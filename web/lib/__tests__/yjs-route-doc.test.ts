import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-yjs-route-"));

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

// Fake agent: records which doc each yjs call touched; `gone` paths stat as missing.
const touched = vi.hoisted(() => ({ calls: [] as Array<{ method: string; docId: string }>, gone: new Set<string>() }));
vi.mock("@/lib/rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  async function callAgent(_d: string, _s: string, params: { method: string; docId: string; path?: string }) {
    if (params.method === "stat") {
      const p = params.path ?? "";
      return { method: "stat", entry: touched.gone.has(p) ? null : { name: p.split("/").pop(), path: p, isDir: false, size: 1, mtimeMs: 0, ext: "md", mime: "text/markdown" } };
    }
    touched.calls.push({ method: params.method, docId: params.docId });
    return params.method === "yjs-read" ? { method: "yjs-read", data: "", bytes: 0 } : { method: "yjs-write", ok: true };
  }
  return { AgentError, callAgent };
});

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const { docIdFor } = await import("../dochub.js");
const { GET, POST } = await import("../../app/api/drives/[driveId]/yjs/route.js");

// The yjs route authorizes `path` and then reads/writes a Yjs doc. The doc must
// be the one named by that authorized path — never a docId the client picked,
// or a viewer of a free file reads (and an editor of one folder writes) any doc.
const DRIVE = "drive-yjs-route";
const OWNER = "u-yr-owner";
const MEMBER = "u-yr-member";
const ctx = { params: Promise.resolve({ driveId: DRIVE }) };
const PAID_DOC = () => docIdFor(DRIVE, "premium/lesson.md");

beforeAll(async () => {
  for (const [id, email] of [[OWNER, "yro@e.com"], [MEMBER, "yrm@e.com"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, "N", "x");
  }
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run(DRIVE, OWNER, "D", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m-yr-root", DRIVE, MEMBER, "", "viewer");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m-yr-drafts", DRIVE, MEMBER, "drafts", "editor");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)")
    .run("s-yr-premium", DRIVE, "premium", "viewer", "tok-yr-premium", 10, "USDC", 1);
  cookieJar.set("aindrive_session", await sign(MEMBER));
});
beforeEach(() => { touched.calls.length = 0; });

describe("yjs route — the doc is the one the authorized path names", () => {
  it("GET reads the doc of the path it checked, not the docId sent with it", async () => {
    const res = await GET(new Request(`http://x/api/drives/${DRIVE}/yjs?docId=${PAID_DOC()}&path=readme.md`), ctx);
    expect(res.status).toBe(200);
    expect(touched.calls).toEqual([{ method: "yjs-read", docId: docIdFor(DRIVE, "readme.md") }]);
  });

  it("POST writes the doc of the path it checked, not the docId sent with it", async () => {
    const req = new Request(`http://x/api/drives/${DRIVE}/yjs`, {
      method: "POST",
      body: JSON.stringify({ docId: PAID_DOC(), path: "drafts/a.md", data: "AA==" }),
    });
    expect((await POST(req, ctx)).status).toBe(200);
    expect(touched.calls).toEqual([{ method: "yjs-write", docId: docIdFor(DRIVE, "drafts/a.md") }]);
  });

  it("any spelling of a path names one doc (canonical path → docId)", async () => {
    const nfd = "drafts/메모.md".normalize("NFD");
    await GET(new Request(`http://x/api/drives/${DRIVE}/yjs?path=${encodeURIComponent("./" + nfd)}`), ctx);
    expect(touched.calls).toEqual([{ method: "yjs-read", docId: docIdFor(DRIVE, "drafts/메모.md".normalize("NFC")) }]);
  });

  it("a path with no file (moved or deleted) reads no doc — its old edits may now sit behind a paywall", async () => {
    touched.gone.add("drafts/moved.md");
    const res = await GET(new Request(`http://x/api/drives/${DRIVE}/yjs?path=drafts/moved.md`), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: "" });
    expect(touched.calls).toEqual([]);
  });

  it("the paid doc itself is still behind the paywall", async () => {
    const res = await GET(new Request(`http://x/api/drives/${DRIVE}/yjs?path=premium/lesson.md`), ctx);
    expect(res.status).toBe(402);
    expect(touched.calls).toEqual([]);
  });
});

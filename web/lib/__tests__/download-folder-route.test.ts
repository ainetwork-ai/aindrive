// fs/download-folder: a folder downloads as a zip under the same rule as its
// listing — viewer+ gets it, anonymous is 401, a locked folder is 402 before
// the agent is asked, and inside a readable folder the paid children this
// caller cannot read are left out (X-Aindrive-Skipped). Fixture drive + users:
// visibility-fixture.ts (vic viewer at root who bought `bought`, ed editor).
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-download-folder-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";

vi.mock("next/headers", async () => (await import("./visibility-fixture")).nextHeadersMock());

// The agent: folders of the fixture, plus a zip-folder that records its call and
// "produces" a fake archive the route must drain with download-chunk and delete.
type Call = { method: string; path?: string; out?: string; exclude?: string[] };
const calls: Call[] = [];
const zips = new Map<string, Buffer>(); // out path → bytes
let zipFailure: string | null = null;
const DIRS = new Set(["", "pub", "listed", "hidden", "bought"]);
const FILES = new Set(["pub/a.png", "top.md", "listed/x.png", "hidden/y.png", "hidden2.png", "bought/z.png"]);
vi.mock("../rpc", () => {
  class AgentError extends Error { status: number; constructor(msg: string, status = 502) { super(msg); this.status = status; } }
  return {
    AgentError,
    isOnline: () => true,
    callAgent: async (_d: string, _s: string, p: Call & { offset?: number; length?: number }) => {
      calls.push({ method: p.method, path: p.path, out: p.out, exclude: p.exclude });
      switch (p.method) {
        case "stat": {
          const path = p.path!;
          if (DIRS.has(path)) return { entry: { name: path, path, isDir: true, size: 0, mtimeMs: 1 } };
          if (FILES.has(path)) return { entry: { name: path, path, isDir: false, size: 3, mtimeMs: 1 } };
          if (zips.has(path)) return { entry: { name: path, path, isDir: false, size: zips.get(path)!.length, mtimeMs: 1 } };
          return { entry: null };
        }
        case "zip-folder": {
          if (zipFailure) throw new AgentError(zipFailure, 500);
          const body = Buffer.from(`PK-fake-zip-of:${p.path}:${(p.exclude ?? []).join(",")}`);
          zips.set(p.out!, body);
          return { method: "zip-folder", ok: true, size: body.length, files: 7, bytes: 1234, skipped: (p.exclude ?? []).length };
        }
        case "download-chunk": {
          const buf = zips.get(p.path!) ?? Buffer.alloc(0);
          const slice = buf.subarray(p.offset ?? 0, (p.offset ?? 0) + (p.length ?? buf.length));
          return { data: slice.toString("base64"), eof: (p.offset ?? 0) + slice.length >= buf.length };
        }
        case "delete": { zips.delete(p.path!); return { ok: true }; }
      }
      throw new AgentError("unsupported " + p.method, 400);
    },
  };
});

const { seed, ctx, signInAs } = await import("./visibility-fixture");
const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const route = await import("../../app/api/drives/[driveId]/fs/download-folder/route.js");

beforeAll(() => { seed(db); });
beforeEach(() => { calls.length = 0; zips.clear(); zipFailure = null; });
const as = (userId: string | null) => signInAs(sign, userId);
const get = (path: string, extra = "") => new Request(`https://drive.test/api/drives/d1/fs/download-folder?path=${encodeURIComponent(path)}${extra}`);
const zipCalls = () => calls.filter((c) => c.method === "zip-folder");
const untilIdle = () => new Promise((r) => setTimeout(r, 20));

describe("fs/download-folder", () => {
  it("viewer: streams <folder>.zip, then the temp zip is deleted on the agent", async () => {
    await as("vic");
    const res = await route.GET(get("pub"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="pub.zip"');
    expect(res.headers.get("x-aindrive-skipped")).toBe("0");
    expect(res.headers.get("x-aindrive-files")).toBe("7");
    const body = Buffer.from(await res.arrayBuffer()).toString();
    expect(body).toBe("PK-fake-zip-of:pub:");
    expect(res.headers.get("content-length")).toBe(String(body.length));
    const z = zipCalls()[0];
    expect(z.path).toBe("pub");
    expect(z.out).toMatch(/^\.aindrive\/uploads\/zip\/[0-9a-f-]{36}\.zip$/);
    await untilIdle();
    expect(calls.some((c) => c.method === "delete" && c.path === z.out)).toBe(true);
    expect(zips.size).toBe(0);
  });

  it("root folder downloads as <drive name>.zip", async () => {
    await as("ed");
    const res = await route.GET(get(""), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`filename="${encodeURIComponent("Team Drive.zip")}"`);
  });

  it("anonymous: 401, and the agent is never asked to zip", async () => {
    await as(null);
    const res = await route.GET(get("pub"), ctx);
    expect(res.status).toBe(401);
    expect(zipCalls()).toEqual([]);
  });

  it("a user with no grant: 403, nothing zipped", async () => {
    await as("bob");
    const res = await route.GET(get("pub"), ctx);
    expect(res.status).toBe(403);
    expect(zipCalls()).toEqual([]);
  });

  it("locked root (a listed sale the viewer has not bought): 402 with the paywall body, nothing zipped", async () => {
    await as("vic");
    const res = await route.GET(get("listed"), ctx);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ reason: "payment_required", shareId: "s_listed" });
    expect(calls).toEqual([]); // not even a stat: the gate refuses first
  });

  it("viewer at the root: the paid children they cannot read are excluded and counted", async () => {
    await as("vic");
    const res = await route.GET(get(""), ctx);
    expect(res.status).toBe(200);
    // listed (locked), hidden + hidden2.png (unlisted) are left out; `bought` is theirs.
    expect(zipCalls()[0].exclude).toEqual(["hidden", "hidden2.png", "listed"]);
    expect(res.headers.get("x-aindrive-skipped")).toBe("3");
    await res.arrayBuffer();
  });

  it("editor at the root: nothing is excluded", async () => {
    await as("ed");
    const res = await route.GET(get(""), ctx);
    expect(res.status).toBe(200);
    expect(zipCalls()[0].exclude).toEqual([]);
    expect(res.headers.get("x-aindrive-skipped")).toBe("0");
    await res.arrayBuffer();
  });

  it("a file path is 404 (fs/download is the file route)", async () => {
    await as("vic");
    expect((await route.GET(get("top.md"), ctx)).status).toBe(404);
    expect((await route.GET(get("nope"), ctx)).status).toBe(404);
    expect(zipCalls()).toEqual([]);
  });

  it("agent cap → 413", async () => {
    await as("vic");
    zipFailure = "zip limit: more than 20000 files";
    const res = await route.GET(get("pub"), ctx);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/);
  });

  it("prepare=1 answers JSON with a tokenized url that streams the prepared zip without a cookie, then deletes it", async () => {
    await as("vic");
    const prep = await route.GET(get("pub", "&prepare=1"), ctx);
    expect(prep.status).toBe(200);
    const j = await prep.json();
    expect(j).toMatchObject({ filename: "pub.zip", files: 7, skipped: 0 });
    expect(j.url).toMatch(/^\/api\/drives\/d1\/fs\/download-folder\?path=pub&dt=/);
    expect(zips.size).toBe(1); // kept for the fetch

    await as(null); // the OS downloader carries no cookie
    const res = await route.GET(new Request(`https://drive.test${j.url}`), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="pub.zip"');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PK-fake-zip-of:pub:");
    await untilIdle();
    expect(zips.size).toBe(0);

    // Same token again: the zip is gone → 410. A folder token never opens another path.
    expect((await route.GET(new Request(`https://drive.test${j.url}`), ctx)).status).toBe(410);
    expect((await route.GET(new Request(`https://drive.test${j.url.replace("path=pub", "path=listed")}`), ctx)).status).toBe(403);
  });

  it("a file download token does not open the folder route", async () => {
    const { signDownloadToken } = await import("../download-token");
    const t = await signDownloadToken("d1", "pub");
    await as(null);
    const res = await route.GET(get("pub", `&dt=${encodeURIComponent(t)}`), ctx);
    expect(res.status).toBe(403);
    expect(zipCalls()).toEqual([]);
  });
});

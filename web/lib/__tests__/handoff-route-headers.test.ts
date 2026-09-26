import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-handoff-route-"));

// Fake device: every handoff-read returns the whole file at once.
vi.mock("@/lib/rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  const bytes = Buffer.from("<script>alert(document.cookie)</script>");
  return { AgentError, callAgent: async () => ({ data: bytes.toString("base64"), eof: true, size: bytes.length }) };
});

const { db } = await import("../db.js");
const { createHandoffs } = await import("../handoff");
const { GET } = await import("../../app/api/h/[id]/route.js");

// A handoff link serves bytes whose type the link's creator chose, on the app's
// own origin, to whoever opens it. Types a browser would run (HTML, SVG, …)
// must never execute there with the visitor's session — the same policy as
// fs/stream (lib/served-bytes.ts).
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u-h", "h@e.com", "H", "x");
db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d-h", "u-h", "Phone", "h", "s");

async function fetchAs(mime: string, name: string) {
  const [l] = createHandoffs("u-h", "d-h", [{ deviceKey: name.padEnd(20, "x"), name, mime, size: 38 }], "Agent", 600);
  return GET(new Request(`http://x/api/h/${l.id}?k=${l.secret}`), { params: Promise.resolve({ id: l.id }) });
}

describe("GET /api/h/:id — the creator's mime never runs on our origin", () => {
  it("HTML is sent as a download of opaque bytes", async () => {
    const res = await fetchAs("text/html", "page.html");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("a passive type (image) still shows inline", async () => {
    const res = await fetchAs("image/png", "photo.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("markdown and plain text stay text for the agent reading them", async () => {
    const md = await fetchAs("text/markdown", "001 notes.md");
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetchAs("text/plain", "a.txt")).headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // …but a type a browser runs never does, however it is spelled.
    expect((await fetchAs("text/html; charset=utf-8", "p.html")).headers.get("content-type")).toBe("application/octet-stream");
    expect((await fetchAs("application/xhtml+xml", "p.xhtml")).headers.get("content-type")).toBe("application/octet-stream");
  });

  it("SVG shows inline only inside a CSP sandbox", async () => {
    const res = await fetchAs("image/svg+xml", "logo.svg");
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });
});

describe("no route renders bytes inline except through servedBytesHeaders", () => {
  const routes = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : n === "route.ts" ? [p] : [];
  });
  it("no route.ts writes an inline Content-Disposition itself", () => {
    const hits = routes(join(__dirname, "../../app")).filter((f) => /content-disposition["']?\s*:\s*[`"']inline/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

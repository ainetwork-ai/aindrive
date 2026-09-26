// AINUI assets (docs/AINUI.md §2): the byte routes a host resolves assets
// through — fs/thumbnail, fs/stream, fs/download — accept the session JWT as
// `Authorization: Bearer` as well as the cookie, with every other check intact.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-ainui-assets-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
}));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
const agentCalls: string[] = [];
vi.mock("../rpc", () => ({
  AgentError: class extends Error {},
  callAgent: async (_d: string, _s: string, req: { method: string; path: string; offset?: number; length?: number }) => {
    agentCalls.push(`${req.method} ${req.path}`);
    const bytes = Buffer.from(SVG);
    if (req.method === "stat") return { entry: { name: req.path, isDir: false, size: bytes.length, mtimeMs: 42 } };
    if (req.method === "read") return { content: bytes.toString("base64"), encoding: "base64" };
    if (req.method === "download-chunk") {
      const chunk = bytes.subarray(req.offset ?? 0, (req.offset ?? 0) + (req.length ?? bytes.length));
      return { data: chunk.toString("base64"), eof: (req.offset ?? 0) + chunk.length >= bytes.length };
    }
    return {};
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const tokens = await import("../mcp-tokens");
const thumb = await import("../../app/api/drives/[driveId]/fs/thumbnail/route.js");
const stream = await import("../../app/api/drives/[driveId]/fs/stream/route.js");
const download = await import("../../app/api/drives/[driveId]/fs/download/route.js");

const ctx = { params: Promise.resolve({ driveId: "d1" }) };
const get = (
  route: { GET: (req: Request, c: typeof ctx) => Promise<Response> },
  op: string, path: string, auth?: string,
) => route.GET(new Request(`http://drive.test/api/drives/d1/fs/${op}?path=${encodeURIComponent(path)}&v=42`, {
  headers: auth ? { authorization: auth } : {},
}), ctx);

let ownerJwt = "";
let strangerJwt = "";

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('o1','o@x.com','O','x'), ('s1','s@x.com','S','x')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES ('d1','o1','D1','h','s')").run();
  ownerJwt = await sign("o1");
  strangerJwt = await sign("s1");
});
beforeEach(() => { cookieJar.clear(); agentCalls.length = 0; });

describe("fs/thumbnail with a bearer session JWT", () => {
  it("valid JWT → the thumbnail", async () => {
    const res = await get(thumb, "thumbnail", "Camera/a.svg", `Bearer ${ownerJwt}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toBe(SVG);
  });

  it("invalid token → 401, and it never falls back to the cookie", async () => {
    expect((await get(thumb, "thumbnail", "Camera/a.svg", "Bearer not-a-jwt")).status).toBe(401);
    // a forged JWT (wrong key)
    const forged = ownerJwt.slice(0, ownerJwt.lastIndexOf(".") + 1) + "AAAA";
    expect((await get(thumb, "thumbnail", "Camera/a.svg", `Bearer ${forged}`)).status).toBe(401);
    // an MCP token is not a session
    const pat = tokens.issuePat({ userId: "o1", driveId: "d1", name: "t", scope: "read", ttlDays: null }).token;
    expect((await get(thumb, "thumbnail", "Camera/a.svg", `Bearer ${pat}`)).status).toBe(401);
    cookieJar.set("aindrive_session", ownerJwt);
    expect((await get(thumb, "thumbnail", "Camera/a.svg", "Bearer not-a-jwt")).status).toBe(401);
    expect(agentCalls).toEqual([]);
  });

  it("no token → anonymous (401) unless the cookie is there, as before", async () => {
    expect((await get(thumb, "thumbnail", "Camera/a.svg")).status).toBe(401);
    cookieJar.set("aindrive_session", ownerJwt);
    expect((await get(thumb, "thumbnail", "Camera/a.svg")).status).toBe(200);
  });

  it("the same role checks: a stranger's valid JWT is 403; system paths stay closed", async () => {
    expect((await get(thumb, "thumbnail", "Camera/a.svg", `Bearer ${strangerJwt}`)).status).toBe(403);
    expect((await get(thumb, "thumbnail", ".aindrive/x.svg", `Bearer ${ownerJwt}`)).status).toBe(403);
    expect(agentCalls).toEqual([]);
  });
});

describe("fs/stream and fs/download with a bearer session JWT", () => {
  it("stream: valid → bytes, invalid → 401, none → 401", async () => {
    const ok = await get(stream, "stream", "a.svg", `Bearer ${ownerJwt}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(SVG);
    expect((await get(stream, "stream", "a.svg", "Bearer nope")).status).toBe(401);
    expect((await get(stream, "stream", "a.svg")).status).toBe(401);
    expect((await get(stream, "stream", "a.svg", `Bearer ${strangerJwt}`)).status).toBe(403);
  });

  it("download: valid → attachment, invalid → 401", async () => {
    const ok = await get(download, "download", "a.svg", `Bearer ${ownerJwt}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toContain("attachment");
    expect((await get(download, "download", "a.svg", "Bearer nope")).status).toBe(401);
    expect((await get(download, "download", "a.svg")).status).toBe(401);
  });
});

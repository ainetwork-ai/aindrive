import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-handoff-mcp-"));

// Fake device: serves only the keys it registered, like Handoffs.java.
const served = new Map<string, string>();
vi.mock("@/lib/rpc", () => {
  class AgentError extends Error {
    status: number;
    constructor(msg: string, status = 502) { super(msg); this.status = status; }
  }
  return {
    AgentError,
    callAgent: async (_d: string, _s: string, p: { key: string }) => {
      const t = served.get(p.key);
      if (t === undefined) throw new AgentError("unknown key", 404);
      const b = Buffer.from(t);
      return { data: b.toString("base64"), eof: true, size: b.length };
    },
  };
});

const { db } = await import("../db.js");
const { createHandoffGrant, createHandoffs, revokeHandoffs } = await import("../handoff");
const route = await import("../../app/mcp/h/[grantId]/route.js");

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("u1", "u1@e.com", "U", "x");
db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("d1", "u1", "Phone", "h", "s");
const note = (k: string, text: string, mime = "text/markdown", ext = "md") => { served.set(k.padEnd(20, "x"), text); return { deviceKey: k.padEnd(20, "x"), name: `${k}.${ext}`, mime, size: text.length }; };

function call(grantId: string, token: string | null, body: unknown) {
  return route.POST(new Request(`http://x/mcp/h/${grantId}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ grantId }) });
}
async function result(res: Response): Promise<any> {
  const text = await res.text();
  return JSON.parse(text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text);
}
const tool = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("/mcp/h/:grant — an agent reads only the files it was handed", () => {
  it("needs the grant's own token", async () => {
    const { grant } = createHandoffGrant("u1", "d1", [note("a", "hello")], "Cloud", 600);
    expect((await call(grant.id, null, tool("list_files"))).status).toBe(401);
    expect((await call(grant.id, "aind_hg_wrong", tool("list_files"))).status).toBe(401);
    const other = createHandoffGrant("u1", "d1", [note("b", "x")], "Cloud", 600);
    expect((await call(grant.id, other.grant.token, tool("list_files"))).status).toBe(401);
  });

  it("lists and reads the granted files, and nothing else on the device", async () => {
    const { grant, links } = createHandoffGrant("u1", "d1", [note("c1", "call notes one"), note("c2", "call notes two")], "Cloud", 600);
    const [outside] = createHandoffs("u1", "d1", [note("secret", "not yours")], "Cloud", 600);
    const list = await result(await call(grant.id, grant.token, tool("list_files")));
    expect(list.result.structuredContent.files.map((f: { name: string }) => f.name)).toEqual(["c1.md", "c2.md"]);
    const read = await result(await call(grant.id, grant.token, tool("read_file", { id: links[1].id })));
    expect(read.result.content[0].text).toBe("call notes two");
    const refused = await result(await call(grant.id, grant.token, tool("read_file", { id: outside.id })));
    expect(refused.result.isError).toBe(true);
  });

  it("refuses non-text files", async () => {
    const { grant, links } = createHandoffGrant("u1", "d1", [note("audio", "RIFF", "audio/mp4", "m4a")], "Cloud", 600);
    const r = await result(await call(grant.id, grant.token, tool("read_file", { id: links[0].id })));
    expect(r.result.isError).toBe(true);
  });

  it("a revoked link leaves the view; revoking the audience closes the grant", async () => {
    const { grant, links } = createHandoffGrant("u1", "d1", [note("r1", "one"), note("r2", "two")], "Closing Agent", 600);
    revokeHandoffs("u1", { id: links[0].id });
    const list = await result(await call(grant.id, grant.token, tool("list_files")));
    expect(list.result.structuredContent.files.map((f: { name: string }) => f.name)).toEqual(["r2.md"]);
    revokeHandoffs("u1", { audience: "Closing Agent" });
    expect((await call(grant.id, grant.token, tool("list_files"))).status).toBe(410);
  });

  it("expires with its links", async () => {
    const { grant } = createHandoffGrant("u1", "d1", [note("e", "x")], "Cloud", 600);
    db.prepare("UPDATE handoff_grants SET expires_at = datetime('now', '-1 second') WHERE id = ?").run(grant.id);
    expect((await call(grant.id, grant.token, tool("list_files"))).status).toBe(410);
  });
});

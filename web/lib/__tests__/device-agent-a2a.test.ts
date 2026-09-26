// /a2a/d/[driveId] — a drive's on-device agent over A2A (lib/device-agent-a2a.ts): the question goes
// straight to the device's agent-ask RPC, with no agent record to read first.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-device-a2a-"));
process.env.AINDRIVE_PUBLIC_URL = "http://drive.test";

vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
const rpcCalls: { driveId: string; params: Record<string, unknown> }[] = [];
let offline = false;
vi.mock("../agents", () => ({
  sendRpc: async (driveId: string, params: Record<string, unknown>) => {
    rpcCalls.push({ driveId, params });
    if (offline) throw Object.assign(new Error("agent offline"), { status: 504 });
    return { answer: `Found 2 photos for “${params.query}”.`, sources: [{ path: "a.jpg", snippet: "2026-09", matchedBy: "photo" }, { path: "b.jpg", snippet: "2026-09", matchedBy: "photo" }] };
  },
}));

const { db } = await import("../db.js");
const { sign } = await import("../session.js");
const route = await import("../../app/a2a/d/[driveId]/route.js");
const cardRoute = await import("../../app/a2a/d/[driveId]/.well-known/agent-card.json/route.js");

let owner: string, member: string;
beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES ('o1','o@x.com','O','x'), ('m1','m@x.com','M','x')").run();
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, last_hostname) VALUES ('d1','o1','trees photos','h','s','S26')").run();
  db.prepare("INSERT INTO drive_members (drive_id, user_id, role, path) VALUES ('d1','m1','viewer','')").run();
  owner = await sign("o1"); member = await sign("m1");
});

const ctx = (driveId = "d1") => ({ params: Promise.resolve({ driveId }) });
const send = (text: string, metadata?: Record<string, unknown>) => ({
  jsonrpc: "2.0", id: 1, method: "message/send",
  params: { message: { kind: "message", role: "user", messageId: `m${Math.random()}`, parts: [{ kind: "text", text }], ...(metadata ? { metadata } : {}) } },
});
const post = (body: unknown, token: string | null, ip = "1.1.1.1") => route.POST(new Request("http://drive.test/a2a/d/d1", {
  method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}), ctx());
const dataOf = (r: any) => r.result.parts.find((p: any) => p.kind === "data" && p.metadata?.type === "ai.aindrive/ask-result")?.data;

describe("a drive's on-device agent over A2A", () => {
  it("the owner's question reaches the device's agent-ask — no agent record — and comes back with its sources", async () => {
    const r = await (await post(send("tree photos"), owner, "10.0.0.1")).json();
    expect(r.result.parts[0].text).toContain("Found 2 photos");
    expect(dataOf(r).sources.map((s: any) => s.path)).toEqual(["a.jpg", "b.jpg"]);
    expect(rpcCalls.at(-1)).toMatchObject({ driveId: "d1", params: { method: "agent-ask", agentId: "agt_device", query: "tree photos" } });
    expect(rpcCalls.some((c) => c.params.method === "read")).toBe(false);
  });

  it("a device that can't answer says so (not 'agent not found')", async () => {
    offline = true;
    try {
      const r = await (await post(send("food photos"), owner, "10.0.0.2")).json();
      expect(r.result.parts[0].text).toMatch(/^\[unavailable\] the device is offline/);
      expect(dataOf(r)).toMatchObject({ error: "device_unavailable" });
    } finally { offline = false; }
  });

  it("only the owner asks the device; no bearer is 401", async () => {
    const n = rpcCalls.length;
    const r = await (await post(send("tree photos"), member, "10.0.0.3")).json();
    expect(r.result.parts[0].text).toMatch(/^\[forbidden\]/);
    expect(rpcCalls.length).toBe(n);
    expect((await post(send("x"), null, "10.0.0.3")).status).toBe(401);
  });

  it("one question to several drives is one ask; separate questions hit the free tier's limit", async () => {
    for (let i = 0; i < 8; i++) expect((await post(send("q", { askId: "abcdefghijklmnop" }), owner, "10.0.0.4")).status).toBe(200);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(send(`q${i}`), owner, "10.0.0.5")).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("the card names the drive and its device, for someone the drive admits", async () => {
    const get = (token: string | null) => cardRoute.GET(new Request("http://drive.test/a2a/d/d1/.well-known/agent-card.json", { headers: token ? { authorization: `Bearer ${token}` } : {} }), ctx());
    const c = await (await get(owner)).json();
    expect(c.name).toBe("trees photos on S26");
    expect(c.url).toBe("http://drive.test/a2a/d/d1");
    expect((await get(null)).status).toBe(401);
  });
});

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-rtc-"));
const sentToAgent: { driveId: string; frame: Record<string, unknown> }[] = [];
let paid = false;
vi.mock("@/lib/willow/roles", () => ({
  isMember: (_d: string, u: string | null) => u === "u-mem" || u === "u-paid",
  roleOf: (_d: string, u: string | null) => (u ? "viewer" : "none"),
  paywalled: (_d: string, u: string | null) => paid || u === "u-paid",
}));
vi.mock("@/lib/rpc", () => ({ callAgent: async () => ({ method: "stat", entry: { size: 5_000_000, mtimeMs: 7, isDir: false } }) }));
vi.mock("@/lib/media/cache", () => ({ mediaManifest: async () => ({ size: 5_000_000, mtimeMs: 7, outboard: new Uint8Array(32 * 5), root: new Uint8Array(32), rootHex: "cd".repeat(32) }) }));
vi.mock("@/lib/agents.js", () => ({ sendToAgent: (driveId: string, frame: Record<string, unknown>) => { sentToAgent.push({ driveId, frame }); return true; } }));

const { db } = await import("../db.js");
const { createDrive } = await import("../drives");
const { onRtcSignal, routeFromAgent } = await import("../media/rtc-signal");
const { verifyToken } = await import("@/shared/media/p2p");

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("owner", "o@x.com", "O", "x");
const drive = await createDrive("owner", "D");
const secret = (db.prepare("SELECT drive_secret FROM drives WHERE id = ?").get(drive.driveId) as { drive_secret: string }).drive_secret;

function fakeWs() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, sent: [] as unknown[], closed: 0 as number });
  (ws as unknown as { send: (d: string) => void }).send = (d: string) => ws.sent.push(JSON.parse(d));
  (ws as unknown as { close: (c: number) => void }).close = (c: number) => { ws.closed = c; };
  return ws;
}

describe("P2P signalling", () => {
  it("a member's offer reaches the agent with a token for exactly this file; the answer comes back to them only", async () => {
    const a = fakeWs(), b = fakeWs();
    await onRtcSignal(a as never, {} as never, { drive: drive.driveId, path: "v.mp4" }, "u-mem");
    await onRtcSignal(b as never, {} as never, { drive: drive.driveId, path: "v.mp4" }, "u-mem");
    const ready = a.sent[0] as { t: string; sid: string; manifest: { size: number; root: string } };
    expect(ready.t).toBe("ready");
    expect(ready.manifest.root).toBe("cd".repeat(32));
    a.emit("message", Buffer.from(JSON.stringify({ t: "signal", data: { sdp: "offer" } })));
    const f = sentToAgent.at(-1)!.frame as { type: string; sid: string; token: string; path: string; data: unknown };
    expect(f.type).toBe("rtc");
    expect(f.sid).toBe(ready.sid);
    expect(verifyToken(secret, f.token, Date.now())).toMatchObject({ drive: drive.driveId, path: "v.mp4", root: "cd".repeat(32) });
    routeFromAgent(drive.driveId, { type: "rtc", sid: ready.sid, data: { sdp: "answer" } });
    expect(a.sent.at(-1)).toEqual({ t: "signal", data: { sdp: "answer" } });
    expect(b.sent.some((m) => (m as { data?: { sdp?: string } }).data?.sdp === "answer")).toBe(false);
  });

  it("a paywalled user is closed with 4402 and nothing reaches the agent", async () => {
    const before = sentToAgent.length;
    const w = fakeWs();
    await onRtcSignal(w as never, {} as never, { drive: drive.driveId, path: "v.mp4" }, "u-paid");
    expect(w.closed).toBe(4402);
    w.emit("message", Buffer.from(JSON.stringify({ t: "signal", data: {} })));
    expect(sentToAgent.length).toBe(before);
  });

  it("a non-member is closed with 4401", async () => {
    const w = fakeWs();
    await onRtcSignal(w as never, {} as never, { drive: drive.driveId, path: "v.mp4" }, "stranger");
    expect(w.closed).toBe(4401);
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import * as Y from "yjs";
import { startWillowPeer } from "../willow-peer.js";
import { newStore } from "../willow-shared/schemes.js";
import { generateDeviceKey } from "../willow-shared/keys.js";
import { appendUpdate, loadDoc } from "../willow-shared/doc.js";
import { SyncSession, fullRange } from "../willow-shared/session.js";

// A ws-like socket pair: the agent's end, and a server end driving a SyncSession.
function socketPair() {
  const mk = () => Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1 });
  const a = mk(), b = mk();
  a.send = (d) => queueMicrotask(() => b.emit("message", Buffer.from(String(d))));
  b.send = (d) => queueMicrotask(() => a.emit("message", Buffer.from(String(d))));
  a.close = () => { a.readyState = 3; a.emit("close"); b.emit("close"); };
  b.close = a.close;
  queueMicrotask(() => a.emit("open"));
  return [a, b];
}

const until = async (ok, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error("timeout"); };
const text = (s, c) => { const d = new Y.Doc(); d.clientID = c; d.getText("content").insert(0, s); return Y.encodeStateAsUpdate(d); };

let peers = [];
afterEach(async () => { for (const p of peers) await p.stop(); peers = []; });

describe("agent Willow peer", () => {
  it("keeps a 0600 device key, gets a certificate, and receives entries from the server", async () => {
    const root = mkdtempSync(join(tmpdir(), "willow-agent-"));
    const server = newStore("drive-1");
    const other = await generateDeviceKey();
    await appendUpdate(server, other, ["a.md"], text("from server", 5), 1);
    const certCalls = [];
    const fetchImpl = async (url, init) => { certCalls.push({ url, init }); return { ok: true, json: async () => ({ cert: { v: 1, deviceKey: JSON.parse(init.body).deviceKey, userId: "owner", label: "agent", issuedAt: "1", issuer: { type: "attestation", key: "00".repeat(32) }, sig: "00".repeat(64) } }) }; };
    const connect = () => { const [agentEnd, serverEnd] = socketPair(); const listeners = []; serverEnd.on("message", (d) => listeners.forEach((cb) => cb(JSON.parse(String(d))))); void new SyncSession({ store: server, ranges: [fullRange()], channel: { send: (f) => serverEnd.send(JSON.stringify(f)), onFrame: (cb) => listeners.push(cb), onClose: () => {} } }).start(); return agentEnd; };
    const drive = { driveId: "drive-1", agentToken: "tok" };
    const p = await startWillowPeer({ root, drive, server: "http://x", connect, fetchImpl });
    peers.push(p);
    await until(async () => (await loadDoc(p.store, ["a.md"])).getText("content").toString() === "from server");
    expect(statSync(join(root, ".aindrive/device.key")).mode & 0o777).toBe(0o600);
    expect(certCalls[0].init.headers.authorization).toBe("Bearer tok");
    const key1 = readFileSync(join(root, ".aindrive/device.key"), "utf8");
    await p.stop(); peers = [];
    const p2 = await startWillowPeer({ root, drive, server: "http://x", connect, fetchImpl });
    peers.push(p2);
    expect(readFileSync(join(root, ".aindrive/device.key"), "utf8")).toBe(key1);
    expect(certCalls.length).toBe(1); // the certificate is kept in the store
  });
});

// Removing a lost device from the web (plan 12.2, found on a real CLI agent):
//   - POST /rotate drops every device socket still on the old pair (4401) —
//     before, the lost device kept serving on its open socket;
//   - DELETE drops every socket, not only the RPC primary (4410);
//   - POST /api/auth/logout?everywhere=1 ends the account's other sign-ins,
//     including the session a CLI keeps from pairing — before, nothing on the
//     web could end it, and the lost device could mint the drive's credentials
//     again with `aindrive rotate-token`.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-device-removal-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.test";

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

const { db } = await import("../db.js");
const { sign, verify } = await import("../session.js");
const ev = await import("../share-events");
const agents = await import("../agents.js");
const rotateRoute = await import("../../app/api/drives/[driveId]/rotate/route.js");
const driveRoute = await import("../../app/api/drives/[driveId]/route.js");
const logoutRoute = await import("../../app/api/auth/logout/route.js");

const ORIGIN = "https://drive.test";
const TOKEN = "agent-token-old-000000000000000000000000";
const ctx = (driveId: string) => ({ params: Promise.resolve({ driveId }) });
const asUser = async (id: string) => cookieJar.set("aindrive_session", await sign(id));

type FakeWs = EventEmitter & { OPEN: number; readyState: number; closed: [number, string] | null; _socket: EventEmitter; send(d: string): void; ping(): void; terminate(): void; close(code?: number, reason?: string): void };
function fakeWs(): FakeWs {
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, closed: null, _socket: new EventEmitter() }) as FakeWs;
  ws.send = () => {};
  ws.ping = () => {};
  ws.terminate = () => { ws.readyState = 3; ws.emit("close"); };
  ws.close = (code = 1000, reason = "") => { if (ws.readyState === 3) return; ws.closed = [code, reason]; ws.readyState = 3; ws.emit("close"); };
  return ws;
}
const connect = (ws: FakeWs, driveId: string, token = TOKEN) =>
  agents.onAgentConnect(ws, { headers: { authorization: `Bearer ${token}` } }, { driveId });
const availability = (userId: string) =>
  (ev.listShareEvents(userId).events as { type: string; revision?: string }[]).filter((e) => e.type === "file.availability").map((e) => e.revision);

beforeAll(async () => {
  const u = db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)");
  for (const id of ["owner1", "other1"]) u.run(id, `${id}@example.com`, id, "x");
  const d = db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)");
  const hash = await bcrypt.hash(TOKEN, 4);
  d.run("rot1", "owner1", "Laptop", hash, "secret-rot1");
  d.run("del1", "owner1", "Doomed", hash, "secret-del1");
});

describe("POST /api/drives/:id/rotate — remove the device serving a drive", () => {
  it("disconnects every device on the old pair (4401), records offline once, and refuses the old token after", async () => {
    const lost = fakeWs(), peer = fakeWs();
    await connect(peer, "rot1");
    await connect(lost, "rot1"); // latest = RPC primary
    expect(agents.isAgentConnected("rot1")).toBe(true);

    await asUser("other1");
    expect((await rotateRoute.POST(new Request(`${ORIGIN}/api`, { method: "POST" }), ctx("rot1"))).status).toBe(404);
    expect(lost.closed).toBeNull();

    await asUser("owner1");
    const res = await rotateRoute.POST(new Request(`${ORIGIN}/api`, { method: "POST" }), ctx("rot1"));
    expect(res.status).toBe(200);
    const fresh = await res.json();
    expect(lost.closed).toEqual([4401, "credentials rotated"]);
    expect(peer.closed).toEqual([4401, "credentials rotated"]);
    expect(agents.isAgentConnected("rot1")).toBe(false);
    expect(availability("owner1")).toEqual(["online", "offline"]);
    await expect(agents.sendRpc("rot1", { method: "list", path: "" })).rejects.toThrow("agent offline");

    const again = fakeWs();
    await connect(again, "rot1");
    expect(again.closed).toEqual([4401, "bad token"]);
    const replacement = fakeWs();
    await connect(replacement, "rot1", fresh.agentToken);
    expect(replacement.closed).toBeNull();
    expect(agents.isAgentConnected("rot1")).toBe(true);
    replacement.close();
  });
});

describe("DELETE /api/drives/:id", () => {
  it("closes the primary AND the other devices' sockets (4410)", async () => {
    const a = fakeWs(), b = fakeWs();
    await connect(a, "del1");
    await connect(b, "del1");
    await asUser("owner1");
    const res = await driveRoute.DELETE(new Request(`${ORIGIN}/api`, { method: "DELETE" }), ctx("del1"));
    expect(res.status).toBe(200);
    expect(a.closed).toEqual([4410, "drive deleted"]);
    expect(b.closed).toEqual([4410, "drive deleted"]);
    expect(agents.isAgentConnected("del1")).toBe(false);
    const late = fakeWs();
    await connect(late, "del1");
    expect(late.closed).toEqual([4404, "no such drive"]);
  });
});

describe("POST /api/auth/logout?everywhere=1", () => {
  const logout = (q = "") => logoutRoute.POST(new Request(`${ORIGIN}/api/auth/logout${q}`, { method: "POST" }));

  it("a plain sign-out leaves the account's other sign-ins alone", async () => {
    const cliSession = await sign("other1");
    await asUser("other1");
    expect((await logout()).status).toBe(303);
    expect(cookieJar.has("aindrive_session")).toBe(false);
    expect(await verify(cliSession)).toBe("other1");
  });

  it("ends every session of the account — the lost laptop's CLI sign-in included", async () => {
    const cliSession = await sign("owner1");      // what `aindrive login` keeps in ~/.aindrive/credentials.json
    const otherBrowser = await sign("owner1");
    const bystander = await sign("other1");
    await asUser("owner1");
    const res = await logout("?everywhere=1");
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    expect(cookieJar.has("aindrive_session")).toBe(false);
    expect(await verify(cliSession)).toBeNull();
    expect(await verify(otherBrowser)).toBeNull();
    expect(await verify(bystander)).toBe("other1");

    // The lost device cannot mint the drive's credentials again with its old sign-in.
    cookieJar.set("aindrive_session", cliSession);
    expect((await rotateRoute.POST(new Request(`${ORIGIN}/api`, { method: "POST" }), ctx("rot1"))).status).toBe(401);
    // A new sign-in works as usual.
    await asUser("owner1");
    expect(await verify(cookieJar.get("aindrive_session")!)).toBe("owner1");
  });

  it("with no one signed in it only clears cookies", async () => {
    cookieJar.clear();
    expect((await logout("?everywhere=1")).status).toBe(303);
  });
});

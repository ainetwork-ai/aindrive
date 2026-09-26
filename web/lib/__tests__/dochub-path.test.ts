import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";

// Point the DB at a throwaway dir BEFORE importing db.js (it opens on import).
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-dochub-path-"));
process.env.AINDRIVE_SESSION_SECRET = "dochub-path-test-secret";

const { db } = await import("../db.js");
const { onDocConnect, broadcastReload } = await import("../dochub.js");

// The live-doc WebSocket takes its path from the URL, like the fs/* routes, so
// it must judge — and key the doc — by the same canonical path they do.
const DRIVE = "drive-dochub-path";
const OWNER = "u-dh-owner";
const VIEWER = "u-dh-viewer";

type FakeWs = { closedWith: number | null; sent: string[]; readyState: number; OPEN: number;
  close(code: number): void; send(s: string): void; on(): void };
function fakeWs(): FakeWs {
  return { closedWith: null, sent: [], readyState: 1, OPEN: 1,
    close(code) { this.closedWith = code; }, send(s) { this.sent.push(s); }, on() {} };
}
async function connectAs(userId: string, path: string): Promise<FakeWs> {
  const jwt = await new SignJWT({ sub: userId }).setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(process.env.AINDRIVE_SESSION_SECRET));
  const ws = fakeWs();
  await onDocConnect(ws, { headers: { cookie: `aindrive_session=${jwt}` } }, { drive: DRIVE, path });
  return ws;
}

beforeAll(() => {
  for (const [id, email] of [[OWNER, "dho@e.com"], [VIEWER, "dhv@e.com"]]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, "N", "x");
  }
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run(DRIVE, OWNER, "D", "h", "s");
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("m-dh-viewer", DRIVE, VIEWER, "", "viewer");
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)")
    .run("s-dh-premium", DRIVE, "premium", "viewer", "tok-dh-premium", 10, "USDC", 1);
  db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed) VALUES (?,?,?,?,?,?,?,?)")
    .run("s-dh-album", DRIVE, "앨범".normalize("NFC"), "viewer", "tok-dh-album", 1, "USDC", 1);
});

describe("onDocConnect — the paywall sees the canonical path", () => {
  it("control: a viewer who hasn't bought premium/ is refused its live doc", async () => {
    expect((await connectAs(VIEWER, "premium/notes.md")).closedWith).toBe(4402);
  });

  it.each([
    ["a ./ prefix", "./premium/notes.md"],
    ["a doubled slash", "premium//notes.md"],
    ["a leading slash", "/premium/notes.md"],
    ["the NFD spelling of a paid folder", "앨범/notes.md".normalize("NFD")],
  ])("%s is still behind the paywall", async (_label, path) => {
    expect((await connectAs(VIEWER, path)).closedWith).toBe(4402);
  });

  it("a '..' path is refused as a bad request, not an unhandled throw", async () => {
    expect((await connectAs(VIEWER, "../etc/passwd")).closedWith).toBe(4400);
  });
});

describe("broadcastReload — the agent's path reaches editors of the same doc", () => {
  it("an NFD path from the agent reloads editors who opened the NFC path", async () => {
    const ws = await connectAs(OWNER, "메모.md".normalize("NFC"));
    expect(ws.closedWith).toBeNull();
    expect(broadcastReload(DRIVE, "메모.md".normalize("NFD"))).toBe(1);
  });
});

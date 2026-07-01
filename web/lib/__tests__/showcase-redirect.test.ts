// Regression test for the "Buy to unlock" redirect (showcase/[shareId] route).
//
// Bug: the route built its 302 Location with `new URL("/s/"+token, req.url)`.
// Behind the nginx reverse proxy, req.url's host is the container's internal
// bind address (localhost:3737), so the browser was sent an absolute
// `Location: http://localhost:3737/s/<token>` it could not connect to
// ("사이트에 연결할 수 없음" / ERR_CONNECTION_REFUSED). The fix mirrors the
// logout route: emit a RELATIVE Location so the browser resolves it against the
// public URL it actually requested. This test locks the Location to be relative.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-showcase-redirect-"));

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
const { sign } = await import("../session.js");
const { GET } = await import("../../app/api/drives/[driveId]/showcase/[shareId]/route.js");

const ctx = (shareId: string) => ({ params: Promise.resolve({ driveId: "d1", shareId }) });
// A request whose HOST is the container's internal bind address — exactly what
// the Node server sees behind the proxy. The old code leaked this host into the
// redirect; the fix must NOT.
const buyReq = (shareId: string) =>
  GET(new Request(`http://localhost:3737/api/drives/d1/showcase/${shareId}`), ctx(shareId));

beforeAll(async () => {
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("buyer1", "b@example.com", "Buyer", "x");
  db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
    .run("owner1", "o@example.com", "Owner", "x");
  db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
    .run("d1", "owner1", "D1", "h", "s");
  // buyer1 is a whole-drive viewer (satisfies the relationship gate).
  db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
    .run("dm_buyer", "d1", "buyer1", "", "viewer");
  db.prepare(`
    INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run("sh_listed", "d1", "premium", "viewer", "tok_abc", 5, "USDC", 1, null);
  cookieJar.set("aindrive_session", await sign("buyer1"));
});

describe("GET showcase/[shareId] — Buy-to-unlock redirect", () => {
  it("redirects to a RELATIVE /s/<token> Location (no leaked host)", async () => {
    const res = await buyReq("sh_listed");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location");
    // The core regression: Location must be the relative path, NOT an absolute
    // URL carrying the container's bind host (http://localhost:3737/...).
    expect(location).toBe("/s/tok_abc");
    expect(location?.startsWith("http")).toBe(false);
  });

  it("still gates: 404 for a share that is not a listed paid item", async () => {
    db.prepare(`
      INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency, listed, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run("sh_unlisted", "d1", "secret", "viewer", "tok_x", 9, "USDC", 0, null);
    const res = await buyReq("sh_unlisted");
    expect(res.status).toBe(404);
  });
});

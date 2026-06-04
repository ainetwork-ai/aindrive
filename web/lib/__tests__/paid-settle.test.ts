import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-settle-"));
process.env.AINDRIVE_DEV_BYPASS_X402 = "1";

// Per-test cookie jar: tests set entries here to drive getUser()/getWallet().
// The next/headers mock reads/writes it so cookies() works outside a request
// context (the handler calls cookies() via getUser + setWalletCookie).
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
const { GET } = await import("../../app/api/s/[token]/route.js");
const { sign } = await import("../session.js");

const PAYER = "0xpayerpayerpayerpayerpayerpayerpayer00001";
const LOGGED_PAYER = "0xpayerpayerpayerpayerpayerpayerpayer00002";
const UPGRADE_PAYER = "0xpayerpayerpayerpayerpayerpayerpayer00003";

function devPaymentHeader(from: string): string {
  // DEV_BYPASS accepts any well-formed JSON; reads authorization.from.
  const payload = { payload: { authorization: { from } } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("paid share settle → drive_members", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("owner1", "o@example.com", "Owner", "x");
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("member1", "m@example.com", "Member", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
      .run("d1", "owner1", "D1", "h", "s");
    db.prepare(
      "INSERT INTO shares (id, drive_id, path, role, token, price_usdc) VALUES (?,?,?,?,?,?)"
    ).run("sh1", "d1", "docs", "editor", "tok1", 2.0);
    // A viewer-tier paid share at the same path, used for the upgrade-only test.
    db.prepare(
      "INSERT INTO shares (id, drive_id, path, role, token, price_usdc) VALUES (?,?,?,?,?,?)"
    ).run("sh2", "d1", "docs", "viewer", "tok2", 1.0);
  });

  it("writes a drive_members grant for a placeholder account + receipt with account_id", async () => {
    cookieJar.clear();
    const req = new Request("http://localhost/api/s/tok1", {
      headers: { "X-PAYMENT": devPaymentHeader(PAYER) },
    });
    const res = await GET(req, { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(200);

    const link = db.prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
      .get(PAYER.toLowerCase()) as { account_id: string };
    expect(link.account_id).toMatch(/^w_/);

    const member = db.prepare(
      "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?"
    ).get("d1", link.account_id, "docs") as { role: string };
    expect(member.role).toBe("editor");

    const receipt = db.prepare("SELECT account_id FROM payment_receipts WHERE wallet = ?")
      .get(PAYER.toLowerCase()) as { account_id: string };
    expect(receipt.account_id).toBe(link.account_id);
  });

  it("attributes the grant + receipt to the logged-in session account, not a placeholder", async () => {
    cookieJar.clear();
    // getUser() resolves member1 via a real signed session cookie.
    cookieJar.set("aindrive_session", await sign("member1"));
    const req = new Request("http://localhost/api/s/tok1", {
      headers: { "X-PAYMENT": devPaymentHeader(LOGGED_PAYER) },
    });
    const res = await GET(req, { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(200);

    // drive_members keyed to the SESSION account (member1) — not a w_ placeholder.
    const member = db.prepare(
      "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?"
    ).get("d1", "member1", "docs") as { role: string };
    expect(member.role).toBe("editor");

    // Receipt is attributed to member1 too.
    const receipt = db.prepare("SELECT account_id FROM payment_receipts WHERE wallet = ?")
      .get(LOGGED_PAYER.toLowerCase()) as { account_id: string };
    expect(receipt.account_id).toBe("member1");

    // No wallet-placeholder account was minted for this payer.
    const placeholder = db.prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
      .get(LOGGED_PAYER.toLowerCase());
    expect(placeholder).toBeUndefined();
  });

  it("already-entitled member: a covering grant short-circuits the paywall (no re-charge, no downgrade)", async () => {
    cookieJar.clear();
    // A logged-in account that already holds editor at docs (seeded directly).
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("upmember", "up@example.com", "Up", "x");
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
      .run("dm_up", "d1", "upmember", "docs", "editor");
    cookieJar.set("aindrive_session", await sign("upmember"));

    // Re-open the VIEWER-tier paid share. The existing editor grant covers
    // share.role (viewer), so the GET returns early WITHOUT a paywall — the
    // member is never asked to pay again. No X-PAYMENT header is sent.
    const viewerReq = new Request("http://localhost/api/s/tok2");
    const res = await GET(viewerReq, { params: Promise.resolve({ token: "tok2" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("editor"); // returns existing role, not the share's viewer

    // The grant is untouched (still editor) — no downgrade.
    const member = db.prepare(
      "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?"
    ).get("d1", "upmember", "docs") as { role: string };
    expect(member.role).toBe("editor");

    // No payment ran, so no receipt was written for this fresh payer wallet.
    const receipt = db.prepare("SELECT account_id FROM payment_receipts WHERE share_id = ? AND wallet = ?")
      .get("sh2", UPGRADE_PAYER.toLowerCase());
    expect(receipt).toBeUndefined();
  });
});

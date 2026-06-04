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

    // Legacy folder_access row still written (removed in Phase 5).
    const fa = db.prepare(
      "SELECT role FROM folder_access WHERE drive_id = ? AND path = ? AND wallet_address = ?"
    ).get("d1", "docs", PAYER.toLowerCase()) as { role: string };
    expect(fa.role).toBe("editor");
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

  it("upgrade-only: a lower-tier paid share does NOT downgrade an existing higher role", async () => {
    cookieJar.clear();
    // A logged-in account that already holds editor at docs (seeded directly).
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("upmember", "up@example.com", "Up", "x");
    db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES (?,?,?,?,?)")
      .run("dm_up", "d1", "upmember", "docs", "editor");
    cookieJar.set("aindrive_session", await sign("upmember"));

    // Pay the VIEWER-tier share as this account, via a fresh payer wallet that
    // has no folder_access allowlist row (so the settle tail runs, not the
    // wallet-allowlist early return). The settle merge must keep editor.
    const viewerReq = new Request("http://localhost/api/s/tok2", {
      headers: { "X-PAYMENT": devPaymentHeader(UPGRADE_PAYER) },
    });
    expect((await GET(viewerReq, { params: Promise.resolve({ token: "tok2" }) })).status).toBe(200);

    const member = db.prepare(
      "SELECT role FROM drive_members WHERE drive_id = ? AND user_id = ? AND path = ?"
    ).get("d1", "upmember", "docs") as { role: string };
    expect(member.role).toBe("editor"); // NOT downgraded to viewer

    // The viewer-share settle still records a receipt, attributed to the account.
    const receipt = db.prepare("SELECT account_id FROM payment_receipts WHERE share_id = ? AND wallet = ?")
      .get("sh2", UPGRADE_PAYER.toLowerCase()) as { account_id: string };
    expect(receipt.account_id).toBe("upmember");
  });
});

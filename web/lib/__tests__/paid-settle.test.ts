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
  // DEV_BYPASS accepts any well-formed JSON; reads authorization.from
  // (eip3009 payloads) or permit2Authorization.from (permit2 payloads).
  const payload = { payload: { authorization: { from } } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function devPermit2PaymentHeader(from: string): string {
  const payload = { payload: { permit2Authorization: { from } } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodeRequiredHeader(res: Response) {
  const header = res.headers.get("PAYMENT-REQUIRED");
  expect(header).toBeTruthy();
  return JSON.parse(Buffer.from(header!, "base64").toString());
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
    // A drive whose policy allows a permit2 token (no EIP-3009/EIP-712 domain),
    // plus a share priced in it — exercises the v2 permit2 requirements path.
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, allowed_tokens) VALUES (?,?,?,?,?,?)")
      .run("d2", "owner1", "D2", "h2", "s2", JSON.stringify([
        { symbol: "FANCO", chain: "base", asset: "0x187e30921d687583e5e35f3dc6474f59a6e6fe5b", name: null, version: null, decimals: 18, transferMethod: "permit2" },
      ]));
    db.prepare(
      "INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency) VALUES (?,?,?,?,?,?,?)"
    ).run("sh3", "d2", "media", "viewer", "tok3", 5.0, "FANCO");
  });

  it("402 carries a v2 PAYMENT-REQUIRED header (eip3009 token: full EIP-712 domain in extra)", async () => {
    cookieJar.clear();
    const res = await GET(new Request("http://localhost/api/s/tok1"), { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(402);
    const pr = decodeRequiredHeader(res);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toContain("/api/s/tok1");
    expect(pr.accepts).toHaveLength(1);
    const r = pr.accepts[0];
    expect(r.scheme).toBe("exact");
    expect(r.network).toBe("eip155:84532"); // default testnet USDC
    expect(r.amount).toBe("2000000");
    expect(r.extra).toEqual({ assetTransferMethod: "eip3009", name: "USDC", version: "2" });
    // Informational body for the gate UI stays alongside the protocol header.
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.currency).toEqual({ symbol: "USDC", decimals: 6 });
  });

  it("402 carries permit2 requirements for tokens without an EIP-712 domain", async () => {
    cookieJar.clear();
    const res = await GET(new Request("http://localhost/api/s/tok3"), { params: Promise.resolve({ token: "tok3" }) });
    expect(res.status).toBe(402);
    const r = decodeRequiredHeader(res).accepts[0];
    expect(r.network).toBe("eip155:8453");
    expect(r.amount).toBe("5" + "0".repeat(18));
    expect(r.asset).toBe("0x187e30921d687583e5e35f3dc6474f59a6e6fe5b");
    // permit2 signs against the Permit2 contract domain — no token name/version.
    expect(r.extra).toEqual({ assetTransferMethod: "permit2" });
  });

  it("extracts the payer from permit2Authorization payloads", async () => {
    cookieJar.clear();
    const PERMIT2_PAYER = "0xpayerpayerpayerpayerpayerpayerpayer00004";
    const req = new Request("http://localhost/api/s/tok3", {
      headers: { "PAYMENT-SIGNATURE": devPermit2PaymentHeader(PERMIT2_PAYER) },
    });
    const res = await GET(req, { params: Promise.resolve({ token: "tok3" }) });
    expect(res.status).toBe(200);
    const receipt = db.prepare("SELECT network FROM payment_receipts WHERE wallet = ?")
      .get(PERMIT2_PAYER.toLowerCase()) as { network: string };
    // Receipts keep the internal chain name, not the CAIP-2 wire form.
    expect(receipt.network).toBe("base");
  });

  it("writes a drive_members grant for a placeholder account + receipt with account_id", async () => {
    cookieJar.clear();
    const req = new Request("http://localhost/api/s/tok1", {
      headers: { "PAYMENT-SIGNATURE": devPaymentHeader(PAYER) },
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
      headers: { "PAYMENT-SIGNATURE": devPaymentHeader(LOGGED_PAYER) },
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

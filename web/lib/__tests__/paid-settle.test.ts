import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-settle-"));
process.env.AINDRIVE_DEV_BYPASS_X402 = "1";

// Mock next/headers so cookies() returns an empty store outside a request context.
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

const { db } = await import("../db.js");
const { GET } = await import("../../app/api/s/[token]/route.js");

const PAYER = "0xpayerpayerpayerpayerpayerpayerpayer00001";

function devPaymentHeader(from: string): string {
  // DEV_BYPASS accepts any well-formed JSON; reads authorization.from.
  const payload = { payload: { authorization: { from } } };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("paid share settle → drive_members", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("owner1", "o@example.com", "Owner", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)")
      .run("d1", "owner1", "D1", "h", "s");
    db.prepare(
      "INSERT INTO shares (id, drive_id, path, role, token, price_usdc) VALUES (?,?,?,?,?,?)"
    ).run("sh1", "d1", "docs", "editor", "tok1", 2.0);
  });

  it("writes a drive_members grant for a placeholder account + receipt with account_id", async () => {
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
});

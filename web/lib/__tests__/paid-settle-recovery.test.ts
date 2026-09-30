import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The share gate when the facilitator refuses a settle whose transfer is in
// fact on-chain (its success answer was lost): the chain lookup
// (lib/x402-recover.ts) is mocked here and tested on its own in
// x402-recover.test.ts.
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-settle-recovery-"));
delete process.env.AINDRIVE_DEV_BYPASS_X402;

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

const settleMock = vi.fn();
const recoverMock = vi.fn();
vi.mock("../x402-facilitator", () => ({
  canSettle: () => true,
  verifyAndSettle: (...a: unknown[]) => settleMock(...a),
}));
vi.mock("../x402-recover", () => ({
  recoverSettledAuthorization: (...a: unknown[]) => recoverMock(...a),
}));

const { db } = await import("../db.js");
const { GET } = await import("../../app/api/s/[token]/route.js");
const { sign } = await import("../session.js");

const PAYER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TX = `0x${"12".repeat(32)}`;
const envelope = Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: { from: PAYER, nonce: `0x${"ab".repeat(32)}` } } })).toString("base64");

async function buy(userId: string | null, header = envelope) {
  cookieJar.clear();
  if (userId) cookieJar.set("aindrive_session", await sign(userId));
  return GET(new Request("http://localhost/api/s/rtok", { headers: { "PAYMENT-SIGNATURE": header } }), { params: Promise.resolve({ token: "rtok" }) });
}
const members = (userId: string) => db.prepare("SELECT role FROM drive_members WHERE drive_id = 'rd1' AND user_id = ?").all(userId);
const receipts = () => db.prepare("SELECT account_id, tx_hash, wallet FROM payment_receipts WHERE share_id = 'rsh1'").all() as { account_id: string; tx_hash: string; wallet: string }[];

describe("paid share: a settle answer lost after the transfer was mined", () => {
  beforeAll(() => {
    for (const [id, email] of [["rowner", "ro@example.com"], ["rbuyer", "rb@example.com"], ["rother", "rx@example.com"]]) {
      db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run(id, email, id, "x");
    }
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret) VALUES (?,?,?,?,?)").run("rd1", "rowner", "RD1", "h", "s");
    db.prepare("INSERT INTO shares (id, drive_id, path, role, token, price_usdc) VALUES (?,?,?,?,?,?)").run("rsh1", "rd1", "report.md", "viewer", "rtok", 0.5);
  });
  beforeEach(() => {
    settleMock.mockReset();
    recoverMock.mockReset();
  });

  it("refused settle, nothing on-chain → 402, no grant, no receipt", async () => {
    settleMock.mockResolvedValue({ ok: false, status: 402, reason: "invalid_exact_evm_transaction_simulation_failed" });
    recoverMock.mockResolvedValue(null);
    const res = await buy("rbuyer");
    expect(res.status).toBe(402);
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(members("rbuyer")).toEqual([]);
    expect(receipts()).toEqual([]);
  });

  it("refused settle, transfer found on-chain → 200 with that tx, one grant, one receipt", async () => {
    settleMock.mockResolvedValue({ ok: false, status: 402, reason: "invalid_exact_evm_nonce_already_used" });
    recoverMock.mockResolvedValue({ payer: PAYER, transaction: TX, network: "eip155:84532" });
    const res = await buy("rbuyer");
    expect(res.status).toBe(200);
    expect((await res.json()).txHash).toBe(TX);
    expect(members("rbuyer")).toEqual([{ role: "viewer" }]);
    expect(receipts()).toEqual([{ account_id: "rbuyer", tx_hash: TX, wallet: PAYER }]);
  });

  it("the same buyer retrying afterwards is already entitled: no settle, no second receipt", async () => {
    const res = await buy("rbuyer");
    expect(res.status).toBe(200);
    expect(settleMock).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(1);
  });

  it("another account replaying the credited envelope → 402, the payment is not credited twice", async () => {
    settleMock.mockResolvedValue({ ok: false, status: 402, reason: "invalid_exact_evm_transaction_simulation_failed" });
    recoverMock.mockResolvedValue({ payer: PAYER, transaction: TX, network: "eip155:84532" });
    const res = await buy("rother");
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("this payment has already been credited");
    expect(members("rother")).toEqual([]);
    expect(receipts()).toHaveLength(1);
  });

  it("the buyer's concurrent twin that lost the race to record the same tx → 200 as the member it now is", async () => {
    // Simulate the twin: while this request waits on the facilitator, the
    // winning request has already written the grant (receipt from above).
    db.prepare("DELETE FROM drive_members WHERE drive_id = 'rd1' AND user_id = 'rbuyer'").run();
    settleMock.mockImplementation(async () => {
      db.prepare("INSERT INTO drive_members (id, drive_id, user_id, path, role) VALUES ('rm-twin', 'rd1', 'rbuyer', 'report.md', 'viewer')").run();
      return { ok: false, status: 402, reason: "invalid_exact_evm_transaction_simulation_failed" };
    });
    recoverMock.mockResolvedValue({ payer: PAYER, transaction: TX, network: "eip155:84532" });
    const res = await buy("rbuyer");
    expect(res.status).toBe(200);
    expect((await res.json()).txHash).toBe(TX);
    expect(members("rbuyer")).toEqual([{ role: "viewer" }]);
    expect(receipts()).toHaveLength(1);
  });

  it("…but not once the owner revoked that grant: replaying the old envelope does not restore it", async () => {
    db.prepare("DELETE FROM drive_members WHERE drive_id = 'rd1' AND user_id = 'rbuyer'").run();
    settleMock.mockResolvedValue({ ok: false, status: 402, reason: "invalid_exact_evm_transaction_simulation_failed" });
    recoverMock.mockResolvedValue({ payer: PAYER, transaction: TX, network: "eip155:84532" });
    const res = await buy("rbuyer");
    expect(res.status).toBe(402);
    expect(members("rbuyer")).toEqual([]);
    expect(receipts()).toHaveLength(1);
  });

  it("a 503 (payments not configured) is answered as before, without a chain lookup", async () => {
    settleMock.mockResolvedValue({ ok: false, status: 503, reason: "payments are not configured on this server" });
    const res = await buy("rother");
    expect(res.status).toBe(503);
    expect(recoverMock).not.toHaveBeenCalled();
  });
});

// Non-bypass x402 v2 protocol behaviour of /api/s/[token]: facilitator
// verify/settle wiring, the permit2_allowance_required → 412 mapping, and
// settle-failure surfacing. The facilitator client is mocked — on-chain truth
// is the facilitator's job, ours is the HTTP/status/bookkeeping contract.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-x402v2-"));
delete process.env.AINDRIVE_DEV_BYPASS_X402;

const { verifyMock, settleMock } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  settleMock: vi.fn(),
}));
vi.mock("@x402/core/server", () => ({
  HTTPFacilitatorClient: class {
    constructor(_cfg?: unknown) {}
    verify = verifyMock;
    settle = settleMock;
  },
}));

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

const PAYER = "0xpayerpayerpayerpayerpayerpayerpayerd2001";

function v2PaymentHeader(payloadInner: object): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload: payloadInner })).toString("base64");
}

function payingReq(token: string): Request {
  return new Request(`http://localhost/api/s/${token}`, {
    headers: { "PAYMENT-SIGNATURE": v2PaymentHeader({ permit2Authorization: { from: PAYER } }) },
  });
}

describe("x402 v2 verify/settle protocol", () => {
  beforeAll(() => {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run("owner1", "o@example.com", "Owner", "x");
    db.prepare("INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, allowed_tokens) VALUES (?,?,?,?,?,?)")
      .run("d1", "owner1", "D1", "h", "s", JSON.stringify([
        { symbol: "FANCO", chain: "base-sepolia", asset: "0x187e30921d687583e5e35f3dc6474f59a6e6fe5b", name: null, version: null, decimals: 18, transferMethod: "permit2" },
      ]));
    db.prepare(
      "INSERT INTO shares (id, drive_id, path, role, token, price_usdc, currency) VALUES (?,?,?,?,?,?,?)"
    ).run("sh1", "d1", "docs", "viewer", "tok1", 3.0, "FANCO");
  });

  beforeEach(() => {
    cookieJar.clear();
    verifyMock.mockReset();
    settleMock.mockReset();
  });

  it("maps permit2_allowance_required to 412 and never settles", async () => {
    verifyMock.mockResolvedValue({ isValid: false, invalidReason: "permit2_allowance_required" });
    const res = await GET(payingReq("tok1"), { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(412);
    const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    expect(pr.error).toBe("permit2_allowance_required");
    expect(settleMock).not.toHaveBeenCalled();
  });

  it("other verify failures stay 402", async () => {
    verifyMock.mockResolvedValue({ isValid: false, invalidReason: "invalid_signature" });
    const res = await GET(payingReq("tok1"), { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(402);
    expect(settleMock).not.toHaveBeenCalled();
  });

  it("settles a valid permit2 payment: 200, receipt, grant", async () => {
    verifyMock.mockResolvedValue({ isValid: true, payer: PAYER });
    settleMock.mockResolvedValue({ success: true, transaction: "0xfacetx1", payer: PAYER, network: "eip155:84532" });
    const res = await GET(payingReq("tok1"), { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.txHash).toBe("0xfacetx1");
    // verify/settle were both called with OUR requirements, not the client echo.
    const [, verifyReqs] = verifyMock.mock.calls[0];
    expect(verifyReqs.amount).toBe("3" + "0".repeat(18));
    expect(verifyReqs.network).toBe("eip155:84532");
    expect(verifyReqs.extra).toEqual({ assetTransferMethod: "permit2" });
    const receipt = db.prepare("SELECT tx_hash, network FROM payment_receipts WHERE wallet = ?")
      .get(PAYER.toLowerCase()) as { tx_hash: string; network: string };
    expect(receipt.tx_hash).toBe("0xfacetx1");
    expect(receipt.network).toBe("base-sepolia");
  });

  it("surfaces settle failure as 402 with the facilitator reason", async () => {
    verifyMock.mockResolvedValue({ isValid: true, payer: PAYER });
    settleMock.mockResolvedValue({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
    const res = await GET(payingReq("tok1"), { params: Promise.resolve({ token: "tok1" }) });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("insufficient_funds");
  });
});

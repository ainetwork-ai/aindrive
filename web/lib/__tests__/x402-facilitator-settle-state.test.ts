import { describe, it, expect, vi, beforeEach } from "vitest";

// verifyAndSettle (lib/x402-facilitator.ts): the beforeSettle hook runs only
// after verify passed and right before settle, and a failure says what settle
// did — "not_sent", "refused" (one request, answered with a pre-broadcast
// refusal) or "uncertain" (everything else). The route releases an account's
// row only on "refused" (docs/X402_PAYMENT_PENDING.md).
process.env.AINDRIVE_X402_FACILITATOR = "http://facilitator.test";
delete process.env.AINDRIVE_DEV_BYPASS_X402;

type SettleAnswer =
  | { kind: "ok" }
  | { kind: "fail"; reason: string; transaction?: string }
  | { kind: "throw"; error: Error };
const fac = { valid: true, verifyThrows: null as Error | null, calls: [] as string[], settles: [] as SettleAnswer[] };
class SettleError extends Error {
  constructor(readonly statusCode: number, readonly errorReason: string, readonly transaction = "") { super(errorReason); this.name = "SettleError"; }
}
const timeout = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const netDown = () => new TypeError("fetch failed");
vi.mock("@x402/core/server", () => ({
  HTTPFacilitatorClient: class {
    async verify() {
      fac.calls.push("verify");
      if (fac.verifyThrows) throw fac.verifyThrows;
      return fac.valid ? { isValid: true } : { isValid: false, invalidReason: "invalid_exact_evm_signature" };
    }
    async settle() {
      fac.calls.push("settle");
      const a = fac.settles.shift() ?? { kind: "ok" };
      if (a.kind === "throw") throw a.error;
      if (a.kind === "fail") return { success: false, errorReason: a.reason, transaction: a.transaction ?? "", network: "eip155:84532" };
      return { success: true, transaction: "0xabc", network: "eip155:84532", payer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" };
    }
  },
}));
const { verifyAndSettle, PRE_BROADCAST_REFUSALS } = await import("../x402-facilitator");
const payload = { x402Version: 2, payload: { authorization: { from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" } } } as never;
const requirements = { network: "eip155:84532", scheme: "exact", amount: "1", payTo: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", asset: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", maxTimeoutSeconds: 300 } as never;
const hook = () => { fac.calls.push("hook"); return null; };

describe("verifyAndSettle: beforeSettle and settle state", () => {
  beforeEach(() => { fac.valid = true; fac.verifyThrows = null; fac.calls = []; fac.settles = []; });

  it("runs the hook between verify and settle", async () => {
    const out = await verifyAndSettle(payload, requirements, "t", { beforeSettle: hook });
    expect(out.ok).toBe(true);
    expect(fac.calls).toEqual(["verify", "hook", "settle"]);
  });

  it("verify refused: hook not run, nothing sent", async () => {
    fac.valid = false;
    const out = await verifyAndSettle(payload, requirements, "t", { beforeSettle: hook });
    expect(out).toMatchObject({ ok: false, status: 402, settle: "not_sent" });
    expect(fac.calls).toEqual(["verify"]);
  });

  it("verify unreachable: hook not run, nothing sent", async () => {
    fac.verifyThrows = netDown();
    const out = await verifyAndSettle(payload, requirements, "t", { beforeSettle: hook });
    expect(out).toMatchObject({ ok: false, status: 402, settle: "not_sent" });
    expect(fac.calls).toEqual(["verify", "verify"]);
  });

  it("a hook reason stops before settle (409 aborted, not_sent)", async () => {
    const out = await verifyAndSettle(payload, requirements, "t", { beforeSettle: () => "pending" });
    expect(out).toEqual({ ok: false, status: 409, reason: "pending", settle: "not_sent", aborted: true });
    expect(fac.calls).toEqual(["verify"]);
  });

  it("a hook throw (row not written) stops before settle as 503", async () => {
    const out = await verifyAndSettle(payload, requirements, "t", { beforeSettle: () => { throw new Error("SQLITE_BUSY"); } });
    expect(out).toMatchObject({ ok: false, status: 503, settle: "not_sent" });
    expect(fac.calls).toEqual(["verify"]);
  });

  it("first settle answered with a pre-broadcast refusal → refused", async () => {
    fac.settles = [{ kind: "fail", reason: "invalid_exact_evm_signature" }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, settle: "refused" });
  });

  it("the same refusal as a non-2xx SettleError → refused", async () => {
    fac.settles = [{ kind: "throw", error: new SettleError(400, "invalid_exact_evm_recipient_mismatch") }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, settle: "refused" });
  });

  for (const reason of [
    "invalid_exact_evm_nonce_already_used", // our own earlier broadcast (facilitator-internal retry) can cause it
    "invalid_exact_evm_insufficient_balance", // so can our own transfer having moved the funds
    "invalid_exact_evm_payload_authorization_valid_before", // expiry is checked before "used" by the token
    "invalid_exact_evm_transaction_failed", // broadcast, reverted or lost
    "invalid_exact_evm_transaction_simulation_failed",
    "some_unknown_reason",
  ]) {
    it(`first settle answered ${reason} → uncertain`, async () => {
      fac.settles = [{ kind: "fail", reason }];
      expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, settle: "uncertain" });
      expect(PRE_BROADCAST_REFUSALS.has(reason)).toBe(false);
    });
  }

  it("a refusal that names a transaction (it was broadcast) → uncertain", async () => {
    fac.settles = [{ kind: "fail", reason: "invalid_exact_evm_signature", transaction: "0xdead" }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, settle: "uncertain" });
  });

  it("timeout then a pre-broadcast refusal on the retry → uncertain (the first may have broadcast)", async () => {
    fac.settles = [{ kind: "throw", error: timeout() }, { kind: "fail", reason: "invalid_exact_evm_signature" }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, settle: "uncertain" });
    expect(fac.calls).toEqual(["verify", "settle", "settle"]);
  });

  it("timeout on both requests → uncertain", async () => {
    fac.settles = [{ kind: "throw", error: timeout() }, { kind: "throw", error: timeout() }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, status: 402, settle: "uncertain" });
  });

  it("network error, then a SettleError refusal on the retry → uncertain", async () => {
    fac.settles = [{ kind: "throw", error: netDown() }, { kind: "throw", error: new SettleError(400, "invalid_exact_evm_signature") }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, settle: "uncertain" });
  });

  it("a non-SettleError failure (HTTP 500 text) → uncertain", async () => {
    fac.settles = [{ kind: "throw", error: new Error("Facilitator settle failed (500): oops") }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: false, settle: "uncertain" });
  });

  it("timeout then success → ok", async () => {
    fac.settles = [{ kind: "throw", error: timeout() }, { kind: "ok" }];
    expect(await verifyAndSettle(payload, requirements, "t")).toMatchObject({ ok: true, transaction: "0xabc" });
  });
});

import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { recoverSettledAuthorization, type RecoveryClient } from "../x402-recover";

const ASSET = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const PAYER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAY_TO = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const OTHER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const NONCE = `0x${"ab".repeat(32)}` as const;
const TX = `0x${"12".repeat(32)}` as const;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact", network: "eip155:84532", amount: "500000", payTo: PAY_TO, asset: ASSET, maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" }, ...over,
} as PaymentRequirements);
const payload = (auth: Record<string, unknown> = {}): PaymentPayload => ({
  x402Version: 2,
  payload: { signature: "0x00", authorization: { from: PAYER, to: PAY_TO, value: "500000", validAfter: "0", validBefore: "9999999999", nonce: NONCE, ...auth } },
} as unknown as PaymentPayload);

function transferLog(from: string, to: string, value: bigint, address = ASSET) {
  return {
    address,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

type Fake = { used?: boolean; logs?: { transactionHash: `0x${string}` }[]; status?: string; receiptLogs?: ReturnType<typeof transferLog>[]; fail?: boolean };
function client(f: Fake): RecoveryClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readContract: (async (a: { functionName: string; args: unknown[] }) => { calls.push(`read:${a.functionName}`); if (f.fail) throw new Error("rpc down"); return f.used ?? false; }) as never,
    getBlockNumber: (async () => { calls.push("block"); return 20_000n; }) as never,
    getLogs: (async (a: { fromBlock: bigint; args: { authorizer: string; nonce: string } }) => {
      calls.push(`logs:${a.fromBlock}:${a.args.authorizer}:${a.args.nonce === NONCE}`);
      return f.logs ?? [];
    }) as never,
    getTransactionReceipt: (async () => { calls.push("receipt"); return { status: f.status ?? "success", logs: f.receiptLogs ?? [] }; }) as never,
  };
}

describe("recoverSettledAuthorization", () => {
  it("credits the tx whose AuthorizationUsed log and Transfer match this sale", async () => {
    const c = client({ used: true, logs: [{ transactionHash: TX }], receiptLogs: [transferLog(PAYER, PAY_TO, 500000n)] });
    const r = await recoverSettledAuthorization(payload(), requirements(), c);
    expect(r).toEqual({ payer: PAYER, transaction: TX, network: "eip155:84532" });
    expect(c.calls).toContain(`logs:10000:${PAYER}:true`); // default look-back 10 000 blocks
  });

  it("an unused authorization (nothing settled) → null, no log scan", async () => {
    const c = client({ used: false });
    expect(await recoverSettledAuthorization(payload(), requirements(), c)).toBeNull();
    expect(c.calls).toEqual(["read:authorizationState"]);
  });

  it("used but no AuthorizationUsed log in range (e.g. cancelled, or too old) → null", async () => {
    expect(await recoverSettledAuthorization(payload(), requirements(), client({ used: true, logs: [] }))).toBeNull();
  });

  it("the tx moved money elsewhere, a different amount, or another token → null", async () => {
    for (const bad of [transferLog(PAYER, OTHER, 500000n), transferLog(PAYER, PAY_TO, 499999n), transferLog(PAYER, PAY_TO, 500000n, OTHER)]) {
      expect(await recoverSettledAuthorization(payload(), requirements(), client({ used: true, logs: [{ transactionHash: TX }], receiptLogs: [bad] }))).toBeNull();
    }
  });

  it("a reverted tx → null", async () => {
    const c = client({ used: true, logs: [{ transactionHash: TX }], status: "reverted", receiptLogs: [transferLog(PAYER, PAY_TO, 500000n)] });
    expect(await recoverSettledAuthorization(payload(), requirements(), c)).toBeNull();
  });

  it("an envelope for another seller or price is not looked up at all", async () => {
    const c1 = client({ used: true });
    expect(await recoverSettledAuthorization(payload({ to: OTHER }), requirements(), c1)).toBeNull();
    const c2 = client({ used: true });
    expect(await recoverSettledAuthorization(payload({ value: "1" }), requirements(), c2)).toBeNull();
    expect([...c1.calls, ...c2.calls]).toEqual([]);
  });

  it("permit2 sales, malformed payloads, unknown networks and RPC errors → null", async () => {
    const ok = { used: true, logs: [{ transactionHash: TX }], receiptLogs: [transferLog(PAYER, PAY_TO, 500000n)] };
    expect(await recoverSettledAuthorization(payload(), requirements({ extra: { assetTransferMethod: "permit2" } }), client(ok))).toBeNull();
    expect(await recoverSettledAuthorization({ x402Version: 2, payload: {} } as unknown as PaymentPayload, requirements(), client(ok))).toBeNull();
    expect(await recoverSettledAuthorization(payload({ nonce: "0x01" }), requirements(), client(ok))).toBeNull();
    expect(await recoverSettledAuthorization(payload(), requirements({ network: "eip155:1" }))).toBeNull(); // no RPC for that chain
    expect(await recoverSettledAuthorization(payload(), requirements(), client({ ...ok, fail: true }))).toBeNull();
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi } from "viem";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-paymaster-"));

const {
  mintSponsorGrant, verifySponsorGrant, validateSponsoredUserOp,
  PERMIT2_ADDRESS, SPONSOR_GRANT_TTL_MS,
} = await import("../paymaster.js");

const WALLET = "0xAbCd00000000000000000000000000000000AbCd";
const FANCO = "0x187e30921D687583E5E35f3Dc6474F59A6e6FE5B";
const AMOUNT = "5000000000000000000"; // 5 FANCO (18 decimals)

const smartWalletAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount)"]);

const approveData = (spender: string, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount] });

const executeWrap = (target: string, value: bigint, data: `0x${string}`) =>
  encodeFunctionData({ abi: smartWalletAbi, functionName: "execute", args: [target as `0x${string}`, value, data] });

const mkGrant = () => mintSponsorGrant({ wallet: WALLET, asset: FANCO, chainId: 8453, amount: AMOUNT });

afterEach(() => vi.useRealTimers());

describe("sponsor grant mint/verify", () => {
  it("round-trips and normalises addresses to lowercase", () => {
    const g = verifySponsorGrant(mkGrant());
    expect(g).not.toBeNull();
    expect(g!.wallet).toBe(WALLET.toLowerCase());
    expect(g!.asset).toBe(FANCO.toLowerCase());
    expect(g!.chainId).toBe(8453);
    expect(g!.amount).toBe(AMOUNT);
  });

  it("rejects a tampered payload (amount swap) and a truncated grant", () => {
    const grant = mkGrant();
    const [body, sig] = [grant.slice(0, grant.lastIndexOf(".")), grant.slice(grant.lastIndexOf(".") + 1)];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    payload.amount = "999999999999999999999999";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(verifySponsorGrant(forged)).toBeNull();
    expect(verifySponsorGrant(body)).toBeNull();      // no sig part
    expect(verifySponsorGrant("garbage")).toBeNull();
  });

  it("rejects an expired grant", () => {
    const grant = mkGrant();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SPONSOR_GRANT_TTL_MS + 1000);
    expect(verifySponsorGrant(grant)).toBeNull();
  });
});

describe("validateSponsoredUserOp — only the exact granted approve passes", () => {
  const grant = verifySponsorGrant(mkGrant())!;

  it("accepts execute-wrapped approve(PERMIT2, grant.amount) on the granted asset", () => {
    const callData = executeWrap(FANCO, 0n, approveData(PERMIT2_ADDRESS, BigInt(AMOUNT)));
    expect(validateSponsoredUserOp({ grant, sender: WALLET, callData })).toEqual({ ok: true });
  });

  it("accepts a single-call executeBatch wrapping the same approve", () => {
    const callData = encodeFunctionData({
      abi: smartWalletAbi, functionName: "executeBatch",
      args: [[{ target: FANCO as `0x${string}`, value: 0n, data: approveData(PERMIT2_ADDRESS, BigInt(AMOUNT)) }]],
    });
    expect(validateSponsoredUserOp({ grant, sender: WALLET, callData })).toEqual({ ok: true });
  });

  it("rejects: wrong sender / wrong target / wrong spender / wrong amount / nonzero value", () => {
    const good = approveData(PERMIT2_ADDRESS, BigInt(AMOUNT));
    const cases: Array<{ sender?: string; callData: `0x${string}` }> = [
      { sender: "0x1111111111111111111111111111111111111111", callData: executeWrap(FANCO, 0n, good) },
      { callData: executeWrap("0x2222222222222222222222222222222222222222", 0n, good) }, // not the asset
      { callData: executeWrap(FANCO, 0n, approveData("0x3333333333333333333333333333333333333333", BigInt(AMOUNT))) },
      { callData: executeWrap(FANCO, 0n, approveData(PERMIT2_ADDRESS, BigInt(AMOUNT) + 1n)) },
      { callData: executeWrap(FANCO, 1n, good) }, // value transfer
    ];
    for (const c of cases) {
      const res = validateSponsoredUserOp({ grant, sender: c.sender ?? WALLET, callData: c.callData });
      expect(res.ok).toBe(false);
    }
  });

  it("rejects a batch smuggling a second call alongside the approve", () => {
    const callData = encodeFunctionData({
      abi: smartWalletAbi, functionName: "executeBatch",
      args: [[
        { target: FANCO as `0x${string}`, value: 0n, data: approveData(PERMIT2_ADDRESS, BigInt(AMOUNT)) },
        { target: FANCO as `0x${string}`, value: 0n, data: approveData("0x4444444444444444444444444444444444444444", 2n ** 255n) },
      ]],
    });
    expect(validateSponsoredUserOp({ grant, sender: WALLET, callData }).ok).toBe(false);
  });

  it("rejects junk callData and a bare (unwrapped) approve", () => {
    expect(validateSponsoredUserOp({ grant, sender: WALLET, callData: "0xdeadbeef" }).ok).toBe(false);
    expect(validateSponsoredUserOp({ grant, sender: WALLET, callData: approveData(PERMIT2_ADDRESS, BigInt(AMOUNT)) }).ok).toBe(false);
    expect(validateSponsoredUserOp({ grant, sender: WALLET, callData: "not-hex" }).ok).toBe(false);
  });
});

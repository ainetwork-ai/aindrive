import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, maxUint256 } from "viem";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-paymaster-"));

const { db } = await import("../db.js");
const {
  mintSponsorGrant, verifySponsorGrant, validateSponsoredApprove,
  checkSponsorBudget, consumeSponsorGrant, releaseSponsorGrant,
  PERMIT2_ADDRESS, SPONSOR_GRANT_TTL_MS,
} = await import("../paymaster.js");

const USER = "user_1";
const WALLET = "0xAbCd00000000000000000000000000000000AbCd";
const FANCO = "0x187e30921D687583E5E35f3Dc6474F59A6e6FE5B";
const AMOUNT = "5000000000000000000"; // 5 FANCO (18 decimals)
const TOKEN = "share_tok_abc";

const smartWalletAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);
const erc20Abi = parseAbi(["function approve(address spender, uint256 amount)"]);

const approveData = (spender: string, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as `0x${string}`, amount] });
const executeWrap = (target: string, value: bigint, data: `0x${string}`) =>
  encodeFunctionData({ abi: smartWalletAbi, functionName: "execute", args: [target as `0x${string}`, value, data] });

const mkGrant = (over: Partial<{ userId: string; token: string; wallet: string }> = {}) =>
  mintSponsorGrant({
    userId: over.userId ?? USER, token: over.token ?? TOKEN, wallet: over.wallet ?? WALLET,
    asset: FANCO, chainId: 8453, amount: AMOUNT,
  });
const goodCallData = () => executeWrap(FANCO, 0n, approveData(PERMIT2_ADDRESS, BigInt(AMOUNT)));

beforeEach(() => { db.prepare("DELETE FROM sponsored_ops").run(); });
afterEach(() => {
  vi.useRealTimers();
  delete process.env.AINDRIVE_PAYMASTER_DAILY_CAP;
  delete process.env.AINDRIVE_PAYMASTER_USER_DAILY_CAP;
});

describe("sponsor grant mint/verify", () => {
  it("round-trips (lowercased addrs, jti + sub + token present)", () => {
    const g = verifySponsorGrant(mkGrant())!;
    expect(g.wallet).toBe(WALLET.toLowerCase());
    expect(g.asset).toBe(FANCO.toLowerCase());
    expect(g.chainId).toBe(8453);
    expect(g.amount).toBe(AMOUNT);
    expect(g.sub).toBe(USER);
    expect(g.token).toBe(TOKEN);
    expect(g.jti).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives each grant a distinct jti", () => {
    expect(verifySponsorGrant(mkGrant())!.jti).not.toBe(verifySponsorGrant(mkGrant())!.jti);
  });

  it("rejects tamper (amount swap), truncation, and expiry", () => {
    const grant = mkGrant();
    const dot = grant.lastIndexOf(".");
    const payload = JSON.parse(Buffer.from(grant.slice(0, dot), "base64url").toString());
    payload.amount = "999999999999999999999999";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${grant.slice(dot + 1)}`;
    expect(verifySponsorGrant(forged)).toBeNull();
    expect(verifySponsorGrant(grant.slice(0, dot))).toBeNull();
    expect(verifySponsorGrant("garbage")).toBeNull();

    const g2 = mkGrant();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + SPONSOR_GRANT_TTL_MS + 1000);
    expect(verifySponsorGrant(g2)).toBeNull();
  });
});

describe("validateSponsoredApprove — shape", () => {
  const grant = verifySponsorGrant(mkGrant())!;
  const ok = (op: object) => validateSponsoredApprove({ grant, op, enforceGas: false });

  it("accepts execute- and single-executeBatch-wrapped approve(PERMIT2, amount)", () => {
    expect(ok({ sender: WALLET, callData: goodCallData() })).toEqual({ ok: true });
    const batch = encodeFunctionData({
      abi: smartWalletAbi, functionName: "executeBatch",
      args: [[{ target: FANCO as `0x${string}`, value: 0n, data: approveData(PERMIT2_ADDRESS, BigInt(AMOUNT)) }]],
    });
    expect(ok({ sender: WALLET, callData: batch })).toEqual({ ok: true });
  });

  it("rejects wrong sender / target / spender / amount / value / multi-call / junk / bare approve", () => {
    const good = approveData(PERMIT2_ADDRESS, BigInt(AMOUNT));
    const bad: object[] = [
      { sender: "0x1111111111111111111111111111111111111111", callData: goodCallData() },
      { sender: WALLET, callData: executeWrap("0x2222222222222222222222222222222222222222", 0n, good) },
      { sender: WALLET, callData: executeWrap(FANCO, 0n, approveData("0x3333333333333333333333333333333333333333", BigInt(AMOUNT))) },
      { sender: WALLET, callData: executeWrap(FANCO, 0n, approveData(PERMIT2_ADDRESS, BigInt(AMOUNT) + 1n)) },
      { sender: WALLET, callData: executeWrap(FANCO, 1n, good) },
      { sender: WALLET, callData: encodeFunctionData({
        abi: smartWalletAbi, functionName: "executeBatch",
        args: [[
          { target: FANCO as `0x${string}`, value: 0n, data: good },
          { target: FANCO as `0x${string}`, value: 0n, data: approveData("0x4444444444444444444444444444444444444444", 2n ** 255n) },
        ]] }) },
      { sender: WALLET, callData: "0xdeadbeef" },
      { sender: WALLET, callData: good }, // bare, not execute-wrapped
      { sender: WALLET, callData: "not-hex" },
    ];
    for (const op of bad) expect(ok(op).ok).toBe(false);
  });
});

describe("validateSponsoredApprove — unlimited (MaxUint256) approve is the production shape", () => {
  // grant/route mints amount = maxUint256, so the sponsored approve is unlimited
  // (one-time per wallet). Validation still pins op.amount === grant.amount.
  const grant = verifySponsorGrant(
    mintSponsorGrant({ userId: USER, token: TOKEN, wallet: WALLET, asset: FANCO, chainId: 8453, amount: maxUint256.toString() }),
  )!;
  it("accepts a max-uint approve matching the grant", () => {
    const callData = executeWrap(FANCO, 0n, approveData(PERMIT2_ADDRESS, maxUint256));
    expect(validateSponsoredApprove({ grant, op: { sender: WALLET, callData }, enforceGas: false })).toEqual({ ok: true });
  });
  it("rejects any amount other than the granted max (can't downscale/upscale)", () => {
    const callData = executeWrap(FANCO, 0n, approveData(PERMIT2_ADDRESS, maxUint256 - 1n));
    expect(validateSponsoredApprove({ grant, op: { sender: WALLET, callData }, enforceGas: false }).ok).toBe(false);
  });
});

describe("validateSponsoredApprove — gas caps (C1)", () => {
  const grant = verifySponsorGrant(mkGrant())!;
  const base = { sender: WALLET, callData: goodCallData() };

  it("ignores gas fields when enforceGas is false (stub stage)", () => {
    expect(validateSponsoredApprove({ grant, op: { ...base, callGasLimit: "0xffffffff" }, enforceGas: false }))
      .toEqual({ ok: true });
  });

  it("passes a normal approve op under the caps when enforced", () => {
    const op = { ...base, callGasLimit: "0xC350" /* 50000 */, maxFeePerGas: "0x3B9ACA00" /* 1 gwei */ };
    expect(validateSponsoredApprove({ grant, op, enforceGas: true })).toEqual({ ok: true });
  });

  it("rejects an inflated callGasLimit and an inflated maxFeePerGas when enforced", () => {
    expect(validateSponsoredApprove({ grant, op: { ...base, callGasLimit: 5_000_000 }, enforceGas: true }).ok).toBe(false);
    expect(validateSponsoredApprove({ grant, op: { ...base, maxFeePerGas: 100_000_000_000 }, enforceGas: true }).ok).toBe(false);
  });
});

describe("consumeSponsorGrant — one-time (H1)", () => {
  it("claims once, refuses replay, and release re-opens it", () => {
    const g = verifySponsorGrant(mkGrant())!;
    expect(consumeSponsorGrant(g)).toBe(true);
    expect(consumeSponsorGrant(g)).toBe(false); // replay blocked
    releaseSponsorGrant(g.jti);
    expect(consumeSponsorGrant(g)).toBe(true);  // released → claimable again
  });
});

describe("checkSponsorBudget — rolling 24h caps (H2/H3)", () => {
  it("blocks once the per-user cap is spent, and the global cap independently", () => {
    process.env.AINDRIVE_PAYMASTER_USER_DAILY_CAP = "2";
    process.env.AINDRIVE_PAYMASTER_DAILY_CAP = "100";
    expect(checkSponsorBudget(USER).ok).toBe(true);
    consumeSponsorGrant(verifySponsorGrant(mkGrant())!);
    consumeSponsorGrant(verifySponsorGrant(mkGrant())!);
    const perUser = checkSponsorBudget(USER);
    expect(perUser.ok).toBe(false);
    // a DIFFERENT user is unaffected by the per-user cap...
    expect(checkSponsorBudget("user_2").ok).toBe(true);
    // ...until the GLOBAL cap bites.
    process.env.AINDRIVE_PAYMASTER_DAILY_CAP = "2";
    expect(checkSponsorBudget("user_2").ok).toBe(false);
  });
});

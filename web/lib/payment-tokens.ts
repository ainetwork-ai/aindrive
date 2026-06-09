// Payment-token presets a drive owner can allow. decimals/EIP-712 fields feed
// x402 requirements; FANCO's eip712 fields are null — its on-chain settle needs
// the Permit2 path (x402 v2), tracked as Phase 2b. Under DEV_BYPASS the policy
// plumbing (402 body, receipts, UI) is fully exercisable regardless.
export type PaymentToken = {
  symbol: string; chain: string; asset: string;
  name: string | null; version: string | null; decimals: number;
};
export const TOKEN_PRESETS: Record<string, PaymentToken> = {
  USDC: { symbol: "USDC", chain: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6 },
  FANCO: { symbol: "FANCO", chain: "base", asset: "", name: null, version: null, decimals: 18 },
};
export const DEFAULT_TOKENS: PaymentToken[] = [TOKEN_PRESETS.USDC];

function isPaymentToken(t: unknown): t is PaymentToken {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.symbol === "string" &&
    typeof o.chain === "string" &&
    typeof o.asset === "string" &&
    (o.name === null || typeof o.name === "string") &&
    (o.version === null || typeof o.version === "string") &&
    typeof o.decimals === "number" && Number.isInteger(o.decimals)
  );
}

// drives.allowed_tokens (JSON TEXT) → token policy. NULL / empty array /
// unparsable / malformed entries all fall back to DEFAULT_TOKENS so a bad
// policy row can never brick payments (preserves pre-policy behaviour).
export function resolveDriveTokens(allowedTokensJson: string | null): PaymentToken[] {
  if (!allowedTokensJson) return DEFAULT_TOKENS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(allowedTokensJson);
  } catch {
    return DEFAULT_TOKENS;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isPaymentToken)) {
    return DEFAULT_TOKENS;
  }
  return parsed;
}

// [rev2-B] 금액 스케일링은 절대 float 곱셈 금지: 18 decimals에서 price 0.01만 돼도
// Number.MAX_SAFE_INTEGER 초과(정밀도 손실), 1000 이상이면 "1e+21" 지수표기가 되어
// x402의 digit-string 검증/BigInt() 소비자가 throw. BigInt 십진 문자열 스케일링으로.
export function toAtomicAmount(price: number, decimals: number): string {
  // price는 소수 2자리까지만 허용(shares 입력 검증과 동일) — 그 이상은 반올림.
  const cents = Math.round(price * 100); // safe: price < 1e13
  return (BigInt(cents) * 10n ** BigInt(decimals - 2)).toString();
}

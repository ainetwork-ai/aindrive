// Payment-token presets a drive owner can allow. decimals/EIP-712 fields feed
// x402 requirements; FANCO's eip712 fields are null — its on-chain settle needs
// the Permit2 path (x402 v2), tracked as Phase 2b. Under DEV_BYPASS the policy
// plumbing (402 body, receipts, UI) is fully exercisable regardless.
export type PaymentToken = {
  symbol: string; chain: string; asset: string;
  name: string | null; version: string | null; decimals: number;
};
export const TOKEN_PRESETS: Record<string, PaymentToken> = {
  // x402-settleable (EIP-3009 transferWithAuthorization + EIP-712 domain). name/
  // version are the on-chain EIP-712 domain values — getting them wrong breaks
  // signature verification, so they're hand-verified here. Add more major tokens
  // only with confirmed name/version; otherwise owners add them via the custom
  // token flow, which reads these from chain.
  USDC: { symbol: "USDC", chain: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6 },
  // Not yet settleable on-chain: no EIP-3009 path (name/version null) — its
  // settle needs the Permit2 route (x402 v2), tracked as Phase 2b. Owners must
  // supply the asset address. Exercisable under DEV_BYPASS for the full UI/402
  // plumbing, but real settlement is deferred.
  FANCO: { symbol: "FANCO", chain: "base", asset: "", name: null, version: null, decimals: 18 },
};
export const DEFAULT_TOKENS: PaymentToken[] = [TOKEN_PRESETS.USDC];

// x402's "exact" scheme settles via EIP-3009 transferWithAuthorization, which
// needs a complete EIP-712 domain (name + version). A token missing either has
// no on-chain settle path yet (e.g. FANCO → Permit2/Phase 2b): the UI can list
// it and exercise the 402 flow under DEV_BYPASS, but it can't take real money.
export function isX402Settleable(t: Pick<PaymentToken, "name" | "version" | "asset">): boolean {
  return !!(t.name && t.version && t.asset);
}

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

// Strict counterpart of resolveDriveTokens for *writes*: returns null on
// garbage instead of falling back, so the drive PATCH route can 400 a bad
// policy rather than silently storing one that reads back as the default.
export function parseTokenPolicy(json: string): PaymentToken[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isPaymentToken)) return null;
  return parsed;
}

// drives.allowed_tokens (JSON TEXT) → token policy. NULL / empty array /
// unparsable / malformed entries all fall back to DEFAULT_TOKENS so a bad
// policy row can never brick payments (preserves pre-policy behaviour).
export function resolveDriveTokens(allowedTokensJson: string | null): PaymentToken[] {
  if (!allowedTokensJson) return DEFAULT_TOKENS;
  return parseTokenPolicy(allowedTokensJson) ?? DEFAULT_TOKENS;
}

// [rev2-B] 금액 스케일링은 절대 float 곱셈 금지: 18 decimals에서 price 0.01만 돼도
// Number.MAX_SAFE_INTEGER 초과(정밀도 손실), 1000 이상이면 "1e+21" 지수표기가 되어
// x402의 digit-string 검증/BigInt() 소비자가 throw. BigInt 십진 문자열 스케일링으로.
export function toAtomicAmount(price: number, decimals: number): string {
  // price는 소수 2자리까지만 허용(shares 입력 검증과 동일) — 그 이상은 반올림.
  const cents = Math.round(price * 100); // safe: price < 1e13
  return (BigInt(cents) * 10n ** BigInt(decimals - 2)).toString();
}

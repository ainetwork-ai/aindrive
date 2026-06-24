// Payment-token presets a drive owner can allow. decimals/EIP-712 fields feed
// x402 requirements. Every token settles through one of x402 v2's two
// asset-transfer methods: eip3009 (transferWithAuthorization — needs the
// token's EIP-712 domain) or permit2 (universal ERC-20 fallback — signature
// domain is the Permit2 contract itself, so no token domain needed).
export type TransferMethod = "eip3009" | "permit2";
export type PaymentToken = {
  symbol: string; chain: string; asset: string;
  // EIP-712 domain of the TOKEN. Required for eip3009 settles; for permit2
  // they only matter to the (future) EIP-2612 gas-sponsoring extension.
  name: string | null; version: string | null; decimals: number;
  transferMethod: TransferMethod;
};

// Single payment-network switch. `mainnet` flips the USDC preset chain+address
// as ONE atomic set so chain and asset can never disagree. Read from a
// NEXT_PUBLIC_ var because BOTH the server (402 verify) and the browser (policy
// editor preset) need it — facilitator/payout stay server-only (NOT public).
// Default testnet, so a missing/typo'd value can never accidentally take real
// money. The chain switch in wagmi-config (browser wallet) reads the same flag.
export type PaymentNetwork = "mainnet" | "testnet";
export function paymentNetwork(): PaymentNetwork {
  return process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

// The chain this deployment's payments live on. A mainnet deployment accepts
// ONLY mainnet-chain tokens — a sepolia token in a mainnet drive would quote
// (and settle!) on sepolia, letting buyers pay worthless testnet coins for
// real content. Testnet deployments stay permissive: dev deliberately
// exercises real mainnet tokens (e.g. FANCO) against a local build.
export function activeChain(): "base" | "base-sepolia" {
  return paymentNetwork() === "mainnet" ? "base" : "base-sepolia";
}

/**
 * Mainnet-deployment chain guard: the first disallowed chain in `tokens`, or
 * null when the policy is fine. Enforced at every boundary a token can enter
 * or leave by — policy PATCH, token lookup, and the 402 quote (which also
 * covers policies stored before this guard existed).
 */
export function policyChainViolation(tokens: Pick<PaymentToken, "chain">[]): string | null {
  if (paymentNetwork() !== "mainnet") return null;
  const bad = tokens.find((t) => t.chain !== "base");
  return bad ? bad.chain : null;
}

// USDC preset per network. Both verified against the live chain (name differs:
// sepolia "USDC" / mainnet "USD Coin" — version 2 on both). EIP-3009 settleable.
const USDC_BY_NETWORK: Record<PaymentNetwork, PaymentToken> = {
  testnet: { symbol: "USDC", chain: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6, transferMethod: "eip3009" },
  mainnet: { symbol: "USDC", chain: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2", decimals: 6, transferMethod: "eip3009" },
};

export const TOKEN_PRESETS: Record<string, PaymentToken> = {
  // EIP-3009 settleable. Chain/address follow the payment-network switch;
  // name/version are the on-chain EIP-712 domain values (hand-verified —
  // wrong values break signature verification).
  USDC: USDC_BY_NETWORK[paymentNetwork()],
  // No EIP-3009 entrypoint → settles via the universal permit2 path. Owners
  // must supply the asset address (the empty asset keeps it out of the preset
  // checkboxes; add by CA lookup instead).
  FANCO: { symbol: "FANCO", chain: "base", asset: "", name: null, version: null, decimals: 18, transferMethod: "permit2" },
};
export const DEFAULT_TOKENS: PaymentToken[] = [TOKEN_PRESETS.USDC];

// Can x402's "exact" scheme settle this token on-chain? eip3009 signs against
// the token's own EIP-712 domain, so it needs name+version+asset; permit2
// signs against the Permit2 contract's domain, so the asset address alone
// suffices. A token failing this can still be listed and exercised under
// DEV_BYPASS, but it can't take real money.
export function isX402Settleable(t: Pick<PaymentToken, "name" | "version" | "asset" | "transferMethod">): boolean {
  if (t.transferMethod === "permit2") return !!t.asset;
  return !!(t.name && t.version && t.asset);
}

// Internal chain names (PaymentToken.chain, receipts.network) stay human
// strings; x402 v2 speaks CAIP-2 on the wire. Convert at the protocol
// boundary only. Throws on unknown chains so a policy bug can't silently
// quote requirements on a network we never meant to settle on.
const CAIP2_BY_CHAIN: Record<string, `${string}:${string}`> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};
export function toCaip2Network(chain: string): `${string}:${string}` {
  const id = CAIP2_BY_CHAIN[chain];
  if (!id) throw new Error(`unknown payment chain: ${chain}`);
  return id;
}

// Stored token rows written before the transferMethod field exist without it
// (undefined) — those are normalized below, so "missing" is valid here.
function isPaymentToken(t: unknown): t is Omit<PaymentToken, "transferMethod"> & { transferMethod?: TransferMethod } {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  return (
    typeof o.symbol === "string" &&
    typeof o.chain === "string" &&
    typeof o.asset === "string" &&
    (o.name === null || typeof o.name === "string") &&
    (o.version === null || typeof o.version === "string") &&
    // decimals >= 2: toAtomicAmount scales from cents (10^(decimals-2)) and
    // BigInt cannot take a negative exponent — a 0/1-decimal token would crash
    // every 402 quote for the share. Real 0-decimal ERC-20s exist; they are
    // rejected at write time (here) and at lookup time instead.
    typeof o.decimals === "number" && Number.isInteger(o.decimals) && o.decimals >= 2 &&
    (o.transferMethod === undefined || o.transferMethod === "eip3009" || o.transferMethod === "permit2")
  );
}

// Legacy rows (no transferMethod): a full EIP-712 domain was exactly the old
// "x402-settleable" rule, so those tokens keep settling via eip3009; anything
// else gains the permit2 path it never had.
function withTransferMethod(t: Omit<PaymentToken, "transferMethod"> & { transferMethod?: TransferMethod }): PaymentToken {
  return { ...t, transferMethod: t.transferMethod ?? (t.name && t.version ? "eip3009" : "permit2") };
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
  return parsed.map(withTransferMethod);
}

// A stored policy keeps the token JSON it was saved with. After a network flip
// that stale chain/asset would make the 402 quote — and possibly SETTLE — on
// the OLD network: a buyer could pay worthless testnet USDC for real mainnet
// content, with no operator signal. So reads rebind any stored token that is a
// KNOWN USDC variant (asset matches one of the verified per-network addresses)
// to the current network's preset. Custom tokens (owner-chosen chain+address)
// are never touched — that chain choice is explicit and theirs.
const KNOWN_USDC_ASSETS = new Set(
  Object.values(USDC_BY_NETWORK).map((t) => t.asset.toLowerCase()),
);
function rebindPresetVariants(tokens: PaymentToken[]): PaymentToken[] {
  return tokens.map((t) =>
    t.symbol === "USDC" && KNOWN_USDC_ASSETS.has(t.asset.toLowerCase())
      ? TOKEN_PRESETS.USDC
      : t,
  );
}

// drives.allowed_tokens (JSON TEXT) → token policy. NULL / empty array /
// unparsable / malformed entries all fall back to DEFAULT_TOKENS so a bad
// policy row can never brick payments (preserves pre-policy behaviour).
export function resolveDriveTokens(allowedTokensJson: string | null): PaymentToken[] {
  if (!allowedTokensJson) return DEFAULT_TOKENS;
  return rebindPresetVariants(parseTokenPolicy(allowedTokensJson) ?? DEFAULT_TOKENS);
}

// [rev2-B] 금액 스케일링은 절대 float 곱셈 금지: 18 decimals에서 price 0.01만 돼도
// Number.MAX_SAFE_INTEGER 초과(정밀도 손실), 1000 이상이면 "1e+21" 지수표기가 되어
// x402의 digit-string 검증/BigInt() 소비자가 throw. BigInt 십진 문자열 스케일링으로.
export function toAtomicAmount(price: number, decimals: number): string {
  // BigInt 음수 지수 불가 — decimals < 2 는 정책 검증(isPaymentToken)과
  // token-lookup 에서 차단되므로 여기 도달하면 검증 누락 버그다.
  if (decimals < 2) throw new Error(`toAtomicAmount: decimals must be >= 2, got ${decimals}`);
  // price는 소수 2자리까지만 허용(shares 입력 검증과 동일) — 그 이상은 반올림.
  const cents = Math.round(price * 100); // safe: price < 1e13
  return (BigInt(cents) * 10n ** BigInt(decimals - 2)).toString();
}

// Pick the currency a paid share settles in, validated against a drive's token
// policy. Pure over the policy's symbol list (first symbol = the default when
// the caller doesn't pick one). Returns null when the requested symbol isn't in
// the policy, so share CREATE and share EDIT reject an off-policy currency
// through one shared gate instead of drifting apart.
export function pickShareCurrency(allowedSymbols: string[], requested?: string | null): string | null {
  const currency = requested ?? allowedSymbols[0];
  return allowedSymbols.includes(currency) ? currency : null;
}

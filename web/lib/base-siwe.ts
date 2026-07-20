/**
 * Base Account `wallet_connect` + `signInWithEthereum` capability helpers.
 *
 * Why this exists: the Base passkey wallet handles every request in a
 * keys.coinbase.com popup, and browsers only allow that popup inside the
 * click's user activation (mobile Safari enforces this absolutely). A
 * connect-then-sign flow therefore needs TWO popups and the second one gets
 * blocked. The `signInWithEthereum` capability folds the SIWE signature into
 * the connect request itself — one popup, opened from the click, does both.
 * Reference: Base docs, base-account/reference/core/capabilities/signInWithEthereum.
 *
 * Pure request/response mapping only — the caller owns the provider call and
 * the POST to /api/wallet/login.
 */

export function walletConnectSiweRequest(nonce: string, chainId: number) {
  return {
    method: "wallet_connect",
    params: [
      {
        version: "1",
        capabilities: {
          signInWithEthereum: { nonce, chainId: `0x${chainId.toString(16)}` },
        },
      },
    ],
  } as const;
}

export interface SiweAuth {
  address: string;
  message: string;
  signature: string;
}

/**
 * Pull { address, message, signature } out of a wallet_connect response —
 * exactly the payload POST /api/wallet/login verifies. Throws on any shape
 * mismatch (e.g. the wallet ignored the capability) so callers surface a
 * real error instead of posting undefined fields.
 */
export function extractSiweAuth(result: unknown): SiweAuth {
  const accounts = (result as { accounts?: unknown } | undefined)?.accounts;
  const first = Array.isArray(accounts) ? (accounts[0] as {
    address?: unknown;
    capabilities?: { signInWithEthereum?: { message?: unknown; signature?: unknown } };
  } | undefined) : undefined;
  const address = first?.address;
  const siwe = first?.capabilities?.signInWithEthereum;
  if (typeof address !== "string" || typeof siwe?.message !== "string" || typeof siwe?.signature !== "string") {
    throw new Error("wallet_connect response missing signInWithEthereum result");
  }
  return { address, message: siwe.message, signature: siwe.signature };
}

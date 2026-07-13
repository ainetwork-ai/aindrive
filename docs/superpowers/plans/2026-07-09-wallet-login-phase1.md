# Wallet-login Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user log into a wallet-provisioned account with a wallet alone (SIWE, no email), verifying smart-wallet (Base Account passkey) signatures server-side, and expose that login inline in the payment funnel so the aindrive email-signup step disappears.

**Architecture:** Login and payment stay separate proofs (spec §2). A new `/api/wallet/login` route verifies a SIWE signature with viem (EOA + ERC-1271 + ERC-6492), resolves the wallet's account, and — gated by a new `login_enabled` flag — mints the real `aindrive_session`. Wallet-provisioned placeholder accounts are login-enabled at mint; wallets linked to real email accounts default to NOT login-enabled (the opt-in UI to flip that is Phase 2). The share-gate renders "Sign in with wallet" inline instead of bouncing to `/login`.

**Tech Stack:** Next.js App Router, TypeScript + plain-ESM JS under `web/lib/`, better-sqlite3, viem `^2.48.4` (`verifySiweMessage`/`createPublicClient`), `siwe` (message construction only), wagmi/RainbowKit (client), vitest.

## Global Constraints

- **Package boundary:** all work inside `web/`; no cross-package imports (web/ ↔ cli/).
- **Test runner:** `cd web && npm test` (`vitest run lib/`); one file: `cd web && npx vitest run lib/__tests__/<f>`; typecheck: `cd web && npm run typecheck` (MUST be clean — a `.ts` import extension or a bad type fails it even when vitest passes).
- **Test DB pattern:** set `process.env.AINDRIVE_DATA_DIR = mkdtempSync(...)` before the first `await import("../db.js")`. Env in tests uses `vi.stubEnv(...)` + `afterEach(() => vi.unstubAllEnvs())` (repo convention, see `payment-network.test.ts`). Dynamic route imports use a `.js` extension (repo convention, see `password-reset-route.test.ts`), never `.ts`.
- **Login ≠ payment:** never mint a session from a payment. Sessions come only from an explicit SIWE login-intent verified against a server-issued single-use nonce.
- **Chain:** SIWE messages already carry `activeChainId()` (8453/84532) from Phase 0. Server signature verification MUST run on the active Base chain (ERC-1271 is chain/state-dependent).
- **Server RPC:** Base RPC URLs are `process.env.AINDRIVE_BASE_RPC ?? "https://mainnet.base.org"` and `process.env.AINDRIVE_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org"` (pattern from `web/app/api/token-lookup/route.ts:27-28`).
- **Provenance gate (security-critical):** a session may be minted for a wallet ONLY when that wallet's `account_wallets.login_enabled = 1`. Placeholder (wallet-provisioned) accounts are login-enabled at mint; all pre-existing / payment-attribution links are `0` and stay blocked in Phase 1.
- **DEV_BYPASS never mints a session** (carried from spec §8) — it does not touch the SIWE login path at all, but any code added near settle must not issue a session under `AINDRIVE_DEV_BYPASS_X402`.

---

## File Structure

- `web/lib/evm.ts` — CREATE. `basePublicClient()`: a viem PublicClient bound to the active Base chain + RPC. Single source of truth for server-side on-chain reads used by auth (mirrors, does not refactor, token-lookup's inline client).
- `web/lib/siwe-verify.ts` — CREATE. `verifyWalletSignature({ message, signature, address, nonce, domain })`: viem `verifySiweMessage` over `basePublicClient()`, returns `Promise<boolean>`. Handles EOA + ERC-1271 + ERC-6492. The one place SIWE signatures are verified.
- `web/lib/wallet.ts` — MODIFY. `resolveAccountForWallet` sets `login_enabled = 1` on the placeholder link it mints. ADD `walletLoginAccount(wallet): { accountId: string; loginEnabled: boolean } | null` (resolve the wallet's linked account + whether login is enabled; null if unknown wallet).
- `web/lib/db.js` — MODIFY. Add `ALTER TABLE account_wallets ADD COLUMN login_enabled INTEGER NOT NULL DEFAULT 0` to the idempotent ALTER loop.
- `web/app/api/wallet/login/route.ts` — CREATE. Verify SIWE → gate on login_enabled → `setCookie(accountId)`.
- `web/app/api/wallet/verify/route.ts` — MODIFY. Swap `siweMsg.verify()` → `verifyWalletSignature` (smart-wallet capable). Behavior otherwise unchanged (still only sets the wallet cookie).
- `web/app/api/wallet/link/route.ts` — MODIFY. Same verifier swap.
- `web/components/use-wallet-session.ts` — CREATE. `useWalletSession()`: SIWE flow that posts `/api/wallet/login` and yields a real session (sibling of `use-wallet-login.ts`, which stays as the wallet-cookie-only proof).
- `web/components/share-gate.tsx` — MODIFY. Replace the `login` state's page bounce with inline "Sign in with wallet"; keep an email link as fallback.
- `web/app/login/page.tsx` — MODIFY. Add a "Sign in with wallet" affordance (for free-share consume by wallet-only users).
- Tests: `web/lib/__tests__/siwe-verify.test.ts` (CREATE), `web/lib/__tests__/wallet-login-gate.test.ts` (CREATE), extend `wallet-link.test.ts`.

---

## Task 1: Server EVM client + viem SIWE verifier

**Files:**
- Create: `web/lib/evm.ts`, `web/lib/siwe-verify.ts`
- Test: `web/lib/__tests__/siwe-verify.test.ts`

**Interfaces:**
- Produces: `basePublicClient(): PublicClient` (web/lib/evm.ts) — viem client for `activeChain()` with the RPC env fallback. `verifyWalletSignature(args: { message: string; signature: string; address: string; nonce: string; domain: string }): Promise<boolean>` (web/lib/siwe-verify.ts).
- Consumes: `activeChain()`/`activeChainId()` from `web/lib/payment-tokens.ts` (Phase 0); viem `createPublicClient`, `http`, `verifySiweMessage` (from `viem/siwe`).

**Why:** `siwe@3`'s `verify()` without a chain provider is EOA-only and lacks ERC-6492, so a Base Account passkey login (the front-line connector) fails. viem's `verifySiweMessage` delegates to `verifyHash`, which resolves EOA + ERC-1271 + ERC-6492 through a public client — Base's documented recipe.

**Testing note:** a real ERC-6492/1271 smart-wallet signature can't be fixtured in a unit test without a live Base Account or a mocked RPC. This task unit-tests the EOA path (a signature generated with viem `privateKeyToAccount`) plus the rejection cases (wrong domain, wrong nonce, tampered signature). The smart-wallet path is covered by (a) asserting `verifyWalletSignature` passes `address/message/signature` through to viem unchanged, and (b) manual E2E in Task 6 with a real Base Account. Do not fake a 6492 signature.

- [ ] **Step 1: Write the failing test**

Create `web/lib/__tests__/siwe-verify.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";

vi.stubEnv("NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK", "testnet");
afterEach(() => vi.unstubAllEnvs());

const { verifyWalletSignature } = await import("../siwe-verify.js");

const DOMAIN = "drive.example.test";
const NONCE = "abcd1234efgh";
// Deterministic test EOA (well-known throwaway key; never used for value).
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

async function buildSigned(over: Partial<{ domain: string; nonce: string }> = {}) {
  const message = new SiweMessage({
    domain: over.domain ?? DOMAIN,
    address: account.address,
    statement: "aindrive wants you to sign in with your wallet.",
    uri: `https://${DOMAIN}`,
    version: "1",
    chainId: 84532,
    nonce: over.nonce ?? NONCE,
  }).prepareMessage();
  const signature = await account.signMessage({ message });
  return { message, signature };
}

describe("verifyWalletSignature (EOA path)", () => {
  it("accepts a valid EOA SIWE signature for the expected domain+nonce", async () => {
    const { message, signature } = await buildSigned();
    const ok = await verifyWalletSignature({
      message, signature, address: account.address, nonce: NONCE, domain: DOMAIN,
    });
    expect(ok).toBe(true);
  });

  it("rejects a signature whose domain does not match the expected domain", async () => {
    const { message, signature } = await buildSigned({ domain: "evil.example" });
    const ok = await verifyWalletSignature({
      message, signature, address: account.address, nonce: NONCE, domain: DOMAIN,
    });
    expect(ok).toBe(false);
  });

  it("rejects when the expected nonce differs from the message nonce", async () => {
    const { message, signature } = await buildSigned();
    const ok = await verifyWalletSignature({
      message, signature, address: account.address, nonce: "wrongnonce99", domain: DOMAIN,
    });
    expect(ok).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const { message } = await buildSigned();
    const ok = await verifyWalletSignature({
      message, signature: "0xdeadbeef", address: account.address, nonce: NONCE, domain: DOMAIN,
    });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run lib/__tests__/siwe-verify.test.ts`
Expected: FAIL — `../siwe-verify.js` does not exist (import error).

- [ ] **Step 3: Create `web/lib/evm.ts`**

```ts
import { createPublicClient, http, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { activeChain } from "./payment-tokens";

// Server-side read-only client for the deployment's active Base chain. Mirrors
// the inline client in app/api/token-lookup/route.ts (kept separate; auth must
// not depend on the token-policy editor). RPC URL falls back to the public
// Base endpoint when the env override is unset.
const CHAINS = {
  base: { chain: base, rpc: process.env.AINDRIVE_BASE_RPC ?? "https://mainnet.base.org" },
  "base-sepolia": { chain: baseSepolia, rpc: process.env.AINDRIVE_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org" },
} as const;

export function basePublicClient(): PublicClient {
  const { chain, rpc } = CHAINS[activeChain()];
  return createPublicClient({ chain, transport: http(rpc) });
}
```

- [ ] **Step 4: Create `web/lib/siwe-verify.ts`**

```ts
import { verifySiweMessage } from "viem/siwe";
import { basePublicClient } from "./evm";

/**
 * Verify a SIWE (EIP-4361) login signature against the active Base chain.
 *
 * viem's verifySiweMessage delegates signature checking to verifyHash, which
 * resolves EOA (ecrecover), deployed smart wallets (ERC-1271), and
 * counterfactual/undeployed accounts (ERC-6492) through the public client — so
 * Base Account passkey wallets verify without per-type branching. It also
 * re-checks the message's domain / nonce / address against the expected values
 * (defense in depth on top of the route's manual checks + single-use nonce).
 */
export async function verifyWalletSignature(args: {
  message: string;
  signature: string;
  address: string;
  nonce: string;
  domain: string;
}): Promise<boolean> {
  try {
    return await verifySiweMessage(basePublicClient(), {
      message: args.message,
      signature: args.signature as `0x${string}`,
      address: args.address as `0x${string}`,
      nonce: args.nonce,
      domain: args.domain,
    });
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run lib/__tests__/siwe-verify.test.ts`
Expected: PASS (4/4). If `verifySiweMessage`'s argument shape differs in the installed viem version, check `node_modules/viem/siwe` types and adapt the call — the contract (message/signature/address/nonce/domain → boolean over a public client) is what matters.

- [ ] **Step 6: Typecheck + commit**

Run: `cd web && npm run typecheck` (expect clean).
```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git add web/lib/evm.ts web/lib/siwe-verify.ts web/lib/__tests__/siwe-verify.test.ts
git commit -m "feat(auth): viem SIWE verifier (EOA + ERC-1271 + ERC-6492)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `login_enabled` column + provenance-aware resolution

**Files:**
- Modify: `web/lib/db.js` (ALTER loop), `web/lib/wallet.ts` (mint sets login_enabled; add `walletLoginAccount`)
- Test: `web/lib/__tests__/wallet-link.test.ts` (extend)

**Interfaces:**
- Produces: `walletLoginAccount(wallet: string): { accountId: string; loginEnabled: boolean } | null` (wallet.ts). Returns null for an unknown wallet; otherwise the linked account id + whether login is enabled.
- Consumes: `db` from `../db.js`.

**Why:** `verified_via` records HOW ownership was proven, not WHETHER the owner consented to wallet-login. A user who linked a wallet for payment attribution (verified_via='siwe') never consented to it becoming a login credential. A dedicated `login_enabled` flag, defaulting 0, is the machine-checkable consent signal. Placeholder (wallet-provisioned) accounts are the wallet's own identity, so their mint sets it 1.

- [ ] **Step 1: Write the failing tests** (append to `web/lib/__tests__/wallet-link.test.ts`)

```ts
describe("login_enabled provenance", () => {
  const NEWW = "0xD00d000000000000000000000000000000000011";

  it("a freshly minted placeholder account is login-enabled", () => {
    const id = resolveAccountForWallet(NEWW);
    const acct = walletLoginAccount(NEWW);
    expect(acct).toEqual({ accountId: id, loginEnabled: true });
  });

  it("returns null for an unknown wallet", () => {
    expect(walletLoginAccount("0x0000000000000000000000000000000000009999")).toBeNull();
  });

  it("a wallet linked to a real account is NOT login-enabled by default", () => {
    // u1 is a real (email) account seeded in the top-level beforeAll.
    const realWallet = "0xEeee000000000000000000000000000000000012";
    linkWalletToAccount("u1", realWallet, "siwe"); // authenticated link → verified_via siwe, login_enabled default 0
    expect(walletLoginAccount(realWallet)).toEqual({ accountId: "u1", loginEnabled: false });
  });
});
```

Add `walletLoginAccount` to the destructured imports at the top of the test file:
`const { linkWalletToAccount, WalletAlreadyLinkedError, resolveAccountForWallet, walletLoginAccount } = await import("../wallet.js");` (merge with the existing import lines; keep whatever is already imported).

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run lib/__tests__/wallet-link.test.ts -t "login_enabled"`
Expected: FAIL — `walletLoginAccount` is not exported / `login_enabled` column missing.

- [ ] **Step 3: Add the column (web/lib/db.js)**

In the idempotent ALTER loop (the array of `ALTER TABLE ...` strings, ~db.js:167-176), add:

```js
    "ALTER TABLE account_wallets ADD COLUMN login_enabled INTEGER NOT NULL DEFAULT 0",
```

- [ ] **Step 4: Mint sets login_enabled=1; add `walletLoginAccount` (web/lib/wallet.ts)**

In `resolveAccountForWallet`, the placeholder `account_wallets` INSERT currently is:
```ts
    db.prepare(
      "INSERT INTO account_wallets (id, account_id, wallet_address, verified_via) VALUES (?, ?, ?, ?)"
    ).run(nanoid(12), id, addr, "payment");
```
Change it to set `login_enabled = 1` (the wallet IS this account's identity):
```ts
    db.prepare(
      "INSERT INTO account_wallets (id, account_id, wallet_address, verified_via, login_enabled) VALUES (?, ?, ?, ?, 1)"
    ).run(nanoid(12), id, addr, "payment");
```

Add the resolver (near `resolveAccountForWallet`):
```ts
/**
 * Resolve a wallet's linked account for LOGIN, with the consent gate.
 * loginEnabled reflects account_wallets.login_enabled: 1 for wallet-provisioned
 * placeholders (the wallet is the account) and for links a user explicitly
 * enabled login on; 0 for payment-attribution links (blocked from minting a
 * session). Returns null for an unknown wallet.
 */
export function walletLoginAccount(wallet: string): { accountId: string; loginEnabled: boolean } | null {
  const row = db
    .prepare("SELECT account_id, login_enabled FROM account_wallets WHERE wallet_address = ?")
    .get(wallet.toLowerCase()) as { account_id: string; login_enabled: number } | undefined;
  if (!row) return null;
  return { accountId: row.account_id, loginEnabled: row.login_enabled === 1 };
}
```

- [ ] **Step 5: Run tests green**

Run: `cd web && npx vitest run lib/__tests__/wallet-link.test.ts`
Expected: PASS (existing + 3 new). If the shared temp DB already has an `account_wallets` table from a prior run without the column, the idempotent ALTER adds it at open; a fresh `AINDRIVE_DATA_DIR` per test file guarantees the new schema.

- [ ] **Step 6: Typecheck + commit**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
cd web && npm run typecheck && cd ..
git add web/lib/db.js web/lib/wallet.ts web/lib/__tests__/wallet-link.test.ts
git commit -m "feat(auth): login_enabled gate on account_wallets

Placeholder mints are login-enabled; payment-attribution links default off.
walletLoginAccount() exposes the consent gate for the login route.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `/api/wallet/login` route (SIWE → session)

**Files:**
- Create: `web/app/api/wallet/login/route.ts`
- Test: `web/lib/__tests__/wallet-login-gate.test.ts`

**Interfaces:**
- Consumes: `consumeNonce`, `resolveAccountForWallet`, `walletLoginAccount` from `@/lib/wallet`; `verifyWalletSignature` from `@/lib/siwe-verify`; `setCookie` from `@/lib/session`; `tryConsume`, `clientKey` from `@/lib/rate-limit`; `env` from `@/lib/env`; `SiweMessage` from `siwe`; `isAddress` from `viem`.
- Produces: `POST` → 200 `{ ok: true, address }` with an `aindrive_session` cookie set, or 400/401/403/429.

**Why:** This is the wallet-only login. It mirrors `/api/wallet/verify` (nonce + domain + SIWE) but resolves an account and mints the real session — gated by the provenance flag so it can only log into a login-enabled account.

**Contract (mirror the structure of `web/app/api/wallet/verify/route.ts` exactly):**
1. Rate-limit (`name: "wallet-login"`, limit 10, window 60_000).
2. Parse body `{ address, signature, nonce, message }` with the same Zod schema shape as verify.
3. Derive client IP the same way; `consumeNonce(ip, nonce)` → 400 on miss.
4. Parse `new SiweMessage(message)`; check `siweMsg.nonce === nonce` (400) and `siweMsg.address.toLowerCase() === address.toLowerCase()` (400).
5. `verifyWalletSignature({ message, signature, address, nonce, domain: EXPECTED_DOMAIN })` → 401 on false. `EXPECTED_DOMAIN = new URL(env.publicUrl).host` (as in link route).
6. **Gate:** `const existing = walletLoginAccount(address);` — if `existing && !existing.loginEnabled` → 403 `{ error: "wallet_login_not_enabled" }` (a real account the owner hasn't opted into wallet-login on). Otherwise `const accountId = existing?.accountId ?? resolveAccountForWallet(address)` (unknown wallet → mint a login-enabled placeholder).
7. `await setCookie(accountId);` return 200 `{ ok: true, address: address.toLowerCase() }`.

- [ ] **Step 1: Write the failing test** — test the gate/branch logic with the verifier and cookie mocked (the SIWE crypto is Task 1's concern; here we test routing).

Create `web/lib/__tests__/wallet-login-gate.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-walletlogin-"));
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";

// Always-valid signature + no real nonce store: isolate the route's account/gate logic.
vi.mock("@/lib/siwe-verify", () => ({ verifyWalletSignature: vi.fn(async () => true) }));
const setCookie = vi.fn(async () => {});
vi.mock("@/lib/session", () => ({ setCookie }));
vi.mock("@/lib/rate-limit", () => ({ tryConsume: () => ({ ok: true }), clientKey: () => "k" }));

const { db } = await import("../db.js");
const wallet = await import("../wallet.js");
// Seed a real email account with a NON-login-enabled linked wallet.
const BLOCKED = "0xB10c000000000000000000000000000000000013";
db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("e1", "e1@x.com", "E1", "h");
wallet.linkWalletToAccount("e1", BLOCKED, "siwe"); // login_enabled defaults 0

// Stub the nonce so consumeNonce succeeds for our message.
vi.spyOn(wallet, "consumeNonce").mockReturnValue(true);

const { POST } = await import("../../app/api/wallet/login/route.js");

function req(address: string) {
  const nonce = "noncenonce12";
  const message = new (require("siwe").SiweMessage)({
    domain: "drive.example.test", address, statement: "x",
    uri: "https://drive.example.test", version: "1", chainId: 84532, nonce,
  }).prepareMessage();
  return new Request("https://drive.example.test/api/wallet/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature: "0xsig", nonce, message }),
  });
}

describe("POST /api/wallet/login gate", () => {
  beforeEach(() => setCookie.mockClear());

  it("mints a session for an unknown wallet (new placeholder)", async () => {
    const res = await POST(req("0xNeW0000000000000000000000000000000000014"));
    expect(res.status).toBe(200);
    expect(setCookie).toHaveBeenCalledOnce();
  });

  it("refuses (403) to log into a real account whose wallet is not login-enabled", async () => {
    const res = await POST(req(BLOCKED));
    expect(res.status).toBe(403);
    expect(setCookie).not.toHaveBeenCalled();
  });
});
```

> Note: if `vi.spyOn(wallet, "consumeNonce")` can't intercept an ESM named export in this setup, instead issue a real nonce: import `issueNonce`, call it with the same derived IP the route uses, and put that nonce in the message — whichever the repo's other route tests do. Confirm the RED failure is "route module not found", not a mock-wiring error.

- [ ] **Step 2: Run to verify it fails** — `cd web && npx vitest run lib/__tests__/wallet-login-gate.test.ts` → FAIL (route missing).

- [ ] **Step 3: Create the route** (`web/app/api/wallet/login/route.ts`) — implement the 7-step contract above, structurally mirroring `web/app/api/wallet/verify/route.ts` (read that file first and copy its rate-limit/IP/nonce/SIWE-parse scaffolding verbatim, changing only steps 5–7):

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";
import { SiweMessage } from "siwe";
import { consumeNonce, resolveAccountForWallet, walletLoginAccount } from "@/lib/wallet";
import { verifyWalletSignature } from "@/lib/siwe-verify";
import { setCookie } from "@/lib/session";
import { tryConsume, clientKey } from "@/lib/rate-limit";
import { env } from "@/lib/env";

const EXPECTED_DOMAIN = new URL(env.publicUrl).host;
const Body = z.object({
  address: z.string().refine((v) => isAddress(v), "invalid address"),
  signature: z.string().min(2),
  nonce: z.string().min(8),
  message: z.string().min(10),
});

export async function POST(req: Request) {
  const rl = tryConsume({ name: "wallet-login", key: clientKey(req, "wallet-login"), limit: 10, windowMs: 60_000 });
  if (!rl.ok) {
    const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
  }
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const { address, signature, nonce, message } = body.data;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || req.headers.get("x-real-ip") || "anon";
  if (!consumeNonce(ip, nonce)) {
    return NextResponse.json({ error: "unknown or expired nonce" }, { status: 400 });
  }

  let siweMsg: SiweMessage;
  try { siweMsg = new SiweMessage(message); } catch { return NextResponse.json({ error: "bad message" }, { status: 400 }); }
  if (siweMsg.nonce !== nonce) return NextResponse.json({ error: "nonce mismatch" }, { status: 400 });
  if (siweMsg.address.toLowerCase() !== address.toLowerCase()) {
    return NextResponse.json({ error: "address mismatch" }, { status: 400 });
  }

  const ok = await verifyWalletSignature({ message, signature, address, nonce, domain: EXPECTED_DOMAIN });
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });

  // Provenance gate: a wallet linked to a real account that hasn't opted into
  // wallet-login must NOT mint a session (payment attribution != login consent).
  const existing = walletLoginAccount(address);
  if (existing && !existing.loginEnabled) {
    return NextResponse.json({ error: "wallet_login_not_enabled" }, { status: 403 });
  }
  const accountId = existing?.accountId ?? resolveAccountForWallet(address);

  await setCookie(accountId);
  return NextResponse.json({ ok: true, address: address.toLowerCase() });
}
```

- [ ] **Step 4: Run tests green** — `cd web && npx vitest run lib/__tests__/wallet-login-gate.test.ts` → PASS (2/2).

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
cd web && npm run typecheck && cd ..
git add web/app/api/wallet/login/route.ts web/lib/__tests__/wallet-login-gate.test.ts
git commit -m "feat(auth): POST /api/wallet/login — SIWE to session, provenance-gated

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Route the existing verify + link through the viem verifier

**Files:**
- Modify: `web/app/api/wallet/verify/route.ts`, `web/app/api/wallet/link/route.ts`
- Test: existing `wallet-link.test.ts` must stay green (it tests DB logic, not the HTTP verify path); no new test unless a route test exists.

**Interfaces:** Consumes `verifyWalletSignature` from `@/lib/siwe-verify`.

**Why:** These two routes still call `siweMsg.verify({ signature, ... })` (EOA-only), so Base Account users can't link or re-prove wallet ownership. Route both through the smart-wallet-capable verifier for consistency with the new login route.

- [ ] **Step 1: Update `web/app/api/wallet/verify/route.ts`**

Replace the `siweMsg.verify(...)` block (the `const result = await siweMsg.verify({ signature }); ok = result.success;` section) with:
```ts
    ok = await verifyWalletSignature({ message, signature, address, nonce, domain: EXPECTED_DOMAIN });
```
Add `import { verifyWalletSignature } from "@/lib/siwe-verify";`. If the verify route lacks an `EXPECTED_DOMAIN`, add `const EXPECTED_DOMAIN = new URL(env.publicUrl).host;` (it already imports `env`? if not, import it). Keep the manual nonce/address checks that precede it.

- [ ] **Step 2: Update `web/app/api/wallet/link/route.ts`**

It already has `EXPECTED_DOMAIN` (`link/route.ts:13`). Replace the `const result = await siweMsg.verify({ signature, domain: EXPECTED_DOMAIN, nonce }); ok = result.success;` with:
```ts
    ok = await verifyWalletSignature({ message, signature, address, nonce, domain: EXPECTED_DOMAIN });
```
Add the import. Leave the rest (nonce consume, address checks, `linkWalletToAccount`) unchanged.

- [ ] **Step 3: Typecheck + full suite**

Run: `cd web && npm run typecheck` (clean) and `cd web && npm test` (all green — the existing wallet-link DB tests and everything else).

- [ ] **Step 4: Commit**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git add web/app/api/wallet/verify/route.ts web/app/api/wallet/link/route.ts
git commit -m "refactor(auth): verify + link use the viem smart-wallet SIWE verifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Inline SIWE in the funnel + `/login`

**Files:**
- Create: `web/components/use-wallet-session.ts`
- Modify: `web/components/share-gate.tsx`, `web/app/login/page.tsx`
- Test: manual E2E (Task 6); these are client components without a unit harness. Keep changes minimal and typechecked.

**Interfaces:**
- Produces: `useWalletSession(): { login: () => Promise<boolean>; busy: boolean; error: string | null; isConnected: boolean; address?: string }` — SIWE flow posting `/api/wallet/login`, mirroring `use-wallet-login.ts` but hitting the login endpoint (session) instead of `/api/wallet/verify` (wallet cookie).

**Why:** The funnel win leaks unless login happens inline. The share-gate currently `router.push('/login')` (email-only) on the `login` state; replace with an inline wallet sign-in that reuses the already-connected wallet and one passkey prompt.

- [ ] **Step 1: Create `web/components/use-wallet-session.ts`** — copy `web/components/use-wallet-login.ts` verbatim, then change the final POST target from `/api/wallet/verify` to `/api/wallet/login`, and rename the hook to `useWalletSession`. (The nonce fetch, SiweMessage build with `CHAIN_ID`, and `signMessageAsync` are identical.)

- [ ] **Step 2: Wire it into `share-gate.tsx`'s `login` state**

In the `state === "login"` block (`share-gate.tsx:459-487`), replace the single "Sign in to continue" button (which does `router.push('/login?next=...')`) with a wallet-first affordance:
- A `<ConnectButton />` (already imported) when not connected.
- When connected, a "Sign in with wallet" button that calls `useWalletSession().login()`; on `true`, call `check()` again (re-runs the gate → now `me.user` exists → paywall).
- Keep a secondary text link "Use email instead" → the existing `router.push('/login?next=/s/${token}')`.

Add `const { login: walletLogin, busy: walletBusy } = useWalletSession();` near the other hooks (import from `@/components/use-wallet-session`). The handler:
```ts
async function signInWithWallet() {
  const ok = await walletLogin();
  if (ok) await check(); // re-run: session now exists → paywall state
}
```
Do not remove the email fallback; render it below the wallet button.

- [ ] **Step 3: Add a wallet button to `web/app/login/page.tsx`**

Below the email form, add a divider and a "Sign in with wallet" button using `useWalletSession()`; on success `router.push(safeNext)`. This lets wallet-only users consume free shares (which route through `/login`). Keep the email form as the primary for existing users.

- [ ] **Step 4: Typecheck + build sanity**

Run: `cd web && npm run typecheck` (clean). Run: `cd web && npm test` (unchanged suites still green — no lib logic changed).

- [ ] **Step 5: Commit**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git add web/components/use-wallet-session.ts web/components/share-gate.tsx web/app/login/page.tsx
git commit -m "feat(auth): inline wallet sign-in in the share-gate + /login

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: E2E verification, docs, PR

**Files:** `docs/PERMISSIONS.md`, `CLAUDE.md` (principle amendment); verification only otherwise.

- [ ] **Step 1: Amend the identity principle** — update `CLAUDE.md:18` and `docs/PERMISSIONS.md` Identity note per spec §6 (wallet-provisioned accounts are self-custodial; a wallet linked to a real email account is a login credential only after explicit opt-in; payment is not authentication). Keep `docs/PERMISSIONS.md` canonical; `CLAUDE.md` points at it. Commit.

- [ ] **Step 2: Full regression** — `cd web && npm test` (all green) and `cd web && npm run typecheck` (clean). Record counts.

- [ ] **Step 3: Manual E2E (the part unit tests can't cover)** — run the app; with a Base Account passkey wallet: (a) hit a paid share while logged out → the gate shows inline "Sign in with wallet" → sign → land on the paywall → pay → enter the drive, with NO email signup; (b) log out → confirm both cookies cleared; (c) confirm a wallet linked to a real email account (login_enabled=0) is refused at `/api/wallet/login` with 403. Document results in the PR.

- [ ] **Step 4: Push + draft PR**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git push -u origin wallet-login-phase1
gh pr create --draft --base main --title "Wallet-login Phase 1: SIWE wallet-only login (viem smart-wallet verify, provenance gate)" --body "<summarize tasks; note manual-E2E results; carry forward: Phase 2 opt-in UI to enable wallet-login on email accounts, wallet-only account UI de-leak, opt-in email upgrade>"
```

---

## Self-Review

**1. Spec coverage (spec §4 Phase 1):** viem ERC-6492/1271 verify → Task 1; verify→session endpoint → Task 3; provenance gate → Task 2 (flag) + Task 3 (enforcement); inline SIWE + /login → Task 5; link/verify rebuilt → Task 4; principle amendment → Task 6. The "remove pre-payment login gate" is realized by Task 5 replacing the `login`-state bounce with inline sign-in (the gate still establishes identity before payment — now via wallet, not email — preserving the spec §2 "identity before payment" invariant). ✅

**2. Placeholder scan:** every code step shows full code or a precise edit against a named file:line; test code is complete; the one genuinely un-fixturable path (ERC-6492) is called out with an explicit testing strategy rather than a fake. ✅

**3. Type consistency:** `verifyWalletSignature(args) → Promise<boolean>` (Task 1) consumed unchanged in Tasks 3–4. `walletLoginAccount(wallet) → { accountId, loginEnabled } | null` (Task 2) consumed in Task 3. `basePublicClient()` (Task 1) consumed in Task 1's verifier only. `useWalletSession()` shape (Task 5) matches `use-wallet-login.ts`'s. ✅

**Deferred to Phase 2 (not this plan):** the opt-in UI/endpoint to set `login_enabled=1` on a real email account's linked wallet; wallet-only-account UI de-leak (roster/whoami synthetic email); "lose the wallet, lose the account" legibility badge; opt-in email upgrade for wallet-only accounts.

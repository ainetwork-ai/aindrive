# Wallet-login Phase 0 — Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three latent defects in the current code that the wallet-login design surfaced — a non-transactional account mint (a money-taken-no-access CRITICAL), logout not clearing the wallet cookie, and a hardcoded SIWE chainId — none of which depend on shipping wallet login.

**Architecture:** Three independent fixes in `web/lib/`, each test-first with vitest. They share no code and can be reviewed separately, but ship as one PR because they are all "pre-work hardening" for wallet login. No API surface changes except logout's cookie-clearing side effect.

**Tech Stack:** Next.js (App Router), TypeScript + plain-ESM JS mix under `web/lib/`, better-sqlite3 (synchronous, single-process), vitest, `siwe` (message construction only), `bcryptjs`, `nanoid`.

## Global Constraints

- **Package boundary:** all work is inside `web/`. Never import across package roots (`web/` ↔ `cli/`). (CLAUDE.md package layout)
- **Test runner:** `cd web && npm test` runs `vitest run lib/`. A single file: `cd web && npx vitest run lib/__tests__/<file>` .
- **Test DB pattern:** set `process.env.AINDRIVE_DATA_DIR = mkdtempSync(...)` **before** the first `await import("../db.js")` — `db.js` opens the DB at module load. Use dynamic `await import(...)`, never a top-level static import of `db`/`wallet`.
- **DB is synchronous & single-process** (better-sqlite3). `db.transaction(fn)` returns a wrapped function; calling it runs `fn` in a SQLite transaction (auto BEGIN/COMMIT, ROLLBACK on throw).
- **Wallet addresses are stored lowercased** everywhere (`account_wallets.wallet_address`, `payment_receipts.wallet`, `paid_lifts.wallet`).
- **Chain numeric ids:** Base mainnet `8453`, Base Sepolia `84532`. The deployment's active chain comes from `activeChain()` in `web/lib/payment-tokens.ts` (`"base"` | `"base-sepolia"`).

---

## File Structure

- `web/lib/wallet.ts` — MODIFY `resolveAccountForWallet` (transactional + self-healing); MODIFY `challengeMessage` (chainId). Also gains no new exports.
- `web/lib/payment-tokens.ts` — ADD `activeChainId(): 8453 | 84532` helper (single source of truth for the numeric SIWE chainId; consumed by `wallet.ts` and the client hook mirror).
- `web/components/use-wallet-login.ts` — MODIFY the client SIWE message chainId (mirror of the server value; client can't import server env, so it reads `NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK` directly — same switch `paymentNetwork()` uses).
- `web/app/api/auth/logout/route.ts` — MODIFY to also clear the wallet cookie.
- `web/lib/tier.ts` — no change in Phase 0 (single-tier-authority refactor is deferred to Phase 1 where the session becomes wallet-aware; Phase 0 only stops logout from leaving a stale wallet cookie). See Task 3 note.
- Tests:
  - `web/lib/__tests__/wallet-link.test.ts` — EXTEND (self-heal + atomicity cases live next to the existing `resolveAccountForWallet` tests).
  - `web/lib/__tests__/siwe-chainid.test.ts` — CREATE (chainId of the built SIWE message).
  - `web/lib/__tests__/logout-cookies.test.ts` — CREATE (logout clears both cookies).

---

## Task 1: Transactional + self-healing account mint

**Files:**
- Modify: `web/lib/wallet.ts:146-164` (`resolveAccountForWallet`)
- Test: `web/lib/__tests__/wallet-link.test.ts` (extend)

**Interfaces:**
- Consumes: `db` from `../db.js`; `nanoid`, `bcrypt` already imported in `wallet.ts`.
- Produces: `resolveAccountForWallet(wallet: string): string` — unchanged signature, unchanged return (`never null`). New guarantee: the `users` + `account_wallets` INSERTs are one atomic transaction, and a pre-existing `users` row on the synthetic email (an orphan from a past crash) is **healed** by linking `account_wallets` to it instead of throwing on email-UNIQUE.

**Why:** The two INSERTs (`wallet.ts:157-159`, `160-162`) are not wrapped in a transaction. A crash between them orphans a `users` row on the deterministic synthetic email `<addr>@wallet.aindrive.local`; every later call then re-attempts the `users` INSERT and throws `UNIQUE constraint failed: users.email`, which the settle path swallows (`s/[token]/route.ts:320`) → that wallet is permanently locked out of access it paid for. Atomicity prevents new orphans; self-heal recovers any that already exist.

- [ ] **Step 1: Write the failing tests**

Add to the end of `web/lib/__tests__/wallet-link.test.ts` (inside the file, after the existing `describe("resolveAccountForWallet", …)` block — reuse the same imported `db`, `resolveAccountForWallet`):

```ts
describe("resolveAccountForWallet atomicity + self-heal", () => {
  const SYNTH_WALLET = "0xCafE000000000000000000000000000000000009";
  const addr = SYNTH_WALLET.toLowerCase();

  it("heals an orphan users row (synthetic email exists, no account_wallets link)", () => {
    // Simulate a crash-orphaned users row: minted with the deterministic
    // synthetic email but NO account_wallets link written.
    const orphanId = "w_orphan01";
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)")
      .run(orphanId, `${addr}@wallet.aindrive.local`, `wallet:${addr.slice(0, 10)}`, "x");

    // Must NOT throw on email-UNIQUE; must adopt the orphan and link it.
    const id = resolveAccountForWallet(SYNTH_WALLET);
    expect(id).toBe(orphanId);

    const link = db.prepare(
      "SELECT account_id, verified_via FROM account_wallets WHERE wallet_address = ?"
    ).get(addr) as { account_id: string; verified_via: string };
    expect(link.account_id).toBe(orphanId);
    expect(link.verified_via).toBe("payment");
  });

  it("is atomic: a fresh mint writes BOTH the users row and the link, or neither", () => {
    const fresh = "0xBeeF000000000000000000000000000000000010";
    const id = resolveAccountForWallet(fresh);
    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
    const link = db.prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
      .get(fresh.toLowerCase()) as { account_id: string } | undefined;
    expect(user).toBeTruthy();
    expect(link?.account_id).toBe(id);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run lib/__tests__/wallet-link.test.ts -t "atomicity"`
Expected: FAIL — the self-heal test throws `UNIQUE constraint failed: users.email` (current code re-INSERTs on the orphan email instead of adopting it).

- [ ] **Step 3: Rewrite `resolveAccountForWallet` to be transactional + self-healing**

Replace the body of `resolveAccountForWallet` (`web/lib/wallet.ts:146-164`) with:

```ts
export function resolveAccountForWallet(wallet: string): string {
  const addr = wallet.toLowerCase();
  const linked = db
    .prepare("SELECT account_id FROM account_wallets WHERE wallet_address = ?")
    .get(addr) as { account_id: string } | undefined;
  if (linked) return linked.account_id;

  const synthEmail = `${addr}@wallet.aindrive.local`;
  // Atomic: either both the users row and its link land, or neither.
  // Self-healing: a crash between the two INSERTs (pre-fix) could orphan a
  // users row on the deterministic synthetic email. Adopt that row instead of
  // re-INSERTing and throwing email-UNIQUE — otherwise the wallet is locked
  // out forever (every settle re-throws, swallowed at s/[token]/route.ts).
  const mint = db.transaction(() => {
    const orphan = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(synthEmail) as { id: string } | undefined;
    const id = orphan?.id ?? "w_" + nanoid(10);
    if (!orphan) {
      // Random input → the hash can never be reproduced by a login attempt.
      const placeholderHash = bcrypt.hashSync(nanoid(24), 10);
      db.prepare(
        "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)"
      ).run(id, synthEmail, `wallet:${addr.slice(0, 10)}`, placeholderHash);
    }
    db.prepare(
      "INSERT INTO account_wallets (id, account_id, wallet_address, verified_via) VALUES (?, ?, ?, ?)"
    ).run(nanoid(12), id, addr, "payment");
    return id;
  });
  return mint();
}
```

Keep the existing docstring (`wallet.ts:131-145`) but update its "future-phase concern" sentence to note the mint is now transactional and self-healing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run lib/__tests__/wallet-link.test.ts`
Expected: PASS — all existing `resolveAccountForWallet` tests plus the two new ones.

- [ ] **Step 5: Commit**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git add web/lib/wallet.ts web/lib/__tests__/wallet-link.test.ts
git commit -m "fix(wallet): make resolveAccountForWallet transactional + self-healing

Wrap the users + account_wallets INSERTs in db.transaction() so a crash
can't orphan a users row on the deterministic synthetic email; adopt any
existing orphan instead of throwing email-UNIQUE (which the settle path
swallows, permanently locking the wallet out of paid access).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: SIWE chainId → active Base chain

**Files:**
- Modify: `web/lib/payment-tokens.ts` (add `activeChainId`)
- Modify: `web/lib/wallet.ts` (`challengeMessage`, ~line 88 `chainId: 1`)
- Modify: `web/components/use-wallet-login.ts:42` (`chainId: 1`)
- Test: `web/lib/__tests__/siwe-chainid.test.ts` (create)

**Interfaces:**
- Produces: `activeChainId(): 8453 | 84532` exported from `web/lib/payment-tokens.ts` — the numeric SIWE/EVM chain id for this deployment, derived from the same `paymentNetwork()` switch as `activeChain()`.
- Consumes (Task uses): `paymentNetwork()` already in `payment-tokens.ts`.

**Why:** The SIWE message hardcodes `chainId: 1` (Ethereum mainnet) in two places, but this app's wallets live on Base (8453 / 84532). A Base Account signs SIWE for the chain in the message; a chainId mismatch makes server-side smart-wallet verification (Phase 1) resolve the wrong chain's contract state. Fixing the emitted chainId now keeps Phase 0 self-contained and unblocks Phase 1's verifier.

- [ ] **Step 1: Write the failing test**

Create `web/lib/__tests__/siwe-chainid.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SiweMessage } from "siwe";

// challengeMessage needs env.publicUrl; set a deterministic one before import.
process.env.AINDRIVE_PUBLIC_URL = "https://drive.example.test";
process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK = "testnet";

const { challengeMessage } = await import("../wallet.js");
const { activeChainId } = await import("../payment-tokens.js");

describe("SIWE challenge chainId", () => {
  it("activeChainId is Base Sepolia on testnet, Base mainnet on mainnet", () => {
    expect(activeChainId()).toBe(84532);
  });

  it("challengeMessage emits the active Base chainId, not Ethereum mainnet (1)", () => {
    const msg = challengeMessage("abcd1234efgh", "0x0000000000000000000000000000000000000001");
    const parsed = new SiweMessage(msg);
    expect(parsed.chainId).toBe(84532);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run lib/__tests__/siwe-chainid.test.ts`
Expected: FAIL — `activeChainId` is not exported (import error), and/or `parsed.chainId` is `1`.

- [ ] **Step 3: Add `activeChainId` to `payment-tokens.ts`**

Add directly below `activeChain()` (after `web/lib/payment-tokens.ts:33`):

```ts
// Numeric EVM/SIWE chain id for this deployment's active chain. Mirrors
// activeChain() (which returns the wire string) for callers that need the
// integer — e.g. the SIWE message chainId. Base mainnet 8453 / Sepolia 84532.
export function activeChainId(): 8453 | 84532 {
  return paymentNetwork() === "mainnet" ? 8453 : 84532;
}
```

- [ ] **Step 4: Use it in `challengeMessage` (`web/lib/wallet.ts`)**

Add to the imports at the top of `web/lib/wallet.ts` (next to the existing `./env` import):

```ts
import { activeChainId } from "./payment-tokens";
```

In `challengeMessage`, replace `chainId: 1,` (≈`wallet.ts:89`) with:

```ts
    chainId: activeChainId(),
```

- [ ] **Step 5: Fix the client mirror (`web/components/use-wallet-login.ts`)**

The client can't import server env. Add near the top of the file (after the imports):

```ts
// Mirrors server activeChainId() (web/lib/payment-tokens.ts) — the client
// reads the same NEXT_PUBLIC_ switch. Base mainnet 8453 / Sepolia 84532.
const CHAIN_ID =
  process.env.NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK === "mainnet" ? 8453 : 84532;
```

Replace `chainId: 1,` (`use-wallet-login.ts:42`) with `chainId: CHAIN_ID,`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd web && npx vitest run lib/__tests__/siwe-chainid.test.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Typecheck (the client edit isn't covered by vitest)**

Run: `cd web && npm run typecheck`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git add web/lib/payment-tokens.ts web/lib/wallet.ts web/components/use-wallet-login.ts web/lib/__tests__/siwe-chainid.test.ts
git commit -m "fix(siwe): emit the active Base chainId, not hardcoded Ethereum 1

Add activeChainId() (8453/84532) and use it in the server challenge and
the client SIWE message. A Base Account signs for the chain named in the
message; chainId 1 broke smart-wallet verification on Base.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Logout clears the wallet cookie

**Files:**
- Modify: `web/app/api/auth/logout/route.ts`
- Test: `web/lib/__tests__/logout-cookies.test.ts` (create)

**Interfaces:**
- Consumes: `clearCookie` from `@/lib/session` (already used); `clearWalletCookie` from `@/lib/wallet` (exists, `wallet.ts:41`, currently zero call sites).
- Produces: logout POST clears BOTH `aindrive_session` and `aindrive_wallet`.

**Why:** `logout/route.ts` only calls `clearCookie()` (session). `clearWalletCookie` is never called anywhere. The wallet cookie is an authorization credential, not just display: `tier.ts:52` reads `getWallet()` to grant the AI-agent tier / rate-limit budget. So a "logged out" user keeps their wallet-derived tier. Clearing it on logout is correct today and required before Phase 1 makes wallet-login a real session.

> **Scope note:** the deeper "single tier authority" refactor (resolve tier from the *session account's* linked wallets rather than the raw cookie) is deferred to Phase 1, where the session first becomes wallet-aware. Phase 0 only stops logout from leaving a stale authorizing cookie.

**Testing approach:** `clearCookie`/`clearWalletCookie` call `next/headers` `cookies()`, which throws outside a request scope — so a unit test can't invoke the route directly without mocking. Test the observable contract instead: assert the route module calls both clearers. Mock both modules and invoke `POST`.

- [ ] **Step 1: Write the failing test**

Create `web/lib/__tests__/logout-cookies.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const clearCookie = vi.fn(async () => {});
const clearWalletCookie = vi.fn(async () => {});

vi.mock("@/lib/session", () => ({ clearCookie }));
vi.mock("@/lib/wallet", () => ({ clearWalletCookie }));

const { POST } = await import("../../app/api/auth/logout/route.ts");

describe("logout", () => {
  beforeEach(() => {
    clearCookie.mockClear();
    clearWalletCookie.mockClear();
  });

  it("clears BOTH the session and wallet cookies", async () => {
    const res = await POST();
    expect(clearCookie).toHaveBeenCalledOnce();
    expect(clearWalletCookie).toHaveBeenCalledOnce();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
  });
});
```

Note: the `@/` alias resolves via `web/tsconfig.json` paths; vitest picks it up through the existing config. If the mock alias fails to resolve, use the relative specifiers `"../session"` / `"../wallet"` in both the `vi.mock` calls and confirm against how other `lib/__tests__` files import — but the route itself imports via `@/lib/...`, so mock the same specifier the route uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run lib/__tests__/logout-cookies.test.ts`
Expected: FAIL — `clearWalletCookie` was not called (route only calls `clearCookie`).

- [ ] **Step 3: Update the logout route**

Replace `web/app/api/auth/logout/route.ts` with:

```ts
import { clearCookie } from "@/lib/session";
import { clearWalletCookie } from "@/lib/wallet";

export async function POST() {
  // Clear BOTH credentials: the session cookie (identity) AND the wallet
  // cookie. The wallet cookie authorizes the AI-agent tier / rate-limit
  // budget (lib/tier.ts getUserTier → getWallet), so leaving it set would
  // keep a "logged out" user on their wallet-derived tier.
  await clearCookie();
  await clearWalletCookie();
  // Use a relative Location so the browser resolves against the public URL
  // it requested (e.g. https://aindrive.ainetwork.ai/) instead of the
  // container's bind address (which leaks via NextResponse.redirect's
  // absolute URL construction when behind a reverse proxy).
  return new Response(null, {
    status: 303,
    headers: { Location: "/" },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run lib/__tests__/logout-cookies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git add web/app/api/auth/logout/route.ts web/lib/__tests__/logout-cookies.test.ts
git commit -m "fix(auth): logout clears the wallet cookie too

clearWalletCookie had zero call sites, so logout left aindrive_wallet
set — and that cookie authorizes the AI-agent tier/rate-limit budget
(tier.ts getUserTier). Clear both credentials on logout.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full-suite regression + typecheck gate

**Files:** none (verification only)

**Why:** Tasks 1–3 touch `wallet.ts` (imported widely) and a shared payment helper. Confirm nothing else regressed before the PR.

- [ ] **Step 1: Run the full lib test suite**

Run: `cd web && npm test`
Expected: PASS — including the pre-existing `wallet-link.test.ts`, `paid-settle.test.ts`, `signup-verify.test.ts`, and the three files touched/created here.

- [ ] **Step 2: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Push the branch and open a draft PR**

```bash
cd /Users/comcom/Git/aindrive/.claude/worktrees/wallet-login
git push -u origin worktree-wallet-login
gh pr create --draft --title "Wallet-login Phase 0: bug fixes (transactional mint, logout cookie, SIWE chainId)" \
  --body "$(cat <<'EOF'
Pre-work hardening surfaced by the wallet-only login design
(docs/superpowers/specs/2026-07-09-wallet-only-login-design.md §3). These
are defects in current code, independent of shipping wallet login:

- **Transactional + self-healing account mint** — `resolveAccountForWallet`
  wrapped in `db.transaction()`; adopts a crash-orphaned users row instead of
  throwing email-UNIQUE (was a money-taken-no-access CRITICAL on the settle path).
- **SIWE chainId** — emit the active Base chain (8453/84532) via new
  `activeChainId()`, not hardcoded Ethereum `1`.
- **Logout clears the wallet cookie** — it authorizes the AI-agent tier;
  `clearWalletCookie` previously had zero call sites.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage (spec §3, Phase 0):**
- §3.1 transactional + self-healing mint → Task 1 ✅
- §3.2 logout clears both cookies → Task 3 ✅ (single-tier-authority explicitly deferred to Phase 1 with a scope note — matches spec §3.2's forward-looking wording)
- §3.3 chainId fix in all sites → Task 2 (`wallet.ts:89`, `use-wallet-login.ts:42`) ✅

**2. Placeholder scan:** no TBD/TODO; every code step shows full code and exact run commands with expected output. ✅

**3. Type consistency:** `activeChainId(): 8453 | 84532` defined in Task 2 and consumed only within Task 2. `resolveAccountForWallet` signature unchanged (Task 1). `clearWalletCookie` matches its existing export in `wallet.ts:41` (Task 3). ✅

**Deferred to Phase 1 (not this plan):** viem ERC-6492/1271 verifier, verify→session endpoint, provenance gate, inline SIWE, single-tier-authority refactor. Deferred to Phase 2: UI de-leak, "lose the wallet" badge, opt-in email link.

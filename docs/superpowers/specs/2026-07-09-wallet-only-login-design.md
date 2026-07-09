# Wallet-only login — design

**Status:** design (approved for spec review)
**Date:** 2026-07-09
**Drives:** remove the aindrive email-signup step from the x402 payment funnel by
letting a user log in with **just a wallet** (no email). Verified against the
codebase by an 18-agent adversarial pass, an independent architecture review,
and a 106-agent external best-practice research pass — all three converge on the
design below.

---

## 1. Problem

The x402 payment demo funnel makes a buyer (a) install / open a Base wallet
**and then** (b) do a **separate aindrive email signup** before they can pay.
Step (b) is the drop-off. We want a buyer to reach content with a wallet alone.

Today two separate proofs already exist in code and must stay separate (this is
also the SIWE/EIP-4361 industry norm — see §7):

- `aindrive_session` — identity. JWT `{sub: userId}`, `web/lib/session.ts`. The
  real login session; every drive/permission/receipt hangs off `users.id`.
- `aindrive_wallet` — wallet-ownership proof only. JWT `{addr}`,
  `web/lib/wallet.ts`. Holds an address, **not** an account.

"The account" = a `users` row (`web/lib/db.js:24`); its `id` is the root of
identity. `email` + `password_hash` are columns on it; wallets link via
`account_wallets` (`wallet_address` UNIQUE lowercased, `verified_via` records
provenance — `db.js:96`).

## 2. Chosen approach — "A-prime" (login and payment stay separate)

**Login = SIWE. Payment = x402. They never substitute for each other.** A
payment signature is a transfer authorization, not a login credential; reusing
it as auth is the exact anti-pattern SIWE exists to prevent (§7).

Funnel becomes: **connect wallet → SIWE "sign in with wallet" (one signature,
no email) → pay.** For a Base Account passkey wallet the sign-in is one biometric
tap — far lighter than an email form.

The account a wallet logs into is a **wallet-provisioned `users` row**
(`resolveAccountForWallet`, `wallet.ts:146`): a real account whose `email` is a
synthetic `<addr>@wallet.aindrive.local` placeholder and whose `password_hash`
is unusable. It is self-custodial identity (§6): **lose the wallet, lose the
account — by design.** The user may *optionally* attach a real email later for
an alternative login (opt-in, not recovery of the wallet key — §6).

### Rejected alternatives
- **Payment-first auto-session** (paying mints the session): conflates
  payment/login and re-opens three confirmed holes at once — DEV_BYPASS takeover
  (`route.ts:31,211-216`), linked-full-account hijack (`wallet.ts:151`), and it
  forces the non-transactional mint onto the **irreversible, single-use** settle
  path. Rejected.
- **Path-scoped sessions** (a session that unlocks only the purchased path): the
  account is *already* scoped by its `drive_members` rows. Redundant machinery
  that fights the role-ladder model in `docs/PERMISSIONS.md`. Not built.
- **Session lifetime by account type**: considered as defense-in-depth, dropped
  for simplicity — the provenance gate (§4) is the real hijack defense, so all
  sessions keep the current flat 30-day lifetime (`session.ts:17`).

### Where the fragile mint actually lives
"Identity before payment keeps `resolveAccountForWallet` a rare fallback" is
**false** as originally framed: SIWE-login itself must call
`resolveAccountForWallet` to obtain a `userId` for `setCookie`. A-prime does not
*remove* the mint from the hot path — it **relocates** it from settle to login.
That is a net win **because login is retryable and a single-use x402
authorization is not** (`route.ts:293`) — but only once the mint is made
transactional (§3). State this explicitly; do not claim the mint is avoided.

## 3. Phase 0 — bug fixes (ship independently of this feature)

These are defects in the **current** code, surfaced by the review. They reduce
risk whether or not wallet-login ships, and Phase 1 depends on them. Ship as
their own PR.

1. **Transactional mint.** `resolveAccountForWallet` does two separate INSERTs —
   `users` (`wallet.ts:157-159`) then `account_wallets` (`160-162`) — with **no
   transaction** (the codebase has zero `db.transaction(` uses). A crash between
   them orphans a `users` row on the deterministic synthetic email, so **every
   future call for that wallet throws email-UNIQUE** and is swallowed at
   `route.ts:320` → permanent lockout / money-taken-no-access. Fix: wrap both
   INSERTs in `db.transaction()` (better-sqlite3 supports it). Additionally make
   it **self-healing**: on a `users`-email UNIQUE hit, look up the existing row
   by the synthetic email and (re)link `account_wallets` instead of throwing.
2. **Logout clears both cookies + single tier authority.** `logout/route.ts:3`
   calls only `clearCookie()`; `clearWalletCookie` has **zero call sites**. The
   wallet cookie is not cosmetic — `tier.ts:52` reads `getWallet()` to grant the
   AI-agent tier / rate-limit budget, so a "logged out" user keeps their
   wallet-derived tier. Fix: logout clears `aindrive_wallet` too; resolve tier
   from the **session account's** linked wallets, not the raw cookie.
3. **SIWE chainId.** Hardcoded `chainId: 1` (Ethereum) in `wallet.ts:89` and
   `use-wallet-login.ts:42`; Base is 8453 / 84532. Fix all sites to the active
   payment chain (`paymentNetwork()`), so the SIWE message and verification agree
   with where Base Account actually lives.

## 4. Phase 1 — wallet login = session

4. **Rebuild SIWE verification on viem.** `web/app/api/wallet/verify/route.ts:43`
   and `web/app/api/wallet/link/route.ts:54` call `siwe`'s `verify()` **without a
   chain provider** → EOA (`ecrecover`) only. The front-line connector is Base
   Account passkey (`wagmi-config.ts:67`), a smart wallet signing via ERC-1271
   (deployed) / ERC-6492 (counterfactual) — it **fails today**. Replace with
   viem's `verifySiweMessage` (delegates to `verifyHash`, handling EOA + ERC-1271
   + ERC-6492 via a public client bound to a Base RPC). This is Base's own
   documented server recipe (§7). Verify **on the Base chain** (ERC-1271 is
   state-dependent — a research-confirmed pitfall). Apply to `/api/wallet/link`
   too. Keep the server-issued single-use nonce + domain binding.
5. **New verify → session endpoint.** Add a route + a sibling to
   `useWalletLogin` (`web/components/use-wallet-login.ts`) that mints an
   `aindrive_session` (`setCookie(userId)`) — not just the wallet cookie the
   current hook sets (`use-wallet-login.ts:47`). `userId` comes from
   `resolveAccountForWallet` (now transactional, §3.1).
6. **Provenance gate (primary hijack defense).** `resolveAccountForWallet`
   returns a *linked* account even if it is a full email account
   (`wallet.ts:148-151`), so a wallet linked merely to **pay** would become a
   login credential for that whole account from one signature, no password. Gate
   session-minting on account kind, machine-checkable via `account_wallets`:
   - **wallet-provisioned placeholder** (synthetic email / `verified_via`
     indicates payment-origin): may freely log into **itself** — this is the
     no-signup path the funnel needs. Benign: it holds only that payer's own
     purchases.
   - **wallet linked to a real email account**: **not** a login credential until
     the owner opts in while authenticated. Add an explicit
     login-authorized signal (extend `verified_via` or add a `login_enabled`
     column) set only through the authenticated link flow. Until then, a SIWE
     attempt with that wallet does not mint a session for the email account.
7. **Inline SIWE in the funnel — no page hop.** The share-gate login state does
   `router.push('/login?next=…')` (`share-gate.tsx:478`) and the free-share path
   also bounces to `/login` on the accept 401 (`share-gate.tsx:137`). If
   `/login` stays email-only the UX win leaks out here. Render "sign in with
   wallet" **inline** in the gate (reuse the already-connected wallet + one
   passkey prompt), and add the SIWE button to `/login` itself so free-share
   consume (`accept/route.ts`) works for wallet-only users.

## 5. Phase 2 — surfaces & optional identity upgrade

8. **De-leak wallet-provisioned identity.** Synthetic email / `wallet:0x…` name
   (`wallet.ts:159`) currently render into `/api/whoami` (`whoami/route.ts:6-11`)
   and the owner's member roster (`drive-manage.tsx:187,216-220`). Display a
   truncated wallet address instead of the synthetic email, everywhere a
   wallet-only account is shown to itself or to other members.
9. **"Lose the wallet, lose the account" is legible.** A wallet-only account
   carries an explicit badge/affordance stating it is recoverable **only** by its
   wallet (state legibility — the responsible form of "you're on your own").
10. **Opt-in email link (kept).** Offer — never force — attaching a real email +
    password to a wallet-only account, as a *user-chosen alternative login*
    (Privy-style progressive linking, §7). This is **not** wallet-key recovery;
    aindrive never custodies or restores wallet keys. Reuses the existing link
    machinery.

### Explicitly NOT built
- **Wallet-key recovery / custody.** Web3 norm: lose the key, it's gone. Base
  Account passkey recovery is Coinbase's responsibility, not aindrive's.
- **Account merging.** With login-before-payment, purchases bind to the chosen
  identity, so split accounts rarely arise. The one residual collision — a wallet
  that already owns its own wallet-only account is later offered to an email
  account — stays blocked by `WalletAlreadyLinkedError` (409, `wallet.ts:119`)
  with a clear "this wallet already has its own account — sign in with it"
  message. No merge engine.

## 6. Amended product principle

`CLAUDE.md:18` and `docs/PERMISSIONS.md` currently read *"Wallets are a payment
instrument only, never a login."* Replace with (exact wording finalized during
implementation):

> Identity is an account (`users` row). It is reached by **either** an
> email+password credential **or** a wallet (SIWE). A **wallet-provisioned
> account** is self-custodial: losing the wallet loses the account, by design —
> aindrive does not custody or recover wallet keys. A wallet linked to an
> existing email account is a login credential **only** after the owner opts in
> while authenticated; a payment-provisioned link never is. A verified wallet
> *payment* may still bootstrap/attribute an account (a trusted facilitator
> attests the payer controls the key), but payment is not authentication.

`docs/PERMISSIONS.md` is the canonical reference; `CLAUDE.md` points at it (no
duplication).

## 7. External grounding (research, all high-confidence unless noted)

- **Login ≠ payment is the standard.** SIWE/EIP-4361 is an off-chain ERC-191
  message carrying a mandatory **domain** (origin-bound, anti-phishing), a
  per-session **nonce** (≥8 alphanumerics, replay protection), and a login-intent
  statement — none of which a transaction signature has. So a payment signature
  must not double as a login credential. (EIP-4361; docs.login.xyz)
- **Base's documented server recipe is viem.** `client.verifyMessage(...)` →
  401 on failure; Base Account signatures embed an **ERC-6492** wrapper so they
  verify **before** the smart wallet is deployed; viem resolves EOA + ERC-1271 +
  ERC-6492 automatically. `verifySiweMessage` is the SIWE-specific wrapper.
  (docs.base.org/base-account/guides/authenticate-users; /identity/smart-wallet)
- **Do not trust `siwe.verify()` for smart wallets** (medium, 2-1, and matched by
  our own code read): a single `siwe@3` `verify()` without a provider is EOA-only
  and lacks ERC-6492. Use viem. (Refuted counter-claim in the research set.)
- **Wallet-only accounts are normal but carry hard recovery risk** — production
  tools (Privy, Dynamic, thirdweb, Base) prompt users to link a durable backup
  (email/phone/passkey) *progressively*, which is exactly the opt-in upgrade in
  §5.10. Losing the sole login method permanently locks the account. (Privy;
  Dynamic TSS-MPC docs)

## 8. Cross-cutting rules & deploy constraints

- **DEV_BYPASS never mints a session.** `AINDRIVE_DEV_BYPASS_X402=1` skips
  signature verification and takes the payer from client JSON (`route.ts:211`);
  it must stay wallet-cookie-only and never reach the session path. Document that
  the flag must never be set on any internet-reachable deployment.
- **Wallet-switch desync.** wagmi lets a user switch accounts post-login; `pay()`
  uses the *currently connected* address and settle overwrites the wallet cookie
  (`route.ts:334`) while the session stays bound to the sign-in wallet. Surface
  "paying as B, signed in as A" (or block the mismatch); do not silently diverge.
- **Nonce store is per-process in-memory** (`wallet.ts:49-57`). Safe **only**
  because the deployment is single-instance (embedded SQLite forbids replicas).
  Making SIWE the primary login raises the stakes: if we ever scale horizontally,
  the nonce store **and** SQLite must move to shared backends together.
- **CSRF.** Do not add a "mint session from the existing wallet cookie" GET
  endpoint — it would lack the nonce's incidental cross-origin protection. Keep
  session-minting behind the single-use, IP-keyed nonce + SIWE POST.
- **Mobile / Base App deeplink.** The SIWE *sign* step needs the post-redirect
  reconnect handling the paywall already has for *pay* (`share-gate.tsx:104-106`);
  the 5-min nonce TTL must cover a slow round-trip. `NEXT_PUBLIC_WC_PROJECT_ID`
  must be a real value for mobile QR pairing (`wagmi-config.ts:39-43` only warns).

## 9. Verification strategy (agent-first)

- `web/lib/wallet.ts` is pure-ish DB logic → unit tests: transactional mint,
  self-heal on synthetic-email UNIQUE, provenance gate (placeholder self-login
  allowed; payment-linked email account blocked until opt-in).
- SIWE verification: fixture signatures for EOA, deployed ERC-1271, and
  counterfactual ERC-6492 Base Account; assert all three verify on the Base chain
  and fail off-domain / on a spent nonce.
- Existing tests to keep green: `wallet-link.test.ts`, `paid-settle.test.ts`,
  `signup-verify.test.ts`.
- Manual end-to-end: the funnel (connect → SIWE → pay) with a Base Account
  passkey, and free-share consume as a wallet-only user.

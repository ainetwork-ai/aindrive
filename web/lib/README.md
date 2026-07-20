# web/lib — server-side domain logic for the web app

## Responsibility

Shared server/runtime modules behind the Next.js routes and the custom
WebSocket server (`server.js`): permissions, payments/x402, the agent RPC
bridge, SQLite access, and collab fan-out. React components and route
*shapes* live elsewhere; this directory owns the logic those routes call.

## The `.js` + `.d.ts` pattern

Modules that `server.js` imports directly (no Next.js build step) are plain
ESM `.js` with a hand-written `.d.ts` sidecar: `access-core`, `agents`,
`boot-checks`, `db`, `path`, `rate-limit`. They are imported by both TypeScript
routes and `node server.js`, so they cannot be `.ts`. Some are also mirrored
by hand into `cli/` (e.g. `protocol`, chunk sizes) — keep those in sync.

## Files

**Permissions / access**
- `access-core.js` — pure role algebra: `ROLE_RANK`, `bestMatchingRole`, `computeEntry`, `mergeRoleUpgradeOnly`. No DB, no session.
- `access.ts` — DB-backed role resolution (`resolveAccess`, `entryView`) over `drives` + `drive_members`.
- `require-access.ts` — `requireDriveRole()` auth gate for drive-scoped API routes (getUser→getDrive→resolveAccess→atLeast).
- `member-guard.ts` — `canRemoveMember`: the drive creator's row is unremovable.
- `invites.js` — `drive_invites` for emails without an account; converts to `drive_members` (upgrade-only) on signup.
- `showcase.ts` — read-only upsell view of listed paid shares the caller doesn't yet cover. Depends on access, never reverse.

**Payments / x402**
- `payment-tokens.ts` — allowed-token presets, network switch, policy parse/rebind, `toAtomicAmount` (BigInt decimal scaling).
- `x402-ain.ts` — x402 v2 facilitator for AIN on ETH mainnet (build requirements, `verify`, `settle` via on-chain Transfer log).
- `paid-lifts.js` — `paid_lifts` table: quota/tier lifts bought with AIN + tx-hash anti-replay (`txHashUsed`).
- `tier.ts` — free/pro/max tiers from active lifts; rate-limit + storage-cap multipliers.
- `wallet.ts` — SIWE nonce/cookie, `linkWalletToAccount`, `resolveAccountForWallet` (wallet→durable account bridge).
- `payment-hooks.ts` — `onPaymentSettled` extension point (Phase 2 stub).

**Agent bridge / RPC**
- `agents.js` — in-memory registry of connected agent WebSockets; `sendRpc`, `onAgentConnect`, heartbeat, multi-device fan-out.
- `rpc.ts` — typed `callAgent<M>()` wrapper + `AgentError`.
- `protocol.ts` — RPC method/params/result types + `DriveEntry` (mirrored to `cli/`).
- `sig.js` — HMAC sign/verify of RPC frames with the drive_secret (the live
  module, imported by `agents.js`). `sig.ts` is an unused duplicate — see the
  sig-consolidation note in `web/shared/README.md`.
- `agent-stream.ts` — byte-range `ReadableStream` over sequential `download-chunk` RPCs (Range playback, downloads).
- `aindrive-agent.ts` — A2A agent card + executor (runs `@/shared/agent-skills`).

**Storage / DB**
- `db.js` — singleton better-sqlite3 + drizzle; bootstraps schema, runs idempotent ALTERs, starts maintenance.
- `drives.ts` — drive CRUD, token rotation, payout/token-policy setters, Willow namespace keypair.
- `payout.ts` — pure path-scoped payout resolution (nearest-ancestor wallet, mirrors role inheritance); `drives.ts` wraps it with DB access.
- `upload-sessions.ts` — chunked/resumable upload sessions: session rows, agent temp pump (4 MiB RPC re-chunk), per-session lock. Protocol + recovery invariants live in the route: `app/api/drives/[driveId]/fs/upload-sessions/`.
- `storage-usage.js` — per-owner cached file/folder counts for tier-cap enforcement (upper bound, not exact).
- `sqlite-maintenance.js` — periodic WAL checkpoint / VACUUM / optimize.
- `migrations/` — one-shot idempotent migrations (`run.js` runs all at startup).

**Collab / Willow**
- `dochub.js` — per-doc WS broadcast hub for Y.js sync; authorizes (viewer=sub, editor=push), does NOT parse Y bytes.
- `yjs/aindrive-provider.ts` — browser Y.js provider over the doc WS (+ IndexedDB persistence). `yjs/trace-client.ts` — browser trace emitter.
- `willow/` — Meadowcap capability issuance (`cap-issue.ts`) + Ed25519 schemes (`meadowcap.js`, `schemes.js`).

**Infra**
- Config/boot: `env.ts`, `load-env.js`, `boot-checks.js`, `cookie-config.ts`.
- Identity: `session.ts` (session JWT cookie).
- Observability: `logger.js`, `trace.js` (stdout + ring buffer).
- Guards/limits: `rate-limit.js`, `limits.ts`.
- Helpers: `path.js`, `mime.ts`, `zod-helpers.ts` (`zPath`), `sort-entries.ts`, `api-client.ts`, `wagmi-config.ts`, `eip6963-uuid-guard.ts` (stabilises misbehaving wallet-extension announces so the picker lists each wallet once).

## Contracts & invariants

- **Single access source**: ownership or a covering `drive_members` row — both free and paid shares write rows there. There is no separate wallet-allowlist or share-cookie path; `access.ts` and `dochub.js`'s `resolveRole` mirror the same rule (the latter is duplicated, not imported, because `next/headers` is unavailable under raw `node server.js`).
- **Path canonicalization**: every stored/looked-up path goes through `normalizePath` (`zPath` at API boundaries) before any `isAncestorOrSelf` check. The `NormalizedPath` brand asserted in `access.ts` relies on this.
- **Role merges never downgrade** (`mergeRoleUpgradeOnly`); the creator row is never removable (`member-guard`).
- **Payment network switch is atomic**: USDC chain+asset flip together; reads rebind stale known-USDC policy rows to the current network. `toAtomicAmount` requires decimals ≥ 2 (scales from cents).
- **x402 anti-replay**: a settled `tx_hash`/`payment_tx` is UNIQUE; `verify` rejects reused hashes before any network call.
- **Globals are intentional**: agent map, dochubs, db handle, nonce/rate-limit stores are pinned on `globalThis` so the Next.js bundle and `server.js` share one instance across module duplication / HMR.
- **DEV_BYPASS_X402** makes paid shares free; `boot-checks.js` hard-fails production if it's set.

## Gotchas

- `db.js`, `paid-lifts.js`, `storage-usage.js` self-create their tables/indexes on first import — importing them has side effects.
- `db.js`'s `payment_chain→currency` rename must run before the ADD-COLUMN loop (see comment); order matters on fresh boots.
- `wagmi-config.ts` defers connector construction until first browser access (SSR `window` crash otherwise).
- Storage-usage counts start at 0/0 and only become accurate as writes flow through aindrive — they are upper-bound caps, not exact quotas.

## Related

- Permission / identity model → `docs/PERMISSIONS.md`
- Willow / Meadowcap design → `docs/WILLOW_DESIGN.md`
- Trace event contract → `docs/TRACE_CONTRACT.md`
- Package-isolation rationale (`.js`+`.d.ts`, cli mirroring) → repo-root `CLAUDE.md`
- Tests for the pure/logic modules → `web/lib/__tests__/`

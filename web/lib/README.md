# web/lib — server-side domain logic for the web app

## Responsibility

Shared server/runtime modules behind the Next.js routes and the custom
WebSocket server (`server.js`): permissions, payments/x402, the agent RPC
bridge, SQLite access, and collab fan-out. React components and route
*shapes* live elsewhere; this directory owns the logic those routes call.

## The `.js` + `.d.ts` pattern

Modules that `server.js` imports directly (no Next.js build step) are plain
ESM `.js` with a hand-written `.d.ts` sidecar: `access-core`, `agents`,
`boot-checks`, `db`, `oauth-trusted`, `orgs`, `org-policy`, `path`, `rate-limit`. They are imported by both TypeScript
routes and `node server.js`, so they cannot be `.ts`. Some are also mirrored
by hand into `cli/` (e.g. `protocol`, chunk sizes) — keep those in sync.

## Files

**Permissions / access**
- `access-core.js` — pure role algebra: `ROLE_RANK`, `bestMatchingRole`, `computeEntry`, `mergeRoleUpgradeOnly`. No DB, no session.
- `access.ts` — DB-backed role resolution (`resolveAccess`, `entryView`) over `drives` + `drive_members` + organization shares (`orgs.js`). `personalRoleByUser` leaves the organization out — for acts that write a durable grant (minting links, accept/settle merges); `isRelatedToDrive` is the showcase gate.
- `orgs.js` (+ `.d.ts`) — organizations: drives shared with an AIN SSO organization (`drive_org_shares`), the role an active member gets (`orgRoleInDrive`, read by `access.ts`, `dochub.js`, `mcp-tokens.ts`), the home page's org sections (with paused shares counted), share/unshare (audited in `sso_audit`), the sign-in landing. `org-policy.js` (+ `.d.ts`) — its pure rules: who may share (creator + org admin or `AINDRIVE_ORG_SHARE_ALLOWLIST`, refusal codes), the allowlist parser, `landingPath`, `orgSectionState`. Operator: `scripts/org-drive.mjs`.
- `drive-location.ts` — pure: `?path` + membership + stat kind → the drive page's folder, open file, breadcrumb root and grant listing (`locationPath` is the reverse, for the URL).
- `require-access.ts` — `requireDriveRole()` auth gate for drive-scoped API routes (getUser→getDrive→resolveAccess→atLeast). With `opts.req` (fs/thumbnail, fs/stream, fs/download) it also takes the session JWT as `Authorization: Bearer` (`session.ts` `getRequestUser`; an invalid bearer is a 401, never a cookie fallback) — for hosts that proxy AINUI assets. With `opts.delegation` (fs/read, fs/list only) it takes an AIN SSO resource delegation (`resource-delegation.ts`) and gates as the delegated account.
- `sale-access.js` — the paid carve-out: `paidAccessDenial` (read gate, shared by HTTP and `dochub.js`), `paidLocksForPaths`/`paidLocksForListing` (🔒 rows). `paid-lock.ts` turns a 402 body into the paywall the drive UI shows (client-safe).
- `member-guard.ts` — `canRemoveMember`: the drive creator's row is unremovable.
- `invites.js` — `drive_invites` for emails without an account; converts to `drive_members` (upgrade-only) on signup.
- `showcase.ts` — read-only upsell view of listed paid shares the caller doesn't yet cover. Depends on access, never reverse.

**Payments / x402**
- `payment-tokens.ts` — allowed-token presets, network switch, policy parse/rebind, `toAtomicAmount` (BigInt decimal scaling).
- `sales.ts` — share-link create/edit/revoke, payout-wallet and token-policy validation, receipt paging. One implementation behind the `shares`/`payout`/drive-PATCH routes and the remote-MCP sale tools; returns `{ ok: false, status, error }` with the route's exact message.
- `x402-ain.ts` — x402 v2 facilitator for AIN on ETH mainnet (build requirements, `verify`, `settle` via on-chain Transfer log).
- `x402-facilitator.ts` — facilitator resolution + `verifyAndSettle` (`beforeSettle` hook between verify and settle; failures say whether settle was `not_sent`, `refused` before broadcast, or `uncertain`).
- `x402-account-settlements.js` — accounts' EIP-3009 settle attempts recorded before settle; blocks a second charge while an outcome is unknown; never credits from the chain (`docs/X402_PAYMENT_PENDING.md`). `x402-authorization-chain.js` — read-only chain checks for the support CLI `scripts/x402-settlements.mjs` only.
- `paid-lifts.js` — `paid_lifts` table: quota/tier lifts bought with AIN + tx-hash anti-replay (`txHashUsed`).
- `tier.ts` — free/pro/max tiers from active lifts. Rate limits use the caller's tier (wallet cookie); storage caps use the drive owner's (`getOwnerStorageCaps`: lifts on any wallet linked to the owner, or `AINDRIVE_UNLIMITED_OWNERS`), identical for session, PAT and account-token writes.
- `wallet.ts` — SIWE nonce/cookie, `linkWalletToAccount`, `resolveAccountForWallet` (wallet→durable account bridge).
- `base-siwe.ts` — client helpers for Base Account `wallet_connect` + `signInWithEthereum` (single-popup passkey + SIWE; the popup-blocker rationale lives in its header).
- `payment-hooks.ts` — `onPaymentSettled` extension point (Phase 2 stub).

**Agent bridge / RPC**
- `agents.js` — in-memory registry of connected agent WebSockets; `sendRpc`, `onAgentConnect`, heartbeat, multi-device fan-out. `canonicalAgentResult` puts list/stat names into NFC on the way in. `startHeartbeat` drops a socket that misses a pong (the CLI mirrors it with `watchServerSilence`).
  `rotateAgentLive` rotates a drive's agent token + secret over the live socket
  without disconnecting it (the CLI half is `cli/src/rotation.js`). Set
  `drives.rotation_pending = 1` to queue a drive: it rotates on its next connect,
  or within 5 min if it is online (`startRotationSweeper`). Multi-device drives
  and older agents stay pending; `rotate-token` (manual) clears the flag.
- `rpc.ts` — typed `callAgent<M>()` wrapper + `AgentError`.
- `protocol.ts` — RPC method/params/result types + `DriveEntry` (mirrored to `cli/`).
- `sig.js` — HMAC sign/verify of RPC frames with the drive_secret (the live
  module, imported by `agents.js`). `sig.ts` is an unused duplicate — see the
  sig-consolidation note in `web/shared/README.md`.
- `agent-stream.ts` — byte-range `ReadableStream` over sequential `download-chunk` RPCs (Range playback, downloads).
- `aindrive-agent.ts` — A2A agent card and executor. It handles skill DataParts, A2UI actions and text commands, and sends an A2UI DataPart when the extension is on. It runs `@/shared/agent-skills`.
- `device-agent-a2a.ts` — each drive's on-device agent over A2A (`/a2a/d/[driveId]`, card at `./.well-known/agent-card.json`): owner only, the question goes straight to the device's `agent-ask` RPC (no `.aindrive/agents` record — reading one per question turned a busy phone into "agent_not_found"); the reply carries an `ai.aindrive/ask-result` data part; billed like the old ask (tier budget, one `metadata.askId` = one ask).
- `agui.ts` — AG-UI 1.0 agent (`/agui`, `/agui/d/[id]`): RunAgentInput in, one skill per run, events back (TOOL_CALL_*, `a2ui-surface` activity, state, text).
- `agent-auth.ts` — one bearer → SkillCtx resolver for A2A and AG-UI (PAT, OAuth, account token, session JWT).
- `resource-delegation.ts` — origin-side enforcement of AIN SSO resource delegations (`ain-rdlg+jwt`, wallet-and-delegation §5; matrix R-DLG-READ-001): `verifyResourceDelegation` (issuer JWKS via `sso/oidc.ts`, typ/iss/aud/exp, contract claim shapes), `verifyProofOfPossession` (`X-AIN-PoP` JWS by the `cnf` key, 60 s window, single-use jti), `createDelegationStatusClient` (revocation, cached ≤ 60 s, fails closed), `mayReadWithDelegation` (three checks: linked account may read now, grant names the file or an ancestor folder key, read/list only). Never imports the SSO SDK (other repo).
- `listing-visibility.ts` — the one listing rule (plan task 06.5): `visibleChildren` hides the reserved `.aindrive/` subtree and unlisted unentitled sales, locks listed ones. Used by fs/list and the list_files/stat/search skills; bytes stay behind `require-access.ts readDenial`.
- `path-generations.js` — per-path generations (task 10.2, `path_generations` table): `generationFor` hands one out (flag on), `dropGenerations` on create/rename/delete and the agent's fs-changed removal, a changed `birthtimeMs` rotates it; fs/read refuses a stale one with `resource_deleted`.
- `request-id.ts` — `X-Request-Id` + one allow-listed, secret-scrubbed log line for the shared-list and delegated routes (task 12.5). `ain-integration.js` — the `AIN_INTEGRATION_ENABLED` flag these read.
- `shared-items.ts` — the common shared-file list (ain-integration contract 1.0, re-declared locally): `listSharedItems` builds `FileListResponse` rows from `drives` + `drive_members` (+ `payment_receipts` for `paid`, `sso_identities` for `ownerRef`; `shared_with_org` from `orgs.js orgDrivesForUser`), `sharedFileId` = the `p1:` path-derived id, contract error helpers. Serves `/api/me/shared`, `/api/oauth/shared` and the `list_shared` skill; never calls an agent.
- `mcp-http.ts` / `mcp-ui.ts` / `mcp-tokens.ts` / `oauth.ts` — remote MCP (tools, MCP Apps view, A2UI results), its tokens and the OAuth server. `oauth-authorize.ts` — what a visit of `/oauth/authorize` does (sign-in via AIN SSO, trusted client + AIN SSO session → code, else consent) and the one approval it shares with the consent POST; `oauth-trusted.js` — parses `AINDRIVE_TRUSTED_OAUTH_CLIENTS`. See `app/mcp/README.md`.
- `share-events-core.js` / `share-events.ts` — the change feed (ain-integration task 10): `recordShareEvent` writes one `share_events` row per recipient with a per-resource strictly increasing `version` (`share_event_versions`), keeps the newest 10 000 rows per recipient (`share_event_floors` = the gap floor); hooks `onMemberGranted/Revoked`, `onOrgShared/Revoked`, `onDriveDeleted`, `onAgentOnlineChanged`, `onFsChanged` are called from the member/share/settle/delete routes, `invites.js`, `sso/store.js`, `orgs.js` and `agents.js` (plain ESM so the custom server can import the core). The `.ts` mirrors the event contract (zod) and pages it (`listShareEvents`, `ev_<seq>` cursors, `gap`) for `/api/me/events` and `/api/oauth/events`. `share-events-restore.js` (`scripts/after-restore.mjs`) moves the feed past a database restore: seq jump, floors raised (every older cursor → `gap: true`), versions +1 000 000.
- `ainui.ts` — server side of AINUI (`docs/AINUI.md`): wires `shared/a2ui/ainui.ts` (builders + action dispatcher) to runSkill, the transport's allow-list, the caller's live role and `mime.ts`. Used by `mcp-http.ts` (`X-AINUI: 1`), `agui.ts` (`forwardedProps.ainui`) and `aindrive-agent.ts` (`metadata.ainui`).

**Storage / DB**
- `db.js` — singleton better-sqlite3 + drizzle; bootstraps schema, runs idempotent ALTERs, starts maintenance.
- `drives.ts` — drive CRUD, token rotation, payout/token-policy setters, Willow namespace keypair.
- `payout.ts` — pure path-scoped payout resolution (nearest-ancestor wallet, mirrors role inheritance); `drives.ts` wraps it with DB access.
- `upload-sessions.ts` — chunked/resumable upload sessions: session rows, agent temp pump (4 MiB RPC re-chunk), per-session lock. Protocol + recovery invariants live in the route: `app/api/drives/[driveId]/fs/upload-sessions/`.
- `write-guard.ts` — writes that name a path: `withPathLock` (one write of a (drive, path) at a time in this process — agents that write in place never interleave two saves), conditional writes (`baseRevision`/`If-Match`/`base_revision` → 409 `conflict` + `currentRevision`; `none` = create only) and the no-backslash rule for new names (the contract would give `a\b` the id of `a/b`). Used by fs/write and MCP `write_file`; mkdir/rename/upload* apply the name rule.
- `storage-usage.js` — per-owner cached file/folder counts for tier-cap enforcement (upper bound, not exact). Signed deltas: creates add, deletes subtract; the stored total is clamped at 0.
- `sqlite-maintenance.js` — periodic WAL checkpoint / VACUUM / optimize.
- `migrations/` — one-shot idempotent migrations (`run.js` runs all at startup).

**Collab / Willow**
- `dochub.js` — per-doc WS broadcast hub for Y.js sync; authorizes (viewer=sub, editor=push), does NOT parse Y bytes. Sockets with organization-derived access are re-checked per frame and swept every 5 s (`revalidateOrgPeers`), so out-of-process share changes (operator script) reach them.
- `yjs/aindrive-provider.ts` — browser Y.js provider over the doc WS (+ IndexedDB persistence). `yjs/trace-client.ts` — browser trace emitter.
- `willow/` — Meadowcap capability issuance (`cap-issue.ts`) + Ed25519 schemes (`meadowcap.js`, `schemes.js`).

**Infra**
- Config/boot: `env.ts`, `load-env.js`, `boot-checks.js`, `cookie-config.ts`.
- Identity: `session.ts` (session JWT cookie; verified through the AIN SSO gate — epoch, SSO session row, suspension), `sso/` (AIN SSO sign-in, provisioning adapter, back-channel logout — `sso/README.md`), `google-auth.ts` (Google ID token; never links by email), `auth-csrf.ts` (login-CSRF guard of the auth POSTs that set or end the session cookie).
- Observability: `logger.js`, `trace.js` (stdout + ring buffer).
- Guards/limits: `rate-limit.js`, `limits.ts` (drives-per-account cap, `AINDRIVE_UNLIMITED_OWNERS` storage-cap exemption).
- Helpers: `path.js`, `mime.ts`, `served-bytes.ts` (the only way a route serves user-typed bytes inline — fs/stream, /api/h), `zod-helpers.ts` (`zPath`), `sort-entries.ts`, `api-client.ts`, `wagmi-config.ts`, `eip6963-uuid-guard.ts` (stabilises misbehaving wallet-extension announces so the picker lists each wallet once).

## Contracts & invariants

- **Single access source**: ownership, a covering `drive_members` row — both free and paid shares write rows there — or an organization the drive is shared with (`orgs.js orgRoleInDrive`: a whole-drive viewer/editor grant, computed per check from `sso_memberships`, never copied into `drive_members`). There is no separate wallet-allowlist or share-cookie path; `access.ts` and `dochub.js`'s `resolveRole` mirror the same rule (the latter is duplicated, not imported, because `next/headers` is unavailable under raw `node server.js`; both call the same `orgRoleInDrive`).
- **Path canonicalization**: every stored/looked-up path goes through `normalizePath` (`zPath` at API boundaries) before any `isAncestorOrSelf` check — slashes, `.` segments and Unicode NFC (macOS agents report NFD names). A gate judges the same canonical path it then serves: the WS hub canonicalizes its URL path, and a Yjs doc is named by the authorized path (`docIdFor`), never by a client-sent id. Case is not canonicalized, so the paywall and the `.aindrive/` check ignore it (a macOS agent serves `Premium/` for `premium/`) — `PERMISSIONS_MATRIX.md` R-ACC-PATH-001. The `NormalizedPath` brand asserted in `access.ts` relies on this.
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

## Remote folder chat

`cloud-agent.ts` uses `ain-ui`'s bounded recursive walker and A2A accumulator. It lists only the requested subtree (200 entries, 8 levels, 64 directories), reports incomplete inventories, and grants temporary read links for at most 50 files. The receiving model decides which granted files to read. `folder-chat-stream.ts` wraps updates as AG-UI SSE and AIN-UI activity snapshots. Never retry a submitted streaming turn as a new blocking request. Tests: `folder-chat-route.test.ts`, `cloud-agent-listing.test.ts`.

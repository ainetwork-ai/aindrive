# Test Scenarios — RED/GREEN Inventory

Last updated: 2026-06-10 (post-final additions #168–#175 — showcase + payment-token policy Phase 2a)

## Baseline before Phase 3 fixes

Run: ~86 pass / ~65 fail (from Phase 2 dispatch notes)
After Phase 3a+3b: **136 passed / 15 skipped / 0 failed (151 total)**
After Phase 3c: **147 passed / 1 skipped / 0 failed (148 total)** (3 deleted: #56/#57/#58)

---

## Root causes fixed in Phase 3a

### Fix #1 — Signup rate-limit cascade (recovered ~40 cases)

`POST /api/auth/signup` enforces `tryConsume({name:"auth-signup", limit:5, windowMs:300000})`
keyed on `x-forwarded-for || x-real-ip || "anon"`. The rate-limit check fires BEFORE input
validation, so even 400-returning calls (short password, bad email) consume from the bucket.

Inline signups in cases 1–6 and `ensureOwner()` all sent no `x-forwarded-for`, sharing
the `anon` bucket. By case 6 the bucket was full (count ≥ 5); the `ensureOwner()` call
in case #8 got `429 rate_limited` → `ownerCookie = null` → all subsequent `ensureDrive()`
calls got `401 unauthorized` → cascading failure through ~40 cases.

**Fix:** Added `signup(email, name, password)` wrapper (cases.mjs) deriving a unique
`x-forwarded-for` IP from `state.uniqueSeed` per call. Replaced all inline signup calls
and `ensureOwner()`. Same pattern applies to any future signup helpers added to the suite.

### Fix #2 — macOS `ps -eo pid,cmd` column unavailable (recovered agent kill/restart)

macOS `ps` requires `command`, not `cmd`. Affected `ensureDrive()` kill-existing-agent
path and case #96 agent-reconnect test — both using `ps -eo pid,cmd`.

**Fix:** Replaced `ps -eo pid,cmd` with `ps -eo pid,command` at both call sites.

### Fix #3 — afterEach sweep killing the suite agent (recovered ~8 FS/Yjs cases)

`all.test.mjs` afterEach sweeps all `start-agent.mjs` processes after every test,
intending to clean up agents spawned within a specific case (#92 boot.mjs, #96/#118
start-agent.mjs). It correctly skips `HARNESS_AGENT_PID` (the globalSetup agent)
but also killed the "suite agent" spawned by `ensureDrive()` for the test drive.

After case #41 (which calls `ensureDrive()` and starts the agent), the afterEach swept
killed the suite agent. Case #42 ran without calling `ensureDrive()`, found the drive
offline, and got 504. Same pattern for #45, #48, #50–#53, #83, #86, #87.

**Fix:** `ensureDrive()` and all agent-restart sites now publish the spawned PID to
`process.env.SUITE_AGENT_PID`. The afterEach sweep skips both `HARNESS_AGENT_PID`
and `SUITE_AGENT_PID`. Case #96 also updates `SUITE_AGENT_PID` when it respawns.

---

## RED cases — classified for Phase 3c

All 15 cases below were explicitly skipped in the suite before Phase 3c.
The Phase 3b baseline was **green (136 pass / 15 skip / 0 fail)**.

Per spec MF5, a required gate must contain no known false-greens. Cases #59/#62/#63
passed only because a wallet-cookie user had no session (`getUser()` null → 401 for
session absence), not because role logic denied them — so they were skipped here and
rewritten with real email-signup `drive_members` actors in Phase 3c.

| # | File | Name (abbreviated) | Phase 3b Reason | Phase 3c Disposition |
|---|------|--------------------|-----------------|----------------------|
| 56 | cases.mjs | owner adds wallet to / | POST /api/drives/[driveId]/access deleted in PR#6 → 404 | DELETED: no equivalent; role-gating intent in #59–65 |
| 57 | cases.mjs | duplicate wallet at same path → 409 | same deleted route → 404 | DELETED: /members upsert returns 200 upgrade-only |
| 58 | cases.mjs | owner adds wallet B to subpath | same deleted route → 404 | DELETED: intent in #61 (real /members invite at "docs") |
| 59 | cases.mjs | wallet C with no allowlist → 401 | false-green (session absence) | PORTED: real uninvited email user → 401/403 |
| 60 | cases.mjs | wallet A (allowed at /) can list root | depends on deleted /access grant | PORTED: invite real viewer at ""; assert role=viewer |
| 61 | cases.mjs | wallet B (allowed at docs) can list docs | depends on deleted /access grant | PORTED: invite real viewer at "docs" |
| 62 | cases.mjs | wallet B cannot list parent / | false-green (session absence) | PORTED: docs-only viewer → **eq(r.status, 403)** |
| 63 | cases.mjs | wallet A (viewer) cannot write | false-green (session absence) | PORTED: root viewer write → **eq(r.status, 403)** |
| 64 | cases.mjs | owner revokes wallet A | GET+DELETE /access/[id] deleted | PORTED: DELETE /members/[id]; revoked user denied |
| 65 | cases.mjs | access add returns Meadowcap cap | /access deleted; cap source gone | PORTED: DEV_BYPASS paid GET → body.cap |
| 76 | cases.mjs | verify a freshly-issued cap | /access deleted; no cap | PORTED: getPaidCap() → /cap/verify; valid=true |
| 78 | cases.mjs | cap pathPrefix matches issuance | /access deleted | PORTED: cap path="" → pathPrefix="" |
| 79 | cases.mjs | cap timeEnd ≈ now + 30 days | /access deleted | PORTED: cap from paid GET; timeEnd in 30d window |
| 80 | cases.mjs | two issuances → different receiver pubkeys | /access deleted | PORTED: two separate share tokens; receiverPub differs |
| 109 | collab-cases.mjs | viewer-role peer denied subscription | WS hub has no wallet-cookie auth path | SKIP-tracked: genuine product design gap (out of 3c scope) |

No false-greens remain: #62 and #63 now assert **specific 403** (not 401\|\|403).
Cases #56/#57/#58 deleted (no equivalent capability in the new model).

---

## Phase 3c confirmed GREEN baseline

**Run date:** 2026-06-06
**Node version:** 22.22.3
**Harness:** `npm --prefix web run test:e2e` (live server+agent on per-run tmp dirs)

**Result: 147 passed / 1 skipped / 0 failed (148 total)**
(151 − 3 deleted [#56/#57/#58] = 148 total; 14 formerly-skipped cases now green)

### Explicitly skipped

- Genuine product design gap tracked separately: **#109** (1 case — WS hub has no wallet-cookie auth path; tracked for fix outside Phase 3c scope)

### Green clusters (all 147 passing cases)

| Cluster | Cases | Notes |
|---------|-------|-------|
| A. Auth | #1–#10 | signup, login, logout, session cookie |
| B. Wallet auth | #11–#20 | SIWE nonce/verify, /wallet/me |
| C. Drives | #21–#30 | create, list, rotate, online flag, page render |
| D. Agent WS | #31–#35 | last_seen_at, bad token close, simultaneous agents, heartbeat |
| E. RPC/FS | #36–#55 | list, read, write, mkdir, rename, delete |
| F. Membership / role gating | #59–#65 | real email actors via /members; denial cases assert specific 403 |
| G. Shares / x402 | #66–#67 | free/paid share, DEV_BYPASS settle, x402 402 path (#68–#75 do not exist) |
| H. Cap | #76–#80 | Meadowcap issuance + verification via DEV_BYPASS paid-accept GET |
| I. Yjs | #81–#90 | real-time editing, autosave, Y.Doc persistence, Willow Store, WS role gate |
| J. Multi-device | #91–#100 | multi-agent, willow sync, idempotent digest, reconnect |
| Collab | #101–#120 exc. #109 | Yjs CRDT convergence, awareness, persistence |
| Trace | #121–#140 | trace ring, ws-doc-sub/fwd events, diagnose.mjs |
| Emergent | #141–#160 | self-write suppression, loop detection, steady-state |

### Deletion record

| # | Reason for deletion |
|---|---------------------|
| 56 | Tested POST /access (deleted PR #6); role-gating intent in #59–#65 |
| 57 | Same; /members upsert is upgrade-only (no 409) |
| 58 | Same; /members invite at "docs" is #61 |

### Phase 3b confirmed GREEN baseline (archived)

**Result: 136 passed / 15 skipped / 0 failed (151 total)**

- Cases deferred to Phase 3c (access/wallet re-architecture): **#56, #57, #58, #59, #60, #61, #62, #63, #64, #65, #76, #78, #79, #80** (14 cases)
- Genuine product design gap tracked separately: **#109** (1 case)

**This baseline is the Phase 7 merge-gate target.**

### FINAL state (after Phase 3c + Phase 5)

**Result: 151 passed / 1 skipped / 0 failed.**

> Post-final addition (drive-access-entry Phase 1, 2026-06-10): **#165/#166** — path-scoped
> viewer reaches granted sub-path (200) but not root (403); un-granted sibling explicit
> `?path` → 403 (oracle guard). New IDs — deleted IDs (#56–#58) stay retired.
> Phase 1b (2026-06-10): **#167** — multi-grant viewer (dir grant + FILE grant): root and
> un-granted parent `assets` list → 403, granted `docs` list → 200, granted file
> `assets/logo.txt` read → 200 (synthetic-root server-side preconditions).
> Suite now **154 passed / 1 skipped / 0 failed**.
>
> Phase 2a — showcase + payment-token policy (2026-06-10): **#168–#175** (8 cases).
> #168 listed leaf visible to a partial member, with NO ancestor/full-path/token
> leak in the DTO + the listed path's `fs/list` still 403 (showcase is fs-independent).
> #169 unlisted paid share absent. #170 non-member showcase GET → 403 (member upsell,
> not a public storefront). #171 USDC policy 402 (`accepts[0].network`=base-sepolia,
> asset=USDC preset, `currency.symbol`=USDC). **#172** policy *discriminator*: a
> non-USDC FANCO policy (base, 18-dec, dummy asset) drives the 402 to those exact
> values + `maxAmountRequired === "1000000000000000000"` (exact 1·10^18 digit string,
> no exponent) — direct proof the policy flows, not a hardcoded constant. #173 listed
> is owner-only (path editor: listed:true → 403, unlisted → 200). #174 settle-gated:
> no `drive_members` row until the DEV_BYPASS paid GET settles (real DB state via
> `dbHandle()`, joined through `account_wallets`). #175 WS denied for a listed-but-unpaid
> path (partial member → dochub `close(4401)`; listed/price never open the realtime hub).
> Suite now **162 passed / 1 skipped / 0 failed**.

- Phase 3c re-architected all 14 deferred access/cap cases to REAL actors: email-signup users invited via `POST /api/drives/[driveId]/members` (or CONSUME via `/api/s/[token]/accept`), not wallet-only cookies. Denial cases (#62/#63) assert a **specific 403** for an authenticated insufficient-role user (no `401||403` false-greens) — a privilege-escalation regression turns them red. Cap cases (#76–#80) obtain the Meadowcap cap from the DEV_BYPASS paid GET (`body.cap`) → `/api/cap/verify`. Cases #56–#58 deleted (wallet-allowlist capability gone, no equivalent).
- Phase 5 added money-path coverage #161–#164: free CONSUME → `drive_members` row; paid settle → `payment_receipts` row; `tx_hash UNIQUE` replay guard (white-box, since DEV_BYPASS mints a fresh tx_hash per call — documented limitation); `mergeRoleUpgradeOnly` (editor not downgraded by a viewer share). All assert real DB state via `dbHandle()`.
- **Only remaining skip: #109** — dochub WS hub reads only `aindrive_session`, not the `aindrive_wallet` cookie, so a wallet-cookie-only WS visitor can't auth. Decided policy (2026-06): identity is the email account; the wallet is a payment instrument only, never a login/actor credential — and the share gate requires sign-in before payment, so real paid visitors hold a session cookie. The skip documents the dead wallet-actor path, NOT a planned feature.

### Phase 4 — de-flake status & fast-subset decision

De-flake **substance is achieved** and was built into the harness during Phases 2–3, not as a separate pass:
- Readiness via `pollUntil` on `/api/readyz` then `/api/healthz` (no fixed boot sleeps).
- Per-run isolation: fresh tmp `AINDRIVE_DATA_DIR` + tmp `AINDRIVE_SAMPLE_DIR` copy per run.
- Process-group teardown (SIGTERM→SIGKILL) + an `afterEach` `ps` sweep covering per-case agents → **no orphan processes** after any run.
- Signup rate-limit isolation: unique `x-forwarded-for` per signup (no shared `anon` bucket).
- Empirically stable: the full suite ran **green across ~10 independent re-runs** by separate review agents, with clean teardown each time.

**Fast-subset (`AINDRIVE_E2E_FAST`) — DEFERRED (YAGNI), per Open Item O1.** Measured full-suite wall-clock ≈ **4 min** locally (est. 5–8 min on ubuntu CI). That is an acceptable PR-gate cost, so the CI `e2e` job runs the FULL suite on every PR + push (see `.github/workflows/ci.yml`). A fast-subset-on-PR + nightly-full split is a documented follow-on to revisit only if CI time becomes a pain or the suite grows materially. The state object is shared+serial (`fileParallelism:false`) by design; per-run isolation removes cross-run contamination, and the proven stability makes intra-run order-coupling a non-issue in practice.

**Net status: built, green (151/1/0 at completion — now 162/1/0, see Post-final note), CI-wired, stable. Sub-project 1 (the e2e test net) is complete.**

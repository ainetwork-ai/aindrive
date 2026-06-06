# Test Scenarios — RED/GREEN Inventory

Last updated: 2026-06-06 (post-PR-#6 reconciliation, Phase 3a + 3b)

## Baseline before Phase 3 fixes

Run: ~86 pass / ~65 fail (from Phase 2 dispatch notes)
After Phase 3a+3b: **136 passed / 15 skipped / 0 failed (151 total)**

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

All 15 cases below are explicitly skipped in the suite with a reason string.
The Phase 3b baseline is **green (136 pass / 15 skip / 0 fail)**.

Per spec MF5, a required gate must contain no known false-greens. Cases #59/#62/#63
pass only because a wallet-cookie user has no session (`getUser()` null → 401 for
session absence), not because role logic denied them — so they are skipped here and
rewritten with real email-signup `drive_members` actors in Phase 3c, NOT counted green.

| # | File | Name (abbreviated) | Reason RED | Disposition |
|---|------|--------------------|------------|-------------|
| 56 | cases.mjs | owner adds wallet to / | POST /api/drives/[driveId]/access deleted in PR#6 → 404 | PORT-3c: rewrite via POST /api/drives/[driveId]/members |
| 57 | cases.mjs | duplicate wallet at same path → 409 | same deleted route → 404 | PORT-3c: /members upsert returns 200 upgrade-only, not 409 |
| 58 | cases.mjs | owner adds wallet B to subpath | same deleted route → 404 | PORT-3c: rewrite via /members invite at path "docs" |
| 59 | cases.mjs | wallet C with no allowlist → 401 | wallet-cookie → `getUser()` null → 401 for session absence, NOT role denial (false-green; may even 401 from a wallet/verify 429) | PORT-3c: rewrite with real email-signup drive_members actors |
| 60 | cases.mjs | wallet A (allowed at /) can list root | depends on case #56 /access grant (never set up) | PORT-3c: invite real email user as viewer at "" |
| 61 | cases.mjs | wallet B (allowed at docs) can list docs | depends on case #58 /access grant (never set up) | PORT-3c: invite real email user as viewer at "docs" |
| 62 | cases.mjs | wallet B cannot list parent / | wallet-cookie → `getUser()` null → 401 for session absence, NOT path-scope role gate (false-green) | PORT-3c: rewrite with real email-signup drive_members actors |
| 63 | cases.mjs | wallet A (viewer) cannot write | wallet-cookie → `getUser()` null → 401 for session absence, NOT role gate on min:editor (false-green) | PORT-3c: rewrite with real email-signup drive_members actors |
| 64 | cases.mjs | owner revokes wallet A | GET + DELETE /api/drives/[driveId]/access/[id] deleted → 404 | PORT-3c: rewrite via DELETE /api/drives/[driveId]/members/[memberId] |
| 65 | cases.mjs | access add returns Meadowcap cap | POST /access deleted; cap source gone | PORT-3c: cap now from paid-accept GET body.cap (DEV_BYPASS) |
| 76 | cases.mjs | verify a freshly-issued cap | POST /access deleted; no cap to verify | PORT-3c: get cap from DEV_BYPASS paid GET /api/s/[token] body.cap |
| 78 | cases.mjs | cap pathPrefix matches issuance | same — POST /access gone | PORT-3c: cap from paid-accept GET |
| 79 | cases.mjs | cap timeEnd ≈ now + 30 days | same | PORT-3c: cap from paid-accept GET |
| 80 | cases.mjs | two issuances → different receiver pubkeys | same | PORT-3c: two paid-accept GETs (DEV_BYPASS, distinct share tokens) |
| 109 | collab-cases.mjs | viewer-role peer denied subscription | `dochub.js` `readUserFromCookie` only reads `aindrive_session`; wallet cookie from paid GET not recognized for WS auth | SKIP-tracked: genuine product design gap — WS hub has no wallet-cookie auth path. Fix tracked separately from 3c. |

No false-greens remain in the green baseline: the three previously-accepted denial
cases (#59/#62/#63) are now skipped (see rows above).

---

## Phase 3b confirmed GREEN baseline

**Run date:** 2026-06-06
**Node version:** 22.22.3
**Harness:** `npm --prefix web run test:e2e` (live server+agent on per-run tmp dirs)

**Result: 136 passed / 15 skipped / 0 failed (151 total)**

### Explicitly skipped (classified above)

- Cases deferred to Phase 3c (access/wallet re-architecture): **#56, #57, #58, #59, #60, #61, #62, #63, #64, #65, #76, #78, #79, #80** (14 cases)
- Genuine product design gap tracked separately: **#109** (1 case)

### Green clusters (all 136 passing cases)

| Cluster | Cases | Notes |
|---------|-------|-------|
| A. Auth | #1–#10 | signup, login, logout, session cookie |
| B. Wallet auth | #11–#20 | SIWE nonce/verify, /wallet/me |
| C. Drives | #21–#30 | create, list, rotate, online flag, page render |
| D. Agent WS | #31–#35 | last_seen_at, bad token close, simultaneous agents, heartbeat |
| E. RPC/FS | #36–#55 | list, read, write, mkdir, rename, delete |
| G. Shares / x402 | #66–#67 | free/paid share, DEV_BYPASS settle, x402 402 path (#68–#75 do not exist) |
| H. Cap | #77 | garbled-cap rejection (standalone, no /access dependency) |
| I. Yjs | #81–#90 exc. skipped | real-time editing, autosave, Y.Doc persistence, Willow Store |
| J. Multi-device | #91–#100 | multi-agent, willow sync, idempotent digest, reconnect |
| Collab | #101–#120 exc. #109 | Yjs CRDT convergence, awareness, persistence |
| Trace | #121–#140 | trace ring, ws-doc-sub/fwd events, diagnose.mjs |
| Emergent | #141–#160 | self-write suppression, loop detection, steady-state |

**This baseline is the Phase 7 merge-gate target.**

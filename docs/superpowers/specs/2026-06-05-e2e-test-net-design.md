# Sub-project 1 — Stand up the e2e Test Net — Design Spec

> 2026-06-05. First sub-project of the hackathon→product architecture work
> (`docs/ARCHITECTURE_ASSESSMENT.md`, P0 first move). Re-scoped after a first
> adversarial review (the prior draft falsely assumed the scenario suite was
> in-process) and a second focused re-review (harness env/port mechanics +
> reconciliation reality). This spec owns the *real* net. sig/protocol
> consolidation → Sub-project 2; schema codegen → the deferred drizzle-kit
> sub-project.

## Why

The assessment's "first move": no later refactor (state-interface extraction,
Willow cleanup, the PR-#6 permission model that lives **in the HTTP routes**) is safe
without a CI net catching regressions on the **money paths** (share create, x402
settle, paid→`drive_members` grant, free CONSUME accept, role gating) and **realtime
paths** (Yjs convergence, DocHub broadcast, willow-sync). Today:

- The `web/scenarios/` suite (151 cases: cases 91 + collab 20 + emergent 20 + trace
  20) covers these paths but is **excluded from CI** (`.github/workflows/ci.yml:4-6`:
  scenarios "need a live :3737 server + a connected CLI agent, so they are NOT run
  here"), **hardcoded to one dev's absolute paths** (`/mnt/newdata/git/aindrive/...`),
  spawns a **`start-agent.mjs` absent from the repo**, and is **RED against current
  code** (cases hitting the `/api/drives/[driveId]/access` route PR #6 deleted, plus
  cases that pass for the *wrong reason* — see Phase 3). Clean checkout = 151/151 fail.
- The CLI has **zero tests**.
- Node is fragmented (CI 20 / Docker `node:22` / a dev better-sqlite3 binary built
  for 24).

## Goal

The scenario suite runs **green in CI** against a freshly-booted server + agent on
tmp dirs, reconciled to the post-PR-#6 API with *real* role actors (no false greens),
de-flaked enough to become a **required merge gate** (after a green streak); plus a
**minimal CLI unit suite**; on a **single Node version**; with the money-path
coverage gaps closed.

## Scope

**In:** Node unification + cli dep install + the better-sqlite3 dual-ABI decision;
de-hardcoding all scenario literals (incl. dynamic `import()`/`execSync` strings and
the `run.mjs` entrypoint); an in-repo agent shim + sample fixture; the
server+agent+tmp-DB harness; reconciling the suite to a documented green baseline
(non-access subset first; access/cap re-architecture tracked as its own work);
de-flaking/isolation; money-path coverage additions; a minimal CLI unit suite; CI wiring.

**Out (tracked elsewhere):**
- **sig/protocol consolidation → Sub-project 2.** Safe to split: no `scenarios/*.mjs`
  imports `sig`/`protocol` (verified — the "protocol" matches are unrelated
  y-protocols/sync). NB this is *import-graph*-clean, not *runtime*-clean: the spawned
  agent signs/verifies at runtime, so SP2 must keep web-sign/cli-verify wire-compatible
  (HMAC sorted-keys + base64url) or this net catches it at runtime — which is the point.
- **schema codegen / single-source → drizzle-kit (migration) sub-project** (reads
  `schema.ts` natively). The schema fork does not affect this net (db.js imports
  `schema.js` directly; the suite doesn't depend on `.ts`/`.js` parity).
- Edge-security, litestream/Sentry/health, state-interface extraction (Decision 1),
  Willow cleanup (Decision 4), `web/src/` finish (Decision 5).

## Design (phased; each phase leaves the repo runnable)

### Phase 0 — Unify Node + install both packages + decide the dual-ABI hazard
- Pin **Node 22** (matches Docker `node:22`; has better-sqlite3 prebuilds). Root
  `.nvmrc`=`22`; every CI job `node-version: 22`; `web` engines `>=22`. **Leave `cli`
  engines `>=20`** (end-user package).
- **Install BOTH packages in CI.** The web vitest worker dynamically imports
  `cli/src/{willow-store,rpc,agent}.js` (cases.mjs:495/514/577/657/975/1039/1055,
  emergent:199), which need `cli/node_modules`. Add `npm --prefix cli install`
  (alongside `web`) to every job that runs scenarios; add a setup smoke
  (`node -e "import('./cli/src/willow-store.js')"` and `require('better-sqlite3')` in
  *both* packages) so a missing dep/prebuild fails at install, not mid-suite.
- **DECIDED (was O2): resolve the two-ABI-in-one-process hazard.** `web` pins
  `better-sqlite3@^11` (loaded by the worker at cases.mjs:10 `new Database()`); `cli`
  pins `^12` (loaded into the *same* worker by the dynamic imports above). Two native
  N-API ABIs of the same addon in one process can segfault ("module did not
  self-register") — fatal for a required gate. Resolution (pick in writing-plans, both
  in-scope): **(a) align `cli` to `better-sqlite3@^11`** (simplest, one-line dep
  change + reinstall), or **(b) run the willow-store/rpc in-process cases in a child
  process** so the ABIs never co-load. Default lean (a) unless cli needs a v12-only API.

### Phase 1 — Make the suite runnable from a clean checkout
1. **De-hardcode every literal, in all four case files AND `run.mjs`.** Add
   `web/scenarios/paths.mjs` deriving the repo root from `import.meta.url`
   (`<root>/web/scenarios/`), overridable by `AINDRIVE_REPO_ROOT`. Derive `SAMPLE`
   (in-repo fixture), the cli-src dir for the dynamic `import()`s, `tools/diagnose.mjs`
   (trace:62, emergent:63), `docs/TEST_SCENARIOS.md` (run.mjs:12). **Rewrite the
   template-string `import()`/`execSync` literals too** (cases.mjs:495/514/975/1039/1055,
   emergent:199, trace:62), not just the top-of-file `BASE`/`WS_BASE`/`SAMPLE` consts.
   Decide whether `run.mjs` (a second entrypoint with its own `/mnt` path at run.mjs:12)
   stays supported (de-hardcode + a real green run) or is deprecated — don't half-fix it.
2. **Create the missing agent launcher.** The suite spawns
   `spawn('node',['start-agent.mjs'],{cwd:SAMPLE})` (cases.mjs:124/161/1084,
   collab:452) but `start-agent.mjs` is absent. Add a committed shim that reads
   `<SAMPLE>/.aindrive/config.json` and calls `runAgent({root, drive, server:
   drive.serverUrl})` from repo-relative `cli/src/agent.js` — proven to work: `runAgent`
   signature is `{root,drive,server}` (agent.js:61), `cli/src/commands/serve.js:48`
   uses exactly it, and cases.mjs:1039 already inlines the same pattern. The token comes
   from `ensureDrive()` POSTing `/api/drives` (createDrive returns
   `{driveId,agentToken,driveSecret,serverUrl,url}`, drives.ts:48-54) and persisting
   `config.json` with `serverUrl` overridden to BASE; agent auth needs only Bearer
   agentToken + driveId (agents.js:69-89). Standardize both spawn sites on the shim.
3. **In-repo sample fixture** under `web/scenarios/fixtures/sample/` with at least a
   `docs/` subdir (case #45 asserts it); generate per-run content in tmp where exact
   bytes don't matter (default), commit a fixture only where a case asserts exact bytes.

### Phase 2 — The e2e harness (server + agent + tmp DB lifecycle)
A vitest `globalSetup` (or CI wrapper) that:
1. **Picks a free port itself** (bind a throwaway `net.Server` to `:0`, read
   `.address().port`, close) — `PORT=0` is NOT discoverable from `server.js`
   (server.js:19 binds the configured `PORT` and the listen callback never reads
   `server.address().port`). Then spawns `node server.js` with the **server-process
   env**: `PORT=<free port>` (mandatory), `AINDRIVE_DATA_DIR=<tmp>` (mandatory),
   `AINDRIVE_DEV_BYPASS_X402=1` (mandatory — captured as a module-load const at
   s/[token]/route.ts:19, so it must be in the *server* env at boot). **Run in dev
   mode** (no `NODE_ENV=production`): boot-checks are a verified dev no-op
   (boot-checks.js:8 returns early when `NODE_ENV!=="production"`), and `env.ts`
   auto-creates the session secret (env.ts:13-21) and defaults `publicUrl` to
   `http://localhost:${PORT}` (env.ts:26-29) — so `AINDRIVE_SESSION_SECRET` /
   `AINDRIVE_PUBLIC_URL` / `AINDRIVE_PAYOUT_WALLET` are **optional in dev** (pin only
   for determinism, NOT because boot-checks demand them).
2. **Set `AINDRIVE_DATA_DIR` + `BASE`/`WS_BASE` in BOTH the spawned server env AND the
   test-runner env.** `dbHandle()` (cases.mjs:166-170) opens the server's sqlite from
   the *runner's* `AINDRIVE_DATA_DIR`; if only the server gets it they silently diverge
   onto different DBs. Also: a committed-but-gitignored `web/.env.local` hardcodes
   `AINDRIVE_DATA_DIR`/`AINDRIVE_DEV_BYPASS_X402` on the dev box (absent in CI), and
   explicit `process.env` wins over it (load-env.js) — so the harness must pass these
   **explicitly** to override `.env.local` locally.
3. **Install + boot the agent, then poll readiness correctly.** `npm --prefix cli
   install` (Phase 0) must have run. Poll `GET /readyz` → 200 first (server+DB up; it
   gates on `uptime>=2` + a `SELECT 1`, so it 503s for ~2s — **retry past the window,
   don't bail on first 503**; a 200 also guarantees `data.sqlite` exists so
   `dbHandle()`'s readonly open won't ENOENT). THEN confirm the agent paired via
   `GET /api/drives` (`isOnline`) or `/healthz` `agentsConnected` (healthz:7-11, fed by
   `globalThis.__aindrive_agent_map`) — `/readyz` has **no** agent awareness.
4. **Teardown that doesn't orphan.** Capture PIDs from `spawn()` handles (not
   `ps|grep`). Existing spawns use `{detached:true}.unref()`, so kill the process group
   (`process.kill(-pid)`) or spawn non-detached (children die with parent), SIGTERM→
   SIGKILL, in a guaranteed `try/finally`. Cover the **per-case** detached agents (#92
   cases.mjs:1038, collab:449), not just the globalSetup SAMPLE agent — add an
   afterEach/teardown sweep so a thrown case doesn't leak node agents across CI runs.

### Phase 3 — Reconcile the suite to a documented GREEN baseline
This is the spec's largest unknown and is a **multi-day re-architecture, not a route
swap.** Restructure into three parts; the required gate (Phase 7) uses 3b's baseline,
while 3c lands incrementally.

- **3a — Mechanical RED inventory (all four files).** Grep all of `web/scenarios/*.mjs`
  for PR-#6-removed surfaces — `/api/drives/[driveId]/access`, `folder_access`, the
  free-share `aindrive_share` cookie, `shares.password_hash`, removed columns — and
  produce an **enumerated PORT / DELETE / REWRITE table** with the target route for
  each. Known so far: cases ~56-65 (access/role gating), 76-80 (cap-verify),
  trace-cases.mjs:339 (hits deleted /access), case 90 (cases.mjs:999, depends on
  deleted #58's grant), case 138 (false-green on trace-dump assert). The table is the
  deliverable; effort can't be measured until Phases 1-2 let the suite boot.
- **3b — Get the NON-ACCESS subset green = the gate baseline.** The bulk (yjs/collab
  convergence, DocHub gating, share-create, x402 settle, trace, willow-sync) is green
  once Phases 1-2 land. Establish and **document** this baseline; the required gate
  (Phase 7) is built on it so the net ships without waiting on the hardest archaeology.
- **3c — Re-architect the access/cap actors (tracked, lands incrementally).**
  - **Identity model (the hidden cost):** the surviving role gate resolves by
    `users.id` (require-access.ts:34 → `resolveRoleByUser` on `drive_members.user_id`).
    The suite's access actors are **wallet-only** (`loginWallet`→`/api/wallet/verify`
    sets a wallet cookie, **no users row, no session** → `getUser()===null` →
    unconditional 401). So porting 56-65 is **not** a grant-mechanism swap — every
    access actor must be rebuilt as an **email-signup user invited via `POST
    /api/drives/[driveId]/members`** (or CONSUME via `POST /api/s/[token]/accept`,
    accept/route.ts:60-64), all behind the same `resolveRoleByUser` gate.
  - **False-green bar:** cases 59/62/63 currently pass because wallet=no-session, not
    because of role logic. Each ported *denial* case MUST use a real lower-privilege
    user (e.g. a viewer invited via `/members`) so a privilege-escalation regression
    actually fails. A baseline built on session-absence is worthless.
  - **PORT (not delete) the cap cases 76-80:** they verify Meadowcap caps against
    `/api/cap/verify` (still exists). Obtain the cap from the DEV_BYPASS paid-accept GET
    (`body.cap`, s/[token]/route.ts:280-295 `issueShareCap`) and feed `/api/cap/verify`;
    prereqs: the drive's willow namespace must be provisioned (78/79 need `ns.pub`),
    only read-caps are obtainable, case 80 needs two settles.
  - **DELETE** only the genuinely dead wallet-allowlist-specific cases (a subset of
    56-65), preserving role-gating intent via the ported users.

### Phase 4 — De-flake & isolate (for a required gate)
Per-run tmp `AINDRIVE_DATA_DIR` (Phase 2). Replace fixed sleeps (`sleep(3500)` post-
spawn, `800-1000` for convergence) with poll-until-ready. **`next({dev:true})` compiles
routes on first hit** — a `/readyz` 200 doesn't mean a route is warm; warm the key
routes after readyz or keep generous first-case timeouts so de-flaking doesn't trade
sleeps for compile-flakes. The suite shares one mutable `state` across all 151 cases
and runs serial (`fileParallelism:false`); per-run isolation removes cross-run
contamination but not intra-run order-fragility (e.g. `walletA/walletB` reused by SIWE
cases 14-17/25/90). State the isolation contract explicitly: pin order + a guard test,
or accept order-coupling as tracked debt. Measure wall-clock; decide required-fast-
subset + nightly-full vs full-required. **Required only after a documented green streak.**

### Phase 5 — Close the money-path coverage gaps
Add cases (runnable in this harness via the live server + DEV_BYPASS settle + a
logged-in account): (a) `POST /api/s/[token]/accept` free CONSUME → `drive_members`
row; (b) paid settle → `payment_receipts` row; (c) replay same `tx_hash` → no duplicate;
(d) `mergeRoleUpgradeOnly` — a covering higher grant is not downgraded. These need a
real session user (see Phase 3c identity model), so sequence after 3c's actor helpers.

### Phase 6 — Minimal CLI unit suite
Add vitest to `cli/` + tests for: `safeResolve` traversal rejection; HMAC sign/verify
**including a cross-package web-sign/cli-verify check** (this is the only net for cli,
which has no typecheck); `handleRpc` dispatch (rpc.js:120-261 — write/rename/delete +
rename-root/delete-root guards); `isSelfWrite` TTL; and willow-sync's four pure
functions (`buildSummary`/`digestsWeMissFrom`/`fulfillWant`/`applyGive`). Wire into the
CI `cli` job.

### Phase 7 — Wire into CI
Add the e2e job (Phase 2 harness, both packages installed) + the cli-test step. Per
Phase 4's measurement: required fast subset (3b baseline) on every PR, full live suite
nightly. Mark required only after the green streak.

## Sequencing
0 (Node+cli install+ABI) → 1 (runnable) → 2 (harness) → 3a (inventory) → 3b (non-access
green = baseline) → 4 (de-flake) → 7-partial (gate on 3b) → 3c (access/cap re-arch,
incremental) → 5 (money coverage, needs 3c actors) → 6 (cli unit). 3c + 5 land
incrementally into an already-required 3b gate.

## Edge cases / risks
| risk | mitigation |
|---|---|
| Suite RED on current code | Phase 3a inventory + 3b green baseline before gating; 3c re-arch tracked |
| `start-agent.mjs` absent | Phase 1.2 repo-relative `runAgent` shim (proven pattern) |
| Boot-checks/env wrong (dev no-op) | Phase 2.1: only DATA_DIR+PORT+DEV_BYPASS required; others auto-fallback |
| PORT=0 undiscoverable | Phase 2.1: harness picks free port, passes PORT=<it> |
| dbHandle opens wrong DB | Phase 2.2: AINDRIVE_DATA_DIR in BOTH server + runner; override .env.local |
| cli deps missing → MODULE_NOT_FOUND | Phase 0: `npm --prefix cli install` + setup smoke |
| two better-sqlite3 ABIs in one process | Phase 0 decided: align cli to ^11 OR subprocess the in-process cases |
| false-green denial cases | Phase 3c: real lower-privilege users, not session-absence |
| flaky/ slow required gate | Phase 4 poll-until-ready + warm + isolation + green-streak; fast-subset+nightly |
| orphaned agent processes | Phase 2.4 kill process group, cover per-case spawns |
| next-dev first-compile latency | Phase 4 warm routes / generous first-case timeouts |

## Open items (defaulted)
- **O1 — required scope:** fast-subset(3b)-required + nightly-full vs full-required.
  Default: decide after Phase 4 measures; lean fast-subset+nightly if full > ~3 min.
- **O2 RESOLVED → Phase 0** (dual better-sqlite3 ABI: align cli to ^11 default).
- **O3 — fixture committed vs generated:** default generate-in-tmp; commit only where a
  case asserts exact bytes (the `docs/` subdir for #45).
- **O4 — `run.mjs` entrypoint:** default deprecate unless a green run is demonstrated.

## Verification
Per phase: `npm --prefix web run typecheck` + `npm --prefix web test` (lib) stay green;
Phase 2 harness boots locally; Phase 3b non-access subset **green locally (documented)**;
Phase 6 `cli` tests green; Phase 7 CI e2e + cli jobs green. All under Node 22. The gate
becomes required only on the documented 3b baseline; 3c/5 cases join as they go green
with real role actors.

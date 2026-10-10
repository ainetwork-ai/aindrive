# Deploy runbook

How to ship a release of the web app, with a focus on the **mainnet payment
go-live** (the part with real-money footguns). For the Docker/container
mechanics and multi-engineer build coordination (the build lock, nginx
front-door, volumes), see [`DOCKER_PUBLISH_GUIDE.md`](DOCKER_PUBLISH_GUIDE.md);
this runbook is the release/payment layer on top of it. For the tag + GitHub
Release convention after a deploy (`web-YYYY.MM.DD`), see
[`RELEASING.md`](RELEASING.md).

> **The normal way to ship is to merge to `main`.** You do not run a deploy
> command — merging a PR to `main` deploys itself (see below). The by-hand
> paths further down are for debugging a failed auto-deploy or for a release
> you want to drive step by step.

## Automatic: merge to `main` ships it (recommended)

**Merge a PR into `main` and it goes live on its own — no deploy command.**
On the lab host, cron runs `/mnt/newdata/git/.autodeploy/autodeploy.sh aindrive`
every 2 minutes. When `origin/main` moved and something under `web/` changed, it
checks the commit out in its own clean worktree (`/mnt/newdata/git/.autodeploy/aindrive`,
`web/.env.production` symlinked from the main checkout) and runs
`scripts/deploy.sh --no-pull` — the same gates, rollback snapshot, health check
and `web-YYYY.MM.DD` Release as by hand. A merge is live within ~2 min plus the
build. A failed deploy is retried with exponential backoff (2, 4, 8, 16, 32 min;
given up after 6 failures until the next merge); `rm ~/.autodeploy/aindrive.retry`
retries now. Rollback snapshots (`aindrive-web:predeploy-*`) are pruned to the
newest 5. Log: `~/.autodeploy/aindrive.log`.

If nothing under `web/` changed (docs, `cli/`, `mobile/`, other packages), the
poller advances the deployed marker without rebuilding — so such a merge is
"deployed" instantly and the site is untouched.

## By hand (`scripts/deploy.sh`)

Reach for this to debug a failed auto-deploy, or to drive a mainnet release
step by step. It is the same script the poller runs.

```bash
scripts/deploy.sh            # pull origin/main → gated build → swap → tag + Release
DRY_RUN=1 scripts/deploy.sh  # build + verify only (no swap, no tag)
scripts/deploy.sh --no-pull  # deploy the current checkout as-is
```

`scripts/deploy.sh` encodes the manual recipe below as **fail-fast gates** — it
refuses to deploy on lockfile drift, a non-mainnet / non-https / DEV_BYPASS-on
`.env.production`, an empty WalletConnect id, or an image that didn't actually
bake `mainnet`; it snapshots the old image for rollback, health-checks through
the recreate 502, and cuts the `web-YYYY.MM.DD` tag + Release. The manual steps
below are what it runs — reach for them to debug or to deploy by hand.

## TL;DR (mainnet release)

```bash
# on the deploy host, in the repo
git pull --rebase origin main

# ONE gitignored file holds everything — build vars + runtime secrets.
# (see web/.env.example for the field reference)
$EDITOR web/.env.production   # mainnet, CDP keys, SESSION_SECRET, https URL, DEV_BYPASS=0,
                             # NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK=mainnet, (optional) WC id

# build — --env-file points Compose's ${...} interpolation (the NEXT_PUBLIC_*
# build args) at .env.production; it defaults to .env. (Runtime secrets load via
# env_file: by literal path and need no flag — see "What runs where".)
cd web
flock /tmp/aindrive-build.lock sudo docker compose --env-file .env.production -f docker-compose.yml up -d --build

# smoke: one SMALL real purchase, confirm it settles + shows in Settings → Sales
```

## What runs where

The container uses **one** gitignored file, `web/.env.production`, for both
stages — but via two different Compose mechanisms:

- **Runtime secrets** (CDP keys, SESSION_SECRET, …) load through the service
  `env_file: ./.env.production`. This is a literal path — it works with **no
  flag**.
- **Build args** (`NEXT_PUBLIC_*`, inlined into the client bundle) are filled by
  Compose's `${...}` interpolation, which defaults to a file literally named
  `.env`. To source them from `.env.production` you **must** pass
  `--env-file .env.production` (or `export COMPOSE_ENV_FILES=.env.production`).
  Skip it and the bundle silently bakes the testnet defaults.

Only `web/.env.example` (the field reference) is committed. Local dev that runs
`node server.js` directly uses `web/.env.local` (via `@next/env`) — a separate
path from the container. Host/container/nginx/volume layout: see
DOCKER_PUBLISH_GUIDE.

> **If you already have a `web/.env.production`** from before: add the
> `NEXT_PUBLIC_*` lines you used to pass on the shell into it, and start using
> `--env-file .env.production` on the build command. Remove any stray bare
> `web/.env`. (Forgetting the secrets fails loud — the SESSION_SECRET boot
> check exits rather than running insecure.)

## Env that matters for payments

Field reference with defaults is `web/.env.example`. For a mainnet release the
load-bearing ones:

| Var | Mainnet value | Why it bites |
|-----|---------------|-------------|
| `NEXT_PUBLIC_WC_PROJECT_ID` | set (free, cloud.reown.com) | **Build-time inlined** (same rule as the network var below — lives in `.env.production`, read at build via `--env-file`). Empty = every WalletConnect relay flow breaks: mobile-browser visitors paying with a wallet APP get an infinite spinner. Desktop extensions and Base Account don't need it. |
| `NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK` | `mainnet` | **Build-time inlined.** A runtime-only change leaves the *browser bundle* on testnet while the server is on mainnet (split-brain). Put it in `web/.env.production` and rebuild **with `--env-file .env.production`** (Compose interpolates the build arg from there only with that flag) — a restart alone is not enough. |
| `AINDRIVE_DEV_BYPASS_X402` | `0` (or unset) | `=1` skips on-chain verification — payments "succeed" without money moving. Never on mainnet. (Boot check refuses to start prod with it on.) |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | set | The Coinbase CDP facilitator that settles mainnet payments. Without them mainnet refuses with 503 (no safe default). |
| `AINDRIVE_AGENT_WALLETS` | `0` (or unset) | `=1` keeps a custodial agent wallet per account and lists the `x402_wallet` / `x402_sign` / `x402_settle` MCP tools (web/app/mcp/README.md). Only when you mean to let agents spend. |
| `AINDRIVE_X402_FACILITATOR` | **unset** | An explicit URL takes precedence over the CDP keys — setting it (e.g. to x402.org) makes CDP be ignored and mainnet settles fail. Leave unset when using CDP. |
| `CDP_PAYMASTER_URL` | set for gasless FANCO buys | ERC-7677 paymaster RPC (CDP Portal → Paymaster, Base endpoint). Sponsors smart-wallet buyers' permit2 `approve` gas so a buyer holding only the sale token can pay. **Configure the CDP-side contract allowlist (the token) + spend caps too** — the app's `/api/paymaster` proxy validates each op, the portal policy is the budget backstop. Unset = buyers pay their own approve gas (works, but needs ETH). |
| `AINDRIVE_SESSION_SECRET` | 32+ random bytes | Required in prod (no file fallback). `openssl rand -hex 32`. |
| `AINDRIVE_PUBLIC_URL` | `https://…` | Must be https; secure cookies refuse plain http. |
| `AINIZE_URL` | `https://ainize.ai` | The ainize host whose `POST /api/run` executes a repo file for the drive UI's ▶ Run (`web/lib/run-ainize.ts`); also where a pushed repo with `ainize.json` is bound to a project (`/api/projects/auto`, as aindrive) and where "Open in ainize" goes (the bound project's page; hidden while there is none). While that endpoint is not deployed, runs show "runner unavailable" (ainize 503) and nothing else changes. |
| `AINDRIVE_GOOGLE_CLIENT_IDS` | `web-id.apps.googleusercontent.com[,…]` | Optional: enables Google sign-in (`/api/auth/google`). First id = the **Web** OAuth client the mobile app requests ID tokens for; the Android OAuth client (package `ai.ainetwork.aindrive` + signing SHA-1) must exist in the same Google Cloud project. Unset → the route returns 404 and the app falls back to browser sign-in. |
| `AINDRIVE_SSO_ISSUER`, `AINDRIVE_SSO_CLIENT_ID` | **unset** (AIN SSO off) | Together: the AIN SSO provisioning adapter (`{AINDRIVE_PUBLIC_URL}/api/sso`) and back-channel logout (`/api/auth/sso/backchannel-logout`) go live; nothing else changes. Issuer must be https. See `web/lib/sso/README.md`. |
| `AINDRIVE_SSO_CLIENT_SECRET`, `AINDRIVE_SSO_ENABLED` | **unset** / `false` | With both (and the two above), `/login` shows "Continue with AIN" (redirect URI `{AINDRIVE_PUBLIC_URL}/api/auth/sso/callback`). `ENABLED=false` is the rollback: legacy logins work again, suspensions stay. The secret alone (with issuer + client id) also gives aindrive its **machine identity**: after a push of a repo whose root has `ainize.json`, aindrive binds it to an ainize project as itself (`web/lib/sso/service-token.ts` → AIN SSO `client_credentials` for `resource=<AINIZE_URL>` → `POST ${AINIZE_URL}/api/projects/auto`; `web/lib/git-project-hooks.ts`). AIN SSO must list the ainize origin in `AIN_SSO_SERVICE_RESOURCES` and ainize must list `aindrive` in `AIN_SSO_SERVICE_APPS`; without the secret nothing binds (logged) and pushes still succeed. |
| `AINDRIVE_LEGACY_LOGIN` | `true` | `unlinked_only` (AIN-linked accounts must use AIN) or `false` (no password/Google/wallet sign-in, signup or email reset). Applies only while `AINDRIVE_SSO_ENABLED=true`. With SSO on, `true` shows "Sign up with AIN" next to the legacy sign-up; any other value makes sign-up go to AIN SSO (`prompt=create`). A mistyped value fails the boot. |
| `AINDRIVE_SSO_SILENT` | **unset** (on while SSO login is enabled) | `false` turns off only the automatic sign-in check (a page visit without a session goes once per 30 min to AIN SSO with `prompt=none`; `web/lib/sso/silent.ts`) — also the first step of an OAuth authorization request's sign-in (`/oauth/authorize`, `web/lib/oauth-authorize.ts`). |
| `AINDRIVE_SSO_ATTEST`, `AINDRIVE_SSO_ATTEST_EMAIL_DOMAINS` | **unset** (on with the client secret) / `comcom.ai` | After a legacy sign-in aindrive reports the Google `sub` (Google) or a company address it verified by email code (password) to AIN SSO (`/api/upstream/app-attest`), so the AIN account links to it. `ATTEST=false` = off; domains comma-separated or `none`. |
| `AINDRIVE_ORG_SHARE_ALLOWLIST` | **unset** (only org admins share) | Organization drives (`docs/PERMISSIONS.md` "Organizations"): a drive's creator may share it with an AIN SSO organization from its Manage page when AIN SSO makes them that org's admin (app role `admin`/`owner`). This comma-separated list also allows named people: `<org slug or id>:<aindrive user id or AIN subject>` — stable ids, never an email; a malformed entry fails the boot. Read per request. The operator script (below) needs no allowlist. |
| `AINDRIVE_SSO_SERVICE_APPS` | **unset** (no machine tokens) | Comma-separated AIN SSO client_ids of first-party applications allowed to act **as themselves** here (`web/lib/sso/service-principal.ts`): a bearer that is an AIN SSO `client_credentials` JWT (`typ at+jwt`, `aud` = `AINDRIVE_PUBLIC_URL`, `sub` = `azp` = a listed client_id, signed by the issuer's JWKS) makes the caller a **viewer** on the drives shared with an organization the application is assigned in (the token's `orgs`), on git upload-pack (`/api/drives/<id>/git/…` and `/<org>/git/<repo>`) and `git-meta` only — never editor/owner, never `.aindrive/`, a push is 403, every read is logged. This is how ainize-node clones a project's repository when a push hook fires (ainize-node `docs/PROJECTS.md`); AIN SSO must list this host in `AIN_SSO_SERVICE_RESOURCES` and the application must be assigned to the organization. Needs `AINDRIVE_SSO_ISSUER` + `AINDRIVE_SSO_CLIENT_ID`. Read per request. |
| `AINDRIVE_TRUSTED_OAUTH_CLIENTS` | **unset** (every app gets the consent screen) | Comma-separated `<client_id>=<scope>+<scope>` entries — the OAuth `client_id`s of the operator's own apps, each with its scope ceiling (required; `wallet:pay` and `drives:sell` may not be listed: they always need consent). A person signed in **through AIN SSO** opening such an app's valid authorization request (registered `redirect_uri`, which must be https; PKCE S256; scopes within the ceiling; the `login_hint` subject, if sent) gets the code without the consent screen — recorded like a click on Allow; a password/Google/wallet session still gets the screen. An anonymous visitor of such a request is signed in through AIN SSO (silent check, then AIN's sign-in; `/login` after a sign-out). A listed client is never garbage-collected. AIN Teams production: `aind_client_RLq7PUwle30nN4ePhOlVmg=profile+drives:read`. Needs AIN SSO login on; read per request (a restart applies a change); a malformed entry fails the boot. See `web/app/mcp/README.md` "Trusted first-party clients". |
| `AINDRIVE_DEFAULT_DRIVE_LIMIT` | **unset** (unlimited) | Positive integer caps drives per account (`POST /api/drives` → 429 `drive_limit_reached`). Every shared folder is a drive, so a low cap bites phone users first. |
| `AINDRIVE_UNLIMITED_OWNERS` | **unset** (every owner capped by tier) | Comma-separated user ids and/or wallet addresses. Drives whose owner is listed (by id, or by any wallet linked to the owner's account) skip the per-owner file-count cap: free 1,000 / pro 100,000 files summed over all of that owner's drives, counted on every write path (browser, MCP PAT, account token). Set it for an app's operator account that stores many users' files in one drive through a PAT. Read per request; a restart applies it. |

**Payout wallets are NOT an env var.** Each drive owner sets their own payout
wallet in Settings → Payments; a paid share can't be created until they do.
There is no deployment-wide payout fallback (it would misroute funds in a
multi-tenant drive).

## Organization drives (AIN SSO)

A company folder every employee sees (e.g. ComCom's) is an ordinary drive that
its owner — an **active member** of the organization — serves with the aindrive
agent, shared with the organization. Model: `docs/PERMISSIONS.md`
"Organizations". Needs the AIN SSO adapter live (`AINDRIVE_SSO_ISSUER` +
`AINDRIVE_SSO_CLIENT_ID`) and AIN SSO to have provisioned the organization's
members (their rows are in `sso_memberships`).

1. Serve the folder from the owner's account (e.g. `kimminhyun@comcom.ai`): on
   the host that holds it, run `aindrive` in that folder signed in as that
   account. Its drive id is the `<id>` in `/d/<id>`.
2. Bind it to the organization, in the running web container
   (`aindrive-web-1`; the image ships `scripts/org-drive.mjs`):

   ```bash
   sudo docker exec aindrive-web-1 node scripts/org-drive.mjs orgs                    # organizations + their drives
   sudo docker exec aindrive-web-1 node scripts/org-drive.mjs share --drive <id> --org comcom                  # viewer (default)
   sudo docker exec aindrive-web-1 node scripts/org-drive.mjs share --drive <id> --org comcom --role editor    # or change the role
   sudo docker exec aindrive-web-1 node scripts/org-drive.mjs list --drive <id>
   sudo docker exec aindrive-web-1 node scripts/org-drive.mjs unshare --drive <id> --org comcom
   ```

   `--org` takes the slug or the org id (`--issuer` if two issuers know it).
   `share` refuses when the drive's owner is not an active member of that
   organization — the share would stay paused — unless `--force`. Every change
   takes effect at once (access is read per request, no restart) and is recorded
   in `sso_audit` with actor `operator`. The script runs in its own process, so
   the server notices a lowered role or an unshare on doc sockets already open
   by itself: a member's next edit is refused and their socket closed at once,
   and a socket that only reads is closed within 5 s (every HTTP call is
   refused at once). The drive's owner can do the same from the drive's Manage
   → Members → Organizations card when they are the org's admin or
   allowlisted (`AINDRIVE_ORG_SHARE_ALLOWLIST`); a creator who is neither is
   told to ask the operator — this script.
3. Members see it: the signed-in home lists the organization first, and an AIN
   sign-in lands on its drive on a person's first sign-in or while they have no
   personal drive of their own.

## Repositories in a drive (bare remote + working copy)

A repo in a drive is two folders under `repositories/` (`web/lib/git-paths.ts`,
`cli/src/rpc.js` layout note): `repositories/<repo>.git` is the **bare remote**
every clone/push targets — `https://<host>/<org>/git/<repo>` and
`git@<host>:<org>/<repo>` both mean it — and `repositories/<repo>/` is the
**working copy** (`origin = ../<repo>.git`) that the drive shows and edits, that
▶ Run executes, and that the git panel commits (VS Code-like Source Control:
stage/unstage/discard, commit staged or all). After a push lands in the bare, the
agent fast-forwards the working copy **only if it is clean**; a dirty copy is
left alone and the panel shows it behind with a Pull (ff-only) button. A commit
in the panel deploys nothing; **Push** (working copy → bare) is the deploy
trigger and fires the ainize project hook exactly like a push over HTTP/SSH.
The browser pages `/<org>/git/<repo>[/tree|blob|raw|commits|commit|deployments/…]`
(`web/lib/git-urls.ts`) show the working copy at the checked-out branch and the
object store (read-only) at any other ref. A repo made before this layout (one
non-bare `updateInstead` directory) is still cloned from and shown with a
"migrate" hint; `node scripts/migrate-repo-layout.mjs <drive root> <repo>` on
the agent's machine splits it in place without losing history or edits.

## Git over SSH

`git clone git@aindrive.ainetwork.ai:<org-slug>/<repo>` / `git push …` reach an
SSH server that runs **inside the web container** (`web/ssh-server.ts`,
started by `server.js`; docs in `web/lib/git-ssh/server.ts`). It listens on
`AINDRIVE_SSH_PORT` (2222) and Compose publishes it on **loopback only**
(`127.0.0.1:2222`), the same way the HTTP port is published on `3738`. Nothing
in the repo binds port 22: the host's front door does, and that is operator
work outside this repo.

What it needs in `web/.env.production`:

- `AINDRIVE_SSO_ISSUER`, `AINDRIVE_SSO_CLIENT_ID`, `AINDRIVE_SSO_CLIENT_SECRET`
  — the SSH server asks AIN SSO which account owns an offered key
  (`GET {ISSUER}/api/apps/ssh-keys/lookup?fingerprint=SHA256:…`, app-authenticated
  with these credentials; `web/lib/sso-ssh-keys.ts`). **Without all three the
  SSH server logs a warning and does not start**; HTTP git keeps working.
- `AINDRIVE_SSH_PORT` (default 2222; `0` turns it off), optional
  `AINDRIVE_SSH_HOST_KEY_PATH` (default `/data/ssh_host_ed25519_key`).

The Ed25519 host key is generated on first start into `/data` (the volume), so
it survives redeploys. Back it up with the DB ("Backup and restore"): a new host
key makes every user's `known_hosts` entry fail. Publish its fingerprint
(`docker compose exec web cat /data/ssh_host_ed25519_key.pub`) where users can
check it.

### Exposing port 22 → container 2222

Pick ONE; both keep sshd (the host's own SSH) untouched.

**A. nginx `stream` block** (the host already runs nginx for TLS). sshd must
not be listening on the public IP's port 22 — move the host's sshd to another
port or bind it to a management address first, or git over SSH and host
administration fight for the same socket.

```nginx
# /etc/nginx/nginx.conf — top level, next to the `http {}` block (NOT inside it)
stream {
    upstream aindrive_git_ssh { server 127.0.0.1:2222; }
    server {
        listen 22;                 # add `listen [::]:22;` for IPv6
        proxy_pass aindrive_git_ssh;
        proxy_connect_timeout 10s;
        proxy_timeout 10m;         # ≥ the 300 s per-exec cap, plus slow clients
    }
}
```

`nginx -t && systemctl reload nginx`. The server sees connections from
127.0.0.1 (nginx); per-IP rate limiting, if wanted, belongs in this block
(`limit_conn`), not in the app.

**B. Port forward** when nginx should stay HTTP-only:

```sh
# IPv4 DNAT, persistent via your firewall tooling (ufw before.rules / nftables)
iptables -t nat -A PREROUTING  -p tcp --dport 22 -j REDIRECT --to-port 2222
# traffic from the host itself to its own :22 (optional)
iptables -t nat -A OUTPUT -o lo -p tcp --dport 22 -j REDIRECT --to-port 2222
```

and change the Compose publish from `127.0.0.1:2222:2222` to `2222:2222` in a
`docker-compose.override.yml` (REDIRECT delivers to the host's interface, not
loopback). With B, the host's sshd must likewise move off port 22.

**Keep port 22 for sshd instead?** Then publish git on another port and tell
users `ssh://git@aindrive.ainetwork.ai:2222/comcom/repo` — clone URLs lose the
short scp-like form, nothing else changes.

### Checks

```sh
ssh -T git@aindrive.ainetwork.ai                 # "aindrive: only git-upload-pack … available" → wired up
git ls-remote git@aindrive.ainetwork.ai:comcom/some-repo
docker compose logs web | grep '"\[git-ssh\]'  # one line per exec: user, drive, repo, svc, bytes, ms, exit
```

Authentication is **public key only**, user `git`, keys registered at AIN SSO;
the drive gate is the same one HTTP uses (clone needs viewer, push needs editor
on the repo path; `.aindrive/` is refused). A push to a path with no repo
creates one (non-bare, `updateInstead`), as over HTTP.

## CDP facilitator — verified facts (2026-06)

Checked against a live `getSupported()` call with the prod CDP key:

- **Base mainnet (`eip155:8453`) is supported** for x402 v2 `exact` — the path
  USDC and permit2 tokens settle through.
- **CDP pays the settle gas** (the facilitator's job). You do **not** fund the
  CDP account with ETH; CDP bills per-tx ($0.001, 1,000/mo free).
- The CDP "Verify your business to go live with payments" banner does **not**
  block facilitator verify/settle — an authenticated `getSupported` succeeds
  without it. (That banner gates other CDP products, not x402.)
- `eip2612GasSponsoring` extension is available (future: make the buyer's
  one-time approve gasless too).
- **Custom permit2 tokens (e.g. FANCO):** `/supported` only advertises
  scheme×network, not per-token. `exact` on mainnet is open, so permit2
  settlement should work, but **confirm with a small real purchase** in that
  token before relying on it — USDC is the certain path.

## Go-live order (do NOT reorder)

1. `git pull` — confirm the deploy host is at the intended commit.
2. Fill `web/.env.production` (gitignored) — the one file for everything.
   Double-check `DEV_BYPASS=0`, `AINDRIVE_X402_FACILITATOR` unset, https URL,
   CDP keys present, and `NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK=mainnet`.
3. Build under the build lock **with `--env-file .env.production`** (see TL;DR) —
   that flag is what makes Compose read the `NEXT_PUBLIC_*` build args from it.
   A restart alone is NOT enough; the client bundle is baked at build.
4. Each selling drive's owner sets a payout wallet (Settings → Payments).
5. **Smoke test**: a small real USDC purchase end-to-end → settles → appears in
   Settings → Sales. For a permit2 token you intend to sell, smoke that too
   (includes the buyer's one-time on-chain approve).

## Troubleshooting

- **Payment returns 503** → mainnet with no facilitator configured. Set the CDP
  keys (and leave `AINDRIVE_X402_FACILITATOR` unset).
- **Wallet confirm popup shows the wrong network** (e.g. "Base Sepolia" while
  funds settle on mainnet) → the browser bundle was built with the wrong
  `NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK` (wagmi's default chain is baked at
  build). Settlement is server-driven so it's still correct, but rebuild per
  step 3 to fix the display. (The pay/approve flow also switches the wallet to
  the right chain before signing, so a fresh client self-corrects.)
- **Browser pays on testnet but server is mainnet** (or vice versa) → same
  build-arg cause. Rebuild per step 3.
- **Large upload fails partway** → large files go up as ≤8 MiB resumable parts
  (`fs/upload-sessions`), so proxy body caps / request timeouts no longer apply
  to them; re-dropping the same file resumes from the last confirmed byte. If
  parts themselves keep failing, the cause is the agent side (offline agent,
  full/slow agent disk — check the error toast text). The nginx sizing block in
  `PRODUCTION_TODO.md` still matters for streaming *downloads* (`fs/stream`
  video playback).
- **"set a payout wallet before selling" (400) on share create** → the drive
  has no payout wallet; owner sets it in Settings → Payments.
- **Payment "succeeds" but no funds / dev tx hash** → `AINDRIVE_DEV_BYPASS_X402`
  is `1`. Must be `0` in prod (boot check should have refused to start).
- **Wallet warns "withdraw ALL your <token>"** → shouldn't happen anymore;
  approvals are encoded for the exact sale amount, not unlimited.

## Rollback

Rebuild from the previous good commit (same build command). Data persists in
the Docker volume (`aindrive_aindrive-data`), so a code rollback doesn't touch
SQLite/Yjs state. See DOCKER_PUBLISH_GUIDE for image/volume specifics.

A rollback to a release without the change feed (before the AIN integration
routes) writes no `share_events` while it runs: after rolling forward again,
stop the container and run `scripts/after-restore.mjs` once (below) so products
re-list instead of missing the changes made in between.

## Backup and restore

What the server owns is the SQLite database in the volume (`/data/data.sqlite`:
accounts, drives, members, organization shares, share links, OAuth/account
grants, handoff grants, the change feed). **Files are not on the server** — they
stay on each owner's device, and backing them up is the owner's job (the
device's `<folder>/.aindrive/` and `~/.aindrive/` hold its drive credentials:
losing them means pairing the folder again, not losing data).

- **Back up** with SQLite's online backup while the server runs (a plain `cp` of
  a WAL database can be torn):
  `sudo docker exec aindrive-web-1 node -e 'require("better-sqlite3")("/data/data.sqlite").backup("/data/backup-"+Date.now()+".sqlite").then(()=>console.log("ok"))'`
  then move the file off the host. The session secret (`AINDRIVE_SESSION_SECRET`)
  is in the env file, not the DB — keep it with the backup or every session ends.
- **Restore**: stop the container, put the backup in place as
  `/data/data.sqlite` (remove `data.sqlite-wal`/`-shm` next to it), then **before
  starting**:
  ```
  sudo docker compose run --rm web node scripts/after-restore.mjs
  ```
  It moves the change feed past everything issued before the restore, so every
  product's cursor answers `gap: true` and the product re-lists, and later
  events outrank what products saw after the backup (lib/share-events-restore.js
  has the why). Without it a product can keep a grant the restore removed and
  drop a later revoke. Then start the container; devices reconnect by
  themselves.
- Changes made after the backup are gone (grants, shares, account tokens issued
  since): products whose refresh token was issued or rotated after the backup
  get `invalid_grant` and connect again.

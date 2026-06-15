# Deploy runbook

How to ship a release of the web app, with a focus on the **mainnet payment
go-live** (the part with real-money footguns). For the Docker/container
mechanics and multi-engineer build coordination (the build lock, nginx
front-door, volumes), see [`DOCKER_PUBLISH_GUIDE.md`](DOCKER_PUBLISH_GUIDE.md);
this runbook is the release/payment layer on top of it.

## TL;DR (mainnet release)

```bash
# on the deploy host, in the repo
git pull --rebase origin main

# ONE gitignored file holds everything — build vars + runtime secrets.
# (see web/.env.example for the field reference)
$EDITOR web/.env.production   # mainnet, CDP keys, SESSION_SECRET, https URL, DEV_BYPASS=0,
                             # NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK=mainnet, (optional) WC id

# build — --env-file points Compose's ${...} interpolation at .env.production
# (it defaults to .env). That one flag covers BOTH build args and runtime env_file.
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
| `AINDRIVE_X402_FACILITATOR` | **unset** | An explicit URL takes precedence over the CDP keys — setting it (e.g. to x402.org) makes CDP be ignored and mainnet settles fail. Leave unset when using CDP. |
| `AINDRIVE_SESSION_SECRET` | 32+ random bytes | Required in prod (no file fallback). `openssl rand -hex 32`. |
| `AINDRIVE_PUBLIC_URL` | `https://…` | Must be https; secure cookies refuse plain http. |

**Payout wallets are NOT an env var.** Each drive owner sets their own payout
wallet in Settings → Payments; a paid share can't be created until they do.
There is no deployment-wide payout fallback (it would misroute funds in a
multi-tenant drive).

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

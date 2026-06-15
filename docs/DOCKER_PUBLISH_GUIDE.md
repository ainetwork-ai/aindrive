# Docker publish guide — multi-engineer coordination

Covers rebuilding the Docker image and (re)starting the container that backs
`aindrive.ainetwork.ai`. CLI npm releases live in a separate guide:
[`cli/NPM_PUBLISH_GUIDE.md`](../cli/NPM_PUBLISH_GUIDE.md).

This server is shared. Three (or more) engineers may push code and want to
redeploy the prod container at the same time. Without coordination you get
half-built images, killed builds, and "wait, why did my deploy disappear"
surprises. Read this once, then follow the rules.

---

## Layout (the facts you need to know first)

| What | Where |
|------|-------|
| Repo | `/mnt/newdata/git/aindrive` |
| Compose file | `web/docker-compose.yml` (project name: `aindrive`) |
| Built image | `aindrive-web:latest` |
| Container | `aindrive-web-1` (host loopback `127.0.0.1:3738` ↔ container `:3737`) |
| Front-door | host nginx → `127.0.0.1:3738`, TLS via Let's Encrypt at `aindrive.ainetwork.ai` |
| Persistent data | Docker volume `aindrive_aindrive-data` mounted at `/data` (SQLite + Yjs) |
| Host dev server | port `3737` (someone runs `node server.js` directly — **do not kill**) |

`docker-compose.yml` is namespaced via `name: aindrive`. So all `docker compose
-f web/docker-compose.yml ...` commands resolve to the same project regardless
of where you run them from. Always pass `-f web/docker-compose.yml` or `cd web`
first.

> ⚠ `-f web/docker-compose.yml` is a path **relative to the repo root**. Run it
> from any other directory (e.g. `cli/`) and it resolves to `cli/web/...` →
> `no such file or directory`. When unsure, use the absolute path:
> `-f /mnt/newdata/git/aindrive/web/docker-compose.yml`.

> ⚠ **Set the env file for this shell before any build:**
> ```bash
> export COMPOSE_ENV_FILES=.env.production
> ```
> The prod config lives in `web/.env.production` (not `.env`). Compose's
> `${...}` build-arg interpolation defaults to a file named `.env`, so without
> this (or a per-command `--env-file .env.production`) every `--build` silently
> bakes the **testnet** client bundle. All `docker compose` commands below
> assume it is set. (Runtime secrets load via `env_file:` by literal path and
> don't depend on it — only the build args do.) Details: `docs/DEPLOY.md`.

---

## Golden rules

### 1. One build at a time. Use the lock.

Concurrent builds cost CPU and the second one will often fail with cache
conflicts or recreate containers in the middle of someone else's deploy. Use a
flock-protected wrapper — first one in wins, others wait their turn:

```bash
# acquire-or-wait, single shared lock at /tmp/aindrive-build.lock
flock /tmp/aindrive-build.lock \
  sudo docker compose -f web/docker-compose.yml up -d --build
```

If you absolutely cannot wait, use `flock -n` (non-blocking) and bail rather
than racing:

```bash
flock -n /tmp/aindrive-build.lock \
  sudo docker compose -f web/docker-compose.yml up -d --build \
  || { echo "another build in progress — try again in a minute"; exit 1; }
```

### 2. Never `pkill -f "docker.*build"`.

`pkill -f` matches any process whose command line contains the pattern. That
includes **your own** new build that you just started, plus any wrapper bash a
teammate is running. If a stuck build needs to die, find its pid first:

```bash
ps -ef | grep "compose.*build" | grep -v grep   # find it
sudo kill <pid>                                  # kill that one
```

### 3. Pull and merge before you build.

```bash
git fetch origin
git status                # clean working tree?
git log --oneline HEAD..origin/main   # anything you don't have?
git pull --rebase origin main
```

Building stale code on top of someone else's merged commits wipes their fix
the moment your image becomes the running container. Always rebase first.

### 4. Don't overlap deploys. Watch the container "CREATED" timestamp.

```bash
sudo docker compose -f web/docker-compose.yml ps
# NAME             STATUS         CREATED ...
# aindrive-web-1   Up 12 seconds  ...
```

If "CREATED" is < ~30s and you didn't trigger it — someone else's deploy is
still settling. Wait, then verify with `curl -sI https://aindrive.ainetwork.ai/`
before stacking another build on top.

### 5. Don't touch the host dev server (port 3737).

A Node process owned by `comcom` is bound to `0.0.0.0:3737` (someone's local
dev). The container intentionally binds `127.0.0.1:3738` to avoid conflict.
If you see `bind: address already in use` on 3738, **don't** kill 3737 — find
out who owns it, ask before stopping.

```bash
sudo ss -ltnp | grep 3738
ps -p <PID> -o pid,user,cmd
```

---

## Standard build & verify recipe

```bash
cd /mnt/newdata/git/aindrive

# 1. sync
git pull --rebase origin main

# 2. build (locked)
flock /tmp/aindrive-build.lock \
  sudo docker compose -f web/docker-compose.yml up -d --build

# 3. confirm container is fresh
sudo docker compose -f web/docker-compose.yml ps

# 4. confirm the NEW container is actually serving. /api/healthz returns
#    {ok, uptime, dbOk, agentsConnected} uncached — a low uptime proves the
#    fresh container is live (a plain `/` 200 can be served by a stale one).
curl -s --max-time 8 https://aindrive.ainetwork.ai/api/healthz; echo
#    -> {"ok":true,"uptime":7.4,"agentsConnected":3,"dbOk":true}
curl -s -o /dev/null -w 'readyz: %{http_code}\n' --max-time 8 \
  https://aindrive.ainetwork.ai/api/readyz

# 5. tail logs for ~10s if something looks off
sudo docker compose -f web/docker-compose.yml logs --tail 30 web
```

If step 4 returns 5xx and step 5 shows fresh stack traces, that's your problem
to fix — don't trigger another build hoping it'll go away.

If the container is **not running at all** after `up -d` (it starts then exits),
the prime suspect is the production boot guard — see "Environment / secrets"
below. `logs` prints `[aindrive] BOOT FAILED — ...` naming the exact bad var.

---

## Build failed. Now what.

Build output is huge. Strip the ANSI color codes and grep for the actionable
message:

```bash
LOG=/tmp/aindrive-build.log
sudo docker compose -f web/docker-compose.yml build web --progress=plain \
  > "$LOG" 2>&1

sed 's/\x1b\[[0-9;]*m//g' "$LOG" \
  | grep -nB 5 -A 5 "Type error\|Failed to compile\|Module not found\|error TS"
```

Common failure modes seen in this repo:

| Symptom | Likely cause |
|---------|--------------|
| `Type error: Property 'X' does not exist on type 'DriveRow'` | added a SQLite column but didn't update the type in `web/lib/drives.ts` and the schema in `web/drizzle/schema.ts` + `schema.js` |
| `Cannot find name 'toast'` / `Cannot find name 'EditableAgent'` | new component added a reference but forgot the `import` |
| `Cannot find module '@/shared/...'` | someone moved code in/out of `web/shared/`. Imports use the `@/` alias — relative paths break in Docker |
| `ReferenceError: window is not defined` (at runtime, not build) | a module ran browser-only code at module load. Wrap in `typeof window !== "undefined"` or defer to `useEffect` |
| `bind: address already in use` for `127.0.0.1:3738` | a previous container did not shut down cleanly — `sudo docker compose -f web/docker-compose.yml down`, then bring up again |

---

## Branching strategy when more than one of us is mid-feature

Don't develop directly on `main` if someone else is too. Branch:

```bash
git switch -c <yourname>/<feature>
# work, commit
git push -u origin <yourname>/<feature>
gh pr create --fill   # or open in the browser
```

After review + merge, the **person merging** is responsible for triggering
the rebuild. Don't merge and walk away — the running container is still
on the previous commit until someone runs `docker compose ... up -d --build`.

---

## Environment / secrets (`.env.production`)

`docker-compose.yml` loads `web/.env.production` (`required: false` — the
container starts without it, but **production must have it**). It is gitignored
and lives **only on the host** at `web/.env.production`; the committed template
is `web/.env.example`. Back the live file up — it holds values that are
expensive or impossible to re-create.

> The runtime env loads here via `env_file: ./.env.production` (literal path, no
> flag). The **build args** (`NEXT_PUBLIC_*`) are separate — they need
> `COMPOSE_ENV_FILES=.env.production` / `--env-file .env.production` so Compose's
> `${...}` interpolation reads this file instead of the default `.env` (see the
> ⚠ callout under "Layout", and `docs/DEPLOY.md`).

A production boot guard (`web/lib/boot-checks.js`, run once at startup) refuses
to start the server and `process.exit(1)`s when any of these are wrong. So a
misconfigured env file shows up as a container that exits right after `up -d` —
check `logs` for `[aindrive] BOOT FAILED`.

| Variable | Enforced in prod | Why it bites |
|----------|------------------|--------------|
| `AINDRIVE_DEV_BYPASS_X402` | must **not** be `1` | `1` makes every paid (x402) share free — revenue bypass |
| `AINDRIVE_SESSION_SECRET` | set, ≥ 32 chars | missing/short = boot fails; rotating it logs everyone out. `openssl rand -hex 32` |
| `AINDRIVE_PUBLIC_URL` | must start `https://` | Secure cookies can't be set over plain HTTP |
| `AINDRIVE_PAYOUT_WALLET` | set, not all-zeros (unless bypass on) | wrong/zero address = buyers' USDC goes nowhere |

Not an env var, but the other irreplaceable secret: **`namespace_secret`** is a
per-drive key stored as a BLOB in the SQLite DB on the `/data` volume (see
`web/lib/drives.ts`). Lose `/data` and every existing share/capability becomes
unverifiable. Rebuilds keep `/data`; `down -v` **destroys** it (see Quick
reference). Full launch checklist: `docs/PRODUCTION_TODO.md`.

After editing a **runtime** value in `.env.production` (a secret — CDP keys,
SESSION_SECRET, …), recreate the container so it re-reads the file; no rebuild
needed. (A `NEXT_PUBLIC_*` change is build-time — it needs a full `--build`.)

```bash
flock /tmp/aindrive-build.lock \
  sudo docker compose -f web/docker-compose.yml up -d   # re-reads .env.production
```

---

## Database migrations

The repo uses idempotent `ALTER TABLE` statements in `web/lib/db.js` plus
the schema declarations in `web/drizzle/schema.ts` (TS) and
`web/drizzle/schema.js` (runtime). To add a column:

1. Edit `web/drizzle/schema.ts` — add the column to the table.
2. Edit `web/drizzle/schema.js` — same change (mirror).
3. Edit `web/lib/db.js` — add `"ALTER TABLE <t> ADD COLUMN <c> <type>"` to the
   idempotent ALTER list.
4. If the column appears in API responses, update the corresponding row type
   (`DriveRow`, etc.) in `web/lib/`.

Step 3 is what ships the column to the deployed SQLite file. Existing data
is preserved (the volume is not blown away on rebuild).

---

## Resetting to a known-good state

If the deployed container is broken and `git log` shows a recent
green-build commit `<sha>`:

```bash
git fetch origin
git reset --hard <sha>     # ⚠ destructive — coordinate first

flock /tmp/aindrive-build.lock \
  sudo docker compose -f web/docker-compose.yml up -d --build
```

Tell your teammates in chat **before** running `git reset --hard` on the
deploy machine. Their pending unpushed work on this checkout will be lost.

### Faster rollback — tag images by git sha

`git reset --hard` + a full rebuild takes minutes, painful while prod is down.
If you snapshot the running image under its sha **before** each deploy, you can
roll back with no rebuild:

```bash
# before deploying: tag the current good image with its sha
sudo docker tag aindrive-web:latest aindrive-web:$(git rev-parse --short HEAD)

# a deploy broke prod: point :latest back at a known-good sha, no build
sudo docker tag aindrive-web:<good-sha> aindrive-web:latest
sudo docker compose -f web/docker-compose.yml up -d   # seconds, not minutes
```

List snapshots: `sudo docker images aindrive-web`. Prune old ones with
`sudo docker rmi aindrive-web:<sha>` when disk fills.

---

## Quick reference

```bash
# bring up (build + start)
flock /tmp/aindrive-build.lock \
  sudo docker compose -f web/docker-compose.yml up -d --build

# logs
sudo docker compose -f web/docker-compose.yml logs -f web

# restart (no rebuild)
sudo docker compose -f web/docker-compose.yml restart web

# stop
sudo docker compose -f web/docker-compose.yml down

# wipe data (⚠ destroys SQLite + Yjs docs)
sudo docker compose -f web/docker-compose.yml down -v

# inspect data volume from host
sudo ls /var/lib/docker/volumes/aindrive_aindrive-data/_data
```

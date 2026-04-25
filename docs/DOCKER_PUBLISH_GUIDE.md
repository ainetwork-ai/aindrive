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

# 4. confirm site is up (resolve via the prod-reachable IP)
curl -sI --max-time 8 https://aindrive.ainetwork.ai/ | head -3

# 5. tail logs for ~10s if something looks off
sudo docker compose -f web/docker-compose.yml logs --tail 30 web
```

If step 4 returns 5xx and step 5 shows fresh stack traces, that's your problem
to fix — don't trigger another build hoping it'll go away.

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

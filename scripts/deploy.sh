#!/usr/bin/env bash
#
# scripts/deploy.sh — one-command production deploy for the aindrive web app
# (https://aindrive.ainetwork.ai). Encodes docs/DEPLOY.md + DOCKER_PUBLISH_GUIDE.md
# into GATED steps so a deploy is reproducible and hard to get wrong.
#
# Run from anywhere on the deploy host:
#   scripts/deploy.sh                 # pull origin/main, build, deploy, tag
#   scripts/deploy.sh --no-pull       # deploy the current checkout as-is
#   DRY_RUN=1 scripts/deploy.sh       # build + verify only; no swap, no tag
#
# Every gate below is a landmine this repo has actually hit in prod:
#   - lockfile drift (npm ci fails only in the Docker build, at deploy time)
#   - a testnet/empty-WC client bundle baked because a build-arg was missed
#   - a DEV_BYPASS flag left on, or a non-mainnet .env.production
# Fail early and loudly instead of discovering it after the swap.
#
# The whole body runs inside main(), called on the last line: bash parses a
# function fully before executing it, so `git pull` rewriting this very file
# mid-run can't skew execution.
set -euo pipefail

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

main() {
  local REPO HEALTH LOCK COMMIT WC ENVOUT OLD_IMG DATE TAG n NO_PULL=0

  # ── args (unknown flag dies rather than silently pull-deploying) ──────────
  for arg in "$@"; do
    case "$arg" in
      --no-pull) NO_PULL=1 ;;
      *) die "unknown argument: $arg (usage: [--no-pull]; DRY_RUN=1 env for build-only)" ;;
    esac
  done

  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$REPO"
  local -a COMPOSE=(sudo docker compose -f web/docker-compose.yml)
  HEALTH="https://aindrive.ainetwork.ai/api/healthz"
  LOCK=/tmp/aindrive-build.lock

  # Snapshot the CURRENTLY-running image up front — the build below replaces
  # aindrive-web:latest, so a snapshot taken after it would point at the NEW
  # image and the rollback hint would redeploy what we just shipped.
  OLD_IMG="$(sudo docker inspect aindrive-web-1 --format '{{.Image}}' 2>/dev/null || true)"

  # ── 1. sync ──────────────────────────────────────────────────────────────
  if [[ "$NO_PULL" == 0 ]]; then
    log "Pull origin/main (rebase)"
    git pull --rebase origin main
  fi
  COMMIT="$(git rev-parse --short HEAD)"
  ok "at $COMMIT ($(git log -1 --pretty=%s | cut -c1-60))"

  # ── 2. GATE: lockfile in sync (the recurring drift landmine) ──────────────
  log "Gate: web/package-lock.json is npm-ci-installable"
  ( cd web && npm ci --dry-run --no-audit --no-fund >/dev/null 2>&1 ) \
    || die "lockfile drift — run 'cd web && npm install', commit the lock via PR, then retry."
  ok "lock in sync"

  # ── 3. GATE: prod payment config (real-money guard) ───────────────────────
  log "Gate: mainnet payment config in web/.env.production"
  [[ -f web/.env.production ]] || die "web/.env.production missing."
  grep -q '^NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK=mainnet$' web/.env.production \
    || die "NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK is not 'mainnet' in .env.production."
  grep -qE '^AINDRIVE_PUBLIC_URL=https://' web/.env.production \
    || die "AINDRIVE_PUBLIC_URL must be https:// (SIWE wallet login binds to it)."
  if grep -qhE '^AINDRIVE_DEV_BYPASS_(X402|OTP)=1' web/.env web/.env.production 2>/dev/null; then
    die "a DEV_BYPASS flag is =1 in prod env — refusing to deploy."
  fi
  # Strip surrounding quotes (\042=" \047=') + whitespace so a quoted env value
  # can't bake the quotes into the client bundle (gate 5 is self-consistent and
  # wouldn't flag it).
  WC="$(grep -m1 '^NEXT_PUBLIC_WC_PROJECT_ID=' web/.env.production | cut -d= -f2- | tr -d '\042\047' | xargs || true)"
  [[ -n "$WC" ]] || die "NEXT_PUBLIC_WC_PROJECT_ID empty in .env.production (mobile wallet would break)."
  ok "mainnet · https public url · no dev-bypass · WC set"

  # ── 4. build (locked, explicit build-args — never bake testnet/empty-WC) ──
  log "Build image at $COMMIT (NEXT_PUBLIC network=mainnet, WC set)"
  flock "$LOCK" "${COMPOSE[@]}" build \
    --build-arg NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK=mainnet \
    --build-arg NEXT_PUBLIC_WC_PROJECT_ID="$WC" \
    web

  # ── 5. GATE: verify what actually got baked into the image ────────────────
  log "Gate: verify baked client vars"
  ENVOUT="$(sudo docker image inspect aindrive-web:latest --format '{{range .Config.Env}}{{println .}}{{end}}')"
  grep -qx 'NEXT_PUBLIC_AINDRIVE_PAYMENT_NETWORK=mainnet' <<<"$ENVOUT" || die "built image is NOT mainnet."
  grep -qx "NEXT_PUBLIC_WC_PROJECT_ID=$WC"                <<<"$ENVOUT" || die "built image WC id mismatch."
  ok "image baked mainnet + WC"

  if [[ "${DRY_RUN:-}" == "1" ]]; then
    log "DRY_RUN — built + verified, skipping swap/tag."; return 0
  fi

  # ── 6. tag the OLD image (captured up front) for rollback, then swap ──────
  if [[ -n "$OLD_IMG" ]]; then
    sudo docker tag "$OLD_IMG" "aindrive-web:predeploy-$COMMIT"   # dies loud on failure (set -e)
    ok "rollback snapshot: aindrive-web:predeploy-$COMMIT -> $OLD_IMG"
  else
    log "no running container to snapshot (first deploy?) — skipping rollback tag"
  fi
  log "Swap prod (up -d)"
  flock "$LOCK" "${COMPOSE[@]}" up -d

  # ── 7. GATE: health. --retry-max-time bounds the WHOLE recreate window;
  #        --max-time is per-attempt, so a slow cold start doesn't false-fail.
  log "Gate: health"
  curl -fsS --retry 30 --retry-delay 1 --retry-all-errors --retry-max-time 90 --max-time 5 "$HEALTH" \
    | grep -q '"ok":true' \
    || die "health check failed AFTER swap — new image is live but unverified. Inspect: ${COMPOSE[*]} logs --tail 40 web"
  sudo docker inspect --format '  running image {{.Image}}' aindrive-web-1
  ok "healthy"

  # ── 8. calver tag + GitHub Release (docs/RELEASING.md) ────────────────────
  git fetch --tags --quiet origin   # so the collision check sees remote tags too
  DATE="$(date +%Y.%m.%d)"; TAG="web-$DATE"; n=2
  while git rev-parse "$TAG" >/dev/null 2>&1; do TAG="web-$DATE-$n"; n=$((n + 1)); done
  log "Release $TAG at $COMMIT"
  git tag -a "$TAG" "$COMMIT" -m "web release $DATE — $(git log -1 --pretty=%s | cut -c1-80)"
  git push origin "$TAG"
  gh release create "$TAG" --generate-notes --title "$TAG"
  log "Done — $TAG is live."
  [[ -n "$OLD_IMG" ]] && log "Rollback: docker tag aindrive-web:predeploy-$COMMIT aindrive-web:latest && ${COMPOSE[*]} up -d"
  return 0
}

main "$@"

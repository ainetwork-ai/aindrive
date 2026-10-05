#!/usr/bin/env bash
# Local aindrive web for third-party OAuth integration tests (e.g. AIN Mail's Drive sharing).
#
#   scripts/dev-oauth-share.sh start   start web on $PORT (default 3747) with a throwaway data dir
#   scripts/dev-oauth-share.sh seed    create owner+second user, a drive, and an account-grant
#                                       token pair for a registered client (prints JSON)
#   scripts/dev-oauth-share.sh demo    seed + exercise access-check / members (prints each response)
#   scripts/dev-oauth-share.sh stop
#
# Needs Node 22 (better-sqlite3); web/node_modules installed. Dev-only switches:
# EMAIL_PROVIDER=log, AINDRIVE_DEV_BYPASS_OTP=1 (signup without the email code).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3747}"
BASE="http://localhost:$PORT"
STATE="${AINDRIVE_DEV_STATE:-$here/.dev-oauth-share}"
REDIRECT="${REDIRECT_URI:-http://localhost:3751/api/integrations/drive/callback}"
SCOPE="${SCOPE:-profile drives:read drives:share}"
mkdir -p "$STATE"

start() {
  [ -f "$STATE/pid" ] && kill -0 "$(cat "$STATE/pid")" 2>/dev/null && { echo "already running on $BASE"; return; }
  mkdir -p "$STATE/data"
  ( cd "$here/web" && env PORT="$PORT" HOSTNAME=127.0.0.1 AINDRIVE_PUBLIC_URL="$BASE" AINDRIVE_DATA_DIR="$STATE/data" \
      AINDRIVE_SESSION_SECRET="dev-oauth-share-$(hostname)-secret-0123456789" EMAIL_PROVIDER=log AINDRIVE_DEV_BYPASS_OTP=1 \
      AINDRIVE_DEV_BYPASS_X402=1 NEXT_TELEMETRY_DISABLED=1 setsid nohup node server.js </dev/null >"$STATE/server.log" 2>&1 & echo $! >"$STATE/pid" )
  for _ in $(seq 1 180); do curl -sf "$BASE/.well-known/oauth-authorization-server" >/dev/null && { echo "aindrive on $BASE (log $STATE/server.log)"; return; }; sleep 1; done
  echo "did not start; see $STATE/server.log" >&2; exit 1
}
stop() {
  [ -f "$STATE/pid" ] && kill "$(cat "$STATE/pid")" 2>/dev/null || true
  # setsid may fork: also stop any `node server.js` running from this worktree's web/
  for p in $(pgrep -f "node server.js" || true); do [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$here/web" ] && kill "$p" 2>/dev/null || true; done
  rm -f "$STATE/pid"; echo stopped
}

# signup <jar> <email> <name>
signup() {
  curl -s -c "$1" -b "$1" -H "Origin: $BASE" -H 'content-type: application/json' \
    -d "{\"email\":\"$2\",\"name\":\"$3\",\"password\":\"dev-password-123\"}" "$BASE/api/auth/signup" >/dev/null
  curl -s -c "$1" -b "$1" -H "Origin: $BASE" -H 'content-type: application/json' \
    -d "{\"email\":\"$2\",\"password\":\"dev-password-123\"}" "$BASE/api/auth/login" >/dev/null
}

seed() {
  run="$(date +%s)"
  owner="owner-$run@example.com"; second="second-$run@example.com"
  signup "$STATE/owner.jar" "$owner" Owner
  signup "$STATE/second.jar" "$second" Second
  drive=$(curl -s -b "$STATE/owner.jar" -H "Origin: $BASE" -H 'content-type: application/json' -d '{"name":"Shared"}' "$BASE/api/drives" | node -pe 'JSON.parse(require("fs").readFileSync(0)).driveId || JSON.parse(require("fs").readFileSync(0)).id' 2>/dev/null || true)
  [ -n "$drive" ] || drive=$(curl -s -b "$STATE/owner.jar" "$BASE/api/drives" | node -pe 'JSON.parse(require("fs").readFileSync(0)).drives[0].id')
  client=$(curl -s -H 'content-type: application/json' -d "{\"client_name\":\"AIN Mail (dev)\",\"redirect_uris\":[\"$REDIRECT\"],\"token_endpoint_auth_method\":\"none\",\"grant_types\":[\"authorization_code\",\"refresh_token\"]}" "$BASE/api/oauth/register" | node -pe 'JSON.parse(require("fs").readFileSync(0)).client_id')
  verifier=$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64url"))')
  challenge=$(node -e "console.log(require('crypto').createHash('sha256').update('$verifier').digest('base64url'))")
  # The consent page's Approve, as the signed-in owner (same request the button sends).
  redirect=$(curl -s -b "$STATE/owner.jar" -H "Origin: $BASE" -H 'content-type: application/json' \
    -d "{\"response_type\":\"code\",\"client_id\":\"$client\",\"redirect_uri\":\"$REDIRECT\",\"scope\":\"$SCOPE\",\"state\":\"s\",\"code_challenge\":\"$challenge\",\"code_challenge_method\":\"S256\",\"decision\":\"approve\"}" \
    "$BASE/api/oauth/authorize" | node -pe 'JSON.parse(require("fs").readFileSync(0)).redirect')
  code=$(node -pe "new URL('$redirect').searchParams.get('code')")
  tokens=$(curl -s -d grant_type=authorization_code -d "client_id=$client" -d "code=$code" -d "code_verifier=$verifier" --data-urlencode "redirect_uri=$REDIRECT" "$BASE/api/oauth/token")
  node -e "const t=$tokens; console.log(JSON.stringify({base:'$BASE',driveId:'$drive',owner:'$owner',second:'$second',clientId:'$client',scope:t.scope,access_token:t.access_token,refresh_token:t.refresh_token},null,2))" | tee "$STATE/seed.json"
}

demo() {
  seed >/dev/null
  j="$STATE/seed.json"; v() { node -pe "require('$j').$1"; }
  tok=$(v access_token); drive=$(v driveId); second=$(v second)
  echo "consent lines:"; curl -s -b "$STATE/owner.jar" "$BASE/oauth/authorize?response_type=code&client_id=$(v clientId)&redirect_uri=$(node -pe "encodeURIComponent('$REDIRECT')")&scope=$(node -pe "encodeURIComponent('$SCOPE')")&state=s&code_challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&code_challenge_method=S256" | grep -o 'Share files and folders[^<]*' | head -1
  echo "scope: $(v scope)"
  echo "drives:"; curl -s -H "Authorization: Bearer $tok" "$BASE/api/oauth/drives"; echo
  p() { echo "$1 $2"; curl -s -w ' [%{http_code}]' -H "Authorization: Bearer $tok" -H 'content-type: application/json' -d "$3" "$BASE/api/oauth/drives/$drive/$2"; echo; }
  p check access-check "{\"path\":\"plans/q3.pdf\",\"emails\":[\"$(v owner)\",\"$second\",\"nobody@example.com\"]}"
  p grant members "{\"email\":\"nobody@example.com\",\"path\":\"plans\",\"role\":\"viewer\"}"
  p grant members "{\"email\":\"$second\",\"path\":\"plans\",\"role\":\"editor\"}"
  p check access-check "{\"path\":\"plans/q3.pdf\",\"emails\":[\"$(v owner)\",\"$second\",\"nobody@example.com\"]}"
}

case "${1:-}" in start) start ;; stop) stop ;; seed) seed ;; demo) demo ;; *) echo "usage: $0 start|seed|demo|stop" >&2; exit 2 ;; esac

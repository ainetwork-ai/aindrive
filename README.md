# aindrive

> Run `aindrive` in any folder. Browse, share, and edit it like Google Drive — without ever opening a port on your machine.

aindrive has two pieces:

- **`web/`** — the Google-Drive-style UI, deployed to Vercel. Handles auth, sharing, permissions, and routing file operations to the right agent.
- **`cli/`** — the `aindrive` npm package (`npm i -g aindrive`). A local agent that connects outbound to the Vercel side over Upstash Redis, answers filesystem RPCs, and keeps your bytes on your own disk.

## Architecture at a glance

```
┌──────────────┐  HTTPS  ┌──────────────────┐   TLS (rediss://)   ┌──────────────┐
│   Browser    │ ──────▶ │  web/ on Vercel  │ ◀─ pull RPC queue ─ │  aindrive CLI │
│ (you + your  │ ◀────── │  Next.js API     │ ─▶ push response ── │  on your mac  │
│  collaborators)         │  Postgres+Redis  │                     │  (outbound only)
└──────────────┘          └──────────────────┘                     └──────────────┘
```

### Security guarantees

- **No inbound port on your machine.** The CLI initiates an outbound connection; nothing local listens.
- **HMAC-signed RPCs.** Every request and response carries a per-drive secret signature. Even if the Redis credentials leak, messages cannot be forged.
- **Path-escape protection.** The agent refuses any path that normalizes outside the drive root.
- **Fixed method allowlist.** Unknown RPC method names are dropped with no filesystem access.
- **Unguessable share tokens** (nanoid 24) with optional password, expiry, and role scoping.
- **TLS-only Redis** (`rediss://`). The agent refuses non-TLS connections.
- **Scoped cookies** — `HttpOnly`, `SameSite=Lax`, `Secure` on Vercel.

See `memory/feedback_aindrive_security.md` for the full security model.

## Usage

```bash
# one-time
npm install -g aindrive
aindrive login            # opens browser device-code flow

# per folder
cd ~/Documents
aindrive                  # pairs this folder as a new drive, opens the web UI
```

## Local development

```bash
# web (deploy target: Vercel)
cd web
cp .env.example .env.local
# fill in DATABASE_URL, UPSTASH_REDIS_REST_URL/TOKEN, AINDRIVE_SESSION_SECRET
npm install
npm run dev

# cli
cd cli
npm install
AINDRIVE_SERVER=http://localhost:3000 node bin/aindrive.mjs login
AINDRIVE_SERVER=http://localhost:3000 AINDRIVE_ALLOW_INSECURE_REDIS=1 node bin/aindrive.mjs /path/to/folder
```

## Production deploy

1. Vercel → Import `web/`
2. Install these Marketplace integrations (they auto-inject env vars):
   - **Neon** → `DATABASE_URL`
   - **Upstash Redis** → `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
3. Add `AINDRIVE_SESSION_SECRET` (`openssl rand -hex 32`) and `AINDRIVE_PUBLIC_URL` (your domain).
4. Deploy. Then publish the CLI: `cd cli && npm publish`.

## License

MIT

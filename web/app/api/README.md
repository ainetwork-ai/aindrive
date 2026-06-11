# web/app/api — HTTP API surface

Next.js route handlers for the web app. Browsers and 3rd-party/A2A agents call
these; file ops are brokered to the per-drive CLI agent over the WebSocket RPC
bridge (`lib/rpc.ts` `callAgent`). This layer owns auth gating, validation,
tier/usage caps, and payment settlement — it does NOT own the real filesystem
(the CLI agent does) nor the role model (`docs/PERMISSIONS.md`).

## Files

Auth / identity:

| Route | Role / gate |
|-------|-------------|
| `auth/login`, `auth/signup`, `auth/logout` | email+password session cookie; rate-limited. First-ever signup → `admin`. |
| `auth/cli/{start,approve,poll}` | device-link flow: CLI starts, browser (logged-in) approves a `linkId`, CLI polls with its device secret to get a session token. |
| `auth/me`, `whoami` | current user (+ wallet, for whoami). |
| `wallet/{nonce,verify}` | SIWE login challenge + verify → sets wallet cookie (payment instrument only, never a login — see CLAUDE.md). |
| `wallet/link` | bind a wallet to the logged-in account (origin+nonce bound; reclaims past receipts). Login required. |
| `wallet/me` | current wallet address from cookie. |
| `me/tier` | tier (free/pro/max) + prices + limits + upgrade URLs. |

Drives (`drives/[driveId]/…`, owner/member gated):

| Route | Gate |
|-------|------|
| `drives` (GET/POST) | list user's drives / create (per-user drive limit). Auth. |
| `drives/[driveId]` (GET/PATCH) | drive settings: `payout_wallet`, `allowed_tokens` policy. Owner only. |
| `drives/[driveId]/rotate` | rotate agent token + drive secret. Owner only. |
| `members` (GET/POST), `members/[memberId]` (PATCH/DELETE) | roster + invite (owner). Re-invite is upgrade-only; creator row immutable. PATCH may downgrade. |
| `members/invites/[inviteId]` (DELETE) | cancel a pre-account invite. Owner. |
| `shares` (GET/POST), `shares/[shareId]` (DELETE) | mint/list/revoke share links. Create = editor-at-path; `listed` paid shares = owner only; revoke = owner or the link's creator. |
| `receipts` | payment ledger, newest first. Owner only. |
| `showcase` (GET), `showcase/[shareId]` (GET) | upsell list / purchase entry (302 → `/s/<token>`). Gated to accounts related to the drive (owner or any member row). |
| `agents`, `agents/[agentId]` | owner CRUD over in-drive agents; `apiKey` stripped from all responses. |
| `agents/[agentId]/ask` | A2A ask; identity→policy→CLI execution. Tiered rate limit; outputs map to 200/401/402/429. |
| `agents/[agentId]/.well-known/agent-card.json` | public A2A AgentCard (secrets stripped). |
| `yjs` (GET/POST) | collaborative-doc read (viewer) / write (editor) via agent RPC. |

File ops (`drives/[driveId]/fs/…`) — all go through the agent WS bridge, all
gated by `requireDriveRole` (read paths = viewer+, mutations = editor+):

| Route | Notes |
|-------|-------|
| `list` / `read` | dir listing / file content (`auto` picks utf8 vs base64 by mime; capped). |
| `write` | base64/utf8 JSON body, memory-bound (≤100 MB default). Tiered file-count cap on create. |
| `upload` | streaming raw octet-stream → re-chunked to agent's 4 MiB limit, temp `.aindrive/uploads/*.part` then atomic rename. ≤2 GiB. Aborts never publish a partial file. |
| `stream` | Range-aware inline media for `<video>`/`<img>` seek. XSS guard below. |
| `download` | chunked stream, `Content-Disposition: attachment`, no size cap. |
| `thumbnail` | 256px webp via sharp, disk cache keyed by `sha1(path)+mtime`. |
| `mkdir` / `rename` / `delete` | folder ops; mkdir has a tiered folder cap. |

Payments / capabilities:

| Route | Gate |
|-------|------|
| `s/[token]` (GET) | share gate: free → ok; paid → x402 verify+settle, then writes the member grant + receipt + issues a cap. Owner/already-entitled bypass pay. |
| `s/[token]/accept` (POST) | redeem a free (or already-paid-covered) share into a `drive_members` grant. Login required; never settles payment. |
| `x402/lift` (GET) | pay an AIN micropayment to lift a scoped limit / unlock a tier (`scope=tier:pro` etc.). |
| `cap/verify` (POST) | decode + describe a Meadowcap capability token. |
| `token-lookup` (POST) | on-chain ERC-20 metadata for the token-policy editor. Login-gated (anti-amplification). |

Ops / dev:

| Route | Notes |
|-------|-------|
| `healthz` | liveness + db + connected-agent count. |
| `readyz` | readiness (db + warmup grace). |
| `dev/trace`, `dev/trace/dump` | yjs trace ring ingest/dump (trace is on by default; returns `disabled` when `AINDRIVE_TRACE=off`). |

## Contracts & invariants

- **Every drive route resolves access before touching the agent.** Mutations
  require editor+, reads viewer+; `requireDriveRole` returns a `NextResponse`
  on failure (handlers early-return it). Member/share/owner-scoped routes use
  `resolveRole`/`getDrive.owner_id` directly.
- **Grants are upgrade-only** on paid-settle, share-accept, and re-invite
  (`mergeRoleUpgradeOnly`); the drive creator's member row is immutable.
  Explicit `PATCH /members/[id]` is the only path that may downgrade.
- **fs/stream inline-XSS guard:** only browser-passive media (non-SVG image,
  video, audio, pdf) is served inline; SVG gets a CSP sandbox; everything else
  is forced to `application/octet-stream; attachment`. Editors upload arbitrary
  bytes, so inline same-origin HTML/script would be a stored-XSS vector.
- **Paid share at creation requires the drive's own `payout_wallet`** (no
  global fallback) and a `currency` allowed by the drive policy.
- **Post-settle is crash-safe:** the on-chain settle is irreversible, so grant
  and receipt writes are best-effort/idempotent (tx_hash UNIQUE → treated as
  replay) and never surface a 500 that would hide a settled payment.

## Gotchas

- File-size caps live in env (`AINDRIVE_MAX_{READ,WRITE,UPLOAD}_BYTES`); the
  agent independently caps single reads at ~8 MiB, which is why large files use
  `stream`/`download`/`upload` chunking instead of `read`/`write`.
- `DEV_BYPASS_X402` and `AINDRIVE_X402_FACILITATOR`/CDP keys decide settlement;
  mainnet with no facilitator returns 503 on first hit rather than minting a
  paywall that can't settle.
- Storage usage counters (`storage-usage.js`) drift on recursive folder deletes
  by design — limits are upper bounds, not exact accounting.

## Related

- Permission/role model, identity, path-scoped grants → `docs/PERMISSIONS.md`.
- x402 payment protocol flow (402 → PAYMENT-SIGNATURE → verify/settle) and
  sharing modes → repo root `README.md` (sharing + x402 section). Not re-explained here.
- Product/UX rules (create-in-context, audit-in-settings; tokens as a pricing
  menu) → repo `CLAUDE.md`.

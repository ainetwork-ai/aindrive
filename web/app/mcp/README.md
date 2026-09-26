# web/app/mcp — remote MCP endpoints

Remote Model Context Protocol (Streamable HTTP, stateless) over a drive, so
other apps (Claude Code, claude.ai, ChatGPT, Cursor, …) can list/read/search/
write files. Tools are the shared agent skills (`shared/agent-skills.ts`
`runSkill`), plumbed through `lib/mcp-http.ts`. Users reach the connection
panel from the drive sidebar → **MCP** (`components/mcp-modal.tsx`).

## Endpoints

| Path | Auth | Scope |
|------|------|-------|
| `/mcp/d/[driveId]` | `Authorization: Bearer <MCP token>` | one drive, `read` or `write` ceiling. **Use this.** |
| `/mcp` | session JWT as bearer, or session cookie | legacy, account-wide (all drives). Not advertised. |

Drive endpoint tools: `list_files`, `read_file`, `stat`, `search`, plus
`write_file` / `delete_path` for write tokens, the sale tools for an
account grant with `drives:sell` (below), plus the app-only `a2ui_action`.
There is no `drive_id` argument; the URL fixes it.

## UI (MCP Apps + A2UI) — `lib/mcp-http.ts`, `lib/mcp-ui.ts`

- Every tool carries `_meta.ui.resourceUri = "ui://aindrive/browser"`, an MCP Apps
  view: the official ext-apps App bundle + `shared/a2ui/renderer.js`, inlined
  into one HTML file (read from `node_modules`/`shared` at runtime).
- Every result carries its A2UI surface in `_meta["ai.aindrive/a2ui"]`, which is
  UI-only; the model sees the text. With `X-A2UI: 1` (or `?a2ui=1`) the result
  also embeds the surface as an `application/a2ui+json` resource.
- Clicks in the view come back as `tools/call a2ui_action {action}`. That tool
  is limited to the same tool allow-list as the token.
- Public guide: `/docs/mcp`, `/docs/a2ui` (source `app/docs/content/`).

## Tokens (`lib/mcp-tokens.ts`, table `mcp_tokens`)

- **PAT** `aind_pat_…`: issued in the MCP modal (`POST /api/drives/[id]/mcp-tokens`),
  shown once, expires in 30d / 90d / never, revocable.
- **OAuth** `aind_oat_…` (1h) + refresh `aind_ort_…` (30d, rotated on every use):
  one row per connected app, listed and revocable in the same modal.
- Only sha256 hashes are stored. A token is bound to one drive. Its scope is a
  **ceiling**: every call re-resolves the holder's live role (and the paid
  carve-out), so leaving the drive or being downgraded takes effect immediately.
  Issue-time scope is clamped by the holder's highest role (viewer → read only).

## OAuth 2.1 (`lib/oauth.ts`)

The flow follows the MCP authorization spec, so a client needs only the URL:

1. `/mcp/d/[id]` without a token → `401` + `WWW-Authenticate: … resource_metadata=…`
2. `/.well-known/oauth-protected-resource/mcp/d/[id]` (RFC 9728) → the auth server
3. `/.well-known/oauth-authorization-server` (RFC 8414)
4. `POST /api/oauth/register`: dynamic client registration (RFC 7591), public clients only
5. `/oauth/authorize`: login redirect, then consent page (`app/oauth/authorize/`) → `POST /api/oauth/authorize`
6. `POST /api/oauth/token`: `authorization_code` (PKCE S256 required) / `refresh_token`

The drive comes from the RFC 8707 `resource` (= the drive's MCP URL). Scopes
on the wire are `drive:read` / `drive:write`.

## Account-level grant ("Sign in with aindrive") — `lib/account-tokens.ts`

For third-party web apps: one token pair for the user, not one drive.

- Request `/oauth/authorize` with **no `resource`** and only account scopes:
  `profile`, `drives:read`, `drives:write`, `drives:sell` (any non-empty
  subset). Mixing in `drive:*` or any unknown scope is rejected. Consent lists
  one line per requested scope; login redirect as usual.
- Same DCR, PKCE and `/api/oauth/token` exchange/refresh as the drive flow
  (the code's table decides the kind); `scope` comes back as the granted set,
  e.g. `"profile drives:read drives:sell"`.
- Tokens (table `account_tokens`): access `aind_aat_…` (1h) + refresh
  `aind_art_…` (30d, rotated; reuse revokes the grant). Hashes only.
- `GET /api/oauth/userinfo` (`profile`) → `{ sub, email, email_verified, name, wallet_address }`.
  Wallet-only accounts have a placeholder email and `email_verified: false`, so don't show that email.
- `GET /api/oauth/drives` (`drives:read`) → `{ drives: [{ id, name, online, role }] }`.
- `/mcp/d/[id]` accepts the access token on any drive the user is a member of
  (non-member → 403; no `drives:*` scope → 403). Each scope adds its tools, and
  unlisted tools are refused:
  - `drives:read` → `list_files`, `read_file`, `stat`, `search`
  - `drives:write` → `write_file`, `delete_path` (the user still needs editor at the path)
  - `drives:sell` → the sale tools, **creator-only** (`drives.owner_id`, checked on every
    call; a member or co-owner gets `[forbidden]`). Same validation and messages as the
    HTTP routes (`lib/sales.ts`):

    | Tool | Input → output |
    |------|----------------|
    | `list_shares` | `{}` → `{ shares: [{ id, token, url, path, role, price, currency, listed, expiresAt, createdAt }] }` |
    | `create_share` | `{ path, price, currency, listed?=true, role?='viewer', expiresAt? }` → `{ id, token, url }` (payout wallet required, currency in policy, non-root path needs the agent online) |
    | `update_share` | `{ shareId, price?, currency?, listed? }` → `{ ok }` (a free share can't become paid) |
    | `delete_share` | `{ shareId }` → `{ ok }` |
    | `get_sale_settings` | `{}` → `{ payoutWallets: [{ path, wallet }], allowedTokens }` (effective policy) |
    | `set_payout_wallet` | `{ path?='', wallet }` → `{ ok }` (stored lowercased) |
    | `set_token_policy` | `{ tokens: [{ symbol, chain, asset, name?, version?, decimals, transferMethod }] }` → `{ ok }` (chain `base`/`base-sepolia`, asset a contract address) |
    | `list_receipts` | `{ limit?=50, before? }` → `{ receipts: [{ txHash, path, wallet, amount, currency, network, shareId, accountId, settledAt }] }`, newest first; page with `before` = last `settledAt` |
- Checkout relay: `GET /api/s/<token>` with `Authorization: Bearer aind_aat_…`
  credits the purchase to that account (see `app/api/README.md`).
- Connected apps: `GET /api/oauth/account-tokens`, `DELETE /api/oauth/account-tokens/[id]`
  (session + same-origin). There is no UI for this yet.

## Pay tools (x402) — `lib/x402-pay-skills.ts`, `lib/agent-wallets.ts`

aindrive as an x402 **client and facilitator front** for an account, so an
app acting as the account (ainmem's pocket-money gift, an agent buying a
file) pays without holding a key:

| Tool | In | Out |
|------|----|-----|
| `x402_wallet` | `{}` | `{ address, kind: "agent" }` |
| `x402_sign` | `{ x402Version: 2, paymentRequirements, resource? }` | `{ paymentPayload }` (EIP-3009 `exact`, signed by the agent wallet) |
| `x402_settle` | `{ paymentPayload, paymentRequirements }` | the facilitator's settle reply: `{ success, transaction, network, payer }` or `{ success: false, errorReason }` |

Shapes are x402 v2's, so a caller drops them in where it would call a
facilitator. Settlement uses the same facilitator resolution as paid shares
(`lib/x402-facilitator.ts`: `AINDRIVE_X402_FACILITATOR` → CDP keys → x402.org
on testnet; `AINDRIVE_DEV_BYPASS_X402=1` for demos).

- **Agent wallet** = a custodial "pocket-money" key per account (table
  `agent_wallets`, AES-GCM under the session secret), made on first use. It is
  NOT the identity wallet (`account_wallets`, SIWE, self-custodial). Fund it
  with what an agent may spend.
- **Off by default.** `AINDRIVE_AGENT_WALLETS=1` turns it on; until then the
  tools are not listed anywhere, so a client that looks for `x402_*` in
  `tools/list` learns whether it can pay here.
- **Who gets them**: a session on the legacy `/mcp` (the whole account), or an
  account grant with the `wallet:pay` scope on `/mcp/d/[driveId]`. PATs and
  drive-scoped OAuth never do.

## Guards in runSkill (every MCP call)

- The path is canonicalized once (`normalizePath`); that same string feeds the access check, paywall and agent call.
- The `.aindrive/` subtree (agent token, drive secret, agent API keys) is refused for every role.
- Paid rules match `fs/*`: a priced subtree can't be read or listed without an
  entitlement. Listed sales show as `locked`, unlisted sales are hidden, and `search` never descends into them.
- `write_file` enforces the same size and file-count caps as `fs/write`. The count cap is the drive owner's (their tier, or `AINDRIVE_UNLIMITED_OWNERS`), never the caller's: a PAT or account-token call sends no wallet cookie.

## Gotchas

- Every URL is built from `AINDRIVE_PUBLIC_URL` (`env.publicUrl`). If it is wrong,
  `resource` validation fails and the metadata points at the wrong host.
- An authorization code is burned before it is checked, so a failed exchange can't be retried.
- Replaying a superseded refresh token revokes the whole grant (the token leaked).
- Cookie-authenticated mutations (consent, PAT issue/revoke) require a same-origin `Origin` (`isSameOrigin`).
- The consent screen labels `client_name` as self-reported and shows the redirect origin. DCR is open, so the name proves nothing.
- Redirect URIs: https, loopback http, or a private-use scheme (`cursor://`); never `javascript:`/`data:`/`file:`.
- Tests: `lib/__tests__/mcp-auth.test.ts`, `lib/__tests__/oauth-account.test.ts`, `lib/__tests__/oauth-sale-tools.test.ts`. Design: `docs/superpowers/specs/2026-09-23-remote-mcp-design.md`.

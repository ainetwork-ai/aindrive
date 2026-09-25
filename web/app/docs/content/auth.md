# Authentication

Every endpoint takes a bearer token: `Authorization: Bearer <token>`. The token
decides **which drives** you can reach and a **ceiling** on what you can do. The
ceiling is never a grant — each call is re-checked against the user's *current*
role and path-scoped permissions, so removing someone from a drive (or
downgrading them) takes effect immediately for every token they hold.

| Token | Prefix | Reach | How you get it |
|---|---|---|---|
| Personal access token | `aind_pat_` | one drive, `read` or `write` | drive → sidebar **MCP** → *Generate* (shown once; 30d / 90d / never) |
| OAuth drive token | `aind_oat_` (+ refresh `aind_ort_`) | one drive, `drive:read` / `drive:write` | OAuth 2.1 with `resource` = the drive's MCP URL |
| OAuth account token | `aind_aat_` (+ refresh `aind_art_`) | every drive the user belongs to, per scope: `drives:read`, `drives:write`, `drives:sell`, and/or `profile` | OAuth 2.1 with **no** `resource` ("Sign in with aindrive") |

Where each token works:

| | `/mcp/d/<id>` | `/a2a` | `/agui` | `/agui/d/<id>` | `/api/oauth/userinfo` · `/api/oauth/drives` |
|---|---|---|---|---|---|
| `aind_pat_` / `aind_oat_` | its drive | its drive (pinned) | its drive (pinned) | its drive | — |
| `aind_aat_` + `drives:read` | read tools, any member drive | read skills | read skills | read skills | drives ✓ |
| `aind_aat_` + `drives:write` | + `write_file`, `delete_path` | + write skills | + write skills | + write skills | — |
| `aind_aat_` + `drives:sell` | + [sale tools](/docs/skills#sale-tools) (drive creator only) | — | — | — | — |
| `aind_aat_` + `profile` | — | — | — | — | userinfo ✓ |

Each account scope adds exactly its skills; a skill outside the granted scopes
is refused. Write skills still need the user's editor role at the path, and sale
tools only work for the drive's creator.

## OAuth 2.1

aindrive is a standards-compliant authorization server (the flow MCP hosts run
automatically). You only need this if you write your own client.

| | |
|---|---|
| Discovery | `GET {{BASE}}/.well-known/oauth-authorization-server` (RFC 8414) |
| Per-drive resource metadata | `GET {{BASE}}/.well-known/oauth-protected-resource/mcp/d/<driveId>` (RFC 9728) |
| Dynamic client registration | `POST {{BASE}}/api/oauth/register` (RFC 7591 — public clients only) |
| Authorize | `GET {{BASE}}/oauth/authorize` — **PKCE S256 required** |
| Token | `POST {{BASE}}/api/oauth/token` — `authorization_code`, `refresh_token` |
| Scopes | per drive: `drive:read`, `drive:write` · account: `profile`, `drives:read`, `drives:write`, `drives:sell` |

### 1. Register

```bash
curl -s {{BASE}}/api/oauth/register -H 'content-type: application/json' -d '{
  "client_name": "My App",
  "redirect_uris": ["https://myapp.example/callback"]
}'
# → { "client_id": "aind_client_…", ... }
```

Redirect URIs: `https://…`, `http://localhost|127.0.0.1` (native apps), or a
private-use scheme (`myapp://…`). Registration is rate-limited.

### 2. Send the user to authorize

```
{{BASE}}/oauth/authorize?response_type=code
  &client_id=aind_client_…
  &redirect_uri=https://myapp.example/callback
  &code_challenge=<BASE64URL(SHA256(verifier))>&code_challenge_method=S256
  &state=<random>
  &scope=drive:read%20drive:write          ← account grant: e.g. profile%20drives:read
  &resource={{BASE}}/mcp/d/<driveId>       ← omit for an account grant
```

The user signs in (email or wallet) and approves on aindrive's consent screen;
they can lower the permission. You get `?code=…&state=…&iss={{BASE}}` back.

### 3. Exchange and refresh

```bash
curl -s {{BASE}}/api/oauth/token -d grant_type=authorization_code \
  -d code=$CODE -d client_id=$CLIENT_ID -d redirect_uri=$REDIRECT -d code_verifier=$VERIFIER
# → { access_token, refresh_token, token_type:"Bearer", expires_in:3600, scope }

curl -s {{BASE}}/api/oauth/token -d grant_type=refresh_token -d refresh_token=$RT -d client_id=$CLIENT_ID
```

Access tokens live 1 hour; refresh tokens 30 days and **rotate on every use**.
Replaying an old refresh token revokes the whole grant (it means the token
leaked). Codes are single-use and expire in 10 minutes.

## Revoking

Users see every token and connected app in the drive's **MCP** panel (drive
tokens) and can revoke them there; drive owners see and revoke all members'
tokens. Account grants are listed at `GET /api/oauth/account-tokens` and revoked
with `DELETE /api/oauth/account-tokens/<id>`.

# Remote MCP: drive-scoped tokens + OAuth 2.1, 2026-09-23

## Goal

The drive sidebar gets an **MCP** entry above "Create agent". It gives any
member a remote MCP URL plus a way to authenticate other apps: a personal
access token for header-configurable clients (Claude Code, Cursor, VS Code),
or OAuth so URL-only connectors (claude.ai, ChatGPT) work with no token copy.

## Problem

`/mcp` already existed, but its bearer was the **login session JWT** (30d,
not individually revocable). Sharing it with an app meant sharing the login.
Nothing in the UI issued a token or showed the URL.

## Decisions

- **Drive-scoped.** URL `/mcp/d/<driveId>`, and each token is bound to one drive.
  This follows "create in context". No `list_drives` and no `drive_id` argument.
- **Scope = ceiling.** `read` | `write` is chosen at issue time and clamped to the
  holder's highest role (viewer → read only). Each call still resolves the live
  role plus the paid carve-out, so downgrades and leaving the drive apply immediately.
- **Any member may issue**, for themselves. The owner can list and revoke every
  member's tokens in the drive.
- **One table (`mcp_tokens`)** holds PATs and OAuth grants (one row per connected
  app, rotated in place on refresh). Only sha256 hashes are stored.
- **OAuth per the MCP authorization spec**: RFC 9728 PRM + `WWW-Authenticate`,
  RFC 8414 AS metadata, RFC 7591 DCR (public clients), auth code + PKCE S256,
  RFC 8707 `resource` → drive, refresh rotation, RFC 9207 `iss`.
  Access token 1h, refresh 30d, code 10 min (burned before checking).
- **Legacy `/mcp` kept** for existing integrations but no longer advertised.

## Components

| Unit | Responsibility |
|------|----------------|
| `lib/mcp-tokens.ts` | issue/verify/refresh/list/revoke, scope clamp, `mcpUrlFor` |
| `lib/oauth.ts` | metadata, DCR, authorize validation, codes, PKCE |
| `lib/mcp-http.ts` | stateless Streamable-HTTP server over `runSkill` |
| `shared/agent-skills.ts` | `SkillCtx.driveId/scope`, `driveScopedDescriptors`, paid carve-out on read |
| `app/mcp/d/[driveId]` | bearer → token → drive check → serve |
| `app/.well-known/*`, `app/api/oauth/*`, `app/oauth/authorize` | OAuth surface + consent UI |
| `app/api/drives/[id]/mcp-tokens` | PAT issue/list/revoke |
| `components/mcp-modal.tsx` | URL, OAuth how-to, PAT issue (shown once) + snippets, token list |

## Security notes

- Consent POST requires the session plus a same-origin `Origin`. The consent page
  sits under the middleware's `X-Frame-Options: SAMEORIGIN`.
- Redirect URIs: https, loopback http, or private-use schemes. No fragments and
  no dangerous schemes. Exact match at authorize time.
- DCR is limited to 20/h per IP and the token endpoint to 60/min per IP. A user
  can hold at most 50 active PATs per drive.

## Security review follow-ups (same PR)

An independent review of the first cut found, and this PR fixes:
- A paywall bypass via non-canonical paths (`/paid/a.pdf`). runSkill now normalizes once.
- `.aindrive/config.json` was readable through skills. It is now refused. **This bug predates the PR and
  still exists in the HTTP `fs/*` routes and the CLI agent's read/write handlers (tracked separately).**
- `list_files`/`stat`/`search` leaked paid and unlisted entries. They now follow R-VIS-PAID-001.
- MCP writes skipped quotas.
- Refresh reuse was not detected.
- Unbounded DCR (added a global cap and GC).
- Login `next=/\evil` open redirect.
- Unverified client names on the consent screen.

## Testing

`lib/__tests__/mcp-auth.test.ts`: scope clamp, PAT lifecycle, 401 +
resource_metadata, cross-drive 403, read-scope tool filtering, live-role
clamp, management API permissions, full OAuth flow (CSRF, deny, PKCE failure
burning the code, refresh rotation, reuse → grant revoked, revoke), viewer clamp,
safe `next`. `lib/__tests__/mcp-skills-guard.test.ts`: path canonicalization vs
paywall, `.aindrive` refusal, and paid visibility on list/stat/search.

# Same-Wi-Fi direct + web route — hybrid transport (2026-09-26)

## Problem

Opening a phone's shared folder from the Mac app on the same home Wi-Fi is
slow: every byte goes Mac → aindrive server → phone over the agent's WebSocket
and back, even when the two devices sit a metre apart. Grids of photos were
worst — the server's thumbnail route pulled each camera original (5–40 MB)
through that relay before resizing it, so the app left remote tiles as icons.

Goal: **at home on the same Wi-Fi it should feel local**; anywhere else it keeps
working through the server exactly as today.

## Principles

- **The server stays the authority.** Who may read what (role ladder,
  path-scoped grants, paid shares — `docs/PERMISSIONS.md`) is decided only by
  the server. The LAN path is a faster *pipe*, never a second permission system.
- **Hybrid, per request.** Direct when it answers fast, the web route otherwise;
  a failure on the direct path silently retries through the server.
- **No new long-lived secrets.** The phone already shares `drive_secret` with the
  server (frame signing, `web/lib/sig.js`); the direct path derives from it.
- **Browsers keep the web route.** An https page can't reach a LAN http address
  (mixed content, Private Network Access), so only the native apps (Mac app,
  phone app) use direct.

## Phase 1 — small thumbnails through the server (shipped with this spec)

- Agent RPC `thumbnail {path, px}` → `{data (base64 JPEG), mime}`. The phone
  answers from its own cached thumbnail (`Thumbs.java`, the same cache the app's
  grid uses): tens of KB instead of the original.
- `fs/thumbnail` route tries it first and caches the JPEG; an agent without the
  method answers "unknown method" and the route falls back to pulling the
  original (CLI agents unchanged).
- The app's grid shows thumbnails for other devices' drives via that route.

## Phase 2 — direct on the same Wi-Fi

```
 Mac app / phone app                 aindrive server                   serving phone
 ───────────────────                 ───────────────                   ─────────────
                                     ◄── agent-hello {lan:[ip:port]} ── (WS, on Wi-Fi only)
 POST /api/drives/:id/direct ──────► role check (viewer+ on path)
 ◄── {endpoints, ticket, key, exp}   ticket = AEAD(k_drive, {key, uid,
                                              role, scope, exp})
 GET http://ip:port/v1/… ─────────────────────────────────────────────► open ticket with k_drive,
   X-Aindrive-Ticket: ticket                                            check exp/scope/role,
   body/response sealed with key                                        serve list/thumb/bytes
 on timeout/error → same call via /api/drives/:id/fs/*  (web route)
```

**Advertising.** The phone runs one small HTTP server (all its drives) only
while on Wi-Fi and at least one share is on. It reports private addresses only
(RFC 1918, link-local, IPv6 ULA) in `agent-hello` and again on network change
(`agent-lan`). The server keeps them in memory with the socket — gone when the
agent disconnects, never in the DB.

**Ticket.** `POST /api/drives/:id/direct` (session cookie) runs the same gate as
`fs/read` and returns `{endpoints, ticket, key, exp}`: a random 256-bit session
`key`, and `ticket = AES-256-GCM(k_drive, {key, drive, uid, role, scope, exp})`
with `k_drive = HKDF(drive_secret, "aindrive-direct-v1")`. Only the server and
that phone can make or open a ticket. `exp` = 5 min; the client renews early.

**Channel.** Every request and response body is sealed with `key`
(AES-GCM, random 96-bit IV, AAD = method + path + ticket id; streamed files in
64 KB sealed frames). Someone else on the Wi-Fi can neither read files nor forge
requests or answers; no TLS certificates to generate or pin. The phone checks
`scope`/`role` from the ticket on every request (read-only in v1).

**API on the phone (v1, read-only).** `POST /v1/rpc` for `list`, `stat`,
`thumbnail` (same JSON as the WS RPCs, same `RpcHandler`), and
`GET /v1/file?path=` with `Range` for images/video.

**Client routing (`mobile/src/transport.ts`, used by phone + Mac shells).**
Per remote drive: fetch a ticket lazily, probe `/v1/ping` (300 ms); while it
answers, `list`/`thumbnail`/viewer bytes go direct, else the web route. A direct
failure marks the drive "via server" for 60 s and retries the call on the web
route. The folder header shows **Same Wi-Fi** or **Via server**. Native code
does the HTTP (CapacitorHttp / Electron main), so no CORS/mixed-content issues;
the Mac serves decrypted streams to the viewer through its `app://` protocol.

## Later

- Phase 3: writes/uploads direct (server still told, so live editors and
  activity stay correct); the Mac/CLI agent serving the same protocol.
- Phase 4: beyond one network — WebRTC data channel with the server as
  signalling (same ticket), relay as the fallback it already is.

## Risks

- Guest/office Wi-Fi with client isolation → probe fails → web route (correct,
  just not faster). Battery: server runs only with a share on and on Wi-Fi.
- Ticket leak = 5 minutes of the scope it was minted for, no more than the
  session that minted it could already read.

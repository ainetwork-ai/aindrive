# aindrive mobile

Installable Android/iOS app that turns **folders on the phone** into aindrive
drives — one drive per picked folder. The phone plays the role `cli/` plays on
a laptop: it runs the agent, holds the files, and answers signed RPCs. It is not a web wrapper — the
WebView here is only the pairing/control screen.

```
npm install
npm run apk:debug        # → android/app/build/outputs/apk/debug/app-debug.apk
npm run ios              # opens Xcode (macOS only)
```

## Responsibility

Serve user-picked device folders to an aindrive server over **outbound**
WebSockets (one socket per drive), so the drives' files live on the phone and
no inbound port is opened on it. Pairing reuses the desktop CLI's single-use browser link, so a phone
drive and a laptop drive are the same thing to the server.

## Files

| Path | Role |
|------|------|
| `src/main.ts` | shell UI: log in, add folders, pair/start/stop each one, status. Touches no files. |
| `src/api.ts` | pairing calls — `/api/auth/cli/start`, `/poll`, `/api/drives` |
| `src/plugin.ts` | typed face of the native `AindriveAgent` plugin |
| `android/…/AgentService.java` | the agent: one `Conn` (WSS socket + reconnect) per drive, in a single foreground service |
| `android/…/SafFs.java` | filesystem over the picked SAF tree (real device storage) |
| `android/…/RpcHandler.java` | RPC method dispatch, mirroring `cli/src/rpc.js` |
| `android/…/Sig.java` | HMAC frame signing, byte-compatible with `web/lib/sig.js` |
| `ios/App/App/AgentCore.swift` | same agent, one `DriveConn` (`URLSessionWebSocketTask`) per drive |
| `ios/App/App/DriveFs.swift` | filesystem over a security-scoped folder bookmark |
| `ios/App/App/{RpcHandler,Sig}.swift` | iOS counterparts of the above |

## Contracts

- **Frame signing must match Node byte-for-byte.** The canonical form is
  `JSON.stringify(payload, Object.keys(payload).sort())`, whose second argument
  is a key *allowlist* applied to every object — so nested objects (`params`,
  `result`) serialise as `{}`. `SigCompatTest` pins this against vectors
  generated from `web/lib/sig.js`; regenerate them from Node rather than
  editing them to match new output.
- **RPC results must match `cli/src/rpc.js`.** The server cannot tell which
  kind of agent it is talking to, so a shape difference surfaces as a broken
  file browser, not an error.
- **One folder = one drive = one socket.** Every shared folder is paired as its
  own drive (own driveId/token/secret) exactly as a separate desktop agent
  would be; the native side keys connections by driveId. Plugin API:
  `start(config)` adds/replaces a drive, `stop({driveId})` removes one,
  `stop()` removes all, `status()` returns `{running, connected, drives[]}`.
- **Folder access is scoped per tree.** Android takes a persistable SAF grant
  per folder; iOS stores a security-scoped bookmark per folder. Neither can
  read outside the folders the user picked.

## Gotchas

- **Shell state is `aindrive.mobile.state.v2`** (a `shares[]` list). The v1
  single-folder layout is migrated once on load and then deleted, so an
  existing pairing keeps working without re-pairing.
- **Android needs the foreground service.** WebViews and background threads are
  suspended seconds after leaving the app, which would take the drive offline on
  every app switch. The persistent notification is the honest signal that the
  phone is serving files, and the off switch.
- **iOS cannot stay online in the background.** There is no foreground-service
  equivalent; a backgrounded app keeps the socket only for a short background
  task assertion. The drive is online while the app is open. This is a platform
  limit, not a TODO.
- **`agent-ask` is refused on mobile** — it would need the owner's LLM key and a
  full-folder knowledge walk on the phone.
- **`yjs-*` keeps only the latest snapshot**, not the append-only Willow store,
  because there is no Y.js in the native process. That is the same fallback path
  the desktop agent still supports: collaboration converges through the server,
  local edit history is what is lost.
- **`.aindrive/` is not written into the user's folder.** Drive config lives in
  app storage and yjs snapshots in app-private storage — a phone's Documents
  directory should not sprout a control directory the user cannot clean up.

## Related

- `cli/README.md` — the desktop agent this mirrors
- `docs/PERMISSIONS.md` — role ladder and path-scoped grants
- root `README.md` — architecture and how the pieces fit

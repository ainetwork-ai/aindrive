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
| `src/main.ts` | shell UI: log in, add/create folders, add files to them, pair/start/stop each one, status. |
| `src/api.ts` | pairing calls — `/api/auth/cli/start`, `/poll`, `/api/drives` |
| `src/plugin.ts` | typed face of the native `AindriveAgent` plugin |
| `android/…/AgentService.java` | the agent: one `Conn` (WSS socket + reconnect) per drive, in a single foreground service |
| `android/…/SafFs.java` | filesystem over the picked SAF tree (real device storage) |
| `android/…/RpcHandler.java` | RPC method dispatch, mirroring `cli/src/rpc.js` |
| `android/…/Sig.java` | HMAC frame signing, byte-compatible with `web/lib/sig.js` |
| `android/…/index/{PhotoIndex,Indexer,ExifMeta,GeoLookup}.java` | on-device photo index: app-private SQLite, EXIF date/GPS, offline GeoNames gazetteer (`assets/geo/cities.tsv.gz`, built by `scripts/build-gazetteer.py`) |
| `android/…/agent/{QueryParser,AskRunner,SearchQuery}.java` | the on-device agent: question → place/date filters → `{answer, sources}`; answers `agent-ask` and the in-app search |
| `ios/App/App/AgentCore.swift` | same agent, one `DriveConn` (`URLSessionWebSocketTask`) per drive |
| `ios/App/App/DriveFs.swift` | filesystem over a security-scoped folder bookmark |
| `ios/App/App/{RpcHandler,Sig}.swift` | iOS counterparts of the above |

## Contracts

- **Frame signing must match Node byte-for-byte.** The canonical form is
  `JSON.stringify(payload, Object.keys(payload).sort())`, whose second argument
  is a key *allowlist* applied to every object in the tree, in allowlist
  order — so a nested `result` keeps only the top-level key names it shares
  (`{"result":{"ok":true}}`), not `{}`. `SigCompatTest` pins this against vectors
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
- **A share can be created from scratch.** `createFolder({name})` asks where
  (a granted tree) and creates the sub-folder there; the handle is
  `tree#docId` on Android (`SafFs.subfolderUri` — the *parent* grant is what
  the permission covers) and a bookmark of the sub-folder on iOS.
  `addFiles({folderUri})` is the phone's drag-and-drop: the system file picker,
  copied into the folder root, same-name files replaced.
- **`agent-ask` is answered on the phone, offline.** Same `{answer, sources:
  [{path, snippet}]}` as the desktop agent, produced by `agent/AskRunner` over
  this drive's photo index; `agent.json` is never read (the phone has one kind
  of agent) and no LLM key exists on the device. Plugin API: `reindex()` builds
  the index (asks for `ACCESS_MEDIA_LOCATION` first), `ask({query})` runs the
  same runner across every running drive. Design + roadmap (LLM planner, CLIP):
  `docs/superpowers/specs/2026-09-23-mobile-on-device-agent-design.md`.
- **Folder access is scoped per tree.** Android takes a persistable SAF grant
  per folder; iOS stores a security-scoped bookmark per folder. Neither can
  read outside the folders the user picked.

## Gotchas

- **Android 10+ redacts GPS EXIF from any stream an app opens** unless it holds
  `ACCESS_MEDIA_LOCATION` — SAF included, silently. Without the grant every photo
  indexes with a date but no place and "photos from Paris" finds nothing.
- **The gazetteer is `assets/geo/cities.tsv.gz` on disk but `geo/cities.tsv` at
  runtime**: AAPT inflates `.gz` assets and drops the suffix.
- **Debug builds accept agent commands via `adb`** (`MainActivity.forwardDebugIntent`):
  `am start -n ai.ainetwork.aindrive/.MainActivity --es agentAction ai.ainetwork.aindrive.ASK --es query "파리 사진"`
  logs the answer under tag `AindriveAgent`; `…REINDEX` rebuilds. Handy when the
  phone is locked on a desk.

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

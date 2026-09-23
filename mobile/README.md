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
| `src/main.ts` | shell UI: log in, add folders, pair/start/stop each one, status, and an in-app file browser per folder (navigate, open, new folder, add files, rename, delete). |
| `src/api.ts` | pairing calls — `/api/auth/cli/start`, `/poll`, `/api/drives` |
| `src/plugin.ts` | typed face of the native `AindriveAgent` plugin |
| `android/…/AgentService.java` | the agent: one `Conn` (WSS socket + reconnect) per drive, in a single foreground service |
| `android/…/SafFs.java` | filesystem over the picked SAF tree (real device storage) |
| `android/…/RpcHandler.java` | RPC method dispatch, mirroring `cli/src/rpc.js` |
| `android/…/Sig.java` | HMAC frame signing, byte-compatible with `web/lib/sig.js` |
| `android/…/index/{PhotoIndex,Indexer,ExifMeta,GeoLookup}.java` | on-device photo index: app-private SQLite, EXIF date/GPS, offline GeoNames gazetteer (`assets/geo/cities.tsv.gz`, built by `scripts/build-gazetteer.py`) |
| `android/…/agent/{QueryParser,AskRunner,SearchQuery,ContentWords}.java` | the on-device agent: question → kind/place/date/size filters + content words → name, transcript and photo matching → `{answer, sources}`; answers `agent-ask` and the in-app search |
| `android/…/clip/{ClipEmbedder,ClipTokenizer,ModelStore}.java` | photo recognition: MobileCLIP-S0 on ONNX Runtime (image + text → 512-d), CLIP BPE tokenizer port, verified model downloads (`assets/clip/models.json`) |
| `android/…/speech/{SpeechRecognizer,AudioDecoder}.java` | speech recognition: Whisper-base (int8) via sherpa-onnx; any container → 16 kHz PCM through MediaCodec (`assets/speech/models.json`) |
| `scripts/make-real-corpus.py`, `scripts/run-device-scenarios.py` | real-photo / real-speech corpus + the adb runner that asks every scenario on the phone |
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
- **The in-app browser reads the folder locally.** `listFolder`, `openFile`,
  `mkdir`, `rename`, `delete` and `addFiles({folderUri, path})` go straight to
  `SafFs`/`DriveFs` — the same code the RPCs use — so it works offline and
  while the drive is off, and shows exactly what the web shows. `addFiles` is
  the phone's drag-and-drop: the system file picker, copied into the folder,
  same-name files replaced. `openFile` hands the file to the OS (Android
  ACTION_VIEW chooser, iOS Quick Look).
- **Folder access is scoped per tree.** Android takes a persistable SAF grant
  per folder; iOS stores a security-scoped bookmark per folder. Neither can
  read outside the folders the user picked.

## Gotchas

- **Use the fp32 MobileCLIP vision export.** The int8 export gives random
  rankings and the fp16 one computes wrong vectors on Android's CPU execution
  provider (cosine ≈ 0.2 with the reference); fp32 matches (≥ 0.96).
- **sherpa-onnx must be the `static-link-onnxruntime` AAR** (fetched by
  `app/sherpa-onnx.gradle`): the plain AAR bundles a `libonnxruntime.so` that
  collides with `onnxruntime-android`. The APK is arm64-only for the same reason.
- **Whisper-base Korean is approximate** (CER ≈ 0.45 on read speech; English is
  near-perfect). Distinctive words survive, filler does not — enough to find
  "the meeting where we discussed the budget", not to write minutes.
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
- **The agent can act, not just answer.** "…모아서 폴더로 만들어줘" copies the
  matches into a new top-level folder named after the question (`SafFs.copy`,
  `AskRunner.collect`, reported as `action` on the result); "…공유해줘" makes
  the shell mint a viewer link for that folder via `POST /api/drives/:id/shares`
  (the shell holds the session — the native side never does). Only exact
  matches are collected: a relaxed search reports `skipped` instead.
- **Files open in the app.** Images (downscaled via `readFile`) and audio show
  in an in-app viewer; everything else goes to the OS chooser (`openFile`).
- **`agent-ask` is answered on the phone, offline.** Same `{answer, sources:
  [{path, snippet, matchedBy}]}` as the desktop agent, produced by
  `agent/AskRunner` over this drive's index; `agent.json` is never read (the
  phone has one kind of agent) and no LLM key exists on the device.
- **Recognition is real and on-device.** Photos get a MobileCLIP vector (the
  question's content words become "a photo of …" and rank photos by cosine;
  ≥ 0.17 and within 0.08 of the best counts as a match), recordings and videos
  get a Whisper transcript (first 15 min, 28 s windows) searched by keyword.
  Models (≈ 230 MB) are not in the APK: `ensureModels()` downloads them with
  SHA-256 checks into `filesDir/models/`. Verified on device with real Commons
  photographs and real meeting / Korean recordings (46/46 scenarios).
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

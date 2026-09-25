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
| `android/…/clip/{ClipEmbedder,ClipTokenizer,ModelStore}.java` | photo recognition: **MobileCLIP2-S2** on ONNX Runtime (`assets/clip/mobileclip2-s2.json`, fp32, external-data weights, 400 MB; on the real corpus P@4 0.93 vs MobileCLIP-S0 0.88 vs SigLIP2-B/16 0.85 — see `scripts/` calibration; thresholds `minScore`/`margin` are per-model in the manifest; licence apple-amlr = research use, SigLIP 2 is the Apache-2.0 alternative), CLIP BPE tokenizer port, checksum-verified model store (single files or tar.bz2 bundles). Changing the image model drops old vectors (`FileIndex.adoptImageModel`) |
| `android/…/speech/{SpeechRecognizer,AudioDecoder}.java` | speech recognition via sherpa-onnx: **Qwen3-ASR 0.6B int8** by default (`assets/speech/qwen3-asr.json`; best Korean of the exportable models — a 75 s call: Qwen3-ASR near-verbatim, SenseVoice usable, Whisper-base garbled; ~0.35× realtime on an S26), `sense-voice.json` / `whisper-base.json` kept for the `TRANSCRIBE` benchmark hook; any container → 16 kHz PCM through MediaCodec. Changing engine drops old transcripts (`FileIndex.adoptSpeechEngine`) |
| `android/…/llm/Summarizer.java` | the only LLM on the phone: Qwen2.5-1.5B-Instruct (8-bit) on MediaPipe LLM Inference, used solely to summarise transcripts for the call report (`assets/llm/models.json`, ~1.6 GB, optional — without it the report shows topic words) |
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
- **A folder the agent makes is a drive of its own**, not a sub-folder of the
  drive it was collected from. It sits physically inside that folder (the only
  place with a SAF grant), but the shell registers it as its own share (root =
  `buildDocumentUriUsingTree` URI, `SharedFolder.parent`), pairs it, and passes
  every other share's root as `excludeUris` so the parent stops listing it
  (`SafFs` hides excluded doc ids). Share links therefore point at the new
  drive's root, and a file belongs to exactly one drive.
- **Agent sources** (`AgentConfig.source`, drive ids `src-calls` / `src-photos`)
  are folders the agent may *read* for its tasks — Samsung's `Call` recordings
  and `DCIM` — without serving them: a `Conn` with no socket, indexed like a
  drive. Anything made from a source (a collected folder, a report) is written
  into the first shared drive that is on (`AgentService.outputConn`), and its
  `action.driveId` names that drive. With no shared drive on, the task is
  reported as `skipped: "no file access"`.
- **The call report** ("who do I talk to most, and about what" —
  `QueryParser.isCallsTask` → `agent/CallReport`) ranks people by the call log
  (`READ_CALL_LOG`, asked from the action card; without it recordings are
  counted instead), groups `통화 녹음 <who>_yymmdd_hhmmss.m4a` recordings by
  person, transcribes the newest 3 per person on demand (first 3 minutes,
  cached in the index — a call source is never transcribed at index time) and
  writes `Call summary <date>/Call summary.md`. "Usually about" is TF-IDF
  vocabulary across people plus one representative sentence, and the markdown
  says so. When the optional summariser model is present (`llm/Summarizer`),
  each person also gets a 2–3 sentence summary written on the phone from the
  excerpts (cached in the index's `meta` table by transcript set); searches
  never go through the LLM.
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

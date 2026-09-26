# desktop/ — aindrive for Mac

The phone app, on the Mac. The window is the **mobile shell** (`mobile/src`,
built into `shell/`): same screens and features — folders with their P2P
switch, the file browser and viewer, Share / Manage / Agents / Account, chat
with agents. What the phone does natively, the Mac does here: each shared
folder is served by the bundled CLI agent (`cli/` → `cli/aindrive.mjs`) in an
Electron utility process, kept running from the menu bar and restored at login.

| File | Role |
|------|------|
| `src/main.js` | Electron main: the shell window (`app://shell/`), native calls + fetch bridge (IPC), menu-bar icon, login item, `aindrive://` |
| `src/mac-agent.js` | the Mac's **`AindriveAgent`** (the plugin `mobile/src/plugin.ts` declares): start/stop/status via agents.js, folder picker, local file ops, Quick Look, thumbnails, name search for `ask`; phone-only calls reject with a clear message |
| `src/agents.js` | one CLI process per folder (spawner injected); state from its output; restarts, backoff, clean stop. No Electron imports — unit-tested |
| `src/shell/mac-bridge.js` | loaded first in the shell: Capacitor plugin headers + `nativePromise`/`nativeCallback` (so `AindriveAgent`, `CapacitorCookies` are "native"), and `fetch` → main process with the session cookie (CapacitorHttp's job) |
| `src/preload.cjs` | the window's only bridge: `native:call`, `native:event`, `native:fetch` |
| `src/agent/` | **aindrive-on-device** on the Mac: the phone's query understanding ported by hand from `mobile/android/.../agent/` (`router.js`, `query-parser.js`, `social-reply.js`, `geo-lookup.js`; `java-regex.js` pins Java regex semantics), a per-folder file index with EXIF date + GPS → city (`file-index.js`, `indexer.js`), answers and tasks (`ask-runner.js`), and the multi-folder merge (`device-agent.js`). Parity with the phone is tested on the same dialogue benchmark and SGD / Persona-chat guards (`src/__tests__/`) |
| `src/store.js` | `folders.json` in the app's data dir: drives served here, folders picked here |
| `scripts/prepare-shell.mjs`, `prepare-cli.mjs` | build `../mobile` into `shell/` (+ bridge, CSP) and `../cli` into `cli/` |
| `scripts/build-mac.mjs`, `after-pack.cjs`, `dmg/` | `.app` + `.dmg` per arch from Linux or macOS; fuses off; pinned downloads |

State is the CLI's: `<folder>/.aindrive/config.json` holds the drive the shell
paired, so a folder served here and by `aindrive` in a terminal is one drive.
The shell's own state (sign-in, folder list) is its localStorage (Preferences).

## Build

```bash
npm ci && npm test
npm start                 # dev: builds cli + shell, runs Electron
npm run dist:mac          # dist/aindrive-<version>-mac-{arm64,x64}.dmg
```

Releases: `docs/RELEASING.md` (desktop track; tag `desktop-vX.Y.Z` → `.github/workflows/desktop.yml`).
`web/shared/desktop.ts` is where the website's download link points.

## Gotchas

- **Same shell, two devices.** Copy and phone-only features in `mobile/src` go
  through `mobile/src/device.ts` (`ON_MAC`, `DEVICE`). A new `AindriveAgent`
  method needs a Mac version in `mac-agent.js` and a header in `mac-bridge.js`
  (without one it fails as "not implemented on electron", not silently).
- **Not on the Mac (yet):** call-log / camera-roll agent sources, recognition
  models (photo contents, transcripts) and the on-device LLM — `ask` understands
  like the phone but matches by kind, date, place and name only — and Google's
  account picker (sign-in goes through the browser).
- **Handoff links** (files handed to aindrive-cloud): `registerHandoffs` writes
  random keys to `~/.aindrive/handoffs.json` (0600); the bundled CLI serves only
  those keys over `handoff-read` (`cli/src/handoffs.js`).
- **The bundled CLI has no `sharp`:** keep native modules lazily imported in
  `cli/` (as `thumbnail` does) — a top-level import stops every Mac folder connecting.
- **Electron ↔ better-sqlite3 ABI.** The CLI's native module must match
  Electron's ABI and darwin/arch; bump Electron only with the pins in build-mac.mjs.
- **No RunAsNode.** Agents are utility processes; the fuses stay off (after-pack.cjs).
- **Not notarized.** Ad-hoc signed: first open needs System Settings → Privacy
  & Security → **Open Anyway**. Notarizing needs a Developer ID in the workflow.
- `aindrive://` links only open the window; the server is chosen in the shell.

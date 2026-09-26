# desktop/ — aindrive for Mac

A menu-bar app that shares folders with aindrive without a terminal: **Share a
folder…** → pick one → approve in the browser → it is online. It is the
`aindrive` CLI with a window around it: each shared folder runs the bundled CLI
agent (`cli/` → `desktop/cli/aindrive.mjs`) in an Electron utility process, so
pairing, sign-in and serving behave exactly like `npm i -g aindrive`.

| File | Role |
|------|------|
| `src/main.js` | Electron main: window, menu-bar icon, folder picker, `aindrive://share` links, open at login, IPC |
| `src/agents.js` | one CLI process per folder (spawner injected); state from its output (`parseLine`); restarts a paired folder that dies, waits on a missing one. No Electron imports — unit-tested |
| `src/store.js` | the app's settings (`~/Library/Application Support/aindrive/folders.json`): folders, paused, server |
| `src/preload.cjs`, `src/ui/` | the window (sandboxed; talks to main only through `window.aindrive`) |
| `scripts/prepare-cli.mjs` | builds `../cli` and copies its bundle into `cli/` |
| `scripts/build-mac.mjs` | `.app` + `.dmg` per arch, from Linux or macOS (see below); every download pinned by version + sha256 |
| `scripts/after-pack.cjs` | turns off Electron's RunAsNode / NODE_OPTIONS / inspect fuses before signing |
| `scripts/icons.py` | draws `assets/` (app icon, menu-bar template icons) |

State lives where the CLI keeps it: `~/.aindrive/credentials.json` (sign-in)
and `<folder>/.aindrive/config.json` (the drive). A folder shared from the app
and from a terminal is the same drive.

## Build

```bash
npm ci && npm test
npm run dist:mac            # dist/aindrive-<version>-mac-{arm64,x64}.dmg
node scripts/build-mac.mjs arm64
```

On Linux it needs Docker (the DMG toolchain in `scripts/dmg/`: xorrisofs +
libdmg-hfsplus) and downloads `rcodesign` for the ad-hoc signature Apple silicon
requires. On macOS it uses `hdiutil` and `codesign`. Releases: `docs/RELEASING.md`
(desktop track) — `.github/workflows/desktop.yml` builds and attaches the DMGs
on a `desktop-v*` tag; `web/shared/desktop.ts` is where the website's download
link points.

## Gotchas

- **Electron ↔ better-sqlite3 ABI.** The CLI needs better-sqlite3 inside
  Electron's Node, so the prebuilt binary must match Electron's ABI *and*
  darwin/arch — build-mac.mjs fetches it from the better-sqlite3 release. Bump
  Electron only to a major that release ships `electron-v<ABI>-darwin-*` for,
  and add its ABI and hashes to the pins in build-mac.mjs.
- **No RunAsNode.** Agents are utility processes, never `ELECTRON_RUN_AS_NODE`:
  with that fuse on, any local program could run code as this app and inherit
  the folder access the user granted it. Keep the fuses off (after-pack.cjs).
- **Not notarized.** There is no Developer ID yet, so the app is ad-hoc signed:
  the first open needs System Settings → Privacy & Security → **Open Anyway**
  (or `xattr -dr com.apple.quarantine /Applications/aindrive.app`). Notarizing
  needs an Apple Developer ID certificate in the release workflow.
- **`aindrive://` links** come from any web page, so a link may switch the
  server only to the default one or localhost (`handleUrl`).
- Closing the window keeps sharing (menu-bar icon); **Quit** stops every agent.

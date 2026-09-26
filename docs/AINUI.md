# AIN-UI integration

The canonical protocol, catalog, builders and renderers are maintained in
[ainetwork-ai/AIN-UI](https://github.com/ainetwork-ai/AIN-UI) and published as
[`ain-ui`](https://www.npmjs.com/package/ain-ui). See its
[protocol specification](https://github.com/ainetwork-ai/AIN-UI/blob/main/docs/AINUI.md).

Aindrive's `web/shared/a2ui/` modules re-export the package for existing callers.
`web/lib/ainui.ts` injects storage, permission and MIME callbacks. MCP, AG-UI
and A2A negotiate AIN-UI as before. The package's upload action checks the
allow-list and write capability before `write_file`; uploads are limited to
8 MiB on JSON transports. Larger files use aindrive's resumable upload routes.

`GET /api/s/:token` accepts `X-AINUI: 1` and includes the package's payment
surface in `messages`, alongside the unchanged x402 header. Both aindrive's
checkout and ainmem render this surface; wallet signing stays in the host.
`GET /ainui/v1/catalog.json` serves the package's generated catalog.

AIN-UI release changes must be made in the package repository, published,
and then consumed by updating `web/package.json` and its lockfile.

## Drive hosts: phone protocol v2 (aindrive only)

Not part of the ain-ui package: how the device holding a folder talks to aindrive
web, which the `ask` skill relies on.

A **drive host** is the device holding the folder; it answers questions through
the `agent-ask` RPC. The first frame on a host's socket is
`agent-hello {hostname, platform, appVersion, methods, caps}`: `platform` is
`android` | `ios` | `cli`, `methods` every RPC method the host answers, and
`caps: ["ask.v2"]` means it takes the v2 `agent-ask` params:

- `mode: "read"`: no collect / move / delete / write, no call report, the call log is
  not read. An asked-for act comes back as `action: {type, skipped: true, reason:
  "read_only"}` and the answer says it only looked. `"act"` or no `mode`: as before.
  Any other `mode` is refused (`bad_mode`).
- `root`: every source, count and the answer are over files at or below it (exact,
  case-sensitive prefix; NFC or NFD spelling). Normalized like `normalizePath`; `..`
  or a `.aindrive/` root is refused (`bad_root`). In `act` a collected folder is made
  inside `root`, and a call report is refused inside a folder (`reason:
  "outside_root"`).
- `context`: accepted and ignored. The reply adds `action` when the question asked for
  one (never the phone's `folderUri`).

Android advertises `ask.v2` (`mobile/android/…/agent/AskScope.java`). iOS (it refuses
`agent-ask`) and the desktop CLI (its LLM agent has no read-only mode yet) send
`caps: []`, so the server's `ask` skill turns their questions away up front.

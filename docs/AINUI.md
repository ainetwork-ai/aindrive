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
`android` | `ios` | `cli` | `desktop`, `methods` every RPC method the host answers, and
`caps: ["ask.v2"]` means it takes the v2 `agent-ask` params. The Mac app runs the CLI's
agent, so today its drives say `cli`, with `appVersion` the Mac app's own version
(`desktop/package.json`, read next to the bundled agent); no host sends `desktop` yet.
iOS leaves `agent-ask` out of `methods`: it only refuses it, and its `caps: []` already
has the server turn questions away. A host that sent no hello, or no `caps`, has `caps: []`.

- `mode: "read"`: no collect / move / delete / write, no call report, the call log is
  not read. An asked-for act comes back as `action: {type, skipped: true, reason:
  "read_only"}` and the answer says it only looked. Small talk gets a fixed reply (the
  phone's on-device LLM is not started for it). `"act"` or no `mode`: as before.
  Any other `mode` is refused (`bad_mode`).
- `root`: every source, count and the answer are over files at or below it (exact,
  case-sensitive prefix; a file stored in NFC or NFD matches). Normalized like
  `normalizePath`; `..` or a `.aindrive/` root is refused (`bad_root`). Every source
  `path` (and action `files`) comes back in the server's spelling — NFC, no edge
  slashes — so it literally equals `root` or starts with `root + "/"`; the host
  resolves that spelling back to an NFD-named file as it does for any path. In `act` a
  collected folder is made inside `root`, and a call report is refused inside a folder
  (`reason: "outside_root"`).
- `context`: accepted and ignored. The reply adds `action` when the question asked for
  one (never the phone's `folderUri`).
- Sources are paths in the asked drive. A call report (`act`, whole drive) also counts
  the phone's call-recordings folders, which are not drives, but lists as sources only
  recordings inside the asked drive. The server still filters every returned path as
  untrusted input (inside `root`, not a system path, readable at the caller's role).

Android advertises `ask.v2` (`mobile/android/…/agent/AskScope.java`). iOS (it refuses
`agent-ask`) and the desktop CLI (its LLM agent has no read-only mode yet) send
`caps: []`, so the server's `ask` skill turns their questions away up front.

- **Trust assumption.** The frame HMAC does not cover `params`: `web/lib/sig.js`
  canonicalises with a top-level key allowlist, which filters nested keys too. So
  `mode` and `root` are protected by TLS on the host socket and by the server's own
  checks (role and scope before the call, source filtering after it), not by the
  signature. Hosts also keep no `issuedAt` window or `reqId` replay cache yet. Signing
  the full canonical JSON, with the ±120 s window and the replay cache on every host, is
  tracked in `docs/PRODUCTION_TODO.md` §1 and is needed before non-owners rely on read mode.
- **Reply deadlines.** A host drops a reply the server can no longer be waiting for:
  Android admits a response only until the server's timeout for that method, counted
  from when the request arrived, less 2 s — 25 s by default, 120 s for `upload-chunk`,
  `rename` and `download-chunk`, 90 s for `agent-ask` (`mobile/android/…/RpcBudget.java`).
  A new or longer server timeout must be added there too. `RpcBudgetTest` reads every
  `callAgent(` / `sendRpc(` call in `web/` and fails when one gives its method (a string
  literal) more than the phone's budget for that method, when its `timeoutMs` is neither
  a number nor a numeric constant, or when a call whose method is not a literal gets more
  than the default. A timeout passed in through a variable options object is not seen.

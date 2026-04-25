# aindrive

> Local agent for [aindrive](https://aindrive.app) — connects any folder on
> your machine to an aindrive web server through an **outbound** WebSocket.
> No inbound ports are opened. Bytes never leave your machine unless requested
> over a signed RPC.

```
npm i -g aindrive
aindrive login                 # opens browser → paste the one-time code
cd ~/Documents
aindrive
# → opens https://aindrive.ainetwork.ai/d/<drive-id>
```

`aindrive login` opens `https://aindrive.ainetwork.ai/cli-login` in your
browser. Sign in there (if you aren't already), copy the code shown on the
page, and paste it back into the CLI prompt. The code is single-use and
expires in 10 minutes.

## Commands

```
aindrive [folder]          serve a folder (default: current dir)
aindrive login             authenticate this machine with the server
aindrive status [folder]   show drive id, server URL, connection state
aindrive rotate-token      rotate the per-drive agent token
```

## Flags

```
--server <url>   server URL (default: $AINDRIVE_SERVER or https://aindrive.ainetwork.ai)
--name <name>    name for this drive on first pairing
--no-open        do not open the browser
--version        print version
```

## How it works

`aindrive` dials out to the configured server over WSS and waits for signed RPC
calls (`list`, `read`, `write`, `mkdir`, …). Each request carries an HMAC built
from a per-drive secret negotiated at pairing time; the server cannot read or
write files without a valid signature. The server is a relay — it never touches
your disk.

State lives in two places:

- **`~/.aindrive/credentials.json`** — login session for the configured server.
- **`<folder>/.aindrive.json`** — per-folder drive id, secret, and agent token.

Pair a new folder with `aindrive` (uses your global login), or re-attach an
existing drive by running `aindrive` inside a folder that already has
`.aindrive.json`.

## Self-hosting

Point at your own server with `--server` or `AINDRIVE_SERVER`:

```
AINDRIVE_SERVER=https://drive.example.com aindrive login
AINDRIVE_SERVER=https://drive.example.com aindrive ~/work
```

## Requirements

- Node.js ≥ 20

## License

MIT

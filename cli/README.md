# aindrive

> Local agent for [aindrive](https://aindrive.app) — connects any folder on
> your machine to an aindrive web server through an **outbound** WebSocket.
> No inbound ports are opened. Bytes never leave your machine unless requested
> over a signed RPC.

```
npm i -g aindrive
cd ~/Documents
aindrive
# first run: opens browser → click Authorize → folder is served at
# https://aindrive.ainetwork.ai/d/<drive-id>
```

`aindrive` will sign you in on first use. If you prefer to do it explicitly,
`aindrive login` does the same thing — it opens
`https://aindrive.ainetwork.ai/cli-login/<linkId>`, polls for your approval,
and then immediately starts serving the current folder. Each pairing link is
single-use and expires in 10 minutes.

## Commands

```
aindrive [folder]          serve a folder (default: current dir; logs in on first use)
aindrive login             sign in and serve the current folder
aindrive status [folder]   show drive id, server URL, connection state
aindrive rotate-token      rotate the per-drive agent token
aindrive mcp               run a Model Context Protocol stdio server
```

### MCP integration

`aindrive mcp` exposes every drive operation (list/read/write/share/grant
/ask-agent/x402-resolve) to MCP-aware AI assistants — Claude Code, Claude
Desktop, Cursor, etc. The same single npm install enables it; no extra
package needed.

```json
// claude_desktop_config.json or .mcp.json
{
  "mcpServers": {
    "aindrive": { "command": "aindrive", "args": ["mcp"] }
  }
}
```

Auth precedence:
1. `AINDRIVE_SESSION` env (raw `aindrive_session=...` cookie)
2. `AINDRIVE_WALLET_COOKIE` env (raw `aindrive_wallet=...` cookie)
3. `~/.aindrive/credentials.json` from `aindrive login`.

`AINDRIVE_CAP` env attaches a Meadowcap cap to every request; useful for
agents that paid via x402 and want to reuse the cap from another box.

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
- **`<folder>/.aindrive/config.json`** — per-folder drive id, secret, and agent token.
  Same directory also holds `<folder>/.aindrive/willow.db` (Y.Doc updates) and
  `<folder>/.aindrive/yjs/<docId>.bin` (latest snapshots) once the agent runs.

Pair a new folder with `aindrive` (uses your global login), or re-attach an
existing drive by running `aindrive` inside a folder that already has
`.aindrive/config.json`.

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

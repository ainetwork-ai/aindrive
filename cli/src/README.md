# cli/src — internal module map

Source for the `aindrive` local agent: the process that owns the real filesystem
and brokers signed RPC + multi-device sync with the web server over one WSS
connection. **Plain ESM JS, no TypeScript build** (see repo `CLAUDE.md`); types
that overlap with the web side are mirrored by hand with a pointer comment.

For the user-facing guide (install, commands, flags, how it works) see
[`../README.md`](../README.md). This file is the maintainer/agent map of the
internals.

## File map

| File / dir | Responsibility |
|------------|----------------|
| `main.js` | CLI entrypoint — commander wiring of `commands/` |
| `commands/` | one file per verb: `login` `serve` `rotate` `status` `stop` `logs` `mcp` |
| `agent.js` | WS bridge to the server: signed-RPC loop, `fs.watch` change gossip, graceful drain/shutdown. Pure helpers `toWsUrl`/`sanitize` exported for test |
| `agent-runner.js` | local `agent-ask` execution (knowledge fetch + LLM call). The API key never leaves this process — the whole point of running it here |
| `rpc.js` | the RPC dispatch (`handleRpc`): fs `read`/`write`/`list`/`stat`, chunked `upload`/`download`, `yjs-*`, `agent-ask`. Path-escape guard `safeResolve` |
| `willow-store.js` | the `yjs_entries` SQLite store — **authoritative for all reads**; the official Willow `Store` is also written but fire-and-forget / not read back (see Gotchas) |
| `willow-sync.js` | multi-device sync wire protocol over the same WS (`attachSync`): summary → want → give |
| `willow/` | `KvDriverSqlite` + `schemes` backing the official Willow `Store` |
| `sig.js` | HMAC sign/verify of RPC frames — **mirrors `web/lib/sig.js`** (wire-compat) |
| `config.js` | on-disk secret/cred store: drive config + global creds, written `0600` / dir `0700` |
| `api.js` | thin HTTP client (`apiFetch`) to the server |
| `daemon.js` | detached background-agent management (spawn, pid file, logfile) |
| `logger.js` | pino logger |
| `knowledge/` | knowledge-base factory + impls (`resolveKnowledgeBase`) |
| `llm/` | LLM client factory + providers (`resolveLlmClient`) |
| `mcp/` | the `aindrive mcp` MCP server + client / resources / tools |

## Contracts & gotchas

- **`sig.js` ↔ `web/lib/sig.js` must stay byte-compatible** — `__tests__/sig.test.mjs`
  imports the web copy and round-trips against it. Signed payloads should stay flat
  (canonicalisation does not recurse — see the `sig.js` header).
- **`willow-store.js`: the `yjs_entries` mirror is the source of truth for reads**;
  the Willow `Store` write is write-only decoration today.
- **Known bugs** (tracked, not fixed here): `rotate-token` is dead (cred field-name
  drift) — see [`../../docs/PRODUCTION_TODO.md`](../../docs/PRODUCTION_TODO.md)
  "Known bugs".
- **Tests**: vitest (`npm test`). `__tests__/*.test.mjs` includes characterization
  suites that snapshot current behaviour (added during the agent-first migration);
  `QUIRK`/`CURRENT BEHAVIOUR`-labelled cases lock intentional-looking oddities so a
  later fix surfaces as a deliberate change.

## Related

- [`../README.md`](../README.md) — product/user guide
- [`../../docs/PRODUCTION_TODO.md`](../../docs/PRODUCTION_TODO.md) — known bugs + hardening
- [`../../docs/RELEASING.md`](../../docs/RELEASING.md) — npm release process

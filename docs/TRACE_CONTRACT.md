# Trace observability — standard structured logging

aindrive uses **structured JSON stdout logs + in-memory ring buffer** (12-factor app pattern). No file writes.

## Event shape

Every event across browser/server/agent uses the same shape:

```json
{
  "level":  "info",
  "ns":     "aindrive.trace",
  "t":      1734567890123,
  "docId":  "X9aB-22charBase64url",
  "session":"S-tab1-1234",
  "src":    "browser|server|agent|cli",
  "event":  "ydoc-update",
  "origin": "local|remote|disk-seed|idb-restore",
  "byteLen":47,
  "textLen":102,
  "svBefore":"sha:abcd",
  "svAfter": "sha:efgh",
  "extra":  {}
}
```

## Where events go

1. **stdout** as single-line JSON — captured by any log aggregator (journald, datadog, loki, vector, plain shell).
2. **In-memory ring buffer** (10k events, configurable via `AINDRIVE_TRACE_RING_SIZE`) — queryable live.

## Endpoints

- `POST /api/dev/trace`  — accepts `{...event}` or `[{...event}, ...]`. Browser/CLI agents push events here.
- `GET  /api/dev/trace`  — `{ enabled, ring: { size, max } }`
- `GET  /api/dev/trace/dump?docId=X&since=ms&limit=500` — query ring buffer

## Toggle

- `AINDRIVE_TRACE=off` → all calls are no-ops (production default).
- `AINDRIVE_TRACE=on`  (default in dev) → events flow.

## Live debugging

```bash
# Live tail (server stdout)
node server.js 2>&1 | jq 'select(.ns == "aindrive.trace")'

# Filter by doc
node server.js 2>&1 | jq 'select(.ns == "aindrive.trace" and .docId == "X9aB...")'

# Snapshot via API
curl 'http://localhost:3737/api/dev/trace/dump?docId=X9aB&limit=200' | jq

# Run analyzer on the snapshot
curl -s 'http://localhost:3737/api/dev/trace/dump?docId=X9aB&limit=2000' \
  | jq -c '.events[]' \
  | node tools/diagnose.mjs --stdin
```

## Event taxonomy

(same as before — only the transport changed)

### browser
- `provider-connect`, `provider-disconnect`, `provider-sub-ok`
- `idb-load`, `whenReady-resolved`
- `ydoc-update`, `awareness-update`
- `disk-seed-skip`, `disk-seed-apply`, `yjs-pull-apply`
- `autosave-trigger`, `autosave-flush`
- `reload-event`

### server
- `ws-doc-sub`, `ws-doc-unsub`, `ws-doc-fwd`
- `agent-connect`, `agent-disconnect`
- `rpc-out`, `rpc-in-resp`

### cli (agent)
- `rpc-handle`, `disk-write`, `willow-append`, `willow-replay`, `fs-changed`

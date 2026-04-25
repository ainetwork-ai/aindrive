# aindrive Concurrent Editing — Design

> Replace the current "last write wins" save flow with real-time multi-user editing using **Y.js (CRDT) over WebSocket**, with optional **Willow Store** backing for multi-device persistence.

## What we have today

- Single agent per drive, all browser tabs talk to the same agent over the existing custom server (`/api/agent/connect`).
- File save = `POST /api/drives/:id/fs/write` → `agent.handleRpc('write')` → `fsp.writeFile`.
- Two simultaneous saves race; the later one wins. No cursor presence, no character-level merge.

## Goals

1. **Two browser tabs editing the same Markdown / text / code file see each other's keystrokes within ~100 ms.**
2. **Cursor + selection presence** for every connected editor.
3. **Disk file stays canonical** — saving still produces a normal UTF-8 file on disk that any other tool can read.
4. **Offline tolerance** — a tab that loses the WebSocket can keep editing locally and reconcile on reconnect.
5. **Multi-device on the same drive** — eventually a second machine running `aindrive` against the same drive can sync edits via Willow.

## Stack decisions

| Layer | Choice | Why |
|---|---|---|
| CRDT | **Y.js** (`yjs`) | Battle-tested, char-level merging, native Monaco binding (`y-monaco`), Awareness API, small wire format |
| Editor binding | **y-monaco** | Monaco is already our editor; binding is one line |
| Provider (transport) | **Custom WebSocket** layered over our existing `/api/agent/doc/:driveId/:encodedPath` endpoint | Reuse Next.js custom server; same auth path; no extra port |
| Awareness | **y-protocols/awareness** | Cursors, selections, user name+color, ephemeral (not persisted) |
| Browser persistence | **y-indexeddb** | Lets a tab keep editing while the WS is dead |
| Server persistence (v1) | **`.aindrive/yjs/<sha>.bin`** beside the drive root | Simple, debuggable, can be deleted at any time without losing the underlying text file |
| Server persistence (v2) | **Willow Store + KvDriver(SQLite)** | Multi-device sync via WGPS; each Y.update becomes a Willow entry |
| File on disk | UTF-8 text written from `Y.Doc.toString()` on save | Stays compatible with `cat`, `git`, every other tool |

## Architecture

```
┌─────────────────────────────────┐                    ┌──────────────────────────┐
│  Browser tab A                  │                    │  Browser tab B           │
│  Monaco ⇄ Y.Doc ⇄ y-monaco      │                    │  Monaco ⇄ Y.Doc ⇄ y-mon. │
│                  ⇄ y-indexeddb  │                    │                          │
│           ⇄ AindriveProvider    │                    │  ⇄ AindriveProvider      │
└──────────────┬──────────────────┘                    └──────────┬───────────────┘
               │                                                  │
               │  WSS /api/agent/doc?drive=X&path=foo.md         │
               ▼                                                  ▼
       ┌────────────────────────────────────────────────────────────────┐
       │          Next.js custom server (server.js)                      │
       │  ─ DocHub: per-(driveId, path) Map<wsId, WebSocket>             │
       │  ─ Multiplexes Y.js sync messages across all subscribers        │
       │  ─ Forwards new updates to the CLI agent for persistence        │
       └────────────────────────────┬───────────────────────────────────┘
                                    │  WS frame: { type:'doc-update',
                                    │              path, update: <bytes> }
                                    ▼
                        ┌─────────────────────────────┐
                        │  CLI agent                  │
                        │  Stores .aindrive/yjs/X.bin │
                        │  (v2: Willow Store)         │
                        │  On save, writes text file  │
                        └─────────────────────────────┘
```

### Wire protocol (WSS frames)

```
client → server
  { t: 'sub',    docId }           // subscribe (server replies with current state vector)
  { t: 'sync',   docId, msg }      // y-protocols sync message (state vector / update)
  { t: 'aware',  docId, msg }      // y-protocols awareness update

server → client
  { t: 'sync',   docId, msg }      // forwarded from another peer or from agent
  { t: 'aware',  docId, msg }      // forwarded awareness update
  { t: 'sub-ok', docId }           // ack with initial state included
```

`docId = base64url(sha1(driveId + ':' + path))` — keeps the wire small and avoids leaking paths.

### Save semantics

Save (Cmd-S in the editor or autosave debounce) does **two** things:
1. `agent.persistYjs(docId, Y.encodeStateAsUpdate(doc))` — writes `.aindrive/yjs/<docId>.bin`.
2. `agent.writeFile(path, doc.toString())` — overwrites the canonical text file.

If the agent is offline, the Y.Doc keeps mutating in-browser (y-indexeddb) and queues updates on the provider. On reconnect, the queue flushes.

### Conflict edge cases

- **Two users save simultaneously** → both updates merge in Y.Doc (CRDT), both writes to disk produce the same final text.
- **External tool edits the file on disk while a tab has it open** → on next FS poll (or fs.watch), agent invalidates Y.Doc, broadcasts `{ t: 'reload' }` to subscribers; the tab reloads and discards in-memory CRDT state. (Cmd-Z history lost — surface a warning toast.)
- **Two devices offline, both edit, both reconnect** → CRDT merges, last text representation is union.

## Security

- The `/api/agent/doc` WS endpoint inherits the same auth as `/api/drives/:id/fs/*`: requires session cookie OR wallet cookie with folder_access (role ≥ editor for write, viewer for read-only follow).
- Subscribers with role `viewer` get sync messages but server rejects their outbound `sync` updates (read-only mode in y-monaco).
- Y.js updates are framed bytes — server treats them as opaque, never parses contents (no injection surface).

## What is **NOT** in scope for this milestone

- Operational transform fallback (Y.js only)
- Binary file collaborative editing (only text/Markdown/code in Monaco)
- Conflict UI for the disk-edit-while-open case (just warn + reload)
- Permission re-check on every keystroke (only at WS subscribe time; revocations take effect on next subscribe)

## Open questions

1. **Save trigger.** Always autosave on debounce, or only on Cmd-S? Default: **autosave 5 s after last keystroke** + on tab close.
2. **Y.doc binary GC.** Keep `.aindrive/yjs/*.bin` forever, or prune entries older than N days with no edits? Default: keep forever in v1.
3. **Username/color source.** Use `users.name` for logged-in sessions, `0xXXXX…XXXX` truncated wallet for visitors? Default: yes, hash address → color.
4. **Willow Store rollout.** Is multi-device sync v2 or much later? Default: separate milestone after v1 ships.

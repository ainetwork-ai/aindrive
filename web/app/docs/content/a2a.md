# A2A — Agent2Agent

aindrive is a single A2A agent (protocol **v0.3**, JSON-RPC transport).

| | |
|---|---|
| Agent card | `GET {{BASE}}/.well-known/agent-card.json` |
| Endpoint | `POST {{BASE}}/a2a` — `message/send`, `message/stream` (SSE) |
| Auth | `Authorization: Bearer <token>` — see [Authentication](/docs/auth). A drive token pins every call to its drive. |
| Extensions | A2UI `https://a2ui.org/a2a-extension/a2ui/v0.9` |

## Asking for something

A message can ask in three ways (first match wins):

**1. DataPart skill call** — explicit, typed ([skills](/docs/skills)):

```json
{ "kind": "data", "data": { "skill": "read_file", "drive_id": "<driveId>", "path": "notes/todo.md" } }
```

(`drive_id` is optional with a drive token.)

**2. A2UI action** — a click from a surface you rendered:

```json
{ "kind": "data", "data": { "version": "v0.9", "action": {
    "name": "aindrive.open", "surfaceId": "…", "sourceComponentId": "item_open",
    "timestamp": "2026-09-24T10:00:00Z",
    "context": { "drive_id": "<driveId>", "path": "notes", "is_dir": true } } } }
```

**3. Text command**

| Text | Skill |
|---|---|
| `drives` | `list_drives` |
| `ls <path>` | `list_files` |
| `cat <path>` / `open <path>` | `read_file` |
| `stat <path>` | `stat` |
| `find <query>` / `search <query>` | `search` |
| anything else | filename `search` (drive tokens) / `list_drives` (account tokens) |

## Reply

```json
{ "kind": "message", "role": "agent", "parts": [
  { "kind": "text", "text": "📁 notes\n📄 a.md" },
  { "kind": "data", "data": { "entries": [ … ] } },
  { "kind": "data", "data": [ …A2UI messages… ],
    "metadata": { "mimeType": "application/a2ui+json" } }     ← only with A2UI
]}
```

Errors come back as a message with `metadata.error: true` and the reason in the
text part (e.g. `[forbidden] …`).

## Getting UI: the A2UI extension

Activate it with the header (or send `metadata.a2uiRendererCapabilities` in
the message):

```bash
curl -s {{BASE}}/a2a \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'X-A2A-Extensions: https://a2ui.org/a2a-extension/a2ui/v0.9' \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{
        "kind":"message","role":"user","messageId":"m1",
        "parts":[{"kind":"text","text":"ls"}]}}}'
```

The response echoes `X-A2A-Extensions` and adds the `application/a2ui+json`
DataPart — feed it to any A2UI renderer ([A2UI](/docs/a2ui)). When the user
clicks, send the resulting `action` back as shown above; A2UI is kept on
automatically for replies to actions.

## Streaming

`message/stream` returns `text/event-stream`; each `data:` line is a JSON-RPC
response whose `result` is the agent message (or task events).

## JavaScript client

```ts
import { A2AClient } from "@a2a-js/sdk/client";

const client = await A2AClient.fromCardUrl("{{BASE}}/.well-known/agent-card.json", {
  fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } }),
});
const res = await client.sendMessage({
  message: { kind: "message", role: "user", messageId: crypto.randomUUID(),
             parts: [{ kind: "data", data: { skill: "search", query: "invoice" } }] },
});
```

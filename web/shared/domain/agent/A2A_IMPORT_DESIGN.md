# A2A URL Import — design

Status: draft v6 (browser-only client). First import target is
Whisper STT at `http://localhost:8000/.well-known/agent-card.json`,
trigger is the browser microphone, mediator is **the browser itself**.

## v6 in one paragraph

The browser owns the whole flow: it imports the A2A card, holds the
mic, opens a WebSocket to the agent's `transcribe_stream` skill,
streams PCM, receives partial/final JSON frames, and writes the final
transcript to the drive via the existing `POST /api/drives/<id>/fs/
write` endpoint. **No new aindrive backend code.** No MCP. No
pre-signed URLs. No proxy. The only possible backend addition is a
~20-line CORS-workaround proxy for the *initial card fetch* (see
§ CORS below).

## Why no backend changes

The audio never enters aindrive's process. Transcript text uses an
endpoint we already have. Agent metadata fits in the browser
(localStorage for v1; optionally written to the drive as a JSON
file for cross-device sync in v1.1). The whole feature is one React
component plus an AudioWorklet plus a small typed schema for the
imported card. Shipping surface ≈ a single PR to `web/components/`.

## Architecture

```
┌────────────────────────────────────────────────┐
│  browser tab (drive UI)                        │
│                                                │
│  ┌─────────────────────────────────────────┐   │
│  │  Import modal                           │   │
│  │   1. paste card URL                     │   │
│  │   2. fetch card (CORS — see below)      │   │
│  │   3. parse + pick skill                 │   │
│  │   4. save to localStorage               │   │
│  └─────────────────────────────────────────┘   │
│                                                │
│  ┌─────────────────────────────────────────┐   │
│  │  Record widget                          │   │
│  │   getUserMedia → AudioWorklet → ws──┐   │   │
│  │                                     │   │   │
│  │   collects partials → finals       │   │   │
│  │   on Stop:                          │   │   │
│  │     fetch POST /api/drives/<id>/    │   │   │
│  │            fs/write   (transcript)  │   │   │
│  └─────────────────────────────────────┴───┘   │
└──────────────────────────────────────────┬─────┘
                                           │
                                           │ ws(s)://...
                                           ▼
                                ┌──────────────────────┐
                                │  Whisper agent       │
                                │  /ws/stream          │
                                └──────────────────────┘
```

aindrive web's only contribution: it serves the React app and accepts
the existing `fs/write` POST.

## CORS — yes there's a problem, but only on the card fetch

Two cross-origin hops to think about:

### 1. Fetching the agent card — **likely blocked, needs workaround**

`fetch("http://localhost:8000/.well-known/agent-card.json")` from a
page served at `http://localhost:3000` (or whatever aindrive runs on)
is a cross-origin **HTTP** request. The browser sends a "simple"
GET with no preflight, but the response must carry
`Access-Control-Allow-Origin: *` (or our exact origin) for JS to
read the body. **Whisper almost certainly doesn't set this header**
unless the maintainer explicitly enabled CORS. Without it, the
`fetch()` resolves but `response.json()` throws an opaque-response
error.

Two solutions:

  - **(A) Agent-side fix.** Ask Whisper maintainer to add
    `Access-Control-Allow-Origin: *` on the `/.well-known/agent-card
    .json` route. One line of Python middleware. This is what the
    A2A spec *should* recommend — the whole point of `.well-known/
    agent-card.json` is browser discovery.

  - **(B) Aindrive-side workaround.** Add a thin backend proxy:

    ```
    GET /api/a2a/fetch-card?url=<encoded url>
    → server-side fetches the URL with SSRF guard, returns body.
    ```

    Browser calls our proxy, gets the JSON, parses. ~20 lines, same
    SSRF guard we already need anywhere we accept user URLs.

    For dev with localhost agents this is also where we
    deliberately allow loopback (otherwise SSRF guard kills the
    fetch). Same toggle from v4.

I'd ship **(B) immediately** as the universal path (don't make
adoption depend on every A2A author adding CORS), and lobby for (A)
in the A2A spec so the proxy isn't necessary forever.

### 2. The WebSocket — **almost certainly fine**

`new WebSocket("ws://localhost:8000/ws/stream")` from `http://
localhost:3000` is cross-origin, but **WebSocket has no preflight
and no CORS in the HTTP sense**. The browser sends an Upgrade
request with an `Origin` header, and the server may inspect it. Most
WS frameworks don't check by default; some do (Tornado, Socket.io
with strict options). Whisper's `transcribe_stream` description
mentions only the protocol — no Origin enforcement implied. **In
practice this just works** for the localhost case.

If a future hosted Whisper does enforce Origin, the fix is allow-
listing aindrive's prod origin on the server — same one-liner.

### 3. Mixed content — **production blocker, not a v1 dev blocker**

When aindrive serves itself over `https://` (production), Chrome and
Firefox block `ws://` connections initiated from that page as mixed
content. Today aindrive in dev is `http://localhost:3000`, Whisper
is `ws://localhost:8000` — fine. For prod we need Whisper on
`wss://`. That's an agent-operator concern, not ours.

So: **v1 ships with a backend CORS-workaround proxy for card fetch
only.** WebSocket goes direct. No mixed-content issue in dev.

## What we save where

  - **Imported agents list** — localStorage key
    `aindrive.remoteAgents.v1`, scoped per drive: `{ [driveId]:
    RemoteAgent[] }`. Survives reloads, not cross-device. Good
    enough for v1. v1.1 can mirror to `.aindrive/remote-agents.json`
    on the drive.

  - **Transcripts** — drive at `${output.folder}/${renderedFilename}`
    via existing `fs/write`. Same auth as everything else (owner
    session cookie). No special path needed.

That's it. No new tables, no new server routes (except the card-
fetch proxy), no new database schema.

## Domain shape — kept minimal

```ts
// web/shared/contracts/a2a.ts (new, small)
export type A2AImportedCard = {
  name: string;
  description: string;
  version: string;
  protocolVersion: string;
  url: string;
  preferredTransport: "JSONRPC" | "HTTP+JSON" | "GRPC";
  capabilities?: { streaming?: boolean; pushNotifications?: boolean };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    inputModes?: string[];
    outputModes?: string[];
    tags?: string[];
  }>;
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  iconUrl?: string;
};
```

```ts
// web/components/record-widget.tsx — local types only

type ImportedRemoteAgent = {
  id: string;             // local uuid
  driveId: string;
  cardUrl: string;        // for re-sync UI
  card: A2AImportedCard;  // raw, untrusted
  skillId: string;        // picked at import time

  // Derived & locked at import time:
  wsUrl: string;          // from skill description / card.url
  configFrame: Record<string, unknown>;
  output: {
    folder: string;
    filenameTemplate: string;
    frontmatterTemplate?: string;
  };
  importedAt: number;
};
```

For Whisper the concrete record is:

```ts
{
  id: "<uuid>",
  driveId: "<drive-id>",
  cardUrl: "http://localhost:8000/.well-known/agent-card.json",
  card: { /* …raw fetched card… */ },
  skillId: "transcribe_stream",
  wsUrl: "ws://localhost:8000/ws/stream",
  configFrame: { sample_rate: 16000 },   // language: auto by default
  output: {
    folder: "transcripts",
    filenameTemplate: "{date}-{title}.md",
    frontmatterTemplate:
      "---\nrecorded_at: {date}\ntranscribed_by: {agentName}\n---\n\n",
  },
  importedAt: 1731600000000,
}
```

`wsUrl` is parsed out of the skill description on import (regex /
URL-finder). If parsing fails, the import modal asks the owner to
paste it manually before saving.

## Browser pipeline (record widget)

1. `navigator.mediaDevices.getUserMedia({ audio: true })`.
2. Wire to an `AudioWorkletNode` that:
   - downsamples to 16 kHz mono via simple decimation (or
     `OfflineAudioContext` for higher quality if needed)
   - quantizes Float32 → Int16 LE
   - posts 100 ms chunks (3200 bytes) via `port.postMessage`
3. `const ws = new WebSocket(agent.wsUrl); ws.binaryType =
   "arraybuffer"; ws.onopen = () => ws.send(JSON.stringify(agent.
   configFrame));`
4. Chunk handler: `ws.send(buffer);`
5. `ws.onmessage`: parse JSON, switch on `type`:
   - `partial` → set `partialText` in UI state
   - `final` → append `text` to `finalText`, clear `partialText`
   - `error` → surface to UI, stop recording
6. On Stop:
   - `ws.send(JSON.stringify({ action: "stop" }));`
   - wait for one final `final` frame (Whisper guarantees a flush)
   - `ws.close()`
   - render filename + frontmatter, POST to `/api/drives/<id>/fs/
     write` with the markdown body
   - close widget

Total browser code estimate: ~250 lines TSX (widget + worklet host)
+ ~60 lines worklet processor JS.

## Files we'll add/touch (v6 — confirmed minimal)

- `web/shared/contracts/a2a.ts` — `A2AImportedCard` type. **new**.
- `web/lib/audio/pcm-worklet.ts` — AudioWorklet processor. **new**.
- `web/lib/remote-agents.ts` — localStorage helpers + skill
  inference. **new**.
- `web/app/api/a2a/fetch-card/route.ts` — CORS-workaround proxy with
  SSRF guard + dev loopback toggle. **new** (only backend change).
- `web/components/import-a2a-modal.tsx` — paste URL → fetch → pick
  skill → save. **new**.
- `web/components/record-widget.tsx` — mic + WS + transcript +
  save. **new**.
- `web/components/drive-shell.tsx` — mount a 🎙 button in the
  toolbar; clicking opens the record widget if any
  `browser-stream` agent is imported, otherwise opens the import
  modal. **touched**.
- No changes to: agent domain types, agent repo, existing
  `/agents` routes, the CLI, the create-local-agent modal.

## Open questions

1. **CORS workaround route name.** `/api/a2a/fetch-card?url=…`
   seems right. Method GET, response is JSON pass-through. Add
   `?force-loopback=1` for the localhost dev toggle, gated by
   server env `AINDRIVE_ALLOW_LOOPBACK_A2A=1`. OK?

2. **Mic permission.** Request on click of 🎙, not on page load.
   v1 doesn't ask up front. OK?

3. **WS reconnect.** If the WS drops mid-recording, do we
   reconnect and resume (sending Whisper a hint to "continue"), or
   stop and save what we have? v1 = stop and save. Confirm.

4. **Audio resampling quality.** Simple decimation is fine for
   16 kHz output from a 48 kHz mic input (factor of 3); we should
   low-pass filter first to avoid aliasing. Worklet has 80 lines.
   OK?

5. **Title input.** v1 = optional text field in the widget. Empty
   → filename uses `{date}-{ts}.md`. OK?

6. **Drive list refresh after save.** Best UX is to refresh the
   folder view and highlight the new transcript file. We have an
   existing fs-changed event channel for the WS sync — should the
   record widget trip it on save, same as a normal upload? Yes
   unless there's a reason not to.

## v1.1 backlog (not blocking)

  - Batch transcribe of existing audio files (Whisper's
    `transcribe` skill, byte-proxy via aindrive backend — only
    feature that needs the proxy path).
  - Cross-device sync of imported agents (mirror to drive
    `.aindrive/remote-agents.json`).
  - Partial transcript snapshotting every N seconds for crash
    safety.
  - Production hosted Whisper (`wss://`, origin allow-list).

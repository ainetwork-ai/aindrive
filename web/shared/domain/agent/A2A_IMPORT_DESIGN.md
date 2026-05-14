# A2A URL Import — design

Status: draft v4 (Whisper-compatible). The first agent we'll import
is **Whisper STT** at `http://localhost:8000/.well-known/agent-card.json`.
This draft is shaped around what that card actually looks like; the
MCP-mediated future path from v3 is preserved as a flagged variant.

## The card we have to import

Pretty-printed:

```jsonc
{
  "name": "Whisper STT Agent",
  "version": "0.2.0",
  "protocolVersion": "0.3.0",
  "description": "Speech-to-text agent powered by faster-whisper …",
  "url": "http://localhost:8000",
  "preferredTransport": "JSONRPC",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": [
    "audio/wav", "audio/mpeg", "audio/mp4", "audio/webm",
    "audio/ogg", "audio/flac", "application/octet-stream"
  ],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "transcribe",
      "name": "Transcribe audio",
      "description": "Batch transcription. Send a FilePart (base64 bytes
        + mime_type). Optionally include a DataPart with {language,
        task, align}. task='transcribe'|'translate' (translate →
        English). language is an ISO 639-1 code …",
      "inputModes": ["audio/wav", "audio/mpeg", "audio/mp4",
                     "audio/webm", "audio/ogg", "audio/flac"],
      "outputModes": ["text/plain", "application/json"],
      "tags": ["speech","stt","whisper","audio","transcription",
               "korean","multilingual"]
    },
    {
      "id": "transcribe_stream",
      "name": "Transcribe live audio (streaming)",
      "description": "Real-time streaming transcription over WebSocket
        at `ws://localhost:8000/ws/stream` …",
      "inputModes": ["audio/pcm;rate=16000;channels=1;encoding=…"],
      "outputModes": ["application/json", "text/event-stream"]
    }
  ]
}
```

Four facts this card forces:

1. **The card shape does NOT match our `AindriveAgentCard` type.** A2A
   v0.3 publishes `url` + `preferredTransport` (+ optional
   `additionalInterfaces[]`) and **no** `supportedInterfaces[]` /
   `securitySchemes` / `provider` / `documentationUrl` / `iconUrl`.
   We need a separate type for *imported* cards and a mapper into our
   own re-emit shape.

2. **No MCP affordance.** Whisper takes audio bytes inline in a
   FilePart. It will not call back into our MCP for the bytes. The
   MCP-mediated v3 path **does not apply** to this agent.

3. **JSON-RPC is the wire.** `preferredTransport: "JSONRPC"` +
   spec's `message/send` method. We need a JSON-RPC 2.0 outbound
   client, not a plain `POST {q}`.

4. **Localhost.** `url: "http://localhost:8000"` will be blocked by
   any sane SSRF filter. We need an explicit dev-mode flag to allow
   loopback imports.

## v1 decision: byte-proxy with binding

The MCP-mediated handoff (v3) is the right *future* architecture, but
it requires the upstream agent to be MCP-capable. Whisper isn't.

For v1 we ship the **byte-proxy** path:

  - aindrive reads input file from the drive.
  - aindrive POSTs JSON-RPC `message/send` to the upstream `url` with
    a FilePart carrying base64 bytes (+ optional DataPart for
    skill-specific params).
  - aindrive writes upstream's text response back to a drive folder.

We keep the v3 MCP-mediated branch reserved by giving `RemoteAgent` a
`mediation` discriminator. v1 ships only `proxy-bytes`. MCP support
gets added when we have an agent that wants it.

## Domain shapes

### Imported card (incoming, A2A v0.3-aligned)

```ts
// web/shared/contracts/a2a.ts (new file)
export type A2AImportedCard = {
  name: string;
  description: string;
  version: string;
  protocolVersion: string;          // e.g. "0.3.0"
  url: string;                       // base URL = the RPC endpoint
  preferredTransport: "JSONRPC" | "HTTP+JSON" | "GRPC";
  additionalInterfaces?: Array<{
    url: string;
    transport: "JSONRPC" | "HTTP+JSON" | "GRPC";
    protocolVersion?: string;
  }>;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    inputModes?: string[];
    outputModes?: string[];
    tags?: string[];
    examples?: string[];
  }>;
  /** v0.3 optional auth — Whisper omits it, so we treat absence = public. */
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  iconUrl?: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
};
```

We keep this type separate from `AindriveAgentCard` so each is free
to follow its own spec target. The mapper that re-emits an imported
agent's card under our base URL goes from `A2AImportedCard` →
`AindriveAgentCard`.

### `RemoteAgent`

```ts
// web/shared/domain/agent/types.ts

export type Agent = LocalAgent | RemoteAgent;

export type LocalAgent = {
  kind: "local";
  // ... existing fields unchanged ...
};

export type RemoteAgent = {
  kind: "remote";
  id: AgentId;
  driveId: DriveId;
  ownerId: UserId;

  /** Display, copied from card at import time. */
  name: string;
  description: string;

  /** Source of truth for re-sync. */
  cardUrl: string;
  /** The endpoint we actually call (derived from card url + chosen interface). */
  endpointUrl: string;
  transport: "JSONRPC" | "HTTP+JSON";
  /** A2A method to invoke. v0.3 = "message/send". */
  method: string;
  /** Upstream skill id we target. Drives DataPart construction. */
  skillId: string;

  mediation:
    /** v1: aindrive reads input from drive, forwards as FilePart;
     *      writes upstream text response back to drive. */
    | { kind: "proxy-bytes"; io: RemoteAgentIo }
    /** v2 placeholder: hand the upstream a scoped MCP cap; it does I/O itself. */
    | { kind: "mcp-handoff"; mcpScope: McpScope; mcpCapEnc: string };

  /** Cached imported card for our /.well-known echo and re-sync UI. */
  importedCard: A2AImportedCard;
  cardFetchedAt: number;

  access: AccessConfig;
  createdAt: number;
};

export type RemoteAgentIo = {
  input:
    /** Inbound `/ask` body has `{ q: string }`. We send a TextPart. */
    | { mode: "text" }
    /** Inbound body has `{ inputPath }`. We read drive file as bytes,
     *  send as FilePart. STT and OCR use this. */
    | {
        mode: "drive-file";
        acceptMimeTypes: string[];
        /** Skill-specific tuning passed as a DataPart sibling of the file.
         *  For Whisper: { language?: "ko", task?: "transcribe", align?: bool }. */
        dataPart?: Record<string, unknown>;
      };

  output:
    | { mode: "echo" }
    | {
        mode: "drive-file";
        folder: string;
        /** Template tokens: {base}, {ts}, {date}, {skillId}, {lang}. */
        filenameTemplate: string;
        /** Where in the JSON-RPC result to pull text from. v0.3 is typically
         *  result.message.parts[*] where kind === "text". This selector keeps
         *  us robust to agents that wrap differently. */
        textSelector?:
          | { kind: "a2a-message-parts" }       // v0.3 default
          | { kind: "json-path"; path: string }; // fallback
      };
};

export type McpScope = {
  readPaths: string[];
  writePaths: string[];
  expiresAt?: number;
};
```

For **Whisper specifically**, the persisted `mediation` is:

```ts
{
  kind: "proxy-bytes",
  io: {
    input: {
      mode: "drive-file",
      acceptMimeTypes: ["audio/wav","audio/mpeg","audio/mp4",
                        "audio/webm","audio/ogg","audio/flac"],
      dataPart: { task: "transcribe" }   // language omitted → auto-detect
    },
    output: {
      mode: "drive-file",
      folder: "transcripts",
      filenameTemplate: "{base}.transcript.md",
      textSelector: { kind: "a2a-message-parts" }
    }
  }
}
```

## Outbound wire format (Whisper-compatible)

We POST to `endpointUrl` (= the card's `url`, since v0.3 puts the
JSON-RPC endpoint at the base):

```http
POST http://localhost:8000  HTTP/1.1
Content-Type: application/json
Accept: application/json
```

Body:

```jsonc
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "messageId": "<uuid>",
      "parts": [
        { "kind": "file", "file": {
            "name": "meeting.m4a",
            "mimeType": "audio/mp4",
            "bytes": "<base64 audio>"
        }},
        { "kind": "data", "data": { "task": "transcribe" } }
      ]
    },
    "configuration": {
      "acceptedOutputModes": ["text/plain", "application/json"]
    }
  }
}
```

Expected response (per A2A v0.3 + the skill's description):

```jsonc
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "result": {
    "id": "<task or message id>",
    "kind": "message",
    "role": "agent",
    "parts": [
      { "kind": "text", "text": "<the full transcript>" }
    ]
    // (or kind: "task" with status / message, depending on which v0.3
    //  shape Whisper actually emits — see Open Q1 below)
  }
}
```

Our extractor walks `result.parts[*]` for `kind === "text"` and
concatenates. If `result` is a Task envelope instead, we walk
`result.status.message.parts[*]` and `result.history[*].parts[*]`.
The selector type makes that policy explicit and overridable.

## Localhost / dev import mode

Whisper is at `http://localhost:8000`. Without an opt-in we **must
reject** loopback URLs at import time — once persisted, the agent JSON
travels with the drive (export, copy to another host) and an
unauthenticated localhost URL becomes a footgun.

Proposal:
  - Import modal exposes an explicit toggle: **"This is a local
    development agent (allow loopback)"** off by default.
  - When on, we still:
    - require the agent to be in the importing owner's own drive,
    - prefix the agent name with a `[local]` badge in the UI,
    - reject the agent JSON from being re-emitted via our own
      `/.well-known/agent-card.json` (the public card route 404s for
      loopback-mediated agents).

  - When off, hostname must resolve to a non-private/non-loopback
    address, and TLS is required.

## Card URL canonicalization

We tried `http://localhost:8000/.well-known/agent-card.json` and it
returned the card directly, so we accept that shape. If owner pastes
`http://localhost:8000` we GET it; if the response is HTML/404 we
retry with `/.well-known/agent-card.json` appended. Same logic for
non-local URLs.

## Import flow, step by step

1. Owner pastes `http://localhost:8000/.well-known/agent-card.json`
   and ticks "Local development agent".
2. Server-side, route POST `/api/drives/[driveId]/agents/import`:
   a. SSRF check **bypassed** for loopback only when the flag is on.
   b. GET card with 5s timeout, ≤64KB body.
   c. Parse against `A2AImportedCard`.
   d. `security` empty/absent → allowed (public).
   e. Pick first skill where `outputModes` contains a text type AND
      `inputModes` contains at least one MIME we recognize. For
      Whisper, this is `transcribe` (the streaming one would also
      qualify but JSON-RPC text-out > WebSocket for v1; we explicitly
      skip skills whose inputModes are PCM streams).
   f. Infer the binding: input `drive-file` with the skill's audio
      MIME list; output `drive-file` with default folder
      `"transcripts"` and template `"{base}.transcript.md"`.
   g. Owner is shown the inferred binding and may override:
      - output folder
      - filename template
      - DataPart presets (`{ language: "ko", task: "transcribe" }`)
   h. Persist `RemoteAgent` with `mediation.kind = "proxy-bytes"`.
3. Owner drops `recordings/meeting.m4a` in the drive, clicks
   "Transcribe with Whisper STT Agent" from the file's row menu.
4. Route POST `/api/drives/.../agents/<id>/ask` with
   `{ inputPath: "recordings/meeting.m4a" }`.
5. Executor:
   a. Loads agent.
   b. Reads `recordings/meeting.m4a` via FsBrowser (binary).
   c. Sniffs MIME against `acceptMimeTypes`; rejects on mismatch.
   d. Builds JSON-RPC `message/send` body (above).
   e. POSTs to `endpointUrl` with 120s timeout (audio takes time).
      Body size: cap at 50 MB pre-base64 for v1; bigger goes to
      streaming, which we haven't wired.
   f. Extracts text from `result` per `textSelector`.
   g. Renders filename template; writes to
      `transcripts/meeting.transcript.md` via FsBrowser.
   h. Returns `{ answer: "<transcript>", sources: [{ path: "transcripts/meeting.transcript.md", snippet: "" }] }`.

## Files to add/touch

- `web/shared/contracts/a2a.ts` — `A2AImportedCard` (new file, this
  type is for import only and doesn't belong in `http.ts`).
- `web/shared/domain/agent/types.ts` — `Agent` discriminated union,
  `RemoteAgent` with `mediation`, `RemoteAgentIo`.
- `web/shared/domain/agent/ports.ts` — `AgentExecutorRouter`.
- `web/src/use-cases/agent/import-agent.ts` — new.
- `web/src/infra/agent-executor/remote-a2a-proxy-executor.ts` — new.
- `web/src/infra/a2a-client/jsonrpc-a2a-client.ts` — new.
- `web/src/infra/agent-repo/fs-agent-repo.ts` — `kind`-aware r/w.
- `web/app/api/drives/[driveId]/agents/import/route.ts` — new.
- `web/app/api/drives/[driveId]/agents/[agentId]/ask/route.ts` —
  accept `inputPath`; route via executor router.
- `web/app/api/drives/[driveId]/agents/[agentId]/.well-known/agent-card.json/route.ts`
  — branch on `kind`. For remote-loopback agents, refuse to publish.
- `web/components/create-agent-modal.tsx` — Build / Import tabs +
  binding panel + "local dev" toggle.
- `web/components/file-row-actions.tsx` (or wherever the row menu
  lives) — add "Send to agent…" entry.
- `cli/` — **no changes** for v1.

## Open questions

1. **Whisper's response shape.** Real A2A v0.3 servers can return
   either a `Message` directly or a `Task` envelope. Whisper's card
   doesn't say. Do you know which it uses? If unknown, we wire the
   message-first extractor with Task fallback (zero-cost branch).

2. **Default language.** Skill description says language is optional
   (omit → auto-detect). For first-import demo we default DataPart to
   `{ task: "transcribe" }` (no language). Override in the modal lets
   owner pin `language: "ko"` if most audio is Korean. OK?

3. **Streaming skill.** The card also publishes `transcribe_stream`
   over WebSocket with PCM 16k mono input. v1 ignores it (not the
   common case for "drop a file and transcribe"). Future agent type
   `"transcribe_stream"` would be a different binding.

4. **Body size cap.** 50 MB pre-base64. Bigger files would need a
   chunking strategy or the streaming skill. Confirm.

5. **MIME sniff.** Trust file extension, or actually read the magic
   bytes? Extension is fine for v1; magic-byte sniffer can come later.

6. **Loopback re-emit refusal.** When the imported agent's
   `endpointUrl` is loopback, do we refuse to publish our own
   `.well-known/agent-card.json` for it (it can't be reached from
   outside our server anyway and would mislead clients), or publish
   with a clear note? I lean **refuse** for v1 — local dev should
   stay local.

7. **DataPart override at invoke time.** Should `/ask` accept
   `{ inputPath, dataPart?: object }` so the trigger UI can pass
   per-call options (e.g. language) without re-saving the agent?
   I think yes — small surface, big flexibility.

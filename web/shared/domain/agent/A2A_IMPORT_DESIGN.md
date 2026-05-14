# A2A URL Import — design

Status: draft v3 (MCP-mediated). Supersedes the proxy-with-binding shape
in v2 (kept below for the trail of reasoning).

## Goal

Owner pastes an A2A `agent-card.json` URL into the "Create agent" flow.
One click → a working remote agent appears in the drive. **First import
target is an STT agent** that consumes audio from the drive and writes
transcripts back into a folder.

Out of scope for v1: importing agents that require user-facing auth
(cap, x402) on the agent's **own** invoke endpoint. The owner must
point at an `/ask` endpoint they can call themselves.

## The pivot — why MCP-mediated instead of proxy-with-binding

The previous draft modeled `RemoteAgent` as a proxy: aindrive reads the
input file, forwards bytes to the upstream A2A agent inside an A2A
`FilePart`, gets the response, writes the response to a drive folder.
That works but bakes a lot of policy into aindrive (which MIME types,
where to write, filename templates, drive-file vs text mode) and makes
aindrive the data plane for every byte.

The right composition: **aindrive exposes its filesystem as an MCP
server, and we hand the imported A2A agent a scoped MCP credential at
invoke time.** The A2A agent fetches inputs and writes outputs itself.

This is clean because:

  - aindrive isn't a data plane. We don't move bytes through us; we
    move *capabilities*. Our role shrinks to "auth + audit".
  - It's the right protocol stack. A2A is for agent-to-agent calls;
    MCP is for an agent accessing tools/resources. They compose
    naturally — the A2A agent we call is **also** an MCP client.
  - It generalizes. STT, OCR, summarizer, embedding-indexer, anything
    that wants drive access — same shape. No per-domain binding
    config in the agent JSON.
  - It uses what we already built. `cli/src/mcp/` has the full tool
    surface (`list_files`, `read_file`, `write_file`, `search`,
    `verify_cap`, …). Each tool is already a thin shim over the
    drive's HTTP API. We just need to expose it over a different
    transport.
  - Path scoping reuses Meadowcap. The cap we hand the A2A agent has
    the same shape we hand any cap-bearer; the existing
    `aindrive-cap` auth scheme on the web HTTP API enforces it.

## Architecture

```
┌─────────────┐                                    ┌─────────────┐
│  owner UI   │  1. paste card URL, pick scope    │  aindrive   │
│  (browser)  │ ────────────────────────────────► │   web       │
└─────────────┘                                    │             │
                                                   │  POST       │
                                                   │  /agents/   │
                                                   │  import     │
                                                   └──────┬──────┘
                                                          │ 2. fetch + validate
                                                          │    card; mint cap
                                                          │    scoped to selected
                                                          │    paths; encrypt at
                                                          │    rest; persist as
                                                          │    RemoteAgent
                                                          ▼
                                                   ┌─────────────┐
                                                   │ FsAgentRepo │
                                                   └─────────────┘

┌─────────────┐                                    ┌─────────────┐
│  owner UI   │  3. trigger ("transcribe X")      │  aindrive   │
│  (browser)  │ ────────────────────────────────► │   web       │
└─────────────┘                                    │  /ask       │
                                                   └──────┬──────┘
                                                          │
                                                          │ 4. POST upstream askUrl
                                                          ▼
                                                   ┌─────────────┐
                                                   │  external   │
                                                   │  A2A agent  │
                                                   │   (STT)     │
                                                   └──────┬──────┘
                                                          │ 5. uses MCP creds
                                                          ▼      we passed in step 4
                                                   ┌─────────────┐    ┌───────────┐
                                                   │ aindrive web│───►│  drive    │
                                                   │  /mcp       │    │  fs       │
                                                   │  (streaming │    └───────────┘
                                                   │   HTTP)     │
                                                   └─────────────┘
```

Step 5 is the whole point: the A2A agent calls **aindrive's MCP** —
`read_file("recordings/meeting.m4a")`, runs STT internally, then
`write_file("transcripts/meeting.transcript.md", ...)`. aindrive
never touches the audio bytes. The A2A agent's response to step 4 is
a short status (`{ wrote: ["transcripts/meeting.transcript.md"] }`),
not the transcript itself.

## What we need to build

### 1. Web-side MCP endpoint over streamable HTTP

Today `cli/src/mcp/server.js` uses `StdioServerTransport`. We add a
**second** transport that runs inside the Next.js web server:

  - Route: `POST /mcp` (and `GET /mcp` for SSE event stream per MCP's
    Streamable HTTP transport).
  - Auth: `Authorization: Bearer <base64-cap>` on every request. The
    handler resolves the cap → driveId + path prefix + r/w bits,
    parks it on the session for the lifetime of the streamable HTTP
    connection.
  - Tool surface: same shape as the CLI's `TOOLS` array, but the
    handlers go directly through the web's existing in-process
    drive ops (skip the HTTP-to-self round-trip the CLI does).
  - Tool **subset** allowed for cap-scoped sessions:
    `list_files`, `read_file`, `write_file`, `rename`, `delete_path`,
    `stat`, `search` — all gated by the cap's path prefix and r/w.
    Owner-only tools (`create_share`, `grant_access`, …) are 403
    when the session is a cap.

Tool registry lives at `web/shared/mcp/tools.ts` — typed, importable
by routes. The CLI's stdio MCP keeps its own copy in JS for now (the
two will diverge slowly; merging is a v2 cleanup, not blocking).

### 2. Scoped cap mint at import time

The import modal collects:
  - `cardUrl` (the A2A card to import)
  - `readPaths[]` (drive-relative; empty array = no read)
  - `writePaths[]` (drive-relative; empty array = no read)

We mint one Meadowcap per granted prefix using the drive's owned
namespace (`getDriveNamespace(driveId)`). For v1 we collapse the cap
set to a single cap with the **broadest common prefix** plus an
allow-list of leaf prefixes — exact construction lives in
`web/lib/cap.ts` (existing helpers there).

The cap base64 is stored in the agent JSON, encrypted at rest with a
per-namespace symmetric key (same key used today for
`agent.llm.apiKey`). On invoke we decrypt and send.

The cap's expiry defaults to **never** but the owner can set a TTL
in the modal (90 day default suggested).

### 3. `RemoteAgent` domain shape (simpler than v2)

```ts
// types.ts
export type Agent = LocalAgent | RemoteAgent;

export type LocalAgent = {
  kind: "local";
  // ...all existing fields unchanged...
};

export type RemoteAgent = {
  kind: "remote";
  id: AgentId;
  driveId: DriveId;
  ownerId: UserId;

  /** Display fields, copied from the imported card. */
  name: string;
  description: string;
  iconUrl?: string;

  /** Source of truth for re-sync. */
  cardUrl: string;
  /** Picked from card.supportedInterfaces. */
  askUrl: string;
  protocolBinding: "HTTP+JSON" | "JSONRPC";
  /** Upstream skill we'll target. v1 = first skill on the card. */
  skillId: string;

  /** Path scope granted to upstream via MCP. */
  mcpScope: {
    readPaths: string[];   // drive-relative
    writePaths: string[];  // drive-relative
    expiresAt?: number;    // ms epoch
  };
  /** Encrypted base64 cap. Decrypted only at invoke time. */
  mcpCapEnc: string;

  /** Full upstream card cached for our own /.well-known emission. */
  upstreamCard: AindriveAgentCard;
  cardFetchedAt: number;

  access: AccessConfig;     // who can trigger this agent on us
  createdAt: number;
};
```

Note what's **gone** from v2: no `io: RemoteAgentIo`, no
`outputFolder` field, no `filenameTemplate`. The A2A agent is given
scoped MCP access and decides where its output lands within that
scope. We removed an entire decision class from our model.

### 4. Invoke path — how we pass the MCP creds

A2A `tasks/send` doesn't standardize "here's an MCP server to use".
We use a convention until/unless the spec adds one. Outbound body:

```json
{
  "jsonrpc": "2.0", "method": "tasks/send", "id": "...",
  "params": {
    "id": "<task-uuid>",
    "message": {
      "role": "user",
      "parts": [
        { "kind": "text", "text": "<the actual user request>" }
      ],
      "metadata": {
        "aindrive.mcp": {
          "url": "https://<our-base>/mcp",
          "auth": "Bearer <decrypted cap>",
          "driveId": "<drive-id>",
          "hint": {
            "readPaths": ["recordings/"],
            "writePaths": ["transcripts/"]
          }
        }
      }
    }
  }
}
```

We document the `aindrive.mcp` extension on our card and in the
import response so partner agent authors can pick it up. STT folks
get a one-pager.

### 5. Triggering — how the owner invokes the imported agent

For STT, the natural UI is:
  - Right-click an audio file in the drive viewer → "Send to <STT
    agent name>".
  - Modal asks for any extra instruction (defaults to "Transcribe
    this file and save the transcript next to it.").
  - aindrive picks the inputPath, packages the request, calls the
    upstream askUrl with `parts[0].text` = the rendered instruction
    + the inputPath, and `metadata.aindrive.mcp` = scoped creds.
  - The web route returns whatever upstream returned. Owner refreshes
    the folder; the transcript is there because the A2A agent wrote
    it via MCP.

No `/invoke` route forking. We extend `/ask` body to optionally carry
`{ inputPath?: string }` which gets templated into the outbound text.

### 6. Our own card for a `RemoteAgent`

`GET /.well-known/agent-card.json` for an imported agent emits our
card under our base URL:
  - `name`, `description`, `iconUrl` copied from upstream.
  - `supportedInterfaces[].url` = **our** `/ask` (we're the entry).
  - `provider.organization` = `"aindrive (proxied via MCP)"`,
    `provider.url` = upstream `cardUrl`.
  - `skills` = the chosen upstream skill, with our base URL.
  - `security` = `[]` for v1.
  - Extension `x-aindrive-upstream-card` = upstream `cardUrl`.
  - Extension `x-aindrive-mcp-mediated` = `true` (signals to anyone
    chaining downstream that this agent doesn't move data bytes
    through us).

## Security — what cap-scoping must enforce

Hard rules the MCP HTTP route must enforce on every tool call:
  1. The auth bearer is a valid Meadowcap for **this drive's**
     namespace (reject any cap rooted at another namespacePub).
  2. The op (read vs write) matches the cap's r/w bit.
  3. The target path is `path.startsWith(prefix)` for at least one of
     the cap's granted prefixes.
  4. `.aindrive/**` is always blocked, regardless of cap. The existing
     `system-paths.ts` rule already does this for cap-bearers —
     same policy applies here.
  5. Rate-limit per-cap. Default 60 file ops / minute. Tuned later.
  6. Audit: every MCP tool call hits a JSONL audit log scoped to
     `(driveId, capRecipientHex)` for owner-visible review.

Auditing matters because the owner is granting an external agent
write access to part of their drive. They need to be able to see what
it did.

## Open questions

1. **Trigger UX.** "Right-click file → send to agent" is what I'd
   build. Alternatives: chat-style "/run @stt on recordings/meeting.m4a"
   in a drive console; or an auto-watcher on a designated input
   folder. Manual UI first, watcher v1.1. OK?

2. **MCP transport.** Streamable HTTP per the current MCP spec, or
   legacy SSE? I'd go Streamable HTTP (simpler, single endpoint, the
   SDK supports it). Confirm.

3. **Cap-encryption key.** Reuse the same per-namespace symmetric key
   we use for `agent.llm.apiKey`. OK?

4. **Audit retention.** JSONL audit log, 30 days, drive-local file at
   `.aindrive/audit/mcp-<yyyymm>.jsonl`. OK?

5. **Default scope.** Default `readPaths` and `writePaths` to **empty**
   (owner must explicitly tick boxes) rather than auto-inferring from
   the upstream skill's MIME types. Safer. OK?

6. **Tool subset.** Cap-bearer sessions get only the file ops
   (list/read/write/rename/delete/stat/search). All sharing,
   payment, allow-list tools are 403. OK?

7. **A2A `aindrive.mcp` extension.** We need the upstream agent (STT
   here) to actually read `message.metadata.aindrive.mcp` and use it.
   This is a partner agreement. Do you have control over the first
   STT agent we'll import, or do we need to publish the convention
   somewhere and hope for adoption? If we control it, we can iterate
   the extension shape freely.

## Files this design touches

  - `web/shared/domain/agent/types.ts` — `Agent` discriminated union,
    `RemoteAgent` with `mcpScope`
  - `web/shared/domain/agent/ports.ts` — `AgentExecutorRouter`
  - `web/shared/mcp/tools.ts` — typed MCP tool registry (new)
  - `web/src/infra/mcp-server/streamable-http.ts` — new
  - `web/app/api/mcp/route.ts` — Next.js handler over Streamable HTTP
  - `web/src/use-cases/agent/import-agent.ts` — new
  - `web/src/infra/agent-executor/remote-a2a-executor.ts` — sends
    `tasks/send` with the `aindrive.mcp` metadata
  - `web/src/infra/agent-repo/fs-agent-repo.ts` — `kind`-aware
  - `web/app/api/drives/[driveId]/agents/import/route.ts` — new
  - `web/app/api/drives/[driveId]/agents/[agentId]/.well-known/agent-card.json/route.ts`
    — branch on `kind`
  - `web/app/api/drives/[driveId]/agents/[agentId]/ask/route.ts` —
    route via `executorRouter`
  - `web/components/create-agent-modal.tsx` — Build/Import tabs +
    scope picker
  - `cli/` — **no changes**. (CLI's stdio MCP stays as-is for local
    clients like Claude Desktop.)

## v2 trail — proxy with binding (deprecated)

The earlier shape had `RemoteAgentIo` with `input.mode = "drive-file"`
+ `output.mode = "drive-file"` + a filename template, and aindrive
forwarded file bytes upstream inside A2A `FilePart`s. This works for
agents that **don't** speak MCP, so we may bring it back as a
fallback later. For v1 we commit to MCP-mediated only.

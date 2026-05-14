# A2A URL Import — design

Status: draft v2 (STT-aware). Lives next to the agent domain so the
contract is reviewed against `types.ts` / `ports.ts` before any code
moves.

## Goal

Owner pastes an A2A `agent-card.json` URL into the "Create agent" flow.
One click → a working agent appears in the drive. **The first agent
we'll import is an STT service** that consumes audio files from the
drive and writes transcripts back into a folder, so the model has to
accommodate side-effects on the drive — not just request/response
passthrough.

Out of scope for v1: importing agents that require auth (cap, x402)
upstream. The owner must point at a publicly-askable card.

## What an A2A URL gives us, and what it doesn't

Per `AindriveAgentCard` (`web/shared/contracts/http.ts`) and the A2A v1
spec, a card at `{base}/.well-known/agent-card.json` carries:

  - `name`, `description`, `version`, `iconUrl`, `provider`
  - `supportedInterfaces[]` — at least one URL + protocol binding
  - `securitySchemes` + `security[]` — empty array = public
  - `skills[]` — `id`, `name`, `description`, `tags`, `examples`,
    `inputModes[]`, `outputModes[]` (MIME types)
  - `defaultInputModes` / `defaultOutputModes`

It does **not** carry: `persona`, `llm.apiKey`, `namespacePub`,
`ownerId`, `knowledge.strategy`, the local folder the agent indexes —
those are intentionally redacted in `agent-card.json/route.ts:49`.

So the card alone cannot reconstruct a local aindrive agent. Two
plausible interpretations of "import":

### A — **Remote proxy with optional drive side-effect** ← v1

The new agent in this drive is a thin pass-through to the upstream
A2A endpoint. At invocation time we forward the request, then
**optionally write the response into a drive folder**. The CLI is
never involved; no LLM API key needed.

This is the version that fits STT: audio bytes go up, transcript text
comes back, transcript lands at `{output-folder}/{name}.transcript.md`.

### B — **Config seed** (deferred)

Paste card URL → modal pre-fills `name`/`description`/`skills`. Owner
still chooses folder + LLM + API key. Final agent is a normal local
agent. This is "form prefill", not "create immediately" — defer as a
separate `Use as template` button.

## v1 = Remote proxy with drive side-effect. Concretely

### 1. Two kinds of remote agent, expressed by an I/O binding

A `RemoteAgent` is fully described by **how its inputs/outputs map
to/from this drive**, not by the upstream agent's category. The same
shape supports text Q&A proxies *and* file-processing proxies (STT,
OCR, summarizer):

```ts
export type RemoteAgentIo = {
  input:
    /** Inbound `/ask` body has `{ q: string }`. We send q as a TextPart. */
    | { mode: "text" }
    /** Inbound body has `{ inputPath: "<drive-relative file>" }`. We
     *  read that file via FsBrowser, send the bytes as a FilePart with
     *  the matching MIME type. STT and OCR use this. */
    | { mode: "drive-file"; acceptMimeTypes: string[] };

  output:
    /** Return upstream's text response in the HTTP response body. The
     *  text Q&A path is this. */
    | { mode: "echo" }
    /** Write upstream's text response into the drive at
     *  `${folder}/${render(filenameTemplate, ctx)}`. STT uses this. */
    | {
        mode: "drive-file";
        folder: string;
        /** Template language: `{base}` = input filename minus extension,
         *  `{ts}` = unix epoch seconds, `{date}` = YYYY-MM-DD,
         *  `{skillId}` = upstream skill id. v1 keeps this list small. */
        filenameTemplate: string;
      };
};
```

Picking the binding at import time:

  - Card has at least one skill whose `inputModes` includes an
    `audio/*`, `video/*`, `image/*`, or `application/pdf` MIME type
    AND whose `outputModes` includes a text type
    → infer `input: drive-file` + `output: drive-file`. Modal asks
       owner for the output folder and filename template.
  - Otherwise (all skills are text-in/text-out)
    → infer `input: text` + `output: echo`. No folder needed.

The owner can override the inferred binding in the import modal
(advanced view), but defaults must match the obvious case.

### 2. Domain — `Agent` becomes a discriminated union

```ts
// types.ts
export type Agent = LocalAgent | RemoteAgent;

export type LocalAgent = {
  kind: "local";
  // ...all existing fields unchanged: folder, persona, namespacePub,
  // knowledge, llm, access, ...
};

export type RemoteAgent = {
  kind: "remote";
  id: AgentId;
  driveId: DriveId;
  ownerId: UserId;
  name: string;
  description: string;
  iconUrl?: string;
  /** Source of truth for re-sync. */
  cardUrl: string;
  /** Picked from card.supportedInterfaces at import time. */
  askUrl: string;
  protocolBinding: "HTTP+JSON" | "JSONRPC";
  /** The exact upstream skill we'll invoke. v1 = first skill on the card. */
  skillId: string;
  io: RemoteAgentIo;
  /** Public projection of upstream card, frozen at import. Echoed back
   *  by our own /.well-known/agent-card.json so clients following our
   *  card see consistent metadata. */
  upstreamCard: AindriveAgentCard;
  cardFetchedAt: number;
  /** Same access shape as local agents — used by our `/invoke` route
   *  to gate callers. For STT v1 default is `["owner"]`. */
  access: AccessConfig;
  createdAt: number;
};
```

Migration: `FsAgentRepo` reads any existing JSON without `kind` as
`{ kind: "local", ...rest }`. New writes always include the
discriminator.

### 3. Ports — executor router + a new outbound A2A client

```ts
// ports.ts — already has AgentExecutor. Add:

export interface AgentExecutorRouter {
  forAgent(agent: Agent): AgentExecutor;
}

/** Speaks A2A on the outbound side. Internal to the remote executor. */
export interface A2AClient {
  invoke(input: {
    askUrl: string;
    skillId: string;
    protocolBinding: "HTTP+JSON" | "JSONRPC";
    parts: ReadonlyArray<A2APart>;
    timeoutMs: number;
  }): Promise<{ text: string; rawMime: string }>;
}

export type A2APart =
  | { kind: "text"; text: string }
  | { kind: "file"; mimeType: string; bytes: Uint8Array; filename?: string };
```

`forAgent({ kind: "local" })` → existing `rpcAgentExecutor`.
`forAgent({ kind: "remote" })` → new `RemoteA2AExecutor`.

`RemoteA2AExecutor.ask({ driveId, agentId, request })` flow:

  1. Load the `RemoteAgent` (executor is given a repo handle in compose).
  2. Build parts according to `io.input`:
     - `text` → `[{ kind: "text", text: request.q }]`
     - `drive-file` → read `request.inputPath` via FsBrowser as bytes,
       validate MIME against `acceptMimeTypes`, build a single FilePart.
  3. Call `A2AClient.invoke(...)`.
  4. Apply `io.output`:
     - `echo` → return `{ answer: text, sources: [] }`.
     - `drive-file` → render filename template, write `text` to
       `${folder}/${rendered}` via FsBrowser, return
       `{ answer: text, sources: [{ path: rendered, snippet: "" }] }`.

### 4. Request shape — extend `/ask`, don't fork it

The current route accepts `{ q: string }`. To support file-binding
remote agents we widen to a discriminated body:

```ts
type AskBody =
  | { q: string }                            // text agents (existing)
  | { inputPath: string };                   // file-binding remote agents
```

Route validates: a `LocalAgent` or a `RemoteAgent` with `io.input.mode
= "text"` requires `q`. A `RemoteAgent` with `io.input.mode =
"drive-file"` requires `inputPath`. Anything else → 400.

Naming nit: the route stays at `/ask`. We're not introducing
`/invoke`. The verb "ask" is general enough ("ask this agent to
transcribe this file" reads fine) and renaming would churn a lot of
code for marginal gain.

### 5. Use-case — `importAgentFromA2A`

```ts
// web/src/use-cases/agent/import-agent.ts
export type ImportAgentInput = {
  driveId: DriveId;
  ownerId: UserId;
  cardUrl: string;
  /** Owner-supplied overrides applied AFTER inference. */
  overrides?: {
    name?: string;
    outputFolder?: string;
    filenameTemplate?: string;
    access?: AccessConfig;
  };
};

export type ImportAgentOutput =
  | { kind: "ok"; agent: RemoteAgent }
  | { kind: "rejected"; reason:
        | "bad_url"
        | "ssrf_blocked"
        | "unreachable"
        | "not_a2a_card"
        | "card_too_large"
        | "no_supported_interface"
        | "no_compatible_skill"
        | "auth_required"
        | "agent_count_limit"
        | "duplicate_card_url"
        | "output_folder_required"   // file-binding agents with no folder
        | "output_folder_invalid" };
```

Validation order (cheapest first):
  1. URL is `http(s)`, length sane.
  2. SSRF: DNS-resolve host, reject if any address is private/
     link-local/loopback. (Aindrive often runs alongside private
     services; an authenticated owner is still not a license to scan
     internal nets via us.) Disallow cross-origin redirects.
  3. GET card, `Accept: application/json`, 5s, ≤64KB body.
  4. JSON parses; `name`, `supportedInterfaces[0].url`, `version` exist.
  5. `security[]` is empty array. Else `auth_required`.
  6. Pick the first `HTTP+JSON` interface; reject if none.
  7. Infer binding (see §1). If `output.mode = "drive-file"`, require
     `overrides.outputFolder` and validate via the same rules as
     `createAgent` (`isSystemPath`, no `..`, no leading `/`).
  8. Tier cap (`HARD_MAX_AGENTS_PER_DRIVE`).
  9. Dedupe on `cardUrl` within the drive.

### 6. Route — `POST /api/drives/[driveId]/agents/import`

Sibling of existing `POST .../agents`. Body:

```ts
{
  cardUrl: string;
  outputFolder?: string;        // required when binding infers drive-file output
  filenameTemplate?: string;    // optional override; defaults provided below
  name?: string;
}
```

Owner-only, same auth and tier check as `POST .../agents`. Returns
`{ ok, agent }` using the existing `toPublicAgent` projection, extended
to surface `kind`, `cardUrl`, `iconUrl`, `io`.

Defaults for filename templates (chosen to be obvious-looking):
  - STT (audio in, text out): `"{base}.transcript.md"`
  - OCR (image/pdf in, text out): `"{base}.ocr.md"`
  - Generic file-in/text-out: `"{base}.{skillId}.md"`

### 7. UI — modal tab + advanced binding panel

`create-agent-modal.tsx` grows a tabbed top row:
  - **Build** (existing flow)
  - **Import from A2A URL** (new)

Import tab flow:
  1. URL input + "Fetch card" button.
  2. After successful fetch, render a small preview card (icon, name,
     description, skill list).
  3. Show a binding panel:
     - For text-in/text-out: nothing extra to configure.
     - For file-in/text-out (STT case):
       - "Save transcripts to" folder picker — required.
       - Filename template — input with default applied.
  4. Submit → calls `POST .../agents/import`.

The success screen reuses the existing one (card URL + invoke URL +
copy buttons), with one extra line for file-binding agents: *"Drop
`audio/*` files in the drive and call this agent's invoke URL with the
file path to transcribe."*

### 8. Our own card for a `RemoteAgent`

`GET /.well-known/agent-card.json` for an imported agent emits **our**
card under our base URL:
  - `name`, `description`, `iconUrl` copied from upstream.
  - `supportedInterfaces[].url` = **our** `/ask` (we're the proxy).
  - `provider.organization` = `"aindrive (proxied)"`,
    `provider.url` = upstream `cardUrl`.
  - `skills` = single skill mirroring the chosen upstream skill, with
    `inputModes`/`outputModes` reflecting `io.input.acceptMimeTypes`
    and `output.mode`.
  - `security` = `[]` for v1.
  - Non-spec extension `x-aindrive-upstream-card` linking the original.

This means a downstream A2A client discovering our card calls **us**,
not upstream directly — which is what makes the drive write side-effect
possible.

### 9. Drive write side-effects: who calls our `/ask`

The drive-file output mode writes to the owner's drive. Therefore the
default `access.policies` for a file-binding remote agent is
`["owner"]` only — we do not let arbitrary cap-bearers cause writes
into the owner's tree. The modal lets the owner widen it to
`["owner", "cap-holder"]` only if the cap has write coverage for the
output folder (we validate at ask time, not import time, against the
presented cap).

For STT v1 specifically, owner-only is the default and we don't need
to ship the cap-write-coverage check yet — it's a flagged TODO in the
route.

### 10. What the CLI sees

Nothing. The CLI runs on the owner's machine and handles `agent-ask`
RPCs for `LocalAgent`s only. Remote agents are entirely a web-side
construct. The on-disk JSON in `.aindrive/agents/` includes them with
`kind: "remote"`, which the CLI's existing agent loader can ignore
(skip non-`local` entries when answering `agent-ask`).

This split is important: it means we can ship the whole feature
without bumping the CLI version.

## Concrete first STT import — what it looks like end-to-end

Assume upstream STT card at `https://stt.example.com/.well-known/
agent-card.json` declares:

```jsonc
{
  "name": "Whisper STT",
  "supportedInterfaces": [{ "url": "https://stt.example.com/a2a",
    "protocolBinding": "HTTP+JSON", "protocolVersion": "1.0" }],
  "security": [],
  "skills": [{
    "id": "transcribe",
    "inputModes": ["audio/wav", "audio/mpeg", "audio/m4a"],
    "outputModes": ["text/plain"]
  }]
}
```

Owner pastes that URL in import tab. We:
  1. Fetch + validate card.
  2. Infer `io.input = { mode: "drive-file",
                         acceptMimeTypes: ["audio/wav","audio/mpeg","audio/m4a"] }`,
     `io.output = { mode: "drive-file" }`.
  3. Modal asks for output folder (`/transcripts`) + filename
     template (default `{base}.transcript.md`).
  4. Persist `RemoteAgent` JSON at
     `.aindrive/agents/agt_<id>.json`.

Owner then drops `meeting.m4a` in `/recordings`, calls (e.g. via UI
button on the file row):
  `POST /api/drives/{driveId}/agents/{agentId}/ask`
  `{ inputPath: "recordings/meeting.m4a" }`

Web:
  1. Loads the agent, checks `kind === "remote"`, validates body
     matches binding.
  2. Reads `recordings/meeting.m4a` via FsBrowser (bytes).
  3. POSTs A2A JSON-RPC `tasks/send` to `https://stt.example.com/a2a`
     with a single FilePart.
  4. Receives `{ result: { messages: [{ parts: [{ text: "..." }] }] } }`.
  5. Writes `transcripts/meeting.transcript.md` via FsBrowser.
  6. Returns `{ answer: "<transcript text>",
                sources: [{ path: "transcripts/meeting.transcript.md",
                            snippet: "" }] }`.

## Open questions (please confirm before/while I code)

1. **Auto-trigger vs. manual trigger.** For STT the magical UX is
   "drop audio file → transcript appears". v1 plan is manual trigger
   (UI button on file row or explicit `/ask` call). Auto-on-upload =
   v1.1 (needs a drive write hook + job queue). OK with manual first?

2. **Filename template language.** Proposing: `{base}`, `{ts}`,
   `{date}`, `{skillId}`. Anything else needed for the STT case (e.g.
   `{duration}`, `{lang}`)? I'd defer those until upstream actually
   surfaces them in the response.

3. **Overwrite on collision.** If `meeting.transcript.md` already
   exists, do we overwrite, suffix with `-2`, or error? Default
   proposal: suffix.

4. **Owner-only access for v1 remote agents.** Proposed default. OK?

5. **JSON-RPC vs HTTP+JSON for outbound.** I'll detect from
   `protocolBinding` and support both, prioritizing whichever the
   first STT we import actually speaks. Have a specific STT endpoint
   you'll point at first?

6. **Card URL canonicalization.** Auto-append `/.well-known/
   agent-card.json` if the URL doesn't end with it and the plain GET
   doesn't return a card. OK?

## Files this design touches (preview)

  - `web/shared/domain/agent/types.ts` — `Agent` discriminated union,
    `RemoteAgentIo`
  - `web/shared/domain/agent/ports.ts` — `AgentExecutorRouter`,
    `A2AClient`
  - `web/src/use-cases/agent/import-agent.ts` — new
  - `web/src/infra/agent-executor/remote-a2a-executor.ts` — new
  - `web/src/infra/a2a-client/http-json-a2a-client.ts` — new
  - `web/src/infra/agent-repo/fs-agent-repo.ts` — `kind`-aware read/write
  - `web/app/api/drives/[driveId]/agents/import/route.ts` — new
  - `web/app/api/drives/[driveId]/agents/[agentId]/.well-known/agent-card.json/route.ts`
    — branch on `kind`
  - `web/app/api/drives/[driveId]/agents/[agentId]/ask/route.ts` —
    accept `inputPath`; route via `executorRouter.forAgent(agent)`
  - `web/components/create-agent-modal.tsx` — Build/Import tabs +
    binding panel
  - `cli/` — **no changes**.

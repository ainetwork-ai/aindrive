# AIN-UI link snippets

When a URL on an AIN application host is pasted into a chat (AIN Teams, or any
other consumer), the consumer asks that same URL for an **interactive snippet**
instead of scraping its HTML: a small A2UI surface — the repo's Run form, a file
preview, the latest deployments — plus the actions its buttons fire. The producer
(aindrive for `aindrive.ainetwork.ai`, ainize for `ainize.ai`) answers for the
*viewer*, with the viewer's own access rights, and the consumer draws the surface
with the renderer it already has for agent answers (A2UI v0.9, basic catalog).

This document is the contract between producers and consumers. aindrive's producer
is `web/lib/ainui-snippet.ts` (builders) + `web/app/[slug]/git/[...path]/route.ts`
(negotiation); ainize's is `ainize-node/src/ainui-snippet.ts` +
`src/project-routes.ts` (`GET /api/ainui/snippet`), fronted by ainize-web's
middleware. ainize-node mirrors a short version of this page in `docs/PROJECTS.md`.

## 1. Discovery: content negotiation on the pasted URL

The consumer requests **the pasted URL itself** with

```
GET <the pasted URL>
Accept: application/vnd.ain.ui+json
Authorization: Bearer <AIN SSO client_credentials token of the consumer app, aud = producer origin>
X-AIN-Actor: <the viewer's AIN SSO subject>
```

* `Accept` is the switch. A request **without** `application/vnd.ain.ui+json` in
  `Accept` is served exactly as before (HTML page, raw file, git smart-HTTP); a
  request with it never gets HTML. Browsers never send this media type.
* The identity pattern is the one aindrive → ainize already uses for runs
  (aindrive `web/lib/run-ainize.ts`, ainize-node `src/run-actor.ts`): the
  **application** proves itself with an OAuth 2.0 `client_credentials` token from
  AIN SSO (RFC 9068 `at+jwt`; `sub` = `azp` = `client_id` = the app, `aud` = the
  producer's public origin, 5-minute lifetime) and **names the person** in
  `X-AIN-Actor`. Producers verify the token with their existing service-principal
  code (aindrive `web/lib/sso/service-principal.ts`, ainize-node `sso.ts
  verifyServiceToken`) — the consumer's client_id must be on the producer's trust
  list (`AINDRIVE_SSO_SERVICE_APPS` / `AIN_SSO_SERVICE_APPS`, e.g. `ainteams`).
* The actor is resolved to the account the producer knows from sign-in (aindrive:
  `sso_identities` subject → user; ainize: `sso:<sub>` or the linked legacy
  principal). An actor the producer has never seen is not an error by itself —
  it is simply a person with no access (§4). A missing `X-AIN-Actor` means the
  snippet is for the application itself (viewer on org-shared drives at aindrive;
  nothing at ainize).

Successful answer: `200`, `Content-Type: application/vnd.ain.ui+json`, body:

```jsonc
{
  "ainui": 1,                              // format version of THIS envelope
  "kind": "aindrive.repo",                 // producer-defined snippet type (§3)
  "title": "comcom/clef-artwork-search",
  "subtitle": "main · 1f1dcca · run as the person",   // optional
  "icon": "git",                           // optional hint: git | file | deploy | lock
  "url": "https://aindrive.ainetwork.ai/comcom/git/clef-artwork-search",   // canonical page URL ("Open in …")
  "surface": [ /* A2UI v0.9 messages, see §2 */ ],
  "actions": { /* actionId → how to perform it, see §2.2 */ },
  "refresh": 30                            // optional: seconds after which the consumer MAY re-fetch
}
```

Errors are JSON with the same media type:

| status | body | meaning |
|---|---|---|
| 401 | `{ "error": "invalid service token", "reason": "…" }` + `WWW-Authenticate: Bearer error="invalid_token"` | the app token did not verify (wrong `aud`, untrusted app, expired) |
| 403 | the envelope above with `"kind": "denied"` and a minimal surface (§4) | the actor may not see this resource |
| 404 | `{ "error": "not found" }` | no such repo / file / project — the same body a wrong URL always got |
| 503 | `{ "error": "drive offline" }` | aindrive: the drive's agent is not connected |

## 2. The surface and its actions

### 2.1 `surface`: A2UI v0.9 messages, basic catalog

`surface` is an **array of A2UI v0.9 messages** — exactly what an A2A agent puts in
its `application/json+a2ui` data parts, so a consumer folds it with the same code
(ainteams `backend/src/domain/shared/a2ui.ts extractA2UISurface`, ainize-web
`src/components/a2ui/surface.ts readSurface`):

1. `createSurface { surfaceId, catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json" }`
2. `updateComponents { surfaceId, components: [...] }` — flat list, one component has `id: "root"`
3. `updateDataModel { surfaceId, path: "/", value: {...} }` — the initial data model

Only these basic-catalog components are used, so a renderer that draws agent
answers today needs nothing new: **`Column`, `Row`, `Card`, `Text`, `Divider`,
`TextField`, `Button`**. Rows of a list are emitted as static components (no
`List` templates: the v0.9 template spelling differs between renderers).
Components carry no HTML; `Text.text` may be a literal or a `{ "path": "/…" }`
binding into the data model.

Conventions a consumer may rely on (component ids are stable across producers):

| id | what it is |
|---|---|
| `root` | the top `Column` |
| `header` | `Row` with the title / sub-title `Text`s |
| `run` | the Run `Card` (absent when nothing is runnable) |
| `run.input.<NAME>` | one `TextField` per `ainize.json` input, `value: {path: "/inputs/<NAME>"}`, `label` = description or name. `choice` inputs list the options in the label; `boolean`/`number` inputs are text fields too (`variant: "number"` for numbers). The consumer owns the typed value once drawn. |
| `run.button` | the `Button` whose action is `run` (§2.2) |
| `run.status` | `Text` bound to `/run/status` — `idle` \| `running` \| `exit 0` \| `exit 1` \| `error: …` |
| `run.output` | `Text` bound to `/run/output` — **render preformatted / monospace**; the consumer appends streamed output here (§2.3) |
| `deployments` | the Deployments `Card`; rows `deployments.<n>` (n = 0..2, newest first), each a `Row` of `●`-prefixed status text, short sha, time, and link `Button`s |
| `file.code` | (file snippet) `Text` with the first ~40 lines — render preformatted / monospace |
| `links` | `Row` of `Button`s whose actions are `open:*` (navigation) |

### 2.2 `actions`: what a button does

Every `Button` in the surface has `action.event.name` = an **actionId** that is a
key of the envelope's `actions` map. The consumer never invents a request: it
looks the id up and performs what the entry says.

```jsonc
"actions": {
  "run": {
    "method": "POST",
    "url": "https://aindrive.ainetwork.ai/api/drives/-nLGGiI3VXYR/run",
    "body": { "repo": "repositories/clef-artwork-search", "entry": "art_search.py", "env": { "$context": true } },
    "stream": "sse",
    "output": { "path": "/run/output", "status": "/run/status" }
  },
  "redeploy": { "method": "POST", "url": "https://ainize.ai/api/projects/prj_…/redeploy", "body": {} },
  "open:aindrive": { "method": "GET", "url": "https://aindrive.ainetwork.ai/comcom/git/clef-artwork-search", "navigate": true },
  "open:inspect": { "method": "GET", "url": "https://ainize.ai/projects/prj_…", "navigate": true }
}
```

* `navigate: true` — the consumer opens `url` for the viewer (new tab / link). No request is made on their behalf.
* Otherwise the consumer performs `method url` **server-side**, with the same two identity headers as the discovery request (§1) — the producer runs the action **as the actor**. `Content-Type: application/json`.
* `body` is a template. The literal `{ "$context": true }` is replaced by the
  **resolved `event.context`** of the pressed button — the renderer already
  resolves `{ "path": "/inputs/DESC" }` context values to the viewer's current
  field values at click time (ainteams `A2UISurfaceView resolveContext`). For a
  Run button the context keys are the env names (`INPUT_<NAME>`) so `env` is the
  answers verbatim. Anything else in `body` is sent as is.
* `stream: "sse"` — the answer is `text/event-stream` (§2.3). Without it the
  answer is JSON; the consumer shows success/failure (`{ ok: true, … }` or an
  `{ error }` body) as a one-line status under the surface.

### 2.3 Streaming actions (run)

A streaming action answers exactly the shape of aindrive's run route /
ainize's `/api/run` (ainize-node `deploy/run-runtime/README.md`):

```
event: stdout
data: "text"            ← JSON string

event: stderr
data: "text"

event: exit
data: {"code": 0, "ms": 1234}

event: error
data: "message"
```

The consumer, for the action's `output`:

1. on starting: `updateDataModel` `output.status` = `"running"`, `output.path` = `""`;
2. on `stdout` / `stderr`: **append** the text to the value at `output.path` (stderr may be prefixed `⚠ `; keep order);
3. on `error`: set `output.status` = `"error: <message>"`;
4. on `exit`: set `output.status` = `"exit <code> · <ms> ms"`; the stream ends after it.

Set the values by **re-rendering the same surface with the changed data model**
(`Text` components bound to those paths redraw); never splice the component list.
A non-2xx first response (401/403/404/429/503) has a JSON `{ error }` body — show
it as the status.

## 3. Snippet kinds producers must emit

### 3.1 `aindrive.repo` — `https://aindrive.ainetwork.ai/<org>/git/<repo>` and `…/tree/<ref>/<dir>`

* `header`: `<org>/<repo>` · branch · HEAD short sha + subject (from the agent's `git-meta`).
* `run` card **when `ainize.json` exists** in the repo: one `TextField` per
  manifest input (`inputs`, GitHub-Actions `workflow_dispatch` shape; prefilled
  with `default`), the entry file named in the card, `run.button` → action `run`
  = `POST /api/drives/<driveId>/run` with `{ repo, entry, env: {$context} }`
  streaming into `run.output`. The run executes on ainize **as the actor**
  (their own `aindrive run` key reaches the sandbox; aindrive `web/lib/run-ainize.ts`).
* `deployments` card when the repo is bound to an ainize project: up to 3 newest
  deployments (`● ready` / `● building` / `● error`, short sha, relative time,
  `Inspect` → project page, `Visit` → `outputUrl` when ready). Rows beyond the
  newest need ainize to accept aindrive's machine token + actor on
  `GET /api/projects/:id/deployments` (§5); without it only the newest is shown.
* `links`: `Open in aindrive` (`open:aindrive`), and `Project on ainize` when bound.

### 3.2 `aindrive.file` — `…/blob/<ref>/<path>`

* `header`: file path · ref.
* `file.code`: the first 40 lines (≤ 8 KiB) of a text file at that ref; a binary file says so instead.
* `run` card when the file is runnable (`.py`, `.js`, `.mjs`) **and** the ref is the
  checked-out branch (the run executes the working tree): the manifest inputs
  when `ainize.json` exists, `run.button` → the same run endpoint with this
  file as `entry`.
* `links`: `Open` (`open:aindrive`) → the blob page; `Raw`.

### 3.3 `ainize.project` — `https://ainize.ai/<org>/<repo>` and `https://ainize.ai/projects/<id>`

* `header`: project name · `<org>/<repo>` · branch.
* `deployments` card: the latest deployment (status, sha, when, `Visit` / `Inspect`), then up to 2 older rows.
* `run` card for `kind: script` projects: the same inputs form (from the deployed
  commit's `ainize.json`), `run.button` → `POST /api/projects/<id>/run` with
  `{ env: {$context} }`, streaming. ainize checks the deployed commit out and runs
  it as the actor.
* `redeploy` action (`Button` `redeploy.button`, action `redeploy` → `POST /api/projects/<id>/redeploy`,
  JSON answer `{ deploymentId, status: "queued" }`) — present **only for editors** (§4).
* `links`: `Open on ainize` (`open:inspect`), `Repository` (`open:aindrive`).

## 4. Authorization and privacy

* A producer answers a snippet only for an actor with **viewer or better** on the
  resource: aindrive — the drive role the repo path resolves to (org membership
  through the drive's org share, a direct member grant, or ownership); ainize —
  the project's owner, or an active member of the AIN organization the project's
  `<org>` names. **Editors** (redeploy): aindrive editor+ is not used by any
  action today; on ainize the editor is the project's owner.
* Otherwise **403** with `"kind": "denied"`, a one-`Text` surface
  (`"Sign in to <host> or ask for access to <org>/<repo>."`) and a single
  `open:*` link to the page, so the message still shows something clickable.
  Which repos / projects exist is not revealed beyond that: a repo the actor
  cannot see and a repo that does not exist both answer 404 at aindrive (as the
  HTML pages do); ainize answers 404 for an unknown project and 403 for a known one the actor may not see.
* **Never in a surface**: webhook secrets, deploy tokens, API keys, session
  cookies, other members' identities, drive ids beyond the one in the action URL.
  Manifest `env` values are not shown (they may be mistaken for secrets).
* Actions re-check access on every call — the snippet is not a capability.
* The consumer must not cache a snippet across viewers; `refresh` is a hint for the same viewer.

## 5. Producer ↔ producer: deployments for the aindrive snippet

aindrive builds its `deployments` card from ainize: `GET /api/projects/by-repo?repo=<clone URL>`
(public, newest deployment only) and `GET /api/projects/<id>/deployments` with aindrive's own
machine token for the ainize origin + `X-AIN-Actor: <viewer>` — ainize answers the list when the
actor could see the project's snippet (§4), and 404 otherwise. Both fetches are best-effort with a
3 s timeout: an unreachable ainize leaves the card out, never fails the snippet.

## 6. Versioning

`ainui: 1` names this envelope. Additive changes (new optional fields, new `kind`s,
new action options) keep the number; a consumer ignores what it does not know. A
consumer that sees an unknown `kind` still draws `surface` and offers `actions` it
understands (`navigate` and plain `POST`s always work).

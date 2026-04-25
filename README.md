# aindrive

> **Your local folder, on the web — accessible to humans and AI agents.**
> Files stay on your machine. Sharing is capability-based. Access is paid (or free).
> Agents pay micropayments for folder access via [x402](https://x402.org) and use [A2A](https://a2a-protocol.org) to negotiate
> permissions, collaborate on edits, and feed the contents into RAG pipelines.

```
npm i -g aindrive
cd ~/Documents
aindrive
# → opens https://aindrive.ainetwork.ai/d/<your-drive-id>
```

To plug aindrive into Claude Desktop / Claude Code as an MCP server:

```
aindrive mcp
# stdio Model Context Protocol server exposing every drive operation
# (list/read/write/share/grant/ask-agent/…) to AI assistants
```

---

## What it does

Run `aindrive` in any folder on your machine. That folder is now served at a
public URL with a Google Drive-style web UI:

- **Browse, view, and edit** any file in the browser (Monaco-based editor for
  text/code, image/PDF preview for binaries).
- **Real-time collaborative editing** — multiple humans + AI agents in the same
  document, character-level CRDT merging via Y.js.
- **Wallet-based access control** — owner adds wallets to a folder's allowlist
  manually, OR visitors pay USDC via x402 and get auto-added.
- **Capability tokens** for share links (Meadowcap), so a leaked share URL is
  cryptographically verifiable and revocable without a database lookup.
- **AI agents as first-class peers** — discover via A2A AgentCard, request
  permissions, edit alongside humans, stream content into RAG.

The bytes never leave your machine. The web layer only proxies signed RPC
calls to a local agent over an outbound WebSocket — no inbound port is opened
on your computer.

---

## Architecture

aindrive is a **single application** with four runtime components — browser
UI, Next.js server, local CLI, and an MCP stdio server (`aindrive mcp`) for
AI assistants — plus a **built-in AI agent runtime** that the server hosts.
The agent is a first-class citizen of the app; only the LLM provider call
(OpenAI, Anthropic, etc.) is external, via a user-supplied API key. Optional
3rd-party agents can connect over the A2A interface, and any MCP-aware
client (Claude Code, Claude Desktop, Cursor, …) can drive the same drive
operations through `aindrive mcp`.

```
                                       LLM inference
                                ┌──────────────┴────────────────┐
                                │ Local model (Ollama/llama.cpp)│
                                │   ── OR ──                    │
                                │ Web3 model (Flock, Bittensor) │
                                │   ── OR ──                    │
                                │ Cloud API (OpenAI/Anthropic)  │
                                └──────────────┬────────────────┘
                                               │
                                               │  pluggable provider
                                               │  (Flock = login-free)
┌─────────────┐      HTTPS        ┌──────────┴──────────────────────┐
│   Browser   │ ────────────────▶ │     Next.js custom server       │
│  (humans)   │ ◀──── WSS ──────  │   (web/server.js)               │
└─────────────┘   /api/agent/doc  │                                 │
                                  │  ┌─────────────────────────┐    │
                                  │  │  DocHub (per-doc bcast) │    │
                                  │  │  AgentMap (drive RPC)   │    │
                                  │  │  Trace ring buffer      │    │
                                  │  │  Auth + Wallets + Caps  │    │
                                  │  └─────────────────────────┘    │
                                  │  ┌─────────────────────────┐    │
                                  │  │  aindrive AI agent      │    │
┌─────────────┐    A2A JSON-RPC   │  │  ─ A2A AgentCard server │    │
│ 3rd-party   │ ─────────────────▶│  │  ─ x402 paywall handler │    │
│ agent       │ ◀─ x402 X-PAYMENT │  │  ─ Folder RAG (embed +  │    │
│ (optional)  │       payment     │  │     index + retrieve)   │    │
└─────────────┘                   │  │  ─ Y.js peer (live edit)│    │
                                  │  └─────────────────────────┘    │
                                  │  SQLite (better-sqlite3)        │
                                  └────────────────┬────────────────┘
                                       │  WSS  /api/agent/connect
                                       │  (outbound only — CLI dials in)
                                       ▼
                           ┌─────────────────────────────┐
                           │   aindrive CLI (your machine)│
                           │   ─ Reads/writes local files │
                           │   ─ HMAC-signs every RPC     │
                           │   ─ Willow Store (SQLite)    │
                           │     for Y.Doc binary entries │
                           │   ─ fs.watch + self-write    │
                           │     suppression              │
                           │   ─ MCP stdio server         │
                           │     (`aindrive mcp` mode)    │
                           └──────────────┬──────────────┘
                                          │  stdio MCP (JSON-RPC)
                                          ▼
                           ┌─────────────────────────────┐
                           │  AI assistant (Claude Code, │
                           │  Claude Desktop, Cursor, …) │
                           │  drives every aindrive op   │
                           │  via MCP tools + resources  │
                           └─────────────────────────────┘
```

**Key point:** the AI agent is **inside aindrive**. It runs on the same
Next.js process, reuses the same auth, the same DocHub, the same Willow
Store. It is just another peer that happens to be an LLM under the hood.
This is what makes RAG + collaborative editing first-class instead of
bolted-on.

### LLM provider is pluggable — including login-free Web3 models

aindrive doesn't lock you to a specific LLM vendor. The agent's inference
backend is one config switch:

| Provider | Login | Network | Notes |
|---|---|---|---|
| **Local model** (Ollama, llama.cpp) | none | localhost only | Zero egress; perfect for sensitive folders |
| **[Flock](https://flock.io)** (Web3 inference network) | **none** — pay per call via wallet | decentralised | Combined with [x402](https://x402.org) + wallet auth → **fully login-free** stack |
| OpenAI / Anthropic | API key | centralised | Familiar default; needs `*_API_KEY` env |

The "login-free" path is the most interesting design: with **Flock for
inference + x402 for folder payments + wallet for identity**, a user can
use aindrive end-to-end without ever signing up for anything. They open
the URL, connect a wallet, pay for what they use, and get an AI agent
collaborating on their files — all without an account, an API key, or a
SaaS subscription.

### Layer responsibilities

| Layer | What it does | What it does NOT do |
|---|---|---|
| **Browser** | UI, Monaco editor, Y.Doc + IndexedDB, autosave | Touches your filesystem directly |
| **Next.js server** | Auth, sharing, allowlist, trace ring, RPC bridge | Stores file bytes (only metadata in SQLite) |
| **DocHub (server)** | Per-doc WebSocket broadcast for Y.js sync + Awareness | Parses Y.js bytes (treated as opaque) |
| **CLI agent (local)** | Filesystem RPCs, fs.watch, Willow Store appends | Opens an inbound port |
| **Willow Store (local SQLite)** | Persists every Y.Doc update as a Meadowcap-friendly entry | Replicates without a peer-to-peer sync session |

### Two transport protocols

1. **`/api/agent/connect`** — long-lived WebSocket from CLI to server.
   Carries fs RPCs (`list`, `read`, `write`, `mkdir`, `rename`, `delete`,
   `yjs-write`, `yjs-read`) plus multi-device sync gossip frames.
2. **`/api/agent/doc?drive=X&path=Y`** — per-document WebSocket from browser
   to server. Carries Y.js sync frames + Awareness updates. Server is dumb,
   only forwards to other peers and gates by role.

---

## How sharing works

aindrive has three layered access mechanisms — each more cryptographically
strict than the last:

### 1. Owner-managed allowlist (simple)

```
folder_access(drive_id, path, wallet_address, role, added_by, payment_tx?)
```

Owner manually adds a wallet to a folder/path. Path is hierarchical:
`docs/q1` grants access to anything under `docs/q1/...`. Roles ladder:
`viewer < commenter < editor < owner`.

### 2. Capability tokens (Meadowcap)

Every grant additionally issues a **Meadowcap capability** — a signed,
self-contained token encoding `{ namespace, path-prefix, time-range, role,
recipient-pubkey }`. Returned in response, can be embedded in share URLs:

```
https://aindrive.app/cap/<base64url-cap>
```

Server verifies the capability on every request — no DB lookup needed for
revocation if cap has expired. The drive's namespace keypair is generated
on drive creation and stored per drive.

### 3. [x402](https://x402.org) paid access

Owner can mark a share link as paid:

```
shares(token, path, role, price_usdc, payment_chain)
```

When a visitor without a wallet allowlist entry hits `/api/s/<token>`, the
server responds with **HTTP 402 Payment Required** following the
[x402 spec](https://x402.org) (body, not header):

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "maxAmountRequired": "500000",
      "payTo": "0x...owner-payout",
      "resource": "https://aindrive.ainetwork.ai/api/s/<token>",
      "description": "aindrive: access to share <token>",
      "maxTimeoutSeconds": 300,
      "mimeType": "application/json"
    }
  ],
  "error": "X-PAYMENT header is required"
}
```

The visitor (human via wallet popup, or AI agent automatically) signs an
EIP-3009 USDC authorisation, base64-encodes the resulting payload, and
**re-issues the same `GET /api/s/<token>` with an `X-PAYMENT` header**.
Server hands the payload to the x402 facilitator (`AINDRIVE_X402_FACILITATOR`,
default `https://x402.org/facilitator`) for `verify` + `settle`, then
**inserts the payer wallet into folder_access** and issues a Meadowcap cap.
From that moment, the wallet has permanent access (until owner revokes).

> **Spec note.** aindrive uses **[x402 protocol v1](https://x402.org)**
> (`x402Version: 1` in every envelope). v1 communicates payment requirements
> in the **JSON body** (`accepts: [PaymentRequirements]`), the client carries
> the signed `PaymentPayload` in an `X-PAYMENT` header on retry, and on
> success the server may set an `X-PAYMENT-RESPONSE` header with the
> facilitator's settle receipt. (x402 v2 renames these to
> `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`; aindrive
> tracks v2 via the `x402` npm package and will move with it.)

Payment is a **one-shot, lifetime grant** — no recurring billing, no per-file
charges. The mental model is "buying a key", not "paying per door open".

---

## Payment → permission lifecycle (deep dive)

This is the core economic loop: a wallet pays once, gets durable folder access,
keeps that access across sessions/devices/agents until the owner revokes.

### Step 1 — owner publishes a paid share

Owner opens the Share dialog, sets a price + role:

```http
POST /api/drives/<driveId>/shares
Cookie: aindrive_session=<owner-jwt>
{
  "path": "research/",
  "role": "viewer",
  "price_usdc": 0.50,
  "expiresAt": null      // optional — share LINK expiry (not access expiry)
}
```

Server inserts:
```sql
INSERT INTO shares
  (id, drive_id, path, role, token, price_usdc, payment_chain, created_by)
VALUES (?, ?, 'research/', 'viewer', <random-token>, 0.50, 'base', <owner-id>);
```

Owner gets back `https://aindrive.app/s/<token>` — that's what they paste
into Twitter / Slack / Telegram.

### Step 2 — visitor (human or AI agent) loads the share

```
GET /api/s/<token>
```

Server checks, in order:

1. Is the token still valid? (`shares` row exists, `expires_at` not past)
2. Is the requester the owner? → return `200` immediately.
3. Is the share **free** (`price_usdc IS NULL`)? → return `200`.
4. Does the requester have a `aindrive_wallet` cookie + a row in
   `folder_access` for this `(drive_id, path, wallet_address)`? → return `200`.
5. Otherwise → return `402` with the x402 payment requirements in the body.

The `402` response follows the [x402 spec](https://x402.org): the
requirements live in the JSON body under `accepts[]`, not in a header. Any
x402-aware client (browser wallet, AI agent, autonomous script) can pay
automatically:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base-sepolia",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "maxAmountRequired": "500000",
    "payTo": "0x...owner-payout",
    "resource": "https://aindrive.ainetwork.ai/api/s/<token>",
    "description": "aindrive: access to share <token>",
    "maxTimeoutSeconds": 300,
    "mimeType": "application/json"
  }],
  "error": "X-PAYMENT header is required"
}
```

### Step 3 — visitor pays (X-PAYMENT header)

The visitor signs an EIP-3009 `transferWithAuthorization` for `0.50 USDC`
on Base to the owner's payout address — no separate broadcast needed; the
facilitator submits and confirms it. The result is wrapped in a
`PaymentPayload` and base64-encoded:

```http
GET /api/s/<token>
Cookie: aindrive_wallet=<their-jwt>     ← optional; binds payer to a session
X-PAYMENT: <base64(JSON.stringify({
  x402Version: 1,
  scheme: "exact",
  network: "base-sepolia",
  payload: {
    authorization: { from, to, value, validAfter, validBefore, nonce },
    signature
  }
}))>
```

In `AINDRIVE_DEV_BYPASS_X402=1` mode the server accepts a minimally-shaped
JSON for local demos; in prod it parses with the official `PaymentPayloadSchema`
from `x402/types`.

### Step 4 — server verifies + grants

Server-side flow (atomic, in `web/app/api/s/[token]/route.ts`):

```js
// 1. Load share row + decode the X-PAYMENT envelope
const share = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
const payload = PaymentPayloadSchema.parse(JSON.parse(safeBase64Decode(xPayment)));

// 2. verify + settle via the x402 facilitator (AINDRIVE_X402_FACILITATOR,
//    defaults to https://x402.org/facilitator)
const facilitator = useFacilitator({ url: FACILITATOR_URL });
const v = await facilitator.verify(payload, requirements);
if (!v.isValid) return 402;
const s = await facilitator.settle(payload, requirements);
if (!s.success) return 402;
const payer = (s.payer || payload.payload.authorization.from).toLowerCase();
const txHash = s.transaction;

// 3. INSERT the wallet into folder_access (UNIQUE constraint = idempotent)
db.prepare(`
  INSERT INTO folder_access
    (id, drive_id, path, wallet_address, added_by, payment_tx, role)
  VALUES (?, ?, ?, ?, 'payment', ?, ?)
`).run(nanoid(), share.drive_id, share.path, payer, txHash, share.role);

// 4. Issue a Meadowcap capability for the same area
const cap = await issueShareCap({
  namespacePub:    drive.namespace_pubkey,
  namespaceSecret: drive.namespace_secret,
  pathPrefix:      share.path,
  accessMode:      share.role === "viewer" ? "read" : "write",
});

// 5. Set the wallet cookie so subsequent requests are auto-authorized
await setWalletCookie(payer);

return { ok: true, driveId: share.drive_id, path: share.path,
         txHash, cap: cap.capBase64 };
```

The `200` response carries the same JSON body. Per x402 v1, the server MAY
also include an `X-PAYMENT-RESPONSE` header whose value is the base64-encoded
JSON receipt returned by `facilitator.settle(...)` — clients that need to
audit the on-chain settlement should read that header.

After this single roundtrip, the wallet has **two independent proofs of
access** (defense in depth):

| Proof | Where it lives | Verified by | Survives if… |
|---|---|---|---|
| `folder_access` row | server SQLite | every API request via `resolveAccess()` | server is up |
| Meadowcap capability | client cookie (`aindrive_caps`) + downloadable | Ed25519 signature on the cap | server compromised — only owner can forge |

### Step 5 — visitor returns later (lifetime access)

The visitor closes the browser, walks away, comes back next week:

```http
GET /api/drives/<driveId>/fs/list?path=research/
Cookie: aindrive_wallet=<their-jwt-from-pay-step>
```

Server:

```js
const wallet = await getWallet();   // decodes cookie → 0xabc…
const role = await resolveAccess(driveId, path, /* userId */ null);
// resolveAccess fans out to:
//   resolveRoleByUser(...)   → none (no session)
//   resolveRoleByWallet(...) → SELECT role FROM folder_access
//                              WHERE drive_id=? AND wallet_address=?
//                              AND path is ancestor-or-self of requested path
//   → returns 'viewer'
```

The wallet stays authorized **forever** until either:
- Owner revokes via `DELETE /api/drives/<id>/access/<rowId>` (→ `folder_access` row deleted), OR
- The visitor's wallet cookie expires (30d JWT — they re-prove ownership via SIWE and continue).

There's no per-request payment, no recurring billing, no rate-limit on
reads. The mental model is **buying a key** — once you have it, you use it
as much as you like.

### Step 6 — same wallet, second device

The user's second laptop:

1. Visit the share URL → cookie-less request → `402`.
2. The wallet (e.g. WalletConnect on mobile) signs a SIWE challenge on
   `/api/wallet/verify` → `aindrive_wallet` cookie set on this device too.
3. Now this device's request matches the same `folder_access` row → `200`.

No second payment needed. The wallet IS the identity; access follows the
wallet across browsers, devices, even AI agents holding the same key.

### Step 7 — AI agent pays (no human in the loop)

An autonomous agent does exactly the same x402 flow, with one difference:
it manages its own wallet:

```python
# pseudo-code
resp = httpx.get(share_url)
if resp.status_code == 402:
    accepts = resp.json()["accepts"]
    req = next(a for a in accepts if a["scheme"] == "exact")
    auth = wallet.sign_eip3009_transfer(
        to=req["payTo"], value=req["maxAmountRequired"],
        asset=req["asset"], network=req["network"],
    )
    payment = base64.b64encode(json.dumps({
        "x402Version": 1, "scheme": "exact", "network": req["network"],
        "payload": { "authorization": auth.message, "signature": auth.signature }
    }).encode()).decode()
    resp = httpx.get(share_url, headers={"X-PAYMENT": payment})
# 200 → response body has { driveId, path, txHash, cap }; cookie is now set.
files = httpx.get(f"{base}/api/drives/{driveId}/fs/list?path=research/").json()
for f in files["entries"]:
    content = httpx.get(f"{base}/api/drives/{driveId}/fs/read?path={f['path']}").json()
    embed_and_index(content)
```

For agents driving aindrive over MCP rather than HTTP, the same flow is
exposed as the `resolve_share` tool (see [`aindrive mcp`](#mcp-server) below).

Whenever the agent comes back, the wallet is recognized, no payment is
required again. Persistent agent memory of "I paid for folder X with wallet Y"
means it never accidentally re-pays.

### Step 8 — owner sees + manages the new member

The owner's Share dialog now shows the wallet, who paid, and the txHash:

```
Wallet access:
  0x70997970…dC79c8   research/   payment   tx 0xDEADBEEF…   added 2 days ago
```

Owner clicks `Remove` → `DELETE /api/drives/<id>/access/<rowId>` →
`folder_access` row gone → wallet's next request returns `403`.

The `cap` cookie is still in the visitor's browser, but on every fs/* call
the server short-circuits with `resolveAccess() === 'none'`. (Future work:
publish a Meadowcap revocation entry to a well-known subspace so even
peer-to-peer Willow sync respects revocation without needing the server.)

### Why this design

- **Self-serve by AI agents** — agents are the original use case for
  [x402](https://x402.org). They need to pay for resources without a human
  clicking buttons. aindrive treats agents and humans identically here.
- **Wallet is identity** — no separate user account needed for paid
  visitors. Combined with login-free LLM (Flock) → entire flow runs without
  signup.
- **Owner keeps control** — payment grants persistent access, but owner
  can revoke at any time. Revocation is a single DB row delete.
- **Two-tier proof** — server-side `folder_access` row is the primary
  authority; Meadowcap cap is a portable backup/proof that works even when
  the visitor is offline or syncing P2P.
- **Path-scoped** — payment for `research/` doesn't grant access to
  `private/`. Owner publishes one share per area they want to monetize.

---

## How collaborative editing works

Built on **Y.js** (CRDTs) — character-level merge with no central authority.

### Browser side

```
Monaco editor
  ↕ y-monaco binding (textarea ↔ Y.Text)
Y.Doc
  ├ AindriveProvider (custom)  ←  WebSocket /api/agent/doc
  └ IndexeddbPersistence       ←  per-tab IndexedDB
```

Every keystroke produces a binary update. The provider:
1. Writes it to IndexedDB (offline survival).
2. Sends it on the WebSocket to the server.
3. Server forwards to other peers on the same `(driveId, path)`.
4. Each peer applies it to their Y.Doc → Monaco re-renders.

**Awareness** rides the same socket: cursors, selections, user name + color.

### Server side

The DocHub keeps a `Map<docId, Set<peer>>`. Frames are forwarded to every
*other* peer in the same set. Subscription requires `role >= viewer`; pushing
sync updates requires `role >= editor`. **The server never inspects Y.js
bytes** — it can't read the document content.

### Persistence

Two sinks:
1. **Disk file** — autosave debounced 5s after last keystroke. The agent
   writes UTF-8 text via the existing `write` RPC. The agent's `fs.watch`
   suppresses self-write notifications for 2s to prevent the autosave →
   fs.watch → reload echo loop.
2. **`.aindrive/willow.db`** — every save also appends a Y.Doc binary update
   to a per-doc Willow Store entry. Compacted automatically (50 entries / 1
   MB / 10 minutes thresholds) by replaying through a fresh Y.Doc and
   storing the snapshot.

Re-opening the file replays the Willow Store entries → fresh Y.Doc → seed
Monaco. If the Willow Store is empty, fall back to seeding from the disk file.

---

## Why Willow Protocol

aindrive's data model isn't ad-hoc — it's borrowed from
[**Willow Protocol**](https://willowprotocol.org), a P2P data spec designed
for capability-based, eventually-consistent file-like data. Three ideas
from Willow shape how aindrive thinks:

### 1. Three-dimensional data — `(namespace, subspace, path)`

Every piece of data lives at a coordinate in three independent axes:

| Axis | aindrive meaning |
|---|---|
| **Namespace** | One whole drive = one owned namespace. NamespaceId = drive's Ed25519 pubkey. |
| **Subspace** | One device or one author = one subspace. Each user/agent gets a keypair. |
| **Path** | The file path (`docs/q1/notes.md`), encoded as a Willow path. |

Plus an implicit fourth dimension: **timestamp** on every entry, used for
ordering and pruning.

This means "the same file on two devices" is naturally two separate
subspace×path entries that merge — no central coordinator needed.

### 2. Owned vs Communal namespaces

Willow distinguishes:

- **Owned namespace** — derived from a namespace keypair held by the owner.
  Top-down model: only the owner (or someone they delegate to) can write.
  **aindrive uses owned namespaces** — every drive has exactly one root key,
  generated on `createDrive()` and stored encrypted in the server SQLite
  (`drives.namespace_secret BLOB`). The owner delegates write capability to
  collaborators via Meadowcap, never sharing the root key.

- **Communal namespace** — anyone with a subspace key can write to their
  own subspace. Wiki-like.
  Not currently used by aindrive but the schema supports it for future
  "team drives" without a single owner.

### 3. Meadowcap — capabilities as data

Instead of "I have a server-side ACL row that says you can read this folder,"
Willow uses **Meadowcap**, where:

> A capability is a self-contained, signed token saying
> "the owner of namespace N grants `<read|write>` access to subspace S
> for paths starting with P, between time T1 and T2, to recipient R."

Anyone can verify a cap with just the public namespace key — no server lookup
needed. Caps can be **delegated** down a chain (owner → collaborator →
sub-collaborator), each step adding a signature that further restricts the
area.

aindrive uses Meadowcap for:
- **Share links** — `aindrive://cap/<base64url-cap>`. Encoded once,
  parsed by anyone, no DB hit on the happy path.
- **API access tokens** — agents present a cap with their request, server
  verifies signature + checks the granted area covers the requested path.
- **Time-bounded shares** — encode `{ time_range: [now, now + 7d] }` and
  the cap auto-expires, no DB cleanup needed.
- **Path-scoped delegation** — owner can give an agent "edit access to
  `drafts/` but not `private/`" by delegating with a smaller area.

### 4. Willow Store on disk (`.aindrive/willow.db`)

The CLI agent maintains a per-drive **Willow Store** as a SQLite file at
`<folder>/.aindrive/willow.db`:

```sql
CREATE TABLE yjs_entries (
  doc_id      TEXT NOT NULL,    -- sha1(driveId:path).slice(0,22)
  seq         INTEGER NOT NULL, -- monotonic per doc_id
  payload     BLOB NOT NULL,    -- raw Y.Doc update bytes
  digest      TEXT NOT NULL,    -- sha256 of payload (Willow PayloadDigest)
  created_at  INTEGER NOT NULL, -- ms epoch (Willow timestamp)
  kind        TEXT CHECK (kind IN ('update', 'snapshot')),
  PRIMARY KEY (doc_id, seq)
);
```

Each `yjs-write` RPC = one new Willow entry. Each entry has a SHA-256
digest and a timestamp — the Willow primitives. The schema is intentionally
shaped to be promotable to a real Willow Store with full Meadowcap
authorization wrapping (next milestone).

**Auto-compaction**: every append checks thresholds (≥50 updates, ≥1 MB
total payload, or oldest entry >10 min old) and if exceeded, replays
all updates through a fresh `Y.Doc`, encodes the merged state as a
single `snapshot` entry, and deletes everything older. Bounded growth,
no manual maintenance.

### 5. Multi-device sync (Willow-inspired gossip)

When two `aindrive` processes connect to the same drive (e.g. you work
on a doc from your laptop and your desktop), they both register their
WebSocket on the server's per-drive agent set. The CLI agent attaches
a small **WGPS-inspired gossip protocol**:

```
A → server → B    sync-summary  { docId, lastSeq, recent digests[] }
B → server → A    sync-want     { docId, missing digests[] }
A → server → B    sync-give     { docId, entries[] (with payloads) }
B applies entries to its own Willow Store (deduping by digest)
```

Periodic summaries every 30s + immediate response on receive. **Same
content-digest = no-op** (idempotent). The full WGPS handshake with
Private Area Intersection isn't implemented yet — the current protocol
trades some efficiency for simplicity, replicating the entire shared-area
summary instead of negotiating intersections cryptographically.

Once both stores converge, opening the file in a browser on EITHER device
replays the same entries → same Y.Doc state → same text.

### 6. Willow vs Y.js — why both?

A common question: "Willow is a CRDT-style protocol. Why do we need Y.js on
top of it?"

The two operate at completely different granularities:

| | **Willow** | **Y.js** |
|---|---|---|
| Merge unit | Entry (whole file version) | Character (inside text) |
| Conflict resolution | Last-writer-wins per `(subspace, path)` | True CRDT merge — both edits preserved |
| Payload semantics | Opaque bytes — Willow doesn't look inside | Structured (Text, Map, List) |
| Permissions | Meadowcap built-in | None |
| Multi-device sync | WGPS protocol | Save/load only |

Willow is "CRDT-like" only at the entry level — it gives you eventual
consistency for "what is the current version of file X" — but if two peers
write to the same path concurrently, **the newer timestamp wins entirely**
and the other write is lost.

#### What goes wrong with Willow alone

```
Tab A types "AAAA" → autosave → Willow entry { path: notes.md, payload: "AAAA", t: t1 }
Tab B types "BBBB" → autosave → Willow entry { path: notes.md, payload: "BBBB", t: t2 }
t2 > t1  →  B wins, A's "AAAA" is gone forever.
```

There is no character-level merge in Willow. It is a *data sync* protocol,
not an *editing* CRDT.

#### How Y.js fits

Y.js does the actual character-level merge. Each Y.Doc update is a small
binary delta (NOT the whole file content). aindrive stores those deltas
**as Willow entry payloads**:

```
Tab A types "AAAA"  →  Y.js update bytes (delta)  ──┐
Tab B types "BBBB"  →  Y.js update bytes (delta)  ──┤
                                                     ▼
                          ┌────────────────────────────────────┐
                          │  Each update = one Willow entry    │
                          │  appendUpdate(docId, payloadBytes) │
                          └─────────────────┬──────────────────┘
                                            │
                              Multi-device sync (Willow's job)
                                            │
                                            ▼
                  Other device replays ALL entry payloads:
                    for (e of entries) Y.applyUpdate(doc, e.payload)
                  →  CRDT-merged final state. Both AAAA and BBBB present.
```

The two layers compose cleanly:

- **Y.js layer**: "How do many edits to the same content merge correctly?"
- **Willow layer**: "How do we store, authorize, and sync those edit
  records across devices?"

Earthstar (Willow's reference application) recommends exactly this pattern
— Willow Store + Y.js update payloads — as the standard collaborative
editing recipe. The Willow spec even explicitly describes "running CRDTs on
top of Willow" as the intended composition.

### Why bother with Willow instead of just "file + Y.Doc binary"?

- **Capability-native sharing** — Meadowcap caps work without a server. We
  could (and plan to) move share verification to the edge / browser /
  agent — owner offline, share still works.
- **Multi-device by default** — append-only entries with monotonic
  digests are trivial to sync; mutable files are not.
- **Composable** — once a doc lives in a Willow Store, RAG agents can sync
  the same store to their own machine and query offline.
- **Standardised** — third parties implementing Willow get a-indrive-
  compatible storage for free.

The current implementation is a pragmatic subset: we use Willow's *mental
model* and *file format* without yet running the full WGPS sync protocol or
the official `@earthstar/willow` Store with `KvDriver`. The schema and
content-digest discipline mean we can swap in the full Willow library as
the project matures without migrating data.

See [`docs/WILLOW_DESIGN.md`](docs/WILLOW_DESIGN.md) for the longer design
discussion of where aindrive maps onto the Willow spec.

---

## How AI agents fit in ([A2A](https://a2a-protocol.org) + RAG)

aindrive's primary insight: **a folder of files is a perfect RAG corpus, and
the app itself runs an AI agent over it — collaboratively editing alongside
humans, with capabilities and payments first-class.**

### The built-in agent

Every aindrive deployment ships an internal AI agent runtime inside the
Next.js process. It owns:

- **Folder RAG** — walks the drive's files, chunks + embeds them, stores
  vectors in a per-drive table, answers semantic queries.
- **Live editor peer** — opens its own `/api/agent/doc` connection just
  like a human tab; appears as a presence avatar in the UI.
- **A2A endpoint** — exposes the standard Agent-to-Agent JSON-RPC interface
  so other apps / agents can talk to it without any aindrive-specific glue.

The only thing that leaves the box is the LLM API call (with the user's
own key — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc., set per-deployment).
Embeddings, indexing, retrieval, edit application all happen inside aindrive.

### [A2A](https://a2a-protocol.org) is the door (for both internal and external agents)

The same A2A interface is used:

1. **Internally** — the browser UI talks to the built-in agent via A2A
   when the user clicks "Ask aindrive about this folder".
2. **Externally** — a 3rd-party app (Claude desktop, custom workflow,
   another aindrive instance) discovers the AgentCard, possibly pays via
   x402, then issues A2A calls.

### Discovery ([A2A](https://a2a-protocol.org) AgentCard)

Each drive exposes an A2A AgentCard at:

```
GET /d/<driveId>/.well-known/agent.json
```

```json
{
  "name": "aindrive folder X",
  "description": "Personal research notes — Q1 2026",
  "version": "1.0.0",
  "capabilities": ["streaming", "pushNotifications"],
  "skills": [
    { "id": "list-files",  "name": "List drive contents",
      "description": "Browse the folder hierarchy" },
    { "id": "read-file",   "name": "Read a file's content" },
    { "id": "write-file",  "name": "Edit a file collaboratively",
      "description": "Joins the live Y.js session" },
    { "id": "search",      "name": "Semantic search across the folder",
      "description": "RAG endpoint over the folder's files" }
  ],
  "auth": [
    { "type": "bearer", "description": "Owner-issued API token" },
    { "type": "x402",
      "x402Version": 1,
      "accepts": [{
        "scheme": "exact",
        "network": "base-sepolia",
        "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "maxAmountRequired": "500000",
        "payTo": "0x...owner-payout",
        "maxTimeoutSeconds": 300,
        "mimeType": "application/json"
      }],
      "description": "Pay for one-time lifetime read access" }
  ]
}
```

A 3rd-party agent (Claude, ChatGPT plugin, custom) discovers the card,
sees the price, decides to pay.

### Pay → access ([x402](https://x402.org))

```
agent  → POST /api/agent/skill/read-file { path: "research/notes.md" }
server → 402 Payment Required (body: x402 accepts[] with the AgentCard price)
agent  → signs an EIP-3009 USDC authorisation, base64-encodes the
         PaymentPayload, retries the call with X-PAYMENT header
server → facilitator.verify + settle, folder_access INSERT,
         returns 200 + Meadowcap cap
```

The cap is what the agent presents on subsequent calls. The agent's wallet
address becomes its identity in `folder_access`.

### Permission management ([A2A](https://a2a-protocol.org) messages)

Agents can negotiate role upgrades via A2A messages:

```json
{
  "method": "message/send",
  "params": {
    "message": {
      "role": "agent",
      "parts": [{
        "kind": "data",
        "data": {
          "intent": "request-write-access",
          "for-path": "drafts/",
          "reason": "to apply RAG-suggested rewrites"
        }
      }]
    }
  }
}
```

The owner's app surfaces this as a permission prompt. Owner approves →
`folder_access.role` upgraded from `viewer` to `editor`. Owner can revoke
at any time.

### Collaborative RAG editing

Once an agent has `editor` role, it joins the same Y.js document the human
is editing. Practical RAG flow:

1. Human types a question or `[REWRITE]` marker in `draft.md`.
2. AI agent (subscribed to the same Y.Doc via `/api/agent/doc`) sees the
   change in real time via Awareness/Y.update.
3. Agent runs RAG over the rest of the folder via `/api/agent/skill/search`
   (which calls list + read RPCs internally).
4. Agent inserts the answer or rewrite directly into the Y.Doc — appears
   live in the human's Monaco editor.
5. Both writes (human + agent) merge cleanly via CRDT — no overwrites.

This is what "shared editing with an AI" looks like when the AI is a
peer, not a feature.

---

## How RAG is implemented

RAG is **part of aindrive itself**. The built-in agent indexes each drive's
files and serves retrieval queries. Embedding generation is pluggable:

- **Local** — `nomic-embed-text` via Ollama, sentence-transformers via
  Python sidecar. Zero network egress.
- **Web3** — Flock embedding subnet, paid per call from the user's wallet.
  No API key, no signup.
- **Cloud** — OpenAI `text-embedding-3-small`, Voyage, Cohere. Needs an
  API key per provider.

When configured with **local + Flock**, aindrive can run **completely
account-free**: no provider signup, no API key, no SaaS bill — just a
wallet, a folder, and a URL.

| Step | Where | Notes |
|---|---|---|
| 1. Enumerate | aindrive built-in agent | walks `fs/list` recursively, respects `.aindrive` ignore |
| 2. Read | built-in agent calls `fs/read` | utf8 for text, base64 for binaries (skipped) |
| 3. Chunk | built-in agent | configurable strategy (paragraph, fixed-tokens, semantic) |
| 4. Embed | pluggable: local model / Flock / OpenAI | local has no egress; Flock has no API key; cloud needs key |
| 5. Store | per-drive `embeddings` table in SQLite | sqlite-vec / pgvector if scaled later |
| 6. Query | A2A skill `search { query }` | top-k retrieval, returns chunks + paths |
| 7. Edit | built-in agent joins Y.js as a peer | inserts answers/rewrites live into the doc |
| 8. Re-index | fs.watch fires → debounce → re-embed changed files | incremental, append-only embeddings |

External agents can either:
- **Use aindrive's RAG** via the A2A `search` skill (one HTTP call) — pay
  per query via x402 or with allowlisted access.
- **Build their own** by enumerating + reading via the same fs APIs and
  bringing their own embedding pipeline.

In either case, **edits go through Y.js**, so an external agent's writes
merge live with the human's keystrokes — no overwrites.

---

## MCP server (`aindrive mcp`) <a id="mcp-server"></a>

Every aindrive install ships an [MCP](https://modelcontextprotocol.io)
stdio server bundled into the same single binary. AI assistants
(Claude Code, Claude Desktop, Cursor, …) can drive every drive operation
without any aindrive-specific glue.

```bash
npm i -g aindrive
aindrive mcp        # stdio MCP server
```

**Claude Code / Desktop config:**

```json
{
  "mcpServers": {
    "aindrive": { "command": "aindrive", "args": ["mcp"] }
  }
}
```

**Auth precedence** (set as env on the MCP process):
1. `AINDRIVE_SESSION` — full owner cookie (`aindrive_session=...`)
2. `AINDRIVE_WALLET_COOKIE` — wallet cookie (`aindrive_wallet=...`)
3. Falls back to `~/.aindrive/credentials.json` from `aindrive login`.

`AINDRIVE_SERVER` (or `--server`) overrides the target host.
`AINDRIVE_CAP` adds a Meadowcap cap header to every call.

**Tools exposed:**

| Group | Tools |
|---|---|
| Discovery | `list_drives`, `drive_info` |
| Files | `list_files`, `read_file`, `write_file`, `rename`, `delete_path`, `stat`, `search` |
| Sharing | `create_share`, `list_shares` |
| Wallet allowlist | `grant_access`, `list_access`, `revoke_access` |
| Capabilities | `verify_cap` |
| Paid shares | `resolve_share` (auto-builds the x402 X-PAYMENT envelope) |
| Agents | `list_agents`, `ask_agent` (A2A) |

**Resources exposed:** `aindrive://drive/<driveId>/{+path}` — Claude can
attach drive files directly via `@aindrive://...` references.

---

## Storage layout

| Where | What |
|---|---|
| **Server SQLite** (`AINDRIVE_DATA_DIR/data.sqlite`) | users, drives, drive_members, shares, folder_access (the metadata) |
| **Server in-memory** | trace ring buffer (10k events), agent map, DocHub map |
| **Local agent SQLite** (`<folder>/.aindrive/willow.db`) | yjs_entries — per-doc Willow Store |
| **Local agent files** (`<folder>/.aindrive/yjs/<docId>.bin`) | Latest Y.Doc snapshot for cold-start reads |
| **Local agent config** (`<folder>/.aindrive/config.json`) | driveId, agentToken, driveSecret |
| **User filesystem** (`<folder>/...`) | The actual files — written as plain UTF-8 / binary |

---

## Security model

- **Outbound-only agent**: the CLI never opens an inbound port. The internet
  cannot directly reach your machine.
- **HMAC-signed RPCs**: every request from server to agent and every response
  is signed with `driveSecret`. Forging a request would require both the
  Redis-equivalent connection AND the secret.
- **Path traversal blocked**: every requested path is `safeResolve()`'d
  against the drive root.
- **Method allowlist**: unknown RPC methods are dropped silently.
- **Self-write suppression**: 2s window where the agent's `fs.watch` ignores
  changes to paths it just wrote — prevents autosave → fs.watch → reload
  loops.
- **Cap signature verification**: Meadowcap capabilities verified per-request
  via Ed25519 + Meadowcap encoding rules.
- **CSRF**: cookies are `httpOnly`, `sameSite=Lax`, `secure` in production.
  All mutating endpoints check session.

---

## Observability (the "diagnose this bug" story)

aindrive ships with first-class structured-logging tracing. **Every layer
emits the same JSON shape** — never a file write, always stdout +
in-memory ring buffer queryable over HTTP.

```bash
# Live tail every aindrive event
node web/server.js | jq 'select(.ns == "aindrive.trace")'

# Snapshot a particular doc's trace
curl 'http://localhost:3737/api/dev/trace/dump?docId=<docId>&limit=2000' | jq

# Run the analyzer to find invariant violations + root-cause hints
#  diagnose.mjs takes a JSONL file path (one event per line)
curl -s 'http://localhost:3737/api/dev/trace/dump?docId=<docId>&limit=2000' \
  | jq -c '.events[]' > /tmp/trace.jsonl
node tools/diagnose.mjs /tmp/trace.jsonl
```

`tools/diagnose.mjs` understands these invariants and prints the violating
event + a code-pointer to the likely fix:

| ID | Pattern | Hint |
|---|---|---|
| V1 | `disk-seed-apply` after `idb-load` (with content) | viewer.tsx synced-handler — gate on `whenReady` |
| V2 | `autosave-flush` without any preceding `ydoc-update` | autosave fired even though Y.Doc didn't change |
| V3 | `autosave-flush` while a remote sync is still pulling | wait until `provider-sub-ok` settles before flushing |
| V4 | Willow replay produces a digest that doesn't match the entry | store corruption or replay-order bug |
| V5 | local update doubles textLen after `idb-load` | IDB content was applied twice |
| V6 | `rpc-out` without `rpc-in-resp` for 25s | agent timed out / disconnected |
| V7 | `provider-sub-ok` before `provider-connect` | impossible — replay or test bug |
| V8 | multiple `disk-seed-apply` in same session | seeded from disk twice |
| V9 | `autosave-flush` followed by `reload-event` < 1s | self-write fs.watch loop — agent's `isSelfWrite` table missed it |
| V10 | `reload-event` followed by `ydoc-update` with same textLen | reload was a no-op echo — viewer should short-circuit |

When a user says "edits are getting rolled back", the response is "send me
the trace" and `diagnose.mjs` prints the file:line to fix.

---

## Repo layout

```
aindrive/
├── web/                   # Next.js 15 + custom Node server
│   ├── server.js          # http + ws upgrade + Next handler
│   ├── lib/
│   │   ├── agents.js      # CLI ↔ server WS map + RPC dispatch
│   │   ├── dochub.js      # browser ↔ server per-doc broadcast
│   │   ├── access.ts      # role resolution (user OR wallet → role)
│   │   ├── drives.ts      # drive CRUD + Ed25519 namespace keypairs
│   │   ├── trace.js       # stdout JSON + ring buffer
│   │   ├── willow/        # Meadowcap setup + cap issuance
│   │   └── yjs/           # AindriveProvider + trace-client
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/      # signup, login, logout
│   │   │   ├── wallet/    # SIWE-style wallet sign-in
│   │   │   ├── drives/    # drive CRUD + per-drive fs/yjs/access/shares
│   │   │   ├── s/         # share token endpoint (single GET; x402 X-PAYMENT)
│   │   │   ├── cap/       # capability decode + verify
│   │   │   └── dev/trace/ # POST sink + ring buffer dump
│   │   ├── d/[driveId]    # owner / member view
│   │   └── s/[token]      # share link landing
│   ├── components/        # DriveShell, Viewer, ShareDialog, ShareGate
│   └── scenarios/         # ~150 integration tests (cases + collab + trace + emergent)
│
├── cli/                   # `npm i -g aindrive`
│   ├── bin/aindrive.mjs   # CLI entry
│   └── src/
│       ├── agent.js       # WS client, fs.watch, willow-sync attachment
│       ├── rpc.js         # RPC method allowlist + handlers
│       ├── willow-store.js  # SQLite-backed yjs_entries + compaction
│       ├── willow-sync.js   # multi-device entry-diff gossip
│       ├── commands/      # login, serve, rotate-token, status, mcp
│       └── mcp/           # MCP stdio server (tools, resources, HTTP client)
│
├── tools/
│   └── diagnose.mjs       # trace analyzer + invariant checker
│
└── docs/
    ├── TRACE_CONTRACT.md
    ├── CONCURRENT_EDITING_DESIGN.md
    ├── WILLOW_DESIGN.md
    └── TEST_SCENARIOS.md  # 160-scenario checklist
```

---

## Quickstart (local dev)

```bash
# 1. Server
cd web
npm install
AINDRIVE_DATA_DIR=/tmp/aindrive-data PORT=3737 \
  AINDRIVE_DEV_BYPASS_X402=1 \
  node server.js
# → http://localhost:3737

# 2. CLI agent
cd ../cli
npm install
AINDRIVE_SERVER=http://localhost:3737 node bin/aindrive.mjs login
cd /any/folder
AINDRIVE_SERVER=http://localhost:3737 node /path/to/cli/bin/aindrive.mjs

# 3. Open the URL it printed → browse, edit, share
```

## Tests

```bash
cd web
node scenarios/run.mjs
# → ~150 scenarios across auth, fs, sharing, x402, Y.js editing,
#   multi-device sync, observability, emergent steady-state behavior.
#   IDs are sparse 1–160 (a handful, e.g. #68–#75 around the legacy
#   /pay endpoint, were retired when the API moved to x402 X-PAYMENT).

# Filter by group:
SCENARIO='14[1-9]|15[0-9]|160' node scenarios/run.mjs   # emergent only
```

> **Sample folder.** Several scenarios pair `web/scenarios/sample/` (or
> `sample/` at the repo root) as the agent's served folder, then write
> their own marker files before asserting on listings — they don't depend
> on any specific pre-existing files in the sample folder.

## License

MIT

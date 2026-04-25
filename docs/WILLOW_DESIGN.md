# aindrive on Willow Protocol — Design

> Replace the current Postgres-queue RPC bridge with [Willow Protocol](https://willowprotocol.org) so file sharing uses capability-based P2P sync instead of "the relay proxies every file op."

## Why Willow

The current architecture treats the web server as a **trusted middle-man** — every byte the browser sees has been pulled by the Next.js server from the local CLI agent over our own RPC. That works, but:

- Sharing is bespoke: tokens, roles, expiry — all hand-rolled in Postgres.
- The web app must hold a live agent connection for *every* read.
- Adding a second device to one drive is a non-trivial protocol change.
- "Collaborator with their own machine" requires the collaborator to also tunnel through our central server.

Willow gives us, off the shelf:

| Need | Willow primitive |
|---|---|
| Hierarchical files | `path` (length-prefixed components) under a `subspace` inside a `namespace` |
| Per-file content | `Entry` (metadata) + `Payload` (bytes, content-addressed) |
| Multi-device per user | Multiple `subspace_id`s under one owned `namespace` |
| Collaborators | Meadowcap **capabilities** delegated to their key |
| Time-bounded share links | Capabilities with a time range, signed once, no DB lookup |
| Eventual consistency between devices | WGPS sync over any duplex byte stream |
| Selective sync ("only the `/photos` folder") | `AreaOfInterest` |

## Core mapping

```
Drive            ↔  one owned Namespace (NamespaceId = owner's public key)
Device           ↔  one Subspace        (SubspaceId  = device public key)
Folder           ↔  Path prefix         ("docs", "docs/q1")
File             ↔  Entry  (path = file path, payload = file bytes)
File version     ↔  Entry timestamp + author signature
Share link       ↔  read   capability over an Area, optionally with time bound
Collaborator     ↔  write  capability over an Area, delegated to invitee's key
Revoke share     ↔  publish a "revocation" cap or rely on expiry
```

Filesystem semantics:

- File overwrite → new Entry at same path, newer timestamp wins per Willow's pruning rules.
- Delete → tombstone Entry (zero-length payload, special flag).
- Rename → delete old path + create new path (atomic in the agent, two entries on the wire).

## Components

```
┌───────────────────────────────┐                     ┌───────────────────────────────┐
│  aindrive CLI (your machine)  │  WGPS over WSS  ⇄  │  self-hosted relay + mirror   │
│  • full Willow store          │                     │  • Willow store (SQLite for   │
│  • owns the namespace key     │                     │     entries/caps,             │
│  • indexes local FS as        │                     │     local disk volume for     │
│    Entries (lazy hashing)     │                     │     payloads)                 │
│  • outbound only              │                     │  • mirrors only what its caps │
└──────────────┬────────────────┘                     │     authorize                 │
               │                                      └──────────────┬────────────────┘
               │ Meadowcap delegations                               │ HTTP GET / Server
               │ (caps in URLs or in DM)                             │ Components read
               ▼                                                     ▼
┌───────────────────────────────┐                     ┌───────────────────────────────┐
│  Collaborator's CLI           │                     │   Browser (you / collaborator) │
│  • runs WGPS to relay         │                     │  • thin Willow read client     │
│  • or directly to your CLI    │                     │  • Drive UI reads relay's      │
│    when both online           │                     │     mirror; falls back to      │
└───────────────────────────────┘                     │     direct WGPS in WebSocket   │
                                                       │     where supported            │
                                                       └───────────────────────────────┘
```

The relay is **a Willow peer**, not a privileged broker. It can only read what its capabilities allow. A private folder on your laptop never crosses the wire unless you grant the relay (or a specific collaborator) a cap.

## Sync flow

1. `aindrive login` → generate user namespace keypair (kept on disk, never sent), register the public key + relay-issued mirror cap in the server DB.
2. `aindrive` in a folder:
   - First run: create/open a local Willow store; set namespace = user-owned, subspace = this device's key.
   - Walk the folder; for each file, hash the bytes (lazy, only on change) and write an Entry whose payload digest matches.
   - Open WSS to `wss://aindrive.ainetwork.ai/api/willow/sync`.
   - Run **WGPS handshake**: present caps proving "I am the namespace owner," declare an AreaOfInterest covering the whole drive.
   - Stream Entries + Payloads to the relay's mirror.
3. Browser navigates to `/d/<namespace_pubkey>` → Server Component reads the relay's local Willow store at that namespace and renders the directory listing — **no live RPC to your laptop**.
4. Edit a file in the browser → POST `/api/willow/write` (the user is authenticated via session) → server-side, the relay signs an Entry on behalf of the *user's delegated cap to itself* (created once at pairing) → entry replicates back to your laptop on next WGPS round, and the agent materializes the bytes onto disk.

## Sharing model (Meadowcap)

A share link is just a serialized capability. Concretely:

```
aindrive://cap/<base64url(SerializedCap)>
```

`SerializedCap` is a Meadowcap subspace cap with:

- `namespace_id` = drive owner's public key
- `area` = `{ subspace_id: any, path_prefix: "docs/q1", time_range: [now, now + 7d] }`
- `access_mode` = `read` | `write`
- `delegations` = chain ending at either the recipient's public key (named share) **or** `()` (anyone-with-the-link share)

The web UI's "Share" dialog generates this cap server-side using the owner's *delegation key* (a sub-key the owner uploaded to the relay during pairing for exactly this purpose; the root namespace key never leaves the laptop). The relay can then authorize any peer that presents the cap — including the browser session of the recipient.

**Revocation:** publish a "max-timestamp clip" entry inside a well-known revocation subspace; peers reject caps whose `created_at < clip`. Or simpler v1: rely on short expiries + the fact that the relay can refuse to mirror to a revoked recipient.

## What this changes in our codebase

| Today | After |
|---|---|
| `web/lib/rpc.ts` (Postgres queue) | Delete. Replaced by direct Willow store reads on the relay. |
| `cli/src/agent.js` (HTTP long-poll) | Replaced by `cli/src/willow-peer.js` — WGPS over WebSocket. |
| `web/lib/access.ts` (role table) | Replaced by Meadowcap cap verification. |
| `shares` table | Becomes `share_caps` table — stores serialized caps for revocation tracking. |
| `drive_members` table | Becomes `cap_grants` — same shape, but each row is a Meadowcap delegation. |
| File preview (`/api/drives/.../fs/read`) | Replaced by the relay reading its own Willow store; payloads served from local disk volume. |
| Drive id | Switch from `nanoid(12)` to `base32(namespace_pubkey)`. |

The browser-facing UI (`drive-shell.tsx`, `viewer.tsx`, `share-dialog.tsx`) stays the same shape — only the data source under it changes.

## Storage on the relay

| Data | Where |
|---|---|
| Entries (metadata, signatures) | SQLite — one row per entry, indexed `(namespace, subspace, path, timestamp)` |
| Payloads (file bytes) | Local disk volume mounted into the container. Deduped by digest. |
| Caps | SQLite `share_caps`, plus an in-memory verifier on every API request |
| Sync session state | Per-WSS-connection memory; no persistence |

## Picking a Willow implementation

- **JS/TS**: [`@earthstar-project/willow-js`](https://github.com/earthstar-project/willow-js) — most complete, runs in Node and the browser. Probably what we use on both CLI and the relay.
- **Rust**: `willow-rs` — better perf, but adds a build pipeline.

Default: TypeScript everywhere → reuse types and signing logic across CLI, server, and browser. Only swap to Rust if hashing throughput on large folders becomes a bottleneck.

## Migration plan from current architecture

1. Add `cli/src/willow-peer.js` next to `agent.js`; both can run; new drives use Willow.
2. Add `web/app/api/willow/sync/route.ts` (WSS upgrade) + `web/lib/willow-store.ts`.
3. Implement `share-cap` issuance in the existing share dialog; old `shares` table remains for legacy share links until they expire.
4. Switch `web/app/d/[driveId]/page.tsx` to read from Willow store instead of calling `callAgent`.
5. Once green, delete `lib/rpc.ts`, the queue table, and the long-poll routes.

## Open questions (decide before we cut code)

1. **Where does the user's namespace root key live?** On the laptop only? Or escrowed (encrypted) on the relay for "sign in from a new device"? Affects how scary "lost laptop" is.
2. **Anonymous share links** (cap with no delegation chain endpoint) — convenient but harder to revoke. Allow them, or always require named recipients?
3. **Large files (>100 MB).** Willow streams payloads in chunks; we need to decide how many we hold on the relay's disk (cost) vs only synced peer-to-peer (browser can't preview).
4. **End-to-end encryption for private namespaces.** Willow itself is plaintext on the wire to the relay. If a user wants the relay to only ever see ciphertext for their private folder, we need an E2EE layer on top — out of scope for v1, but the design shouldn't preclude it.

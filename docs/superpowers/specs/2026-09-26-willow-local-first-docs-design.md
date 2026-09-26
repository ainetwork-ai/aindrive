# Willow local-first documents: offline editing and signed authorship

Date: 2026-09-26 · Status: proposed · Scope: Phase 1 of the Willow roadmap (§10)

## 1. Goal

A collaboratively edited document on aindrive (`.md` in the rich-text editor, code
and text in Monaco — the Yjs documents) should:

1. **Work offline.** It opens and edits with no network, on any device that has it,
   and merges on reconnect without anyone pressing anything.
2. **Know who wrote what.** Every change is signed by the device that made it, and
   that device is bound to a person. Anyone holding the document can check it
   without trusting the aindrive server.
3. **Need no extra step from users.** Keys are made and bound during things people
   already do: signing in, pairing a device.

The server becomes one peer among others: it caches and relays, and it cannot forge
an edit.

Non-goals for this phase: binary files and media (the P2P media spec,
`2026-09-26-p2p-media-streaming-design.md`), direct device-to-device sync without the
server (Phase 2, §10), and ainmem pages (ainmem's own spec).

## 2. What is there today (verified 2026-09-26, origin/main 43eab85)

- Browser: `web/lib/yjs/aindrive-provider.ts` relays Yjs over `/api/agent/doc`, keeps
  a `y-indexeddb` copy. Frames sent while the socket is closed are dropped (:152); a
  failed autosave (`fs/write` + `POST /yjs`) is logged, not retried. The rich-text
  editor seeds from the markdown on disk and never pulls `/yjs`, so local and agent
  CRDT histories can diverge; a disk reload replaces the whole text.
- Server: `web/lib/dochub.js` relays only; no persistence, no author.
- CLI: `yjs_entries` SQLite is the real store; the `@earthstar/willow` Store is written
  fire-and-forget and never read (`cli/src/willow-store.js:13-20`), with authorisation
  that always passes (`cli/src/willow/schemes.js:131-144`). `willow-sync.js` is a
  custom digest gossip whose incoming entries are not verified.
- Phones: `yjs-write` overwrites one `<docId>.bin`; no history, no sync.
- Identity: no per-user or per-device signing key. Each drive's namespace secret key
  is kept on the server (`web/lib/drives.ts:81-89`).

## 3. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Communal namespace per drive.** Each device writes only in its own subspace; nobody holds a namespace secret. | Removes the server-held namespace key (the top risk in today's audit). A communal namespace is standard Meadowcap: a write is authorised by the subspace owner's own signature. |
| D2 | **Subspace = device key (Ed25519)**, made silently on first use and never exported. | This is the "who wrote it" unit. Per-device keys mean a lost phone is revoked alone. |
| D3 | **Device certificate binds a device key to a person**, issued inside flows people already do (§4). | No extra steps (goal 3). |
| D4 | **Membership is checked at ingest**, by every peer, against owner-signed grants stored as Willow entries. | Communal namespaces let anyone write their own subspace; peers must refuse entries from non-members, and do it without asking the server (Phase 2 readiness). |
| D5 | **A document is the union of the Yjs updates for its path, across all subspaces.** | Yjs merges updates in any order, so no coordination is needed. Each update is one signed Willow entry. |
| D6 | **The browser and the phone app run the same JS Willow store** (`@earthstar/willow` with its IndexedDB drivers); the CLI/Mac run it on SQLite. Native Java/Swift keep only file I/O. | One implementation of a subtle protocol instead of three. The mobile shell is already a web app (Capacitor). |
| D7 | **Sync is WGPS** (`WgpsMessenger`, WebSocket transport) between every client and the server peer. | The spec protocol, already in the library; replaces `willow-sync.js`. |
| D8 | **The folder's agent materialises the merged document into the real file on disk**, and turns external disk edits into signed updates of its own. | Today only the browser writes the file, and only when online. |

## 4. Identity: device keys and certificates

**Device key.** Browser: WebCrypto Ed25519, `extractable: false`, kept in IndexedDB.
CLI/Mac: `~/.aindrive/device.key` (0600). Phone app: the WebView's key, wrapped by
Android Keystore / iOS Keychain through a small native plugin.

**Certificate** (a signed statement `{deviceKey, userId, issuer, issuedAt, label}`),
issued without a new step:

| How the person is signed in | Who signs the certificate | Strength |
|---|---|---|
| Wallet sign-in (SIWE, `web/app/api/wallet/login`) | the wallet itself: the SIWE message gains a line `aindrive device: ed25519:<key>` | self-sovereign |
| Pairing a CLI/Mac/phone (`web/app/api/auth/cli/*`) | the approving browser's device key (a chain to that browser's certificate) | same as the approver's |
| Email/password, Google | aindrive's attestation key, a server key used for nothing else | "vouched by aindrive", shown as such |

An email account that later links a wallet gets self-sovereign certificates for new
devices from then on. Certificates are Willow entries in the device's own subspace at
`["_id", "cert"]`, so they sync with the data they explain.

**Revocation.** "Remove this device" (account page, signed in) writes a revocation
signed by aindrive's attestation key; a device may also retire itself. Another device
cannot revoke a device, so a stolen device cannot lock its owner's others out. Peers
judge revocation at the later of their own clock and the entry's timestamp, so a
revoked device cannot backdate new entries; the cost is that offline edits it made
before the revocation but syncs afterwards are refused. Edits already accepted stay
attributed. A device paired by a device that is later retired stays valid.

## 5. Data layout in a drive's namespace

```
namespace  = drive (communal; id derived from the drive id)
subspace   = device key
paths:
  ["_id", "cert"]                      device certificate(s)
  ["_id", "revoke", <deviceKey>]       revocations of this person's other devices
  ["_acl", <grantee userId>]           owner-signed membership grants (role, path prefix, expiry)
  ["doc", <docPath...>, "~u", <seq>]  one Yjs update; payload = the update bytes
  ["doc", <docPath...>, "~u"]         this device's compacted snapshot (prunes its own <seq> entries)
```

The `"~u"` segment keeps a snapshot from pruning another document whose path starts
the same (a snapshot of `a` must not remove `a/b`'s updates).

`docPath` is the canonical `normalizePath` result, split into components. Timestamps
are microseconds (Willow data model), from the device clock, clamped to be
non-decreasing per subspace.

**Grants** mirror today's `drive_members` rows. The owner's device signs them. The
server keeps writing `drive_members` too and remains the authority for the web UI, so
nothing about sharing changes for users. When a grant is created on the web, the
owner's browser signs it; if the owner has no browser session open (e.g. a paid
share), the server's attestation key signs it, marked "vouched by aindrive" like
certificates.

## 6. Components

| Unit | Where | Does | Replaces |
|---|---|---|---|
| `willow/schemes` | `web/shared/willow/` (mirrored by hand into `cli/`, per repo rules) | the scheme parameters: Ed25519 subspace, SHA-256 payload, communal authorisation + ingest policy (D4) | `cli/src/willow/schemes.js` |
| `willow/policy` | same | `mayWrite(entry, grants, certs, revocations)`: a pure function | today's always-true check |
| `willow/doc` | same | Yjs ⇄ entries: append an update, read a path across subspaces, compact own subspace, author of a Yjs clientID | `cli/src/willow-store.js` read path |
| Browser store | `web/lib/willow/client.ts` | IndexedDB store, device key, WGPS to server | `aindrive-provider.ts` persistence and autosave |
| Server peer | `web/lib/willow/peer.js` + `/api/willow/sync` (WS) | SQLite store for every drive, WGPS with every client, ingest policy, live fan-out | `dochub.js` sync frames (awareness stays in dochub) |
| Agent peer | `cli/src/willow/peer.js` | store, WGPS to server, materialise to disk, disk edit to update | `willow-store.js`, `willow-sync.js`, `yjs-*` RPCs |
| Phone | `mobile/src/willow.ts` in the shell; native keystore plugin | same JS as the browser | `yjs-*` in `RpcHandler.java/.swift` |
| Authorship UI | rich-text + Monaco | "who wrote this" on hover/selection, device list in the account page | the self-claimed awareness name |

Awareness (cursors, "who is here") stays on `dochub`: it is ephemeral and needs no
signatures.

## 7. Data flow

**Edit (online or offline).** Keystroke → Yjs update → `willow/doc.append` signs it as
an entry in the local store → the UI already shows it. If WGPS to the server is up,
the entry goes out in the same tick; if not, it waits in the store.

**Reconnect.** WGPS reconciles the stores by range fingerprints; only the missing
entries move, in both directions. No queue, no retry logic of our own.

**Live collaboration.** The server peer, on ingesting an entry, pushes it to every
open WGPS session interested in that path, so people see each other's typing as today.

**Opening a document.** Local store first (instant, works offline), then sync. The
markdown on disk is no longer a seed: the first open of a file that has no entries yet
imports it once, as an update authored by the agent that holds the file.

**Disk.** The folder's agent materialises the merged document into the file, at most
every 2 s while it changes. An external edit (the file changed on disk and was not our
own write) becomes a diff-based Yjs update signed by the agent's device, labelled
"edited on <device>".

**Offline open.** A service worker caches the app shell and the drive pages already
visited; the local store has the documents. The file list shows which documents are
available offline.

## 8. Errors and edge cases

- **Entry refused by policy** (not a member, revoked, outside the grant's path): the
  peer drops it and reports it in the WGPS session; the author's client shows "this
  change was not accepted" on the document. It never silently disappears.
- **Clock skew.** Microsecond timestamps only order entries within one subspace and
  decide compaction; Yjs does the merging, so a wrong clock cannot lose text.
- **Store full / quota** (browser): compact own subspace; if still full, stop taking
  offline edits for new documents and say so.
- **Two devices of one person** are two subspaces, and Yjs merges them like two people.
- **Migration.** On first run, the agent imports each `yjs_entries` document as one
  update authored by the agent device, marked "imported, author unknown". The old
  tables stay readable for one release.

## 9. Testing

- `willow/policy` and `willow/doc`: unit tests, table-driven (member/non-member,
  revoked before/after, path outside grant, compaction pruning).
- Two in-memory stores + `WgpsMessenger` in-memory transport: offline divergent edits
  converge; a forged entry (wrong signature, non-member) is refused on both sides.
- E2E (Playwright): edit offline (`context.setOffline(true)`), reload, reconnect, a
  second browser sees the text with the right author on hover.
- CLI: disk edit → update → second peer; materialisation writes the merged text.

## 10. Roadmap

- **Phase 1 (this spec):** identity, store, WGPS through the server, offline editing,
  authorship UI; the CLI/Mac, browser and phone app all as clients.
- **Phase 2 — direct device sync.** The same WGPS between devices over a direct
  transport (LAN WebSocket, then WebRTC). The ingest policy is already server-free.
- **Phase 3 — media.** `2026-09-26-p2p-media-streaming-design.md`.

## 11. Deliberate deviations from the Willow specs

- **Read access in WGPS.** Sessions are authenticated by the existing session or agent
  token, and the server peer limits each session to the areas its user may read.
  Meadowcap read capabilities are not used in Phase 1; they come with Phase 2, when
  peers other than the server hold data.
- **Write access** is the communal-namespace rule (subspace owner signs) plus the
  ingest policy of D4. Meadowcap owned namespaces and delegation chains are not used.

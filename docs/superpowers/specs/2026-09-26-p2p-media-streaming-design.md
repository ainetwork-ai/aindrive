# P2P media streaming over Willow

Date: 2026-09-26 · Status: proposed · Phase 3 of the Willow roadmap
(`2026-09-26-willow-local-first-docs-design.md` §10), built on its identity and store.

## 1. Goal

A video or other large file on a device (Grandma's phone) plays and downloads quickly
and reliably for everyone who may see it:

1. **The device's uplink carries each byte once.** Replays, seeking back and other
   viewers are served by whichever peer already holds the bytes.
2. **Any peer may serve, none has to be trusted.** Every chunk is checked against a
   hash the owner's device signed.
3. **It survives the device going to sleep** for bytes already fetched, and resumes
   from where it stopped when it wakes.
4. **Playback starts fast** even on a slow uplink.

Non-goals: live streaming and calls (real-time media is WebRTC media, not stored
files); editing media; files nobody has opened (no prefetch of whole folders).

## 2. What is there today

Bytes flow on demand: the browser's Range request becomes `download-chunk` RPCs to
the device over the agent WebSocket, base64 in JSON, 1 MiB per RPC since
2026-09-26 (#129). Nothing is cached, so every replay goes back to the phone, and a
multi-minute 4K clip on a phone uplink cannot play smoothly at all.

## 3. Decisions

| # | Decision | Why |
|---|----------|-----|
| M1 | **A media file is a Willow entry** at `["file", <path...>]` in the owner device's subspace; its payload digest is a **chunked SHA-256 root**. | Signed "what and who" comes from Phase 1 for free. |
| M2 | **Chunked digest:** 1 MiB leaves, each SHA-256; the digest is SHA-256 of the concatenated leaf hashes. The leaf list (the "outboard", 32 B per MiB) is a second entry at `["file", <path...>, ".chunks"]`. | Lets any single chunk be checked on arrival. `@earthstar/willow` 0.6 checks a payload digest only once complete (verified in `PayloadDriver.receive`), so slice verification lives in our layer. It is simple enough to write identically in TS, Java and Swift. |
| M3 | **Bytes move as chunks on a separate blob channel**, not through WGPS payload transfer. | WGPS reconciles entries well; a player needs byte ranges now, from whoever has them. WGPS still syncs the two small entries. |
| M4 | **The server is a caching peer.** It fetches chunks from the device on first request, verifies them, stores them (LRU, per-drive quota), and serves browsers over plain HTTP Range. | Goal 1, and the browser's `<video>` element works unchanged. |
| M5 | **Direct device-to-browser over a WebRTC data channel** when both are reachable, with the server as signalling and fallback. | Goal 1 at the edge: same Wi-Fi, no server hop. Added after M4 works. |
| M6 | **A playback copy** (H.264, 720p, about 2 Mbps) made on the device, stored as a derived entry `["file", <path...>, ".play"]`, signed by the same device. Players use it; downloads use the original. | Goal 4: on a phone uplink, cutting bytes beats any protocol. |
| M7 | **Binary frames** for chunks on every channel (no base64). | About 25% fewer bytes and no encode cost on the phone. |

Rejected: iroh-blobs (verified BLAKE3/Bao streaming with NAT traversal). A good fit
for native peers, but it needs Rust in the Android, iOS and Node agents and has no
first-class browser path. Revisit if Phase 2's direct transport ends up on iroh anyway.

### Amendments (2026-09-26, while building step 1)

- **The Willow record of a media file is a manifest**, not the file as a Willow
  payload: the store's payload digest is SHA-256 over a whole payload and cannot check
  a slice. The chunk hash list comes from the device (`media-index`) and every chunk
  is checked against it; bytes move on the chunk channel (M3).
- **Phones answer `media-index` unsigned until they hold a Willow key** (the phone
  shell peer): the server still verifies every chunk against that list, so integrity
  and "carried once" hold now; signed authorship of the manifest follows.
- **Cached ranges play while the device is unreachable**: the server keeps the last
  manifest per file and serves any range whose chunks are all cached.

## 4. Components

| Unit | Where | Does |
|---|---|---|
| `media/chunks` | `web/shared/media/` + hand mirrors in `cli/`, Java, Swift | leaf hashing, root, verify(chunk, index, outboard) |
| Indexer | each agent | on first share or first open: hash the file, write the two entries; incremental on append-only growth |
| Transcoder | phone (MediaCodec / AVFoundation), Mac/CLI (ffmpeg if present) | makes `.play`, low priority, charging/Wi-Fi only on phones |
| Blob channel | agent WS (binary frames), server ↔ browser HTTP Range, WebRTC data channel | `want(digest, chunkIndexes)` → chunks |
| Cache peer | `web/lib/media/cache.ts` | verify on arrival, store on disk, LRU + quota, serve Range |
| Player | viewer | prefers `.play`, Range to the cache peer; shows "from the device" vs "cached" |

## 5. Data flow

1. **First open.** The browser asks the server for `path`. The server peer knows the
   entries (synced by WGPS) and so the digest and outboard; it asks the device for the
   chunks the Range needs, plus the next few (prefetch), verifies each against the
   outboard, stores it, and streams it to the browser.
2. **Seek or replay.** Chunks already cached come from the server; missing ones are
   fetched as in step 1.
3. **Another viewer.** Served from the cache; the device is not touched.
4. **Device asleep.** Cached ranges still play; missing ranges wait with a clear state
   ("waiting for Grandma's phone"), and resume on reconnect from the first missing chunk.
5. **Direct path (M5).** If a WebRTC channel to the device opens, the browser takes
   chunks from it first and verifies them itself (the outboard comes with the entry),
   falling back to the server.

## 6. Errors

- A chunk that fails verification is dropped and refetched from another peer; the
  sending peer is logged. Two failures from the device mean the file changed: re-index.
- The file changed on disk: the indexer writes a new entry (new digest); caches keyed by
  digest stop serving the old one.
- Cache quota reached: LRU eviction per drive; the playback copy is kept longest.
- Access: the server serves a chunk only to a session that may read the path at that
  moment (today's gate, including the paywall); caches never widen access.

## 7. Testing

- `media/chunks`: vectors shared by the TS, Java and Swift test suites (the same file,
  the same leaves and root).
- Cache peer: a corrupted chunk is refused and refetched; a second viewer causes no
  device traffic; quota eviction order.
- E2E: play a 200 MB video from a throttled agent (~2 Mbps). Time to first frame with
  `.play` under 3 s; the second play makes zero agent requests.

## 8. Order

1. Chunked digest + indexer + server cache peer (M1–M4). **Shipped**
   (`web/lib/media/cache.ts`, `media-index` on the CLI, Android and iOS). M7 (binary
   frames) is still open: chunks still travel as base64 inside `download-chunk`.
2. Playback copy (M6).
3. Direct WebRTC path (M5), together with Phase 2's direct transport.

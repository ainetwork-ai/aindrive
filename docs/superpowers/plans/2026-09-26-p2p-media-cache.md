# P2P media: chunk index + verifying cache peer (Plan 6 of 6, media spec order step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A large file on a device (a video on Grandma's phone) is carried up the
device's uplink once. The server keeps verified 1 MiB chunks, so replays, seeking back
and other viewers are served from the cache, and every chunk is checked against the
device's chunk hash list.

**Architecture:** A new agent RPC `media-index` returns a file's chunk hash list
(CLI, Android, iOS). The server's cache peer (`web/lib/media/cache.ts`):
- gets that list and keeps it per file (size and modification time);
- serves Range requests chunk by chunk from a disk cache;
- fetches missing chunks with the existing `download-chunk` RPC, verifies each against the list (`web/shared/media/chunks.ts`, Plan 1), and prefetches ahead;
- evicts least recently used chunks per drive.

`fs/stream` and `fs/download` use it whenever the agent answers `media-index`, and otherwise fall back to today's path.

**Tech Stack:** Node streams, `@noble/hashes` (web, CLI), `java.security.MessageDigest` (Android), CryptoKit (iOS).

**Spec:** `docs/superpowers/specs/2026-09-26-p2p-media-streaming-design.md` (M2, M3, M4; M7 binary frames and M5/M6 are later steps).

## Spec amendments (Task 5 writes them into the spec)

- A media file's Willow record is a small manifest (`size`, `mtimeMs`, chunk size, `root`) plus the chunk hash list, not the file bytes as a Willow payload. The store's payload digest is SHA-256 over a whole payload and cannot check a slice. Bytes move on the chunk channel.
- Until an agent has a Willow key (the phone app, Plan 5), `media-index` answers with an unsigned chunk hash list. The server still verifies every chunk against it, and authorship arrives with the signed manifest.

## Global Constraints

- The chunk is exactly 1,048,576 bytes; the root is SHA-256 over the concatenated leaves (`web/shared/media/chunk-vectors.json`); every implementation must reproduce those vectors.
- The cache never widens access: every route keeps its existing gate (role, paywall, download token).
- A chunk that fails verification is never cached or served.
- Cache budget per drive: `AINDRIVE_MEDIA_CACHE_MB` (default 2048); LRU eviction.

## Review Focus

1. **The file changes on disk while cached**: the next request sees a different size or mtime, re-indexes, and never serves old bytes.
2. **An agent that returns a corrupt chunk**: nothing is cached, and the response errors instead of streaming garbage.
3. **Two viewers request the same uncached chunk at the same time**: one agent fetch, not two.
4. **An old agent without `media-index`**: streaming works exactly as before.
5. **A Range that ends mid-chunk, and a file whose size is an exact multiple of 1 MiB**: correct bytes and Content-Length.

---

### Task 1: `media-index` in the CLI agent

**Files:** Modify `cli/src/rpc.js` (method + `RPC_METHODS`), create `cli/src/media-index.js`; mirror `web/shared/protocol.ts` / `web/lib/protocol.ts` (method + result type); test `cli/src/__tests__/media-index.test.mjs`.

**Interfaces:** `mediaIndex(abs): Promise<{ size: number; mtimeMs: number; chunk: 1048576; leaves: string[] }>`, streaming (never loads the whole file), memoised by `(abs, size, mtimeMs)`.

- [ ] Test: the six vector sizes from `web/shared/media/chunk-vectors.json` give roots equal to the vectors (root = sha256(concat(leaves))); a changed file gives a new result.
- [ ] Implement with `createReadStream(abs, { highWaterMark: 1 << 20 })` and a 1 MiB accumulator (same algorithm as `leafHashes` in `chunks.ts`).
- [ ] RPC: `case "media-index": { const abs = safeResolve(root, params.path); return { method: "media-index", ...(await mediaIndex(abs)) }; }`
- [ ] Commit.

### Task 2: `media-index` on the phones

**Files:** `mobile/android/app/src/main/java/ai/ainetwork/aindrive/RpcHandler.java`, `mobile/ios/App/App/RpcHandler.swift`.

- [ ] Android: `case "media-index"`: resolve like `download-chunk`, stream 1 MiB buffers through `MessageDigest.getInstance("SHA-256")`, return `{ method, size, mtimeMs, chunk, leaves }` (hex).
- [ ] iOS: the same with `CryptoKit.SHA256` over `FileHandle.readData(ofLength: 1 << 20)`.
- [ ] Verify: Android `./gradlew :app:compileDebugJavaWithJavac` (or the project's existing build task); a small JVM check of the vectors if a JDK is present. iOS compiles only on macOS: ledger it as unverified if no Xcode here.
- [ ] Commit.

### Task 3: The cache peer

**Files:** Create `web/lib/media/cache.ts`; test `web/lib/__tests__/media-cache.test.ts`.

**Interfaces:**
- `mediaManifest(driveId, secret, path, stat: { size, mtimeMs }): Promise<Manifest | null>` (null when the agent has no `media-index`; checks that `leaves.length === ceil(size / 1 MiB)`; memoised per `(driveId, path, size, mtimeMs)`)
- `cachedByteStream(driveId, secret, path, m: Manifest, start, endExclusive): ReadableStream<Uint8Array>` — chunk `i` comes from `<dataDir>/media-cache/<driveId>/<root>/<i>` when present; otherwise `download-chunk` (offset `i·1 MiB`, length ≤ 1 MiB), verified with `verifyChunk`, written, and served. It prefetches the next 2 chunks in the background. Concurrent requests for one chunk share a single fetch.
- `evict(driveId)` — LRU by file access time until the drive is under budget; runs after each write.

- [ ] Tests, with `callAgent` mocked and a counter on `download-chunk`:
  - the bytes of a Range that crosses chunk boundaries equal the source;
  - a second full read makes 0 agent calls;
  - a corrupt chunk errors the stream and is not written;
  - two concurrent reads of one chunk make 1 agent call;
  - a changed `mtimeMs` re-indexes (new manifest) and does not reuse the old chunks;
  - eviction keeps the drive under a tiny budget.
- [ ] Implement; tests pass; commit.

### Task 4: Routes use the cache peer

**Files:** `web/app/api/drives/[driveId]/fs/stream/route.ts`, `web/app/api/drives/[driveId]/fs/download/route.ts`.

- [ ] After the existing `stat`: `const m = size >= 1 << 20 ? await mediaManifest(...) : null;` then `m ? cachedByteStream(...) : agentByteStream(...)` (same headers). An error from `media-index` (unknown method) means null.
- [ ] Test in `media-cache.test.ts`: a manifest-less agent falls back (the route helper `bytesFor(...)` is exported for the test).
- [ ] Commit.

### Task 5: Spec amendments + docs

- [ ] Amend the media spec (the two amendments above, and the order: step 1 shipped here).
- [ ] Add `web/lib/README.md` lines for `media/cache.ts`, and `cli/README.md` for `media-index`.
- [ ] Commit.

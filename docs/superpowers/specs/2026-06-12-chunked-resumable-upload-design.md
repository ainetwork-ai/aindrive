# Chunked + resumable upload (2026-06-12)

## Problem

Large uploads went through one giant streaming POST. Every layer between the
browser and the agent limits a single long request, and each produced a
distinct field failure:

- prod nginx `client_max_body_size 200m` → instant 413, masked by nginx
  lingering close (~30 s of discarded body made the progress bar climb to
  70–75 % on a request that was already rejected)
- Node `server.requestTimeout` 300 s default → kills any body slower than
  5 min (fixed separately, PR #25)
- a single slow agent disk append → chunk RPC timeout mid-stream (PR #23)
- and inherently: no resume — any failure restarts a GB upload from zero.

## Decision

tus-style session protocol; single-POST `fs/upload` kept for files ≤ one part.

- `POST fs/upload-sessions {path, size}` → `{uploadId, partSize: 8 MiB}`.
  Same gates as fs/upload (2 GiB cap, editor role, tier file-count).
- `PATCH fs/upload-sessions/:uploadId` raw part body, header `X-Upload-Offset`
  must equal server `receivedBytes` → appends to a hidden agent temp
  (`.aindrive/uploads/<id>.part`), 4 MiB agent RPCs. Mismatch → 409 + the
  authoritative offset (client re-slices). Final part → atomic rename.
  Zero-byte PATCH at offset == size retries just the rename.
- `GET` → reconciled resume point; `DELETE` → abort + temp cleanup.
- Sessions persist in sqlite (`upload_sessions`); stale ones swept on create
  (48 h TTL). One PATCH in flight per session (in-memory lock).

## Key invariant — recovery truth is the agent temp's stat size

The DB's `received_bytes` is a cache. A part can die after some of its 4 MiB
RPCs landed (agent ahead of DB); GET/PATCH stat the temp first and adopt its
size, so retries never double-append. chunkId 0 (agent-side truncate) is sent
only at absolute offset 0, making a retry of the very first part safe.

A MISSING temp is ambiguous and is disambiguated, never guessed (adversarial
review findings):
- all bytes had landed AND the target exists at the declared size →
  **published**: the final rename succeeded but its response was lost;
  complete the session (bookkeeping runs here, exactly once) instead of
  re-uploading onto the published file.
- otherwise → **lost** (agent wipe — or a transient stat error, which is
  indistinguishable): purge the session, 410. The client opens a fresh
  session/temp. Resuming "from 0" would chunkId-0-truncate blind.

DELETE takes the same per-session lock as PATCH — an abort racing the final
part could otherwise delete the fully-assembled temp between its last append
and its rename.

Client: per-(drive, path, size, mtime) `localStorage` key remembers the
session id — re-dropping the same file resumes. 5 transient failures with
backoff, offset re-synced via GET, then give up (key kept for a later resume).

## Rejected

- Presigned-URL offload to object storage: aindrive's storage *is* the user's
  agent machine; there is no third party to offload to.
- Parallel parts: appends must be sequential (agent has append-only chunk
  RPCs), and the agent WS is the bottleneck anyway — parallelism would buy
  nothing and cost the offset invariant.
- New agent RPCs (e.g. write-at-offset): deployed agents must keep working;
  the protocol uses only RPCs every agent already has.

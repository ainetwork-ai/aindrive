# P2P media: direct device → browser over WebRTC (Plan 7, media spec order step 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the browser can reach the device directly (same Wi-Fi, or a NAT a STUN
server can open), video chunks flow device → browser over a WebRTC data channel with
no server hop. Every chunk is verified against the device's chunk hash list. When no
direct path opens, the server cache (Plan 6) serves as today.

**Architecture:**
- **Signalling:** the server relays signalling only.
  - The browser opens `WS /api/media/rtc?drive=&path=`, and the server gates it exactly like `fs/stream`.
  - The server mints a token scoped to (drive, path, content root, expiry), signed with the drive secret.
  - It relays the offer, answer and ICE candidates over the agent's existing socket.
- **Agent side:** the agent (CLI, Node, `werift`) checks the token and serves only that file's chunks on the data channel.
- **Browser side:** a service worker catches `fs/stream` requests for media and asks the page. The page's P2P manager takes chunks from the data channel and verifies each one, or falls back to the server URL.

**Tech Stack:** `werift` (pure-TS WebRTC for Node) in the CLI, the browser's `RTCPeerConnection`, the service worker from Plan 2, `@noble/hashes` HMAC.

**Spec:** `docs/superpowers/specs/2026-09-26-p2p-media-streaming-design.md` (M5); Plan 6 for the manifest and the cache.

## Global Constraints

- The data channel carries only chunks of the one file the token names, for its current content (the root); the agent re-checks size and mtime before serving.
- Pieces are ≤ 64 KiB (SCTP message limits in browsers); a chunk is verified whole before use.
- No TURN: when direct ICE fails within 4 s, the server path is used; nothing about correctness depends on P2P.
- STUN servers are configurable (`NEXT_PUBLIC_AINDRIVE_STUN`, default `stun:stun.l.google.com:19302`); LAN host candidates work without it.

## Review Focus

1. **A token for one file used to ask for another path, or after the file changed**: refused by the agent.
2. **A peer sends a piece for a chunk index it was not asked for, or a corrupt chunk**: dropped, the chunk comes from the server instead.
3. **The data channel closes mid-video**: playback continues from the server without an error.
4. **Two tabs play the same video**: each has its own session; nothing crosses.
5. **The user may not read the file (paywall, no role)**: no signalling, no token.

---

### Task 1: The chunk wire and the token (shared, mirrored to the CLI)

**Files:** create `web/shared/media/p2p.ts` (added to the mirror generator's sources), test `web/lib/__tests__/media-p2p.test.ts`.

**Interfaces:**
- `PIECE = 65536`; `encodeWant(index): string` (JSON text frame `{want: i}`), `encodePieces(index, chunk): Uint8Array[]` (binary: `u32 index | u32 offset | u32 total | bytes`), `class Reassembler { push(frame: Uint8Array): { index, chunk } | null }` (rejects out-of-range offsets, mismatched totals, > 1 MiB).
- `mintToken(secret: string, claim: { drive, path, root, exp }): string`, `verifyToken(secret, token, now): claim | null` (HMAC-SHA256 over the canonical claim; base64url).

- [ ] Tests: round trip of a 1 MiB chunk and a short last chunk through pieces in shuffled order; a piece with a bad offset or a different total is rejected; a token with a changed path, root or an expired `exp` fails; a token signed with another secret fails.
- [ ] Implement; add `web/shared/media/p2p.ts` to `mirror-willow-to-cli.mjs`; regenerate; commit.

### Task 2: Signalling through the server

**Files:** create `web/lib/media/rtc-signal.ts`, route in `web/server.js` (`/api/media/rtc`, the Willow socket server), `web/lib/agents.js` (forward `{type:"rtc", sid, data}` frames from the agent to the session), test `web/lib/__tests__/media-rtc-signal.test.ts`.

**Interfaces:** `onRtcSignal(ws, req, query, userId)` — gate (member, role ≥ viewer on the path, not paywalled — the same helpers as the Willow peer), manifest via `mediaManifest` (Plan 6), token via `mintToken(drive_secret, …, exp = now + 10 min)`, then relay: browser `{t:"offer", sdp}` → agent `{type:"rtc", sid, token, path, data}`; agent `{type:"rtc", sid, data}` → browser. `sendToAgent(driveId, frame)` in `agents.js`.

- [ ] Tests with a fake agent socket: a member gets their offer relayed with a token for exactly (drive, path, root); a paywalled user is closed with 4402 and nothing reaches the agent; answers route back by `sid` only to their own browser.
- [ ] Implement; commit.

### Task 3: The agent answers and serves chunks

**Files:** create `cli/src/media-rtc.js`, modify `cli/src/agent.js` (dispatch `type:"rtc"` frames), add `werift` to CLI devDependencies (bundled), test `cli/src/__tests__/media-rtc.test.mjs`.

**Interfaces:** `handleRtc(frame, { root, driveSecret, send })` — first frame of a `sid` must carry a valid token; creates a `werift` `RTCPeerConnection`, answers, trickles ICE through `send({type:"rtc", sid, data})`; on the data channel `chunks`: `{want: i}` → re-check the file's size/mtime/root against the token (via `mediaIndex`), read chunk `i`, send its pieces. Sessions close after 10 minutes idle.

- [ ] Test: two `werift` peers in one process (the "browser" side a werift peer too) exchange signalling through `handleRtc`; the browser side requests chunks 0 and 3 of a 3.5 MiB file and verifies them with `verifyChunk`; a token for another path gets no answer; a file changed after minting is refused.
- [ ] Implement; commit.

### Task 4: The browser plays over P2P, with the server as fallback

**Files:** create `web/lib/media/p2p-client.ts` (page side), modify `web/public/sw.js` (media `fs/stream` requests go to the page when it announced P2P), `web/lib/willow/offline.ts` (register the page as the SW's P2P helper), test `web/e2e/media-p2p.spec.ts`.

**Interfaces:** `p2pClient(driveId, path)`: opens the signalling socket, `RTCPeerConnection` with the configured STUN, the data channel; `range(start, end): ReadableStream` that asks for the needed chunks, verifies each with the manifest the server sent at signalling, and for any chunk not received within 4 s (or failing verification) fetches that byte range from `fs/stream?…&via=server`. Stats on `window.__aindriveP2P` (`p2pBytes`, `serverBytes`).

- [ ] E2E (Chromium + a real CLI agent, same host): play `v.mp4` in a `<video>` on the drive page; `__aindriveP2P.p2pBytes` > 0 and equals what played; then kill the agent's data channel side: playback of the rest still completes (`serverBytes` > 0).
- [ ] Implement; commit.

### Task 5: Spec + docs

- [ ] Media spec: M5 shipped for CLI/Mac agents (phones need the WebView peer: Plan 5); document the token and fallback.
- [ ] READMEs; commit.

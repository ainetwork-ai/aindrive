# Demo Drive — "Acme Inc."

This folder is the demo drive for the agent feature. Contains a small set of
fake company documents an agent can answer questions about. Used as the
seed for hackathon-style demos: spin up `aindrive` against this folder and
ask the agent things like "what was Q1 marketing spend?".

## Run

```bash
# 1. Web server (port 3738 to avoid conflicts with main worktree)
cd web && PORT=3738 npm run dev

# 2. Connect this folder as a drive
cd cli && AINDRIVE_SERVER=http://localhost:3738 \
         FLOCK_API_KEY=sk-...                    \
         node bin/aindrive.mjs ../demo
```

The folder structure is intentionally small so the v1 KnowledgeBase
(`dump-all-text` — sends every text file to the LLM) fits in any model's
context. Adding more docs is fine; budget caps at 256KB total.

## Files

| Path | What it has | Sample question |
|---|---|---|
| `okr/q1-2026.md` | Q1 OKRs (numbers) | "What was Q1 marketing spend?" |
| `okr/q2-2026.md` | Q2 OKRs in progress | "How many leads did we target for Q2?" |
| `meetings/2026-04-15-leadership.md` | Leadership sync notes | "What did we decide about hiring?" |
| `products/aindrive-spec.md` | Aindrive product spec | "What's the protocol stack of aindrive?" |
| `legal/tos-draft.md` | ToS draft | "What's our refund policy?" |

## Why this layout

Each file lives under a sub-folder so we can also demo *folder-scoped*
agents (e.g. one agent over `okr/`, a separate one over `legal/` —
different policies, different audiences).

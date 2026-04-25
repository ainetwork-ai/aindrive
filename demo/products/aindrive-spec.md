# aindrive — Product spec (v1, 2026-04)

## What it is

aindrive is a self-hosted-with-zero-network-exposure Drive replacement.
Owner runs the `aindrive` CLI in any folder; that folder becomes
browseable via a Vercel-hosted web UI. Files never leave owner's
machine — the CLI dials out over WSS, no inbound port opens.

## Protocol stack

| Layer | What we use | Why |
|---|---|---|
| Web ↔ owner CLI | aindrive WSS RPC, HMAC-SHA256 signed envelopes | No inbound port, replay-safe |
| Web ↔ browser | Next.js HTTP + cookies (session, cap) | Standard |
| Capability | Meadowcap (`@earthstar/meadowcap`) | Capability-based access; share links are caps |
| Multi-device sync (Q3) | Willow WGPS | Earthstar/Willow ecosystem |
| Payments | x402 (paywall) + a2a-x402 extension (agent calls) | Standards-compliant agent commerce |
| LLM | OpenAI-compatible HTTP (Flock by default) | Provider-pluggable |

## Components

- **`web/`** Next.js app — UI, identity, share dialog, paywall, agent CRUD
- **`cli/`** local agent — file RPC, agent execution, Willow store
- **`shared/`** types frozen across both — RPC protocol, contracts

## Pricing

| Tier | Price | Includes |
|---|---|---|
| Hobby | free | 1 drive, no agents |
| Pro | $9/mo per owner | unlimited drives, up to 10 agents per drive |
| Team | $29/seat/mo | + delegated cap issuance, audit log |

Add-on: **per-call x402 agent revenue** (owner sets price, platform takes 5%).

## Security highlights

- Local agent never opens an inbound port.
- All RPCs HMAC-signed with per-drive secret.
- `.aindrive/` subtree is owner-only — agent JSON, llm.apiKey, drive secret all live there. Cap-bearers blocked at the fs/* layer.
- Share links are signed Meadowcap capabilities (path prefix + time range + recipient pubkey).
- TLS-only Redis if used; cookies are HttpOnly + SameSite=Lax + Secure.

## What's NOT in v1

- Multi-device drive sync (Q2 KR1.3 / Q3)
- E2E encryption of file content (server can read all)
- Mobile native client
- Realtime presence beyond Y.js doc collaboration

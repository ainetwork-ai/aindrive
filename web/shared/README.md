# web/shared — code reused INSIDE the web package

## Responsibility

Wire protocol, HTTP contracts, signing, and the Agent domain layer (pure types,
ports, policies) consumed across `web/`. This is web-internal shared code — it is
NOT a cross-package shared module. The CLI hand-mirrors anything it needs from
here (see Cross-package rule below).

## Files

Crypto / signing:
- `crypto/sig.ts` — canonical HMAC-SHA256 sign/verify/strip. Single source of
  truth; `sig.ts` and other `sig.{ts,js}` copies are legacy duplicates to migrate off.
- `sig.ts` — older duplicate of the above, kept until callers move to `crypto/sig.ts`.

Wire protocol (web ↔ CLI agent over the WebSocket RPC bridge — see
`web/lib/agents.js`):
- `protocol.ts` — RPC methods, request/response shapes, `DriveEntry`, and
  `LIMITS`. `PROTOCOL_VERSION` is the compatibility gate. (The `REQ_QUEUE`/
  `RES_QUEUE`/`HEARTBEAT_KEY` queue-key builders here are vestigial Redis-era
  helpers — unused; the live transport is WebSocket.)

Agent skills (backing both MCP tools and A2A executor):
- `agent-skills.ts` — `runSkill` + `SKILL_DESCRIPTORS` (JSON Schema). One backing
  fn for `app/mcp/route.ts` and `lib/aindrive-agent.ts`. Pulls in `@/lib/*` (drives,
  access, db, rpc), so it is web-bound, not pure domain.

HTTP contracts (cross-track frozen agreement):
- `contracts/http.ts` — Pay→Cap, cap-verify, RAG ask, x402 402-body, and the A2A
  `AindriveAgentCard` types.

Agent domain (pure, no I/O):
- `domain/agent/types.ts` — `Agent`, `LlmConfig`, `KnowledgeConfig`, `AccessConfig`,
  ids, persona defaults.
- `domain/agent/access.ts` — `CallerIdentity`, `AccessDecision`, `AccessPolicy` /
  `IdentityResolver` interfaces (the plug-in point for "who may ask this agent").
- `domain/agent/ports.ts` — web-side ports: `AgentRepo`, `FsBrowser`,
  `AgentExecutor`, `AccessPolicyFactory`. KnowledgeBase/LlmClient live in `cli/`.
- `domain/agent/registry.ts` — allowed names for `knowledge.strategy` /
  `llm.provider` / `access.policies[]` + guards.
- `domain/agent/A2A_IMPORT_DESIGN.md` — design doc for browser-only A2A card import.

Policy:
- `domain/policy/path.ts` — `pathCovers(prefix, target)`, Willow path-prefix semantics.
- `domain/policy/system-paths.ts` — `isSystemPath`; flags the reserved `.aindrive/` subtree.

Display (pure, no I/O):
- `wallet-display.ts` — `isWalletOnlyEmail` / `walletDisplayLabel`; de-leaks the
  synthetic `<addr>@wallet.aindrive.local` email at any render site into a
  truncated wallet address.

## Contracts & invariants

- **Signing canonicalization**: payloads are signed as JSON with sorted keys, so
  two key-orderings of the same object verify identically. Don't add new sig files.
- **`contracts/http.ts` is frozen**: shapes are a cross-track agreement; changing
  one requires a multi-track sync, not a solo edit.
- **`.aindrive/` is a single failure point**: cap-bearer fs reads MUST go through a
  check that rejects `isSystemPath` paths, or `llm.apiKey` leaks. Enforcement lives
  in HTTP middleware / fs routes, not here. Server-internal callers intentionally bypass it.
- **`registry.ts` must stay in sync with CLI factories**: a name listed here but
  missing from CLI's resolvers surfaces as `agent_misconfigured` at ask time.
- **Secrets boundary**: web holds no LLM secrets; agent execution (and `llm.apiKey`
  use) happens CLI-side. Public agent-card projections MUST omit `apiKey`.

## Gotchas

- Two `sig` implementations coexist; `crypto/sig.ts` is canonical — import that.
- `agent-skills.ts` sits in `shared/` but is not pure: it imports web `@/lib/*`. It
  is shared between MCP and A2A entrypoints, not between packages.
- `A2A_IMPORT_DESIGN.md` is a draft proposing files that mostly do not exist yet
  (e.g. `contracts/a2a.ts`); read it as intent, not current state.

## Related

- Cross-package rule (no top-level `shared/`; CLI hand-mirrors with a comment) and
  its rationale: root `CLAUDE.md` → "Package layout: independent packages".
- Permission / identity model: `docs/PERMISSIONS.md`.
- Agent feature design: `docs/personal/haechan/AGENT_FEATURE_DESIGN.md`.
- x402 wire format: https://github.com/google-agentic-commerce/a2a-x402.

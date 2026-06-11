# aindrive — repo conventions

## What aindrive is

A **shared drive (Google-Drive-like) with paid content and AI agents inside it**:
browse/upload/preview/collaborate on files, sell access to files or folders,
and let agents read/act over a drive. A local CLI **agent** owns the real
filesystem; the **web** app brokers between browsers and agents over WebSocket.

## Product / UX principles

- **Context-first IA.** Files are the main surface. Sharing & selling are
  created **in the item's context** (the right-side Share drawer on a
  file/folder); the **drive-wide ledger** — full member roster, all links,
  sales/earnings, payment settings — lives on the Manage page (`/d/[id]/manage`).
  Rule: *create in context, audit in settings* — never split one concept
  (e.g. "links") across both a create surface and a separate list surface.
- **Identity = email-login account.** Wallets are a payment instrument only,
  never a login. A paid grant binds to the logged-in account. Details +
  rationale: `docs/PERMISSIONS.md`.
- **Payment tokens are a pricing menu.** A drive's allowed-tokens policy is the
  set of currencies an owner may price a sale in; each sale is priced in ONE
  token and the buyer pays only that one. It is not simultaneous/multi-charge.
- **Permissions**: role ladder + path-scoped grants + upgrade-only merge —
  canonical reference `docs/PERMISSIONS.md`.
- Design decisions for in-flight UX work live in
  `docs/superpowers/specs/*-design.md` (e.g. the 2026-06 UX overhaul).

## Package layout: independent packages, no root shared code

Packages live exclusively under their own directory. Each is independent:

- `web/` — Next.js + WebSocket server. Owns `web/shared/` for code reused inside web (contracts, domain types, crypto helpers).
- `cli/` — local agent. Plain ESM JS, no TS build pipeline. Mirrors any web/shared types it needs by hand.

**Do not create directories at the repo root that hold code shared between packages** (e.g. no top-level `shared/`, `common/`, `lib/`, etc.). Each package must be self-contained so it can be packaged, dockerized, and deployed without pulling in siblings.

The repo root is also not a package — there is no root `package.json`, no root `node_modules` for source code, and no root build step.

### Why
- `web/` is built and deployed in isolation (Docker context = `web/`). Imports outside `web/` break the build.
- `cli/` is published to npm under the name `aindrive`. A root `package.json` would collide with that name.
- Cross-package code sharing has historically been one-way (web → shared) and small. Manual mirroring + a comment pointing at the canonical copy has been less friction than maintaining a shared package.

### If you really need to share code between web and cli
Don't reach for a top-level `shared/`. Options, in order of preference:
1. Duplicate and mark with a comment (`// Mirrors web/shared/x.ts`) — fine for small types/constants.
2. Publish a small package (`@aindrive/protocol` or similar) and add it as a dep to both.
3. Set up a workspaces structure — only if 1 and 2 stop working.

## Documentation system

Docs live at the layer that matches how often they change (the *why* is the
global doc meta-principles in the user's `~/.claude/CLAUDE.md` — §1 natural
habitat, §2 positive cross-ref, §3 deletion test). Where things go in **this**
repo:

| Layer | Holds | Examples |
|-------|-------|----------|
| `CLAUDE.md` (this file) | repo-wide conventions + architecture overview | product/UX principles, package layout, this table |
| root `README.md` | what aindrive is, architecture, **pointers** to domain READMEs | — |
| `<dir>/README.md` | that subsystem's responsibility, file map, contracts, gotchas | `web/app/api/`, `web/lib/`, `web/components/`, `web/shared/`, `cli/` |
| `docs/*.md` | cross-cutting design not tied to one dir | `PERMISSIONS.md`, `DEPLOY.md`, `ARCHITECTURE.md`, `WILLOW_DESIGN.md`, `TRACE_CONTRACT.md`, `PRODUCTION_TODO.md` |
| `docs/superpowers/{specs,plans}/` | dated design history (brainstorm → plan), immutable record | per-feature `YYYY-MM-DD-*.md` |
| code comments | invariants / intent / WHY (machine-checked where possible) | — |

Rules (enforced by review):
- **Locality** — document a subsystem in its own `<dir>/README.md`, next to the
  code, so it changes with the code and never goes stale at a distance.
- **Reference, don't duplicate** — one source of truth. The root README and
  domain READMEs *point at* `docs/PERMISSIONS.md`, `docs/DEPLOY.md`, the specs,
  etc.; they never restate them.
- **New meaningful subsystem → add its README**; touching one → keep its README
  ↔ code consistent. A domain README is a tight map (≈25–60 lines: purpose,
  files, contracts, gotchas, related) — not prose, not code dumps, not history.
- **Test:** a fresh agent reading the relevant README + filenames can locate the
  file to change without reading every file. If not, the doc/structure is wrong.

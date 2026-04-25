# aindrive — repo conventions

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

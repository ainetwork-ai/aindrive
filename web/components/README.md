# web/components — React surfaces for the drive web app

## Responsibility

The browser-side UI: the file-browser shell, file viewer/editors, the per-item
Share drawer, the owner Settings page, the paywall, folder chat, and the
design-system primitives in `ui/`. Server brokering, protocol types, and access
logic live elsewhere (`web/lib`, `web/shared`); components only render + call
`apiFetch`.

## IA rule (drives the file split)

**Create in context, audit in Settings.** Selling/inviting/linking is created on
an item via `share-dialog` (the right-docked Share *drawer*); the whole-drive
ledger — member roster, all links, sales, payment settings — is read/managed on
`drive-manage` (`/d/[id]/manage`). One concept is never split across a create
surface and a separate list surface. Rationale: `../../CLAUDE.md` (product
principles) + `../../docs/superpowers/specs/2026-06-11-ux-overhaul-design.md`.

## Files

Convention: `X.tsx` = stateful shell (owns state/effects/actions); `X-parts.tsx`
= pure presentational render fns receiving data+handlers; `X-utils.ts` = pure
helpers. Shells lazy-load heavy children via `next/dynamic`.

Browser shell:
- `drive-shell(.tsx/-parts)` — file browser: sidebar, header/breadcrumbs,
  grid+list, selection, sort/search, showcase section.
- `file-icons` — file-type → icon+color map (list rows + grid cards share it).
- `row-menu` — single source for the `⋮` dropdown + right-click context-menu
  items, with permission gates (sell/share owner-only; rename/delete = canManage).

Viewer / editors:
- `viewer(.tsx/-parts/-utils)` — media preview (Range-streamed) + text editing.
  Picks Monaco (code) or the rich-text editor (.md), owns the Yjs collab lifecycle.
- `editors/rich-text-editor` — collaborative WYSIWYG Markdown (TipTap + Yjs).

Sharing / payments:
- `share-dialog(.tsx/-sections)` — the Share **drawer**: per-path invite, sell,
  free link, members. Owns drive token-policy editor (`PaymentTokensEditor`,
  reused by manage).
- `drive-manage` — owner Settings page, Members/Links/Sales/Payments left-rail.
- `share-gate(.tsx/-client)` — the `/s/[token]` paywall: x402 pay + Permit2
  approve. `-client` is the SSR-skipping wrapper.
- `x402-badges` / `x402-logo` — price badge + brand mark.
- `wallet-provider` — wagmi + RainbowKit + react-query provider tree.
- `use-wallet-login` — SIWE re-login for a wallet that already has access
  (re-issues `aindrive_wallet` cookie; not a payment).

Agents:
- `folder-chat(.tsx/-parts)` — picks a drive agent and asks it over the folder.
- `create-agent-modal(.tsx/-parts)` — owner-only RAG-agent registration.

Design system:
- `ui/` — primitives, barrel-exported from `ui/index.ts`: Button, IconButton,
  Modal (`center` | `drawer` variant), Input, Select, Toggle, Menu, Tooltip,
  Avatar, Badge, Card, SectionCard, EmptyState, Skeleton, Field. Live gallery:
  `app/_dev/ui`.

## Contracts & invariants

- Heavy/interactive children (`Viewer`, `ShareDialog`, `CreateAgentModal`,
  `FolderChat`, `ShareGate`) are `dynamic({ ssr: false })` — they pull Monaco /
  wagmi and have no SSR value; importing eagerly breaks the route or bloats JS.
- Permission gating in the UI is convenience only; the server re-validates. Some
  GETs 403 for non-owners/co-owners — components fall back to defaults rather
  than failing (e.g. share-dialog drive-token read, manage payment settings).
- A `.md` file opens Monaco **or** the rich-text editor, never both — the two
  bind to different Y.Doc roots. Crossing them risks disk data loss (see the
  editor file header + `specs/2026-06-10-editor-framework-design.md`).
- `share-gate`: the Permit2 approve + allowance probe must run on the **token's**
  chain, not wherever the wallet is connected, or settlement silently fails.
- `row-menu` items are defined once (`rowMenuItems`) so dropdown and context menu
  stay identical.

## Gotchas

- Monaco is self-hosted from `/monaco/vs` (CSP blocks the jsdelivr CDN); assets
  are copied by `scripts/copy-monaco.mjs` on pre(dev|build).
- `file-icons` colors are intentionally NOT design tokens — they're a type
  taxonomy (like Badge's warning amber).
- No Textarea primitive yet; multiline controls hand-roll Input's chrome.

## Related

- Product / UX principles, IA rule, package layout: `../../CLAUDE.md`
- Permission & identity model: `../../docs/PERMISSIONS.md`
- In-flight UX/editor design specs: `../../docs/superpowers/specs/`
- Protocol/access/payment-token logic the shells call: `../lib`, `../shared`

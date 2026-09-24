# web/shared/a2ui — one UI definition for every agent transport

A2UI v0.9 surfaces (basic catalog only) describing each skill result, plus the
mapping from the user's clicks back to skills. MCP, A2A and AG-UI all send the
**same** surface, so there is one place to change the UI.

| File | Role |
|------|------|
| `index.ts` | `a2uiForSkill(skill, args, result, driveId)` → A2UI messages; `parseA2uiAction` / `actionToSkill` (clicks → skill); `commandToSkill` (text grammar shared by A2A + AG-UI); protocol constants (MIME, catalog, A2A extension URI, AG-UI activity type, MCP `_meta` key). Pure; importable from client code. |
| `renderer.js` | Dependency-free renderer for the emitted subset (plain ESM, browser). Inlined into the MCP Apps view (`lib/mcp-ui.ts`) and used by the `/docs/a2ui` playground. |

Where it's used:
- MCP: `lib/mcp-http.ts`, which adds a result `_meta` field, the embedded resource, and the `a2ui_action` tool
- A2A: `lib/aindrive-agent.ts`, which sends a DataPart of mimeType `application/a2ui+json` when the extension is on
- AG-UI: `lib/agui.ts`, which sends `ACTIVITY_SNAPSHOT a2ui-surface` with the messages under `a2ui_operations`

Contracts and gotchas:
- Components must validate against the official schemas. `lib/__tests__/a2ui.test.ts` checks every surface against `@a2ui/web_core` (a dev dependency). Only the basic catalog is used, so any conforming renderer works.
- Action names (`aindrive.open`, `aindrive.search`, `aindrive.open_drive`) and their `context` keys are public API, documented in `app/docs/content/a2ui.md`. Change them only together with the docs.
- `Icon.name` can't be data-bound in v0.9, so list rows use emoji labels instead of icons.
- Images preview inline as data URLs up to about 1.5 MB. Larger ones show a note instead.

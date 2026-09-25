# web/app/docs — public integration guide (`/docs`)

Static pages for third-party developers covering MCP, A2A, AG-UI, A2UI and auth.

| File | Role |
|------|------|
| `content/*.md` | the page text. `{{BASE}}` becomes `AINDRIVE_PUBLIC_URL` at build time (falls back to `https://aindrive.ainetwork.ai`) |
| `_lib.ts` | page list (`DOCS_PAGES`, which is also the nav) and `readDoc` |
| `page.tsx`, `[slug]/page.tsx` | `force-static`: markdown is read at build, so the runtime image needs no `app/` files |
| `_components/SkillsReference.tsx` | `/docs/skills`, generated from `shared/skill-descriptors.ts`, so it never drifts from the code |
| `_components/Playground.tsx` | `/docs/a2ui` live demo: real `a2uiForSkill` surfaces and `renderer.js` over a fake drive |

To add a page, add `content/<slug>.md` and an entry in `DOCS_PAGES`. When endpoint behavior changes, update the matching page in the same PR.

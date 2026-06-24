# Releasing aindrive

Two **independent** release tracks — they ship differently, so they version and
tag differently. The Releases page (`gh release list`) is the changelog; there
is no separate CHANGELOG file.

| Track | Artifact | Version scheme | Tag | How-to |
|-------|----------|----------------|-----|--------|
| **cli** | `aindrive` on npm | semver | `vX.Y.Z` | [`cli/NPM_PUBLISH_GUIDE.md`](../cli/NPM_PUBLISH_GUIDE.md) |
| **web** | `aindrive.ainetwork.ai` container | calver (deploy date) | `web-YYYY.MM.DD` | [`DEPLOY.md`](DEPLOY.md) + [`DOCKER_PUBLISH_GUIDE.md`](DOCKER_PUBLISH_GUIDE.md) |

## CLI — semver, `vX.Y.Z`

The cli is a published npm package, so it carries a real semver version and one
tag per publish. **The `vX.Y.Z` git tag + the GitHub Release must match the
published npm version** — they ARE the release record.

Per release (mechanics in `cli/NPM_PUBLISH_GUIDE.md`):
1. `npm version <patch|minor|major>` (bumps `cli/package.json` + lockfile)
2. `git tag -a vX.Y.Z -m "aindrive X.Y.Z (cli npm release)"` and push the tag
3. `npm publish`
4. `gh release create vX.Y.Z --generate-notes`

- **Pitfall — version/tag drift:** hand-editing the version (skipping
  `npm version`) or publishing without tagging leaves the tag missing. That
  already happened to `0.2.4` (published, untagged — since backfilled). Always
  use the steps above; never bump the number by hand.
- **devDeps are not shipped.** The cli is bundled by esbuild (`dist/aindrive.mjs`),
  so a devDependency advisory (e.g. undici/hono) is a CI-`npm audit` concern,
  **not** an npm-user security issue — it does **not** require an urgent republish.

## web — continuous deploy from `main`, calver `web-YYYY.MM.DD`

The web app has **no npm artifact and no semver** (`web/package.json` stays at
`0.1.0`). A "release" is simply *the `main` commit currently live in the prod
container*; deploying = rebuilding that container from `main` HEAD.

Per prod deploy (mechanics in `DEPLOY.md` + `DOCKER_PUBLISH_GUIDE.md`):
1. Deploy as usual (rebuild the container from the intended `main` commit).
2. `git tag -a web-YYYY.MM.DD <deployed-commit> -m "web release YYYY.MM.DD — …"`
   (add `-2`, `-3` for multiple deploys in a day) and push the tag.
3. `gh release create web-YYYY.MM.DD --generate-notes`.

- Purpose: a **rollback reference** + human record of what went live and when.
- Do **not** bump `web/package.json` — the calver tag is the marker, not the
  package version (the container exposes no version).

## GitHub Releases

One Release per tag on **both** tracks, `--generate-notes` for the change list.
GitHub's "Latest" badge auto-resolves to the most recent tag across both tracks
(so it may sit on a `web-*` or a `v*` tag — that's expected; the two tracks are
peers, not a single version line).

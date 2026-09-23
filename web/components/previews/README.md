# web/components/previews — inline file preview renderers

Renders every non-text file the Viewer opens. `index.tsx` maps a `PreviewKind`
(`lib/preview-kind.ts`, chosen by file name) to a lazy renderer chunk; text and
markdown stay in `../viewer.tsx` (they own the Yjs lifecycle). Why/coverage:
`docs/superpowers/specs/2026-09-23-file-preview-coverage-design.md`.

## Kind → renderer → library

| kind | file | library |
|---|---|---|
| image / tiff / psd | `image` / `tiff` / `psd` | `<img>` / utif → canvas / ag-psd composite |
| pdf (also .ai) | `pdf` | pdfjs-dist, self-hosted worker + CMaps |
| video / audio | `video` / `audio` | native element → fs/preview `?to=mp4` when the codec fails |
| docx / pptx | `docx` / `pptx` | docx-preview / pptx-preview in `sandboxed-doc-frame` |
| sheet | `sheet` | SheetJS → own grid of React text nodes (no frame needed) |
| archive | `archive` + `archive-open` | libarchive.js (wasm); members re-previewed via `PreviewBody` |
| font / dxf | `font` / `dxf` | FontFace API / dxf-viewer (three.js, WebGL) |
| converted | `converted` | fs/preview `?to=pdf` → `pdf` viewer |

Password-protected OOXML: `office-password.tsx` + `lib/office-crypto.ts`.

## Contract

`types.ts` `PreviewSource {name, url, size, bytes(), convertUrl?}` — drive
files: `url` = fs/stream, `convertUrl` = fs/preview; archive members: `url` =
blob:, no `convertUrl` (never round-trip through the server). Renderers use
`bytes()` (memoized, `MAX_CLIENT_PARSE_BYTES` guard) rather than refetching.
Shared UI states: `status.tsx`. Converted/transcoded polling: `use-converted.ts`
(202 → poll, 415/422/501/413 → message, ~10 × 503 → "busy" + Retry).

## Security rules (keep them)

- Library HTML from untrusted XML only ever lands in `sandboxed-doc-frame`
  (`sandbox` WITHOUT `allow-scripts`). docx nodes are created in the frame's
  document (`frameFactory`); pptx run text is `<`-escaped before render
  (chart strings end up as SVG text nodes — verified inert).
- Links: only http(s)/mailto survive, forced to `target=_blank rel=noopener`,
  re-checked by a MutationObserver.
- Every Blob behind a blob: URL is typed: archive members are forced to
  `application/octet-stream` so "open in new tab" can't run HTML on our origin.
- CSP (`../../middleware.ts`) must allow `blob:` in `media-src`, `connect-src`
  (pdf.js fetch) and `worker-src` — archive members are blob: URLs.

## Assets & server path

- Workers / wasm / CMaps / DXF fonts are self-hosted under `/preview-assets`
  by `scripts/copy-preview-assets.mjs` (predev/prebuild); CSP blocks CDNs.
- Server conversion: `app/api/drives/[driveId]/fs/preview` + `lib/preview-convert.ts`
  → sidecar `web/converter/` (magic-byte + ffprobe gates, cached PDF/MP4).

## Gotchas

- The Viewer keys `PreviewBody` by `path:mtimeMs` — renderers may assume their
  source never changes under them.
- Free WebGL contexts / blob URLs / FontFaces in effect cleanups (browsers cap them).
- Word bullets in Symbol/Wingdings private-use code points are remapped in `docx.tsx`.

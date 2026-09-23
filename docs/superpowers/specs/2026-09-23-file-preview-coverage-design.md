# File preview coverage — parity with Google Drive (2026-09-23)

## Goal

Every file type Google Drive previews
(<https://support.google.com/drive/answer/37603>) opens inline in the aindrive
Viewer (the right-side panel). Before this, only what the agent's small mime
table tagged image/video/audio/pdf/text rendered; everything else — including
bmp/tiff, which the table simply lacked — showed "No inline preview".

Google's list: zip rar tar gzip · mp3 mpeg wav ogg opus · jpeg png gif bmp tiff
svg · css html php c cpp h hpp js java py · txt · webm mp4 3gp mov avi mpeg-ps
wmv flv ogg · dxf ai psd pdf eps ps ttf · xls xlsx ppt pptx doc docx xps ·
password-protected Office · key numbers.

## Decisions

1. **Renderer chosen by file name, not `entry.mime`.** `web/lib/preview-kind.ts`
   maps extension → `PreviewKind`. The agent's mime is unreliable (published CLI
   versions tag most types `application/octet-stream`), and fixing it would need
   every user to upgrade their agent. `preview-kind.test.ts` pins the Google list.

2. **Parse in the browser whenever a mature JS/wasm library exists.** The server
   never parses user files for these (it only proxies bytes), which keeps the
   attack surface where it already was and needs no new server capacity.

   | Kind | Library | Types |
   |---|---|---|
   | image | native `<img>` | jpg png gif webp bmp svg ico avif |
   | tiff | utif | tif tiff |
   | psd | ag-psd (composite) | psd |
   | pdf | pdfjs-dist (self-hosted worker) | pdf, ai (PDF-compatible) |
   | docx | docx-preview | docx |
   | sheet | SheetJS (CDN tarball — the npm `xlsx` is abandoned + vulnerable) | xlsx xls xlsb ods |
   | pptx | pptx-preview (echarts overridden to ≥6.1 for GHSA-fgmj-fm8m-jvvx) | pptx |
   | archive | libarchive.js (wasm) | zip rar 7z tar gz bz2 xz |
   | font | FontFace API | ttf otf woff woff2 |
   | dxf | dxf-viewer (three.js) | dxf |
   | text | Monaco (existing) | + php c cpp h hpp java … |
   | encrypted OOXML | cfb + WebCrypto/@noble (ECMA-376 agile/standard) | password prompt → docx/sheet/pptx |

3. **A converter sidecar for what browsers cannot render**: legacy binary
   Office (doc, ppt), iWork (key, numbers, pages), PostScript (eps, ps), XPS, and
   video codecs browsers don't decode (avi, wmv, flv, mpeg-ps, 3gp, and any
   native-container file whose codec fails). `web/converter/` is its own image
   (LibreOffice, Ghostscript, libgxps, ffmpeg) with **no secrets, no volumes, no
   egress** (internal compose network), read-only root, tmpfs, cap_drop ALL,
   memory/pid limits, per-job timeouts. Those parsers have a long CVE history —
   isolating them from the web process (which holds session secrets, payout
   keys and the SQLite DB) is the point.

   The web route `GET /api/drives/:id/fs/preview?path&to=pdf|mp4&v` gates like
   fs/stream (viewer+), pulls bytes from the agent, converts via the sidecar,
   and caches the output under `$AINDRIVE_DATA_DIR/previews/` keyed by
   path+mtime. It is asynchronous — `202 {status:"pending"}` while converting,
   `200` + Range-served bytes when ready — so long video transcodes never hit
   proxy timeouts. Without `AINDRIVE_CONVERTER_URL` it returns 501 and the
   Viewer shows "download to open".

4. **Rendered documents live in a sandboxed frame.** docx/sheet/pptx output is
   HTML built from untrusted XML (hyperlinks, embedded content). It is rendered
   into an `<iframe sandbox="allow-same-origin">` (no `allow-scripts`), so a
   `javascript:` link or injected markup cannot execute on the app origin.

5. **Out of scope**: grid thumbnails for the new types; HEIC (not on Google's
   list); editing any of the new types (preview only); decrypting legacy
   (RC4/binary) password-protected Office — reported as protected instead.

# web/converter — preview conversion sidecar

Converts file types browsers can't render into ones they can, for the file
Viewer: legacy Office / iWork / PostScript / XPS → PDF, non-browser video →
H.264 MP4. Called only by the web route `fs/preview` (`web/lib/preview-convert.ts`).
Why a separate image: spec §3 in `docs/superpowers/specs/2026-09-23-file-preview-coverage-design.md`.

## Files

- `server.mjs` — zero-dep node:http server: engines, concurrency gate, timeouts.
- `Dockerfile` — node:22-bookworm-slim + LibreOffice (`*-nogui`), ghostscript,
  libgxps-utils, ffmpeg, fonts (noto-cjk, liberation2, carlito, caladea). Non-root.

## API

- `POST /convert?to=pdf|mp4&ext=<ext>` — body = raw file bytes. `200` + the
  converted bytes (`application/pdf` / `video/mp4`), or JSON `{error}`:
  `415` unknown ext/target, `413` too large, `422` engine failed, `504` timed
  out, `503` queue full (`Retry-After`).
- `GET /healthz` — `{ok, running, queued}`.

| to | ext | engine | timeout env (default) |
|----|-----|--------|------------------------|
| pdf | doc dot rtf odt ott wpd ppt pps pot odp key numbers pages | `soffice --convert-to pdf` | `CONVERTER_DOC_TIMEOUT_MS` (120s) |
| pdf | eps ps | `gs -dSAFER … pdfwrite` (`-dEPSCrop` for eps) | `CONVERTER_PS_TIMEOUT_MS` (60s) |
| pdf | xps oxps | `xpstopdf` | `CONVERTER_PS_TIMEOUT_MS` |
| mp4 | video row of `web/lib/preview-kind.ts` | ffmpeg libx264/aac, ≤1280w, faststart | `CONVERTER_VIDEO_TIMEOUT_MS` (30 min) |

Other env: `PORT` (8080), `CONVERTER_MAX_INPUT_BYTES` (512 MiB),
`CONVERTER_CONCURRENCY` (2), `CONVERTER_MAX_QUEUE` (16).

## Security posture (keep it)

Runs third-party parsers on untrusted files, so it holds nothing and reaches
nothing: no secrets/env_file, no volumes, no ports, `internal` compose network
only, read-only root + `/tmp` tmpfs, `cap_drop: ALL`, `no-new-privileges`,
mem/pid/cpu limits (`web/docker-compose.yml`). Engines are spawned with an
args array (no shell), on a fixed `in.<ext>` name in a fresh per-job dir that
is always removed; a timeout SIGKILLs the whole process group.

## Gotchas

- `soffice` exits 0 on import failure — a missing output file is the failure signal.
- Each LibreOffice job gets its own `-env:UserInstallation` (concurrent jobs
  on one profile block each other); `HOME=/tmp` because root is read-only.
- The ext table mirrors `web/lib/preview-kind.ts` (`converted` + `video`) — keep in sync.
- Engine stderr goes to the container log only; callers get a generic message.

## Run locally

    docker build -t aindrive-converter:dev web/converter
    docker run -d --name aindrive-converter-dev --read-only --tmpfs /tmp:size=2g \
      --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1:3890:8080 aindrive-converter:dev
    # web: AINDRIVE_CONVERTER_URL=http://127.0.0.1:3890

# syntax=docker/dockerfile:1.7
# aindrive preview converter — see README.md. Deliberately a separate image
# from web: it runs third-party document/video parsers against user files and
# must never share a process, filesystem or secrets with the web app.
FROM node:22-bookworm-slim

# *-nogui: LibreOffice without the X11/GTK stack (headless convert only).
# iWork (key/numbers/pages) import comes with libreoffice-core (libetonyek).
# Fonts: noto-cjk for Korean/CJK text, liberation2 + carlito + caladea are
# metric-compatible stand-ins for Arial/Times/Calibri/Cambria so layouts
# don't reflow.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer-nogui libreoffice-calc-nogui \
      libreoffice-impress-nogui libreoffice-draw-nogui \
      ghostscript libgxps-utils ffmpeg \
      fonts-noto-cjk fonts-liberation2 fonts-crosextra-carlito \
      fonts-crosextra-caladea fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f \
    && groupadd -r conv && useradd -r -g conv -d /tmp -s /usr/sbin/nologin conv

WORKDIR /app
COPY server.mjs ./server.mjs

# Root fs is read-only at runtime; /tmp is the only writable place (tmpfs).
# LibreOffice and fontconfig want a writable HOME / cache dir.
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache

USER conv
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.mjs"]

// aindrive preview converter — turns file types browsers cannot render into
// ones they can (PDF for documents, H.264 MP4 for video). Runs in its own
// locked-down container (no secrets, no volumes, no egress) because the
// parsers it drives — LibreOffice, Ghostscript, libgxps, ffmpeg — have a long
// CVE history. See README.md.
//
// Zero dependencies on purpose: plain node:http, one file, nothing to audit.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const PORT = int("PORT", 8080);
const TMP = process.env.CONVERTER_TMP_DIR || "/tmp";
const MAX_INPUT_BYTES = int("CONVERTER_MAX_INPUT_BYTES", 512 * 1024 * 1024);
const CONCURRENCY = int("CONVERTER_CONCURRENCY", 2);
// Waiting jobs beyond this get 503 — a queue that grows without bound just
// converts a burst into a pile of timed-out requests.
const MAX_QUEUE = int("CONVERTER_MAX_QUEUE", 16);
const DOC_TIMEOUT_MS = int("CONVERTER_DOC_TIMEOUT_MS", 120_000);
const PS_TIMEOUT_MS = int("CONVERTER_PS_TIMEOUT_MS", 60_000);
const VIDEO_TIMEOUT_MS = int("CONVERTER_VIDEO_TIMEOUT_MS", 30 * 60_000);

function int(name, dflt) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

// ext → engine. Mirrors web/lib/preview-kind.ts ("converted" + "video" rows).
const LIBREOFFICE = ["doc", "dot", "rtf", "odt", "ott", "wpd", "ppt", "pps", "pot", "odp", "key", "numbers", "pages"];
const POSTSCRIPT = ["eps", "ps"];
const XPS = ["xps", "oxps"];
const VIDEO = [
  "mp4", "m4v", "webm", "mov", "ogv", "mkv",
  "avi", "wmv", "asf", "flv", "f4v", "3gp", "3g2", "mpg", "mpeg", "mpe", "m1v", "m2v", "vob", "m2ts",
];

/** Returns { run(inFile, outDir) → outFile, timeoutMs, mime } or null (415). */
function engineFor(to, ext) {
  if (to === "pdf" && LIBREOFFICE.includes(ext)) {
    return {
      mime: "application/pdf",
      timeoutMs: DOC_TIMEOUT_MS,
      run: async (inFile, jobDir, signal) => {
        const outDir = join(jobDir, "out");
        await mkdir(outDir);
        // Per-job profile dir: soffice refuses to run twice on one profile, so
        // a shared one would serialize (or deadlock) concurrent jobs.
        await exec("soffice", [
          "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nologo",
          `-env:UserInstallation=file://${join(jobDir, "lo")}`,
          "--convert-to", "pdf", "--outdir", outDir, inFile,
        ], signal);
        // soffice exits 0 even when the import filter failed — the missing
        // output file is the only reliable failure signal.
        const out = (await readdir(outDir)).find((f) => f.endsWith(".pdf"));
        if (!out) throw new ConvertError("document could not be converted");
        return join(outDir, out);
      },
    };
  }
  if (to === "pdf" && POSTSCRIPT.includes(ext)) {
    return {
      mime: "application/pdf",
      timeoutMs: PS_TIMEOUT_MS,
      run: async (inFile, jobDir, signal) => {
        const out = join(jobDir, "out.pdf");
        // -dSAFER: PostScript is a programming language; without it a file can
        // read/write arbitrary paths. -dEPSCrop sizes the page to the EPS bbox.
        await exec("gs", [
          "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pdfwrite",
          ...(ext === "eps" ? ["-dEPSCrop"] : []),
          "-o", out, inFile,
        ], signal);
        return out;
      },
    };
  }
  if (to === "pdf" && XPS.includes(ext)) {
    return {
      mime: "application/pdf",
      timeoutMs: PS_TIMEOUT_MS,
      run: async (inFile, jobDir, signal) => {
        const out = join(jobDir, "out.pdf");
        await exec("xpstopdf", [inFile, out], signal);
        return out;
      },
    };
  }
  if (to === "mp4" && VIDEO.includes(ext)) {
    return {
      mime: "video/mp4",
      timeoutMs: VIDEO_TIMEOUT_MS,
      run: async (inFile, jobDir, signal) => {
        const out = join(jobDir, "out.mp4");
        await exec("ffmpeg", [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-i", inFile,
          "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          // ≤1280 wide, both dims even (yuv420p + libx264 reject odd sizes).
          "-vf", "scale='trunc(min(1280,iw)/2)*2':-2",
          "-c:a", "aac", "-b:a", "128k",
          // moov atom up front so the browser can start playing / seek over Range.
          "-movflags", "+faststart",
          out,
        ], signal);
        return out;
      },
    };
  }
  return null;
}

class ConvertError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

/** Spawn without a shell; kill the whole process group on abort. */
function exec(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    // detached → own process group, so a timeout also kills soffice's
    // oosplash → soffice.bin child instead of orphaning it.
    const child = spawn(cmd, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    signal.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => { signal.removeEventListener("abort", kill); reject(e); });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      kill(); // reap any grandchildren left in the group
      if (signal.aborted) return reject(new ConvertError("conversion timed out", 504));
      if (code !== 0) {
        // Parser stderr stays in the sidecar log — it is noise to end users.
        console.warn(`[converter] ${cmd} exit ${code}: ${stderr.trim().slice(-500)}`);
        return reject(new ConvertError(`${cmd === "soffice" ? "document" : cmd === "ffmpeg" ? "video" : "file"} could not be converted`));
      }
      resolve();
    });
  });
}

// ── concurrency gate ────────────────────────────────────────────────────────
let running = 0;
const waiting = [];
function acquire() {
  if (running < CONCURRENCY) { running++; return Promise.resolve(); }
  if (waiting.length >= MAX_QUEUE) return null;
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), ...headers });
  res.end(s);
}

async function handleConvert(req, res, url) {
  const to = url.searchParams.get("to") ?? "";
  const ext = (url.searchParams.get("ext") ?? "").toLowerCase();
  const engine = engineFor(to, ext);
  if (!engine) return sendJson(res, 415, { error: `unsupported conversion: .${ext} → ${to}` });
  const declared = parseInt(req.headers["content-length"] ?? "", 10);
  if (declared > MAX_INPUT_BYTES) return sendJson(res, 413, { error: "input too large", limit: MAX_INPUT_BYTES });

  // Take a slot BEFORE reading the body: queued uploads then wait in TCP
  // backpressure instead of piling up in the size-limited /tmp tmpfs.
  const slot = acquire();
  if (!slot) return sendJson(res, 503, { error: "converter busy" }, { "retry-after": "10" });
  await slot;

  let jobDir;
  let timer;
  const ac = new AbortController();
  // Client went away (web gave up) → stop burning CPU on it.
  res.on("close", () => { if (!res.writableFinished) ac.abort(); });
  try {
    jobDir = await mkdtemp(join(TMP, "job-"));
    // Fixed basename: the user's file name never reaches a command line.
    const inFile = join(jobDir, `in.${ext}`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > MAX_INPUT_BYTES) cb(new ConvertError("input too large", 413));
        else cb(null, chunk);
      },
    });
    await pipeline(req, limiter, createWriteStream(inFile));
    if (received === 0) throw new ConvertError("empty input", 400);

    // Timeout starts after the upload: pulling bytes from a slow agent is not
    // the engine hanging.
    timer = setTimeout(() => ac.abort(), engine.timeoutMs);

    const out = await engine.run(inFile, jobDir, ac.signal);
    const size = (await stat(out).catch(() => null))?.size ?? 0;
    if (size === 0) throw new ConvertError("conversion produced no output");
    clearTimeout(timer);
    res.writeHead(200, { "content-type": engine.mime, "content-length": size });
    await pipeline(createReadStream(out), res);
  } catch (e) {
    const status = e instanceof ConvertError ? e.status : 500;
    if (status >= 500 && status !== 504) console.error("[converter]", to, ext, e);
    else console.warn("[converter]", to, ext, e.message);
    sendJson(res, status, { error: e instanceof ConvertError ? e.message : "conversion failed" });
  } finally {
    clearTimeout(timer);
    if (jobDir) await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://converter");
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, running, queued: waiting.length });
  }
  if (req.method === "POST" && url.pathname === "/convert") {
    handleConvert(req, res, url).catch((e) => { console.error("[converter]", e); sendJson(res, 500, { error: "internal error" }); });
    return;
  }
  sendJson(res, 404, { error: "not found" });
});
// Long transcodes: never let node's own timeouts cut a live request.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.listen(PORT, () => console.log(`[converter] listening on :${PORT} (concurrency ${CONCURRENCY})`));

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));

/**
 * The afan host bridge — the aindrive side of afan-soverign `docs/AGENT_BRIDGE.md`
 * (design record: ain-integration `docs/18-afan-host-bridge.md`).
 *
 * afan sovereign has no network code. To ask a shared agent it writes
 * `people/<me>/agent-requests/<id>.md` into the folder this agent serves; this module notices the file (through
 * agent.js's existing fs.watch), checks who asked, calls the agent over A2A with a handoff grant for the files
 * the request names, and writes the answer to `people/<me>/agent-results/<id>.md`. It also keeps `_catalog.md`
 * (the registry listing the app picks from) at the bundle root.
 *
 * Rules it keeps:
 *   • Off by default. On for a folder only with `"afanBridge": true` in its `.aindrive/config.json`, or for
 *     every folder this process serves with `AINDRIVE_AFAN_BRIDGE=1`. A folder not paired with a drive
 *     (no driveId — e.g. a bundle that arrived by USB) never runs it.
 *   • A handle is a directory name, not an identity. A request runs only when the server, asked with this
 *     host's own session, confirms the handle: the drive owner (`drive.md` names the handle, and
 *     `GET /api/drives/:id` — creator only — answers 200), or exactly one member holding `editor` on
 *     `people/<handle>` (`GET /api/drives/:id/members`). Anything that cannot be confirmed gets an error
 *     result and is never executed.
 *   • `POST /api/handoffs` is owner-only, so only the owner's requests carry files. A member's request would
 *     need a resource delegation minted for that member (AIN SSO `ain-rdlg`), which this host cannot mint on
 *     their behalf — so a confirmed member is refused with `forbidden` (detail `member-delegation-unavailable`).
 *   • Credentials — the session, the handoff grant token and link secrets, the Ainize bearer — live in memory
 *     and in request headers / the A2A message only. Nothing written to the bundle carries one, and every
 *     written text is scrubbed of them as a last line of defence. Logs carry ids and statuses only.
 *   • Idempotent. The A2A `messageId` is the request's `idempotency_key`; a result that exists is never
 *     re-run (a result file is created exclusively, so two hosts serving the same folder cannot both answer);
 *     a completed answer for the same key is reused without calling the agent again. A `running` result this
 *     device left behind (crash, restart) is resumed with the same messageId.
 *   • `canceled: true` is honoured before the call and while it runs (tasks/cancel when the task id is known);
 *     `expires` is honoured before the call and bounds how long the host waits.
 */
import { promises as fsp, constants as FS } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeHandoffs, removeHandoffs, HANDOFFS_FILE } from "./handoffs.js";
import { guessMime } from "./rpc.js";
import { log as defaultLog } from "./logger.js";
import {
  CATALOG_MIN_INTERVAL_MS, CATALOG_PATH, DEFAULT_AINIZE_URL, catalogAsOf, catalogMarkdown, fetchRegistry, isoSeconds,
} from "./afan-catalog.js";

export const REQUEST_TYPE = "afan Agent Request";
export const RESULT_TYPE = "afan Agent Result";
export const DRIVE_TYPE = "afan Drive";
/** `people/<handle>/agent-requests/<id>.md` — a temp file (`….md.tmp`) never matches. */
export const REQUEST_PATH_RE = /^people\/([^/]+)\/agent-requests\/([^/]+)\.md$/;
/** afan-soverign schema.ts HANDLE_RE. */
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HANDOFF_TTL_SECONDS = 15 * 60;
const MAX_HANDOFF_FILES = 50;
const FOLDER_MAX_ENTRIES = 200;
const REGISTRY_RETRY_MS = 60_000;
const VERIFY_CACHE_MS = 60_000;
/** The longest the host waits on one agent when the request's expiry is further away. */
const MAX_WAIT_MS = 10 * 60_000;
const SECRET_SHAPES = /(aind_[a-z]+_[A-Za-z0-9_-]+|ain-rdlg[A-Za-z0-9+._-]*|([?&](?:token|signature|sig|key|k)=)[^&\s)"']+)/gi;

/** Contract errors.ts RETRYABLE. */
const RETRYABLE = {
  auth_required: false, forbidden: false, entitlement_required: false, unsupported_input: false,
  source_offline: true, resource_deleted: false, agent_stopped: false, rate_limited: true, temporary_failure: true,
};

/** Whether this served folder runs the bridge. Off unless the folder or the environment opts in. */
export function afanBridgeEnabled(drive, env = process.env) {
  if (!drive?.driveId) return false;
  return drive.afanBridge === true || env.AINDRIVE_AFAN_BRIDGE === "1";
}

class BridgeError extends Error {
  constructor(status, code, message, detail, extra = {}) {
    super(message);
    this.status = status; this.code = code; this.detail = detail; this.extra = extra;
  }
}
const reject = (code, message, detail) => new BridgeError("rejected", code, message, detail);
const fail = (code, message, detail, extra) => new BridgeError("failed", code, message, detail, extra);

/** Split a markdown file into frontmatter (parsed) and body; null when it is not a concept. */
export function parseConcept(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  let fm;
  try { fm = parseYaml(m[1]); } catch { return null; }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) return null;
  return { fm, body: m[2] ?? "" };
}

/** The text under `# Heading` up to the next top-level heading (afan core `bodySection`). */
export function bodySection(body, heading) {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^# /.test(lines[i] ?? "")) { end = i; break; }
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Contract `conversationContextId`. */
export function conversationContextId({ account, org = null, product = "afan", room = null, conversation }) {
  return ["ctx", account, org ?? "-", product, room ?? "-", conversation].map((s) => encodeURIComponent(String(s))).join(":");
}

/** The aindrive user id in a session JWT (`sub`), read without verifying — it is our own token. */
function sessionSubject(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload?.sub === "string" && payload.sub ? payload.sub : null;
  } catch { return null; }
}

function isLoopback(host) { return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"; }
/** An agent endpoint must be https (http only on loopback, for local stacks and tests). */
function allowedEndpoint(url) {
  try { const u = new URL(url); return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u.hostname)); }
  catch { return false; }
}

/** The text of A2A parts (v0.3 `kind: "text"`, or v1 `text`). */
function textOfParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((p) => (typeof p?.text === "string" && (p.kind === "text" || p.type === "text" || p.kind === undefined) ? p.text : ""))
    .filter(Boolean).join("\n");
}

/** File parts an agent returned, as FileRefs (references only; a URL that carries a credential is dropped). */
function outputsOf(parts) {
  const out = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    const f = p?.kind === "file" ? p.file : null;
    if (!f || typeof f.uri !== "string") continue;
    if (/[?&](token|signature|sig|key|k)=/i.test(f.uri) || /aind_[a-z]+_|ain-rdlg/i.test(f.uri)) continue;
    out.push({ ...(typeof f.name === "string" ? { display_name: f.name } : {}), source_url: f.uri });
  }
  return out;
}

/** A normalized drive path from a bundle-absolute or drive-relative path; null when it escapes. */
function cleanRel(p) {
  if (typeof p !== "string") return null;
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  if (parts[0] === ".aindrive") return null;
  return parts.join("/");
}

/**
 * Build the bridge for one served folder.
 *
 * @param {object} o
 * @param {string} o.root              the served folder (= the afan bundle root)
 * @param {string} o.driveId
 * @param {string} o.server            the aindrive server origin
 * @param {() => Promise<string|null>} o.getSession  this host's aindrive session token (never logged)
 * @param {string} [o.ainizeUrl]
 * @param {string} [o.ainizeToken]     optional bearer for Ainize (registry + A2A)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {string} [o.handoffsFile]
 * @param {() => number} [o.now]
 * @param {string} [o.device]
 * @param {string} [o.hostVersion]
 * @param {number} [o.pollMs]
 */
export function createAfanBridge(o) {
  const root = resolve(o.root);
  const driveId = o.driveId;
  const server = String(o.server || "").replace(/\/+$/, "");
  const ainizeUrl = String(o.ainizeUrl || DEFAULT_AINIZE_URL).replace(/\/+$/, "");
  const ainizeToken = o.ainizeToken || null;
  const fetchImpl = o.fetchImpl || fetch;
  const handoffsFile = o.handoffsFile || HANDOFFS_FILE;
  const now = o.now || (() => Date.now());
  const device = o.device || osHostname();
  const host = `aindrive-cli/${o.hostVersion || "dev"}`;
  const pollMs = o.pollMs ?? 1000;
  const log = o.log || defaultLog;
  const debounceMs = o.debounceMs ?? 150;

  const inFlight = new Map();   // request rel path → promise
  const timers = new Map();
  const verifyCache = new Map(); // handle → { at, value }
  let registry = null;          // { at, entries }
  let catalogWrittenAt = null;  // ms; null until read from disk
  let catalogRun = null;
  const secrets = new Set();    // every credential seen this process — scrubbed from written text
  let closed = false;

  const remember = (s) => { if (typeof s === "string" && s.length >= 6) secrets.add(s); };
  remember(ainizeToken);

  function scrub(text) {
    let s = String(text ?? "");
    for (const secret of secrets) if (secret) s = s.split(secret).join("[redacted]");
    return s.replace(SECRET_SHAPES, (m, _all, q) => (q ? `${q}[redacted]` : "[redacted]"));
  }

  // ------------------------------------------------------------------ aindrive server (this host's session)

  async function serverCall(method, path, body) {
    const session = await o.getSession();
    if (!session) throw new BridgeError("rejected", "auth_required", "this aindrive host is not signed in (run `aindrive login`)", "no-session");
    remember(session);
    const res = await fetchImpl(`${server}${path}`, {
      method,
      headers: { accept: "application/json", cookie: `aindrive_session=${session}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json, session };
  }

  async function readConcept(rel) {
    try { return parseConcept(await fsp.readFile(join(root, rel), "utf8")); } catch { return null; }
  }

  async function driveOwnerHandle() {
    const c = await readConcept("drive.md");
    return c?.fm?.type === DRIVE_TYPE && typeof c.fm.owner === "string" ? c.fm.owner : null;
  }

  /**
   * Who a handle is, as the server says — `{ kind: "owner"|"member", account }` — or a BridgeError naming why
   * it cannot be confirmed. Cached briefly so a burst of requests asks once.
   */
  async function verifyAuthor(handle) {
    const hit = verifyCache.get(handle);
    if (hit && now() - hit.at < VERIFY_CACHE_MS) { if (hit.value instanceof Error) throw hit.value; return hit.value; }
    let value;
    try { value = await verifyAuthorUncached(handle); }
    catch (e) {
      // The server could not be asked (offline): still refused — never run unconfirmed — but retryable, and not cached.
      if (!(e instanceof BridgeError)) throw fail("source_offline", "the aindrive server could not be reached to confirm who wrote this request", "author-unverifiable");
      value = e;
    }
    verifyCache.set(handle, { at: now(), value });
    if (value instanceof Error) throw value;
    return value;
  }

  /**
   * Accounts OTHER than the drive's creator that can write `people/<handle>/…` — an editor (or co-owner) on the
   * drive root, on `people`, or on `people/<handle>` itself. Any of them could have written the request file (or,
   * at the root, rewritten drive.md's owner line), so a request under that handle cannot be attributed to one person.
   */
  async function writersOf(handle) {
    const r = await serverCall("GET", `/api/drives/${encodeURIComponent(driveId)}/members`);
    if (r.status === 401) throw reject("auth_required", "this aindrive host's sign-in is no longer valid", "session-refused");
    if (r.status >= 500) throw new Error(`members ${r.status}`); // transient: retryable, not cached (see verifyAuthor)
    if (r.status !== 200 || !Array.isArray(r.json?.members)) throw reject("forbidden", "the drive's members could not be read to confirm the author", "author-unverified");
    const scopes = new Set(["", "people", `people/${handle}`]);
    return new Set(r.json.members
      .filter((m) => scopes.has(cleanRel(m?.path ?? "")) && (m.role === "editor" || m.role === "owner"))
      .map((m) => ({ key: String(m.email ?? m.id ?? "").toLowerCase(), exact: cleanRel(m?.path ?? "") === `people/${handle}` })))
  }

  async function verifyAuthorUncached(handle) {
    const ownerHandle = await driveOwnerHandle();
    if (ownerHandle && ownerHandle === handle) {
      const r = await serverCall("GET", `/api/drives/${encodeURIComponent(driveId)}`);
      if (r.status === 401) throw reject("auth_required", "this aindrive host's sign-in is no longer valid", "session-refused");
      if (r.status >= 500) throw new Error(`drive ${r.status}`); // transient: retryable, not cached
      if (r.status !== 200) throw reject("forbidden", `drive.md names "${handle}" as owner, but this host's account does not own the drive`, "drive-owner-mismatch");
      // The owner's folder (and drive.md at the root) must be writable by the owner alone, or the request could be
      // someone else's wearing the owner's handle — and it would run with an owner handoff grant.
      const others = await writersOf(handle);
      if (others.size) throw reject("forbidden", `another account can write people/${handle} (or the drive root), so this request cannot be attributed to the owner`, "author-ambiguous");
      return { kind: "owner", account: `aindrive:${sessionSubject(r.session) ?? driveId}` };
    }
    const writers = [...await writersOf(handle)];
    const exact = new Set(writers.filter((w) => w.exact).map((w) => w.key));
    const broader = writers.filter((w) => !w.exact);
    if (broader.length) throw reject("forbidden", `an account with editor on the drive root or on people can write people/${handle}`, "author-ambiguous");
    if (exact.size !== 1) throw reject("forbidden", `no single account holds editor on people/${handle}`, exact.size ? "author-ambiguous" : "author-unverified");
    return { kind: "member", account: null };
  }

  async function isDriveOwner() {
    try { return (await serverCall("GET", `/api/drives/${encodeURIComponent(driveId)}`)).status === 200; } catch { return false; }
  }

  // ------------------------------------------------------------------ registry + catalog

  async function listing({ maxAgeMs = CATALOG_MIN_INTERVAL_MS } = {}) {
    if (registry && now() - registry.at < maxAgeMs) return registry.entries;
    const entries = await fetchRegistry({ ainizeUrl, token: ainizeToken, fetchImpl });
    registry = { at: now(), entries };
    return entries;
  }

  async function resolveAgent(key) {
    let entries;
    try { entries = await listing(); }
    catch { throw fail("source_offline", "the agent registry could not be reached", "registry-unreachable"); }
    let entry = entries.find((e) => e.agentKey === key);
    if (!entry && registry && now() - registry.at >= REGISTRY_RETRY_MS) {
      try { entry = (await listing({ maxAgeMs: 0 })).find((e) => e.agentKey === key); } catch { /* keep the miss */ }
    }
    return entry ?? null;
  }

  /**
   * Rewrite `_catalog.md` from the registry — at most every 10 minutes, and only on the owner's host (the
   * root is owner-writable only under the two-grant model).
   */
  function refreshCatalog({ force = false } = {}) {
    if (catalogRun) return catalogRun;
    catalogRun = (async () => {
      if (catalogWrittenAt === null) catalogWrittenAt = await catalogAsOf(root);
      if (!force && now() - catalogWrittenAt < CATALOG_MIN_INTERVAL_MS) return false;
      if (!(await isDriveOwner())) return false;
      const entries = await listing({ maxAgeMs: force ? 0 : CATALOG_MIN_INTERVAL_MS });
      await atomicWrite(CATALOG_PATH, scrub(catalogMarkdown(entries, isoSeconds(now()))));
      catalogWrittenAt = now();
      log.info({ agents: entries.length }, "afan catalog refreshed");
      return true;
    })().catch((e) => { log.warn({ err: e?.message ? String(e.message).slice(0, 120) : "error" }, "afan catalog refresh failed"); return false; })
      .finally(() => { catalogRun = null; });
    return catalogRun;
  }

  // ------------------------------------------------------------------ files

  async function atomicWrite(rel, text) {
    const abs = join(root, rel);
    await fsp.mkdir(join(abs, ".."), { recursive: true });
    const tmp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, abs);
  }

  /** Create `rel` only if absent (link is atomic and fails on EEXIST). False when someone else got there first. */
  async function exclusiveWrite(rel, text) {
    const abs = join(root, rel);
    await fsp.mkdir(join(abs, ".."), { recursive: true });
    const tmp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
    await fsp.writeFile(tmp, text);
    try {
      await fsp.link(tmp, abs);
      return true;
    } catch (e) {
      if (e?.code === "EEXIST") return false;
      // a filesystem without hard links: check-then-rename (a narrow race, still never a partial file)
      try { await fsp.access(abs, FS.F_OK); return false; } catch { /* absent */ }
      await fsp.rename(tmp, abs);
      return true;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  function resultMarkdown(r) {
    const fm = {
      type: RESULT_TYPE,
      title: `Answer to ${r.requestId}`,
      request_id: r.requestId,
      request: `/people/${r.handle}/agent-requests/${r.requestId}.md`,
      author: r.handle,
      agent: {
        ...(r.agentKey ? { key: r.agentKey } : {}),
        ...(r.releaseId ? { release_id: r.releaseId } : {}),
        ...(r.endpoint ? { endpoint: r.endpoint } : {}),
      },
      status: r.status,
      ...(r.taskId ? { task_id: r.taskId } : {}),
      ...(r.contextId ? { context_id: r.contextId } : {}),
      ...(r.error ? { error: {
        code: r.error.code, message: r.error.message, retryable: r.error.retryable ?? RETRYABLE[r.error.code] ?? false,
        action_url: r.error.actionUrl ?? null, ...(r.error.detail ? { detail: r.error.detail } : {}),
      } } : {}),
      ...(r.idempotencyKey ? { idempotency_key: r.idempotencyKey } : {}),
      started: r.started,
      ...(r.finished ? { finished: r.finished } : {}),
      sources: r.sources ?? [],
      outputs: r.outputs ?? [],
      ...(r.detail ? { detail: r.detail } : {}),
      executed_by: { host, device },
      generated: { by: r.answeredByAgent && r.agentKey ? `agent:${r.agentKey}` : "agent:aindrive-cli", at: r.finished ?? r.started },
      ...(r.verified ? { verified: [{ by: `aindrive:${driveId}`, at: r.verifiedAt, method: "grant-match" }] } : {}),
    };
    const parts = [];
    if (r.status === "completed" || r.answer) parts.push("# Answer", "", (r.answer ?? "").trim() || "(the agent returned no text)", "");
    else if (r.error) parts.push("# Answer", "", `Not answered: ${r.error.message}`, "");
    else parts.push("# Answer", "", "(working…)", "");
    if (r.sources?.length) parts.push("# Sources", "", ...r.sources.map((s) => `* [${s.split("/").pop() || s}](${s})`), "");
    return scrub(`---\n${stringifyYaml(fm, { lineWidth: 0 })}---\n${parts.join("\n")}`);
  }

  // ------------------------------------------------------------------ file refs → local files

  function refDriveId(ref) {
    if (typeof ref.file_key === "string") { const parts = ref.file_key.split("#"); if (parts.length >= 3) return parts[1]; }
    // Both sourceUrl spellings aindrive serves: /d/<id>/<path> and /d/<id>?path=<path>.
    if (typeof ref.source_url === "string") {
      const m = /\/d\/([^/?#]+)(?:[/?#]|$)/.exec(ref.source_url);
      if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
    }
    return null;
  }

  async function localFileOf(ref) {
    let rel;
    if (typeof ref.bundle_path === "string") rel = cleanRel(ref.bundle_path);
    else if (typeof ref.legacy_path === "string") {
      const d = refDriveId(ref);
      if (d && d !== driveId) throw reject("forbidden", "a file from another drive cannot be handed off by this host", "cross-drive-file");
      rel = cleanRel(ref.legacy_path);
    } else throw reject("unsupported_input", "a file reference names no path this host can resolve", "unresolvable-file-ref");
    if (rel === null) throw reject("forbidden", "a file reference points outside the shared folder", "path-escape");
    const realRoot = await fsp.realpath(root);
    let abs;
    try { abs = await fsp.realpath(join(root, rel)); }
    catch { throw fail("resource_deleted", `a referenced file is gone: ${basename(rel) || "/"}`, "file-missing"); }
    if (abs !== realRoot && !abs.startsWith(realRoot + sep)) throw reject("forbidden", "a file reference points outside the shared folder", "path-escape");
    const st = await fsp.stat(abs);
    const source = ref.source_url ?? ref.bundle_path ?? `/${rel}`;
    return { rel, abs, st, source, name: ref.display_name || basename(abs) || "folder" };
  }

  async function folderContext(f) {
    const dirents = await fsp.readdir(f.abs, { withFileTypes: true });
    const visible = dirents.filter((d) => !d.name.startsWith(".") && !d.name.endsWith(".tmp"));
    const entries = [];
    for (const d of visible.slice(0, FOLDER_MAX_ENTRIES)) {
      let size = null;
      if (d.isFile()) { try { size = (await fsp.stat(join(f.abs, d.name))).size; } catch { /* raced */ } }
      entries.push({ name: d.name, path: `/${f.rel ? `${f.rel}/` : ""}${d.name}`, isDir: d.isDirectory(), size, mime: d.isDirectory() ? null : guessMime(d.name) });
    }
    return { name: f.name, path: `/${f.rel}`, recursive: false, depth: 1, totalEntries: visible.length, truncated: visible.length > FOLDER_MAX_ENTRIES, entries };
  }

  // ------------------------------------------------------------------ A2A

  async function a2a(endpoint, method, params, signal) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(ainizeToken ? { authorization: `Bearer ${ainizeToken}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
        signal,
      });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw fail("source_offline", "the agent could not be reached", "agent-unreachable");
    }
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    if (res.status >= 400) {
      const c = json?.error && typeof json.error.code === "string" ? json.error : null;
      const byStatus = { 401: "auth_required", 402: "entitlement_required", 403: "forbidden", 404: "resource_deleted", 409: "agent_stopped", 410: "resource_deleted", 415: "unsupported_input", 429: "rate_limited" };
      const code = c?.code && code_ok(c.code) ? c.code : byStatus[res.status] ?? "temporary_failure";
      throw fail(code, c?.message ? scrub(String(c.message)).slice(0, 300) : `the agent answered ${res.status}`, `a2a-http-${res.status}`,
        { actionUrl: typeof (c?.actionUrl ?? c?.action_url) === "string" ? (c.actionUrl ?? c.action_url) : undefined });
    }
    if (json?.error) throw fail("temporary_failure", scrub(String(json.error.message ?? "agent error")).slice(0, 300), `a2a-rpc-${json.error.code ?? "error"}`);
    return json?.result;
  }
  const code_ok = (c) => Object.prototype.hasOwnProperty.call(RETRYABLE, c);

  /** A2A result (Message or Task) → { state, taskId, contextId, text, outputs }. */
  function readA2a(result) {
    if (!result || typeof result !== "object") return { state: "failed", text: "" };
    if (result.kind === "message" || (Array.isArray(result.parts) && !result.status)) {
      return { state: "completed", taskId: result.taskId, contextId: result.contextId, text: textOfParts(result.parts), outputs: outputsOf(result.parts) };
    }
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const artParts = artifacts.flatMap((a) => (Array.isArray(a?.parts) ? a.parts : []));
    const statusText = textOfParts(result.status?.message?.parts);
    const text = textOfParts(artParts) || statusText;
    return {
      state: String(result.status?.state ?? "unknown").toLowerCase().replace(/_/g, "-"),
      taskId: typeof result.id === "string" ? result.id : undefined,
      contextId: typeof result.contextId === "string" ? result.contextId : undefined,
      text, statusText, outputs: outputsOf(artParts),
    };
  }

  // ------------------------------------------------------------------ one request

  async function readRequest(rel) {
    const c = await readConcept(rel);
    if (!c || c.fm.type !== REQUEST_TYPE) return null;
    return c;
  }

  async function findCompletedTwin(handle, requestId, key) {
    if (!key) return null;
    const dir = join(root, "people", handle, "agent-results");
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return null; }
    for (const name of names) {
      if (!name.endsWith(".md") || name === `${requestId}.md`) continue;
      const c = await readConcept(`people/${handle}/agent-results/${name}`);
      if (c?.fm?.type === RESULT_TYPE && c.fm.status === "completed" && c.fm.idempotency_key === key && c.fm.author === handle) return c;
    }
    return null;
  }

  async function processRequest(rel) {
    const m = REQUEST_PATH_RE.exec(rel);
    if (!m || closed) return null;
    const [, handle, requestId] = m;
    const resultRel = `people/${handle}/agent-results/${requestId}.md`;
    const req = await readRequest(rel);
    if (!req) return null;
    const existing = await readConcept(resultRel);
    let resume = false;
    if (existing) {
      // A result exists → answered (or being answered by another host). Resume only our own stale `running`.
      if (existing.fm.status === "running" && existing.fm.executed_by?.device === device) resume = true;
      else return null;
    }

    const fm = req.fm;
    const agentKey = typeof fm.agent?.key === "string" ? fm.agent.key : undefined;
    const releaseWanted = typeof fm.agent?.release_id === "string" ? fm.agent.release_id : undefined;
    const idempotencyKey = typeof fm.idempotency_key === "string" && fm.idempotency_key ? fm.idempotency_key : requestId;
    const conversation = typeof fm.conversation === "string" && fm.conversation ? fm.conversation : requestId;
    const started = isoSeconds(now());
    const base = { handle, requestId, agentKey, releaseId: releaseWanted, idempotencyKey, started };

    const finish = async (r, { exclusive }) => {
      const text = resultMarkdown({ ...base, finished: isoSeconds(now()), ...r });
      if (exclusive) return exclusiveWrite(resultRel, text);
      await atomicWrite(resultRel, text);
      return true;
    };
    const refuse = (e, extra = {}) => finish({
      status: e.status === "failed" ? "failed" : e.status, ...extra,
      error: { code: e.code, message: scrub(e.message), detail: e.detail, actionUrl: e.extra?.actionUrl },
    }, { exclusive: !resume });

    // --- checks that need nothing but the file
    if (!HANDLE_RE.test(handle) || !REQUEST_ID_RE.test(requestId)) return null;
    if (fm.author !== handle) return refuse(reject("unsupported_input", "the request's author is not the person whose folder it is in", "author-path-mismatch"));
    if (fm.request_id !== undefined && fm.request_id !== requestId) return refuse(reject("unsupported_input", "request_id does not match the file name", "request-id-mismatch"));
    if (!agentKey) return refuse(reject("unsupported_input", "the request names no agent", "missing-agent"));
    if (fm.canceled === true) return finish({ status: "canceled" }, { exclusive: !resume });
    const expiresAt = Date.parse(fm.expires ?? "");
    if (Number.isFinite(expiresAt) && now() >= expiresAt) {
      return finish({ status: "expired", error: { code: "temporary_failure", message: "the request expired before this host could start it", detail: "expired-before-start", retryable: true } }, { exclusive: !resume });
    }

    // --- who asked (the server decides, never the handle string)
    let who;
    try { who = await verifyAuthor(handle); }
    catch (e) { return refuse(e instanceof BridgeError ? e : reject("forbidden", "could not confirm who wrote this request", "author-unverified")); }
    const verifiedAt = isoSeconds(now());
    const verified = { verified: true, verifiedAt };
    if (who.kind !== "owner") {
      return refuse(reject("forbidden", "only the drive owner's requests can hand files to an agent from this host; a member's request needs a delegation this host cannot mint", "member-delegation-unavailable"), verified);
    }

    // --- the same question already answered → reuse, never call twice
    const twin = await findCompletedTwin(handle, requestId, idempotencyKey);
    if (twin) {
      const answer = bodySection(twin.body, "# Answer") ?? twin.body.trim();
      return finish({
        ...verified, status: "completed", answeredByAgent: true, answer,
        endpoint: twin.fm.agent?.endpoint, releaseId: twin.fm.agent?.release_id ?? releaseWanted,
        taskId: twin.fm.task_id, contextId: twin.fm.context_id,
        sources: Array.isArray(twin.fm.sources) ? twin.fm.sources : [], outputs: Array.isArray(twin.fm.outputs) ? twin.fm.outputs : [],
        detail: twin.fm.detail,
      }, { exclusive: !resume });
    }

    // --- which agent
    let agent;
    try { agent = await resolveAgent(agentKey); }
    catch (e) { return refuse(e, verified); }
    if (!agent) return refuse(reject("resource_deleted", "this agent is not in the registry", "agent-not-found"), verified);
    if (agent.status !== "active") return refuse(reject("agent_stopped", `this agent is ${agent.status}`, `agent-${agent.status}`), verified);
    if (!agent.canInvoke) return refuse(reject("forbidden", "this agent cannot be called by this account", "cannot-invoke"), verified);
    if (releaseWanted && agent.releaseId && releaseWanted !== agent.releaseId) return refuse(reject("unsupported_input", `release ${releaseWanted} is not the one the registry serves`, "release-mismatch"), verified);
    if (!agent.endpoint || !allowedEndpoint(agent.endpoint)) return refuse(reject("unsupported_input", "the agent has no usable endpoint", "endpoint-unusable"), verified);

    const contextId = conversationContextId({ account: who.account, org: null, product: "afan", room: driveId, conversation });
    const running = { ...verified, agentKey, releaseId: agent.releaseId ?? releaseWanted, endpoint: agent.endpoint, contextId };

    // --- claim: the result file exists from here on, so no other host (or re-scan) runs it
    if (!resume) {
      const claimed = await exclusiveWrite(resultRel, resultMarkdown({ ...base, ...running, status: "running" }));
      if (!claimed) return null;
    }
    const write = (r) => finish({ ...running, ...r }, { exclusive: false });

    let handoff = null;
    try {
      // --- files → one handoff grant (owner-only POST /api/handoffs)
      const refs = (Array.isArray(fm.file_refs) ? fm.file_refs : []).filter((r) => r && typeof r === "object");
      const files = [], folders = [];
      for (const ref of refs) {
        const f = await localFileOf(ref);
        if (f.st.isDirectory()) folders.push(f); else if (f.st.isFile()) files.push(f);
      }
      if (files.length > MAX_HANDOFF_FILES) throw reject("unsupported_input", `at most ${MAX_HANDOFF_FILES} files per request`, "too-many-files");
      if (files.length) handoff = await grantFiles(files, `afan:${agentKey}:${requestId}`.slice(0, 300));

      // --- A2A message/send (messageId = idempotency key → the node answers a retry with the same task)
      const folderContexts = [];
      for (const f of folders) folderContexts.push(await folderContext(f));
      const prompt = bodySection(req.body, "# Prompt") ?? req.body.trim();
      const parts = [
        { kind: "text", text: prompt },
        ...folderContexts.map((folder) => ({ kind: "data", data: { folder }, metadata: { type: "ai.aindrive/folder-context" } })),
        ...(handoff ? handoff.links.slice(0, 10).map((l) => ({ kind: "file", file: { uri: l.url, name: l.name, mimeType: l.mime } })) : []),
        ...(handoff?.mcp ? [{
          kind: "data",
          data: { mcpServers: [{ name: "aindrive-handoff", transport: "streamable-http", url: handoff.mcp.url, headers: { Authorization: `Bearer ${handoff.mcp.token}` }, expiresAt: handoff.mcp.expiresAt, tools: ["list_files", "read_file"] }] },
          metadata: { type: "ai.aindrive/handoff-mcp" },
        }] : []),
      ];
      const message = { kind: "message", role: "user", messageId: idempotencyKey, contextId, parts };
      const outcome = await runTask(agent.endpoint, message, rel, expiresAt);

      const sources = handoff ? await readSources(handoff) : [];
      if (outcome.canceled) return await write({ status: "canceled", taskId: outcome.taskId, sources });
      if (outcome.expired) return await write({ status: "expired", taskId: outcome.taskId, sources, error: { code: "temporary_failure", message: "the agent did not answer before the request expired", detail: "expired-while-running", retryable: true } });
      const a = outcome.read;
      const taskId = a.taskId, ctx = a.contextId ?? contextId;
      if (a.state === "completed") {
        return await write({
          status: "completed", answeredByAgent: true, answer: a.text, taskId, contextId: ctx, sources, outputs: a.outputs,
          ...(sources.length ? {} : { detail: "no-sources" }),
        });
      }
      if (a.state === "canceled") return await write({ status: "canceled", taskId, contextId: ctx, sources });
      const code = a.state === "auth-required" ? "auth_required" : a.state === "input-required" ? "unsupported_input" : "temporary_failure";
      return await write({
        status: "failed", answeredByAgent: true, taskId, contextId: ctx, sources,
        error: { code, message: scrub(a.statusText || `the agent's task ended ${a.state}`).slice(0, 300), detail: `task-${a.state}` },
      });
    } catch (e) {
      const err = e instanceof BridgeError ? e : fail("temporary_failure", "the host could not complete this request", "host-error");
      if (!(e instanceof BridgeError)) log.warn({ requestId, err: String(e?.message ?? e).slice(0, 120).replace(SECRET_SHAPES, "[redacted]") }, "afan bridge error");
      return await write({ status: err.status, error: { code: err.code, message: scrub(err.message), detail: err.detail, actionUrl: err.extra?.actionUrl } });
    } finally {
      if (handoff) await revoke(handoff);
    }
  }

  /** Register device keys, then ask the server for one grant over exactly those files. */
  async function grantFiles(files, audience) {
    const expiresAt = now() + HANDOFF_TTL_SECONDS * 1000 + 60_000;
    const keyed = files.map((f) => ({ ...f, deviceKey: randomBytes(18).toString("base64url") }));
    const add = {};
    for (const f of keyed) add[f.deviceKey] = { path: f.abs, expiresAt };
    await writeHandoffs(add, handoffsFile, now());
    const keys = keyed.map((f) => f.deviceKey);
    let r;
    try {
      r = await serverCall("POST", "/api/handoffs", {
        driveId, audience, ttlSeconds: HANDOFF_TTL_SECONDS,
        files: keyed.map((f) => ({ deviceKey: f.deviceKey, name: f.name.slice(0, 255), mime: guessMime(f.name), size: f.st.size })),
      });
    } catch (e) {
      await removeHandoffs(keys, handoffsFile, now());
      if (e instanceof BridgeError) throw e;
      throw fail("source_offline", "the aindrive server could not be reached to grant the files", "handoff-unreachable");
    }
    if (r.status !== 200 || !r.json?.mcp) {
      await removeHandoffs(keys, handoffsFile, now());
      if (r.status === 401) throw reject("auth_required", "this aindrive host's sign-in is no longer valid", "session-refused");
      if (r.status === 403) throw reject("forbidden", "the server refused to hand these files off", "handoff-forbidden");
      if (r.status === 429) throw fail("rate_limited", "too many handoffs right now", "handoff-rate-limited");
      throw fail("temporary_failure", `the server could not grant the files (${r.status})`, "handoff-failed");
    }
    remember(r.json.mcp.token);
    const links = (r.json.links ?? []).map((l) => {
      try { remember(new URL(l.url).searchParams.get("k")); } catch { /* no url */ }
      const f = keyed.find((k) => k.deviceKey === l.deviceKey);
      return { id: l.id, url: l.url, name: l.name, mime: f ? guessMime(f.name) : "application/octet-stream", source: f?.source };
    });
    return { audience, keys, links, mcp: { url: r.json.mcp.url, token: r.json.mcp.token, expiresAt: r.json.mcp.expiresAt } };
  }

  /** What the agent actually read: the grant's links the server logged a successful fetch for. */
  async function readSources(handoff) {
    try {
      const r = await serverCall("GET", "/api/handoffs");
      const rows = Array.isArray(r.json?.handoffs) ? r.json.handoffs : [];
      const read = new Set(rows.filter((h) => Number(h?.fetches) > 0).map((h) => h.id));
      return [...new Set(handoff.links.filter((l) => read.has(l.id) && l.source).map((l) => l.source))];
    } catch { return []; }
  }

  async function revoke(handoff) {
    try { await serverCall("DELETE", `/api/handoffs?audience=${encodeURIComponent(handoff.audience)}`); }
    catch { log.warn("afan handoff revoke failed — the grant still expires on its own"); }
    try { await removeHandoffs(handoff.keys, handoffsFile, now()); } catch { /* expires anyway */ }
  }

  /**
   * message/send, then tasks/get until the task ends — while watching the request file for `canceled: true`
   * and the clock for `expires`.
   */
  async function runTask(endpoint, message, rel, expiresAt) {
    const deadline = Math.min(Number.isFinite(expiresAt) ? expiresAt : Infinity, now() + MAX_WAIT_MS);
    const ac = new AbortController();
    let taskId;
    let stop = null; // "canceled" | "expired"
    const watch = (async () => {
      while (!ac.signal.aborted) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (ac.signal.aborted) return;
        const req = await readRequest(rel);
        if (req?.fm?.canceled === true) { stop = "canceled"; ac.abort(); return; }
        if (now() >= deadline) { stop = "expired"; ac.abort(); return; }
      }
    })();
    const cancelTask = async () => { if (taskId) { try { await a2a(endpoint, "tasks/cancel", { id: taskId }); } catch { /* best effort */ } } };
    try {
      let read;
      try {
        read = readA2a(await a2a(endpoint, "message/send", { message, configuration: { acceptedOutputModes: ["text/plain", "application/json"] } }, ac.signal));
      } catch (e) {
        if (stop) return { [stop]: true, taskId };
        throw e;
      }
      taskId = read.taskId;
      while (["submitted", "working", "unknown"].includes(read.state)) {
        if (stop) { await cancelTask(); return { [stop]: true, taskId }; }
        if (!taskId) break;
        await new Promise((r) => setTimeout(r, pollMs));
        if (stop) { await cancelTask(); return { [stop]: true, taskId }; }
        try { read = readA2a(await a2a(endpoint, "tasks/get", { id: taskId }, ac.signal)); }
        catch (e) { if (stop) { await cancelTask(); return { [stop]: true, taskId }; } throw e; }
      }
      return { read, taskId };
    } finally {
      if (!ac.signal.aborted) ac.abort();
      await watch.catch(() => {});
    }
  }

  // ------------------------------------------------------------------ entry points

  /** Run one request path (drive-relative); one run per path at a time. */
  function runRequest(rel) {
    if (inFlight.has(rel)) return inFlight.get(rel);
    const p = processRequest(rel)
      .then((r) => { if (r) log.info({ path: rel.split("/").slice(-1)[0] }, "afan request answered"); return r; })
      .catch((e) => { log.warn({ err: String(e?.message ?? e).slice(0, 120).replace(SECRET_SHAPES, "[redacted]") }, "afan request failed"); return null; })
      .finally(() => inFlight.delete(rel));
    inFlight.set(rel, p);
    p.then(() => refreshCatalog()).catch(() => {});
    return p;
  }

  /** agent.js's fs.watch hands every changed path here; only request files are acted on (debounced). */
  function notify(rel) {
    if (closed || typeof rel !== "string" || !REQUEST_PATH_RE.test(rel)) return false;
    if (timers.has(rel)) clearTimeout(timers.get(rel));
    timers.set(rel, setTimeout(() => { timers.delete(rel); runRequest(rel); }, debounceMs));
    return true;
  }

  /** Every request already in the folder — at start and after a reconnect (requests written while offline). */
  async function scan() {
    const out = [];
    let people = [];
    try { people = await fsp.readdir(join(root, "people"), { withFileTypes: true }); } catch { return out; }
    for (const p of people) {
      if (!p.isDirectory()) continue;
      let names = [];
      try { names = await fsp.readdir(join(root, "people", p.name, "agent-requests")); } catch { continue; }
      for (const n of names) {
        const rel = `people/${p.name}/agent-requests/${n}`;
        if (REQUEST_PATH_RE.test(rel)) out.push(runRequest(rel));
      }
    }
    refreshCatalog();
    return Promise.all(out);
  }

  /** Resolves when nothing is running (tests, graceful stop). */
  async function idle() {
    while (inFlight.size || timers.size || catalogRun) {
      await Promise.all([...inFlight.values(), catalogRun].filter(Boolean));
      if (timers.size) await new Promise((r) => setTimeout(r, debounceMs + 10));
    }
  }

  /** Keep `_catalog.md` fresh while the host runs (each tick is still throttled to once per 10 minutes). */
  let catalogTimer = null;
  function startCatalogTimer(everyMs = CATALOG_MIN_INTERVAL_MS) {
    if (catalogTimer || closed) return;
    catalogTimer = setInterval(() => { refreshCatalog(); }, everyMs);
    catalogTimer.unref?.();
  }

  function close() {
    closed = true;
    if (catalogTimer) { clearInterval(catalogTimer); catalogTimer = null; }
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return { notify, scan, process: runRequest, refreshCatalog, startCatalogTimer, idle, close };
}

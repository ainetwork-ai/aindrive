/**
 * One `aindrive <folder>` agent process per shared folder — the same CLI a
 * terminal user runs (cli/, bundled into the app as cli/aindrive.mjs). The app
 * never talks to the server itself: pairing, sign-in and serving are the CLI's.
 *
 * Status comes from the CLI's output: its plain lines (pairing, "waiting for
 * approval") and its pino JSON log ("connected", "disconnected", …).
 *
 * How a process is started is injected (`spawn`): Electron's utilityProcess in
 * the app (main.js), plain child_process in tests. No Electron imports here.
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** @typedef {"starting"|"approve"|"connecting"|"online"|"stopped"|"error"} State */
/**
 * What `spawn` must return — the shape shared by child_process and utilityProcess.
 * @typedef {{ pid?: number, stdout: NodeJS.ReadableStream|null, stderr: NodeJS.ReadableStream|null,
 *   on(ev: "exit", fn: (code: number|null) => void): unknown, on(ev: "error", fn: (e: unknown) => void): unknown,
 *   kill(): unknown }} Proc
 */

const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];
/** longer than the CLI's own shutdown drain (cli/src/agent.js DRAIN_TIMEOUT_MS = 10 s) */
const STOP_GRACE_MS = 12_000;

/** What one line of CLI output says about the agent, if anything. */
export function parseLine(line) {
  const s = line.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j.msg === "connected") return { state: "online" };
      if (j.msg === "disconnected" || j.msg === "reconnecting") return { state: "connecting" };
      if (j.msg === "agent connection error") return { state: "connecting", detail: j.err };
      return null;
    } catch { return null; }
  }
  if (/waiting for approval/i.test(s)) return { state: "approve" };
  const login = s.match(/(https?:\/\/\S+\/cli-login\/\S+)/);
  if (login) return { loginUrl: login[1] };
  const paired = s.match(/✓ paired\s+(\S+)/);
  if (paired) return { url: paired[1], state: "connecting" };
  if (/signed in/i.test(s)) return { state: "starting" };
  if (/aindrive serving/i.test(s)) return { state: "connecting" };
  const err = s.match(/^aindrive:\s*(.+)$/);
  if (err) return { state: "error", detail: err[1] };
  return null;
}

/** The web URL of a paired folder, from the CLI's `.aindrive/config.json`. */
export function driveUrlOf(folder) {
  const f = join(folder, ".aindrive", "config.json");
  if (!existsSync(f)) return null;
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    return c.url || (c.serverUrl && c.driveId ? `${c.serverUrl}/d/${c.driveId}` : null);
  } catch { return null; }
}

export function isFolder(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export class AgentManager extends EventEmitter {
  /**
   * @param {{ spawn: (folder: string, firstRun: boolean) => Proc }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    /**
     * `removing`: stopped and forgotten, but its process has not exited yet — kept
     * so a quick re-share waits for it instead of running two agents on one folder.
     * @type {Map<string, { child: Proc|null, state: State, detail?: string, url?: string|null, loginUrl?: string,
     *   restarts: number, wanted: boolean, removing?: boolean, killing?: boolean, firstRun?: boolean, timer?: NodeJS.Timeout, killTimer?: NodeJS.Timeout }>}
     */
    this.agents = new Map();
  }

  /** Snapshot for the UI. */
  list() {
    return [...this.agents.entries()].filter(([, a]) => !a.removing).map(([folder, a]) => ({
      folder,
      name: basename(folder),
      state: a.state,
      detail: a.detail ?? null,
      url: a.url ?? driveUrlOf(folder),
      loginUrl: a.state === "approve" ? a.loginUrl ?? null : null,
    }));
  }

  has(folder) {
    const a = this.agents.get(folder);
    return !!a && !a.removing;
  }

  /** Start serving a folder (idempotent). `firstRun` lets the CLI open the browser. */
  start(folder, { firstRun = false } = {}) {
    let a = this.agents.get(folder);
    if (!a) {
      a = { child: null, state: "starting", restarts: 0, wanted: true, url: driveUrlOf(folder) };
      this.agents.set(folder, a);
    }
    a.wanted = true;
    a.removing = false;
    a.firstRun = firstRun;
    clearTimeout(a.timer);
    // still running (or still shutting down after a pause/remove): its exit respawns it
    if (a.child) { this.emit("change"); return; }
    this.#spawn(folder, a);
  }

  #spawn(folder, a) {
    a.state = "starting";
    a.detail = undefined;
    if (!isFolder(folder)) {
      a.state = "error";
      a.detail = "This folder is not available — is its drive connected?";
      this.#scheduleRestart(folder, a, true);
      this.emit("change");
      return;
    }
    /** @type {Proc} */
    let child;
    try {
      child = this.opts.spawn(folder, !!a.firstRun);
    } catch (e) {
      a.state = "error";
      a.detail = e instanceof Error ? e.message : String(e);
      this.emit("change");
      return;
    }
    a.firstRun = false;
    a.child = child;
    const onLine = (line) => {
      this.emit("log", folder, line);
      const p = parseLine(line);
      if (!p) return;
      if (p.url) a.url = p.url;
      if (p.loginUrl) a.loginUrl = p.loginUrl;
      if (p.state) {
        a.state = p.state;
        a.detail = p.detail;
        if (p.state === "online") a.restarts = 0;
      }
      this.emit("change");
    };
    // one buffer per stream, decoded as a stream: a line split across chunks,
    // or a "✓" split across bytes, still arrives whole
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const dec = new StringDecoder("utf8");
      let pending = "";
      stream.on("data", (buf) => {
        const lines = (pending + dec.write(buf)).split("\n");
        pending = lines.pop() ?? "";
        lines.forEach(onLine);
      });
      stream.on("end", () => { const rest = pending + dec.end(); pending = ""; if (rest) onLine(rest); });
    }
    let exited = false;
    const onExit = (code) => {
      if (exited || a.child !== child) return;
      exited = true;
      clearTimeout(a.killTimer);
      const killed = a.killing;
      a.killing = false;
      a.child = null;
      a.url = driveUrlOf(folder) ?? a.url;
      if (a.removing && !a.wanted) {
        this.agents.delete(folder);
      } else if (!a.wanted) {
        a.state = "stopped";
        a.detail = undefined;
      } else if (killed) {
        this.#spawn(folder, a); // paused or removed, then shared again while it was shutting down
        return;
      } else if (!driveUrlOf(folder)) {
        // never paired (sign-in declined, link expired, crashed…): wait for the user to retry,
        // rather than minting a new sign-in link every minute
        a.state = "error";
        a.detail ??= code ? `aindrive stopped (${code}) before the folder was shared` : "Sign-in did not finish";
      } else {
        this.#scheduleRestart(folder, a, false, code);
      }
      this.emit("change");
    };
    child.on("exit", onExit);
    child.on("error", (e) => {
      a.detail = e instanceof Error ? e.message : String(e);
      // a process that never started (no pid) emits no exit — treat the error as one
      if (child.pid === undefined) { a.state = "error"; onExit(null); }
      else this.emit("change");
    });
    this.emit("change");
  }

  /** A paired folder should stay served: come back, slower each time. */
  #scheduleRestart(folder, a, unavailable, code) {
    const delay = RESTART_DELAYS_MS[Math.min(a.restarts, RESTART_DELAYS_MS.length - 1)];
    a.restarts++;
    if (!unavailable) {
      a.state = "connecting";
      a.detail = code ? `agent exited (${code}) — retrying` : undefined;
    }
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      if (a.wanted && !a.child && this.agents.get(folder) === a) this.#spawn(folder, a);
    }, delay);
  }

  #kill(a) {
    const c = a.child;
    if (!c) return;
    a.killing = true;
    c.kill();
    // the CLI drains in-flight requests first; past that, it is stuck
    clearTimeout(a.killTimer);
    a.killTimer = setTimeout(() => {
      if (a.child === c) { try { process.kill(/** @type {number} */ (c.pid), "SIGKILL"); } catch { /* gone */ } }
    }, STOP_GRACE_MS);
  }

  /** Stop serving (the folder stays in the list, paused). */
  stop(folder) {
    const a = this.agents.get(folder);
    if (!a) return;
    a.wanted = false;
    clearTimeout(a.timer);
    if (a.child) this.#kill(a);
    else { a.state = "stopped"; a.detail = undefined; }
    this.emit("change");
  }

  /** Stop and forget. */
  remove(folder) {
    const a = this.agents.get(folder);
    if (!a) return;
    a.wanted = false;
    a.removing = true;
    clearTimeout(a.timer);
    if (a.child) this.#kill(a);
    else this.agents.delete(folder);
    this.emit("change");
  }

  /** Add a folder in the stopped state (restored paused on launch). */
  addStopped(folder) {
    if (!this.agents.has(folder)) this.agents.set(folder, { child: null, state: "stopped", restarts: 0, wanted: false, url: driveUrlOf(folder) });
  }

  /** Stop everything — pending restarts included — and wait for the processes to exit. */
  async stopAll(ms = STOP_GRACE_MS + 1_000) {
    for (const a of this.agents.values()) {
      a.wanted = false;
      clearTimeout(a.timer);
    }
    const kids = [...this.agents.values()].filter((a) => a.child).map((a) => {
      const c = /** @type {Proc} */ (a.child);
      const done = new Promise((r) => c.on("exit", r));
      this.#kill(a);
      return done;
    });
    await Promise.race([Promise.all(kids), new Promise((r) => setTimeout(r, ms))]);
  }
}

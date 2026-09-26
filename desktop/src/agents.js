/**
 * One `aindrive <folder>` agent process per shared folder — the same CLI a
 * terminal user runs (cli/, bundled into the app as cli/aindrive.mjs), started
 * with the app's own runtime as Node (ELECTRON_RUN_AS_NODE). The app never
 * talks to the server itself: pairing, sign-in and serving are the CLI's.
 *
 * Status comes from the CLI's output: its plain lines (pairing, "waiting for
 * approval") and its pino JSON log ("connected", "disconnected", …).
 *
 * No Electron imports here, so tests can drive it with any command.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** @typedef {"starting"|"approve"|"connecting"|"online"|"stopped"|"error"} State */

const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];

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

export class AgentManager extends EventEmitter {
  /**
   * @param {{ command: string, args: (folder: string, firstRun: boolean) => string[], env?: Record<string,string> }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    /** @type {Map<string, { child: import("node:child_process").ChildProcess|null, state: State, detail?: string, url?: string|null, loginUrl?: string, restarts: number, wanted: boolean, timer?: NodeJS.Timeout }>} */
    this.agents = new Map();
  }

  /** Snapshot for the UI. */
  list() {
    return [...this.agents.entries()].map(([folder, a]) => ({
      folder,
      name: basename(folder),
      state: a.state,
      detail: a.detail ?? null,
      url: a.url ?? driveUrlOf(folder),
      loginUrl: a.state === "approve" ? a.loginUrl ?? null : null,
    }));
  }

  /** Start serving a folder (idempotent). `firstRun` lets the CLI open the browser. */
  start(folder, { firstRun = false } = {}) {
    let a = this.agents.get(folder);
    if (a?.child) return;
    if (!a) {
      a = { child: null, state: "starting", restarts: 0, wanted: true, url: driveUrlOf(folder) };
      this.agents.set(folder, a);
    }
    a.wanted = true;
    clearTimeout(a.timer);
    this.#spawn(folder, a, firstRun);
  }

  #spawn(folder, a, firstRun) {
    a.state = "starting";
    a.detail = undefined;
    const child = spawn(this.opts.command, this.opts.args(folder, firstRun), {
      cwd: folder,
      env: { ...process.env, ...this.opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    a.child = child;
    const onData = (buf) => {
      a.pending = (a.pending ?? "") + buf.toString("utf8");
      const lines = a.pending.split("\n");
      a.pending = lines.pop();
      for (const line of lines) {
        this.emit("log", folder, line);
        const p = parseLine(line);
        if (!p) continue;
        if (p.url) a.url = p.url;
        if (p.loginUrl) a.loginUrl = p.loginUrl;
        if (p.state) {
          a.state = p.state;
          a.detail = p.detail;
          if (p.state === "online") a.restarts = 0;
        }
        this.emit("change");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      a.state = "error";
      a.detail = e.message;
      this.emit("change");
    });
    child.on("exit", (code) => {
      a.child = null;
      if (!a.url) a.url = driveUrlOf(folder);
      if (!a.wanted) {
        a.state = "stopped";
      } else if (a.state === "error" && !driveUrlOf(folder)) {
        // never paired (sign-in declined, link expired…): wait for the user to retry
      } else {
        // a paired folder should stay served: come back, slower each time
        const delay = RESTART_DELAYS_MS[Math.min(a.restarts, RESTART_DELAYS_MS.length - 1)];
        a.restarts++;
        a.state = "connecting";
        a.detail = code ? `agent exited (${code}) — retrying` : undefined;
        a.timer = setTimeout(() => { if (a.wanted && !a.child) this.#spawn(folder, a, false); }, delay);
      }
      this.emit("change");
    });
    this.emit("change");
  }

  /** Stop serving (the folder stays in the list, paused). */
  stop(folder) {
    const a = this.agents.get(folder);
    if (!a) return;
    a.wanted = false;
    clearTimeout(a.timer);
    if (a.child) a.child.kill("SIGTERM");
    else a.state = "stopped";
    this.emit("change");
  }

  /** Stop and forget. */
  remove(folder) {
    this.stop(folder);
    this.agents.delete(folder);
    this.emit("change");
  }

  /** Add a folder in the stopped state (restored paused on launch). */
  addStopped(folder) {
    if (!this.agents.has(folder)) this.agents.set(folder, { child: null, state: "stopped", restarts: 0, wanted: false, url: driveUrlOf(folder) });
  }

  /** SIGTERM everything; resolves once all have exited (or after `ms`). */
  async stopAll(ms = 5_000) {
    const kids = [...this.agents.values()].filter((a) => a.child).map((a) => {
      a.wanted = false;
      clearTimeout(a.timer);
      const c = a.child;
      return new Promise((r) => { c.once("exit", r); c.kill("SIGTERM"); });
    });
    await Promise.race([Promise.all(kids), new Promise((r) => setTimeout(r, ms))]);
  }
}

import { spawn } from "node:child_process";

/**
 * Git over SSH: the agent end of a bidirectional `git upload-pack` /
 * `git receive-pack` stream (web/lib/git-ssh/*, web/lib/agents.js openGitExec).
 *
 * Smart-HTTP (rpc.js `git-service`) runs git with --stateless-rpc on one request
 * body and one result file. Over SSH git speaks the STATEFUL protocol: the
 * upload-pack negotiation is multi-round on one connection, so the two ends
 * must be live pipes. The RPC `git-ssh-exec` (rpc.js) spawns the service and
 * registers it here; from then on the same WebSocket carries, next to the
 * ordinary request/response frames, these per-exec frames (all HMAC-signed
 * with the drive secret like every other frame, cli/src/sig.js):
 *
 *   server → agent  {type:"git-stdin",  execId, seq, data?:b64, eof?:true, kill?:true, ack?:n}
 *   agent → server  {type:"git-stdout", execId, seq, data:b64}
 *                   {type:"git-stderr", execId, data:b64}
 *                   {type:"git-exit",   execId, code, signal}
 *                   {type:"git-stdin-ack", execId, ack:n}   (bytes written to git's stdin)
 *
 * Flow control is a byte window in each direction: the sender stops after
 * WINDOW unacknowledged bytes until the receiver acks what it consumed, so a
 * slow SSH client never makes the agent buffer a whole clone in memory, and a
 * big push never piles up in git's stdin pipe buffer here.
 *
 * Only the two services are ever spawned, always on a path rpc.js safeResolve
 * accepted and _isGitRepo confirmed; this module never touches the path itself.
 */
export const GIT_EXEC_LIMITS = Object.freeze({
  chunkBytes: 256 * 1024,      // one stdout frame's payload (before base64)
  windowBytes: 4 * 1024 * 1024, // unacknowledged bytes allowed in flight per direction
  maxPerConnection: 8,          // concurrent execs one agent connection serves
  maxMs: 300_000,               // the agent's own cap; the server enforces the same
});

export class GitExecs {
  /**
   * @param {{ send: (frame: object) => void, log?: { warn: Function, info: Function } }} io
   *   `send` signs and writes one agent→server frame (type + fields, no sig yet).
   */
  constructor({ send, log = console, afterReceive = null }) {
    this._send = send;
    this._log = log;
    /** called with the repo path after a receive-pack exited 0 (rpc.js postReceive: fast-forward the working copy) */
    this._afterReceive = afterReceive;
    /** @type {Map<string, object>} */
    this._execs = new Map();
  }

  get size() { return this._execs.size; }

  /**
   * Spawn `git <service> <repoAbs>`. Resolves once the child is running (its
   * `spawn` event) so the RPC answer means "stdin is open". Rejects when the
   * exec id is taken, the cap is hit or git cannot be spawned.
   */
  start({ execId, repoAbs, service, protocol }) {
    if (typeof execId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(execId)) throw new Error("invalid execId");
    if (this._execs.has(execId)) throw new Error("exec already running");
    if (this._execs.size >= GIT_EXEC_LIMITS.maxPerConnection) throw new Error("too many concurrent git sessions");
    if (service !== "upload-pack" && service !== "receive-pack") throw new Error("unknown git service");

    const env = protocol ? { ...process.env, GIT_PROTOCOL: protocol } : process.env;
    const child = spawn("git", [service, repoAbs], { stdio: ["pipe", "pipe", "pipe"], env });
    const ex = {
      execId, child, seq: 0,
      outUnacked: 0,      // stdout bytes sent, not yet acked by the server
      inUnacked: 0,       // stdin bytes received, not yet reported written
      paused: false,
      done: false,
      timer: null,
    };
    this._execs.set(execId, ex);

    child.stdout.on("data", (buf) => {
      for (let off = 0; off < buf.length; off += GIT_EXEC_LIMITS.chunkBytes) {
        const part = buf.subarray(off, Math.min(buf.length, off + GIT_EXEC_LIMITS.chunkBytes));
        ex.outUnacked += part.length;
        this._send({ type: "git-stdout", execId, seq: ex.seq++, data: part.toString("base64") });
      }
      if (ex.outUnacked >= GIT_EXEC_LIMITS.windowBytes && !ex.paused) { ex.paused = true; child.stdout.pause(); }
    });
    child.stderr.on("data", (buf) => {
      this._send({ type: "git-stderr", execId, data: buf.toString("base64") });
    });
    child.stdin.on("error", () => {}); // EPIPE when git exits before the client stops sending
    child.on("close", (code, signal) => {
      // The git-exit frame waits for the working copy sync, so a client that
      // reloads the drive right after `git push` sees the pushed files.
      const after = service === "receive-pack" && code === 0 && this._afterReceive ? this._afterReceive(repoAbs) : null;
      Promise.resolve(after).catch(() => null).then(() => this._finish(ex, { code, signal }));
    });
    ex.timer = setTimeout(() => {
      this._log.warn?.({ execId, service }, "git exec hit the time cap — killing");
      try { child.kill("SIGKILL"); } catch {}
    }, GIT_EXEC_LIMITS.maxMs);
    ex.timer.unref?.();

    return new Promise((resolve, reject) => {
      child.once("spawn", () => resolve({ pid: child.pid }));
      child.once("error", (e) => {
        this._finish(ex, { code: null, signal: null, error: e.message });
        reject(new Error("git could not be started: " + e.message));
      });
    });
  }

  /** A server→agent `git-stdin` frame (already signature-verified by the caller). */
  stdin(frame) {
    const ex = this._execs.get(frame.execId);
    if (!ex || ex.done) return false;
    if (typeof frame.ack === "number" && frame.ack > 0) {
      ex.outUnacked = Math.max(0, ex.outUnacked - frame.ack);
      if (ex.paused && ex.outUnacked < GIT_EXEC_LIMITS.windowBytes / 2) { ex.paused = false; ex.child.stdout.resume(); }
    }
    if (frame.kill) { try { ex.child.kill("SIGKILL"); } catch {} return true; }
    if (typeof frame.data === "string" && frame.data.length) {
      const buf = Buffer.from(frame.data, "base64");
      if (!ex.child.stdin.destroyed && ex.child.stdin.writable) {
        ex.child.stdin.write(buf, () => {
          if (ex.done) return;
          this._send({ type: "git-stdin-ack", execId: ex.execId, ack: buf.length });
        });
      }
    }
    if (frame.eof) { try { ex.child.stdin.end(); } catch {} }
    return true;
  }

  /** Kill every running exec (the connection dropped). */
  closeAll() {
    for (const ex of [...this._execs.values()]) {
      try { ex.child.kill("SIGKILL"); } catch {}
      this._finish(ex, { code: null, signal: "SIGKILL", silent: true });
    }
  }

  _finish(ex, { code, signal, error = null, silent = false }) {
    if (ex.done) return;
    ex.done = true;
    clearTimeout(ex.timer);
    this._execs.delete(ex.execId);
    if (!silent) this._send({ type: "git-exit", execId: ex.execId, code, signal: signal ?? null, ...(error ? { error } : {}) });
  }
}

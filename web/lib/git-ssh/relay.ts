/**
 * One git-over-SSH exec: the SSH channel on one side, the drive agent's live
 * `git <service> <repo>` pipe (lib/agents.js openGitExec) on the other.
 *
 * Why not the smart-HTTP relay (lib/git-http.ts: body → temp file → git
 * --stateless-rpc → temp file → response)? Over SSH git speaks its STATEFUL
 * protocol: upload-pack negotiation is several have/ack rounds on one
 * connection and receive-pack reads the pack while answering, so the two ends
 * must be live pipes — hence the `git-ssh-exec` RPC plus stream frames.
 *
 * Per exec: a 300 s cap (same as the HTTP git-service timeout), a per-drive
 * concurrency cap, and one log line (user, drive, repo, service, bytes in/out,
 * ms, exit). On a channel close or error before git finished, git is killed on
 * the agent; nothing is left behind (no temp files exist in this path).
 */
import { AgentError, callAgent } from "../rpc";
import { openGitExec, type GitExecExit, type GitExecHandle } from "../agents.js";
import type { GitService } from "./command";

export const GIT_SSH_EXEC_TIMEOUT_MS = 300_000;
export const GIT_SSH_MAX_PER_DRIVE = 4;

/** The subset of an ssh2 session channel the relay touches (so tests can fake it). */
export interface RelayChannel {
  on(event: "data", cb: (buf: Buffer) => void): unknown;
  on(event: "end" | "close", cb: () => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  write(buf: Buffer, cb?: (err?: Error | null) => void): boolean;
  pause(): unknown;
  resume(): unknown;
  end(): unknown;
  close(): unknown;
  exit(code: number): unknown;
  stderr: { write(buf: Buffer | string): unknown };
}

export type RelayOutcome = { exit: number; bytesIn: number; bytesOut: number; ms: number; error?: string };

const inflight = new Map<string, number>();
export function activeExecs(driveId: string): number { return inflight.get(driveId) ?? 0; }

type Opener = typeof openGitExec;

export type RelayOpts = {
  driveId: string;
  driveSecret: string;
  repo: string;
  service: GitService;
  protocol?: string;
  channel: RelayChannel;
  timeoutMs?: number;
  maxPerDrive?: number;
  /** Test seam: a fake openGitExec. */
  open?: Opener;
  /** Test seam: a fake git-init (a push to a path with no repo creates one, as over HTTP). */
  init?: (driveId: string, secret: string, repo: string) => Promise<unknown>;
};

/**
 * Run the exec to completion. Resolves (never rejects) with the outcome; the
 * channel has been given its exit status and closed by then. Refusals that
 * happen before git starts (offline drive, missing repo, cap) are reported to
 * the client on stderr with exit 1 — git prints them as `fatal: …`.
 */
export async function relayGitExec(opts: RelayOpts): Promise<RelayOutcome> {
  const { driveId, repo, service, channel } = opts;
  const started = Date.now();
  const max = opts.maxPerDrive ?? GIT_SSH_MAX_PER_DRIVE;
  const open = opts.open ?? openGitExec;
  const init = opts.init ?? ((d: string, s: string, r: string) => callAgent(d, s, { method: "git-init", repo: r }));

  const fail = (msg: string, extra: Partial<RelayOutcome> = {}): RelayOutcome => {
    try { channel.stderr.write(`aindrive: ${msg}\n`); } catch {}
    try { channel.exit(1); } catch {}
    try { channel.end(); } catch {}
    try { channel.close(); } catch {}
    return { exit: 1, bytesIn: 0, bytesOut: 0, ms: Date.now() - started, error: msg, ...extra };
  };

  if (activeExecs(driveId) >= max) return fail("too many concurrent git operations on this drive, try again shortly");
  inflight.set(driveId, activeExecs(driveId) + 1);
  try {
    return await run();
  } finally {
    const n = activeExecs(driveId) - 1;
    if (n <= 0) inflight.delete(driveId); else inflight.set(driveId, n);
  }

  async function run(): Promise<RelayOutcome> {
    let bytesIn = 0, bytesOut = 0;
    let handle: GitExecHandle;
    let exitP!: Promise<GitExecExit>;
    let resolveExit!: (e: GitExecExit) => void;
    exitP = new Promise<GitExecExit>((r) => { resolveExit = r; });
    const stdoutQueue: Promise<void>[] = [];

    const handlers = {
      onStdout(buf: Buffer) {
        bytesOut += buf.length;
        // write() flushes in order; ack once the SSH stream took the bytes so
        // the agent's window tracks what the client actually drained.
        const p = new Promise<void>((done) => {
          let acked = false;
          const ack = () => { if (!acked) { acked = true; handle?.ack(buf.length); done(); } };
          // The callback fires once the SSH stream flushed the bytes (also under
          // backpressure), so the ack follows the client's real consumption.
          try { channel.write(buf, () => ack()); } catch { ack(); }
        });
        stdoutQueue.push(p);
      },
      onStderr(buf: Buffer) { try { channel.stderr.write(buf); } catch {} },
      onExit(e: GitExecExit) { resolveExit(e); },
    };

    const openOnce = () => open(driveId, { repo, service, protocol: opts.protocol }, handlers);
    try {
      try {
        handle = await openOnce();
      } catch (e) {
        const err = e as AgentError;
        // A push to a fresh path: create the repo (write-gated by the caller),
        // exactly as lib/git-http.ts does on a receive-pack to a missing repo.
        if (service === "receive-pack" && /not a git repository/i.test(err.message)) {
          await init(driveId, opts.driveSecret, repo);
          handle = await openOnce();
        } else throw e;
      }
    } catch (e) {
      const err = e as AgentError;
      if (err.status === 504 || /offline|timeout|disconnected/i.test(err.message)) return fail("the drive is offline");
      if (/not a git repository/i.test(err.message)) return fail("repository not found");
      return fail(err.message.replace(/\s+/g, " ").slice(0, 200));
    }

    // Client → git: stop reading the channel while the agent has a window's
    // worth of stdin unwritten; resume when it acks.
    channel.on("data", (buf) => { bytesIn += buf.length; if (!handle.write(buf)) channel.pause(); });
    handle.onDrain = () => { if (handle.inFlight() < handle.windowBytes / 2) channel.resume(); };
    channel.on("end", () => handle.end());
    const abort = () => { if (!handle.finished) handle.kill(); };
    channel.on("close", abort);
    channel.on("error", abort);

    const timer = setTimeout(() => {
      try { channel.stderr.write(`aindrive: git ${service} exceeded ${Math.round((opts.timeoutMs ?? GIT_SSH_EXEC_TIMEOUT_MS) / 1000)} s and was stopped\n`); } catch {}
      handle.kill();
    }, opts.timeoutMs ?? GIT_SSH_EXEC_TIMEOUT_MS);

    const exit = await exitP;
    clearTimeout(timer);
    // Every stdout byte reached the SSH stream before the exit status does.
    await Promise.all(stdoutQueue);
    const code = exit.error ? 1 : (exit.code ?? 1);
    if (exit.error) { try { channel.stderr.write(`aindrive: ${exit.error}\n`); } catch {} }
    try { channel.exit(code); } catch {}
    try { channel.end(); } catch {}
    try { channel.close(); } catch {}
    return { exit: code, bytesIn, bytesOut, ms: Date.now() - started, ...(exit.error ? { error: exit.error } : {}) };
  }
}

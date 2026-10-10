/**
 * Git over SSH for repos stored in drives:
 *
 *   git clone git@aindrive.ainetwork.ai:comcom/clef-artwork-search
 *   git push  git@aindrive.ainetwork.ai:comcom/clef-artwork-search main
 *
 * An ssh2 server (one process with the web server, lib/../ssh-server.ts) that:
 *   1. authenticates ONLY by public key for the user `git`: the offered key's
 *      SHA256 fingerprint is looked up at AIN SSO (lib/sso-ssh-keys.ts), the
 *      subject mapped to the linked aindrive account (lib/git-ssh/identity.ts),
 *      and the client's signature verified with ssh2 — password, keyboard-
 *      interactive, none and every other method are refused;
 *   2. accepts ONLY `git-upload-pack '<path>'` / `git-receive-pack '<path>'`
 *      (lib/git-ssh/command.ts) — no shell, pty, sftp, forwarding, subsystem;
 *   3. resolves `<org-slug>/<repo>` (lib/git-slug.ts resolveGitSlug) or
 *      `d/<driveId>/<repo>`, applies aindrive's drive gate for the key's user
 *      (gateDriveRoleForUser: upload → viewer, receive → editor — the same gate
 *      and the same checks as smart-HTTP and every fs/* route), then
 *   4. relays the channel to the drive agent's live git (lib/git-ssh/relay.ts).
 *
 * Refusals never reveal what exists: a missing org, drive or repo and a
 * forbidden repo all answer "repository not found" / "permission denied" on
 * stderr with exit 1, which git shows as `fatal: …`.
 */
// ssh2 is CommonJS: a default import is the one shape that works both bundled
// (esbuild, plain Node ESM at runtime) and under vitest.
import ssh2, { type Server, type Connection, type AuthContext, type Session, type ServerChannel, type ParsedKey } from "ssh2";
const { Server: SshServer, utils } = ssh2;
import { log as defaultLog } from "../logger.js";
import { resolveGitSlug } from "../git-slug";
import { gateDriveRoleForUser } from "../drive-gate";
import { minRoleFor, parseGitCommand, parseRepoTarget } from "./command";
import { resolveSshIdentity, type IdentityDeps, type SshIdentity } from "./identity";
import { relayGitExec, type RelayOpts } from "./relay";

export type Logger = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; debug?: (o: object, m: string) => void };

export type GitSshServerOpts = {
  hostKeys: (string | Buffer)[];
  identity: IdentityDeps;
  log?: Logger;
  /** Test seams. */
  resolveSlug?: (slug: string) => string | null;
  gate?: typeof gateDriveRoleForUser;
  relay?: (opts: RelayOpts) => Promise<unknown>;
  /** Per-connection idle/handshake limits. */
  authTimeoutMs?: number;
  /**
   * A receive-pack that exited 0: the ref updates the client sent (`head`), for
   * the ainize project hook (lib/git-project-hooks.ts notifyProjectOfPush — wired
   * by web/ssh-server.ts, so this module stays free of the web's imports).
   */
  onPushed?: (push: { driveId: string; driveSecret: string; repo: string; userId: string; head: Buffer }) => void;
};

export const SSH_USERNAME = "git";
const MAX_AUTH_ATTEMPTS = 6;
const AUTH_TIMEOUT_MS = 30_000;

type ConnState = { identity: SshIdentity | null; remote: string; attempts: number; protocol?: string };

export function createGitSshServer(opts: GitSshServerOpts): Server {
  const log = opts.log ?? defaultLog;
  const resolveSlug = opts.resolveSlug ?? resolveGitSlug;
  const gate = opts.gate ?? gateDriveRoleForUser;
  const relay = opts.relay ?? relayGitExec;

  const server: Server = new SshServer({ hostKeys: opts.hostKeys, ident: "SSH-2.0-aindrive" }, (client: Connection, info) => {
    const state: ConnState = { identity: null, remote: `${info.ip}:${info.port}`, attempts: 0 };
    let authed = false;
    const authTimer = setTimeout(() => { if (!authed) { log.warn({ remote: state.remote }, "[git-ssh] authentication timed out"); client.end(); } }, opts.authTimeoutMs ?? AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    client.on("authentication", (ctx: AuthContext) => {
      void authenticate(ctx, state, opts.identity, log).then((ok) => {
        if (ok) return; // accepted inside
        if (++state.attempts >= MAX_AUTH_ATTEMPTS) { try { ctx.reject([]); } catch {} client.end(); return; }
        try { ctx.reject(["publickey"]); } catch {}
      });
    });

    client.on("ready", () => {
      authed = true;
      clearTimeout(authTimer);
      log.info({ remote: state.remote, user: state.identity?.userId, subject: state.identity?.subject, fp: state.identity?.fingerprint }, "[git-ssh] authenticated");
    });

    client.on("session", (accept) => {
      const session: Session = accept();
      // The only environment a client may hand git: its protocol version.
      session.on("env", (acceptEnv, rejectEnv, envInfo) => {
        if (envInfo.key === "GIT_PROTOCOL" && /^version=\d$/.test(envInfo.val)) { state.protocol = envInfo.val; acceptEnv?.(); }
        else rejectEnv?.();
      });
      for (const ev of ["pty", "shell", "sftp", "x11", "auth-agent", "signal", "window-change"] as const) {
        session.on(ev as "pty", (_a: unknown, reject: (() => void) | undefined) => { try { reject?.(); } catch {} });
      }
      session.on("subsystem", (_a, reject) => { try { reject?.(); } catch {} });
      session.on("exec", (acceptExec, rejectExec, execInfo) => {
        const identity = state.identity;
        if (!identity) { try { rejectExec?.(); } catch {} client.end(); return; }
        const cmd = parseGitCommand(execInfo.command);
        if (!cmd) {
          log.warn({ remote: state.remote, user: identity.userId, command: String(execInfo.command).slice(0, 120) }, "[git-ssh] refused command");
          const ch = acceptExec?.();
          if (ch) refuse(ch, "only git-upload-pack and git-receive-pack are available here");
          else { try { rejectExec?.(); } catch {} }
          return;
        }
        const channel = acceptExec?.();
        if (!channel) return;
        void handleExec(channel, cmd.service, cmd.rawPath, identity, state).catch((e) => {
          log.warn({ remote: state.remote, err: (e as Error)?.message }, "[git-ssh] exec failed");
          refuse(channel, "internal error");
        });
      });
    });

    client.on("error", (e) => {
      // A client probing the port or closing mid-handshake is routine; log at debug.
      log.debug?.({ remote: state.remote, err: e?.message }, "[git-ssh] connection error");
    });
    client.on("close", () => clearTimeout(authTimer));
  });

  async function handleExec(channel: ServerChannel, service: "upload-pack" | "receive-pack", rawPath: string, identity: SshIdentity, state: ConnState) {
    const target = parseRepoTarget(rawPath);
    if (!target) return refuse(channel, "repository not found");
    const driveId = target.kind === "drive" ? target.driveId : resolveSlug(target.slug);
    if (!driveId) {
      log.info({ user: identity.userId, path: rawPath, service }, "[git-ssh] no drive for path");
      return refuse(channel, "repository not found");
    }
    const g = await gate(driveId, target.repo, { min: minRoleFor(service), userId: identity.userId });
    if ("denied" in g) {
      log.info({ user: identity.userId, drive: driveId, repo: target.repo, service, status: g.status }, "[git-ssh] gate refused");
      return refuse(channel, denialMessage(g.status, service));
    }
    const started = Date.now();
    const out = (await relay({
      driveId, driveSecret: g.drive.drive_secret, repo: target.repo, service, protocol: state.protocol, channel,
    })) as { exit: number; bytesIn: number; bytesOut: number; ms: number; error?: string; head?: Buffer } | undefined;
    if (service === "receive-pack" && out?.exit === 0 && out.head?.length && opts.onPushed) {
      try { opts.onPushed({ driveId, driveSecret: g.drive.drive_secret, repo: target.repo, userId: identity.userId, head: out.head }); } catch {}
    }
    log.info({
      user: identity.userId, subject: identity.subject, drive: driveId, repo: target.repo, svc: service,
      bytesIn: out?.bytesIn ?? 0, bytesOut: out?.bytesOut ?? 0, ms: out?.ms ?? Date.now() - started, exit: out?.exit ?? -1,
      ...(out?.error ? { error: out.error } : {}),
    }, "[git-ssh] exec");
  }

  return server;
}

function denialMessage(status: number, service: "upload-pack" | "receive-pack"): string {
  if (status === 404) return "repository not found";
  if (status === 402) return "payment required for this path";
  if (status === 400) return "invalid repository path";
  return service === "receive-pack" ? "permission denied (push needs editor access)" : "permission denied";
}

function refuse(channel: ServerChannel, msg: string) {
  try { channel.stderr.write(`aindrive: ${msg}\n`); } catch {}
  try { channel.exit(1); } catch {}
  try { channel.end(); } catch {}
  try { channel.close(); } catch {}
}

/**
 * One authentication round. ssh2 presents a public-key offer twice: first
 * without a signature (the client asks "would this key do?"), then signed. The
 * identity is resolved on both (cached ≤60 s in the directory), the signature
 * verified on the second with the key the client sent, and the connection
 * carries the identity from then on. Returns true when ctx was accepted.
 */
export async function authenticate(ctx: AuthContext, state: ConnState, identityDeps: IdentityDeps, log: Logger): Promise<boolean> {
  if (ctx.username !== SSH_USERNAME) {
    log.info({ remote: state.remote, username: String(ctx.username).slice(0, 64), method: ctx.method }, "[git-ssh] refused: username is not git");
    return false;
  }
  if (ctx.method !== "publickey") return false;
  const parsed = utils.parseKey(ctx.key.data);
  if (parsed instanceof Error || Array.isArray(parsed)) return false;
  const key = parsed as ParsedKey;
  if (key.type !== ctx.key.algo && !(key.type.startsWith("ssh-rsa") && ctx.key.algo.startsWith("rsa-sha2"))) return false;

  let result;
  try {
    result = await resolveSshIdentity(ctx.key.data, identityDeps);
  } catch (e) {
    log.warn({ remote: state.remote, err: (e as Error)?.message }, "[git-ssh] key lookup failed");
    return false;
  }
  if (!result.ok) {
    log.info({ remote: state.remote, reason: result.reason }, "[git-ssh] refused key");
    return false;
  }
  if (ctx.signature) {
    // The signed round: this accept IS the authentication, so the signature
    // over ssh2's session blob must verify with the offered key — no blob, no entry.
    if (!ctx.blob) return false;
    const ok = key.verify(ctx.blob, ctx.signature, ctx.hashAlgo);
    if (ok !== true) {
      log.warn({ remote: state.remote, user: result.identity.userId }, "[git-ssh] bad signature");
      return false;
    }
    state.identity = result.identity;
    ctx.accept();
    return true;
  }
  // Signature-less round: the key is acceptable — the client will now sign.
  // (ssh2 answers PK_OK here; nothing is authenticated yet.)
  ctx.accept();
  return true;
}

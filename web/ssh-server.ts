/**
 * Git over SSH — the process entry (lib/git-ssh/*). Started by server.js next
 * to the HTTP server, in the same container, so it shares the live agent
 * sockets (lib/agents.js pins its registry on globalThis) and the database.
 *
 *   AINDRIVE_SSH_PORT           TCP port inside the container (default 2222; 0 or "off" disables)
 *   AINDRIVE_SSH_HOST           bind address (default 0.0.0.0)
 *   AINDRIVE_SSH_HOST_KEY_PATH  OpenSSH Ed25519 private key; generated on first
 *                               start when missing (default <AINDRIVE_DATA_DIR>/ssh_host_ed25519_key)
 *   AINDRIVE_SSO_ISSUER / _CLIENT_ID / _CLIENT_SECRET
 *                               aindrive's AIN SSO app credentials — the key
 *                               directory (lib/sso-ssh-keys.ts) needs all three;
 *                               without them the SSH server does not start.
 *
 * The public host port 22 → container 2222 mapping is the operator's
 * (docs/DEPLOY.md "Git over SSH"); this process never binds 22 itself.
 *
 * server.js is plain Node, so this TypeScript entry is bundled by
 * scripts/build-ssh-server.mjs into .ssh-server/ssh-server.mjs (prebuild /
 * predev) and dynamically imported from there.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./lib/logger.js";
import { appCredentials } from "./lib/sso/config";
import { cachedSshKeyDirectory, createSsoSshKeyDirectory, type SshKeyDirectory } from "./lib/sso-ssh-keys";
import { loadOrCreateHostKey } from "./lib/git-ssh/host-key";
import { createGitSshServer } from "./lib/git-ssh/server";
import { notifyProjectOfPush } from "./lib/git-project-hooks";
import type { Server } from "ssh2";

export type StartOpts = {
  port?: number;
  host?: string;
  hostKeyPath?: string;
  /** Test seam: a fake key directory in place of AIN SSO. */
  directory?: SshKeyDirectory;
  issuer?: string;
};

export function sshPortFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = (env.AINDRIVE_SSH_PORT ?? "2222").trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export function defaultHostKeyPath(env: Record<string, string | undefined> = process.env): string {
  if (env.AINDRIVE_SSH_HOST_KEY_PATH) return env.AINDRIVE_SSH_HOST_KEY_PATH;
  return join(env.AINDRIVE_DATA_DIR || join(homedir(), ".aindrive"), "ssh_host_ed25519_key");
}

/** Start listening; resolves with the server (or null when disabled / unconfigured). Never throws on a bind error: it logs and resolves null, so the web server keeps running. */
export async function startGitSshServer(opts: StartOpts = {}): Promise<Server | null> {
  const port = opts.port ?? sshPortFromEnv();
  if (port === null) { log.info({}, "[git-ssh] disabled (AINDRIVE_SSH_PORT=0)"); return null; }

  let directory = opts.directory;
  let issuer = opts.issuer;
  if (!directory) {
    const creds = appCredentials();
    if (!creds) { log.warn({}, "[git-ssh] not started: AIN SSO app credentials (AINDRIVE_SSO_ISSUER, _CLIENT_ID, _CLIENT_SECRET) are not set"); return null; }
    directory = createSsoSshKeyDirectory(creds);
    issuer = creds.issuer;
  }
  // ≤60 s memo in front of whichever directory: an SSH sign-in offers the key
  // twice (probe, then signed), so one lookup per key per connection.
  directory = cachedSshKeyDirectory(directory);
  if (!issuer) throw new Error("startGitSshServer: issuer is required with a custom directory");

  const hostKey = loadOrCreateHostKey(opts.hostKeyPath ?? defaultHostKeyPath(), log);
  const server = createGitSshServer({
    hostKeys: [hostKey], identity: { directory, issuer }, log,
    // A push over SSH deploys like one over HTTP: auto-bind on ainize.json, then the project hook (fire-and-forget).
    onPushed: (p) => { void notifyProjectOfPush(p.driveId, p.repo, p.head, p.userId, fetch, { driveSecret: p.driveSecret }).catch(() => {}); },
  });
  const host = opts.host ?? process.env.AINDRIVE_SSH_HOST ?? "0.0.0.0";
  return new Promise((resolve) => {
    server.once("error", (e: Error) => {
      log.warn({ port, host, err: e.message }, "[git-ssh] could not listen — git over SSH is off for this process");
      resolve(null);
    });
    server.listen(port, host, () => {
      log.info({ port, host }, "[git-ssh] listening");
      resolve(server);
    });
  });
}

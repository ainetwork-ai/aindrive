/**
 * The SSH host key of the git-over-SSH server: an Ed25519 key in OpenSSH's
 * private-key format (what ssh2 parses; Node's PKCS#8 export for Ed25519 is not
 * accepted by ssh2's parser), generated on first start into the data dir with
 * mode 0600 and reused afterwards — a changed host key makes every client's
 * known_hosts entry fail, so it must survive restarts (docs/DEPLOY.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

function sshString(b: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}
const sshStr = (s: string) => sshString(Buffer.from(s, "utf8"));

/** The `ssh-ed25519 AAAA…` public line and the OpenSSH private key text for a Node Ed25519 key pair. */
export function toOpenSshEd25519(privateKey: KeyObject, comment = "aindrive-git-ssh"): { privatePem: string; publicLine: string } {
  const jwk = privateKey.export({ format: "jwk" }) as { x?: string; d?: string; crv?: string };
  if (jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) throw new Error("not an Ed25519 private key");
  const pub = Buffer.from(jwk.x, "base64url");
  const seed = Buffer.from(jwk.d, "base64url");
  const pubBlob = Buffer.concat([sshStr("ssh-ed25519"), sshString(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, sshStr("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshStr(comment)]);
  const padLen = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))]);
  const count = Buffer.alloc(4); count.writeUInt32BE(1, 0);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshStr("none"), sshStr("none"), sshString(Buffer.alloc(0)),
    count, sshString(pubBlob), sshString(priv),
  ]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  return {
    privatePem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicLine: `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`,
  };
}

export function generateHostKey(): { privatePem: string; publicLine: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  return toOpenSshEd25519(privateKey);
}

/** Read the host key at `path`, or create it (and `<path>.pub`) when missing. Returns the private key text. */
export function loadOrCreateHostKey(path: string, log?: { info: (o: object, m: string) => void }): string {
  if (existsSync(path)) return readFileSync(path, "utf8");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = generateHostKey();
  writeFileSync(path, key.privatePem, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  writeFileSync(`${path}.pub`, key.publicLine + "\n", { mode: 0o644 });
  log?.info({ path, publicKey: key.publicLine }, "[git-ssh] generated a new host key");
  return key.privatePem;
}

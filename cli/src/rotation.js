import { writeDriveConfig } from "./config.js";

/**
 * Live credential rotation, driven by the server over the signed RPC channel
 * (web/lib/agents.js rotateAgentLive). The server sends
 * { method: "rotate-credentials", agentToken, driveSecret }, signed with the
 * CURRENT secret. The agent:
 *
 *   1. persists the new pair AND the previous one (`previousCredentials`),
 *   2. answers ok, still signing with the old secret,
 *   3. switches to the new pair; the old secret keeps verifying requests for
 *      a short grace window (see GRACE_MS) so in-flight RPCs don't drop.
 *
 * The server stores the new pair only after the ok. If that ok is lost, the
 * agent's next handshake with the new token is refused (4401), and
 * revertRotation() falls back to `previousCredentials`, which the server still
 * holds. The drive stays pending server-side and is retried. A successful
 * handshake (the server's "hello") calls commitRotation() to drop the fallback.
 */

export const GRACE_MS = 60_000;
const MIN_CRED_LEN = 32;

/** Persist + adopt new credentials. Returns the previous secret for the grace window. */
export async function applyRotation({ root, drive, params }) {
  const { agentToken, driveSecret } = params ?? {};
  if (typeof agentToken !== "string" || agentToken.length < MIN_CRED_LEN
    || typeof driveSecret !== "string" || driveSecret.length < MIN_CRED_LEN) {
    throw new Error("invalid credentials");
  }
  const previous = { agentToken: drive.agentToken, driveSecret: drive.driveSecret };
  await writeDriveConfig(root, {
    ...drive, agentToken, driveSecret, rotatedAt: Date.now(), previousCredentials: previous,
  });
  return {
    previousSecret: previous.driveSecret,
    adopt() {
      drive.agentToken = agentToken;
      drive.driveSecret = driveSecret;
      drive.previousCredentials = previous;
    },
  };
}

/** Handshake refused after a rotation → go back to the pair the server still has. */
export async function revertRotation({ root, drive }) {
  const prev = drive.previousCredentials;
  if (!prev?.agentToken || !prev?.driveSecret) return false;
  drive.agentToken = prev.agentToken;
  drive.driveSecret = prev.driveSecret;
  delete drive.previousCredentials;
  await writeDriveConfig(root, drive);
  return true;
}

/** Server accepted the current token → the fallback pair is no longer needed. */
export async function commitRotation({ root, drive }) {
  if (!drive.previousCredentials) return false;
  delete drive.previousCredentials;
  await writeDriveConfig(root, drive);
  return true;
}

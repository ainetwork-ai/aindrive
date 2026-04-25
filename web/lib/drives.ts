import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { db } from "./db";
import { env } from "./env";
import { generateEd25519Keypair } from "./willow/meadowcap";

export type DriveRow = {
  id: string;
  owner_id: string;
  name: string;
  drive_secret: string;
  agent_token_hash: string;
  last_seen_at: string | null;
  created_at: string;
  namespace_pubkey: Buffer | null;
  namespace_secret: Buffer | null;
};

export async function createDrive(ownerId: string, name: string) {
  const driveId = nanoid(12);
  const agentToken = nanoid(48);
  const driveSecret = nanoid(48);
  const hash = await bcrypt.hash(agentToken, 10);
  const ns = await generateEd25519Keypair();
  db.prepare(
    "INSERT INTO drives (id, owner_id, name, agent_token_hash, drive_secret, namespace_pubkey, namespace_secret) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(driveId, ownerId, name, hash, driveSecret, Buffer.from(ns.publicKey), Buffer.from(ns.secretKey));
  const base = env.publicUrl.replace(/\/$/, "");
  return {
    driveId,
    agentToken,
    driveSecret,
    serverUrl: base,
    url: `${base}/d/${driveId}`,
  };
}

export async function rotateAgentToken(driveId: string) {
  const agentToken = nanoid(48);
  const driveSecret = nanoid(48);
  const hash = await bcrypt.hash(agentToken, 10);
  db.prepare(
    "UPDATE drives SET agent_token_hash = ?, drive_secret = ? WHERE id = ?"
  ).run(hash, driveSecret, driveId);
  return { agentToken, driveSecret };
}

export function getDrive(driveId: string): DriveRow | null {
  return (db.prepare("SELECT * FROM drives WHERE id = ?").get(driveId) as DriveRow) ?? null;
}

export function getDriveNamespace(driveId: string): { pub: Uint8Array; secret: Uint8Array } | null {
  const row = db.prepare("SELECT namespace_pubkey, namespace_secret FROM drives WHERE id = ?").get(driveId) as
    | { namespace_pubkey: Buffer | null; namespace_secret: Buffer | null }
    | undefined;
  if (!row?.namespace_pubkey || !row?.namespace_secret) return null;
  return { pub: new Uint8Array(row.namespace_pubkey), secret: new Uint8Array(row.namespace_secret) };
}

export function listUserDrives(userId: string): DriveRow[] {
  return db.prepare(`
    SELECT d.* FROM drives d
    LEFT JOIN drive_members m ON m.drive_id = d.id AND m.user_id = ?
    WHERE d.owner_id = ? OR m.user_id = ?
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all(userId, userId, userId) as DriveRow[];
}

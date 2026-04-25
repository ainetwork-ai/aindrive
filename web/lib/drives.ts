import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db, drizzleDb } from "./db";
import { drives } from "../drizzle/schema";
import { env } from "./env";
import { generateEd25519Keypair } from "./willow/meadowcap";

export type DriveRow = {
  id: string;
  owner_id: string;
  name: string;
  drive_secret: string;
  agent_token_hash: string;
  last_seen_at: string | null;
  last_hostname: string | null;
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
  drizzleDb.insert(drives).values({
    id: driveId,
    owner_id: ownerId,
    name,
    agent_token_hash: hash,
    drive_secret: driveSecret,
    namespace_pubkey: Buffer.from(ns.publicKey),
    namespace_secret: Buffer.from(ns.secretKey),
  }).run();
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
  drizzleDb
    .update(drives)
    .set({ agent_token_hash: hash, drive_secret: driveSecret })
    .where(eq(drives.id, driveId))
    .run();
  return { agentToken, driveSecret };
}

export function getDrive(driveId: string): DriveRow | null {
  const row = drizzleDb
    .select()
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  return (row as DriveRow) ?? null;
}

export function getDriveNamespace(driveId: string): { pub: Uint8Array; secret: Uint8Array } | null {
  const row = drizzleDb
    .select({ namespace_pubkey: drives.namespace_pubkey, namespace_secret: drives.namespace_secret })
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  if (!row?.namespace_pubkey || !row?.namespace_secret) return null;
  return {
    pub: new Uint8Array(row.namespace_pubkey as Buffer),
    secret: new Uint8Array(row.namespace_secret as Buffer),
  };
}

export function listUserDrives(userId: string): DriveRow[] {
  // GROUP BY + LEFT JOIN: raw SQL is cleaner than drizzle for this query
  return db.prepare(`
    SELECT d.* FROM drives d
    LEFT JOIN drive_members m ON m.drive_id = d.id AND m.user_id = ?
    WHERE d.owner_id = ? OR m.user_id = ?
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `).all(userId, userId, userId) as DriveRow[];
}

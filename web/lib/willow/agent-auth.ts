// A drive's own agent on Willow sync (plan 3): it authenticates with its agent
// token, the same bearer check as the RPC socket (lib/agents.js onAgentConnect),
// and acts as a device of the drive's owner.
import bcrypt from "bcryptjs";
import { db } from "@/lib/db.js";

export async function agentUser(driveId: string, authorization: string | undefined): Promise<string | null> {
  if (!driveId || !authorization?.startsWith("Bearer ")) return null;
  const row = db.prepare("SELECT agent_token_hash, owner_id FROM drives WHERE id = ?").get(driveId) as { agent_token_hash: string; owner_id: string } | undefined;
  if (!row) return null;
  return (await bcrypt.compare(authorization.slice(7), row.agent_token_hash)) ? row.owner_id : null;
}

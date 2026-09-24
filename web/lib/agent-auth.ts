/**
 * One bearer → SkillCtx resolver for every agent protocol surface (A2A,
 * AG-UI; MCP keeps its own route because it must answer with RFC 9728
 * WWW-Authenticate). Accepts, in order:
 *
 *   aind_pat_… / aind_oat_…   drive token (PAT or OAuth) → pinned to its drive,
 *                             scope read|write (lib/mcp-tokens)
 *   aind_aat_…                account grant with `drives:read` → read-only,
 *                             any drive the user belongs to (lib/account-tokens)
 *   session JWT / cookie      legacy first-party auth → full account access
 *
 * The scope is a ceiling only: runSkill re-resolves the user's live role on
 * every call (shared/agent-skills.ts).
 */
import { cookies } from "next/headers";
import { verify } from "./session";
import { maxRoleInDrive, verifyMcpToken } from "./mcp-tokens";
import { ACCOUNT_ACCESS_PREFIX, verifyAccountToken } from "./account-tokens";
import type { SkillCtx } from "@/shared/agent-skills";

export type AgentAuth =
  | { ok: true; ctx: SkillCtx }
  | { ok: false; status: 401 | 403; error: string };

function bearerOf(req: Request): string | null {
  const m = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * @param pinDriveId  set on drive-scoped routes (`/agui/d/[driveId]`): the
 *                    token must be usable on that drive, and the ctx is pinned to it.
 */
export async function resolveAgentAuth(req: Request, pinDriveId?: string): Promise<AgentAuth> {
  const bearer = bearerOf(req);

  if (bearer?.startsWith("aind_pat_") || bearer?.startsWith("aind_oat_")) {
    const t = verifyMcpToken(bearer);
    if (!t) return { ok: false, status: 401, error: "token is invalid, expired or revoked" };
    if (pinDriveId && t.driveId !== pinDriveId) return { ok: false, status: 403, error: "token is bound to a different drive" };
    return { ok: true, ctx: { userId: t.userId, driveId: t.driveId, scope: t.scope } };
  }

  if (bearer?.startsWith(ACCOUNT_ACCESS_PREFIX)) {
    const t = verifyAccountToken(bearer);
    if (!t) return { ok: false, status: 401, error: "token is invalid, expired or revoked" };
    if (!t.scopes.includes("drives:read")) return { ok: false, status: 403, error: "token lacks the drives:read scope" };
    if (pinDriveId && maxRoleInDrive(pinDriveId, t.userId) === "none") {
      return { ok: false, status: 403, error: "the account has no access to this drive" };
    }
    return { ok: true, ctx: { userId: t.userId, scope: "read", ...(pinDriveId ? { driveId: pinDriveId } : {}) } };
  }

  const jwt = bearer ?? (await cookies()).get("aindrive_session")?.value ?? null;
  const userId = jwt ? await verify(jwt) : null;
  if (!userId) return { ok: false, status: 401, error: "missing or invalid bearer token" };
  if (pinDriveId && maxRoleInDrive(pinDriveId, userId) === "none") {
    return { ok: false, status: 403, error: "no access to this drive" };
  }
  return { ok: true, ctx: { userId, ...(pinDriveId ? { driveId: pinDriveId } : {}) } };
}

/**
 * One bearer → SkillCtx resolver for every agent protocol surface (A2A,
 * AG-UI; MCP keeps its own route because it must answer with RFC 9728
 * WWW-Authenticate). Accepts, in order:
 *
 *   aind_pat_… / aind_oat_…   drive token (PAT or OAuth) → pinned to its drive,
 *                             scope read|write (lib/mcp-tokens)
 *   aind_aat_…                account grant: `drives:read` / `drives:write` →
 *                             any drive the user belongs to (lib/account-tokens);
 *                             `drives:sell` tools stay on the MCP endpoint
 *   session JWT (as bearer)   legacy first-party auth → full account access
 *
 * Bearer only — the session COOKIE is deliberately not accepted: these
 * endpoints answer CORS `*` and parse bodies regardless of Content-Type, so a
 * cookie credential would allow blind same-site request forgery.
 *
 * The scope is a ceiling only: runSkill re-resolves the user's live role on
 * every call (shared/agent-skills.ts).
 */
import { verify } from "./session";
import { maxRoleInDrive, verifyMcpToken } from "./mcp-tokens";
import { ACCOUNT_ACCESS_PREFIX, verifyAccountToken } from "./account-tokens";
import type { SkillCtx } from "@/shared/agent-skills";
import { isSaleSkill, isSkillName, skillGroup } from "@/shared/skill-descriptors";

type Group = "read" | "write";
export type AgentAuth =
  | { ok: true; ctx: SkillCtx; groups: readonly Group[] }
  | { ok: false; status: 401 | 403; error: string };

const ALL: readonly Group[] = ["read", "write"];

/**
 * Can this grant run `skill` at all? Mirrors the MCP route's per-group tool
 * filter for account tokens (drives:read → read skills, drives:write → write
 * skills). Sale tools are drive-scoped MCP tools only. The role/scope checks
 * inside runSkill still apply on top.
 */
export function skillPermitted(auth: Extract<AgentAuth, { ok: true }>, skill: string): string | null {
  if (!isSkillName(skill)) return `unknown skill: ${skill}`;
  if (isSaleSkill(skill)) return "sale tools are only available on the drive MCP endpoint (/mcp/d/<id>) with a drives:sell grant";
  const g = skillGroup(skill);
  return (auth.groups as readonly string[]).includes(g) ? null : `this token has no ${g === "write" ? "drives:write" : "drives:read"} scope`;
}

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
    return { ok: true, ctx: { userId: t.userId, driveId: t.driveId, scope: t.scope }, groups: ALL };
  }

  if (bearer?.startsWith(ACCOUNT_ACCESS_PREFIX)) {
    const t = verifyAccountToken(bearer);
    if (!t) return { ok: false, status: 401, error: "token is invalid, expired or revoked" };
    const groups = ALL.filter((g) => t.scopes.includes(`drives:${g}` as never));
    if (!groups.length) return { ok: false, status: 403, error: "token lacks a drives:read or drives:write scope" };
    if (pinDriveId && maxRoleInDrive(pinDriveId, t.userId) === "none") {
      return { ok: false, status: 403, error: "the account has no access to this drive" };
    }
    const scope = groups.includes("write") ? "write" : "read";
    return { ok: true, ctx: { userId: t.userId, scope, ...(pinDriveId ? { driveId: pinDriveId } : {}) }, groups };
  }

  const userId = bearer ? await verify(bearer) : null;
  if (!userId) return { ok: false, status: 401, error: "missing or invalid bearer token" };
  if (pinDriveId && maxRoleInDrive(pinDriveId, userId) === "none") {
    return { ok: false, status: 403, error: "no access to this drive" };
  }
  return { ok: true, ctx: { userId, ...(pinDriveId ? { driveId: pinDriveId } : {}) }, groups: ALL };
}

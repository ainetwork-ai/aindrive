/**
 * Server side of AINUI (docs/AINUI.md): wires the pure builders and the action
 * dispatcher in shared/a2ui/ainui.ts to runSkill, the transport's allow-list,
 * the caller's live role and lib/mime.
 *
 *   ainuiSurface(host, skill, args, result)   surface for a skill the caller already ran
 *   ainuiAction(host, action)                 run an AINUI action (maybe several skills)
 *
 * `host.allowed` is the transport's own allow-list for direct calls — the MCP
 * tools list for the token, or skillPermitted() for A2A / AG-UI grants — so an
 * action can never reach a skill the caller couldn't call itself; runSkill's
 * checks (scope, drive pin, live role, paid carve-out, system paths) apply to
 * every step on top.
 */
import { runSkill, type SkillCtx, type SkillResult } from "@/shared/agent-skills";
import type { A2uiAction, A2uiMessage } from "@/shared/a2ui";
import { ainuiForSkill, dispatchAinuiAction, type AinuiEnv, type AinuiReply } from "@/shared/a2ui/ainui";
import { atLeast, resolveAccess } from "./access";
import { getDrive } from "./drives";
import { classifyKind, lookupMime } from "./mime";
import { normalizePath } from "./path";

export type AinuiHost = { ctx: SkillCtx; allowed: (skill: string) => boolean };

const LOOKUPS: Pick<AinuiEnv, "mimeOf" | "isText"> = {
  mimeOf: lookupMime,
  isText: (path) => classifyKind(path).kind === "text",
};

/**
 * What the caller may do at `path`: write/delete buttons appear only when the
 * skill is on the allow-list, the token scope isn't read-only and the live role
 * is editor+ (runSkill re-checks all of it when the button is pressed).
 */
export async function ainuiEnv(host: AinuiHost, driveId: string, path: string): Promise<AinuiEnv> {
  const { ctx } = host;
  if (!driveId || (ctx.driveId && ctx.driveId !== driveId)) return { ...LOOKUPS };
  const drive = getDrive(driveId);
  if (!drive) return { ...LOOKUPS };
  let editor = false;
  if (ctx.scope !== "read") {
    try { editor = atLeast(await resolveAccess(driveId, normalizePath(path), ctx.userId), "editor"); }
    catch { editor = false; }
  }
  return {
    ...LOOKUPS,
    rootLabel: drive.name,
    canWrite: editor && host.allowed("write_file"),
    canDelete: editor && host.allowed("delete_path"),
  };
}

/** AINUI surface for a skill the caller ran directly (tools/call, AG-UI skill, A2A DataPart). */
export async function ainuiSurface(
  host: AinuiHost, skill: string, args: Record<string, unknown>, result: SkillResult,
): Promise<A2uiMessage[]> {
  const driveId = (typeof args.drive_id === "string" && args.drive_id) || host.ctx.driveId || "";
  const path = typeof args.path === "string" ? args.path.replace(/^\/+|\/+$/g, "") : "";
  const env = result.kind === "ok" ? await ainuiEnv(host, driveId, path) : LOOKUPS;
  return ainuiForSkill(skill, args, result, host.ctx.driveId, env);
}

/** Answer an AINUI action as the caller. */
export function ainuiAction(host: AinuiHost, action: A2uiAction): Promise<AinuiReply> {
  return dispatchAinuiAction(action, {
    run: (skill, args) => runSkill(host.ctx, skill, args),
    allowed: host.allowed,
    env: (driveId, path) => ainuiEnv(host, driveId, path),
    driveId: host.ctx.driveId,
  });
}

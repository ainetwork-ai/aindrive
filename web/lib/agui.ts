/**
 * AG-UI (Agent–User Interaction protocol, https://docs.ag-ui.com, v1.0) agent
 * for aindrive: `POST RunAgentInput` → a stream of AG-UI events (SSE, or
 * protobuf when `Accept: application/vnd.ag-ui.event+proto`). Served at
 * /agui (account-wide) and /agui/d/[driveId] (pinned to one drive).
 *
 * The agent is deterministic (no LLM): each run executes ONE skill, chosen by
 *   1. forwardedProps.a2uiAction  — an A2UI click (CopilotKit's shape: {userAction})
 *   2. forwardedProps.skill (+ forwardedProps.args) — an explicit call
 *   3. the last user message — command grammar (`ls`, `cat`, `find`, `drives`;
 *      anything else = filename search), shared/a2ui commandToSkill
 * and reports it as standard events: TOOL_CALL_* for the skill, an A2UI
 * surface as ACTIVITY_SNAPSHOT (activityType "a2ui-surface", the
 * @ag-ui/a2ui-middleware / CopilotKit shape), STATE_SNAPSHOT {driveId, path,
 * skill}, and an assistant TEXT_MESSAGE summary. Guide: /docs/ag-ui.
 */
import { EventType, contentToText, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { runSkill, isSkillName, type SkillCtx } from "@/shared/agent-skills";
import {
  AGUI_A2UI_ACTIVITY, AGUI_A2UI_OPERATIONS_KEY, a2uiForSkill, actionToSkill, commandToSkill, parseA2uiAction,
  type SkillCall,
} from "@/shared/a2ui";

export function planRun(input: RunAgentInput, ctx: SkillCtx): SkillCall | { error: string } {
  const fp = (input.forwardedProps ?? {}) as Record<string, unknown>;
  const action = fp.a2uiAction ? parseA2uiAction(fp.a2uiAction) : null;
  if (action) {
    const state = (input.state ?? {}) as Record<string, unknown>;
    return actionToSkill(action, ctx.driveId ?? (typeof state.driveId === "string" ? state.driveId : undefined));
  }
  if (typeof fp.skill === "string") {
    if (!isSkillName(fp.skill)) return { error: `unknown skill: ${fp.skill}` };
    const args = fp.args && typeof fp.args === "object" ? fp.args as Record<string, unknown> : {};
    return { skill: fp.skill, args };
  }
  const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user") as
    | { content?: unknown } | undefined;
  const text = lastUser ? contentToText(lastUser.content as Parameters<typeof contentToText>[0]) : "";
  const state = (input.state ?? {}) as Record<string, unknown>;
  const driveId = ctx.driveId ?? (typeof state.driveId === "string" ? state.driveId : undefined);
  return commandToSkill(text, driveId);
}

export async function* runEvents(input: RunAgentInput, ctx: SkillCtx): AsyncGenerator<BaseEvent> {
  const { threadId, runId } = input;
  yield { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;

  const call = planRun(input, ctx);
  if ("error" in call) {
    yield { type: EventType.RUN_ERROR, message: call.error, code: "bad_request" } as BaseEvent;
    return;
  }
  const { skill, args } = call;
  const toolCallId = `call_${runId}`;

  yield { type: EventType.STEP_STARTED, stepName: skill } as BaseEvent;
  yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: skill } as BaseEvent;
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) } as BaseEvent;
  yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;

  const result = await runSkill(ctx, skill, args);
  const content = result.kind === "ok"
    ? JSON.stringify(result.structured ?? {})
    : JSON.stringify({ error: { code: result.code, message: result.message } });
  yield { type: EventType.TOOL_CALL_RESULT, messageId: `tool_${runId}`, toolCallId, content, role: "tool" } as BaseEvent;

  const driveId = (typeof args.drive_id === "string" && args.drive_id) || ctx.driveId;
  yield {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: `a2ui-surface-${toolCallId}`,
    activityType: AGUI_A2UI_ACTIVITY,
    content: { [AGUI_A2UI_OPERATIONS_KEY]: a2uiForSkill(skill, args, result, driveId) },
    replace: true,
  } as BaseEvent;

  yield {
    type: EventType.STATE_SNAPSHOT,
    snapshot: {
      ...((input.state ?? {}) as Record<string, unknown>),
      driveId: driveId ?? null,
      path: typeof args.path === "string" ? args.path : "",
      skill,
      ok: result.kind === "ok",
    },
  } as BaseEvent;

  const messageId = `msg_${runId}`;
  const summary = result.kind === "ok" ? result.text : `[${result.code}] ${result.message}`;
  yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent;
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: summary || "(no output)" } as BaseEvent;
  yield { type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent;
  yield { type: EventType.STEP_FINISHED, stepName: skill } as BaseEvent;
  yield { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export const AGUI_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

/** GET: a small self-description so integrators (and humans) can discover the contract. */
export function aguiInfo(driveId?: string) {
  return Response.json({
    name: "aindrive",
    protocol: "ag-ui",
    protocolVersion: "1.0",
    description: "Deterministic file agent: one skill per run, reported as TOOL_CALL_* + an A2UI surface (ACTIVITY_SNAPSHOT a2ui-surface).",
    ...(driveId ? { driveId } : {}),
    input: {
      "forwardedProps.a2uiAction": "an A2UI action ({userAction} or a v0.9 action) from a rendered surface",
      "forwardedProps.skill + forwardedProps.args": "run a skill directly (see /.well-known/agent-card.json skills)",
      "messages[last user]": "`drives`, `ls <path>`, `cat <path>`, `stat <path>`, `find <query>`; other text = filename search",
    },
    auth: "Authorization: Bearer <MCP token | OAuth access token>",
    docs: "/docs/ag-ui",
  }, { headers: AGUI_CORS });
}

export async function serveAgui(req: Request, pinDriveId?: string): Promise<Response> {
  const { RunAgentInputSchema } = await import("@ag-ui/core/schemas");
  const { EventEncoder } = await import("@ag-ui/encoder");
  const { resolveAgentAuth } = await import("./agent-auth");

  const auth = await resolveAgentAuth(req, pinDriveId);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, {
      status: auth.status,
      headers: { ...AGUI_CORS, ...(auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="aindrive"' } : {}) },
    });
  }
  const parsed = RunAgentInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid RunAgentInput", issues: parsed.error.issues }, { status: 400, headers: AGUI_CORS });
  }

  const encoder = new EventEncoder({ accept: req.headers.get("accept") ?? undefined });
  const binary = encoder.getContentType() !== "text/event-stream";
  const events = runEvents(parsed.data as RunAgentInput, auth.ctx);
  const te = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) { controller.close(); return; }
        controller.enqueue(binary ? encoder.encodeBinary(value) : te.encode(encoder.encode(value)));
      } catch (e) {
        const err = { type: EventType.RUN_ERROR, message: (e as Error).message || "internal error", code: "internal" } as BaseEvent;
        controller.enqueue(binary ? encoder.encodeBinary(err) : te.encode(encoder.encode(err)));
        controller.close();
      }
    },
    cancel() { void events.return(undefined); },
  });
  return new Response(stream, {
    headers: { ...AGUI_CORS, "Content-Type": encoder.getContentType(), "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}

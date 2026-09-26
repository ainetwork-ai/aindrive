/**
 * The aindrive-as-a-whole A2A agent: card data + executor.
 *
 * Single root agent (A2A v0.3, @a2a-js/sdk). Card at
 * /.well-known/agent-card.json, JSON-RPC at /a2a (message/send and
 * message/stream). Skills are shared/agent-skills; a message asks for one as
 *
 *   DataPart {skill: "<id>", ...args}          explicit call
 *   DataPart A2UI action (v0.9 client event)   a click on a rendered surface
 *   TextPart "ls docs" / "cat a.md" / "find q"  command grammar (shared/a2ui)
 *
 * Replies: TextPart summary + DataPart structured result, plus — when the
 * client activates the A2UI extension (X-A2A-Extensions or
 * metadata.a2uiRendererCapabilities) or sent an A2UI action — a DataPart of
 * A2UI messages (metadata.mimeType application/a2ui+json). See /docs/a2a.
 *
 * AINUI (docs/AINUI.md): message `metadata.ainui = true` → the DataPart carries
 * an AINUI surface, and an A2UI action runs through the AINUI dispatcher
 * (lib/ainui.ts; write actions, multi-step replies) under the same grant checks.
 */

import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
  User,
} from "@a2a-js/sdk/server";
import type { AgentCard, Message, Part } from "@a2a-js/sdk";
import { env } from "./env";
import { skillPermitted, type AgentAuth } from "./agent-auth";
import { runSkill, SKILL_DESCRIPTORS, isSkillName, type SkillCtx } from "@/shared/agent-skills";
import {
  A2UI_A2A_EXTENSION, A2UI_BASIC_CATALOG, A2UI_MIME, a2uiForSkill, actionToSkill, commandToSkill, parseA2uiAction,
  type A2uiAction, type A2uiMessage, type SkillCall,
} from "@/shared/a2ui";
import { AINUI_CATALOG, type AinuiStep } from "@/shared/a2ui/ainui";
import { ainuiAction, ainuiSurface, type AinuiHost } from "./ainui";

/** A `User` carrying the resolved grant (lib/agent-auth). */
export class AindriveUser implements User {
  constructor(readonly auth: Extract<AgentAuth, { ok: true }>) {}
  get ctx(): SkillCtx { return this.auth.ctx; }
  get isAuthenticated() { return true; }
  get userName() { return this.ctx.userId; }
}

export function aindriveAgentCard(): AgentCard {
  const base = env.publicUrl.replace(/\/$/, "");
  return {
    name: "aindrive",
    description:
      "Shared-drive agent: list, read, search, write and delete files in aindrive drives. " +
      "Send a DataPart {skill, ...args} (see skills), an A2UI action, or a text command " +
      "(`drives`, `ls <path>`, `cat <path>`, `find <query>`). Activate the A2UI extension " +
      "to receive ready-to-render UI surfaces.",
    version: "0.2.0",
    protocolVersion: "0.3.0",
    url: `${base}/a2a`,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [{
        uri: A2UI_A2A_EXTENSION,
        description:
          "Replies include A2UI v0.9 surfaces (basic catalog) as application/a2ui+json DataParts. " +
          "Send message metadata.ainui = true for AINUI surfaces (the AINUI catalog: basic + grid, tiles, file viewer, write actions).",
        required: false,
        params: { supportedCatalogIds: [A2UI_BASIC_CATALOG, AINUI_CATALOG] },
      }],
    },
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
        description: "aindrive MCP token (aind_pat_…), OAuth access token (aind_oat_… / aind_aat_…). See /docs/auth.",
      },
      oauth: {
        type: "oauth2",
        oauth2MetadataUrl: `${base}/.well-known/oauth-authorization-server`,
        flows: {
          authorizationCode: {
            authorizationUrl: `${base}/oauth/authorize`,
            tokenUrl: `${base}/api/oauth/token`,
            refreshUrl: `${base}/api/oauth/token`,
            scopes: {
              "drives:read": "Read every drive you belong to",
              profile: "Your name and email",
              "drive:read": "Read one drive (resource = its MCP URL)",
              "drive:write": "Write one drive (resource = its MCP URL)",
            },
          },
        },
      },
    },
    security: [{ bearer: [] }, { oauth: ["drives:read"] }],
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain", A2UI_MIME],
    iconUrl: `${base}/icon.png`,
    provider: { organization: "aindrive", url: base },
    documentationUrl: `${base}/docs/a2a`,
    skills: SKILL_DESCRIPTORS.map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
      tags: ["filesystem"],
      inputModes: ["application/json", "text/plain"],
      outputModes: ["application/json", "text/plain", A2UI_MIME],
    })),
  };
}

type DataPart = { kind: "data"; data: Record<string, unknown> | unknown[]; metadata?: Record<string, unknown> };

/** Work out which skill a message asks for, and whether it came from an A2UI surface. */
export function interpretMessage(message: Message, ctx: SkillCtx): { call: SkillCall; fromA2ui: boolean } | { error: string } {
  const parts = (message.parts ?? []) as Part[];
  for (const p of parts) {
    if (p.kind !== "data") continue;
    const d = (p as DataPart).data as Record<string, unknown>;
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    if (typeof d.skill === "string") {
      if (!isSkillName(d.skill)) return { error: `unknown skill: ${d.skill}` };
      const { skill, ...args } = d;
      return { call: { skill: skill as string, args }, fromA2ui: false };
    }
    const action = parseA2uiAction(d);
    if (action) {
      const mapped = actionToSkill(action, ctx.driveId);
      if ("error" in mapped) return mapped;
      return { call: mapped, fromA2ui: true };
    }
  }
  const text = parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join(" ").trim();
  if (text) return { call: commandToSkill(text, ctx.driveId), fromA2ui: false };
  return { error: "send a DataPart {skill, ...args}, an A2UI action, or a text command — see the agent card" };
}

/** The A2UI action a message carries, if its first skill-or-action DataPart is an action (as interpretMessage). */
export function actionInMessage(message: Message): A2uiAction | null {
  for (const p of (message.parts ?? []) as Part[]) {
    if (p.kind !== "data") continue;
    const d = (p as DataPart).data as Record<string, unknown>;
    if (!d || typeof d !== "object" || Array.isArray(d)) continue;
    if (typeof d.skill === "string") return null;
    const action = parseA2uiAction(d);
    if (action) return action;
  }
  return null;
}

export class AindriveExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const user = requestContext.context?.user;
    const auth = user instanceof AindriveUser ? user.auth : null;
    const ctx = auth?.ctx ?? null;
    const message = requestContext.userMessage as Message | undefined;
    const contextId = requestContext.contextId;
    const msgId = randomMessageId();
    const done = (m: Message) => { eventBus.publish(m); eventBus.finished(); };

    if (!ctx) return done(errMessage(msgId, contextId, "unauthorized — missing or invalid bearer token"));
    if (!message || !Array.isArray(message.parts)) return done(errMessage(msgId, contextId, "message.parts required"));

    if ((message.metadata as Record<string, unknown> | undefined)?.ainui === true) {
      return this.executeAinui(auth!, message, requestContext, msgId, done);
    }

    const interpreted = interpretMessage(message, ctx);
    if ("error" in interpreted) return done(errMessage(msgId, contextId, interpreted.error));
    const { call, fromA2ui } = interpreted;
    const denied = skillPermitted(auth!, call.skill);
    if (denied) return done(errMessage(msgId, contextId, `[forbidden] ${denied}`));

    const result = await runSkill(ctx, call.skill, call.args);

    const call_ = requestContext.context;
    const wantsA2ui = fromA2ui
      || !!call_?.requestedExtensions?.includes(A2UI_A2A_EXTENSION)
      || !!(message.metadata as Record<string, unknown> | undefined)?.a2uiRendererCapabilities;
    const a2uiPart: Part[] = [];
    if (wantsA2ui) {
      call_?.addActivatedExtension(A2UI_A2A_EXTENSION);
      a2uiPart.push({
        kind: "data",
        data: a2uiForSkill(call.skill, call.args, result, ctx.driveId) as unknown as Record<string, unknown>,
        metadata: { mimeType: A2UI_MIME },
      } as Part);
    }

    if (result.kind === "err") {
      const m = errMessage(msgId, contextId, `[${result.code}] ${result.message}`);
      m.parts.push(...a2uiPart);
      return done(m);
    }
    done({
      kind: "message",
      role: "agent",
      messageId: msgId,
      contextId,
      parts: [
        { kind: "text", text: result.text },
        { kind: "data", data: (result.structured ?? {}) as Record<string, unknown> },
        ...a2uiPart,
      ],
    });
  }

  /** AINUI reply: always carries the (AINUI) surface; actions go through the AINUI dispatcher. */
  private async executeAinui(
    auth: Extract<AgentAuth, { ok: true }>,
    message: Message,
    requestContext: RequestContext,
    msgId: string,
    done: (m: Message) => void,
  ): Promise<void> {
    const ctx = auth.ctx;
    const contextId = requestContext.contextId;
    const host: AinuiHost = { ctx, allowed: (skill) => skillPermitted(auth, skill) === null };
    let final: AinuiStep;
    let surface: A2uiMessage[];
    const action = actionInMessage(message);
    if (action) {
      const reply = await ainuiAction(host, action);
      if (reply.kind === "invalid") return done(errMessage(msgId, contextId, reply.error));
      if (reply.kind === "refused") {
        return done(errMessage(msgId, contextId, `[forbidden] ${skillPermitted(auth, reply.skill) ?? reply.skill}`));
      }
      ({ final, surface } = reply);
    } else {
      const interpreted = interpretMessage(message, ctx);
      if ("error" in interpreted) return done(errMessage(msgId, contextId, interpreted.error));
      const { call } = interpreted;
      const denied = skillPermitted(auth, call.skill);
      if (denied) return done(errMessage(msgId, contextId, `[forbidden] ${denied}`));
      final = { ...call, result: await runSkill(ctx, call.skill, call.args) };
      surface = await ainuiSurface(host, call.skill, call.args, final.result);
    }

    requestContext.context?.addActivatedExtension(A2UI_A2A_EXTENSION);
    const a2uiPart = { kind: "data", data: surface as unknown as Record<string, unknown>, metadata: { mimeType: A2UI_MIME } } as Part;
    const result = final.result;
    if (result.kind === "err") {
      const m = errMessage(msgId, contextId, `[${result.code}] ${result.message}`);
      m.parts.push(a2uiPart);
      return done(m);
    }
    done({
      kind: "message",
      role: "agent",
      messageId: msgId,
      contextId,
      parts: [
        { kind: "text", text: result.text },
        { kind: "data", data: (result.structured ?? {}) as Record<string, unknown> },
        a2uiPart,
      ],
    });
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }
}

function errMessage(messageId: string, contextId: string | undefined, text: string): Message {
  return {
    kind: "message",
    role: "agent",
    messageId,
    contextId,
    parts: [{ kind: "text", text }],
    metadata: { error: true },
  };
}

function randomMessageId(): string {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36)
  );
}

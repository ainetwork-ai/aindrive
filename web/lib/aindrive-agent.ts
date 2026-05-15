/**
 * The aindrive-as-a-whole A2A agent: card data + executor.
 *
 * Single root agent. Skills take `drive_id` as an argument so external
 * callers can address any drive the authenticated owner has access to,
 * without aindrive maintaining one A2A identity per drive.
 *
 * Wire format follows the @a2a-js/sdk types so we stay aligned with
 * A2A v0.3.0. Card lives at /.well-known/agent-card.json (root).
 * JSON-RPC endpoint lives at /a2a.
 */

import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
  User,
} from "@a2a-js/sdk/server";
import type { AgentCard, Message } from "@a2a-js/sdk";

/** A `User` implementation backed by our session JWT. */
export class AindriveUser implements User {
  constructor(private readonly _userId: string) {}
  get isAuthenticated() { return true; }
  get userName() { return this._userId; }
}
import { env } from "./env";
import { runSkill, SKILL_DESCRIPTORS, isSkillName } from "@/shared/agent-skills";

export function aindriveAgentCard(): AgentCard {
  const base = env.publicUrl.replace(/\/$/, "");
  return {
    name: "aindrive",
    description:
      "Filesystem A2A agent for aindrive drives. Each skill takes `drive_id` " +
      "to address a specific drive the authenticated owner has access to. " +
      "Include a DataPart {skill:'<id>', ...args} in the message — v1 doesn't " +
      "parse free-text TextParts.",
    version: "0.1.0",
    protocolVersion: "0.3.0",
    url: `${base}/a2a`,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    iconUrl: `${base}/icon.png`,
    provider: { organization: "aindrive", url: base },
    documentationUrl: `${base}/`,
    skills: SKILL_DESCRIPTORS.map((s) => ({
      id: s.name,
      name: s.name,
      description: s.description,
      tags: ["filesystem"],
      inputModes: ["application/json"],
      outputModes: ["application/json", "text/plain"],
    })),
  };
}

/**
 * Pulls the DataPart out of an inbound A2A message and runs the named skill.
 * Reads the authenticated userId from `ServerCallContext` set by the route
 * adapter (route.ts on /a2a verifies the JWT before constructing the context).
 */
export class AindriveExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const user = requestContext.context?.user;
    const userId = user?.isAuthenticated ? user.userName : "";
    const message = requestContext.userMessage as Message | undefined;
    const contextId = requestContext.contextId;
    const msgId = randomMessageId();

    if (!userId) {
      eventBus.publish(errMessage(msgId, contextId, "unauthorized — missing or invalid bearer/session"));
      eventBus.finished();
      return;
    }
    if (!message || !Array.isArray(message.parts)) {
      eventBus.publish(errMessage(msgId, contextId, "message.parts required"));
      eventBus.finished();
      return;
    }

    const dataPart = message.parts.find(
      (p) => p && (p as { kind?: string }).kind === "data",
    ) as { kind: "data"; data: Record<string, unknown> } | undefined;
    if (!dataPart || !dataPart.data) {
      eventBus.publish(errMessage(
        msgId,
        contextId,
        "v1 requires a DataPart of the form {skill, ...args}; see card.skills for schemas.",
      ));
      eventBus.finished();
      return;
    }

    const skillName = typeof dataPart.data.skill === "string" ? dataPart.data.skill : "";
    if (!isSkillName(skillName)) {
      eventBus.publish(errMessage(msgId, contextId, `unknown skill: ${skillName}`));
      eventBus.finished();
      return;
    }

    const result = await runSkill({ userId }, skillName, dataPart.data);

    if (result.kind === "err") {
      eventBus.publish(errMessage(msgId, contextId, `[${result.code}] ${result.message}`));
      eventBus.finished();
      return;
    }

    const out: Message = {
      kind: "message",
      role: "agent",
      messageId: msgId,
      contextId,
      parts: [
        { kind: "text", text: result.text },
        { kind: "data", data: (result.structured ?? {}) as Record<string, unknown> },
      ],
    };
    eventBus.publish(out);
    eventBus.finished();
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

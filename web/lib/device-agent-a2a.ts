/**
 * Each drive's own agent over A2A: `/a2a/d/<driveId>` (+ its AgentCard). The owner's apps ask
 * their other devices here, with the same @a2a-js/sdk client they use for any A2A agent.
 *
 * The question goes straight to the device's `agent-ask` RPC — the on-device agent of the phone or
 * the Mac app. No per-drive agent record is involved (the old `/agents/<id>/ask` read
 * `.aindrive/agents/<id>.json` from the device on every question and reported any failed read —
 * a busy or half-connected phone — as "agent_not_found"). A device that can't answer now says so.
 *
 * Reply: a text part (the answer) and a data part `ai.aindrive/ask-result` with
 * `{ answer, sources, action? }` — the shape the apps render (thumbnails, "open folder").
 */
import type { AgentCard, Message, Part } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import { sendRpc } from "./agents";
import { AindriveUser } from "./aindrive-agent";
import { getDrive } from "./drives";

export const ASK_RESULT_PART = "ai.aindrive/ask-result";
/** The phone and the Mac app validate the id's shape only; there is no agent file behind it. */
export const DEVICE_AGENT_ID = "agt_device";

export function deviceAgentCard(base: string, drive: { id: string; name: string; hostname?: string | null }): AgentCard {
  const where = drive.hostname ? ` on ${drive.hostname}` : "";
  return {
    name: `${drive.name}${where}`,
    description: `The on-device agent of “${drive.name}”${where}: finds its files by place, date, kind, name and what the photos show, and collects them into folders.`,
    version: "1",
    url: `${base.replace(/\/+$/, "")}/a2a/d/${encodeURIComponent(drive.id)}`,
    preferredTransport: "JSONRPC",
    protocolVersion: "0.3",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: [{ id: "ask", name: "Ask this folder", description: "Finds and collects the files of this drive, on the device that holds them.", tags: ["files"], examples: ["photos taken in Tokyo", "collect this month's food photos"] }],
  } as AgentCard;
}

const textOf = (parts: Part[] | undefined) => (parts ?? []).filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("\n").trim();
const msgId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export class DeviceAgentExecutor implements AgentExecutor {
  constructor(private readonly driveId: string) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const contextId = requestContext.contextId;
    const reply = (parts: Part[]) => { eventBus.publish({ kind: "message", role: "agent", messageId: msgId(), contextId, parts } as Message); eventBus.finished(); };
    const user = requestContext.context?.user;
    const auth = user instanceof AindriveUser ? user.auth : null;
    // The device's whole drive answers (paid files included), so only its owner asks it — as before.
    const drive = getDrive(this.driveId);
    if (!auth?.ok || !drive || drive.owner_id !== auth.ctx.userId) return reply([{ kind: "text", text: "[forbidden] only the drive's owner can ask its device" }]);
    const q = textOf((requestContext.userMessage as Message | undefined)?.parts);
    if (!q) return reply([{ kind: "text", text: "[bad_request] a text part with the question is required" }]);
    let r: { answer?: string; sources?: unknown[]; action?: unknown };
    try {
      r = await sendRpc(this.driveId, { method: "agent-ask", agentId: DEVICE_AGENT_ID, query: q.slice(0, 2000) }, { timeoutMs: 60_000 });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const why = status === 504 || /offline|timeout/i.test((e as Error).message) ? "the device is offline or didn't answer in time" : (e as Error).message;
      return reply([{ kind: "text", text: `[unavailable] ${why}` }, { kind: "data", data: { error: "device_unavailable", detail: why }, metadata: { type: ASK_RESULT_PART } } as Part]);
    }
    const result = { answer: r.answer ?? "", sources: r.sources ?? [], ...(r.action ? { action: r.action } : {}) };
    reply([{ kind: "text", text: result.answer }, { kind: "data", data: result, metadata: { type: ASK_RESULT_PART } } as Part]);
  }

  cancelTask = async (): Promise<void> => {};
}

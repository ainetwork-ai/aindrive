import { randomUUID } from "node:crypto";
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import type { AgentCard, Message, Task } from "@a2a-js/sdk";
import { callAgent } from "./rpc";
import { createHandoffGrant, DEFAULT_TTL_SECONDS, MAX_FILES } from "./handoff";
import { env } from "./env";
import type { DriveEntry } from "./protocol";

/**
 * aindrive-cloud from the web's Folder Chat — the on-device agent's cloud counterpart, run by
 * ainize.ai (Qwen3.8-Flash-Next), the same agent the phone app hands turns to (mobile/src/a2a.ts).
 *
 * A turn is one A2A `message/send`: the question, what is in the open folder (names, kinds, sizes),
 * and that folder's files as handoff links + the grant's MCP view (lib/handoff.ts) — short-lived
 * (15 min), exactly those files, read by the agent only when an answer needs them. Nothing else of
 * the drive is reachable. Only the drive's owner can send a turn (the route checks).
 */

export const CLOUD_AGENT = {
  name: "aindrive-cloud",
  by: "ainize.ai",
  model: "Qwen3.8-Flash-Next",
  card: process.env.AINDRIVE_CLOUD_AGENT_CARD?.trim() || "https://ainize.ai/agents/aindrive-cloud/.well-known/agent-card.json",
};

/** Must match mobile/src/a2a.ts — the agent looks for the MCP view under this type. */
const HANDOFF_MCP_PART = "ai.aindrive/handoff-mcp";
const LISTED_MAX = 200;

function factory(): ClientFactory {
  return new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({}), new RestTransportFactory({})],
    cardResolver: new DefaultAgentCardResolver({}),
  }));
}

// the card is fetched as given (a path-scoped card URL: resolving it from a base URL
// drops the agent's path), and kept for a few minutes
let cached: { card: AgentCard; at: number } | null = null;
async function agentCard(): Promise<AgentCard> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.card;
  const r = await fetch(CLOUD_AGENT.card, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`agent card ${r.status}`);
  cached = { card: (await r.json()) as AgentCard, at: Date.now() };
  return cached.card;
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => {
    const o = p as Record<string, unknown>;
    if ((o.kind === "text" || o.type === "text") && typeof o.text === "string") return o.text;
    if (o.kind === "file" && o.file) return `📎 ${String((o.file as Record<string, unknown>).name ?? "file")}`;
    return "";
  }).filter(Boolean).join("\n");
}

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export async function askCloud(opts: {
  ownerId: string; driveId: string; driveSecret: string; folder: string; q: string; contextId?: string;
}): Promise<{ text: string; contextId?: string; handed: number }> {
  const listed = await callAgent(opts.driveId, opts.driveSecret, { method: "list", path: opts.folder }) as { entries: DriveEntry[] };
  const entries = (listed.entries ?? []).filter((e) => !e.name.startsWith("."));
  // the folder's files, newest first, as links; the listing itself goes as text
  const files = entries.filter((e) => !e.isDir).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
  const handed = files.length
    ? createHandoffGrant(opts.ownerId, opts.driveId,
        files.map((f) => ({ deviceKey: "web", drivePath: f.path, name: f.name, mime: f.mime || "application/octet-stream", size: f.size })),
        CLOUD_AGENT.card, DEFAULT_TTL_SECONDS)
    : null;
  const base = env.publicUrl.replace(/\/+$/, "");
  const listing = entries.slice(0, LISTED_MAX)
    .map((e) => (e.isDir ? `- ${e.name}/ (folder)` : `- ${e.name} (${e.mime || "file"}, ${human(e.size)})`)).join("\n");
  const context = `[aindrive folder "${opts.folder || "/"}": ${entries.length} item${entries.length === 1 ? "" : "s"}` +
    `${entries.length > LISTED_MAX ? `, first ${LISTED_MAX} listed` : ""}` +
    `${handed ? `; the ${files.length} newest files are attached as links` : ""}]\n${listing || "(empty)"}`;
  const message: Message = {
    kind: "message", role: "user", messageId: randomUUID(),
    parts: [
      { kind: "text", text: `${opts.q}\n\n${context}` },
      ...(handed ? handed.links.map((l) => ({ kind: "file" as const, file: { uri: `${base}/api/h/${l.id}?k=${l.secret}`, name: l.name, mimeType: files.find((f) => f.name === l.name)?.mime } })) : []),
      ...(handed ? [{
        kind: "data" as const,
        data: { mcpServers: [{ name: "aindrive-handoff", transport: "streamable-http", url: `${base}/mcp/h/${handed.grant.id}`, headers: { Authorization: `Bearer ${handed.grant.token}` }, expiresAt: handed.grant.expiresAt, tools: ["list_files", "read_file"] }] },
        metadata: { type: HANDOFF_MCP_PART },
      }] : []),
    ],
    ...(opts.contextId ? { contextId: opts.contextId } : {}),
  };
  const client = await factory().createFromAgentCard(await agentCard());
  const r = await client.sendMessage({ message, configuration: { blocking: true, acceptedOutputModes: ["text/plain", "application/json"] } });
  if (r.kind === "message") return { text: textOf(r.parts) || "(no text in the reply)", contextId: r.contextId ?? opts.contextId, handed: files.length };
  const task = r as Task;
  const said = task.status?.message ? textOf(task.status.message.parts) : "";
  const arts = (task.artifacts ?? []).map((a) => textOf(a.parts)).filter(Boolean).join("\n\n");
  const out = [said, arts].filter(Boolean).join("\n\n");
  return { text: out || `(the agent's task is ${task.status?.state ?? "empty"})`, contextId: task.contextId ?? opts.contextId, handed: files.length };
}

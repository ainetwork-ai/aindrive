import { A2aChatAccumulator, listFolderTree, type ChatUpdate } from "ain-ui";
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

function factory(signal?: AbortSignal): ClientFactory {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
  return new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  }));
}

// the card is fetched as given (a path-scoped card URL: resolving it from a base URL
// drops the agent's path), and kept for a few minutes
let cached: { card: AgentCard; at: number } | null = null;
async function agentCard(url = CLOUD_AGENT.card): Promise<AgentCard> {
  if (url === CLOUD_AGENT.card && cached && Date.now() - cached.at < 10 * 60_000) return cached.card;
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`agent card ${r.status}`);
  const card = (await r.json()) as AgentCard;
  if (url === CLOUD_AGENT.card) cached = { card, at: Date.now() };
  return card;
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

/**
 * The folder and its subfolders, breadth-first, as the cloud agent should see them: a flat listing
 * of paths relative to the folder. Capped, so a camera roll doesn't become a 10,000-line prompt —
 * the agent was told "non-recursive" before and answered as if subfolders did not exist.
 */
export async function listRecursive(list: (path: string) => Promise<DriveEntry[]>, folder: string, max = LISTED_MAX, maxDepth = 8)
  : Promise<{ entries: (DriveEntry & { rel: string })[]; folders: number; truncated: boolean }> {
  const tree = await listFolderTree(list, folder, { maxEntries: max, maxDepth });
  const base = folder.replace(/^\/+|\/+$/g, "");
  return { entries: tree.entries.map(e => ({ ...e, rel: base ? e.path.slice(base.length + 1) : e.path })), folders: tree.entries.filter(e => e.isDir).length, truncated: tree.truncated };

}

/** Counts by kind and the date span, so "what is in here" has an answer even before the agent reads anything. */
export function describeEntries(entries: DriveEntry[]): string {
  const files = entries.filter((e) => !e.isDir);
  const kind = (e: DriveEntry) => (e.mime?.startsWith("image/") ? "photos" : e.mime?.startsWith("video/") ? "videos" : e.mime?.startsWith("audio/") ? "recordings"
    : e.mime === "application/pdf" ? "PDFs" : e.mime?.startsWith("text/") || /word|document|hwp/.test(e.mime ?? "") ? "documents" : "other files");
  const counts = new Map<string, number>();
  for (const f of files) counts.set(kind(f), (counts.get(kind(f)) ?? 0) + 1);
  const times = files.map((f) => f.mtimeMs).filter((t) => t > 0);
  const ym = (t: number) => new Date(t).toISOString().slice(0, 7);
  const span = times.length ? (ym(Math.min(...times)) === ym(Math.max(...times)) ? ym(times[0]) : `${ym(Math.min(...times))} – ${ym(Math.max(...times))}`) : "";
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ") + (span ? ` (${span})` : "");
}

/**
 * A drive folder handed to an agent: its listing (recursive, capped), what the device's own agent says
 * about it, and its newest files as handoff links + the grant's MCP view. `audience` is who the grant is
 * for (the agent's card or name). Shared by aindrive-cloud turns (askCloud) and the phone's
 * "@agent @folder" turns about a folder on another device (/api/drives/[driveId]/folder-handoff).
 */
export async function handFolder(opts: { ownerId: string; driveId: string; driveSecret: string; folder: string; audience: string }) {
  const { entries, folders, truncated } = await listRecursive(
    async (path) => ((await callAgent(opts.driveId, opts.driveSecret, { method: "list", path })) as { entries: DriveEntry[] }).entries ?? [], opts.folder);
  // What the device's own agent knows about these files (dates, places, kinds from its index): the
  // cloud model is text-only and cannot look at a photo, so this is how "what is in here" gets answered
  // about pictures. Best effort — a plain CLI drive has no such agent.
  const deviceSays = opts.folder ? "" : await callAgent(opts.driveId, opts.driveSecret, { method: "agent-ask", agentId: "folder-chat", query: `what's in ${opts.folder ? `the folder "${opts.folder}"` : "this folder"}?` })
    .then((r) => String((r as { answer?: string }).answer ?? "").trim()).catch(() => "");
  // the folder's files, newest first, as links; the listing itself goes as text
  const files = entries.filter((e) => !e.isDir).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
  const handed = files.length
    ? createHandoffGrant(opts.ownerId, opts.driveId,
        files.map((f) => ({ deviceKey: "web", drivePath: f.path, name: f.name, mime: f.mime || "application/octet-stream", size: f.size })),
        opts.audience, DEFAULT_TTL_SECONDS)
    : null;
  const base = env.publicUrl.replace(/\/+$/, "");
  const listing = entries
    .map((e) => (e.isDir ? `- ${e.rel}/ (folder)` : `- ${e.rel} (${e.mime || "file"}, ${human(e.size)})`)).join("\n");
  const context = `[aindrive folder "${opts.folder || "/"}", including its ${folders} subfolder${folders === 1 ? "" : "s"}: ${describeEntries(entries) || "empty"}` +
    `${truncated ? `; only the first ${entries.length} entries are listed` : ""}` +
    `${handed ? `; the ${files.length} newest files are attached as links` : ""}]` +
    `${deviceSays ? `\n[the device's agent about these files: ${deviceSays}]` : ""}\n${listing || "(empty)"}`;

  return {
    entries, truncated, context, deviceSays,
    links: (handed?.links ?? []).map((l, i) => ({ id: l.id, url: `${base}/api/h/${l.id}?k=${l.secret}`, name: l.name, mime: files[i]?.mime || "application/octet-stream", expiresAt: l.expiresAt })),
    mcp: handed ? { url: `${base}/mcp/h/${handed.grant.id}`, token: handed.grant.token, expiresAt: handed.grant.expiresAt } : null,
  };
}

/** One aindrive-cloud turn about one folder, or several ("@aindrive-cloud @Photos-in-S21 @Docs-in-Mac …"). */
export async function askCloud(opts: {
  ownerId: string; folders: { driveId: string; driveSecret: string; folder: string }[]; q: string; contextId?: string; cardUrl?: string; signal?: AbortSignal; onUpdate?: (update: ChatUpdate) => void;
}): Promise<{ text: string; contextId?: string; handed: number }> {
  const handed = await Promise.all(opts.folders.map((f) => handFolder({ ...f, ownerId: opts.ownerId, audience: opts.cardUrl ?? CLOUD_AGENT.card })));
  const context = handed.map((h) => h.context).join("\n\n");
  const links = handed.flatMap((h) => h.links);
  const mcps = handed.flatMap((h) => (h.mcp ? [h.mcp] : []));
  const message: Message = {
    kind: "message", role: "user", messageId: randomUUID(),
    parts: [
      { kind: "text", text: `${opts.q}\n\n${context}` },
      ...links.map((l) => ({ kind: "file" as const, file: { uri: l.url, name: l.name, mimeType: l.mime } })),
      ...(mcps.length ? [{
        kind: "data" as const,
        data: { mcpServers: mcps.map((mcp, i) => ({ name: i ? `aindrive-handoff-${i + 1}` : "aindrive-handoff", transport: "streamable-http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, expiresAt: mcp.expiresAt, tools: ["list_files", "read_file"] })) },
        metadata: { type: HANDOFF_MCP_PART },
      }] : []),
    ],
    ...(opts.contextId ? { contextId: opts.contextId } : {}),
  };
  opts.signal?.throwIfAborted();
  const card = await agentCard(opts.cardUrl);
  const client = await factory(opts.signal).createFromAgentCard(card);
  const accumulator = new A2aChatAccumulator();
  if (opts.onUpdate && card.capabilities?.streaming) {
    // Once submitted, never silently resubmit after a network or task failure.
    for await (const event of client.sendMessageStream({ message, configuration: { acceptedOutputModes: ["text/plain", "application/json"] } })) {
      opts.signal?.throwIfAborted();
      const update = accumulator.push(event);
      opts.onUpdate(update);
      if (update.state && ["completed", "input-required", "auth-required"].includes(update.state)) break;
    }
    if (!accumulator.received) throw new Error("Agent returned an empty stream");
  } else {
    accumulator.push(await client.sendMessage({ message, configuration: { blocking: true, acceptedOutputModes: ["text/plain", "application/json"] } }));
  }
  const result = accumulator.value();
  if (result.state && !["completed", "input-required", "auth-required"].includes(result.state)) throw new Error(`Agent task is still ${result.state}; stream ended early`);
  opts.onUpdate?.(result);
  return { text: result.text, contextId: result.contextId ?? opts.contextId, handed: links.length };
}

// A2A (Agent2Agent, v0.3) client on the official JS SDK (@a2a-js/sdk — the
// same SDK web/app/a2a/route.ts serves with; see a2a-protocol.org/latest/sdk):
// add any agent by pasting its URL, then chat with it from the agent sheet
// instead of the on-device agent. The SDK resolves the AgentCard
// (/.well-known/agent-card.json), picks the transport the card offers
// (JSON-RPC or REST) and sends `message/send`; the reply is a Message or a Task
// (status.message / artifacts). The contextId it returns is sent back so the
// agent keeps the conversation.
import { Preferences } from "@capacitor/preferences";
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import type { AgentCard, Message, Task } from "@a2a-js/sdk";

export interface A2aAgent {
  id: string;
  /** What the user pasted (kept for display). */
  source: string;
  /** JSON-RPC endpoint from the card. */
  url: string;
  name: string;
  description?: string;
  version?: string;
  provider?: string;
  skills: { name: string; description?: string }[];
  /** Bearer token for agents that need one (optional). */
  token?: string;
  /** The AgentCard as resolved, so a turn needs no second fetch. */
  card?: AgentCard;
  /** The signed-in aindrive server's own agent: always in the chat, can't be removed. */
  builtin?: boolean;
  addedAt: number;
}

const KEY = "aindrive.mobile.a2a.v1";

export async function loadAgents(): Promise<{ agents: A2aAgent[]; selected: string }> {
  try {
    const v = (await Preferences.get({ key: KEY })).value;
    if (v) { const o = JSON.parse(v); return { agents: o.agents ?? [], selected: o.selected ?? "local" }; }
  } catch { /* first run */ }
  return { agents: [], selected: "local" };
}

export async function saveAgents(agents: A2aAgent[], selected: string): Promise<void> {
  try { await Preferences.set({ key: KEY, value: JSON.stringify({ agents, selected }) }); } catch { /* best effort */ }
}

/** fetch that adds the bearer token (the native HTTP layer handles CORS). */
function authedFetch(bearer?: string): typeof fetch {
  if (!bearer) return (input, init) => fetch(input, init);
  return (input, init = {}) => {
    const h = new Headers(init.headers);
    h.set("authorization", `Bearer ${bearer}`);
    return fetch(input, { ...init, headers: h });
  };
}

function factory(bearer?: string): ClientFactory {
  const fetchImpl = authedFetch(bearer);
  return new ClientFactory(ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  }));
}

/** The pasted text → the agent's card. Accepts the card URL, the site, or a path under it. */
export async function discover(raw: string, token?: string): Promise<A2aAgent> {
  let s = raw.trim();
  if (!s) throw new Error("Paste an agent URL");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  const resolver = new DefaultAgentCardResolver({ fetchImpl: authedFetch(token) });
  // [base, path] pairs for DefaultAgentCardResolver.resolve: the exact card URL, the path's
  // well-known card, the site's, and the pre-0.3 name. The path is tried WITH a trailing slash first:
  // the resolver joins the card path relatively, so `…/agents/news` without one loses `news` and asks
  // `…/agents/.well-known/agent-card.json` — every agent hosted under a path (ainize.ai/agents/<id>) failed.
  const path = u.pathname.replace(/\/+$/, "");
  const tries: [string, string?][] = /\.json$/i.test(u.pathname)
    ? [[u.toString(), ""]]
    : [...(path ? [[`${u.origin}${path}/`] as [string]] : []),
       // A site's human page is often /agent/<name> while the A2A endpoint is /agents/<name> (ainize.ai).
       ...(/\/agent\//.test(path) ? [[`${u.origin}${path.replace("/agent/", "/agents/")}/`] as [string]] : []),
       [`${u.origin}${path}`], [`${u.origin}/`], [`${u.origin}/`, "/.well-known/agent.json"]];
  let lastErr = "";
  for (const [base, path] of tries) {
    try {
      const c = await resolver.resolve(base, path);
      if (!c?.name) { lastErr = "not an agent card"; continue; }
      return {
        id: `a2a-${Date.now().toString(36)}`, source: raw.trim(), url: c.url || `${u.origin}/a2a`, name: c.name,
        description: c.description, version: c.version, provider: c.provider?.organization,
        skills: (c.skills ?? []).map((k) => ({ name: k.name ?? k.id, description: k.description })),
        token, card: c, addedAt: Date.now(),
      };
    } catch (e) { lastErr = (e as Error).message; }
  }
  throw new Error(`No A2A agent card found at that address (${lastErr})`);
}

/** Text of the parts of a Message / Artifact. */
function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => {
    const o = p as Record<string, unknown>;
    if ((o.kind === "text" || o.type === "text") && typeof o.text === "string") return o.text;
    if (o.kind === "data" && o.data) return "```\n" + JSON.stringify(o.data, null, 2) + "\n```";
    if (o.kind === "file" && o.file) return `📎 ${String((o.file as Record<string, unknown>).name ?? "file")}`;
    return "";
  }).filter(Boolean).join("\n");
}

/** One chat turn to an A2A agent. Returns the reply text and the contextId to send next time. */
/** A file handed to the agent as a link (web/lib/handoff.ts): the agent fetches `uri` if it needs the bytes. */
export interface LinkedFile { uri: string; name: string; mimeType: string }

export async function send(agent: A2aAgent, text: string, contextId?: string, sessionBearer?: string, files: LinkedFile[] = []): Promise<{ text: string; contextId?: string }> {
  const f = factory(agent.token || sessionBearer);
  const client = agent.card ? await f.createFromAgentCard(agent.card) : await f.createFromUrl(new URL(agent.url).origin);
  const message: Message = {
    kind: "message", role: "user", messageId: crypto.randomUUID?.() ?? `m-${Date.now()}`,
    parts: [{ kind: "text", text }, ...files.map((f) => ({ kind: "file" as const, file: { uri: f.uri, name: f.name, mimeType: f.mimeType } }))],
    ...(contextId ? { contextId } : {}),
  };
  const r = await client.sendMessage({ message, configuration: { blocking: true, acceptedOutputModes: ["text/plain", "application/json"] } });
  if (r.kind === "message") return { text: textOf(r.parts) || "(no text in the reply)", contextId: r.contextId ?? contextId };
  // A Task: its status message, then any artifacts.
  const task = r as Task;
  const said = task.status?.message ? textOf(task.status.message.parts) : "";
  const arts = (task.artifacts ?? []).map((a) => textOf(a.parts)).filter(Boolean).join("\n\n");
  const out = [said, arts].filter(Boolean).join("\n\n");
  const state = task.status?.state ?? "";
  if (out) return { text: out, contextId: task.contextId ?? contextId };
  return { text: state === "input-required" ? "The agent needs more input." : state ? `Task ${state}.` : "(empty reply)", contextId: task.contextId ?? contextId };
}

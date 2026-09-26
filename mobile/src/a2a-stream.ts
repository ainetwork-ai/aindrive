// An A2A reply as it arrives (`message/stream`), folded into what the chat shows: the answer so far,
// the step the agent is on ("Opening attached file 1…"), and whether it is finished. Kept apart from
// a2a.ts (which needs Capacitor) so tests can feed it the events an agent sends.
//
// What arrives, in the order ainize-hosted agents send it (other agents may send any subset):
//   Task                         — the turn started; carries the contextId
//   status-update  working       — a step, said out loud while it runs
//   artifact-update (append)     — the next piece of the answer; the first one (append: false) starts it
//   status-update  final         — the whole answer, which replaces the pieces
// An agent without streaming sends one Message or Task instead; that folds the same way.

export interface A2aReply {
  /** The answer so far (the whole answer once `done`). */
  text: string;
  contextId?: string;
  /** What the agent is doing right now, while no answer text has arrived yet. */
  step?: string;
  /** Task state last reported (completed, input-required, failed, …). */
  state?: string;
  done: boolean;
}

export const a2aReplyStart = (contextId?: string): A2aReply => ({ text: "", contextId, done: false });

/** Text of the parts of a Message / Artifact. */
export function a2aTextOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => {
    const o = p as Record<string, unknown>;
    if ((o.kind === "text" || o.type === "text") && typeof o.text === "string") return o.text;
    if (o.kind === "data" && o.data) return "```\n" + JSON.stringify(o.data, null, 2) + "\n```";
    if (o.kind === "file" && o.file) return `📎 ${String((o.file as Record<string, unknown>).name ?? "file")}`;
    return "";
  }).filter(Boolean).join("\n");
}

/** A streamed piece, exactly as sent: its spaces are part of the answer. */
function chunkOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => {
    const o = p as Record<string, unknown>;
    return (o.kind === "text" || o.type === "text") && typeof o.text === "string" ? o.text : "";
  }).join("");
}

const FINAL_STATES = new Set(["completed", "input-required", "auth-required", "failed", "canceled", "rejected"]);

export function foldA2aEvent(r: A2aReply, event: unknown): A2aReply {
  const e = (event ?? {}) as Record<string, unknown>;
  const contextId = typeof e.contextId === "string" ? e.contextId : r.contextId;
  if (e.kind === "message") return { ...r, contextId, text: a2aTextOf(e.parts), step: undefined, done: true };
  if (e.kind === "artifact-update") {
    const piece = chunkOf((e.artifact as { parts?: unknown } | undefined)?.parts);
    return { ...r, contextId, text: e.append === true ? r.text + piece : piece, step: undefined };
  }
  const status = e.status as { state?: string; message?: { parts?: unknown } } | undefined;
  if (e.kind === "status-update") {
    const said = a2aTextOf(status?.message?.parts);
    const state = status?.state ?? r.state;
    if (e.final === true || (state && FINAL_STATES.has(state))) return { ...r, contextId, state, text: said || r.text, step: undefined, done: true };
    return { ...r, contextId, state, ...(said && !r.text ? { step: said } : {}) };
  }
  if (e.kind === "task") {
    // A whole Task: its status message, then any artifacts (an agent that does not stream answers this way).
    const said = a2aTextOf(status?.message?.parts);
    const arts = ((e.artifacts as { parts?: unknown }[] | undefined) ?? []).map((a) => a2aTextOf(a.parts)).filter(Boolean).join("\n\n");
    const state = status?.state;
    const done = !!state && FINAL_STATES.has(state);
    const text = arts === said ? said : [said, arts].filter(Boolean).join("\n\n");   // an agent that repeats its answer as an artifact shows it once
    return { ...r, contextId, state, done, ...(done ? { text: text || r.text } : {}) };
  }
  return r;
}

/** What the chat keeps once the reply is over (an empty one says what state it ended in). */
export function a2aReplyText(r: A2aReply): string {
  if (r.text) return r.text;
  if (r.state === "input-required") return "The agent needs more input.";
  return r.state ? `Task ${r.state}.` : "(empty reply)";
}

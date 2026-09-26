/**
 * "@agent @folder …" in Folder Chat: the leading @-words of a message name an agent and/or folders.
 * A folder is one of the account's drives — a folder shared from a device — as "@<name>-in-<device>",
 * the same handles the phone/Mac chat offers (mobile/src/main.ts mentionFolders; mirrored by hand).
 */

export interface MentionDrive { id: string; name: string; hostname: string | null; online: boolean; owned?: boolean }
export interface FolderMention { handle: string; label: string; drive: MentionDrive }

const dashed = (s: string) => s.trim().replace(/\s+/g, "-");

/** Mirrors mobile/src/main.ts deviceName. */
export function deviceName(d: { hostname: string | null }): string {
  return (d.hostname ?? "").trim().replace(/\.local$/i, "") || "Unknown device";
}

/** An agent's @name: its name without a trailing "agent", spaces as dashes (mobile handleOf). */
export function agentHandle(name: string): string {
  return name.trim().replace(/\s+agent$/i, "").replace(/\s+/g, "-");
}

/** The account's own drives as mentionable folders; handing their files to an agent is the owner's call. */
export function mentionFolders(drives: MentionDrive[]): FolderMention[] {
  const out = drives.filter((d) => d.owned !== false)
    .map((d) => ({ handle: `${dashed(d.name)}-in-${dashed(deviceName(d))}`, label: `${d.name} · ${deviceName(d)}`, drive: d }));
  // a handle names one folder: a second one with the same name gets a number
  const seen = new Map<string, number>();
  for (const f of out) {
    const k = f.handle.toLowerCase(), n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) f.handle += `-${n}`;
  }
  return out;
}

/**
 * The leading run of @-words: each a folder (exact handle) or an agent (exact handle, else a prefix);
 * the first other word starts the question. Null when nothing leading resolves.
 */
export function parseMentions<A extends { name: string }>(q: string, agents: A[], folders: FolderMention[])
  : { agent?: A; folders: FolderMention[]; text: string } | null {
  let rest = q.trim(), agent: A | undefined;
  const picked: FolderMention[] = [];
  for (let m = /^@(\S+)\s*/.exec(rest); m; m = /^@(\S+)\s*/.exec(rest)) {
    const key = m[1].replace(/[,.:;!?]+$/, "").toLowerCase();
    const folder = folders.find((f) => f.handle.toLowerCase() === key);
    const a = folder ? undefined
      : agents.find((x) => agentHandle(x.name).toLowerCase() === key) ?? agents.find((x) => agentHandle(x.name).toLowerCase().startsWith(key));
    if (folder) { if (!picked.includes(folder)) picked.push(folder); }
    else if (a && !agent) agent = a;
    else break;
    rest = rest.slice(m[0].length);
  }
  if (!agent && !picked.length) return null;
  return { agent, folders: picked, text: rest || q.trim() };
}

/** The "@wor" being typed at the caret, or null. */
export function mentionTokenAt(value: string, caret: number): { start: number; text: string } | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return m ? { start: caret - m[1].length - 1, text: m[1] } : null;
}

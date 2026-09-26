/**
 * One question, many drives. The apps ask every drive of the account in parallel (each folder a
 * phone shares is its own drive), and the per-client ask budget (the tier's billing unit) counted
 * each of those calls — so one question over 7 phone folders was 7 asks and hit the free limit.
 * The app tags the calls of one question with one random id (`x-aindrive-ask`): the first call is
 * charged, up to FANOUT_MAX more with that id ride along within FANOUT_WINDOW_MS. Reusing an id
 * longer or wider is charged as new asks, so it can't become a free pass.
 */
export const FANOUT_MAX = 16;
export const FANOUT_WINDOW_MS = 60_000;

type Seen = { uses: number; exp: number };
const seen: Map<string, Seen> = ((globalThis as Record<string, unknown>).__aindrive_ask_fanout as Map<string, Seen>) ?? new Map();
(globalThis as Record<string, unknown>).__aindrive_ask_fanout = seen;

/** True when this call is part of a question already charged; false = charge it (and remember the id). */
export function ridesAlong(clientKey: string, askId: string | null, now = Date.now()): boolean {
  if (!askId || !/^[A-Za-z0-9_-]{16,64}$/.test(askId)) return false;
  if (seen.size > 5000) for (const [k, v] of seen) if (v.exp <= now) seen.delete(k);
  const k = `${clientKey}|${askId}`;
  const s = seen.get(k);
  if (s && s.exp > now && s.uses < FANOUT_MAX) { s.uses++; return true; }
  seen.set(k, { uses: 0, exp: now + FANOUT_WINDOW_MS });
  return false;
}

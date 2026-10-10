import { createHash, randomUUID } from "node:crypto";
import { db } from "./db";
import { autoBindProject, fireProjectHook, projectHookFor, type Pusher, type RefUpdate, type PushContext } from "./git-project-hooks";
import { log } from "./logger.js";

type Delivery = { id: string; drive_id: string; repo: string; payload: string; user_id: string | null; origin: string | null; attempts: number };
const LEASE_MS = 60_000;

/** Persist the actor and immutable ref update, never a credential. Repeated notifications share one receipt. */
export function enqueueProjectDelivery(driveId: string, repo: string, update: RefUpdate, pusher: Pusher, userId: string | null, ctx?: PushContext): string {
  const payload = JSON.stringify({ ...update, pusher });
  const id = createHash("sha256").update(JSON.stringify([driveId, repo, payload])).digest("hex");
  db.prepare(`INSERT OR IGNORE INTO git_project_deliveries
    (id, drive_id, repo, payload, user_id, origin, status, attempts, next_attempt_at, created_at)
    VALUES (?,?,?,?,?,?,'pending',0,?,?)`).run(id, driveId, repo, payload, userId, ctx?.origin ?? null, Date.now(), Date.now());
  return id;
}

/** A database lease prevents the Next handler and startup worker from sending the same event concurrently. */
export async function deliverProjectEvent(id: string, fetchImpl: typeof fetch = fetch, ctx?: PushContext, force = false): Promise<number | null> {
  const now = Date.now();
  const lease = randomUUID();
  const claimed = db.prepare(`UPDATE git_project_deliveries SET lease = ?, lease_until = ?, attempts = attempts + 1
    WHERE id = ? AND status = 'pending' AND (lease_until IS NULL OR lease_until <= ?)
    AND (? = 1 OR next_attempt_at <= ?)
    AND NOT EXISTS (SELECT 1 FROM git_project_deliveries earlier
      WHERE earlier.drive_id = git_project_deliveries.drive_id AND earlier.repo = git_project_deliveries.repo
      AND earlier.status = 'pending' AND earlier.rowid < git_project_deliveries.rowid)` ).run(lease, now + LEASE_MS, id, now, force ? 1 : 0, now);
  if (!claimed.changes) return null;
  const row = db.prepare("SELECT * FROM git_project_deliveries WHERE id = ?").get(id) as Delivery;
  const payload = JSON.parse(row.payload) as RefUpdate & { pusher: Pusher };
  let status = 0;
  let error: string | null = null;
  let ignored = false;
  try {
    let hook = projectHookFor(row.drive_id, row.repo);
    if (!hook) {
      const drive = db.prepare("SELECT drive_secret FROM drives WHERE id = ?").get(row.drive_id) as { drive_secret: string } | undefined;
      const context = ctx ?? (drive ? { driveSecret: drive.drive_secret, origin: row.origin ?? undefined } : undefined);
      if (!context) throw new Error("drive unavailable for project binding");
      const result = await autoBindProject(row.drive_id, row.repo, payload, row.user_id, context, fetchImpl, payload.pusher, row.id);
      if (result.bound) hook = projectHookFor(row.drive_id, row.repo);
      else {
        ignored = result.reason === "no_manifest" || result.reason === "no_org_url";
        error = `${result.reason}${result.detail ? `: ${result.detail}` : ""}`;
      }
    }
    if (hook) {
      status = await fireProjectHook(hook, payload, payload.pusher, fetchImpl, row.id);
      if (status < 200 || status >= 300) error = `hook HTTP ${status}`;
    }
  } catch (e) { error = (e as Error).message; }
  const delivered = status >= 200 && status < 300;
  const backoff = Math.min(3_600_000, 1_000 * 2 ** Math.min(row.attempts, 12));
  db.prepare(`UPDATE git_project_deliveries SET status = ?, next_attempt_at = ?, last_error = ?,
    delivered_at = ?, lease = NULL, lease_until = NULL WHERE id = ? AND lease = ?`).run(
    delivered ? "delivered" : ignored ? "ignored" : "pending", Date.now() + backoff, error,
    delivered ? Date.now() : null, id, lease,
  );
  return status;
}

export async function drainProjectDeliveries(fetchImpl: typeof fetch = fetch): Promise<void> {
  const now = Date.now();
  const rows = db.prepare(`SELECT id FROM git_project_deliveries WHERE status = 'pending'
    AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
    AND NOT EXISTS (SELECT 1 FROM git_project_deliveries earlier WHERE earlier.drive_id = git_project_deliveries.drive_id
      AND earlier.repo = git_project_deliveries.repo AND earlier.status = 'pending' AND earlier.rowid < git_project_deliveries.rowid)
    ORDER BY created_at LIMIT 20`).all(now, now) as { id: string }[];
  // Preserve source order; retries never run an older event concurrently with a newer one here.
  for (const row of rows) await deliverProjectEvent(row.id, fetchImpl);
  db.prepare("DELETE FROM git_project_deliveries WHERE status != 'pending' AND created_at < ?").run(now - 30 * 24 * 60 * 60 * 1000);
}

export function startProjectDeliveryWorker(): { stop: () => Promise<void> } {
  let stopped = false;
  let active: Promise<void> | null = null;
  const tick = () => {
    if (stopped || active) return;
    active = drainProjectDeliveries().catch((e) => log.warn({ err: (e as Error).message }, "project delivery retry failed"))
      .finally(() => { active = null; });
  };
  const timer = setInterval(tick, 5_000);
  timer.unref();
  tick();
  return { stop: async () => { stopped = true; clearInterval(timer); await active; } };
}

/**
 * Per-user drive limit.
 *
 * Off by default: every shared folder is its own drive (a phone shares N
 * folders as N drives), so a small fixed cap was the first thing users hit by
 * accident. Set AINDRIVE_DEFAULT_DRIVE_LIMIT to a positive integer to enforce
 * a cap; unset, 0, or garbage means unlimited.
 *
 * Future: replace the return value with a DB lookup like:
 *   const row = drizzleDb.select({ limit: users.drive_limit }).from(users).where(eq(users.id, userId)).get();
 *   return row?.limit ?? defaultLimit;
 */
export function getUserDriveLimit(_userId: string): number {
  const raw = parseInt(process.env.AINDRIVE_DEFAULT_DRIVE_LIMIT ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : Infinity;
}

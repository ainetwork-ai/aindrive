/**
 * Per-user drive limit.
 *
 * Future: replace the return value with a DB lookup like:
 *   const row = drizzleDb.select({ limit: users.drive_limit }).from(users).where(eq(users.id, userId)).get();
 *   return row?.limit ?? defaultLimit;
 */
export function getUserDriveLimit(_userId: string): number {
  const defaultLimit = parseInt(process.env.AINDRIVE_DEFAULT_DRIVE_LIMIT ?? "10", 10);
  // Per-user override: add a `drive_limit` column to the users table and return it here.
  return defaultLimit;
}

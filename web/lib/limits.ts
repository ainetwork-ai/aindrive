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

/**
 * Operator exemption from the per-owner storage caps (lib/tier.ts
 * getOwnerStorageCaps). AINDRIVE_UNLIMITED_OWNERS is a comma-separated list of
 * user ids and/or wallet addresses; a drive whose owner matches — by id, or by
 * any wallet linked to the owner's account — has no file/folder count cap.
 * For service accounts that host many users' files in one drive (e.g. an
 * app's operator drive written through a PAT). Read per call, so a restart
 * is the only deploy step. Ids match exactly; addresses case-insensitively.
 */
export function isUnlimitedOwner(ownerId: string, ownerWallets: readonly string[] = []): boolean {
  const entries = (process.env.AINDRIVE_UNLIMITED_OWNERS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  const wallets = new Set(ownerWallets.map((w) => w.toLowerCase()));
  return entries.some((e) => e === ownerId || (/^0x[0-9a-fA-F]{40}$/.test(e) && wallets.has(e.toLowerCase())));
}

/**
 * The paywall a drive route's 402 describes (require-access.ts spreads the
 * PaidDenial into the body). Client-safe: the drive UI turns a payment denial
 * for the location it is showing into the paywall, not an error message.
 */
export type PaidLock = { gatePath: string; shareId: string; price: number; currency: string | null; listed: boolean };

export function paidLockFrom(status: number, body: unknown): PaidLock | null {
  if (status !== 402 || !body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.gatePath !== "string" || typeof b.shareId !== "string" || typeof b.price !== "number") return null;
  return {
    gatePath: b.gatePath,
    shareId: b.shareId,
    price: b.price,
    currency: typeof b.currency === "string" ? b.currency : null,
    listed: b.listed === true,
  };
}

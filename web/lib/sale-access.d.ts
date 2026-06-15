import type { RoleOrNone } from "./access-core";

export type SaleGate = {
  id: string;
  path: string;
  price_usdc: number;
  currency: string | null;
  expires_at: string | null;
};

export type PaidDenial = { gatePath: string; shareId: string; price: number; currency: string | null };

export declare function classifyPath(
  driveId: string,
  targetPath: string,
): { classification: "free" | "paid"; gate: SaleGate | null };

export declare function hasPaidEntitlement(driveId: string, accountId: string, gatePath: string): boolean;

export declare function paidAccessDenial(
  driveId: string,
  targetPath: string,
  role: RoleOrNone,
  accountId: string | null,
): PaidDenial | null;

export type EntryLock = { price: number; currency: string | null; shareId: string; listed: boolean };

export declare function paidLocksForListing(
  driveId: string,
  parentPath: string,
  childNames: string[],
  role: RoleOrNone,
  accountId: string | null,
): Record<string, EntryLock>;

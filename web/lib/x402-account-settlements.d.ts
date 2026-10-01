import type { Role } from "./access-core";

export type Eip3009Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  /** sha256 over the canonical authorization and its signature. */
  envelopeHash: string;
};

export type SettlementStatus = "unresolved" | "credited" | "released";

export type SettlementRow = {
  id: string;
  account_id: string;
  share_id: string;
  drive_id: string;
  path: string;
  role: Role;
  amount_usdc: number;
  currency: string;
  chain: string;
  pay_to: string;
  amount_atomic: string;
  network: string;
  asset: string;
  payer: string;
  nonce: string;
  envelope_hash: string;
  valid_before: string | null;
  status: SettlementStatus;
  tx_hash: string | null;
  last_error: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: number;
  updated_at: number;
};

export type SettlementKey = { network: string; asset: string; payer: string; nonce: string };
export type SaleRef = { shareId: string; driveId: string; path: string; role: Role };

export type RecordResult =
  | { kind: "recorded"; row: SettlementRow }
  /** The authorization is already another account's, sale's or envelope's (or resolved). */
  | { kind: "conflict" }
  /** The account has an unresolved attempt for this sale. */
  | { kind: "pending"; row: SettlementRow }
  /** The account holds the sale by now. */
  | { kind: "held" };

export type CreditResult =
  | { ok: true; already: boolean; txHash: string; row: SettlementRow }
  | { ok: false; reason: string };

export declare function isAmbiguousPayload(payload: unknown): boolean;
export declare function eip3009Authorization(payload: unknown): Eip3009Authorization | null;
export declare function findSettlement(k: SettlementKey): SettlementRow | undefined;
export declare function getSettlement(id: string): SettlementRow | undefined;
export declare function settlementEvents(id: string): { action: string; actor: string; detail: string | null; at: number }[];
export declare function isSameSale(row: Pick<SettlementRow, "share_id" | "drive_id" | "path" | "role">, sale: SaleRef): boolean;
export declare function openSettlementFor(accountId: string, sale: SaleRef): SettlementRow | undefined;
export declare function recordBeforeSettle(
  input: SettlementKey & {
    accountId: string;
    sale: SaleRef & { amountUsdc: number; currency: string; chain: string; payTo: string; amountAtomic: string };
    envelopeHash: string;
    validBefore: string;
  },
  holdsNow: () => boolean,
  nowMs?: number,
): RecordResult;
export declare function creditSettlement(
  c: { id: string; txHash: string; wallet?: string; actor: string; note?: string | null },
  nowMs?: number,
): CreditResult;
export declare function releaseSettlement(r: { id: string; actor: string; reason: string }, nowMs?: number): boolean;
export declare function noteUncertain(id: string, reason: string, nowMs?: number): void;
export declare function supportUrl(ref: string): string;

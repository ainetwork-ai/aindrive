// Sales KPI aggregation for the Manage-page Earnings ledger.
//
// WHY this exists: payment_receipts.amount_usdc holds the amount in the SALE's
// currency unit, not USDC (a FANCO sale stores FANCO count). Summing across
// currencies into one $ figure is meaningless, so earnings are grouped BY
// currency. Pure so the component and tests share one aggregation.

/** The two receipt fields the KPI needs. Full row is in share-dialog-sections. */
export type ReceiptAmount = { amount_usdc: number | null; currency: string | null };

export type CurrencyTotal = { currency: string; total: number };

// Fallback for receipts whose currency is NULL. Post-migration no live row is
// NULL (db.js backfills, the write path records tok.symbol), but display stays
// defensive: pre-currency sales were all USDC.
export const DEFAULT_RECEIPT_CURRENCY = "USDC";

/**
 * Sums receipt amounts per currency, largest total first. NULL currency and
 * NULL amount fold into USDC / 0 respectively.
 */
export function sumByCurrency(receipts: ReceiptAmount[]): CurrencyTotal[] {
  const totals = new Map<string, number>();
  for (const r of receipts) {
    const currency = r.currency ?? DEFAULT_RECEIPT_CURRENCY;
    totals.set(currency, (totals.get(currency) ?? 0) + (r.amount_usdc ?? 0));
  }
  return [...totals.entries()]
    .map(([currency, total]) => ({ currency, total }))
    .sort((a, b) => b.total - a.total);
}

/** Renders grouped totals as e.g. "1,200 USDC · 300 FANCO". Empty → "0 USDC". */
export function formatCurrencyTotals(totals: CurrencyTotal[]): string {
  if (totals.length === 0) return `0 ${DEFAULT_RECEIPT_CURRENCY}`;
  return totals
    .map((t) => `${t.total.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${t.currency}`)
    .join(" · ");
}

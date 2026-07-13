export type PaymentSettledContext = {
  driveId: string;
  path: string;
  wallet: string;
  txHash: string;
  amountUsdc: number;
  // Token symbol the amount is denominated in (amountUsdc is in THIS unit, not
  // USD). See payment_receipts.currency.
  currency: string;
  network: string;
};

export async function onPaymentSettled(_ctx: PaymentSettledContext): Promise<void> {
  // Phase 2 fills this in (Nansen wallet enrichment, dashboard updates).
}

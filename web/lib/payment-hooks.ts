export type PaymentSettledContext = {
  driveId: string;
  path: string;
  wallet: string;
  txHash: string;
  amountUsdc: number;
  network: string;
};

export async function onPaymentSettled(_ctx: PaymentSettledContext): Promise<void> {
  // Phase 2 fills this in (Nansen wallet enrichment, dashboard updates).
}

import { X402Logo } from "./x402-logo";

export function X402Badge({ price }: { price: number }) {
  return (
    <span
      className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-lg
                 bg-gradient-to-r from-blue-600 to-blue-500
                 shadow-md shadow-blue-500/30
                 hover:shadow-lg hover:shadow-blue-500/40 transition"
      title={`Selling for $${price.toFixed(2)} USDC via x402`}
    >
      <X402Logo className="h-3 w-auto text-white" />
      <span aria-hidden="true" className="h-3 w-px bg-white/40" />
      <span className="text-white text-[14px] font-bold tabular-nums leading-none tracking-[0.04em] font-[family-name:var(--font-display)]">
        ${price.toFixed(2)}
      </span>
    </span>
  );
}

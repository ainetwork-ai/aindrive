// Display helpers for wallet-provisioned accounts, whose email is a synthetic
// `<lowercased 0x address>@wallet.aindrive.local` placeholder (web/lib/wallet.ts
// resolveAccountForWallet). Never show that placeholder to a human — show a
// truncated wallet address instead. Pure; used by server + client.
const SYNTH_SUFFIX = "@wallet.aindrive.local";

export function isWalletOnlyEmail(email: string): boolean {
  return email.toLowerCase().endsWith(SYNTH_SUFFIX);
}

export function walletDisplayLabel(email: string, name?: string | null): string {
  if (!isWalletOnlyEmail(email)) return name || email;
  // The local-part of the synthetic email IS the lowercased wallet address.
  const addr = email.slice(0, email.length - SYNTH_SUFFIX.length);
  return addr.length >= 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

// Normalises EIP-6963 wallet announcements so uuid-based dedupe works as the
// spec intends. EIP-6963 requires a wallet to keep ONE stable uuid per page
// session; the Coinbase Wallet extension regenerates it on every announce.
// wagmi's discovery store (mipd) dedupes announcements by uuid only, and
// wagmi's ssr-hydrate path batch-converts every stored announcement into a
// connector with no intra-batch rdns check (still unfixed as of @wagmi/core
// 3.6.3) — so one misbehaving extension renders twice under RainbowKit's
// "Installed" group.
//
// Fix at the boundary: pin the first uuid seen per rdns and REWRITE later
// announces to it. Rewriting (not dropping) matters: re-announces must keep
// propagating so any store created later (HMR, second config) can still
// discover the wallet; spec-compliant wallets pass through untouched.
//
// Invariant: install BEFORE wagmi's createConfig() — listener order is what
// puts the rewrite ahead of mipd's listener (getWagmiConfig does this).

// Mirrors mipd's EIP6963ProviderInfo/Detail (transitive dep — not imported).
type Eip6963ProviderInfo = { uuid: string; name: string; icon: string; rdns: string };
type Eip6963AnnounceDetail = { info: Eip6963ProviderInfo; provider: unknown };

let installed = false;

export function installEip6963UuidGuard(): void {
  if (typeof window === "undefined" || installed) return;
  installed = true;
  const uuidByRdns = new Map<string, string>();
  window.addEventListener("eip6963:announceProvider", (e) => {
    const detail = (e as CustomEvent<Eip6963AnnounceDetail>).detail;
    const info = detail?.info;
    if (!info?.rdns || !info?.uuid) return; // malformed — not ours to police
    const canonical = uuidByRdns.get(info.rdns);
    if (!canonical) {
      uuidByRdns.set(info.rdns, info.uuid);
      return;
    }
    if (info.uuid === canonical) return; // spec-compliant (or our own re-dispatch)
    e.stopImmediatePropagation();
    window.dispatchEvent(
      new CustomEvent<Eip6963AnnounceDetail>("eip6963:announceProvider", {
        detail: Object.freeze({
          info: Object.freeze({ ...info, uuid: canonical }),
          provider: detail.provider,
        }),
      }),
    );
  });
}

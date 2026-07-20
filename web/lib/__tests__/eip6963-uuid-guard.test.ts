import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The guard's contract (see eip6963-uuid-guard.ts): per rdns, every announce a
// downstream listener sees carries ONE stable uuid, announces are never
// dropped, and spec-compliant traffic passes through untouched. Downstream is
// wagmi's mipd store, which dedupes by uuid only — so uuid stability is
// exactly what keeps one extension from rendering twice under "Installed".

type AnnounceDetail = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: unknown };

const ICON = "data:image/svg+xml;base64,PHN2Zy8+";

function announce(rdns: string, uuid: string, provider: unknown = {}) {
  window.dispatchEvent(
    new CustomEvent<AnnounceDetail>("eip6963:announceProvider", {
      detail: Object.freeze({ info: Object.freeze({ uuid, name: rdns, icon: ICON, rdns }), provider }),
    }),
  );
}

// Registered AFTER the guard, like mipd's listener in the real flow.
function collect(): AnnounceDetail[] {
  const seen: AnnounceDetail[] = [];
  window.addEventListener("eip6963:announceProvider", (e) => {
    seen.push((e as CustomEvent<AnnounceDetail>).detail);
  });
  return seen;
}

async function installGuard() {
  // Fresh module per test: the guard is a module-level singleton.
  const { installEip6963UuidGuard } = await import("../eip6963-uuid-guard");
  installEip6963UuidGuard();
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installEip6963UuidGuard", () => {
  it("rewrites per-announce uuids to the first-seen uuid, so uuid-dedupe keeps one entry", async () => {
    await installGuard();
    const seen = collect();
    announce("com.coinbase.wallet", "uuid-1");
    announce("com.coinbase.wallet", "uuid-2"); // Coinbase-style: fresh uuid per announce
    announce("com.coinbase.wallet", "uuid-3");
    expect(seen.map((d) => d.info.uuid)).toEqual(["uuid-1", "uuid-1", "uuid-1"]);
    // mipd-style consumer: dedupe by uuid → exactly one provider survives
    expect(new Set(seen.map((d) => d.info.uuid)).size).toBe(1);
  });

  it("re-announces keep propagating (rewritten, not dropped) — late stores can still discover", async () => {
    await installGuard();
    const early = collect();
    announce("com.coinbase.wallet", "uuid-1");
    // A store created later (HMR / second config) subscribes after the fact…
    const late = collect();
    announce("com.coinbase.wallet", "uuid-2");
    // …and still receives the re-announce, under the canonical uuid.
    expect(late).toHaveLength(1);
    expect(late[0].info.uuid).toBe("uuid-1");
    expect(early).toHaveLength(2);
  });

  it("leaves spec-compliant wallets untouched (same detail object, no re-dispatch)", async () => {
    await installGuard();
    const seen = collect();
    const provider = { request: () => {} };
    announce("io.metamask", "stable-uuid", provider);
    announce("io.metamask", "stable-uuid", provider);
    expect(seen).toHaveLength(2);
    expect(seen.every((d) => d.info.uuid === "stable-uuid" && d.provider === provider)).toBe(true);
  });

  it("keeps distinct wallets independent", async () => {
    await installGuard();
    const seen = collect();
    announce("io.metamask", "mm-uuid");
    announce("com.coinbase.wallet", "cb-uuid-1");
    announce("com.coinbase.wallet", "cb-uuid-2");
    announce("io.metamask", "mm-uuid");
    expect(seen.map((d) => `${d.info.rdns}:${d.info.uuid}`)).toEqual([
      "io.metamask:mm-uuid",
      "com.coinbase.wallet:cb-uuid-1",
      "com.coinbase.wallet:cb-uuid-1",
      "io.metamask:mm-uuid",
    ]);
  });

  it("is idempotent: double install emits one event per announce, not a rewrite storm", async () => {
    const { installEip6963UuidGuard } = await import("../eip6963-uuid-guard");
    installEip6963UuidGuard();
    installEip6963UuidGuard();
    const seen = collect();
    announce("com.coinbase.wallet", "uuid-1");
    announce("com.coinbase.wallet", "uuid-2");
    expect(seen).toHaveLength(2);
    expect(seen.map((d) => d.info.uuid)).toEqual(["uuid-1", "uuid-1"]);
  });

  it("passes malformed announces through without crashing", async () => {
    await installGuard();
    const seen: unknown[] = [];
    window.addEventListener("eip6963:announceProvider", (e) => {
      seen.push((e as CustomEvent).detail);
    });
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: undefined }));
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: { info: { name: "x" } } }));
    expect(seen).toHaveLength(2);
  });

  it("no-ops without window (SSR)", async () => {
    vi.unstubAllGlobals();
    const { installEip6963UuidGuard } = await import("../eip6963-uuid-guard");
    expect(() => installEip6963UuidGuard()).not.toThrow();
  });
});

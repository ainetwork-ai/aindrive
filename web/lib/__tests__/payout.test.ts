import { describe, it, expect } from "vitest";
import { resolvePayoutWallet } from "../payout";

describe("resolvePayoutWallet", () => {
  const rows = [
    { path: "", wallet: "0xROOT" },
    { path: "artists", wallet: "0xARTISTS" },
    { path: "artists/alice", wallet: "0xALICE" },
  ];

  it("picks the deepest ancestor wallet that covers the path", () => {
    expect(resolvePayoutWallet(rows, "artists/alice/song.mp3")).toBe("0xALICE");
    expect(resolvePayoutWallet(rows, "artists/alice")).toBe("0xALICE");
  });

  it("falls back to a shallower ancestor when no deeper one is set", () => {
    expect(resolvePayoutWallet(rows, "artists/bob/track.mp3")).toBe("0xARTISTS");
    expect(resolvePayoutWallet(rows, "artists")).toBe("0xARTISTS");
  });

  it("falls back to the root wallet for unrelated paths", () => {
    expect(resolvePayoutWallet(rows, "docs/readme.md")).toBe("0xROOT");
    expect(resolvePayoutWallet(rows, "")).toBe("0xROOT");
  });

  it("returns null when no ancestor (incl. root) has a wallet", () => {
    const noRoot = [{ path: "artists/alice", wallet: "0xALICE" }];
    expect(resolvePayoutWallet(noRoot, "docs/x.md")).toBeNull();
    expect(resolvePayoutWallet(noRoot, "artists")).toBeNull(); // alice is a descendant, not ancestor
    expect(resolvePayoutWallet([], "anything")).toBeNull();
  });

  it("a sibling's wallet never leaks across folders", () => {
    // artists/alice's wallet must NOT pay for artists/bob's sale.
    expect(resolvePayoutWallet(rows, "artists/bob")).toBe("0xARTISTS");
  });
});

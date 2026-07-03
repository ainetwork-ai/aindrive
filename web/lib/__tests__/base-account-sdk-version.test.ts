import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// @wagmi/connectors exact-pins @base-org/account, so without the package.json
// override the SDK silently freezes while Coinbase keeps evolving the
// keys.coinbase.com popup it talks to. Versions < 2.5.5 miss the
// findOwnerIndex fix (base/account-sdk#282): accounts with owner add/remove
// history — i.e. wallets created in the Base App — get a spurious "upgrade
// wallet" prompt whose add-owner tx reverts (AlreadyOwner), an infinite
// spinner. This guard fails if a dependency change ever re-freezes the SDK
// below that fix.
describe("@base-org/account resolved version", () => {
  it("is at least 2.5.5 (findOwnerIndex fix, account-sdk#282)", () => {
    // The SDK's exports map hides ./package.json, so resolve the entry file
    // and walk up to the package root.
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve("@base-org/account"));
    while (!dir.endsWith("@base-org/account")) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("@base-org/account package root not found");
      dir = parent;
    }
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
    const [major, minor, patch] = version.split(".").map(Number);
    expect(major).toBe(2); // major bump = intentional migration, revisit the override
    expect(minor * 1000 + patch).toBeGreaterThanOrEqual(5 * 1000 + 5);
  });
});

import { describe, it, expect } from "vitest";
import { mergeRoleUpgradeOnly } from "../access-core.js";

// CONSUME upserts drive_members(user, share.path, share.role) UPGRADE-ONLY:
// the persisted role is mergeRoleUpgradeOnly(existingRow?.role ?? "none", share.role).
describe("share CONSUME — upgrade-only role merge", () => {
  it("grants the share role when the caller has no existing row", () => {
    expect(mergeRoleUpgradeOnly("none", "viewer")).toBe("viewer");
    expect(mergeRoleUpgradeOnly("none", "editor")).toBe("editor");
  });

  it("upgrades a lower existing role to the share role", () => {
    expect(mergeRoleUpgradeOnly("viewer", "editor")).toBe("editor");
  });

  it("never downgrades a higher existing role", () => {
    expect(mergeRoleUpgradeOnly("editor", "viewer")).toBe("editor");
    expect(mergeRoleUpgradeOnly("owner", "viewer")).toBe("owner");
    expect(mergeRoleUpgradeOnly("owner", "editor")).toBe("owner");
  });

  it("is a no-op when roles are equal", () => {
    expect(mergeRoleUpgradeOnly("editor", "editor")).toBe("editor");
  });
});

import { describe, it, expect } from "vitest";
import { canRemoveMember } from "../member-guard";

describe("canRemoveMember", () => {
  it("allows removing a non-creator member", () => {
    expect(canRemoveMember({ memberUserId: "u2", driveOwnerId: "u1" })).toBe(true);
  });
  it("refuses to remove the drive creator's own row", () => {
    expect(canRemoveMember({ memberUserId: "u1", driveOwnerId: "u1" })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-willow-agent-"));
const { db } = await import("../db.js");
const { createDrive } = await import("../drives");
const { agentUser } = await import("../willow/agent-auth");

db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)").run("owner-1", "o@example.com", "Owner", "x");

describe("an agent on Willow sync", () => {
  it("is the drive owner when its agent token matches", async () => {
    const d = await createDrive("owner-1", "D");
    expect(await agentUser(d.driveId, `Bearer ${d.agentToken}`)).toBe("owner-1");
  });
  it("is nobody with a wrong, missing or other drive's token", async () => {
    const d = await createDrive("owner-1", "D");
    const other = await createDrive("owner-1", "E");
    expect(await agentUser(d.driveId, "Bearer nope")).toBeNull();
    expect(await agentUser(d.driveId, undefined)).toBeNull();
    expect(await agentUser(d.driveId, `Bearer ${other.agentToken}`)).toBeNull();
    expect(await agentUser("missing", `Bearer ${d.agentToken}`)).toBeNull();
  });
});

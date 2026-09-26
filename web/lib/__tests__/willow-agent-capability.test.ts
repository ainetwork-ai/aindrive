import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AINDRIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "aindrive-willow-cap-"));
const { recordAgentHello, agentMaterializes, forgetAgentCapabilities } = await import("../agents.js");

describe("an agent that materialises documents", () => {
  it("is known from its hello, and forgotten when it goes", () => {
    expect(agentMaterializes("d1")).toBe(false);
    recordAgentHello("d1", { type: "agent-hello", hostname: "mac", capabilities: ["willow"] });
    expect(agentMaterializes("d1")).toBe(true);
    recordAgentHello("d2", { type: "agent-hello", hostname: "old-cli" }); // an old agent says nothing
    expect(agentMaterializes("d2")).toBe(false);
    forgetAgentCapabilities("d1");
    expect(agentMaterializes("d1")).toBe(false);
  });
});

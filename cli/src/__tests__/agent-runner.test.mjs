// Characterization tests for agent-runner.js — agent-first migration safety net.
//
// These SNAPSHOT the *current* behaviour (probed against the real module, not an
// assumed spec) so a later refactor can be proven behaviour-preserving.
//
// runAgentAsk's input-validation + agent-load layer runs BEFORE the KB/LLM call,
// so it is fully deterministic and testable without any network/model injection.
// The success path (which calls resolveKnowledgeBase + resolveLlmClient) is NOT
// covered here — it has no exported seam to inject fakes without a source change.
// The one pure helper that shapes the LLM prompt (buildSystemPrompt) is covered
// separately once exported (see agent.test.mjs sibling / the export seam).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentAsk } from "../agent-runner.js";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-runner-char-"));
});

describe("runAgentAsk — agentId validation (regex /^agt_[A-Za-z0-9_-]{6,32}$/)", () => {
  it("rejects a non-string agentId with bad_agent_id:<value>", async () => {
    await expect(runAgentAsk({ root, agentId: 123, query: "q" }))
      .rejects.toThrow("bad_agent_id:123");
  });

  it("rejects a wrong prefix", async () => {
    await expect(runAgentAsk({ root, agentId: "xyz_abcdef", query: "q" }))
      .rejects.toThrow("bad_agent_id:xyz_abcdef");
  });

  it("rejects too-few chars after the agt_ prefix (needs 6-32)", async () => {
    await expect(runAgentAsk({ root, agentId: "agt_abc", query: "q" }))
      .rejects.toThrow("bad_agent_id:agt_abc");
  });

  it("rejects more than 32 chars after the prefix", async () => {
    const tooLong = "agt_" + "a".repeat(33);
    await expect(runAgentAsk({ root, agentId: tooLong, query: "q" }))
      .rejects.toThrow(`bad_agent_id:${tooLong}`);
  });
});

describe("runAgentAsk — query validation (runs after a valid agentId)", () => {
  it("rejects an empty query with empty_query", async () => {
    await expect(runAgentAsk({ root, agentId: "agt_abcdef", query: "" }))
      .rejects.toThrow("empty_query");
  });

  it("rejects a non-string query with empty_query", async () => {
    await expect(runAgentAsk({ root, agentId: "agt_abcdef", query: undefined }))
      .rejects.toThrow("empty_query");
  });
});

describe("runAgentAsk — agent.json load (runs after id + query pass)", () => {
  it("throws agent_not_found:<id> (ENOENT) when no agent file exists", async () => {
    await expect(runAgentAsk({ root, agentId: "agt_abcdef", query: "hi" }))
      .rejects.toThrow("agent_not_found:agt_abcdef");
  });

  it("throws agent_load_failed:<reason> when the agent.json is corrupt", async () => {
    mkdirSync(join(root, ".aindrive", "agents"), { recursive: true });
    writeFileSync(join(root, ".aindrive", "agents", "agt_corrupt1.json"), "{bad");
    await expect(runAgentAsk({ root, agentId: "agt_corrupt1", query: "hi" }))
      // exact parse-error text is Node-version specific; lock only the prefix
      .rejects.toThrow(/^agent_load_failed:/);
  });
});

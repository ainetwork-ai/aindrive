/**
 * runAgentAsk — the actual agent execution that happens on the owner's
 * machine. Loads the agent JSON locally, runs the configured KB, calls
 * the configured LLM, returns { answer, sources }.
 *
 * Called from cli/src/rpc.js when a `agent-ask` RPC arrives. The web
 * side has already verified caller identity + access policy; this
 * function is the trusted runner.
 *
 * API key never leaves this process — that's the whole point of
 * putting agent execution here instead of on the web server.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import { resolveKnowledgeBase } from "./knowledge/factory.js";
import { resolveLlmClient } from "./llm/factory.js";

const AGENT_DIR = ".aindrive/agents";

export async function runAgentAsk({ root, agentId, query }) {
  if (typeof agentId !== "string" || !/^agt_[A-Za-z0-9_-]{6,32}$/.test(agentId)) {
    // Mirrors web/shared/domain/agent/types.ts isAgentId. Inlined here because
    // CLI is plain ESM JS and doesn't compile web/shared/*.ts.
    throw new Error(`bad_agent_id:${agentId}`);
  }
  if (typeof query !== "string" || query.length === 0) {
    throw new Error("empty_query");
  }

  // 1. Load agent.json from disk
  const agentPath = path.join(root, AGENT_DIR, `${agentId}.json`);
  let agent;
  try {
    const raw = await fsp.readFile(agentPath, "utf8");
    agent = JSON.parse(raw);
  } catch (e) {
    if (e && e.code === "ENOENT") throw new Error(`agent_not_found:${agentId}`);
    throw new Error(`agent_load_failed:${e?.message || e}`);
  }

  // 2. Knowledge fetch (local fs walk; ignores .aindrive/)
  const kb = resolveKnowledgeBase(agent.knowledge);
  const chunks = await kb.fetch({ root, agent, query });

  // 3. LLM call (Flock / OpenAI / ...)
  const llm = resolveLlmClient(agent.llm);
  const answer = await llm.complete({
    system: buildSystemPrompt(agent, chunks),
    user: query,
  });

  return {
    answer,
    sources: chunks.map((c) => {
      const src = {
        path: c.path,
        snippet: c.text.length > 280 ? c.text.slice(0, 280) + "…" : c.text,
      };
      if (typeof c.lineStart === "number") src.lineStart = c.lineStart;
      if (typeof c.lineEnd === "number") src.lineEnd = c.lineEnd;
      return src;
    }),
  };
}

function buildSystemPrompt(agent, chunks) {
  const knowledge = chunks.length === 0
    ? "(no knowledge available — the folder is empty or contains no readable text files)"
    : chunks.map((c) => `── ${c.path} ──\n${c.text}`).join("\n\n");
  return [
    `You are "${agent.name || "agent"}", an AI assistant answering questions strictly from the documents below.`,
    `Rules:`,
    `  - Answer ONLY using the documents. Do not invent facts.`,
    `  - If the answer is not in the documents, reply exactly: "I don't see that in this folder."`,
    `  - Cite source files in parentheses, e.g. "(see docs/q1-okr.md)".`,
    `  - Keep answers concise.`,
    ``,
    `DOCUMENTS:`,
    knowledge,
  ].join("\n");
}

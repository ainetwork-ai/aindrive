/**
 * Single source of truth for the names that appear in agent JSON
 * (`knowledge.strategy`, `llm.provider`, `access.policies[]`).
 *
 * Web validates incoming create requests against these. CLI's actual
 * impl factories must stay in sync (a name listed here but missing
 * from CLI's resolveLlmClient/resolveKnowledgeBase will surface as
 * agent_misconfigured at ask time).
 */

export const KNOWLEDGE_STRATEGIES = ["dump-all-text"] as const;
export type KnowledgeStrategy = (typeof KNOWLEDGE_STRATEGIES)[number];

export const LLM_PROVIDERS = ["openai", "flock"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const POLICY_NAMES = ["owner", "cap-holder"] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];

export const isKnowledgeStrategy = (s: string): s is KnowledgeStrategy =>
  (KNOWLEDGE_STRATEGIES as readonly string[]).includes(s);
export const isLlmProvider = (s: string): s is LlmProvider =>
  (LLM_PROVIDERS as readonly string[]).includes(s);
export const isPolicyName = (s: string): s is PolicyName =>
  (POLICY_NAMES as readonly string[]).includes(s);

/**
 * resolveKnowledgeBase — picks the right KB impl per KnowledgeConfig.
 *
 * v1 registry: "dump-all-text". Adding strategies = entry here.
 */

import { dumpAllTextKb } from "./dump-all-text-kb.js";

const REGISTRY = {
  "dump-all-text": dumpAllTextKb,
  // future:
  // "vector-rag": vectorRagKb,
  // "hybrid":     hybridKb,
};

export function resolveKnowledgeBase(config) {
  const strategy = config?.strategy;
  const kb = REGISTRY[strategy];
  if (!kb) throw new Error(`unknown_knowledge_strategy:${strategy}`);
  return kb;
}

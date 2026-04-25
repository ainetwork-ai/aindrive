/**
 * KnowledgeBaseFactory — dispatches to the right impl by `strategy` key.
 *
 * Adding a new strategy = register here. askAgent never sees the change.
 */

import type {
  FsBrowser,
  KnowledgeBase,
  KnowledgeBaseFactory,
} from "../../../../shared/domain/agent/ports.js";
import type { KnowledgeConfig } from "../../../../shared/domain/agent/types.js";
import { dumpAllTextKb } from "./dump-all-text-kb.js";

export const knowledgeBaseFactory = (fs: FsBrowser): KnowledgeBaseFactory => {
  const registry: Record<string, KnowledgeBase> = {
    "dump-all-text": dumpAllTextKb(fs),
    // future:
    // "vector-rag": vectorRagKb(fs, embedder, vectorStore),
    // "hybrid":     hybridKb(fs, ...),
  };

  return {
    make(config: KnowledgeConfig): KnowledgeBase {
      const kb = registry[config.strategy];
      if (!kb) throw new Error(`unknown_knowledge_strategy:${config.strategy}`);
      return kb;
    },
  };
};

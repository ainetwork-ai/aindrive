/**
 * KnowledgeBase v1: dump every text-ish file under the agent's folder
 * and hand the LLM the lot. Ignores the query.
 *
 * Why this is the v1 default:
 *   - Zero infrastructure (no embeddings, no index store)
 *   - Demo folders are 5-10 small markdown files → fits in any model's context
 *   - Forward-compatible: returns KnowledgeChunk[], so swapping in a real
 *     RAG impl later changes only this factory wire, not askAgent.
 *
 * When to switch:
 *   - Folder size pushes past ~50KB total → context window pain
 *   - Latency / cost of sending whole folder per query starts mattering
 *   → swap with VectorRagKb impl, no other code changes.
 */

import type { Agent } from "../../../../shared/domain/agent/types.js";
import type {
  FsBrowser,
  KnowledgeBase,
  KnowledgeChunk,
  FileEntry,
} from "../../../../shared/domain/agent/ports.js";

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "log", "csv", "tsv"]);

/** Hard cap so a misconfigured agent can't blow the context window. */
const MAX_TOTAL_BYTES = 256 * 1024;
/** Per-file read cap; CLI also enforces 8MB but we want to be polite. */
const MAX_PER_FILE_BYTES = 64 * 1024;

export const dumpAllTextKb = (fs: FsBrowser): KnowledgeBase => ({
  async fetch({ agent }: { agent: Agent; query: string }): Promise<KnowledgeChunk[]> {
    const out: KnowledgeChunk[] = [];
    let totalBytes = 0;

    async function walk(p: string): Promise<void> {
      let entries: FileEntry[];
      try {
        entries = await fs.list(agent.driveId, p);
      } catch {
        return; // missing / unreadable folder → skip silently
      }
      for (const entry of entries) {
        if (totalBytes >= MAX_TOTAL_BYTES) return;
        if (entry.isDir) {
          await walk(entry.path);
          continue;
        }
        if (!TEXT_EXTENSIONS.has(entry.ext)) continue;
        const remaining = MAX_TOTAL_BYTES - totalBytes;
        const cap = Math.min(MAX_PER_FILE_BYTES, remaining);
        try {
          const text = await fs.read(agent.driveId, entry.path, cap);
          out.push({ path: entry.path, text });
          totalBytes += Buffer.byteLength(text, "utf8");
        } catch {
          // skip files that fail to read
        }
      }
    }

    await walk(agent.folder);
    return out;
  },
});

/**
 * KnowledgeBase v1 (CLI side): walk agent.folder via node:fs and read
 * every text-ish file. No retrieval, no scoring — the LLM gets the lot.
 *
 * Caps:
 *   MAX_TOTAL_BYTES per ask  → keeps context window sane
 *   MAX_PER_FILE_BYTES per file → fairness across files
 *
 * Skips `.aindrive/` (system files, including the agent JSON itself
 * and llm.apiKey — we don't feed our own secrets back to the LLM).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".log", ".csv", ".tsv"]);
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_PER_FILE_BYTES = 64 * 1024;

export const dumpAllTextKb = {
  /**
   * @param {{ root: string, agent: { folder?: string }, query: string }} ctx
   * @returns {Promise<Array<{ path: string, text: string }>>}
   */
  async fetch({ root, agent }) {
    const out = [];
    let total = 0;

    async function walk(rel) {
      if (total >= MAX_TOTAL_BYTES) return;
      const dirAbs = rel ? path.join(root, rel) : root;
      let entries;
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (total >= MAX_TOTAL_BYTES) return;
        if (e.name === ".aindrive" || e.name === ".git" || e.name === ".DS_Store") continue;
        const subRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(subRel);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!TEXT_EXTS.has(ext)) continue;
        const remaining = MAX_TOTAL_BYTES - total;
        const cap = Math.min(MAX_PER_FILE_BYTES, remaining);
        try {
          const buf = await fsp.readFile(path.join(root, subRel));
          const text = buf.length > cap ? buf.subarray(0, cap).toString("utf8") : buf.toString("utf8");
          out.push({ path: subRel, text });
          total += Buffer.byteLength(text, "utf8");
        } catch {
          // skip unreadable files
        }
      }
    }

    await walk(agent.folder || "");
    return out;
  },
};

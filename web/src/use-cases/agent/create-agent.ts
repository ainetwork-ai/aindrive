/**
 * createAgent — owner registers a new agent over a folder of their drive.
 *
 * Pure use-case: input contains everything needed (caller is pre-verified
 * as owner, namespacePub pre-fetched by the route from the drives table).
 * No DB or HTTP touched here.
 *
 * Validates the config shape (so a bad UI doesn't write garbage into the
 * drive) and writes the agent JSON via AgentRepo.
 */

import type { AgentRepo } from "../../../../shared/domain/agent/ports.js";
import type {
  AccessConfig,
  Agent,
  DriveId,
  KnowledgeConfig,
  LlmConfig,
  UserId,
} from "../../../../shared/domain/agent/types.js";
import { isSystemPath } from "../../../../shared/domain/policy/system-paths.js";
import {
  isKnowledgeStrategy,
  isLlmProvider,
  isPolicyName,
} from "../../../../shared/domain/agent/registry.js";

export type CreateAgentDeps = { agents: AgentRepo };

export type CreateAgentInput = {
  driveId: DriveId;
  /** Verified by the route layer (= drive.owner_id). */
  ownerId: UserId;
  /** Read by the route from drives.namespace_pubkey (lazy-created if null). */
  namespacePub: Uint8Array;
  folder: string;
  name: string;
  description: string;
  knowledge: KnowledgeConfig;
  llm: LlmConfig;
  access: AccessConfig;
};

export type CreateAgentOutput =
  | { kind: "ok"; agent: Agent }
  | { kind: "rejected"; reason: string };

const NAME_MAX = 80;
const DESC_MAX = 500;
const FOLDER_MAX = 1024;

export async function createAgent(
  deps: CreateAgentDeps,
  input: CreateAgentInput,
): Promise<CreateAgentOutput> {
  // ─── input validation ────────────────────────────────────────────────
  const name = (input.name ?? "").trim();
  if (!name) return reject("name_required");
  if (name.length > NAME_MAX) return reject("name_too_long");

  const description = (input.description ?? "").trim();
  if (description.length > DESC_MAX) return reject("description_too_long");

  const folder = normalizeFolder(input.folder);
  if (folder.length > FOLDER_MAX) return reject("folder_too_long");
  if (folder.includes("..") || folder.startsWith("/")) {
    return reject("folder_invalid");
  }
  if (isSystemPath(folder)) return reject("folder_reserved");

  if (!input.knowledge || !isKnowledgeStrategy(input.knowledge.strategy)) {
    return reject(`unknown_knowledge_strategy:${input.knowledge?.strategy}`);
  }

  if (!input.llm || !isLlmProvider(input.llm.provider)) {
    return reject(`unknown_llm_provider:${input.llm?.provider}`);
  }
  if (!input.llm.model || typeof input.llm.model !== "string") {
    return reject("llm_model_required");
  }

  if (!input.access?.policies?.length) {
    return reject("access_policies_required");
  }
  for (const p of input.access.policies) {
    if (!isPolicyName(p)) return reject(`unknown_policy:${p}`);
  }

  // ─── persist ─────────────────────────────────────────────────────────
  try {
    const agent = await deps.agents.create({
      driveId: input.driveId,
      ownerId: input.ownerId,
      folder,
      name,
      description,
      namespacePub: input.namespacePub,
      knowledge: input.knowledge,
      llm: input.llm,
      access: input.access,
    });
    return { kind: "ok", agent };
  } catch (e) {
    return reject(`create_failed:${(e as Error).message}`);
  }
}

function reject(reason: string): CreateAgentOutput {
  return { kind: "rejected", reason };
}

/** Trim leading/trailing slash, collapse repeats. "" = whole drive. */
function normalizeFolder(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

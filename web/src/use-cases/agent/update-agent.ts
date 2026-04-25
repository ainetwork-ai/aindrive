/**
 * updateAgent — owner-only edit of an existing agent's editable fields.
 *
 * Immutable: id, driveId, ownerId, namespacePub, createdAt.
 * Editable:  name, description, persona, folder, knowledge, llm, access.
 *
 * apiKey / persona semantics:
 *   - undefined in patch  → keep existing
 *   - "" (empty)           → clear existing (apiKey falls back to env;
 *                            persona falls back to DEFAULT_AGENT_PERSONA)
 *   - non-empty           → replace
 */

import type { AgentRepo } from "@/shared/domain/agent/ports";
import type {
  AccessConfig,
  Agent,
  AgentId,
  DriveId,
  KnowledgeConfig,
  LlmConfig,
  UserId,
} from "@/shared/domain/agent/types";
import { PERSONA_MAX } from "@/shared/domain/agent/types";
import { isSystemPath } from "@/shared/domain/policy/system-paths";
import {
  isKnowledgeStrategy,
  isLlmProvider,
  isPolicyName,
} from "@/shared/domain/agent/registry";

export type UpdateAgentDeps = { agents: AgentRepo };

export type UpdateAgentInput = {
  driveId: DriveId;
  agentId: AgentId;
  ownerId: UserId;
  patch: {
    name?: string;
    description?: string;
    persona?: string;
    folder?: string;
    knowledge?: KnowledgeConfig;
    llm?: Partial<LlmConfig>;
    access?: AccessConfig;
  };
};

export type UpdateAgentOutput =
  | { kind: "ok"; agent: Agent }
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "rejected"; reason: string };

const NAME_MAX = 80;
const DESC_MAX = 500;
const FOLDER_MAX = 1024;

export async function updateAgent(
  deps: UpdateAgentDeps,
  input: UpdateAgentInput,
): Promise<UpdateAgentOutput> {
  const existing = await deps.agents.byId(input.driveId, input.agentId);
  if (!existing) return { kind: "not-found" };
  if (existing.ownerId !== input.ownerId) return { kind: "forbidden" };

  const next: Agent = { ...existing };

  if (input.patch.name !== undefined) {
    const name = input.patch.name.trim();
    if (!name) return reject("name_required");
    if (name.length > NAME_MAX) return reject("name_too_long");
    next.name = name;
  }

  if (input.patch.description !== undefined) {
    const description = input.patch.description.trim();
    if (description.length > DESC_MAX) return reject("description_too_long");
    next.description = description;
  }

  if (input.patch.folder !== undefined) {
    const folder = normalizeFolder(input.patch.folder);
    if (folder.length > FOLDER_MAX) return reject("folder_too_long");
    if (folder.includes("..") || folder.startsWith("/")) return reject("folder_invalid");
    if (isSystemPath(folder)) return reject("folder_reserved");
    next.folder = folder;
  }

  if (input.patch.knowledge) {
    if (!isKnowledgeStrategy(input.patch.knowledge.strategy)) {
      return reject(`unknown_knowledge_strategy:${input.patch.knowledge.strategy}`);
    }
    next.knowledge = input.patch.knowledge;
  }

  if (input.patch.llm) {
    const llm: LlmConfig = { ...next.llm, ...input.patch.llm };
    if (!isLlmProvider(llm.provider)) return reject(`unknown_llm_provider:${llm.provider}`);
    if (!llm.model) return reject("llm_model_required");
    // apiKey: explicit "" clears, undefined keeps, non-empty replaces
    if (input.patch.llm.apiKey === "") delete (llm as Partial<LlmConfig>).apiKey;
    next.llm = llm;
  }

  if (input.patch.access) {
    if (!input.patch.access.policies?.length) return reject("access_policies_required");
    for (const p of input.patch.access.policies) {
      if (!isPolicyName(p)) return reject(`unknown_policy:${p}`);
    }
    next.access = input.patch.access;
  }

  try {
    const saved = await deps.agents.update(next);
    return { kind: "ok", agent: saved };
  } catch (e) {
    return reject(`update_failed:${(e as Error).message}`);
  }
}

function reject(reason: string): UpdateAgentOutput {
  return { kind: "rejected", reason };
}

function normalizeFolder(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

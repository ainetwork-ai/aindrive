/**
 * AgentRepo implementation that stores each agent as a JSON file at
 *   <drive>/.aindrive/agents/<id>.json
 *
 * No DB. Agent travels with the drive. cap-bearers are kept out of
 * .aindrive/ at the HTTP middleware layer (see system-paths.ts) — this
 * repo runs server-side and bypasses that gate.
 */

import { nanoid } from "nanoid";
import {
  AGENT_ID_PREFIX,
  isAgentId,
  type Agent,
  type AgentId,
  type DriveId,
  type NewAgentInput,
} from "@/shared/domain/agent/types";
import type {
  AgentRepo,
  FsBrowser,
} from "@/shared/domain/agent/ports";

const AGENT_DIR = ".aindrive/agents";

type StoredAgent = Omit<Agent, "namespacePub"> & { namespacePub: string };

function serialize(a: Agent): StoredAgent {
  return { ...a, namespacePub: Buffer.from(a.namespacePub).toString("base64url") };
}

function deserialize(s: StoredAgent): Agent {
  return { ...s, namespacePub: new Uint8Array(Buffer.from(s.namespacePub, "base64url")) };
}

function agentPath(id: AgentId): string {
  if (!isAgentId(id)) throw new Error(`bad_agent_id:${id}`);
  return `${AGENT_DIR}/${id}.json`;
}

export const fsAgentRepo = (fs: FsBrowser): AgentRepo => ({
  async byId(driveId: DriveId, id: AgentId): Promise<Agent | null> {
    try {
      const json = await fs.read(driveId, agentPath(id));
      return deserialize(JSON.parse(json) as StoredAgent);
    } catch {
      // Could be missing file, malformed JSON, agent offline, etc. Treat
      // all as "not found" — caller maps to 404. Logging happens at the
      // FsBrowser layer, not here.
      return null;
    }
  },

  async listByDrive(driveId: DriveId): Promise<Agent[]> {
    let entries;
    try {
      entries = await fs.list(driveId, AGENT_DIR);
    } catch {
      return []; // dir doesn't exist yet → no agents
    }
    const jsonFiles = entries.filter((e) => !e.isDir && e.path.endsWith(".json"));
    const out: Agent[] = [];
    await Promise.all(
      jsonFiles.map(async (e) => {
        try {
          const json = await fs.read(driveId, e.path);
          out.push(deserialize(JSON.parse(json) as StoredAgent));
        } catch {
          // skip unreadable / corrupt entries
        }
      }),
    );
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  },

  async create(input: NewAgentInput): Promise<Agent> {
    const id: AgentId = `${AGENT_ID_PREFIX}${nanoid(10)}`;
    const agent: Agent = { ...input, id, createdAt: Date.now() };
    await fs.write(
      input.driveId,
      agentPath(id),
      JSON.stringify(serialize(agent), null, 2),
    );
    return agent;
  },
});

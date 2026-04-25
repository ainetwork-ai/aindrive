/**
 * FsBrowser implementation backed by the existing legacy WSS RPC bridge.
 *
 * Forwards list/read/write to `web/lib/agents.js#sendRpc` which routes
 * the request to the drive's connected CLI agent. Returns plain
 * domain types (FileEntry / string).
 *
 * NOTE: this is the unprivileged path — it does NOT enforce the
 * .aindrive/ block on its own. The block lives in the cap-bearer
 * HTTP middleware so server-internal code (e.g. FsAgentRepo) can
 * legitimately read .aindrive/agents/*.json without tripping it.
 */

import { sendRpc } from "../../../lib/agents.js";
import type {
  FileEntry,
  FsBrowser,
} from "../../../../shared/domain/agent/ports.js";
import type { DriveId } from "../../../../shared/domain/agent/types.js";

/** Limits passed to read; matches CLI agent's LIMITS.maxReadBytes default. */
const DEFAULT_READ_MAX = 8 * 1024 * 1024;

export const rpcFsBrowser: FsBrowser = {
  async list(driveId: DriveId, path: string): Promise<FileEntry[]> {
    const r = await sendRpc(driveId, { method: "list", path });
    return r.entries.map((e) => ({
      path: e.path,
      isDir: e.isDir,
      size: e.size,
      ext: e.ext,
    }));
  },

  async read(driveId: DriveId, path: string, maxBytes?: number): Promise<string> {
    const r = await sendRpc(driveId, {
      method: "read",
      path,
      encoding: "utf8",
      maxBytes: maxBytes ?? DEFAULT_READ_MAX,
    });
    return r.content;
  },

  async write(driveId: DriveId, path: string, content: string): Promise<void> {
    await sendRpc(driveId, { method: "write", path, content, encoding: "utf8" });
  },
};

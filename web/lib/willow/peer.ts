// web/lib/willow/peer.ts
// The server as one Willow peer (spec §6): a store per drive, one SyncSession per
// socket. At ingest it checks, for every entry from any device: the signature
// (the store's scheme), who the device is (certificates in the store), and that
// person's role on the path — the same rule the HTTP routes use.
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { partsOf, toHex } from "@/shared/willow/bytes";
import { resolvePerson, certsFrom, type Cert } from "@/shared/willow/cert";
import { mayWrite } from "@/shared/willow/policy";
import { clientClaimConflict } from "@/shared/willow/doc";
import { nowMicros } from "@/shared/willow/schemes";
import { SyncSession, fullRange } from "@/shared/willow/session";
import type { AnyStore } from "@/shared/willow/doc";
import type { WireEntry } from "@/shared/willow/wire";
import { dataDir } from "@/lib/env";
import { openDriveStore } from "./store-node";
import { trust } from "./attestation";
import { roleOf, blockedByPaywall } from "./roles";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const RANK: Record<string, number> = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 };
const WRITE = RANK.editor;

async function certsIn(store: AnyStore): Promise<Cert[]> {
  const raw: { subspaceHex: string; payload: Uint8Array }[] = [];
  const enc = new TextEncoder();
  for await (const [entry, payload] of store.queryRange({ ...fullRange(), pathRange: { start: [enc.encode("_id")], end: [enc.encode("_id\u0000")] } }, "oldest")) {
    if (partsOf(entry.path)[1] !== "cert" || !payload) continue;
    raw.push({ subspaceHex: toHex(entry.subspaceId), payload: await payload.bytes() });
  }
  return certsFrom(raw); // shape-checked, and only certs in their own device's subspace (review I4)
}

export function acceptFor(driveId: string, store: AnyStore) {
  return async (w: WireEntry): Promise<string | null> => {
    const parts = partsOf(w.entry.path);
    const subspace = toHex(w.entry.subspaceId);
    const now = nowMicros();
    if (parts[0] === "_id") {
      let cert: Cert | undefined;
      if (parts[1] === "cert") {
        const parsed = certsFrom([{ subspaceHex: subspace, payload: w.payload ?? new Uint8Array() }]);
        if (!parsed.length) return "bad-cert";
        cert = parsed[0];
      }
      const v = await mayWrite({ subspaceHex: subspace, path: parts, timestamp: w.entry.timestamp, payloadLength: w.entry.payloadLength, cert },
        { driveId, ownerUserId: "", grants: [], certs: await certsIn(store), revocations: [], trust: trust(), now });
      return v.ok ? null : v.reason === "unknown-device" && parts[1] === "cert" ? "bad-cert" : v.reason;
    }
    if (parts[0] !== "doc") return "outside-grant";
    const person = await resolvePerson(subspace, await certsIn(store), [], trust(), now > w.entry.timestamp ? now : w.entry.timestamp);
    if (!person) return "unknown-device";
    const u = parts.indexOf("~u");
    const docPath = parts.slice(1, u < 0 ? parts.length : u);
    if ((RANK[roleOf(driveId, person.userId, docPath.join("/"))] ?? 0) < WRITE) return "not-a-member";
    if (w.payload && (await clientClaimConflict(store, docPath, subspace, w.payload))) return "client-id-taken"; // review I5
    return null;
  };
}

export function storeDir() {
  const dir = join(dataDir(), "willow");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** WS /api/willow/sync?drive=<id> — one sync session for a signed-in member. */
export async function onWillowSync(ws: WebSocket, _req: IncomingMessage, query: Record<string, unknown>, userId: string | null) {
  const driveId = String(query.drive ?? "");
  if (!driveId || (RANK[roleOf(driveId, userId, "")] ?? 0) < RANK.viewer) { ws.close(4401, "no access"); return; }
  if (blockedByPaywall(driveId, userId)) { ws.close(4402, "payment required"); return; }
  const store = openDriveStore(driveId, storeDir());
  const listeners: ((f: never) => void)[] = [];
  const closers: (() => void)[] = [];
  ws.on("message", (data) => { let f; try { f = JSON.parse(data.toString("utf8")); } catch { return; } for (const cb of listeners) cb(f as never); });
  ws.on("close", () => closers.forEach((c) => c()));
  const session = new SyncSession({
    store,
    ranges: [fullRange()],
    accept: acceptFor(driveId, store),
    channel: {
      send: (f) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)); },
      onFrame: (cb) => listeners.push(cb as never),
      onClose: (cb) => closers.push(cb),
    },
  });
  await session.start();
}

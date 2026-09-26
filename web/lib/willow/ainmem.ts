// ainmem's signed page edits in a drive's store (ainmem docs/willow-ainmem-plan.md Task 3).
//
// An ainmem teamspace linked to this drive signs each transaction with the editing
// browser's device key as the entry ["ainmem", teamspaceId, pageId, txId]. ainmem's
// server hands them in here (ingestEntries) as the account that linked the drive; each
// entry passes the same ingest check as sync (acceptFor), vouched by that account.
// ainmemAuthors reads back who signed each transaction of a page, verified.
import { db } from "@/lib/db.js";
import { partsOf, toHex, utf8 } from "@/shared/willow/bytes";
import { resolvePerson } from "@/shared/willow/cert";
import { certsIn, revocationsIn } from "@/shared/willow/doc";
import { namespaceOf } from "@/shared/willow/schemes";
import { decodeEntry, type WireEntry } from "@/shared/willow/wire";
import { ANY_SUBSPACE, OPEN_END, type Area } from "@jsr/earthstar__willow-utils";
import { openDriveStore } from "./store-node";
import { acceptFor, storeDir } from "./peer";
import { roleOf } from "./roles";
import { trust } from "./attestation";

export const INGEST_MAX = 200;
const RANK: Record<string, number> = { none: 0, viewer: 1, commenter: 2, editor: 3, owner: 4 };

function decode(driveId: string, j: unknown): WireEntry | null {
  const o = j as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  if (typeof o.s !== "string" || !Array.isArray(o.p) || typeof o.ts !== "string" || typeof o.n !== "string" || typeof o.d !== "string" || typeof o.tok !== "string") return null;
  if (o.pl !== undefined && typeof o.pl !== "string") return null;
  try {
    const w = decodeEntry(o, namespaceOf(driveId));
    return w.entry.subspaceId.length === 32 && w.entry.payloadDigest.length === 32 ? w : null;
  } catch {
    return null;
  }
}

/** One verdict per entry, in order: null = stored (or already there), else why not. */
export async function ingestEntries(driveId: string, callerId: string, entries: unknown[]): Promise<(string | null)[]> {
  if ((RANK[roleOf(driveId, callerId, "")] ?? 0) < RANK.editor) return entries.map(() => "not-a-member");
  const store = openDriveStore(driveId, storeDir());
  const accept = acceptFor(driveId, store, { vouchedBy: callerId });
  const out: (string | null)[] = [];
  for (const j of entries.slice(0, INGEST_MAX)) {
    const w = decode(driveId, j);
    if (!w) { out.push("malformed"); continue; }
    const parts = partsOf(w.entry.path);
    const cert = parts[0] === "_id" && parts[1] === "cert" && parts.length === 2;
    if (!cert && parts[0] !== "ainmem") { out.push("outside-grant"); continue; }
    if (!w.payload || BigInt(w.payload.length) !== w.entry.payloadLength) { out.push("malformed"); continue; }
    const why = await accept(w);
    if (why) { out.push(why); continue; }
    const r = await store.ingestEntry(w.entry, w.token);
    if (r.kind === "failure") { out.push(r.reason ?? "invalid"); continue; }
    if (r.kind === "success") {
      async function* one(b: Uint8Array) { yield b; }
      await store.ingestPayload({ path: w.entry.path, timestamp: w.entry.timestamp, subspace: w.entry.subspaceId }, one(w.payload));
    }
    out.push(null); // "no_op": the same (or a newer) entry is already there
  }
  while (out.length < entries.length) out.push("too-many");
  return out;
}

export type AinmemAuthor = { tx: string; userId: string; name: string | null; strength: "wallet" | "attested"; device: string; at: number };

/** Who signed each transaction of a page, as the store's certificates and revocations
 *  say now; entries from devices that no longer resolve are left out. */
export async function ainmemAuthors(driveId: string, teamspaceId: string, pageId: string): Promise<AinmemAuthor[]> {
  const store = openDriveStore(driveId, storeDir());
  const certs = await certsIn(store), revs = await revocationsIn(store);
  const area = { includedSubspaceId: ANY_SUBSPACE, pathPrefix: [utf8("ainmem"), utf8(teamspaceId), utf8(pageId)], timeRange: { start: 0n, end: OPEN_END } } as Area<Uint8Array>;
  const names = new Map<string, string | null>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, (db.prepare("SELECT name FROM users WHERE id = ?").get(id) as { name?: string } | undefined)?.name ?? null);
    return names.get(id)!;
  };
  const out: AinmemAuthor[] = [];
  for await (const [entry] of store.query({ area, maxCount: 0, maxSize: 0n }, "timestamp")) {
    const parts = partsOf(entry.path);
    if (parts.length !== 4) continue;
    const device = toHex(entry.subspaceId);
    const p = await resolvePerson(device, certs, revs, trust(), entry.timestamp);
    if (!p) continue;
    out.push({ tx: parts[3], userId: p.userId, name: nameOf(p.userId), strength: p.strength, device, at: Number(entry.timestamp / 1000n) });
  }
  return out;
}

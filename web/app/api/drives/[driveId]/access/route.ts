import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { isAddress } from "viem";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive, getDriveNamespace } from "@/lib/drives";
import { issueShareCap } from "@/lib/willow/cap-issue";
import { zPath } from "@/lib/zod-helpers";
import { normalizePath } from "@/lib/path";

const Body = z.object({
  wallet_address: z.string().refine((v) => isAddress(v), "invalid address"),
  path: zPath.default(""),
  role: z.enum(["viewer", "commenter", "editor"]).default("viewer"),
});

export async function GET(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  let path: string | null = null;
  if (rawPath !== null) {
    try { path = normalizePath(rawPath); }
    catch { return NextResponse.json({ error: "invalid path" }, { status: 400 }); }
  }
  const rows = path === null
    ? db.prepare("SELECT id, path, wallet_address, added_by, payment_tx, role, added_at FROM folder_access WHERE drive_id = ? ORDER BY added_at DESC").all(driveId)
    : db.prepare("SELECT id, path, wallet_address, added_by, payment_tx, role, added_at FROM folder_access WHERE drive_id = ? AND path = ? ORDER BY added_at DESC").all(driveId, path);
  return NextResponse.json({ access: rows });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive || drive.owner_id !== user.id) {
    return NextResponse.json({ error: "only owner can add wallets" }, { status: 403 });
  }
  const id = nanoid(12);
  const wallet = body.data.wallet_address.toLowerCase();
  try {
    db.prepare(
      "INSERT INTO folder_access (id, drive_id, path, wallet_address, added_by, role) VALUES (?, ?, ?, ?, 'owner', ?)"
    ).run(id, driveId, body.data.path, wallet, body.data.role);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) {
      return NextResponse.json({ error: "wallet already has access at this path" }, { status: 409 });
    }
    throw e;
  }
  // Issue Meadowcap cap as a portable proof of grant
  let capBase64: string | null = null;
  const ns = getDriveNamespace(driveId);
  if (ns) {
    try {
      const issued = await issueShareCap({
        namespacePub: ns.pub,
        namespaceSecret: ns.secret,
        pathPrefix: body.data.path,
        accessMode: "read",
      });
      capBase64 = issued.capBase64;
    } catch (e) {
      console.warn("cap issuance failed:", (e as Error).message);
    }
  }

  return NextResponse.json({ id, wallet_address: wallet, path: body.data.path, role: body.data.role, cap: capBase64 });
}

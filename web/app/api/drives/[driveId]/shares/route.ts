import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { env } from "@/lib/env";
import { zPath } from "@/lib/zod-helpers";
import { AgentError, callAgent } from "@/lib/rpc";

const Body = z.object({
  path: zPath.default(""),
  role: z.enum(["viewer", "commenter", "editor"]),
  expiresAt: z.string().datetime().optional(),
  password: z.string().min(4).max(200).optional(),
  price_usdc: z.number().positive().optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = resolveRole(driveId, user.id, "");
  if (!atLeast(role, "editor")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const shares = db.prepare(`
    SELECT id, path, role, token, expires_at, created_at, price_usdc, payment_chain
    FROM shares WHERE drive_id = ? ORDER BY created_at DESC
  `).all(driveId);
  return NextResponse.json({ shares });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const role = resolveRole(driveId, user.id, body.data.path);
  if (!atLeast(role, "editor")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Verify the share path actually exists in the drive before issuing a
  // token. Empty path ("") = drive root, no check needed; anything else
  // gets a stat probe so we don't hand out tokens for typo'd paths that
  // would 404 after the visitor pays.
  if (body.data.path !== "") {
    try {
      const stat = await callAgent(driveId, drive.drive_secret, { method: "stat", path: body.data.path });
      if (!stat?.entry) {
        return NextResponse.json({ error: "path not found in drive" }, { status: 400 });
      }
    } catch (e) {
      const err = e as AgentError;
      return NextResponse.json({ error: err.message || "agent unreachable" }, { status: err.status ?? 503 });
    }
  }

  const id = nanoid(12);
  const token = nanoid(24);
  const passwordHash = body.data.password ? await bcrypt.hash(body.data.password, 10) : null;
  db.prepare(`
    INSERT INTO shares (id, drive_id, path, role, token, password_hash, expires_at, created_by, price_usdc, payment_chain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, driveId, body.data.path, body.data.role, token, passwordHash, body.data.expiresAt ?? null, user.id, body.data.price_usdc ?? null, body.data.price_usdc ? "base-sepolia" : null);
  return NextResponse.json({
    id,
    token,
    url: `${env.publicUrl.replace(/\/$/, "")}/s/${token}`,
  });
}

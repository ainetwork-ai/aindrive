import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "@/lib/db";
import { getUser } from "@/lib/session";
import { getDrive, payoutWalletFor } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { resolveDriveTokens, pickShareCurrency } from "@/lib/payment-tokens";
import { env } from "@/lib/env";
import { zPath } from "@/lib/zod-helpers";
import { AgentError, callAgent } from "@/lib/rpc";

const Body = z.object({
  path: zPath.default(""),
  role: z.enum(["viewer", "editor"]),
  expiresAt: z.string().datetime().optional(),
  price_usdc: z.number().positive().optional(),
  currency: z.string().optional(),
  listed: z.boolean().optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const role = resolveRole(driveId, user.id, "");
  if (!atLeast(role, "editor")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const shares = db.prepare(`
    SELECT id, path, role, token, expires_at, created_at, price_usdc, currency, listed
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

  // [rev2-D] Listing on the drive's showcase is owner-only: a path-scoped
  // editor must not be able to put arbitrary priced items on the drive's
  // storefront. Unlisted share creation stays editor-at-path as before.
  if (body.data.listed && !atLeast(resolveRole(driveId, user.id, ""), "owner")) {
    return NextResponse.json({ error: "only the owner can list a share" }, { status: 403 });
  }

  // Granting EDITOR access via a link is owner-only — a non-owner editor must
  // not be able to laterally escalate strangers to editor. Editors may still
  // mint VIEWER links at paths they cover. (owner is whole-drive only → root.)
  if (body.data.role === "editor" && !atLeast(resolveRole(driveId, user.id, ""), "owner")) {
    return NextResponse.json({ error: "only an owner can grant editor access via a link" }, { status: 403 });
  }

  // Paid share: currency must be one the drive's token policy allows.
  // Defaults to the policy's first token when the caller doesn't pick one.
  let currency: string | null = null;
  if (body.data.price_usdc) {
    // A paid share needs somewhere for the money to land. The payout wallet is
    // path-scoped: this share's funds go to the nearest ANCESTOR folder's
    // wallet (set in that folder's Share panel; inherits down to the drive
    // root). If no ancestor — not even root — has one, block at creation
    // instead of minting a link that settles to 0x0 and fails at checkout.
    if (!payoutWalletFor(driveId, body.data.path)) {
      return NextResponse.json(
        { error: "set a payout wallet for this folder (or a parent) before selling" },
        { status: 400 },
      );
    }
    const symbols = resolveDriveTokens(drive.allowed_tokens).map((t) => t.symbol);
    currency = pickShareCurrency(symbols, body.data.currency);
    if (currency === null) {
      return NextResponse.json({ error: "currency not allowed by drive policy" }, { status: 400 });
    }
  }

  // Verify the share path actually exists in the drive before issuing a
  // token. Empty path ("") = drive root, no check needed; anything else
  // gets a stat probe so we don't hand out tokens for typo'd paths that
  // would 404 after the visitor pays.
  // Non-root path: stat-probe verifies the path EXISTS (typo protection),
  // which needs the agent. Root ("") has no path to verify, so it is NOT
  // gated on the agent being online — a fresh, not-yet-paired drive can still
  // set up free invites and storefront sales before/independent of the agent
  // running (the drive just reads "offline" until the agent connects).
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
  db.prepare(`
    INSERT INTO shares (id, drive_id, path, role, token, expires_at, created_by, price_usdc, currency, listed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, driveId, body.data.path, body.data.role, token, body.data.expiresAt ?? null, user.id, body.data.price_usdc ?? null, currency, body.data.listed ? 1 : 0);
  return NextResponse.json({
    id,
    token,
    url: `${env.publicUrl.replace(/\/$/, "")}/s/${token}`,
  });
}

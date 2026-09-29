import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { checkOrgShare, listDriveOrgShares, orgAccessIssuer, orgShareCandidates, shareDriveWithOrg } from "@/lib/orgs.js";

/**
 * Organization sharing of a drive (docs/PERMISSIONS.md "Organizations").
 *
 * GET  — the organizations the drive is shared with. Owners (creator and
 *        co-owners) see it; only the creator gets `candidates` (their own
 *        organizations, each with whether they may share this drive with it).
 * POST { orgId, role? } — share the whole drive with an organization, or
 *        change its role (viewer | editor, default viewer). Creator only, an
 *        active member of that organization, and its admin (AIN SSO app role
 *        admin/owner) or on AINDRIVE_ORG_SHARE_ALLOWLIST (lib/org-policy.js).
 * Unshare: DELETE ./[orgId].
 */
const Body = z.object({
  orgId: z.string().min(1).max(255),
  role: z.enum(["viewer", "editor"]).default("viewer"),
});

export async function GET(_req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const isCreator = drive.owner_id === user.id;
  return NextResponse.json({
    enabled: orgAccessIssuer() !== null,
    canManage: isCreator,
    shares: listDriveOrgShares(driveId).map(({ createdBy: _createdBy, ...s }) => s),
    candidates: isCreator ? orgShareCandidates(driveId, user.id) : [],
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const decision = checkOrgShare(driveId, user.id, body.data.orgId);
  if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: decision.status });
  const { previousRole } = shareDriveWithOrg({
    driveId,
    issuer: decision.issuer,
    orgId: body.data.orgId,
    role: body.data.role,
    actor: `user:${user.id}`,
    actorUserId: user.id,
    subject: decision.membership.subject,
    via: decision.via,
  });
  return NextResponse.json({ ok: true, role: body.data.role, previousRole }, { status: previousRole ? 200 : 201 });
}

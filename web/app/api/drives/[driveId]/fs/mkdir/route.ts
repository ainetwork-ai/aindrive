import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";
import { getUserTier, TIER_FOLDER_LIMIT, TIER_PRICE_AIN } from "@/lib/tier";
import { getOwnerUsage, bumpOwnerUsage } from "@/lib/storage-usage.js";

const Body = z.object({ path: z.string().min(1) });

export async function POST(req: Request, { params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const user = await getUser();
  const drive = getDrive(driveId);
  if (!drive) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  const role = await resolveAccess(driveId, body.data.path, user?.id ?? null);
  if (!atLeast(role, "editor")) {
    return NextResponse.json({ error: "forbidden" }, { status: user ? 403 : 401 });
  }
  const ownerId = drive.owner_id as string;
  const { tier } = await getUserTier(req);
  const folderLimit = TIER_FOLDER_LIMIT[tier];
  if (Number.isFinite(folderLimit)) {
    const usage = getOwnerUsage(ownerId);
    if (usage.folders + 1 > folderLimit) {
      return NextResponse.json(
        {
          error: "folder_limit_reached",
          tier,
          limit: folderLimit,
          current: usage.folders,
          upgrade: tier === "max" ? null : {
            to: tier === "free" ? "pro" : "max",
            priceAin: tier === "free" ? TIER_PRICE_AIN.pro : TIER_PRICE_AIN.max,
            url: tier === "free"
              ? `/api/x402/lift?scope=tier:pro&priceAin=${TIER_PRICE_AIN.pro}`
              : `/api/x402/lift?scope=tier:max&priceAin=${TIER_PRICE_AIN.max}`,
          },
        },
        { status: 429 },
      );
    }
  }
  try {
    const result = await callAgent(driveId, drive.drive_secret, { method: "mkdir", path: body.data.path });
    bumpOwnerUsage(ownerId, { folders: 1 });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

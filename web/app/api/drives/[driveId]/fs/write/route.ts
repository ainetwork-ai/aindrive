import { NextResponse } from "next/server";
import { z } from "zod";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveAccess, atLeast } from "@/lib/access";
import { AgentError, callAgent } from "@/lib/rpc";
import { getUserTier, TIER_FILE_LIMIT, TIER_PRICE_AIN } from "@/lib/tier";
import { getOwnerUsage, bumpOwnerUsage } from "@/lib/storage-usage.js";

const MAX_WRITE_BYTES = parseInt(process.env.AINDRIVE_MAX_WRITE_BYTES ?? String(16 * 1024 * 1024), 10);

const Body = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

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
  const { content, encoding } = body.data;
  const byteLength = encoding === "base64"
    ? Math.ceil(content.length * 3 / 4)
    : Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_WRITE_BYTES) {
    return NextResponse.json(
      { error: "payload too large", limit: MAX_WRITE_BYTES },
      { status: 413, headers: { "X-Max-Bytes": String(MAX_WRITE_BYTES) } },
    );
  }
  // Tiered file-count cap (per owner, summed across all of their drives).
  // Only enforce on file creation — overwrites of existing files don't bump
  // the count. We approximate "is this a new file?" by asking the agent for
  // a stat first; if it errors as not-found, treat as create.
  const ownerId = drive.owner_id as string;
  const { tier } = await getUserTier(req);
  const fileLimit = TIER_FILE_LIMIT[tier];
  let creating = false;
  try {
    const list = await callAgent(driveId, drive.drive_secret, { method: "list", path: dirOf(body.data.path) });
    const exists = (list.entries ?? []).some((e: { name: string; isDir?: boolean }) => e.name === baseOf(body.data.path) && !e.isDir);
    creating = !exists;
  } catch { creating = true; }
  if (creating && Number.isFinite(fileLimit)) {
    const usage = getOwnerUsage(ownerId);
    if (usage.files + 1 > fileLimit) {
      return NextResponse.json(
        {
          error: "file_limit_reached",
          tier,
          limit: fileLimit,
          current: usage.files,
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
    const result = await callAgent(driveId, drive.drive_secret, {
      method: "write", path: body.data.path, content, encoding: body.data.encoding,
    });
    if (creating) bumpOwnerUsage(ownerId, { files: 1 });
    return NextResponse.json(result);
  } catch (e) {
    const err = e as AgentError;
    return NextResponse.json({ error: err.message }, { status: err.status ?? 500 });
  }
}

function dirOf(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
function baseOf(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }

import { NextResponse } from "next/server";
import { z } from "zod";
import { decodeAndDescribeCap } from "@/lib/willow/cap-issue";

const Body = z.object({ cap: z.string().min(8) });

export async function POST(req: Request) {
  const body = Body.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid input" }, { status: 400 });
  const desc = await decodeAndDescribeCap(body.data.cap);
  if (!desc) return NextResponse.json({ error: "could not decode cap" }, { status: 400 });
  return NextResponse.json({
    valid: desc.valid,
    pathPrefix: desc.pathPrefix,
    receiverPub: Buffer.from(desc.receiverPub).toString("hex"),
    timeStart: desc.timeStart.toString(),
    timeEnd: desc.timeEnd?.toString() ?? null,
  });
}

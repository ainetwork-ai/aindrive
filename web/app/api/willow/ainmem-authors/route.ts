// web/app/api/willow/ainmem-authors/route.ts
import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/session";
import { ainmemAuthors } from "@/lib/willow/ainmem";
import { roleOf } from "@/lib/willow/roles";

/** GET ?drive&teamspace&page → { authors } — who signed each ainmem transaction of a
 *  page, for anyone who may read the drive. */
export async function GET(req: Request) {
  const user = await getRequestUser(req);
  if (!user || user === "invalid") return NextResponse.json({ error: "sign in" }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const drive = q.get("drive") ?? "", teamspace = q.get("teamspace") ?? "", page = q.get("page") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(drive) || !teamspace || !page) return NextResponse.json({ error: "drive, teamspace, page" }, { status: 400 });
  if (!["viewer", "commenter", "editor", "owner"].includes(roleOf(drive, user.id, ""))) return NextResponse.json({ error: "not a member" }, { status: 403 });
  return NextResponse.json({ authors: await ainmemAuthors(drive, teamspace, page) });
}

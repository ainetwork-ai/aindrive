import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { DriveManage } from "@/components/drive-manage";

// Owner-only drive management surface. Members/editors are bounced back to the
// drive — the API enforces the same gate, this just avoids rendering a shell
// they can't use.
export default async function ManagePage({ params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) redirect(`/login?next=/d/${driveId}/manage`);
  const drive = getDrive(driveId);
  if (!drive) return <main className="p-10">Drive not found.</main>;
  if (!atLeast(resolveRole(driveId, user.id, ""), "owner")) redirect(`/d/${driveId}`);
  return <DriveManage driveId={drive.id} driveName={drive.name} />;
}

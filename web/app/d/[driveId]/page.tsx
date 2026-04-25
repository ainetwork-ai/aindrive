import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast } from "@/lib/access";
import { DriveShell } from "@/components/drive-shell";

export default async function DrivePage({ params }: { params: Promise<{ driveId: string }> }) {
  const { driveId } = await params;
  const user = await getUser();
  if (!user) redirect(`/login?next=/d/${driveId}`);
  const drive = getDrive(driveId);
  if (!drive) return <main className="p-10">Drive not found.</main>;
  const role = resolveRole(driveId, user.id, "");
  if (!atLeast(role, "viewer")) {
    return <main className="p-10">You don’t have access to this drive. Ask the owner to invite you.</main>;
  }
  return <DriveShell driveId={drive.id} driveName={drive.name} />;
}

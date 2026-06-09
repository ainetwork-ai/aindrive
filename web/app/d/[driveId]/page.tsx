import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast, entryView } from "@/lib/access";
import { DriveShell } from "@/components/drive-shell";

export default async function DrivePage({
  params,
  searchParams,
}: {
  params: Promise<{ driveId: string }>;
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const { driveId } = await params;
  const sp = await searchParams;
  const rawPath = Array.isArray(sp.path) ? sp.path[0] : sp.path;
  const pathProvided = rawPath !== undefined && rawPath !== null;

  const user = await getUser();
  if (!user) redirect(`/login?next=/d/${driveId}`);
  const drive = getDrive(driveId);
  if (!drive) return <main className="p-10">Drive not found.</main>;

  // Resolve the path we will actually render + the role at it.
  let renderPath = rawPath ?? "";
  let role = resolveRole(driveId, user.id, renderPath);

  if (!atLeast(role, "viewer")) {
    // An explicitly-supplied ?path the user can't reach is a hard deny — never
    // redirect to an accessible entry, or the render-vs-redirect difference
    // becomes a per-path access oracle (spec D5).
    if (pathProvided) {
      return <main className="p-10">You don’t have access to this path. Ask the owner to invite you.</main>;
    }
    // No explicit path (root entry) but no root access → land on an accessible
    // entry point computed purely from membership (spec D5 / P0 bug fix).
    const entry = entryView(driveId, user.id);
    if (entry.kind === "none") {
      return <main className="p-10">You don’t have access to this drive. Ask the owner to invite you.</main>;
    }
    renderPath = entry.path ?? "";
    role = resolveRole(driveId, user.id, renderPath);
  }

  return (
    <DriveShell
      driveId={drive.id}
      driveName={drive.name}
      initialPath={renderPath}
      initialRole={role}
    />
  );
}

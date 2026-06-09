import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast, entryView } from "@/lib/access";
import { callAgent } from "@/lib/rpc";
import type { DriveEntry } from "@/lib/protocol";
import { DriveShell } from "@/components/drive-shell";

// Synthetic-root rows for a multi-grant member: stat each grant so files render
// as files (click → Viewer) and dirs as dirs (click → navigate). The agent may
// be offline — fall back to an extension heuristic; the row stays visible and
// the server still gates every subsequent call.
async function loadEntryItems(driveId: string, driveSecret: string, paths: string[]): Promise<DriveEntry[]> {
  return Promise.all(paths.map(async (p) => {
    try {
      // Short timeout: a half-open agent socket would otherwise hold the RSC
      // render for the 25s default — these rows are cosmetic and have a fallback.
      const r = await callAgent(driveId, driveSecret, { method: "stat", path: p }, { timeoutMs: 3000 });
      if (r && r.method === "stat" && r.entry) return { ...r.entry, name: p, path: p };
    } catch {}
    const looksFile = /\.[A-Za-z0-9]+$/.test(p);
    return { name: p, path: p, isDir: !looksFile, size: 0, mtimeMs: 0, ext: looksFile ? p.split(".").pop()!.toLowerCase() : "", mime: looksFile ? "application/octet-stream" : "inode/directory" };
  }));
}

export default async function DrivePage({ params, searchParams }: {
  params: Promise<{ driveId: string }>;
  searchParams: Promise<{ path?: string | string[] }>;
}) {
  const { driveId } = await params;
  const sp = await searchParams;
  const rawPath = Array.isArray(sp.path) ? sp.path[0] : sp.path;
  const pathProvided = rawPath !== undefined;

  const user = await getUser();
  if (!user) redirect(`/login?next=/d/${driveId}`);
  const drive = getDrive(driveId);
  if (!drive) return <main className="p-10">Drive not found.</main>;

  let renderPath = rawPath ?? "";
  let role = resolveRole(driveId, user.id, renderPath);
  // The member's entry shape is a property of the member, not of this render's
  // ?path — compute it for every non-owner outcome so the synthetic root
  // survives reloads at ?path and Back-navigation to "" (review fix #4).
  const entry = entryView(driveId, user.id);

  if (!atLeast(role, "viewer")) {
    if (pathProvided) {
      // Explicit inaccessible ?path stays a uniform hard deny (oracle guard).
      return <main className="p-10">You don’t have access to this path. Ask the owner to invite you.</main>;
    }
    if (entry.kind === "none") {
      return <main className="p-10">You don’t have access to this drive. Ask the owner to invite you.</main>;
    }
    if (entry.kind === "multi") {
      const entryItems = await loadEntryItems(driveId, drive.drive_secret, entry.allPaths ?? []);
      return <DriveShell driveId={drive.id} driveName={drive.name} initialPath="" initialRole="viewer" entryItems={entryItems} />;
    }
    renderPath = entry.path ?? "";
    role = resolveRole(driveId, user.id, renderPath);
  }

  // Allowed render (owner / root member / covered explicit ?path). Multi
  // members still get entryItems so "" remains their synthetic root.
  const entryItems = entry.kind === "multi"
    ? await loadEntryItems(driveId, drive.drive_secret, entry.allPaths ?? [])
    : undefined;
  return <DriveShell driveId={drive.id} driveName={drive.name} initialPath={renderPath} initialRole={role} entryItems={entryItems} />;
}

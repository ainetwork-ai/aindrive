import { redirect } from "next/navigation";
import { getUser } from "@/lib/session";
import { getDrive } from "@/lib/drives";
import { resolveRole, atLeast, entryView } from "@/lib/access";
import { readDenial } from "@/lib/require-access";
import { paidLocksForPaths } from "@/lib/sale-access.js";
import { normalizePath } from "@/lib/path";
import { resolveDriveLocation, type PathKind } from "@/lib/drive-location";
import { callAgent } from "@/lib/rpc";
import type { DriveEntry } from "@/lib/protocol";
import { DriveShell } from "@/components/drive-shell";

// The agent's view of one path, or null when it can't answer. Short timeout: a
// half-open agent socket would otherwise hold the RSC render for the 25s default.
async function statEntry(driveId: string, driveSecret: string, path: string): Promise<DriveEntry | null> {
  try {
    const r = await callAgent(driveId, driveSecret, { method: "stat", path }, { timeoutMs: 3000 });
    if (r && r.method === "stat" && r.entry) return { ...r.entry, path };
  } catch {}
  return null;
}
const kindOf = (e: DriveEntry | null): PathKind => (e ? (e.isDir ? "dir" : "file") : "unknown");

// Grant-listing rows: files render as files (click → Viewer), dirs as dirs
// (click → navigate). No stat (offline agent, or a row the user can't read
// yet) → extension heuristic; the row stays visible and the server still
// gates every subsequent call.
async function loadEntryItems(stat: (p: string) => Promise<DriveEntry | null>, paths: string[]): Promise<DriveEntry[]> {
  return Promise.all(paths.map(async (p) => {
    const e = await stat(p);
    if (e) return { ...e, name: p };
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

  const user = await getUser();
  if (!user) redirect(`/login?next=/d/${driveId}`);
  const drive = getDrive(driveId);
  if (!drive) return <main className="p-10">Drive not found.</main>;

  let requested: string | null = null;
  if (rawPath !== undefined) {
    try { requested = normalizePath(rawPath); }
    catch { return <main className="p-10">You don’t have access to this path. Ask the owner to invite you.</main>; }
  }
  const roleAt = (p: string) => resolveRole(driveId, user.id, p);
  const entry = entryView(driveId, user.id);
  // Stat only what the user may READ — role, reserved subtree and paywall alike
  // (readDenial, the fs/* gate's own decision) — so the page reveals nothing by
  // stat that the API withholds. Anything else stays "unknown" and lists as a
  // folder, where the listing reports the 402/403. One stat per path per render.
  const stats = new Map<string, Promise<DriveEntry | null>>();
  const statReadable = (p: string): Promise<DriveEntry | null> => {
    const role = roleAt(p);
    if (!atLeast(role, "viewer") || readDenial(driveId, p, role, user.id)) return Promise.resolve(null);
    if (!stats.has(p)) stats.set(p, statEntry(driveId, drive.drive_secret, p));
    return stats.get(p)!;
  };
  const [requestedEntry, singleEntry] = await Promise.all([
    requested !== null ? statReadable(requested) : null,
    entry.kind === "single" && entry.path ? statReadable(entry.path) : null,
  ]);

  const loc = resolveDriveLocation({
    requested, requestedKind: kindOf(requestedEntry),
    entry, entryKind: kindOf(singleEntry), roleAt,
  });
  if (loc.kind === "deny") {
    // Say WHO is signed in: the common cause is the right link opened in a browser signed into
    // another account (the Mac/phone app uses one account, the browser another). The owner is not
    // named — a non-member must not learn who owns a drive.
    const here = `/d/${driveId}${requested ? `?path=${encodeURIComponent(requested)}` : ""}`;
    return (
      <main className="min-h-screen flex items-center justify-center px-6">
        <div className="w-full max-w-sm bg-white border border-drive-border rounded-2xl p-6 shadow-drive">
          <h1 className="text-lg font-semibold">{loc.reason === "path" ? "No access to this folder" : "No access to this drive"}</h1>
          <p className="mt-2 text-sm text-drive-muted">
            You’re signed in as <span className="font-medium text-drive-text">{user.email}</span>, and this account can’t open it.
            If you shared it from another account — for example in the aindrive app — switch to that account.
            Otherwise, ask the owner to invite {user.email}.
          </p>
          <form method="post" action={`/api/auth/logout?next=${encodeURIComponent(here)}`} className="mt-5">
            <button className="w-full rounded-lg bg-drive-accent text-white py-2 hover:bg-drive-accentHover">Switch account</button>
          </form>
          <a href="/" className="mt-3 block text-center text-sm text-drive-accent hover:underline">Back to your drives</a>
        </div>
      </main>
    );
  }

  const grantRoots = entry.allPaths ?? (entry.path ? [entry.path] : []);
  // A grant row the viewer hasn't paid for shows 🔒 + price and opens the
  // paywall, as fs/list marks a folder's children (R-VIS-PAID-001). A grant is
  // the member's own, so an unlisted sale's row stays visible, just locked.
  const entryItems = loc.grantListing
    ? await loadEntryItems(statReadable, grantRoots).then((rows) => {
        const locks = paidLocksForPaths(driveId, grantRoots, roleAt, user.id);
        return rows.map((e) => (locks[e.path] ? { ...e, locked: true, ...locks[e.path] } : e));
      })
    : undefined;
  const initialOpen = loc.open === null ? null
    : loc.open === requested ? requestedEntry
    : singleEntry;
  // The grant listing is read-only: a role picked up inside a grant must not
  // lend edit affordances to rows that are other grants' roots.
  const initialRole = loc.grantListing && loc.folder === "" ? "viewer" : roleAt(loc.folder);

  return (
    <DriveShell
      driveId={drive.id} driveName={drive.name}
      initialFolder={loc.folder} scopeRoot={loc.scopeRoot} initialOpen={initialOpen}
      initialRole={initialRole} entryItems={entryItems}
    />
  );
}

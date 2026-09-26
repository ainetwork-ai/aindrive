// Where the drive page puts a user: which folder to list, which file to open,
// and how far up the breadcrumb may go.
//
// `?path` names what the user is LOOKING AT — a folder or a file — and a
// grant can be either (a paid file share grants the file itself). Only a stat
// can tell them apart, so the page stats and hands the kind in; this module
// stays pure. Treating every path as a folder listed files with fs/list and
// broke every file deep link (post-purchase redirect, single-file grants).
import { atLeast, type RoleOrNone } from "./access-core.js";

/** stat result; "unknown" when there is no path or the agent is unreachable */
export type PathKind = "dir" | "file" | "unknown";

/** computeEntry's result for (drive, user) */
export type EntryView = { kind: "root" | "single" | "multi" | "none"; path?: string; allPaths?: string[] };

export type LocationInput = {
  /** normalized ?path, or null when the URL has none */
  requested: string | null;
  requestedKind: PathKind;
  entry: EntryView;
  /** kind of entry.path when entry.kind is "single" */
  entryKind: PathKind;
  /** the user's role at a path (owner ⇒ "owner") */
  roleAt: (path: string) => RoleOrNone;
};

export type DriveLocation =
  | { kind: "deny"; reason: "path" | "drive" }
  | {
      kind: "view";
      /** folder whose contents are listed ("" + grantListing = the grant listing) */
      folder: string;
      /** file to open in the viewer */
      open: string | null;
      /** highest folder the breadcrumb may reach */
      scopeRoot: string;
      /** the drive root renders this user's grant roots instead of fs/list("") */
      grantListing: boolean;
    };

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function resolveDriveLocation({ requested, requestedKind, entry, entryKind, roleAt }: LocationInput): DriveLocation {
  const rootAccess = atLeast(roleAt(""), "viewer");
  // No root access and the root can't be one folder to land in: several
  // grants, or a single grant that is a file.
  const grantListing = !rootAccess && (entry.kind === "multi" || (entry.kind === "single" && entryKind === "file"));
  // A single-folder member's breadcrumb tops out at their grant.
  const scopeRoot = rootAccess || grantListing ? "" : (entry.path ?? "");
  const view = (folder: string, open: string | null): DriveLocation => ({ kind: "view", folder, open, scopeRoot, grantListing });

  if (requested !== null) {
    // An explicit path the user can't read stays a uniform hard deny — never
    // redirect to their entry, or render-vs-redirect becomes a path oracle.
    if (!atLeast(roleAt(requested), "viewer")) return { kind: "deny", reason: "path" };
    // Unknown (agent offline) lists as a folder; the listing reports the outage.
    if (requestedKind !== "file") return view(requested, null);
    const parent = parentOf(requested);
    // A file bought on its own sits in a folder its buyer can't list — show it
    // in their grant listing instead.
    return atLeast(roleAt(parent), "viewer") ? view(parent, requested) : view("", requested);
  }
  if (rootAccess) return view("", null);
  if (entry.kind === "none") return { kind: "deny", reason: "drive" };
  if (grantListing) return view("", entry.kind === "single" ? (entry.path ?? null) : null);
  return view(entry.path ?? "", null);
}

/** The ?path value for what the user is looking at: the open file, else the folder; null at the drive root. */
export function locationPath(folder: string, open: string | null): string | null {
  return open ?? (folder || null);
}

export type ViewerHistory = { action: "push" | "replace" | "back" | "none"; openPushed: boolean };

/**
 * How to record a viewer change in browser history. `openPushed`: the current
 * entry was pushed by opening a file on this page. Switching files replaces
 * that entry and closing steps back over it, so one Back (or ✕) always closes
 * the viewer; an unchanged URL (the same row, a locked row) records nothing.
 */
export function viewerHistory({ openPushed, opening, urlChanged }: { openPushed: boolean; opening: boolean; urlChanged: boolean }): ViewerHistory {
  if (!opening) return openPushed ? { action: "back", openPushed: false } : { action: urlChanged ? "push" : "none", openPushed: false };
  if (!urlChanged) return { action: "none", openPushed };
  return openPushed ? { action: "replace", openPushed: true } : { action: "push", openPushed: true };
}

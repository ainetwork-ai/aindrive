import { listFolderTree } from "ain-ui";
import type { FileEntry } from "./plugin";

/**
 * Folder metadata is a snapshot. It now walks subfolders (breadth-first, bounded), and the files in it are handed
 * to the agent through one MCP grant, so an agent asked "what is in this folder?" can open what is in its
 * subfolders too — pictures included — instead of answering from names.
 */
export interface FolderContext {
  name: string;
  path: string;
  recursive: boolean;
  listingErrors?: string[];
  /** how many levels below the chosen folder were listed (0 = only its direct children) */
  depth: number;
  /** The device it lives on, when that is not this one (a folder on another device, listed by the server). */
  device?: string;
  /** What that device's own agent says about these files (it has looked at the photos; the listing hasn't). */
  note?: string;
  totalEntries: number;
  truncated: boolean;
  entries: Pick<FileEntry, "name" | "path" | "isDir" | "size" | "mime">[];
}

/** Entries described to the agent, across all levels. */
export const FOLDER_ENTRY_LIMIT = 500;
/** Levels below the chosen folder that are listed: its subfolders, theirs, and theirs. */
export const FOLDER_DEPTH_LIMIT = 3;
/** Files granted for reading through the handoff MCP server (and web/lib/handoff.ts MAX_FILES). */
export const FOLDER_FILE_LIMIT = 50;

type Entry = FileEntry;
const join = (dir: string, child: string) => (dir ? `${dir}/${child}` : child);

/**
 * Reads the selected native folder and its subfolders, breadth-first and bounded — nearest files first, so a
 * cut keeps what is closest to the folder the person chose. The root listing failing stops the handoff; a
 * subfolder that cannot be listed is skipped and the snapshot says it is truncated.
 */
export async function prepareFolderHandoff<T extends { files: unknown[] }>(
  scope: { uri: string; label: string },
  list: (opts: { folderUri: string; path: string }) => Promise<{ entries: FileEntry[] }>,
  handoff: (files: { folderUri: string; path: string }[]) => Promise<T | null>,
  selectedPaths?: string[],
): Promise<(T & { folder: FolderContext }) | null> {
  const tree = await listFolderTree(path => list({ folderUri: scope.uri, path }).then(r => r.entries), "", { maxEntries: FOLDER_ENTRY_LIMIT, maxDepth: FOLDER_DEPTH_LIMIT });
  const all = tree.entries;
  const truncated = tree.truncated;
  const deepest = Math.max(0, ...all.map(e => e.path.split("/").length - 1));
  const paths = selectedPaths?.length ? selectedPaths : all.filter((e) => !e.isDir).map((e) => e.path);
  const picked = [...new Set(paths)].slice(0, FOLDER_FILE_LIMIT)
    .map((path) => ({ folderUri: scope.uri, path }));
  const handed = await handoff(picked);
  if (!handed) return null;
  return {
    ...handed,
    folder: {
      name: scope.label, path: "", recursive: deepest > 0, depth: deepest, totalEntries: tree.observedEntries, truncated, listingErrors: tree.errors,
      entries: all.map(({ name, path, isDir, size, mime }) => ({ name, path, isDir, size, mime })),
    },
  };
}

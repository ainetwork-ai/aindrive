import type { FileEntry } from "./plugin";

/** Folder metadata is a snapshot; the MCP grant can read only its attached files. */
export interface FolderContext {
  name: string;
  path: string;
  recursive: false;
  totalEntries: number;
  truncated: boolean;
  entries: Pick<FileEntry, "name" | "path" | "isDir" | "size" | "mime">[];
}

export const FOLDER_ENTRY_LIMIT = 200;
export const FOLDER_FILE_LIMIT = 10;

/** Reads only the selected native folder. No previous search or drive fallback. */
export async function prepareFolderHandoff<T extends { files: unknown[] }>(
  scope: { uri: string; label: string },
  list: (opts: { folderUri: string; path: string }) => Promise<{ entries: FileEntry[] }>,
  handoff: (files: { folderUri: string; path: string }[]) => Promise<T | null>,
  selectedPaths?: string[],
): Promise<(T & { folder: FolderContext }) | null> {
  const { entries } = await list({ folderUri: scope.uri, path: "" });
  const visible = entries.slice(0, FOLDER_ENTRY_LIMIT);
  const paths = selectedPaths?.length ? selectedPaths : visible.filter((e) => !e.isDir).map((e) => e.path);
  const picked = [...new Set(paths)].slice(0, FOLDER_FILE_LIMIT)
    .map((path) => ({ folderUri: scope.uri, path }));
  const handed = await handoff(picked);
  if (!handed) return null;
  return {
    ...handed,
    folder: {
      name: scope.label, path: "", recursive: false, totalEntries: entries.length,
      truncated: entries.length > visible.length,
      entries: visible.map(({ name, path, isDir, size, mime }) => ({ name, path, isDir, size, mime })),
    },
  };
}

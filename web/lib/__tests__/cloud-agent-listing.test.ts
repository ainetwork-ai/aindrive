import { describe, expect, it } from "vitest";
import { describeEntries, listRecursive } from "../cloud-agent";
import type { DriveEntry } from "../protocol";

const e = (path: string, isDir = false, mime = "", mtimeMs = 0, size = 10): DriveEntry => ({ name: path.split("/").pop()!, path, isDir, mime, mtimeMs, size, ext: path.includes(".") ? path.split(".").pop()! : "" });

describe("Folder Chat lists the folder recursively and describes it", () => {
  const tree: Record<string, DriveEntry[]> = {
    "Trips": [e("Trips/Jeju", true), e("Trips/plan.pdf", false, "application/pdf", Date.UTC(2026, 2, 1))],
    "Trips/Jeju": [e("Trips/Jeju/a.jpg", false, "image/jpeg", Date.UTC(2025, 4, 1)), e("Trips/Jeju/b.jpg", false, "image/jpeg", Date.UTC(2025, 4, 2)), e("Trips/Jeju/.hidden", false)],
  };
  it("walks subfolders breadth-first with paths relative to the folder, skipping dotfiles", async () => {
    const r = await listRecursive(async (p) => tree[p] ?? [], "Trips");
    expect(r.entries.map((x) => x.rel)).toEqual(["Jeju", "plan.pdf", "Jeju/a.jpg", "Jeju/b.jpg"]);
    expect(r.folders).toBe(1);
    expect(r.truncated).toBe(false);
  });
  it("caps the listing and says so", async () => {
    const r = await listRecursive(async (p) => tree[p] ?? [], "Trips", 2);
    expect(r.entries).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
  it("describes counts by kind and the date span", async () => {
    const r = await listRecursive(async (p) => tree[p] ?? [], "Trips");
    expect(describeEntries(r.entries)).toBe("2 photos, 1 PDFs (2025-05 – 2026-03)");
  });
});

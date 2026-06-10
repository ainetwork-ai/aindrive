// 드라이브 셸의 엔트리 정렬: 폴더 우선 고정, 그 안에서 key 비교.
// 서버(fs/list)는 에이전트의 readdir 순서를 그대로 보내므로 표시 순서의
// 책임은 전적으로 클라이언트인 여기에 있다.
import type { DriveEntry } from "@/lib/protocol";

export type SortKey = "name" | "mtime" | "size";
export type SortDir = "asc" | "desc";
export type SortState = { key: SortKey; dir: SortDir };

// numeric: "file2" < "file10"; sensitivity base: 대소문자 무시.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortEntries(entries: DriveEntry[], key: SortKey, dir: SortDir): DriveEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 폴더 우선은 방향과 무관
    let cmp = 0;
    if (key === "mtime") cmp = a.mtimeMs - b.mtimeMs;
    else if (key === "size" && !a.isDir) cmp = a.size - b.size; // 디렉토리 size는 무의미 → name 폴백
    if (cmp === 0) cmp = collator.compare(a.name, b.name);
    return sign * cmp;
  });
}

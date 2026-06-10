# Drive Shell Polish (정렬·검색·썸네일) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** UIUX 오버홀에서 연기된 3건 — 폴더우선 자연 정렬(컬럼 토글), 현재 폴더 파일명 검색, 그리드 이미지 썸네일(서버 리사이즈+캐시) — 을 구현한다.

**Architecture:** 정렬·검색은 `drive-shell.tsx`의 클라이언트 상태 + 순수 유틸(`lib/sort-entries.ts`)로, 썸네일은 fs/read와 동일 가드의 읽기전용 라우트(`fs/thumbnail`)가 에이전트에서 1회 읽고 sharp로 256px webp 변환 후 `AINDRIVE_DATA_DIR/thumbs`에 mtime 키로 디스크 캐시. Spec: `docs/superpowers/specs/2026-06-11-drive-shell-polish-design.md`.

**Tech Stack:** Next.js 15, vitest, sharp, lucide-react, use-debounce(기존 의존성).

---

### Task 0: sharp 명시 의존성

- [ ] `cd web && npm install sharp` (이미 lockfile에 next 경유 존재 — 명시 승격)
- [ ] Commit `chore(web): promote sharp to a direct dependency (thumbnails)`

### Task 1: lib/sort-entries.ts (TDD)

**Files:** Create `web/lib/sort-entries.ts`, Test `web/lib/__tests__/sort-entries.test.ts`

- [ ] **Step 1: 실패 테스트**

```ts
import { describe, it, expect } from "vitest";
import { sortEntries, type SortKey, type SortDir } from "../sort-entries";

const e = (name: string, isDir = false, size = 0, mtimeMs = 0) =>
  ({ name, path: name, isDir, size, mtimeMs, ext: "", mime: "" });

describe("sortEntries", () => {
  it("folders always come first regardless of direction", () => {
    const out = sortEntries([e("z.txt"), e("a", true), e("b.txt")], "name", "desc");
    expect(out.map((x) => x.name)).toEqual(["a", "z.txt", "b.txt"]);
  });
  it("natural numeric name order (file2 < file10), case-insensitive", () => {
    const out = sortEntries([e("file10"), e("File2"), e("file1")], "name", "asc");
    expect(out.map((x) => x.name)).toEqual(["file1", "File2", "file10"]);
  });
  it("mtime desc puts newest first", () => {
    const out = sortEntries([e("old", false, 0, 1), e("new", false, 0, 9)], "mtime", "desc");
    expect(out[0].name).toBe("new");
  });
  it("size for directories falls back to name (server size is meaningless)", () => {
    const out = sortEntries([e("zz", true, 999), e("aa", true, 1)], "size", "asc");
    expect(out.map((x) => x.name)).toEqual(["aa", "zz"]);
  });
  it("does not mutate the input array", () => {
    const input = [e("b.txt"), e("a.txt")];
    sortEntries(input, "name", "asc");
    expect(input[0].name).toBe("b.txt");
  });
});
```

- [ ] **Step 2:** `npx vitest run lib/__tests__/sort-entries.test.ts` → FAIL (모듈 없음)
- [ ] **Step 3: 구현**

```ts
// 드라이브 셸의 엔트리 정렬: 폴더 우선 고정, 그 안에서 key 비교.
// 서버(fs/list)는 readdir 순서를 그대로 보내므로 순서 보장은 전적으로 여기.
import type { DriveEntry } from "@/lib/protocol";

export type SortKey = "name" | "mtime" | "size";
export type SortDir = "asc" | "desc";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortEntries(entries: DriveEntry[], key: SortKey, dir: SortDir): DriveEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 폴더 우선은 방향 무관
    let cmp = 0;
    if (key === "mtime") cmp = a.mtimeMs - b.mtimeMs;
    else if (key === "size" && !a.isDir) cmp = a.size - b.size; // 디렉토리 size는 무의미 → name 폴백
    if (cmp === 0) cmp = collator.compare(a.name, b.name);
    return sign * cmp;
  });
}
```

- [ ] **Step 4:** 테스트 PASS 확인 → Commit `feat(web): folder-first natural entry sort util`

### Task 2: 셸 상태 — 정렬·검색 적용

**Files:** Modify `web/components/drive-shell.tsx` (entries 상태 부근)

- [ ] **Step 1:** `viewMode`와 동일 패턴으로 상태 추가 + 적용 memo:

```tsx
const [sort, setSortState] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
useEffect(() => {
  try { const s = JSON.parse(localStorage.getItem("aindrive:sort") || ""); if (s?.key) setSortState(s); } catch {}
}, []);
function setSort(key: SortKey) { // 같은 컬럼 재클릭 = 방향 토글
  setSortState((cur) => {
    const next = cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" as const : "asc" as const } : { key, dir: "asc" as const };
    localStorage.setItem("aindrive:sort", JSON.stringify(next));
    return next;
  });
}
const [query, setQuery] = useState("");
useEffect(() => { setQuery(""); }, [path]); // 폴더 이동 시 검색 리셋
// 필터 → 정렬 한 곳에서: 리스트/그리드가 같은 배열을 소비
const visibleEntries = useMemo(() => {
  const q = query.trim().toLowerCase();
  const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
  return sortEntries(filtered, sort.key, sort.dir);
}, [entries, query, sort]);
```

`FileTable`/`DriveHeader`에 `entries={visibleEntries}`, `sort`, `onSort={setSort}`, `query`, `onQuery={setQuery}` 전달 (실제 prop 배선은 현행 시그니처에 맞춤).

- [ ] **Step 2:** `npm run typecheck` PASS → Task 3과 함께 커밋

### Task 3: 헤더 검색창 + 리스트 컬럼 정렬 UI

**Files:** Modify `web/components/drive-shell-parts.tsx` (DriveHeader, FileTable thead, 빈 상태)

- [ ] **Step 1:** DriveHeader에 검색 입력 (breadcrumb 우측, 기존 버튼들 좌측):

```tsx
<div className="relative hidden sm:block">
  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-drive-muted pointer-events-none" />
  <input
    value={query}
    onChange={(e) => onQuery(e.target.value)}
    placeholder="Search in this folder"
    className="w-44 md:w-56 rounded-full border border-drive-border bg-drive-sidebar/60 pl-8 pr-7 py-1.5 text-body text-drive-text placeholder:text-drive-muted focus:outline-none focus:ring-2 focus:ring-drive-accent/40 focus:bg-white"
  />
  {query && (
    <button aria-label="Clear search" onClick={() => onQuery("")}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-drive-muted hover:text-drive-text">
      <X className="w-3.5 h-3.5" />
    </button>
  )}
</div>
```

(onChange 직결 — 필터는 useMemo라 150ms debounce 불필요해지면 생략 가능. 수백 엔트리 수준에선 즉시 필터가 더 반응적.)

- [ ] **Step 2:** thead 컬럼을 버튼화:

```tsx
function SortHeader({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: { key: SortKey; dir: SortDir }; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort.key === k;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={className}>
      <button onClick={() => onSort(k)} className="inline-flex items-center gap-1 hover:text-drive-text" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
        {label}{active && <Arrow className="w-3.5 h-3.5" />}
      </button>
    </th>
  );
}
```

Name/Modified/Size 3개 적용(⋮ 컬럼 제외).

- [ ] **Step 3:** 검색 0건 빈 상태: 기존 빈 상태 분기에 `query` 있으면 `No files match "{query}"` + "Clear search" 텍스트 버튼.
- [ ] **Step 4:** `npm run typecheck` PASS, 수동 빌드 확인 → Commit `feat(web): folder search + sortable list columns in drive shell`

### Task 4: 썸네일 라우트 (TDD는 e2e 시나리오로)

**Files:** Create `web/app/api/drives/[driveId]/fs/thumbnail/route.ts`, Modify `web/scenarios/cases.mjs` (시나리오 추가)

- [ ] **Step 1: 라우트 구현** — `fs/read/route.ts`의 가드·에이전트 호출 구조를 그대로 따른다:

```ts
// GET /api/drives/[driveId]/fs/thumbnail?path=…&v=<mtimeMs>
// 그리드 카드용 이미지 썸네일. 원본은 에이전트에서 1회만 읽고(sharp 256px
// webp) AINDRIVE_DATA_DIR/thumbs에 mtime 키로 캐시 — 파일이 바뀌면 키가
// 바뀌므로 자연 무효화. v= 쿼리는 브라우저 캐시(immutable)의 무효화 키.
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import sharp from "sharp";
import mime from "mime-types";
// (가드/에이전트 RPC import는 fs/read/route.ts와 동일하게)

const THUMB_W = 256;

export async function GET(req, { params }) {
  // 1) fs/read와 동일 인증·권한 가드 (viewer 이상)
  // 2) mime 판정: path 확장자 기준 image/*가 아니면 415
  // 3) stat RPC로 mtimeMs 확보 → 캐시 키 = sha1(path)-mtimeMs
  const dir = join(dataDir(), "thumbs", driveId);
  const file = join(dir, `${createHash("sha1").update(path).digest("hex")}-${mtimeMs}.webp`);
  if (existsSync(file)) return imgResponse(readFileSync(file));
  // 4) read RPC(base64) → Buffer → sharp 변환 (SVG는 원본 그대로 + CSP sandbox)
  const out = await sharp(buf).rotate().resize({ width: THUMB_W, height: THUMB_W, fit: "inside", withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  mkdirSync(dir, { recursive: true }); writeFileSync(file, out);
  return imgResponse(out);
}
function imgResponse(buf: Buffer) {
  return new NextResponse(buf, { headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=31536000, immutable" } });
}
```

에러 매핑: 에이전트 오프라인 → 503, 16MB 초과 → 413, sharp 실패 → 422. 모두 그리드에서 아이콘 폴백.

- [ ] **Step 2: e2e 시나리오 추가** (cases.mjs — 1×1 PNG 픽스처를 base64로 fs/write 후):

```js
add(180, "thumbnail: image → 200 webp, cached second hit, non-image 415", async () => {
  await ensureDrive();
  const cookie = await reEnsureOwner();
  const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await jget(`/api/drives/${state.driveId}/fs/write`, { method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ path: "thumb-target.png", content: PNG_1x1, encoding: "base64" }) });
  const r1 = await fetch(`${BASE}/api/drives/${state.driveId}/fs/thumbnail?path=thumb-target.png`, { headers: { cookie } });
  eq(r1.status, 200, "thumbnail 200");
  eq(r1.headers.get("content-type"), "image/webp", "webp content type");
  const r2 = await fetch(`${BASE}/api/drives/${state.driveId}/fs/thumbnail?path=thumb-target.png`, { headers: { cookie } });
  eq(r2.status, 200, "cache hit still 200");
  const r3 = await fetch(`${BASE}/api/drives/${state.driveId}/fs/thumbnail?path=hello.txt`, { headers: { cookie } });
  eq(r3.status, 415, "non-image 415");
  const r4 = await fetch(`${BASE}/api/drives/${state.driveId}/fs/thumbnail?path=thumb-target.png`); // no cookie
  assert(r4.status === 401 || r4.status === 403, "unauthenticated rejected");
});
```

(jget/BASE/픽스처 형식은 기존 하니스 컨벤션에 맞춤; hello.txt는 기존 시나리오가 만들어 둔 파일 재사용 또는 즉석 write.)

- [ ] **Step 3:** e2e 해당 케이스만 실행해 PASS → Commit `feat(api): image thumbnail endpoint (sharp resize + mtime-keyed disk cache)`

### Task 5: 그리드 카드 썸네일

**Files:** Modify `web/components/drive-shell-parts.tsx` (FileGrid 카드)

- [ ] **Step 1:** 카드 아이콘 영역 분기:

```tsx
function GridVisual({ driveId, entry }: { driveId: string; entry: DriveEntry }) {
  const [broken, setBroken] = useState(false);
  const { Icon, className } = fileIcon(entry);
  if (!entry.isDir && entry.mime.startsWith("image/") && !broken) {
    return (
      <img
        src={`/api/drives/${driveId}/fs/thumbnail?path=${encodeURIComponent(entry.path)}&v=${entry.mtimeMs}`}
        alt="" loading="lazy" onError={() => setBroken(true)}
        className="w-full aspect-[4/3] object-cover rounded-md bg-drive-sidebar"
      />
    );
  }
  return <Icon className={`w-10 h-10 ${className}`} />; // 기존 렌더와 동일
}
```

FileGrid 카드에서 기존 `<Icon …>` 자리를 `<GridVisual driveId={…} entry={e} />`로. driveId prop이 grid까지 안 내려오면 prop 체인 추가.

- [ ] **Step 2:** `npm run typecheck` PASS → Commit `feat(web): image thumbnails in grid cards (lazy, icon fallback)`

### Task 6: 전체 검증

- [ ] `npm run test` (단위 전체) PASS
- [ ] `npm run typecheck` + `npm run build` PASS
- [ ] `npm run test:e2e` — 기존 162 + 신규 케이스 green
- [ ] `/d/<driveId>` 실화면 스모크(dev 서버): 그리드 썸네일·정렬 토글·검색 동작 확인 가능하면 수행

### Task 7: 리뷰 + 머지

- [ ] code-reviewer 서브에이전트 리뷰(가드 우회·경로 탈출·캐시 오염 관점 포함 — thumbs 캐시 키에 사용자 입력 path가 sha1로만 들어가는지, path traversal이 에이전트 RPC 정규화에 막히는지)
- [ ] 수정 반영 → PR 생성 → `gh pr merge --admin --merge --delete-branch`

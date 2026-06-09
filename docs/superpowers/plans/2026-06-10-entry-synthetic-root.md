# Entry Synthetic Root (Phase 1b) Implementation Plan — rev2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> rev2: ultracode 3-lens 적대검증이 confirm한 결함 4건 반영 — stale role(편집 affordance 잔존·grant root Delete 노출), 파일 grant ENOTDIR dead-end, deep-grant breadcrumb dead-end, reload 후 합성 root 소실. 핵심 교정: **합성 root는 렌더 분기의 속성이 아니라 멤버의 속성** — multi 멤버의 모든 렌더에 entryItems를 전달한다.

**Goal:** 여러 path를 공유받은 멤버가 드라이브를 열면, 한 path로 텔레포트되는 대신 **접근가능 path들을 항목 목록으로 보여주는 합성 root 뷰**에 안착한다 (spec D5 multi 분기). 파일 grant는 파일로, 폴더 grant는 폴더로 동작한다.

**Architecture:**
- `page.tsx`(RSC)는 **비-owner의 모든 허용 렌더**(no-?path 안착이든 명시 ?path든)에서 `entryView`를 계산해, `kind:"multi"`면 각 grant path를 agent `stat` RPC로 조회한 `entryItems: DriveEntry[]`를 DriveShell에 전달한다(agent offline 시 휴리스틱 fallback). no-?path multi는 `initialPath=""`.
- `DriveShell`은 `isSyntheticRoot = !!entryItems && path===""`일 때: fs/list를 건너뛰고 `entryItems`를 표시, **role을 "viewer"로 리셋**, `canEdit`을 **명시적으로 차단**. 파일 행 클릭은 기존 `setSelected`→Viewer(fs/read는 grant path에서 role-gated — 정상 동작), 폴더 행은 `setPath`.
- breadcrumb은 entryItems 모드에서 **덮는 grant를 단일 세그먼트로**: `[driveName→""] + [grant 전체] + grant 이하 세그먼트`. 중간(비권한) 조상 세그먼트를 만들지 않는다.
- 서버 권한 경계 불변: root fs/list는 여전히 403, 모든 fs 호출 재게이트. entryItems는 본인 grant 목록+그 stat 메타라 leak 아님(stat은 grant path 자체 — 권한 보유 경로의 메타).

**Tech Stack:** Next.js 15 RSC + client DriveShell, agent `stat` RPC(`cli/src/rpc.js`에 기존 구현), vitest, e2e 하니스, playwright.

---

## File Structure

- `web/app/d/[driveId]/page.tsx` — multi 멤버 공통 entryItems 구성/전달 (stat + fallback)
- `web/components/drive-shell.tsx` — entryItems prop, isSyntheticRoot(로드/role/canEdit), crumbs grant-aware
- `web/components/drive-shell-parts.tsx` — FileTable mtime 0 → "—"
- `web/scenarios/cases.mjs` — #167(dir×2+file grant 권한 관측)
- `web/lib/__tests__/` — 신규 없음(순수 로직 추가가 없으면; crumbs 계산을 헬퍼로 뽑으면 단위 1개 추가 가능 — 구현 판단)

---

## Task 1+2 (단일 커밋 — 타입 상호의존): page 전달 + DriveShell 합성 모드

**Files:** Modify `web/app/d/[driveId]/page.tsx`, `web/components/drive-shell.tsx`

- [ ] **Step 1: page.tsx — entryItems 구성 헬퍼 + 전 분기 전달**

`page.tsx`를 다음 구조로 재작성. 핵심: ① hard-deny 분기 **불변**, ② 허용 렌더 전에 multi 여부를 공통 계산, ③ multi면 stat으로 entryItems.

```tsx
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
      const r = await callAgent(driveId, driveSecret, { method: "stat", path: p });
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
```

구현 전 확인: `callAgent`의 실제 export 위치/시그니처(`web/lib/rpc.ts|js` — fs 라우트들이 쓰는 그것)와 stat 응답 shape(`{ method:"stat", entry: DriveEntry|null }`, `web/lib/protocol.ts:42`)를 읽고 맞춘다. `getDrive` 반환에 `drive_secret`이 있는지 확인(fs 라우트들이 동일 패턴 사용).

- [ ] **Step 2: drive-shell.tsx — entryItems prop + isSyntheticRoot + role/canEdit/crumbs**

```tsx
type Props = {
  driveId: string;
  driveName: string;
  initialPath?: string;
  initialRole?: string;
  /** Multi-grant member's accessible entries; "" renders these instead of fs/list (synthetic root). */
  entryItems?: DriveEntry[];
};
```

(a) load 분기 — **role 리셋 포함** (review fix #1):
```tsx
  const isSyntheticRoot = !!entryItems && path === "";
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    // Synthetic root (multi-grant member at ""): server-side root fs/list would
    // 403 — render the member's own grant entries instead. Role resets to
    // viewer: a grant-level role picked up inside a path must not leak edit
    // affordances back onto the synthetic listing (its rows are grant roots —
    // a stale editor role would even expose a working Delete on them).
    if (entryItems && path === "") {
      setEntries(entryItems);
      setRole("viewer");
      setLoading(false);
      return;
    }
    /* 기존 fs/list fetch 그대로 */
  }, [driveId, path, entryItems]);
```

(b) canEdit 이중 차단 (방어 심층):
```tsx
  const canEdit = !isSyntheticRoot && (role === "editor" || role === "owner");
```

(c) crumbs — entryItems 모드에서 grant 단일 세그먼트 (review fix #3):
```tsx
  const crumbs = useMemo(() => {
    if (entryItems) {
      // Synthetic mode: never emit clickable segments between "" and the grant
      // (the member has no access there — they'd be guaranteed 403 dead-ends).
      // Chain: driveName("") → whole grant as one crumb → segments below it.
      const acc: { label: string; path: string }[] = [{ label: driveName, path: "" }];
      if (path === "") return acc;
      const grant = entryItems.map((e) => e.path).find((g) => path === g || path.startsWith(g + "/"));
      if (!grant) { acc.push({ label: path, path }); return acc; }
      acc.push({ label: grant, path: grant });
      let cur = grant;
      for (const p of path.slice(grant.length).split("/").filter(Boolean)) {
        cur = `${cur}/${p}`; acc.push({ label: p, path: cur });
      }
      return acc;
    }
    /* 기존 rootPath 클램프 로직 그대로 */
  }, [path, driveName, rootPath, entryItems]);
```

- [ ] **Step 3: typecheck** — `npm --prefix web run typecheck` exit 0
- [ ] **Step 4: 커밋** — `feat(drive): synthetic root for multi-grant members (Phase 1b)`

## Task 3: FileTable mtime 0 → "—"

**Files:** Modify `web/components/drive-shell-parts.tsx` (Modified 셀)
- [ ] `{e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : "—"}` → typecheck → commit `fix(ui): em-dash for zero mtime (synthetic entries)`

## Task 4: e2e #167 — multi-grant(디렉토리×2 + 파일) 권한 관측

**Files:** Modify `web/scenarios/cases.mjs` (#166 뒤, 동일 스타일)

- [ ] #165/#166 패턴으로: owner가 `docs`·`assets` mkdir + `assets/logo.txt` 업로드(fs/write). viewer를 `docs`(viewer), `assets/logo.txt`(파일 grant, viewer)에 invite → 단언: root fs/list **403**, `docs` fs/list **200**, `assets` fs/list **403**(grant는 파일이지 폴더 아님), `assets/logo.txt` fs/read **200** (review fix #2의 서버측 전제). 풀 suite GREEN(155/1 기대) → commit `test(scenarios): #167 multi-grant incl. file grant (synthetic-root preconditions)`

## Task 5: 실브라우저 검증 (review fix 4건 전부 관측)

- [ ] 시드: owner + drive + `docs`(viewer에게 **editor**로) + `a/b` 깊은 grant(viewer) + `assets/logo.txt` 파일 grant(viewer) → multi 멤버.
- [ ] playwright 단언:
  1. 드라이브 클릭 → 합성 root: `docs`·`a/b`·`assets/logo.txt` 행(파일은 파일 아이콘), 날짜 "—" 아님 1970 아님, **New folder/Upload 비활성**.
  2. `docs`(editor) 진입 → 편집 가능 → **breadcrumb root 복귀 → New folder/Upload/행메뉴 사라짐** (stale role fix).
  3. `a/b` 진입 → crumbs가 `[drive, a/b]` — **중간 `a` crumb 없음**.
  4. `assets/logo.txt` 행 클릭 → **Viewer로 열림** (ENOTDIR 에러 아님).
  5. `?path=docs`로 reload → Back/크럼로 "" 복귀 → **합성 root 재표시** (403 에러 아님).
  6. `?path=secret` hard-deny 불변.
- [ ] 스크린샷, 환경 정리.

## Self-Review (rev2)
- review fix #1: load 분기 setRole("viewer") + canEdit의 isSyntheticRoot 게이트(이중) + Task 5-2 관측.
- review fix #2: stat 기반 entryItems(+offline 휴리스틱) + Task 4 파일 grant 단언 + Task 5-4.
- review fix #3: crumbs grant-단일-세그먼트 + Task 5-3.
- review fix #4: entryView/entryItems를 모든 비-owner 허용 렌더에 전달 + Task 5-5.
- 불변식: hard-deny 분기 그대로(±0줄), 서버 재게이트 불변, entryItems=본인 grant 메타만.
- 성능: stat N회는 multi grant 수(통상 2~5) × RPC 1왕복 — RSC 1렌더당, `timeoutMs:3000`(half-open socket이 25s 기본값으로 렌더를 잡는 것 방지 — 품질리뷰 반영). 캐싱은 YAGNI.

## Follow-up (1b 범위 밖, 추적)

- **파일 grant의 editor 역할이 UI에서 막힘**: 합성 root의 role 리셋(viewer)은 옳지만, 파일 grant는 "들어가서 role을 회복"할 폴더가 없어 Viewer가 영구 read-only가 된다(서버는 쓰기를 허용함에도). 수정 방향: `computeEntry`가 이미 가진 멤버 row의 role을 entryItems에 per-grant로 실어 Viewer의 canEdit에 연결. 파일 단위 editor 공유가 실사용에 등장하면 착수.

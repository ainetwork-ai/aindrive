# Drive Access Entry (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공유받은 path-한정 멤버가 홈에서 드라이브를 클릭하면 "권한 없음" 대신 자기가 접근 가능한 진입점으로 자동 안착하게 한다 (P0 버그 해소).

**Architecture:** 서버가 `drive_members`만으로 사용자의 "진입점(entry path)"을 결정적으로 계산하는 순수 함수(`computeEntry`)를 access 층에 추가한다. 드라이브 페이지는 root 권한이 없을 때 거부하는 대신 이 진입점으로 `DriveShell`을 렌더(`initialPath`=진입점)한다. `drive-shell.tsx`는 이미 `initialPath`를 `rootPath`로 써서 grant-scoped 네비게이션을 하므로(`drive-shell.tsx:108-124`), 클라이언트 변경은 최소다. 데이터 스키마 변경 없음. 진열/결제는 무관(Phase 2).

**Tech Stack:** Next.js 15 (App Router, RSC), TypeScript, better-sqlite3 + drizzle, vitest (`web/lib/__tests__/`), 기존 e2e 시나리오 하니스(`web/scenarios/`).

**Scope 경계:**
- **Phase 1a (이 계획)**: 진입점 계산 + 안착(단일 진입점이면 그곳, 여러 개면 결정적으로 가장 얕은 1개) + `?path` oracle 차단. **이걸로 P0 버그 완결** — 단일이든 다중이든 일단 접근 가능한 곳으로 들어가진다.
- **Phase 1b (별도 계획)**: 다중 진입점일 때 한 곳으로 텔레포트 대신 "합성 root 개요 뷰"(접근가능 top-level들 나열). UX 개선이라 분리. 이 계획은 1b를 위해 `computeEntry`가 다중 정보(`allPaths`)도 반환하도록 설계해 확장 비용을 0으로 둔다.

---

## File Structure

- `web/lib/access-core.js` — **수정**. `computeEntry(rows, isOwner)` 순수 함수 추가. `bestMatchingRole`과 같은 "rows-from-DB → 결정" 류. WS(`dochub.js`)도 import 가능한 순수 모듈 유지.
- `web/lib/__tests__/access-core.test.ts` — **수정**. `computeEntry` 단위 테스트 추가.
- `web/lib/access.ts` — **수정**. `entryView(driveId, userId)` 추가: `drive_members` 행을 읽어 `computeEntry` 호출(DB 접근 래퍼).
- `web/app/d/[driveId]/page.tsx` — **수정**. root 거부 대신 진입점 안착 + `?path` hard-deny.
- `web/scenarios/cases.mjs` — **수정**. P0 회귀 시나리오(진입 안착, `?path` hard-deny) 추가.

---

## Task 1: `computeEntry` 순수 함수 (진입점 결정)

**Files:**
- Modify: `web/lib/access-core.js` (after `bestMatchingRole`, ~line 47)
- Test: `web/lib/__tests__/access-core.test.ts`

계약: `drive_members` 행 목록(이 드라이브·이 유저)과 `isOwner` 플래그를 받아 진입점을 결정.
- owner 거나 root 멤버십(`path === ""`) 보유 → `{ kind: "root", path: "" }`
- 멤버십 0개 → `{ kind: "none" }`
- 1개(조상 정리 후) → `{ kind: "single", path }`
- 여러 개(서로 cover 안 하는 path들) → `{ kind: "multi", path, allPaths }` (`path` = 결정적 기본 진입점)
- "조상 정리": 한 path가 다른 path의 조상이면 조상만 남긴다(가장 얕은 grant가 진입점이므로). `isAncestorOrSelf` 재사용.
- 결정적 정렬(테스트 가능): 깊이(`/` 개수) 오름차순 → 사전순. `path`는 정리된 목록의 첫 번째.

- [ ] **Step 1: Write the failing test**

`web/lib/__tests__/access-core.test.ts` 상단 import에 `computeEntry`를 추가하고(기존 `import { bestMatchingRole, ... } from "../access-core.js"` 줄에 합류), 파일 끝에 추가:

```ts
import { computeEntry } from "../access-core.js";

describe("computeEntry", () => {
  it("owner → root", () => {
    expect(computeEntry([], true)).toEqual({ kind: "root", path: "" });
  });
  it("no membership → none", () => {
    expect(computeEntry([], false)).toEqual({ kind: "none" });
  });
  it("root membership → root", () => {
    expect(computeEntry([{ path: "", role: "viewer" }], false)).toEqual({ kind: "root", path: "" });
  });
  it("single path member → single", () => {
    expect(computeEntry([{ path: "docs/specs", role: "viewer" }], false))
      .toEqual({ kind: "single", path: "docs/specs" });
  });
  it("collapses ancestor: docs covers docs/a → entry is docs", () => {
    expect(computeEntry([{ path: "docs", role: "viewer" }, { path: "docs/a", role: "editor" }], false))
      .toEqual({ kind: "single", path: "docs" });
  });
  it("two unrelated paths → multi, deterministic shallowest-then-alpha", () => {
    const r = computeEntry([{ path: "photos", role: "viewer" }, { path: "docs", role: "viewer" }], false);
    expect(r.kind).toBe("multi");
    expect(r.path).toBe("docs"); // same depth → alpha
    expect(r.allPaths).toEqual(["docs", "photos"]);
  });
  it("depth breaks ties before alpha: a/b/c vs z → z wins (shallower)", () => {
    const r = computeEntry([{ path: "a/b/c", role: "viewer" }, { path: "z", role: "viewer" }], false);
    expect(r.path).toBe("z");
    expect(r.allPaths).toEqual(["z", "a/b/c"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- access-core`
Expected: FAIL — `computeEntry is not a function` / `not exported`.

- [ ] **Step 3: Implement `computeEntry` in `web/lib/access-core.js`**

`bestMatchingRole` 함수 다음(`return best; }` 뒤, ~line 47)에 추가:

```js
/**
 * Decide a user's entry point into a drive from their membership rows.
 *
 * Pure: same inputs → same output (deterministic), so it is unit-testable and
 * reusable by both the HTTP page (access.ts) and the WS handler (dochub.js).
 * Only consumes drive_members rows + an isOwner flag — knows nothing about
 * commerce (listed/price). Entry selection: collapse ancestor-covered paths,
 * then pick shallowest (fewest "/"), ties broken alphabetically.
 *
 * @param {Array<{path: string, role: string}>} rows  drive_members for (drive,user), path pre-normalized
 * @param {boolean} isOwner  true if user owns the drive
 * @returns {{kind:"root"|"single"|"multi"|"none", path?: string, allPaths?: string[]}}
 */
export function computeEntry(rows, isOwner) {
  if (isOwner) return { kind: "root", path: "" };
  if (!rows || rows.length === 0) return { kind: "none" };
  if (rows.some((r) => r.path === "")) return { kind: "root", path: "" };

  // Collapse paths covered by a shallower grant (ancestor wins as entry).
  const paths = rows.map((r) => r.path);
  const roots = paths.filter(
    (p) => !paths.some((q) => q !== p && isAncestorOrSelf(q, p))
  );
  // Dedup (two rows same path) + deterministic order: depth asc, then lexicographic.
  const uniq = [...new Set(roots)].sort((a, b) => {
    const da = a === "" ? 0 : a.split("/").length;
    const db = b === "" ? 0 : b.split("/").length;
    return da !== db ? da - db : a < b ? -1 : a > b ? 1 : 0;
  });
  if (uniq.length === 1) return { kind: "single", path: uniq[0] };
  return { kind: "multi", path: uniq[0], allPaths: uniq };
}
```

`isAncestorOrSelf`는 이 파일이 이미 `import { normalizePath, isAncestorOrSelf } from "./path.js"`(line 9)로 가져오고 있으니 추가 import 불필요.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- access-core`
Expected: PASS (기존 `bestMatchingRole`/`mergeRoleUpgradeOnly` 테스트 포함 전체 GREEN).

- [ ] **Step 5: Commit**

```bash
git add web/lib/access-core.js web/lib/__tests__/access-core.test.ts
git commit -m "feat(access): computeEntry — deterministic drive entry point from membership"
```

---

## Task 2: `entryView` DB 래퍼 (access.ts)

**Files:**
- Modify: `web/lib/access.ts` (after `resolveRoleByUser`, ~line 28)

`computeEntry`에 줄 `rows`(이 드라이브·이 유저의 `drive_members`)와 `isOwner`를 DB에서 조달.

- [ ] **Step 1: Implement `entryView` in `web/lib/access.ts`**

`resolveRoleByUser` 함수 다음(line 28 `}` 뒤)에 추가. 파일 상단은 이미 `drizzleDb`, `drives`, `drive_members`, `eq`, `and`를 import 중(line 1-3):

```ts
import { computeEntry } from "./access-core.js";

/**
 * Compute a user's entry point into a drive (pure logic in computeEntry).
 * Returns {kind:"root"|"single"|"multi"|"none", path?, allPaths?}. Used by the
 * drive page to land path-scoped members on an accessible path instead of
 * rejecting them at root. Reads only drive_members + ownership (access layer).
 */
export function entryView(driveId: string, userId: string) {
  const drive = drizzleDb
    .select({ owner_id: drives.owner_id })
    .from(drives)
    .where(eq(drives.id, driveId))
    .get();
  if (!drive) return { kind: "none" as const };
  const isOwner = drive.owner_id === userId;
  const rows = drizzleDb
    .select({ path: drive_members.path, role: drive_members.role })
    .from(drive_members)
    .where(and(eq(drive_members.drive_id, driveId), eq(drive_members.user_id, userId)))
    .all() as { path: string; role: string }[];
  return computeEntry(rows, isOwner);
}
```

`computeEntry` import는 파일 상단 import 그룹에 추가(기존 `import { ... } from "./access-core.js"` 줄에 `computeEntry` 합치거나 별도 줄).

- [ ] **Step 2: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: PASS (no type errors). `entryView` 반환 타입이 union으로 추론되는지 확인.

- [ ] **Step 3: Commit**

```bash
git add web/lib/access.ts
git commit -m "feat(access): entryView — read membership + computeEntry for a drive"
```

---

## Task 3: 드라이브 페이지 진입점 안착 + `?path` hard-deny

**Files:**
- Modify: `web/app/d/[driveId]/page.tsx` (전체 로직, 현재 line 19-34)

현재 동작(`page.tsx:23-26`): `resolveRole(driveId, userId, initialPath)` → viewer 미만이면 거부.

새 동작:
- `?path` **명시 제공**(rawPath 존재) + 그 path 권한 없음 → **현행 그대로 hard-deny**(oracle 차단: redirect 안 함).
- `?path` **없음**(root 접근) + root 권한 없음 → `entryView`로 진입점 계산:
  - `single`/`multi` → 그 `path`를 `initialPath`로 `DriveShell` 렌더(역할은 그 path 기준 `resolveRole`).
  - `none` → 거부(현행 메시지).
- `?path` 있고 권한 있음 / owner / root 멤버 → 현행처럼 그 path 렌더.

- [ ] **Step 1: Rewrite `web/app/d/[driveId]/page.tsx`**

```tsx
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
    // becomes a per-path access oracle (spec D5 / review sec S2).
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
```

- [ ] **Step 2: Typecheck**

Run: `npm --prefix web run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/app/d/[driveId]/page.tsx
git commit -m "fix(drive): land path-scoped members on entry point; hard-deny explicit ?path"
```

---

## Task 4: e2e 회귀 시나리오 (P0 버그 RED→GREEN)

**Files:**
- Modify: `web/scenarios/cases.mjs` (멤버십/역할 게이팅 클러스터 #59-#65 부근)

기존 시나리오 하니스의 헬퍼(`signup`, `ensureDrive`, `apiFetch` 패턴, 실 server+agent)를 사용한다. **이 단계 전에 반드시 `web/scenarios/cases.mjs`를 읽고** 기존 케이스(특히 #60-#63: 멤버 초대 후 list/write)의 헬퍼 사용법·단언 스타일을 그대로 따른다. (이 plan은 케이스 본문 스켈레톤만 제시; 실제 헬퍼 이름은 파일에서 확인해 맞춘다.)

검증할 동작 2가지:
1. **진입 안착**: owner가 `docs` 경로에 viewer로 다른 계정을 초대 → 그 계정이 드라이브 페이지를 **path 없이** 열었을 때(서버 렌더 경로), 접근이 거부되지 않고 `docs`로 안착(role=viewer). HTTP 레벨에선 page.tsx가 RSC라 직접 테스트가 어려우므로, **진입점 계산 자체를 검증**: `entryView`가 정확한 path를 반환하는지 + 그 path의 `fs/list`가 200인지(root list는 403, docs list는 200).
2. **`?path` hard-deny**: 같은 viewer가 권한 없는 `secret` 경로를 `fs/list?path=secret`로 조회 → 403(현행 게이트 유지).

- [ ] **Step 1: Read existing scenario helpers**

Run: `sed -n '1,60p' web/scenarios/cases.mjs` 및 #59-#65 케이스 확인. 헬퍼(`signup`, drive 생성, 멤버 초대 `POST /members`, `apiFetch`)의 정확한 시그니처를 파악.

- [ ] **Step 2: Add the failing scenario cases**

#65 부근(멤버 role 게이팅 클러스터 끝)에 추가. 아래는 **구조 스켈레톤** — 실제 헬퍼명은 Step 1에서 확인해 치환:

```js
// #P0a — path-scoped viewer: root fs/list denied, granted sub-path allowed.
// (entry point: a docs-only viewer must be able to reach docs, not root.)
case("#P0a path-scoped viewer reaches granted sub-path, not root", async (s) => {
  const owner = await signup(s);                       // helper from file
  const drive = await ensureDrive(s, owner);           // helper from file
  // create docs/ in the drive (agent-backed mkdir), then invite a fresh viewer at "docs"
  await mkdir(s, owner, drive, "docs");
  const viewer = await signup(s);
  await invite(s, owner, drive, { path: "docs", role: "viewer", email: viewer.email });
  // root list denied:
  const rootList = await apiAs(viewer, `/api/drives/${drive.id}/fs/list?path=`);
  eq(rootList.status, 403);
  // granted sub-path list allowed:
  const docsList = await apiAs(viewer, `/api/drives/${drive.id}/fs/list?path=docs`);
  eq(docsList.status, 200);
});

// #P0b — explicit inaccessible ?path is a hard deny (no oracle).
case("#P0b path-scoped viewer denied on an un-granted sibling", async (s) => {
  // ...same setup; viewer granted at docs; list of un-granted "secret" → 403
  const secretList = await apiAs(viewer, `/api/drives/${drive.id}/fs/list?path=secret`);
  eq(secretList.status, 403);
});
```

> 주의: `entryView`는 서버 전용 함수라 e2e(HTTP)로 직접 못 부른다. 대신 위처럼 **관측 가능한 결과**(granted sub-path는 200, root·un-granted는 403)로 진입점 의도를 검증한다. `entryView` 자체의 분기는 Task 1 단위테스트가 커버한다.

- [ ] **Step 3: Run e2e (dev 서버 없이 단독)**

Run: `npm --prefix web run test:e2e`
Expected: 신규 케이스 포함 전체 GREEN (기존 151 + 신규). 만약 RED면 헬퍼 시그니처 불일치 → Step 1로 돌아가 수정.

- [ ] **Step 4: Commit**

```bash
git add web/scenarios/cases.mjs
git commit -m "test(scenarios): path-scoped viewer entry + ?path hard-deny (P0 regression)"
```

---

## Task 5: 실브라우저 확인 (Monaco 교훈 — HTTP e2e로 안 잡히는 부분)

**Files:** 없음(검증만).

P0 버그의 *사용자 체감*(홈→클릭→안착)은 RSC 렌더라 HTTP e2e로 안 잡힌다. 실 브라우저로 확인.

- [ ] **Step 1: 로컬 dev 인스턴스 기동 + 시드**

기존 데모 띄우는 법으로 server+agent 기동(setsid 데몬). owner 계정으로 드라이브 만들고 `docs` 폴더 생성, 둘째 계정을 `docs`에 viewer 초대.

- [ ] **Step 2: playwright로 둘째 계정 로그인 → 홈 → 드라이브 클릭**

Expected: "You don't have access"가 **안 뜨고**, `docs` 내용이 보인다(breadcrumb root=docs). 콘솔 에러 0.

- [ ] **Step 3: 결과 기록**

스크린샷 + 콘솔/네트워크 확인. RED였던 버그가 시각적으로 GREEN인지 확인.

(데모 정리: 검증 후 server/agent kill + 데모 데이터 삭제.)

---

## Self-Review (작성자 체크)

- **Spec 커버리지**: D5(진입점 결정 + `?path` oracle 차단) → Task 1·3. D6(진입점=access층) → Task 1·2(`access-core.js`/`access.ts`, commerce import 없음). P0 버그 → Task 3·4·5. 진열/결제(Phase 2)·합성 root(Phase 1b)·URL segment(후속)는 의도적으로 범위 밖.
- **Placeholder**: Task 4만 헬퍼명을 "파일에서 확인"으로 둠 — 이는 기존 시나리오 컨벤션을 깨지 않기 위한 의도적 위임이며, Step 1에서 실제 확인하도록 강제. 그 외 Task 1-3은 완전한 코드 제시.
- **타입 일관성**: `computeEntry` 반환 `{kind, path?, allPaths?}` — Task 1 정의, Task 2 그대로 반환, Task 3에서 `entry.kind`/`entry.path` 사용. 일치.
- **불변식**: 권한 판정은 여전히 `resolveRole`(=`drive_members`)만. `computeEntry`는 진입점 *제안*일 뿐, Task 3에서 `renderPath`에 대해 `resolveRole`을 **다시 호출**해 실제 역할을 확정 → 진입점 계산 버그가 권한 상승으로 이어지지 않음.

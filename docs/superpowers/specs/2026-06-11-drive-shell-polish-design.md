# Drive shell polish: 정렬 · 검색 · 그리드 썸네일 — design

2026-06-10 UIUX 오버홀(3'-2)에서 의도적으로 연기된 3건. 셸의 표현층 +
썸네일용 읽기전용 API 1개. 권한 모델·결제·진열 불변식은 건드리지 않는다.

## 1. 이름 정렬 (+ 컬럼 정렬)

현행: `fs/list`가 에이전트의 readdir 순서를 그대로 반환, 클라이언트도
재정렬하지 않음 → 사실상 무작위.

- `web/lib/sort-entries.ts` 신규: `sortEntries(entries, key, dir)`.
  - **폴더 우선** 고정, 그 안에서 key 비교.
  - key = `name` | `mtime` | `size`. name은 `Intl.Collator(undefined,
    {numeric: true, sensitivity: "base"})` — "file2" < "file10".
  - 디렉토리의 size 비교는 name 폴백(서버 size 의미 없음).
- 상태는 `drive-shell.tsx`가 소유(`viewMode`와 동일 패턴), localStorage
  `aindrive:sort` = `{key, dir}`. 기본 `name asc`.
- 리스트 뷰: thead의 Name/Modified/Size를 버튼화, 활성 컬럼에 ▲/▼
  (lucide ArrowUp/ArrowDown 3.5w). 같은 컬럼 재클릭 = 방향 토글.
- 그리드 뷰: 같은 정렬 상태를 공유(별도 UI 없음 — 리스트에서 바꾼 정렬이
  그리드에도 적용. 그리드 전용 정렬 드롭다운은 YAGNI).

## 2. 검색 (현재 폴더 파일명 필터)

UIUX 스펙 3'-2의 원문 그대로: "드라이브 검색(파일명 필터, 클라이언트)".

- `DriveHeader`에 검색 입력(lucide Search 아이콘, placeholder "Search in
  this folder", ⌘ 없이 단순 input, 150ms debounce — `use-debounce` 기존 의존성).
- 필터: `entry.name.toLowerCase().includes(q.toLowerCase())`. 현재 폴더
  엔트리만 대상(진열 카드는 비대상 — 판매 진열은 탐색이 아니라 상점).
- 필터 결과 0건이면 기존 빈 상태 컴포넌트에 "No files match \"q\"" 변형.
- 폴더 이동 시 검색어 리셋. 드라이브 전체 재귀 검색은 에이전트 RPC(재귀
  list)가 필요한 별도 작업 — 범위 밖.

정렬·검색 적용 순서: `useMemo(filter → sort)` 한 곳에서 — 리스트/그리드가
같은 배열을 소비.

## 3. 그리드 이미지 썸네일

### 접근법 비교
1. 클라이언트 fs/read(base64) → data URL — 원본 전체 바이트가 이미지마다
   JSON으로 흐름(8MB 사진 = 11MB 응답 × N장), 캐시 불가. 기각.
2. `<img src=fs/download>` 직결 — 리사이즈 없음 + `no-store`라 재방문마다
   원본 재전송. 기각.
3. **서버 썸네일 엔드포인트 (채택)** — 원본은 에이전트에서 1회만 끌어오고
   서버 디스크에 리사이즈 결과를 캐시, 클라이언트엔 immutable 캐시 헤더.

### 엔드포인트
`GET /api/drives/[driveId]/fs/thumbnail?path=…` (읽기 전용)

- 권한: `fs/read`와 동일 가드(로그인 + viewer 이상). 동일 코드 경로 재사용.
- 대상: `entry.mime`이 `image/*`인 파일만(요청 path의 확장자 기준 mime 판정,
  비이미지는 415). SVG는 변환 없이 그대로 전달(스크립트 무력화를 위해
  `Content-Type: image/svg+xml` + `Content-Security-Policy: sandbox` 헤더).
- 생성: 에이전트 `read`(base64, 기존 16MB 한도 그대로 — 초과는 413 →
  클라이언트는 아이콘 폴백) → `sharp(buf).rotate().resize({width: 256,
  height: 256, fit: "inside", withoutEnlargement: true}).webp({quality: 78})`.
  `rotate()`는 EXIF 방향 보정.
- 캐시: `AINDRIVE_DATA_DIR/thumbs/<driveId>/<sha1(path)>-<mtimeMs>.webp`.
  mtime이 키에 들어가므로 파일 수정 시 자연 무효화(구 mtime 파일은 잔존 —
  용량이 수십 KB라 정리는 후속). 조회는 stat(에이전트 RPC)로 mtime 확인 후
  캐시 적중 시 에이전트 read 생략.
- 응답 헤더: `Content-Type: image/webp`, `Cache-Control: private,
  max-age=31536000, immutable` + URL에 `&v=<mtimeMs>` 쿼리(브라우저 캐시
  무효화 키). 실패(에이전트 오프라인/413/변환 실패)는 4xx/5xx — 그리드는
  `onError`로 타입 아이콘 폴백.
- 의존성: `sharp`를 web 명시 의존성으로 추가(현재 next 경유 optional로만
  존재). Docker는 bookworm(glibc) — prebuilt 바이너리 OK.

### 그리드 카드
- `entry.mime.startsWith("image/")`인 카드: 아이콘 영역 대신 상단에
  `<img src={thumbUrl} loading="lazy" …>` — 카드 폭 채움, `aspect-[4/3]
  object-cover rounded-md bg-drive-sidebar`(로딩 중 배경). `onError` 시
  기존 아이콘으로 폴백(상태 1개).
- 리스트 뷰는 현행 아이콘 유지(행 높이 불변 — 스캔성 우선).

## 테스트

- 단위: `sort-entries.test.ts`(폴더 우선, 자연 정렬, dir 토글, size에서 dir
  name 폴백), 썸네일 캐시 키 헬퍼(분리된 순수 함수면).
- e2e 시나리오(cases.mjs 추가): 작은 PNG를 `fs/write` → `fs/thumbnail` GET →
  200 + `image/webp` + 두 번째 GET이 캐시 적중(응답 동일). 비이미지 path →
  415. 권한 없는 사용자 → 403.
- 정렬·검색은 클라이언트 전용이라 단위 테스트 + 기존 e2e green 유지로 충분.

## 범위 밖 (후속)

- 드라이브 전체 재귀 검색, 그리드 전용 정렬 UI, 비이미지(영상/PDF) 썸네일,
  썸네일 캐시 용량 정리(GC).

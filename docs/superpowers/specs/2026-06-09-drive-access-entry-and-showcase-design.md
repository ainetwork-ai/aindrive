# Drive Access Entry (+ optional Showcase) — Design

설계 확정일: 2026-06-09. 브레인스토밍 산출물. 스펙 리뷰(보안/아키/제품 3렌즈) 반영 개정.

## 본질 (먼저 못 박는다)

aindrive의 본질은 **"내 로컬 폴더를 안전하게 공유하는 드라이브"** 다. 판매·진열·결제는 그 위에 얹는 *부가 기능*이지 본체가 아니다. 따라서 이 작업의 1순위는 **공유받은 사람이 자기가 받은 폴더에 들어가게 하는 것**(아래 P0 버그)이고, 진열/마켓은 명확히 부속으로 격리한다. (초안이 마켓플레이스에 과몰입해 무게중심이 틀어졌던 것을 교정함.)

## 배경 / 문제

1. **[P0 버그] 공유받은 하위 디렉토리 접근 불가.** 홈("My drives")에서 공유받은 드라이브를 클릭하면 "You don't have access" 가 뜬다. 원인: 홈 목록 링크가 `/d/<id>`(root)로만 걸려 있고(`web/app/page.tsx:58`), 드라이브 페이지는 `?path`로 권한을 해석한다(`web/app/d/[driveId]/page.tsx:23`). path-한정 멤버는 root(`""`)에서 `bestMatchingRole`이 "none" → 거부. `?path`를 손으로 정확히 넣으면 정상 동작. **이게 이번 작업의 핵심.**

2. **[설계] "진입점"을 아무도 계산하지 않는다.** 권한 판정 자체는 서버에서 `drive_members` 기준으로 견고하다(`web/lib/access.ts`, `access-core.js#bestMatchingRole`). 문제는 홈 목록이 "이 사용자가 이 드라이브의 어디에 들어갈 수 있는가"를 모른 채 무조건 root로 보낸다는 것.

3. **[부가] 진열(showcase).** 소유자가 *판매용으로 등록한* 폴더를, 아직 권한 없는 사용자에게 잠금+가격으로 노출해 구매를 유도. **단 이건 부가 기능이며, "낯선 사람이 공개적으로 도착하는 마켓플레이스"는 이 스펙 범위 밖**(아래 비목표 참조).

## 비목표 (명시적 범위 밖 — §2 긍정 cross-ref)

- **URL을 query param(`?path=`)에서 path segment(`/d/<id>/docs/specs`)로 전환.** path segment가 URL 설계로는 더 정석이다(북마크·뒤로가기·`%2F` 인코딩 제거). 하지만 그건 **순수 URL 미용**이고, P0 버그(드라이브 접근)와 **독립**이다 — ②는 `?path`든 segment든 "서버가 진입점을 계산한다"로 풀린다. segment 전환은 Next.js catch-all 라우트(`app/d/[driveId]/[[...path]]/page.tsx`) + 모든 내부 링크/redirect/share-gate 수정을 요하는 별도 리팩토링이라, P0에 묶으면 버그 수정이 URL 대공사에 인질로 잡힌다. **별도 후속 이슈로 분리.** (이 스펙은 `?path`를 유지하되, 그 권한-결합 문제는 D5에서 끊는다 — query param 자체가 아니라 "권한을 URL에 의존"하던 게 진짜 결함이었다.)
- **공개 마켓플레이스 도착 경로.** 현재 진열은 *드라이브에 이미 어떤 멤버십이 있는 사용자*(부분 멤버)에게 보이는 업셀 surface다. 낯선 사람이 판매자 storefront에 도달하는 공개 경로(공개 `/browse` 피드, 비멤버용 공개 드라이브 URL)는 **별도 후속 작업**으로 분리한다. 이 스펙은 그 *기반*(진열 메커니즘·권한 분리)만 짓고 공개 도착은 짓지 않는다 — 그래야 "드라이브 본질" 작업이 마켓 기능에 발목 잡히지 않는다.
- 구매목록/소유 surface, 환불·재판매·저작권 이전, 결제 전 미리보기/샘플 — 모두 후속.

## 핵심 설계 결정

### D1. 잠금 표시는 두 종류로 가른다

- **진열 잠금**: 소유자가 판매 대상으로 등록(`listed`)한 것 → **leaf 이름** + 🔒 + 가격으로 보인다. 클릭 시 결제 → 열림.
- **사적 폴더**: 등록 안 한 것 → **안 보인다**(이름조차 유출 금지).

권한 없는 모든 것을 노출하지 않는다 — 사적 폴더 이름 자체가 기밀일 수 있다.

**[리뷰 반영 — 보안 C1] 유출 자산은 "내용"이 아니라 `path` 문자열 자체다.** share row의 `path`는 전체 경로(`clients/acme-corp/q3-pitch`)라 조상 디렉토리 이름(`acme-corp`, 기밀일 수 있음)을 담는다. 따라서:
- 비구매자에게 보내는 진열 DTO는 **leaf 이름만**: `{ shareId, leafName, role, price, currency }`. **전체 `path` 절대 금지.**
- 진열은 **드라이브에 평면(flat) 리스트**로, 진입 뷰에 노출. 실제 부모 경로 아래 중첩 배치하지 않는다(중첩하면 조상 이름이 다시 샘).
- 구매자는 settle 후에만 실제 path를 받는다(기존 share-gate가 이미 그럼).

### D2. 권한층과 상거래층 분리

접근권은 단일 소스, 상거래는 그걸 가리키는 별도 레이어. (`folder_access` 제거 → `drive_members` 통일의 연장.)

```
[권한 층 — 단일 진실]   drive_members(drive_id, user_id, path, role)   ← 안 건드림
[상거래 층]            drives(..., allowed_tokens)   shares(..., listed, currency)
```

권한 판정은 영원히 `drive_members`만 본다. `listed`/`price`/`currency`는 판정에 관여하지 않는다.

### D3. 스키마 — 기존 컬럼 재사용, 신규 컬럼 충돌/중복 회피

**[리뷰 반영 — 아키 C1·C2] 기존 `shares` 컬럼을 먼저 직시한다:**
- `shares.token` = **URL 슬러그**(`/s/<token>`, unique, NOT NULL). **"결제 통화"용으로 `token` 컬럼 추가 절대 금지**(duplicate column + 의미 충돌). 통화는 `currency`(또는 `price_token`)로.
- `shares.price_usdc` = **실사용 가격 컬럼**. 새 `price` 컬럼 추가하지 않는다 — `price_usdc`를 canonical 가격으로 재사용(이름의 "usdc"는 historical, 후속 마이그레이션에서 정리 가능).
- `shares.payment_chain` = **이미 dead column**. 작성만 되고(`"base-sepolia"` 리터럴) settle은 `X402_NETWORK` 상수를 하드코딩해 이 컬럼을 안 읽는다. → 새 컬럼 만들지 말고 **이 자리를 `currency`로 대체/재정의**.

결과 신규 컬럼은 **단 두 개**: `shares.listed`(P0/부가), `drives.allowed_tokens`(Phase 2). 둘 다 `db.js`의 idempotent `ALTER TABLE ADD COLUMN` 패턴에 그대로 맞는다.

### D4. 결제자 식별 = 로그인 계정

settle은 이미 `drive_members`에 `user_id`로 멤버십 행을 INSERT. 로그인 사용자가 진열 클릭 → 지갑 connect → x402 결제 → settle → 그 user_id에 멤버십. 지갑은 결제 순간만, 계정↔지갑 영구연결(SIWE link)은 불필요(범위 밖).

### D5. 진입점 결정 + `?path` oracle 차단

**[리뷰 반영 — 제품 S1] 단일/다중 진입점 분기:**
- 접근가능 path가 **1개**면 → 바로 그 path로 진입.
- **여러 개**면 → 텔레포트하지 말고 **합성 root 뷰**: 그 사용자의 접근가능 top-level path들 + 진열 항목을 한 화면에 나열. (드라이브 개요처럼.)
- owner거나 root 멤버십이면 → 진입점은 root(`""`).
- 동률 tie-break(테스트 결정성용): 깊이 → 사전순. 단 이건 "단일 진입 바로가기"의 내부 규칙이지 사용자에게 보이는 주 동작이 아니다.

**[리뷰 반영 — 보안 S2] `?path` oracle 차단:** 진입점 안착은 `listEntryView` 기준으로 `?path`와 **독립** 계산. 명시적으로 들어온 접근 불가 `?path`는 오늘처럼 **uniform hard-deny**(redirect-to-entry 금지 — render-vs-redirect 신호가 path 추측 oracle이 됨). entry 자동안착은 **root path가 없을 때만** 발동.

### D6. 모듈 경계 — 진입점은 access 층, 진열은 commerce 층

**[리뷰 반영 — 아키 S2] D2의 분리를 코드에도 적용:**
- **진입점 계산**(순수 `drive_members` 수학) → `access-core.js`/`access.ts`. `bestMatchingRole`과 같은 종류. WS(`dochub.js`)도 재사용 가능하게.
- **진열 쿼리**(`listed` shares) → 별도 commerce 모듈(`lib/showcase.ts` 등). access 모듈이 `shares`를 import하면 안 됨.
- 디렉토리/진입 응답은 둘을 **조합**.

## 단계 분리 (드라이브 본질 우선)

### Phase 1 — 드라이브 접근 진입 (본체, P0)

순수 권한/드라이브 기능. **결제·진열 무관하게 독립 가치.**
- `entryView(driveId, userId)`: `drive_members`로 접근가능 진입점 계산(D5). access 층.
- 드라이브 페이지: root 권한 없으면 거부 대신 진입점 안착(단일) 또는 합성 root(다중). `?path` oracle 차단(D5).
- 홈 목록(`page.tsx`)·drive-shell: 서버가 준 진입점으로 링크. path 추측 금지.
- **데이터 변경 없음**(권한은 기존 `drive_members`로 충분).
- 이걸로 P0 버그 종결. 진열 없이도 완결.

### Phase 2 — 진열 + 결제 토큰 (부가)

- `shares.listed`(INTEGER DEFAULT 0) + `drives.allowed_tokens`(TEXT, JSON) 추가.
- **진열 생성 UI를 같은 Phase에**: share-dialog에 `☑ 진열` 체크박스(리뷰 제품 C2 — Phase 분리로 "생성 UI 없는 렌더러" 방지). 진열과 그 표시를 한 묶음으로 출시.
- 진열 표시: 전용 access-gated 엔드포인트(`GET /api/drives/[driveId]/showcase`)가 leaf-이름 DTO만 반환(D1). 진입 뷰에 평면 노출.
- 결제 토큰: `shares.currency`(payment_chain 대체) + `drives.allowed_tokens` 검증. settle의 `X402_NETWORK` 하드코딩(+ `s/[token]/route.ts`의 asset/EIP-712) 정책 기반 교체.
- 구매: 진열 클릭 → x402(base/FANCO) → settle → 멤버십(D4).

> `allowed_tokens` 포맷: JSON 배열의 `{symbol, chain, asset}` 객체(bare symbol은 settle의 x402 requirements에 불충분 — asset address·EIP-712 name 필요). Phase 2 착수 시 확정.

### Phase 3 — 권한관리 UI/UX 개선

로직은 e2e GREEN. share-dialog 멤버리스트/역할선택 등 표면 다듬기. Phase 1·2 완료 후 구체화.

## 권한 모델 불변식 (절대 불변)

- 접근 판정은 `drive_members`(+`drives.owner_id`)만. `listed`/`price`/`currency`는 판정에 무관.
- 잠긴 path의 **내용도, 전체 path 문자열도** 비권한자에게 노출 안 함. 진열은 leaf 이름 메타만(D1).
- 유료 share는 settle **전에는** 멤버십 없음(기존 불변식, e2e #161~ 검증).
- `mergeRoleUpgradeOnly`: 재초대/재결제가 역할 강등 안 함.
- WS(`dochub.js`)는 진열 로직 불필요·금지 — 잠긴 path는 멤버십 없으니 `4401`로 정확히 거부됨(올바른 동작). 단 테스트로 못박는다(아래).

## 테스트 전략

기존 e2e 하니스(`web/scenarios/`, 151 케이스)에 추가:
- **[P1] 진입점**: path-한정 viewer가 홈→클릭 시 접근가능 path로 안착(현 버그 RED→GREEN). 다중 path는 합성 root.
- **[P1] `?path` oracle**: 접근 불가 명시 `?path` → uniform hard-deny(현 동작 유지).
- **[P2] 진열 가시성**: 비구매자가 `listed` 유료 share를 leaf+가격으로 본다. 단 **전체 path·내용은 못 본다**(fs/list 403/leaf-only DTO).
- **[P2] 사적 폴더 비노출**: `listed` 아닌 비권한 path는 진열에 안 나온다.
- **[P2] WS 거부**: 비구매자가 listed-but-unpaid path로 WS 열기 → `4401`.
- **[불변식] 결제 전 무멤버십**: 진열이 보여도 settle 전 `drive_members` 행 없음.

브라우저 렌더 의존(🔒 배지)은 HTTP e2e로 안 잡힘(Monaco 교훈) → 실브라우저 확인을 plan에 포함.

## 영향 파일 (Phase 1 기준)

- `web/lib/access.ts` / `access-core.js` — `entryView` 신규(순수 권한)
- `web/app/d/[driveId]/page.tsx` — 진입점 안착 + `?path` hard-deny
- `web/app/page.tsx` + `web/components/drive-shell*.tsx` — 진입점 링크, (다중 시) 합성 root
- `web/lib/drives.ts` — 홈 목록이 진입점 계산에 필요한 멤버 정보 제공
- `web/scenarios/cases.mjs` — P1 테스트

(Phase 2 영향 파일은 Phase 2 plan에서.)

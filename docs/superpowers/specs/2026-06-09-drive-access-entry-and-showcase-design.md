# Drive Access Entry + Showcase — Design

설계 확정일: 2026-06-09. 브레인스토밍 산출물.

## 배경 / 문제

사용자가 직접 써보다 발견한 버그 + 그에 엮인 설계 결함:

1. **[버그] 공유받은 하위 디렉토리 접근 불가.** 홈("My drives")에서 공유받은 드라이브를 클릭하면 "You don't have access" 가 뜬다. 원인: 홈 목록 링크가 `/d/<id>`(root)로만 걸려 있고(`web/app/page.tsx:58`), 드라이브 페이지는 `?path`로 권한을 해석한다(`web/app/d/[driveId]/page.tsx:23` → `resolveRole(driveId, userId, initialPath)`). path-한정 멤버는 root(`""`)에서 `bestMatchingRole`이 "none"을 반환 → 거부. `?path`를 손으로 정확히 넣으면 정상 동작한다.

2. **[설계] "진입점"을 아무도 계산하지 않는다.** 권한 판정 자체는 서버에서 `drive_members` 기준으로 견고하다(`web/lib/access.ts`, `access-core.js#bestMatchingRole`). 문제는 클라이언트(홈 목록)가 "이 사용자가 이 드라이브의 어디에 들어갈 수 있는가"를 모른 채 무조건 root로 보낸다는 것.

3. **[제품] Discovery 부재.** aindrive는 콘텐츠 마켓플레이스를 지향한다("web3 작가·예술가가 콘텐츠/저작권을 사고판다"). "존재를 알아야 산다" — 비구매자가 판매 중인 콘텐츠의 존재를 볼 수 없으면 구매 기회 자체가 사라진다. 현재 권한 없는 path는 그냥 안 보인다.

## 핵심 설계 결정 (브레인스토밍 합의)

### D1. 잠금 = 진열창 (discovery), 단 "팔려고 내놓은 것"만

권한 없는 폴더를 보여줄지는 두 종류로 가른다:

- **진열 잠금**: 소유자가 판매 대상으로 등록한 것 → 이름 + 🔒 + 가격으로 **보인다**(진열창). 클릭 시 결제 → 열림.
- **사적 폴더**: 소유자가 아무에게도 안 준 것 → **안 보인다**(이름조차 유출 금지. 예: `taxes-2026.xlsx`).

"권한 없는 모든 것을 노출"하지 않는다 — 사적 폴더 이름 자체가 기밀일 수 있기 때문.

### D2. 권한층과 상거래층 분리 (권한관리 건전성)

권한관리의 황금률 — **접근권은 단일 소스, 상거래는 그걸 가리키는 별도 레이어**. 이 레포가 이미 `folder_access`를 없애고 `drive_members`로 권한을 통일한 그 원칙의 연장.

```
[권한 층 — 단일 진실]
  drive_members(drive_id, user_id, path, role)   ← 누가 어디에 접근 가능 (그대로 유지)
      ↑ 결제 settle / 무료 CONSUME 이 여기에 행을 씀

[상거래 층]
  drives(..., allowed_tokens)                     ← 드라이브 통화 정책 [신규]
  shares(..., path, role, price, token, listed)   ← 진열/가격 [컬럼 추가]
      ↑ "권한을 부여하는 방법"이지 권한 자체가 아님
```

권한 판정은 영원히 `drive_members`만 본다(불변식). `listed`/`price`/`token`은 권한과 독립 — "무료로 그냥 권한 주기 / 유료로 팔기 / 팔되 진열 안 하기"가 서로 간섭 없이 표현된다.

### D3. 토큰 정책 = 드라이브 정책 + share 인스턴스 (2계층)

백화점(드라이브)이 허용 통화를 정하고, 입점 매장(share)이 그 안에서 가격표를 붙인다.

- `drives.allowed_tokens`: 이 드라이브에서 결제 가능한 토큰 목록 (예: `[FANCO@base]`). 소유자가 설정.
- `shares.price` + `shares.token`: 그 허용 목록 내에서 판매자가 선택. share 생성 시 `token ∈ allowed_tokens` 검증.
- 현재 `payment_chain` 하드코딩(`base-sepolia`, `shares/route.ts:64`)을 정책 기반으로 교체.

> 주의(YAGNI): 지금 허용목록은 `[FANCO]` 하나일 가능성이 크다. 드라이브 단위 정책은 "필드 + 검증" 수준으로 단순하게 두고, 다중 토큰 UI는 실제 필요 시 확장.

### D4. 결제자 식별 = 로그인 계정

settle은 이미 `drive_members`에 `user_id` 기준으로 멤버십 행을 INSERT 한다(`app/api/s/[token]/accept` + settle 경로). 따라서:

- 로그인 사용자가 진열 클릭 → 지갑 connect → x402 결제 → settle → **그 user_id에 멤버십 부여**.
- 지갑은 **결제 순간에만** 필요. 계정↔지갑 영구 연결(SIWE link)은 **불필요** — 그건 별개 신원 기능이며 이 작업 범위 밖.

## 단계 분리 (사용자 합의)

범위가 크므로 독립 단계로 나눈다. 각 단계는 자체 plan → 구현 → 검증 사이클.

### Phase 1 — 접근 진입 + 진열 표시 (이 spec의 1차 구현 대상)

가장 가치 높음: 보고된 버그(②) 해소 + 제품 핵심(discovery). 데이터 모델 변경 최소.

**서버:**
- `listEntryView(driveId, userId)` (신규, `web/lib/access.ts` 또는 인접): 주어진 사용자에 대해
  - **접근가능 진입점**: `drive_members` 중 이 사용자를 cover 하는 path들. 기본 진입점 선택 규칙: ① 깊이(경로 세그먼트 수)가 가장 얕은 것, ② 동률이면 사전순 첫 번째 — 결정적(deterministic)이어야 테스트 가능. owner거나 root 멤버십이 있으면 진입점은 root(`""`).
  - **진열 path**: `listed` 유료 share 중 이 사용자가 아직 권한 없는 것.
- 드라이브 페이지(`app/d/[driveId]/page.tsx`): root 권한이 없으면 거부하는 대신, 위 진입점으로 안착. 진입점도 없고 진열도 없으면 그때만 "접근 없음".
- 디렉토리 목록 응답에 진열 항목을 **잠금 메타(이름+🔒+가격)** 로 병합. 단 — **잠긴 path의 내용은 절대 조회하지 않는다**(에이전트 RPC는 권한 통과한 path만). 진열은 share row의 메타데이터(path 이름·가격)만으로 그린다. 권한 모델 불변식 유지.

**클라이언트:**
- 홈 목록 링크: 서버가 준 진입점을 사용(필요 시 `?path` 부착). path 추측 금지.
- drive-shell: 잠긴 항목을 🔒+가격 배지로 렌더, 클릭 시 결제 흐름 진입(Phase 2까지는 기존 share-gate로 라우팅).

**데이터:** `shares.listed` (boolean, default 0) 추가. (price/token은 Phase 2)

**Phase 1의 진열 클릭 동작 (scope 경계 명확화):** Phase 1에서 잠긴 항목을 🔒+가격으로 *표시*하고, 클릭하면 **기존 share-gate 결제 페이지로 라우팅**한다(현재 동작하는 유료 share 흐름 그대로 — `price_usdc`/`payment_chain` 기존 컬럼 사용). 즉 Phase 1만으로도 "진열 보고 → 클릭 → 결제 → 접근"이 end-to-end로 닫힌다. Phase 2는 그 결제의 *토큰을 드라이브 정책으로 일반화*하고 share-dialog에 진열·가격·토큰 입력 UI를 추가하는 것이지, Phase 1의 결제가 Phase 2에 의존하지 않는다.

### Phase 2 — 판매 설정 정책 + 결제 토큰 (③ + ① 결제 흐름 완성)

- `drives.allowed_tokens` 추가 + 드라이브 설정 UI.
- `shares.price` / `shares.token` 추가, share 생성 시 허용목록 검증. `payment_chain` 하드코딩 제거.
- Share 다이얼로그: 가격 + 토큰(허용목록 내) + `☑ 진열` 입력.
- 구매 흐름: 진열 클릭 → x402 결제(base/FANCO) → settle → 멤버십. (D4)

### Phase 3 — 권한관리 UI/UX 개선 (④)

로직은 e2e GREEN으로 검증됨. Phase 1·2로 멤버 트리·진열·결제 UI가 새로 생기므로, 그와 함께 share-dialog 멤버리스트/역할선택 등 표면 다듬기. 범위는 Phase 1·2 완료 후 구체화.

## 권한 모델 불변식 (절대 깨지 않음)

- 접근 판정은 `drive_members`(+`drives.owner_id`)만으로 한다. `listed`/`price`/`token`은 판정에 관여하지 않는다.
- 잠긴(권한 없는) path의 **내용물은 조회하지 않는다**. 진열은 share row 메타만으로 그린다.
- 유료 share는 settle **전에는** 멤버십을 만들지 않는다(기존 불변식, e2e #161~ 로 검증됨).
- `mergeRoleUpgradeOnly`: 재초대/재결제가 기존 역할을 강등하지 않는다.

## 테스트 전략

기존 e2e 시나리오 하니스(`web/scenarios/`, 151 케이스)에 추가:

- **진입점**: path-한정 viewer가 홈→드라이브 클릭 시 접근가능 path로 안착(현재 버그의 RED→GREEN). root 거부 대신 진입.
- **진열 가시성**: 비구매자가 `listed` 유료 share를 🔒+가격으로 본다. 단 잠긴 path의 **내용(fs/list)은 못 본다**(403/빈 응답) — 메타만.
- **사적 폴더 비노출**: `listed` 아닌 권한 없는 path는 목록에 안 나온다.
- **불변식 회귀**: 진열이 보여도 결제 전엔 `drive_members` 행 없음. 결제 후에만 접근.

브라우저 렌더 의존 부분(🔒 배지 표시)은 HTTP-레벨 e2e로 안 잡히므로(이전 Monaco 버그 교훈), 해당 항목은 실브라우저 확인을 plan에 포함.

## 영향 파일 (Phase 1 기준 초안)

- `web/drizzle/schema.ts` / `schema.js` — `shares.listed`
- `web/lib/db.js` — idempotent ALTER (`shares ADD COLUMN listed`)
- `web/lib/access.ts` — `listEntryView` 신규
- `web/app/d/[driveId]/page.tsx` — 진입점 안착 로직
- `web/app/page.tsx` + `web/components/drive-shell*.tsx` — 진입점 링크, 잠금 항목 렌더
- 디렉토리 목록 API/경로 — 진열 메타 병합
- `web/scenarios/cases.mjs` (+ 인접) — 위 테스트

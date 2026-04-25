# Paywall Design — Open Questions Queue

설계 단계에서 의도적으로 보류한 질문들을 큐로 모아둠. 현재 깊이 있게 다루는 항목은 별도로 추적, 나머지는 여기에 적재.

## Locked-in Decisions (확정)

- **결제 프로토콜**: 진짜 x402 스펙 (`x402-next` 미들웨어)
- **체인/자산**: Base + USDC
- **결제 모델**: 한 번 결제 = 영구 접근 (`folder_access` 영구 행)
- **결제 단위**: path 단위 (파일/폴더 자유)
- **기존 코드 재사용**: `/s/{token}` 흐름, `folder_access`, 지갑 연결 그대로
- **Q1 접근 경로**: "aggregate share catalog" 패턴 — 드라이브당 카탈로그 토큰 1개(`path="", price=NULL`) + path별 paid share 토큰들. 스키마 변경 없음, 용법 규약.
- **Phase 분리**: **Phase 1 = x402만**, **Phase 2 = Nansen 플러그인 (대시보드/프로파일)**. Phase 1 완료가 프로젝트 성공의 최소 조건.
- **플러그인 결합 지점**: 결제 후처리 훅 `onPaymentSettled(ctx)` 함수 — Phase 1은 빈 구현, Phase 2에서 본체 구현.
- **Nansen 인증 (Phase 2)**: Pro API key + 해커톤 크레딧
- **Q3 사실상 확정**: 지갑 기반 식별 (결제자에게 aindrive 계정 불필요, 지갑만 있으면 OK). 코드에 이미 박혀있음.
- **UX 진입점 (Phase 1)**:
  - Primary: 파일 행의 `[⋮]` 오버플로우 메뉴 (기존 `[Pencil][Trash]` 교체) — "Monetize…/Edit price/Stop selling" 메뉴 항목
  - Secondary: 헤더 "Share" 버튼 — 현재 경로 기준 (드라이브 루트 = 카탈로그 토큰 발급)
  - Tertiary: 업로드 완료 토스트 — 단일 파일 시 "가격 매기기" CTA
  - 시각 표시: 파일 행 이름 옆에 `💰 $price` 배지 (가격 설정된 파일)
- **UI 라이브러리 선택**:
  - 팝오버 메뉴: 직접 구현 (useState + absolute positioning)
  - 토스트: `sonner`
- **UI 카피 (구현 중 변경)**: "Monetize" → **"Sell"** 로 통일 — 한국어 사용자에게 더 직관적. 사용자 노출 라벨 + 내부 식별자(`sell` action, `focus: "sell"`, `sellOn` state, `saveSell` 함수) 모두 일괄 교체. docs/는 의도적으로 역사 기록 유지.
- **Monetize 섹션 스코프 (Phase 1)**: 최소 스펙에 충실 — **"가격 설정만"**. DELETE/Update/Stop selling 전부 제외.
  - 2상태 UI: OFF / 편집중 / 활성(읽기 전용). 저장 후 변경 불가.
  - 변경 필요 시 새 share 생성 (legacy share 공존 허용, 영구권 보존)
  - 포기: 가격 수정, 판매 중단, 삭제 API
  - 빠지는 작업: DELETE 라우트, 확인 모달, 상태 역전이 전이
- **백엔드 기술 결정 (확정)**:
  - facilitator: `x402.org/facilitator` + Base Sepolia (testnet). 환경변수로 CDP 교체 가능.
  - 지갑/결제 라이브러리: `wagmi` + `viem` + `RainbowKit` + `x402-fetch`
  - `price_usdc REAL` 유지 + 저장 시 `toFixed(2)` + facilitator 전달 시 마이크로 변환
  - `folder_access.price_paid_usdc` 추가 안 함 (Phase 2 ALTER 예정)
  - 중복 구매 버그 수정: `/api/s/[token]/route.ts`에서 `resolveRoleByWallet` 재사용 (4-5줄)

## Status (Phase 1 설계 완료)

- [x] ~~"1회 결제의 의미"~~ — 영구로 통일되어 소멸
- [x] ~~Q1 — 접근 경로~~ — aggregate share catalog 패턴으로 확정
- [x] ~~Q2 — 수신 지갑 모델~~ — Phase 1은 env var 단일 지갑, Phase 2+ 에서 확장
- [x] ~~Q3 — 결제자 지갑 연결 의무~~ — 지갑만 있으면 OK
- [x] ~~Q4 — 파일 삭제·환불 정책~~ — Phase 1은 "환불 없음" 문구만, 삭제 시 권한 유지+404
- [x] ~~Q5 — 잠금 표시 정밀도~~ — 파일명 + 가격 배지 + 🔒 (패턴 (a))
- [x] ~~중복 구매 오판 버그~~ — `resolveRoleByWallet` 재사용으로 수정
- [x] ~~스키마 잔여~~ — REAL 유지, `price_paid_usdc` Phase 2로
- [x] ~~facilitator 선택~~ — x402.org + Base Sepolia
- [x] ~~지갑 라이브러리~~ — wagmi+viem+RainbowKit+x402-fetch

모든 Phase 1 설계 항목 확정. 구현 플랜은 `PAYWALL_PHASE1_PLAN.md` 참조.

### 기타 기술적 미해결
- [ ] **중복 구매 오판 버그**: `/api/s/[token]/route.ts:43-48`의 정확 path 매칭 → prefix 매칭 수정 필요
- [ ] `price_usdc REAL` 타입 → INTEGER 마이크로 USDC 또는 문자열로 변경 검토
- [ ] `folder_access.price_paid_usdc` 컬럼 추가 (결제 시점 가격 스냅샷)
- [ ] `payment_chain` 값 표준화 (`base` vs `base-mainnet` vs `base-sepolia`)
- [ ] 프로덕션 DB 확정 (README는 Postgres, 실제는 SQLite — self-hosted Docker 배포에서는 SQLite + 볼륨 마운트로 정착)

---

## Q1. `/d/{driveId}` vs `/s/{token}` UX 통합 (최우선)

원래 사용자 시나리오: "다른 사용자가 `/d/{driveId}`에 접속 → 잠금 아이콘 → 클릭 → 결제"

현실의 라우팅: `/d/{driveId}`는 드라이브 멤버 전용, `/s/{token}`은 토큰 기반 게이트. 두 모델을 어떻게 녹일 것인가.

**후보 ①**: `/d/{driveId}`를 공개화 + 파일별 가격 메타
**후보 ②**: `/s/{token}`을 "카탈로그 + per-file 결제" 페이지로 재구성 (aggregate share 패턴)
**후보 ③**: 하이브리드 — `/d`는 멤버용, `/s`는 외부용, UI는 통일

해커톤 스코프에서 후보 ②(aggregate share)가 가장 적합해 보임: `path=""`, `role=viewer`, `price=NULL`인 "카탈로그 share"를 만들고, 유료 파일은 그 아래에 path별 paid share로 따로 존재. 카탈로그 페이지에서 🔒 배지 렌더.

## Q2. 수신 지갑은 누구의 것인가

결제 USDC가 어디로 가야 하는가:

- **(a) 파일 소유자 지갑으로 직접** — P2P, 가장 단순. 소유자가 미리 payout wallet 등록 필요.
- **(b) 플랫폼 지갑** → 정산 — 수수료 차감, 환불 가능, escrow/회계 부담.
- **(c) 하이브리드** — 기본은 (a), 플랫폼 수수료 별도.

현재 `app/api/s/[token]/pay/route.ts`는 `process.env.AINDRIVE_PAYOUT_WALLET` 단일 환경변수 — 모든 드라이브가 한 곳으로 송금되는 (b) 임시 구현.

해커톤 시연용으로는 (b) 유지가 단순. v1 실배포 가려면 `users.payout_wallet` 컬럼 + 소유자 지갑으로 확장.

## Q4. 파일 삭제·가격 변경·환불 정책

영구 결제 모델 확정으로 **우선순위 상승**:

- **소유자가 파일을 삭제하면**: 권한은 유지(`folder_access` 유지)하되 404 반환이 단순. 소유자 UI에서 "N명이 결제한 파일입니다" 경고 표시.
- **소유자가 가격을 변경하면**: 기존 구매자는 영향 없음.
- **환불**: "모든 결제는 최종, 환불 없음"으로 시작. 결제 전 UI에 문구 명시.

## Q5. 잠금 표시 정밀도

비-소유자가 디렉터리 리스팅할 때:

- **(a) 파일명/크기/유형 보임, 내용만 잠김** — 가격 + 🔒 배지 표시. 가장 상점 같음.
- **(b) 파일명만 가림** — 썸네일/내용 없음.
- **(c) 존재만 표시** — "잠긴 파일 N개".

기본 (a) 권장. 가격을 리스팅에 함께 노출.

---

## Phase 2 — Nansen 플러그인 (Phase 1 완료 후)

Phase 1에서 만들어둔 `onPaymentSettled` 훅에 본체를 채우고 대시보드를 신설하는 트랙.

초점: "판매 수익 트래킹 대시보드" (그래프/차트 중심). SM 게이팅은 Phase 2 내에서도 후순위.

### Phase 2 설계 항목
- [ ] `wallet_profiles` 테이블 신설 (labels, pnl_summary, top_holdings, smart_money_tags, updated_at)
- [ ] Nansen API key 환경변수 `AINDRIVE_NANSEN_API_KEY`
- [ ] `onPaymentSettled` 훅에서 호출할 엔드포인트 확정
  - `/labels/*` (지갑 라벨 — Pro 전용, Phase 2에서 사용 가능)
  - `/profiler/address/pnl-summary`
  - `/profiler/address/current-balance`
  - (선택) `/profiler/address/related-wallets`
- [ ] 판매 수익 트래킹 대시보드 페이지 `/dashboard` 신설
  - 총 수익 (USDC)
  - 시간대별 수익 그래프 (일/주/월)
  - 파일별 판매 집계 + 구매자 리스트
  - 구매자 지갑 라벨/PnL 배지
- [ ] Nansen 호출 실패 시 degradation (결제는 성공 / 프로파일은 비어있음)
- [ ] 캐시 TTL 전략 (같은 지갑 반복 조회 방지)

### Phase 2 후순위 (시간 남으면)
- [ ] Tier 2: SM 게이팅 — `shares.gating_policy` JSON 컬럼 + 게이트 로직
- [ ] Tier 3: Holder 게이팅 — 토큰 홀딩 검증

# Permit2 settlement via x402 v2 (Phase 2b) — design

EIP-3009 미지원 ERC-20(예: FANCO)을 실제 온체인 정산 가능하게 만든다. 수단은
x402 v2의 permit2 asset-transfer method. 이 작업으로 "Settle later" 상태가
사라지고, CA가 확인된 모든 ERC-20이 정산 가능해진다.

## 외부 사실 (2026-06-11 검증)

- x402 v2 (2025-12-11 출시)의 exact-evm 스킴은 토큰 능력에 따라 두 전송
  방식을 쓴다: `extra.assetTransferMethod = "eip3009" | "permit2"`.
  permit2는 임의 ERC-20의 보편 폴백.
- Permit2 서명 도메인은 토큰이 아니라 Permit2 컨트랙트
  (`{name:"Permit2", chainId, verifyingContract:0x000000000022D4…BA3}`,
  version 없음). spender는 canonical `x402ExactPermit2Proxy`
  (`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`) — witness.to 외 송금 불가를
  컨트랙트가 강제. **Base mainnet/Sepolia 양쪽 배포 확인** (eth_getCode).
- facilitator 지원 (직접 확인): `https://x402.org/facilitator` →
  v2 exact `eip155:84532` + 가스 스폰서링 확장 2종, 무인증, 테스트넷 전용.
  CDP(`api.cdp.coinbase.com/platform/v2/x402`) → v2 + permit2, Base
  mainnet/Sepolia, CDP API 키 필수, 월 1,000건 무료.
- **v2 SDK 리소스 서버는 `PAYMENT-SIGNATURE` 헤더만 읽음** — v1 클라이언트
  (`x402-fetch@1.2.0`)와 한 엔드포인트 공존 불가. 우리 클라이언트/서버는 같은
  앱이므로 동시 마이그레이션.
- SDK 클라이언트는 Permit2 `approve()`를 자동 전송하지 않는다. allowance
  부족 시 facilitator verify가 `permit2_allowance_required`를 반환하고,
  스펙은 이를 412로 표면화하라고 명시. 승인 UX는 앱 책임.
- 패키지: `@x402/core` `@x402/evm` `@x402/fetch` (~2.14.0),
  `@coinbase/x402@^2.1.0` (CDP 인증 헤더). 기존 `x402-fetch`는 1.2.0 동결.

## 접근법 비교

1. **`@x402/next` `withX402` 전면 채택** — 기각. 우리 라우트의 정산은 도메인
   로직(owner bypass, 기득권 검사, 정책 해석, upgrade-only grant, 영수증,
   Willow cap, DEV_BYPASS)과 교차하는데, 래퍼는 "핸들러 성공 후 정산"
   라이프사이클을 강제해 구조 전복 대비 프로토콜상 이득이 없다.
2. **v2 코어 프리미티브 + 기존 라우트 구조 유지 (채택)** — 암호학/와이어
   포맷(서명, 페이로드 스키마, facilitator 호출, 헤더 코덱)은 전부 SDK가,
   도메인 로직은 전부 우리가 소유. diff 최소, 정석 경계.
3. v1 위에 permit2 수작업 — 불가. v1 facilitator는 permit2를 정산하지 않음.

## 설계

### 토큰 정책 (`web/lib/payment-tokens.ts`)

- `PaymentToken`에 `transferMethod?: "eip3009" | "permit2"` 추가.
  - 저장된 레거시 정책(필드 없음)의 추론: `name && version → eip3009`,
    아니면 `permit2`. 구 의미론("name+version = settleable")과 정확히 일치.
  - USDC 프리셋 `eip3009`, FANCO 프리셋 `permit2` (asset은 여전히 owner 입력).
- `isX402Settleable` 의미 변경: eip3009 → `name && version && asset`,
  permit2 → `asset`만. (permit2 서명은 토큰 도메인이 필요 없으므로.)
- CAIP-2 매핑 추가: `toCaip2Network("base") = "eip155:8453"`,
  `"base-sepolia" = "eip155:84532"`. 내부 표기(chain, 영수증 network 컬럼)는
  기존 문자열 유지 — 프로토콜 경계에서만 변환.

### 서버 (`web/app/api/s/[token]/route.ts`)

- v1 import(`x402/verify` 등) → `@x402/core/server`의
  `HTTPFacilitatorClient`, `@x402/core/http`의 헤더 코덱, `@x402/core/types`.
- 402 응답: v2 `PaymentRequired`(`resource` 톱레벨, `accepts[].amount`,
  CAIP-2 network, `extra.assetTransferMethod`)를 `PAYMENT-REQUIRED` 헤더로
  인코딩. **기존 정보용 JSON 바디는 유지** (share-gate가 가격/통화 표시에
  사용 — v2에서 바디는 서버 재량). 바디의 `x402Version`은 2로.
  - eip3009 토큰: `extra.name/version` 필수(토큰 EIP-712 도메인).
  - permit2 토큰: `extra`는 `assetTransferMethod`만. name/version 생략은
    "EIP-2612 가스 스폰서링 안 씀" 신호 — 승인은 payer가 직접(Option A).
    가스 스폰서링 확장은 후속(YAGNI).
- 결제 헤더: `PAYMENT-SIGNATURE` 읽기 + `decodePaymentSignatureHeader`.
  DEV_BYPASS는 관대한 JSON 파싱 유지, payer 추출은
  `payload.authorization?.from ?? payload.permit2Authorization?.from`.
- verify 결과 `invalidReason === "permit2_allowance_required"` → **412**
  (스펙 준수), 그 외 실패 402. 둘 다 헤더+바디에 error 포함.
- settle 성공 후 처리(grant/영수증/cap/쿠키/hook)는 불변. settle payer 추출도
  permit2Authorization 폴백 추가.
- facilitator 선택 (우선순위):
  1. `AINDRIVE_X402_FACILITATOR` (명시 URL — self-hosted/기타)
  2. `CDP_API_KEY_ID`+`CDP_API_KEY_SECRET` → `@coinbase/x402`
     `createFacilitatorConfig` (URL+JWT 인증 내장)
  3. testnet → `https://x402.org/facilitator` 기본값
  4. mainnet에서 1·2 모두 없음 → 기존 의도적 503 불변.

### 클라이언트 (`web/components/share-gate.tsx`)

- `x402-fetch` v1 → `@x402/fetch` v2: `x402Client` +
  `ExactEvmScheme`(`@x402/evm/exact/client`)를 `eip155:*`에 등록.
  wagmi `WalletClient` → `{address, signTypedData}` 어댑터 (SDK paywall의
  비공개 browserAdapter 미러링, 주석으로 출처 표기).
- 금액 가드: v1 `maxValue` 인자 대체 — `registerPolicy`로 표시된 금액 초과
  requirement를 필터 (서버가 표시가보다 큰 금액을 요구하면 결제 불가).
- **Permit2 승인 UX (2단계)**: requirement가 permit2이면
  - pay 전에 wagmi publicClient로 `getPermit2AllowanceReadParams` 조회.
    allowance < amount → "Approve {symbol} (one-time)" 단계 노출 →
    `createPermit2ApprovalTx(asset)` 전송 → 영수증 대기 → Pay 진행.
  - 412 응답(레이스 폴백) → 승인 단계로 전환. (412 시 SDK 래퍼는 응답을
    그대로 반환하므로 앱이 status를 검사.)
- 바디 필드 rename 반영: `maxAmountRequired` → `amount`.

### 정책 편집 UI (`share-dialog-sections.tsx`, `/api/token-lookup`)

- lookup 응답에서 `settleable` 제거(이제 ERC-20이면 항상 정산 가능),
  `eip3009`/`needsVersion` 유지. 저장 시 method 결정:
  `eip3009 && name && 유효 version → "eip3009"`, 아니면 `"permit2"`.
- SettleBadge: "Settle later" 사망. eip3009 → "Settles now",
  permit2 → "Settles now · one-time approval". FANCO 안내문구의
  "Phase 2b 필요" 문장 교체.
- 부수 수정: 기존엔 EIP-3009 프로브가 실패해도 name+version이 온체인에
  있으면 `isX402Settleable`이 참 — 잘못된 "Settles now" 가능성.
  `transferMethod` 명시 저장으로 닫힘.

### 불변 영역

- `/api/x402/lift` (AIN 직접전송 스킴, facilitator 무관) — v1 커스텀 유지.
- 영수증 스키마·`onPaymentSettled`·grant 로직.
- `paymentNetwork()` 스위치와 USDC rebind 로직 (chain 문자열 의미 불변).

## 테스트

- 단위(vitest): transferMethod 추론(레거시 JSON 파싱), isX402Settleable
  신구 의미, toCaip2Network, 402 응답의 PAYMENT-REQUIRED 헤더 디코딩
  (eip3009/permit2 extra 분기), 412 분기(verify mock), settle 성공 경로
  v2 페이로드(eip3009+permit2 payer 추출), 금액 가드 정책.
- 기존 paid-settle/payment-network/payment-tokens 테스트 v2 형태로 갱신,
  전체 스위트 green 유지.
- 실체인 스모크(Base Sepolia, 비-3009 토큰 + x402.org facilitator)는 자금
  있는 키 필요 — 후속 항목으로 기록.

## 후속 (이번 범위 밖)

- EIP-2612 가스 스폰서링 확장 (payer 가스리스 승인).
- `@x402/paywall` 대체 검토 — 우리 게이트 UI가 더 풍부해 불필요 판단.
- 외부 v1 에이전트 호환 — 공유 링크가 서드파티 x402 v1 봇에 소비될 가능성은
  현재 0에 수렴(결제 UI는 우리 게이트뿐). 생태계가 v2로 이동 완료.

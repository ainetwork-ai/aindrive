# Paywall Phase 1 — Implementation Plan (x402 only)

Phase 1 스코프: **x402 실제 스펙으로 파일 판매/구매 플로우 완성**. Nansen/대시보드는 Phase 2.

설계 확정 내역은 `PAYWALL_DESIGN_QUEUE.md` 참조. 이 문서는 실행용.

---

## 데모 시나리오 (E2E 수용 기준)

```
1. 소유자 브라우저: `aindrive` 실행 → /d/{driveId} 열림
2. 파일 행 [⋮] 클릭 → "Monetize…"
3. ShareDialog 열림 → Monetize 토글 ON → Price 0.5 USDC 입력 → Save
4. 가격 배지 💰 $0.50 렌더링 + share URL 자동 복사 토스트
5. 구매자 브라우저(다른 세션): URL 붙여 넣어 /s/{token} 접근
6. Paywall 화면: RainbowKit "Connect Wallet" → MetaMask 연결
7. "Pay 0.5 USDC" 클릭 → 지갑이 EIP-3009 서명 팝업
8. 서명 완료 → 서버가 facilitator로 검증·정착 → 파일 열람 화면
9. 같은 브라우저 탭 닫고 재방문: 결제 없이 바로 파일 열람 (지갑 쿠키)
```

---

## 파일별 변경 목록

### 🆕 신규 파일

| 파일 | 역할 | 규모 |
|---|---|---|
| `web/lib/payment-hooks.ts` | `onPaymentSettled(ctx)` 빈 구현 — Phase 2 결합 지점 | ~10줄 |
| `web/lib/wagmi-config.ts` | wagmi + RainbowKit 설정 (Base Sepolia, WalletConnect projectId) | ~20줄 |
| `web/components/wallet-provider.tsx` | wagmi Provider + RainbowKit Provider 래퍼 (client component) | ~25줄 |
| `web/components/row-menu.tsx` | 파일 행 `[⋮]` 팝오버 메뉴 (Monetize / Share / Rename / Delete) | ~60줄 |

### ✏️ 수정 파일

| 파일 | 변경 요약 |
|---|---|
| `web/package.json` | `wagmi`, `@rainbow-me/rainbowkit`, `x402-fetch`, `sonner` 추가 |
| `web/app/layout.tsx` | `<WalletProvider>` 래핑, `<Toaster />` (sonner) 마운트 |
| `web/components/drive-shell.tsx` | 행 액션을 `[⋮]`로 교체, 가격 배지 렌더, shares 로드, 업로드 토스트 |
| `web/components/share-dialog.tsx` | Monetize 섹션 신설 (토글+price+save+active 뷰), `focusSection` prop, Copy/Done 바 |
| `web/components/share-gate.tsx` | 전체 재구성 — RainbowKit Connect + x402-fetch 결제 흐름 |
| `web/app/api/s/[token]/route.ts` | 진짜 x402 스펙 402 응답 (X-PAYMENT-REQUIREMENTS 헤더), 중복 구매 버그 수정 |
| ~~`web/app/api/s/[token]/pay/route.ts`~~ | **삭제됨** (구현 중 결정 변경). x402 표준은 같은 URL에서 verify+settle 처리. 모든 결제 로직은 `[token]/route.ts` GET 핸들러로 통합. `onPaymentSettled` 훅 호출도 그쪽에서. |
| `web/.env.example` | `AINDRIVE_PAYOUT_WALLET`, `AINDRIVE_X402_FACILITATOR`, `NEXT_PUBLIC_WC_PROJECT_ID` 추가 |

### 🚫 건드리지 않는 파일 (Phase 1)

- `cli/**/*` — CLI는 Phase 1에서 수정 없음
- `shared/**/*`
- `web/lib/db.js` — 스키마 그대로 (ALTER 없음)
- `web/lib/access.ts` — `resolveRoleByWallet` 그대로 재사용
- `web/app/api/drives/**/*` — 이미 wallet 권한 인정 중
- `web/components/viewer.tsx`

---

## 작업 블록별 일정 (Phase 1 = 약 22h 추정)

### 블록 A — 기반 세팅 (3-4h)

- [ ] 의존성 설치: `npm i wagmi @rainbow-me/rainbowkit x402-fetch sonner`
- [ ] `wagmi-config.ts` 작성 (Base Sepolia 체인, WalletConnect projectId)
- [ ] `wallet-provider.tsx` 작성 (Wagmi + RainbowKit + QueryClient)
- [ ] `layout.tsx`에 provider 래핑 + `<Toaster position="bottom-right" />` 마운트
- [ ] `payment-hooks.ts` 스켈레톤 (`onPaymentSettled` 빈 함수)
- [ ] `.env.local` 세팅: payout wallet, facilitator URL, WC project ID
- [ ] Base Sepolia 테스트 USDC faucet 2개 지갑 확보

### 블록 B — 백엔드 x402 스펙 준수 (4-5h)

- [ ] `/api/s/[token]/route.ts`:
  - [ ] 중복 구매 버그 수정 (정확 매칭 → `resolveRoleByWallet`)
  - [ ] 402 응답 포맷을 x402 표준 헤더로 (`X-PAYMENT-REQUIREMENTS` JSON)
  - [ ] `X-PAYMENT` 헤더 있으면 `/pay`로 위임 or 인라인 검증
- [ ] `/api/s/[token]/pay/route.ts`:
  - [ ] `X-PAYMENT` 헤더 파싱 + facilitator `/verify` + `/settle` 호출
  - [ ] 기존 txHash 경로 삭제 (또는 DEV_BYPASS 전용으로 남김)
  - [ ] folder_access INSERT + setWalletCookie 유지
  - [ ] `await onPaymentSettled({driveId, path, wallet, txHash, amountUsdc})` 호출
- [ ] DEV_BYPASS 플래그 흐름 보존 (시연 안전판)
- [ ] 간단한 curl/httpie 스크립트로 백엔드 단독 검증

### 블록 C — 판매자 UI (5-6h)

- [ ] `share-dialog.tsx` Monetize 섹션:
  - [ ] 토글 컴포넌트 (Tailwind)
  - [ ] OFF / 편집중 / 활성 3상태 UI
  - [ ] `focusSection="monetize"` prop → 열릴 때 자동 스크롤/펼침
  - [ ] Save → POST `/shares` with `price_usdc` → 활성 상태 전환 + URL 자동 복사 + sonner 토스트
  - [ ] Copy link / Done 하단 바
- [ ] `row-menu.tsx` 팝오버:
  - [ ] absolute positioning + outside-click close
  - [ ] 메뉴 항목: Monetize / Share / Rename / Delete
  - [ ] 동적 라벨 (이미 paid share 있으면 "Already selling" disabled)
- [ ] `drive-shell.tsx`:
  - [ ] shares 데이터 fetch (`GET /api/drives/{driveId}/shares`) → `Map<path, share>`
  - [ ] 행 액션 `[Pencil][Trash]` → `[⋮]` + RowMenu
  - [ ] 가격 배지: 이름 옆 `<span>💰 ${price}</span>` (paid share 존재 시)
  - [ ] `onUpload` 완료 후: 단일 파일이면 `toast.success(..., { action: "가격 매기기" })`

### 블록 D — 구매자 UI (4-5h)

- [ ] `share-gate.tsx` 재구성:
  - [ ] 미연결 상태: `<ConnectButton />` 노출
  - [ ] 연결 상태: x402-fetch로 `/api/s/{token}` 호출
  - [ ] 402 감지 시: "Pay X USDC" 버튼 + 설명
  - [ ] 버튼 클릭 → x402-fetch가 EIP-3009 서명 유도 + 재시도 자동 처리
  - [ ] 200 반환 시: 파일 뷰 or 드라이브 리다이렉트
  - [ ] 이미 결제된 지갑(쿠키)은 자동 통과
- [ ] 결제 성공 후 UX:
  - [ ] "결제 완료, Basescan: {txUrl}" 링크 표시
  - [ ] 드라이브 리스팅으로 전환 (해당 path 접근 가능)
- [ ] 에러 핸들링: 지갑 거부, 잔액 부족, facilitator 타임아웃

### 블록 E — E2E 테스트 & 리허설 (2-3h)

- [ ] 데모 시나리오 1~9 실행
- [ ] 엣지 케이스:
  - [ ] 이미 결제한 지갑이 다른 탭에서 URL 열기 → 바로 접근
  - [ ] 드라이브 루트에 결제한 지갑이 하위 paid share URL 방문 → 재결제 X
  - [ ] 잔액 없는 지갑으로 결제 시도 → 에러 표시
- [ ] DEV_BYPASS 모드 켜서 네트워크 없이도 돌아가는지 확인
- [ ] 시연 스크립트 작성 (무대 위 말 순서)

---

## 환경 설정 체크리스트 (구현 직전)

```
[지갑]
  □ 판매자 지갑 (Base Sepolia, 약간의 ETH for gas)
  □ 구매자 지갑 (Base Sepolia, 테스트 USDC 10+)
  □ AINDRIVE_PAYOUT_WALLET = 판매자 지갑 주소

[외부 서비스]
  □ WalletConnect Cloud projectId 발급 (무료)
  □ x402.org facilitator URL 확인 (기본값)
  □ Base Sepolia USDC 컨트랙트 주소 확인

[.env.local]
  □ AINDRIVE_SESSION_SECRET  (기존)
  □ AINDRIVE_PAYOUT_WALLET   (신규)
  □ AINDRIVE_X402_FACILITATOR (기본값 있음, 선택)
  □ NEXT_PUBLIC_WC_PROJECT_ID (신규, 프론트 노출 필요)
  □ AINDRIVE_DEV_BYPASS_X402=0 (시연은 OFF, 개발은 ON)
```

---

## Phase 2 진입점 (참고)

Phase 1 완료 후 Nansen 플러그인을 붙일 때 건드릴 곳:

1. `web/lib/payment-hooks.ts` — `onPaymentSettled` 본체 채우기
2. `web/lib/nansen-client.ts` — 신규 (Nansen API 래퍼, API key 기반)
3. DB ALTER — `wallet_profiles` 테이블 신설, `folder_access.price_paid_usdc` 추가
4. `web/app/dashboard/page.tsx` — 신규 판매 수익 대시보드
5. `.env.local` — `AINDRIVE_NANSEN_API_KEY`

Phase 1 코드 베이스는 건드리지 않음 — 훅만 구현 채우기.

---

## 리스크와 완화

| 리스크 | 완화책 |
|---|---|
| x402-next/x402-fetch API가 예상과 다름 | 블록 A에서 간단 hello-world로 먼저 검증. 필요하면 직접 구현으로 전환 |
| Base Sepolia facilitator 불안정 | DEV_BYPASS 모드를 시연 안전판으로 유지. 무대 위에서 토글 가능 |
| RainbowKit bundle size | Phase 1 스코프 외. 시간 남으면 optimization |
| 업로드 토스트가 fs 자동 감지와 겹침 | Phase 1은 웹 업로드 경로에서만 토스트. fs-changed는 Phase 2 이상 |
| 시연 당일 지갑 꼬임 | 판매자/구매자 지갑 주소 + seed 메모. 백업 지갑 1개 추가 준비 |

# Showcase + Payment-Token Policy (Phase 2a) Implementation Plan — rev2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> rev2: ultracode 4-lens 검증 confirmed 15건(고유 8) 반영 — 마이그레이션 boot-crash(A), 18-decimals BigInt 수학(B), share-gate 표시(C), listed owner 게이트(D), 만료 필터(E), Task1 게이트 정합(F), fallback 의미론(G), #171 판별력(H).
>
> 사전 조사(코드 맵 + x402/mint.club 웹 조사) 결론 반영: mint.club 토큰은 plain ERC-20(EIP-3009 ✗)이라 **현 x402 v1 스택으로는 실 온체인 FANCO 결제 불가**. 최신 x402 스펙의 Permit2 경로(CDP facilitator)로는 가능하나 v2 마이그레이션+1회 approve UX가 필요 → **Phase 2b로 분리**(비목표 참조). 이 plan(2a)은 정책 배관·진열·UI 전부를 **DEV_BYPASS로 e2e 검증 가능한 범위**로 완성한다.

**Goal:** 드라이브 소유자가 결제 통화 정책(`allowed_tokens`)을 정하고, share를 가격+통화로 **진열(`listed`)**하면, 권한 없는 부분-멤버가 진입 뷰에서 **leaf 이름+가격의 잠금 항목**으로 발견·클릭·(DEV_BYPASS) 결제·접근하는 흐름을 완성한다. (todo①③ = spec D1·D3·D4)

**Architecture:**
- 데이터: `drives.allowed_tokens TEXT`(JSON 배열 `{symbol, chain, asset, name, version, decimals}`), `shares.listed INTEGER DEFAULT 0`, `shares.payment_chain`→**RENAME**→`shares.currency`(symbol 저장; idempotent rename — db.js try/catch 패턴). 권한층(`drive_members`) 불변.
- 진열 읽기: 전용 `GET /api/drives/[driveId]/showcase` — 로그인 + (해당 드라이브의 멤버 또는 owner)만. 반환은 **leaf-name DTO만**: `{shareId, token, leafName, role, price, currency}` — 전체 path 금지(보안 C1). caller가 이미 cover하는 path의 share는 제외(이미 가진 건 진열 불필요).
- 진열 표시: DriveShell 진입 뷰(합성 root + 일반 root/grant 뷰)에 "For sale" 섹션 — 🔒 leafName + 가격 배지, 클릭 → `/s/<share.token>`(기존 share-gate). showcase는 fs와 무관(내용 조회 0).
- settle 정책화: `requirements{network, asset, extra{name,version}, maxAmountRequired}`를 `share.currency` → `drives.allowed_tokens` lookup으로 구성. `currency` 없는 레거시 share는 기존 USDC base-sepolia 상수 fallback(후방호환). receipt `network`·hook 동반.
- share 생성: `price` + `currency`(allowed_tokens 내 검증) + `listed` 입력. share-dialog sell 섹션에 통화 select + ☑ 진열. allowed_tokens 편집은 sell 섹션 내 owner 전용 소UI(JSON 직접 편집 금지 — symbol 프리셋: USDC(테스트넷 기본), FANCO(base) 프리셋 상수 제공).
- 기본 정책: `allowed_tokens`가 NULL/빈 배열이면 `[USDC base-sepolia 프리셋]`으로 간주(기존 동작 보존).

**불변식 (절대):** 권한 판정은 `drive_members`만 — `listed`/`price`/`currency` 무관. 진열 DTO에 전체 path·내용 없음(leafName만). settle 전 멤버십 없음(기존 e2e #161~). WS dochub 변경 없음(잠긴 path는 4401 그대로).

**Tech Stack:** 기존 스택 그대로. x402 라이브러리 변경 없음(2b로 분리).

---

## Token preset 상수 (단일 정의)

`web/lib/payment-tokens.ts` (신규):
```ts
// Payment-token presets a drive owner can allow. decimals/EIP-712 fields feed
// x402 requirements; FANCO's eip712 fields are null — its on-chain settle needs
// the Permit2 path (x402 v2), tracked as Phase 2b. Under DEV_BYPASS the policy
// plumbing (402 body, receipts, UI) is fully exercisable regardless.
export type PaymentToken = {
  symbol: string; chain: string; asset: string;
  name: string | null; version: string | null; decimals: number;
};
export const TOKEN_PRESETS: Record<string, PaymentToken> = {
  USDC: { symbol: "USDC", chain: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", decimals: 6 },
  FANCO: { symbol: "FANCO", chain: "base", asset: "", name: null, version: null, decimals: 18 },
};
export const DEFAULT_TOKENS: PaymentToken[] = [TOKEN_PRESETS.USDC];

// [rev2-B] 금액 스케일링은 절대 float 곱셈 금지: 18 decimals에서 price 0.01만 돼도
// Number.MAX_SAFE_INTEGER 초과(정밀도 손실), 1000 이상이면 "1e+21" 지수표기가 되어
// x402의 digit-string 검증/BigInt() 소비자가 throw. BigInt 십진 문자열 스케일링으로.
export function toAtomicAmount(price: number, decimals: number): string {
  // price는 소수 2자리까지만 허용(shares 입력 검증과 동일) — 그 이상은 반올림.
  const cents = Math.round(price * 100); // safe: price < 1e13
  return (BigInt(cents) * 10n ** BigInt(decimals - 2)).toString();
}
```
(`decimals >= 2` 전제 — 프리셋이 6/18뿐. 단위 테스트에 1.1/1000/0.01@18 → 정확한 digit string, "e+" 부재 단언 포함.)
> FANCO `asset`은 빈 문자열로 시작 — mint.club 페이지가 CSR이라 컨트랙트 주소를 조사에서 못 박았다. **온체인 결제는 2b**이므로 지금은 자리만; owner가 설정 UI에서 주소를 입력할 수 있게 한다(아래 Task 5). DEV_BYPASS 검증엔 영향 없음.

---

## Task 1: 스키마 + 부팅 마이그레이션

**Files:** `web/drizzle/schema.ts`, `web/drizzle/schema.js`, `web/lib/db.js`, (신규) `web/lib/payment-tokens.ts`

- [ ] schema.ts/.js: `drives.allowed_tokens: text("allowed_tokens")`, `shares.listed: integer("listed").notNull().default(0)`, `shares.payment_chain` → `currency`로 컬럼명 변경(두 스키마 파일 모두).
- [ ] **[rev2-A] db.js 마이그레이션 — 순서·충돌 주의**:
  1. 기존 idempotent ADD 루프에서 **`"ALTER TABLE shares ADD COLUMN payment_chain TEXT"` 라인(:108)을 삭제**한다 — 안 지우면 새 DB에서 CREATE가 만든 `currency` 옆에 `payment_chain`이 또 생기고 rename이 "duplicate column: currency"로 throw → **모든 새 DB 첫 부팅 크래시**.
  2. rename try/catch를 ADD 루프 **앞**에: `ALTER TABLE shares RENAME COLUMN payment_chain TO currency` — catch는 `no such column`(이미 rename/새 DB)과 `duplicate column`(half-state 방어) 둘 다 무시.
  3. ADD 루프에 `ALTER TABLE shares ADD COLUMN currency TEXT` 추가(payment_chain ALTER 이전의 아주 오래된 DB 커버), `ALTER TABLE drives ADD COLUMN allowed_tokens TEXT`, `ALTER TABLE shares ADD COLUMN listed INTEGER NOT NULL DEFAULT 0`.
  4. CREATE TABLE IF NOT EXISTS의 shares 정의도 `currency`로.
- [ ] **[rev2-F] raw-SQL 컬럼명 동기 갱신을 이 Task에 포함**(안 하면 이 커밋의 트리에서 settle 라우트가 깨져 게이트 불성립): `web/app/api/s/[token]/route.ts`의 ShareRow 필드·SELECT(:28·:35) `payment_chain`→`currency`; `web/app/api/drives/[driveId]/shares/route.ts`의 SELECT(:26)·INSERT(:62-64) 동일 갱신(INSERT 값은 아직 `price_usdc ? "base-sepolia" : null` 그대로 — 의미 변경은 Task 2). ~~accept/route.ts~~(payment_chain 미참조 — 대상 아님).
- [ ] `web/lib/payment-tokens.ts` 위 내용(+`toAtomicAmount`) + `resolveDriveTokens(allowedTokensJson: string|null): PaymentToken[]`(파싱 실패/NULL → DEFAULT_TOKENS) 헬퍼.
- [ ] 단위 테스트 `web/lib/__tests__/payment-tokens.test.ts`: resolveDriveTokens(null/garbage/valid) 3 + toAtomicAmount(1.1@18, 1000@18, 0.01@18, 5@6) 4케이스 — 정확한 digit string·지수표기 부재.
- [ ] 게이트: typecheck 0, `vitest run lib/` GREEN(paid-settle 포함 — F 덕에 이 트리에서 성립). 커밋 `feat(db): allowed_tokens + listed + payment_chain→currency rename`.

## Task 2: settle 정책화 (후방호환 fallback)

**Files:** `web/app/api/s/[token]/route.ts`, `web/app/api/drives/[driveId]/shares/route.ts`, `web/components/share-gate.tsx`

- [ ] shares/route.ts: Body에 `currency: z.string().optional()`, `listed: z.boolean().optional()` 추가. INSERT를 `currency`(요청값 또는 price 있으면 드라이브 토큰[0].symbol) + `listed`(boolean→0/1)로. **검증**: `price_usdc` 제공 시 `currency`가 `resolveDriveTokens(drive.allowed_tokens)`의 symbol 중 하나여야(아니면 400). **[rev2-D] `listed === true`는 owner 전용**: `if (body.data.listed && !atLeast(resolveRole(driveId, user.id, ""), "owner")) → 403` (spec D1 "소유자가 등록" — path-editor가 드라이브 진열대에 임의 가격을 올리는 것 차단; unlisted share 생성은 기존대로 editor 가능). GET 응답에 `listed`, `currency` 포함.
- [ ] s/[token]/route.ts: `X402_NETWORK`/`USDC_BASE_SEPOLIA` 상수 제거. **[rev2-G] fallback은 레거시(NULL)에만**:
  ```ts
  const tokens = resolveDriveTokens(drive.allowed_tokens);
  const tok = share.currency == null ? TOKEN_PRESETS.USDC : findToken(tokens, share.currency);
  if (!tok) return NextResponse.json({ error: "share currency no longer allowed by drive policy" }, { status: 410 });
  ```
  (무조건 `?? USDC`는 정책에서 제거된 통화를 **다른 단위의 USDC로 재과금**하는 경로 — 금지.) `maxAmountRequired: toAtomicAmount(share.price_usdc, tok.decimals)` **[rev2-B]**, `network: tok.chain`, `asset: tok.asset`, `extra: tok.name ? { name: tok.name, version: tok.version } : undefined`, receipt `network: tok.chain`. drive SELECT에 `allowed_tokens` 추가.
- [ ] 402 바디 최상위에 `currency: { symbol: tok.symbol, decimals: tok.decimals }` 병기(x402 스키마 밖 — 클라 표시용; x402-fetch는 accepts만 읽음).
- [ ] **[rev2-C] share-gate.tsx 표시 갱신**(결제 동의 화면 — 금액 오표기는 소비자 보호 문제): 402 분기 응답 타입에 `currency?: {symbol, decimals}` 추가, 표시 금액 = `Number(maxAmountRequired) / 10**(currency?.decimals ?? 6)`, 라벨/버튼의 `USDC` → `currency?.symbol ?? "USDC"`(비-USD 심볼엔 `$` 접두 제거). 필드 부재(레거시) → USDC/6 fallback.
- [ ] 게이트: typecheck 0 + 기존 `lib/__tests__/paid-settle.test.ts` GREEN(레거시 NULL fallback 검증 겸함). 커밋 `feat(payments): drive token policy drives x402 requirements`.

## Task 3: showcase 엔드포인트 (leaf-DTO, access-gated)

**Files:** (신규) `web/app/api/drives/[driveId]/showcase/route.ts`, (신규) `web/lib/showcase.ts`(commerce 층 — D6 모듈 경계)

- [ ] `web/lib/showcase.ts`: `listShowcase(driveId, userId): ShowcaseItem[]` — `shares WHERE drive_id=? AND listed=1 AND price_usdc IS NOT NULL` 조회 후, **[rev2-E] 만료 제외**(JS-side: `!s.expires_at || new Date(s.expires_at) >= new Date()` — expires_at은 ISO 'T'/'Z' 포맷이라 `datetime('now')`와의 SQL 문자열 비교는 경계에서 불안전), **caller가 이미 cover하는 path 제외**(`resolveRoleByUser(driveId, userId, share.path) === "none"`인 것만 잔류), DTO 매핑 `{shareId: id, token, leafName: lastSegment(path) || drive-root-label, role, price: price_usdc, currency}`. **path 전체는 DTO에 절대 미포함**(보안 C1 — 조상 디렉토리명 유출 방지). root("") share의 leafName은 `"(drive)"`.
- [ ] route.ts: `getUser()` 401 게이트 + **드라이브 관계 게이트**: owner이거나 `drive_members`에 행이 1개라도 있는 사용자만(완전 무관자는 404/403 — 공개 도착경로는 비목표라 부분-멤버 업셀만). `{items: listShowcase(...)}` 반환.
- [ ] 단위 테스트(`web/lib/__tests__/showcase.test.ts`): tmp DB로 — listed=0 미노출 / cover된 share 제외 / leafName만 노출(전체 path 부재) / root share 라벨 / **만료 share 제외[rev2-E]**. 5케이스.
- [ ] 게이트 후 커밋 `feat(showcase): access-gated leaf-DTO endpoint`.

## Task 4: DriveShell "For sale" 섹션 (진열 표시 + 클릭→share-gate)

**Files:** `web/components/drive-shell.tsx`, `web/components/drive-shell-parts.tsx`

- [ ] drive-shell: `loadShowcase` — `GET /api/drives/${driveId}/showcase`(비-owner만; owner는 자기 진열 안 봐도 됨 — 단순화: role!=="owner"일 때 fetch, 404/403은 무시하고 빈 배열). state `showcase: ShowcaseItem[]`.
- [ ] drive-shell-parts: `ShowcaseSection({items})` — FileTable 아래, 항목별 행: 🔒 아이콘 + `leafName` + `X402Badge`(기존 컴포넌트 재사용, price) + currency 심볼. 클릭 → `window.location.href = "/s/" + item.token`(기존 share-gate가 결제·CONSUME 처리). 빈 items면 섹션 미렌더.
- [ ] 표시 위치: 진입 뷰 = `path === rootPath || isSyntheticRoot`일 때만(깊이 탐색 중엔 숨김 — 진입 화면의 발견 surface라는 D1 의도).
- [ ] 게이트: typecheck 0. 커밋 `feat(ui): for-sale showcase section on drive entry views`.

## Task 5: share-dialog — 진열 체크박스 + 통화 select + allowed_tokens 설정

**Files:** `web/components/share-dialog.tsx`, `web/components/share-dialog-sections.tsx`, `web/app/api/drives/[driveId]/route.ts`(또는 기존 드라이브 PATCH 라우트 — **구현 전 존재 확인**, 없으면 신규 PATCH: owner 전용, `{allowed_tokens}` 갱신)

- [ ] sell 섹션(`share-dialog-sections.tsx:111~`): 가격 입력 옆 **통화 select**(드라이브 allowed_tokens의 symbol들; GET /api/drives/[driveId] 또는 showcase용으로 내려준 정책에서 — 구현 시 기존 데이터 흐름 확인) + **☑ List in drive (진열)** 체크박스 — **[rev2-D] 체크박스는 owner에게만 렌더**(API 게이트와 일관). 생성 POST에 `currency`, `listed` 전달.
- [ ] owner 전용 "Payment tokens" 소UI(sell 섹션 하단): 프리셋 토글(USDC/FANCO 체크박스) + FANCO 선택 시 asset 주소 입력 필드(빈 값이면 저장 거부 — 2b 전까지 DEV 용도임을 헬퍼 텍스트로). PATCH로 저장.
- [ ] 기존 paid share 표시 Row(`:122`)의 `USDC` 하드코딩 → share.currency 표기.
- [ ] 게이트: typecheck 0. 커밋 `feat(ui): listed checkbox + currency select + token policy editor`.

## Task 6: e2e (spec 테스트 전략 [P2] 전부)

**Files:** `web/scenarios/cases.mjs`

- [ ] #168 진열 가시성: owner가 docs를 price+listed로 share → 부분 멤버(다른 path viewer)가 showcase GET → leafName/price 보임 + **응답 JSON에 전체 path 문자열 부재** 단언(`JSON.stringify(body).includes("docs/inner") === false` 식 — share를 `docs/inner`에 걸어 조상 노출 검사) + 그 멤버의 `docs/inner` fs/list 403 불변.
- [ ] #169 사적 비노출: listed=0 유료 share는 showcase에 안 나옴.
- [ ] #170 무관자 차단: 멤버십 0인 로그인 사용자의 showcase GET → 403/404.
- [ ] #171 정책 402: allowed_tokens=[USDC프리셋]인 드라이브의 paid share GET(결제 전, DEV_BYPASS여도 X-PAYMENT 없는 첫 GET은 402) → 402 바디 `accepts[0].network/asset`이 정책값 + 최상위 `currency.symbol` 단언. *(DEV_BYPASS는 X-PAYMENT 제출 시 facilitator만 스킵 — 402 발급 자체는 정상 동작함을 코드 조사로 확인)*
- [ ] **[rev2-H] #171b 정책 판별 402**: USDC 프리셋은 레거시 상수와 동일값이라 정책 작동을 증명 못함 → allowed_tokens=[USDC, FANCO(dummy asset `0x00…01`)]로 설정, `currency:"FANCO"` share(가격 1) 생성 → 402 바디 `accepts[0].network === "base"`, `asset === dummy`, `maxAmountRequired === "1" + "0"×18`(지수표기 부재), `currency.symbol === "FANCO"` 단언 — 하드코딩이 아닌 정책이 흐른다는 직접 증거.
- [ ] **[rev2-D] #171c listed 권한**: path-editor(docs editor)가 `listed:true` share POST → 403; `listed` 없이 → 200.
- [ ] #172 settle 불변: listed share가 보여도 settle 전 `drive_members` 행 없음(dbHandle), settle 후 생성 — 기존 #161 패턴 재사용.
- [ ] #173 WS 거부: 비구매 멤버가 listed path docId로 WS subscribe → 4401 (기존 collab 케이스의 WS 헬퍼 재사용; 없으면 #109 부근 패턴 확인).
- [ ] 풀 suite 단독 GREEN(162/1 기대 — #168~#173 + #171b/#171c는 별도 add ID #174/#175로 등록해 8케이스) + TEST_SCENARIOS.md Post-final 갱신. 커밋 `test(scenarios): #168-#175 showcase + token policy`.

## Task 7: 실브라우저 검증

- [ ] 시드: owner + allowed_tokens 설정(USDC) + `docs`(멤버 A viewer) + `premium/`에 price 5 + listed share. 멤버 A 로그인.
- [ ] 단언: ① 진입 뷰 For sale 섹션에 🔒 premium + $5 USDC 배지(전체 path 아닌 leaf만) ② 클릭 → share-gate 결제 화면(금액·통화 표기) ③ DEV_BYPASS 결제 → premium 접근(드라이브에 행 추가됨) ④ For sale 섹션에서 사라짐(이제 cover됨) ⑤ owner 뷰엔 진열 섹션 없음 ⑥ share-dialog에서 통화 select·진열 체크박스 동작. 스크린샷. 정리.

## 비목표 (이 plan 밖)

- **실 FANCO 온체인 결제 (Phase 2b)**: x402 v1→v2(@x402/*) 마이그레이션, Permit2 facilitator(CDP), payer 1회 approve UX, FANCO 컨트랙트 주소 확정. 조사 결과 문서화됨 — 착수 시 별도 plan.
- 공개 도착경로(비멤버 storefront), 구매목록 surface — spec 비목표 그대로.
- share-gate 자체의 표시 개선(통화 표기 외) — Phase 3' UIUX 대개편에서.

## Self-Review
- D1: leaf-DTO·평면 진열·전용 게이트 엔드포인트 ✓ (Task 3). 사적 폴더(listed=0) 비노출 ✓ (#169).
- D3: 2계층(드라이브 정책→share 선택) ✓ (Task 1·2·5). `shares.token` 충돌 회피(통화는 `currency`) ✓. `price_usdc` 재사용(새 price 컬럼 없음) ✓ — 심볼만 currency로 일반화, 컬럼명은 historical로 유지(spec D3).
- D4: 결제자=로그인 계정 — settle 로직 불변(요구사항 구성만 정책화) ✓.
- 불변식: 권한층 무변경, showcase는 fs 미접촉, settle-전-무멤버십 e2e ✓.
- 후방호환: currency NULL/정책 NULL → USDC 프리셋 fallback — 기존 e2e(#65~#80, #161~)가 회귀 그물 ✓.

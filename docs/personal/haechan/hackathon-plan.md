> 🔒 **PERSONAL NOTES — Haechan**
>
> 이 문서는 해커톤에 임하는 **해찬 개인의 전략·진행 메모**입니다. 팀 합의
> 사항이 아니에요. 자유롭게 읽으셔도 좋지만, 여기 적힌 트랙 분배·계약·
> 타임라인 등을 *팀 표준*으로 받아들이지 마세요. 진짜 팀 공유 자료는
> [`README.md`](../../../README.md) 와 [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) 에 있습니다.
>
> *Personal hackathon strategy notes by Haechan. Read freely, but do not
> treat the track assignments / contracts / timeline here as team-wide
> consensus. Team-shared docs live in README.md and docs/ARCHITECTURE.md.*

---

# aindrive 해커톤 실행 플랜 (2026-04-25)

> **한 줄 미션**: 어떤 폴더든 *결제하면 열리는 RAG 에이전트*로 발행하는 도구. 외부 A2A 클라이언트는 표준 `a2a-x402`로 호출하고, aindrive에서 폴더를 산 buyer는 Meadowcap cap으로 무제한 면제받는다.

> 같이 보기: [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) — 코드 디자인·레이어 분리·트랙별 ownership

---

## 0. Requirements Summary

### 무엇을 만드는가
aindrive 위에 새로운 두 기능 레이어:
1. **폴더 RAG 에이전트 발행**: owner가 자기 드라이브의 어떤 폴더든 "Create Agent" 한 번으로 RAG 에이전트로 노출. Agent Card는 `/.well-known/agent-card/<id>.json`에 게시.
2. **이중 인증/결제 트랙**:
   - 외부 A2A 클라이언트: 표준 `a2a-x402` 와이어 (per-call USDC micropayment)
   - aindrive web buyer: Meadowcap cap을 Bearer로 제시하면 결제 면제

### 왜 만드는가
- aindrive의 차별점이 *"파일 공유 드라이브"*에서 *"폴더 단위 AI 에이전트 발행소"*로 격상
- A2A + x402 표준에 정확히 부합 → walled garden 회피, 다른 AI가 발견·결제·호출 가능
- Meadowcap cap의 capability-based access를 *결제 영수증*으로 재사용 → "한 번 사면 끝" 약속 유지

### 배경 (현재 코드 상태, 검증 완료)
- `web/lib/willow/`에 Meadowcap 헬퍼 존재 (cap-issue.ts, schemes.js, meadowcap.js) — 단 share 발급 흐름엔 미연결, legacy nanoid token만 사용
- `web/app/api/s/[token]/{route,pay/route}.ts`에 x402 게이트는 있으나 결제 성공 시 `folder_access` row만 발급
- RAG·에이전트·agent-card·ERC-8004 식별자 — 전무
- `@earthstar/willow` 패키지는 설치만 됐고 import 0건. Data Model / WGPS는 미사용
- 살아있는 RPC 브리지: `/api/agent/connect` WSS → `cli/src/agent.js` HMAC RPC

### 외부 종속의 정직한 상태
- 공식 `google-agentic-commerce/a2a-x402` — Apache-2.0, Google org, **Python only, v0.1.0 단일 릴리스, 22 commits, ⭐ 496**. 스펙 + reference impl 위주, 가벼운 유지보수
- **공식 TS SDK 없음.** 우리는 Coinbase가 운영하는 `x402` npm (v2.1.0, active)으로 결제 primitive 처리 + A2A 와이어 어댑터(~50줄) 직접 작성

---

## 1. Architecture (목표 상태)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Owner (CLI 실행자, 폴더 보유)                             │
│  aindrive ~/myfolder  →  web에서 [Create Agent] 클릭                         │
│  └─ 가격 무료(M2 buyer 면제 위주) + per-call x402 0.001 USDC (외부 호출자)   │
└────────────────────────────┬─────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  web (Next.js)                                                               │
│   ├─ POST /api/drives/[driveId]/agents       (owner: agent 생성·인덱싱)      │
│   ├─ GET  /.well-known/agent-card/[id].json  (퍼블릭 agent card)             │
│   ├─ POST /api/agent/[id]/ask                (이중 인증 분기)                │
│   │     ├─ Authorization: Bearer <cap>  → Meadowcap 검증 → 면제 → RAG       │
│   │     └─ X-PAYMENT (a2a-x402)         → x402 검증 → owner 지갑 입금 → RAG │
│   └─ GET  /api/drives/[driveId]/agents       (소유 agent 목록)               │
└────────────────────────────┬─────────────────────────────────────────────────┘
                             │ sendRpc (기존 WSS)
                             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  CLI agent (cli/src/rpc.js)                                                  │
│   ├─ rag-index   { folder } → walk + chunk + embed → ~/.aindrive/rag/<id>.db │
│   └─ rag-query   { folder, q, k? } → top-k → LLM → { answer, sources }       │
└──────────────────────────────────────────────────────────────────────────────┘
                             ▲
            ┌────────────────┴───────────────────────────────────┐
            │                                                    │
┌─────────────────────────┐                       ┌─────────────────────────────┐
│ External A2A Consumer   │                       │ aindrive Buyer (cap 보유)   │
│ (LangChain, Claude MCP, │                       │ 브라우저: 사이드바 채팅창   │
│  curl, 다른 봇)         │                       │ 또는 외부 curl + cap        │
│                         │                       │                             │
│ → /.well-known fetch    │                       │ → POST /api/agent/[id]/ask  │
│ → 402 + paymentReq      │                       │   Authorization: Bearer cap │
│ → USDC sign + retry     │                       │ → 면제 → 답                 │
│ → 답                    │                       │                             │
└─────────────────────────┘                       └─────────────────────────────┘
```

---

## 2. Acceptance Criteria

### A. Cap & Pay (Track A)
- [ ] **AC-A1**: 신규 드라이브 페어링 시 `drives.namespace_pubkey`/`namespace_secret`이 NULL이 아님
- [ ] **AC-A2**: 유료 share 결제 성공 시 응답에 `cap` (base64url Meadowcap) + `expiresAt` 포함, `aindrive_cap` 쿠키 set (httpOnly, sameSite=Lax, secure)
- [ ] **AC-A3**: `verifyCapBearer(capBase64, expectedNamespace, requestedPath)` 헬퍼가 ① 서명 체인 ② 만료 ③ namespace 일치 ④ path_prefix 부분집합 4가지 검사
- [ ] **AC-A4**: `/api/drives/[driveId]/fs/read` 라우트가 cap-bearer 통과 시 sendRpc 흐름 진행, 실패 시 401 + 사유
- [ ] **AC-A5**: 만료된 cap → 401 `cap_expired`, 잘못된 path prefix → 401 `cap_path_out_of_scope`

### B. Folder RAG + A2A Agent (Track B)
- [ ] **AC-B1**: `cli/src/rag.js` (`rag-index`)가 폴더 walk → 청크(800자/100자 overlap) → 임베딩 → `~/.aindrive/rag/<driveId>__<folderHash>.sqlite` 저장
- [ ] **AC-B2**: `rag-query`가 코사인 top-k=5 검색 → LLM 호출 → `{answer, sources:[{path,lineStart,lineEnd,snippet}]}` 반환. 출처 인용 강제
- [ ] **AC-B3**: `GET /.well-known/agent-card/[id].json`이 A2A v1 스펙(securitySchemes, security, supportedInterfaces, skills) 준수 + 듀얼 스킴 선언 (`x402-payment`, `aindrive-cap`)
- [ ] **AC-B4**: `POST /api/agent/[id]/ask` 라우트가 cap-bearer / x402 / no-auth 3-way 분기, kind discriminated union
- [ ] **AC-B5**: vanilla `curl -X POST .../ask -H "X-PAYMENT: ..."` 외부 호출 가능 (우리 client 0줄)
- [ ] **AC-B6**: cap 통과 시 호출당 카운터 +1, drive당 분당 60회 / 일당 1000회 토큰 버킷

### C. UX & Demo (Track C)
- [ ] **AC-C1**: drive-shell에 우측 사이드바 토글, 폴더 컨텍스트 채팅
- [ ] **AC-C2**: owner 모드에서 폴더 우클릭 → `Create Agent` 모달 → 가격 입력 → 인덱싱 진행률 → agent card URL + 복사 버튼
- [ ] **AC-C3**: 채팅 답변에 출처 카드 (파일·라인·스니펫). 카드 클릭 시 viewer 점프
- [ ] **AC-C4**: paywall 결제 성공 직후 *"🔑 Capability granted, valid until ..."* 토스트 + Export 버튼
- [ ] **AC-C5**: `sample/` 시드: 가상 회사 OKR/회의록/제품 스펙 5~10개 마크다운
- [ ] **AC-C6**: 30초 시연 영상 + 5장 슬라이드

### 통합
- [ ] **AC-INT1**: 풀 e2e — 드라이브 생성 → agent 발행 → 외부 curl이 vanilla a2a-x402 흐름으로 호출 → 답+출처 + owner 지갑 입금 hash
- [ ] **AC-INT2**: 같은 agent를 brower buyer가 cap-bearer로 호출 → x402 안 거치고 답

---

## 3. Implementation Steps

> **각 트랙은 ARCHITECTURE.md의 디렉토리 구조를 따른다.** 새 코드는 새 구조 (`shared/domain/`, `web/src/{adapters,use-cases,infra}/`)에 작성. 기존 `web/lib/*`는 그대로 두고 점진 이동.

### Track A — Cap & Pay (백엔드 1명)

#### A.1 신규: `shared/domain/capability/`
- `types.ts` — `Capability`, `Area`, `CapVerifyResult`
- `ports.ts` — `interface CapIssuer`, `interface CapVerifier`
- `verify.ts` — pure: `pathCoveredByPrefix(path, prefix)`, `isWithinTimeRange(now, range)` (단위 테스트 강제)

#### A.2 신규: `web/src/infra/crypto/meadowcap-impl.ts`
`@earthstar/meadowcap` 래퍼. `CapIssuer`, `CapVerifier` 구현. 기존 `web/lib/willow/cap-issue.ts` 로직 옮김.

#### A.3 신규: `web/src/use-cases/capability/`
- `issue-share-cap.ts` — 결제 성공 시 호출. `IssueDeps = {drives, capIssuer, capStore}`
- `verify-bearer-cap.ts` — 미들웨어가 호출

#### A.4 신규: `web/src/adapters/http/middleware/cap.ts`
`Authorization: Bearer <cap>` 헤더 추출 → use-case 호출 → `{ok, area} | {ok:false, reason}` 반환.

#### A.5 수정: `web/app/api/drives/route.ts` (POST)
신규 드라이브 생성 시 `generateEd25519Keypair()` → `drives.namespace_pubkey/secret` 채움.

#### A.6 수정: `web/app/api/s/[token]/pay/route.ts`
결제 성공 분기에서 use-case `issueShareCap` 호출 → `{cap, expiresAt}` 응답 포함, `aindrive_cap` 쿠키 set.

#### A.7 수정: `web/app/api/drives/[driveId]/fs/{read,list}/route.ts`
세션 인증 OR cap-middleware. 둘 다 실패 시 401.

#### A.8 테스트: `web/tests/m5-cap.mjs`
1. signup → drive create → namespace_pubkey not null
2. paid share 생성
3. 결제 시뮬레이션 → cap 받기
4. cap으로 fs/read 성공
5. 잘못된 path → 401 cap_path_out_of_scope
6. cap 만료 → 401 cap_expired

### Track B — Folder RAG + Agent Card (AI/CLI 1명)

#### B.1 의존성
`cli/package.json`:
```json
"openai": "^4.0.0",
"better-sqlite3": "^11.7.0"
```
`web/package.json`:
```json
"x402": "^2.1.0",          // Coinbase 활성 유지보수
"@a2a-js/sdk": "^0.3.13"   // A2A 카드/JSON-RPC 코어
```

> **공식 a2a-x402 TS SDK 없음.** Coinbase `x402` npm으로 결제 primitive(facilitator 검증, X-PAYMENT 처리) 처리하고, A2A 익스텐션 와이어 포맷(agent-card.json `securityScheme` + 402 응답에 `paymentRequirements` 동봉)은 [공식 spec](https://github.com/google-agentic-commerce/a2a-x402) 따라 직접 작성 (~50줄).

#### B.2 신규: `shared/domain/agent/`
- `types.ts` — `Agent`, `AgentCard`, `AskRequest`, `AskResult`, `Source`
- `ports.ts` — `interface AgentRepo`, `interface RagEngine`

#### B.3 신규: `cli/src/use-cases/rag/`
- `index-folder.ts` — walk + chunk + embed
- `query-folder.ts` — embed q + cosine top-k + LLM

#### B.4 신규: `cli/src/infra/`
- `sqlite/rag-store.ts` — `(chunk_id, file_path, line_start, line_end, text, embedding BLOB)`
- `llm/openai-embed.ts` — `text-embedding-3-small`
- `llm/openai-chat.ts` — `gpt-4o-mini`, max_tokens=400, 시스템 프롬프트로 출처 강제

#### B.5 수정: `cli/src/rpc.js` (또는 신규 `cli/src/use-cases/fs/handle-rpc.ts`)
RPC_METHODS에 `rag-index`, `rag-query` 추가, use-case 호출.

#### B.6 신규: `web/src/use-cases/agent/`
- `create-agent.ts` — owner 검증 + agents 테이블 INSERT + sendRpc(rag-index)
- `ask-agent.ts` — ★ 이중 인증 분기 핵심 (ARCHITECTURE.md §4 참조)
- `publish-card.ts` — A2A v1 카드 JSON 생성

#### B.7 신규: `web/src/adapters/http/routes/`
- `agents/route.ts` — POST(create), GET(list)
- `agent/[id]/ask/route.ts` — ask use-case 호출, output kind에 따라 200/402/401/429
- `well-known/agent-card/[id]/route.ts` — publish-card 호출

#### B.8 신규: `web/src/adapters/http/middleware/x402.ts`
X-PAYMENT 헤더 → Coinbase `x402` lib로 검증 → owner 지갑 입금.

#### B.9 신규: `web/src/infra/policy/rate-limit.ts`
in-memory 토큰버킷 (key: `agent:{id}:cap:{recipientHex}`), 분당 60 / 일당 1000.

#### B.10 신규: DB 마이그레이션 (`web/src/infra/db/sqlite.ts`)
```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  drive_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_usdc_per_call REAL,
  payment_chain TEXT DEFAULT 'base-sepolia',
  payment_address TEXT,
  index_status TEXT DEFAULT 'pending' CHECK (index_status IN ('pending','indexing','ready','failed')),
  index_progress INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(drive_id) REFERENCES drives(id) ON DELETE CASCADE
);
```

#### B.11 테스트: `web/tests/m6-agent.mjs`
1. owner: agent 생성 + 인덱싱 wait until ready
2. 외부 호출 (cap 없음, X-PAYMENT 없음) → 402 + paymentRequirements
3. mock X-PAYMENT 헤더로 재시도 → 200 + answer + sources
4. cap-bearer 호출 → 200 + 답
5. rate limit 초과 → 429

### Track C — UX & Demo (프론트 1명)

#### C.1 수정: `web/components/share-dialog.tsx`
가격 옆 헬퍼: *"드라이브 buyer는 모든 agent 무제한 면제"*

#### C.2 수정: `web/components/share-gate.tsx`
응답에 `cap` 받으면 → 토스트 *"🔑 Capability granted (until {date})"* + *"Export for external use"* 버튼 (mydrive-{driveId}.cap 다운로드) + *"Use with curl"* 클립보드 복사

#### C.3 신규: `web/components/folder-chat.tsx`
스트리밍/폴링 채팅 + 출처 카드 (파일·라인 클릭 → viewer 하이라이트)

#### C.4 수정: `web/components/drive-shell.tsx`
우측 패널 토글, 폴더 우클릭 메뉴에 *"Create Agent"* 추가, 인덱싱 progress polling

#### C.5 신규: `web/components/agent-card-preview.tsx`
agent-card.json URL + 미리보기 + curl/LangChain 코드 스니펫

#### C.6 시드: `sample/` 보강
- `docs/q1-okr.md`, `docs/q2-okr.md`
- `meetings/2026-04-15-leadership.md`
- `products/aindrive-spec.md`
- `legal/tos.md`
- 트릭 질문: *"우리 5월 마케팅 예산?"*

#### C.7 발표 자료
`pitch/`:
- `slides.md` (5장)
- `demo-script.md` (90초 + 백업 클릭)
- `demo.mp4`

---

## 4. Risks & Mitigations

| 리스크 | 영향 | 완화 |
|---|---|---|
| **R1**: x402 facilitator 차단/지연 | demo 망함 | `AINDRIVE_X402_DEV_BYPASS=1` env 분기 |
| **R2**: OpenAI 비용 폭발 | 카드 정지 | sample/ 50파일 이내, max_tokens=400, embedding 캐시 SHA256(content) |
| **R3**: WSS 끊김 → agent_offline 504 | 라이브 데모 사고 | 데모 직전 `aindrive` 재시작 + 헬스 체크. 자동 재연결 backoff은 있음 |
| **R4**: cap 검증 false positive | 보안 사고 | m5 negative case 4개 (만료/wrong namespace/wrong path/forged sig) 통과 필수 |
| **R5**: 인덱싱 시간 초과 | UX 망함 | DB `index_progress` polling. 30초 넘으면 *"Indexing in background"* |
| **R6**: 공식 a2a-x402 TS 구현 부재 | 통합 시간 소요 | T+1h echo agent로 wire smoke 테스트 — 카드 securityScheme + 402 응답 + X-PAYMENT 검증 3가지만 spec 따라 (~50줄). 막히면 `dabit3/a2a-x402-typescript` 참조용 |
| **R7**: SQLite 단일 인스턴스 | 해커톤은 OK | 발표에서 *"프로덕션은 Neon Postgres"* 한 줄 |
| **R8**: RAG 환각 | 신뢰 무너짐 | 시스템 프롬프트로 *"sources only, else 'not in this folder'"* 강제 |
| **R9**: 비동기 인덱싱 중 호출 → 빈 답 | UX 사고 | `index_status='ready'` 아니면 503 *"agent_indexing"* + 진행률 헤더 |
| **R10**: 트랙 간 머지 충돌 | T+10h 통합 지연 | 첫 30분 4개 contract + ARCHITECTURE.md의 feature ownership으로 같은 파일 만지지 않음 |

---

## 5. Verification Steps

### 통합 e2e (T+14h, T+22h 필수 통과)
```bash
# 1. owner 측 준비
cd web && npm run dev &
cd cli && node bin/aindrive.mjs login
cd cli && node bin/aindrive.mjs /mnt/newdata/git/aindrive-haechan/sample &

# 2. owner: agent 생성
curl -X POST http://localhost:3737/api/drives/<id>/agents \
  -H "Cookie: aindrive_session=..." \
  -d '{"folder":"docs","name":"OKR Bot","price_usdc_per_call":0.001}'
# → wait for index_status=ready

# 3. 외부 컨슈머 (cap 없음, x402 결제)
curl -X POST .../api/agent/<id>/ask -d '{"q":"Q1 OKR?"}'
# → 402 + paymentRequirements

curl -X POST .../api/agent/<id>/ask \
  -H "X-PAYMENT: <signed payment>" \
  -d '{"q":"Q1 OKR?"}'
# → 200 + {answer, sources}

# 4. buyer (cap 보유)
curl -X POST .../api/agent/<id>/ask \
  -H "Authorization: Bearer <cap>" \
  -d '{"q":"5월 예산?"}'
# → 200, x402 안 거침

# 5. agent card 발견
curl .../.well-known/agent-card/<id>.json
# → A2A v1 spec 준수 JSON
```

---

## 6. Track별 분업 (3인)

| Track | 담당 | 메인 브랜치 | 핵심 deliverable |
|---|---|---|---|
| **A** Cap & Pay | 백엔드/보안 | `haechan/track-a-cap` | 결제→cap, fs/agent 라우트 보호, m5 통과 |
| **B** RAG + A2A | AI/CLI | `haechan/track-b-rag` | rag-index/query, agent-card.json, /ask 라우트, m6 통과 |
| **C** UX & Demo | 프론트/내러티브 | `haechan/track-c-ux` | folder-chat, paywall→cap UX, share-dialog, 시드, 슬라이드 |

### 첫 30분 킥오프에서 못 박을 4개 contract

```ts
// shared/contracts/http.ts 에 박는다 (Track A 작성, 3인 합의 후 freeze)

// 1) 결제 성공 응답 (Track A → C)
export type PaySuccessResponse = {
  ok: true;
  cap: string;             // base64url Meadowcap
  expiresAt: number;       // ms
  pathPrefix: string;
  driveId: string;
};

// 2) cap 검증 헬퍼 시그니처 (Track A → A 라우트들 + B의 /ask)
export interface CapVerifier {
  verify(capBase64: string, expectedNamespace: Uint8Array, requestedPath: string):
    Promise<CapVerifyResult>;
}
export type CapVerifyResult =
  | { ok: true; area: { pathPrefix: string; expiresAt: number; recipientHex: string } }
  | { ok: false; reason: "cap_invalid" | "cap_expired" | "cap_namespace_mismatch" | "cap_path_out_of_scope" };

// 3) RAG 응답 (Track B → C)
export type RagAnswer = {
  answer: string;
  sources: Array<{ path: string; lineStart: number; lineEnd: number; snippet: string }>;
};

// 4) Agent Card 스킴 ID (Track B 단독, C는 표시용)
export const SCHEME_X402 = "x402-payment";
export const SCHEME_CAP  = "aindrive-cap";
```

---

## 7. Timeline (24h)

```
T+00:00  킥오프 60분
         ├─ 위 4개 contract 박기 (shared/contracts/http.ts)
         ├─ ARCHITECTURE.md §10 한 장 요약 같이 읽기
         ├─ 브랜치 3개 분기 (haechan/track-{a,b,c})
         └─ npm install (x402, @a2a-js/sdk, openai, better-sqlite3)

T+01:00  병행 작업 시작
         A: verify-cap 스켈레톤 + smoke 테스트
         B: rag.js 인덱싱 + sample/ 5파일에 답변
         C: Mock 응답으로 사이드바 UI 80%
         🔥 T+01:00에 a2a-x402 wire smoke 테스트 (R6)

T+04:00  체크포인트 #1 (15분, 전원)

T+08:00  체크포인트 #2

T+12:00  통합 시작 (각자 main 머지)

T+14:00  통합 e2e #1 — 5단계 전체 통과

T+18:00  버그 픽스 + 폴리시 (새 기능 금지)

T+20:00  Feature freeze
         C: 화면 녹화 + 슬라이드 5장 시작
         A/B: 데모 시드 정비

T+22:00  드라이런 3회

T+24:00  발표
```

---

## 8. 발표 한 컷 (라이브 데모)

```
패널 1 (1분): "이 폴더가 있습니다" → owner UI 폴더 트리
              → 우클릭 [Create Agent] → 가격 0.001 USDC/call → 인덱싱
              → agent-card.json URL 표시

패널 2 (1분): "외부 누구나 호출 — 우리 SDK 0줄"
              → 다른 터미널 vanilla curl
              → 첫 호출: 402 + paymentRequirements
              → x402 client USDC sign + retry
              → 200 + answer + sources
              → owner 지갑 입금 트랜잭션 hash

패널 3 (1분): "buyer는 면제 — cap 보유"
              → 다른 컴퓨터 (시뮬)에서 cap-bearer 호출
              → x402 안 거치고 답
              → "한 번 결제로 무제한, 어디서든 작동"
```

### 예상 Q&A — 정직 답변

| 질문 | 답변 |
|---|---|
| *"공식 a2a-x402 라이브러리 쓴 건가요?"* | *"공식 스펙(`google-agentic-commerce/a2a-x402`, Apache-2.0)을 따랐고, 결제 primitive는 Coinbase가 운영하는 `x402` npm을 사용. 공식 TS SDK가 없어 wire format 어댑터(~50줄)는 spec 보고 직접 작성했습니다."* |
| *"왜 자체 cap 시스템도?"* | *"외부 A2A 클라이언트는 표준 x402로 호출, aindrive에서 폴더 산 buyer는 Meadowcap capability로 결제 면제 — 두 트랙 공존. 어느 쪽도 walled garden 아님."* |
| *"Willow Protocol 어디?"* | *"Meadowcap(Willow의 권한 레이어)을 공식 구현(`@earthstar/meadowcap`)으로 사용. Willow Data Model과 WGPS 풀 sync는 다음 마일스톤."* |
| *"owner OpenAI 비용 폭주?"* | *"Cap-bearer 호출은 drive당 분당 60회 / 일당 1000회 토큰버킷. 외부 호출은 호출당 결제라 자체 정산."* |
| *"호스팅 WSS 타임아웃?"* | *"현재는 자체 호스팅 시연. 프로덕션은 always-on relay(Fly/Railway) + 분리된 UI 호스트가 다음 단계."* |

---

## 9. 개방된 결정 (T+0:00 킥오프 전 합의)

1. **임베딩/LLM**: OpenAI 직접 (`text-embedding-3-small` + `gpt-4o-mini`) — 셋업 빠름
2. **결제 체인**: `base-sepolia` testnet — 표준
3. **owner 지갑 등록**: agent 생성 시 (옵셔널 — 무료 agent도 가능)
4. **buyer cap 만료**: 7일
5. **Willow Data Model / WGPS** — 범위 외, *"다음 마일스톤"*
6. **AP2 mandate / ERC-8004** — 범위 외

---

## 10. 산출 파일 매핑

ARCHITECTURE.md의 디렉토리 구조 참조. 핵심:

```
shared/
├── domain/{capability,agent,drive,share}/{types,ports}.ts
├── contracts/{http,rpc,agent-card}.ts
└── crypto/sig.ts                      ← 기존 4중복 → 1개

web/src/
├── adapters/http/{routes,middleware}/
├── use-cases/{capability,agent,share,drive}/<verb>.ts
├── infra/{db,crypto,payment,rpc,policy}/
└── composition.ts                     ← DI 한 곳

cli/src/
├── adapters/{wss,cli}/
├── use-cases/{rag,fs,doc}/<verb>.ts
├── infra/{fs,sqlite,llm}/
└── composition.ts

web/tests/m5-cap.mjs, m6-agent.mjs   ← 트랙별 e2e
sample/{docs,meetings,products,legal}/  ← 데모 시드
pitch/{slides.md,demo-script.md,demo.mp4}
```

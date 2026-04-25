# aindrive 해커톤 실행 플랜 (2026-04-25)

> **한 줄 미션**: 어떤 폴더든 *결제하면 열리는 RAG 에이전트*로 발행하는 도구. 외부 A2A 클라이언트는 표준 `a2a-x402`로 호출하고, aindrive에서 폴더를 산 buyer는 Meadowcap cap으로 무제한 면제받는다.

---

## 0. Requirements Summary

### 무엇을 만드는가
aindrive 위에 새로운 두 기능 레이어:
1. **폴더 RAG 에이전트 발행**: owner가 자기 드라이브의 어떤 폴더든 "Create Agent" 한 번으로 RAG 에이전트로 노출. Agent Card는 `/.well-known/agent-card.json`에 게시.
2. **이중 인증/결제 트랙**:
   - 외부 A2A 클라이언트: 표준 `a2a-x402` (per-call USDC micropayment)
   - aindrive web buyer: Meadowcap cap을 Bearer로 제시하면 결제 면제

### 왜 만드는가
- aindrive의 차별점이 *"파일 공유 드라이브"*에서 *"폴더 단위 AI 에이전트 발행소"*로 격상
- A2A + x402 표준에 정확히 부합 → walled garden 회피, 다른 AI가 발견·결제·호출 가능
- Meadowcap cap의 capability-based access를 *결제 영수증*으로 재사용 → "한 번 사면 끝" 약속 유지

### 배경 (현재 상태, 5일 전 메모리 기준)
- `web/lib/willow/`에 Meadowcap 헬퍼는 있으나 share 발급 흐름엔 미연결 (legacy nanoid token만 사용)
- `web/app/api/s/[token]/{route,pay/route}.ts`에 x402 게이트는 있으나 `folder_access` row만 발급
- RAG·에이전트·agent-card·ERC-8004 식별자 — 전무
- `@earthstar/willow` 패키지는 설치만 됐고 import 0건. Data Model / WGPS는 안 씀
- 살아있는 RPC 브리지: `/api/agent/connect` WSS → `cli/src/agent.js` HMAC RPC

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

## 2. Acceptance Criteria (각 항목 테스트 가능)

### A. Cap & Pay (Track A)
- [ ] **AC-A1**: 신규 드라이브 페어링 시 `drives.namespace_pubkey`/`namespace_secret`이 NULL이 아님 (`POST /api/drives` 검증)
- [ ] **AC-A2**: 유료 share 결제 성공 시 응답에 `cap` 필드(base64url Meadowcap) + `expiresAt` 포함, `aindrive_cap` 쿠키 set됨 (httpOnly, sameSite=Lax, secure)
- [ ] **AC-A3**: `verifyCapBearer(capBase64, driveId, path)` 헬퍼가 ① 서명 체인 ② 만료 ③ namespace 일치 ④ path_prefix 부분집합 4가지를 모두 검사하고 `{ok, area}` 또는 `{ok:false, reason}` 반환
- [ ] **AC-A4**: `/api/drives/[driveId]/fs/read` 라우트가 cap-bearer 통과 시 기존 sendRpc 흐름 진행, 실패 시 401 + 사유
- [ ] **AC-A5**: 만료된 cap → 401 `cap_expired`, 잘못된 path prefix → 401 `cap_path_out_of_scope` (e2e 테스트로 검증)

### B. Folder RAG + A2A Agent (Track B)
- [ ] **AC-B1**: `cli/src/rpc.js#rag-index`가 폴더 walk → 청크(800자/100자 overlap) → 임베딩 → `~/.aindrive/rag/<driveId>__<folderHash>.sqlite`에 `(chunk_id, file_path, line_start, line_end, text, embedding BLOB)` 저장
- [ ] **AC-B2**: `rag-query`가 코사인 top-k=5 검색 → LLM 호출 → `{answer:string, sources:Array<{path,lineStart,lineEnd,snippet}>}` 반환. 출처 인용 강제 (시스템 프롬프트로)
- [ ] **AC-B3**: `GET /.well-known/agent-card/[id].json`이 A2A v1 스펙(securitySchemes, security, supportedInterfaces, skills) 준수 + 듀얼 스킴 선언 (`x402-payment`, `aindrive-cap`)
- [ ] **AC-B4**: `POST /api/agent/[id]/ask` 라우트:
  - cap-bearer 헤더 있으면 → Track A의 `verifyCapBearer` 통과 시 즉시 RAG
  - 없으면 → x402 익스텐션이 402 응답 + `paymentRequirements` 반환
  - X-PAYMENT 헤더 검증 통과 시 → RAG + owner 지갑 입금
- [ ] **AC-B5**: vanilla `curl -X POST .../ask -H "X-PAYMENT: ..."`로 외부 호출 가능 (우리 client 0줄)
- [ ] **AC-B6**: `verifyCapBearer` 통과 시 호출당 카운터 +1, drive당 분당 60회 / 일당 1000회 토큰 버킷 (메모리 OK)

### C. UX & Demo (Track C)
- [ ] **AC-C1**: drive-shell에 우측 사이드바 토글, 폴더 컨텍스트 들고 채팅 가능
- [ ] **AC-C2**: owner 모드에서 폴더 우클릭 → `Create Agent` 모달 → 가격 입력 → 인덱싱 진행률 표시 → agent card URL 표시 + 복사 버튼
- [ ] **AC-C3**: 채팅창 답변에 출처 카드 (파일명·라인 범위·스니펫). 카드 클릭 시 viewer로 점프
- [ ] **AC-C4**: paywall(공유 결제) 성공 직후 *"🔑 Capability granted, valid until ..."* 토스트 + Export 버튼 (cap base64 다운로드)
- [ ] **AC-C5**: `sample/` 시드 데이터: 가상 회사 OKR/회의록/제품 스펙 5~10개 마크다운 파일
- [ ] **AC-C6**: 30초 시연 영상 + 5장 슬라이드 (문제·해법·아키텍처·데모컷·향후 로드맵)

### 통합 (전 트랙 공통)
- [ ] **AC-INT1**: 풀 e2e 시나리오 1회 통과 — 드라이브 생성 → agent 발행 → 외부 curl이 vanilla a2a-x402 client 흐름으로 호출 → 답 + 출처 + owner 지갑 입금 트랜잭션 hash 출력
- [ ] **AC-INT2**: 같은 agent를 brower buyer가 cap-bearer로 호출 → x402 안 거치고 답 받음

---

## 3. Implementation Steps (트랙별, 파일 단위)

### Track A — Cap & Pay (백엔드 1명)

#### A.1 신규 파일: `web/lib/willow/verify-cap.ts`
```ts
import { meadowcap, pathFromString, pathToString } from "./meadowcap.js";
const mc = meadowcap();

export type CapVerifyResult =
  | { ok: true; area: { pathPrefix: string; expiresAt: number; recipientPub: Uint8Array } }
  | { ok: false; reason: "cap_invalid" | "cap_expired" | "cap_namespace_mismatch" | "cap_path_out_of_scope" };

export async function verifyCapBearer(
  capBase64: string,
  expectedNamespace: Uint8Array,
  requestedPath: string
): Promise<CapVerifyResult> {
  // 1. decode + isValidCap
  // 2. namespace 일치
  // 3. now in time_range
  // 4. requestedPath startsWith pathPrefix
  // 5. recipientPub 추출
}
```

#### A.2 수정: `web/app/api/drives/route.ts` (POST 핸들러)
```diff
+ import { generateEd25519Keypair } from "@/lib/willow/meadowcap.js";
+ const { publicKey, secretKey } = await generateEd25519Keypair();
  db.prepare(`INSERT INTO drives (..., namespace_pubkey, namespace_secret) VALUES (..., ?, ?)`)
-   .run(...);
+   .run(..., Buffer.from(publicKey), Buffer.from(secretKey));
```

#### A.3 수정: `web/app/api/s/[token]/pay/route.ts`
결제 성공 분기에서 `folder_access` insert를 **유지**하면서 추가로 cap 발급:
```diff
+ import { issueShareCap } from "@/lib/willow/cap-issue.js";
+ const driveRow = db.prepare("SELECT namespace_pubkey, namespace_secret FROM drives WHERE id = ?").get(share.drive_id);
+ const { capBase64, recipientSecret } = await issueShareCap({
+   namespacePub: driveRow.namespace_pubkey,
+   namespaceSecret: driveRow.namespace_secret,
+   pathPrefix: share.path,
+   accessMode: share.role === 'editor' ? 'write' : 'read',
+   ttlMs: 7 * 24 * 60 * 60 * 1000,
+ });
+ const res = NextResponse.json({ ok: true, cap: capBase64, expiresAt: Date.now() + 7*86400_000 });
+ res.cookies.set('aindrive_cap', capBase64, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 7*86400 });
+ return res;
```

#### A.4 신규 미들웨어: `web/lib/willow/cap-middleware.ts`
fs 라우트들에 공통 적용. 헤더 또는 쿠키에서 cap 추출 → verifyCapBearer 호출.

#### A.5 수정: `web/app/api/drives/[driveId]/fs/{read,list}/route.ts`
세션 인증 분기 + cap 분기 OR로 묶음. 두 분기 모두 실패 시 401.

#### A.6 테스트: `web/m5-cap-test.mjs` (신규)
`m3-test.mjs` 패턴 그대로:
1. signup → drive create → check namespace_pubkey not null
2. paid share 생성
3. 결제 시뮬레이션 → cap 받기
4. cap으로 fs/read 호출 성공
5. 잘못된 path → 401 cap_path_out_of_scope
6. cap 만료 시뮬레이션 → 401 cap_expired

### Track B — Folder RAG + Agent Card (AI/CLI 1명)

#### B.1 의존성 추가: `cli/package.json`
```json
"openai": "^4.0.0",
"better-sqlite3": "^11.7.0"
```

`web/package.json`:
```json
"x402": "^2.1.0",          // Coinbase가 운영하는 x402 protocol primitives (활성 유지보수, 2026-04 기준)
"@a2a-js/sdk": "^0.3.13"   // A2A 카드/JSON-RPC 코어
```

> **주의**: 공식 `google-agentic-commerce/a2a-x402` 레포는 **Python 100%, v0.1.0 단일 릴리스, 22 commits** — 스펙 + reference impl 위주로 가벼운 유지보수 상태. **공식 TypeScript SDK는 없음.** 우리 전략: Coinbase의 `x402` npm으로 결제 primitive(facilitator 검증, X-PAYMENT 처리)를 처리하고, A2A 익스텐션 와이어 포맷(agent-card.json `securityScheme` + 402 응답에 `paymentRequirements` 동봉)은 [공식 spec](https://github.com/google-agentic-commerce/a2a-x402) 따라 직접 작성 (분량 ~50줄). 커뮤니티 TS 포트(`dabit3/a2a-x402-typescript`)도 있으나 1인 메인테이너라 의존 X.

#### B.2 신규: `cli/src/rag.js`
```js
export async function indexFolder({ root, folderRel, driveId }) { /* walk + chunk + embed + sqlite */ }
export async function queryFolder({ root, folderRel, driveId, q, k=5 }) { /* embed q + cosine top-k + LLM */ }
```
- 임베딩 모델: `text-embedding-3-small` (`OPENAI_API_KEY` env)
- 청크: 800 chars, 100 overlap, 마크다운/텍스트/코드만 (binary skip)
- 시스템 프롬프트: *"Answer only from sources below. Cite sources by path:line. If unsure, say 'not in this folder'."*

#### B.3 수정: `cli/src/rpc.js` — RPC_METHODS에 추가
```diff
- "yjs-write", "yjs-read",
+ "yjs-write", "yjs-read", "rag-index", "rag-query",
```
+ 새 case 두 개로 위 함수 호출.

#### B.4 신규: `web/app/api/drives/[driveId]/agents/route.ts`
- POST: owner만, body `{ folder, name, description, pricing? }` → driveId 검증 → `sendRpc(driveId, {method:'rag-index', folder})` 비동기 → DB `agents` 테이블에 row → agent_id 반환
- GET: owner의 agents 목록

신규 테이블 (`web/lib/db.js`에 ALTER):
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

#### B.5 신규: `web/app/.well-known/agent-card/[id]/route.ts`
A2A v1 spec 엄수:
```ts
return Response.json({
  name: agent.name,
  description: agent.description,
  version: "1.0.0",
  supportedInterfaces: [{ url: `${baseUrl}/api/agent/${id}`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
  capabilities: { streaming: false, pushNotifications: false },
  securitySchemes: {
    "x402-payment": { type: "custom", spec: "https://github.com/google-agentic-commerce/a2a-x402" },
    "aindrive-cap": { type: "http", scheme: "bearer", description: "Meadowcap capability obtained at /d/<driveId>/buy" }
  },
  security: [{ "x402-payment": [] }, { "aindrive-cap": [] }],
  skills: [{ id: "ask", name: "Ask folder", description: "Q&A over folder contents", tags: ["rag", "search"] }],
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
});
```
경로: `/.well-known/agent-card/<id>.json` (스펙 파일명).

#### B.6 신규: `web/app/api/agent/[id]/ask/route.ts`
```ts
import { verifyCapBearer } from "@/lib/willow/verify-cap.js";
import { paymentRequired, verifyPayment } from "x402"; // 또는 a2a-x402 typescript 포팅

const auth = req.headers.get("authorization");
const xpay = req.headers.get("x-payment");

if (auth?.startsWith("Bearer ")) {
  const cap = auth.slice(7);
  const result = await verifyCapBearer(cap, agent.namespace_pubkey, agent.folder);
  if (!result.ok) return new Response(JSON.stringify({error: result.reason}), {status:401});
  if (!checkRateLimit(agent.id, result.area.recipientPub)) return new Response("rate_limit", {status:429});
} else if (xpay) {
  const payOk = await verifyPayment(xpay, agent.price_usdc_per_call, agent.payment_address);
  if (!payOk) return new Response(JSON.stringify({error:"payment_invalid"}), {status:402});
} else {
  return paymentRequired({
    price: agent.price_usdc_per_call,
    network: agent.payment_chain,
    payTo: agent.payment_address,
    facilitator: process.env.AINDRIVE_X402_FACILITATOR || "https://x402.org/facilitator",
  });
}

// 인증 통과 → RAG
const result = await sendRpc(agent.drive_id, { method:"rag-query", folder: agent.folder, q: body.q });
return Response.json(result);
```

#### B.7 신규: `web/lib/rate-limit.js`
in-memory 토큰버킷 (key: `agentId:recipientPub`), 분당 60 / 일당 1000.

#### B.8 테스트: `web/m6-agent-test.mjs`
1. owner: agent 생성 + 인덱싱 wait until ready
2. 외부 호출 (cap 없음, X-PAYMENT 없음) → 402 + paymentRequirements
3. mock X-PAYMENT 헤더로 재시도 → 200 + answer + sources
4. cap-bearer로 호출 → 200 + 답 (rate counter 증가 확인)
5. rate limit 초과 → 429

### Track C — UX & Demo (프론트 1명)

#### C.1 수정: `web/components/share-dialog.tsx`
가격 필드 옆에 *"드라이브 buyer는 이 드라이브의 모든 agent에 무제한 면제됨"* 헬퍼 텍스트.

#### C.2 수정: `web/components/share-gate.tsx`
결제 성공 응답에서 `cap` 필드 받으면:
- 토스트 *"🔑 Capability granted (until {date})"*
- *"Export for external use"* 버튼 → `mydrive-{driveId}.cap` 다운로드
- *"Use with curl"* 버튼 → 클립보드에 1라인 curl 명령어 복사

#### C.3 신규: `web/components/folder-chat.tsx`
- 스트리밍 채팅창 (간단히 logical, 폴링도 OK)
- 메시지 + 출처 카드 컴포넌트
- 출처 클릭 시 viewer.tsx에서 해당 라인 하이라이트

#### C.4 수정: `web/components/drive-shell.tsx`
- 우측 패널 toggle (데스크톱만)
- 폴더 우클릭 메뉴에 *"Create Agent"* 추가
- agent 모달: name, description, price 입력 → POST → 인덱싱 progress polling

#### C.5 신규: `web/components/agent-card-preview.tsx`
- 생성 직후 `agent-card.json` URL + 미리보기 + curl 예시 + LangChain 예시 코드 스니펫

#### C.6 시드: `sample/` 보강
- `docs/q1-okr.md`, `docs/q2-okr.md`
- `meetings/2026-04-15-leadership.md`
- `products/aindrive-spec.md`
- `legal/tos.md`
- 의도적 트릭 질문도 가능하게: *"우리 5월 마케팅 예산 뭐였지?"* (스펙 안에 있음)

#### C.7 발표 자료
`pitch/` 디렉토리:
- `slides.md` (5장: 문제/해결/아키텍처/시연 캡처/로드맵)
- `demo-script.md` (90초 대본 + 백업 클릭 순서)
- `demo.mp4` (드라이런 후 녹화)

---

## 4. Risks & Mitigations

| 리스크 | 영향 | 완화 |
|---|---|---|
| **R1**: x402 facilitator (`x402.org/facilitator`) 해커톤장 인터넷 차단/지연 | demo 망함 | `AINDRIVE_X402_DEV_BYPASS=1` env 분기로 mock 검증 활성화. 코드에 이미 dev bypass 흔적 있음 |
| **R2**: OpenAI API 키 비용 폭발 (인덱싱 + 질의) | 카드 정지 | sample/ 50파일 이내, 답변 max_tokens=400, embedding 캐시 SHA256(content) → 동일 chunk 재인덱싱 스킵 |
| **R3**: WSS 연결 끊김 (CLI agent ↔ web) → agent_offline 504 | 라이브 데모 사고 | 데모 직전 `aindrive` 재시작 + 헬스 체크. agent_offline 시 자동 재연결 backoff은 이미 있음 |
| **R4**: cap 검증 버그로 false positive (도용 access) | 보안 사고 | `web/m5-cap-test.mjs`에 negative case 4개 강제 (만료/wrong namespace/wrong path/forged sig). 머지 전 통과 필수 |
| **R5**: 인덱싱 시간 초과 (UI에서 무한 대기처럼 보임) | UX 망함 | DB `index_progress` 컬럼으로 진행률 polling. 30초 넘으면 토스트 *"Indexing in background, you'll be notified"* |
| **R6**: 공식 a2a-x402 TS 구현 없음 (Python only, v0.1.0 단일 릴리스). Coinbase `x402` npm + 우리 spec 어댑터 직접 작성 필요 | 통합 시간 소요 | T+1h에 echo agent로 wire format smoke 테스트 필수 — 카드 securityScheme 선언 + 402 응답 paymentRequirements + X-PAYMENT 검증 3가지만 spec 따라 구현 (~50줄). 막히면 커뮤니티 포트 `dabit3/a2a-x402-typescript` 참조용으로만 사용 |
| **R7**: SQLite 단일 인스턴스라 멀티 워커 X | 해커톤은 단일이라 OK | 발표에서 "프로덕션은 Neon Postgres 마이그레이션" 한 줄로 처리 |
| **R8**: RAG 답변 환각 | 신뢰 무너짐 | 시스템 프롬프트로 *"sources only, else say 'not found'"* 강제. 출처 chunk_id를 답변에 강제 포함하도록 schema |
| **R9**: agent 생성 비동기 인덱싱 중에 호출이 들어오면 빈 답 | UX 사고 | `index_status='ready'` 아니면 ask 라우트에서 503 *"agent_indexing"* + 진행률 헤더 |
| **R10**: 트랙 간 머지 충돌 (특히 drive-shell.tsx, db.js) | T+10h 통합 지연 | 첫 30분에 4개 contract 박고, drive-shell.tsx는 Track C 단독 소유. db.js의 ALTER는 Track A/B 각각 자기 컬럼만 추가 (서로 다른 ALTER) |

---

## 5. Verification Steps

### Per-track 머지 전
1. `cd web && npm run typecheck` 통과 (TS만)
2. 트랙별 m*-test.mjs 통과
3. 자기 트랙 PR 본인이 head이면서 main에서 cherry-pick 가능 (rebase 가능)

### 통합 e2e (T+14h, T+22h 필수 통과)
```bash
# 1. owner 측 준비
cd web && npm run dev &
cd cli && node bin/aindrive.mjs login
cd cli && node bin/aindrive.mjs /mnt/newdata/git/aindrive/sample &

# 2. owner: agent 생성
curl -X POST http://localhost:3737/api/drives/<id>/agents \
  -H "Cookie: aindrive_session=..." \
  -d '{"folder":"docs","name":"OKR Bot","price_usdc_per_call":0.001}'
# → wait for index_status=ready

# 3. 외부 컨슈머 시뮬레이션 (cap 없음, x402 결제)
curl -X POST http://localhost:3737/api/agent/<agentId>/ask -d '{"q":"Q1 OKR?"}'
# → 402 + paymentRequirements

curl -X POST http://localhost:3737/api/agent/<agentId>/ask \
  -H "X-PAYMENT: <mock or real signed payment>" \
  -d '{"q":"Q1 OKR?"}'
# → 200 + {answer, sources}

# 4. buyer 시뮬레이션 (cap 보유)
# (m5에서 받은 cap 재사용)
curl -X POST http://localhost:3737/api/agent/<agentId>/ask \
  -H "Authorization: Bearer <cap>" \
  -d '{"q":"우리 5월 예산?"}'
# → 200, x402 안 거침

# 5. agent card 발견
curl http://localhost:3737/.well-known/agent-card/<agentId>.json
# → A2A v1 spec 준수 JSON
```

### 라이브 데모 체크리스트 (T+22h 드라이런)
- [ ] 시연 시작 전 `aindrive` 재시작, agent index_status=ready 확인
- [ ] `OPENAI_API_KEY`, x402 facilitator 응답 헬스 체크
- [ ] 백업 영상 (demo.mp4) 클릭 가능
- [ ] 발표자 PC 와이파이 + 이더넷 둘 다 (LTE 핫스팟 백업)

---

## 6. Track별 분업 (3인)

| Track | 담당 (성향) | 메인 PR | 의존 받음 / 줌 | 핵심 deliverable |
|---|---|---|---|---|
| **A** Cap & Pay | 백엔드/보안 | `track-a-cap` | A→B (verifyCapBearer 헬퍼) | 결제→cap, fs/agent 라우트 보호, m5 통과 |
| **B** RAG + A2A | AI/CLI | `track-b-rag` | B→C (응답 JSON 모양) | rag-index/query, agent-card.json, /ask 라우트, m6 통과 |
| **C** UX & Demo | 프론트/내러티브 | `track-c-ux` | C는 A/B 둘 다에 의존 (응답 모양만) | folder-chat, paywall→cap UX, share-dialog, 시드 데이터, 슬라이드/영상 |

### 첫 30분 킥오프에서 못 박을 4개 contract
```ts
// 1) 결제 성공 응답 (Track A → C)
type PaySuccessResponse = { ok: true; cap: string; expiresAt: number; pathPrefix: string; driveId: string };

// 2) cap 검증 헬퍼 시그니처 (Track A → A 라우트들 + B의 /ask)
async function verifyCapBearer(capBase64: string, expectedNamespace: Uint8Array, requestedPath: string): Promise<CapVerifyResult>;

// 3) RAG 응답 (Track B → C)
type RagAnswer = { answer: string; sources: Array<{path:string; lineStart:number; lineEnd:number; snippet:string}> };

// 4) Agent Card 스킴 ID (Track B 단독 결정, C는 미리보기에 표시)
const SCHEME_X402 = "x402-payment";
const SCHEME_CAP  = "aindrive-cap";
```

---

## 7. Timeline (24h)

```
T+00:00  킥오프 60분
         ├─ 위 4개 contract 박기
         ├─ 브랜치 3개 분기, 첫 커밋 푸시
         └─ npm install 추가 패키지 (x402, @a2a-js/sdk, openai, better-sqlite3)

T+01:00  병행 작업 시작
         A: verify-cap.ts 스켈레톤 + smoke 테스트
         B: rag.js 인덱싱 동작 + sample/ 5파일에 답변
         C: Mock 응답으로 사이드바 UI 80%
         🔥 T+01:00에 a2a-x402 npm 통합 smoke 테스트 (R6 mitigations)

T+04:00  체크포인트 #1 (15분, 전원)
         ├─ A: cap 발급 → 검증 e2e green
         ├─ B: rag-query가 sample/에 답변 가능
         └─ C: paywall→toast→사이드바 흐름 정적 동작

T+08:00  체크포인트 #2
         ├─ A: paid share → cap 쿠키, fs/read 라우트 보호
         ├─ B: agent-card.json + /ask 라우트 (cap 분기만)
         └─ C: Create Agent 모달 + folder-chat 동작

T+12:00  통합 시작 (각자 main 머지)
         ├─ B: /ask 라우트에 x402 분기 추가
         └─ C: 실제 응답으로 Mock 교체

T+14:00  통합 e2e #1 (위 verification 5단계 전체)
         발견 버그 우선순위 매김

T+18:00  버그 픽스 + 폴리시 (새 기능 금지)

T+20:00  Feature freeze
         C: 화면 녹화 + 슬라이드 5장 시작
         A/B: 데모 시드 정비, smoke 테스트 재실행

T+22:00  드라이런 3회 (각 5분)
         말씨/클릭 순서 합의, 트러블 시 폴백 (영상 재생) 약속

T+24:00  발표
```

---

## 8. 발표 한 컷 (라이브 데모)

```
패널 1 (1분): "이 폴더가 있습니다" → owner UI에서 폴더 트리 보임
              → 우클릭 → [Create Agent] → 가격 0.001 USDC/call → 인덱싱 진행
              → agent-card.json URL 표시

패널 2 (1분): "외부 누구나 호출할 수 있습니다 — 우리 SDK 0줄"
              → 다른 터미널, 미리 짠 vanilla curl 스크립트
              → 첫 호출: 402 응답 (paymentRequirements 출력)
              → x402 client로 USDC sign + retry
              → 200 + answer + sources 출력
              → owner 지갑에 0.001 USDC 입금 트랜잭션 hash

패널 3 (1분): "우리 buyer는 면제됩니다 — cap을 가지고 있으니까"
              → 또 다른 컴퓨터 (혹은 시뮬)에서 cap-bearer로 호출
              → x402 한 번도 안 거치고 답
              → "한 번 결제로 무제한, 다른 환경에서도 작동"
```

### 예상 Q&A — 정직 답변 미리 준비

| 질문 | 답변 |
|---|---|
| *"공식 a2a-x402 라이브러리 쓴 건가요?"* | "공식 스펙(`google-agentic-commerce/a2a-x402`, Apache-2.0)을 따랐고, 결제 primitive는 Coinbase가 운영하는 `x402` npm을 사용했습니다. 공식 TS SDK가 없어 wire format 어댑터(~50줄)는 spec 보고 직접 작성했습니다." |
| *"왜 자체 cap 시스템도 같이?"* | "외부 A2A 클라이언트는 표준 x402로 호출하고, aindrive에서 폴더를 산 buyer는 Meadowcap capability로 결제 면제 — 두 트랙이 공존합니다. 어느 쪽도 walled garden이 아닙니다." |
| *"Willow Protocol 어디서 쓰여요?"* | "Meadowcap(Willow의 권한 레이어)을 공식 구현(`@earthstar/meadowcap`)으로 사용해 capability를 발급/검증합니다. Willow Data Model과 WGPS 풀 sync는 다음 마일스톤입니다." |
| *"owner의 OpenAI 비용 폭주 안 위험해요?"* | "Cap-bearer 호출은 drive당 분당 60회 / 일당 1000회 토큰버킷으로 제한합니다. 외부 호출은 호출당 결제라 자체 정산됩니다." |
| *"Vercel WSS 5분 한계는?"* | "현재는 ngrok-free한 자체 호스팅 시연. 프로덕션은 always-on relay(Fly/Railway) + Vercel UI 분리가 다음 단계입니다." |

---

## 9. 개방된 결정 (T+0:00 킥오프 전 합의 필요)

1. **임베딩/LLM 제공자**: OpenAI (`text-embedding-3-small` + `gpt-4o-mini`)? 또는 Vercel AI Gateway? **추천: OpenAI 직접 (셋업 빠름)**
2. **결제 체인**: `base-sepolia` (testnet, 무료 USDC 가능)? 또는 mainnet? **추천: base-sepolia (해커톤 표준, facilitator도 testnet 지원)**
3. **owner 지갑 등록 시점**: drive 페어링 시 owner의 지갑 주소 받기 (signup에 추가 필드)? 또는 agent 생성 시? **추천: agent 생성 시 (옵셔널 — 무료 agent도 가능)**
4. **buyer cap 만료**: 7일? 30일? **추천: 7일 (도난 위험 최소화)**
5. **Willow Data Model / WGPS 풀 통합 — 해커톤 범위?** **결정: 범위 외. 발표에서 "다음 마일스톤"이라 정직 명시**
6. **AP2 mandate 통합?** **결정: 범위 외. ERC-8004 identity도 범위 외. 시간 부족.**

---

## 10. 최종 산출물 디렉토리 맵

```
web/
  app/
    .well-known/agent-card/[id]/route.ts       (B5)
    api/
      agent/[id]/ask/route.ts                  (B6)
      drives/[driveId]/agents/route.ts         (B4)
      drives/route.ts                          (A2 수정)
      s/[token]/pay/route.ts                   (A3 수정)
      drives/[driveId]/fs/{read,list}/route.ts (A5 수정)
  lib/
    willow/
      verify-cap.ts                            (A1 신규)
      cap-middleware.ts                        (A4 신규)
    rate-limit.js                              (B7 신규)
    db.js                                      (수정 — agents 테이블)
  components/
    share-dialog.tsx                           (C1 수정)
    share-gate.tsx                             (C2 수정)
    folder-chat.tsx                            (C3 신규)
    drive-shell.tsx                            (C4 수정)
    agent-card-preview.tsx                     (C5 신규)
  m5-cap-test.mjs                              (A6 신규)
  m6-agent-test.mjs                            (B8 신규)

cli/
  src/
    rag.js                                     (B2 신규)
    rpc.js                                     (B3 수정)

sample/
  docs/q1-okr.md, q2-okr.md, ...               (C6 시드)
  meetings/2026-04-15-leadership.md
  products/aindrive-spec.md
  legal/tos.md

pitch/
  slides.md, demo-script.md, demo.mp4         (C7)

.omc/plans/hackathon-2026-04-25.md             (이 파일)
```

---

## Final Checklist (작성자)

- [x] Acceptance criteria 90%+ 구체적 (파일/엔드포인트 명시)
- [x] 80%+ 클레임이 파일/라인 인용
- [x] 모든 risk에 mitigation
- [x] 모호한 용어 없음 ("빠르다" → 구체 수치)
- [x] `.omc/plans/`에 저장
- [x] 3인 분업 명확
- [x] 24h 타임라인 + 체크포인트 4개
- [x] 발표 시연 한 컷 정의

# aindrive 아키텍처 — 협업·유지보수 중심 설계

> **이 문서가 푸는 문제**: 3명이 24h 안에 같은 코드베이스에 동시에 손대는데 깨지지 않도록, 그리고 해커톤 끝나고도 6개월 지나도 후회 안 할 구조를 잡는다.

---

## 0. 5가지 핵심 원칙

| # | 원칙 | 한 줄 |
|---|---|---|
| 1 | **Dependency rule** | 안쪽 레이어는 바깥을 모른다. import는 한 방향. |
| 2 | **One source of truth** | 같은 타입·로직이 두 군데 있으면 하나 지운다. |
| 3 | **Thin adapter, fat use-case, pure domain** | HTTP route 10줄 이내, use-case가 흐름, domain은 pure |
| 4 | **Vertical features, horizontal layers** | 한 feature(cap, agent, share)는 자기 슬라이스를 모든 레이어에 가짐 |
| 5 | **Track = feature ownership, not layer ownership** | Track A는 `capability/` 전체 (도메인+유스케이스+라우트), B는 `agent/` 전체. 레이어로 자르면 셋이 한 파일에서 충돌 |

이 5개만 지키면 나머지는 자연 따라옵니다.

---

## 1. 레이어 모델

```
┌─────────────────────────────────────────────────────────────────────┐
│ 4. ADAPTERS (I/O 경계)                                               │
│    HTTP routes, WSS handlers, React components, CLI commands        │
│    "외부 세계 → 내 use-case 호출"                                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ depends on ↓
┌──────────────────────────────┴──────────────────────────────────────┐
│ 3. USE-CASES (오케스트레이션)                                        │
│    issueCapForShare, askAgent, createAgent, verifyAndForwardRpc     │
│    "비즈니스 흐름 — 도메인 + 인프라를 조합"                          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ depends on ↓
┌──────────────────────────────┴──────────────────────────────────────┐
│ 2. DOMAIN (순수 로직 + 포트 인터페이스)                              │
│    Capability 검증 규칙, Path 정규화, Cap area 부분집합 검사        │
│    interface DriveRepo, interface CapStore, interface LLM           │
│    "I/O 없음. 함수와 타입만."                                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ implemented by ↓
┌──────────────────────────────┴──────────────────────────────────────┐
│ 1. INFRA (포트의 구체 구현)                                          │
│    SqliteDriveRepo, OpenAIEmbedder, X402Facilitator, MeadowcapImpl  │
│    "외부 라이브러리·DB·네트워크와의 접점"                            │
└─────────────────────────────────────────────────────────────────────┘
```

**규칙**: 화살표는 단방향. domain이 infra를 import하는 순간 깨짐 — domain은 *interface*만 선언, infra가 *구현*.

---

## 2. 디렉토리 구조 (실전, 해커톤 대응)

```
aindrive/
├── shared/                          ← web ↔ cli 공유 (단 한 군데)
│   ├── domain/
│   │   ├── capability/              ← Track A 소유
│   │   │   ├── types.ts             (Cap, CapVerifyResult, Area)
│   │   │   ├── verify.ts            (pure: cap이 path를 cover하나?)
│   │   │   └── ports.ts             (interface CapIssuer, CapVerifier)
│   │   ├── agent/                   ← Track B 소유
│   │   │   ├── types.ts             (Agent, AgentCard, RagAnswer)
│   │   │   └── ports.ts             (interface AgentRepo, RagEngine)
│   │   ├── drive/
│   │   │   ├── types.ts             (Drive, Namespace, Subspace)
│   │   │   └── ports.ts             (interface DriveRepo)
│   │   └── share/
│   │       ├── types.ts             (Share, PaymentRequirement)
│   │       └── ports.ts
│   ├── contracts/                   ← 트랙 간 계약 (HTTP/RPC/이벤트)
│   │   ├── http.ts                  (PaySuccessResponse, AskRequest, etc.)
│   │   ├── rpc.ts                   (agent ↔ web RPC envelope)
│   │   └── agent-card.ts            (A2A spec 타입)
│   └── crypto/
│       └── sig.ts                   ← HMAC. 단일 source. .js/.ts 중복 제거
│
├── web/
│   ├── src/
│   │   ├── adapters/                ← 외부 세계 → use-case
│   │   │   ├── http/                ← Next.js route 핸들러 (얇게!)
│   │   │   │   ├── routes/
│   │   │   │   │   ├── auth/        (signup, login, logout)
│   │   │   │   │   ├── drives/      (CRUD)
│   │   │   │   │   ├── shares/      ← Track A
│   │   │   │   │   ├── agents/      ← Track B
│   │   │   │   │   └── well-known/  ← Track B (agent-card.json)
│   │   │   │   └── middleware/
│   │   │   │       ├── session.ts   (쿠키 → userId)
│   │   │   │       ├── cap.ts       ← Track A (Authorization: Bearer cap)
│   │   │   │       ├── x402.ts      ← Track B (X-PAYMENT)
│   │   │   │       └── rate-limit.ts
│   │   │   ├── wss/
│   │   │   │   ├── agent-bridge.ts  (/api/agent/connect — RPC 라우터)
│   │   │   │   └── doc-hub.ts       (/api/agent/doc — Y.js 멀티캐스트)
│   │   │   └── ui/                  ← Track C
│   │   │       ├── components/
│   │   │       └── pages/           (=Next.js app/)
│   │   ├── use-cases/               ← 비즈니스 흐름
│   │   │   ├── capability/          ← Track A
│   │   │   │   ├── issue-share-cap.ts
│   │   │   │   └── verify-bearer-cap.ts
│   │   │   ├── agent/               ← Track B
│   │   │   │   ├── create-agent.ts
│   │   │   │   ├── ask-agent.ts     ★ 이중 인증 분기 핵심
│   │   │   │   └── publish-card.ts
│   │   │   ├── share/
│   │   │   │   ├── create-share.ts
│   │   │   │   └── accept-x402-payment.ts
│   │   │   └── drive/
│   │   │       ├── pair-drive.ts    (namespace keypair 생성 포함)
│   │   │       └── proxy-fs.ts      (fs RPC 프록시)
│   │   ├── infra/                   ← 도메인 port의 구체 구현
│   │   │   ├── db/
│   │   │   │   ├── sqlite.ts        (한 군데서 DB 핸들 export)
│   │   │   │   ├── drive-repo.ts    (DriveRepo 구현)
│   │   │   │   ├── agent-repo.ts
│   │   │   │   ├── share-repo.ts
│   │   │   │   └── cap-store.ts
│   │   │   ├── crypto/
│   │   │   │   ├── meadowcap-impl.ts (CapIssuer, CapVerifier 구현)
│   │   │   │   └── ed25519.ts
│   │   │   ├── payment/
│   │   │   │   └── x402-facilitator.ts
│   │   │   └── rpc/
│   │   │       └── agent-rpc.ts     (sendRpc 구현)
│   │   └── composition.ts           ← DI: use-case에 infra 주입
│   ├── server.ts                    ← .js → .ts 마이그레이션 (tsx로 실행)
│   ├── package.json
│   └── tsconfig.json
│
├── cli/
│   ├── src/
│   │   ├── adapters/
│   │   │   ├── wss/agent-client.ts  (outbound WSS to web)
│   │   │   └── cli/                  (commander)
│   │   │       ├── login.ts
│   │   │       ├── serve.ts
│   │   │       └── status.ts
│   │   ├── use-cases/
│   │   │   ├── fs/handle-rpc.ts     (RPC 라우터)
│   │   │   ├── rag/                  ← Track B (cli 측)
│   │   │   │   ├── index-folder.ts
│   │   │   │   └── query-folder.ts
│   │   │   └── doc/persist-yjs.ts
│   │   ├── infra/
│   │   │   ├── fs/safe-resolve.ts
│   │   │   ├── sqlite/rag-store.ts
│   │   │   ├── llm/openai-embed.ts
│   │   │   └── llm/openai-chat.ts
│   │   └── composition.ts
│   └── package.json
│
└── docs/
    ├── ARCHITECTURE.md              ← 이 문서
    ├── WILLOW_DESIGN.md
    └── CONCURRENT_EDITING_DESIGN.md
```

---

## 3. 의존 규칙 (CI에서 강제 가능)

```
adapters → use-cases → domain (← interfaces)
                             ↑
infra ────────── implements ─┘

금지:
  ❌ domain 가 infra/adapters import
  ❌ use-case 가 adapters import
  ❌ infra 가 use-case import
  ❌ shared/contracts 가 web/cli 코드 import
```

자동 검증 (해커톤 후 추가 권장):
```bash
npx eslint --rule 'no-restricted-imports: ["error", {"patterns": ["**/adapters/*", "**/infra/*"]}]' shared/domain/
```

---

## 4. 구체 예시 — `askAgent` 유스케이스가 어떻게 흐르나

이게 트랙 B의 핵심 흐름이고, 모든 원칙이 한 곳에 모입니다.

### 4.1 Domain (shared/domain/agent/types.ts) — pure
```ts
export type Agent = {
  id: string;
  driveId: string;
  folder: string;
  namespacePub: Uint8Array;
  pricePerCallUsdc: number | null;
};

export type AskRequest = { q: string };
export type AskResult = { answer: string; sources: Source[] };
export type Source = { path: string; lineStart: number; lineEnd: number; snippet: string };
```

### 4.2 Domain ports (shared/domain/agent/ports.ts)
```ts
export interface AgentRepo {
  byId(id: string): Promise<Agent | null>;
}
export interface RagEngine {
  query(driveId: string, folder: string, q: string): Promise<AskResult>;
}
```

### 4.3 Use-case (web/src/use-cases/agent/ask-agent.ts) — 흐름만, I/O 없음
```ts
import type { Agent, AskRequest, AskResult } from "@shared/domain/agent/types";
import type { AgentRepo, RagEngine } from "@shared/domain/agent/ports";
import type { CapVerifier } from "@shared/domain/capability/ports";
import type { X402Verifier, PaymentRequirement } from "@shared/domain/share/ports";
import type { RateLimiter } from "@shared/domain/policy/ports";

export type AskAgentDeps = {
  agents: AgentRepo;
  rag: RagEngine;
  capVerifier: CapVerifier;
  x402Verifier: X402Verifier;
  rateLimit: RateLimiter;
};

export type AskAgentInput =
  | { kind: "cap-bearer"; agentId: string; capBase64: string; req: AskRequest }
  | { kind: "x402-payment"; agentId: string; xPaymentHeader: string; req: AskRequest }
  | { kind: "no-auth"; agentId: string; req: AskRequest };

export type AskAgentOutput =
  | { kind: "ok"; result: AskResult }
  | { kind: "payment-required"; requirement: PaymentRequirement }
  | { kind: "denied"; reason: string }
  | { kind: "rate-limited" };

export async function askAgent(deps: AskAgentDeps, input: AskAgentInput): Promise<AskAgentOutput> {
  const agent = await deps.agents.byId(input.agentId);
  if (!agent) return { kind: "denied", reason: "agent_not_found" };

  switch (input.kind) {
    case "cap-bearer": {
      const v = await deps.capVerifier.verify(input.capBase64, agent.namespacePub, agent.folder);
      if (!v.ok) return { kind: "denied", reason: v.reason };
      const allowed = await deps.rateLimit.checkAndConsume(`agent:${agent.id}:cap:${v.recipientHex}`);
      if (!allowed) return { kind: "rate-limited" };
      const result = await deps.rag.query(agent.driveId, agent.folder, input.req.q);
      return { kind: "ok", result };
    }
    case "x402-payment": {
      const v = await deps.x402Verifier.verify(input.xPaymentHeader, agent);
      if (!v.ok) return { kind: "denied", reason: v.reason };
      const result = await deps.rag.query(agent.driveId, agent.folder, input.req.q);
      return { kind: "ok", result };
    }
    case "no-auth": {
      if (!agent.pricePerCallUsdc) {
        const result = await deps.rag.query(agent.driveId, agent.folder, input.req.q);
        return { kind: "ok", result };
      }
      return { kind: "payment-required", requirement: { priceUsdc: agent.pricePerCallUsdc, ... } };
    }
  }
}
```

순수 함수. 어떤 DB도, fetch도, console.log도 없음. **무엇을 할지**만 안다.

### 4.4 Adapter (web/src/adapters/http/routes/agents/ask.ts) — 얇게
```ts
import { NextRequest, NextResponse } from "next/server";
import { askAgent } from "@/use-cases/agent/ask-agent";
import { compose } from "@/composition";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const auth = req.headers.get("authorization");
  const xpay = req.headers.get("x-payment");

  const input = auth?.startsWith("Bearer ")
    ? { kind: "cap-bearer" as const, agentId: params.id, capBase64: auth.slice(7), req: body }
    : xpay
      ? { kind: "x402-payment" as const, agentId: params.id, xPaymentHeader: xpay, req: body }
      : { kind: "no-auth" as const, agentId: params.id, req: body };

  const out = await askAgent(compose.askAgent, input);

  switch (out.kind) {
    case "ok":               return NextResponse.json(out.result);
    case "payment-required": return NextResponse.json({ paymentRequirements: out.requirement }, { status: 402 });
    case "denied":           return NextResponse.json({ error: out.reason }, { status: 401 });
    case "rate-limited":     return NextResponse.json({ error: "rate_limit" }, { status: 429 });
  }
}
```

라우트는 *transport 변환만* 한다. 비즈니스 로직 0.

### 4.5 Infra (web/src/infra/crypto/meadowcap-impl.ts)
```ts
import { meadowcap } from "./meadowcap-instance";
import type { CapVerifier, CapVerifyResult } from "@shared/domain/capability/ports";

export const meadowcapVerifier: CapVerifier = {
  async verify(capBase64, expectedNamespace, requestedPath): Promise<CapVerifyResult> {
    const cap = mc.decodeCap(Buffer.from(capBase64, "base64url"));
    if (!await mc.isValidCap(cap)) return { ok: false, reason: "cap_invalid" };
    // ... 4단계 검증
    return { ok: true, area: { ... }, recipientHex };
  }
};
```

### 4.6 Composition (web/src/composition.ts) — DI 한 곳
```ts
import { sqliteAgentRepo } from "./infra/db/agent-repo";
import { sqliteCapStore } from "./infra/db/cap-store";
import { meadowcapVerifier } from "./infra/crypto/meadowcap-impl";
import { x402FacilitatorVerifier } from "./infra/payment/x402-facilitator";
import { ragEngineViaRpc } from "./infra/rpc/rag-engine";
import { memoryRateLimit } from "./infra/policy/rate-limit";

export const compose = {
  askAgent: {
    agents: sqliteAgentRepo,
    rag: ragEngineViaRpc,
    capVerifier: meadowcapVerifier,
    x402Verifier: x402FacilitatorVerifier,
    rateLimit: memoryRateLimit,
  },
  // 다른 use-case들도 여기서 wire
};
```

테스트할 땐 `composition.ts` 안 쓰고 mock deps 직접 주입 → use-case 단위 테스트가 1초 안에 통과.

---

## 5. Track ↔ Feature 매핑 (충돌 0)

각 트랙이 **feature 슬라이스 전체**를 소유 = 같은 파일을 동시에 안 만짐.

| Track | 소유 디렉토리 | 만지는 공통 파일 | 충돌 위험 |
|---|---|---|---|
| **A** Cap & Pay | `shared/domain/capability/`, `shared/domain/share/` (일부), `web/src/use-cases/capability/`, `web/src/use-cases/share/`, `web/src/adapters/http/routes/shares/`, `web/src/adapters/http/middleware/cap.ts`, `web/src/infra/crypto/meadowcap-impl.ts` | `composition.ts` (자기 wire 추가), `db.ts` (자기 ALTER) | 낮음 |
| **B** RAG + A2A | `shared/domain/agent/`, `web/src/use-cases/agent/`, `web/src/adapters/http/routes/agents/`, `web/src/adapters/http/routes/well-known/`, `web/src/adapters/http/middleware/x402.ts`, `web/src/infra/payment/`, `web/src/infra/rpc/rag-engine.ts`, `cli/src/use-cases/rag/`, `cli/src/infra/llm/`, `cli/src/infra/sqlite/rag-store.ts` | `composition.ts`, `db.ts`, `cli/src/use-cases/fs/handle-rpc.ts` (rag-* 케이스만 추가) | 중간 — `handle-rpc.ts` 동시 수정 가능 |
| **C** UX & Demo | `web/src/adapters/ui/`, `pitch/`, `sample/`, `demo/` 시드 | (드물게) 응답 타입 정정 시 `shared/contracts/http.ts` 한 줄 | 낮음 |

**공통 파일에서 충돌 방지 규칙**:
- `composition.ts`: 알파벳 순으로 자기 wire 추가, merge conflict는 자명
- `db.ts`: 각자 자기 테이블 ALTER만 (서로 다른 테이블이라 충돌 X)
- `handle-rpc.ts` (CLI): 새 case는 알파벳 순으로

---

## 6. 네이밍 규칙

| 종류 | 규칙 | 예 |
|---|---|---|
| 도메인 타입 | PascalCase, 명사 | `Capability`, `Agent`, `RagAnswer` |
| Port 인터페이스 | PascalCase, 책임 명사 | `CapVerifier`, `AgentRepo`, `RagEngine` |
| Use-case 함수 | camelCase, 동사로 시작 | `askAgent`, `issueShareCap`, `pairDrive` |
| Use-case 파일 | kebab-case, 동사로 시작 | `ask-agent.ts`, `issue-share-cap.ts` |
| Infra 구현 | infra별 prefix | `sqliteAgentRepo`, `meadowcapVerifier`, `openaiEmbedder` |
| Use-case 입출력 타입 | `<Verb>Input` / `<Verb>Output` | `AskAgentInput`, `AskAgentOutput` |
| Discriminated union | `kind` 필드로 분기 | `{kind: "ok" | "denied" | ...}` |
| HTTP 응답 DTO | `<Verb>Response` | `PaySuccessResponse` |

---

## 7. 테스트 전략 (해커톤 최소 + 향후 확장)

```
┌─────────────────────────────────┐
│ E2E (m5/m6 .mjs)                │ ← 해커톤 통합 통과 기준 (느림, 적음)
│  실서버 + curl/fetch            │
├─────────────────────────────────┤
│ Use-case 테스트                  │ ← 가장 가성비 좋음 (mock deps만 주입)
│  mock infra → 흐름 검증         │   해커톤에 트랙별 5~10개씩 작성 권장
├─────────────────────────────────┤
│ Domain 단위                     │ ← Cap path 부분집합, 만료 비교 등
│  pure function, 즉시 통과       │   순수 로직만이라 빠르고 안 깨짐
└─────────────────────────────────┘
```

해커톤 권장:
- **트랙당 use-case 테스트 3개 + e2e 1개** 최소 충족
- domain 로직(예: `cap area covers path?`)은 **반드시 단위 테스트** (보안 회귀 방지)
- UI는 e2e가 곧 데모 — 별도 테스트 X

---

## 8. 안티패턴 (해커톤이라도 피하기)

❌ **God route**: 한 라우트에서 세션 검증 + cap 검증 + DB 쿼리 + RPC + 응답 변환을 다 함
→ ✅ middleware + use-case로 분리, route는 transport만

❌ **타입을 .ts/.js 두 곳에 베껴두기** (현 `sig.ts`/`sig.js` 문제)
→ ✅ `shared/crypto/sig.ts` 하나만, `tsx`로 실행

❌ **domain에서 process.env, fs, fetch 직접 사용**
→ ✅ port 인터페이스로 빼고, infra가 구현

❌ **순환 의존**: agent.ts가 cap.ts import, cap.ts가 agent.ts import
→ ✅ 공통 것을 third 모듈로 추출 (`shared/domain/common/`)

❌ **거대한 use-case** (200줄+)
→ ✅ 흐름 단계별로 작은 함수로 쪼개고, use-case는 그것들 호출

❌ **인라인 매직 넘버** (`if (now - ts > 300_000)`)
→ ✅ `domain/policy/constants.ts`에 `REPLAY_WINDOW_MS = 5 * 60 * 1000`

---

## 9. 마이그레이션 순서 (해커톤 현실 버전)

24h 안에 풀 리팩토링은 못함. **새 코드만 새 구조로**, 기존 코드는 점진 이동:

### T+0~1h (킥오프 시)
1. 위 디렉토리 구조 한 번 만들고 비워둠 (mkdir 들)
2. `shared/crypto/sig.ts` 단일 파일로 합침, 나머지 4개 sig 파일 import 경로만 redirect
3. `shared/contracts/http.ts`에 4개 contract 타입 박음 (Track 합의 결과)

### T+1~4h (각 트랙 첫 작업)
4. **새로 만드는 모든 파일은 새 구조로** (cap-issue.ts, ask-agent.ts, agent-card route 등)
5. 기존 `lib/access.ts`, `lib/agents.js` 등은 *그대로 둠* — 깨면 다른 트랙 머지 폭망

### T+8h (체크포인트)
6. 각 트랙이 자기 use-case 1개를 무조건 새 구조로 작성·통과 확인

### 해커톤 후
7. 기존 `lib/*` 파일들을 새 구조로 점진 이동, import 경로 재배선
8. ESLint 규칙으로 layer dependency 강제

---

## 10. 한 장 요약

```
원칙 5개   : 한 방향 import / 단일 source / 얇은 adapter / vertical feature / track=feature 소유
레이어 4   : adapters → use-cases → domain ← infra
디렉토리   : shared/domain + shared/contracts + (web|cli)/src/{adapters,use-cases,infra,composition.ts}
트랙 매핑  : A=capability+share, B=agent+rag, C=ui  → 같은 파일 안 만짐
네이밍     : Port=명사, UseCase=동사, kind 필드로 union 분기
테스트     : domain 단위 (필수) + use-case mock (가성비) + e2e (1~2개)
안티패턴   : God route / 타입 중복 / domain의 I/O / 순환 의존 / 매직 넘버
마이그     : 새 코드는 새 구조, 기존은 점진. 해커톤 후에 풀 마이그.
```

이 문서를 첫 30분 킥오프에서 같이 읽고 의문 해소하면, 24h 동안 셋이 거의 안 부딪힙니다. 그리고 6개월 뒤에 와서도 *"왜 이렇게 짰지?"* 라는 질문이 안 나옵니다 — 답이 디렉토리 구조 자체에 박혀 있기 때문에.

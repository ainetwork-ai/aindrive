# Agent Feature — Design (해찬 작업)

> **문제**: owner가 폴더로 RAG 에이전트를 만든다. 그걸 *누가 쓸 수 있는지*는 오늘은 "owner + drive buyer (cap holder)"지만, **요구사항은 언제든 바뀐다** — 내일 x402 per-call payer가 추가될 수도, 모레 subscription이 들어올 수도, 그 다음엔 referral chain일 수도. 코드의 **1군데만** 고치면 되어야 한다.

---

## 디자인 한 줄

> **`AccessPolicy`를 port 인터페이스로 두고, 새 access 종류는 새 policy 구현 + composer에 한 줄 추가로 끝나게 한다.**

`askAgent` use-case는 *누가 어떻게 인증됐는가*를 모른다. 단지:
1. `IdentityResolver`로 caller가 누군지 알아낸다
2. `AccessPolicy.decide()`에 (agent, caller, request)를 던진다
3. 결과(`allow / deny / require-payment / rate-limited`)대로 행동한다

policy의 *내용*은 외부에 격리. use-case는 영원히 안 바뀜.

---

## 변하는 축 vs 안 변하는 축

| 축 | 안 변함 (use-case에 박음) | 변함 (port 뒤로 격리) |
|---|---|---|
| 누가 인증됐나? | Resolver가 알려준 결과 모양 (`CallerIdentity`) | 어떤 헤더/쿠키를 보고 어떻게 검증할지 |
| 무엇을 해야 하나? | `query → answer + sources` | LLM 종류, 임베딩 종류, 청킹 전략 |
| 누가 쓸 수 있나? | "policy가 결정한다"는 사실 | 정책의 내용 (owner-only? cap holder? x402 payer? subscriber? ...) |
| 응답은 어떻게? | discriminated union (`AccessDecision`) | 각 경로의 HTTP status / 본문 |

---

## 코드 구조

```
shared/domain/agent/
├── types.ts         ← Agent, AskRequest, AskResult, Source — pure
├── access.ts        ← CallerIdentity, AccessRequest, AccessDecision,
│                      AccessPolicy interface, IdentityResolver interface
└── ports.ts         ← AgentRepo, RagEngine

web/src/use-cases/agent/
├── ask-agent.ts     ★ orchestration (변하면 안 됨)
├── create-agent.ts
└── policies/
    ├── owner.ts          ← 오늘 구현
    ├── cap-holder.ts     ← 오늘 구현
    ├── compose.ts        ← firstAllow / allOf
    └── (내일/모레/...)
        ├── x402-payment.ts
        ├── subscription.ts
        ├── public.ts          // 항상 allow (free agent)
        └── referral.ts

web/src/adapters/http/middleware/
├── identify-caller.ts    ← composite IdentityResolver
└── (각 인증 방식의 resolver — session, cap, x402)
```

---

## ★ 핵심 흐름 — `askAgent` use-case (한 번 짜고 절대 안 건드림)

```ts
async function askAgent(deps: AskAgentDeps, input: AskAgentInput): Promise<AskAgentOutput> {
  const agent = await deps.agents.byId(input.agentId);
  if (!agent) return { kind: "denied", reason: "agent_not_found" };
  if (agent.indexStatus !== "ready") return { kind: "indexing", progress: agent.indexProgress };

  const caller = await deps.identityResolver.resolve(input.req);
  const decision = await deps.accessPolicy.decide({ agent, caller, request: input.askRequest });

  switch (decision.kind) {
    case "allow":           return { kind: "ok", result: await deps.rag.query(agent, input.askRequest) };
    case "deny":            return { kind: "denied", reason: decision.reason };
    case "require-payment": return { kind: "payment-required", requirement: decision.requirement };
    case "rate-limited":    return { kind: "rate-limited", retryAfterMs: decision.retryAfterMs };
  }
}
```

이게 전부. 정책이 어떻든, 신원이 어떻든, askAgent는 안 바뀜.

---

## 새 access 종류를 추가할 때 (3 단계)

가령 *"내일부터 subscription 가입자도 무제한 사용"*이 추가된다고 하자.

### 1단계 — `CallerIdentity`에 변종 추가
```ts
// shared/domain/agent/access.ts
export type CallerIdentity =
  | { kind: "anonymous" }
  | { kind: "session-user"; userId: string }
  | { kind: "cap-bearer"; recipientHex: string; pathPrefix: string; expiresAt: number }
  | { kind: "x402-payer"; payerAddress: string; paidUsdc: number; nonce: string }
  | { kind: "subscriber"; userId: string; tier: "basic" | "pro" };  // ← 추가
```

### 2단계 — IdentityResolver 추가
```ts
// web/src/adapters/http/middleware/subscription-resolver.ts
export const subscriptionResolver: IdentityResolver = {
  async resolve(req) {
    const sub = await querySubscriptionDB(req.headers.get("x-subscription-token"));
    if (!sub?.active) return { kind: "anonymous" };
    return { kind: "subscriber", userId: sub.userId, tier: sub.tier };
  }
};
```

### 3단계 — Policy 추가 + composer에 등록
```ts
// web/src/use-cases/agent/policies/subscription.ts
export const subscriptionPolicy: AccessPolicy = {
  name: "subscription",
  async decide({ caller }) {
    if (caller.kind === "subscriber") return { kind: "allow", reason: `subscriber:${caller.tier}` };
    return { kind: "deny", reason: "not_subscriber" };
  }
};

// web/src/composition.ts (한 줄 추가)
const policy = firstAllow([
  ownerPolicy,
  capHolderPolicy,
  x402PaymentPolicy,
  subscriptionPolicy,  // ← 추가
]);
```

**askAgent.ts, agent types, RAG engine — 0줄 변경.**

---

## 정책 조합 패턴

3가지로 충분:

```ts
// 첫 allow가 이김 — 가장 흔함
firstAllow([ownerPolicy, capHolderPolicy, x402PaymentPolicy])
//   ㄴ owner면 통과, 아니면 cap 검사, 아니면 x402 결제 요구

// 모두 allow 필요 — 드물지만 (예: 결제+지역제한)
allOf([x402PaymentPolicy, regionPolicy])

// 첫 deny가 이김 — 보안 강화 (예: blocklist + 정상 정책)
firstDenyElseAllow([blocklistPolicy, ownerPolicy, ...])
```

---

## 안 하는 것 (오늘 범위)

- ❌ `AccessPolicy` 외부 동적 로딩 (DB에 저장된 정책 JSON 해석) — YAGNI. 코드에서 구성.
- ❌ 정책별 우선순위 weight — firstAllow 충분.
- ❌ Policy 결과 캐싱 — DB I/O 적음. 도입 시 별도 layer.
- ❌ Policy 자체의 권한 (메타-권한) — 정책 추가는 코드 PR로만 가능 (보안).

---

## 안티패턴 — 미래의 나에게

❌ `if (caller.kind === "cap-bearer") {...} else if (caller.kind === "x402-payer") {...}` 가 use-case 안에 있다
   → 새 변종 추가할 때마다 use-case 수정. 정책 격리 위반.
   → ✅ policy.decide() 한 줄로 위임.

❌ Policy가 DB·HTTP 직접 호출
   → 테스트 어려워짐. policy는 pure하거나 의존성 주입 받음.
   → ✅ Policy의 deps도 ports로.

❌ "임시" 정책을 ask-agent.ts에 inline
   → 두 번이 되고 곧 다섯 번 됨.
   → ✅ 무조건 policies/<name>.ts 새 파일.

---

## 측정 가능한 acceptance

- [ ] 새 access 종류 추가가 **askAgent.ts 1줄 변경 없이** 가능 (위 3단계만)
- [ ] 모든 policy는 단위 테스트 가능 (mock caller + mock agent → AccessDecision)
- [ ] askAgent 단위 테스트 가능 (mock policy / mock rag / mock repo)
- [ ] HTTP route는 askAgent 호출 + AccessDecision → status 변환만 (10줄 이내)

---

## 첫 마일스톤 (오늘)

1. `shared/domain/agent/{types,access,ports}.ts` 작성 (이 문서와 동기화)
2. `policies/owner.ts`, `policies/cap-holder.ts`, `policies/compose.ts` 구현
3. `web/src/use-cases/agent/ask-agent.ts` 작성 (위 ★ 흐름 그대로)
4. `web/src/adapters/http/routes/agents/[id]/ask/route.ts` 얇은 변환 라우트
5. `web/src/composition.ts` 에 wire
6. 단위 테스트: 각 policy 3-4개 케이스 + askAgent 4-way 분기

x402 / subscription 등은 *내일 이후*. 오늘은 owner + cap-holder만 살아있으면 됨.

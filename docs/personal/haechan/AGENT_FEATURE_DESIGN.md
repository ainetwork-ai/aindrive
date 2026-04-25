# Agent Feature — Design (해찬 작업)

> **문제**: owner가 폴더로 RAG 에이전트를 만든다. 그걸 *누가 쓸 수 있는지*, *지식을 어떻게 가져오는지*, *어떤 LLM을 쓰는지* — 이 셋 모두 시간이 지나면서 바뀐다. 코드의 **각 축마다 1군데씩**만 고치면 되어야 한다.

---

## 디자인 한 줄

> **세 개의 port로 변하는 축을 격리하고, `askAgent`는 그 셋을 합치기만 한다.**

| 변하는 축 | Port | v1 (오늘) | 가능한 v2 / v3 |
|---|---|---|---|
| 누가 쓸 수 있나? | `AccessPolicy` | owner + cap-holder | + x402 payer, subscriber, referral, public, … |
| 지식은 어디서 어떻게? | `KnowledgeBase` | `DumpAllText` (런타임에 .txt/.md 전부 덤프) | vector RAG, BM25, hybrid, 사전 인덱스, summarization … |
| LLM은 무엇? | `LlmClient` | OpenAI gpt-4o-mini | Anthropic, llama.cpp local, AI Gateway routing … |

세 축 모두 **동일한 패턴**: interface → 여러 impl → composition에서 wire. `askAgent`는 영원히 안 바뀜.

---

## v1 데모 시나리오 (최소 스펙)

1. owner: 웹 UI에서 [Create Agent] 클릭 → DB에 row 추가. **인덱싱 없음**, 즉시 ready.
2. 권한 있는 caller가 질문 전송 (이번 시연에선 drive cap 보유자).
3. AccessPolicy 통과 → KnowledgeBase가 폴더의 .txt/.md를 전부 덤프 → system prompt에 박아서 LlmClient 호출 → 답변 + 출처(파일 목록) 반환.

이게 작동하면 끝. 인덱싱·결제·다양한 정책은 나중에.

---

## ★ 변하지 않는 흐름 — `askAgent`

```ts
async function askAgent(deps, input) {
  const agent = await deps.agents.byId(input.agentId);
  if (!agent) return { kind: "denied", reason: "agent_not_found" };

  const caller = await deps.identityResolver.resolve(input.http);
  const decision = await deps.accessPolicy.decide({ agent, caller, request: input.askRequest });
  if (decision.kind !== "allow") return mapDenyShape(decision);

  const chunks = await deps.knowledgeBase.fetch({ agent, query: input.askRequest.q });
  const answer = await deps.llm.complete({
    system: buildSystemPrompt(chunks, agent.name),
    user: input.askRequest.q,
  });
  return { kind: "ok", result: { answer, sources: chunks.map(toSource) }, policyName };
}
```

이 함수는 *어떤 정책*도, *어떤 retrieval 전략*도, *어떤 모델*도 이름으로 언급하지 않는다.

---

## 새 axis 변경을 추가할 때 — 3 단계 (각 port 동일)

### Access 새 종류 (예: subscription)
1. `CallerIdentity`에 `{ kind: "subscriber"; ... }` 추가
2. `subscription-resolver.ts` (`IdentityResolver` 구현) 추가
3. `policies/subscription.ts` 추가 + composition의 `firstAllow([...])` 한 줄에 끼움

### KnowledgeBase 고도화 (예: vector RAG)
1. `web/src/infra/knowledge/vector-rag-kb.ts` 추가 (`KnowledgeBase` 구현)
2. composition에서 `knowledgeBase: vectorRagKb` 한 줄 교체
   (또는 agent별로 다른 KB를 쓰고 싶으면 `KnowledgeBaseSelector` 한 단계 더)

### LLM 교체 (예: Anthropic)
1. `web/src/infra/llm/anthropic-client.ts` 추가 (`LlmClient` 구현)
2. composition에서 `llm: anthropicClient` 한 줄 교체

---

## 코드 구조

```
shared/domain/agent/
├── types.ts         Agent (slim), AskRequest, AskResult, Source — pure
├── access.ts        CallerIdentity, AccessDecision, AccessPolicy, IdentityResolver
└── ports.ts         AgentRepo, KnowledgeBase, KnowledgeChunk, LlmClient, FsBrowser

web/src/use-cases/agent/
├── ask-agent.ts     ★ 흐름 (port만 호출)
├── create-agent.ts  owner-only 등록
└── policies/
    ├── owner.ts          (v1) session-user 정확히 owner면 allow
    ├── cap-holder.ts     (v1) 검증된 cap이 폴더 커버하면 allow
    ├── compose.ts        firstAllow / allOf / firstDenyElse
    └── (미래)
        ├── x402-payment.ts
        ├── subscription.ts
        ├── public.ts
        └── referral.ts

web/src/infra/
├── db/sqlite-agent-repo.ts          (v1) AgentRepo SQLite
├── knowledge/dump-all-text-kb.ts    (v1) KnowledgeBase: 폴더 walk + .txt/.md 덤프
├── knowledge/(future) vector-rag-kb.ts, hybrid-kb.ts
├── llm/openai-client.ts             (v1) LlmClient: OpenAI gpt-4o-mini
├── llm/(future) anthropic-client.ts, local-llama-client.ts
├── fs/rpc-fs-browser.ts             FsBrowser: 기존 sendRpc 래퍼
└── http/identity/(session|cap)-resolver.ts

web/src/composition.ts
└── compose.askAgent = { agents, identityResolver, accessPolicy, knowledgeBase, llm }
```

---

## v1 KnowledgeBase 구체 (`DumpAllTextKb`)

```ts
export const dumpAllTextKb: KnowledgeBase = {
  async fetch({ agent }) {
    const TEXT_EXTS = new Set(["txt", "md", "markdown", "log"]);
    const out: KnowledgeChunk[] = [];
    async function walk(p: string) {
      const entries = await fsBrowser.list(agent.driveId, p);
      for (const e of entries) {
        if (e.isDir) await walk(e.path);
        else if (TEXT_EXTS.has(e.ext)) {
          const text = await fsBrowser.read(agent.driveId, e.path, 64 * 1024);
          out.push({ path: e.path, text });
        }
      }
    }
    await walk(agent.folder);
    return out;
  }
};
```

쿼리를 무시한다 (relevance scoring 없음). 데모 폴더는 5–10 파일이라 LLM context window에 다 들어감. 50 파일 넘어가면 `VectorRagKb`로 교체 권장.

---

## v1 LlmClient 구체 (`OpenAIClient`)

```ts
export const openaiClient: LlmClient = {
  async complete({ system, user, maxTokens = 400 }) {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens,
    });
    return r.choices[0]?.message?.content ?? "";
  }
};
```

---

## 측정 가능한 acceptance

- [ ] `askAgent.ts`가 OpenAI / Anthropic / "RAG" / "vector" 같은 단어를 안 가짐
- [ ] KnowledgeBase 새 impl 추가가 `askAgent.ts` 0줄 변경
- [ ] LlmClient 새 impl 추가가 `askAgent.ts` 0줄 변경
- [ ] AccessPolicy 새 종류 추가가 `askAgent.ts` 0줄 변경
- [ ] tsc --noEmit clean
- [ ] 데모 폴더(sample/) 5–10 파일에 대해 1초 내 답변

---

## 안 하는 것 (v1 범위 밖)

- ❌ 사전 인덱싱 / `indexStatus`
- ❌ 결제 / `pricePerCallUsdc`
- ❌ Vector store / 임베딩
- ❌ Streaming response
- ❌ Multi-turn 대화 (질문-답 1쌍만)
- ❌ Rate limiting (policy에 자리는 있으나 impl 없음)

추가는 모두 *port impl 한 개 추가 + composition 한 줄*로 가능.

---

## 안티패턴 (미래의 나에게)

❌ `if (caller.kind === "cap-bearer") { ... } else if (...) {` 가 askAgent 안에
   → policy.decide()로.

❌ `if (folder size > 100 files) { use vector } else { dump all }` 가 askAgent 안에
   → KnowledgeBase impl 안에 캡슐화. askAgent는 모름.

❌ `openai.chat.completions.create()` 가 use-case 안에
   → LlmClient.complete()로.

❌ KnowledgeBase impl이 LlmClient를 직접 import (예: query rewriting을 위해)
   → ports.ts에 의존성 추가하거나, KnowledgeBase factory에 LlmClient 주입.

❌ "이번만" KnowledgeBase 안 거치고 askAgent에서 직접 fs.read
   → 한 번이 되면 다섯 번 됨. 무조건 port 통해.

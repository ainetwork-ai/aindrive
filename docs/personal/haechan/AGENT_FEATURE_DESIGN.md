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

## Per-agent config — 각 axis는 agent 자체에 박힘

owner마다·agent마다 *다른 모델·다른 retrieval 전략·다른 정책 조합*을 쓸 수 있어야 한다. agent JSON에 `llm/knowledge/access` 섹션을 두고, 런타임에 factory가 그 키로 구체 impl을 골라낸다.

### 보안 모델: in-drive config + `.aindrive/` 차단 룰

agent JSON 전체(`llm.apiKey` 포함)가 `<drive>/.aindrive/agents/<id>.json`에 산다. cap-holder가 이 파일을 직접 읽지 못하게 막는 게 핵심:

| 누가 | `.aindrive/` 접근 | 어디서 enforce |
|---|---|---|
| Owner (session-user, ownerId 매치) | ✓ 모든 fs/* RPC 가능 | 서버 미들웨어가 owner 패스 |
| cap-bearer | ✗ fs/list, fs/read, fs/write 모두 거부 | `shared/domain/policy/system-paths.ts#isSystemPath` 체크 |
| Server-internal (FsAgentRepo, etc.) | ✓ cap 미들웨어 통과 안 함 | 직접 sendRpc 사용 |

**단일 실패점**: 이 룰 우회 = key 유출. → 단위 테스트 필수 (`isSystemPath` 4–5 케이스).

추가로 공개 endpoint (예: `/.well-known/agent-card`)은 *항상 projection*해서 응답:
```ts
function toPublicAgentCard(agent: Agent): AindriveAgentCard {
  return {
    name: agent.name,
    description: agent.description,
    skills: [...],
    securitySchemes: { ... },
    // llm.apiKey, ownerId, namespacePub 등은 절대 포함 안 함
  };
}
```

### Trade-off (정직)

- ❌ Drive 백업·export·rsync 시 key가 함께 따라간다 — owner 책임 (`.env`처럼)
- ❌ 다른 서버로 drive 옮겨도 key는 동일 (단점: 키 회수 안 됨 / 장점: drive가 self-contained)
- ✓ DB 0개, server-side secrets file 0개
- ✓ agent = 자기가 자기 모든 걸 들고 있는 단일 엔티티
- ✓ 미래에 KMS / Vault로 옮기고 싶으면 `LlmConfig.apiKey`를 `keyRef`로 바꾸고 LlmClientFactory만 교체

### Agent JSON 예시 (full v1)
```json
{
  "id": "agt_8f2a1c",
  "driveId": "drv_xxx",
  "ownerId": "usr_yyy",
  "folder": "docs",
  "name": "OKR 봇",
  "description": "Q1 OKR 묻는 봇",
  "namespacePub": "<base64url>",
  "knowledge": { "strategy": "dump-all-text" },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "temperature": 0.2,
    "maxTokens": 400
  },
  "access": { "policies": ["owner", "cap-holder"] },
  "createdAt": 1745000000000
}
```

### 새 ports — Factory 패턴

```ts
interface LlmClientFactory     { make(cfg: LlmConfig): Promise<LlmClient>; }
interface KnowledgeBaseFactory { make(cfg: KnowledgeConfig): KnowledgeBase; }
interface AccessPolicyFactory  { make(cfg: AccessConfig): AccessPolicy; }
```

### v1 LlmClientFactory impl
```ts
export const v1LlmFactory: LlmClientFactory = {
  async make(config) {
    const apiKey =
      config.apiKey
      ?? process.env[`${config.provider.toUpperCase()}_API_KEY`];
    if (!apiKey) throw new Error(`no_api_key:${config.provider}`);

    switch (config.provider) {
      case "openai":   return makeOpenAi({ apiKey, model: config.model, temp: config.temperature });
      // 미래: case "anthropic": return makeAnthropic(...)
      default: throw new Error(`unknown_provider:${config.provider}`);
    }
  }
};
```

### Create Agent UI (제안)

```
Name              [OKR 봇                                    ]
Description       [Q1 OKR 묻는 봇                          ]
Folder            [docs/                                     ]

── Knowledge ─────────────────────────────────────────────────
Strategy          [Dump all text                ▾]
                   (Coming: Vector RAG, Hybrid, …)

── LLM ───────────────────────────────────────────────────────
Provider          [OpenAI                       ▾]
Model             [gpt-4o-mini                  ▾]
Temperature       [────●──────────────────────] 0.2
API Key           [                                          ]
                   비워두면 플랫폼 기본 키 사용. 입력 시 server에
                   owner 전용으로 암호화 저장. drive엔 안 들어감.

── Access ────────────────────────────────────────────────────
☑ Owner (always allowed)
☑ Drive cap holders
☐ x402 payers (coming soon)

                                       [Cancel]    [Create]
```

UI 자체가 3 port를 그대로 비춰줌. 새 옵션 = 드롭다운에 entry 추가 + factory 등록.

---

## v1 데모 시나리오 (최소 스펙, 확정)

> **포함**: 웹 UI 안에서 owner가 agent 만들고, drive 권한자(session-user 또는 cap holder)가 사이드바 채팅으로 사용. A2A agent card도 publish.
>
> **불포함**: 외부 다른 agent가 우리 agent를 호출 (cross-agent 인증 복잡도 too high). 결제 (x402). 사전 인덱싱.

### 컷 1 (15s) — Owner가 agent 만든다
- 웹 UI에서 폴더 우클릭 → [Create Agent] → 모달 (provider/model/api key 입력 옵션)
- [Create] → `<drive>/.aindrive/agents/agt_xxx.json` 생성, 즉시 ready

### 컷 2 (30s) — Owner가 사이드바에서 직접 물어본다
- Drive shell의 우측 사이드바 채팅창
- 질문 → 답변 + 출처 카드 (`(see docs/q1-okr.md)`)
- "owner는 항상 자기 폴더에 접근 가능" 어필

### 컷 3 (45s, ★ 핵심) — 권한 있는 다른 사람이 사이드바에서 물어본다
- 다른 브라우저(시크릿창) — drive cap holder
- 미리 받은 share 링크로 들어옴 → cap 쿠키 보유
- 같은 drive, 같은 사이드바 채팅창 → 같은 agent에 질문 → 답변
- "owner가 agent 한 번 만들면, drive 권한자 누구나 별도 추가 작업 0으로 사용"

### 컷 4 (10s) — 같은 agent가 이미 A2A 표준으로 노출되고 있음
- 새 탭에서 `GET /.well-known/agent-card/<driveId>/<agentId>.json`
- A2A v1 spec 준수 JSON (name, description, skills, securitySchemes) 표시
- "외부 agent도 이걸 발견할 수 있고, 인증만 통과하면 호출 가능 — 발표일엔 인증 흐름 시연은 생략 (cross-agent 인증은 별도 마일스톤)"

총 ~100초.

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

## 저장: file-based, no DB

agent 메타데이터는 **drive 안에 JSON 파일로** 둔다. SQLite/Postgres 마이그레이션 없음.

```
<drive>/.aindrive/agents/<agentId>.json
```

### 파일 한 개 예시
```json
{
  "id": "agt_8f2a1c",
  "driveId": "drv_xxx",
  "ownerId": "usr_yyy",
  "folder": "docs",
  "name": "OKR Bot",
  "description": "Q1 OKR 문서 위에서 답하는 에이전트",
  "namespacePub": "<base64url 32 bytes>",
  "createdAt": 1745000000000
}
```

### 왜 이게 좋은가
- DB 스키마/마이그레이션 X — 신규 트랙이 `agents` 테이블 추가할 필요 없음
- agent가 drive와 함께 이동·공유됨 — 폴더 export·복사 시 메타도 따라감
- cap 권한 자연스럽게 적용 — `.aindrive/agents/` 도 drive 안이라 cap이 커버
- 미래에 Willow 동기화하면 agent 정의도 자동 sync (별도 동기화 코드 불필요)

### 호환성 메모
- CLI의 `cli/src/rpc.js` 의 `HIDDEN`은 *parent를 list할 때*만 `.aindrive`를 숨김.
  `list/.aindrive/agents` 직접 호출은 정상 동작.
- `write` RPC는 `mkdir -p`를 자동으로 함 (`fsp.mkdir(path.dirname(abs), {recursive: true})`).
  첫 agent 생성 시 `.aindrive/agents/` 디렉토리 자동 생성.
- v1엔 lock 없음 — owner 1명이 만드므로 race 없음. 나중에 멀티-device sync 시 별도 처리.

### `FsAgentRepo` (v1 impl)
```ts
// web/src/infra/agent-repo/fs-agent-repo.ts
const AGENT_DIR = ".aindrive/agents";

export const fsAgentRepo = (fs: FsBrowser): AgentRepo => ({
  async byId(driveId, id) {
    try {
      const json = await fs.read(driveId, `${AGENT_DIR}/${id}.json`);
      return deserializeAgent(JSON.parse(json));
    } catch (e) { return null; } // ENOENT → null
  },
  async listByDrive(driveId) {
    const entries = await fs.list(driveId, AGENT_DIR).catch(() => []);
    return Promise.all(
      entries.filter(e => !e.isDir && e.path.endsWith(".json"))
        .map(e => fs.read(driveId, e.path).then(j => deserializeAgent(JSON.parse(j))))
    );
  },
  async create(input) {
    const id = `agt_${nanoid(8)}`;
    const agent = { ...input, id, createdAt: Date.now() };
    await fs.write(driveId, `${AGENT_DIR}/${id}.json`, JSON.stringify(serializeAgent(agent), null, 2));
    return agent;
  }
});

// namespacePub Uint8Array <-> base64url 직렬화 함수 따로
```

### HTTP 라우트는 `driveId`를 항상 URL에 가짐
```
POST   /api/drives/[driveId]/agents              create
GET    /api/drives/[driveId]/agents              list
POST   /api/drives/[driveId]/agents/[id]/ask     ★ 핵심
GET    /api/drives/[driveId]/agents/[id]/card    A2A agent card JSON
```

내일 well-known A2A discovery 추가 시: `/.well-known/agent-card?drive=X&id=Y` redirect.

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

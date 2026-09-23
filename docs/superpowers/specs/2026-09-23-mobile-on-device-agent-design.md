# Mobile on-device agent — design (2026-09-23)

> **목표**: 폰 앱(`mobile/`)에 초경량 에이전트를 넣어 *"프랑스 여행 갔던 사진 찾아줘"* 같은
> 자연어 요청으로 공유 폴더의 파일을 찾는다. 모델·인덱스·추론이 전부 폰 안에서 돌고,
> 서버는 지금처럼 서명된 RPC만 중계한다. 2026-09 기준 공개 모델·런타임으로 설계.

## 한 줄 설계

> **찾는 일은 임베딩 인덱스가 하고, LLM은 "질문을 검색으로 번역"만 한다.**

LLM이 사진을 직접 "보는" 구조는 폰에서 불가능하다(1만 장 × 비전 추론). 대신
사진은 인덱싱 때 한 번만 임베딩·메타데이터를 뽑아 두고, 질문 시점엔 sub-1B LLM이
`search_photos(place, date_from, date_to, text_query)` 같은 **툴 호출 하나**로 질문을
구조화한다. 그 결과 LLM은 아주 작아도 되고, 검색은 밀리초 단위다.

```
"프랑스 여행 갔던 사진 찾아줘"
        │
        ▼  (1) Planner — Qwen3.5-0.8B, function calling, ~300 tok 생성
search_photos({ place: "France", date_from: null, date_to: null, text_query: "travel photos" })
        │
        ▼  (2) Retriever — 순수 코드 (SQLite + 벡터 브루트포스)
   place 필터 ∩ 날짜 필터 → CLIP text 임베딩과 cosine 상위 N
        │
        ▼  (3) Answer — 결과 목록은 코드가 만들고, LLM은 한 줄 요약만 (선택)
 { answer: "2024년 5월 파리·니스에서 찍은 사진 37장을 찾았어요", sources: [{path, snippet}] }
```

## 모델 선택 (2026-09 기준)

| 역할 | 모델 | 크기 (양자화) | 근거 |
|---|---|---|---|
| **Planner LLM** (기본) | **Qwen3.5-0.8B** (2026-02, Apache 2.0) | Q4 ≈ 0.5 GB, 4 GB RAM 폰에서 15–25 tok/s | sub-1B 중 툴 호출을 정식 지원하는 유일한 계열. 한국어 포함 200+ 언어. LiteRT-LM 지원 목록(Qwen 0.6B–2.5B)에 있음. |
| **Planner LLM** (있으면) | **Gemma 4 E2B / Gemini Nano 4** via ML Kit GenAI Prompt API | 다운로드 0 (시스템 제공), 단 8 GB+ RAM·AICore 기기 | 2026-04 AICore 개발자 프리뷰. 품질↑, 배터리 60%↓. 기기가 지원하면 자동 승격. |
| **이미지·텍스트 임베딩** | **MobileCLIP2-S0** (Apple) | image 11.4M + text 63.4M ≈ 75M → int8 ≈ 80 MB | 사진 1장 임베딩 수 ms. 텍스트 인코더로 질문도 같은 공간에 넣어 "eiffel tower", "beach" 같은 내용 검색. ONNX·TFLite 변환본 공개. |
| **텍스트 파일 임베딩** (phase 2) | **EmbeddingGemma-300M** | 양자화 시 < 200 MB RAM | 문서·메모 검색용. phase 1에서는 제외. |
| **위치 → 지명** | 오프라인 GeoNames `cities15000` 테이블 | ≈ 2 MB | EXIF GPS → 국가/도시. 네트워크 없이 "프랑스" 매칭. 벡터 불필요. |

**왜 Gemma 4 E2B를 기본으로 안 쓰나**: Q4 ≈ 1.5 GB, 공식 요구 RAM 8 GB. "초경량"과
어긋난다. 대신 ML Kit 경로로 *기기에 이미 있으면* 쓰는 승격 옵션으로만 둔다.
**왜 SmolLM2-360M이 아닌가**: 툴 호출 신뢰성이 낮아 JSON 파싱 실패율이 높다. 0.8B가
sub-1B에서 툴 호출을 정식 지원하는 하한선이다.

## 런타임

| 구성 | 선택 | 대안 / 비고 |
|---|---|---|
| LLM 추론 | **LiteRT-LM** (Kotlin, `.litertlm`), CPU/GPU | 함수 호출 + constrained decoding 내장 → JSON 깨짐 방지. NPU는 아직 Windows 프리뷰만. llama.cpp(JNI)는 모델 폭이 넓지만 툴 호출은 직접 구현해야 함. |
| CLIP 추론 | **LiteRT** (tflite) 이미지·텍스트 인코더 2개 | ONNX Runtime Mobile도 가능. |
| EXIF | `androidx.exifinterface` | SAF `InputStream`으로 읽음. 사진 전체 디코드 없이 헤더만. |
| 인덱스 저장 | 앱 전용 SQLite (`filesDir/index/<driveId>.db`) | `yjs` 스냅샷과 같은 원칙: **사용자 폴더에 `.aindrive/`를 만들지 않는다.** |
| 벡터 검색 | 브루트포스 cosine (512-d fp16) | 1만 장 = 10 MB, < 50 ms. 10만 장 넘으면 그때 HNSW. |
| 모델 배포 | APK에 넣지 않고 첫 사용 시 다운로드 (SHA-256 검증) | APK는 지금처럼 ~5 MB 유지. 서버 CDN 또는 HF 미러. Wi-Fi일 때만 기본. |

## 인덱서 (백그라운드)

- `AgentService`가 온라인 상태일 때 idle 워커가 SAF 트리를 걷는다. 배터리·발열 때문에
  **충전 중 + Wi-Fi**를 기본 조건으로, 설정에서 완화 가능.
- 파일당 저장: `path, docId, mtimeMs, size, mime, takenAt(EXIF), lat/lon, country, city, clipVec(fp16[512])`.
- 증분: `(docId, mtimeMs)` 가 같으면 스킵. 삭제된 문서는 sweep 때 제거.
- 사진만 phase 1 (`image/*`). 동영상은 첫 프레임 1장으로 phase 2.
- 처리량 목표: 중급 폰에서 사진 1장 ≈ 30–60 ms (디코드+임베딩) → 1만 장 ≈ 5–10분.

## 툴 계약 (Planner ↔ Retriever)

LLM에 노출하는 함수는 **하나**다. 함수를 여럿 주면 0.8B 모델의 선택 오류가 급증한다.

```json
{
  "name": "search_files",
  "parameters": {
    "place":       "string | null  — 국가/도시명, 영문 정규화 (France, Paris)",
    "date_from":   "YYYY-MM-DD | null",
    "date_to":     "YYYY-MM-DD | null",
    "text_query":  "string | null  — 사진 내용을 영어로 (beach sunset, food, eiffel tower)",
    "kind":        "photo | video | document | any"
  }
}
```

- 상대 날짜("작년 여름")는 LLM이 아니라 **코드가** 오늘 날짜 기준으로 풀도록 프롬프트에
  `today`를 넣고, 결과는 절대 날짜로만 받는다.
- 결과 랭킹: place·date는 **하드 필터**, `text_query`는 cosine 정렬. 필터가 0건이면
  필터를 하나씩 풀며 "프랑스 사진은 없고, 대신 …" 식으로 답한다.
- 응답 형식은 데스크톱 `agent-ask`와 동일: `{ answer, sources: [{ path, snippet }] }`.
  사진은 `snippet` 대신 `takenAt · city, country`를 넣는다. 웹 UI는 그대로 재사용.

## 진입점 — 같은 RPC, 두 개의 입구

1. **웹에서**: 기존 `agent-ask` RPC를 그대로 받는다. 지금 `RpcHandler`가
   `agent_ask_unsupported_on_mobile`로 거부하는 자리를 이 러너로 교체. 웹 쪽 접근 정책·
   타임아웃(60 s)은 이미 있음 (`web/src/infra/agent-executor/rpc-agent-executor.ts`).
2. **앱 안에서**: 셸에 검색창 하나. 같은 러너를 플러그인 메서드 `ask(query)`로 호출.
   서버·네트워크 없이 완전 오프라인으로 동작한다 — 이게 폰 에이전트의 존재 이유.

데스크톱 에이전트의 `agent.json`(`knowledge / llm / access`) 형식은 유지하되, 모바일은
`llm.provider = "on-device"`, `knowledge.strategy = "photo-index"` 하나만 지원한다.
API 키를 폰에 두지 않는다는 원칙은 그대로.

## 기기 요구·폴백

| 기기 | 동작 |
|---|---|
| RAM ≥ 4 GB, arm64 | Qwen3.5-0.8B + MobileCLIP2-S0 (기본) |
| AICore + Gemini Nano 4 지원 (12 GB, 플래그십) | Planner를 ML Kit로 승격, CLIP은 동일 |
| RAM < 4 GB 또는 모델 미다운로드 | **LLM 없이** 동작: 질문을 CLIP 텍스트 인코더에만 넣고, 지명·날짜는 정규식(국가명 사전)으로 추출. 품질은 떨어지지만 검색은 된다. |
| iOS | 같은 설계, 런타임만 Core ML(MobileCLIP2는 Apple이 Core ML 아티팩트 제공) + LiteRT-LM iOS. 백그라운드 인덱싱은 앱이 열려 있을 때만 (README의 플랫폼 한계). |

## 크기·성능 예산 (목표)

| 항목 | 예산 |
|---|---|
| 추가 다운로드 | ≈ 600 MB (LLM 0.5 GB + CLIP 80 MB + 지오 2 MB) |
| 질문 → 답 | < 3 s (Planner ≈ 1.5–2 s, 검색 < 50 ms) |
| 인덱스 디스크 | 사진 1장 ≈ 1.2 KB |
| 유휴 시 메모리 | 0 (모델은 질문 시 로드, 30 s 후 언로드) |

## 단계

1. **P1 — 사진 검색**: 인덱서(EXIF+GPS+CLIP) → 앱 내 검색창 → `agent-ask` 연결. LLM 없이 먼저 출시 가능한 폴백 경로부터.
2. **P2 — Planner**: LiteRT-LM + Qwen3.5-0.8B 함수 호출. 모델 다운로드 UI. ML Kit 승격.
3. **P3 — 문서**: EmbeddingGemma로 텍스트 파일, 동영상 첫 프레임.

## 열린 질문

- 모델 파일 호스팅: 우리 CDN(버전 고정, 가용성 우리 책임) vs HF 직링크(무료, 변경 위험). → CDN 권장.
- 인덱싱을 "공유 켜기" 기본 동작에 포함할지, 별도 opt-in 토글로 둘지. 배터리·프라이버시 관점에서 **opt-in** 권장.
- 웹에서 폰 에이전트에게 물을 때 60 s 타임아웃 안에 콜드 스타트(모델 로드 ≈ 3–5 s)가 들어가는지 확인 필요.

## Sources

- [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4) — E2B 5.1B/2.3B effective, 128K ctx, Apache 2.0
- [Gemma 4 on Android (Android Developers Blog, 2026-04)](https://android-developers.googleblog.com/2026/04/gemma-4-new-standard-for-local-agentic-intelligence.html) — ML Kit GenAI Prompt API, AICore preview
- [Gemma 4 RAM requirements](https://www.gemma4.wiki/requirements/gemma-4-ram-requirements) — E2B 8 GB RAM / 2 GB storage
- [Qwen3.5-0.8B model card](https://huggingface.co/Qwen/Qwen3.5-0.8B) — 2026-02, tool calling, 262K ctx, Apache 2.0
- [Qwen 3.5 small models (MarkTechPost, 2026-03)](https://www.marktechpost.com/2026/03/02/alibaba-just-released-qwen-3-5-small-models-a-family-of-0-8b-to-9b-parameters-built-for-on-device-applications/)
- [Run Qwen 3.5 on Android](https://dev.to/alichherawalla/how-to-run-qwen-35-on-your-android-phone-in-2026-locally-no-cloud-58pi) — 0.8B Q4 ≈ 500 MB, 15–25 tok/s
- [LiteRT-LM overview](https://developers.google.com/edge/litert-lm/overview) — Kotlin API, `.litertlm`, function calling w/ constrained decoding, Qwen 0.6B–2.5B
- [MobileCLIP2 variants](https://fastvlm.net/mobileclip2) — S0 image 11.4M / text 63.4M, 71.5% IN top-1
- [MobileCLIP (Apple ML Research)](https://machinelearning.apple.com/research/mobileclip) — 3–15 ms latency
- [mobileclip2-onnx](https://huggingface.co/plhery/mobileclip2-onnx), [mobileclip2_tflite](https://huggingface.co/anton96vice/mobileclip2_tflite)
- [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) — 308M, < 200 MB RAM
- [Google AI Edge on-device SLMs](https://developers.googleblog.com/google-ai-edge-small-language-models-multimodality-rag-function-calling/)

# Mobile Agent P1 — Photo Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 폰 앱이 공유 폴더의 사진을 오프라인으로 인덱싱(EXIF·GPS·CLIP 임베딩)하고, "프랑스 여행 사진 찾아줘" 같은 질문에 **LLM 없이** 파일 목록으로 답한다. 같은 러너가 앱 내 검색창과 웹의 `agent-ask` RPC 양쪽에 응답한다. LLM Planner는 P2.

**Architecture:** `AgentService` idle 워커가 SAF 트리를 걸으며 사진마다 `PhotoIndex`(앱 전용 SQLite)에 `takenAt / lat,lon / country,city / clipVec(fp16[512])`를 쓴다. 질문은 `QueryParser`(지명 사전 + 날짜 표현 정규식)가 `SearchQuery{place, dateFrom, dateTo, textQuery}`로 바꾸고, `Retriever`가 하드 필터 후 CLIP 텍스트 임베딩과 cosine 정렬한다. 응답은 데스크톱 `agent-ask`와 같은 `{answer, sources[{path, snippet}]}`. Spec: `docs/superpowers/specs/2026-09-23-mobile-on-device-agent-design.md`.

**Tech Stack:** Java (기존 `mobile/android` 스타일 유지), `androidx.exifinterface`, LiteRT (`com.google.ai.edge.litert:litert`) + MobileCLIP2-S0 tflite ×2, SQLite (`android.database.sqlite`), OkHttp(모델 다운로드), 번들 자산 `geonames-cities15000.tsv`(≈2 MB). Capacitor 플러그인 메서드 `ask` / `indexStatus` / `setIndexing`. 셸은 `mobile/src/main.ts` 카드 추가.

**Non-goals (P1):** LLM, 동영상, 텍스트 문서, iOS 구현(설계만 공유), 웹 UI 변경.

---

### Task 0: 결정 사항 고정 (코드 전 30분)

- [ ] MobileCLIP2-S0 tflite 아티팩트 확정: `anton96vice/mobileclip2_tflite`에 S0 image/text 인코더가 있는지 확인, 없으면 `plhery/mobileclip2-onnx`의 S0를 `onnx2tf`로 변환해 우리 CDN에 올린다. 입력 해상도(256), 출력 차원(512), 텍스트 토크나이저(CLIP BPE, `vocab.json`+`merges.txt`) 파일 목록과 SHA-256을 `mobile/android/app/src/main/assets/models.json`에 기록.
- [ ] 모델 호스팅 URL 결정(스펙 열린 질문 → CDN 권장). `models.json`은 `{ id, url, sha256, bytes }` 배열.
- [ ] Commit `chore(mobile): pin CLIP model manifest`

### Task 1: PhotoIndex — SQLite 저장소

**Files:** Create `mobile/android/app/src/main/java/ai/ainetwork/aindrive/index/PhotoIndex.java`

- [ ] `SQLiteOpenHelper`, DB 경로 `filesDir/index/<sanitizedDriveId>.db` (yjs와 같은 규칙: 사용자 폴더에 아무것도 안 만든다).
- [ ] 스키마:

```sql
CREATE TABLE photos (
  doc_id   TEXT PRIMARY KEY,   -- SAF document id (rename에도 안정)
  path     TEXT NOT NULL,      -- 드라이브 상대경로, 표시·응답용
  mtime_ms INTEGER NOT NULL,
  size     INTEGER NOT NULL,
  taken_at INTEGER,            -- epoch ms, EXIF DateTimeOriginal → 없으면 mtime
  lat REAL, lon REAL,
  country  TEXT,               -- ISO 3166-1 alpha-2 (FR)
  city     TEXT,               -- geonames name (Paris)
  vec      BLOB                -- fp16[512] little-endian, L2-normalized
);
CREATE INDEX photos_taken ON photos(taken_at);
CREATE INDEX photos_country ON photos(country);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);   -- indexer cursor, model id, schema ver
```

- [ ] API: `upsert(PhotoRow)`, `needsIndex(docId, mtimeMs) → boolean`, `deleteMissing(Set<String> liveDocIds)`, `count()`, `scan(Filter, Consumer<PhotoRow>)` (필터: country/city/dateFrom/dateTo — vec 포함 전체 행을 순회, 랭킹은 호출자).
- [ ] `Fp16.encode(float[]) / decode(byte[])` 유틸 + JVM 단위 테스트(왕복 오차 < 1e-3).
- [ ] Commit `feat(mobile): PhotoIndex sqlite store + fp16 vector codec`

### Task 2: EXIF + 오프라인 역지오코딩

**Files:** Create `index/ExifMeta.java`, `index/GeoLookup.java`; Add asset `assets/geo/cities15000.tsv`; Modify `app/build.gradle` (`androidx.exifinterface:exifinterface:1.3.7`)

- [ ] `ExifMeta.read(InputStream) → {takenAtMs|null, lat|null, lon|null}`: `ExifInterface`로 `DateTimeOriginal`(+`OffsetTimeOriginal`) 파싱, `getLatLong()`. 헤더만 읽고 전체 디코드 없음.
- [ ] `cities15000.tsv` 컬럼: `name \t country \t lat \t lon \t population` (GeoNames CC-BY 4.0, 라이선스 노트 파일 동봉). 빌드 시 gzip 유지(`aaptOptions noCompress` 예외 불필요 — 우리가 직접 gzip 풀어 읽음).
- [ ] `GeoLookup.nearest(lat, lon) → {country, city}`: 로드 시 1°×1° 그리드 버킷, 주변 9버킷에서 haversine 최소. 인구 가중은 안 함(가장 가까운 도시가 정답). 콜드 로드 < 200 ms, 조회 < 1 ms.
- [ ] `GeoNames` 별칭 사전 `assets/geo/countries.tsv`: `iso \t en \t ko \t aliases…` (France / 프랑스 / 불란서). Task 5의 파서가 사용.
- [ ] JVM 테스트: 파리 좌표 → FR/Paris, 제주 좌표 → KR/Jeju, 대양 한가운데 → null.
- [ ] Commit `feat(mobile): EXIF time/GPS + offline GeoNames reverse geocode`

### Task 3: CLIP 임베더 + 모델 다운로더

**Files:** Create `index/ClipEmbedder.java`, `index/ClipTokenizer.java`, `index/ModelStore.java`; Modify `app/build.gradle` (`com.google.ai.edge.litert:litert:1.x`, `litert-gpu` 선택)

- [ ] `ModelStore`: `models.json` 매니페스트 → `filesDir/models/<id>/…`. `ensure(id, progress)`는 이미 있고 SHA-256 일치하면 즉시 반환, 아니면 OkHttp로 임시 파일에 받아 검증 후 원자 rename. Wi-Fi 아닐 때는 `NEEDS_WIFI`로 거부(설정에서 해제 가능).
- [ ] `ClipTokenizer`: CLIP BPE (`vocab.json`, `merges.txt`), 소문자화, 77 토큰 패딩. 포팅 대상은 open_clip `SimpleTokenizer` — 결과가 같아야 한다.
- [ ] `ClipEmbedder`: 두 `Interpreter`(image, text). `embedImage(Bitmap) → float[512]`(중앙 크롭 256, CLIP mean/std 정규화, L2 normalize), `embedText(String) → float[512]`. 이미지 디코드는 `BitmapFactory.Options.inSampleSize`로 긴 변 ≤ 512까지만 읽어 메모리·시간 절약. GPU delegate는 가능할 때만, 실패 시 CPU 4스레드로 폴백.
- [ ] 계측 테스트(기기): 동일 사진에 대해 ONNX 레퍼런스 임베딩과 cosine > 0.99. 텍스트 "a photo of the Eiffel Tower" vs 에펠탑 사진이 vs 해변 사진보다 높은지 assert.
- [ ] Commit `feat(mobile): MobileCLIP2-S0 embedder + verified model download`

### Task 4: Indexer 워커

**Files:** Create `index/Indexer.java`; Modify `AgentService.java`, `SafFs.java`

- [ ] `SafFs.walk(Consumer<Entry>)`: 트리 전체를 DFS(HIDDEN 제외, `image/*`만 콜백). 기존 `list`를 재사용하되 디렉토리당 1 쿼리.
- [ ] `Indexer.runOnce(fs, index, embedder, geo, cancelToken)`: walk → `needsIndex`면 `ExifMeta` + `GeoLookup` + `embedImage` → `upsert`; 마지막에 `deleteMissing`. 100장마다 `meta.cursor` 갱신, 진행률 콜백 `{done, total, phase}`. 예외는 파일 단위로 삼키고 카운트(한 장 깨져도 전체 중단 X).
- [ ] 스케줄: `AgentService`가 연결된 뒤 그리고 매 6시간, **충전 중(`BatteryManager`) + Wi-Fi(`ConnectivityManager`)**일 때만 시작. 조건이 깨지면 `cancelToken`으로 중단, 다음 조건 충족 시 커서부터 재개. 사용자 토글 `indexing=false`면 아예 안 돈다(기본값 **off**, opt-in — 스펙 결정).
- [ ] 알림 텍스트에 "Indexing photos 1,230 / 8,400" 표시(기존 `notifyStatus` 재사용).
- [ ] Commit `feat(mobile): background photo indexer (charging + wifi, incremental)`

### Task 5: QueryParser + Retriever (LLM 없는 경로)

**Files:** Create `agent/SearchQuery.java`, `agent/QueryParser.java`, `agent/Retriever.java`

- [ ] `SearchQuery { String country, city, textQuery; Long dateFrom, dateTo; }`
- [ ] `QueryParser.parse(String q, LocalDate today)`:
  - 지명: `countries.tsv`(ko/en/alias) + `cities15000` 상위 5k 도시명(ko 표기는 별도 소사전 `cities-ko.tsv`: 파리/런던/도쿄/뉴욕 등 200개). 가장 긴 매치 우선. 도시 매치 시 country도 채움.
  - 날짜: `YYYY년`, `M월`, `작년|올해|재작년`, `봄|여름|가을|겨울`, `지난주|이번달`, `2024-05` 를 `[dateFrom, dateTo]`로. 영어 동등 표현 포함.
  - 잔여 토큰에서 불용어("사진", "찾아줘", "보여줘", "photos", "find", "show", "여행"…) 제거 → `textQuery`(한국어면 소사전으로 영어 치환: 바다→beach, 음식→food, 야경→night view, 눈→snow… 100개; 미매치 단어는 그대로 둔다 — CLIP은 일부 한국어에도 반응함).
- [ ] `Retriever.search(index, embedder, SearchQuery, limit=50)`:
  1. 하드 필터: country/city/date. `scan`으로 후보 수집.
  2. `textQuery`가 있으면 `embedText` 후 cosine 정렬, 없으면 `taken_at DESC`.
  3. 후보 0건이면 필터를 `city → date → country` 순으로 하나씩 풀고 `relaxed` 플래그를 남긴다.
  4. 결과: `List<Hit{path, takenAt, city, country, score}>`.
- [ ] JVM 테스트(파서): "프랑스 여행 갔던 사진 찾아줘" → FR, text "travel"; "작년 여름 제주 바다" → KR/Jeju, 2025-06-01~08-31, "beach"; "2024년 5월 파리 야경" → FR/Paris, 2024-05, "night view".
- [ ] Commit `feat(mobile): rule-based query parser + filtered cosine retriever`

### Task 6: AskRunner + RPC + 플러그인

**Files:** Create `agent/AskRunner.java`; Modify `RpcHandler.java`, `AindriveAgentPlugin.java`, `mobile/src/plugin.ts`

- [ ] `AskRunner.ask(query) → JSONObject { answer, sources[] }`:
  - `answer`: 템플릿. "Found 37 photos taken in Paris and Nice, France (May 2024)." / relaxed면 "No photos matched France; showing 12 from 2024 instead." / 인덱스 비었으면 "Photo index is empty — enable indexing in the app." 한국어 질문이면 한국어 템플릿(질문에 한글이 있으면).
  - `sources[]`: `{ path, snippet: "2024-05-12 · Paris, FR" }` 상위 50. 데스크톱과 같은 필드명이라 웹 UI 무변경.
- [ ] `RpcHandler` `agent-ask`: `agent_ask_unsupported_on_mobile` 던지던 자리를 `AskRunner`로 교체. `agentId`는 형식만 검증하고 `agent.json`은 읽지 않는다(웹이 접근 정책을 이미 검증; 폰 에이전트는 종류가 하나). 콜드 스타트(모델 로드) 포함 60 s 안에 답해야 함 — 임베더는 첫 질문 후 30 s 유지.
- [ ] 플러그인 메서드: `ask({query}) → {answer, sources}`, `indexStatus() → {enabled, indexed, total, phase, modelReady}`, `setIndexing({enabled})`, `ensureModels()`(다운로드 진행 이벤트 `modelProgress`).
- [ ] `plugin.ts`에 타입 추가.
- [ ] Commit `feat(mobile): agent-ask on the phone + ask/indexStatus plugin surface`

### Task 7: 셸 UI

**Files:** Modify `mobile/src/main.ts`, `mobile/src/ui.css`

- [ ] Status 카드 아래 **Photo search** 카드(로그인·페어링 후에만):
  - 토글 "Index photos on this phone (charging + Wi-Fi)" → `setIndexing`. 처음 켤 때 모델 다운로드(≈80 MB) 진행 바, 완료 후 "Indexed 1,230 / 8,400".
  - 검색창 + 버튼. 결과: answer 한 줄 + 목록(썸네일 없음, `path` + snippet). 항목 탭 → `Browser.open(driveUrl + ?path=…)`.
  - 전부 영어 문자열(이번 세션 원칙).
- [ ] `npx tsc --noEmit` PASS, 폰 배포로 "프랑스 사진" 질의 스크린샷 확인.
- [ ] Commit `feat(mobile): photo search card (index toggle, model download, query)`

### Task 8: 문서

**Files:** Modify `mobile/README.md`

- [ ] 파일 맵에 `index/*`, `agent/*` 추가. Contracts에 "`agent-ask` 응답 형식은 데스크톱과 동일; 폰은 `agent.json`을 읽지 않는다", "인덱스는 앱 전용 저장소". Gotchas에 "인덱싱 기본 off, 충전+Wi-Fi 게이트", "모델은 APK 밖".
- [ ] Commit `docs(mobile): photo index + on-device ask`

---

## 검증 체크리스트 (P1 완료 기준)

- [ ] 사진 1,000장 폴더: 첫 인덱싱 ≤ 2분(중급 폰), 재실행 시 변경 없으면 ≤ 5초.
- [ ] "프랑스 여행 사진" → FR 사진만, `taken_at` 내림차순, 3초 내.
- [ ] "작년 여름 바다" → 날짜 필터 + beach cosine 상위가 실제 바다 사진.
- [ ] 웹에서 같은 드라이브의 에이전트에게 질문 → 동일 결과, 60 s 타임아웃 미발생(콜드 스타트 포함).
- [ ] 인덱싱 off 상태에서 `agent-ask` → "index is empty" 안내, 예외 없음.
- [ ] 사용자 폴더에 새 파일/디렉토리가 생기지 않음(`.aindrive/` 없음).
- [ ] `./gradlew testDebugUnitTest` PASS (Fp16, GeoLookup, QueryParser).

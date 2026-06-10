# 대용량 스트리밍 업로드 — design

현행 업로드는 브라우저가 파일 전체를 ArrayBuffer→base64로 메모리에 올려
`fs/write` JSON 한 방으로 보낸다(`AINDRIVE_MAX_WRITE_BYTES` 기본 100MB,
경로 전체가 메모리 바운드). GB급 파일을 위해 브라우저→웹서버→에이전트
전 구간을 스트림/청크로 바꾼다. 합의된 정석 방향(청크/스트림 전송)의 구현.

## 핵심 발견과 접근법

에이전트(CLI)에는 `upload-chunk`(chunkId 0=truncate, 이후 append, 청크
≤4MB) / `rename` / `delete` RPC가 **이미 배포되어 있다**(0.2.x 전부).
따라서 세 가지 접근 중:

1. CLI에 업로드 세션 프로토콜 신설(temp+rename 내장) — 프로토콜 변경 +
   0.2.4 republish + 구버전 에이전트 분기 필요. 기각(불필요).
2. 기존 append를 최종 경로에 직접 — 중단 시 **부분 파일이 완성품처럼
   목록에 남는** 정합성 결함 + 동시 업로드 시 교차 손상. 기각.
3. **웹 오케스트레이션 원자 업로드 (채택)** — 기존 RPC만 조합:
   `.aindrive/uploads/<uploadId>.part`(목록에서 숨겨지는 `.aindrive` 하위)에
   청크를 순차 append → 전송 완료 시 `rename`으로 최종 경로에 원자 반영 →
   실패/중단 시 `delete` best-effort. **CLI 무변경, 구 에이전트 완전 호환,
   동시 같은-경로 업로드도 uploadId로 임시명이 갈려 마지막 rename 승자만
   남는다(현행 write 의미론과 동일).**

## 서버: `POST /api/drives/[driveId]/fs/upload?path=…`

- 바디: raw `application/octet-stream` (JSON/base64 아님 — 33% 오버헤드와
  메모리 버퍼링 제거). Next App Router 라우트 핸들러는 바디를 파싱하지
  않고 `req.body` ReadableStream으로 주므로 미들웨어 10MB 문제도 무관
  (/api는 이미 미들웨어 제외).
- 가드: `requireDriveRole(min: "editor")` + fs/write와 동일한 티어
  파일수 게이트(429 + upgrade payload 미러) + `bumpOwnerUsage({files:1})`
  (창작 시). 존재 여부 판정도 write 라우트와 동일(stat/list).
- 한도: `AINDRIVE_MAX_UPLOAD_BYTES` 기본 2 GiB. Content-Length 있으면
  선검사(413), 없어도 스트림 누적 카운터로 강제(초과 시 중단+tmp delete).
- 스트리밍 루프: `req.body`를 read하며 4 MiB(에이전트
  `maxUploadChunkBytes`) 버퍼로 재청크 → `upload-chunk`를 **순차 await**
  (자연 백프레셔; WS maxPayload 160MB 대비 base64 후 ~5.3MB로 여유).
  chunkId 0이 truncate이므로 재시도 없이 단순 순차 — 청크 RPC 실패는
  전체 실패(tmp delete 후 5xx).
- 0바이트 파일: 빈 데이터 청크 1개(chunkId 0)로 tmp 생성 후 rename.
- 완료: `rename(tmp → path)` → `{ ok, path, bytes }` 200.
- 에이전트 오프라인/RPC 에러: AgentError status 매핑(fs/read와 동일).

## 클라이언트 (`drive-shell.tsx` onUpload)

- ArrayBuffer/base64 제거 — `XMLHttpRequest`로 `file`을 바디로 직접 전송
  (브라우저가 디스크에서 스트리밍; fetch 대신 XHR인 이유는 업로드 진행률
  이벤트 — fetch duplex 스트림은 Chrome 한정이라 부적합).
- 진행률: sonner 토스트 1개를 파일별로 같은 id로 갱신
  ("Uploading name — 42%"), 완료 시 기존 success/"Set price" 액션 토스트
  로직 유지. 파일들은 현행대로 순차 업로드.
- 모든 파일 업로드를 이 경로로 단일화(소파일=청크 1개와 동일 비용).
  `fs/write`(JSON)는 에디터 텍스트 저장 경로로 존속 — 용도가 다르다.
- 413/429 에러 바디의 limit/upgrade 정보는 기존 토스트 에러로 표면화.

## 테스트

- e2e 시나리오(실제 에이전트 경유가 본질이라 단위보다 e2e가 정합):
  - 10 MiB(>청크 2.5개) 랜덤 바이트 업로드 → 200 + stat 크기 일치 +
    download/read로 바이트 왕복 해시 일치.
  - 업로드 후 `.aindrive/uploads`가 목록에 안 보임(root list에 .aindrive
    숨김 유지 확인) + tmp 잔존물 없음.
  - 비편집자(viewer) → 403, 익명 → 401/403.
  - `AINDRIVE_MAX_UPLOAD_BYTES`를 작게 가정하기 어려우므로 Content-Length
    초과 케이스는 헤더만 큰 요청으로 413 확인.
- 클라이언트 XHR 경로는 typecheck/build + 기존 업로드 시나리오(드래그드롭
  포함 e2e가 fs/write 기반이면 upload 라우트로 따라 감 — 갱신) + 실화면
  스모크.

## 범위 밖 (후속)

- 대용량 다운로드/영상 재생 스트리밍(`download-chunk` + Range) — 업로드와
  대칭인 별도 작업.
- 재개(resumable) 업로드 — 현 세대는 실패 시 재전송. tmp+rename 구조라
  세션 재개를 얹을 자리는 이미 있다.
- 병렬 멀티파일/청크 파이프라이닝 — 순차로 시작, 병목이면 후속.

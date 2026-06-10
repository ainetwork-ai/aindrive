# Streaming Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GB급 파일 업로드를 브라우저→웹서버→에이전트 전 구간 스트림/청크로 처리한다 (원자 반영, CLI 무변경).

**Architecture:** 신규 `POST /api/drives/[driveId]/fs/upload?path=…`가 raw octet-stream 바디를 4MiB로 재청크해 에이전트 `upload-chunk`(`.aindrive/uploads/<id>.part`)로 순차 전송, 완료 시 `rename`으로 원자 반영, 실패 시 `delete`. 클라이언트 onUpload는 XHR(file 바디 + 진행률 토스트)로 교체. Spec: `docs/superpowers/specs/2026-06-11-streaming-upload-design.md`.

**Tech Stack:** Next.js 15 route handler(ReadableStream), 기존 agent RPC(upload-chunk/rename/delete), XMLHttpRequest, sonner.

---

### Task 1: 업로드 라우트

**Files:** Create `web/app/api/drives/[driveId]/fs/upload/route.ts`

- [ ] fs/write의 가드·티어 게이트·usage bump를 미러하고, 스트림 루프 구현:

```ts
const CHUNK = 4 * 1024 * 1024; // 에이전트 maxUploadChunkBytes
const MAX_UPLOAD_BYTES = parseInt(process.env.AINDRIVE_MAX_UPLOAD_BYTES ?? String(2 * 1024 * 1024 * 1024), 10);
// Content-Length 선검사(413) → editor 가드 → creating 판정+티어 429 →
// tmp = `.aindrive/uploads/${nanoid(12)}.part`
// for await (reader): buffer accum → CHUNK 단위 upload-chunk(chunkId++,
//   data: base64) 순차 await; 누적 > MAX → abort(413)
// flush 잔여(0바이트 파일은 빈 청크 1개) → rename(tmp→path) →
//   creating이면 bumpOwnerUsage({files:1}) → { ok, path, bytes }
// 실패 경로: delete(tmp) best-effort 후 AgentError status 매핑
```

- [ ] `npm run typecheck` PASS → Commit `feat(api): streaming chunked upload route (atomic tmp+rename via existing agent RPCs)`

### Task 2: e2e 시나리오 #177

**Files:** Modify `web/scenarios/cases.mjs`

- [ ] 10MiB 랜덤 버퍼 → `fetch(BASE+/fs/upload?path=big.bin, {method:"POST", body})` → 200, `stat` 크기 일치, `fs/download` 바이트 sha1 일치, root list에 `.aindrive` 미노출, viewer 403/익명 401|403, Content-Length 초과 413.
- [ ] 케이스 단독 실행 PASS → Commit `test(e2e): #177 streaming upload roundtrip + guards`

### Task 3: 클라이언트 XHR 업로드

**Files:** Modify `web/components/drive-shell.tsx`

- [ ] `onUpload`의 arrayBuffer/base64 루프를 XHR로 교체:

```ts
function uploadFile(driveId: string, target: string, file: File, onProgress: (pct: number) => void) {
  return new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/drives/${driveId}/fs/upload?path=${encodeURIComponent(target)}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => resolve(xhr.status < 300 ? { ok: true } : { ok: false, error: parseErr(xhr) });
    xhr.onerror = () => resolve({ ok: false, error: "network error" });
    xhr.send(file);
  });
}
```

파일별 sonner 토스트 id 갱신("Uploading name — N%"), 기존 완료 토스트("Set price" 액션) 유지. `arrayBufferToBase64` 헬퍼는 다른 사용처 없으면 삭제.

- [ ] typecheck PASS → Commit `feat(web): stream uploads from the browser with per-file progress`

### Task 4: 전체 검증

- [ ] `npm run test` + `npm run typecheck` + `npm run build` PASS
- [ ] `npm run test:e2e` green (기존 + #177)

### Task 5: 리뷰 + 머지

- [ ] 적대 리뷰(스트림 경계: 부분파일 노출, tmp 누수, 한도 우회, 동시성, 백프레셔) → 수정 → PR → merge

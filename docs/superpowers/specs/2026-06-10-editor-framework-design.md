# Editor Framework + Rich-Text — Design (3'-4)

> 상위: `2026-06-10-uiux-overhaul-design.md` §3'-4. 그 절이 "직렬화·협업 계약이 무거워(데이터 손실 위험) 별도 spec으로 분리"라 지시 → 이 문서가 그 상세.

## 문제 (현 상태)

`web/components/viewer.tsx`(308줄)는 **단일 컴포넌트에 모든 파일타입 분기를 인라인**한다:

- `isText`(text/*·json·TEXT_EXT) → Monaco, `Y.Text("content")`에 `y-monaco` 바인딩.
- `isImage` → `<img>`, `isPdf` → `<iframe>`, 그 외 → "Preview not available".
- 협업 전체(provider 생성·seed·reload de-dup·awareness/presence·debounced autosave·beforeunload flush·teardown)가 `isText` 게이트 useEffect에 하드코딩(viewer.tsx:88-221).
- 디스크 왕복은 `provider.doc.getText("content").toString()` 고정(autosave:68, save:255, reload:110).

결과: (1) 새 에디터(리치텍스트·미디어)를 추가하려면 이 거대 useEffect를 건드려야 하고, (2) 디스크 직렬화가 `Y.Text("content")`에 묶여 **다른 CRDT root를 쓰는 에디터를 지원할 수 없다**.

## 목표

1. **에디터 레지스트리**: `mime/ext → EditorDescriptor`. Viewer는 디스패처만.
2. **`useCollabDoc` 훅**: 텍스트-패밀리 협업 공유 로직을 descriptor가 주는 **디스크 어댑터**로 매개. binary는 provider-free.
3. **리치텍스트(.md WYSIWYG)**: TipTap/ProseMirror self-host, **같은 Y.Doc의 다른 root**(`getXmlFragment("prosemirror")`), **ProseMirror↔Markdown 직렬화기**. ← 데이터손실 위험의 핵심.
4. **미디어 다변화**: 비디오/오디오 재생, 이미지 뷰어 개선(fit/zoom). PDF 유지.
5. 시트/슬라이드 **비목표**(placeholder). editor-roadmap memory 일치.

## 불변식 / 제약 (절대)

- **CRDT root 분리**: y-monaco는 `Y.Text("content")`(평문), y-prosemirror는 `Y.XmlFragment`(트리). **같은 root에 둘을 바인딩하면 doc 손상**. 리치텍스트는 반드시 `doc.getXmlFragment("prosemirror")`, 코드/텍스트는 `doc.getText("content")` — 한 파일은 둘 중 *하나의* 에디터만 연다(mime/ext로 결정, 동시 바인딩 없음).
- **디스크 직렬화는 descriptor 책임**: autosave/save/reload가 `getText("content")`를 직접 부르지 않는다. `descriptor.serializeToDisk(doc)`/`deserializeFromDisk(doc, bytes)`/`reloadEquals(doc, diskText)` 경유.
- **데이터손실 0**: 리치텍스트 빈 .md 시드 → 편집 → autosave → 디스크 .md 가 **비어있지 않고 정확**. (현행 text 경로의 `getText("content")`는 리치텍스트엔 빈 바이트를 씀 → 반드시 교체.)
- **협업 바이트 불투명 재사용**: WS sync·IndexedDB·`/api/drives/{id}/yjs`(.bin)는 전체-doc 바이트라 에디터 무관 재사용. **단** 디스크 file-body 왕복(`fs/write`)만 에디터별.
- **self-host(CSP)**: ProseMirror/TipTap은 npm 번들(Next 빌드). CDN 금지. Monaco self-host 유지.
- **API/권한/협업 프로토콜 무변경**: `web/app/api/*`, `web/lib/yjs/aindrive-provider.ts`, `fs/read|write`, `/yjs` 계약 불변. 표현+클라 직렬화만.

## EditorDescriptor 계약

```ts
type EditorKind = "text" | "richtext" | "image" | "pdf" | "video" | "audio" | "none";

interface EditorDescriptor {
  kind: EditorKind;
  /** true면 useCollabDoc(provider+CRDT)를 건다. false면 binary read-only preview. */
  collab: boolean;
  /** 협업 에디터만: CRDT root에서 디스크 바이트로. richtext=ProseMirror→Markdown, text=ytext.toString(). */
  serializeToDisk?: (doc: Y.Doc) => string;
  /** 협업 에디터만: 디스크 텍스트를 CRDT root에 시드(빈 root일 때만 호출). richtext=Markdown→ProseMirror. */
  seedFromDisk?: (doc: Y.Doc, diskText: string) => void;
  /** autosave→fs.watch→reload 루프 차단: 직렬화 결과가 디스크와 같으면 reload 무시. */
  reloadEquals?: (doc: Y.Doc, diskText: string) => boolean;
  /** 렌더. collab이면 {doc, awareness, canEdit}, binary면 {dataUrl, entry}. */
  Component: React.ComponentType<EditorComponentProps>;
}
```

레지스트리 해석: `pickEditor(entry) → EditorDescriptor` (ext 우선, 그다음 mime prefix, fallback "none"). `.md`/`.markdown` → richtext, 그 외 TEXT_EXT/text/json → text(Monaco), image/* → image, application/pdf → pdf, video/* → video, audio/* → audio.

## useCollabDoc 훅

`viewer.tsx:88-221`의 텍스트 협업 useEffect를 추출. 시그니처:

```ts
function useCollabDoc(driveId, path, descriptor, canEdit): {
  doc: Y.Doc | null; awareness: Awareness | null;
  status; presence; loading;
}
```

내부(현행 로직 그대로, `getText("content")`만 descriptor 경유로 교체):
- provider 생성·`on` 구독·awareness identity·presence refresh.
- synced: docId 계산, tracer(opt-in), `whenReady`, **시드** — `serializeToDisk(doc)`가 빈 신호일 때만 yjs-pull→`seedFromDisk(doc, diskText)`.
- reload: 디스크 재읽기 → `reloadEquals(doc, diskText)`면 no-op(자기 autosave), 아니면 `seedFromDisk` 재적용(트랜잭션).
- autosave(debounce 5s/max15s): `serializeToDisk(doc)`를 `fs/write`, `encodeStateAsUpdate`를 `/yjs`.
- beforeunload flush, teardown.

빈-신호 판정: text는 `ytext.length===0`, richtext는 ProseMirror fragment가 빈 doc인지(`xml.length===0`). descriptor가 `isEmpty(doc)` 노출 또는 `serializeToDisk(doc)===""`로 판정.

## 리치텍스트 (핵심 위험)

- **deps(신규)**: `@tiptap/core`,`@tiptap/react`,`@tiptap/starter-kit`,`@tiptap/extension-collaboration`(+ `@tiptap/extension-collaboration-cursor` 선택),`y-prosemirror`,`prosemirror-markdown`. 전부 번들(self-host).
- **바인딩**: TipTap `Collaboration.configure({ document: ydoc, field: "prosemirror" })` → `ydoc.getXmlFragment("prosemirror")`. **`Y.Text("content")` 미사용**(코드 경로와 root 분리 → 한 파일 한 에디터라 충돌 없음).
- **직렬화기 (byte-stable/idempotent)**:
  - `serializeToDisk`: ProseMirror doc → Markdown. `prosemirror-markdown`의 `defaultMarkdownSerializer`(StarterKit 노드 커버) + GFM 확장(필요한 노드만).
  - `seedFromDisk`: Markdown → ProseMirror doc. `prosemirror-markdown`의 `defaultMarkdownParser` → ProseMirror node → `prosemirrorToYXmlFragment`(y-prosemirror)로 XmlFragment 시드. **트랜잭션 origin=provider**(자기 reload 루프 방지).
  - **idempotent 요구**: `parse(serialize(doc)) ≈ doc`, `serialize(parse(md))`가 안정(round-trip이 바이트를 흔들지 않음). `reloadEquals`는 `serializeToDisk(doc) === diskText`(정규화 후).
- **dirty 게이트**: 리치 편집 중 디스크-origin reload는 `reloadEquals`로 막되, 충돌 시 디스크 우선 아닌 **CRDT 우선**(현행 text 정책과 동일 — CRDT가 authoritative, reload는 빈/외부변경만).

## 미디어 (저위험)

- **video/***: `<video controls>` + dataUrl(현 binary read 경로 재사용). 큰 파일 주의 — dataUrl base64는 메모리 부담이나 v1은 현행 image/pdf와 동일 방식 유지(스트리밍은 후속).
- **audio/***: `<audio controls>` + 파일명/아이콘 카드.
- **image**: fit-to-width 기본 + 클릭 시 원본 크기 토글(zoom), 체커보드 배경(투명 PNG). 
- **pdf**: 현행 iframe 유지.

## 테스트 트랙 (필수 — 기존 162 e2e는 Y.Text 경로라 이 회귀 못 잡음)

신규 e2e 시나리오(scenarios/ 또는 web/e2e playwright):
1. **리치텍스트 디스크 왕복 무결성**: 빈 `.md` 생성 → WYSIWYG로 heading/bold/list 편집 → autosave 대기 → 디스크 `.md` 재읽기 → **비어있지 않고** heading(`#`)·bold(`**`)·list(`-`) 정확. (데이터손실 회귀 그물)
2. **리치텍스트 협업 수렴**: 두 컨텍스트가 같은 `.md` 편집 → 서로 반영 + 디스크 일관.
3. **에디터 선택**: `.md`→richtext, `.ts`→Monaco, `.png`→image, `.mp4`→video 렌더 확인.
4. **회귀**: 기존 Monaco 텍스트 협업(concurrent-editing.spec) 불변.

## 구현 순서 (체크포인트별 커밋)

1. 레지스트리 + `useCollabDoc` 추출 — **동작 무변경**(text=Monaco만). 기존 협업 e2e가 그물. ← 안전, 먼저.
2. 미디어(video/audio/image 개선) — binary 경로 확장. 저위험.
3. 리치텍스트 deps + 직렬화기 + 왕복 테스트(테스트 먼저 = TDD) → TipTap 에디터 → 테스트 green일 때만 `.md`를 richtext로 라우팅. **테스트 red면 .md는 Monaco 유지**(데이터손실 방지 — 안전 기본값).
4. 최종 리뷰(에이전트팀 — CRDT/직렬화 어드버서리얼) + 풀 e2e + 신규 트랙.

## 영향 범위

- 신규: `web/components/editors/*`(registry, useCollabDoc, RichTextEditor, MonacoEditor wrap, MediaViewer, ImageViewer), `web/lib/editors/markdown-serializer.ts`.
- 개편: `viewer.tsx`(디스패처로 축소), `viewer-parts.tsx`(헤더는 kind-aware).
- deps: 위 ProseMirror/TipTap 묶음.
- 무변경: `web/app/api/*`, `web/lib/yjs/*`, `aindrive-provider`, 협업 프로토콜.

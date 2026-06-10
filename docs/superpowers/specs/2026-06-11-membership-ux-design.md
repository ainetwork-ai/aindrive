# 권한 정책 정리 + 멤버/공유 관리 UX 개편 — design

피드백: "멤버 권한 주고 받고 관리하고 이런 게 엄청 불편" — 페이지 신설·버튼
재배치 허용, 최적 UX 구성 요청. 서비스 정체성: 구글 공유드라이브 + 드라이브 안
유료 컨텐츠.

## 현황 진단 (코드 감사 결과)

- **모놀리식 모달**: earnings/판매/멤버/초대/링크/토큰정책/정산지갑 7가지가
  path-스코프 모달 하나에. 폴더별 grant를 관리하려면 폴더를 옮겨다니며 모달을
  다시 열어야 함.
- **사람 단위 뷰 부재**: "누가 이 드라이브 어디에 무슨 권한"을 한눈에 볼 수 없음.
  inherited 표시는 있으나 클릭해 그 지점에서 관리 불가.
- **초대의 반쪽**: 미가입 이메일 초대는 404 — pending 상태가 없어 "받는" 경험이
  끊김.
- **링크 폐기 불가**: shares에 DELETE API 자체가 없음.
- **역할 의미 설명 부재**, **정산지갑이 Sell 안에 묻힘**(드라이브 전역 설정인데).

## 설계

### 1. 관리 페이지 신설 — `/d/[driveId]/manage` (owner 전용)

드라이브 헤더에 owner용 Manage(Settings 아이콘) 버튼 → 전용 페이지. 탭 3개:

**People** (기본 탭)
- 멤버를 **사람 단위로 그룹화**: Avatar + 이름/이메일, 그 아래 grant 칩 목록
  (`/path · role`). 각 grant: 역할 select(owner 게이트), 제거 IconButton,
  path 클릭 → 해당 폴더로 이동. 드라이브 creator는 제거 불가(기존 가드).
- 상단 검색(이름/이메일 필터, 클라이언트).
- **Invite 카드**: 이메일 + 폴더(현재 경로 트리 대신 텍스트 경로 입력 + ""=전체)
  + 역할 select + **역할 설명 캡션**(Viewer: 읽기/다운로드 · Editor: 업로드/편집/
  삭제 · Owner: 멤버/판매 관리).
- **Pending invites 목록**: 미가입 이메일 초대 행(email · path · role · 취소).

**Links & sales**
- share 링크 테이블: path · role · Free/가격 · listed 배지 · 만료 · 복사 ·
  **Revoke**(확인 후 삭제 — 기존 구매자의 drive_members grant는 불변, 링크만
  죽음을 명시).
- Earnings 카드: 기존 EarningsSection 이전(총액 + 영수증 목록 + basescan 링크).

**Settings**
- Payout wallet (모달에서 승격 — 드라이브 전역 설정).
- Payment token policy 에디터 (기존 컴포넌트 재사용 이전).

### 2. share-dialog 경량화 (컨텍스트 공유에 집중)

남기는 것: 이 폴더의 **빠른 공유** — free 링크 생성, 판매 설정(가격+통화,
정책은 Settings로 안내), 이 폴더로 이메일 초대, 이 폴더에 접근 가능한 멤버
**요약**(읽기 전용, direct/inherited 합산) + "Manage all members →" 링크.
제거(페이지로 이전): Earnings, 토큰 정책 에디터, payout wallet 편집(미설정 시
판매 저장에서 Settings로 안내만).

### 3. Pending invites (백엔드)

- 테이블 `drive_invites(id, drive_id, email(lower), path, role, created_by,
  created_at)` — UNIQUE(drive_id, email, path). db.js bootstrap에 CREATE TABLE.
- `POST /members`: 이메일 미가입이면 404 대신 invite upsert 후
  `{ok, pending: true}` 202. 가입 계정이면 기존 그대로 즉시 grant.
- **가입 시 전환**: signup 라우트에서 email 매칭 invite 전부
  `drive_members`(upgrade-only)로 전환 후 invite 삭제 — 가입만 하면 드라이브가
  사이드바에 보임.
- `GET /members` 응답에 `pending: [{id, email, path, role}]` 추가(owner에게만).
- `DELETE /api/drives/[id]/members/invites/[inviteId]` (owner).

### 4. Share revoke (백엔드)

- `DELETE /api/drives/[id]/shares/[shareId]` — owner 또는 해당 share의
  created_by 본인. 효과: 행 삭제 → /s/[token] 즉시 404. 이미 settle된 구매
  grant/영수증은 불변(명시적 의미론).

### 5. 권한 모델 문서화 — `docs/PERMISSIONS.md`

한 장: 역할 래더(none<viewer<editor<owner), path-스코프 grant + 조상 상속
(bestMatchingRole), upgrade-only 병합(결제/수락이 기존 역할을 강등 못함),
entry 계산(root/single/synthetic multi), 링크·결제·초대가 각각 grant로
수렴하는 흐름. README에서 cross-ref.

## 불변식 (깨면 안 됨)

- 서버 권한 로직(access-core/resolveAccess/멤버 API 가드) 의미 불변 —
  pending invite와 share DELETE는 순수 추가.
- 기존 e2e(멤버/공유/결제 시나리오) green. upgrade-only·creator 제거 불가 유지.
- 모달 경량화는 표현 이동이지 기능 제거가 아님(모든 기능이 페이지에 존재).

## 테스트

- e2e 추가: ① 미가입 초대 → 202+pending 목록 → 가입 → 자동 grant + pending
  소멸 ② share revoke → /s/token 404, 기존 grant 잔존 ③ /manage 가드(비owner
  403/redirect) ④ invite 취소.
- 단위: invite 전환 헬퍼(가입 훅), revoke 권한 가드.

## 범위 밖 (후속)

- 멤버별 활동/구매 이력 드릴다운, 대량 작업, 멤버 태그, 초대 이메일 발송
  (현재는 링크 공유가 전달 수단), 구매자용 "내 구매" 페이지.

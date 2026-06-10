# npm publish guide (`aindrive` CLI)

여러 엔지니어가 같은 npm 패키지(`aindrive`)에 publish할 때 충돌·재현 불가
한 상태를 막기 위한 운영 가이드. **`cli/` 디렉터리 한정**.
`web/`는 npm으로 배포하지 않습니다.

---

## TL;DR (한 줄 룰 3개)

1. **항상 다음 순서로**: `git pull --rebase` → `npm version <patch|minor|major>`
   → `npm publish` → `git push --follow-tags`. 이 4개를 한 호흡에 끝낸다.
2. **버전은 npm registry 기준**: `npm view aindrive version`이 진실. 로컬
   `package.json`만 보고 bump하지 않는다.
3. **publish 후엔 무조건 push**: 안 그러면 다음 사람이 같은 버전으로 bump
   해서 409를 본다. publish 했는데 push를 잊은 게 모든 사고의 원인.

---

## 1. 권한 / 계정

- npm registry 계정: `dev_ainetwork` (2FA 활성)
  - 새 사람을 추가할 때는 owner가 `npm owner add <user> aindrive` 수행
- GitHub: `git@github.com:ainetwork-ai/aindrive.git`, branch `main`

publish하려면 두 가지가 모두 필요:
- `npm whoami` → `dev_ainetwork` (또는 owner 권한 있는 계정)
- 모바일 authenticator (OTP)

### `npm login`이 안 될 때 (원격/서버에서 자주)

`npm login`이 브라우저 로그인 URL만 띄우고 `npm error Exit handler never
called!`로 죽는 경우가 있다 — 헤드리스/원격 박스에서 웹 인증 콜백이 안 돌아오는
npm 버그다. 우회 두 가지:

1. **터미널 직접 입력 (권장)** — 브라우저 없이 username/password/OTP를 터미널
   에서 받는다:
   ```bash
   npm login --auth-type=legacy
   npm whoami                 # dev_ainetwork 나오면 성공
   ```
2. **automation token (OTP 자체를 없앰, CI·반복 배포용)** — npm 웹 UI →
   Access Tokens → Granular/Automation 토큰 발급 후 `~/.npmrc`에:
   ```
   //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxx
   ```
   automation 토큰은 publish 시 OTP를 요구하지 않는다. **절대 repo에 커밋 금지**
   (`~/.npmrc`에만 둔다).

> 비대화형(스크립트/에이전트 등 non-TTY)에서 `npm publish`는 OTP 프롬프트를 못
> 띄우고 `EOTP`로 즉시 실패한다. 이때는 `--otp=<코드>`를 인라인으로 넘기거나
> (2번) automation 토큰을 쓴다.

---

## 2. 사전 체크 (한 번만)

```bash
npm whoami                  # 로그인 확인 — 401이면 npm login
npm view aindrive version   # 현재 latest 버전 — bump 기준
```

`@jsr` 스코프는 publish하는 쪽엔 필요 없음. **번들에 모든 의존성이 들어가
있으므로** 받는 사용자도 별도 npm config 불필요.

---

## 3. publish 절차 (정상 케이스)

`cli/`에서 진행:

```bash
# 1) 최신 main 동기화
git fetch origin
git pull --rebase origin main

# 2) 빌드가 통과하는지 먼저 확인
npm run build               # = node build.mjs → dist/aindrive.mjs
node dist/aindrive.mjs --version
node dist/aindrive.mjs --help

# 3) tarball 미리보기 (선택이지만 권장)
npm pack --dry-run

# 4) 버전 bump — 아래 "버전 룰" 참고
npm version patch            # 0.1.6 → 0.1.7  (버그/작은 변경)
# npm version minor           # 0.1.6 → 0.2.0  (기능 추가, 호환)
# npm version major           # 0.1.6 → 1.0.0  (호환 깨짐)
# ⚠ 이 repo에선 npm version이 package.json/package-lock의 *숫자만* 바꾸고
#   git commit/tag는 안 만든다 (cli/가 루트 package.json 없는 서브디렉터리라
#   npm이 git 단계를 조용히 스킵 — git-tag-version=true여도). 그래서 commit +
#   tag를 손으로 완성한다 (버전 숫자는 npm version이 만든 그대로 둔다):
git add cli/package.json cli/package-lock.json
git commit -m "chore(cli): bump 0.1.6 -> 0.1.7"
git tag -a v0.1.7 -m "aindrive 0.1.7 (cli npm release)"

# 5) publish — OTP 입력
npm publish --access public --otp=<6자리>

# 6) 즉시 push (commit + tag 함께)
git push --follow-tags origin main
```

`prepublishOnly` 훅이 `npm run build`를 다시 한 번 돌리므로 빌드는 자동
보장. 그래도 4번 전에 직접 한 번 돌려 깨진 빌드를 commit하는 사고를 막는다.

---

## 4. 버전 룰

- **patch** (`0.1.x`): 버그 픽스, 내부 리팩터, README 수정
- **minor** (`0.x.0`): 새 명령어/플래그, 새 기능 — 기존 사용 방식이 그대로
  동작
- **major** (`x.0.0`): 옵션 제거, 동작 변경, 호환 깨짐

판단이 애매하면 **patch**로 간다. minor를 너무 아껴 받지 않는다 — 받는
쪽이 `npm i -g aindrive@latest` 한 줄로 따라가니 비용이 거의 없다.

**중요**: 버전 *숫자*는 손으로 `cli/package.json`에서 고치지 말고 항상
`npm version`으로 만든다 (package-lock까지 일관되게 갱신됨). 단 이 repo에선
§3-4)에서 봤듯 git commit/tag가 자동으로 안 만들어지니 그 두 단계는 직접
완성해야 한다 — 그래야 누가 무슨 버전을 publish했는지 history(`v0.1.7` 태그)로
남는다.

---

## 5. 충돌 시나리오와 복구

### 5-1. publish 시 `403`/`409` (이미 같은 버전 존재)

원인: 다른 사람이 이미 같은 버전을 publish함. 또는 본인이 이전에 publish
했는데 commit/push를 잊어 같은 버전을 bump.

복구:
```bash
git fetch origin
git pull --rebase origin main
npm version patch          # 다음 패치로
npm publish --access public --otp=<코드>
git push --follow-tags origin main
```

### 5-2. publish 했는데 git push를 잊음

다음 사람이 잘못된 버전으로 bump하기 전에:
```bash
git push --follow-tags origin main
```
태그까지 함께 올라가야 함.

### 5-3. publish는 했는데 코드에 결함이 있음 (24시간 이내)

```bash
npm unpublish aindrive@<bad-version>      # 24시간 내에만 가능
```
24시간이 지났으면 **deprecate** 후 새 patch publish:
```bash
npm deprecate aindrive@<bad-version> "use <next-version>+; previous had <issue>"
```
unpublish 한 버전은 **24시간 동안 같은 번호로 다시 publish할 수 없음** —
무조건 patch bump해야 한다.

### 5-4. rebase 충돌이 `package.json`에서 남

다른 사람도 같은 시점에 bump 중이었을 가능성. 본인의 bump를 버리고
remote 것을 쓴 뒤 다시 bump:
```bash
git checkout --theirs cli/package.json
git rebase --continue
npm version patch
```

### 5-5. `package-lock.json` conflict

대부분 `cli/package-lock.json`은 그대로 두고 다음으로 해결:
```bash
git checkout --theirs cli/package-lock.json
npm install                # lock을 다시 산출
git add cli/package-lock.json
git rebase --continue
```

### 5-6. `package.json` 버전이 registry보다 앞서는데 태그가 없음

증상: `npm view aindrive version`은 `0.2.1`인데 로컬 `cli/package.json`은
`0.2.2`, 그리고 `git tag -l v0.2.2`가 비어 있음. 누군가 `npm version` 대신
`package.json`을 손으로 고쳐 commit하고(§4 위반) 아직 publish는 안 한 상태다.

복구 — **bump 금지.** 이미 박힌 버전이 곧 다음 publish 버전이다:
```bash
git pull --rebase origin main
npm run build && node dist/aindrive.mjs --version    # 0.2.2 확인
npm publish --access public --otp=<코드>              # 0.2.2 그대로 publish
git tag -a v0.2.2 -m "aindrive 0.2.2 (cli npm release)"   # 누락 태그 보강
git push --follow-tags origin main
```
여기서 `npm version patch`를 돌리면 0.2.3으로 튀어 0.2.2를 건너뛴다 — 금지.

---

## 6. 자주 실수하는 것

- ❌ **루트(`/`)에서 `npm publish`** — 루트엔 패키지가 없다. 반드시 `cli/`
  안에서. (관련: `feedback_aindrive_no_root_package_json.md`)
- ❌ **`package.json` 손으로 version bump** — git tag가 안 만들어져
  history에서 publish 시점이 사라짐.
- ❌ **publish 후 push 망각** — 즉시 `git push --follow-tags`.
- ❌ **`--no-git-tag-version` 옵션** — 사용 금지. 누가 언제 publish했는지
  추적 불가.
- ❌ **dist만 수정해 publish** — `dist/`는 빌드 산출물. `src/`만 고치고
  `npm run build`로 재생성.
- ❌ **테스트 안 돌리고 publish** — 최소한 `node dist/aindrive.mjs --version`,
  `--help`은 확인.

---

## 7. 빠른 참조

```bash
# 처음 셋업
cd cli
npm install

# 매 publish
git fetch origin && git pull --rebase origin main
npm run build && node dist/aindrive.mjs --version
npm pack --dry-run                                  # (선택)
npm version patch
npm publish --access public --otp=XXXXXX
git push --follow-tags origin main
```

문제가 생기면 다른 publish를 하기 **전에** 채널에 알리자. 침묵이 충돌의
원인이다.

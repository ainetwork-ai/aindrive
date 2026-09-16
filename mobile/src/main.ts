/**
 * aindrive mobile shell.
 *
 * This screen only PAIRS and CONTROLS — it never touches files. Pairing
 * follows the same flow as `aindrive login` on desktop (cli/src/commands/
 * login.js): ask the server for a single-use link, open it in the system
 * browser, poll until the user approves, then create the drive. The resulting
 * driveId/agentToken/driveSecret are handed to the native agent service,
 * which is what actually serves the picked device folder.
 */
import { Preferences } from "@capacitor/preferences";
import { Browser } from "@capacitor/browser";
import { App } from "@capacitor/app";
import { AindriveAgent, type AgentStatus, type PickedFolder } from "./plugin";
import { normalizeServer, startCliLogin, pollCliLogin, pairDrive } from "./api";

const DEFAULT_SERVER = "https://aindrive.ainetwork.ai";
const STORE_KEY = "aindrive.mobile.state.v1";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface SavedState {
  server: string;
  sessionCookie?: string;
  email?: string;
  folder?: PickedFolder;
  drive?: { driveId: string; agentToken: string; driveSecret: string; url?: string };
}

let state: SavedState = { server: DEFAULT_SERVER };
let status: AgentStatus = {
  running: false, connected: false, driveId: null,
  folderLabel: null, rpcCount: 0, lastError: null,
};
const logLines: string[] = [];
let busy: string | null = null;
let errorMsg: string | null = null;

async function save() {
  await Preferences.set({ key: STORE_KEY, value: JSON.stringify(state) });
}

async function load() {
  const { value } = await Preferences.get({ key: STORE_KEY });
  if (value) {
    try { state = { ...state, ...JSON.parse(value) }; } catch { /* corrupt → defaults */ }
  }
}

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  logLines.unshift(`${ts}  ${msg}`);
  if (logLines.length > 120) logLines.pop();
  render();
}

function driveUrl(): string | null {
  if (!state.drive) return null;
  return state.drive.url || `${state.server}/d/${state.drive.driveId}`;
}

// ---------------------------------------------------------------- actions

async function chooseFolder() {
  errorMsg = null;
  try {
    const folder = await AindriveAgent.pickFolder();
    state.folder = folder;
    await save();
    log(`폴더 선택: ${folder.label}`);
  } catch (e) {
    errorMsg = msgOf(e);
  }
  render();
}

async function connect() {
  errorMsg = null;
  if (!state.folder) { errorMsg = "먼저 공유할 폴더를 선택하세요."; return render(); }

  try {
    state.server = normalizeServer(state.server);
    await save();

    if (!state.sessionCookie) {
      busy = "브라우저에서 로그인 승인을 기다리는 중…"; render();
      const start = await startCliLogin(state.server);
      const url = `${state.server}/cli-login/${start.linkId}`;
      log(`로그인 링크 열기: ${url}`);
      await Browser.open({ url });

      const approved = await pollUntilApproved(state.server, start.linkId, start.deviceSecret);
      await Browser.close().catch(() => {});
      state.sessionCookie = approved.token;
      state.email = approved.email;
      await save();
      log(`로그인 완료${approved.email ? ` (${approved.email})` : ""}`);
    }

    if (!state.drive) {
      busy = "드라이브 페어링 중…"; render();
      const paired = await pairDrive(state.server, state.sessionCookie!, state.folder.label);
      state.drive = {
        driveId: paired.driveId,
        agentToken: paired.agentToken,
        driveSecret: paired.driveSecret,
        url: paired.url,
      };
      if (paired.serverUrl) state.server = normalizeServer(paired.serverUrl);
      await save();
      log(`페어링 완료: ${paired.driveId}`);
    }

    busy = "에이전트 시작 중…"; render();
    status = await AindriveAgent.start({
      serverUrl: state.server,
      driveId: state.drive!.driveId,
      agentToken: state.drive!.agentToken,
      driveSecret: state.drive!.driveSecret,
      folderUri: state.folder.uri,
    });
    log("에이전트 실행 — 드라이브 온라인");
  } catch (e) {
    errorMsg = msgOf(e);
    log(`오류: ${errorMsg}`);
  } finally {
    busy = null;
    render();
  }
}

async function pollUntilApproved(server: string, linkId: string, deviceSecret: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const r = await pollCliLogin(server, linkId, deviceSecret);
    if (r) return r;
  }
  throw new Error("로그인 승인 대기 시간이 초과되었습니다");
}

async function stopAgent() {
  try { status = await AindriveAgent.stop(); log("에이전트 중지 — 드라이브 오프라인"); }
  catch (e) { errorMsg = msgOf(e); }
  render();
}

async function openDrive() {
  const url = driveUrl();
  if (url) await Browser.open({ url });
}

async function unpair() {
  await AindriveAgent.stop().catch(() => {});
  state = { server: state.server };
  await save();
  log("페어링 해제 — 저장된 자격 증명 삭제됨");
  render();
}

// ---------------------------------------------------------------- render

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  const url = driveUrl();
  const dot = status.connected ? "on" : status.lastError ? "err" : "off";
  const stateLabel = status.connected ? "온라인" : status.running ? "연결 중…" : "오프라인";

  app.innerHTML = `
    <h1>aindrive</h1>
    <p class="sub">이 폰의 폴더를 드라이브로 공유합니다. 파일은 기기에 그대로 남고, 서버는 서명된 RPC만 중계합니다.</p>

    <div class="card">
      <h2>상태</h2>
      <div class="row"><span class="k">에이전트</span><span class="v"><span class="dot ${dot}"></span>${stateLabel}</span></div>
      <div class="row"><span class="k">공유 폴더</span><span class="v">${esc(state.folder?.label ?? "미선택")}</span></div>
      <div class="row"><span class="k">드라이브 ID</span><span class="v mono">${esc(state.drive?.driveId ?? "-")}</span></div>
      <div class="row"><span class="k">처리한 요청</span><span class="v mono">${status.rpcCount}</span></div>
      ${state.email ? `<div class="row"><span class="k">계정</span><span class="v">${esc(state.email)}</span></div>` : ""}
    </div>

    <div class="card">
      <h2>설정</h2>
      <label for="server">서버</label>
      <input id="server" type="text" value="${esc(state.server)}" ${status.running ? "disabled" : ""} />
      <button class="ghost" id="pick" ${status.running ? "disabled" : ""}>
        ${state.folder ? "다른 폴더 선택" : "공유할 폴더 선택"}
      </button>
      ${
        status.running
          ? `<button class="danger" id="stop">에이전트 중지</button>`
          : `<button id="connect" ${busy ? "disabled" : ""}>${busy ?? (state.drive ? "드라이브 켜기" : "로그인하고 공유 시작")}</button>`
      }
      ${url ? `<button class="ghost" id="open">브라우저에서 드라이브 열기</button>` : ""}
      ${errorMsg ? `<div class="err-box">${esc(errorMsg)}</div>` : ""}
      <p class="note">공유는 에이전트가 실행 중일 때만 가능합니다. 앱이 백그라운드에 있어도 포그라운드 서비스로 계속 동작합니다.</p>
    </div>

    <div class="card">
      <h2>활동</h2>
      <div class="log">${logLines.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>아직 활동이 없습니다</div>"}</div>
      ${state.drive ? `<button class="danger" id="unpair">이 드라이브 페어링 해제</button>` : ""}
    </div>
  `;

  bind("pick", chooseFolder);
  bind("connect", connect);
  bind("stop", stopAgent);
  bind("open", openDrive);
  bind("unpair", unpair);
  const serverInput = document.getElementById("server") as HTMLInputElement | null;
  serverInput?.addEventListener("change", () => {
    state.server = serverInput.value;
    void save();
  });
}

function bind(id: string, fn: () => void) {
  document.getElementById(id)?.addEventListener("click", fn);
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- boot

async function boot() {
  await load();
  try { status = await AindriveAgent.status(); } catch { /* plugin absent in browser dev */ }
  await AindriveAgent.addListener("statusChanged", (s) => {
    const wasConnected = status.connected;
    status = s;
    if (s.connected && !wasConnected) log("서버에 연결됨");
    if (!s.connected && wasConnected) log("서버 연결 끊김 — 재연결 시도 중");
    if (s.lastError) log(`에이전트: ${s.lastError}`);
    render();
  }).catch(() => {});
  App.addListener("resume", () => {
    AindriveAgent.status().then((s) => { status = s; render(); }).catch(() => {});
  });
  render();
}

void boot();

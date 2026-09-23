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
    log(`Folder selected: ${folder.label}`);
  } catch (e) {
    errorMsg = msgOf(e);
  }
  render();
}

async function login() {
  errorMsg = null;
  try {
    state.server = normalizeServer(state.server);
    await save();
    busy = "Waiting for login approval in the browser…"; render();
    const start = await startCliLogin(state.server);
    const url = `${state.server}/cli-login/${start.linkId}`;
    log(`Opening login link: ${url}`);
    await Browser.open({ url });

    const approved = await pollUntilApproved(state.server, start.linkId, start.deviceSecret);
    await Browser.close().catch(() => {});
    state.sessionCookie = approved.token;
    state.email = approved.email;
    await save();
    log(`Logged in${approved.email ? ` (${approved.email})` : ""}`);
  } catch (e) {
    errorMsg = msgOf(e);
    log(`Error: ${errorMsg}`);
  } finally {
    busy = null;
    render();
  }
}

async function logout() {
  await AindriveAgent.stop().catch(() => {});
  state = { server: state.server };
  await save();
  log("Logged out — stored credentials deleted");
  render();
}

async function startSharing() {
  errorMsg = null;
  if (!state.sessionCookie) { errorMsg = "Log in first."; return render(); }
  if (!state.folder) { errorMsg = "Pick a folder to share first."; return render(); }

  try {
    if (!state.drive) {
      busy = "Pairing drive…"; render();
      const paired = await pairDrive(state.server, state.sessionCookie, state.folder.label);
      state.drive = {
        driveId: paired.driveId,
        agentToken: paired.agentToken,
        driveSecret: paired.driveSecret,
        url: paired.url,
      };
      if (paired.serverUrl) state.server = normalizeServer(paired.serverUrl);
      await save();
      log(`Paired: ${paired.driveId}`);
    }

    busy = "Starting agent…"; render();
    status = await AindriveAgent.start({
      serverUrl: state.server,
      driveId: state.drive!.driveId,
      agentToken: state.drive!.agentToken,
      driveSecret: state.drive!.driveSecret,
      folderUri: state.folder.uri,
    });
    log("Agent running — drive online");
  } catch (e) {
    errorMsg = msgOf(e);
    log(`Error: ${errorMsg}`);
  } finally {
    busy = null;
    render();
  }
}

async function pollUntilApproved(server: string, linkId: string, deviceSecret: string) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastNetErr: string | null = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let r;
    try {
      r = await pollCliLogin(server, linkId, deviceSecret);
    } catch (e) {
      // The system browser takes the foreground while the user approves, and
      // the network can flap (DNS/route) for a moment. A transport failure is
      // not a server verdict — keep polling until the link's own deadline.
      if (!isTransportError(e)) throw e;
      const m = msgOf(e);
      if (m !== lastNetErr) { lastNetErr = m; log(`Network hiccup, retrying: ${m}`); }
      continue;
    }
    if (r) return r;
  }
  throw new Error("Timed out waiting for login approval");
}

async function stopAgent() {
  try { status = await AindriveAgent.stop(); log("Agent stopped — drive offline"); }
  catch (e) { errorMsg = msgOf(e); }
  render();
}

async function openDrive() {
  const url = driveUrl();
  if (url) await Browser.open({ url });
}

async function unpair() {
  await AindriveAgent.stop().catch(() => {});
  const { server, sessionCookie, email } = state;
  state = { server, sessionCookie, email };
  await save();
  log("Unpaired — drive credentials deleted");
  render();
}

// ---------------------------------------------------------------- render

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  const url = driveUrl();
  const dot = status.connected ? "on" : status.lastError ? "err" : "off";
  const stateLabel = status.connected ? "Online" : status.running ? "Connecting…" : "Offline";
  const err = errorMsg ? `<div class="err-box">${esc(errorMsg)}</div>` : "";
  const activity = `
    <div class="card">
      <h2>Activity</h2>
      <div class="log">${logLines.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>No activity yet</div>"}</div>
    </div>`;

  // Step 1 — not logged in: server + login only.
  if (!state.sessionCookie) {
    app.innerHTML = `
      <h1>aindrive</h1>
      <p class="sub">Share a folder on this phone as a drive. Files stay on the device; the server only relays signed RPCs.</p>

      <div class="card">
        <h2>Log in</h2>
        <label for="server">Server</label>
        <input id="server" type="text" value="${esc(state.server)}" ${busy ? "disabled" : ""} />
        <button id="login" ${busy ? "disabled" : ""}>${busy ?? "Log in"}</button>
        ${err}
        <p class="note">Login opens in your browser. Approve it there and come back to this app.</p>
      </div>
      ${activity}
    `;
    bind("login", login);
    bindServerInput();
    return;
  }

  // Step 2 / 3 — logged in: pick a folder and share, then control the agent.
  app.innerHTML = `
    <h1>aindrive</h1>
    <p class="sub">Share a folder on this phone as a drive. Files stay on the device; the server only relays signed RPCs.</p>

    <div class="card">
      <h2>Status</h2>
      <div class="row"><span class="k">Account</span><span class="v">${esc(state.email ?? "Logged in")}</span></div>
      <div class="row"><span class="k">Server</span><span class="v mono">${esc(state.server)}</span></div>
      <div class="row"><span class="k">Agent</span><span class="v"><span class="dot ${dot}"></span>${stateLabel}</span></div>
      <div class="row"><span class="k">Shared folder</span><span class="v">${esc(state.folder?.label ?? "Not selected")}</span></div>
      <div class="row"><span class="k">Drive ID</span><span class="v mono">${esc(state.drive?.driveId ?? "-")}</span></div>
      <div class="row"><span class="k">Requests served</span><span class="v mono">${status.rpcCount}</span></div>
    </div>

    <div class="card">
      <h2>${state.drive ? "Drive" : "Set up sharing"}</h2>
      <button class="ghost" id="pick" ${status.running ? "disabled" : ""}>
        ${state.folder ? "Choose a different folder" : "Choose a folder to share"}
      </button>
      ${
        status.running
          ? `<button class="danger" id="stop">Stop agent</button>`
          : `<button id="start" ${busy || !state.folder ? "disabled" : ""}>${busy ?? (state.drive ? "Turn drive on" : "Start sharing")}</button>`
      }
      ${url ? `<button class="ghost" id="open">Open drive in browser</button>` : ""}
      ${err}
      <p class="note">Sharing works only while the agent is running. It keeps running as a foreground service even when the app is in the background.</p>
    </div>

    ${activity}

    <div class="card">
      <h2>Account</h2>
      ${state.drive ? `<button class="ghost" id="unpair">Unpair this drive</button>` : ""}
      <button class="danger" id="logout" ${status.running ? "disabled" : ""}>Log out</button>
    </div>
  `;

  bind("pick", chooseFolder);
  bind("start", startSharing);
  bind("stop", stopAgent);
  bind("open", openDrive);
  bind("unpair", unpair);
  bind("logout", logout);
}

function bindServerInput() {
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

/** fetch()/CapacitorHttp rejections (DNS, offline, reset) — never HTTP statuses. */
function isTransportError(e: unknown): boolean {
  const m = msgOf(e);
  return /failed to fetch|resolve host|unknownhost|network|timed? ?out|econn|socket|unreachable/i.test(m)
    && !/→ \d{3}:/.test(m);
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
    if (s.connected && !wasConnected) log("Connected to server");
    if (!s.connected && wasConnected) log("Disconnected from server — reconnecting");
    if (s.lastError) log(`Agent: ${s.lastError}`);
    render();
  }).catch(() => {});
  App.addListener("resume", () => {
    AindriveAgent.status().then((s) => { status = s; render(); }).catch(() => {});
  });
  render();
}

void boot();

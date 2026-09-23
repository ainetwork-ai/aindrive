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
import { AindriveAgent, IDLE_STATUS, type AgentStatus, type DriveStatus, type PickedFolder } from "./plugin";
import { normalizeServer, startCliLogin, pollCliLogin, pairDrive } from "./api";

const DEFAULT_SERVER = "https://aindrive.ainetwork.ai";
const STORE_KEY = "aindrive.mobile.state.v2";
/** Pre-multi-folder layout: one `folder` + one `drive` at the top level. */
const LEGACY_STORE_KEY = "aindrive.mobile.state.v1";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

interface DriveCreds { driveId: string; agentToken: string; driveSecret: string; url?: string }

/** One shared folder. `drive` is set once it has been paired with the server. */
interface SharedFolder {
  folder: PickedFolder;
  drive?: DriveCreds;
}

interface SavedState {
  server: string;
  sessionCookie?: string;
  email?: string;
  /** Every folder the user has chosen to share, in the order they were added. */
  shares: SharedFolder[];
}

interface LegacyState {
  server?: string;
  sessionCookie?: string;
  email?: string;
  folder?: PickedFolder;
  drive?: DriveCreds;
}

let state: SavedState = { server: DEFAULT_SERVER, shares: [] };
let status: AgentStatus = IDLE_STATUS;
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
    if (!Array.isArray(state.shares)) state.shares = [];
    return;
  }
  // First launch after the multi-folder update: lift the single folder/drive
  // into the list so an existing pairing keeps working without re-pairing.
  const legacy = await Preferences.get({ key: LEGACY_STORE_KEY });
  if (!legacy.value) return;
  try {
    const old = JSON.parse(legacy.value) as LegacyState;
    state = {
      server: old.server || DEFAULT_SERVER,
      sessionCookie: old.sessionCookie,
      email: old.email,
      shares: old.folder ? [{ folder: old.folder, drive: old.drive }] : [],
    };
    await save();
    await Preferences.remove({ key: LEGACY_STORE_KEY });
  } catch { /* corrupt → defaults */ }
}

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  logLines.unshift(`${ts}  ${msg}`);
  if (logLines.length > 120) logLines.pop();
  render();
}

function driveUrl(share: SharedFolder): string | null {
  if (!share.drive) return null;
  return share.drive.url || `${state.server}/d/${share.drive.driveId}`;
}

function driveStatus(share: SharedFolder): DriveStatus | undefined {
  const id = share.drive?.driveId;
  return id ? status.drives.find((d) => d.driveId === id) : undefined;
}

/** Stable key for a share: the folder handle (unique per SAF grant / bookmark). */
function shareKey(share: SharedFolder): string {
  return share.folder.uri;
}

function findShare(key: string): SharedFolder | undefined {
  return state.shares.find((s) => shareKey(s) === key);
}

// ---------------------------------------------------------------- actions

async function addFolder() {
  errorMsg = null;
  try {
    const folder = await AindriveAgent.pickFolder();
    if (findShare(folder.uri)) {
      errorMsg = `"${folder.label}" is already shared.`;
      return render();
    }
    state.shares.push({ folder });
    await save();
    log(`Folder added: ${folder.label}`);
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
  state = { server: state.server, shares: [] };
  await save();
  log("Logged out — stored credentials deleted");
  render();
}

async function startShare(share: SharedFolder) {
  errorMsg = null;
  if (!state.sessionCookie) { errorMsg = "Log in first."; return render(); }

  try {
    if (!share.drive) {
      busy = `Pairing ${share.folder.label}…`; render();
      const paired = await pairDrive(state.server, state.sessionCookie, share.folder.label);
      share.drive = {
        driveId: paired.driveId,
        agentToken: paired.agentToken,
        driveSecret: paired.driveSecret,
        url: paired.url,
      };
      if (paired.serverUrl) state.server = normalizeServer(paired.serverUrl);
      await save();
      log(`Paired ${share.folder.label}: ${paired.driveId}`);
    }

    busy = `Starting ${share.folder.label}…`; render();
    status = await AindriveAgent.start({
      serverUrl: state.server,
      driveId: share.drive.driveId,
      agentToken: share.drive.agentToken,
      driveSecret: share.drive.driveSecret,
      folderUri: share.folder.uri,
      folderLabel: share.folder.label,
    });
    log(`${share.folder.label} online`);
  } catch (e) {
    errorMsg = msgOf(e);
    log(`Error: ${errorMsg}`);
  } finally {
    busy = null;
    render();
  }
}

/** Turn on every paired-or-not folder that is not already being served. */
async function startAll() {
  for (const share of state.shares) {
    if (driveStatus(share)?.running) continue;
    await startShare(share);
    if (errorMsg) break;
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

async function stopShare(share: SharedFolder) {
  if (!share.drive) return;
  try {
    status = await AindriveAgent.stop({ driveId: share.drive.driveId });
    log(`${share.folder.label} offline`);
  } catch (e) { errorMsg = msgOf(e); }
  render();
}

async function stopAll() {
  try { status = await AindriveAgent.stop(); log("All drives offline"); }
  catch (e) { errorMsg = msgOf(e); }
  render();
}

async function openDrive(share: SharedFolder) {
  const url = driveUrl(share);
  if (url) await Browser.open({ url });
}

/** Forget a folder: takes its drive offline and drops its credentials. */
async function removeShare(share: SharedFolder) {
  if (share.drive) await AindriveAgent.stop({ driveId: share.drive.driveId }).catch(() => {});
  state.shares = state.shares.filter((s) => s !== share);
  await save();
  try { status = await AindriveAgent.status(); } catch { /* browser dev */ }
  log(`Removed ${share.folder.label}${share.drive ? " — drive credentials deleted" : ""}`);
  render();
}

// ---------------------------------------------------------------- render

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  const err = errorMsg ? `<div class="err-box">${esc(errorMsg)}</div>` : "";
  const activity = `
    <div class="card">
      <h2>Activity</h2>
      <div class="log">${logLines.map((l) => `<div>${esc(l)}</div>`).join("") || "<div>No activity yet</div>"}</div>
    </div>`;
  const intro = `
    <h1>aindrive</h1>
    <p class="sub">Share folders on this phone as drives. Files stay on the device; the server only relays signed RPCs.</p>`;

  // Step 1 — not logged in: server + login only.
  if (!state.sessionCookie) {
    app.innerHTML = `
      ${intro}
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

  // Step 2 — logged in: one card per shared folder, plus "add folder".
  const online = status.drives.filter((d) => d.connected).length;
  const running = status.drives.filter((d) => d.running).length;
  const agentDot = online > 0 ? "on" : running > 0 ? "err" : "off";
  const agentLabel = running === 0 ? "Offline"
    : online === running ? `Online (${online} ${online === 1 ? "drive" : "drives"})`
    : `Online ${online}/${running}`;
  const idle = state.shares.some((s) => !driveStatus(s)?.running);

  const shareCards = state.shares.map((share) => {
    const key = shareKey(share);
    const d = driveStatus(share);
    const dot = d?.connected ? "on" : d?.running ? "err" : "off";
    const label = d?.connected ? "Online" : d?.running ? (d.lastError ? "Reconnecting…" : "Connecting…") : "Offline";
    const url = driveUrl(share);
    return `
      <div class="card" data-share="${esc(key)}">
        <h2>${esc(share.folder.label)}</h2>
        <div class="row"><span class="k">Status</span><span class="v"><span class="dot ${dot}"></span>${label}</span></div>
        <div class="row"><span class="k">Drive ID</span><span class="v mono">${esc(share.drive?.driveId ?? "Not paired yet")}</span></div>
        <div class="row"><span class="k">Requests served</span><span class="v mono">${d?.rpcCount ?? 0}</span></div>
        ${d?.lastError && !d.connected ? `<div class="err-box">${esc(d.lastError)}</div>` : ""}
        ${
          d?.running
            ? `<button class="danger" data-act="stop">Turn off</button>`
            : `<button data-act="start" ${busy ? "disabled" : ""}>${share.drive ? "Turn on" : "Start sharing"}</button>`
        }
        ${url ? `<button class="ghost" data-act="open">Open drive in browser</button>` : ""}
        <button class="ghost" data-act="remove" ${d?.running || busy ? "disabled" : ""}>Remove folder</button>
      </div>`;
  }).join("");

  app.innerHTML = `
    ${intro}
    <div class="card">
      <h2>Status</h2>
      <div class="row"><span class="k">Account</span><span class="v">${esc(state.email ?? "Logged in")}</span></div>
      <div class="row"><span class="k">Server</span><span class="v mono">${esc(state.server)}</span></div>
      <div class="row"><span class="k">Agent</span><span class="v"><span class="dot ${agentDot}"></span>${agentLabel}</span></div>
      <div class="row"><span class="k">Shared folders</span><span class="v mono">${state.shares.length}</span></div>
      ${busy ? `<p class="note">${esc(busy)}</p>` : ""}
      ${err}
    </div>

    ${shareCards || `<div class="card"><h2>Shared folders</h2><p class="note">No folders yet. Add one below — each folder becomes its own drive.</p></div>`}

    <div class="card">
      <h2>Add</h2>
      <button class="ghost" id="add" ${busy ? "disabled" : ""}>Add a folder to share</button>
      ${state.shares.length > 1 ? `
        <button id="start-all" ${busy || !idle ? "disabled" : ""}>Turn all on</button>
        <button class="danger" id="stop-all" ${running === 0 ? "disabled" : ""}>Turn all off</button>` : ""}
      <p class="note">Sharing works only while the agent is running. It keeps running as a foreground service even when the app is in the background.</p>
    </div>

    ${activity}

    <div class="card">
      <h2>Account</h2>
      <button class="danger" id="logout" ${running > 0 ? "disabled" : ""}>Log out</button>
    </div>
  `;

  bind("add", addFolder);
  bind("start-all", startAll);
  bind("stop-all", stopAll);
  bind("logout", logout);
  app.querySelectorAll<HTMLElement>("[data-share]").forEach((card) => {
    const share = findShare(card.dataset.share!);
    if (!share) return;
    card.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
      const act = btn.dataset.act;
      btn.addEventListener("click", () => {
        if (act === "start") void startShare(share);
        else if (act === "stop") void stopShare(share);
        else if (act === "open") void openDrive(share);
        else if (act === "remove") void removeShare(share);
      });
    });
  });
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
    const before = new Map(status.drives.map((d) => [d.driveId, d]));
    status = s;
    for (const d of s.drives) {
      const prev = before.get(d.driveId);
      const name = d.folderLabel ?? d.driveId;
      if (d.connected && !prev?.connected) log(`${name}: connected`);
      if (!d.connected && prev?.connected) log(`${name}: disconnected — reconnecting`);
      if (d.lastError && d.lastError !== prev?.lastError) log(`${name}: ${d.lastError}`);
    }
    render();
  }).catch(() => {});
  App.addListener("resume", () => {
    AindriveAgent.status().then((s) => { status = s; render(); }).catch(() => {});
  });
  render();
}

void boot();

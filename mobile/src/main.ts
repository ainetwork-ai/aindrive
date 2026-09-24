/**
 * aindrive mobile shell.
 *
 * This screen only PAIRS and CONTROLS — it never touches files. Pairing
 * follows the same flow as `aindrive login` on desktop (cli/src/commands/
 * login.js): ask the server for a single-use link, open it in the system
 * browser, poll until the user approves, then create the drive. The resulting
 * driveId/agentToken/driveSecret are handed to the native agent service,
 * which is what actually serves the picked device folder.
 *
 * UI principles: one primary action per screen, a switch for on/off state, an
 * overflow menu for the rare and destructive actions, no developer detail on
 * the surface, and feedback via toasts instead of boxes that appear mid-page.
 */
import { Preferences } from "@capacitor/preferences";
import { Browser } from "@capacitor/browser";
import { App } from "@capacitor/app";
import { AindriveAgent, IDLE_STATUS, type FileEntry, type AgentStatus, type AskResult, type DriveStatus, type PickedFolder } from "./plugin";
import { normalizeServer, startCliLogin, pollCliLogin, pairDrive, deleteDrive, createShare, listDrives, remoteList, remoteRead, ensureRemoteAgent, askRemote, type RemoteDrive } from "./api";

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
  /** Label of the folder this one lives in — agent-made folders are drives of their own but sit inside a picked folder. */
  parent?: string;
  /** The switch was on when the app last ran: turn it back on at launch (a reinstall or reboot must not silently take drives offline). */
  on?: boolean;
}

interface SavedState {
  server: string;
  sessionCookie?: string;
  email?: string;
  /** Every folder the user has chosen to share, in the order they were added. */
  shares: SharedFolder[];
  /** Agent sources: folders the agent may read for its tasks, never served. */
  sources?: AgentSource[];
}

/** One folder the agent may read. `preset` marks the two suggested ones (call recordings, camera roll). */
interface AgentSource { id: string; folder: PickedFolder; preset?: PresetId }
type PresetId = "src-calls" | "src-photos";
/** Suggested first: Samsung's call recordings and the camera roll. Any other folder can be added too. */
const PRESETS: { id: PresetId; label: string; hint: string; initial: string }[] = [
  { id: "src-calls", label: "Call recordings", hint: "For \"who do I talk to most, and about what\" — the Call folder", initial: "Call" },
  { id: "src-photos", label: "Camera photos", hint: "For \"collect this month's food photos\" — DCIM", initial: "DCIM" },
];

interface LegacyState {
  server?: string;
  sessionCookie?: string;
  email?: string;
  folder?: PickedFolder;
  drive?: DriveCreds;
}

interface Activity { at: number; msg: string }

let state: SavedState = { server: DEFAULT_SERVER, shares: [] };
let status: AgentStatus = IDLE_STATUS;
const activity: Activity[] = [];
/** Folder keys with an action in flight — drives the switch's busy look. */
const busyShares = new Set<string>();
let busy: string | null = null;
let askQuery = "";
let askResult: AskResult | null = null;
/** One exchange with the agent. The thread is the conversation: kept across launches, cleared with "New chat". */
interface Turn { q: string; r?: AskResult; error?: string; at: number }
let thread: Turn[] = [];
/** The last turn's effective filters (AskResult.context): what "them" / "those" mean next time. */
let askContext: Record<string, unknown> | null = null;
const THREAD_KEY = "aindrive.mobile.thread.v1";
const THREAD_MAX = 40;
let askBusy = false;
let searchOpen = false;
let menuFor: string | null = null;
/** In-app file browser: which share, where in it, what we saw there. */
let browse: {
  key: string;
  /** Set when browsing a drive on another device (through the server relay). */
  remote?: RemoteDrive;
  path: string;
  entries: FileEntry[] | null;
  error: string | null;
  loading: boolean;
  menu: string | null;   // entry path whose ⋯ menu is open
  plusMenu: boolean;      // "+" menu (new folder / add files)
} | null = null;
let showAllActivity = false;
/** In-app viewer: what is open (images and audio play here; everything else goes to the OS). */
let viewer: { share?: SharedFolder; remote?: RemoteDrive; path: string; name: string; mime: string; src?: string; loading: boolean } | null = null;
/** Drives this account has on OTHER devices (same login on another phone / laptop). */
let remotes: RemoteDrive[] = [];
let remotesAt = 0;
/** agentId per remote drive, created on first ask (the record lives in that drive). */
const remoteAgents = new Map<string, string>();
/** Share link minted for the agent's last collected folder. */
let actionShare: { folder: string; url?: string; busy: boolean; error?: string } | null = null;
let toast: { msg: string; error?: boolean; timer?: number } | null = null;
let confirmSheet: { title: string; body: string; ok: string; danger?: boolean; resolve: (v: boolean) => void } | null = null;

async function save() {
  await Preferences.set({ key: STORE_KEY, value: JSON.stringify(state) });
}

async function saveThread() {
  thread = thread.slice(-THREAD_MAX);
  try { await Preferences.set({ key: THREAD_KEY, value: JSON.stringify({ thread, context: askContext }) }); } catch { /* best effort */ }
}

async function loadThread() {
  try {
    const { value } = await Preferences.get({ key: THREAD_KEY });
    if (!value) return;
    const t = JSON.parse(value) as { thread?: Turn[]; context?: Record<string, unknown> | null };
    thread = Array.isArray(t.thread) ? t.thread : [];
    askContext = t.context ?? null;
    askResult = thread.length ? thread[thread.length - 1].r ?? null : null;
  } catch { thread = []; askContext = null; }
}

async function newChat() {
  thread = []; askContext = null; askResult = null; askQuery = ""; actionShare = null;
  await saveThread();
  render();
  (document.getElementById("ask-input") as HTMLInputElement | null)?.focus();
}

async function load() {
  const { value } = await Preferences.get({ key: STORE_KEY });
  if (value) {
    try { state = { ...state, ...JSON.parse(value) }; } catch { /* corrupt → defaults */ }
    if (!Array.isArray(state.shares)) state.shares = [];
    if (state.sources && !Array.isArray(state.sources)) {
      // first shape: { "src-calls": folder, "src-photos": folder }
      const old = state.sources as unknown as Record<string, PickedFolder>;
      state.sources = Object.entries(old).map(([id, folder]) => ({ id, folder, preset: id as PresetId }));
    }
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

// ---------------------------------------------------------------- feedback

function log(msg: string) {
  activity.unshift({ at: Date.now(), msg });
  if (activity.length > 120) activity.pop();
  render();
}

/** Non-blocking feedback. Errors stay until dismissed; successes fade. */
function notify(msg: string, error = false) {
  if (toast?.timer) clearTimeout(toast.timer);
  toast = { msg, error };
  if (!error) toast.timer = window.setTimeout(() => { toast = null; render(); }, 3200);
  render();
}

function fail(e: unknown) {
  const m = msgOf(e);
  log(`Error: ${m}`);
  notify(m, true);
}

/** In-app confirmation sheet instead of the WebView's native confirm(). */
function confirmAsync(title: string, body: string, ok: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    confirmSheet = { title, body, ok, danger, resolve: (v) => { confirmSheet = null; resolve(v); render(); } };
    render();
  });
}

// ---------------------------------------------------------------- helpers

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

function shareByDrive(driveId: string | undefined): SharedFolder | undefined {
  if (driveId) return state.shares.find((s) => s.drive?.driveId === driveId);
  const running = state.shares.filter((s) => driveStatus(s)?.running);
  return running.length === 1 ? running[0] : undefined;
}

// ---------------------------------------------------------------- other devices

function localDriveIds(): Set<string> {
  return new Set(state.shares.map((s) => s.drive?.driveId).filter((x): x is string => !!x));
}

/** Drives owned by this account that this phone does not serve. Cached 30 s. */
async function refreshRemotes(force = false) {
  if (!state.sessionCookie) { remotes = []; return; }
  if (!force && Date.now() - remotesAt < 30_000) return;
  try {
    const all = await listDrives(state.server, state.sessionCookie);
    const mine = localDriveIds();
    remotes = all.filter((d) => !mine.has(d.id));
    remotesAt = Date.now();
    render();
  } catch (e) {
    log(`Could not list other devices: ${msgOf(e)}`);
  }
}

async function openRemoteBrowser(drive: RemoteDrive, path = "") {
  menuFor = null;
  browse = { key: "remote:" + drive.id, remote: drive, path, entries: null, error: null, loading: true, menu: null, plusMenu: false };
  render();
  await loadBrowse();
}

async function viewRemoteFile(drive: RemoteDrive, path: string, mime?: string) {
  const name = path.split("/").pop() ?? path;
  const m = mime || guessMime(name);
  if (!(m.startsWith("image/") || m.startsWith("audio/"))) {
    // Anything else: the web has the right viewer/download for it.
    await Browser.open({ url: `${state.server}/d/${drive.id}?path=${encodeURIComponent(path.split("/").slice(0, -1).join("/"))}` });
    return;
  }
  viewer = { remote: drive, path, name, mime: m, loading: true };
  render();
  try {
    const r = await remoteRead(state.server, state.sessionCookie!, drive.id, path);
    if (viewer && viewer.path === path) { viewer.src = `data:${r.mime || m};base64,${r.base64}`; viewer.mime = r.mime || m; viewer.loading = false; }
  } catch (e) {
    viewer = null;
    notify(msgOf(e), true);
  }
  render();
}

// ---------------------------------------------------------------- actions

async function addFolder() {
  try {
    const folder = await AindriveAgent.pickFolder();
    if (findShare(folder.uri)) {
      notify(`"${folder.label}" is already shared.`, true);
      return;
    }
    const share: SharedFolder = { folder };
    state.shares.push(share);
    await save();
    log(`Folder added: ${folder.label}`);
    // Adding a folder means sharing it — go straight to online, no second tap.
    await startShare(share);
  } catch (e) {
    if (!/cancel/i.test(msgOf(e))) fail(e);
    render();
  }
}

/** Copy files picked in the system picker into a shared folder. */
async function addFiles(share: SharedFolder, path = "") {
  const key = shareKey(share);
  busyShares.add(key); render();
  try {
    const r = await AindriveAgent.addFiles({ folderUri: share.folder.uri, path });
    if (r.added.length) {
      log(`Added ${r.added.length} file${r.added.length === 1 ? "" : "s"} to ${share.folder.label}: ${r.added.join(", ")}`);
      notify(`Added ${r.added.length} file${r.added.length === 1 ? "" : "s"} to ${share.folder.label}`);
    }
    for (const f of r.failed) log(`Could not add ${f}`);
    if (r.failed.length && !r.added.length) notify(r.failed[0], true);
  } catch (e) {
    if (!/cancel/i.test(msgOf(e))) fail(e);
  } finally {
    busyShares.delete(key);
    if (browse?.key === key) await loadBrowse();
    render();
  }
}

// ---------------------------------------------------------------- file browser
//
// Reads the shared folder locally through the native plugin — the same tree
// the agent serves — so it works offline and while the drive is off. Basic
// file-manager verbs only: navigate, open, new folder, add files, rename,
// delete. Anything richer (sharing, selling, previews) is the web UI's job.

function browseShare(): SharedFolder | undefined {
  if (!browse) return undefined;
  if (browse.remote) return REMOTE_SHARE;   // stand-in so the browser code paths stay shared
  return findShare(browse.key);
}

/** A placeholder "share" for remote browsing; the folder handle is never used there. */
const REMOTE_SHARE: SharedFolder = { folder: { uri: "remote", label: "" } };

async function openBrowser(share: SharedFolder, path = "") {
  menuFor = null;
  browse = { key: shareKey(share), path, entries: null, error: null, loading: true, menu: null, plusMenu: false };
  render();
  await loadBrowse();
}

async function loadBrowse() {
  const share = browseShare();
  if (!browse || !share) return;
  if (browse.remote) share.folder.label = browse.remote.name;
  browse.loading = true; browse.error = null; browse.menu = null; browse.plusMenu = false;
  render();
  try {
    if (browse.remote) {
      const entries = await remoteList(state.server, state.sessionCookie!, browse.remote.id, browse.path);
      if (!browse) return;
      browse.entries = entries.map((e) => ({ name: e.name, path: e.path, isDir: e.isDir, size: e.size, mtimeMs: e.mtimeMs, mime: e.mime ?? guessMime(e.name) }));
    } else {
      const r = await AindriveAgent.listFolder({ folderUri: share.folder.uri, path: browse.path });
      if (!browse) return;
      browse.entries = r.entries;
    }
  } catch (e) {
    if (browse) { browse.entries = []; browse.error = msgOf(e); }
  } finally {
    if (browse) browse.loading = false;
    render();
  }
}

/** Back: up one level, or close the browser at the root. */
function browseBack() {
  if (!browse) return;
  if (browse.menu || browse.plusMenu) { browse.menu = null; browse.plusMenu = false; render(); return; }
  if (!browse.path) { browse = null; render(); return; }
  browse.path = browse.path.split("/").slice(0, -1).join("/");
  void loadBrowse();
}

async function browseOpen(entry: FileEntry) {
  const share = browseShare();
  if (!browse || !share) return;
  if (entry.isDir) { browse.path = entry.path; await loadBrowse(); return; }
  if (browse.remote) { await viewRemoteFile(browse.remote, entry.path, entry.mime); return; }
  await viewFile(share, entry.path, entry.mime);
}

/**
 * Open a file the way a person expects: images and audio right here in the
 * app (no chooser, no web), everything else with the phone's own app.
 */
async function viewFile(share: SharedFolder, path: string, mime?: string) {
  const name = path.split("/").pop() ?? path;
  const m = mime || guessMime(name);
  if (m.startsWith("image/") || m.startsWith("audio/")) {
    viewer = { share, path, name, mime: m, loading: true };
    render();
    try {
      const r = await AindriveAgent.readFile({ folderUri: share.folder.uri, path, maxPx: 1600 });
      if (viewer && viewer.path === path) { viewer.src = `data:${r.mime};base64,${r.base64}`; viewer.mime = r.mime; viewer.loading = false; }
    } catch (e) {
      viewer = null;
      notify(msgOf(e), true);
    }
    render();
    return;
  }
  try { await AindriveAgent.openFile({ folderUri: share.folder.uri, path }); }
  catch (e) { notify(msgOf(e), true); }
}

function guessMime(name: string): string {
  const e = (name.split(".").pop() ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp"].includes(e)) return "image/" + (e === "jpg" ? "jpeg" : e);
  if (["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "amr"].includes(e)) return "audio/" + e;
  if (["mp4", "mov", "mkv", "webm", "3gp"].includes(e)) return "video/" + e;
  return "application/octet-stream";
}

/**
 * A folder the agent made on this phone becomes a drive of its own — its own
 * row, switch and share link — rather than a sub-folder of the drive it was
 * collected from. The parent is restarted so it stops showing that folder.
 */
async function promoteCollected(a: NonNullable<AskResult["action"]>) {
  const label = a.folder!;
  const parent = shareByDrive(a.driveId);
  let share = findShare(a.folderUri!);
  if (!share) {
    share = { folder: { uri: a.folderUri!, label }, parent: parent?.folder.label };
    state.shares.push(share);
    await save();
    log(`Folder "${label}" added as its own drive`);
  }
  await startShare(share);
  if (parent && driveStatus(parent)?.running) await startShare(parent);
  a.label = label;
  a.folder = "";
  a.driveId = share.drive?.driveId;
}

/** After "…and share it": mint a viewer link for the folder the agent just made. */
async function shareCollected() {
  const a = askResult?.action;
  if (a?.folder === undefined || !state.sessionCookie) return;
  const name = a.label ?? a.folder;
  const share = shareByDrive(a.driveId);
  const driveId = share?.drive?.driveId ?? (remotes.some((d) => d.id === a.driveId) ? a.driveId : undefined);
  if (!driveId) { notify("Turn the folder on to share it.", true); return; }
  actionShare = { folder: name, busy: true };
  render();
  try {
    const r = await createShare(state.server, state.sessionCookie, driveId, a.folder);
    actionShare = { folder: name, url: r.url, busy: false };
    log(`Shared ${name}: ${r.url}`);
    await navigator.clipboard?.writeText(r.url).then(() => notify("Link copied")).catch(() => {});
  } catch (e) {
    actionShare = { folder: name, busy: false, error: msgOf(e) };
    log(`Error: ${msgOf(e)}`);
  }
  render();
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function validName(name: string | null): string | null {
  const n = (name ?? "").trim();
  if (!n || n === "." || n === ".." || n.includes("/")) return null;
  return n;
}

async function browseNewFolder() {
  const share = browseShare();
  if (!browse || !share) return;
  browse.plusMenu = false;
  const name = validName(prompt("New folder name"));
  if (!name) return render();
  try {
    await AindriveAgent.mkdir({ folderUri: share.folder.uri, path: joinPath(browse.path, name) });
    log(`Created folder ${name} in ${share.folder.label}`);
  } catch (e) { notify(msgOf(e), true); }
  await loadBrowse();
}

async function browseRename(entry: FileEntry) {
  const share = browseShare();
  if (!browse || !share) return;
  browse.menu = null;
  const name = validName(prompt("Rename", entry.name));
  if (!name || name === entry.name) return render();
  if (browse.entries?.some((e) => e.name === name)) { notify(`"${name}" already exists here`, true); return; }
  try {
    await AindriveAgent.rename({ folderUri: share.folder.uri, from: entry.path, to: joinPath(browse.path, name) });
    log(`Renamed ${entry.name} → ${name}`);
  } catch (e) { notify(msgOf(e), true); }
  await loadBrowse();
}

async function browseDelete(entry: FileEntry) {
  const share = browseShare();
  if (!browse || !share) return;
  browse.menu = null; render();
  const ok = await confirmAsync(
    `Delete "${entry.name}"?`,
    entry.isDir ? "The folder and everything inside it is deleted from this phone." : "The file is deleted from this phone.",
    "Delete", true,
  );
  if (!ok) return;
  try {
    await AindriveAgent.delete({ folderUri: share.folder.uri, path: entry.path });
    log(`Deleted ${entry.name}`);
  } catch (e) { notify(msgOf(e), true); }
  await loadBrowse();
}

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1; let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

async function login() {
  try {
    state.server = normalizeServer(state.server);
    await save();
    busy = "Waiting for you to approve in the browser…"; render();
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
    fail(e);
  } finally {
    busy = null;
    render();
  }
}

async function logout() {
  const ok = await confirmAsync("Log out?", "Folders on this phone stop being shared and their credentials are removed from this device. Nothing on the server is deleted.", "Log out", true);
  if (!ok) return;
  await AindriveAgent.stop().catch(() => {});
  state = { server: state.server, shares: [] };
  await save();
  log("Logged out — stored credentials deleted");
  render();
}

async function startShare(share: SharedFolder) {
  if (!state.sessionCookie) { notify("Log in first.", true); return; }
  const key = shareKey(share);
  busyShares.add(key); render();
  try {
    if (!share.drive) {
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
    status = await AindriveAgent.start({
      serverUrl: state.server,
      driveId: share.drive.driveId,
      agentToken: share.drive.agentToken,
      driveSecret: share.drive.driveSecret,
      folderUri: share.folder.uri,
      folderLabel: share.folder.label,
      indexOnStart: true,
      excludeUris: state.shares.filter((s) => s !== share).map((s) => s.folder.uri),
    });
    log(`${share.folder.label} online`);
    if (!share.on) { share.on = true; await save(); }
  } catch (e) {
    fail(e);
  } finally {
    busyShares.delete(key);
    render();
  }
}

/** Turn on every paired-or-not folder that is not already being served. */
async function startAll() {
  for (const share of state.shares) {
    if (driveStatus(share)?.running) continue;
    await startShare(share);
  }
  await startSources();
}

// ---------------------------------------------------------------- agent sources

function sourceStatus(id: string): DriveStatus | undefined {
  return status.drives.find((d) => d.driveId === id);
}

/**
 * Let the agent read a folder on this phone. Not shared: it never gets a drive
 * on the server. A preset keeps its fixed id (the native side treats
 * "src-calls" specially); any other folder gets a fresh one.
 */
async function addSource(preset?: PresetId) {
  const def = PRESETS.find((s) => s.id === preset);
  try {
    const folder = await AindriveAgent.pickFolder(def ? { initial: def.initial } : {});
    if (state.sources?.some((s) => s.folder.uri === folder.uri)) { notify(`The agent can already read "${folder.label}".`, true); return; }
    const src: AgentSource = { id: def ? def.id : `src-${Date.now().toString(36)}`, folder, preset };
    state.sources = [...(state.sources ?? []), src];
    await save();
    log(`Agent may read ${folder.label}${def ? ` (${def.label})` : ""}`);
    await startSource(src);
  } catch (e) {
    if (!/cancel/i.test(msgOf(e))) fail(e);
    render();
  }
}

async function startSource(src: AgentSource) {
  busyShares.add(src.id); render();
  try {
    status = await AindriveAgent.start({ serverUrl: state.server, driveId: src.id, agentToken: "", driveSecret: "", folderUri: src.folder.uri, folderLabel: src.folder.label, indexOnStart: true, source: true });
  } catch (e) {
    fail(e);
  } finally {
    busyShares.delete(src.id);
    render();
  }
}

async function startSources() {
  for (const s of state.sources ?? []) if (!sourceStatus(s.id)?.running) await startSource(s);
}

async function removeSource(id: string) {
  await AindriveAgent.stop({ driveId: id }).catch(() => {});
  state.sources = (state.sources ?? []).filter((s) => s.id !== id);
  await save();
  try { status = await AindriveAgent.status(); } catch { /* browser dev */ }
  render();
}

function sourceCard(src: AgentSource): string {
  const def = PRESETS.find((p) => p.id === src.preset);
  const d = sourceStatus(src.id);
  const ix = d?.index;
  const st = busyShares.has(src.id) ? "Starting…" : d?.running ? (ix?.running ? `Indexing ${ix.done}/${ix.total}` : ix?.indexed ? `${ix.indexed.toLocaleString()} files indexed` : "Ready") : "Off";
  return `
    <div class="card" data-source="${esc(src.id)}">
      <div class="folder">
        <div class="glyph">${src.preset === "src-calls" ? I.phone : I.folder}</div>
        <div style="min-width:0;flex:1">
          <div class="name">${esc(def ? def.label : src.folder.label)}${def ? ` <span class="hint">· ${esc(src.folder.label)}</span>` : ""}</div>
          ${def ? `<div class="hint">${esc(def.hint)}</div>` : ""}
          <div class="state"><span class="dot ${d?.running ? "on" : "off"}"></span>${esc(st)}</div>
        </div>
        <button class="btn secondary small" data-act="src-remove">Revoke</button>
      </div>
    </div>`;
}

function sourcesSection(): string {
  const have = new Set((state.sources ?? []).map((s) => s.preset));
  const suggested = PRESETS.filter((p) => !have.has(p.id)).map((p) => `
    <div class="card" data-preset="${p.id}">
      <div class="folder">
        <div class="glyph">${p.id === "src-calls" ? I.phone : I.folder}</div>
        <div style="min-width:0;flex:1">
          <div class="name">${esc(p.label)}</div>
          <div class="hint">${esc(p.hint)}</div>
          <div class="state"><span class="dot off"></span>Not allowed</div>
        </div>
        <button class="btn small" data-act="src-add">Allow</button>
      </div>
    </div>`).join("");
  return `
    <div class="section"><h2>Agent can read</h2><button class="link" id="add-source">${I.plus} Add folder</button></div>
    ${(state.sources ?? []).map(sourceCard).join("")}
    ${suggested}
    <p class="hint">Read only by the agent on this phone, for its tasks. Never shared. What it makes is saved into a shared folder.</p>`;
}

async function allowCallLog() {
  try {
    const r = await AindriveAgent.requestCallLog();
    notify(r.granted ? "Call log access allowed — asking again." : "Call log access was refused.", !r.granted);
    if (r.granted && askQuery) void ask(askQuery);
  } catch (e) { fail(e); }
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
  const key = shareKey(share);
  busyShares.add(key); render();
  try {
    status = await AindriveAgent.stop({ driveId: share.drive.driveId });
    share.on = false; await save();
    log(`${share.folder.label} offline`);
  } catch (e) { fail(e); }
  finally { busyShares.delete(key); render(); }
}

async function stopAll() {
  try { status = await AindriveAgent.stop(); log("All folders offline"); }
  catch (e) { fail(e); }
  render();
}

async function openDrive(share: SharedFolder, path?: string) {
  const url = driveUrl(share);
  if (!url) return;
  const dir = path ? path.split("/").slice(0, -1).join("/") : "";
  await Browser.open({ url: dir ? `${url}?path=${encodeURIComponent(dir)}` : url });
}

/**
 * Forget a folder: takes its drive offline, deletes the drive on the server
 * (so the account gets its drive-limit slot back), and drops the credentials.
 * Files in the folder are untouched.
 */
async function removeShare(share: SharedFolder) {
  const ok = await confirmAsync(
    `Stop sharing "${share.folder.label}"?`,
    share.drive
      ? "The drive is deleted from the server: members lose access and share links stop working. Files on this phone are not deleted."
      : "It is removed from this list. Files on this phone are not deleted.",
    "Remove", true);
  if (!ok) return;
  const key = shareKey(share);
  busyShares.add(key); render();
  if (share.drive) {
    await AindriveAgent.stop({ driveId: share.drive.driveId }).catch(() => {});
    if (state.sessionCookie) {
      try {
        await deleteDrive(state.server, state.sessionCookie, share.drive.driveId);
        log(`Deleted drive ${share.drive.driveId}`);
      } catch (e) {
        const m = `Drive could not be deleted on the server (${msgOf(e)}). It still counts toward your drive limit — delete it from Manage on the web.`;
        log(`Error: ${m}`);
        notify(m, true);
      }
    }
  }
  busyShares.delete(key);
  state.shares = state.shares.filter((s) => s !== share);
  await save();
  try { status = await AindriveAgent.status(); } catch { /* browser dev */ }
  log(`Removed ${share.folder.label}`);
  render();
}

async function ensureModels() {
  try {
    status = await AindriveAgent.ensureModels();
    log("Downloading recognition models…");
  } catch (e) {
    fail(e);
  }
  render();
}

async function reindex() {
  try {
    status = await AindriveAgent.reindex();
    log("Indexing files…");
  } catch (e) {
    fail(e);
  }
  render();
}

/** "share it" / "공유해줘" right after a folder was made: no new search, just the link. */
const SHARE_AGAIN = /^(share (it|that|this|them|the folder)|make a (share )?link|공유(해|해줘|해 줘|하자)?|링크 (만들어|만들어줘|줘))[.!]?$/i;

async function ask(q = askQuery) {
  q = q.trim();
  if (!q) return;
  askQuery = q;
  if (SHARE_AGAIN.test(q) && askResult?.action?.folder !== undefined && !askResult.action.skipped) {
    thread.push({ q, r: { answer: "Sharing the folder I just made.", sources: [], action: askResult.action }, at: Date.now() });
    askQuery = ""; await saveThread(); render();
    await shareCollected();
    return;
  }
  askBusy = true; actionShare = null; render();
  try {
    const localRunning = status.drives.some((d) => d.running);
    const targets = remotes.filter((d) => d.online);
    const [local, ...remoteResults] = await Promise.all([
      localRunning ? AindriveAgent.ask({ query: q, context: askContext ?? undefined }) : Promise.resolve<AskResult | null>(null),
      ...targets.map(async (d) => {
        try {
          const agentId = remoteAgents.get(d.id) ?? await ensureRemoteAgent(state.server, state.sessionCookie!, d.id);
          remoteAgents.set(d.id, agentId);
          const r = await askRemote(state.server, state.sessionCookie!, d.id, agentId, q);
          return { drive: d, r, error: null as string | null, skipped: false };
        } catch (e) {
          // A drive shared TO this account (not owned) has no agent we may create: leave it out quietly.
          if (/403|not_owner/.test(msgOf(e))) return { drive: d, r: null, error: null, skipped: true };
          return { drive: d, r: null, error: msgOf(e) };
        }
      }),
    ]);
    // Merge: this phone first, then each other device, sources tagged with where they live.
    const merged: AskResult = { answer: "", sources: [] };
    const parts: string[] = [];
    if (local) { parts.push(targets.length ? `This phone: ${local.answer}` : local.answer); merged.sources.push(...local.sources); merged.action = local.action; }
    for (const rr of remoteResults) {
      if ((rr as { skipped?: boolean }).skipped) continue;
      if (rr.error) { parts.push(`${rr.drive.name}: couldn't ask (${rr.error})`); continue; }
      const r = rr.r!;
      parts.push(`${rr.drive.name}: ${r.answer}`);
      merged.sources.push(...r.sources.map((s) => ({ ...s, driveId: rr.drive.id, remoteName: rr.drive.name, matchedBy: s.matchedBy as AskResult["sources"][number]["matchedBy"] })));
      if (!merged.action && r.action && !r.action.skipped) merged.action = { ...(r.action as NonNullable<AskResult["action"]>), driveId: rr.drive.id };
    }
    if (!local && !targets.length) throw new Error("Turn a folder on, or have another device online, to ask.");
    merged.answer = parts.join("\n");
    askResult = merged;
    if (local?.context && typeof local.context === "object") askContext = local.context as Record<string, unknown>;
    thread.push({ q, r: merged, at: Date.now() });
    askQuery = "";
    await saveThread();
    log(`Asked: ${q} → ${askResult.sources.length} result${askResult.sources.length === 1 ? "" : "s"}${targets.length ? ` across ${1 + targets.length} devices` : ""}`);
    const a = askResult.action;
    if (a?.folder) log(`Agent made folder "${a.folder}" with ${a.copied} file${a.copied === 1 ? "" : "s"}`);
    if (a?.folder && a.folderUri && shareByDrive(a.driveId)) await promoteCollected(a);
    if (a && a.label !== undefined && a.share) void shareCollected();
  } catch (e) {
    fail(e);
    askResult = null;
    thread.push({ q, error: msgOf(e), at: Date.now() });
    await saveThread();
  } finally {
    askBusy = false;
    render();
  }
}

function openSearch() {
  if (!status.drives.some((d) => d.running) && !remotes.some((d) => d.online)) {
    notify(state.shares.length ? "Turn a folder on to search it." : "Add a folder first — the agent works across your shared folders.", true);
    return;
  }
  void refreshRemotes();
  searchOpen = true;
  menuFor = null;
  render();
  (document.getElementById("ask-input") as HTMLInputElement | null)?.focus();
  // First open with nothing indexed yet: start it, nobody wants to find a button first.
  const ix = status.drives.map((d) => d.index).filter((i) => !!i);
  if (ix.length && ix.every((i) => i && i.indexed === 0 && !i.running)) void reindex();
}

// ---------------------------------------------------------------- icons

const I = {
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  more: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>`,
  agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5v3"/><rect x="4" y="6" width="16" height="12" rx="4"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><path d="M9.5 15.5h5M2 11v3M22 11v3M8 18v2.5M16 18v2.5"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
};

// ---------------------------------------------------------------- render

/** True while the user is typing somewhere in the app — a full re-render would drop the keyboard. */
function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement && (el.type === "text" || el.type === "search" || el.type === "email" || el.type === "password") || el instanceof HTMLTextAreaElement;
}

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  // innerHTML replaces the focused input; put the caret (and the keyboard) back where it was.
  const focused = typing() ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : null;
  const keep = focused ? { id: focused.id, value: focused.value, start: focused.selectionStart, end: focused.selectionEnd } : null;
  try { renderScreens(app); } finally {
    if (keep?.id) {
      const el = document.getElementById(keep.id) as HTMLInputElement | HTMLTextAreaElement | null;
      if (el) {
        if (el.value !== keep.value) el.value = keep.value;
        el.focus({ preventScroll: true });
        try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ }
      }
    }
  }
}

function renderScreens(app: HTMLElement) {
  if (!state.sessionCookie) { app.innerHTML = loginScreen(); bindLogin(); return; }
  if (searchOpen) { app.innerHTML = searchSheet() + overlays(); bindSearch(); return; }
  if (browse) { app.innerHTML = browseSheet() + overlays(); bindBrowse(); return; }
  app.innerHTML = homeScreen() + overlays();
  bindHome();
}

// ---- login

function loginScreen(): string {
  return `
    <div class="hero">
      <h1>aindrive</h1>
      <p>Turn a folder on this phone into a shared drive — and find anything in it by asking.</p>
    </div>
    <ul class="features">
      <li><span class="ic">${I.phone}</span><div><b>Files stay on your phone</b><span>Nothing is uploaded. The server only relays requests to this device.</span></div></li>
      <li><span class="ic">${I.lock}</span><div><b>Only the folders you pick</b><span>You choose each folder; the app can't see anything else.</span></div></li>
      <li><span class="ic">${I.sparkle}</span><div><b>Ask, don't browse</b><span>"photos taken in Paris", "last week's screenshots", "the contract pdf" — answered on-device, offline.</span></div></li>
    </ul>
    <div class="card">
      <button class="btn" id="login" ${busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span> ${esc(busy)}` : "Continue in browser"}</button>
      <p class="hint">Sign in opens in your browser. Approve it there and come back — this app never sees your password.</p>
      <details class="adv">
        <summary>Advanced · server</summary>
        <label for="server">Server</label>
        <input id="server" type="text" value="${esc(state.server)}" ${busy ? "disabled" : ""} />
      </details>
    </div>
    ${overlays()}`;
}

function bindLogin() {
  bind("login", login);
  const serverInput = document.getElementById("server") as HTMLInputElement | null;
  serverInput?.addEventListener("change", () => { state.server = serverInput.value; void save(); });
  bindOverlays();
}

// ---- home

function homeScreen(): string {
  const running = status.drives.filter((d) => d.running && !d.source).length;
  const anyPaired = state.shares.length > 0;
  const folders = state.shares.map(folderCard).join("");
  const empty = `
    <div class="card empty">
      <div class="art">${I.folder}</div>
      <h3>Share your first folder</h3>
      <p>Pick a folder on this phone. It becomes a drive you can open on the web, share with people, and search by asking.</p>
      <button class="btn" id="add-first">${I.plus} Choose a folder</button>
    </div>`;
  const acts = activity.slice(0, showAllActivity ? 30 : 4);
  return `
    <div class="topbar">
      <h1>aindrive</h1>
      <div class="actions">
        ${anyPaired ? `<button class="iconbtn" id="add" aria-label="Add folder" title="Add folder">${I.plus}</button>` : ""}
        <button class="iconbtn primary" id="toggle-search" aria-label="Agent" title="Agent">${I.agent}</button>
      </div>
    </div>

    ${anyPaired ? `
      <div class="section">
        <h2>Shared folders</h2>
        ${state.shares.length > 1 ? (running < state.shares.length
          ? `<button class="link" id="start-all">Turn all on</button>`
          : `<button class="link" id="stop-all">Turn all off</button>`) : ""}
      </div>
      ${folders}
      <p class="hint">A folder is shared only while its switch is on. Sharing keeps running in the background; the notification is the off switch.</p>`
      : empty}

    ${anyPaired ? sourcesSection() : ""}

    ${remotes.length ? `
      <div class="section"><h2>Other devices</h2><button class="link" id="refresh-remotes">Refresh</button></div>
      ${remotes.map((d) => `
        <div class="card remote" data-remote="${esc(d.id)}">
          <div class="folder">
            <div class="glyph">${I.phone}</div>
            <div style="min-width:0">
              <div class="name">${esc(d.name)}</div>
              <div class="state"><span class="dot ${d.online ? "on" : "off"}"></span>${d.online ? "Online" : "Offline"}${d.hostname ? ` · ${esc(d.hostname)}` : ""}</div>
            </div>
            <div class="controls"><button class="btn secondary small" data-act="browse" ${d.online ? "" : "disabled"}>Browse</button></div>
          </div>
        </div>`).join("")}
      <p class="hint">Folders shared from other devices signed in as ${esc(state.email ?? "you")}. Browsing and asking go through the server; the files stay on that device.</p>` : ""}

    <div class="section"><h2>Recent activity</h2>${activity.length > 4 ? `<button class="link" id="more-activity">${showAllActivity ? "Show less" : "Show all"}</button>` : ""}</div>
    <div class="card">
      ${acts.length ? `<ul class="activity">${acts.map((a) => `<li><time>${esc(when(a.at))}</time><span class="msg">${esc(a.msg)}</span></li>`).join("")}</ul>`
        : `<p class="note" style="margin:0">Nothing yet. Things you do here and connections from the web show up in this list.</p>`}
    </div>

    <div class="section"><h2>Account</h2></div>
    <div class="card">
      <div class="kv"><span class="k">Signed in as</span><span class="v">${esc(state.email ?? "—")}</span></div>
      <div class="kv"><span class="k">Server</span><span class="v mono">${esc(state.server.replace(/^https?:\/\//, ""))}</span></div>
      <button class="btn secondary" id="logout" ${running > 0 ? "disabled" : ""}>Log out</button>
      ${running > 0 ? `<p class="hint">Turn every folder off to log out.</p>` : ""}
    </div>`;
}

function folderCard(share: SharedFolder): string {
  const key = shareKey(share);
  const d = driveStatus(share);
  const isBusy = busyShares.has(key);
  const on = !!d?.running;
  const dot = d?.connected ? "on" : d?.running ? "err" : "off";
  const stateText = isBusy ? (on ? "Turning off…" : share.drive ? "Connecting…" : "Setting up…")
    : d?.connected ? "Online"
    : d?.running ? (d.lastError ? "Reconnecting…" : "Connecting…")
    : "Not shared";
  const ix = d?.index;
  const indexText = on && ix ? (ix.running ? ` · indexing ${ix.done}/${ix.total}` : ix.indexed ? ` · ${ix.indexed.toLocaleString()} files` : "") : "";
  const menu = menuFor === key ? `
    <div class="menu">
      <button data-act="addfiles">Add files from this phone…</button>
      ${driveUrl(share) ? `<button data-act="open">Open on the web</button>` : ""}
      ${share.drive ? `<button data-act="copy">Copy drive ID</button>` : ""}
      <div class="sep"></div>
      <button class="danger" data-act="remove" ${on ? "disabled" : ""}>Remove folder${on ? " · turn off first" : ""}</button>
    </div>` : "";
  return `
    <div class="card" data-share="${esc(key)}">
      <div class="folder">
        <div class="glyph" data-act="browse">${I.folder}</div>
        <div style="min-width:0" data-act="browse" role="button" aria-label="Open ${esc(share.folder.label)}">
          <div class="name">${esc(share.folder.label)}</div>
          ${share.parent ? `<div class="hint">in ${esc(share.parent)} · made by the agent</div>` : ""}
          <div class="state"><span class="dot ${dot}"></span>${esc(stateText)}${esc(indexText)}</div>
        </div>
        <div class="controls">
          <button class="switch ${isBusy ? "busy" : ""}" role="switch" aria-checked="${on}" aria-label="Share ${esc(share.folder.label)}" data-act="toggle" ${isBusy ? "disabled" : ""}></button>
          <div class="menu-wrap">
            <button class="iconbtn" style="border:0;background:none;width:38px" data-act="menu" aria-label="More">${I.more}</button>
            ${menu}
          </div>
        </div>
      </div>
      ${d?.lastError && !d.connected && !isBusy ? `<p class="hint folder-err" style="color:var(--warn)">${esc(d.lastError)}</p>` : ""}
    </div>`;
}

function bindHome() {
  const app = document.getElementById("app")!;
  bind("add", addFolder);
  bind("add-first", addFolder);
  bind("toggle-search", openSearch);
  bind("start-all", startAll);
  bind("add-source", () => void addSource());
  for (const el of document.querySelectorAll<HTMLElement>("[data-preset]")) {
    el.querySelector("[data-act=src-add]")?.addEventListener("click", () => void addSource(el.dataset.preset as PresetId));
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-source]")) {
    el.querySelector("[data-act=src-remove]")?.addEventListener("click", () => void removeSource(el.dataset.source!));
  }
  bind("stop-all", stopAll);
  bind("logout", logout);
  bind("more-activity", () => { showAllActivity = !showAllActivity; render(); });
  bind("refresh-remotes", () => void refreshRemotes(true));
  app.querySelectorAll<HTMLElement>("[data-remote]").forEach((card) => {
    const d = remotes.find((r) => r.id === card.dataset.remote);
    if (!d) return;
    card.querySelector<HTMLButtonElement>("[data-act=browse]")?.addEventListener("click", () => void openRemoteBrowser(d));
  });
  app.querySelectorAll<HTMLElement>("[data-share]").forEach((card) => {
    const share = findShare(card.dataset.share!);
    if (!share) return;
    card.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((btn) => {
      const act = btn.dataset.act;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (act === "toggle") { void (driveStatus(share)?.running ? stopShare(share) : startShare(share)); }
        else if (act === "browse") { void openBrowser(share); }
        else if (act === "menu") { menuFor = menuFor === shareKey(share) ? null : shareKey(share); render(); }
        else if (act === "open") { menuFor = null; void openDrive(share); }
        else if (act === "addfiles") { menuFor = null; void addFiles(share); }
        else if (act === "copy") { menuFor = null; void navigator.clipboard?.writeText(share.drive!.driveId).then(() => notify("Drive ID copied")); }
        else if (act === "remove") { menuFor = null; void removeShare(share); }
      });
    });
  });
  if (menuFor) app.addEventListener("click", () => { menuFor = null; render(); }, { once: true });
  bindOverlays();
}

// ---- search

/** Follow-ups offered under the last answer, when they make sense for it. */
const FOLLOWUPS: { q: string; when: (r: AskResult | null) => boolean }[] = [
  { q: "Collect them into a folder", when: (r) => !!r && r.sources.length > 0 && !r.action?.folder },
  { q: "Share it", when: (r) => r?.action?.folder !== undefined && !r.action.skipped && !actionShare?.url },
  { q: "How many are there?", when: (r) => !!r && r.sources.length > 0 && r.action?.type !== "count" },
  { q: "Only the ones from this month", when: (r) => !!r && r.sources.length > 1 },
  { q: "Show the oldest 3", when: (r) => !!r && r.sources.length > 3 },
];
/** Older turns show 3 hits; tapping "Show all" expands that turn. */
const expandedTurns = new Set<number>();

/** Tap-to-run examples, grouped by what the agent can do. Every one is a scenario the device tests cover. */
const SUGGESTIONS: { title: string; items: string[] }[] = [
  { title: "Reports", items: [
    "Sort my call history by who I talk to most and summarize what we usually talk about, and share it",
    "Who do I call the most?",
  ] },
  { title: "Collect into a folder & share", items: [
    "Collect this month's food photos into a folder and share it",
    "Collect the photos I took in Paris into a folder",
    "Make a folder of sunset photos",
    "Collect the recordings and share them",
    "Put all the dog pictures in one folder",
    "Collect the receipt photos",
  ] },
  { title: "Find by place & time", items: [
    "Photos taken in Paris",
    "Photos from Japan last year",
    "Photos taken this month",
    "Last week's screenshots",
    "Videos from Seoul",
  ] },
  { title: "Find by what it shows or says", items: [
    "Dog photos",
    "Pizza photos",
    "Photos of the beach",
    "Meeting recordings where we talked about the budget",
    "Recordings where someone mentions a contract",
  ] },
  { title: "Counts & rankings", items: [
    "How many photos do I have",
    "How many photos from Korea",
    "The 5 biggest files",
    "Show me just the 3 most recent photos",
    "The 2 oldest photos",
  ] },
  { title: "Move & delete (asks first)", items: [
    "Move the Nice photos into a folder",
    "Delete the Tokyo photos",
  ] },
];

function searchSheet(): string {
  const ix = status.drives.map((d) => d.index).filter((i): i is NonNullable<typeof i> => !!i);
  const indexed = ix.reduce((n, i) => n + i.indexed, 0);
  const active = ix.find((i) => i.running);
  const recognised = ix.reduce((n, i) => n + (i.recognisedTotal ?? 0), 0);
  const models = status.models;
  const indexLine = active
    ? (active.phase === "recognising"
      ? `<div class="indexline"><div style="flex:1">Recognising photos & recordings… ${active.recognised.toLocaleString()} / ${active.toRecognise.toLocaleString()}<div class="progress"><i style="width:${active.toRecognise ? Math.round(100 * active.recognised / active.toRecognise) : 0}%"></i></div></div></div>`
      : `<div class="indexline"><div style="flex:1">Indexing… ${active.done.toLocaleString()} / ${active.total.toLocaleString()}<div class="progress"><i style="width:${active.total ? Math.round(100 * active.done / active.total) : 0}%"></i></div></div></div>`)
    : `<div class="indexline"><span>${indexed ? `${indexed.toLocaleString()} files indexed${recognised ? ` · ${recognised.toLocaleString()} recognised` : ""}` : "Not indexed yet"}</span><button class="btn secondary small" id="reindex">${indexed ? "Refresh" : "Index now"}</button></div>`;
  const modelsLine = !models ? "" : models.downloading
    ? `<div class="indexline"><div style="flex:1">Downloading recognition models… ${Math.round(models.done / 1e6)} / ${Math.round(models.total / 1e6)} MB<div class="progress"><i style="width:${models.total ? Math.round(100 * models.done / models.total) : 0}%"></i></div></div></div>`
    : models.ready ? ""
    : `<div class="card" style="margin:0 0 12px;padding:12px 14px">
        <b style="font-size:14px">Recognise what's inside</b>
        <p class="note" style="margin:4px 0 10px">Find photos by what they show and recordings by what was said — on this phone, offline. One-time download of about ${Math.round(models.total / 1e6)} MB.</p>
        ${models.error ? `<p class="hint" style="color:var(--err)">${esc(models.error)}</p>` : ""}
        <button class="btn small" id="ensure-models">Download models</button>
      </div>`;
  const a = askResult?.action;
  const actionCard = !a ? "" : a.skipped
    ? `<div class="card action"><b>Nothing to collect</b><p class="note" style="margin:4px 0 0">${esc(a.reason === "nothing matched" ? "No files matched, so no folder was made." : a.reason === "only loose matches" ? "Only loose matches were found — say it more precisely and I'll make the folder." : "Turn a shared folder on so I have somewhere to save the result.")}</p>${a.needsCallLog ? `<p class="hint" style="margin-top:8px"><button class="link" id="action-calllog">Allow call log</button></p>` : ""}</div>`
    : `<div class="card action">
        <div class="row" style="padding:0"><span class="k">${I.folder}</span><span class="v" style="text-align:left;flex:1;margin-left:10px"><b>${esc(a.label ?? a.folder ?? "")}</b><br><span class="hint">${a.label !== undefined ? "Its own drive · " : ""}${a.copied} file${a.copied === 1 ? "" : "s"} copied${a.failed ? `, ${a.failed} failed` : ""}</span></span></div>
        <div class="folder-foot">
          <button class="btn secondary small" id="action-open">Open folder</button>
          ${actionShare?.url ? `<button class="btn small" id="action-copy">${I.link} Copy link</button>` : `<button class="btn small" id="action-share" ${actionShare?.busy ? "disabled" : ""}>${actionShare?.busy ? "Sharing…" : `${I.link} Share link`}</button>`}
        </div>
        ${a.needsCallLog ? `<p class="hint" style="margin-top:8px">Without call-log access the ranking counts recordings only. <button class="link" id="action-calllog">Allow call log</button></p>` : ""}
        ${actionShare?.url ? `<p class="hint mono" style="margin-top:8px;word-break:break-all">${esc(actionShare.url)}</p>` : ""}
        ${actionShare?.error ? `<p class="hint" style="color:var(--err)">${esc(actionShare.error)}</p>` : ""}
      </div>`;
  const hitsList = (r: AskResult, turn: number, max: number) => !r.sources.length ? "" : `<ul class="hits">${r.sources.slice(0, max).map((src, i) => {
    const name = src.path.split("/").pop() ?? src.path;
    const dir = src.path.split("/").slice(0, -1).join("/");
    const how = src.matchedBy === "photo" ? "👁" : src.matchedBy === "speech" ? "🎙" : "";
    const where = (src as { remoteName?: string }).remoteName;
    return `<li data-turn="${turn}" data-hit="${i}"><span class="kind ${kindClass(name)}">${esc(ext(name))}</span><div style="min-width:0"><div class="name">${how ? `<span title="${src.matchedBy === "photo" ? "matched by what the photo shows" : "matched by what was said"}">${how}</span> ` : ""}${esc(name)}</div><div class="meta">${esc([where ? `📱 ${where}` : "", src.snippet, dir].filter(Boolean).join(" · "))}</div></div></li>`;
  }).join("")}${r.sources.length > max ? `<li class="more" data-more="${turn}">Show all ${r.sources.length}</li>` : ""}</ul>`;
  const turns = thread.map((t, i) => {
    const last = i === thread.length - 1;
    const open = last || expandedTurns.has(i);
    return `
      <div class="turn ${last ? "last" : ""}">
        <div class="bubble">${esc(t.q)}</div>
        ${t.error ? `<p class="answer" style="color:var(--err)">${esc(t.error)}</p>` : t.r ? `
          ${last ? actionCard : t.r.action?.folder ? `<p class="hint">${esc(t.r.action.label ?? t.r.action.folder)} · ${t.r.action.copied ?? 0} files</p>` : ""}
          <p class="answer">${esc(t.r.answer)}</p>
          ${hitsList(t.r, i, open ? 200 : 3)}` : ""}
      </div>`;
  }).join("");
  const body = `
    ${turns}
    ${askBusy ? `<div class="searching"><span class="spinner"></span> Working…</div>` : ""}
    ${!thread.length && !askBusy ? `
      ${SUGGESTIONS.map((g) => `
        <p class="note group">${esc(g.title)}</p>
        <div class="chips">${g.items.map((s) => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join("")}</div>`).join("")}
      <p class="hint">Finds files by type, name, date, size, where and when photos were taken, what photos show and what recordings say — and can collect the results into a new folder and share it. Follow-ups work: "…and share them", "only the ones from Paris". Runs on this phone; only sharing needs the server.</p>` : ""}
    ${thread.length && !askBusy ? `<div class="chips followups">${FOLLOWUPS.filter((f) => f.when(askResult)).map((f) => `<button class="chip" data-suggest="${esc(f.q)}">${esc(f.q)}</button>`).join("")}</div>` : ""}`;
  return `
    <div class="sheet">
      <div class="bar">
        <button class="iconbtn" id="close-search" aria-label="Back">${I.back}</button>
        <div class="field">${I.agent}<input id="ask-input" type="text" enterkeyhint="send" placeholder="${thread.length ? "Follow up, or ask something new" : "Ask or tell me what to do"}" value="${esc(askQuery)}" autocomplete="off" />
          ${askQuery ? `<button id="clear-ask" aria-label="Clear">${I.close}</button>` : ""}</div>
        ${thread.length ? `<button class="iconbtn" id="new-chat" aria-label="New chat" title="New chat">${I.plus}</button>` : ""}
      </div>
      <div class="body">
        ${modelsLine}
        ${indexLine}
        ${body}
      </div>
    </div>`;
}

function bindSearch() {
  bind("close-search", () => { searchOpen = false; render(); });
  bind("reindex", reindex);
  bind("ensure-models", ensureModels);
  bind("clear-ask", () => { askQuery = ""; render(); (document.getElementById("ask-input") as HTMLInputElement | null)?.focus(); });
  bind("new-chat", () => void newChat());
  document.querySelectorAll<HTMLElement>("[data-more]").forEach((li) => li.addEventListener("click", () => { expandedTurns.add(Number(li.dataset.more)); render(); }));
  const bodyEl = document.querySelector<HTMLElement>(".sheet .body");
  if (bodyEl && thread.length) bodyEl.scrollTop = bodyEl.scrollHeight;
  const input = document.getElementById("ask-input") as HTMLInputElement | null;
  input?.addEventListener("input", () => { askQuery = input.value; });
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter") { input.blur(); void ask(); } });
  document.querySelectorAll<HTMLButtonElement>("[data-suggest]").forEach((b) => b.addEventListener("click", () => void ask(b.dataset.suggest!)));
  document.querySelectorAll<HTMLElement>("[data-hit]").forEach((li) => li.addEventListener("click", () => {
    const hit = thread[Number(li.dataset.turn)]?.r?.sources[Number(li.dataset.hit)];
    if (!hit) return;
    const remote = remotes.find((d) => d.id === hit.driveId);
    if (remote) { void viewRemoteFile(remote, hit.path); return; }
    const share = shareByDrive(hit.driveId);
    if (share) void viewFile(share, hit.path); else notify("Turn the folder on to open it.", true);
  }));
  bind("action-share", shareCollected);
  bind("action-calllog", allowCallLog);
  bind("action-copy", () => { if (actionShare?.url) void navigator.clipboard?.writeText(actionShare.url).then(() => notify("Link copied")); });
  bind("action-open", () => {
    const a = askResult?.action; if (a?.folder === undefined) return;
    const remote = remotes.find((d) => d.id === a.driveId);
    if (remote) { searchOpen = false; void openRemoteBrowser(remote, a.folder); return; }
    const share = shareByDrive(a.driveId);
    if (share) { searchOpen = false; void openBrowser(share, a.folder); }
  });
  bindOverlays();
}

function kindClass(name: string): string {
  const e = ext(name).toLowerCase();
  if (["jpg", "jpeg", "png", "heic", "webp", "gif"].includes(e)) return "photo";
  if (["mp4", "mov", "mkv", "webm"].includes(e)) return "video";
  if (e === "pdf") return "pdf";
  if (["doc", "docx", "txt", "md", "hwp", "xlsx", "xls", "csv", "ppt", "pptx"].includes(e)) return "doc";
  return "";
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  const e = i >= 0 ? name.slice(i + 1) : "";
  return (e.length > 4 ? e.slice(0, 4) : e || "file").toUpperCase();
}

// ---- file browser

function browseSheet(): string {
  const share = browseShare();
  if (!browse || !share) return "";
  const crumbs = browse.path ? browse.path.split("/") : [];
  const title = crumbs.length ? crumbs[crumbs.length - 1] : share.folder.label;
  const sub = crumbs.length ? [share.folder.label, ...crumbs.slice(0, -1)].join(" / ") : (driveStatus(share)?.connected ? "Online" : "On this phone");
  const isBusy = busyShares.has(browse.key);
  const plus = browse.plusMenu ? `
    <div class="menu">
      <button data-op="newfolder">New folder</button>
      <button data-op="addfiles">Add files from this phone…</button>
      ${driveUrl(share) ? `<div class="sep"></div><button data-op="web">Open on the web</button>` : ""}
    </div>` : "";
  let body: string;
  if (browse.loading && !browse.entries) body = `<div class="searching"><span class="spinner"></span> Loading…</div>`;
  else if (browse.error) body = `<div class="empty"><h3>Couldn’t read this folder</h3><p>${esc(browse.error)}</p><button class="btn secondary" id="browse-retry">Try again</button></div>`;
  else if (!browse.entries?.length) body = `<div class="empty"><div class="art">${I.folder}</div><h3>Empty folder</h3><p>Add files from this phone or create a folder with the + button.</p></div>`;
  else body = `<ul class="hits files">${browse.entries.map((e) => {
    const menu = browse!.menu === e.path ? `
      <div class="menu">
        <button data-op="open">${e.isDir ? "Open" : "Open with…"}</button>
        <button data-op="rename">Rename</button>
        <div class="sep"></div>
        <button class="danger" data-op="delete">Delete</button>
      </div>` : "";
    const meta = e.isDir ? "Folder" : [prettyBytes(e.size), e.mtimeMs ? new Date(e.mtimeMs).toLocaleDateString() : ""].filter(Boolean).join(" · ");
    return `<li data-entry="${esc(e.path)}">
      <span class="kind ${e.isDir ? "dir" : kindClass(e.name)}" data-op="open">${e.isDir ? I.folder : esc(ext(e.name))}</span>
      <div style="min-width:0" data-op="open"><div class="name">${esc(e.name)}</div><div class="meta">${esc(meta)}</div></div>
      <div class="menu-wrap"><button class="iconbtn" style="border:0;background:none;width:38px" data-op="menu" aria-label="More">${I.more}</button>${menu}</div>
    </li>`;
  }).join("")}</ul>`;
  return `
    <div class="sheet">
      <div class="bar">
        <button class="iconbtn" id="browse-back" aria-label="Back">${I.back}</button>
        <div class="crumbs"><div class="title">${esc(title)}</div><div class="sub">${esc(sub)}</div></div>
        <div class="menu-wrap">
          <button class="iconbtn primary" id="browse-plus" aria-label="Add" ${isBusy ? "disabled" : ""}>${isBusy ? `<span class="spinner"></span>` : I.plus}</button>
          ${plus}
        </div>
      </div>
      <div class="body" id="browse-body">${body}</div>
    </div>`;
}

function bindBrowse() {
  const share = browseShare();
  if (!browse || !share) return;
  bind("browse-back", browseBack);
  bind("browse-retry", () => void loadBrowse());
  bind("browse-plus", () => { if (browse) { browse.plusMenu = !browse.plusMenu; browse.menu = null; render(); } });
  document.querySelectorAll<HTMLElement>("#browse-plus ~ .menu [data-op]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const op = btn.dataset.op;
      if (op === "newfolder") void browseNewFolder();
      else if (op === "addfiles") { if (browse) browse.plusMenu = false; void addFiles(share, browse!.path); }
      else if (op === "web") { if (browse) browse.plusMenu = false; void openDrive(share, browse!.path ? `${browse!.path}/x` : undefined); }
    });
  });
  document.querySelectorAll<HTMLElement>("[data-entry]").forEach((li) => {
    const entry = browse!.entries?.find((e) => e.path === li.dataset.entry);
    if (!entry) return;
    li.querySelectorAll<HTMLElement>("[data-op]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const op = el.dataset.op;
        if (op === "open") { if (browse) browse.menu = null; void browseOpen(entry); }
        else if (op === "menu") { if (browse) { browse.menu = browse.menu === entry.path ? null : entry.path; browse.plusMenu = false; render(); } }
        else if (op === "rename") void browseRename(entry);
        else if (op === "delete") void browseDelete(entry);
      });
    });
  });
  // Tap anywhere else closes open menus.
  document.getElementById("browse-body")?.addEventListener("click", () => {
    if (browse && (browse.menu || browse.plusMenu)) { browse.menu = null; browse.plusMenu = false; render(); }
  });
}

// ---- overlays

function viewerSheet(): string {
  if (!viewer) return "";
  const media = viewer.loading ? `<div class="searching"><span class="spinner"></span> Loading…</div>`
    : viewer.mime.startsWith("image/") ? `<img src="${viewer.src}" alt="${esc(viewer.name)}" />`
    : `<audio controls autoplay src="${viewer.src}"></audio>`;
  return `
    <div class="viewer" id="viewer">
      <div class="bar">
        <button class="iconbtn" id="viewer-close" aria-label="Close">${I.back}</button>
        <div class="title">${esc(viewer.name)}</div>
        <button class="iconbtn" id="viewer-ext" aria-label="Open with another app" title="Open with another app">${I.more}</button>
      </div>
      <div class="stage">${media}</div>
    </div>`;
}

function bindViewer() {
  bind("viewer-close", () => { viewer = null; render(); });
  bind("viewer-ext", () => {
    const v = viewer; if (!v) return;
    if (v.remote) { void Browser.open({ url: `${state.server}/d/${v.remote.id}?path=${encodeURIComponent(v.path.split("/").slice(0, -1).join("/"))}` }); return; }
    if (v.share) void AindriveAgent.openFile({ folderUri: v.share.folder.uri, path: v.path }).catch((e) => notify(msgOf(e), true));
  });
}

function overlays(): string {
  const t = toast ? `<div class="toast ${toast.error ? "error" : ""}" role="status">${esc(toast.msg)}${toast.error ? `<button id="toast-close">OK</button>` : ""}</div>` : "";
  const c = confirmSheet ? `
    <div class="scrim" id="scrim">
      <div class="confirm" id="confirm">
        <h3>${esc(confirmSheet.title)}</h3>
        <p>${esc(confirmSheet.body)}</p>
        <div class="row">
          <button class="btn secondary" id="confirm-no">Cancel</button>
          <button class="btn ${confirmSheet.danger ? "danger" : ""}" id="confirm-yes">${esc(confirmSheet.ok)}</button>
        </div>
      </div>
    </div>` : "";
  return viewerSheet() + t + c;
}

function bindOverlays() {
  bindViewer();
  bind("toast-close", () => { toast = null; render(); });
  bind("confirm-no", () => confirmSheet?.resolve(false));
  bind("confirm-yes", () => confirmSheet?.resolve(true));
  document.getElementById("scrim")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) confirmSheet?.resolve(false); });
}

// ---------------------------------------------------------------- utils

function bind(id: string, fn: () => void) {
  document.getElementById(id)?.addEventListener("click", fn);
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** "12:41" today, "Sep 23" otherwise — the phone's own clock and locale. */
function when(at: number): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  await loadThread();
  // Everything that was on comes back by itself: sources, and the shares whose switch was on.
  void (async () => {
    for (const share of state.shares) if (share.on && state.sessionCookie && !driveStatus(share)?.running) await startShare(share);
    await startSources();
  })();
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
    // Indexing progress ticks every few files; never redraw under someone's fingers.
    if (!typing()) render();
  }).catch(() => {});
  App.addListener("resume", () => {
    AindriveAgent.status().then((s) => { status = s; render(); }).catch(() => {});
    void refreshRemotes();
  });
  void refreshRemotes();
  App.addListener("backButton", () => {
    if (confirmSheet) confirmSheet.resolve(false);
    else if (viewer) { viewer = null; render(); }
    else if (searchOpen) { searchOpen = false; render(); }
    else if (browse) browseBack();
    else if (menuFor) { menuFor = null; render(); }
    else App.exitApp();
  });
  render();
}

void boot();

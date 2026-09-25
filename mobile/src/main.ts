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
import "./ui.css";
import { I, icon, fileGlyph } from "./icons";
import { Web } from "./web";
import type { Ctx, Sheet } from "./kit";
import { ShareSheet } from "./share-sheet";
import { ManageSheet } from "./manage-sheet";
import { ChatSheet, McpSheet } from "./agents-sheet";
import { AccountSheet } from "./account-sheet";

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
type PresetId = "src-calls-new" | "src-calls" | "src-photos";
/** Suggested first: Samsung's call recordings and the camera roll. Any other folder can be added too. */
const PRESETS: { id: PresetId; label: string; hint: string; initial: string }[] = [
  { id: "src-calls-new", label: "Call recordings", hint: "For \"who do I talk to most, and about what\" — Recordings/Call (Samsung, 2022 and later)", initial: "Recordings/Call" },
  { id: "src-calls", label: "Older call recordings", hint: "The Call folder (Samsung, before 2022)", initial: "Call" },
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
  /** "Search in this folder" filter, like the web header's search box. */
  query?: string;
  searching?: boolean;
  /** "For sale" items at the root of a drive shared with you (web: ShowcaseSection). */
  showcase?: { shareId: string; leafName: string; price: number; currency: string | null }[];
} | null = null;
/** List/grid and sort, remembered like the web's (localStorage there, Preferences here). */
let browseView: "list" | "grid" = "list";
let browseSort: { by: "name" | "modified" | "size"; dir: 1 | -1 } = { by: "name", dir: 1 };
/** Thumbnails for the grid view, by folder-uri + path (data URLs, small). */
const thumbs = new Map<string, string | null>();
/** A module-owned sheet (share, manage, chat, MCP, account, move) on top of whatever is open. */
let sheet: Sheet | null = null;
/** Text typed into sheet fields survives re-renders (status ticks, list reloads). */
const drafts = new Map<string, string>();
let showAllActivity = false;
/** In-app viewer: what is open (images and audio play here; everything else goes to the OS). */
let viewer: { share?: SharedFolder; remote?: RemoteDrive; path: string; name: string; mime: string; src?: string; text?: string; loading: boolean; editing?: boolean; draft?: string; saving?: boolean } | null = null;
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

/** Past conversations (newest first): "New chat" files the current one here instead of throwing it away. */
interface PastChat { at: number; title: string; thread: Turn[] }
let pastChats: PastChat[] = [];
let historyOpen = false;
const HISTORY_KEY = "aindrive.mobile.history.v1";

async function loadHistory() {
  try { const { value } = await Preferences.get({ key: HISTORY_KEY }); pastChats = value ? JSON.parse(value) : []; } catch { pastChats = []; }
}

async function saveHistory() {
  // Keep the text, drop heavy source lists beyond what the screen shows.
  pastChats = pastChats.slice(0, 30).map((c) => ({ ...c, thread: c.thread.map((t) => ({ ...t, r: t.r ? { ...t.r, sources: t.r.sources.slice(0, 30) } : t.r })) }));
  try { await Preferences.set({ key: HISTORY_KEY, value: JSON.stringify(pastChats) }); } catch { /* best effort */ }
}

async function openPastChat(i: number) {
  const c = pastChats[i]; if (!c) return;
  if (thread.length) pastChats.unshift({ at: Date.now(), title: thread[0].q, thread });
  pastChats = pastChats.filter((x) => x !== c);
  thread = c.thread; askResult = thread[thread.length - 1]?.r ?? null; askContext = null; historyOpen = false;
  expandedPhotos.clear(); expandedFiles.clear();
  await Promise.all([saveThread(), saveHistory()]);
  render();
}

async function newChat() {
  if (thread.length) { pastChats.unshift({ at: Date.now(), title: thread[0].q, thread }); await saveHistory(); }
  expandedPhotos.clear(); expandedFiles.clear();
  thread = []; askContext = null; askResult = null; askQuery = ""; actionShare = null;
  await saveThread();
  render();
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

// ---------------------------------------------------------------- sheets (share, manage, chat, MCP, account)

function web(): Web { return new Web(state.server, state.sessionCookie ?? ""); }

/** What a sheet module may do to the shell — see kit.ts. */
function sheetCtx(): Ctx {
  return {
    web: web(),
    server: state.server,
    notify,
    // Sheets redraw even while a field has focus (render() puts focus and caret back);
    // only background status ticks hold off while someone types.
    rerender: () => render(),
    confirm: confirmAsync,
    close: closeSheet,
    copy: async (text, what = "Copied") => {
      try { await navigator.clipboard.writeText(text); notify(`${what} copied`); } catch { notify(text); }
    },
    openUrl: (url) => Browser.open({ url }),
    forget: (...ids) => { for (const id of ids) drafts.delete(id); },
  };
}

function openSheet(make: (ctx: Ctx) => Sheet) {
  menuFor = null;
  if (browse) { browse.menu = null; browse.plusMenu = false; }
  sheet = make(sheetCtx());
  render();
}

function closeSheet() { sheet = null; drafts.clear(); render(); }

function sheetHtml(): string {
  if (!sheet) return "";
  return sheet.kind === "drawer" ? `<div class="scrim" id="sheet-scrim">${sheet.render()}</div>` : sheet.render();
}

function bindSheet() {
  const host = document.getElementById("sheet-host");
  if (!sheet || !host) return;
  sheet.bind(host);
  document.getElementById("sheet-scrim")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); });
}

/** The drive id a share or remote drive is known by on the server. */
function driveIdOf(share?: SharedFolder, remote?: RemoteDrive): string | undefined { return remote?.id ?? share?.drive?.driveId; }

function openShareFor(driveId: string | undefined, path: string, name: string) {
  if (!driveId) { notify("Turn the folder on first so it has a drive to share.", true); return; }
  openSheet((ctx) => new ShareSheet(ctx, driveId, path, name));
}

function openManage(driveId: string | undefined, name: string) {
  if (!driveId) { notify("Turn the folder on first.", true); return; }
  openSheet((ctx) => new ManageSheet(ctx, driveId, name, () => {
    sheet = null;
    const local = state.shares.find((s) => s.drive?.driveId === driveId);
    if (local) { void AindriveAgent.stop({ driveId }).catch(() => {}); state.shares = state.shares.filter((s) => s !== local); void save(); }
    remotes = remotes.filter((d) => d.id !== driveId);
    browse = null; render();
  }));
}

function openChat(driveId: string | undefined, name: string, folder: string, owned: boolean) {
  if (!driveId) { notify("Turn the folder on first.", true); return; }
  openSheet((ctx) => new ChatSheet(ctx, driveId, name, folder, owned, (path) => {
    sheet = null;
    const local = state.shares.find((s) => s.drive?.driveId === driveId);
    const remote = remotes.find((d) => d.id === driveId);
    if (local) void viewFile(local, path); else if (remote) void viewRemoteFile(remote, path); else render();
  }));
}

function openMcp(driveId: string | undefined, name: string) {
  if (!driveId) { notify("Turn the folder on first.", true); return; }
  openSheet((ctx) => new McpSheet(ctx, driveId, name));
}

function openAccount() {
  openSheet((ctx) => new AccountSheet(ctx, () => { sheet = null; void logout(); }));
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

/** Leave a drive someone shared with you (web: LeaveDriveButton). */
async function leaveDrive(d: RemoteDrive) {
  if (!(await confirmAsync(`Leave “${d.name}”?`, "You lose access until the owner invites you again.", "Leave", true))) return;
  try { await web().leave(d.id); remotes = remotes.filter((x) => x.id !== d.id); notify(`Left ${d.name}`); }
  catch (e) { notify(msgOf(e), true); }
  render();
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
  if (!(m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/") || isText(m, name))) {
    // Anything else: the web has the right viewer/download for it.
    await Browser.open({ url: `${state.server}/d/${drive.id}?path=${encodeURIComponent(path.split("/").slice(0, -1).join("/"))}` });
    return;
  }
  viewer = { remote: drive, path, name, mime: m, loading: true };
  render();
  try {
    const r = await remoteRead(state.server, state.sessionCookie!, drive.id, path);
    if (viewer && viewer.path === path) {
      if (isText(m, name)) viewer.text = decodeUtf8(r.base64); else viewer.src = `data:${r.mime || m};base64,${r.base64}`;
      viewer.mime = r.mime || m; viewer.loading = false;
    }
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

/** SAF's ways of saying "that document is gone". */
function isGone(msg: string): boolean {
  return /FileNotFound|No such file|not found|Missing file|does not exist|ENOENT|is child of/i.test(msg);
}

async function loadBrowse() {
  const share = browseShare();
  if (!browse || !share) return;
  if (browse.remote) share.folder.label = browse.remote.name;
  browse.loading = true; browse.error = null; browse.menu = null; browse.plusMenu = false;
  render();
  try {
    if (browse.remote) {
      if (!browse.path && browse.remote.owned === false) {
        const b = browse;
        void web().showcase(b.remote!.id).then((items) => { b.showcase = items; if (!typing()) render(); }).catch(() => {});
      }
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
    if (browse && !browse.remote && !browse.path && isGone(msgOf(e))) { browse = null; await pruneMissing(); return; }
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
  if (m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/") || isText(m, name)) {
    viewer = { share, path, name, mime: m, loading: true };
    render();
    try {
      const r = await AindriveAgent.readFile({ folderUri: share.folder.uri, path, maxPx: 1600 });
      if (viewer && viewer.path === path) {
        if (isText(m, name)) viewer.text = decodeUtf8(r.base64);
        else viewer.src = `data:${r.mime};base64,${r.base64}`;
        viewer.mime = r.mime; viewer.loading = false;
      }
    } catch (e) {
      viewer = null;
      // Too big to play in the app (> 25 MB): hand it to the phone's player.
      if (m.startsWith("video/") || m.startsWith("audio/")) { render(); try { await AindriveAgent.openFile({ folderUri: share.folder.uri, path }); } catch (e2) { notify(msgOf(e2), true); } return; }
      notify(msgOf(e), true);
    }
    render();
    return;
  }
  try { await AindriveAgent.openFile({ folderUri: share.folder.uri, path }); }
  catch (e) { notify(msgOf(e), true); }
}

/** Markdown and plain text render in the app: the agent's reports are .md files. */
function isText(mime: string, name: string): boolean {
  const e = (name.split(".").pop() ?? "").toLowerCase();
  return mime.startsWith("text/") || ["md", "markdown", "txt", "log", "csv", "json"].includes(e);
}

function decodeUtf8(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Just enough Markdown for the agent's own reports: headings, tables, lists,
 * quotes, bold/italic/code, paragraphs. Everything is escaped first.
 */
function renderMarkdown(md: string): string {
  const inline = (t: string) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,!?])/g, "$1<i>$2</i>")
    .replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" target="_blank" rel="noopener">$1</a>`);
  const lines = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\|/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const cells = (row: string) => row.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
      const head = cells(l); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`); continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`); continue;
    }
    if (/^>\s?/.test(l)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`); continue;
    }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\||\s*[-*]\s|\s*\d+\.\s|>)/.test(lines[i])) p.push(lines[i++]);
    out.push(`<p>${inline(p.join(" "))}</p>`);
  }
  return out.join("");
}

function guessMime(name: string): string {
  const e = (name.split(".").pop() ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp"].includes(e)) return "image/" + (e === "jpg" ? "jpeg" : e);
  if (["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "amr"].includes(e)) return "audio/" + e;
  if (["mp4", "mov", "mkv", "webm", "3gp"].includes(e)) return "video/" + e;
  if (["md", "markdown"].includes(e)) return "text/markdown";
  if (["txt", "log", "csv"].includes(e)) return "text/plain";
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
    if (browse.remote) await web().mkdir(browse.remote.id, joinPath(browse.path, name));
    else await AindriveAgent.mkdir({ folderUri: share.folder.uri, path: joinPath(browse.path, name) });
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
    if (browse.remote) await web().rename(browse.remote.id, entry.path, joinPath(browse.path, name));
    else await AindriveAgent.rename({ folderUri: share.folder.uri, from: entry.path, to: joinPath(browse.path, name) });
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
    browse.remote ? `It is deleted on ${browse.remote.hostname ?? "the device that serves this drive"}.`
      : entry.isDir ? "The folder and everything inside it is deleted from this phone." : "The file is deleted from this phone.",
    "Delete", true,
  );
  if (!ok) return;
  try {
    if (browse.remote) await web().remove(browse.remote.id, entry.path);
    else await AindriveAgent.delete({ folderUri: share.folder.uri, path: entry.path });
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
  const st = busyShares.has(src.id) ? "Starting…" : d?.running
    ? (ix?.running ? (ix.phase === "recognising" ? `${src.preset?.startsWith("src-calls") ? "Transcribing" : "Recognising"} ${ix.recognised.toLocaleString()}/${ix.toRecognise.toLocaleString()}` : `Indexing ${ix.done}/${ix.total}`)
      : ix?.indexed ? `${ix.indexed.toLocaleString()} files indexed${ix.recognisedTotal ? ` · ${ix.recognisedTotal.toLocaleString()} ${src.preset?.startsWith("src-calls") ? "transcribed" : "recognised"}` : ""}` : "Ready")
    : "Off";
  return `
    <div class="card" data-source="${esc(src.id)}">
      <div class="folder">
        <div class="glyph">${src.preset?.startsWith("src-calls") ? I.phone : I.folder}</div>
        <div style="min-width:0;flex:1">
          <div class="name">${esc(def ? def.label : src.folder.label)}${def ? ` <span class="hint">· ${esc(src.folder.label)}</span>` : ""}</div>
          ${def ? `<div class="hint">${esc(def.hint)}</div>` : ""}
          <div class="state"><span class="dot ${d?.running ? "on" : "off"}"></span>${esc(st)}</div>
        </div>
        <button class="btn secondary small" data-act="src-remove">Revoke</button>
      </div>
    </div>`;
}

/** Which models see the user's data — all on this phone, none in the cloud. A small link in the agent sheet; opens on tap. */
let modelInfoOpen = false;
function modelsSection(): string {
  const m = status.models;
  if (!m?.list?.length) return "";
  const what: Record<string, string> = { image: "Finds photos by what they show", speech: "Transcribes recordings and calls", llm: "Writes the summaries in reports" };
  const toggle = `<button class="link small" id="model-info-toggle">${modelInfoOpen ? "Hide model info" : "Model info"}</button>`;
  if (!modelInfoOpen) return `<div class="modelinfo-bar">${toggle}</div>`;
  return `
    <div class="modelinfo-bar">${toggle}${m.ready && m.llm ? "" : `<button class="link small" id="models-download" ${m.downloading ? "disabled" : ""}>${m.downloading ? `Downloading… ${Math.round(100 * m.done / Math.max(1, m.total))}%` : "Download all"}</button>`}</div>
    <div class="card" style="padding:6px 16px;margin-bottom:12px">
      ${m.list.map((x) => `
        <div class="row model"><span class="k">${esc(x.role)}</span>
          <span class="v" style="text-align:left;flex:1;margin-left:12px;min-width:0">
            <b>${esc(x.name)}</b><br>
            <span class="hint">${esc(what[x.id] ?? "")} · ${(x.bytes / 1e6) >= 1000 ? (x.bytes / 1e9).toFixed(1) + " GB" : Math.round(x.bytes / 1e6) + " MB"} · ${esc(x.license.replace(/\s*\(.*$/, ""))}</span>
          </span>
          <span class="dot ${x.ready ? "on" : "off"}" title="${x.ready ? "On this phone" : "Not downloaded"}"></span>
        </div>`).join("")}
      <p class="hint" style="margin:6px 0 8px">Everything runs on this phone; nothing is sent to a cloud model. ${m.error ? `<span style="color:var(--err)">${esc(m.error)}</span>` : ""}</p>
    </div>`;
}

function sourcesSection(): string {
  const have = new Set((state.sources ?? []).map((s) => s.preset));
  const suggested = PRESETS.filter((p) => !have.has(p.id)).map((p) => `
    <div class="card" data-preset="${p.id}">
      <div class="folder">
        <div class="glyph">${p.id.startsWith("src-calls") ? I.phone : I.folder}</div>
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
/**
 * A folder deleted on the phone (in Files, or by the user) simply disappears
 * from the list: its drive is taken offline and deleted on the server,
 * quietly. Checked at launch, on resume and before the list is shown.
 */
async function pruneMissing() {
  const gone: SharedFolder[] = [];
  for (const share of state.shares) {
    try { await AindriveAgent.listFolder({ folderUri: share.folder.uri, path: "" }); }
    catch (e) { if (isGone(msgOf(e))) gone.push(share); }
  }
  if (!gone.length) return;
  for (const share of gone) {
    if (share.drive) {
      await AindriveAgent.stop({ driveId: share.drive.driveId }).catch(() => {});
      if (state.sessionCookie) await deleteDrive(state.server, state.sessionCookie, share.drive.driveId).catch(() => {});
    }
    log(`${share.folder.label} was deleted on the phone — removed from the list`);
  }
  state.shares = state.shares.filter((s) => !gone.includes(s));
  await save();
  // Parents hid the removed folders (excludeUris): restart them so a folder recreated inside shows up again.
  for (const s of state.shares) if (driveStatus(s)?.running) await startShare(s);
  try { status = await AindriveAgent.status(); } catch { /* browser dev */ }
  if (browse && gone.some((s) => browse && shareKey(s) === browse.key)) browse = null;
  render();
}

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
  render();   // no autofocus: the conversation and suggestions come first, the keyboard on tap
  // First open with nothing indexed yet: start it, nobody wants to find a button first.
  const ix = status.drives.map((d) => d.index).filter((i) => !!i);
  if (ix.length && ix.every((i) => i && i.indexed === 0 && !i.running)) void reindex();
}


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
  if (!state.sessionCookie) { app.innerHTML = loginScreen(); bindLogin(); bindOverlays(); return; }
  if (searchOpen) { app.innerHTML = searchSheet() + overlays(); bindSearch(); }
  else if (browse) { app.innerHTML = browseSheet() + overlays(); bindBrowse(); }
  else { app.innerHTML = homeScreen() + overlays(); bindHome(); }
  // Viewer, toast and confirm sit on every screen: bind them once, here.
  bindOverlays();
  // Sheets render last so they sit on top; fields keep what was typed.
  if (sheet) {
    const host = document.createElement("div");
    host.id = "sheet-host";
    host.innerHTML = sheetHtml();
    app.appendChild(host);
    for (const [id, v] of drafts) {
      const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>("#" + CSS.escape(id));
      if (el && !el.value && el.type !== "checkbox") el.value = v;
    }
    host.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id && t.type !== "checkbox") drafts.set(t.id, t.value);
    });
    bindSheet();
  }
}

// ---- login

function loginScreen(): string {
  return `
    <div class="hero">
      <div class="brand">${I.drive} aindrive</div>
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
      <button class="btn" id="add-first" style="max-width:280px">${I.plus} Choose a folder</button>
    </div>`;
  const acts = activity.slice(0, showAllActivity ? 30 : 4);
  const others = remotes.filter((d) => d.owned !== false);
  const sharedWithMe = remotes.filter((d) => d.owned === false);
  const who = state.email ?? "Account";
  return `
    <div class="topbar">
      <div class="brand">${I.drive} aindrive</div>
      <div class="actions">
        ${anyPaired ? `<button class="iconbtn" id="add" aria-label="Add folder" title="Add folder">${I.plus}</button>` : ""}
        <button class="iconbtn primary" id="toggle-search" aria-label="Agent" title="Agent">${I.agent}</button>
      </div>
    </div>

    ${anyPaired ? `
      <div class="section">
        <h2>On this phone</h2>
        ${state.shares.length > 1 ? (running < state.shares.length
          ? `<button class="link" id="start-all">Turn all on</button>`
          : `<button class="link" id="stop-all">Turn all off</button>`) : ""}
      </div>
      ${folders}
      <p class="hint">A folder is shared only while its switch is on. Sharing keeps running in the background; the notification is the off switch.</p>`
      : empty}

    ${anyPaired ? sourcesSection() : ""}

    ${others.length ? `
      <div class="section"><h2>My drives on other devices</h2><button class="link" id="refresh-remotes">${icon("refresh", 16)} Refresh</button></div>
      ${others.map(remoteCard).join("")}` : ""}

    ${sharedWithMe.length ? `
      <div class="section"><h2>Shared with me</h2></div>
      ${sharedWithMe.map(remoteCard).join("")}` : ""}

    <div class="section"><h2>Recent activity</h2>${activity.length > 4 ? `<button class="link" id="more-activity">${showAllActivity ? "Show less" : "Show all"}</button>` : ""}</div>
    <div class="card">
      ${acts.length ? `<ul class="activity">${acts.map((a) => `<li><time>${esc(when(a.at))}</time><span class="msg">${esc(a.msg)}</span></li>`).join("")}</ul>`
        : `<p class="note" style="margin:0">Nothing yet. Things you do here and connections from the web show up in this list.</p>`}
    </div>

    <div class="section"><h2>Account</h2></div>
    <button class="card account" id="account" style="width:100%;text-align:left">
      <div class="avatar">${esc(who.slice(0, 1).toUpperCase())}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:500">${esc(who)}</div><div class="hint" style="margin:0">${esc(state.server.replace(/^https?:\/\//, ""))}</div></div>
      ${I.chevron}
    </button>`;
}

/** A drive this account can reach that another device serves (or that someone shared with you). */
function remoteCard(d: RemoteDrive): string {
  // The server stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const seenAt = d.lastSeenAt ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(d.lastSeenAt) ? d.lastSeenAt : d.lastSeenAt.replace(" ", "T") + "Z") : null;
  const seen = d.online ? "Online" : seenAt && !isNaN(seenAt.getTime()) ? `Last seen ${seenAt.toLocaleString()}` : "Offline";
  const menu = menuFor === "remote:" + d.id ? `
    <div class="menu">
      <button data-act="share">${icon("share", 18)} Share…</button>
      ${d.owned !== false ? `<button data-act="manage">${icon("settings", 18)} Manage</button>` : ""}
      <button data-act="chat">${icon("chat", 18)} Chat with agents</button>
      <button data-act="mcp">${icon("plug", 18)} MCP</button>
      <button data-act="web">${icon("external", 18)} Open on the web</button>
      ${d.owned === false ? `<div class="sep"></div><button class="danger" data-act="leave">${icon("logout", 18)} Leave drive</button>` : ""}
    </div>` : "";
  return `
    <div class="card remote" data-remote="${esc(d.id)}">
      <div class="folder">
        <div class="glyph" data-act="browse">${d.owned === false ? I.users : I.drive}</div>
        <div style="min-width:0" data-act="browse" role="button">
          <div class="name">${esc(d.name)}</div>
          <div class="state"><span class="dot ${d.online ? "on" : "off"}"></span>${esc(seen)}${d.hostname ? ` · ${esc(d.hostname)}` : ""}</div>
        </div>
        <div class="controls"><div class="menu-wrap"><button class="iconbtn ghost" data-act="menu" aria-label="More">${I.more}</button>${menu}</div></div>
      </div>
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
      ${share.drive ? `<button data-act="share">${icon("share", 18)} Share…</button>
      <button data-act="manage">${icon("settings", 18)} Manage</button>
      <button data-act="chat">${icon("chat", 18)} Chat with agents</button>
      <button data-act="mcp">${icon("plug", 18)} MCP</button>
      <div class="sep"></div>` : ""}
      <button data-act="addfiles">${icon("upload", 18)} Add files from this phone…</button>
      ${driveUrl(share) ? `<button data-act="open">${icon("external", 18)} Open on the web</button>` : ""}
      ${share.drive ? `<button data-act="copy">${icon("copy", 18)} Copy drive ID</button>` : ""}
      <div class="sep"></div>
      <button class="danger" data-act="remove" ${on ? "disabled" : ""}>${icon("trash", 18)} Remove folder${on ? " · turn off first" : ""}</button>
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
            <button class="iconbtn ghost" data-act="menu" aria-label="More">${I.more}</button>
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
  bind("account", openAccount);
  bind("more-activity", () => { showAllActivity = !showAllActivity; render(); });
  bind("refresh-remotes", () => void refreshRemotes(true));
  app.querySelectorAll<HTMLElement>("[data-remote]").forEach((card) => {
    const d = remotes.find((r) => r.id === card.dataset.remote);
    if (!d) return;
    card.querySelectorAll<HTMLElement>("[data-act]").forEach((el) => el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const act = el.dataset.act;
      if (act === "browse") { if (d.online) void openRemoteBrowser(d); else notify(`${d.name} is offline — its device isn't connected.`, true); return; }
      if (act === "menu") { menuFor = menuFor === "remote:" + d.id ? null : "remote:" + d.id; render(); return; }
      menuFor = null;
      if (act === "share") openShareFor(d.id, "", d.name);
      else if (act === "manage") openManage(d.id, d.name);
      else if (act === "chat") openChat(d.id, d.name, "", d.owned !== false);
      else if (act === "mcp") openMcp(d.id, d.name);
      else if (act === "web") void Browser.open({ url: `${state.server}/d/${d.id}` });
      else if (act === "leave") void leaveDrive(d);
    }));
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
        else if (act === "share") openShareFor(share.drive?.driveId, "", share.folder.label);
        else if (act === "manage") openManage(share.drive?.driveId, share.folder.label);
        else if (act === "chat") openChat(share.drive?.driveId, share.folder.label, "", true);
        else if (act === "mcp") openMcp(share.drive?.driveId, share.folder.label);
      });
    });
  });
  if (menuFor) app.addEventListener("click", () => { menuFor = null; render(); }, { once: true });
}

// ---- search

/** Follow-ups offered under the last answer, when they make sense for it. */
const FOLLOWUPS: { q: string; when: (r: AskResult | null) => boolean }[] = [
  { q: "Collect them into a folder", when: (r) => !!r && r.sources.length > 0 && r.action?.folder === undefined },
  { q: "Share it", when: (r) => r?.action?.folder !== undefined && !r.action.skipped && !actionShare?.url },
  { q: "How many are there?", when: (r) => !!r && r.sources.length > 0 && r.action?.type !== "count" },
  { q: "Only the ones from this month", when: (r) => !!r && r.sources.length > 1 },
  { q: "Show the oldest 3", when: (r) => !!r && r.sources.length > 3 },
];
/** Turns whose photo grid / file list the user expanded ("+N", "Show all"). */
const expandedPhotos = new Set<number>();
const expandedFiles = new Set<number>();
/** Agent-result thumbnails (small JPEGs read on the phone), by drive + path. */
const askThumbs = new Map<string, string | null>();

function thumbId(src: { driveId?: string; path: string }): string { return `${src.driveId ?? ""}|${src.path}`; }

/** The folder a result lives in on this phone: a shared folder or an agent source (DCIM, Call…). */
function localFolderFor(driveId?: string): SharedFolder | undefined {
  const share = shareByDrive(driveId);
  if (share) return share;
  const src = state.sources?.find((x) => x.id === driveId);
  return src ? { folder: src.folder } : undefined;
}

async function loadAskThumbs() {
  const want = [...document.querySelectorAll<HTMLElement>("[data-thumb]")].map((el) => el.dataset.thumb!).filter((k) => !askThumbs.has(k));
  if (!want.length) return;
  for (const k of want) askThumbs.set(k, null);
  // Three at a time, each shown as soon as it's ready (a camera photo takes a few seconds to decode).
  let redraw = 0;
  const one = async (k: string) => {
    const [driveId, ...rest] = k.split("|");
    const folder = localFolderFor(driveId || undefined);
    if (!folder) return;   // other devices: keep the icon (a full read per thumbnail is too heavy)
    try {
      const r = await AindriveAgent.readFile({ folderUri: folder.folder.uri, path: rest.join("|"), maxPx: 256 });
      askThumbs.set(k, `data:${r.mime};base64,${r.base64}`);
      // Patch the tile in place: no full re-render, so scrolling and typing are left alone.
      const el = document.querySelector<HTMLElement>(`[data-thumb="${CSS.escape(k)}"]`);
      const img = document.createElement("img"); img.src = askThumbs.get(k)!; img.alt = "";
      if (el) { el.querySelector("span.ft-image")?.remove(); el.prepend(img); } else redraw++;
    } catch { /* keep the icon */ }
  };
  const queue = [...want];
  await Promise.all([0, 1, 2].map(async () => { while (queue.length) await one(queue.shift()!); }));
  if (redraw && !typing()) render();
}

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
  // Photo recognition is what the agent needs now; a call archive transcribing for hours is shown after it.
  const runningDrives = status.drives.filter((d) => d.index?.running);
  const activeDrive = runningDrives.find((d) => !d.driveId.startsWith("src-calls")) ?? runningDrives[0];
  const active = activeDrive?.index;
  const activeName = activeDrive ? (activeDrive.folderLabel || "a folder") : "";
  const recognised = ix.reduce((n, i) => n + (i.recognisedTotal ?? 0), 0);
  const models = status.models;
  const indexLine = active
    ? (active.phase === "recognising"
      ? `<div class="indexline"><div style="flex:1">${activeDrive?.driveId.startsWith("src-calls") ? "Transcribing calls" : "Recognising photos & recordings"} in ${esc(activeName)}… ${active.recognised.toLocaleString()} / ${active.toRecognise.toLocaleString()}<div class="progress"><i style="width:${active.toRecognise ? Math.round(100 * active.recognised / active.toRecognise) : 0}%"></i></div></div></div>`
      : `<div class="indexline"><div style="flex:1">Indexing… ${active.done.toLocaleString()} / ${active.total.toLocaleString()}<div class="progress"><i style="width:${active.total ? Math.round(100 * active.done / active.total) : 0}%"></i></div></div></div>`)
    : `<div class="indexline"><span>${indexed ? `${indexed.toLocaleString()} files indexed${recognised ? ` · ${recognised.toLocaleString()} recognised` : ""}` : "Not indexed yet"}</span><button class="btn secondary small" id="reindex">${indexed ? "Refresh" : "Index now"}</button></div>`;
  const modelsLine = !models ? "" : models.downloading
    ? `<div class="indexline"><div style="flex:1">Downloading recognition models… ${Math.round(models.done / 1e6)} / ${Math.round(models.total / 1e6)} MB<div class="progress"><i style="width:${models.total ? Math.round(100 * models.done / models.total) : 0}%"></i></div></div></div>`
    : models.ready ? ""
    : `<div class="card" style="margin:0 0 12px;padding:12px 14px">
        <b style="font-size:14px">Recognise what's inside</b>
        <p class="note" style="margin:4px 0 10px">Find photos by what they show, recordings by what was said, and get real summaries in the call report — all on this phone, offline. One-time download of about ${(models.total / 1e9).toFixed(1)} GB (photo + speech models, and a small language model for summaries).</p>
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
  // Photos as a real thumbnail grid (a few, then "+N" expands); everything else a short list.
  const hitsList = (r: AskResult, turn: number, last: boolean) => {
    if (!r.sources.length) return "";
    const idx = r.sources.map((src, i) => ({ src, i }));
    const photos = idx.filter(({ src }) => guessMime(src.path).startsWith("image/"));
    const files = idx.filter(({ src }) => !guessMime(src.path).startsWith("image/"));
    const pMax = expandedPhotos.has(turn) ? photos.length : last ? 6 : 3;
    const fMax = expandedFiles.has(turn) ? files.length : last ? 5 : 3;
    const grid = photos.length ? `<div class="photo-grid">${photos.slice(0, pMax).map(({ src, i }) => {
      const t = askThumbs.get(thumbId(src));
      const how = src.matchedBy === "photo" ? `<span class="badge-how" title="matched by what the photo shows">${icon("sparkle", 12)}</span>` : "";
      return `<button class="ph" data-turn="${turn}" data-hit="${i}" data-thumb="${esc(thumbId(src))}" aria-label="${esc(src.path.split("/").pop() ?? "")}">${t ? `<img src="${t}" alt="" />` : `<span class="ft-image">${icon("fileImage", 24)}</span>`}${how}</button>`;
    }).join("")}${photos.length > pMax ? `<button class="ph more" data-more-photos="${turn}">+${photos.length - pMax}</button>` : ""}</div>` : "";
    const list = files.length ? `<ul class="hits">${files.slice(0, fMax).map(({ src, i }) => {
      if (src.caller) {
        // A call recording reads as "who — what", not as its file name.
        const at = src.callAt ? new Date(src.callAt) : null;
        const whenTxt = at ? `${at.toLocaleDateString()} ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "";
        return `<li data-turn="${turn}" data-hit="${i}" class="call"><span class="kind ft-audio">${icon("call", 20)}</span><div style="min-width:0">
          <div class="name">${esc(src.caller)} <span class="when">${esc(whenTxt)}</span></div>
          <div class="summary">${esc(src.summary ?? src.snippet)}</div></div></li>`;
      }
      const name = src.path.split("/").pop() ?? src.path;
      const dir = src.path.split("/").slice(0, -1).join("/");
      const how = src.matchedBy === "speech" ? "🎙 " : "";
      const where = (src as { remoteName?: string }).remoteName;
      return `<li data-turn="${turn}" data-hit="${i}"><span class="kind ${fileGlyph(name, false).cls}">${fileGlyph(name, false).svg}</span><div style="min-width:0"><div class="name">${how}${esc(name)}</div><div class="meta">${esc([where ? `📱 ${where}` : "", src.snippet, dir].filter(Boolean).join(" · "))}</div></div></li>`;
    }).join("")}${files.length > fMax ? `<li class="more" data-more-files="${turn}">Show all ${files.length}</li>` : ""}</ul>` : "";
    return grid + list;
  };
  const turns = thread.map((t, i) => {
    const last = i === thread.length - 1;
    return `
      <div class="turn ${last ? "last" : ""}">
        <div class="bubble">${esc(t.q)}</div>
        ${t.error ? `<p class="answer" style="color:var(--err)">${esc(t.error)}</p>` : t.r ? `
          ${last ? actionCard : t.r.action?.folder ? `<p class="hint">${esc(t.r.action.label ?? t.r.action.folder)} · ${t.r.action.copied ?? 0} files</p>` : ""}
          <p class="answer">${esc(t.r.answer)}</p>
          ${hitsList(t.r, i, last)}` : ""}
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
    ${thread.length && !askBusy ? `<div class="chips followups">${FOLLOWUPS.filter((f) => askResult?.action?.report !== "calls" || f.q === "Share it").filter((f) => f.when(askResult)).map((f) => `<button class="chip" data-suggest="${esc(f.q)}">${esc(f.q)}</button>`).join("")}</div>` : ""}`;
  return `
    <div class="sheet">
      <div class="bar">
        <button class="iconbtn ghost" id="close-search" aria-label="Back">${I.back}</button>
        <div class="crumbs"><div class="title">Agent</div><div class="sub">Runs on this phone · ${thread.length ? `${thread.length} message${thread.length === 1 ? "" : "s"}` : "offline"}</div></div>
        <!-- Always shown (with a label) so past conversations are findable even before the first "New chat". -->
        <button class="btn small secondary" id="chat-history" aria-label="Past chats">${icon("history", 16)} History${pastChats.length ? ` · ${pastChats.length}` : ""}</button>
        ${thread.length ? `<button class="btn small secondary" id="new-chat" aria-label="New chat">${icon("plus", 16)} New chat</button>` : ""}
      </div>
      ${historyOpen ? `<div class="scrim" id="history-scrim"><div class="drawer"><div class="grab"></div>
        <div class="head"><h3>Past chats</h3><button class="iconbtn ghost" id="history-close" aria-label="Close">${I.close}</button></div>
        ${pastChats.length ? "" : `<p class="note" style="padding:12px 16px">No past chats yet. Tapping “New chat” saves the current conversation here.</p>`}
        <ul class="list">${pastChats.map((c, i) => `<li data-past="${i}"><span class="kind ft-doc">${icon("chat", 20)}</span><div class="grow"><div class="t">${esc(c.title)}</div><div class="s">${esc(new Date(c.at).toLocaleString())} · ${c.thread.length} message${c.thread.length === 1 ? "" : "s"}</div></div>${icon("chevron", 18)}</li>`).join("")}</ul></div></div>` : ""}
      <div class="body" id="ask-body">
        ${modelsLine}
        ${indexLine}
        ${modelsSection()}
        ${body}
      </div>
      <!-- Composer at the bottom, like a chat: the conversation stays in view above the keyboard. -->
      <div class="bar composer">
        <div class="field">${I.agent}<input id="ask-input" type="text" enterkeyhint="send" placeholder="${thread.length ? "Follow up, or ask something new" : "Ask or tell me what to do"}" value="${esc(askQuery)}" autocomplete="off" />
          ${askQuery ? `<button id="clear-ask" aria-label="Clear">${I.close}</button>` : ""}</div>
        <button class="iconbtn primary" id="ask-send" aria-label="Send" ${askBusy ? "disabled" : ""}>${icon("up", 20)}</button>
      </div>
    </div>`;
}

function bindSearch() {
  bind("close-search", () => { searchOpen = false; render(); });
  bind("model-info-toggle", () => { modelInfoOpen = !modelInfoOpen; render(); });
  bind("models-download", ensureModels);
  bind("reindex", reindex);
  bind("ensure-models", ensureModels);
  bind("ask-send", () => { const i = document.getElementById("ask-input") as HTMLInputElement | null; if (i) { askQuery = i.value; i.blur(); } void ask(); });
  document.getElementById("ask-input")?.addEventListener("focus", () => {
    // The keyboard shrinks the view: keep the newest turn visible above the composer.
    setTimeout(() => { const b = document.getElementById("ask-body"); if (b) b.scrollTop = b.scrollHeight; }, 250);
  });
  bind("clear-ask", () => { askQuery = ""; render(); (document.getElementById("ask-input") as HTMLInputElement | null)?.focus(); });
  bind("new-chat", () => void newChat());
  bind("chat-history", () => { historyOpen = true; render(); });
  bind("history-close", () => { historyOpen = false; render(); });
  document.getElementById("history-scrim")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) { historyOpen = false; render(); } });
  document.querySelectorAll<HTMLElement>("[data-past]").forEach((el) => el.addEventListener("click", () => void openPastChat(Number(el.dataset.past))));
  document.querySelectorAll<HTMLElement>("[data-more-photos]").forEach((el) => el.addEventListener("click", () => { expandedPhotos.add(Number(el.dataset.morePhotos)); render(); }));
  document.querySelectorAll<HTMLElement>("[data-more-files]").forEach((el) => el.addEventListener("click", () => { expandedFiles.add(Number(el.dataset.moreFiles)); render(); }));
  void loadAskThumbs();
  const bodyEl = document.getElementById("ask-body");
  if (bodyEl && thread.length) bodyEl.scrollTop = bodyEl.scrollHeight;
  const input = document.getElementById("ask-input") as HTMLInputElement | null;
  input?.addEventListener("input", () => { askQuery = input.value; });
  input?.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); askQuery = input.value; input.blur(); void ask(); } });
  document.querySelectorAll<HTMLButtonElement>("[data-suggest]").forEach((b) => b.addEventListener("click", () => void ask(b.dataset.suggest!)));
  document.querySelectorAll<HTMLElement>("[data-hit]").forEach((li) => li.addEventListener("click", () => {
    const hit = thread[Number(li.dataset.turn)]?.r?.sources[Number(li.dataset.hit)];
    if (!hit) return;
    const remote = remotes.find((d) => d.id === hit.driveId);
    if (remote) { void viewRemoteFile(remote, hit.path); return; }
    const share = localFolderFor(hit.driveId);
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
}


function ext(name: string): string {
  const i = name.lastIndexOf(".");
  const e = i >= 0 ? name.slice(i + 1) : "";
  return (e.length > 4 ? e.slice(0, 4) : e || "file").toUpperCase();
}

// ---- file browser

function sortedEntries(entries: FileEntry[]): FileEntry[] {
  const q = (browse?.query ?? "").trim().toLowerCase();
  const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice();
  const { by, dir } = browseSort;
  list.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;   // folders first, like the web
    const c = by === "size" ? (a.size - b.size) : by === "modified" ? (a.mtimeMs - b.mtimeMs) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return c * dir;
  });
  return list;
}

function entryMenu(e: FileEntry, remote: boolean): string {
  return `
      <div class="menu">
        <button data-op="open">${icon(e.isDir ? "folder" : "external", 18)} ${e.isDir ? "Open" : "Open"}</button>
        <button data-op="share">${icon("share", 18)} Share…</button>
        ${e.isDir ? `<button data-op="chat">${icon("chat", 18)} Chat about this folder</button>` : `<button data-op="download">${icon("download", 18)} ${remote ? "Download" : "Open with…"}</button>`}
        <div class="sep"></div>
        <button data-op="rename">${icon("edit", 18)} Rename</button>
        <button data-op="move">${icon("move", 18)} Move…</button>
        <button class="danger" data-op="delete">${icon("trash", 18)} Delete</button>
      </div>`;
}

function browseSheet(): string {
  const share = browseShare();
  if (!browse || !share) return "";
  const b = browse;
  const crumbs = b.path ? b.path.split("/") : [];
  const root = b.remote ? b.remote.name : share.folder.label;
  const title = crumbs.length ? crumbs[crumbs.length - 1] : root;
  const trail = [root, ...crumbs.slice(0, -1)];
  const isBusy = busyShares.has(b.key);
  const remote = !!b.remote;
  let body: string;
  if (b.loading && !b.entries) body = `<div class="searching"><span class="spinner"></span> Loading…</div>`;
  else if (b.error && isGone(b.error) && !b.path && !remote) body = `<div class="empty"><h3>This folder no longer exists</h3><p>It was deleted or moved on the phone.</p><button class="btn secondary" id="browse-forget">Remove from list</button></div>`;
  else if (b.error) body = `<div class="empty"><div class="art">${I.info}</div><h3>Couldn’t read this folder</h3><p>${esc(b.error)}</p><button class="btn secondary" id="browse-retry" style="max-width:220px">${I.refresh} Try again</button></div>`;
  else {
    const list = sortedEntries(b.entries ?? []);
    if (!list.length) body = b.query ? `<div class="empty"><div class="art">${I.search}</div><h3>No matches</h3><p>Nothing in this folder is called “${esc(b.query)}”.</p></div>`
      : `<div class="empty"><div class="art">${I.folder}</div><h3>This folder is empty</h3><p>Upload files or create a folder.</p></div>`;
    else if (browseView === "grid") body = `<div class="tiles">${list.map((e) => {
      const g = fileGlyph(e.name, e.isDir);
      const t = !e.isDir && !remote ? thumbs.get(thumbKey(e.path)) : undefined;
      return `<div class="tile" data-entry="${esc(e.path)}">
        <div class="thumb" data-op="open">${t ? `<img src="${t}" alt="" />` : `<span class="${g.cls}" style="display:inline-flex">${g.svg.replace(/width="22" height="22"/, 'width="44" height="44"')}</span>`}</div>
        <div class="cap"><span class="${g.cls}" style="display:inline-flex">${g.svg.replace(/width="22" height="22"/, 'width="16" height="16"')}</span><div class="name" data-op="open">${esc(e.name)}</div>
          <div class="menu-wrap"><button class="iconbtn ghost" data-op="menu" aria-label="More">${I.more}</button>${b.menu === e.path ? entryMenu(e, remote) : ""}</div></div>
      </div>`;
    }).join("")}</div>`;
    else body = `<ul class="hits files">${list.map((e) => {
      const g = fileGlyph(e.name, e.isDir);
      const meta = e.isDir ? (e.mtimeMs ? new Date(e.mtimeMs).toLocaleDateString() : "Folder") : [prettyBytes(e.size), e.mtimeMs ? new Date(e.mtimeMs).toLocaleDateString() : ""].filter(Boolean).join(" · ");
      return `<li data-entry="${esc(e.path)}" class="${b.menu === e.path ? "selected" : ""}">
        <span class="kind ${g.cls}" data-op="open">${g.svg}</span>
        <div style="min-width:0" data-op="open"><div class="name">${esc(e.name)}</div><div class="meta">${esc(meta)}</div></div>
        <div class="menu-wrap"><button class="iconbtn ghost" data-op="menu" aria-label="More">${I.more}</button>${b.menu === e.path ? entryMenu(e, remote) : ""}</div>
      </li>`;
    }).join("")}</ul>`;
  }
  const sortBtn = (by: typeof browseSort.by, label: string) =>
    `<button data-sort="${by}" aria-pressed="${browseSort.by === by}">${label}${browseSort.by === by ? icon(browseSort.dir === 1 ? "up" : "down", 14) : ""}</button>`;
  return `
    <div class="sheet">
      <div class="bar">
        <button class="iconbtn ghost" id="browse-back" aria-label="Back">${I.back}</button>
        ${b.searching ? `<div class="field">${I.search}<input id="browse-q" type="search" placeholder="Search in this folder" value="${esc(b.query ?? "")}" autocomplete="off" /><button id="browse-q-close" aria-label="Close search">${I.close}</button></div>`
          : `<div class="crumbs"><div class="title">${esc(title)}</div><div class="sub">${crumbs.length ? trail.map((t, i) => `<button data-crumb="${i}">${esc(t)}</button>`).join(" / ") : (remote ? esc(b.remote!.hostname ?? (b.remote!.online ? "Online" : "Offline")) : (driveStatus(share)?.connected ? "Online" : "On this phone"))}</div></div>
        <button class="iconbtn ghost" id="browse-search" aria-label="Search in this folder">${I.search}</button>`}
        <button class="iconbtn primary" id="browse-share" aria-label="Share">${I.share}</button>
        <button class="iconbtn" id="browse-chat" aria-label="Chat">${I.chat}</button>
      </div>
      <div class="toolbar">
        <div class="seg"><button id="view-list" aria-pressed="${browseView === "list"}" aria-label="List">${icon("list", 18)}</button><button id="view-grid" aria-pressed="${browseView === "grid"}" aria-label="Grid">${icon("grid", 18)}</button></div>
        <div class="grow"></div>
        <button class="btn small secondary" id="browse-newfolder" ${isBusy ? "disabled" : ""}>${icon("folderPlus", 16)} New folder</button>
        ${remote ? "" : `<button class="btn small secondary" id="browse-upload" ${isBusy ? "disabled" : ""}>${isBusy ? `<span class="spinner"></span>` : icon("upload", 16)} Upload</button>`}
      </div>
      <div class="body" id="browse-body">
        ${!b.path && b.showcase?.length ? `<div class="section" style="margin-top:4px"><h2>${icon("lock", 14)} For sale</h2></div>
          <div class="tiles" style="margin-bottom:16px">${b.showcase.map((it) => { const g = fileGlyph(it.leafName, false); return `<div class="tile" data-buy="${esc(it.shareId)}">
            <div class="thumb"><span class="${g.cls}">${icon("lock", 36)}</span></div>
            <div class="cap"><div class="name">${esc(it.leafName)}</div><span class="badge accent">${it.price.toFixed(2)} ${esc(it.currency ?? "USDC")}</span></div></div>`; }).join("")}</div>` : ""}
        ${b.entries?.length ? `<div class="sorthead">${sortBtn("name", "Name")} · ${sortBtn("modified", "Modified")} · ${sortBtn("size", "Size")}</div>` : ""}
        ${body}
      </div>
    </div>`;
}

function thumbKey(path: string): string { return `${browse?.key ?? ""}|${path}`; }

/** Grid view: small JPEGs for photos, read on the phone and cached for the session. */
async function loadThumbs() {
  const share = browseShare();
  if (!browse || !share || browse.remote || browseView !== "grid" || !browse.entries) return;
  const want = browse.entries.filter((e) => !e.isDir && guessMime(e.name).startsWith("image/") && !thumbs.has(thumbKey(e.path))).slice(0, 60);
  for (const e of want) {
    thumbs.set(thumbKey(e.path), null);
    try {
      const r = await AindriveAgent.readFile({ folderUri: share.folder.uri, path: e.path, maxPx: 320 });
      thumbs.set(thumbKey(e.path), `data:${r.mime};base64,${r.base64}`);
    } catch { /* leave the icon */ }
  }
  if (want.length && !typing()) render();
}

function bindBrowse() {
  const share = browseShare();
  if (!browse || !share) return;
  const b = browse;
  bind("browse-back", browseBack);
  bind("browse-retry", () => void loadBrowse());
  bind("browse-forget", () => { const sh = browseShare(); browse = null; render(); if (sh) void removeShare(sh); });
  bind("browse-search", () => { b.searching = true; render(); (document.getElementById("browse-q") as HTMLInputElement | null)?.focus(); });
  bind("browse-q-close", () => { b.searching = false; b.query = ""; render(); });
  const q = document.getElementById("browse-q") as HTMLInputElement | null;
  q?.addEventListener("input", () => { b.query = q.value; const pos = q.selectionStart; render(); const n = document.getElementById("browse-q") as HTMLInputElement | null; n?.focus(); n?.setSelectionRange(pos, pos); });
  bind("view-list", () => { browseView = "list"; void Preferences.set({ key: "aindrive.mobile.view", value: "list" }); render(); });
  bind("view-grid", () => { browseView = "grid"; void Preferences.set({ key: "aindrive.mobile.view", value: "grid" }); render(); void loadThumbs(); });
  document.querySelectorAll<HTMLElement>("[data-sort]").forEach((el) => el.addEventListener("click", () => {
    const by = el.dataset.sort as typeof browseSort.by;
    browseSort = browseSort.by === by ? { by, dir: browseSort.dir === 1 ? -1 : 1 } : { by, dir: by === "name" ? 1 : -1 };
    void Preferences.set({ key: "aindrive.mobile.sort", value: JSON.stringify(browseSort) });
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-crumb]").forEach((el) => el.addEventListener("click", () => {
    const i = Number(el.dataset.crumb);
    b.path = b.path.split("/").slice(0, i).join("/");
    void loadBrowse();
  }));
  bind("browse-newfolder", () => void browseNewFolder());
  bind("browse-upload", () => void addFiles(share, b.path));
  bind("browse-share", () => openShareFor(driveIdOf(share, b.remote), b.path, b.path ? b.path.split("/").pop()! : (b.remote?.name ?? share.folder.label)));
  bind("browse-chat", () => openChat(driveIdOf(share, b.remote), b.remote?.name ?? share.folder.label, b.path, b.remote ? b.remote.owned !== false : true));
  document.querySelectorAll<HTMLElement>("[data-entry]").forEach((li) => {
    const entry = b.entries?.find((e) => e.path === li.dataset.entry);
    if (!entry) return;
    li.querySelectorAll<HTMLElement>("[data-op]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const op = el.dataset.op;
        if (op === "menu") { b.menu = b.menu === entry.path ? null : entry.path; b.plusMenu = false; render(); return; }
        b.menu = null;
        if (op === "open") void browseOpen(entry);
        else if (op === "rename") void browseRename(entry);
        else if (op === "delete") void browseDelete(entry);
        else if (op === "move") openMove(entry);
        else if (op === "share") openShareFor(driveIdOf(share, b.remote), entry.path, entry.name);
        else if (op === "chat") openChat(driveIdOf(share, b.remote), b.remote?.name ?? share.folder.label, entry.path, b.remote ? b.remote.owned !== false : true);
        else if (op === "download") void downloadEntry(entry);
      });
    });
  });
  // Tap anywhere else closes open menus.
  document.getElementById("browse-body")?.addEventListener("click", () => {
    if (b.menu || b.plusMenu) { b.menu = null; b.plusMenu = false; render(); }
  });
  document.querySelectorAll<HTMLElement>("[data-buy]").forEach((el) => el.addEventListener("click", () => {
    // Buying needs a wallet: the web's paywall (/s/:token) handles x402 payment.
    if (b.remote) void Browser.open({ url: `${state.server}/api/drives/${b.remote.id}/showcase/${el.dataset.buy}` });
  }));
  if (browseView === "grid") void loadThumbs();
}

/** Local: hand the file to the phone's apps (share/open with). Remote: a signed download link in the browser, like the web. */
async function downloadEntry(entry: FileEntry) {
  const share = browseShare();
  if (!browse || !share) return;
  try {
    if (browse.remote) await Browser.open({ url: await web().downloadUrl(browse.remote.id, entry.path) });
    else await AindriveAgent.openFile({ folderUri: share.folder.uri, path: entry.path });
  } catch (e) { notify(msgOf(e), true); }
}

/** Move = rename into another folder (web: drag onto a folder or breadcrumb). A folder picker sheet. */
function openMove(entry: FileEntry) {
  const share = browseShare();
  if (!browse || !share) return;
  const remote = browse.remote;
  let at = browse.path;
  let dirs: FileEntry[] | null = null;
  let err: string | null = null;
  const list = async () => {
    dirs = null; err = null; render();
    try {
      const all = remote
        ? (await remoteList(state.server, state.sessionCookie!, remote.id, at)).map((e) => ({ ...e, mime: e.mime ?? "" })) as FileEntry[]
        : (await AindriveAgent.listFolder({ folderUri: share.folder.uri, path: at })).entries;
      dirs = all.filter((e) => e.isDir && e.path !== entry.path);
    } catch (e) { err = msgOf(e); dirs = []; }
    render();
  };
  const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
  openSheet(() => ({
    kind: "drawer",
    render: () => `<div class="drawer"><div class="grab"></div>
      <div class="head"><h3>Move “${esc(entry.name)}”</h3><button class="iconbtn ghost" id="mv-close" aria-label="Close">${I.close}</button></div>
      <p class="sub">${esc((remote?.name ?? share.folder.label) + (at ? " / " + at.split("/").join(" / ") : ""))}</p>
      <ul class="hits files">
        ${at ? `<li data-up><span class="kind ft-folder">${icon("back", 20)}</span><div class="name">Up one level</div><span></span></li>` : ""}
        ${dirs === null ? `<li><div class="searching" style="grid-column:1/-1"><span class="spinner"></span></div></li>`
          : (dirs as FileEntry[]).map((d) => `<li data-dir="${esc(d.path)}"><span class="kind ft-folder">${icon("folder", 22)}</span><div class="name">${esc(d.name)}</div>${icon("chevron", 18)}</li>`).join("")}
        ${err ? `<li><span class="meta" style="grid-column:1/-1;color:var(--err)">${esc(err)}</span></li>` : ""}
      </ul>
      <button class="btn" id="mv-here" ${parentOf(entry.path) === at ? "disabled" : ""}>${I.move} Move here</button></div>`,
    bind: (root) => {
      root.querySelector("#mv-close")?.addEventListener("click", closeSheet);
      root.querySelector("[data-up]")?.addEventListener("click", () => { at = parentOf(at); void list(); });
      root.querySelectorAll<HTMLElement>("[data-dir]").forEach((el) => el.addEventListener("click", () => { at = el.dataset.dir!; void list(); }));
      root.querySelector("#mv-here")?.addEventListener("click", () => void (async () => {
        const to = joinPath(at, entry.name);
        try {
          if (remote) await web().rename(remote.id, entry.path, to);
          else await AindriveAgent.rename({ folderUri: share.folder.uri, from: entry.path, to });
          log(`Moved ${entry.name} → /${at}`); notify(`Moved to /${at || ""}`);
          closeSheet(); await loadBrowse();
        } catch (e) { notify(msgOf(e), true); }
      })());
    },
  }));
  void list();
}

// ---- overlays

function viewerSheet(): string {
  if (!viewer) return "";
  const v = viewer;
  const isDoc = v.text !== undefined;
  const md = /\.(md|markdown)$/i.test(v.name);
  const media = v.loading ? `<div class="searching"><span class="spinner"></span> Loading…</div>`
    : isDoc ? (v.editing ? `<textarea class="editor" id="viewer-edit" spellcheck="false">${esc(v.draft ?? v.text ?? "")}</textarea>`
      : `<div class="doc">${md ? renderMarkdown(v.text ?? "") : `<pre>${esc(v.text ?? "")}</pre>`}</div>`)
    : v.mime.startsWith("image/") ? `<img src="${v.src}" alt="${esc(v.name)}" />`
    : v.mime.startsWith("video/") ? `<video controls autoplay playsinline src="${v.src}"></video>`
    : `<audio controls autoplay src="${v.src}"></audio>`;
  return `
    <div class="viewer ${isDoc ? "paper" : ""}" id="viewer">
      <div class="bar">
        <button class="iconbtn" id="viewer-close" aria-label="Close">${I.back}</button>
        <div class="title">${esc(v.name)}</div>
        ${isDoc && !v.loading ? (v.editing
          ? `<button class="btn small" id="viewer-save" ${v.saving ? "disabled" : ""}>${v.saving ? `<span class="spinner"></span>` : I.save} Save</button>`
          : `<button class="iconbtn" id="viewer-editbtn" aria-label="Edit">${I.edit}</button>`) : ""}
        <button class="iconbtn" id="viewer-ext" aria-label="Open with another app" title="Open with another app">${v.remote ? I.download : I.external}</button>
      </div>
      <div class="stage">${media}</div>
    </div>`;
}

function bindViewer() {
  bind("viewer-close", async () => {
    if (viewer?.editing && viewer.draft !== undefined && viewer.draft !== viewer.text
      && !(await confirmAsync("Discard changes?", "Your edits to this file haven't been saved.", "Discard", true))) return;
    viewer = null; render();
  });
  bind("viewer-editbtn", () => { if (viewer) { viewer.editing = true; viewer.draft = viewer.text; render(); (document.getElementById("viewer-edit") as HTMLTextAreaElement | null)?.focus(); } });
  const ta = document.getElementById("viewer-edit") as HTMLTextAreaElement | null;
  ta?.addEventListener("input", () => { if (viewer) viewer.draft = ta.value; });
  bind("viewer-save", () => void saveViewer());
  bind("viewer-ext", () => {
    const v = viewer; if (!v) return;
    if (v.remote) { void web().downloadUrl(v.remote.id, v.path).then((url) => Browser.open({ url })).catch((e) => notify(msgOf(e), true)); return; }
    if (v.share) void AindriveAgent.openFile({ folderUri: v.share.folder.uri, path: v.path }).catch((e) => notify(msgOf(e), true));
  });
}

/** Save the edited text: on this phone through the plugin, elsewhere through the web's fs/write (like the web editors' Save). */
async function saveViewer() {
  const v = viewer; if (!v || v.draft === undefined) return;
  v.saving = true; render();
  try {
    if (v.remote) await web().writeText(v.remote.id, v.path, v.draft);
    else if (v.share) await AindriveAgent.writeText({ folderUri: v.share.folder.uri, path: v.path, text: v.draft });
    v.text = v.draft; v.editing = false;
    log(`Saved ${v.name}`); notify("Saved");
  } catch (e) { notify(msgOf(e), true); }
  v.saving = false; render();
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
  try {
    const v = (await Preferences.get({ key: "aindrive.mobile.view" })).value;
    if (v === "grid" || v === "list") browseView = v;
    const so = (await Preferences.get({ key: "aindrive.mobile.sort" })).value;
    if (so) browseSort = JSON.parse(so);
  } catch { /* defaults */ }
  try { status = await AindriveAgent.status(); } catch { /* plugin absent in browser dev */ }
  await loadThread();
  await loadHistory();
  await pruneMissing();
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
    void pruneMissing();
    AindriveAgent.status().then((s) => { status = s; render(); }).catch(() => {});
    void refreshRemotes();
  });
  void refreshRemotes();
  App.addListener("backButton", () => {
    if (confirmSheet) confirmSheet.resolve(false);
    else if (sheet) closeSheet();
    else if (historyOpen) { historyOpen = false; render(); }
    else if (viewer) { viewer = null; render(); }
    else if (searchOpen) { searchOpen = false; render(); }
    else if (browse) browseBack();
    else if (menuFor) { menuFor = null; render(); }
    else App.exitApp();
  });
  render();
}

void boot();

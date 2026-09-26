/**
 * aindrive for Mac: share a folder with aindrive without a terminal.
 *
 * A small window (and a menu-bar icon) lists the shared folders; "Share a
 * folder…" picks one and runs the bundled CLI agent on it in a utility process (agents.js). The
 * first share signs in the way `aindrive` does — the browser opens aindrive's
 * approve page — and every later launch serves the same folders again, quietly.
 *
 * The web app links here with `aindrive://share` (register: build config
 * `protocols`), so "Share a folder from this Mac" on the website opens this app.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, utilityProcess } from "electron";
import { readFileSync, rmSync } from "node:fs";
import { homedir, uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager, driveUrlOf, isFolder } from "./agents.js";
import { createStore } from "./store.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const DEFAULT_SERVER = process.env.AINDRIVE_SERVER || "https://aindrive.ainetwork.ai";
const CREDS = join(homedir(), ".aindrive", "credentials.json");

// A second copy (say, the one still on the mounted .dmg) hands over to the
// running one and exits right away — before it can start agents of its own.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}
app.setAsDefaultProtocolClient("aindrive");

const store = createStore(join(app.getPath("userData"), "folders.json"));
// Each agent is a utility process — Electron's Node, without the RunAsNode fuse
// (turned off at build time, so no other program can borrow this app's folder
// access by running its binary as plain Node).
const agents = new AgentManager({
  spawn: (folder, firstRun) =>
    utilityProcess.fork(
      join(root, "cli", "aindrive.mjs"),
      [
        folder,
        "--server", store.get().server || DEFAULT_SERVER,
        // the first share opens the browser (sign-in, then the new drive); a relaunch stays quiet
        ...(firstRun ? [] : ["--no-open"]),
      ],
      { cwd: folder, stdio: "pipe", serviceName: `aindrive agent (${basename(folder)})`, env: { ...process.env, NODE_ENV: "production" } },
    ),
});

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
let quitting = false;
/** a share asked for before the app was ready (aindrive:// launch) */
let pendingShare = false;

function account() {
  try {
    const c = JSON.parse(readFileSync(CREDS, "utf8"));
    return { email: c.email || null, server: c.server || null };
  } catch { return null; }
}

function snapshot() {
  return {
    account: account(),
    server: store.get().server || DEFAULT_SERVER,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    folders: agents.list(),
    version: app.getVersion(),
  };
}

function broadcast() {
  win?.webContents.send("state", snapshot());
  rebuildTrayMenu();
}

const LABEL = { starting: "Starting…", approve: "Approve in your browser", connecting: "Connecting…", online: "Online", stopped: "Paused", error: "Needs attention" };
const DOT = { online: "🟢", connecting: "🟡", starting: "🟡", approve: "🟠", stopped: "⚪️", error: "🔴" };

function rebuildTrayMenu() {
  if (!tray) return;
  const folders = agents.list();
  const online = folders.filter((f) => f.state === "online").length;
  tray.setToolTip(folders.length ? `aindrive — ${online}/${folders.length} folders online` : "aindrive");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Share a folder…", click: () => void shareFolder() },
    { type: "separator" },
    ...(folders.length
      ? folders.map((f) => ({
          label: `${DOT[f.state]} ${f.name}`,
          sublabel: LABEL[f.state],
          submenu: [
            { label: "Open in aindrive", enabled: !!f.url, click: () => f.url && shell.openExternal(f.url) },
            { label: "Show in Finder", click: () => reveal(f.folder) },
            f.state === "stopped"
              ? { label: "Resume sharing", click: () => resume(f.folder) }
              : { label: "Pause sharing", click: () => pause(f.folder) },
          ],
        }))
      : [{ label: "No folders shared yet", enabled: false }]),
    { type: "separator" },
    { label: "Open aindrive window", click: showWindow },
    { label: "Open aindrive on the web", click: () => shell.openExternal(store.get().server || DEFAULT_SERVER) },
    { type: "separator" },
    { label: "Quit aindrive (stops sharing)", click: () => app.quit() },
  ]));
}

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 460,
    height: 600,
    minWidth: 380,
    minHeight: 420,
    title: "aindrive",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f6f8fc",
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(join(here, "ui", "index.html"));
  win.once("ready-to-show", () => win?.show());
  // links in the window open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("close", (e) => {
    // closing the window keeps sharing — the menu-bar icon stays
    if (!quitting) {
      e.preventDefault();
      win?.hide();
      app.dock?.hide();
    }
  });
  win.on("show", () => app.dock?.show());
  win.on("closed", () => { win = null; });
}

async function shareFolder(picked) {
  let folder = picked;
  if (!folder) {
    showWindow();
    const r = await dialog.showOpenDialog(win ?? undefined, {
      title: "Share a folder with aindrive",
      buttonLabel: "Share",
      message: "Choose a folder. Its files stay on this Mac; aindrive shows them on the web while this app runs.",
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return;
    folder = r.filePaths[0];
  }
  if (!isFolder(folder)) {
    await dialog.showMessageBox(win ?? undefined, { type: "info", message: "Only folders can be shared.", detail: `${basename(folder)} is a file. Drop or choose the folder that holds it.` });
    return;
  }
  if (folder === homedir() || folder === "/") {
    const ok = await dialog.showMessageBox(win ?? undefined, {
      type: "warning",
      buttons: ["Choose another folder", "Share anyway"],
      defaultId: 0,
      message: `Share your whole ${folder === "/" ? "disk" : "home folder"}?`,
      detail: "Everything in it becomes reachable from aindrive on the web. A single folder, like Documents, is usually what you want.",
    });
    if (ok.response === 0) return void shareFolder();
  }
  store.update((s) => ({ ...s, folders: [...s.folders.filter((f) => f.path !== folder), { path: folder, paused: false }] }));
  // never paired → let the CLI open the browser (sign-in, then the new drive)
  agents.start(folder, { firstRun: !driveUrlOf(folder) });
  // sharing is meant to last: come back after a restart unless the user said otherwise
  if (!store.get().loginItemAsked) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    store.update((s) => ({ ...s, loginItemAsked: true }));
  }
  broadcast();
}

/** Open a shared folder in Finder — never "open" anything that has an extension
 *  (.app, .pkg, .prefPane… are folders that macOS would launch or install). */
function reveal(folder) {
  if (/\.[A-Za-z0-9-]+\/?$/.test(basename(folder))) shell.showItemInFolder(folder);
  else void shell.openPath(folder);
}

function pause(folder) {
  agents.stop(folder);
  store.update((s) => ({ ...s, folders: s.folders.map((f) => (f.path === folder ? { ...f, paused: true } : f)) }));
}

function resume(folder) {
  agents.start(folder);
  store.update((s) => ({ ...s, folders: s.folders.map((f) => (f.path === folder ? { ...f, paused: false } : f)) }));
}

function remove(folder) {
  agents.remove(folder);
  store.update((s) => ({ ...s, folders: s.folders.filter((f) => f.path !== folder) }));
}

/** A folder the app shares — what the window may ask to open. */
const known = (folder) => typeof folder === "string" && agents.has(folder);

/** aindrive://share[?server=https://…] — from the website's "Share from this Mac". */
function handleUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return; }
  if (u.protocol !== "aindrive:") return;
  const server = u.searchParams.get("server");
  // Any web page can open an aindrive:// link, so a link may only pick the
  // default server — or, in a development build, a local one. Never send a
  // folder somewhere else.
  const wanted = server?.replace(/\/$/, "");
  const devServer = !app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(wanted ?? "");
  if (wanted && (wanted === DEFAULT_SERVER || devServer)) {
    store.update((s) => ({ ...s, server: wanted === DEFAULT_SERVER ? undefined : wanted }));
  }
  const action = u.hostname || u.pathname.replace(/^\/+/, "");
  if (action === "share") {
    if (app.isReady()) void shareFolder();
    else pendingShare = true;
  } else if (app.isReady()) showWindow();
}

app.on("open-url", (e, url) => { e.preventDefault(); handleUrl(url); });
app.on("second-instance", (_e, argv) => {
  const link = argv.find((a) => a.startsWith("aindrive://"));
  if (link) handleUrl(link);
  else showWindow();
});

ipcMain.handle("state", () => snapshot());
ipcMain.handle("share", (_e, folder) => shareFolder(typeof folder === "string" ? folder : undefined));
ipcMain.handle("pause", (_e, folder) => known(folder) && pause(folder));
ipcMain.handle("resume", (_e, folder) => known(folder) && resume(folder));
ipcMain.handle("remove", async (_e, folder) => {
  if (!known(folder)) return;
  const r = await dialog.showMessageBox(win ?? undefined, {
    type: "question",
    buttons: ["Cancel", "Stop sharing"],
    defaultId: 1,
    message: `Stop sharing “${basename(folder)}”?`,
    detail: "It goes offline on aindrive. Nothing on this Mac is deleted, and sharing it again later brings back the same drive.",
  });
  if (r.response === 1) remove(folder);
});
ipcMain.handle("open", (_e, what, folder) => {
  if (!known(folder)) return;
  if (what === "finder") return reveal(folder);
  const url = agents.list().find((f) => f.folder === folder)?.[what === "login" ? "loginUrl" : "url"];
  if (url && /^https?:\/\//.test(url)) return shell.openExternal(url);
});
ipcMain.handle("web", () => shell.openExternal(store.get().server || DEFAULT_SERVER));
ipcMain.handle("openAtLogin", (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  broadcast();
});
ipcMain.handle("signOut", async () => {
  const r = await dialog.showMessageBox(win ?? undefined, {
    type: "question",
    buttons: ["Cancel", "Sign out"],
    defaultId: 1,
    message: "Sign out of aindrive on this Mac?",
    detail: "Folders already shared keep working. Sharing a new folder will ask you to sign in again.",
  });
  if (r.response === 1) {
    rmSync(CREDS, { force: true });
    broadcast();
  }
});

agents.on("change", broadcast);

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(join(root, "assets", "trayTemplate.png"));
  img.setTemplateImage(true);
  tray = new Tray(img);
  for (const f of store.get().folders) {
    // one bad entry must not keep the others (or the menu) from coming back
    try {
      if (f.paused) agents.addStopped(f.path);
      else agents.start(f.path); // a folder on a drive that is not connected waits and retries
    } catch (e) {
      console.error("could not restore", f.path, e);
    }
  }
  rebuildTrayMenu();
  // Started at login: stay in the menu bar; opened by hand: show the window.
  // macOS 13+ (SMAppService) no longer reports "opened at login", so a launch
  // in the first minutes after boot, with folders to serve, counts as one.
  const s = app.getLoginItemSettings();
  const atLogin = s.wasOpenedAtLogin || s.wasOpenedAsHidden ||
    (s.openAtLogin && store.get().folders.length > 0 && uptime() < 180);
  if (!atLogin) showWindow();
  else app.dock?.hide();
  if (pendingShare) void shareFolder();
  const link = process.argv.find((a) => a.startsWith("aindrive://"));
  if (link) handleUrl(link);
});

app.on("activate", showWindow);
app.on("window-all-closed", () => { /* keep running in the menu bar */ });
app.on("before-quit", async (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  await agents.stopAll();
  app.quit();
});

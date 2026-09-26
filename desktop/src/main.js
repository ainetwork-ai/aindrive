/**
 * aindrive for Mac — the same app as on the phone.
 *
 * The window is the mobile shell (mobile/src, built into shell/ by
 * scripts/prepare-shell.mjs): same screens, same features. What a phone does
 * natively, the Mac does here:
 *
 *   AindriveAgent     mac-agent.js — folders served by the bundled CLI agent
 *                     (agents.js, one utility process per drive), files read
 *                     locally, Quick Look, thumbnails, name search for `ask`
 *   CapacitorHttp     every http(s) fetch leaves from this process with the
 *                     session cookie (shell/mac-bridge.js → native:fetch)
 *   CapacitorCookies  that cookie jar (the default session's)
 *   Finder            remote drives (other devices', shared with you) mounted
 *                     as /Volumes/aindrive — webdav.js on loopback, finder.js
 *
 * Drives keep being served with the window closed (menu-bar icon) and come
 * back at login — the phone's foreground service. `aindrive://share` from the
 * website opens the window.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, session, shell, Tray, utilityProcess } from "electron";
import { existsSync } from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentManager } from "./agents.js";
import { createMacAgent } from "./mac-agent.js";
import { createStore } from "./store.js";
import { createDavServer } from "./webdav.js";
import { MOUNT_POINT, mountVolume, mountedUrl, serverApi, unmountVolume } from "./finder.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const shellDir = join(root, "shell");
const DEFAULT_SERVER = process.env.AINDRIVE_SERVER || "https://aindrive.ainetwork.ai";

// A second copy (say, the one still on the mounted .dmg) hands over to the
// running one and exits right away — before it can start agents of its own.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}
app.setAsDefaultProtocolClient("aindrive");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const store = createStore(join(app.getPath("userData"), "folders.json"));
// Each agent is a utility process — Electron's Node, without the RunAsNode fuse
// (turned off at build time, so no other program can borrow this app's folder
// access by running its binary as plain Node).
const agents = new AgentManager({
  spawn: (folder, firstRun) => {
    const cfgServer = serverOf(folder);
    return utilityProcess.fork(
      join(root, "cli", "aindrive.mjs"),
      [folder, "--server", cfgServer, ...(firstRun ? [] : ["--no-open"])],
      { cwd: folder, stdio: "pipe", serviceName: `aindrive agent (${basename(folder)})`, env: { ...process.env, NODE_ENV: "production" } },
    );
  },
});
/** The server a folder was paired with (its CLI config), else the default. */
function serverOf(folder) {
  const d = (store.get().drives ?? []).find((x) => x.folder === folder);
  return d?.server || DEFAULT_SERVER;
}

/** @type {BrowserWindow|null} */
let win = null;
/** @type {Tray|null} */
let tray = null;
let quitting = false;

const mac = createMacAgent({
  agents,
  store,
  electron: { dialog, nativeImage, shell, getWindow: () => win },
  thumbsDir: join(app.getPath("userData"), "thumbs"),
  emit: (status) => {
    win?.webContents.send("native:event", "AindriveAgent", "statusChanged", status);
    rebuildTrayMenu();
  },
});
mac.migrate();

// ── the shell's native calls ───────────────────────────────────────────────

const AGENT_METHODS = new Set(["pickFolder", "requestCallLog", "addFiles", "mkdir", "rename", "writeText", "delete", "listFolder",
  "openFile", "readFile", "googleSignIn", "registerHandoffs", "thumbnail", "start", "stop", "status", "reindex", "ensureModels", "ask", "adoptable"]);

async function cookiesCall(method, o) {
  const ses = session.defaultSession;
  const url = typeof o?.url === "string" && /^https?:\/\//.test(o.url) ? o.url : null;
  switch (method) {
    case "setCookie": {
      if (!url || typeof o.key !== "string") throw new Error("setCookie needs url and key");
      const https = url.startsWith("https:");
      await ses.cookies.set({ url, name: o.key, value: String(o.value ?? ""), path: o.path || "/", secure: https, httpOnly: true, sameSite: https ? "no_restriction" : "lax", expirationDate: Date.now() / 1000 + 60 * 60 * 24 * 365 });
      return;
    }
    case "getCookies": {
      const list = url ? await ses.cookies.get({ url }) : [];
      return Object.fromEntries(list.map((c) => [c.name, c.value]));
    }
    case "deleteCookie":
      if (url && typeof o.key === "string") await ses.cookies.remove(url, o.key);
      return;
    case "clearCookies":
      if (url) for (const c of await ses.cookies.get({ url })) await ses.cookies.remove(url, c.name);
      return;
    case "clearAllCookies":
      await ses.clearStorageData({ storages: ["cookies"] });
      return;
    default:
      throw new Error(`CapacitorCookies.${method} is not on the Mac`);
  }
}

ipcMain.handle("native:call", async (e, plugin, method, options) => {
  if (e.sender !== win?.webContents) throw new Error("not the aindrive window");
  if (plugin === "CapacitorCookies") return cookiesCall(method, options);
  if (plugin !== "AindriveAgent" || !AGENT_METHODS.has(method)) throw new Error(`${plugin}.${method} is not on the Mac`);
  return mac[method](options ?? {});
});

ipcMain.handle("native:fetch", async (e, req) => {
  if (e.sender !== win?.webContents) throw new Error("not the aindrive window");
  if (!/^https?:\/\//i.test(req?.url ?? "")) throw new Error("only http(s)");
  const headers = new Headers();
  for (const [k, v] of req.headers ?? []) if (!/^(cookie|host|origin|content-length)$/i.test(k)) headers.append(k, v);
  return sendRequest(req.url, req.method, headers, req.body);
});

/**
 * One http(s) request from this process, with the session's cookies — the
 * phone's native cookie jar. Redirects are followed only within the origin
 * asked for: a third party (an A2A agent URL) must not bounce a request, cookie
 * attached, onto the aindrive server. Any other redirect comes back as its 3xx.
 */
function sendRequest(url, method, headers, body) {
  const origin = new URL(url).origin;
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method, redirect: "manual", useSessionCookies: true });
    for (const [k, v] of headers) req.setHeader(k, v);
    let hops = 0;
    req.on("redirect", (status, _method, to, resHeaders) => {
      if (new URL(to).origin === origin && hops++ < 5) return req.followRedirect();
      req.abort();
      resolve({ status, statusText: "", headers: flat(resHeaders), body: new Uint8Array() });
    });
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, statusText: res.statusMessage, headers: flat(res.headers), body: new Uint8Array(Buffer.concat(chunks)) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(Buffer.from(body));
    req.end();
  });
}

/** Response headers as pairs, never Set-Cookie (the jar keeps those). */
function flat(h) {
  const out = [];
  for (const [k, v] of Object.entries(h ?? {})) {
    if (k.toLowerCase() === "set-cookie") continue;
    for (const x of Array.isArray(v) ? v : [v]) out.push([k, String(x)]);
  }
  return out;
}

// ── remote drives in Finder ────────────────────────────────────────────────

/** The server this app is signed in to: one it paired folders with, else the default — whichever has the session cookie. */
async function signedInServer() {
  const s = store.get();
  const candidates = [...new Set([...(s.drives ?? []).map((d) => d.server), s.server, DEFAULT_SERVER].filter(Boolean))];
  for (const url of candidates) if ((await session.defaultSession.cookies.get({ url })).length) return url.replace(/\/+$/, "");
  return null;
}

let finderServer = null;
/** A call to the signed-in server with the session's cookies; the response body streams. */
function serverRequest(method, path, { headers = {}, body, json } = {}) {
  return new Promise((resolve, reject) => {
    if (!finderServer) return reject(Object.assign(new Error("not signed in"), { status: 401 }));
    const req = net.request({ url: finderServer + path, method, redirect: "error", useSessionCookies: true });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.on("response", (res) => {
      const h = {};
      for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v);
      resolve({ status: res.statusCode, headers: h, body: res });
    });
    req.on("error", reject);
    (async () => {
      if (json !== undefined) { req.setHeader("content-type", "application/json"); req.end(JSON.stringify(json)); return; }
      if (!body) { req.end(); return; }
      if (Buffer.isBuffer(body)) { req.end(body); return; }
      req.chunkedEncoding = true;
      for await (const c of body) req.write(Buffer.from(c));
      req.end();
    })().catch((e) => { req.abort(); reject(e); });
  });
}

let dav = null;
let davUrl = null;
let finderMounted = false;
/** Mount the remote drives when signed in and there are any; unmount when turned off. Idempotent — runs every minute. */
async function syncFinder() {
  try {
    if (store.get().finder === false) { await unmountVolume(); finderMounted = false; return; }
    finderServer = await signedInServer();
    if (!finderServer) return;
    if (!dav) {
      dav = createDavServer({
        api: serverApi(serverRequest),
        // this Mac's own folders are in Finder already, as themselves
        excludeIds: () => new Set((store.get().drives ?? []).map((d) => d.driveId)),
        log: (m) => console.warn(m),
      });
      davUrl = await dav.listen();
    }
    const own = new Set((store.get().drives ?? []).map((d) => d.driveId));
    const remote = (await serverApi(serverRequest).drives()).filter((d) => !own.has(d.id));
    if (!remote.length) return;
    dav.refresh();
    finderMounted = await mountVolume(davUrl);
  } catch (e) {
    console.warn(`finder: ${e?.message ?? e}`);   // signed out (401), offline: try again next time
  } finally { rebuildTrayMenu(); }
}

// ── window, menu bar ───────────────────────────────────────────────────────

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 430,
    height: 860,
    minWidth: 360,
    minHeight: 560,
    title: "aindrive",
    backgroundColor: "#f8fafd",
    show: false,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL("app://shell/index.html");
  win.once("ready-to-show", () => win?.show());
  // links open in the browser (the shell's Browser.open), never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("app://shell/")) e.preventDefault(); });
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

const DOT = { online: "🟢", connecting: "🟡", starting: "🟡", approve: "🟠", stopped: "⚪️", error: "🔴" };

function rebuildTrayMenu() {
  if (!tray) return;
  const s = mac.status();
  const served = s.drives.filter((d) => d.p2p);
  const online = served.filter((d) => d.connected).length;
  tray.setToolTip(served.length ? `aindrive — ${online}/${served.length} folders online` : "aindrive");
  const byFolder = new Map(agents.list().map((a) => [a.folder, a]));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open aindrive", click: showWindow },
    { type: "separator" },
    ...(served.length
      ? (store.get().drives ?? []).filter((d) => !d.localOnly).map((d) => {
          const a = byFolder.get(d.folder);
          const url = a?.url;
          // the files are on this Mac: opening the folder means Finder; the drive's page is for elsewhere
          return {
            label: `${DOT[a?.state ?? "stopped"]} ${d.label ?? basename(d.folder)}`,
            submenu: [
              { label: "Open folder", click: () => reveal(d.folder) },
              { label: "Open on the web", enabled: !!url, click: () => url && shell.openExternal(url) },
            ],
          };
        })
      : [{ label: "No folders shared yet", enabled: false }]),
    { type: "separator" },
    { label: "Open remote drives in Finder", enabled: finderMounted, click: () => void shell.openPath(MOUNT_POINT) },
    {
      label: "Remote drives in Finder", type: "checkbox", checked: store.get().finder !== false,
      click: (item) => { store.update((s) => ({ ...s, finder: item.checked })); void syncFinder(); },
    },
    { label: "Open aindrive on the web", click: () => shell.openExternal(DEFAULT_SERVER) },
    { type: "separator" },
    { label: "Quit aindrive (stops sharing)", click: () => app.quit() },
  ]));
}

/** Open a shared folder in Finder — never "open" anything with an extension
 *  (.app, .pkg, .prefPane… are folders that macOS would launch or install). */
function reveal(folder) {
  if (/\.[A-Za-z0-9-]+\/?$/.test(basename(folder))) shell.showItemInFolder(folder);
  else void shell.openPath(folder);
}

/** app://shell/… is the shell's files; app://thumb/… the thumbnails mac-agent made. */
function serveApp(request) {
  const u = new URL(request.url);
  const base = u.host === "shell" ? shellDir : u.host === "thumb" ? join(app.getPath("userData"), "thumbs") : null;
  if (!base) return new Response("not found", { status: 404 });
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "") || "index.html";
  const file = normalize(join(base, rel));
  if (!file.startsWith(base + sep) || !existsSync(file)) return new Response("not found", { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

app.on("open-url", (e) => { e.preventDefault(); if (app.isReady()) showWindow(); });
app.on("second-instance", () => showWindow());

app.whenReady().then(() => {
  protocol.handle("app", serveApp);
  const img = nativeImage.createFromPath(join(root, "assets", "trayTemplate.png"));
  img.setTemplateImage(true);
  tray = new Tray(img);
  mac.restore();
  // sharing is meant to last: come back at login once something is shared
  if ((store.get().drives ?? []).length && !store.get().loginItemSet) {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    store.update((s) => ({ ...s, loginItemSet: true }));
  }
  rebuildTrayMenu();
  // Remote drives in Finder: once signed in (the shell may still be signing in), then every minute.
  setTimeout(() => void syncFinder(), 3_000);
  setInterval(() => void syncFinder(), 60_000);
  // Started at login: stay in the menu bar; opened by hand: show the window.
  // macOS 13+ (SMAppService) no longer reports "opened at login", so a launch
  // in the first minutes after boot, with folders to serve, counts as one.
  const s = app.getLoginItemSettings();
  const atLogin = s.wasOpenedAtLogin || s.wasOpenedAsHidden ||
    (s.openAtLogin && (store.get().drives ?? []).length > 0 && uptime() < 180);
  if (!atLogin) showWindow();
  else app.dock?.hide();
});

app.on("activate", showWindow);
app.on("window-all-closed", () => { /* keep serving from the menu bar */ });
app.on("before-quit", async (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  // the volume's server lives in this process: leave no dead mount behind
  if (dav && (await mountedUrl()) === davUrl) await unmountVolume();
  await agents.stopAll();
  app.quit();
});

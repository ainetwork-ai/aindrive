// The window: the shared folders and their state, from the main process.
const api = window.aindrive;

const LABEL = {
  starting: "Starting…",
  approve: "Approve in your browser",
  connecting: "Connecting…",
  online: "Online",
  stopped: "Paused",
  error: "Needs attention",
};

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") n.addEventListener("click", v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

function render(s) {
  $("account").textContent = s.account?.email
    ? `Signed in as ${s.account.email}`
    : s.account ? "Signed in" : "Not signed in — you'll sign in on your first share";
  $("signout").hidden = !s.account;
  $("login").checked = !!s.openAtLogin;
  $("empty").hidden = s.folders.length > 0;
  const list = $("folders");
  list.replaceChildren(
    ...s.folders.map((f) => {
      const busy = f.state === "stopped";
      const detail =
        f.state === "approve"
          ? "Your browser opened aindrive — click Approve there."
          : f.state === "error"
            ? f.detail || "Something went wrong."
            : f.folder;
      return el(
        "li",
        { class: `folder state-${f.state}` },
        el("div", { class: "row" },
          el("span", { class: "dot", title: LABEL[f.state] }),
          el("div", { class: "info" },
            el("div", { class: "name", title: "Open in Finder", style: "cursor:pointer", onclick: () => api.open("finder", f.folder) }, f.name),
            el("div", { class: "detail muted", title: f.folder }, detail),
          ),
          el("span", { class: "badge" }, LABEL[f.state]),
        ),
        el("div", { class: "actions" },
          f.state === "approve" && f.loginUrl
            ? el("button", { class: "small primary", onclick: () => api.open("login", f.folder) }, "Open approve page")
            : null,
          f.state === "error" && !f.url
            ? el("button", { class: "small primary", onclick: () => api.share(f.folder) }, "Try again")
            : null,
          // The folder is on this Mac: opening it means Finder. The drive's web page is for other devices
          // (and needs a browser signed into the same account).
          el("button", { class: "small primary", onclick: () => api.open("finder", f.folder) }, "Open folder"),
          f.url ? el("button", { class: "small", onclick: () => api.open("web", f.folder) }, "Open on the web") : null,
          busy
            ? el("button", { class: "small", onclick: () => api.resume(f.folder) }, "Resume")
            : f.url ? el("button", { class: "small", onclick: () => api.pause(f.folder) }, "Pause") : null,
          el("button", { class: "small danger", onclick: () => api.remove(f.folder) }, "Stop sharing"),
        ),
      );
    }),
  );
}

$("share").addEventListener("click", () => api.share());
$("web").addEventListener("click", () => api.web());
$("signout").addEventListener("click", () => api.signOut());
$("login").addEventListener("change", (e) => api.setOpenAtLogin(e.target.checked));

// drop a folder from Finder onto the window to share it
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  for (const f of e.dataTransfer?.files ?? []) {
    const p = api.pathOf(f);
    if (p) api.share(p);
  }
});

api.onState(render);
api.state().then(render);

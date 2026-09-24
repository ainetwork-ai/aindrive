#!/usr/bin/env python3
"""Run the 100 agent TASK scenarios (make-task-scenarios.py) on the phone.

    python3 scripts/make-real-corpus.py <photos> <audio> <dir>
    python3 scripts/make-task-scenarios.py <dir>
    python3 scripts/run-task-scenarios.py <dir> [--sub real-corpus] [--skip-push]

For each scenario the agent is asked over adb and its `action` is checked;
for collect/move the new folder's contents are listed on the phone and
compared; delete must stay pending with the files still there; count and
top-N are checked against the answer. Folders the agent creates are
removed after each scenario; the corpus is re-pushed after the move group.
"""
import html
import json
import os
import re
import subprocess
import sys
import time
from urllib.parse import unquote

DIR = sys.argv[1]
SUB = sys.argv[sys.argv.index("--sub") + 1] if "--sub" in sys.argv else "real-corpus"
SKIP_PUSH = "--skip-push" in sys.argv
PKG = "ai.ainetwork.aindrive"

def adb(*a): return subprocess.run(["adb", *a], capture_output=True, text=True)
def sh(cmd): return adb("shell", cmd).stdout

def state():
    xml = adb("shell", "run-as", PKG, "cat", "shared_prefs/CapacitorStorage.xml").stdout
    m = re.search(r'name="aindrive.mobile.state.v2">(.*?)</string>', xml, re.S)
    if not m: sys.exit("app state not found")
    return json.loads(html.unescape(m.group(1)))

def hook(action, **extras):
    cmd = ["shell", "am", "start", "-n", f"{PKG}/.MainActivity", "--es", "agentAction", action]
    for k, v in extras.items():
        if isinstance(v, bool): cmd += ["--ez", k, "true" if v else "false"]
        else: cmd += ["--es", k, "'" + str(v).replace("'", "'\\''") + "'"]
    return adb(*cmd)

st = state(); share = st["shares"][0]; d = share["drive"]; uri = share["folder"]["uri"]
vol, _, rel = unquote(uri.split("/tree/")[1]).partition(":")
root = ("/sdcard/" if vol == "primary" else f"/storage/{vol}/") + rel
q = lambda p: "'" + p.replace("'", "'\\''") + "'"

def start_drive(index=False):
    adb("shell", "am", "force-stop", PKG)
    if index:
        for f in adb("shell", "run-as", PKG, "ls", "files/index").stdout.split():
            adb("shell", "run-as", PKG, "rm", "-f", f"files/index/{f}")
    adb("logcat", "-c")
    hook("ai.ainetwork.aindrive.START", serverUrl=st["server"], driveId=d["driveId"], agentToken=d["agentToken"],
         driveSecret=d["driveSecret"], folderUri=uri, folderLabel=share["folder"]["label"], indexOnStart=True)
    for _ in range(1800):
        time.sleep(1)
        log = adb("logcat", "-d", "-s", "AindriveIndexer").stdout
        if re.search(r"recognised \d+ files", log) or (re.search(r"indexed \d+ files", log) and "vision_model" not in adb("shell", "run-as", PKG, "ls", "files/models/clip").stdout): return
    sys.exit("indexing did not finish")

def push_corpus():
    adb("shell", "rm", "-rf", q(f"{root}/{SUB}"))
    for w in ("test-corpus", "real-corpus"):
        if w != SUB: adb("shell", "rm", "-rf", q(f"{root}/{w}"))
    r = adb("push", os.path.join(DIR, "corpus"), f"{root}/{SUB}")
    if r.returncode: sys.exit(r.stderr)

def ask(query, timeout=40):
    adb("logcat", "-c")
    hook("ai.ainetwork.aindrive.ASK", query=query)
    for _ in range(timeout * 2):
        time.sleep(0.5)
        log = re.sub(r"^.*?AindriveAgent: ", "", adb("logcat", "-d", "-s", "AindriveAgent").stdout, flags=re.M)
        m = re.search(r"ask\((.*?)\) → (\{.*)", log, re.S)
        if m:
            try: return json.loads(m.group(2).strip())
            except json.JSONDecodeError: continue
    return None

def ls(path):
    out = sh(f"ls -1 {q(path)} 2>/dev/null")
    return sorted(x for x in out.split("\n") if x.strip())

def exists(path): return sh(f"test -e {q(path)} && echo yes").strip() == "yes"

def snippet_dates(srcs):
    out = []
    for s in srcs:
        m = re.search(r"\d{4}-\d{2}-\d{2}", s["snippet"]); out.append(m.group(0) if m else None)
    return out

def snippet_sizes(srcs):
    out = []
    for s in srcs:
        m = re.search(r"([\d.]+) (B|KB|MB|GB)", s["snippet"])
        if not m: out.append(None); continue
        out.append(float(m.group(1)) * {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9}[m.group(2)])
    return out

scen = json.load(open(os.path.join(DIR, "task-scenarios.json"), encoding="utf-8"))["scenarios"]
# --only T001,T007 : run a subset (after fixing something)
if "--only" in sys.argv:
    only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
    scen = [s for s in scen if s["id"] in only]
if not SKIP_PUSH: push_corpus()
start_drive(index=True)

passed, failed = 0, []
created = []
for s in scen:
    a = ask(s["q"])
    want = s["action"]
    problems = []
    if a is None:
        failed.append((s, "no answer", [])); continue
    act = a.get("action") or {}
    if want.get("type") is not None and act.get("type") != want["type"]: problems.append(f"action.type {act.get('type')!r} ≠ {want['type']!r}")
    if want.get("skipped"):
        if not act.get("skipped"): problems.append("expected skipped")
        if act.get("folder"): problems.append("a folder was made")
    if "folder" in want and not want.get("skipped"):
        folder = act.get("folder")
        if act.get("skipped"): problems.append(f"skipped: {act.get('reason')}")
        elif not folder: problems.append("no folder in action")
        else:
            created.append(folder)
            got = ls(f"{root}/{folder}")
            if "folderFiles" in s and got != s["folderFiles"]:
                problems.append(f"folder has {len(got)} files, want {len(s['folderFiles'])}: missing {sorted(set(s['folderFiles']) - set(got))[:4]} extra {sorted(set(got) - set(s['folderFiles']))[:4]}")
            if "folderMustInclude" in s:
                must, must_not = set(s["folderMustInclude"]), set(s["folderMustExclude"])
                recall = len(must & set(got)) / max(1, len(must))
                if recall < s.get("minRecall", 1): problems.append(f"folder recall {recall:.0%} < {s.get('minRecall', 1):.0%} ({len(got)} files)")
                if must_not & set(got): problems.append(f"folder contains excluded {sorted(must_not & set(got))[:3]}")
            if want.get("share") and not act.get("share"): problems.append("share flag missing")
            if want["type"] == "move":
                still = [f for f in (s.get("folderFiles") or []) if exists(f"{root}/{SUB}/Photos/Nice/{f}") or exists(f"{root}/{SUB}/Recordings/{f}")]
                # originals must be gone: check by name anywhere under the corpus
                remaining = sh(f"find {q(root + '/' + SUB)} -type f 2>/dev/null").split("\n")
                names_left = {os.path.basename(x) for x in remaining}
                gone = [f for f in (s.get("folderFiles") or []) if f not in names_left]
                if len(gone) != len(s.get("folderFiles") or []): problems.append(f"move left {len(s['folderFiles']) - len(gone)} originals behind")
    if want.get("type") == "count":
        n = act.get("count")
        if "countAtLeast" in s:
            if n is None or n < s["countAtLeast"]: problems.append(f"count {n} < {s['countAtLeast']}")
        elif n != want.get("count"): problems.append(f"count {n} ≠ {want.get('count')}")
    if "listLength" in s:
        srcs = [x for x in a["sources"] if x["path"].startswith(SUB + "/")]
        if len(a["sources"]) != s["listLength"]: problems.append(f"list has {len(a['sources'])} rows, want {s['listLength']}")
        if s["order"] in ("newest", "oldest"):
            ds = [x for x in snippet_dates(a["sources"]) if x]
            ok = all((ds[i] >= ds[i + 1]) if s["order"] == "newest" else (ds[i] <= ds[i + 1]) for i in range(len(ds) - 1))
            if not ok: problems.append(f"not ordered {s['order']}: {ds}")
        if s["order"] == "size":
            sz = [x for x in snippet_sizes(a["sources"]) if x is not None]
            if any(sz[i] < sz[i + 1] for i in range(len(sz) - 1)): problems.append(f"not ordered by size: {sz}")
    if want.get("type") == "delete" and not want.get("skipped"):
        if not act.get("pending"): problems.append("delete not pending")
        files = sorted(os.path.basename(p) for p in act.get("files", []))
        if files != s["pendingFiles"]: problems.append(f"pending {len(files)} files, want {len(s['pendingFiles'])}")
        for p in act.get("files", [])[:3]:
            if not exists(f"{root}/{p}"): problems.append(f"{p} was deleted!")
    if problems: failed.append((s, a.get("answer", ""), problems))
    else: passed += 1
    # clean up whatever the agent created so the next scenario starts clean
    for f in created:
        adb("shell", "rm", "-rf", q(f"{root}/{f}"))
    created = []
    if want.get("type") == "move" and not problems:
        # restore the originals for the next move scenario
        push_corpus(); start_drive(index=False)

print(f"\n{passed}/{len(scen)} task scenarios passed")
for s, ans, problems in failed:
    print(f"\nFAIL {s['id']}  {s['q']}\n   answer: {str(ans)[:160]}")
    for p in problems: print(f"   - {p}")
json.dump({"passed": passed, "failed": [{"id": s["id"], "q": s["q"], "answer": ans, "problems": p} for s, ans, p in failed]},
          open(os.path.join(DIR, "task-report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
sys.exit(0 if not failed else 1)

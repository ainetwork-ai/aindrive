#!/usr/bin/env python3
"""End-to-end: push the generated corpus to the phone, rebuild the index and
ask the on-device agent every scenario over adb. Debug build required (the
MainActivity adb hooks); the app must already be paired with one folder.

    python3 scripts/make-test-corpus.py <dir>
    python3 scripts/run-device-scenarios.py <dir> [--skip-push]

The corpus lands in "<shared folder>/test-corpus". Results outside that
sub-folder are ignored when comparing, so the user's own files don't break
expectations; the expected set must match exactly otherwise.
"""
import html
import json
import os
import re
import subprocess
import sys
import time

DIR = sys.argv[1] if len(sys.argv) > 1 else "test-corpus"
SKIP_PUSH = "--skip-push" in sys.argv
PKG = "ai.ainetwork.aindrive"
# --sub NAME: sub-folder of the shared folder to push into (default test-corpus)
SUB = sys.argv[sys.argv.index("--sub") + 1] if "--sub" in sys.argv else "test-corpus"
# --wipe-others: also delete the other known corpus sub-folder so expectations aren't polluted
WIPE = [x for x in ("test-corpus", "real-corpus") if x != SUB] if "--wipe-others" in sys.argv else []

def adb(*a, **k):
    return subprocess.run(["adb", *a], capture_output=True, text=True, **k)

def state():
    xml = adb("shell", "run-as", PKG, "cat", "shared_prefs/CapacitorStorage.xml").stdout
    m = re.search(r'name="aindrive.mobile.state.v2">(.*?)</string>', xml, re.S)
    if not m: sys.exit("app state not found — is the debug app installed and paired?")
    return json.loads(html.unescape(m.group(1)))

def hook(action, **extras):
    cmd = ["shell", "am", "start", "-n", f"{PKG}/.MainActivity", "--es", "agentAction", action]
    for k, v in extras.items():
        if isinstance(v, bool): cmd += ["--ez", k, "true" if v else "false"]
        else: cmd += ["--es", k, "'" + str(v).replace("'", "'\\''") + "'"]
    return adb(*cmd)

st = state()
share = st["shares"][0]
uri = share["folder"]["uri"]
# content://com.android.externalstorage.documents/tree/primary%3AFolder → /sdcard/Folder
doc = uri.split("/tree/")[1]
from urllib.parse import unquote
vol, _, rel = unquote(doc).partition(":")
root = ("/sdcard/" if vol == "primary" else f"/storage/{vol}/") + rel
target = f"{root}/{SUB}"
scen = json.load(open(os.path.join(DIR, "device-scenarios.json"), encoding="utf-8"))

if not SKIP_PUSH:
    print(f"pushing {len(scen['files'])} files → {target}")
    adb("shell", "rm", "-rf", f"'{target}'")
    for w in WIPE: adb("shell", "rm", "-rf", f"'{root}/{w}'")
    r = adb("push", os.path.join(DIR, "corpus"), f"{target}")
    if r.returncode: sys.exit(r.stderr)

# rebuild the index from scratch
adb("shell", "am", "force-stop", PKG)
for f in adb("shell", "run-as", PKG, "ls", "files/index").stdout.split():
    adb("shell", "run-as", PKG, "rm", "-f", f"files/index/{f}")
adb("logcat", "-G", "8M"); adb("logcat", "-c")
d = share["drive"]
hook("ai.ainetwork.aindrive.START", serverUrl=st["server"], driveId=d["driveId"], agentToken=d["agentToken"],
     driveSecret=d["driveSecret"], folderUri=uri, folderLabel=share["folder"]["label"], indexOnStart=True)
# Wait for the metadata pass, then — if recognition models are on the phone —
# for the recognition pass too (it logs "recognised N files" when it ends).
has_models = "vision_model" in adb("shell", "run-as", PKG, "ls", "files/models/clip").stdout
m = done = None
for _ in range(1800):
    time.sleep(1)
    log = adb("logcat", "-d", "-s", "AindriveIndexer").stdout
    m = m or re.search(r"indexed (\d+) files \((\d+) failed", log)
    done = re.search(r"recognised (\d+) files", log)
    if m and (done or not has_models): break
else:
    sys.exit("indexing did not finish")
print(f"indexed {m.group(1)} files ({m.group(2)} failed); " + (f"recognition: {done.group(0)}" if done else "no recognition models on the phone"))

# Ask in batches and harvest logcat after each: answers carry up to 50 sources
# with snippets, and a hundred of them overflow the ring buffer.
answers = {}
def harvest():
    log = adb("logcat", "-d", "-s", "AindriveAgent").stdout
    log = re.sub(r"^.*?AindriveAgent: ", "", log, flags=re.M)
    for part in re.split(r"(?=ask\()", log):
        m = re.match(r"ask\((.*?)\) → (\{.*)", part, re.S)
        if not m: continue
        try: answers[m.group(1)] = json.loads(m.group(2).strip())
        except json.JSONDecodeError: continue
    adb("logcat", "-c")
adb("logcat", "-c")
for i, s in enumerate(scen["scenarios"]):
    hook("ai.ainetwork.aindrive.ASK", query=s["q"])
    time.sleep(1.3)
    if (i + 1) % 8 == 0: time.sleep(1.5); harvest()
time.sleep(3); harvest()

passed, failed = 0, []
for s in scen["scenarios"]:
    a = answers.get(s["q"])
    if a is None:
        failed.append((s, "no answer logged", None)); continue
    got = sorted(os.path.basename(x["path"]) for x in a["sources"] if x["path"].startswith(SUB + "/"))
    if "answerContains" in s:
        ok = s["answerContains"] in a["answer"]
        s["expect"] = f"answer contains “{s['answerContains']}”"
    elif "expect" in s:
        ok = got == s["expect"]
    else:
        must, must_not = set(s["mustInclude"]), set(s["mustExclude"])
        recall = 1.0 if not must else len(must & set(got)) / len(must)
        ok = recall >= s.get("minRecall", 1.0) and not (must_not & set(got))
        s["expect"] = f"≥{int(100 * s.get('minRecall', 1))}% of {sorted(must)} and none of {len(must_not)} excluded"
    if ok: passed += 1
    else: failed.append((s, a["answer"], got))

print(f"\n{passed}/{len(scen['scenarios'])} scenarios passed")
for s, ans, got in failed:
    print(f"\nFAIL {s['id']}  {s['q']}\n   answer: {ans}")
    if got is not None and isinstance(s["expect"], list):
        missing = sorted(set(s["expect"]) - set(got)); extra = sorted(set(got) - set(s["expect"]))
        if missing: print(f"   missing: {missing[:8]}{' …' if len(missing) > 8 else ''}")
        if extra: print(f"   extra:   {extra[:8]}{' …' if len(extra) > 8 else ''}")
    elif got is not None:
        print(f"   want:    {s['expect']}\n   got:     {got[:10]}{' …' if len(got) > 10 else ''}")
json.dump({"passed": passed, "failed": [{"id": s["id"], "q": s["q"], "answer": ans, "got": got, "expect": s["expect"]} for s, ans, got in failed]},
          open(os.path.join(DIR, "device-report.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
sys.exit(0 if not failed else 1)

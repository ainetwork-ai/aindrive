#!/usr/bin/env python3
"""Run the call-history report on the phone (debug build, adb).

    adb shell pm grant ai.ainetwork.aindrive android.permission.READ_CALL_LOG
    python3 scripts/run-call-report.py [question]

Stages the newest 3 recordings of 6 people from /sdcard/Call into the
"SharedPhotos" share as CallSrc, starts that share as the output drive and
CallSrc as the `src-calls` agent source, asks the question and prints the
answer, the action and the markdown it wrote. Transcription happens on the
phone (first 3 minutes of each recording), so the first run takes minutes;
later runs reuse the transcripts in the index.
"""
import html, json, re, subprocess, sys, time
PKG="ai.ainetwork.aindrive"
def adb(*a): return subprocess.run(["adb", *a], capture_output=True, text=True)
def hook(action, **extras):
    cmd=["shell","am","start","-n",f"{PKG}/.MainActivity","--es","agentAction",action]
    for k,v in extras.items():
        if isinstance(v,bool): cmd+=["--ez",k,"true" if v else "false"]
        else: cmd+=["--es",k,"'"+str(v).replace("'","'\\''")+"'"]
    return adb(*cmd)
adb("shell", 'mkdir -p /sdcard/SharedPhotos/CallSrc; for n in 지구 신수철 "#이지애" 장래영 김정현 전보배; do ls /sdcard/Call | grep -F "녹음 ${n}_" | sort -t_ -k2,3 | tail -3 | while read f; do cp -n "/sdcard/Call/$f" /sdcard/SharedPhotos/CallSrc/; done; done')
xml=adb("shell","run-as",PKG,"cat","shared_prefs/CapacitorStorage.xml").stdout
st=json.loads(html.unescape(re.search(r'name="aindrive.mobile.state.v2">(.*?)</string>',xml,re.S).group(1)))
share=[s for s in st["shares"] if s["folder"]["label"]=="SharedPhotos"][0]; d=share["drive"]
adb("shell","am","force-stop",PKG); adb("logcat","-c")
hook("ai.ainetwork.aindrive.START", serverUrl=st["server"], driveId=d["driveId"], agentToken=d["agentToken"], driveSecret=d["driveSecret"],
     folderUri=share["folder"]["uri"], folderLabel="SharedPhotos", indexOnStart=False)
time.sleep(2)
src="content://com.android.externalstorage.documents/tree/primary%3ASharedPhotos/document/primary%3ASharedPhotos%2FCallSrc"
hook("ai.ainetwork.aindrive.START", driveId="src-calls", folderUri=src, folderLabel="CallSrc", indexOnStart=True, source=True, serverUrl="", agentToken="", driveSecret="")
for _ in range(120):
    time.sleep(1)
    if re.search(r"indexed \d+ files", adb("logcat","-d","-s","AindriveIndexer").stdout): break
print(adb("logcat","-d","-s","AindriveIndexer").stdout.strip().split("\n")[-1][-120:])
q=sys.argv[1] if len(sys.argv)>1 else "Sort my call history by who I talk to most and summarize what we usually talk about, and share it"
adb("logcat","-c"); hook("ai.ainetwork.aindrive.ASK", query=q); t0=time.time()
while time.time()-t0<900:
    time.sleep(2)
    log=re.sub(r"^.*?AindriveAgent: ","",adb("logcat","-d","-s","AindriveAgent").stdout,flags=re.M)
    m=re.search(r"ask\((.*?)\) → (\{.*)",log,re.S)
    if m:
        try: r=json.loads(m.group(2).strip()); break
        except json.JSONDecodeError: continue
else: sys.exit("no answer")
print(f"{time.time()-t0:.0f}s"); print(r["answer"]); a=r.get("action",{}); print({k:v for k,v in a.items() if k not in("people","files")})
print(adb("shell",f"ls -la '/sdcard/SharedPhotos/{a.get('folder','')}'").stdout)
print(adb("shell",f"cat '/sdcard/SharedPhotos/{a.get('folder','')}'/*.md").stdout[:2500])

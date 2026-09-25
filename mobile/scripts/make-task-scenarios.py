#!/usr/bin/env python3
"""100 agent TASK scenarios over the real corpus (make-real-corpus.py):
collect, collect+share, move, count, top-N, delete (confirmation pending),
and tasks that must refuse. Each scenario states what the agent must DO —
the `action` object on its answer — and, for collect/move, which files must
land in the new folder (checked on the phone by run-device-scenarios.py).

    python3 scripts/make-task-scenarios.py <corpus-dir>   # writes <corpus-dir>/task-scenarios.json

Tasks that create folders are cleaned up by the runner after each scenario;
moves are grouped last and the corpus is re-pushed afterwards.
"""
import json
import os
import sys
from datetime import datetime

DIR = sys.argv[1]
files = json.load(open(os.path.join(DIR, "real-files.json"), encoding="utf-8"))["files"]
NOW = datetime.now()
YM = NOW.strftime("%Y-%m")

def names(*topics): return sorted(f["name"] for f in files if f["topic"] in topics)
def photos_in(city): return sorted(f["name"] for f in files if f["city"] == city)
def photos_country(cc): return sorted(f["name"] for f in files if f["country"] == cc)
def kind(k): return sorted(f["name"] for f in files if f["kind"] == k)
ALL_PHOTOS = kind("photo")
AUDIO = kind("audio")

S = []
def add(q, action, **extra):
    S.append({"id": f"T{len(S)+1:03d}", "q": q, "action": action, **extra})

# ---- A. collect (copy into a new folder): exact filters — folder must hold exactly these files
def collect(q, folder, expect, share=False, kind_="collect"):
    add(q, {"type": kind_, "folder": folder, "share": share}, folderFiles=sorted(expect))

collect("collect the photos I took in Paris into a folder", "Paris photos", photos_in("Paris"))
collect("organize my Nice photos into a folder", "Nice photos", photos_in("Nice"))
collect("gather my Tokyo photos", "Tokyo photos", photos_in("Tokyo"))
collect("make an album of the Osaka photos", "Osaka photos", photos_in("Osaka"))
collect("collect Seoul photos and make a folder", "Seoul photos", photos_in("Seoul"))
collect("put the Busan photos in a folder", "Busan photos", photos_in("Busan"))
collect("collect my Jeju photos", "Jeju City photos", photos_in("Jeju City"))
collect("New York photos into a folder", "New York City photos", photos_in("New York City"))
collect("gather the London photos", "London photos", photos_in("London"))
collect("make a Bangkok photo album", "Bangkok photos", photos_in("Bangkok"))
collect("collect all the France photos into a folder", "France photos", photos_country("FR"))
collect("collect my Japan photos", "Japan photos", photos_country("JP"))
collect("organize the Korea photos into a folder", "South Korea photos", photos_country("KR"))
collect("collect my Paris photos into a folder", "Paris photos", photos_in("Paris"))
collect("gather the photos from Tokyo into an album", "Tokyo photos", photos_in("Tokyo"))
collect("put all the Korea photos in a folder", "South Korea photos", photos_country("KR"))
collect("collect the recordings and make a folder", "recordings", AUDIO)
collect("recordings into a folder", "recordings", AUDIO)
collect(f"collect this month's France photos", f"France photos {YM}", photos_country("FR"))
collect(f"London photos taken this month into a folder", f"London photos {YM}", photos_in("London"))

# ---- B. collect by what the photo shows (recognition): folder must contain the subject's photos (≥ half) and none of the excluded
def collect_fuzzy(q, folder, must, must_not, min_recall=0.5, share=False, kind_="collect"):
    add(q, {"type": kind_, "folder": folder, "share": share}, folderMustInclude=sorted(must), folderMustExclude=sorted(must_not), minRecall=min_recall)
collect_fuzzy("collect the puppy photos into a folder", "puppy photos", names("dog"), names("pizza", "car", "receipt"))
collect_fuzzy("gather my cat photos", "cat photos", names("cat"), names("pizza", "car", "beach"))
collect_fuzzy("organize the pizza photos into a folder", "pizza photos", names("pizza"), names("dog", "car", "beach"))
collect_fuzzy("make an album of the ramen photos", "ramen photos", names("ramen"), names("dog", "car", "beach"))
collect_fuzzy("collect the beach photos", "beach photos", names("beach"), names("dog", "pizza", "receipt"))
collect_fuzzy("make a folder of sunset photos", "sunset photos", names("sunset"), names("dog", "pizza", "receipt"))
collect_fuzzy("cherry blossom photos into a folder", "cherry blossom photos", names("flowers"), names("dog", "pizza", "car"))
collect_fuzzy("collect my receipt photos", "receipt photos", names("receipt"), names("dog", "beach", "sunset"))
collect_fuzzy("collect the sports car photos into a folder", "sports car photos", names("car"), names("dog", "pizza", "receipt"))
collect_fuzzy("organize the cake photos into a folder", "cake photos", names("cake"), names("dog", "car", "receipt"))
collect_fuzzy("gather the coffee photos", "coffee photos", names("coffee"), names("dog", "car", "beach"))
collect_fuzzy("make a wedding photo album", "wedding photos", names("wedding"), names("pizza", "car", "receipt"))
collect_fuzzy("baby photos into a folder", "baby photos", names("baby"), names("pizza", "car", "receipt"))
collect_fuzzy("collect the concert photos", "concert photos", names("concert"), names("pizza", "receipt", "cat"))
collect_fuzzy("put all the dog pictures in one folder", "dog pictures", names("dog"), names("pizza", "car", "receipt"))
collect_fuzzy(f"collect only the food photos from this month into a folder", f"food photos {YM}", names("pizza", "ramen"), names("dog", "car", "receipt", "beach"), 0.5)

# ---- C. collect + share
collect("collect the Paris photos into a folder and share it", "Paris photos", photos_in("Paris"), share=True)
collect("gather the Tokyo photos and make a share link", "Tokyo photos", photos_in("Tokyo"), share=True)
collect("make a folder of the Japan photos and share it", "Japan photos", photos_country("JP"), share=True)
collect("collect the recordings and share them", "recordings", AUDIO, share=True)
collect("share my London photos as a folder", "London photos", photos_in("London"), share=True)
collect("collect Korea photos into a folder and share it", "South Korea photos", photos_country("KR"), share=True)
collect_fuzzy("collect the puppy photos and share them", "puppy photos", names("dog"), names("pizza", "car"), share=True)
collect_fuzzy("make a pizza photo folder and share it", "pizza photos", names("pizza"), names("dog", "car"), share=True)
collect_fuzzy(f"collect only the food photos I ate this month into a folder and share it", f"food photos {YM}", names("pizza", "ramen"), names("dog", "car", "receipt"), 0.5, share=True)
collect_fuzzy("collect the cherry blossom photos and share them as a link", "cherry blossom photos", names("flowers"), names("dog", "pizza"), share=True)

collect("collect the Busan photos and share them", "Busan photos", photos_in("Busan"), share=True)
collect("collect this month's Tokyo photos", f"Tokyo photos {YM}", photos_in("Tokyo"))
collect_fuzzy("make a coffee photo folder and share", "coffee photos", names("coffee"), names("dog", "car"), share=True)
collect_fuzzy("collect the sunset photos and share them", "sunset photos", names("sunset"), names("dog", "pizza"), share=True)

# ---- D. count: the number in `action.count` must match (exact filters only)
def count(q, n): add(q, {"type": "count", "count": n})
count("how many Paris photos are there?", len(photos_in("Paris")))
count("how many Tokyo photos", len(photos_in("Tokyo")))
count("tell me the number of France photos", len(photos_country("FR")))
count("how many photos from Japan", len(photos_country("JP")))
count("how many photos did I take in Korea", len(photos_country("KR")))
count("how many recording files are there", len(AUDIO))
count("how many videos are there?", len(kind("video")))
count("how many photos do I have", 50)   # capped at LIMIT in the list, but the count is the real total → see runner (countAtLeast)
count("how many photos from Paris", len(photos_in("Paris")))
count("how many recordings do I have", len(AUDIO))
count("how many photos from Korea", len(photos_country("KR")))
count("how many videos", len(kind("video")))
count("count the Nice photos", len(photos_in("Nice")))
count("how many Bangkok photos are there", len(photos_in("Bangkok")))
count("number of London photos", len(photos_in("London")))
count("how many Osaka photos", len(photos_in("Osaka")))
count("how many photos from France", len(photos_country("FR")))
# "how many photos do I have": the drive holds the corpus plus whatever else the user has → at least the corpus's photos.
for sc in S:
    if sc["q"] == "how many photos do I have": sc["countAtLeast"] = len(ALL_PHOTOS); del sc["action"]["count"]

# ---- E. top-N / ordering: the list must have exactly N rows, and the ordering rule must hold
def topn(q, n, order): add(q, {"type": None}, listLength=n, order=order)
topn("show me just the 3 most recent photos", 3, "newest")
topn("recent 5 photos", 5, "newest")
topn("the 5 biggest files", 5, "size")
topn("largest 3 photos", 3, "size")
topn("the 2 oldest photos", 2, "oldest")
topn("just 2 recordings", 2, "newest")
topn("latest 4 photos", 4, "newest")
topn("5 largest files", 5, "size")
topn("3 biggest photos", 3, "size")
topn("oldest 3 photos", 3, "oldest")
topn("recent 3 recordings", 3, "newest")
topn("earliest 2 recordings", 2, "oldest")

# ---- F. delete: never executed — must come back pending with the right file list, files still present
def delete(q, expect): add(q, {"type": "delete", "pending": True}, pendingFiles=sorted(expect))
delete("delete my Paris photos", photos_in("Paris"))
delete("remove the Nice photos", photos_in("Nice"))
delete("delete all the recording files", AUDIO)
delete("trash the videos", kind("video"))
delete("delete the Tokyo photos", photos_in("Tokyo"))
delete("remove my London photos", photos_in("London"))
delete("get rid of the Bangkok photos", photos_in("Bangkok"))
delete("delete Osaka photos", photos_in("Osaka"))
delete("delete recordings", AUDIO)
delete("remove my Jeju photos", photos_in("Jeju City"))

# ---- G. must refuse (nothing matched → no folder, no deletion)
def refuse(q, t): add(q, {"type": t, "skipped": True})
refuse("collect the Moscow photos into a folder", "collect")
refuse("collect the photos from 2019", "collect")
refuse("delete the Berlin photos", "delete")
refuse("collect my Madrid photos into a folder", "collect")
refuse("screenshots into a folder", "collect")   # the real corpus has no screenshots
refuse("delete the recordings from 2020", "delete")

# ---- H. move (last: changes the corpus; the runner re-pushes afterwards)
collect("move the Nice photos into a folder", "Nice photos", photos_in("Nice"), kind_="move")
collect("move the Osaka photos and make a folder", "Osaka photos", photos_in("Osaka"), kind_="move")
collect("move Bangkok photos to a folder", "Bangkok photos", photos_in("Bangkok"), kind_="move")
collect("move the London photos into a folder", "London photos", photos_in("London"), kind_="move")
collect("move the recordings into a folder", "recordings", AUDIO, kind_="move")

assert len(S) == 100, len(S)
json.dump({"generatedAt": NOW.isoformat(), "scenarios": S}, open(os.path.join(DIR, "task-scenarios.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(S)} task scenarios → {os.path.join(DIR, 'task-scenarios.json')}")

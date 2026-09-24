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

collect("파리에서 찍은 사진 모아서 폴더로 만들어줘", f"파리 사진", photos_in("Paris"))
collect("니스 사진 폴더로 정리해줘", "니스 사진", photos_in("Nice"))
collect("도쿄 사진 모아줘", "도쿄 사진", photos_in("Tokyo"))
collect("오사카 사진을 앨범으로 만들어", "오사카 사진", photos_in("Osaka"))
collect("서울 사진 모아서 폴더 만들어", "서울특별시 사진", photos_in("Seoul"))
collect("부산 사진 폴더에 넣어줘", "부산광역시 사진", photos_in("Busan"))
collect("제주 사진 모아줘", "제주시 사진", photos_in("Jeju City"))
collect("뉴욕 사진 모아서 폴더로", "뉴욕 시 사진", photos_in("New York City"))
collect("런던 사진 모아줘", "런던 사진", photos_in("London"))
collect("방콕 사진 앨범 만들어줘", "방콕 사진", photos_in("Bangkok"))
collect("프랑스 사진 전부 모아서 폴더 만들어", "프랑스 사진", photos_country("FR"))
collect("일본 사진 모아줘", "일본 사진", photos_country("JP"))
collect("한국 사진 폴더로 정리", "대한민국 사진", photos_country("KR"))
collect("collect my Paris photos into a folder", "Paris photos", photos_in("Paris"))
collect("gather the photos from Tokyo into an album", "Tokyo photos", photos_in("Tokyo"))
collect("put all the Korea photos in a folder", "South Korea photos", photos_country("KR"))
collect("녹음 파일 모아서 폴더 만들어", "녹음", AUDIO)
collect("recordings into a folder", "recordings", AUDIO)
collect(f"이번달 프랑스 사진 모아줘", f"프랑스 사진 {YM}", photos_country("FR"))
collect(f"이번달에 찍은 런던 사진 모아서 폴더로", f"런던 사진 {YM}", photos_in("London"))

# ---- B. collect by what the photo shows (recognition): folder must contain the subject's photos (≥ half) and none of the excluded
def collect_fuzzy(q, folder, must, must_not, min_recall=0.5, share=False, kind_="collect"):
    add(q, {"type": kind_, "folder": folder, "share": share}, folderMustInclude=sorted(must), folderMustExclude=sorted(must_not), minRecall=min_recall)
collect_fuzzy("강아지 사진 모아서 폴더 만들어줘", "강아지 사진", names("dog"), names("pizza", "car", "receipt"))
collect_fuzzy("고양이 사진 모아줘", "고양이 사진", names("cat"), names("pizza", "car", "beach"))
collect_fuzzy("피자 사진 폴더로 정리해", "피자 사진", names("pizza"), names("dog", "car", "beach"))
collect_fuzzy("라면 사진 모아서 앨범 만들어", "라면 사진", names("ramen"), names("dog", "car", "beach"))
collect_fuzzy("바다 사진 모아줘", "바다 사진", names("beach"), names("dog", "pizza", "receipt"))
collect_fuzzy("노을 사진 폴더 만들어", "노을 사진", names("sunset"), names("dog", "pizza", "receipt"))
collect_fuzzy("벚꽃 사진 모아서 폴더로", "벚꽃 사진", names("flowers"), names("dog", "pizza", "car"))
collect_fuzzy("영수증 사진 모아줘", "영수증 사진", names("receipt"), names("dog", "beach", "sunset"))
collect_fuzzy("스포츠카 사진 모아서 폴더 만들어", "스포츠카 사진", names("car"), names("dog", "pizza", "receipt"))
collect_fuzzy("케이크 사진 폴더로 정리", "케이크 사진", names("cake"), names("dog", "car", "receipt"))
collect_fuzzy("커피 사진 모아줘", "커피 사진", names("coffee"), names("dog", "car", "beach"))
collect_fuzzy("결혼식 사진 앨범 만들어줘", "결혼식 사진", names("wedding"), names("pizza", "car", "receipt"))
collect_fuzzy("아기 사진 모아서 폴더로", "아기 사진", names("baby"), names("pizza", "car", "receipt"))
collect_fuzzy("콘서트 사진 모아줘", "콘서트 사진", names("concert"), names("pizza", "receipt", "cat"))
collect_fuzzy("collect the dog photos into a folder", "dog photos", names("dog"), names("pizza", "car", "receipt"))
collect_fuzzy(f"이번달에 먹은 음식사진만 모아서 폴더로 만들어줘", f"음식 사진 {YM}", names("pizza", "ramen"), names("dog", "car", "receipt", "beach"), 0.5)

# ---- C. collect + share
collect("파리 사진 모아서 폴더 만들고 공유해줘", "파리 사진", photos_in("Paris"), share=True)
collect("도쿄 사진 모아서 공유 링크 만들어줘", "도쿄 사진", photos_in("Tokyo"), share=True)
collect("일본 사진 폴더로 만들어서 공유해", "일본 사진", photos_country("JP"), share=True)
collect("녹음 파일 모아서 공유해줘", "녹음", AUDIO, share=True)
collect("share my London photos as a folder", "London photos", photos_in("London"), share=True)
collect("collect Korea photos into a folder and share it", "South Korea photos", photos_country("KR"), share=True)
collect_fuzzy("강아지 사진 모아서 공유해줘", "강아지 사진", names("dog"), names("pizza", "car"), share=True)
collect_fuzzy("피자 사진 폴더로 만들어서 공유", "피자 사진", names("pizza"), names("dog", "car"), share=True)
collect_fuzzy(f"이번달에 먹은 음식사진만 모아서 폴더로 만들어서 공유해줘", f"음식 사진 {YM}", names("pizza", "ramen"), names("dog", "car", "receipt"), 0.5, share=True)
collect_fuzzy("벚꽃 사진 모아서 링크로 공유해줘", "벚꽃 사진", names("flowers"), names("dog", "pizza"), share=True)

collect("부산 사진 모아서 공유해줘", "부산광역시 사진", photos_in("Busan"), share=True)
collect("이번달 도쿄 사진 모아줘", f"도쿄 사진 {YM}", photos_in("Tokyo"))
collect_fuzzy("커피 사진 폴더로 만들고 공유", "커피 사진", names("coffee"), names("dog", "car"), share=True)
collect_fuzzy("노을 사진 모아서 공유해줘", "노을 사진", names("sunset"), names("dog", "pizza"), share=True)

# ---- D. count: the number in `action.count` must match (exact filters only)
def count(q, n): add(q, {"type": "count", "count": n})
count("파리 사진 몇 장 있어?", len(photos_in("Paris")))
count("도쿄 사진 몇 개야", len(photos_in("Tokyo")))
count("프랑스 사진 개수 알려줘", len(photos_country("FR")))
count("일본 사진 몇 장", len(photos_country("JP")))
count("한국에서 찍은 사진 몇 개 있어", len(photos_country("KR")))
count("녹음 파일 몇 개야", len(AUDIO))
count("영상 몇 개 있어?", len(kind("video")))
count("사진 몇 장 있어", 50)   # capped at LIMIT in the list, but the count is the real total → see runner (countAtLeast)
count("how many photos from Paris", len(photos_in("Paris")))
count("how many recordings do I have", len(AUDIO))
count("how many photos from Korea", len(photos_country("KR")))
count("how many videos", len(kind("video")))
count("니스 사진 몇 장", len(photos_in("Nice")))
count("방콕 사진 몇 장 있어", len(photos_in("Bangkok")))
count("런던 사진 개수", len(photos_in("London")))
count("오사카 사진 몇 장", len(photos_in("Osaka")))
count("how many photos from France", len(photos_country("FR")))
# "사진 몇 장 있어": the drive holds the corpus plus whatever else the user has → at least the corpus's photos.
for sc in S:
    if sc["q"] == "사진 몇 장 있어": sc["countAtLeast"] = len(ALL_PHOTOS); del sc["action"]["count"]

# ---- E. top-N / ordering: the list must have exactly N rows, and the ordering rule must hold
def topn(q, n, order): add(q, {"type": None}, listLength=n, order=order)
topn("가장 최근 사진 3장만 보여줘", 3, "newest")
topn("최근 사진 5개", 5, "newest")
topn("가장 큰 파일 5개", 5, "size")
topn("가장 큰 사진 3장", 3, "size")
topn("가장 오래된 사진 2장", 2, "oldest")
topn("녹음 파일 2개만", 2, "newest")
topn("latest 4 photos", 4, "newest")
topn("5 largest files", 5, "size")
topn("3 biggest photos", 3, "size")
topn("oldest 3 photos", 3, "oldest")
topn("최근 녹음 3개", 3, "newest")
topn("가장 오래된 녹음 2개", 2, "oldest")

# ---- F. delete: never executed — must come back pending with the right file list, files still present
def delete(q, expect): add(q, {"type": "delete", "pending": True}, pendingFiles=sorted(expect))
delete("파리 사진 삭제해줘", photos_in("Paris"))
delete("니스 사진 지워줘", photos_in("Nice"))
delete("녹음 파일 전부 삭제", AUDIO)
delete("영상 지워", kind("video"))
delete("delete the Tokyo photos", photos_in("Tokyo"))
delete("remove my London photos", photos_in("London"))
delete("방콕 사진 없애줘", photos_in("Bangkok"))
delete("오사카 사진 삭제", photos_in("Osaka"))
delete("delete recordings", AUDIO)
delete("제주 사진 지워줘", photos_in("Jeju City"))

# ---- G. must refuse (nothing matched → no folder, no deletion)
def refuse(q, t): add(q, {"type": t, "skipped": True})
refuse("모스크바 사진 모아서 폴더 만들어줘", "collect")
refuse("2019년 사진 모아줘", "collect")
refuse("베를린 사진 삭제해줘", "delete")
refuse("collect my Madrid photos into a folder", "collect")
refuse("스크린샷 모아서 폴더로", "collect")   # the real corpus has no screenshots
refuse("2020년 녹음 삭제해줘", "delete")

# ---- H. move (last: changes the corpus; the runner re-pushes afterwards)
collect("니스 사진 폴더로 옮겨줘", "니스 사진", photos_in("Nice"), kind_="move")
collect("오사카 사진 옮겨서 폴더 만들어", "오사카 사진", photos_in("Osaka"), kind_="move")
collect("방콕 사진 이동해서 폴더로", "방콕 사진", photos_in("Bangkok"), kind_="move")
collect("move the London photos into a folder", "London photos", photos_in("London"), kind_="move")
collect("녹음 파일 폴더로 옮겨", "녹음", AUDIO, kind_="move")

assert len(S) == 100, len(S)
json.dump({"generatedAt": NOW.isoformat(), "scenarios": S}, open(os.path.join(DIR, "task-scenarios.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(S)} task scenarios → {os.path.join(DIR, 'task-scenarios.json')}")

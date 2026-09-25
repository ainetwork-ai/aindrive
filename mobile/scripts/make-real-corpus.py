#!/usr/bin/env python3
"""Build the REAL test corpus: real photographs (Wikimedia Commons, free
licences) and real speech recordings (a Wikimedia meeting, an interview,
Zeroth-Korean read speech), plus the scenarios that exercise recognition.

    python3 scripts/make-real-corpus.py <photos-dir> <audio-dir> <out-dir>

<photos-dir>  jpgs named <topic>_<n>.jpg (from the Commons fetch), with
              ATTRIBUTION.json next to them
<audio-dir>   m4a/mp3/mp4 recordings with known content

Unlike make-test-corpus.py nothing here is synthetic: GPS is written only for
photos whose subject is a known place (an Eiffel Tower photo *was* taken in
Paris) and never for a beach or a dog; the EXIF date is left to the file's
own mtime. Scenarios for recognition therefore say what MUST be found and
what must NOT, instead of demanding an exact set — a model is not a filter.
"""
import json
import os
import shutil
import struct
import sys
import io
from datetime import datetime

from PIL import Image

PHOTOS, AUDIO, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
CORPUS = os.path.join(OUT, "corpus")

# subject → (city, ISO, lat, lon) when the subject IS a place
PLACE = {
    "paris": ("Paris", "FR", 48.8584, 2.2945), "paris_louvre": ("Paris", "FR", 48.8606, 2.3376), "paris_seine": ("Paris", "FR", 48.8566, 2.3522),
    "nice": ("Nice", "FR", 43.6950, 7.2650), "busan": ("Busan", "KR", 35.1587, 129.1604), "newyork": ("New York City", "US", 40.7128, -74.0060),
    "london": ("London", "GB", 51.5007, -0.1246), "bangkok": ("Bangkok", "TH", 13.7437, 100.4888), "osaka": ("Osaka", "JP", 34.6687, 135.5013),
    "seoul": ("Seoul", "KR", 37.5326, 126.9903), "tokyo": ("Tokyo", "JP", 35.6595, 139.7004), "jeju": ("Jeju City", "KR", 33.4996, 126.5312),
}

def _rational(v):
    v = abs(v); d = int(v); m = int((v - d) * 60); s = ((v - d) * 60 - m) * 60
    return [(d, 1), (m, 1), (int(round(s * 100)), 100)]

def _ifd(entries, base):
    n = len(entries); ifd_len = 2 + 12 * n + 4
    data = b""; out = struct.pack(">H", n)
    for tag, typ, val, cnt in sorted(entries):
        if len(val) <= 4: out += struct.pack(">HHI", tag, typ, cnt) + val.ljust(4, b"\0")
        else:
            out += struct.pack(">HHII", tag, typ, cnt, base + ifd_len + len(data))
            data += val + (b"\0" if len(val) % 2 else b"")
    return out + b"\0\0\0\0", data

def gps_exif(lat, lon):
    ifd0_off = 8
    gps_off = ifd0_off + (2 + 12 + 4)
    ifd0, d0 = _ifd([(0x8825, 4, struct.pack(">I", gps_off), 1)], ifd0_off)
    rat = lambda rs: b"".join(struct.pack(">II", a, b) for a, b in rs)
    gps, d2 = _ifd([(0x0001, 2, (b"N" if lat >= 0 else b"S") + b"\0", 2), (0x0002, 5, rat(_rational(lat)), 3),
                    (0x0003, 2, (b"E" if lon >= 0 else b"W") + b"\0", 2), (0x0004, 5, rat(_rational(lon)), 3)], gps_off)
    return b"Exif\0\0" + b"MM\0\x2a" + struct.pack(">I", ifd0_off) + ifd0 + d0 + gps + d2

if os.path.exists(CORPUS): shutil.rmtree(CORPUS)
files = []   # {name, path, topic, kind, city, country}

attrib = json.load(open(os.path.join(PHOTOS, "ATTRIBUTION.json"), encoding="utf-8"))
for fn in sorted(os.listdir(PHOTOS)):
    if not fn.endswith(".jpg"): continue
    topic = fn.rsplit("_", 1)[0]
    im = Image.open(os.path.join(PHOTOS, fn)).convert("RGB")
    # keep photos phone-sized; re-encode drops the original (mostly stripped) EXIF
    im.thumbnail((1600, 1600))
    place = PLACE.get(topic)
    sub = "Photos/" + (place[0] if place else "Things")
    rel = f"{sub}/{fn}"
    os.makedirs(os.path.join(CORPUS, sub), exist_ok=True)
    buf = io.BytesIO()
    if place: im.save(buf, "JPEG", quality=88, exif=gps_exif(place[2], place[3]))
    else: im.save(buf, "JPEG", quality=88)
    open(os.path.join(CORPUS, rel), "wb").write(buf.getvalue())
    files.append({"name": fn, "path": rel, "topic": topic, "kind": "photo", "city": place[0] if place else None, "country": place[1] if place else None,
                  "source": attrib.get(f"real2/{fn}", attrib.get(f"real/{fn}", {})).get("title", "")})

os.makedirs(os.path.join(CORPUS, "Recordings"), exist_ok=True)
for fn in sorted(os.listdir(AUDIO)):
    if not fn.split(".")[-1] in ("m4a", "mp3", "mp4", "ogg", "wav"): continue
    shutil.copy(os.path.join(AUDIO, fn), os.path.join(CORPUS, "Recordings", fn))
    files.append({"name": fn, "path": "Recordings/" + fn, "topic": "audio", "kind": "video" if fn.endswith(".mp4") else "audio", "city": None, "country": None})

json.dump({"generatedAt": datetime.now().isoformat(), "files": files}, open(os.path.join(OUT, "real-files.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
shutil.copy(os.path.join(PHOTOS, "ATTRIBUTION.json"), os.path.join(CORPUS, "Photos", "ATTRIBUTION.json"))

def names(*topics): return sorted(f["name"] for f in files if f["topic"] in topics)
def photos_in(city): return sorted(f["name"] for f in files if f["city"] == city)
def photos_country(cc): return sorted(f["name"] for f in files if f["country"] == cc)

S = []
def exact(q, expect): S.append({"id": f"R{len(S)+1:03d}", "q": q, "expect": sorted(expect)})
def fuzzy(q, must, must_not, min_recall=1.0): S.append({"id": f"R{len(S)+1:03d}", "q": q, "mustInclude": sorted(must), "mustExclude": sorted(must_not), "minRecall": min_recall})

# --- place (real GPS on real landmark photos): exact
exact("파리에서 찍은 사진 찾아줘", photos_in("Paris"))
exact("photos from Paris", photos_in("Paris"))
exact("프랑스 여행 사진", photos_country("FR"))
exact("니스 사진", photos_in("Nice"))
exact("부산 사진", photos_in("Busan"))
exact("서울에서 찍은 사진", photos_in("Seoul"))
exact("도쿄 사진", photos_in("Tokyo"))
exact("오사카 사진", photos_in("Osaka"))
exact("일본 사진", photos_country("JP"))
exact("한국 사진", photos_country("KR"))
exact("제주 사진", photos_in("Jeju City"))
exact("뉴욕 사진", photos_in("New York City"))
exact("런던 사진", photos_in("London"))
exact("방콕 사진", photos_in("Bangkok"))

# --- what the photo shows (CLIP): must find the subject's photos, must not surface clearly unrelated subjects
NOT = lambda *t: names(*t)
fuzzy("강아지 사진", names("dog"), NOT("pizza", "car", "receipt", "skyscraper", "whiteboard"), 0.75)
fuzzy("a photo of a dog", names("dog"), NOT("pizza", "car", "receipt", "skyscraper", "whiteboard"), 0.75)
fuzzy("고양이 사진", names("cat"), NOT("pizza", "car", "beach", "skyscraper", "receipt"), 0.5)
fuzzy("에펠탑 사진", names("paris"), NOT("dog", "cat", "pizza", "ramen", "cake", "receipt"), 0.75)
fuzzy("Eiffel Tower", names("paris"), NOT("dog", "cat", "pizza", "ramen", "cake", "receipt"), 0.75)
fuzzy("피자 사진", names("pizza"), NOT("dog", "cat", "car", "beach", "skyscraper"), 0.5)
fuzzy("라면 사진", names("ramen"), NOT("dog", "car", "beach", "skyscraper", "flowers"), 0.5)
fuzzy("바다 사진", names("beach"), NOT("dog", "pizza", "car", "receipt", "whiteboard"), 0.75)
fuzzy("노을 사진", names("sunset"), NOT("dog", "pizza", "receipt", "whiteboard", "cat"), 0.5)
fuzzy("눈 온 풍경 사진", names("snow"), NOT("pizza", "dog", "receipt", "car"), 0.5)
fuzzy("벚꽃 사진", names("flowers"), NOT("dog", "pizza", "car", "receipt", "skyscraper"), 0.75)
fuzzy("영수증 사진", names("receipt"), NOT("dog", "cat", "beach", "sunset", "mountain"), 0.5)
fuzzy("화이트보드 사진", names("whiteboard"), NOT("dog", "cat", "beach", "pizza", "sunset"), 0.5)
fuzzy("빨간 스포츠카 사진", names("car"), NOT("dog", "cat", "pizza", "beach", "receipt"), 0.75)
fuzzy("자전거 사진", names("bicycle"), NOT("pizza", "cat", "receipt", "cake", "ramen"), 0.5)
fuzzy("생일 케이크 사진", names("cake"), NOT("dog", "car", "beach", "skyscraper", "receipt"), 0.75)
fuzzy("산 사진", names("mountain"), NOT("pizza", "receipt", "whiteboard", "cake", "car"), 0.5)
fuzzy("커피 사진", names("coffee"), NOT("dog", "car", "beach", "skyscraper", "mountain"), 0.5)
fuzzy("결혼식 사진", names("wedding"), NOT("pizza", "car", "receipt", "dog", "ramen"), 0.5)
fuzzy("아기 사진", names("baby"), NOT("pizza", "car", "receipt", "skyscraper", "ramen"), 0.5)
fuzzy("콘서트 사진", names("concert"), NOT("pizza", "receipt", "cat", "cake", "coffee"), 0.5)
fuzzy("등산 사진", names("hiking"), NOT("pizza", "receipt", "cat", "cake", "coffee"), 0.5)
fuzzy("고층 빌딩 사진", names("skyscraper", "newyork"), NOT("dog", "pizza", "receipt", "cake", "coffee"), 0.5)
fuzzy("야경 사진", names("seoul"), NOT("receipt", "whiteboard", "pizza", "cake"), 0.5)
# No food photos in Paris: the agent must SAY it dropped the content words rather than pass landmarks off as food.
S.append({"id": f"R{len(S)+1:03d}", "q": "파리에서 찍은 음식 사진", "answerContains": "내용 조건을 빼고"})

# --- what the recording says (Whisper): keyword in transcript
fuzzy("rules 얘기한 회의 녹음", ["회의_녹음_CEE_Spring_2017.m4a"], ["meeting_lightning_talks_2017.m4a", "interview_ambaiowei.mp3"], 1.0)
fuzzy("recording about Wikipedia rules", ["회의_녹음_CEE_Spring_2017.m4a"], ["interview_ambaiowei.mp3"], 1.0)
fuzzy("pizza 언급된 녹음", ["meeting_lightning_talks_2017.m4a"], ["회의_녹음_CEE_Spring_2017.m4a", "interview_ambaiowei.mp3"], 1.0)
fuzzy("meeting recording about patience", ["meeting_lightning_talks_2017.m4a"], ["interview_ambaiowei.mp3"], 1.0)
fuzzy("사랑 얘기 나온 녹음", ["녹음_한국어_0.m4a"], ["meeting_lightning_talks_2017.m4a"], 1.0)
fuzzy("남극 언급한 녹음", ["녹음_한국어_3.m4a"], ["meeting_lightning_talks_2017.m4a"], 1.0)
fuzzy("결과 언급된 회의 영상", ["회의_영상_2026-09-15.mp4"], [], 1.0)

json.dump({"generatedAt": datetime.now().isoformat(), "files": files, "scenarios": S},
          open(os.path.join(OUT, "device-scenarios.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(files)} real files → {CORPUS}; {len(S)} scenarios")

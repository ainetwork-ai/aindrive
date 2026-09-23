#!/usr/bin/env python3
"""Generate the on-device search test corpus (~130 real files) and the 100
end-to-end scenarios that go with it.

    python3 scripts/make-test-corpus.py <out-dir>

Writes <out-dir>/corpus/… (photos with real EXIF date+GPS, screenshots, videos,
documents, spreadsheets, decks, audio, archives — realistic names, realistic
mtimes) and <out-dir>/device-scenarios.json, where each scenario's expected
file set is computed from the SAME corpus metadata by a small Python model of
the agent's semantics. run-device-scenarios.py pushes the corpus to the phone,
rebuilds the index and asks every question.

Everything relative ("yesterday", "last week", "recent") is anchored at
generation time, so regenerate right before a run.
"""
import json
import os
import random
import shutil
import struct
import sys
import time
import zipfile
from datetime import datetime, timedelta

from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else "test-corpus"
CORPUS = os.path.join(OUT, "corpus")
random.seed(7)
NOW = datetime.now().replace(microsecond=0)
TODAY = NOW.replace(hour=0, minute=0, second=0)

# ------------------------------------------------------------ EXIF writer (spec-correct, see mkexif in git history)

def _rational(v):
    v = abs(v); d = int(v); m = int((v - d) * 60); s = ((v - d) * 60 - m) * 60
    return [(d, 1), (m, 1), (int(round(s * 100)), 100)]

def _ifd(entries, base):
    n = len(entries); ifd_len = 2 + 12 * n + 4
    data = b""; out = struct.pack(">H", n)
    for tag, typ, val, cnt in sorted(entries):
        if len(val) <= 4:
            out += struct.pack(">HHI", tag, typ, cnt) + val.ljust(4, b"\0")
        else:
            out += struct.pack(">HHII", tag, typ, cnt, base + ifd_len + len(data))
            data += val + (b"\0" if len(val) % 2 else b"")
    return out + b"\0\0\0\0", data

def exif_bytes(dto, lat, lon):
    make_b = b"TestCam\0"; dto_b = dto.encode() + b"\0"
    ifd0_off = 8
    n0 = 3 if lat is not None else 2
    exif_off = ifd0_off + (2 + 12 * n0 + 4) + len(make_b)
    gps_off = exif_off + (2 + 12 + 4) + len(dto_b)
    e0 = [(0x010F, 2, make_b, len(make_b)), (0x8769, 4, struct.pack(">I", exif_off), 1)]
    if lat is not None:
        e0.append((0x8825, 4, struct.pack(">I", gps_off), 1))
    ifd0, d0 = _ifd(e0, ifd0_off)
    exif, d1 = _ifd([(0x9003, 2, dto_b, len(dto_b))], exif_off)
    tiff = b"MM\0\x2a" + struct.pack(">I", ifd0_off) + ifd0 + d0 + exif + d1
    if lat is not None:
        rat = lambda rs: b"".join(struct.pack(">II", a, b) for a, b in rs)
        gps, d2 = _ifd([
            (0x0001, 2, (b"N" if lat >= 0 else b"S") + b"\0", 2), (0x0002, 5, rat(_rational(lat)), 3),
            (0x0003, 2, (b"E" if lon >= 0 else b"W") + b"\0", 2), (0x0004, 5, rat(_rational(lon)), 3),
        ], gps_off)
        tiff += gps + d2
    return b"Exif\0\0" + tiff

# ------------------------------------------------------------ places

PLACES = {
    "paris":  ("Paris", "FR", 48.8566, 2.3522),
    "nice":   ("Nice", "FR", 43.7034, 7.2663),
    "london": ("London", "GB", 51.5074, -0.1278),
    "tokyo":  ("Tokyo", "JP", 35.6762, 139.6503),
    "osaka":  ("Osaka", "JP", 34.6937, 135.5023),
    "newyork": ("New York City", "US", 40.7128, -74.0060),
    "seoul":  ("Seoul", "KR", 37.5665, 126.9780),
    "busan":  ("Busan", "KR", 35.1796, 129.0756),
    "jeju":   ("Jeju City", "KR", 33.4996, 126.5312),
    "bangkok": ("Bangkok", "TH", 13.7563, 100.5018),
}

records = []   # {path, kind, when(datetime), city, country, size}

def put(rel, data, when, kind, place=None):
    path = os.path.join(CORPUS, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    ts = time.mktime(when.timetuple())
    os.utime(path, (ts, ts))
    city, country = (PLACES[place][0], PLACES[place][1]) if place else (None, None)
    records.append({"path": rel, "name": os.path.basename(rel), "kind": kind, "when": when.isoformat(),
                    "city": city, "country": country, "size": len(data)})

def photo(rel, when, place=None, size=(640, 480), pad=0):
    img = Image.new("RGB", size, (random.randint(30, 220), random.randint(30, 220), random.randint(30, 220)))
    import io
    buf = io.BytesIO()
    lat, lon = (PLACES[place][2] + random.uniform(-0.01, 0.01), PLACES[place][3] + random.uniform(-0.01, 0.01)) if place else (None, None)
    img.save(buf, "JPEG", exif=exif_bytes(when.strftime("%Y:%m:%d %H:%M:%S"), lat, lon), quality=90)
    data = buf.getvalue() + (b"\0" * pad)   # trailing bytes after EOI are ignored by decoders; make "large" files
    put(rel, data, when, "photo", place)

def png_screenshot(rel, when):
    import io
    buf = io.BytesIO()
    Image.new("RGB", (360, 780), (20, 24, 30)).save(buf, "PNG")
    put(rel, buf.getvalue(), when, "screenshot")

def video(rel, when, mb):
    # ftyp box + padding: a syntactically plausible MP4 header, nothing decodable — the index only reads names and sizes.
    head = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"
    put(rel, head + b"\0" * (int(mb * 1024 * 1024) - len(head)), when, "video")

def pdf(rel, when, title):
    body = f"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n% {title}\ntrailer<</Root 1 0 R>>\n%%EOF\n"
    put(rel, body.encode("utf-8"), when, "pdf")

def office(rel, when, kind):
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("docProps/core.xml", f"<core><title>{os.path.basename(rel)}</title></core>")
    put(rel, buf.getvalue(), when, kind)

def text(rel, when, body):
    put(rel, body.encode("utf-8"), when, "document")

def audio(rel, when, kb):
    put(rel, b"ID3" + b"\0" * (kb * 1024), when, "audio")

def archive(rel, when, names):
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n in names: z.writestr(n, "x")
    put(rel, buf.getvalue(), when, "archive")

def d(y, m, day, h=12): return datetime(y, m, day, h, random.randint(0, 59))
def ago(days, h=14): return (TODAY - timedelta(days=days)).replace(hour=h, minute=random.randint(0, 59))

if os.path.exists(CORPUS):
    shutil.rmtree(CORPUS)

# ------------------------------------------------------------ photos (with GPS)
for i in range(1, 9):   photo(f"Photos/2024-05 Paris/paris_{i:03d}.jpg", d(2024, 5, 11 + i // 3, 9 + i), "paris")
for i in range(1, 4):   photo(f"Photos/2024-05 Paris/nice_{i:03d}.jpg", d(2024, 5, 16 + i // 2, 15), "nice")
photo("Photos/2024-05 Paris/음식_파리_크루아상.jpg", d(2024, 5, 12, 8), "paris")
photo("Photos/2024-05 Paris/음식_파리_에스카르고.jpg", d(2024, 5, 14, 20), "paris")
for i in range(1, 7):   photo(f"Photos/2023-12 Tokyo/tokyo_{i:03d}.jpg", d(2023, 12, 27 + i // 2, 10 + i), "tokyo")
for i in range(1, 3):   photo(f"Photos/2023-12 Tokyo/osaka_{i:03d}.jpg", d(2024, 1, 2, 11 + i), "osaka")
for i in range(1, 5):   photo(f"Photos/2023-06 London/london_{i:03d}.jpg", d(2023, 6, 9 + i, 13), "london")
for i in range(1, 6):   photo(f"Photos/2025-10 New York/newyork_{i:03d}.jpg", d(2025, 10, 3 + i, 16), "newyork")
for i in range(1, 8):   photo(f"Photos/2025-08 Jeju/jeju_{i:03d}.jpg", d(2025, 8, 1 + i, 10 + i % 5), "jeju")
photo("Photos/2025-08 Jeju/제주_바다_협재.jpg", d(2025, 8, 4, 15), "jeju")
photo("Photos/2025-08 Jeju/제주_음식_흑돼지.jpg", d(2025, 8, 5, 19), "jeju")
for i in range(1, 5):   photo(f"Photos/2025-07 Busan/busan_{i:03d}.jpg", d(2025, 7, 19 + i, 14), "busan")
photo("Photos/2025-07 Busan/부산_바다_해운대.jpg", d(2025, 7, 21, 11), "busan")
for i in range(1, 4):   photo(f"Photos/2026-02 Bangkok/bangkok_{i:03d}.jpg", d(2026, 2, 10 + i, 12), "bangkok")
for i in range(1, 5):   photo(f"Photos/Seoul/seoul_한강_{i:03d}.jpg", d(2025, 4 + i, 6, 18), "seoul")
for i in range(1, 3):   photo(f"Photos/Seoul/seoul_카페_{i:03d}.jpg", d(2026, 3, 8 + i, 15), "seoul")
for i in range(1, 4):   photo(f"Photos/Pets/강아지_공원_{i:03d}.jpg", d(2026, 8, 2 + i, 17), "seoul")
for i in range(1, 3):   photo(f"Photos/Pets/고양이_{i:03d}.jpg", ago(12 + i), "seoul")          # recent (≤30 days)
photo("Photos/Receipts/영수증_스타벅스.jpg", ago(20), "seoul")
photo("Photos/Receipts/영수증_택시.jpg", d(2026, 6, 3), "seoul")
photo("Photos/Receipts/receipt_amazon.jpg", d(2026, 7, 14), "seoul")
# recency: today / yesterday / last week (Seoul)
photo("Photos/Camera/IMG_today_001.jpg", TODAY + timedelta(hours=9), "seoul")
photo("Photos/Camera/IMG_today_002.jpg", TODAY + timedelta(hours=11), "seoul")
for i in range(1, 4):   photo(f"Photos/Camera/IMG_yesterday_{i:03d}.jpg", ago(1, 10 + i), "seoul")
# last week = the previous Monday..Sunday
last_mon = TODAY - timedelta(days=TODAY.weekday() + 7)
for i in range(1, 4):   photo(f"Photos/Camera/IMG_lastweek_{i:03d}.jpg", last_mon + timedelta(days=i, hours=12), "seoul")
# no GPS
for i in range(1, 7):   photo(f"Photos/Misc/IMG_{2022 + i % 3}{i:02d}01_{i:03d}.jpg", d(2022 + i % 3, 1 + i, 1))
photo("Photos/Misc/large_panorama.jpg", d(2025, 5, 5), None, (2000, 600), pad=2 * 1024 * 1024)   # large photo
# ------------------------------------------------------------ screenshots
for i in range(1, 5):   png_screenshot(f"Screenshots/Screenshot_202609{10 + i:02d}_1{i}0000.png", d(2026, 9, 10 + i, 10 + i))
png_screenshot("Screenshots/Screenshot_today.png", TODAY + timedelta(hours=8))
png_screenshot("Screenshots/스크린샷 2026-08-20 오후 3.12.45.png", d(2026, 8, 20, 15))
png_screenshot("Screenshots/스크린샷 2026-07-02 오전 9.30.00.png", d(2026, 7, 2, 9))
for i in range(1, 3):   png_screenshot(f"Screenshots/Screenshot_lastweek_{i}.png", last_mon + timedelta(days=2 + i, hours=9))
# ------------------------------------------------------------ videos
video("Videos/VID_20240514_paris_seine.mp4", d(2024, 5, 14, 19), 3.0)
video("Videos/jeju_drone.mp4", d(2025, 8, 3, 17), 2.0)
video("Videos/birthday_2026.mp4", d(2026, 2, 28, 18), 0.4)
video("Videos/회의_녹화_2026-09-15.mp4", d(2026, 9, 15, 14), 1.5)
video("Videos/VID_yesterday.mp4", ago(1, 20), 0.2)
# ------------------------------------------------------------ documents
pdf("Documents/계약서_아인네트워크_2026.pdf", d(2026, 3, 2), "contract")
pdf("Documents/계약서_임대차_2025.pdf", d(2025, 11, 20), "lease")
pdf("Documents/이력서_김민현.pdf", d(2026, 1, 15), "resume")
pdf("Documents/invoice_2026-08.pdf", d(2026, 8, 31), "invoice")
pdf("Documents/invoice_2026-07.pdf", d(2026, 7, 31), "invoice")
pdf("Documents/영수증_호텔_파리.pdf", d(2024, 5, 18), "receipt")
pdf("Documents/보고서_Q2_2026.pdf", d(2026, 7, 5), "report")
pdf("Documents/manual_camera.pdf", d(2023, 3, 3), "manual")
pdf("Documents/논문_on-device-agents.pdf", ago(3), "paper")
office("Documents/회의록_2026-09-15.docx", d(2026, 9, 15, 16), "document")
office("Documents/회의록_2026-09-22.docx", ago(2), "document")
office("Documents/보고서_Q3_초안.docx", ago(5), "document")
office("Documents/제안서_모바일에이전트.docx", d(2026, 9, 1), "document")
office("Documents/계약서_초안.docx", d(2026, 2, 20), "document")
text("Documents/notes.txt", d(2026, 6, 6), "todo\n")
text("Documents/README.md", d(2026, 5, 1), "# readme\n")
text("Documents/아이디어_메모.txt", ago(9), "메모\n")
office("Documents/예산_2026.xlsx", d(2026, 1, 10), "spreadsheet")
office("Documents/budget_Q3.xlsx", ago(6), "spreadsheet")
office("Documents/가계부_2025.xlsx", d(2025, 12, 31), "spreadsheet")
office("Documents/참석자_명단.csv", d(2026, 9, 12), "spreadsheet")
office("Documents/발표자료_킥오프.pptx", d(2026, 9, 3), "presentation")
office("Documents/제안서_발표.pptx", d(2026, 4, 22), "presentation")
office("Documents/pitch_deck_2025.pptx", d(2025, 10, 30), "presentation")
office("Documents/이력서_영문.docx", d(2026, 1, 16), "document")
# ------------------------------------------------------------ audio / archives / other
audio("Music/녹음_회의_2026-09-15.m4a", d(2026, 9, 15, 15), 300)
audio("Music/녹음_인터뷰.mp3", d(2026, 4, 4), 900)
audio("Music/song_demo.mp3", d(2025, 9, 9), 1500)
archive("Archives/backup_2025.zip", d(2025, 12, 30), ["a", "b"])
archive("Archives/photos_export_paris.zip", d(2024, 6, 1), ["p1", "p2"])
archive("Archives/프로젝트_소스.zip", ago(4), ["src"])
put("Other/app-debug.apk", b"PK\x03\x04" + b"\0" * 1024 * 1200, d(2026, 9, 20), "other")
put("Other/data.bin", b"\0" * 2048, d(2026, 1, 1), "other")

# ------------------------------------------------------------ scenarios: question + semantic filter → expected files

def W(days_from=None, days_to=None): return (TODAY + timedelta(days=days_from), TODAY + timedelta(days=days_to))
def month(y, m):
    a = datetime(y, m, 1); b = datetime(y + (m == 12), (m % 12) + 1, 1); return (a, b)
def year(y): return (datetime(y, 1, 1), datetime(y + 1, 1, 1))
def season(y, s):
    return {"spring": (datetime(y, 3, 1), datetime(y, 6, 1)), "summer": (datetime(y, 6, 1), datetime(y, 9, 1)),
            "autumn": (datetime(y, 9, 1), datetime(y, 12, 1)), "winter": (datetime(y, 12, 1), datetime(y + 1, 3, 1))}[s]
Y = NOW.year
this_mon = TODAY - timedelta(days=TODAY.weekday())
LASTWEEK = (this_mon - timedelta(days=7), this_mon)
THISWEEK = (this_mon, this_mon + timedelta(days=7))
RECENT = (TODAY - timedelta(days=30), TODAY + timedelta(days=1))
TODAYW = W(0, 1); YESTERDAY = W(-1, 0)
LARGE = 1024 * 1024

def expect(kind=None, city=None, country=None, when=None, kw=(), min_size=None, photoish=False):
    out = []
    for r in records:
        if kind and r["kind"] != kind: continue
        if photoish and r["kind"] not in ("photo", "screenshot"): continue
        if city and r["city"] != city: continue
        if country and r["country"] != country: continue
        if when:
            t = datetime.fromisoformat(r["when"])
            if not (when[0] <= t < when[1]): continue
        if min_size and r["size"] < min_size: continue
        if kw and not all(k.lower() in r["name"].lower() for k in kw): continue
        out.append(r["name"])
    return sorted(out)

S = []
def sc(q, **f): S.append({"id": f"S{len(S) + 1:03d}", "q": q, "expect": expect(**f)})

# A. place (photos)
sc("파리에서 찍은 사진 찾아줘", kind="photo", city="Paris")
sc("프랑스 여행 갔던 사진", kind="photo", country="FR")
sc("니스에서 찍은 사진", kind="photo", city="Nice")
sc("도쿄 사진 보여줘", kind="photo", city="Tokyo")
sc("오사카에서 찍은 사진", kind="photo", city="Osaka")
sc("일본 여행 사진", kind="photo", country="JP")
sc("런던에서 찍은 사진", kind="photo", city="London")
sc("영국 사진", kind="photo", country="GB")
sc("뉴욕 사진", kind="photo", city="New York City")
sc("미국에서 찍은 사진", kind="photo", country="US")
sc("제주 사진", kind="photo", city="Jeju City")
sc("부산에서 찍은 사진", kind="photo", city="Busan")
sc("서울 사진", kind="photo", city="Seoul")
sc("한국에서 찍은 사진", kind="photo", country="KR")
sc("방콕 사진", kind="photo", city="Bangkok")
sc("태국 여행 사진", kind="photo", country="TH")
sc("photos from Paris", kind="photo", city="Paris")
sc("pictures taken in Tokyo", kind="photo", city="Tokyo")
sc("photos from New York", kind="photo", city="New York City")
sc("pictures from Korea", kind="photo", country="KR")
sc("photos from France", kind="photo", country="FR")
sc("photos from Jeju", kind="photo", city="Jeju City")
sc("London photos", kind="photo", city="London")
# B. place + date
sc("2024년 5월 파리 사진", kind="photo", city="Paris", when=month(2024, 5))
sc("2023년 도쿄 사진", kind="photo", city="Tokyo", when=year(2023))
sc("2024년 1월 오사카 사진", kind="photo", city="Osaka", when=month(2024, 1))
sc("2025년 8월 제주 사진", kind="photo", city="Jeju City", when=month(2025, 8))
sc("작년 여름 제주 사진", kind="photo", city="Jeju City", when=season(Y - 1, "summer"))
sc("작년 여름 부산 사진", kind="photo", city="Busan", when=season(Y - 1, "summer"))
sc("2025년 10월 뉴욕 사진", kind="photo", city="New York City", when=month(2025, 10))
sc("올해 방콕 사진", kind="photo", city="Bangkok", when=year(Y))
sc("photos from Paris in May 2024", kind="photo", city="Paris", when=month(2024, 5))
sc("Tokyo photos from December 2023", kind="photo", city="Tokyo", when=month(2023, 12))
sc("Busan photos last summer", kind="photo", city="Busan", when=season(Y - 1, "summer"))
sc("2023년 겨울 일본 사진", kind="photo", country="JP", when=season(2023, "winter"))
# C. date only (photos)
sc("2024년 사진", kind="photo", when=year(2024))
sc("2023년 6월 사진", kind="photo", when=month(2023, 6))
sc("작년 사진", kind="photo", when=year(Y - 1))
sc("올해 사진", kind="photo", when=year(Y))
sc("photos from 2025", kind="photo", when=year(2025))
sc("pictures from October 2025", kind="photo", when=month(2025, 10))
sc("2026년 8월 사진", kind="photo", when=month(2026, 8))
# D. recency
sc("오늘 찍은 사진", kind="photo", when=TODAYW)
sc("어제 사진", kind="photo", when=YESTERDAY)
sc("지난주 사진", kind="photo", when=LASTWEEK)
sc("지난주 스크린샷", kind="screenshot", when=LASTWEEK)
sc("오늘 스크린샷", kind="screenshot", when=TODAYW)
sc("photos taken today", kind="photo", when=TODAYW)
sc("yesterday's photos", kind="photo", when=YESTERDAY)
sc("last week's photos", kind="photo", when=LASTWEEK)
sc("어제 영상", kind="video", when=YESTERDAY)
sc("최근 문서", kind="document", when=RECENT)
sc("recent PDFs", kind="pdf", when=RECENT)
sc("최근 엑셀 파일", kind="spreadsheet", when=RECENT)
sc("최근 압축파일", kind="archive", when=RECENT)
# E. kinds
sc("스크린샷 보여줘", kind="screenshot")
sc("스샷 찾아줘", kind="screenshot")
sc("screenshots", kind="screenshot")
sc("영상 파일", kind="video")
sc("videos", kind="video")
sc("PDF 파일", kind="pdf")
sc("엑셀 파일", kind="spreadsheet")
sc("spreadsheets", kind="spreadsheet")
sc("발표자료", kind="presentation")
sc("ppt 파일 보여줘", kind="presentation")
sc("녹음 파일", kind="audio")
sc("음악 파일", kind="audio")
sc("압축 파일", kind="archive")
sc("zip files", kind="archive")
sc("문서 파일", kind="document")
sc("word documents", kind="document")
# F. kind + name keyword
sc("계약서 pdf", kind="pdf", kw=["계약서"])
sc("계약서 문서", kind="document", kw=["계약서"])
sc("이력서 pdf", kind="pdf", kw=["이력서"])
sc("회의록 문서", kind="document", kw=["회의록"])
sc("invoice pdf", kind="pdf", kw=["invoice"])
sc("보고서 파일", kw=["보고서"])
sc("예산 엑셀", kind="spreadsheet", kw=["예산"])
sc("budget spreadsheet", kind="spreadsheet", kw=["budget"])
sc("킥오프 발표자료", kind="presentation", kw=["킥오프"])
sc("pitch deck", kind="presentation", kw=["pitch"])
sc("회의 녹음", kind="audio", kw=["회의"])
sc("backup zip", kind="archive", kw=["backup"])
sc("회의 영상", kind="video", kw=["회의"])
sc("drone video", kind="video", kw=["drone"])
# G. name keyword only / content-ish words (matched on file names for now)
sc("영수증", kw=["영수증"])
sc("영수증 사진", kind="photo", kw=["영수증"])
sc("강아지 사진", kind="photo", kw=["강아지"])
sc("고양이 사진 보여줘", kind="photo", kw=["고양이"])
sc("바다 사진", kind="photo", kw=["바다"])
sc("제주 바다 사진", kind="photo", city="Jeju City", kw=["바다"])
sc("음식 사진", kind="photo", kw=["음식"])
sc("파리 음식 사진", kind="photo", city="Paris", kw=["음식"])
sc("한강 사진", kind="photo", kw=["한강"])
sc("제안서", kw=["제안서"])
sc("manual", kw=["manual"])
# H. size
sc("큰 파일", min_size=LARGE)
sc("large files", min_size=LARGE)
sc("큰 영상 파일", kind="video", min_size=LARGE)
sc("대용량 사진", kind="photo", min_size=LARGE)

assert len(S) == 100, len(S)
for s in S:
    assert s["expect"], f"scenario has no expected files: {s['q']}"
    assert len(s["expect"]) <= 50, f"more than LIMIT: {s['q']}"

with open(os.path.join(OUT, "device-scenarios.json"), "w", encoding="utf-8") as f:
    json.dump({"generatedAt": NOW.isoformat(), "files": records, "scenarios": S}, f, ensure_ascii=False, indent=1)
print(f"{len(records)} files in {CORPUS}, {len(S)} scenarios → {os.path.join(OUT, 'device-scenarios.json')}")

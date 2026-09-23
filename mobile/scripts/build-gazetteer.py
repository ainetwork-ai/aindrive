#!/usr/bin/env python3
"""Build android/app/src/main/assets/geo/cities.tsv.gz from GeoNames dumps.

Inputs (download from https://download.geonames.org/export/dump/):
  cities15000.zip        — every populated place with ≥15k people (required)
  alternateNamesV2.zip   — language-tagged names; used for proper Korean city
                           names (optional: without it the first Hangul alias
                           in cities15000 is used, which is sometimes archaic —
                           e.g. 경성 for Seoul).

Usage: python3 scripts/build-gazetteer.py <dir-with-unzipped-dumps>

Output columns: name, ISO country, lat, lon, population, Korean name.
Rows are sorted by population desc (GeoLookup relies on it: first name wins).
Sections of cities (PPLX: "Paris 16 Passy") and historical/abandoned places
are dropped so a landmark resolves to the city people actually name.
"""
import gzip
import os
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "."
OUT = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "main", "assets", "geo", "cities.tsv.gz")
DROP = {"PPLX", "PPLH", "PPLQ", "PPLW"}
HANGUL = re.compile(r"^[가-힣\s]+$")

cities = []
with open(os.path.join(SRC, "cities15000.txt"), encoding="utf-8") as f:
    for line in f:
        c = line.rstrip("\n").split("\t")
        if c[7] in DROP:
            continue
        ko = next((a.strip() for a in c[3].split(",") if a.strip() and HANGUL.match(a.strip())), "")
        cities.append([int(c[0]), c[1], c[8], c[4], c[5], int(c[14] or 0), ko])

alt = os.path.join(SRC, "alternateNamesV2.txt")
if os.path.exists(alt):
    want = {c[0] for c in cities}
    best = {}  # geonameid -> (rank, name)  rank: 0 preferred, 1 plain, 2 short/colloquial/historic
    with open(alt, encoding="utf-8") as f:
        for line in f:
            c = line.rstrip("\n").split("\t")
            if len(c) < 8 or c[2] != "ko":
                continue
            gid = int(c[1])
            if gid not in want or not HANGUL.match(c[3]):
                continue
            preferred, short, colloquial, historic = c[4] == "1", c[5] == "1", c[6] == "1", c[7] == "1"
            rank = 0 if preferred else 2 if (short or colloquial or historic) else 1
            if gid not in best or rank < best[gid][0]:
                best[gid] = (rank, c[3])
    for c in cities:
        if c[0] in best:
            c[6] = best[c[0]][1]
    print(f"korean names from alternateNamesV2: {len(best)}")

cities.sort(key=lambda c: -c[5])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with gzip.open(OUT, "wt", encoding="utf-8") as g:
    g.write("# GeoNames cities15000 (CC BY 4.0, https://www.geonames.org) — name\tcountry\tlat\tlon\tpopulation\tko\n")
    for c in cities:
        g.write("\t".join([c[1], c[2], c[3], c[4], str(c[5]), c[6]]) + "\n")
print(f"wrote {len(cities)} cities → {os.path.abspath(OUT)} ({os.path.getsize(OUT)} bytes)")

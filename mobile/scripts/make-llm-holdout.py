#!/usr/bin/env python3
"""llm-holdout: phrasings a person actually types that the rule parser was never written for.
Hand-written (not templated) on 2026-09-27, BEFORE the LLM-assisted understanding was tuned
(docs/superpowers/specs/2026-09-27-llm-understanding-design.md, "Evaluation"). Same schema and
date conventions as make-dialogues.py (today 2026-09-27, a Sunday; weeks start Monday; seasons
Mar/Jun/Sep/Dec; a month still ahead this year means last year's). English only, like the rest
of the dataset. Do not tune on it: scores here are the honest number.
"""
import json
from datetime import date, timedelta

TODAY = date(2026, 9, 27)
MONDAY = TODAY - timedelta(TODAY.weekday())
d = lambda x: x.isoformat()
def month(y, m): return (date(y, m, 1), date(y + (m == 12), m % 12 + 1, 1))
def year(y): return (date(y, 1, 1), date(y + 1, 1, 1))
def season(y, m0): return (date(y, m0, 1), date(y + (m0 + 3 > 12), (m0 + 3 - 1) % 12 + 1, 1))
LAST_WEEK = (MONDAY - timedelta(7), MONDAY)
THIS_WEEK = (MONDAY, MONDAY + timedelta(7))
LAST_WEEKEND = (MONDAY - timedelta(2), MONDAY)
YESTERDAY = (TODAY - timedelta(1), TODAY)

def st(kind=None, city=None, country=None, when=None, content=(), limit=0, oldest=False, largest=False):
    return {"kind": kind, "city": city, "country": country,
            "date_from": d(when[0]) if when else None, "date_to": d(when[1]) if when else None,
            "content": list(content), "limit": limit, "oldest": oldest, "largest": largest}

def files(u, intent="FindFiles", **kw): return {"utterance": u, "route": "files", "intent": intent, "state": st(**kw)}
def chat(u): return {"utterance": u, "route": "chat", "intent": "Chat", "state": None}
def out(u): return {"utterance": u, "route": "out", "intent": "OutOfScope", "state": None}
def calls(u, intent="CallReport"): return {"utterance": u, "route": "calls", "intent": intent, "state": None}

D = [
    # --- the folder itself is the subject, not a destination
    [files("what's in this folder?"), files("and how many of those are videos", "CountFiles", kind="video")],
    [files("can you show me what this folder has"), files("just the PDFs please", kind="pdf")],
    [files("is there anything in here from Tokyo?", city="Tokyo", country="JP")],
    [files("give me a rundown of this folder"), chat("thanks, that's all")],
    # --- indirect asks
    [files("anything from Sam's wedding?", content=["wedding"])],
    [files("got any pictures of the beach", kind="photo", content=["beach"]), files("the ones from last summer", kind="photo", content=["beach"], when=season(2025, 6))],
    [files("I'm looking for that contract we signed in March", kind="document", content=["contract"], when=month(2026, 3))],
    [files("where did the receipts from the Lisbon trip end up", city="Lisbon", country="PT", content=["receipt"])],
    [files("I know there's a sunset shot from Bali somewhere", kind="photo", country="ID", content=["sunset"])],
    [files("did I ever save the invoice from the plumber", content=["invoice"])],
    [files("remind me what videos I took in Kyoto", kind="video", city="Kyoto", country="JP")],
    [files("there should be a recording of the budget call", kind="audio", content=["budget"])],
    [files("pull up whatever I have from Barcelona", city="Barcelona", country="ES"), files("only the videos", kind="video", city="Barcelona", country="ES")],
    [files("any chance you have the passport scan", content=["passport"])],
    # --- time expressed as people say it
    [files("pics from the week before this one", kind="photo", when=LAST_WEEK)],
    [files("everything I shot this past summer", when=season(2026, 6))],
    [files("screenshots from earlier this week", kind="screenshot", when=THIS_WEEK)],
    [files("what did I photograph over the weekend", kind="photo", when=LAST_WEEKEND)],
    [files("photos from the winter before this one", kind="photo", when=season(2025, 12))],
    [files("the December photos", kind="photo", when=month(2025, 12))],
    [files("videos from back in 2023", kind="video", when=year(2023))],
    [files("anything from yesterday evening", when=YESTERDAY)],
    [files("all the spreadsheets I made this year", kind="spreadsheet", when=year(2026))],
    [files("stuff from three days ago", when=(TODAY - timedelta(3), TODAY - timedelta(2)))],
    [files("photos from the spring of 2025", kind="photo", when=season(2025, 3))],
    # --- places inside a sentence
    [files("show me the pictures from when we were in Prague", kind="photo", city="Prague", country="CZ")],
    [files("what did I film on the Hanoi trip", kind="video", city="Hanoi", country="VN")],
    [files("the Vancouver stuff from last year", city="Vancouver", country="CA", when=year(2025))],
    [files("I want to see my Japan photos", kind="photo", country="JP"), files("the Osaka ones only", kind="photo", city="Osaka", country="JP")],
    [files("temple pictures from Taipei", kind="photo", city="Taipei", country="TW", content=["temple"])],
    [files("snow photos from Zürich this winter", kind="photo", city="Zürich", country="CH", content=["snow"], when=season(2025, 12))],
    [files("recordings from the Berlin meetings", kind="audio", city="Berlin", country="DE", content=["meeting"])],
    # --- counting, said differently
    [files("how much stuff do I have from Bangkok", "CountFiles", city="Bangkok", country="TH")],
    [files("do I have more than ten videos from Osaka?", "CountFiles", kind="video", city="Osaka", country="JP")],
    [files("count the screenshots from last month", "CountFiles", kind="screenshot", when=month(2026, 8))],
    [files("what's the number of PDFs in here", "CountFiles", kind="pdf")],
    # --- collecting and sharing, said differently
    [files("put the Sydney photos together somewhere", "CollectFiles", kind="photo", city="Sydney", country="AU")],
    [files("gather up all the dog pictures", "CollectFiles", kind="photo", content=["dog"]), files("and send me a link to it", "ShareFiles", kind="photo", content=["dog"])],
    [files("make me a set of the whiteboard photos from this week", "CollectFiles", kind="photo", content=["whiteboard"], when=THIS_WEEK)],
    [files("I want the Chicago videos in one place", "CollectFiles", kind="video", city="Chicago", country="US")],
    [files("get the recipes together so I can pass them on", "ShareFiles", content=["recipe"])],
    [files("bundle the August receipts and give me a link", "ShareFiles", content=["receipt"], when=month(2026, 8))],
    [files("move the Singapore screenshots out into their own folder", "MoveFiles", kind="screenshot", city="Singapore", country="SG")],
    [files("get rid of the screenshots from yesterday", "DeleteFiles", kind="screenshot", when=YESTERDAY)],
    # --- ordering and limits
    [files("the five biggest videos", kind="video", limit=5, largest=True)],
    [files("my oldest photos from London", kind="photo", city="London", country="GB", oldest=True)],
    [files("just the three most recent PDFs", kind="pdf", limit=3)],
    [files("what's the earliest thing I have from Paris", city="Paris", country="FR", oldest=True)],
    # --- typos and terse
    [files("fotos frm tokyo", kind="photo", city="Tokyo", country="JP")],
    [files("vids amsterdam", kind="video", city="Amsterdam", country="NL")],
    [files("cat pics", kind="photo", content=["cat"])],
    [files("resume pdf", kind="pdf", content=["resume"])],
    # --- file talk that is NOT a file question
    [out("my desk at work is such a mess, any tips?")],
    [chat("do you like photography?")],
    [out("what camera should I buy for travel photos")],
    [out("can you book a table for four tonight")],
    [out("how do I share my screen in a video call")],
    [out("write me a caption for my beach photo")],
    [chat("you're pretty good at this")],
    [out("is it going to rain in Tokyo tomorrow")],
    # --- conversations that switch
    [chat("hey"), files("photos from Seoul in August", kind="photo", city="Seoul", country="KR", when=month(2026, 8)), files("what about videos", kind="video", city="Seoul", country="KR", when=month(2026, 8)), chat("perfect, thank you")],
    [out("what time is it in New York"), files("actually, show me my New York photos", kind="photo", city="New York City", country="US")],
    [files("wedding photos", kind="photo", content=["wedding"]), out("who should I invite to mine?"), files("back to the photos — just the ones from Italy", kind="photo", content=["wedding"], country="IT")],
    [calls("who did I talk to the most this month"), files("and the recordings with the bank", kind="audio", content=["bank"])],
]

turns = sum(len(x) for x in D)
out_ = {"today": d(TODAY), "dialogues": [{"dialogue_id": f"llm_holdout_{i:05d}", "turns": t} for i, t in enumerate(D)]}
import os
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "android", "app", "src", "test", "resources", "dialogues", "llm-holdout.json")
json.dump(out_, open(path, "w"), ensure_ascii=False, indent=1)
print(f"{len(D)} dialogues, {turns} turns → {path}")

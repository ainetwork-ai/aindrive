#!/usr/bin/env python3
"""
aindrive dialogue dataset — a DSTC8 Schema-Guided-Dialogue-style corpus for
what the on-device agent CAN do: find, collect, share, count, move and delete
the files on the phone (photos, videos, recordings, documents…), plus the
call-log reports, small talk and out-of-scope requests.

Each dialogue is a list of user turns; each turn carries the annotation the
agent must reach (SGD style: the FULL dialogue state after that turn, not just
what the turn said), so carry-over ("only the ones from 2024", "and share
them") and resets (a new topic) are measured, not just single questions.

    route   files | calls | chat | out
    intent  FindFiles CollectFiles ShareFiles MoveFiles DeleteFiles CountFiles
            CallReport WhoLikesMe Chat OutOfScope
    state   kind city country date_from date_to content[] limit oldest largest

Splits (like SGD's unseen services): every template list and value pool is
partitioned; `test` uses phrasings and values `dev` never shows, so tuning the
parser on dev and reporting test is honest.

"Today" is 2026-09-24 (a Thursday), matching the unit tests.

    python3 scripts/make-dialogues.py   # → android/app/src/test/resources/dialogues/
"""
import json, os, random
from datetime import date, timedelta

OUT = os.path.join(os.path.dirname(__file__), "..", "android", "app", "src", "test", "resources", "dialogues")
TODAY = date(2026, 9, 24)

# ---------------------------------------------------------------- values

# (surface, GeoNames city, ISO country)
CITIES = [
    ("Paris", "Paris", "FR"), ("London", "London", "GB"), ("Tokyo", "Tokyo", "JP"), ("New York", "New York City", "US"),
    ("Los Angeles", "Los Angeles", "US"), ("San Francisco", "San Francisco", "US"), ("Seoul", "Seoul", "KR"),
    ("Osaka", "Osaka", "JP"), ("Barcelona", "Barcelona", "ES"), ("Rome", "Rome", "IT"), ("Berlin", "Berlin", "DE"),
    ("Bangkok", "Bangkok", "TH"), ("Nice", "Nice", "FR"), ("Busan", "Busan", "KR"), ("Hong Kong", "Hong Kong", "HK"),
    ("Kyoto", "Kyoto", "JP"), ("Madrid", "Madrid", "ES"), ("Amsterdam", "Amsterdam", "NL"), ("Vienna", "Vienna", "AT"),
    ("Sydney", "Sydney", "AU"), ("Toronto", "Toronto", "CA"), ("Chicago", "Chicago", "US"), ("Seattle", "Seattle", "US"),
    ("Milan", "Milan", "IT"), ("Lisbon", "Lisbon", "PT"), ("Prague", "Prague", "CZ"), ("Singapore", None, "SG"),
    ("Taipei", "Taipei", "TW"), ("Hanoi", "Hanoi", "VN"), ("Munich", "Munich", "DE"),
]
COUNTRIES = [
    ("France", "FR"), ("Japan", "JP"), ("Korea", "KR"), ("Italy", "IT"), ("Spain", "ES"), ("Germany", "DE"),
    ("Mexico", "MX"), ("Thailand", "TH"), ("Vietnam", "VN"), ("the UK", "GB"), ("the US", "US"), ("Canada", "CA"),
    ("Australia", "AU"), ("Switzerland", "CH"), ("Portugal", "PT"), ("Greece", "GR"),
]


def ym(y, m):
    return date(y, m, 1)


def next_month(d):
    return date(d.year + (d.month == 12), d.month % 12 + 1, 1)


def year(y):
    return (date(y, 1, 1), date(y + 1, 1, 1))


def month(y, m):
    return (ym(y, m), next_month(ym(y, m)))


MONDAY = TODAY - timedelta(days=TODAY.weekday())
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

# (surface, (from, to)) — `from` inclusive, `to` exclusive.
DATES = [
    ("last month", month(2026, 8)), ("this month", month(2026, 9)), ("last year", year(2025)), ("this year", year(2026)),
    ("in 2024", year(2024)), ("from 2023", year(2023)), ("in May 2024", month(2024, 5)), ("from March 2025", month(2025, 3)),
    ("in July", month(2026, 7)), ("from June", month(2026, 6)), ("last summer", (ym(2025, 6), ym(2025, 9))),
    ("this spring", (ym(2026, 3), ym(2026, 6))), ("last winter", (ym(2025, 12), ym(2026, 3))),
    ("yesterday", (TODAY - timedelta(1), TODAY)), ("today", (TODAY, TODAY + timedelta(1))),
    ("last week", (MONDAY - timedelta(7), MONDAY)), ("this week", (MONDAY, MONDAY + timedelta(7))),
    ("in December 2024", month(2024, 12)), ("from 2022", year(2022)), ("in August", month(2026, 8)),
    # phrasings people use that a keyword parser easily misses
    ("in December", month(2025, 12)),                   # a month still ahead this year = last year's
    ("back in March", month(2026, 3)),
    ("from last weekend", (MONDAY - timedelta(2), MONDAY)),
    ("in the past week", (TODAY - timedelta(7), TODAY + timedelta(1))),
    ("from the last 30 days", (TODAY - timedelta(30), TODAY + timedelta(1))),
    ("two weeks ago", (MONDAY - timedelta(14), MONDAY - timedelta(7))),
    ("3 days ago", (TODAY - timedelta(3), TODAY - timedelta(2))),
    ("earlier this year", year(2026)),
    ("from summer 2024", (ym(2024, 6), ym(2024, 9))),
    ("in fall 2025", (ym(2025, 9), ym(2025, 12))),
]

# What a photo shows: (surface noun, canonical content word)
PHOTO_TOPICS = [
    ("food", "food"), ("sunset", "sunset"), ("beach", "beach"), ("dog", "dog"), ("cat", "cat"), ("car", "car"),
    ("receipt", "receipt"), ("mountain", "mountain"), ("flower", "flower"), ("snow", "snow"), ("cake", "cake"),
    ("coffee", "coffee"), ("whiteboard", "whiteboard"), ("baby", "baby"), ("selfie", "selfie"), ("building", "building"),
    ("sky", "sky"), ("river", "river"), ("park", "park"), ("bridge", "bridge"), ("pizza", "pizza"), ("sushi", "sushi"),
    ("menu", "menu"), ("tree", "tree"), ("lake", "lake"), ("concert", "concert"), ("wedding", "wedding"), ("birthday", "birthday"),
]
# What a recording talks about
REC_TOPICS = ["budget", "hiring", "roadmap", "contract", "vacation", "marketing", "launch", "pricing", "insurance", "rent",
              "investment", "design", "recruiting", "deadline", "moving", "school"]
DOC_TOPICS = ["lease", "invoice", "resume", "tax", "contract", "passport", "insurance", "salary", "visa", "warranty", "mortgage", "report"]

# (surface plural, canonical kind)
KINDS = {
    "photo": ["photos", "pictures", "pics", "images", "shots", "snaps"],
    "video": ["videos", "clips", "movies I shot", "video clips"],
    "audio": ["recordings", "voice memos", "audio files", "voice recordings"],
    "screenshot": ["screenshots", "screen captures", "screen grabs"],
    "pdf": ["PDFs", "PDF files"],
    "document": ["documents", "docs", "Word files", "notes"],
    "spreadsheet": ["spreadsheets", "Excel files", "sheets"],
    "presentation": ["presentations", "slide decks", "PowerPoints"],
    "archive": ["zip files", "archives"],
}

OUT_OF_SCOPE = [
    "Book a table for two at an Italian place tonight.", "What's the weather like in Seattle tomorrow?",
    "Find me a flight to Chicago next Friday.", "Play some jazz on the living room speaker.", "Set an alarm for 6:30 am.",
    "Send a text to Mom saying I'll be late.", "Call me a cab to the airport.", "What movies are playing near me?",
    "I need a hotel in Denver for three nights.", "Transfer $200 to my savings account.", "Tell me a joke.",
    "Order a large pepperoni pizza.", "How tall is the Eiffel Tower?", "Remind me to buy milk.",
    "Find a hair salon in San Jose.", "Get me tickets to the Lakers game.", "What time is it in London?",
    "Rent a compact car for the weekend.", "Find a dentist near downtown.", "Translate 'thank you' into Japanese.",
    "Schedule a meeting with Alex on Monday.", "What's my bank balance?", "Buy bus tickets to Sacramento.",
    "Recommend a good sushi restaurant.",
]
OUT_FOLLOWUPS = ["For 4 people.", "Tomorrow at 7 pm.", "Yes, please.", "The cheaper one.", "The earlier one.", "No, the other one.",
                 "Make it for Saturday.", "In the morning.", "Downtown, please.", "Two tickets."]
CHAT_OPEN = ["Hi", "Hello", "Hey there", "Good morning", "What can you do?", "Hi!", "Hello there", "How are you?", "What's up?",
             "Who are you?", "Nice to meet you!"]
CHAT_CLOSE = ["Thanks!", "Thank you so much.", "Great, thanks.", "Perfect, that's all.", "Ok, bye.", "Thanks, that's it.", "Awesome, thank you!"]

CALLS = ["Who do I call the most?", "Sort my call history by who I talk to most.", "Summarize my call history.",
         "Who did I talk to the most on the phone?", "Show my call log ranked by person.", "Give me a report of my calls.",
         "Rank my contacts by how often we talk on the phone.", "What do I usually talk about with the people I call most?"]
LIKES = ["Who likes me the most?", "Who likes me the most and what's the proof?", "Who loves me the most?",
         "Who cares about me the most?", "Who misses me the most?", "Who's closest to me?"]

# ---------------------------------------------------------------- templates
# {k} kind surface, {p} place phrase, {d} date phrase, {t} topic.  Each list is
# split dev/test by position (every 4th → test).

FIND = [
    "show me {k} {p}", "{k} {p}", "find my {k} {d}", "{k} {d}", "I'm looking for the {k} I took {p}",
    "can you find {k} {p} {d}?", "pull up my {k} {d}", "where are my {k} {p}?", "show {k} {p} {d}",
    "get me the {k} {d}", "any {k} {p}?", "I want to see my {k} {d}", "open my {k} {p}",
    "list the {k} {d}", "{k} taken {p}", "do I have {k} {p}?",
]
FIND_TOPIC = [
    "{t} {k}", "{k} of {t}", "show me {t} {k}", "find {k} of my {t}", "{k} with a {t}", "any {t} {k} {d}?",
    "I need the {t} {k} {p}", "{t} {k} {d}", "pictures of the {t} {p}", "{t} {k} I took {d}",
    "look for {t} {k}", "{k} that show a {t}", "my {k} of the {t} {d}",
]
FIND_REC = [
    "recordings about the {t}", "find the meeting recording where we talked about {t}", "voice memos about {t}",
    "the call where we discussed the {t}", "{t} recordings {d}", "any recordings mentioning {t}?",
    "find the audio about {t}", "meeting recordings about {t} {d}",
]
FIND_DOC = [
    "my {t} {k}", "find the {t} {k}", "{k} about the {t}", "where's the {t} {k}?", "{t} {k} {d}", "open the {t} {k}",
    "show me the {t} {k} I saved {d}", "the {k} for my {t}",
]
COLLECT = [
    "collect the {k} {p} into a folder", "put my {k} {d} in a folder", "make an album of the {k} {p}",
    "gather all {k} {p} {d}", "organize the {k} {d} into a folder", "copy the {k} {p} into a new folder",
    "create a folder with my {k} {p}", "move... no, collect the {k} {d}",
]
SHARE = [
    "share the {k} {p}", "collect the {k} {d} and share them", "make a folder of my {k} {p} and share it",
    "share my {k} {d} with a link", "put the {k} {p} in a folder and give me a link", "share all {k} {p} {d}",
]
COUNT = ["how many {k} did I take {p}?", "how many {k} {d}?", "count my {k} {p}", "how many {k} do I have {d}?",
         "number of {k} {p}", "how many {k} are there {p} {d}?"]
DELETE = ["delete the {k} {d}", "remove all {k} {p}", "get rid of the {k} {d}", "trash my {k} {d}", "delete {k} {p} {d}"]
MOVE = ["move the {k} {p} into a folder", "move my {k} {d} to a new folder", "move all {k} {p} somewhere else",
        "move the {k} {d} into their own folder"]
RANK = [("the {n} largest {k}", "largest"), ("my {n} biggest {k}", "largest"), ("the oldest {n} {k}", "oldest"),
        ("my {n} oldest {k}", "oldest"), ("show the latest {n} {k}", "latest"), ("the newest {n} {k}", "latest"),
        ("top {n} largest {k} {d}", "largest"), ("the {n} most recent {k}", "latest")]

REFINE_PLACE = ["only the ones from {n}", "just {n}", "what about {n}?", "how about in {n}?", "and in {n}?", "only {n} please",
                "narrow it to {n}", "the ones taken in {n}"]
REFINE_DATE = ["only the ones {d}", "just the ones {d}", "what about {d}?", "only those {d}", "and {d}?",
               "same but {d}", "how about {d}?", "the ones {d} please"]
REFINE_KIND = ["what about {k}?", "show the {k} instead", "and the {k}?", "how about {k}?", "only the {k}", "just {k}"]
TASK_COLLECT = ["put them in a folder", "collect them into a folder", "make a folder of those", "gather them into an album",
                "save those into a new folder", "organize them in a folder"]
TASK_SHARE = ["share them", "and share them", "share those with a link", "can you share it?", "make a link for them",
              "share that folder"]
TASK_COUNT = ["how many are there?", "how many?", "count them", "how many of those are there?", "what's the count?"]
TASK_DELETE = ["delete them", "remove those", "get rid of them", "trash them"]

# ---------------------------------------------------------------- holdout
# Written after dev/test were tuned on and never used for tuning: fresh
# phrasings and places, to measure how the agent does on people it hasn't met.
HOLDOUT = {
    "cities": [("Venice", "Venice", "IT"), ("Edinburgh", "Edinburgh", "GB"), ("Boston", "Boston", "US"), ("Vancouver", "Vancouver", "CA"),
               ("Melbourne", "Melbourne", "AU"), ("Istanbul", "Istanbul", "TR"), ("Florence", "Florence", "IT"), ("Dublin", "Dublin", "IE")],
    "countries": [("Ireland", "IE"), ("Turkey", "TR"), ("the Netherlands", "NL"), ("Brazil", "BR")],
    "dates": [("last April", month(2026, 4)), ("in October 2025", month(2025, 10)), ("from 2021", year(2021)), ("this past summer", (ym(2026, 6), ym(2026, 9))),
              ("over the last two weeks", (TODAY - timedelta(14), TODAY + timedelta(1))), ("a week ago", (MONDAY - timedelta(7), MONDAY)),
              ("from the start of the year", year(2026)), ("in spring 2025", (ym(2025, 3), ym(2025, 6)))],
    "ptopics": [("sunrise", "sunrise"), ("horse", "horse"), ("pasta", "pasta"), ("museum", "museum"), ("boat", "boat"), ("waterfall", "waterfall")],
    "rtopics": ["salary", "renovation", "quarterly results", "onboarding"],
    "dtopics": ["receipt", "prescription", "ticket", "certificate"],
    "FIND": ["could you dig up my {k} {p}", "I'd love to see the {k} {d}", "bring up {k} {p} {d}", "got any {k} {d}?",
             "search for {k} {p}", "display my {k} {d}"],
    "FIND_TOPIC": ["find every {k} with a {t} in it", "{k} where there's a {t}", "dig up {t} {k} {p}", "show {k} of a {t} {d}"],
    "FIND_REC": ["search my recordings for {t}", "which recording mentions the {t}?", "voice memos where I talk about {t}"],
    "FIND_DOC": ["dig up the {t} {k}", "where did I put the {t} {k}?", "the {k} with my {t}"],
    "COLLECT": ["bundle the {k} {p} into one folder", "can you make an album from the {k} {d}?", "throw all {k} {p} into a new folder"],
    "SHARE": ["send a share link for the {k} {p}", "collect the {k} {d} and share the folder"],
    "COUNT": ["how many {k} have I got {p}?", "tell me how many {k} I took {d}"],
    "DELETE": ["please delete every {k} {d}", "wipe the {k} {p}"],
    "MOVE": ["move all the {k} {d} into a separate folder"],
    "RANK": [("show me the {n} biggest {k}", "largest"), ("find my {n} oldest {k}", "oldest"), ("the {n} newest {k} {d}", "latest")],
    "REFINE_PLACE": ["only in {n}", "now just the ones from {n}", "switch to {n}"],
    "REFINE_DATE": ["now only {d}", "limit it to {d}", "and only those {d}"],
    "REFINE_KIND": ["show me the {k} now", "switch to {k}"],
    "TASK_COLLECT": ["bundle them into a folder", "put all of those in one folder"],
    "TASK_SHARE": ["send me a link to those", "share these please"],
    "TASK_COUNT": ["how many is that?", "total count?"],
    "TASK_DELETE": ["delete all of them"],
    "OUT": ["Can you book me a massage for Friday?", "What's the score of the Giants game?", "Order me an Uber.", "Find cheap flights to Miami."],
    "OUT_FOLLOWUPS": ["For two, please.", "Around 5 pm.", "The first one."],
    "CHAT_OPEN": ["Hey!", "Good evening", "How's it going?", "What's your name?"],
    "CHAT_CLOSE": ["Cheers!", "That's great, thanks a lot.", "Perfect, bye!"],
    "CALLS": ["Who have I been calling the most lately?", "Make a ranking of the people I call."],
    "LIKES": ["Who adores me the most?", "Who misses me the most, and how do you know?"],
}

# ---------------------------------------------------------------- generation


def split(items, test):
    return [x for i, x in enumerate(items) if (i % 4 == 3) == test]


def fmt(template, **kw):
    s = template
    for k, v in kw.items():
        s = s.replace("{" + k + "}", v)
    return " ".join(s.split()).replace(" ?", "?").strip()


class Gen:
    def __init__(self, test, seed, holdout=False):
        self.r = random.Random(seed)
        self.test = test
        if holdout:
            self.init_holdout()
            return
        self.cities = split(CITIES, test)
        self.countries = split(COUNTRIES, test)
        self.dates = split(DATES, test)
        self.ptopics = split(PHOTO_TOPICS, test)
        self.rtopics = split(REC_TOPICS, test)
        self.dtopics = split(DOC_TOPICS, test)
        self.t = {name: split(lst, test) for name, lst in {
            "FIND": FIND, "FIND_TOPIC": FIND_TOPIC, "FIND_REC": FIND_REC, "FIND_DOC": FIND_DOC, "COLLECT": COLLECT,
            "SHARE": SHARE, "COUNT": COUNT, "DELETE": DELETE, "MOVE": MOVE, "RANK": RANK, "REFINE_PLACE": REFINE_PLACE,
            "REFINE_DATE": REFINE_DATE, "REFINE_KIND": REFINE_KIND, "TASK_COLLECT": TASK_COLLECT, "TASK_SHARE": TASK_SHARE,
            "TASK_COUNT": TASK_COUNT, "TASK_DELETE": TASK_DELETE, "OUT": OUT_OF_SCOPE, "OUT_FOLLOWUPS": OUT_FOLLOWUPS,
            "CHAT_OPEN": CHAT_OPEN, "CHAT_CLOSE": CHAT_CLOSE, "CALLS": CALLS, "LIKES": LIKES}.items()}
        self.kinds = {k: split(v, test) or v for k, v in KINDS.items()}

    def init_holdout(self):
        h = HOLDOUT
        self.cities, self.countries, self.dates = h["cities"], h["countries"], h["dates"]
        self.ptopics, self.rtopics, self.dtopics = h["ptopics"], h["rtopics"], h["dtopics"]
        self.t = {k: v for k, v in h.items() if k.isupper()}
        self.kinds = {k: v[-1:] for k, v in KINDS.items()}   # the last surface of each kind

    def pick(self, name):
        return self.r.choice(self.t[name])

    # -- slot fillers: return (phrase, state-delta)
    def place(self):
        if self.r.random() < 0.7:
            s, c, cc = self.r.choice(self.cities)
            return self.r.choice(["in " + s, "from " + s, "in " + s, "taken in " + s]), {"city": c, "country": cc}
        s, cc = self.r.choice(self.countries)
        return self.r.choice(["in ", "from "]) + s, {"city": None, "country": cc}

    def place_name(self):
        if self.r.random() < 0.7:
            s, c, cc = self.r.choice(self.cities)
            return s, {"city": c, "country": cc}
        s, cc = self.r.choice(self.countries)
        return s, {"city": None, "country": cc}

    def date(self):
        s, (a, b) = self.r.choice(self.dates)
        return s, {"date_from": a.isoformat(), "date_to": b.isoformat()}

    def kind(self, k=None):
        k = k or self.r.choice(list(self.kinds))
        return self.r.choice(self.kinds[k]), {"kind": k}

    @staticmethod
    def blank():
        return {"kind": None, "city": None, "country": None, "date_from": None, "date_to": None, "content": [],
                "limit": 0, "oldest": False, "largest": False}

    def filled(self, template, kind=None, want_p=None, want_d=None, topic=None):
        """Fill a template; slots whose placeholder is absent stay unset."""
        st = self.blank()
        k, dk = self.kind(kind)
        st.update(dk)
        p = d = ""
        if "{p}" in template and (want_p if want_p is not None else self.r.random() < 0.6):
            p, dp = self.place(); st.update(dp)
        if "{d}" in template and (want_d if want_d is not None else self.r.random() < 0.6):
            d, dd = self.date(); st.update(dd)
        t = ""
        if topic:
            t, canon = topic
            st["content"] = [canon]
        return fmt(template, k=k, p=p, d=d, t=t), st

    # -- one opening file request
    def opener(self):
        roll = self.r.random()
        if roll < 0.40:
            tpl = self.pick("FIND")
            return (*self.filled(tpl, kind=self.r.choice(["photo", "photo", "video", "screenshot", "photo"])), "FindFiles")
        if roll < 0.60:
            tpl = self.pick("FIND_TOPIC")
            s, canon = self.r.choice(self.ptopics)
            return (*self.filled(tpl, kind="photo", topic=(s, canon)), "FindFiles")
        if roll < 0.70:
            t = self.r.choice(self.rtopics)
            u, st = self.filled(self.pick("FIND_REC"), kind="audio", topic=(t, t), want_p=False)
            st["kind"] = "audio"
            return u, st, "FindFiles"
        if roll < 0.80:
            t = self.r.choice(self.dtopics)
            k = self.r.choice(["pdf", "document", "spreadsheet", "presentation"])
            return (*self.filled(self.pick("FIND_DOC"), kind=k, topic=(t, t), want_p=False), "FindFiles")
        if roll < 0.88:
            tpl, how = self.pick("RANK")
            n = self.r.choice([3, 5, 10])
            k, dk = self.kind(self.r.choice(["photo", "video", "pdf", "document"]))
            st = self.blank(); st.update(dk); st["limit"] = n
            d = ""
            if "{d}" in tpl:
                d, dd = self.date(); st.update(dd)
            if how == "largest": st["largest"] = True
            if how == "oldest": st["oldest"] = True
            return fmt(tpl, n=str(n), k=k, d=d), st, "FindFiles"
        if roll < 0.92:
            return (*self.filled(self.pick("COUNT"), kind="photo"), "CountFiles")
        if roll < 0.95:
            return (*self.filled(self.pick("DELETE"), kind=self.r.choice(["screenshot", "video", "photo"])), "DeleteFiles")
        if roll < 0.975:
            return (*self.filled(self.pick("MOVE"), kind="photo"), "MoveFiles")
        return (*self.filled(self.pick("COLLECT"), kind="photo"), "CollectFiles")

    def dialogue(self, did):
        turns = []

        def add(u, route, intent, st):
            turns.append({"utterance": u, "route": route, "intent": intent, "state": json.loads(json.dumps(st)) if st else None})

        flow = self.r.random()
        state = None
        if flow < 0.12:
            add(self.pick("CHAT_OPEN"), "chat", "Chat", None)
        if flow < 0.08:
            likes = self.r.random() < 0.4
            u = self.pick("LIKES") if likes else self.pick("CALLS")
            share = not likes and self.r.random() < 0.4
            if share:
                u = u.rstrip("?.") + self.r.choice([", and share it", " and share it with a link", ". Share the summary too."])
            add(u, "calls", "WhoLikesMe" if likes else "CallReport", None)
            turns[-1]["share"] = share
            add(self.pick("CHAT_CLOSE"), "chat", "Chat", None)
            return {"dialogue_id": did, "turns": turns}
        if 0.12 <= flow < 0.22:
            add(self.pick("OUT"), "out", "OutOfScope", None)
            for _ in range(self.r.randint(0, 2)):
                add(self.pick("OUT_FOLLOWUPS"), "out", "OutOfScope", None)
            if self.r.random() < 0.5:
                add(self.pick("CHAT_CLOSE"), "chat", "Chat", None)
                return {"dialogue_id": did, "turns": turns}
            # back to files, clearly
            s, c, cc = self.r.choice(self.cities)
            k, dk = self.kind("photo")
            st = self.blank(); st.update(dk); st.update({"city": c, "country": cc})
            add(self.r.choice(["Actually, show me my {k} from {s}.", "Never mind. Find my {k} from {s}.", "OK, then show my {k} taken in {s}."])
                .replace("{k}", k).replace("{s}", s), "files", "FindFiles", st)
            state = st
        if state is None:
            u, state, intent = self.opener()
            add(u, "files", intent, state)
            if intent in ("DeleteFiles", "MoveFiles"):
                add(self.pick("CHAT_CLOSE"), "chat", "Chat", None)
                return {"dialogue_id": did, "turns": turns}

        for _ in range(self.r.randint(0, 3)):
            roll = self.r.random()
            st = dict(state); st["content"] = list(state["content"])
            if roll < 0.2:
                n, dp = self.place_name(); st.update(dp)
                add(fmt(self.pick("REFINE_PLACE"), n=n), "files", "FindFiles", st)
            elif roll < 0.4:
                d, dd = self.date(); st.update(dd)
                add(fmt(self.pick("REFINE_DATE"), d=d), "files", "FindFiles", st)
            elif roll < 0.5 and state["kind"] in ("photo", "video", "screenshot"):
                k, dk = self.kind(self.r.choice([x for x in ("photo", "video", "screenshot") if x != state["kind"]]))
                st.update(dk)
                add(fmt(self.pick("REFINE_KIND"), k=k), "files", "FindFiles", st)
            elif roll < 0.62:
                add(self.pick("TASK_COUNT"), "files", "CountFiles", st)
            elif roll < 0.75:
                add(self.pick("TASK_COLLECT"), "files", "CollectFiles", st)
            elif roll < 0.88:
                add(self.pick("TASK_SHARE"), "files", "ShareFiles", st)
            elif roll < 0.93:
                add(self.pick("CHAT_CLOSE"), "chat", "Chat", None)
                continue
            else:
                # a new, unrelated question resets the state
                u, st, intent = self.opener()
                add(u, "files", intent, st)
            state = st
        if self.r.random() < 0.4:
            add(self.pick("CHAT_CLOSE"), "chat", "Chat", None)
        return {"dialogue_id": did, "turns": turns}


SCHEMA = {
    "service_name": "aindrive_files",
    "description": "Find, organise and share the files on this phone, and report on its call history",
    "slots": [
        {"name": "kind", "description": "File kind", "is_categorical": True,
         "possible_values": ["photo", "video", "audio", "screenshot", "pdf", "document", "spreadsheet", "presentation", "archive"]},
        {"name": "city", "description": "Where a photo was taken (GeoNames name)", "is_categorical": False},
        {"name": "country", "description": "Where a photo was taken (ISO-3166 alpha-2)", "is_categorical": False},
        {"name": "date_from", "description": "Taken/created on or after (YYYY-MM-DD)", "is_categorical": False},
        {"name": "date_to", "description": "Taken/created before (YYYY-MM-DD, exclusive)", "is_categorical": False},
        {"name": "content", "description": "What the photo shows / the recording or document is about", "is_categorical": False},
        {"name": "limit", "description": "How many files to return", "is_categorical": False},
        {"name": "oldest", "description": "Oldest first", "is_categorical": True, "possible_values": [True, False]},
        {"name": "largest", "description": "Largest first", "is_categorical": True, "possible_values": [True, False]},
    ],
    "intents": [
        {"name": "FindFiles", "description": "List files matching the state"},
        {"name": "CollectFiles", "description": "Copy the matching files into a new folder"},
        {"name": "ShareFiles", "description": "Collect the matching files (or the last report) and share a link"},
        {"name": "MoveFiles", "description": "Move the matching files into a new folder"},
        {"name": "DeleteFiles", "description": "Delete the matching files"},
        {"name": "CountFiles", "description": "Say how many files match"},
        {"name": "CallReport", "description": "Rank contacts by calls and summarise what was talked about"},
        {"name": "WhoLikesMe", "description": "Rank contacts by warmth, with evidence from calls"},
        {"name": "Chat", "description": "Greeting, thanks, goodbye — no file access"},
        {"name": "OutOfScope", "description": "A request aindrive cannot serve (booking, weather…) — no file access"},
    ],
}


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "schema.json"), "w") as f:
        json.dump(SCHEMA, f, indent=1)
    for name, test, n, seed in (("dev", False, 1500, 7), ("test", True, 500, 11), ("holdout", True, 300, 23)):
        g = Gen(test, seed, holdout=name == "holdout")
        ds = [g.dialogue(f"{name}_{i:05d}") for i in range(n)]
        with open(os.path.join(OUT, name + ".json"), "w") as f:
            json.dump({"today": TODAY.isoformat(), "dialogues": ds}, f, indent=0, ensure_ascii=False)
        turns = sum(len(d["turns"]) for d in ds)
        print(name, len(ds), "dialogues", turns, "turns")


if __name__ == "__main__":
    main()

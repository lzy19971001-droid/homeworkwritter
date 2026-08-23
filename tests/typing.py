#!/usr/bin/env python3
"""Watch the typing model work, one keystroke at a time, in a terminal.

No server, no browser, no Google account:

    python tests/typing.py                      # type the sample text
    python tests/typing.py --speed 8            # eight times faster
    python tests/typing.py --wpm 40 --typos 4   # slower, more error-prone
    python tests/typing.py --file essay.txt     # your own text
    python tests/typing.py --seed 7             # reproducible run
    python tests/typing.py --trace              # log every keystroke instead
    python tests/typing.py --stats 200          # timing distribution over N runs
    python tests/typing.py --check              # constants still match the JS?

TIMING MODEL
Inter-key intervals follow Dhakal, Feit, Kristensson & Oulasvirta, "Observations
on Typing from 136 Million Keystrokes" (CHI 2018), which logged 136M keystrokes
from 168,960 people:

  - mean inter-key interval 238.66 ms (SD 111.60) at a mean of 51.56 wpm; the
    distribution is right-skewed, so intervals are drawn log-normally
  - the pair of keys matters: hands alternating is quicker than one hand, and
    same-finger pairs are the slowest of all; earlier work puts different-hand
    pairs 30-60 ms ahead of same-hand and about 80 ms ahead of same-finger
  - the left hand trails the right by 7-15 ms
  - error corrections make up 6.3% of all keypresses (2.29 per sentence);
    uncorrected error rates in careful typing run 1.0-3.2%
  - insertion and omission errors outnumber substitutions for skilled typists

This is a port of src/typist.js, not a wrapper — there is no JavaScript runtime
involved. Ports drift, so every tunable number lives in TUNING below and
`--check` reads the JS to confirm they still agree.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import re
import shutil
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "src"
TYPIST_JS = SRC / "typist.js"
KEYBOARD_JS = SRC / "keyboard.js"

SAMPLE = (
    "The Treaty of Versailles was signed in June 1919, formally ending the First World War. "
    "Its terms placed responsibility for the conflict on Germany and required substantial "
    "reparations.\n\n"
    "Historians remain divided on whether those terms made a second war inevitable, or whether "
    "the economic collapse of the following decade mattered more."
)

# Every number the model leans on, in one place so --check can compare them
# against the JavaScript.
TUNING = {
    "REFERENCE_IKI": 238.66,   # ms, the study's mean
    "IKI_CV": 0.47,            # 111.60 / 238.66
    "SHIFT": 90,
    "DIGIT": 50,
    "SPACE": -25,
    "LEFT_HAND": 10,
    "SAME_KEY": 30,
    "SAME_FINGER": 65,
    "SAME_HAND": 15,
    "PAUSE_MULTIPLIER": [0, 1, 2, 3.5],
}

# Fingers run 0 (pinky) to 3 (index); the thumb keys the space bar.
ROWS = {
    "L": {0: "`1qaz~!QAZ", 1: "2wsx@WSX", 2: "3edc#EDC", 3: "45rfvtgb$%RFVTGB"},
    "R": {3: "67yhnujm^&YHNUJM", 2: "8ik,*IK<", 1: "9ol.(OL>",
          0: "0p;/-=[]\\'\")P:?_+{}|\""},
}
KEYS: dict[str, tuple[str, int]] = {}
for _hand, _fingers in ROWS.items():
    for _finger, _chars in _fingers.items():
        for _ch in _chars:
            KEYS.setdefault(_ch, (_hand, _finger))

SHIFTED = set("~!@#$%^&*()_+{}|:\"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ")
DIGITS = set("0123456789")

NEIGHBOURS = {
    "a": "qwsz", "b": "vghn", "c": "xdfv", "d": "serfcx", "e": "wsdr", "f": "drtgvc",
    "g": "ftyhbv", "h": "gyujnb", "i": "ujko", "j": "huikmn", "k": "jiolm", "l": "kop",
    "m": "njk", "n": "bhjm", "o": "iklp", "p": "ol", "q": "wa", "r": "edft",
    "s": "awedxz", "t": "rfgy", "u": "yhji", "v": "cfgb", "w": "qase", "x": "zsdc",
    "y": "tghu", "z": "asx",
}

COMMON = set("""the be to of and a in that have i it for not on with he as you do at
this but his by from they we say her she or an will my one all would there their what so up out
if about who get which go me when make can like time no just him know take people into year your
good some could them see other than then now look only come its over think also back after use
two how our work first well way even new want because any these give day most us is are was were
been has had did does said where while much many such own same each few more""".split())


def key_for(ch: str):
    if ch == " ":
        return ("T", 4)
    if ch in "\n\t":
        return ("R", 0)
    return KEYS.get(ch) or KEYS.get(ch.lower())


def transition_cost(prev: str | None, ch: str) -> float:
    """Milliseconds to add for this particular key-to-key move."""
    cost = 0.0
    if ch in SHIFTED:
        cost += TUNING["SHIFT"]
    if ch in DIGITS:
        cost += TUNING["DIGIT"]

    b = key_for(ch)
    if b is None:
        return cost + 60
    if ch == " ":
        return cost + TUNING["SPACE"]
    if b[0] == "L":
        cost += TUNING["LEFT_HAND"]

    a = key_for(prev) if prev else None
    if a is None:
        return cost
    if prev == ch:
        return cost + TUNING["SAME_KEY"]
    if a == b:
        return cost + TUNING["SAME_FINGER"]
    if a[0] == b[0]:
        return cost + TUNING["SAME_HAND"]
    return cost


def mean_transition_cost(text: str) -> float:
    """Average key-to-key cost, subtracted so the mean lands on the target speed
    while the relative structure of fast and awkward pairs is preserved."""
    total, prev = 0.0, None
    for ch in text:
        total += transition_cost(prev, ch)
        prev = ch
    return total / len(text) if text else 0.0


def word_ease(word: str) -> float:
    bare = re.sub(r"[^A-Za-z0-9'-]", "", word)
    if not bare:
        return 1.0
    lower, ease = bare.lower(), 1.0
    if lower in COMMON:
        ease *= 1.25 if len(bare) <= 4 else 1.15
    if len(bare) >= 14:
        ease *= 0.8
    elif len(bare) >= 10:
        ease *= 0.88
    if re.search(r"\d", bare):
        ease *= 0.85
    if any(ord(c) > 127 for c in word):
        ease *= 0.8
    return min(1.4, max(0.6, ease))


@dataclass
class Stats:
    keystrokes: int = 0
    errors: int = 0
    substitutions: int = 0
    insertions: int = 0
    omissions: int = 0
    transpositions: int = 0
    backspaces: int = 0
    immediate_fixes: int = 0
    delayed_fixes: int = 0
    pauses: int = 0
    longest_pause_ms: float = 0.0
    ikis: list = field(default_factory=list)


class Screen:
    """Redraws the document in place, so backspacing is visible as backspacing."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        if enabled and os.name == "nt":
            try:                                        # ask for ANSI handling
                import ctypes
                k = ctypes.windll.kernel32
                k.SetConsoleMode(k.GetStdHandle(-11), 7)
            except Exception:
                pass

    def start(self):
        if self.enabled:
            sys.stdout.write("\x1b[2J")

    def draw(self, doc: str, status: str):
        if not self.enabled:
            return
        width = max(40, min(shutil.get_terminal_size((100, 30)).columns - 2, 96))
        lines = []
        for para in doc.split("\n"):
            if not para:
                lines.append("")
                continue
            line = ""
            for word in para.split(" "):
                if len(line) + len(word) + 1 > width:
                    lines.append(line)
                    line = word
                else:
                    line = f"{line} {word}" if line else word
            lines.append(line)
        if lines:
            lines[-1] += "█"
        sys.stdout.write("\x1b[H\x1b[J" + "\n".join(lines) + "\n\n\x1b[2m" + status + "\x1b[0m\n")
        sys.stdout.flush()


class Typist:
    """The model from src/typist.js, writing into a string instead of a Doc."""

    def __init__(self, wpm=60, typo_rate=0.02, pause_level=1, time_scale=1.0,
                 rng=None, screen=None, trace=False, quiet=False):
        self.wpm = wpm
        self.typo_rate = typo_rate
        self.pause_level = pause_level
        self.time_scale = max(1.0, time_scale)
        self.rng = rng or random.Random()
        self.screen = screen
        self.trace = trace
        self.quiet = quiet

        self.doc = ""
        self.done = 0
        self.drift = 1.0
        self.keystrokes = 0
        self.stats = Stats()
        self.started = 0.0
        self.total = 0
        self.cost_offset = 0.0   # set per run, to anchor the mean to the target

    # --- timing ------------------------------------------------------------

    def skewed(self, mean: float) -> float:
        """Log-normal draw: most intervals near the mean, a long slow tail."""
        cv = TUNING["IKI_CV"]
        sigma = math.sqrt(math.log(1 + cv * cv))
        mu = math.log(mean) - sigma * sigma / 2
        return math.exp(self.rng.gauss(mu, sigma))

    def envelope(self) -> float:
        warm_up = min(1.0, 0.82 + (self.done / 240) * 0.18)
        fatigue = max(0.88, 1 - (self.done - 3000) / 40000) if self.done > 3000 else 1.0
        return warm_up * fatigue * self.drift

    def base_iki(self, prev, ch, ease) -> float:
        target = 60000 / (self.wpm * 5)
        scale = target / TUNING["REFERENCE_IKI"]
        cost = transition_cost(prev, ch) - self.cost_offset
        return max(18.0, (target + cost * scale) / (ease * self.envelope()))

    def notice_scale(self) -> float:
        return min(2.5, max(0.05, 55 / self.wpm)) * max(0.3, TUNING["PAUSE_MULTIPLIER"][self.pause_level])

    # --- the hands ---------------------------------------------------------

    def sleep(self, ms):
        if not self.quiet:
            time.sleep(max(0.0, ms / self.time_scale) / 1000)

    def event(self, kind, detail=""):
        if self.trace:
            print(f"{time.perf_counter() - self.started:7.2f}s  {kind:<10} {detail}")

    def render(self):
        if self.screen and not self.trace and not self.quiet:
            pct = (self.done / self.total * 100) if self.total else 0
            self.screen.draw(self.doc, f"{self.done}/{self.total} chars  {pct:5.1f}%   "
                                       f"{self.stats.keystrokes} keystrokes   "
                                       f"{self.stats.errors} errors   "
                                       f"{self.stats.backspaces} backspaces")

    def keystroke(self, ch, prev, ease):
        iki = self.skewed(self.base_iki(prev, ch, ease))
        self.doc += ch
        self.keystrokes += 1
        self.stats.keystrokes += 1
        self.stats.ikis.append(iki)
        self.event("key", f"{ch!r} {iki:.0f}ms")
        self.render()
        self.sleep(iki)

    def backspace(self, n):
        for _ in range(n):
            self.doc = self.doc[:-1]
            self.stats.backspaces += 1
            self.render()
            self.sleep(60 + self.rng.random() * 60)
        if n:
            self.event("backspace", f"-{n}")

    def hesitate(self, ms, reason):
        if ms <= 0:
            return
        self.stats.pauses += 1
        self.stats.longest_pause_ms = max(self.stats.longest_pause_ms, ms)
        self.event("pause", f"{reason} {ms:.0f}ms")
        self.render()
        self.sleep(ms)

    # --- the run -----------------------------------------------------------

    def type(self, text: str) -> float:
        self.total = len(text)
        self.cost_offset = mean_transition_cost(text)
        self.started = time.perf_counter()
        if self.screen and not self.trace and not self.quiet:
            self.screen.start()

        pause_m = TUNING["PAUSE_MULTIPLIER"][self.pause_level]
        chars = list(text)
        i = 0
        prev = None
        ease = 1.0
        word_start = 0
        since_thought = 0
        next_thought = self.rng.uniform(90, 260)
        slip = None
        careful_until = 0

        def word_at(pos):
            m = re.match(r"\S+", text[pos:])
            return m.group(0) if m else ""

        while i < len(chars):
            if i == word_start:
                ease = word_ease(word_at(i))
            ch = chars[i]

            if slip and self.keystrokes >= slip["notice_in"]:
                self.hesitate(self.rng.uniform(180, 700) * self.notice_scale(), "spotted-error")
                self.backspace(len(self.doc) - slip["at"])
                self.done, i, prev = slip["done"], slip["i"], slip["prev"]
                if slip["late"]:
                    self.stats.delayed_fixes += 1
                else:
                    self.stats.immediate_fixes += 1
                self.event("fix", f"back to {slip['i']}")
                slip = None
                careful_until = self.keystrokes + self.rng.randint(4, 12)
                self.sleep(self.rng.uniform(80, 260) * self.notice_scale())
                continue

            if slip is None and self.keystrokes >= careful_until and not ch.isspace() \
                    and self.rng.random() < self.typo_rate:
                kind = self.rng.choice(["insert", "insert", "omit", "omit", "substitute", "transpose"])
                notice_in = self.keystrokes + self.rng.randint(1, 6)
                slip = {"at": len(self.doc), "i": i, "prev": prev, "done": self.done,
                        "notice_in": notice_in, "late": notice_in - self.keystrokes > 2}
                self.stats.errors += 1

                if kind == "substitute":
                    self.stats.substitutions += 1
                    near = NEIGHBOURS.get(ch.lower())
                    wrong = self.rng.choice(near) if near else ch
                    if ch.isupper():
                        wrong = wrong.upper()
                    self.event("error", f"substitute {ch!r} -> {wrong!r}")
                    self.keystroke(wrong, prev, ease)
                    prev, i = wrong, i + 1
                    continue
                if kind == "insert":
                    self.stats.insertions += 1
                    near = NEIGHBOURS.get(ch.lower())
                    extra = ch if (self.rng.random() < 0.5 or not near) else self.rng.choice(near)
                    self.event("error", f"insert {extra!r} before {ch!r}")
                    self.keystroke(extra, prev, ease)
                    prev = extra
                    continue
                if kind == "omit":
                    self.stats.omissions += 1
                    self.event("error", f"omit {ch!r}")
                    self.done += 1
                    i += 1
                    continue
                if i + 1 < len(chars) and not chars[i + 1].isspace() and chars[i + 1] != ch:
                    self.stats.transpositions += 1
                    self.event("error", f"transpose {ch!r}{chars[i+1]!r}")
                    self.keystroke(chars[i + 1], prev, ease)
                    self.keystroke(ch, chars[i + 1], ease)
                    prev, i = ch, i + 2
                    continue
                slip = None
                self.stats.errors -= 1

            self.keystroke(ch, prev, ease)
            prev = ch
            self.done += 1
            i += 1
            if ch.isspace():
                word_start = i

            if pause_m > 0 and slip is None:
                before = text[:i]
                if re.search(r"\n\s*\n\s*$", before) and i < len(text) and not text[i].isspace():
                    self.drift = self.rng.uniform(0.85, 1.18)
                    self.hesitate(self.rng.uniform(900, 3200) * pause_m, "paragraph")
                    since_thought = 0
                elif re.search(r"[.!?][\"')\]]?\s$", before):
                    self.hesitate(self.rng.uniform(280, 1300) * pause_m, "sentence")
                    since_thought = 0
                elif ch.isspace() and self.rng.random() < 0.0015:
                    self.hesitate(self.rng.uniform(4000, 14000) * pause_m, "interrupted")
                    since_thought = 0
                elif ch.isspace():
                    since_thought += 1
                    if since_thought > next_thought:
                        since_thought = 0
                        next_thought = self.rng.uniform(90, 260)
                        self.hesitate(self.rng.uniform(400, 2200) * pause_m, "mid-flow")

        if slip:
            self.hesitate(self.rng.uniform(200, 800) * self.notice_scale(), "spotted-error")
            self.backspace(len(self.doc) - slip["at"])
            self.done, prev = slip["done"], slip["prev"]
            self.stats.delayed_fixes += 1
            j = slip["i"]
            while j < len(chars):
                self.keystroke(chars[j], prev, word_ease(word_at(j)))
                prev = chars[j]
                self.done += 1
                j += 1

        self.render()
        return time.perf_counter() - self.started


def check_constants() -> int:
    """Confirm the numbers here still match the ones in the JavaScript."""
    problems = []
    for path in (TYPIST_JS, KEYBOARD_JS):
        if not path.exists():
            print(f"cannot find {path}")
            return 1
    typist = TYPIST_JS.read_text(encoding="utf-8")
    keyboard = KEYBOARD_JS.read_text(encoding="utf-8")

    def want(label, text, pattern, expected):
        m = re.search(pattern, text)
        if not m:
            problems.append(f"{label}: not found (did the code move?)")
        elif m.group(1).strip() != str(expected):
            problems.append(f"{label}: JS has {m.group(1).strip()}, this script has {expected}")

    want("REFERENCE_IKI", typist, r"REFERENCE_IKI\s*=\s*([\d.]+)", TUNING["REFERENCE_IKI"])
    want("IKI_CV", typist, r"cv\s*=\s*([\d.]+)", TUNING["IKI_CV"])
    want("PAUSE_MULTIPLIER", typist, r"PAUSE_MULTIPLIER\s*=\s*\[([^\]]+)\]",
         ", ".join(str(x) for x in TUNING["PAUSE_MULTIPLIER"]))
    want("shift cost", keyboard, r"SHIFTED\.has\(ch\)\)\s*cost\s*\+=\s*(\d+)", TUNING["SHIFT"])
    want("digit cost", keyboard, r"DIGITS\.has\(ch\)\)\s*cost\s*\+=\s*(\d+)", TUNING["DIGIT"])
    want("space cost", keyboard, r"ch === ' '\) return cost - (\d+)", abs(TUNING["SPACE"]))
    want("left-hand cost", keyboard, r"b\.hand === 'L'\) cost \+= (\d+)", TUNING["LEFT_HAND"])
    want("same-key cost", keyboard, r"prev === ch\) return cost \+ (\d+)", TUNING["SAME_KEY"])
    want("same-finger cost", keyboard, r"a\.finger === b\.finger\) return cost \+ (\d+)", TUNING["SAME_FINGER"])
    want("same-hand cost", keyboard, r"a\.hand === b\.hand\) return cost \+ (\d+)", TUNING["SAME_HAND"])

    js_common = re.search(r"const COMMON = new Set\(`([^`]+)`", typist)
    if not js_common:
        problems.append("COMMON: not found in typist.js")
    elif set(js_common.group(1).split()) != COMMON:
        problems.append("COMMON word list differs between typist.js and this script")

    if problems:
        print("Constants have drifted from the JavaScript:\n")
        for p in problems:
            print("  - " + p)
        print("\nUpdate whichever is wrong, then run --check again.")
        return 1
    print("Constants match src/typist.js and src/keyboard.js.")
    return 0


def distribution(runs: int, args) -> int:
    """Type the text many times with no delays and report the timing spread."""
    text = load_text(args)
    ikis, wpms, errors, correct = [], [], [], 0
    for n in range(runs):
        t = Typist(wpm=args.wpm, typo_rate=args.typos / 100, pause_level=args.pauses,
                   rng=random.Random(None if args.seed is None else args.seed + n), quiet=True)
        t.type(text)
        ikis.extend(t.stats.ikis)
        wpms.append((len(text) / 5) / (sum(t.stats.ikis) / 60000))
        errors.append(t.stats.errors)
        correct += 1 if t.doc == text else 0

    ikis.sort()
    print(f"  runs                {runs}")
    print(f"  reconstructed       {correct}/{runs} exactly")
    print(f"  keystroke intervals mean {statistics.mean(ikis):6.1f} ms   "
          f"SD {statistics.pstdev(ikis):5.1f}   median {statistics.median(ikis):6.1f}")
    print(f"                      p10 {ikis[len(ikis)//10]:6.1f}   "
          f"p90 {ikis[len(ikis)*9//10]:6.1f}   max {ikis[-1]:6.1f}")
    print(f"  study reference     mean 238.7 ms   SD 111.6  (at 51.6 wpm)")
    print(f"  typing speed        mean {statistics.mean(wpms):5.1f} wpm excluding pauses "
          f"(target {args.wpm})")
    print(f"  errors per run      mean {statistics.mean(errors):4.1f}")
    return 0 if correct == runs else 1


def load_text(args) -> str:
    if args.file:
        return Path(args.file).read_text(encoding="utf-8").strip()
    if args.text:
        return args.text
    return SAMPLE


def main() -> int:
    ap = argparse.ArgumentParser(description="Watch the typing model, keystroke by keystroke.")
    ap.add_argument("--wpm", type=int, default=60, help="target speed (default 60)")
    ap.add_argument("--typos", type=float, default=2,
                    help="error rate per keystroke, as a percentage (default 2)")
    ap.add_argument("--pauses", type=int, default=1, choices=[0, 1, 2, 3])
    ap.add_argument("--speed", type=float, default=1, help="time scale: 8 means eight times faster")
    ap.add_argument("--text", help="type this instead of the sample")
    ap.add_argument("--file", help="type the contents of this file")
    ap.add_argument("--seed", type=int, help="fix the random seed for a repeatable run")
    ap.add_argument("--trace", action="store_true", help="log every keystroke instead of animating")
    ap.add_argument("--stats", type=int, metavar="N", help="run N times with no delays, report timings")
    ap.add_argument("--check", action="store_true", help="verify constants match the JavaScript")
    args = ap.parse_args()

    if args.check:
        return check_constants()
    if args.stats:
        return distribution(args.stats, args)

    text = load_text(args)
    screen = Screen(enabled=sys.stdout.isatty() and not args.trace)
    typist = Typist(wpm=args.wpm, typo_rate=args.typos / 100, pause_level=args.pauses,
                    time_scale=args.speed, rng=random.Random(args.seed), screen=screen,
                    trace=args.trace)

    elapsed = typist.type(text)
    s = typist.stats
    ok = typist.doc == text
    mean_iki = statistics.mean(s.ikis) if s.ikis else 0

    print()
    print(f"  result            {'matches the source exactly' if ok else 'MISMATCH'}")
    print(f"  characters        {len(typist.doc)} typed, {len(text)} expected")
    print(f"  keystrokes        {s.keystrokes} for {len(text)} characters "
          f"({s.keystrokes / max(1, len(text)):.2f} per character)")
    print(f"  mean interval     {mean_iki:.0f} ms  (study: 238.7 ms at 51.6 wpm)")
    print(f"  wall clock        {elapsed:.1f}s at {args.speed:g}x")
    print(f"  errors            {s.errors} — {s.substitutions} substitution, "
          f"{s.insertions} insertion, {s.omissions} omission, {s.transpositions} transposition")
    print(f"  corrections       {s.backspaces} backspaces, "
          f"{s.immediate_fixes} caught at once, {s.delayed_fixes} caught late")
    print(f"  pauses            {s.pauses}, longest {s.longest_pause_ms:.0f}ms")

    if not ok:
        print("\n  expected:", repr(text[:120]))
        print("  got:     ", repr(typist.doc[:120]))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nstopped")
        sys.exit(130)

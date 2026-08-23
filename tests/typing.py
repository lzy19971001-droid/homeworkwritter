#!/usr/bin/env python3
"""Watch the typing model work, live, in a terminal.

No server, no browser, no Google account:

    python tests/typing.py                      # type the sample text
    python tests/typing.py --speed 8            # eight times faster
    python tests/typing.py --wpm 40 --typos 25  # slow and error-prone
    python tests/typing.py --file essay.txt     # your own text
    python tests/typing.py --seed 7             # reproducible run
    python tests/typing.py --trace              # log every event instead
    python tests/typing.py --check              # constants still match the JS?

This is a port of the model in src/typist.js, not a wrapper around it — there is
no JavaScript runtime involved. That means the two can drift, so every tunable
number lives in TUNING below and `--check` reads src/typist.js to confirm they
still agree. Change one, change the other, and let --check tell you if you
forgot.
"""

from __future__ import annotations

import argparse
import os
import random
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
TYPIST_JS = HERE.parent / "src" / "typist.js"

SAMPLE = (
    "The Treaty of Versailles was signed in June 1919, formally ending the First World War. "
    "Its terms placed responsibility for the conflict on Germany and required substantial "
    "reparations.\n\n"
    "Historians remain divided on whether those terms made a second war inevitable, or whether "
    "the economic collapse of the following decade mattered more. Photosynthesis is unrelated, "
    "but it is a long word worth timing."
)

# Every number the model leans on, in one place so --check can compare them
# against src/typist.js.
TUNING = {
    "CADENCE_MS": 1600,
    "PAUSE_MULTIPLIER": [0, 1, 2, 3.5],
    "DELAYED_TYPO_SHARE": 0.35,
    "HARD_WORD_EASE": 0.72,
    "HARD_WORD_CHANCE": 0.3,
    "INTERRUPT_CHANCE": 0.004,
    "WARMUP_CHARS": 240,
    "FATIGUE_AFTER": 3000,
}

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


def word_ease(word: str) -> float:
    """How quickly a word comes out, as a multiplier on the target speed."""
    bare = re.sub(r"[^A-Za-z0-9'-]", "", word)
    if not bare:
        return 1.0
    lower = bare.lower()
    ease = 1.0

    if lower in COMMON:
        ease *= 1.5 if len(bare) <= 4 else 1.3
    if len(bare) >= 14:
        ease *= 0.62
    elif len(bare) >= 10:
        ease *= 0.74
    elif len(bare) >= 8:
        ease *= 0.86

    if re.search(r"\d", bare):
        ease *= 0.7                                  # figures need looking at
    if re.search(r"[A-Z]{2,}", bare):
        ease *= 0.72                                 # acronyms, shift-key work
    elif bare[:1].isupper() and lower not in COMMON:
        ease *= 0.85                                 # proper nouns
    if any(ord(ch) > 127 for ch in word):
        ease *= 0.7                                  # accents, dashes, curly quotes
    if re.search(r"[()\";:\[\]{}]", word):
        ease *= 0.88                                 # reaching for punctuation

    return min(1.6, max(0.5, ease))


def split_words(text: str) -> list[str]:
    """Words with their surrounding whitespace attached, so spacing survives."""
    return re.findall(r"\s*\S+\s*|\s+", text)


def corrupt(word: str, rng: random.Random) -> str | None:
    """A plausible mistyping: key slip, transposition, doubled or dropped letter."""
    kind = rng.choice(["slip", "slip", "swap", "double", "drop", "caps"])
    i = rng.randrange(1, len(word))

    if kind == "slip":
        near = NEIGHBOURS.get(word[i].lower())
        if not near:
            return None
        hit = rng.choice(near)
        if word[i].isupper():
            hit = hit.upper()
        return word[:i] + hit + word[i + 1:]
    if kind == "swap":
        if i >= len(word) - 1 or word[i] == word[i + 1]:
            return None
        return word[:i] + word[i + 1] + word[i] + word[i + 2:]
    if kind == "double":
        return word[:i] + word[i] + word[i:]
    if kind == "drop":
        return word[:i] + word[i + 1:]
    if kind == "caps":
        first = word[0]
        if first.isupper():
            return first.lower() + word[1:]
        if first.islower():
            return first.upper() + word[1:]
    return None


@dataclass
class Stats:
    bursts: int = 0
    typos: int = 0
    immediate_fixes: int = 0
    delayed_fixes: int = 0
    deletes: int = 0
    pauses: int = 0
    pause_ms: float = 0.0
    longest_pause_ms: float = 0.0
    events: list = field(default_factory=list)


class Screen:
    """Redraws the whole document in place, so deletions are visible as such."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.last = 0
        if enabled and os.name == "nt":
            # Ask the console for ANSI handling; harmless if already on.
            try:
                import ctypes
                k = ctypes.windll.kernel32
                k.SetConsoleMode(k.GetStdHandle(-11), 7)
            except Exception:
                pass

    def draw(self, doc: str, status: str) -> None:
        if not self.enabled:
            return
        width = max(40, min(shutil.get_terminal_size((100, 30)).columns, 100))
        lines: list[str] = []
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
                    line = f"{line} {word}".strip()
            lines.append(line)
        if lines:
            lines[-1] += "█"                      # block cursor
        body = "\n".join(lines)
        sys.stdout.write("\x1b[H\x1b[J" + body + "\n\n\x1b[2m" + status + "\x1b[0m\n")
        sys.stdout.flush()

    def start(self) -> None:
        if self.enabled:
            sys.stdout.write("\x1b[2J")


class Typist:
    """The model from src/typist.js, writing into a string instead of a Doc."""

    def __init__(self, wpm=70, typo_rate=0.08, pause_level=1, time_scale=1.0,
                 rng=None, screen=None, trace=False):
        self.wpm = wpm
        self.typo_rate = typo_rate
        self.pause_level = pause_level
        self.time_scale = max(1.0, time_scale)
        self.rng = rng or random.Random()
        self.screen = screen
        self.trace = trace

        self.doc = ""
        self.done = 0
        self.drift = 1.0
        self.stats = Stats()
        self.started = 0.0

    # --- helpers -----------------------------------------------------------

    def rand(self, a, b):
        return self.rng.uniform(a, b)

    def chance(self, p):
        return self.rng.random() < p

    def cps(self):
        return (self.wpm * 5) / 60

    def stamina(self):
        warm_up = min(1.0, 0.82 + (self.done / TUNING["WARMUP_CHARS"]) * 0.18)
        fatigue = 1.0
        if self.done > TUNING["FATIGUE_AFTER"]:
            fatigue = max(0.88, 1 - (self.done - TUNING["FATIGUE_AFTER"]) / 40000)
        return warm_up * fatigue

    def word_ms(self, text, ease):
        return (len(text) / (self.cps() * ease * self.drift * self.stamina())) * 1000 * self.rand(0.82, 1.22)

    def notice_scale(self):
        return min(2.5, max(0.05, 55 / self.wpm)) * max(0.3, TUNING["PAUSE_MULTIPLIER"][self.pause_level])

    def event(self, kind, detail=""):
        at = time.perf_counter() - self.started
        self.stats.events.append((at, kind, detail))
        if self.trace:
            print(f"{at:7.2f}s  {kind:<8} {detail}")

    def sleep(self, ms):
        time.sleep(max(0.0, ms / self.time_scale) / 1000)

    def status(self):
        pct = (self.done / self.total * 100) if self.total else 0
        return (f"{self.done}/{self.total} chars  {pct:5.1f}%   "
                f"{self.wpm} wpm target   typos {self.stats.typos} "
                f"({self.stats.immediate_fixes} now, {self.stats.delayed_fixes} later)")

    def render(self):
        if self.screen and not self.trace:
            self.screen.draw(self.doc, self.status())

    # --- the two primitive operations --------------------------------------

    def emit(self, chunk, budget_ms, source_len=None):
        self.doc += chunk
        self.done += len(chunk) if source_len is None else source_len
        self.stats.bursts += 1
        self.event("burst", f"+{len(chunk)} {chunk!r}")
        self.render()
        self.sleep(budget_ms)

    def remove_tail(self, n):
        self.doc = self.doc[:-n] if n else self.doc
        self.stats.deletes += 1
        self.event("delete", f"-{n}")
        self.render()

    def hesitate(self, ms, reason):
        if ms <= 0:
            return
        self.stats.pauses += 1
        self.stats.pause_ms += ms
        self.stats.longest_pause_ms = max(self.stats.longest_pause_ms, ms)
        self.event("pause", f"{reason} {int(ms)}ms")
        self.render()
        self.sleep(ms)

    # --- the run -----------------------------------------------------------

    def type(self, text):
        self.total = len(text)
        self.started = time.perf_counter()
        if self.screen and not self.trace:
            self.screen.start()

        pause_m = TUNING["PAUSE_MULTIPLIER"][self.pause_level]
        buffer, budget = "", 0.0
        burst = self.burst_target()
        since_thought, next_thought = 0, self.rand(14, 42)
        fix = None

        def flush():
            nonlocal buffer, budget
            if buffer:
                self.emit(buffer, budget)
                buffer, budget = "", 0.0

        for token in split_words(text):
            core = token.strip()
            ease = word_ease(core)

            # Already carrying a mistake: keep typing, then go back for it.
            if fix:
                buffer += token
                budget += self.word_ms(token, ease)
                fix["source"] += token
                fix["words_left"] -= 1
                if fix["words_left"] <= 0:
                    flush()
                    self.fix_delayed(fix)
                    fix = None
                elif len(buffer) >= burst:
                    flush()
                    burst = self.burst_target()
                continue

            typo_odds = min(self.typo_rate * 4, self.typo_rate / ease)
            wrong = corrupt(core, self.rng) if len(core) >= 4 and self.chance(typo_odds) else None

            if pause_m > 0 and ease <= TUNING["HARD_WORD_EASE"] and self.chance(TUNING["HARD_WORD_CHANCE"]):
                flush()
                self.hesitate(self.rand(250, 900) * pause_m, "hard-word")

            if wrong and wrong != core:
                at = token.index(core)
                lead, trail = token[:at], token[at + len(core):]
                if buffer + lead:
                    self.emit(buffer + lead, budget + self.word_ms(lead, ease))
                    buffer, budget = "", 0.0
                self.stats.typos += 1

                if self.chance(TUNING["DELAYED_TYPO_SHARE"]):
                    # Noticed later: type it wrong and carry on for a word or two.
                    self.event("typo", f"delayed: {core} -> {wrong}")
                    self.emit(wrong, self.word_ms(wrong, ease), len(core) + len(trail))
                    fix = {"doc_start": len(self.doc) - len(wrong),
                           "source": core + trail,
                           "words_left": round(self.rand(1, 3))}
                else:
                    self.event("typo", f"immediate: {core} -> {wrong}")
                    self.mistype_now(wrong, len(core))
                    buffer = core + trail
                    budget = self.word_ms(core + trail, ease)
            else:
                buffer += token
                budget += self.word_ms(token, ease)

            if len(buffer) >= burst:
                flush()
                burst = self.burst_target()

            if pause_m > 0 and not fix:
                if re.search(r"\n\s*\n\s*$", token):
                    flush()
                    self.drift = self.rand(0.85, 1.18)
                    self.hesitate(self.rand(900, 3200) * pause_m, "paragraph")
                elif re.search(r"[.!?][\"')\]]?\s+$", token):
                    flush()
                    self.hesitate(self.rand(280, 1300) * pause_m, "sentence")
                elif self.chance(TUNING["INTERRUPT_CHANCE"]):
                    flush()
                    self.hesitate(self.rand(4000, 14000) * pause_m, "interrupted")
                else:
                    since_thought += 1
                    if since_thought > next_thought:
                        since_thought, next_thought = 0, self.rand(14, 42)
                        self.hesitate(self.rand(400, 2200) * pause_m, "mid-flow")

        if fix:
            flush()
            self.fix_delayed(fix)
        flush()
        self.render()
        return time.perf_counter() - self.started

    def burst_target(self):
        return max(2, round(self.cps() * self.drift * (TUNING["CADENCE_MS"] / 1000) * self.rand(0.7, 1.3)))

    def mistype_now(self, wrong, correct_len):
        self.emit(wrong, self.word_ms(wrong, word_ease(wrong)), correct_len)
        self.hesitate(self.rand(220, 900) * self.notice_scale(), "spotted-typo")
        self.remove_tail(len(wrong))
        self.done -= correct_len
        self.stats.immediate_fixes += 1
        self.sleep(self.rand(90, 320) * self.notice_scale())

    def fix_delayed(self, fix):
        self.hesitate(self.rand(300, 1200) * self.notice_scale(), "spotted-typo-late")
        self.remove_tail(len(self.doc) - fix["doc_start"])
        self.done -= len(fix["source"])
        self.stats.delayed_fixes += 1
        self.sleep(self.rand(120, 400) * self.notice_scale())
        self.emit(fix["source"], self.word_ms(fix["source"], word_ease(fix["source"])))
        self.event("fix", f"retyped {len(fix['source'])}")


def check_constants() -> int:
    """Confirm the numbers here still match the ones in src/typist.js."""
    if not TYPIST_JS.exists():
        print(f"cannot find {TYPIST_JS}")
        return 1
    js = TYPIST_JS.read_text(encoding="utf-8")
    problems = []

    def want(label, pattern, expected):
        m = re.search(pattern, js)
        if not m:
            problems.append(f"{label}: no longer found in typist.js (pattern changed?)")
            return
        found = m.group(1).strip()
        if str(found) != str(expected):
            problems.append(f"{label}: typist.js has {found}, this script has {expected}")

    want("CADENCE_MS", r"CADENCE_MS\s*=\s*(\d+)", TUNING["CADENCE_MS"])
    want("PAUSE_MULTIPLIER", r"PAUSE_MULTIPLIER\s*=\s*\[([^\]]+)\]",
         ", ".join(str(x) for x in TUNING["PAUSE_MULTIPLIER"]))
    want("delayed typo share", r"chance\((0\.\d+)\)\)\s*\{\s*\n\s*//\s*Noticed later", TUNING["DELAYED_TYPO_SHARE"])
    want("hard-word ease", r"ease\s*<=\s*(0\.\d+)", TUNING["HARD_WORD_EASE"])
    # Anchored on the label rather than the surrounding statements, which move around.
    want("interrupt chance", r"chance\((0\.\d+)\)\)[\s\S]{0,160}?'interrupted'", TUNING["INTERRUPT_CHANCE"])

    js_common = re.search(r"const COMMON = new Set\(`([^`]+)`", js)
    if js_common:
        if set(js_common.group(1).split()) != COMMON:
            problems.append("COMMON word list differs between typist.js and this script")
    else:
        problems.append("COMMON: no longer found in typist.js")

    if problems:
        print("Constants have drifted from src/typist.js:\n")
        for p in problems:
            print("  - " + p)
        print("\nUpdate whichever is wrong, then run --check again.")
        return 1
    print("Constants match src/typist.js.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Watch the typing model, live, in a terminal.")
    ap.add_argument("--wpm", type=int, default=70, help="target speed (default 70)")
    ap.add_argument("--typos", type=float, default=8, help="typo rate as a percentage (default 8)")
    ap.add_argument("--pauses", type=int, default=1, choices=[0, 1, 2, 3],
                    help="0 off, 1 normal, 2 long, 3 very long")
    ap.add_argument("--speed", type=float, default=1, help="time scale: 8 means eight times faster")
    ap.add_argument("--text", help="type this instead of the sample")
    ap.add_argument("--file", help="type the contents of this file")
    ap.add_argument("--seed", type=int, help="fix the random seed for a repeatable run")
    ap.add_argument("--trace", action="store_true", help="log every event instead of animating")
    ap.add_argument("--check", action="store_true", help="verify constants match src/typist.js")
    args = ap.parse_args()

    if args.check:
        return check_constants()

    if args.file:
        text = Path(args.file).read_text(encoding="utf-8").strip()
    elif args.text:
        text = args.text
    else:
        text = SAMPLE

    rng = random.Random(args.seed)
    screen = Screen(enabled=sys.stdout.isatty() and not args.trace)
    typist = Typist(wpm=args.wpm, typo_rate=args.typos / 100, pause_level=args.pauses,
                    time_scale=args.speed, rng=rng, screen=screen, trace=args.trace)

    elapsed = typist.type(text)

    ok = typist.doc == text
    modelled_wpm = (len(text) / 5) / (elapsed * args.speed / 60) if elapsed else 0
    print()
    print(f"  result          {'matches the source exactly' if ok else 'MISMATCH'}")
    print(f"  characters      {len(typist.doc)} typed, {len(text)} expected")
    print(f"  wall clock      {elapsed:.1f}s at {args.speed:g}x")
    # Pauses count against the clock, so this sits below the target on purpose.
    print(f"  modelled speed  {modelled_wpm:.0f} wpm including pauses (target {args.wpm})")
    print(f"  bursts          {typist.stats.bursts}")
    print(f"  typos           {typist.stats.typos} "
          f"({typist.stats.immediate_fixes} fixed at once, {typist.stats.delayed_fixes} fixed later)")
    print(f"  deletions       {typist.stats.deletes}")
    print(f"  pauses          {typist.stats.pauses}, longest {typist.stats.longest_pause_ms:.0f}ms")

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

import { transitionCost } from './keyboard.js';

/**
 * The typing model: one keystroke at a time.
 *
 * Timing follows Dhakal, Feit, Kristensson & Oulasvirta, "Observations on Typing
 * from 136 Million Keystrokes" (CHI 2018) — 136M keystrokes from 168,960 people:
 *
 *   - mean inter-key interval 238.66 ms, SD 111.60, at a mean of 51.56 wpm, so
 *     the spread is wide (CV ≈ 0.47) and right-skewed rather than symmetric
 *   - which two keys are involved matters: alternating hands beat same-hand,
 *     same-finger pairs are slowest, the left hand lags the right slightly
 *   - error corrections account for 6.3% of all keypresses (2.29 per sentence);
 *     uncorrected error rates in careful typing run 1.0–3.2%
 *   - insertion and omission errors outnumber substitutions for skilled typists
 *
 * Writing to a Google Doc cannot mean one API request per keystroke — that would
 * be roughly 300 requests a minute at 60 wpm, far past the quota. So keystrokes
 * are simulated individually and *flushed* on a cadence: the timing is per
 * character, the network traffic is per burst. Give a sink that costs nothing
 * (a DOM node, a string) and `granular: true` to see every keystroke land
 * separately, which is what tests/lab.html and tests/typing.py do.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Right-skewed jitter: most intervals near the mean, a long tail of slow ones. */
function skewed(mean, cv = 0.47) {
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const mu = Math.log(mean) - (sigma * sigma) / 2;
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.exp(mu + sigma * normal);
}

export class Stopped extends Error {
  constructor() { super('Stopped by user.'); this.name = 'Stopped'; }
}

/** Rough QWERTY neighbours — the keys a hurried finger actually hits. */
const NEIGHBOURS = {
  a: 'qwsz', b: 'vghn', c: 'xdfv', d: 'serfcx', e: 'wsdr', f: 'drtgvc',
  g: 'ftyhbv', h: 'gyujnb', i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop',
  m: 'njk', n: 'bhjm', o: 'iklp', p: 'ol', q: 'wa', r: 'edft',
  s: 'awedxz', t: 'rfgy', u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc',
  y: 'tghu', z: 'asx',
};

const PAUSE_MULTIPLIER = [0, 1, 2, 3.5];

/** The reference point the study measured: 238.66 ms per key at 51.56 wpm. */
const REFERENCE_IKI = 238.66;

/**
 * The words a touch typist fires off without thinking. Typed as one motion,
 * so they come out above the average speed and rarely carry an error.
 */
const COMMON = new Set(`the be to of and a in that have i it for not on with he as you do at
this but his by from they we say her she or an will my one all would there their what so up out
if about who get which go me when make can like time no just him know take people into year your
good some could them see other than then now look only come its over think also back after use
two how our work first well way even new want because any these give day most us is are was were
been has had did does said where while much many such own same each few more`.split(/\s+/).filter(Boolean));

/**
 * Word familiarity, as a multiplier on the interval. Short common words are
 * produced as a single motor programme; long or unusual ones are assembled.
 * Deliberately gentler than the per-key effects, which the data quantifies.
 */
export function wordEase(word) {
  const bare = word.replace(/[^A-Za-z0-9'-]/g, '');
  if (!bare) return 1;
  const lower = bare.toLowerCase();
  let ease = 1;

  if (COMMON.has(lower)) ease *= bare.length <= 4 ? 1.25 : 1.15;
  if (bare.length >= 14) ease *= 0.8;
  else if (bare.length >= 10) ease *= 0.88;
  if (/\d/.test(bare)) ease *= 0.85;
  for (const ch of word) { if (ch.codePointAt(0) > 127) { ease *= 0.8; break; } }

  return Math.min(1.4, Math.max(0.6, ease));
}

export function splitWords(text) {
  return text.match(/\s*\S+\s*|\s+/g) || [];
}

/**
 * Average key-to-key cost across a piece of text. Subtracting it anchors the
 * mean interval to the requested speed while leaving the relative structure —
 * which pairs are quick, which are awkward — exactly as measured.
 */
export function meanTransitionCost(text) {
  let total = 0;
  let n = 0;
  let prev = null;
  for (const ch of text) {
    total += transitionCost(prev, ch);
    prev = ch;
    n++;
  }
  return n ? total / n : 0;
}

/** Mean interval for one keystroke, before jitter. */
function baseIki(prev, ch, wpm, ease, envelope, offset = 0) {
  const target = 60000 / (wpm * 5);                 // ms per character at this speed
  const scale = target / REFERENCE_IKI;             // shift the study's costs to it
  return Math.max(18, (target + (transitionCost(prev, ch) - offset) * scale) / (ease * envelope));
}

/** Predicted wall-clock duration, so the UI can warn before a 40-minute run. */
export function estimateMs(text, { wpm = 55, typoRate = 0.03, pauseLevel = 1, maxRpm = 45 } = {}) {
  if (!text) return 0;

  let typingMs = 0;
  let prev = null;
  let done = 0;
  const offset = meanTransitionCost(text);
  for (const token of splitWords(text)) {
    const ease = wordEase(token.trim());
    for (const ch of token) {
      // Mirror the run's own speed envelope, or the estimate comes out
      // optimistic: the opening couple of hundred characters are slower.
      const warmUp = Math.min(1, 0.82 + (done / 240) * 0.18);
      const fatigue = done > 3000 ? Math.max(0.88, 1 - (done - 3000) / 40000) : 1;
      typingMs += baseIki(prev, ch, wpm, ease, warmUp * fatigue, offset);
      prev = ch;
      done++;
    }
  }

  const m = PAUSE_MULTIPLIER[pauseLevel] ?? 1;
  const sentences = (text.match(/[.!?]\s/g) || []).length;
  const paragraphs = (text.match(/\n/g) || []).length;
  const words = (text.match(/\S+/g) || []).length;
  const pauseMs = m * (sentences * 800 + paragraphs * 2000 + (words / 25) * 1400);
  const correctionMs = words * typoRate * 900;

  const requests = Math.ceil(typingMs / 1600) + Math.round(words * typoRate) * 2;
  const quotaFloorMs = (requests / maxRpm) * 60000;

  return Math.max(typingMs + pauseMs + correctionMs + requests * 260, quotaFloorMs);
}

export function formatDuration(ms) {
  if (!ms) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} sec`;
  return `${Math.floor(m / 60)} hr ${m % 60} min`;
}

export class HumanTypist {
  /**
   * @param {object} opts
   * @param {object} opts.sink        append(text) / remove(start, end) / length()
   * @param {number} opts.wpm         target typing speed
   * @param {number} opts.typoRate    errors per keystroke, before correction
   * @param {number} opts.pauseLevel  0 none ... 3 very hesitant
   * @param {boolean} [opts.granular] send every keystroke separately (local sinks)
   * @param {number} [opts.flushMs]   how much typing time to buffer per request
   * @param {number} [opts.timeScale] divides every wait; for local testing only
   */
  constructor({
    sink, wpm = 55, typoRate = 0.03, pauseLevel = 1, granular = false,
    flushMs = 1600, timeScale = 1, onProgress = () => {}, onEvent = () => {},
  }) {
    if (!sink) throw new Error('HumanTypist needs a sink: { append, remove, length }.');
    this.sink = sink;
    this.wpm = wpm;
    this.typoRate = typoRate;
    this.pauseLevel = pauseLevel;
    this.granular = granular;
    this.flushMs = granular ? 0 : flushMs;
    this.timeScale = Math.max(1, timeScale);
    this.onProgress = onProgress;
    this.onEvent = onEvent;

    this.paused = false;
    this.stopped = false;
    this.requests = 0;
    this.keystrokes = 0;
    this.done = 0;          // source characters correctly in place
    this.docChars = 0;      // characters currently in the document
    this.total = 0;
    this.startedAt = 0;
    this.drift = 1;
    this.text = '';

    this.pending = '';      // typed but not yet sent to the sink
    this.pendingMs = 0;
    this.costOffset = 0;    // set per run, to anchor the mean to the target speed
    this.skipped = 0;       // negligible waits elided since the last yield

    this.stats = {
      keystrokes: 0, bursts: 0, errors: 0, substitutions: 0, insertions: 0,
      omissions: 0, transpositions: 0, backspaces: 0, immediateFixes: 0,
      delayedFixes: 0, pauses: 0, pauseMs: 0, longestPauseMs: 0,
    };
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  stop() { this.stopped = true; this.paused = false; }

  get remainingText() { return this.text ? this.text.slice(this.done) : ''; }

  async gate() {
    if (this.stopped) throw new Stopped();
    while (this.paused) {
      await sleep(150);
      if (this.stopped) throw new Stopped();
    }
  }

  async wait(ms) {
    const scaled = ms / this.timeScale;
    // Per keystroke there is now one wait per character, and every await costs a
    // macrotask — clamped to ~4 ms in a foreground tab and a full second in a
    // background one. Below a few milliseconds, just carry on, yielding
    // periodically so the page still repaints and Stop still lands.
    if (scaled < 3) {
      if (++this.skipped % 64 === 0) await sleep(0);
      if (this.stopped) throw new Stopped();
      return;
    }
    const until = Date.now() + scaled;
    for (;;) {
      await this.gate();
      const left = until - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(left, 200));
    }
  }

  report(state) {
    const elapsed = Date.now() - this.startedAt;
    const frac = this.total ? this.done / this.total : 0;
    const etaMs = frac > 0.01 ? Math.max(0, elapsed / frac - elapsed) : null;
    this.onProgress({ done: this.done, total: this.total, requests: this.requests, etaMs, state });
  }

  /** Warm-up over the first stretch, mild fatigue on a long piece. */
  envelope() {
    const warmUp = Math.min(1, 0.82 + (this.done / 240) * 0.18);
    const fatigue = this.done > 3000 ? Math.max(0.88, 1 - (this.done - 3000) / 40000) : 1;
    return warmUp * fatigue * this.drift;
  }

  /* --- the two things hands actually do ---------------------------------- */

  /** Press one key. Time is charged per keystroke; bytes go out per burst. */
  async keystroke(ch, prev, ease) {
    await this.gate();
    const mean = baseIki(prev, ch, this.wpm, ease, this.envelope(), this.costOffset);
    const iki = skewed(mean);

    this.pending += ch;
    this.pendingMs += iki;
    this.keystrokes++;
    this.stats.keystrokes++;
    this.onEvent({ type: 'key', ch, ms: Math.round(iki) });

    if (this.pendingMs >= this.flushMs) await this.flush();
    else await this.wait(iki);
  }

  /** Send whatever has been typed but not yet written. */
  async flush() {
    if (!this.pending) return;
    const chunk = this.pending;
    const owed = this.pendingMs;
    this.pending = '';
    this.pendingMs = 0;

    const started = performance.now();
    await this.sink.append(chunk);
    this.requests++;
    this.stats.bursts++;
    this.docChars += chunk.length;
    this.onEvent({ type: 'burst', chars: chunk.length, text: chunk, ms: Math.round(owed) });

    const spent = performance.now() - started;
    if (owed > spent) await this.wait(owed - spent);
    this.report('typing');
  }

  /** Hold backspace until `n` characters are gone. */
  async backspace(n) {
    if (n <= 0) return;
    await this.flush();
    const perKey = 60 + rand(0, 60);

    if (this.granular) {
      for (let i = 0; i < n; i++) {
        await this.gate();
        await this.sink.remove(this.docChars, this.docChars + 1);
        this.docChars--;
        this.requests++;
        this.stats.backspaces++;
        this.onEvent({ type: 'backspace', chars: 1 });
        await this.wait(perKey);
      }
      return;
    }

    const end = this.docChars + 1;
    try {
      await this.sink.remove(end - n, end);
    } catch {
      this.docChars = await this.sink.length();
      const resynced = this.docChars + 1;
      await this.sink.remove(Math.max(1, resynced - n), resynced);
    }
    this.docChars -= n;
    this.requests++;
    this.stats.backspaces += n;
    this.onEvent({ type: 'backspace', chars: n });
    await this.wait(perKey * n);
  }

  async hesitate(ms, reason) {
    if (ms <= 0) return;
    await this.flush();
    this.stats.pauses++;
    this.stats.pauseMs += ms;
    this.stats.longestPauseMs = Math.max(this.stats.longestPauseMs, ms);
    this.onEvent({ type: 'pause', reason, ms: Math.round(ms) });
    this.report('thinking');
    await this.wait(ms);
  }

  /* --- the run ------------------------------------------------------------ */

  async type(text) {
    this.text = text;
    this.total = text.length;
    this.costOffset = meanTransitionCost(text);
    this.startedAt = Date.now();
    this.docChars = await this.sink.length();
    this.report('typing');

    const pauseM = PAUSE_MULTIPLIER[this.pauseLevel] ?? 1;
    const chars = [...text];

    let i = 0;           // position in the source
    let prev = null;     // previously struck key
    let ease = 1;        // familiarity of the word being typed
    let wordStart = 0;
    let sinceThought = 0;
    let nextThought = rand(90, 260);          // in keystrokes, not words
    // A mistake that has been made but not yet noticed.
    let slip = null;     // { at, noticeIn }
    // Nobody fumbles the same word twice in a row: after a correction the hands
    // slow down and get it right. This also stops a high error rate from
    // rewinding onto the same character forever.
    let carefulUntil = 0;

    const wordAt = (pos) => {
      const m = /^\S+/.exec(text.slice(pos));
      return m ? m[0] : '';
    };

    while (i < chars.length) {
      await this.gate();

      if (i === wordStart) ease = wordEase(wordAt(i));

      const ch = chars[i];

      // Has the slip been noticed yet?
      if (slip && this.keystrokes >= slip.noticeIn) {
        await this.hesitate(rand(180, 700) * this.noticeScale(), 'spotted-error');
        const wrongChars = this.docChars + this.pending.length - slip.at;
        await this.backspace(wrongChars);
        this.done = slip.done;
        i = slip.i;
        prev = slip.prev;
        this.stats[slip.late ? 'delayedFixes' : 'immediateFixes']++;
        this.onEvent({ type: 'fix', chars: wrongChars, late: slip.late });
        slip = null;
        carefulUntil = this.keystrokes + Math.floor(rand(4, 12));
        await this.wait(rand(80, 260) * this.noticeScale());
        continue;
      }

      // Make a mistake? Insertions and omissions outnumber substitutions.
      if (!slip && this.keystrokes >= carefulUntil && /\S/.test(ch) && chance(this.typoRate)) {
        const kind = pick(['insert', 'insert', 'omit', 'omit', 'substitute', 'transpose']);
        const noticeIn = this.keystrokes + Math.floor(rand(1, 7));
        slip = { at: this.docChars + this.pending.length, i, prev, done: this.done,
                 noticeIn, late: false };
        slip.late = noticeIn - this.keystrokes > 2;
        this.stats.errors++;

        if (kind === 'substitute') {
          this.stats.substitutions++;
          const near = NEIGHBOURS[ch.toLowerCase()];
          const wrong = near ? pick(near.split('')) : ch;
          this.onEvent({ type: 'error', kind, expected: ch, typed: wrong });
          await this.keystroke(ch === ch.toUpperCase() && near ? wrong.toUpperCase() : wrong, prev, ease);
          prev = wrong;
          i++;
          continue;
        }
        if (kind === 'insert') {
          this.stats.insertions++;
          const near = NEIGHBOURS[ch.toLowerCase()];
          const extra = chance(0.5) || !near ? ch : pick(near.split(''));
          this.onEvent({ type: 'error', kind, expected: ch, typed: extra + ch });
          await this.keystroke(extra, prev, ease);
          prev = extra;
          continue;                       // the real character still has to be typed
        }
        if (kind === 'omit') {
          this.stats.omissions++;
          this.onEvent({ type: 'error', kind, expected: ch, typed: '' });
          this.done++;                    // the source advances; the document does not
          i++;
          continue;
        }
        // transpose: type the next character first
        if (i + 1 < chars.length && /\S/.test(chars[i + 1]) && chars[i + 1] !== ch) {
          this.stats.transpositions++;
          this.onEvent({ type: 'error', kind, expected: ch + chars[i + 1], typed: chars[i + 1] + ch });
          await this.keystroke(chars[i + 1], prev, ease);
          await this.keystroke(ch, chars[i + 1], ease);
          prev = ch;
          i += 2;
          continue;
        }
        slip = null;
        this.stats.errors--;
      }

      await this.keystroke(ch, prev, ease);
      prev = ch;
      this.done++;
      i++;

      if (/\s/.test(ch)) wordStart = i;

      // Hesitations. Writing research treats pauses over a couple of seconds as
      // planning rather than motor delay; these sit either side of that line.
      if (pauseM > 0 && !slip) {
        const before = text.slice(0, i);
        if (/\n\s*\n\s*$/.test(before) && /\S/.test(text.slice(i, i + 1))) {
          this.drift = rand(0.85, 1.18);
          await this.hesitate(rand(900, 3200) * pauseM, 'paragraph');
          sinceThought = 0;
        } else if (/[.!?]["')\]]?\s$/.test(before)) {
          await this.hesitate(rand(280, 1300) * pauseM, 'sentence');
          sinceThought = 0;
        } else if (/\s$/.test(ch) && chance(0.0015)) {
          await this.hesitate(rand(4000, 14000) * pauseM, 'interrupted');
          sinceThought = 0;
        } else if (/\s$/.test(ch) && ++sinceThought > nextThought) {
          sinceThought = 0;
          nextThought = rand(90, 260);
          await this.hesitate(rand(400, 2200) * pauseM, 'mid-flow');
        } else if (/\s$/.test(ch)) {
          sinceThought++;
        }
      }
    }

    // Anything still wrong at the end still gets fixed.
    if (slip) {
      const wrongChars = this.docChars + this.pending.length - slip.at;
      await this.hesitate(rand(200, 800) * this.noticeScale(), 'spotted-error');
      await this.backspace(wrongChars);
      this.done = slip.done;
      this.stats.delayedFixes++;
      let j = slip.i;
      let p = slip.prev;
      while (j < chars.length) {
        await this.keystroke(chars[j], p, wordEase(wordAt(j)));
        p = chars[j];
        this.done++;
        j++;
      }
    }

    await this.flush();
    this.report('done');
    const ms = Date.now() - this.startedAt;
    return {
      requests: this.requests,
      chars: this.done,
      ms,
      effectiveWpm: ms ? Math.round((this.done / 5) / (ms / 60000)) : 0,
      meanIki: this.stats.keystrokes ? Math.round(ms / this.stats.keystrokes) : 0,
      ...this.stats,
    };
  }

  /** How long it takes to spot a mistake: faster typists catch them sooner. */
  noticeScale() {
    return Math.min(2.5, Math.max(0.05, 55 / this.wpm))
      * Math.max(0.3, PAUSE_MULTIPLIER[this.pauseLevel] ?? 1);
  }
}

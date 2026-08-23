import { appendText, deleteRange, getBodyLength } from './gdocs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class Stopped extends Error {
  constructor() { super('Stopped by user.'); this.name = 'Stopped'; }
}

/**
 * Where the typing goes. The app passes the Google Doc sink below; the landing
 * page and the lab pass ones backed by a DOM node, so what you watch there is
 * this exact engine rather than a lookalike animation.
 *
 * `length` returns the character count; positions follow the Docs API, where
 * the first character sits at index 1.
 */
export const docsSink = (documentId) => ({
  append: (text) => appendText(documentId, text),
  remove: (startIndex, endIndex) => deleteRange(documentId, startIndex, endIndex),
  length: () => getBodyLength(documentId),
});

/** Rough QWERTY neighbours — the keys a hurried finger actually hits. */
const NEIGHBOURS = {
  a: 'qwsz', b: 'vghn', c: 'xdfv', d: 'serfcx', e: 'wsdr', f: 'drtgvc',
  g: 'ftyhbv', h: 'gyujnb', i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop',
  m: 'njk', n: 'bhjm', o: 'iklp', p: 'ol', q: 'wa', r: 'edft',
  s: 'awedxz', t: 'rfgy', u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc',
  y: 'tghu', z: 'asx',
};

const PAUSE_MULTIPLIER = [0, 1, 2, 3.5];

/**
 * The words a touch typist fires off without thinking. Typed as one motion,
 * so they come out well above the average speed and rarely carry a typo.
 */
const COMMON = new Set(`the be to of and a in that have i it for not on with he as you do at
this but his by from they we say her she or an will my one all would there their what so up out
if about who get which go me when make can like time no just him know take people into year your
good some could them see other than then now look only come its over think also back after use
two how our work first well way even new want because any these give day most us is are was were
been has had did does said where while much many such own same each few more`.split(/\s+/).filter(Boolean));

/**
 * How quickly a given word comes out, as a multiplier on the target speed.
 * Familiar short words run fast; long, numeric, capitalised or otherwise
 * awkward ones drag. Everything else sits near 1.
 */
export function wordEase(word) {
  const bare = word.replace(/[^A-Za-z0-9'-]/g, '');
  if (!bare) return 1;
  const lower = bare.toLowerCase();
  let ease = 1;

  if (COMMON.has(lower)) ease *= bare.length <= 4 ? 1.5 : 1.3;
  if (bare.length >= 14) ease *= 0.62;
  else if (bare.length >= 10) ease *= 0.74;
  else if (bare.length >= 8) ease *= 0.86;

  if (/\d/.test(bare)) ease *= 0.7;                                  // figures need looking at
  if (/[A-Z]{2,}/.test(bare)) ease *= 0.72;                          // acronyms, shift-key work
  else if (/^[A-Z]/.test(bare) && !COMMON.has(lower)) ease *= 0.85;  // proper nouns
  // Accented letters, dashes and curly quotes: awkward keys, or none at all.
  for (const ch of word) { if (ch.codePointAt(0) > 127) { ease *= 0.7; break; } }
  if (/[()";:[\]{}]/.test(word)) ease *= 0.88;                       // reaching for punctuation

  return Math.min(1.6, Math.max(0.5, ease));
}

/** Characters per second implied by a words-per-minute figure (5 chars is 1 word). */
const cps = (wpm) => (wpm * 5) / 60;

/** How much typing time we let build up before sending one API request. */
const CADENCE_MS = 1600;
/** Typical round-trip cost of one Docs API call, used only for estimates. */
const REQUEST_OVERHEAD_MS = 260;

export function splitWords(text) {
  // Keep surrounding whitespace attached to each word so spacing survives intact.
  return text.match(/\s*\S+\s*|\s+/g) || [];
}

/** Predicted wall-clock duration, so the UI can warn before a 40-minute run. */
export function estimateMs(text, { wpm = 55, typoRate = 0.03, pauseLevel = 1, maxRpm = 45 } = {}) {
  if (!text) return 0;
  const speed = cps(wpm);
  // Weight each word by its own ease, so a page of short familiar words is not
  // estimated at the same rate as a page of technical vocabulary.
  let weighted = 0;
  for (const token of splitWords(text)) weighted += token.length / wordEase(token.trim());
  const typingMs = (weighted / speed) * 1000;

  const m = PAUSE_MULTIPLIER[pauseLevel] ?? 1;
  const sentences = (text.match(/[.!?]\s/g) || []).length;
  const paragraphs = (text.match(/\n/g) || []).length;
  const words = (text.match(/\S+/g) || []).length;
  const pauseMs = m * (sentences * 800 + paragraphs * 2000 + (words / 25) * 1400);

  const burst = Math.max(2, Math.round(speed * (CADENCE_MS / 1000)));
  const requests = Math.ceil(text.length / burst) + Math.round(words * typoRate) * 2;
  const overheadMs = requests * REQUEST_OVERHEAD_MS;
  const quotaFloorMs = (requests / maxRpm) * 60000;

  return Math.max(typingMs + pauseMs + overheadMs, quotaFloorMs);
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
   * @param {string} [opts.documentId]  target Google Doc (or pass a sink)
   * @param {object} [opts.sink]        append / remove / length
   * @param {number} opts.wpm           target typing speed
   * @param {number} opts.typoRate      probability a word is mistyped first
   * @param {number} opts.pauseLevel    0 none ... 3 very hesitant
   * @param {number} [opts.timeScale]   divides every wait; for local testing only
   * @param {function} [opts.onProgress] ({done, total, requests, etaMs, state})
   * @param {function} [opts.onEvent]   trace hook: ({type, ...}) for the lab
   */
  constructor({
    documentId = null, sink = null, wpm = 55, typoRate = 0.03, pauseLevel = 1,
    timeScale = 1, onProgress = () => {}, onEvent = () => {}, onLog = () => {},
  }) {
    this.documentId = documentId;
    this.sink = sink || docsSink(documentId);
    this.wpm = wpm;
    this.typoRate = typoRate;
    this.pauseLevel = pauseLevel;
    this.timeScale = Math.max(1, timeScale);
    this.onProgress = onProgress;
    this.onEvent = onEvent;
    this.onLog = onLog;

    this.paused = false;
    this.stopped = false;
    this.requests = 0;
    this.done = 0;          // source characters committed to the document
    this.docChars = 0;      // characters currently in the document body
    this.total = 0;
    this.startedAt = 0;
    this.drift = 1;         // per-paragraph speed wobble
    this.text = '';

    this.stats = { bursts: 0, typos: 0, immediateFixes: 0, delayedFixes: 0, deletes: 0, pauses: 0, pauseMs: 0, longestPauseMs: 0 };
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

  /** Sleep in slices so Pause and Stop stay responsive during long pauses. */
  async wait(ms) {
    const scaled = ms / this.timeScale;
    const until = Date.now() + scaled;
    for (;;) {
      await this.gate();
      const left = until - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(left, 200));
    }
  }

  /** A deliberate pause, recorded so the lab can show the rhythm. */
  async hesitate(ms, reason) {
    if (ms <= 0) return;
    this.stats.pauses++;
    this.stats.pauseMs += ms;
    this.stats.longestPauseMs = Math.max(this.stats.longestPauseMs, ms);
    this.onEvent({ type: 'pause', reason, ms: Math.round(ms) });
    this.report('thinking');
    await this.wait(ms);
  }

  report(state) {
    const elapsed = Date.now() - this.startedAt;
    const frac = this.total ? this.done / this.total : 0;
    const etaMs = frac > 0.01 ? Math.max(0, elapsed / frac - elapsed) : null;
    this.onProgress({ done: this.done, total: this.total, requests: this.requests, etaMs, state });
  }

  /**
   * Speed envelope over the whole run: hands warm up over the first stretch,
   * then tire slightly on a long piece. Multiplies the per-word ease.
   */
  stamina() {
    const warmUp = Math.min(1, 0.82 + (this.done / 240) * 0.18);
    const fatigue = this.done > 3000 ? Math.max(0.88, 1 - (this.done - 3000) / 40000) : 1;
    return warmUp * fatigue;
  }

  /** How long one word should take, given how awkward it is to type. */
  wordMs(text, ease) {
    return (text.length / (cps(this.wpm) * ease * this.drift * this.stamina())) * 1000 * rand(0.82, 1.22);
  }

  /**
   * One API call's worth of characters. `sourceLen` is how much of the source
   * this represents — it differs from `chunk.length` while a misspelling is
   * standing in for the real word.
   */
  async emit(chunk, budgetMs, sourceLen = chunk.length) {
    await this.gate();
    const started = performance.now();
    await this.sink.append(chunk);
    this.requests++;
    this.stats.bursts++;
    this.docChars += chunk.length;
    this.done += sourceLen;
    this.onEvent({ type: 'burst', chars: chunk.length, text: chunk, ms: Math.round(budgetMs) });

    const spent = performance.now() - started;
    if (budgetMs > spent) await this.wait(budgetMs - spent);
    this.report('typing');
  }

  /** Remove the last `n` characters, re-syncing from the API if the index drifted. */
  async removeTail(n) {
    const end = this.docChars + 1;
    try {
      await this.sink.remove(end - n, end);
    } catch {
      this.docChars = await this.sink.length();
      const resynced = this.docChars + 1;
      await this.sink.remove(Math.max(1, resynced - n), resynced);
    }
    this.requests++;
    this.stats.deletes++;
    this.docChars -= n;
    this.onEvent({ type: 'delete', chars: n });
  }

  /** How long it takes to spot a mistake: faster typists catch them sooner. */
  noticeScale() {
    return Math.min(2.5, Math.max(0.05, 55 / this.wpm))
      * Math.max(0.3, PAUSE_MULTIPLIER[this.pauseLevel] ?? 1);
  }

  /** Type a wrong spelling, notice it straight away, rub it out, carry on. */
  async mistypeNow(wrong, correctLen) {
    await this.emit(wrong, this.wordMs(wrong, wordEase(wrong)), correctLen);
    await this.hesitate(rand(220, 900) * this.noticeScale(), 'spotted-typo');
    await this.removeTail(wrong.length);
    this.done -= correctLen;
    this.stats.immediateFixes++;
    await this.wait(rand(90, 320) * this.noticeScale());
  }

  /**
   * The other way people fix things: carry on for a word or two, notice the
   * mistake sitting back there, then wipe out everything since and retype it.
   */
  async fixDelayed(fix) {
    await this.hesitate(rand(300, 1200) * this.noticeScale(), 'spotted-typo-late');
    await this.removeTail(this.docChars - fix.docStart);
    this.done -= fix.source.length;
    this.stats.delayedFixes++;
    await this.wait(rand(120, 400) * this.noticeScale());
    await this.emit(fix.source, this.wordMs(fix.source, wordEase(fix.source)));
    this.onEvent({ type: 'fix', mode: 'delayed', chars: fix.source.length });
  }

  async type(text) {
    this.text = text;
    this.total = text.length;
    this.startedAt = Date.now();
    this.docChars = await this.sink.length();
    this.report('typing');

    const words = splitWords(text);
    const pauseM = PAUSE_MULTIPLIER[this.pauseLevel] ?? 1;
    const burstTarget = () =>
      Math.max(2, Math.round(cps(this.wpm) * this.drift * (CADENCE_MS / 1000) * rand(0.7, 1.3)));

    let buffer = '';
    let budget = 0;               // ms the words now in the buffer should take
    let burst = burstTarget();
    let sinceThought = 0;
    let nextThought = rand(14, 42);
    let fix = null;               // a mistake left standing, to be fixed shortly

    const flush = async () => {
      if (!buffer) return;
      await this.emit(buffer, budget);
      buffer = '';
      budget = 0;
    };

    for (const token of words) {
      await this.gate();

      const core = token.trim();
      const ease = wordEase(core);

      // Already carrying a mistake: keep typing, then go back for it.
      if (fix) {
        buffer += token;
        budget += this.wordMs(token, ease);
        fix.source += token;
        if (--fix.wordsLeft <= 0) {
          await flush();
          await this.fixDelayed(fix);
          fix = null;
        } else if (buffer.length >= burst) {
          await flush();
          burst = burstTarget();
        }
        continue;
      }

      // A word that is slower to type is also likelier to come out wrong.
      const typoOdds = Math.min(this.typoRate * 4, this.typoRate / ease);
      const wrong = core.length >= 4 && chance(typoOdds) ? corrupt(core) : null;

      // Awkward words get a beat of hesitation before the hands start moving.
      if (pauseM > 0 && ease <= 0.72 && chance(0.3)) {
        await flush();
        await this.hesitate(rand(250, 900) * pauseM, 'hard-word');
      }

      if (wrong && wrong !== core) {
        const at = token.indexOf(core);
        const lead = token.slice(0, at);
        const trail = token.slice(at + core.length);
        if (buffer + lead) {
          await this.emit(buffer + lead, budget + this.wordMs(lead, ease));
          buffer = '';
          budget = 0;
        }
        this.stats.typos++;

        if (chance(0.35)) {
          // Noticed later: type it wrong and keep going for a word or two.
          this.onEvent({ type: 'typo', mode: 'delayed', wrong, right: core });
          // Credit the whole token, trailing space included: the fix deletes and
          // retypes the entire span, so the two must account for the same text.
          await this.emit(wrong, this.wordMs(wrong, ease), core.length + trail.length);
          fix = { docStart: this.docChars - wrong.length, source: core + trail, wordsLeft: Math.round(rand(1, 3)) };
        } else {
          this.onEvent({ type: 'typo', mode: 'immediate', wrong, right: core });
          await this.mistypeNow(wrong, core.length);
          buffer = core + trail;
          budget = this.wordMs(core + trail, ease);
        }
      } else {
        buffer += token;
        budget += this.wordMs(token, ease);
      }

      if (buffer.length >= burst) {
        await flush();
        burst = burstTarget();
      }

      // Hesitations: at the end of a sentence, between paragraphs, and now and
      // then mid-flow, the way anyone actually writing something stops to think.
      if (pauseM > 0 && !fix) {
        if (/\n\s*\n\s*$/.test(token)) {
          await flush();
          this.drift = rand(0.85, 1.18);
          await this.hesitate(rand(900, 3200) * pauseM, 'paragraph');
        } else if (/[.!?]["')\]]?\s+$/.test(token)) {
          await flush();
          await this.hesitate(rand(280, 1300) * pauseM, 'sentence');
        } else if (chance(0.004)) {
          await flush();
          await this.hesitate(rand(4000, 14000) * pauseM, 'interrupted');
        } else if (++sinceThought > nextThought) {
          sinceThought = 0;
          nextThought = rand(14, 42);
          await this.hesitate(rand(400, 2200) * pauseM, 'mid-flow');
        }
      }
    }

    // A mistake still standing at the end still gets fixed.
    if (fix) {
      await flush();
      await this.fixDelayed(fix);
      fix = null;
    }
    await flush();

    this.report('done');
    const ms = Date.now() - this.startedAt;
    return {
      requests: this.requests,
      chars: this.done,
      ms,
      effectiveWpm: ms ? Math.round((this.done / 5) / (ms / 60000)) : 0,
      ...this.stats,
    };
  }
}

/** Produce a plausible mistyping of a word. */
function corrupt(word) {
  const kind = pick(['slip', 'slip', 'swap', 'double', 'drop', 'caps']);
  const i = 1 + Math.floor(Math.random() * (word.length - 1));

  switch (kind) {
    case 'slip': {
      const ch = word[i].toLowerCase();
      const near = NEIGHBOURS[ch];
      if (!near) return null;
      let hit = pick(near.split(''));
      if (word[i] !== ch) hit = hit.toUpperCase();
      return word.slice(0, i) + hit + word.slice(i + 1);
    }
    case 'swap': {
      if (i >= word.length - 1 || word[i] === word[i + 1]) return null;
      return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
    }
    case 'double':
      return word.slice(0, i) + word[i] + word.slice(i);
    case 'drop':
      return word.slice(0, i) + word.slice(i + 1);
    case 'caps': {
      // Missed the shift key, or held it a beat too long.
      const first = word[0];
      if (first === first.toUpperCase() && first !== first.toLowerCase()) {
        return first.toLowerCase() + word.slice(1);
      }
      if (first === first.toLowerCase() && first !== first.toUpperCase()) {
        return first.toUpperCase() + word.slice(1);
      }
      return null;
    }
    default:
      return null;
  }
}

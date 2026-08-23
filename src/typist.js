import { appendText, deleteRange, getBodyLength } from './gdocs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;

export class Stopped extends Error {
  constructor() { super('Stopped by user.'); this.name = 'Stopped'; }
}

/**
 * Where the typing goes. The app passes the Google Doc sink below; the landing
 * page passes one backed by a `<div>`, so the demo you see there is this exact
 * engine rather than a lookalike animation.
 *
 * `length` returns the character count; positions follow the Docs API, where the
 * first character sits at index 1.
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
been has had did does said them where why while much many such own same each few more other them
i'm it's don't that's is not and the of a to in`.split(/\s+/).filter(Boolean));

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

  if (/\d/.test(bare)) ease *= 0.7;                      // figures need looking at
  if (/[A-Z]{2,}/.test(bare)) ease *= 0.72;               // acronyms, shift-key work
  else if (/^[A-Z]/.test(bare) && !COMMON.has(lower)) ease *= 0.85;  // proper nouns
  // Accented letters, dashes and curly quotes: awkward keys, or none at all.
  for (const ch of word) { if (ch.codePointAt(0) > 127) { ease *= 0.7; break; } }
  if (/[()";:\[\]{}]/.test(word)) ease *= 0.88;           // reaching for punctuation

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

/**
 * Predicted wall-clock duration, so the UI can warn before a 40-minute run.
 */
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
   * @param {string} opts.documentId  target Google Doc
   * @param {number} opts.wpm         target typing speed
   * @param {number} opts.typoRate    probability a long word is mistyped first
   * @param {number} opts.pauseLevel  0 none ... 3 very hesitant
   * @param {function} opts.onProgress ({done, total, requests, etaMs, state})
   * @param {function} opts.onLog     (message, isError)
   */
  constructor({ documentId = null, sink = null, wpm = 55, typoRate = 0.03, pauseLevel = 1,
                onProgress = () => {}, onLog = () => {} }) {
    this.documentId = documentId;
    this.sink = sink || docsSink(documentId);
    this.wpm = wpm;
    this.typoRate = typoRate;
    this.pauseLevel = pauseLevel;
    this.onProgress = onProgress;
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
    const until = Date.now() + ms;
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

  /**
   * One API call's worth of characters. The caller passes the time these
   * particular words should have taken — summed per word, so the pace inside a
   * burst reflects which words they were, not just how many characters.
   */
  async emit(chunk, budgetMs) {
    await this.gate();
    const started = performance.now();
    await this.sink.append(chunk);
    this.requests++;
    this.docChars += chunk.length;
    this.done += chunk.length;

    const spent = performance.now() - started;
    if (budgetMs > spent) await this.wait(budgetMs - spent);
    this.report('typing');
  }

  /** How long one word should take, given how awkward it is to type. */
  wordMs(text, ease) {
    return (text.length / (cps(this.wpm) * ease * this.drift)) * 1000 * rand(0.82, 1.22);
  }

  /** Type a wrong spelling, notice it, rub it out, and carry on. */
  async mistype(wrong) {
    await this.gate();
    await this.sink.append(wrong);
    this.requests++;
    this.docChars += wrong.length;
    this.report('typing');

    // The moment of noticing: a fast typist catches it sooner, and the hesitancy
    // setting stretches it, but even "no pauses" leaves a beat for the backspace.
    const notice = Math.min(2.5, Math.max(0.05, 55 / this.wpm))
      * Math.max(0.3, PAUSE_MULTIPLIER[this.pauseLevel] ?? 1);
    await this.wait(rand(220, 900) * notice);

    const end = this.docChars + 1;     // body index just past the last character
    try {
      await this.sink.remove(end - wrong.length, end);
    } catch (err) {
      // Our cursor drifted (someone else editing the doc?) - re-sync and retry.
      this.docChars = await this.sink.length();
      const resynced = this.docChars + 1;
      await this.sink.remove(Math.max(1, resynced - wrong.length), resynced);
    }
    this.requests++;
    this.docChars -= wrong.length;
    await this.wait(rand(90, 320) * notice);
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

      // A word that is slower to type is also likelier to come out wrong.
      const typoOdds = Math.min(this.typoRate * 4, this.typoRate / ease);
      const wrong = core.length >= 4 && chance(typoOdds) ? corrupt(core) : null;

      // Awkward words get a beat of hesitation before the hands start moving.
      if (pauseM > 0 && ease <= 0.72 && chance(0.3)) {
        await flush();
        this.report('thinking');
        await this.wait(rand(250, 900) * pauseM);
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
        await this.mistype(wrong);
        buffer = core + trail;
        budget = this.wordMs(core + trail, ease);
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
      if (pauseM > 0) {
        if (/\n\s*\n\s*$/.test(token)) {
          await flush();
          this.drift = rand(0.85, 1.18);
          this.report('thinking');
          await this.wait(rand(900, 3200) * pauseM);
        } else if (/[.!?]["')\]]?\s+$/.test(token)) {
          await flush();
          this.report('thinking');
          await this.wait(rand(280, 1300) * pauseM);
        } else if (++sinceThought > nextThought) {
          sinceThought = 0;
          nextThought = rand(14, 42);
          this.report('thinking');
          await this.wait(rand(400, 2200) * pauseM);
        }
      }
    }

    await flush();
    this.report('done');
    return { requests: this.requests, chars: this.done, ms: Date.now() - this.startedAt };
  }
}

/** Produce a plausible mistyping of a word. */
function corrupt(word) {
  const kinds = ['slip', 'swap', 'double', 'drop'];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  const i = 1 + Math.floor(Math.random() * (word.length - 1));

  switch (kind) {
    case 'slip': {
      const ch = word[i].toLowerCase();
      const near = NEIGHBOURS[ch];
      if (!near) return null;
      let hit = near[Math.floor(Math.random() * near.length)];
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
    default:
      return null;
  }
}

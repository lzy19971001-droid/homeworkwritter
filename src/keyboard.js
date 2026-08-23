/**
 * QWERTY hand and finger assignment, and the cost of moving between two keys.
 *
 * The numbers come from Dhakal, Feit, Kristensson & Oulasvirta, "Observations on
 * Typing from 136 Million Keystrokes" (CHI 2018) and the earlier work it reviews:
 *
 *   - mean inter-key interval 238.66 ms (SD 111.60) at a mean of 51.56 wpm
 *   - bigrams typed with alternating hands run 5–20 ms faster than same-hand ones
 *     for fast, trained and untrained typists
 *   - earlier studies put different-hand pairs 30–60 ms ahead of same-hand and
 *     about 80 ms ahead of same-finger pairs
 *   - the left hand is 7–15 ms slower than the right
 *   - repeating one letter is faster than an average bigram for trained typists
 *
 * Fingers are numbered 0 (pinky) to 3 (index); the thumb keys the space bar.
 */

const ROWS = {
  L: {
    0: '`1qaz~!QAZ',
    1: '2wsx@WSX',
    2: '3edc#EDC',
    3: '45rfvtgb$%RFVTGB',
  },
  R: {
    3: '67yhnujm^&YHNUJM',
    2: '8ik,*IK<',
    1: '9ol.(OL>',
    0: "0p;/-=[]\\'\")P:?_+{}|\"",
  },
};

const KEYS = new Map();
for (const [hand, fingers] of Object.entries(ROWS)) {
  for (const [finger, chars] of Object.entries(fingers)) {
    for (const ch of chars) {
      if (!KEYS.has(ch)) KEYS.set(ch, { hand, finger: Number(finger) });
    }
  }
}

/** Characters that need a shift held down, so a second finger is involved. */
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ');

const DIGITS = new Set('0123456789');

export function keyFor(ch) {
  if (ch === ' ') return { hand: 'T', finger: 4 };          // thumb
  if (ch === '\n' || ch === '\t') return { hand: 'R', finger: 0 };
  return KEYS.get(ch) || KEYS.get(ch.toLowerCase()) || null;
}

/**
 * Milliseconds to add to (or subtract from) the baseline interval for this
 * particular transition. Everything is expressed relative to the 238 ms mean
 * the study reports, and scaled by the caller for other speeds.
 */
export function transitionCost(prev, ch) {
  let cost = 0;

  if (SHIFTED.has(ch)) cost += 90;      // reaching for shift with the other pinky
  if (DIGITS.has(ch)) cost += 50;       // the number row is off home position

  const a = prev == null ? null : keyFor(prev);
  const b = keyFor(ch);
  if (!b) return cost + 60;             // something exotic: accents, em dashes

  if (ch === ' ') return cost - 25;     // the thumb is already resting on it
  if (b.hand === 'L') cost += 10;       // the left hand runs slightly behind

  if (!a) return cost;

  if (prev === ch) return cost + 30;                        // same key twice
  if (a.hand === b.hand && a.finger === b.finger) return cost + 65;  // same finger
  if (a.hand === b.hand) return cost + 15;                  // same hand, other finger
  return cost;                                              // hands alternate
}

import { HumanTypist } from './typist.js';

/**
 * The hero demo. It drives the same HumanTypist the real app uses — same bursts,
 * same hesitations, same typo-and-correct behaviour — but writes into a <div>
 * instead of a Google Doc, so what you watch on the landing page is the engine
 * itself rather than a scripted animation.
 */

const SAMPLE = `The Treaty of Versailles was signed in June 1919, formally ending the First World War. Its terms placed responsibility for the conflict on Germany and required substantial reparations.

Historians remain divided on whether those terms made a second war inevitable, or whether the economic collapse of the following decade mattered more.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A sink backed by a DOM node. Indexes follow the Docs API: first char is 1. */
function domSink(node) {
  let text = '';
  const paint = () => { node.textContent = text; };
  return {
    async append(chunk) { text += chunk; paint(); },
    async remove(startIndex, endIndex) {
      text = text.slice(0, startIndex - 1) + text.slice(endIndex - 1);
      paint();
    },
    async length() { return text.length; },
    reset() { text = ''; paint(); },
  };
}

export function startDemo({ page, status, replayBtn }) {
  const sink = domSink(page);
  let typist = null;
  // Bumped whenever a run is superseded, so an old loop knows to bow out.
  let generation = 0;

  const setStatus = (label) => { if (status) status.textContent = label; };

  async function loop() {
    const mine = ++generation;
    typist?.stop();

    while (mine === generation && !document.hidden) {
      sink.reset();
      typist = new HumanTypist({
        sink,
        wpm: 90,
        typoRate: 0.09,
        pauseLevel: 1,
        onProgress: ({ state }) => setStatus(state === 'thinking' ? 'thinking…' : 'typing…'),
      });
      try {
        await typist.type(SAMPLE);
        setStatus('saved to Drive');
      } catch {
        return;                        // superseded by a newer run
      }
      if (mine !== generation) return;
      await sleep(4500);
    }
  }

  replayBtn?.addEventListener('click', () => loop());

  // Don't burn cycles typing into a tab nobody is looking at.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      generation++;
      typist?.stop();
    } else {
      loop();
    }
  });

  loop();
}

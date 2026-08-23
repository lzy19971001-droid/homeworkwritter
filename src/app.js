import { getClientId, setClientId, signIn, signOut, onAuthChange, isSignedIn } from './auth.js';
import { createDocument, docUrl, ensureFolder, ApiError } from './gdocs.js';
import { extractText } from './extract.js';
import { HumanTypist, Stopped, estimateMs, formatDuration } from './typist.js';
import { MAX_REQUESTS_PER_MINUTE } from './config.js';

const $ = (id) => document.getElementById(id);
const el = {
  signIn: $('signInBtn'), signOut: $('signOutBtn'), profile: $('profile'),
  avatar: $('avatar'), who: $('who'),
  setupCard: $('setupCard'), clientIdInput: $('clientIdInput'), saveClientId: $('saveClientId'),
  text: $('text'), file: $('file'), drop: $('drop'), fileInfo: $('fileInfo'), counts: $('counts'),
  title: $('title'), folder: $('folder'),
  wpm: $('wpm'), wpmOut: $('wpmOut'), typo: $('typo'), typoOut: $('typoOut'),
  pause: $('pause'), pauseOut: $('pauseOut'), watch: $('watch'),
  estimate: $('estimate'),
  start: $('startBtn'), pauseBtn: $('pauseBtn'), stop: $('stopBtn'), docLink: $('docLink'),
  progressWrap: $('progressWrap'), bar: $('bar'), progressText: $('progressText'), etaText: $('etaText'),
  log: $('log'),
};

const PAUSE_LABELS = ['off', 'normal', 'long', 'very long'];

const state = {
  sourceText: '',      // text from the paste box or the uploaded file
  fromFile: false,
  typist: null,
  running: false,
  documentId: null,
  resumeText: null,    // set when a run stops early, so it can be continued
};

/* ------------------------------------------------------------------ logging */

function log(message, isError = false) {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('span');
  if (isError) line.className = 'err';
  line.textContent = `[${time}] ${message}\n`;
  el.log.append(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function describeError(err) {
  if (err instanceof ApiError) {
    if (err.status === 403 && /has not been used|disabled/i.test(err.message)) {
      return `${err.message}\nEnable the Google Docs API and Google Drive API in your Cloud project, wait a minute, then retry.`;
    }
    if (err.status === 403) return `Google refused the request: ${err.message}`;
    if (err.status === 429) return 'Google rate-limited the run even after backing off. Try a slower speed.';
    return `Google API error ${err.status}: ${err.message}`;
  }
  return err?.message || String(err);
}

/* --------------------------------------------------------------------- auth */

onAuthChange(({ user, signedIn }) => {
  el.signIn.classList.toggle('hidden', signedIn);
  el.profile.classList.toggle('hidden', !signedIn);
  if (user) {
    el.who.textContent = user.name || user.email || 'Signed in';
    if (user.picture) el.avatar.src = user.picture; else el.avatar.classList.add('hidden');
  }
  refreshStart();
});

el.signIn.addEventListener('click', async () => {
  if (!getClientId()) { el.setupCard.classList.remove('hidden'); el.clientIdInput.focus(); return; }
  el.signIn.disabled = true;
  try {
    const user = await signIn();
    log(`Signed in as ${user?.email || 'your Google account'}.`);
  } catch (err) {
    log(describeError(err), true);
  } finally {
    el.signIn.disabled = false;
  }
});

el.signOut.addEventListener('click', () => {
  signOut();
  log('Signed out. The access token was revoked.');
});

el.saveClientId.addEventListener('click', () => {
  const id = el.clientIdInput.value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    log('That does not look like a client ID — it should end in .apps.googleusercontent.com', true);
    return;
  }
  setClientId(id);
  el.setupCard.classList.add('hidden');
  log('Client ID saved in this browser. You can sign in now.');
});

if (!getClientId()) el.setupCard.classList.remove('hidden');

/* --------------------------------------------------------------- input tabs */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const pane of document.querySelectorAll('.pane')) {
      pane.classList.toggle('hidden', pane.id !== tab.dataset.pane);
    }
    state.fromFile = tab.dataset.pane === 'filePane';
    if (!state.fromFile) state.sourceText = el.text.value;
    refreshCounts();
  });
}

el.text.addEventListener('input', () => {
  if (!state.fromFile) { state.sourceText = el.text.value; refreshCounts(); }
});

el.drop.addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.add('hover'); });
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('hover'));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('hover');
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
el.file.addEventListener('change', () => {
  const file = el.file.files?.[0];
  if (file) loadFile(file);
});

async function loadFile(file) {
  el.fileInfo.classList.remove('hidden');
  el.fileInfo.textContent = `Reading ${file.name}…`;
  try {
    const needsGoogle = !/\.(txt|md|markdown|csv|tsv|json|log|text|docx)$/i.test(file.name)
      && !file.type.startsWith('text/');
    if (needsGoogle && !isSignedIn()) {
      throw new Error('Sign in first — this format is converted by Google Drive, which needs your permission.');
    }
    const text = await extractText(file, (step) => { el.fileInfo.textContent = `${file.name} — ${step}`; });
    if (!text.trim()) throw new Error('No text could be read out of that file.');
    state.sourceText = text;
    state.fromFile = true;
    el.fileInfo.textContent = `${file.name} — ${text.length.toLocaleString()} characters read.`;
    if (!el.title.value.trim()) el.title.value = file.name.replace(/\.[^.]+$/, '');
    log(`Loaded ${file.name} (${text.length.toLocaleString()} characters).`);
  } catch (err) {
    state.sourceText = '';
    el.fileInfo.textContent = describeError(err);
    log(describeError(err), true);
  }
  refreshCounts();
}

/* ------------------------------------------------------------------ options */

function options() {
  return {
    wpm: Number(el.wpm.value),
    typoRate: Number(el.typo.value) / 100,
    pauseLevel: Number(el.pause.value),
    maxRpm: MAX_REQUESTS_PER_MINUTE,
  };
}

for (const input of [el.wpm, el.typo, el.pause]) {
  input.addEventListener('input', () => {
    el.wpmOut.value = el.wpm.value;
    el.typoOut.value = el.typo.value;
    el.pauseOut.value = PAUSE_LABELS[Number(el.pause.value)];
    refreshEstimate();
  });
}

function refreshCounts() {
  const text = state.sourceText || '';
  const words = (text.match(/\S+/g) || []).length;
  el.counts.textContent = `${text.length.toLocaleString()} characters · ${words.toLocaleString()} words`;
  refreshEstimate();
  refreshStart();
}

function refreshEstimate() {
  const ms = estimateMs(state.sourceText || '', options());
  el.estimate.textContent = ms
    ? `Estimated time: about ${formatDuration(ms)} — leave this tab open and in the foreground while it types.`
    : 'Estimated time: —';
}

function refreshStart() {
  el.start.disabled = state.running || !isSignedIn() || !(state.sourceText || '').trim();
}

/* ---------------------------------------------------------------- the run */

el.start.addEventListener('click', run);

el.pauseBtn.addEventListener('click', () => {
  if (!state.typist) return;
  if (state.typist.paused) {
    state.typist.resume();
    el.pauseBtn.textContent = 'Pause';
    log('Resumed.');
  } else {
    state.typist.pause();
    el.pauseBtn.textContent = 'Resume';
    log('Paused — the document keeps whatever has been typed so far.');
  }
});

el.stop.addEventListener('click', () => {
  state.typist?.stop();
  log('Stopping…');
});

async function run() {
  const text = (state.sourceText || '').trim();
  if (!text) return;

  state.running = true;
  el.start.disabled = true;
  el.pauseBtn.classList.remove('hidden');
  el.stop.classList.remove('hidden');
  el.progressWrap.classList.remove('hidden');
  el.pauseBtn.textContent = 'Pause';

  const opts = options();
  const resuming = state.resumeText && state.documentId;
  const toType = resuming ? state.resumeText : text;

  try {
    if (!resuming) {
      const title = el.title.value.trim() || 'Homework';
      const folderName = el.folder.value.trim();

      let folderId = null;
      if (folderName) {
        folderId = await ensureFolder(folderName);
        log(`Filing it under "${folderName}".`);
      }

      log(`Creating "${title}" in your Google Drive…`);
      const doc = await createDocument(title, folderId);
      state.documentId = doc.documentId;

      const url = docUrl(state.documentId);
      el.docLink.href = url;
      el.docLink.classList.remove('hidden');
      log(`Document created: ${url}`);
      if (el.watch.checked) window.open(url, '_blank', 'noopener');
    } else {
      log('Resuming where the last run stopped…');
    }

    state.resumeText = null;

    const typist = new HumanTypist({
      documentId: state.documentId,
      ...opts,
      onProgress: onProgress,
      onLog: log,
    });
    state.typist = typist;

    log(`Typing ${toType.length.toLocaleString()} characters at about ${opts.wpm} wpm…`);
    const result = await typist.type(toType);
    log(`Done — ${result.chars.toLocaleString()} characters in ${formatDuration(result.ms)} across ${result.requests} edits.`);
    el.progressText.textContent = 'Finished';
    el.etaText.textContent = '';
  } catch (err) {
    const typed = state.typist?.done || 0;
    state.resumeText = toType.slice(typed);
    if (err instanceof Stopped) {
      log(`Stopped after ${typed.toLocaleString()} characters. Press start again to continue in the same document.`);
    } else {
      log(describeError(err), true);
      if (state.resumeText) log('Press start again to continue in the same document from where it left off.');
    }
  } finally {
    state.running = false;
    state.typist = null;
    el.pauseBtn.classList.add('hidden');
    el.stop.classList.add('hidden');
    el.start.textContent = state.resumeText ? 'Continue typing' : 'Create doc & start typing';
    refreshStart();
  }
}

function onProgress({ done, total, requests, etaMs, state: phase }) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  el.bar.style.width = `${pct.toFixed(1)}%`;
  el.progressText.textContent =
    `${phase === 'thinking' ? 'Thinking…' : 'Typing…'} ${done.toLocaleString()} / ${total.toLocaleString()} characters · ${requests} edits`;
  el.etaText.textContent = etaMs ? `about ${formatDuration(etaMs)} left` : '';
}

/* Guard against losing a run to an accidental tab close. */
window.addEventListener('beforeunload', (e) => {
  if (state.running) { e.preventDefault(); e.returnValue = ''; }
});

refreshCounts();
el.pauseOut.value = PAUSE_LABELS[Number(el.pause.value)];

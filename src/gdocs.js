import { getAccessToken } from './auth.js';
import { MAX_REQUESTS_PER_MINUTE } from './config.js';

/** Simple sliding-window limiter so we never trip the Docs API write quota. */
class RateLimiter {
  constructor(perMinute) { this.perMinute = perMinute; this.stamps = []; }
  async slot() {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < 60_000);
      if (this.stamps.length < this.perMinute) { this.stamps.push(now); return; }
      const waitMs = 60_000 - (now - this.stamps[0]) + 50;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const limiter = new RateLimiter(MAX_REQUESTS_PER_MINUTE);

/** Raise or lower the quota pacing. Used by tests/simulate.html to run flat out. */
export function setRateLimit(perMinute) { limiter.perMinute = perMinute; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Fetch a Google API endpoint with auth, quota pacing, and retries.
 * Retries 429/5xx with exponential backoff; refreshes the token once on 401.
 */
async function api(url, { method = 'GET', json, body, headers = {}, retries = 5 } = {}) {
  let attempt = 0;
  let refreshed = false;
  for (;;) {
    await limiter.slot();
    const token = await getAccessToken();
    const init = { method, headers: { Authorization: `Bearer ${token}`, ...headers } };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (networkErr) {
      if (attempt >= retries) throw new ApiError(0, `Network error: ${networkErr.message}`);
      await sleep(backoff(attempt++));
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }

    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    const message = parsed?.error?.message || text || res.statusText;

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await getAccessToken({ forceRefresh: true });
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(backoff(attempt++));
      continue;
    }
    throw new ApiError(res.status, message, parsed);
  }
}

function backoff(attempt) {
  return Math.min(32_000, 800 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
}

const DOCS = 'https://docs.googleapis.com/v1/documents';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

/**
 * Create the empty Doc through the Drive API rather than documents.create, so
 * that the narrow drive.file scope is unambiguously sufficient: Drive makes the
 * file, the app owns it, and the Docs API may then edit it. Optionally drops it
 * straight into a folder, which saves a second call to move it afterwards.
 */
export async function createDocument(title, folderId = null) {
  const file = await api(`${DRIVE}?fields=id`, {
    method: 'POST',
    json: {
      name: title || 'Untitled',
      mimeType: 'application/vnd.google-apps.document',
      ...(folderId ? { parents: [folderId] } : {}),
    },
  });
  return { documentId: file.id };
}

export function docUrl(documentId) {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

export async function batchUpdate(documentId, requests) {
  return api(`${DOCS}/${documentId}:batchUpdate`, { method: 'POST', json: { requests } });
}

/** Append text at the very end of the document body. */
export function appendText(documentId, text) {
  return batchUpdate(documentId, [{ insertText: { text, endOfSegmentLocation: {} } }]);
}

/** Delete a character range, e.g. to rub out a typo. */
export function deleteRange(documentId, startIndex, endIndex) {
  return batchUpdate(documentId, [{ deleteContentRange: { range: { startIndex, endIndex } } }]);
}

/**
 * Number of characters currently in the body. A Google Doc always ends with a
 * final newline that cannot be removed, so the body's end index is
 * (characters typed) + 2. Used to re-sync if our local cursor ever drifts.
 */
export async function getBodyLength(documentId) {
  const doc = await api(`${DOCS}/${documentId}?fields=body(content(endIndex))`);
  const content = doc.body?.content || [];
  const end = content.length ? content[content.length - 1].endIndex : 2;
  return Math.max(0, end - 2);
}

/** Find a Drive folder this app created, or create it. Requires only drive.file. */
export async function ensureFolder(name) {
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const found = await api(`${DRIVE}?q=${q}&fields=files(id,name)&pageSize=1`);
  if (found.files?.length) return found.files[0].id;
  const created = await api(DRIVE, {
    method: 'POST',
    json: { name, mimeType: 'application/vnd.google-apps.folder' },
  });
  return created.id;
}

/**
 * Upload a file to Drive asking Google to convert it to a Doc, export the plain
 * text, then move the temporary copy to the trash. This is how .pdf / .doc /
 * .odt / .rtf uploads are read — Google does the parsing, we keep no copy.
 */
export async function extractTextViaDrive(file, onStep = () => {}) {
  const boundary = `hw${Math.random().toString(36).slice(2)}`;
  const metadata = {
    name: `[temp] ${file.name}`,
    mimeType: 'application/vnd.google-apps.document',
  };
  const parts = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
    file,
    `\r\n--${boundary}--\r\n`,
  ]);

  onStep('Uploading to Drive for conversion…');
  const uploaded = await api(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: parts,
  });

  try {
    onStep('Reading the converted text…');
    const token = await getAccessToken();
    const res = await fetch(`${DRIVE}/${uploaded.id}/export?mimeType=text/plain`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError(res.status, `Could not export the converted file (${res.status}).`);
    return await res.text();
  } finally {
    onStep('Moving the temporary copy to Drive trash…');
    try {
      await api(`${DRIVE}/${uploaded.id}`, { method: 'PATCH', json: { trashed: true } });
    } catch { /* leave it in Drive rather than fail the run */ }
  }
}

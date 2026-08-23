import { extractTextViaDrive } from './gdocs.js';

const PLAIN_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'text'];

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/**
 * Turn an uploaded file into plain text.
 *  - text formats are read directly
 *  - .docx is unzipped and parsed in the browser (no upload, no library)
 *  - anything else is handed to Drive's converter (requires being signed in)
 */
export async function extractText(file, onStep = () => {}) {
  const ext = extOf(file.name);

  if (PLAIN_EXT.includes(ext) || file.type.startsWith('text/')) {
    onStep('Reading file…');
    return normalise(await file.text());
  }
  if (ext === 'docx') {
    onStep('Unzipping .docx in your browser…');
    return normalise(await readDocx(file));
  }
  onStep('This format needs Google to convert it.');
  return normalise(await extractTextViaDrive(file, onStep));
}

function normalise(text) {
  return text
    .replace(/\r\n?/g, '\n')       // Windows / classic Mac line endings
    .replace(/ /g, ' ')       // non-breaking spaces confuse word counts
    .replace(/\n{3,}/g, '\n\n')    // collapse runs of blank lines
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/* ---------------------------------------------------------------------------
 * Minimal .docx reader: a .docx is a ZIP holding word/document.xml.
 * We read the ZIP central directory and inflate that one entry with the
 * browser's built-in DecompressionStream — no third-party dependency.
 * ------------------------------------------------------------------------- */

async function readDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const entry = findZipEntry(buf, 'word/document.xml');
  if (!entry) throw new Error('That .docx file has no word/document.xml — it may be corrupt.');
  const bytes = await inflateEntry(buf, entry);
  const xml = new TextDecoder().decode(bytes);
  return docxXmlToText(xml);
}

function findZipEntry(buf, wantedName) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory record: signature 0x06054b50, within the last 64KB.
  let eocd = -1;
  const from = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid .docx (ZIP) file.');

  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true); // offset of central directory

  for (let n = 0; n < entries; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (name === wantedName) {
      // Local header: name/extra lengths can differ from the central directory.
      const lNameLen = view.getUint16(localOffset + 26, true);
      const lExtraLen = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      return { method, start, end: start + compSize };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function inflateEntry(buf, { method, start, end }) {
  const slice = buf.subarray(start, end);
  if (method === 0) return slice;                       // stored
  if (method !== 8) throw new Error(`Unsupported ZIP compression method ${method}.`);
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot unzip .docx files. Please paste the text instead.');
  }
  const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function docxXmlToText(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse the .docx contents.');

  const paragraphs = [];
  for (const p of doc.getElementsByTagName('w:p')) {
    let line = '';
    // Walk in document order so tabs and breaks land in the right place.
    const walker = doc.createTreeWalker(p, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      switch (node.nodeName) {
        case 'w:t': line += node.textContent; break;
        case 'w:tab': line += '\t'; break;
        case 'w:br': case 'w:cr': line += '\n'; break;
      }
    }
    paragraphs.push(line);
  }
  return paragraphs.join('\n');
}

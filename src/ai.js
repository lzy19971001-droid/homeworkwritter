/**
 * Drafting with an AI model, from the browser, on the user's own API key.
 *
 * Every provider here is called directly from the page. That is only reasonable
 * because the key belongs to the person sitting at the browser and never leaves
 * it — there is no server in this app to hold one. Anthropic's SDK calls this
 * out explicitly and requires `dangerouslyAllowBrowser` to opt in; the same
 * caution applies to the other two.
 *
 * Model lists are fetched from each provider rather than hard-coded, so a name
 * baked in today cannot go stale.
 */

const KEY_PREFIX = 'hw.key.';

export function getKey(provider) {
  try { return localStorage.getItem(KEY_PREFIX + provider) || ''; } catch { return ''; }
}
export function setKey(provider, key) {
  try {
    if (key) localStorage.setItem(KEY_PREFIX + provider, key);
    else localStorage.removeItem(KEY_PREFIX + provider);
  } catch { /* private mode */ }
}
export function forgetAllKeys() {
  for (const id of Object.keys(PROVIDERS)) setKey(id, '');
}

const SYSTEM = `You are drafting prose that will be typed straight into a Google Doc.

Return only the finished text. No preamble, no sign-off, no commentary about what
you wrote. Use plain prose: no markdown, no "#" headings, no "**" bold, no bullet
characters unless the user explicitly asks for a list. Separate paragraphs with a
blank line. Write in the register the user asks for, and match any length they give.

This is a conversation: when asked to revise, return the full revised text rather
than describing the change or sending only the edited part. Whatever you return is
what gets typed into the document.`;

/** Anthropic — via the official SDK, loaded as an ES module with no build step. */
async function anthropicClient(apiKey) {
  const { default: Anthropic } = await import('https://esm.sh/@anthropic-ai/sdk');
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

export const PROVIDERS = {
  claude: {
    label: 'Claude',
    keyHint: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    fallbackModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    preferred: 'claude-opus-5',

    async listModels(apiKey) {
      const client = await anthropicClient(apiKey);
      const out = [];
      for await (const m of client.models.list({ limit: 40 })) out.push(m.id);
      return out;
    },

    async generate({ apiKey, model, messages, onDelta, signal }) {
      const client = await anthropicClient(apiKey);
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: messages.map((m) => ({ role: m.role, content: m.text })),
        thinking: { type: 'adaptive' },
        // Routes around a safety refusal instead of returning nothing.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }, { signal });

      stream.on('text', (text) => onDelta(text));
      const message = await stream.finalMessage();

      if (message.stop_reason === 'refusal') {
        throw new Error(
          `Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}. Try rephrasing it.`
        );
      }
      return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  },

  openai: {
    label: 'OpenAI',
    keyHint: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
    fallbackModels: ['gpt-4o', 'gpt-4o-mini'],
    preferred: 'gpt-4o',

    async listModels(apiKey) {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw await httpError(res, 'OpenAI');
      const data = await res.json();
      return (data.data || []).map((m) => m.id).filter((id) => /^(gpt|o\d)/.test(id)).sort();
    },

    async generate({ apiKey, model, messages, signal }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM },
            ...messages.map((m) => ({ role: m.role, content: m.text })),
          ],
        }),
        signal,
      });
      if (!res.ok) throw await httpError(res, 'OpenAI');
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    },
  },

  gemini: {
    label: 'Gemini',
    keyHint: 'AIza…',
    keysUrl: 'https://aistudio.google.com/app/apikey',
    fallbackModels: ['gemini-2.0-flash'],
    preferred: 'gemini-2.0-flash',

    async listModels(apiKey) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      if (!res.ok) throw await httpError(res, 'Gemini');
      const data = await res.json();
      return (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .sort();
    },

    async generate({ apiKey, model, messages, signal }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          // Gemini calls the assistant role "model".
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.text }],
          })),
        }),
        signal,
      });
      if (!res.ok) throw await httpError(res, 'Gemini');
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      return parts.map((p) => p.text || '').join('');
    },
  },
};

async function httpError(res, label) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body.error?.message || body.message || '';
  } catch { /* non-JSON body */ }
  if (res.status === 401 || res.status === 403) {
    return new Error(`${label} rejected that API key${detail ? `: ${detail}` : '.'}`);
  }
  if (res.status === 429) return new Error(`${label} rate-limited the request. Wait a moment and retry.`);
  return new Error(`${label} error ${res.status}${detail ? `: ${detail}` : ''}`);
}

/** Model list from the provider, falling back to a short static list if it fails. */
export async function loadModels(providerId, apiKey) {
  const provider = PROVIDERS[providerId];
  try {
    const ids = await provider.listModels(apiKey);
    return ids.length ? ids : provider.fallbackModels;
  } catch {
    return provider.fallbackModels;
  }
}

export function generate(providerId, opts) {
  return PROVIDERS[providerId].generate({ onDelta: () => {}, ...opts });
}

/**
 * Shared plumbing for the billing functions.
 *
 * Stripe is called over plain fetch rather than through its SDK: the calls used
 * here are three form-encoded POSTs, and the webhook signature is an HMAC that
 * Node's own crypto does. That keeps the deploy to a single dependency.
 */

export const FREE_RUNS_PER_MONTH = 3;

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Establish who is asking. The browser sends the Google access token it already
 * holds; Google tells us which account it belongs to. Never trust an email sent
 * by the client — that is the whole point of this round trip.
 */
export async function identify(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { error: json({ error: 'Not signed in.' }, 401) };

  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { error: json({ error: 'Google rejected that session. Sign in again.' }, 401) };

  const profile = await res.json();
  if (!profile.email) return { error: json({ error: 'That account has no email address.' }, 401) };
  return { email: profile.email.toLowerCase(), profile };
}

// Imported lazily so this module can be loaded outside the Netlify runtime —
// which is what lets tests/billing.html exercise the logic below in a browser.
const store = async () => (await import('@netlify/blobs')).getStore('entitlements');

/** Current billing month, as the key the free allowance resets on. */
export const thisMonth = () => new Date().toISOString().slice(0, 7);

export async function readRecord(email) {
  const found = (await (await store()).get(email, { type: 'json' })) || {};
  const record = {
    email,
    status: 'free',          // 'free' | 'active' | 'past_due' | 'canceled'
    customerId: null,
    subscriptionEnds: null,
    month: thisMonth(),
    used: 0,
    ...found,
  };
  // The free allowance renews with the calendar month.
  if (record.month !== thisMonth()) {
    record.month = thisMonth();
    record.used = 0;
  }
  return record;
}

export async function writeRecord(record) {
  await (await store()).setJSON(record.email, record);
  return record;
}

/** A subscription that has been paid for and has not lapsed. */
export function isSubscribed(record) {
  if (record.status !== 'active') return false;
  if (!record.subscriptionEnds) return true;
  // Keep access until the period actually ends, even after a cancellation.
  return Date.now() < new Date(record.subscriptionEnds).getTime() + 24 * 3600 * 1000;
}

export function entitlement(record) {
  const subscribed = isSubscribed(record);
  return {
    email: record.email,
    subscribed,
    status: record.status,
    used: record.used,
    limit: FREE_RUNS_PER_MONTH,
    remaining: subscribed ? null : Math.max(0, FREE_RUNS_PER_MONTH - record.used),
    renewsOn: subscribed ? record.subscriptionEnds : monthEnd(),
  };
}

function monthEnd() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** POST to the Stripe API with form encoding, which is what it expects. */
export async function stripe(path, params = {}, method = 'POST') {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set on this site.');

  const body = new URLSearchParams();
  const walk = (value, prefix) => {
    for (const [k, v] of Object.entries(value)) {
      const name = prefix ? `${prefix}[${k}]` : k;
      if (v === undefined || v === null) continue;
      if (typeof v === 'object') walk(v, name);
      else body.append(name, String(v));
    }
  };
  walk(params, '');

  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'GET' ? undefined : body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe error ${res.status}`);
  return data;
}

export function siteUrl(req) {
  return process.env.SITE_URL || new URL(req.url).origin;
}

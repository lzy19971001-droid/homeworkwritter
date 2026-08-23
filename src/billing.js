import { getAccessToken } from './auth.js';

/**
 * Talks to the billing functions. The browser never decides whether someone has
 * paid — it asks, and shows the answer. Every call carries the Google access
 * token, which the function exchanges for a verified email.
 *
 * If the functions are not deployed (running from a plain static server, say),
 * every check returns `unmetered` and the app behaves as it always did. That
 * keeps local development and self-hosting working without Stripe.
 */

const API = '/api';

async function call(path, { method = 'GET' } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });

  // No functions deployed: Netlify serves the SPA/404 page instead of JSON.
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    return { unmetered: true, status: res.status };
  }

  const body = await res.json();
  return { ...body, httpStatus: res.status };
}

/** Where does this account stand? Never throws — billing must not break typing. */
export async function status() {
  try {
    return await call('entitlement');
  } catch {
    return { unmetered: true };
  }
}

/**
 * Claim one document. Returns `{ allowed }`, and on refusal the reason to show.
 * A network failure counts as allowed: an outage here should not stand between
 * someone and their own work.
 */
export async function claimRun() {
  try {
    const result = await call('entitlement', { method: 'POST' });
    if (result.unmetered) return { allowed: true, unmetered: true };
    return { ...result, allowed: result.allowed !== false };
  } catch {
    return { allowed: true, offline: true };
  }
}

export async function startCheckout() {
  const result = await call('checkout', { method: 'POST' });
  if (result.unmetered) throw new Error('Subscriptions are not set up on this deployment.');
  if (!result.url) throw new Error(result.error || 'Stripe did not return a checkout page.');
  window.location.assign(result.url);
}

export async function openPortal() {
  const result = await call('portal', { method: 'POST' });
  if (result.unmetered) throw new Error('Subscriptions are not set up on this deployment.');
  if (!result.url) throw new Error(result.error || 'Stripe did not return a billing page.');
  window.location.assign(result.url);
}

/** One line describing the plan, for the header. */
export function describe(state) {
  if (!state || state.unmetered) return '';
  if (state.subscribed) return 'Subscribed · unlimited';
  if (state.status === 'past_due') return 'Payment failed · update card';
  const left = state.remaining ?? 0;
  return left === 1 ? '1 free document left this month' : `${left} free documents left this month`;
}

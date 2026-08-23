import { readRecord, writeRecord, stripe, json } from './_shared.mjs';

/**
 * Stripe tells us what happened; this is the only thing that may mark an account
 * as paid. The browser never gets to claim it.
 *
 * The signature check is not optional: this endpoint is public, so without it
 * anyone could POST a fake "subscription active" event and let themselves in.
 */
export async function verify(rawBody, signature, secret, now = Date.now()) {
  const parts = {};
  for (const pair of (signature || '').split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) parts[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  if (!parts.t || !parts.v1) return false;

  // Reject anything older than five minutes, so a captured request cannot be
  // replayed later.
  if (!Number.isFinite(Number(parts.t))) return false;
  if (Math.abs(now / 1000 - Number(parts.t)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${parts.t}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare: never let the response time reveal how much of a
  // forged signature was correct.
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

/** Find which account an event belongs to, by metadata first, customer second. */
async function emailFor(object) {
  const direct = object.metadata?.email
    || object.client_reference_id
    || object.customer_details?.email
    || object.customer_email;
  if (direct) return direct.toLowerCase();

  if (object.customer) {
    const customer = await stripe(`customers/${object.customer}`, {}, 'GET');
    if (customer.email) return customer.email.toLowerCase();
  }
  return null;
}

export default async (req) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'STRIPE_WEBHOOK_SECRET is not set.' }, 500);

  const raw = await req.text();
  if (!(await verify(raw, req.headers.get('stripe-signature'), secret))) {
    return json({ error: 'Bad signature.' }, 400);
  }

  const event = JSON.parse(raw);
  const object = event.data?.object || {};

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const email = await emailFor(object);
        if (!email) break;
        const record = await readRecord(email);
        record.customerId = object.customer || record.customerId;
        record.status = 'active';
        if (object.subscription) {
          const sub = await stripe(`subscriptions/${object.subscription}`, {}, 'GET');
          record.subscriptionEnds = new Date(sub.current_period_end * 1000).toISOString();
          record.status = sub.status === 'trialing' ? 'active' : sub.status;
        }
        await writeRecord(record);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const email = await emailFor(object);
        if (!email) break;
        const record = await readRecord(email);
        record.customerId = object.customer || record.customerId;
        // Stripe's own status is the truth: active, past_due, canceled, unpaid.
        record.status = event.type.endsWith('deleted') ? 'canceled'
          : (object.status === 'trialing' ? 'active' : object.status);
        record.subscriptionEnds = object.current_period_end
          ? new Date(object.current_period_end * 1000).toISOString()
          : record.subscriptionEnds;
        await writeRecord(record);
        break;
      }

      case 'invoice.payment_failed': {
        const email = await emailFor(object);
        if (!email) break;
        const record = await readRecord(email);
        record.status = 'past_due';
        await writeRecord(record);
        break;
      }

      default:
        break;   // everything else is none of this app's business
    }
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    return json({ error: err.message }, 500);
  }

  return json({ received: true });
};

export const config = { path: '/api/stripe-webhook' };

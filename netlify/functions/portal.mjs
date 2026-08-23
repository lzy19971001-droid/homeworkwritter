import { identify, readRecord, stripe, siteUrl, json } from './_shared.mjs';

/**
 * Send a subscriber to Stripe's own billing portal, where they can change their
 * card, download invoices or cancel. Doing it this way means none of that is
 * code in this repo, and cancelling never requires emailing anyone.
 */
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const who = await identify(req);
  if (who.error) return who.error;

  const record = await readRecord(who.email);
  if (!record.customerId) return json({ error: 'This account has never subscribed.' }, 404);

  try {
    const session = await stripe('billing_portal/sessions', {
      customer: record.customerId,
      return_url: `${siteUrl(req)}/app.html`,
    });
    return json({ url: session.url });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
};

export const config = { path: '/api/portal' };

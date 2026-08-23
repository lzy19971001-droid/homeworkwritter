import { identify, readRecord, writeRecord, stripe, siteUrl, json } from './_shared.mjs';

/**
 * Start a Stripe Checkout session for the annual subscription, and hand back the
 * URL for the browser to go to. Card details are entered on Stripe's own page —
 * they never reach this site, which is the point of using Checkout.
 *
 * The Google email is attached to the customer and echoed in the session
 * metadata, so the webhook can match the payment back to the right account.
 */
export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const who = await identify(req);
  if (who.error) return who.error;

  const price = process.env.STRIPE_PRICE_ID;
  if (!price) return json({ error: 'STRIPE_PRICE_ID is not set on this site.' }, 500);

  const record = await readRecord(who.email);

  try {
    // Reuse the customer if this account has paid before, so their history and
    // cards stay in one place rather than fragmenting across records.
    if (!record.customerId) {
      const existing = await stripe(
        `customers?email=${encodeURIComponent(who.email)}&limit=1`, {}, 'GET'
      );
      const customer = existing.data?.[0]
        || await stripe('customers', { email: who.email, name: who.profile.name || undefined });
      record.customerId = customer.id;
      await writeRecord(record);
    }

    const site = siteUrl(req);
    const session = await stripe('checkout/sessions', {
      mode: 'subscription',
      customer: record.customerId,
      client_reference_id: who.email,
      'line_items[0][price]': price,
      'line_items[0][quantity]': 1,
      'metadata[email]': who.email,
      'subscription_data[metadata][email]': who.email,
      allow_promotion_codes: true,
      success_url: `${site}/app.html?checkout=done`,
      cancel_url: `${site}/app.html?checkout=cancelled`,
    });

    return json({ url: session.url });
  } catch (err) {
    return json({ error: err.message }, 502);
  }
};

export const config = { path: '/api/checkout' };

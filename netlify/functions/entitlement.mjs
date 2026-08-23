import { identify, readRecord, writeRecord, entitlement, isSubscribed, json, FREE_RUNS_PER_MONTH } from './_shared.mjs';

/**
 * What is this account allowed to do?
 *
 *   GET  /api/entitlement   — report the current position
 *   POST /api/entitlement   — claim one run, or refuse
 *
 * The count lives here rather than in the browser, so clearing site data does
 * not hand anyone a fresh allowance. It does not make the gate airtight: the
 * typing itself happens in the browser with the user's own Google token, so
 * someone determined can skip this call. It is a paywall, not a vault.
 */
export default async (req) => {
  const who = await identify(req);
  if (who.error) return who.error;

  const record = await readRecord(who.email);

  if (req.method === 'GET') {
    return json(entitlement(record));
  }

  if (req.method !== 'POST') {
    return json({ error: 'Use GET or POST.' }, 405);
  }

  if (isSubscribed(record)) {
    return json({ ...entitlement(record), allowed: true });
  }

  if (record.used >= FREE_RUNS_PER_MONTH) {
    return json({
      ...entitlement(record),
      allowed: false,
      reason: `That is ${FREE_RUNS_PER_MONTH} documents this month. The allowance renews on the 1st, or you can subscribe for unlimited use.`,
    }, 402);
  }

  record.used += 1;
  await writeRecord(record);
  return json({ ...entitlement(record), allowed: true });
};

export const config = { path: '/api/entitlement' };

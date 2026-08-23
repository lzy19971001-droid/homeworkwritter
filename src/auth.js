import { DEFAULT_CLIENT_ID, SCOPES } from './config.js';

const CLIENT_ID_KEY = 'hw.clientId';
// Remembers that this browser has granted access before, so a returning visitor
// can be signed in again without being asked to click anything.
const RETURNING_KEY = 'hw.returning';

let tokenClient = null;
let clientId = localStorage.getItem(CLIENT_ID_KEY) || DEFAULT_CLIENT_ID || '';
let accessToken = null;
let expiresAt = 0;
let user = null;
const listeners = new Set();

export function getClientId() { return clientId; }

/** `persist: false` is for tests, which must not overwrite a real saved ID. */
export function setClientId(id, { persist = true } = {}) {
  clientId = (id || '').trim();
  if (persist) localStorage.setItem(CLIENT_ID_KEY, clientId);
  tokenClient = null;
}

export function onAuthChange(fn) { listeners.add(fn); fn({ user, signedIn: !!accessToken }); }
function emit() { for (const fn of listeners) fn({ user, signedIn: !!accessToken }); }

export function getUser() { return user; }
export function isSignedIn() { return !!accessToken && Date.now() < expiresAt; }

function gis() {
  const g = window.google?.accounts?.oauth2;
  if (!g) throw new Error('Google sign-in script has not loaded yet. Check your connection and reload.');
  return g;
}

function ensureClient() {
  if (!clientId) throw new Error('No OAuth client ID configured.');
  if (!tokenClient) {
    tokenClient = gis().initTokenClient({ client_id: clientId, scope: SCOPES, callback: () => {} });
  }
  return tokenClient;
}

/**
 * Ask Google for an access token. Must be triggered by a user gesture the first
 * time (and whenever Google decides to show its account chooser), otherwise the
 * popup is blocked by the browser.
 */
export function requestToken({ prompt = '' } = {}) {
  const client = ensureClient();
  return new Promise((resolve, reject) => {
    client.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      accessToken = resp.access_token;
      expiresAt = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
      try { localStorage.setItem(RETURNING_KEY, '1'); } catch { /* private mode */ }
      emit();
      resolve(accessToken);
    };
    client.error_callback = (err) => {
      reject(new Error(err?.type === 'popup_closed'
        ? 'Sign-in window was closed before finishing.'
        : (err?.message || 'Sign-in failed.')));
    };
    try {
      client.requestAccessToken({ prompt });
    } catch (err) {
      reject(err);
    }
  });
}

export async function signIn() {
  await requestToken({ prompt: '' });
  await loadProfile();
  return user;
}

export function signOut() {
  try { localStorage.removeItem(RETURNING_KEY); } catch { /* private mode */ }
  const token = accessToken;
  accessToken = null;
  expiresAt = 0;
  user = null;
  emit();
  if (token) { try { gis().revoke(token, () => {}); } catch { /* best effort */ } }
}

/**
 * Sign a returning visitor straight back in, with no click and no consent screen,
 * the way any other product with a Google button behaves. Google only honours
 * this if the browser still has a session and the grant is still in place —
 * otherwise it fails quietly and the button is shown as usual.
 */
export async function restoreSession() {
  if (!clientId || localStorage.getItem(RETURNING_KEY) !== '1') return false;
  try {
    await requestToken({ prompt: 'none' });
    await loadProfile();
    return true;
  } catch {
    return false;
  }
}

async function loadProfile() {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) { user = await res.json(); emit(); }
  } catch { /* the profile is cosmetic — never block on it */ }
}

/**
 * Returns a valid token, silently renewing it when it is close to expiry.
 * Silent renewal can fail if the browser blocks the hidden popup — callers
 * should surface that so the user can click to reconnect.
 */
export async function getAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && accessToken && Date.now() < expiresAt) return accessToken;
  await requestToken({ prompt: '' });
  return accessToken;
}

// Paste your Google OAuth 2.0 "Web application" client ID here to bake it into the
// deployment. A client ID is public information — it is safe to commit. There is no
// client secret anywhere in this app; the browser token flow does not use one.
//
// If you leave it empty the app asks for it at runtime and remembers it in
// localStorage, so you can also try the app without editing this file.
export const DEFAULT_CLIENT_ID = '';

// Scopes:
//   drive.file – see and manage ONLY the files this app creates, never the rest
//                of your Drive. The Docs API accepts it for documents the app
//                created, so the sensitive `documents` scope (which would grant
//                access to every Doc you own, and would put the app through
//                Google's verification review) is deliberately NOT requested.
//   openid/email/profile – show who is signed in
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
  'profile',
].join(' ');

// Safety rail for the Google Docs API write quota (per-user, per-minute).
// The API allows more than this; staying well under keeps the run smooth.
export const MAX_REQUESTS_PER_MINUTE = 45;

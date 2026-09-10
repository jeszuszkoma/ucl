import { CONFIG } from './config.js';

// Supabase Auth over plain fetch (GoTrue REST). No SDK.
//   signup  -> POST /auth/v1/signup            (email confirmation required)
//   login   -> POST <LOGIN_URL> (edge fn, username or email)  or  /auth/v1/token
//   refresh -> POST /auth/v1/token?grant_type=refresh_token
//   recover -> POST /auth/v1/recover, then PUT /auth/v1/user with the recovery token
// The session (tokens + user) lives in localStorage.

const LS_SESSION = 'ucl.session';
const LS_LOCAL_NAME = 'ucl.localName'; // local mode only

// Force local mode for development without a Supabase project: add ?local to
// the URL once (remembered in localStorage) - ?online switches back.
const FORCE_LOCAL = (() => {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('online')) localStorage.removeItem('ucl.forceLocal');
    else if (q.has('local')) localStorage.setItem('ucl.forceLocal', '1');
    return localStorage.getItem('ucl.forceLocal') === '1';
  } catch { return false; }
})();
export const online = () => !FORCE_LOCAL && Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);

export class AuthError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

// ------------------------------------------------------------ session store

let cached = null;

export function session() {
  if (cached !== null) return cached || null;
  try { cached = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); }
  catch { cached = null; }
  return cached || null;
}

function storeSession(s) {
  cached = s || null;
  if (s) localStorage.setItem(LS_SESSION, JSON.stringify(s));
  else localStorage.removeItem(LS_SESSION);
}

function fromToken(payload) {
  // GoTrue token response -> compact session
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: payload.expires_at ?? Math.floor(Date.now() / 1000) + (payload.expires_in ?? 3600),
    user: { id: payload.user?.id, email: payload.user?.email },
    username: payload.user?.user_metadata?.username ?? null,
  };
}

// { id, username } for the logged-in player, or null.
export function currentUser() {
  if (!online()) {
    const name = localStorage.getItem(LS_LOCAL_NAME);
    return name ? { id: 'local', username: name } : null;
  }
  const s = session();
  return s?.user?.id ? { id: s.user.id, username: s.username ?? '…' } : null;
}

export function setLocalName(name) {
  localStorage.setItem(LS_LOCAL_NAME, name.trim());
}

// ------------------------------------------------------------ http helpers

const base = () => CONFIG.SUPABASE_URL.replace(/\/$/, '');

async function authFetch(path, { method = 'POST', body, bearer } = {}) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      apikey: CONFIG.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const code = json?.error_code ?? json?.error ?? json?.code ?? `http_${res.status}`;
    throw new AuthError(String(code), json?.msg ?? json?.error_description ?? json?.message ?? text);
  }
  return json;
}

// Another tab may rotate the refresh token: drop the in-memory copy when the
// stored session changes so we never replay a stale token.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => { if (e.key === LS_SESSION) cached = null; });
}

// Errors from the refresh call that mean "this session is really gone".
// Anything else (offline, 5xx, 429) keeps the stored session for a retry.
const TERMINAL = /refresh_token|session_not_found|session_expired|invalid_grant|user_banned|user_not_found|bad_jwt|^http_40[013]$/;

// Access token, refreshed when it expires within 60 s (or on force).
// Throws AuthError('no_session') | AuthError('session_expired') | AuthError('offline').
let refreshing = null;
export async function token({ force = false } = {}) {
  cached = null; // re-read localStorage (other tab may have refreshed)
  const s = session();
  if (!s?.access_token) throw new AuthError('no_session');
  if (!force && s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  if (!refreshing) {
    refreshing = authFetch('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refresh_token } })
      .then(p => {
        const next = { ...fromToken(p), username: s.username ?? p.user?.user_metadata?.username ?? null };
        storeSession(next);
        return next.access_token;
      })
      .catch(e => {
        if (e instanceof AuthError && TERMINAL.test(e.code)) {
          storeSession(null);
          throw new AuthError('session_expired', e.message);
        }
        throw new AuthError('offline', e.message);
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Headers for PostgREST calls as the logged-in user.
export async function headers() {
  return {
    apikey: CONFIG.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${await token()}`,
    'Content-Type': 'application/json',
  };
}

// ------------------------------------------------------------ flows

// Registration. Resolves when the confirmation email is on its way.
export async function signup({ email, username, password, invite }) {
  email = email.trim().toLowerCase();
  username = username.trim();
  // Readable errors before the trigger can reject the row.
  const pre = await authFetch('/rest/v1/rpc/signup_precheck', {
    body: { p_username: username, p_invite: invite.trim() },
  });
  if (pre !== 'ok') throw new AuthError(pre);
  // GoTrue reads redirect_to from the query string (not the JSON body); the
  // URL must also be on the dashboard's Redirect URLs allow-list.
  const res = await authFetch(`/auth/v1/signup${redirectQs()}`, {
    body: {
      email, password,
      data: { username, invite: invite.trim() },
      gotrue_meta_security: {},
    },
  });
  // With "Confirm email" on, GoTrue returns the user without a session. An
  // already-registered address comes back as a fake user with no identities.
  if (Array.isArray(res?.identities) && res.identities.length === 0) {
    throw new AuthError('user_already_exists');
  }
  if (res?.access_token) storeSession(fromToken(res)); // confirmations disabled in the project
  return { needsConfirm: !res?.access_token };
}

const redirectQs = () => (CONFIG.SITE_URL ? `?redirect_to=${encodeURIComponent(CONFIG.SITE_URL)}` : '');

export async function login(usernameOrEmail, password) {
  const id = usernameOrEmail.trim();
  let payload;
  // Emails go straight to Auth (per-IP rate limit stays the caller's own);
  // usernames need the edge function for the private username -> email lookup.
  if (CONFIG.LOGIN_URL && !id.includes('@')) {
    const res = await fetch(CONFIG.LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY },
      body: JSON.stringify({ username: id, password }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new AuthError(String(json?.error ?? `http_${res.status}`));
    payload = json;
  } else {
    if (!id.includes('@')) throw new AuthError('email_login_only');
    payload = await authFetch('/auth/v1/token?grant_type=password', { body: { email: id.toLowerCase(), password } });
  }
  const s = fromToken(payload);
  storeSession(s);
  s.username = await loadProfile().catch(() => s.username);
  storeSession(s);
  return currentUser();
}

export async function logout() {
  const s = session();
  storeSession(null);
  if (s?.access_token) {
    try { await authFetch('/auth/v1/logout', { bearer: s.access_token }); } catch { /* already gone */ }
  }
}

export async function recover(email) {
  await authFetch(`/auth/v1/recover${redirectQs()}`, { body: { email: email.trim().toLowerCase() } });
}

// New confirmation link for an unconfirmed signup.
export async function resend(email) {
  await authFetch(`/auth/v1/resend${redirectQs()}`, { body: { type: 'signup', email: email.trim().toLowerCase() } });
}

export async function updatePassword(password) {
  const p = await authFetch('/auth/v1/user', { method: 'PUT', body: { password }, bearer: await token() });
  return p;
}

// Username from profiles (the source of truth; metadata is only a copy).
export async function loadProfile(retry = true) {
  const s = session();
  if (!s?.user?.id) return null;
  const res = await fetch(`${base()}/rest/v1/profiles?select=username&user_id=eq.${s.user.id}`, {
    headers: await headers(),
  });
  if (res.status === 401 && retry) { await token({ force: true }); return loadProfile(false); }
  if (!res.ok) throw new AuthError(res.status === 401 ? 'session_expired' : `http_${res.status}`);
  const rows = await res.json();
  const name = rows?.[0]?.username ?? null;
  if (name && name !== s.username) storeSession({ ...session(), username: name });
  return name;
}

// Email links land here with tokens in the URL hash:
//   #access_token=…&refresh_token=…&type=signup|recovery|magiclink
// Store the session and return the link type ('signup' | 'recovery' | null).
export function handleAuthHash() {
  const h = location.hash;
  if (!h.includes('access_token=')) {
    if (h.includes('error=')) {
      const p = new URLSearchParams(h.slice(1));
      history.replaceState(null, '', location.pathname + location.search);
      return { type: 'error', message: p.get('error_description') ?? p.get('error') };
    }
    return null;
  }
  const p = new URLSearchParams(h.slice(1));
  const s = {
    access_token: p.get('access_token'),
    refresh_token: p.get('refresh_token'),
    expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + (Number(p.get('expires_in')) || 3600),
    user: { id: null, email: null },
    username: null,
  };
  try {
    const claims = JSON.parse(atob(s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    s.user = { id: claims.sub, email: claims.email };
    s.username = claims.user_metadata?.username ?? null;
  } catch { /* fall back to loadProfile() */ }
  storeSession(s);
  history.replaceState(null, '', location.pathname + location.search);
  return { type: p.get('type') ?? 'signup' };
}

// Human-readable error text for the auth modal.
export function describe(err) {
  const code = err?.code ?? '';
  const map = {
    bad_invite: 'Wrong invite code.',
    bad_username: 'Username: 3–20 letters, digits, . _ -',
    taken: 'That username is taken.',
    user_already_exists: 'This email is already registered — log in instead.',
    email_exists: 'This email is already registered — log in instead.',
    weak_password: 'Password too weak — at least 6 characters.',
    invalid_credentials: 'Wrong username or password.',
    email_not_confirmed: 'Email not confirmed yet — check your inbox.',
    email_login_only: 'Log in with your email address.',
    over_email_send_rate_limit: 'Too many emails sent — wait a minute and retry.',
    over_request_rate_limit: 'Too many attempts — wait a minute and retry.',
    session_expired: 'Session expired — log in again.',
    no_session: 'Log in first.',
    offline: 'No connection — try again.',
    auth_unavailable: 'Login service unavailable — try again shortly.',
    validation_failed: 'Check the fields.',
    signup_disabled: 'Registration is closed.',
    same_password: 'New password must differ from the old one.',
  };
  if (map[code]) return map[code];
  if (/^http_5/.test(code)) return map.auth_unavailable;
  if (err instanceof TypeError) return map.offline; // fetch failed: no network
  if (err?.message && !/^http_/.test(code)) return err.message;
  return 'Something went wrong — try again.';
}

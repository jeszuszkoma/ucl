// Supabase Edge Function: log in with USERNAME (or email) + password.
//
// The browser never learns other players' emails: the username -> email
// lookup runs here with the service role, then the password grant is
// forwarded to Supabase Auth and the session is returned to the client.
//
// Deploy:  supabase functions deploy login --no-verify-jwt
// Env:     SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are
//          injected automatically by the platform.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

// Best-effort throttle per caller IP and per username (in-memory, per isolate).
// GoTrue's own /token limiter only sees this function's egress IP, so without
// this one guesser could lock every player out. Isolates recycle, so treat it
// as a speed bump, not a guarantee.
const WINDOW_MS = 5 * 60_000;
const MAX_PER_IP = 20;
const MAX_PER_USER = 10;
const hits = new Map<string, { n: number; reset: number }>();
function throttled(key: string, max: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + WINDOW_MS }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 60_000);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // New-style keys win when set as function secrets (PUBLISHABLE_KEY /
  // SECRET_KEY); otherwise the platform-injected legacy JWT keys are used.
  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let username = '', password = '';
  try {
    const body = await req.json();
    username = String(body.username ?? '').trim();
    password = String(body.password ?? '');
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  if (!username || !password || username.length > 254 || password.length > 256) {
    return json({ error: 'invalid_credentials' }, 400);
  }
  // cf-connecting-ip is set by the edge, not the caller; x-forwarded-for's LAST
  // hop is the one appended by the proxy (a caller can prepend to the list).
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const ip = req.headers.get('cf-connecting-ip') ?? xff[xff.length - 1] ?? 'unknown';
  // Same normalisation as the DB (lower-case, accents stripped).
  const userKey = `user:${username.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()}`;
  if (throttled(`ip:${ip}`, MAX_PER_IP) || throttled(userKey, MAX_PER_USER)) {
    return json({ error: 'over_request_rate_limit' }, 429);
  }

  // Resolve email. Same error for unknown user and wrong password (no enumeration).
  let email = username.includes('@') ? username : '';
  if (!email) {
    const r = await fetch(`${url}/rest/v1/rpc/email_for_username`, {
      method: 'POST',
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_username: username }),
    });
    if (r.ok) email = ((await r.json()) as string | null) ?? '';
  }
  if (!email) return json({ error: 'invalid_credentials' }, 400);

  const auth = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await auth.text();
  if (!auth.ok) {
    // Pass through GoTrue's error code (e.g. email_not_confirmed) but not the email.
    // A non-400 upstream answer (outage, 429) must not read as "wrong password".
    let code = auth.status === 400 ? 'invalid_credentials' : auth.status === 429 ? 'over_request_rate_limit' : 'auth_unavailable';
    try {
      const j = JSON.parse(text);
      code = j.error_code ?? j.error ?? code;
    } catch { /* keep default */ }
    return json({ error: code }, auth.status === 400 ? 400 : auth.status === 429 ? 429 : 502);
  }
  // Successful grant: reset the per-user counter so a typo doesn't linger.
  hits.delete(userKey);
  return new Response(text, { headers: { ...CORS, 'Content-Type': 'application/json' } });
});

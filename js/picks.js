import { CONFIG } from './config.js';
import { online, headers, token, currentUser } from './auth.js';

// Ballot state: picks, submissions, trophy picks, ballots, player names.
// Online: Supabase PostgREST as the logged-in user (RLS decides what is
// visible / writable). Local mode: everything in localStorage.

const LS = {
  picks: 'ucl.local.picks',        // { "<num>": "1"|"X"|"2" }
  subs: 'ucl.local.submissions',   // { "<phase>": iso }
  trophy: 'ucl.local.trophy',      // { champion, top_scorer }
};
const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const base = () => CONFIG.SUPABASE_URL.replace(/\/$/, '');

// PostgREST rejects an expired JWT with 401 (server clock, not ours): refresh
// once and retry, so a slow device clock never reads as "ballot closed".
// Every request gets a bounded lifetime so a hung write can't keep SUBMIT
// disabled ("saving…") for minutes; a fresh signal is created per attempt.
const TIMEOUT_MS = 15_000;
async function restFetch(url, init, retry = true) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(await headers()), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 && retry) {
    await token({ force: true });
    return restFetch(url, init, false);
  }
  return res;
}

// PostgREST caps a reply at 1000 rows - page with Range until a short page.
async function fetchAll(path) {
  const PAGE = 1000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const res = await restFetch(`${base()}/rest/v1/${path}`, {
      headers: { 'Range-Unit': 'items', Range: `${from}-${from + PAGE - 1}` },
    });
    if (!res.ok) throw new Error(`${path.split('?')[0]} ${res.status}`);
    const rows = await res.json();
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

async function write(path, body, { onConflict } = {}) {
  const url = `${base()}/rest/v1/${path}${onConflict ? `?on_conflict=${onConflict}` : ''}`;
  const res = await restFetch(url, {
    method: 'POST',
    headers: { Prefer: onConflict ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`${path} ${res.status}: ${txt}`);
    err.status = res.status;
    // 42501 = RLS refused (ballot closed / already submitted / not in ballot)
    err.locked = res.status === 403 || /42501|row-level security/.test(txt);
    throw err;
  }
}

// -> {
//   ballots:     { phase: { label, opens_at, locks_at } }
//   profiles:    { user_id: username }
//   picks:       { "<num>:<user_id>": pick }
//   submissions: { "<phase>:<user_id>": submitted_at }
//   trophy:      { user_id: { champion, top_scorer } }
// }
export async function fetchState() {
  const me = currentUser();
  if (!me) return { ballots: await fetchBallots(), profiles: {}, picks: {}, submissions: {}, trophy: {} };
  if (!online()) {
    const picks = {}, submissions = {}, trophy = {};
    if (me) {
      for (const [num, pick] of Object.entries(ls(LS.picks, {}))) picks[`${num}:${me.id}`] = pick;
      for (const [phase, at] of Object.entries(ls(LS.subs, {}))) submissions[`${phase}:${me.id}`] = at;
      const t = ls(LS.trophy, null);
      if (t) trophy[me.id] = t;
    }
    return {
      ballots: CONFIG.LOCAL_BALLOTS,
      profiles: me ? { [me.id]: me.username } : {},
      picks, submissions, trophy,
    };
  }
  const [ballotRows, profileRows, pickRows, subRows, trophyRows] = await Promise.all([
    fetchAll('ballots?select=phase,label,opens_at,locks_at'),
    fetchAll('profiles?select=user_id,username&order=username.asc'),
    fetchAll('picks?select=user_id,match_num,pick&order=match_num.asc,user_id.asc'),
    fetchAll('submissions?select=user_id,phase,submitted_at'),
    fetchAll('trophy_picks?select=user_id,champion,top_scorer'),
  ]);
  const ballots = {};
  for (const b of ballotRows) ballots[b.phase] = { label: b.label, opens_at: b.opens_at, locks_at: b.locks_at };
  const profiles = {};
  for (const p of profileRows) profiles[p.user_id] = p.username;
  const picks = {};
  for (const r of pickRows) picks[`${r.match_num}:${r.user_id}`] = r.pick;
  const submissions = {};
  for (const r of subRows) submissions[`${r.phase}:${r.user_id}`] = r.submitted_at;
  const trophy = {};
  for (const r of trophyRows) trophy[r.user_id] = { champion: r.champion, top_scorer: r.top_scorer };
  return { ballots, profiles, picks, submissions, trophy };
}

export async function savePick(num, pick) {
  const me = currentUser();
  if (!me) throw new Error('not logged in');
  if (!online()) {
    const map = ls(LS.picks, {});
    map[num] = pick;
    lsSet(LS.picks, map);
    return;
  }
  await write('picks', { user_id: me.id, match_num: num, pick }, { onConflict: 'user_id,match_num' });
}

// Freeze the caller's ballot for a phase. Irreversible.
export async function submitPhase(phase) {
  const me = currentUser();
  if (!me) throw new Error('not logged in');
  if (!online()) {
    const map = ls(LS.subs, {});
    map[phase] = new Date().toISOString();
    lsSet(LS.subs, map);
    return;
  }
  await write('submissions', { user_id: me.id, phase });
}

// Champion + top scorer. Send ONLY the changed column: PostgREST's
// merge-duplicates upsert updates just the payload columns, so a stale local
// copy of the other pick can never null it.
export async function saveTrophy(patch) {
  const me = currentUser();
  if (!me) throw new Error('not logged in');
  const cols = {};
  if ('champion' in patch) cols.champion = patch.champion ?? null;
  if ('top_scorer' in patch) cols.top_scorer = patch.top_scorer ?? null;
  if (!online()) {
    lsSet(LS.trophy, { champion: null, top_scorer: null, ...ls(LS.trophy, {}), ...cols });
    return;
  }
  await write('trophy_picks', { user_id: me.id, ...cols }, { onConflict: 'user_id' });
}

// Ballot deadlines are public (anon-readable): lets a logged-out visitor see
// when the ballot opens / locks before creating an account.
export async function fetchBallots() {
  if (!online()) return CONFIG.LOCAL_BALLOTS;
  const res = await fetch(`${base()}/rest/v1/ballots?select=phase,label,opens_at,locks_at`, {
    headers: { apikey: CONFIG.SUPABASE_ANON_KEY },
  });
  if (!res.ok) throw new Error(`ballots ${res.status}`);
  const ballots = {};
  for (const b of await res.json()) ballots[b.phase] = { label: b.label, opens_at: b.opens_at, locks_at: b.locks_at };
  return ballots;
}

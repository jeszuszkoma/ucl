import { CONFIG } from './config.js';
import { online, headers, token, currentUser } from './auth.js';

// Ballot state: picks, submissions, trophy picks, ballots, player names.
//
// Picks are NOT sent to the server as they are tapped. They stay in this
// browser (localStorage, per player) until SUBMIT ships the whole ballot in
// one call (`submit_ballot` RPC): one request per player per phase instead
// of one per tap. Trade-off: a draft exists only on the device it was made
// on, and a ballot that is never submitted counts for nothing.
//
// Online: Supabase PostgREST as the logged-in user (RLS decides what is
// visible / writable). Local mode: everything in localStorage.

const LS = {
  picks: 'ucl.local.picks',        // local mode: { "<num>": "1"|"X"|"2" }
  subs: 'ucl.local.submissions',   // local mode: { "<phase>": iso }
  trophy: 'ucl.local.trophy',      // local mode: { champion, top_scorer }
  draft: 'ucl.draft.',             // online: + user id -> { picks, trophy }
};
const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const lsSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const base = () => CONFIG.SUPABASE_URL.replace(/\/$/, '');

// PostgREST rejects an expired JWT with 401 (server clock, not ours): refresh
// once and retry, so a slow device clock never reads as "ballot closed".
// Every request gets a bounded lifetime so a hung submit can't keep the
// button on "sending…" for minutes; a fresh signal is created per attempt.
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

async function rpc(name, body) {
  const res = await restFetch(`${base()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  const txt = await res.text();
  const err = new Error(`${name} ${res.status}: ${txt}`);
  err.status = res.status;
  // 42501 = refused by RLS or the function (ballot closed / already submitted)
  err.locked = res.status === 403 || /42501|row-level security/.test(txt);
  // 23514 = the server disagrees that the ballot is complete
  err.incomplete = /23514/.test(txt);
  throw err;
}

// ---------------------------------------------------------------- drafts
// { picks: { "<num>": pick }, trophy: { champion, top_scorer } } of the
// logged-in player on this device. Empty in local mode (its picks are the
// "server" there) and when logged out.
const draftKey = me => `${LS.draft}${me.id}`;
export function loadDraft() {
  const me = currentUser();
  if (!me || !online()) return { picks: {}, trophy: {} };
  const d = ls(draftKey(me), {});
  return { picks: d.picks ?? {}, trophy: d.trophy ?? {} };
}
function saveDraft(d) { lsSet(draftKey(currentUser()), d); }

// Forget draft rows that a submit turned into server rows.
export function clearDraft(nums, { champion = false, scorer = false } = {}) {
  const me = currentUser();
  if (!me || !online()) return;
  const d = loadDraft();
  for (const n of nums) delete d.picks[n];
  if (champion) delete d.trophy.champion;
  if (scorer) delete d.trophy.top_scorer;
  saveDraft(d);
}

// -> {
//   ballots:     { phase: { label, opens_at, locks_at } }
//   profiles:    { user_id: username }
//   picks:       { "<num>:<user_id>": pick }      (server rows only - drafts are layered on by the app)
//   submissions: { "<phase>:<user_id>": submitted_at }
//   trophy:      { user_id: { champion, top_scorer } }   (from champion_picks + scorer_picks)
// }
export async function fetchState() {
  const me = currentUser();
  if (!me) return { ballots: await fetchBallots(), profiles: {}, picks: {}, submissions: {}, trophy: {} };
  if (!online()) {
    const picks = {}, submissions = {}, trophy = {};
    for (const [num, pick] of Object.entries(ls(LS.picks, {}))) picks[`${num}:${me.id}`] = pick;
    for (const [phase, at] of Object.entries(ls(LS.subs, {}))) submissions[`${phase}:${me.id}`] = at;
    const t = ls(LS.trophy, null);
    if (t) trophy[me.id] = t;
    return {
      ballots: CONFIG.LOCAL_BALLOTS,
      profiles: { [me.id]: me.username },
      picks, submissions, trophy,
    };
  }
  const [ballotRows, profileRows, pickRows, subRows, champRows, scorerRows] = await Promise.all([
    fetchAll('ballots?select=phase,label,opens_at,locks_at'),
    fetchAll('profiles?select=user_id,username&order=username.asc'),
    fetchAll('picks?select=user_id,match_num,pick&order=match_num.asc,user_id.asc'),
    fetchAll('submissions?select=user_id,phase,submitted_at'),
    fetchAll('champion_picks?select=user_id,champion'),
    fetchAll('scorer_picks?select=user_id,top_scorer'),
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
  for (const r of champRows) trophy[r.user_id] = { champion: r.champion, top_scorer: null };
  for (const r of scorerRows) trophy[r.user_id] = { ...(trophy[r.user_id] ?? { champion: null }), top_scorer: r.top_scorer };
  return { ballots, profiles, picks, submissions, trophy };
}

// Draft pick - this device only, no request.
export async function savePick(num, pick) {
  const me = currentUser();
  if (!me) throw new Error('not logged in');
  if (!online()) {
    const map = ls(LS.picks, {});
    map[num] = pick;
    lsSet(LS.picks, map);
    return;
  }
  const d = loadDraft();
  d.picks[num] = pick;
  saveDraft(d);
}

// Draft champion / top scorer - this device only, no request.
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
  const d = loadDraft();
  d.trophy = { ...d.trophy, ...cols };
  saveDraft(d);
}

// Ship one ballot and freeze it. Irreversible. One request: the server writes
// the picks and the submission row in a single transaction, or nothing.
//   match phases: picks = { "<num>": pick } for every match of the phase
//   'champion': champion        'scorer': top_scorer
export async function submitPhase(phase, { picks, champion = null, top_scorer = null }) {
  const me = currentUser();
  if (!me) throw new Error('not logged in');
  if (!online()) {
    const map = ls(LS.subs, {});
    map[phase] = new Date().toISOString();
    lsSet(LS.subs, map);
    return;
  }
  await rpc('submit_ballot', {
    p_phase: phase,
    p_picks: Object.entries(picks).map(([num, pick]) => ({ num: Number(num), pick })),
    p_champion: champion,
    p_top_scorer: top_scorer,
  });
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

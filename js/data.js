import { CONFIG } from './config.js';
import { setTeams, teamByEspnId, isPlaceholder } from './teams.js';

// ------------------------------------------------------------ constants

export const KO_ROUNDS = ['Knockout play-off', 'Round of 16', 'Quarter-final', 'Semi-final', 'Final'];

export const PHASE_LABEL = {
  league: 'League phase', playoff: 'Knockout play-off', r16: 'Round of 16',
  qf: 'Quarter-finals', sf: 'Semi-finals', final: 'Final',
};

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions';
const ESPN_STANDINGS = 'https://site.api.espn.com/apis/v2/sports/soccer/uefa.champions/standings';
// ESPN stopped accepting "YYYYMMDD-YYYYMMDD" date ranges (HTTP 400 since
// October 2026). Single days and whole months ("YYYYMM") still work, so every
// pull goes month by month. limit= lifts ESPN's 100-event cap.
const SEASON_MONTHS = ['202609', '202610', '202611', '202612', '202701', '202702', '202703', '202704', '202705', '202706'];
const ym = d => d.toISOString().slice(0, 7).replace('-', '');

// ------------------------------------------------------------ match helpers

// "16:45 UTC+0" + "2026-09-08" -> Date (viewer's local timezone).
function parseKickoff(date, time) {
  const m = (time ?? '').match(/^(\d{2}):(\d{2}) UTC([+-]\d+)$/);
  if (!m) return new Date(`${date}T${time || '00:00'}:00Z`);
  const [, hh, mm, off] = m;
  const pad = String(Math.abs(parseInt(off, 10))).padStart(2, '0');
  return new Date(`${date}T${hh}:${mm}:00${off.startsWith('-') ? '-' : '+'}${pad}:00`);
}

// Live kickoff: ESPN may move a match (postponement). Used for display + status.
export function kickoff(match) {
  return parseKickoff(match.espnDate ?? match.date, match.espnTime ?? match.time);
}

// Bundled kickoff: what the server's `matches` table holds. Decides ballot
// membership, so the browser and the RLS policy agree even if ESPN moves a game
// before the admin re-syncs the schedule.
export function scheduledKickoff(match) {
  return parseKickoff(match.date, match.time);
}

export function isKnockout(match) {
  return match.phase !== 'league';
}

// The final is a single match decided on the night: pick the winner (1 / 2).
// Every other match (league, two-legged ties) is a plain 1 / X / 2.
export function isWinnerOnly(match) {
  return match.phase === 'final';
}

export function options(match) {
  return isWinnerOnly(match) ? ['1', '2'] : ['1', 'X', '2'];
}

export function placeholder(match) {
  return isPlaceholder(match.team1) || isPlaceholder(match.team2);
}

// 'scheduled' | 'live' | 'finished'
export function status(match, now = new Date()) {
  if (match._live) return 'live';
  if (match.score?.ft) return 'finished';
  const ko = kickoff(match);
  const liveWindowMs = isKnockout(match) ? 150 * 60_000 : 120 * 60_000;
  if (now >= ko && now - ko < liveWindowMs) return 'live';
  if (now >= ko) return 'finished'; // past, no score yet -> awaiting result
  return 'scheduled';
}

// Final score incl. extra time, always as [team1, team2]; pens shown separately.
export function goals(match) {
  const s = match.score;
  if (!s?.ft) return null;
  return { home: s.ft[0], away: s.ft[1], pens: s.p ?? null, et: Boolean(s.et) };
}

// '1' | 'X' | '2' for a finished match, null when undecided.
//  - league + two-legged ties: result of the match incl. extra time, a tie is X
//    (a shootout after a drawn 2nd leg does not change the match result)
//  - final: winner; level without a shootout score yet = undecided (null)
export function outcome(match) {
  const g = goals(match);
  if (!g) return null;
  if (g.home !== g.away) return g.home > g.away ? '1' : '2';
  if (isWinnerOnly(match)) return g.pens ? (g.pens[0] > g.pens[1] ? '1' : '2') : null;
  return 'X';
}

// ------------------------------------------------------------ schedule

export async function loadSchedule() {
  const data = await fetch('./data/ucl2027.json', { cache: 'no-cache' }).then(r => r.json());
  setTeams(data.teams);
  return data.matches;
}

// ------------------------------------------------------------ ESPN scores

// ESPN feeds occasionally leak raw control characters that break JSON.parse.
const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g');
async function espnJson(url) {
  const txt = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`ESPN ${r.status}`);
    return r.text();
  });
  return JSON.parse(txt.replace(CTRL, ' '));
}

// Months covering yesterday..tomorrow (UTC) - one request, two around a month
// boundary. Catches venue-timezone drift the way the old 3-day range did.
function nearMonths(now = new Date()) {
  return [...new Set([ym(new Date(now - 86_400_000)), ym(new Date(+now + 86_400_000))])];
}

// Every season month plus any month a match of ours was moved into.
function fullMonths(matches) {
  const set = new Set(SEASON_MONTHS);
  for (const m of matches) for (const d of [m.date, m.espnDate]) if (d) set.add(d.slice(0, 7).replace('-', ''));
  return [...set].sort();
}

// Pulls are serialised (the 10-minute full pull and the 60-second near pull
// share the same match objects) and every merge is stamped with a sequence
// number taken when its request started, so an older reply can never
// overwrite a fresher one (a monotonic counter, immune to clock steps).
let chain = Promise.resolve();
let pullSeq = 0;
export function refreshScores(matches, opts = {}) {
  const run = chain.then(() => doRefresh(matches, opts));
  chain = run.catch(() => {});
  return run;
}

async function doRefresh(matches, { full = false } = {}) {
  const months = full ? fullMonths(matches) : nearMonths();
  const urls = months.map(m => `${ESPN}/scoreboard?dates=${m}&limit=1000`);
  let changed = false;
  for (const url of urls) {
    const at = ++pullSeq;
    try {
      const sb = await espnJson(url);
      changed = mergeEspn(matches, sb, at) || changed;
    } catch (e) {
      console.warn('espn scores failed', url, e);
    }
  }
  return changed;
}

// Merge ESPN scoreboard events into our matches (by ESPN event id).
// Writes score / _live / goals lists in memory only. Returns true on change.
// Scores and goals are attributed by TEAM, not by ESPN's home/away flag: picks
// are positional (1 = team1) and the schedule keeps its stored orientation
// even if ESPN later swaps home and away.
function mergeEspn(matches, espn, at = ++pullSeq) {
  if (!espn?.events) return false;
  const byEspn = new Map(matches.map(m => [String(m.espn), m]));
  const nameOf = c => teamByEspnId(c?.team?.id) ?? c?.team?.displayName ?? null;
  let changed = false;
  for (const ev of espn.events) {
    const m = byEspn.get(String(ev.id));
    if (!m) continue;
    if (m._at && m._at > at) continue; // a fresher reply already landed
    m._at = at;
    const comp = ev.competitions?.[0];
    if (!comp?.competitors) continue;
    const hc = comp.competitors.find(c => c.homeAway === 'home');
    const ac = comp.competitors.find(c => c.homeAway === 'away');
    if (!hc || !ac) continue;

    // Team names fill in once a draw is made - only ever replace placeholders.
    // A placeholder slot takes whichever competitor is NOT the team already
    // stored on the other side (ESPN may have re-oriented the event since).
    const home = nameOf(hc), away = nameOf(ac);
    const fill1 = home === m.team2 ? away : home;
    const fill2 = away === m.team1 ? home : away;
    if (fill1 && isPlaceholder(m.team1) && !isPlaceholder(fill1) && fill1 !== m.team2) { m.team1 = fill1; changed = true; }
    if (fill2 && isPlaceholder(m.team2) && !isPlaceholder(fill2) && fill2 !== m.team1) { m.team2 = fill2; changed = true; }

    // Map ESPN's two competitors onto our team1 / team2: a side that resolves
    // by name wins; the other side gets the remaining competitor; if neither
    // resolves (both placeholders) fall back to ESPN's home/away order.
    const m1 = comp.competitors.find(c => nameOf(c) === m.team1);
    const m2 = comp.competitors.find(c => nameOf(c) === m.team2 && c !== m1);
    const c1 = m1 ?? (m2 ? (m2 === hc ? ac : hc) : hc);
    const c2 = m2 ?? (c1 === hc ? ac : hc);

    // Kickoff can move (postponements): keep the bundled one, remember ESPN's.
    if (ev.date && ev.date.length >= 16) {
      const d = new Date(ev.date);
      const date = ev.date.slice(0, 10);
      const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC+0`;
      const moved = date !== m.date || time !== m.time;
      if (moved && (m.espnDate !== date || m.espnTime !== time)) { m.espnDate = date; m.espnTime = time; changed = true; }
      if (!moved && m.espnDate) { delete m.espnDate; delete m.espnTime; changed = true; }
    }

    // 'pre' | 'in' | 'post'. Abandoned / postponed / cancelled fixtures also
    // come back as 'post' but with completed:false and a 0-0 - never a result.
    const type = comp.status?.type;
    const st = type?.state;
    const done = st === 'post' && type?.completed === true;
    if (st !== 'in' && !done) {
      if (m._live) { delete m._live; changed = true; }
      if (m.score) { delete m.score; changed = true; }
      continue;
    }
    const h = Number(c1.score), a = Number(c2.score);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    const score = { ft: [h, a] };
    if ((comp.status?.period ?? 0) > 2) score.et = true;
    const sh = Number(c1.shootoutScore), sa = Number(c2.shootoutScore);
    if (Number.isFinite(sh) && Number.isFinite(sa) && sh + sa > 0) score.p = [sh, sa];
    if (JSON.stringify(score) !== JSON.stringify(m.score)) { m.score = score; changed = true; }

    const live = st === 'in';
    if (live !== Boolean(m._live)) changed = true;
    if (live) m._live = true; else delete m._live;

    // Goal scorers ride along in the scoreboard - no per-match call needed.
    if (Array.isArray(comp.details)) {
      const g1 = [], g2 = [];
      for (const k of comp.details) {
        if (!k.scoringPlay || k.shootout) continue;
        const name = k.athletesInvolved?.[0]?.displayName;
        if (!name) continue;
        const entry = { name, owngoal: Boolean(k.ownGoal), minute: k.clock?.displayValue ?? '' };
        (String(k.team?.id) === String(c1.team?.id) ? g1 : g2).push(entry);
      }
      if (JSON.stringify(g1) !== JSON.stringify(m.goals1 ?? []) ||
          JSON.stringify(g2) !== JSON.stringify(m.goals2 ?? [])) {
        m.goals1 = g1; m.goals2 = g2; changed = true;
      }
    }
  }
  return changed;
}

// Tournament top-scorer tally from the goal lists of finished matches.
// Own goals and shootout penalties excluded. -> [{ name, goals }] or null.
export function topScorers(matches) {
  const tally = new Map();
  for (const m of matches) {
    if (!m.score?.ft || m._live) continue;
    for (const g of [...(m.goals1 ?? []), ...(m.goals2 ?? [])]) {
      if (g.owngoal || !g.name) continue;
      tally.set(g.name, (tally.get(g.name) ?? 0) + 1);
    }
  }
  if (!tally.size) return null;
  return [...tally.entries()]
    .map(([name, goals]) => ({ name, goals }))
    .sort((a, b) => b.goals - a.goals || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ standings

// Computed fallback: points, goal difference, goals for.
export function standings(matches, group = 'League Phase') {
  const rows = new Map();
  const ensure = t => {
    if (!rows.has(t)) rows.set(t, { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
    return rows.get(t);
  };
  for (const m of matches) {
    if (m.group !== group) continue;
    ensure(m.team1); ensure(m.team2);
    const g = goals(m);
    if (!g || m._live) continue;
    const a = rows.get(m.team1), b = rows.get(m.team2);
    a.p++; b.p++;
    a.gf += g.home; a.ga += g.away;
    b.gf += g.away; b.ga += g.home;
    if (g.home > g.away)      { a.w++; b.l++; a.pts += 3; }
    else if (g.home < g.away) { b.w++; a.l++; b.pts += 3; }
    else                      { a.d++; b.d++; a.pts++; b.pts++; }
  }
  return [...rows.values()]
    .sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.team.localeCompare(y.team))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// Official 36-team table from ESPN (rank + qualification note). null on failure.
export async function fetchStandings() {
  try {
    const d = await espnJson(ESPN_STANDINGS);
    const entries = d?.children?.[0]?.standings?.entries;
    if (!Array.isArray(entries) || !entries.length) return null;
    const rows = entries.map(e => {
      const s = Object.fromEntries((e.stats ?? []).map(x => [x.name, Number(x.value)]));
      return {
        team: teamByEspnId(e.team?.id) ?? e.team?.displayName,
        rank: s.rank, p: s.gamesPlayed, w: s.wins, d: s.ties, l: s.losses,
        gf: s.pointsFor, ga: s.pointsAgainst, pts: s.points,
        note: e.note?.description ?? '',
      };
    }).filter(r => r.team && Number.isFinite(r.rank));
    rows.sort((a, b) => a.rank - b.rank);
    return rows.length ? rows : null;
  } catch (e) {
    console.warn('espn standings failed', e);
    return null;
  }
}

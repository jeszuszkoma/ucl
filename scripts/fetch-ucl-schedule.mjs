// Build data/ucl2027.json from ESPN's public Champions League scoreboard.
//
//   node scripts/fetch-ucl-schedule.mjs
//
// Re-run any time. Rules that keep picks valid across re-runs (picks in the
// database are keyed by `num`, and 1/2 picks are positional: 1 = team1):
//   * every known ESPN event keeps its `num`, its `round` label and its
//     team1/team2 orientation - only new events get numbered;
//   * an unknown event that pairs the same two clubs as a known match whose
//     old event vanished from the feed or is abandoned is the REPLAY of that
//     match: same num, new ESPN id (the abandoned event is dropped);
//   * a new league-phase event takes the matchday of the known matches played
//     on the same day (+-1); only a fresh build clusters by date gaps;
//   * team display names are carried forward for known ESPN team ids;
//   * ESPN's "TBD Home / TBD Away" pseudo-teams never enter the team list.
// Every deviation is printed so the admin sees it. Matches missing from the
// feed stay in the file (flagged) so existing picks keep their target.
//
// After a run that adds or changes matches, run scripts/matches-sql.mjs and
// paste the output into the Supabase SQL editor.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const LEAGUE = 'uefa.champions';
const BASE = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}`;
const WINDOWS = ['20260901-20270131', '20270201-20270630']; // league phase, knockouts
const OUT = new URL('../data/ucl2027.json', import.meta.url);

// ESPN season.slug -> [round label, ballot phase]
const SLUG_ROUND = {
  'knockout-round-playoffs': ['Knockout play-off', 'playoff'],
  'round-of-16': ['Round of 16', 'r16'],
  'quarterfinals': ['Quarter-final', 'qf'],
  'semifinals': ['Semi-final', 'sf'],
  'final': ['Final', 'final'],
};
const phaseOf = slug => slug === 'league-phase' ? 'league' : (SLUG_ROUND[slug]?.[1] ?? slug);
const PLACEHOLDER = /^(tbd|tba|winner|loser|runner|1st|2nd|w\d+|l\d+)\b/i;
const isPlaceholder = name => !name || PLACEHOLDER.test(name); // "Bodo/Glimt" is real

// ESPN feeds occasionally leak raw C0 control characters, which are illegal
// inside JSON string literals. Blank the whole range before parsing.
const CTRL = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g');
async function espnJson(url) {
  const txt = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.text();
  });
  return JSON.parse(txt.replace(CTRL, ' '));
}

const warnings = [];
const warn = msg => { warnings.push(msg); console.warn('warning:', msg); };
const pairKey = (a, b) => [a, b].sort().join('|');
const isAbandoned = e => e.competitions?.[0]?.status?.type?.state === 'post' &&
  e.competitions?.[0]?.status?.type?.completed === false;

// ------------------------------------------------------------ previous state
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { matches: [], teams: [] };
const prevByEspn = new Map(prev.matches.map(m => [String(m.espn), m]));
const prevNameByTeamId = new Map((prev.teams ?? []).filter(t => t.espnId).map(t => [String(t.espnId), t.name]));
let nextNum = Math.max(0, ...prev.matches.map(m => m.num)) + 1;

// ------------------------------------------------------------ fetch
let events = [];
for (const w of WINDOWS) {
  const sb = await espnJson(`${BASE}/scoreboard?dates=${w}&limit=1000`);
  events.push(...(sb.events ?? []));
}
{
  const seen = new Set();
  const uniq = events.filter(e => !seen.has(String(e.id)) && seen.add(String(e.id)));
  if (uniq.length !== events.length) warn(`${events.length - uniq.length} duplicate event id(s) in the feed - ignored`);
  events = uniq;
}
events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
const feedIds = new Set(events.map(e => String(e.id)));
const abandonedIds = new Set(events.filter(isAbandoned).map(e => String(e.id)));

// Team name for a competitor: carried forward for known ids, else ESPN's name.
function teamName(t) {
  if (!t) return 'TBD';
  const id = String(t.id ?? '');
  const espnName = t.displayName ?? 'TBD';
  if (isPlaceholder(espnName)) return espnName;
  const known = prevNameByTeamId.get(id);
  if (known && known !== espnName) {
    warn(`team ${id} renamed by ESPN: "${known}" -> "${espnName}" (keeping "${known}")`);
    return known;
  }
  return espnName;
}
const sides = e => {
  const c = e.competitions[0];
  const hc = c.competitors.find(x => x.homeAway === 'home');
  const ac = c.competitors.find(x => x.homeAway === 'away');
  return { c, hc, ac, home: teamName(hc?.team), away: teamName(ac?.team) };
};

// ------------------------------------------------------------ replays (pre-pass)
// An unknown event pairing two known clubs, in the same phase as a stored match
// whose event vanished or is abandoned, is that match replayed under a new id.
const replayOf = new Map();   // new event id -> previous match
const replaced = new Set();   // previous event ids superseded by a replay
const unresolved = new Set(); // unknown league events duplicating a pairing that is still live
for (const e of events) {
  if (prevByEspn.has(String(e.id))) continue;
  const { home, away } = sides(e);
  if (isPlaceholder(home) || isPlaceholder(away)) continue;
  const phase = phaseOf(e.season?.slug);
  const cand = prev.matches.find(p =>
    !replaced.has(String(p.espn)) &&
    p.phase === phase &&
    pairKey(p.team1, p.team2) === pairKey(home, away) &&
    (!feedIds.has(String(p.espn)) || abandonedIds.has(String(p.espn))));
  if (cand) {
    replayOf.set(String(e.id), cand);
    replaced.add(String(cand.espn));
    warn(`event ${e.id} ${home} v ${away} on ${e.date.slice(0, 10)} treated as replay of match ${cand.num} (old event ${cand.espn}${abandonedIds.has(String(cand.espn)) ? ', abandoned' : ', gone'})`);
  } else if (phase === 'league') {
    // Each pair meets exactly once in the league phase. A second event for a
    // pairing whose stored match is still live on ESPN is a duplicate or a
    // reschedule published early: never number it silently.
    const dup = prev.matches.find(p => p.phase === 'league' && pairKey(p.team1, p.team2) === pairKey(home, away));
    if (dup) {
      unresolved.add(String(e.id));
      warn(`event ${e.id} ${home} v ${away} on ${e.date.slice(0, 10)} duplicates match ${dup.num} (event ${dup.espn}, still ${abandonedIds.has(String(dup.espn)) ? 'abandoned' : 'scheduled'}) - NOT added; re-run once ESPN drops or abandons the old event`);
    }
  }
}

// ------------------------------------------------------------ matchday labels
// Known league events keep their label. A new one takes the label of known
// matches on the same day (+-1). With no previous file: date-gap clustering.
const roundByDate = new Map();
for (const p of prev.matches) if (p.phase === 'league') roundByDate.set(p.date, p.round);
let maxMd = Math.max(0, ...prev.matches.map(p => Number((p.round.match(/^Matchday (\d+)$/) ?? [])[1] ?? 0)));
let md = 0, lastT = 0;
function leagueRound(e, old) {
  if (old) return old.round;
  if (!prev.matches.length) { // fresh build
    const t = Date.parse(e.date);
    if (t - lastT > 5 * 86_400_000) md++;
    lastT = t;
    return `Matchday ${md}`;
  }
  const day = new Date(e.date.slice(0, 10));
  for (const off of [0, -1, 1]) {
    const d = new Date(day); d.setUTCDate(d.getUTCDate() + off);
    const r = roundByDate.get(d.toISOString().slice(0, 10));
    if (r) return r;
  }
  maxMd++;
  warn(`event ${e.id} on ${e.date.slice(0, 10)} matches no known matchday - labelled "Matchday ${maxMd}"; fix by hand if wrong`);
  return `Matchday ${maxMd}`;
}

// ------------------------------------------------------------ build
const teams = new Map();
for (const t of prev.teams ?? []) teams.set(t.name, t);
const matches = [];
const seenNums = new Set();

for (const e of events) {
  if (replaced.has(String(e.id))) { warn(`event ${e.id} dropped (replaced by its replay)`); continue; }
  if (unresolved.has(String(e.id))) continue;
  const { c, hc, ac, home, away } = sides(e);
  for (const [x, name] of [[hc, home], [ac, away]]) {
    const t = x?.team;
    if (!t || isPlaceholder(name)) continue; // never register TBD pseudo-teams
    if (!teams.has(name)) {
      teams.set(name, {
        name, short: t.shortDisplayName ?? name, abbr: t.abbreviation ?? '',
        espnId: String(t.id), logo: t.logo ?? null, color: t.color ?? null,
      });
    }
  }

  const slug = e.season?.slug;
  const old = prevByEspn.get(String(e.id)) ?? replayOf.get(String(e.id)) ?? null;
  let round, phase, leg = null;
  if (slug === 'league-phase') {
    phase = 'league';
    round = leagueRound(e, old);
  } else {
    [round, phase] = SLUG_ROUND[slug] ?? [slug, slug];
    const note = (c.notes ?? []).map(n => n.headline).find(h => /leg/i.test(h)) ?? '';
    if (/^1st/i.test(note)) leg = 1;
    else if (/^2nd/i.test(note)) leg = 2;
    if (old?.leg) leg = old.leg;
  }

  // Orientation: keep the stored one unless a placeholder is being replaced.
  let team1 = home, team2 = away;
  if (old && !isPlaceholder(old.team1) && !isPlaceholder(old.team2)) {
    if (old.team1 === away && old.team2 === home) {
      warn(`match ${old.num}: ESPN swapped home/away (${home} v ${away}); keeping stored order ${old.team1} v ${old.team2} (scores are matched by team, picks stay valid)`);
      team1 = old.team1; team2 = old.team2;
    } else if (old.team1 !== home || old.team2 !== away) {
      warn(`match ${old.num}: teams changed ${old.team1} v ${old.team2} -> ${home} v ${away}`);
    }
  }

  const d = new Date(e.date);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const date = e.date.slice(0, 10), time = `${hh}:${mm} UTC+0`;
  if (old && (old.date !== date || old.time !== time)) warn(`match ${old.num} moved: ${old.date} ${old.time} -> ${date} ${time}`);
  if (isAbandoned(e)) warn(`event ${e.id} (${home} v ${away}, ${date}) is abandoned/postponed on ESPN - no result will be scored`);

  const venue = c.venue ? [c.venue.fullName, c.venue.address?.city].filter(Boolean).join(', ') : (old?.ground ?? '');
  const num = old?.num ?? nextNum++;
  if (seenNums.has(num)) { warn(`event ${e.id} would duplicate match ${num} - skipped`); continue; }
  seenNums.add(num);
  matches.push({
    num, espn: String(e.id), phase, round,
    ...(leg ? { leg } : {}),
    date, time, team1, team2,
    ...(phase === 'league' ? { group: 'League Phase' } : {}),
    ground: venue,
  });
}

// Matches that disappeared from the feed stay (flagged) so picks keep a target.
for (const p of prev.matches) {
  if (seenNums.has(p.num)) continue;
  warn(`match ${p.num} (${p.team1} v ${p.team2}, ${p.date}, event ${p.espn}) is no longer in the ESPN feed - kept as is`);
  matches.push(p);
  seenNums.add(p.num);
}
matches.sort((a, b) => a.num - b.num);

const out = {
  name: 'UEFA Champions League 2026-27',
  source: `${BASE}/scoreboard`,
  fetched: new Date().toISOString(),
  teams: [...teams.values()].sort((a, b) => a.name.localeCompare(b.name)),
  matches,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
const added = matches.filter(m => !prevByEspn.has(String(m.espn)) && !replayOf.has(String(m.espn))).length;
console.log(`wrote ${matches.length} matches (${added} new), ${teams.size} teams, ${warnings.length} warning(s) -> data/ucl2027.json`);

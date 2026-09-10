import { CONFIG } from './config.js';
import { TEAMS, crest, teamShort, isPlaceholder } from './teams.js';
import {
  loadSchedule, refreshScores, fetchStandings, standings, kickoff, scheduledKickoff, status, options,
  outcome, goals, topScorers, isKnockout, isWinnerOnly, placeholder, KO_ROUNDS, PHASE_LABEL,
} from './data.js';
import {
  online, currentUser, signup, login, logout, recover, resend, updatePassword, handleAuthHash,
  loadProfile, setLocalName, describe, AuthError,
} from './auth.js';
import { fetchState, fetchBallots, savePick, submitPhase, saveTrophy } from './picks.js';

const $ = sel => document.querySelector(sel);

// Bumped before every optimistic write; a background state snapshot that
// started before the bump must not clobber the player's own fresh rows.
let writeSeq = 0;

const state = {
  matches: [],
  ballots: {},      // phase -> { label, opens_at, locks_at }
  profiles: {},     // user_id -> username
  picks: {},        // "num:user_id" -> '1' | 'X' | '2'
  submissions: {},  // "phase:user_id" -> iso
  trophy: {},       // user_id -> { champion, top_scorer }
  table: null,      // ESPN standings rows, or null -> computed
  view: 'matches',
  now: new Date(),
  scorerCustom: false,
  scoresLoaded: false,
  autoScrolled: false,
  stateLoaded: false,
  authMode: null,   // null | 'login' | 'register' | 'forgot' | 'resend' | 'reset' | 'sent' | 'local'
  authBusy: false,
  pendingWrites: 0, // picks / trophy saves in flight (SUBMIT waits for them)
};

// Gólkirály shortlist. OTHER… opens free text for anyone else.
const SCORERS = [
  ['Kylian Mbappé', 'Real Madrid'], ['Vinícius Júnior', 'Real Madrid'],
  ['Erling Haaland', 'Manchester City'], ['Harry Kane', 'Bayern Munich'],
  ['Robert Lewandowski', 'Barcelona'], ['Lamine Yamal', 'Barcelona'], ['Raphinha', 'Barcelona'],
  ['Mohamed Salah', 'Liverpool'], ['Alexander Isak', 'Liverpool'],
  ['Ousmane Dembélé', 'Paris Saint-Germain'], ['Bradley Barcola', 'Paris Saint-Germain'],
  ['Julián Álvarez', 'Atlético Madrid'], ['Antoine Griezmann', 'Atlético Madrid'],
  ['Viktor Gyökeres', 'Arsenal'], ['Bukayo Saka', 'Arsenal'],
  ['Lautaro Martínez', 'Internazionale'], ['Marcus Thuram', 'Internazionale'],
  ['Serhou Guirassy', 'Borussia Dortmund'], ['Victor Osimhen', 'Galatasaray'],
  ['Benjamin Šeško', 'Manchester United'], ['Ollie Watkins', 'Aston Villa'],
  ['Rasmus Højlund', 'Napoli'], ['Samu Aghehowa', 'FC Porto'],
  ['Youssef En-Nesyri', 'Fenerbahce'], ['Michael Olise', 'Bayern Munich'],
  ['Florian Wirtz', 'Liverpool'], ['Jude Bellingham', 'Real Madrid'],
  ['Cody Gakpo', 'Liverpool'], ['Nick Woltemade', 'VfB Stuttgart'],
];

// Accent/case-insensitive compare for free-text scorer picks.
const norm = s => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function fmtTime(m) {
  return kickoff(m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDeadline(d) {
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function teamLabel(name) {
  return isPlaceholder(name) ? name : teamShort(name);
}
const me = () => currentUser();
const myId = () => me()?.id ?? null;

function myPick(m) {
  const id = myId();
  return id ? state.picks[`${m.num}:${id}`] ?? null : null;
}
function picksFor(m) {
  const out = { 1: [], X: [], 2: [] };
  const prefix = `${m.num}:`;
  for (const [key, pick] of Object.entries(state.picks)) {
    if (key.startsWith(prefix)) out[pick]?.push(state.profiles[key.slice(prefix.length)] ?? '?');
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.localeCompare(b));
  return out;
}

/* ---------- ballots ---------- */

function ballot(phase) { return state.ballots[phase] ?? null; }

// 'none' | 'upcoming' | 'open' | 'submitted' | 'locked'
function ballotState(phase) {
  const b = ballot(phase);
  if (!b) return 'none';
  if (state.now < new Date(b.opens_at)) return 'upcoming';
  if (state.now >= new Date(b.locks_at)) return 'locked';
  const id = myId();
  if (id && state.submissions[`${phase}:${id}`]) return 'submitted';
  return 'open';
}
// Membership uses the bundled kickoff (same as the server's matches table), not
// ESPN's live one, so the browser and the RLS policy always agree.
function inBallot(m) {
  const b = ballot(m.phase);
  return Boolean(b) && scheduledKickoff(m) >= new Date(b.locks_at);
}
function canPick(m) {
  return inBallot(m) && ballotState(m.phase) === 'open' && !placeholder(m);
}
function revealed(m) {
  return ballotState(m.phase) === 'locked';
}
function ballotMatches(phase) {
  return state.matches.filter(m => m.phase === phase && inBallot(m));
}
// Progress towards SUBMIT. The league ballot also needs the two trophy picks
// (they share its lock, and SUBMIT freezes them too).
function pickedCount(phase) {
  const ms = ballotMatches(phase);
  let picked = ms.filter(m => myPick(m)).length, total = ms.length;
  if (phase === 'league' && total) {
    const t = myTrophy();
    total += 2;
    picked += (t.champion ? 1 : 0) + (t.top_scorer ? 1 : 0);
  }
  return { picked, total };
}

/* ---------- tournament specials ---------- */

function finalMatch() {
  return state.matches.find(m => m.phase === 'final');
}
// Champion once the final is decided, else null.
function champion() {
  const f = finalMatch();
  if (!f || placeholder(f)) return null;
  const res = outcome(f);
  if (!res || res === 'X' || f._live) return null;
  return res === '1' ? f.team1 : f.team2;
}
function myTrophy() {
  const id = myId();
  return (id && state.trophy[id]) || { champion: null, top_scorer: null };
}
// Winner(s) of the gólkirály race - only once the tournament is decided.
function topScorerWinners() {
  if (CONFIG.TOP_SCORERS.length) return CONFIG.TOP_SCORERS;
  if (!champion()) return null;
  const tally = topScorers(state.matches);
  if (!tally) return null;
  return tally.filter(s => s.goals === tally[0].goals).map(s => s.name);
}

/* ---------- scoring ---------- */

function leaderboard() {
  const players = Object.entries(state.profiles).map(([id, name]) => ({ id, name }));
  const rows = players.map(p => ({ id: p.id, player: p.name, pts: 0, hit: 0, played: 0 }));
  const byId = new Map(rows.map(r => [r.id, r]));
  const champ = champion();
  const tops = topScorerWinners()?.map(norm);
  for (const r of rows) {
    const t = state.trophy[r.id];
    if (champ && t?.champion === champ) r.pts += CONFIG.POINTS_CHAMPION;
    if (tops?.length && tops.includes(norm(t?.top_scorer))) r.pts += CONFIG.POINTS_TOP_SCORER;
  }
  for (const m of state.matches) {
    if (!revealed(m) || !inBallot(m)) continue;
    const res = outcome(m);
    if (!res || m._live) continue;
    for (const r of rows) {
      const pick = state.picks[`${m.num}:${r.id}`];
      if (!pick) continue;
      r.played++;
      if (pick === res) { r.hit++; r.pts += CONFIG.POINTS_MATCH; }
    }
  }
  return rows.sort((a, b) => b.pts - a.pts || b.hit - a.hit || a.player.localeCompare(b.player));
}

/* ---------- rendering ---------- */

// Sticky ballot bar + scroll padding follow the real header height.
function syncHeader() {
  const hdr = document.querySelector('header');
  if (hdr) document.documentElement.style.setProperty('--hdr', `${hdr.offsetHeight}px`);
}

function render() {
  renderAuth(); // cheap no-op unless the modal state changed
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && $('#view')?.contains(ae)) return;
  state.now = new Date();
  const u = me();
  $('#player-chip').textContent = u ? u.username : 'LOG IN';
  $('#mode-banner').hidden = online();
  syncHeader();
  const view = {
    matches: renderMatches,
    table: renderTable,
    knockout: renderKnockout,
    trophy: renderTrophy,
    board: renderBoard,
  }[state.view];
  $('#view').innerHTML = view();
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === state.view));
  if (state.view === 'matches' && !state.autoScrolled && state.scoresLoaded) {
    const num = focusMatchNum();
    const target = (num != null && document.getElementById(`m${num}`)) || document.querySelector('.day-today');
    if (target) {
      target.scrollIntoView({ block: 'start' });
      state.autoScrolled = true;
    }
  }
}

// Jump target: a live match, else the next kickoff, else the last match.
const LIVE_WINDOW_MS = 150 * 60_000;
function focusMatchNum() {
  const sorted = [...state.matches].filter(m => m.phase === 'league').sort((a, b) => kickoff(a) - kickoff(b));
  const now = state.now.getTime();
  const live = sorted.find(m => {
    const k = kickoff(m).getTime();
    return now >= k && now < k + LIVE_WINDOW_MS && status(m, state.now) === 'live';
  });
  if (live) return live.num;
  const next = sorted.find(m => kickoff(m).getTime() > now);
  if (next) return next.num;
  return sorted.length ? sorted[sorted.length - 1].num : null;
}

// Status strip for a phase's ballot (top of Matches / each knockout round).
function ballotBar(phase) {
  const b = ballot(phase);
  const st = ballotState(phase);
  const label = (b?.label ?? PHASE_LABEL[phase] ?? phase).toUpperCase();
  if (st === 'none') {
    return phase === 'league'
      ? `<div class="ballot-bar none">🗳 ${label} BALLOT — not open yet</div>`
      : '';
  }
  const lock = fmtDeadline(new Date(b.locks_at));
  if (st === 'upcoming') return `<div class="ballot-bar none">🗳 ${label} BALLOT opens ${fmtDeadline(new Date(b.opens_at))} · locks ${lock}</div>`;
  if (st === 'locked') return `<div class="ballot-bar locked">🔒 ${label} BALLOT LOCKED — everyone's picks revealed</div>`;
  const { picked, total } = pickedCount(phase);
  if (st === 'submitted') return `<div class="ballot-bar done">✅ ${label} BALLOT SUBMITTED · ${picked}/${total} picks · locks ${lock}</div>`;
  const saving = state.pendingWrites > 0;
  const complete = total > 0 && picked === total && !saving;
  const hint = phase === 'league' ? 'Pick every match + champion + top scorer first' : 'Pick every match first';
  return `<div class="ballot-bar open">
    <div class="bb-text">🗳 ${label} BALLOT OPEN · <b>${picked}/${total}</b> picked · locks ${lock}</div>
    <button class="submit-ballot" data-phase="${esc(phase)}" ${complete ? '' : 'disabled'}
      title="${complete ? 'Submit — final, no changes after' : saving ? 'Saving picks…' : hint}">SUBMIT</button>
  </div>`;
}

function matchCard(m) {
  const st = m._live ? 'live' : status(m, state.now);
  const g = goals(m);
  const res = outcome(m);
  const mine = myPick(m);
  const opts = options(m);
  const editable = canPick(m);
  const shown = inBallot(m);
  const open = revealed(m);
  const picks = open ? picksFor(m) : { 1: [], X: [], 2: [] };
  const decided = st === 'finished' && !!res && !m._live;

  const optLabel = o => o === 'X' ? 'X' : isWinnerOnly(m) ? teamShort(o === '1' ? m.team1 : m.team2) : o;

  let voteArea = '';
  if (shown && (editable || mine || open)) {
    const btns = opts.map(o => {
      const isMine = mine === o;
      const cls = ['vote-btn', isMine ? 'mine' : '',
        decided && open ? (o === res ? 'hit' : isMine ? 'miss' : '') : ''].join(' ');
      const count = open && picks[o].length ? `<span class="vcount">${picks[o].length}</span>` : '';
      return `<button class="${cls}" data-vote="${o}" data-num="${m.num}" ${editable ? '' : 'disabled'}><span class="vlabel">${esc(optLabel(o))}</span>${count}</button>`;
    }).join('');
    const reveal = open && Object.values(picks).some(a => a.length)
      ? `<div class="picks-line">${opts.filter(o => picks[o].length)
          .map(o => `<span class="pick-tag ${decided && o === res ? 'ghit' : ''}">${esc(optLabel(o))}: ${picks[o].map(esc).join(', ')}</span>`)
          .join(' ')}</div>`
      : '';
    voteArea = `<div class="vote-row">${btns}</div>${reveal}`;
  } else if (shown && ballotState(m.phase) === 'upcoming') {
    voteArea = `<div class="vote-locked">⏳ BALLOT OPENS ${fmtDeadline(new Date(ballot(m.phase).opens_at)).toUpperCase()}</div>`;
  } else if (!shown && ballot(m.phase)) {
    voteArea = `<div class="vote-locked dim">NOT IN BALLOT — played before launch</div>`;
  }

  const score = g
    ? `<div class="score">${g.home}<span class="sep">:</span>${g.away}${g.et ? '<span class="pens">AET</span>' : ''}${g.pens ? `<span class="pens">(${g.pens[0]}–${g.pens[1]} p)</span>` : ''}</div>`
    : `<div class="score ko-time">${fmtTime(m)}</div>`;
  const badge = st === 'live' || m._live
    ? '<span class="badge live">● LIVE</span>'
    : st === 'finished' && g ? '<span class="badge ft">FT</span>'
    : `<span class="badge num">M${m.num}</span>`;
  const meta = [m.round + (m.leg ? ` · leg ${m.leg}` : ''), fmtDay(kickoff(m)), m.ground].filter(Boolean).join(' · ');

  return `
  <article class="match ${st} ${mine ? 'picked' : ''}" id="m${m.num}">
    <div class="match-meta">${badge}<span class="meta-text">${esc(meta)}</span></div>
    <div class="match-row">
      <div class="team home">${crest(m.team1)}<span class="tname">${esc(teamLabel(m.team1))}</span></div>
      ${score}
      <div class="team away"><span class="tname">${esc(teamLabel(m.team2))}</span>${crest(m.team2)}</div>
    </div>
    ${voteArea}
  </article>`;
}

function renderMatches() {
  const league = state.matches.filter(m => m.phase === 'league').sort((a, b) => kickoff(a) - kickoff(b));
  const days = new Map();
  for (const m of league) {
    const key = `${m.round}|${kickoff(m).toDateString()}`;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(m);
  }
  const todayKey = state.now.toDateString();
  let html = ballotBar('league');
  let lastRound = '';
  for (const [key, ms] of days) {
    const [round, dayStr] = key.split('|');
    const d = new Date(dayStr);
    const isToday = dayStr === todayKey;
    if (round !== lastRound) {
      html += `<h2 class="md-head">${esc(round.toUpperCase())}</h2>`;
      lastRound = round;
    }
    html += `<section class="day ${isToday ? 'day-today' : ''}">
      <h3 class="day-head">${isToday ? '<span class="today-tag">TODAY</span>' : ''}${fmtDay(d)}</h3>
      ${ms.map(matchCard).join('')}
    </section>`;
  }
  return html;
}

function renderTable() {
  const rows = state.table ?? standings(state.matches, 'League Phase');
  const zone = r => r.rank <= 8 ? 'qual' : r.rank <= 24 ? 'maybe' : 'out';
  return `<section class="group-card table-card">
    <h2 class="group-head">LEAGUE PHASE</h2>
    <table class="gtable">
      <thead><tr><th>#</th><th class="tl">TEAM</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>PTS</th></tr></thead>
      <tbody>${rows.map(r => `
        <tr class="${zone(r)}" title="${esc(r.note ?? '')}">
          <td>${r.rank}</td>
          <td class="tl">${crest(r.team, 'crest sm')} ${esc(teamShort(r.team))}</td>
          <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
          <td>${r.gf - r.ga > 0 ? '+' : ''}${r.gf - r.ga}</td>
          <td class="pts">${r.pts}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="special-note">1–8 straight to the round of 16 · 9–24 knockout play-off · 25–36 out${state.table ? ' · official ESPN table' : ' · computed from results'}</p>
  </section>`;
}

function renderKnockout() {
  const sections = KO_ROUNDS.map(round => {
    const ms = state.matches.filter(m => m.round === round).sort((a, b) => kickoff(a) - kickoff(b));
    if (!ms.length) return '';
    const phase = ms[0].phase;
    return `<section class="ko-round">
      <h2 class="md-head">${esc(round.toUpperCase())}</h2>
      ${ballotBar(phase)}
      ${ms.map(matchCard).join('')}
    </section>`;
  }).join('');
  if (sections) return sections;
  return `<div class="empty">Knockout fixtures appear after the league phase (draw late January).<br>
    A new ballot opens for every round.</div>`;
}

function renderTrophy() {
  const st = ballotState('league');
  const b = ballot('league');
  const editable = st === 'open';
  const locked = st === 'locked';
  const champ = champion();
  const mine = myTrophy();
  const lockTxt = b ? (locked ? 'LOCKED' : `locks ${fmtDeadline(new Date(b.locks_at))}`) : 'ballot not open yet';

  // --- champion ---
  let champBody;
  if (!locked) {
    champBody = `<div class="champ-grid">${Object.keys(TEAMS).sort().map(t => `
      <button class="champ-btn ${mine.champion === t ? 'mine' : ''}" data-champ="${esc(t)}" ${editable ? '' : 'disabled'}>
        ${crest(t, 'crest sm')}<span>${esc(teamShort(t))}</span>
      </button>`).join('')}</div>
      <p class="special-note">${editable ? 'Tap to pick — changeable until you SUBMIT the league ballot.' : st === 'submitted' ? 'Submitted — final.' : 'Not editable now.'}
      Hidden from others until the ballot locks.</p>`;
  } else {
    const rows = Object.entries(state.trophy).filter(([, s]) => s.champion)
      .map(([id, s]) => [state.profiles[id] ?? '?', s]).sort(([a], [b]) => a.localeCompare(b));
    champBody = rows.length
      ? `<div class="special-list">${rows.map(([p, s]) => `
          <div class="special-row ${champ && s.champion === champ ? 'won' : ''}">
            <span class="sp-player">${esc(p)}</span>
            <span class="sp-pick">${crest(s.champion, 'crest sm')} ${esc(s.champion)}${champ && s.champion === champ ? ' ✓' : ''}</span>
          </div>`).join('')}</div>`
      : `<div class="empty">Nobody picked a champion.</div>`;
  }

  // --- top scorer ---
  const winners = topScorerWinners();
  const winnersN = winners?.map(norm) ?? [];
  let scorerBody;
  if (!locked) {
    const sel = mine.top_scorer;
    const inList = SCORERS.some(([n]) => n === sel);
    scorerBody = `<div class="champ-grid">${SCORERS.map(([n, t]) => `
      <button class="champ-btn scorer-btn ${sel === n ? 'mine' : ''}" data-scorer="${esc(n)}" ${editable ? '' : 'disabled'}>
        ${crest(t, 'crest sm')}<span>${esc(n)}</span>
      </button>`).join('')}
      <button class="champ-btn scorer-other ${sel && !inList ? 'mine' : ''}" id="scorer-other" ${editable ? '' : 'disabled'}>
        <span class="crest sm ph">✏️</span><span>${sel && !inList ? esc(sel) : 'OTHER…'}</span>
      </button></div>
      ${state.scorerCustom && editable ? `
      <div class="fs-row scorer-custom">
        <input id="scorer-input" maxlength="40" placeholder="Player name…" autocomplete="off" value="${sel && !inList ? esc(sel) : ''}">
        <button id="scorer-set">SET</button>
      </div>` : ''}
      <p class="special-note">${editable ? 'Tap to pick — changeable until you SUBMIT the league ballot.' : st === 'submitted' ? 'Submitted — final.' : 'Not editable now.'}
      Hidden from others until the ballot locks.</p>`;
  } else {
    const rows = Object.entries(state.trophy).filter(([, s]) => s.top_scorer)
      .map(([id, s]) => [state.profiles[id] ?? '?', s]).sort(([a], [b]) => a.localeCompare(b));
    scorerBody = rows.length
      ? `<div class="special-list">${rows.map(([p, s]) => `
          <div class="special-row ${winnersN.includes(norm(s.top_scorer)) ? 'won' : ''}">
            <span class="sp-player">${esc(p)}</span>
            <span class="sp-pick">⚽ ${esc(s.top_scorer)}${winnersN.includes(norm(s.top_scorer)) ? ' ✓' : ''}</span>
          </div>`).join('')}</div>`
      : `<div class="empty">Nobody picked a gólkirály.</div>`;
  }

  return `
  <section class="special-card">
    <h2 class="group-head">🏆 CHAMPIONS LEAGUE WINNER</h2>
    <p class="special-note">${CONFIG.POINTS_CHAMPION} pts for the correct winner · ${lockTxt}</p>
    ${champBody}
  </section>
  <section class="special-card">
    <h2 class="group-head">👑 GÓLKIRÁLY — TOP SCORER</h2>
    <p class="special-note">${CONFIG.POINTS_TOP_SCORER} pts for the season's top scorer · ${lockTxt}</p>
    ${scorerBody}
  </section>
  ${scorerRaceCard()}`;
}

function scorerRaceCard() {
  const race = topScorers(state.matches) ?? [];
  const top = race.slice(0, 8);
  const lead = top.length ? top[0].goals : 0;
  const body = top.length
    ? `<div class="scorer-race">${top.map((s, i) => `
        <div class="race-row ${s.goals === lead ? 'lead' : ''}">
          <span class="race-rank">${i + 1}</span>
          <span class="race-name">${esc(s.name)}</span>
          <span class="race-goals">${s.goals} ⚽</span>
        </div>`).join('')}</div>`
    : `<div class="empty">No goals yet — scorers appear as matches finish.</div>`;
  return `
  <section class="special-card scorer-board">
    <h2 class="group-head">⚽ TOP SCORERS</h2>
    <p class="special-note">Live goal count · own goals & shootout penalties don't count</p>
    ${body}
  </section>`;
}

function scoringLegend() {
  return `
  <section class="special-card rules-card">
    <h2 class="group-head">📐 SCORING</h2>
    <div class="rule-row"><span class="rule-ico">✓</span>
      <span class="rule-lab">Correct result — 1 / X / 2 (final: winner)</span>
      <span class="rule-pts">${CONFIG.POINTS_MATCH} pts</span></div>
    <div class="rule-row"><span class="rule-ico">🏆</span>
      <span class="rule-lab">Champions League winner — Trophy tab</span>
      <span class="rule-pts">${CONFIG.POINTS_CHAMPION} pts</span></div>
    <div class="rule-row"><span class="rule-ico">👑</span>
      <span class="rule-lab">Gólkirály (top scorer) — Trophy tab</span>
      <span class="rule-pts">${CONFIG.POINTS_TOP_SCORER} pts</span></div>
    <p class="special-note">One ballot per phase: pick every match, press SUBMIT. Unsubmitted ballots lock
      automatically at the deadline. Everyone's picks stay hidden until then.</p>
  </section>`;
}

function renderBoard() {
  const rows = leaderboard();
  if (!rows.length) return scoringLegend() + `<div class="empty">No players yet.</div>`;
  const medals = ['🥇', '🥈', '🥉'];
  const anyRevealed = Object.keys(state.ballots).some(p => ballotState(p) === 'locked');
  const id = myId();
  if (!anyRevealed) {
    // Nothing to score yet: show who is in and who has submitted.
    const subs = Object.keys(state.submissions);
    return scoringLegend() + `<table class="board">
      <thead><tr><th class="tl">PLAYER</th><th>LEAGUE BALLOT</th></tr></thead>
      <tbody>${rows.sort((a, b) => a.player.localeCompare(b.player)).map(r => `
        <tr class="${r.id === id ? 'me' : ''}">
          <td class="tl">${esc(r.player)}</td>
          <td>${subs.includes(`league:${r.id}`) ? '<span class="ok">SUBMITTED ✓</span>' : '<span class="dim">draft</span>'}</td>
        </tr>`).join('')}
      </tbody></table>`;
  }
  return scoringLegend() + `<table class="board">
    <thead><tr><th>#</th><th class="tl">PLAYER</th><th>HITS</th><th>PTS</th></tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr class="${r.id === id ? 'me' : ''}">
        <td>${medals[i] ?? i + 1}</td>
        <td class="tl">${esc(r.player)}</td>
        <td>${r.hit}/${r.played}</td>
        <td class="pts">${r.pts}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

/* ---------- auth modal ---------- */

function openAuth(mode) {
  state.authMode = mode;
  state.authError = '';
  state.authErrorCode = '';
  renderAuth();
  setTimeout(() => $('#auth-modal input:not([type=hidden])')?.focus(), 50);
}
function closeAuth() {
  state.authMode = null;
  document.activeElement?.blur?.();
  renderAuth();
}

// Rebuilds the modal only when its state actually changed, and carries typed
// values across rebuilds (busy / error toggles) so nothing the user typed is lost.
function renderAuth() {
  const modal = $('#auth-modal');
  const mode = state.authMode;
  modal.hidden = !mode;
  if (!mode) { modal.dataset.sig = ''; modal.dataset.mode = ''; return; }
  const sig = [mode, state.authBusy, state.authError, state.authInfo ?? ''].join('|');
  if (modal.dataset.sig === sig) return;
  const sameMode = modal.dataset.mode === mode;
  modal.dataset.sig = sig;
  modal.dataset.mode = mode;
  const kept = {};
  if (sameMode) for (const i of modal.querySelectorAll('input')) kept[i.id] = i.value;

  const busy = state.authBusy ? 'disabled' : '';
  const err = state.authError ? `<p class="auth-error">${esc(state.authError)}</p>` : '';
  const field = (id, ph, type = 'text', extra = '', ac = 'off') =>
    `<input id="${id}" type="${type}" placeholder="${ph}" autocomplete="${ac}" ${extra} ${busy}>`;
  let body;
  if (mode === 'local') {
    body = `<h2>LOCAL MODE</h2>
      <p class="modal-hint">No Supabase configured — picks stay on this device.</p>
      ${field('a-name', 'Your name', 'text', 'maxlength="20"')}
      ${err}<button id="a-local" ${busy}>ENTER</button>`;
  } else if (mode === 'login') {
    const resend = state.authErrorCode === 'email_not_confirmed'
      ? ` · <a href="#" data-auth="resend">Resend confirmation</a>` : '';
    body = `<h2>LOG IN</h2>
      ${field('a-user', CONFIG.LOGIN_URL ? 'Username or email' : 'Email', 'text', '', 'username')}
      ${field('a-pass', 'Password', 'password', '', 'current-password')}
      ${err}<button id="a-login" ${busy}>ENTER ARENA</button>
      <p class="modal-hint"><a href="#" data-auth="register">Create account</a> · <a href="#" data-auth="forgot">Forgot password</a>${resend}</p>`;
  } else if (mode === 'register') {
    body = `<h2>REGISTER</h2>
      ${field('a-email', 'Email', 'email', '', 'email')}
      ${field('a-name', 'Username (shown on the board)', 'text', 'maxlength="20"', 'username')}
      ${field('a-pass', 'Password (min 6)', 'password', '', 'new-password')}
      ${field('a-invite', 'Invite code', 'text')}
      ${err}<button id="a-register" ${busy}>CREATE ACCOUNT</button>
      <p class="modal-hint">You'll get a confirmation email. Click the link, then log in.<br>
      <a href="#" data-auth="login">Back to log in</a></p>`;
  } else if (mode === 'forgot') {
    body = `<h2>RESET PASSWORD</h2>
      ${field('a-email', 'Email', 'email', '', 'email')}
      ${err}<button id="a-forgot" ${busy}>SEND RESET LINK</button>
      <p class="modal-hint"><a href="#" data-auth="login">Back to log in</a></p>`;
  } else if (mode === 'resend') {
    body = `<h2>RESEND CONFIRMATION</h2>
      ${field('a-email', 'Email you registered with', 'email', '', 'email')}
      ${err}<button id="a-resend" ${busy}>SEND LINK AGAIN</button>
      <p class="modal-hint"><a href="#" data-auth="login">Back to log in</a></p>`;
  } else if (mode === 'reset') {
    body = `<h2>NEW PASSWORD</h2>
      ${field('a-pass', 'New password (min 6)', 'password', '', 'new-password')}
      ${err}<button id="a-reset" ${busy}>SAVE PASSWORD</button>`;
  } else if (mode === 'sent') {
    body = `<h2>CHECK YOUR EMAIL</h2>
      <p class="modal-hint">${esc(state.authInfo ?? 'We sent you a link.')}</p>
      <button id="a-close" ${busy}>OK</button>`;
  }
  modal.querySelector('.modal-box').innerHTML = body;
  for (const i of modal.querySelectorAll('input')) if (kept[i.id] != null) i.value = kept[i.id];
}

// Runs an auth call with the modal in busy state. Field values are read by the
// caller BEFORE this runs (the rebuild keeps them anyway, belt and braces).
async function authAction(fn) {
  state.authBusy = true; state.authError = ''; state.authErrorCode = ''; renderAuth();
  try {
    await fn();
  } catch (e) {
    console.error(e);
    state.authError = describe(e);
    state.authErrorCode = e?.code ?? '';
  } finally {
    state.authBusy = false;
    renderAuth();
    setTimeout(() => $('#auth-modal input')?.focus(), 30);
  }
}

const val = id => $(`#${id}`)?.value ?? '';

async function afterLogin() {
  writeSeq++; // anything fetched for the previous identity is stale
  closeAuth();
  render();
  const first = !state.stateLoaded;
  await loadState();
  // First full layout with ballot state: jump to the live / next match now.
  if (first && state.stateLoaded) state.autoScrolled = false;
  render();
}

/* ---------- events ---------- */

document.addEventListener('click', async e => {
  const tab = e.target.closest('.tab');
  if (tab) {
    if (tab.dataset.view === 'matches' && state.view !== 'matches') state.autoScrolled = false;
    const changed = state.view !== tab.dataset.view;
    state.view = tab.dataset.view;
    render();
    if (changed && state.view !== 'matches') window.scrollTo(0, 0);
    return;
  }

  if (e.target.closest('#player-chip')) {
    if (!me()) { openAuth(online() ? 'login' : 'local'); return; }
    if (confirm(`Log out ${me().username}?`)) {
      writeSeq++;
      await logout();
      if (!online()) localStorage.removeItem('ucl.localName');
      state.picks = {}; state.submissions = {}; state.trophy = {};
      render();
      openAuth(online() ? 'login' : 'local');
    }
    return;
  }

  // auth modal
  const sw = e.target.closest('[data-auth]');
  if (sw) { e.preventDefault(); openAuth(sw.dataset.auth); return; }
  if (e.target.closest('#a-close')) { closeAuth(); if (!me()) openAuth('login'); return; }
  if (e.target.closest('#a-local')) {
    const n = val('a-name').trim();
    if (!n) return;
    setLocalName(n);
    await afterLogin();
    return;
  }
  if (e.target.closest('#a-login')) {
    const user = val('a-user'), pass = val('a-pass');
    await authAction(async () => {
      await login(user, pass);
      await afterLogin();
    });
    return;
  }
  if (e.target.closest('#a-register')) {
    const form = { email: val('a-email'), username: val('a-name'), password: val('a-pass'), invite: val('a-invite') };
    await authAction(async () => {
      const r = await signup(form);
      if (r.needsConfirm) {
        state.authInfo = `Confirmation link sent to ${form.email.trim()}. Open it, then log in.`;
        state.authMode = 'sent';
      } else {
        await afterLogin();
      }
    });
    return;
  }
  if (e.target.closest('#a-forgot')) {
    const email = val('a-email');
    await authAction(async () => {
      await recover(email);
      state.authInfo = 'If that email is registered, a reset link is on its way.';
      state.authMode = 'sent';
    });
    return;
  }
  if (e.target.closest('#a-resend')) {
    const email = val('a-email');
    await authAction(async () => {
      await resend(email);
      state.authInfo = 'If that email is registered and unconfirmed, a new confirmation link is on its way.';
      state.authMode = 'sent';
    });
    return;
  }
  if (e.target.closest('#a-reset')) {
    const pass = val('a-pass');
    await authAction(async () => {
      await updatePassword(pass);
      toast('Password saved ✓', 'ok');
      await afterLogin();
    });
    return;
  }

  // ballot submit
  const sub = e.target.closest('.submit-ballot');
  if (sub && !sub.disabled) {
    if (!me()) { openAuth(online() ? 'login' : 'local'); return; }
    const phase = sub.dataset.phase;
    const { picked, total } = pickedCount(phase);
    if (picked !== total) { toast(phase === 'league' ? 'Pick every match, champion and top scorer first' : 'Pick every match first'); return; }
    if (state.pendingWrites > 0) { toast('Still saving a pick — try again in a second'); return; }
    if (!confirm(`Submit your ${ballot(phase)?.label ?? phase} ballot?\n\nFINAL — no changes afterwards.`)) return;
    const key = `${phase}:${myId()}`;
    writeSeq++;
    state.pendingWrites++;
    state.submissions[key] = new Date().toISOString(); // optimistic
    render();
    try {
      await submitPhase(phase);
      toast('Ballot submitted ✅', 'ok');
    } catch (err) {
      console.error(err);
      delete state.submissions[key];
      if (err instanceof AuthError && (err.code === 'session_expired' || err.code === 'no_session')) { render(); openAuth('login'); return; }
      toast(err.locked ? 'Ballot is closed' : 'Submit failed — check connection');
    } finally {
      state.pendingWrites--;
      writeSeq++; // snapshots that started during the write are stale
    }
    await loadState().catch(() => {});
    render();
    return;
  }

  // trophy picks
  if (e.target.closest('#scorer-other')) {
    if (!me()) { openAuth(online() ? 'login' : 'local'); return; }
    state.scorerCustom = !state.scorerCustom;
    render();
    return;
  }
  if (e.target.closest('#scorer-set')) {
    const v = $('#scorer-input').value.trim();
    if (!v) { toast('Type a player name'); return; }
    document.activeElement?.blur?.(); // let render() replace the input
    state.scorerCustom = false;
    await setTrophy({ top_scorer: v });
    return;
  }
  const scorerBtn = e.target.closest('.scorer-btn');
  if (scorerBtn && !scorerBtn.disabled) {
    state.scorerCustom = false;
    await setTrophy({ top_scorer: scorerBtn.dataset.scorer });
    return;
  }
  const champBtn = e.target.closest('.champ-btn[data-champ]');
  if (champBtn && !champBtn.disabled) {
    await setTrophy({ champion: champBtn.dataset.champ });
    return;
  }

  // match pick
  const btn = e.target.closest('.vote-btn');
  if (btn && !btn.disabled) {
    if (!me()) { openAuth(online() ? 'login' : 'local'); return; }
    const num = Number(btn.dataset.num);
    const pick = btn.dataset.vote;
    const key = `${num}:${myId()}`;
    const prev = state.picks[key];
    writeSeq++;
    state.pendingWrites++;
    state.picks[key] = pick; // optimistic
    render();
    try {
      // One upsert at a time per match: a double-tap must end with the last tap.
      const run = () => savePick(num, pick);
      const p = (saving.get(key) ?? Promise.resolve()).then(run, run);
      saving.set(key, p);
      await p;
    } catch (err) {
      console.error(err);
      if (state.picks[key] === pick) { if (prev) state.picks[key] = prev; else delete state.picks[key]; }
      if (err instanceof AuthError && (err.code === 'session_expired' || err.code === 'no_session')) { openAuth('login'); return; }
      toast(err.locked ? 'Ballot is closed' : 'Pick failed — check connection');
      if (err.locked) loadState().then(render).catch(() => {});
    } finally {
      state.pendingWrites--;
      writeSeq++; // snapshots that started during the write are stale
      render();
    }
  }
});
const saving = new Map(); // "num:user" -> last save promise

async function setTrophy(patch) {
  if (!me()) { openAuth(online() ? 'login' : 'local'); return; }
  const id = myId();
  const prev = state.trophy[id] ?? { champion: null, top_scorer: null };
  writeSeq++;
  state.pendingWrites++;
  state.trophy[id] = { ...prev, ...patch }; // optimistic
  render();
  try {
    await saveTrophy(patch); // only the changed column goes to the server
    toast(patch.champion ? 'Champion pick saved 🏆' : 'Gólkirály pick saved 👑', 'ok');
  } catch (err) {
    console.error(err);
    state.trophy[id] = prev;
    if (err instanceof AuthError && (err.code === 'session_expired' || err.code === 'no_session')) { openAuth('login'); return; }
    toast(err.locked ? 'Ballot is closed' : 'Save failed — check connection');
  } finally {
    state.pendingWrites--;
    writeSeq++; // snapshots that started during the write are stale
    render();
  }
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.matches('#auth-modal input')) {
    e.preventDefault();
    const btn = $('#auth-modal .modal-box > button');
    if (btn && !btn.disabled) btn.click();
    return;
  }
  if (e.target.matches('#scorer-input')) { e.preventDefault(); $('#scorer-set').click(); }
});

function toast(msg, kind = 'err') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('ok', kind === 'ok');
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------- data loading ---------- */

const loggedOut = e => e instanceof AuthError && (e.code === 'session_expired' || e.code === 'no_session');

async function loadState() {
  if (!me()) {
    // Deadlines are public: show when the ballot opens even before login.
    try { state.ballots = await fetchBallots(); } catch (e) { console.warn('ballots', e); }
    return;
  }
  const seq = writeSeq, uid = myId();
  try {
    const s = await fetchState();
    if (myId() !== uid) return; // logged out / switched user while in flight
    if (seq === writeSeq && state.pendingWrites === 0) {
      Object.assign(state, s);
    } else {
      // A write raced this snapshot: server rows underneath, local rows on top.
      const trophy = { ...s.trophy };
      if (state.trophy[uid]) {
        trophy[uid] = { ...(s.trophy[uid] ?? {}),
          ...Object.fromEntries(Object.entries(state.trophy[uid]).filter(([, v]) => v != null)) };
      }
      Object.assign(state, {
        ballots: s.ballots, profiles: s.profiles,
        picks: { ...s.picks, ...state.picks },
        submissions: { ...s.submissions, ...state.submissions },
        trophy,
      });
    }
    state.stateLoaded = true;
  } catch (e) {
    if (myId() !== uid) return;
    console.warn('state load failed', e);
    if (loggedOut(e)) {
      state.picks = {}; state.submissions = {}; state.trophy = {};
      openAuth('login');
    } else if (!state.stateLoaded) {
      toast('No connection — retrying');
    }
  }
}

/* ---------- boot ---------- */

async function boot() {
  const link = handleAuthHash();
  state.matches = await loadSchedule();
  render();

  if (link?.type === 'recovery') {
    openAuth('reset');
  } else if (link?.type === 'error') {
    toast(link.message || 'Link expired — request a new one');
    if (!me()) openAuth(online() ? 'login' : 'local');
  } else if (link?.type) {
    toast('Email confirmed ✓ — welcome', 'ok');
    await loadProfile().catch(() => {});
  } else if (!me()) {
    openAuth(online() ? 'login' : 'local');
  } else if (online()) {
    loadProfile().then(render).catch(e => { if (loggedOut(e)) openAuth('login'); });
  }

  await loadState();
  render();
  if ('ResizeObserver' in window) new ResizeObserver(syncHeader).observe(document.querySelector('header'));
  else window.addEventListener('resize', syncHeader);

  refreshScores(state.matches, { full: true }).then(() => { state.scoresLoaded = true; render(); });
  fetchStandings().then(rows => { if (rows) { state.table = rows; render(); } });

  setInterval(async () => {
    try {
      await Promise.all([refreshScores(state.matches), loadState()]);
      render();
    } catch (e) {
      console.warn('refresh failed', e);
    }
  }, CONFIG.REFRESH_MS);
  setInterval(async () => {
    await refreshScores(state.matches, { full: true }).catch(() => {});
    const rows = await fetchStandings();
    if (rows) state.table = rows;
    render();
  }, CONFIG.FULL_REFRESH_MS);
}

boot();

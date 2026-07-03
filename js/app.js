import { CONFIG } from './config.js';
import { TEAMS, flag } from './teams.js';
import {
  loadSchedule, refreshScores, kickoff, status, votingOpen, placeholder,
  unlockTime, isKnockout, goals, goals90, outcome, standings, topScorers, KO_ROUNDS,
  fetchTopScorers,
} from './data.js';
import {
  online, playerName, setPlayerName, fetchVotes, castVote, playersFrom,
  fetchSpecials, saveSpecial, fetchGuesses, castGuess,
  claimPlayer, isClaimed, setClaimed,
} from './votes.js';

const $ = sel => document.querySelector(sel);

const state = {
  matches: [],
  votes: {},        // "num:player" -> pick
  guesses: {},      // "num:player" -> [home, away]
  specials: {},     // player -> { champion, final_score, top_scorer }
  champPick: null,  // champion selection awaiting OK (not saved yet)
  scorerPick: null, // gólkirály selection awaiting OK
  scorerCustom: false, // free-text scorer input open
  view: 'matches',
  now: new Date(),
  autoScrolled: false, // have we jumped to the focus match yet this matches-view visit
  scoresLoaded: false, // first refreshScores done — layout is stable enough to jump
  scorerRace: [],   // live tournament top-scorer tally from ESPN [{name, goals}]
};

// Gólkirály shortlist: realistic Golden Boot candidates from qualified teams.
// "OTHER" opens a free-text field for everyone else.
const SCORERS = [
  ['Kylian Mbappé', 'France'], ['Erling Haaland', 'Norway'],
  ['Harry Kane', 'England'], ['Lionel Messi', 'Argentina'],
  ['Lautaro Martínez', 'Argentina'], ['Julián Álvarez', 'Argentina'],
  ['Vinícius Júnior', 'Brazil'], ['Raphinha', 'Brazil'], ['Endrick', 'Brazil'],
  ['Lamine Yamal', 'Spain'], ['Mikel Oyarzabal', 'Spain'],
  ['Jamal Musiala', 'Germany'], ['Florian Wirtz', 'Germany'],
  ['Kai Havertz', 'Germany'], ['Jude Bellingham', 'England'],
  ['Bukayo Saka', 'England'], ['Cristiano Ronaldo', 'Portugal'],
  ['Rafael Leão', 'Portugal'], ['Cody Gakpo', 'Netherlands'],
  ['Memphis Depay', 'Netherlands'], ['Romelu Lukaku', 'Belgium'],
  ['Darwin Núñez', 'Uruguay'], ['Luis Díaz', 'Colombia'],
  ['Mohamed Salah', 'Egypt'], ['Sadio Mané', 'Senegal'],
  ['Son Heung-min', 'South Korea'], ['Santiago Giménez', 'Mexico'],
  ['Raúl Jiménez', 'Mexico'], ['Jonathan David', 'Canada'],
  ['Christian Pulisic', 'USA'], ['Ayoub El Kaabi', 'Morocco'],
  ['Marcus Thuram', 'France'],
];

// Accent/case-insensitive compare for free-text scorer picks.
const norm = s => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/* ---------- helpers ---------- */

const GROUPS = 'ABCDEFGHIJKL'.split('').map(c => `Group ${c}`);

function slotLabel(slot) {
  let m = slot.match(/^(\d)([A-L])$/);
  if (m) return `${['1st', '2nd', '3rd'][m[1] - 1]} ${m[2]}`;
  m = slot.match(/^W(\d+)$/);
  if (m) return `Winner ${m[1]}`;
  m = slot.match(/^L(\d+)$/);
  if (m) return `Loser ${m[1]}`;
  m = slot.match(/^3([A-L/]+)$/);
  if (m) return `3rd ${m[1]}`;
  return slot;
}

function teamLabel(name) {
  return placeholderName(name) ? slotLabel(name) : name;
}
function placeholderName(name) {
  return /^([WL]\d+|\d[A-L])$|\//.test(name);
}

function fmtTime(m) {
  return kickoff(m).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function myPick(m) {
  return state.votes[`${m.num}:${playerName()}`] ?? null;
}

function myGuess(m) {
  return state.guesses[`${m.num}:${playerName()}`] ?? null;
}

function guessesFor(m) {
  const out = [];
  const prefix = `${m.num}:`;
  for (const [key, g] of Object.entries(state.guesses)) {
    if (key.startsWith(prefix)) out.push({ player: key.slice(prefix.length), g });
  }
  return out.sort((a, b) => a.player.localeCompare(b.player));
}

// EXACT judges on the 90-minute score, betting style — ET goals don't count.
function exactHit(m, g) {
  const res = goals90(m);
  return res && g && g[0] === res.home && g[1] === res.away;
}

function votesFor(m) {
  const out = { 1: [], X: [], 2: [] };
  const prefix = `${m.num}:`;
  for (const [key, pick] of Object.entries(state.votes)) {
    if (key.startsWith(prefix)) out[pick]?.push(key.slice(prefix.length));
  }
  return out;
}

/* ---------- tournament specials ---------- */

function finalMatch() {
  return state.matches.find(m => m.round === 'Final');
}
function firstKnockoff() {
  // champion picks lock when the knockout stage begins
  const ko = state.matches.filter(isKnockout).sort((a, b) => kickoff(a) - kickoff(b));
  return ko[0];
}
// Champion team name once the final is decided, else null.
function worldChampion() {
  const f = finalMatch();
  if (!f || placeholder(f)) return null;
  const res = outcome(f);
  if (!res || f._live) return null;
  return res === '1' ? f.team1 : f.team2;
}
function mySpecial() {
  return state.specials[playerName()] ?? { champion: null, final_score: null, top_scorer: null };
}

// Champion + gólkirály picks close at Netherlands–Japan kickoff (Sun Jun 14,
// 22:00 CEST) — Márk's rule, well before knockout so group form can't be ridden.
function specialsDeadline() {
  const m = state.matches.find(x =>
    (x.team1 === 'Netherlands' && x.team2 === 'Japan') ||
    (x.team1 === 'Japan' && x.team2 === 'Netherlands'));
  return m ? kickoff(m) : new Date('2026-06-14T22:00:00+02:00');
}

// Winner(s) of the gólkirály race — only once the tournament is decided.
// Config override first (failsafe), else openfootball goal-list tally.
function worldTopScorers() {
  if (CONFIG.TOP_SCORERS.length) return CONFIG.TOP_SCORERS;
  if (!worldChampion()) return null; // race open until the final is played
  const tally = topScorers(state.matches);
  if (!tally) return null;
  return tally.filter(s => s.goals === tally[0].goals).map(s => s.name);
}

/* ---------- scoring ---------- */

function leaderboard() {
  const guessPlayers = Object.keys(state.guesses).map(k => k.slice(k.indexOf(':') + 1));
  const players = [...new Set([
    ...playersFrom(state.votes), ...Object.keys(state.specials), ...guessPlayers,
  ])].sort((a, b) => a.localeCompare(b));
  const rows = players.map(p => ({ player: p, pts: 0, hit: 0, played: 0, exact: 0 }));
  const byName = new Map(rows.map(r => [r.player, r]));
  const champ = worldChampion();
  if (champ) {
    for (const p of players) {
      if (state.specials[p]?.champion === champ) byName.get(p).pts += CONFIG.POINTS_CHAMPION;
    }
  }
  const tops = worldTopScorers()?.map(norm);
  if (tops?.length) {
    for (const p of players) {
      if (tops.includes(norm(state.specials[p]?.top_scorer))) {
        byName.get(p).pts += CONFIG.POINTS_TOP_SCORER;
      }
    }
  }
  for (const m of state.matches) {
    const res = outcome(m);
    if (!res || m._live) continue;
    for (const p of players) {
      const row = byName.get(p);
      const pick = state.votes[`${m.num}:${p}`];
      if (pick) {
        row.played++;
        if (pick === res) {
          row.hit++;
          row.pts += isKnockout(m) ? CONFIG.POINTS_KO : CONFIG.POINTS_GROUP;
        }
      }
      if (exactHit(m, state.guesses[`${m.num}:${p}`])) {
        row.exact++;
        row.pts += CONFIG.POINTS_EXACT;
      }
    }
  }
  return rows.sort((a, b) => b.pts - a.pts || b.hit - a.hit || a.player.localeCompare(b.player));
}

/* ---------- rendering ---------- */

function render() {
  // Don't clobber an input the user is typing in (refresh tick re-renders).
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && $('#view')?.contains(ae)) return;
  state.now = new Date();
  $('#player-chip').textContent = playerName() || 'SET NAME';
  $('#mode-banner').hidden = online();
  const view = {
    matches: renderMatches,
    groups: renderGroups,
    knockout: renderKnockout,
    trophy: renderTrophy,
    board: renderBoard,
  }[state.view];
  $('#view').innerHTML = view();
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === state.view));
  // Jump to the focus match — but only once scores/picks have loaded, so the
  // finished cards above it have their final height and don't shove it away.
  if (state.view === 'matches' && !state.autoScrolled && state.scoresLoaded) {
    const num = focusMatchNum();
    const target = (num != null && document.getElementById(`m${num}`))
      || document.querySelector('.day-today');
    if (target) {
      target.scrollIntoView({ block: 'start' }); // scroll-padding-top clears the sticky header
      state.autoScrolled = true; // latch until the user leaves & re-enters Matches
    }
  }
}

// The match the app should jump to:
//   1. a game in play — but only one whose kickoff is within the live window,
//      so a stale _live flag left on an old match can't drag the jump back
//   2. else the next match that hasn't kicked off (rolls to the next day)
//   3. else the last match (tournament over)
const LIVE_WINDOW_MS = 150 * 60_000; // 90' + ET + pens + halftime headroom
function focusMatchNum() {
  const sorted = [...state.matches].sort((a, b) => kickoff(a) - kickoff(b));
  const now = state.now.getTime();
  // status()==='live' covers both the live feed and the post-kickoff window;
  // the time guard discards a stale flag stuck on a long-finished match.
  // (A live match carries a *current* score.ft, so don't test ft here.)
  const live = sorted.find(m => {
    const k = kickoff(m).getTime();
    return now >= k && now < k + LIVE_WINDOW_MS && status(m, state.now) === 'live';
  });
  if (live) return live.num;
  const next = sorted.find(m => kickoff(m).getTime() > now);
  if (next) return next.num;
  return sorted.length ? sorted[sorted.length - 1].num : null;
}

function matchCard(m) {
  const st = m._live ? 'live' : status(m, state.now);
  const g = goals(m);
  const open = votingOpen(m, state.now);
  const mine = myPick(m);
  const res = outcome(m);
  const ko = isKnockout(m);
  const picks = votesFor(m);
  const locked = !open;
  // Hit/miss coloring only once the match is decided — a live running score
  // would paint picks wrong (KO at 1:1 makes outcome 'X', nobody's pick), and
  // a KO tie at FT stays undecided until pens reach the feed.
  const decided = st === 'finished' && !!res && !(ko && res === 'X');

  const opts = ko ? ['1', '2'] : ['1', 'X', '2'];
  const voteBtns = opts.map(o => {
    const names = picks[o];
    const isMine = mine === o;
    const cls = [
      'vote-btn',
      isMine ? 'mine' : '',
      decided ? (o === res ? 'hit' : isMine ? 'miss' : '') : '',
    ].join(' ');
    const label = o === '1' ? (ko ? teamShort(m.team1) : '1')
                : o === '2' ? (ko ? teamShort(m.team2) : '2') : 'X';
    // Counts stay hidden until kickoff — fully blind voting.
    const count = locked && names.length ? `<span class="vcount">${names.length}</span>` : '';
    return `<button class="${cls}" data-vote="${o}" data-num="${m.num}"
      ${locked || placeholder(m) ? 'disabled' : ''}>${label}${count}</button>`;
  }).join('');

  // Friends' picks revealed once voting locks.
  const reveal = locked && Object.values(picks).some(a => a.length)
    ? `<div class="picks-line">${opts.filter(o => picks[o].length)
        .map(o => `<span class="pick-tag">${o === 'X' ? 'X' : o === '1' ? teamShort(m.team1) : teamShort(m.team2)}: ${picks[o].map(esc).join(', ')}</span>`)
        .join(' ')}</div>`
    : '';

  // Exact score: inputs while open, revealed guesses (✓ = +5) once locked.
  const mg = myGuess(m);
  const guessRow = !locked
    ? `<div class="guess-row" data-num="${m.num}">
        <span class="guess-lab">EXACT</span>
        <input class="gh" type="number" min="0" max="30" inputmode="numeric" placeholder="–" value="${mg ? mg[0] : ''}">
        <span class="gsep">:</span>
        <input class="ga" type="number" min="0" max="30" inputmode="numeric" placeholder="–" value="${mg ? mg[1] : ''}">
        <button class="guess-save">OK</button>
      </div>`
    : '';
  const gl = guessesFor(m);
  // ✓ only after FT — a live running score would flash exact hits mid-match.
  const xh = g => st === 'finished' && exactHit(m, g);
  const guessReveal = locked && gl.length
    ? `<div class="picks-line">${gl.map(({ player, g }) =>
        `<span class="pick-tag ${xh(g) ? 'ghit' : ''}">${esc(player)} ${g[0]}:${g[1]}${xh(g) ? ' ✓' : ''}</span>`).join('')}</div>`
    : '';

  const score = g
    ? `<div class="score">${g.home}<span class="sep">:</span>${g.away}${g.pens ? `<span class="pens">(${g.pens[0]}–${g.pens[1]} p)</span>` : ''}</div>`
    : `<div class="score ko-time">${fmtTime(m)}</div>`;

  const badge = st === 'live' || m._live
    ? '<span class="badge live">● LIVE</span>'
    : st === 'finished' && g ? '<span class="badge ft">FT</span>'
    : `<span class="badge num">M${m.num}</span>`;

  // Voting not unlocked yet — show when it opens instead of buttons.
  const unlock = unlockTime(m);
  const future = state.now < unlock;
  const unlockLabel = unlock.toDateString() === state.now.toDateString()
    ? `TODAY ${unlock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : unlock.toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase();
  const voteArea = future
    ? `<div class="vote-locked">⏳ VOTING OPENS ${unlockLabel}</div>`
    : `<div class="vote-row">${voteBtns}</div>${guessRow}${reveal}${guessReveal}`;

  return `
  <article class="match ${st}" id="m${m.num}">
    <div class="match-meta">
      ${badge}
      <span class="meta-text">${m.group ? m.group.replace('Group ', 'GRP ') : esc(m.round)} · ${esc(m.ground)}</span>
    </div>
    <div class="match-row">
      <div class="team home"><span class="flag">${flag(m.team1)}</span><span class="tname">${esc(teamLabel(m.team1))}</span></div>
      ${score}
      <div class="team away"><span class="tname">${esc(teamLabel(m.team2))}</span><span class="flag">${flag(m.team2)}</span></div>
    </div>
    ${voteArea}
  </article>`;
}

function teamShort(name) {
  if (placeholderName(name)) return slotLabel(name);
  const map = { 'Bosnia & Herzegovina': 'Bosnia', 'Czech Republic': 'Czechia', 'South Africa': 'S. Africa', 'South Korea': 'S. Korea', 'Saudi Arabia': 'Saudi A.', 'New Zealand': 'N. Zealand', 'Ivory Coast': 'Ivory C.' };
  return map[name] ?? name;
}

// Cross-check an exact-score guess against the 1X2 pick. Returns an error
// message on contradiction, null when consistent (or no pick yet).
// Knockout: a draw guess fits any pick — pens decide the winner.
function guessConflict(match, pick, h, a) {
  if (!match || !pick) return null;
  const dir = h > a ? '1' : h < a ? '2' : 'X';
  if (dir === pick) return null;
  if (isKnockout(match) && dir === 'X') return null;
  const label = {
    1: `${teamShort(match.team1)} win`,
    2: `${teamShort(match.team2)} win`,
    X: 'draw',
  };
  return `${h}:${a} = ${label[dir]}, but your pick is ${label[pick]}`;
}

function renderMatches() {
  const days = new Map();
  const sorted = [...state.matches].sort((a, b) => kickoff(a) - kickoff(b));
  for (const m of sorted) {
    const key = kickoff(m).toDateString();
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(m);
  }
  const todayKey = state.now.toDateString();
  let html = '';
  for (const [key, ms] of days) {
    const d = new Date(key);
    const isToday = key === todayKey;
    html += `<section class="day ${isToday ? 'day-today' : ''}">
      <h2 class="day-head">${isToday ? '<span class="today-tag">TODAY</span>' : ''}${fmtDay(d)}</h2>
      ${ms.map(matchCard).join('')}
    </section>`;
  }
  return html;
}

function renderGroups() {
  return `<div class="groups-grid">` + GROUPS.map(gr => {
    const rows = standings(state.matches, gr);
    return `<section class="group-card">
      <h2 class="group-head">${gr.toUpperCase()}</h2>
      <table class="gtable">
        <thead><tr><th></th><th class="tl">TEAM</th><th>P</th><th>GD</th><th>PTS</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr class="${i < 2 ? 'qual' : i === 2 ? 'maybe' : ''}">
            <td>${i + 1}</td>
            <td class="tl">${flag(r.team)} ${esc(teamShort(r.team))}</td>
            <td>${r.p}</td><td>${r.gf - r.ga > 0 ? '+' : ''}${r.gf - r.ga}</td>
            <td class="pts">${r.pts}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
  }).join('') + `</div>`;
}

function renderKnockout() {
  return KO_ROUNDS.map(round => {
    const ms = state.matches.filter(m => m.round === round)
      .sort((a, b) => kickoff(a) - kickoff(b));
    if (!ms.length) return '';
    return `<section class="ko-round">
      <h2 class="day-head">${esc(round.toUpperCase())}</h2>
      ${ms.map(matchCard).join('')}
    </section>`;
  }).join('');
}

function renderTrophy() {
  const deadline = specialsDeadline();
  const fin = finalMatch();
  const champLocked = state.now >= deadline;
  const scoreLocked = fin ? state.now >= kickoff(fin) : false;
  const champ = worldChampion();
  const mine = mySpecial();
  const fmtDeadline = d => d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  // --- champion section ---
  let champBody;
  if (!champLocked && mine.champion) {
    // One-shot pick already made — show it, no way back.
    champBody = `
      <div class="special-row champ-final">
        <span class="sp-player">YOUR PICK</span>
        <span class="sp-pick">${flag(mine.champion)} ${esc(mine.champion)} 🔒</span>
      </div>
      <p class="special-note">Pick is final — it can't be changed. Hidden from others
      until the picks lock.</p>`;
  } else if (!champLocked) {
    const sel = state.champPick;
    champBody = `<div class="champ-grid">${Object.keys(TEAMS).map(t => `
      <button class="champ-btn ${sel === t ? 'mine' : ''}" data-champ="${esc(t)}">
        <span class="flag">${flag(t)}</span><span>${esc(teamShort(t))}</span>
      </button>`).join('')}</div>
      ${sel ? `
      <div class="champ-confirm">
        <span class="confirm-txt">${flag(sel)} ${esc(sel)} — final answer? No changes later.</span>
        <button id="champ-ok">OK</button>
      </div>` : ''}
      <p class="special-note">One shot — once you press OK the pick is locked forever.
      Hidden from others until the picks lock.</p>`;
  } else {
    const rows = Object.entries(state.specials)
      .filter(([, s]) => s.champion)
      .sort(([a], [b]) => a.localeCompare(b));
    champBody = rows.length
      ? `<div class="special-list">${rows.map(([p, s]) => `
          <div class="special-row ${champ && s.champion === champ ? 'won' : ''}">
            <span class="sp-player">${esc(p)}</span>
            <span class="sp-pick">${flag(s.champion)} ${esc(s.champion)}${champ && s.champion === champ ? ' ✓' : ''}</span>
          </div>`).join('')}</div>`
      : `<div class="empty">Nobody dared to pick a champion.</div>`;
  }

  // --- gólkirály (top scorer) section — same lifecycle as champion ---
  const winners = worldTopScorers();
  const winnersN = winners?.map(norm) ?? [];
  let scorerBody;
  if (!champLocked && mine.top_scorer) {
    scorerBody = `
      <div class="special-row champ-final">
        <span class="sp-player">YOUR PICK</span>
        <span class="sp-pick">⚽ ${esc(mine.top_scorer)} 🔒</span>
      </div>
      <p class="special-note">Pick is final — it can't be changed. Hidden from others
      until the picks lock.</p>`;
  } else if (!champLocked) {
    const sel = state.scorerPick;
    scorerBody = `<div class="champ-grid">${SCORERS.map(([n, t]) => `
      <button class="champ-btn scorer-btn ${sel === n ? 'mine' : ''}" data-scorer="${esc(n)}">
        <span class="flag">${flag(t)}</span><span>${esc(n)}</span>
      </button>`).join('')}
      <button class="champ-btn scorer-other ${state.scorerCustom ? 'mine' : ''}" id="scorer-other">
        <span class="flag">✏️</span><span>OTHER…</span>
      </button></div>
      ${state.scorerCustom ? `
      <div class="fs-row scorer-custom">
        <input id="scorer-input" maxlength="40" placeholder="Player name…" autocomplete="off">
        <button id="scorer-set">SET</button>
      </div>` : ''}
      ${sel ? `
      <div class="champ-confirm">
        <span class="confirm-txt">⚽ ${esc(sel)} — final answer? No changes later.</span>
        <button id="scorer-ok">OK</button>
      </div>` : ''}
      <p class="special-note">One shot — once you press OK the pick is locked forever.
      Hidden from others until the picks lock.</p>`;
  } else {
    const rows = Object.entries(state.specials)
      .filter(([, s]) => s.top_scorer)
      .sort(([a], [b]) => a.localeCompare(b));
    scorerBody = rows.length
      ? `<div class="special-list">${rows.map(([p, s]) => `
          <div class="special-row ${winnersN.includes(norm(s.top_scorer)) ? 'won' : ''}">
            <span class="sp-player">${esc(p)}</span>
            <span class="sp-pick">⚽ ${esc(s.top_scorer)}${winnersN.includes(norm(s.top_scorer)) ? ' ✓' : ''}</span>
          </div>`).join('')}</div>`
      : `<div class="empty">Nobody picked a gólkirály.</div>`;
  }

  // --- exact final score section ---
  let scoreBody;
  if (!scoreLocked) {
    scoreBody = `
      <div class="fs-row">
        <input id="fs-input" maxlength="40" placeholder="e.g. Argentina 2:1 France"
          value="${esc(mine.final_score ?? '')}" autocomplete="off">
        <button id="fs-save">SAVE</button>
      </div>
      <p class="special-note">Free text — write the exact final result you expect.
      Hidden from others until the final kicks off. Bragging rights only.</p>`;
  } else {
    const rows = Object.entries(state.specials)
      .filter(([, s]) => s.final_score)
      .sort(([a], [b]) => a.localeCompare(b));
    scoreBody = rows.length
      ? `<div class="special-list">${rows.map(([p, s]) => `
          <div class="special-row">
            <span class="sp-player">${esc(p)}</span>
            <span class="sp-pick">${esc(s.final_score)}</span>
          </div>`).join('')}</div>`
      : `<div class="empty">No final score predictions.</div>`;
  }

  const scoreSection = CONFIG.SHOW_FINAL_SCORE ? `
  <section class="special-card">
    <h2 class="group-head">✍️ EXACT FINAL SCORE</h2>
    <p class="special-note">${scoreLocked ? 'LOCKED' : `locks ${fin ? fmtDeadline(kickoff(fin)) : '—'} (final kickoff)`}</p>
    ${scoreBody}
  </section>` : '';

  return `
  <section class="special-card">
    <h2 class="group-head">🏆 WORLD CUP CHAMPION</h2>
    <p class="special-note">${CONFIG.POINTS_CHAMPION} pts for the correct winner ·
      ${champLocked ? 'LOCKED' : `locks ${fmtDeadline(deadline)} (NED–JPN kickoff)`}</p>
    ${champBody}
  </section>
  <section class="special-card">
    <h2 class="group-head">👑 GÓLKIRÁLY — TOP SCORER</h2>
    <p class="special-note">${CONFIG.POINTS_TOP_SCORER} pts for the tournament's top scorer ·
      ${champLocked ? 'LOCKED' : `locks ${fmtDeadline(deadline)} (NED–JPN kickoff)`}</p>
    ${scorerBody}
  </section>
  ${scorerRaceCard()}${scoreSection}`;
}

// Live top-5 scorer board (display only) — counts from ESPN, see fetchTopScorers.
function scorerRaceCard() {
  const race = state.scorerRace ?? [];
  const top = race.slice(0, 5);
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
  const resPts = CONFIG.POINTS_GROUP === CONFIG.POINTS_KO
    ? `${CONFIG.POINTS_GROUP}` : `${CONFIG.POINTS_GROUP}/${CONFIG.POINTS_KO}`;
  return `
  <section class="special-card rules-card">
    <h2 class="group-head">📐 SCORING</h2>
    <div class="rule-row"><span class="rule-ico">✓</span>
      <span class="rule-lab">Correct result — 1 / X / 2</span>
      <span class="rule-pts">${resPts} pts</span></div>
    <div class="rule-row"><span class="rule-ico">🎯</span>
      <span class="rule-lab">Exact score — EXACT row on the match</span>
      <span class="rule-pts">+${CONFIG.POINTS_EXACT} pts</span></div>
    <div class="rule-row rule-sub"><span class="rule-ico">↳</span>
      <span class="rule-lab">both right on one match</span>
      <span class="rule-pts">${CONFIG.POINTS_GROUP + CONFIG.POINTS_EXACT} pts</span></div>
    <div class="rule-row"><span class="rule-ico">🏆</span>
      <span class="rule-lab">World Cup champion — Trophy tab</span>
      <span class="rule-pts">${CONFIG.POINTS_CHAMPION} pts</span></div>
    <div class="rule-row"><span class="rule-ico">👑</span>
      <span class="rule-lab">Gólkirály (top scorer) — Trophy tab</span>
      <span class="rule-pts">${CONFIG.POINTS_TOP_SCORER} pts</span></div>
    <p class="special-note">Votes lock at kickoff · everyone's picks hidden until then.</p>
  </section>`;
}

function renderBoard() {
  const rows = leaderboard();
  if (!rows.length) {
    return scoringLegend() +
      `<div class="empty">No players yet. Vote on a match to enter the arena.</div>`;
  }
  const medals = ['🥇', '🥈', '🥉'];
  return scoringLegend() + `<table class="board">
    <thead><tr><th>#</th><th class="tl">PLAYER</th><th>HITS</th><th>EXACT</th><th>PTS</th></tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr class="${r.player === playerName() ? 'me' : ''}">
        <td>${medals[i] ?? i + 1}</td>
        <td class="tl">${esc(r.player)}</td>
        <td>${r.hit}/${r.played}</td>
        <td>${r.exact ? '★' + r.exact : '–'}</td>
        <td class="pts">${r.pts}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

/* ---------- name modal ---------- */

function askName(force = false) {
  // Devices from before the PIN era have a name but no claim — ask once.
  if (playerName() && isClaimed() && !force) return;
  $('#name-modal').hidden = false;
  const input = $('#name-input');
  input.value = playerName();
  $('#pin-input').value = '';
  $('#name-error').hidden = true;
  setTimeout(() => (input.value ? $('#pin-input') : input).focus(), 50);
}

async function saveName() {
  const v = $('#name-input').value.trim();
  const pin = $('#pin-input').value.trim();
  const err = $('#name-error');
  if (!v) return;
  if (online() && !/^\d{4,8}$/.test(pin)) {
    err.textContent = 'PIN must be 4–8 digits.';
    err.hidden = false;
    return;
  }
  const btn = $('#name-save');
  btn.disabled = true;
  try {
    const claimed = await claimPlayer(v, pin);
    if (!claimed) {
      // Registration is frozen, so null means either a wrong PIN on an existing
      // name or a name that was never registered — be honest about both.
      err.textContent = 'Wrong PIN, or this name isn’t in the game. New players are closed — ask Márk to add you.';
      err.hidden = false;
      return;
    }
    setPlayerName(claimed);
    setClaimed();
    $('#name-modal').hidden = true;
    render();
  } catch (e) {
    console.error(e);
    err.textContent = 'Connection error — try again.';
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- events ---------- */

document.addEventListener('click', async e => {
  const tab = e.target.closest('.tab');
  if (tab) {
    // Re-arm the jump each time the user enters Matches from another tab.
    if (tab.dataset.view === 'matches' && state.view !== 'matches') state.autoScrolled = false;
    state.view = tab.dataset.view;
    render();
    return;
  }

  if (e.target.closest('#player-chip')) { askName(true); return; }
  if (e.target.closest('#name-save')) { saveName(); return; }

  if (e.target.closest('.guess-save')) {
    if (!playerName()) { askName(); return; }
    const row = e.target.closest('.guess-row');
    const num = Number(row.dataset.num);
    const h = parseInt(row.querySelector('.gh').value, 10);
    const a = parseInt(row.querySelector('.ga').value, 10);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 30 || a > 30) {
      toast('Enter both scores (0–30)');
      return;
    }
    const me = playerName();
    const key = `${num}:${me}`;
    const m = state.matches.find(x => x.num === num);
    const conflict = guessConflict(m, state.votes[key], h, a);
    if (conflict) { toast(conflict); return; }
    const prev = state.guesses[key];
    state.guesses[key] = [h, a]; // optimistic
    try {
      await castGuess(num, me, h, a);
      toast(`Exact score saved: ${h}:${a} ✓`, 'ok');
    } catch (err) {
      console.error(err);
      if (prev) state.guesses[key] = prev; else delete state.guesses[key];
      toast('Save failed — check connection');
    }
    render();
    return;
  }

  if (e.target.closest('#scorer-other')) {
    if (!playerName()) { askName(); return; }
    if (mySpecial().top_scorer) return;
    state.scorerCustom = !state.scorerCustom;
    state.scorerPick = null;
    render();
    return;
  }

  if (e.target.closest('#scorer-set')) {
    const v = $('#scorer-input').value.trim();
    if (!v) { toast('Type a player name'); return; }
    state.scorerPick = v;
    state.scorerCustom = false;
    render();
    return;
  }

  const scorerBtn = e.target.closest('.scorer-btn');
  if (scorerBtn) {
    if (!playerName()) { askName(); return; }
    if (mySpecial().top_scorer) return; // one shot — already locked in
    state.scorerPick = scorerBtn.dataset.scorer;
    state.scorerCustom = false;
    render();
    return;
  }

  if (e.target.closest('#scorer-ok')) {
    if (!playerName()) { askName(); return; }
    const me = playerName();
    if (!state.scorerPick || state.specials[me]?.top_scorer) return;
    const prev = state.specials[me] ?? { champion: null, final_score: null, top_scorer: null };
    state.specials[me] = { ...prev, top_scorer: state.scorerPick }; // optimistic
    state.scorerPick = null;
    render();
    try {
      await saveSpecial(me, state.specials[me]);
      toast('Gólkirály locked in 👑', 'ok');
    } catch (err) {
      console.error(err);
      state.specials[me] = prev;
      render();
      toast('Save failed — check connection');
    }
    return;
  }

  const champBtn = e.target.closest('.champ-btn');
  if (champBtn) {
    if (!playerName()) { askName(); return; }
    if (mySpecial().champion) return; // one shot — already locked in
    state.champPick = champBtn.dataset.champ; // selection only, OK confirms
    render();
    return;
  }

  if (e.target.closest('#champ-ok')) {
    if (!playerName()) { askName(); return; }
    const me = playerName();
    if (!state.champPick || (state.specials[me]?.champion)) return;
    const prev = state.specials[me] ?? { champion: null, final_score: null };
    state.specials[me] = { ...prev, champion: state.champPick }; // optimistic
    state.champPick = null;
    render();
    try {
      await saveSpecial(me, state.specials[me]);
      toast('Champion locked in 🏆', 'ok');
    } catch (err) {
      console.error(err);
      state.specials[me] = prev;
      render();
      toast('Save failed — check connection');
    }
    return;
  }

  if (e.target.closest('#fs-save')) {
    if (!playerName()) { askName(); return; }
    const me = playerName();
    const text = $('#fs-input').value.trim();
    const prev = state.specials[me] ?? { champion: null, final_score: null };
    state.specials[me] = { ...prev, final_score: text || null };
    try {
      await saveSpecial(me, state.specials[me]);
      toast('Final score saved ✓', 'ok');
    } catch (err) {
      console.error(err);
      state.specials[me] = prev;
      toast('Save failed — check connection');
    }
    render();
    return;
  }

  const btn = e.target.closest('.vote-btn');
  if (btn && !btn.disabled) {
    if (!playerName()) { askName(); return; }
    const num = Number(btn.dataset.num);
    const pick = btn.dataset.vote;
    const key = `${num}:${playerName()}`;
    const prev = state.votes[key];
    const g = state.guesses[key];
    if (g && guessConflict(state.matches.find(x => x.num === num), pick, g[0], g[1])) {
      toast(`⚠ EXACT ${g[0]}:${g[1]} no longer matches your pick — update it`);
    }
    state.votes[key] = pick;          // optimistic
    render();
    try {
      await castVote(num, playerName(), pick);
    } catch (err) {
      console.error(err);
      if (prev) state.votes[key] = prev; else delete state.votes[key];
      render();
      toast('Vote failed — check connection');
    }
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !$('#name-modal').hidden) { saveName(); return; }
  if (e.key === 'Enter' && e.target.matches('#scorer-input')) {
    $('#scorer-set').click();
    return;
  }
  if (e.key === 'Enter' && e.target.matches('.guess-row input')) {
    e.target.closest('.guess-row').querySelector('.guess-save').click();
    e.target.blur();
  }
});

function toast(msg, kind = 'err') {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('ok', kind === 'ok');
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ---------- boot ---------- */

async function boot() {
  state.matches = await loadSchedule();
  render();
  askName();
  try {
    [state.votes, state.specials, state.guesses] = await Promise.all([
      fetchVotes(), fetchSpecials(), fetchGuesses(),
    ]);
  } catch (e) { console.warn(e); }
  refreshScores(state.matches).then(() => { state.scoresLoaded = true; render(); });
  render();
  // Top-scorer board loads in the background (cached per match) and shows when ready.
  fetchTopScorers().then(race => { state.scorerRace = race; render(); }).catch(e => console.warn('scorers', e));
  setInterval(async () => {
    try {
      const [votes, specials, guesses, , race] = await Promise.all([
        fetchVotes(), fetchSpecials(), fetchGuesses(), refreshScores(state.matches), fetchTopScorers(),
      ]);
      state.votes = votes;
      state.specials = specials;
      state.guesses = guesses;
      if (race) state.scorerRace = race;
      render();
    } catch (e) { console.warn('refresh failed', e); }
  }, CONFIG.REFRESH_MS);
}

boot();

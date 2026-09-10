// Team metadata comes from data/ucl2027.json (built from ESPN): crest URL,
// short name, abbreviation, ESPN id. Populated once at boot via setTeams().

export let TEAMS = {};          // displayName -> { short, abbr, espnId, logo, color }
let BY_ESPN_ID = new Map();     // espnId -> displayName

export function setTeams(list) {
  TEAMS = {};
  BY_ESPN_ID = new Map();
  for (const t of list ?? []) {
    TEAMS[t.name] = t;
    if (t.espnId) BY_ESPN_ID.set(String(t.espnId), t.name);
  }
}

export function teamByEspnId(id) {
  return BY_ESPN_ID.get(String(id)) ?? null;
}

// Knockout placeholders before a draw: "TBD Home", "Winner X", "1st ..." etc.
// (No slash test: "Bodo/Glimt" is a real club.)
export function isPlaceholder(name) {
  if (!name || !/\S/.test(name)) return true;
  return /^(tbd|tba|winner|loser|runner|1st|2nd|w\d+|l\d+)\b/i.test(name);
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Crest <img> for the team (falls back to a ball for placeholders).
export function crest(team, cls = 'crest') {
  const t = TEAMS[team];
  if (!t?.logo) return `<span class="${cls} ph">⚽</span>`;
  return `<img class="${cls}" src="${esc(t.logo)}" alt="" loading="lazy" decoding="async">`;
}

const SHORT_OVERRIDE = {
  'Paris Saint-Germain': 'PSG',
  'Borussia Dortmund': 'Dortmund',
  'Manchester City': 'Man City',
  'Manchester United': 'Man United',
  'Atlético Madrid': 'Atlético',
  'Feyenoord Rotterdam': 'Feyenoord',
  'Internazionale': 'Inter',
  'Bayern Munich': 'Bayern',
  'Shakhtar Donetsk': 'Shakhtar',
  'Slovan Bratislava': 'Slovan',
  'PSV Eindhoven': 'PSV',
  'VfB Stuttgart': 'Stuttgart',
  'Sporting CP': 'Sporting',
  'Slavia Prague': 'Slavia',
  'Real Betis': 'Betis',
  'Club Brugge': 'Brugge',
  'Bodo/Glimt': 'Bodø/Glimt',
  'LASK Linz': 'LASK',
  'Viking FK': 'Viking',
  'Sabah FK': 'Sabah',
  'AS Roma': 'Roma',
  'FC Porto': 'Porto',
};

export function teamShort(name) {
  if (isPlaceholder(name)) return name;
  return SHORT_OVERRIDE[name] ?? TEAMS[name]?.short ?? name;
}

export function teamAbbr(name) {
  return TEAMS[name]?.abbr ?? teamShort(name).slice(0, 3).toUpperCase();
}

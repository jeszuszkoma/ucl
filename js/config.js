// App configuration. See SETUP.md for the Supabase steps.
// Empty SUPABASE_* values = local mode (single device, no accounts) - handy
// for development, not for playing with friends.
export const CONFIG = {
  SUPABASE_URL: 'https://wwbovzfjoiuxzfehkqut.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_t-CWzc_hRSDsW2Y8ebJQPA_ao7gx8cn', // public by design
  // Edge function that logs in with username + password (keeps emails private).
  // Empty = login with email only, straight against Supabase Auth.
  LOGIN_URL: 'https://wwbovzfjoiuxzfehkqut.supabase.co/functions/v1/login',
  // Where confirmation / password-reset emails send people back to.
  SITE_URL: 'https://jeszuszkoma.github.io/wc26/',

  // Points.
  POINTS_MATCH: 3,        // correct 1 / X / 2 (league and knockout alike)
  POINTS_CHAMPION: 20,    // correct Champions League winner
  POINTS_TOP_SCORER: 20,  // correct gólkirály (tournament top scorer)

  // Manual override for the final top-scorer verdict if the feed is late or
  // wrong at the end of the season. e.g. ['Kylian Mbappé']
  TOP_SCORERS: [],

  // How often to refresh scores + picks while the app is open (ms).
  REFRESH_MS: 60_000,
  // Full-season score pull (bigger payload) - on boot, then every N ms.
  FULL_REFRESH_MS: 10 * 60_000,

  // Local-mode ballots (no Supabase). Mirrors what supabase/matches.sql seeds.
  LOCAL_BALLOTS: {
    league: { label: 'League phase', opens_at: '2026-09-01T00:00:00Z', locks_at: '2026-10-13T16:45:00Z' },
  },
};

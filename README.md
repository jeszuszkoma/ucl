# WC26 // PREDICTION ARENA ⚽

Friends prediction game for the 2026 FIFA World Cup. No money, no accounts —
voting opens each matchday, pick `1 / X / 2` before kickoff, score points when
you're right, top the board.

**Live:** https://jeszuszkoma.github.io/wc26/

> **Status (2026-07-20):** tournament over — the site now shows a holding page
> with the final top 3. Game data has been cleared from Supabase (local backup
> kept). The app itself is untouched (`js/`, `css/`, `data/`) — to bring it
> back, restore `index.html` from the last pre-holding commit.

- All 12 groups, 104 matches, knockout bracket — times shown in your timezone
- Shared voting via Supabase (optional — works locally without it)
- Scores from [openfootball](https://github.com/openfootball/worldcup.json) (~daily),
  optionally near-live via [football-data.org](https://www.football-data.org/)
- Zero build step: plain HTML/CSS/JS, hosted on GitHub Pages

Setup for shared voting + live scores: see [SETUP.md](SETUP.md).

## Stack

- Vanilla ES modules, no framework, no dependencies
- Supabase (free tier): `votes` table over PostgREST, anon key, RLS
- Supabase Edge Function proxies football-data.org (key stays server-side)

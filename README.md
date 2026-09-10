# UCL 26/27 // PREDICTION ARENA ⚽

Friends prediction game for the 2026/27 UEFA Champions League. Real accounts,
one ballot per phase: pick `1 / X / 2` for every match, press SUBMIT, score
points when you're right, top the board.

**Live:** https://jeszuszkoma.github.io/wc26/

> Started life as the World Cup 2026 game (see git history before Sept 2026).

## How the game works

- **Accounts:** register with email + username + password + invite code (no
  email confirmation — you are logged in straight away), later log in with
  username (or email) + password. Username is what the board shows. Emails
  stay private and are only used for password resets.
- **League ballot:** all 126 remaining league-phase matches (Matchday 2–8; MD1
  was played before launch). Pick every match, press **SUBMIT** — final. Picks
  stay in your browser until you submit (one request per ballot, not one per
  tap), so finish on the device you started on. A ballot that is never
  submitted counts for nothing after the deadline
  (**Oct 13, 2026 18:45 CEST**, Matchday 2 kickoff). Everyone's picks are hidden
  until then, then revealed on the cards.
- **Knockout ballots:** one per round (play-off, R16, QF, SF, final), opening
  when the draw is known and locking at the round's first kickoff.
- **Trophy tab:** Champions League winner and gólkirály (top scorer) are two
  more ballots with their own SUBMIT each, so three submits before Matchday 2.
  They lock with the league by default; each deadline is one row in
  `public.ballots` and can be moved separately.
- **Scoring:** correct result 3 pts (two-legged ties: match result incl. extra
  time, shootout ignored; final: winner). Champion 20 pts. Top scorer 20 pts.

## Stack

- Vanilla ES modules, no framework, no build step, GitHub Pages
- Scores, scorers, standings: ESPN's public Champions League JSON (no key, CORS-open)
- Supabase (free tier): Auth (email + password), Postgres with row-level
  security enforcing ballot deadlines and pick visibility, one edge function
  for username login

Setup: see [SETUP.md](SETUP.md). Data refresh: `node scripts/fetch-ucl-schedule.mjs`.

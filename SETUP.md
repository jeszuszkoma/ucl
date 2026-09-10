# UCL 26/27 // PREDICTION ARENA — Setup

The app is static (GitHub Pages). Everything stateful lives in one Supabase
project. Without Supabase config it runs in **local mode** (no accounts, picks
on this device only) — fine for development, not for playing.

## 1. Database (~5 min)

Either paste the files into the dashboard **SQL Editor**, or run them from
the CLI after `npx supabase@latest link --project-ref wwbovzfjoiuxzfehkqut`:
`npx supabase@latest db query --linked -f supabase/schema.sql` (same for
`matches.sql`; plain statements go in quotes instead of `-f`).

1. Open the project → **SQL Editor**.
2. If the old World Cup tables are still there, drop them first:
   ```sql
   drop table if exists public.votes, public.guesses, public.specials, public.players cascade;
   drop function if exists public.claim_player(text, text);
   ```
3. Paste [`supabase/schema.sql`](supabase/schema.sql) → Run. Creates tables,
   row-level security, the signup trigger and helper functions.
4. Paste [`supabase/matches.sql`](supabase/matches.sql) → Run. Seeds the 144
   league-phase matches and the league ballot (opens now, locks at Matchday 2
   kickoff, `2026-10-13T16:45:00Z`).
5. Read the invite code your friends will use (a random one is generated), or
   set your own — keep it long, the pre-check endpoint is public:
   ```sql
   select value from public.app_config where key = 'invite_code';
   update public.app_config set value = 'something-long-and-random' where key = 'invite_code';
   ```

## 2. Auth settings (Supabase dashboard → Authentication)

- **Providers → Email:** enabled, **Confirm email** ON.
- **URL Configuration → Site URL / Redirect URLs:** declared in
  [`supabase/config.toml`](supabase/config.toml) together with the rate limits
  and *Confirm email*. Apply them with `npx supabase@latest config push`
  (`config diff` previews; undeclared dashboard settings are left alone).
  Confirmation and reset links send people back to the site URL.
- **Rate limits / SMTP:** Supabase's built-in mailer allows only a couple of
  emails per hour — enough to test, not for a signup wave. Before inviting
  people, set up **custom SMTP** (Project Settings → Authentication → SMTP):
  a free [Resend](https://resend.com) or [Brevo](https://www.brevo.com) account
  works (Resend: 3000 emails/month free; needs a verified sender domain or
  their onboarding sender).
- **Rate Limits:** raise *Token refresh / sign-in* well above your player count
  (username logins pass through the edge function, so Supabase sees them from
  one IP). Email links expire after 1 h by default — players who miss it use
  "Resend confirmation" on the login screen.
- Optional: **Email Templates** — customise the confirmation / reset text.
- **Do not create players from the dashboard** (*Invite user* / *Add user*):
  those rows carry no username or invite code and the signup trigger rejects
  them by design. Everyone registers through the app with the invite code.
  Rename someone with
  `update public.profiles set username = 'Name' where username = 'old';`.
- **Registration that never got confirmed** (typo in the email, link expired)
  frees its username automatically after 1 hour, so the person can simply
  register again.

## 3. Username login (edge function, ~5 min)

Login is by username; the lookup to email runs server-side so nobody can list
players' emails.

```sh
npx supabase@latest login       # opens the browser; approve the CLI there (global npm install is not supported)
npx supabase@latest functions deploy login --no-verify-jwt --project-ref wwbovzfjoiuxzfehkqut
```

The project must be running: a free-tier project pauses after a week of
inactivity and the deploy then fails with `status 'INACTIVE'`. Restore it
first from https://supabase.com/dashboard/project/wwbovzfjoiuxzfehkqut
("Restore project", takes a few minutes) and rerun the deploy.

`js/config.js` already points `LOGIN_URL` at
`https://<ref>.supabase.co/functions/v1/login`. If you skip this step, set
`LOGIN_URL: ''` — login then works with email + password only.

If you ever disable the legacy JWT API keys in the dashboard, give the function
the new keys as secrets (it prefers them when present):
```sh
supabase secrets set PUBLISHABLE_KEY=sb_publishable_... SECRET_KEY=sb_secret_...
```

## 4. Deploy

Commit + push to `main`; GitHub Pages serves it. Test locally with any static
server, e.g. `npx http-server . -p 8087 -c-1`, then open
`http://localhost:8087/?local` for local mode (`?online` switches back).

## Operating the game

- **Schema changes:** `supabase/schema.sql` is safe to re-run (everything is
  create-or-replace / if-not-exists). Apply it *before* pushing JavaScript that
  depends on it - e.g. SUBMIT calls the `submit_ballot` function, and a client
  deployed ahead of the SQL would fail every submit.
- **Only submitted ballots count.** Picks stay in the player's browser until
  SUBMIT; the server reveals and the board scores only rows that belong to a
  submitted ballot. A player who never submits simply has no ballot.

- **Fixtures / results / standings** come live from ESPN; nothing to do.
- **Refresh the bundled schedule** (postponements, or when knockout fixtures
  appear):
  ```sh
  node scripts/fetch-ucl-schedule.mjs          # updates data/ucl2027.json, keeps match numbers stable
  node scripts/matches-sql.mjs > supabase/matches.sql
  ```
  Read the script's warnings (postponements, replays, renamed teams, matches
  gone from the feed) and paste `supabase/matches.sql` into the SQL editor.
  For a knockout round the ballot is emitted only once every pairing is drawn
  (ESPN lists "TBD" fixtures early); it opens immediately and locks at the
  round's first kickoff, following that kickoff if ESPN moves it before the
  lock. Commit + push the JSON.
- **Abandoned match:** ESPN keeps it as "0-0, not completed" — the app shows no
  result and nobody scores it. The replay appears under a new ESPN event; the
  script maps it back onto the same match number automatically (check the
  warning it prints).
- **Move a deadline:**
  `update public.ballots set locks_at = '2026-10-13T16:45:00Z' where phase = 'league';`
- **Change the invite code:** see step 1.5. **Close registration:** set the code
  to something nobody knows.
- **Remove a player:** Authentication → Users → delete (cascades to picks).
- **Top scorer verdict override** (if ESPN's goal data is wrong at the end):
  `TOP_SCORERS` in `js/config.js`.

## Rules recap (what the server enforces)

- Picks are accepted only while the phase's ballot is open, only for matches
  that kick off at or after the ballot lock, and only until the player submits.
- Other players' picks and trophy picks are readable only once the phase is locked.
- A submission is final (no update/delete policy).
- Signup requires the invite code and a unique username (3–20 chars; letters
  incl. accents, digits, `. _ -`; "Márk" and "mark" count as the same name).

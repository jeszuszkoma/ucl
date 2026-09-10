-- UCL 26/27 prediction game - database schema (v2, real accounts).
-- Run once in the Supabase SQL editor. Then run supabase/matches.sql.
--
-- Security model (all enforced server-side, the browser is untrusted):
--   * Accounts: Supabase Auth (email + password, email confirmation on).
--   * Signup needs the invite code stored in app_config (checked in a trigger).
--   * Usernames are unique (case-insensitive) and public; emails never leave auth.
--   * A ballot (phase) is open between opens_at and locks_at. While open a
--     player may set picks for matches of that phase whose kickoff is not
--     before locks_at. SUBMIT freezes the player's ballot early.
--   * Other players' picks become readable only once the phase is locked.

create extension if not exists pgcrypto;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------- config
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config enable row level security;
-- No policies on purpose: reachable only through security-definer functions.
-- The invite code seeds as a random 24-hex string; read it back with
--   select value from public.app_config where key = 'invite_code';
-- or set your own (keep it long - the pre-check RPC is public and unthrottled):
--   update public.app_config set value = 'a-long-random-code' where key = 'invite_code';
insert into public.app_config (key, value)
  values ('invite_code', encode(extensions.gen_random_bytes(12), 'hex'))
  on conflict (key) do nothing;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  username   text not null check (char_length(username) between 3 and 20),
  created_at timestamptz not null default now()
);
-- Usernames are unique ignoring case AND accents ("Márk" blocks "mark"), so two
-- look-alike names can't share a board. Accented letters themselves are fine.
create or replace function public.norm_name(p text) returns text
language sql immutable strict as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, trim(p)))
$$;
drop index if exists public.profiles_username_lower_idx;
create unique index if not exists profiles_username_norm_idx on public.profiles (public.norm_name(username));
alter table public.profiles enable row level security;
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated using (true);
-- No insert/update/delete policies: rows are created by the signup trigger only.

-- Username rule shared by the pre-check and the trigger: letters (accents ok),
-- digits, . _ - ; 3-20 chars; must start with a letter or digit.
create or replace function public.valid_username(p text) returns boolean
language sql immutable as $$
  select p ~ '^[[:alnum:]][[:alnum:]_.-]{2,19}$'
$$;

-- A registration that never confirmed its email (typo, link expired) must not
-- reserve the username forever: drop such accounts after an hour when someone
-- wants the name. Best effort - auth.users may be off limits, then we skip.
create or replace function public.release_stale_username(p_username text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from auth.users u
   using public.profiles p
   where p.user_id = u.id
     and u.email_confirmed_at is null
     and u.created_at < now() - interval '1 hour'
     and public.norm_name(p.username) = public.norm_name(p_username);
exception when others then
  null;
end;
$$;
revoke all on function public.release_stale_username(text) from public, anon, authenticated;

-- Signup trigger: verify invite code + username, create the profile row.
-- Raising here aborts the signup (auth returns "Database error saving new user"),
-- so the client calls signup_precheck() first to give a readable error.
-- Every account must come through the app's registration form: the dashboard
-- "Invite user" / "Add user" buttons create rows without metadata and are
-- rejected here on purpose (an unauthenticated magic-link signup looks the same).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  uname text := trim(coalesce(new.raw_user_meta_data->>'username', ''));
  code  text := trim(coalesce(new.raw_user_meta_data->>'invite', ''));
  want  text;
begin
  select value into want from public.app_config where key = 'invite_code';
  if want is null or code <> want then
    raise exception 'invalid invite code';
  end if;
  perform public.release_stale_username(uname);
  if not public.valid_username(uname) then
    raise exception 'invalid username';
  end if;
  insert into public.profiles (user_id, username) values (new.id, uname);
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Pre-check called by the registration form. Returns:
--   'ok' | 'bad_invite' | 'bad_username' | 'taken'
create or replace function public.signup_precheck(p_username text, p_invite text) returns text
language plpgsql security definer set search_path = public as $$
declare want text;
begin
  select value into want from public.app_config where key = 'invite_code';
  if want is null or trim(coalesce(p_invite, '')) <> want then return 'bad_invite'; end if;
  if not public.valid_username(trim(coalesce(p_username, ''))) then return 'bad_username'; end if;
  perform public.release_stale_username(p_username);
  if exists (select 1 from public.profiles where public.norm_name(username) = public.norm_name(p_username)) then return 'taken'; end if;
  return 'ok';
end;
$$;
revoke all on function public.signup_precheck(text, text) from public;
grant execute on function public.signup_precheck(text, text) to anon, authenticated;

-- Username -> email, for the `login` edge function ONLY (service role).
create or replace function public.email_for_username(p_username text) returns text
language sql security definer set search_path = public as $$
  select u.email::text
    from auth.users u
    join public.profiles p on p.user_id = u.id
   where public.norm_name(p.username) = public.norm_name(p_username)
   limit 1
$$;
revoke all on function public.email_for_username(text) from public, anon, authenticated;
grant execute on function public.email_for_username(text) to service_role;
-- Not needed by clients; keep the helpers off the public RPC surface.
revoke all on function public.valid_username(text) from public, anon, authenticated;
revoke all on function public.norm_name(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- ballots
create table if not exists public.ballots (
  phase    text primary key,          -- league | playoff | r16 | qf | sf | final
  label    text not null,
  opens_at timestamptz not null,
  locks_at timestamptz not null,
  check (locks_at > opens_at)
);
alter table public.ballots enable row level security;
drop policy if exists "read ballots" on public.ballots;
create policy "read ballots" on public.ballots for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- matches
-- Mirror of data/ucl2027.json (num is the stable id used by picks).
create table if not exists public.matches (
  num     int primary key,
  espn    text not null unique,
  phase   text not null references public.ballots (phase),
  round   text not null,
  kickoff timestamptz not null,
  team1   text not null,
  team2   text not null
);
alter table public.matches enable row level security;
drop policy if exists "read matches" on public.matches;
create policy "read matches" on public.matches for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- submissions
create table if not exists public.submissions (
  user_id      uuid not null references auth.users (id) on delete cascade,
  phase        text not null references public.ballots (phase),
  submitted_at timestamptz not null default now(),
  primary key (user_id, phase)
);
alter table public.submissions enable row level security;

-- ---------------------------------------------------------------- helpers
create or replace function public.phase_open(p_phase text) returns boolean
language sql stable as $$
  select exists (select 1 from public.ballots
                  where phase = p_phase and now() >= opens_at and now() < locks_at)
$$;

create or replace function public.phase_locked(p_phase text) returns boolean
language sql stable as $$
  select exists (select 1 from public.ballots where phase = p_phase and now() >= locks_at)
$$;

-- Caller may still edit their ballot for this phase.
create or replace function public.can_edit_phase(p_phase text) returns boolean
language sql stable as $$
  select public.phase_open(p_phase)
     and not exists (select 1 from public.submissions
                      where user_id = auth.uid() and phase = p_phase)
$$;

-- Caller may set a pick on this match: phase editable AND the match is part
-- of the ballot (kicks off at or after the ballot lock - excludes games that
-- were already played when the ballot opened, e.g. Matchday 1).
create or replace function public.can_pick(p_num int) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.matches m join public.ballots b on b.phase = m.phase
     where m.num = p_num and m.kickoff >= b.locks_at and public.can_edit_phase(m.phase))
$$;

create or replace function public.match_locked(p_num int) returns boolean
language sql stable as $$
  select exists (select 1 from public.matches m where m.num = p_num and public.phase_locked(m.phase))
$$;

drop policy if exists "read submissions" on public.submissions;
create policy "read submissions" on public.submissions for select to authenticated using (true);
-- "submit own" (insert) is declared further down, after picks and
-- trophy_picks exist: it checks that the ballot is complete.
-- No update/delete: a submission is final.

-- Has this player submitted the ballot the match belongs to? Only submitted
-- ballots are ever revealed or scored; rows without a submission (never
-- pressed SUBMIT) stay invisible to everyone but their owner.
create or replace function public.pick_submitted(p_user uuid, p_num int) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from public.submissions s
                   join public.matches m on m.phase = s.phase
                  where s.user_id = p_user and m.num = p_num)
$$;

-- ---------------------------------------------------------------- picks
create table if not exists public.picks (
  user_id    uuid not null references auth.users (id) on delete cascade,
  match_num  int  not null references public.matches (num),
  pick       text not null check (pick in ('1', 'X', '2')),
  updated_at timestamptz not null default now(),
  primary key (user_id, match_num)
);
alter table public.picks enable row level security;

drop policy if exists "read own picks" on public.picks;
create policy "read own picks" on public.picks for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "read revealed picks" on public.picks;
create policy "read revealed picks" on public.picks for select to authenticated
  using (public.match_locked(match_num) and public.pick_submitted(user_id, match_num));
drop policy if exists "insert own pick" on public.picks;
create policy "insert own pick" on public.picks for insert to authenticated
  with check (user_id = auth.uid() and public.can_pick(match_num));
drop policy if exists "update own pick" on public.picks;
create policy "update own pick" on public.picks for update to authenticated
  using (user_id = auth.uid() and public.can_pick(match_num))
  with check (user_id = auth.uid() and public.can_pick(match_num));

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists picks_touch on public.picks;
create trigger picks_touch before update on public.picks
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- trophy picks
-- Champion + top scorer. Part of the league ballot (same lock).
create table if not exists public.trophy_picks (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  champion   text check (champion is null or char_length(champion) <= 40),
  top_scorer text check (top_scorer is null or char_length(top_scorer) <= 40),
  updated_at timestamptz not null default now()
);
alter table public.trophy_picks enable row level security;

drop policy if exists "read own trophy" on public.trophy_picks;
create policy "read own trophy" on public.trophy_picks for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "read revealed trophy" on public.trophy_picks;
create policy "read revealed trophy" on public.trophy_picks for select to authenticated
  using (public.phase_locked('league')
         and exists (select 1 from public.submissions s where s.user_id = trophy_picks.user_id and s.phase = 'league'));
drop policy if exists "insert own trophy" on public.trophy_picks;
create policy "insert own trophy" on public.trophy_picks for insert to authenticated
  with check (user_id = auth.uid() and public.can_edit_phase('league'));
drop policy if exists "update own trophy" on public.trophy_picks;
create policy "update own trophy" on public.trophy_picks for update to authenticated
  using (user_id = auth.uid() and public.can_edit_phase('league'))
  with check (user_id = auth.uid() and public.can_edit_phase('league'));
drop trigger if exists trophy_touch on public.trophy_picks;
create trigger trophy_touch before update on public.trophy_picks
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- submit own
-- A submission row is what makes a ballot count. It can only be inserted
-- while the phase is open and once the caller's ballot is complete: a pick
-- for every match of the phase (kickoff >= lock) and, for the league, both
-- trophy picks. submit_ballot() below writes the picks first, in the same
-- transaction, so it passes; a bare POST to /rest/v1/submissions cannot
-- mark a half-filled ballot as submitted.
create or replace function public.ballot_complete(p_phase text) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from public.matches m join public.ballots b on b.phase = m.phase
                  where m.phase = p_phase and m.kickoff >= b.locks_at)
     and not exists (select 1 from public.matches m join public.ballots b on b.phase = m.phase
                      where m.phase = p_phase and m.kickoff >= b.locks_at
                        and not exists (select 1 from public.picks p
                                         where p.user_id = auth.uid() and p.match_num = m.num))
     and (p_phase <> 'league'
          or exists (select 1 from public.trophy_picks t
                      where t.user_id = auth.uid()
                        and nullif(trim(t.champion), '') is not null
                        and nullif(trim(t.top_scorer), '') is not null))
$$;
drop policy if exists "submit own" on public.submissions;
create policy "submit own" on public.submissions for insert to authenticated
  with check (user_id = auth.uid() and public.phase_open(phase) and public.ballot_complete(phase));

-- ---------------------------------------------------------------- submit_ballot
-- The whole ballot arrives in one call. Picks live on the player's device
-- until SUBMIT; then every pick, the trophy picks (league) and the submission
-- row are written in a single transaction and frozen. Runs as the caller
-- (security invoker), so the row policies above still decide what may be
-- written; the completeness check here just gives a clear error before the
-- "submit own" policy would refuse the submission row.
-- p_picks: [{"num": 19, "pick": "1"}, ...] - every match of the ballot.
create or replace function public.submit_ballot(
  p_phase text, p_picks jsonb, p_champion text default null, p_top_scorer text default null)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_total int;
  v_given int;
begin
  if v_uid is null then
    raise exception 'not logged in' using errcode = '42501';
  end if;
  if not public.can_edit_phase(p_phase) then
    raise exception 'ballot closed or already submitted' using errcode = '42501';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' then
    raise exception 'picks must be a JSON array' using errcode = '22023';
  end if;

  -- Every match of the ballot exactly once, each with a legal pick. Picks for
  -- matches outside the ballot (already played, other phase) are ignored.
  select count(*) into v_total
    from public.matches m join public.ballots b on b.phase = m.phase
   where m.phase = p_phase and m.kickoff >= b.locks_at;
  select count(distinct m.num) into v_given
    from jsonb_array_elements(p_picks) e
    join public.matches m on m.num = (e->>'num')::int
    join public.ballots b on b.phase = m.phase
   where m.phase = p_phase and m.kickoff >= b.locks_at
     and e->>'pick' in ('1', 'X', '2');
  if v_total = 0 or v_given <> v_total then
    raise exception 'incomplete ballot: % of % picks', v_given, v_total using errcode = '23514';
  end if;
  if p_phase = 'league'
     and (nullif(trim(p_champion), '') is null or nullif(trim(p_top_scorer), '') is null) then
    raise exception 'champion and top scorer required' using errcode = '23514';
  end if;

  -- last occurrence wins if a match appears twice
  insert into public.picks (user_id, match_num, pick)
  select v_uid, p.num, p.pick from (
    select distinct on (m.num) m.num, e.val->>'pick' as pick
      from jsonb_array_elements(p_picks) with ordinality as e(val, ord)
      join public.matches m on m.num = (e.val->>'num')::int
      join public.ballots b on b.phase = m.phase
     where m.phase = p_phase and m.kickoff >= b.locks_at
       and e.val->>'pick' in ('1', 'X', '2')
     order by m.num, e.ord desc) p
  on conflict (user_id, match_num) do update set pick = excluded.pick;

  if p_phase = 'league' then
    insert into public.trophy_picks (user_id, champion, top_scorer)
    values (v_uid, trim(p_champion), trim(p_top_scorer))
    on conflict (user_id) do update
      set champion = excluded.champion, top_scorer = excluded.top_scorer;
  end if;

  insert into public.submissions (user_id, phase) values (v_uid, p_phase);
end $$;
revoke all on function public.submit_ballot(text, jsonb, text, text) from public, anon;
grant execute on function public.submit_ballot(text, jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------- admin notes
-- Read / change the invite code:
--   select value from public.app_config where key = 'invite_code';
--   update public.app_config set value = 'a-long-random-code' where key = 'invite_code';
-- Rename a player:
--   update public.profiles set username = 'NewName' where username = 'OldName';
-- Extend / move a deadline:
--   update public.ballots set locks_at = '2026-10-13T16:45:00Z' where phase = 'league';
-- Open a knockout ballot after regenerating data + supabase/matches.sql:
--   the generated file inserts the ballot row (opens now, locks at first kickoff).

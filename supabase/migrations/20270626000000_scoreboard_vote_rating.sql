-- 20270626000000_scoreboard_vote_rating.sql
--
-- The Scoreboard's monthly team vote and the owner's rating (owner, 2026-11-12).
--
--   * scoreboard_votes    one row per vote: in the last 3 days of the month each scored person gives 3 votes to
--                         3 different colleagues (never themselves), with an optional line on how they helped.
--                         Cast once; a vote is never changed or removed. SECRET: the routes never show who
--                         voted for whom, to anybody (the owner sees totals and the anonymous lines).
--   * scoreboard_ratings  the owner's 1-5 for each person and month, with one line of reason the person reads.
--                         Changeable until the month closes (23:00 IST on its last day; enforced by the route).
--
-- Closed to the browser; /api/scoreboard/vote and /ratings (service role, actor from the token) are the only door.
-- The windows and limits are also checked there (src/lib/scoreboard/vote.ts); the database holds the shape:
-- not yourself, at most 3 a month, never changed.
--
-- ROLLBACK: drop table public.scoreboard_votes, public.scoreboard_ratings;
--           drop function public.scoreboard_votes_guard();

do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'DEPENDENCY MISSING: users';
  end if;
end $$;

create table if not exists public.scoreboard_votes (
  month       date not null check (extract(day from month) = 1),
  voter_id    uuid not null references public.users(id),
  nominee_id  uuid not null references public.users(id),
  note        text check (note is null or length(btrim(note)) between 2 and 200),
  created_at  timestamptz not null default now(),
  primary key (month, voter_id, nominee_id),
  constraint scoreboard_votes_not_self check (voter_id <> nominee_id)
);
create index if not exists scoreboard_votes_nominee_idx on public.scoreboard_votes (month, nominee_id);

create or replace function public.scoreboard_votes_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'SCOREBOARD_VOTE_FINAL: a vote is cast once and never changed' using errcode = '42501';
  end if;
  if (select count(*) from public.scoreboard_votes v where v.month = new.month and v.voter_id = new.voter_id) >= 3 then
    raise exception 'SCOREBOARD_VOTE_LIMIT: three votes a month' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.scoreboard_votes_guard() from public, anon, authenticated;
drop trigger if exists scoreboard_votes_guard on public.scoreboard_votes;
create trigger scoreboard_votes_guard
  before insert or update or delete on public.scoreboard_votes
  for each row execute function public.scoreboard_votes_guard();

create table if not exists public.scoreboard_ratings (
  month        date not null check (extract(day from month) = 1),
  employee_id  uuid not null references public.users(id),
  rating       integer not null check (rating between 1 and 5),
  reason       text not null check (length(btrim(reason)) between 3 and 300),
  rated_by     uuid not null references public.users(id),
  rated_at     timestamptz not null default now(),
  primary key (month, employee_id)
);

alter table public.scoreboard_votes enable row level security;
alter table public.scoreboard_ratings enable row level security;
revoke all on public.scoreboard_votes, public.scoreboard_ratings from public, anon, authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.scoreboard_votes', 'select')
     or has_table_privilege('anon', 'public.scoreboard_ratings', 'select') then
    raise exception 'scoreboard vote and rating tables must be closed to the browser';
  end if;
end $$;

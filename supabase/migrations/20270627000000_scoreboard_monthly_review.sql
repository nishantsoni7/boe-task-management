-- 20270627000000_scoreboard_monthly_review.sql
--
-- The Scoreboard's monthly review (owner, 2026-11-12): the owner confirms the month's awards and freezes the
-- month, and writes private review goals for the lowest scorer and anybody in the Red zone.
--
--   * scoreboard_months   a month the owner has frozen and announced: when, by whom. Written once.
--   * scoreboard_awards   the month's winners: Star Performer, Star Seller, Most Improved, Team Player (one
--                         each) and Never Late (any number), with an optional line. Written in the same act as
--                         the freeze and never changed after it (a trigger refuses any change to a frozen
--                         month's awards).
--   * scoreboard_reviews  a private review: up to 3 written goals for the next month, a check-in date, whether
--                         a written warning was given, a private note. Read only by the owner and the person.
--
-- Closed to the browser; /api/scoreboard/review and /api/scoreboard/me (service role, actor from the token)
-- are the only door.
--
-- ROLLBACK: drop table public.scoreboard_reviews, public.scoreboard_awards, public.scoreboard_months;
--           drop function public.scoreboard_awards_frozen();

do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'DEPENDENCY MISSING: users';
  end if;
end $$;

create table if not exists public.scoreboard_months (
  month       date primary key check (extract(day from month) = 1),
  frozen_at   timestamptz not null default now(),
  frozen_by   uuid not null references public.users(id)
);

create table if not exists public.scoreboard_awards (
  month        date not null check (extract(day from month) = 1),
  award        text not null check (award in ('star_performer', 'star_seller', 'most_improved', 'team_player', 'never_late')),
  employee_id  uuid not null references public.users(id),
  note         text check (note is null or length(btrim(note)) between 2 and 200),
  created_at   timestamptz not null default now(),
  primary key (month, award, employee_id)
);
-- One winner for every award but Never Late.
create unique index if not exists scoreboard_awards_one_winner on public.scoreboard_awards (month, award) where award <> 'never_late';

create or replace function public.scoreboard_awards_frozen()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'SCOREBOARD_AWARDS_FINAL: announced awards are never changed' using errcode = '42501';
  end if;
  if exists (select 1 from public.scoreboard_months m where m.month = new.month) then
    raise exception 'SCOREBOARD_MONTH_FROZEN: this month is already frozen and announced' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.scoreboard_awards_frozen() from public, anon, authenticated;
drop trigger if exists scoreboard_awards_frozen on public.scoreboard_awards;
create trigger scoreboard_awards_frozen
  before insert or update or delete on public.scoreboard_awards
  for each row execute function public.scoreboard_awards_frozen();

create or replace function public.scoreboard_months_final()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'SCOREBOARD_MONTH_FROZEN: a frozen month stays frozen' using errcode = '42501';
end;
$$;
revoke all on function public.scoreboard_months_final() from public, anon, authenticated;
drop trigger if exists scoreboard_months_final on public.scoreboard_months;
create trigger scoreboard_months_final
  before update or delete on public.scoreboard_months
  for each row execute function public.scoreboard_months_final();

create table if not exists public.scoreboard_reviews (
  month        date not null check (extract(day from month) = 1),
  employee_id  uuid not null references public.users(id),
  goals        text[] not null check (cardinality(goals) between 1 and 3),
  checkin_on   date not null,
  warning      boolean not null default false,
  note         text check (note is null or length(note) <= 1000),
  created_by   uuid not null references public.users(id),
  updated_at   timestamptz not null default now(),
  primary key (month, employee_id),
  constraint scoreboard_reviews_checkin_after_month check (checkin_on > month)
);

alter table public.scoreboard_months enable row level security;
alter table public.scoreboard_awards enable row level security;
alter table public.scoreboard_reviews enable row level security;
revoke all on public.scoreboard_months, public.scoreboard_awards, public.scoreboard_reviews from public, anon, authenticated;

do $$
begin
  if has_table_privilege('authenticated', 'public.scoreboard_reviews', 'select')
     or has_table_privilege('anon', 'public.scoreboard_awards', 'select') then
    raise exception 'scoreboard review tables must be closed to the browser';
  end if;
end $$;

-- 20270807000000_picture_wallet.sql
--
-- Picture credits (owner, 2026-11-18). Every paid picture press (Studio Image, Edit PI Customize image, the
-- quotation image studio's Clean up and Change it) takes credits from a wallet before the paid fal call is made.
--
--   image_credit_settings    ONE row: the pause switch, the "limits on" switch, the monthly pool, the daily cap
--                            per person and the rupees per dollar used for display.
--   image_credit_allowances  monthly credits per person; used only while limits are on.
--   image_credit_ledger      one row per press (who, which tool, credits, the dollars it costs us, charged or
--                            refunded). The tracking page reads it.
--
-- MEASURE FIRST: `enforce` is false when this is applied. The wallet then records every press and blocks
-- NOTHING except the pause switch, so nobody loses access on the day it ships. The owner turns limits on
-- (and sets allowances) after seeing real numbers on the tracking page. With limits on, a press is refused when
-- the person has no allowance, has used their month's credits or the day's cap, or the company pool for the
-- month is used up. Month and day are India time.
--
-- ALL ACCESS IS THROUGH THE SERVER. The tables have row level security on and no policies, the functions are
-- SECURITY DEFINER and executable by the service role only; the routes check who the caller is.
--
-- image_credit_spend() locks the settings row, so two presses at the same moment cannot both pass a limit.
--
-- ROLLBACK: nothing existing is changed. Revert the code, then drop the three functions and three tables
-- (a new, later migration; this one is not edited once applied).

create table if not exists public.image_credit_settings (
  id           boolean     primary key default true check (id),
  enabled      boolean     not null default true,
  enforce      boolean     not null default false,
  monthly_pool integer     not null default 1500 check (monthly_pool >= 0),
  daily_cap    integer     not null default 60   check (daily_cap >= 1),
  inr_per_usd  numeric(6,2) not null default 88  check (inr_per_usd > 0),
  updated_by   uuid        references public.users(id) on delete set null,
  updated_at   timestamptz not null default now()
);
insert into public.image_credit_settings (id) values (true) on conflict (id) do nothing;

create table if not exists public.image_credit_allowances (
  user_id         uuid        primary key references public.users(id) on delete cascade,
  monthly_credits integer     not null check (monthly_credits >= 0),
  updated_by      uuid        references public.users(id) on delete set null,
  updated_at      timestamptz not null default now()
);

create table if not exists public.image_credit_ledger (
  id           uuid          primary key default gen_random_uuid(),
  user_id      uuid          references public.users(id) on delete set null,
  tool         text          not null check (tool in ('studio', 'pi_customize', 'quotation_clean', 'quotation_change')),
  credits      integer       not null check (credits > 0),
  usd_estimate numeric(8,4)  not null check (usd_estimate >= 0),
  status       text          not null default 'charged' check (status in ('charged', 'refunded')),
  created_at   timestamptz   not null default now(),
  refunded_at  timestamptz
);
create index if not exists image_credit_ledger_created_idx on public.image_credit_ledger (created_at desc);
create index if not exists image_credit_ledger_user_created_idx on public.image_credit_ledger (user_id, created_at desc);

alter table public.image_credit_settings   enable row level security;
alter table public.image_credit_allowances enable row level security;
alter table public.image_credit_ledger     enable row level security;
revoke all on table public.image_credit_settings, public.image_credit_allowances, public.image_credit_ledger from anon, authenticated;

-- ── Take credits before a paid call ──────────────────────────────────────────────────────────────────────
create or replace function public.image_credit_spend(p_user uuid, p_tool text, p_credits integer, p_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s            public.image_credit_settings;
  allowance    integer;
  month_start  timestamptz := date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  day_start    timestamptz := date_trunc('day',   now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  user_month   integer;
  user_day     integer;
  pool_used    integer;
  new_id       uuid;
begin
  if p_credits is null or p_credits < 1 or p_usd is null or p_usd < 0 then
    raise exception 'IMAGE_CREDIT_BAD_COST';
  end if;

  -- One row, locked: spends are serialised, so the sums below cannot be raced past.
  select * into s from public.image_credit_settings where id for update;

  if not s.enabled then
    return jsonb_build_object('ok', false, 'code', 'PAUSED');
  end if;

  if s.enforce then
    select monthly_credits into allowance from public.image_credit_allowances where user_id = p_user;
    if allowance is null then
      return jsonb_build_object('ok', false, 'code', 'NO_ALLOWANCE');
    end if;

    select coalesce(sum(credits), 0) into user_month from public.image_credit_ledger
      where user_id = p_user and status = 'charged' and created_at >= month_start;
    if user_month + p_credits > allowance then
      return jsonb_build_object('ok', false, 'code', 'USER_MONTH');
    end if;

    select coalesce(sum(credits), 0) into user_day from public.image_credit_ledger
      where user_id = p_user and status = 'charged' and created_at >= day_start;
    if user_day + p_credits > s.daily_cap then
      return jsonb_build_object('ok', false, 'code', 'USER_DAY');
    end if;

    select coalesce(sum(credits), 0) into pool_used from public.image_credit_ledger
      where status = 'charged' and created_at >= month_start;
    if pool_used + p_credits > s.monthly_pool then
      return jsonb_build_object('ok', false, 'code', 'POOL');
    end if;
  end if;

  insert into public.image_credit_ledger (user_id, tool, credits, usd_estimate)
  values (p_user, p_tool, p_credits, p_usd)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'ledger_id', new_id);
end;
$$;

-- ── Give credits back when fal clearly refused the request before running it ───────────────────────────────
create or replace function public.image_credit_refund(p_ledger uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.image_credit_ledger set status = 'refunded', refunded_at = now()
    where id = p_ledger and status = 'charged';
  return found;
end;
$$;

-- ── What one person can still do (for the note beside the button) ───────────────────────────────────────────
create or replace function public.image_credit_status(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s            public.image_credit_settings;
  allowance    integer;
  month_start  timestamptz := date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  day_start    timestamptz := date_trunc('day',   now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  user_month   integer;
  user_day     integer;
  pool_used    integer;
begin
  select * into s from public.image_credit_settings where id;
  if not s.enforce then
    return jsonb_build_object('enabled', s.enabled, 'enforce', false);
  end if;

  select monthly_credits into allowance from public.image_credit_allowances where user_id = p_user;
  if allowance is null then
    return jsonb_build_object('enabled', s.enabled, 'enforce', true, 'allowed', false);
  end if;

  select coalesce(sum(credits), 0) into user_month from public.image_credit_ledger
    where user_id = p_user and status = 'charged' and created_at >= month_start;
  select coalesce(sum(credits), 0) into user_day from public.image_credit_ledger
    where user_id = p_user and status = 'charged' and created_at >= day_start;
  select coalesce(sum(credits), 0) into pool_used from public.image_credit_ledger
    where status = 'charged' and created_at >= month_start;

  return jsonb_build_object(
    'enabled', s.enabled, 'enforce', true, 'allowed', true,
    'month_left', greatest(allowance - user_month, 0),
    'today_left', greatest(s.daily_cap - user_day, 0),
    'pool_left',  greatest(s.monthly_pool - pool_used, 0)
  );
end;
$$;

-- ── The tracking page: by day, by person, by tool (India days; charged presses only) ────────────────────────
create or replace function public.image_credit_report(p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ist_today   date := (now() at time zone 'Asia/Kolkata')::date;
  month_first date := date_trunc('month', now() at time zone 'Asia/Kolkata')::date;
  from_day    date := (now() at time zone 'Asia/Kolkata')::date - (greatest(coalesce(p_days, 14), 1) - 1);
  result      jsonb;
begin
  with l as (
    select user_id, tool, credits, usd_estimate, (created_at at time zone 'Asia/Kolkata')::date as day
    from public.image_credit_ledger
    where status = 'charged'
      and (created_at at time zone 'Asia/Kolkata')::date >= least(from_day, month_first, ist_today - 7)
  ), per_day_user as (
    select day, user_id, count(*) as n from l group by day, user_id
  ), top_day as (
    select distinct on (day) day, user_id, n from per_day_user order by day, n desc, user_id
  )
  select jsonb_build_object(
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', d.day, 'presses', d.presses, 'credits', d.credits, 'usd', d.usd,
                                          'top_user', t.user_id, 'top_presses', t.n) order by d.day desc)
      from (select day, count(*) as presses, sum(credits) as credits, sum(usd_estimate) as usd
            from l where day >= from_day group by day) d
      left join top_day t on t.day = d.day
    ), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'presses', p.presses, 'credits', p.credits, 'usd', p.usd)
                       order by p.presses desc)
      from (select user_id, count(*) as presses, sum(credits) as credits, sum(usd_estimate) as usd
            from l where day >= month_first group by user_id) p
    ), '[]'::jsonb),
    'tools', coalesce((
      select jsonb_agg(jsonb_build_object('tool', x.tool, 'presses', x.presses, 'credits', x.credits, 'usd', x.usd)
                       order by x.presses desc)
      from (select tool, count(*) as presses, sum(credits) as credits, sum(usd_estimate) as usd
            from l where day >= month_first group by tool) x
    ), '[]'::jsonb),
    'today', (select jsonb_build_object('presses', count(*), 'credits', coalesce(sum(credits), 0), 'usd', coalesce(sum(usd_estimate), 0))
              from l where day = ist_today),
    'month', (select jsonb_build_object('presses', count(*), 'credits', coalesce(sum(credits), 0), 'usd', coalesce(sum(usd_estimate), 0))
              from l where day >= month_first),
    'usd_prev7', (select coalesce(sum(usd_estimate), 0) from l where day >= ist_today - 7 and day < ist_today)
  ) into result;

  return result;
end;
$$;

revoke all on function public.image_credit_spend(uuid, text, integer, numeric) from public, anon, authenticated;
revoke all on function public.image_credit_refund(uuid)                         from public, anon, authenticated;
revoke all on function public.image_credit_status(uuid)                         from public, anon, authenticated;
revoke all on function public.image_credit_report(integer)                      from public, anon, authenticated;
grant execute on function public.image_credit_spend(uuid, text, integer, numeric) to service_role;
grant execute on function public.image_credit_refund(uuid)                         to service_role;
grant execute on function public.image_credit_status(uuid)                         to service_role;
grant execute on function public.image_credit_report(integer)                      to service_role;

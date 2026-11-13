-- REVIEW RANKINGS: ONE ON/OFF SWITCH, SET BY AN ADMINISTRATOR IN CONTROL CENTER.
--
-- WHAT THIS MIGRATION IS FOR
-- --------------------------
-- The Reviews leaderboard (who leads this month, the ranked list) can be hidden
-- from employees. The administrator flips one switch in Control Center →
-- Reviews → Rankings; every screen that shows the ranking reads the switch and
-- hides itself when it is off.
--
-- IT STARTS OFF. The row is created with rankings_visible = false, so the
-- moment this ships the rankings are hidden, and an administrator turns them on
-- when they want them back.
--
-- WHAT IT ADDS
--   1.  public.review_display_settings      ONE row (id is always true), RLS on
--   2.  set_review_rankings_visible(bool)   the only write, admin only
--
-- WHO CAN DO WHAT
--   read   every signed-in user: the screens need to know whether to draw the board
--   write  an active, non-deleted administrator, through the function only. No
--          client role holds INSERT, UPDATE or DELETE on the table.
--
-- WHAT IT DOES NOT TOUCH. customer_review_leaderboard() and every other review
-- function, table and policy. The switch decides what a screen draws; the
-- leaderboard data itself (names and eligible-review counts, which every
-- signed-in employee could already read) is unchanged.
--
-- IDEMPOTENT. Re-running is a no-op; the block at the end raises if anything
-- did not take.
--
-- ROLLBACK (nothing else depends on it, so drop in this order):
--   drop function if exists public.set_review_rankings_visible(boolean);
--   drop table    if exists public.review_display_settings;


-- ═══ 0. What this migration assumes already exists ═══════════════════════════

do $$
begin
  if to_regclass('public.users') is null then
    raise exception 'public.users is missing';
  end if;
end;
$$;


-- ═══ 1. The switch ═══════════════════════════════════════════════════════════

create table if not exists public.review_display_settings (
  -- Always true, and the primary key: a second row cannot exist.
  id                boolean     primary key default true check (id),
  rankings_visible  boolean     not null default false,
  updated_by        uuid        references public.users(id),
  updated_at        timestamptz not null default now()
);

comment on table public.review_display_settings is
  'One row. rankings_visible says whether employees see the review leaderboard. Written only by set_review_rankings_visible().';

insert into public.review_display_settings (id, rankings_visible)
values (true, false)
on conflict (id) do nothing;

alter table public.review_display_settings enable row level security;

revoke all on public.review_display_settings from public, anon, authenticated;
grant  select on public.review_display_settings to authenticated;

drop policy if exists "review_display_settings_select" on public.review_display_settings;
create policy "review_display_settings_select" on public.review_display_settings
  for select to authenticated
  using (true);


-- ═══ 2. The one write ════════════════════════════════════════════════════════

create or replace function public.set_review_rankings_visible(p_visible boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'Sign in to change this.' using errcode = '42501';
  end if;
  if p_visible is null then
    raise exception 'Choose on or off.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_caller
      and u.role = 'admin'
      and u.is_active
      and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'Only an administrator can change this.' using errcode = '42501';
  end if;

  update public.review_display_settings
     set rankings_visible = p_visible,
         updated_by       = v_caller,
         updated_at       = now()
   where id;

  return p_visible;
end;
$$;

comment on function public.set_review_rankings_visible(boolean) is
  'Admin only. Turns the review leaderboard on or off for every employee.';

revoke execute on function public.set_review_rankings_visible(boolean) from public, anon;
grant  execute on function public.set_review_rankings_visible(boolean) to authenticated;


-- ═══ 3. Verification: raises if any of it did not take ═══════════════════════

do $$
begin
  if (select count(*) from public.review_display_settings) <> 1 then
    raise exception 'review_display_settings must hold exactly one row';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.review_display_settings'::regclass) then
    raise exception 'review_display_settings must have row level security on';
  end if;
  if has_table_privilege('authenticated', 'public.review_display_settings', 'INSERT')
     or has_table_privilege('authenticated', 'public.review_display_settings', 'UPDATE')
     or has_table_privilege('authenticated', 'public.review_display_settings', 'DELETE')
     or has_table_privilege('anon', 'public.review_display_settings', 'SELECT') then
    raise exception 'review_display_settings must be readable by signed-in users only and written by no client role';
  end if;
  if not has_function_privilege('authenticated', 'public.set_review_rankings_visible(boolean)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_review_rankings_visible(boolean)', 'EXECUTE') then
    raise exception 'set_review_rankings_visible must be executable by signed-in users only';
  end if;
end;
$$;

-- BOE Credits — Half Day and Full Day / Absent redemption each get an ON/OFF
-- switch in BOE Credits Settings. Both are OFF from this migration onward; an
-- administrator can switch either one on later, independently of the other.
--
-- A CONFIGURATION CHANGE, NOT A REMOVAL
-- -------------------------------------
-- Two booleans on the append-only settings row, one per kind of day. OFF means
-- no NEW attendance redemption of that kind: the payslip offers none, the
-- employee pages explain none, the redemption route refuses one, and — should
-- anything reach the table anyway — the trigger below refuses the insert.
--
-- BOTH COLUMNS DEFAULT TO FALSE. Redemption is an optional feature: a settings
-- row does not switch it on unless an administrator explicitly does. Adding a
-- column with a constant default gives every EXISTING row that value without
-- rewriting or updating any row, so the settings row in force — and every
-- earlier one — reads OFF as soon as this file applies. The append-only trigger
-- on boe_credit_settings (BEFORE UPDATE OR DELETE) is never involved, and no
-- settings row is inserted, updated or deleted.
--
-- What OFF never does:
--   * change a price. half_day_redemption_credits / full_day_redemption_credits
--     keep their stored values, so switching back on restores them;
--   * touch a redemption already made, its ledger row, or any balance;
--   * reverse coverage. The payroll lifecycle skips an Absent to Half Day
--     re-price while Half Day is off (src/lib/payroll/creditCoverage.ts) and
--     leaves the absent-day coverage in place.
--
-- Not wrapped in an explicit transaction, like the credits files before it.

-- ═══ 1. The two switches — OFF ═════════════════════════════════════════════

alter table public.boe_credit_settings
  add column if not exists half_day_redemption_enabled boolean not null default false,
  add column if not exists full_day_redemption_enabled boolean not null default false;

comment on column public.boe_credit_settings.half_day_redemption_enabled is
  'When false (the default), no new Half Day attendance redemption may be made. half_day_redemption_credits is kept for when an administrator switches it on. Existing redemptions are never touched.';

comment on column public.boe_credit_settings.full_day_redemption_enabled is
  'When false (the default), no new Full Day / Absent attendance redemption may be made. full_day_redemption_credits is kept for when an administrator switches it on. Existing redemptions are never touched.';

-- ═══ 2. The database refuses a redemption of a switched-off kind ═══════════
--
-- A BEFORE INSERT trigger on the record rather than a re-created
-- redeem_boe_credits_for_attendance(): the function body stays exactly as
-- 20261204000000 left it, and every path that writes a record — today only that
-- function — is covered. The ledger row the function posts first is rolled back
-- with the refused insert, because both are one transaction.

create or replace function public.boe_credit_attendance_redemption_enabled_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
begin
  select case new.deduction_type
           when 'half_day' then s.half_day_redemption_enabled
           else                 s.full_day_redemption_enabled
         end
    into v_enabled
    from public.boe_credit_settings s
   order by s.created_at desc
   limit 1;

  -- No settings row leaves v_enabled null; redeem_boe_credits_for_attendance()
  -- already refuses that case with BOE_CREDITS_SETTINGS.
  if v_enabled is false then
    raise exception 'BOE_CREDITS_REDEMPTION_DISABLED: BOE Credits cannot be used to cover this deduction'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke execute on function public.boe_credit_attendance_redemption_enabled_guard() from public, anon, authenticated;

drop trigger if exists boe_credit_attendance_redemptions_enabled_guard on public.boe_credit_attendance_redemptions;
create trigger boe_credit_attendance_redemptions_enabled_guard
  before insert on public.boe_credit_attendance_redemptions
  for each row execute function public.boe_credit_attendance_redemption_enabled_guard();

-- ═══ 3. Post-conditions ════════════════════════════════════════════════════
--
-- Structural only, so the file stays re-runnable after an administrator has
-- switched a redemption on.

do $$
begin
  if (
    select count(*) from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'boe_credit_settings'
       and column_name in ('half_day_redemption_enabled', 'full_day_redemption_enabled')
       and data_type    = 'boolean'
       and is_nullable  = 'NO'
  ) <> 2 then
    raise exception 'BOE Credits redemption switches: the two settings columns are missing or nullable';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.boe_credit_attendance_redemptions'::regclass
       and tgname  = 'boe_credit_attendance_redemptions_enabled_guard'
       and not tgisinternal
  ) then
    raise exception 'BOE Credits redemption switches: the attendance redemption guard trigger is missing';
  end if;
end $$;

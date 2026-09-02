-- ═══════════════════════════════════════════════════════════════════════════
-- BOE Credits — Phase 1C: an employee spends credits to cover one attendance
-- deduction, before payroll is locked — and gets them back if that deduction
-- later stops existing.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
-- --------------
--   public.boe_credit_attendance_redemptions              one row per redemption; closed once by its reversal
--   public.boe_credit_attendance_redemptions_guard()      the table's immutability rule
--   public.boe_credit_redemption_closed_by_reversal()     ledger trigger: a reversal closes its redemption
--   public.redeem_boe_credits_for_attendance(...)         the ONE way a day is covered — service role only
--   public.reverse_boe_credit_attendance_redemption(...)  the ONE way coverage is withdrawn — service role only
--
-- THE BUSINESS RULE, STATED ONCE
-- ------------------------------
--   Half Day  = 1 credit
--   Absent    = 2 credits
--
-- Whole credits, fixed, and NOT linked to salary, to rupees or to
-- boe_credit_settings.credit_value. credit_value is a Payroll figure for a
-- later phase and plays no part in what a day costs here; the two literals in
-- redeem_boe_credits_for_attendance() are the whole of the cost model,
-- mirrored by ATTENDANCE_REDEMPTION_COST in src/lib/boeCredits/
-- attendanceRedemption.ts and pinned against this file by
-- attendanceRedemption.test.ts. The credits spent are also WRITTEN ON THE
-- ROW, so history reads the same if the constants ever change.
--
-- THE LEDGER VOCABULARY IS THE FOUNDATION'S, UNCHANGED
-- ---------------------------------------------------
-- 20261101000000 fixed the four transaction kinds in a CHECK and in the
-- posting function: review_reward, redemption, reversal, admin_adjustment.
-- A redemption here is therefore transaction_type 'redemption' (negative),
-- and its source is source_type 'attendance_redemption' with source_id = the
-- id of the redemption row below. Nothing on the ledger is renamed or
-- widened. The ledger's one-row-per-source index then means: one ledger row
-- per redemption record, one reversal per ledger row — its existing rule.
--
-- THE RECORD, AND WHY IT CAN BE CLOSED BUT NEVER EDITED
-- ----------------------------------------------------
-- The ledger holds the money; it cannot say WHICH day a row covered or
-- whether it was a half day. So each redemption also writes one row here, in
-- the same transaction, carrying the date, the kind, the credits and the
-- ledger row. Coverage is ACTIVE while reversal_transaction_id is NULL, and
-- the partial unique index below is what makes two active redemptions for
-- one employee-date impossible at the table — whatever path led there.
--
-- A record changes exactly once, when its ledger row is reversed: the
-- reversal's id and instant are written and nothing else may move — the
-- guard trigger refuses every other UPDATE and every DELETE, for every role.
-- That closing write is made by a trigger on the LEDGER (any reversal of a
-- redemption row closes its record), so the ledger and the record cannot
-- disagree about whether a day is covered. History is complete: the
-- redemption, its reversal, and any later redemption of the same day are all
-- separate rows that are never rewritten. This is the same shape as
-- attendance_day_corrections' is_current / superseded_at chain.
--
-- WHY A DAY CAN BE REDEEMED AGAIN AFTER A REVERSAL
-- -----------------------------------------------
-- The uniqueness rule is "at most one ACTIVE coverage per employee-date",
-- not "one ever". Attendance moves: a day redeemed as Absent, corrected to
-- Present (redemption reversed, credits restored), and later legitimately
-- corrected back to Absent has an eligible deduction again, and may be
-- covered again with a NEW record and a NEW ledger row. Double-spend
-- protection is unchanged: the per-employee advisory lock serialises every
-- redemption and every reversal for one employee, the active-only index is
-- the guarantee behind it, and post_boe_credit_transaction() still refuses
-- an overdraft under that same lock.
--
-- THE LIFECYCLE, IN ONE SENTENCE. Credits stay spent only while there is a
-- chargeable deduction for that employee and date: the application's
-- correction and regeneration paths (src/lib/payroll/creditCoverage.ts)
-- reverse a redemption whose day is no longer a chargeable Absent or Half
-- Day — corrected to Present, absorbed by paid leave, ₹0 — and re-price one
-- bought as Absent for a day that became a Half Day (reverse the 2, post a
-- fresh 1). Both go through the two functions below; nothing edits a ledger
-- amount.
--
-- WHAT THE DATABASE DECIDES, AND WHAT IT TRUSTS THE ROUTE FOR
-- -----------------------------------------------------------
-- Whether a date carries a genuine half-day or full-day salary deduction is
-- decided by the payroll engine (src/lib/payroll/engine.ts) in the
-- application. The route runs it and refuses anything that is not a
-- chargeable absent or half-day line BEFORE calling here; this function then
-- decides everything a database CAN decide, under locks:
--   * the actor is the employee, or an active admin re-pricing on the
--     employee's behalf after correcting attendance;
--   * the kind is one of the two, and the cost follows from it;
--   * the period exists and is NOT locked; payroll has been generated for
--     this employee; the date is inside the month and not in the future;
--   * no ACTIVE coverage exists for the day;
--   * the balance suffices (post_boe_credit_transaction, same lock);
--   * the ledger row and the record are written together or not at all.
--
-- LOCKED PAYROLL. Redemption and reversal are both refused. The existing
-- unlock (status back to 'generated') admits them again; no second door.
--
-- ATTENDANCE TRUTH IS NOT REWRITTEN. Nothing here touches attendance_records
-- or attendance_day_corrections, and payroll_results is only READ.
--
-- OLD-CODE COMPATIBILITY
-- ----------------------
-- This file applies BEFORE the Phase 1C application deploys. It creates new
-- objects, adds one AFTER INSERT trigger on the ledger that acts only on a
-- 'reversal' row, and restates two column comments. It does not alter any
-- existing column, constraint, index, policy, grant or function, so the
-- running Phase 1B code — which never posts a reversal from any route —
-- behaves exactly as before. The runner diffs pg_get_functiondef of the
-- foundation's functions before and after applying this file to prove it.
--
-- ASSUMPTIONS TO CHECK BEFORE THIS IS APPLIED
--   1. 20261101000000 is applied: boe_credit_transactions,
--      can_manage_boe_credits(), post_boe_credit_transaction(...),
--      reverse_boe_credit_transaction(uuid, uuid, text).
--   2. public.payroll_periods(id, payroll_month, payroll_year, status) and
--      public.payroll_results(payroll_period_id, employee_id) exist.
--   3. public.users(id, role, is_active, is_deleted) exists.
--
-- PRODUCTION SAFETY. Additive; every statement guarded; re-runnable.
--
-- ROLLBACK
-- --------
--   drop trigger  if exists boe_credit_redemption_closed_by_reversal on public.boe_credit_transactions;
--   drop function if exists public.boe_credit_redemption_closed_by_reversal();
--   drop function if exists public.reverse_boe_credit_attendance_redemption(uuid, uuid, text);
--   drop function if exists public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid);
--   drop table    if exists public.boe_credit_attendance_redemptions;
--   drop function if exists public.boe_credit_attendance_redemptions_guard();
-- Ledger rows already posted stay, as any ledger row does; with the table
-- gone the engine sees no coverage and the next regeneration charges the day
-- again — reverse the ledger rows first if that is not intended.

-- ═══ 1. The record ═════════════════════════════════════════════════════════

create table if not exists public.boe_credit_attendance_redemptions (
  id                      uuid        primary key default gen_random_uuid(),

  employee_id             uuid        not null references public.users(id),
  attendance_date         date        not null,

  -- Which deduction the credits covered. The cost follows from it.
  deduction_type          text        not null check (deduction_type in ('half_day', 'absent')),

  -- Credits spent, written here so the record stays self-describing.
  credits                 integer     not null check (credits > 0),

  -- The ledger row that paid for it: transaction_type 'redemption',
  -- source_type 'attendance_redemption', source_id = this row's id.
  transaction_id          uuid        not null unique references public.boe_credit_transactions(id),

  -- The payroll month the day belongs to. NOT NULL, unlike the ledger's
  -- nullable column: a redemption is always against a specific month.
  payroll_period_id       uuid        not null references public.payroll_periods(id),

  created_by              uuid        references public.users(id),
  created_at              timestamptz not null default now(),

  -- Set exactly once, by the ledger trigger, when the ledger row is reversed.
  -- NULL means the coverage is ACTIVE.
  reversal_transaction_id uuid        unique references public.boe_credit_transactions(id),
  reversed_at             timestamptz,

  constraint boe_credit_attendance_redemptions_reversal_consistent check (
    (reversal_transaction_id is null) = (reversed_at is null)
  )
);

comment on table public.boe_credit_attendance_redemptions is
  'BOE Credits Phase 1C: one row per attendance day an employee covered with credits. Written by redeem_boe_credits_for_attendance() with its ledger row; closed once (reversal_transaction_id, reversed_at) when that ledger row is reversed; never edited or deleted otherwise. Coverage is ACTIVE while reversal_transaction_id is NULL.';

comment on column public.boe_credit_attendance_redemptions.credits is
  'Whole credits spent: 1 for a half day, 2 for an absent day. Fixed, never derived from salary or credit_value.';

-- THE UNIQUENESS RULE: at most one ACTIVE coverage per employee-date. A
-- reversed record drops out of the index, so the day can be covered again.
create unique index if not exists boe_credit_attendance_redemptions_active_unique
  on public.boe_credit_attendance_redemptions (employee_id, attendance_date)
  where reversal_transaction_id is null;

create index if not exists boe_credit_attendance_redemptions_period_idx
  on public.boe_credit_attendance_redemptions (payroll_period_id, employee_id);

-- ─── 1a. Immutability: close once, otherwise append-only ────────────────────

create or replace function public.boe_credit_attendance_redemptions_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BOE_CREDITS_APPEND_ONLY: boe_credit_attendance_redemptions is never deleted — reverse the redemption instead'
      using errcode = '42501';
  end if;
  if old.reversal_transaction_id is not null then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a reversed redemption is closed and cannot change'
      using errcode = '42501';
  end if;
  if new.reversal_transaction_id is null or new.reversed_at is null then
    raise exception 'BOE_CREDITS_APPEND_ONLY: the only permitted change to a redemption is closing it with its reversal'
      using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'reversal_transaction_id' - 'reversed_at')
     <> (to_jsonb(old) - 'reversal_transaction_id' - 'reversed_at') then
    raise exception 'BOE_CREDITS_APPEND_ONLY: closing a redemption may not alter anything else on it'
      using errcode = '42501';
  end if;
  -- Closed only by the genuine reversal of ITS OWN ledger row — never by hand
  -- with some other id, which would say "not covered" while the credits stay
  -- spent.
  if not exists (
    select 1 from public.boe_credit_transactions t
     where t.id = new.reversal_transaction_id
       and t.transaction_type = 'reversal'
       and t.source_type = 'boe_credit_transaction'
       and t.source_id = old.transaction_id
  ) then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a redemption is closed only by the reversal of its own ledger row'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.boe_credit_attendance_redemptions_guard() from public, anon, authenticated;

drop trigger if exists boe_credit_attendance_redemptions_guard on public.boe_credit_attendance_redemptions;
create trigger boe_credit_attendance_redemptions_guard
  before update or delete on public.boe_credit_attendance_redemptions
  for each row execute function public.boe_credit_attendance_redemptions_guard();

-- ─── 1b. Authorization ──────────────────────────────────────────────────────
-- Same posture as the ledger: an employee reads their own rows, management
-- reads everyone's, no client role can write.

alter table public.boe_credit_attendance_redemptions enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.boe_credit_attendance_redemptions from authenticated, anon;
revoke select on public.boe_credit_attendance_redemptions from anon;
grant  select on public.boe_credit_attendance_redemptions to authenticated;

drop policy if exists "boe_credit_attendance_redemptions_read_own_or_manage" on public.boe_credit_attendance_redemptions;
create policy "boe_credit_attendance_redemptions_read_own_or_manage"
  on public.boe_credit_attendance_redemptions
  for select
  to authenticated
  using (employee_id = auth.uid() or public.can_manage_boe_credits());

-- ═══ 2. A reversal closes its redemption ═══════════════════════════════════
--
-- Fires on the LEDGER, after any 'reversal' row is inserted, and closes the
-- redemption record whose ledger row it reverses — if there is one and it is
-- still open. Every reversal path (the function in §4, or an administrator
-- through reverse_boe_credit_transaction directly) therefore withdraws the
-- coverage; the record can never say "covered" while the ledger says
-- "refunded". Reversals of rewards and adjustments match no record and do
-- nothing.

create or replace function public.boe_credit_redemption_closed_by_reversal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.transaction_type = 'reversal' and new.source_type = 'boe_credit_transaction' then
    update public.boe_credit_attendance_redemptions
       set reversal_transaction_id = new.id,
           reversed_at             = new.created_at
     where transaction_id = new.source_id
       and reversal_transaction_id is null;
  end if;
  return null;
end;
$$;

revoke execute on function public.boe_credit_redemption_closed_by_reversal() from public, anon, authenticated;

drop trigger if exists boe_credit_redemption_closed_by_reversal on public.boe_credit_transactions;
create trigger boe_credit_redemption_closed_by_reversal
  after insert on public.boe_credit_transactions
  for each row
  when (new.transaction_type = 'reversal')
  execute function public.boe_credit_redemption_closed_by_reversal();

-- The ledger's source vocabulary, restated with the new kind. The foundation
-- named 'payroll_period' for a redemption; Phase 1C names the redemption
-- record itself.
comment on column public.boe_credit_transactions.source_type is
  'What produced this row: customer_review (a verified review), attendance_redemption (a Phase 1C attendance redemption; source_id = boe_credit_attendance_redemptions.id), boe_credit_transaction (for a reversal) or manual (an admin adjustment, which has no source_id).';

comment on column public.boe_credit_settings.credit_value is
  'Rupees per credit, reserved for a later Payroll phase. NOT used by attendance redemption: a half day costs 1 credit and an absent day 2, fixed.';

-- ═══ 3. The redemption ═════════════════════════════════════════════════════
--
-- SERVICE ROLE ONLY, like post_boe_credit_transaction(), which it calls.
-- Returns jsonb: { redemption_id, transaction_id, deduction_type,
--                  attendance_date, credits, available_credits }

create or replace function public.redeem_boe_credits_for_attendance(
  p_employee_id       uuid,
  p_payroll_period_id uuid,
  p_attendance_date   date,
  p_deduction_type    text,
  p_actor_id          uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period  public.payroll_periods%rowtype;
  v_cost    integer;
  v_id      uuid;
  v_tx      uuid;
  v_label   text;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_balance integer;
begin
  -- 1. the actor: the employee, or an active admin re-pricing on their behalf
  if p_employee_id is null or p_actor_id is null then
    raise exception 'BOE_CREDITS_DENIED: credits can only be redeemed by the employee whose attendance they cover'
      using errcode = '42501';
  end if;
  if p_actor_id <> p_employee_id and not exists (
    select 1 from public.users
     where id = p_actor_id and role = 'admin' and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'BOE_CREDITS_DENIED: credits can only be redeemed by the employee whose attendance they cover'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users
     where id = p_employee_id and coalesce(is_deleted, false) = false
  ) then
    raise exception 'BOE_CREDITS_EMPLOYEE: the employee does not exist or has been deleted'
      using errcode = 'P0002';
  end if;

  -- 2. the kind, and the cost that follows from it. THE TWO LITERALS.
  v_cost := case p_deduction_type
    when 'half_day' then 1
    when 'absent'   then 2
    else null
  end;
  if v_cost is null then
    raise exception 'BOE_CREDITS_REDEMPTION_TYPE: credits cover a half day or an absent day, not %', coalesce(p_deduction_type, '<null>')
      using errcode = '22023';
  end if;

  -- 3. serialise per employee FIRST — the same key post_boe_credit_transaction
  --    takes (re-entrant), and the key the reversal takes — so a redemption
  --    and a reversal for one person happen one after the other, and the
  --    active-coverage check below cannot race either. Taken before the
  --    period lock so the two functions acquire in the same order.
  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  -- 4. the period. FOR SHARE holds off a concurrent lock until this commits.
  if p_payroll_period_id is null then
    raise exception 'BOE_CREDITS_PERIOD: a payroll period is required'
      using errcode = '22023';
  end if;
  select * into v_period from public.payroll_periods where id = p_payroll_period_id for share;
  if not found then
    raise exception 'BOE_CREDITS_PERIOD: the payroll period does not exist'
      using errcode = 'P0002';
  end if;
  if v_period.status = 'locked' then
    raise exception 'BOE_CREDITS_PERIOD_LOCKED: payroll for this month is locked, so credits can no longer be applied to it'
      using errcode = '55000';
  end if;

  -- 5. the deduction it covers must be one that is shown
  if not exists (
    select 1 from public.payroll_results
     where payroll_period_id = p_payroll_period_id and employee_id = p_employee_id
  ) then
    raise exception 'BOE_CREDITS_NOT_GENERATED: payroll for this month has not been generated yet, so there is no deduction to cover'
      using errcode = '55000';
  end if;

  -- 6. the date: inside the month, and not ahead of today
  if p_attendance_date is null
     or extract(year  from p_attendance_date)::integer <> v_period.payroll_year
     or extract(month from p_attendance_date)::integer <> v_period.payroll_month then
    raise exception 'BOE_CREDITS_DATE: the attendance date is not inside this payroll period'
      using errcode = '22023';
  end if;
  if p_attendance_date > v_today then
    raise exception 'BOE_CREDITS_DATE: credits cannot be applied to a date that has not happened yet'
      using errcode = '22023';
  end if;

  -- 7. no ACTIVE coverage for the day. The partial unique index refuses a
  --    second one whatever path led here; this says so in words first.
  if exists (
    select 1 from public.boe_credit_attendance_redemptions
     where employee_id = p_employee_id
       and attendance_date = p_attendance_date
       and reversal_transaction_id is null
  ) then
    raise exception 'BOE_CREDITS_ALREADY_COVERED: this day is already covered with BOE Credits'
      using errcode = '23505';
  end if;

  -- 8. the ledger row, through the one write path (duplicate-source check,
  --    balance check, insert — under the lock already held)
  v_id    := gen_random_uuid();
  v_label := to_char(p_attendance_date, 'DD Mon YYYY') || ' · '
          || case p_deduction_type when 'half_day' then 'Half Day' else 'Absent' end;

  v_tx := public.post_boe_credit_transaction(
    p_employee_id,
    'redemption',
    -v_cost,
    'attendance_redemption',
    v_id,
    'Attendance redemption · ' || v_label,
    p_actor_id,
    p_payroll_period_id
  );

  -- 9. the record, in the same transaction
  insert into public.boe_credit_attendance_redemptions (
    id, employee_id, attendance_date, deduction_type, credits,
    transaction_id, payroll_period_id, created_by
  ) values (
    v_id, p_employee_id, p_attendance_date, p_deduction_type, v_cost,
    v_tx, p_payroll_period_id, p_actor_id
  );

  select coalesce(sum(credits), 0) into v_balance
    from public.boe_credit_transactions where employee_id = p_employee_id;

  return jsonb_build_object(
    'redemption_id',     v_id,
    'transaction_id',    v_tx,
    'deduction_type',    p_deduction_type,
    'attendance_date',   p_attendance_date,
    'credits',           v_cost,
    'available_credits', v_balance
  );
end;
$$;

revoke execute on function public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)
  from public, anon, authenticated;
grant  execute on function public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)
  to service_role;

comment on function public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid) is
  'SERVICE ROLE ONLY. Covers one attendance day with BOE Credits: 1 for a half day, 2 for an absent day. Actor is the employee (or an active admin re-pricing after a correction); period unlocked with a generated result; date inside the month and not in the future; at most one ACTIVE coverage per day. Posts the ledger row (redemption / attendance_redemption) and the record together, under the per-employee lock.';

-- ═══ 4. The reversal ═══════════════════════════════════════════════════════
--
-- SERVICE ROLE ONLY. Withdraws one ACTIVE coverage: posts the compensating
-- ledger row through reverse_boe_credit_transaction() — which requires an
-- active admin actor and a reason, as the foundation demands of every
-- reversal — and the ledger trigger closes the record. Used by the
-- correction and regeneration paths when a redeemed day is no longer a
-- chargeable deduction. Refused on a locked month, and refused twice.
-- Returns jsonb: { redemption_id, reversal_transaction_id, credits, available_credits }

create or replace function public.reverse_boe_credit_attendance_redemption(
  p_redemption_id uuid,
  p_actor_id      uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_r       public.boe_credit_attendance_redemptions%rowtype;
  v_status  text;
  v_rev     uuid;
  v_closed  uuid;
  v_balance integer;
begin
  select * into v_r from public.boe_credit_attendance_redemptions where id = p_redemption_id;
  if not found then
    raise exception 'BOE_CREDITS_REDEMPTION: the redemption does not exist'
      using errcode = 'P0002';
  end if;

  -- The same per-employee lock, in the same order as the redemption.
  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(v_r.employee_id::text));

  select * into v_r from public.boe_credit_attendance_redemptions where id = p_redemption_id for update;
  if v_r.reversal_transaction_id is not null then
    raise exception 'BOE_CREDITS_ALREADY_REVERSED: this redemption has already been reversed'
      using errcode = '55000';
  end if;

  select status into v_status from public.payroll_periods where id = v_r.payroll_period_id for share;
  if v_status = 'locked' then
    raise exception 'BOE_CREDITS_PERIOD_LOCKED: payroll for this month is locked, so its credit coverage cannot change'
      using errcode = '55000';
  end if;

  v_rev := public.reverse_boe_credit_transaction(v_r.transaction_id, p_actor_id, p_reason);

  -- The ledger trigger closed the record; hold this function to that.
  select reversal_transaction_id into v_closed
    from public.boe_credit_attendance_redemptions where id = p_redemption_id;
  if v_closed is distinct from v_rev then
    raise exception 'BOE_CREDITS_REDEMPTION: the reversal was posted but the record was not closed'
      using errcode = 'XX000';
  end if;

  select coalesce(sum(credits), 0) into v_balance
    from public.boe_credit_transactions where employee_id = v_r.employee_id;

  return jsonb_build_object(
    'redemption_id',           p_redemption_id,
    'reversal_transaction_id', v_rev,
    'credits',                 v_r.credits,
    'available_credits',       v_balance
  );
end;
$$;

revoke execute on function public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)
  from public, anon, authenticated;
grant  execute on function public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)
  to service_role;

comment on function public.reverse_boe_credit_attendance_redemption(uuid, uuid, text) is
  'SERVICE ROLE ONLY. Withdraws one active attendance redemption: posts its reversal through reverse_boe_credit_transaction() (active admin actor, reason required) and the ledger trigger closes the record. Refused when already reversed or when the payroll month is locked.';

-- ═══ 5. Assertions ═════════════════════════════════════════════════════════

do $$
declare
  v_n integer;
begin
  -- 5a. the table exists with row security on
  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'boe_credit_attendance_redemptions' and c.relrowsecurity;
  if v_n <> 1 then
    raise exception 'BOE_CREDITS_1C: boe_credit_attendance_redemptions missing or without row security';
  end if;

  -- 5b. at most one ACTIVE coverage per day, and one ledger row per record
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname  = 'boe_credit_attendance_redemptions_active_unique'
       and indexdef ilike '%unique%'
       and indexdef ilike '%where (reversal_transaction_id is null)%'
  ) then
    raise exception 'BOE_CREDITS_1C: the active-only unique index is missing or not partial';
  end if;
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.boe_credit_attendance_redemptions'::regclass
       and c.contype = 'u'
       and c.conkey = array[(select attnum from pg_attribute where attrelid = c.conrelid and attname = 'transaction_id')]
  ) then
    raise exception 'BOE_CREDITS_1C: transaction_id is not unique';
  end if;

  -- 5c. both triggers are armed
  select count(*) into v_n
    from pg_trigger
   where tgname in ('boe_credit_attendance_redemptions_guard', 'boe_credit_redemption_closed_by_reversal')
     and not tgisinternal;
  if v_n <> 2 then
    raise exception 'BOE_CREDITS_1C: expected 2 triggers, found %', v_n;
  end if;

  -- 5d. exactly one policy, and it is SELECT
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'boe_credit_attendance_redemptions';
  if v_n <> 1 then
    raise exception 'BOE_CREDITS_1C: expected exactly 1 policy on the redemptions table, found %', v_n;
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'boe_credit_attendance_redemptions' and cmd <> 'SELECT'
  ) then
    raise exception 'BOE_CREDITS_1C: a non-SELECT policy exists on the redemptions table';
  end if;

  -- 5e. no client role can write it, and anon cannot read it
  if has_table_privilege('authenticated', 'public.boe_credit_attendance_redemptions', 'INSERT')
     or has_table_privilege('authenticated', 'public.boe_credit_attendance_redemptions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.boe_credit_attendance_redemptions', 'DELETE')
     or has_table_privilege('anon', 'public.boe_credit_attendance_redemptions', 'SELECT') then
    raise exception 'BOE_CREDITS_1C: a client role holds a write (or anon a read) on the redemptions table';
  end if;

  -- 5f. both functions are service role only
  if has_function_privilege('authenticated', 'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1C: a client role can execute a redemption function';
  end if;
  if not has_function_privilege('service_role', 'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1C: service_role cannot execute a redemption function';
  end if;

  -- 5g. the foundation's vocabulary is untouched: still exactly the four kinds
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.boe_credit_transactions'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%review_reward%'
       and pg_get_constraintdef(oid) like '%''redemption''%'
       and pg_get_constraintdef(oid) not like '%credit_redeemed%'
  ) then
    raise exception 'BOE_CREDITS_1C: the ledger''s transaction_type CHECK is not the foundation''s';
  end if;

  -- 5h. NO BACKFILL. This file wrote nothing.
  select count(*) into v_n
    from public.boe_credit_attendance_redemptions
   where created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'BOE_CREDITS_1C: this migration created % redemption row(s); it must create none', v_n;
  end if;
  select count(*) into v_n
    from public.boe_credit_transactions
   where transaction_type in ('redemption', 'reversal') and created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'BOE_CREDITS_1C: this migration posted % ledger row(s); it must post none', v_n;
  end if;
end $$;

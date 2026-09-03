-- ═══════════════════════════════════════════════════════════════════════════
-- BOE Credits — Phase 1D: configurable settings, monthly review qualification
-- with provisional credits, configurable attendance prices, and a payroll
-- salary addition paid for with credits.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
-- --------------
--   boe_credit_settings                     three new columns: half_day_redemption_credits,
--                                           full_day_redemption_credits, minimum_monthly_reviews;
--                                           credit_value must now be positive; one new active row
--   boe_credit_transactions                 a FIFTH kind: review_month_lapse (negative, one per
--                                           employee-month, admin actor, no overdraft check)
--   boe_credit_review_months                one row per employee + review month: the minimum
--                                           that applied, the count, the status, the lapse row
--   boe_credit_review_rewards               one row per review_reward ledger row: which review,
--                                           which month it counts for, and why (submitted_at)
--   boe_credit_payroll_applications         one row per payroll credit application: credits,
--                                           the rate and the rupees SNAPSHOTTED; closed once
--   boe_credit_provisional_credits(uuid)    rewards that cannot be spent yet (open months)
--   boe_credit_spendable_balance(uuid)      SUM(ledger) − provisional
--   boe_credit_balances                     the view, now with provisional_credits and
--                                           spendable_credits beside the recorded total
--   post_boe_credit_transaction(...)        re-created: the fifth kind; a redemption is checked
--                                           against the SPENDABLE balance; an employee may reverse
--                                           their OWN payroll application
--   boe_credit_reversal_guard()             BEFORE INSERT on the ledger: a lapsed month's reward
--                                           and a locked month's redemption cannot be reversed
--   boe_credit_reversal_effects()           AFTER INSERT on the ledger: a reversed reward refreshes
--                                           its month; a reversed payroll application is closed
--   post_boe_credit_review_reward(...)      the reward, its month attribution and qualification,
--                                           in one call — called by the verify transition
--   refresh_boe_credit_review_month(...)    recount an employee-month and qualify it if it earned it
--   finalize_boe_credit_review_month(...)   admin, idempotent: qualified stays, below-minimum lapses
--   transition_customer_review_test_card()  re-created: the reward branch calls the function above
--   redeem_boe_credits_for_attendance(...)  re-created: the cost is read from the settings
--   apply_boe_credits_to_payroll(...)       the employee turns spendable credits into rupees
--   remove_boe_credit_payroll_application(...)  and withdraws that, while payroll is unlocked
--
-- THE BUSINESS RULES, STATED ONCE
-- -------------------------------
--   * Five global settings, admin-managed, newest row active:
--       review_reward_credits          1 credit per verified review
--       credit_value                   ₹100 per credit (payroll)
--       half_day_redemption_credits    8
--       full_day_redemption_credits    15  (independent of half day; never derived)
--       minimum_monthly_reviews        3
--     A change applies to FUTURE actions only. Every historical row keeps the
--     credits, the rate and the rupees written on it.
--   * A review's credit counts for the month of its SUCCESSFUL SUBMISSION
--     (submitted_at, Asia/Kolkata) — the month the work was handed over — not
--     the month it happened to be verified. Submitted 30 Sep, verified 2 Oct →
--     September. The reward is still posted only on verification.
--   * Until an employee's month reaches the minimum, that month's reward
--     credits are PROVISIONAL: recorded, visible, and NOT spendable. On the
--     review that reaches the minimum the month becomes `qualified` and all its
--     rewards become spendable; later rewards in a qualified month are
--     spendable immediately. Older credits are never affected.
--   * An administrator finalizes a month after it has ended. A qualified month
--     stays qualified. A month below the minimum LAPSES: one append-only
--     review_month_lapse row removes exactly that month's still-valid reward
--     credits — nothing older — and the month can never reopen. Finalizing
--     twice creates nothing.
--   * A reward can still be reversed individually (an invalid review). Before
--     finalization it no longer counts toward the month. After a qualified
--     month is finalized it does not reopen the month. A reward whose month has
--     LAPSED cannot be reversed — its credits are already gone.
--   * Attendance: Half Day costs half_day_redemption_credits, Absent costs
--     full_day_redemption_credits, read at the moment of redemption and written
--     on the record. A day bought at 1 credit stays 1 credit.
--   * Payroll: an employee converts spendable credits into a salary addition of
--     credits × credit_value, snapshotted on the application. Settlement adds
--     it to Salary Payable; the payroll engine, gross salary, attendance and
--     net_salary are untouched. At most one ACTIVE application per employee and
--     payroll period; changing it is a reversal plus a new redemption; a locked
--     period freezes it. Regeneration never re-prices it.
--
-- THE SOURCE OF TRUTH FOR "HOW MANY CAN I SPEND"
-- ----------------------------------------------
--   recorded balance  = SUM(credits) over the ledger                 (unchanged)
--   provisional       = SUM(credits) of review_reward rows whose month row is
--                       still 'open' and which have not been reversed
--   spendable balance = recorded − provisional
--
-- The ledger's arithmetic is untouched: a lapse is a negative row like any
-- other, and a qualification is a status change on the month row that stops
-- excluding the rewards — no ledger row is edited, deleted or re-typed.
-- post_boe_credit_transaction() checks a redemption against the SPENDABLE
-- balance under the per-employee advisory lock, so no path — attendance or
-- payroll, sequential or concurrent — can consume a provisional credit.
--
-- OLD ROWS. A review_reward posted before this file (none exist in production)
-- has no boe_credit_review_rewards row, belongs to no month, and is therefore
-- fully spendable and never lapses. Nothing is backfilled.
--
-- ASSUMPTIONS TO CHECK BEFORE THIS IS APPLIED
--   1. 20261101000000, 20261102000000 and 20261103000000 are applied.
--   2. public.customer_review_test_cards has submitted_at and card_ref
--      (20261017000000); public.resolve_permission exists (transition body).
--   3. public.payroll_periods(id, payroll_month, payroll_year, status) and
--      public.payroll_results(payroll_period_id, employee_id) exist.
--
-- PRODUCTION SAFETY. Additive: three new tables, three new columns with
-- defaults, one new settings row, one widened CHECK, re-created functions on
-- their existing signatures. No row is edited or deleted. Every statement is
-- guarded, so re-running is safe.
--
-- DEPLOYMENT ORDER. Apply BEFORE the Phase 1D application code: the code reads
-- the new settings columns and the new view columns. The Phase 1C code keeps
-- running against this schema (the functions it calls keep their signatures
-- and their markers; the cost simply comes from the settings).
--
-- ROLLBACK (lossless only if no Phase 1D row was written)
--   drop function if exists public.remove_boe_credit_payroll_application(uuid, uuid, uuid);
--   drop function if exists public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid);
--   drop function if exists public.finalize_boe_credit_review_month(uuid, date, uuid);
--   drop function if exists public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid);
--   drop function if exists public.refresh_boe_credit_review_month(uuid, date);
--   drop trigger  if exists boe_credit_reversal_effects on public.boe_credit_transactions;
--   drop trigger  if exists boe_credit_reversal_guard   on public.boe_credit_transactions;
--   drop function if exists public.boe_credit_reversal_effects();
--   drop function if exists public.boe_credit_reversal_guard();
--   re-apply 20261102000000 § transition, 20261103000000 § redeem, 20261101000000 § post;
--   drop view public.boe_credit_balances and re-apply 20261101000000 § 4;
--   drop table public.boe_credit_payroll_applications, boe_credit_review_rewards, boe_credit_review_months;
--   restore the two ledger CHECKs from 20261101000000.

-- ═══ 1. Settings ═══════════════════════════════════════════════════════════
--
-- Three new numbers with the Phase 1D defaults, so the Phase 1A row (kept, as
-- history) reads sensibly, and a fresh active row carrying the approved
-- production values. The append-only trigger is untouched: ADD COLUMN is DDL,
-- and the new row is an INSERT.

alter table public.boe_credit_settings
  add column if not exists half_day_redemption_credits integer not null default 8
    check (half_day_redemption_credits > 0 and half_day_redemption_credits <= 100000),
  add column if not exists full_day_redemption_credits integer not null default 15
    check (full_day_redemption_credits > 0 and full_day_redemption_credits <= 100000),
  add column if not exists minimum_monthly_reviews integer not null default 3
    check (minimum_monthly_reviews > 0 and minimum_monthly_reviews <= 1000);

-- A credit must be worth something for a payroll application to mean anything.
-- The Phase 1A row holds 1.00, so the constraint validates against history.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.boe_credit_settings'::regclass
       and conname  = 'boe_credit_settings_credit_value_positive'
  ) then
    alter table public.boe_credit_settings
      add constraint boe_credit_settings_credit_value_positive check (credit_value > 0);
  end if;
end $$;

comment on table public.boe_credit_settings is
  'BOE Credits settings. Append-only: the newest row is active and every earlier row is the history. review_reward_credits = credits per verified review; credit_value = rupees per credit for a payroll application; half_day_redemption_credits / full_day_redemption_credits = what an attendance day costs; minimum_monthly_reviews = verified reviews a month needs before its rewards become spendable. Every change applies to future actions only. Never UPDATE or DELETE — save a new row.';

comment on column public.boe_credit_settings.credit_value is
  'Rupees per credit for a PAYROLL application (Phase 1D). Snapshotted on boe_credit_payroll_applications.credit_value_snapshot at the moment of application; a later change never re-prices an existing application. Attendance redemption does not read it.';

comment on column public.boe_credit_settings.half_day_redemption_credits is
  'Credits an employee spends to cover a chargeable Half Day. Read at redemption time and written on the record; independent of full_day_redemption_credits.';

comment on column public.boe_credit_settings.full_day_redemption_credits is
  'Credits an employee spends to cover a chargeable Absent (full) day. Read at redemption time and written on the record; independent of half_day_redemption_credits.';

comment on column public.boe_credit_settings.minimum_monthly_reviews is
  'Verified reviews an employee needs in one review month before that month''s reward credits become spendable. Snapshotted on boe_credit_review_months when the month row is created.';

-- The Phase 1D active values, once: 1 credit per review, ₹100 per credit,
-- 8 / 15 for attendance, 3 reviews a month. Skipped when the newest row already
-- says exactly that, so re-running adds nothing.
do $$
declare
  v_newest public.boe_credit_settings%rowtype;
begin
  select * into v_newest from public.boe_credit_settings order by created_at desc limit 1;
  if not found
     or v_newest.review_reward_credits       is distinct from 1
     or v_newest.credit_value                is distinct from 100.00
     or v_newest.half_day_redemption_credits is distinct from 8
     or v_newest.full_day_redemption_credits is distinct from 15
     or v_newest.minimum_monthly_reviews     is distinct from 3 then
    insert into public.boe_credit_settings (
      review_reward_credits, credit_value,
      half_day_redemption_credits, full_day_redemption_credits, minimum_monthly_reviews,
      created_by, note
    ) values (1, 100.00, 8, 15, 3, null, 'BOE Credits Phase 1D defaults');
  end if;
end $$;

-- ═══ 2. The fifth ledger kind ══════════════════════════════════════════════
--
-- review_month_lapse: negative, one per employee-month (source_type
-- 'boe_credit_review_month', source_id = the month row, so the foundation's
-- one-row-per-source index is what makes a second lapse impossible), posted
-- by an administrator's finalization and never checked against the balance —
-- the credits it removes are the provisional ones, which were never spendable.

do $$
declare
  v_name text;
begin
  -- the kind list (an inline column CHECK, whose name Postgres chose)
  select conname into v_name
    from pg_constraint
   where conrelid = 'public.boe_credit_transactions'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) like '%transaction_type%'
     and pg_get_constraintdef(oid) like '%''review_reward''%'
     and pg_get_constraintdef(oid) not like '%credits%';
  if v_name is not null and pg_get_constraintdef(
       (select oid from pg_constraint where conrelid = 'public.boe_credit_transactions'::regclass and conname = v_name)
     ) not like '%review_month_lapse%' then
    execute format('alter table public.boe_credit_transactions drop constraint %I', v_name);
    alter table public.boe_credit_transactions
      add constraint boe_credit_transactions_transaction_type_check check (transaction_type in (
        'review_reward',
        'redemption',
        'reversal',
        'admin_adjustment',
        'review_month_lapse'
      ));
  end if;

  -- the shape rule, restated with the fifth kind
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.boe_credit_transactions'::regclass
       and conname = 'boe_credit_transactions_shape_check'
       and pg_get_constraintdef(oid) not like '%review_month_lapse%'
  ) then
    alter table public.boe_credit_transactions drop constraint boe_credit_transactions_shape_check;
    alter table public.boe_credit_transactions
      add constraint boe_credit_transactions_shape_check check (
        case transaction_type
          when 'review_reward'      then credits > 0 and source_type <> 'manual'
          when 'redemption'         then credits < 0 and source_type <> 'manual'
          when 'reversal'           then source_type = 'boe_credit_transaction'
          when 'admin_adjustment'   then source_type = 'manual' and description is not null
          when 'review_month_lapse' then credits < 0 and source_type = 'boe_credit_review_month'
        end
      );
  end if;
end $$;

comment on column public.boe_credit_transactions.source_type is
  'What produced this row: customer_review (a verified review), attendance_redemption (source_id = boe_credit_attendance_redemptions.id), payroll_redemption (source_id = boe_credit_payroll_applications.id), boe_credit_review_month (a review_month_lapse; source_id = boe_credit_review_months.id), boe_credit_transaction (for a reversal) or manual (an admin adjustment, which has no source_id).';

-- ═══ 3. Review months and the rewards that belong to them ══════════════════

create table if not exists public.boe_credit_review_months (
  id                        uuid        primary key default gen_random_uuid(),
  employee_id               uuid        not null references public.users(id),
  -- The first day of the review month (Asia/Kolkata).
  review_month              date        not null check (review_month = date_trunc('month', review_month)::date),
  -- The minimum that applied when this month first earned a reward. A later
  -- settings change does not rewrite it.
  minimum_reviews_snapshot  integer     not null check (minimum_reviews_snapshot > 0),
  -- Verified reviews still counting (rewarded and not reversed).
  qualifying_review_count   integer     not null default 0 check (qualifying_review_count >= 0),
  -- Reward credits still counting (rewarded and not reversed).
  earned_review_credits     integer     not null default 0 check (earned_review_credits >= 0),
  status                    text        not null default 'open' check (status in ('open', 'qualified', 'lapsed')),
  qualified_at              timestamptz,
  finalized_at              timestamptz,
  finalized_by              uuid        references public.users(id),
  lapse_transaction_id      uuid        unique references public.boe_credit_transactions(id),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint boe_credit_review_months_employee_month_unique unique (employee_id, review_month),
  constraint boe_credit_review_months_qualified_consistent check (
    (status = 'qualified') = (qualified_at is not null)
  ),
  constraint boe_credit_review_months_lapse_consistent check (
    lapse_transaction_id is null or status = 'lapsed'
  ),
  constraint boe_credit_review_months_finalized_consistent check (
    (status <> 'lapsed') or finalized_at is not null
  )
);

comment on table public.boe_credit_review_months is
  'BOE Credits Phase 1D: one row per employee and review month (the month of successful submission, Asia/Kolkata). Holds the monthly minimum that applied, the count of still-valid verified reviews, and the status: open (rewards provisional), qualified (rewards spendable), lapsed (finalized below the minimum; one review_month_lapse ledger row removed the month''s still-valid reward credits). Written only by the Phase 1D functions.';

create index if not exists boe_credit_review_months_month_status_idx
  on public.boe_credit_review_months (review_month, status);

create table if not exists public.boe_credit_review_rewards (
  -- One row per review_reward ledger row.
  transaction_id   uuid        primary key references public.boe_credit_transactions(id),
  employee_id      uuid        not null references public.users(id),
  -- The review, by id and by its human reference. A type/id pair rather than a
  -- foreign key, as the ledger does: the credit is not coupled to the review
  -- table's lifecycle.
  card_id          uuid        not null,
  card_ref         text        not null,
  -- The successful submission this reward is attributed to, and the month it
  -- resolves to. Both are SNAPSHOTS: the attribution is decided once, here.
  submitted_at     timestamptz not null,
  review_month     date        not null check (review_month = date_trunc('month', review_month)::date),
  review_month_id  uuid        not null references public.boe_credit_review_months(id),
  created_at       timestamptz not null default now(),

  constraint boe_credit_review_rewards_one_per_card unique (employee_id, card_id)
);

comment on table public.boe_credit_review_rewards is
  'BOE Credits Phase 1D: which review each review_reward ledger row was for, and which review month it counts toward (the Asia/Kolkata month of submitted_at at verification). Append-only; written only by post_boe_credit_review_reward().';

create index if not exists boe_credit_review_rewards_month_idx
  on public.boe_credit_review_rewards (review_month_id);

-- Append-only, both. The month row is the ONE exception: its status and
-- counters move, through the Phase 1D functions only (no client role can write
-- it, and the functions are service-role or definer-internal).
drop trigger if exists boe_credit_review_rewards_append_only on public.boe_credit_review_rewards;
create trigger boe_credit_review_rewards_append_only
  before update or delete on public.boe_credit_review_rewards
  for each row execute function public.boe_credits_append_only();

create or replace function public.boe_credit_review_months_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BOE_CREDITS_APPEND_ONLY: boe_credit_review_months is never deleted'
      using errcode = '42501';
  end if;
  -- Identity never moves; a finalized month never changes status again.
  if new.employee_id <> old.employee_id or new.review_month <> old.review_month
     or new.minimum_reviews_snapshot <> old.minimum_reviews_snapshot then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a review month keeps its employee, month and minimum'
      using errcode = '42501';
  end if;
  if old.status = 'lapsed' and (new.status <> 'lapsed' or new.lapse_transaction_id is distinct from old.lapse_transaction_id) then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a lapsed review month is final'
      using errcode = '42501';
  end if;
  if old.status = 'qualified' and new.status <> 'qualified' then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a qualified review month stays qualified'
      using errcode = '42501';
  end if;
  if old.finalized_at is not null and new.finalized_at is distinct from old.finalized_at then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a finalized review month is not re-finalized'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.boe_credit_review_months_guard() from public, anon, authenticated;

drop trigger if exists boe_credit_review_months_guard on public.boe_credit_review_months;
create trigger boe_credit_review_months_guard
  before update or delete on public.boe_credit_review_months
  for each row execute function public.boe_credit_review_months_guard();

-- Authorization: own rows or management; no client writes; anon blind.
alter table public.boe_credit_review_months enable row level security;
alter table public.boe_credit_review_rewards enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.boe_credit_review_months from authenticated, anon;
revoke select on public.boe_credit_review_months from anon;
grant  select on public.boe_credit_review_months to authenticated;

revoke insert, update, delete, truncate, references, trigger
  on public.boe_credit_review_rewards from authenticated, anon;
revoke select on public.boe_credit_review_rewards from anon;
grant  select on public.boe_credit_review_rewards to authenticated;

drop policy if exists "boe_credit_review_months_read_own_or_manage" on public.boe_credit_review_months;
create policy "boe_credit_review_months_read_own_or_manage"
  on public.boe_credit_review_months
  for select
  to authenticated
  using (employee_id = auth.uid() or public.can_manage_boe_credits());

drop policy if exists "boe_credit_review_rewards_read_own_or_manage" on public.boe_credit_review_rewards;
create policy "boe_credit_review_rewards_read_own_or_manage"
  on public.boe_credit_review_rewards
  for select
  to authenticated
  using (employee_id = auth.uid() or public.can_manage_boe_credits());

-- ═══ 4. Payroll credit applications ════════════════════════════════════════
--
-- The same shape as the Phase 1C attendance record: written with its ledger
-- row in one transaction, closed exactly once by the reversal of that ledger
-- row (a ledger trigger, §7), never edited otherwise. Coverage is ACTIVE while
-- reversal_transaction_id is null, and the partial unique index is what makes
-- two active applications for one employee-period impossible.

create table if not exists public.boe_credit_payroll_applications (
  id                        uuid          primary key default gen_random_uuid(),
  employee_id               uuid          not null references public.users(id),
  payroll_period_id         uuid          not null references public.payroll_periods(id),
  credits_used              integer       not null check (credits_used > 0),
  -- THE SNAPSHOTS. What the payroll month used, forever.
  credit_value_snapshot     numeric(12,2) not null check (credit_value_snapshot > 0),
  credit_amount_snapshot    numeric(12,2) not null check (credit_amount_snapshot > 0),
  -- The ledger row that paid for it: 'redemption' / 'payroll_redemption' / this id.
  redemption_transaction_id uuid          not null unique references public.boe_credit_transactions(id),
  created_by                uuid          references public.users(id),
  created_at                timestamptz   not null default now(),
  -- Set exactly once, by the ledger trigger, when the ledger row is reversed.
  reversal_transaction_id   uuid          unique references public.boe_credit_transactions(id),
  reversed_at               timestamptz,

  constraint boe_credit_payroll_applications_amount_check check (
    credit_amount_snapshot = round(credits_used * credit_value_snapshot, 2)
  ),
  constraint boe_credit_payroll_applications_reversal_consistent check (
    (reversal_transaction_id is null) = (reversed_at is null)
  )
);

comment on table public.boe_credit_payroll_applications is
  'BOE Credits Phase 1D: one row per payroll credit application — credits × the credit_value at that moment = the rupee addition Settlement adds to Salary Payable. All three are snapshots. Written by apply_boe_credits_to_payroll() with its ledger row; closed once (reversal_transaction_id, reversed_at) when that ledger row is reversed; never edited otherwise. ACTIVE while reversal_transaction_id is null.';

create unique index if not exists boe_credit_payroll_applications_active_unique
  on public.boe_credit_payroll_applications (employee_id, payroll_period_id)
  where reversal_transaction_id is null;

create index if not exists boe_credit_payroll_applications_period_idx
  on public.boe_credit_payroll_applications (payroll_period_id, employee_id);

create or replace function public.boe_credit_payroll_applications_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BOE_CREDITS_APPEND_ONLY: boe_credit_payroll_applications is never deleted — reverse the application instead'
      using errcode = '42501';
  end if;
  if old.reversal_transaction_id is not null then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a reversed payroll application is closed and cannot change'
      using errcode = '42501';
  end if;
  if new.reversal_transaction_id is null or new.reversed_at is null then
    raise exception 'BOE_CREDITS_APPEND_ONLY: the only permitted change to a payroll application is closing it with its reversal'
      using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'reversal_transaction_id' - 'reversed_at')
     <> (to_jsonb(old) - 'reversal_transaction_id' - 'reversed_at') then
    raise exception 'BOE_CREDITS_APPEND_ONLY: closing a payroll application may not alter anything else on it'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.boe_credit_transactions t
     where t.id = new.reversal_transaction_id
       and t.transaction_type = 'reversal'
       and t.source_type = 'boe_credit_transaction'
       and t.source_id = old.redemption_transaction_id
  ) then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a payroll application is closed only by the reversal of its own ledger row'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.boe_credit_payroll_applications_guard() from public, anon, authenticated;

drop trigger if exists boe_credit_payroll_applications_guard on public.boe_credit_payroll_applications;
create trigger boe_credit_payroll_applications_guard
  before update or delete on public.boe_credit_payroll_applications
  for each row execute function public.boe_credit_payroll_applications_guard();

alter table public.boe_credit_payroll_applications enable row level security;

revoke insert, update, delete, truncate, references, trigger
  on public.boe_credit_payroll_applications from authenticated, anon;
revoke select on public.boe_credit_payroll_applications from anon;
grant  select on public.boe_credit_payroll_applications to authenticated;

drop policy if exists "boe_credit_payroll_applications_read_own_or_manage" on public.boe_credit_payroll_applications;
create policy "boe_credit_payroll_applications_read_own_or_manage"
  on public.boe_credit_payroll_applications
  for select
  to authenticated
  using (employee_id = auth.uid() or public.can_manage_boe_credits());

-- ═══ 5. The balances: recorded, provisional, spendable ═════════════════════
--
-- SECURITY INVOKER, like boe_credit_balance(): an employee's own read goes
-- through the own-rows policies on all three tables; a definer function that
-- calls these runs them as the owner.

create or replace function public.boe_credit_provisional_credits(p_employee_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(t.credits), 0)::integer
    from public.boe_credit_transactions t
    join public.boe_credit_review_rewards r on r.transaction_id = t.id
    join public.boe_credit_review_months  m on m.id = r.review_month_id
   where t.employee_id = p_employee_id
     and t.transaction_type = 'review_reward'
     and m.status = 'open'
     and not exists (
       select 1 from public.boe_credit_transactions rv
        where rv.transaction_type = 'reversal'
          and rv.source_type = 'boe_credit_transaction'
          and rv.source_id = t.id
     );
$$;

revoke execute on function public.boe_credit_provisional_credits(uuid) from public, anon;
grant  execute on function public.boe_credit_provisional_credits(uuid) to authenticated;

comment on function public.boe_credit_provisional_credits(uuid) is
  'Review-reward credits an employee holds that cannot be spent yet: rewards attributed to a review month still open (below the monthly minimum), not reversed. Read under the caller''s own RLS.';

create or replace function public.boe_credit_spendable_balance(p_employee_id uuid)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select public.boe_credit_balance(p_employee_id) - public.boe_credit_provisional_credits(p_employee_id);
$$;

revoke execute on function public.boe_credit_spendable_balance(uuid) from public, anon;
grant  execute on function public.boe_credit_spendable_balance(uuid) to authenticated;

comment on function public.boe_credit_spendable_balance(uuid) is
  'THE balance a redemption is checked against: SUM(ledger) minus provisional review rewards. Read under the caller''s own RLS.';

drop view if exists public.boe_credit_balances;
create view public.boe_credit_balances
with (security_invoker = true) as
select
  employee_id,
  -- The recorded total, unchanged in meaning: SUM(credits).
  coalesce(sum(credits), 0)::integer                                                       as available_credits,
  count(*)::integer                                                                        as transaction_count,
  max(created_at)                                                                          as last_transaction_at,
  public.boe_credit_provisional_credits(employee_id)                                       as provisional_credits,
  (coalesce(sum(credits), 0) - public.boe_credit_provisional_credits(employee_id))::integer as spendable_credits
from public.boe_credit_transactions
group by employee_id;

revoke all on public.boe_credit_balances from anon;
grant  select on public.boe_credit_balances to authenticated;

comment on view public.boe_credit_balances is
  'BOE Credits per employee, derived on every read: available_credits = SUM(credits) (the recorded total), provisional_credits = rewards of still-open review months, spendable_credits = the difference — the only figure a redemption may consume. Employees with no ledger rows are absent and have zero of each.';

-- ═══ 6. The one write path, re-created ═════════════════════════════════════
--
-- Same signature, same grants, same markers. Three changes, each stated:
--   1. the fifth kind, review_month_lapse: negative, sourced from a month row,
--      posted by an active admin, never checked against the balance;
--   2. a REDEMPTION is checked against the SPENDABLE balance (recorded minus
--      provisional), so a provisional credit cannot be spent by any path;
--   3. a REVERSAL may be posted by an active admin (as before) OR by the
--      employee themselves when the row reversed is their own payroll
--      application (source_type 'payroll_redemption') — changing or removing
--      one is the employee's action. No other reversal is opened to a
--      non-admin.

create or replace function public.post_boe_credit_transaction(
  p_employee_id       uuid,
  p_transaction_type  text,
  p_credits           integer,
  p_source_type       text,
  p_source_id         uuid,
  p_description       text,
  p_actor_id          uuid,
  p_payroll_period_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id          uuid;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_balance     integer;
  v_original    public.boe_credit_transactions%rowtype;
  v_actor_admin boolean := false;
begin
  -- 1. the employee
  if p_employee_id is null or not exists (
    select 1 from public.users
     where id = p_employee_id and coalesce(is_deleted, false) = false
  ) then
    raise exception 'BOE_CREDITS_EMPLOYEE: the employee does not exist or has been deleted'
      using errcode = 'P0002';
  end if;

  -- 2. the actor
  if p_actor_id is not null and not exists (select 1 from public.users where id = p_actor_id) then
    raise exception 'BOE_CREDITS_ACTOR: the acting user does not exist'
      using errcode = 'P0002';
  end if;
  if p_actor_id is not null then
    select true into v_actor_admin
      from public.users
     where id = p_actor_id
       and role = 'admin'
       and is_active = true
       and coalesce(is_deleted, false) = false;
    v_actor_admin := coalesce(v_actor_admin, false);
  end if;

  -- 3. type and amount
  if p_transaction_type is null
     or p_transaction_type not in ('review_reward', 'redemption', 'reversal', 'admin_adjustment', 'review_month_lapse') then
    raise exception 'BOE_CREDITS_TYPE: unknown transaction type %', coalesce(p_transaction_type, '<null>')
      using errcode = '22023';
  end if;

  if p_credits is null or p_credits = 0 then
    raise exception 'BOE_CREDITS_ZERO: a credit transaction must move at least one credit'
      using errcode = '22023';
  end if;

  -- 4. the shape, said in words the route can show
  if p_transaction_type = 'admin_adjustment' then
    if v_description is null then
      raise exception 'BOE_CREDITS_REASON: an admin adjustment needs a reason'
        using errcode = '22023';
    end if;
    if p_source_type is distinct from 'manual' or p_source_id is not null then
      raise exception 'BOE_CREDITS_SOURCE: an admin adjustment is a manual entry and carries no source id'
        using errcode = '22023';
    end if;
  else
    if p_source_type is null or p_source_type = 'manual' or p_source_id is null then
      raise exception 'BOE_CREDITS_SOURCE: a % must name the source it came from', p_transaction_type
        using errcode = '22023';
    end if;
  end if;

  if p_transaction_type = 'review_reward' and p_credits < 0 then
    raise exception 'BOE_CREDITS_SIGN: a review reward earns credits — the amount must be positive'
      using errcode = '22023';
  end if;

  if p_transaction_type = 'redemption' and p_credits > 0 then
    raise exception 'BOE_CREDITS_SIGN: a redemption spends credits — the amount must be negative'
      using errcode = '22023';
  end if;

  if p_transaction_type = 'review_month_lapse' then
    if p_credits > 0 then
      raise exception 'BOE_CREDITS_SIGN: a review month lapse removes credits — the amount must be negative'
        using errcode = '22023';
    end if;
    if p_source_type <> 'boe_credit_review_month' or not exists (
      select 1 from public.boe_credit_review_months m
       where m.id = p_source_id and m.employee_id = p_employee_id
    ) then
      raise exception 'BOE_CREDITS_SOURCE: a review month lapse must name the employee''s review month'
        using errcode = '22023';
    end if;
  end if;

  if p_transaction_type = 'reversal' then
    if p_source_type <> 'boe_credit_transaction' then
      raise exception 'BOE_CREDITS_SOURCE: a reversal must name the transaction it reverses'
        using errcode = '22023';
    end if;
    select * into v_original from public.boe_credit_transactions where id = p_source_id;
    if not found then
      raise exception 'BOE_CREDITS_REVERSAL: the transaction to reverse does not exist'
        using errcode = 'P0002';
    end if;
    if v_original.employee_id <> p_employee_id then
      raise exception 'BOE_CREDITS_REVERSAL: the transaction belongs to a different employee'
        using errcode = '22023';
    end if;
    if v_original.transaction_type = 'reversal' then
      raise exception 'BOE_CREDITS_REVERSAL: a reversal cannot itself be reversed — post an admin adjustment'
        using errcode = '55000';
    end if;
    if p_credits <> -v_original.credits then
      raise exception 'BOE_CREDITS_REVERSAL: a reversal must negate the original amount exactly'
        using errcode = '22023';
    end if;
  end if;

  -- 2b. who may post the hand-posted kinds
  if p_transaction_type in ('admin_adjustment', 'review_month_lapse') and not v_actor_admin then
    raise exception 'BOE_CREDITS_DENIED: only an administrator can post a %', p_transaction_type
      using errcode = '42501';
  end if;
  if p_transaction_type = 'reversal' and not v_actor_admin then
    -- The one non-admin reversal: an employee withdrawing their OWN payroll
    -- credit application. Everything else still needs an administrator.
    if p_actor_id is null
       or v_original.source_type <> 'payroll_redemption'
       or v_original.employee_id <> p_actor_id then
      raise exception 'BOE_CREDITS_DENIED: only an administrator can post a reversal'
        using errcode = '42501';
    end if;
  end if;

  -- 5. serialise per employee. Two posts for the same person now happen one
  --    after the other, so the duplicate check and the balance check below
  --    cannot race each other. The lock is released with the transaction.
  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  if p_source_id is not null and exists (
    select 1 from public.boe_credit_transactions
     where employee_id      = p_employee_id
       and transaction_type = p_transaction_type
       and source_type      = p_source_type
       and source_id        = p_source_id
  ) then
    raise exception 'BOE_CREDITS_DUPLICATE_SOURCE: this % has already been recorded for this source', p_transaction_type
      using errcode = '23505';
  end if;

  -- THE SPENDABLE BALANCE, not the recorded one: a provisional reward is
  -- excluded here, whichever path is spending.
  if p_transaction_type = 'redemption' then
    v_balance := public.boe_credit_spendable_balance(p_employee_id);
    if v_balance + p_credits < 0 then
      raise exception 'BOE_CREDITS_INSUFFICIENT: only % credits are available to spend', greatest(v_balance, 0)
        using errcode = '23514';
    end if;
  end if;

  -- 6. the row
  insert into public.boe_credit_transactions (
    employee_id, transaction_type, credits, source_type, source_id,
    payroll_period_id, description, created_by
  ) values (
    p_employee_id, p_transaction_type, p_credits, p_source_type, p_source_id,
    p_payroll_period_id, v_description, p_actor_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)
  to service_role;

comment on function public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid) is
  'SERVICE ROLE ONLY. The one way a BOE Credits ledger row is written. Validates employee, actor (an active admin for adjustments, lapses and reversals — except an employee reversing their own payroll application), non-zero amount, type, shape and the one-row-per-source rule under a per-employee lock. A redemption is checked against the SPENDABLE balance (recorded minus provisional). Not callable by anon or authenticated.';

-- ═══ 7. Reversals: what they may not touch, and what they close ════════════

-- BEFORE INSERT: two reversals that must never happen.
create or replace function public.boe_credit_reversal_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original public.boe_credit_transactions%rowtype;
  v_status   text;
begin
  if new.transaction_type <> 'reversal' or new.source_type <> 'boe_credit_transaction' then
    return new;
  end if;
  select * into v_original from public.boe_credit_transactions where id = new.source_id;
  if not found then
    return new;   -- post_boe_credit_transaction has already refused this
  end if;

  -- A reward whose month has lapsed: its credits are already gone with the
  -- lapse row. Reversing it as well would take the same credit twice.
  if v_original.transaction_type = 'review_reward' and exists (
    select 1 from public.boe_credit_review_rewards r
      join public.boe_credit_review_months m on m.id = r.review_month_id
     where r.transaction_id = v_original.id and m.status = 'lapsed'
  ) then
    raise exception 'BOE_CREDITS_MONTH_LAPSED: this reward''s review month has lapsed, so its credit was already removed — it cannot be reversed again'
      using errcode = '55000';
  end if;

  -- A lapse is the month's final word. Reversing it would hand the credits
  -- back while the month stays lapsed; the correction for a wrong close is an
  -- admin adjustment, which records why.
  if v_original.transaction_type = 'review_month_lapse' then
    raise exception 'BOE_CREDITS_REVERSAL: a review month lapse is final — post an admin adjustment instead'
      using errcode = '55000';
  end if;

  -- A redemption inside a LOCKED payroll month is frozen with the month.
  if v_original.transaction_type = 'redemption'
     and v_original.source_type in ('attendance_redemption', 'payroll_redemption')
     and v_original.payroll_period_id is not null then
    select status into v_status from public.payroll_periods where id = v_original.payroll_period_id;
    if v_status = 'locked' then
      raise exception 'BOE_CREDITS_PERIOD_LOCKED: payroll for this month is locked, so its credit use cannot change'
        using errcode = '55000';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.boe_credit_reversal_guard() from public, anon, authenticated;

drop trigger if exists boe_credit_reversal_guard on public.boe_credit_transactions;
create trigger boe_credit_reversal_guard
  before insert on public.boe_credit_transactions
  for each row
  when (new.transaction_type = 'reversal')
  execute function public.boe_credit_reversal_guard();

-- ─── 7a. Recount a review month, and qualify it if it has earned it ────────
--
-- Internal: called under the employee's advisory lock by the reward posting
-- function, the reversal trigger and finalization. Only open → qualified
-- happens here; nothing here lapses, reopens or finalizes.

create or replace function public.refresh_boe_credit_review_month(
  p_employee_id  uuid,
  p_review_month date
)
returns public.boe_credit_review_months
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_month   public.boe_credit_review_months%rowtype;
  v_count   integer;
  v_credits integer;
begin
  select * into v_month
    from public.boe_credit_review_months
   where employee_id = p_employee_id and review_month = p_review_month
     for update;
  if not found then
    return null;
  end if;

  select count(*)::integer, coalesce(sum(t.credits), 0)::integer
    into v_count, v_credits
    from public.boe_credit_review_rewards r
    join public.boe_credit_transactions t on t.id = r.transaction_id
   where r.review_month_id = v_month.id
     and not exists (
       select 1 from public.boe_credit_transactions rv
        where rv.transaction_type = 'reversal'
          and rv.source_type = 'boe_credit_transaction'
          and rv.source_id = t.id
     );

  update public.boe_credit_review_months
     set qualifying_review_count = v_count,
         earned_review_credits   = v_credits,
         status       = case when status = 'open' and v_count >= minimum_reviews_snapshot then 'qualified' else status end,
         qualified_at = case when status = 'open' and v_count >= minimum_reviews_snapshot then now() else qualified_at end
   where id = v_month.id
   returning * into v_month;

  return v_month;
end;
$$;

revoke execute on function public.refresh_boe_credit_review_month(uuid, date) from public, anon, authenticated;
grant  execute on function public.refresh_boe_credit_review_month(uuid, date) to service_role;

-- AFTER INSERT: a reversal's consequences on the Phase 1D records.
create or replace function public.boe_credit_reversal_effects()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original public.boe_credit_transactions%rowtype;
  v_reward   public.boe_credit_review_rewards%rowtype;
begin
  if new.transaction_type <> 'reversal' or new.source_type <> 'boe_credit_transaction' then
    return null;
  end if;
  select * into v_original from public.boe_credit_transactions where id = new.source_id;
  if not found then
    return null;
  end if;

  -- A reversed reward stops counting toward its month (before qualification);
  -- a qualified or lapsed month is not reopened.
  if v_original.transaction_type = 'review_reward' then
    select * into v_reward from public.boe_credit_review_rewards where transaction_id = v_original.id;
    if found then
      perform public.refresh_boe_credit_review_month(v_reward.employee_id, v_reward.review_month);
    end if;
  end if;

  -- A reversed payroll redemption closes its application.
  if v_original.transaction_type = 'redemption' and v_original.source_type = 'payroll_redemption' then
    update public.boe_credit_payroll_applications
       set reversal_transaction_id = new.id,
           reversed_at             = new.created_at
     where redemption_transaction_id = v_original.id
       and reversal_transaction_id is null;
  end if;

  return null;
end;
$$;

revoke execute on function public.boe_credit_reversal_effects() from public, anon, authenticated;

drop trigger if exists boe_credit_reversal_effects on public.boe_credit_transactions;
create trigger boe_credit_reversal_effects
  after insert on public.boe_credit_transactions
  for each row
  when (new.transaction_type = 'reversal')
  execute function public.boe_credit_reversal_effects();

-- ═══ 8. The reward, attributed to its month ════════════════════════════════
--
-- SERVICE ROLE ONLY (the verify transition calls it as the owner). Posts the
-- review_reward row for the active setting, records which review and which
-- month, creates the month row on first use with the minimum snapshotted, and
-- refreshes the month — which is where the third review makes the month
-- qualified. All under the per-employee lock, so a concurrent finalization
-- sees either none of it or all of it.
--
-- Returns jsonb: { transaction_id, credits, review_month, month_status,
--                  qualifying_review_count, minimum_reviews, provisional }

create or replace function public.post_boe_credit_review_reward(
  p_employee_id  uuid,
  p_card_id      uuid,
  p_card_ref     text,
  p_submitted_at timestamptz,
  p_actor_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.boe_credit_settings%rowtype;
  v_month    date;
  v_row      public.boe_credit_review_months%rowtype;
  v_tx       uuid;
begin
  if p_card_id is null or nullif(btrim(coalesce(p_card_ref, '')), '') is null then
    raise exception 'BOE_CREDITS_SOURCE: a review reward must name the review it is for'
      using errcode = '22023';
  end if;
  if p_submitted_at is null then
    raise exception 'BOE_CREDITS_REVIEW_MONTH: the review has no submission to attribute its credit to'
      using errcode = '22023';
  end if;

  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row'
      using errcode = 'P0002';
  end if;

  -- THE REVIEW MONTH: the Asia/Kolkata calendar month of the successful submission.
  v_month := date_trunc('month', (p_submitted_at at time zone 'Asia/Kolkata')::date)::date;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  v_tx := public.post_boe_credit_transaction(
    p_employee_id,
    'review_reward',
    v_settings.review_reward_credits,
    'customer_review',
    p_card_id,
    'Review verified · ' || p_card_ref,
    p_actor_id
  );

  insert into public.boe_credit_review_months (employee_id, review_month, minimum_reviews_snapshot)
  values (p_employee_id, v_month, v_settings.minimum_monthly_reviews)
  on conflict (employee_id, review_month) do nothing;

  select * into v_row from public.boe_credit_review_months
   where employee_id = p_employee_id and review_month = v_month;

  insert into public.boe_credit_review_rewards (
    transaction_id, employee_id, card_id, card_ref, submitted_at, review_month, review_month_id
  ) values (
    v_tx, p_employee_id, p_card_id, p_card_ref, p_submitted_at, v_month, v_row.id
  );

  v_row := public.refresh_boe_credit_review_month(p_employee_id, v_month);

  return jsonb_build_object(
    'transaction_id',          v_tx,
    'credits',                 v_settings.review_reward_credits,
    'review_month',            v_month,
    'month_status',            v_row.status,
    'qualifying_review_count', v_row.qualifying_review_count,
    'minimum_reviews',         v_row.minimum_reviews_snapshot,
    'provisional',             v_row.status = 'open'
  );
end;
$$;

revoke execute on function public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid)
  from public, anon, authenticated;
grant  execute on function public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid)
  to service_role;

comment on function public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid) is
  'SERVICE ROLE ONLY (called by the verify transition as its owner). Posts one review_reward for the active review_reward_credits, attributes it to the Asia/Kolkata month of the successful submission, snapshots the monthly minimum on first use of that month, and qualifies the month when the count reaches the minimum. Under the per-employee lock.';

-- ═══ 9. Finalization ═══════════════════════════════════════════════════════
--
-- SERVICE ROLE ONLY; the actor must be an active admin. The month must have
-- ended (Asia/Kolkata). Idempotent: a month already qualified or lapsed is
-- returned as it is; a second call never posts a second lapse — the month row
-- is locked, the status is re-read under the employee lock, and the ledger's
-- one-row-per-source index stands behind both.
--
-- Returns jsonb: { review_month_id, status, qualifying_review_count,
--                  minimum_reviews, lapsed_credits, lapse_transaction_id,
--                  already_finalized }

create or replace function public.finalize_boe_credit_review_month(
  p_employee_id  uuid,
  p_review_month date,
  p_actor_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row    public.boe_credit_review_months%rowtype;
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_lapse  uuid;
  v_label  text;
begin
  if p_actor_id is null or not exists (
    select 1 from public.users
     where id = p_actor_id and role = 'admin' and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'BOE_CREDITS_DENIED: only an administrator can finalize a review month'
      using errcode = '42501';
  end if;
  if p_review_month is null or p_review_month <> date_trunc('month', p_review_month)::date then
    raise exception 'BOE_CREDITS_REVIEW_MONTH: a review month is named by its first day'
      using errcode = '22023';
  end if;
  if p_review_month >= date_trunc('month', v_today)::date then
    raise exception 'BOE_CREDITS_MONTH_OPEN: a review month can only be finalized after it has ended'
      using errcode = '55000';
  end if;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  -- Recount first, so a reversal that landed since the last refresh is honoured.
  v_row := public.refresh_boe_credit_review_month(p_employee_id, p_review_month);
  if v_row.id is null then
    raise exception 'BOE_CREDITS_REVIEW_MONTH: this employee earned no review credits in that month'
      using errcode = 'P0002';
  end if;

  if v_row.finalized_at is not null then
    return jsonb_build_object(
      'review_month_id',         v_row.id,
      'status',                  v_row.status,
      'qualifying_review_count', v_row.qualifying_review_count,
      'minimum_reviews',         v_row.minimum_reviews_snapshot,
      'lapsed_credits',          0,
      'lapse_transaction_id',    v_row.lapse_transaction_id,
      'already_finalized',       true
    );
  end if;

  if v_row.status = 'qualified' then
    update public.boe_credit_review_months
       set finalized_at = now(), finalized_by = p_actor_id
     where id = v_row.id
     returning * into v_row;
    return jsonb_build_object(
      'review_month_id',         v_row.id,
      'status',                  v_row.status,
      'qualifying_review_count', v_row.qualifying_review_count,
      'minimum_reviews',         v_row.minimum_reviews_snapshot,
      'lapsed_credits',          0,
      'lapse_transaction_id',    null,
      'already_finalized',       false
    );
  end if;

  -- Below the minimum: the month lapses. Only its STILL-VALID reward credits
  -- go — a reward already reversed contributed nothing to earned_review_credits.
  v_label := trim(to_char(p_review_month, 'Month')) || ' ' || to_char(p_review_month, 'YYYY');
  if v_row.earned_review_credits > 0 then
    v_lapse := public.post_boe_credit_transaction(
      p_employee_id,
      'review_month_lapse',
      -v_row.earned_review_credits,
      'boe_credit_review_month',
      v_row.id,
      v_label || ' review credits lapsed · ' || v_row.qualifying_review_count || ' of '
        || v_row.minimum_reviews_snapshot || ' reviews',
      p_actor_id
    );
  end if;

  update public.boe_credit_review_months
     set status               = 'lapsed',
         finalized_at         = now(),
         finalized_by         = p_actor_id,
         lapse_transaction_id = v_lapse
   where id = v_row.id
   returning * into v_row;

  return jsonb_build_object(
    'review_month_id',         v_row.id,
    'status',                  v_row.status,
    'qualifying_review_count', v_row.qualifying_review_count,
    'minimum_reviews',         v_row.minimum_reviews_snapshot,
    'lapsed_credits',          v_row.earned_review_credits,
    'lapse_transaction_id',    v_lapse,
    'already_finalized',       false
  );
end;
$$;

revoke execute on function public.finalize_boe_credit_review_month(uuid, date, uuid)
  from public, anon, authenticated;
grant  execute on function public.finalize_boe_credit_review_month(uuid, date, uuid)
  to service_role;

comment on function public.finalize_boe_credit_review_month(uuid, date, uuid) is
  'SERVICE ROLE ONLY; active admin actor. Finalizes one employee''s review month after it has ended: a qualified month is stamped finalized; a month below its minimum lapses with ONE review_month_lapse row for its still-valid reward credits. Idempotent under the per-employee lock — a finalized month is returned unchanged.';

-- ═══ 10. The verify transition, re-created ═════════════════════════════════
--
-- Byte-for-byte the 20261102000000 body except the reward branch, which now
-- calls post_boe_credit_review_reward() with the card's submitted_at — the
-- successful submission the verifier is confirming — and returns what it
-- reported (the month, its status, the count) beside the credits.

drop function if exists public.transition_customer_review_test_card(uuid, text, text);

create or replace function public.transition_customer_review_test_card(
  p_card_id     uuid,
  p_next_status text,
  p_detail      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c             public.customer_review_test_cards%rowtype;
  v_uid         uuid := auth.uid();
  v_use         boolean;
  v_verify      boolean;
  v_holder      boolean;
  v_legal       boolean;
  v_detail      text := nullif(btrim(coalesce(p_detail, '')), '');
  v_reward      jsonb;
  v_holder_name text;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- Locked for the duration, so two clicks cannot both read 'booked' and both
  -- write 'submitted'. The legality guard below then refuses the second.
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- REFUSED BEFORE ANY OTHER JUDGEMENT. Submitting, verifying and returning are
  -- all workflow actions, and a deleted review has left the workflow. A
  -- verifier can still READ the tombstone; they cannot move it.
  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be moved'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  -- RESOLVED FROM THE PERMISSION ENGINE, NOT FROM THE ROLE.
  v_use    := public.resolve_permission(v_uid, 'customer_review_requests', 'use');
  v_verify := public.resolve_permission(v_uid, 'customer_review_requests', 'verify');
  v_holder := (c.booked_by = v_uid);

  if not (v_use or v_verify) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: You do not have access to this module'
      using errcode = '42501';
  end if;

  -- ── Is the move itself legal? ──
  v_legal := case c.status
    when 'booked'    then p_next_status in ('submitted')
    when 'submitted' then p_next_status in ('verified', 'booked')
    else false
  end;

  if not v_legal then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: A % card cannot become %', c.status, p_next_status
      using errcode = '23514';
  end if;

  -- ── Is this person allowed to make it? ──
  if p_next_status in ('verified', 'booked') then
    if not v_verify then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Verifying or returning a test needs the Verify permission'
        using errcode = '42501';
    end if;
  else
    -- SUBMITTING IS A TESTER ACTION: the holder, and nobody else.
    if not (v_holder and v_use) then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can submit it'
        using errcode = '42501';
    end if;
  end if;

  if p_next_status = 'submitted' then
    perform public.assert_customer_review_test_card_submittable(p_card_id);
  end if;

  -- A return has to say why.
  if p_next_status = 'booked' and v_detail is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Give a short reason when returning a test'
      using errcode = '23514';
  end if;

  -- ── Apply ──
  update public.customer_review_test_cards c2
     set status = p_next_status,

         submitted_at = case when p_next_status = 'submitted' then now()  else c2.submitted_at end,
         submitted_by = case when p_next_status = 'submitted' then v_uid  else c2.submitted_by end,

         verified_at = case when p_next_status = 'verified' then now()  else c2.verified_at end,
         verified_by = case when p_next_status = 'verified' then v_uid  else c2.verified_by end,
         verification_note = case
           when p_next_status = 'verified' then v_detail
           else c2.verification_note
         end,

         returned_at   = case when p_next_status = 'booked' then now()    else c2.returned_at end,
         returned_by   = case when p_next_status = 'booked' then v_uid    else c2.returned_by end,
         return_reason = case when p_next_status = 'booked' then v_detail else c2.return_reason end
   -- NOTHING IS CLEARED ON A RETURN, and that is the choice rather than an
   -- omission. The append-only trail keeps every submission and every return.
   where c2.id = p_card_id;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id,
     case p_next_status when 'submitted' then 'submitted'
                        when 'verified'  then 'verified'
                        else 'returned' end,
     c.status, p_next_status, v_detail, v_uid);

  -- ── BOE Credits: the reward, in the same transaction ──
  --
  -- Reached only on submitted -> verified, which the legality guard above
  -- admits exactly once per card. The recipient is the HOLDER, read from the
  -- locked row; the actor recorded on the ledger row is the verifier, whose
  -- decision this is. The amount is the active setting, never a literal. The
  -- credit counts for the month of c.submitted_at — the successful submission
  -- being verified — decided by post_boe_credit_review_reward().
  if p_next_status = 'verified' then
    if c.booked_by is null then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: This review has no holder to reward'
        using errcode = '23514';
    end if;
    if c.submitted_at is null then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: This review has no submission to reward'
        using errcode = '23514';
    end if;

    v_reward := public.post_boe_credit_review_reward(
      c.booked_by,
      p_card_id,
      c.card_ref,
      c.submitted_at,
      v_uid
    );

    select u.full_name into v_holder_name from public.users u where u.id = c.booked_by;
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id;

  return jsonb_build_object(
    'card', to_jsonb(c),
    'reward', case
      when v_reward is null then null
      else v_reward || jsonb_build_object(
        'employee_id',   c.booked_by,
        'employee_name', v_holder_name
      )
    end
  );
end;
$$;

-- The grants, restated verbatim from 20261017000000: a browser-callable
-- function, on the same identity signature the allow-list names.
revoke execute on function public.transition_customer_review_test_card(uuid, text, text) from public, anon;
grant  execute on function public.transition_customer_review_test_card(uuid, text, text) to authenticated;

comment on function public.transition_customer_review_test_card(uuid, text, text) is
  'Moves one review between booked, submitted and verified (or back to booked with a reason). Actor is auth.uid(); use/verify are resolved from the permission engine, never a role. On submitted -> verified it posts exactly one review_reward for the holder (booked_by) through post_boe_credit_review_reward(), attributed to the month of the submission being verified, in the same transaction, and returns {card, reward}.';

-- ═══ 11. Attendance redemption, priced by the settings ═════════════════════
--
-- Same signature, same grants, same markers as 20261103000000. The two
-- literals are gone: the cost is the newest settings row's, read here, and
-- written on the record as before.

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
  v_period   public.payroll_periods%rowtype;
  v_settings public.boe_credit_settings%rowtype;
  v_cost     integer;
  v_id       uuid;
  v_tx       uuid;
  v_label    text;
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_balance  integer;
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

  -- 2. the kind, and the cost that follows from it — FROM THE SETTINGS.
  if p_deduction_type is null or p_deduction_type not in ('half_day', 'absent') then
    raise exception 'BOE_CREDITS_REDEMPTION_TYPE: credits cover a half day or an absent day, not %', coalesce(p_deduction_type, '<null>')
      using errcode = '22023';
  end if;
  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row'
      using errcode = 'P0002';
  end if;
  v_cost := case p_deduction_type
    when 'half_day' then v_settings.half_day_redemption_credits
    else                 v_settings.full_day_redemption_credits
  end;

  -- 3. serialise per employee FIRST, then the period FOR SHARE (the same order
  --    as the reversal, so the two cannot deadlock).
  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  -- 4. the period
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

  -- 7. no ACTIVE coverage for the day
  if exists (
    select 1 from public.boe_credit_attendance_redemptions
     where employee_id = p_employee_id
       and attendance_date = p_attendance_date
       and reversal_transaction_id is null
  ) then
    raise exception 'BOE_CREDITS_ALREADY_COVERED: this day is already covered with BOE Credits'
      using errcode = '23505';
  end if;

  -- 8. the ledger row, through the one write path (spendable-balance check inside)
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

  v_balance := public.boe_credit_spendable_balance(p_employee_id);

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
  'SERVICE ROLE ONLY. Covers one attendance day with BOE Credits at the ACTIVE settings price (half_day_redemption_credits / full_day_redemption_credits), written on the record. Actor is the employee (or an active admin re-pricing after a correction); period unlocked with a generated result; date inside the month and not in the future; at most one ACTIVE coverage per day; checked against the spendable balance. Returns available_credits = the spendable balance afterwards.';

comment on column public.boe_credit_attendance_redemptions.credits is
  'Whole credits spent, as priced by the settings at the moment of redemption. Historical: a later settings change never re-prices this row.';

-- ═══ 12. Payroll: credits into rupees ══════════════════════════════════════
--
-- SERVICE ROLE ONLY. The actor must be the employee. Under the per-employee
-- lock, with the period read FOR SHARE (a concurrent lock waits):
--   * the period exists, is not locked, and has a generated result for them;
--   * the credits are a positive whole number;
--   * an ACTIVE application with the SAME credits is returned as-is — a retry
--     or a double click changes nothing (idempotent);
--   * an ACTIVE application with DIFFERENT credits is reversed first (its
--     credits come back), then the new redemption is posted; both or neither;
--   * the rate is the newest credit_value, snapshotted with the rupees;
--   * the redemption is checked against the SPENDABLE balance inside
--     post_boe_credit_transaction().
-- Returns jsonb: { application_id, transaction_id, credits_used, credit_value,
--                  credit_amount, spendable_credits, replaced_application_id,
--                  unchanged }

create or replace function public.apply_boe_credits_to_payroll(
  p_employee_id       uuid,
  p_payroll_period_id uuid,
  p_credits           integer,
  p_actor_id          uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period   public.payroll_periods%rowtype;
  v_settings public.boe_credit_settings%rowtype;
  v_existing public.boe_credit_payroll_applications%rowtype;
  v_amount   numeric(12,2);
  v_id       uuid;
  v_tx       uuid;
  v_label    text;
  v_replaced uuid;
begin
  if p_employee_id is null or p_actor_id is null or p_actor_id <> p_employee_id then
    raise exception 'BOE_CREDITS_DENIED: credits can only be applied to payroll by the employee whose salary it is'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.users
     where id = p_employee_id and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'BOE_CREDITS_EMPLOYEE: the employee does not exist or is not active'
      using errcode = 'P0002';
  end if;
  if p_credits is null or p_credits <= 0 then
    raise exception 'BOE_CREDITS_ZERO: choose at least one credit to apply'
      using errcode = '22023';
  end if;

  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

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
  if not exists (
    select 1 from public.payroll_results
     where payroll_period_id = p_payroll_period_id and employee_id = p_employee_id
  ) then
    raise exception 'BOE_CREDITS_NOT_GENERATED: payroll for this month has not been generated yet'
      using errcode = '55000';
  end if;

  select * into v_existing
    from public.boe_credit_payroll_applications
   where employee_id = p_employee_id
     and payroll_period_id = p_payroll_period_id
     and reversal_transaction_id is null
     for update;

  v_label := trim(to_char(make_date(v_period.payroll_year, v_period.payroll_month, 1), 'Month'))
          || ' ' || v_period.payroll_year;

  if found then
    if v_existing.credits_used = p_credits then
      -- A retry, a double click, a second tab: nothing to do.
      return jsonb_build_object(
        'application_id',          v_existing.id,
        'transaction_id',          v_existing.redemption_transaction_id,
        'credits_used',            v_existing.credits_used,
        'credit_value',            v_existing.credit_value_snapshot,
        'credit_amount',           v_existing.credit_amount_snapshot,
        'spendable_credits',       public.boe_credit_spendable_balance(p_employee_id),
        'replaced_application_id', null,
        'unchanged',               true
      );
    end if;
    -- Reversed by the employee: the one non-admin reversal the ledger admits.
    perform public.post_boe_credit_transaction(
      p_employee_id,
      'reversal',
      v_existing.credits_used,
      'boe_credit_transaction',
      v_existing.redemption_transaction_id,
      'Payroll credit application changed · ' || v_label,
      p_actor_id,
      p_payroll_period_id
    );
    v_replaced := v_existing.id;
  end if;

  v_amount := round(p_credits * v_settings.credit_value, 2);
  v_id     := gen_random_uuid();

  v_tx := public.post_boe_credit_transaction(
    p_employee_id,
    'redemption',
    -p_credits,
    'payroll_redemption',
    v_id,
    'Applied to payroll · ' || v_label,
    p_actor_id,
    p_payroll_period_id
  );

  insert into public.boe_credit_payroll_applications (
    id, employee_id, payroll_period_id, credits_used,
    credit_value_snapshot, credit_amount_snapshot, redemption_transaction_id, created_by
  ) values (
    v_id, p_employee_id, p_payroll_period_id, p_credits,
    v_settings.credit_value, v_amount, v_tx, p_actor_id
  );

  return jsonb_build_object(
    'application_id',          v_id,
    'transaction_id',          v_tx,
    'credits_used',            p_credits,
    'credit_value',            v_settings.credit_value,
    'credit_amount',           v_amount,
    'spendable_credits',       public.boe_credit_spendable_balance(p_employee_id),
    'replaced_application_id', v_replaced,
    'unchanged',               false
  );
end;
$$;

revoke execute on function public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant  execute on function public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)
  to service_role;

comment on function public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid) is
  'SERVICE ROLE ONLY; the actor must be the employee. Applies N spendable credits to one unlocked, generated payroll month as a salary addition of N × the active credit_value, both snapshotted on boe_credit_payroll_applications. Idempotent for the same N; a different N reverses the active application and posts a new one, atomically. At most one ACTIVE application per employee-period.';

-- Withdrawal. Returns jsonb: { removed, application_id, reversal_transaction_id, spendable_credits }
create or replace function public.remove_boe_credit_payroll_application(
  p_employee_id       uuid,
  p_payroll_period_id uuid,
  p_actor_id          uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period   public.payroll_periods%rowtype;
  v_existing public.boe_credit_payroll_applications%rowtype;
  v_rev      uuid;
  v_label    text;
begin
  if p_employee_id is null or p_actor_id is null or p_actor_id <> p_employee_id then
    raise exception 'BOE_CREDITS_DENIED: a payroll credit application can only be removed by the employee whose salary it is'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  select * into v_period from public.payroll_periods where id = p_payroll_period_id for share;
  if not found then
    raise exception 'BOE_CREDITS_PERIOD: the payroll period does not exist'
      using errcode = 'P0002';
  end if;
  if v_period.status = 'locked' then
    raise exception 'BOE_CREDITS_PERIOD_LOCKED: payroll for this month is locked, so its credit application cannot change'
      using errcode = '55000';
  end if;

  select * into v_existing
    from public.boe_credit_payroll_applications
   where employee_id = p_employee_id
     and payroll_period_id = p_payroll_period_id
     and reversal_transaction_id is null
     for update;
  if not found then
    return jsonb_build_object(
      'removed', false, 'application_id', null, 'reversal_transaction_id', null,
      'spendable_credits', public.boe_credit_spendable_balance(p_employee_id)
    );
  end if;

  v_label := trim(to_char(make_date(v_period.payroll_year, v_period.payroll_month, 1), 'Month'))
          || ' ' || v_period.payroll_year;

  v_rev := public.post_boe_credit_transaction(
    p_employee_id,
    'reversal',
    v_existing.credits_used,
    'boe_credit_transaction',
    v_existing.redemption_transaction_id,
    'Payroll credit application removed · ' || v_label,
    p_actor_id,
    p_payroll_period_id
  );

  return jsonb_build_object(
    'removed', true, 'application_id', v_existing.id, 'reversal_transaction_id', v_rev,
    'spendable_credits', public.boe_credit_spendable_balance(p_employee_id)
  );
end;
$$;

revoke execute on function public.remove_boe_credit_payroll_application(uuid, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.remove_boe_credit_payroll_application(uuid, uuid, uuid)
  to service_role;

comment on function public.remove_boe_credit_payroll_application(uuid, uuid, uuid) is
  'SERVICE ROLE ONLY; the actor must be the employee. Withdraws the ACTIVE payroll credit application for one unlocked month by reversing its ledger row; the ledger trigger closes the record. Nothing to remove is not an error.';

-- ═══ 13. Assertions ════════════════════════════════════════════════════════

do $$
declare
  v_n        integer;
  v_settings public.boe_credit_settings%rowtype;
begin
  -- 13a. the three new tables exist with row security on, one SELECT policy each
  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('boe_credit_review_months', 'boe_credit_review_rewards', 'boe_credit_payroll_applications')
     and c.relrowsecurity;
  if v_n <> 3 then
    raise exception 'BOE_CREDITS_1D: expected 3 new tables with row security enabled, found %', v_n;
  end if;
  select count(*) into v_n
    from pg_policies
   where schemaname = 'public'
     and tablename in ('boe_credit_review_months', 'boe_credit_review_rewards', 'boe_credit_payroll_applications');
  if v_n <> 3 or exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('boe_credit_review_months', 'boe_credit_review_rewards', 'boe_credit_payroll_applications')
       and cmd <> 'SELECT'
  ) then
    raise exception 'BOE_CREDITS_1D: expected exactly one SELECT policy on each new table';
  end if;

  -- 13b. no client role can write the new tables; anon cannot read them
  if has_table_privilege('authenticated', 'public.boe_credit_review_months', 'INSERT')
     or has_table_privilege('authenticated', 'public.boe_credit_review_months', 'UPDATE')
     or has_table_privilege('authenticated', 'public.boe_credit_review_rewards', 'INSERT')
     or has_table_privilege('authenticated', 'public.boe_credit_payroll_applications', 'INSERT')
     or has_table_privilege('authenticated', 'public.boe_credit_payroll_applications', 'UPDATE')
     or has_table_privilege('anon', 'public.boe_credit_review_months', 'SELECT')
     or has_table_privilege('anon', 'public.boe_credit_payroll_applications', 'SELECT') then
    raise exception 'BOE_CREDITS_1D: a client role holds a write (or anon a read) on a Phase 1D table';
  end if;

  -- 13c. the uniqueness rules
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname  = 'boe_credit_payroll_applications_active_unique'
       and indexdef ilike '%unique%'
       and indexdef ilike '%where (reversal_transaction_id is null)%'
  ) then
    raise exception 'BOE_CREDITS_1D: the active-only unique index on payroll applications is missing or not partial';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.boe_credit_review_months'::regclass
       and conname = 'boe_credit_review_months_employee_month_unique'
  ) then
    raise exception 'BOE_CREDITS_1D: (employee, review_month) is not unique';
  end if;

  -- 13d. the ledger admits the fifth kind and still refuses everything else
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.boe_credit_transactions'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%review_month_lapse%'
       and pg_get_constraintdef(oid) like '%review_reward%'
       and pg_get_constraintdef(oid) not like '%credits%'
  ) then
    raise exception 'BOE_CREDITS_1D: the transaction_type CHECK does not admit review_month_lapse';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.boe_credit_transactions'::regclass
       and conname = 'boe_credit_transactions_shape_check'
       and pg_get_constraintdef(oid) like '%review_month_lapse%'
  ) then
    raise exception 'BOE_CREDITS_1D: the shape CHECK does not cover review_month_lapse';
  end if;

  -- 13e. every Phase 1D function is service role only; the transition stays browser-callable
  if has_function_privilege('authenticated', 'public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.finalize_boe_credit_review_month(uuid, date, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.remove_boe_credit_payroll_application(uuid, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.refresh_boe_credit_review_month(uuid, date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1D: a client role can execute a Phase 1D write function';
  end if;
  if not has_function_privilege('service_role', 'public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.finalize_boe_credit_review_month(uuid, date, uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1D: service_role cannot execute a Phase 1D function';
  end if;
  if not has_function_privilege('authenticated', 'public.transition_customer_review_test_card(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.transition_customer_review_test_card(uuid, text, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_1D: the transition grants changed';
  end if;

  -- 13f. the ledger triggers: the two new ones beside the Phase 1C closer
  select count(*) into v_n
    from pg_trigger
   where tgname in ('boe_credit_reversal_guard', 'boe_credit_reversal_effects', 'boe_credit_redemption_closed_by_reversal')
     and not tgisinternal;
  if v_n <> 3 then
    raise exception 'BOE_CREDITS_1D: expected 3 reversal triggers on the ledger, found %', v_n;
  end if;

  -- 13g. the view carries the three figures and runs as the invoker
  if not exists (
    select 1 from pg_class c
     where c.relname = 'boe_credit_balances' and c.relkind = 'v'
       and exists (select 1 from unnest(c.reloptions) o where o = 'security_invoker=true')
  ) then
    raise exception 'BOE_CREDITS_1D: boe_credit_balances is not security_invoker';
  end if;
  select count(*) into v_n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'boe_credit_balances'
     and column_name in ('available_credits', 'provisional_credits', 'spendable_credits');
  if v_n <> 3 then
    raise exception 'BOE_CREDITS_1D: the balances view lacks a Phase 1D column';
  end if;

  -- 13h. the active settings are the Phase 1D values
  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if v_settings.review_reward_credits       is distinct from 1
     or v_settings.credit_value                is distinct from 100.00
     or v_settings.half_day_redemption_credits is distinct from 8
     or v_settings.full_day_redemption_credits is distinct from 15
     or v_settings.minimum_monthly_reviews     is distinct from 3 then
    raise exception 'BOE_CREDITS_1D: active settings are not (1, 100.00, 8, 15, 3)';
  end if;

  -- 13i. NO BACKFILL. This file wrote no ledger row, no month, no reward record, no application.
  select count(*) into v_n from public.boe_credit_transactions where created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'BOE_CREDITS_1D: this migration posted % ledger row(s); it must post none', v_n;
  end if;
  select count(*) into v_n from public.boe_credit_review_months where created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'BOE_CREDITS_1D: this migration created % review month row(s); it must create none', v_n;
  end if;
  select count(*) into v_n from public.boe_credit_payroll_applications where created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'BOE_CREDITS_1D: this migration created % payroll application(s); it must create none', v_n;
  end if;
end $$;

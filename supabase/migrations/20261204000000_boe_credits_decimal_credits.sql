-- ═══════════════════════════════════════════════════════════════════════════
-- BOE Credits — decimal credits (1.5, 2.5, 0.5 …), without changing any rule.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY. An image-based review may earn ₹75 = 1.5 credits. Every credit amount
-- in the BOE Credits schema was declared `integer`, and — worse than a refused
-- insert — every PL/pgSQL variable that carried a credit amount was `integer`
-- too, so a 1.5 would not fail, it would ROUND: an `integer` variable assigned
-- 1.5 holds 2. Concretely, before this file:
--
--   post_boe_credit_review_reward()      v_credits integer  → a 1.5 image reward posts 2
--   refresh_boe_credit_review_month()    sum(...)::integer   → a month's earned credits round
--   post_boe_credit_transaction()        v_balance integer  → a 7.5 spendable balance reads 8,
--                                                             so an 8-credit redemption would
--                                                             overdraw and be ADMITTED
--   redeem_boe_credits_for_attendance()  v_balance integer  → the reported balance rounds
--   reverse_boe_credit_attendance_redemption()  v_balance integer → same
--   boe_credit_balance / _provisional_credits / _spendable_balance  return integer
--   boe_credit_balances                  ::integer casts on all three figures
--
-- WHAT CHANGES
-- ------------
--   Columns, integer → numeric(12,2):
--     boe_credit_transactions.credits
--     boe_credit_review_months.earned_review_credits
--     boe_credit_payroll_applications.credits_used
--     boe_credit_settings.review_reward_credits         (the TEXT review reward)
--     boe_credit_settings.image_review_reward_credits   (the IMAGE review reward)
--   Functions re-created with numeric amounts, bodies otherwise identical to
--   the definitions currently in force (20261104000000 / 20261103000000 /
--   20261107000000):
--     boe_credit_balance, boe_credit_provisional_credits, boe_credit_spendable_balance
--     post_boe_credit_transaction       p_credits integer → numeric (new signature)
--     apply_boe_credits_to_payroll      p_credits integer → numeric (new signature)
--     post_boe_credit_review_reward     v_credits numeric
--     refresh_boe_credit_review_month   v_credits numeric
--     redeem_boe_credits_for_attendance            v_balance numeric
--     reverse_boe_credit_attendance_redemption     v_balance numeric
--   boe_credit_balances                 re-created with numeric figures
--
-- WHAT DOES NOT CHANGE
-- --------------------
--   * Every rule: signs, the one-row-per-source index, the spendable-balance
--     check, provisional months, lapses, reversal guards, period locks,
--     append-only triggers, grants to client roles. A reversal still negates
--     the original EXACTLY, now to the hundredth.
--   * The attendance prices (half_day/full_day_redemption_credits), the monthly
--     minimum and boe_credit_attendance_redemptions.credits stay whole numbers:
--     nothing asked for a fractional attendance price, and a decimal balance
--     spends against a whole price without any change.
--   * credit_value (₹ per credit) is untouched. It is a setting an administrator
--     changes on /payroll/credits.
--
-- PRECISION. numeric(12,2): two decimal places, the hundredth of a credit —
-- 0.5, 1.5 and 2.5 are exact, and 1.555 is REFUSED by the posting functions
-- (BOE_CREDITS_PRECISION) rather than silently rounded by the column. No
-- floating-point type is used anywhere.
--
-- EXISTING ROWS. integer → numeric(12,2) is exact for every integer in range:
-- 100 becomes 100.00, which is the same number. No row is inserted, updated or
-- deleted; the ALTERs rewrite the tables without firing their append-only row
-- triggers, and a balance before equals the balance after, to the credit.
--
-- DEPLOYMENT ORDER. Apply BEFORE the application code that sends a decimal. The
-- currently deployed code keeps working against this schema: it sends whole
-- numbers, which the numeric signatures accept, and PostgREST returns numeric as
-- a JSON number, which it already reads with Number().
--
-- ROLLBACK (lossless only while every stored amount is still whole)
--   re-apply 20261104000000 §5 (functions + view), §6 (post), §7a (refresh),
--   §11 (redeem), §12 (apply) and 20261103000000 §4 (reverse), 20261107000000
--   §12 (reward) after `alter column ... type integer` on the five columns,
--   dropping the numeric signatures of post_boe_credit_transaction and
--   apply_boe_credits_to_payroll first.

-- ═══ 1. Take down what depends on the column types ═════════════════════════
--
-- The view reads credits and calls the provisional function; the three
-- balance functions change their RETURN type, which CREATE OR REPLACE cannot
-- do. All four are re-created in §3, in the same transaction.

drop view if exists public.boe_credit_balances;
drop function if exists public.boe_credit_spendable_balance(uuid);
drop function if exists public.boe_credit_provisional_credits(uuid);
drop function if exists public.boe_credit_balance(uuid);

-- ═══ 2. The columns ════════════════════════════════════════════════════════

alter table public.boe_credit_transactions
  alter column credits type numeric(12,2) using credits::numeric(12,2);

comment on column public.boe_credit_transactions.credits is
  'Signed credits, at most two decimal places (1.5 is one and a half credits). Positive earns, negative spends. Never zero.';

alter table public.boe_credit_review_months
  alter column earned_review_credits type numeric(12,2) using earned_review_credits::numeric(12,2);

alter table public.boe_credit_payroll_applications
  alter column credits_used type numeric(12,2) using credits_used::numeric(12,2);

alter table public.boe_credit_settings
  alter column review_reward_credits type numeric(12,2) using review_reward_credits::numeric(12,2),
  alter column image_review_reward_credits type numeric(12,2) using image_review_reward_credits::numeric(12,2);

comment on column public.boe_credit_settings.review_reward_credits is
  'Credits ONE verified TEXT review earns, at most two decimal places. The column keeps its original name because it keeps its original meaning and its history. Read at verification time; a later change never re-prices a reward already posted.';

comment on column public.boe_credit_settings.image_review_reward_credits is
  'Credits ONE verified IMAGE review earns, at most two decimal places (1.5 = one and a half). Independent of the text reward. Read at verification time from the newest settings row.';

-- ═══ 3. The balances, numeric ═════════════════════════════════════════════

create or replace function public.boe_credit_balance(p_employee_id uuid)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(credits), 0)
    from public.boe_credit_transactions
   where employee_id = p_employee_id;
$$;

revoke execute on function public.boe_credit_balance(uuid) from public, anon;
grant  execute on function public.boe_credit_balance(uuid) to authenticated, service_role;

comment on function public.boe_credit_balance(uuid) is
  'SUM(credits) for one employee, read under the caller''s own RLS. Zero when there are no rows. Numeric: decimal credits are summed exactly.';

create or replace function public.boe_credit_provisional_credits(p_employee_id uuid)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(t.credits), 0)
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
grant  execute on function public.boe_credit_provisional_credits(uuid) to authenticated, service_role;

comment on function public.boe_credit_provisional_credits(uuid) is
  'Review-reward credits an employee holds that cannot be spent yet: rewards attributed to a review month still open (below the monthly minimum), not reversed. Read under the caller''s own RLS. Numeric.';

create or replace function public.boe_credit_spendable_balance(p_employee_id uuid)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select public.boe_credit_balance(p_employee_id) - public.boe_credit_provisional_credits(p_employee_id);
$$;

revoke execute on function public.boe_credit_spendable_balance(uuid) from public, anon;
grant  execute on function public.boe_credit_spendable_balance(uuid) to authenticated, service_role;

comment on function public.boe_credit_spendable_balance(uuid) is
  'THE balance a redemption is checked against: SUM(ledger) minus provisional review rewards. Read under the caller''s own RLS. Numeric.';

create view public.boe_credit_balances
with (security_invoker = true) as
select
  employee_id,
  -- The recorded total, unchanged in meaning: SUM(credits). Numeric, so 1.5 stays 1.5.
  coalesce(sum(credits), 0)::numeric(12,2)                                                       as available_credits,
  count(*)::integer                                                                              as transaction_count,
  max(created_at)                                                                                as last_transaction_at,
  public.boe_credit_provisional_credits(employee_id)::numeric(12,2)                              as provisional_credits,
  (coalesce(sum(credits), 0) - public.boe_credit_provisional_credits(employee_id))::numeric(12,2) as spendable_credits
from public.boe_credit_transactions
group by employee_id;

revoke all on public.boe_credit_balances from anon;
grant  select on public.boe_credit_balances to authenticated, service_role;

comment on view public.boe_credit_balances is
  'BOE Credits per employee, derived on every read: available_credits = SUM(credits) (the recorded total), provisional_credits = rewards of still-open review months, spendable_credits = the difference — the only figure a redemption may consume. Two decimal places. Employees with no ledger rows are absent and have zero of each.';

-- ═══ 4. The one write path, numeric ═══════════════════════════════════════
--
-- The 20261104000000 §6 body, with three differences and no others:
--   * p_credits is numeric, so the signature changes (the integer one is dropped
--     — two overloads would make every named-argument call ambiguous);
--   * an amount with more than two decimal places is refused, not rounded;
--   * v_balance is numeric, so the spendable-balance check compares exactly.

drop function if exists public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid);

create or replace function public.post_boe_credit_transaction(
  p_employee_id       uuid,
  p_transaction_type  text,
  p_credits           numeric,
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
  v_balance     numeric;
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
    raise exception 'BOE_CREDITS_ZERO: a credit transaction must move a non-zero number of credits'
      using errcode = '22023';
  end if;

  -- The column is numeric(12,2); a third decimal would be rounded silently on
  -- insert. Refused here instead, so what is posted is what was asked for.
  if p_credits <> round(p_credits, 2) then
    raise exception 'BOE_CREDITS_PRECISION: credits have at most two decimal places'
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
  -- excluded here, whichever path is spending. Numeric, so 7.5 is 7.5.
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

revoke execute on function public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)
  to service_role;

comment on function public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid) is
  'SERVICE ROLE ONLY. The one way a BOE Credits ledger row is written. Validates employee, actor (an active admin for adjustments, lapses and reversals — except an employee reversing their own payroll application), a non-zero amount with at most two decimal places, type, shape and the one-row-per-source rule under a per-employee lock. A redemption is checked against the SPENDABLE balance (recorded minus provisional). Not callable by anon or authenticated.';

-- ═══ 5. The review reward, numeric ════════════════════════════════════════
--
-- The 20261107000000 §12 body; the only change is `v_credits numeric`, so a
-- 1.5 image reward posts 1.5 rather than 2.

create or replace function public.post_boe_credit_review_reward(
  p_employee_id  uuid,
  p_card_id      uuid,
  p_card_ref     text,
  p_review_type  text,
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
  v_credits  numeric;
begin
  if p_card_id is null or nullif(btrim(coalesce(p_card_ref, '')), '') is null then
    raise exception 'BOE_CREDITS_SOURCE: a review reward must name the review it is for'
      using errcode = '22023';
  end if;
  if p_submitted_at is null then
    raise exception 'BOE_CREDITS_REVIEW_MONTH: the review has no submission to attribute its credit to'
      using errcode = '22023';
  end if;
  -- THE TYPE DECIDES THE PRICE, so an unrecognised one is refused rather than
  -- defaulted. A default here would be a silent mispricing.
  if p_review_type is null or p_review_type not in ('text', 'image') then
    raise exception 'BOE_CREDITS_REVIEW_TYPE: a review reward must name a known review type'
      using errcode = '22023';
  end if;

  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row'
      using errcode = 'P0002';
  end if;

  v_credits := case p_review_type
    when 'image' then v_settings.image_review_reward_credits
    else v_settings.review_reward_credits
  end;

  -- THE REVIEW MONTH: the Asia/Kolkata calendar month of the successful submission.
  v_month := date_trunc('month', (p_submitted_at at time zone 'Asia/Kolkata')::date)::date;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(p_employee_id::text));

  v_tx := public.post_boe_credit_transaction(
    p_employee_id,
    'review_reward',
    v_credits,
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
    'credits',                 v_credits,
    'review_type',             p_review_type,
    'review_month',            v_month,
    'month_status',            v_row.status,
    'qualifying_review_count', v_row.qualifying_review_count,
    'minimum_reviews',         v_row.minimum_reviews_snapshot,
    'provisional',             v_row.status = 'open'
  );
end;
$$;

revoke execute on function public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)
  from public, anon, authenticated;
grant  execute on function public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)
  to service_role;

-- ═══ 6. The month recount, numeric ════════════════════════════════════════
--
-- The 20261104000000 §7a body; the only change is that the earned credits are
-- summed as numeric instead of cast to integer.

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
  v_credits numeric;
begin
  select * into v_month
    from public.boe_credit_review_months
   where employee_id = p_employee_id and review_month = p_review_month
     for update;
  if not found then
    return null;
  end if;

  select count(*)::integer, coalesce(sum(t.credits), 0)
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

-- ═══ 7. Attendance redemption, numeric balance ════════════════════════════
--
-- The 20261104000000 §11 body; the only change is `v_balance numeric`. The
-- price itself (v_cost) is still a whole number read from the settings.

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
  v_balance  numeric;
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

-- The 20261103000000 §4 body; the only change is `v_balance numeric`.
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
  v_balance numeric;
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

-- ═══ 8. Payroll application, numeric credits ══════════════════════════════
--
-- The 20261104000000 §12 body; p_credits is numeric (new signature, the
-- integer one dropped) and a third decimal place is refused. The rupees are
-- still round(credits × credit_value, 2), snapshotted.

drop function if exists public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid);

create or replace function public.apply_boe_credits_to_payroll(
  p_employee_id       uuid,
  p_payroll_period_id uuid,
  p_credits           numeric,
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
    raise exception 'BOE_CREDITS_ZERO: choose a number of credits above zero to apply'
      using errcode = '22023';
  end if;
  if p_credits <> round(p_credits, 2) then
    raise exception 'BOE_CREDITS_PRECISION: credits have at most two decimal places'
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

revoke execute on function public.apply_boe_credits_to_payroll(uuid, uuid, numeric, uuid)
  from public, anon, authenticated;
grant  execute on function public.apply_boe_credits_to_payroll(uuid, uuid, numeric, uuid)
  to service_role;

comment on function public.apply_boe_credits_to_payroll(uuid, uuid, numeric, uuid) is
  'SERVICE ROLE ONLY; the actor must be the employee. Applies N spendable credits (at most two decimal places) to one unlocked, generated payroll month as a salary addition of round(N × the active credit_value, 2), both snapshotted on boe_credit_payroll_applications. Idempotent for the same N; a different N reverses the active application and posts a new one, atomically. At most one ACTIVE application per employee-period.';

-- ═══ 9. Assertions ═════════════════════════════════════════════════════════

do $$
declare
  v_n     integer;
  v_col   record;
  v_src   text;
begin
  -- 9a. every credit amount column is numeric(12,2)
  for v_col in
    select * from (values
      ('boe_credit_transactions',         'credits'),
      ('boe_credit_review_months',        'earned_review_credits'),
      ('boe_credit_payroll_applications', 'credits_used'),
      ('boe_credit_settings',             'review_reward_credits'),
      ('boe_credit_settings',             'image_review_reward_credits')
    ) as t(table_name, column_name)
  loop
    if not exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name   = v_col.table_name
         and c.column_name  = v_col.column_name
         and c.data_type    = 'numeric'
         and c.numeric_precision = 12
         and c.numeric_scale     = 2
    ) then
      raise exception 'BOE_CREDITS_DECIMAL: %.% is not numeric(12,2)', v_col.table_name, v_col.column_name;
    end if;
  end loop;

  -- 9b. the three balance figures in the view are numeric, and it still runs as the invoker
  select count(*) into v_n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'boe_credit_balances'
     and column_name in ('available_credits', 'provisional_credits', 'spendable_credits')
     and data_type = 'numeric';
  if v_n <> 3 then
    raise exception 'BOE_CREDITS_DECIMAL: the balances view does not carry three numeric figures (found %)', v_n;
  end if;
  if not exists (
    select 1 from pg_class c
     where c.relname = 'boe_credit_balances' and c.relkind = 'v'
       and exists (select 1 from unnest(c.reloptions) o where o = 'security_invoker=true')
  ) then
    raise exception 'BOE_CREDITS_DECIMAL: boe_credit_balances is not security_invoker';
  end if;

  -- 9c. the balance functions return numeric
  if pg_get_function_result(to_regprocedure('public.boe_credit_balance(uuid)')) is distinct from 'numeric'
     or pg_get_function_result(to_regprocedure('public.boe_credit_provisional_credits(uuid)')) is distinct from 'numeric'
     or pg_get_function_result(to_regprocedure('public.boe_credit_spendable_balance(uuid)')) is distinct from 'numeric' then
    raise exception 'BOE_CREDITS_DECIMAL: a balance function does not return numeric';
  end if;

  -- 9d. exactly one posting function and one payroll application function, numeric
  if to_regprocedure('public.post_boe_credit_transaction(uuid, text, integer, text, uuid, text, uuid, uuid)') is not null
     or to_regprocedure('public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)') is null then
    raise exception 'BOE_CREDITS_DECIMAL: post_boe_credit_transaction does not have exactly the numeric signature';
  end if;
  if to_regprocedure('public.apply_boe_credits_to_payroll(uuid, uuid, integer, uuid)') is not null
     or to_regprocedure('public.apply_boe_credits_to_payroll(uuid, uuid, numeric, uuid)') is null then
    raise exception 'BOE_CREDITS_DECIMAL: apply_boe_credits_to_payroll does not have exactly the numeric signature';
  end if;

  -- 9e. no credit-carrying variable is integer any more
  select prosrc into v_src from pg_proc where oid = to_regprocedure('public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)');
  if v_src ~ 'v_balance\s+integer' then
    raise exception 'BOE_CREDITS_DECIMAL: post_boe_credit_transaction still reads the balance as integer';
  end if;
  select prosrc into v_src from pg_proc where oid = to_regprocedure('public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)');
  if v_src is null or v_src ~ 'v_credits\s+integer' then
    raise exception 'BOE_CREDITS_DECIMAL: post_boe_credit_review_reward still prices the reward as integer';
  end if;
  select prosrc into v_src from pg_proc where oid = to_regprocedure('public.refresh_boe_credit_review_month(uuid, date)');
  if v_src ~ 'v_credits\s+integer' or v_src ~ 'sum\(t\.credits\), 0\)::integer' then
    raise exception 'BOE_CREDITS_DECIMAL: refresh_boe_credit_review_month still sums credits as integer';
  end if;
  select prosrc into v_src from pg_proc where oid = to_regprocedure('public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)');
  if v_src ~ 'v_balance\s+integer' then
    raise exception 'BOE_CREDITS_DECIMAL: redeem_boe_credits_for_attendance still reads the balance as integer';
  end if;
  select prosrc into v_src from pg_proc where oid = to_regprocedure('public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)');
  if v_src ~ 'v_balance\s+integer' then
    raise exception 'BOE_CREDITS_DECIMAL: reverse_boe_credit_attendance_redemption still reads the balance as integer';
  end if;

  -- 9f. the write paths are still service role only
  if has_function_privilege('authenticated', 'public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.apply_boe_credits_to_payroll(uuid, uuid, numeric, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.apply_boe_credits_to_payroll(uuid, uuid, numeric, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.refresh_boe_credit_review_month(uuid, date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.redeem_boe_credits_for_attendance(uuid, uuid, date, text, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reverse_boe_credit_attendance_redemption(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_DECIMAL: a client role can execute a credits write function';
  end if;
  if not has_function_privilege('service_role', 'public.post_boe_credit_transaction(uuid, text, numeric, text, uuid, text, uuid, uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.apply_boe_credits_to_payroll(uuid, uuid, numeric, uuid)', 'EXECUTE') then
    raise exception 'BOE_CREDITS_DECIMAL: service_role cannot execute a credits write function';
  end if;
  if has_table_privilege('anon', 'public.boe_credit_balances', 'SELECT')
     or not has_table_privilege('authenticated', 'public.boe_credit_balances', 'SELECT') then
    raise exception 'BOE_CREDITS_DECIMAL: the balances view grants changed';
  end if;

  -- 9g. NOTHING WAS WRITTEN. This file converts types; it posts no row.
  select count(*) into v_n from public.boe_credit_transactions where created_at >= transaction_timestamp();
  if v_n <> 0 then
    raise exception 'BOE_CREDITS_DECIMAL: this migration posted % ledger row(s); it must post none', v_n;
  end if;
end $$;

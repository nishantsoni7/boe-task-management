-- ═════════════════════════════════════════════════════════════════════════════
-- BOE Credits: a review month that is still open follows the monthly target
-- saved NOW
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY. An admin lowered "Minimum Approved Reviews Per Month" from 3 to 1 on the
-- BOE Credits page. October's Month close table still read "2 of 3" and "1 of 3",
-- "Below target", and closing October would have lapsed those credits. Each month
-- row copied the target in force when its first review was approved
-- (minimum_reviews_snapshot), the guard trigger refused any later change to it, and
-- refresh_boe_credit_review_month() qualified a month only against that copy. So a
-- change to the saved target never reached a month that already had a row.
--
-- THE RULE AFTER THIS FILE
--   * A month that is OPEN (not qualified, not closed) uses the target saved now.
--     Every recount re-reads it, and saving a new target recounts all open months
--     at once, so a month whose approved reviews reach the new target becomes
--     'qualified' and its credits become spendable.
--   * A month that has QUALIFIED keeps qualifying: raising the target later takes
--     nothing back (the settings form already says "no credit already held is
--     taken"). The guard still refuses qualified -> open.
--   * A month that has been CLOSED (finalized, or lapsed) keeps the minimum it was
--     closed under. A lapsed month stays final; this file does not reopen one.
--
-- WHAT CHANGES (four definitions, one trigger, one one-time recount)
--   1. boe_credit_review_months_guard(): the minimum may move while the month is
--      open and not finalized; employee and month never move; the lapsed/qualified
--      rules and the finalize-once rule are unchanged.
--   2. refresh_boe_credit_review_month(): the 20261204000000 body, plus: for an
--      open, unfinalized month the minimum is first set to the newest settings
--      row's minimum_monthly_reviews, and the month qualifies against THAT.
--      finalize_boe_credit_review_month() calls it first, so closing a month
--      judges it against the target in force when it is closed.
--   3. refresh_open_boe_credit_review_months(): recounts every open month, one
--      employee at a time under the same advisory lock the reward functions use.
--   4. Trigger boe_credit_settings_refresh_open_months (AFTER INSERT on
--      boe_credit_settings) calls (3), so saving the target on the BOE Credits page
--      applies at once without any application code.
--   5. At the end of this file, (3) runs once against the target saved now. THAT
--      IS THE STEP THAT MOVES CREDITS: every open month whose approved reviews
--      already reach the active target turns 'qualified' and its pending credits
--      become spendable. Nothing else is written.
--
-- NOT CHANGED: the ledger, rewards, balances, payroll applications, the settings
-- table and its append-only trigger, the post_*_reward functions (they still copy
-- the target into a NEW month row, which is now simply the starting value of an
-- open month), and every closed or lapsed month.
--
-- ROLLBACK (behaviour only). Restore the 20261104000000 guard and the 20261204000000
-- refresh_boe_credit_review_month(), then:
--     drop trigger if exists boe_credit_settings_refresh_open_months on public.boe_credit_settings;
--     drop function if exists public.boe_credit_settings_refresh_open_months();
--     drop function if exists public.refresh_open_boe_credit_review_months();
-- It does NOT undo what step 5 did: a month that has qualified stays qualified by
-- design, and its credits stay spendable. Reverse any individual credit through
-- Payroll > Credits > History if that is ever wanted.
--
-- Safe to apply twice: every statement is create-or-replace or drop-if-exists, and
-- the one-time recount finds nothing left to qualify the second time.

-- ═══ 1. The guard: the minimum follows the target while the month is open ═══

create or replace function public.boe_credit_review_months_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'BOE_CREDITS_APPEND_ONLY: boe_credit_review_months is never deleted'
      using errcode = '42501';
  end if;
  -- Identity never moves.
  if new.employee_id <> old.employee_id or new.review_month <> old.review_month then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a review month keeps its employee and month'
      using errcode = '42501';
  end if;
  -- The minimum follows the saved target only while the month is open. Once it has
  -- qualified, or been closed, it keeps the one it did so under.
  if new.minimum_reviews_snapshot <> old.minimum_reviews_snapshot
     and (old.status <> 'open' or old.finalized_at is not null) then
    raise exception 'BOE_CREDITS_APPEND_ONLY: a qualified or closed review month keeps its minimum'
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

-- ═══ 2. The recount: an open month judges itself against the saved target ═══
--
-- The 20261204000000 body. The only additions are v_target / v_min and the two
-- places v_min replaces the stored column.

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
  v_target  integer;
  v_min     integer;
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

  -- An open, unfinalized month follows the target saved now. A qualified or closed
  -- month keeps the minimum it qualified or closed under.
  v_min := v_month.minimum_reviews_snapshot;
  if v_month.status = 'open' and v_month.finalized_at is null then
    select s.minimum_monthly_reviews into v_target
      from public.boe_credit_settings s
     order by s.created_at desc
     limit 1;
    v_min := coalesce(v_target, v_min);
  end if;

  update public.boe_credit_review_months
     set qualifying_review_count  = v_count,
         earned_review_credits    = v_credits,
         minimum_reviews_snapshot = v_min,
         status       = case when status = 'open' and v_count >= v_min then 'qualified' else status end,
         qualified_at = case when status = 'open' and v_count >= v_min then now() else qualified_at end
   where id = v_month.id
   returning * into v_month;

  return v_month;
end;
$$;

revoke execute on function public.refresh_boe_credit_review_month(uuid, date) from public, anon, authenticated;
grant  execute on function public.refresh_boe_credit_review_month(uuid, date) to service_role;

-- ═══ 3. Recount every open month ═══════════════════════════════════════════
--
-- One employee at a time under the per-employee advisory lock the reward and
-- redemption functions take, in a fixed (month, employee) order so two callers
-- cannot wait on each other. Returns how many open months it looked at.

create or replace function public.refresh_open_boe_credit_review_months()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_n   integer := 0;
begin
  for v_row in
    select m.employee_id, m.review_month
      from public.boe_credit_review_months m
     where m.status = 'open' and m.finalized_at is null
     order by m.review_month, m.employee_id
  loop
    perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(v_row.employee_id::text));
    perform public.refresh_boe_credit_review_month(v_row.employee_id, v_row.review_month);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.refresh_open_boe_credit_review_months() from public, anon, authenticated;
grant  execute on function public.refresh_open_boe_credit_review_months() to service_role;

comment on function public.refresh_open_boe_credit_review_months() is
  'SERVICE ROLE ONLY. Recounts every review month that is still open against the newest saved monthly target; a month whose approved reviews reach it becomes qualified and its credits spendable. Called by the settings trigger and once by the migration that introduced it.';

-- ═══ 4. Saving the target applies it ═══════════════════════════════════════

create or replace function public.boe_credit_settings_refresh_open_months()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_open_boe_credit_review_months();
  return null;
end;
$$;

revoke execute on function public.boe_credit_settings_refresh_open_months() from public, anon, authenticated;

drop trigger if exists boe_credit_settings_refresh_open_months on public.boe_credit_settings;
create trigger boe_credit_settings_refresh_open_months
  after insert on public.boe_credit_settings
  for each row execute function public.boe_credit_settings_refresh_open_months();

comment on column public.boe_credit_review_months.minimum_reviews_snapshot is
  'The monthly target this month is judged against. While the month is open it follows the newest saved target (every recount and every settings save refresh it); once the month has qualified or been closed it keeps the target it qualified or closed under.';

-- ═══ 5. One-time: judge the months that are open right now ═════════════════
--
-- THIS MOVES CREDITS: an open month whose approved reviews already reach the
-- target saved now becomes 'qualified', and its pending credits become spendable.
-- The self-checks below run in the same transaction and abort the apply, and with
-- it that change, if the result is not exactly the rule above.

do $$
declare
  v_target integer;
  v_n      integer;
  v_bad    integer;
  v_wrong  integer;
begin
  select s.minimum_monthly_reviews into v_target
    from public.boe_credit_settings s
   order by s.created_at desc
   limit 1;

  v_n := public.refresh_open_boe_credit_review_months();
  raise notice 'BOE credits: % open review month(s) re-checked against the saved target of %', v_n, v_target;

  if v_target is not null then
    -- No open month is left that already meets the target, and every open month
    -- carries the saved target.
    select count(*) into v_bad
      from public.boe_credit_review_months m
     where m.status = 'open' and m.finalized_at is null
       and (m.qualifying_review_count >= v_target or m.minimum_reviews_snapshot <> v_target);
    if v_bad > 0 then
      raise exception 'BOE_CREDITS_ASSERT: % open review month(s) still do not follow the saved target of %', v_bad, v_target;
    end if;
  end if;

  -- A lapsed month was not touched: it still has its lapse row.
  select count(*) into v_wrong
    from public.boe_credit_review_months m
   where m.status = 'lapsed' and m.lapse_transaction_id is null and m.earned_review_credits > 0;
  if v_wrong > 0 then
    raise exception 'BOE_CREDITS_ASSERT: a lapsed review month lost its lapse row';
  end if;

  -- The two new functions and the trigger are in place, and no client role can call them.
  if not exists (select 1 from pg_trigger where tgname = 'boe_credit_settings_refresh_open_months' and not tgisinternal) then
    raise exception 'BOE_CREDITS_ASSERT: the settings trigger is missing';
  end if;
  if has_function_privilege('anon', 'public.refresh_open_boe_credit_review_months()', 'execute')
     or has_function_privilege('authenticated', 'public.refresh_open_boe_credit_review_months()', 'execute')
     or has_function_privilege('anon', 'public.refresh_boe_credit_review_month(uuid, date)', 'execute')
     or has_function_privilege('authenticated', 'public.refresh_boe_credit_review_month(uuid, date)', 'execute') then
    raise exception 'BOE_CREDITS_ASSERT: a client role can execute a review month refresh';
  end if;
end;
$$;

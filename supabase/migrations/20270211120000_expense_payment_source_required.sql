-- ═══════════════════════════════════════════════════════════════════════════
-- 20270211120000 — A NEW expense must say how it was paid
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20270205120000 added expenses.paid_from ('company' | 'personal' | NULL) and
-- deliberately left the database accepting NULL: the app in production then did
-- not send the column, and refusing it would have broken saves in the window
-- between that migration and the deploy. That app is now live (#241), and its
-- form requires the choice. This is the follow-up it promised: the database
-- requires it too, so no other path — a script, an old build, a direct API call,
-- finalize_expense_draft() called without p_paid_from — can create an expense
-- whose source is unknown.
--
-- WHAT IT DOES
--   One BEFORE INSERT trigger on public.expenses: paid_from must be set.
--   (paid_by is already tied to it by expenses_paid_by_matches_source.)
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * No CHECK constraint. Even NOT VALID, a CHECK is enforced on every UPDATE
--     of an existing row, so correcting a typo on an older expense would force
--     somebody to guess how it was paid. Older expenses stay "not recorded"
--     (NULL) and stay correctable; expenses_guard_reimbursement already refuses
--     turning a recorded source back into NULL.
--   * No existing row is read, changed or classified. §2 asserts it.
--   * No policy, grant, function signature or other table changes.
--
-- WHO IT AFFECTS
--   Every caller, the service role included (a trigger, not RLS). The current
--   app always sends the choice. A build older than #241 — none is the
--   production deployment; only stale previews or pinned aliases could be —
--   would now get a refusal it can read instead of saving an unknown source.
--
-- ROLLBACK: drop trigger expenses_require_payment_source on public.expenses;
--           drop function public.expenses_require_payment_source();
--
-- DEPENDENCIES: 20270205120000 (expenses.paid_from).
-- ═══════════════════════════════════════════════════════════════════════════

do $dep$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'expenses' and column_name = 'paid_from') then
    raise exception 'DEPENDENCY MISSING: 20270205120000 (expenses.paid_from) must be applied first';
  end if;
end $dep$;


-- ═══ §1. The rule ═══════════════════════════════════════════════════════════

create or replace function public.expenses_require_payment_source()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.paid_from is null then
    raise exception 'EXPENSE_PAYMENT_SOURCE_REQUIRED: choose whether this expense was paid from a company account or personally'
      using errcode = '23502';
  end if;
  return new;
end;
$fn$;

comment on function public.expenses_require_payment_source() is
  'Refuses a NEW expense with no payment source (paid_from). Older expenses keep NULL ("not recorded") and stay correctable. Applies to every caller, the service role included. 20270211120000.';

revoke all on function public.expenses_require_payment_source() from public, anon, authenticated;

drop trigger if exists expenses_require_payment_source on public.expenses;
create trigger expenses_require_payment_source
  before insert on public.expenses
  for each row execute function public.expenses_require_payment_source();


-- ═══ §2. Assertions ═════════════════════════════════════════════════════════

do $assert$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.expenses'::regclass
                    and tgname = 'expenses_require_payment_source' and not tgisinternal
                    and tgtype & 4 = 4          -- INSERT
                    and tgtype & 16 = 0) then   -- not UPDATE: older rows stay correctable
    raise exception 'ASSERTION FAILED: expenses_require_payment_source must be a BEFORE INSERT trigger only';
  end if;
  if exists (select 1 from pg_constraint
              where conrelid = 'public.expenses'::regclass and contype = 'c'
                and pg_get_constraintdef(oid) ~* 'paid_from is not null') then
    raise exception 'ASSERTION FAILED: a CHECK on paid_from would block corrections of older expenses';
  end if;
  if (select is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'expenses' and column_name = 'paid_from') <> 'YES' then
    raise exception 'ASSERTION FAILED: paid_from must stay nullable for older expenses';
  end if;
end $assert$;

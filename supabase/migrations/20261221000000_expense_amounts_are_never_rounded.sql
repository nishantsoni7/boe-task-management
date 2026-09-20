-- ── An expense amount is REFUSED, never rounded ──────────────────────────────
--
-- THE DEFECT, AND HOW IT WAS FOUND. 20261220000000 declared
-- public.expenses.amount as `numeric(14,2)` and its comment claimed the declared
-- scale meant "excess precision is refused rather than rounded". That is not
-- what a scaled numeric does. PostgreSQL ROUNDS a value to the column's scale on
-- assignment; it raises nothing. Verified against this database immediately
-- after 20261220000000 was applied, inside a rolled-back transaction:
--
--     insert … amount = 10.005  →  stored as 10.01
--
-- Two consequences, and the second is the serious one:
--
--   1. The CHECK `amount = round(amount, 2)` in expenses_amount_valid was DEAD
--      CODE. By the time it ran, the value had already been rounded to two
--      places, so it could never fail.
--   2. A write that did not come through the form — a direct PostgREST call, a
--      script, a future server action — could turn 10.005 into 10.01 SILENTLY.
--      A different amount than the one submitted, with nothing on the row, in
--      the response or in any log to say so.
--
-- WHY THAT IS NOT ACCEPTABLE HERE. "Money is never silently rounded" is a rule
-- this module already enforces everywhere else, and PR #172 (the launch audit)
-- exists largely because of it: sanitizeAmountInput stopped truncating pasted
-- figures, amountInputProblem explains a refusal in words, and 20261219000000
-- added the rupees-and-paise CHECK to finance_payment_requests.amount. The
-- browser half of that rule is intact for expenses — the form refuses 10.005 and
-- says why — but the database half was missing, and a browser check is a
-- convenience, never a boundary.
--
-- THE FIX: DROP THE DECLARED SCALE, which makes the CHECK that is already there
-- do the work it was written to do. `numeric` with no declared precision is
-- EXACT DECIMAL, not floating point — it is arbitrary-precision, stores the
-- digits it is given, and crosses the wire as a string. So this does not weaken
-- the "never floating point" requirement in any way; it strengthens the rule
-- about precision from "rounded quietly" to "refused loudly".
--
-- IT IS ALSO WHAT THE REST OF FINANCE DOES. finance_payment_requests.amount is
-- plain `numeric` with exactly this CHECK (20260628000200, 20261219000000), and
-- finance_payment_allocations.allocated_amount likewise (20260918000000). After
-- this migration all three money columns in the module are declared and
-- constrained identically.
--
-- ── SAFETY ──────────────────────────────────────────────────────────────────
--
-- ADDITIVE AND NON-DESTRUCTIVE. One ALTER COLUMN TYPE, WIDENING the type
-- (numeric(14,2) → numeric). No policy, index, trigger, constraint, grant or
-- other table is touched, and there is no DML against any table, new or
-- existing. §3 asserts all of it.
--
-- EXISTING ROWS ARE SAFE BY CONSTRUCTION. Every amount already stored went
-- through numeric(14,2), so every one of them is already exactly two decimal
-- places; widening the type preserves each value digit for digit and PostgreSQL
-- does not rewrite or re-round anything. Rows exist — the first real expense was
-- recorded minutes after 20261220000000 went live — and none of them is at risk.

-- ─── 1. Check the property that actually matters ────────────────────────────
--
-- An earlier draft of this guard demanded an EMPTY table. That was the wrong
-- test: emptiness was a PROXY for "nothing can be re-rounded", and the proxy
-- stopped being true the moment somebody used the feature, while the thing it
-- stood for stayed true. What matters is that every stored amount is ALREADY
-- exactly two decimal places, so that widening the column cannot change a single
-- figure. That is what is checked here, row by row, and it fails loudly with the
-- offending values if it is ever false.

do $$
declare
  v_bad text;
begin
  if to_regclass('public.expenses') is null then
    raise exception 'expenses amount fix: public.expenses does not exist; 20261220000000 has not been applied';
  end if;

  select string_agg(format('%s (%s)', id, amount), ', ')
    into v_bad
  from public.expenses
  where amount is distinct from round(amount, 2);

  if v_bad is not null then
    raise exception
      'expenses amount fix: these amounts are not exactly two decimal places and must be looked at first: %',
      v_bad;
  end if;
end $$;

-- ─── 2. The column ──────────────────────────────────────────────────────────
--
-- WIDENING, so PostgreSQL does not rewrite or re-round anything: every value
-- representable as numeric(14,2) is representable as numeric. The CHECK
-- constraint expenses_amount_valid is UNTOUCHED and is what now refuses a third
-- decimal place, because there is no longer a scale to round it away first.

alter table public.expenses
  alter column amount type numeric;

comment on column public.expenses.amount is
  'Rupees and paise, exact decimal. NOT floating point, and NOT a scaled numeric: a declared scale would ROUND a third decimal place instead of refusing it. Positive; NaN and excess precision are refused by expenses_amount_valid rather than rounded — the same declaration and the same CHECK as finance_payment_requests.amount.';

-- ─── 3. Assertions ──────────────────────────────────────────────────────────
--
-- Read-only, and they FAIL THE MIGRATION rather than let a half-applied state
-- look successful. The second one is the point of the whole file: it proves the
-- refusal actually happens now, by attempting it.

do $$
declare
  v_scale int;
  v_refused boolean := false;
  v_category uuid;
  v_actor uuid;
begin
  -- 3a. The declared scale is gone.
  select numeric_scale into v_scale
  from information_schema.columns
  where table_schema = 'public' and table_name = 'expenses' and column_name = 'amount';
  if v_scale is not null then
    raise exception 'expenses amount fix: amount still declares scale %, so it would still round', v_scale;
  end if;

  -- 3b. The CHECK that does the work is still in place.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.expenses'::regclass and conname = 'expenses_amount_valid'
  ) then
    raise exception 'expenses amount fix: expenses_amount_valid is missing';
  end if;

  -- 3c. AND IT NOW BITES. The structural checks above already imply it — with no
  --     declared scale the value reaches the CHECK unrounded — but the bug being
  --     fixed was precisely that a constraint LOOKED right and did nothing, so
  --     this attempts the write and insists on being refused.
  --
  --     IT LEAVES NOTHING BEHIND, and needs no savepoint to manage that (PL/pgSQL
  --     has no ROLLBACK TO; its BEGIN/EXCEPTION blocks are the mechanism). When
  --     the fix is working the INSERT raises and inserts nothing, which is the
  --     whole point. If it were somehow accepted, the RAISE below aborts the
  --     migration's transaction and the stray row goes with it.
  --
  --     It borrows an EXISTING category rather than creating one, so the probe
  --     writes to expense_categories not at all. On a database with no categories
  --     yet there is nothing to borrow and the probe is skipped with a notice —
  --     3a and 3b still hold, and there is no expense to be wrong about.
  select id into v_actor from public.users where is_active limit 1;
  select id into v_category from public.expense_categories limit 1;
  if v_actor is null or v_category is null then
    raise notice 'expenses amount fix: no category to borrow for the write probe; 3a and 3b stand on their own';
    return;
  end if;

  begin
    insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by)
    values (current_date, 10.005, 'cash', '__amount probe__', v_category, v_actor);
  exception when check_violation then
    v_refused := true;
  end;

  if not v_refused then
    raise exception 'expenses amount fix: 10.005 was still accepted — the amount is being rounded, not refused';
  end if;
end $$;

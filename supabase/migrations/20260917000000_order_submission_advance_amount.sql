-- Order Management: the advance is DECLARED AS AN AMOUNT.
--
-- WHAT CHANGES
-- ------------
-- 20260913000000 asked the employee for a PERCENTAGE and derived the rupees.
-- That is the wrong way round for the business: what is negotiated with a client
-- and what will eventually be received is a FIGURE, and a percentage is what that
-- figure happens to come to. So the declaration is now:
--
--   Advance: 40% or above    a typed amount, at least 40% of the grand total and
--                            at most the grand total. The standard route. No
--                            exception, no decision, exactly as before.
--   Reduced advance: below   a typed amount above zero and below 40% of the
--   40%                      grand total, with a mandatory reason. The EXISTING
--                            exception workflow, unchanged.
--   No advance: 0%           a fixed zero, with a mandatory reason. The EXISTING
--                            exception workflow, unchanged.
--
-- The percentage is now DERIVED from the amount and the grand total, and is kept
-- for the exception routes because the applied predicate, the applied constraints
-- and every existing record are written in terms of it.
--
-- THE AMOUNT IS PRIMARY, AND CLASSIFICATION NEVER USES A ROUNDED PERCENTAGE.
-- Whether a declaration is standard or an exception is decided by comparing the
-- amount with grand_total * 40 / 100 directly. A percentage rounded for display
-- can reach 40.00 for an amount that is genuinely below the requirement, and
-- classifying on it would route a reduced advance down the standard path.
--
-- WHAT THIS IS NOT
-- ----------------
-- STILL NOT A PAYMENT, and the proof is still structural. There is no payment
-- column, no finance_payment_requests reference, no receipt, no allocation, no
-- verification of receipt and no reconciliation. Nothing here reads or writes a
-- Finance table. An amount declared is an amount SAID, by the employee, about
-- what the client has agreed — payment verification and linking are a separate
-- module and are not started here.
--
-- NOTHING APPLIED IS EDITED
-- -------------------------
-- 20260908000000 through 20260916000000 are untouched. This file is additive:
-- one new column, five new CHECK constraints, one new BEFORE trigger, three new
-- functions, one new implementation, one new PostgREST door, and ONE applied
-- function restated as a delegate (submit_order_submission_advance_internal), so
-- that there is still exactly ONE implementation of submitting a PI.
--
-- THE TWO APPLIED DOORS ARE NOT RESTATED AND DO NOT CHANGE.
-- submit_order_submission(uuid), submit_order_submission_with_note(uuid, text)
-- and submit_order_submission_with_advance(uuid, text, text, numeric, text) keep
-- their exact names, signatures, argument names, privileges and behaviour. An
-- old client and a cached PostgREST schema both keep working.
--
-- order_submission_advance_ready(text, numeric, text) IS NOT TOUCHED, so Phase C's
-- applied approve_order_submission() needs no restatement. It still reads:
--
--   ready  ⇔  'standard'  OR  an APPROVED exception below 40
--
-- and it still means what the phase needs it to mean, because the amount rules
-- below make 'standard' provably equivalent to "the declared amount is at least
-- 40% of the grand total":
--
--   * a standard declaration written by this file carries an amount, and the
--     CHECK refuses one below grand_total * 40 / 100;
--   * a standard declaration with NO amount is a record written before this file
--     (or one whose grand total was replaced afterwards), and it means exactly
--     what it always meant — the standard 40% of the CURRENT grand total, which
--     satisfies the requirement by definition;
--   * a grand total can only be replaced while the PI is draft or needs_changes,
--     and the trigger below clears the amount when that happens, so an amount and
--     the total it was measured against can never disagree on a submitted record.

-- ═══ 1. The declared amount ══════════════════════════════════════════════════
--
-- PLAIN `numeric`, NOT numeric(12,2), for the same reason 20260913000000 gave for
-- the percentage: a constrained scale would silently ROUND 1250.005 to 1250.01 and
-- store a figure the employee never typed. Plain numeric plus the scale CHECK in
-- section 2 REFUSES it instead, for every caller including direct SQL and the
-- service role.
--
-- NULLABLE, and NULL means "no amount was declared" — never zero. Zero is a
-- declaration ("No advance"), and conflating the two would turn every record
-- written before this file into a no-advance request nobody made.

alter table public.order_submissions
  add column advance_declared_amount numeric;

comment on column public.order_submissions.advance_declared_amount is
  'The advance AMOUNT the employee declared for this PI, in rupees, to two decimal places. At least grand_total * 40 / 100 under the standard condition and strictly below it under an exception. NULL means no amount was declared: a record written before this column existed, or one whose grand total was replaced afterwards. NULL is never zero — zero is the No advance declaration. Says nothing about payment: no money has been recorded, requested, verified or received.';

-- ═══ 2. What the persisted model may say ════════════════════════════════════
--
-- Table constraints, not RPC checks, so a direct UPDATE from psql and a write by
-- the service role are refused by exactly the same rules a browser is.

alter table public.order_submissions

  -- THE AMOUNT, IN FULL.
  --
  --   >= 0        zero is the No advance declaration.
  --   = round(,2) rupees and paise. Excessive precision is REFUSED, never
  --               rounded into a figure the employee did not type.
  --   <> NaN      numeric accepts 'NaN', and NaN sorts ABOVE every real number,
  --               so the range test alone would already refuse it. Stated
  --               anyway, because a reader should not have to know that.
  add constraint order_submissions_advance_amount_valid check (
    advance_declared_amount is null
    or (
      advance_declared_amount <> 'NaN'::numeric
      and advance_declared_amount >= 0
      and advance_declared_amount = round(advance_declared_amount, 2)
    )
  ),

  -- AN AMOUNT IS A DECLARATION ABOUT A TOTAL. Neither half may be missing.
  add constraint order_submissions_advance_amount_needs_declaration check (
    advance_declared_amount is null
    or (advance_condition is not null and grand_total is not null)
  ),

  -- NOBODY DECLARES MORE THAN THE ORDER IS WORTH.
  add constraint order_submissions_advance_amount_within_total check (
    advance_declared_amount is null or advance_declared_amount <= grand_total
  ),

  -- THE AMOUNT AND THE CONDITION SAY THE SAME THING.
  --
  -- The literal 40 is written out rather than calling
  -- order_submission_standard_advance_percent(), for the reason 20260913000000
  -- already recorded: a CHECK is not re-validated when a function it calls is
  -- replaced, and a constraint that could silently stop meaning what it says is
  -- worse than a duplicated number. The assertions at the foot prove they agree.
  --
  -- `grand_total * 40 / 100` and NOT a rounded percentage. numeric is exact, so
  -- this is the true 40% of the total to full precision, and an amount one paisa
  -- below it is an exception — which is the whole point.
  add constraint order_submissions_advance_amount_matches_condition check (
    advance_declared_amount is null
    or (advance_condition = 'standard'  and advance_declared_amount >= grand_total * 40 / 100)
    or (advance_condition = 'exception' and advance_declared_amount <  grand_total * 40 / 100)
  ),

  -- ZERO RUPEES IS ZERO PERCENT.
  --
  -- "No advance" is the one declaration whose meaning a reviewer reads straight
  -- off the figure, so a record may not store ₹0 beside a percentage claiming
  -- something was asked for. Under 'exception' the percentage is already NOT NULL
  -- by order_submissions_advance_exception_is_complete, so this is total.
  --
  -- ONE DIRECTION ONLY, and deliberately. The converse — zero percent implies
  -- zero rupees — is NOT true and must not be asserted: ₹5.00 against a grand
  -- total of ₹10,00,000 is 0.0005%, which truncates to 0.00 at two decimal
  -- places while remaining a real, positive, declared advance. The screens name
  -- that record by its AMOUNT, which is the fact that was declared, and never by
  -- a percentage rounded past the point where it still says anything.
  add constraint order_submissions_advance_amount_zero_is_zero_percent check (
    advance_declared_amount is null
    or advance_condition is distinct from 'exception'
    or advance_declared_amount <> 0
    or advance_exception_percent = 0
  );

-- ═══ 3. An amount and the total it was measured against cannot disagree ═════
--
-- THE PROBLEM 20260913000000 NAMED, ANSWERED. That file stored no rupee figure
-- precisely because "it would create a second fact that could disagree with the
-- first the moment a corrected PI changed the total, and there would be no way to
-- tell which one the business meant". The business now needs the amount to be the
-- first fact, so the disagreement is prevented instead of avoided:
--
--   when grand_total changes, the declared amount is CLEARED.
--
-- replace_order_submission_parse() — the only writer of grand_total, service role
-- only, and reachable only while the PI is draft or needs_changes — is NOT
-- restated for this. A BEFORE ROW trigger runs before CHECK constraints are
-- evaluated, so the row that reaches section 2 is already consistent, whatever
-- statement produced it.
--
-- WHAT THE CLEARED RECORD THEN MEANS is exactly what a pre-Phase-B record means:
-- a condition with no amount, read as the standard 40% of the total it now has.
-- The PI must be resubmitted anyway — a replaced parse leaves it in draft or
-- needs_changes — and resubmitting writes a fresh amount against the fresh total.
--
-- IT DOES NOT FIRE WHEN THE STATEMENT IS ITSELF WRITING AN AMOUNT. A caller that
-- sets both in one UPDATE is stating a new amount against a new total, which is
-- coherent; the constraints in section 2 judge it on its merits.

create or replace function public.order_submissions_advance_amount_follows_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.grand_total is distinct from old.grand_total
     and new.advance_declared_amount is not distinct from old.advance_declared_amount then
    new.advance_declared_amount := null;
  end if;
  return new;
end;
$$;

comment on function public.order_submissions_advance_amount_follows_total() is
  'Clears order_submissions.advance_declared_amount whenever grand_total is replaced without a new amount being written in the same statement, so a declared advance can never survive the total it was measured against. Executable by no role: reached only as a trigger.';

revoke execute on function public.order_submissions_advance_amount_follows_total()
  from public, anon, authenticated, service_role;

-- NAME ORDER. Triggers of the same timing fire in NAME order, and this sorts
-- first of the five on this table:
--
--   order_submissions_advance_amount_follows_total   this one
--   order_submissions_enforce_status_transition      the status graph
--   order_submissions_guard_advance_exception        the declaration guard
--   order_submissions_guard_frozen_columns           the creation record
--   order_submissions_set_updated_at                 the stamp
--
-- which is harmless: it only ever nulls a column none of the other four reads,
-- and CHECK constraints are evaluated after all of them regardless.
drop trigger if exists order_submissions_advance_amount_follows_total on public.order_submissions;
create trigger order_submissions_advance_amount_follows_total
  before update on public.order_submissions
  for each row execute function public.order_submissions_advance_amount_follows_total();

-- ═══ 4. The three derivations ═══════════════════════════════════════════════

-- The smallest amount that MEETS the standard requirement, in whole paise.
--
-- CEILING, NOT ROUNDING, and the difference matters. 40% of ₹100.01 is ₹40.004,
-- which is not an amount anybody can pay; rounding it gives ₹40.00, which is
-- BELOW the requirement and which this file's own constraint would then refuse.
-- The ceiling gives ₹40.01 — the smallest real figure that actually satisfies
-- "at least 40%" — so the amount offered to the employee as the default is
-- always a figure the database will accept.
--
-- `ceil(p_grand_total * 40) / 100` and not `ceil(p_grand_total * 40 / 100 * 100)`:
-- the two are equal and the first does not depend on numeric's division scale.
create or replace function public.order_submission_standard_advance_amount(
  p_grand_total numeric
)
returns numeric
language sql
immutable
parallel safe
as $$
  select case
    when p_grand_total is null then null
    when p_grand_total = 'NaN'::numeric then null
    when p_grand_total < 0 then null
    -- round() only trims the scale numeric division leaves behind: ceil() has
    -- already made this an exact whole-paise figure, so no value moves.
    else round(ceil(p_grand_total * 40) / 100, 2)
  end
$$;

comment on function public.order_submission_standard_advance_amount(numeric) is
  'The smallest whole-paise amount that satisfies the standard 40% advance requirement against a grand total: ceil(grand_total * 40) / 100. Rounded UP, so the figure offered as the default is never a paisa below the requirement it is meant to meet. Derived; says nothing about payment.';

revoke execute on function public.order_submission_standard_advance_amount(numeric) from public, anon;
grant  execute on function public.order_submission_standard_advance_amount(numeric) to authenticated;

-- The percentage an amount comes to, TRUNCATED to two decimal places.
--
-- TRUNCATED AND NEVER ROUNDED, for one reason: an amount of ₹39,999.99 against a
-- grand total of ₹1,00,000 is 39.99999%, which ROUNDS to 40.00 — a figure that
-- would claim the standard requirement is met, contradict the amount beside it,
-- and violate the applied constraint that an exception percentage is strictly
-- below 40. Truncation cannot overstate, so the derived figure can never say the
-- requirement is met when the amount says it is not.
--
-- NULL, never a guess, for an absent, NaN or non-positive total: a percentage OF
-- nothing is not a number, and 0/0 is not 0%.
create or replace function public.order_submission_advance_percent_of(
  p_grand_total numeric,
  p_amount      numeric
)
returns numeric
language sql
immutable
parallel safe
as $$
  select case
    when p_grand_total is null or p_amount is null then null
    when p_grand_total = 'NaN'::numeric or p_amount = 'NaN'::numeric then null
    when p_grand_total <= 0 then null
    else trunc(p_amount * 100 / p_grand_total, 2)
  end
$$;

comment on function public.order_submission_advance_percent_of(numeric, numeric) is
  'The percentage of a grand total an advance amount comes to, truncated — never rounded — to two decimal places, so a figure below the standard requirement can never be displayed or stored as meeting it. NULL for an absent, NaN or non-positive total.';

revoke execute on function public.order_submission_advance_percent_of(numeric, numeric) from public, anon;
grant  execute on function public.order_submission_advance_percent_of(numeric, numeric) to authenticated;

-- The advance a record actually carries, whether or not it stores an amount.
--
-- THE ONE COMPATIBILITY RULE, IN ONE PLACE, so no screen and no server path can
-- word it differently:
--
--   an amount is stored          →  that amount, exactly as declared
--   'standard' with no amount    →  the standard 40% of the current grand total
--                                   — what the record has always meant
--   'exception' with no amount   →  the stored percentage of the current grand
--                                   total — what the record has always meant
--   nothing declared             →  NULL
--
-- ONE FIGURE FOR THE STANDARD CONDITION, EVERYWHERE. The fallback is the same
-- order_submission_standard_advance_amount() the dialog pre-fills and the same
-- one the constraint is measured against, so a record that stores no amount and
-- one that stores the default cannot print a paisa apart from each other.
create or replace function public.order_submission_effective_advance_amount(
  p_advance_condition       text,
  p_advance_declared_amount numeric,
  p_advance_percent         numeric,
  p_grand_total             numeric
)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p_advance_declared_amount is not null then p_advance_declared_amount
    when p_advance_condition = 'standard' then
      public.order_submission_standard_advance_amount(p_grand_total)
    when p_advance_condition = 'exception' then
      public.order_submission_advance_amount(p_grand_total, p_advance_percent)
    else null
  end
$$;

comment on function public.order_submission_effective_advance_amount(text, numeric, numeric, numeric) is
  'The advance amount a submission carries: the declared amount when it stores one, otherwise the figure the record has always meant — the standard 40% of the grand total under the standard condition, or the stored percentage of it under an exception. NULL when nothing was declared. The single compatibility rule for records written before advance_declared_amount existed.';

revoke execute on function public.order_submission_effective_advance_amount(text, numeric, numeric, numeric) from public, anon;
grant  execute on function public.order_submission_effective_advance_amount(text, numeric, numeric, numeric) to authenticated;

-- ═══ 5. Submitting, with a declared amount ══════════════════════════════════
--
-- ONE IMPLEMENTATION, FOUR DOORS — the arrangement 20260911000000 established and
-- 20260913000000 extended, extended once more rather than replaced.
--
--   submit_order_submission(uuid)                        unchanged, authenticated
--   submit_order_submission_with_note(uuid, text)         unchanged, authenticated
--   submit_order_submission_with_advance(...)             unchanged, authenticated
--   submit_order_submission_with_advance_amount(...)      NEW,       authenticated
--   submit_order_submission_internal(uuid, text)          unchanged delegate
--   submit_order_submission_advance_internal(...)         becomes a delegate
--   submit_order_submission_advance_v2_internal(...)      the implementation
--
-- SEPARATE NAMES, NOT AN OVERLOAD. PostgREST resolves a function by the argument
-- names in the request body, so two functions sharing a name would be picked
-- apart by which keys a caller happened to send.
--
-- p_declare_mode, and what each value means, PRECISELY:
--
--   'none'     leave the advance declaration on the record EXACTLY as it is. It
--              does not clear an approved exception, does not invent a standard
--              declaration, and cannot turn a rejected exception into a ready one.
--   'amount'   p_advance_value is the declared AMOUNT in rupees. The new door.
--   'percent'  p_advance_value is a proposed PERCENTAGE. The compatibility path
--              for the applied door, byte-for-byte the behaviour 20260913000000
--              shipped, plus clearing advance_declared_amount so a stored amount
--              can never contradict a percentage declared over the top of it.

create or replace function public.submit_order_submission_advance_v2_internal(
  p_submission_id     uuid,
  p_note              text,
  p_declare_mode      text,
  p_advance_condition text,
  p_advance_value     numeric,
  p_advance_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_item_count integer;
  v_incomplete integer;
  v_bad        integer;
  v_bad_row    integer;
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
  v_mode       text := nullif(btrim(lower(coalesce(p_declare_mode, ''))), '');
  -- Trimmed and folded, so "  Standard  " and "standard" are the same choice and
  -- a reason of pure whitespace is indistinguishable from no reason at all.
  v_condition  text := nullif(btrim(lower(coalesce(p_advance_condition, ''))), '');
  v_reason     text := nullif(btrim(coalesce(p_advance_reason, '')), '');
  v_percent    numeric;
  v_amount     numeric;
  v_threshold  numeric;
  v_standard   numeric := public.order_submission_standard_advance_percent();
  v_declare    boolean;
  v_effective  numeric;
  v_metaamount numeric;
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_advance    jsonb   := '{}'::jsonb;
begin
  if v_mode is null or v_mode not in ('none', 'amount', 'percent') then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_MODE_INVALID: an advance is declared by amount or by percentage, or not at all'
      using errcode = 'P0001';
  end if;
  v_declare := v_mode <> 'none';

  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to submit an order submission'
      using errcode = '42501';
  end if;

  if v_note is not null and char_length(v_note) > 1000 then
    raise exception
      'ORDER_SUBMISSION_NOTE_TOO_LONG: a reply may be at most 1000 characters (this one is %)',
      char_length(v_note)
      using errcode = 'P0001';
  end if;

  -- ── The declaration's SHAPE, before the row is locked ──
  --
  -- Every one of these is the caller's own mistake and needs nothing from the
  -- record, so refusing early costs the database nothing and holds no lock. The
  -- rules that need the grand total wait until section "FIT", below.
  if v_declare then
    if v_condition is null or v_condition not in ('standard', 'exception') then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: choose the standard advance requirement or request an exception'
        using errcode = 'P0001';
    end if;

    -- A REASON BELONGS TO AN EXCEPTION AND TO NOTHING ELSE, on both paths. A
    -- reason arriving with a standard declaration means the caller has sent two
    -- different answers, and guessing which one they meant is not this
    -- function's job. (The percentage path refuses a percentage here as well,
    -- below; the amount path takes an amount on both routes, so the amount is
    -- not a contradiction there.)
    if v_condition = 'standard' and v_mode = 'amount' and v_reason is not null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: the standard advance requirement carries no reason'
        using errcode = 'P0001';
    end if;

    if v_condition = 'exception' then
      if v_reason is null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_REASON_REQUIRED: say why a lower advance is being proposed'
          using errcode = 'P0001';
      end if;
      if char_length(v_reason) > 1000 then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
          char_length(v_reason)
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  if v_mode = 'amount' then
    if p_advance_value is null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: enter the advance amount being declared'
        using errcode = 'P0001';
    end if;
    -- NaN first, and by name: it compares ABOVE every real number, so leaving it
    -- to the range test would refuse it with a message about being too high.
    if p_advance_value = 'NaN'::numeric then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: the advance amount is not a number'
        using errcode = 'P0001';
    end if;
    if p_advance_value < 0 then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: the advance amount cannot be negative'
        using errcode = 'P0001';
    end if;
    if p_advance_value <> round(p_advance_value, 2) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: the advance amount may have at most two decimal places'
        using errcode = 'P0001';
    end if;
    v_amount := p_advance_value;

  elsif v_mode = 'percent' then
    v_percent := p_advance_value;

    if v_condition = 'standard' then
      -- The standard requirement, declared the OLD way, is exactly the configured
      -- rule. A percentage or a reason arriving with it means the caller has sent
      -- two different answers, and guessing which one they meant is not this
      -- function's job.
      if p_advance_value is not null or v_reason is not null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: the standard advance requirement carries no percentage and no reason'
          using errcode = 'P0001';
      end if;
    else
      if v_percent is null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: enter the advance percentage being proposed'
          using errcode = 'P0001';
      end if;
      if v_percent = 'NaN'::numeric then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: the advance percentage is not a number'
          using errcode = 'P0001';
      end if;
      if v_percent < 0 or v_percent >= v_standard then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: an exception must be at least 0%% and below the standard %%%',
          v_standard
          using errcode = 'P0001';
      end if;
      if v_percent <> round(v_percent, 2) then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: the advance percentage may have at most two decimal places'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if not public.can_edit_order_submission(p_submission_id) then
    raise exception 'This order submission cannot be submitted by you in its current state'
      using errcode = '42501';
  end if;

  -- ── The declaration's FIT with this record ──
  if v_declare then
    -- FAIL CLOSED ON AN UNKNOWN AMOUNT. Nobody may declare an advance against a
    -- total the record does not have; the same rule is a table constraint, so
    -- this is the readable half of a refusal that happens either way.
    if v_sub.grand_total is null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored grand total, so an advance requirement cannot be declared against it'
        using errcode = 'P0001';
    end if;

    -- ONLY THE OWNER MAY PROPOSE AN EXCEPTION. can_edit_order_submission admits
    -- an active admin as well, which is right for correcting a record and wrong
    -- for asking the business a commercial question in somebody else's name.
    if v_condition = 'exception'
       and not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_OWNER: only the owner of this PI may request an advance exception'
        using errcode = '42501';
    end if;
  end if;

  if v_mode = 'amount' then
    -- THE CLASSIFICATION, AGAINST THE AMOUNT AND NEVER AGAINST A ROUNDED
    -- PERCENTAGE. v_threshold is the smallest whole-paise figure that satisfies
    -- the standard requirement, so for an amount already proved to be whole
    -- paise, "at or above v_threshold" and "at least grand_total * 40 / 100" are
    -- the same statement — which is what the table constraint enforces.
    v_threshold := public.order_submission_standard_advance_amount(v_sub.grand_total);

    if v_amount > v_sub.grand_total then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_ABOVE_TOTAL: the advance cannot exceed the grand total of %',
        v_sub.grand_total
        using errcode = 'P0001';
    end if;

    if v_condition = 'standard' then
      if v_amount < v_threshold then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_AMOUNT_BELOW_STANDARD: the standard advance requires at least % — request a reduced advance to declare less',
          v_threshold
          using errcode = 'P0001';
      end if;
      -- The percentage the declared amount comes to. NULL only for a zero total,
      -- where the standard requirement is itself zero and no percentage exists.
      v_percent := public.order_submission_advance_percent_of(v_sub.grand_total, v_amount);
    else
      -- An exception is a percentage OF something, and a zero or absent total
      -- gives nothing to take a percentage of. Refused by name rather than as a
      -- range failure against two zeroes.
      if v_sub.grand_total <= 0 then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no positive grand total, so an advance exception cannot be declared against it'
          using errcode = 'P0001';
      end if;
      if v_amount >= v_threshold then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_AMOUNT_NOT_REDUCED: a reduced advance must be below the standard requirement of %',
          v_threshold
          using errcode = 'P0001';
      end if;
      -- Truncated, so a figure below the requirement can never be stored as 40.
      -- Zero rupees is zero percent exactly, with no division involved.
      v_percent := case
        when v_amount = 0 then 0
        else public.order_submission_advance_percent_of(v_sub.grand_total, v_amount)
      end;
    end if;
  end if;

  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) must be fixed in the workbook before this can be submitted',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_name), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  -- ── The workbook: shape, then existence, then type ──
  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: no file exists in order-files at the recorded workbook path'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX: the stored workbook is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_incomplete
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_incomplete > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_incomplete
      using errcode = 'P0001';
  end if;

  -- ── Exactly one representative image per product line ──
  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── Every recorded image: the key must name THIS submission, THIS item, its
  --    own role and its own position ──
  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  -- ── Every recorded image: a real object, of a real image type ──
  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── The write ──
  --
  -- ONE STATEMENT ON EVERY PATH, so the status and the advance declaration land
  -- together or not at all. review_note is cleared exactly as the applied
  -- migrations established: management's outstanding request has been answered.

  if v_mode = 'none' then
    -- Nothing was declared, so nothing about the advance moves. Whatever the
    -- record already carried it still carries.
    update public.order_submissions
       set status = 'submitted',
           review_note = null
     where id = p_submission_id;

  elsif v_condition = 'standard' then
    -- MOVING TO THE STRICTER CHOICE NEEDS NO APPROVAL, and it clears the whole
    -- actionable exception state from the row. The permanent record of what was
    -- once asked for, and what was decided, stays in the append-only trail —
    -- nothing there is deleted or rewritten.
    --
    -- v_amount is NULL on the 'percent' path, which is the declaration the
    -- applied door has always made: the standard requirement, with no typed
    -- figure. Writing it explicitly also clears any amount left by a previous
    -- declaration, so the row cannot carry a figure its condition disagrees with.
    v_effective  := coalesce(v_percent, v_standard);
    v_metaamount := coalesce(
      v_amount, public.order_submission_advance_amount(v_sub.grand_total, v_standard));

    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           advance_condition = 'standard',
           advance_declared_amount = v_amount,
           advance_exception_percent = null,
           advance_exception_reason = null,
           advance_exception_status = null,
           advance_exception_requested_by = null,
           advance_exception_requested_at = null,
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null
     where id = p_submission_id;

  else
    v_effective  := v_percent;
    v_metaamount := coalesce(
      v_amount, public.order_submission_advance_amount(v_sub.grand_total, v_percent));

    -- AN APPROVED EXCEPTION SURVIVES A RESUBMISSION THAT DOES NOT CHANGE IT.
    --
    -- A PI returned for an unrelated correction comes back with the same proposal
    -- the business already accepted, and asking management to accept it a second
    -- time would be make-work. Anything else — a different figure, different
    -- words, a move from standard, a previously rejected or pending request —
    -- becomes a FRESH pending decision with fresh requester and time and cleared
    -- decision fields.
    --
    -- ON THE AMOUNT PATH THE COMPARISON IS THE AMOUNT, because the amount is what
    -- was declared. order_submission_effective_advance_amount reads the stored
    -- record the one way this file defines, so an approved exception written
    -- before this column existed is recognised as unchanged when the same rupee
    -- figure is declared over it.
    --
    -- Numeric equality is by VALUE, so 5 and 5.00 are the same proposal.
    if v_mode = 'amount' then
      -- BOTH FIGURES MUST MATCH, not just the rupees. A stored percentage that
      -- does not derive from the amount now being declared is a DIFFERENT
      -- proposal however similar the two look, and keeping the old decision over
      -- it would leave the row saying two things at once.
      v_keep := coalesce(
        v_sub.advance_condition = 'exception'
        and v_sub.advance_exception_status = 'approved'
        and public.order_submission_effective_advance_amount(
              v_sub.advance_condition, v_sub.advance_declared_amount,
              v_sub.advance_exception_percent, v_sub.grand_total) = v_amount
        and v_sub.advance_exception_percent = v_percent
        and v_sub.advance_exception_reason is not distinct from v_reason,
        false
      );
    else
      v_keep := coalesce(
        v_sub.advance_condition = 'exception'
        and v_sub.advance_exception_status = 'approved'
        and v_sub.advance_exception_percent = v_percent
        and v_sub.advance_exception_reason is not distinct from v_reason,
        false
      );
    end if;

    if v_keep then
      -- The decision stands and the proposal is unchanged, so the only thing
      -- written is the amount the record was always worth — never on the
      -- 'percent' path, which declares no amount and must not invent one.
      update public.order_submissions
         set status = 'submitted',
             review_note = null,
             advance_declared_amount = case when v_mode = 'amount'
                                            then v_amount
                                            else advance_declared_amount end
       where id = p_submission_id;
    else
      update public.order_submissions
         set status = 'submitted',
             review_note = null,
             advance_condition = 'exception',
             advance_declared_amount = v_amount,
             advance_exception_percent = v_percent,
             advance_exception_reason = v_reason,
             advance_exception_status = 'pending',
             advance_exception_requested_by = v_actor,
             advance_exception_requested_at = now(),
             advance_exception_decided_by = null,
             advance_exception_decided_at = null,
             advance_exception_rejection_reason = null
       where id = p_submission_id;
      v_requested := true;
    end if;
  end if;

  -- submitted_at is stamped by the status transition trigger (20260910000000)
  -- and by nothing here.

  if v_declare then
    -- THE SAME KEYS 20260913000000 WROTE, so the activity trail renders every
    -- event ever logged with one reader. advance_amount is now the DECLARED
    -- figure when there is one, and the derived figure when there is not.
    v_advance := jsonb_build_object(
      'advance_condition', v_condition,
      'advance_percent',   v_effective,
      'standard_percent',  v_standard,
      'grand_total',       v_sub.grand_total,
      'advance_amount',    v_metaamount,
      'advance_declared',  v_mode = 'amount'
    );
  end if;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
      || v_advance
  );

  -- The exception request is its OWN event, separate from the submission, so a
  -- reader can see the proposal without reading the submission's bookkeeping.
  if v_requested then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'advance_exception_requested', v_sub.status, 'submitted', v_reason,
      v_advance || jsonb_build_object('exception_status', 'pending')
    );
  end if;

  -- The established return shape, unchanged, so all four doors answer exactly
  -- what the first one always answered.
  return jsonb_build_object('id', p_submission_id, 'status', 'submitted', 'item_count', v_item_count);
end;
$$;

revoke execute on function public.submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text) is
  'The single implementation of submitting a PI for review, with an optional employee reply and an optional advance declaration made either as an amount or, for the applied door, as a percentage. Executable by no role: reached only by the wrappers, as their definer.';

-- ── 5a. The applied implementation, now a delegate ──────────────────────────
--
-- IDENTICAL NAME, SIGNATURE, ARGUMENT NAMES, RETURN SHAPE AND PRIVILEGES. Its
-- two callers — submit_order_submission_internal(uuid, text) and
-- submit_order_submission_with_advance(uuid, text, text, numeric, text) — are not
-- restated at all and do not change: they call this, and this now calls the one
-- implementation with the percentage path selected.

create or replace function public.submit_order_submission_advance_internal(
  p_submission_id     uuid,
  p_note              text,
  p_declare_advance   boolean,
  p_advance_condition text,
  p_advance_percent   numeric,
  p_advance_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.submit_order_submission_advance_v2_internal(
    p_submission_id,
    p_note,
    case when coalesce(p_declare_advance, false) then 'percent' else 'none' end,
    p_advance_condition,
    p_advance_percent,
    p_advance_reason);
end;
$$;

revoke execute on function public.submit_order_submission_advance_internal(uuid, text, boolean, text, numeric, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_order_submission_advance_internal(uuid, text, boolean, text, numeric, text) is
  'Submits a PI with an optional employee reply and an optional advance declaration expressed as a PERCENTAGE. A one-line delegate to submit_order_submission_advance_v2_internal, so there is still exactly one implementation of submitting. Executable by no role.';

-- ── 5b. The new door ────────────────────────────────────────────────────────
--
-- Identical authority to the other three — the same implementation underneath —
-- differing only in carrying the declared AMOUNT.

create or replace function public.submit_order_submission_with_advance_amount(
  p_submission_id     uuid,
  p_note              text,
  p_advance_condition text,
  p_advance_amount    numeric,
  p_advance_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.submit_order_submission_advance_v2_internal(
    p_submission_id, p_note, 'amount', p_advance_condition, p_advance_amount, p_advance_reason);
end;
$$;

revoke execute on function public.submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)
  from public, anon;
grant  execute on function public.submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)
  to authenticated;

comment on function public.submit_order_submission_with_advance_amount(uuid, text, text, numeric, text) is
  'Submits a PI for review under a declared advance AMOUNT in rupees: ''standard'' for an amount of at least 40% of the grand total and at most the grand total, or ''exception'' with an amount below 40% — zero included — and a mandatory reason. The percentage is derived and truncated, never rounded up. Only the owner may propose an exception, a missing grand total fails closed, and no payment is created, requested, verified or implied.';

-- ═══ 6. Assertions ══════════════════════════════════════════════════════════
--
-- Everything below runs inside the migration's transaction and rolls back with
-- it. A failure here fails the migration.

do $$
declare
  v_amount  numeric;
  v_percent numeric;
begin
  -- The duplicated 40 in the CHECK agrees with the configured rule.
  if public.order_submission_standard_advance_percent() <> 40 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_AMOUNT_UNSAFE: the standard advance percent is no longer 40, so the literal 40 written into order_submissions_advance_amount_matches_condition no longer means what it says';
  end if;

  -- The ceiling never lands below the requirement, and never more than a paisa
  -- above it.
  for v_amount in select unnest(array[0, 1, 100.01, 100.02, 100.03, 100.04, 100.05, 253700, 999999.99]::numeric[]) loop
    if public.order_submission_standard_advance_amount(v_amount) < v_amount * 40 / 100 then
      raise exception 'the standard advance amount for % is below 40%% of it', v_amount;
    end if;
    if public.order_submission_standard_advance_amount(v_amount) - v_amount * 40 / 100 >= 0.01 then
      raise exception 'the standard advance amount for % overshoots 40%% by a paisa or more', v_amount;
    end if;
  end loop;

  if public.order_submission_standard_advance_amount(100.01) <> 40.01 then
    raise exception 'the standard advance amount of 100.01 should be 40.01';
  end if;
  if public.order_submission_standard_advance_amount(2537000) <> 1014800 then
    raise exception 'the standard advance amount of 2537000 should be 1014800';
  end if;
  if public.order_submission_standard_advance_amount(null) is not null
     or public.order_submission_standard_advance_amount('NaN'::numeric) is not null then
    raise exception 'the standard advance amount of an unknown total should be null';
  end if;

  -- The derived percentage TRUNCATES: the one case that would otherwise claim
  -- the standard requirement is met by an amount that does not meet it.
  v_percent := public.order_submission_advance_percent_of(100000, 39999.99);
  if v_percent <> 39.99 then
    raise exception 'a 39.99999%% advance should truncate to 39.99, not %', v_percent;
  end if;
  if v_percent >= public.order_submission_standard_advance_percent() then
    raise exception 'a truncated percentage below the standard must stay below it';
  end if;
  if public.order_submission_advance_percent_of(2537000, 1014800) <> 40 then
    raise exception 'an exact 40%% amount should derive 40';
  end if;
  if public.order_submission_advance_percent_of(0, 0) is not null
     or public.order_submission_advance_percent_of(null, 10) is not null
     or public.order_submission_advance_percent_of(100, null) is not null then
    raise exception 'a percentage of an absent or zero total should be null';
  end if;

  -- The compatibility reading: a declared amount wins, and a record without one
  -- still means what it always meant.
  if public.order_submission_effective_advance_amount('standard', 1200000, null, 2537000) <> 1200000 then
    raise exception 'a declared amount should be reported as declared';
  end if;
  if public.order_submission_effective_advance_amount('standard', null, null, 2537000) <> 1014800 then
    raise exception 'a standard record with no amount should read as 40%% of its total';
  end if;
  if public.order_submission_effective_advance_amount('exception', null, 12.5, 2537000) <> 317125 then
    raise exception 'an exception record with no amount should read as its percentage of its total';
  end if;
  if public.order_submission_effective_advance_amount(null, null, null, 2537000) is not null then
    raise exception 'an undeclared record carries no advance amount';
  end if;

  -- A positive amount that truncates to 0.00% is a real declaration, and the
  -- constraint above is one-directional so it can be stored.
  if public.order_submission_advance_percent_of(1000000, 5) <> 0 then
    raise exception 'a 0.0005%% advance should truncate to 0';
  end if;

  -- Phase C's predicate is untouched and still answers what this file relies on.
  if not public.order_submission_advance_ready('standard', null, null) then
    raise exception 'a standard declaration must remain advance-ready';
  end if;
  if not public.order_submission_advance_ready('exception', 39.99, 'approved') then
    raise exception 'an approved exception below the standard must remain advance-ready';
  end if;
  if public.order_submission_advance_ready('exception', 12.5, 'pending') then
    raise exception 'a pending exception must not be advance-ready';
  end if;
end $$;

-- Nothing in this file may reach a payment. Proved by reading the file's own
-- installed definitions rather than by asserting it in a comment.
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'order_submission_standard_advance_amount',
      'order_submission_advance_percent_of',
      'order_submission_effective_advance_amount',
      'submit_order_submission_advance_v2_internal',
      'submit_order_submission_with_advance_amount',
      'order_submissions_advance_amount_follows_total'
    )
    and pg_get_functiondef(p.oid) ~* '(finance_payment|payment_request|payment_allocation|received_advance|\mpayments\M)';

  if v_bad is not null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_AMOUNT_UNSAFE: % reference(s) a payment table, which this phase must not', v_bad;
  end if;
end $$;

-- The applied doors still exist, with their exact signatures.
do $$
begin
  if to_regprocedure('public.submit_order_submission_with_advance(uuid, text, text, numeric, text)') is null
     or to_regprocedure('public.submit_order_submission_internal(uuid, text)') is null
     or to_regprocedure('public.submit_order_submission(uuid)') is null
     or to_regprocedure('public.submit_order_submission_with_note(uuid, text)') is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_AMOUNT_UNSAFE: an applied submit door is missing after this migration';
  end if;
end $$;

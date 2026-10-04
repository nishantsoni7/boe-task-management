-- ═══════════════════════════════════════════════════════════════════════════
-- 20270227000000  THE ADVANCE IS A PERCENTAGE OF THE TOTAL BEFORE GST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE RULE (agreed with the business, replacing "40% of the Grand Total"):
--
--   Subtotal            = Product value - Discount
--   Total before GST    = Subtotal + Fabric + Packaging + quoted Transportation
--                         ("as applicable" wording adds nothing)
--   Grand Total         = Total before GST + GST
--   Advance %           = VERIFIED advance / Total before GST x 100
--   Required 40% advance = 40% of Total before GST
--
--   Worked example: total before GST 1,20,000, GST 21,600, Grand Total
--   1,41,600, verified 48,000 -> exactly 40.00%, required 48,000, shortfall 0.
--   Until now the database divided by the Grand Total (required 56,640).
--
-- THE FIGURE. The PI stores the workbook's own pre-GST total in
-- order_submissions.total_before_gst (it already includes fabric, packaging and
-- the quoted transportation amount). Nothing here recomputes it. An ORDER stores
-- only total_value (= the Grand Total) and is re-valued by PI revisions
-- (value_epoch), so its base is DERIVED ON READ, never stored, never back-filled:
-- order_advance_base(order_id) takes the in-force approved PI version's staged
-- parse (commercial.total_before_gst) when that version's grand_total is the
-- Order's total_value, else the source PI's total_before_gst when ITS grand_total
-- is the Order's total_value, else NULL. order_total_before_gst(orders) exposes
-- the same scalar to a signed-in reader (and to PostgREST as a computed column).
-- No existing row is written by this migration.
--
-- WHAT STAYS EXACTLY AS IT WAS: the 40 itself, the rounding rules (required =
-- base x 40 / 100 exact; shortfall rounded UP to the paisa; suggested standard
-- amount = ceiling to the paisa), "only finance-verified allocations count"
-- (finance_payment_status_is_verified), permissions, administrator approval,
-- the advance-exception workflow, every grant / revoke / security attribute /
-- search_path of every function below (CREATE OR REPLACE keeps the ACL).
--
-- A MISSING BASE NEVER PASSES. NULL, zero, NaN and negative bases are explicit
-- everywhere: percent NULL (never 0/0, NaN or Infinity), required NULL,
-- shortfall NULL, payment_ready false, and the doors refuse in words:
--   * approve_order_submission, approve_pi_advance_exception,
--     submit_pi_for_review_internal and submit_order_submission_advance_v2_internal
--     refuse a PI that has a grand total but no usable total before GST, in the
--     style they already refuse a missing grand total
--     (ORDER_SUBMISSION_INCOMPLETE / ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING);
--   * order_advance_position() reports value_known = false, percent / required /
--     shortfall NULL, below = true, ready = false -- unless an administrator's
--     explicit Order-level exception stands (exactly how an Order with no value
--     was already treated: that approval is the one thing that may proceed).
--
-- THE JSON. Key names TypeScript already reads are unchanged; their numbers now
-- use the pre-GST base. ADDED: advance_base everywhere a percentage is drawn,
-- total_before_gst beside it on PI-shaped objects, order_value_known on the
-- Order position. NOTE value_known on the Order position now means "the advance
-- BASE is known" (it is what every reader already uses to decide whether a
-- percentage can be shown).
--
-- EXISTING EXCEPTIONS AND DECISIONS (the safest reading, chosen deliberately):
--   * advance_exception_decided_grand_total keeps its job: an IDENTITY check
--     ("have the figures changed since the administrator decided?"), still on
--     grand_total, the workbook hash and the terms. The pre-GST total is read
--     from that same workbook, so it cannot move without one of them moving.
--     No decided_total_before_gst column is added: it would make every approved
--     exception in flight "stale" at deploy and force a second decision on
--     figures that did not change.
--   * advance_exception_decided_verified is a RUPEE floor (money verified when
--     the administrator decided). It is unaffected and still voids a PI
--     exception when verified money falls under it.
--   * order_pi_exception_floor() is NOT changed: its percentage fallback (only
--     for decisions taken before decided_verified existed) was decided on the
--     OLD basis and keeps its old reading (percent x Grand Total), which is the
--     stricter floor. New decisions always carry decided_verified.
--   * An approved exception authorises conversion at ANY payment level, so a
--     decision made on the old basis can never approve more than the
--     administrator already allowed. What cannot approve is a PI whose base is
--     missing: every door above checks the base BEFORE it looks at an exception,
--     and the payment summary reports order_gate_cleared = false for it.
--
-- EXISTING DECLARED ADVANCES ARE NOT REWRITTEN. advance_declared_amount and
-- advance_exception_percent were priced on the Grand Total. The constraint
-- order_submissions_advance_amount_matches_condition is replaced by a LOOSER one
-- (see section 4): a 'standard' amount must reach 40% of the pre-GST total
-- (never lower than before for old rows, because the pre-GST total is not above
-- the grand total) and an 'exception' amount stays below 40% of the Grand Total.
-- The strict pre-GST classification of a NEW declaration is made by the door
-- (submit_order_submission_advance_v2_internal), not by a CHECK, because a CHECK
-- is evaluated on every UPDATE of a row, NOT VALID or not: an old exception
-- declared at, say, 38% of the Grand Total (about 44.8% of the pre-GST total)
-- would otherwise make every later UPDATE of that PI fail (the decision, the
-- conversion, an internal-details save). The new CHECK is implied by the old
-- one for every existing row, so adding it cannot fail on production-shaped data
-- and is validated at once. The trigger that clears a declared amount when the
-- grand total is replaced now also clears it when the pre-GST total is replaced.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH: orders.total_value, any
-- order_submissions / order_advance_* / order_pi_versions row, any payment or
-- allocation, any permission. Nothing is back-filled.
--
-- AFTER IT APPLIES: an aligned Order with no derivable base (its value was
-- amended by hand, not by a PI revision) is no longer "ready" on the percentage;
-- nothing is rewritten, but the next payment reduction or re-valuation of that
-- Order opens a hold like any Order short of the requirement. The migration
-- reports how many (NOTICE) so the owner can look before the first one happens.
--
-- Replays safely: every statement is CREATE OR REPLACE / DROP IF EXISTS.
--
-- Rollback: "docs/Module Docs/advance-on-total-before-gst-rollback.sql".

-- ═══ 0. Dependencies ════════════════════════════════════════════════════════

do $dep$
begin
  if to_regprocedure('public.order_advance_position(uuid)') is null
     or to_regprocedure('public.orders_dashboard_summary()') is null
     or to_regprocedure('public.can_read_order_detail(uuid)') is null
     or to_regprocedure('public.finance_payment_status_is_verified(text)') is null
     or to_regprocedure('public.approve_order_submission(uuid, uuid, date, date, text)') is null then
    raise exception 'DEPENDENCY MISSING: the Orders / PI advance chain (20270116000000, 20270205000000, 20270221000000) is not applied';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'order_submissions' and column_name = 'total_before_gst') then
    raise exception 'DEPENDENCY MISSING: public.order_submissions.total_before_gst';
  end if;
end $dep$;

-- What the replaced functions looked like (privileges, security, search_path), to
-- prove at the foot that CREATE OR REPLACE kept every one of them.
drop table if exists pg_temp.pi_advance_acl_before;
create temp table pi_advance_acl_before as
select p.oid, p.oid::regprocedure::text as sig, p.proacl::text as acl, p.prosecdef as secdef, p.proconfig::text as config
  from pg_proc p
 where p.oid = any (array[
   'public.order_submission_standard_advance_amount(numeric)'::regprocedure,
   'public.order_submission_advance_amount(numeric, numeric)'::regprocedure,
   'public.order_submission_required_payment(numeric)'::regprocedure,
   'public.order_submission_payment_shortfall(numeric, numeric)'::regprocedure,
   'public.order_submission_payment_ready(numeric, numeric, text)'::regprocedure,
   'public.order_submissions_advance_amount_follows_total()'::regprocedure,
   'public.order_advance_position(uuid)'::regprocedure,
   'public.approve_order_submission(uuid, uuid, date, date, text)'::regprocedure,
   'public.approve_pi_advance_exception(uuid)'::regprocedure,
   'public.reject_pi_advance_exception(uuid, text)'::regprocedure,
   'public.submit_pi_for_review_internal(uuid, text, text, text, text)'::regprocedure,
   'public.submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text)'::regprocedure,
   'public.pi_submission_payment_summary(uuid)'::regprocedure,
   'public.orders_alignment_requires_advance()'::regprocedure,
   'public.order_advance_hold_recheck(uuid, text, jsonb)'::regprocedure,
   'public.orders_dashboard_summary()'::regprocedure
 ]);

-- ═══ 1. The base: derive on read, never store ══════════════════════════════

-- A number out of a JSON text, or NULL. Never raises: a payload that holds words
-- where a figure should be is "no figure", not an error in somebody's approval.
create or replace function public.order_advance_numeric(p_text text)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case when p_text ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then btrim(p_text)::numeric end
$$;
revoke execute on function public.order_advance_numeric(text) from public, anon, authenticated, service_role;
comment on function public.order_advance_numeric(text) is
  'A plain decimal out of text, else NULL (never raises, never NaN). Used to read commercial figures out of a PI version''s staged parse. Executable by no client role. 20270227000000.';

-- The Order's advance base: the pre-GST total of the PI that PRICES it.
--
--   1. the in-force (approved) PI version's staged parse, when its Grand Total is
--      the Order's total_value (a revised PI, V2 onward);
--   2. else the source PI's total_before_gst, when its Grand Total is the
--      Order's total_value (V1, or the PI row after a revision was applied);
--   3. else NULL: the Order's value was set some other way (a hand amendment),
--      so no PI figure is known to be the pre-GST total of THAT value.
--
-- Only a positive, real figure is a base. Reads, never writes. Executable by no
-- client role (definers and triggers call it); clients use order_total_before_gst.
create or replace function public.order_advance_base(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when b.base is not null and b.base <> 'NaN'::numeric and b.base > 0 then b.base end
    from (
      select coalesce(
        (select round(public.order_advance_numeric(p.payload -> 'commercial' ->> 'total_before_gst'), 2)
           from public.orders o
           join public.order_pi_versions v on v.order_id = o.id and v.status = 'approved'
           join public.order_pi_revision_staged_parses p on p.version_id = v.id
          where o.id = p_order_id
            and public.order_advance_numeric(p.payload -> 'commercial' ->> 'grand_total') = o.total_value
            and public.order_advance_numeric(p.payload -> 'commercial' ->> 'total_before_gst') > 0
            -- INCONSISTENT DATA IS NOT A BASE: GST is never negative, so a pre-GST total above the grand total
            -- it is part of violates the commercial model (the parser only WARNS, GRAND_TOTAL_MISMATCH).
            and public.order_advance_numeric(p.payload -> 'commercial' ->> 'total_before_gst')
                <= public.order_advance_numeric(p.payload -> 'commercial' ->> 'grand_total')
          limit 1),
        (select s.total_before_gst
           from public.orders o
           join public.order_submissions s on s.id = o.source_order_submission_id
          where o.id = p_order_id
            and s.grand_total = o.total_value
            and s.total_before_gst <> 'NaN'::numeric
            and s.total_before_gst > 0
            -- (as above) a pre-GST total above its own grand total is inconsistent data, not a base
            and s.total_before_gst <= s.grand_total
          limit 1)
      ) as base
    ) b
$$;
revoke execute on function public.order_advance_base(uuid) from public, anon, authenticated, service_role;
comment on function public.order_advance_base(uuid) is
  'The pre-GST total an Order''s advance is measured against, derived on read from the in-force PI version (or the source PI) when its Grand Total is the Order''s value, else NULL. Never stored, never back-filled. Executable by no client role. 20270227000000.';

-- The same scalar for a signed-in reader, shaped as a PostgREST COMPUTED COLUMN:
--   .from('orders').select('id, total_value, order_total_before_gst')
-- It re-reads the Order by id and answers only a caller who may read that Order,
-- so it cannot be handed a made-up row to read another Order's figure. NULL
-- means "no pre-GST total is known for this Order's value".
create or replace function public.order_total_before_gst(o public.orders)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.can_read_order_detail(o.id) then public.order_advance_base(o.id) end
$$;
revoke all on function public.order_total_before_gst(public.orders) from public, anon, service_role;
grant execute on function public.order_total_before_gst(public.orders) to authenticated;
comment on function public.order_total_before_gst(public.orders) is
  'The pre-GST total this Order''s advance is measured against (derive-on-read, no write), or NULL when none is known; NULL for a caller who cannot read the Order. A PostgREST computed column. 20270227000000.';

-- ═══ 2. The pure helpers: the argument is now the PRE-GST BASE ══════════════
--
-- Names, signatures and parameter names are KEPT (a CHECK, a trigger, a down
-- script and callers outside this repo may name them; a rename would need
-- DROP FUNCTION): p_grand_total is, from this migration on, THE BASE. COMMENT ON
-- FUNCTION says so. A base that is NULL, NaN, zero or negative answers NULL.

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
    when p_grand_total <= 0 then null
    -- round() only trims the scale numeric division leaves behind: ceil() has
    -- already made this an exact whole-paise figure, so no value moves.
    else round(ceil(p_grand_total * 40) / 100, 2)
  end
$$;

create or replace function public.order_submission_advance_amount(
  p_grand_total numeric,
  p_percent     numeric
)
returns numeric
language sql
immutable
parallel safe
as $$
  select case
    when p_grand_total is null or p_percent is null then null
    when p_grand_total = 'NaN'::numeric or p_percent = 'NaN'::numeric then null
    when p_grand_total <= 0 then null
    else round(p_grand_total * p_percent / 100, 2)
  end
$$;

create or replace function public.order_submission_required_payment(p_grand_total numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p_grand_total is null then null
    when p_grand_total = 'NaN'::numeric then null
    when p_grand_total <= 0 then null
    else p_grand_total * public.order_submission_standard_advance_percent() / 100
  end
$$;

create or replace function public.order_submission_payment_shortfall(
  p_grand_total numeric,
  p_verified    numeric
)
returns numeric
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when p_grand_total is null or p_grand_total = 'NaN'::numeric or p_grand_total <= 0 then null
    when p_verified is null or p_verified = 'NaN'::numeric then null
    else round(greatest(
      ceil((public.order_submission_required_payment(p_grand_total) - p_verified) * 100) / 100,
      0), 2)
  end
$$;

-- No usable base is never ready -- not even under an approved exception: the
-- exception authorises a LOWER payment against a figure, and there is no figure.
create or replace function public.order_submission_payment_ready(
  p_grand_total              numeric,
  p_verified_payment         numeric,
  p_advance_exception_status text
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(
    p_grand_total is not null and p_grand_total <> 'NaN'::numeric and p_grand_total > 0
    and (
      -- An APPROVED exception is sufficient on its own, at any level of payment
      -- including none.
      p_advance_exception_status = 'approved'
      or (
        p_verified_payment is not null and p_verified_payment <> 'NaN'::numeric
        and p_verified_payment >= public.order_submission_required_payment(p_grand_total)
      )
    ),
    false
  )
$$;

comment on function public.order_submission_standard_advance_amount(numeric) is
  'The smallest whole-paise advance that meets the standard 40% of the PRE-GST BASE (the argument, still named p_grand_total); NULL for a NULL, NaN, zero or negative base. 20270227000000.';
comment on function public.order_submission_advance_amount(numeric, numeric) is
  'round(base x percent / 100, 2) where the base is the PRE-GST total (the argument, still named p_grand_total); NULL for a NULL, NaN, zero or negative base. 20270227000000.';
comment on function public.order_submission_required_payment(numeric) is
  '40% of the PRE-GST base (the argument, still named p_grand_total), exact; NULL for a NULL, NaN, zero or negative base. 20270227000000.';
comment on function public.order_submission_payment_shortfall(numeric, numeric) is
  'How much more verified payment reaches 40% of the PRE-GST base (the argument, still named p_grand_total), rounded UP to the paisa; NULL when the base or the verified figure is unusable. 20270227000000.';
comment on function public.order_submission_payment_ready(numeric, numeric, text) is
  'True only with a usable PRE-GST base (the argument, still named p_grand_total) and either an approved exception or verified payment of at least 40% of it. NULL, zero, NaN and negative bases are never ready. 20270227000000.';
comment on function public.order_submission_advance_percent_of(numeric, numeric) is
  'trunc(amount x 100 / base, 2) where the base is the PRE-GST total (the argument, still named p_grand_total); NULL for a NULL, NaN, zero or negative base. Body unchanged by 20270227000000: only what is passed in changed.';
comment on function public.order_submission_effective_advance_amount(text, numeric, numeric, numeric) is
  'The advance a PI states: its declared amount, else the standard / exception figure of the PRE-GST base (the last argument, still named p_grand_total). Body unchanged by 20270227000000: only what is passed in changed.';

-- ═══ 3. A declared amount follows BOTH totals ═══════════════════════════════
--
-- Cleared whenever grand_total OR total_before_gst is replaced without a new
-- amount in the same statement: a declared advance must not survive the figures
-- it was measured against. (The trigger itself -- BEFORE UPDATE, row level -- is
-- unchanged; only this body is.)
create or replace function public.order_submissions_advance_amount_follows_total()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.grand_total is distinct from old.grand_total
      or new.total_before_gst is distinct from old.total_before_gst)
     and new.advance_declared_amount is not distinct from old.advance_declared_amount then
    new.advance_declared_amount := null;
  end if;
  return new;
end;
$$;

-- ═══ 4. The amount and the condition say the same thing ═════════════════════
--
-- Replaces order_submissions_advance_amount_matches_condition (20260917000000),
-- which compared the declared amount with grand_total x 40 / 100.
--
--   standard   amount >= 40% of the pre-GST total. least(total_before_gst,
--              grand_total) because a row with no pre-GST figure falls back to the
--              grand total, and because the pre-GST total is never above the grand
--              total: every row the OLD rule accepted (>= 40% of the grand total)
--              is accepted by this one.
--   exception  amount <  40% of the GRAND total, i.e. exactly the old upper bound.
--              Deliberately NOT 40% of the pre-GST total: an exception declared
--              before this migration at, say, 38% of the grand total is about
--              44.8% of the pre-GST total, and a CHECK is evaluated again on every
--              later UPDATE of that row (NOT VALID included), so the stricter bound
--              would make the PI impossible to decide, convert or edit.
--              The strict classification of a NEW declaration against the pre-GST
--              total is made in submit_order_submission_advance_v2_internal
--              (ORDER_SUBMISSION_ADVANCE_AMOUNT_NOT_REDUCED / _BELOW_STANDARD).
--
-- The new rule is implied by the old one for every existing row, so it cannot be
-- violated by data already there and is validated by the ADD itself. The literal
-- 40 stays written out (a CHECK is not re-validated when a function it calls is
-- replaced); the assertions at the foot prove it agrees with the function.
alter table public.order_submissions
  drop constraint if exists order_submissions_advance_amount_matches_condition;

alter table public.order_submissions
  add constraint order_submissions_advance_amount_matches_condition check (
    advance_declared_amount is null
    or (advance_condition = 'standard'
        and advance_declared_amount >= least(coalesce(total_before_gst, grand_total), grand_total) * 40 / 100)
    or (advance_condition = 'exception'
        and advance_declared_amount <  grand_total * 40 / 100)
  );

comment on column public.order_submissions.advance_declared_amount is
  'The advance AMOUNT the employee declared for this PI, in rupees, to two decimal places. Since 20270227000000 the 40% is of the TOTAL BEFORE GST: at least total_before_gst x 40 / 100 under the standard condition and strictly below it under an exception (the table constraint is the looser one -- standard: at least 40% of the pre-GST total; exception: below 40% of the Grand Total -- so declarations made on the old basis stay valid; the submit door applies the strict pre-GST classification). NULL means no amount was declared: a record written before this column existed, or one whose totals were replaced afterwards. NULL is never zero -- zero is the No advance declaration. Says nothing about payment: no money has been recorded, requested, verified or received.';

-- ═══ 5. The callers: every body is its CURRENT latest definition with only the
-- denominator (and the refusal / keys that go with it) changed ════════════════

-- order_advance_position: previous definition 20270205000000_order_production_needs_order_level_exception.sql
create or replace function public.order_advance_position(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o          public.orders%rowtype;
  s          public.order_submissions%rowtype;
  v_known    boolean;
  v_base     numeric;
  v_value_known boolean;
  v_verified numeric;
  v_awaiting numeric;
  v_required numeric;
  v_short    numeric;
  v_version  uuid;
  v_exc      public.order_advance_exceptions%rowtype;
  v_pi_exc   boolean := false;
  v_hold     public.order_advance_holds%rowtype;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then return null; end if;

  -- 20270227000000: THE ADVANCE IS MEASURED AGAINST THE TOTAL BEFORE GST, not the
  -- Grand Total. The base is derived on read (order_advance_base): the in-force PI
  -- version's pre-GST total, or the source PI's, when its Grand Total is the Order's
  -- value; otherwise there is no base. NULL, zero and NaN are "no base on record":
  -- nothing to measure against, never 0%, never ready on the percentage.
  v_base  := public.order_advance_base(o.id);
  v_known := v_base is not null and v_base <> 'NaN'::numeric and v_base > 0;
  v_value_known := o.total_value is not null and o.total_value <> 'NaN'::numeric and o.total_value > 0;

  select coalesce(sum(a.allocated_amount), 0) into v_verified
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and public.finance_payment_status_is_verified(f.status);
  select coalesce(sum(a.allocated_amount), 0) into v_awaiting
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and f.status in ('pending_approval', 'needs_clarification');

  if v_known then
    v_required := public.order_submission_required_payment(v_base);
    v_short    := greatest(coalesce(public.order_submission_payment_shortfall(v_base, v_verified), v_required - v_verified), 0);
  end if;

  select v.id into v_version from public.order_pi_versions v
   where v.order_id = o.id and v.status = 'approved' limit 1;

  -- An administrator's exception for THIS value basis, still backed by the
  -- money it was given against.
  select * into v_exc from public.order_advance_exceptions e
   where e.order_id = o.id
     and e.value_epoch = o.value_epoch
     and e.order_value is not distinct from o.total_value
     and e.pi_version_id is not distinct from v_version
     and v_verified >= e.verified_at_grant
     and not exists (select 1 from public.order_advance_exception_voids x where x.exception_id = e.id)
   order by e.approved_at desc limit 1;

  -- The PI's own pre-conversion exception: only while the Order has never
  -- been re-valued, the PI still carries the figures it was decided on, the
  -- verified money has not fallen below what it was when the administrator
  -- DECIDED it (advance_exception_decided_verified; older decisions fall back
  -- to the recorded percentage), and no reversal has voided it.
  if o.source_order_submission_id is not null and o.value_epoch = 0 then
    select * into s from public.order_submissions where id = o.source_order_submission_id;
    v_pi_exc := coalesce(s.id is not null
      and s.grand_total is not distinct from o.total_value
      and v_verified >= public.order_pi_exception_floor(s.advance_exception_decided_verified, s.advance_exception_percent, o.total_value)
      and not exists (select 1 from public.order_advance_exception_voids x where x.order_id = o.id and x.exception_id is null)
      and public.order_submission_exception_current(
            s.advance_exception_status,
            s.advance_exception_decided_grand_total,     s.grand_total,
            s.advance_exception_decided_workbook_sha256, s.source_workbook_sha256,
            s.advance_exception_decided_payment_terms,   s.payment_terms,
            s.advance_exception_decided_billing_terms,   s.billing_terms), false);
  end if;

  select * into v_hold from public.order_advance_holds h where h.order_id = o.id and h.resolved_at is null;

  return jsonb_build_object(
    'order_value',  o.total_value,
    'value_known',  v_known,            -- since 20270227000000: the advance BASE is known
    'order_value_known', v_value_known,
    'advance_base', v_base,
    'value_epoch',  o.value_epoch,
    'pi_version_id', v_version,
    'verified',     v_verified,
    'awaiting',     v_awaiting,
    'required',     v_required,
    'shortfall',    v_short,
    -- truncated, as the dashboard and the PI summary do: 39.9999% must never read 40.00% beside a shortfall
    'percent',      case when v_known then trunc(100 * v_verified / v_base, 2) end,
    'threshold_percent', public.order_submission_standard_advance_percent(),
    'below',        not v_known or v_short > 0,
    'exception',    case when v_exc.id is not null then jsonb_build_object(
                      'source', 'order', 'approved_by', v_exc.approved_by, 'approved_at', v_exc.approved_at,
                      'reason', v_exc.reason, 'order_value', v_exc.order_value)
                    when v_pi_exc then jsonb_build_object('source', 'pi', 'approved_by', s.advance_exception_decided_by,
                      'approved_at', s.advance_exception_decided_at)
                    end,
    'hold',         case when v_hold.id is not null then jsonb_build_object(
                      'id', v_hold.id, 'cause', v_hold.cause, 'held_at', v_hold.held_at,
                      'order_value', v_hold.order_value, 'previous_order_value', v_hold.previous_order_value,
                      'verified', v_hold.verified, 'percent', v_hold.percent, 'shortfall', v_hold.shortfall)
                    end,
    -- 20270205000000: production needs the verified 40% or an Order-level
    -- (administrator's, with a reason) exception. The PI's own exception lets
    -- the PI become an Order; it no longer starts production by itself.
    'ready',        (v_known and v_short = 0) or v_exc.id is not null);
end;
$$;

-- approve_order_submission: previous definition 20261226000000_order_submission_finance_verification_no_longer_required.sql
create or replace function public.approve_order_submission(
  p_submission_id uuid,
  p_assigned_to   uuid,
  p_confirm_date  date,
  p_due_date      date,
  p_lead_source   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := public.assert_order_submission_actor();
  v_sub          public.order_submissions%rowtype;
  v_order_id     uuid;
  v_number       text;
  v_now          timestamptz;
  v_item_count   integer;
  v_bad          integer;
  v_bad_row      integer;
  v_client       text;
  v_verified     numeric;
  v_unverified   numeric;
  v_required     numeric;
  v_shortfall    numeric;
  v_route        text;
  v_exception_current boolean;
  v_moved_count  integer := 0;
  v_moved_amount numeric := 0;
  v_stranded     integer;
  v_pi_stamped   boolean := false;
  v_codes        jsonb;
  v_lead_source  text;
  v_salesperson  uuid;
begin
  -- ── 1. Authorization, server-side, before anything is read ──
  if not public.actor_can_approve_order() then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  -- ── 2. The lock, before any mutable state is judged ──
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- ── 3. Already approved: answer with what exists ──
  if v_sub.status = 'approved' and v_sub.order_id is not null then
    select o.display_number into v_number
    from public.orders o where o.id = v_sub.order_id;

    return jsonb_build_object(
      'submission_id',    p_submission_id,
      'order_id',         v_sub.order_id,
      'display_number',   v_number,
      'already_approved', true
    );
  end if;

  -- ── 4. A deletion reservation freezes the record for everybody ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  -- ── 5. Only a submitted PI can be approved ──
  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_ALREADY_LINKED: this PI is already linked to an Order'
      using errcode = 'P0001';
  end if;

  -- ── 5b. The four fields a Confirmed Order cannot be built without ──
  --
  -- WHY HERE. Before the payment gate, before the diagnostics, before the
  -- workbook and image checks and before anything is written: a conversion
  -- refused for a missing field must leave the PI exactly as it found it.
  --
  -- WHY IN THE DATABASE. The screen asks for all four and will not submit
  -- without them, and that is a courtesy rather than a control. A stale client,
  -- a replayed request and a hand-made PostgREST call all arrive here.
  --
  -- HISTORICAL ORDERS ARE UNTOUCHED. This is a rule about CREATING an Order,
  -- expressed in the function that creates one. public.orders keeps every
  -- column nullable, so the Orders that predate this migration still read and
  -- still open.
  if p_assigned_to is null then
    raise exception
      'ORDER_CONFIRMATION_SALESPERSON_REQUIRED: a salesperson is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  select id into v_salesperson from public.users where id = p_assigned_to;
  if v_salesperson is null then
    raise exception
      'ORDER_CONFIRMATION_SALESPERSON_UNKNOWN: that salesperson is not a BOE user'
      using errcode = 'P0001';
  end if;

  if p_confirm_date is null then
    raise exception
      'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED: a confirm date is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  if p_due_date is null then
    raise exception
      'ORDER_CONFIRMATION_DUE_DATE_REQUIRED: a due date is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  v_lead_source := nullif(btrim(coalesce(p_lead_source, '')), '');
  if v_lead_source is null then
    raise exception
      'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED: a lead source is required before an Order can be confirmed'
      using errcode = 'P0001';
  end if;

  -- The SAME five values public.orders has always accepted. The CHECK
  -- constraint would refuse anything else at the INSERT; naming it here means
  -- the refusal is a sentence about the field rather than a constraint name.
  if v_lead_source not in ('reference', 'repeat_customer', 'whatsapp', 'instagram', 'website') then
    raise exception
      'ORDER_CONFIRMATION_LEAD_SOURCE_INVALID: that lead source is not one BOE records'
      using errcode = 'P0001';
  end if;

  v_now := now();

  -- ── 6b. The PI decision, if it has not been taken against this submission ──
  if not public.order_submission_pi_approved(
       v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at) then
    update public.order_submissions
       set pi_approved_by            = v_actor,
           pi_approved_at            = v_now,
           pi_approved_submission_at = v_sub.submitted_at
     where id = p_submission_id;
    v_pi_stamped := true;
    v_sub.pi_approved_by            := v_actor;
    v_sub.pi_approved_at            := v_now;
    v_sub.pi_approved_submission_at := v_sub.submitted_at;
  end if;

  -- ── 6a. The total the requirement is a percentage of ──
  if v_sub.grand_total is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored grand total'
      using errcode = 'P0001';
  end if;

  -- ── 6a'. 20270227000000: the 40% advance is of the TOTAL BEFORE GST ──
  -- A PI with a grand total but no usable pre-GST figure cannot be measured, and
  -- an exception does not change that: refused before any payment is judged.
  if v_sub.total_before_gst is null
     or v_sub.total_before_gst = 'NaN'::numeric
     or v_sub.total_before_gst <= 0
     or v_sub.total_before_gst > v_sub.grand_total then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored total before GST, so its 40%% advance cannot be measured'
      using errcode = 'P0001';
  end if;

  -- ── 7. The PAYMENT gate, live, under locks ──
  perform 1
  from public.finance_payment_requests f
  where f.id in (
    select a.payment_request_id
    from public.finance_payment_allocations a
    where a.order_submission_id = p_submission_id
  )
  order by f.id
  for update;

  perform 1
  from public.finance_payment_allocations a
  where a.order_submission_id = p_submission_id
  order by a.id
  for update;

  v_verified   := public.order_submission_verified_payment(p_submission_id);
  v_unverified := public.order_submission_unverified_payment(p_submission_id);
  v_required   := public.order_submission_required_payment(v_sub.total_before_gst);
  v_shortfall  := public.order_submission_payment_shortfall(v_sub.total_before_gst, v_verified);

  v_exception_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  if v_verified >= v_required then
    v_route := 'standard';
  elsif v_exception_current then
    v_route := 'exception';
  else
    v_route := null;
  end if;

  if v_route is null then
    if v_sub.advance_exception_status = 'pending' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_PENDING: The reduced-payment exception is still pending.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'rejected' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REJECTED: The reduced-payment exception was rejected. Update the PI before resubmitting.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'approved' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_STALE: The reduced-payment approval was given for different commercial terms and must be approved again.'
        using errcode = 'P0001';
    end if;

    if v_unverified > 0 then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION: Payment is awaiting Finance verification. % more verified payment is required for standard approval, or Admin approval is required to proceed below 40%%.',
        '₹' || to_char(v_shortfall, 'FM999999999990.00')
        using errcode = 'P0001';
    end if;

    raise exception
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: % more verified payment is required for standard approval. Admin approval is required to proceed below 40%%.',
      '₹' || to_char(v_shortfall, 'FM999999999990.00')
      using errcode = 'P0001';
  end if;

  -- ── 7b. NOTHING MAY STILL BE WITH FINANCE (20261226000000) ──
  --
  -- THE CASE THE ROUTE ABOVE CANNOT REFUSE. v_route is resolved from VERIFIED
  -- money against the requirement, or from a current exception. Both can be
  -- satisfied while a SEPARATE payment against this same PI is still sitting
  -- with Finance undecided — and until this check existed, that PI could be
  -- turned into an Order with money in flight that nobody had agreed was real.
  --
  -- The branch above raises AWAITING_VERIFICATION too, but only when the PI is
  -- ALSO short. This one is unconditional, and it is the rule as stated: if any
  -- payment attached to this PI is awaiting verification, the Order is not
  -- created.
  --
  -- REJECTED AND REVERSED PAYMENTS ARE NOT THIS. order_submission_unverified_payment()
  -- counts only pending_approval and needs_clarification — money Finance has
  -- yet to decide. A rejected payment is decided, counts zero, and blocks
  -- nothing here, exactly as it did before.
  if v_unverified > 0 then
    raise exception
      'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION: a payment attached to this PI is awaiting Finance verification and must be verified before the Order can be created'
      using errcode = 'P0001';
  end if;

  -- ── 8. No blocking diagnostics ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- ── 9. The fields an Order cannot be built without ──
  v_client := nullif(btrim(coalesce(v_sub.client_name, '')), '');
  if v_client is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  -- ── 10. The workbook: shape, then existence, then type ──
  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

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
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: the PI workbook is missing from storage, or is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  -- ── 11. The product lines still satisfy the submission invariants ──
  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_bad
      using errcode = 'P0001';
  end if;

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

  -- ── 12. Everything holds. Open the approval context. ──
  perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true);

  if v_pi_stamped then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
      jsonb_build_object(
        'approved_submission_at', v_sub.submitted_at,
        'order_created',          true
      )
    );
  end if;

  -- ── 13. Exactly one Order ──
  insert into public.orders (
    client_name, requested_by, assigned_to, confirm_date, due_date,
    total_value, total_product_value, lead_source,
    billing_percentage,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    p_assigned_to,
    p_confirm_date,
    p_due_date,
    v_sub.grand_total,
    v_sub.gross_product_amount,
    v_lead_source,
    v_sub.billing_percentage,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 13b. Permanent BOE item codes, assigned the moment the Order exists ──
  v_codes := public.assign_order_product_codes(v_order_id, v_actor);

  -- ── 14. The submission becomes approved, and names its Order ──
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id
   where id = p_submission_id;

  -- ── 14a. The money follows the record. It is MOVED, never copied. ──
  with moved as (
    update public.finance_payment_allocations
       set order_submission_id = null,
           order_id            = v_order_id
     where order_submission_id = p_submission_id
       and status = 'active'
    returning allocated_amount
  )
  select count(*), coalesce(sum(allocated_amount), 0)
    into v_moved_count, v_moved_amount
  from moved;

  select count(*) into v_stranded
  from public.finance_payment_allocations
  where order_submission_id = p_submission_id and status = 'active';

  if v_stranded > 0 then
    raise exception
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED: % allocation(s) still name this PI after conversion; no Order may be created over stranded money',
      v_stranded
      using errcode = 'P0001';
  end if;

  -- ── 14b. V1 of the Order's PI history: the document it was approved from ──
  insert into public.order_pi_versions (
    order_id, submission_id, version_number, status,
    workbook_path, workbook_name, workbook_sha256,
    uploaded_by, uploaded_at, revision_reason,
    decided_by, decided_at
  ) values (
    v_order_id, p_submission_id, 1, 'approved',
    v_sub.source_workbook_path, v_sub.source_workbook_name, v_sub.source_workbook_sha256,
    coalesce(v_sub.submitted_by, v_sub.created_by), coalesce(v_sub.submitted_at, v_now), null,
    v_actor, v_now
  );

  -- ── 15. Both trails ──
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'approved', 'submitted', 'approved', null,
    jsonb_build_object(
      'order_id',             v_order_id,
      'order_display_number', v_number,
      'item_count',           v_item_count,
      'payment_route',        v_route,
      'verified_payment',     v_verified,
      'unverified_payment',   v_unverified,
      'attached_payment',     v_verified + v_unverified,
      'required_payment',     v_required,
      'grand_total',          v_sub.grand_total,
      'advance_base',         v_sub.total_before_gst,
      'total_before_gst',     v_sub.total_before_gst,
      'pi_approved_at',       v_sub.pi_approved_at,
      'pi_approved_by',       v_sub.pi_approved_by
    )
  );

  if v_moved_count > 0 then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'payment_allocations_moved', 'approved', 'approved', null,
      jsonb_build_object(
        'order_id',           v_order_id,
        'allocation_count',   v_moved_count,
        'allocated_total',    v_moved_amount
      )
    );
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_pi_submission',
    jsonb_build_object(
      'order_submission_id',       p_submission_id,
      'item_count',                v_item_count,
      'payment_route',             v_route,
      'moved_allocation_count',    v_moved_count,
      'moved_allocated_total',     v_moved_amount,
      'production_alignment',      'not_aligned'
    )
  );

  if jsonb_array_length(v_codes) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_order_id, v_actor, 'order_product_codes_assigned',
      jsonb_build_object('codes', v_codes)
    );
  end if;

  -- ── 16. Close the context before returning ──
  perform set_config('boe.pi_submission_approval_id', '', true);

  -- ── 17. Identifiers only. Nothing the caller could not already read. ──
  return jsonb_build_object(
    'submission_id',    p_submission_id,
    'order_id',         v_order_id,
    'display_number',   v_number,
    'already_approved', false
  );
end;
$$;

-- approve_pi_advance_exception: previous definition 20270114000000_order_submission_numbering_at_conversion_and_exception_reasons.sql
create or replace function public.approve_pi_advance_exception(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_sub      public.order_submissions%rowtype;
  v_verified numeric;
begin
  -- NOT orders.approve_order. Holding that alone is deliberately not enough.
  if not public.actor_has_module_permission('orders', 'approve_advance_exception') then
    raise exception 'You do not have permission to decide advance exceptions'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can have its advance exception decided (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.advance_condition is distinct from 'exception'
     or v_sub.advance_exception_status is distinct from 'pending' then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: this PI has no advance exception waiting for a decision'
      using errcode = 'P0001';
  end if;

  -- 20270227000000: a decision is taken against a figure. No usable total before
  -- GST (the base of the 40%), no decision.
  if v_sub.total_before_gst is null
     or v_sub.total_before_gst = 'NaN'::numeric
     or v_sub.total_before_gst <= 0
     or v_sub.total_before_gst > v_sub.grand_total then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored total before GST, so its advance cannot be measured and an exception cannot be decided'
      using errcode = 'P0001';
  end if;

  -- THE VERIFIED MONEY NOW, not when it was requested (review R7).
  v_verified := coalesce(public.order_submission_verified_payment(p_submission_id), 0);

  update public.order_submissions
     set advance_exception_status = 'approved',
         advance_exception_decided_by = v_actor,
         advance_exception_decided_at = now(),
         advance_exception_rejection_reason = null,
         advance_exception_decided_grand_total     = v_sub.grand_total,
         advance_exception_decided_workbook_sha256 = v_sub.source_workbook_sha256,
         advance_exception_decided_payment_terms   = v_sub.payment_terms,
         advance_exception_decided_billing_terms   = v_sub.billing_terms,
         advance_exception_decided_verified        = v_verified
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'advance_exception_approved', 'submitted', 'submitted', null,
    jsonb_build_object(
      'advance_condition', 'exception',
      'advance_percent',   v_sub.advance_exception_percent,
      'decided_verified',  v_verified,
      'decided_percent',   case when coalesce(v_sub.total_before_gst, 0) > 0
                                then round(100 * v_verified / v_sub.total_before_gst, 2) end,
      'standard_percent',  public.order_submission_standard_advance_percent(),
      'grand_total',       v_sub.grand_total,
      'advance_base',      v_sub.total_before_gst,
      'total_before_gst',  v_sub.total_before_gst,
      'advance_amount',    public.order_submission_advance_amount(
                             v_sub.total_before_gst, v_sub.advance_exception_percent),
      'exception_status',  'approved',
      'payment_terms',     v_sub.payment_terms,
      'billing_terms',     v_sub.billing_terms,
      'workbook_sha256',   v_sub.source_workbook_sha256
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'status', 'submitted',
    'advance_exception_status', 'approved',
    'decided_verified', v_verified
  );
end;
$$;

-- reject_pi_advance_exception: previous definition 20260921000000_order_submission_verified_payment_gate.sql
create or replace function public.reject_pi_advance_exception(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_sub    public.order_submissions%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.actor_has_module_permission('orders', 'approve_advance_exception') then
    raise exception 'You do not have permission to decide advance exceptions'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_DECISION_REASON_REQUIRED: say why the proposed advance is being refused'
      using errcode = 'P0001';
  end if;

  if char_length(v_reason) > 1000 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can have its advance exception decided (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.advance_condition is distinct from 'exception'
     or v_sub.advance_exception_status is distinct from 'pending' then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_NOT_PENDING: this PI has no advance exception waiting for a decision'
      using errcode = 'P0001';
  end if;

  -- ONE STATEMENT: the refusal, the reason and the PI's return happen together
  -- or not at all. The basis columns are cleared with it — a refused exception
  -- describes a record that is about to be corrected, so there is nothing left
  -- for it to have been a decision about.
  update public.order_submissions
     set advance_exception_status = 'rejected',
         advance_exception_decided_by = v_actor,
         advance_exception_decided_at = now(),
         advance_exception_rejection_reason = v_reason,
         advance_exception_decided_grand_total     = null,
         advance_exception_decided_workbook_sha256 = null,
         advance_exception_decided_payment_terms   = null,
         advance_exception_decided_billing_terms   = null,
         status = 'needs_changes',
         review_note = v_reason
   where id = p_submission_id;

  -- ONE EVENT FOR ONE ACTION. No 'changes_requested' row is written beside this:
  -- the previous and new status on this row already say the PI was returned, and
  -- two entries would read as two separate management decisions.
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'advance_exception_rejected', 'submitted', 'needs_changes', v_reason,
    jsonb_build_object(
      'advance_condition', 'exception',
      'advance_percent',   v_sub.advance_exception_percent,
      'standard_percent',  public.order_submission_standard_advance_percent(),
      'grand_total',       v_sub.grand_total,
      'advance_base',      v_sub.total_before_gst,
      'total_before_gst',  v_sub.total_before_gst,
      'advance_amount',    public.order_submission_advance_amount(
                             v_sub.total_before_gst, v_sub.advance_exception_percent),
      'exception_status',  'rejected',
      'pi_returned',       true
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'status', 'needs_changes',
    'advance_exception_status', 'rejected'
  );
end;
$$;

-- submit_pi_for_review_internal: previous definition 20270114000000_order_submission_numbering_at_conversion_and_exception_reasons.sql
create or replace function public.submit_pi_for_review_internal(
  p_submission_id uuid,
  p_note          text,
  p_reason        text,
  p_payment_terms text,
  p_billing_terms text
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
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_pay_terms  text := nullif(btrim(coalesce(p_payment_terms, '')), '');
  v_bill_terms text := nullif(btrim(coalesce(p_billing_terms, '')), '');
  v_verified   numeric;
  v_unverified numeric;
  v_attached   numeric;
  v_required   numeric;
  v_percent    numeric;
  v_attached_percent numeric;
  v_standard   numeric := public.order_submission_standard_advance_percent();
  v_route      text;
  v_reason_code text;
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_meta       jsonb;
  -- ── Added by 20261224000000, for the auto-approval block at the foot ──
  v_can_approve   boolean := false;
  v_submitted_at  timestamptz;
  v_pi_now        timestamptz;
  v_auto_approved boolean := false;
begin
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

  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  if v_pay_terms is not null and char_length(v_pay_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: payment terms may be at most 500 characters (these are %)',
      char_length(v_pay_terms)
      using errcode = 'P0001';
  end if;

  if v_bill_terms is not null and char_length(v_bill_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: billing terms may be at most 500 characters (these are %)',
      char_length(v_bill_terms)
      using errcode = 'P0001';
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

  if v_sub.grand_total is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored grand total, so its payment position cannot be judged'
      using errcode = 'P0001';
  end if;

  -- 20270227000000: the 40% is of the TOTAL BEFORE GST. A PI that states a grand
  -- total but no usable pre-GST figure is incomplete, in the same words.
  if v_sub.total_before_gst is null
     or v_sub.total_before_gst = 'NaN'::numeric
     or v_sub.total_before_gst <= 0
     or v_sub.total_before_gst > v_sub.grand_total then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored total before GST, so its payment position cannot be judged'
      using errcode = 'P0001';
  end if;

  -- The live payment position, under the same locks the approval takes:
  -- payments before allocations, both in id order.
  perform 1
  from public.finance_payment_requests f
  where f.id in (
    select a.payment_request_id
    from public.finance_payment_allocations a
    where a.order_submission_id = p_submission_id
  )
  order by f.id
  for update;

  perform 1
  from public.finance_payment_allocations a
  where a.order_submission_id = p_submission_id
  order by a.id
  for update;

  v_verified   := public.order_submission_verified_payment(p_submission_id);
  v_unverified := public.order_submission_unverified_payment(p_submission_id);
  v_attached   := v_verified + v_unverified;
  v_required   := public.order_submission_required_payment(v_sub.total_before_gst);

  -- THE ROUTE IS CHOSEN ON ATTACHED PAYMENT. Money the client has paid and
  -- Finance has not yet looked at is not a reason to make the employee argue
  -- for an exception; it is a reason for Finance to look. Below 40% attached —
  -- zero included — the business must be told why before it is asked.
  v_route := case when v_attached >= v_required then 'standard' else 'exception' end;

  v_attached_percent := case
    when v_attached = 0 then 0
    else coalesce(public.order_submission_advance_percent_of(v_sub.total_before_gst, v_attached), 0)
  end;

  if v_route = 'exception' then
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED: say why an Order should be confirmed below the standard %% requirement'
        using errcode = 'P0001';
    end if;

    -- ── 20270114000000: ONE OF THREE REASONS, and nothing else ──
    --
    -- The reason is one of the three the screen offers, stated in words the
    -- admin reads as they are: 'Against client PO', 'Sample order', or
    -- 'Other: <remark>' where the remark says something (at least 10
    -- characters). Anything else is refused rather than stored, so every
    -- request carries a category an admin can filter and reason about.
    --
    -- PAYMENT TERMS ARE NO LONGER DEMANDED HERE. They remain part of the
    -- exception's recorded basis below — order_submission_exception_current()
    -- still compares them — and are still stored when given. Choosing a reason
    -- decides nothing: the request is 'pending' until an admin holding
    -- orders.approve_advance_exception approves it, exactly as before.
    -- (Refused below, once v_keep is known: an exception this PI already
    -- holds is kept word for word, whatever words it was given in.)
    v_reason_code := public.order_submission_exception_reason_code(v_reason);

    if not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_OWNER: only the owner of this PI may request an advance exception'
        using errcode = '42501';
    end if;

    -- THE SNAPSHOT keeps its applied meaning: verified payment, truncated and
    -- never rounded. On this route verified <= attached < the requirement, so
    -- the "strictly below 40" row constraint holds by construction.
    v_percent := case
      when v_verified = 0 then 0
      else coalesce(
        public.order_submission_advance_percent_of(v_sub.total_before_gst, v_verified), 0)
    end;

    if v_percent >= v_standard then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_NOT_POSITIVE: this PI has no positive total before GST to measure a payment percentage against'
        using errcode = 'P0001';
    end if;

    v_keep := coalesce(
      v_sub.advance_condition = 'exception'
      and v_sub.advance_exception_reason is not distinct from v_reason
      and public.order_submission_exception_current(
            v_sub.advance_exception_status,
            v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
            v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
            v_sub.advance_exception_decided_payment_terms,   v_pay_terms,
            v_sub.advance_exception_decided_billing_terms,   v_bill_terms),
      false
    );

    -- A PI returned for changes whose exception still stands — the same
    -- reason, the figures it was decided on unchanged — resubmits with it
    -- untouched, even when that reason was written before the three existed.
    -- Only a NEW request must be one of the three.
    if v_reason_code is null and not v_keep then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REASON_INVALID: choose Against client PO, Sample order, or Other with a remark of at least 10 characters'
        using errcode = 'P0001';
    end if;
  end if;

  -- ── The completeness checks, identical to every other submission path ──
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

  -- ── The write: one statement on every path ──
  if v_route = 'standard' then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'standard',
           advance_declared_amount = null,
           advance_exception_percent = null,
           advance_exception_reason = null,
           advance_exception_reason_code = null,
           advance_exception_status = null,
           advance_exception_requested_by = null,
           advance_exception_requested_at = null,
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null,
           advance_exception_decided_verified        = null
     where id = p_submission_id;

  elsif v_keep then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_declared_amount = null,
           advance_exception_percent = v_percent
     where id = p_submission_id;

  else
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'exception',
           advance_declared_amount = null,
           advance_exception_percent = v_percent,
           advance_exception_reason = v_reason,
           advance_exception_reason_code = v_reason_code,
           advance_exception_status = 'pending',
           advance_exception_requested_by = v_actor,
           advance_exception_requested_at = now(),
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null,
           advance_exception_decided_verified        = null
     where id = p_submission_id;
    v_requested := true;
  end if;

  v_meta := jsonb_build_object(
    'advance_condition',  v_route,
    'advance_percent',    case when v_route = 'standard' then v_standard else v_percent end,
    'standard_percent',   v_standard,
    'grand_total',        v_sub.grand_total,
    'advance_base',       v_sub.total_before_gst,
    'total_before_gst',   v_sub.total_before_gst,
    'advance_amount',     v_verified,
    'verified_payment',   v_verified,
    'unverified_payment', v_unverified,
    'attached_payment',   v_attached,
    'attached_percent',   v_attached_percent,
    'required_payment',   v_required,
    'payment_terms',      v_pay_terms,
    'billing_terms',      v_bill_terms
  );

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
      || v_meta
  );

  if v_requested then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'advance_exception_requested', v_sub.status, 'submitted', v_reason,
      v_meta || jsonb_build_object('exception_status', 'pending', 'reason_code', v_reason_code)
    );
  end if;

  -- ══ AUTO-APPROVAL, and nothing but the PI decision ════════════════════════
  --
  -- LAST, so that it is unreachable by a PI that failed anything above it.
  -- Every workbook, completeness, image and storage check has already run and
  -- already had its chance to raise; a PI carrying a single blocking issue was
  -- refused hundreds of lines ago and never arrives here. Nothing in this block
  -- re-judges the document — it records a decision about one that has just
  -- been proved submittable.
  --
  -- THE PERMISSION IS ASKED OF THE ENGINE, AT THE MOMENT OF THE CALL. Not of a
  -- role name, not of a column on the record, and not of anything the browser
  -- sent. actor_can_approve_order() — §4's permission-only door, the SAME one
  -- the reviewer's Approve button goes through — resolves auth.uid() against
  -- the four precedence levels every time.
  --
  -- THE ADMIN ROLE IS NOT A BACK DOOR HERE, and that is the whole reason §4
  -- exists. Asking the admin-branching helper would have auto-approved every
  -- administrator's own uploads no matter what the Control Centre said, which
  -- is the defect this file corrects rather than reproduces.
  --
  -- So withdrawing somebody's approve_order stops the very next submission
  -- from being auto-approved, with no cache to wait for and nothing to
  -- redeploy. It rewrites no decision already recorded: a PI approved while
  -- the permission was held keeps its stamp and its trail, because this block
  -- only ever writes forward.
  --
  -- A SECOND STATEMENT, NOT A LONGER FIRST ONE, and that is forced rather than
  -- chosen. order_submissions_guard_pi_approval (20261119000000 §1) CLEARS the
  -- three pi_approved_ columns on any update that moves status, which every
  -- write above does — draft/needs_changes → submitted. Folding the stamp into
  -- those statements would therefore have written it and thrown it away in the
  -- same breath. Stamped here, the guard sees submitted → submitted and applies
  -- its other rule instead: the decision must be bound to the submission it was
  -- made against.
  --
  -- WHICH IS WHY submitted_at IS READ BACK. It is assigned by the status
  -- transition trigger from the transaction clock and is deliberately not
  -- something any caller can supply, so the only way to bind the decision to
  -- this submission is to ask the row what the trigger wrote.
  --
  -- THE TRAIL SAYS BOTH THINGS. 'submitted' was logged above with this actor as
  -- the uploader; 'pi_approved' is logged here with this actor as the approver,
  -- carrying auto_approved = true so a reader can tell a decision that was
  -- taken from one that was merely implied. Requirement and consequence: on an
  -- auto-approved PI the uploader and the approver are the same person, and the
  -- history says so in two separate events rather than pretending otherwise.
  v_can_approve := public.actor_can_approve_order();

  if v_can_approve then
    select submitted_at into v_submitted_at
    from public.order_submissions
    where id = p_submission_id;

    v_pi_now := now();

    update public.order_submissions
       set pi_approved_by            = v_actor,
           pi_approved_at            = v_pi_now,
           pi_approved_submission_at = v_submitted_at
     where id = p_submission_id;

    v_auto_approved := true;

    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
      jsonb_build_object(
        'approved_submission_at', v_submitted_at,
        'order_created',          false,
        'auto_approved',          true,
        'submitted_by',           v_actor
      )
    );
  end if;

  return jsonb_build_object(
    'id',                  p_submission_id,
    'status',              'submitted',
    'item_count',          v_item_count,
    'payment_route',       v_route,
    'verified_payment',    v_verified,
    'unverified_payment',  v_unverified,
    'attached_payment',    v_attached,
    'required_payment',    v_required,
    'exception_requested', v_requested,
    -- Added by 20261224000000. Additive: every key above is unchanged, so a
    -- caller that reads only exception_requested is unaffected.
    'pi_auto_approved',    v_auto_approved,
    'pi_approved_at',      v_pi_now
  );
end;
$$;

-- submit_order_submission_advance_v2_internal: previous definition 20270212000000_order_submission_legacy_advance_doors_closed.sql
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

    -- 20270227000000: the advance is a percentage of the TOTAL BEFORE GST. Without
    -- a usable pre-GST figure nothing can be classified as standard or reduced.
    if v_sub.total_before_gst is null
       or v_sub.total_before_gst = 'NaN'::numeric
       or v_sub.total_before_gst <= 0
       or v_sub.total_before_gst > v_sub.grand_total then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored total before GST, so an advance requirement cannot be declared against it'
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
    v_threshold := public.order_submission_standard_advance_amount(v_sub.total_before_gst);

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
      v_percent := public.order_submission_advance_percent_of(v_sub.total_before_gst, v_amount);
    else
      -- An exception is a percentage OF something, and a zero or absent total
      -- gives nothing to take a percentage of. Refused by name rather than as a
      -- range failure against two zeroes.
      if v_sub.total_before_gst <= 0 then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no positive total before GST, so an advance exception cannot be declared against it'
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
        else public.order_submission_advance_percent_of(v_sub.total_before_gst, v_amount)
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
      v_amount, public.order_submission_advance_amount(v_sub.total_before_gst, v_standard));

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
           advance_exception_rejection_reason = null,
           -- the decision basis goes with the decision (20270212000000): it may only
           -- stand on an approved exception (order_submissions_exception_basis_scope)
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;

  else
    v_effective  := v_percent;
    v_metaamount := coalesce(
      v_amount, public.order_submission_advance_amount(v_sub.total_before_gst, v_percent));

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
              v_sub.advance_exception_percent, v_sub.total_before_gst) = v_amount
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
             advance_exception_rejection_reason = null,
             -- the decision basis goes with the decision (20270212000000): it may only
             -- stand on an approved exception (order_submissions_exception_basis_scope)
             advance_exception_decided_grand_total     = null,
             advance_exception_decided_workbook_sha256 = null,
             advance_exception_decided_payment_terms   = null,
             advance_exception_decided_billing_terms   = null
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
      'advance_base',      v_sub.total_before_gst,
      'total_before_gst',  v_sub.total_before_gst,
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

-- pi_submission_payment_summary: previous definition 20270111120000_finance_payment_reference_survives_verification.sql
CREATE OR REPLACE FUNCTION public.pi_submission_payment_summary(p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
set search_path = public, pg_temp
AS $function$
declare
  v_actor     uuid := auth.uid();
  v_sub       public.order_submissions%rowtype;
  v_verified  numeric := 0;
  v_unverif   numeric := 0;
  v_attached  numeric := 0;
  v_total     numeric;
  v_base      numeric;
  v_base_ok   boolean;
  v_required  numeric;
  v_meets      boolean;
  v_attached_meets boolean;
  v_exc_current boolean;
  v_position  text;
  v_sub_position text;
  v_pi_approved boolean;
  v_pi_approver text;
  v_is_admin  boolean;
  v_fin_all   boolean;
  v_rows      jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id;

  if not found or not public.can_view_order_submission(p_submission_id) then
    raise exception 'ORDER_SUBMISSION_NOT_AVAILABLE: that PI is not available.'
      using errcode = '42501';
  end if;

  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin' and u.is_active
      and coalesce(u.is_deleted, false) = false
  );
  v_fin_all := public.actor_has_module_permission('finance', 'view_all');

  select
    coalesce(sum(a.allocated_amount) filter (
      where public.finance_payment_status_is_verified(f.status)), 0),
    coalesce(sum(a.allocated_amount) filter (
      where f.status in ('pending_approval', 'needs_clarification')), 0)
    into v_verified, v_unverif
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id
    and a.status = 'active';

  v_attached := v_verified + v_unverif;
  v_total    := v_sub.grand_total;
  -- 20270227000000: every advance figure below is measured against the TOTAL
  -- BEFORE GST (advance_base). No usable base: percentages, required and
  -- shortfall are NULL and the gate is not cleared.
  v_base_ok  := v_sub.total_before_gst is not null and v_sub.total_before_gst <> 'NaN'::numeric and v_sub.total_before_gst > 0
                and v_sub.total_before_gst <= coalesce(v_sub.grand_total, v_sub.total_before_gst);
  v_base     := case when v_base_ok then v_sub.total_before_gst end;
  v_required := public.order_submission_required_payment(v_base);
  v_meets    := v_required is not null and v_verified >= v_required;
  v_attached_meets := v_required is not null and v_attached >= v_required;

  v_exc_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  v_position := case
    when not v_base_ok                               then 'payment_required'
    when v_meets                                     then 'standard_met'
    when v_exc_current                               then 'exception_approved'
    when v_sub.advance_exception_status = 'approved' then 'exception_stale'
    when v_sub.advance_exception_status = 'pending'  then 'exception_pending'
    when v_sub.advance_exception_status = 'rejected' then 'exception_rejected'
    when v_unverif > 0                               then 'verification_pending'
    else 'payment_required'
  end;

  -- WHERE THE SUBMISSION RULE STANDS, resolved here so the dialog that asks
  -- for a reason and the door that refuses without one read one answer.
  v_sub_position := case
    when v_attached_meets then 'attached_met'
    when v_attached > 0   then 'attached_partial'
    else 'no_payment'
  end;

  -- THE PI DECISION. On an approved record it is read straight, as the finance
  -- check is: the columns are deliberately kept, and submitted_at no longer
  -- moves.
  v_pi_approved := case
    when v_sub.status = 'approved' then v_sub.pi_approved_at is not null
    else public.order_submission_pi_approved(
           v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at)
  end;

  select u.full_name into v_pi_approver
  from public.users u where u.id = v_sub.pi_approved_by;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
      'allocation_id',     a.id,
      'allocation_status', a.status,
      'allocated_amount',  a.allocated_amount,
      'payment_id',        f.id,
      'request_number',    f.request_number,
      'amount',            f.amount,
      'payment_date',      f.payment_date,
      'payment_mode',      f.payment_mode,
      'reference',         f.proof_note,
      'remarks',           f.sales_note,
      'status',            f.status,
      'is_verified',       public.finance_payment_status_is_verified(f.status),
      'admin_note',        f.admin_note,
      'entered_by',        eb.full_name,
      'verified_by',       vb.full_name,
      'created_at',        f.created_at,
      'verified_at',       f.approved_at,
      'rejected_at',       f.rejected_at,
      'proof_count',       (select count(*) from public.payment_proof_attachments pa
                             where pa.payment_request_id = f.id),
      'can_view_proof',    (v_is_admin or f.submitted_by = v_actor)
    ) as r
    from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
    left join public.users eb on eb.id = f.submitted_by
    left join public.users vb on vb.id = f.approved_by
    where a.order_submission_id = p_submission_id
  ) t;

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'submission_status',    v_sub.status,
    'grand_total',          v_total,
    'advance_base',         v_base,
    'total_before_gst',     v_sub.total_before_gst,
    'advance_base_missing', not v_base_ok,
    'verified_amount',      v_verified,
    'unverified_amount',    v_unverif,
    'attached_amount',      v_attached,
    'verified_percent',     case when not v_base_ok then null
                                 else trunc(v_verified * 100 / v_base, 2) end,
    'unverified_percent',   case when not v_base_ok then null
                                 else trunc(v_unverif  * 100 / v_base, 2) end,
    'attached_percent',     case when not v_base_ok then null
                                 else trunc(v_attached * 100 / v_base, 2) end,
    'needed_for_standard',  public.order_submission_payment_shortfall(v_base, v_verified),
    'needed_attached_for_submission',
                            public.order_submission_payment_shortfall(v_base, v_attached),
    'required_payment',     v_required,
    'meets_standard',       v_meets,
    'attached_meets_standard', v_attached_meets,
    'approval_position',    v_position,
    'submission_position',  v_sub_position,
    'order_gate_cleared',   (v_base_ok and (v_meets or v_exc_current)),
    'pi_approved',          v_pi_approved,
    'pi_approved_at',       case when v_pi_approved then v_sub.pi_approved_at end,
    'pi_approved_by',       case when v_pi_approved then v_sub.pi_approved_by end,
    'pi_approved_by_name',  case when v_pi_approved then v_pi_approver end,
    'pending_balance',      case when v_total is null then null
                                 else greatest(v_total - v_verified, 0) end,
    'standard_percent',     public.order_submission_standard_advance_percent(),
    'advance_condition',    v_sub.advance_condition,
    'exception_status',     v_sub.advance_exception_status,
    'exception_current',    v_exc_current,
    'exception_reason',     v_sub.advance_exception_reason,
    'exception_rejection_reason', v_sub.advance_exception_rejection_reason,
    'payment_terms',        v_sub.payment_terms,
    'billing_terms',        v_sub.billing_terms,
    'can_view_all_finance', v_fin_all,
    'payments',             v_rows
  );
end;
$function$;

-- orders_alignment_requires_advance: previous definition 20270116000000_order_pi_revision_in_force_at_admin_approval.sql
create or replace function public.orders_alignment_requires_advance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pos jsonb;
begin
  if new.production_alignment is distinct from 'aligned'
     or old.production_alignment is not distinct from 'aligned' then
    return new;
  end if;
  if public.in_test_data_cleanup() then return new; end if;

  -- Measured on the value the Order will have after THIS write.
  v_pos := public.order_advance_position(new.id);
  if new.total_value is distinct from old.total_value then
    v_pos := v_pos || jsonb_build_object('ready', false);   -- never align in the same write that changes the value
  end if;
  if (v_pos ->> 'ready')::boolean then
    return new;
  end if;
  if not (v_pos ->> 'value_known')::boolean then
    raise exception
      'ORDER_ADVANCE_VALUE_UNKNOWN: Order % has no total before GST on record, so its 40%% advance cannot be measured. An administrator''s below-40%% approval is needed before production can be aligned.',
      new.display_number
      using errcode = 'P0001';
  end if;
  raise exception
    'ORDER_ADVANCE_BELOW_THRESHOLD: Order % has ₹% verified — % of its ₹% total before GST. ₹% more verified payment, or an administrator''s below-40%% approval, is needed before production can be aligned.%',
    new.display_number,
    to_char((v_pos ->> 'verified')::numeric, 'FM99999999999990.00'),
    coalesce(v_pos ->> 'percent', '0') || '%',
    to_char((v_pos ->> 'advance_base')::numeric, 'FM99999999999990.00'),
    to_char((v_pos ->> 'shortfall')::numeric, 'FM99999999999990.00'),
    case when (v_pos ->> 'awaiting')::numeric > 0
         then format(' ₹%s is awaiting Finance verification.', to_char((v_pos ->> 'awaiting')::numeric, 'FM99999999999990.00'))
         else '' end
    using errcode = 'P0001';
end;
$$;

-- order_advance_hold_recheck: previous definition 20270120000000_order_submission_admin_decisions_ask_permissions.sql
CREATE OR REPLACE FUNCTION public.order_advance_hold_recheck(p_order_id uuid, p_cause text, p_detail jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
set search_path = public, pg_temp
AS $function$
declare
  o         public.orders%rowtype;
  v_pos     jsonb;
  -- Who caused it. A PI revision is applied by the service role on an
  -- administrator's behalf: that administrator is the author (review R5).
  v_actor   uuid := coalesce(auth.uid(), nullif(current_setting('boe.pi_revision_actor', true), '')::uuid);
  v_hold    uuid;
  v_in_rev  boolean := nullif(current_setting('boe.pi_revision_apply', true), '') is not null;
  v_dir     text;
  v_what    text;
  v_title   text;
  v_body    text;
begin
  if p_order_id is null or public.in_test_data_cleanup() then
    return false;
  end if;

  -- The Order's row lock first: an alignment in flight either committed
  -- before this (and is seen below) or waits and then sees this write.
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.production_alignment is distinct from 'aligned'
     or o.status in ('cancelled', 'dispatched') then
    return false;
  end if;

  -- Already held: a PI revision re-values the Order more than once inside its
  -- apply (parse, restore, amendment) before its handoff removes the alignment.
  if exists (select 1 from public.order_advance_holds h where h.order_id = o.id and h.resolved_at is null) then
    return false;
  end if;

  v_pos := public.order_advance_position(o.id);
  if (v_pos ->> 'ready')::boolean then
    return false;
  end if;

  if v_actor is not null and not exists (select 1 from public.users u where u.id = v_actor) then
    v_actor := null;
  end if;

  insert into public.order_advance_holds
    (order_id, cause, order_value, previous_order_value, value_epoch, verified, percent, shortfall, detail, held_by)
  values (o.id, p_cause, o.total_value, nullif(p_detail ->> 'previous_order_value', '')::numeric, o.value_epoch,
          (v_pos ->> 'verified')::numeric, nullif(v_pos ->> 'percent', '')::numeric,
          nullif(v_pos ->> 'shortfall', '')::numeric, coalesce(p_detail, '{}'::jsonb), v_actor)
  returning id into v_hold;

  -- The direction is said only when both figures are known (review R2): a
  -- LOWER value can leave an Order short too, when an approval it relied on
  -- was for the old value.
  v_dir := public.order_value_change_word(nullif(p_detail ->> 'previous_order_value', '')::numeric, o.total_value);
  v_what := case p_cause
    when 'value_changed' then case when v_dir = 'changed' then 'its value changed' else 'its value was ' || v_dir end
    when 'pi_revision'   then 'a revised PI ' || v_dir || ' its value'
    else 'verified payment against it was reduced' end;

  -- A revision's own handoff removes the alignment in this transaction.
  if not v_in_rev then
    perform public.order_operations_handoff_set_alignment(
      o.id, v_actor, false,
      format('Production readiness removed: the verified advance fell below 40%% after %s.', v_what),
      jsonb_build_object('reason', 'advance_hold', 'hold_id', v_hold, 'cause', p_cause));
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (o.id, v_actor, 'order_advance_hold_opened',
          jsonb_build_object('hold_id', v_hold, 'cause', p_cause,
                             'order_value', o.total_value, 'value_known', v_pos -> 'value_known',
                             'verified', v_pos -> 'verified', 'percent', v_pos -> 'percent',
                             'shortfall', v_pos -> 'shortfall') || coalesce(p_detail, '{}'::jsonb));

  v_title := format('Order %s: production readiness removed — advance below 40%%.', o.display_number);
  v_body  := case when (v_pos ->> 'value_known')::boolean then
               format('After %s, ₹%s is verified — %s%% of the ₹%s total before GST. ₹%s more verified payment, or an administrator''s below-40%% approval, is needed before Operations can align production again.',
                      v_what,
                      to_char((v_pos ->> 'verified')::numeric, 'FM99999999999990.00'),
                      v_pos ->> 'percent',
                      to_char((v_pos ->> 'advance_base')::numeric, 'FM99999999999990.00'),
                      to_char((v_pos ->> 'shortfall')::numeric, 'FM99999999999990.00'))
             else format('After %s, the Order has no total before GST on record, so its advance cannot be measured. An administrator''s below-40%% approval is needed before Operations can align production again.', v_what)
             end;
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select r.user_id, null, o.id, 'order_update_production'::notification_type, v_title, v_body, true
    from (select u.id as user_id from public.users u
           where public.user_has_module_permission(u.id, 'orders', 'approve_advance_exception') and u.is_active and coalesce(u.is_deleted, false) = false
          union
          -- The operations reviewer only while they can act on it (review R8):
          -- an inactive or deleted reviewer is not told; the administrators are.
          select r.user_id from public.order_operations_reviewers r
            join public.users u on u.id = r.user_id
           where r.duty = 'pi_handoff' and u.is_active and coalesce(u.is_deleted, false) = false) r
   where r.user_id is distinct from v_actor;

  return true;
end;
$function$;

-- orders_dashboard_summary: previous definition 20270221000000_orders_dashboard_factory_focus.sql
create or replace function public.orders_dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_now        timestamptz := now();
  v_today      date := timezone('Asia/Kolkata', now())::date;
  v_month_from date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  -- The six COMPLETED calendar months before this one.
  v_six_from   date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '6 months')::date;
  v_six_to     date := (date_trunc('month', timezone('Asia/Kolkata', now()))::date - 1);
  v_year_from  date := date_trunc('year', timezone('Asia/Kolkata', now()))::date;
  v_sees_all   boolean;
  v_owner      boolean := public.is_orders_owner();
  v_result     jsonb;
begin
  if not public.module_entry_open('orders') then
    raise exception 'The Orders module is not open to this account' using errcode = '42501';
  end if;

  -- Company-wide revenue is only ever offered to somebody who sees EVERY
  -- Order: an active admin or a holder of orders.view_all. A visibility scope
  -- never counts: it widens Orders, not money.
  v_sees_all :=
    exists (select 1 from public.users u
             where u.id = v_actor and u.role = 'admin' and u.is_active
               and coalesce(u.is_deleted, false) = false)
    or coalesce(public.resolve_permission(v_actor, 'orders', 'view_all'), false);

  with open_orders as materialized (
    select o.id, o.display_number, o.client_name, o.status, o.confirm_date, o.created_at,
           o.total_value, o.production_alignment,
           -- PAYMENT-DERIVED FIGURES (verified %, shortfall, exceptions) are shown only for an
           -- Order the reader may open WITHOUT a visibility scope. A scope widens Orders, not money.
           public.can_view_order_unscoped(o.id) as full_view
      from public.orders o
     where coalesce(o.is_test_data, false) = false
       and o.status not in ('dispatched', 'cancelled')
       and public.can_read_order_detail(o.id)
  ),
  pos as materialized (
    select d.id as order_id, public.order_advance_position(d.id) as pos
      from open_orders d
  ),
  reviewer as (
    select r.user_id, u.full_name
      from public.order_operations_reviewers r
      left join public.users u on u.id = r.user_id
     where r.duty = 'pi_handoff'
  ),
  aligned as (
    -- WHOSE COURT IT IS IN, and SINCE WHEN. An order flagged for clarification
    -- is waiting on the approver, an order held for advance on the money, an
    -- order with no reviewer on an administrator: none of them is "waiting for
    -- the reviewer", and none is called that.
    select coalesce(jsonb_agg(x order by (x ->> 'rank')::int, (x ->> 'waiting_seconds')::numeric desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', d.id, 'display_number', d.display_number, 'client_name', d.client_name,
               'status', d.status,
               'state', st.state,
               'waiting_on', case st.state
                   when 'awaiting_reviewer'     then 'reviewer'
                   when 'awaiting_unassigned'   then 'administrator'
                   when 'clarification_needed'  then 'approver'
                   when 'held_advance'          then 'payment'
                   when 'accepted_not_aligned'  then 'reviewer'
                   else 'legacy' end,
               'rank', case st.state
                   when 'awaiting_reviewer' then 1 when 'accepted_not_aligned' then 2
                   when 'awaiting_unassigned' then 3 when 'clarification_needed' then 4
                   when 'held_advance' then 5 else 6 end,
               'since', st.since,
               'waiting_seconds', greatest(extract(epoch from (v_now - st.since)), 0),
               'detail', case when st.state = 'clarification_needed' then h.clarification_reason end,
               -- A payment-derived flag: withheld for an Order seen only through a scope.
               'advance_blocks', d.full_view and not coalesce((p.pos ->> 'ready')::boolean, false)) as x
        from open_orders d
        join pos p on p.order_id = d.id
        left join lateral (
          select oh.status, oh.assigned_to, oh.approved_at, oh.clarification_reason, oh.clarification_at, oh.accepted_at
            from public.order_operations_handoffs oh
           where oh.order_id = d.id and oh.superseded_at is null
           order by oh.created_at desc limit 1) h on true
        cross join lateral (
          select case
                   when h.status = 'clarification_needed' then 'clarification_needed'
                   when h.status = 'awaiting' and h.assigned_to is null then 'awaiting_unassigned'
                   when h.status = 'awaiting' then 'awaiting_reviewer'
                   when jsonb_typeof(p.pos -> 'hold') = 'object' then 'held_advance'
                   when h.status = 'accepted' then 'accepted_not_aligned'
                   else 'no_handoff' end as state,
                 case
                   when h.status = 'clarification_needed' then coalesce(h.clarification_at, h.approved_at)
                   when h.status = 'awaiting' then h.approved_at
                   when jsonb_typeof(p.pos -> 'hold') = 'object' then (p.pos -> 'hold' ->> 'held_at')::timestamptz
                   when h.status = 'accepted' then h.accepted_at
                   else d.created_at end as since) st
       where d.production_alignment is distinct from 'aligned'
    ) s
  ),
  advance as (
    -- Verified advance below 40%: the gate's own shortfall > 0. An approved
    -- exception does NOT remove an order: it is listed, and said.
    select coalesce(jsonb_agg(x order by (x ->> 'shortfall')::numeric desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', d.id, 'display_number', d.display_number, 'client_name', d.client_name,
               'status', d.status, 'order_value', d.total_value,
               -- 20270227000000: the percentage and the shortfall are of the TOTAL
               -- BEFORE GST (advance_base), not of order_value.
               'advance_base', p.pos -> 'advance_base',
               'verified', p.pos -> 'verified',
               -- Truncated, never rounded up: 39.996% must not read "40.00%"
               -- beside a shortfall.
               'percent', trunc(100 * (p.pos ->> 'verified')::numeric / nullif((p.pos ->> 'advance_base')::numeric, 0), 2),
               'shortfall', p.pos -> 'shortfall',
               'exception_approved', (jsonb_typeof(p.pos -> 'exception') = 'object'),
               'held', (jsonb_typeof(p.pos -> 'hold') = 'object')) as x
        from open_orders d join pos p on p.order_id = d.id
       where d.full_view
         and coalesce((p.pos ->> 'value_known')::boolean, false)
         and coalesce((p.pos ->> 'shortfall')::numeric, 0) > 0
    ) s
  ),
  ff_status as (
    -- Fabric and finish, each on its own, for Orders more than 15 days past the
    -- client confirmation date. A recorded status other than Fully Approved is
    -- PENDING. No record at all is PENDING too for an Order created since tracking
    -- began (approval is required and has not been given: 'no_approval_recorded'),
    -- and NOT RECORDED — ambiguous history — for an older Order.
    select d.id, d.display_number, d.client_name, d.status, d.confirm_date,
           (v_today - d.confirm_date) as days_since,
           k.kind,
           coalesce(k.recorded_status,
                    case when d.created_at >= (select st.fabric_finish_tracking_from from public.orders_dashboard_settings st where st.id)
                         then 'no_approval_recorded' end) as effective_status
      from open_orders d
     cross join lateral (
       select kinds.kind,
              (select e.status from public.order_approval_events e
                where e.order_id = d.id and e.approval_kind = kinds.kind
                order by e.created_at desc, e.id desc limit 1) as recorded_status
         from (values ('fabric'), ('finish')) as kinds(kind)) k
     where d.confirm_date is not null and (v_today - d.confirm_date) > 15
  ),
  fabric_pending as (
    select coalesce(jsonb_agg(x order by (x ->> 'days_since_confirmation')::int desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', f.id, 'display_number', f.display_number, 'client_name', f.client_name,
               'status', f.status, 'confirm_date', f.confirm_date,
               'days_since_confirmation', max(f.days_since),
               'pending', jsonb_agg(jsonb_build_object('kind', f.kind, 'status', f.effective_status) order by f.kind)
                            filter (where f.effective_status is not null and f.effective_status <> 'fully_approved'),
               'not_recorded', coalesce(jsonb_agg(f.kind order by f.kind) filter (where f.effective_status is null), '[]'::jsonb)) as x
        from ff_status f
       group by f.id, f.display_number, f.client_name, f.status, f.confirm_date
      having count(*) filter (where f.effective_status is not null and f.effective_status <> 'fully_approved') > 0
    ) s
  ),
  fabric_unrecorded as (
    select coalesce(jsonb_agg(x order by (x ->> 'days_since_confirmation')::int desc, x ->> 'display_number'), '[]'::jsonb) j
    from (
      select jsonb_build_object(
               'order_id', f.id, 'display_number', f.display_number, 'client_name', f.client_name,
               'status', f.status, 'confirm_date', f.confirm_date,
               'days_since_confirmation', max(f.days_since),
               'not_recorded', jsonb_agg(f.kind order by f.kind) filter (where f.effective_status is null)) as x
        from ff_status f
       group by f.id, f.display_number, f.client_name, f.status, f.confirm_date
      having count(*) filter (where f.effective_status is null) > 0
         and count(*) filter (where f.effective_status is not null and f.effective_status <> 'fully_approved') = 0
    ) s
  ),
  gaps as (
    select jsonb_build_object(
             'open_orders', (select count(*) from open_orders),
             'advance_value_unknown', (select count(*) from pos p join open_orders d on d.id = p.order_id
                                        where d.full_view and not coalesce((p.pos ->> 'value_known')::boolean, false)),
             'advance_outside_scope', (select count(*) from open_orders where not full_view),
             'no_confirm_date', (select count(*) from open_orders where confirm_date is null)) j
  ),
  rev as (
    -- Revenue: each non-cancelled, non-test Order ONCE, at its current product
    -- value. The Order's own figure is the PI's gross; where the PI in force
    -- states a discount and the Order still carries that gross, the PI's
    -- after-discount subtotal is the product value — the meaning every PI and
    -- Order screen already gives the words (orderWorkspace.orderProductValue).
    select o.id, o.confirm_date,
           case
             when o.total_product_value is null or o.total_product_value = 'NaN'::numeric then null
             when coalesce(pi.d, 0) <> 0 and pi.g is not null and o.total_product_value = pi.g and pi.st is not null
               then pi.st
             else o.total_product_value end as pv,
           (coalesce(pi.d, 0) <> 0
             and not (pi.g is not null and o.total_product_value = pi.g and pi.st is not null)) as before_discount
      from public.orders o
      left join lateral (
        select s.gross_product_amount as g, s.discount_amount as d, s.subtotal_after_discount as st
          from public.order_submissions s
         where s.id = coalesce(
                 (select v.submission_id from public.order_pi_versions v
                   where v.order_id = o.id and v.status = 'approved'
                   order by v.version_number desc limit 1),
                 o.source_order_submission_id)) pi on true
     where v_sees_all
       and coalesce(o.is_test_data, false) = false
       and o.status <> 'cancelled'
  ),
  revenue as (
    select jsonb_build_object(
             'currency', 'INR',
             'basis', 'product_value',
             'date_basis', 'confirm_date',
             'current_month', jsonb_build_object('from', v_month_from, 'to', v_today,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_month_from and v_today), 0),
               'orders', count(*) filter (where confirm_date between v_month_from and v_today and pv is not null)),
             'last_six_months', jsonb_build_object('from', v_six_from, 'to', v_six_to,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_six_from and v_six_to), 0),
               'orders', count(*) filter (where confirm_date between v_six_from and v_six_to and pv is not null)),
             'current_year', jsonb_build_object('from', v_year_from, 'to', v_today,
               'amount', coalesce(sum(pv) filter (where confirm_date between v_year_from and v_today), 0),
               'orders', count(*) filter (where confirm_date between v_year_from and v_today and pv is not null)),
             'gaps', jsonb_build_object(
               'no_confirm_date', count(*) filter (where confirm_date is null),
               'future_confirm_date', count(*) filter (where confirm_date > v_today),
               -- In a period but with no product value on record: excluded, and said.
               'no_product_value_in_year', count(*) filter (where confirm_date between v_year_from and v_today and pv is null),
               -- Still the figure BEFORE the PI's discount (amended away from the PI).
               'before_discount_in_year', count(*) filter (where confirm_date between v_year_from and v_today and before_discount))) j
      from rev
    having v_sees_all
  ),
  focus as (
    -- Factory Focus: everybody with Orders entry sees WHICH Orders; what else
    -- they see follows Order visibility. No client, no note, no link, no status
    -- for an Order the reader cannot open.
    select jsonb_build_object(
      'active', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'selection_id', d.id,
                 'display_number', o.display_number,
                 'selected_month', d.selected_month,
                 'selected_at', d.selected_at,
                 'salesperson_name', sp.full_name,
                 'can_open', can_open.v,
                 'order_id', case when can_open.v then o.id end,
                 'client_name', case when can_open.v then o.client_name end,
                 'status', case when can_open.v then o.status end,
                 'note', case when can_open.v then d.note end) order by d.selected_at)
          from public.order_factory_focus_selections d
          join public.orders o on o.id = d.order_id
          left join public.users sp on sp.id = d.salesperson_id
          cross join lateral (select public.can_read_order_detail(o.id) as v) can_open
         where d.removed_at is null
           and coalesce(o.is_test_data, false) = false), '[]'::jsonb),
      -- The removal reason goes to the Order's salesperson, for a month.
      'removed_for_you', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'display_number', o.display_number,
                 'selected_month', d.selected_month,
                 'removed_at', d.removed_at,
                 'removal_reason', d.removal_reason) order by d.removed_at desc)
          from public.order_factory_focus_selections d
          join public.orders o on o.id = d.order_id
         where d.removed_at is not null
           and d.salesperson_id = v_actor
           and d.removed_at > v_now - interval '30 days'), '[]'::jsonb),
      'month_start', v_month_from,
      'month_used', case when v_owner then
          (select count(*) from public.order_factory_focus_selections d where d.selected_month = v_month_from) end,
      'month_limit', 2,
      'can_manage', v_owner) j
  )
  select jsonb_build_object(
    'today', v_today,
    'now', v_now,
    'viewer', jsonb_build_object(
      'sees_all_orders', v_sees_all,
      'can_view_revenue', v_sees_all,
      'can_manage_focus', v_owner),
    'alignment_reviewer', (select jsonb_build_object('user_id', user_id, 'name', full_name) from reviewer),
    'groups', jsonb_build_object(
      'not_aligned', (select j from aligned),
      'advance_below_40', (select j from advance),
      'fabric_finish_pending', (select j from fabric_pending),
      'fabric_finish_unrecorded', (select j from fabric_unrecorded)),
    'gaps', (select j from gaps),
    'revenue', (select j from revenue),
    'factory_focus', (select j from focus))
  into v_result;

  return v_result;
end;
$$;

-- ═══ 6. It took ═════════════════════════════════════════════════════════════

do $verify$
declare
  v_bad     text;
  v_n       integer;
  v_aligned integer;
begin
  -- The formula, on the worked example (pre-GST 1,20,000; GST 21,600; grand 1,41,600).
  if public.order_submission_required_payment(120000) is distinct from 48000
     or public.order_submission_payment_shortfall(120000, 48000) is distinct from 0
     or public.order_submission_payment_shortfall(120000, 47999.99) is distinct from 0.01
     or public.order_submission_payment_ready(120000, 48000, null) is distinct from true
     or public.order_submission_payment_ready(120000, 47999.99, null) is distinct from false
     or public.order_submission_advance_percent_of(120000, 48000) is distinct from 40.00
     or public.order_submission_standard_advance_amount(120000) is distinct from 48000
     or public.order_submission_advance_amount(120000, 30) is distinct from 36000 then
    raise exception 'ASSERTION FAILED: the 40%% advance is not 40%% of the total before GST';
  end if;
  -- ...and 48,000 against the OLD denominator would not have been enough.
  if public.order_submission_payment_ready(141600, 48000, null) is distinct from false then
    raise exception 'ASSERTION FAILED: the helper no longer takes the base it is given';
  end if;

  -- A base that is missing is explicit and never satisfies anything.
  if public.order_submission_required_payment(null) is not null
     or public.order_submission_required_payment(0) is not null
     or public.order_submission_required_payment(-1) is not null
     or public.order_submission_required_payment('NaN'::numeric) is not null
     or public.order_submission_payment_shortfall(null, 1) is not null
     or public.order_submission_payment_shortfall(0, 1) is not null
     or public.order_submission_payment_shortfall('NaN'::numeric, 1) is not null
     or public.order_submission_payment_shortfall(100, null) is not null
     or public.order_submission_advance_percent_of(0, 5) is not null
     or public.order_submission_advance_percent_of(null, 5) is not null
     or public.order_submission_standard_advance_amount(0) is not null
     or public.order_submission_advance_amount(0, 10) is not null
     or public.order_submission_payment_ready(null, 999999, 'approved') is distinct from false
     or public.order_submission_payment_ready(0, 999999, 'approved') is distinct from false
     or public.order_submission_payment_ready('NaN'::numeric, 999999, null) is distinct from false
     or public.order_submission_payment_ready(100, null, null) is distinct from false
     or public.order_submission_payment_ready(100, null, 'approved') is distinct from true then
    raise exception 'ASSERTION FAILED: a missing, zero, NaN or negative base satisfied a gate or returned a number';
  end if;

  -- The literal 40 in the constraint is the function's 40.
  if public.order_submission_standard_advance_percent() <> 40
     or pg_get_constraintdef((select c.oid from pg_constraint c
                               where c.conrelid = 'public.order_submissions'::regclass
                                 and c.conname = 'order_submissions_advance_amount_matches_condition')) not like '%total_before_gst%(40)::numeric%'
     or not (select c.convalidated from pg_constraint c
              where c.conrelid = 'public.order_submissions'::regclass
                and c.conname = 'order_submissions_advance_amount_matches_condition') then
    raise exception 'ASSERTION FAILED: the amount/condition constraint is missing, unvalidated or has drifted from the standard percent';
  end if;

  -- The new readers exist, and are client-callable only where intended.
  if has_function_privilege('anon', 'public.order_total_before_gst(public.orders)', 'execute')
     or not has_function_privilege('authenticated', 'public.order_total_before_gst(public.orders)', 'execute')
     or has_function_privilege('service_role', 'public.order_total_before_gst(public.orders)', 'execute')
     or has_function_privilege('authenticated', 'public.order_advance_base(uuid)', 'execute')
     or has_function_privilege('anon', 'public.order_advance_base(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.order_advance_numeric(text)', 'execute') then
    raise exception 'ASSERTION FAILED: the pre-GST readers have the wrong grants';
  end if;

  -- Replacing a function kept its privileges, security attribute and search_path.
  select string_agg(a.sig, ', ') into v_bad
    from pg_temp.pi_advance_acl_before a
    join pg_proc p on p.oid = a.oid
   where p.proacl::text is distinct from a.acl
      or p.prosecdef is distinct from a.secdef
      or p.proconfig::text is distinct from a.config;
  if v_bad is not null then
    raise exception 'ASSERTION FAILED: ACL, SECURITY DEFINER or search_path changed on: %', v_bad;
  end if;
  if exists (select 1 from pg_proc p
              where p.oid in (select oid from pg_temp.pi_advance_acl_before)
                and p.prosecdef and coalesce(p.proconfig::text, '') not like '%search_path=public, pg_temp%') then
    raise exception 'ASSERTION FAILED: a definer lost its pinned search_path';
  end if;

  -- The doors name the base: the old denominator is gone from every body that
  -- computes an advance (grand_total is still read for the identity check, the
  -- order value and the not-above-total rule, never passed to the helpers).
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where p.oid in (select oid from pg_temp.pi_advance_acl_before)
     and p.prosrc ~ 'order_submission_(required_payment|payment_shortfall|advance_percent_of|standard_advance_amount|advance_amount)\(\s*(v_sub\.grand_total|s\.grand_total|o\.total_value|v_total\M)';
  if v_bad is not null then
    raise exception 'ASSERTION FAILED: still measured against the grand total: %', v_bad;
  end if;

  -- What the owner should look at before the first payment change or revision.
  select count(*) into v_aligned
    from public.orders o
   where o.production_alignment = 'aligned'
     and o.status not in ('cancelled', 'dispatched')
     and public.order_advance_base(o.id) is null;
  select count(*) into v_n
    from public.order_submissions s
   where s.status in ('draft', 'submitted', 'needs_changes')
     and s.grand_total is not null
     and (s.total_before_gst is null or s.total_before_gst <= 0 or s.total_before_gst > s.grand_total);
  raise notice '20270227000000: % aligned Order(s) have no derivable total before GST (they read as not ready until a payment, a PI revision or an administrator''s approval says otherwise; nothing was written); % open PI(s) have a grand total but no usable total before GST (their approval / submission is refused as incomplete until the PI is corrected).', v_aligned, v_n;
end $verify$;

drop table if exists pg_temp.pi_advance_acl_before;

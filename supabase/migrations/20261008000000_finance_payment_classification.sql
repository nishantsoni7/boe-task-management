-- ═════════════════════════════════════════════════════════════════════════════
-- One classification of a payment, for Order Management and for Finance
-- ═════════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20261007000000. Forward-only; no earlier migration is edited.
--
-- ── THE QUESTION ─────────────────────────────────────────────────────────────
--
-- A payment may be connected to one or more Confirmed Orders, to one or more PI
-- Drafts, to BOTH through split allocations, or to nothing yet. Two modules ask
-- which of those a payment is, and until now each answered for itself: Finance
-- read `order_id`/`order_request_id` and called the rest "Non-Linked"; Orders
-- read its own allocations and could not see the rest of a payment at all.
--
-- This migration adds the ONE answer, to the projection both already read:
--
--   order_allocated_total     money attributed to Confirmed Orders
--   pi_allocated_total        money attributed to PI Drafts
--   active_allocation_count   how many live allocations the caller can see
--   attribution_complete      whether this caller's sight of them is complete
--   available_balance         what is left to allocate — null when unknowable
--   is_linked_to_order        the `Linked to Orders` narrowing
--   is_linked_to_pi           the `Linked to PI Drafts` narrowing
--   is_available_to_allocate  the `Available to Allocate` narrowing
--
-- ── IT IS NOT A SECOND ATTRIBUTION FORMULA ───────────────────────────────────
--
-- Every figure follows the canonical rule stated in
-- src/lib/finance/paymentAttribution.ts and implemented by
-- order_linked_payment_total() (20261005000000) and by this view's own
-- `attributed_total` (20261004000000):
--
--   1. any active allocation  → the allocations are authoritative, and the
--                               payment's own order_id contributes NOTHING
--   2. none, but a direct link → the link attributes the WHOLE payment
--   3. reversed allocations count for nothing
--   4. what is left after active allocations is AVAILABLE
--
-- The two new totals are that same `attributed_total` SPLIT BY THE KIND of
-- target it went to, and they sum back to it exactly — asserted below. No branch
-- here decides attribution differently from the branch beside it.
--
-- A RETIRED ORDER REQUEST ATTRIBUTES NOTHING, and that is the canonical rule
-- rather than a new decision: rule 2 names `order_id` and only `order_id`.
-- `order_request_id` has never attributed a rupee under it. So a historical
-- payment parked on a retired Order Request, with no allocations, now reads as
-- fully AVAILABLE — which is the truth about it, and the point of surfacing it.
--
-- ── WHY THE BALANCE IS SOMETIMES NULL ────────────────────────────────────────
--
-- The view is SECURITY INVOKER, so the allocation sums are what THIS CALLER may
-- read. A reader who reaches a payment through PI or Order participation
-- (20260919000000 §4) sees only the allocations naming records they can open, so
-- their sum UNDERSTATES the attribution — which OVERSTATES the balance.
--
-- Overstating free money is the one error direction that must never happen: it
-- would put rupees into an allocation queue that are already committed, and
-- somebody would allocate them twice. So `available_balance` is stated only when
-- the caller's sight is COMPLETE, and is null otherwise. Completeness is the
-- same two cases payment_active_allocation_totals() (20261005000000 §1) already
-- treats as complete, and for the same reasons:
--
--   * company-wide Finance sight (finance.view_all, admins included), which
--     reads every allocation row there is; or
--   * the caller submitted the payment, which
--     finance_payment_allocations_payment_owner_select entitles to every
--     allocation of THAT payment.
--
-- THIS IS NOT A WIDENING, AND MUST NOT BECOME ONE. `attribution_complete` is a
-- statement about what the caller can already see. It is NOT a definer sum, and
-- making it one would tell every reader how a payment is split whether or not
-- they may see the allocations that say so. The under-stating direction is kept
-- deliberately: `is_linked_to_order` and `is_linked_to_pi` are honest about what
-- the caller can see, and `available` is simply withheld.
--
-- ── REJECTED MONEY IS NOT MONEY ──────────────────────────────────────────────
--
-- The three `is_*` booleans are FALSE for a rejected payment, whatever its
-- figures say, so no narrowing can return one and no count can include one. The
-- figures themselves stay truthful — a screen that opens a rejected payment
-- still shows where its money went — but the classification refuses it, in the
-- database, so a client that forgot the status filter cannot inflate a total.
--
-- AWAITING-VERIFICATION MONEY IS NOT EXCLUDED. It is real, recorded and
-- allocatable (allocate_payment_to_target admits it and refuses only rejected
-- money), so it classifies exactly like verified money. Keeping the two apart is
-- the caller's job and the caller has what it needs: `status` is right there on
-- the row, and every surface prints it.
--
-- ── WHAT IS STILL DELIBERATELY NOT EXPOSED ───────────────────────────────────
--
-- No allocation id, and no list of WHICH Orders or PIs a payment names.
-- 20260921000000 §8a's boundary stands: the projection says how much and to what
-- KIND, never to which record. A caller that needs the split reads
-- finance_payment_allocations under its own RLS, which is what the payment
-- detail panel already does.
--
-- ── NO NEW STORAGE, NO NEW INDEX, NO POLICY CHANGE ───────────────────────────
--
-- Nothing is stored: this is a read-time projection over
-- finance_payment_allocations, which remains the only record of what money
-- belongs to. The aggregate is keyed on payment_request_id where status =
-- 'active' — exactly finance_payment_allocations_payment_active_idx
-- (20260918000000) — so no index is added. No policy is created, dropped,
-- altered or widened by this file.

begin;

-- ═══ 1. The projection ══════════════════════════════════════════════════════
--
-- CREATE OR REPLACE, not DROP and CREATE, for the reason 20261004000000 records:
-- replacing keeps the view's oid, its privileges and anything depending on it.
-- Replace permits adding columns only AT THE END, which is why the eight new
-- ones are last and every existing column keeps its name, its type and its
-- position.
--
-- THE BODY IS RESTRUCTURED, THE OUTPUT IS NOT. The row source moves into an
-- inner subquery so the sums and the permission probe are computed ONCE and the
-- derived columns can read them by name instead of restating a four-branch CASE
-- five times. Every existing output column is the same expression it was in
-- 20261004000000 §1, reading the same inputs — asserted column by column below.

create or replace view public.finance_received_payments
with (security_invoker = true) as
select
  b.id,
  b.request_number,
  b.client_name,
  b.amount,
  b.payment_date,
  b.payment_mode,
  b.received_in,
  b.proof_note,
  b.order_number,
  b.order_id,
  b.order_request_id,
  b.order_request_number,
  b.sales_note,
  b.status,
  b.payment_against,
  b.submitted_by,
  b.approved_by,
  b.admin_note,
  b.created_at,
  b.approved_at,

  b.submitted_by_name,
  b.approved_by_name,

  b.allocated_order_id,
  b.allocated_order_number,

  b.is_order_allocated,

  b.allocated_total,

  -- ── attributed_total, unchanged from 20261004000000 ──
  --
  --   any active allocation  → the allocations are authoritative
  --   none, but a direct link → the link attributes the WHOLE payment
  --   neither                 → nothing is attributed
  b.attributed_total,

  -- ── allocation_state, unchanged from 20261004000000 ──
  --
  -- Derived from the attributed figure and the payment's own amount, so the
  -- boundaries are exact at any figure. 'over' is NOT an expected state — the
  -- capacity trigger refuses to create it — which is exactly why it stays
  -- nameable rather than rounded into 'full'.
  b.allocation_state,

  -- ═══ NEW ═══════════════════════════════════════════════════════════════════

  -- ── The attributed total, split by the KIND of target ──
  --
  -- THE SPLIT OF A FIGURE THE RULE ALREADY PRODUCED, never a re-derivation. Rule
  -- 1 first: when any active allocation exists, each kind gets its own active
  -- share and the direct link contributes nothing — not even to the Order it
  -- names. Rule 2 second: with no active allocation, the direct link attributes
  -- the WHOLE payment to an Order.
  --
  -- A PI HAS NO FALLBACK, and that asymmetry is the schema's, not a choice made
  -- here: `finance_payment_requests` carries `order_id` and no PI equivalent, so
  -- an unallocated payment can never be attributed to a PI Draft.
  --
  -- The two sum to attributed_total exactly, at every figure — §3g asserts it.
  case
    when b.allocated_total > 0   then b.order_allocated_total
    when b.order_id is not null  then b.amount
    else 0
  end as order_attributed_total,

  case
    when b.allocated_total > 0 then b.pi_allocated_total
    else 0
  end as pi_attributed_total,

  -- The raw allocation-ledger sums, before the rule is applied. Exposed beside
  -- the attributed figures because a screen showing "₹4L of ₹10L allocated"
  -- needs the ledger's own number, and deriving it back out of the attributed
  -- pair would be impossible on a legacy-linked payment.
  b.order_allocated_total,
  b.pi_allocated_total,

  -- How many live allocations this caller can see. ACTIVE ONLY: a reversed
  -- allocation is a withdrawn claim, it stays in the Finance trail where its
  -- reason is, and counting it would tell a reader money is spoken for when it
  -- is free.
  b.active_allocation_count,

  -- ── Whether this caller's sight of the allocations is complete ──
  --
  -- A STATEMENT ABOUT THE CALLER, not about the money, and deliberately not a
  -- definer sum — see the header. False is the safe answer and is what a caller
  -- with no session gets.
  b.attribution_complete,

  -- ── What is left to allocate ──
  --
  -- amount - attributed, floored at zero, and NULL when it may not be stated.
  -- Null is not zero and the two must never collapse: zero means "nothing is
  -- free", null means "you cannot be told", and only one of those should keep a
  -- payment out of somebody's allocation queue for the right reason.
  case
    when not b.attribution_complete then null::numeric
    when b.amount is null           then null::numeric
    else greatest(b.amount - b.attributed_total, 0)
  end as available_balance,

  -- ── The three narrowings ──
  --
  -- FALSE FOR A REJECTED PAYMENT, whatever its figures say, so no view can
  -- return one and no count can include one. Rejected money is not money, and
  -- this is the layer that enforces it rather than trusting every client to
  -- remember a status filter.
  --
  -- NEVER NULL. A null boolean would silently fail `eq.true` AND `eq.false`, so
  -- a payment could vanish from every narrowing at once — which is precisely the
  -- failure mode a classification exists to prevent.
  (
    coalesce(b.status, '') <> 'rejected'
    and coalesce(
      case
        when b.allocated_total > 0  then b.order_allocated_total
        when b.order_id is not null then b.amount
        else 0
      end, 0) > 0
  ) as is_linked_to_order,

  (
    coalesce(b.status, '') <> 'rejected'
    and coalesce(case when b.allocated_total > 0 then b.pi_allocated_total else 0 end, 0) > 0
  ) as is_linked_to_pi,

  -- INCLUDES PARTIALLY ALLOCATED MONEY, which is the whole reason it is a
  -- balance and not a flag: a ₹10L payment with ₹4L allocated has ₹6L that still
  -- needs somebody, and a yes/no "is it allocated" would hide it behind a
  -- confident "yes".
  (
    coalesce(b.status, '') <> 'rejected'
    and b.attribution_complete
    and b.amount is not null
    and greatest(b.amount - b.attributed_total, 0) > 0
  ) as is_available_to_allocate

from (
  select
    f.id,
    f.request_number,
    f.client_name,
    f.amount,
    f.payment_date,
    f.payment_mode,
    f.received_in,
    f.proof_note,
    f.order_number,
    f.order_id,
    f.order_request_id,
    f.order_request_number,
    f.sales_note,
    f.status,
    f.payment_against,
    f.submitted_by,
    f.approved_by,
    f.admin_note,
    f.created_at,
    f.approved_at,

    eb.full_name as submitted_by_name,
    ab.full_name as approved_by_name,

    alloc.order_id       as allocated_order_id,
    alloc.display_number as allocated_order_number,

    (alloc.order_id is not null) as is_order_allocated,

    coalesce(totals.allocated_total, 0)       as allocated_total,
    coalesce(totals.order_allocated_total, 0) as order_allocated_total,
    coalesce(totals.pi_allocated_total, 0)    as pi_allocated_total,
    coalesce(totals.active_allocation_count, 0)::integer as active_allocation_count,

    case
      when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
      when f.order_id is not null                  then f.amount
      else 0
    end as attributed_total,

    case
      when f.amount is null then null
      when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
                 when f.order_id is not null                  then f.amount
                 else 0 end) = 0                     then 'unallocated'
      when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
                 when f.order_id is not null                  then f.amount
                 else 0 end) > f.amount              then 'over'
      when (case when coalesce(totals.allocated_total, 0) > 0 then coalesce(totals.allocated_total, 0)
                 when f.order_id is not null                  then f.amount
                 else 0 end) = f.amount              then 'full'
      else 'partial'
    end as allocation_state,

    -- ── Completeness ──
    --
    -- The permission probe is an UNCORRELATED SCALAR SUBQUERY on purpose:
    -- PostgreSQL turns one into an InitPlan and evaluates it ONCE for the whole
    -- statement, rather than once per payment on a fifty-row page. Written as a
    -- plain function call it would be a per-row call into the permission engine.
    -- COALESCED AS A WHOLE, not branch by branch. `f.submitted_by = auth.uid()`
    -- is NULL when there is no session, and `false or null` is null — which
    -- would make `not attribution_complete` null too and send the balance down
    -- the wrong CASE branch. False is the safe answer and is what a caller with
    -- no session must get.
    coalesce(
      coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
      or f.submitted_by = auth.uid(),
      false
    ) as attribution_complete

  from public.finance_payment_requests f
  left join public.users eb on eb.id = f.submitted_by
  left join public.users ab on ab.id = f.approved_by
  left join lateral (
    select a.order_id, o.display_number
    from public.finance_payment_allocations a
    left join public.orders o on o.id = a.order_id
    where a.payment_request_id = f.id
      and a.status = 'active'
      and a.order_id is not null
    order by a.created_at, a.id
    limit 1
  ) alloc on true
  -- ONE ROW BY CONSTRUCTION: an aggregate with no GROUP BY over a correlated
  -- filter always yields exactly one row, so this cannot multiply a payment.
  -- Uses finance_payment_allocations_payment_active_idx directly — the predicate
  -- is that index's predicate and the key is its key — and the three sums plus
  -- the count are one pass over the same rows, not four.
  left join lateral (
    select
      sum(a.allocated_amount)                                              as allocated_total,
      sum(a.allocated_amount) filter (where a.order_id is not null)        as order_allocated_total,
      sum(a.allocated_amount) filter (where a.order_submission_id is not null)
                                                                           as pi_allocated_total,
      count(*)                                                             as active_allocation_count
    from public.finance_payment_allocations a
    where a.payment_request_id = f.id
      and a.status = 'active'
  ) totals on true
) b;

comment on view public.finance_received_payments is
  'Every payment row a caller may already read, plus ONE canonical classification of what it is connected to: how much is attributed to Confirmed Orders, how much to PI Drafts, how many live allocations say so, what is left to allocate, and the three narrowings Order Management and Finance both filter by. Every figure follows the canonical attribution rule — active allocations are authoritative whenever any exists, the payment''s own order_id is the fallback only when none does, reversed allocations count for nothing — so the two kind totals sum to attributed_total exactly and never restate the rule differently. A retired Order Request attributes nothing, which is the rule rather than a special case. SECURITY INVOKER: every underlying policy is evaluated as the caller, so this can show nothing the tables beneath it would not; in consequence available_balance is NULL, never a number, unless the caller''s sight of the allocation table is complete for that payment (finance.view_all, admins included, or their own submitted payment) — an incomplete sum would overstate free money, and overstating free money is the one error that gets rupees allocated twice. The three is_* booleans are FALSE for a rejected payment, in the database, so no narrowing or count can include one; awaiting-verification money classifies normally and is kept apart by its own status column. Exposes no allocation id and no list of which records a payment names. Exactly one row per payment. Read-only projection; it stores nothing and is not a second ledger.';

-- ═══ 2. Privileges, normalised again ════════════════════════════════════════
--
-- Expected to be no-ops — CREATE OR REPLACE does not re-run the platform's
-- default privileges — and stated anyway for the reason 20260921000000 §8a and
-- 20261004000000 §2 both record: Supabase bootstraps `alter default privileges
-- ... grant all on tables to postgres, anon, authenticated, service_role`, and an
-- object that ever passes through a plain CREATE is born with INSERT, UPDATE and
-- DELETE for every client role. The one privilege this object may carry is
-- SELECT. Revoke first, then grant: the other order erases the grant.

revoke all privileges on public.finance_received_payments
  from public, anon, authenticated;

grant select on public.finance_received_payments to authenticated;

-- ═══ 3. Apply-time assertions ═══════════════════════════════════════════════

do $$
declare
  v_opt  text;
  v_cols text[];
  v_col  text;
begin
  -- 3a. Still SECURITY INVOKER. If a replace ever dropped this option the view
  -- would evaluate as its OWNER and show every caller every payment in the
  -- company. This is the single most important line in the file.
  select coalesce(
           (select option_value
              from pg_options_to_table(c.reloptions)
             where option_name = 'security_invoker'),
           'false')
    into v_opt
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'finance_received_payments';

  if v_opt is distinct from 'true' then
    raise exception
      'finance_received_payments must remain security_invoker=true (found "%")', v_opt;
  end if;

  -- FROM pg_catalog, NOT information_schema. `information_schema.columns` is
  -- filtered by the asking role's privileges and by relkind, so it reports
  -- present columns as absent whenever the applying role is neither the
  -- relation's owner nor a privilege holder — which is how the first form of
  -- 20261007000000 §5i refused its own apply on the linked database against a
  -- column that demonstrably existed. A positive existence check read from it is
  -- a false failure waiting to happen; this is the same check asked of the
  -- catalog, which is filtered by nothing.
  select array_agg(a.attname::text order by a.attnum)
    into v_cols
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.finance_received_payments'::regclass
    and a.attnum > 0
    and not a.attisdropped;

  -- FAIL CLOSED ON AN EMPTY LIST. Every check below is `not (v_col = any(v_cols))`,
  -- and `= any(NULL)` is NULL, `not NULL` is NULL, and `if NULL then` is FALSE —
  -- so a v_cols that came back NULL would let all eighteen column assertions pass
  -- in silence. Unreachable as written, because the regclass cast above throws
  -- first if the view is gone; asserted anyway, because that is the direction
  -- this whole class of defect fails in.
  if v_cols is null or array_length(v_cols, 1) is null then
    raise exception 'finance_received_payments has no columns in the catalog; the projection is gone';
  end if;

  -- 3b. Every pre-existing column is still present, still named the same, in the
  -- same position. CREATE OR REPLACE enforces this itself; asserting it catches
  -- a hand-edited redefinition and states the contract for a reader.
  for v_col in
    select unnest(array[
      'id','request_number','client_name','amount','payment_date','payment_mode',
      'received_in','proof_note','order_number','order_id','order_request_id',
      'order_request_number','sales_note','status','payment_against','submitted_by',
      'approved_by','admin_note','created_at','approved_at','submitted_by_name',
      'approved_by_name','allocated_order_id','allocated_order_number',
      'is_order_allocated','allocated_total','attributed_total','allocation_state'
    ])
  loop
    if not (v_col = any (v_cols)) then
      raise exception 'finance_received_payments lost the existing column "%"', v_col;
    end if;
  end loop;

  -- 3c. And the eight new ones arrived.
  for v_col in
    select unnest(array[
      'order_attributed_total','pi_attributed_total',
      'order_allocated_total','pi_allocated_total',
      'active_allocation_count','attribution_complete','available_balance',
      'is_linked_to_order','is_linked_to_pi','is_available_to_allocate'
    ])
  loop
    if not (v_col = any (v_cols)) then
      raise exception 'finance_received_payments is missing "%"', v_col;
    end if;
  end loop;

  -- 3d. The three narrowings are boolean and NOT NULL-able in practice. A null
  -- boolean fails `eq.true` and `eq.false` alike, so a payment could disappear
  -- from every view at once.
  for v_col in
    select unnest(array['is_linked_to_order','is_linked_to_pi','is_available_to_allocate'])
  loop
    -- Also from the catalog, and for a second reason: a hidden column makes the
    -- information_schema lookup return NULL, `NULL <> 'boolean'` is NULL, and
    -- `if NULL then` is false — so the check would pass silently on exactly the
    -- rows it exists to police. `is distinct from` closes that too.
    if (select format_type(a.atttypid, a.atttypmod)
          from pg_catalog.pg_attribute a
         where a.attrelid = 'public.finance_received_payments'::regclass
           and a.attname = v_col
           and a.attnum > 0 and not a.attisdropped) is distinct from 'boolean' then
      raise exception '% must be boolean', v_col;
    end if;
  end loop;

  if exists (
    select 1 from public.finance_received_payments
    where is_linked_to_order is null
       or is_linked_to_pi is null
       or is_available_to_allocate is null
       or attribution_complete is null
  ) then
    raise exception
      'a classification boolean came back NULL; a payment would vanish from every narrowing';
  end if;

  -- 3e. No CLIENT role may write through it.
  if has_table_privilege('authenticated', 'public.finance_received_payments', 'insert')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'update')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'delete') then
    raise exception 'authenticated must hold SELECT only on finance_received_payments';
  end if;

  if not has_table_privilege('authenticated', 'public.finance_received_payments', 'select') then
    raise exception 'authenticated must be able to SELECT finance_received_payments';
  end if;

  -- 3f. The index the aggregate depends on still exists. Without it the sums
  -- become a sequential scan of every allocation, per payment, per page.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'finance_payment_allocations'
      and indexname = 'finance_payment_allocations_payment_active_idx'
  ) then
    raise exception
      'finance_payment_allocations_payment_active_idx is required by the allocation sums';
  end if;

  -- 3g. THE CONSERVATION LAW, CHECKED AGAINST REAL ROWS.
  --
  -- order_attributed_total + pi_attributed_total = attributed_total, exactly,
  -- for every payment in the database. This is what makes the split a split
  -- rather than a second formula: if any branch above disagreed with
  -- attributed_total's own branches, this finds it at apply time instead of on a
  -- Finance screen months later.
  --
  -- READ AS THE APPLYING ROLE, which owns the schema, so it sees every row: the
  -- invoker semantics that scope a client's read do not scope the owner's. This
  -- is a question about DATA, which is why reading rows is the right instrument
  -- here and the wrong one in 20261007000000 §5i, where the question was about
  -- schema. Nothing in this file switches roles, so the session that took the
  -- catalog checks above is the session that takes this one.
  if exists (
    select 1 from public.finance_received_payments
    where coalesce(order_attributed_total, 0) + coalesce(pi_attributed_total, 0)
          is distinct from coalesce(attributed_total, 0)
  ) then
    raise exception
      'the kind split does not sum to attributed_total: the classification would disagree with the attribution rule';
  end if;

  -- 3h. And the balance closes: attributed + available = amount, for every row
  -- that is not over-allocated. An over-allocated row fails this deliberately
  -- and is excluded — the excess is a defect in stored data and must stay
  -- visible rather than be rebalanced by a migration.
  if exists (
    select 1 from public.finance_received_payments
    where available_balance is not null
      and amount is not null
      and allocation_state is distinct from 'over'
      and attributed_total + available_balance is distinct from amount
  ) then
    raise exception
      'attributed + available does not equal the payment amount on at least one row';
  end if;

  -- 3i. No rejected payment appears in any narrowing.
  if exists (
    select 1 from public.finance_received_payments
    where status = 'rejected'
      and (is_linked_to_order or is_linked_to_pi or is_available_to_allocate)
  ) then
    raise exception 'a rejected payment is classified into a narrowing; rejected money must not count';
  end if;

  -- 3j. NO TABLE GAINED A COLUMN. This migration adds a projection, not a stored
  -- total; a denormalised copy of allocation data would be a second source of
  -- financial truth and would drift the first time a write missed it.
  -- Catalog again: a negative check read from information_schema passes whenever
  -- the columns are merely invisible, which is the direction that would let a
  -- stored classification through unnoticed.
  if exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = 'public.finance_payment_requests'::regclass
      and a.attnum > 0 and not a.attisdropped
      and a.attname in (
        'order_attributed_total', 'pi_attributed_total', 'available_balance',
        'attribution_complete', 'active_allocation_count',
        'is_linked_to_order', 'is_linked_to_pi', 'is_available_to_allocate'
      )
  ) then
    raise exception 'the classification must not be stored on finance_payment_requests';
  end if;
end $$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CREATE OR REPLACE cannot DROP a column, so a rollback is
-- `drop view public.finance_received_payments;` followed by 20261004000000 §1's
-- create block verbatim and its revoke/grant pair.
--
-- The application degrades safely without this migration: every classification
-- surface probes for the new columns (paymentClassificationAvailable) and simply
-- does not draw the tabs when they are absent, so an un-migrated database
-- behaves exactly as it did before. Nothing else needs undoing — no table,
-- column, policy, index, function or trigger was created, altered or dropped.

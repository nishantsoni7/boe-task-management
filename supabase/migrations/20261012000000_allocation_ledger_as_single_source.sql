-- ═══════════════════════════════════════════════════════════════════════════
-- The allocation ledger is the single financial source — in SQL as well as in
-- the application.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS CLOSES
-- ----------------
-- PR #55 removed Link to an Order and Unlink from the product and made active
-- `finance_payment_allocations` rows the only source of attribution IN THE
-- APPLICATION. It could not change the database, so two SQL objects kept a
-- fallback the application had dropped:
--
--   order_linked_payment_total(uuid)   ...when s.order_id = p_order_id then s.amount
--   finance_received_payments (view)   ...when f.order_id is not null  then f.amount
--
-- Both read: "a payment with no active allocation is attributed IN FULL to the
-- Order its own order_id names." So one payment could read ₹0 allocated on the
-- Confirmed Payments screen and be counted as this Order's money by the
-- database at the same moment. Two answers to one question about money.
--
-- WHY THE FALLBACK EXISTED, AND WHY IT NO LONGER SHOULD
-- ----------------------------------------------------
-- It protected a real invariant while BOTH mechanisms were live. Money linked
-- the old way was genuinely committed to an Order, and calling it unallocated
-- would have put it into Finance's suspense queue while the Order still counted
-- it — the same rupees in two places.
--
-- Neither mechanism is live now. Nothing writes `order_id` on a payment: the
-- link RPCs have no caller, and this migration removes them. And nothing can
-- correct or reverse an attribution that has no allocation row behind it,
-- because reverse_payment_allocation operates on allocation rows. A fallback
-- attribution is therefore money the product can neither move nor undo — which
-- is a worse failure than the one the fallback was written to prevent.
--
-- THE RULE, ENTIRE
-- ----------------
--   1. Only rows in finance_payment_allocations with status = 'active'
--      contribute to financial allocation.
--   2. Allocated total is the sum of those rows' allocated_amount.
--   3. Remaining balance is the payment amount minus that total.
--   4. A payment with no active allocation row is Zero Allocated.
--   5. order_id / order_request_id / payment_against contribute ₹0. They remain
--      as PROVENANCE — where the money was originally reported against — and
--      are still selected, displayed and searchable. They are simply not money.
--   6. One payment may be allocated partially or fully across several PI Drafts
--      and Orders at once.
--   7. No allocation is counted twice.
--   8. A reversed allocation contributes ₹0.
--   9. Over-allocation stays visible as its own state; it is never rounded into
--      'full'.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -------------------------------
-- It does not drop a column, an enum value or a lifecycle status. It does not
-- convert a legacy link into an allocation row — inventing an allocation nobody
-- authorised would be exactly the fabrication the fallback amounted to. It does
-- not delete, rewrite or touch a single business row: every statement below is
-- a definition change. `approved_linked` and `approved_unlinked` remain the two
-- verified statuses and are untouched, because they say whether Finance checked
-- the money, not who it belongs to.
--
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════════
-- §1. order_linked_payment_total(uuid) — an Order's verified money
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Signature, volatility, security mode, search_path and grants are all
-- unchanged. Only the arithmetic changes, and it collapses: with no fallback
-- there is no longer any reason to know what the payment does ELSEWHERE, so the
-- candidates/shares machinery that existed to answer that question goes with
-- it. This Order's total is the sum of the active allocations naming this
-- Order, restricted to payments Finance has verified.
--
-- STILL VERIFIED-ONLY. finance_payment_status_is_verified() is the same filter
-- as before: an allocation whose parent payment is pending, needs clarification
-- or rejected contributes nothing. That is a status question, not an
-- attribution one, and this migration does not touch it.
--
-- STILL AUTHORIZATION-CHECKED. can_view_order_as_actor() is unchanged and still
-- decides whether the caller may have an answer at all. `auth.uid() is null`
-- keeps the definer-context path open exactly as before — the guarded RPCs that
-- read this into an activity payload hold a locked row and have no session.

create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when public.can_view_order_as_actor(p_order_id) or auth.uid() is null
    then coalesce((
      select sum(a.allocated_amount)
        from public.finance_payment_allocations a
        join public.finance_payment_requests f on f.id = a.payment_request_id
       where a.order_id = p_order_id
         and a.status = 'active'
         and public.finance_payment_status_is_verified(f.status)
    ), 0)
  end;
$$;

comment on function public.order_linked_payment_total(uuid) is
  'Rupees of FINANCE-VERIFIED money allocated to one Order: the sum of active finance_payment_allocations naming it, and nothing else. The payment''s own order_id contributes ZERO — it is provenance, not allocation (20261012000000). Reversed allocations and unverified parents count for nothing. Returns null when the caller may not view the Order.';

revoke execute on function public.order_linked_payment_total(uuid) from public, anon;
grant  execute on function public.order_linked_payment_total(uuid) to authenticated;
alter function public.order_linked_payment_total(uuid) set search_path = public, pg_temp;


-- ═══════════════════════════════════════════════════════════════════════════
-- §2. finance_received_payments — the same rule, across every derived column
-- ═══════════════════════════════════════════════════════════════════════════
--
-- EVERY COLUMN IS PRESERVED, in name, type and order: this is a
-- `create or replace view`, which requires exactly that, and the application
-- reads the view by name. Seven expressions change and nothing else does.
--
-- The seven that carried `when f.order_id is not null then f.amount`:
--   attributed_total, allocation_state, order_attributed_total,
--   available_balance, is_linked_to_order, is_available_to_allocate
-- (allocation_state carried it three times over, inline).
--
-- ATTRIBUTED_TOTAL AND ALLOCATED_TOTAL NOW AGREE BY CONSTRUCTION, and so do
-- allocation_state and confirmed_allocation_status modulo their vocabularies
-- ('unallocated' vs 'zero'). Both pairs are KEPT rather than collapsed: the
-- application selects all four by name, the two vocabularies mean different
-- things to different screens, and a view that quietly loses a column is a
-- deployment failure rather than a tidy-up. They are now two names for one
-- figure, which is the point — they used to be two different figures.
--
-- order_id, order_request_id, order_number, order_request_number and
-- payment_against are still selected and still returned. They are provenance:
-- what the money was reported against when it arrived. Nothing financial reads
-- them any more.

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
  b.attributed_total,
  b.allocation_state,

  b.order_attributed_total,
  b.pi_attributed_total,
  b.order_allocated_total,
  b.pi_allocated_total,
  b.active_allocation_count,
  b.attribution_complete,
  b.available_balance,
  b.is_linked_to_order,
  b.is_linked_to_pi,
  b.is_available_to_allocate,

  b.human_payment_id,

  -- Unchanged from 20261011000000: this column was ALREADY pure-ledger. It is
  -- now simply no longer the odd one out.
  case
    when b.amount is null             then null
    when b.allocated_total <= 0       then 'zero'
    when b.allocated_total > b.amount then 'over'
    when b.allocated_total = b.amount then 'full'
    else 'partial'
  end as confirmed_allocation_status

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
    f.human_payment_id,

    eb.full_name as submitted_by_name,
    ab.full_name as approved_by_name,

    alloc.order_id       as allocated_order_id,
    alloc.display_number as allocated_order_number,

    (alloc.order_id is not null) as is_order_allocated,

    coalesce(totals.allocated_total, 0)       as allocated_total,
    coalesce(totals.order_allocated_total, 0) as order_allocated_total,
    coalesce(totals.pi_allocated_total, 0)    as pi_allocated_total,
    coalesce(totals.active_allocation_count, 0)::integer as active_allocation_count,

    -- ── WAS: allocated_total, else the whole amount if order_id was set ──
    coalesce(totals.allocated_total, 0) as attributed_total,

    case
      when f.amount is null                              then null
      when coalesce(totals.allocated_total, 0) = 0       then 'unallocated'
      when coalesce(totals.allocated_total, 0) > f.amount then 'over'
      when coalesce(totals.allocated_total, 0) = f.amount then 'full'
      else 'partial'
    end as allocation_state,

    -- ── WAS: order_allocated_total, else the whole amount if order_id was set ──
    coalesce(totals.order_allocated_total, 0) as order_attributed_total,

    -- Unchanged: the PI side never had a fallback, because a PI has no linkage
    -- column for one. The two sides finally behave alike.
    coalesce(totals.pi_allocated_total, 0) as pi_attributed_total,

    coalesce(
      coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
      or f.submitted_by = auth.uid(),
      false
    ) as attribution_complete,

    -- WITHHELD RATHER THAN GUESSED, exactly as before: a reader who cannot see
    -- every allocation is told null, never a balance derived from a partial
    -- view. Only the subtrahend changed.
    case
      when not coalesce(
             coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
             or f.submitted_by = auth.uid(),
             false
           ) then null::numeric
      when f.amount is null then null::numeric
      else greatest(f.amount - coalesce(totals.allocated_total, 0), 0)
    end as available_balance,

    (
      coalesce(f.status, '') <> 'rejected'
      and coalesce(totals.order_allocated_total, 0) > 0
    ) as is_linked_to_order,

    (
      coalesce(f.status, '') <> 'rejected'
      and coalesce(totals.pi_allocated_total, 0) > 0
    ) as is_linked_to_pi,

    (
      coalesce(f.status, '') <> 'rejected'
      and coalesce(
            coalesce((select public.actor_has_module_permission('finance', 'view_all')), false)
            or f.submitted_by = auth.uid(),
            false
          )
      and f.amount is not null
      and greatest(f.amount - coalesce(totals.allocated_total, 0), 0) > 0
    ) as is_available_to_allocate

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
  'Every payment row a caller may already read, classified from ACTIVE ALLOCATION ROWS ALONE (20261012000000). attributed_total equals allocated_total and allocation_state agrees with confirmed_allocation_status by construction: the direct-link fallback that made them differ is gone. order_id / order_request_id / payment_against are still returned as PROVENANCE and contribute no money. SECURITY INVOKER, unchanged from every prior revision.';

revoke all privileges on public.finance_received_payments from public, anon, authenticated;
grant select on public.finance_received_payments to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §3. The obsolete Link/Unlink write surface
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Four RPCs, dropped by exact signature:
--
--   link_finance_payment_to_order(uuid, uuid)
--   link_finance_payment_to_order_request(uuid, uuid)
--   unlink_finance_payment_from_order(uuid, text)
--   unlink_finance_payment_from_order_request(uuid, text)
--
-- THE DEPENDENCY EVIDENCE. No trigger executes them, no policy references them,
-- no function body calls them, and PR #55 removed the last application caller.
-- The only remaining mentions anywhere in the schema are their own definitions,
-- their grants, and prose in comments. Dropping is therefore a removal, not a
-- breakage — and a writable RPC that can still set order_id is not a dormant
-- artefact, it is a live way to write a financial field that §1 and §2 have
-- just finished declaring is not financial.
--
-- SUPERSEDING 20261007000000 §5j, DELIBERATELY AND WITH ITS REASON ADDRESSED.
-- That migration asserted unlink_finance_payment_from_order_request must remain
-- executable by `authenticated`, because:
--
--     "Revoking them would strand abandoned drafts and, worse, strand money on
--      a retired record with no way to move it to a real one."
--
-- That was true when a payment's order_request_id was what attributed its
-- money: unlink was the only way to get the money back. It is not true after
-- §1 and §2. A payment carrying order_request_id and no active allocation is
-- now Zero Allocated, its FULL amount is available_balance, and
-- is_available_to_allocate is true — so Allocate Funds can move every rupee of
-- it to any Order or PI Draft, without unlink existing. The money is not
-- stranded; it is free, which is strictly better than what unlink offered.
-- The suite asserts exactly this (§A, order-request variant), so the invariant
-- being superseded is proved obsolete rather than merely overruled.
--
-- 20261007000000 §5k, which requires link_finance_payment_to_order_request to
-- be executable by NO client role, is satisfied more completely by a function
-- that does not exist.
--
-- Both of those are apply-time DO blocks inside migration 107. On a replay they
-- run at 107 — before this file — and still pass. Nothing re-checks them later.

do $$
declare
  v_sig     text;
  v_dropped text[] := '{}';
  v_proc    record;
begin
  -- ── Refuse to drop anything another database object still depends on ──
  --
  -- The grep evidence above is a claim about the repository; this is the
  -- database's own answer about the schema actually in front of us. pg_depend
  -- records every function-to-function, trigger-to-function and view-to-function
  -- dependency PostgreSQL knows about.
  for v_proc in
    select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'link_finance_payment_to_order',
        'link_finance_payment_to_order_request',
        'unlink_finance_payment_from_order',
        'unlink_finance_payment_from_order_request'
      )
  loop
    if exists (
      select 1 from pg_depend d
      where d.refobjid = v_proc.oid
        and d.deptype in ('n', 'a')
        and d.classid <> 'pg_proc'::regclass  -- its own grants are not a dependency
    ) then
      raise exception
        'REFUSING TO DROP %: another database object still depends on it. Investigate before retrying.',
        v_proc.sig;
    end if;
  end loop;

  -- ── Drop every overload of each name, by exact signature ──
  for v_proc in
    select p.oid::regprocedure::text as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'link_finance_payment_to_order',
        'link_finance_payment_to_order_request',
        'unlink_finance_payment_from_order',
        'unlink_finance_payment_from_order_request'
      )
    order by 1
  loop
    -- RESTRICT, not CASCADE. If something does depend on it after all, this
    -- must fail loudly rather than quietly remove whatever that was.
    execute format('drop function %s', v_proc.sig);
    v_dropped := v_dropped || v_proc.sig;
  end loop;

  if array_length(v_dropped, 1) is null then
    raise notice 'no Link/Unlink RPC was present to drop (already removed)';
  else
    raise notice 'dropped the obsolete Link/Unlink write surface: %',
      array_to_string(v_dropped, ', ');
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- §4. Apply-time assertions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- These run when the migration is applied, against the real schema, and refuse
-- the deployment rather than leaving a half-corrected database behind.

do $$
declare
  v_opt   text;
  v_cols  text[];
  v_def   text;
  v_n     int;
begin
  -- ── 4a. The fallback is gone from both objects, textually ──
  --
  -- Read back from the catalogue, not from this file: what matters is what the
  -- database ended up holding.
  select pg_get_functiondef('public.order_linked_payment_total(uuid)'::regprocedure) into v_def;
  if v_def ~* 'order_id\s*=\s*p_order_id\s+then\s+\S*amount' then
    raise exception
      'order_linked_payment_total still attributes a payment by its own order_id';
  end if;
  if v_def !~* 'finance_payment_allocations' then
    raise exception 'order_linked_payment_total must read the allocation ledger';
  end if;
  if v_def !~* 'finance_payment_status_is_verified' then
    raise exception
      'order_linked_payment_total must still count only Finance-verified payments';
  end if;
  if v_def !~* 'can_view_order_as_actor' then
    raise exception 'order_linked_payment_total lost its authorization check';
  end if;

  select pg_get_viewdef('public.finance_received_payments'::regclass, true) into v_def;
  if v_def ~* 'order_id\s+IS\s+NOT\s+NULL\s+THEN\s+\S*amount' then
    raise exception
      'finance_received_payments still attributes a payment by its own order_id';
  end if;

  -- ── 4b. The view kept its security mode, its grants and every column ──
  select coalesce(
           (select option_value from pg_options_to_table(c.reloptions)
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

  select array_agg(a.attname::text order by a.attnum) into v_cols
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.finance_received_payments'::regclass
    and a.attnum > 0 and not a.attisdropped;

  foreach v_def in array array[
    'id', 'request_number', 'client_name', 'amount', 'payment_date',
    'payment_mode', 'received_in', 'proof_note', 'order_number', 'order_id',
    'order_request_id', 'order_request_number', 'sales_note', 'status',
    'payment_against', 'submitted_by', 'approved_by', 'admin_note',
    'created_at', 'approved_at', 'submitted_by_name', 'approved_by_name',
    'allocated_order_id', 'allocated_order_number', 'is_order_allocated',
    'allocated_total', 'attributed_total', 'allocation_state',
    'order_attributed_total', 'pi_attributed_total', 'order_allocated_total',
    'pi_allocated_total', 'active_allocation_count', 'attribution_complete',
    'available_balance', 'is_linked_to_order', 'is_linked_to_pi',
    'is_available_to_allocate', 'human_payment_id', 'confirmed_allocation_status'
  ] loop
    if not (v_def = any (v_cols)) then
      raise exception 'finance_received_payments lost the column "%"', v_def;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.finance_received_payments', 'insert')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'update')
     or has_table_privilege('authenticated', 'public.finance_received_payments', 'delete')
  then
    raise exception 'finance_received_payments must stay read-only for authenticated';
  end if;
  if not has_table_privilege('authenticated', 'public.finance_received_payments', 'select') then
    raise exception 'authenticated lost SELECT on finance_received_payments';
  end if;
  if has_table_privilege('anon', 'public.finance_received_payments', 'select') then
    raise exception 'anon must not read finance_received_payments';
  end if;

  -- ── 4c. order_linked_payment_total kept its exposure posture ──
  if not has_function_privilege('authenticated', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'authenticated lost EXECUTE on order_linked_payment_total(uuid)';
  end if;
  if has_function_privilege('anon', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'anon must not execute order_linked_payment_total(uuid)';
  end if;

  -- Read from prosecdef, which is the catalogue's own answer rather than a
  -- string match on the source. The wording avoids the literal phrase on
  -- purpose: verifiedPaymentGateSchema.test.ts scans everything after the view
  -- definition for it, to catch a revision that turns the PROJECTION into a
  -- definer view, and that guard should not be muffled by an unrelated message.
  select p.prosecdef into v_opt
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'order_linked_payment_total';
  if v_opt is distinct from 'true' then
    raise exception
      'order_linked_payment_total must remain a definer function (prosecdef = true)';
  end if;

  -- ── 4d. The Link/Unlink write surface is gone, in every overload ──
  select count(*) into v_n
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'link_finance_payment_to_order',
      'link_finance_payment_to_order_request',
      'unlink_finance_payment_from_order',
      'unlink_finance_payment_from_order_request'
    );
  if v_n <> 0 then
    raise exception '% Link/Unlink function(s) survived the drop', v_n;
  end if;

  -- ── 4e. Nothing that decides money was dropped with them ──
  --
  -- The allocation write path, the capacity invariant and the verified-status
  -- definition are all untouched by this migration and must still be here.
  foreach v_def in array array[
    'allocate_payment_to_targets',
    'allocate_payment_to_target_internal',
    'finance_payment_status_is_verified',
    'finance_payment_allocations_enforce_capacity'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_def
    ) then
      raise exception 'the allocation machinery lost %', v_def;
    end if;
  end loop;

  -- ── 4f. The legacy COLUMNS are still here ──
  --
  -- This migration removes their financial meaning, not the data. Dropping them
  -- is a separate decision with separate consequences for history and search.
  foreach v_def in array array['order_id', 'order_request_id', 'payment_against'] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'finance_payment_requests'
        and column_name = v_def
    ) then
      raise exception
        'finance_payment_requests.% must NOT be dropped by this migration: it is provenance', v_def;
    end if;
  end loop;

  raise notice 'ALLOCATION LEDGER IS THE SINGLE FINANCIAL SOURCE — apply-time assertions passed';
end $$;

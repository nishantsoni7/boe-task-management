-- ═══════════════════════════════════════════════════════════════════════════
-- 20270701000000 — Confirmed Payments: find a payment by ANY order number it is
--                  allocated to, show that order's confirmed total, and let an
--                  old order's client be corrected
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE ASK (owner, 2026-11-12, screenshot of Confirmed Payments):
--   * search should find a payment by the order number (or PI number) it is
--     recorded against, and when it does, also show the total confirmed amount
--     of that order;
--   * for an OLD order (not in this system) the client could not be added or
--     edited.
--
-- WHAT IS ADDED, and nothing wider:
--   §1  order_search_text(finance_received_payments) — a PostgREST computed
--       field on the Confirmed Payments projection: every Order number, PI Draft
--       reference / reserved number, the PI an Order came from, and old order
--       number and client that ONE confirmed payment is allocated to (active
--       allocations only). The list's search filters by it, so a payment is
--       found by the same names its Order / PI cell prints. Same access checks
--       as complete_allocation_status (20261216000000); NULL for a payment the
--       caller may not read or that is not confirmed.
--   §2  finance_order_confirmed_totals(text) — for a typed order number: each
--       Order / PI Draft / old order it matches, with the number of confirmed
--       payments allocated to it and the SUM OF WHAT WAS ALLOCATED to it. That
--       is the order's confirmed money; it is NOT the sum of the payments'
--       amounts (a payment split across two orders would count twice). Only
--       payments the caller may already read are counted.
--   §3  correct_legacy_order_client(uuid, text) — fixes the client typed with an
--       old order. The allocation's legacy columns are immutable (20270407000000);
--       this door is the one exception, for the client name only, through a
--       transaction-local marker, and it writes a history line on the payment.
--       The PAYMENT row is never touched: finance_payment_requests_lock_cash_
--       custody (20270415000000) refuses edits to it on a payment in a cash
--       handover, and the screen reads the client from the allocation instead.
--   §4  The immutability guard (finance_payment_allocations_guard_transition) is
--       restated: 20270407000000 §2 verbatim, plus the marker clause.
--   §5  The activity trail learns one event: allocation_legacy_client_corrected
--       (the FULL current set, 20270608000000, plus the new value).
--
-- AUTHORITY. Correcting a client name is finance.manage (the authority that
-- edits a Confirmed Payment); the search and the totals are finance.view and
-- show only what the caller may already read. No new permission key.
--
-- NOT TOUCHED: finance_received_payments (the view is not redefined; a computed
-- field hangs off its row type), any payment row, any amount, any Order or PI
-- total, the RLS policies of the allocations table.
--
-- ROLLBACK: drop the three functions; re-emit the 20270407000000 guard; the
-- event value may stay in the CHECK (corrections already written would violate
-- a narrower one). No money or payment row changes either way.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regclass('public.finance_received_payments') is null
     or to_regclass('public.finance_payment_allocations') is null
     or to_regprocedure('public.received_payment_visible_to_actor(uuid)') is null
     or to_regprocedure('public.finance_payment_status_is_verified(text)') is null
     or to_regprocedure('public.normalize_legacy_order_no(text)') is null
     or to_regprocedure('public.finance_payment_allocations_guard_transition()') is null
     or to_regprocedure('public.actor_has_module_permission(text, text)') is null
     or to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: the allocation model and the Confirmed Payments projection (20261216000000, 20270407000000) must be applied first';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- §1. The search text of one confirmed payment
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.order_search_text(
  p_row public.finance_received_payments
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_text   text;
begin
  -- A search text is only for someone who may see Confirmed Payments at all.
  if auth.uid() is null
     or not coalesce(public.module_entry_open('finance'), false)
     or not coalesce(public.actor_has_module_permission('finance', 'view'), false) then
    return null;
  end if;

  -- From the BASE table, by id. Only the id of the row handed in is trusted.
  select f.status into v_status
  from public.finance_payment_requests f
  where f.id = p_row.id;

  if not found
     or not public.finance_payment_status_is_verified(v_status)
     or not public.received_payment_visible_to_actor(p_row.id) then
    return null;
  end if;

  -- What the Order / PI cell prints (target_reference and the reserved number of
  -- received_payment_allocation_targets), plus the PI an Order came from and the
  -- client typed with an old order. Active allocations only.
  select string_agg(distinct t.word, ' ') into v_text
  from (
    select unnest(array[
      (case
         when a.legacy_order_no is not null then a.legacy_order_no
         when a.order_id is not null then nullif(btrim(o.display_number), '')
         else coalesce(nullif(btrim(s.draft_reference), ''),
                       nullif(btrim(regexp_replace(coalesce(s.source_workbook_name, ''), '^.*[\\/]', '')), ''))
       end)::text,
      (case when a.legacy_order_no is null and a.order_id is null
            then nullif(btrim(s.reserved_order_number), '') end)::text,
      (case when a.order_id is not null then nullif(btrim(so.draft_reference), '') end)::text,
      a.legacy_client_name::text
    ]) as word
    from public.finance_payment_allocations a
    left join public.orders            o  on o.id  = a.order_id
    left join public.order_submissions so on so.id = o.source_order_submission_id
    left join public.order_submissions s  on s.id  = a.order_submission_id
    where a.payment_request_id = p_row.id
      and a.status = 'active'
  ) t
  where t.word is not null;

  return v_text;
end;
$$;

comment on function public.order_search_text(public.finance_received_payments) is
  'PostgREST computed field on finance_received_payments: every Order number, PI Draft reference or reserved number, source PI of an Order, and old order number and client that one CONFIRMED payment is actively allocated to, space-separated, for the Confirmed Payments search. NULL for a payment the caller may not read or that is not confirmed. Same access checks as complete_allocation_status; reads the payment by id from finance_payment_requests. SECURITY DEFINER, STABLE. 20270701000000.';

revoke all on function public.order_search_text(public.finance_received_payments) from public;
revoke all on function public.order_search_text(public.finance_received_payments) from anon;
revoke all on function public.order_search_text(public.finance_received_payments) from service_role;
grant execute on function public.order_search_text(public.finance_received_payments) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- §2. The confirmed total of the order(s) a typed number names
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per Order / PI Draft / old order whose number contains the term (case
-- ignored). target_type / target_reference / reserved_order_number /
-- target_client_name use the names of received_payment_allocation_targets, so the
-- screen names a row with the same code. confirmed_total is the sum of the ACTIVE
-- allocations to that target on confirmed payments the caller may read.
-- A term shorter than 3 characters, or longer than 60, answers nothing.

create or replace function public.finance_order_confirmed_totals(p_term text)
returns table (
  target_type           text,
  target_reference      text,
  reserved_order_number text,
  target_client_name    text,
  payments_count        integer,
  confirmed_total       numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
  v_term  text := btrim(coalesce(p_term, ''));
  v_like  text;
begin
  if v_actor is null then
    raise exception 'ORDER_TOTALS_AUTH_REQUIRED: sign in to read order totals.'
      using errcode = '28000';
  end if;
  if not coalesce(public.module_entry_open('finance'), false) then
    raise exception 'ORDER_TOTALS_NOT_PERMITTED: Finance access is required.'
      using errcode = '42501';
  end if;
  if not coalesce(public.actor_has_module_permission('finance', 'view'), false) then
    raise exception 'ORDER_TOTALS_NOT_PERMITTED: you do not have permission to view Finance payments.'
      using errcode = '42501';
  end if;

  if length(v_term) < 3 or length(v_term) > 60 then
    return;
  end if;

  -- The term is text to find, never a pattern: % _ and \ are escaped.
  v_like := '%' || replace(replace(replace(v_term, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';

  return query
  with raw as (
    select
      a.payment_request_id as pid,
      a.allocated_amount   as amount,
      (case when a.legacy_order_no is not null then 'legacy_order'
            when a.order_id is not null then 'order'
            else 'pi_draft' end)::text as ttype,
      coalesce(a.order_id::text, a.order_submission_id::text, a.legacy_order_no) as tkey,
      (case
         when a.legacy_order_no is not null then a.legacy_order_no
         when a.order_id is not null then nullif(btrim(o.display_number), '')
         else coalesce(nullif(btrim(s.draft_reference), ''),
                       nullif(btrim(regexp_replace(coalesce(s.source_workbook_name, ''), '^.*[\\/]', '')), ''))
       end)::text as ref,
      (case when a.legacy_order_no is null and a.order_id is null
            then nullif(btrim(s.reserved_order_number), '') end)::text as reserved,
      (case when a.order_id is not null then nullif(btrim(so.draft_reference), '') end)::text as source_pi,
      a.legacy_client_name::text as client
    from public.finance_payment_allocations a
    left join public.orders            o  on o.id  = a.order_id
    left join public.order_submissions so on so.id = o.source_order_submission_id
    left join public.order_submissions s  on s.id  = a.order_submission_id
    where a.status = 'active'
  ),
  hits as (
    select r.*
    from raw r
    where r.ref ilike v_like
       or r.reserved ilike v_like
       or r.source_pi ilike v_like
  )
  select
    h.ttype,
    min(h.ref),
    min(h.reserved),
    min(h.client),
    count(distinct h.pid)::integer,
    sum(h.amount)
  from hits h
  join public.finance_payment_requests f on f.id = h.pid
  where public.finance_payment_status_is_verified(f.status)
    and public.received_payment_visible_to_actor(f.id)
  group by h.ttype, h.tkey
  order by h.ttype, min(h.ref)
  limit 26;
end;
$$;

comment on function public.finance_order_confirmed_totals(text) is
  'For a typed order number (3 to 60 characters, matched anywhere in an Order number, a PI Draft reference or reserved number, the PI an Order came from, or an old order number): each Order / PI Draft / old order it names, with how many confirmed payments are allocated to it and the SUM OF THE ACTIVE ALLOCATIONS to it (not the payments'' amounts). Only payments the caller may already read; at most 26 rows. Same access checks as received_payment_allocation_targets. 20270701000000.';

revoke all on function public.finance_order_confirmed_totals(text) from public;
revoke all on function public.finance_order_confirmed_totals(text) from anon;
revoke all on function public.finance_order_confirmed_totals(text) from service_role;
grant execute on function public.finance_order_confirmed_totals(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- §3. The guard: one marker lets ONE allocation's client name change
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20270407000000 §2 verbatim (same attributes: SECURITY INVOKER, search_path),
-- plus: legacy_client_name may change when the transaction-local setting
-- boe.legacy_client_correction names this very allocation, which is active and an
-- old-order one. Every other column stays frozen, and only §4 sets the marker.

create or replace function public.finance_payment_allocations_guard_transition()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_conversion    boolean := false;
  v_client_marker boolean := false;
begin
  if old.status = 'active'
     and old.order_submission_id is not null
     and public.in_pi_submission_approval(old.order_submission_id)
     and new.order_submission_id is null
     and new.order_id is not null
     and new.id                 is not distinct from old.id
     and new.payment_request_id is not distinct from old.payment_request_id
     and new.allocated_amount   is not distinct from old.allocated_amount
     and new.origin_target_type is not distinct from old.origin_target_type
     and new.created_by         is not distinct from old.created_by
     and new.created_at         is not distinct from old.created_at
     and new.status             is not distinct from old.status
     and new.reversed_by        is not distinct from old.reversed_by
     and new.reversed_at        is not distinct from old.reversed_at
     and new.reversal_reason    is not distinct from old.reversal_reason
     and new.legacy_order_no    is not distinct from old.legacy_order_no
     and new.legacy_client_name is not distinct from old.legacy_client_name
     and exists (
       select 1 from public.orders o
       where o.id = new.order_id
         and o.source_order_submission_id = old.order_submission_id
     )
  then
    v_conversion := true;
  end if;

  -- The one door that may change an old order's client name (§4).
  v_client_marker := old.status = 'active'
    and old.legacy_order_no is not null
    and coalesce(current_setting('boe.legacy_client_correction', true), '') = old.id::text;

  if not v_conversion then
    if new.id                  is distinct from old.id
       or new.payment_request_id  is distinct from old.payment_request_id
       or new.order_submission_id is distinct from old.order_submission_id
       or new.order_id            is distinct from old.order_id
       or new.legacy_order_no     is distinct from old.legacy_order_no
       or (new.legacy_client_name is distinct from old.legacy_client_name and not v_client_marker)
       or new.allocated_amount    is distinct from old.allocated_amount
       or new.origin_target_type  is distinct from old.origin_target_type
       or new.created_by          is distinct from old.created_by
       or new.created_at          is distinct from old.created_at
    then
      raise exception
        'ALLOCATION_IMMUTABLE: an allocation''s payment, target, amount, provenance and creation record cannot be changed. Reverse it and create another.'
        using errcode = '42501';
    end if;
  end if;

  if old.status = 'reversed' then
    if new.status is distinct from old.status then
      raise exception
        'ALLOCATION_REVERSAL_FINAL: a reversed allocation can never be made active again. Create a new allocation instead.'
        using errcode = '42501';
    end if;

    if new.reversed_by     is distinct from old.reversed_by
       or new.reversed_at     is distinct from old.reversed_at
       or new.reversal_reason is distinct from old.reversal_reason
    then
      raise exception
        'ALLOCATION_REVERSAL_IMMUTABLE: a recorded reversal cannot be rewritten.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.finance_payment_allocations_guard_transition()
  from public, anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- §4. The history learns the correction
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.finance_payment_request_activity_log
  drop constraint if exists finance_payment_request_activity_log_event_type_check;

alter table public.finance_payment_request_activity_log
  add constraint finance_payment_request_activity_log_event_type_check
  check (event_type in (
    'request_submitted',
    'order_linked',
    'order_unlinked',
    'order_link_changed',
    'order_request_linked',
    'order_request_unlinked',
    'target_changed',
    'status_changed',
    'collection_details_updated',
    'cash_handover_recorded',
    'allocation_created',
    'allocation_reversed',
    'allocation_moved',
    'request_deleted',
    'request_merged',
    'request_merged_in',
    'allocation_legacy_client_corrected'
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- §5. The door that corrects an old order's client
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.correct_legacy_order_client(
  p_allocation_id uuid,
  p_client_name   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_client text := nullif(btrim(regexp_replace(coalesce(p_client_name, ''), '\s+', ' ', 'g')), '');
  v_alloc  public.finance_payment_allocations%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required to correct an old order''s client' using errcode = '28000';
  end if;

  if not coalesce(public.module_entry_open('finance'), false)
     or not coalesce(public.actor_has_module_permission('finance', 'manage'), false) then
    raise exception 'LEGACY_CLIENT_NOT_PERMITTED: you do not have permission to correct a received payment.'
      using errcode = '42501';
  end if;

  if v_client is null then
    raise exception 'ALLOCATION_LEGACY_CLIENT_REQUIRED: enter the client the old order belongs to.'
      using errcode = 'P0001';
  end if;
  if length(v_client) > 120 then
    raise exception 'ALLOCATION_LEGACY_CLIENT_TOO_LONG: a client name can be at most 120 characters.'
      using errcode = 'P0001';
  end if;

  select * into v_alloc
  from public.finance_payment_allocations a
  where a.id = p_allocation_id
  for update;

  if not found or v_alloc.legacy_order_no is null then
    raise exception 'LEGACY_ALLOCATION_NOT_FOUND: that is not an old-order allocation.'
      using errcode = 'P0002';
  end if;
  if v_alloc.status <> 'active' then
    raise exception 'LEGACY_ALLOCATION_REVERSED: a reversed allocation is history and is not changed.'
      using errcode = 'P0001';
  end if;

  -- Nothing to do: no change, no history line.
  if v_alloc.legacy_client_name = v_client then
    return jsonb_build_object(
      'allocation_id',      v_alloc.id,
      'payment_request_id', v_alloc.payment_request_id,
      'legacy_order_no',    v_alloc.legacy_order_no,
      'legacy_client_name', v_client,
      'changed',            false
    );
  end if;

  perform set_config('boe.legacy_client_correction', v_alloc.id::text, true);
  update public.finance_payment_allocations
     set legacy_client_name = v_client
   where id = v_alloc.id;
  perform set_config('boe.legacy_client_correction', '', true);

  insert into public.finance_payment_request_activity_log
    (payment_request_id, actor_id, event_type, payload)
  values (
    v_alloc.payment_request_id, v_actor, 'allocation_legacy_client_corrected',
    jsonb_build_object(
      'allocation_id',        v_alloc.id,
      'legacy_order_no',      v_alloc.legacy_order_no,
      'previous_client_name', v_alloc.legacy_client_name,
      'legacy_client_name',   v_client
    )
  );

  return jsonb_build_object(
    'allocation_id',      v_alloc.id,
    'payment_request_id', v_alloc.payment_request_id,
    'legacy_order_no',    v_alloc.legacy_order_no,
    'legacy_client_name', v_client,
    'changed',            true
  );
end;
$$;

comment on function public.correct_legacy_order_client(uuid, text) is
  'Corrects the client typed with an OLD-order allocation (the one thing about that allocation that may change). Needs finance.manage and Finance entry; refuses a reversed or non-old-order allocation and a blank or over-long name; sets the transaction-local marker the allocation guard honours for this allocation only, and writes allocation_legacy_client_corrected on the payment''s history. Never touches the payment row. 20270701000000.';

revoke all on function public.correct_legacy_order_client(uuid, text) from public;
revoke all on function public.correct_legacy_order_client(uuid, text) from anon;
revoke all on function public.correct_legacy_order_client(uuid, text) from service_role;
grant execute on function public.correct_legacy_order_client(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- §6. Apply-time assertions
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_name text;
  v_proc pg_proc%rowtype;
begin
  -- Definer + pinned search_path on the three new functions.
  foreach v_name in array array[
    'public.order_search_text(public.finance_received_payments)',
    'public.finance_order_confirmed_totals(text)',
    'public.correct_legacy_order_client(uuid, text)'
  ] loop
    select * into v_proc from pg_proc where oid = v_name::regprocedure;
    if not v_proc.prosecdef then
      raise exception 'ASSERT: % must be SECURITY DEFINER', v_name;
    end if;
    if v_proc.proconfig is null
       or not exists (select 1 from unnest(v_proc.proconfig) c where c like 'search_path=%') then
      raise exception 'ASSERT: % must pin its search_path', v_name;
    end if;
  end loop;

  -- Signed-in users only: never anon.
  if has_function_privilege('anon', 'public.order_search_text(public.finance_received_payments)', 'EXECUTE')
     or has_function_privilege('anon', 'public.finance_order_confirmed_totals(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.correct_legacy_order_client(uuid, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.order_search_text(public.finance_received_payments)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.finance_order_confirmed_totals(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.correct_legacy_order_client(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT: the three functions must be executable by authenticated and by nobody else';
  end if;

  -- The correction door asks for finance.manage.
  if position('''manage''' in pg_get_functiondef('public.correct_legacy_order_client(uuid, text)'::regprocedure)) = 0 then
    raise exception 'ASSERT: correct_legacy_order_client must require finance.manage';
  end if;

  -- The guard still freezes every other column and honours the marker.
  if position('boe.legacy_client_correction' in pg_get_functiondef(
       'public.finance_payment_allocations_guard_transition()'::regprocedure)) = 0
     or position('new.allocated_amount' in pg_get_functiondef(
       'public.finance_payment_allocations_guard_transition()'::regprocedure)) = 0
     or position('new.legacy_order_no' in pg_get_functiondef(
       'public.finance_payment_allocations_guard_transition()'::regprocedure)) = 0 then
    raise exception 'ASSERT: the allocation guard must keep its freeze and name the correction marker';
  end if;

  -- The history holds the new event AND every earlier one.
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.finance_payment_request_activity_log'::regclass
       and c.conname = 'finance_payment_request_activity_log_event_type_check'
       and pg_get_constraintdef(c.oid) like '%allocation_legacy_client_corrected%'
       and pg_get_constraintdef(c.oid) like '%request_merged_in%'
       and pg_get_constraintdef(c.oid) like '%allocation_moved%'
       and pg_get_constraintdef(c.oid) like '%cash_handover_recorded%'
  ) then
    raise exception 'ASSERT: the activity event check must hold the new event and every earlier one';
  end if;
end $$;

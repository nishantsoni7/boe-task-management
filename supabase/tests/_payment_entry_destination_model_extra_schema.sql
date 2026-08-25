-- Supplement to the 20261012000000 fixture chain, for
-- 20261013000000_payment_entry_destination_model.sql.
--
-- WHAT THIS ADDS. 113 restates two RPCs and adds a third, so the fixture must
-- carry the PRE-113 forms of the two it restates — otherwise the suite would
-- prove nothing about what changed:
--
--   record_payment_with_allocations   pre-113: REQUIRES a typed customer name
--   approve_finance_payment_request   pre-113: approves, creates no allocation
--
-- plus the three helpers they call that the chain does not build
-- (assert_order_submission_actor, log_order_submission_activity,
-- stamp_is_test_data) and the payment_target_type column approval reads.
--
-- The bodies are faithful in SHAPE to the real ones — the permission gate, the
-- lock, the status rule, the refusal this migration removes — and deliberately
-- shorter where detail cannot affect what is being proved. Where a refusal is
-- the thing under test, it is reproduced exactly.
--
-- Run AFTER _allocation_ledger_single_source_extra_schema.sql and the real
-- 20261012000000 — see run_payment_entry_destination_model_suite.sh.

-- ── Columns the real schema has that the shaped fixture stops short of ───────
alter table public.finance_payment_requests
  add column if not exists payment_target_type text,
  add column if not exists updated_at          timestamptz not null default now(),
  add column if not exists order_request_number text;

alter table public.orders
  add column if not exists client_name text;

-- The cash trail (20260716000000 §1) and the pair rule that governs it
-- (20260716000000 §2). Production has carried both since long before 112; the
-- shaped fixture stops short of them, and submit_payment_request writes them.
alter table public.finance_payment_requests
  add column if not exists collected_by_user_id     uuid references public.users(id),
  add column if not exists collected_from_text      text,
  add column if not exists handed_over_to_user_id   uuid references public.users(id),
  add column if not exists handed_over_at           date,
  add column if not exists collection_handover_note text;

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_handover_pair;
alter table public.finance_payment_requests
  add constraint finance_payment_requests_handover_pair
  check (
    (handed_over_to_user_id is null and handed_over_at is null)
    or
    (handed_over_to_user_id is not null and handed_over_at is not null)
  );

-- ── The real table's own domain rules ────────────────────────────────────────
-- The shaped fixture builds the columns without the CHECKs and with client_name
-- already nullable. Both are restored here, faithfully, BEFORE 113 runs — which
-- is what gives 113's assertions something to prove: that it makes client_name
-- nullable (it starts NOT NULL), and that it leaves the payment_mode domain
-- alone at five values with no 'card'.
update public.finance_payment_requests set client_name = 'Legacy Co' where client_name is null;
alter table public.finance_payment_requests
  alter column client_name set not null;

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_payment_mode_check;
alter table public.finance_payment_requests
  add constraint finance_payment_requests_payment_mode_check
  check (payment_mode in ('bank_transfer','cash','upi','cheque','other'));

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_received_in_check;
alter table public.finance_payment_requests
  add constraint finance_payment_requests_received_in_check
  check (received_in in ('company_account','cash_in_hand','savings_account','other'));

-- received_in is NULLABLE in production since 20260919000000 §1, and proof_note
-- since 20260688000000 ("Payment Proof / Reference is no longer required"). The
-- fixture matches both, so nothing here has to fabricate an account or a proof.
alter table public.finance_payment_requests
  alter column received_in drop not null;
alter table public.finance_payment_requests
  alter column proof_note  drop not null;

-- ── The test-data marker the reset protocol owns ─────────────────────────────
create or replace function public.stamp_is_test_data()
returns trigger language plpgsql as $$
begin
  new.is_test_data := true;
  return new;
end $$;

-- ── Helpers record_payment_with_allocations calls ────────────────────────────
create or replace function public.assert_order_submission_actor()
returns uuid language plpgsql stable as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  return v_actor;
end $$;

create or replace function public.log_order_submission_activity(
  p_submission_id uuid, p_actor uuid, p_event text,
  p_from text, p_to text, p_note text, p_payload jsonb
) returns void language plpgsql as $$
begin
  -- The real one writes order_submission_activity. Nothing in this suite reads
  -- that trail, so this is a no-op that keeps the call site honest.
  return;
end $$;

-- ── order_requests columns approval reads ────────────────────────────────────
alter table public.order_requests
  add column if not exists finalized_at        timestamptz,
  add column if not exists converted_order_id  uuid;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-113 record_payment_with_allocations
-- ═══════════════════════════════════════════════════════════════════════════
-- The refusal 113 removes is reproduced EXACTLY: PAYMENT_CLIENT_REQUIRED. The
-- suite proves it fires before 113 and is gone after.
create or replace function public.record_payment_with_allocations(
  p_amount       numeric,
  p_payment_date date,
  p_payment_mode text,
  p_client_name  text,
  p_received_in  text    default null,
  p_reference    text    default null,
  p_remarks      text    default null,
  p_allocations  jsonb   default '[]'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_client     text;
  v_mode       text;
  v_payment_id uuid;
  v_number     text;
  v_row        jsonb;
  v_kind       text;
  v_target     uuid;
  v_share      numeric;
begin
  if not public.actor_has_module_permission('finance', 'allocate') then
    raise exception 'FINANCE_ALLOCATE_REQUIRED: you may not allocate payments.'
      using errcode = '42501';
  end if;

  v_mode := btrim(lower(coalesce(p_payment_mode, '')));
  if v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque', 'other') then
    raise exception 'PAYMENT_MODE_INVALID' using errcode = 'P0001';
  end if;

  v_client := nullif(btrim(coalesce(p_client_name, '')), '');
  if v_client is null then
    raise exception 'PAYMENT_CLIENT_REQUIRED: name the client this payment came from.'
      using errcode = 'P0001';
  end if;

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in,
     status, submitted_by, sales_note, order_number)
  values
    (v_client, p_amount, p_payment_date, v_mode, p_received_in,
     'pending_approval', v_actor, p_remarks, p_reference)
  returning id, request_number into v_payment_id, v_number;

  for v_row in select jsonb_array_elements(p_allocations) loop
    v_kind   := btrim(lower(v_row->>'kind'));
    v_target := (v_row->>'id')::uuid;
    v_share  := (v_row->>'amount')::numeric;
    perform public.allocate_payment_to_target_internal(
      p_payment_request_id  => v_payment_id,
      p_order_submission_id => case when v_kind = 'submission' then v_target end,
      p_order_id            => case when v_kind = 'order'      then v_target end,
      p_allocated_amount    => v_share
    );
  end loop;

  return jsonb_build_object('payment_request_id', v_payment_id, 'request_number', v_number);
end $$;

revoke execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)
  from public, anon;
grant execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)
  to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRE-113 approve_finance_payment_request
-- ═══════════════════════════════════════════════════════════════════════════
-- Approves and creates NO allocation — the gap 113 closes.
create or replace function public.approve_finance_payment_request(
  p_request_id uuid,
  p_admin_note text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor  uuid := auth.uid();
  v_req    public.finance_payment_requests%rowtype;
  v_status text;
  v_now    timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Authentication required to approve a payment request' using errcode = '28000';
  end if;
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only an admin may approve a payment request' using errcode = '42501';
  end if;

  select * into v_req from public.finance_payment_requests where id = p_request_id for update;
  if not found then
    raise exception 'Payment request % not found', p_request_id using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending_approval' then
    raise exception 'Only a pending payment request can be approved (% is %)',
      v_req.request_number, v_req.status using errcode = 'P0001';
  end if;

  v_status := case when v_req.payment_target_type = 'confirmed_order'
                   then 'approved_linked' else 'approved_unlinked' end;

  update public.finance_payment_requests
     set status = v_status, approved_by = v_actor, approved_at = v_now,
         admin_note = p_admin_note, updated_at = v_now
   where id = p_request_id;

  return jsonb_build_object(
    'request_id', v_req.id, 'request_number', v_req.request_number, 'status', v_status);
end $$;

revoke execute on function public.approve_finance_payment_request(uuid, text) from public, anon;
grant execute on function public.approve_finance_payment_request(uuid, text) to authenticated;

-- ── A reject path, so §6's cancel-on-reject trigger has something to fire on ──
create or replace function public.reject_finance_payment_request(
  p_request_id uuid, p_reason text
) returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only an admin may reject a payment request' using errcode = '42501';
  end if;
  update public.finance_payment_requests
     set status = 'rejected', admin_note = p_reason, updated_at = now()
   where id = p_request_id and status = 'pending_approval';
end $$;
grant execute on function public.reject_finance_payment_request(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- TARGET ELIGIBILITY in the allocator
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The 111 fixture's allocate_payment_to_target_internal stand-in checks the
-- PAYMENT side only. The real one (20260921000000 §…) also refuses an
-- ineligible TARGET, and 113 depends on exactly that: approval re-validates the
-- target by calling the allocator, so a PI converted between submission and
-- verification must be refused THERE, not only at submission.
--
-- This wraps the existing stand-in rather than replacing it: the target checks
-- are added in front, faithful to the real refusals and their error names, and
-- the payment-side behaviour underneath is left exactly as the 111 fixture
-- built it. Without this, assertion 7 would be proving nothing.

alter function public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric)
  rename to allocate_payment_to_target_internal_payment_side;

create or replace function public.allocate_payment_to_target_internal(
  p_payment_request_id  uuid,
  p_order_submission_id uuid    default null,
  p_order_id            uuid    default null,
  p_allocated_amount    numeric default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_sub public.order_submissions%rowtype;
  v_ord public.orders%rowtype;
begin
  if p_order_submission_id is not null then
    select * into v_sub from public.order_submissions where id = p_order_submission_id;
    if not found then
      raise exception 'ALLOCATION_TARGET_NOT_AVAILABLE: the selected PI submission is not available.'
        using errcode = 'P0001';
    end if;
    if v_sub.deletion_claim_token is not null then
      raise exception 'ALLOCATION_TARGET_CLAIMED: this PI is reserved for deletion and cannot receive an allocation.'
        using errcode = 'P0001';
    end if;
    if v_sub.order_id is not null then
      raise exception 'ALLOCATION_TARGET_CONVERTED: this PI has been approved and is now an Order. Allocate to the Order instead.'
        using errcode = 'P0001';
    end if;
    if v_sub.status = 'rejected' then
      raise exception 'ALLOCATION_TARGET_NOT_ACTIVE: a rejected PI cannot receive an allocation.'
        using errcode = 'P0001';
    end if;
  end if;

  if p_order_id is not null then
    select * into v_ord from public.orders where id = p_order_id;
    if not found then
      raise exception 'ALLOCATION_TARGET_NOT_AVAILABLE: the selected Order is not available.'
        using errcode = 'P0001';
    end if;
    if v_ord.status = 'cancelled' then
      raise exception 'ALLOCATION_TARGET_NOT_ACTIVE: Order % is cancelled and cannot receive an allocation.',
        v_ord.display_number using errcode = 'P0001';
    end if;
  end if;

  return public.allocate_payment_to_target_internal_payment_side(
    p_payment_request_id, p_order_submission_id, p_order_id, p_allocated_amount);
end $$;

revoke execute on function public.allocate_payment_to_target_internal(uuid, uuid, uuid, numeric)
  from public, anon, authenticated, service_role;
revoke execute on function public.allocate_payment_to_target_internal_payment_side(uuid, uuid, uuid, numeric)
  from public, anon, authenticated, service_role;

-- ── module_entry_open, with an actual answer ─────────────────────────────────
-- The 111 fixture stubs this to `select true`, which is fine for a suite that
-- never tests entry. 113's §14 does: a user with no Finance entry must not be
-- able to submit a payment request. Faithful to the SHAPE of the real probe —
-- admin always, otherwise an explicit grant — without reproducing the whole
-- module-permission table.
create or replace function public.module_entry_open(p_module text)
returns boolean
language sql stable
as $$
  select coalesce((
    select true
    from public.users u
    where u.id = auth.uid()
      and u.is_active and coalesce(u.is_deleted, false) = false
      and (
        u.role = 'admin'
        or exists (
          select 1 from public.finance_permission_grants g
          where g.user_id = u.id and g.action like p_module || '.%'
        )
      )
  ), false)
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20270331000000 — An admin may delete a Confirmed Payment entered by mistake
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE OWNER'S DECISION (2026-10-21): a verified payment recorded by mistake
-- must be deletable. This lifts the permanence rule of 20261218000000 (owner
-- decision 2026-09-18) for ACTIVE ADMINS ONLY, through the same durable claim
-- protocol as before: a reason, the exact Payment ID typed back, the proof
-- manifest swept, the allocations released in the same statement as the delete,
-- and the claim row kept as the permanent tombstone (who, when, why, amount).
--
-- WHAT CHANGES — four function bodies, bodies extracted from the live
-- migrations by script (never retyped):
--
--   §1 finance_payment_deletable_by   20261218 body minus the verified /
--                                     test-data condition.
--   §2 finance_payment_requests_guard_approved_delete
--                                     20261218 body minus the test-data
--                                     condition inside the finalization
--                                     exemption. Still refuses every caller that
--                                     is not inside finalize_finance_payment_
--                                     deletion for THIS payment id, the
--                                     service role and direct SQL included.
--   §3 begin_finance_payment_deletion 20261011 body plus ONE refusal: a payment
--                                     actively linked to a bank statement line
--                                     (bank_line_payment_links.unlinked_at is
--                                     null) is refused with
--                                     PAYMENT_DELETION_BANK_LINKED. Unlink it in
--                                     Bank Statements first.
--   §4 finalize_finance_payment_deletion
--                                     20261011 body plus the same refusal
--                                     re-checked under the lock, and removal of
--                                     the payment's ALREADY-UNLINKED link notes
--                                     (their foreign key would otherwise refuse
--                                     the delete).
--
-- WHAT IS UNCHANGED: who may delete (active admin), unverified deletion, the
-- Test Data Cleanup path, signatures, grants and the claim table. No table,
-- column, policy or permission change; no row changes at apply time.
-- ROLLBACK: a new, later migration re-emitting the 20261218000000 bodies of §1
-- and §2 (and the 20261011000000 bodies of §3 and §4).
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.finance_payment_deletable_by(uuid, uuid)') is null
     or to_regprocedure('public.begin_finance_payment_deletion(uuid, text, text)') is null
     or to_regprocedure('public.finalize_finance_payment_deletion(uuid, uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20261011000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_finance_payment_deletion_finalization(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20261011000000 (finalization context) must be applied';
  end if;
  if to_regclass('public.bank_line_payment_links') is null then
    raise exception 'DEPENDENCY MISSING: 20270329000000 (bank statements) must be applied before this migration';
  end if;
end $$;

-- ── §1. Who may open a deletion claim ─────────────────────────────────────────

create or replace function public.finance_payment_deletable_by(
  p_payment_id uuid,
  p_actor_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.finance_payment_requests f
    join public.users u on u.id = p_actor_id
    where f.id = p_payment_id
      and u.role = 'admin'
      and u.is_active
      and coalesce(u.is_deleted, false) = false
      -- 20270331000000: the 20261218000000 condition (a verified payment only when
      -- it is test data) is lifted: an active admin may delete a payment of any
      -- status, as 20261011000000 had it.
  )
$$;

-- ── §2. The trigger every DELETE meets ────────────────────────────────────────

create or replace function public.finance_payment_requests_guard_approved_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.in_test_data_cleanup() then
    return old;
  end if;

  -- 20270331000000: the claim protocol may remove a verified payment, test data
  -- or not. Nothing else can: the exemption is for this payment id only and
  -- only inside finalize_finance_payment_deletion's transaction.
  if old.status in ('approved_unlinked', 'approved_linked')
     and public.in_finance_payment_deletion_finalization(old.id)
  then
    return old;
  end if;

  if old.status in ('approved_unlinked', 'approved_linked') then
    raise exception
      'PAYMENT_APPROVED_PERMANENT: Payment % has been approved and is permanent bank payment history',
      old.request_number
      using errcode = '42501';
  end if;

  return old;
end;
$$;

-- ── §3. begin — authorize, refuse a bank-linked payment, freeze, write the manifest ───

create or replace function public.begin_finance_payment_deletion(
  p_payment_id         uuid,
  p_reason             text,
  p_confirm_payment_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_pay      public.finance_payment_requests%rowtype;
  v_claim    public.finance_payment_deletion_claims%rowtype;
  v_paths    text[];
  v_allocs   jsonb;
  v_alloc_ids uuid[];
begin
  if v_actor is null then
    raise exception 'PAYMENT_DELETION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  -- THE ROW IS LOCKED FIRST, exactly as 110 §11d did, so the status the
  -- authorization and the manifest both read cannot move under this call.
  select * into v_pay from public.finance_payment_requests
   where id = p_payment_id for update;
  if not found then
    raise exception 'PAYMENT_DELETION_NOT_FOUND: payment % not found', p_payment_id
      using errcode = 'P0002';
  end if;

  if not public.finance_payment_deletable_by(p_payment_id, v_actor) then
    raise exception 'PAYMENT_DELETION_DENIED: you may not delete this payment'
      using errcode = '42501';
  end if;

  -- 20270331000000: money a reconciler has matched to a bank line is not
  -- deleted from under that match. Unlink it in Bank Statements first.
  if exists (select 1 from public.bank_line_payment_links l
              where l.payment_id = p_payment_id and l.unlinked_at is null) then
    raise exception
      'PAYMENT_DELETION_BANK_LINKED: payment % is linked to a bank statement line; unlink it in Bank Statements first',
      v_pay.human_payment_id
      using errcode = 'P0001';
  end if;

  -- RESUME RATHER THAN REFUSE, before re-validating the reason/confirmation —
  -- a second call finishing an interrupted first one is not a fresh request
  -- and must not be asked to retype anything the first call already recorded.
  select * into v_claim from public.finance_payment_deletion_claims
   where payment_id = p_payment_id and finalized_at is null and released_at is null
   for update;
  if found then
    return jsonb_build_object(
      'claim_token',     v_claim.claim_token,
      'storage_paths',   to_jsonb(v_claim.storage_paths),
      'storage_removed', to_jsonb(v_claim.storage_removed),
      'resumed',         true
    );
  end if;

  -- ── Gate: a reason ──
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'PAYMENT_DELETION_REASON_REQUIRED: enter why this payment is being deleted'
      using errcode = 'P0001';
  end if;

  -- ── Gate: the exact Payment ID, typed ──
  if coalesce(btrim(p_confirm_payment_id), '') <> v_pay.human_payment_id then
    raise exception 'PAYMENT_DELETION_ID_MISMATCH: type % exactly to confirm deletion', v_pay.human_payment_id
      using errcode = 'P0001';
  end if;

  -- The manifest, from the rows themselves — never from anything a browser
  -- sent. Every proof key this payment owns, whatever the payment's status.
  select coalesce(array_agg(a.storage_path order by a.storage_path), '{}')
    into v_paths
  from public.payment_proof_attachments a
  where a.payment_request_id = p_payment_id
    and a.storage_path is not null;

  -- The tombstone snapshot: every allocation this payment carries, active or
  -- reversed, taken before finalize releases them with the payment.
  select coalesce(array_agg(al.id order by al.id), '{}'),
         coalesce(jsonb_agg(jsonb_build_object(
           'id',          al.id,
           'target_type', case when al.order_id is not null then 'order' else 'order_submission' end,
           'target_id',   coalesce(al.order_id, al.order_submission_id),
           'amount',      al.allocated_amount,
           'status',      al.status
         ) order by al.created_at, al.id), '[]'::jsonb)
    into v_alloc_ids, v_allocs
  from public.finance_payment_allocations al
  where al.payment_request_id = p_payment_id;

  insert into public.finance_payment_deletion_claims
    (payment_id, payment_number, payment_status, storage_paths, allocation_ids,
     claimed_by, claimed_by_email,
     human_payment_id, amount, customer_name, deletion_reason, allocation_details)
  values
    (p_payment_id, v_pay.request_number, v_pay.status, v_paths, v_alloc_ids,
     v_actor, (select email from public.users where id = v_actor),
     v_pay.human_payment_id, v_pay.amount, v_pay.client_name, btrim(p_reason), v_allocs)
  returning * into v_claim;

  return jsonb_build_object(
    'claim_token',     v_claim.claim_token,
    'storage_paths',   to_jsonb(v_claim.storage_paths),
    'storage_removed', to_jsonb(v_claim.storage_removed),
    'resumed',         false
  );
end;
$$;

-- ── §4. finalize — clear undone bank notes, stand the guard down, delete ──────

create or replace function public.finalize_finance_payment_deletion(
  p_payment_id  uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_claim  public.finance_payment_deletion_claims%rowtype;
  v_pay    public.finance_payment_requests%rowtype;
  v_allocs integer;
begin
  if v_actor is null then
    raise exception 'PAYMENT_DELETION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  select * into v_claim from public.finance_payment_deletion_claims
   where payment_id = p_payment_id and claim_token = p_claim_token
   for update;
  if not found then
    raise exception 'PAYMENT_DELETION_CLAIM_INVALID: this deletion claim is not current'
      using errcode = '55P03';
  end if;

  if v_claim.finalized_at is not null then
    return v_claim.result || jsonb_build_object('already_deleted', true);
  end if;
  if v_claim.released_at is not null then
    raise exception 'PAYMENT_DELETION_CLAIM_INVALID: this deletion claim was released'
      using errcode = '55P03';
  end if;

  select * into v_pay from public.finance_payment_requests
   where id = p_payment_id for update;
  if not found then
    update public.finance_payment_deletion_claims
       set finalized_at = now(),
           result = jsonb_build_object('allocations_released', 0, 'row_absent', true)
     where id = v_claim.id;
    return jsonb_build_object('allocations_released', 0, 'already_deleted', true);
  end if;

  if not public.finance_payment_deletable_by(p_payment_id, v_actor) then
    raise exception 'PAYMENT_DELETION_DENIED: you may not delete this payment'
      using errcode = '42501';
  end if;

  if not (v_claim.storage_paths <@ v_claim.storage_removed) then
    raise exception
      'PAYMENT_DELETION_PROOF_PENDING: % proof object(s) are still in storage',
      cardinality(v_claim.storage_paths) - cardinality(v_claim.storage_removed)
      using errcode = '55P03';
  end if;

  -- 20270331000000: re-checked under the lock. A link made after begin() stops
  -- the delete; links already undone are history notes only and go with it
  -- (their foreign key would otherwise refuse the delete).
  if exists (select 1 from public.bank_line_payment_links l
              where l.payment_id = p_payment_id and l.unlinked_at is null) then
    raise exception
      'PAYMENT_DELETION_BANK_LINKED: payment % is linked to a bank statement line; unlink it in Bank Statements first',
      v_pay.human_payment_id
      using errcode = 'P0001';
  end if;
  delete from public.bank_line_payment_links
   where payment_id = p_payment_id and unlinked_at is not null;

  select count(*) into v_allocs
  from public.finance_payment_allocations where payment_request_id = p_payment_id;

  -- STAND THE APPROVED-DELETE GUARD DOWN, for this payment id, for the rest of
  -- this transaction only. Everything up to this line has already proved: an
  -- active admin, a standing claim taken with a reason and the typed Payment
  -- ID, and a fully-swept proof manifest. Nothing else in this transaction
  -- reads or writes this setting.
  perform set_config('boe.payment_deletion_finalize', p_payment_id::text, true);

  update public.finance_payment_deletion_claims
     set finalized_at = now(),
         result = jsonb_build_object('allocations_released', v_allocs)
   where id = v_claim.id;

  -- finance_payment_requests_guard_approved_delete now permits this exact row;
  -- finance_payment_requests_release_allocations still deletes the
  -- allocations inside this same statement.
  delete from public.finance_payment_requests where id = p_payment_id;

  return jsonb_build_object('allocations_released', v_allocs, 'already_deleted', false);
end;
$$;


-- Grants are unchanged by create or replace; restated so this file is explicit.
revoke execute on function public.begin_finance_payment_deletion(uuid, text, text) from public, anon;
grant  execute on function public.begin_finance_payment_deletion(uuid, text, text) to authenticated;
revoke execute on function public.finalize_finance_payment_deletion(uuid, uuid) from public, anon;
grant  execute on function public.finalize_finance_payment_deletion(uuid, uuid) to authenticated;

-- ── Apply-time assertions — the migration refuses itself otherwise ──────────

do $$
declare
  v_a text := pg_get_functiondef('public.finance_payment_deletable_by(uuid, uuid)'::regprocedure);
  v_g text := pg_get_functiondef('public.finance_payment_requests_guard_approved_delete()'::regprocedure);
  v_b text := pg_get_functiondef('public.begin_finance_payment_deletion(uuid, text, text)'::regprocedure);
  v_f text := pg_get_functiondef('public.finalize_finance_payment_deletion(uuid, uuid)'::regprocedure);
begin
  if v_a not like '%u.role = ''admin''%' or v_a not like '%u.is_active%'
     or position('is_test_data' in v_a) > 0
     or position('finance_payment_status_is_verified(f.status)' in v_a) > 0 then
    raise exception 'ASSERTION FAILED: finance_payment_deletable_by is not admin-only-any-status';
  end if;
  if v_g not like '%in_test_data_cleanup()%'
     or v_g not like '%in_finance_payment_deletion_finalization(old.id)%'
     or v_g not like '%PAYMENT_APPROVED_PERMANENT%'
     or position('is_test_data' in v_g) > 0 then
    raise exception 'ASSERTION FAILED: the delete guard lost a rule or kept the test-data condition';
  end if;
  if v_b not like '%PAYMENT_DELETION_BANK_LINKED%' or v_b not like '%bank_line_payment_links%'
     or v_b not like '%PAYMENT_DELETION_ID_MISMATCH%' or v_b not like '%PAYMENT_DELETION_REASON_REQUIRED%' then
    raise exception 'ASSERTION FAILED: begin_finance_payment_deletion lost a rule';
  end if;
  if v_f not like '%PAYMENT_DELETION_BANK_LINKED%'
     or v_f not like '%delete from public.bank_line_payment_links%'
     or v_f not like '%PAYMENT_DELETION_PROOF_PENDING%'
     or v_f not like '%boe.payment_deletion_finalize%' then
    raise exception 'ASSERTION FAILED: finalize_finance_payment_deletion lost a rule';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_requests'::regclass
                    and tgname = 'finance_payment_requests_guard_approved_delete'
                    and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: finance_payment_requests_guard_approved_delete is not bound';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon')
     and (has_function_privilege('anon', 'public.begin_finance_payment_deletion(uuid, text, text)', 'execute')
       or has_function_privilege('anon', 'public.finalize_finance_payment_deletion(uuid, uuid)', 'execute')) then
    raise exception 'ASSERTION FAILED: anon may execute a deletion function';
  end if;
  raise notice '20270331000000: an admin may delete a Confirmed Payment through the claim protocol; a bank-linked payment is refused';
end $$;

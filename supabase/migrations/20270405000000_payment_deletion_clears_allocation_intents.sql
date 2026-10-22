-- ═══════════════════════════════════════════════════════════════════════════
-- 20270405000000 — Deleting a Confirmed Payment that was applied from an intent
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DEFECT (seen live 2026-10-22, P-AA-0040): finalize_finance_payment_deletion
-- failed with
--   update or delete on table "finance_payment_allocations" violates foreign key
--   constraint "finance_payment_allocation_intents_applied_allocation_id_fkey"
-- A payment entered with a destination carries an intent whose
-- applied_allocation_id names the allocation it became. Deleting the payment
-- fires finance_payment_requests_release_allocations (BEFORE DELETE), which
-- deletes the allocations while the intent still points at one; the cascade
-- from the payment to its intents only runs afterwards.
--
-- FIX: finalize_finance_payment_deletion deletes the payment's intents before the
-- payment. The body is 20270331000000 §4 extracted by script, plus that one
-- statement. Signature, grants, authorization, claim, bank-link rule and every
-- other line are unchanged. No table, column, policy or permission change; no
-- row changes at apply time.
-- ROLLBACK: a later migration re-emitting the 20270331000000 §4 body.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.finalize_finance_payment_deletion(uuid, uuid)') is null
     or to_regclass('public.finance_payment_allocation_intents') is null then
    raise exception 'DEPENDENCY MISSING: 20270331000000 and 20261013000000 must be applied before this migration';
  end if;
end $$;

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

  -- 20270405000000: the payment's allocation intents go FIRST. An intent that was
  -- applied names its allocation (applied_allocation_id, a no-action FK), and the
  -- release trigger below deletes the allocations BEFORE the cascade from the
  -- payment reaches the intents, so the delete was refused. The intents would be
  -- removed with the payment a moment later regardless (on delete cascade); what
  -- the payment was allocated to is already in the claim's allocation_details.
  delete from public.finance_payment_allocation_intents
   where payment_request_id = p_payment_id;

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

revoke execute on function public.finalize_finance_payment_deletion(uuid, uuid) from public, anon;
grant  execute on function public.finalize_finance_payment_deletion(uuid, uuid) to authenticated;

do $$
declare
  v_f text := pg_get_functiondef('public.finalize_finance_payment_deletion(uuid, uuid)'::regprocedure);
begin
  if position('delete from public.finance_payment_allocation_intents' in v_f) = 0
     or position('delete from public.finance_payment_allocation_intents' in v_f)
        > position('delete from public.finance_payment_requests' in v_f)
     or v_f not like '%PAYMENT_DELETION_BANK_LINKED%'
     or v_f not like '%PAYMENT_DELETION_PROOF_PENDING%'
     or v_f not like '%boe.payment_deletion_finalize%' then
    raise exception 'ASSERTION FAILED: finalize_finance_payment_deletion lost a rule or does not clear intents before the delete';
  end if;
  raise notice '20270405000000: a payment applied from an intent can now be deleted';
end $$;

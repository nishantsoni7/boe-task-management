-- ════════════════════════════════════════════════════════════════════════════
-- 20270323000000 — A ROLE ADMIN MAY ATTACH A PROOF TO A PAYMENT THAT IS STILL
--                  AWAITING A DECISION
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE GAP. Since 20260672 only the person who SUBMITTED a payment can attach a
-- proof file to it, and only while it is pending_approval (storage policy
-- payment_proofs_insert, row policy payment_proof_attachments_insert). An admin
-- who opens Edit Payment Request on someone else's pending payment can correct
-- every field — amount, date, account, reference, notes — but cannot add the
-- screenshot that was sent to them, because the file write is refused.
--
-- THE RULE ADDED. An ACTIVE role admin may add a proof file to a payment that is
-- not yet verified and not deleted: pending_approval, needs_clarification or
-- rejected. The proof row must name the admin as its creator, and the file must
-- live under that payment's own folder, exactly as today.
--
-- WHAT DOES NOT CHANGE. The submitter's own rules are untouched (same policies,
-- same pending-only window). A VERIFIED payment (approved_unlinked / approved_linked)
-- still takes no new proof from anybody: the evidence of a confirmed payment is
-- not rewritten. DELETE already lets an admin remove a proof (20260672); reading
-- is unchanged (20270118120000). No payment, allocation, status or amount rule
-- is touched, the bucket stays private, anon gets nothing, no data is written.
--
-- ORDERING. After 20270322000000. Apply this BEFORE the code that offers the
-- upload to admins is deployed: without it an admin's upload is refused and the
-- form says the proof did not upload (the correction itself is still saved).
-- Rollback: drop the two policies, then the function.
-- ════════════════════════════════════════════════════════════════════════════

do $dep$
begin
  if to_regclass('public.payment_proof_attachments') is null
     or to_regclass('public.finance_payment_requests') is null then
    raise exception 'DEPENDENCY MISSING: the payment proof table and the payment table must exist';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'finance_payment_requests'
                    and column_name = 'deleted_at') then
    raise exception 'DEPENDENCY MISSING: finance_payment_requests.deleted_at (20270226000000)';
  end if;
end $dep$;


-- ═══ §1. The one rule, in one place ═════════════════════════════════════════
-- Takes the folder as TEXT and compares text to text, so an unexpected object
-- name can never raise a uuid cast error: it simply matches nothing.

create or replace function public.admin_may_attach_payment_proof(p_payment_folder text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.users u
      join public.finance_payment_requests p on p.id::text = p_payment_folder
     where u.id = auth.uid()
       and u.role = 'admin'
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and p.deleted_at is null
       and p.status in ('pending_approval', 'needs_clarification', 'rejected')
  );
$fn$;

comment on function public.admin_may_attach_payment_proof(text) is
  'True when the signed-in caller is an active role admin and the payment named by the folder is unverified (pending_approval, needs_clarification, rejected) and not deleted. Used by the admin INSERT policies on payment_proof_attachments and storage.objects (bucket payment-proofs). 20270323000000.';

revoke execute on function public.admin_may_attach_payment_proof(text) from public, anon;
grant  execute on function public.admin_may_attach_payment_proof(text) to authenticated;


-- ═══ §2. The proof row ══════════════════════════════════════════════════════

drop policy if exists payment_proof_attachments_admin_insert on public.payment_proof_attachments;
create policy payment_proof_attachments_admin_insert on public.payment_proof_attachments
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.admin_may_attach_payment_proof(payment_request_id::text)
  );


-- ═══ §3. The file ═══════════════════════════════════════════════════════════

drop policy if exists payment_proofs_admin_insert on storage.objects;
create policy payment_proofs_admin_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and public.admin_may_attach_payment_proof(split_part(name, '/', 1))
  );


-- ═══ Assertions, on the DEPLOYED objects ════════════════════════════════════

do $assert$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_proof_attachments'
                  and policyname = 'payment_proof_attachments_admin_insert' and cmd = 'INSERT'
                  and roles::text = '{authenticated}') then
    raise exception 'ASSERTION FAILED: the admin proof-row INSERT policy is missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'payment_proofs_admin_insert' and cmd = 'INSERT'
                  and roles::text = '{authenticated}'
                  and with_check like '%payment-proofs%'
                  and with_check like '%admin_may_attach_payment_proof%') then
    raise exception 'ASSERTION FAILED: the admin proof-file INSERT policy is missing or not bucket-scoped';
  end if;

  -- The submitter's own rules are untouched.
  if (select with_check from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname = 'payment_proofs_insert') not like '%fpr.submitted_by = auth.uid()%pending_approval%' then
    raise exception 'ASSERTION FAILED: the submitter storage insert rule changed';
  end if;

  -- A verified payment is not in the rule.
  if pg_get_functiondef('public.admin_may_attach_payment_proof(text)'::regprocedure) like '%approved_%' then
    raise exception 'ASSERTION FAILED: the rule must not admit a verified payment';
  end if;

  if has_function_privilege('anon', 'public.admin_may_attach_payment_proof(text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute admin_may_attach_payment_proof';
  end if;
  if (select public from storage.buckets where id = 'payment-proofs') then
    raise exception 'ASSERTION FAILED: the payment-proofs bucket is public';
  end if;

  raise notice '20270323000000 applied: a role admin may attach a proof to an unverified payment.';
end $assert$;

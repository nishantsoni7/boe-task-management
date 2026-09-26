-- ════════════════════════════════════════════════════════════════════════════
-- 20270118120000 — A PAYMENT'S PROOF OPENS FOR THE PEOPLE WHO REVIEW THAT
--                  PAYMENT, AND FOR NOBODY ELSE
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT (production, SELECT-only, 2026-09-26). Once a proof can be
-- attached at all (20270117000000), the people who verify payments cannot open
-- it:
--
--   * the proof ROW (payment_proof_attachments) is readable by its recorder, a
--     role admin, a holder of finance.view_all, and any "participant" of the
--     PI/Order the payment is allocated to;
--   * the proof FILE (storage.objects, bucket payment-proofs, policy
--     payment_proofs_select) is readable only by the recorder — matched on the
--     first folder of the path — or a role admin.
--
--   So a verifier who is not role admin (Nitish: finance.approve +
--   finance.view_all; Dhruv: finance.approve) sees that a proof exists and
--   cannot open it; Dhruv cannot even see that it exists. And the file rule is
--   bound to a path GUESS (the first folder), not to the proof actually on
--   record.
--
-- THE RULE, IN ONE PLACE. public.can_open_payment_proof(payment_id) is true for
-- an ACTIVE, non-deleted caller when the payment exists and the caller is
--   * the person who recorded it, or
--   * a reviewer of payments: role admin or finance.approve (the verification
--     authority), or finance.view_all (company-wide Finance sight) — both with
--     Finance module entry, and both granted in Control Center.
-- Participants of a PI/Order (Operations, Sales on someone else's PI) are NOT
-- reviewers of the payment and do not open its proof.
--
-- WHAT CHANGES, AND ONLY THIS:
--
--   §1  can_open_payment_proof(uuid), and payment_proof_object_readable(name,
--       owner_id) for the storage rule: a file opens only when a proof row
--       names EXACTLY that path under EXACTLY that payment's folder and
--       can_open_payment_proof() says yes for that payment. A guessed or
--       unrecorded path opens nothing — with two narrow exceptions, both of
--       which exist today and are kept so nothing that works stops working:
--         - the uploader may read their OWN upload that no proof row names
--           yet (Storage's remove() needs SELECT, and attachPaymentProof
--           removes its own upload when saving the row fails);
--         - a role admin may read any file in the bucket (the Control Center
--           test-data cleanup removes files after their rows are gone).
--   §2  payment_proofs_select on storage.objects is replaced by one that asks
--       §1. INSERT and DELETE on storage, and INSERT/DELETE on the proof rows,
--       are unchanged: only the recorder attaches a proof, only while the
--       payment is pending.
--   §3  One more SELECT policy on payment_proof_attachments, for the same
--       reviewers (so a finance.approve verifier can find the proof to open).
--       The module-entry gate (RESTRICTIVE) still applies to it.
--
-- WHAT IT DOES NOT DO. No payment, allocation, verification or UTR rule
-- changes; the bucket stays private; no grant to anon; no data is touched.
--
-- ORDERING. After 20270117000000 (#230, proofs can be attached) and before
-- 20270120000000 (#226, Record Payment completes after the proof).
-- Rollback: restore payment_proofs_select as 20260672 defines it (live 2026-09-26),
-- drop payment_proof_attachments_reviewer_select, drop the two functions.
-- ════════════════════════════════════════════════════════════════════════════

do $dep$
begin
  if to_regclass('public.payment_proof_attachments') is null
     or to_regprocedure('public.actor_has_module_permission(text, text)') is null
     or to_regprocedure('public.actor_has_permission(text, text)') is null
     or to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'DEPENDENCY MISSING: the payment proof table and the permission helpers must exist';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                  and policyname = 'payment_proofs_select') then
    raise exception 'DEPENDENCY MISSING: storage policy payment_proofs_select, which this file replaces';
  end if;
end $dep$;


-- ═══ §1. Who may open a payment's proof ═════════════════════════════════════

create or replace function public.can_open_payment_proof(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from public.finance_payment_requests p
      join public.users u on u.id = auth.uid()
     where p.id = p_payment_id
       and u.is_active
       and coalesce(u.is_deleted, false) = false
       and (
         p.submitted_by = u.id
         or (public.module_entry_open('finance')
             and (public.actor_has_module_permission('finance', 'approve')
                  or public.actor_has_permission('finance', 'view_all')))
       )
  );
$fn$;

comment on function public.can_open_payment_proof(uuid) is
  'True when the signed-in, active caller recorded this payment, or reviews payments (role admin or finance.approve, or finance.view_all, with Finance module entry). Participants of the PI/Order are not reviewers. 20270118120000.';

revoke execute on function public.can_open_payment_proof(uuid) from public, anon;
grant  execute on function public.can_open_payment_proof(uuid) to authenticated;

create or replace function public.payment_proof_object_readable(p_name text, p_owner_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_payment uuid;
  v_recorded boolean;
begin
  if auth.uid() is null or p_name is null then
    return false;
  end if;

  -- A role admin reads any proof file (kept from the policy this replaces:
  -- the Control Center test-data cleanup removes files after their rows).
  if exists (select 1 from public.users u
              where u.id = auth.uid() and u.role = 'admin'
                and u.is_active and coalesce(u.is_deleted, false) = false) then
    return true;
  end if;

  -- BOUND TO THE RECORD: the one proof row that names exactly this path, under
  -- exactly its payment's folder.
  select a.payment_request_id into v_payment
    from public.payment_proof_attachments a
   where a.storage_path = p_name
     and a.payment_request_id::text = split_part(p_name, '/', 1)
   limit 1;
  v_recorded := found;

  if v_recorded then
    return public.can_open_payment_proof(v_payment);
  end if;

  -- An upload no proof row names yet: only its own uploader, so a failed
  -- attach can remove it (Storage's remove() needs SELECT). Nobody else.
  return not exists (select 1 from public.payment_proof_attachments a where a.storage_path = p_name)
     and p_owner_id is not null
     and p_owner_id = auth.uid()::text;
end;
$fn$;

comment on function public.payment_proof_object_readable(text, text) is
  'Storage SELECT rule for bucket payment-proofs: a role admin; else a file named by a proof row under that payment''s folder, for a caller can_open_payment_proof() admits; else only the uploader of an upload no row names yet. 20270118120000.';

revoke execute on function public.payment_proof_object_readable(text, text) from public, anon;
grant  execute on function public.payment_proof_object_readable(text, text) to authenticated;


-- ═══ §2. The file rule asks §1 ══════════════════════════════════════════════

drop policy if exists payment_proofs_select on storage.objects;
create policy payment_proofs_select on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs'
         and public.payment_proof_object_readable(name, owner_id));


-- ═══ §3. Reviewers can find the proof they may open ═════════════════════════

drop policy if exists payment_proof_attachments_reviewer_select on public.payment_proof_attachments;
create policy payment_proof_attachments_reviewer_select on public.payment_proof_attachments
  for select to authenticated
  using (public.can_open_payment_proof(payment_request_id));


-- ═══ Assertions, on the DEPLOYED objects ════════════════════════════════════

do $assert$
declare
  v_qual text;
begin
  select qual into v_qual from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and policyname = 'payment_proofs_select';
  if v_qual is null or v_qual not like '%payment_proof_object_readable(name, owner_id)%'
     or v_qual not like '%payment-proofs%' then
    raise exception 'ASSERTION FAILED: payment_proofs_select does not ask payment_proof_object_readable for the payment-proofs bucket';
  end if;
  if (select roles::text from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname = 'payment_proofs_select') <> '{authenticated}' then
    raise exception 'ASSERTION FAILED: payment_proofs_select must be for authenticated only';
  end if;

  -- The write rules are untouched: still recorder-only, still pending-only.
  if (select with_check from pg_policies where schemaname = 'storage' and tablename = 'objects'
        and policyname = 'payment_proofs_insert') not like '%fpr.submitted_by = auth.uid()%pending_approval%' then
    raise exception 'ASSERTION FAILED: the storage insert rule changed';
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_proof_attachments'
                  and policyname = 'payment_proof_attachments_reviewer_select' and cmd = 'SELECT') then
    raise exception 'ASSERTION FAILED: the reviewer SELECT policy is missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_proof_attachments'
                  and policyname = 'payment_proof_attachments_module_entry_gate' and permissive = 'RESTRICTIVE') then
    raise exception 'ASSERTION FAILED: the module-entry gate on proof rows is gone';
  end if;

  -- Participants are not reviewers.
  if pg_get_functiondef('public.can_open_payment_proof(uuid)'::regprocedure) like '%can_read_payment_as_participant%' then
    raise exception 'ASSERTION FAILED: can_open_payment_proof must not admit participants';
  end if;

  if has_function_privilege('anon', 'public.can_open_payment_proof(uuid)', 'execute')
     or has_function_privilege('anon', 'public.payment_proof_object_readable(text, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can execute a proof-access function';
  end if;
  if (select public from storage.buckets where id = 'payment-proofs') then
    raise exception 'ASSERTION FAILED: the payment-proofs bucket is public';
  end if;

  raise notice '20270118120000 applied: a payment''s proof opens for its recorder and its reviewers only.';
end $assert$;

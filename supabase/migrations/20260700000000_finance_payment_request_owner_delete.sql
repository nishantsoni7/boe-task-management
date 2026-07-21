-- Finance: let a salesperson delete their own UNAPPROVED payment request.
--
-- Business rule being implemented
-- ------------------------------
-- A creator manages the payment requests they raised until an admin approves
-- one. Approval is the hard locking point: from that moment the record belongs
-- to the Received Payments workflow and is closed to the creator entirely.
--
--   pending_approval | needs_clarification | rejected  -> creator may edit and delete
--   approved_unlinked | approved_linked               -> creator may do neither
--
-- What was in place before this migration
-- ---------------------------------------
--   * finance_payment_requests_own_update (20260653, widened by 20260695)
--     already scopes creator UPDATE to exactly the three unapproved statuses.
--     Unchanged here.
--   * finance_payment_requests_own_delete_pending (20260672 §2b) granted
--     creator DELETE only for 'pending_approval' AND only within 15 minutes of
--     creation. That was deliberately a *compensation* grant for a failed
--     proof upload, not a user-facing feature, and 20260654 had made DELETE
--     admin-only on purpose.
--
-- This migration replaces that narrow grant with the real business rule. The
-- consequence is accepted and stated plainly: because
-- finance_payment_request_activity_log cascades on delete (20260674), a
-- creator deleting their own request also destroys that request's activity
-- history. No soft-delete or archive layer is introduced — deletion stays a
-- hard delete, and it stays impossible once the request is approved.
--
-- Admin DELETE (finance_payment_requests_admin_delete, 20260654) is NOT
-- narrowed. It cannot be: Payment Requests and Received Payments are the same
-- table, and the admin correction workflow on the Received Payments page
-- depends on being able to edit and delete approved rows. Keeping approved
-- rows out of reach of the Payment Requests page is therefore enforced in that
-- page's UI, not in the database, and only for admins — for a creator the lock
-- is real and enforced here in three independent ways (RLS UPDATE policy, RLS
-- DELETE policy, and the two guard triggers below).

-- ── 1. Creator DELETE: own row, unapproved statuses only ──────────────────────
-- No time window. The status list is evaluated by RLS against the CURRENT
-- committed row at delete time, which is also what makes the client's
-- conditional delete race-safe: if an admin approves the request while the
-- confirmation modal is open, the DELETE simply matches zero rows.

drop policy if exists "finance_payment_requests_own_delete_pending" on public.finance_payment_requests;
drop policy if exists "finance_payment_requests_own_delete"         on public.finance_payment_requests;

create policy "finance_payment_requests_own_delete"
  on public.finance_payment_requests
  for delete to authenticated
  using (
    submitted_by = auth.uid()
    and status in ('pending_approval', 'needs_clarification', 'rejected')
  );

-- ── 2. Post-approval UPDATE guard (idempotent restatement of 20260699 §5) ─────
-- 20260699000000 is applied on the linked project, so this section is a no-op
-- there: the body below is byte-for-byte the deployed one. It is restated so
-- this migration is complete on its own — on any environment where 20260699
-- has not been applied, the creator's post-approval lock still lands with it.
-- The function references only columns that exist since 20260628000200, so it
-- compiles whether or not 20260699's order_request_id column is present.

create or replace function public.finance_payment_requests_guard_approved()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Service-role / direct SQL, and admins, are exempt.
  if v_actor is null then
    return new;
  end if;

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return new;
  end if;

  if old.status not in ('approved_unlinked', 'approved_linked') then
    return new;
  end if;

  if new.client_name     is distinct from old.client_name
     or new.amount          is distinct from old.amount
     or new.payment_date    is distinct from old.payment_date
     or new.payment_mode    is distinct from old.payment_mode
     or new.received_in     is distinct from old.received_in
     or new.proof_note      is distinct from old.proof_note
     or new.sales_note      is distinct from old.sales_note
     or new.payment_against is distinct from old.payment_against
     or new.status          is distinct from old.status
     or new.order_id        is distinct from old.order_id
     or new.order_number    is distinct from old.order_number
     or new.submitted_by    is distinct from old.submitted_by
     or new.approved_by     is distinct from old.approved_by
     or new.approved_at     is distinct from old.approved_at
     or new.created_at      is distinct from old.created_at
     or new.admin_note      is distinct from old.admin_note
  then
    raise exception 'Payment % has been approved and can no longer be edited', old.request_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.finance_payment_requests_guard_approved() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_guard_approved on public.finance_payment_requests;

create trigger finance_payment_requests_guard_approved
  before update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved();

-- ── 3. Post-approval DELETE guard (new) ───────────────────────────────────────
-- Section 1's policy already filters a creator's DELETE of an approved row to
-- zero rows. This trigger states the same rule as a hard failure on the table
-- itself, so it holds for every write path rather than only for the policy that
-- authorized the statement, and survives any future policy edit — the same
-- reasoning 20260699 §4/§5 used for the update side.
--
-- Admins are exempt: the Received Payments page's Delete action is the
-- sanctioned way to remove an approved payment, and it deletes from this same
-- table. auth.uid() IS NULL (service role / direct SQL / maintenance) is exempt
-- for the same reason as in the update guard.
--
-- Note this trigger does not fire for cascaded deletes of CHILD rows — it is on
-- finance_payment_requests itself. Nothing cascades INTO this table: order_id
-- and order_request_id are plain FKs to orders/order_requests with no ON DELETE
-- CASCADE, so no order or order-request deletion can remove a payment row.

create or replace function public.finance_payment_requests_guard_approved_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    return old;
  end if;

  if exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    return old;
  end if;

  if old.status in ('approved_unlinked', 'approved_linked') then
    raise exception 'Payment % has been approved and can no longer be deleted', old.request_number
      using errcode = '42501';
  end if;

  return old;
end;
$$;

revoke execute on function public.finance_payment_requests_guard_approved_delete() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_guard_approved_delete on public.finance_payment_requests;

create trigger finance_payment_requests_guard_approved_delete
  before delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved_delete();

-- ── 4. Proof-object cleanup after a request is deleted ────────────────────────
-- payment_proof_attachments cascades with the request (20260672), but the
-- object in the private payment-proofs bucket does not — deleting a request
-- has always left its proof file behind as an orphan.
--
-- The client cannot simply delete the object first: if the subsequent request
-- delete were then refused (an approval landing in between), it would have
-- destroyed the proof of a payment that still exists. So the request is deleted
-- FIRST and the object removed afterwards — at which point the existing
-- submitter branch below no longer matches, because it resolves ownership
-- THROUGH the request row that is now gone.
--
-- Both existing branches are reproduced unchanged; only the third is new. It
-- authorizes an uploader to remove their own object exactly when no payment
-- request owns its path any more. Such an object is an orphan by definition, so
-- this can never reach the proof of a live request, approved or otherwise —
-- the submitter branch's 'pending_approval' restriction (which is what stops a
-- creator destroying the evidence behind a request they still hold) is
-- deliberately left as it was.
--
-- owner_id is the current Supabase storage ownership column and owner is its
-- deprecated uuid predecessor; both are checked so objects uploaded under
-- either convention can be cleaned up. An object with neither set simply fails
-- to match and is reported to the user as a failed cleanup rather than silently
-- treated as deleted.

drop policy if exists "payment_proofs_delete" on storage.objects;

create policy "payment_proofs_delete"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (
      -- Submitter, only while the request is still pending (unchanged).
      exists (
        select 1 from public.finance_payment_requests fpr
        where fpr.id::text = split_part(storage.objects.name, '/', 1)
          and fpr.submitted_by = auth.uid()
          and fpr.status = 'pending_approval'
      )
      -- Admin, unrestricted (unchanged).
      or exists (
        select 1 from public.users u
        where u.id = auth.uid() and u.role = 'admin'
      )
      -- NEW: uploader cleaning up an object whose payment request no longer exists.
      or (
        (storage.objects.owner_id = auth.uid()::text or storage.objects.owner = auth.uid())
        and not exists (
          select 1 from public.finance_payment_requests fpr
          where fpr.id::text = split_part(storage.objects.name, '/', 1)
        )
      )
    )
  );

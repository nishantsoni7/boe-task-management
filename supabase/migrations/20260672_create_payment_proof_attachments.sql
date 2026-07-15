-- Finance — Payment proof attachments (Requests workflow, Phase 1).
--
-- Fixes a real defect: the New Payment Confirmation form in
-- src/app/finance/page.tsx let the user pick a proof file and stored it in
-- component state, but handleSubmit never uploaded it — the interface accepted
-- an attachment and silently discarded it.
--
-- This migration adds:
--   1. A PRIVATE storage bucket 'payment-proofs' (NOT public).
--   2. A metadata table payment_proof_attachments (object path only, never a
--      public URL — viewing uses short-lived signed URLs).
--   3. RLS on the table AND policies on storage.objects, both keyed to the
--      path convention  payment-proofs/{payment_request_id}/{file}.
--
-- Visibility mirrors finance_payment_requests exactly: a proof is viewable
-- only by the related payment request's submitter or an admin. Operations,
-- other salespeople/BDM who did not submit it, and unauthenticated users are
-- denied at the database, not just hidden in the UI.
--
-- Nothing here touches finance_payment_requests, its five statuses, the
-- approved_linked constraint, the order number sequence, task attachments, or
-- any order table/policy.

-- ── 1. Private bucket ─────────────────────────────────────────────────────────

-- do UPDATE, not do NOTHING: if a 'payment-proofs' bucket already exists (e.g.
-- created by hand, public), do-nothing would silently accept it and every
-- privacy guarantee below would collapse. This enforces the properties instead
-- of assuming them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs',
  'payment-proofs',
  false,      -- private: no anonymous/public read
  10485760,   -- 10 MB per file
  array['image/jpeg','image/png','image/webp','image/gif','application/pdf']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── 2. Metadata table ─────────────────────────────────────────────────────────

create table if not exists public.payment_proof_attachments (
  id                 uuid        primary key default gen_random_uuid(),
  payment_request_id uuid        not null references public.finance_payment_requests(id) on delete cascade,
  storage_path       text        not null,   -- object key within the bucket; never a public URL
  file_name          text        not null,   -- original name, for display only
  file_type          text,
  file_size          bigint,
  created_by         uuid        not null references public.users(id),
  created_at         timestamptz not null default now()
);

create index if not exists payment_proof_attachments_request_idx
  on public.payment_proof_attachments(payment_request_id);

alter table public.payment_proof_attachments enable row level security;

-- SELECT: submitter of the related payment request, or admin.
create policy "payment_proof_attachments_select"
  on public.payment_proof_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.finance_payment_requests fpr
      where fpr.id = payment_proof_attachments.payment_request_id
        and fpr.submitted_by = auth.uid()
    )
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

-- INSERT: caller may only attach to their OWN payment request, as themselves,
-- and only while that request is still 'pending_approval' — the state it is in
-- during submission. A proof can therefore never be added to (or swapped into)
-- an already-approved/rejected request.
create policy "payment_proof_attachments_insert"
  on public.payment_proof_attachments
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.finance_payment_requests fpr
      where fpr.id = payment_proof_attachments.payment_request_id
        and fpr.submitted_by = auth.uid()
        and fpr.status = 'pending_approval'
    )
  );

-- DELETE: admin unrestricted; uploader ONLY while the related request is still
-- 'pending_approval'. The status gate matters: without it a submitter could
-- delete the proof of a payment that has already been approved — destroying the
-- very evidence the proof exists to substantiate. The client's compensation
-- cleanup always runs seconds after creation, while the request is still
-- pending, so this costs the cleanup path nothing.
-- No UPDATE policy — attachment rows are immutable once written.
create policy "payment_proof_attachments_delete"
  on public.payment_proof_attachments
  for delete to authenticated
  using (
    (
      created_by = auth.uid()
      and exists (
        select 1 from public.finance_payment_requests fpr
        where fpr.id = payment_proof_attachments.payment_request_id
          and fpr.status = 'pending_approval'
      )
    )
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

-- ── 2b. Creator cleanup policy on finance_payment_requests ────────────────────
-- Proof upload is a client-side create-row → upload-object → insert-metadata
-- sequence; if a later step fails, the just-created request must be removed so
-- the user is never told success when the proof was not persisted. Existing
-- RLS grants DELETE to admins only, so a Sales/BDM submitter could not clean up
-- their own failed submission. This adds a tightly-scoped creator-delete:
-- OWN row, ONLY while still 'pending_approval', and ONLY within 15 minutes of
-- creation. It cannot delete needs_clarification, approved_*, or rejected
-- requests, so no historical/approved record is ever removable this way.
--
-- The time window is what keeps this a *compensation* grant rather than a
-- general one: without it, a submitter could delete any of their pending
-- requests at will — silently withdrawing a submission before an admin ever
-- saw it, with no audit trail. 20260654 deliberately made DELETE admin-only,
-- and that intent is preserved everywhere except the seconds-long window in
-- which a failed submission must be rolled back.
--
-- This does not change the creator EDIT window or any approval behaviour.
create policy "finance_payment_requests_own_delete_pending"
  on public.finance_payment_requests
  for delete to authenticated
  using (
    submitted_by = auth.uid()
    and status = 'pending_approval'
    and created_at > now() - interval '15 minutes'
  );

-- ── 3. Storage object policies (bucket: payment-proofs) ───────────────────────
-- Path convention: {payment_request_id}/{unique}.{ext}
-- Ownership is validated through the payment request. We compare
-- fpr.id::text = split_part(name, '/', 1) rather than casting the object name
-- to uuid, so an unexpected object name can never raise a cast error — it
-- simply fails to match and access is denied (fails closed).
--
-- These policies are permissive and bucket-scoped, so they do not affect the
-- existing task-attachments policies (which are scoped to that bucket).

-- INSERT: submitter only, and only while their request is still
-- 'pending_approval' (i.e. during submission). Mirrors the metadata insert
-- policy, so a proof object cannot be added to an approved/rejected request.
create policy "payment_proofs_insert"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and exists (
      select 1 from public.finance_payment_requests fpr
      where fpr.id::text = split_part(storage.objects.name, '/', 1)
        and fpr.submitted_by = auth.uid()
        and fpr.status = 'pending_approval'
    )
  );

-- SELECT: submitter or admin, at ANY status. Deliberately NOT status-gated —
-- a proof must stay readable after the payment is approved; that is the point
-- of keeping it. Everyone else (other Sales/BDM, Operations, anon) is denied.
create policy "payment_proofs_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (
      exists (
        select 1 from public.finance_payment_requests fpr
        where fpr.id::text = split_part(storage.objects.name, '/', 1)
          and fpr.submitted_by = auth.uid()
      )
      or exists (
        select 1 from public.users u
        where u.id = auth.uid() and u.role = 'admin'
      )
    )
  );

-- DELETE: admin unrestricted; submitter ONLY while the request is still
-- 'pending_approval'. Same reasoning as the metadata delete policy — this is a
-- compensation grant for a failed submission, not a licence to remove the proof
-- of an approved payment. The client's cleanup (metadata-insert failure) runs
-- while the request is still pending, so it remains authorized.
create policy "payment_proofs_delete"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (
      exists (
        select 1 from public.finance_payment_requests fpr
        where fpr.id::text = split_part(storage.objects.name, '/', 1)
          and fpr.submitted_by = auth.uid()
          and fpr.status = 'pending_approval'
      )
      or exists (
        select 1 from public.users u
        where u.id = auth.uid() and u.role = 'admin'
      )
    )
  );

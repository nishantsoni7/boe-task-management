-- Order Requests — Main PI + reference attachments with DB-backed finalization.
--
-- New business requirement: creating an Order Request must carry file
-- attachments. Two categories:
--   * main_pi   — the primary commercial document (Proforma Invoice). MANDATORY,
--                 and EXACTLY ONE per finalized request.
--   * reference — optional supporting files (drawings, images, specifications,
--                 client documents). Zero or many.
--
-- Why finalization (the core safety property)
-- -------------------------------------------
-- A request row must be created BEFORE its files, because the storage RLS keys
-- ownership off the request id in the object path. That opens a window in which
-- a row exists without its mandatory Main PI. If an upload (or the browser) dies
-- in that window, the naive design leaves a normal-looking "submitted" request
-- with no PI — already notified and counted.
--
-- This migration closes that window with an UPLOAD-STAGE / FINALIZED flag:
--   * order_requests.finalized_at IS NULL  → a draft in the upload stage. It is
--     invisible to reviewers/assignees (RLS), excluded from ordinary queries,
--     fires NO notification and NO request_submitted activity, and can be
--     removed only through the narrow cleanup_unfinalized_order_request RPC.
--   * order_requests.finalized_at IS NOT NULL → an operational, submitted
--     request, exactly as before this migration.
--
-- Compatibility (the reason there is no force-draft trigger): the flag is driven
-- by a column DEFAULT now(), not by forcing every insert to NULL. An OLD
-- (attachment-unaware) client OMITS finalized_at and its row self-finalizes via
-- the default — so old and new frontends can create requests side by side, with
-- no timed activation and no stale-tab window. The NEW client sends an explicit
-- NULL to open a draft, and finalize_order_request() is the ONLY way that draft
-- becomes non-null, refusing unless EXACTLY ONE main_pi row exists.
--
-- Compatibility limitation (documented, accepted): the legacy path is simply
-- "omit finalized_at" and MUST stay open, so any authenticated creator can
-- likewise mint an operational request with no Main PI. The INSERT policy is
-- therefore left exactly as 20260710 and does NOT try to guard finalized_at (see
-- §2b for why a value guard would be theatre). During the compatibility window
-- the "exactly one Main PI" guarantee is DB-enforced for the NEW draft→finalize
-- path and convention-enforced for legacy inserts; a later hardening migration
-- retires legacy creation once the old frontend is gone (see §2b + roadmap).
--
-- Mirrors the Finance payment-proof implementation (20260672) for the private
-- bucket + signed-URL access, and the Order Request activity/RPC conventions
-- (20260680 / 20260698). It is intentionally separate from 20260710 (assignee
-- ownership) — that file is not touched.

-- ── 1. Private bucket ─────────────────────────────────────────────────────────
-- do UPDATE, not do NOTHING: enforce the private/limit/type properties even if a
-- bucket with this id already exists. Allowed types are the safe, well-defined
-- set the codebase already trusts for task attachments (20260607) — PDF, still
-- images, Office documents (NON-macro only), and plain text/CSV. No executables,
-- no macro-enabled Office formats, and no application/octet-stream (which would
-- turn the gate into "any binary"). ZIP is deliberately excluded from this phase
-- (a container can hold anything; it needs an explicit product decision, not an
-- automatic inclusion). Raw CAD (DWG/DXF) is likewise not accepted: browsers
-- report its MIME inconsistently and admitting it would require octet-stream — a
-- CAD file is exported to PDF instead.
--
-- PER-FILE SIZE LIMIT — 10 MB, the BOE product rule
-- -------------------------------------------------
-- No Order Request attachment may be STORED above 10 MB. A user may SELECT a
-- larger file, but the app must then reduce it below the limit with a safe,
-- format-specific processor (today: images only) or refuse it. The original
-- oversized bytes never reach Storage.
--
-- This bucket limit is the INDEPENDENT BACKEND ENFORCEMENT of that rule, not the
-- first line of defence: the client checks first so the user gets a useful
-- message, and the bucket refuses regardless of what any client believes. It MUST
-- stay equal to ORDER_REQ_ATTACHMENT_MAX_BYTES in
-- src/lib/orderRequestAttachments.ts — one rule expressed in two places.
--
-- NOT to be confused with the Supabase PROJECT-WIDE Storage ceiling, which is
-- 50 MB on this project's plan (Dashboard → Storage → Settings, verified
-- 2026-07-25; fixed on the Free plan). That is infrastructure headroom, not
-- permission — the product limit is 10 MB and is deliberately far below it. Do
-- not raise this bucket toward the infrastructure ceiling: they answer different
-- questions.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'order-request-attachments',
  'order-request-attachments',
  false,      -- private: no anonymous/public read
  10485760,   -- 10 MB per file (10 × 1024 × 1024) — the BOE product rule
  array[
    'application/pdf',
    'image/jpeg','image/png','image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain','text/csv'
  ]
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── 2. order_requests.finalized_at (upload-stage flag) ────────────────────────
-- Backward-compatible finalization flag, designed so the OLD (attachment-unaware)
-- frontend and the NEW (attachment) frontend can BOTH create requests safely at
-- the same time — no timed activation migration, no stale-tab window, no
-- reconciliation ever required.
--
--   * OLD client → OMITS finalized_at, so the column DEFAULT now() applies and
--     the row is born a normal, operational submission (visible, counted,
--     notified), exactly as before this feature existed. A tab left open for
--     days stays safe: every legacy insert self-finalizes via the default.
--   * NEW client → EXPLICITLY inserts finalized_at = NULL. PostgREST preserves an
--     explicit null (it suppresses the column default), so that row is an
--     upload-stage DRAFT — invisible to reviewers/assignees, uncounted,
--     unnotified — until finalize_order_request() verifies its Main PI.
--
-- There is deliberately NO global force-draft trigger. Forcing every insert to
-- NULL (the earlier design) would turn each OLD-client submission into a
-- permanently hidden draft it can never finalize — the exact incompatibility we
-- are removing. The DEFAULT does the compatibility work; the INSERT policy is
-- left exactly as 20260710 (§2b explains why a finalized_at value guard adds no
-- real protection during the compatibility window).

-- Add the column WITHOUT a default first, backfill existing rows to their own
-- created_at (faithful historical ordering, not the migration instant), THEN
-- attach DEFAULT now() for future omitted inserts. The column stays NULLABLE
-- despite the default, because the NEW client must be able to create explicit
-- NULL drafts.
alter table public.order_requests
  add column if not exists finalized_at timestamptz;

update public.order_requests
   set finalized_at = coalesce(finalized_at, created_at, now())
 where finalized_at is null;

alter table public.order_requests
  alter column finalized_at set default now();

create index if not exists order_requests_finalized_at_idx
  on public.order_requests (finalized_at);

-- ── 2b. INSERT policy: intentionally UNCHANGED from 20260710 (documented) ─────
-- An earlier draft added `finalized_at is null or finalized_at = now()` to the
-- insert policy, to block a client from POSTing an arbitrary finalized_at and
-- minting an operational request with no Main PI. That guard was REMOVED after a
-- linked-DB probe (2026-07-24) proved it protects nothing:
--   * `= now()` DOES work mechanically — a defaulted (omitted) value passes,
--     while every client literal (fixed ISO timestamp, now()±1s,
--     clock_timestamp()) fails, because now() = transaction_timestamp() is fixed
--     per statement and a PostgREST client (which sends literals, not SQL
--     functions) cannot reproduce that microsecond instant.
--   * BUT the outcome it "blocks" — an operational, no-Main-PI request — is
--     trivially reachable by simply OMITTING finalized_at, which is the legacy
--     path and MUST stay open for old-frontend compatibility. The guard closes
--     one door while the identical door beside it is open by design, so it is
--     pure complexity: a non-obvious equality that stops nothing an attacker
--     could not already do by omission.
--
-- The insert policy therefore stays byte-for-byte as 20260710 defines it
-- (created_by = auth.uid(), born 'submitted' and unconverted, non-admin
-- self-assign / admin-any). This migration does NOT drop/recreate it.
--
-- The NEW client still sends explicit finalized_at = NULL to open a draft
-- (omission would default to operational) — a CLIENT contract, not an RLS one,
-- which is acceptable: a real new-frontend user cannot omit it, and the
-- guarantee that actually matters — exactly one Main PI on any request that gets
-- finalized — is enforced by finalize_order_request() + the partial unique index
-- regardless of what finalized_at an insert carries. The compatibility
-- limitation (legacy/crafted inserts may be operational without a Main PI) is
-- retired by the future hardening migration (force-draft + drop default), not
-- here.

-- Activity trigger, finalization-aware. The INSERT branch is guarded by
-- finalized_at so request_submitted fires EXACTLY when a row is born operational:
--   * OLD-client insert → finalized_at defaulted to now() (non-null) →
--     request_submitted recorded once at creation, exactly as before.
--   * NEW-client insert → finalized_at explicitly NULL (a draft) → nothing is
--     recorded here; finalize_order_request() emits request_submitted +
--     attachments_uploaded once the Main PI is verified.
-- The full deployed body (20260689) is reproduced verbatim except the INSERT
-- branch, now guarded by finalized_at. The finalize UPDATE does not change
-- status, so the UPDATE chain below records nothing for it, and finalize is
-- idempotent, so a retry never double-logs.
create or replace function public.log_order_request_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_order_number text;
  v_linked_count integer;
begin
  if (tg_op = 'INSERT') then
    -- request_submitted fires only for a row born operational — finalized_at
    -- non-null, i.e. the defaulted OLD-client insert. A NEW-client draft
    -- (finalized_at NULL) logs nothing here; finalize_order_request() emits its
    -- activity once the Main PI is verified.
    if new.finalized_at is not null then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'request_submitted', v_actor, null, new.status);
    end if;

  elsif (new.status is distinct from old.status) then
    if (new.status = 'converted') then
      select o.display_number into v_order_number
      from public.orders o
      where o.id = new.converted_order_id;

      select count(*) into v_linked_count
      from public.finance_payment_requests f
      where f.order_id = new.converted_order_id;

      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'request_converted', v_actor, old.status, new.status,
              jsonb_build_object(
                'converted_order_id',   new.converted_order_id,
                'order_display_number', v_order_number,
                'linked_payment_count', v_linked_count
              ));

    elsif (old.status = 'submitted' and new.status = 'needs_clarification') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'clarification_requested', v_actor, old.status, new.status,
              jsonb_build_object('clarification_note', new.clarification_note));

    elsif (old.status = 'needs_clarification' and new.status = 'submitted') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'clarification_resubmitted', v_actor, old.status, new.status);

    elsif (old.status = 'submitted' and new.status = 'rejected') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status, details)
      values (new.id, 'request_rejected', v_actor, old.status, new.status,
              jsonb_build_object('rejection_reason', new.rejection_reason));

    elsif (old.status = 'rejected' and new.status = 'submitted') then
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'reapplication_submitted', v_actor, old.status, new.status);

    else
      insert into public.order_request_activity
        (order_request_id, event_type, actor_id, from_status, to_status)
      values (new.id, 'status_changed', v_actor, old.status, new.status);
    end if;

  -- else: a plain field edit / updated_at touch — nothing to record.
  end if;

  return null;  -- AFTER trigger; return value is ignored.
end;
$$;

-- ── 3. Isolate draft rows in RLS ──────────────────────────────────────────────
-- Reviewers (admins) and the person a request is assigned to must not see an
-- upload-stage draft — it is not yet a real submission. The CREATOR keeps
-- visibility (unchanged order_requests_requester_select, created_by/requested_by)
-- so the compensation/cleanup flow can still read and remove its own draft.
-- An admin-created draft is visible to that admin through requester_select
-- (created_by = the admin), so gating admin_select on finalized loses them
-- nothing during the draft window.

drop policy if exists "order_requests_admin_select" on public.order_requests;
create policy "order_requests_admin_select" on public.order_requests
  for select to authenticated
  using (
    finalized_at is not null
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

drop policy if exists "order_requests_assignee_select" on public.order_requests;
create policy "order_requests_assignee_select" on public.order_requests
  for select to authenticated
  using (finalized_at is not null and assigned_to = auth.uid());

-- ── 4. Metadata table ─────────────────────────────────────────────────────────

create table if not exists public.order_request_attachments (
  id                  uuid        primary key default gen_random_uuid(),
  order_request_id    uuid        not null references public.order_requests(id) on delete cascade,
  attachment_type     text        not null check (attachment_type in ('main_pi', 'reference')),
  file_name           text        not null,               -- original name, for display only
  storage_path        text        not null unique,        -- object key within the bucket; never a public URL
  mime_type           text,
  original_size_bytes bigint,                              -- size the user selected (pre-compression)
  uploaded_size_bytes bigint,                              -- size actually stored (post-compression)
  uploaded_by         uuid        not null references public.users(id),
  created_at          timestamptz not null default now()
);

create index if not exists order_request_attachments_request_idx
  on public.order_request_attachments (order_request_id);

-- AT MOST one Main PI per request, enforced by the database. finalize_order_request()
-- additionally enforces that EXACTLY one exists before a request becomes operational,
-- so the two together give "exactly one Main PI on every finalized request".
create unique index if not exists order_request_attachments_one_main_pi
  on public.order_request_attachments (order_request_id)
  where attachment_type = 'main_pi';

alter table public.order_request_attachments enable row level security;

-- Attachments may be written ONLY during the upload stage (finalized_at IS NULL),
-- by an admin or the request's CREATOR/OWNER (created_by / requested_by), and
-- never once converted. A pure assignee (assigned_to but not the creator) is NOT
-- a draft participant: an unfinalized row is the creator's incomplete submission
-- workspace, and assignment access begins only after finalization. After
-- finalization NO ONE may insert (add references later) or, via the absence of a
-- DELETE policy below, remove attachment rows through the API — the first phase
-- has no post-creation attachment editing. Encapsulated so the table and storage
-- policies agree by construction.
create or replace function public.order_request_attachment_writable(p_order_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.order_requests r
    where r.id = p_order_request_id
      and r.finalized_at is null            -- upload stage only
      and r.status = 'submitted'            -- a draft is always 'submitted'
      and r.converted_order_id is null
      and (
        exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
        or r.created_by = auth.uid()
        or r.requested_by = auth.uid()
      )
  );
$$;

revoke execute on function public.order_request_attachment_writable(uuid) from public, anon;
grant execute on function public.order_request_attachment_writable(uuid) to authenticated;

-- SELECT: admin and the request's creator/owner (created_by / requested_by) at
-- ANY status — a Main PI stays viewable as history, including after conversion.
-- The assignee is a participant ONLY once the request is FINALIZED: while it is
-- an upload-stage draft the assignee is not yet involved (the creator owns the
-- workspace), so the assigned_to branch is gated on finalized_at IS NOT NULL.
create policy "order_request_attachments_select"
  on public.order_request_attachments
  for select to authenticated
  using (
    exists (
      select 1 from public.order_requests r
      where r.id = order_request_attachments.order_request_id
        and (
          r.created_by  = auth.uid()
          or r.requested_by = auth.uid()
          or (r.assigned_to = auth.uid() and r.finalized_at is not null)
        )
    )
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

-- INSERT: only during the upload stage (writable()), and only as oneself. Once
-- the request is finalized, writable() is false, so references cannot be added
-- later through a direct API call.
create policy "order_request_attachments_insert"
  on public.order_request_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.order_request_attachment_writable(order_request_id)
  );

-- NO DELETE policy. Attachment metadata is never removed row-by-row through the
-- API — not by a user, not by an admin. It disappears only when the whole
-- request is deleted (FK ON DELETE CASCADE), i.e. through admin_delete_order_request
-- (finalized requests) or cleanup_unfinalized_order_request (drafts). This is
-- what makes it impossible to strip the Main PI off a finalized request, or to
-- delete metadata while leaving the storage object.
-- No UPDATE policy either — attachment rows are immutable once written.

-- ── 5. Storage object policies (bucket: order-request-attachments) ────────────
-- Path convention: {order_request_id}/{main-pi|references}/{uuid}-{safe_name}
-- Ownership is validated from the FIRST path segment via
-- r.id::text = split_part(name,'/',1) (never a uuid cast — a malformed name
-- fails closed instead of raising). Bucket-scoped, so payment-proofs and
-- task-attachments policies are unaffected.

-- INSERT: upload stage only, admin OR the request's CREATOR/OWNER — all gated to
-- a DRAFT request (finalized_at IS NULL ∧ submitted ∧ not converted) whose id is
-- the first path segment. A pure assignee cannot write a draft's objects (draft
-- is the creator's workspace). Once a request is finalized NO ONE, admin
-- included, may add an object to its path: this is what makes finalized
-- attachments immutable at the storage layer (mirrors the metadata insert policy,
-- which is also draft-only via writable()).
create policy "order_request_attachments_storage_insert"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-request-attachments'
    and exists (
      select 1 from public.order_requests r
      where r.id::text = split_part(storage.objects.name, '/', 1)
        and r.finalized_at is null
        and r.status = 'submitted'
        and r.converted_order_id is null
        and (
          r.created_by = auth.uid()
          or r.requested_by = auth.uid()
          or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
        )
    )
  );

-- SELECT: admin and the creator/owner at ANY status — a commercial document must
-- stay readable after conversion. The assignee may read only once the request is
-- FINALIZED (assigned_to branch gated on finalized_at IS NOT NULL); an
-- upload-stage draft's objects are the creator's alone, so a pure assignee gets
-- no signed URL for a draft (createSignedUrl is governed by this same policy).
create policy "order_request_attachments_storage_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-request-attachments'
    and (
      exists (
        select 1 from public.order_requests r
        where r.id::text = split_part(storage.objects.name, '/', 1)
          and (
            r.created_by  = auth.uid()
            or r.requested_by = auth.uid()
            or (r.assigned_to = auth.uid() and r.finalized_at is not null)
          )
      )
      or exists (
        select 1 from public.users u
        where u.id = auth.uid() and u.role = 'admin'
      )
    )
  );

-- DELETE: STRICTLY the upload stage only. A direct client Storage delete is
-- allowed only for a DRAFT request (finalized_at IS NULL ∧ submitted ∧ not
-- converted), by an admin or the request's CREATOR/OWNER — this is the
-- compensation/sweep path for discarding a never-submitted draft. A pure assignee
-- cannot delete another creator's draft objects. Once a request
-- is finalized NO ONE, admin included, can remove its objects through an ordinary
-- client Storage call, and a converted request's objects are likewise untouchable
-- (draft-only excludes both). Combined with the draft-only INSERT and the absent
-- metadata DELETE policy, finalized attachments are immutable via the client API.
--
-- Whole-request deletion of a FINALIZED request (admin delete, test-data cleanup)
-- therefore does NOT rely on this policy: it removes objects through the
-- admin-authenticated, bucket-scoped, service-role cleanup API
-- (src/app/api/orders/requests/attachments/cleanup) AFTER the DB deletion rules
-- (admin_delete_order_request / execute_test_data_cleanup, which refuse converted
-- requests) have run. There is no broad admin object-delete grant here.
create policy "order_request_attachments_storage_delete"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'order-request-attachments'
    and exists (
      select 1 from public.order_requests r
      where r.id::text = split_part(storage.objects.name, '/', 1)
        and r.finalized_at is null
        and r.status = 'submitted'
        and r.converted_order_id is null
        and (
          r.created_by = auth.uid()
          or r.requested_by = auth.uid()
          or exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
        )
    )
  );

-- ── 6. Activity event type ────────────────────────────────────────────────────
-- Add 'attachments_uploaded' to the CHECK. Postgres cannot add a value to a
-- CHECK in place, so the constraint must be dropped and re-created with the FULL
-- list — which makes this the single most dangerous statement in the migration:
-- any value omitted here is silently REVOKED.
--
-- The list below is the LIVE constraint (verified against the linked database on
-- 2026-07-25) PLUS 'attachments_uploaded'. In particular 'request_edited' — added
-- by 20260708 for edit_order_request() — MUST stay. An earlier draft of this
-- migration was written before 20260708 existed and omitted it, which would have
-- made every future "Edit Request" fail with a 23514 CHECK violation. It applied
-- cleanly in testing only because order_request_activity happened to be empty, so
-- the breakage would not have surfaced until the first real edit in production.
--
-- RULE for anyone editing this list: re-read the constraint from the live
-- database first (pg_get_constraintdef) and take the UNION with whatever this
-- migration adds. Never retype it from memory or from an older migration.
alter table public.order_request_activity
  drop constraint order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in (
    'request_submitted',
    'status_changed',
    'request_converted',
    'clarification_requested',
    'clarification_resubmitted',
    'request_rejected',
    'reapplication_submitted',
    'payment_linked',
    'payment_unlinked',
    'request_edited',          -- from 20260708 — do NOT drop (see note above)
    'attachments_uploaded'     -- added by this migration
  ));

-- ── 7. finalize_order_request() ───────────────────────────────────────────────
-- The ONLY path that turns an upload-stage draft into an operational request.
-- It verifies EXACTLY ONE main_pi metadata row exists, stamps finalized_at, and
-- writes request_submitted + a grouped attachments_uploaded event TRANSACTIONALLY
-- (so the guaranteed activity cannot be silently lost). Idempotent: a second
-- call on an already-finalized request is a no-op success, so a client retry
-- never double-submits or double-notifies.
create or replace function public.finalize_order_request(p_order_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_req      public.order_requests%rowtype;
  v_main     integer;
  v_ref      integer;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  -- Lock the row so a concurrent finalize/convert/delete serializes here.
  select * into v_req from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'ORDER_REQUEST_NOT_FOUND: That Order Request no longer exists.'
      using errcode = 'P0002';
  end if;

  -- Only the creator/owner (created_by / requested_by) or an admin may finalize.
  -- A pure assignee is deliberately EXCLUDED: an unfinalized draft is the
  -- creator's workspace, and the assignee gains access only after it becomes
  -- operational (e.g. an admin creates + finalizes a request FOR a salesperson).
  if not (
    v_req.created_by = v_actor
    or v_req.requested_by = v_actor
    or exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin')
  ) then
    raise exception 'You cannot finalize this Order Request.' using errcode = '42501';
  end if;

  -- Idempotent no-op if already finalized (client retry after a flaky network).
  -- finalized_now = false tells the caller NOT to fire the notification or treat
  -- this as a fresh submission; already_finalized = true tells it to still treat
  -- the call as an overall success. No activity row is written on this path.
  if v_req.finalized_at is not null then
    select count(*) into v_ref
    from public.order_request_attachments
    where order_request_id = p_order_request_id and attachment_type = 'reference';
    return jsonb_build_object(
      'order_request_id', v_req.id,
      'request_number',   v_req.request_number,
      'finalized_at',     v_req.finalized_at,
      'reference_count',  v_ref,
      'finalized_now',    false,
      'already_finalized', true
    );
  end if;

  -- A draft is always 'submitted' and unconverted; assert defensively.
  if v_req.status <> 'submitted' or v_req.converted_order_id is not null then
    raise exception 'This Order Request is not in a finalizable state.' using errcode = '42501';
  end if;

  -- The core guarantee: EXACTLY ONE Main PI must exist. The partial unique index
  -- already caps it at one; this rejects zero.
  select count(*) into v_main
  from public.order_request_attachments
  where order_request_id = p_order_request_id and attachment_type = 'main_pi';

  if v_main <> 1 then
    raise exception 'MAIN_PI_REQUIRED: exactly one Main PI must be attached before the request can be submitted.'
      using errcode = 'P0001';
  end if;

  -- The Main PI must be an Excel workbook (.xlsx or .xls) — enforced server-side
  -- so a crafted request can never finalize a PDF/image/other file as the Main PI
  -- (the client also validates this; this is the authoritative gate). Validated on
  -- BOTH signals that the table stores:
  --   * file_name extension MUST be .xlsx or .xls; AND
  --   * mime_type MUST be an Excel mime, OR NULL/empty. NULL/empty is allowed
  --     because a genuine workbook can arrive with a missing/quirky browser mime
  --     (and a direct/service insert may omit it); the client uploads a canonical
  --     Excel mime, so a real upload always carries one. A NON-empty, non-Excel
  --     stored mime (e.g. application/pdf on a .xlsx name) is a clear conflict and
  --     is rejected rather than trusting the filename alone.
  -- Existing/legacy attachment rows are never re-validated — only this finalize
  -- path is gated, so viewing and deletion of any older non-Excel Main PI stay
  -- format-agnostic.
  if not exists (
    select 1 from public.order_request_attachments
    where order_request_id = p_order_request_id
      and attachment_type = 'main_pi'
      and (lower(file_name) like '%.xlsx' or lower(file_name) like '%.xls')
      and (
        mime_type is null
        or mime_type = ''
        or mime_type in (
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel'
        )
      )
  ) then
    raise exception 'MAIN_PI_NOT_EXCEL: the Main PI must be an Excel file (.xlsx or .xls).'
      using errcode = 'P0001';
  end if;

  select count(*) into v_ref
  from public.order_request_attachments
  where order_request_id = p_order_request_id and attachment_type = 'reference';

  update public.order_requests
     set finalized_at = now()
   where id = p_order_request_id;

  -- Transactional activity: the request enters its normal workflow, and the
  -- grouped attachment event is recorded in the same statement set.
  insert into public.order_request_activity
    (order_request_id, event_type, actor_id, from_status, to_status)
  values (p_order_request_id, 'request_submitted', v_actor, null, v_req.status);

  insert into public.order_request_activity
    (order_request_id, event_type, actor_id, details)
  values (
    p_order_request_id, 'attachments_uploaded', v_actor,
    jsonb_build_object('main_pi', true, 'reference_count', v_ref)
  );

  -- finalized_now = true: THIS call performed the first unfinalized→finalized
  -- transition, so the caller should fire the notification exactly once here.
  return jsonb_build_object(
    'order_request_id', p_order_request_id,
    'request_number',   v_req.request_number,
    'finalized_at',     now(),
    'reference_count',  v_ref,
    'finalized_now',    true,
    'already_finalized', false
  );
end;
$$;

revoke execute on function public.finalize_order_request(uuid) from public, anon;
grant execute on function public.finalize_order_request(uuid) to authenticated;

-- ── 8. cleanup_unfinalized_order_request() ────────────────────────────────────
-- The ONLY user-reachable way to delete an Order Request row that is not an
-- admin action. Narrowly scoped: the caller must be the CREATOR, the request
-- must be UNFINALIZED (upload-stage), NOT converted, and RECENT. This replaces
-- the broad 15-minute creator DELETE policy — a salesperson gets no general
-- delete over submitted requests, only the ability to discard their own failed
-- or abandoned upload-stage draft. Finalized requests remain deletable only
-- through admin_delete_order_request.
--
-- It returns the storage paths (collected before the cascade) for the caller's
-- reference, but the caller removes the objects BEFORE calling this, while the
-- draft row still authorises the storage delete.
create or replace function public.cleanup_unfinalized_order_request(p_order_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_req   public.order_requests%rowtype;
  v_paths text[];
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_req from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    -- Already gone (a prior cleanup / retry). Idempotent success.
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;

  -- Only DRAFTS are ever discardable this way; a finalized/converted request is
  -- deleted only through admin_delete_order_request.
  if v_req.finalized_at is not null then
    raise exception 'This Order Request is already submitted and cannot be discarded this way.'
      using errcode = '42501';
  end if;

  if v_req.status <> 'submitted' or v_req.converted_order_id is not null then
    raise exception 'This Order Request cannot be discarded.' using errcode = '42501';
  end if;

  -- Authorised callers, checked CREATOR-FIRST so an admin discarding THEIR OWN
  -- just-created draft (the immediate rollback path) is treated as a creator, not
  -- blocked by the admin age floor:
  --   * the CREATOR (admin or not): their own draft, within 24h — the
  --     compensation / next-visit sweep window. Keeps it from being a general
  --     delete of one's own submitted requests.
  --   * a non-creator ADMIN: any user's draft, but only once it is > 1 hour old,
  --     so the admin cleanup route (admin_list_stale_order_request_drafts) can
  --     never race a live upload in someone else's session. No upper age bound,
  --     so a draft abandoned for days is still reclaimable.
  if v_req.created_by = v_actor then
    if v_req.created_at <= now() - interval '24 hours' then
      raise exception 'This upload-stage request is too old to discard automatically.'
        using errcode = '42501';
    end if;
  elsif exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    if v_req.created_at > now() - interval '1 hour' then
      raise exception 'This upload-stage request is too new to discard as an admin.'
        using errcode = '42501';
    end if;
  else
    raise exception 'You can only discard an Order Request you created.' using errcode = '42501';
  end if;

  select coalesce(array_agg(storage_path), '{}'::text[]) into v_paths
  from public.order_request_attachments
  where order_request_id = p_order_request_id;

  -- Cascade removes the attachment metadata rows.
  delete from public.order_requests where id = p_order_request_id;

  return jsonb_build_object(
    'deleted', true,
    'request_number', v_req.request_number,
    'storage_paths', to_jsonb(v_paths)
  );
end;
$$;

revoke execute on function public.cleanup_unfinalized_order_request(uuid) from public, anon;
grant execute on function public.cleanup_unfinalized_order_request(uuid) to authenticated;

-- ── 9. admin_list_stale_order_request_drafts() ────────────────────────────────
-- Upload-stage drafts are invisible to reviewers by design, so an abandoned
-- draft older than the creator's 24h auto-sweep window would otherwise be
-- silently stranded. This is the DEFINED admin cleanup route: an admin lists the
-- stale drafts (default: older than 24h) with their storage paths, then discards
-- each via cleanup_unfinalized_order_request() (admin branch) and removes its
-- objects through the service-role cleanup API. SECURITY DEFINER + admin-gated so
-- it can see rows RLS hides; it only ever exposes DRAFTS (never a real request).
create or replace function public.admin_list_stale_order_request_drafts(p_min_age_hours integer default 24)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'Only an admin may list stale Order Request drafts.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',             r.id,
      'request_number', r.request_number,
      'created_by',     r.created_by,
      'created_at',     r.created_at,
      'storage_paths',  coalesce((
        select jsonb_agg(a.storage_path order by a.storage_path)
        from public.order_request_attachments a
        where a.order_request_id = r.id
      ), '[]'::jsonb)
    ) order by r.created_at)
    from public.order_requests r
    where r.finalized_at is null
      and r.status = 'submitted'
      and r.converted_order_id is null
      and r.created_at <= now() - make_interval(hours => greatest(coalesce(p_min_age_hours, 24), 1))
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.admin_list_stale_order_request_drafts(integer) from public, anon;
grant execute on function public.admin_list_stale_order_request_drafts(integer) to authenticated;

-- ── 10. remove_unfinalized_order_request_attachment() ─────────────────────────
-- Remove ONE optional reference attachment from a draft, without discarding the
-- whole draft.
--
-- Why an RPC and not a DELETE policy: §4 deliberately gives
-- order_request_attachments NO delete policy, which is what makes it impossible
-- to strip the Main PI off a finalized request. A client CAN already delete the
-- storage OBJECT of a draft (§5 delete policy is draft-only), but it can never
-- delete the metadata ROW — so a client-side removal would leave a row pointing
-- at a file that no longer exists. This function closes exactly that gap, and
-- nothing wider: it is the only way a single metadata row is ever removed, and it
-- refuses everything except an optional reference on a live draft.
--
-- Check ORDER is deliberate: the caller is AUTHORISED BEFORE any property of the
-- attachment is revealed, so an unauthorised user gets an identical 42501 whether
-- the row is a Main PI, already finalized, or converted — the function never
-- becomes an oracle for another user's draft contents.
--
-- The parent request is locked FOR UPDATE so a removal cannot interleave with a
-- concurrent finalize_order_request(): whichever runs second sees the other's
-- committed state, and a request can never finalize while one of its files is
-- half-removed.
--
-- Not-found is an idempotent SUCCESS (removed=false, reason=not_found), matching
-- cleanup_unfinalized_order_request(). A client retrying after a dropped response
-- must converge rather than error.
create or replace function public.remove_unfinalized_order_request_attachment(p_attachment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_att   public.order_request_attachments%rowtype;
  v_req   public.order_requests%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select * into v_att
  from public.order_request_attachments
  where id = p_attachment_id;

  if not found then
    -- Already gone (a retry, or a prior removal). Idempotent success.
    return jsonb_build_object('removed', false, 'reason', 'not_found');
  end if;

  select * into v_req
  from public.order_requests
  where id = v_att.order_request_id
  for update;

  if not found then
    raise exception 'ORDER_REQUEST_NOT_FOUND: That Order Request no longer exists.'
      using errcode = 'P0002';
  end if;

  -- AUTHORISE FIRST (see note above). Same participant set as
  -- order_request_attachment_writable(): the creator/owner, or an admin. A pure
  -- assignee is excluded — an unfinalized draft is the creator's workspace.
  if not (
    v_req.created_by = v_actor
    or v_req.requested_by = v_actor
    or exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin')
  ) then
    raise exception 'You cannot modify this Order Request.' using errcode = '42501';
  end if;

  -- Upload stage only. A finalized or converted request's attachments are
  -- immutable for everyone, admin included — unchanged by this function.
  if v_req.finalized_at is not null then
    raise exception 'ATTACHMENT_NOT_REMOVABLE: this Order Request is already submitted.'
      using errcode = '42501';
  end if;

  if v_req.status <> 'submitted' or v_req.converted_order_id is not null then
    raise exception 'ATTACHMENT_NOT_REMOVABLE: this Order Request is not in an editable state.'
      using errcode = '42501';
  end if;

  -- The Main PI is mandatory and is NEVER removable through this path. Replacing
  -- it means discarding the draft; that keeps "exactly one Main PI on every
  -- finalized request" true by construction rather than by client discipline.
  if v_att.attachment_type <> 'reference' then
    raise exception 'MAIN_PI_NOT_REMOVABLE: the Main PI cannot be removed individually.'
      using errcode = '42501';
  end if;

  -- Exactly one row, addressed by primary key.
  delete from public.order_request_attachments where id = p_attachment_id;

  -- storage_path is returned so the caller can reconcile/confirm which object the
  -- row referred to; the caller removes the object BEFORE calling this.
  return jsonb_build_object(
    'removed',          true,
    'attachment_id',    v_att.id,
    'order_request_id', v_att.order_request_id,
    'storage_path',     v_att.storage_path,
    'file_name',        v_att.file_name
  );
end;
$$;

revoke execute on function public.remove_unfinalized_order_request_attachment(uuid) from public, anon;
grant execute on function public.remove_unfinalized_order_request_attachment(uuid) to authenticated;

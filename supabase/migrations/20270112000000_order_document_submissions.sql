-- ═══════════════════════════════════════════════════════════════════════════
-- Order document submissions: Design Files and Client PO, reviewed twice
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
--
-- A Confirmed Order had nowhere to keep the client's purchase order or its own
-- design files (orderDocumentsPanel.ts records that audit). This file gives both
-- a home, and the home is a REVIEW QUEUE, not a shelf:
--
--   Sales submits      create_order_document_submission()          pending_admin
--   Admin decides      decide_order_document_submission_admin()    awaiting_operations | rejected_admin
--   Operations decides decide_order_document_submission_operations() accepted | rejected_operations
--
-- ONLY OPERATIONS ACCEPTANCE MAKES A FILE CURRENT. There is no "current" column
-- to keep in step: the accepted document set of an Order is DERIVED from its
-- accepted submissions (Client PO: the latest accepted one; Design Files: every
-- accepted one from the latest accepted "replace" onwards). Promotion is
-- therefore the single row update that moves a submission to `accepted`, and it
-- cannot split from its own state transition. Replacing never deletes: the
-- earlier files stay on their own (accepted) submission, in history.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- * The Main PI is NOT a category here. A new PI goes through the existing
--   propose_order_pi_revision / approve_order_pi_revision door and the
--   20261229000000 operations handoff; building a second PI approval beside it
--   would give one Order two answers to "which PI is in force".
-- * No existing function, table, policy or row is changed. Order 0524 and every
--   PI version and handoff are untouched.
-- * The initial PI submission is not wired here (Phase 2).
--
-- REVIEWERS
--
-- Admin stage: an active admin — the same authority that decides a revised PI
-- (canDecidePiRevision / approve_order_pi_revision). Operations stage: the ONE
-- operations reviewer assigned in Control Center (order_operations_reviewers,
-- duty 'pi_handoff'), read at DECISION time so a reassignment takes effect at
-- once, and only if they can open the Order. Nobody is substituted: an admin is
-- not the operations reviewer unless an admin assigned themself.
--
-- SNAPSHOT INTEGRITY
--
-- Files are uploaded before the submission row exists, under a key that names
-- the submission's id. The storage INSERT policy admits a key only while no row
-- with that id exists, so the moment the submission is created its file set is
-- sealed; there is no UPDATE or DELETE policy, so no file can be swapped or
-- removed afterwards. Each decision must quote the snapshot hash the reviewer
-- was shown; a mismatch or a decision on a submission that has already moved is
-- refused, which makes repeated clicks and stale tabs harmless.
--
-- LOCK ORDER (matches 20261229000000): order_operations_reviewers (SHARE, only
-- where the reviewer is read) → orders (FOR UPDATE) → the submission.

-- ═══ 1. Notification types ═════════════════════════════════════════════════
alter type notification_type add value if not exists 'order_document_review_requested';
alter type notification_type add value if not exists 'order_document_review_decided';


-- ═══ 2. Tables ═════════════════════════════════════════════════════════════

create table if not exists public.order_document_submissions (
  id                     uuid primary key,
  -- 'amendment': a change on a Confirmed Order. 'initial': sent with the PI
  -- for approval; it has no Order until approve_order_submission() creates one,
  -- and it is decided by the PI's own doors (see §11).
  stage                  text not null default 'amendment' check (stage in ('initial', 'amendment')),
  order_id               uuid references public.orders(id) on delete cascade,
  pi_submission_id       uuid references public.order_submissions(id) on delete cascade,
  includes_design_files  boolean not null default false,
  includes_client_po     boolean not null default false,
  design_mode            text check (design_mode in ('add', 'replace')),
  note                   text check (note is null or char_length(note) <= 1000),
  status                 text not null default 'pending_admin'
                         check (status in ('pending_admin', 'awaiting_operations', 'accepted',
                                           'rejected_admin', 'rejected_operations')),
  snapshot_sha256        text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  file_count             integer not null check (file_count between 1 and 25),
  resubmission_of        uuid references public.order_document_submissions(id) on delete set null,
  submitted_by           uuid not null references public.users(id),
  submitted_at           timestamptz not null default now(),
  admin_decided_by       uuid references public.users(id),
  admin_decided_at       timestamptz,
  admin_reason           text check (admin_reason is null or char_length(admin_reason) <= 1000),
  operations_reviewer    uuid references public.users(id),
  operations_decided_by  uuid references public.users(id),
  operations_decided_at  timestamptz,
  operations_reason      text check (operations_reason is null or char_length(operations_reason) <= 1000),
  check (includes_design_files or includes_client_po),
  check (stage <> 'amendment' or order_id is not null),
  check (stage <> 'initial' or pi_submission_id is not null),
  check (order_id is not null or status in ('pending_admin', 'rejected_admin')),
  check (includes_design_files = (design_mode is not null)),
  check (status <> 'rejected_admin' or (admin_reason is not null and admin_decided_at is not null)),
  check (status <> 'rejected_operations' or (operations_reason is not null and operations_decided_at is not null)),
  check (status not in ('awaiting_operations', 'accepted', 'rejected_operations') or admin_decided_at is not null),
  check (status <> 'accepted' or operations_decided_at is not null)
);

comment on table public.order_document_submissions is
  'A proposed change to a Confirmed Order''s Design Files and/or Client PO. Pending until an admin approves it and the assigned operations reviewer accepts it; only accepted submissions form the Order''s current document set. Written only by the three order_document_submission RPCs.';

-- ONE UNRESOLVED SUBMISSION PER CATEGORY PER ORDER. The RPC checks first and
-- says so in words; these indexes are what make two racing submits impossible.
create unique index if not exists order_document_submissions_one_open_design
  on public.order_document_submissions (order_id)
  where includes_design_files and status in ('pending_admin', 'awaiting_operations');
create unique index if not exists order_document_submissions_one_open_po
  on public.order_document_submissions (order_id)
  where includes_client_po and status in ('pending_admin', 'awaiting_operations');
-- ONE OPEN INITIAL SUBMISSION PER PI.
create unique index if not exists order_document_submissions_one_open_initial
  on public.order_document_submissions (pi_submission_id)
  where stage = 'initial' and status = 'pending_admin';
create index if not exists order_document_submissions_pi_idx
  on public.order_document_submissions (pi_submission_id, submitted_at desc)
  where pi_submission_id is not null;
create index if not exists order_document_submissions_order_idx
  on public.order_document_submissions (order_id, submitted_at desc);
create index if not exists order_document_submissions_status_idx
  on public.order_document_submissions (status)
  where status in ('pending_admin', 'awaiting_operations', 'rejected_admin', 'rejected_operations');

create table if not exists public.order_document_submission_files (
  id                 uuid primary key default gen_random_uuid(),
  submission_id      uuid not null references public.order_document_submissions(id) on delete cascade,
  category           text not null check (category in ('design_files', 'client_po')),
  storage_path       text not null,
  storage_object_id  uuid not null,
  file_name          text not null check (char_length(file_name) between 1 and 200),
  mime_type          text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes         bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  created_at         timestamptz not null default now()
);
create index if not exists order_document_submission_files_sub_idx
  on public.order_document_submission_files (submission_id);
-- A file may be carried forward from an earlier initial submission of the same
-- PI (a returned PI resubmitted with the files it already had), so a stored key
-- can appear on more than one submission — but only once on each.
create unique index if not exists order_document_submission_files_one_per_sub
  on public.order_document_submission_files (submission_id, storage_path);

create table if not exists public.order_document_submission_events (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references public.order_document_submissions(id) on delete cascade,
  order_id       uuid references public.orders(id) on delete cascade,
  pi_submission_id uuid references public.order_submissions(id) on delete cascade,
  actor_id       uuid references public.users(id),
  event          text not null check (event in ('submitted', 'admin_approved', 'admin_rejected',
                                                'operations_accepted', 'operations_rejected',
                                                'operations_reassigned')),
  from_status    text,
  to_status      text not null,
  reason         text,
  created_at     timestamptz not null default now()
);
create index if not exists order_document_submission_events_sub_idx
  on public.order_document_submission_events (submission_id, created_at);

comment on table public.order_document_submission_events is
  'Append-only decision trail of order_document_submissions: who submitted, approved, rejected or accepted, when, and why.';


-- ═══ 3. Guards: frozen identity, forward-only status, append-only trail ════

create or replace function public.order_document_submissions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then return old; end if;
    raise exception 'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE: document submissions cannot be deleted'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending_admin' then
      raise exception 'ORDER_DOCUMENT_SUBMISSION_INVALID: a submission is created pending admin review'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.stage is distinct from old.stage
     or new.pi_submission_id is distinct from old.pi_submission_id
     or (old.order_id is not null and new.order_id is distinct from old.order_id)
     or new.includes_design_files is distinct from old.includes_design_files
     or new.includes_client_po is distinct from old.includes_client_po
     or new.design_mode is distinct from old.design_mode
     or new.note is distinct from old.note
     or new.snapshot_sha256 is distinct from old.snapshot_sha256
     or new.file_count is distinct from old.file_count
     or new.resubmission_of is distinct from old.resubmission_of
     or new.submitted_by is distinct from old.submitted_by
     or new.submitted_at is distinct from old.submitted_at then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE: the snapshot of submission % cannot be changed', old.id
      using errcode = '42501';
  end if;
  -- The Order link is written once: when the approved PI creates the Order.
  if old.order_id is null and new.order_id is not null
     and not (old.stage = 'initial' and old.status = 'pending_admin' and new.status = 'awaiting_operations'
              and current_setting('boe.order_document_pi_link', true) = 'on') then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE: submission % is linked to an Order only by approving its PI', old.id
      using errcode = '42501';
  end if;
  -- An INITIAL submission moves only with its PI (§11), never by a direct call.
  if old.stage = 'initial' and new.status is distinct from old.status
     and current_setting('boe.order_document_pi_link', true) is distinct from 'on' then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID: documents sent with a PI are decided with that PI'
      using errcode = '42501';
  end if;

  -- REASSIGNMENT (§12): only the operations reviewer of a submission awaiting
  -- operations moves, and nothing else about it.
  if new.status = old.status then
    if old.status = 'awaiting_operations'
       and (to_jsonb(new) - 'operations_reviewer') = (to_jsonb(old) - 'operations_reviewer') then
      return new;
    end if;
    raise exception 'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID: submission % cannot be rewritten in place', old.id
      using errcode = '42501';
  end if;

  if old.status = 'pending_admin' and new.status in ('awaiting_operations', 'rejected_admin') then
    return new;
  end if;
  if old.status = 'awaiting_operations' and new.status in ('accepted', 'rejected_operations')
     and new.admin_decided_by is not distinct from old.admin_decided_by
     and new.admin_decided_at is not distinct from old.admin_decided_at then
    return new;
  end if;
  raise exception 'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID: submission % cannot move from % to %',
    old.id, old.status, new.status using errcode = '42501';
end;
$$;
revoke execute on function public.order_document_submissions_guard() from public, anon, authenticated, service_role;
drop trigger if exists order_document_submissions_guard on public.order_document_submissions;
create trigger order_document_submissions_guard
  before insert or update or delete on public.order_document_submissions
  for each row execute function public.order_document_submissions_guard();

create or replace function public.order_document_append_only_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.in_test_data_cleanup() then return old; end if;
  raise exception 'ORDER_DOCUMENT_HISTORY_IMMUTABLE: % rows cannot be changed or deleted', tg_table_name
    using errcode = '42501';
end;
$$;
revoke execute on function public.order_document_append_only_guard() from public, anon, authenticated, service_role;
drop trigger if exists order_document_submission_files_guard on public.order_document_submission_files;
create trigger order_document_submission_files_guard
  before update or delete on public.order_document_submission_files
  for each row execute function public.order_document_append_only_guard();
drop trigger if exists order_document_submission_events_guard on public.order_document_submission_events;
create trigger order_document_submission_events_guard
  before update or delete on public.order_document_submission_events
  for each row execute function public.order_document_append_only_guard();


-- ═══ 4. Privileges and RLS: read by whoever can open the Order ═════════════

-- WHO MAY READ A SUBMISSION: whoever can open its Order; before the Order
-- exists, whoever can open its PI for review (the owner and the approvers).
-- SECURITY INVOKER, so both answers are the caller's own RLS.
create or replace function public.can_view_order_document_submission(p_order_id uuid, p_pi_submission_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case when p_order_id is not null then public.can_view_order(p_order_id)
              else coalesce(public.can_view_order_submission(p_pi_submission_id), false) end;
$$;
revoke execute on function public.can_view_order_document_submission(uuid, uuid) from public, anon;
grant  execute on function public.can_view_order_document_submission(uuid, uuid) to authenticated;

alter table public.order_document_submissions enable row level security;
alter table public.order_document_submission_files enable row level security;
alter table public.order_document_submission_events enable row level security;
revoke all on table public.order_document_submissions from public, anon, authenticated;
revoke all on table public.order_document_submission_files from public, anon, authenticated;
revoke all on table public.order_document_submission_events from public, anon, authenticated;
grant select on table public.order_document_submissions to authenticated;
grant select on table public.order_document_submission_files to authenticated;
grant select on table public.order_document_submission_events to authenticated;

drop policy if exists "order_document_submissions_select" on public.order_document_submissions;
create policy "order_document_submissions_select" on public.order_document_submissions
  for select to authenticated using (public.can_view_order_document_submission(order_id, pi_submission_id));
drop policy if exists "order_document_submissions_module_gate" on public.order_document_submissions;
create policy "order_document_submissions_module_gate" on public.order_document_submissions
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));

drop policy if exists "order_document_submission_files_select" on public.order_document_submission_files;
create policy "order_document_submission_files_select" on public.order_document_submission_files
  for select to authenticated using (exists (
    select 1 from public.order_document_submissions s
    where s.id = submission_id and public.can_view_order_document_submission(s.order_id, s.pi_submission_id)));
drop policy if exists "order_document_submission_files_module_gate" on public.order_document_submission_files;
create policy "order_document_submission_files_module_gate" on public.order_document_submission_files
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));

drop policy if exists "order_document_submission_events_select" on public.order_document_submission_events;
create policy "order_document_submission_events_select" on public.order_document_submission_events
  for select to authenticated using (public.can_view_order_document_submission(order_id, pi_submission_id));
drop policy if exists "order_document_submission_events_module_gate" on public.order_document_submission_events;
create policy "order_document_submission_events_module_gate" on public.order_document_submission_events
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));


-- ═══ 5. Who may submit ════════════════════════════════════════════════════
--
-- The Order's own people — the requester, the assigned salesperson, or the
-- source PI's creator / submitter — holding orders.create; or an active admin.
-- The same shape as canProposePiRevision.

create or replace function public.can_submit_order_document(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.orders o
    join public.users u on u.id = auth.uid()
    left join public.order_submissions s on s.id = o.source_order_submission_id
    where o.id = p_order_id
      and o.status <> 'cancelled'
      and u.is_active and coalesce(u.is_deleted, false) = false
      and (
        u.role = 'admin'
        or (
          coalesce(public.resolve_permission(u.id, 'orders', 'create'), false)
          and (o.requested_by = u.id or o.assigned_to = u.id
               or s.created_by = u.id or s.submitted_by = u.id)
        )
      )
  );
$$;
comment on function public.can_submit_order_document(uuid) is
  'Whether the caller may submit Design Files / Client PO changes on this Order: an active admin, or the Order''s requester, salesperson or source-PI owner holding orders.create. The Order must not be cancelled.';
revoke execute on function public.can_submit_order_document(uuid) from public, anon;
grant  execute on function public.can_submit_order_document(uuid) to authenticated;


-- ═══ 6. Storage: order-files/order-documents/{order}/{submission}/{category}/{uuid}.{ext}

create or replace function public.order_document_file_key_parts(p_name text)
returns table (order_id uuid, submission_id uuid, category text)
language sql
immutable
as $$
  select split_part(p_name, '/', 2)::uuid, split_part(p_name, '/', 3)::uuid, split_part(p_name, '/', 4)
  where p_name ~ '^order-documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(design_files|client_po)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|jpeg|webp)$';
$$;
revoke execute on function public.order_document_file_key_parts(text) from public, anon;
grant  execute on function public.order_document_file_key_parts(text) to authenticated;

-- SEALED ON SUBMIT: a key is writable only while its submission does not exist.
create or replace function public.can_upload_order_document_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_document_file_key_parts(p_name) k
    where public.can_submit_order_document(k.order_id)
      and not exists (select 1 from public.order_document_submissions s where s.id = k.submission_id)
  );
$$;
revoke execute on function public.can_upload_order_document_file(text) from public, anon;
grant  execute on function public.can_upload_order_document_file(text) to authenticated;

create or replace function public.can_read_order_document_file(p_name text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  -- SECURITY INVOKER: can_view_order must see the caller's own Order visibility.
  select exists (
    select 1 from public.order_document_file_key_parts(p_name) k
    where public.can_view_order(k.order_id)
  );
$$;
revoke execute on function public.can_read_order_document_file(text) from public, anon;
grant  execute on function public.can_read_order_document_file(text) to authenticated;

drop policy if exists "order_files_document_submission_insert" on storage.objects;
create policy "order_files_document_submission_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and public.can_upload_order_document_file(name)
  );

drop policy if exists "order_files_document_submission_select" on storage.objects;
create policy "order_files_document_submission_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and public.can_read_order_document_file(name)
  );
-- NO UPDATE AND NO DELETE POLICY: a submitted file can never be swapped or removed.


-- ═══ 7. Helpers ════════════════════════════════════════════════════════════

create or replace function public.order_document_log_event(
  p_submission_id uuid, p_order_id uuid, p_actor uuid, p_event text,
  p_from text, p_to text, p_reason text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.order_document_submission_events
    (submission_id, order_id, pi_submission_id, actor_id, event, from_status, to_status, reason)
  select p_submission_id, p_order_id, s.pi_submission_id, p_actor, p_event, p_from, p_to, p_reason
    from public.order_document_submissions s where s.id = p_submission_id;
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  select p_order_id, p_actor, 'document_submission_' || p_event,
         jsonb_build_object('submission_id', p_submission_id, 'from', p_from, 'to', p_to, 'reason', p_reason)
   where p_order_id is not null;
$$;
revoke execute on function public.order_document_log_event(uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.order_document_categories_label(p_design boolean, p_po boolean)
returns text
language sql
immutable
as $$
  select case when p_design and p_po then 'Design Files and Client PO'
              when p_design then 'Design Files' else 'Client PO' end;
$$;

create or replace function public.order_document_reason(p_reason text, p_required boolean)
returns text
language plpgsql
immutable
as $$
declare v text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_required and v is null then
    raise exception 'ORDER_DOCUMENT_REASON_REQUIRED: a reason is required to reject a submission' using errcode = 'P0001';
  end if;
  if v is not null and char_length(v) > 1000 then
    raise exception 'ORDER_DOCUMENT_REASON_TOO_LONG: the reason may be at most 1000 characters' using errcode = 'P0001';
  end if;
  return v;
end;
$$;


-- ═══ 8. Submit ═════════════════════════════════════════════════════════════
--
-- p_files: [{"path": "...", "file_name": "..."}]. The category is read from the
-- key. Size and type are read from the stored object, never from the caller.

create or replace function public.create_order_document_submission(
  p_submission_id    uuid,
  p_order_id         uuid,
  p_design_mode      text,
  p_note             text,
  p_files            jsonb,
  p_resubmission_of  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := public.assert_order_submission_actor();
  v_order   public.orders%rowtype;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_file    jsonb;
  v_path    text;
  v_name    text;
  v_parts   record;
  v_obj     record;
  v_design  boolean := false;
  v_po      boolean := false;
  v_n_design integer := 0;
  v_n_po    integer := 0;
  v_sha     text;
  v_prior   public.order_document_submissions%rowtype;
begin
  if p_submission_id is null or p_order_id is null then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_INVALID: submission and Order are required' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'ORDER_DOCUMENT_NOTE_TOO_LONG: the note may be at most 1000 characters' using errcode = 'P0001';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'ORDER_DOCUMENT_FILES_REQUIRED: attach at least one file' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_files) > 25 then
    raise exception 'ORDER_DOCUMENT_TOO_MANY_FILES: at most 25 files per submission' using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_DOCUMENT_ORDER_NOT_FOUND: that Order does not exist' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_DOCUMENT_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;
  if not public.can_submit_order_document(p_order_id) then
    raise exception 'Only the Order''s salesperson, requester or PI owner (with Orders create access), or an admin, can submit documents'
      using errcode = '42501';
  end if;
  -- A retried submit with the same id answers rather than double-inserting.
  if exists (select 1 from public.order_document_submissions where id = p_submission_id) then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_EXISTS: this submission was already sent' using errcode = 'P0001';
  end if;

  -- First pass: categories, from the keys.
  for v_file in select * from jsonb_array_elements(p_files) loop
    v_path := v_file->>'path';
    select * into v_parts from public.order_document_file_key_parts(v_path);
    if v_parts.order_id is null or v_parts.order_id <> p_order_id or v_parts.submission_id <> p_submission_id then
      raise exception 'ORDER_DOCUMENT_FILE_PATH_INVALID: % is not a file of this submission', coalesce(v_path, '(none)')
        using errcode = 'P0001';
    end if;
    if v_parts.category = 'design_files' then v_design := true; v_n_design := v_n_design + 1;
    else v_po := true; v_n_po := v_n_po + 1; end if;
  end loop;
  if v_n_po > 5 then
    raise exception 'ORDER_DOCUMENT_TOO_MANY_FILES: at most 5 Client PO files per submission' using errcode = 'P0001';
  end if;
  if v_design and coalesce(p_design_mode, '') not in ('add', 'replace') then
    raise exception 'ORDER_DOCUMENT_DESIGN_MODE_REQUIRED: say whether the design files are added to or replace the current ones'
      using errcode = 'P0001';
  end if;

  -- One unresolved submission per category, said in words.
  if v_design and exists (select 1 from public.order_document_submissions
                           where order_id = p_order_id and includes_design_files
                             and status in ('pending_admin', 'awaiting_operations')) then
    raise exception 'ORDER_DOCUMENT_CATEGORY_PENDING: Design Files on Order % already have a submission under review. Wait for its decision before submitting another.',
      v_order.display_number using errcode = 'P0001';
  end if;
  if v_po and exists (select 1 from public.order_document_submissions
                       where order_id = p_order_id and includes_client_po
                         and status in ('pending_admin', 'awaiting_operations')) then
    raise exception 'ORDER_DOCUMENT_CATEGORY_PENDING: The Client PO on Order % already has a submission under review. Wait for its decision before submitting another.',
      v_order.display_number using errcode = 'P0001';
  end if;

  if p_resubmission_of is not null then
    select * into v_prior from public.order_document_submissions where id = p_resubmission_of;
    if not found or v_prior.order_id <> p_order_id
       or v_prior.status not in ('rejected_admin', 'rejected_operations') then
      raise exception 'ORDER_DOCUMENT_RESUBMISSION_INVALID: only a rejected submission of this Order can be corrected'
        using errcode = 'P0001';
    end if;
  end if;

  -- Second pass: every file must be a stored object this caller uploaded, of
  -- an allowed type and size — read from storage, never from the caller.
  for v_file in select * from jsonb_array_elements(p_files) loop
    v_path := v_file->>'path';
    v_name := nullif(btrim(coalesce(v_file->>'file_name', '')), '');
    if v_name is null or char_length(v_name) > 200 then
      raise exception 'ORDER_DOCUMENT_FILE_NAME_INVALID: every file needs a name of at most 200 characters' using errcode = 'P0001';
    end if;
    select o.id, o.owner_id, (o.metadata->>'mimetype') as mime, (o.metadata->>'size')::bigint as size
      into v_obj
      from storage.objects o where o.bucket_id = 'order-files' and o.name = v_path;
    if not found then
      raise exception 'ORDER_DOCUMENT_FILE_MISSING: % was not uploaded', v_name using errcode = 'P0001';
    end if;
    if v_obj.owner_id is distinct from v_actor::text then
      raise exception 'ORDER_DOCUMENT_FILE_NOT_YOURS: % was uploaded by somebody else', v_name using errcode = '42501';
    end if;
    if v_obj.mime is null or v_obj.mime not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
      raise exception 'ORDER_DOCUMENT_FILE_TYPE: % must be a PDF, PNG, JPEG or WebP file', v_name using errcode = 'P0001';
    end if;
    if v_obj.size is null or v_obj.size <= 0 or v_obj.size > 10485760 then
      raise exception 'ORDER_DOCUMENT_FILE_SIZE: % must be between 1 byte and 10 MB', v_name using errcode = 'P0001';
    end if;
  end loop;
  if (select count(distinct e->>'path') from jsonb_array_elements(p_files) e) <> jsonb_array_length(p_files) then
    raise exception 'ORDER_DOCUMENT_FILE_DUPLICATE: a file is listed twice' using errcode = 'P0001';
  end if;

  -- THE SNAPSHOT HASH, computed from the stored objects BEFORE the row exists,
  -- so it is written once and never rewritten.
  select encode(sha256(convert_to(string_agg(
           split_part(o.name, '/', 4) || '|' || o.name || '|' || o.id::text || '|'
             || (o.metadata->>'size') || '|' || (o.metadata->>'mimetype'),
           E'\n' order by o.name), 'UTF8')), 'hex')
    into v_sha
    from jsonb_array_elements(p_files) e
    join storage.objects o on o.bucket_id = 'order-files' and o.name = e->>'path';

  insert into public.order_document_submissions
    (id, order_id, includes_design_files, includes_client_po, design_mode, note,
     status, snapshot_sha256, file_count, resubmission_of, submitted_by)
  values
    (p_submission_id, p_order_id, v_design, v_po, case when v_design then p_design_mode end, v_note,
     'pending_admin', v_sha, jsonb_array_length(p_files), p_resubmission_of, v_actor);

  insert into public.order_document_submission_files
    (submission_id, category, storage_path, storage_object_id, file_name, mime_type, size_bytes)
  select p_submission_id, split_part(o.name, '/', 4), o.name, o.id, btrim(e->>'file_name'),
         o.metadata->>'mimetype', (o.metadata->>'size')::bigint
    from jsonb_array_elements(p_files) e
    join storage.objects o on o.bucket_id = 'order-files' and o.name = e->>'path';

  perform public.order_document_log_event(p_submission_id, p_order_id, v_actor, 'submitted', null, 'pending_admin', v_note);

  -- The next owner: every active admin except the submitter.
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select u.id, null, p_order_id, 'order_document_review_requested'::notification_type,
         format('Order %s: %s submitted for admin review.', v_order.display_number,
                public.order_document_categories_label(v_design, v_po)),
         v_note, true
    from public.users u
   where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false and u.id <> v_actor;

  return jsonb_build_object('id', p_submission_id, 'order_id', p_order_id, 'status', 'pending_admin',
                            'snapshot_sha256', v_sha, 'file_count', jsonb_array_length(p_files));
end;
$$;
revoke execute on function public.create_order_document_submission(uuid, uuid, text, text, jsonb, uuid) from public, anon;
grant  execute on function public.create_order_document_submission(uuid, uuid, text, text, jsonb, uuid) to authenticated;




-- ═══ 9. The admin decision ═════════════════════════════════════════════════

create or replace function public.decide_order_document_submission_admin(
  p_submission_id  uuid,
  p_decision       text,
  p_reason         text,
  p_snapshot       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_order_id uuid;
  v_order    public.orders%rowtype;
  v_s        public.order_document_submissions%rowtype;
  v_reason   text;
  v_reviewer uuid;
  v_label    text;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'ORDER_DOCUMENT_DECISION_UNKNOWN: the decision must be approved or rejected' using errcode = 'P0001';
  end if;
  v_reason := public.order_document_reason(p_reason, p_decision = 'rejected');
  if exists (select 1 from public.order_document_submissions where id = p_submission_id and stage = 'initial') then
    raise exception 'ORDER_DOCUMENT_DECIDED_WITH_PI: documents sent with a PI are approved or returned with that PI, not here'
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'Only an administrator can make the admin decision on a document submission' using errcode = '42501';
  end if;

  select order_id into v_order_id from public.order_document_submissions where id = p_submission_id;
  if v_order_id is null then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_NOT_FOUND: that submission no longer exists' using errcode = 'P0002';
  end if;
  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_s from public.order_document_submissions where id = p_submission_id for update;

  if v_s.stage = 'initial' then
    raise exception 'ORDER_DOCUMENT_DECIDED_WITH_PI: documents sent with a PI are approved or returned with that PI, not here'
      using errcode = 'P0001';
  end if;
  if v_s.status <> 'pending_admin' then
    raise exception 'ORDER_DOCUMENT_ALREADY_DECIDED: this submission has already been decided (it is now %). Refresh to see its current state.',
      v_s.status using errcode = 'P0001';
  end if;
  if p_snapshot is distinct from v_s.snapshot_sha256 then
    raise exception 'ORDER_DOCUMENT_SNAPSHOT_MISMATCH: the files you reviewed are not the files of this submission. Refresh and review again.'
      using errcode = 'P0001';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_DOCUMENT_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;

  v_label := public.order_document_categories_label(v_s.includes_design_files, v_s.includes_client_po);

  if p_decision = 'rejected' then
    update public.order_document_submissions
       set status = 'rejected_admin', admin_decided_by = v_actor, admin_decided_at = now(), admin_reason = v_reason
     where id = v_s.id;
    perform public.order_document_log_event(v_s.id, v_s.order_id, v_actor, 'admin_rejected', 'pending_admin', 'rejected_admin', v_reason);
    if v_s.submitted_by <> v_actor then
      insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
      values (v_s.submitted_by, null, v_s.order_id, 'order_document_review_decided'::notification_type,
              format('Order %s: your %s submission was rejected by admin.', v_order.display_number, v_label), v_reason, true);
    end if;
    return jsonb_build_object('id', v_s.id, 'status', 'rejected_admin');
  end if;

  -- Approved: the next owner is the assigned operations reviewer, if they can
  -- open this Order. Otherwise it waits unassigned and the admins are told.
  select r.user_id into v_reviewer
    from public.order_operations_reviewers r
    join public.users u on u.id = r.user_id
   where r.duty = 'pi_handoff' and u.is_active and coalesce(u.is_deleted, false) = false
     and public.operations_reviewer_can_open_order(r.user_id, v_s.order_id);

  update public.order_document_submissions
     set status = 'awaiting_operations', admin_decided_by = v_actor, admin_decided_at = now(),
         admin_reason = v_reason, operations_reviewer = v_reviewer
   where id = v_s.id;
  perform public.order_document_log_event(v_s.id, v_s.order_id, v_actor, 'admin_approved', 'pending_admin', 'awaiting_operations', v_reason);

  if v_reviewer is not null then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_reviewer, null, v_s.order_id, 'order_document_review_requested'::notification_type,
            format('Order %s: %s approved by admin — awaiting your operations acceptance.', v_order.display_number, v_label),
            null, true);
  else
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select u.id, null, v_s.order_id, 'order_document_review_requested'::notification_type,
           format('Order %s: %s awaits operations acceptance, but no operations reviewer is assigned.', v_order.display_number, v_label),
           'Assign one in Control Center → Operations Handoff.', true
      from public.users u
     where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false;
  end if;

  return jsonb_build_object('id', v_s.id, 'status', 'awaiting_operations', 'operations_reviewer', v_reviewer);
end;
$$;
revoke execute on function public.decide_order_document_submission_admin(uuid, text, text, text) from public, anon;
grant  execute on function public.decide_order_document_submission_admin(uuid, text, text, text) to authenticated;


-- ═══ 10. The operations decision — the only promotion ══════════════════════

create or replace function public.decide_order_document_submission_operations(
  p_submission_id  uuid,
  p_decision       text,
  p_reason         text,
  p_snapshot       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_order_id uuid;
  v_order    public.orders%rowtype;
  v_s        public.order_document_submissions%rowtype;
  v_reason   text;
  v_reviewer uuid;
  v_label    text;
begin
  if p_decision is null or p_decision not in ('accepted', 'rejected') then
    raise exception 'ORDER_DOCUMENT_DECISION_UNKNOWN: the decision must be accepted or rejected' using errcode = 'P0001';
  end if;
  v_reason := public.order_document_reason(p_reason, p_decision = 'rejected');
  if exists (select 1 from public.order_document_submissions where id = p_submission_id and stage = 'initial') then
    raise exception 'ORDER_DOCUMENT_DECIDED_WITH_PI: documents sent with a PI are accepted with that PI''s operations review (Accept for production), not here'
      using errcode = 'P0001';
  end if;

  select order_id into v_order_id from public.order_document_submissions where id = p_submission_id;
  if v_order_id is null then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_NOT_FOUND: that submission no longer exists' using errcode = 'P0002';
  end if;
  select user_id into v_reviewer from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_s from public.order_document_submissions where id = p_submission_id for update;

  if v_s.stage = 'initial' then
    raise exception 'ORDER_DOCUMENT_DECIDED_WITH_PI: documents sent with a PI are accepted with that PI''s operations review (Accept for production), not here'
      using errcode = 'P0001';
  end if;

  -- Authority: the reviewer assigned NOW, able to open this Order.
  if v_reviewer is null then
    raise exception 'ORDER_DOCUMENT_NO_OPERATIONS_REVIEWER: no operations reviewer is assigned; an administrator must assign one in Control Center'
      using errcode = 'P0001';
  end if;
  if v_reviewer <> v_actor then
    raise exception 'Only the assigned operations reviewer can accept or reject a document submission' using errcode = '42501';
  end if;
  if not public.can_view_order_as_actor(v_s.order_id) then
    raise exception 'You do not have access to this Order' using errcode = '42501';
  end if;

  if v_s.status <> 'awaiting_operations' then
    raise exception 'ORDER_DOCUMENT_ALREADY_DECIDED: this submission is not awaiting operations (it is now %). Refresh to see its current state.',
      v_s.status using errcode = 'P0001';
  end if;
  -- AND the submission is addressed to them: §12 keeps this equal to the
  -- assignment, so a former reviewer's stale tab is refused here too.
  if v_s.operations_reviewer is distinct from v_actor then
    raise exception 'Only the assigned operations reviewer can accept or reject a document submission' using errcode = '42501';
  end if;
  if p_snapshot is distinct from v_s.snapshot_sha256 then
    raise exception 'ORDER_DOCUMENT_SNAPSHOT_MISMATCH: the files you reviewed are not the files of this submission. Refresh and review again.'
      using errcode = 'P0001';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_DOCUMENT_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;

  v_label := public.order_document_categories_label(v_s.includes_design_files, v_s.includes_client_po);

  update public.order_document_submissions
     set status = case when p_decision = 'accepted' then 'accepted' else 'rejected_operations' end,
         operations_reviewer = v_actor, operations_decided_by = v_actor, operations_decided_at = now(),
         operations_reason = v_reason
   where id = v_s.id;
  perform public.order_document_log_event(
    v_s.id, v_s.order_id, v_actor,
    case when p_decision = 'accepted' then 'operations_accepted' else 'operations_rejected' end,
    'awaiting_operations', case when p_decision = 'accepted' then 'accepted' else 'rejected_operations' end,
    v_reason);

  -- Sales hears the final outcome; on a rejection the approving admin does too.
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select distinct x.uid, null::uuid, v_s.order_id, 'order_document_review_decided'::notification_type,
         case when p_decision = 'accepted'
              then format('Order %s: %s accepted by operations and now current.', v_order.display_number, v_label)
              else format('Order %s: %s rejected by operations.', v_order.display_number, v_label) end,
         v_reason, true
    from (select v_s.submitted_by as uid
          union all
          select v_s.admin_decided_by where p_decision = 'rejected') x
   where x.uid is not null and x.uid <> v_actor;

  return jsonb_build_object('id', v_s.id,
                            'status', case when p_decision = 'accepted' then 'accepted' else 'rejected_operations' end);
end;
$$;
revoke execute on function public.decide_order_document_submission_operations(uuid, text, text, text) from public, anon;
grant  execute on function public.decide_order_document_submission_operations(uuid, text, text, text) to authenticated;


-- ═══ 11. Documents sent WITH the PI (the initial submission) ═══════════════
--
-- Sales attaches Design Files and a Client PO in the same dialog that sends
-- the PI for approval. Those files are an INITIAL submission of the PI and are
-- decided by the PI's own doors — there is no second approval and no second
-- operations task:
--
--   submit_pi_for_review_with_documents()   the PI goes to review exactly as
--                                           submit_pi_for_review() sends it,
--                                           and the documents are recorded in
--                                           the same transaction  → pending_admin
--   approve_order_submission()              the approver creates the Order →
--                                           the documents are linked to it and
--                                           await operations (trigger, §11d)
--   request changes / reject the PI         the documents are rejected with the
--                                           PI's own reason (trigger, §11d)
--   decide_order_operations_handoff()       the reviewer accepts the PI version
--   → 'accepted'                            → the documents are accepted with it
--                                           (trigger, §11e)
--
-- A category with no file is an ACKNOWLEDGED ABSENCE, recorded once per
-- submission in order_pi_document_absences — never an "attached" state. The
-- wrapper refuses a submission whose missing categories were not confirmed.
--
-- Nothing here changes a PI rule: submit_pi_for_review() runs unchanged, with
-- every ownership, state, permission, payment and completeness check it makes,
-- and the auto-approval of a PI submitted by an approve_order holder (20261224)
-- still stamps only the PI decision — its documents stay pending until the
-- Order is created, and are accepted only by the operations reviewer.

-- ── 11a. Storage: order-files/pi-documents/{pi}/{submission}/{category}/{uuid}.{ext}

create or replace function public.order_pi_document_key_parts(p_name text)
returns table (pi_submission_id uuid, submission_id uuid, category text)
language sql
immutable
as $$
  select split_part(p_name, '/', 2)::uuid, split_part(p_name, '/', 3)::uuid, split_part(p_name, '/', 4)
  where p_name ~ '^pi-documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(design_files|client_po)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|jpeg|webp)$';
$$;
revoke execute on function public.order_pi_document_key_parts(text) from public, anon;
grant  execute on function public.order_pi_document_key_parts(text) to authenticated;

-- Writable by the PI's owner while the PI is a draft or returned (the same
-- rule as its workbook), and sealed once the submission exists.
create or replace function public.can_upload_pi_document_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_pi_document_key_parts(p_name) k
    where public.can_write_order_submission_file(k.pi_submission_id)
      and not exists (select 1 from public.order_document_submissions s where s.id = k.submission_id)
  );
$$;
revoke execute on function public.can_upload_pi_document_file(text) from public, anon;
grant  execute on function public.can_upload_pi_document_file(text) to authenticated;

-- Readable by whoever can open the PI for review, and — once it is an Order —
-- by whoever can open the Order (the operations reviewer among them).
create or replace function public.can_read_pi_document_file(p_name text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.order_pi_document_key_parts(p_name) k
    where coalesce(public.can_view_order_submission(k.pi_submission_id), false)
       or coalesce(public.can_view_order_submission_via_order(k.pi_submission_id), false)
  );
$$;
revoke execute on function public.can_read_pi_document_file(text) from public, anon;
grant  execute on function public.can_read_pi_document_file(text) to authenticated;

drop policy if exists "order_files_pi_document_insert" on storage.objects;
create policy "order_files_pi_document_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'order-files' and public.module_entry_open('orders')
              and public.can_upload_pi_document_file(name));

drop policy if exists "order_files_pi_document_select" on storage.objects;
create policy "order_files_pi_document_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'order-files' and public.module_entry_open('orders')
         and public.can_read_pi_document_file(name));
-- NO UPDATE AND NO DELETE POLICY here either.

-- ── 11b. The acknowledged absence ──

create table if not exists public.order_pi_document_absences (
  id                uuid primary key default gen_random_uuid(),
  pi_submission_id  uuid not null references public.order_submissions(id) on delete cascade,
  missing           text[] not null check (cardinality(missing) between 1 and 2
                                           and missing <@ array['design_files', 'client_po']::text[]),
  acknowledged_by   uuid not null references public.users(id),
  acknowledged_at   timestamptz not null default now()
);
create index if not exists order_pi_document_absences_pi_idx
  on public.order_pi_document_absences (pi_submission_id, acknowledged_at desc);
comment on table public.order_pi_document_absences is
  'Append-only: at the moment a PI was sent for approval, the submitter explicitly confirmed it goes without these supporting categories. An acknowledged absence, never an attachment.';

drop trigger if exists order_pi_document_absences_guard on public.order_pi_document_absences;
create trigger order_pi_document_absences_guard
  before update or delete on public.order_pi_document_absences
  for each row execute function public.order_document_append_only_guard();

alter table public.order_pi_document_absences enable row level security;
revoke all on table public.order_pi_document_absences from public, anon, authenticated;
grant select on table public.order_pi_document_absences to authenticated;
drop policy if exists "order_pi_document_absences_select" on public.order_pi_document_absences;
create policy "order_pi_document_absences_select" on public.order_pi_document_absences
  for select to authenticated
  using (coalesce(public.can_view_order_submission(pi_submission_id), false)
         or coalesce(public.can_view_order_submission_via_order(pi_submission_id), false));
drop policy if exists "order_pi_document_absences_module_gate" on public.order_pi_document_absences;
create policy "order_pi_document_absences_module_gate" on public.order_pi_document_absences
  as restrictive for all to authenticated
  using (public.module_entry_open('orders')) with check (public.module_entry_open('orders'));

-- Rows with no Order yet are read through the PI's visibility (§4 policies
-- already route through can_view_order_document_submission).

-- ── 11c. Sending the PI with its documents ──
--
-- p_files: [{"path": "...", "file_name": "..."}] — each key under THIS
-- submission, or a file of an EARLIER initial submission of the same PI being
-- carried forward (a returned PI resubmitted with what it already had).
-- p_acknowledged_missing: exactly the categories with no file, confirmed.

create or replace function public.submit_pi_for_review_with_documents(
  p_submission_id           uuid,
  p_note                    text,
  p_reason                  text,
  p_payment_terms           text,
  p_billing_terms           text,
  p_document_submission_id  uuid,
  p_files                   jsonb,
  p_acknowledged_missing    text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_result   jsonb;
  v_file     jsonb;
  v_path     text;
  v_name     text;
  v_parts    record;
  v_obj      record;
  v_design   boolean := false;
  v_po       boolean := false;
  v_missing  text[] := array[]::text[];
  v_ack      text[] := coalesce(p_acknowledged_missing, array[]::text[]);
  v_sha      text;
  v_prior    uuid;
  v_n        integer;
begin
  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'ORDER_DOCUMENT_FILES_INVALID: files must be a list (empty when none are attached)' using errcode = 'P0001';
  end if;
  v_n := jsonb_array_length(p_files);
  if v_n > 25 then
    raise exception 'ORDER_DOCUMENT_TOO_MANY_FILES: at most 25 files per submission' using errcode = 'P0001';
  end if;
  if v_n > 0 and p_document_submission_id is null then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_INVALID: a document submission id is required with files' using errcode = 'P0001';
  end if;

  -- The categories, from the keys; every key must belong to THIS PI.
  for v_file in select * from jsonb_array_elements(p_files) loop
    v_path := v_file->>'path';
    select * into v_parts from public.order_pi_document_key_parts(v_path);
    if v_parts.pi_submission_id is null or v_parts.pi_submission_id <> p_submission_id then
      raise exception 'ORDER_DOCUMENT_FILE_PATH_INVALID: % is not a file of this PI', coalesce(v_path, '(none)')
        using errcode = 'P0001';
    end if;
    if v_parts.submission_id <> p_document_submission_id and not exists (
         select 1 from public.order_document_submission_files f
           join public.order_document_submissions s on s.id = f.submission_id
          where f.storage_path = v_path and s.stage = 'initial' and s.pi_submission_id = p_submission_id) then
      raise exception 'ORDER_DOCUMENT_FILE_PATH_INVALID: % is neither new in this submission nor a file this PI already carried', v_path
        using errcode = 'P0001';
    end if;
    if v_parts.category = 'design_files' then v_design := true; else v_po := true; end if;
  end loop;
  -- (every key was validated above, so its fourth segment IS its category)
  if (select count(*) from jsonb_array_elements(p_files) e where split_part(e->>'path', '/', 4) = 'client_po') > 5 then
    raise exception 'ORDER_DOCUMENT_TOO_MANY_FILES: at most 5 Client PO files per submission' using errcode = 'P0001';
  end if;
  if (select count(distinct e->>'path') from jsonb_array_elements(p_files) e) <> v_n then
    raise exception 'ORDER_DOCUMENT_FILE_DUPLICATE: a file is listed twice' using errcode = 'P0001';
  end if;

  -- THE ABSENCE MUST BE CONFIRMED, category by category.
  if not v_design then v_missing := array_append(v_missing, 'design_files'); end if;
  if not v_po then v_missing := array_append(v_missing, 'client_po'); end if;
  if not (v_ack @> v_missing and v_missing @> v_ack) then
    raise exception 'ORDER_DOCUMENT_ABSENCE_NOT_CONFIRMED: confirm that this PI goes without %',
      array_to_string(array(select case m when 'design_files' then 'design files' else 'a client PO' end from unnest(v_missing) m), ' and ')
      using errcode = 'P0001';
  end if;

  -- THE PI FIRST, through its own door and every check it makes. A refusal
  -- there rolls this whole call back.
  v_result := public.submit_pi_for_review(p_submission_id, p_note, p_reason, p_payment_terms, p_billing_terms);

  if v_n > 0 then
    if exists (select 1 from public.order_document_submissions where id = p_document_submission_id) then
      raise exception 'ORDER_DOCUMENT_SUBMISSION_EXISTS: this submission was already sent' using errcode = 'P0001';
    end if;
    for v_file in select * from jsonb_array_elements(p_files) loop
      v_path := v_file->>'path';
      v_name := nullif(btrim(coalesce(v_file->>'file_name', '')), '');
      if v_name is null or char_length(v_name) > 200 then
        raise exception 'ORDER_DOCUMENT_FILE_NAME_INVALID: every file needs a name of at most 200 characters' using errcode = 'P0001';
      end if;
      select o.id, o.owner_id, (o.metadata->>'mimetype') as mime, (o.metadata->>'size')::bigint as size
        into v_obj from storage.objects o where o.bucket_id = 'order-files' and o.name = v_path;
      if not found then
        raise exception 'ORDER_DOCUMENT_FILE_MISSING: % was not uploaded', v_name using errcode = 'P0001';
      end if;
      -- A NEW file must be the caller's own upload; a carried one was checked
      -- when it was first submitted.
      if split_part(v_path, '/', 3) = p_document_submission_id::text and v_obj.owner_id is distinct from v_actor::text then
        raise exception 'ORDER_DOCUMENT_FILE_NOT_YOURS: % was uploaded by somebody else', v_name using errcode = '42501';
      end if;
      if v_obj.mime is null or v_obj.mime not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
        raise exception 'ORDER_DOCUMENT_FILE_TYPE: % must be a PDF, PNG, JPEG or WebP file', v_name using errcode = 'P0001';
      end if;
      if v_obj.size is null or v_obj.size <= 0 or v_obj.size > 10485760 then
        raise exception 'ORDER_DOCUMENT_FILE_SIZE: % must be between 1 byte and 10 MB', v_name using errcode = 'P0001';
      end if;
    end loop;

    select encode(sha256(convert_to(string_agg(
             split_part(o.name, '/', 4) || '|' || o.name || '|' || o.id::text || '|'
               || (o.metadata->>'size') || '|' || (o.metadata->>'mimetype'),
             E'\n' order by o.name), 'UTF8')), 'hex')
      into v_sha
      from jsonb_array_elements(p_files) e
      join storage.objects o on o.bucket_id = 'order-files' and o.name = e->>'path';

    -- A correction links the last initial submission the PI's return rejected.
    select s.id into v_prior from public.order_document_submissions s
     where s.stage = 'initial' and s.pi_submission_id = p_submission_id and s.status = 'rejected_admin'
     order by s.submitted_at desc limit 1;

    insert into public.order_document_submissions
      (id, stage, order_id, pi_submission_id, includes_design_files, includes_client_po, design_mode, note,
       status, snapshot_sha256, file_count, resubmission_of, submitted_by)
    values
      (p_document_submission_id, 'initial', null, p_submission_id, v_design, v_po,
       case when v_design then 'add' end, null,
       'pending_admin', v_sha, v_n, v_prior, v_actor);

    insert into public.order_document_submission_files
      (submission_id, category, storage_path, storage_object_id, file_name, mime_type, size_bytes)
    select p_document_submission_id, split_part(o.name, '/', 4), o.name, o.id, btrim(e->>'file_name'),
           o.metadata->>'mimetype', (o.metadata->>'size')::bigint
      from jsonb_array_elements(p_files) e
      join storage.objects o on o.bucket_id = 'order-files' and o.name = e->>'path';

    perform public.order_document_log_event(p_document_submission_id, null, v_actor, 'submitted', null, 'pending_admin', null);
  end if;

  if cardinality(v_missing) > 0 then
    insert into public.order_pi_document_absences (pi_submission_id, missing, acknowledged_by)
    values (p_submission_id, v_missing, v_actor);
  end if;

  -- NO NOTIFICATION: the PI's own review queue is where approvers look, and a
  -- second message for the same submission would be a duplicate.
  return v_result || jsonb_build_object(
    'document_submission_id', case when v_n > 0 then p_document_submission_id end,
    'documents_missing', to_jsonb(v_missing));
end;
$$;
comment on function public.submit_pi_for_review_with_documents(uuid, text, text, text, text, uuid, jsonb, text[]) is
  'Sends a PI for approval through submit_pi_for_review() — unchanged, every check it makes — and, in the same transaction, records the Design Files / Client PO attached to it as an initial document submission and any category explicitly confirmed absent. The documents are decided with the PI: approved when approve_order_submission() creates the Order, rejected when the PI is returned or rejected, accepted when the operations reviewer accepts the PI version.';
revoke execute on function public.submit_pi_for_review_with_documents(uuid, text, text, text, text, uuid, jsonb, text[]) from public, anon;
grant  execute on function public.submit_pi_for_review_with_documents(uuid, text, text, text, text, uuid, jsonb, text[]) to authenticated;

-- ── 11d. The PI's own decisions carry its documents ──

create or replace function public.order_submissions_carry_initial_documents()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s        record;
  v_reviewer uuid;
  v_actor    uuid;
  v_reason   text;
begin
  -- THE ORDER WAS CREATED: the approver's decision is the admin decision.
  if old.order_id is null and new.order_id is not null then
    -- The reviewer, read under the same SHARE lock the handoff trigger takes,
    -- so a reassignment in flight is serialized with this approval (§12).
    select r.user_id into v_reviewer from public.order_operations_reviewers r where r.duty = 'pi_handoff' for share;
    if v_reviewer is not null and not (
         exists (select 1 from public.users u where u.id = v_reviewer and u.is_active and coalesce(u.is_deleted, false) = false)
         and public.operations_reviewer_can_open_order(v_reviewer, new.order_id)) then
      v_reviewer := null;
    end if;
    v_actor := coalesce(new.approved_by, auth.uid());
    perform set_config('boe.order_document_pi_link', 'on', true);
    for v_s in
      select id from public.order_document_submissions
       where stage = 'initial' and pi_submission_id = new.id and status = 'pending_admin'
         for update
    loop
      update public.order_document_submissions
         set status = 'awaiting_operations', order_id = new.order_id,
             admin_decided_by = v_actor, admin_decided_at = now(), admin_reason = null,
             operations_reviewer = v_reviewer
       where id = v_s.id;
      perform public.order_document_log_event(v_s.id, new.order_id, v_actor, 'admin_approved',
        'pending_admin', 'awaiting_operations', 'Approved with the PI; accepted with PI V1''s operations review');
    end loop;
    perform set_config('boe.order_document_pi_link', '', true);
    return new;
  end if;

  -- THE PI WENT BACK (returned for changes, or rejected): its documents go
  -- back with it, with the PI's own reason. Sales re-attaches or carries them
  -- forward when resubmitting.
  if old.status = 'submitted' and new.status in ('needs_changes', 'rejected') then
    v_actor := coalesce(new.rejected_by, auth.uid());
    v_reason := coalesce(nullif(btrim(coalesce(new.review_note, '')), ''),
                         case when new.status = 'rejected' then 'The PI was rejected.' else 'The PI was returned for changes.' end);
    v_reason := left(case when new.status = 'rejected' then 'PI rejected: ' else 'PI returned for changes: ' end || v_reason, 1000);
    perform set_config('boe.order_document_pi_link', 'on', true);
    for v_s in
      select id from public.order_document_submissions
       where stage = 'initial' and pi_submission_id = new.id and status = 'pending_admin'
         for update
    loop
      update public.order_document_submissions
         set status = 'rejected_admin', admin_decided_by = v_actor, admin_decided_at = now(), admin_reason = v_reason
       where id = v_s.id;
      perform public.order_document_log_event(v_s.id, null, v_actor, 'admin_rejected', 'pending_admin', 'rejected_admin', v_reason);
    end loop;
    perform set_config('boe.order_document_pi_link', '', true);
  end if;
  return new;
end;
$$;
revoke execute on function public.order_submissions_carry_initial_documents() from public, anon, authenticated, service_role;
drop trigger if exists order_submissions_carry_initial_documents on public.order_submissions;
create trigger order_submissions_carry_initial_documents
  after update of status, order_id on public.order_submissions
  for each row execute function public.order_submissions_carry_initial_documents();

-- ── 11e. The operations reviewer's acceptance of the PI accepts its documents ──
--
-- The existing handoff IS the operations task for the initial documents; no
-- second one is created and the reviewer is notified by the handoff alone.
-- A flag ("Cannot accept") leaves them awaiting, visibly, until the PI version
-- is accepted.

create or replace function public.order_operations_handoffs_accept_initial_documents()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s     record;
  v_order text;
begin
  if new.status <> 'accepted' or old.status = 'accepted' then
    return new;
  end if;
  select display_number into v_order from public.orders where id = new.order_id;
  perform set_config('boe.order_document_pi_link', 'on', true);
  for v_s in
    select id, submitted_by, includes_design_files, includes_client_po
      from public.order_document_submissions
     where stage = 'initial' and order_id = new.order_id and status = 'awaiting_operations'
       for update
  loop
    update public.order_document_submissions
       set status = 'accepted', operations_reviewer = new.accepted_by,
           operations_decided_by = new.accepted_by, operations_decided_at = now(), operations_reason = null
     where id = v_s.id;
    perform public.order_document_log_event(v_s.id, new.order_id, new.accepted_by, 'operations_accepted',
      'awaiting_operations', 'accepted', format('Accepted with PI V%s for production', new.version_number));
    -- Sales hears the final acceptance of what they attached, once.
    if v_s.submitted_by is distinct from new.accepted_by then
      insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
      values (v_s.submitted_by, null, new.order_id, 'order_document_review_decided'::notification_type,
              format('Order %s: %s accepted by operations with PI V%s and now current.', v_order,
                     public.order_document_categories_label(v_s.includes_design_files, v_s.includes_client_po),
                     new.version_number),
              null, true);
    end if;
  end loop;
  perform set_config('boe.order_document_pi_link', '', true);
  return new;
end;
$$;
revoke execute on function public.order_operations_handoffs_accept_initial_documents() from public, anon, authenticated, service_role;
drop trigger if exists order_operations_handoffs_accept_initial_documents on public.order_operations_handoffs;
create trigger order_operations_handoffs_accept_initial_documents
  after update of status on public.order_operations_handoffs
  for each row execute function public.order_operations_handoffs_accept_initial_documents();


-- ═══ 12. Reassigning the operations reviewer readdresses open submissions ══
--
-- The Control Center assignment (order_operations_reviewers) is the one
-- authority. set_order_operations_reviewer() takes that row FOR UPDATE and
-- then writes it; this AFTER trigger, inside the same transaction, readdresses
-- every submission awaiting operations — so operations_reviewer on the row,
-- which the Order page and the Orders dashboard both read, always names the
-- person the decision RPC will accept. The former reviewer loses the action
-- the moment the assignment commits; the new one is told once per submission
-- (initial submissions ride with the PI handoff, whose own readdressing
-- notifies them). Lock order: reviewer row (held) → submissions; every
-- decision path takes the reviewer row SHARE first, so none can be holding a
-- submission while this waits.

create or replace function public.order_operations_reviewers_readdress_documents()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s      record;
  v_to     uuid;
  v_actor  uuid := auth.uid();
begin
  if tg_op = 'UPDATE' and new.user_id is not distinct from old.user_id then
    return new;
  end if;
  for v_s in
    select s.id, s.order_id, s.stage, s.operations_reviewer, s.includes_design_files, s.includes_client_po, o.display_number
      from public.order_document_submissions s
      join public.orders o on o.id = s.order_id
     where s.status = 'awaiting_operations'
       for update of s
  loop
    v_to := case when new.user_id is not null
                   and exists (select 1 from public.users u where u.id = new.user_id and u.is_active and coalesce(u.is_deleted, false) = false)
                   and public.operations_reviewer_can_open_order(new.user_id, v_s.order_id)
                 then new.user_id end;
    continue when v_to is not distinct from v_s.operations_reviewer;
    update public.order_document_submissions set operations_reviewer = v_to where id = v_s.id;
    perform public.order_document_log_event(v_s.id, v_s.order_id, v_actor, 'operations_reassigned',
      'awaiting_operations', 'awaiting_operations',
      case when v_to is null then 'No operations reviewer is assigned' else null end);
    if v_to is not null and v_s.stage = 'amendment' and v_to is distinct from v_actor then
      insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
      values (v_to, null, v_s.order_id, 'order_document_review_requested'::notification_type,
              format('Order %s: %s now awaits your operations acceptance.', v_s.display_number,
                     public.order_document_categories_label(v_s.includes_design_files, v_s.includes_client_po)),
              'You have been assigned as the operations reviewer.', true);
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function public.order_operations_reviewers_readdress_documents() from public, anon, authenticated, service_role;
drop trigger if exists order_operations_reviewers_readdress_documents on public.order_operations_reviewers;
create trigger order_operations_reviewers_readdress_documents
  after insert or update of user_id on public.order_operations_reviewers
  for each row execute function public.order_operations_reviewers_readdress_documents();

-- FABRIC AND FINISH APPROVALS, AS PERMANENT EVENTS.
--
-- WHAT THIS MIGRATION IS FOR
-- --------------------------
-- A Confirmed Order passes two sign-offs before it can be built: the fabric and
-- the finish. Each moves through Not Approved → Partially Approved → Fully
-- Approved, each is evidenced by a screenshot from the ERP, and each matters
-- enough that "who said so, and when" has to survive the next change.
--
-- SO IT IS AN EVENT LOG, NOT A STATUS COLUMN. A pair of columns on public.orders
-- would answer "where is it now" and destroy the answer to "how did it get
-- here" on every update — and the evidence with it. Rows here are appended and
-- never changed: there is no UPDATE policy and no DELETE policy for any client
-- role, and a trigger refuses both again for anything holding a direct grant.
-- The current state of a card is the newest event of each kind, which is a read.
--
-- WHAT IT DOES NOT TOUCH. Nothing about order creation, confirmation, payment
-- verification, the advance exception, or production alignment. The Risky/Safe
-- advance indicator this feature also introduces is computed in the browser
-- from the existing finance position and stores nothing; the 40%-or-exception
-- gate on approving a PI is untouched and lives where it always has.
--
-- WHAT IT ADDS
--   1.  public.order_approval_events            append-only, RLS on
--   2.  public.can_record_order_approval(uuid)  the one write authority
--   3.  public.record_order_approval_event(...) the one write path
--   4.  storage bucket order-approval-evidence  private, images only
--   5.  storage policies                        read follows Order visibility,
--                                               write follows (2), delete reaches
--                                               only an unclaimed orphan
--
-- IDEMPOTENT. Every object is created if-not-exists or replaced, every policy is
-- dropped before it is created, and the verification block at the end raises if
-- any of it did not take. Re-running is a no-op.

-- ═══ 0. What this migration assumes already exists ═══════════════════════════
--
-- Fail LOUDLY and early rather than creating a table whose policies silently
-- admit nobody because a helper was missing.

do $$
begin
  if to_regprocedure('public.can_view_order(uuid)') is null then
    raise exception 'can_view_order(uuid) is missing; 20260924000000 must run first';
  end if;
  if to_regprocedure('public.module_entry_open(text)') is null then
    raise exception 'module_entry_open(text) is missing; 20260905000000 must run first';
  end if;
  if to_regclass('public.orders') is null then
    raise exception 'public.orders is missing';
  end if;
end;
$$;


-- ═══ 1. The event log ════════════════════════════════════════════════════════

create table if not exists public.order_approval_events (
  id             uuid        primary key default gen_random_uuid(),

  -- CASCADE, for the same reason order_pi_versions cascades: an audited Test
  -- Data Cleanup deletes the Order, and nothing else can delete one at all
  -- (orders_prevent_delete refuses every path, including the service role).
  order_id       uuid        not null references public.orders(id) on delete cascade,

  -- WHICH SIGN-OFF. Two kinds, tracked entirely separately: a fabric event says
  -- nothing about finish and vice versa.
  approval_kind  text        not null check (approval_kind in ('fabric', 'finish')),

  status         text        not null
                             check (status in ('not_approved', 'partially_approved', 'fully_approved')),

  -- The ERP screenshot backing THIS event, in the private evidence bucket.
  evidence_path  text,

  -- WHO AND WHEN, on every event without exception. The FK does not cascade and
  -- does not null: an approval whose actor cannot be named is not an audit
  -- record, and public.users rows are deactivated rather than deleted.
  actor_id       uuid        not null references public.users(id) on delete restrict,
  created_at     timestamptz not null default now(),

  -- EVIDENCE IS REQUIRED EXACTLY WHERE IT MEANS SOMETHING.
  --
  -- A biconditional, not a one-way check: moving to Partially or Fully Approved
  -- must carry a screenshot, and moving BACK to Not Approved must not. The
  -- second half matters as much as the first — evidence filed against "this is
  -- not approved" would be a proof of nothing, sitting in the audit trail
  -- looking like a proof of something.
  constraint order_approval_events_evidence_matches_status check (
    (status in ('partially_approved', 'fully_approved'))
    = (nullif(btrim(coalesce(evidence_path, '')), '') is not null)
  ),

  -- A path this bucket could never hold is not a path.
  constraint order_approval_events_evidence_path_shape check (
    evidence_path is null
    or evidence_path ~ '^orders/[0-9a-f-]{36}/(fabric|finish)/[A-Za-z0-9._-]{1,120}$'
  )
);

comment on table public.order_approval_events is
  'Every fabric and finish approval event a Confirmed Order has recorded: the new status, the ERP screenshot backing it, who recorded it and when. APPEND-ONLY — no UPDATE or DELETE policy exists for any client role and order_approval_events_append_only refuses both again at the row. The current state of each kind is the newest row for that kind, which is a read and never a stored column.';

comment on column public.order_approval_events.evidence_path is
  'Object key in the private order-approval-evidence bucket. NOT NULL exactly when the status is partially_approved or fully_approved, by order_approval_events_evidence_matches_status. Never a URL, and never public.';

-- THE INDEX THE CARD ACTUALLY USES: newest event per kind for one Order, which
-- is a backwards scan of (order_id, approval_kind, created_at desc) and touches
-- one row per kind however long the history grows.
create index if not exists order_approval_events_current_idx
  on public.order_approval_events (order_id, approval_kind, created_at desc, id desc);

-- The evidence lookup, for the storage policy's reverse question: does any row
-- claim this object?
create index if not exists order_approval_events_evidence_idx
  on public.order_approval_events (evidence_path)
  where evidence_path is not null;


-- ═══ 2. Who may record one ═══════════════════════════════════════════════════
--
-- THE SALESPERSON ASSIGNED TO THE ORDER, AN ADMIN, OR A MANAGER — and nobody
-- else, whatever they can see.
--
-- THE SALESPERSON IS MATCHED BY ID, NEVER BY NAME. orders.assigned_to holds the
-- user id; comparing a display name would let two people called the same thing
-- sign off each other's Orders, and would break the moment somebody is renamed.
--
-- SECURITY DEFINER because it reads public.users, whose RLS does not show one
-- employee another's row — the established pattern in this repository
-- (can_write_order_pi_revision_file, 20261119000000). It is DEFINER to READ a
-- fact, not to skip a check: every condition below is stated explicitly, the
-- search path is pinned, and EXECUTE is granted to authenticated only.
--
-- ROLE COMES FROM public.users.role, which only an administrator can write. No
-- decision here reads anything the caller can edit about themselves.
create or replace function public.can_record_order_approval(p_order_id uuid)
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
    where o.id = p_order_id
      and u.is_active
      and coalesce(u.is_deleted, false) = false
      and (
        u.role in ('admin', 'manager')
        or o.assigned_to = auth.uid()
      )
  );
$$;

comment on function public.can_record_order_approval(uuid) is
  'True when the CALLER may record a fabric or finish approval event on this Order: the salesperson in orders.assigned_to (matched by user id, never by name), an active admin, or an active manager. Definer because it reads public.users.role, which RLS does not expose between employees; every condition is stated explicitly and EXECUTE is granted to authenticated only.';

revoke execute on function public.can_record_order_approval(uuid) from public, anon;
grant  execute on function public.can_record_order_approval(uuid) to authenticated;


-- ═══ 3. Row security ═════════════════════════════════════════════════════════

alter table public.order_approval_events enable row level security;
alter table public.order_approval_events force row level security;

revoke all on table public.order_approval_events from public, anon, authenticated;

-- SELECT and INSERT only. The two verbs this table does not grant are the whole
-- reason it can be trusted as history.
grant select, insert on table public.order_approval_events to authenticated;

drop policy if exists "order_approval_events_select" on public.order_approval_events;
create policy "order_approval_events_select" on public.order_approval_events
  for select to authenticated
  using (public.can_view_order(order_id));

drop policy if exists "order_approval_events_insert" on public.order_approval_events;
create policy "order_approval_events_insert" on public.order_approval_events
  for insert to authenticated
  with check (
    public.can_record_order_approval(order_id)
    -- The row must name its own author. Without this a permitted writer could
    -- file an event under somebody else's name.
    and actor_id = auth.uid()
  );

-- The module door, restrictive over both: a reader who has not been given the
-- Orders module sees nothing here either.
drop policy if exists "order_approval_events_module_entry_gate" on public.order_approval_events;
create policy "order_approval_events_module_entry_gate" on public.order_approval_events
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));

-- NO UPDATE POLICY AND NO DELETE POLICY. Deliberate, and the point of the table.

-- ── The second lock ──
--
-- Policies bind roles that go through RLS. This trigger refuses an UPDATE or a
-- DELETE from anything at all, including a future migration that adds a grant
-- by accident and including the service role. History that can be edited by the
-- application is not history.
create or replace function public.order_approval_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'ORDER_APPROVAL_EVENT_IMMUTABLE: fabric and finish approval events are append-only'
    using errcode = 'P0001';
end;
$$;

comment on function public.order_approval_events_append_only() is
  'Refuses every UPDATE and DELETE on public.order_approval_events. The RLS policies already grant neither; this refuses them a second time for any path that holds a direct grant, including the service role.';

revoke execute on function public.order_approval_events_append_only() from public, anon, authenticated;

drop trigger if exists order_approval_events_append_only on public.order_approval_events;
create trigger order_approval_events_append_only
  before update or delete on public.order_approval_events
  for each row execute function public.order_approval_events_append_only();


-- ═══ 4. The one write path ═══════════════════════════════════════════════════
--
-- The browser uploads the screenshot to the private bucket and then calls this
-- with the key. Everything that matters is re-derived HERE, under a row lock on
-- the Order, because a client-side check is a courtesy and not a control:
--
--   * the caller may record on this Order            can_record_order_approval
--   * the Order is not cancelled
--   * the status is one of the three
--   * evidence is present for an approved status, and REFUSED for Not Approved
--     rather than quietly discarded
--   * the evidence object EXISTS in the bucket, under this Order's own prefix
--     and this kind's folder — a recorded path that names nothing, or names
--     another Order's file, is refused rather than stored
--   * the evidence is not already claimed by an earlier event, so one upload
--     cannot satisfy two requirements
--   * an APPROVED status that is not a change from the current one is refused,
--     so "already approved" does not silently demand, or silently accept, a
--     second screenshot for an event that did not happen
--
-- It returns the id of the row it wrote. It never updates one.
create or replace function public.record_order_approval_event(
  p_order_id      uuid,
  p_approval_kind text,
  p_status        text,
  p_evidence_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_kind    text := lower(btrim(coalesce(p_approval_kind, '')));
  v_status  text := lower(btrim(coalesce(p_status, '')));
  v_path    text := nullif(btrim(coalesce(p_evidence_path, '')), '');
  v_current text;
  v_id      uuid;
begin
  if v_actor is null then
    raise exception 'ORDER_APPROVAL_NOT_AUTHENTICATED: sign in first'
      using errcode = 'P0001';
  end if;

  if v_kind not in ('fabric', 'finish') then
    raise exception 'ORDER_APPROVAL_BAD_KIND: approval kind must be fabric or finish'
      using errcode = 'P0001';
  end if;

  if v_status not in ('not_approved', 'partially_approved', 'fully_approved') then
    raise exception 'ORDER_APPROVAL_BAD_STATUS: unknown approval status'
      using errcode = 'P0001';
  end if;

  -- THE ORDER, LOCKED. Two people pressing Save at once then queue rather than
  -- both reading the same "current" status and both writing a first event.
  perform 1 from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_APPROVAL_NO_ORDER: that Order does not exist'
      using errcode = 'P0001';
  end if;

  if not public.can_record_order_approval(p_order_id) then
    raise exception
      'ORDER_APPROVAL_FORBIDDEN: only the assigned salesperson, an admin or a manager may record this'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from public.orders where id = p_order_id and status = 'cancelled') then
    raise exception 'ORDER_APPROVAL_ORDER_CANCELLED: this Order is cancelled'
      using errcode = 'P0001';
  end if;

  -- Where this kind stands right now: the newest event, or the implicit
  -- not_approved every Order starts at.
  select e.status into v_current
  from public.order_approval_events e
  where e.order_id = p_order_id and e.approval_kind = v_kind
  order by e.created_at desc, e.id desc
  limit 1;
  v_current := coalesce(v_current, 'not_approved');

  -- NOTHING CHANGED, NOTHING RECORDED. An unchanged approved status must not
  -- demand another screenshot, and must not accept one: an event log where the
  -- same fact appears twice with two proofs is a log nobody can read.
  if v_status = v_current then
    raise exception
      'ORDER_APPROVAL_UNCHANGED: % is already %', v_kind, v_status
      using errcode = 'P0001';
  end if;

  if v_status in ('partially_approved', 'fully_approved') then
    if v_path is null then
      raise exception
        'ORDER_APPROVAL_EVIDENCE_REQUIRED: an ERP screenshot is required for this % approval', v_kind
        using errcode = 'P0001';
    end if;

    -- THE KEY MUST NAME THIS ORDER AND THIS KIND. A caller who sent another
    -- Order's evidence path, or the fabric file for a finish event, is refused
    -- here — which is what makes "one file cannot satisfy both" true at the
    -- write boundary rather than only in the dialog.
    if v_path not like 'orders/' || p_order_id::text || '/' || v_kind || '/%' then
      raise exception
        'ORDER_APPROVAL_EVIDENCE_PATH: that screenshot does not belong to this Order and approval'
        using errcode = 'P0001';
    end if;

    -- IT MUST ACTUALLY BE THERE. A recorded path with no object behind it is a
    -- proof that cannot be opened, and it would pass every other check.
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-approval-evidence' and o.name = v_path
    ) then
      raise exception
        'ORDER_APPROVAL_EVIDENCE_MISSING: that screenshot was not found in storage'
        using errcode = 'P0001';
    end if;

    -- ONE FILE, ONE EVENT. Re-using an earlier event's screenshot would let a
    -- single upload stand as proof of two different approvals.
    if exists (
      select 1 from public.order_approval_events e where e.evidence_path = v_path
    ) then
      raise exception
        'ORDER_APPROVAL_EVIDENCE_REUSED: that screenshot is already filed against another approval'
        using errcode = 'P0001';
    end if;
  elsif v_path is not null then
    -- NOT APPROVED TAKES NO PROOF — AND REFUSING ONE IS NOT THE SAME AS
    -- DROPPING IT.
    --
    -- An earlier version of this function set v_path to null here. That was
    -- wrong in two ways at once. The caller was told the event had been
    -- recorded WITH the screenshot it sent, while the audit row holds none; and
    -- the object it uploaded a moment earlier stayed in the bucket with nothing
    -- in the log referencing it. A silent disagreement between what the caller
    -- believes it filed and what the history actually holds is the one thing an
    -- append-only table exists to prevent.
    --
    -- So: refuse, name the reason, and let the caller take its own upload back.
    raise exception
      'ORDER_APPROVAL_EVIDENCE_FORBIDDEN: Not Approved carries no screenshot; there is nothing to prove'
      using errcode = 'P0001';
  end if;

  insert into public.order_approval_events (order_id, approval_kind, status, evidence_path, actor_id)
  values (p_order_id, v_kind, v_status, v_path, v_actor)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_order_approval_event(uuid, text, text, text) is
  'Records ONE fabric or finish approval event on a Confirmed Order, for the assigned salesperson, an active admin or an active manager (re-derived here under a row lock on the Order, never trusted from the browser). Requires an ERP screenshot that exists in order-approval-evidence under this Order and this kind, is not already claimed by another event, for partially_approved and fully_approved; refuses evidence for not_approved; refuses a status that is not a change. Appends — it never updates a row.';

revoke execute on function public.record_order_approval_event(uuid, text, text, text) from public, anon;
grant  execute on function public.record_order_approval_event(uuid, text, text, text) to authenticated;


-- ═══ 5. The evidence bucket ══════════════════════════════════════════════════
--
-- ITS OWN BUCKET, not order-files. order-files authorizes every object by the
-- SUBMISSION its key names (order_file_submission_id), so an Order-scoped key
-- would decode to null and match nothing — it would fail closed, which is safe
-- but unusable. A second path grammar inside that bucket would also mean two
-- different authorities sharing one set of policies, which is how a storage
-- rule stops being reviewable.
--
-- PRIVATE, and images only: this bucket holds screenshots and must never be
-- able to hold a workbook or a PDF. 5 MiB is ample for an ERP screen capture
-- and half the workbook ceiling.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'order-approval-evidence',
  'order-approval-evidence',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The Order id an object key belongs to, or null when the key is not one of
-- ours. split_part never raises, so a malformed name fails closed — the same
-- reasoning order_file_submission_id follows.
create or replace function public.order_approval_evidence_order_id(p_name text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_name is null then null
    when split_part(p_name, '/', 1) <> 'orders' then null
    when split_part(p_name, '/', 3) not in ('fabric', 'finish') then null
    when split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 2)::uuid
    else null
  end;
$$;

comment on function public.order_approval_evidence_order_id(text) is
  'The Order id encoded in an order-approval-evidence object key, or null when the key is not an orders/{uuid}/{fabric|finish}/... path. Returns null rather than raising on a malformed key, so storage policies fail closed.';

revoke execute on function public.order_approval_evidence_order_id(text) from public, anon;
grant  execute on function public.order_approval_evidence_order_id(text) to authenticated;

-- READING AND WRITING ARE DIFFERENT AUTHORITIES, exactly as they are for
-- order-files:
--
--   SELECT  can_view_order                 anybody who may read the Order may
--                                          open its evidence. The card shows
--                                          the statuses to every Order viewer,
--                                          and a status whose proof cannot be
--                                          opened is a status nobody can check.
--   INSERT  can_record_order_approval      the assigned salesperson, an admin
--                                          or a manager, and nobody else.
--
--   DELETE  can_record_order_approval      and ONLY while no event claims the
--           + unclaimed                    object: the orphan a refused write
--                                          left behind, never a filed proof.
--
-- NO UPDATE POLICY: an uploaded screenshot's bytes are permanent. Without that
-- policy an x-upsert write cannot swap a file while leaving its key untouched,
-- which is what keeps "the proof filed is the proof uploaded" true.
drop policy if exists "order_approval_evidence_select" on storage.objects;
create policy "order_approval_evidence_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-approval-evidence'
    and public.module_entry_open('orders')
    and public.can_view_order(public.order_approval_evidence_order_id(name))
  );

drop policy if exists "order_approval_evidence_insert" on storage.objects;
create policy "order_approval_evidence_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-approval-evidence'
    and public.module_entry_open('orders')
    and public.can_record_order_approval(public.order_approval_evidence_order_id(name))
  );

-- ── DELETE: AN ORPHAN, AND ONLY EVER AN ORPHAN ──
--
-- The browser must upload the screenshot BEFORE it calls
-- record_order_approval_event(), because that function refuses a path naming no
-- object. So every refusal from that function — a forbidden caller, a stale
-- status, evidence sent for Not Approved — happens with a freshly uploaded file
-- already in the bucket and no row referencing it. Without a way to take that
-- file back, every failed press would leave litter in a private bucket forever.
--
-- THIS DOES NOT WEAKEN PERMANENCE, and the `not exists` clause is the whole
-- reason why. An object becomes unreachable by this policy the instant an event
-- claims it, claiming is the only thing the write path does with a path, and
-- the table it would have to be un-claimed from has no UPDATE or DELETE policy
-- and a trigger that refuses both. A FILED PROOF IS STILL PERMANENT; what can
-- be removed is a file that no approval has ever stood on.
--
-- The authority is the write authority, not the read authority: only somebody
-- who could have recorded the event may clear up after attempting it.
drop policy if exists "order_approval_evidence_delete" on storage.objects;
create policy "order_approval_evidence_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'order-approval-evidence'
    and public.module_entry_open('orders')
    and public.can_record_order_approval(public.order_approval_evidence_order_id(name))
    and not exists (
      select 1
      from public.order_approval_events e
      where e.evidence_path = storage.objects.name
    )
  );


-- ═══ 6. Did all of that take? ════════════════════════════════════════════════
--
-- A migration that half-applied is worse than one that failed, because the
-- half that applied looks like a working feature.

do $$
declare
  v_policies int;
begin
  if to_regclass('public.order_approval_events') is null then
    raise exception 'order_approval_events was not created';
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'order_approval_events'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'row security is not enabled and forced on order_approval_events';
  end if;

  -- APPEND-ONLY, CHECKED. The two verbs that must have no policy.
  select count(*) into v_policies
  from pg_policies
  where schemaname = 'public' and tablename = 'order_approval_events'
    and cmd in ('UPDATE', 'DELETE');
  if v_policies > 0 then
    raise exception 'order_approval_events has % UPDATE/DELETE policies; it must have none', v_policies;
  end if;

  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'order_approval_events'
      and grantee in ('anon', 'public')
  ) then
    raise exception 'order_approval_events is granted to anon or public';
  end if;

  if exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'order_approval_events'
      and grantee = 'authenticated' and privilege_type in ('UPDATE', 'DELETE')
  ) then
    raise exception 'order_approval_events grants UPDATE or DELETE to authenticated';
  end if;

  if not exists (
    select 1 from storage.buckets
    where id = 'order-approval-evidence' and public = false and file_size_limit = 5242880
  ) then
    raise exception 'order-approval-evidence is not private at the 5 MiB limit';
  end if;

  -- STILL NO UPDATE POLICY. Without it an x-upsert write cannot swap a file's
  -- bytes while leaving its key — and the event that names it — untouched.
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'order_approval_evidence_update'
  ) then
    raise exception 'an UPDATE policy exists on the evidence bucket; proofs would not be permanent';
  end if;

  -- THE DELETE POLICY EXISTS, AND IT CANNOT REACH A FILED PROOF. It is here so
  -- a refused write can take back the file it had to upload first. Both halves
  -- are asserted: the write authority, and the claim check that makes the
  -- difference between an orphan and evidence. A future edit that drops either
  -- one fails this migration rather than quietly making proofs deletable.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'order_approval_evidence_delete'
      and qual like '%can_record_order_approval%'
      and qual like '%order_approval_events%'
  ) then
    raise exception
      'the evidence DELETE policy is missing, or is not restricted to objects no approval event claims';
  end if;

  if to_regprocedure('public.record_order_approval_event(uuid, text, text, text)') is null then
    raise exception 'record_order_approval_event was not created';
  end if;
end;
$$;

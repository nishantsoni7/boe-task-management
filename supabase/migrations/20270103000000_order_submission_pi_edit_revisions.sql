-- ═══════════════════════════════════════════════════════════════════════════
-- 20270103000000 — One "Edit PI": an approved PI changes only as a new version
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Builds on 20270101000000 (#205): a revised PI is authorized by an Admin and
-- put in force only when the assigned Operations reviewer accepts it. Until now
-- a revision could only be a re-uploaded workbook. This adds the second kind:
-- a revision EDITED IN THE APP (client, dates, terms, products, quantities,
-- prices, photos), which travels the very same path.
--
--   1. order_pi_versions.source_kind  'workbook' | 'edit'. An edit revision
--      carries its complete proposed PI in `proposal` — built and priced by the
--      server (src/app/api/orders/pi-edits), never by the browser — including
--      the parse payload #205's staging and promotion already accept.
--      Both columns are written once, at proposal, and never again.
--
--   2. order_pi_edit_drafts  an employee's unsent Edit PI work on an approved
--      PI: private to its author, one per Order and author.
--
--   3. propose_order_pi_edit_revision()  SERVICE ROLE ONLY. The same authority,
--      reason and one-open-revision rules as propose_order_pi_revision(), for
--      an edit proposal. Nothing current changes.
--
--   4. At Operations acceptance of an EDIT revision, its terms (fabric
--      responsibility, commercial terms note, city, payment and billing terms,
--      billing %) are applied in the same transaction. #205's acceptance only
--      fills blank terms, which would silently drop an edited one.
--
--   5. The full content of the version being superseded is kept at the moment
--      #205 snapshots it, so V1 → V2 → V3 can each be read back later; and
--      order_pi_version_detail() returns what a version contained.
--
--   6. AN APPROVED PI IS CHANGED ONLY BY A VERSION. Once a PI has become an
--      Order, its client, dates, commercial figures, terms and product lines
--      refuse every write except #205's acceptance of a revision (and Test Data
--      Cleanup). The earlier admin edit doors — client details, terms, schedule
--      terms, product text, reorder, billing %, "Change PI" — keep working on a
--      PI that has not become an Order, and are refused in words on one that has.
--
-- Unchanged: who may propose (the PI's owner holding orders.create, or an
-- admin), who authorizes (an active admin), who accepts (the assigned
-- Operations reviewer), #205's amendment gate on the Order's five fields, every
-- payment, allocation and Finance rule, and every existing row.

do $$
begin
  if to_regclass('public.order_pi_revision_staged_parses') is null
     or to_regprocedure('public.decide_order_pi_revision_operations(uuid, text, text)') is null then
    raise exception 'PRECONDITION FAILED: 20270101000000 (revised PI promotes on operations acceptance) is not applied';
  end if;
end $$;


-- ─── 1. Two kinds of revision ─────────────────────────────────────────────

alter table public.order_pi_versions
  add column if not exists source_kind text not null default 'workbook',
  add column if not exists proposal    jsonb;

alter table public.order_pi_versions drop constraint if exists order_pi_versions_source_kind_check;
alter table public.order_pi_versions add constraint order_pi_versions_source_kind_check
  check (source_kind in ('workbook', 'edit'));

alter table public.order_pi_versions drop constraint if exists order_pi_versions_proposal_matches_kind;
alter table public.order_pi_versions add constraint order_pi_versions_proposal_matches_kind
  check ((source_kind = 'edit') = (proposal is not null)
         and (proposal is null or (jsonb_typeof(proposal) = 'object'
                                   and jsonb_typeof(proposal -> 'payload') = 'object')));

comment on column public.order_pi_versions.source_kind is
  'How this version was proposed: ''workbook'' (a re-uploaded PI file, parsed at Admin approval) or ''edit'' (edited in the app; its complete proposed PI is in `proposal`). 20270103000000.';
comment on column public.order_pi_versions.proposal is
  'An EDIT revision''s complete proposed PI, built and priced server-side: {payload (the parse payload #205 stages), terms, change_summary, base_version_id}. NULL for a workbook revision. Written once. 20270103000000.';

create or replace function public.order_pi_versions_kind_is_permanent()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source_kind is distinct from old.source_kind or new.proposal is distinct from old.proposal then
    raise exception 'ORDER_PI_VERSION_IMMUTABLE: what a PI version proposed cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.order_pi_versions_kind_is_permanent() from public, anon, authenticated;

drop trigger if exists order_pi_versions_kind_is_permanent on public.order_pi_versions;
create trigger order_pi_versions_kind_is_permanent
  before update of source_kind, proposal on public.order_pi_versions
  for each row execute function public.order_pi_versions_kind_is_permanent();


-- ─── 2. Unsent Edit PI work, private to its author ────────────────────────

create table if not exists public.order_pi_edit_drafts (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references public.orders(id) on delete cascade,
  submission_id   uuid not null references public.order_submissions(id) on delete cascade,
  author_id       uuid not null default auth.uid() references public.users(id),
  base_version_id uuid references public.order_pi_versions(id) on delete set null,
  -- The editor's own state (the edit, not a payload). Never trusted: the server
  -- rebuilds and re-prices everything when it is submitted.
  edit            jsonb not null check (jsonb_typeof(edit) = 'object'),
  reason          text check (reason is null or char_length(reason) <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint order_pi_edit_drafts_one_per_author unique (order_id, author_id),
  constraint order_pi_edit_drafts_size check (octet_length(edit::text) <= 1048576)
);

comment on table public.order_pi_edit_drafts is
  'An employee''s unsent Edit PI work on an approved PI (20270103000000). Private to its author; one per Order and author. Saving here changes nothing on the PI or the Order; only submitting it (propose_order_pi_edit_revision) creates a pending version.';

alter table public.order_pi_edit_drafts enable row level security;
revoke all on public.order_pi_edit_drafts from public, anon, authenticated;
grant select, insert, update, delete on public.order_pi_edit_drafts to authenticated;

-- Who may keep Edit PI work on this Order: the same people who may propose a
-- revision (an admin, or the PI's owner holding orders.create).
create or replace function public.can_propose_order_pi_edit(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.orders o
      join public.order_submissions s on s.id = o.source_order_submission_id and s.order_id = o.id
      join public.users u on u.id = auth.uid() and u.is_active and coalesce(u.is_deleted, false) = false
     where o.id = p_order_id
       and o.status <> 'cancelled'
       and s.status = 'approved'
       and (u.role = 'admin'
            or ((s.created_by = u.id or s.submitted_by = u.id)
                and public.actor_has_module_permission('orders', 'create')))
  );
$$;
revoke execute on function public.can_propose_order_pi_edit(uuid) from public, anon;
grant  execute on function public.can_propose_order_pi_edit(uuid) to authenticated;

drop policy if exists order_pi_edit_drafts_own on public.order_pi_edit_drafts;
create policy order_pi_edit_drafts_own on public.order_pi_edit_drafts
  for all to authenticated
  using (author_id = auth.uid() and public.module_entry_open('orders'))
  with check (author_id = auth.uid() and public.module_entry_open('orders')
              and public.can_propose_order_pi_edit(order_id)
              and submission_id = (select o.source_order_submission_id from public.orders o where o.id = order_id));


-- ─── 3. Proposing an edit revision ────────────────────────────────────────

create or replace function public.propose_order_pi_edit_revision(
  p_order_id  uuid,
  p_actor_id  uuid,
  p_proposal  jsonb,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin boolean;
  v_active   boolean;
  v_order    public.orders%rowtype;
  v_sub      public.order_submissions%rowtype;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_next     integer;
  v_id       uuid;
  v_payload  jsonb := p_proposal -> 'payload';
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required' using errcode = '28000';
  end if;

  select u.role = 'admin', u.is_active and coalesce(u.is_deleted, false) = false
    into v_is_admin, v_active
    from public.users u where u.id = p_actor_id;
  if not coalesce(v_active, false) then
    raise exception 'You do not have permission to propose a revised PI' using errcode = '42501';
  end if;

  -- The permission engine answers for the actor, exactly as it would for them
  -- in the browser: claims set for this transaction only.
  perform set_config('request.jwt.claims', json_build_object('sub', p_actor_id, 'role', 'authenticated')::text, true);
  if not (coalesce(v_is_admin, false) or public.actor_has_module_permission('orders', 'create')) then
    raise exception 'You do not have permission to propose a revised PI' using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'ORDER_PI_REVISION_REASON_REQUIRED: say why the PI is being revised' using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'ORDER_PI_REVISION_REASON_TOO_LONG: the reason may be at most 500 characters (this one is %)',
      char_length(v_reason) using errcode = 'P0001';
  end if;

  if p_proposal is null or jsonb_typeof(p_proposal) <> 'object' or jsonb_typeof(v_payload) <> 'object'
     or jsonb_typeof(v_payload -> 'items') <> 'array' or jsonb_array_length(v_payload -> 'items') = 0
     or jsonb_typeof(v_payload -> 'seed_terms') <> 'object' then
    raise exception 'ORDER_PI_EDIT_INVALID: the proposed PI is incomplete' using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled and cannot take a revised PI', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = v_order.source_order_submission_id for update;
  if not found or v_sub.status <> 'approved' or v_sub.order_id is distinct from v_order.id then
    raise exception 'ORDER_PI_REVISION_INVALID: the PI behind Order % is not in an approvable state', v_order.display_number
      using errcode = 'P0001';
  end if;
  if not (coalesce(v_is_admin, false) or v_sub.created_by = p_actor_id or v_sub.submitted_by = p_actor_id) then
    raise exception 'ORDER_PI_REVISION_NOT_OWNER: only the person who owns this PI, or an administrator, may propose a revision'
      using errcode = '42501';
  end if;
  if v_sub.deletion_claim_token is not null then
    raise exception 'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion' using errcode = '55P03';
  end if;

  -- The proposal keeps the ORIGINAL uploaded workbook as its source: an edit
  -- does not produce a new file, and #205's staging checks exactly this.
  if (v_payload -> 'source' ->> 'workbook_path') is distinct from v_sub.source_workbook_path then
    raise exception 'ORDER_PI_EDIT_STALE: the PI changed while this edit was being made. Reload and edit again.'
      using errcode = 'P0001';
  end if;

  -- One open revision per Order, whatever its kind (pending or awaiting
  -- Operations) — said in words, before the unique index says it in code.
  if exists (select 1 from public.order_pi_versions v
              where v.order_id = v_order.id and v.status in ('pending', 'admin_approved')) then
    raise exception 'ORDER_PI_REVISION_PENDING: a revised PI is already waiting for a decision on Order %', v_order.display_number
      using errcode = 'P0001';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next
    from public.order_pi_versions where order_id = v_order.id;

  insert into public.order_pi_versions (
    order_id, submission_id, version_number, status,
    workbook_path, workbook_name, workbook_sha256,
    uploaded_by, uploaded_at, revision_reason, source_kind, proposal
  ) values (
    v_order.id, v_sub.id, v_next, 'pending',
    v_sub.source_workbook_path, v_sub.source_workbook_name, v_sub.source_workbook_sha256,
    p_actor_id, now(), v_reason, 'edit', p_proposal
  )
  returning id into v_id;

  -- The author's unsent draft has become this version.
  delete from public.order_pi_edit_drafts where order_id = v_order.id and author_id = p_actor_id;

  perform public.log_order_submission_activity(
    v_sub.id, p_actor_id, 'pi_revision_proposed', 'approved', 'approved', v_reason,
    jsonb_build_object('order_id', v_order.id, 'version_id', v_id, 'version_number', v_next, 'source_kind', 'edit')
  );
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, p_actor_id, 'pi_revision_proposed',
          jsonb_build_object('version_id', v_id, 'version_number', v_next, 'reason', v_reason,
                             'source_kind', 'edit', 'change_summary', p_proposal -> 'change_summary'));

  return jsonb_build_object('version_id', v_id, 'version_number', v_next, 'order_id', v_order.id, 'status', 'pending');
end;
$$;

comment on function public.propose_order_pi_edit_revision(uuid, uuid, jsonb, text) is
  'SERVICE ROLE ONLY (the Edit PI route builds and prices the proposal). Records an in-app edit of an approved PI as a PENDING version: same authority, reason and one-open-revision rules as propose_order_pi_revision(). Changes nothing current: the approved PI stays in force until an Admin authorizes and the Operations reviewer accepts the revision (20270101000000). 20270103000000.';

revoke execute on function public.propose_order_pi_edit_revision(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant  execute on function public.propose_order_pi_edit_revision(uuid, uuid, jsonb, text) to service_role;


-- ─── 4. An accepted EDIT revision's terms are applied with it ─────────────

create or replace function public.order_pi_versions_apply_edit_terms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  t        jsonb := new.proposal -> 'terms';
  v_prev   text := coalesce(current_setting('boe.pi_revision_apply', true), '');
  v_amend  text := coalesce(current_setting('boe.amendment_context', true), '');
  v_billing numeric;
  v_order  uuid;
begin
  if new.source_kind <> 'edit' or t is null or jsonb_typeof(t) <> 'object' then return new; end if;

  perform set_config('boe.pi_revision_apply', new.submission_id::text, true);
  update public.order_submissions s set
    fabric_responsibility = case when t ? 'fabric_responsibility'
                                 then nullif(t ->> 'fabric_responsibility', '') else s.fabric_responsibility end,
    commercial_terms_note = case when t ? 'commercial_terms_note'
                                 then nullif(btrim(t ->> 'commercial_terms_note'), '') else s.commercial_terms_note end,
    client_city           = case when t ? 'client_city'
                                 then nullif(btrim(t ->> 'client_city'), '') else s.client_city end,
    payment_terms         = case when t ? 'payment_terms'
                                 then nullif(btrim(t ->> 'payment_terms'), '') else s.payment_terms end,
    billing_terms         = case when t ? 'billing_terms'
                                 then nullif(btrim(t ->> 'billing_terms'), '') else s.billing_terms end,
    billing_percentage    = case when t ? 'billing_percentage'
                                 then nullif(t ->> 'billing_percentage', '')::numeric else s.billing_percentage end
   where s.id = new.submission_id
  returning s.billing_percentage, s.order_id into v_billing, v_order;

  -- The Order mirrors the billing percentage, as every other writer of it does.
  if v_order is not null then
    perform set_config('boe.amendment_context', 'order_amendment', true);
    update public.orders o set billing_percentage = v_billing, updated_at = now()
     where o.id = v_order and o.billing_percentage is distinct from v_billing;
    perform set_config('boe.amendment_context', v_amend, true);
  end if;
  perform set_config('boe.pi_revision_apply', v_prev, true);
  return new;
end;
$$;
revoke execute on function public.order_pi_versions_apply_edit_terms() from public, anon, authenticated, service_role;

drop trigger if exists order_pi_versions_apply_edit_terms on public.order_pi_versions;
create trigger order_pi_versions_apply_edit_terms
  after update of status on public.order_pi_versions
  for each row
  when (old.status = 'admin_approved' and new.status = 'approved' and new.source_kind = 'edit')
  execute function public.order_pi_versions_apply_edit_terms();


-- ─── 5. What each version contained ───────────────────────────────────────

create table if not exists public.order_pi_version_contents (
  version_id  uuid primary key references public.order_pi_versions(id) on delete cascade,
  content     jsonb not null check (jsonb_typeof(content) = 'object'),
  captured_at timestamptz not null default now()
);
comment on table public.order_pi_version_contents is
  'The complete content (header, commercial figures, terms, product lines and pictures) of a PI version at the moment a later version replaced it — captured when #205 snapshots it, before the replacement is written. Read through order_pi_version_detail(). Never edited. 20270103000000.';
alter table public.order_pi_version_contents enable row level security;
revoke all on public.order_pi_version_contents from public, anon, authenticated;

-- The PI's content columns, the set every reader and the guard below share.
create or replace function public.order_pi_content_keys()
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array[
    'client_name', 'creation_date', 'source_created_by', 'boe_gst', 'contact_number',
    'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address', 'ship_to_name', 'ship_to_phone',
    'ship_to_gst', 'shipping_address', 'order_confirmation_date', 'dispatch_commitment', 'due_date',
    'source_workbook_path', 'source_workbook_name', 'source_workbook_sha256',
    'gross_product_amount', 'discount_amount', 'subtotal_after_discount', 'fabric_cost', 'fabric_cost_meaning',
    'fabric_cost_text', 'packing_cost', 'packing_cost_meaning', 'packing_cost_text', 'transportation_amount',
    'transportation_text', 'total_before_gst', 'gst_amount', 'grand_total', 'billing_percentage',
    'fabric_responsibility', 'commercial_terms_note', 'client_city', 'payment_terms', 'billing_terms']::text[]
$$;

create or replace function public.order_pi_content_of(p_submission_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'submission', (select jsonb_object_agg(k, to_jsonb(s) -> k)
                     from public.order_submissions s, unnest(public.order_pi_content_keys()) k
                    where s.id = p_submission_id),
    'items',  coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order, i.source_row)
                          from public.order_submission_items i where i.submission_id = p_submission_id), '[]'::jsonb),
    'images', coalesce((select jsonb_agg(to_jsonb(m) order by m.item_id, m.role, m.position)
                          from public.order_submission_item_images m where m.submission_id = p_submission_id), '[]'::jsonb))
$$;
revoke execute on function public.order_pi_content_of(uuid) from public, anon, authenticated;

-- #205 writes superseded_snapshot immediately BEFORE applying the new parse;
-- the submission still holds the outgoing version, so it is captured here.
create or replace function public.order_pi_revision_capture_outgoing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_outgoing uuid := nullif(new.superseded_snapshot ->> 'version_id', '')::uuid;
begin
  if v_outgoing is not null then
    insert into public.order_pi_version_contents (version_id, content)
    values (v_outgoing, public.order_pi_content_of(new.submission_id))
    on conflict (version_id) do nothing;
  end if;
  return new;
end;
$$;
revoke execute on function public.order_pi_revision_capture_outgoing() from public, anon, authenticated, service_role;

drop trigger if exists order_pi_revision_capture_outgoing on public.order_pi_revision_staged_parses;
create trigger order_pi_revision_capture_outgoing
  after update of superseded_snapshot on public.order_pi_revision_staged_parses
  for each row
  when (old.superseded_snapshot is null and new.superseded_snapshot is not null)
  execute function public.order_pi_revision_capture_outgoing();

-- What a version contained, for anybody who may open the Order.
--   edit revision          its proposal (what was proposed IS what it contains)
--   the current version    'live' — read the PI itself
--   a replaced version     the content captured when it was replaced; for one
--                          replaced before this migration, #205's snapshot
--                          (lines and Order figures only)
--   a workbook revision    its staged parse once an Admin authorized it;
--                          before that only its file exists
create or replace function public.order_pi_version_detail(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v   public.order_pi_versions%rowtype;
  v_c jsonb;
begin
  select * into v from public.order_pi_versions where id = p_version_id;
  if not found or not coalesce(public.can_view_order(v.order_id), false) then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  if v.source_kind = 'edit' then
    return jsonb_build_object('source', 'proposal', 'content', v.proposal);
  end if;
  if v.status = 'approved' then
    return jsonb_build_object('source', 'live', 'content', null);
  end if;
  select content into v_c from public.order_pi_version_contents where version_id = v.id;
  if v_c is not null then
    return jsonb_build_object('source', 'captured', 'content', v_c);
  end if;
  if v.status = 'superseded' then
    select sp.superseded_snapshot into v_c from public.order_pi_revision_staged_parses sp
     where sp.version_id = v.superseded_by_version_id;
    return jsonb_build_object('source', case when v_c is null then 'none' else 'snapshot' end, 'content', v_c);
  end if;
  select sp.payload - 'processing_token' into v_c from public.order_pi_revision_staged_parses sp where sp.version_id = v.id;
  return jsonb_build_object('source', case when v_c is null then 'none' else 'staged' end,
                            'content', case when v_c is null then null else jsonb_build_object('payload', v_c) end);
end;
$$;
comment on function public.order_pi_version_detail(uuid) is
  'What one PI version contained, for anybody who may open its Order: {source: proposal | live | captured | snapshot | staged | none, content}. Read-only. 20270103000000.';
revoke execute on function public.order_pi_version_detail(uuid) from public, anon;
grant  execute on function public.order_pi_version_detail(uuid) to authenticated;


-- ─── 6. An approved PI is changed only by a version ───────────────────────

create or replace function public.order_pi_is_versioned_write_allowed(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.in_test_data_cleanup()
      or coalesce(current_setting('boe.pi_revision_apply', true), '') = p_submission_id::text
      or coalesce(current_setting('boe.pi_submission_approval_id', true), '') = p_submission_id::text
$$;
revoke execute on function public.order_pi_is_versioned_write_allowed(uuid) from public, anon, authenticated;

create or replace function public.order_submissions_approved_pi_is_versioned()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k text;
begin
  -- Only a PI that has already become an Order.
  if old.order_id is null or old.status <> 'approved' then return new; end if;
  if public.order_pi_is_versioned_write_allowed(new.id) then return new; end if;
  -- While a revision awaits Operations, #205's freeze refuses the same edit in
  -- its own, more specific words; this guard steps aside so that is the one
  -- a person reads.
  if public.order_submission_has_revision_awaiting_operations(new.id) then return new; end if;
  foreach k in array public.order_pi_content_keys() loop
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION: this PI is approved and in force on an Order. Use Edit PI to propose a new version; the current one stays in force until the new one is approved.'
        using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function public.order_submissions_approved_pi_is_versioned() from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_approved_pi_is_versioned on public.order_submissions;
create trigger order_submissions_approved_pi_is_versioned
  before update on public.order_submissions
  for each row execute function public.order_submissions_approved_pi_is_versioned();

create or replace function public.order_submission_lines_approved_pi_is_versioned()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub uuid := case when tg_op = 'DELETE' then old.submission_id else new.submission_id end;
begin
  if not exists (select 1 from public.order_submissions s
                  where s.id = v_sub and s.order_id is not null and s.status = 'approved') then
    return coalesce(new, old);
  end if;
  if public.order_pi_is_versioned_write_allowed(v_sub) then return coalesce(new, old); end if;
  -- #205's freeze answers for lines while a revision awaits Operations.
  if tg_table_name = 'order_submission_items'
     and public.order_submission_has_revision_awaiting_operations(v_sub) then return coalesce(new, old); end if;
  raise exception 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION: this PI is approved and in force on an Order. Use Edit PI to propose a new version; the current one stays in force until the new one is approved.'
    using errcode = 'P0001';
end;
$$;
revoke execute on function public.order_submission_lines_approved_pi_is_versioned() from public, anon, authenticated, service_role;

drop trigger if exists order_submission_items_approved_pi_is_versioned on public.order_submission_items;
create trigger order_submission_items_approved_pi_is_versioned
  before insert or update or delete on public.order_submission_items
  for each row execute function public.order_submission_lines_approved_pi_is_versioned();

drop trigger if exists order_submission_item_images_approved_pi_is_versioned on public.order_submission_item_images;
create trigger order_submission_item_images_approved_pi_is_versioned
  before insert or update or delete on public.order_submission_item_images
  for each row execute function public.order_submission_lines_approved_pi_is_versioned();


-- ─── 7. Assertions ────────────────────────────────────────────────────────

do $assert$
begin
  if exists (select 1 from public.order_pi_versions where source_kind <> 'workbook' or proposal is not null) then
    raise exception 'ASSERTION FAILED: an existing version was given a kind or a proposal';
  end if;
  if has_function_privilege('authenticated', 'public.propose_order_pi_edit_revision(uuid, uuid, jsonb, text)', 'EXECUTE') then
    raise exception 'ASSERTION FAILED: the browser can propose an edit revision without the server';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'order_submissions_approved_pi_is_versioned')
     or not exists (select 1 from pg_trigger where tgname = 'order_submission_items_approved_pi_is_versioned')
     or not exists (select 1 from pg_trigger where tgname = 'order_pi_versions_apply_edit_terms') then
    raise exception 'ASSERTION FAILED: a trigger this migration installs is missing';
  end if;
end
$assert$;

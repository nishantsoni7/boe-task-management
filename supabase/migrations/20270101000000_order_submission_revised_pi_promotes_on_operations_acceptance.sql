-- ═══════════════════════════════════════════════════════════════════════════
-- A revised PI (V2+) is STAGED at Admin approval and PROMOTED only when the
-- assigned Operations reviewer accepts it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE INVARIANT
--
-- Admin approval AUTHORIZES a proposed PI. Until the assigned operations
-- reviewer accepts it, the accepted PI and everything read from it stay
-- current: the version in force (V1 stays 'approved'), the product lines and
-- their pictures (order_submission_items / _item_images), the Order's figures
-- and dates, the generated documents, the BOE item codes, production alignment
-- and V1's operations handoff. Rejection leaves all of those exactly as they
-- were.
--
--   propose_order_pi_revision()              V2 'pending'                (unchanged)
--   approve_order_pi_revision()  — admin     V2 'admin_approved'; the server's
--     (route: /api/orders/pi-revisions/      parse is STORED in
--      approve, staging mode)                order_pi_revision_staged_parses;
--                                            nothing current moves
--   decide_order_pi_revision_operations()    'rejected' — nothing moves
--     — the assigned reviewer                'accepted' — ONE transaction:
--                                              amendment gate → lease → the
--                                              existing parse writer with the
--                                              staged payload → V1 superseded,
--                                              V2 approved (the existing
--                                              trigger records V2's handoff) →
--                                              the existing handoff decision
--                                              accepts it → codes → release
--
-- THE AMENDMENT RULE
--
-- The five amendable Order fields — client name, confirm date, due date, Order
-- value, product value — change ONLY through the existing amendment process
-- (amend_order, or Request a Change → approve_order_change_request). If the
-- staged V2 differs from the Order on any of them, acceptance is refused with
-- ORDER_PI_REVISION_AMENDMENT_REQUIRED naming each difference; once the Order
-- has been amended to V2's values, acceptance proceeds. Acceptance itself never
-- writes those five fields: the parse writer's own write is restored to the
-- reconciled values in the same transaction. Product lines, pictures and the
-- billing percentage have no amendment process: they are shown to the reviewer
-- (order_pi_revision_differences) and accepting V2 is the explicit decision
-- that applies them.
--
-- WHAT IS REUSED, UNCHANGED: replace_order_submission_parse,
-- begin/finish_order_submission_processing, seed_order_submission_pi_terms,
-- assign_order_product_codes, order_pi_versions_record_operations_handoff and
-- decide_order_operations_handoff. RE-EMITTED: approve_order_pi_revision
-- (staging instead of applying) and order_pi_versions_guard (the new status).
--
-- OLD PATHS: pending → approved is no longer a legal transition, so no caller
-- — including a stale deployment of the old route — can put a revision in
-- force without the operations decision. Versions approved before this
-- migration are untouched.
--
-- LOCK ORDER on every path: order_operations_reviewers (SHARE; FOR UPDATE in a
-- reassignment) → orders → order_submissions → order_pi_versions → handoffs.

-- ═══ 1. Schema ═════════════════════════════════════════════════════════════

alter table public.order_pi_versions
  add column if not exists operations_reviewer   uuid references public.users(id),
  add column if not exists operations_decided_by uuid references public.users(id),
  add column if not exists operations_decided_at timestamptz,
  add column if not exists operations_reason     text,
  add column if not exists applied_at            timestamptz;

alter table public.order_pi_versions drop constraint if exists order_pi_versions_operations_reason_length;
alter table public.order_pi_versions add constraint order_pi_versions_operations_reason_length
  check (coalesce(char_length(operations_reason), 0) <= 1000);

alter table public.order_pi_versions drop constraint if exists order_pi_versions_status_check;
alter table public.order_pi_versions add constraint order_pi_versions_status_check
  check (status in ('pending', 'admin_approved', 'approved', 'rejected', 'superseded'));

alter table public.order_pi_versions drop constraint if exists order_pi_versions_decision_complete;
alter table public.order_pi_versions add constraint order_pi_versions_decision_complete check (
  (status = 'pending' and decided_by is null and decided_at is null)
  or (status in ('admin_approved', 'approved', 'superseded') and decided_by is not null and decided_at is not null)
  or (status = 'rejected' and decided_by is not null and decided_at is not null
      and nullif(btrim(coalesce(decision_reason, '')), '') is not null)
);

-- ONE OPEN REVISION PER ORDER: pending OR awaiting operations.
drop index if exists public.order_pi_versions_one_pending_per_order;
create unique index order_pi_versions_one_pending_per_order
  on public.order_pi_versions (order_id) where status in ('pending', 'admin_approved');

create table if not exists public.order_pi_revision_staged_parses (
  version_id          uuid primary key references public.order_pi_versions(id) on delete cascade,
  submission_id       uuid not null references public.order_submissions(id) on delete cascade,
  payload             jsonb not null check (jsonb_typeof(payload) = 'object'),
  staged_by           uuid not null references public.users(id),
  staged_at           timestamptz not null default now(),
  -- What was in force the moment V2 was applied: V1's lines and pictures and
  -- the Order's figures. V1's rows are replaced by the parse; this keeps them.
  superseded_snapshot jsonb,
  applied_at          timestamptz,
  applied_by          uuid references public.users(id)
);
comment on table public.order_pi_revision_staged_parses is
  'The server''s parse of a revised PI workbook, stored when an admin approves the revision and applied — unchanged — only when the assigned operations reviewer accepts it. Keeps a snapshot of the lines and figures it replaced. Written only by approve_order_pi_revision and decide_order_pi_revision_operations.';

create or replace function public.order_pi_revision_staged_parses_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then return old; end if;
    raise exception 'ORDER_PI_REVISION_STAGE_IMMUTABLE: a staged revision cannot be deleted' using errcode = '42501';
  end if;
  -- Only the one-time application may be recorded; the payload never changes.
  if new.version_id is distinct from old.version_id or new.submission_id is distinct from old.submission_id
     or new.payload is distinct from old.payload or new.staged_by is distinct from old.staged_by
     or new.staged_at is distinct from old.staged_at or old.applied_at is not null then
    raise exception 'ORDER_PI_REVISION_STAGE_IMMUTABLE: a staged revision is written once and applied once' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.order_pi_revision_staged_parses_guard() from public, anon, authenticated, service_role;
drop trigger if exists order_pi_revision_staged_parses_guard on public.order_pi_revision_staged_parses;
create trigger order_pi_revision_staged_parses_guard
  before update or delete on public.order_pi_revision_staged_parses
  for each row execute function public.order_pi_revision_staged_parses_guard();

alter table public.order_pi_revision_staged_parses enable row level security;
revoke all on table public.order_pi_revision_staged_parses from public, anon, authenticated;
-- No client read: the payload carries storage keys. The reviewer reads the
-- differences through order_pi_revision_differences().


-- ═══ 2. order_pi_versions_guard, re-emitted with the new status ════════════
--
-- As 20261119000000 left it, except:
--   * pending → approved is REMOVED (the old immediate path);
--   * pending → admin_approved; admin_approved → rejected;
--   * admin_approved → approved ONLY inside the operations acceptance
--     (boe.pi_revision_apply = this version's submission);
--   * the reviewer of an admin_approved version may be readdressed (§7);
--   * the operations_* columns are written only with those transitions.

create or replace function public.order_pi_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then
      return old;
    end if;
    raise exception
      'ORDER_PI_VERSION_IMMUTABLE: PI version history cannot be deleted'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      return new;
    end if;
    if new.status = 'approved' and new.version_number = 1
       and public.in_pi_submission_approval(new.submission_id) then
      return new;
    end if;
    raise exception
      'ORDER_PI_VERSION_INVALID: a PI version is created pending, or as V1 by approving the PI'
      using errcode = '42501';
  end if;

  if new.order_id        is distinct from old.order_id
     or new.submission_id  is distinct from old.submission_id
     or new.version_number is distinct from old.version_number
     or new.workbook_path  is distinct from old.workbook_path
     or new.workbook_name  is distinct from old.workbook_name
     or new.uploaded_by    is distinct from old.uploaded_by
     or new.uploaded_at    is distinct from old.uploaded_at
     or new.revision_reason is distinct from old.revision_reason
     or new.created_at     is distinct from old.created_at then
    raise exception
      'ORDER_PI_VERSION_IMMUTABLE: the identity and document of PI version % cannot be changed', old.id
      using errcode = '42501';
  end if;

  if new.status is not distinct from old.status then
    -- A standing decision cannot be re-worded either.
    if old.status <> 'pending'
       and (new.decided_by is distinct from old.decided_by
            or new.decided_at is distinct from old.decided_at
            or new.decision_reason is distinct from old.decision_reason
            or new.operations_decided_by is distinct from old.operations_decided_by
            or new.operations_decided_at is distinct from old.operations_decided_at
            or new.operations_reason is distinct from old.operations_reason
            or new.applied_at is distinct from old.applied_at) then
      raise exception
        'ORDER_PI_VERSION_IMMUTABLE: the decision on PI version % cannot be rewritten', old.id
        using errcode = '42501';
    end if;
    if new.operations_reviewer is distinct from old.operations_reviewer and old.status <> 'admin_approved' then
      raise exception
        'ORDER_PI_VERSION_IMMUTABLE: only a revision awaiting operations can be readdressed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status = 'rejected' then
    return new;
  end if;
  if old.status = 'pending' and new.status = 'admin_approved' then
    return new;
  end if;
  if old.status = 'admin_approved' and new.status = 'rejected'
     and new.operations_decided_at is not null then
    return new;
  end if;
  if old.status = 'admin_approved' and new.status = 'approved'
     and current_setting('boe.pi_revision_apply', true) = new.submission_id::text
     and new.operations_decided_at is not null then
    return new;
  end if;
  if old.status = 'approved' and new.status = 'superseded' then
    return new;
  end if;

  raise exception
    'ORDER_PI_VERSION_TRANSITION_INVALID: PI version % cannot move from % to %',
    old.id, old.status, new.status
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_pi_versions_guard()
  from public, anon, authenticated, service_role;


-- ═══ 3. While a revision awaits operations, the PI it would replace is frozen
--
-- The staged payload will overwrite the submission's parse-owned columns and
-- every product line when it is applied. An edit made in between (client
-- details, a line description, the terms, the billing percentage, a "Change
-- PI" upload) would be silently lost — so it is refused, in words, until the
-- revision is decided. The lease columns and timestamps stay writable.

create or replace function public.order_submission_has_revision_awaiting_operations(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.order_pi_versions v
                  where v.submission_id = p_submission_id and v.status = 'admin_approved');
$$;
revoke execute on function public.order_submission_has_revision_awaiting_operations(uuid) from public, anon;
grant  execute on function public.order_submission_has_revision_awaiting_operations(uuid) to authenticated;

create or replace function public.order_submissions_frozen_while_revision_awaits()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keys text[] := array[
    'parse_fingerprint', 'client_name', 'creation_date', 'source_created_by', 'boe_gst', 'contact_number',
    'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address', 'ship_to_name', 'ship_to_phone',
    'ship_to_gst', 'shipping_address', 'order_confirmation_date', 'dispatch_commitment', 'due_date',
    'source_order_number', 'source_workbook_path', 'source_workbook_name', 'source_workbook_size_bytes',
    'source_workbook_sha256', 'template_version', 'parse_warnings', 'parse_blocking_issues',
    'gross_product_amount', 'discount_amount', 'subtotal_after_discount', 'fabric_cost', 'fabric_cost_meaning',
    'fabric_cost_text', 'packing_cost', 'packing_cost_meaning', 'packing_cost_text', 'transportation_amount',
    'transportation_text', 'total_before_gst', 'gst_amount', 'grand_total', 'billing_percentage',
    'fabric_responsibility', 'commercial_terms_note', 'client_city'];
  k text;
begin
  if public.in_test_data_cleanup() then return new; end if;
  if current_setting('boe.pi_revision_apply', true) = new.id::text then return new; end if;
  if not public.order_submission_has_revision_awaiting_operations(new.id) then return new; end if;
  foreach k in array v_keys loop
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'ORDER_PI_REVISION_AWAITING_OPERATIONS: a revised PI for this Order is awaiting operations acceptance; the PI cannot be edited until it is accepted or rejected'
        using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function public.order_submissions_frozen_while_revision_awaits() from public, anon, authenticated, service_role;
drop trigger if exists order_submissions_frozen_while_revision_awaits on public.order_submissions;
create trigger order_submissions_frozen_while_revision_awaits
  before update on public.order_submissions
  for each row execute function public.order_submissions_frozen_while_revision_awaits();

create or replace function public.order_submission_items_frozen_while_revision_awaits()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub uuid := case when tg_op = 'DELETE' then old.submission_id else new.submission_id end;
begin
  if public.in_test_data_cleanup() then return coalesce(new, old); end if;
  if current_setting('boe.pi_revision_apply', true) = v_sub::text then return coalesce(new, old); end if;
  if public.order_submission_has_revision_awaiting_operations(v_sub) then
    raise exception 'ORDER_PI_REVISION_AWAITING_OPERATIONS: a revised PI for this Order is awaiting operations acceptance; its product lines cannot be edited until it is accepted or rejected'
      using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end;
$$;
revoke execute on function public.order_submission_items_frozen_while_revision_awaits() from public, anon, authenticated, service_role;
drop trigger if exists order_submission_items_frozen_while_revision_awaits on public.order_submission_items;
create trigger order_submission_items_frozen_while_revision_awaits
  before insert or update or delete on public.order_submission_items
  for each row execute function public.order_submission_items_frozen_while_revision_awaits();


-- ═══ 4. The commercial differences between a staged V2 and the Order ══════

-- The five amendable fields, as the parse writer would leave them (it keeps
-- the Order's client name and confirm date when the PI has none; a PI with no
-- dispatch date is treated as "no change" and never wipes the Order's).
create or replace function public.order_pi_revision_blocking_differences(p_payload jsonb, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o     public.orders%rowtype;
  h     jsonb := coalesce(p_payload -> 'header', '{}'::jsonb);
  c     jsonb := coalesce(p_payload -> 'commercial', '{}'::jsonb);
  v_client  text := nullif(btrim(coalesce(h ->> 'client_name', '')), '');
  v_confirm date := nullif(h ->> 'order_confirmation_date', '')::date;
  v_due     date := nullif(h ->> 'due_date', '')::date;
  v_total   numeric := nullif(c ->> 'grand_total', '')::numeric;
  v_product numeric := coalesce(nullif(c ->> 'gross_product_amount', '')::numeric, 0);
  out   jsonb := '[]'::jsonb;
begin
  select * into o from public.orders where id = p_order_id;
  if v_client is not null and v_client is distinct from o.client_name then
    out := out || jsonb_build_object('field', 'client_name', 'label', 'Client', 'order_value', o.client_name, 'pi_value', v_client);
  end if;
  if v_confirm is not null and v_confirm is distinct from o.confirm_date then
    out := out || jsonb_build_object('field', 'confirm_date', 'label', 'Confirm date', 'order_value', o.confirm_date, 'pi_value', v_confirm);
  end if;
  if v_due is not null and v_due is distinct from o.due_date then
    out := out || jsonb_build_object('field', 'due_date', 'label', 'Due date', 'order_value', o.due_date, 'pi_value', v_due);
  end if;
  if v_total is distinct from o.total_value then
    out := out || jsonb_build_object('field', 'total_value', 'label', 'Order value', 'order_value', o.total_value, 'pi_value', v_total);
  end if;
  if v_product is distinct from o.total_product_value then
    out := out || jsonb_build_object('field', 'total_product_value', 'label', 'Product value', 'order_value', o.total_product_value, 'pi_value', v_product);
  end if;
  return out;
end;
$$;
revoke execute on function public.order_pi_revision_blocking_differences(jsonb, uuid) from public, anon, authenticated, service_role;

-- What the reviewer (and anyone who can open the Order) is shown.
create or replace function public.order_pi_revision_differences(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v   public.order_pi_versions%rowtype;
  s   public.order_pi_revision_staged_parses%rowtype;
  sub public.order_submissions%rowtype;
  v_lines jsonb;
begin
  select * into v from public.order_pi_versions where id = p_version_id;
  if not found or not public.can_view_order_as_actor(v.order_id) then
    raise exception 'You do not have access to this Order' using errcode = '42501';
  end if;
  select * into s from public.order_pi_revision_staged_parses where version_id = p_version_id;
  if not found then
    return jsonb_build_object('staged', false);
  end if;
  select * into sub from public.order_submissions where id = v.submission_id;

  with new_lines as (
    select coalesce(nullif(btrim(i ->> 'item_sequence'), ''), '#' || (i ->> 'source_row')) as seq,
           nullif(btrim(i ->> 'product_name'), '') as name,
           (i ->> 'quantity')::numeric as qty, (i ->> 'cost_per_piece')::numeric as rate,
           (i ->> 'total_amount')::numeric as total
      from jsonb_array_elements(coalesce(s.payload -> 'items', '[]'::jsonb)) i
  ), old_lines as (
    select coalesce(item_sequence, '#' || source_row) as seq, product_name as name,
           quantity as qty, cost_per_piece as rate, total_amount as total
      from public.order_submission_items where submission_id = v.submission_id
  )
  select jsonb_build_object(
    'added',   coalesce((select jsonb_agg(jsonb_build_object('seq', n.seq, 'name', n.name, 'qty', n.qty, 'rate', n.rate, 'total', n.total) order by n.seq)
                          from new_lines n where not exists (select 1 from old_lines o where o.seq = n.seq)), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(jsonb_build_object('seq', o.seq, 'name', o.name, 'qty', o.qty, 'rate', o.rate, 'total', o.total) order by o.seq)
                          from old_lines o where not exists (select 1 from new_lines n where n.seq = o.seq)), '[]'::jsonb),
    'changed', coalesce((select jsonb_agg(jsonb_build_object('seq', n.seq, 'name', n.name,
                                  'from', jsonb_build_object('name', o.name, 'qty', o.qty, 'rate', o.rate, 'total', o.total),
                                  'to',   jsonb_build_object('name', n.name, 'qty', n.qty, 'rate', n.rate, 'total', n.total)) order by n.seq)
                          from new_lines n join old_lines o on o.seq = n.seq
                         where (n.name, n.qty, n.rate, n.total) is distinct from (o.name, o.qty, o.rate, o.total)), '[]'::jsonb)
  ) into v_lines;

  return jsonb_build_object(
    'staged', true,
    'blocking', public.order_pi_revision_blocking_differences(s.payload, v.order_id),
    'lines', v_lines,
    'billing_percentage', jsonb_build_object('order', sub.billing_percentage,
                                             'pi', nullif(s.payload -> 'commercial' ->> 'billing_percentage', '')),
    'applied', s.applied_at is not null
  );
end;
$$;
revoke execute on function public.order_pi_revision_differences(uuid) from public, anon;
grant  execute on function public.order_pi_revision_differences(uuid) to authenticated;


-- ═══ 5. approve_order_pi_revision, re-emitted: STAGE, do not apply ═════════
--
-- Word for word from 20261229000000 through the file-mismatch check: the same
-- admin, payload, lock-order, state, staleness and file checks. What changed is
-- everything after them: the parse is stored, the version becomes
-- 'admin_approved', the reviewer is addressed and told. Nothing current moves.

create or replace function public.approve_order_pi_revision(
  p_version_id uuid,
  p_actor_id   uuid,
  p_payload    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin  boolean;
  v_ver       public.order_pi_versions%rowtype;
  v_current   public.order_pi_versions%rowtype;
  v_order     public.orders%rowtype;
  v_sub       public.order_submissions%rowtype;
  v_path      text;
  v_now       timestamptz := now();
  v_reviewer  uuid;
  v_name      text;
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required'
      using errcode = '28000';
  end if;

  select coalesce(u.role = 'admin', false) into v_is_admin
  from public.users u
  where u.id = p_actor_id and u.is_active and coalesce(u.is_deleted, false) = false;
  if not found or not coalesce(v_is_admin, false) then
    raise exception 'You do not have permission to decide a revised PI'
      using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id;
  if not found then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  select user_id into v_reviewer from public.order_operations_reviewers where duty = 'pi_handoff' for share;

  select * into v_order from public.orders where id = v_ver.order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception
      'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled and cannot take a revised PI', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = v_ver.submission_id for update;
  if not found or v_sub.order_id is distinct from v_order.id then
    raise exception
      'ORDER_PI_REVISION_INVALID: the PI behind Order % is not the one this version names', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  if v_ver.status <> 'pending' then
    raise exception
      'ORDER_PI_REVISION_NOT_PENDING: PI version % is % and is no longer waiting for a decision',
      v_ver.version_number, v_ver.status
      using errcode = 'P0001';
  end if;

  select * into v_current from public.order_pi_versions
  where order_id = v_order.id and status = 'approved' for update;

  if v_current.id is not null and v_current.version_number >= v_ver.version_number then
    raise exception
      'ORDER_PI_REVISION_STALE: PI version % is older than the current approved version %',
      v_ver.version_number, v_current.version_number
      using errcode = 'P0001';
  end if;

  v_path := nullif(btrim(coalesce(p_payload -> 'source' ->> 'workbook_path', '')), '');
  if v_path is null or v_path is distinct from v_ver.workbook_path then
    raise exception
      'ORDER_PI_REVISION_FILE_MISMATCH: the parsed workbook is not the file this revision proposed'
      using errcode = 'P0001';
  end if;

  -- ── STAGE (new) ──
  -- The processing token is the route's lease for THIS request; a new one is
  -- taken when the payload is applied.
  insert into public.order_pi_revision_staged_parses (version_id, submission_id, payload, staged_by)
  values (v_ver.id, v_sub.id, p_payload - 'processing_token', p_actor_id);

  -- The reviewer, if they can open this Order; otherwise it waits unassigned.
  if v_reviewer is not null and not (
       exists (select 1 from public.users u where u.id = v_reviewer and u.is_active and coalesce(u.is_deleted, false) = false)
       and public.operations_reviewer_can_open_order(v_reviewer, v_order.id)) then
    v_reviewer := null;
  end if;

  update public.order_pi_versions
     set status = 'admin_approved',
         decided_by = p_actor_id,
         decided_at = v_now,
         workbook_sha256 = coalesce(nullif(lower(p_payload -> 'source' ->> 'workbook_sha256'), ''), workbook_sha256),
         operations_reviewer = v_reviewer
   where id = v_ver.id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, p_actor_id, 'pi_revision_admin_approved',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'current_version_number', v_current.version_number,
                             'operations_reviewer', v_reviewer));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = p_actor_id;
  if v_reviewer is not null then
    if v_reviewer is distinct from p_actor_id then
      insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
      values (v_reviewer, null, v_order.id, 'order_operations_review_requested'::notification_type,
              format('Order %s: PI V%s approved by %s — awaiting your operations acceptance.',
                     v_order.display_number, v_ver.version_number, coalesce(v_name, 'an administrator')),
              format('PI V%s stays in force until you accept PI V%s. Open the Order, compare the two, then Accept or Reject.',
                     v_current.version_number, v_ver.version_number),
              true);
    end if;
  else
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select u.id, null, v_order.id, 'order_operations_review_requested'::notification_type,
           format('Order %s: PI V%s awaits operations acceptance, but no operations reviewer is assigned.', v_order.display_number, v_ver.version_number),
           'Assign one in Control Center → Operations Handoff.', true
      from public.users u
     where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false;
  end if;

  return jsonb_build_object(
    'version_id',       v_ver.id,
    'version_number',   v_ver.version_number,
    'order_id',         v_order.id,
    'status',           'admin_approved',
    'current_version_number', v_current.version_number,
    'operations_reviewer', v_reviewer,
    'staged',           true
  );
end;
$$;

comment on function public.approve_order_pi_revision(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. An active admin approves a pending revised PI: the same checks as before (20261229000000), after which the server''s parse is STORED (order_pi_revision_staged_parses) and the version becomes admin_approved, addressed to the operations reviewer. NOTHING CURRENT CHANGES — the version in force, the Order''s figures, lines, pictures, documents, codes and alignment stay as they are until decide_order_pi_revision_operations() accepts it (20270101000000).';

revoke execute on function public.approve_order_pi_revision(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.approve_order_pi_revision(uuid, uuid, jsonb) to service_role;


-- ═══ 6. The operations decision — the only promotion ═══════════════════════

create or replace function public.decide_order_pi_revision_operations(
  p_version_id uuid,
  p_decision   text,
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := public.assert_order_submission_actor();
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_order_id  uuid;
  v_reviewer  uuid;
  v_order     public.orders%rowtype;
  v_sub       public.order_submissions%rowtype;
  v_ver       public.order_pi_versions%rowtype;
  v_current   public.order_pi_versions%rowtype;
  v_stage     public.order_pi_revision_staged_parses%rowtype;
  v_blocking  jsonb;
  v_token     uuid := gen_random_uuid();
  v_result    jsonb;
  v_codes     jsonb;
  v_handoff   uuid;
  v_now       timestamptz := now();
  v_seed      jsonb;
  v_name      text;
  v_pre       record;
  v_text      text;
begin
  if p_decision is null or p_decision not in ('accepted', 'rejected') then
    raise exception 'ORDER_PI_REVISION_DECISION_UNKNOWN: the decision must be accepted or rejected' using errcode = 'P0001';
  end if;
  if p_decision = 'rejected' and v_reason is null then
    raise exception 'ORDER_PI_REVISION_REASON_REQUIRED: say why the revised PI cannot be accepted — Sales and the approving admin will see it'
      using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception 'ORDER_PI_REVISION_REASON_TOO_LONG: the reason may be at most 1000 characters' using errcode = 'P0001';
  end if;

  select order_id into v_order_id from public.order_pi_versions where id = p_version_id;
  if v_order_id is null then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  -- LOCK ORDER: reviewers → orders → submission → versions (→ handoffs, inside
  -- the handoff decision below).
  select user_id into v_reviewer from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_ver from public.order_pi_versions where id = p_version_id;
  select * into v_sub from public.order_submissions where id = v_ver.submission_id for update;
  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  select * into v_current from public.order_pi_versions where order_id = v_order_id and status = 'approved' for update;

  -- ── Authority: the reviewer assigned now, able to open this Order ──
  if v_reviewer is null then
    raise exception 'ORDER_PI_REVISION_NO_REVIEWER: no operations reviewer is assigned; an administrator must assign one in Control Center'
      using errcode = 'P0001';
  end if;
  if v_reviewer <> v_actor then
    raise exception 'Only the assigned operations reviewer can accept or reject a revised PI' using errcode = '42501';
  end if;
  if not public.can_view_order_as_actor(v_order_id) then
    raise exception 'You do not have access to this Order' using errcode = '42501';
  end if;

  -- ── State: a revision awaiting operations, on an open Order ──
  if v_ver.status <> 'admin_approved' then
    raise exception 'ORDER_PI_REVISION_NOT_AWAITING_OPERATIONS: PI V% is % — it is not awaiting an operations decision. Refresh to see its current state.',
      v_ver.version_number, v_ver.status using errcode = 'P0001';
  end if;
  if v_ver.operations_reviewer is distinct from v_actor then
    raise exception 'Only the assigned operations reviewer can accept or reject a revised PI' using errcode = '42501';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;
  select * into v_stage from public.order_pi_revision_staged_parses where version_id = v_ver.id;
  if not found or v_stage.applied_at is not null then
    raise exception 'ORDER_PI_REVISION_NOT_STAGED: PI V% has no approved parse waiting to be applied', v_ver.version_number using errcode = 'P0001';
  end if;
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;

  -- ── REJECT: nothing current moves ──
  if p_decision = 'rejected' then
    update public.order_pi_versions
       set status = 'rejected',
           decision_reason = left('Operations: ' || v_reason, 1000),
           operations_decided_by = v_actor, operations_decided_at = v_now, operations_reason = v_reason
     where id = v_ver.id;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_order.id, v_actor, 'pi_revision_operations_rejected',
            jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number, 'reason', v_reason,
                               'current_version_number', v_current.version_number));
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select distinct x.uid, null::uuid, v_order.id, 'order_operations_review_decided'::notification_type,
           format('Order %s: %s rejected PI V%s. PI V%s stays in force.', v_order.display_number,
                  coalesce(v_name, 'Operations'), v_ver.version_number, v_current.version_number),
           v_reason, true
      from (select v_ver.uploaded_by as uid union all select v_ver.decided_by) x
     where x.uid is not null and x.uid <> v_actor;
    return jsonb_build_object('version_id', v_ver.id, 'status', 'rejected');
  end if;

  -- ── ACCEPT ──
  -- 1. THE AMENDMENT GATE: the Order must already carry V2's commercial values.
  v_blocking := public.order_pi_revision_blocking_differences(v_stage.payload, v_order.id);
  if jsonb_array_length(v_blocking) > 0 then
    select string_agg(format('%s: Order has %s, PI V%s has %s', d ->> 'label',
                             coalesce(d ->> 'order_value', 'nothing'), v_ver.version_number, coalesce(d ->> 'pi_value', 'nothing')), '; ')
      into v_text from jsonb_array_elements(v_blocking) d;
    raise exception 'ORDER_PI_REVISION_AMENDMENT_REQUIRED: PI V% changes the Order''s commercial data (%). Amend the Order to these values first (Request a Change, approved by an admin), then accept PI V%.',
      v_ver.version_number, v_text, v_ver.version_number using errcode = 'P0001';
  end if;

  -- 2. The approving admin's authority is what the parse writer re-checks.
  if not exists (select 1 from public.users u where u.id = v_stage.staged_by and u.role = 'admin'
                  and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'ORDER_PI_REVISION_APPROVER_INACTIVE: the administrator who approved PI V% is no longer active; an administrator must approve it again',
      v_ver.version_number using errcode = 'P0001';
  end if;

  -- 3. Keep what is about to be replaced.
  select o.client_name, o.confirm_date, o.due_date, o.total_value, o.total_product_value into v_pre
    from public.orders o where o.id = v_order.id;
  update public.order_pi_revision_staged_parses
     set superseded_snapshot = jsonb_build_object(
           'version_id', v_current.id, 'version_number', v_current.version_number,
           'order', jsonb_build_object('client_name', v_order.client_name, 'confirm_date', v_order.confirm_date,
                                       'due_date', v_order.due_date, 'total_value', v_order.total_value,
                                       'total_product_value', v_order.total_product_value,
                                       'billing_percentage', v_sub.billing_percentage),
           'items',  coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order) from public.order_submission_items i where i.submission_id = v_sub.id), '[]'::jsonb),
           'images', coalesce((select jsonb_agg(to_jsonb(m)) from public.order_submission_item_images m where m.submission_id = v_sub.id), '[]'::jsonb)),
         applied_at = v_now, applied_by = v_actor
   where version_id = v_ver.id;

  -- 4. Apply the staged parse through the unchanged writer, under a lease.
  perform set_config('boe.pi_revision_apply', v_sub.id::text, true);
  perform public.begin_order_submission_processing(v_sub.id, v_stage.staged_by, v_token);
  perform set_config('boe.amendment_context', 'order_amendment', true);
  v_result := public.replace_order_submission_parse(v_sub.id, v_stage.staged_by,
    v_stage.payload || jsonb_build_object(
      'processing_token', v_token,
      'change_reason', left('PI revision V' || v_ver.version_number::text || ' accepted by operations: ' || v_ver.revision_reason, 500)));
  -- ACCEPTANCE NEVER WRITES THE AMENDABLE FIELDS: they were reconciled above;
  -- this restores anything the writer's own rules moved (a PI with no due date).
  update public.orders
     set client_name = v_pre.client_name, confirm_date = v_pre.confirm_date, due_date = v_pre.due_date,
         total_value = v_pre.total_value, total_product_value = v_pre.total_product_value
   where id = v_order.id
     and (client_name, confirm_date, due_date, total_value, total_product_value)
         is distinct from (v_pre.client_name, v_pre.confirm_date, v_pre.due_date, v_pre.total_value, v_pre.total_product_value);
  perform set_config('boe.amendment_context', '', true);
  perform public.finish_order_submission_processing(v_sub.id, v_token);
  v_seed := v_stage.payload -> 'seed_terms';
  if v_seed is not null and jsonb_typeof(v_seed) = 'object' then
    perform public.seed_order_submission_pi_terms(v_sub.id,
      v_seed ->> 'fabric_responsibility', v_seed ->> 'commercial_terms_note', v_seed ->> 'client_city');
  end if;

  if (select source_workbook_path from public.order_submissions where id = v_sub.id) is distinct from v_ver.workbook_path then
    raise exception 'ORDER_PI_REVISION_NOT_APPLIED: the revised workbook was not recorded on the PI' using errcode = 'P0001';
  end if;

  -- 5. The version in force changes — only here.
  if v_current.id is not null then
    update public.order_pi_versions
       set status = 'superseded', superseded_at = v_now, superseded_by_version_id = v_ver.id
     where id = v_current.id;
  end if;
  update public.order_pi_versions
     set status = 'approved', operations_decided_by = v_actor, operations_decided_at = v_now,
         operations_reason = v_reason, applied_at = v_now
   where id = v_ver.id;
  perform set_config('boe.pi_revision_apply', '', true);

  v_codes := public.assign_order_product_codes(v_order.id, v_actor);

  -- 6. The existing handoff (recorded by the trigger above) is accepted by the
  --    same person in the same transaction: ONE operations decision, which
  --    also aligns the Order for production against V2.
  select id into v_handoff from public.order_operations_handoffs
   where pi_version_id = v_ver.id and superseded_at is null;
  if v_handoff is not null then
    perform public.decide_order_operations_handoff(v_handoff, 'accepted', v_reason);
    -- The trigger's "awaiting your review" message to the reviewer was written
    -- in this transaction for a decision this transaction has already made.
    delete from public.notifications
     where user_id = v_actor and entity_id = v_order.id and created_at = v_now
       and type = 'order_operations_review_requested'::notification_type;
  end if;

  perform public.log_order_submission_activity(
    v_sub.id, v_actor, 'pi_revision_approved', 'approved', 'approved', v_reason,
    jsonb_build_object('order_id', v_order.id, 'version_id', v_ver.id, 'version_number', v_ver.version_number,
                       'superseded_version_number', v_current.version_number,
                       'approved_by_admin', v_stage.staged_by, 'accepted_by_operations', v_actor,
                       'superseded_documents', v_result -> 'superseded_documents'));
  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, v_actor, 'pi_revision_applied',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'superseded_version_number', v_current.version_number,
                             'approved_by', v_stage.staged_by, 'note', v_reason,
                             'superseded_documents', v_result -> 'superseded_documents'));
  if jsonb_array_length(v_codes) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_order.id, v_actor, 'order_product_codes_assigned', jsonb_build_object('codes', v_codes, 'version_id', v_ver.id));
  end if;

  -- Sales hears that their revision is now in force, once.
  if v_ver.uploaded_by is not null and v_ver.uploaded_by <> v_actor then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_ver.uploaded_by, null, v_order.id, 'order_operations_review_decided'::notification_type,
            format('Order %s: %s accepted PI V%s — it is now the PI in force.', v_order.display_number,
                   coalesce(v_name, 'Operations'), v_ver.version_number),
            v_reason, true);
  end if;

  return jsonb_build_object('version_id', v_ver.id, 'status', 'approved', 'order_id', v_order.id,
                            'superseded_version_number', v_current.version_number, 'handoff_id', v_handoff);
end;
$$;
comment on function public.decide_order_pi_revision_operations(uuid, text, text) is
  'The assigned operations reviewer accepts or rejects a revised PI an admin approved (admin_approved). Reject: reason required; nothing current changes. Accept: refused while the staged PI differs from the Order on an amendable field (amend the Order first); otherwise applies the staged parse through replace_order_submission_parse under a lease, supersedes the previous version, approves this one, records and accepts its operations handoff, and assigns product codes — in ONE transaction. Re-checks under row locks: caller is the current, active reviewer who can open the Order; the version is still awaiting operations; the Order is open.';
revoke execute on function public.decide_order_pi_revision_operations(uuid, text, text) from public, anon;
grant  execute on function public.decide_order_pi_revision_operations(uuid, text, text) to authenticated;


-- ═══ 7. Reassignment readdresses revisions awaiting operations ═════════════

create or replace function public.order_operations_reviewers_readdress_pi_revisions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v      record;
  v_to   uuid;
  v_actor uuid := auth.uid();
begin
  if tg_op = 'UPDATE' and new.user_id is not distinct from old.user_id then
    return new;
  end if;
  for v in
    select pv.id, pv.order_id, pv.version_number, pv.operations_reviewer, o.display_number
      from public.order_pi_versions pv join public.orders o on o.id = pv.order_id
     where pv.status = 'admin_approved' and o.status <> 'cancelled'
       for update of pv
  loop
    v_to := case when new.user_id is not null
                   and exists (select 1 from public.users u where u.id = new.user_id and u.is_active and coalesce(u.is_deleted, false) = false)
                   and public.operations_reviewer_can_open_order(new.user_id, v.order_id)
                 then new.user_id end;
    continue when v_to is not distinct from v.operations_reviewer;
    update public.order_pi_versions set operations_reviewer = v_to where id = v.id;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v.order_id, v_actor, 'pi_revision_reviewer_changed',
            jsonb_build_object('version_id', v.id, 'version_number', v.version_number,
                               'assigned_to', v_to, 'previously_assigned_to', v.operations_reviewer));
    if v_to is not null and v_to is distinct from v_actor then
      insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
      values (v_to, null, v.order_id, 'order_operations_review_requested'::notification_type,
              format('Order %s: PI V%s now awaits your operations acceptance.', v.display_number, v.version_number),
              'You have been assigned as the operations reviewer.', true);
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function public.order_operations_reviewers_readdress_pi_revisions() from public, anon, authenticated, service_role;
drop trigger if exists order_operations_reviewers_readdress_pi_revisions on public.order_operations_reviewers;
create trigger order_operations_reviewers_readdress_pi_revisions
  after insert or update of user_id on public.order_operations_reviewers
  for each row execute function public.order_operations_reviewers_readdress_pi_revisions();


-- ═══ 8. Apply-time assertions ══════════════════════════════════════════════
do $$
begin
  if has_function_privilege('authenticated', 'public.approve_order_pi_revision(uuid, uuid, jsonb)', 'EXECUTE') then
    raise exception 'ASSERT: approve_order_pi_revision must stay service-role only';
  end if;
  if has_table_privilege('authenticated', 'public.order_pi_revision_staged_parses', 'SELECT') then
    raise exception 'ASSERT: staged parses carry storage keys and are not client-readable';
  end if;
  if position('replace_order_submission_parse' in pg_get_functiondef('public.approve_order_pi_revision(uuid, uuid, jsonb)'::regprocedure)) > 0 then
    raise exception 'ASSERT: admin approval must no longer apply the parse';
  end if;
end $$;

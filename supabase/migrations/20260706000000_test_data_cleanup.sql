-- Admin-only Test Data Cleanup.
--
-- 20260705000000 made finalized Orders, converted Order Requests and approved
-- bank payments permanently undeletable. That is the correct production rule and
-- it must never be relaxed. But the system is still in testing, and the Orders →
-- Finance workflow has to be exercised repeatedly from a clean state, which
-- means a controlled way to remove a COMPLETE verified test transaction chain.
--
-- The shape of the answer matters as much as the answer. This is deliberately
-- NOT a delete button that admins are trusted to use carefully. It is a separate
-- flow with five independent gates, every one of which is enforced in the
-- database rather than the UI:
--
--   1. the caller is an admin
--   2. Test Data Cleanup is enabled and not permanently disabled
--   3. a non-empty reason is supplied
--   4. the exact words DELETE TEST DATA are typed
--   5. EVERY business record in the resolved chain is marked test data
--
-- and one more that is structural rather than procedural: the guards from
-- 20260705000000 stay armed throughout. They stand down only for the single
-- transaction that execute_test_data_cleanup() has already validated, via a
-- transaction-local GUC that no client can set.
--
-- Live state this migration was written against (inspected 2026-07-21):
--   orders 1, order_requests 2, finance_payment_requests 0,
--   payment_proof_attachments 0, payment-proofs objects 0,
--   order_activity_log 1, order_request_activity 6,
--   order/finance notifications 1 (of 19,675 total — the rest are task-related)
--   No settings, config or audit table exists anywhere in the schema.
--
-- Scope discipline: nothing here weakens a production protection, touches a
-- numbering sequence or cycle, alters a provenance FK, or changes any existing
-- SELECT/INSERT/UPDATE policy. It deletes no row on the way in — it only marks
-- three named rows as test data.

-- ══════════════════════════════════════════════════════════════════════════════
-- PART 1 — TEST DATA CLASSIFICATION
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1.1 The marker ────────────────────────────────────────────────────────────
--
-- One boolean on each of the three business tables. Deliberately NOT added to
-- activity logs, proof attachments or notifications: those are child rows with
-- no independent existence, so their eligibility is their parent's eligibility.
-- A second flag there could only ever disagree with the first.
--
-- NOT NULL DEFAULT false — a record is real unless something deliberately says
-- otherwise, so any future code path that forgets about this column produces a
-- protected record rather than a deletable one.

alter table public.orders
  add column if not exists is_test_data boolean not null default false;

alter table public.order_requests
  add column if not exists is_test_data boolean not null default false;

alter table public.finance_payment_requests
  add column if not exists is_test_data boolean not null default false;

comment on column public.orders.is_test_data is
  'True only for records created during system testing. Set once at INSERT and immutable thereafter. Only test records can be removed by execute_test_data_cleanup().';

-- ── 1.2 Stamping: how a record becomes test data ──────────────────────────────
--
-- The column default is false, per the rule that normal records are real. What
-- makes the feature usable is this trigger: while Test Data Cleanup is enabled,
-- newly created records are stamped test data automatically.
--
-- This is the crux of the design, so the reasoning is worth stating plainly.
-- The alternative — an admin screen for ticking records as test data — is worse
-- in every direction. It is a permanent, general-purpose "make this deletable"
-- control, which is exactly the capability this whole workstream exists to
-- remove; it can be pointed at a real record; and it has to be remembered after
-- every test run, so the one time it is forgotten the test data becomes
-- permanent instead.
--
-- Stamping at INSERT inverts all of that. "Test data" stops being a judgement an
-- admin makes about a record and becomes a fact about WHEN the record was
-- created — during the testing phase or after it. There is no control to misuse,
-- nothing to remember, and the blast radius shrinks to zero the moment the
-- phase ends: once cleanup is permanently disabled this trigger can only ever
-- write false, so every record from go-live onwards is real and protected, with
-- no further action required by anyone.
--
-- A caller-supplied value is ignored entirely rather than honoured when true —
-- the same rule the Order-number and request-number triggers already apply. That
-- keeps "am I test data?" a property of the system's phase, never of the request
-- payload, so no client can opt a record into being deletable.

create or replace function public.stamp_test_data_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.is_test_data := coalesce(
    (select s.enabled and not s.permanently_disabled
       from public.test_data_cleanup_settings s
      where s.id = true),
    false
  );
  return new;
end;
$$;

revoke execute on function public.stamp_test_data_flag() from public, anon, authenticated;

-- ── 1.3 Immutability ──────────────────────────────────────────────────────────
--
-- Once stamped, the flag never changes — in EITHER direction, which is stricter
-- than the stated requirement and deliberately so. Blocking test → real matters
-- as much as blocking real → test: without it, anyone could quietly re-classify
-- a record to change whether it is protected, and the marker would stop being
-- evidence of anything.
--
-- Not even the cleanup context is exempt. Cleanup deletes records; it has no
-- business re-labelling them.
--
-- Scoped to the column, so every ordinary update passes straight through.

create or replace function public.prevent_test_data_flag_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_test_data is distinct from old.is_test_data then
    raise exception
      'TEST_DATA_FLAG_IMMUTABLE: Whether a record is test data is fixed when it is created and cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.prevent_test_data_flag_change() from public, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- PART 2 — SETTINGS
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 2.1 The singleton ─────────────────────────────────────────────────────────
--
-- Same idiom as order_number_cycle (20260703): a boolean primary key CHECKed to
-- true, so exactly one row can ever exist and no code has to choose which row is
-- live. RLS enabled with NO policies plus an explicit REVOKE — the table is not
-- client-readable or client-writable at all; everything goes through the
-- admin-gated RPCs below.
--
-- The CHECK is what makes "permanently" mean permanently at the storage layer:
-- enabled and permanently_disabled can never both be true, so no future code
-- path — including a careless UPDATE — can produce a re-enabled cleanup without
-- first clearing a column that nothing in the application can clear.

create table if not exists public.test_data_cleanup_settings (
  id                    boolean     primary key default true,
  enabled               boolean     not null default false,
  permanently_disabled  boolean     not null default false,
  enabled_at            timestamptz,
  enabled_by            uuid        references public.users(id) on delete set null,
  disabled_at           timestamptz,
  disabled_by           uuid        references public.users(id) on delete set null,
  disabled_by_email     text,
  constraint test_data_cleanup_settings_singleton check (id),
  constraint test_data_cleanup_settings_disable_is_final
    check (not (enabled and permanently_disabled))
);

comment on table public.test_data_cleanup_settings is
  'Single-row switch for the admin-only Test Data Cleanup flow. Never written directly by clients: RLS is enabled with no policies. Once permanently_disabled is true it cannot be cleared by any application path — only a new migration or service-role intervention.';

alter table public.test_data_cleanup_settings enable row level security;

revoke all on table public.test_data_cleanup_settings from public, anon, authenticated;

-- Deliberate initialization: the system IS in its testing phase as of this
-- migration, which is the entire reason the feature is being built. Recorded
-- explicitly here rather than left to a later toggle, so the enabled state has a
-- dated, reviewable origin in version control.
--
-- ON CONFLICT DO NOTHING makes the migration re-runnable and, critically,
-- non-destructive on re-run: it can never resurrect a cleanup that an admin has
-- since permanently disabled.
insert into public.test_data_cleanup_settings (id, enabled, permanently_disabled, enabled_at)
values (true, true, false, now())
on conflict (id) do nothing;

-- Now that the settings table exists, arm the stamping and immutability
-- triggers. Order matters: stamp_test_data_flag() reads the table, so the
-- triggers are created after the row exists.

drop trigger if exists orders_stamp_test_data on public.orders;
create trigger orders_stamp_test_data
  before insert on public.orders
  for each row execute function public.stamp_test_data_flag();

drop trigger if exists orders_protect_test_data on public.orders;
create trigger orders_protect_test_data
  before update on public.orders
  for each row execute function public.prevent_test_data_flag_change();

drop trigger if exists order_requests_stamp_test_data on public.order_requests;
create trigger order_requests_stamp_test_data
  before insert on public.order_requests
  for each row execute function public.stamp_test_data_flag();

drop trigger if exists order_requests_protect_test_data on public.order_requests;
create trigger order_requests_protect_test_data
  before update on public.order_requests
  for each row execute function public.prevent_test_data_flag_change();

drop trigger if exists finance_payment_requests_stamp_test_data on public.finance_payment_requests;
create trigger finance_payment_requests_stamp_test_data
  before insert on public.finance_payment_requests
  for each row execute function public.stamp_test_data_flag();

drop trigger if exists finance_payment_requests_protect_test_data on public.finance_payment_requests;
create trigger finance_payment_requests_protect_test_data
  before update on public.finance_payment_requests
  for each row execute function public.prevent_test_data_flag_change();

-- ── 2.2 Classifying the records that already exist ────────────────────────────
--
-- The three rows below pre-date the stamping trigger, so they are classified
-- here — by EXPLICIT UUID, never by a table-wide UPDATE or a date cutoff.
-- A cutoff was considered and rejected: order_request_seq is at 5 and
-- finance_payment_request_seq at 22, so roughly 22 payment requests and 3 order
-- requests were already created and hard-deleted during earlier testing. The
-- surviving history is not continuous, so no date can separate test from real.
--
-- Confirmed with the product owner on 2026-07-21 that all three are test data:
--
--   60d418d1-a94e-4ab9-9e4d-e47ba0151767  Order 0017 (Pappadam, running)
--       created 2026-07-20 by admin@bestofexports.com when conversion was being
--       tested; ₹0 ever received, no payment has ever been linked to it.
--   a58f753b-92fc-4d72-bcc7-a2b3aab129bd  ORD-REQ-2026-0003 (Pappadam, converted)
--       the source request that produced Order 0017 — the same chain.
--   8e09a8ca-ac92-44c2-a1e6-94fa1ebd244b  ORD-REQ-2026-0005 (Dazzle, needs_clarification)
--       created 2026-07-21 by the dedicated test account test.sales@boe-test.local.
--
-- The WHERE clauses re-assert each row's number as well as its uuid, so if this
-- migration is ever applied to a database where those uuids mean something else,
-- it silently matches nothing instead of mislabelling a real record. The
-- assertion afterwards then fails loudly rather than leaving the job half done.
--
-- The immutability trigger from 1.3 has to stand down for exactly these three
-- statements. It is re-armed immediately; DDL is transactional, so a failure
-- anywhere below restores it along with everything else.

alter table public.orders          disable trigger orders_protect_test_data;
alter table public.order_requests  disable trigger order_requests_protect_test_data;

update public.orders
   set is_test_data = true
 where id = '60d418d1-a94e-4ab9-9e4d-e47ba0151767'
   and display_number = '0017';

update public.order_requests
   set is_test_data = true
 where id = 'a58f753b-92fc-4d72-bcc7-a2b3aab129bd'
   and request_number = 'ORD-REQ-2026-0003';

update public.order_requests
   set is_test_data = true
 where id = '8e09a8ca-ac92-44c2-a1e6-94fa1ebd244b'
   and request_number = 'ORD-REQ-2026-0005';

alter table public.order_requests  enable trigger order_requests_protect_test_data;
alter table public.orders          enable trigger orders_protect_test_data;

do $$
declare
  v_orders   bigint;
  v_requests bigint;
begin
  select count(*) into v_orders   from public.orders         where is_test_data;
  select count(*) into v_requests from public.order_requests where is_test_data;

  if v_orders <> 1 or v_requests <> 2 then
    raise exception
      'Test-data classification did not match the reviewed set: expected 1 order and 2 order requests, got % and %. Refusing to proceed.',
      v_orders, v_requests;
  end if;
end $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- PART 3 — AUDIT
-- ══════════════════════════════════════════════════════════════════════════════

-- The audit row is written INSIDE the cleanup transaction, before any business
-- row is removed, so it commits or rolls back with the deletion it describes —
-- there can be no deletion without a matching audit entry, and no audit entry
-- for a deletion that did not happen.
--
-- performed_by is ON DELETE SET NULL with the email denormalized alongside it:
-- the audit has to outlive the admin's user record, and there is no name column
-- on public.users. Numbers are stored, not full row snapshots — this project has
-- no payload-snapshot convention, and keeping deleted business data in an audit
-- table would quietly recreate the records the cleanup was asked to remove.

create table if not exists public.test_data_cleanup_audit (
  id                  uuid        primary key default gen_random_uuid(),
  performed_by        uuid        references public.users(id) on delete set null,
  performed_by_email  text,
  performed_at        timestamptz not null default now(),
  reason              text        not null,
  confirmation        text        not null,
  root_type           text        not null,
  root_id             uuid        not null,
  root_number         text,
  deleted_records     jsonb       not null default '[]'::jsonb,
  table_counts        jsonb       not null default '{}'::jsonb,
  storage_paths       jsonb       not null default '[]'::jsonb,
  result              jsonb       not null default '{}'::jsonb,
  constraint test_data_cleanup_audit_reason_not_blank check (btrim(reason) <> '')
);

comment on table public.test_data_cleanup_audit is
  'Permanent record of every Test Data Cleanup execution. Written only by execute_test_data_cleanup(). Survives the business records it describes.';

alter table public.test_data_cleanup_audit enable row level security;

revoke all on table public.test_data_cleanup_audit from public, anon, authenticated;

-- Admins may READ the audit; nobody may write it from a client. The insert
-- happens inside a SECURITY DEFINER function, which is unaffected by RLS.
grant select on table public.test_data_cleanup_audit to authenticated;

create policy "test_data_cleanup_audit_admin_select"
  on public.test_data_cleanup_audit
  for select to authenticated
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );

-- ══════════════════════════════════════════════════════════════════════════════
-- PART 4 — SETTINGS RPCs
-- ══════════════════════════════════════════════════════════════════════════════

create or replace function public.get_test_data_cleanup_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.test_data_cleanup_settings%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'Only an admin may read the Test Data Cleanup settings'
      using errcode = '42501';
  end if;

  select * into v_row from public.test_data_cleanup_settings where id = true;

  return jsonb_build_object(
    'enabled',              coalesce(v_row.enabled, false),
    'permanently_disabled', coalesce(v_row.permanently_disabled, false),
    'disabled_at',          v_row.disabled_at,
    'disabled_by_email',    v_row.disabled_by_email,
    'enabled_at',           v_row.enabled_at,
    'test_record_counts',   jsonb_build_object(
      'orders',           (select count(*) from public.orders                   where is_test_data),
      'order_requests',   (select count(*) from public.order_requests           where is_test_data),
      'payment_requests', (select count(*) from public.finance_payment_requests where is_test_data)
    )
  );
end;
$$;

revoke execute on function public.get_test_data_cleanup_settings() from public, anon;
grant  execute on function public.get_test_data_cleanup_settings() to authenticated;

-- The one-way door.
--
-- Idempotent by design: disabling an already-disabled cleanup succeeds and says
-- so, rather than erroring. A destructive-sounding action that reports failure
-- when the desired state already holds invites a second, harder attempt.

create or replace function public.permanently_disable_test_data_cleanup(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_row   public.test_data_cleanup_settings%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select u.email into v_email
  from public.users u
  where u.id = v_actor and u.role = 'admin';

  if v_email is null then
    raise exception 'Only an admin may disable Test Data Cleanup' using errcode = '42501';
  end if;

  if coalesce(btrim(p_confirmation), '') <> 'DISABLE TEST CLEANUP' then
    raise exception
      'CLEANUP_CONFIRMATION_INVALID: Type DISABLE TEST CLEANUP exactly to confirm'
      using errcode = 'P0001';
  end if;

  select * into v_row from public.test_data_cleanup_settings where id = true for update;

  if not found then
    raise exception 'CLEANUP_SETTINGS_MISSING: Test Data Cleanup is not configured'
      using errcode = 'P0001';
  end if;

  if v_row.permanently_disabled then
    return jsonb_build_object(
      'permanently_disabled', true,
      'already_disabled',     true,
      'disabled_at',          v_row.disabled_at,
      'disabled_by_email',    v_row.disabled_by_email
    );
  end if;

  update public.test_data_cleanup_settings
     set enabled              = false,
         permanently_disabled = true,
         disabled_at          = now(),
         disabled_by          = v_actor,
         disabled_by_email    = v_email
   where id = true;

  return jsonb_build_object(
    'permanently_disabled', true,
    'already_disabled',     false,
    'disabled_at',          now(),
    'disabled_by_email',    v_email
  );
end;
$$;

revoke execute on function public.permanently_disable_test_data_cleanup(text) from public, anon;
grant  execute on function public.permanently_disable_test_data_cleanup(text) to authenticated;

comment on function public.permanently_disable_test_data_cleanup(text) is
  'Admin-only, irreversible through the application. Sets permanently_disabled, after which preview and execute both refuse and newly created records are always real. Re-enabling requires a new migration or service-role intervention.';

-- ══════════════════════════════════════════════════════════════════════════════
-- PART 5 — CHAIN RESOLUTION
-- ══════════════════════════════════════════════════════════════════════════════

-- The single source of truth for "what does cleaning this up actually touch?".
-- Preview and execute both call it, so what an admin was shown and what the
-- database acts on cannot drift — execute simply re-runs it under held locks and
-- re-checks the answer.
--
-- The graph is deliberately root-type dependent rather than a blind transitive
-- closure, because the two directions do not mean the same thing:
--
--   order          -> the Order, the Order Request that produced it, and every
--                     payment attached to either. Deleting an Order while its
--                     source request survives would leave a converted request
--                     pointing at nothing.
--   order_request  -> the mirror image. A converted request and its Order are
--                     one indivisible unit; cleaning up only one is what
--                     rule 9.2 exists to forbid.
--   payment        -> the payment alone. A payment is a leaf: removing one says
--                     nothing about the Order it was attached to, and pulling
--                     that Order into the chain would delete far more than the
--                     admin asked for. Its links are still CHECKED — a payment
--                     attached to a real Order or a real request is refused.
--
-- Eligibility is all-or-nothing. Every business record in the chain must be
-- marked test data; one real record blocks the whole operation and is named in
-- `blocking`. There is no partial cleanup.

create or replace function public.resolve_test_data_cleanup_chain(
  p_root_type text,
  p_root_id   uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_order_id   uuid;
  v_request_id uuid;
  v_payments   uuid[] := '{}';
  v_root_num   text;
  v_delete     jsonb := '[]'::jsonb;
  v_retain     jsonb := '[]'::jsonb;
  v_block      jsonb := '[]'::jsonb;
  v_paths      jsonb := '[]'::jsonb;
  v_counts     jsonb;
begin
  if p_root_type not in ('order', 'order_request', 'payment') then
    raise exception 'CLEANUP_ROOT_TYPE_INVALID: Unknown record type %', p_root_type
      using errcode = 'P0001';
  end if;

  -- ── Resolve the chain members ──────────────────────────────────────────────
  if p_root_type = 'order' then
    select o.id, o.source_order_request_id, o.display_number
      into v_order_id, v_request_id, v_root_num
    from public.orders o where o.id = p_root_id;

  elsif p_root_type = 'order_request' then
    select r.id, r.converted_order_id, r.request_number
      into v_request_id, v_order_id, v_root_num
    from public.order_requests r where r.id = p_root_id;

  else
    select f.request_number into v_root_num
    from public.finance_payment_requests f where f.id = p_root_id;

    if v_root_num is not null then
      v_payments := array[p_root_id];
    end if;
  end if;

  if v_root_num is null then
    raise exception 'CLEANUP_ROOT_NOT_FOUND: That record no longer exists'
      using errcode = 'P0002';
  end if;

  -- Payments attached to either side of an order/request chain.
  if p_root_type in ('order', 'order_request') then
    select coalesce(array_agg(f.id), '{}')
      into v_payments
    from public.finance_payment_requests f
    where (v_order_id   is not null and f.order_id         = v_order_id)
       or (v_request_id is not null and f.order_request_id = v_request_id);
  end if;

  -- ── Records proposed for deletion, and the ones that block ─────────────────
  select coalesce(jsonb_agg(x order by x->>'type', x->>'number'), '[]'::jsonb)
    into v_delete
  from (
    select jsonb_build_object(
             'type', 'order', 'id', o.id, 'number', o.display_number,
             'status', o.status, 'label', o.client_name, 'is_test_data', o.is_test_data) as x
    from public.orders o where o.id = v_order_id
    union all
    select jsonb_build_object(
             'type', 'order_request', 'id', r.id, 'number', r.request_number,
             'status', r.status, 'label', r.client_name, 'is_test_data', r.is_test_data)
    from public.order_requests r where r.id = v_request_id
    union all
    select jsonb_build_object(
             'type', 'payment', 'id', f.id, 'number', f.request_number,
             'status', f.status, 'label', f.client_name, 'amount', f.amount,
             'is_test_data', f.is_test_data)
    from public.finance_payment_requests f where f.id = any(v_payments)
  ) t;

  select coalesce(jsonb_agg(x), '[]'::jsonb)
    into v_block
  from jsonb_array_elements(v_delete) x
  where not (x->>'is_test_data')::boolean;

  -- A payment root keeps its Order / Order Request. They are reported as
  -- retained so the admin can see what survives, and they are checked: an
  -- attachment to a REAL record blocks, exactly as rule 9.3 requires.
  if p_root_type = 'payment' then
    select coalesce(jsonb_agg(x order by x->>'type'), '[]'::jsonb)
      into v_retain
    from (
      select jsonb_build_object('type','order','id',o.id,'number',o.display_number,
                                'status',o.status,'is_test_data',o.is_test_data) as x
      from public.orders o
      join public.finance_payment_requests f on f.order_id = o.id
      where f.id = p_root_id
      union all
      select jsonb_build_object('type','order_request','id',r.id,'number',r.request_number,
                                'status',r.status,'is_test_data',r.is_test_data)
      from public.order_requests r
      join public.finance_payment_requests f on f.order_request_id = r.id
      where f.id = p_root_id
    ) t;

    v_block := v_block || (
      select coalesce(jsonb_agg(x), '[]'::jsonb)
      from jsonb_array_elements(v_retain) x
      where not (x->>'is_test_data')::boolean
    );
  end if;

  -- ── Proof objects and dependent-row counts ────────────────────────────────
  select coalesce(jsonb_agg(a.storage_path order by a.storage_path), '[]'::jsonb)
    into v_paths
  from public.payment_proof_attachments a
  where a.payment_request_id = any(v_payments);

  v_counts := jsonb_build_object(
    'orders',                   (select count(*) from public.orders where id = v_order_id),
    'order_requests',           (select count(*) from public.order_requests where id = v_request_id),
    'payment_requests',         coalesce(array_length(v_payments, 1), 0),
    'order_activity_log',       (select count(*) from public.order_activity_log where order_id = v_order_id),
    'order_request_activity',   (select count(*) from public.order_request_activity where order_request_id = v_request_id),
    'payment_activity',         (select count(*) from public.finance_payment_request_activity_log where payment_request_id = any(v_payments)),
    'proof_attachments',        (select count(*) from public.payment_proof_attachments where payment_request_id = any(v_payments)),
    'notifications',            (select count(*) from public.notifications
                                  where entity_id in (
                                    select unnest(array_remove(array[v_order_id, v_request_id], null))
                                    union all select unnest(v_payments))
                                    and (type::text like 'order%' or type::text like 'finance%'))
  );

  return jsonb_build_object(
    'root_type',       p_root_type,
    'root_id',         p_root_id,
    'root_number',     v_root_num,
    'order_id',        v_order_id,
    'order_request_id',v_request_id,
    'payment_ids',     to_jsonb(v_payments),
    'to_delete',       v_delete,
    'to_retain',       v_retain,
    'blocking',        v_block,
    'storage_paths',   v_paths,
    'counts',          v_counts,
    'eligible',        jsonb_array_length(v_block) = 0
  );
end;
$$;

revoke execute on function public.resolve_test_data_cleanup_chain(text, uuid) from public, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- PART 6 — SEARCH AND PREVIEW
-- ══════════════════════════════════════════════════════════════════════════════

create or replace function public.search_test_data_cleanup_roots(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_q     text := '%' || coalesce(btrim(p_query), '') || '%';
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'Only an admin may search Test Data Cleanup records'
      using errcode = '42501';
  end if;
  if coalesce(btrim(p_query), '') = '' then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(x order by x->>'type', x->>'number')
    from (
      select jsonb_build_object('type','order','id',o.id,'number',o.display_number,
               'status',o.status,'label',o.client_name,'is_test_data',o.is_test_data) as x
      from public.orders o
      where o.display_number ilike v_q or o.client_name ilike v_q
      union all
      select jsonb_build_object('type','order_request','id',r.id,'number',r.request_number,
               'status',r.status,'label',r.client_name,'is_test_data',r.is_test_data)
      from public.order_requests r
      where r.request_number ilike v_q or r.client_name ilike v_q
      union all
      select jsonb_build_object('type','payment','id',f.id,'number',f.request_number,
               'status',f.status,'label',f.client_name,'amount',f.amount,'is_test_data',f.is_test_data)
      from public.finance_payment_requests f
      where f.request_number ilike v_q or f.client_name ilike v_q
    ) t
    limit 50
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.search_test_data_cleanup_roots(text) from public, anon;
grant  execute on function public.search_test_data_cleanup_roots(text) to authenticated;

-- Read-only. Gated on admin AND on the enabled setting, so a disabled cleanup
-- cannot even be explored — and so the client never has to decide for itself
-- whether an operation would be allowed.

create or replace function public.preview_test_data_cleanup(
  p_root_type text,
  p_root_id   uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_set   public.test_data_cleanup_settings%rowtype;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'Only an admin may preview Test Data Cleanup' using errcode = '42501';
  end if;

  select * into v_set from public.test_data_cleanup_settings where id = true;

  if not found or v_set.permanently_disabled or not v_set.enabled then
    raise exception
      'CLEANUP_DISABLED: Test Data Cleanup has been permanently disabled. Final Orders and bank payment history cannot be deleted.'
      using errcode = '42501';
  end if;

  return public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);
end;
$$;

revoke execute on function public.preview_test_data_cleanup(text, uuid) from public, anon;
grant  execute on function public.preview_test_data_cleanup(text, uuid) to authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- PART 7 — EXECUTION
-- ══════════════════════════════════════════════════════════════════════════════

-- One RPC, one transaction, all five gates. The client never issues a delete.
--
-- Deletion order is dictated by two NO ACTION foreign keys that point at each
-- other — orders.source_order_request_id -> order_requests (20260701) and
-- order_requests.converted_order_id -> orders. Neither row can be deleted while
-- the other exists, so one reference has to be released first.
--
-- Releasing orders.source_order_request_id is the right side to break: clearing
-- order_requests.converted_order_id would also require changing the request's
-- status, because order_requests_converted_consistency ties the two together,
-- and mutating a status on the way to deleting the row is both pointless and
-- misleading. The provenance FK itself is NOT weakened anywhere — it is fully
-- enforcing before this transaction and after it; only this one authorized
-- transaction nulls the column it protects, immediately before deleting both
-- rows anyway.

-- The provenance guard from 20260701 freezes source_order_request_id once set,
-- which is exactly right for every ordinary path and is why it is kept. It needs
-- one exemption so the authorized cleanup transaction can release the reference
-- described above.
--
-- Reproduced verbatim from pg_get_functiondef on the live database, with the
-- cleanup-context check added and nothing else altered. Replacing the function
-- rather than the trigger keeps 20260701 untouched, and the immutability
-- guarantee is unchanged for every transaction that is not an authorized
-- cleanup — which is all of them except the one this migration creates.

create or replace function public.prevent_order_source_request_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.in_test_data_cleanup() then
    return new;
  end if;

  if old.source_order_request_id is not null
     and new.source_order_request_id is distinct from old.source_order_request_id then
    raise exception 'source_order_request_id is immutable and cannot be changed once set'
      using errcode = '42501';
  end if;

  if old.source_request_number is not null
     and new.source_request_number is distinct from old.source_request_number then
    raise exception 'source_request_number is immutable and cannot be changed once set'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.prevent_order_source_request_change() from public, anon, authenticated;

create or replace function public.execute_test_data_cleanup(
  p_root_type    text,
  p_root_id      uuid,
  p_reason       text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor    uuid := auth.uid();
  v_email    text;
  v_set      public.test_data_cleanup_settings%rowtype;
  v_chain    jsonb;
  v_order    uuid;
  v_request  uuid;
  v_payments uuid[];
  v_ids      uuid[];
  v_audit    uuid;
  v_n_notif  integer := 0;
  v_n_pay    integer := 0;
  v_n_req    integer := 0;
  v_n_ord    integer := 0;
begin
  -- ── Gate 1: admin ─────────────────────────────────────────────────────────
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select u.email into v_email
  from public.users u where u.id = v_actor and u.role = 'admin';

  if v_email is null then
    raise exception 'Only an admin may run Test Data Cleanup' using errcode = '42501';
  end if;

  -- ── Gate 2: enabled. Locked, so a concurrent permanent-disable cannot slip
  --    past between the check and the deletion.
  select * into v_set from public.test_data_cleanup_settings where id = true for update;

  if not found or v_set.permanently_disabled or not v_set.enabled then
    raise exception
      'CLEANUP_DISABLED: Test Data Cleanup has been permanently disabled. Final Orders and bank payment history cannot be deleted.'
      using errcode = '42501';
  end if;

  -- ── Gate 3: a reason ──────────────────────────────────────────────────────
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'CLEANUP_REASON_REQUIRED: Enter why this test data is being removed'
      using errcode = 'P0001';
  end if;

  -- ── Gate 4: the typed words ───────────────────────────────────────────────
  if coalesce(btrim(p_confirmation), '') <> 'DELETE TEST DATA' then
    raise exception 'CLEANUP_CONFIRMATION_INVALID: Type DELETE TEST DATA exactly to confirm'
      using errcode = 'P0001';
  end if;

  -- ── Resolve, then LOCK, then re-resolve ───────────────────────────────────
  -- The first pass finds the rows; the locks freeze them; the second pass is the
  -- one that counts. Anything that changed between the admin's preview and now —
  -- a payment approved onto the Order, a request converted — is caught by the
  -- re-check rather than acted on from a stale graph.
  v_chain := public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);

  v_order   := nullif(v_chain->>'order_id', '')::uuid;
  v_request := nullif(v_chain->>'order_request_id', '')::uuid;

  -- jsonb_array_elements_text, not jsonb_array_elements: the latter yields jsonb
  -- string values whose ::text form still carries its quotes, which the uuid cast
  -- then rejects.
  select coalesce(array_agg(value::uuid), '{}')
    into v_payments
  from jsonb_array_elements_text(v_chain->'payment_ids');

  perform 1 from public.orders         where id = v_order   for update;
  perform 1 from public.order_requests where id = v_request for update;
  perform 1 from public.finance_payment_requests
   where id = any(v_payments) order by id for update;

  v_chain := public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);

  -- ── Gate 5: every record in the chain is test data ────────────────────────
  if not (v_chain->>'eligible')::boolean then
    raise exception
      'CLEANUP_NOT_ELIGIBLE: This chain contains records that are not test data and cannot be removed: %',
      (select string_agg(coalesce(x->>'number', x->>'id'), ', ')
         from jsonb_array_elements(v_chain->'blocking') x)
      using errcode = '42501';
  end if;

  v_order   := nullif(v_chain->>'order_id', '')::uuid;
  v_request := nullif(v_chain->>'order_request_id', '')::uuid;
  -- jsonb_array_elements_text, not jsonb_array_elements: the latter yields jsonb
  -- string values whose ::text form still carries its quotes, which the uuid cast
  -- then rejects.
  select coalesce(array_agg(value::uuid), '{}')
    into v_payments
  from jsonb_array_elements_text(v_chain->'payment_ids');

  -- ── The audit entry, written BEFORE anything is removed ───────────────────
  insert into public.test_data_cleanup_audit (
    performed_by, performed_by_email, reason, confirmation,
    root_type, root_id, root_number,
    deleted_records, table_counts, storage_paths
  )
  values (
    v_actor, v_email, btrim(p_reason), 'DELETE TEST DATA',
    p_root_type, p_root_id, v_chain->>'root_number',
    v_chain->'to_delete', v_chain->'counts', v_chain->'storage_paths'
  )
  returning id into v_audit;

  -- ── Stand the production guards down for this transaction only ────────────
  -- Everything above has already been verified. set_config(..., true) is
  -- transaction-local: it cannot outlive this call, and no client can set it.
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);

  v_ids := array_remove(array[v_order, v_request], null) || v_payments;

  -- 1. Notifications have no foreign key, so nothing removes them implicitly.
  --    Scoped to this chain's uuids and to Order/Finance types, so a task
  --    notification that happens to share an id can never be caught.
  delete from public.notifications
   where entity_id = any(v_ids)
     and (type::text like 'order%' or type::text like 'finance%');
  get diagnostics v_n_notif = row_count;

  -- 2. Payments. payment_proof_attachments and
  --    finance_payment_request_activity_log both cascade with the row.
  delete from public.finance_payment_requests where id = any(v_payments);
  get diagnostics v_n_pay = row_count;

  -- 3. Release the provenance reference so the mutual FK lock opens. Both rows
  --    are deleted immediately below, so this state is never observable.
  if v_order is not null and v_request is not null then
    update public.orders
       set source_order_request_id = null,
           source_request_number   = null
     where id = v_order;
  end if;

  -- 4. The request (order_request_activity cascades).
  delete from public.order_requests where id = v_request;
  get diagnostics v_n_req = row_count;

  -- 5. The Order (order_activity_log cascades).
  delete from public.orders where id = v_order;
  get diagnostics v_n_ord = row_count;

  update public.test_data_cleanup_audit
     set result = jsonb_build_object(
           'notifications',    v_n_notif,
           'payment_requests', v_n_pay,
           'order_requests',   v_n_req,
           'orders',           v_n_ord
         )
   where id = v_audit;

  -- Storage paths are RETURNED, never deleted here: object storage is not part
  -- of this transaction, so a file removed now could not be restored if the
  -- transaction rolled back. The caller deletes them only after this commits.
  return jsonb_build_object(
    'audit_id',      v_audit,
    'root_type',     p_root_type,
    'root_number',   v_chain->>'root_number',
    'deleted',       jsonb_build_object(
                       'orders',           v_n_ord,
                       'order_requests',   v_n_req,
                       'payment_requests', v_n_pay,
                       'notifications',    v_n_notif
                     ),
    'deleted_records', v_chain->'to_delete',
    'retained',        v_chain->'to_retain',
    'storage_paths',   v_chain->'storage_paths'
  );
end;
$$;

revoke execute on function public.execute_test_data_cleanup(text, uuid, text, text) from public, anon;
grant  execute on function public.execute_test_data_cleanup(text, uuid, text, text) to authenticated;

comment on function public.execute_test_data_cleanup(text, uuid, text, text) is
  'Admin-only. Removes one complete verified test transaction chain in a single transaction, after checking admin, enabled setting, reason, typed confirmation and per-record test-data eligibility. Writes a permanent audit row first. Never touches numbering: no sequence is reset and order_number_cycle is not reduced, so a deleted Order number is never reused.';

-- ── 8. What this migration deliberately does NOT do ───────────────────────────
--
--   * No sequence is reset, restarted or advanced; order_number_cycle is never
--     read or written. A cleaned-up Order number is retired, not recycled.
--   * No production protection from 20260705000000 is weakened. The guards are
--     still armed for every other transaction in the system.
--   * No storage object is deleted from SQL — paths are returned for the caller
--     to remove after the transaction commits.
--   * No full row snapshots are stored in the audit; numbers and counts only.

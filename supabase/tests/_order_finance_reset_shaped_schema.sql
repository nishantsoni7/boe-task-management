-- A production-shaped database for the Order & Finance module reset.
--
-- WHAT THIS IS AND IS NOT. It is not the schema — 201 applied migrations are.
-- It is every structure 20261010000000 reads, writes, guards or asserts against,
-- reproduced with the SAME column types, the SAME foreign-key delete rules and
-- the SAME guard triggers, so that applying the migration here exercises the
-- real thing rather than a sketch. Anything the migration does not touch is
-- absent on purpose: a fixture that grows to match the whole system stops being
-- readable and starts being a second source of truth.
--
-- THE FOREIGN KEY DELETE RULES ARE THE POINT. Every NO ACTION below is NO ACTION
-- in the applied schema, and 20261010000000 §11 asserts the exact list against
-- pg_constraint — so if this file got one wrong, the migration refuses itself
-- here rather than passing on a fiction.
--
-- Used by run_order_finance_reset_suite.sh, which builds a database from this
-- file, applies the migration, and runs order_finance_reset_assertions.sql.

-- The Supabase role model, as much of it as the grants in the migration name.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public to anon, authenticated, service_role;

-- auth.uid(), as Supabase provides it: the session's JWT claim.
-- Tolerates an absent or blank claim exactly as the deployed one does: a
-- session with no JWT is anonymous, not an error.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub',
    nullif(current_setting('request.jwt.claim.sub', true), '')), '')::uuid
$$;

create table storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name      text not null,
  metadata  jsonb,
  unique (bucket_id, name)
);

-- ── People ──────────────────────────────────────────────────────────────────
create table public.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  role       text not null default 'employee',
  is_active  boolean not null default true,
  is_deleted boolean not null default false
);

create table public.notifications (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid,
  type      text not null,
  user_id   uuid references public.users(id)
);

-- ── Orders ──────────────────────────────────────────────────────────────────
create table public.order_requests (
  id                uuid primary key default gen_random_uuid(),
  request_number    text,
  status            text not null default 'pending',
  client_name       text,
  converted_order_id uuid,
  is_test_data      boolean not null default false
);

create table public.orders (
  id                  uuid primary key default gen_random_uuid(),
  display_number      text,
  status              text not null default 'confirmed',
  client_name         text,
  source_order_request_id uuid references public.order_requests(id),
  source_request_number   text,
  is_test_data        boolean not null default false
);

alter table public.order_requests
  add constraint order_requests_converted_order_fk
  foreign key (converted_order_id) references public.orders(id);

create table public.order_submissions (
  id                    uuid primary key default gen_random_uuid(),
  client_name           text,
  status                text not null default 'draft',
  created_by            uuid references public.users(id),
  submitted_by          uuid references public.users(id),
  order_id              uuid references public.orders(id),
  source_workbook_path  text,
  grand_total           numeric,
  deletion_claim_token  uuid,
  deletion_claimed_at   timestamptz,
  deletion_claimed_by   uuid,
  updated_at            timestamptz not null default now()
);

alter table public.orders
  add column source_order_submission_id uuid references public.order_submissions(id);

create table public.order_submission_items (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.order_submissions(id) on delete cascade,
  product_name  text,
  unique (id, submission_id)
);

create table public.order_submission_item_images (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.order_submissions(id) on delete cascade,
  item_id       uuid not null,
  storage_path  text not null,
  foreign key (item_id, submission_id)
    references public.order_submission_items(id, submission_id) on delete cascade
);

create table public.order_submission_activity (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.order_submissions(id) on delete cascade,
  action        text not null default 'created'
);

create table public.order_submission_correction_requests (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.order_submissions(id),
  section       text not null default 'other',
  status        text not null default 'open',
  resolved_edit_activity_id uuid references public.order_submission_activity(id)
);

create table public.order_activity_log (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  event_type text not null default 'created'
);

create table public.order_change_requests (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status   text not null default 'open'
);

create table public.order_document_versions (
  id       uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  version  integer not null default 1,
  status   text not null default 'ready'
);

create table public.order_request_activity (
  id               uuid primary key default gen_random_uuid(),
  order_request_id uuid not null references public.order_requests(id) on delete cascade,
  action           text not null default 'created'
);

create table public.order_request_attachments (
  id               uuid primary key default gen_random_uuid(),
  order_request_id uuid not null references public.order_requests(id) on delete cascade,
  storage_path     text not null unique
);

create table public.order_number_cycle (
  id           boolean primary key default true,
  next_number  bigint  not null default 1,
  constraint order_number_cycle_singleton check (id)
);
insert into public.order_number_cycle (id, next_number) values (true, 1);

-- ── Finance ─────────────────────────────────────────────────────────────────
create table public.finance_payment_requests (
  id               uuid primary key default gen_random_uuid(),
  request_number   text,
  client_name      text,
  amount           numeric not null default 0,
  status           text not null default 'pending_approval',
  order_id         uuid references public.orders(id) on delete set null,
  order_request_id uuid references public.order_requests(id),
  submitted_by     uuid references public.users(id),
  is_test_data     boolean not null default false
);

create table public.finance_payment_request_activity_log (
  id                 uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.finance_payment_requests(id) on delete cascade,
  event_type         text not null default 'created'
);

create table public.payment_proof_attachments (
  id                 uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.finance_payment_requests(id) on delete cascade,
  storage_path       text not null unique
);

create table public.finance_payment_allocations (
  id                  uuid primary key default gen_random_uuid(),
  payment_request_id  uuid not null references public.finance_payment_requests(id),
  order_submission_id uuid references public.order_submissions(id),
  order_id            uuid references public.orders(id),
  allocated_amount    numeric not null default 1,
  status              text not null default 'active',
  origin_target_type  text not null default 'order_submission',
  created_by          uuid references public.users(id),
  is_test_data        boolean not null default false,
  constraint finance_payment_allocations_one_target
    check (num_nonnulls(order_submission_id, order_id) = 1)
);

-- The canonical definition of "verified", reproduced from 20260918000000 §5
-- because §11 of the migration under test calls it rather than restating the
-- status list. Byte-equivalent to the deployed body: two statuses, and nothing
-- else is verified money.
create or replace function public.finance_payment_status_is_verified(p_status text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(p_status in ('approved_unlinked', 'approved_linked'), false)
$$;

-- ── The cleanup protocol, as 20260705/20260706/20260916 left it ─────────────
create or replace function public.in_test_data_cleanup()
returns boolean language sql stable set search_path = public as $$
  select coalesce(current_setting('boe.cleanup_context', true), '') = 'test_data_cleanup';
$$;

create table public.test_data_cleanup_settings (
  id                   boolean primary key default true,
  enabled              boolean not null default false,
  permanently_disabled boolean not null default false,
  enabled_at           timestamptz,
  enabled_by           uuid references public.users(id) on delete set null,
  disabled_at          timestamptz,
  disabled_by          uuid references public.users(id) on delete set null,
  disabled_by_email    text,
  constraint test_data_cleanup_settings_singleton check (id),
  constraint test_data_cleanup_settings_disable_is_final
    check (not (enabled and permanently_disabled))
);
insert into public.test_data_cleanup_settings (id, enabled, permanently_disabled, enabled_at)
values (true, true, false, now());

create table public.test_data_cleanup_audit (
  id                 uuid primary key default gen_random_uuid(),
  performed_by       uuid references public.users(id) on delete set null,
  performed_by_email text,
  performed_at       timestamptz not null default now(),
  reason             text not null,
  confirmation       text not null,
  root_type          text not null,
  root_id            uuid,
  root_number        text,
  deleted_records    jsonb not null default '[]'::jsonb,
  table_counts       jsonb not null default '{}'::jsonb,
  storage_paths      jsonb not null default '[]'::jsonb,
  result             jsonb not null default '{}'::jsonb,
  constraint test_data_cleanup_audit_reason_not_blank check (btrim(reason) <> '')
);

create table public.test_data_cleanup_claims (
  id                  uuid primary key default gen_random_uuid(),
  claim_token         uuid not null unique default gen_random_uuid(),
  root_type           text not null,
  root_id             uuid not null,
  root_number         text,
  order_id            uuid,
  order_request_id    uuid,
  order_submission_id uuid,
  payment_ids         uuid[] not null default '{}',
  chain               jsonb  not null default '{}'::jsonb,
  reason              text not null,
  confirmation        text not null,
  claimed_by          uuid references public.users(id) on delete set null,
  claimed_by_email    text,
  claimed_at          timestamptz not null default now(),
  storage_prefix      text,
  finalized_at        timestamptz,
  audit_id            uuid references public.test_data_cleanup_audit(id) on delete set null,
  result              jsonb not null default '{}'::jsonb,
  constraint test_data_cleanup_claims_reason_not_blank check (btrim(reason) <> ''),
  constraint test_data_cleanup_claims_root_type_known
    check (root_type in ('order', 'order_request', 'payment'))
);

create unique index test_data_cleanup_claims_open_root_uidx
  on public.test_data_cleanup_claims (root_type, root_id) where finalized_at is null;

-- stamp / immutability, verbatim in behaviour from 20260706000000 §1.2–1.3
create or replace function public.stamp_test_data_flag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.is_test_data := coalesce(
    (select s.enabled and not s.permanently_disabled
       from public.test_data_cleanup_settings s where s.id = true), false);
  return new;
end; $$;

create or replace function public.prevent_test_data_flag_change()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.is_test_data is distinct from old.is_test_data then
    raise exception
      'TEST_DATA_FLAG_IMMUTABLE: Whether a record is test data is fixed when it is created and cannot be changed'
      using errcode = '42501';
  end if;
  return new;
end; $$;

create trigger orders_stamp_test_data before insert on public.orders
  for each row execute function public.stamp_test_data_flag();
create trigger orders_protect_test_data before update on public.orders
  for each row execute function public.prevent_test_data_flag_change();
create trigger order_requests_stamp_test_data before insert on public.order_requests
  for each row execute function public.stamp_test_data_flag();
create trigger finance_payment_requests_stamp_test_data before insert on public.finance_payment_requests
  for each row execute function public.stamp_test_data_flag();
create trigger finance_payment_allocations_stamp_test_data before insert on public.finance_payment_allocations
  for each row execute function public.stamp_test_data_flag();

-- ── The production protections (20260705000000, 20260918000000 §8) ──────────
create or replace function public.prevent_order_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.in_test_data_cleanup() then return old; end if;
  raise exception 'ORDER_DELETE_BLOCKED: Confirmed Order % is permanent business history and cannot be deleted',
    old.display_number using errcode = '42501';
end; $$;
create trigger orders_prevent_delete before delete on public.orders
  for each row execute function public.prevent_order_delete();

create or replace function public.prevent_converted_order_request_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.in_test_data_cleanup() then return old; end if;
  if old.status = 'converted' or old.converted_order_id is not null then
    raise exception 'ORDER_REQUEST_CONVERTED_PERMANENT: Order Request % created a Confirmed Order',
      old.request_number using errcode = '42501';
  end if;
  return old;
end; $$;
create trigger order_requests_prevent_converted_delete before delete on public.order_requests
  for each row execute function public.prevent_converted_order_request_delete();

create or replace function public.finance_payment_requests_guard_approved_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.in_test_data_cleanup() then return old; end if;
  if old.status in ('approved_unlinked', 'approved_linked') then
    raise exception 'PAYMENT_APPROVED_PERMANENT: Payment % has been approved and is permanent bank payment history',
      old.request_number using errcode = '42501';
  end if;
  return old;
end; $$;
create trigger finance_payment_requests_guard_approved_delete before delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_guard_approved_delete();

create or replace function public.in_payment_allocation_release(p_payment_id uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select coalesce(nullif(current_setting('boe.payment_allocation_release', true), ''), '') = p_payment_id::text
$$;

create or replace function public.finance_payment_allocations_guard_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.in_test_data_cleanup() then return old; end if;
  if public.in_payment_allocation_release(old.payment_request_id) then return old; end if;
  raise exception 'ALLOCATION_PERMANENT: allocation % is a financial record and cannot be deleted. Reverse it instead.',
    old.id using errcode = '42501';
end; $$;
create trigger finance_payment_allocations_guard_delete before delete on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_guard_delete();

create or replace function public.finance_payment_requests_release_allocations()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform set_config('boe.payment_allocation_release', old.id::text, true);
  delete from public.finance_payment_allocations where payment_request_id = old.id;
  perform set_config('boe.payment_allocation_release', '', true);
  return old;
end; $$;
create trigger finance_payment_requests_release_allocations before delete on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_release_allocations();

-- ── The PI deletion claim guard (20260914000000 §4), for §4 of the migration ─
create or replace function public.order_submissions_guard_deletion_claim()
returns trigger language plpgsql as $$
declare
  v_claim_columns text[] := array['deletion_claim_token','deletion_claimed_at','deletion_claimed_by','updated_at'];
begin
  if old.deletion_claim_token is null then return new; end if;
  if coalesce(current_setting('boe.order_submission_purge_id', true), '') = old.id::text then return new; end if;
  if (to_jsonb(new) - v_claim_columns) = (to_jsonb(old) - v_claim_columns) then return new; end if;
  raise exception 'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be changed'
    using errcode = '55P03';
end; $$;
create trigger order_submissions_guard_deletion_claim before update on public.order_submissions
  for each row execute function public.order_submissions_guard_deletion_claim();

-- ── The number-cycle reset (20260926000000 §2), gates 0–4 ──────────────────
create table public.order_number_cycle_resets (
  id            uuid primary key default gen_random_uuid(),
  performed_by  uuid references public.users(id) on delete set null,
  performed_at  timestamptz not null default now(),
  previous_next bigint not null,
  new_next      bigint not null,
  claim_id      uuid references public.test_data_cleanup_claims(id) on delete set null,
  evidence      jsonb not null default '{}'::jsonb
);

create or replace function public.reset_confirmed_order_number_cycle(p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_claim public.test_data_cleanup_claims%rowtype;
  v_prev  bigint;
  v_n     bigint;
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin'
                   and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'ORDER_NUMBER_RESET_FORBIDDEN: Only an active admin may reset the Confirmed Order number cycle'
      using errcode = '42501';
  end if;

  select c.next_number into v_prev from public.order_number_cycle c where c.id = true for update;

  if p_claim_token is null then
    raise exception 'ORDER_NUMBER_RESET_NO_CLAIM: a finalized Test Data Cleanup claim is required'
      using errcode = '42501';
  end if;
  select * into v_claim from public.test_data_cleanup_claims where claim_token = p_claim_token;
  if not found then
    raise exception 'ORDER_NUMBER_RESET_CLAIM_INVALID: that cleanup claim is not valid' using errcode = '42501';
  end if;
  if v_claim.finalized_at is null then
    raise exception 'ORDER_NUMBER_RESET_CLAIM_UNFINISHED: that cleanup has not been finalized' using errcode = '42501';
  end if;

  select count(*) into v_n from public.orders;
  if v_n <> 0 then
    raise exception 'ORDER_NUMBER_RESET_ORDERS_EXIST: % Order(s) still exist', v_n using errcode = '42501';
  end if;
  select count(*) into v_n from public.order_submissions s
   where s.status in ('submitted','approved') or s.order_id is not null;
  if v_n <> 0 then
    raise exception 'ORDER_NUMBER_RESET_APPROVAL_PENDING: % PI submission(s) are submitted or approved', v_n
      using errcode = '42501';
  end if;
  select count(*) into v_n from public.finance_payment_allocations a
   where a.order_id is not null or a.order_submission_id is not null;
  if v_n <> 0 then
    raise exception 'ORDER_NUMBER_RESET_ALLOCATIONS_EXIST: % allocation(s) still name an Order or PI', v_n
      using errcode = '42501';
  end if;

  update public.order_number_cycle set next_number = 1 where id = true;
  insert into public.order_number_cycle_resets (performed_by, previous_next, new_next, claim_id, evidence)
  values (v_actor, v_prev, 1, v_claim.id, jsonb_build_object('orders', 0, 'scope', v_claim.scope));

  return jsonb_build_object('previous_next', v_prev, 'new_next', 1);
end; $$;

-- The chain protocol's own resolver, reduced to the one behaviour §11 asserts:
-- an unknown root type is refused, which is what makes a module claim fail
-- closed if it is ever handed to the chain finalizer.
create or replace function public.resolve_test_data_cleanup_chain(p_root_type text, p_root_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_root_type not in ('order', 'order_request', 'payment') then
    raise exception 'CLEANUP_ROOT_TYPE_INVALID: Unknown record type %', p_root_type using errcode = 'P0001';
  end if;
  return jsonb_build_object('eligible', true);
end; $$;

create or replace function public.begin_test_data_cleanup(
  p_root_type text, p_root_id uuid, p_reason text, p_confirmation text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);
  return jsonb_build_object('claim_token', null);
end; $$;

create or replace function public.finalize_test_data_cleanup(p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_claim public.test_data_cleanup_claims%rowtype;
begin
  select * into v_claim from public.test_data_cleanup_claims where claim_token = p_claim_token;
  if not found then
    raise exception 'CLEANUP_CLAIM_INVALID: this cleanup claim is not valid' using errcode = '42501';
  end if;
  -- Fails closed for a module claim: the root type is not one this resolver knows.
  perform public.resolve_test_data_cleanup_chain(v_claim.root_type, v_claim.root_id);
  return jsonb_build_object('ok', true);
end; $$;

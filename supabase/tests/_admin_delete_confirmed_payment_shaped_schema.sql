-- Shaped schema for run_admin_delete_confirmed_payment_suite.sh (20270331000000).
--
-- Just what begin/finalize_finance_payment_deletion, finance_payment_deletable_by
-- and the delete guard read or write. The runner installs the DEPLOYED bodies of
-- the helpers and the 20261011000000 / 20261218000000 versions of the four
-- functions this migration re-emits, then applies the migration itself.
--
-- SHAPED, NOT THE REAL TABLES: finance_payment_allocations is reduced to the
-- columns the functions read, and the real "release allocations" trigger is
-- stood in for by a BEFORE DELETE trigger that deletes the payment's allocations.
-- A disposable database only. It never talks to a linked project.

-- Roles are cluster-wide, so a second run must not trip on the first one's.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.users (
  id         uuid primary key,
  email      text,
  role       text not null default 'employee',
  is_active  boolean not null default true,
  is_deleted boolean default false
);

create table public.finance_payment_requests (
  id               uuid primary key,
  request_number   text,
  human_payment_id text,
  status           text not null,
  amount           numeric(14,2) not null default 100,
  client_name      text,
  is_test_data     boolean not null default false
);

create table public.finance_payment_allocations (
  id                 uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.finance_payment_requests(id),
  order_id           uuid,
  order_submission_id uuid,
  allocated_amount   numeric(14,2) not null default 100,
  status             text not null default 'active',
  created_at         timestamptz not null default now()
);

create function public.shaped_release_allocations() returns trigger language plpgsql as $$
begin
  delete from public.finance_payment_allocations where payment_request_id = old.id;
  return old;
end $$;
create trigger shaped_release_allocations
  before delete on public.finance_payment_requests
  for each row execute function public.shaped_release_allocations();

create table public.payment_proof_attachments (
  id                 uuid primary key default gen_random_uuid(),
  payment_request_id uuid not null references public.finance_payment_requests(id) on delete cascade,
  storage_path       text
);

-- Same columns and foreign key as 20270329000000 (the FK is NO ACTION: this is
-- the constraint the migration's clearing of undone links exists for).
create table public.bank_line_payment_links (
  id          uuid primary key default gen_random_uuid(),
  line_id     uuid not null,
  payment_id  uuid not null references public.finance_payment_requests(id),
  amount      numeric(14,2) not null check (amount > 0),
  linked_by   uuid not null references public.users(id),
  linked_at   timestamptz not null default now(),
  unlinked_by uuid null references public.users(id),
  unlinked_at timestamptz null,
  constraint bank_line_payment_links_unlink_pair
    check ((unlinked_by is null) = (unlinked_at is null))
);

-- Same columns as the deployed claim table (20261010000000 + 20261011000000),
-- without the claimed_by foreign key and the status check.
create table public.finance_payment_deletion_claims (
  id                 uuid        primary key default gen_random_uuid(),
  claim_token        uuid        not null unique default gen_random_uuid(),
  payment_id         uuid        not null,
  payment_number     text,
  payment_status     text        not null,
  storage_paths      text[]      not null default '{}',
  storage_removed    text[]      not null default '{}',
  allocation_ids     uuid[]      not null default '{}',
  claimed_by         uuid,
  claimed_by_email   text,
  claimed_at         timestamptz not null default now(),
  finalized_at       timestamptz,
  released_at        timestamptz,
  result             jsonb       not null default '{}'::jsonb,
  human_payment_id   text,
  amount             numeric(14,2),
  customer_name      text,
  deletion_reason    text,
  allocation_details jsonb
);

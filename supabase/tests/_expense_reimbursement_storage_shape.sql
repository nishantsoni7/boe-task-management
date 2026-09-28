-- ── SHAPER, NOT A SUITE ─────────────────────────────────────────────────────
--
-- The smallest storage schema 20270205120000 needs on a disposable database:
-- storage.buckets and storage.objects with the columns its policies read, RLS on,
-- and the client grants Supabase's own storage schema gives. Applied after
-- _expense_lifecycle_shaped_schema.sql by run_expense_reimbursement_suite.sh.
-- Never deploys.

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner_id text,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY STUBS — decimal credits (20261204000000) and Custom Review
-- Submissions (20261205000000) on a bare PostgreSQL container
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- The bare-container chain (002 baseline → payroll periods → 1A → 1C → 003
-- stubs → 1D) stops short of three things the two migrations under test need,
-- and each is created here in its smallest form:
--
--   1. boe_credit_settings.image_review_reward_credits — added by
--      20261107000000, which cannot run here (it needs the whole Review
--      Workflow chain). The column is added exactly as that migration adds it,
--      as an INTEGER, so the decimal migration's conversion is exercised.
--   2. public.resolve_permission(uuid, text, text) — the permission engine,
--      reduced to a grants table the suite fills. Same signature and return
--      type as production; nothing else about the engine is reproduced.
--   3. Supabase Storage — storage.buckets and storage.objects, only the columns
--      the migration writes and its SELECT policy reads, with row security on.
--
-- Nothing here is taken from production.

-- ─── 1. The image review reward, as 20261107000000 added it ─────────────────

alter table public.boe_credit_settings
  add column if not exists image_review_reward_credits integer not null default 1
    check (image_review_reward_credits > 0 and image_review_reward_credits <= 100000);

-- ─── 2. The permission engine, as a table ───────────────────────────────────

create table if not exists public.test_permission_grants (
  user_id    uuid not null,
  module_key text not null,
  action_key text not null,
  primary key (user_id, module_key, action_key)
);

create or replace function public.resolve_permission(p_user_id uuid, p_module_key text, p_action_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.test_permission_grants g
     where g.user_id = p_user_id and g.module_key = p_module_key and g.action_key = p_action_key
  );
$$;

grant execute on function public.resolve_permission(uuid, text, text) to authenticated, service_role;

-- ─── 3. Storage, reduced ────────────────────────────────────────────────────

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name      text not null
);

alter table storage.objects enable row level security;
grant select on storage.objects to authenticated;

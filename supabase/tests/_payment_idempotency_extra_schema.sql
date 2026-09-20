-- TEST-ONLY. Brings the shaped Orders/Finance schema (the chain
-- run_payment_entry_edit_race.sh builds through 20261014000000) up to
-- PRODUCTION'S shape for everything 20261219000000 reads or changes.
-- run_payment_idempotency_suite.sh appends the deployed function bodies,
-- extracted verbatim from their own migrations.
--
-- Every addition below exists in production; the source is named on each line.

-- order_submissions columns the discard rule reads.
alter table public.order_submissions
  add column if not exists processing_token      uuid,          -- 20260909000000
  add column if not exists processing_started_at timestamptz,   -- 20260909000000
  add column if not exists reserved_order_number text,          -- 20261009000000
  add column if not exists assigned_to           uuid;          -- read by record_pi_submission_payment

-- The activity trail as 20260908000000 created it.
alter table public.order_submission_activity
  add column if not exists actor_id        uuid,
  add column if not exists previous_status text,
  add column if not exists new_status      text,
  add column if not exists note            text,
  add column if not exists metadata        jsonb not null default '{}'::jsonb,
  add column if not exists created_at      timestamptz not null default now();

-- 20261119000000: a PI version cascades from its submission.
create table if not exists public.order_pi_versions (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid references public.orders(id) on delete cascade,
  submission_id uuid not null references public.order_submissions(id) on delete cascade
);

-- THE DIRECT INSERT DOOR, as production has it (read-only catalog check,
-- 2026-09-19: has_table_privilege('authenticated', …, 'INSERT') = true and one
-- INSERT policy). Supabase's default privileges grant the table to
-- authenticated; 20260628000200 wrote the policy.
grant select, insert, update, delete on public.finance_payment_requests to authenticated;
drop policy if exists "finance_payment_requests_own_insert" on public.finance_payment_requests;
create policy "finance_payment_requests_own_insert"
  on public.finance_payment_requests
  for insert to authenticated
  with check (submitted_by = auth.uid());
drop policy if exists "finance_payment_requests_own_select" on public.finance_payment_requests;
create policy "finance_payment_requests_own_select"
  on public.finance_payment_requests
  for select to authenticated
  using (submitted_by = auth.uid());

-- PI Drafts are read under RLS; the creator's own read is what the list shows
-- them (20260908000000 grants the creator a read, among others).
alter table public.order_submissions enable row level security;
grant select on public.order_submissions to authenticated;
drop policy if exists "order_submissions_creator_select" on public.order_submissions;
create policy "order_submissions_creator_select"
  on public.order_submissions
  for select to authenticated
  using (created_by = auth.uid());

-- The Finance activity trail as 20260675_… created it; the runner installs the
-- deployed log_finance_payment_request_activity() (20260716000000) on it.
alter table public.finance_payment_request_activity_log
  add column if not exists actor_id   uuid,
  add column if not exists payload    jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

-- PRODUCTION'S FUNCTION PRIVILEGES for the reset write guard (read-only catalog
-- check, 2026-09-19): authenticated holds EXECUTE on neither
-- in_test_data_cleanup() nor open_order_finance_reset_scope(), and the guard
-- is not SECURITY DEFINER — so a direct client write to finance_payment_requests
-- is refused there with "permission denied for function".
revoke execute on function public.in_test_data_cleanup() from public, anon, authenticated;
revoke execute on function public.open_order_finance_reset_scope() from public, anon, authenticated;

-- MODULE ENTRY IN PRODUCTION'S SHAPE (20260905000000): an admin passes on role
-- alone — production does not ask whether that admin is still active — and
-- anyone else passes on a Finance/Orders grant (the stand-in for
-- resolve_permission). So a deactivated ADMIN is refused by the replay check's
-- own active test, not by this function.
create or replace function public.module_entry_open(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or exists (select 1 from public.users u
                   join public.finance_permission_grants g on g.user_id = u.id
                  where u.id = auth.uid() and u.is_active and coalesce(u.is_deleted, false) = false
                    and g.action like p_module || '.%')
$$;

-- Columns the deployed decision guard and reject door read (20261211000000).
alter table public.finance_payment_requests
  add column if not exists admin_note  text;

-- As on every Supabase project: signed-in roles may call auth.uid().
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;

-- Production's permission helper is SECURITY DEFINER with a fixed search_path
-- (20260901000000); the shaped stand-in is made the same.
alter function public.actor_has_module_permission(text, text) security definer set search_path = public, pg_temp;

-- A VERIFIER SEES AND MAY UPDATE the payments they decide, as production's
-- verifier policies allow — so a verifier's direct UPDATE reaches the row and
-- its triggers (the defect 20261219000000 §5 routes around), instead of
-- silently matching nothing.
drop policy if exists "finance_payment_requests_verifier_select" on public.finance_payment_requests;
create policy "finance_payment_requests_verifier_select"
  on public.finance_payment_requests for select to authenticated
  using (public.actor_has_module_permission('finance', 'approve'));
drop policy if exists "finance_payment_requests_verifier_update" on public.finance_payment_requests;
create policy "finance_payment_requests_verifier_update"
  on public.finance_payment_requests for update to authenticated
  using (public.actor_has_module_permission('finance', 'approve'));

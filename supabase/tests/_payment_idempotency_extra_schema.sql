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

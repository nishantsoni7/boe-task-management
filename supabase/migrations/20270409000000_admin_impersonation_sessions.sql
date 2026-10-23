-- Admin "Login as member": audit trail of every impersonation session.
-- One row per login-as. Written ONLY by the service-role API routes /api/impersonation/{start,end};
-- no browser role can read or write it. Rollback: drop table public.admin_impersonation_sessions.

create table if not exists public.admin_impersonation_sessions (
  id              uuid primary key default gen_random_uuid(),
  admin_id        uuid not null references public.users(id),
  target_user_id  uuid not null references public.users(id),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  ip_address      text,
  user_agent      text
);

create index if not exists admin_impersonation_sessions_admin_idx
  on public.admin_impersonation_sessions (admin_id, started_at desc);
create index if not exists admin_impersonation_sessions_target_idx
  on public.admin_impersonation_sessions (target_user_id, started_at desc);

alter table public.admin_impersonation_sessions enable row level security;

-- Deliberately no policies: RLS denies every non-service-role caller.
revoke all on public.admin_impersonation_sessions from anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- TEST-ONLY STUBS — BOE Credits Phase 1D on a bare PostgreSQL container
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THIS FILE MUST NEVER ENTER supabase/migrations, AND MUST NEVER DEPLOY.
--
-- 20261104000000 re-creates transition_customer_review_test_card(), whose
-- body declares `c public.customer_review_test_cards%rowtype`. PL/pgSQL
-- resolves that declaration when the function is CREATED, so on a bare
-- container — which has no Review Workflow chain — the migration cannot even
-- be applied without the table existing. This file creates the smallest
-- relation that lets it compile. The transition is NEVER EXECUTED here: the
-- bare-container suite proves the credits functions the transition calls
-- (post_boe_credit_review_reward and everything below it); the transition
-- itself is proven on a full local Supabase stack by
-- run_boe_credits_phase_1d_stack_local.sh, where the real table exists.
--
-- Column names and types are quoted from 20261017000000; nothing here is
-- taken from production.

create table if not exists public.customer_review_test_cards (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'available',
  card_ref      text not null,
  booked_by     uuid,
  booked_at     timestamptz,
  submitted_at  timestamptz,
  submitted_by  uuid,
  verified_at   timestamptz,
  verified_by   uuid,
  deleted_at    timestamptz
);

create table if not exists public.customer_review_test_card_events (
  id              uuid primary key default gen_random_uuid(),
  card_id         uuid not null,
  event_type      text not null,
  previous_status text,
  new_status      text,
  detail          text,
  actor_id        uuid,
  created_at      timestamptz not null default now()
);

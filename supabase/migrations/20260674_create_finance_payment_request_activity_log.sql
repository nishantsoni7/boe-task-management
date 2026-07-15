-- Finance: Payment Request activity log (Phase 2B)
--
-- Append-only ledger of lifecycle and order-linking events on a
-- finance_payment_requests row. Mirrors order_activity_log's shape exactly
-- (generic event_type + jsonb payload, actor_id nullable FK, no update/delete
-- policy) rather than task_activity_log's older fixed-column design.
--
-- event_type values:
--   request_submitted          -> payload: {} (or {backfilled:true, status_at_backfill})
--   clarification_requested    -> payload: { from, to, note }
--   clarification_submitted    -> payload: { from, to }
--   request_rejected           -> payload: { from, to, note }
--   request_approved_unlinked  -> payload: { from, to }
--   request_approved_linked    -> payload: { from, to, order_id, order_number }
--   order_linked               -> payload: { order_id, order_number }
--   order_link_changed         -> payload: { from_order_id, from_order_number, to_order_id, to_order_number }
--   order_unlinked             -> payload: { order_id, order_number }
--   status_corrected_by_admin  -> payload: { from, to, note }
--
-- on delete cascade (not restrict): finance_payment_requests already supports
-- an unrestricted admin Delete action today. Restricting the FK would break
-- that existing feature the moment any request has logged activity, since
-- every request gets a request_submitted row on creation.

create table public.finance_payment_request_activity_log (
  id                  uuid        primary key default gen_random_uuid(),
  payment_request_id  uuid        not null references public.finance_payment_requests(id) on delete cascade,
  actor_id            uuid        references public.users(id) on delete set null,
  event_type          text        not null
                        check (event_type in (
                          'request_submitted',
                          'clarification_requested',
                          'clarification_submitted',
                          'request_rejected',
                          'request_approved_unlinked',
                          'request_approved_linked',
                          'order_linked',
                          'order_link_changed',
                          'order_unlinked',
                          'status_corrected_by_admin'
                        )),
  payload             jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

create index finance_payment_request_activity_log_request_created_idx
  on public.finance_payment_request_activity_log (payment_request_id, created_at);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Mirrors finance_payment_requests' own two-role model exactly: submitter sees
-- their own request's activity, admin sees all. No separate operations/team
-- policy exists on the parent table, so none is added here either.

alter table public.finance_payment_request_activity_log enable row level security;

create policy "finance_payment_request_activity_log_own_select"
  on public.finance_payment_request_activity_log
  for select to authenticated
  using (
    exists (
      select 1 from public.finance_payment_requests r
      where r.id = payment_request_id and r.submitted_by = auth.uid()
    )
  );

create policy "finance_payment_request_activity_log_admin_select"
  on public.finance_payment_request_activity_log
  for select to authenticated
  using (
    exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- Insert: actor must be the caller themselves, and the caller must currently
-- be allowed to act on this request (owner or admin). This prevents a client
-- from fabricating rows for someone else's request or attributing an entry
-- to another user, without requiring a DB trigger.

create policy "finance_payment_request_activity_log_own_insert"
  on public.finance_payment_request_activity_log
  for insert to authenticated
  with check (
    actor_id = auth.uid()
    and exists (
      select 1 from public.finance_payment_requests r
      where r.id = payment_request_id and r.submitted_by = auth.uid()
    )
  );

create policy "finance_payment_request_activity_log_admin_insert"
  on public.finance_payment_request_activity_log
  for insert to authenticated
  with check (
    actor_id = auth.uid()
    and exists (select 1 from public.users where users.id = auth.uid() and users.role = 'admin')
  );

-- No update or delete policy: append-only, same convention as order_activity_log.

-- ── Backfill ──────────────────────────────────────────────────────────────────
-- One synthetic request_submitted row per existing request, using the row's
-- own submitted_by/created_at. No fabricated approval/rejection/linking
-- timestamps — those are only known to have happened somewhere before
-- updated_at, which isn't precise enough to invent a history entry for.

insert into public.finance_payment_request_activity_log (payment_request_id, actor_id, event_type, payload, created_at)
select
  id,
  submitted_by,
  'request_submitted',
  jsonb_build_object('backfilled', true, 'status_at_backfill', status),
  created_at
from public.finance_payment_requests;

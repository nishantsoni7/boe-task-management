-- Finance Phase 2C: status-entry timestamps for rejected / needs_clarification.
--
-- Phase 2C ages rejected requests out of the active Rejected view into a
-- query-derived Archive after 30 days, and flags needs_clarification requests
-- older than 30 days as "stale". Both need to know WHEN a request entered its
-- current state.
--
-- updated_at is NOT a reliable source: set_updated_at() bumps it on EVERY write
-- (a plain field edit, an admin_note touch, an order_id null-out from an
-- order-deletion FK cascade), none of which represent a status transition. So
-- this migration adds two dedicated, database-managed timestamps:
--
--   rejected_at                -> when the row last entered status 'rejected'
--   clarification_requested_at -> when the row last entered 'needs_clarification'
--
-- These are maintained entirely by a trigger from the REAL status transition of
-- OLD -> NEW. Client-supplied values are always overwritten, so no caller can
-- forge or freeze them. No new status and no archived boolean are introduced:
-- Archive membership stays purely query-derived from rejected_at + status.
--
-- Scope: this migration only adds two columns, one backfill, and one trigger.
-- It does not touch the status CHECK constraint, RLS policies, grants on the
-- table, the Phase 2B activity-log trigger/semantics, request numbering, the
-- payment-proof storage design, the approved_linked-requires-order_id rule, or
-- the existing admin hard-delete behavior.
--
-- Transaction safety: the whole file is wrapped in an explicit BEGIN/COMMIT.
-- DDL (including ALTER TABLE ... DISABLE/ENABLE TRIGGER) is transactional in
-- Postgres, so if any statement between the disable and re-enable of
-- finance_payment_requests_set_updated_at fails, the ROLLBACK undoes the
-- disable along with everything else — the trigger can never be left disabled
-- by a partial run. If the runner already wraps file execution in its own
-- transaction, this BEGIN is a harmless no-op (Postgres just warns "there is
-- already a transaction in progress" and continues in the outer transaction).

begin;

-- ── 1. Columns ────────────────────────────────────────────────────────────────

alter table public.finance_payment_requests
  add column if not exists rejected_at                timestamptz,
  add column if not exists clarification_requested_at timestamptz;

-- ── 2. Conservative backfill ──────────────────────────────────────────────────
-- Best available historical approximation for rows that entered their state
-- before these columns existed: use updated_at. For an untouched rejected /
-- clarification row, updated_at IS the transition moment; for a later-edited row
-- it is an upper bound (age is under-estimated, so such a row stays visible
-- LONGER — the fail-safe direction, never archived/staled early).
--
-- set_updated_at() is temporarily disabled so reading updated_at into the new
-- columns does not, as a side effect, bump updated_at itself to now() on every
-- backfilled row. The new timestamp trigger (step 3) does not exist yet, and the
-- Phase 2B AFTER activity trigger no-ops here (no status/order_id change), so no
-- activity rows are produced by this backfill.

alter table public.finance_payment_requests
  disable trigger finance_payment_requests_set_updated_at;

update public.finance_payment_requests
  set rejected_at = updated_at
  where status = 'rejected'
    and rejected_at is null;

update public.finance_payment_requests
  set clarification_requested_at = updated_at
  where status = 'needs_clarification'
    and clarification_requested_at is null;

alter table public.finance_payment_requests
  enable trigger finance_payment_requests_set_updated_at;

-- ── 3. Database-managed transition handling ───────────────────────────────────
-- A BEFORE INSERT OR UPDATE row trigger derives both timestamps from the actual
-- OLD -> NEW status transition and always overwrites whatever the client sent:
--
--   entering 'rejected'              -> rejected_at = now()
--   staying  'rejected'              -> rejected_at preserved (pinned to OLD)
--   leaving  'rejected'              -> rejected_at = null
--   entering 'needs_clarification'   -> clarification_requested_at = now()
--   staying  'needs_clarification'   -> clarification_requested_at preserved
--   leaving  'needs_clarification'   -> clarification_requested_at = null
--
-- Because every branch assigns NEW.rejected_at / NEW.clarification_requested_at,
-- a client can never set, freeze, or skew these columns by including them in an
-- insert/update — the trigger's value always wins.
--
-- Not SECURITY DEFINER: the function only writes columns of the row already
-- being mutated (which the caller is authorized to update under existing RLS)
-- and reads no other table, so no elevated privilege is required. search_path is
-- still pinned defensively. It is trigger-only, so EXECUTE is revoked from every
-- client role.

create or replace function public.finance_payment_requests_touch_status_timestamps()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (tg_op = 'INSERT') then
    new.rejected_at :=
      case when new.status = 'rejected' then now() else null end;
    new.clarification_requested_at :=
      case when new.status = 'needs_clarification' then now() else null end;
    return new;
  end if;

  -- UPDATE: rejected_at
  if (new.status = 'rejected' and old.status is distinct from 'rejected') then
    new.rejected_at := now();               -- entering rejected
  elsif (new.status = 'rejected') then
    new.rejected_at := old.rejected_at;     -- staying rejected: pin original
  else
    new.rejected_at := null;                -- not rejected: clear
  end if;

  -- UPDATE: clarification_requested_at
  if (new.status = 'needs_clarification' and old.status is distinct from 'needs_clarification') then
    new.clarification_requested_at := now();               -- entering
  elsif (new.status = 'needs_clarification') then
    new.clarification_requested_at := old.clarification_requested_at;  -- staying: pin
  else
    new.clarification_requested_at := null;                -- leaving: clear
  end if;

  return new;
end;
$$;

revoke execute on function public.finance_payment_requests_touch_status_timestamps()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_status_timestamps
  on public.finance_payment_requests;

create trigger finance_payment_requests_status_timestamps
  before insert or update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_touch_status_timestamps();

-- ── 4. Indexes ────────────────────────────────────────────────────────────────
-- None. The Finance page already loads the caller's permitted request set and
-- partitions active/archived/stale client-side, so no age predicate runs in the
-- database. An index on rejected_at / clarification_requested_at would have no
-- query to serve at current volume; add one only if a measured server-side age
-- filter is introduced later.

commit;

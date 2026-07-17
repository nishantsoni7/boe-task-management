-- Finance Phase C.1 — enforce status <-> order_id/order_number in lock-step.
--
-- Verified before writing this migration (read-only production queries, no
-- data touched): zero rows on the linked project violate either direction of
-- this invariant —
--   approved_unlinked  => order_id IS NULL     and order_number IS NULL
--   approved_linked    => order_id IS NOT NULL and order_number IS NOT NULL
-- (all statuses other than these two are unconstrained here; order_number is
-- legitimately free-form reference text for pending_approval/
-- needs_clarification/rejected rows, per the original 20260628000200 design).
--
-- Two live bypasses that could have produced a NEW violation were closed in
-- the same review, immediately before this migration was written (see
-- src/app/finance/page.tsx and src/app/finance/received/page.tsx):
--   1. The generic Admin "Correct Status" dropdowns could set status to
--      approved_unlinked/approved_linked directly, independent of order_id.
--      Both states are now removed from STATUS_CORRECTION_OPTIONS in both
--      files, and the whole correction control is hidden whenever the row is
--      already in one of those two states.
--   2. Both EditPaymentModals let an admin free-text-edit order_number on ANY
--      row regardless of status, independent of order_id. order_number is now
--      excluded from the edit payload (and the field shown read-only) once a
--      row is approved_unlinked/approved_linked.
-- With both closed, the only remaining writers of these two statuses are
-- approve_finance_payment_request (20260690000000), link_finance_payment_to_order
-- and unlink_finance_payment_from_order (20260691000000) — each already sets
-- status/order_id/order_number together in a single UPDATE statement, so this
-- CHECK is satisfied by every one of them by construction.
--
-- Residual, deliberately NOT closed here (reported, not fixed — would require
-- a broader RLS decision this migration does not make): the
-- finance_payment_requests_admin_update RLS policy still permits any admin
-- session to issue a direct PostgREST PATCH setting status/order_id/
-- order_number to any value, bypassing all three RPCs' locking, eligibility,
-- and cancelled-order checks. This CHECK constraint stops such a call from
-- producing a structurally invalid row (status without a matching order_id/
-- order_number), but it cannot enforce the RPCs' business rules (row locking,
-- order-not-cancelled, payment_against origin for unlink) — only removing or
-- narrowing that RLS policy could close that path fully.
--
-- This supersedes finance_payment_requests_approved_linked_requires_order_id
-- (20260670): that constraint only checked the approved_linked -> order_id
-- direction; this one checks both statuses and both columns, so the narrower
-- constraint is now redundant and is dropped.

alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_approved_linked_requires_order_id;

alter table public.finance_payment_requests
  add constraint finance_payment_requests_status_order_invariant
  check (
    (
      status = 'approved_unlinked'
      and order_id is null
      and order_number is null
    )
    or
    (
      status = 'approved_linked'
      and order_id is not null
      and order_number is not null
    )
    or status not in ('approved_unlinked', 'approved_linked')
  );

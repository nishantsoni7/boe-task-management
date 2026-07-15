-- Finance Phase 2B: remove implementation-test activity rows.
--
-- During the Phase 2B production verification session, four activity rows were
-- generated on payment request PAY-REQ-2026-0003 by exercising the admin
-- correction tool and the guided review flow against the live database. They do
-- NOT represent genuine operational actions and would make that request's
-- employee-facing audit timeline misleading, so they are removed here.
--
-- This deletes ONLY the four exact row IDs captured during that session. The
-- legitimate backfilled request_submitted row for the same request
-- (f9fcb804-d75f-4fb6-a256-58c28ce5af03) is deliberately NOT listed and is
-- retained. Re-running this migration is a no-op once the rows are gone, and the
-- explicit id list makes it impossible to affect any unrelated row.
--
-- This is a one-time targeted cleanup. It does NOT grant delete privileges,
-- expose a delete API, or add reusable deletion logic to the activity table,
-- which remains append-only for all client roles.

delete from public.finance_payment_request_activity_log
where id in (
  'cbd5f805-774e-423e-ba44-892cd2ed8767',  -- status_corrected_by_admin (test, 2026-07-15 11:56)
  '7c730e17-f97a-49cb-8998-019ccb382eee',  -- status_corrected_by_admin (test, 2026-07-15 11:58)
  'a3a5cef3-448a-4011-94fc-e6e7086a5cb6',  -- clarification_requested   (test, 2026-07-15 12:39)
  '690dc95d-8887-481e-b5ae-e833042c34fa'   -- clarification_submitted   (test, 2026-07-15 12:42)
);

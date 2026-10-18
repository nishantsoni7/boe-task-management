# 20. Sample Tracking

Verified against checkout `852e0493`. Module key `sample_tracking` (display "Sample Tracking": "Request catalogs, track dispatch and returns."). No dedicated doc in `docs/Module Docs` apart from the permission-migration phase docs; this file is the reference.

## 1. Purpose & users

- Staff request physical catalogue samples (fabric, metal colour, rope, wooden swatches, other) to be sent to a client; an admin approves; the requester submits the dispatch QR; a dispatcher sends it with courier details; a receiver verifies the sample coming back (or it is marked lost).
- Users: requesters (any employee with module `view`; sees only OWN rows), admin (approves/rejects, sees all, deletes), dispatchers (`dispatch`), receivers (`receive`), loss recorders (`mark_lost`), closers (`close`).
- One real non-admin holder noted in memory (2026-08-31): Aditya holds every action except `delete` through employee overrides (verified through `resolve_effective_permissions`, from memory). Do not re-grant.

## 2. Status at commit 852e0493

- SHIPPED; stable since 2026-09-04 (`20260904000000` view parent gate) and 2026-08-31 (#77 receive-panel gate fix, `bf6b253`).
- Behavior is largely CLIENT-DRIVEN: `src/app/samples/page.tsx` (1411 lines) performs status changes with direct `supabase.from('sample_dispatches').update(...)` under RLS. There is no RPC layer or audit/history table for status changes (columns on the row carry actor/time).
- Permission engine cut-over (Phase 3F, `20260665`) is live: `resolve_permission(auth.uid(), 'sample_tracking', <action>)` gates the four lifecycle policies; legacy `employee_permissions`/`has_permission()` remain in the schema, unused, for rollback only.

## 3. Pages and API routes

Pages: `/samples` (single large screen with filter buckets: pending_approval, approved, qr_submitted, dispatched (sorted by overdue), rejected, closed = returned or lost; request form, cards with action panels), `/samples/dispatch/[id]` (dispatch detail/work page for dispatchers, 340 lines), `/samples/notifications`. Layout `src/app/samples/layout.tsx` = `ModuleGuard moduleKey="sample_tracking"` (before it existed, /samples only checked a session; the lifecycle actions deliberately do NOT grant entry).

API (`src/app/api/samples/`): `POST /notify` (events: sample_request_created, _approved, _rejected, _reapplied, _edited, _deleted, sample_qr_submitted, sample_dispatched, sample_followup, sample_returned, sample_lost; service role; inserts into `sample_notifications`; admin recipients = `users.role='admin'` and not deleted), `GET/DELETE/PATCH /notifications`, `/notifications/[id]` (DELETE, PATCH), `POST /notifications/delete-selected`. Optimistic-delete logic with snapshot/rollback in `src/lib/sampleNotificationDeletes.ts`.

## 4. Database

- `sample_dispatches` (`20260622` create; reshaped by `20260623` from a dispatch schema to a request/approval schema; later `20260624` inward verification, `20260626` rejection_reason, `20260627` courier fields, `20260628000000` dispatched_by, `20260631` status check, `20260632` lost audit fields): columns `catalog_type`, `catalog_name`, `client_name`, `client_phone`, `client_address`, `status`, `requested_by` (NOT NULL), `approved_by/at`, `rejected_by/at`, `rejection_reason`, `dispatched_at/by`, `courier_name`, `tracking_number`, `dispatch_note`, `expected_return_date`, `returned_date`, `received_by/at/note`, `lost_by/at/note`, `notes`, `last_followup_note/date`, `created_at`, `updated_at` (trigger `trg_sample_dispatches_updated_at`). Status CHECK (20260631): `pending_approval`, `approved`, `qr_submitted`, `dispatched`, `returned`, `lost`, `rejected` (default `pending_approval`).
- `sample_notifications`: used by the app (per-recipient state; columns user_id, event, title, body ...) but NO `create table` for it exists in `supabase/migrations/` on this checkout (grep: only a comment in `20260731000000_asset_notification_types.sql`). It was created outside the migration history; a fresh DB built from migrations lacks it. See `docs/migrations-are-not-self-contained.md`.
- Function `sample_tracking_module_open()` (STABLE, SECURITY DEFINER; true for an active admin or effective `sample_tracking:view`) from `20260904000000`.
- RLS (final, `20260904000000`, parent gate evaluated FIRST in every policy): SELECT = gate AND (own row OR admin OR has any of dispatch/receive/mark_lost/close). INSERT = gate AND `requested_by = auth.uid()`. UPDATE policies (transitions enforced in USING/WITH CHECK): `sample_dispatches_update_admin` (admin: any row, any state, from 20260630), `sd_update_perm_dispatch` (qr_submitted -> dispatched, needs `dispatch`), `sd_update_perm_receive` (dispatched -> returned, needs `receive`; never reads requested_by), `sd_update_perm_lost` (dispatched -> lost, needs `mark_lost`), requester policies `..._update_qr_submit` (approved -> qr_submitted), `..._update_requester_edit` (pending_approval stays pending_approval), `..._update_reapply` (rejected -> pending_approval), `..._update_followup` (dispatched stays dispatched). DELETE = admin, OR (gate AND own row AND status pending_approval) (the requester may withdraw only an unapproved request).
- Permission registration: actions `view, create, edit, delete, approve, export, manage` plus custom `dispatch, receive, mark_lost, close` (Phase 3B). `20260663` seeded admin defaults; `20260664` backfilled 3 employee overrides from legacy `employee_permissions`.

## 5. Permissions & access

- Entry: effective `view` (or admin). Lifecycle grants do not give entry (dormant when `view` is false).
- Approve/reject: effectively ADMIN ONLY in the database (only the admin update policy permits `pending_approval -> approved/rejected`). The registered `approve` action exists in the catalog but no policy consults it (the page uses `isAdmin` for approve).
- Dispatch needs `dispatch` and status `qr_submitted`; receive needs `receive` and status `dispatched`; lost needs `mark_lost` and status `dispatched`; `close` is registered and used in SELECT scope.
- A requester who also holds `receive` may receive their own sample (the DB never reads `requested_by`; the UI used to be stricter - fixed in #77).
- View As: all write actions are intercepted with an alert ("View Mode only").

## 6. Business rules

- Lifecycle: `pending_approval` -> (admin) `approved` or `rejected`; `approved` -> (requester Submit QR) `qr_submitted`; `qr_submitted` -> (dispatcher, needs courier name) `dispatched` with optional tracking number and note; `dispatched` -> `returned` (receiver verifies, optional note, sets `returned_date`) or `lost` (mark_lost, optional note); `rejected` -> requester Reapply -> `pending_approval` (clears rejected_by/at/reason, appends `[Reapply] <note>` to notes). Requester may edit while `pending_approval`; may save a follow-up note/date while `dispatched`.
- Overdue = status `dispatched` AND `expected_return_date` earlier than today (local date); `daysOverdue` = floor((now - expected_return_date)/86400000) (can be off by one around midnight/timezone).
- Catalogue types: fabric_catalog, metal_color_catalog, rope_catalog, wooden_swatches_catalog, other.
- Received-by distinct from requested-by was "enforced in app layer" in 20260624 comment; current rule: the DB does not enforce it and the UI does not require it (see #77).
- Notifications are per event via `/api/samples/notify`; they live in `sample_notifications`, NOT the shared `notifications` table, and have no `type` enum or `task_id`. Every Task/Finance/Order notification helper is bound to the shared table, so Sample Tracking has its own list/delete helpers.

## 7. Key components & lib files

`src/app/samples/page.tsx` (RequestCard with `act()` helper, handlers handleApprove/handleDispatchWithDetails/handleVerifyReceived/handleConfirmLost/handleReapply), `src/app/samples/dispatch/[id]/page.tsx`, `src/app/samples/notifications/page.tsx`, `src/lib/sampleNotificationDeletes.ts`, `src/lib/permissions/resolver.ts` (`getEffectivePermissions`), `src/lib/notifications.ts` (comment explains the separate system), layout `ModuleGuard`.

## 8. Decisions made & why

- Permission-engine migration done in phases 3A-3F with shadow verification (52/52 matches before cutover; docs `PERMISSIONS_MIGRATION_PHASE3A/3C/3E/3F`); lifecycle actions stay custom actions.
- Parent gate (`view` first) so switching module access off actually closes the module (before, ownership kept row access).
- Separate notification table kept to avoid rewriting live Task Management helpers.
- The database policy is the specification: the #77 fix aligned the UI to `sd_update_perm_receive` rather than changing the DB.

## 9. Known traps, gotchas, unfixed defects

- Control vs panel gate drift: a button and the panel it discloses were gated on two expressions (`canReceive` vs `isAdmin || (canReceive && !isRequester)`), giving a live button that did nothing. Check pairs like this elsewhere; `canReceive` already includes admin.
- `sample_notifications` table has no migration (not self-contained).
- All status changes are client-side updates: a bug in the UI or a crafted client can only do what RLS permits, so RLS is the real spec; any new transition requires a new/changed policy.
- The `approve` action in the catalog is not enforced anywhere; granting it does nothing.
- `20260630` comment: the original open UPDATE policy `USING (true)` was "either never applied or dropped", which silently blocked non-admin updates - evidence that live policies may differ from migrations; check `pg_policies` on the real DB.
- Hand-copied conditions in tests let defects pass; `sampleReceiveAction.test.ts` lifts the real gate expressions from the page source with a regex and evaluates them via `new Function`.
- Notify route trusts the client to supply `requestedBy` and `sampleLabel`; it only requires an authenticated user (any logged-in user can fire events for any requester id) (verified by reading the route's fragments; no ownership check seen).
- `sample_tracking` also appears in the legacy `app_modules` row (`visibility_type 'live'`, so launcher showed it to everyone); gate is now ModuleGuard + DB gate.
- Lint/test baseline from memory is stale (was 47 failures on 2026-08-31); current rule is 0 failures on main.

## 10. Tests that guard it

- `src/lib/permissions/sampleReceiveAction.test.ts` (13 tests: pins the receive panel gate against the page source), `src/lib/sampleNotificationDeletes.test.ts`, `src/lib/pi/sampleImageMapping.test.ts` (unrelated PI sample images). Permission-engine shadow tests under `src/lib/permissions/`. Run: `npx tsx --test src/lib/permissions/sampleReceiveAction.test.ts src/lib/sampleNotificationDeletes.test.ts`.
- No SQL assertion suite exists for the sample policies in `supabase/tests/`.

## 11. Open items / next planned work

- None recorded as planned. Candidates: migration for `sample_notifications`; enforce or retire the `approve` action; move transitions behind RPCs with an audit trail.

## 12. Recheck before changing this module

- Read: `src/app/samples/page.tsx` (RequestCard handlers and the gate expressions), `20260904000000_sample_tracking_view_parent_gate.sql` (current policies), `20260630` (requester transitions), `src/app/api/samples/notify/route.ts`, `src/lib/permissions/modules.ts` sample block.
- Query: `select polname, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) from pg_policy where polrelid='sample_dispatches'::regclass`; list `sample_notifications` columns; effective permissions for dispatch/receive/mark_lost/close holders.
- Run: `sampleReceiveAction.test.ts`; sign in as admin, requester, receiver for a manual click-through of every transition.

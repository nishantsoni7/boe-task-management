# 04 - Minop / MORX attendance device integration

Verified against checkout `852e0493`. Secrets and tokens are referred to BY NAME ONLY (never record values): `MINOP_WEBHOOK_SECRET`, `MINOP_WEBHOOK_PATH_TOKEN`. Related: 03 Attendance (the destination that is deliberately NOT written), 05 Payroll.

## 1. Purpose & users

- Capture punches from the MORX MSD5K Mini biometric device (cloud: Minop Cloud / PayTime) into BOE as raw, inspectable records, so a future phase can use them as a live attendance source.
- Current phase is COLLECTION-ONLY: data is stored and shown to admins; it must not create or update attendance, employee mappings, payroll or deductions. The official attendance source is still the fingerprint Excel import (the Minop machine is a NEW, test-only device; the older non-API device stays official).
- Users: **Admin** only (diagnostics pages and APIs). The external caller is Minop Cloud / the device (unauthenticated except for the secret URL token or shared secret).

## 2. Status at commit 852e0493

| Piece | Status |
|---|---|
| Stage 1 raw capture, header/payload-token authenticated: `POST /api/integrations/minop/webhook` | Shipped (stores only; returns `{"status":"1"}` string) |
| Raw path-token receiver: `POST /api/integrations/minop/webhook/[token]` | Shipped (PR #159; stores only). Reply: Say Hello `{"status":1}`; Transaction Data `{"transStatus":[{"txnId":<as sent>,"status":1},…]}` (per-transaction acknowledgement, fix branch `fix/minop-transstatus-ack`, PR pending; before it the reply was a bare `{"status":1}`) |
| Stage 2 attendance processor (`runProcessing.ts` etc.) | Code present but DISABLED by compile-time constant `MINOP_COLLECTION_ONLY = true`; the function throws before any read/write |
| Retry/reprocess route `POST /api/attendance/minop-deliveries/[id]/reprocess` | DELETED (only `GET` route.ts remains in that folder) |
| `/attendance/minop` ("Attendance Sync") diagnostics | Shipped, Retry action removed; unprocessed rows read "Stored only" |
| `/attendance/minop/incoming` "Incoming Minop data" register + CSV/raw export | Shipped (#271, 2026-10-01) |
| Live device -> BOE delivery | UNPROVEN as of last evidence (2026-09-19, from memory): a punch reached Minop Cloud but BOE saw 0 real deliveries; BOE receiver itself proven by an owner-approved synthetic self-test. Next step is owner action with Minop support (push not firing). Current prod delivery count is unknown from a checkout |
| trans[] -> attendance adapter, employee re-enrolment/mapping | NOT BUILT (planned "later phase") |

## 3. Pages and API routes

- Pages: `/attendance/minop` (Attendance Sync, `src/app/attendance/minop/page.tsx`), `/attendance/minop/incoming` (second tab of the "Issues" sidebar section). Both behind `AttendanceGuard` (admin).
- Inbound (public, no session):
  - `POST /api/integrations/minop/webhook` - `authenticateMinopWebhook`: `Authorization: Bearer <secret>`, or `x-minop-webhook-secret`, or JSON `AuthToken` / `RealTime.AuthToken`, constant-time compared with `MINOP_WEBHOOK_SECRET`. Unset secret -> 503 (stores nothing); wrong -> 401. Invalid JSON is stored `quarantined_invalid_json` and answered 400; failed insert -> 500 (so Minop retries). Reads `?stgid` into `service_tag_id`.
  - `POST /api/integrations/minop/webhook/[token]` - `handleMinopPathTokenWebhook` (`src/lib/minop/pathTokenWebhook.ts`). `MINOP_WEBHOOK_PATH_TOKEN` must be >= 32 chars (`MINOP_MIN_PATH_TOKEN_LENGTH`); unset/short/wrong -> 404 with EMPTY body and nothing stored (indistinguishable). After the token is proven failures answer `{"status":0}` with 413/400/500. Never logs the URL.
  - Both: `MINOP_MAX_WEBHOOK_BYTES = 256 KiB` (413 over); `runtime = 'nodejs'`.
- Admin APIs (all `requireAdmin`, read-only): `GET /api/attendance/minop-deliveries` (latest 100, optional `?status=`), `GET /api/attendance/minop-incoming` (50/page, search by Minop user id / punch id / device, IST date range), `GET /api/attendance/minop-incoming/export?format=csv|raw` (all matching records, up to 20,000 messages per request, hitting the ceiling shows a notice), `GET /api/attendance/minop-incoming/[deliveryId]`.

## 4. Database

### Table `minop_webhook_deliveries`
- `20261113000000_create_minop_webhook_deliveries.sql`: `id`, `received_at`, `service_tag_id`, `content_type`, `user_agent`, `raw_body` (exact), `payload` jsonb, `body_sha256` (audit aid, NOT unique, indexed), `auth_method`, `processing_status` ('received' | 'quarantined_invalid_json'), `error_text`; CHECKs tie payload/error to status; RLS ON with NO policy; `REVOKE ALL FROM anon, authenticated`; `GRANT ALL TO service_role`. Only the service-role routes touch it.
- `20261115000000_minop_attendance_processing.sql` (additive): `attendance_status` (pending, processed, ignored_unsupported_type, unmapped, mapping_conflict, inactive_employee, payroll_locked, malformed_event, error), `attendance_processed_at`, `attendance_error`, `mapped_user_id` FK users, `punch_type`, `punch_time_utc`; CHECK `attendance_status IS NULL OR processing_status = 'received'`; and `attendance_records.source` (NULL or 'minop').
- `20261210000000_minop_webhook_url_path_token_auth.sql`: widens `minop_webhook_deliveries_auth_method_check` to 4 values: bearer, x-minop-webhook-secret, payload-auth-token, url-path-token. Must be applied BEFORE deploying the path-token route (else every valid delivery fails 23514 -> Minop gets 500).
- No functions/triggers. No storage bucket.
- Apply-state (from memory, unverified here): 20261113 and 20261115 applied; 20261210 applied 2026-09-13 via `db push --linked` before the #159 merge (merge 9f6df43e). A migration `20260831000000` name collision exists on an unmerged local branch `feature/minop-raw-ingestion` (6017703e); it is NOT on main.
- Immutable: never edit these applied migrations; widen constraints by a new migration.

### Environment (names only)
- `MINOP_WEBHOOK_SECRET` (set in prod Vercel per memory: an unauthenticated POST returned 401, so it exists).
- `MINOP_WEBHOOK_PATH_TOKEN` (prod Vercel, stored as a "Config" not "Secret" variable so the owner can reveal it to paste into the Minop dashboard; value never printed or committed).
- `MINOP_ATTENDANCE_PROCESSING_ENABLED` appears only in comments/docs/tests now; it has no effect (the constant overrides it).

## 5. Permissions & access
- Inbound: shared secret (header/payload) or secret URL path segment. Nothing else; no Supabase credential ever goes to Minop.
- Admin pages/APIs: `users.role = 'admin'` via `requireAdmin`; no module-permission key.
- `minop_webhook_deliveries` is unreadable to every browser role (no policy, privileges revoked).
- `stage2Security.test.ts` pins admin gating and that the Minop write path cannot reach any Payroll table.

## 6. Business rules
- Collection-only guard: `src/lib/minop/collectionMode.ts` (`MINOP_COLLECTION_ONLY = true`, `assertMinopAttendanceWritesAllowed()` throws `MinopCollectionOnlyError`). It is a CODE constant on purpose (a stray env var cannot reopen the write path). Turning processing back on is a deliberate code change in a later phase.
- Real device payload (proven 2026-08-11): `{"trans":[{"txnId":"3","dvcId":"1","dvcIP":"127.0.0.2","punchId":"2","txnDateTime":"2026-08-11 12:41:35","mode":"8"}]}` - all values strings; `txnDateTime` has NO time zone; `mode` meaning unknown; no auth header at all. The register labels columns with raw field names (Punch ID (punchId), Transaction ID (txnId), Device ID (dvcId), Mode (raw)) and never translates mode to IN/OUT or presents punchId as a confirmed employee id.
- Published/alternative shape: `{"RealTime":{OperationID, AuthToken, PunchLog:{UserId, LogTime, Type}}}`. The (disabled) Stage 2 parser reads only this shape; a real `trans[]` body would become `malformed_event`.
- Register statuses: Read / Cannot read / No punches (empty `trans`) / partial; bodies flagged `boeSyntheticSelfTest` say so. Duplicate flags: same body SHA-256 in more than one message, or same device id + event id in more than one punch. Duplicates are never dropped.
- Credentials (`AuthToken`, `authorization`, `secret`, `password`, `api key`, `token` values) are blanked in payload view, CSV and raw export. CSV: UTF-8 BOM, CRLF; digit-only IDs written as `="0012"`; cells starting `= + - @` prefixed with `'`.
- Received time shown in Asia/Kolkata with seconds; punch time shown exactly as sent (not converted).
- Retained for the future processor (disabled): exact string match of `PunchLog.UserId` to `users.fingerprint_employee_code` (no normalisation; "0014" != "14"); 0 matches -> unmapped; >1 -> mapping_conflict; inactive/deleted -> inactive_employee; only CheckIn/CheckOut become attendance; earliest CheckIn + latest CheckOut per IST day (idempotent, order-independent); delivery dated in a locked payroll period -> payroll_locked; LogTime must carry Z/offset. Owner direction rule when linked: first-in/last-out, direction `inferred`.
- Say-Hello callback is documented as POST every minute when online; it has never been observed to fire.

## 7. Key components & lib files
`src/lib/minop/`: `webhook.ts` (auth, capture, limits), `pathTokenWebhook.ts`, `collectionMode.ts`, `incomingRegister.ts`, `incomingQuery.ts`, `incomingCsv.ts`, `punchEvent.ts`, `employeeMapping.ts`, `attendanceMerge.ts`, `processDelivery.ts`, `runProcessing.ts`. Routes under `src/app/api/integrations/minop/` and `src/app/api/attendance/minop-*`. Pages `src/app/attendance/minop/{page.tsx,incoming/page.tsx}`. Simulator: `scripts/minop-webhook-simulator.mjs` (payload-agnostic; use only an unmistakably synthetic UserId). Doc: `docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md` (top section is current; Stage 2 sections describe the switched-off processor).

## 8. Decisions made and why
- Raw-first: store the exact body, hash it, never dedupe on the hash (a genuine second punch can serialise identically); idempotency belongs to the (future) merge.
- Header auth kept for the simulator/vendor configs; a SECOND route authenticates by secret URL path because the Minop Developer Dashboard accepts only a URL (two fields: Say Hello, Transaction Data).
- Collection-only (2026-10-01): the device is a test unit; admins want to verify what Minop actually sends before anything touches attendance/payroll. Made a code constant, not an env flag.
- Replies follow Minop's contract (Developer Dashboard examples, read 2026-10-25): Say Hello -> `{"status":1}`; Transaction Data -> `{"transStatus":[{"txnId":21,"status":1}]}`, naming every accepted transaction with its txnId as sent. A bare `{"status":1}` for Transaction Data (the earlier behaviour) acknowledges nothing, which is the likely reason Minop kept `IsSync = False` and re-sent each punch ~14 times. Not acknowledging on store failure so Minop retries. The header-authenticated route still answers `{"status":"1"}` (simulator only).
- Wrong/unset token -> bare 404 so the endpoint's existence is not revealed.

## 9. Known traps / gotchas / unfixed defects
- The header-authenticated route 401s the real device (it sends no auth); only the path-token route can receive from it.
- `vercel logs` keeps only minutes of history; a wrong token stores nothing and logs nothing useful. `vercel link` silently pulls the Development env into `.env.local` in the cwd - run it only in a scratch directory and delete that file.
- The token is in the URL: it shows in Vercel request logs and to anyone who can see the Minop dashboard. Rotate by changing the variable and the dashboard URL together. Never log `req.url` in this route.
- Prod delivery table contains at least one known synthetic self-test row (body has `boeSyntheticSelfTest:true`, `trans:[]`, id e8f9f458..., from memory); ignore it when counting real Minop deliveries.
- The saved Minop dashboard URLs were compared by hash against prod and matched (2026-09-19, from memory) yet 0 deliveries arrived: the failure layer is Minop-side push configuration, not BOE.
- Any new `auth_method` value needs a migration first (CHECK).
- Docs drift: the Stage 2 text in `ATTENDANCE_MINOP_INTEGRATION.md` (flag-gated, Retry action, `reprocess` route) is historical; the code no longer matches it. `runProcessing.ts` header still describes inline processing.
- 7 test-fixture users and 3 real people lacked `fingerprint_employee_code` on 2026-09-06 (from memory); no code was ever assigned by this integration.
- The Supabase test environment `boe-minop-test-disposable` (ap-south-1, Mumbai) exists; production `boe-task-management` and `badminton-fund-manager` are off-limits for experiments. `db push`/`db reset`/`db query -f` were rejected for that disposable project; the chosen route was the Dashboard SQL Editor in an explicit BEGIN/COMMIT. Its database password is held by the owner, never in files.

## 10. Tests that guard it
Run `npx tsx --test src/lib/minop/*.test.ts` (or the full suite, see 03 section 10). Files: `webhook.test.ts`, `pathTokenWebhook.test.ts`, `incomingRegister.test.ts`, `punchEvent.test.ts`, `employeeMapping.test.ts`, `attendanceMerge.test.ts`, `processDelivery.test.ts`, `runProcessing.test.ts`, `stage2Security.test.ts`. Also `src/lib/attendance/monthAvailability.test.ts` (coverage excludes source=minop) and `src/components/layout/attendancePayrollNav.test.tsx` (the nav entries resolve to real pages). Migration ledger tests must list each new migration filename.

## 11. Open items / next planned work
- Get the device's push to reach BOE (owner action with Minop support); then one enrolled test user and one punch.
- Resolve what `punchId`, `mode`, `dvcIP` mean and the time zone of `txnDateTime`.
- Later phase: a trans[] adapter, employee mapping, re-enable processing as a code change, with CSV import as the fallback.

## 12. Recheck before changing this module
1. `src/lib/minop/collectionMode.ts`, `webhook.ts`, `pathTokenWebhook.ts`, and both route files.
2. `supabase/migrations/20261113000000`, `20261115000000`, `20261210000000` (CHECK lists).
3. `docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md` top section.
4. Read-only prod checks: delivery count/date range; the three env var NAMES exist (never print values); `migration list --linked`.
5. Run all `src/lib/minop/*.test.ts` plus `src/lib/attendance/monthAvailability.test.ts`.

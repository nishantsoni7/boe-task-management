# 04 - Minop / MORX attendance device integration

Verified against `origin/main` 14a3fc5a plus read-only production queries on 2026-10-30. Secrets and tokens are referred to BY NAME ONLY (never record values): `MINOP_WEBHOOK_SECRET`, `MINOP_WEBHOOK_PATH_TOKEN`. Related: 03 Attendance (the destination), 05 Payroll.

## 1. Purpose & users

- Capture punches from the MORX MSD5K Mini biometric device (cloud: Minop Cloud / PayTime) into BOE, and make them the company's attendance source.
- **Owner decision 2026-10-30: from 1 November 2026 the new machine is the ONLY attendance source, with no parallel period on the old machine.** October stays on the old machine's Excel.
- From that date punches become `attendance_records` rows for linked, active employees, by the same rules as the Excel import. Before it, punches are stored and shown to admins and touch nothing else, and the official source is the fingerprint Excel import.
- Users: **Admin** only (diagnostics pages and APIs). The external caller is Minop Cloud / the device (unauthenticated except for the secret URL token or shared secret).

## 2. Status at 2026-10-30

| Piece | Status |
|---|---|
| Stage 1 raw capture, header/payload-token authenticated: `POST /api/integrations/minop/webhook` | Shipped (stores only; returns `{"status":"1"}` string) |
| Raw path-token receiver: `POST /api/integrations/minop/webhook/[token]` | Shipped (PR #159). Reply: Say Hello `{"status":1}`; Transaction Data `{"transStatus":[{"txnId":<as sent>,"status":1},…]}` (per-transaction acknowledgement, #451; before it the reply was a bare `{"status":1}` and each punch came up to 15 times; every punch since 25 Oct has arrived once) |
| Old attendance processor (`runProcessing.ts`, `processDelivery.ts`, `punchEvent.ts`, `employeeMapping.ts`, `attendanceMerge.ts`, `collectionMode.ts`) | DELETED. It read a message shape the machine never sends, and two ways to write attendance is one too many |
| Retry/reprocess route `POST /api/attendance/minop-deliveries/[id]/reprocess` | DELETED (only `GET` route.ts remains in that folder) |
| `/attendance/minop` ("Attendance Sync") diagnostics | Shipped, Retry action removed; rows read "Stored" |
| `/attendance/minop/incoming` "Incoming Minop data" register + CSV/raw export | Shipped (#271, 2026-10-01) |
| Live device -> BOE delivery | PROVEN on production 2026-10-30: 246 deliveries, latest punch 12:59 IST received 7 minutes later. Not real time: 2 minutes to 2 hours on 28 Oct, about 2 days on 25-26 Oct, and nothing at all 13-25 Oct |
| `minop_punches`: each punch kept once | Shipped (#523), migration APPLIED 2026-10-30, 45 punches loaded. Written by the path-token route only; the migration loaded everything already received |
| Machine ID (`users.minop_user_id`) + unlinked-IDs notice on Employee Master | Shipped (#523), migration APPLIED 2026-10-30. 10 staff linked from the owner's list |
| Machine punches -> `attendance_records` | Shipped (#526). No migration needed. From 2026-11-01, linked and active people only |
| Nightly sync `GET /api/attendance/minop-sync` (Vercel Cron, 00:15 IST) | Shipped (#526) |
| Excel import and preview for months from November 2026 | Refused (400), #526 |
| Today tab `/attendance/today` + machine status | Shipped (#528). Seen by the owner on the preview with real punches |
| Stopped-machine alert `GET /api/attendance/machine-alert` (Vercel Cron, 11:05 IST) | Shipped (#528), 20270511000000 APPLIED 2026-10-30. Has not fired for real yet |

## 3. Pages and API routes

- Pages: `/attendance/today` (Today, first tab of the Attendance section and where its sidebar link lands), `/attendance/minop` (Attendance Sync, `src/app/attendance/minop/page.tsx`), `/attendance/minop/incoming` (second tab of the "Issues" sidebar section). All behind `AttendanceGuard` (admin).
- Inbound (public, no session):
  - `POST /api/integrations/minop/webhook` - `authenticateMinopWebhook`: `Authorization: Bearer <secret>`, or `x-minop-webhook-secret`, or JSON `AuthToken` / `RealTime.AuthToken`, constant-time compared with `MINOP_WEBHOOK_SECRET`. Unset secret -> 503 (stores nothing); wrong -> 401. Invalid JSON is stored `quarantined_invalid_json` and answered 400; failed insert -> 500 (so Minop retries). Reads `?stgid` into `service_tag_id`.
  - `POST /api/integrations/minop/webhook/[token]` - `handleMinopPathTokenWebhook` (`src/lib/minop/pathTokenWebhook.ts`). `MINOP_WEBHOOK_PATH_TOKEN` must be >= 32 chars (`MINOP_MIN_PATH_TOKEN_LENGTH`); unset/short/wrong -> 404 with EMPTY body and nothing stored (indistinguishable). After the token is proven failures answer `{"status":0}` with 413/400/500. Never logs the URL.
  - Both: `MINOP_MAX_WEBHOOK_BYTES = 256 KiB` (413 over); `runtime = 'nodejs'`.
- Admin APIs (all `requireAdmin`, read-only): `GET /api/attendance/minop-deliveries` (latest 100, optional `?status=`), `GET /api/attendance/minop-incoming` (50/page, search by Minop user id / punch id / device, IST date range, `?sort=punch_time|received&dir=asc|desc`, default latest punch time first), `GET /api/attendance/minop-incoming/export?format=csv|raw` (all matching records, same `sort`/`dir`, up to 20,000 messages per request, hitting the ceiling shows a notice), `GET /api/attendance/minop-incoming/[deliveryId]`, `GET /api/attendance/minop-unmapped` (machine IDs that have punched and belong to no employee), `GET /api/attendance/machine-day?date=YYYY-MM-DD` (one day for the Today tab; today when left out; 400 outside the days the machine covers), `GET /api/attendance/machine-status` (is the machine sending, for the For you card).
- `GET /api/attendance/minop-sync` (Vercel Cron, `Authorization: Bearer $CRON_SECRET`; unset secret -> 503): copies any punch the webhook missed, then works out every machine day of this month and last month again.
- `GET /api/attendance/machine-alert` (Vercel Cron, same secret; unset -> 503): tells every active admin once a day when the machine has stopped. Writes only `notifications`.
- Employee Master (`/attendance/employees`): Machine ID column and edit field, notice listing unlinked IDs. Saves through `PATCH /api/update-employee` (admin); an ID already in use answers 409.

## 4. Database

### Table `minop_webhook_deliveries`
- `20261113000000_create_minop_webhook_deliveries.sql`: `id`, `received_at`, `service_tag_id`, `content_type`, `user_agent`, `raw_body` (exact), `payload` jsonb, `body_sha256` (audit aid, NOT unique, indexed), `auth_method`, `processing_status` ('received' | 'quarantined_invalid_json'), `error_text`; CHECKs tie payload/error to status; RLS ON with NO policy; `REVOKE ALL FROM anon, authenticated`; `GRANT ALL TO service_role`. Only the service-role routes touch it.
- `20261115000000_minop_attendance_processing.sql` (additive): `attendance_status` (pending, processed, ignored_unsupported_type, unmapped, mapping_conflict, inactive_employee, payroll_locked, malformed_event, error), `attendance_processed_at`, `attendance_error`, `mapped_user_id` FK users, `punch_type`, `punch_time_utc`; CHECK `attendance_status IS NULL OR processing_status = 'received'`; and `attendance_records.source` (NULL or 'minop').
- `20261210000000_minop_webhook_url_path_token_auth.sql`: widens `minop_webhook_deliveries_auth_method_check` to 4 values: bearer, x-minop-webhook-secret, payload-auth-token, url-path-token. Must be applied BEFORE deploying the path-token route (else every valid delivery fails 23514 -> Minop gets 500).
- No functions/triggers. No storage bucket.

### Table `minop_punches`
- `20270510000000_minop_punches.sql`: `id`, `dvc_id`, `minop_user_id`, `punch_local` (timestamp as sent), `punch_at` (that time in IST), `txn_id` and `mode` (information only), `first_seen_at`. `UNIQUE (dvc_id, minop_user_id, punch_local)`. RLS ON with NO policy; `REVOKE ALL FROM anon, authenticated`; `GRANT ALL TO service_role`. The migration also loads every punch already held in `minop_webhook_deliveries`.
- Who a punch belongs to is NOT stored: it is resolved at read time from `users.minop_user_id`, so correcting Employee Master corrects history.

### Column `users.minop_user_id`
- `20270510000100_users_minop_user_id.sql`: text, unique where set, not blank. Separate from `fingerprint_employee_code` because the machines number people differently (0014 vs 4). Unreadable from a browser (column grants, `20260813000000`); only `/api/employee-list` for an admin caller returns it.

### Apply state
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
- Start date: `MACHINE_ATTENDANCE_FROM = 2026-11-01` in `src/lib/minop/machineDay.ts`, a code constant. Nothing dated before it is ever written.
- A machine day (`buildMachineDay`): first and last punch of the IST day are the pair (`confirmed`); punches under `DOUBLE_TAP_MINUTES` (5) apart are one punch; one punch before 14:00 is an arrival, at or after is a departure (`inferred`, the same `isArrivalByDivider` as the Excel import). `mode` is never read. Double taps read as a missing punch, never as a one-minute day.
- `planMachineDays` skips: dates before the start, impossible punch times, IDs linked to nobody, inactive or deleted people, locked payroll months. It writes only a row that would change, because a written row moves `updated_at`, and that marks a generated payroll month as out of date.
- Each write works out the whole day from all its punches, so late and out-of-order punches give the same result. Writers: the webhook (best-effort), the nightly sync, and `PATCH /api/update-employee` when a Machine ID is saved.
- `payroll_active = false` people still get rows, as the Excel import does.
- Real device payload (proven 2026-08-11): `{"trans":[{"txnId":"3","dvcId":"1","dvcIP":"127.0.0.2","punchId":"2","txnDateTime":"2026-08-11 12:41:35","mode":"8"}]}` - all values strings; `txnDateTime` has NO time zone but is IST (production punches arrive 2 minutes after their stated time); `mode` is "8" or "IN", mixed on one day and never OUT, so it gives no direction; no auth header at all. The register labels columns with raw field names (Punch ID (punchId), Transaction ID (txnId), Device ID (dvcId), Mode (raw)) and never translates mode to IN/OUT or presents punchId as a confirmed employee id.
- Published/alternative shape: `{"RealTime":{OperationID, AuthToken, PunchLog:{UserId, LogTime, Type}}}`. The register still shows it; nothing reads it for attendance.
- Register statuses: Read / Cannot read / No punches (empty `trans`) / partial; bodies flagged `boeSyntheticSelfTest` say so. Duplicate flags: same body SHA-256 in more than one message, or same device id + event id in more than one punch. Duplicates are never dropped.
- Credentials (`AuthToken`, `authorization`, `secret`, `password`, `api key`, `token` values) are blanked in payload view, CSV and raw export. CSV: UTF-8 BOM, CRLF; digit-only IDs written as `="0012"`; cells starting `= + - @` prefixed with `'`.
- Received time shown in Asia/Kolkata with seconds; punch time shown exactly as sent (not converted).
- Say-Hello callback is documented as POST every minute when online; it has never been observed to fire.
- The machine has stopped (`judgeMachineHealth`) on a working day from 2026-11-01, past 11:00 IST (`MACHINE_STOPPED_AFTER_MINUTES`), when no real punch has reached BOE since midnight. "Reached" is `first_seen_at`: a late punch from yesterday still proves it is connected. Minop's sample message does not count. Sundays and full-day holidays are days off; a half-day holiday is not.
- Today lists active people with a Machine ID plus active payroll people with none, inside their joining and exit dates. Statuses: In office, Left, No punch yet, No punch, Can't tell yet, On leave, Day off, Morning punch missing, Evening punch missing, No Machine ID. Only approved requests count.
- "Can't tell yet" replaces a no-punch row today while the machine has stopped, and on a past working day nobody at all punched, so a quiet machine never reads as absences.
- "Late" on Today is the payroll rule: past `grace_end_minutes` (10:15), counted from `scheduled_in_minutes` (10:00). Information only. The month views' `is_late` has no grace period, so 10:05 is late there and not on Today. Hours are `computeWorkedDuration`, after lunch.
- A punch time more than 30 days before BOE received it, or more than 1 hour after, is not a real punch (`isPlausiblePunchTime`): the unlinked-IDs list leaves it out and it stays visible in the register. The longest real delay seen is 6 days.

## 7. Key components & lib files
`src/lib/minop/`: `webhook.ts` (auth, capture, limits), `pathTokenWebhook.ts`, `incomingRegister.ts`, `incomingQuery.ts`, `incomingCsv.ts`, `punches.ts`, `unmapped.ts`, `machineDay.ts`, `machineAttendance.ts`, `machineHealth.ts`, `machineDayView.ts`. Routes under `src/app/api/integrations/minop/` and `src/app/api/attendance/minop-*`. Pages `src/app/attendance/minop/{page.tsx,incoming/page.tsx}`. Simulator: `scripts/minop-webhook-simulator.mjs` (payload-agnostic; use only an unmistakably synthetic UserId). Doc: `docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md` (historical below its first section).

## 8. Decisions made and why
- Raw-first: store the exact body, hash it, never dedupe on the hash (a genuine second punch can serialise identically); idempotency belongs to the (future) merge.
- Header auth kept for the simulator/vendor configs; a SECOND route authenticates by secret URL path because the Minop Developer Dashboard accepts only a URL (two fields: Say Hello, Transaction Data).
- Collection-only (2026-10-01): the device is a test unit; admins want to verify what Minop actually sends before anything touches attendance/payroll. Ended by the owner's decision of 2026-10-30; the constant and the old processor are gone.
- Replies follow Minop's contract (Developer Dashboard examples, read 2026-10-25): Say Hello -> `{"status":1}`; Transaction Data -> `{"transStatus":[{"txnId":21,"status":1}]}`, naming every accepted transaction with its txnId as sent. A bare `{"status":1}` for Transaction Data (the earlier behaviour) acknowledges nothing, which is the likely reason Minop kept `IsSync = False` and re-sent each punch ~14 times. Not acknowledging on store failure so Minop retries. The header-authenticated route still answers `{"status":"1"}` (simulator only).
- Wrong/unset token -> bare 404 so the endpoint's existence is not revealed.
- A punch is identified by device + person + punch time (2026-10-30). The earlier design keyed on `txnId`, unmerged on `docs/minop-shadow-mode-spec`; production proved it unsafe (see section 9), so that branch was rebuilt, not rebased. Its separate `minop_punch_sightings` table and RPC were dropped: nothing read them, and a plain insert that skips a key already held does the same job.
- Recording a punch is best-effort and never changes what Minop is told: the raw delivery is already safe, and the nightly sync repairs anything missed.
- The header-authenticated route does not record punches: the real machine cannot reach it, so only the simulator would write there.
- The new writer replaced the old processor rather than reviving it: the old one read `RealTime.PunchLog` and CheckIn/CheckOut types the machine never sends, and handled one punch at a time.
- A month the machine supplies stops at yesterday (`machineLatestDate`): today is not a row until the day is over, so nobody reads as absent or missing a punch while it is going. My Attendance shows today as a separate "so far" line.
- Today reads punches through `buildMachineDay`, not `attendance_records`, so it also works before the start date and shows what attendance will hold. It does not read corrections: it says what the machine recorded, and a missing punch is still fixed in Monthly Review.
- The stopped check is worked out when a screen opens, so it turns red at 11:00. The cron only reaches an admin who is not looking. Its schedule is 11:05 IST because Vercel has started the handover reminder 49 minutes late (03:30 UTC -> 04:19 UTC), so the notification can come nearly an hour later, and the body says "today" rather than naming 11:00.
- The alert goes to active admins, which on 2026-10-30 is the owner alone. It is one row a day per admin (checked by a read, so a rare double run could send two). The bell row stays as a record after the machine recovers; the screens clear themselves.

## 9. Known traps / gotchas / unfixed defects
- `txnId` is NOT unique. On production txn 21 and 22 each carried two different punches. Never key on it. The acknowledgement still echoes it, because that is Minop's contract.
- Changing or clearing a Machine ID does not remove rows already written for that ID. A wrong link needs those days corrected by hand.
- No Excel fallback exists for machine months: the upload is refused. If the machine is down for a day, fix the days with attendance corrections.
- An inactive person's punches write nothing. Today shows them as a warning, so somebody can act.
- A merge can reach production late: Vercel made no deployment for #528's merge, and it went live with the next commit on main. Check the deployment rather than assume it.
- Punches dated 2018-05-11 with IDs 1000 and 1001 are Minop's own sample message (the same values as its Developer Dashboard example), not a machine fault. Testing or saving the callback URL in the dashboard can send them again.
- The header-authenticated route 401s the real device (it sends no auth); only the path-token route can receive from it.
- `vercel logs` keeps only minutes of history; a wrong token stores nothing and logs nothing useful. `vercel link` silently pulls the Development env into `.env.local` in the cwd - run it only in a scratch directory and delete that file.
- The token is in the URL: it shows in Vercel request logs and to anyone who can see the Minop dashboard. Rotate by changing the variable and the dashboard URL together. Never log `req.url` in this route.
- Prod delivery table contains at least one known synthetic self-test row (body has `boeSyntheticSelfTest:true`, `trans:[]`, id e8f9f458..., from memory); ignore it when counting real Minop deliveries.
- The saved Minop dashboard URLs were compared by hash against prod and matched (2026-09-19, from memory) yet 0 deliveries arrived: the failure layer is Minop-side push configuration, not BOE.
- Any new `auth_method` value needs a migration first (CHECK).
- Docs drift: the Stage 2 text in `ATTENDANCE_MINOP_INTEGRATION.md` (flag-gated, Retry action, `reprocess` route) is historical; the code no longer matches it.
- 7 test-fixture users and 3 real people lacked `fingerprint_employee_code` on 2026-09-06 (from memory); no code was ever assigned by this integration.
- The Supabase test environment `boe-minop-test-disposable` (ap-south-1, Mumbai) exists; production `boe-task-management` and `badminton-fund-manager` are off-limits for experiments. `db push`/`db reset`/`db query -f` were rejected for that disposable project; the chosen route was the Dashboard SQL Editor in an explicit BEGIN/COMMIT. Its database password is held by the owner, never in files.

## 10. Tests that guard it
Run `npx tsx --test src/lib/minop/*.test.ts` (or the full suite, see 03 section 10). Files: `webhook.test.ts`, `pathTokenWebhook.test.ts`, `incomingRegister.test.ts`, `stage2Security.test.ts`, `punches.test.ts`, `machineDay.test.ts`, `machineAttendance.test.ts`, `machineHealth.test.ts`, `machineDayView.test.ts` (the rules, then the real reads and writes on `MemorySupabase`). Also `src/lib/attendance/monthAvailability.test.ts` (machine months stop at yesterday) and `src/components/layout/attendancePayrollNav.test.tsx` (the nav entries resolve to real pages). Migration ledger tests must list each new migration filename. The table itself: `node supabase/tests/minop_punches_pglite.mjs <dir with pglite>` (not in `npm test`; expected last line "all 10 checks passed").

## 11. Open items / next planned work
Machine-only attendance from 1 November 2026. Every punch is kept in `minop_webhook_deliveries` meanwhile, so nothing is lost if a step lands after that date: the nightly sync loads November from the raw messages.
1. Clean punches and link staff: DONE (#523).
2. Switch-on: DONE (#526). Its first real test is the first day of punches: check the rows on 2 November.
3. Daily machine screen and stopped-punches alert: DONE (#528). The red state and the alert have not been seen for real: they need a quiet working day from 2 November. Phone alerts are not switched on, so the alert stops at For you and the bell until they are.
4. Later: the employee "punch recorded" banner (`docs/minop-shadow-mode-spec`, section 7).
- Owner reminder for the Minop subscription renewal: it lapsed once, and a lapse now stops attendance. Needs the date from the owner.
- Open with the owner: a Machine ID for the one payroll employee not yet on the list.

## 12. Recheck before changing this module
1. `src/lib/minop/machineDay.ts`, `machineAttendance.ts`, `machineHealth.ts`, `machineDayView.ts`, `webhook.ts`, `pathTokenWebhook.ts`, and both route files.
2. `supabase/migrations/20261113000000`, `20261115000000`, `20261210000000` (CHECK lists), `20270510000000`, `20270510000100`.
3. `docs/Module Docs/ATTENDANCE_MINOP_INTEGRATION.md` top section.
4. Read-only prod checks: delivery count/date range; the three env var NAMES exist (never print values); `migration list --linked`.
5. Run all `src/lib/minop/*.test.ts` plus `src/lib/attendance/monthAvailability.test.ts`.

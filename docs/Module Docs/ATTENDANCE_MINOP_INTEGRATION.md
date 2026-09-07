# Attendance — Minop Live Integration

Last Updated: 7 September 2026

## Purpose

Add Minop biometric punches as a live input to BOE's existing Attendance system without redesigning Attendance or Payroll.

Current production Attendance already owns employee mapping, daily attendance rows, employee self-service, corrections and Payroll consumption. Minop is therefore an external input adapter, not a second attendance system.

```text
Minop device
    → HTTPS webhook (authenticated)
    → raw delivery, stored verbatim (public.minop_webhook_deliveries)
    → attendance processing (flag-gated)
    → employee mapping (fingerprint_employee_code)
    → merge into public.attendance_records (one row per user/date)
    → My Attendance
    → existing Payroll (unchanged)
```

## Stage 1 — Raw authenticated ingestion

Status: **merged to `main`. Migration `20261113000000_create_minop_webhook_deliveries.sql` is written and verified safe (dry-run confirmed it is the only pending migration in the entire history) but has not yet been applied to the production database — see "Production setup" below for the exact blocker and the operator command.**

- `POST /api/integrations/minop/webhook`
- `public.minop_webhook_deliveries`
- `src/lib/minop/webhook.ts` / `webhook.test.ts`

### Authentication

The route fails closed unless server environment variable `MINOP_WEBHOOK_SECRET` exists.

It validates the configured secret from any of:

1. `Authorization: Bearer <secret>`;
2. `x-minop-webhook-secret: <secret>`; or
3. the payload's own `AuthToken` — top-level, or `RealTime.AuthToken` as Minop's published real-time callback shape carries it.

Which mechanism the physical Minop service uses is **not yet confirmed** — see "Minop unknowns" below. The secret itself is never stored or logged.

### What is stored

Every authenticated HTTP delivery is retained with the exact raw request body, a parsed JSON copy, a SHA-256 of the raw body (audit/search aid, **not** a uniqueness key — see below), received timestamp, content type, user agent, authentication method, and a transport-level `processing_status` (`received` or `quarantined_invalid_json`).

Raw payloads are inaccessible to `anon` and `authenticated`. RLS is enabled with no browser policy; only the service-role webhook route and the service-role attendance processor touch the table.

### Duplicate/retry rule

`body_sha256` is indexed but deliberately not unique — a genuine second punch can legitimately serialise identically to a byte, and treating the hash as an idempotency key would silently discard it. Idempotency instead lives in the attendance merge itself (see Stage 2).

## Stage 2 — Attendance processing

Status: **implemented on `feature/minop-attendance-processing`, flag-gated OFF by default.**

Files:

- `src/lib/minop/punchEvent.ts` — validates a stored delivery's payload into one punch event (RealTime → PunchLog → UserId/Type/LogTime).
- `src/lib/minop/employeeMapping.ts` — exact-match `fingerprint_employee_code` lookup, mirroring the CSV importer's own matching rule (`src/lib/attendance/employeeMapping.ts`): no normalisation, no guessing.
- `src/lib/minop/attendanceMerge.ts` — the incremental form of the CSV importer's own multi-punch rule ("with two or more punches the first and last are the pair"): the **earliest CheckIn** of the day is the arrival, the **latest CheckOut** is the departure. This is also what makes replaying the same event idempotent.
- `src/lib/minop/processDelivery.ts` — the pure decision function, reusing the CSV importer's own `attendanceRowChange` (`src/lib/attendance/punchParser.ts`) to judge "did anything actually change" identically for a Minop punch and a CSV row.
- `src/lib/minop/runProcessing.ts` — wires the decision to real reads/writes: employee lookup, payroll-lock check, existing-row read, and the `attendance_records` upsert.
- Migration `20261115000000_minop_attendance_processing.sql` — additive: processing-outcome columns on `minop_webhook_deliveries` (`attendance_status`, `attendance_processed_at`, `attendance_error`, `mapped_user_id`, `punch_type`, `punch_time_utc`), and `attendance_records.source` (`'minop'` or `NULL`).

### When processing runs

Inline, synchronously, inside the webhook route, immediately after the raw delivery is durably stored — no queue, no cron. A processing failure never withholds Minop's acknowledgement: the raw delivery is already safely stored by that point, which is what Minop's documented retry behaviour exists to protect. The failure is instead recorded on the delivery for an admin to see and retry (Phase G below).

### Rollout flag

`MINOP_ATTENDANCE_PROCESSING_ENABLED=true` — anything else (unset, `false`, any other string) means OFF, which is the required default before real device evidence exists.

| State | Raw capture | Attendance writes |
|---|---|---|
| Before physical validation (default) | ON, once Stage 1 is deployed and the secret is set | **OFF** |
| After a genuine callback and mapping are verified | ON | ON |

Turning it on does **not** require a redeploy of new code — it is a plain server environment variable, flipped in the same place `MINOP_WEBHOOK_SECRET` lives. Turning it back off is the disable/rollback path (see "Troubleshooting" below).

### Employee mapping

`PunchLog.UserId` is matched by **exact string equality** against `users.fingerprint_employee_code` — the same field and the same no-normalisation rule the CSV fingerprint import already uses. A code like `"0014"` and `"14"` are different codes until real device data proves otherwise.

- Exactly one active, non-deleted employee with that code → posts attendance.
- Zero matches → delivery marked `unmapped`.
- More than one employee sharing a code → `mapping_conflict` (a data problem in Employee Master, never resolved by guessing).
- Exactly one match, but inactive or deleted → `inactive_employee`; the resolved employee id is still recorded for an admin's benefit, but no attendance is posted.

### Timestamps

`PunchLog.LogTime` must carry an explicit UTC/offset marker (`Z` or `+HH:MM`) — a bare, zone-less timestamp is refused rather than guessed. The attendance date is the IST calendar date of that instant, via the existing `istDateOf()` helper (`src/lib/istDate.ts`), the same helper other IST-aware parts of the product already use.

### Punch types

Only `CheckIn` and `CheckOut` are turned into attendance. `BreakIn`, `BreakOut`, and any type Minop adds later are recorded (`punch_type`, `punch_time_utc`) and marked `ignored_unsupported_type` — never treated as attendance, never discarded from the raw record.

### Payroll lock

A delivery whose computed attendance date falls in a `locked` payroll period is marked `payroll_locked` and never reaches `attendance_records` — the exact rule the CSV import route already enforces, read from the same `payroll_periods.status` column. The resolved employee is still recorded.

### Idempotency and out-of-order delivery

Because the merge always recomputes "earliest CheckIn, latest CheckOut" from scratch, replaying the identical event (a Minop retry, or an admin's manual reprocess) reproduces the identical result — there is nothing to double-post. Arrival order does not matter either: a CheckOut received before its CheckIn, or several CheckIns/CheckOuts across the day, all resolve to the correct pair. See `src/lib/minop/attendanceMerge.test.ts` and `src/lib/minop/processDelivery.test.ts` for the full matrix.

### Current-day coverage fix

`src/app/api/attendance/employee-monthly-detail/route.ts`'s "how far has the company got this month" signal is now scoped to exclude `attendance_records.source = 'minop'` rows, so one mapped employee's live punch cannot make every other, still-CSV-only employee's unprocessed day read as "covered". Each employee's own coverage separately extends through their own live Minop punches. See `effectiveLatestImportedDate()` in `src/lib/attendance/monthAvailability.ts`.

## My Attendance (same-day verification)

`/my-attendance` gained a manual **Refresh** button and a 45-second auto-refresh while the employee has the *current* IST month open — older months never poll. No websocket, no Minop-specific page: the existing self-service screen is the one an employee already knows.

## Admin diagnostics and reprocessing

`/attendance/minop` (new nav entry inside the existing Attendance admin surface, admin-only via the existing `AttendanceGuard`): the most recent deliveries, their mapped employee (if any), punch type/time, and outcome, with a **Retry** action on anything blocked by a mapping problem, a transient error, or a since-cleared payroll lock.

- `GET /api/attendance/minop-deliveries` — read-only, admin-only (`requireAdmin`).
- `POST /api/attendance/minop-deliveries/[id]/reprocess` — admin-only, re-runs the same processing function on an already-stored delivery. Safe to repeat any number of times: the merge's own idempotency is what makes retry safe, not a restriction on which deliveries may be retried. Refuses a delivery that was quarantined at receipt (never had a valid payload to process).

## Employee mapping readiness (as of 6 September 2026)

Read-only production check, not a fix — mapping assignment is a deliberate admin decision this integration does not automate.

- 20 active, non-deleted user rows; 10 carry a `fingerprint_employee_code`, 10 do not.
- Of the 10 without a code, **7 are test fixtures** left active by other modules' automated test suites (`API Isolation A`, `API Isolation ADMIN`, `Isolation Test A`, `Isolation Test B`, `ReviewIso A`, `ReviewIso B`, `ReviewIso VERIFIER`) — not real employees.
- The **3 real people** without a code: Namrata, Nishant, Nitish Bansal.
- No duplicate `fingerprint_employee_code` values exist among active employees.

No code was assigned or guessed. An operator with real device documentation must decide each of the 3 real employees' codes before their punches can map.

## Production setup

1. **Migration.** `supabase migration list --linked` confirms `20261113000000_create_minop_webhook_deliveries.sql` is the *only* unapplied migration in the entire project history — everything else already matches production. `supabase db push --linked --dry-run` currently refuses with `LegacyDbPushMissingLocalError` because of two pre-existing, unrelated remote ledger entries with no local file (`20260906133945` / `20260906134247` — a Review Workflow experiment that created, then in the very next migration dropped, one function; net schema effect is zero, confirmed by reading their stored `statements`). Applying the Minop migration therefore requires either an operator with direct database-write authorization to run it, or resolving that unrelated ledger gap first (`supabase migration repair --status reverted 20260906133945 20260906134247`, which is Review Workflow's ledger to fix, not Minop's). **Do not repair or reorder that ledger from this branch** — it is outside Minop's scope.
2. **Secret.** Set `MINOP_WEBHOOK_SECRET` to a long, random, cryptographically strong value in the production environment (Vercel), server-side only — never in a `NEXT_PUBLIC_*` variable, never logged, never committed.
3. **Rollout flag.** Leave `MINOP_ATTENDANCE_PROCESSING_ENABLED` unset (or `false`) until Phase I below is complete. Raw capture works and is safe to enable independently of this flag.
4. **Smoke test.** Once the migration is applied and the secret is set, use `scripts/minop-webhook-simulator.mjs` with an unmistakably synthetic `UserId` (one that matches no real `fingerprint_employee_code`) to confirm: unauthorized request rejected, authorized request returns exactly `{"status":"1"}`, and a row lands in `minop_webhook_deliveries` with the raw body and parsed payload intact.

## Minop unknowns

**Required before any physical device is configured:**
- Which authentication mechanism the real device actually sends (header vs. payload `AuthToken`).
- The actual `PunchLog.UserId` format the device emits, and whether it matches an existing `fingerprint_employee_code` value verbatim.
- Whether `OperationID` is unique per event (not yet assumed anywhere in this code).

**Can wait until physical-device testing:**
- Full shape of `BreakIn`/`BreakOut` payloads (already safely ignored, not blocking).
- Any device-specific fields beyond the published contract (already preserved raw regardless).

No application code guesses any of these; see `PHASE I` in the project plan for the exact capture procedure.

## Troubleshooting / rollback

- **Disable attendance writes without touching raw capture:** unset or set `MINOP_ATTENDANCE_PROCESSING_ENABLED` to anything other than `true`. Raw deliveries keep arriving and being stored; nothing further happens to them until an admin reprocesses or the flag is re-enabled.
- **Disable the whole endpoint:** unset `MINOP_WEBHOOK_SECRET`. The route fails closed with `503` and stores nothing (it never reaches the point of doing so).
- **An employee's punch did not appear:** check `/attendance/minop` for their `UserId`/code — `unmapped` means Employee Master needs their code added; `mapping_conflict` means two employees share a code and Employee Master needs correcting; `payroll_locked` means the month is finalised and the punch was correctly refused, not lost.
- **CSV import remains fully available** as a fallback and is unmodified by any of the above — the two paths converge on the same `attendance_records` table through the same change-detection rule, and CSV can always backfill a period Minop did not cover.

## Test matrix (Phase K)

- `src/lib/minop/punchEvent.test.ts` — payload validation: published shape, missing fields, invalid/zone-less timestamps, unsupported types.
- `src/lib/minop/employeeMapping.test.ts` — exact-match mapping: unmapped, conflict, inactive/deleted, no false normalisation.
- `src/lib/minop/attendanceMerge.test.ts` — first-in/last-out merge: retries, out-of-order arrival, multiple punches, idempotency.
- `src/lib/minop/processDelivery.test.ts` — the full decision matrix, including IST date-boundary cases and payroll-lock precedence over mapping.
- `src/lib/minop/runProcessing.test.ts` — the same decisions wired to reads/writes, against an in-memory fake (no live database is touched by attendance test data).
- `src/lib/minop/stage2Security.test.ts` — admin gating on both new routes, and that nothing in the write path can reach a Payroll table.
- `src/lib/attendance/monthAvailability.test.ts` — the current-day coverage fix (`effectiveLatestImportedDate`).
- `src/components/layout/attendancePayrollNav.test.tsx` — the new admin nav entry resolves to a real page and does not break the "exactly one item active" invariant.

## Verification gate

Before merge:

- TypeScript: 0 errors
- ESLint: 0 errors/warnings
- full test suite: 0 failures/skips
- build: green
- `git diff --check`: clean
- migration ledger tests updated for every new migration
- confirm the write path never names a Payroll write table (pinned by `stage2Security.test.ts`)

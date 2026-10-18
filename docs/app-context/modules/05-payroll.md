# 05 - Payroll

Verified against checkout `852e0493`. Part of "Attendance & Payroll" (03 Attendance feeds it; 06 BOE Credits adds a settlement line; 07 covers employee issues). The code is authoritative: `src/lib/payroll/rules.ts` + `settings.ts` supersede `docs/Module Docs/PAYROLL_RULES_V1.md` (marked superseded); current prose is `docs/Module Docs/PAYROLL_ATTENDANCE_RULES.md`.

## 1. Purpose & users

- Turns each employee's month of attendance into gross salary, attendance deductions, adjustments, a settlement (carry-forward, payment, closing balance) and a payslip; supports admin correction, locking/unlocking, deletion of test periods, a salary-processing report with WhatsApp text, and an employee self-service payslip.
- **Admin**: all `/payroll/*` and `/api/payroll/*` management (generate, correct, adjust, settle, lock, unlock, delete, settings, participation, reports). Admin only; no Control Center grant widens it.
- **Employee**: `/my-payroll` and `/my-payroll/[periodId]` (own payslip; mark as reviewed; raise an issue; apply/redeem BOE Credits, see 06), and `/payroll/how-it-works` (the only `/payroll` route an employee may open).
- **Manager role**: no payroll access.

## 2. Status at commit 852e0493

| Capability | Status |
|---|---|
| Idempotent period creation, generation, regeneration, out-of-date detection | Shipped |
| Central Payroll Settings (append-only, per-period snapshot) | Shipped (`/payroll/settings`) |
| Whole-rupee money rule | Shipped |
| Attendance correction on payslip page | Shipped |
| Adjustments with categories, void instead of delete | Shipped |
| Settlement (carry-forward, payment, closing balance) | Shipped |
| Lock / Unlock (with audit events) | Shipped |
| Controlled permanent deletion (`delete_payroll_period`) | Shipped |
| Salary report + WhatsApp text | Shipped |
| Company-paid leave (earned paid leave absorbs earliest item) | Shipped |
| Holiday half-day | Shipped |
| Month-end rule + attendance-ack lock gate | Shipped in code (needs migration `20270215000000`, see 03) |
| Participation (exclude members) | Shipped |
| Ask About Your Salary (LLM Q&A on How Payroll Works) | Shipped; needs `ANTHROPIC_API_KEY` else reports `configured:false` |
| Per-result locking, payslip approval workflow, payroll audit history | NOT BUILT (roadmap; `payroll_results.status` is always written `'draft'`; period-level lock is the only lock) |
| Overtime, tax/PF, bonuses calculation | Deliberately NOT calculated (bonuses arrive as adjustments) |

## 3. Pages and API routes

### Pages (admin, `PayrollGuard` in `src/app/payroll/layout.tsx`)
`/payroll` (Payroll Runs; create period, generate, lock/unlock/delete, participation), `/payroll/results/[periodId]` (run), `/payroll/results/[periodId]/[employeeId]` (payslip detail; page not popup; correction + settlement + issue review), `/payroll/results/[periodId]/salary-report`, `/payroll/monthly-review` + `/[userId]` (Payroll Monthly Preview, read-only engine run), `/payroll/settings`, `/payroll/credits` (06), `/payroll/how-it-works`, `/payroll/notifications`. Guard states: manager / guide_only / denied / unknown; guide-only users are bounced to `/my-payroll` from every route except `PAYROLL_GUIDE_PATH`.
### Pages (employee) `/my-payroll`, `/my-payroll/[periodId]`.

### API (`src/app/api/payroll/`)
| Route | Verbs | Auth |
|---|---|---|
| `periods` | GET, POST | `requireAdmin` for GET (header comment saying Custom members may read is STALE); POST inline admin check; idempotent: returns existing non-locked period (200), 409 if locked |
| `generate` | POST | admin; 422 locked; 422 `payroll_month_in_progress`; body `payroll_period_id`, optional `employee_ids`, `recalculate_with_current_settings` |
| `attendance-correction` | POST | admin (shared `applyAttendanceCorrection` service) |
| `adjustments` | GET, POST | admin; refuses locked month |
| `adjustments/[id]` | DELETE | admin; VOIDS (status `cancelled`+reason/actor/time), refuses locked month |
| `settlement` | PATCH | `requireAdmin`; actions `carry_forward` (override/reset) and `payment` (record/correct/clear); never calls the engine; locked -> 422 and DB trigger |
| `lock`, `unlock` | POST | admin; unlock needs a non-blank `reason` |
| `delete` | GET (facts), POST | `requireAdmin` |
| `settings` | GET, PUT | `requireAdmin` |
| `participation` | GET, PATCH | admin only (returns salaries) |
| `results`, `results/detail`, `monthly-review`, `monthly-review/detail`, `salary-report` | GET | `requireAdmin` |
| `my-result` | GET | any authenticated user, pinned to own rows (caller id from token; no employee_id parameter) |
| `my-result/review` | POST | own result; 422 when the period is locked |
| `ask` | POST | any authenticated user; reads NO payroll record (rules-only grounding) |

## 4. Database

### Tables (defining migration)
- `payroll_periods` (`20260611_create_payroll_periods.sql`; `20260616` adds 'generated'; `20260618` lock metadata): `status` CHECK `draft|generated|locked`; UNIQUE `(payroll_month, payroll_year)`; `settings_snapshot jsonb` nullable (`20260828000000`, no backfill); `locked_at/locked_by` never cleared by unlock.
- `payroll_results`, `payroll_deduction_lines` (`20260612000000`; engine fields `20260614`; `20260617` `employee_reviewed_at`), `payroll_generation` (`20260615`): results store `gross_salary`, `total_deductions`, `net_salary`, `days_present` numeric(4,1), `pending_adjustment_total` (engine-time snapshot), etc. Deduction lines cascade from results; `is_overridden/override_reason` are dead columns. Lines are deleted and recreated on every regeneration.
- `payroll_pending_adjustments` (`20260612000000`, `20260636` adds `adjustment_type` addition|deduction and always-positive amount, `20260809000000` repair, `20260826000000` void columns, `20260829000000` `adjustment_category` + direction CHECK). Status pending|applied|cancelled; `applied_in_period_id` stamped on generation.
- `payroll_settlements` + `payroll_settlement_events` (`20260826000000`): carry-forward (with source period and proposed vs override + reason), `amount_paid` (NULL = not recorded; 0 = recorded), BEFORE INSERT/UPDATE/DELETE lock guard `payroll_settlements_lock_guard` reads the period status. Totals are COMPUTED at read time and never stored.
- `payroll_settings` (`20260828000000`): append-only (trigger `payroll_settings_no_update` blocks UPDATE/DELETE even for service role), newest row active, admin-only RLS, no employee policy; seeded with one row that must equal code defaults (guarded by `settingsMigrationSeed.test.ts`).
- `payroll_period_status_events` (`20260811000000`): append-only lock/unlock trail (one SELECT policy, zero write policies, no immutability trigger on purpose so tests can delete periods).
- `payroll_deletion_audit` (`20260830000000`): NO FK to periods on purpose; counts only, never amounts; admin SELECT only.
- `payroll_holidays` (see 03). `attendance_day_corrections` (03).
- `payroll_lock_attendance_acknowledgements` (`20270215000000`, see 03).
- Credits tables (06) reference `payroll_periods`.

### Key functions
- `delete_payroll_period(...)` SECURITY DEFINER, EXECUTE revoked from anon/authenticated (service role + postgres only); actor passed as parameter and verified admin; refusals: locked, payment recorded, result locked, generation running, non-zero carry-forward dependency, identity mismatch (month/year must match id), credits in use (Phase 1D). Detaches (not deletes) `attendance_day_corrections.payroll_period_id` and returns adjustments to `pending`; NULLs zero-value carry-forward pointers.
- `lock_payroll_period_with_attendance_ack(...)` (03).
- RLS (`20260812000000_attendance_payroll_isolation.sql`, applied 2026-08-03): own-row SELECT (`employee_id = auth.uid()`) on results; deduction lines and periods derive ownership through results; admin keeps `FOR ALL`. Before this, every employee could read every salary. No views, materialized views or security-definer functions touch payroll except the ones above. No payslip storage bucket.
- Apply-state (from memory, unverified here): 20260807-09, 20260811, 20260812, 20260826 (in use by the 2026-08-10 settlement summaries), 20260827-30 all applied; `payroll_settings.settings_snapshot` is NULL for the three legacy periods (May/June/July 2026 era) - legacy periods resolve to `LEGACY_PAYROLL_SETTINGS`.

## 5. Permissions & access
- Admin = `users.role = 'admin'` re-asserted in every route (no module key). Controls: `canCorrectAttendance`, `canUnlockPayroll`, `canDeletePayrollPeriod` (admin only; "Control Center Payroll membership never granted generate/lock/unlock/delete").
- Control Center `payroll` module visibility governs only whether employees see the self-service card; `hidden` closes everything.
- Employee reads go through `/api/payroll/my-result` (service role pinned to caller id) and RLS own-row policies; no client component reads `payroll_*` directly.
- An employee sees a payslip as soon as the period is `generated` (employee review window) - not only after locking.
- `monthly_salary`/`payroll_notes` are column-privilege protected on `users`; the payroll participation API is deliberately not opened to Custom members because it returns salaries.
- Notifications: `attendance_payroll` category feed (no admin-only gate; `ADMIN_ONLY_CATEGORIES = []`).

## 6. Business rules (exact)

### Salary basis
- Per-day rate = monthly salary / **26** (`PER_DAY_DIVISOR`; PAYROLL_RULES_V1 says 30 - wrong). Per-hour rate = per-day / **8.5**. Half day = **0.5** of a day. Working days = every calendar day except Sundays, company holidays (full-day) and dates before `joining_date`.
- Missing punch = flat **2 h**. Late arrival/early departure: 0-15 min free, then round UP to 30-minute blocks at 0.5 h each. Classification bands and schedule: see 03 section 6. `half_day_fraction`, thresholds, schedule, paid-leave bands are ALL in `PayrollSettings` (editable), defaults built from the old constants.
- **Whole rupees**: each LINE is rounded as built (`roundRupees`, half-up AWAY from zero; `Math.round(-10.5)` would be -10); every total = SUM of rounded lines (`sumRupees` throws on non-integer). Three 1 h late lines at 117.647 = 354, not 353. Settlement does NOT round on read (pre-rule months stay as stored).
- A month with `days_present = 0` pays 0 (salary after attendance floored).

### Paid leave ("first paid leave is on the company")
- Earned from days present in the same month: **>=16 days -> 1**, **11-15 -> 0.5**, **<=10 -> 0** (`PAID_LEAVE_TIERS`, editable bands; `MAX_PAID_LEAVE_BANDS = 12`; settings parser rejects duplicate `min_days_present` and non-monotonic bands). Recomputed from attendance every run, so regeneration/corrections cannot spend it twice. No separate counter exists and none must be added.
- Spent on the EARLIEST item by attendance date, in order: one absent day; then 2 half days (`half_days_per_paid_leave`); then one half day against a 0.5 allowance; then up to 8.5 h (`hours_per_paid_leave`) of late/early/missing-punch lines. Absorbed lines stay visible at Rs 0 with `waived_by = 'paid_leave'` ("Paid Leave - Company Paid"); BOE Credits coverage uses `waived_by = 'boe_credits'`.
- Forced `day_treatment`: `'full_day'` = zero charge; `'half_day'`/`'absent'` still raise the aggregate day charge unless absorbed.

### Settings and snapshot
- `settingsForPeriod`: period with snapshot -> its snapshot; DRAFT without snapshot -> adopts active settings; GENERATED without snapshot -> `LEGACY_PAYROLL_SETTINGS`, never today's. `pinSettingsToPeriod` writes the snapshot BEFORE the first employee is calculated; an existing pin is KEPT unless `recalculate_with_current_settings: true` (so a correction can't smuggle in a settings change). Correction route also uses `settingsForPeriod` (previously used defaults).

### Settlement (`src/lib/payroll/settlement.ts`, pure)
```
salary_after_attendance = gross - total_deductions        (0 if days_present = 0)
net_adjustments         = carry_forward + other_adjustments (pending_adjustment_total)
boe_credit_addition     = active application's credit_amount_snapshot (>=0) or 0
salary_payable          = salary_after_attendance + net_adjustments + boe_credit_addition   (may be negative)
closing_balance         = salary_payable - amount_paid     (NULL until a payment is recorded)
```
- NEVER build settlement on `net_salary` (it already contains adjustments, is clamped at 0, and carries no carry-forward). Unknown payment is NOT zero. A month whose payment is unrecorded carries NOTHING forward. The preceding period is the previous period in the PAYROLL SEQUENCE (if June never ran, July's predecessor is May).
- Carry-forward is materialised during generation; manual override (reason required, proposed amount kept) and recorded payment survive regeneration. Recording a payment never reruns attendance.
- List columns "Net Payable" (My Payroll / Payroll Runs) stay the engine figure; Salary Payable is stated on the payslip, settlement route, report/WhatsApp.
- WhatsApp text prints Gross, Attendance Deduction, Salary to be Booked, Advance, Amount Payable (no day counts, never `amount_paid`). Advance = signed sum of the report's own itemised adjustment lines (`pending_adjustment_total` is a generation-time SNAPSHOT, stale after later adjustments). Known inconsistency left: Preview/Copy text ends at "Net payable" from `net_salary` while WhatsApp ends at Salary Payable.

### Adjustments
- Categories: additions `previous_salary_pending, incentive, bonus, reimbursement, other_addition`; deductions `advance_recovery, other_deduction`; direction enforced by API and a DB CHECK. Amount stored positive; `toSignedAdjustment` converts. Month-scoped (`payroll_month/year`) and stamped `applied_in_period_id` on generation; a second run re-reads rows applied by the same period.

### Period lifecycle
- `draft -> generated -> locked`; `locked -> generated` via Unlock (reason mandatory; status moved FIRST, audit row second, revert to locked if the audit write fails; conditional `.eq('status','locked')` makes double-submit a 409). Lock only from `generated`. Locked period: no regeneration, no correction, no adjustment/settlement write (route 422 + DB trigger for settlements), no employee review, no credit changes.
- **Month-end rule** (`periodCompletion.ts`): generate, correct, or lock only from 00:00 IST on the 1st of the next month (`422 payroll_month_in_progress`). Payroll Monthly Preview trims the in-progress month to yesterday via engine option `calendarThrough`. Write paths never pass it.
- **Lock gate** (`lockPeriod.ts`): no open attendance items -> plain lock. Open items -> 409 `attendance_unresolved` (counts, employees, sha-256 fingerprint of open events); retry with `attendance_acknowledgement:{fingerprint, reason}`; stale -> 409 `attendance_ack_stale`; unreadable review -> 503 `attendance_review_unavailable` (retryable, nothing locked); blank reason -> 400.
- Deletion refused while credits are in use against the period.

### Generation behaviour
- Per-employee fetches in parallel; skipped reasons `period_locked`, `employee_inactive`, `no_salary_configured`; `payroll_active = false` employees never reach the engine ("every employee named is excluded" -> 422). Settlement materialised non-fatally; credits coverage reconciled before the result is written.
- `GET /periods` `out_of_date` = MAX(`attendance_records.updated_at`) in the month > last generation `completed_at` (paged reads). Employee count comes from `payroll_results`, not the last run (a one-employee correction regeneration once showed 1 instead of 12).

## 7. Key components & lib files
- `src/lib/payroll/`: `engine.ts` (972 lines; `generatePayrollForEmployee`, `classifySingleDay`, `applyLeaveAbsorption`, `buildFinalDeductionLines`), `rules.ts`, `settings.ts`, `settingsStore.ts`, `store.ts`, `settlement.ts`, `settlementStore.ts`, `money.ts`, `adjustments.ts`, `adjustmentCategories.ts`, `corrections` (`correctionRules.ts`, `correctionContext.ts`, `attendanceCorrectionService.ts`), `lockGuard.ts`, `lockPeriod.ts`, `periodCompletion.ts`, `unlockRules.ts`, `deletionRules.ts`, `periodActions.ts`, `creditCoverage.ts`, `halfDayHoliday.ts`, `participation.ts`, `paidLeaveBands.ts`, `resultDetailPayload.ts`, `resultTabs.ts`, `deductionExplanation.ts`, `salaryReport.ts`, `askGrounding.ts`.
- Pages/components: `src/app/payroll/{page.tsx,CreatePeriodModal,DeletePayrollModal,ParticipationModal,UnlockPayrollModal,PayrollRowActions}`, `src/app/payroll/how-it-works/{page,guideContent.ts,GuideVisuals}` (every number imported from engine constants), `src/components/payroll/PayrollModal.tsx`, `src/components/layout/attendancePayrollNav.tsx`.

## 8. Decisions made and why
- Settings are data pinned to the period so an edit never restates a closed month; legacy periods use the historical constants.
- Rules statement lives in code (`rules.ts`), not docs; explanatory UI is generated from it.
- Whole-rupee lines (totals always add up).
- Entire 2-5 h band is a half day (monotonic cost). OPEN owner decision: a) retire `threshold_half_day_hours`, b) raise presence floor to 3.75 h, c) give 2-3.75 h its own fraction. Do not change unilaterally; get it in writing.
- Deletion exists for pre-July-2026 test periods that employees would read as real salary; never to hide a calculation defect (regenerate instead).
- Excluded members keep imported history; exclusion hides from calculation and counts only.
- Month-end rule has no bypass (no final-settlement path exists; `users.exit_date` unused by engine).
- Unlock target is `generated` (no new status).
- Employee issue = report only (07).

## 9. Known traps / gotchas / unfixed defects
- `net_salary` is clamped and excludes carry-forward/credits: never use it as "payable".
- `pending_adjustment_total` is a generation-time snapshot: stale after any later adjustment.
- `payroll_pending_adjustments`: before the 20260809 repair the `adjustment_type` columns were recorded-as-applied but missing; and `fetchPendingAdjustments` had read signed amounts (a deduction increased net) and had no month scope. Both fixed; keep `src/lib/payroll/adjustments.ts` as the only conversion.
- Settlement locks: a locked fixture cannot be populated or cleaned (BEFORE trigger); build generated, lock last, unlock before cleanup. July 2026's 11 settlements point at June with carry-forward 0.00 (zero pointers are NULLed on delete; non-zero blocks it).
- Regenerating periods without `settings_snapshot` (May/June 2026) stamps TODAY's settings onto them.
- Unlock/deletion/month-end comments drift: `correctionRules.ts` still says "no unlock workflow"; `periods/route.ts` header says Custom members may GET; `PAYROLL_RULES_V1.md` says /30 and a flat 1 leave/month; `engine.validate.ts` scenario S18 expected 0.25 h for 10:30 (engine and rules say 0.5 h; historic baseline failure).
- Dead columns `payroll_deduction_lines.is_overridden/override_reason`.
- `CHECK (btrim(x) <> '')` does not reject tabs/newlines (use `x ~ '\S'`); `E'...'` escape strings in migrations can be altered in transit.
- PowerShell round-trips corrupt UTF-8 repo files; Git Bash heredocs eat backslashes in generated regex; `sed -i` converts CRLF files to LF.
- `db push` from a worktree whose `supabase/config.toml` has `[db.migrations] enabled = false` silently no-ops ("Remote database is up to date"). That setting is local-test-only.
- `src/lib/payroll/settlementPolicy.test.ts` earlier had a fake client missing `.is`, silently hitting the degraded branch (23/23 green); fake query builders must model every operator the production query uses.
- Payroll delete suite: cleanup runs in `beforeEach` as well as `afterEach` (self-healing); year-2999 fixtures leak through `payroll_pending_adjustments` and `payroll_deletion_audit` (no FK) - clean by `payroll_year` first. Fixture periods are briefly visible on the real dashboard while the suite runs.
- `ASK` feature depends on `ANTHROPIC_API_KEY`; absent -> honest disabled state, never a canned answer.
- Open policy gaps: leavers (`exit_date`) charged as absent after exit; no per-day cap for a confirmed 19:00 arrival + missing punch-out (~11 h).

## 10. Tests that guard it
Run all: `npx tsx --test "src/**/*.test.ts" "src/**/*.test.tsx"`; payroll only: `npx tsx --test src/lib/payroll/*.test.ts`. Live-DB suites skip without a test DB (`skipLiveDbSuite`; `REQUIRE_LIVE_DB_TESTS=1` to enforce); never run two suites concurrently.
- Engine/rules: `engine.{corrections,missingPunch,rounding,companyPaidLeave,creditRedemption}.test.ts`, `rulesSource.test.ts`, `settings.test.ts`, `settingsSnapshot.test.ts`, `settingsMigrationSeed.test.ts`, `paidLeaveBands.test.ts`, `money.test.ts`, `halfDayHoliday*.test.ts`, `periodCompletion.test.ts`, `staleRecalculation.test.ts`.
- Settlement/reports: `settlement.test.ts`, `settlementPolicy.test.ts`, `salaryReport.test.ts`, `adjustments*.test.ts`, `resultTabs.test.ts`, `resultDetailPayload.stale.test.ts`, `deductionExplanation.test.ts`, `generatedAt.test.ts`, `src/app/api/payroll/{salaryReportAuth,monthlyReviewConsistency (pins engine-call arg list),settlementAuth}.test.ts`.
- Lifecycle: `unlockRules.test.ts`, `deletionRules.test.ts`, `periodActions.test.ts`, `correctionRules.test.ts`, `correctionContext.test.ts`, `src/app/payroll/PayrollRowActions.test.tsx`, live-DB: `src/app/api/payroll/{periods,delete,unlock}/route.test.ts` (sandbox years 2999/2996/2998).
- Guide/access: `src/app/payroll/how-it-works/guide.test.tsx` (asserts described bands against the classifier's behaviour), `payrollGuideAccess.test.ts`, `askGrounding.test.ts`.
- Security: `src/lib/security/attendancePayroll*.test.ts`.
- Migration-ledger tests (about 10-13 files) pin the migration list; since #327 use `assertNamedSuccessors`.

## 11. Open items / next planned work
- Owner decision on the 2-5 h threshold strategy (section 8).
- Per-result locking, payslip approval workflow, audit history (roadmap order).
- Resolve Preview/Copy vs WhatsApp "Net payable" vs "Salary Payable" inconsistency.
- Final-settlement rule for leavers.
- Denormalised `attendance_last_changed_at` on periods was explicitly REJECTED for now (scale tens of employees); revisit only on measured latency.
- Confirm owner sign-off on the lock-acknowledgement step and prod apply of `20270215000000`.

## 12. Recheck before changing this module
1. `src/lib/payroll/rules.ts`, `settings.ts`, `settingsStore.ts` (`settingsForPeriod`, `pinSettingsToPeriod`), `engine.ts`, `src/lib/attendance/classification.ts`.
2. `settlement.ts` + `settlementStore.ts`; `supabase/migrations/20260826000000_payroll_settlements.sql`, `20260828000000_payroll_settings.sql`, `20260830000000_payroll_period_deletion.sql` headers (FK list).
3. `src/app/api/payroll/{generate,lock,unlock,attendance-correction,settlement,adjustments}/route.ts` and `lockPeriod.ts`, `periodCompletion.ts`.
4. `docs/Module Docs/PAYROLL_ATTENDANCE_RULES.md`, `ATTENDANCE_REQUESTS.md` (sections 3, 3b).
5. Live-state queries (read-only): `supabase migration list --linked`; periods with NULL `settings_snapshot`; probe actual columns after any migration.
6. Run the section 10 suites; for DB-touching work also `supabase/tests` runners (bare postgres:16-alpine recipe per memory) because text tests can pass while an apply aborts.

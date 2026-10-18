# 06 - BOE Credits

Verified against checkout `852e0493`. Reference doc: `docs/Module Docs/BOE_CREDITS.md` (its STATUS banner at the top is stale: it says `20261206000000` and `20261208000000` are "NOT yet applied"; per memory both are applied, see section 4). The review side lives in the Customer Reviews / Review Workflow module (not in this group); this dossier covers the ledger, settings, attendance redemption, payroll application and the review-reward interface.

## 1. Purpose & users

- An append-only credit ledger that rewards employees for approved customer reviews and lets them convert credits into (a) a salary addition for a payroll month (Phase 1D) and (b) optional cover of a chargeable Half Day / Absent day (Phase 1C; currently switched OFF).
- **Employee** (any signed-in user): `/my-credits`, `/my-credits/how-it-works`, `/my-credits/leaderboard`; apply credits on `/my-payroll`; "BOE Credits" entry in the employee Attendance/Payroll nav.
- **Admin** (`users.role='admin'`, `can_manage_boe_credits()` = active non-deleted admin): `/payroll/credits` (settings, month close, balances, History, Adjust, "Reverse this entry").
- **Verifier** (Review Workflow `verify` permission): approves/rejects custom reviews; approval posts the reward but a verifier cannot award other amounts than the configured one.

## 2. Status at commit 852e0493

| Phase | PR / commit | Status |
|---|---|---|
| 1A foundation (ledger, settings, admin page, My Payroll card) | #85, 4ae3caa6 | Shipped |
| 1B review reward on `submitted -> verified` | #86, 623ad7a8 | Shipped (generated-review path) |
| 1C attendance redemption | #87, 14d27215 | Shipped, OFF by default since 1208 |
| 1D settings, monthly qualification, payroll credit addition, My Credits | #88, c3e4b97c; wording fix #89 | Shipped |
| Decimal credits (numeric(12,2)) | #153, e58ad80b | Shipped |
| Custom review submissions + reward | #153 | Shipped (the CURRENT earning path) |
| Custom phase: reapply + monthly rules | #155 (38e76415 + ad8a0ac7) | Shipped |
| Redemption on/off switches | #156 0a8f7f39 + #157 1c620ddf | Shipped, both OFF |
| Edit/delete own custom review, duplicates, reporting + leaderboard, admin reject-after-approval | migrations 20270223/224/225/304 (#269, #291) | Shipped in code; prod apply-state unverified, from memory not tracked |
| Generated-review flow for candidates | paused by constant `CANDIDATE_GENERATED_REVIEWS_ENABLED = false` and SQL `customer_review_generated_booking_enabled()` | Paused |
| Campaigns, per-employee rates, expiry, cash-out, transfers, scheduler for month close, negative penalties, auto-reversal on review deletion | - | NOT built (by design) |

## 3. Pages and API routes

- Pages: `/my-credits`, `/my-credits/how-it-works` (driven by live settings; shows only switched-on redemptions), `/my-credits/leaderboard`, `/payroll/credits`, plus credits panels on `/my-payroll/[periodId]` (`PayrollCreditsPanel`, `RedeemCreditsModal`) and `CreditsSummaryCard` on `/my-payroll`.
- API `src/app/api/boe-credits/`:
  | Route | Verbs | Auth |
  |---|---|---|
  | `settings` | GET (any employee), PUT | PUT `requireAdmin`; PUT validated by `parseBoeCreditSettings(payload.settings, active.settings)` (pinned by `routesAuthority.test.ts`) |
  | `ledger` | GET | `requireSelfOrAdmin` |
  | `balances` | GET | `requireAdmin` (company-wide; own balance read via ledger/view) |
  | `adjustments` | POST | `requireAdmin`; one `admin_adjustment` row, reason mandatory, decimals allowed up to 2 places (route comment still says "whole number": stale) |
  | `redemptions` | POST `{payroll_period_id, attendance_date}` | caller from token only; re-runs the engine to decide eligibility; DB prices the cost |
  | `payroll-applications` | POST `{payroll_period_id, credits}`, DELETE `{payroll_period_id}` | employee's own only; admins have no path |
  | `reversals` | POST | `requireAdmin` |
  | `review-months` | GET `?month=YYYY-MM`, POST finalize | `requireAdmin`; GET warns about submitted-but-unverified reviews |
- Customer-review side routes touching credits: `/api/customer-reviews/custom-submissions*` (Review module).

## 4. Database

### Tables / views
| Object | Migration | Notes |
|---|---|---|
| `boe_credit_transactions` | `20261101000000_boe_credits_foundation.sql` | Append-only ledger (trigger `boe_credit_transactions_append_only` refuses UPDATE/DELETE for everyone incl. service role). `transaction_type` (review_reward, redemption, reversal, admin_adjustment, + `review_month_lapse`), signed `credits` (never 0; numeric(12,2) since 20261204), `source_type`+`source_id`, nullable `payroll_period_id`, `description`, `created_by`. Unique `(employee_id, transaction_type, source_type, source_id) WHERE source_id IS NOT NULL` (one reward per review, one reversal per row, one lapse per month) |
| `boe_credit_settings` | foundation + 1D + 1206 + 1208 | Append-only, newest row active; admin saves create new rows (future actions only) |
| `boe_credit_balances` (view, security invoker) | foundation, replaced by 1D and decimal | `available_credits` (recorded), `provisional_credits`, `spendable_credits`, counts |
| `boe_credit_attendance_redemptions` | `20261103000000` | One per covered day; partial unique `(employee_id, attendance_date) WHERE reversal_transaction_id IS NULL`; close-once guard; closed by AFTER INSERT trigger `boe_credit_redemption_closed_by_reversal` on the ledger |
| `boe_credit_review_months`, `boe_credit_review_rewards`, `boe_credit_payroll_applications` | `20261104000000` | See BOE_CREDITS.md 2.3. Months: `open/qualified/lapsed`, `minimum_reviews_snapshot`; guard trigger (identity fixed, lapsed final, qualified never un-qualifies). Applications: partial unique active per employee-period, snapshots of credits/rate/rupees |

### Functions (all write functions service-role only, `search_path = public, pg_temp`)
`can_manage_boe_credits()`, `post_boe_credit_transaction(..., numeric)`, `reverse_boe_credit_transaction`, `boe_credit_provisional_credits(uuid)`, `boe_credit_spendable_balance(uuid)`, `boe_credit_reversal_guard()` (BEFORE INSERT), `boe_credit_reversal_effects()`, `refresh_boe_credit_review_month`, `post_boe_credit_review_reward`, `post_boe_credit_custom_review_reward`, `finalize_boe_credit_review_month`, `redeem_boe_credits_for_attendance`, `reverse_boe_credit_attendance_redemption`, `apply_boe_credits_to_payroll(numeric)`, `remove_boe_credit_payroll_application`, `transition_customer_review_test_card` (re-created by 1B/1D and again by later review migrations), `approve/reject_customer_review_custom_submission`, `reverse_customer_review_custom_reward` (20270223), `admin_reject_customer_review_custom_submission` (20270304). Trigger `boe_credit_attendance_redemptions_enabled_guard` (BEFORE INSERT; raises `BOE_CREDITS_REDEMPTION_DISABLED`, 55000) from `20261208000000`.
- RLS on every credits table: one SELECT policy (`employee_id = auth.uid() OR can_manage_boe_credits()`), all client writes revoked, anon blind. Two review decisions are `authenticated`-callable RPCs.
- Storage bucket (review side): private `customer-review-custom-proofs` (`20261205000000`).

### Apply-state / immutability
- From memory (unverified here): 1A applied by the owner by hand 2026-09-02; 1B applied via `db push --linked` same day; 1C and 1D applied; 20261204 + 20261205 applied 2026-09-13 BEFORE merging #153; 20261206 + repair 20261207 applied; 20261208 applied 2026-09-13 13:43 UTC (+ #157). Production ledger was EMPTY at last check (no live use then). Re-verify before trusting.
- NEVER recreate/reapply or edit `20261206000000`; `20261207000000` is the permanent forward repair (AFTER trigger off-by-one: `new.reapplication_count + 1` recorded the first reapplication as attempt 2 because NEW already had the increment).
- The Claude auto-mode classifier denies `supabase db push` in this repo; the owner applies migrations by hand or approves a guarded push.

## 5. Permissions & access
- No module-permission key. Management = admin (`can_manage_boe_credits()`), same as Attendance/Payroll (`SELF_SERVICE_MODULE_KEYS` thinking). Widen the SQL function if delegation is ever required.
- Employees read only their own ledger/balances/applications/redemptions (RLS + token-pinned routes). `settings` GET is readable by any signed-in user (rules shown on My Credits).
- The ONE non-admin reversal: an employee reversing their OWN `payroll_redemption` (change/remove application). Everything else admin.
- Reversal guard (BEFORE INSERT) blocks, even directly: reversing a lapsed month's reward, the lapse row itself, any redemption in a LOCKED payroll period.
- Verifier confirms the configured reward amount; only `can_manage_boe_credits()` may award a different amount; never self-approve.
- Never let a service-role client call an `auth.uid()`-based function (its admin assertion fails 28000); call as the user with an anon client carrying the bearer (pattern in `/api/objections/review`).

## 6. Business rules (exact)

### Settings (global; newest row active; defaults in `DEFAULT_BOE_CREDIT_SETTINGS`, fail-closed)
| Setting | Value (Custom Review phase) |
|---|---|
| `credit_value` | Rs 50 per credit (1A seeded 100 credits/Rs 1; 1D seeded 1 credit/Rs 100; prod active row already Rs 50 before 1206 per memory) |
| `review_reward_credits` (Text) | 1 (Rs 50) |
| `image_review_reward_credits` | 1.5 (Rs 75) |
| `minimum_monthly_reviews` | 3 |
| `max_monthly_review_submissions` | 10 |
| `minimum_monthly_image_reviews` | 3 (<= max) |
| `half_day_redemption_credits` | 8 (kept while OFF) |
| `full_day_redemption_credits` | 15 (kept while OFF) |
| `half_day_redemption_enabled` / `full_day_redemption_enabled` | false / false (column default false; in-code default false) |
Bounds: `MAX_REVIEW_REWARD_CREDITS = 100_000`; `credit_value > 0`; amounts have at most 2 decimals (`BOE_CREDITS_PRECISION` error, never rounded); attendance prices and monthly counts stay whole.

### Earning and qualification
- One approved review posts exactly one `review_reward` in the same transaction, priced by its stored type (Text or Image). A custom review counts for the Asia/Kolkata month of `submitted_at` (first submission, never overwritten, reapply keeps it); a generated review for the month of its latest submission.
- PROVISIONAL until the month has >= 3 approved reviews: recorded but not spendable (shown Pending). The reaching approval flips the month to `qualified`; later rewards that month are spendable at once. The minimum used is the one snapshotted when the month row was created.
- No penalty for a short month. Explicit admin FINALIZE after the IST month ended: qualified -> finalized; below minimum -> `lapsed` with ONE `review_month_lapse` row removing exactly that month's still-valid provisional credits (never more). Idempotent; no scheduler. The GET warns about submitted-but-unverified reviews before closing.
- A closed (lapsed) month earns nothing new: approve/reapply refuse (`CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED`) because a reward in a lapsed month would be spendable at once.
- Submission rules (enforced at SUBMISSION by `check_customer_review_custom_month_rules`): <= 10 custom reviews per employee per IST month (reapply takes no slot); a Text Review allowed only when `max - (submitted+1) >= max(0, min_images - images)`.
- Balances: `recorded = SUM(ledger)`, `provisional = un-reversed rewards of OPEN months`, `spendable = recorded - provisional`. Redemptions are checked against SPENDABLE under the per-employee advisory lock `pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(employee_id))`. Credits never expire.
- Edited APPROVED custom review (20270223): credit stays on the ledger while pending approval again (`reward_held`); approve again posts nothing; reject or delete reverses ONCE. Admin reject-after-approval (20270304) reverses once, recounts the ORIGINAL month; a qualified month stays qualified; a lapsed month's reward is not reversed again.
- Leaderboard conversion: 10 credits = 1 point (`customer_review_credits_per_point()`).

### Redemption
- Attendance (OFF now): eligible only for a chargeable Half Day (8 credits) or Absent day (15); NOT for late/early/missing-punch/company-paid/already-covered/future/locked days; the cost is read from settings by the DB and written on the record. Lifecycle in `src/lib/payroll/creditCoverage.ts` runs in the correction and generate routes: restore credits when the deduction disappears or becomes company-paid; re-price ONLY when the KIND of day changes (Absent -> Half Day), never because the price setting changed; while Half Day is OFF the re-price is skipped (absent coverage kept, nothing reversed). Switched-off kind is: not offered, refused by route (422) and by DB trigger, not mentioned on My Credits.
- Payroll: employee applies N spendable credits to an unlocked GENERATED month; salary addition = `round(N x credit_value, 2)`, both snapshotted; one active application per employee-period; same N twice = no-op; locked period freezes it; regeneration never re-prices. 1.5 x Rs 50 = Rs 75.00. Settlement: `salary_payable = ... + boe_credit_addition` (not capped by deductions; Rs 30,000 + Rs 500 = Rs 30,500 valid). `payroll_results.net_salary` is untouched.
- Deleting a payroll period is refused while credits are in use against it (`credits_in_use`).

## 7. Key components & lib files
`src/lib/boeCredits/`: `types.ts`, `settings.ts`, `ledger.ts` (pure sums/descriptions/precision), `service.ts` (reads, RPC wrappers), `attendanceRedemption.ts` (`attendanceRedemptionEligibility`, reason `redemption_disabled`), `paths.ts` (`MY_CREDITS_PATH`, `CREDITS_GUIDE_PATH`). `src/components/boeCredits/`: `AdjustCreditsModal`, `CreditHistoryModal`, `CreditSettingsForm`, `CreditsSummaryCard`, `PayrollCreditsPanel`, `RedeemCreditsModal`. Pages `src/app/my-credits/*`, `src/app/payroll/credits/page.tsx`. Payroll hooks: `src/lib/payroll/creditCoverage.ts`, `settlement.ts`. Review side: `src/lib/customerReviews/*`, `src/components/customerReviews/ReviewLeaderboardScreen`.

## 8. Decisions made and why
- Append-only ledger; corrections are counter-entries; uniqueness at the table so concurrency cannot double-pay.
- Signed credits in the ledger (task requirement) although house style is positive + type.
- No new permission key: admin only (decision, 1A).
- Fifth ledger kind `review_month_lapse` rather than reusing `redemption`/`admin_adjustment`: one lapse per month at the table, no overdraft check.
- Spendable = ledger - open-month rewards; ledger arithmetic untouched.
- Month attribution = IST month of `submitted_at`, snapshotted on the reward record.
- Approved custom review counts toward the monthly minimum exactly like a verified generated review (owner decision).
- Redemption OFF by owner correction 2026-09-13: DB column default false (no UPDATE, since the table is append-only), trigger rather than re-creating the redeem function.
- Recipient of a reward = `booked_by` (never the verifier); no backfill; no notification; deleting a verified review does NOT auto-reverse (admin reverses); a verified review whose holder is soft-deleted cannot be verified (P0002 BOE_CREDITS_EMPLOYEE).
- List "Net Payable" stays the engine figure; Salary Payable shown on payslip, settlement route, report.

## 9. Known traps / gotchas / unfixed defects
- PL/pgSQL `integer` variables silently ROUNDED 1.5 -> 2 (and admitted an 8-credit overdraft against 7.5 spendable); decimal migration re-created every affected function. Any new function must use numeric.
- Trigger-written derived values need behavioural SQL assertions (text tests passed the attempt-number bug).
- `post_boe_credit_transaction` / `apply_boe_credits_to_payroll` have numeric signatures only; integer ones dropped. `redeem`/`apply` overload ambiguity (PGRST203) is avoided by not giving defaults to overloads.
- Tests that spread `DEFAULT_BOE_CREDIT_SETTINGS` and expect a bad redemption price refused must switch both redemptions ON first.
- Rows inserted in ONE transaction share `now()`; tests inserting two settings rows must set `created_at = clock_timestamp()`. `v_out->'reward' is null` is false for a JSON null; use `->>`.
- Adding any migration with "credit" in its name must be listed in `src/lib/boeCredits/migration.test.ts` (it filters by `/credit/`); plus ~10 other ledger-pinning tests. `monthlyReviewConsistency.test.ts` pins the engine-call arg list (8 args).
- CRLF: the ledger-pinning test files are CRLF; edit with `\r?\n`-aware scripts. ES2017 target: regex `/s` flag fails only `next build`.
- Reversing is impossible for: lapsed-month rewards, lapse rows, locked-period redemptions. Fix a lapse by adjustment.
- Docs drift: BOE_CREDITS.md header (apply-state), `adjustments` route comment ("whole number"), `runProcessing`-style comments are historical; trust the migrations.
- Unverified UAT items: first real payslip "Use N credits" offer (both OFF now so none expected), first live redemption, signed-in employee views of payroll application and provisional labels.
- Local DB proof recipes (from memory): bare `postgres:16-alpine` container with marker comment `boe-disposable-boe-credits` and `supabase/tests/run_boe_credits_local.sh` / `run_boe_credits_phase_1d_local.sh` / `run_custom_review_submissions_local.sh` (breaks under `MSYS_NO_PATHCONV=1`). Full local Supabase stack replays are blocked by non-self-contained history (`docs/migrations-are-not-self-contained.md`; `20260813000000` fails on a blank baseline).
- Git Bash `sed -i` converts the CRLF `config.toml` to LF; toggle `[db.migrations] enabled` with a CRLF-preserving script and restore byte-identical.

## 10. Tests that guard it
- `src/lib/boeCredits/{settings,ledger,service,migration,reviewReward,attendanceRedemption,phase1d,decimalCredits}.test.ts`; `src/app/api/boe-credits/routesAuthority.test.ts`.
- `src/lib/payroll/{settlement,salaryReport,creditCoverage,engine.creditRedemption,resultDetailPayload.stale}.test.ts`.
- `src/lib/customerReviews/{nextStep,customSubmissions,customMonthlyRules,customReviewPhase}.test.ts` and `customerReviewOutreach.test.ts` (forbids the RPC name in the list screen, pins nav labels and the `router.push(...to_verify...)`).
- DB-level (not part of `npm test`): `supabase/tests/boe_credits_phase_1d_assertions.sql`, `custom_review_submissions_assertions.sql`, `custom_review_phase_assertions.sql` via the runner scripts above.
- Run: `npx tsx --test src/lib/boeCredits/*.test.ts src/app/api/boe-credits/*.test.ts`; full suite per 03 section 10. Some live-DB suites are refused by the UAT guard against a production `.env.local` by design.

## 11. Open items / next planned work
- Set the image reward business value if still needed (it is already 1.5 in the code defaults and migration).
- Manual UAT of the payslip credit offer when/if redemptions are switched on.
- Observation items on the first real events: one `review_reward` row per verified/approved review, `Covered with N BOE Credit` at Rs 0 on first redemption.
- Possible future: delegated management (widen `can_manage_boe_credits()`), expiry/campaigns (explicitly not built).

## 12. Recheck before changing this module
1. `supabase/migrations/20261101000000`, `20261104000000`, `20261204000000`, `20261206000000`, `20261207000000`, `20261208000000`, `20270223000000`, `20270304000000` (functions are re-created many times; the LAST definition wins).
2. `src/lib/boeCredits/settings.ts` + `src/app/api/boe-credits/settings/route.ts`; `ledger.ts`; `service.ts`.
3. `src/lib/payroll/creditCoverage.ts`, `settlement.ts`, `engine.ts` (`coveredByCredits`), `src/app/api/payroll/generate/route.ts` and `attendance-correction` service (coverage reconcile).
4. `docs/Module Docs/BOE_CREDITS.md`, `CUSTOMER_REVIEW_OUTREACH.md` section 15.
5. Read-only live queries: settings rows (newest), ledger/redemption counts, `boe_credit_balances`, migration list. Probe columns, not just ledger rows.
6. Tests of section 10 plus the ledger-pinning migration tests.

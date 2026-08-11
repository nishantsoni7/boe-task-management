# BOE TASK MANAGEMENT — Development History

Last verified: **2026-08-11**

Milestones, from Git evidence — not every commit. `main` holds **539 commits**,
first commit `5f48f59` on **2026-05-20**.

Each entry names the evidence. Anything not yet merged to `main` is marked
**branch-only** and is **not in production**.

---

## Product launches

| When | Milestone | Evidence |
| --- | --- | --- |
| 2026-05 | Project start — Next.js App Router + Supabase + Vercel | `5f48f59`, `11dc229` |
| 2026-05→06 | Task Management: create, assign, status, completion, cancellation, restore, attachments | `20260619_create_task_attachments.sql` |
| 2026-06 | Members / Employee Records: activation, soft delete, restore, permanent deletion, password reset | `20260605_add_soft_delete_users.sql` |
| 2026-06 | Performance Management + Team Performance | `20260606_add_daily_work_logs.sql` |
| 2026-06 | Sample Tracking: requests, dispatch, courier, inward verification | `20260622`–`20260630` |
| 2026-06 | Attendance: fingerprint import, records, employee mapping | `20260609`, `20260610` |
| 2026-06 | Payroll: periods, holidays, generation, review, locking | `20260611`–`20260618` |
| 2026-07 | Order Management + Order Requests, attachments, amendments | `20260707`–`20260713`, `20260816`–`20260821` |
| 2026-07 | Finance: payment requests, received payments, destinations | `20260700`, `20260716`, `20260717` |
| 2026-07 | Meetings module | permission-gated, `permissions/meetings.ts` |
| 2026-07→08 | Assets & Access lifecycle, custody, change requests | `20260726`–`20260731`, `4e11034` |
| 2026-08-08 | **Employee issue reporting** for attendance and payroll | `c89b8b8`, PR #7/#8 |
| 2026-08-09 | Payroll settlement flow and the payroll guide | `7cc9ebd`, `8cb242c` |
| 2026-08-10 | Salary-processing report with WhatsApp sharing | `c740db2`, `60aaabc`, `0147b6f` |

## Structural decisions

| When | Decision | Evidence |
| --- | --- | --- |
| ~2026-05 | Next.js + Supabase + Vercel | [ADR-0001](../adr/0001-nextjs-supabase-vercel.md) |
| ~2026-05 | Modular monolith | [ADR-0002](../adr/0002-modular-monolith.md) |
| ~2026-06 | Forward-only migrations | [ADR-0003](../adr/0003-forward-only-migrations.md) |
| 2026-07-05 | Permission engine phase 3F deployed, entered observation | `PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md` |
| 2026-08-08 | **One access decision** for launcher, routes and APIs | `88a5dba`, `moduleAccess.ts` |
| 2026-08-10 | Payroll settings versioned and **pinned per period** | `721cfa0`, `f16e207` |
| 2026-08-10 | **branch-only** — Attendance & Payroll consolidated at the UI level | `789c771`, [ADR-0004](../adr/0004-attendance-payroll-ui-consolidation.md) |
| 2026-08-11 | **branch-only** — rule content derives from engine constants | `a33c14e`, [ADR-0005](../adr/0005-guide-content-derives-from-engine-constants.md) |
| 2026-08-11 | **branch-only** — documentation contract + `docs:check` + CI | `cd125f7`, `f8ff8c2`, `cca9847`, [ADR-0007](../adr/0007-documentation-contract.md) |
| 2026-08-11 | **branch-only** — GitHub Actions `verify` workflow and PR template. `lint` non-blocking; the build is a separate job gated on `vars.CI_BUILD_ENABLED` | `cca9847` |

## Business-rule changes

| When | Change | Evidence |
| --- | --- | --- |
| 2026-08-08 | Company-paid leave settles the **earliest** item; the covered line stays visible at ₹0 | `36d7752` — the day had been vanishing from both result tabs |
| 2026-08-08 | Month built from the **calendar**, not from imported records | `ae4ff09` |
| 2026-08-08 | Unuploaded months distinguished from absences | `22d9df6`, `70bf69e` |
| 2026-08-10 | **Whole-rupee rule** — each line rounded, totals are the sum of rounded lines | `3a51ae6` |
| 2026-08-10 | Salary additions and deductions categorised | `910470e` |
| 2026-08-10 | Editable paid-leave bands, with duplicate and non-monotonic rejection | `0025abd` |
| 2026-08-10 | Corrected partial days included in deductions | `711398e` |
| — | Half-day band widened to the presence floor, retiring `short_present` | `classification.ts`; guide copy corrected 2026-08-11 in `a33c14e` (mismatch M-2) |

## Security and privacy corrections

| When | Correction | Evidence |
| --- | --- | --- |
| 2026-08 | Attendance/payroll row isolation — 5 tables had `USING (true)` | `20260812000000` |
| 2026-08 | `users` salary/notes columns made **column-granted**; `select('*')` now errors | `20260813000000`, `f240515` |
| 2026-08 | `custom` visibility confirmed **not** a grant of management access | `moduleAccess.ts`, product-owner decision |
| 2026-08-03 | Assets: removal approval is admin-only; grantable `delete` does not authorize purge | `9002723`, `83b1c75` |
| 2026-08-08 | Issue badges scoped to the viewed employee | `df19f86` |
| 2026-08-11 | **branch-only** — the three UAT scripts read credentials from the environment instead of carrying a `service_role` JWT in tracked source; `check:secrets` added and wired into `verify` | `4a36f74`, `uatScriptCredentials.test.ts` |
| 2026-08-11 | **branch-only** — the scanner reports live findings (fails) separately from historical findings (reports); a credential already in history cannot be fixed by an exit code | `a0352e5` |

**Rotation is still outstanding.** Source cleanup revoked nothing — the exposed
`service_role` key remains live until it is rotated at Supabase. Tracked files
now scan clean (758 files at `a0352e5`). See R-0 in
[09_Risk_Register.md](09_Risk_Register.md).

## Documentation corrections

Corrections to earlier records, recorded because a withdrawn claim is itself
history worth keeping.

| When | Correction | Evidence |
| --- | --- | --- |
| 2026-08-11 | **R-12 restated.** "An unregistered public holiday is charged as an absence" was inferred from an empty table and was **too strong**. The real effect: paid leave usually absorbs the day, so nothing is charged — but the employee's paid-leave entitlement is silently consumed, and the loss surfaces later on a day they genuinely take off | `298faa1`, `src/lib/payroll/engine.holidays.test.ts` |
| 2026-08-11 | `threshold_half_day_hours` labelled **inactive** in the settings UI. It is stored, validated and editable but read by no calculation; the help text had implied it still decided classification. No calculation changed | `5f9a6d8` |
| 2026-08-11 | `npm run verify` composition corrected in `AGENTS.md`, `00_README_FIRST.md` and `README.md` — it runs `check:secrets` first and calls `lint:baseline`, not `lint` | this commit |
| 2026-08-11 | Sample Tracking tables corrected to `sample_dispatches` / `sample_notifications`; `sample_requests` does not exist | this commit, verified against `supabase/migrations/` and `src/**` |

## Deferred: Supabase opaque API key migration

**Pending, not delivered.** An attempt to disable Supabase's legacy JWT API keys
failed and was reverted by re-enabling them. The new opaque key formats are
compatible with the installed packages, so **no application patch was approved or
made**. The failure is strongly linked to a production deployment whose browser
bundle still held the legacy publishable JWT key; a later deployment carries the
new publishable-key format. Legacy keys remain enabled as a safety measure.
Verification requirements are in
[02_Current_System_State.md](02_Current_System_State.md). Treat as deferred
technical cleanup.

## Module consolidations

| When | Consolidation | Evidence |
| --- | --- | --- |
| 2026-08-08 | One `resolveModuleAccess` for launcher, routes and APIs | `88a5dba` |
| 2026-08-08 | One `attendance_payroll` notification category — one feed, two doors | `b60219d`, `c139ddd` |
| 2026-08-10 | **branch-only** — one Attendance & Payroll card, shell and navigation | `789c771` |

## Important migrations

| Migration | What | Status |
| --- | --- | --- |
| `20260812000000` | Attendance/payroll row isolation | Applied |
| `20260813000000` | `users` private columns | Applied |
| `20260822000000` | `custom` module membership | Applied |
| `20260823000000` | One open issue per subject | Applied |
| `20260824000000` | Employee issue workflow | Applied |
| `20260827000000` | Punch direction provenance | Applied |
| `20260828000000` | `payroll_settings` + per-period snapshot | Applied |
| `20260829000000` | Adjustment categories | Applied |
| `20260830000000` | Controlled payroll period deletion | Applied |

Earlier: a migration-history collision (`20260612`/`20260620`/`20260621`) was
repaired **forward** in `d03a4fa`; two dead migrations were retired by
superseding them, never by editing applied files.

---

## Not in production

The branch `feat/attendance-payroll-module-merge` is **10 commits ahead of
`origin/main` `0147b6f`, and 0 behind**. `git cherry -v origin/main HEAD` shows
all 10 as unmerged. **None of this is deployed. It requires no migration.**

| Commit | What |
| --- | --- |
| `789c771` | Attendance & Payroll merged at the UI level |
| `a33c14e` | How Payroll Works redesigned as a calculation journey |
| `2d91b0c` | Project records rebuilt from code evidence; ADRs 0001–0007 created; records 07–12 added; root `CLAUDE_START_HERE.md.txt` deleted |
| `cd125f7` | `AGENTS.md` made the one contributor contract |
| `f8ff8c2` | `verify`, `typecheck`, `test`, `docs:check` and the lint ratchet |
| `cca9847` | CI `verify` workflow + PR template |
| `5f9a6d8` | `threshold_half_day_hours` labelled inactive in the settings UI |
| `298faa1` | Unregistered-holiday effect proven by test; R-12 restated |
| `4a36f74` | UAT credentials read from the environment; `check:secrets` added |
| `a0352e5` | Scanner failure and history reports separated |

`main` itself is **cherry-pick built**, so ahead/behind counts alone are
misleading — always run `git cherry -v origin/main HEAD` before judging what is
merged.

# Phase 3E — Shadow Verification

Status: **Analysis only. Zero writes.** Confirmed by re-counting `employee_permissions` (3), `role_permissions` (58), `permission_actions` (12), and `module_permission_actions` (58) before and after — all unchanged. `has_permission()` and `resolve_permission()` are both `STABLE` SQL functions; the comparison query is a pure `SELECT`.

Purpose: **not** to migrate anything — to prove that migration is safe, by comparing what the legacy system and the centralized engine would each decide, for every user and every Sample Tracking action, today.

Companion artifact: [`permissions-3e-shadow-verification.sql`](permissions-3e-shadow-verification.sql).

---

## Methodology

**Population: exhaustive, not sampled.** This app has exactly 13 users (1 admin, 1 manager, 11 members, one of them inactive). At that size, testing everyone is cheaper and stronger than picking a representative subset — so all 13 users × all 4 Sample Tracking actions = **52 checks**, zero omissions.

**What "legacy" means here — effective decision, not raw function output.** The obvious approach would be comparing `has_permission(uid, key)` directly to `resolve_permission(uid, 'sample_tracking', action)`. That would be misleading: `has_permission()` has no admin bypass built into it at all — the real RLS policies (`sample_dispatches_select`, etc.) grant admins access via a separate `role = 'admin' OR has_permission(...)` clause sitting *next to* the function call, not inside it. The centralized side, by contrast, already has admin baked in as a `role_permissions` row (Phase 3D). Comparing the two raw functions would report a "mismatch" for every admin on every action — not because anything is wrong, but because the two systems store the same real answer in different places. So this phase compares:

- **Legacy effective** = `role = 'admin' OR has_permission(uid, permission_key)` — reproducing what the live RLS policy actually decides today.
- **Centralized effective** = `resolve_permission(uid, 'sample_tracking', action_key)` — used as-is, since admin is already inside its own precedence chain.

Both sides call the real, deployed functions — nothing here reimplements or approximates either system's logic.

---

## Comparison matrix

All 52 checks, real function output, verbatim from the linked database. Mismatches first:

| User | Role | Action | Legacy Effective | Centralized Effective | Match |
|---|---|---|---|---|---|
| **Aditya** | member | dispatch | ✅ true | ❌ false | **❌ MISMATCH** |
| **Aditya** | member | receive | ✅ true | ❌ false | **❌ MISMATCH** |
| **Aditya** | member | mark_lost | ✅ true | ❌ false | **❌ MISMATCH** |
| Aditya | member | close | false | false | ✅ |
| Ajaypal *(inactive)* | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Ashok Choudhary | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Dhruv | **manager** | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Jasvi | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Mohit Sharma | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Namrata | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| **Nishant** | **admin** | dispatch/receive/mark_lost/close | ✅ true | ✅ true | ✅ (×4) |
| Prerna | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Rakesh Prajapat | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Saksham | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Santosh Patel | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |
| Shravi | member | dispatch/receive/mark_lost/close | false | false | ✅ (×4) |

**Totals: 49 / 52 match. 3 / 52 mismatch.**

---

## Mismatch detail

All 3 mismatches are the same user, same root cause:

| User | Module | Action | Legacy | Centralized | Explanation | Expected disposition |
|---|---|---|---|---|---|---|
| Aditya (`973b4337…`) | sample_tracking | dispatch | true | false | Active legacy `employee_permissions` row (`samples_dispatch`, granted 2026-06-14, never revoked) grants this. No corresponding `employee_permission_overrides` row exists yet — Phase 3C intentionally stopped at a validated dry-run and did not write it. | **Resolved by running the Phase 3C backfill before/as the first step of Phase 3F.** Not a bug — this is exactly the gap 3C's backfill script (`permissions-3f-backfill-DRAFT.sql`) exists to close. |
| Aditya | sample_tracking | receive | true | false | Same as above, for `samples_receive`. | Same fix. |
| Aditya | sample_tracking | mark_lost | true | false | Same as above, for `samples_lost`. | Same fix. |

No other mismatches of any kind were found — no unexplained resolver disagreements, no admin-parity gaps, no manager-role surprises, no issue with the one inactive account.

---

## Interpretation

This is the result the plan predicted, not a surprise: Phase 3C already identified these exact 3 rows as "would migrate directly" and produced (but did not run) the backfill for them. Phase 3E's job was to confirm that **nothing else** diverges — and nothing else does. The centralized engine agrees with legacy in 49 of 52 cases out of the box (mostly "everyone is denied by default," plus full admin parity thanks to Phase 3D), and the only 3 disagreements are precisely the 3 rows still waiting on the already-validated backfill.

---

## Conclusion

**Mismatches found — as expected, with a known and already-prepared fix.**

Phase 3F may proceed **only if** the Phase 3C backfill (`permissions-3f-backfill-DRAFT.sql` PART 3) runs before or as the first step of the cutover. If RLS is switched to `resolve_permission()` while these 3 rows remain unmigrated, Aditya silently loses dispatch/receive/mark_lost access the moment the cutover ships — a real regression for the one actual user of this ad hoc mechanism.

**Recommended addition to the Phase 3F exit criteria** (in `PERMISSIONS_MIGRATION_PHASE3A.md` §6): add "backfill executed and re-verified with zero mismatches" as its own checklist line, distinct from "shadow comparison passes" — the shadow comparison here passed *with known, explained mismatches*; 3F's actual gate should be re-running this same script post-backfill and seeing **0 mismatches out of 52**, not just "0 unexplained mismatches."

---

## Post-backfill re-verification (2026-07-04) — pre-cutover gate closed

The backfill above was executed as its own standalone step — **not** as part of Phase 3F, no RLS/app/UI code changed alongside it — via
[`20260664_backfill_sample_tracking_employee_overrides.sql`](../../supabase/migrations/20260664_backfill_sample_tracking_employee_overrides.sql)
(identical SQL to `permissions-3f-backfill-DRAFT.sql` PART 3).

**Write verified by ID-level diff, not aggregate counts** (this DB has live concurrent traffic — `employee_permission_overrides` moved from 6→10 rows for unrelated reasons between Phase 3D and this step, so counts alone are not trustworthy evidence here):

| Check | Result |
|---|---|
| Pre-existing `employee_permission_overrides` rows (10, snapshotted by ID before the write) | ✅ all 10 still present, unmodified |
| New rows | ✅ exactly 3 — all `user_id = 973b4337…` (Aditya), `module = sample_tracking`, actions `dispatch`/`receive`/`mark_lost`, `allowed: true`, `granted_by`/`granted_at` carried over verbatim from the matching legacy row |
| Duplicate `(user_id, module_id, action_id)` combos, whole table | ✅ 0 |
| Other permission tables (`employee_permissions`, `permission_modules`, `permission_actions`, `module_permission_actions`, `role_permissions`) | ✅ all unchanged (3/9/12/58/58 before and after) |

**Re-ran [`permissions-3e-shadow-verification.sql`](permissions-3e-shadow-verification.sql) unchanged** (same query, no edits):

**Result: 52/52 matches. 0 unexplained mismatches. 0 expected mismatches.** Aditya's `dispatch`/`receive`/`mark_lost` now show `legacy_effective: true, centralized_effective: true, match: true` — the 3 rows that were the only divergence in the first pass are now identical on both sides. Every other row is unchanged from the first run.

**Pre-cutover checklist status** (per `PERMISSIONS_MIGRATION_PHASE3A.md` §6): all items now complete —
```
✅ Registry complete                                          (3B)
✅ Catalog synchronized                                        (3B)
✅ Legacy permission mappings finalized                        (3C)
✅ Centralized default role permissions populated              (3D)
✅ Backfill SQL validated                                      (3C)
✅ Shadow verification shows no unexpected mismatches         (3E)
✅ Backfill executed and re-verified with ZERO mismatches      (this step — 52/52)
☐ Rollback procedure documented                                (still open — belongs to 3F planning)
```
Every data-validation gate for the migration is now closed. The only remaining open item, rollback procedure documentation, is part of planning the actual behavioral cutover (Phase 3F) — which remains its own, separate approval point, since it's the first step that changes what enforces authorization at runtime.

---

## Verification — did this phase stay analytical?

| Requirement | Result |
|---|---|
| No writes | ✅ all 4 affected tables re-counted identical before/after |
| No RLS changes | ✅ `git status` shows no RLS/migration files touched this phase |
| No application changes | ✅ no `src/` files touched |
| Real functions used, not reimplemented | ✅ query calls `has_permission()` and `resolve_permission()` directly |
| Every user x every action covered | ✅ 13 × 4 = 52, exhaustive not sampled |
| Every mismatch explained | ✅ all 3 attributed to the same known, already-validated cause |

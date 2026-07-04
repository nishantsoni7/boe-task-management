# Phase 3C — Legacy Data Backfill Planning

Status: **Analysis only. Zero writes.** Confirmed by re-counting all three affected tables (`employee_permissions`, `employee_permission_overrides`, `permission_actions`) before and after every query in this phase — counts identical (3 / 2 / 12).

Question this phase answers: **"If we migrated `employee_permissions` into the centralized engine today, exactly what would be written?"**

Companion artifact: [`permissions-3f-backfill-DRAFT.sql`](permissions-3f-backfill-DRAFT.sql) — the dry-run query, the validation query, and the (fully commented-out, unexecuted) backfill `INSERT`. Not a Supabase migration file; not applied by any tooling.

---

## 1. Legacy permission value inventory

Read directly from the live `employee_permissions` table (read-only `SELECT`, service-role client):

| Metric | Value |
|---|---|
| Total rows | **3** |
| Distinct `permission_key` values present | **3**: `samples_dispatch`, `samples_receive`, `samples_lost` |
| `samples_close` rows | **0** — consistent with Phase 3A's finding that this key was reserved but never wired into any UI or RLS policy |
| Active rows (`revoked_at IS NULL`) | 3 (100%) |
| Revoked rows | 0 |
| Distinct users holding a grant | 1 — `Aditya` (`role: member`, `team: sales`, `is_active: true`) |
| Distinct granters | 1 — `Nishant` (`role: admin`, `is_active: true`) |
| Grant dates | All 2026-06-14 |
| Orphaned `user_id` / `granted_by` / `revoked_by` (row references a deleted user) | **0** — every reference resolves to an existing, active `users` row |
| Unrecognized/typo'd `permission_key` values | **0** |

The legacy dataset is small and clean: one employee (a Sales team member) was manually granted all three wired Sample Tracking permissions on the same day, and nothing has been revoked since.

---

## 2. One-to-one mapping table

Established in Phase 3B (action keys already exist in the centralized catalog — nothing new needed here, just confirming the mapping and the live IDs):

| Legacy `permission_key` | Legacy rows (active / revoked) | → `module_key` | → `action_key` | `action_id` | Classification (Phase 3A vocabulary) |
|---|---|---|---|---|---|
| `samples_dispatch` | 1 / 0 | `sample_tracking` | `dispatch` | `d98bbc38-668d…` | Direct Mapping |
| `samples_receive` | 1 / 0 | `sample_tracking` | `receive` | `431e02ef-c193…` | Direct Mapping |
| `samples_lost` | 1 / 0 | `sample_tracking` | `mark_lost` | `73af51fa-cddf…` | Direct Mapping |
| `samples_close` | 0 / 0 | `sample_tracking` | `close` | `a7d460f9-a00c…` | N/A — no legacy data exists to migrate; mapping target is ready if any ever appear |

`sample_tracking` module id: `888a3c41-371c-43f9-97a6-de01209d7185` (unchanged since Phase 3B).

**Why every row is "Direct Mapping," not "Transform":** the two schemas are structurally identical for this purpose — both have `user_id`, `granted_by`, `granted_at`, `revoked_by`, `revoked_at` with the same semantics. The only translation needed is the key lookup (`permission_key` text → `module_id` + `action_id`); no field needs to be recomputed, merged, or reinterpreted. `allowed` is always `true` in the backfill because the legacy table has no concept of an explicit deny — a row's mere existence *is* the grant, and revocation is (and always was) represented the same way in both tables: a `revoked_at`/`revoked_by` pair, not row deletion.

---

## 3. Dry-run migration plan

[`permissions-3f-backfill-DRAFT.sql`](permissions-3f-backfill-DRAFT.sql) PART 1 executed read-only against the linked database. Actual output (verbatim):

| legacy_row_id | permission_key | target_action_key | legacy_is_active | unmappable | would_collide | disposition |
|---|---|---|---|---|---|---|
| `d0d2f425…` | `samples_dispatch` | `dispatch` | true | false | false | **WOULD_MIGRATE** |
| `8e0cd862…` | `samples_lost` | `mark_lost` | true | false | false | **WOULD_MIGRATE** |
| `723d1634…` | `samples_receive` | `receive` | true | false | false | **WOULD_MIGRATE** |

Collision check: queried every existing `employee_permission_overrides` row for the `sample_tracking` module — **zero rows exist**. (The centralized table has 2 rows total, both for the unrelated `attendance` module, both already soft-revoked, both belonging to a different user — leftover from Phase 2's manual UI verification. No overlap with this backfill.)

---

## 4. Validation statistics

[`permissions-3f-backfill-DRAFT.sql`](permissions-3f-backfill-DRAFT.sql) PART 2 executed read-only against the linked database. Actual output (verbatim):

| Would migrate directly | Transformed | Skipped (collision) | Rejected (unmappable) | Total |
|---|---|---|---|---|
| **3** | **0** | **0** | **0** | **3** |

All 3 legacy rows have a clean, unambiguous target and nothing stands in the way of migrating them.

---

## 5. Unmappable or ambiguous cases

**None found in current data.** Every `permission_key` value present resolves to a valid `(module_key, action_key)` pair, every referenced user exists, and no existing override would be clobbered.

The dry-run script's detection logic (kept live, not just a one-time check) covers three ways a future row *could* become unmappable or ambiguous, so re-running PART 1 before 3F actually ships will catch any drift between now and then:
- **Unrecognized `permission_key`** — anything outside the 4-key map would show `unmappable: true` and disposition `REJECTED`. (Nothing in the current schema/RLS can produce this — `permission_key` is free-text with no `CHECK` constraint — so it's a real, if currently empty, risk category.)
- **Pre-existing centralized override for the same (user, module, action)** — would show `would_collide_with_existing_override: true` and disposition `SKIPPED`, to avoid the backfill silently overwriting something set independently through the Phase 2 Permission Management UI.
- **New legacy grants added between now and 3F** — since there is no application UI that writes to `employee_permissions` (confirmed in Phase 3A), any new rows would come from direct DB access; re-running PART 1 picks them up automatically.

---

## 6. Production-ready migration script (not executed)

[`permissions-3f-backfill-DRAFT.sql`](permissions-3f-backfill-DRAFT.sql) PART 3. Properties:
- **Idempotent** — guarded by both a `NOT EXISTS` check and `ON CONFLICT (user_id, module_id, action_id) DO NOTHING`, so running it twice is a no-op the second time.
- **Self-limiting to mappable rows** — uses `INNER JOIN`s to the key map and `permission_actions`, so any row with an unmappable `permission_key` is silently excluded rather than erroring, matching the "rejected" disposition from PART 1.
- **Not runnable by accident** — every line of the actual `INSERT` is SQL-commented out in the file. Copying it into a real migration (only at Phase 3F, only after the 3F exit criteria in the 3A doc are met) requires deliberately un-commenting it.

---

## Verification — did this phase stay analytical?

| Requirement | Result |
|---|---|
| Legacy database (`employee_permissions`) unchanged | ✅ 3 rows before and after |
| Centralized database (`employee_permission_overrides`, `permission_actions`, etc.) unchanged | ✅ 2 / 12 rows before and after |
| Proposed migration accounts for every legacy row | ✅ all 3 rows classified (all `WOULD_MIGRATE`) |
| Unmappable permissions explicitly identified | ✅ 0 found; detection logic documented and re-runnable |
| Migration reviewable before any writes occur | ✅ `permissions-3f-backfill-DRAFT.sql` PART 3 is fully commented out; nothing executed this phase beyond `SELECT` |
| No migration files created | ✅ artifact lives in `docs/Module Docs/`, not `supabase/migrations/` |
| No RLS, resolver, or application code touched | ✅ `git status` shows no changes to any of those files this phase |

Phase 3C is complete. Given how small and clean the real dataset turned out to be (3 rows, 1 user, 0 edge cases), Phase 3D (populate `role_permissions` for `admin` only on the 4 new actions) and Phase 3E (shadow verification) should both be straightforward — there's very little surface area for divergence to hide in.

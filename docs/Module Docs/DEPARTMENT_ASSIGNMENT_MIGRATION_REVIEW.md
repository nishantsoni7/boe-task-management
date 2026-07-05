# Department Assignment Migration Review

Status: **Review only — no schema change, no migration, no application code touched.**

Date: 2026-07-05

## 1. Current state

- `users.team` is a fixed Postgres enum, `user_team`: `sales | operations | design | purchase | bdm | management` (NOT NULL). `tasks.team` is a **separate** enum, `task_team`, with the identical value set — confirmed via `schema.json`, two distinct `format` types (`public.user_team` vs `public.task_team`). Neither `CREATE TYPE` statement exists in `supabase/migrations/` — both predate migration tracking, most likely created directly in the Supabase dashboard before this repo's migrations directory existed.
- `departments` (added in `supabase/migrations/20260645_create_control_center_v1.sql`, lines 68-76) is a free-form, admin-editable table: `id uuid PK`, `department_key text UNIQUE NOT NULL`, `department_name text`, `is_active`, `sort_order`. It was seeded with exactly the 6 enum values and has **no FK to `users.team`** — the migration's own comment says so explicitly (lines 13-15: "departments.department_key must match the values stored in users.team" is a stated convention, not an enforced constraint).
- Control Center already lets admins insert arbitrary `department_key` rows (e.g. `hr`) via `src/app/api/control-center/departments/route.ts`. Assigning one of these new departments to a person fails at the database with `invalid input value for enum user_team`, because `/api/update-member` writes straight into the enum column with no application-level validation.
- As a stopgap, `src/app/admin/control-center/page.tsx` currently has an uncommitted client-side guard (`ASSIGNABLE_TEAM_KEYS`, lines ~43-45 and ~633-634) that disables non-enum options in the People-edit department dropdown with a "not assignable yet" label. This masks the save error but does not solve the underlying problem — the enum itself is untouched.
- Separately, `src/app/admin/members/page.tsx:13` and `src/app/attendance/employees/page.tsx:48` each hardcode their **own** `TEAMS = ['sales','operations','design','purchase','bdm','management']` array for their own team dropdowns — neither reads from the `departments` table at all. `/admin/members` is still a live, admin-only route (`employee_records` module, seeded in `20260645_create_control_center_v1.sql:63`) that writes to `users.team` through the same `/api/update-member` endpoint Control Center uses.

## 2. Root cause

`users.team` was designed when "team" and "department" were the same fixed, small set of business units, and a Postgres enum was a reasonable way to constrain it. Control Center's Departments feature later generalized "department" into an open-ended, admin-managed table — but the one column that actually assigns a department to a person (`users.team`) was never re-pointed at that same table. The enum type is the single hard blocker; everything else already treats `team` as an opaque string/department key rather than a closed set enforced in application code.

## 3. Repo evidence summary

- **Enums:** `schema.json` → `definitions.users.properties.team`: `{"enum":["sales","operations","design","purchase","bdm","management"],"format":"public.user_team","type":"string"}`; `definitions.tasks.properties.team`: same enum values, `"format":"public.task_team"`. `definitions.users.required` includes `"team"` (NOT NULL).
- **No `CREATE TYPE` in tracked migrations:** `grep -rn "CREATE TYPE" supabase/migrations` returns nothing for `user_team`/`task_team`.
- **`departments` table definition:** `supabase/migrations/20260645_create_control_center_v1.sql:68-76`, seeded at lines 97-104 with the 6 original values.
- **No FK/CHECK linking the two:** confirmed by the `20260645` comment block (lines 13-15) and again by `src/app/api/control-center/departments/[key]/route.ts:48-52`, which explains in a comment that an app-level orphan check (not a DB constraint) is what keeps department deletion safe.
- **No application-level enum validation exists anywhere:** `/api/update-member/route.ts` (lines 7, 48), `/api/create-user/route.ts` (~line 45), `/api/create-employee/route.ts` (~line 70) all write `team` as a raw passthrough. `src/lib/types.ts` types `UserProfile.team` and `Task.team` as plain `string` (lines 65 and 41/245) — no TypeScript union restricts the value anywhere.
- **Permission resolver already treats `team` as text:** `resolve_effective_permissions()` / `resolve_effective_permissions_for_user()` (`supabase/migrations/20260662_fix_permission_resolver_team_cast.sql:41,82`) join `LEFT JOIN public.departments d ON d.department_key = u.team::text`. The explicit `::text` cast exists only because `user_team` is an enum (Postgres has no `text = user_team` operator) — this was a real production bug (error 42883) hit once during Phase 2 rollout and fixed forward in that migration.
- **Module visibility already treats `team` as text:** `src/lib/moduleAccess.ts:19` — `profile.team?.toLowerCase() === allowedDepartment?.toLowerCase()`, a plain case-insensitive string comparison against `app_modules.allowed_department` (a `text` column), built enum-agnostic from the start.
- **Hardcoded literal RLS dependency (unrelated to Control Center):** `supabase/migrations/20260655_create_orders.sql:110,116,119` and `20260656_create_order_activity_log.sql:50,56` gate 5 RLS policies on the literal `users.team = 'operations'`. This is a string/enum-literal comparison that behaves identically whether the column is enum or text — not a blocker for either option, just a pre-existing hardcoded business rule worth knowing about.
- **`tasks.team` is populated by copying `users.team` at task-creation time:** `src/app/tasks/create/page.tsx:61-67` fetches the creator's own profile and does `setTeam(profileData.team)`, then submits it verbatim (line 143). `src/app/tasks/quotation-requests/new/page.tsx:119` does the same (`team: profile?.team ?? 'sales'`). If a user's `users.team` is ever set to a value outside `task_team`'s 6 labels, task creation for that person fails the same way People-Edit does today, just in a different table.
- **Legacy `has_permission()` mechanism has zero dependency on `team`:** `supabase/migrations/20260634_create_employee_permissions.sql` — fully independent of this review, unaffected by any option below.
- **Timing consideration:** `resolve_permission()` / `resolve_effective_permissions()` are not dormant. Phase 3F (`supabase/migrations/20260665_cutover_sample_tracking_rls_to_resolver.sql`) cut 4 live `sample_dispatches` RLS policies over to call them. Per `docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md`, this shipped to production on 2026-07-05 (commit `c1b3468`) and is explicitly still in its post-deploy observation window, with Phase 3G blocked until that window closes cleanly.

## 4. Impact map

**Writes to `users.team`**

| File | Line(s) | Validation |
|---|---|---|
| `src/app/api/update-member/route.ts` | 7, 48 | none — raw passthrough |
| `src/app/api/create-user/route.ts` | ~45 | none |
| `src/app/api/create-employee/route.ts` | ~70 | none, optional, defaults null |

**Reads/filters by `users.team`**

| File | Line(s) | Nature |
|---|---|---|
| `src/app/api/admin-members/route.ts` | 4 | column select, opaque |
| `src/app/api/employee-list/route.ts` | 5, 12 | column select, opaque |
| `src/app/api/control-center/departments/[key]/route.ts` | 65 | `.eq('team', key)` — pre-delete orphan check |
| `src/app/api/control-center/permissions/employees/[id]/route.ts` | 55, 68 | reads team, joins to `department_key` for display |
| `src/app/api/performance-metrics/team/route.ts` | 50, 112 | display only |
| `src/app/api/performance-audit/route.ts` | 31, 34, 42, 260 | passed into an LLM prompt as a label |
| `src/app/api/eod-logs/team/route.ts` | 55, 73 | display only |
| Attendance routes (`employee-records`, `dashboard`, `records`, `monthly-summary`, `employee-monthly-detail`), Payroll routes (`generate`, `results`) | — | none touch `team` at all |

**Frontend**

| File | Dependency |
|---|---|
| `src/lib/moduleAccess.ts:19` | `department_only` visibility, pure string comparison, enum-agnostic |
| `src/app/admin/control-center/page.tsx` | 43-45 hardcoded `ASSIGNABLE_TEAM_KEYS` (temporary guard); 508, 673 opaque `m.team === key` filters/counts; 549, 826 read/display |
| `src/app/admin/control-center/permissions/page.tsx` | 534, 561-564, 573 — opaque `deptLabel()` lookup against `department_key` |
| `src/app/admin/members/page.tsx` | 13 hardcoded `TEAMS`; opaque display/write elsewhere |
| `src/app/attendance/employees/page.tsx` | 48 hardcoded `TEAMS` |
| `src/app/attendance/employees/[id]/page.tsx`, `src/app/modules/page.tsx`, `src/app/account/page.tsx`, `src/app/manager/page.tsx` | opaque display/read only |
| `src/app/orders/[id]/page.tsx:69` | `profile.team === 'operations'` literal check |
| `src/app/showroom-admin/page.tsx`, `.../qr/page.tsx` | `.includes('sales')` substring checks — already loose |
| `src/app/tasks/create/page.tsx`, `src/app/tasks/quotation-requests/new/page.tsx` | auto-copies `users.team` into `tasks.team` at task creation |
| `src/lib/types.ts:65` (and 41/245) | `UserProfile.team: string`, `Task.team: string` — no TS union restricts this anywhere |

**Database / RLS**

| Object | Dependency |
|---|---|
| `departments` table | no FK/CHECK against `users.team`; convention + app-level orphan check only |
| `department_permissions.department_id` | clean `uuid` FK to `departments(id)` — not the risky link |
| `resolve_effective_permissions()` / `resolve_effective_permissions_for_user()` | `::text` cast on `u.team` to join `departments.department_key` |
| `orders` / `order_activity_log` RLS | 5 policies hardcode literal `users.team = 'operations'` |
| `has_permission()` (legacy) | no dependency on `team` at all |

## 5. Options comparison

### Option A — Add missing departments (HR, Marketing, Admin) to the `user_team` enum

- **Pros:** Smallest possible diff; one `ALTER TYPE ... ADD VALUE` per new department; no application code changes required; keeps DB-level input validation "for free."
- **Cons:** Doesn't solve the actual problem — it's a point patch. Every *future* department Control Center creates needs another manual `ALTER TYPE` + deploy before it's assignable, which works against the stated goal of Control Center being the department source of truth. `tasks.team` (a different enum) would still need the same values added separately, or task creation breaks for the new departments' employees. Enum values, once added, cannot be cleanly removed if a department is later deleted/renamed — that requires a full type rebuild.
- **Risk:** Low for this specific request, but it's a recurring cost — every "add a department" ask becomes an engineering ticket, and Control Center's create-department UI would keep silently producing unassignable departments until someone remembers to also touch the enum.
- **Future flexibility:** Poor — actively works against the stated product direction.
- **Required files/migrations:** One migration (`ALTER TYPE public.user_team ADD VALUE ...` ×3, and the same for `public.task_team` if task creation is also to be unblocked); no application changes.
- **Recommended:** No — only viable as a temporary stopgap if Option B must be deferred longer than expected.

### Option B — Convert `users.team` from enum to text, aligned with `departments.department_key`

- **Pros:** Matches the architecture that is already half-built — `departments`, `moduleAccess.ts`, and the permission resolver already treat department as a free-form text key; this closes the one remaining gap. Makes Control Center genuinely the source of truth going forward, with zero recurring migration cost per new department. Removes the `::text` cast in the resolver functions (cosmetic, but simplifies future SQL review).
- **Cons:** Requires an actual DDL change to a NOT NULL column on `users`, which is inherently more sensitive than an additive `ALTER TYPE ADD VALUE`. Loses DB-level enforcement that a team value is one of a known set — that enforcement needs to move to an application-level check or a `CHECK` constraint against `departments.department_key` (a small addition, since no route validates today anyway).
- **Risk:** Moderate, driven almost entirely by timing, not technical difficulty — see §9/§12. No application code was found in this review that breaks under this option.
- **Future flexibility:** High — this is the correct end state, and is the direction this review recommends.
- **Required files/migrations:** A migration converting the column type, optionally a `CHECK` constraint against `departments.department_key` for validation; removal of the `ASSIGNABLE_TEAM_KEYS` guard in `src/app/admin/control-center/page.tsx`. No changes needed in `moduleAccess.ts`, `resolver.ts`, any read-only API route, or `types.ts`.
- **Recommended:** Yes — recommended technical direction, sequenced per §6/§12.

### Option C — Keep the enum and prevent creating unassignable departments

- **Pros:** Zero schema risk; formalizes today's temporary UI guard into a permanent product rule (e.g. Control Center's "create department" form only accepts one of the 6 existing keys, or blocks free-text department creation entirely).
- **Cons:** Directly contradicts the stated goal of letting admins create and assign new departments. Does not move BOE toward "Control Center is source of truth" — it retreats from it.
- **Risk:** Lowest technical risk, highest product risk (this is a feature regression relative to what was asked for).
- **Future flexibility:** None — this is the "pause the initiative" option.
- **Required files/migrations:** A small validation change in `src/app/api/control-center/departments/route.ts`'s POST handler to reject `department_key` values outside the enum's set. No migration.
- **Recommended:** No — only appropriate if the product decision is to pause department-assignment work entirely, not as a target state.

## 6. Recommended approach

**Option B is the recommended technical direction.** Nothing found in this review makes it technically unsafe — the codebase was already largely built as if `team` were text (`moduleAccess.ts`, the permission resolver's join, all UI display code). The one place enum-ness is actually relied on is DB-level input validation, which can be replaced by an application-level or `CHECK`-constraint validation against `departments.department_key` with an equivalent guarantee.

**However, the schema change should not be executed until the Phase 3F production observation period is closed.** `users.team` feeds directly into `resolve_effective_permissions()`/`resolve_effective_permissions_for_user()`, and those functions are — as of 2026-07-05 — the live authorization path for Sample Tracking in production (Phase 3F, commit `c1b3468`), per `docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md`, which is still mid-observation with Phase 3G explicitly blocked. Stacking a schema change to the same column onto an unrelated, still-open production observation window is an avoidable risk, not a necessary one — it resolves itself once that window closes.

**`tasks.team` is out of scope for this initial effort.** It is a separate Postgres enum (`task_team`), coupled to `users.team` only through application logic (task creation copies the creator's `users.team` value into the new task's `team` field). Whether/how to let employees in new departments create team-scoped tasks is a distinct product decision, not an automatic consequence of fixing People assignment, and is called out here so it isn't discovered later as a surprise gap rather than being silently bundled into this migration.

**Initial implementation should be scoped narrowly:** convert `users.team` only, unblock People assignment in Control Center, and explicitly preserve current permission-resolver and module-visibility behavior (both already tolerate text and require no logic changes — only confirmation via the verification checklist in §11).

## 7. Proposed phased implementation plan

This plan is for future approval — no phase below is being executed by this document.

**Phase 0 (prerequisite, scheduling only, not code):** Confirm the Phase 3F observation checklist in `docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md` §5 is closed before starting Phase 1.

**Phase 1 — Schema conversion:**
- Convert `users.team` from the `user_team` enum to `text`.
- Add a validation mechanism replacing the lost enum guarantee — a `CHECK` constraint (or trigger) validating `team` (when not null) exists in `departments.department_key`, rather than a hard FK (a FK would force every legacy value to already exist in `departments`, which it does today, but a `CHECK` is easier to relax later if a "no department" state needs to stay valid).
- Do not touch `tasks.team`/`task_team` in this phase.
- Forward-fix the `::text` casts in `resolve_effective_permissions()`/`resolve_effective_permissions_for_user()` via a new `CREATE OR REPLACE FUNCTION` migration (cosmetic cleanup only, following this repo's established "fix forward, don't edit applied migrations" convention) — confirms by construction that no cast is silently relied upon.

**Phase 2 — Unblock People-Edit:**
- Remove the `ASSIGNABLE_TEAM_KEYS` guard and the disabled-option/"not assignable yet" UI in `src/app/admin/control-center/page.tsx`.
- Separately decide (a product call, not an engineering one) whether `/admin/members` and `/attendance/employees`'s hardcoded `TEAMS` arrays should be replaced with a live fetch from `departments`, or left as-is (safe either way today since they only ever submit enum-valid values currently).

**Phase 3 — Task creation coupling (separate decision, not part of this migration):**
- Decide whether employees in new departments (HR, Marketing, Admin) should create `tasks.team`-scoped tasks the same way sales/ops/design do, or whether Task Management's team field should stop being auto-derived from `users.team` for non-operational departments. Flagged here so it is a deliberate decision, not a bug discovered later.

## 8. Affected files/modules

**Phase 1+2 only (the scope recommended for initial implementation):**

- New migration file (not created by this document), e.g. `supabase/migrations/<date>_convert_users_team_to_text.sql`
- New migration file for the resolver `::text` cast cleanup (optional/cosmetic, forward-fix convention)
- `src/app/admin/control-center/page.tsx` — remove the temporary `ASSIGNABLE_TEAM_KEYS` guard

**Not expected to require changes:** `src/lib/moduleAccess.ts`, `src/lib/permissions/resolver.ts`, any API route listed in §4, `src/lib/types.ts`, any display-only page.

**Explicitly out of scope for this initiative:** `tasks.team`/`task_team`, Sample Tracking (`employee_permissions`, `has_permission()`, `sample_dispatches` RLS), Phase 3G legacy retirement, `/admin/members` and `/attendance/employees` hardcoded `TEAMS` arrays (decision deferred, not required for correctness today).

## 9. Database migration direction (no SQL created yet)

- **Column type change:** `users.team` changes from the `user_team` enum to `text`, using a `USING team::text` cast so existing values are preserved verbatim.
- **Replacement validation:** a `CHECK` constraint (preferred over a hard FK) tying non-null `team` values to `departments.department_key`, so the database still rejects garbage values without requiring every historical/legacy value to pre-exist in `departments` as a hard dependency.
- **Enum type retirement:** the `user_team` enum type itself should **not** be dropped in the same migration as the column conversion — keep it defined-but-unused for at least one release cycle so a revert is a simple, safe `ALTER COLUMN` rather than requiring the type to be recreated from scratch. Drop it only in a later, separate cleanup migration once confidence is established.
- **Resolver functions:** `resolve_effective_permissions()` / `resolve_effective_permissions_for_user()` get a `CREATE OR REPLACE` removing the now-unnecessary `::text` cast — behavior-preserving, not behavior-changing.
- **`tasks.team`/`task_team`:** explicitly not touched by this migration direction.

## 10. Rollback considerations

- The column-type change is reversible via `ALTER COLUMN team TYPE public.user_team USING team::public.user_team`, **but only as long as no row has acquired a value outside the original 6 during the window it was text** — if an admin has already assigned a genuinely new department (e.g. `hr`) to someone, that row would fail to cast back to the old enum. Practical mitigation: don't drop the old enum type immediately (see §9), and treat "no new-department assignments have happened yet" as the rollback window's implicit boundary.
- The resolver function change is a pure `CREATE OR REPLACE` — trivially revertible by reapplying the text from `supabase/migrations/20260662_fix_permission_resolver_team_cast.sql`.
- The `ASSIGNABLE_TEAM_KEYS` guard removal in `control-center/page.tsx` is a normal `git revert`.
- Legacy `employee_permissions`/`has_permission()` and all Phase 3F artifacts are untouched by this plan and remain fully available as-is regardless of whether this migration proceeds or is rolled back — this plan does not put Sample Tracking's rollback posture at any additional risk.

## 11. Verification checklist

- [ ] Confirm the Phase 3F observation checklist (`docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md` §5) is closed, or obtain explicit sign-off to proceed anyway with that risk knowingly accepted.
- [ ] `SELECT DISTINCT team FROM users` and `SELECT DISTINCT team FROM tasks` against production to confirm current values are exactly the 6 known ones (no drift beyond what's expected).
- [ ] Search the live database for any function/view/policy referencing `user_team` or `u.team` beyond what's catalogued in §3/§4 — both enums predate migration tracking, so an untracked object is possible.
- [ ] After the schema change, run `resolve_permission()`/`resolve_effective_permissions()` for a representative user of each existing team and confirm identical output to pre-migration.
- [ ] Confirm `/admin/members`, `/attendance/employees`, Control Center People, Performance, EOD logs, Account page, and Orders all render unchanged for existing users after the type change.
- [ ] Confirm task creation still succeeds for one user per existing team (sanity check that `tasks.team` is unaffected).
- [ ] Only then, test assigning a genuinely new department (e.g. `hr`) end-to-end: Control Center create → assign to person → module visibility respects it if a `department_only` module is later scoped to it → permission resolver correctly resolves `department_permissions` for that department if any are configured.

## 12. Proceed or wait

**Wait on executing the schema change. Proceed now only with drafting the actual migration SQL for a future, separate approval.** The technical case for Option B is solid and this review found no code path that breaks under it — but the timing overlaps a live, still-observed production cutover (Phase 3F) that reads through the exact function this change touches. That is a scheduling risk, not a design flaw, and it resolves itself once the observation window closes. Treat Phase 1 as ready to execute the moment Phase 3F's checklist is complete, rather than opening two live risk windows on the same code path at once.

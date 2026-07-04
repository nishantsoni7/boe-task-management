# Legacy `employee_permissions` — Phase 3A Review & Migration Plan

Status: **Analysis only.** No production code, schema, or behavior was changed to produce this document.
Scope: every use of the legacy `employee_permissions` table / `has_permission()` function in the codebase, as of 2026-07-04 (commit `35dc074`).

---

## 0. Executive summary

The legacy system is small and fully contained: **one table, one SQL function, four RLS policies, one API route, and two page components — all scoped to Sample Tracking.** No other module (Task Management, Attendance, Payroll, Finance, Assets & Access, Employee Records, Performance, Showroom QR) touches it.

The centralized permission engine (Phase 1+2, `35dc074`) already has a `sample_tracking` module registered, but its action set is generic CRUD (`view/create/edit/delete/approve/export/manage`) — it does **not** yet have the fine-grained lifecycle actions (`samples_dispatch`, `samples_receive`, `samples_lost`, `samples_close`) that the legacy system uses. That's the one genuine gap blocking a direct cutover; closing it is schema-only and additive (Phase 3B below).

There is **no admin UI that writes** `employee_permissions` rows anywhere in the app. All four permission keys currently in use are granted out-of-band (direct DB/Supabase Studio). This simplifies migration: there's no write-path UI to port, only a one-time data copy.

---

## 1. Legacy Permission Inventory

| permission_key | Introduced | Wired into UI/RLS? | Notes |
|---|---|---|---|
| `samples_dispatch` | `20260634` | Yes | Gates "Add Tracking Details" / dispatch form on both samples pages; RLS `qr_submitted → dispatched` |
| `samples_receive` | `20260634` | Yes | Gates "Mark Received & Close"; RLS `dispatched → returned` |
| `samples_lost` | `20260634` | Yes | Gates "Mark Lost"; RLS `dispatched → lost` |
| `samples_close` | `20260634` | **No** | Reserved. Included only in the OR-chain that grants row *visibility* (`sample_dispatches_select`) and in the UI's `effectiveHasAnySamplePermission` check. No UI control and no dedicated RLS UPDATE policy exist for it — migration comment confirms it's "wired when the closed status is introduced." |

Mechanism inventory:
- **Table**: `employee_permissions` (`user_id`, `permission_key` free-text, `granted_by`, `granted_at`, `revoked_by`, `revoked_at`)
- **Function**: `has_permission(uid uuid, pkey text) RETURNS boolean` — `SECURITY DEFINER`, used only inside RLS `USING`/`WITH CHECK` clauses
- **RLS policies on `employee_permissions` itself**: `ep_select_own` (self-read), `ep_insert_admin`, `ep_update_admin`, `ep_delete_admin` (admin-only writes)
- **RLS policies on `sample_dispatches`** that call `has_permission()`: `sample_dispatches_select`, `sd_update_perm_dispatch`, `sd_update_perm_receive`, `sd_update_perm_lost`

⚠️ **Naming collision, not a dependency**: the centralized engine's `employee_permission_overrides` table (and its TS type `EmployeePermissionOverrideRow` in [`src/lib/permissions/types.ts`](../../src/lib/permissions/types.ts)) is a *different, unrelated* table that happens to have a very similar name. The `20260660` migration explicitly calls this out: "Deliberately separate from the existing `employee_permissions` table." Anyone grepping `employee_permission` will hit both — do not conflate them.

---

## 2. Usage Matrix

| # | File | Function/Location | Purpose | Protected feature | Legacy permission(s) | Equivalent centralized permission | Classification | Risk |
|---|---|---|---|---|---|---|---|---|
| 1 | [`supabase/migrations/20260634_create_employee_permissions.sql`](../../supabase/migrations/20260634_create_employee_permissions.sql) | `employee_permissions` table + `ep_*` RLS policies | Data store for grants/revokes | Storage mechanism itself | N/A | `employee_permission_overrides` (schema already exists, Phase 2) | **Retire** (after §3 cutover + soak period) | Low |
| 2 | same file | `has_permission(uid, pkey)` SQL function | `SECURITY DEFINER` helper called from RLS | Sample Tracking RLS | any `samples_*` key | `resolve_permission(user_id, 'sample_tracking', action_key)` | **Transform** | **High** |
| 3 | same file | `sample_dispatches_select` policy | Row visibility for non-admin permission holders | Sample Tracking — read | `samples_dispatch`, `samples_receive`, `samples_lost`, `samples_close` | new action(s) on `sample_tracking` module (see §5) | **Transform** | **High** |
| 4 | same file | `sd_update_perm_dispatch`, `sd_update_perm_receive`, `sd_update_perm_lost` policies | Narrow per-status UPDATE grants | Sample lifecycle transitions | `samples_dispatch` / `samples_receive` / `samples_lost` respectively | new custom actions, e.g. `dispatch` / `receive` / `mark_lost` on `sample_tracking` | **Transform** | **High** |
| 5 | [`src/app/api/admin/user-permissions/route.ts`](../../src/app/api/admin/user-permissions/route.ts) | `GET` handler | Admin-only, service-role read of another user's active keys, powers Sample Tracking "View Mode" | Admin impersonation preview | any `samples_*` key (generic) | `getEffectivePermissionsForUser()` / `resolve_effective_permissions_for_user` (already built for the Permission Management UI) | **Direct Mapping** (once §5's action keys exist) | Medium |
| 6 | [`src/app/samples/page.tsx`](../../src/app/samples/page.tsx) `SamplesPage` (~L139–241) | Loads own + (View Mode) viewed-user's permission keys; derives `canDispatch`/`canReceive`/`canLost`/`effectiveHasAnySamplePermission` | Gates action buttons, tab visibility, and non-admin row filtering | Sample Tracking page UI | `samples_dispatch`, `samples_receive`, `samples_lost`, `samples_close` | `sample_tracking` module effective permissions (new actions) | **Transform** | Medium (UI-only gate; RLS is the real backstop) |
| 7 | [`src/app/samples/dispatch/[id]/page.tsx`](../../src/app/samples/dispatch/[id]/page.tsx) `DispatchPage` (L84–90) | Loads own permission keys; gates the whole QR-linked page | Single-sample dispatch form | `samples_dispatch` | `sample_tracking` `dispatch` action (new) | **Transform** | Medium |

No usage classified **Unknown** — every reference traces to a concrete file and purpose. (`samples_close` is *unwired*, not unknown — see §1.)

---

## 3. Migration Classification (aggregated)

- **Retire**: the `employee_permissions` table, its 4 RLS policies, and `has_permission()` itself — only after every row in §2 has cut over and a soak period has passed with no diffs between legacy and centralized decisions.
- **Transform**: everything that currently calls `has_permission()` or reads `employee_permissions` directly (rows 2, 3, 4, 6, 7). None of these can be a same-shape swap — they all depend on §5's new action keys existing first.
- **Direct Mapping**: row 5 (`/api/admin/user-permissions`) — the centralized bulk resolver already returns an equivalent (and richer) shape; it can be swapped in mechanically once the module has the right actions.
- **Unknown**: none.

---

## 4. Risk Assessment

| Risk | Where | Why |
|---|---|---|
| **High** | RLS policies on `sample_dispatches` (rows 2–4) | These are the actual authorization boundary for a real workflow (courier dispatch, receipt confirmation, loss reporting). A mistranslated policy either locks out legitimate staff or — worse — grants an UPDATE window it shouldn't. Any change here needs a side-by-side (legacy vs. `resolve_permission`) verification pass before the old policy is dropped, not just a code read. |
| **Medium** | `/api/admin/user-permissions` (row 5) | Wrong swap could return the wrong user's effective permissions to the admin "View Mode" preview. Contained blast radius (read-only, admin-gated, preview-only — it does not itself authorize writes), but still needs care since it shapes what an admin believes a user can do. |
| **Medium** | UI gating in both samples pages (rows 6, 7) | These only control what buttons render / whether a page shows "Not authorized." Because the RLS policies (rows 2–4) are the real enforcement layer, a bug here is a UX defect (wrong button visible/hidden), not a security hole — but it must stay in sync with whatever the RLS layer decides, or users will see actions that then fail server-side. |
| **Low** | `employee_permissions` table/schema retirement (row 1) | Purely structural once nothing reads or writes it. Reversible right up until the `DROP`, which should happen last and separately. |

No genuine migration blocker requiring a change to the centralized engine's core resolver logic was found. The one gap — missing action keys for `sample_tracking` — is additive schema work, not a redesign.

---

## 5. Dependency Graph

```
employee_permissions (table)
   │
   ├─ ep_select_own / ep_insert_admin / ep_update_admin / ep_delete_admin  (RLS on itself)
   │
   ├─ has_permission(uid, pkey)  [SECURITY DEFINER SQL fn]
   │     │
   │     ├─ sample_dispatches_select        (RLS policy)
   │     ├─ sd_update_perm_dispatch         (RLS policy)
   │     ├─ sd_update_perm_receive          (RLS policy)
   │     └─ sd_update_perm_lost             (RLS policy)
   │
   ├─ direct SELECT via supabase-js client
   │     ├─ src/app/samples/page.tsx                    (own permissions, on load)
   │     └─ src/app/samples/dispatch/[id]/page.tsx       (own permissions, gates page)
   │
   └─ direct SELECT via service-role client
         └─ src/app/api/admin/user-permissions/route.ts  (GET, any user_id, admin-only)
               │
               └─ consumed by src/app/samples/page.tsx    (View Mode fetch, viewAsUserId branch)
```

No inbound edges from Task Management, Attendance, Payroll, Finance, Assets & Access, Employee Records, Performance, or Showroom QR. No edges from the centralized engine *into* the legacy table (the `20260660` migration comment explicitly disclaims touching it) — the only relationship is the naming collision noted in §1.

**Grant path**: no code writes to `employee_permissions`. `ep_insert_admin`/`ep_update_admin` permit it via RLS, but the only actor is presumably direct DB access (Supabase Studio / SQL) — there is no admin screen in the app for assigning `samples_*` keys today. Confirm this with the user/DB before Phase 3B; if true, the data migration in Phase 3C is a one-time backfill, not an ongoing dual-write concern for a UI.

---

## 6. Recommended Migration Phases (3B onward)

Revised 2026-07-04 after Phase 3B review to give each phase a single
responsibility and a single rollback boundary. Each phase is additive/read-only
until 3F, so no phase before it changes runtime behavior.

**Phase 3B — Register the missing actions (schema only) — ✅ COMPLETE**
Added custom `permission_actions` (`dispatch`, `receive`, `mark_lost`,
`close`) and linked them into `module_permission_actions` for
`sample_tracking` via `src/lib/permissions/modules.ts` +
`npm run permissions:sync`. Deliberately did **not** add `role_permissions`
rows — that's now explicit as Phase 3D below, not bundled into 3B.

**Phase 3C — Legacy Data Backfill Planning (no writes) — ✅ COMPLETE**
Full results in
[`PERMISSIONS_MIGRATION_PHASE3C.md`](PERMISSIONS_MIGRATION_PHASE3C.md) and
the dry-run/validation/backfill SQL in
[`permissions-3f-backfill-DRAFT.sql`](permissions-3f-backfill-DRAFT.sql).
Summary: live data turned out to be 3 rows, all for one user, all active,
all mapping cleanly (0 rejected, 0 skipped, 0 orphans). Mapping
(`samples_dispatch → dispatch`, `samples_receive → receive`, `samples_lost
→ mark_lost`; `samples_close` has no legacy grants to migrate since it was
never wired). Zero writes — verified by re-counting all three affected
tables before/after every query.

**Phase 3D — Default Permission Population — ✅ COMPLETE**
Migration
[`20260663_admin_defaults_sample_tracking_new_actions.sql`](../../supabase/migrations/20260663_admin_defaults_sample_tracking_new_actions.sql)
inserted `role_permissions` rows for the 4 new actions, `role = 'admin'`
only (`allowed = true`), mirroring the original `20260660` seed pattern.
Verified by ID-level diff (not just counts, since this is a live/shared
DB): all 54 pre-existing `role_permissions` rows unchanged, exactly 4 new
rows added, zero duplicate `(role, module_id, action_id)` combos.
Confirmed no default rows exist for `manager`/`member` — matches legacy
behavior, where non-admins only ever got access via an explicit
`employee_permissions` row (Phase 3C's backfill target, not a role
default). Resolver output validated directly:
`resolve_effective_permissions(admin_user, 'sample_tracking')` now
returns `allowed: true, source: 'role'` for all 11 actions including the
4 new ones; the same call for the one legacy grant-holder (`member` role)
still returns `allowed: false, source: 'system_default'` across the
board — confirming zero enforcement impact, since nothing in any live RLS
policy or route calls this resolver for `sample_tracking` yet.

**Phase 3E — Shadow Verification — ✅ COMPLETE**
Full results in
[`PERMISSIONS_MIGRATION_PHASE3E.md`](PERMISSIONS_MIGRATION_PHASE3E.md),
SQL in [`permissions-3e-shadow-verification.sql`](permissions-3e-shadow-verification.sql).
Tested **all 13 users × all 4 actions (52 checks, exhaustive not sampled)**,
comparing the real `has_permission()`/`resolve_permission()` functions —
specifically the *effective* legacy decision (`role='admin' OR
has_permission(...)`, matching what the live RLS policies actually
evaluate) against the centralized resolver. Result: **49/52 match, 3/52
mismatch** — all 3 are Aditya's still-unmigrated legacy grants
(dispatch/receive/mark_lost), exactly the 3 rows Phase 3C already
identified and prepared a (not-yet-run) backfill for. No unexplained
mismatches, full admin parity, no manager-role surprises. Zero writes —
verified by re-counting all 4 affected tables before/after.

**Phase 3F — Behavioral Cutover (the one behavior-changing phase)**
Once 3E shows zero divergence and all exit criteria below are met, ship RLS
and application code together, in the same release — deliberately **not**
split into separate reviews/deploys, because reviewing or deploying them
separately would leave the system in an inconsistent state (RLS enforcing
the new engine while the UI still reads the old table, or vice versa). One
approval point, one rollback boundary:
  1. **RLS**: replace `has_permission(...)` calls in
     `sample_dispatches_select`, `sd_update_perm_dispatch`,
     `sd_update_perm_receive`, `sd_update_perm_lost` with
     `resolve_permission(auth.uid(), 'sample_tracking', '<action>')`. Keep
     the old policies `DROP`-able (don't delete migration history) for
     rollback.
  2. **App code**: swap `src/app/samples/page.tsx` and
     `src/app/samples/dispatch/[id]/page.tsx` from direct
     `employee_permissions` reads to `getEffectivePermissions`/
     `getEffectivePermissionsForUser`; swap `/api/admin/user-permissions`
     to call `getEffectivePermissionsForUser` (or retire it in favor of
     the existing `/api/control-center/permissions/employees/[id]` route).

**Exit criteria — must all be true before 3F starts:**
```
✅ Registry complete                                          (3B)
✅ Catalog synchronized                                        (3B)
✅ Legacy permission mappings finalized                        (3C)
✅ Centralized default role permissions populated              (3D)
✅ Backfill SQL validated                                      (3C)
✅ Shadow verification shows no UNEXPLAINED mismatches         (3E — 3/52
   mismatches found, all explained: Aditya's 3 rows pending backfill)
✅ Backfill executed and re-verified with ZERO mismatches      (2026-07-04,
   as its own standalone pre-cutover step, NOT part of 3F — migration
   20260664, then permissions-3e-shadow-verification.sql re-run unchanged:
   52/52 match. Full detail in PERMISSIONS_MIGRATION_PHASE3E.md
   "Post-backfill re-verification")
☐ Rollback procedure documented                                (still open
   — belongs to 3F planning, not a data-validation gate)
```
Every data-validation gate is now closed. The one remaining item
(rollback procedure) is part of planning the actual behavioral cutover,
not something 3A–3E's analysis/data work can close on its own.

**State immediately after 3F completes:**
- The centralized resolver (`resolve_permission`) is the single
  authorization source for Sample Tracking's dispatch/receive/lost/close
  actions.
- Legacy `employee_permissions` **remains present in the schema but is no
  longer consulted** by any RLS policy or application code path.
- Production monitoring runs for a stable observation period, confirming
  expected behavior, before any cleanup (3G) begins.

**Phase 3G — Legacy Retirement**
Only after a stable production observation period following 3F, remove:
- the `employee_permissions` table (once confirmed no longer needed)
- the legacy helper function `has_permission()`
- the legacy API endpoint (`/api/admin/user-permissions`, if not already
  retired in 3F step 2)
- the obsolete `ep_*` RLS policies
- any other dead code tied to the old permission model

This keeps rollback straightforward: until 3G actually runs, the legacy
implementation still exists in full if an issue is discovered after 3F ships.

---

### Roadmap summary

- **3A** — Discovery
- **3B** — Capability expansion ✅ COMPLETE
- **3C** — Backfill planning (no writes)
- **3D** — Default permission population (no enforcement)
- **3E** — Shadow verification (zero behavior change)
- **3F** — Single behavioral cutover (RLS + app code together)
- **3G** — Legacy retirement (after stable production observation)

This ordering keeps every phase before 3F behavior-neutral, isolates the one
genuinely risky step (the single behavioral cutover) behind an explicit exit
gate, and leaves the legacy table itself as the very last thing removed —
kept alive but unconsulted for one full observation window as a safety net.

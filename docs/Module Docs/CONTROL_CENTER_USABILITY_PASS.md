# Control Center Usability Pass — Closeout

Status: **Complete. UI/UX only. Phase 3G not started.**

This is a UI-only usability pass over the admin Control Center (Departments,
People, Access Control) and is separate from the permission-engine migration
tracked in `PERMISSIONS_MIGRATION_PHASE3A` through `PHASE3F_OBSERVATION`. It
does not advance that migration and should not be read as "Phase 3G" —
Phase 3G (legacy retirement) remains explicitly not started, per the gate
at the end of `PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md`.

## 1. What was completed

| Item | Commit(s) |
|---|---|
| Control Center shell/navigation redesign (Overview, Departments, People, Access Control, Module Visibility tabs; Change History shown as disabled "coming soon") | `6e1264c` |
| Access-level presets for Access Control (No Access / Viewer / Editor / Manager / Admin / Custom over the existing granular engine) | `dced692` |
| Access source clarity inside the Change Access modal (current level + source: employee override / department / role / system default, or "mixed") | `46e12ab` |
| Departments V2 — clean list, header, empty state, and a safe Delete flow (blocks deletion when people are still assigned, both client-side and via a new server-side check) | `4a4afd3` |
| People V2 — search/filter (name, email, department, role, status) over already-loaded data, added Email/Joined columns | `bf2f32b` |
| Access Control UI polish — non-alarming Enforced/Prepared explanation, scannable current-access card in the modal | `693bc25` |
| Final smoke review across all five tabs/routes | Clean — see §5 |
| Module Visibility "not working" report | Investigated; no source defect found; user confirmed working again (see §5) |

Files touched across this pass: `src/components/layout/ControlCenterLayout.tsx`,
`src/app/admin/control-center/page.tsx`,
`src/app/admin/control-center/permissions/page.tsx`, and one new API method —
`DELETE` on `src/app/api/control-center/departments/[key]/route.ts` (see §2).

## 2. Behavior preserved

- All existing API routes and their request/response shapes are unchanged:
  `/api/control-center/departments`, `/api/control-center/departments/[key]`
  (PATCH), `/api/control-center/modules`, `/api/control-center/modules/[key]`,
  `/api/control-center/permissions/employees/[id]` (GET/PUT),
  `/api/control-center/permissions/modules`, `/api/admin-members`,
  `/api/update-member`.
- One addition, not a change: a `DELETE` handler was added to
  `departments/[key]/route.ts` because no delete capability existed at all
  before this pass and the UI now requires one. It needed no RLS or schema
  change — `departments_admin_delete` RLS already permitted admin deletes
  from the original migration; the new code is purely an app-level guard
  (people-assigned check) before it deletes.
- Permission resolver behavior (`resolve_permission()`), RLS policies, and
  schema are untouched.
- Legacy permission code — `employee_permissions` table, `has_permission()`,
  and the `ep_*` policies — is untouched and still present, unused, for
  rollback only (as it was before this pass).
- Admin-only gating and View-As blocking on every Control Center page are
  unchanged.

## 3. Current permission status

- The Control Center permission matrix (modules × actions × override) exists
  and is fully editable from Access Control.
- Employee permission overrides can be saved from the UI and persist to
  `employee_permission_overrides`.
- **Only Sample Tracking currently enforces centralized permissions**,
  through `resolve_permission()` (RLS + app code), per the Phase 3F cutover.
- Every other registered module (Task Management, Assets & Access,
  Attendance, Payroll, Showroom QR, Employee Records, Performance, Finance)
  is **Prepared, not enforced** — its access levels save correctly but do
  not yet gate real access. This distinction is visible in the UI in three
  places: the page-level explanation, the Active/Prepared badge on each
  module row, and the status banner inside the Change Access modal.

## 4. What was intentionally not done

- Phase 3G (dropping `employee_permissions`, `has_permission()`, `ep_*`
  policies) — not started.
- No further Sample Tracking product work.
- `employee_permissions` — not removed or modified.
- `has_permission()` — not removed or modified.
- No legacy permission APIs or RLS policies removed.
- No new permission levels, no new modules, no Departments/People redesign
  beyond this pass, no bulk reassignment workflow, no employee-records/HR
  fields added.

## 5. Verification

- `npx tsc --noEmit`, `npx eslint` (scoped to changed files), and
  `npm run build` all passed clean at every step of this pass.
- A full smoke review was run across Overview, Departments, People, Access
  Control, and Module Visibility, plus a safety check confirming no
  schema/RLS/resolver/Sample Tracking files were touched — clean.
- Module Visibility was reported not working once; a focused re-read of
  `ControlCenterLayout.tsx`, `page.tsx`, and both `modules` API routes plus
  a codebase-wide search for a mismatched tab key found no defect. The user
  confirmed it is working again, consistent with a transient client-side
  issue rather than a regression.

## 6. Recommended next decision

Pick one before further permission work begins:

- **(a) Pause permission migration here** and move engineering attention to
  another priority (e.g. Sample Tracking lifecycle completion, Attendance,
  or Payroll, per the roadmap in `docs/BOE Master Context/04_Current_Roadmap.md`),
  leaving the remaining modules in their current Prepared state indefinitely
  until there's a concrete need to enforce one of them; or
- **(b) Plan Phase 3G separately**, only after explicit approval and only as
  its own scoped effort — following the same pattern as Phase 3F (RLS diff,
  live verification, an observation period before considering the legacy
  path retired). Phase 3G should not be started as a side effect of this or
  any other task without that explicit approval.

This document does not make that call — it exists to hand off a clean
decision point.

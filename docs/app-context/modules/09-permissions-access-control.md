# 09 - Permissions & access control

Verified against checkout `852e0493`. Memory notes were checked against code and migrations; unverifiable claims are
labelled "(unverified, from memory)".

## 1. Purpose & users

The permission engine decides who may enter each module and which actions inside it they may take, and the Control Center
screens administrators use to grant/revoke. Authority comes from a decision about a person, never from a job title.

| Who | Interaction |
|---|---|
| Admin (`users.role='admin'`) | the only role that may change permissions (Control Center is admin-only); admin authority is the ROLE and short-circuits guards |
| Manager / Member | hold exactly what an admin granted them (per-employee overrides, optionally a team rule); the role name grants nothing |
| Developers | register modules/actions in `src/lib/permissions/modules.ts` and run `npm run permissions:check` |

## 2. Status at commit 852e0493

- Shipped and live: engine tables + resolvers, Control Center "By Employee" and "By Module" (+ team access cards),
  access levels with protected actions, parent `view` gates in the frontend (`ModuleGuard`) and in the database
  (`module_entry_open()` RESTRICTIVE policies), enforcement for Finance/Orders/Meetings/Assets/Performance/Customer
  Review/Image Editor/Exhibition Leads/Inventory/Sample Tracking (partial for several; see `MODULE_ENFORCEMENT`).
- Phase history (all migration files present): Phase 1 `20260660` engine; Phase 2 UI + `20260661` bulk resolver +
  `20260662` team-cast fix; 3B-3D `20260663`; backfill `20260664`; **3F `20260665` Sample Tracking RLS cutover to
  `resolve_permission()`**; later `20260901`..`20260905` Finance/Orders/protected-visibility/parent gates.
- **Phase 3G (retire legacy `employee_permissions`, `has_permission()`, `ep_*` policies) is NOT done**: no migration drops
  them; `20260634_create_employee_permissions.sql` still defines the table, and nothing in `src/` reads it (only comments
  in `modules.ts`). `docs/Module Docs/PERMISSIONS_MIGRATION_PHASE3F_OBSERVATION.md` still shows its observation checklist
  unchecked ("Phase 3G not started"). Phase 4 (Permission Profiles) is not started: the resolver source type
  `'permission_profile'` does not exist (`PermissionLevel` = system_default | role | department | employee_override).
- `npm run permissions:check` drift fixed by `20261111000000_permission_module_labels_follow_the_registry.sql` (two targeted
  UPDATEs, not `permissions:sync`). Whether the live DB currently reports 0 mismatches cannot be verified from the checkout.

## 3. Pages and API routes

Pages (admin only, shell in `src/app/admin/control-center/layout.tsx`):
- `/admin/control-center/permissions` - By Employee (module table, level selector, sticky save bar, `?employee=` deep link).
- `/admin/control-center/permissions/modules` - By Module (one module across everyone, `?module=`; `TeamAccessCard` on top).
- Legacy `?tab=modules` of the main page still resolves (rollback); `app_modules` visibility editor lives there.

API routes (all re-verify the caller as an ACTIVE, non-deleted admin from the bearer token):
| Route | Methods | Purpose |
|---|---|---|
| `/api/control-center/permissions/employees/[id]` | GET, PUT | one employee's full permission tree (server-computed `sourceLabel` per action); PUT writes only the diffed override rows |
| `/api/control-center/permissions/modules` | GET | module list for By Module |
| `/api/control-center/permissions/modules/[key]/employees` | GET | read-only matrix (bulk resolver per user, batches of 8) |
| `/api/control-center/permissions/modules/[key]/departments` | GET, PUT | team rule: allow/block/inherit per department for the module's ENTRY action (`parseTeamChanges`, max 100 changes) |
| `/api/control-center/modules`, `/modules/[key]` | GET, PATCH | legacy `app_modules` visibility (live/admin_only/department_only/custom/hidden + `allowed_user_ids`) |
| `/api/admin/user-permissions` | GET | View As support (legacy Sample Tracking path; reads centralized resolver) |
| `/api/view-as/subject` | GET | resolves a previewed employee's permissions server-side (module 08) |

## 4. Database

Tables (all from `20260660_create_permission_engine.sql` unless noted): `permission_modules` (module_key unique,
`is_active`), `permission_actions` (action_key unique, **display_name is GLOBAL per action key**, `is_system`),
`module_permission_actions` (module x action, `default_allowed`), `role_permissions` (role, module, action, allowed),
`department_permissions` (department_id, module, action, allowed), `employee_permission_overrides` (user, module, action,
allowed, `granted_by/at`, `revoked_by/at`; unique `(user_id, module_id, action_id)`). Related: `app_modules`
(`20260645`; `allowed_user_ids uuid[]` + two CHECKs from `20260822000000`; `allowed_department` text[] since
`20260668`), `departments` (`department_key` unique, FK NOT enforced against `users.team`), legacy `employee_permissions`
(`20260634`, dead). `users.team` is **text** (`20260666`, validated against `departments` by trigger
`validate_user_team_department`), `tasks.team` is text (`20260667`).

Resolvers (SECURITY DEFINER, `search_path = public, pg_temp` pinned by `20270213000000`):
- `resolve_effective_permissions(user, module)` and `resolve_effective_permissions_for_user(user)` (bulk, `20260661`;
  **duplicates the precedence logic on purpose - change both together**). `20260662` fixed `users.team::text` cast.
- `resolve_permission(user, module, action) -> boolean`; `has_permission(uuid,text)` (legacy); `module_entry_open(module)`
  (admin OR effective `view`; `20260905`); `sample_tracking_module_open()` (`20260904`);
  `actor_has_permission(text,text)` / `actor_has_module_permission(text,text)` (`20260901`: require an ACTIVE non-deleted user,
  admin short-circuit included).
- **Precedence: Employee Override > Department > Role > System Default.** Implemented as
  `COALESCE(eo.allowed, dp.allowed, rp.allowed, mpa.default_allowed, false)`; overrides count only while `revoked_at IS NULL`.
  `default_allowed` is false everywhere. An inactive/unregistered module returns NO rows, so everyone (admins included) resolves false.
- `20270214000000` revoked EXECUTE on six resolver functions (`has_permission`, `module_entry_open`, both `resolve_effective_*`,
  `resolve_permission`, `sample_tracking_module_open`) from `anon`/PUBLIC; `authenticated` and `service_role` keep it.
- RLS idea: ownership/assignment rules stay as permissive policies; `20260905000000` adds `<table>_module_entry_gate`
  RESTRICTIVE `FOR ALL TO authenticated` policies on 27 tables (task_management: `tasks`, `task_attachments`,
  `task_activity_log`, `user_top_tasks`; assets_access 8 tables; meetings 6; orders 6; finance 3), AND-ed with the permissive
  set. Deliberately NOT gated (asserted by the migration): `users`, `positions`, the four `showroom_*` tables,
  `performance_app_opens`, `daily_work_logs`. `view_all` is extra scope, never a substitute for `view`.
- Task RLS (production-read 2026-08-14, `docs/Module Docs/ACCESS_CONTROL_V1.md`): `tasks` SELECT =
  `auth.uid() IN (created_by, assigned_to, delegated_by)`; **no admin branch**. `task_attachments` was `USING (true)` until
  `20260903000000`.
- Immutability: applied migrations are never edited; corrections are later files (examples: `20260723000000` undoes
  `20260721000000`; `20261110000000` undoes the role seed in `20261109000000`). Apply order is load-bearing in several pairs
  (`20260901000000` must be immediately followed by `20260902000000`; a repo test asserts the two sort adjacently).

## 5. Permissions & access (how the engine is used)

Registered modules and actions (`src/lib/permissions/modules.ts`, verified):
| module_key | actions |
|---|---|
| task_management | view, create, edit, delete, export, manage, view_quotations, manage_quotations |
| sample_tracking | view, create, edit, delete, approve, export, manage, dispatch, receive, mark_lost, close |
| assets_access | view, create, edit, delete, manage, assign, manage_access_records, manage_asset_catalogue |
| attendance | view, create, edit, delete, approve, export, manage |
| payroll | view, edit, approve, export, manage, admin |
| showroom_qr | view, create, edit, manage |
| employee_records | view, create, edit, delete, export, manage, admin |
| performance | view, create, edit, export, manage, view_team, view_all |
| finance | view, create, edit, delete, approve, export, manage, view_all, allocate, allocate_correct, verify_own_payment |
| meetings | view, create, edit, delete, export, manage |
| customer_review_requests | use, verify (no `view`; key kept because grants are written against it) |
| orders | view, create, edit, delete, export, manage, approve_order, approve_advance_exception, align_production, view_pi_commission, view_all |
| image_editor | view, create (label "Use" via module-scoped map) |
| exhibition_leads | view, view_all |
| inventory | view, create, edit, delete, approve |

Module entry:
- `ENGINE_GATED_MODULE_KEYS` (`moduleVisibility.ts`): task_management, sample_tracking, assets_access, showroom_qr,
  employee_records, performance, finance, orders, meetings, image_editor, exhibition_leads, inventory (12; the file's comment
  still says "nine"). Entry = effective `view` via `canAccessManagementModule`: inactive module -> false; no role -> false; admin
  -> true; Attendance/Payroll -> false for non-admins; else `permissions.some(view && allowed)`. Customer Review's entry is
  `use` (`MODULE_ENTRY_ACTIONS = ['view','use']`, `entryActionForModule`).
- **Attendance and Payroll are `role_only`:** management surfaces are admin-only whatever any visibility mode or permission
  says (`SELF_SERVICE_MODULE_KEYS` in `src/lib/moduleAccess.ts`). `app_modules` governs only the employee's own self-service
  card (`/my-attendance`, `/my-payroll`); `custom` names who sees that card, it is NOT a back door into everyone's records.
  `resolveManagementAccess` = admin only for those two; `hidden` still closes a module for everyone.
- `resolveModuleAccess(moduleKey,row,profile,fallback)` and 4-arg `canAccessModule(...)` (kept for Showroom; `custom` and
  unknown modes fail closed to admin-only). `fallback` applies only when there is no `app_modules` row.

Levels (`levels.ts`): `no_access | viewer | contributor | manager | custom`. Viewer = view; Contributor = view+create+edit;
Manager = + approve/export where registered; Custom = ticked actions. **PROTECTED_ACTIONS (never granted by a preset, Custom
only):** delete, admin, manage, assign, dispatch, receive, mark_lost, close, view_quotations, manage_quotations, view_all,
approve_order, approve_advance_exception, allocate, allocate_correct, verify_own_payment, align_production, view_pi_commission,
verify, manage_access_records, manage_asset_catalogue, view_team. (ACCESS_CONTROL_V1.md lists a shorter set incl.
`can_be_order_assignee` - stale; that action no longer exists. The code constant is the truth.)
`ACTION_DEPENDENCIES` (child -> parent): manage_quotations->view_quotations->view; verify_own_payment->approve; view_all->view_team->view
(where registered); approve_order/approve_advance_exception/align_production/view_pi_commission->view; verify->use;
manage_access_records/manage_asset_catalogue->view. Turning a parent off turns dependents off (`dependentActionsToRemove`).

Who can do what in practice: admins write overrides; the PUT route refuses (409) removal of `orders.approve_order` from the seeded
owner account (identified by `employee_code`; DB trigger in `20261224000000` also refuses because the route uses the service role).
An Administrator row in the By-Employee screen is read-only. Inactive/deleted users are denied by `actor_has_*`.

`MODULE_ENFORCEMENT` (`enforcement.ts`; the one place that says what is actually enforced; badges Active/Partly active/Prepared/Not used):
enforced: assets_access, meetings, customer_review_requests, image_editor, exhibition_leads, inventory. partial: sample_tracking
(view, dispatch, receive, mark_lost, close), orders (view, view_all, approve_order, manage, delete), finance (view, approve, manage,
delete, view_all), task_management (view, view_quotations, manage_quotations), showroom_qr (view), employee_records (view),
performance (view, view_team, view_all). role_only: attendance, payroll. Anything else defaults to `prepared`.

## 6. Business rules

- **Default-deny / grants-not-inheritance (standing rule).** `role_permissions` holds ONLY `admin` rows (spot-checked: the `INSERT INTO role_permissions` statements in
  `20261017`, `20261020`, `20261028`, `20270220`, `20270305`, `20270309`, `20270313` use `'admin'`; the exception is `20261109000000`, which
  seeded `manager` view_team/view_all and was reversed by `20261110000000`'s DELETE. Re-run the query in section 12 to confirm live state). A new employee has no optional module. To preserve a role check when migrating it into the
  engine, grant `employee_permission_overrides` rows to the named people (by `users.id`, with an email/active cross-check that raises on
  mismatch; `INSERT ... SELECT FROM users WHERE id=...`; keep `granted_at/by` out of `ON CONFLICT DO UPDATE`). Remove a bad role seed with
  `DELETE`, never `allowed=false` (role rows have no `revoked_at`, so false = an active role-level deny).
- Meetings was the exception: `20260902000000` removed its member/manager role defaults and re-granted the eleven active real employees by uuid.
  Test/objection ("(DUMMY)") accounts hold nothing by default.
- **Team (department) rules are a deliberate mechanism**, not role inheritance: `department_permissions` for a module's entry action only,
  written from By Module > Team access (allow / not set / block); individual overrides win; first use: Sales gets `exhibition_leads.view`
  (`20270305000000`).
- Override write semantics: `allowed:true/false` upserts and clears `revoked_*`; `null` soft-revokes (sets `revoked_by/at`) - rows are never
  deleted; unchanged tree = no write ("delta only").
- Enabling Module access ON must not erase Custom permissions (`enableModuleEntry()` flips only `view`); picking a level explicitly still
  applies the whole preset and revokes.
- Performance split (`20261109000000`): `view` = Personal Performance + module entry, `view_team` = Team Performance, `view_all` = all
  employees instead of own department; chain view_all -> view_team -> view. Control Center shows module-scoped labels
  (`MODULE_SCOPED_ACTION_LABELS` in the employees route and `MODULE_SCOPED_ACTION_WORDS` in `accessControlChanges.ts`) because the global
  `view_all` display name is shared by Orders/Finance.
- Task Management entry needs `task_management:view` for every non-admin (RLS gate on the four task tables): an employee with no such
  override cannot read their own tasks.
- Sample Tracking: the one legacy grant-holder's per-person grants (dispatch/receive/mark_lost) were backfilled into overrides (`20260664`); `close` was never
  wired in legacy.

## 7. Key components & lib files

`src/lib/permissions/`: `registry.ts`, `modules.ts`, `resolver.ts`, `constants.ts` (system actions: view, create, edit, delete, approve, export,
manage, admin), `types.ts`, `levels.ts`, `enforcement.ts`, `moduleVisibility.ts`, `departmentAccess.ts`, `accessControlChanges.ts`,
per-module derivers (`orders.ts`, `orderApproval.ts`, `finance.ts`, `meetings.ts`, `performance.ts`, `assetsAccess.ts`, `imageEditor.ts`,
`customerReviewOutreach.ts`, `quotations.ts`), `src/lib/moduleAccess.ts`, `src/lib/security/attendancePayrollApiAuth.ts`
(`requireModuleAccess`, `requireSelfOrModuleAccess`), `scripts/sync-permissions.ts`, `src/components/layout/ModuleGuard.tsx`,
`src/hooks/queries/usePermissionContext.ts`, `src/app/admin/control-center/permissions/{page.tsx,modules/page.tsx,permissions.module.css}`,
`src/components/controlCenter/TeamAccessCard.tsx`, `src/app/admin/control-center/ModuleMemberPicker.tsx`.

`npm run permissions:sync` upserts the in-code registry into `permission_modules/_actions/module_permission_actions` (idempotent; it
re-upserts `display_name` globally per action key). `npm run permissions:check` is read-only: exit 1 if a registered module/action is missing
from the DB, a module's display_name/description differs, or the DB has a module not in code. It needs `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` (loads `.env.local` then `.env`).

## 8. Decisions made & why

- Engine is incremental, one module at a time; each step independently reviewable/rollbackable. Do NOT split a module's RLS+app cutover (they
  must enforce the same source at once) and do NOT bundle phases.
- Restrictive policies instead of rewriting ~90 policies (rewrites risk altering a rule).
- Module list is derived from the single `resolveModuleAccess` family; `app_modules` kept only where still needed (Showroom dept rule,
  Attendance/Payroll self-service cards).
- Attendance/Payroll management is admin-only forever by product decision; a `custom` grant gives the employee their OWN record, never others.
- The `employee_permissions` legacy table is kept for rollback until 3G is explicitly authorised (applying 20260666 early while 3F observation
  was open was an explicit, twice-confirmed owner override, not a precedent) (from memory).
- Grants are per person (see section 6); a manager who needs Team Performance is granted it.

## 9. Known traps / gotchas / unfixed defects

1. A new module/action also needs `role_permissions` admin rows (migration), otherwise the admin loses it on the resolver path (the
   `module_entry_open` admin branch only rescues entry). Register the action in `modules.ts` AND write a migration; `permissions:sync`
   alone does not seed role rows.
2. `permission_actions.display_name` is global: a module-specific label registered in `modules.ts` renames it everywhere on the next sync. Use the
   module-scoped label maps.
3. Adding an action breaks pinned tests beyond migration ledgers: `levels.test.ts` (exact PROTECTED_ACTIONS set), `protectedVisibility.test.ts`
   (exact dependency chains), `enforcement.test.ts` ("modules newly gated"), `registry.test.ts`, `migrationContract/Signatures/Audit` tests; check
   which ledger a test really asserts before appending a filename (a card-inserter ledger in `customerReviews/fixture.test.ts` is NOT the migration ledger).
4. `migrationSignatures`/`migrationContract` tests and ~9+ others hard-code migration filenames; PR #327 let named-successor suites tolerate new files at
   the end, but a migration inserted before the tail still breaks them.
5. Inert grants become live when a later migration wires the action (the 2026-07-16 Assets incident, undone by `20260723000000`). The Access screen
   labels enforcement honestly via `MODULE_ENFORCEMENT`; update it in the same change that enforces an action.
6. A role-based remnant exists outside the engine: `/manager`, `/tasks/all`, `/api/task-detail` (admin|manager by role), `/api/create-employee`
   (admin|manager), `/super-admin`.
7. The route holding the service role bypasses RLS: protections for service-role paths must be triggers (the GUC idiom `boe.*_context`), not policies.
8. Enum/`ALTER COLUMN TYPE` on a column used by RLS fails with 0A000 (`users.team` incident: 4 `orders`/`order_activity_log` policies referencing it had
   to be dropped and recreated in `20260666`); check `pg_depend` first.
9. `ENGINE_GATED_MODULE_KEYS` comment says "nine", list has 12. `ACCESS_CONTROL_V1.md` protected list is out of date vs code. Memory's
   `EXPLICIT_GRANT_MODULE_KEYS` no longer exists: code now has `SELF_SERVICE_MODULE_KEYS` with different semantics (management is admin-only
   regardless of grants) - the memory note describes the superseded 2026-08-08 design.
10. Counting rows in `employee_permission_overrides` is not evidence on a shared live DB (UI testing changes it concurrently); verify by exact-id diffs.
11. Customer Review's module key is `customer_review_requests` while tables are named for test cards; the module is unreachable until its
    migration registers the module (resolver returns no rows -> everyone denied, admins too).

## 10. Tests that guard it

`src/lib/permissions/*.test.ts` (32 files), notably `levels.test.ts`, `protectedVisibility.test.ts`, `enforcement.test.ts`, `registry.test.ts`,
`moduleParentGate.test.ts`, `moduleVisibility.test.ts`, `uiEnforcement.test.ts`, `accessControlUi.test.ts`, `accessControlChanges.test.ts`,
`compatibilityMigration.test.ts`, `moduleMatrixRoute.test.ts`, `departmentAccess.test.ts`, `resolversNotForAnon.test.ts`, `migration*.test.ts`,
`src/lib/moduleAccess.test.ts`, `src/lib/security/attendancePayrollApiIsolation.test.ts`, `src/lib/securityDefinerSearchPath.test.ts`,
`src/lib/users/designationLevels.test.ts` (designation_level may not appear in permissions/moduleAccess/security/ModuleGuard/usePermissionContext).
Run: `npx tsx --test src/lib/permissions/levels.test.ts` (one file) or `npm test`. Live-DB suites skip without a database; never run two at once.

## 11. Open items / next planned work

- Phase 3G (retire `employee_permissions`/`has_permission`/`ep_*`) and the observation checklist; Phase 4 Permission Profiles; integrate `hasPermission()`
  into remaining role-based screens, starting with low-risk admin modules (from memory roadmap).
- Partial modules: wire the remaining stored-but-unused actions (task_management create/edit/delete, showroom_qr create/edit/manage,
  employee_records beyond view, performance create/edit/export/manage).
- Decide product treatment for the three ungated modules (employee_records, showroom_qr, performance) - recorded in `20260905000000` as needing a
  product decision.
- Confirm with a real non-admin login (View As cannot lend permissions).

## 12. Recheck before changing this module

Read: `src/lib/permissions/{modules,levels,enforcement,moduleVisibility}.ts`, `src/lib/moduleAccess.ts`,
`supabase/migrations/20260660_create_permission_engine.sql`, `20260661`, `20260662`, `20260905000000_module_view_parent_gates.sql`,
`20270213000000`, `20270214000000`, the control-center employees route, `docs/Module Docs/ACCESS_CONTROL_V1.md`.
Read-only queries (linked project): `select role,count(*) from role_permissions group by 1;` (expect only admin);
`select count(*) from employee_permission_overrides where revoked_at is null;`; `select * from pg_policies where policyname like '%_module_entry_gate';` (27);
`select module_key,is_active from permission_modules;`. Run `npm run permissions:check`, then
`npx tsx --test src/lib/permissions/*.test.ts`, and `npx tsc --noEmit`.

# 10 - Members, org hierarchy, positions & Admin Control Center

Verified against checkout `852e0493`. Unverifiable claims are labelled "(unverified, from memory)".

## 1. Purpose & users

Control Center is the administrator's own workspace: employee accounts, departments, designations, access (module 09),
Order setup (numbering, notifications, operations handoff, visibility), announcements, and the destructive "Records & Data"
tools. Admin only. The launcher card "Employee Records" (`employee_records` module) lands on the same People screen.

| Who | Can |
|---|---|
| Admin (`users.role='admin'`, active, not deleted) | everything below |
| Manager / member | nothing here (layout redirects to `/dashboard`; every API re-verifies admin). Exceptions: managers can still call `/api/create-employee` (attendance-only employees) |
| Any employee | reads their own announcements (`/announcements`) and sees the banner on `/modules` |

## 2. Status at commit 852e0493

Shipped. Control Center is "complete" (closed by the owner 2026-09-03; reopened only for defects/business needs). Latest change:
**15 Nov 2026 redesign, step 1 (PR pending): navigation and layout rebuilt, screens' contents untouched.** Nine hubs and the section tabs became Home + six areas (People, Access, Orders, Sales, Staff experience, Data & Safety) holding 19 settings; Home is a searchable directory of every setting; the page header has a breadcrumb and a one-line "Affects / Related" strip; the sidebar opens the pages of the area you are in; the Action Queue left the Control Center (owner: pending work shows on the dashboard of the module that owns it). Earlier: #307 (2026-10-13) six navigation hubs, section tabs, Find anything, useful Home. Not shipped / pending: members area still has two
legacy surfaces (`/settings/*`), no Phase for delegated people-administration.

## 3. Pages and API routes

Pages (`src/app/admin/control-center/**`, all under one layout that is the admin gate):
- `/admin/control-center` (Home; `?tab=overview` is Home too; `?tab=modules` -> By Module (the hidden Module Visibility screen, kept for rollback);
  `?tab=people` -> `/people`). The six screens that used to be other `?tab=` values have their own routes since step 2 (2026-11-15):
  `/departments`, `/order-numbering`, `/order-notifications`, `/operations-handoff`, `/order-visibility`, `/sales-team`; the old addresses redirect
  (`next.config.ts`, temporary, from `LEGACY_TAB_REDIRECTS` in `navModel.ts`).
- `/admin/control-center/people` (Employees: list + one dialog per person: Employment / Account / Access / Danger zone) - `MembersWorkspace.tsx`
- `/admin/control-center/positions` (Designations editor, shared `PositionsManager`)
- `/admin/control-center/permissions`, `/permissions/modules` (module 09)
- `/admin/control-center/action-queue` REMOVED (15 Nov 2026): page, loader `actionQueue.ts` and hook `useActionQueue` are deleted; the address is outside the map (`activeHub()` returns null). Its kinds live on the Finance and Orders dashboards.
- `/admin/control-center/announcements` (+ `AnnouncementForm.tsx`)
- `/admin/control-center/day-close` (Day Close & Scoreboard > Go live: the team switch, starts paused, `DayCloseLiveSetting.tsx`; reads and writes through `/api/day-close/members`, write = action `set_live`, administrators only; columns `day_close_settings.team_live` / `live_since`, migration `20270704000000`; module 30 section 9)
- `/admin/control-center/review-rankings` (Reviews > Rankings: one on/off switch for the review leaderboard, `ReviewRankingsSetting.tsx`; writes through `set_review_rankings_visible`, admin only; table `review_display_settings`, migration `20270702000000`; module 14 section 4a)
- `/admin/control-center/for-you` (`ForYouSettings.tsx`): each item of the Modules For you column set Off, Optional or Always on, for everyone (module 08 section 6, 20270513000000). An item moves between "In the column" and "Ready to add" as it is switched
- `/admin/control-center/test-data-cleanup`, `/data-management` (Records & Data hub, shown in the danger colour)
- Legacy: `/admin/members` (redirects to `/people`, keeps its layout ModuleGuard for `employee_records`), `/settings`, `/settings/roles`,
  `/settings/positions` (no longer in any nav, still routable), `/super-admin` (= hub item "Task Records": member-wise task report + permanent task
  deletion), `/super-admin/view-user/[userId]`.
- Employee-facing: `/announcements`, `/announcements/[id]`.

Home + six areas, nineteen settings (`src/lib/controlCenter/navModel.ts`: ONE registry read by the sidebar, the Home directory, the page header and search; a setting lives in exactly one area): **People** (Employees, Departments, Designations) - **Access** (By person, By module, Authorities) - **Orders** (Numbering, Notifications, Operations handoff, Order visibility) - **Sales** (Sales team, WhatsApp connection) - **Staff experience** (Announcements, For you column, Review leaderboard = module 14's show/hide switch, Day Close & Scoreboard = module 30's team switch) - **Data & Safety**, danger-styled (Test data cleanup, Data management, Task records). Each section carries `short` (the directory line), `affects`, `related` and `irreversible`. Search (`FindAnything.tsx`, Ctrl K or `/`) matches labels + keywords, every query word must match (`score`); empty, it offers this tab's recent screens (`recent.ts`, sessionStorage, may fail silently) and the five `COMMON_JOBS`. Every screen but Home has its own route (step 2, 2026-11-15): the six former `?tab=` screens (Departments, Order numbering / notifications / operations handoff / visibility, Sales team) are components (`DepartmentsTab`, `OrderNumberingTab`, `OrderNotificationsTab`, `OperationsHandoffTab`, `OrderVisibilityTab`, `SalesTeamTab`) rendered by thin route pages, and `page.tsx` is only Home plus the hidden Module Visibility tab. No sidebar link replaces history any more, so Back walks back through every screen and each setting has a link of its own. The main page still answers `?tab=modules` (By module) and `?tab=people` (Employees) (`activeSection`, `resolveControlCenterTab`). The sidebar menu starts PINNED open for a browser that never chose (`useSidebarPinned(true)`; a stored choice wins; no other module changes).

API routes (every one re-checks admin from the bearer token; many also require `is_active` and `is_deleted !== true`):
`/api/admin-members` GET (columns include `designation_level`, `performance_tracking_enabled`), `/api/deleted-members` GET,
`/api/create-user` POST (admin; creates auth user + `users` row; takes `role`, `team`, `position`, `designation_level`),
`/api/update-member` POST (name, email, team, role, position, designation_level; demote guarded by last-admin check),
`/api/toggle-active` POST, `/api/delete-user` POST (soft delete; member must be inactive first; sets `deletion_scheduled_at`),
`/api/restore-user` POST, `/api/permanently-delete-user` POST (member must already be soft-deleted), `/api/reset-password` POST (admin sets a
password; min 6), `/api/update-employee` PATCH (admin only: HR fields, performance participation toggle), `/api/create-employee` POST (admin or
manager; attendance-only employee with placeholder `@attendance.local` email and random password), `/api/employee-list` GET (any signed-in user; everyone gets id, full_name, team, position, is_active, employee_code, joining_date, office_timing, fingerprint_employee_code, performance_tracking_enabled; ONLY admins also get monthly_salary), `/api/control-center/departments` GET/POST + `[key]` DELETE/PATCH,
`/api/control-center/modules` + `[key]` (legacy visibility), `/api/control-center/permissions/*` (module 09), `/api/orders/test-data-cleanup` POST,
`/api/orders/test-data-reset` POST, `/api/admin-tasks` GET, `/api/admin-delete-tasks` POST (service role; deletes activity logs first, then tasks).

## 4. Database

- `users` (not created by migrations): role (`admin|manager|member`), `team` (text = `departments.department_key`, trigger `validate_user_team_department`
  from `20260666`), `position` (free-text job title), `designation_level` (nullable text, CHECK six values, `20261106000000`, NOT backfilled, informational
  only), `is_active`, `is_deleted/deleted_at/deleted_by/deletion_scheduled_at` (`20260605`), `performance_tracking_enabled`/`_note`
  (`20260719000000`), `exit_date` (`20260718000000`). **Nothing automatically purges soft-deleted users after the 30-day window**: `deletion_scheduled_at`
  is only written/read; the only scheduled jobs are the Vercel image cleanup and the DB `run_task_health_check`. Permanent delete is a manual admin action.
- `positions` (`20260530_create_positions.sql`): `name` unique, seeded with 7 names (Sales Executive, Senior Sales Executive, Team Leader, Purchase Executive,
  Designer, Production Coordinator, Accounts Executive); RLS `admins_all` + `authenticated_read`.
- `departments` (`20260645`): `department_key` unique, `department_name`, `is_active`, `sort_order`. NO FK/CHECK from `users.team`; the department DELETE route's
  app-level orphan check is what prevents orphaning people. RLS `departments_admin_delete` exists.
- `app_modules` (`20260645`; seeded 8 modules; visibility types live/admin_only/department_only/custom/hidden; `allowed_user_ids` + CHECKs `20260822000000`).
- Announcements (`20270110000000`): `announcements` (title <=120, summary <=280, body <=20000, window `starts_on..ends_on` India dates inclusive, optional PDF
  path/name/size all-or-none, `ended_at/ended_by` for early end), `announcement_recipients`, `announcement_reads`; helpers `announcement_india_date`,
  `announcement_is_live`, `announcement_caller_is_admin`, `announcement_visible_to_caller`; RPCs `create_announcement`, `update_announcement`, `end_announcement`
  (admin), `acknowledge_announcement` (self), `my_announcements()` (caller's live list with own `read_at`); private bucket `announcement-files`
  (PDF only, 10 MiB; write = admin, read = admin or current recipient). Audience = named people, never "everyone"; zero recipients is refused. Not stored in
  `public.notifications` (read state cannot be touched by notification mutations). No scheduler: "active" is computed on every read.
- Test data / reset (Orders & Finance own the mechanics; module 10 owns the screens): `test_data_cleanup_settings` (`enabled` default false;
  `permanently_disabled`; CHECK that both can never be true), `test_data_cleanup_audit`, `test_data_cleanup_claims` (`20260916000000`), reset functions
  `preview_order_finance_test_reset`, `begin_order_finance_test_reset`, `finalize_order_finance_test_reset`, `release_order_finance_test_reset`
  (`20261010000000`). The cleanup escape hatch is a GUC (`boe.cleanup_context` read by `in_test_data_cleanup()`), not an admin identity.
  `orders_prevent_delete` trigger etc. make finalized Orders/payments undeletable; later `20270317000000` added admin Confirmed-Order deletion
  (`order_deletion_log`).
- Storage buckets here: `announcement-files`.
- Migration immutability: see module 08/09 (applied files are frozen; fix forward).

## 5. Permissions & access

- Control Center: admin by ROLE only (no engine action). `ControlCenterRootLayout`: no session -> `/login`; non-admin -> `/dashboard`; admin with View As
  -> exit View As then `/dashboard`. APIs: bearer token -> admin check (with `is_active`/`is_deleted` in the newer ones). Everything in the UI gate is the
  UI half; RLS/RPC admin checks repeat.
- Members: admins only for create/update/toggle/delete/restore/purge/reset-password. The `employee_records` engine module only controls ENTRY to the
  launcher card (everything inside is admin by role).
- `team` (department), `position` (designation), `designation_level`, and `role` are four SEPARATE facts; only `role` + the engine decide access.
  `src/lib/users/designationLevels.test.ts` enforces that `designation_level` appears nowhere in `src/lib/permissions/**`, `moduleAccess.ts`,
  `src/lib/security/**`, `ModuleGuard.tsx`, `usePermissionContext.ts` or any other migration. Restricted rungs (`super_admin`, `administrator`) may only be
  set by an admin (which is already the only role that edits employees).
- Last-administrator invariant: `src/lib/users/lastAdministrator.ts` `checkLastAdministrator(client, targetUserId, action)` used by exactly the four destructive
  routes (`update-member` demote, `toggle-active` deactivate, `delete-user`, `permanently-delete-user`). No operation may leave zero ADMINS who are ACTIVE and
  NOT DELETED. Returns 500 for unreadable target/count, 404 for PGRST116, 400 for the block.

## 6. Business rules

- Soft delete: only an INACTIVE member can be soft-deleted ("Please deactivate this member before deleting"); a member must be soft-deleted before
  permanent deletion; restore requires `is_deleted`. UI promises a 30-day window via `deletion_scheduled_at` (no automated purge, see section 4).
- Last-administrator count is of ACTIVE, NOT-DELETED admins (production had 2 admin rows but 1 active at merge time, from memory). Guard owns its target
  read so a failed read cannot read as "not an admin" (fail-closed).
- Performance participation is a reporting flag, set via update-employee / People dialog ("Included in Performance"); it changes no access (module 13).
- Departments: free-text `department_key`; creating one makes it assignable to people (`ASSIGNABLE_TEAM_KEYS` guard was removed - verified absent). Deleting is
  blocked while people are assigned (route check).
- Announcements: default window = today (IST) through day 15 inclusive (`ANNOUNCEMENT_DEFAULT_DAYS = 15`); banner lists at most `ANNOUNCEMENT_BANNER_MAX_ROWS = 3`
  unread; signed PDF URL TTL 300 s; PDF max 10 MiB. A recipient sees it on Modules until "I have read this" and can reopen it from `/announcements`
  for the whole window.
- **No pending work in the Control Center (owner, 15 Nov 2026).** The Action Queue is deleted. Payment approval and needs-clarification are Finance's Pending / Needs clarification tabs; PI review, PI flagged, change requests and operations-unassigned are Orders' "Needs your decision" / "Not aligned"; money still to allocate is the alert badge on Finance's Confirmed Payments (all in the same-day pendencies change, see CHANGELOG). Home fetches nothing of its own: the directory chips (Employees, Departments, By module counts) and the "Setup checks" (an active employee with no department, an inactive department that still has people, a module set to an empty Custom audience; drawn only when something is wrong) come from the three cached lists.
- Home "Access enforcement" list (folded) is rendered from `moduleEnforcement()` (module 09), so it can never claim more than the code enforces.
- Test Data Cleanup: one verified test transaction; requires typing `DELETE TEST DATA` and a reason; route re-checks active admin; runs
  begin_test_data_cleanup -> storage removal (manifest from the claim) -> finalize in ONE request so an approved PI can never survive with its files destroyed.
  Data Management reset: scope + reason + exact phrase (e.g. `DELETE FINANCE TEST DATA`) + plan hash; freezes the module, kept claim means "ask again to finish".
- Cleanup eligibility is stamped at INSERT by `stamp_test_data_flag()` only while cleanup is enabled; the flag is immutable afterwards. Order numbers are retired,
  never recycled (cycle keeps counting), unless the admin's number choice says otherwise (`20270217000000`).

## 7. Key components & lib files

`src/components/controlCenter/{CcPrimitives.tsx (CcSection/CcToolbar/CcTable/CcBadge/ActiveBadge/CcEmpty/CcDialog/CcField), controlCenter.module.css,
FindAnything.tsx, HomeDirectory.tsx (Home), hubIcons.ts, MembersWorkspace.tsx, OrderVisibilityTab.tsx, TeamAccessCard.tsx}`, `src/components/layout/{ControlCenterLayout,ControlCenterContext,
ControlCenterSkeleton}.tsx`, `src/hooks/queries/{useControlCenterData,usePermissionContext,useAnnouncements}.ts` (`useAdminMembers`,
`useDepartments`, `useAppModules`, 30 s stale, keys include userId; `useControlCenterCache()` setters take `prev => next`), `src/lib/controlCenter/{navModel,recent}.ts`,
`src/lib/users/{lastAdministrator,designationLevels,safeColumns}.ts`, `src/components/positions/PositionsManager.tsx`, `src/lib/announcements.ts`,
`src/app/admin/control-center/ModuleMemberPicker.tsx`.

## 8. Decisions made & why

- One People screen replaced two disconnected ones (Control Center read-only table + Employee Records page); all seven member APIs unchanged.
- Hubs instead of a 14-entry flat sidebar; one registry feeds sidebar, tabs and search. **Superseded 15 Nov 2026:** six areas named by the job (not by the feature that arrived), pages shown under the open area in the sidebar, no tabs, Home as the directory. Two screens were both "People": now "People" (accounts) and Access > "By person". WhatsApp Connection (it is not data) moved from Records & Data to Sales; Sales team moved from Access to Sales. The right-hand column of the preview became a one-line strip under the title, because the real Access and Employees screens are wide and were tuned to the space they have.
- Task Management lost Performance, Team Performance, Settings group and Super Admin from its sidebar; one user menu at the foot of all module sidebars.
- `users.team` enum -> text (Option B) so Control Center departments are the source of truth; adding to the enum was rejected as a treadmill.
- Designation level is informational only, no backfill (34 production users, 0 levels at merge, from memory).
- Announcements are a separate system from notifications on purpose; audience is always named people.
- Test cleanup uses a transaction-local GUC, not an admin exemption; "test data" is a fact about when a record was created, never a tick-box.
- `/admin/members` keeps a layout+ModuleGuard though it only redirects, because `moduleParentGate.test.ts` pins it.

## 9. Known traps / gotchas / unfixed defects

1. The Action Queue came back after ACCESS_CONTROL_V1 said it was removed (2026-08-15), and was removed for good on 15 Nov 2026. Do not rebuild it in the Control Center: pending work belongs on its module's dashboard.
2. `users.team` conversion hit `0A000` because four `orders`/`order_activity_log` RLS policies referenced the column; check `pg_depend` before any `ALTER COLUMN TYPE`.
3. Adding a column to `users` needs a column GRANT and a `safeColumns.ts` entry (module 08), else 42703; `select('*')` on `users` is an error.
4. Adding a migration breaks hard-coded ledger tests (module 08/09). `participantAndOrderTotalSecurity.test.ts` has a FROZEN (applied, hash-pinned) list and a pending list;
   never add an unapplied file to FROZEN.
5. A Control Center / members route that fetches the target and drops the query error becomes fail-open (the exact bug `checkLastAdministrator` was written to kill);
   keep reads inside the guard. `is_active` is NOT an auth gate (Supabase Auth ignores it).
6. Soft-deleted users are not auto-purged although the UI mentions 30 days.
7. `/api/create-employee` accepts manager role; `/api/update-employee` is admin-only now (the Performance doc still says managers may toggle eligibility - stale).
8. `/api/reset-password` min 6 chars vs 8 in self-service.
9. Positions are only a pick-list; `users.position` is plain text, not an FK, so renaming a position does not update people.
10. Department rule changes are cached 30 s on the client; By Module re-fetches the matrix after a team save (`onSaved`).
11. Data Management and Test Data Cleanup are irreversible in production; never fire destructive requests at a live account to prove a guard (use deterministic tests).
12. Never put people's real emails/phones in docs or fixtures; live-DB test fixtures use `@example.invalid` and were once left behind in production (cleaned by PR #132, from memory).

## 10. Tests that guard it

`src/lib/controlCenter/navModel.test.ts`, `src/lib/controlCenter/recent.test.ts`, `src/components/controlCenter/homeDirectory.test.tsx`, `src/components/layout/controlCenterNav.test.ts` (labels, `<Link>`, `inTab`, `tab === 'modules'`, menu default, no tabs, Action Queue files stay deleted),
`src/components/controlCenter/membersConsolidation.test.ts`, `src/lib/users/lastAdministrator.test.ts`, `src/lib/users/designationLevels.test.ts`,
`src/lib/announcements.test.ts`, `src/lib/announcementsMigration.test.ts`, `src/lib/permissions/accessControlUi.test.ts` (layout gate strings),
`compatibilityMigration.test.ts` (needs `'modules'` in `ControlCenterLayout.tsx` and `tab === 'modules'` in page.tsx), `moduleMatrixRoute.test.ts`,
`src/lib/orders/orderFinanceTestReset.test.ts`, `cleanupNumberChoice.test.ts`, `testDataCleanupPiSchema.test.ts`, `testDataCleanupAdvanceExceptionRetry.test.ts`, `testDataResetServer.test.ts`, `orderNumberResetSchema.test.ts` (all under `src/lib/orders/`). `npx tsx --test <file>`; `npm test` for all.

## 11. Open items / next planned work

- Members/Admin API security audit was the stated next item after the repo-health cleanup (from memory); `/api/create-employee` manager allowance and the 6/8 password
  minimum are candidates.
- Rename/merge dead `/settings/*` pages; delete the unused local pages once confirmed unreachable.
- Production owner go-live steps for test-data cleanup (disable cleanup, number start) are the owner's (from memory).
- Optional: automated purge or removal of the "30-day" wording.

## 12. Recheck before changing this module

Read: `src/app/admin/control-center/layout.tsx`, `src/lib/controlCenter/navModel.ts`, `src/components/controlCenter/MembersWorkspace.tsx`,
`src/lib/users/lastAdministrator.ts`, the four destructive routes, `src/lib/users/safeColumns.ts`, `20261106000000`, `20270110000000`,
`20260706000000`, `20260916000000`, `20261010000000`, `20270317000000`. Run `npx tsx --test src/lib/users/*.test.ts src/lib/controlCenter/*.test.ts
src/components/layout/controlCenterNav.test.ts src/lib/announcements*.test.ts`. Read-only queries: `select role,is_active,is_deleted,count(*) from users group by 1,2,3;`
(confirm >=1 active admin), `select * from test_data_cleanup_settings;`, `select count(*) from announcements where ended_at is null;`.

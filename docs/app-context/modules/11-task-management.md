# 11 - Task Management

Verified against checkout `852e0493`. Unverifiable claims are labelled "(unverified, from memory)". Production apply state of
migrations cannot be read from a checkout; where it matters the evidence available is stated.

## 1. Purpose & users

Create, assign, acknowledge, update, complete and report on work between employees; Top 3 Focus; quotation requests (customer-sensitive tasks);
the EOD (end-of-day) log is filed from the Performance module but reads task data (module 13).

| Role / person | What they do |
|---|---|
| Any employee holding `task_management:view` | own dashboard, My Tasks, Assigned By Me, Task Detail, self tasks, delegation |
| Creator of a delegated task | approves or returns submitted work, cancels, restores |
| Assignee | acknowledges, updates status, submits for approval, posts updates |
| Admin | all of the above where the route allows admins; copy-and-assign; Task Records (`/super-admin`); admin cancel/restore; admin sees quotation register |
| `task_management:view_quotations` / `manage_quotations` holders | quotation requests register / submit quotation requests |
| Admin or manager (role) | `/tasks/all`, `/manager` (role-based remnants) |

## 2. Status at commit 852e0493

Shipped (all items below exist in code). Recent: #322 (task navigation warm-up), #288 (`acknowledge_task`), #287/#283 (`change_task_status`), #282 (Task Detail
stalls), #278 (Updates beside Activity), #257, #255 (new task no longer notifies), #217 (attachment gallery + ZIP download), #182/#181 (list return costs nothing).
There is **no task-draft feature** (searched `app/tasks`, `lib/tasks`, `components/tasks`; "draft" in this app means Orders PI drafts / review drafts).
Two creation modals inside `/tasks/my` and `/tasks/assigned-by-me` are unreachable dead code kept because `myTasksLoadState.test.ts` reads them.
Apply state: `20270303000000` ("migration applied" in the #288 title); `20270302000000` is called by the app (`statusChange.ts`) so the app needs it applied
before deploy - treat as applied (commit #287 shipped on it) but verify with `supabase migration list --linked` before relying on it (unverified).

## 3. Pages and API routes

Pages (`src/app/tasks/**`, `src/app/dashboard`, all behind `ModuleGuard moduleKey="task_management"`):
`/dashboard` (home: Top 3 Focus, Needs Your Attention, and the "At a glance" bar with the counters and Tasks Created), `/tasks/my` (My Tasks; tabs, drawer), `/tasks/my/completed`, `/tasks/cancelled`,
`/tasks/assigned-by-me` (+ `/completed`, `/cancelled`), `/tasks/assigned-to-me` (redirects to assigned-by-me), `/tasks/all` (admin|manager by role),
`/tasks/create` (delegate), `/tasks/create-self`, `/tasks/[id]` (Task Detail, has `loading.tsx`), `/tasks/quotation-requests` (+ `/new`), `/manager`
(admin|manager), `/super-admin` (Task Records, admin) and `/super-admin/view-user/[userId]`.

API routes: `/api/tasks/[id]/copy` (POST, admin-only Copy & Assign), `/api/tasks/[id]/notify-assignment` (POST; writes NOTHING by rule since #255),
`/api/cancel-task` (POST), `/api/restore-task` (POST), `/api/notify-status-update` (POST), `/api/task-detail` (GET, admin|manager), `/api/activity-log/[id]`
(PATCH/DELETE own entry), `/api/admin-tasks` (GET admin), `/api/admin-delete-tasks` (POST admin hard delete), `/api/daily-log` (GET/POST EOD),
`/api/eod-logs/team` (GET). RPCs called from the browser: `transition_task_review`, `change_task_status`, `acknowledge_task`.

## 4. Database

- `tasks`, `task_activity_log`, `notifications`, `users` pre-date migrations (no CREATE in `supabase/migrations`; see module 08). Columns (from `src/lib/types.ts`
  and migrations): id, title, note, status, priority (`high|medium|low`), type (`completion|daily_update`), is_urgent, due_date (date), acknowledged_at, created_at,
  last_update_at, completed_at, assigned_to, created_by, delegated_by, copied_from_task_id (`20260693000000`), blocker_reason, waiting_on_type
  (`team_member|external`)/waiting_on_user_id/waiting_on_text, team (text since `20260667`), task_type (`general|quotation_request`, `20260652`, NOT NULL default
  general), customer_name, contact_number, company_name, city_project, attachment_url (legacy, never rendered), attachment_storage_path (`20260906`),
  cancelled_by/cancelled_at/cancellation_reason (`20260633`), is_stale, stale_day_count. **`tasks` has no `is_deleted` column**; "not deleted/cancelled" means
  `status NOT IN ('completed','cancelled')`.
- `task_status` enum: pending, started, working, waiting, blocked, **pending_approval** (appended by `20260832000000` in its own file because Postgres forbids using
  a new enum label in the same transaction), completed, cancelled. `task_activity_log.action` is enum `public.activity_action` (18 task-mutation values; values
  used by scoring: created, acknowledged, status_changed, note_added, comment_added, due_date_changed, priority_changed, title_changed, waiting, working, task_copied,
  delegated, escalated). It carries from_status/to_status/old_val/new_val/actor_id/note.
- `task_attachments` (`20260607`/`20260619`; `storage_path` `20260906`; bucket `task-attachments` made PRIVATE by `20260907000000`; reads via signed URL, TTL 300 s,
  `SIGNED_URL_TTL_SECONDS`; the preview modal renders from a plain URL and uses a second one signed with the filename (`signAttachmentUrl(..., downloadAs)`) for Download / Open in Tab, because a filename-bearing URL downloads instead of displaying; thumbnails 256 px; per-send total attachment cap 10 MB). `user_top_tasks` (`20260628000100`: user_id, task_id, display_order; unique
  (user_id, task_id); RLS select/insert/delete for owner **and NO UPDATE policy**; ON DELETE CASCADE). `daily_work_logs` (`20260606`; EOD).
- Functions/triggers:
  - `transition_task_review(p_task_id, p_action, p_note)` (`20260833000000`, later replaced by `20261016000000` (records `activity_log_id`) and `20261212000000`
    (approval stops notifying)): actions `submit | approve | return`; SECURITY DEFINER; sets GUC `boe.task_review_context` around its UPDATE; the only legal path.
  - `tasks_enforce_review_path` BEFORE UPDATE trigger (`20260834000000`): fires only if `auth.uid()` is non-null (service role exempt: keeps cancel/restore working),
    task is delegated (`created_by <> assigned_to`) AND ordinary (`task_type <> 'quotation_request'`) AND the change touches review states. It also makes
    `assigned_to` / `created_by` immutable for client sessions (Copy & Assign INSERTs a new row). `in_task_review()` lives in 834.
  - `change_task_status(task, status, reason, attachment, waiting type/user/text)` (`20270302000000`): assignee-only; refuses cancelled/pending_approval targets, finished or
    in-review tasks, delegated-ordinary `completed`, un-acknowledged non-self non-quotation tasks, same-status repeats, reason > 1000 chars, waiting without detail
    (waiting text <= 500); locks the row; one transaction for status + stale resets (blocker_reason only when blocked, etc.) + history row; writes no notification.
  - `acknowledge_task(task)` (`20270303000000`): assignee only, not creator, not quotation, not already acknowledged (55000), status in pending/started/working/
    waiting/blocked; writes `acknowledged` + `status_changed -> working` history rows atomically; no notification.
  - `cleanup_top_tasks_on_completion()` (AFTER UPDATE OF status): deletes the pin when status in (`pending_approval`, `completed`, `cancelled`) (`20261018000000`).
  - `run_task_health_check()` hourly pg_cron job (DB-side, not in `vercel.json`): records escalations/stale flags in the activity history only; no notification rows since
    `20261015000000` (about 16k `overdue`/`escalation` notification rows had accumulated, never shown).
  - Performance indexes (`20260679000000`): `idx_tasks_completed_by_user_date`, `idx_tasks_stale_blocked_by_user`, `idx_tasks_active_by_user`, `idx_tasks_overdue_by_user`.
- RLS: `tasks`/`task_activity_log` SELECT = creator OR assignee OR delegator (production-read 2026-08-14, ACCESS_CONTROL_V1.md); **no admin branch**; plus the RESTRICTIVE
  `*_module_entry_gate` (module 09) on `tasks`, `task_attachments`, `task_activity_log`, `user_top_tasks`. Admin tooling that needs more uses the service role.
- Immutability: the three 2026-08 approval migrations were applied one at a time (832 -> 833 -> deploy -> 834); 834 confirmed applied 2026-08-29 (from memory,
  `migration list`). `supabase/tests/task_creator_approval_assertions.sql` asserts the END state, refuses to run before 834 and WRITES rows: never run against production.

## 5. Permissions & access

- Module entry: `task_management:view` (engine) via `ModuleGuard`; every non-admin needs a grant. Quotation surfaces: `deriveQuotationCapabilities(role, permissions)`
  (`src/lib/permissions/quotations.ts`): admin -> view + manage but `canCreateQuotations=false` (an admin keeps review/respond but is not offered "New Quotation
  Request"); others: `canManageQuotations = view && manage_quotations`, `canViewQuotations = view && (view_quotations || manage)`, `canCreateQuotations = canManage`.
  `view_quotations` / `manage_quotations` are PROTECTED (Custom-only) and manage requires view_quotations (module 09). Sensitive quotation fields: customer_name,
  contact_number, company_name, city_project.
- Task-level rules (`src/lib/tasks/taskDetailAccess.ts`, mirrored by the RPC re-checks): `canPostUpdate` = (assignee or creator) and not finished, NO admin exception
  (a test pins this because `/api/notify-status-update` would refuse the call the UI offered); `canMarkComplete` = assignee, not finished, not delegated-ordinary, and
  (self task, or acknowledged, or quotation); `canSubmitForApproval` = assignee of a delegated-ordinary task, acknowledged, status in pending/started/working/
  waiting/blocked; `canApproveTask`/`canReturnTask` = creator of a delegated-ordinary task in `pending_approval`.
- Cancel: creator OR admin only, task not already completed/cancelled (`/api/cancel-task`). Restore: assignee, creator or admin, only completed/cancelled tasks
  (`/api/restore-task`; `restoreTargetStatus` maps `pending_approval` and null to `working`, otherwise back to the status before the terminal move).
  Copy & Assign: active admin only; copies title, description, priority and task-level attachments; assignee/due/priority from the request; status starts pending and
  unacknowledged; rolled back if attachment copy fails. Activity entry edit/delete: only the original actor. Add to Meeting: creator, current assignee or admin who also
  hold Meetings access (`addToMeetingAccess.ts`).
- Task Records (`/super-admin`), `/api/admin-tasks`, `/api/admin-delete-tasks`: admin. `/api/task-detail`, `/tasks/all`, `/manager`: admin|manager by `users.role`
  (and, because RLS has no admin branch and these pages query with the browser client, an admin/manager may only see tasks within their own creator/assignee/delegator
  scope there - unverified at runtime; `/api/admin-tasks` is the service-role path).

## 6. Business rules

Statuses and transitions:
- Delegated ordinary task (creator != assignee, `task_type<>'quotation_request'`): pending -> (Acknowledge) working -> started/working/waiting/blocked via
  `change_task_status` -> **Submit for Approval** (`pending_approval`, `completed_at` stays null, no completion credit) -> creator **Approve** (`completed`,
  `completed_at` set inside the RPC) or **Return** (requires a reason, <= 1000 chars `RETURN_REASON_MAX_LENGTH`, -> `working`, resubmittable). The database refuses any other
  route to completed/pending_approval for these tasks from a client session.
- Self task (created_by = assigned_to): no acknowledgement; assignee can Mark Complete directly.
- Quotation request: no acknowledgement, no creator approval, silent EXCEPT its two endings (Oct 2026): when the assignee marks it complete, or an admin cancels it, the CREATOR (the sales person who raised it) gets one notification; nobody else, no other event (module 12).
- **Quotation Details page (Oct 2026, `/tasks/[id]` for a live quotation task; cancelled ones keep the old layout).** Rendered by `QuotationDetailView` instead of the task layout: status strip (Requested / Waiting or Sent / priority), left card "What sales asked for" (lead name, tap-to-call phone, requester, requirement note, sales' files), right card with two tabs - **Your quotation** (attach the quote file(s) + optional note, **Send Quotation to <sales person>**, disabled until at least one file is attached and none failed) and **Message sales**; after sending a "Quotation sent" card (files, note, date, revision count) with **Reopen for revision**; the activity card is titled **Timeline** and is shared with the task layout. Sending = `saveComment()` (now returns boolean) with `sendingQuotationRef` set, which tags the update row `task_activity_log.new_val = 'quotation_sent'` (`QUOTATION_SENT_MARKER`, no migration) and skips its own comment notice, THEN `applyStatusChange('completed')` (completion notifies the creator as before). Sales' request files are the task-level attachments (`activity_log_id` null); the quote files hang off the tagged update. Old quotations completed before this have no tagged update: the card says so. Pure rules in `src/lib/tasks/quotationSend.ts`.
- Waiting needs `team_member` (user must exist) or `external` (text). Blocker/waiting fields clear when the state that explained them ends.
- Tabs on My Tasks (`myTaskTabs.ts`): Today/Overdue/Future Actionable, Waiting/Blocked, Awaiting Approval, Action Required, All, Important, Unacknowledged, In Progress,
  Overdue, Needs Update, Non-Completion, Completed. "Actionable workload" excludes closed (completed/cancelled) AND `pending_approval`.
- **Assigned By Me redesign (Oct 2026).** One panel, one line per task, no description. Columns: Task, Assigned to, Priority, Status, Due, Last update, actions. Column layout is a container query in `assignedByMe.module.css`: Last update goes first, then Priority, and Cancel task leaves the row but stays in the ⋯ menu. For Approval rows show Approve and Cancel task; every other open task has Cancel task in the ⋯ menu (Open full page, Edit, Cancel task, Delete). Tasks waiting for approval sort first. Neither action shows under View As or for quotations (Approve by `canApproveTask`, Cancel by `canCancelFromList`).
- **Team response bar (Oct 2026).** `teamResponse.ts` (pure), `useTeamResponse`, `TeamResponseBar`. Scope: tasks the viewer assigned, read under their own RLS, so nothing new is exposed. Strip: last 12 working days (Sundays out, holidays and leave NOT out); a day with an update is Updated; a day holding an open task with none is Silent; not counted are today until updated, days with no open task, and days the only tasks sat with the creator for approval. Reply time: median wait from the creator's message (`created`, `note_added`, `comment_added`, a return) to the assignee's next meaningful action, last 30 days; messages before a reply collapse into one; an unanswered one counts at its age once 24 h old; one on a task closed unanswered is dropped. Labels, least active first: Active (at least 70% of days and reply within 24 h), Least active (under 40% or over 72 h), Inconsistent (between), Too early (under 5 counted days or under 3 messages). Cut-offs are proposals agreed on a mockup, untested on real data. Inactive accounts are listed apart and never scored. Does not run under View As. Measures actions only: nothing records who OPENED a task.
- Assigned By Me row colours (PR #445): Important = gold fill + gold border + star; For Approval = blue fill + blue stripe + blue badge; both = blue fill with gold border and star. Phone card: stripe and badge only.
- Overdue: `accruesAssigneeOverdue(status)` is false for completed, cancelled, pending_approval (`reviewTransitions.ts`); single source for My Tasks, dashboard, manager
  views, Team Performance and the per-day score reconstruction. **`isOverdue(dueDate)` in `src/lib/ui.ts` compares to the UTC date (`toISOString().slice(0,10)`), not IST** -
  between 00:00 and 05:30 IST it lags a day (the performance code uses IST via `istDate.ts`).
- Top 3 Focus: max 3 enforced in the BROWSER (`top3Data.length >= 3` in `/tasks/my`), not by a database constraint; pinned tasks are excluded from the strip once
  completed/cancelled/pending_approval (query filter + trigger). Reorder = DELETE + INSERT renumbering 1..N (no UPDATE policy; `display_order` can contain duplicates).
- My Tasks row order (Oct 2026, migration `20270424000000` APPLIED 2026-10-28): Important, then Today's Focus pins, then the rest; within a group the person's drag order from
  `user_task_order` (one row per user, `task_ids uuid[]`, upsert; owner-only RLS; display preference, grants nothing). Pure rules: `src/lib/tasks/taskOrder.ts`; hook
  `useTaskOrder`. Desktop only; pointer-driven drag (`useRowDragSort`: live reorder via transforms, edge auto-scroll, Escape cancels, committed once on release) plus a hover "Move to top" button; no cross-group drops; the saved array is the whole active list so it holds in every tab. Action icons are borderless; the pin
  has its gold border only when pinned.
- Creation (`taskCreateFlow.ts`): similar-task warning when >= 3 of the new title's words longer than 3 characters appear in an existing open task's title of the
  assignee (`findSimilarTitle`); candidates are primed when the assignee is chosen and reused for 60 s (`DUPLICATE_CANDIDATES_MAX_AGE_MS`). Awaited on click: similar check,
  attachment preparation, insert, `created` activity row; the assignment notification runs afterwards and reports its own outcome. Double clicks create one task (synchronous
  in-flight guard). Success target and Self/Delegate buttons: header actions in `DashboardLayout`, hidden on routes in `TASK_CREATE_ACTIONS_HIDDEN_ROUTES`.
- Reporting (`taskReporting.ts`): Tasks Created rows (self vs delegated, 7 and 30 days rolling) EXCLUDE quotation requests (`task_type <> 'quotation_request'`); Completed
  archives and Assigned By Me INCLUDE them. Completed pages are DB-paged (`COMPLETED_PAGE_SIZE = 20`, `completed_at desc nulls last`, id tiebreak); filters counterpart,
  priority, title `ilike` (LIKE wildcards escaped), completed-on day (local-day range). Legacy rows with `completed_at IS NULL` sort last and never match date filters
  (their count was never measured, from memory). Completion windows: yesterday, last 7, last 30 days.
- **Dashboard "At a glance" bar (2026-10-29, PR #500 squash-merged as c79bb1a6, no SQL).** The three counters (Overdue, Waiting, Due Today) and the Tasks Created table moved from the
  bottom of `/dashboard` into one bar, `src/app/dashboard/GlanceBar.tsx` + `glanceBar.module.css`, built like the Modules "For you" panel: from a 1132 px window a
  280 px column fixed to the right edge, full height, own scroll, header and body reserving `280px + 24px` through `:has(.glance)`, 150 px bottom padding for the
  floating round buttons; narrower, an ordinary block under Needs Your Attention (counters three across from 640 px). Always drawn (a 0 still shows). Same counts,
  labels and rule as before: a counter opens its list drawer only when it has tasks; only Overdue is red. Table rows now read "Self tasks" / "Delegated tasks",
  columns "7 days" / "30 days" (the bar's heading says "created"). The page no longer has `OperationalStatusPanel`.
- URL list state: tab, search, filters, page live in the query string (`src/lib/listState.ts`, `useListUrlState`): defaults never written; unusable values parse to default;
  debounced search flushed on blur. Not converted on purpose: `/performance/team`, `/notifications`.
- Return-to-source: Task Detail opens as `/tasks/<id>?returnTo=<encoded list path>`; `taskReturnPath.ts` re-exports `safeReturnPath` (module 08). After Submit for Approval:
  toast -> 800 ms -> `noteListReturn()` -> `router.replace(target)`. Back button uses `appHistory.ts` (`noteDocumentEntry` sampled in `Providers`) so a task opened in a new
  tab still has a Back that goes somewhere.
- Navigation caching (#322, #182, #181, #147): Dashboard warms My Tasks list + shared names table once (never under View As) with one option object shared by page and
  warm-up; My Tasks reads names from the shared table; My Tasks / Assigned By Me prefetch each task href ONCE per arrival (Notifications no longer does: it warms on hover/focus/touch only, module 12 trap 15) with the full `?returnTo` href (the
  router cache is keyed by full href); `/tasks/[id]/loading.tsx` makes prefetch work for the dynamic route; My Tasks must not invalidate its own cache on mount.
- Activity text: one "Send Update" writes ONE `note_added` row whether it carried text, files or both; heading is read from the row (`activityHeadings.ts`:
  `attachmentPhrase`, `commentHeadingRest`). "Read more" appears only when text actually overflows 8 lines.
- Attachments: private bucket; legacy rows are resolved to `storage://task-attachments/...` canonical refs; "Download all images (ZIP)" via `fflate`.
- Daily/EOD log: `daily_work_logs` unique per (user_id, log_date); POST needs a non-empty summary; date default `istToday()`; authorization is Performance's, not task role
  (module 13).

## 7. Key components & lib files

`src/lib/tasks/*` (taskDetailAccess, reviewTransitions, statusChange, acknowledgeTask, taskCreateFlow, taskCreateActions, taskReporting, myTaskTabs, taskReturnPath,
assignmentNotification(.writer.server), attachmentStorage, commentAttachments, activityHeadings, addToMeetingAccess, taskGallery, taskDetailLoad, healthCheckMigrationAudit, quotationSend),
`src/hooks/queries/{useMyTasks,useAssignedByMe,useCompletedTasks,useTaskReports,useTopTasks,useQuotationRequests}.ts`, `src/components/tasks/{AddToMeetingModal,
CancelledArchive,CompletedHistory,CopyAssignModal,MyTaskViewTabs,QuotationDetailView,TaskAttachmentGallery,TaskCreationReport,TaskImageViewer}.tsx`, `src/components/layout/DashboardLayout.tsx`
(shell for the Task Management pages - 22 per memory; header Self/Delegate actions), `src/components/notifications/*`, `src/app/tasks/[id]/page.tsx` (3411 lines), `src/app/tasks/my/page.tsx`
(1985), `src/app/dashboard/page.tsx` (about 1800) with `src/app/dashboard/GlanceBar.tsx` (the At a glance bar). Pure helpers are tested directly; the large client components are pinned by source-contract tests.

Cancelled pages (Oct 2026): `/tasks/cancelled` and `/tasks/assigned-by-me/cancelled` render through `CancelledArchive.tsx` (month groups, rows, heading, note, toolbar, empty state); the pages keep their own paged read, filters, load-error banner and empty-state branch because `archiveListBounds.test.ts` reads those from the page source.

## 8. Decisions made & why

- Delegated work is completed by its CREATOR, not the assignee (assignee word is not enough; credit for Performance awarded on approval).
- Three-migration rollout with deploy in the middle (833 RPC -> frontend -> 834 enforcement) so both old and new frontends work in the overlap.
- No new notification enum values for review events: they reuse `task_acknowledged`; presentation is in the title/activity link.
- Inactive names come through `/api/tasks/people`, not a wider `users` policy: that policy was tightened on purpose (20260812000000) and code selecting from `users` relies on it to keep leavers out of dropdowns. The direct read stays as the fallback.
- Approval is silent; submit still notifies the creator, return/reopen still notifies the assignee; a new task is silent (acknowledgement section already shows it); quotation
  requests are silent except that completion (and an admin's cancellation) tells their creator (Sept 2026 owner rules, amended Oct 2026; `taskNotificationPolicy.ts`).
- Task Management holds task work only; Performance, Settings, Super Admin moved out of its sidebar.
- `change_task_status` and `acknowledge_task` exist because browser-side UPDATE + INSERT were two non-transactional calls (a changed task could have no history row).
- Measure performance on production with disposable "[perf test]" tasks (those tasks remain in production, unverified, from memory).
- Do not reopen the rapid-reorder anomaly of Top 3 (could not be reproduced); add an in-flight lock only if users report it.

## 9. Known traps / gotchas / unfixed defects

1. `tasks` has no `is_deleted` column (an earlier index migration targeting it never applied).
2. `user_top_tasks` has no UPDATE policy; reordering is DELETE+INSERT; `display_order` is not unique.
3. Service role is exempt from `tasks_enforce_review_path` (that is intentional; cancel/restore rely on it) - any new service-role task write bypasses the review rule.
4. A route under `src/app` leaves a stale `.next/dev/types/validator.ts`; `useSearchParams` needs `<Suspense>`; `/tasks/[id]` without `loading.tsx` = no prefetch.
5. Six test files read `/api/notify-status-update`'s source and pin exact identifiers (`notifyUserId === user.id`, `{ skipped: true }`, `verifyActivityBelongsToTask(supabase, activityLogId, taskId)`,
   `activity_log_id: linkedActivityId`, `{ actorId: user.id }`, `if (error) {`, `{ status: 500 }`). Source-contract assertions also match COMMENTS - match call shapes.
6. Four tests pin the notification enrichment query count in `pageEnrichment.ts`; adding a query breaks them by design (module 12).
7. `isOverdue` uses UTC date, see section 6. `/tasks/all` and `/manager` query tasks with the browser client under RLS that has no admin branch; they are role-gated, not engine-gated.
8. Disposable "[perf test]" tasks (self sp1-3 / sa1-3, delegated dp1 / da1) were created in production for measurement and may still exist - ignore them in reports (unverified, from memory).
9. `/api/performance` and its `daily_performance_logs` table are an orphan (module 13); the EOD UI uses `/api/daily-log`.
10. Memory's assertion that Task notifications are "title-whitelisted" is out of date: the task feed is selected structurally on `task_id IS NOT NULL` plus an exclusion of system types
    (module 12).
11. Migration header comments such as "NOT APPLIED" in `20261015000000`, `20261016000000` are stale (the FROZEN list in `participantAndOrderTotalSecurity.test.ts` records both as applied).
12. `copy` route copies attachments with the service role and rolls back the new task on failure; do not weaken that.
13. Chrome/browser verification trap: a hidden Chrome tab reports `visibilityState hidden`, pausing rAF, so the drawer stays off-screen and clicks hit the backdrop (memory).
14. Notification enrichment reads `task_attachments` with only `activity_log_id, file_name, file_type` (never `url`/`storage_path`) - keep it that way (`pageEnrichment.ts`).

15. `users` RLS is `is_active = true`, so any browser read or embedded join returns nothing for a deactivated person. `is_active` is NOT a sign-in gate, so such a person can still work. The Completed and Cancelled archives and `/tasks/all` still read `users` directly and still show "member" for them.
16. Task Detail's `supabase.rpc('transition_task_review'` and `handleCancelTask` are pinned in place by `taskDetailLoad.test.ts`, so the list has its own calls in `taskListActions.ts`, built from the same rules.

## 10. Tests that guard it

Pure: `src/lib/tasks/{taskDetailAccess,myTaskTabs,taskReporting,reviewTransitions,taskReturnPath,activityHeadings,statusChange,acknowledgeTask,taskGallery,attachmentStorage,commentAttachments,quotationSend}.test.ts`.
Source-contract/shape: `taskNavigationPerformance.test.ts`, `taskCreationPerformance.test.ts`, `taskDetailOpenFromDrawer.test.ts`, `myTasksLoadState.test.ts`, `myTasksRuntimeShape.test.ts`,
`myTasksQuickAction.test.ts`, `dashboardViewAsReadOnly.test.ts`, `taskCreateFlow.test.ts`, `taskCreateActions.test.ts`, `assignmentWriteAuthority.test.ts`, `assignmentServerBoundary.test.ts`,
`topTasksApproval.test.ts`, `changeTaskStatusMigration.test.ts`, `changeTaskStatusNotificationCompat.test.ts`, `acknowledgeCallers.test.ts`, `healthCheckMigrationAudit.test.ts`,
`src/app/tasks/archiveListBounds.test.ts` (pins the two Completed pages as DB-paged), `src/app/tasks/quotation-requests/filters.test.ts`, `src/app/dashboard/glanceBar.test.ts` (the At a glance bar: same counters and rule, docked at 280 px), component tests in `src/components/tasks/`.
DB assertion scripts (WRITE rows; never on production): `supabase/tests/task_creator_approval_assertions.sql`. Run: `npx tsx --test src/lib/tasks/*.test.ts`; full: `npm test`.

## 11. Open items / next planned work

- Delete the unreachable create modals in `/tasks/my` and `/tasks/assigned-by-me` (and update `myTasksLoadState.test.ts` with them).
- Re-prime similar-task candidates while typing so the 60 s window cannot lapse (open follow-up).
- Task Detail secondary data (attachments ~565 ms, all active users ~437 ms) still blocks first paint; 6 other drawer callers still close-then-push (candidates).
- Mobile drawer and scroll restoration were never verified in a browser (memory).
- Make `isOverdue` IST-aware; consider an admin branch or service-role path for `/tasks/all` and `/manager`; consider a DB cap for Top 3.
- Hard delete (`/api/admin-delete-tasks`) destroys history: `task_activity_log` FK has no cascade, so the route deletes logs first.

## 12. Recheck before changing this module

Read: `src/lib/tasks/taskDetailAccess.ts`, `reviewTransitions.ts`, `statusChange.ts`, `acknowledgeTask.ts`, `taskCreateFlow.ts`; migrations `20260832`..`20260834`, `20261016`,
`20261018`, `20261212`, `20270302`, `20270303`; `src/lib/notifications/taskNotificationPolicy.ts`; `/api/notify-status-update`, `/api/cancel-task`, `/api/restore-task`; the 6 pinned tests
named above. Read-only queries: `select policyname,cmd,permissive,qual,with_check from pg_policies where tablename in ('tasks','user_top_tasks','task_activity_log','task_attachments');`,
`select column_name,data_type from information_schema.columns where table_name='tasks';` (never assume `is_deleted`), `select enum_range(null::task_status);`.
Run `npx tsx --test src/lib/tasks/*.test.ts src/lib/notifications/*.test.ts`, then lint, `tsc`, `next build`.

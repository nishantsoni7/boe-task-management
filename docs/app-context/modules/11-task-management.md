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
  - `run_task_health_check()` hourly pg_cron job (DB-side, not in `vercel.json`; the cron entry itself is NOT in any migration): since `20270610000000` it writes ONLY the stale flag
    (`tasks.is_stale`/`stale_day_count` and one `stale_flagged` activity line per task). No notification rows since `20261015000000` (about 16k `overdue`/`escalation` rows had accumulated,
    never shown); no "Auto-escalated" activity lines since `20270610000000` (see section 6, "Auto-escalation removed"). Rollback text = the `CREATE OR REPLACE` in `20261015000000`
    (`docs/proposals/run_task_health_check.production.sql` is the version before that).
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
- **Assigned By Me redesign (Oct 2026).** One panel, one line per task, no description. Columns: Task, Assigned to, Priority, Status, Due, Last update, actions. Column layout is a container query in `assignedByMe.module.css`: Last update goes first (list under 1120px), then Priority (under 960px). For Approval rows show Approve and Cancel task as 32px icon buttons (see the icon bullet below); every other open task has Cancel task in the ⋯ menu (Open full page, Edit, Cancel task, Delete). Tasks waiting for approval sort first. Neither action shows under View As or for quotations (Approve by `canApproveTask`, Cancel by `canCancelFromList`).
- **Team response bar (Oct 2026).** `teamResponse.ts` (pure), `useTeamResponse`, `TeamResponseBar`. Scope: tasks the viewer assigned, read under their own RLS, so nothing new is exposed. Strip: last 12 working days (Sundays out, holidays and leave NOT out); a day with an update is Updated; a day holding an open task with none is Silent; not counted are today until updated, days with no open task, and days the only tasks sat with the creator for approval. Reply time: median wait from the creator's message (`created`, `note_added`, `comment_added`, a return) to the assignee's next meaningful action, last 30 days; messages before a reply collapse into one; an unanswered one counts at its age once 24 h old; one on a task closed unanswered is dropped. Labels, least active first: Active (at least 70% of days and reply within 24 h), Least active (under 40% or over 72 h), Inconsistent (between), Too early (under 5 counted days or under 3 messages). Cut-offs are proposals agreed on a mockup, untested on real data. Inactive accounts are listed apart and never scored. Does not run under View As. Measures actions only: nothing records who OPENED a task.
- **Assigned By Me polish (Nov 2026, PR #602 merged as 6db10ccd).** The owner's screenshot showed Approve covering "Last update": the Actions column was 216px for labelled buttons that needed about 250 (Approve 99 + Cancel task 94 + ⋯ 32, because `.boe-btn svg` forces 18px icons). Now Approve and Cancel task are icon buttons whose `title` is the tooltip and whose `aria-label` names the task, the column is 128px at every width, and `assignedByMeRedesign.test.ts` fails if any tier's last track drops under 122px. Priority is a coloured dot with a neutral word; Last update is muted; search and both filters are the shared `.boe-input` (36px, 44px under 768px); Team response draws no 12-day strip for `too_early` people. Phone cards keep the words and carry the same two icons (there is no hover on a phone). Not done: a tablet with no hover never sees the tooltip.
- **Task preview drawer (Nov 2026, PR #654 merged as b0f4ff3e; the right-hand panel opened from the Dashboard, My Tasks, Assigned By Me and their completed / cancelled lists).** It now briefs the task instead of listing fields. Top to bottom: (1) a status card, "Working · due tomorrow · with Dhruv Patel" (status word in its colour, the due words red only when `isOverdue` says so), the REASON under it and "Set by <person> · 2d ago" - read from the newest `status_changed` row of the 20 log rows the drawer already loads, exactly as the full page's Current Status card does (page defaults "Task is in progress / waiting for input / blocked" when the row has no words; nothing when no status row is among the 20); work in review is "with" its creator and the word follows the viewer ("For Approval" / "Approval Pending"); a finished task is with nobody; it is always a NAME, never "you", because View As and `super-admin/view-user` hand the drawer the VIEWED person's id as `currentUserId`; (2) the Waiting On and Blocker Reason boxes as before (a blocked task's reason is not repeated in the card); (3) the Acknowledge action (assignee of an unacknowledged delegated task, unchanged rule); (4) **Latest updates**: the last 3 REAL rows (comments, status changes with their reasons, due-date and priority changes as old → new, files, created), skipping `escalated`, `stale_flagged`, a bare `acknowledged` and `task_copied` whenever a real one exists (only system lines = the newest rows are shown, never an empty box); the row that set the status keeps its line but not its words, which the card already says; (5) facts: Priority, Due, Assigned by, Last update, and the aging chip; (6) the description clamped to 3 lines with "Show more" (shared `ExpandableText`). Footer unchanged in behaviour: the `fullPageHref` Link with the `openingRef` guard and "Opening task..." (pinned by `taskDetailOpenFromDrawer.test.ts`) and Close. Every control is 44px. Still ONE read (`task_activity_log`, 20 rows; `old_val` and `new_val` were added to its select) and no write. Pure rules in `src/lib/tasks/taskDrawerBrief.ts`; the drawer has no loader of its own beyond that read.
- **Icon vocabulary for task actions** (one icon per action, keep it across screens): complete or approve = `CircleCheckBig` (Task Detail Mark Complete and Approve & Complete, My Tasks, this list); cancel = `Ban` (Task Detail, Cancelled archive, the ⋯ menu); return = `Undo2`; acknowledge = `UserCheck`; submit for approval = `SendHorizontal`; open = `ExternalLink`; edit = `Pencil`; delete = `Trash2`; more = `MoreHorizontal`. `CheckCircle2` is a done-STATE glyph on the Completed pages, not an action.
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
- **Dashboard Quotation Requests card as a table (2026-11-11, owner picked option B of three previews, PR #663 squash-merged as 4208b935 on 2026-11-11, no SQL).** The card (admins only: `isAdmin ? <QuotationPanel> : <OverdueTasksPanel>`)
  was a name plus a grey meta line, so how long a request had waited, its priority and the sales person were small or missing. Rows are now drawn by `src/app/dashboard/QuotationRequestsList.tsx` +
  `quotationRequests.module.css` (the old `QuotationRequestsSection` is gone from `page.tsx`): columns **Lead | Sales person | Priority | Pending**, sorted longest pending first (the header arrow says so).
  Sales person = the request's CREATOR (`created_by` through the page's name map), as a two-letter circle in one of four fixed colours per person, then the name; no name loaded = a dash, never "Unknown".
  Priority = three-bar glyph + word, **only High is solid red** (`#A12438`), Medium amber, Low grey; the bars carry the level without colour. Pending = `quotationWait()` (`src/lib/tasks/quotationWait.ts`):
  WHOLE 24-HOUR DAYS since `created_at` ("9 days", "1 day"; under a day "5 hours", under an hour "Under 1 hour"), coloured **grey under 2 days, amber from 2, red from 4**, with a bar full at 7 days. These two
  day counts are the owner's call and live as `WAIT_AGING_DAYS` / `WAIT_LATE_DAYS`. The row is one button (Enter and Space open it, `aria-label` reads the whole row, `title` says the raised date).
  It folds by the width of the CARD (`@container`, under 520 px: no header, two lines per row, "Pending 9 days" written out), not the window. **Unchanged:** the query and sort (`compareByUrgency`: overdue,
  blocked, longest pending, priority), at most 8 rows, the empty state, "View all", the click (`taskDetailHref(task.id, pathname)` back to the Dashboard), admin-only visibility, no write, no notification.
  Quotation requests made from the form never carry a due date (`due_date: null`), so the card no longer prints due-date wording for them.
- URL list state: tab, search, filters, page live in the query string (`src/lib/listState.ts`, `useListUrlState`): defaults never written; unusable values parse to default;
  debounced search flushed on blur. Not converted on purpose: `/performance/team`, `/notifications`.
- Return-to-source: Task Detail opens as `/tasks/<id>?returnTo=<encoded list path>`; `taskReturnPath.ts` re-exports `safeReturnPath` (module 08). After Submit for Approval:
  toast -> 800 ms -> `noteListReturn()` -> `router.replace(target)`. Back button uses `appHistory.ts` (`noteDocumentEntry` sampled in `Providers`) so a task opened in a new
  tab still has a Back that goes somewhere.
- Navigation caching (#322, #182, #181, #147): Dashboard warms My Tasks list + shared names table once (never under View As) with one option object shared by page and
  warm-up; My Tasks reads names from the shared table; My Tasks / Assigned By Me warm a task's href only when the pointer RESTS on its row (250 ms, `src/hooks/useIntentWarm.ts`; they used to warm the first 15 rows on every arrival, which Notifications also stopped doing: module 12 trap 15) with the full `?returnTo` href (the
  router cache is keyed by full href); `/tasks/[id]/loading.tsx` makes prefetch work for the dynamic route; My Tasks must not invalidate its own cache on mount.
- Activity text: one "Send Update" writes ONE `note_added` row whether it carried text, files or both; heading is read from the row (`activityHeadings.ts`:
  `attachmentPhrase`, `commentHeadingRest`). "Read more" appears only when text actually overflows 8 lines.
- Attachments: private bucket; legacy rows are resolved to `storage://task-attachments/...` canonical refs; "Download all images (ZIP)" via `fflate`.
- **Auto-escalation removed (owner decision 2026-11-11, branch `fix/remove-auto-escalation`).** The hourly job used to add two lines to a task's Activity, written under the task CREATOR's name (so it read like a person had escalated their own task): "Auto-escalated: overdue with no action for 24 hours" and "Auto-escalated: no update for 72 hours" (action `escalated`, once per task each). The owner asked for the feature to go ("not solving any purpose"). Migration `20270610000000` replaces the function without them; the **stale flag was kept on purpose** (the owner did not ask for it), and a branch that only `CONTINUE`s remains for an overdue, silent task so those tasks still skip the stale check exactly as before. Nothing was deleted: every `escalated` row already written stays in `task_activity_log`, and `isHiddenActivity` (`src/lib/ui.ts`) hides them where Task Detail's Activity is drawn (`buildActivityLog` in `taskDetailLoad.ts`). Side effect of hiding them: the newest real entry is the person's own update again, so Edit/Delete is back (an `escalated` row used to be "the newest entry" and took it away). **Scoring:** `escalated` stays in `MEANINGFUL_ACTIONS` (`teamPerformance.ts`), so rows already written still count as an active day for their actor (the creator) and as a "reply" in `teamResponse.ts` for a self task; new ones simply stop, so a creator no longer collects a free active day from an overdue task. Not touched, optional "level 2": the Dashboard `EscalationListDrawer`, the Manager "Silent 72h+" filter and `.boe-escalation-*` styles, and `escalationLevel()` in `ui.ts` — they are computed in the browser from `last_update_at` and never read the job's lines. The task preview drawer (`TaskDetailPanel.tsx`, #654) reads its own log rows and already skips `escalated` (with `stale_flagged`, `acknowledged`, `task_copied`) through its own `SYSTEM_ACTIONS` list in `taskDrawerBrief.ts`, not through `isHiddenActivity`; a third screen that draws log rows must skip the old lines itself.
- Preview of `.xlsx` (`AttachmentPreviewModal` → `src/lib/attachments/excelPreview.ts` + `ExcelSheetView.tsx`): read in the browser with ExcelJS 4.4.0 (dynamic import, only when a preview opens) and drawn as in Excel — column widths, row heights, merged cells, fonts, fills, borders, number formats, pictures at their anchors; up to 300 rows × 50 columns per visible sheet. Not drawn: charts, shapes, conditional formatting. `.xls`, `.csv`, and any `.xlsx` ExcelJS cannot read fall back to the plain SheetJS table (first 100 rows). Microsoft's Office Online viewer was removed 2026-11-07: it sent the signed file link to Microsoft and its own page filled the console with CSP / unload / icon errors BOE cannot fix. Do not re-embed an outside viewer (guard in `attachmentDownload.test.ts`).
- Daily/EOD log: `daily_work_logs` unique per (user_id, log_date); POST needs a non-empty summary; date default `istToday()`; authorization is Performance's, not task role
  (module 13).

## 7. Key components & lib files

`src/lib/tasks/*` (taskDetailAccess, reviewTransitions, statusChange, acknowledgeTask, taskCreateFlow, taskCreateActions, taskReporting, myTaskTabs, taskReturnPath,
assignmentNotification(.writer.server), attachmentStorage, commentAttachments, activityHeadings, addToMeetingAccess, taskGallery, taskDetailLoad, healthCheckMigrationAudit, quotationSend, quotationWait, taskDrawerBrief),
`src/components/ui/TaskDetailPanel.tsx` (the preview drawer; 8 callers, 7 pass `fullPageHref`, `super-admin/view-user/[userId]` passes neither and shows no "View Task Page"),
`src/hooks/queries/{useMyTasks,useAssignedByMe,useCompletedTasks,useTaskReports,useTopTasks,useQuotationRequests}.ts`, `src/components/tasks/{AddToMeetingModal,
CancelledArchive,CompletedHistory,CopyAssignModal,MyTaskViewTabs,QuotationDetailView,TaskAttachmentGallery,TaskCreationReport,TaskImageViewer}.tsx`, `src/components/layout/DashboardLayout.tsx`
(shell for the Task Management pages - 22 per memory; header Self/Delegate actions), `src/components/notifications/*`, `src/app/tasks/[id]/page.tsx` (3411 lines), `src/app/tasks/my/page.tsx`
(1985), `src/app/dashboard/page.tsx` (about 1700) with `src/app/dashboard/GlanceBar.tsx` (the At a glance bar) and `src/app/dashboard/QuotationRequestsList.tsx` (the Quotation Requests table). Pure helpers are tested directly; the large client components are pinned by source-contract tests.

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

15. `users` RLS is `is_active = true`, so any browser read or embedded join returns nothing for a deactivated person. `is_active` is NOT a sign-in gate, so such a person can still work. Every task screen names people through `allUserNamesQueryOptions` for this reason; do not add another direct read.
16. Task Detail's `supabase.rpc('transition_task_review'` and `handleCancelTask` are pinned in place by `taskDetailLoad.test.ts`, so the list has its own calls in `taskListActions.ts`, built from the same rules.
15. An icon-only `.boe-btn` must override `min-height` (38px), `padding` and `.boe-btn svg` (18px) with two classes (`.actions .iconButton`), or the button comes out wider than its column (Assigned By Me, Nov 2026).
17. The preview drawer's words ("due tomorrow", "overdue by 3 days") count days against the same UTC date key `isOverdue()` uses, so between 00:00 and 05:30 IST they lag a day exactly as the red flag does; fix both together when `isOverdue` becomes IST-aware (trap 7). Its reason comes only from the 20 newest log rows: a task whose last status change is older than 20 rows shows no reason and no "Set by". Its "attached a file" line is a `note_added` row with no text (the Send Update gate refuses an empty post), because the drawer does not load `task_attachments`.
18. The Dashboard's Quotation "Pending" must stay the same whole-24-hour floor the list is SORTED by (`daysSince` in `page.tsx`; `quotationWait.test.ts` pins the two to one expression). IST calendar days would let a row read "8 days" above one that reads "9 days". The card is admin-only and the day colours (2 and 4 days) are the owner's numbers, not a rule from the database.

## 10. Tests that guard it

Pure: `src/lib/tasks/{taskDetailAccess,myTaskTabs,taskReporting,reviewTransitions,taskReturnPath,activityHeadings,statusChange,acknowledgeTask,taskGallery,attachmentStorage,commentAttachments,quotationSend,quotationWait}.test.ts`; `src/app/dashboard/quotationRequests.render.test.tsx` (the Quotation table: columns, priority bars, wait text and bands, the 8-row cap, click / Enter / Space, what the page keeps).
Source-contract/shape: `taskNavigationPerformance.test.ts`, `taskCreationPerformance.test.ts`, `taskDetailOpenFromDrawer.test.ts`, `myTasksLoadState.test.ts`, `myTasksRuntimeShape.test.ts`,
`myTasksQuickAction.test.ts`, `dashboardViewAsReadOnly.test.ts`, `taskCreateFlow.test.ts`, `taskCreateActions.test.ts`, `assignmentWriteAuthority.test.ts`, `assignmentServerBoundary.test.ts`,
`topTasksApproval.test.ts`, `taskDrawerBrief.test.ts` (the drawer's headline, reason and last-3-updates rules, plus a source check: one read, no write, 44px close), `changeTaskStatusMigration.test.ts`, `changeTaskStatusNotificationCompat.test.ts`, `acknowledgeCallers.test.ts`, `healthCheckMigrationAudit.test.ts` (pins `20261015000000`, which is applied and frozen — do not edit it),
`escalationRemovalMigration.test.ts` (pins `20270610000000` line by line against the function it replaced: only the escalation writes and the 72-hour wrapper are gone, the stale block is identical text),
`src/app/tasks/archiveListBounds.test.ts` (pins the two Completed pages as DB-paged), `src/app/tasks/quotation-requests/filters.test.ts`, `src/app/dashboard/glanceBar.test.ts` (the At a glance bar: same counters and rule, docked at 280 px), component tests in `src/components/tasks/`.
DB assertion scripts (WRITE rows; never on production): `supabase/tests/task_creator_approval_assertions.sql`. Run: `npx tsx --test src/lib/tasks/*.test.ts`; full: `npm test`.

## 11. Open items / next planned work

- Delete the unreachable create modals in `/tasks/my` and `/tasks/assigned-by-me` (and update `myTasksLoadState.test.ts` with them).
- Re-prime similar-task candidates while typing so the 60 s window cannot lapse (open follow-up).
- Task Detail secondary data (attachments ~565 ms, all active users ~437 ms) still blocks first paint; 6 other drawer callers still close-then-push (candidates).
- Mobile drawer and scroll restoration were never verified in a browser (memory). The redesigned drawer (Nov 2026) was drawn in a 375 px frame and a desktop window from fixture data only; nobody has opened it signed in on a real phone.
- Make `isOverdue` IST-aware; consider an admin branch or service-role path for `/tasks/all` and `/manager`; consider a DB cap for Top 3.
- Hard delete (`/api/admin-delete-tasks`) destroys history: `task_activity_log` FK has no cascade, so the route deletes logs first.
- Escalation "level 2" (owner has NOT asked): remove the Dashboard `EscalationListDrawer`, the Manager "Silent 72h+" filter/panel and `.boe-escalation-*` CSS, `TaskCard showEscalation` and `escalationLevel()`. They are browser-side views of `last_update_at`, independent of the removed job lines.
- `/api/task-detail` (admin|manager, last 8 activity rows) has no caller in `src`; it was left as is, so it would still return old `escalated` rows to a future caller.
- Old `escalated` rows (never deleted) can be counted once the owner applies the migration: `select count(*), count(distinct task_id) from task_activity_log where action = 'escalated'`. Whether to delete them is a separate decision.

## 12. Recheck before changing this module

Read: `src/lib/tasks/taskDetailAccess.ts`, `reviewTransitions.ts`, `statusChange.ts`, `acknowledgeTask.ts`, `taskCreateFlow.ts`; migrations `20260832`..`20260834`, `20261016`,
`20261018`, `20261212`, `20270302`, `20270303`; `src/lib/notifications/taskNotificationPolicy.ts`; `/api/notify-status-update`, `/api/cancel-task`, `/api/restore-task`; the 6 pinned tests
named above. Read-only queries: `select policyname,cmd,permissive,qual,with_check from pg_policies where tablename in ('tasks','user_top_tasks','task_activity_log','task_attachments');`,
`select column_name,data_type from information_schema.columns where table_name='tasks';` (never assume `is_deleted`), `select enum_range(null::task_status);`.
Run `npx tsx --test src/lib/tasks/*.test.ts src/lib/notifications/*.test.ts`, then lint, `tsc`, `next build`.

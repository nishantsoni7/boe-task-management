# 12 - Notifications

Verified against checkout `852e0493`. Unverifiable claims are labelled "(unverified, from memory)". Where code analysis suggests a latent defect
that cannot be confirmed without production data, it is marked "(code-verified, runtime unverified)".

## 1. Purpose & users

One shared `public.notifications` table feeds a per-module inbox and unread badge for every module except Sample Tracking (own table). Every employee has
their own inbox; the feed shows only rows addressed to them (`user_id = caller`). Admins additionally trigger most "admin notified" events.

| Surface | Category | Page |
|---|---|---|
| Task Management | `task` (default) | `/notifications` (DashboardLayout) |
| Finance | `finance` | `/finance/notifications` |
| Order Management | `order` | `/orders/notifications` |
| Assets & Access | `asset` | `/assets-access/notifications` |
| Attendance & Payroll | `attendance_payroll` | `/attendance/notifications`, `/payroll/notifications`, `/my-issues/notifications` |
| Review Workflow | `review` | `/customer-reviews/notifications` |
| Inventory | `inventory` | `/inventory/notifications` |
| Sample Tracking | OWN system (`sample_notifications` table, `/api/samples/notifications*`) | `/samples/notifications` |
| Meetings, Exhibition Leads, Showroom, Image Editor, Control Center announcements | none (announcements are a separate system, module 10) | - |

## 2. Status at commit 852e0493

Shipped. Newest: #306 inventory booking notifications (`20270314000000`, `20270314000100`), #284 idempotency index (`20270301000000`), #255/#162 silence rules,
#163 enrichment in one wave, #321 hnd1. `20270301000000` apply state: the #284 title says "not applied"; the writer treats the unique violation as "already announced"
so the code works either way (unverified whether applied; check `\d notifications` for `notifications_event_once_idx`).

## 3. Pages and API routes

Pages above (all render `src/components/notifications/NotificationsView.tsx` with a `category` prop and a module `Layout`).
API (`src/app/api/notifications/`): `GET /api/notifications?category=&limit=&count=1` (list or unread count), `DELETE /api/notifications` (delete all in category),
`DELETE /api/notifications/[id]`, `POST /api/notifications/mark-read` (body: exactly one of `id`, `ids`, `taskId`, `entityId`, `all`+`category`),
`POST /api/notifications/delete-selected` (max `MAX_IDS` ids). Writers: `POST /api/notify-status-update`, `/api/finance/notify`, `/api/orders/[id]/notify`,
`/api/orders/submissions/notify`, `/api/samples/notify`, `/api/assets/notify` (+ `/api/assets/warranty-sweep`), `/api/objections*`,
`/api/cancel-task`, `/api/restore-task`, `/api/tasks/[id]/notify-assignment` (now writes nothing), plus SECURITY DEFINER RPCs/triggers in migrations (task review,
order handoff, document submissions, customer review events, attendance requests, inventory bookings).

## 4. Database

- `public.notifications` pre-dates migrations (not created by any file). Columns used: id, user_id, task_id (FK to tasks), entity_id (uuid, FK-free, added by
  `20260694000000`), type (enum `notification_type`), title, body, is_read, is_push_sent, is_digest, created_at, read_at, activity_log_id (FK to
  `task_activity_log(id)` ON DELETE SET NULL, added by `20261016000000`; header says "NOT APPLIED" but the FROZEN list in `participantAndOrderTotalSecurity.test.ts` records it
  APPLIED).
- **`notifications.type` is a Postgres ENUM (`notification_type`).** Adding a type needs `ALTER TYPE ... ADD VALUE` in its own migration file, applied BEFORE the code that
  names it ships (an unknown value in a `type.in.(...)` filter makes PostgREST return an error for the whole category, which the UI shows as "No notifications yet"; enum columns
  do not support `LIKE`, so `type.like.finance_%` errors, and a HEAD count swallows the error and returns 0). Migrations that add values: `20260694000000` (8 finance + 6 order),
  `20260731000000` (15 asset), `20260802000000` (11 asset/access), `20260824000000` + `20260825000000` (attendance/payroll issue raised/reviewed), `20260921000000`
  (`pi_exception_requested/approved/rejected`), `20261119000000` (`pi_revision_proposed/approved/rejected`), `20261202000000` (`order_update_status/amended/production/payment`),
  `20261206000000` (`customer_review_submitted/reapplied`), `20261229000000` (`order_operations_review_requested/decided`), `20270112000000`
  (`order_document_review_requested/decided`), `20270215000100` (`attendance_request_submitted/decided`), `20270314000000` (`inventory_booking_requested/decided`).
  Base task values (not in migrations): `task_acknowledged` (generic, meaning in the title), `task_assigned`, `overdue`, `escalation`, `stale_flag`, `morning_digest`,
  `evening_digest`.
- `entity_id` is a uuid: `''` is a malformed uuid and fails the whole INSERT (22P02) for every recipient; `normalizeNotificationEntityId` in `src/lib/assets/assetNotifications.ts` is the chokepoint.
- `notifications_event_once_idx` (`20270301000000`): partial UNIQUE index on `(activity_log_id, user_id, type) WHERE activity_log_id IS NOT NULL`. The migration counts duplicate groups first and
  RAISES (deletes nothing) if any exist; creating the index blocks writes briefly (no CONCURRENTLY inside a migration transaction). `isEventAlreadyAnnounced` treats 23505 naming the index as success.
- `run_task_health_check()` (hourly pg_cron) wrote ~16k `overdue`/`escalation` rows with no dedupe until `20261015000000` removed the inserts (activity-log writes kept). Rows remain in the table, hidden by the read rule.
- Announcements deliberately live outside this table (`20270110000000` does not touch `notifications` or the enum).
- RLS idea: a client may not insert a row addressed to someone else; cross-user rows are written by service-role routes or SECURITY DEFINER functions. Immutability: enum additions are forward-only
  (Postgres cannot drop enum values).

## 5. Permissions & access

- Every list/count/mark/delete route is scoped `.eq('user_id', <subject>)` where the subject is the caller, or the previewed employee for a READ under View As.
  All four write paths refuse a declared preview (header `x-boe-view-as`) with 403 `PREVIEW_WRITE_REFUSED`. Reading someone else's feed requires an eligible active admin (`resolveViewAsSubject`).
- `canReadNotificationCategory` + `ADMIN_ONLY_CATEGORIES` (currently EMPTY array; kept so the next admin-only feed is a one-word change) is applied in every route. An invalid `category`
  returns 400 (a typo must not silently route into the task feed); absent defaults to `task`.
- `/api/notify-status-update` authorization: caller must be the task's creator or assignee (checked BEFORE the requested recipient/action are read), recipient must be the OTHER party, the
  headline is composed server-side from the stored task and `users.full_name` resolved by `auth.uid()`; failures return a bare 403 and log `{caller, taskId}` (route is not a task-id oracle).
- Module-side notify routes use the service role, resolve recipients on the server (admins by role, or holders of a permission through `users_with_module_permission(module, action)`), skip the actor, and dedupe.

## 6. Business rules

Feed selection (`src/lib/notifications.ts`, one function `getNotificationCategoryFilter` shared by list, count, mark-read, delete-all):
- `task`: structural `task_id IS NOT NULL` (NOT a title whitelist any more). All other categories: explicit `type.in.(...)` lists (`FINANCE_`, `ORDER_`, `ASSET_`, `ATTENDANCE_PAYROLL_`,
  `REVIEW_`, `INVENTORY_NOTIFICATION_TYPES`). Feeds are disjoint (a test asserts it).
- Every category also applies `.not('type','in', SYSTEM_TYPE_EXCLUSION)` = `escalation, overdue, stale_flag, morning_digest, evening_digest`. `asset_warranty_expiring` is scheduled but
  actionable and is deliberately kept (`ACTIONABLE_SCHEDULED_NOTIFICATION_TYPES`). Every writer goes through `insertUserNotifications(client, rows, {actorId})`
  (`src/lib/notificationWrites.ts`): drops system-type rows (`partitionSystemNotifications`), drops rows addressed to the actor (self-suppression), treats event-unique violation as success.
- Task feed silence rules (September 2026, `src/lib/notifications/taskNotificationPolicy.ts`; enforced at write AND read): (a) quotation requests are silent EXCEPT how they end (Oct 2026): the assignee completing one notifies its CREATOR, and an admin cancelling one notifies the creator (never the assignee; the creator cancelling their own request tells nobody). Quotations are identified by `tasks.task_type`, joined via
  `tasks!inner(task_type)`; (b) creator APPROVAL is silent (title suffix `approved and completed task` plus `transition_task_review` stopped inserting it in `20261212000000`);
  submitting still notifies the creator, returning/reopening still notifies the assignee; (c) a NEW task never notifies the assignee (`shouldNotifyTaskAssignment` returns false;
  read side hides `type='task_assigned'`). `shouldNotifyTaskStatusEvent(task, action, recipientId)`: for a quotation true only for `completed` addressed to `created_by`; false for a `completed` event on a delegated task; `cancellationRecipient()` picks who `/api/cancel-task` tells (assignee, or creator for a quotation). Old rows stay in the table, hidden; they can neither fill a
  page nor hold a badge up because the exclusion is applied BEFORE paging/counting. READ SIDE OF THE QUOTATION EXCEPTION: PostgREST cannot OR a task column with a notification column (its parser rejects an embedded column inside a top-level `or`; verified on PostgREST 12), so the Task feed is TWO plain queries - ordinary tasks (as before) and quotation rows whose title matches `QUOTATION_NOTICE_TITLE_FILTER` (`*completed task`, `Task completed`, `*cancelled a task`, `Task cancelled`) - counted together, merged newest-first (`mergeNewestFirst`, each side `LIMIT n+1`) and unioned for Mark all read / Delete all. Titles are pinned to the two writers by `taskNotificationPolicy.test.ts`. Old quotation completion notices written before Sept 2026 can reappear (owner accepted). Two `or` params in one query are ANDed (verified).
- Paging: `NOTIFICATION_PAGE_SIZE = 50`, `NOTIFICATION_MAX_ROWS = 200` (each "Load older" adds 50); the list requests `limit+1` rows to compute `hasMore`; ordering `created_at desc, id desc` (id tiebreak because batch inserts share a timestamp).
  Mutations are chunked: `MUTATION_ID_CHUNK_SIZE = 200`, `MUTATION_CONCURRENCY = 4`, `VISIBLE_ID_PAGE_SIZE = 1000` (PostgREST cap), `delete-selected` capped at `MAX_IDS = 200`.
- Dedupe windows: finance and orders notify routes skip a row identical for the same recipient within 2 minutes; `/api/orders/submissions/notify` the same (2 min on entity+type); task/status events by the unique index.
- Presentation: `getNotificationMeta(n)` (`src/lib/notificationMeta.ts`) is the single place that returns heading/badge/href/actionLabel; `entity_id` carries the record id for deep links (finance
  `?request=`/`?payment=`, orders -> Order or PI Draft page, `pi_exception*` -> `/orders/drafts/<submission>`). Task rows keep the actor sentence in `title` and the task title in `body`; with
  `activity_log_id` the card can show the real comment preview and previous status; one `note_added` row serves comments, files, or both (`activityHeadings.ts`).
- Caches: list keys `['notifications', <category>]` (staleTime 30 s, gcTime 2 min), counts `['notifications','count']` (task, historic) and `['notifications','count',<category>]` (30 s); keys all come from
  `notificationKeys` in `src/lib/notificationCache.ts` (TanStack matches by prefix: invalidating `['notifications']` fans out to every list and count). Persisted last-known counts
  (`src/lib/notificationCountCache.ts`, localStorage key `boe.notif-count.v1.<userId>.<category>`, max age 7 days) seed the badge on first paint through `initialData` + `initialDataUpdatedAt`
  (the seeded value's own timestamp, so the 30 s stale rule still triggers revalidation); only version, count and time are stored, never content; cleared on sign-out/identity change.

## 7. Key components & lib files

`src/lib/notifications.ts`, `notificationMeta.ts`, `notificationWrites.ts`, `notificationAccess.ts`, `notificationPaging.ts`, `notificationCache.ts`, `notificationCountCache.ts`, `notificationMutations.ts`,
`notify.ts` (client fire-and-forget helpers), `src/lib/notifications/{taskNotificationPolicy,pageEnrichment,grouping,eventPresentation,statusEventNotice,activityLink}.ts`,
`src/lib/tasks/{assignmentNotification,assignmentNotificationWriter.server}.ts`, `src/hooks/queries/{useNotifications,useUnreadNotifications,useNotificationMutations}.ts`,
`src/components/notifications/{NotificationsView,NotificationRow,NotificationTaskGroup,NotificationListSkeleton}.tsx`, `src/components/layout/{NotificationsNavItem,IssueNotificationBell}.tsx`,
`src/lib/assets/assetNotifications.ts`.

## 8. Decisions made & why

- One shared table with type-prefix lists for modules and a structural `task_id` rule for tasks (task meaning lives in the title because all task activity shares enum type `task_acknowledged`).
- System-generated rows (cron observations nobody can act on) are suppressed at write and read; actionable scheduled reminders stay.
- Quotation requests, approvals, and new-task assignment are silent by owner decision (Sept 2026); Oct 2026: a quotation's completion and admin cancellation tell its creator (sales) only.
- Finance/Orders notifications reuse the shared table (not a dedicated one); Sample Tracking keeps its own system.
- Counts persist locally so a badge is never blank after a hard refresh; no notification content ever reaches localStorage.
- View As: a preview may read but never mutate the previewed employee's inbox.
- Notification failure must never roll back the business action (suppressed rows are no-ops; routes report their own failure).

## 8b. Orders notices written by the database (20270321000001)

Triggers on `order_activity_log`, `order_approval_events`, `order_change_requests`, `order_submissions` (deferred constraint trigger), `orders` (insert from a PI) and `order_operations_handoffs` insert notifications in the same transaction as the activity, through `order_notify_users` (never the actor, never inactive/deleted, no same type+record+person within 2 minutes) and `order_update_recipient_ids` (the configured recipients). The browser routes (`/api/orders/[id]/notify`, `/api/orders/submissions/notify`, `/api/finance/notify`) still exist; the 2-minute rule on both sides keeps them from doubling. Payment-submitted notices stay browser-sent (a database trigger at insert time would fire before a self-verified payment completes).

`order_submission_review_notify()` (restated in 20270328000100, APPLIED 2026-10-21) now also notifies `order_submissions.salesperson_id` on needs_changes / rejected. `pi_review_decided` is one type for both outcomes, so `getNotificationMeta` picks the badge from the title ("Changes were requested…" amber, "…was rejected" red).

## 9. Known traps / gotchas / unfixed defects

1. **FIXED 2026-10-19 (code only): these types are now in `ORDER_NOTIFICATION_TYPES` and filed under Orders by `getNotificationMeta` (test `hiddenOrderTypes.test.ts`). Original note:** Some written types are not in any feed list. `pi_exception_requested/approved/rejected`, `pi_revision_proposed/approved/rejected` and
   `order_document_review_requested/decided` are written (by `/api/orders/submissions/notify` and by `20270112000000` triggers) and described by `getNotificationMeta`, but
   `ORDER_NOTIFICATION_TYPES` does not contain them, and the Orders feed is a strict `type.in.(...)`. Such rows would not appear in `/orders/notifications` nor in its unread badge. Check with
   `select type,count(*),count(*) filter (where not is_read) from notifications group by 1;`. Fix = add them to `ORDER_NOTIFICATION_TYPES` (code only) and update the tests that assert the list.
2. **FIXED by 20270321000000 (enum values added). Original note:** `pi_correction_requested/resolved/rejected` are inserted as `type` by `/api/orders/submissions/notify` but NO migration adds them to `notification_type`.** The
   insert would fail with an enum error unless the values were added outside migrations; the client helper `notifyPiSubmission` only returns a boolean.
3. The test titled "Orders selects exactly its own six types" now compares against the constant (12 entries); the title is stale.
4. Memory said the Task feed is title-whitelisted; the code now selects `task_id IS NOT NULL` and relies on `SYSTEM_TYPE_EXCLUSION` as the ONLY thing keeping cron rows out. Never drop that chain
   from list, count, mark-all-read or delete-all.
5. Adding a query to `pageEnrichment.ts` breaks four source-contract tests by design: `pageEnrichment.test.ts` ("select names exactly the columns", "18. query count is bounded"),
   `commentPreviewDelivery.test.tsx` "15b", `NotificationHeaderPolish.test.tsx` "17".
6. Six tests pin `/api/notify-status-update`'s source strings (module 11 trap 5).
7. Migration order matters for enum additions: the migration must be APPLIED before the code that names the value ships (merge to main = deploy). An enum label cannot be used in the transaction that adds it.
8. `activity_log_id` unique index will RAISE if duplicates exist; the migration will not delete anyone's notices.
9. Admin recipients: with effectively one active admin, events addressed to "admins" produce nothing when that admin is the actor (actor exclusion wins) - looks like a bug while testing.
10. `entity_id: ''` fails the whole batch (22P02).
11. `notifications.task_id` is a real FK to tasks; module rows leave it null (use `entity_id`). The `task` category uses `task_id` to decide membership - a module row must never set `task_id`.
12. First-visit gap on `/notifications` was one slow 12 KB JS chunk (4.78 s on a protected preview), not reproduced on production (memory).
13. Enrichment embeds people through foreign keys (`assignee:assigned_to(full_name)`, `creator:created_by(full_name)`, `actor:actor_id(full_name)`) - merged (#163, verified in `pageEnrichment.ts`); memory still calls #163 OPEN.
14. Persisted counts are keyed by user id and category; never persist content.
15. **Task pages are warmed on INTENT only (2026-10-21).** The load-time `router.prefetch` of the first twelve tasks (and the `<Link>` viewport prefetch on each card title) is gone: each warm-up brought the Task page stylesheet, which Chrome preloaded and `/notifications` never applied ("preloaded but not used"), and it added up to 3 RSC requests per task. `NotificationsView` owns `warmTask`; `NotificationTaskGroup` takes an optional `onWarmTask` and calls it on pointer-enter/focus/touch-start of the title link (`prefetch={false}`). The card must not call `prefetch(` itself (`interactionCost.test.ts` matches `/fetch(/`). Guard: `src/lib/notifications/notificationsIntentPrefetch.test.ts`. The reported 5-6 s hang was NOT reproduced on production (about 1 s warm); whether this removes it on slow connections is unmeasured.

## 10. Tests that guard it

`src/lib/notification*.test.ts` (Cache, CountCache, BulkPartialFailure, Mutations, SelfNotify, SystemActivity, `notificationsPagePerformance`), `src/lib/attendancePayrollNotifications.test.ts`,
`src/lib/notifications/*.test.ts` (21 files: `taskNotificationPolicy` via `taskFeedExclusion`, `taskGroupScope`, `eventIdempotency`, `newTaskAcknowledgmentFlow`, `notifyStatusUpdateAuthority`,
`notificationsRouteWaterfall`, `pageEnrichment`, `grouping`, `groupMutations`, `driftGuardCatalogue`, `activityLinkMigration`, `systemActivityLabels`, `interactionCost`, `commentPreviewDelivery.test.tsx`),
`src/app/api/notifications/routeBehaviour.test.ts` (fixture must use a VISIBLE type; `task_assigned` is hidden by design), `src/lib/sampleNotificationDeletes.test.ts`,
`src/lib/tasks/{copyTaskNotification,assignmentWriteAuthority,taskAssignmentRegression}.test.ts`. Run `npx tsx --test src/lib/notification*.test.ts src/lib/notifications/*.test.ts`.

## 11. Open items / next planned work

- Resolve trap 1 and trap 2 (feed lists and the missing enum values) after checking production data.
- First-load latency of `/notifications` (3.08 s server stages measured on a preview before hnd1; post-hnd1 numbers 0.53-0.63 s from #321).
- Production effect of the merged FK-embed enrichment (#163) was never measured (memory).

## 12. Recheck before changing this module

Read: `src/lib/notifications.ts` (header comments), `src/lib/notificationWrites.ts`, `src/lib/notifications/taskNotificationPolicy.ts`, `src/app/api/notifications/route.ts`, `src/lib/notificationMeta.ts`,
`20260694000000`, `20261016000000`, `20270301000000`, and the migration that adds your type. Queries (read-only): `select enum_range(null::notification_type);`, `select type,count(*) from notifications group by 1 order by 2 desc;`,
`select indexname from pg_indexes where tablename='notifications';`. To add a type: migration (alone, applied first) -> add to the right `*_NOTIFICATION_TYPES` list -> `getNotificationMeta` badge/href -> writer route/RPC ->
update the exact-list tests. Run the notification tests, `tsc`, lint.

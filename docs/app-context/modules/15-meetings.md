# 15. Meetings

Verified against checkout `852e0493` (origin/main, 2026-10-18). Items marked "(unverified, from memory)" could not be confirmed on this checkout.

## 1. Purpose & users

- Structured order-review meetings: BOE runs two recurring reviews, "New Order Review" and "Repair Order Review". The team walks order by order and SKU by SKU, records what moved since last time, sets the next follow-up date or turns the discussion into a task.
- Added later: an "order discussion" workflow (issues that live across meetings, with evidence photos), a Meeting Inbox, an in-app guide, spreadsheet import, and PI-workbook import.
- Roles (by permission, not role): attendee/employee (`view`), organiser (`create`), conductor (`edit`), manager (`manage`: sees every meeting, completes/reopens), `delete`, `export`. Admin bypasses the engine in the UI capability derivation.
- Not a general meeting-management tool: no agenda engine, minutes, recurrence, calendar, audio, AI summaries; `order_number` is free text (Meetings owns no order master; production had 0 meeting order numbers matching `orders.display_number` on 2026-09-11, from memory). Continuity across meetings keys on `meeting_orders.order_number_key`.

## 2. Status at commit 852e0493

- SHIPPED: base module (`20260814000000`), select-policy fix (`20260815000000`), PI import columns/bucket/functions (`20260831000000`, applied long before the UI; UI shipped #308 `3e9a943c` 2026-10-14), evidence (`20261203000000`, PR #146), order-discussion workflow + guide + Inbox (`20261213000000`, PR #164, squash `96475c9e`, applied to prod 2026-09-17).
- NOT ON THIS CHECKOUT: `20261214000000_meetings_rpcs_require_module_entry.sql` (module-entry guard for write RPCs). `ls supabase/migrations | grep 202612` shows no such file and the only module-entry check in meetings SQL is in the `20261213` discussion functions. Memory says it was a local-only branch `fix/meetings-rpc-module-entry`, and "Meetings guard fix is draft PR #310" (unverified, from memory; not merged here). So the defect it fixes is UNFIXED at this commit (see section 9). **RESOLVED 2026-10-18:** shipped as `20270319000000_meetings_rpcs_require_module_entry.sql` (PR #310, `40270642`), applied to production; both guards now check `module_entry_open('meetings')`. The text below is the historical description.
- Production meeting data left by test (from memory, 2026-09-18): stale drafts of 12 Aug and 18 Aug and a "ZZ TEST - Repair Order Review ... safe to delete" meeting were deliberately kept; deletion is the owner's decision.
- Production state of discussion/evidence rows at last check (2026-09-18): 0 (from memory).

## 3. Pages and API routes

Pages (`src/app/meetings/`), sidebar `src/components/layout/MeetingsLayout.tsx`:

| Route | Nav label | Screen |
|---|---|---|
| `/meetings` | Active & Upcoming | `MeetingsListScreen.tsx` |
| `/meetings/follow-ups` (`?due=today` / `overdue`) | Due Follow-ups, Overdue | `follow-ups/FollowUpsScreen.tsx` (lib `followUps.ts`) |
| `/meetings/completed` | Completed | list |
| `/meetings/inbox` | Meeting Inbox | `inbox/MeetingInboxScreen.tsx` |
| `/meetings/guide` | How Meetings Work | `guide/MeetingGuide.tsx`, copy as data in `guide/guideContent.ts` (guide test asserts claims against constants and migration SQL) |
| `/meetings/[id]` | (detail) | `[id]/MeetingWorkScreen.tsx` |

The guide and Inbox are NOT in the Modules launcher or Tasks nav (from memory); they are Meetings sidebar entries.

API routes (`src/app/api/meetings/`):

| Route | Method | Purpose |
|---|---|---|
| `template` | GET | blank spreadsheet import template (export permission) |
| `import` | POST | parse spreadsheet, writes nothing (preview + failed rows); `MAX_BYTES` 5 MB, `MAX_ROWS` 2000; browser then calls `import_meeting_rows` RPC which re-validates |
| `import-pi` | POST | parse a BOE Proforma Invoice workbook -> PREVIEW only; writes nothing, workbook never stored; never reads a price or total |
| `import-pi/confirm` | POST (`maxDuration = 60`) | re-parses the file (never trusts a client preview), `import_meeting_rows()` atomically, then uploads de-duplicated photos, then `set_meeting_item_image_path()`; runs AS THE CALLER with the user's token (RLS applies) |

PI import limits: `PI_MAX_BYTES` 10 MB; sheet name `Master`, PI number cell `B20`, header row 31, first product row 32, image column 4, scan to row 400 (`src/lib/meetings/piImport.ts`). Authorizer `authorizePiImporter` (`piRequest.ts`) needs signed-in, active, and Meetings edit/manage (or admin). Not the boundary: the RPCs re-check per meeting.

## 4. Database

Tables:

| Table | Notes | Migration |
|---|---|---|
| `meetings` | `meeting_type` in (`new_order`,`repair_order`); status draft/in_progress/completed; `lead_id` NOT NULL; completion-consistency CHECK; trigger `meetings_prevent_delete_with_content_trg` | 20260814 |
| `meeting_attendees` | references `public.users` | 20260814 |
| `meeting_orders` | `order_number_key` = generated `upper(btrim(order_number))`, UNIQUE (meeting_id, order_number_key); position in on_track/attention/at_risk/closed; order_type | 20260814 |
| `meeting_order_items` | SKU line; `sku_key` generated; status open/waiting/resolved; `quantity numeric(12,2) >= 0`; + `dimensions`, `spec_note`, `image_path` (nullable) | 20260814 / 20260831 |
| `meeting_update_history` | APPEND-ONLY, no UPDATE/DELETE policy; insert only via definer functions | 20260814 |
| `meeting_activity_log` | APPEND-ONLY lifecycle trail (created/started/completed/reopened) | 20260814 |
| `meeting_order_evidence` | evidence images on an order; later `discussion_appearance_id` | 20261203 / 20261213 |
| `meeting_discussion_items` | the issue for life; `category` in (`running_order`,`after_sales`); `after_sales_tag` (repair/replacement/site_issue/other) only for after_sales; `state` open/resolved; resolution fields CHECK-consistent; unique open-per-task index | 20261213 |
| `meeting_discussion_appearances` | issue x meeting, UNIQUE (meeting_id, discussion_item_id); `agenda_position > 0`; `placement` manual/automatic | 20261213 |
| `meeting_discussion_events` | append-only trail; UNIQUE index so a task link is recorded once | 20261213 |

Key functions: `can_view_meeting`, `can_edit_meeting`, `assert_meeting_editor` (20260814); `record_meeting_history`, `record_meeting_activity`, `add_meeting_order`, `save_meeting_order_update`, `remove_meeting_order`, `add_meeting_order_item`, `save_meeting_item_update`, `link_meeting_item_task`, `set_meeting_status`, `import_meeting_rows(uuid, jsonb)` (idempotent: matches order on (meeting_id, order_number_key) and item on (meeting_order_id, sku_key)), `set_meeting_item_image_path`; evidence: `meeting_evidence_path_recorded`, `add_meeting_order_evidence`; discussion (20261213): `assert_meeting_discussion_access` (auth + `module_entry_open('meetings')`, called first by every callable discussion function), `assert_meeting_discussion_editor`, `capture_meeting_discussion_item`, `attach_meeting_discussion_item`, `save_meeting_discussion_update`, `resolve_meeting_discussion_item`, `reopen_meeting_discussion_item`, `link_meeting_discussion_task`, `ensure_meeting_discussion_order`, `add_meeting_discussion_evidence`, `apply_meeting_discussion_carry_forward`, `carry_forward_meeting_discussions`, `list_meeting_discussion_inbox()`, `can_view_discussion_item`, `can_view_discussion_event`, `meeting_discussion_category_for_type` (revoked from clients); triggers `meetings_carry_forward_discussions_trg` (AFTER INSERT on `meetings`), `meeting_discussion_appearance_order_in_meeting_trg`, `meetings_prevent_delete_with_discussion_trg`, `*_set_updated_at`.

RLS idea: `meeting_orders` and `meeting_order_items` have NO UPDATE and NO DELETE policy for anyone, admins included; every mutation goes through SECURITY DEFINER functions that write row + history in one transaction. SELECT through `can_view_meeting()`. 20260905 added RESTRICTIVE `module_entry_open('meetings')` gates on tables (those do NOT reach SECURITY DEFINER RPCs). Discussion tables get their own `*_module_entry_gate` policies.

Storage buckets (private): `meeting-product-images` (20260831; PI product photos; select/insert/delete policies; its DELETE policy lets editors erase objects), `meeting-evidence` (20261203; `file_size_limit` 10485760; JPG/PNG/WEBP only; DELETE only for unrecorded objects via `meeting_evidence_delete_unrecorded`; path pattern `<orderUUID>/<UUID>.(jpg|png|webp)`).

Migrations: `20260814000000_create_meetings_module`, `20260815000000_fix_meetings_select_policy`, `20260831000000_meeting_pi_import`, `20261203000000_meeting_order_evidence`, `20261213000000_meeting_order_discussion_workflow`. Apply state (from memory): 20261203 applied before merge; 20261213 applied 2026-09-17 10:15Z (ledger 261). Verify with `supabase migration list --linked`.

## 5. Permissions & access

- Module key `meetings`; actions `view`, `create`, `edit`, `delete`, `export`, `manage` (registered in `src/lib/permissions/modules.ts`, capabilities derived in `src/lib/permissions/meetings.ts`).
- `view` = ENTER the module, NOT see every meeting. Meetings are visible if you led/created/attended them; `manage` sees every meeting and completes/reopens. `create` = schedule; `edit` = conduct (updates, follow-ups, tasks); `delete` = discard an empty draft; `export` = template + export.
- Layout guard `src/app/meetings/layout.tsx`: admin role OR `hasPermission(view)` OR `hasPermission(manage)` (note: unlike Review Workflow, this guard reads `users.role === 'admin'` first). UI guard is the weakest layer; RLS and definer guards are the boundary.
- Discussion rules: "Add to Meeting" from Task Detail limited to creator/assignee/admin (rule in `src/lib/tasks/addToMeetingAccess.ts`, because the Task page may not import `lib/meetings` - `discussionFlow` test forbids it). Notes follow the meeting: `can_view_discussion_event` per trail row; `resolution_note` column is not granted to clients; edit/manage holders see only Inbox items (not other meetings' notes).
- Module-entry gap: see section 9.

## 6. Business rules

- Meeting types: `new_order`, `repair_order`. Title generated from type + date, freely editable afterwards (stored).
- Statuses: meeting draft -> in_progress -> completed (reopen allowed for manage; `completed_at` fields CHECK-consistent). Item status open/waiting/resolved; order position on_track/attention/at_risk/closed. An "issue" on an item is a blocker and drives a completion warning.
- Updates are never lost or rewritten (history append-only).
- Cannot remove an order that has recorded updates, tasks, or evidence (`MEETING_ORDER_HAS_HISTORY/TASKS/EVIDENCE`). Cannot delete a meeting with ANY order row (`meetings_prevent_delete_with_content`) or any discussion appearance (`meetings_prevent_delete_with_discussion_trg`).
- Evidence: max 10 MB per image (`MEETING_EVIDENCE_MAX_BYTES`, must equal the bucket limit), JPG/PNG/WEBP, up to 6 per save (`MEETING_EVIDENCE_MAX_PER_SAVE`), signed URL TTL 1 hour; oversize images are client-reduced first; duplicate image refused.
- Discussion model: an issue (`meeting_discussion_items`) lives for life, only Open/Resolved. Categories `running_order` (maps to new_order meetings) and `after_sales` (maps to repair_order), mapping enforced by `meeting_discussion_category_for_type` on attach and capture. After-sales tags: repair, replacement, site_issue, other.
- Carry-forward: AFTER INSERT trigger on `meetings` copies open items into the new meeting (idempotent via UNIQUE + `ON CONFLICT DO NOTHING`). Inbox is not a table: an open item with no appearance IS the Inbox; Inbox items only enter meetings dated >= the raised date (IST).
- The `meeting_orders` row for a discussion item is created LAZILY (first evidence upload via `ensure_meeting_discussion_order`), never during carry-forward, because eager rows would make every new draft undeletable.
- A reopen clears `resolved_at/_by/_note` (CHECK forces it); the original resolution survives only in the events table (same pattern as `meetings.completed_at`). Clearing a Decision uses `p_clear_decision`.
- Add to Meeting offers only editable live meetings dated >= IST today (`captureTargetMeetings`, `captureTargetId`), default nearest upcoming else the Inbox, never a past meeting (fix `5b36fc8b`).
- Completed meetings replay events up to `completed_at` (`stateInMeeting`) and show "Now X" beside.
- Undo was removed from capture (Resolve must never stand in for withdrawal).
- PI import: the workbook is never stored; photos are content-addressed (retry overwrites in place), cleanup only removes objects this run created; confirming the same PI twice UPDATES the same order. `spec_note` deliberately not stored in `issue`. `material_spec` column deliberately NOT created (no evidenced source).
- No "15-minute Crisp meeting" timer exists in BOE (owner's brief assumed it; nothing built).

## 7. Key components & lib files

- `src/lib/meetings/`: discussion.ts (types, labels, filters), discussionReads.ts, evidence.ts, status.ts, followUps.ts, history.ts, orderHistory.ts, activity.ts, import.ts (spreadsheet), piImport.ts, piWorkbook.ts, piRequest.ts, taskCapture.ts, taskDraft.ts, errors.ts (strips `MEETING_FORBIDDEN:`), types.ts.
- `src/components/meetings/`: MeetingBoard, DiscussionBoard, DiscussionWorkspace, DiscussionModals, DiscussionTaskModal, OrderDiscussion, MeetingOrderModals, ItemUpdateModal, EvidenceThumbs, MeetingItemMedia, MeetingImportModal, CompleteMeetingModal, MeetingFormModal, MeetingTaskModal, MeetingHistoryModal, MeetingActivityModal.
- CSS: Meetings block in `globals.css` must sit BEFORE the `PI DETAIL` block (see traps).

## 8. Decisions made & why

- `meeting_discussion_items` introduced because `meeting_orders` is one order in one meeting and cannot represent "this particular repair complaint" (one order carries several independent issues).
- Evidence uses a NEW bucket `meeting-evidence` rather than `meeting-product-images` because the latter's DELETE policy lets editors erase objects.
- Notes follow the meeting (owner decision 2026-09-16): resolved/other-meeting text not visible to people who cannot open that meeting.
- Add to Meeting only creator/assignee/admin (owner decision).
- Lazy `meeting_orders` creation; Inbox is a derived view.
- Stale test meetings kept in prod pending owner decision.
- PI import re-parses the file on confirm (no trust in client preview) and runs as the caller, not service role.

## 9. Known traps, gotchas, unfixed defects

- UNFIXED on this checkout: `assert_meeting_editor()` and `can_edit_meeting()` (`20260814000000`) never check `module_entry_open('meetings')`. A user whose Meetings `view` was removed but who is lead/creator or holds `edit`/`manage` can still call the Order-rail write RPCs (add/save/remove order, add/save item, link item task, set status, import rows, set_meeting_item_image_path). Memory measured 64 refusal gaps (from memory). The fix `20261214000000` is not on main here. The discussion RPCs (20261213) ARE guarded by `assert_meeting_discussion_access()`. **RESOLVED 2026-10-18:** shipped as `20270319000000_meetings_rpcs_require_module_entry.sql` (PR #310, `40270642`), applied to production; both guards now check `module_entry_open('meetings')`. The text below is the historical description.
- plpgsql: multi-target `SELECT ... INTO` takes scalar targets only (composite OUT params fail at call sites). `pg_get_function_identity_arguments()` returns parameter NAMES on this stack.
- JS `String.replace` converts `$$` to `$` in SQL: use split/join when generating SQL.
- CSS-append trap: `piDetail.render.test.tsx` `pageCss()` slices globals.css from its heading to EOF; a Meetings CSS block appended after it is judged by PI rules. Put new CSS before `PI DETAIL`.
- PI thumbnail/spec edits must go on BOTH `ItemRow` (desktop) and `ItemCard` (phone).
- Adding any migration breaks about 10 ledger-allowlist tests (`customerReviews/migration`, `finance/participantAndOrderTotalSecurity` x2, `orders/orderReservedPiGateAndBoeItemCodes`, `boeCredits/reviewReward`, `tasks/healthCheckMigrationAudit`, `tasks/topTasksApproval`, `notifications/activityLinkMigration`, `notifications/groupMutations`, `orders/orderFinanceTestReset`, `tasks/assignmentWriteAuthority`). Each wants the filename plus a line saying why it is unaffected.
- No generated Supabase types in the repo: hand-maintained column lists in `discussion.ts` (`MEETING_DISCUSSION_*_COLUMNS`) checked against the schema; `resolution_note` must never be selected (42501).
- Vercel previews stall about half the time (from memory); a worktree dir cannot be removed while the shell cwd is in it.
- PI import must never be merged into an old checkout that already merged: the WIP branch `feat/task-creator-approval` conflicts (23 conflicts) (from memory).
- Residual of the missing guard fix: RPCs that SELECT a row before the guard still reveal "missing" for bogus ids (from memory).
- Production DB is Tokyo, functions run in `hnd1` since #321; unrelated to Meetings correctness but affects timings.

## 10. Tests that guard it

Run: `npx tsx --test src/lib/meetings/*.test.ts` (on Windows with bracket paths use the glob workaround in memory `tsx-test-bracket-path-glob`).
- `src/lib/meetings/`: activity, discussion, discussionFlow (forbids Task page importing lib/meetings), discussionSchema, evidence, evidenceSchema, followUps, history, import, orderDiscussionFlow, orderHistory, piImport, schemaGuards, status, taskCapture, taskDraft. Guide render test (`guide.test.tsx`, asserts guide copy against constants and migration).
- SQL: `supabase/tests/meeting_discussion_workflow_assertions.sql` + `run_meeting_discussion_workflow_local.sh` (disposable stack `boe-meetings-disposable`, ports 583xx; needs `db reset --no-seed` plus re-mark comment before each run; applies the migration twice, runs 23-30 scenarios twice; section 30 enumerates callable functions from the catalogue and probes them with a lead and an edit-holder lacking `view`). Do not run against production.
- Tests that must not rely on a Meetings module-entry migration: moduleEntryGuard test exists only on the unmerged branch (unverified).
- Windows: ports 573xx are excluded; local stacks use 583xx/593xx.

## 11. Open items / next planned work

- Land `20261214` module-entry fix for the Order-rail RPCs (draft PR #310 per memory, unverified) and apply it. **RESOLVED 2026-10-18:** shipped as `20270319000000_meetings_rpcs_require_module_entry.sql` (PR #310, `40270642`), applied to production; both guards now check `module_entry_open('meetings')`. The text below is the historical description.
- Decide cleanup of stale prod meetings (12 Aug, 18 Aug drafts, "ZZ TEST").
- Deferred from #146: evidence void/correction flow, later-meetings indicator, Orders link.
- Unmerged WIP (old checkout commit `2102e980`): a cut of the Meetings sidebar to two entries; NOT carried over (would drop Inbox and Guide).
- Perf advisor notes (INFO) on discussion indexes (from memory).

## 12. Recheck before changing this module

- Read: `supabase/migrations/20260814000000_create_meetings_module.sql` (guards at lines ~351-470), `20261213000000_meeting_order_discussion_workflow.sql`, `20260831000000_meeting_pi_import.sql`, `src/lib/permissions/meetings.ts`, `src/app/meetings/layout.tsx`, `src/lib/meetings/discussion.ts`, `piImport.ts`, `evidence.ts`.
- Query: `supabase migration list --linked`; check whether `20261214` exists on main (`ls supabase/migrations | grep meetings_rpcs`); `select proname, prosrc from pg_proc where proname in ('assert_meeting_editor','can_edit_meeting')` against the dump. **RESOLVED 2026-10-18:** shipped as `20270319000000_meetings_rpcs_require_module_entry.sql` (PR #310, `40270642`), applied to production; both guards now check `module_entry_open('meetings')`. The text below is the historical description.
- Run: all `src/lib/meetings/*.test.ts`, the ledger-pin tests above (if you add a migration), `piDetail.render.test.tsx` (if you touch globals.css), and the local SQL runner.
- Keep: both desktop (`ItemRow`) and phone (`ItemCard`) renderings in sync; never select `resolution_note` from the client.

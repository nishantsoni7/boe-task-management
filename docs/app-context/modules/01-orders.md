# Module dossier 01 — Orders (PI Drafts, Confirmed Orders, PI versions, handoff, documents, deletion)

Verified against the checkout at commit `852e0493` (main, 2026-10-18). Sources: code, `supabase/migrations/*.sql`,
`docs/`, and the auto-memory notes. Anything not verifiable on this checkout is marked **(unverified, from memory)**.
"Applied" below always means "applied to the production database" and can NOT be proven from a checkout: the only proof is
`supabase migration list --linked` with a non-empty `remote` column. Companion dossier: `02-finance.md` (payments, allocations,
expenses). Where a rule lives in both, the database function named here is the authority.

Naming used here: **PI Draft** = a row in `order_submissions` (any status). **Confirmed Order** = a row in `orders`, created only
by `approve_order_submission()`. "Owner" = the single owner/administrator account (employee_code `TEST-001`).

---------------------------------------------------------------------------------------------------------------------------

## 1. Purpose and users

The Orders module takes a salesperson's PI workbook (the BOE "Master" Excel Proforma Invoice) through review into a numbered
**Confirmed Order**, then carries the Order through production hand-off, amendments, PI revisions, documents and dispatch.
There is no other way to create an Order (the older Order Request workflow is retired, see 2).

| Who | What they do |
| --- | --- |
| Salesperson (sales team, `orders.create`) | Uploads a PI, fixes the draft, enters internal details (dates, middleman commission, salesperson, lead source, highlight remark), attaches/records payment, submits for review, proposes PI revisions/edits on their own Orders, uploads Design Files / Client PO, records fabric/finish approvals on their own Orders |
| PI approver (`orders.approve_order`, protected, per person) | Reviews PI: sends back, rejects, approves the PI decision, converts to a Confirmed Order, decides PI revisions |
| Advance-exception approver (`orders.approve_advance_exception`) | Decides "reduced advance" requests on PIs and Order-level "production below 40%" exceptions |
| Production authority (`orders.align_production`) | Legacy per-Order alignment; for Orders that have a handoff, alignment is the *result* of the Operations reviewer's acceptance only (see 6.7) |
| Operations reviewer (one person set in Control Center, duty `pi_handoff`) | Accepts / flags each PI version in force; acceptance aligns the Order for production; reviews Design Files / Client PO |
| Operations team (`users.team = 'operations'`) | Sees every Order; may move status running / on_hold / ready_for_dispatch |
| Active administrator (`users.role = 'admin'`) | Amend / cancel Orders, dispatch, approve/reject PI revisions (permission-gated since 20270120), delete PIs and Orders, Test Data Cleanup, number cycle |
| Finance verifier (`finance.approve`) | Verifies payments attached to PIs (see Finance dossier); no direct PI decisions |
| Owner only | Factory Focus selections, Order visibility scopes (via `is_orders_owner()` / `is_permanent_order_approver`) |

## 2. Status at commit 852e0493

| Capability | State | Evidence |
| --- | --- | --- |
| PI upload, server re-parse, draft editor, submit for review | **Shipped** | `/orders/import`, `/api/orders/import/process-draft`, `submit_pi_for_review*` |
| PI review gate (return / reject / approve PI) and Confirmed Order creation | **Shipped** | `approve_pi_review`, `approve_order_submission` (5-arg) |
| 40% advance gate on **Total before GST**, reduced-advance exception | **Shipped** (20270227 changed the base from Grand Total) | `order_advance_*`, `advanceFormula.ts` |
| Order Requests workflow | **Retired** (20261007); `/orders/requests` and `/orders/requests/[id]` show a notice only | `RetiredWorkflowNotice.tsx` |
| PI versions: workbook revision and in-app "Edit PI" revision, admin approval makes the version in force | **Shipped** (20261119, 20270113, 20270115, 20270116) | `order_pi_versions`, `/api/orders/pi-edits`, `/api/orders/pi-revisions/approve` |
| PI-to-operations handoff (acceptance aligns production) | **Shipped** (20261229) | `order_operations_handoffs` |
| Amendments, change requests, cancellation | **Shipped** (20260816–21) | `amend_order`, `cancel_order`, `order_change_requests` |
| Confirmed documents (Excel + PDF) generation | **Shipped** (20260925) | `/api/orders/[id]/documents` |
| Design Files / Client PO submissions (admin then operations review) | **Shipped** (20270112) | `order_document_submissions*` |
| Fabric / finish approval events with ERP screenshots | **Shipped** (20261227) | `order_approval_events`, bucket `order-approval-evidence` |
| Orders dashboard, Factory Focus, visibility scopes, salesperson dashboard | **Shipped** (20270221, 20270228) | `orders_dashboard_summary`, `salesperson_orders_dashboard` |
| Order update notifications (per-category recipients) | **Shipped** (20261202) | `/api/orders/[id]/notify`, `order_notification_recipients` |
| PI delete (draft/needs_changes/submitted/rejected) and **admin Confirmed Order delete** | **Shipped in code** (#317/#318 = 20270315/16; #320 = 20270317). Migration 20270317 apply state **(unverified, from memory: UNAPPLIED when last recorded, 2026-10-17)** | `delete_confirmed_order`, `/api/orders/[id]/delete` |
| Dispatch payment gate (verified payment >= value minus ₹1,000, "dispatch on credit"), void / refund / customer credit, fabric-per-product with label PDF and quantity requests, "Next action" column on PI list, staged payments, Quotation -> PI | **Planned, NOT on this checkout** (owner decisions 2026-09-18; grep finds no code or schema) | see 8 and 11 |
| Quotation requests | **Lives in Task Management** (`/tasks/quotation-requests*`), not Orders | 3.5 |
| Meeting order-discussion hand-off | **Lives in Meetings** (`meeting_orders`, `meeting_discussion_*`), reads Orders only by order-number text | 3.5 |

Dispatch itself is just a status change by an admin (`ready_for_dispatch` -> `dispatched`); nothing checks payment (see 6.8).

## 3. Pages and API routes

### 3.1 Pages (all inside `src/app/orders/layout.tsx`, `OrdersGuard`)

| Route | Purpose |
| --- | --- |
| `/orders` | Dashboard: intervention sections (alignment, advance, due date, fabric/finish, "panic mode"), revenue (admin / `orders.view_all` only), Factory Focus, queue cards (PI Drafts, operations review). Salespersons who are eligible assignees (not admin, not operations) get the personal dashboard (`salesperson_orders_dashboard`) |
| `/orders/drafts` | PI Drafts list |
| `/orders/drafts/[submissionId]` | PI Draft detail: overview, payment status card, payment details dialog with verify (needs `finance.approve`), internal details, advance exception, review actions, deletion |
| `/orders/drafts/[submissionId]/edit-pi` | Edit PI for a draft |
| `/orders/import` | Upload PI workbook (`orders.create`) |
| `/orders/all` | Confirmed Orders list (URL-state: `useListUrlState`) |
| `/orders/[id]` | Confirmed Order workspace (header, health rail, payment position, products, PI sections, handoff/review modals, documents, approvals, history, delete modal). Layout since the 2026-10 Notion pass: header → property summary → attention → Documents with a right rail (Fabric & Finish, Notes, then Payment in `.order-docs-pay`) → Products (full width) → record column (change requests, activity) beside the Commercial breakdown. Styles: the "ORDER DETAIL — NOTION PASS" block at the end of globals.css overrides the original rules by cascade order — keep it last |
| `/orders/[id]/edit-pi` | Propose an in-app PI edit revision on a Confirmed Order |
| `/orders/notifications` | Order notifications |
| `/orders/requests`, `/orders/requests/[id]` | **Retired** notice only |

Nav (`OrdersLayout.tsx`): Dashboard, PI Drafts, Confirmed Orders (no badge on PI Drafts, by decision). Active-item logic: `src/lib/navigation/moduleNav.ts` (`activeOrdersNav`).
Launch-time control surfaces live elsewhere: Control Center (`/admin/control-center` operations reviewer, order-update recipients, visibility scopes, number cycle), `/admin/control-center/test-data-cleanup`, `/admin/control-center/data-management`, Action Queue.

### 3.2 API routes (`src/app/api/orders/**`)

| Route | Method | Auth / purpose |
| --- | --- | --- |
| `import/process-draft` | POST | Session user; `orders.create` via `resolve_permission` (admin passes); owner or admin of the draft. Server re-parses the uploaded workbook, takes a processing lease (`begin_order_submission_processing`), writes via `replace_order_submission_parse` (or `approve_order_pi_revision` for revisions). `maxDuration`-sensitive, 844 lines |
| `pi-edits` | POST | Edit-PI revision: `can_propose_order_pi_edit`, service role only after DB says yes; `propose_order_pi_edit_revision`; also draft-side `update_order_submission_schedule_terms` |
| `pi-edits/photo` | POST | Uploads a product photo for an edit; gated by `can_propose_order_pi_edit` or `can_edit_order_submission`/`can_admin_edit_order_submission` |
| `pi-revisions/approve` | POST | Permission-only (`user_holds_permission(orders, approve_order)`; role admin NOT enough since 20270120); applies the revision under a processing lease |
| `[id]/documents` | POST | `request_order_document_generation` -> claim -> render -> upload -> `complete_order_document_generation`, all in one request (`maxDuration = 60`); no cron |
| `[id]/pi-versions/[versionId]/pdf` | GET | `order_pi_version_detail` RPC as the user; service role only reads rows/pictures afterward |
| `[id]/notify` | POST | `{event}` only; message built server-side from caller's own recent `order_activity_log` row (5-minute window); recipients from `order_notification_recipients` |
| `[id]/delete` | POST | Admin Order delete: `delete_confirmed_order(order, typed number)` then storage sweep; `PREVIEW_WRITE_REFUSED` guard on preview hosts |
| `[id]` | DELETE | **Always 403** with a stale message ("Confirmed Orders are permanent ... cannot be deleted"); see trap T-9 |
| `submissions/delete` | POST | PI delete claim protocol: begin -> storage sweep -> finalize (`begin_order_submission_deletion`, `finalize_order_submission_deletion`, `release_order_submission_deletion`) |
| `submissions/notify` | POST | Events `pi_exception_requested/approved/rejected`, `pi_correction_*`, `pi_revision_*`; recipients by `users_with_module_permission(...)` plus active admins |
| `pi-format` | GET | Serves the approved PI template workbook from `order-files`; admin or `orders.view` |
| `test-data-cleanup`, `test-data-reset` | POST | Admin only (`users.role = 'admin'`, re-checked in route and RPC); durable claim protocols (see 4.6) |

Cross-cutting API facts: every route builds an `authClient` (user session) for permission RPCs and a `service` client only after the DB has authorised; browser never sends storage keys/paths.

### 3.3 Server-side lib that routes depend on
`src/lib/orders/piEditServer.ts`, `submissionFilesServer.ts`, `submissionDeletionBlockersServer.ts`, `testDataResetServer.ts`, `src/lib/pi/*` (parser, workbook reader, drawing anchors, image formats).

### 3.4 PI workbook parsing (`src/lib/pi/masterSheetParser.ts`)
- Sheet name must be `Master`. Header row 31 is fingerprinted (A31 Code, B31 Name, C31 Quantity, D31 "Dimension in inches & Shape", E31 Representative Image, G31 Material, H31 "Cost per piece (INR)", I31 "Total Cost (INR)", K31 Customization). Mismatch = refused (`TEMPLATE_FINGERPRINT_MISMATCH`).
- Product band rows 32-111 (80 slots B001-B080; column J = hidden item sequence). Header cells: B20 source order number, G20 creation date, **G21 Sales Person**, B22 BOE GST, G22 contact number (the **salesperson's** number), B25-B28 bill-to, G25-G28 ship-to, A113 order confirmation date, E113 dispatch commitment. Commercial footer I115 discount, I116 subtotal, I117 fabric, I118 packing, I119 transportation, I120 total before GST, I121 GST, I122 grand total. The footer is located by its column-G labels and may shift up to `MAX_FOOTER_OFFSET = 20` rows if proven.
- Blocking issues refuse the upload (product name/quantity/cost/item sequence/image missing or ambiguous or unsupported, SUBTOTAL/GST/TOTAL mismatches, GRAND_TOTAL_MISSING, FOOTER_NOT_FOUND, ...). **A missing salesperson (G21) is only a WARNING** (`PI_SALESPERSON_MISSING`) — it lands in an editable draft field. See contradiction C-3.
- Stated figures are never repaired: where quantity x rate disagrees with the line total both are reported and the workbook value is kept.
- `dispatch_commitment` (E113 prose) is NOT a due date. A due date is stored only if E113 is a real Excel date (>= `DUE_DATE_FLOOR = 2020-01-01`; serials below 61 or 1900-dated numbers are rejected) — `src/lib/orders/dueDate.ts`, mirrored in 20260922.

### 3.5 Boundaries with other modules
- **Quotation requests** are Task Management tasks (`task_type` quotation; `/tasks/quotation-requests`, `/tasks/quotation-requests/new`). Permissions are `task_management.view_quotations` / `manage_quotations` (protected, display/route gates only, NO RLS backing — `src/lib/permissions/quotations.ts`, `enforcement.ts`). New requests are assigned to the "quotation owner", resolved by an **email constant** `DEFAULT_QUOTATION_OWNER` in `src/app/tasks/quotation-requests/new/page.tsx` (changed in #316 when the owner moved his sign-in address; an unmatched email leaves requests with no owner and the form shows "Quotation owner not configured"). Quotation numbers: `get_or_create_quotation_no` (showroom). Quotation -> PI conversion does not exist. See `docs/Module Docs/QUOTATION_REQUEST_MEMBER_ACCESS.md`.
- **Meetings order discussion**: `meeting_orders` is "the Order as discussed in ONE meeting", keyed by `order_number_key` text; `meeting_discussion_items/appearances/events` (20261213) hold persistent issues. Meetings PI import (`/api/meetings/import-pi`) parses a PI workbook for a product list and **stores nothing and writes nothing to Orders**. Orders never reads meeting tables.
- **Samples / dispatch**: `/samples` "dispatch" is courier sample dispatch (`sample_dispatches`) and is unrelated to Order dispatch.
- **Notifications**: shared `notifications` table, see 5.6.

## 4. Database

### 4.1 Tables (first migration)

Core: `order_submissions` (20260908), `order_submission_items` (20260908), `order_submission_item_images` (20260909), `order_submission_activity` (20260908, append-only), `order_submission_correction_requests` (20260930), `order_submission_creation_keys` (20261219, idempotency), `order_submission_middleman_commissions` (20270122, separate table on purpose), `orders` (20260655), `order_activity_log` (20260656), `order_change_requests` (20260816), `order_number_cycle` (20260703), `order_number_cycle_resets` (20260926), `order_reserved_number_ledger` (20270116), `order_product_codes` (20261124), `order_pi_versions` (20261119), `order_pi_version_contents` (20270115), `order_pi_revision_staged_parses` (20270113), `order_pi_staged_documents` (20270114), `order_pi_edit_drafts` (20270115), `order_pi_document_absences` (20270112, append-only), `order_operations_handoffs`, `order_operations_reviewers` (20261229), `order_document_versions` (20260925), `order_document_submissions`, `_files`, `_events` (20270112), `order_approval_events` (20261227, append-only), `order_advance_exceptions`, `order_advance_exception_voids`, `order_advance_holds` (20270116), `order_deletion_log` (20270317, immutable), `order_factory_focus_selections`, `order_visibility_scopes`, `order_visibility_scope_members`, `orders_dashboard_settings` (20270221), `order_notification_recipients` (20261202), `user_module_order` (20261228, personal launcher ordering — not Orders business data).
Retired/legacy (kept for history, unreachable): `order_requests`, `order_request_activity`, `order_request_attachments`, `order_request_seq`.
Other modules' tables Orders depends on: `finance_payment_requests`, `finance_payment_allocations`, `finance_payment_allocation_intents` (Finance dossier), `notifications`, `users`, `test_data_cleanup_settings`.

> Inventory caveat: `APP_INVENTORY.generated.md` marks tables "dropped" with `*` by regex-matching `drop table` anywhere in migration text, **including commented rollback notes**. `order_notification_recipients*` and `finance_payment_allocations*` are marked dropped but are live (their "drop table" lines are comments in 20261202 and 20260918). Do not trust the `*`.

### 4.2 Statuses (CHECK constraints)
- `order_submissions.status`: `draft`, `submitted`, `needs_changes`, `rejected`, `approved`. **`approved` means the PI already has its Order** (approval creates it in the same transaction). Transition trigger `order_submissions_enforce_status_transition`.
- `orders.status`: `running` (default), `on_hold`, `ready_for_dispatch`, `dispatched`, `cancelled` (20260702; `requested` retired). Trigger `orders_enforce_status_transition` (20260819): running -> on_hold / ready_for_dispatch / cancelled; on_hold -> running / cancelled; ready_for_dispatch -> dispatched / cancelled; dispatched and cancelled terminal. Cancel only through `cancel_order_with_audit` (`ORDER_CANCEL_PATH_REQUIRED` otherwise). Non-admin: operations team may set only running / on_hold / ready_for_dispatch; everyone else `ORDER_STATUS_FORBIDDEN`. Clients hold column UPDATE on `status` only.
- `order_pi_versions.status`: `pending`, `admin_approved` (legacy staging state; none in production per 20270116 header), `approved`, `rejected`, `superseded`. Exactly one `approved` + at most one open revision per Order (partial unique indexes). `source_kind`: `workbook` | `edit`.
- `order_operations_handoffs.status`: `awaiting`, `accepted`, `clarification_needed`.
- `order_document_submissions.status`: `pending_admin`, `awaiting_operations`, `accepted`, `rejected_admin`, `rejected_operations`; categories `design_files`, `client_po`; 1-25 files each.
- `order_approval_events`: `approval_kind` `fabric` | `finish`; `status` `not_approved`, `partially_approved`, `fully_approved` (an event log: current state = newest event of each kind).
- Advance exception (`order_submissions.advance_exception_status`): `pending`, `approved`, `rejected`.
- `orders.production_alignment`: `not_aligned` (every Order is born so), `aligned` (plus alignment columns).
- `orders.lead_source` allowed (five, `ORDER_LEAD_SOURCES` in `src/lib/orders/orderConfirmation.ts`, mirrored by the CHECK in 20260816): `reference`, `repeat_customer`, `whatsapp`, `instagram`, `website`.

### 4.3 Key RPCs / functions (latest definition is the LAST migration that re-emits it)

| Function | Latest in | Notes |
| --- | --- | --- |
| `create_order_submission(…, p_idempotency_key)` | 20261219 wrapper | retry returns same draft; `discard_unsaved_order_submission` removes a never-saved draft |
| `submit_pi_for_review` / `_internal` / `_with_documents` | 20270227 (internal) | Chooses route on **attached** payment (verified + awaiting). Below 40% the caller must give one of three reasons: `Against client PO`, `Sample order`, `Other: <remark >= 10 chars>` (20270114; stored in `advance_exception_reason_code`). BEFORE trigger (20270123) refuses the transition into `submitted` without confirmed internal details (`order_submission_internal_details_problem`). Self-submit by an `approve_order` holder auto-stamps the PI decision (20261224 §5) |
| `approve_pi_review(uuid)` | 20261226 | PI decision only; creates nothing. No longer requires PI-level finance verification |
| `approve_order_submission(p_submission_id, p_assigned_to, p_confirm_date, p_due_date, p_lead_source)` | 20270227 | The ONLY Order creator. Refusals: `ORDER_CONFIRMATION_{SALESPERSON,CONFIRM_DATE,DUE_DATE,LEAD_SOURCE}_REQUIRED`, `ORDER_SUBMISSION_PAYMENT_INSUFFICIENT`, `_PAYMENT_AWAITING_VERIFICATION` (any attached payment still undecided blocks, even if 40% is met — 20261226 §7b), `_EXCEPTION_{PENDING,REJECTED,STALE}`, `_INCOMPLETE`, `_BLOCKED`, `_ALLOCATION_NOT_MOVED`. Moves the PI's active allocations onto the new Order (same ids), assigns the number, writes V1 into `order_pi_versions`, triggers the handoff |
| `approve_pi_advance_exception`, `reject_pi_advance_exception` | 20270227 | Need `orders.approve_advance_exception` (or admin branch) |
| `approve_order_advance_exception` | 20270120 | Order-level "production below 40%" with reason, recorded in `order_advance_exceptions` (immutable) |
| `order_advance_position`, `order_advance_readiness`, `order_advance_base`, `order_total_before_gst` | 20270227 / 20270205 | Base = in-force PI version's `commercial.total_before_gst` if its grand total equals `orders.total_value`, else the source PI's, else NULL (NULL never passes) |
| `amend_order` (admin), `approve_order_change_request` / `reject_order_change_request`, `cancel_order`, `cancel_order_with_audit`, `apply_order_amendment` | 20260816 / 20260818 | Reason mandatory, NULL = leave field alone, no-op refused |
| `propose_order_pi_revision`, `propose_order_pi_edit_revision` (service role only), `approve_order_pi_revision` (service role only), `reject_order_pi_revision`, `reapprove_order_pi_revision`, `decide_order_pi_revision_operations` | 20270116 / 20270115 / 20270113 | Admin approval makes the version **in force immediately** (20270116); value changes go through `apply_order_amendment` (source `pi_revision`) |
| `decide_order_operations_handoff`, `set_order_operations_reviewer`, `set_order_production_alignment`, `recover_order_production_alignment` | 20261229 / 20270116 / 20270120 | Alignment door routes to the handoff decision when a handoff exists |
| `request_order_document_generation`, `claim_order_document_generation`, `complete_order_document_generation`, `fail_order_document_generation`, `supersede_order_documents` | 20260925 | Claim lease `order_document_claim_ttl()` = 15 minutes (mirrored by `isOrderDocumentClaimStale` in the client) |
| `create_order_document_submission`, `decide_order_document_submission_admin`, `decide_order_document_submission_operations` | 20270112 / 20270120 | |
| `record_order_approval_event` / `can_record_order_approval` | 20261227 | Allowed: assigned salesperson, `users.role` admin or manager |
| `save_order_submission_internal_details`, `set_order_submission_sales_details` (salesperson + lead source on the PI), `set_order_submission_highlight_remark` (1-1000 chars), `set_order_submission_billing_percentage`, `update_order_submission_{client_details,pi_terms,schedule_terms,item_details}`, `reorder_order_submission_items`, `request_order_submission_{changes,correction}` | 20260927-20270211 | Edit doors work only while the PI is not yet an Order; once an Order exists the PI is versioned (`order_submissions_approved_pi_is_versioned`, 20270115) |
| `delete_confirmed_order(order, typed number)` | 20270317 | Admin only; borrows `boe.cleanup_context` for one transaction; writes `order_deletion_log` |
| `begin_order_submission_deletion` / `finalize_` / `release_`, `order_submission_deletable_statuses()` | 20270316 | Deletable: draft, needs_changes, submitted, rejected; owner (created_by / submitted_by) or active admin |
| `allocate_confirmed_order_number`, `get_confirmed_order_number_cycle`, `set_next_confirmed_order_number`, `reset_confirmed_order_number_cycle` | 20260703/04/26 | See 6.1 |
| `orders_dashboard_summary`, `salesperson_orders_dashboard`, `select_order_for_factory_focus`, `remove_order_factory_focus`, `set_order_visibility_scope`, `list_order_visibility_scopes` | 20270221 / 20270228 | |
| `can_view_order_unscoped`, `can_view_order_as_actor`, `can_read_order_detail`, `sales_scope_allows_order`, `can_view_order_submission`, `can_view_order_submission_via_order`, `can_read_order_submission_commission` | 20270221 | Read rules, see 5.4 |
| `actor_can_approve_order`, `is_permanent_order_approver`, `is_permanent_order_approval_grant`, `user_holds_permission`, `user_has_module_permission` | 20261224 / 20270120 | |

### 4.4 Guard triggers (the real enforcement)
`orders_guard_amendable_columns` (commercial columns move only inside `in_order_amendment()` GUC context `boe.amendment_context`), `orders_enforce_status_transition`, `prevent_order_delete` (only cleanup context or `delete_confirmed_order` purge), `prevent_order_display_number_change`, `orders_alignment_requires_advance`, `orders_advance_recheck_on_value_change` / `order_advance_hold_*` (an aligned Order that drops below 40% loses alignment in the same transaction and a hold is recorded), `order_pi_versions_guard`, `order_submissions_guard_*` (frozen columns, advance exception, order link, deletion claim, finance verification), `order_submissions_require_internal_details`, `order_submissions_require_revised_pi_on_submit`, `order_approval_events_append_only`, `order_*_immutable` (advance exceptions, deletion log, voids), `order_finance_reset_write_guard` (Test Data reset; **runs as owner since 20270117**).

### 4.5 RLS idea
- Module entry is a RESTRICTIVE-style gate (`module_entry_open('orders')`) plus ownership/permission policies. `orders` SELECT: admin, operations team, `requested_by`, `assigned_to`, `orders.view_all`, plus the visibility-scope policy `orders_sales_scope_select` (20270221). Client roles have SELECT and column UPDATE(status) only; no INSERT/DELETE/TRUNCATE.
- A **visibility scope reveals Order detail, never money or authority**: Finance policies, `can_read_payment_as_participant`, `order_linked_payment_total`, document generation/retry and all authorisation helpers use the UNSCOPED rule (`can_view_order_unscoped`). `scopeIsNeverMoneyOrAuthority.test.ts` pins this.
- `order_submissions`: creator / submitter / assigned reviewer / `approve_order` holders / Finance verifiers on submitted+approved PIs (see `can_view_order_submission`; re-read the latest body before changing). The middleman commission lives in its own table so wider Orders authorities cannot read it.
- Several tables have RLS enabled with **no client grant and no policy** (Factory Focus, scopes, settings): reachable only through the SECURITY DEFINER RPCs.

### 4.6 Test-data machinery (important and easy to break)
- `test_data_cleanup_settings`: `enabled`, `permanently_disabled` (irreversible; `permanently_disable_test_data_cleanup('DISABLE TEST CLEANUP')`). While enabled, `stamp_test_data_flag()` stamps `is_test_data = true` on every new record at INSERT; the flag is immutable afterwards. **Dashboards, Factory Focus and revenue EXCLUDE `is_test_data` Orders** — if cleanup is still enabled when the first real Order is created, the dashboard looks empty and the flag cannot be flipped. Production flag state **(unverified, from memory: enabled as of 2026-09-18/29)**.
- Cleanup escape hatch is a GUC (`boe.cleanup_context`, read by `in_test_data_cleanup()`), transaction-local, set only by the executors after their gates. Never exempt "admins" in a guard — that exemption was exactly the hole closed by 20260705.
- Claim protocols (durable, token-based, storage deleted by the route, not in SQL): Test Data Cleanup (`begin_test_data_cleanup` -> `finalize`; admin chooses whether a deleted test Order's number stays spent, 20270217), module Reset (`begin_order_finance_test_reset`, 20261010), PI deletion, payment deletion.

### 4.7 Storage buckets
| Bucket | Limit / types | Notes |
| --- | --- | --- |
| `order-files` (private) | 10 MB; xlsx, png, jpeg, webp, pdf | PI workbook under `submissions/{id}/original/`, product images, `pi-documents/{pi}/{submission}/{category}/{file}`, `order-documents/{order}/{submission}/{category}/{file}`, confirmed Excel/PDF. No UPDATE policy for any role (workbook immutable once submitted); object readable only when named by a ready version row |
| `order-approval-evidence` (private) | 5 MB; png, jpeg, webp | Fabric/finish screenshots; read follows Order visibility, write follows `can_record_order_approval`, delete reaches only an unclaimed orphan |
| `order-request-attachments` | legacy | retired workflow |

### 4.8 Migrations that define the module (file names) and ordering facts
Foundations: `20260655_create_orders`, `20260656_create_order_activity_log`, `20260684000000_register_orders_permission_module`, `20260702000000_retire_requested_order_status`, `20260703/04` (number cycle, four digits), `20260705/06` (protect finalized records, test cleanup), `20260816` amendments, `20260818` hardening, `20260819` creation + status enforcement, `20260901` finance/orders permission enforcement, `20260903` view_all split, `20260908` PI submissions (+ `20260909`-`20260917` review, advance exception, final approval), `20260921` verified-payment gate, `20260924/25` handoff + documents, `20261007` retire Order Requests, `20261009`-`20261014` split payment/number reservation/test reset, `20261113`(Minop, unrelated)/`20261118`-`20261121`/`20261124` (review gate, versions, production alignment, BOE item codes), `20261201`/`02` (required confirm fields, update notifications), `20261224`-`20261227` (approval permanent grant + auto-approval, PI header terms/fabric responsibility, finance verification no longer required, fabric/finish events), `20261229`/`30` (operations handoff; one-time Order 0524 fix), `20270112`-`20270116` (document submissions, revision staging, numbering at conversion, PI edit revisions, revision in force at admin approval), `20270117` (guards run as owner), `20270120` (admin decisions ask permissions), `20270122`/`23` (internal details), `20270201` (PDF order number), `20270205` (production needs order-level exception), `20270210`/`11` (highlight remark, sales details), `20270212` (legacy advance doors closed), `20270216`/`17` (cleanup fixes), `20270221` (dashboard/Factory Focus/scopes), `20270227` (advance on total before GST), `20270228` (salesperson dashboard), `20270315`/`16`/`17` (PI/Order deletion).

Immutability / apply-state facts:
- **Never edit an applied migration, not even a comment.** Several tests diff against `origin/main` ("no applied migration has been modified on this branch": `orderDocumentsSchema`, `orderNumberResetSchema`, `orderPiHandoffSchema`); they also fail spuriously if a local `main` is stale — pull, do not edit.
- Migration filename must contain `order_submission` if it writes `order_submissions`/items/activity (`submissionSchema.test.ts`, `finalApprovalScope.test.ts`) — rename the file, never add an exception.
- Pick a timestamp above every migration IN FLIGHT, not only above main (collisions happened: 20261113 and 20261115 were renumbered to 20261118/19/20).
- Release order is always **migration first, then code** for any screen that reads a new table/function.
- Apply-state evidence **(from memory unless noted)**: 20260816-21, 20260705/06/84, 20261111, 20261118-21, 20261211, 20261215-18 applied (2026-09-07/14/18); 20270111120000 applied 2026-09-26 08:54 IST (`docs/releases/2026-09-26-pi-order-release.md`, in repo); #209 stack 20270112-16 released the same day (`docs/releases`); 20270315/16 applied 2026-10-17; 20270318 applied 2026-10-17; **20270317 UNAPPLIED when last recorded** and its code (#320 = commit `0b06be5e`) IS on main — if still unapplied, the admin "Delete Order" action fails at the RPC. Everything between 20261219 and 20270314 not listed: apply state unknown from this checkout.

## 5. Permissions and access

### 5.1 Registered actions (`src/lib/permissions/modules.ts`, module `orders`, display "Order Management")
`view` (module entry), `create`, `edit`, `delete`, `export`, `manage`, `approve_order` ("Approve PI / Confirm Order"), `approve_advance_exception`, `align_production`, `view_pi_commission`, `view_all` ("View All Company Orders").
**Removed from the registry** (grants stay in DB, confer nothing): `approve` (Order-Request conversion) and `can_be_order_assignee`. Caveat: `is_eligible_order_assignee()` (20260697) still reads `resolve_permission(…, 'orders', 'can_be_order_assignee')` for non-sales users, so a historical grant still makes someone eligible as salesperson/dashboard user while the Control Center can no longer offer it.

Protected actions (no access level grants them; `levels.ts` `PROTECTED_ACTIONS`): `delete`, `manage`, `view_all`, `approve_order`, `approve_advance_exception`, `align_production`, `view_pi_commission`. Dependencies (`ACTION_DEPENDENCIES`): `approve_order`, `approve_advance_exception`, `align_production`, `view_pi_commission` each require `view`; `view_all` -> `view_team` -> `view` chain resolves to `view` in Orders.

### 5.2 Capability derivation (`src/lib/permissions/orders.ts`)
Admin role: all true **except** `canApproveOrderSubmission`, which is resolved from the grant (admin or not). Everyone else: `canAccessOrdersModule = view`; every other capability needs entry AND its own action. `canApproveAdvanceException` and `canAlignProduction` are true for admin (database admin branch).

### 5.3 The special case: `orders.approve_order`
- 20261224: permission-only door `actor_can_approve_order()` (no role branch) so the owner can withdraw it from an admin. The owner's grant is made explicit and **unrevokable** by a DB guard (`is_permanent_order_approver`, `PERMANENT_ORDER_APPROVER_CODES = ['TEST-001']` mirrored in `orderApproval.ts`; `orderApproval.test.ts` compares TS with SQL). Control Center keeps an Administrator row read-only except for this action (`ADMIN_EDITABLE_ACTIONS`).
- 20270120 moved other formerly role-admin decisions to permissions: revision approve/reject/re-approve and document admin decision -> `orders.approve_order`; Order-level below-40% -> `orders.approve_advance_exception`; alignment recovery -> `orders.align_production`; payment self-decision separation -> `finance.verify_own_payment`. `users.role` changes for nobody. `permissionGatedAdminDecisions.test.ts` proves each restated function equals its predecessor except the named expressions.
- Production census (from memory, 2026-09-07/26): `approve_order`, `approve_advance_exception`, `align_production` were granted to the owner and a second manager-role user; `orders.create` to the sales staff. Re-run a read-only census before relying on it.

### 5.4 Who can read what
- Order: see 4.5. PI Draft: creator/submitter/assigned reviewer/`approve_order` holders (+ finance verifiers on submitted/approved).
- Revenue figures: active admin or `orders.view_all` only; scope never counts.
- Factory Focus: everybody with entry sees *which* Orders are selected; card detail follows Order visibility.
- Middleman commission: PI salesperson/submitter, assigned reviewer, active admins, `view_pi_commission` holders.
- Operations reviewer must be able to open **every** Order (admin, active operations-team member, or `orders.view_all`, each with entry); `set_order_operations_reviewer` refuses otherwise.

### 5.5 Who can do what (summary)
| Action | Gate |
| --- | --- |
| Upload PI / create draft | `orders.create` (admin passes) |
| Edit draft | owner while `draft`/`needs_changes`; `can_admin_edit_order_submission` for admins (submitted PIs) |
| Submit for review | owner; internal details must be confirmed; payment route chosen by DB |
| Return / reject / approve PI, convert to Order | `orders.approve_order` (+ admin only if also granted) |
| Decide PI advance exception | `orders.approve_advance_exception` or admin |
| Propose PI revision / edit | PI owner holding `orders.create`, or an admin; reason required |
| Approve / reject revision | `orders.approve_order` (permission-only) |
| Accept / flag handoff | the one assigned operations reviewer — nobody else, admin included |
| Amend / cancel Order | admin (`assert_order_amender`); others use "Request a Change" (admin approves) |
| Move status | operations team (running/on_hold/ready_for_dispatch), admin (all valid transitions incl. dispatched) |
| Delete PI | owner or active admin, statuses draft/needs_changes/submitted/rejected, no money attached |
| Delete Confirmed Order | active admin, typed Order number, no allocation/intent/payment request on Order or PI |
| Test Data Cleanup / Reset / number cycle | admin only |
| Generate / retry documents | management approval authority; download follows Order visibility |

### 5.6 Notifications
Shared `notifications` table, type-prefixed (`order_%` visible via `NOTIFICATION_ACTIVITY_OR`), resolver `src/lib/notificationMeta.ts` (one place for heading/badge/href). Enum values added: `order_operations_review_requested/decided`, `order_document_review_requested/decided`, `order_update_{status,amended,payment,production}` (+ the 20260694 set). **Order update recipients** are 4 configured categories (`order_notification_recipients`: `super_admin`, `admin`, `salesperson`, `bdm`); `bdm` = the whole BDM department, ships **OFF**, and the seed and `ORDER_UPDATE_RECIPIENTS_DEFAULT` must stay in lock-step or a missing row fails open. Events come from `order_activity_log` rows by the actor, never from a diff. Per-user unread uses `notifications.entity_id` = order id.

## 6. Business rules (exact)

### 6.1 Numbers and identifiers
- Draft reference **`PID-00001`…** (own sequence, 20270114); immutable; shown instead of the file name; not an Order number. Gaps are meaningless.
- Confirmed Order number: stored **4 digits** (`0524`), permanent, never reused (cancelled Orders keep theirs); the UI shows the operational number without leading zeros (`524`, `formatOrderOperationalNumber`). The number is allocated **at approval inside the transaction** (`assign_order_display_number` -> `allocate_confirmed_order_number` under FOR UPDATE on the single-row `order_number_cycle`); a rolled-back approval rolls the cycle back. Since 20270114 a new draft reserves NOTHING; an existing reservation (one, 0525 in production per the migration header) is honoured and a reserved number is never reissued (`order_reserved_number_ledger`).
- The next number is an admin decision (`set_next_confirmed_order_number`); cleanup returns only numbers it freed from the TOP of the range; the cycle returns to 1 only through `reset_confirmed_order_number_cycle()` (admin, finalized cleanup claim, zero Orders, no submitted/approved PI, no allocation pointing at an Order/PI; audited).
- Item codes: `BE001`…; Order Product Code `<operational no>-BE001` (e.g. `524-BE001`), `order_product_codes`; a retired code/item sequence is never reissued (edit revisions keep item ids so codes re-attach).
- `PDF` of each PI version prints `order_pi_versions.pdf_order_number`, fixed at creation (20270201 — **staged**: the migration still stamps the old unpadded form on new versions; re-read it).

### 6.2 The advance / payment gate (replaced 20270227)
- Rule: required advance = **40% of Total before GST** (`STANDARD_ADVANCE_PERCENT = 40`), exact `numeric` (40% of 100.01 is 40.004; 40.00 does not meet it); shortfall rounded UP to the paisa; suggested standard amount = ceiling to the paisa. Worked example in the migration: pre-GST 1,20,000, GST 21,600, Grand Total 1,41,600, verified 48,000 -> exactly 40.00%.
- Total before GST = Subtotal (product value - discount) + fabric + packaging + quoted transportation ("as applicable" adds nothing). GST and the pre-GST total have NO column on `orders`; they live on the PI / PI version.
- Only **Finance-verified** allocations count (`finance_payment_status_is_verified`: `approved_unlinked`, `approved_linked`). A NULL / zero / NaN / negative base never passes (`value_known = false`).
- Approve is refused while ANY attached payment is still awaiting Finance (even if verified money >= 40%).
- Reduced route: below 40% attached payment (zero included) the submitter gives a reason (3 reasons above) -> exception `pending` -> approver decides; an approval belongs to one value basis (value epoch + PI version + verified amount) and goes `stale` if terms change. Money first, then the decision that stands in for money: if the PI reaches 40% while a request sits, approval takes the standard route.
- **Production needs 40% of the CURRENT Order value** verified, unless an admin-level approver approves production below 40% with a reason at **Order level** (`approve_order_advance_exception`, 20270205). The PI-level exception no longer starts production; it only lets the PI become an Order. An aligned Order that falls short (value raised, or verified money reduced) loses alignment in the same transaction (hold recorded, management notified).
- The old PI-level "Finance verification" step was removed (20261226); `verify_pi_finance_check` still exists but nothing requires it.

### 6.3 PI content rules
- Billing percentage: floor **35**, ceiling **100** (form, RPC, CHECK); undeclared is a real state (not 0, not 100); value = `total_before_gst` x percentage; read-only on the Order; refused rather than clamped.
- Must be present before finalization (`assert_order_submission_finalizable`): client name, creation date, salesperson, salesperson phone, client **city**, a fabric-responsibility answer (`boe` | `client` | `not_selected`; **NULL = unanswered, blocks**, no default), commercial terms. `commercial_terms_note` default is the standard BOE sentence for NEW drafts only (existing rows stay NULL so history is not rewritten; max `COMMERCIAL_TERMS_MAX_LENGTH = 2000`).
- Internal details (20270122/23): confirmation date and due date confirmed by Sales in the app (workbook values kept separately in `workbook_*`), middleman commission answer yes/no (+ who, + amount or percentage of a named figure) — required to submit; client never sees them.
- Order creation needs: salesperson, confirm date, due date, lead source (`approve_order_submission` args; Sales can prefill salesperson/lead source on the draft since 20270211, neither is required to submit).
- Product lines: each needs item sequence + name + exactly one representative image; images PNG/JPEG/WEBP and must exist in storage.
- "Cost's meaning is a column": "Not applicable" and "Included" both add zero but are opposite answers.

### 6.4 PI decision vs Order creation
Two separate acts (20261119): `approve_pi_review()` stamps the PI decision (`pi_approved_by/at/submission_at`) and creates nothing; `approve_order_submission()` creates exactly one Order and stamps the decision itself if it is the first press. The PI decision is **stale** once the record moves (new `submitted_at`). One submission -> one Order in both directions (two partial unique indexes). A failed approval consumes nothing. Auto-approval (20261224 §5): a PI submitted by a holder of `approve_order` gets its PI decision stamped at submit; it is NOT a Confirmed Order and does not decide an advance exception.

### 6.5 PI versions and revisions
- V1 is the document the Order was approved from. A later PI is always a **new version**; the in-force version changes only by admin-level approval (20270116): approve applies the revised parse through the one parser path, moves the Order's five amendable fields through `apply_order_amendment` (source `pi_revision`, with old/new values), supersedes the old version, and fires the operations-handoff trigger for the new version. Operations acceptance no longer stands between approval and the version being current.
- Proposing: PI owner holding `orders.create`, or admin; reason required. Approving / rejecting: `orders.approve_order` (permission-only). Rejection keeps the file and reason. One open revision per Order; items frozen while one awaits (legacy staging guards still exist).
- Edit PI (20270115): the proposal is built and priced by the server (`/api/orders/pi-edits`), never by the browser; kept in `order_pi_versions.proposal`; fabric responsibility, terms note, city, payment and billing terms and billing % are applied at acceptance.
- After an Order exists the PI's client, dates, figures, terms and lines refuse every write except a revision apply (and cleanup). Earlier admin edit doors keep working only on PIs that are not yet Orders.

### 6.6 Amendment model
Amendable fields (`AMENDABLE_FIELDS`): client_name, total_product_value, total_value, confirm_date, due_date, lead_source, notes (source comment says "eight", seven are listed). `created_by`/`created_at` frozen; `display_number` and the source provenance have their own guards; `status`, `notes` operational. NULL in a proposal means "leave alone" (neither door can blank a value). Reason mandatory; no-op refused. A change request approved against a newer amendment is protected (D6c, 20260818). Cancellation records the money received against the Order. Non-admin operations team can never write commercial columns (the wall: `orders_guard_amendable_columns`).
`assigned_to` is not amendable: a historical Order with no salesperson cannot be given one (open follow-up). `requested_by` = PI submitter, `created_by` = approver, `assigned_to` = salesperson (since 20261201); on `order_submissions` `assigned_to` = the PI reviewer and `salesperson_id` = the salesperson (20270211).

### 6.7 Operations handoff and production alignment
- Every time a PI version becomes in force (V1 at conversion; V2+ at admin approval) a handoff row is created for THAT version and addressed to the single configured reviewer (`order_operations_reviewers`, duty `pi_handoff`). With no reviewer it is recorded unassigned (`unassigned_reason = 'no_reviewer'`) and every active admin is notified; assigning a reviewer re-addresses waiting handoffs.
- **Acceptance aligns the Order** (alignment columns written in the same transaction); "Cannot accept" on an accepted version (reason required) takes it back; approving a later version RESETS alignment to `not_aligned` and records what it covered. `set_order_production_alignment()` on an Order with a handoff routes to the same decision, so being admin or holding `align_production` no longer aligns it.
- Alignment also requires the 40% rule (6.2) — refusal `ORDER_ADVANCE_BELOW_THRESHOLD`.
- Lock order for all handoff paths: `order_operations_reviewers` -> `orders` -> PI rows -> `order_operations_handoffs` (runbook has the table). Reviewer assignment takes `FOR UPDATE`; decisions take `FOR SHARE`.
- Order 0524's V1 was routed by a one-time, pinned-id data migration (20261230) that raises and writes nothing if any expectation changed.

### 6.8 Status and dispatch
See 4.2. No payment gate exists on dispatch in code. The owner's decision (₹1,000 tolerance, "dispatch on credit" request) is **not built**. `ready_for_dispatch` is an internal "manufacturing done" signal.

### 6.9 Documents
- Order documents version = a business fact (initial or after approved amendment); an attempt is a technical fact; a failed attempt creates no user-visible version; Order is document-ready only when BOTH Excel and PDF exist; the original uploaded PI is never overwritten. Claim lease 15 minutes; a run dying mid-flight leaves the row `claimed` (client treats stale after 15 min and offers takeover).
- Client-facing PDF must not reveal billing (`clientPdfNoBilling.test.ts`, `clientDocumentPrivacy.test.ts`).
- Design Files / Client PO: submit (1-25 files) -> admin decision -> operations decision; only operations acceptance makes a file current (derived: Client PO = latest accepted; Design Files = every accepted from latest accepted "replace"); never deleted; nothing yet for the main PI (it travels the PI-revision door).

### 6.10 Deletion
- PI: statuses draft/needs_changes/submitted/rejected; owner or admin. Money always blocks: active allocation, pending intent, correction request. Releasable leftovers (20270315): reversed allocation of a payment that is soft-deleted, never approved, not in an applied intent. Submitted PIs carry document submissions whose rows are erased only inside that PI's purge. An `approved` PI is deleted as an Order.
- Confirmed Order: admin, typed number, no allocation/intent/payment-request link in any status (except releasable leftovers); Finance is never touched; ~20 tables of history are removed under the borrowed cleanup GUC in one transaction; storage is swept by the route AFTER; `order_deletion_log` is immutable.
- Approved verified payments are permanent (see Finance).

### 6.11 Factory Focus and visibility
- Owner only; **two NEW selections per IST calendar month** (a removal does not refund the month's selection; active selections carry over); removal manual with reason; nothing hides one automatically; refuses a closed, already-selected or salesperson-less Order. Scopes per sales candidate: own / own + selected / all sales candidates (owner sets). Default everybody "own".
- Dashboard excludes `is_test_data`; fabric/finish tracking starts at `orders_dashboard_settings.fabric_finish_tracking_from` (= moment 20270221 applied).

## 7. Key components and lib files

- Pages: `src/app/orders/page.tsx` (335 lines), `all/page.tsx` (896), `drafts/page.tsx` (785), `drafts/[submissionId]/page.tsx` + `piDetailSections.tsx` + `piDetailView.ts`, `import/page.tsx` (1504), `[id]/page.tsx` (**3742 lines**; do not add queries — pinned), `[id]/OrderWorkspace.tsx`, `OrderStatusWorkspace.tsx`, `OrderAmendmentModals.tsx`, `OrderApprovalModal.tsx`, `OrderRevisionModals.tsx`, `RevisionOperationsReviewModal.tsx`, `OrderDocumentSubmissions.tsx`, `OrderPiSections.tsx`, `DeleteOrderModal.tsx`, `MoreActionsMenu.tsx`.
- Components: `src/components/orders/` (`PiEditor`, `PiLineReview`, `PiPaymentCard`, `AdvanceGatePanel`, `PiVersionsPanel`, `PiInternalDetails`, `PiHighlightRemark`, `PiCompletionPanel`, `DocumentActionQueue`, `piReviewModals`, `piPreview`, dashboard/{AttentionSections,FactoryFocusSection,RevenueSection,SalespersonDashboardView}); layout `src/components/layout/OrdersLayout.tsx`; guard `src/app/orders/layout.tsx`.
- Lib: `src/lib/orders/*` (65 source files). Pure rule modules worth reading first: `advanceFormula.ts`, `advanceRequirement.ts`, `paymentGate.ts`, `submissionWorkflow.ts`, `orderConfirmation.ts`, `amendments.ts`, `orderWorkspace.ts`, `operationsHandoff.ts`, `orderPiVersions.ts`, `orderDeletion.ts`, `submissionDeletion.ts`, `orderDocuments.ts`, `orderDocumentSubmissions.ts`, `piReadiness.ts`, `piTerms.ts`, `billingPercentage.ts`, `dueDate.ts`, `orderProductCodes.ts`, `orderNumberReservation.ts`, `orderUpdateNotifications.ts`, `orderVisibilityScopes.ts`, `productionAlignment.ts`, `orderApprovals.ts`, `orderDashboard*.ts`, `salespersonDashboard.ts`. Parser: `src/lib/pi/`. Permissions: `src/lib/permissions/{orders,orderApproval,levels,modules,enforcement}.ts`. Navigation: `src/lib/navigation/moduleNav.ts`.
- Cross-module reads: `src/lib/finance/{orderFinancePosition,crossModuleLinks,paymentAllocations,piPaymentView}.ts`.

## 8. Decisions made and why (owner decisions)

- **Order Requests retired** (20261007): the only path to an Order is PI upload -> review -> approval, so `approve` and `can_be_order_assignee` options were removed from Access Control (an option that grants nothing is worse than none). `approve_order` was deliberately never `approve` so retirement took nothing away.
- **Two acts, not one**: PI decision vs Order creation; Order creation never automatic from a Finance RPC.
- **Advance base changed from Grand Total to Total before GST** (business agreement, 20270227): GST is tax, not value. Rounding rules unchanged.
- **Finance verification of the PI as a document removed** (20261226): per-payment verification already carries the fact.
- **Admin approval makes a revised PI current immediately** (owner 2026-09-25, 20270116); operations acknowledgement is a separate production-readiness question.
- **Alignment = Operations acceptance** (20261229); an older alignment can never make a newer unaccepted PI look ready.
- **Amendments only through audited doors**, via a transaction-local GUC rather than "exempt admins" (an exemption audits nothing).
- **Cleanup is a GUC, not an identity** (20260705/06), and test-data is stamped at INSERT, never a tick-box.
- **No reservation for new drafts; number assigned at approval** (20270114) so abandoned drafts burn nothing; existing reservations kept.
- **Equal admins / permissions over roles** (owner 2026-09-26): two admins of the PI->Order->Finance flow have equal authority; authority is a Control Center permission, nowhere in code. Exception: `orders.approve_order` is permission-only and unrevokable for the owner.
- **Admin delete of a Confirmed Order allowed** (reversal of the 2026-07 "Orders are permanent" rule) but only with no money attached and a typed number.
- **Owner-only Factory Focus and visibility scopes**; a scope reveals Orders, never money or authority.
- **Owner decisions of 2026-09-18 still to build**: dispatch gate (verified payment >= Order value - ₹1,000, otherwise salesperson requests "Dispatch on credit" with a reason; only admin / one named partner approves; "Ready for Dispatch" is never blocked and always notifies salesperson + Finance with the amount due); void / full refund / partial refund / customer credit / correction for wrong verified payments (admin or the named partner by permission, one person enough, refund records date/amount/mode/reason and reduces Order paid and product values; bounce not needed); "Next action" column on the PI list only + a "My pending actions" view; Orders list columns (Order no, Client, Salesperson, Order value, Confirm date, Due date, Fabric/finish status; no payment columns); fabric and finish tracked **per product** with pieces approved ("Fabric 6/10 pcs"), "Fabric sent by customer" enabling quantity per piece with area (Full piece / Seat / Back / Custom), quantities taken from the PI workbook sheet "Packing cost and Fabric Cost" (H fabric per pc, I total), a customer-fabric label PDF (Order no, Product Code, Fabric Code, quantity in metres, area), salesperson REQUESTS quantity and the owner or partner ENTERS it; staged payments optional with no reminders; lead source asked separately (now done via 20270211); a payer name and a Sample Order type are NOT wanted; "Quotation -> PI is later". Memory marks these **(unverified, from memory)** — none exist in code.
- **Test login kept; no second hard admin; owner sets the first Order number** (go-live decisions, from memory).

## 9. Known traps, gotchas and unfixed defects

1. **Amendment-guard defect family — FIXED on this checkout, but the class remains.** `orders_guard_amendable_columns` refuses changes to client_name / confirm_date / due_date / total_value / total_product_value unless inside `in_order_amendment()`. Functions that wrote `orders` outside it were fixed one at a time: `replace_order_submission_parse` and `update_order_submission_client_details` by 20261120 ("Defects A+B", verified: both now call `set_config('boe.amendment_context', …)`), `update_order_submission_schedule_terms` by 20261217 (found at go-live review). No SQL harness except the newer ones installs this guard, so such bugs hide until the first real Order exists. Memory's "unfixed" note (`reference_orders_amendment_guard_latent_defect`) is STALE. Any NEW function that updates `orders` after approval must open the amendment context (and since 20270115 an approved PI refuses edits except through a version).
2. **`orders.approve_order` is not carried by the admin role.** An admin who was never granted it sees no Approve button and the DB refuses; do not "fix" that by adding a role branch.
3. **Dashboards hide test data.** If Test Data Cleanup is still enabled when real Orders start, every list/revenue figure excludes them and the flag cannot be flipped.
4. **Startup-shape pins**: `orderStartupShape.test.ts` fixes query counts and awaits per screen: guard 2, dashboard 8, All Orders 4, Order detail **41**, PI Drafts 4, PI detail **30**, retired notice 3, import 8; and waits (Order/PI detail 3). Any added `.from(`/`.rpc(`/`await` on the startup path breaks it; move the number deliberately with a comment.
5. **Source-string pins**: `[id]/page.tsx` is pinned by ~17 tests (literals such as `buildOrderFinancePosition(payments, order.total_value)`, `financePaymentHref(p.id)`, `loadOrder()` inside the init `Promise.all`, a component named `ActivityDot`); `piDetail.render.test.tsx` scans `globals.css` from the "PI DETAIL" heading to EOF and requires every `grid-template-columns` track to be `minmax(0,…)`/fixed px (currently a known failing-on-main example in `BASELINE_FAILURES_2026-10-14.md`, cleared by #327 per commit message); `draftsAccess.test.ts` keeps a CLOSED import list for the PI page and forbids `role === 'admin'` there; `finalApprovalScope.test.ts` pins the import page.
6. **Ledger-pin tests**: ~8-11 test files list every migration after 20261008 (`participantAndOrderTotalSecurity`, `orderFinanceTestReset`, `orderReservedPiGateAndBoeItemCodes`, `piFinanceVerificationRemoval`, `orderDeletion`, `custodyTrail`, …). A new migration file must be added to each; search for the previous highest filename. Test files are CRLF — a `\n`-only regex silently matches nothing.
7. **`orderActivityActions.test.ts` / `submissionActivity.test.ts`**: `log_order_submission_activity` third argument must be a literal / CASE of literals; the activity map must equal the latest CHECK constraint. Adding an activity action needs both the constraint and the label map.
8. **`designationLevels.test.ts` refuses any migration (except 20261106) that even mentions `designation_level`, including in a comment.**
9. **Stale user-facing text**: `DELETE /api/orders/[id]` still tells callers "Confirmed Orders are permanent ... cannot be deleted" although admin deletion now exists via `POST /api/orders/[id]/delete`.
10. **Gap in `enforcement.ts`**: `orders.enforcedActions` lists only view, view_all, approve_order, manage, delete; `approve_advance_exception`, `align_production`, `view_pi_commission` ARE enforced in the database but not declared (the Access Control "Enforced" badge understates).
11. **Lock order matters** (handoff, deletion, amendment): reviewers -> orders -> PI rows -> handoffs. A new path that takes them in another order deadlocks.
12. **Overload trap**: never give two signatures of an RPC defaults (PostgREST PGRST203). `approve_order_submission` once existed as 1-arg blocker + 5-arg form with `pronargdefaults = 0`.
13. **PL/pgSQL caches a trigger's EXECUTE check per transaction** — test privilege refusals in a FRESH session/transaction.
14. **`tsx --test` treats a path containing `[id]` as a glob** and silently runs 0 tests; pass a glob such as `"src/app/orders/**/*.render.test.tsx"`. Windows only.
15. `text[] || 'literal'` is array concat — use `array_append()`; `numeric(12,2)` serialises into jsonb as `250000.00`; `supabase db query` is not psql (no `\set`, no NOTICE).
16. **Storage is not in the SQL transaction.** Deletion routes return storage paths and the route removes objects AFTER; a partially failed sweep keeps the claim and the admin retries.
17. **Test-data cleanup + immutable exceptions**: `order_advance_exceptions.pi_version_id … on delete set null` collided with the immutability guard until 20270216; any new immutable table referencing PI/Order rows must be cleanup-aware.
18. **Windows**: a `node_modules` junction in a worktree must be deleted before `git worktree remove --force`; `git worktree remove --force` deletes ignored `.env.local`.
19. **Live-DB tests**: with a real `.env.local`, several suites write fixtures to the ONLY configured project (production). Run the suite with blank Supabase env: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=offline` (dotenv does not override).
20. **Stale docs**: `docs/BOE Master Context/05_Business_Rules.md` Order Management section still says 40% of the **grand total**, requires Finance verification, and marks several features "(branch)"; `src/lib/orders/orderNumberReservation.ts` header describes reserving a number the PI must carry (removed 20261124, new reservations ended 20270114); `src/lib/permissions/finance.ts` header says "NOT YET WIRED" (it is wired).

## 10. Tests that guard it

Run: `npm test` = `tsx --test "src/**/*.test.ts" "src/**/*.test.tsx" "scripts/**/*.test.mjs"`. Subset: `npx tsx --test src/lib/orders/*.test.ts` (use a quoted glob for `[id]` paths). Default offline-safe form: prefix `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=offline`. Per commit message of #327 (5c39ee5a) clean main = 0 failures without a database **(unverified, from commit message and memory; memory also records 8 environment-blocked live-DB suites in other states)**. Never run two suites concurrently against the shared hosted project.

| Area | Files (all under `src/lib/orders/` unless noted) |
| --- | --- |
| Startup shape / architecture | `orderStartupShape`, `src/app/orders/orderDetailArchitecture.test.ts`, `src/app/orders/orderFinanceSwitchAndDetailGate.test.ts`, `piSectionOrder` |
| Advance / payment gate | `advanceFormula`, `advanceRequirement`, `advanceReadiness`, `advanceOnTotalBeforeGstSchema`, `advanceAmountSchema`, `advanceExceptionSchema`, `paymentGate`, `verifiedPaymentGateSchema`, `orderAdvance`, `heldOrderSummary` |
| Approval / authority | `orderApprovalAuthority`, `orderApprovalAutoApprove`, `orderApprovalCapabilityLabels`, `permissionGatedAdminDecisions`, `finalApproval*`, `piFinalizationGate`, `piFinanceVerificationRemoval`, `src/lib/permissions/{orders,orderApproval,levels,registry,enforcement}.test.ts` |
| PI model | `submissionSchema`, `submissionWorkflow`, `submissionPayload`, `submissionActivity`, `orderActivityActions`, `piReadiness`, `piTerms`, `piInternalDetails`, `salesOrderDetails`, `highlightRemark`, `billingPercentage`, `billingContinuity`, `dueDate`, `dueDateContinuity`, `src/lib/pi/{masterSheetParser,workbookReader,previewView,realWorkbook,sampleImageMapping}.test.ts`, `processDraftRoute`, `src/app/orders/import/importAccess.test.ts`, `src/app/orders/drafts/draftsAccess.test.ts`, `piDetail.render.test.tsx` |
| Versions / handoff | `orderPiVersions`, `piVersionPdf`, `orderPiRevisionPromotion`, `piRevisionApproveRoute`, `piEdit`, `piEditDatesOnly`, `operationsHandoff`, `operationsHandoffSchema`, `orderPiHandoffSchema`, `order0524OperationsHandoffMigration`, `productionAlignment`, `orderPiHistory`/`orderOperationsReview`/`orderPiHandoff` render tests under `src/app/orders/[id]/` |
| Amendments / lifecycle | `amendments`, `amendmentContinuity`, `adminAmendmentSchema`, `scheduleTermsAmendmentContext`, `scheduleTermsEditSchema`, `clientDetailsEditSchema`, `productEditSchema`, `orderCurrentStatus`, `orderWorkspace`, `orderConfirmation`, `orderCommercial` |
| Documents | `orderDocuments`, `orderDocumentsSchema`, `documentsRoute`, `confirmedExcel/Pdf/Workbook`, `orderDocumentSubmissions`, `clientDocumentPrivacy`, `clientPdfNoBilling` |
| Numbers | `orderNumberReservation`, `orderNumberResetSchema`, `cleanupNumberChoice`, `orderProductCodes`, `orderReservedPiGateAndBoeItemCodes` |
| Deletion / test data | `orderDeletion`, `submissionDeletion`, `submissionDeletionBlockersServer`, `unsavedDraftDiscard`, `orderFinanceTestReset`, `testDataCleanupPiSchema`, `testDataCleanupAdvanceExceptionRetry`, `testDataResetServer`, `orderRequestRetirement` |
| Dashboard / scope | `orderDashboardSummary`, `orderVisibilityScopes`, `scopeIsNeverMoneyOrAuthority`, `salespersonDashboard`, `orderUpdateNotifications` |
| SQL assertion suites (need Docker postgres:16-alpine; run via `supabase/tests/run_*.sh`, strip CRLF first) | `order_amendment_assertions`, `order_pi_review_gate_and_versions_assertions`, `order_operations_handoff_assertions` (+ race), `order_pi_revision_in_force_at_admin_approval_assertions`, `order_pi_edit_revisions_assertions`, `order_document_submissions_assertions`, `order_submission_deletion_assertions`, `order_submission_internal_details_assertions`, `order_submission_numbering_at_conversion_assertions`, `order_advance_hold_assertions`, `orders_dashboard_assertions`, `salesperson_orders_dashboard_assertions`, `advance_on_total_before_gst_assertions`, `order_finance_reset_assertions`, `order_number_cycle_reset_assertions`. `supabase/tests/finance_payment_verification_assertions.sql` is stale (creates an Order Request). |
| Permission registry drift | `npm run permissions:check` (code registry vs `permission_modules`); fix drift with a targeted migration, **not** `permissions:sync` (it would clobber the shared `view_all` label) |

## 11. Open items / next planned work

- Build, in this order (owner 2026-09-18): dispatch gate + void/refund/correction/customer credit; then per-product fabric & finish with label PDF and quantity requests, Orders list columns, PI "Next action" + "My pending actions", staged payments. None is in code.
- Confirm apply-state of `20270317` and everything 20261219–20270314 with `supabase migration list --linked`.
- Fix `DELETE /api/orders/[id]` message; refresh the stale doc sections listed in trap 20.
- `assigned_to` cannot be amended on a historical Order (no salesperson path).
- Quotation -> PI conversion; Sales Manager team visibility (open question in `FINANCE_ORDER_WORKFLOW.md` §4.6).
- Go-live owner steps still recorded as open (from memory 2026-09-18): remove test data via Test Data Cleanup, set the first Order number, permanently disable cleanup, review who holds the three protected approval actions, remove the test login.
- Direct client writes to guarded tables were reported as broken in production by the test-data write guard (not SECURITY DEFINER) — **fixed on this checkout by 20270117**; apply-state unverified.

## 12. Recheck before changing this module

Read first, in this order:
1. `src/lib/orders/orderStartupShape.test.ts` (query/await budgets) and `src/app/orders/[id]/page.tsx` literals it and ~16 other tests pin.
2. The **latest** body of each function you touch: `grep -l "create or replace function public.<name>" supabase/migrations/*.sql | tail -1` — then check for later `alter function`/re-emits in `20270213*` (search_path pins) and `20270120*`.
3. `supabase/migrations/20270227000000_*` (advance base), `20261224000000_*` (approval authority), `20261229000000_*` + `docs/runbooks/order-operations-handoff-rollout-and-rollback.md` (lock order), `20270116000000_*` (revision in force), `20270221000000_*` + `docs/runbooks/orders-dashboard-factory-focus-rollout-and-rollback.md` (scopes, test-data blocker).
4. `src/lib/permissions/{modules,orders,orderApproval,levels,enforcement}.ts`; run `npm run permissions:check`.
5. Queries before you ship (read-only, via `supabase db query --linked`): `supabase migration list --linked`; `select enabled, permanently_disabled from test_data_cleanup_settings`; count of `orders` / `order_submissions` by status; the active `order_operations_reviewers` row; `pg_get_functiondef` of any RPC you re-emit (compare to the migration, use a script, never hand-retype a 400-line body).
6. Tests to run: `npx tsx --test "src/lib/orders/*.test.ts" "src/lib/pi/*.test.ts" "src/lib/permissions/*.test.ts" "src/app/orders/**/*.test.ts*" "src/lib/finance/*.test.ts"`, then full `npm test` with the offline env prefix; SQL suites for the area from `supabase/tests`.
7. If adding a migration: put `order_submission` in the file name when it writes PI tables; add it to every ledger-pin test (grep the previous highest filename in `src/**/*.test.ts`); timestamp above everything in flight; forward-only; self-assert and EXECUTE the assertions on a disposable DB (text-only tests have passed while an apply aborted).
8. Release order: apply migration -> deploy -> verify (Vercel deploy via the GitHub deployments API + grep the bundle for new strings). `main` is protected (PR + Vercel check; merge = production deploy). Ask the owner before merging or applying.

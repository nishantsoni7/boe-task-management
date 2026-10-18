# Module dossier 02 — Finance (payments received, verification, allocation, custody, expenses)

Verified against the checkout at commit `852e0493` (main, 2026-10-18). Sources: code, `supabase/migrations/*.sql`, `docs/`, and
auto-memory. Anything not verifiable on this checkout is marked **(unverified, from memory)**. "Applied" means applied to the
production database, which a checkout cannot prove (use `supabase migration list --linked`, non-empty `remote` column).
Companion dossier: `01-orders.md` (PIs, Orders, the 40% gate that consumes verified money).

Vocabulary: **payment** = one row of `finance_payment_requests` (the only payment ledger; its name is historical). **Allocation** =
a row of `finance_payment_allocations` saying how much of one payment belongs to one PI Draft or one Confirmed Order.
**Verified** = status `approved_unlinked` or `approved_linked` (`finance_payment_status_is_verified()`, "the single definition of verified").

---------------------------------------------------------------------------------------------------------------------------

## 1. Purpose and users

Finance records and verifies money BOE **receives** (customer advances/balances) and connects it to PI Drafts and Confirmed Orders, and
separately records money BOE **pays out** (small expenses, personal-payment reimbursements).

| Who | What they do |
| --- | --- |
| Salesperson / any employee with `finance.view` + `create` | Sends a Payment Request (records money received, optionally with proof), corrects/reapplies their own unverified request, soft-deletes their own never-approved request, records expenses |
| Payment verifier (`finance.approve`) | Verifies, rejects, or sends back (needs clarification) payments someone else recorded |
| Allocator (`finance.allocate`) | Decides which PI Draft / Confirmed Order a verified payment (or part of it) belongs to |
| Allocation corrector (`finance.allocate_correct`) | Reverses a recorded allocation (whole, with reason) |
| Finance manager (`finance.manage`) | Edits/corrects Confirmed Payments, corrects other people's expenses, records/reverses reimbursement batches (with company-wide sight) |
| Company-wide reader (`finance.view_all`) | Reads every payment and expense; no write |
| Self-verifier (`finance.verify_own_payment`, protected) | Their own payments are verified in the same action they record them; may decide a pending payment they recorded |
| Active administrator (`users.role = 'admin'`) | Everything above through the admin branch; the only people who can permanently delete an *unverified* payment (or any *test* payment) via the claim protocol |
| Operations / Orders people | Read allocations/payments only as **participants** of a PI/Order they can open; cannot see other payments |

## 2. Status at commit 852e0493

| Capability | State | Evidence |
| --- | --- | --- |
| Payment Requests (send, edit, reapply, clarify, reject, verify) | **Shipped** | `/finance`, `submit_payment_request`, `approve/reject/request_finance_payment_clarification` |
| Confirmed Payments list with allocation status filter, Allocated Against column, details modal | **Shipped** (#141/#142/#166/#171) | `/finance/received`, `ReceivedPaymentsView.tsx` |
| Payments to Verify page | **Route exists** (`/finance/payments-to-verify`, `surface="to_verify"`) but **no sidebar entry** — verification is reachable from Payment Requests | `FinanceLayout.tsx` |
| Record Payment (split across many destinations, one transaction) | **Shipped** (20261009/11) | `RecordSplitPaymentModal.tsx`, `record_payment_with_allocations` |
| PI payment entry from the PI Draft | **Shipped** (20260919) | `record_pi_submission_payment` |
| Allocation model: allocate, split atomically, reverse (correction Phase 1) | **Shipped** (20260918, 20261011, 20261012, 20261215, 20261216) | `allocate_payment_to_target[s]`, `reverse_payment_allocation` |
| Payment IDs `P-AA-0001`, admin deletion by durable claim | **Shipped** (20261011) | |
| Verified payments are permanent (test data excepted) | **Shipped** (20261218) | |
| Idempotent payment doors, rupees-and-paise CHECK, unsaved-draft discard | **Shipped** (20261219, PR #172 is merged) | `submissionAttempt.ts` |
| Review modal through RPCs (reject / clarify), OR-overlap RLS fix | **Shipped** (20261211 + #173 = in 20261211/`request_finance_payment_clarification`) | grep shows only RPC calls in the review modal |
| Order/Finance write guards run as owner (proof attach works) | **Shipped in code** (20270117); apply-state **(unverified)** | |
| Payment proof opens for its reviewers | **Shipped** (20270118120000) | `can_open_payment_proof` |
| Self-verification permission (`verify_own_payment`) | **Shipped** (20270120) | `complete_payment_entry` |
| Four-account payment model (HDFC, PNB, Paytm, Canara) and custody trail (Collected / Handed Over) | **Shipped** (20261014); outside courier as "handed by" 20270318 (applied 2026-10-17 per memory) | `finance_payment_custody_events` |
| Owner soft-delete of own never-approved request | **Shipped** (20270226) | `delete_own_payment_request` |
| Payment form redesign: Send Payment Request, Record/Edit Payment, Allocate Funds / Allocate Payment / Correct Allocation / Add PI payment on a shared frame | **Shipped** (#324, #325, #326 are in the history) | `components/PaymentFormParts.tsx`, `FinanceModalShell.tsx` |
| Expenses (quick capture, drafts, voice-to-form, categories, payment source, reimbursement batches, bills) | **Shipped** (20261220–23, 20270205120000, 20270211120000) | `/finance/expenses*` |
| Void / refund / customer credit / "correction" for wrong verified payments; Phase 2 net-received and adjustments | **Planned, not on this checkout** | no schema or code; owner decision 2026-09-18 |
| Sales Manager team visibility; staged payments; payer name field | **Planned / explicitly not wanted** (payer name) | see 8 |

## 3. Pages and API routes

### 3.1 Pages (inside `src/app/finance/layout.tsx` -> `ModuleGuard moduleKey="finance"` = effective `finance:view`)

| Route | Purpose |
| --- | --- |
| `/finance` | **Payment Requests**: tabs Pending / Needs Clarification / Rejected / Archive / All (server-side filters in `paymentRequestsQuery.ts`); new/edit/reapply forms; admin/verifier review modal |
| `/finance/received` | **Confirmed Payments** (`ReceivedPaymentsView`): summary cards (`receivedPaymentsSummary.tsx`, data `lib/finance/confirmedSummary.ts`), then the list with its view bar: tabs All / Zero / Partially / Fully / Over-allocated with counts, search, "Paid date" chip, count; columns Payment ID, Client, Amount (right), Received (date + account), Allocated against, Status, Actions; row actions View / Allocate (words), Edit and Delete behind "More"; cards below a 970px container threshold; deep links `?payment=<id>` and `?action=allocate` |
| (all payment lists) | Notion-style list (2026-10): `FinanceListParts.tsx` (`FinanceTabs`, `FilterChip`, `FinanceEmpty`, `FinancePerson`) + the "FINANCE LISTS" CSS block (`.fin-board`, `.fin-viewbar`, `.fin-table`, `.fin-pill--<status>`, `.fin-dot--<status>`). One colour key: zero = amber, partial = blue, full = green, over = red. `.fin-board` overflow is visible on purpose (the date panel). Do not change the horizontal cell padding of the Confirmed table — its column widths are measured against `TABLE_CELL_PADDING_X_PX`. The Payment ID prints as `PaymentIdChip` (copy button; its click does not open the row). Search boxes use `.boe-list-search`, whose input has its own focus outline switched off because the box shows the ring (the global `:focus-visible !important` rule otherwise draws a second box inside it) |
| `/finance/payments-to-verify` | Same view, `surface="to_verify"`: the other three statuses; verification stays here; no classification views |
| `/finance/received/linked`, `/finance/received/unlinked` | **Retired** — forward (`router.replace`) to `/finance/received?view=…` preserving all other query params |
| `/finance/expenses`, `/finance/expenses/new` | Expense log; new-expense/quick-capture form |
| `/finance/notifications` | Finance notifications |

Nav (`FinanceLayout.tsx`): Payment Requests, Confirmed Payments (with count badge), Expenses. `?view=` is still *read* (fails closed to `all`) but no longer narrows the query.

### 3.2 API routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/finance/notify` | POST | Session user required (401). Events `finance_submitted`, `finance_resubmitted`, `finance_clarification`, `finance_approved_suspense`, `finance_approved_linked`, `finance_rejected`, `finance_linked`, `finance_status_corrected`. Service-role insert into shared `notifications` (`task_id` null, `entity_id` = record), admins via `role='admin'`, actor skipped, 2-minute `(user,type,title)` dedupe |
| `/api/finance/payments/delete` | POST | Admin-only payment deletion by durable claim: `begin_finance_payment_deletion` -> proof sweep (service role, manifest) -> `record_finance_payment_proof_removed` -> `finalize_finance_payment_deletion`; reason + typed Payment ID required; 401/400/502 error codes |
| (client RPCs used directly) | | `submit_payment_request`, `edit_payment_request`, `delete_own_payment_request`, `approve_finance_payment_request`, `reject_finance_payment_request`, `request_finance_payment_clarification`, `record_payment_with_allocations`, `record_pi_submission_payment`, `allocate_payment_to_target`, `allocate_payment_to_targets`, `reverse_payment_allocation`, `append_payment_custody_events`, `complete_payment_entry`, `received_payment_allocation_targets`, `finance_order_search`, `finance_order_lookup`, `finalize_expense_draft`, `record_expense_reimbursement`, `reverse_expense_reimbursement`, `expense_reimbursement_receipts` |

Also cross-module: Admin **Action Queue** reads `finance_payment_requests` (`src/lib/controlCenter/actionQueue.ts`); `/modules` launcher card; `/account` page derives Finance capabilities.

## 4. Database

### 4.1 Tables / views / sequences (first migration)

| Object | First migration | Notes |
| --- | --- | --- |
| `finance_payment_requests` | 20260628000200 | The payment ledger. Columns added over time: `order_id`, `order_request_id` (legacy), `request_number` (`PAY-REQ-<year>-NNNN`, `finance_payment_request_seq`, never reused), `human_payment_id` (`P-AA-0001` … `P-AZ-9999`, `P-BA-0001` …; 676 letter-pairs capacity, `finance_payment_human_id_seq`, immutable, never reused), `payment_mode`, `received_in` (nullable, unwritten since 20261013), `client_name` (nullable since 20261013: NULL = Suspense), `payment_target_type`, `deleted_at/by` (20270226), `is_test_data`, collection/handover legacy columns (frozen history), `proof_note`, `admin_note`, status-entry timestamps (`rejected_at`, `clarification_requested_at`) |
| `finance_payment_requests` activity: `finance_payment_request_activity_log` | 20260674 | Trigger-written; field edits with no status change are NOT logged by design (20260677) |
| `payment_proof_attachments` | 20260672 | proof metadata; bucket `payment-proofs` |
| `finance_payment_allocations` | 20260918 | `status` active/reversed; exactly one of `order_submission_id` / `order_id`; `origin_target_type`; amount > 0, = round(,2), not NaN; reversal needs by/at/non-blank reason; partial unique indexes: one active allocation per (payment, PI) and per (payment, Order). NO ACTION FKs everywhere |
| `finance_payment_allocation_intents` | 20261013 | "when this is verified, allocate it here"; never read by any total; converted at approval |
| `finance_payment_custody_events` | 20261014 | append-only; `collected` / `handed_over`; `handed_by_name` since 20270318 |
| `finance_payment_deletion_claims` | 20261010 | durable claim; tombstone fields (20261011) outlive the payment |
| `finance_payment_submission_keys` | 20261219 | idempotency key store (actor-scoped) |
| `finance_received_payments` (VIEW, `security_invoker = true`) | 20261004 → 20261008 → 20261012 → 20261216 | Confirmed Payments projection incl. classification columns (`order_allocated_total`, `pi_allocated_total`, `active_allocation_count`, `attribution_complete`, `available_balance`, `is_linked_to_order`, `is_linked_to_pi`, `is_available_to_allocate`, `confirmed_allocation_status`) and computed field `complete_allocation_status`. 20261004 asserts it stays security_invoker |
| `finance_payment_destinations` (VIEW) | 20261014 §8 | What a payment is FOR, derived from active allocations then pending intents, nothing else |
| `expenses`, `expense_categories` | 20261220 | |
| `expense_drafts` | 20261222 | quick-capture inbox ("Needs Details") |
| `expense_reimbursements`, `expense_reimbursement_items`, `expense_bill_attachments` | 20270205120000 | |
| Cross-module: `order_submissions`, `orders`, `notifications`, `test_data_cleanup_settings` | | |

Storage buckets: `payment-proofs` (private; 10 MB; jpeg, png, webp, gif, pdf; path `{submitter}/…`; read via `can_open_payment_proof` / `payment_proof_object_readable`), `expense-bills` (private; 10 MB; pdf, jpeg, png, webp; signed URLs only).

### 4.2 Statuses and enumerations
- `finance_payment_requests.status` (5): `pending_approval`, `approved_unlinked`, `approved_linked`, `needs_clarification`, `rejected`. Request-stage = first, fourth, fifth (`REQUEST_STAGE_STATUSES`); confirmed = the two approved (`CONFIRMED_PAYMENT_STATUSES`); the sets are disjoint and exhaustive and tested. **`approved_unlinked` vs `approved_linked` no longer carries the attribution meaning** — the badge and "Payment Against" are derived from allocations/intents; the two strings remain only as the stored verified status. No `converted`/`archived` status: **Archive = rejected rows aged >= 30 days** (client/DB-filter derived); `needs_clarification` older than 30 days shows a display-only "Stale" badge.
- `payment_mode` — CURRENT (new entries): `hdfc`, `pnb`, `paytm`, `canara`; LEGACY (storable, refused for new entries by `finance_payment_requests_enforce_current_payment_mode` and by the four entry RPCs): `bank_transfer`, `cash`, `upi`, `cheque`, `other`. The pre-20261014 account was named by the PAIR `(payment_mode, received_in)`; a bare legacy value cannot be mapped to an account and is never converted. Internal DB comment glosses (hdfc = current account, pnb = "Hawala", paytm = "Cash", canara = savings) are deliberately never rendered; UI helpers: HDFC "Company bank account — current account", Canara "… savings account", Paytm "Internal cash collection", PNB "External cash route".
- Payment destination (form concept, `src/lib/finance/paymentEntry.ts`): `pi_draft`, `confirmed_order`, `suspense` (Suspense = no target, null client, no allocation row).
- Allocation: `active` | `reversed`; Confirmed allocation status (computed): `zero`, `partial`, `full`, `over`.
- Custody activity: `collected`, `handed_over`.
- Expense payment mode (outgoing; own domain, CHECK): `cash`, `upi`, `bank_transfer`, `credit_card`, `debit_card`, `cheque`, `other`. `paid_from`: `company` | `personal` | NULL (= "not recorded", older expenses; never read as either).

### 4.3 Key RPCs and guards (latest definition = last migration that re-emits it)
| Function | Latest | Notes |
| --- | --- | --- |
| `submit_payment_request` (+ `_core` wrapper with `p_idempotency_key`) | 20261219 over 20261014 | Rejects `amount <= 0`, NaN, third decimal (CHECK + `finance_payment_requests_amount_is_rupees_and_paise` trigger). Client name derived server-side from the target |
| `record_payment_with_allocations`, `record_pi_submission_payment` (+ `_core`) | 20261219 over 20261014 | Atomic: payment + proof-ready row + custody + allocations; each wrapper calls `assert_finance_payment_door()` FIRST (actor active, Finance entry, permission) keyed or not |
| `complete_payment_entry(uuid)` | 20270120 | Last call of every Record Payment; verifies on the spot only for `verify_own_payment` holders |
| `approve_finance_payment_request(uuid, text)` | 20261118 (marker restored) | Needs `finance.approve`; submitter may not decide own unless `verify_own_payment`; converts intents to allocations; wraps UPDATE in `set_config('boe.finance_payment_verification', id, true)`. **Both `set_config` lines are load-bearing** (20261013 lost them silently; 20261118 restored them and asserts the DEPLOYED body) |
| `reject_finance_payment_request(uuid, text)`, `request_finance_payment_clarification(uuid, text)` | 20261211 | Same verifier gate; a reason is required; the direct-UPDATE route for rejection no longer exists |
| `edit_payment_request` | 20261013/14 | Owner edit of unverified; Reapply after rejection widens `own_update` USING to `rejected` (20260695) |
| `delete_own_payment_request(uuid)` | 20270226 | Soft delete, owner only, status in pending/needs_clarification/rejected, never approved (status, approved_at/by AND activity trail agree), re-checked under row lock; reverses (not erases) allocations; trigger `finance_payment_requests_freeze_deleted` freezes the row against EVERY update; restrictive SELECT policy hides deleted rows from every reader and the view; the owner hard-DELETE policy was dropped |
| `begin_/finalize_/release_finance_payment_deletion`, `finance_payment_deletable_by`, `finance_payment_requests_guard_approved_delete` | 20261011 / 20261218 | Admin only; **verified payments deletable only if `is_test_data`**; typed Payment ID + reason; storage manifest swept by the route |
| `allocate_payment_to_target` / `allocate_payment_to_targets` | 20261011 (§4) | Needs `finance.allocate`; capacity trigger: active total can never exceed payment amount; allowed on UNVERIFIED payments too (shows Awaiting Verification) |
| `reverse_payment_allocation` | 20260918 | Needs `finance.allocate_correct`; whole allocation; reason mandatory; row kept; a reversed allocation never becomes active again |
| `payment_allocation_ledger_for_correction(uuid)` | 20261215 | Complete ledger of ONE payment for an `allocate_correct` holder with Finance entry who can already read the payment (per-row allocation RLS would otherwise show a participant part of the ledger) |
| `received_payment_allocation_targets`, `complete_allocation_status`, `received_payment_visible_to_actor`, `received_payment_allocation_status` | 20261216 | Definer, STABLE; first two to `authenticated`, the latter two owner-only; the computed field takes the view's row type — a future `drop view finance_received_payments` must drop `complete_allocation_status` first |
| `append_payment_custody_events` (+ `_internal`) | 20261014 / 20270318 | Required people and times re-derived server-side; `payment_mode_requires_custody()` = `pnb`, `paytm` only |
| `finance_payment_status_is_verified`, `payment_active_allocation_totals`, `order_linked_payment_total`, `pi_submission_payment_summary`, `order_submission_*_payment*` | various | Verified totals; `pi_submission_payment_summary` per-payment `reference` reads `proof_note` (20270111120000) |
| `can_open_payment_proof`, `payment_proof_object_readable`, `can_read_payment_as_participant` | 20270118120000 / 20270221 | |
| `finalize_expense_draft` (+ paid-from params), `record_expense_reimbursement`, `reverse_expense_reimbursement`, `expense_reimbursement_receipts` | 20270205120000 | |
| `in_finance_payment_deletion_finalization`, `in_payment_allocation_release`, `in_pi_allocation_release`, `in_finance_payment_verification` | various | transaction-local contexts used by guards |

### 4.4 RLS / guard idea
- `finance_payment_requests`: RESTRICTIVE `module_entry_open('finance')` gate (20260905) AND permissive policies: own rows (submitter), admin, `finance.view_all`, participants of a PI/Order the allocation names (`can_read_payment_as_participant`). **Permissive UPDATE policies are OR-ed with USING and WITH CHECK ORed *separately*** — that is why 20261211 added `finance_payment_requests_guard_decision_status` (BEFORE INSERT/UPDATE pairing OLD/NEW status), `PAYMENT_SELF_DECISION_FORBIDDEN`, `FINANCE_NOTE_PROTECTED` (admin_note), and requires a reason for a direct rejection. Direct INSERT is revoked from anon and authenticated (20261219) — every payment is created through the RPC doors.
- Allocations: SELECT per row (admin, `view_all`, the payment's submitter, participants of the target). The allocation ledger is the ONLY financial attribution (20261012); a payment's own `order_id` is provenance worth ₹0.
- Guard triggers `finance_payment_requests_guard_approved`, `_guard_pending_decision`, `_guard_approved_delete`, `_guard_allocated_amount`, `_guard_deletion_claim`, `_advance_recheck`, `finance_payment_allocations_guard_{delete,transition,deletion_claim,pi_deletion}`, `finance_payment_custody_events_immutable`, `payment_proof_attachments_guard_deletion_claim`, `order_finance_reset_write_guard` (now owner-run, 20270117).
- Expenses: RESTRICTIVE `module_entry_open('finance')` gate; admin read/write; `view_all` read; own rows read/correct; `create` to insert; `manage` to correct others'; no hard DELETE for any client role (soft delete via tombstone columns, 20261222: delete = author or `finance.manage`); drafts read by author/`view_all`/admin.

### 4.5 Migrations (file names) and apply/immutability facts
Foundations: `20260628000200_create_finance_payment_requests`, `20260653/54` policies, `20260657/58` order link/payment-against, `20260670`–`20260678` (invariants, proof, numbering, activity log, status timestamps), `20260688`/`90`/`91`/`92` (optional proof, suspense approval, linking RPCs — linking RPCs are now retired in the UI), `20260694`/`95` (notification enum + entity_id; reapply after rejection), `20260698`/`99`, `20260700` (owner delete — superseded), `20260705` (protect finalized payments), `20260715` (targets), `20260716`/`17` (collection/handover — now frozen history), `20260901` (permission enforcement), `20260903` (view_all), `20260905` (module-entry gates), `20260918` (allocations), `20260919` (PI payment entry), `20260920` (approver can verify), `20261004`–`20261014` (allocation state, ledger source, destination model, custody/modes), `20261118` (marker restored), `20261211` (decisions belong to verifiers), `20261215`/`16`/`18`/`19`, `20261220`–`23`, `20270111120000`, `20270117`, `20270118120000`, `20270120`, `20270205120000`, `20270211120000`, `20270226`, `20270315`–`17` (cross-module deletion), `20270318`.

- Apply-state evidence **(from memory)**: 20260816-21, 20260705/06/16/17, 20260700 applied; 20261211 applied 2026-09-14 (ledger 258→259); 20261215 applied 2026-09-18 (ledger 262); 20261216 applied 2026-09-18; 20261217 and 20261218 applied 2026-09-18; 20270111120000 applied 2026-09-26; 20270318 applied 2026-10-17. 20261219/20261220 (merged PRs #172/#173 on this checkout): last recorded UNAPPLIED on 2026-09-19 — **not re-confirmed**; expense and reimbursement migrations (20261220–23, 20270205120000) have production-check SQL in `supabase/tests/expense_reimbursement_production_*.sql` implying they were applied before their PRs merged. Verify with `migration list --linked`.
- Never edit an applied migration (not even comments/header refs: e.g. 20261215's header cites `allocationLedgerRpc.test.ts` but the pin is in `allocationCorrection.test.ts`; correct in docs, not in the file). Forward-only; ~10 ledger-pin tests list every migration (see 9).
- `db push --linked` silently no-ops if `supabase/config.toml` has `[db.migrations] enabled = false` (gitignored local file) — set true, dry-run first.

## 5. Permissions and access

### 5.1 Registered actions (`src/lib/permissions/modules.ts`, module `finance`, "Finance")
`view` (module entry), `create`, `edit`, `delete`, `approve`, `export`, `manage`, `view_all`, `allocate`, `allocate_correct`, `verify_own_payment`.
Protected (no access level grants them; per-employee only; `PROTECTED_ACTIONS` in `levels.ts`): `delete`, `manage`, `view_all`, `allocate`, `allocate_correct`, `verify_own_payment`. **`approve` is NOT protected**: the access-level preset `manager` = `view, create, edit, approve, export` (`STANDARD_LEVEL_ACTIONS`), so choosing "Manager" for someone in Finance hands them payment verification — a deliberate choice recorded in `levels.ts` (removing it would take verification from every Finance manager). Dependency: `verify_own_payment` requires `approve` (ACTION_DEPENDENCIES); `view_all` chain resolves to `view`.

### 5.2 Capability derivation (`src/lib/permissions/finance.ts`)
Admin role: all twelve capabilities true. Others: entry = `view`; every capability needs entry + its own action: `canViewAllFinance`=view_all, `canCreatePaymentRecord`=create, `canEditPaymentRecord`=edit, `canApprovePayment`=approve, `canExportFinance`=export, `canCorrectOrReversePayment` & `canManageFinance`=manage (two names, one action today), `canDeletePaymentRecord`=delete, `canAllocatePayment`=allocate, `canCorrectPaymentAllocation`=allocate_correct, `canDecideOwnPayment`=verify_own_payment. **The file's header says "NOT YET WIRED" — stale**; it is used by `finance/page.tsx`, `ReceivedPaymentsView`, expenses pages and `/account`.
`enforcement.ts` declares Finance as `partial` with enforced actions `view, approve, manage, delete, view_all` only; `allocate`, `allocate_correct`, `verify_own_payment` are enforced in the DATABASE but not declared there.

### 5.3 Who can do what
| Action | Gate (database is the authority) |
| --- | --- |
| Open Finance | effective `finance:view` (layout guard) + RESTRICTIVE RLS `module_entry_open('finance')` |
| See a payment | own, admin, `view_all`, or participant of the PI/Order it is allocated to |
| Send a Payment Request / Record Payment | `finance.create` via `assert_finance_payment_door` (active user, Finance entry, permission) |
| Edit own unverified request; Reapply a rejected one | submitter (`own_update`; rejected rows reapply to `pending_approval` only) |
| Delete own request | submitter, never-approved only, soft delete (20270226) |
| Verify / reject / ask clarification | `finance.approve` AND not the submitter (unless `verify_own_payment` or admin) |
| Edit a Confirmed Payment | `finance.manage` (and post-approval guard) |
| Allocate | `finance.allocate` (+ visibility of the target); mixed-customer sets need explicit confirmation |
| Reverse an allocation | `finance.allocate_correct` (admin bypass) |
| Delete a payment permanently | active admin only; verified ⇒ test data only; claim protocol |
| Attach proof | submitter while `pending_approval` (storage policy) |
| Open a proof | recorder, role admin, `finance.approve`, `finance.view_all` (each with entry) — participants cannot |
| Expenses | see 4.4; reimbursement batches need `finance.manage` AND (`view_all` or role admin) |

Production holder census **(from memory, 2026-09-07/26; re-check)**: `finance.approve` + `view_all` held by the second (manager-role) admin; `verify_own_payment` registered ungranted until the owner grants it in Control Center ("grant per person").

### 5.4 Notifications
Shared `notifications` table with type-prefixed visibility (`finance_%`), resolver `src/lib/notificationMeta.ts`: `finance_approved_suspense|approved_linked|linked` open `/finance/received?payment=<id>`; all other finance types open `/finance?tab=all&request=<id>`. Adding an event = enum value (migration) + a case in `/api/finance/notify` (store `entity_id`) + badge/href in `getNotificationMeta`. Client helpers `src/lib/notify.ts` are fire-and-forget and log `[notifyFinance] <event> not delivered (HTTP …)` in dev. The enum is a strict PG ENUM — an unknown type silently fails (the original feature "never worked" until 20260694 applied).

## 6. Business rules (exact)

### 6.1 Money handling
- Amounts are rupees and paise; **never silently rounded**. `sanitizeAmountInput` strips only space, comma, ₹ and never truncates; `amountInputProblem` explains refusals. Payments: CHECK amount > 0, finite, `= round(amount, 2)`; allocations the same; expenses `numeric(14,2)` PLUS a CHECK that actually refuses (20261221 — a scaled numeric rounds on assignment, so the first CHECK was dead code). Display: `formatMoney` always 2 decimals (`₹7,50,000.00`, en-IN) — the ONE formatter; exact arithmetic in `exactMoney.ts` (string decimals), never floats.
- The unallocated balance of a payment is **derived, never stored**: `amount − sum(active allocations)`. `allocated_total` on the view can be understated for a participant without `view_all`; Confirmed Payments therefore uses `complete_allocation_status` and the targets RPC (20261216). The raw `allocated_total` column still follows per-row allocation RLS (carry-over for "Phase 2", from memory; not fixed).
- Over-allocation is refused by capacity triggers; `summarizePaymentAllocations` floors `unallocated` at zero when `comparison >= 0`, so an over-allocated payment renders "Over the payment by ₹0.00" instead of the excess (pinned as a known limitation).

### 6.2 Lifecycle of a payment
1. **Recorded** — Payment Request form (destination `pi_draft` / `confirmed_order` / `suspense`, account, date, amount, optional proof/reference) or Record Payment (split across several destinations in ONE transaction: every row or none). Status `pending_approval`. A request naming a PI/Order stores an **intent**, never an allocation (unverified money must not count toward totals or the 40% gate).
2. **Decision** by a verifier: Verify (`approved_*`, intents converted to active allocations), Needs Clarification (note to submitter), or Reject (reason mandatory). The submitter edits and re-submits; a rejected request may be Reapplied.
3. **Confirmed** — appears in Confirmed Payments; remaining money is allocated with Allocate Funds (many targets, atomic) or Allocate Payment; wrong allocation fixed by Correct Allocation (reverse whole allocation with reason, then allocate again).
4. **Permanent** once verified (test data excepted): no delete, no un-verify. Wrong verified money is meant to be handled by Void/Refund/Correction later — not built.
- Duplicate protection: `p_idempotency_key uuid` (actor-scoped advisory lock + stored result + payload fingerprint); same key with different payload ⇒ `PAYMENT_IDEMPOTENCY_KEY_REUSED`; NULL key still accepted (old clients) but is authorised identically. Browser side: `src/lib/finance/submissionAttempt.ts` (sessionStorage key + hash + time), "Retry proof upload".
- Payment Phase history/rules: `docs/Module Docs/FINANCE_ORDER_WORKFLOW.md` §9a–§19 and `PAYMENT_PHASE_PROGRESS.md`.

### 6.3 Separation of duties
- The person who recorded a payment cannot approve/reject/clarify it (`PAYMENT_SELF_DECISION_FORBIDDEN`) unless they hold `verify_own_payment` (or are role admin: the guard's admin early-return is unchanged). A holder's own payments are verified at the end of recording via `complete_payment_entry`, and the other holders are notified for information only. `admin_note` is protected from submitters (`FINANCE_NOTE_PROTECTED`).
- Deciding which business money belongs to (`allocate`), reversing that (`allocate_correct`) and verifying (`approve`) are three independent authorities.

### 6.4 Corrections and mixed customers
- Correct Allocation is whole-allocation only; the allocation row is kept as reversed history (who, when, why); the payment row is untouched; released money is reassigned with Allocate Funds.
- A payment may cover several customers **only on purpose**: Record Payment / Allocate Funds warn, list the customers and require explicit confirmation of that exact set; never blocked for that reason; no customer name is typed or overwritten; the payment displays "Multiple customers" (`MULTIPLE_CUSTOMER_LABEL`); a Suspense payment shows "Not identified". Users without `allocate_correct` get an "existing customers unknown" confirmation in Allocate Funds (known trade-off).

### 6.5 Custody (PNB and Paytm only)
- Append-only trail "Collection & Handover Activity": `collected` (collected_by BOE user) and `handed_over` (handed_to BOE user; handed_by is EITHER a BOE user OR a typed outside name ≤120 chars, exactly one, 20270318). Date AND time (`occurred_at`), bounded against the future by the RPC. Corrections = add a new activity; nothing edits. Natural-duplicate unique index falls back to a zero uuid so a NULL does not defeat double-click protection.
- The five legacy collection/handover columns are frozen history; `legacyCustodyEvents` projects them into the same shape.

### 6.6 Deletion
- Verified ⇒ permanent unless `is_test_data`. Unverified/non-test: admin only through the claim protocol (reason + typed Payment ID, proof manifest sweep). Owner may soft-delete their own never-approved request (20270226): history, allocations (reversed), proofs and ids kept; `human_payment_id`/`request_number` never reused. When a PI is deleted, reversed allocations of such soft-deleted never-approved payments are erased with it (20270315); anything else still blocks (`ALLOCATION_PERMANENT`).
- `docs/releases/payment-request-owner-soft-delete-release.md` is the rollout record.

### 6.7 Expenses
- Fields: `expense_date`, `amount` (> 0, 2 dp), `payment_mode` (7 outgoing values), `paid_to` (trimmed, ≤120), `category_id` (NO ACTION FK; categories are retired, never deleted; names unique case-insensitively across active and retired), `remark` (≤500), `paid_from` company|personal (+ `paid_by` when personal), `reimbursement_id`. **A NEW expense must state `paid_from`** (trigger `expenses_require_payment_source`, 20270211120000; no CHECK so older rows stay correctable; recorded source can never revert to NULL).
- Quick Capture: free text/voice (browser Web Speech, deterministic offline parser, never auto-saved; "nothing is invented") → `expense_drafts` ("Needs Details", author only) → `finalize_expense_draft` makes exactly ONE expense idempotently. Drafts never reach totals or the category suggester.
- Reimbursement: a batch pays ONE payer; items freeze the expense's amount/source/payer; reimbursed expense cannot be deleted; reversal keeps the batch (expenses return to pending); partial unique index on items is the second guard; paying on someone else's behalf needs `finance.manage`.
- An expense touches none of payments, allocations, proofs, Orders or PIs (structural separation, asserted by the migrations).

### 6.8 Order-side consequences (owned by Orders, summarised)
Only verified allocations count toward 40% of **Total before GST** (see 01-orders 6.2); a PI cannot become an Order while any attached payment awaits a decision; allocations move PI→Order at approval (same ids).

## 7. Key components and lib files

- Pages: `src/app/finance/page.tsx` (**946 lines** since 2026-10-18; the rest lives in siblings `paymentRequests{Model,Atoms,Details,New,Edit,AdminReview,Table}.tsx` — `PaymentsTable`, `DetailsModal`, `NewPaymentConfirmationModal`, `EditPaymentModal`, `AdminReviewModal`; `FinancePageInner` stays), `received/ReceivedPaymentsView.tsx` (**1,468 lines**; siblings `received/receivedPayments{Model,Atoms,Panel,Details,Edit,RowActions,Table,Lists}.tsx` hold `DetailsModal`, `AllocationPanel`, `EditPaymentModal`, the table/cards/row actions; `AllocationPanel`, `DetailsModal`, `ReceivedPaymentsTable`, `AllocatedAgainstCell`, `ConfirmedPaymentsList`, `ReceivedPaymentsCards`, `ConfirmedListEmptyState` are re-exported from the view). **A split screen leaves `// @split:` markers; source-text tests read the screen with the pieces put back (see `docs/testing/writing-tests.md`), so run tests with `npm test` / `npm run test:file -- <path>`, never bare `tsx --test`.**, `received/{AllocateFundsModal,AllocatePaymentModal,CorrectAllocationModal,RecordSplitPaymentModal,RetiredReceivedRoute}.tsx`, `expenses/{ExpensesView,ExpenseForm,QuickCapture,NeedsDetailsList,SmartCategorySuggestions,ExpenseBills,ExpenseReimbursementModals,DeleteExpenseModal,useExpenseSpeech}`.
- Shared UI: `src/app/finance/components/{AmountInput,PaymentEntryFields,PaymentFormParts,PaymentDestinationBlock,CustodyTrailFields,ProofReferenceSection,PaymentModeHint,MixedCustomerWarning,DiscardGuard,FinanceModalShell}`; `src/components/finance/{CustomerName,DeletePaymentModal,DeleteOwnPaymentRequestModal}`; layout `src/components/layout/FinanceLayout.tsx`; guard `ModuleGuard`.
- Query modules: `src/app/finance/{paymentRequestsQuery,receivedPaymentsQuery,listQuery}.ts` (page size 50; a list with no `.range()` is silently truncated at PostgREST's 1000 rows), `paymentRouting.ts`, `paymentTargets.ts`, `paymentIntents.ts`, `paymentDestinations.ts` (historical account reading), `src/lib/finance/*` (38 source files): `paymentEntry` (vocabulary), `paymentClassification`, `paymentAllocations`, `allocatedAgainst`, `allocationCorrection`, `mixedCustomers`, `custodyTrail`, `paymentDecision`, `reviewDecision`, `paymentDeletion`, `paymentDeletionProtocol`, `ownPaymentRequestDeletion`, `rowActions`, `paymentSurfaces`, `paymentProof`, `paymentActivityLabels`, `exactMoney`, `submissionAttempt`, `splitPaymentEntry`, `orderFinancePosition`, `piPaymentView`, `crossModuleLinks`, `notificationDedup`, `expenses`, `expenseDrafts`, `expenseVoice`, `expenseCategoryMatch`, `expenseReimbursements`, `expenseDeletion`; permissions `src/lib/permissions/{finance,levels,modules,enforcement}.ts`; `src/lib/currency` (`formatMoney`, `sanitizeAmountInput`, `amountInputProblem`, `isValidAmount`); `src/lib/paymentProof`; `src/lib/notify.ts`; `src/lib/notificationMeta.ts`; `src/lib/controlCenter/actionQueue.ts`.

## 8. Decisions made and why (owner decisions)

- **Allocation ledger is the single financial source** (20261012): two answers to "how much is this Order's money" (view fallback to `order_id`) was removed. Payment-row linkage (`order_id`, `order_request_id`) is provenance only; Link/Unlink to an Order were removed from the product.
- **One payment, many destinations**; unallocated balance derived, never stored; reversal never deletes.
- **Three entry destinations only** (PI Draft, Confirmed Order, Suspense); no customer name typed by a human (derived server-side); no payer-name field (owner 2026-09-18: not wanted); no "Sample Order" type.
- **Four BOE accounts as payment modes** (HDFC, PNB, Paytm, Canara) with custody trail for the two cash routes (PNB external, Paytm internal) — an event log replaced five single-event columns because it could not hold a second hand-off or the time of day.
- **Verified payments are permanent** (owner 2026-09-18 go-live; test data excepted); wrong ones to be Void / full Refund / partial Refund / Customer credit / Correction by admin or a named partner via permission; one person is enough; bounce not needed; refund records date, amount, mode, reason and reduces the Order's paid and product values; customer credit = money stays unallocated, labelled with the customer name. **Not built.**
- **Admins have equal authority** (owner 2026-09-26): a payment an authorised admin records is saved AND verified in one action; other admin informed only; who holds the authority is a Control Center grant (`verify_own_payment`), never code.
- **Staged payments**: optional per Order, no fixed pattern, **no reminders** (not built).
- **Sales-facing deletion**: salesperson may remove their own never-approved request (soft); verified is untouchable; admin hard deletion by claim only.
- **Expenses are structurally separate from receipts** (own domain for payment mode; own tables; no shared vocabulary); small first-class capture on a phone; **bills in a private bucket with signed URLs**; reimbursement is reversal-not-toggle.
- **Idempotency before launch** (PR #172): a lost response must not record money twice; a browser check is a convenience, never a boundary.
- **Verification state is a property of the payment, never of the allocation.**
- **Dates**: `handed_over_at` is no longer derived/required for the new custody model; the old "derived from payment_date" rule applied only to the frozen 20260716 columns.

## 9. Known traps, gotchas and unfixed defects

1. **OR-overlap RLS** on `finance_payment_requests` (fixed by 20261211): permissive UPDATE policies OR their USING and WITH CHECK separately. Any new permissive policy on this table needs the decision-status trigger kept in step.
2. **Verification marker**: `approve_finance_payment_request` must keep both `set_config('boe.finance_payment_verification', …)` lines; re-emitting the function from an old body silently breaks non-admin approvers (`Payment <n> may be approved or rejected, not edited`, 42501). Assert the marker on the DEPLOYED body in any re-emit (a text test is not enough).
3. **Plpgsql caches a trigger's EXECUTE check per transaction** — after a definer RPC runs the guard, a direct UPDATE in the SAME transaction passes. Prove "not widened" in its own transaction.
4. **Write guard not SECURITY DEFINER** (found 2026-09-19: every direct client write to 16 guarded tables fails because `authenticated` lacks EXECUTE on `in_test_data_cleanup()`): **fixed on this checkout by 20270117** (apply-state unverified). Proof-attach, status corrections, ReceivedPaymentsView edits and Order status UPDATE depend on it.
5. **Fixture trap**: a verifier fixture needs `finance.view_all` or RLS hides other people's payments and every probe silently matches zero rows (a probe that only catches exceptions then reports "allowed"). Assert that the row actually changed. `supabase/tests/finance_payment_verification_assertions.sql` is stale (creates an Order Request) and fails at the fixture.
6. **Stale code comments**: `paymentDeletion.ts` header says self-delete is withdrawn (20261011) — 20270226 reintroduced owner soft-delete; `finance.ts` header says not wired; `rowActions.ts` says Delete is "admin-only, any status" — `canDeletePayment` now refuses real verified payments; `paymentDestinations.ts`/memory describe the pre-20261014 pair model (still needed to READ history).
7. **Status strings lie**: `approved_unlinked` can be a fully allocated Order payment (20261014 §A); never branch on it for attribution — read the allocation projection (`finance_payment_destinations`, `finance_received_payments`).
8. **security_invoker view**: `finance_received_payments` must stay `security_invoker = true` (asserted in 20261004); a participant without `view_all` sees an understated `allocated_total`. `create or replace view` is fine; `drop view` must first drop `complete_allocation_status`.
9. **Lists without `.range()` are silently truncated at 1000 rows** (`fetchAllRows`); `listQuery.ts` enforces page size 50.
10. **Ledger-pin and shape pins**: `participantAndOrderTotalSecurity.test.ts` (two lists), `orderFinanceTestReset`, `orderReservedPiGateAndBoeItemCodes`, `piFinanceVerificationRemoval`, `custodyTrail.test.ts`, … list every migration; `src/app/finance/expenses/expenseSurfaces.test.ts` has `ALLOWED_*` file sets wired into `isUnexpectedFile` AND the later `|| ALLOWED_X.has(file)` chain — a new Finance-touching file must be added to a set; `draftsAccess.test.ts` keeps a closed list of finance helpers the PI page may import; `paymentVerificationModal.test.ts` pins `AdminReviewModal` structure (now RPC-based); `orderStartupShape` pins Finance-adjacent reads on Order pages.
11. **Custody dedupe**: unique indexes treat NULLs as distinct — the 20270318 `coalesce(…, zero uuid)` pattern is the fix; copy it for any new natural-key index.
12. **Windows/tooling**: `tsx --test` treats `[id]` paths as globs (silently runs 0 tests); `git worktree remove --force` deletes ignored `.env.local`; a `node_modules` junction breaks Turbopack (`next dev --webpack`) and must be deleted before removing a worktree; legacy `eyJ` Supabase keys are disabled (new publishable/secret keys needed locally).
13. **Never run `npm test` with a real `.env.local`** — five+ live-DB suites write fixtures to the only configured project (production). Blank the env: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=offline`. `REQUIRE_LIVE_DB_TESTS` flips skips to failures. Never run two suites at once.
14. **Classifier/CLI**: `supabase db push` and production rehearsals need explicit per-action user approval; the user ran `db push` in their own terminal. `supabase db query` is not psql (no meta-commands, no NOTICE).
15. **Merge = production deploy** and `main` requires up-to-date branch + Vercel check; stacked PRs merged into their bases AFTER the bottom was squashed never reach main (#319 had to be re-landed as #320).
16. **Expense `paid_from` NULL** is "not recorded", not company; never treat as either.
17. **`PaymentRequest` dev-only notify failures**: client notify helpers never throw, so a broken enum shows only as a dev console line.
18. **Payment Requests "Archive" and "Stale" are derived from timestamps** (`rejected_at`, `clarification_requested_at`, fallback `updated_at`); boundary is >= 30 days; a row with no timestamp counts as active.
19. **Full-suite baseline drift**: clean main reached 31–33 failures by Oct 2026 and was cleared by #327 (5c39ee5a, per commit message and memory). A branch that fails a test that also fails on a pristine main worktree is not necessarily its fault — diff failure lists against a pristine worktree.

## 10. Tests that guard it

Run: `npm test` (see 01-orders section 10 for the offline-env prefix), or `npx tsx --test "src/lib/finance/*.test.ts" "src/app/finance/**/*.test.ts*" "src/components/finance/**/*.test.ts*"`. Behaviour of SQL is proven by `supabase/tests/run_*.sh` (Docker `postgres:16-alpine`, `bash` + `coreutils` + `python3`, strip CRLF first; the harness uses `harness.try(sql)` / `harness.as_user(uuid)`).

| Area | Files |
| --- | --- |
| Entry vocabulary / forms | `src/lib/finance/paymentEntry.test.ts`, `splitPaymentEntry.test.ts`, `paymentIdempotency.test.ts`, `launchAuditFixes.test.ts`, `src/app/finance/{paymentRequestForm,paymentFormsRecordEdit,paymentFormsRemaining,paymentDestinations,paymentRouting,paymentTargets,paymentRequestsQuery,receivedPaymentsQuery,proofReferenceSection,paymentVerificationModal}.test.ts`, `amountEntry.render.test.tsx`, `paymentRequestsTable.render.test.tsx` |
| Allocation / classification | `allocatedAgainst`, `allocationCorrection`, `attributionParity`, `classificationParity`, `paymentAllocations`, `paymentAttribution`, `paymentClassification`, `paymentCommercialTotals`, `paymentTotalsRpcSecurity`, `commonPaymentLinkage`, `mixedCustomers`, `orderFinancePosition`, `piPaymentView`, `crossModuleLinks`, `destinationRecordHref`, `src/app/finance/received/{allocatedAgainst,allocationPanel,correctAllocation}.render.test.tsx`, `paymentsPaging.test.ts` |
| Decisions / security | `paymentDecision`, `reviewDecision`, `participantAndOrderTotalSecurity`, `verifiedPaymentPermanent`, `paymentSurfaceAccess`, `paymentProofViewMigration`, `paymentReferenceMigration`, `src/lib/permissions/{finance,splitPaymentEntryAccess,levels,registry,enforcement}.test.ts` |
| Deletion | `paymentDeletion`, `paymentDeletionProtocol`, `paymentDeletionSurfaces`, `ownPaymentRequestDeletion.test.tsx`, `paymentCancelledLinks` |
| Custody / activity | `custodyTrail`, `paymentActivityLabels`, `notificationDedup` |
| Expenses | `expenses`, `expenseDrafts`, `expenseVoice`, `expenseCategoryMatch`, `expenseEditMapping`, `expenseDeletion`, `expenseReimbursements`, `exactMoney`, `src/app/finance/expenses/{expenseSurfaces,expenseListLoad}.test.ts`, `expense*.render.test.tsx` |
| SQL suites | `finance_payment_allocation_assertions`, `allocation_ledger_single_source_assertions` (+ `run_allocation_ledger_single_source_suite.sh`), `payment_allocation_ledger_assertions`, `payment_entry_destination_model_assertions`, `payment_entry_privileges_assertions`, `payment_custody_and_modes_assertions` (+ privileges), `payment_idempotency_assertions`, `finance_payment_rejection_assertions`, `received_payment_allocation_targets_assertions`, `verified_payment_permanent_assertions`, `payment_request_owner_soft_delete_assertions`, `admin_payment_deletion_and_payment_id_assertions`, `finance_received_payments_allocation_state_assertions`, `financial_amount_invariants_assertions`, `payment_classification_assertions`, `payment_attribution_assertions`, `payment_participant_security`, `expense_lifecycle_assertions`, `expense_reimbursement_assertions`, `expense_reimbursement_source_required_assertions` |
| Permission registry drift | `npm run permissions:check`; fix with a targeted migration (e.g. 20261111), never `permissions:sync` |

## 11. Open items / next planned work

- Void / full + partial Refund / Customer credit / Correction for verified payments (Phase 2 of the allocation plan, with adjustments and **net received** calculations); fix `allocated_total` understatement for participants at the same time.
- Confirm apply-state of 20261219 → 20270117 and 20270317 (cross-module) via the migration ledger.
- Signed-in smoke checks still owed per memory: a `finance.view`-only participant on Confirmed Payments; the correction flow in the UI as a non-admin; the 20261219 idempotent retry paths in a real browser.
- Cosmetic carry-overs recorded in memory (unverified here): at 320px the toolbar's second date input overflows by 11px; the detail modal's AllocationPanel may name a target "A PI Draft" while the row says the PI reference (labels from an old per-row probe).
- Refund-related UI copy and the custody natural-key index pattern should be reused when new append-only event tables are added.
- Go-live owner decisions (from memory, 2026-09-18) still open: whether the 22 per-employee Orders/Finance grants of the partner stay as Control Center overrides (yes, removable); remove the Test login; clean test data and permanently disable cleanup.

## 12. Recheck before changing this module

Read first:
1. `supabase/migrations/20261014000000_*` (modes, custody, destinations — the biggest file), `20261013000000_*` (intents), `20260918000000_*` (allocation spine), `20261211000000_*` (decision guard), `20261219000000_*` (doors, idempotency), `20270120000000_*` (self-verification), `20270226000000_*` (soft delete), `20261218000000_*` (permanence), `20270117000000_*` (owner-run guards).
2. The LAST definition of every function you touch (`grep -l "create or replace function public.<name>" supabase/migrations/*.sql | tail -1`), then check later `alter function` pins (`20270213*`), and compare with `pg_get_functiondef` on a read-only connection. Use a script to extract a body; never retype it.
3. `src/lib/permissions/{finance,levels,modules,enforcement}.ts`, `src/app/finance/paymentRouting.ts`, `src/lib/finance/{paymentEntry,paymentClassification,allocatedAgainst,paymentSurfaces,rowActions}.ts`.
4. Tests to run: `npx tsx --test "src/lib/finance/*.test.ts" "src/app/finance/**/*.test.ts*" "src/lib/permissions/*.test.ts" "src/lib/orders/*.test.ts"`, then full `npm test` with the offline env; the relevant `supabase/tests/run_*.sh`; `npm run permissions:check`.
5. Read-only production checks before/after (`supabase db query --linked`, plain SELECTs; or `begin; set local role authenticated; select set_config('request.jwt.claims', …); …; rollback;` for RPC-as-user): `migration list --linked`; row fingerprints of `finance_payment_requests`, `finance_payment_allocations`, `payment_proof_attachments` (unchanged across a migration); `pg_get_functiondef` md5 of the RPC you changed; `has_function_privilege('authenticated', …)` for any new function (anon must not hold EXECUTE — `from public` does not remove Supabase's default explicit anon grant, as 20261223 learned).
6. Any new migration: add it to every ledger-pin test; filename should say what it touches (`order_submission` if it writes PI tables); give it a self-assertion block and EXECUTE it on a disposable DB; add new money columns with rupee-and-paise CHECKs and refuse rather than round; new append-only table = no UPDATE/DELETE policy plus a trigger; new function = `revoke … from public, anon` and explicit `grant … to authenticated`.
7. UI changes: keep `formatMoney` as the only money formatter; list screens must paginate; actions a reader may not take are ABSENT, not disabled; do not refactor `AdminReviewModal`/`PaymentsTable` without reading `paymentVerificationModal.test.ts` and `paymentRequestsTable.render.test.tsx`; add any new Finance file to `expenseSurfaces.test.ts` ALLOWED sets.
8. Release order: migration first, then merge (merge = production deploy); verify the deploy through the GitHub deployments API and by grepping the bundle for new strings; ask the owner before merging or applying.

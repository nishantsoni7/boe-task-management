# Review Workflow

**Current phase: Custom Reviews only.** Candidates submit Custom Reviews for
approval; the generated / booked review workflow is **paused for candidates**
and kept intact for later.

| | |
| --- | --- |
| Route | `/customer-reviews` |
| Module key | `customer_review_requests` (permissions `use`, `verify`) |
| Custom Review migrations | `20261205000000_customer_review_custom_submissions.sql` — **applied** · `20261206000000_customer_review_custom_reapply_and_monthly_rules.sql` — **in the repository, NOT yet applied** (`supabase migration list --linked`, 2026-09-13: remote head `20261205000000`) |
| Test-record purge migration | `20261209000000_customer_review_test_card_admin_purge.sql` — **in the repository, NOT applied** (§22) |
| Credits | `docs/Module Docs/BOE_CREDITS.md` |

> **Why the route and the module key still say "customer review".** They are
> identifiers. Every Control Center grant is written against the module key,
> and renaming it would silently revoke all of them. The display name is
> "Review Workflow".
>
> **Earlier versions of this document** described the October 2026 internal
> test-card rehearsal and then the generated-review workflow as the product. That
> is no longer the active candidate journey. What is worth keeping about it is in
> the **Historical** appendix at the end.

---

## 1. Purpose

Employees arrange genuine customer reviews for BOE — a written review or one
with photos — and hand over proof that each was published. A reviewer checks
the proof and approves or rejects it. Approved reviews earn **BOE Credits**,
under monthly rules that reward steady work and a mix of Image Reviews.

## 2. The current phase — Custom Reviews only

* A candidate's Review Workflow is **one screen** with **one primary action**:
  **Submit Custom Review**.
* The generated-review workflow (Generate → Assign → Book → Share → Submit →
  Verify) is paused for candidates — no screen offers it and the database refuses
  a candidate's booking (§16). Nothing about it was deleted (§17).
* Reviewers (holders of `verify`) keep every screen: the Custom Submissions
  queue, and the generated-review screens for audit and for finishing reviews
  already submitted.

## 3. Candidate workflow

`/customer-reviews` → **My Reviews** (`CustomReviewsScreen` →
`CustomReviewSubmissions`):

1. **The rules**, beside the button, from the live settings: *Text Review: 1
   credit · ₹50*, *Image Review: 1.5 credits · ₹75*, *1 Credit: ₹50*, *Monthly
   minimum: 3 approved reviews*, *Maximum submissions: 10 a month*, *Minimum
   Image Reviews: 3 a month*.
2. **Submit Custom Review** opens one short form: Review Type (Text / Image),
   Review Published On, Screenshot / Proof, Remark (optional) → **Submit for
   Approval**. A type the monthly rules do not allow is disabled, with the
   reason; when the monthly maximum is reached the button is disabled and says so.
3. The review is listed as **Pending Approval**.
4. **This month** and **Last month** panels (§15).
5. **Your submissions**: every review with its status. A **Rejected** review
   shows the reason, when it was rejected and by whom (when the name can be
   read), **View Proof** (proof, facts and the full history) and **Edit &
   Reapply** (§7).

Nothing is stored until Submit for Approval. The unsaved form is the only draft.

## 4. Reviewer workflow

`/customer-reviews/custom` → **Custom Submissions** (verifier only):

1. Tabs **Pending Approval · N**, **Approved**, **Rejected**. Pending is oldest
   first.
2. **Open & Decide** shows the screenshot large, the facts, a **Reapplied after a
   rejection** panel with the employee's note when it applies, and the
   **History** (submitted, rejected + reason, reapplied + note, approved).
3. **Approve · +1 credit** (or +1.5 for an Image Review) posts the configured
   reward. A BOE Credits administrator may type a different amount; a verifier
   confirms the configured one.
4. **Reject** requires a reason; the employee sees it and can correct and
   reapply.
5. Nobody decides their own review — administrators included.

A notification (§8) opens `/customer-reviews/custom?submission=<id>`, which
loads that review and opens it.

## 5. Text vs Image reviews

`review_type` is `text` or `image`, stored on the submission and chosen by the
candidate. It decides:

* the reward (`review_reward_credits` for text, `image_review_reward_credits`
  for image) — never both;
* the monthly image requirement (§12).

A candidate may change the type when reapplying; turning an Image Review into a
Text Review is checked against the image requirement.

## 6. The lifecycle

```
(form — nothing stored)
        │ Submit for Approval                       ← candidate, POST route
        ▼
pending_verification  ("Pending Approval")
        │ approve_customer_review_custom_submission ← reviewer
        ├──────────────────────────────► approved   (final; one review_reward)
        │ reject_customer_review_custom_submission  ← reviewer, reason required
        ▼
rejected
        │ reapply_customer_review_custom_submission ← the SAME candidate, PATCH route
        └──────────────────────────────► pending_verification (same row)
```

The stored value `pending_verification` is displayed as **Pending Approval**;
it keeps its stored name because it is the audit history's word. The guard
trigger `customer_review_custom_submissions_guard` enforces the moves: a pending
row may be decided once; a rejected row may only be reapplied (its corrections,
counted once); an approved row changes only through an employee edit (§23), which
keeps its credit held; nothing is ever hard-deleted (an employee's delete is a soft delete, §23).

## 7. Reapply

* **Who:** only the submitter (`submitted_by = the session user`), refused with
  `CUSTOMER_REVIEW_CUSTOM_NOT_OWNER` otherwise — administrators included.
* **From:** only `rejected`. An approved review is refused; a review already
  pending returns `already_pending` and changes nothing (a retry).
* **What may change:** review type, published date, remark, screenshot
  (optional — the current one is kept), and an optional note (≤ 500 characters)
  on what changed.
* **The same row.** `submission_ref`, `submitted_by` and `submitted_at` never
  change. `reapplication_count` goes up by one and `last_reapplied_at` is set.
  The rejection's who / when / why leave the row (a pending row cannot carry
  them) and stay in `customer_review_custom_submission_events`.
* **The old screenshot is kept** in the private bucket; the history names it.
* **The slot:** a reapplication takes no new monthly slot (§11).
* **A closed month:** a review whose month lapsed cannot be reapplied (§10).
* After reapplying: Pending Approval again, no further editing, reviewers
  notified as a reapplication, the pending badge goes up.

## 8. Notifications

| Type | When | Title |
| --- | --- | --- |
| `customer_review_submitted` | a custom review is submitted | *Ashok Choudhary submitted a custom Image Review for approval.* |
| `customer_review_reapplied` | a rejected review is reapplied | *Ashok Choudhary reapplied a rejected custom Text Review for approval.* |

* **Written by the database**, by the trail trigger on
  `customer_review_custom_submissions`, in the same transaction as the change.
  A failed submission writes none; a duplicate or a retry that changes nothing
  writes none; a decision writes none.
* **Recipients** (`customer_review_custom_reviewer_ids`): every active,
  non-deleted user who resolves `customer_review_requests.verify` through the
  permission engine, **except the submitter**. No role name and no person is
  hard-coded.
* The shared `notifications` table, `task_id` null, the SUBMISSION id in
  `entity_id`, the reference (and the reapplication number) in `body` — never
  the review content or the note. `is_push_sent = true`: in-app only.
* Category `review` → feed `/customer-reviews/notifications` (the shared
  `NotificationsView`) and the Notifications entry in the Review Workflow sidebar
  for verifiers. The link opens the review in Custom Submissions.

## 9. The pending badge

* The **Custom Submissions** sidebar entry shows the number of reviews in
  `pending_verification` — nothing else (not approved, not rejected, not
  generated reviews).
* `useCustomReviewPendingCount(canVerify)`: one head count under RLS (a verifier
  reads every row), TanStack key
  `['customer-reviews','custom-submissions','pending-count']`, 30 s stale time —
  the same pattern as Finance's sidebar counts. Hidden at 0.
* Only asked for, and only drawn, for a verifier.
* Approving, rejecting (Custom Submissions) and submitting or reapplying (the
  candidate workspace) invalidate the key, so the number moves at once in that
  tab. A colleague's action reaches another open tab on the next read after the
  30 s stale time; there is no polling.

## 10. Monthly qualification — 3 approved reviews, no penalty

The existing BOE Credits month model (Phase 1D), unchanged:

* An approved custom review posts one `review_reward`, recorded in
  `boe_credit_review_rewards` for its review month (§11).
* While the month has fewer than `minimum_monthly_reviews` (3) approved reviews
  its review credits are **provisional**: recorded, visible, not spendable.
* The approval that reaches 3 **qualifies** the month: all its still-valid
  review credits become spendable; later approvals that month are spendable at
  once.
* **No negative penalty.** Nothing here posts a negative row for a short month.
  When an administrator closes a month that stayed below the minimum, the
  existing `review_month_lapse` removes exactly that month's provisional review
  credits — credits the employee held before are untouched.
* A review whose month has **lapsed** can no longer be approved (it would be
  spendable at once, since only open months are provisional) or reapplied:
  `CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED`. Reject it with that reason instead.

## 11. Monthly maximum — 10 submissions

* **The counting rule:** a candidate's month holds every custom review whose
  **first submission** (`submitted_at`) falls in that **Asia/Kolkata** calendar
  month — pending, approved and rejected alike. A reapplication is the same row
  and never counts again. Nothing is stored before Submit, so no draft counts.
* At most `max_monthly_review_submissions` (10). The 11th is refused:
  *You have reached your monthly limit of 10 review submissions.*
* The same month decides the credit (§10): a slot and its credit cannot fall in
  two months, even when a September review is reapplied in October.
* Enforced by `check_customer_review_custom_month_rules()`, called by the
  registration under `pg_advisory_xact_lock(hashtext('customer_review_custom_month'),
  hashtext(employee))` taken **before** the count — two requests racing for the
  last slot run one after the other and the second counts the first.
* The upload route checks the same rule first, so a capped candidate is refused
  before five megabytes are uploaded; the database is what decides.

## 12. Minimum Image Reviews — 3

Of the monthly maximum, at least `minimum_monthly_image_reviews` (3) must be
Image Reviews. `images` counts the month's submitted reviews by their current
type (the slot rule, not approvals). 0 turns the rule off.

## 13. The Text-submission gating formula

```text
submitted             = the month's rows (§11)
images                = of those, Image Reviews
remaining_after_text  = MAX − (submitted + 1)
images_still_required = max(0, MIN_IMAGES − images)

A new TEXT review is allowed only when remaining_after_text ≥ images_still_required.
A new IMAGE review is allowed whenever submitted + 1 ≤ MAX.
A REAPPLICATION is never checked against MAX; it is checked against the mix only
when it turns an Image Review into a Text Review (with that row left out of the
count and counted again as text).
```

| Month so far (10 / 3) | Text | Image |
| --- | --- | --- |
| 7 text, 0 image | refused — *You have submitted 7 reviews this month. Your remaining 3 reviews must be Image Reviews to complete the monthly requirement of 3 Image Reviews.* | allowed |
| 8 total, 1 image | refused | allowed |
| 9 total, 2 images | refused (the last slot must be an image) | allowed |
| 7 total, 2 images | allowed (2 left after, 1 needed) | allowed |
| 9 total, 3 images | allowed | allowed |
| 10 total | refused (cap) | refused (cap) |

The formula reads the live settings; nothing assumes 10 or 3. The same
sentences are produced by `customMonthlyRules.ts` (the form) and by the
database (the decision).

## 14. Credit rates and settings

Admin-managed on `/payroll/credits` (`boe_credit_settings`, append-only, newest
row active). The Custom Review phase row inserted by `20261206000000`:

| Setting | Value |
| --- | ---: |
| `credit_value` — 1 credit | ₹50 |
| `review_reward_credits` — Text Review | 1 credit (₹50) |
| `image_review_reward_credits` — Image Review | 1.5 credits (₹75) |
| `minimum_monthly_reviews` — approved reviews to qualify a month | 3 |
| `max_monthly_review_submissions` — submissions a month | 10 |
| `minimum_monthly_image_reviews` — Image Reviews within the maximum | 3 |

The attendance prices are carried over from the row in force. Every change
applies to **future** actions: the reward is read at approval time and written
on the ledger row and on `credits_awarded`; a month keeps the minimum it started
with; nothing already posted is re-priced. Screens show the live settings —
no literal 1, 1.5, ₹50, 3 or 10 is written into a component.

## 15. Current Month / Last Month

Computed by `summarizeCustomReviewMonth()` (`src/lib/customerReviews/customMonthlyRules.ts`)
from the candidate's own rows (RLS), their `boe_credit_review_months` rows and
the settings. No metric is derived from another whose definition differs.

**This month:** Monthly Review Target `approved / minimum` with *Qualified* /
*Not yet qualified* · Image Review requirement `images / minimum` with how many
more · Submitted `submitted / maximum` and slots left · Text / Image counts ·
Pending approval · Rejected — to correct · **Text Review now: Allowed / Not
allowed** (with the reason) · Review credits (spendable, or pending the target)
· Reward rates and 1 credit = ₹.

**Last month:** Approved reviews · Submitted · Text / Image · Minimum target
achieved Yes/No · Image requirement achieved Yes/No · Review credits earned
(qualified → spendable; lapsed → 0 with what did not become available; not yet
closed → 0 with what is still pending) · Month status.

*Approved reviews* is the BOE Credits month's `qualifying_review_count` — the
count the credits system qualifies on (a reversed reward drops out; a generated
review verified that month counts in). *Submitted / Text / Image / Pending /
Rejected* count the custom review rows of the month.

## 16. Temporarily disabled for candidates

| What | How |
| --- | --- |
| Generated reviews on My Reviews (assigned cards, Book) | `/customer-reviews` and `/customer-reviews/mine` render `CustomReviewsScreen` for a non-verifier (`candidateGeneratedReviewsHidden`) |
| A generated review's page | `/customer-reviews/[id]` shows *Generated reviews are paused for now. Submit a Custom Review instead.* to a non-verifier |
| Booking | trigger `customer_review_generated_booking_paused` (available → booked) refuses a caller who does not resolve `verify` while `customer_review_generated_booking_enabled()` returns false — whatever called it |
| Generate, batches, image library, progress | were already verifier-only |

**Not blocked, deliberately:** a candidate who already held a booked or
submitted generated review when this shipped cannot open it in the interface; a
submitted one is still verified by a reviewer from Reviews → To verify and its
credit is posted as before. The WhatsApp and screenshot routes still check the
card holder, and the transition RPC still works for a held card — none of them
can start the workflow.

## 17. Retained for reactivation

Nothing was deleted by the pause: the card, draft, batch, image-group and
screenshot tables and their data; every generated-review function, route, screen
and test; the
review reward path in `transition_customer_review_test_card()`. **Re-enabling**
is two changes together: `CANDIDATE_GENERATED_REVIEWS_ENABLED = true` in
`src/lib/customerReviews/generatedWorkflow.ts`, and a migration re-creating
`customer_review_generated_booking_enabled()` to return true.
`customReviewPhase.test.ts` pins the two to each other.

## 18. Permissions

| Permission | Custom Reviews |
| --- | --- |
| `customer_review_requests.use` | Submit a custom review; see and reapply **their own** |
| `customer_review_requests.verify` | See every submission and its history; approve / reject (never their own); receive the notifications; the pending badge and the Notifications entry |
| `can_manage_boe_credits()` (active admin) | Award a different amount than configured |
| `users.role = 'admin'`, active and not deleted | Permanently delete an internal test record (§22) — not a Review permission; `verify` is neither required nor enough |

The permission engine is the only authority — no role name is read by the
submission, reapplication, decision or recipient functions. Inactive or deleted
accounts are refused everywhere. The one role read in the module is
`customer_review_test_card_purge_authorized()`, which authorizes the §22 purge
and nothing else.

## 19. Database objects, RPCs and routes

**Tables**

| Object | Notes |
| --- | --- |
| `customer_review_custom_submissions` | + `reapplication_count`, `last_reapplied_at`, `candidate_note` (20261206). One SELECT policy (own or verifier). No client writes |
| `customer_review_custom_submission_events` | Append-only history, one SELECT policy (whoever may read the submission), written by the trail trigger; existing submissions backfilled |
| `boe_credit_settings` | + `max_monthly_review_submissions`, `minimum_monthly_image_reviews` |
| bucket `customer-review-custom-proofs` | Private; first path segment = submission id |
| `notification_type` | + `customer_review_submitted`, `customer_review_reapplied` |

**Functions**

| Function | Callable by | What |
| --- | --- | --- |
| `create_customer_review_custom_submission(…)` | service role (POST route) | Register; month lock + rules |
| `reapply_customer_review_custom_submission(…)` | service role (PATCH route) | Reapply the caller's own rejected review |
| `approve_customer_review_custom_submission(uuid, numeric)` | authenticated | Approve; closed-month guard; one reward |
| `reject_customer_review_custom_submission(uuid, text)` | authenticated | Reject with a reason |
| `post_boe_credit_custom_review_reward(…)` | service role (called by approve) | The ledger row + review month |
| `check_customer_review_custom_month_rules(…)` · `customer_review_custom_month_usage(…)` | service role | The cap and the image mix |
| `customer_review_custom_reviewer_ids(uuid)` | service role | Notification recipients |
| `customer_review_custom_submissions_trail()` | trigger | History + notifications |
| `customer_review_generated_booking_enabled()` · `…_booking_guard()` | trigger | The candidate booking pause |
| `begin_customer_review_test_card_purge(uuid, uuid)` · `finish_…(uuid, uuid)` | service role (purge route) | Permanent deletion of an internal test record (§22) |
| `can_purge_customer_review_test_cards()` | authenticated | Whether to draw the purge control |

**Routes and screens:** `POST` / `PATCH /api/customer-reviews/custom-submissions`;
`POST /api/customer-reviews/test-cards/purge` (§22);
`/customer-reviews` (candidate: `CustomReviewsScreen`), `/customer-reviews/custom`,
`/customer-reviews/notifications`.

**Code:** `src/lib/customerReviews/customSubmissions.ts` (types, parsers, error
mapping), `customMonthlyRules.ts` (rules, summaries), `generatedWorkflow.ts`
(the pause); `src/components/customerReviews/CustomReviewSubmissions.tsx`,
`CustomReviewPerformance.tsx`, `CustomSubmissionPieces.tsx`;
`src/app/customer-reviews/CustomSubmissionsScreen.tsx`;
`src/hooks/queries/useCustomReviewPendingCount.ts`.

## 20. Tests and invariants

| Test | Proves |
| --- | --- |
| `src/lib/customerReviews/customMonthlyRules.test.ts` | the cap (9 → 10th allowed, 10 → 11th refused); every image-mix case above, exhaustively; changed settings; reapplication rules; IST months; the Current / Last Month aggregation (drafts, submitted, pending, rejected, reapplied, approved, text, image, pending vs spendable vs lapsed credits); the sentences match the migration |
| `src/lib/customerReviews/customReviewPhase.test.ts` | notifications (who, when, never a route), the badge (verifier-only, invalidated), reapply (same row, owner, rejected only, history), lock order, closed-month guard, no ledger rows / no penalty, the booking pause on every route and in SQL |
| `src/lib/customerReviews/customSubmissions.test.ts` | the submission, approval and rejection rules (20261205) |
| `src/lib/boeCredits/settings.test.ts` | the eight settings, the phase seed, the parser |
| `supabase/tests/custom_review_phase_assertions.sql` | **executed** on PostgreSQL via `run_custom_review_submissions_local.sh` (with `custom_review_submissions_assertions.sql`): every rule above, with SQLSTATEs, twice, rolled back |
| `src/lib/customerReviews/testCardPurge.test.ts` | §22: the eligibility mirror, the start → files → finish order with every failure and retry, the adapter, and the migration / route / screen contract |
| `supabase/tests/customer_review_test_card_purge_assertions.sql` | §22 **executed** on a local Supabase stack via `run_customer_review_test_card_purge_local.sh`: who, which records, the freeze, the refusal while files remain, nothing left, bystanders — twice, rolled back |

Invariants: one row per review for ever; one slot per review; one reward per
review; a decided row changes only by reapplication; history append-only;
nothing negative posted by this module; the database decides every rule.

## 21. Deliberate limitations

* No stored drafts — the unsaved form is the draft.
* The badge refreshes across users on its 30 s stale time, not in real time.
* Notifications are in-app only.
* A candidate's in-flight generated review is not reachable in the interface
  (§16).
* A review in a lapsed month must be rejected; it cannot earn credit.
* The concurrency guarantee is proven by its mechanism (a lock before the count)
  and by the SQL suite's single-session behaviour, not by a two-session race test.

## 22. Permanently deleting an internal test record

An administrator may erase a generated test card **while it is still provably
internal**. Custom review submissions are never deletable, by this or anything
else. The verifier's ordinary Delete (a tombstone that keeps the trail and the
files) is unchanged.

**Who:** an active, non-deleted `users.role = 'admin'`, resolved in the database
from the session's user on both database calls. Review `verify` is not required.

**An administrator without `verify`** (or without any Review permission) may open
exactly one kind of page: `/customer-reviews/<card id>`. The module layout admits
them there — and nowhere else in the module — only when
`can_purge_customer_review_test_cards()` is true. The page then asks
`customer_review_test_card_purge_record(card)`, which answers only an active
admin and only while the card may still be purged, and shows the read-only
record (reference, title, text, stored file names, activity) with the purge
control. No approval, verification, booking, sharing, attachment or verifier
Delete control is drawn; the workflow functions still refuse such a person
because they resolve `use`/`verify`, which this grants nothing of. Anything the
record function does not return shows the ordinary paused / not-available page.

**Which records — the eligibility predicate** (`customer_review_test_card_purge_blocker()`,
checked under the row lock at start and again at finish). All of:

1. no `boe_credit_transactions.source_id` and no `boe_credit_review_rewards.card_id`
   equal to the card id — a rewarded card is refused with *the reward must be
   handled separately*; nothing is reversed;
2. not a verifier's soft-deletion tombstone;
3. never released: `status = 'pending_approval'`; `approved_at`, `assigned_to`,
   `booked_by`, `whatsapp_opened_at`, `sent_confirmed_at`, `submitted_at`,
   `verified_at` all null; `whatsapp_opened_count = 0`;
4. history only `generated`, `revised`, `draft_edited`, `image_removed`,
   `image_group_set` — any other type (including a future one) refuses;
5. no attachment other than a verifier's review image.

**Why approval is the boundary.** A pending draft is readable by verifiers only
and cannot be assigned. Once approved, the text reached candidates (every `use`
holder before `20261107000000`, the assignee since), and *Copy message* and the
share fallback record nothing — so from approval onwards the schema cannot prove
the text never left BOE, and every approved card is refused.

**How** (`POST /api/customer-reviews/test-cards/purge`, `src/lib/customerReviews/testCardPurge.ts`):

1. **Start** — `begin_customer_review_test_card_purge()` checks, writes a
   `deleted` event and tombstones the card with `deleted_source = 'purge'`. The
   existing freeze then refuses any approval, attachment or other change.
2. **Files** — every object under `<card id>/` in `customer-review-test-screenshots`
   is listed (recursively) and removed through the Storage API — including an
   object whose metadata row was never written.
3. **Finish** — `finish_customer_review_test_card_purge()` checks again, refuses
   with `…_FILES_REMAIN` while any object under the prefix is still stored, then
   deletes the card; its screenshot and event rows cascade. No purge log is kept.

Both calls are repeatable: a failure at any step leaves a frozen card that still
names its files, and running the purge again finishes it.

**Screen:** a low-emphasis *Permanently delete test record* action at the foot of
the detail page, drawn only when `can_purge_customer_review_test_cards()` is true
and the card passes the browser mirror of the rule. The confirmation says the
record, its screenshots and its activity history are removed and that it cannot
be undone. There is no list or bulk purge.

**An interrupted purge** leaves a card tombstoned with `deleted_source = 'purge'`.
It stays frozen, and it stays hidden from everybody the database will not let
purge: verifiers and candidates still get *not available*, exactly as for any
tombstone, and a verifier's ordinary soft deletion is never offered this page.
An active admin who reopens `/customer-reviews/<card id>` — after a reload, in
another tab, days later — gets *Permanent deletion in progress* and a *Continue
permanent deletion* control. Continuing sends the same request: *Start* returns
the paths again without a second tombstone, every remaining file under the prefix
is removed, and *Finish* deletes the card. There is no list of interrupted
purges; the admin reaches one by its URL.

**Limitations:** a card reaches the purge page only by its URL — there is no
list of purgeable or interrupted records for an administrator without `verify`.
If a BOE Credits row appears for a card after its purge started, *Finish* refuses
and the record function stops returning it, so it stays a frozen tombstone for the
reward to be handled first. A batch that lost a draft to a purge can no longer be
assigned whole, exactly as after a verifier's Delete.

---

## 23. Employee edit and delete (`20270223000000`, in the repository — NOT applied)

An employee may edit or delete **their own** custom review from **My Reviews**.

| | |
| --- | --- |
| Routes | `PUT` (edit) and `DELETE` on `/api/customer-reviews/custom-submissions` |
| RPCs | `edit_customer_review_custom_submission()`, `delete_customer_review_custom_submission()` — **service role only**; `reverse_customer_review_custom_reward()` — owner-only helper, callable by nobody |
| Columns | `deleted_at`, `deleted_by`, `edit_count`, `last_edited_at`, `reward_held`, `reward_reversal_transaction_id` |
| History | two new events, `edited` and `deleted`, written by the trail trigger |
| Tests | `src/lib/customerReviews/customReviewEditDelete.test.ts`; `supabase/tests/custom_review_edit_delete_assertions.sql` via `run_custom_review_edit_delete_local.sh`; two-session races in `run_custom_review_edit_delete_race.sh` |

### 23.1 Who, and how it is enforced

Only the submitter. The route reads the review under the caller's own RLS (a review
that is not theirs reads as *not found*), compares `submitted_by` with the session user,
and passes that user as the actor; the database function compares again and refuses
anyone else — administrators and verifiers included — with
`CUSTOMER_REVIEW_CUSTOM_NOT_OWNER`. No client role can write the table or call the
functions, so hiding the buttons is not what protects a review.

### 23.2 What an edit does to each status

| Status | Edit | Effect |
| --- | --- | --- |
| Pending Approval | in place | stays pending; queue position, submission date and month do not move; history row |
| Rejected | not here | corrected through **Edit & Reapply** (§7), as before |
| Approved | in place | **goes back to Pending Approval**; the existing credit **stays on the ledger** but the review is **not eligible** until re-approved (§23.3); the type cannot change; reviewers are notified |

The submission date (`submitted_at`) and reference never change, so an old review does
not move into the current month. A published date may be corrected but never set in the
future. A screenshot may be replaced; the old object is kept and the history names it.
A review in a **closed** (lapsed) month cannot be edited.

### 23.3 Points and credits when a review is edited or deleted

The ledger allows one `review_reward` per source and one reversal per row; a reversal cannot itself be
reversed, and "re-awarding after a reversal is deliberately not possible" (`20261101000000`). So *reverse on
edit, pay again on approval* cannot work. Instead:

* **Edit of an approved review** — nothing is posted. `credits_awarded` and `credit_transaction_id` stay on the
  row, `reward_held` marks that the review is waiting for a decision. **The credit is still in the employee's BOE
  Credits balance** — that balance is the ledger, and it is unchanged — but the review is **Pending Approval**, so
  it is **not eligible**: it does not count in the leaderboard or in "eligible" totals. Reports show its credit
  separately as **awaiting re-approval**, never inside "eligible credits".
* **A verifier approves it again** — nothing is posted; the same credit stands and the review is eligible again.
  Re-approval can never pay a second time (the ledger has one reward per source, and the function refuses to post one
  for a review that already has one).
* **A verifier rejects it** — the credit is **reversed once** and the review is Rejected.
* **The employee deletes it** (any status) — an approved or held credit is reversed once, in the same transaction;
  a pending or rejected review has nothing on the ledger. A month that already **lapsed** is not reversed a second
  time (its credit was already taken by the month's expiry).
* **A review whose credit was reversed cannot be approved again** (`CUSTOMER_REVIEW_CUSTOM_DECIDED` refusal from the approve
  function): the ledger would have to pay a second time. The employee submits a new review, or an administrator posts an
  ordinary adjustment.

**Type is locked** for an approved or held review, because the held credit cannot be re-priced. So an edit can never leave
a Text credit on an Image review or the reverse; a Pending review may change type and is priced when first approved.

However often a review is edited, it has at most one reward and at most one reversal. The reversal is an ordinary
ledger row (`reversal`, negating the reward), posted for the employee by `reverse_customer_review_custom_reward()`.
Note the existing rule that a month that already **qualified** stays qualified after an individual reversal.

**"Pending approval" vs "actual credit balance."** *Pending approval* is a review status: it decides whether the review
is counted (eligible, leaderboard). The *balance* is the ledger: it changes only when a reward or a reversal is posted.
An edited approved review is pending approval **and** its credit is in the balance, until a verifier rejects it (reversed)
or approves it (unchanged). The screens say both things in those words.

### 23.4 Delete

A soft delete: `deleted_at` / `deleted_by` are stamped and the row, proof and history
stay. The employee no longer sees it (the SELECT policy hides it; verifiers still read
it). It leaves every list, count and total, **frees its monthly slot**, and no longer
blocks the same screenshot (the duplicate check keeps it as evidence — see the next
migration). A deleted row is frozen. Verifiers see it under **Custom Submissions →
Deleted**, with who deleted it, when, and whether a credit was reversed.

### 23.5 Repeated and concurrent requests

* Delete is idempotent: the second call answers `already_deleted`, adds no history and
  reverses nothing.
* Edit carries the `edit_count` the form was opened on. An identical repeat (double click,
  retry) answers `unchanged`; a stale counter with different content is refused (409).
* Locks are taken in one order — the employee's month lock, then the row, then the credits
  lock — so edit, delete, approval and rejection serialise on the row. The two-session
  races in `run_custom_review_edit_delete_race.sh` cover delete-vs-delete, delete-vs-edit
  and re-approval-vs-delete.

### 23.6 Screens

**My Reviews:** *Edit* (pending and approved) and *Delete* (any) beside *View Proof*; the
form is the submission form with the current values and a notice when the review is
approved; Delete asks first and says if a credit will be taken back.
**Custom Submissions:** an *Edited after approval* badge, **Approve again** (no amount
field — nothing more is paid), and the **Deleted** tab.

## 24. Possible-duplicate detection (`20270224000000`, in the repository — NOT applied)

Every new submission, edit and reapplication is checked against **every earlier custom
review of every employee — deleted ones included** — so submitting the same review twice, or
deleting one and reposting it, is seen. A check produces *possible* duplicates with reasons; it
never rejects a review and never touches a reward.

| | |
| --- | --- |
| Pure rules | `src/lib/customerReviews/duplicateDetection.ts` (normalization, thresholds, matching, what an employee may see) |
| Server | `duplicateCheck.server.ts` (fetch candidates, compare, token), `imageHash.ts` (difference hash, sharp) |
| Database | columns `reviewer_name`, `review_text`, `reviewer_name_norm`, `review_text_norm`, `proof_phash`; tables `customer_review_custom_duplicate_checks` and `…_flags`; view `…_duplicate_summary`; `decide_customer_review_custom_duplicate()`; `customer_review_custom_duplicate_candidates()` |
| Tests | `duplicateDetection.test.ts`, `customReviewDuplicates.test.ts`, `supabase/tests/custom_review_duplicate_assertions.sql` |
| Backfill | `scripts/backfill-review-image-hashes.ts` (§24.8): dry run by default, `--apply [--limit=N]` fills NULL hashes only, `--verify` is read-only |

### 24.1 What is compared

The submit and edit form gained two **optional** fields: **Reviewer name** and **Review text**
(the words as published). Custom reviews had neither before, so a name or text signal exists only
where the employee filled them in.

| Signal | How | Strength on its own |
| --- | --- | --- |
| Reviewer name | normalized (case, spacing, punctuation, word order) and equal as a whole name | **weak**, always |
| Review text | normalized; identical, or character-trigram (Dice) similarity | moderate or strong |
| Image, identical | SHA-256 of the stored (re-encoded) bytes | strong |
| Image, similar | 4096-bit difference hash (65 × 64, lightly blurred); differing bits as a share of the marked bits | moderate or strong |

A filename or upload URL is never compared.

### 24.2 Thresholds (all in `DUPLICATE_THRESHOLDS`)

| Setting | Value | Meaning |
| --- | ---: | --- |
| `NAME_MIN_CHARS` | 4 | a shorter normalized name is not compared |
| `TEXT_MIN_CHARS` / `TEXT_MIN_TOKENS` | 30 / 6 | shorter text carries **no** text signal, identical or not — "Great service, thank you" is written by thousands of customers |
| `TEXT_EXACT_STRONG_CHARS` | 60 | an exact match at or above this is strong; between 30 and 60 it is moderate |
| `TEXT_NEAR_MIN` | 0.8 | trigram similarity from which text is "similar" (moderate) |
| `TEXT_NEAR_STRONG` | 0.92 | similarity from which it is strong |
| `IMAGE_STRONG_MAX_RATIO` | 0.12 | differing bits ÷ marked bits: at most this is a strong image match |
| `IMAGE_SIMILAR_MAX_RATIO` | 0.38 | differing bits ÷ marked bits: at most this is "similar" (moderate) |
| `IMAGE_MIN_MARKED_BITS` | 60 | fewer marked bits between two hashes and they are not compared (two nearly blank pages) |

**Why a share of the marked bits, why 65 × 64 with a blur, and why 0.38.** Measured on synthetic review
screenshots (same header, stars and margins, only the words changing — the hard case). A coarse 17 × 16 or
33 × 32 hash sees layout, not words, and a screenshot is mostly white, so raw bit counts made a different
review in the same template as close as one screenshot saved at two JPEG qualities. Counting differing bits
as a share of the bits that are marked in either image, at 65 × 64 with a light blur: JPEG (quality 25–50),
resizing (400–1440 px) and blur of ONE screenshot differ in 20–28% of the marked bits; different reviews
in the same template in 54–66%. 0.38 sits between the two. Two pages with almost no marks (a nearly blank
screenshot) are not compared, and a near-blank template with only a few words changed can still read as
similar — one more reason a match is a *possible* duplicate for a person to judge. Combination: the strongest single signal wins; a name added to
a moderate signal, or text and image both moderate, makes it strong.

A match whose only reason is the name is **weak**: it is recorded and shown, but not counted as awaiting
a decision.

### 24.3 Limitations

* Text similarity is lexical: a translation or genuine paraphrase is not seen; typos, case and punctuation are.
* The image hash survives re-encoding, resizing and light compression — not a crop to another region,
  rotation, mirroring, or a large overlay. An identical file is always caught by the SHA-256.
* Names are compared whole: "A. Sharma" and "Amit Sharma" differ.
* Two screenshots of the same website look alike; that is why the image threshold is small and the result
  is always worded **possible**.
* Reviews submitted **before** this feature have no name, text or image hash. Until the backfill script
  has run only an identical screenshot can match them, and their detail says *no duplicate check on record*.
  After it has run they can match by screenshot only — **never** by name or text (§24.8).
* Known image misses (asserted in `historicalMatching.test.ts`): a crop, a small rotation and an inverted (dark-mode)
  copy of the same screenshot are **not** found; two near-blank pages are not compared; a near-blank template with a
  few words changed can read as similar (a possible false positive).
* Candidates are read server-side (newest 5,000 reviews). Text and image scoring happens in the route, not
  in SQL. At BOE's volume this is milliseconds; a much larger table would need a prefilter.
* No paid or AI service is used and none should be added without approval.

### 24.4 What the employee sees

On **Submit**, **Save** and **Reapply** the server checks first. If something matches — or the check could
not run — nothing is saved and the form shows, inline (no notification): an amber icon, **Possible
duplicate review** (or **Duplicate check unavailable**), the reasons — *Same reviewer name*, *Similar review
text*, *Similar image* — and three choices: **Edit review**, **Cancel**, **Submit anyway**.

An unavailable check is never shown or stored as clean. **Submit anyway** resends the request with a token
bound to the exact matches that were shown; if the matches change in between, the employee is warned again.
The database refuses a flagged or unavailable result the employee did not acknowledge, and stores that they
proceeded.

**What the employee is told is cut down** (`employeeView`): the reason categories, and — only for their
**own** earlier review — its reference. Never another employee's review id, reference, name, text, image,
date, or whether a deleted one exists. The evidence tables have one SELECT policy, for `verify` holders.

### 24.5 What the reviewer sees and does

**Custom Submissions:** a badge in the list and the detail — *Possible duplicate review · awaiting decision*,
*Marked duplicate*, *Duplicate check unavailable*, *Checked · different review*, *Weak name match*. **Compare &
decide** opens both reviews side by side (screenshots, submitter, dates, status, name, text), the evidence in
words, whether the employee saw the warning and proceeded, and two decisions: **Duplicate** (asks for a second confirmation, and is not offered for a name-only flag) and **Different
review**, with an optional note. Every check, flag and decision is kept in the review's **History**.

* A decision is a database function: verifier only, **never on your own review**, only on the review's
  **current** check. **Different review** changes nothing. **Duplicate** is binding (§24.6).
* **A changed review is checked again.** Each check carries a content fingerprint (screenshot, normalized name,
  normalized text). Editing the content produces new, undecided flags; an earlier *Different review* stays as
  history and does not clear the new ones. Editing only the remark or date re-raises nothing.
* A **deleted** review stays comparison evidence: reposting it is flagged against the deleted record.

### 24.6 A confirmed duplicate is binding

A **possible** duplicate is only a warning and never blocks anything. An administrator's **Duplicate** decision does:

* The review is **Rejected** ("Confirmed duplicate of an earlier review") — by the same database function, in the same
  transaction, so a decision and an approval cannot both win: both lock the review row first, and **approve refuses a
  confirmed duplicate** (`CUSTOMER_REVIEW_CUSTOM_DUPLICATE_CONFIRMED`, HTTP 409). This is enforced in the database, not
  only in the UI (proved under two concurrent sessions: decision-vs-approve, approve-vs-decision).
* If the review was **already rewarded**, the credit is **reversed once** through the ledger helper. A month that already
  lapsed is not reversed again.
* A weak (name-only) flag can never be confirmed as a duplicate.
* The review **stays in submitted reporting** with its status visible and is counted as *confirmed duplicates*; it is
  **excluded from eligible counts, credits and the leaderboard**.

**Duplicate → Different review afterwards.** The decision is recorded as changed in the history, and the review is no
longer a confirmed duplicate, so it is not excluded *because of the flag*. But the ledger cannot un-reverse: the review
stays **Rejected**, and a reversed credit is **not restored**. If no credit had been reversed, the employee can use **Edit
& Reapply**. If one had, approval is refused (one reward, one reversal — §23.3): the employee submits a new review, or an
administrator posts an adjustment. No screen promises a restored reward.

### 24.7 Release note

Apply `20270223000000`, then `20270224000000`, then `20270225000000` **before** the application code (the routes call the
new functions). After the code is live, run the backfill (§24.8).

### 24.8 Backfill of older reviews — exactly what it provides

**Provides:** `proof_phash` only (the screenshot's difference hash), for reviews that have none. **Does not provide:** the
reviewer name, the review text or their fingerprints — a hash cannot recover words, and older reviews never had them.
**Consequences:**

* An older review can match a new submission **only by its screenshot** (same file, or a look-alike).
* Older reviews become **candidates** for new submissions. They are **not flagged retroactively** — flags are written only
  when a review is submitted, edited or reapplied. `--verify` lists the older look-alike pairs for a person to look at.
* Measured on real pictures (`historicalMatching.test.ts`): the same file matches by SHA-256; JPEG 25/50, resizing to 400 and
  1440 px and a light blur match (20–28% of marked bits differ, limit 38%); different reviews in one template do not (54–66%).
  **False negatives:** a crop, a rotation, an inverted copy. **False positive risk:** two near-blank screenshots with a few
  words changed.

**Runbook** (never run by CI or by a migration; **not run on production**; needs `.env.local` with the service key):

```
npx tsx scripts/backfill-review-image-hashes.ts                       # 1. dry run: how many, first 20 references; writes nothing
npx tsx scripts/backfill-review-image-hashes.ts --apply --limit=200   # 2. hash the next 200 (oldest first), then stop
npx tsx scripts/backfill-review-image-hashes.ts --apply               # 3. repeat / finish; safe to interrupt and re-run
npx tsx scripts/backfill-review-image-hashes.ts --verify              # 4. read-only: coverage + look-alike pairs
```

Resumable because only NULL hashes are selected and the write function fills a NULL and nothing else; a second run does
nothing. Exit 1 means some proofs could not be read (they are named and skipped). `--verify` refuses above 3,000 reviews.

## 25. Reports and the shared leaderboard (`20270225000000`, in the repository — NOT applied)

Read-only: no table is changed and no credit moves. Rules are in §25.1; the corrected rules for duplicates and edits are in §23.3 and §24.6.

| | |
| --- | --- |
| Admin dashboard | **Reports** — `/customer-reviews/reports` (`verify` holders), `ReportsScreen.tsx`, `ReviewCharts.tsx` |
| Leaderboard | `/my-credits/leaderboard` — **every signed-in employee** (no Review permission needed), `ReviewLeaderboardScreen.tsx` |
| Dashboard card | `ReviewLeaderCard.tsx`, one card on `/dashboard` linking to the leaderboard |
| Database | `customer_review_report()`, `customer_review_report_list()`, `customer_review_leaderboard()`, `customer_review_leader_card()`, `customer_review_credits_per_point()`; internal `customer_review_report_rows()`, `customer_review_month_standings()` |
| Pure code | `src/lib/customerReviews/reviewReport.ts` |
| Tests | `reviewReport.test.ts`; `supabase/tests/custom_review_reporting_assertions.sql` (executed twice on PostgreSQL) |

### 25.1 The definitions — one place, every screen

* **Month** — the Asia/Kolkata calendar month of `submitted_at`, the **first** submission: the same date the credit is
  attributed to. An edit or reapplication never moves a review to a later month. Daily bars use the same IST date.
* **Submitted** — every review of the month that is **not deleted** (pending, approved, rejected). Deleted reviews are out
  of every total and stay in the admin history (§23).
* **Text / Image** — the stored `review_type`. A review is **exactly one**, so text + image = submitted. **Counting rule
  for a review that "has both":** there is no such review — the form asks for one type, every custom review carries a
  screenshot, and that does not make it an Image Review. The type is the employee's stated review type, the one that decides
  the reward and the monthly image requirement (§5, §12). No change to that rule was needed.
* **Category** — custom reviews carry no category beyond their type (the generated-review "test categories" belong to a
  different workflow). The **By type and status** table is the category breakdown, and the Type filter is the category
  filter. **Decision needed from the owner** if a separate category (project, city, source) is wanted: it would be a new field.
* **Reward-eligible** — an **approved** review (not deleted) with a posted credit that nothing has reversed, and **not a
  confirmed duplicate**. Deleted, rejected, confirmed-duplicate and **pending** reviews (including an edited approved review
  awaiting re-approval) are **not** eligible. Eligible ≤ submitted always; both are shown wherever they differ.
* **Expired** — a review whose month closed (`boe_credit_review_months.status = 'lapsed'`): its credit was **earned**, then
  expired. **Expiry is not rejection**: the review stays eligible in history (the count and the reward earned that month), and
  is reported separately as *Expired with a closed month*. Month closure never erases an earned result.
* **Awaiting re-approval** — edited approved reviews: submitted, **not** eligible, their credit still in the balance, shown
  apart as `held`.
* **Confirmed duplicates / Reversed** — counted apart; both stay in submitted with their status visible.
* **Credits** — the credits on the eligible reviews (the ledger's own numbers, numeric(12,2)). **No rate was invented**:
  Text and Image rewards, caps and approval rules are the existing ones (§14). Existing awards are never rewritten.
* **Points** — review-earned points = **credits ÷ 10** (Credits = points × 10; `customer_review_credits_per_point()`,
  `CREDITS_PER_POINT` pinned to it by a test). Exact to **three decimals**, computed in hundredths (no float drift): a Text
  review at 1 credit = 0.1 point, an Image review at 1.5 credits = 0.15 point, the smallest ledger unit 0.01 credit = 0.001
  point. Points are per month and **start again each month**. They are a view of review credits — not the Performance-module
  score, which nothing here reads or changes. Credits and points are always shown separately.
* **Historical reports are live, not snapshots.** A later reversal (a delete, a rejected edit, a confirmed duplicate) removes
  the review from its **original submission month's** eligible figures the next time that month is opened; that month's
  *submitted* count does not move (except a delete, which leaves submitted). A review keeps its original submission month
  through every edit and reapplication.
* **Possible duplicates awaiting a decision** — reviews of the month whose latest check has an undecided strong or moderate
  flag (§24).

### 25.2 The admin dashboard

Default: the **current month**; the previous eleven are selectable. Filters: month, employee, type, status (the existing
statuses). Everything comes from **one server-side aggregate**; no review text or screenshot is downloaded.

* **Cards** — Total submitted, Text, Image, Possible duplicates awaiting a decision; a second panel with Reward-eligible
  ("11 of 15 submitted"), Review credits and Review points.
* **Daily** stacked bars (text vs image) for every day of the month; **Monthly history** for the last twelve months (with
  eligible counts under it). Both have a table alternative for accessibility.
* **By type and status** — pending / approved / rejected / submitted / eligible / credits.
* **Contributors** — the highest and lowest by submitted reviews, **all of those tied on the count**, and the employee table
  (submitted, text, image, eligible, credits, points) including **every active employee who may use the workflow, with zeros**,
  so the lowest activity is visible.
* **Clicking** a card or an employee opens the matching list — one **page of 25** (references, status, type, dates,
  credits, points; never text or proof), with a link to the review in Custom Submissions.
* The page checks that its own parts **reconcile** (employee rows, daily bars, breakdown, history and cards) and shows an
  error instead of a dashboard whose parts disagree. The same reconciliation is asserted in SQL.

### 25.3 The leaderboard

Visible to **every signed-in employee** at `/my-credits/leaderboard` (linked from BOE Credits and from a card on the
dashboard). Ranked by **reward-eligible review count** for the month (Asia/Kolkata boundaries); **equal counts share a rank** (1, 2, 2, 4) and are
marked *tied*; display order (count, then name) is stable and does not hide a tie. Columns: rank, employee, reviews, points,
credits. **Your own row is highlighted and always shown**, even outside the top ten.

**"You need X more reviews to take first place"** — X = leader count − your count + 1, while you are behind. A sole leader
sees *You're leading*; **joint leaders need 1 more review to become the sole leader** (*You're joint first with N others — 1 more
review makes you the sole leader*); while nobody has an eligible review the target is 1. Employees who may use the workflow are
included with **zero** eligible reviews in the admin comparison. It is labelled as **additional eligible reviews — a target, not a guaranteed award.**

### 25.4 Performance and safety

* Aggregates run in the database (`generate_series` days and months, one row set per call); the list is paged (≤ 50).
* The report functions check `customer_review_requests.verify` inside the function; the leaderboard needs only an active
  account and returns names and counts, never review content. The two internal functions are callable by nobody.
* Known limit: the report scans the month's reviews and the twelve-month history in one call; at BOE's volume that is
  milliseconds, and `customer_review_custom_submissions (submitted_at)` is indexed.

## 26. Release review — PR #269 (draft)

**Migration order (all NOT applied to production):** `20270223000000` → `20270224000000` → `20270225000000`, then the app code,
then the backfill (§24.8). Never the reverse; the routes call the new functions.

**Final rules:** credits = points × 10 (points = credits ÷ 10, 3 decimals); confirmed Duplicate is binding and reversed once
(§24.6); an edited approved review is Pending, not eligible, credit stays on the ledger (§23.3); expiry is not rejection (§25.1);
leaderboard ranks by eligible count, ties share a rank, joint leaders need 1.

**Ledger limits (unchanged, by design):** one reward and one reversal per source; a reversal cannot be reversed; a reversed
review cannot be approved again; a held credit cannot be re-priced (so type is locked); a Duplicate decision on a review whose
month lapsed cannot reverse a second time; Duplicate → Different restores no reward.

**Remaining verification gaps:** the real `/dashboard` integration of the leader card was verified only in a throwaway page, not
on a real dashboard in a non-production environment; production backfill and production-scale timing are unmeasured.

## Appendix — Historical: the generated-review workflow (paused for candidates)

Kept as a record of what exists and is paused. See the migrations and tests for
detail; this summary is not a specification.

* **Origins.** `20261017000000` built an internal rehearsal: fictional "test
  cards", booked atomically by a single conditional UPDATE, a WhatsApp link built
  on the server from a number that is never stored (last four digits only), a
  screenshot in the private `customer-review-test-screenshots` bucket, and a
  verifier. Its enduring rules: the permission engine is the only authority (no
  administrator-role bypass anywhere), no client role writes a card, the trail is
  append-only, and a verified card leaves every frontend list while its record
  stays in the database.
* **Generated reviews.** Later migrations (`20261023000000` AI drafts,
  `20261026000000` batch approval, `20261027000000` generation claims,
  `20261030000000` deletion and replacement, `20261031000000` editing and review
  images, `20261107000000` review types / assignment / image groups,
  `20261108000000` variable batch size, `20261114000000` word range,
  `20261123000000` native share) turned the cards into generated review drafts:
  a verifier generates a batch, approves drafts, assigns the batch to one
  employee; the employee books a review, shares it, confirms it was sent,
  attaches a screenshot and submits; a verifier verifies or returns it.
* **Credits.** Verifying posts one `review_reward` in the same transaction
  (Phase 1B, 1D), priced by review type, attributed to the Asia/Kolkata month of
  the latest submission.
* **Where it lives.** Screens `/customer-reviews/reviews`, `/batches`, `/images`,
  `/progress`, `/[id]`, `/mine`; routes `generate`, `revise`, `draft`, `images`,
  `image-groups` (verify) and `photos`, `whatsapp` (the card holder); RPCs
  `book_…`, `unbook_…`, `confirm_…_sent`, `transition_customer_review_test_card`,
  `record_…_share_opened`. Tests: `migration`, `securityContract`, `status`,
  `reviewTypes`, `batchSize`, `draftGeneration`, `whatsappRoute`, `uploadRoute`,
  `photoRemoval*`, `shareOpened`, `deletion`, `preBookingImages`, `adminBypass`,
  `internalTest` under `src/lib/customerReviews/` and
  `src/lib/permissions/customerReviewOutreach.test.ts`.

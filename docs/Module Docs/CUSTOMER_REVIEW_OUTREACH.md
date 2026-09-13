# Review Workflow

**Current phase: Custom Reviews only.** Candidates submit Custom Reviews for
approval; the generated / booked review workflow is **paused for candidates**
and kept intact for later.

| | |
| --- | --- |
| Route | `/customer-reviews` |
| Module key | `customer_review_requests` (permissions `use`, `verify`) |
| Custom Review migrations | `20261205000000_customer_review_custom_submissions.sql` — **applied** · `20261206000000_customer_review_custom_reapply_and_monthly_rules.sql` — **in the repository, NOT yet applied** (`supabase migration list --linked`, 2026-09-13: remote head `20261205000000`) |
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
counted once); an approved row never changes; nothing is deleted.

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

Nothing was deleted: the card, draft, batch, image-group and screenshot tables
and their data; every generated-review function, route, screen and test; the
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

The permission engine is the only authority — no role name is read by the
submission, reapplication, decision or recipient functions. Inactive or deleted
accounts are refused everywhere.

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

**Routes and screens:** `POST` / `PATCH /api/customer-reviews/custom-submissions`;
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

---

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

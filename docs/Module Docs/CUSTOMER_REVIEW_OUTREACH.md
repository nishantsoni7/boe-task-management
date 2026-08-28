# Review Workflow Test (Internal)

**Status:** built, tested, **NOT deployed**. The migration exists in the
repository and has **not been applied to any database — local or remote**. The
module is unreachable until it is.

Route: `/customer-reviews` · Module key: `customer_review_requests` ·
Migration: `supabase/migrations/20261017000000_customer_review_outreach.sql`

> **Why the route and the module key still say "customer review".** They are
> identifiers. The module key is what every Control Center grant is written
> against, and renaming it would silently revoke all of them; the route is what
> the guard and the launcher are wired to. The **display name**, the tables, the
> functions and the entire product are named for what this is now. If you are
> reading the key and expecting a customer-facing system, this document is the
> correction.

---

## 1. What this is

An **internal rehearsal of a workflow**. An authorized BOE employee opens a list
of **test cards**, books one, opens WhatsApp with a prefilled message addressed
to a **BOE internal team number**, confirms by hand that they sent it, uploads a
screenshot, and an administrator verifies that the workflow was exercised.

```
available  →  booked  →  submitted  →  verified
```

The phase exists to test seven things and nothing else:

1. permission-based module access,
2. viewing available test cards,
3. booking one card, atomically,
4. opening WhatsApp with internal test content prefilled,
5. manually confirming that the test message was sent,
6. uploading a test screenshot,
7. administrator verification — after which the card leaves every active
   employee view and stays in the administrator's history.

## 2. What this is NOT

**It is not a customer review system**, and the schema is shaped so it cannot
quietly become one.

| It must never… | What stops it |
| --- | --- |
| Hold customer data | There is **no** `customer_name`, `whatsapp_number`, `interaction_type`, `greeting_name` or `project_reference` column. The migration's own assertion block fails if a column matching `customer_name\|customer_phone\|greeting\|whatsapp_number\|contact_` is ever added |
| Point anywhere public | There is **no** review URL, no Google link, no destination column, no publish action and no external address in any screen. The migration fails if a column matching `review_url\|public_url\|review_link\|destination\|google` appears; `customerReviewOutreach.test.ts` fails if any screen or route contains a hard-coded `http(s)://` address |
| Fabricate a review or a customer | Card text is **fixture-loaded filler that says what it is in its own first sentence**. `fixture.test.ts` fails on any card containing an endorsement phrase, a first-person account of an event, a signature, a contact detail, or a link |
| Let an employee write or edit content | **No client role holds INSERT or UPDATE on the card table at all.** There is no form, no create route and no edit route. The migration asserts both the absent policies and the absent privileges |
| Drop the mandatory label | The label is a constant (`INTERNAL_TEST_WARNING`), rendered by a component that takes **no content parameter**, and prepended by a builder with **no parameter that suppresses it and no branch**. Since employees cannot author text at all, there is nothing to edit it out of |
| Message a customer | Every recipient comes from a **server-held allowlist**. A number not on it is a 403 with no link; a missing or malformed allowlist is a 503 |
| Send anything automatically | Nothing here calls a WhatsApp API. `whatsappRoute.test.ts` walks all of `src/` and fails on any WhatsApp endpoint, token or client |
| Treat an opened link as a sent message | `record_customer_review_test_card_whatsapp_opened()` **assigns no status**, and confirming is a separate RPC a person calls afterwards. Both are asserted, in the SQL, by two different test files |

## 3. The mandatory label

Every card and every message carries:

```
INTERNAL TEST ONLY – NOT A CUSTOMER REVIEW – DO NOT PUBLISH
```

It is applied by trusted application logic in
`src/lib/customerReviews/internalTest.ts`, and it is **non-editable and
impossible for an employee to remove**. That is structural, not procedural:

* it is a **constant**, not a column — there is no row to edit;
* `buildInternalTestMessage()` puts it **first and last**, always. It is not a
  parameter, so no caller can decline it, and the builder contains no `if`;
* `<InternalTestWarning />` renders the constant and accepts **no `children` and
  no `text` prop** — a caller decides *where* it appears, never *what it says*;
* **card text is not authored by employees at all**. It arrives from a fixture,
  and `authenticated` holds no INSERT and no UPDATE privilege on any content
  column;
* the **server refuses to return an unlabelled message**, and the **browser
  refuses to open one**, so a future refactor of the builder makes the control
  go dead rather than the label go away;
* the database holds its own copy —
  `public.customer_review_internal_test_warning()` — so a card body containing a
  copy of the label is refused by a CHECK constraint. A stored copy would be one
  an editor could reword.

The SQL constant is written with ASCII hyphens and the application constant with
en dashes; `internalTest.test.ts` pins the two together on their normalized
form, so the **words** cannot drift.

## 4. Roles and permissions

Two permissions, unchanged, in the existing Control Center permission engine.
The module deliberately registers **no `view` action**.

| Permission | Grants |
| --- | --- |
| `customer_review_requests.use` | **Module entry.** See the available pool, book a card, open WhatsApp for a card they hold, confirm they sent it, attach and remove a screenshot, submit for verification. Sees the pool and **their own cards only** |
| `customer_review_requests.verify` | Read **every** card, verify a submitted one, return one to its tester with a reason, and keep a history of verified ones. Implies module entry. Does **not** grant booking |

Expected access:

| Who | `use` | `verify` |
| --- | --- | --- |
| Admin | ✅ | ✅ |
| Explicitly authorized employee | ✅ | — |
| Explicit verifier | — (grant separately if they should also test) | ✅ |
| Unauthorized or inactive employee | — | — |

* **A verifier who does not hold `use` cannot book a card.** That is the
  separation the workflow exists to exercise, and it is enforced in
  `book_customer_review_test_card()` rather than only in the UI.
* `verify` is a **PROTECTED action** (`src/lib/permissions/levels.ts`): no preset
  level grants it; it has to be ticked deliberately in Custom.
* `verify` **depends on** `use` (`ACTION_DEPENDENCIES`), so ticking it brings
  module entry with it.
* **An inactive account is refused everywhere**, including a deactivated admin
  and a deactivated verifier, and including on their own booked card. Every
  predicate and every definer function checks `users.is_active`, because
  `resolve_effective_permissions` does not.

## 5. The screens

| Screen | Who | What it shows |
| --- | --- | --- |
| **Available** | `use` or `verify` | Cards with status `available` only. Each carries the label, the category, the reference, the title, a truncated preview and a **Book** action |
| **My tests** | the tester | That person's `booked` and `submitted` cards. Scoped in the query as well as by RLS, because a verifier sees everybody's |
| **To verify** | `verify` | Submitted cards awaiting a decision |
| **History** | `verify` | Verified cards. **The only place a verified card appears anywhere in the module** |

A verified card is not hidden cosmetically: `verified` is simply not a member of
either active tab's status list, and it never returns to the pool.

### The card screen

Five facts, five controls, and no control performs two of them:

| Fact | Written by | Moves the status? |
| --- | --- | --- |
| booked | `book_customer_review_test_card()` | available → booked |
| whatsapp_opened | the trusted route, via a service-role RPC | **no** |
| sent_confirmed | `confirm_customer_review_test_card_sent()` | **no** |
| submitted | `transition_customer_review_test_card()` | booked → submitted |
| verified | the same, with `verify` | submitted → verified |

## 6. WhatsApp

### The allowlist

Recipients come from one **server-only** environment variable:

```
BOE_INTERNAL_TEST_WHATSAPP_NUMBERS=Ops test phone|+919999900001,QA test phone|+919999900002
```

* Comma- or newline-separated. Each entry is a full international number,
  optionally `Label|+number`. `#` starts a comment.
* **Not** a `NEXT_PUBLIC_` name, so Next never inlines it into a client bundle.
  The numbers reach a browser only through `GET /api/customer-reviews/whatsapp`,
  which requires an active account holding `use`.
* **No real number is committed to this repository.** `.env.example` documents
  the variable with placeholders; real values go in `.env.local`.
* Numbers are **normalized and validated server-side**, strictly: an entry
  without a country code is refused rather than guessed, because the guess would
  decide who gets messaged.

**It fails closed, every way it can fail.** Unset, empty, whitespace, comments
only, or containing **one** bad entry among good ones: the whole list is refused
and no link can be built by anybody. There is no default, no fallback and no
built-in number anywhere in the code.

### Why the server builds the link

If the browser assembled the `wa.me` URL, the allowlist would be a suggestion:
anything running in that tab could put a stranger's number in the path.
`POST /api/customer-reviews/whatsapp` checks the number against the list,
composes the message from the card row and the constants, and returns the URL —
so the number in the link is one the **server** chose from its **own** list.

A tester may also *type* a number instead of picking one. That is not a hole:
what they type is checked against the same list on the server, and a number that
is not on it comes back 403 with no link.

### Opening is not sending

* `record: false` (the default) **previews** the message and records nothing.
* `record: true` records `whatsapp_opened_at`, a counter and the target — and
  **touches no status**. The RPC that does it is granted to `service_role`
  alone, because it takes the actor and the recipient as parameters and the
  trusted route is what establishes both.
* **Confirming is a separate, deliberate action** on a separate control, calling
  a separate RPC, which also moves no status. Submitting is a third step.

Nothing in this repository sends a WhatsApp message. There is no API client, no
token and no outbound call — the only artefact produced is a URL string, and no
test navigates to it.

## 7. Evidence

One screenshot per card, in a **private** bucket
(`customer-review-test-screenshots`), read through short-lived signed URLs.

**A screenshot is not proof of a review.** There is no review in this module. It
is not proof of delivery either. It is the artefact a verifier looks at to
decide whether the *workflow* was exercised, and the screens say so where it is
uploaded and where it is checked.

Upload and removal both go through `/api/customer-reviews/photos`, which is the
**only writer**: `authenticated` holds no storage INSERT policy, no metadata
INSERT policy, and no INSERT, UPDATE or DELETE privilege. The route
authenticates the caller, resolves `use`, reads the card through **their own
RLS**, checks the card is still `booked`, **decodes and re-encodes** the image,
generates the object key itself, and only then writes.

Removal is one operation in three steps — mark, delete the object, delete the
row — so a failure between them leaves a retryable state rather than an orphaned
file or a broken reference. A tester may withdraw a screenshot **only while they
still hold the card**; an administrator may at any status, which is the only
safe correction route for an image uploaded by accident.

## 8. The database

Three tables, all with RLS, none with an unconditional policy.

| Table | Client access |
| --- | --- |
| `customer_review_test_cards` | **SELECT only.** One policy. No INSERT, UPDATE or DELETE policy or privilege for any client role |
| `customer_review_test_card_screenshots` | **SELECT only**, and a row marked for removal is filtered out in the policy itself |
| `customer_review_test_card_events` | **SELECT only.** Append-only: no client holds INSERT, UPDATE, DELETE or TRUNCATE |

### Browser-callable functions, and their exact signatures

The migration pins an **exact allow-list**: any function in this module granted
to `authenticated` whose signature is not on it fails the migration at apply
time.

| Signature | EXECUTE |
| --- | --- |
| `customer_review_internal_test_warning()` | `authenticated`, `service_role` |
| `can_use_customer_review_test_cards()` | `authenticated` |
| `can_view_customer_review_test_card(p_card_id uuid)` | `authenticated` |
| `can_view_customer_review_test_card_row(p_booked_by uuid)` | `authenticated` |
| `book_customer_review_test_card(p_card_id uuid)` | `authenticated` |
| `confirm_customer_review_test_card_sent(p_card_id uuid)` | `authenticated` |
| `transition_customer_review_test_card(p_card_id uuid, p_next_status text, p_detail text DEFAULT NULL)` | `authenticated` |

Service-role only — each takes something the trusted route establishes:

| Signature | Why it is not browser-callable |
| --- | --- |
| `record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)` | takes the actor **and** the allowlisted recipient |
| `begin_customer_review_test_screenshot_removal(uuid, uuid)` | takes the actor |
| `finish_customer_review_test_screenshot_removal(uuid)` | the second half of a removal |

Reachable by nobody but this module's own functions:
`assert_customer_review_test_card_submittable(uuid)`,
`customer_review_test_screenshots_log_removal()`.

**No browser-callable function accepts an acting-user id.** One that did would
be an oracle: a signed-in employee could pass a colleague's uuid and read back
who is active, who is an admin and who holds `verify`. The uuid that *is*
accepted is a row's `booked_by`, compared by equality against `auth.uid()`; the
function reads `public.users` for the caller alone.

Every SECURITY DEFINER function pins `search_path = public, pg_temp`, asserted
over the whole set rather than one at a time.

### Booking is atomic

`book_customer_review_test_card()` claims the row with a **single conditional
UPDATE** carrying `status = 'available'` in its WHERE clause — not a read
followed by a write, which is the shape that loses a race. Under READ COMMITTED
a concurrent transaction blocks on the row lock, re-reads the committed new
version, matches nothing, and raises `23514`
(`CUSTOMER_REVIEW_TEST_ALREADY_BOOKED`). Two testers cannot both take one card.

### Return, and why there is no fifth status

A verifier who cannot use the evidence sends the card **back to `booked`** and
records `return_reason`, `returned_at` and `returned_by`, plus a `returned` row
in the trail. The alternatives were verifying evidence they could not check, or
leaving the card stuck in the queue forever.

Adding a `returned` status would have been a fifth state for something the four
already express: the tester holds the card again, exactly as before, and the
reason is on the row and in the trail where they will see it. This is the
smallest state that answers the requirement.

## 9. Test data

**Sixteen fictional cards**, covering all ten categories and short / medium /
long bodies, plus a long unbroken token, punctuation and a newline.

They live in `supabase/fixtures/customer_review_test_cards.sql` — **outside the
migration chain**, because a migration runs against production and test data
that runs against production *is* test data in production. The migration asserts
that it created no cards at all.

**The fixture cannot reach production even if somebody runs it there.** It
carries its own guard: it refuses to insert unless the database it is connected
to carries the disposable-stack marker, which a person has to set deliberately
and which no BOE deployment has. That is a property of the file, not of the
harness around it — a guard that only exists in the runner protects only the
people who use the runner. The teardown carries the same guard, because a DELETE
pointed at production is worse than an INSERT.

**Loading it:**

```bash
BOE_DB_CONTAINER=supabase_db_<project> supabase/tests/run_customer_review_outreach_local.sh
```

Step 9 of 9 loads the fixture and fails if all sixteen did not land.

**Clearing it:**

```bash
docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f - < supabase/fixtures/customer_review_test_cards_clear.sql
```

It removes exactly the sixteen rows by `card_ref` and nothing else — no
TRUNCATE, no unqualified DELETE. Screenshots and the trail cascade with the
cards; **objects in the private bucket do not**, so a stack that has had
screenshots uploaded should be rebuilt with `supabase db reset --no-seed` rather
than cleared with that file alone.

> **A consequence worth stating.** Because cards come only from a fixture, a
> production deployment of this migration shows an **empty Available list** —
> there is no path by which a card gets created in a real deployment. That is
> correct for a test phase and is a decision for the product owner if the module
> is ever to hold real content.

## 10. Tests

| File | What it proves |
| --- | --- |
| `internalTest.test.ts` | the label is first and last in every message, is not a parameter, has no branch, matches the SQL constant, and survives a `wa.me` round trip |
| `allowlist.test.ts` | every failure mode refuses; one bad entry refuses the whole list; no default and no committed number |
| `whatsappRoute.test.ts` | the allowlist is checked before a link exists; nothing in `src/` can send |
| `status.test.ts` | the four statuses, who may make each move, what a submission needs, and that a verified card is in no active list |
| `migration.test.ts` | the schema, the policies, the grants, and that the SQL transition table matches the browser's edge for edge |
| `securityContract.test.ts` | function by function: pinned `search_path`, no acting-user parameter, row locks, SQLSTATEs, and what each grant admits |
| `uploadRoute.test.ts` | the upload path, the generated key, and the two-route inventory |
| `photoRemoval.test.ts`, `photoRemovalRetry.test.ts` | removal is one operation, is idempotent, and converges after a failure |
| `fixture.test.ts` | the fixture cannot run against production, and none of its content reads as a review |
| `customerReviewOutreach.test.ts` | the guard, the launcher, Control Center, and what the screens offer |
| `supabase/tests/customer_review_test_card_assertions.sql` | **executed against a database**: exact SQLSTATEs, double booking, inactive accounts, visibility, and that a verified card leaves every active list |

### Running the live assertions

They need a **disposable** local stack. The runner names its target explicitly,
requires the marker, and refuses if `public`, `auth`, `storage` or the migration
ledger holds anything:

```bash
supabase start
supabase db reset --no-seed
export BOE_DB_CONTAINER=supabase_db_<project>
docker exec -i "$BOE_DB_CONTAINER" psql -U postgres -d postgres -c \
  "comment on database postgres is 'boe-disposable-customer-review-test'"
supabase/tests/run_customer_review_outreach_local.sh
```

The guards have their own tests:
`supabase/tests/run_customer_review_outreach_guard_tests.sh`.

## 11. Deliberately not built

Reviews, ratings, customers, campaigns, scheduling, message composition, public
links, posting, analytics, leaderboards, incentives, notifications, and any
automatic sending. None of these have storage here on purpose.

## 12. Known limitations

* **The module ships empty in production.** See §9.
* **Atomicity is proved by its mechanism, not by a concurrent run.** The
  assertions file runs in one psql session, so it proves the conditional-UPDATE
  shape structurally and the second-booking refusal behaviourally. A genuinely
  concurrent test would need two sessions.
* **`npm run permissions:check` needs a live database** and cannot be run
  offline; the migration/registry agreement is asserted by `migration.test.ts`
  instead.
* **The disposable-stack test baseline is an incomplete stand-in for
  production's `public.users`.** A green run proves things about this migration;
  it is not evidence that production's users table behaves identically.

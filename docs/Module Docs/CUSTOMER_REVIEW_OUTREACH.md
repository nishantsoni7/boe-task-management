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
to **any valid international number they enter**, confirms by hand that they
sent it, uploads a screenshot, and a verifier checks that the workflow was
exercised.

**The tester chooses the recipient**, so nothing here claims who receives a
message — not that they are internal, and not that they are not a member of the
public. What is true and enforced: nothing is posted anywhere, and BOE never
sends the message. The artefact is a `wa.me` URL a person clicks.

```
available  →  booked  →  submitted  →  verified
```

The phase exists to test seven things and nothing else:

1. permission-based module access,
2. viewing available test cards,
3. booking one card, atomically,
4. opening WhatsApp with internal test content prefilled, addressed to a
   number the tester chooses,
5. manually confirming that the test message was sent,
6. uploading a test screenshot,
7. verification — after which the card leaves **every** frontend view. The
   record and its audit trail stay in the database; no screen reads them back.

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
| Send to a number nobody meant | The number is **normalised and validated on the server**, whatever the browser did: malformed, too short, too long or missing a country code is a 400 with no link. A **bare national number is refused rather than guessed**, so nothing decides which country a number belongs to |
| Message anyone without saying so | The tester must tick a confirmation that the number may receive an internal BOE test message. It is required by the **request**, not by the form, and a truthy value is not a confirmation — only `true` is |
| Keep the number afterwards | **It is never stored.** The card keeps the last four digits and nothing else; the RPC has no parameter a number could arrive in, and the column is shape-constrained to four digits |
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
| `customer_review_requests.use` | **Module entry.** See the available pool, book a card, and — **only on a card they themselves hold** — open WhatsApp for it, confirm they sent it, attach and remove its screenshot, and submit it. Sees the pool and their own cards only |
| `customer_review_requests.verify` | Read **every** card, verify a submitted one, and return one to its tester with a reason. Implies module entry. Does **not** grant booking, and does **not** grant any tester action. Confers nothing over a card once it is verified — there is no screen that shows one |

### Tester actions belong to the card's holder, and to nobody else

Every action below requires the card to be booked by the person taking it —
`card.booked_by = auth.uid()` in the functions the browser calls directly, and
`card.booked_by = p_actor_id` in the two the server calls with an actor it
established from the session. **There is no administrator exception**, in the
routes or in the SQL:

* generating and recording a WhatsApp link
* confirming the test was sent
* uploading a screenshot
* removing a screenshot
* submitting for verification

An administrator or verifier reading somebody else's card is fine and necessary
— that is what verification needs. **Reading is not holding.** Administrator and
verifier authority covers exactly two things: **verifying** a submitted card and
**returning** one to its tester.

An administrator books a card the same way anybody does: by holding `use`,
which the `role_permissions` seed grants them. That is deliberate — it means an
explicit revocation in Control Center actually revokes.

**And the screen now agrees with the database about that.**
`deriveCustomerReviewCapabilities` used to return all-capabilities for any
`role === 'admin'`, so an administrator whose `use` had been revoked was still
drawn a **Book** button — and `book_customer_review_test_card()`, which asks
`resolve_permission` and has no administrator branch, refused it 42501. The
short-circuit is gone: `canUse` is the resolved permission, for everybody.

| Capability | Resolved from | Admin short-circuit? |
| --- | --- | --- |
| `canUse` | `customer_review_requests.use` | **No** — matches the SQL, which has none either |
| `canVerify` | `customer_review_requests.verify` **or** `role === 'admin'` | Yes |
| `canAccessModule` | `canUse \|\| canVerify` | via `canVerify` |

> **The remaining asymmetry, stated rather than left to be found.**
> `canVerify` still admits an administrator directly. An administrator whose
> `verify` is explicitly revoked would be offered **Verify test** and refused by
> `transition_customer_review_test_card()`, which is a smaller version of the
> same mismatch. It is kept because narrowing verifier authority was not part of
> the correction that was asked for, and because the seed grants admins
> `verify` so the case only arises after a deliberate revocation. Closing it is
> a one-line change to the same function.

> **What this costs, stated rather than hidden.** Once a card is submitted its
> screenshot is frozen for everybody, so an image uploaded by mistake can only
> be corrected by a verifier **returning** the card to its tester first. That is
> a real extra step, and it is the price of not letting administrators act as
> testers.

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

**There is no fourth screen.** A verified card appears in no list, and there is
no History tab, no sidebar entry and no `?tab=` value that reaches one.

### Why a verified card is not in the frontend at all

The product owner's rule is that a finished card leaves the interface. It is
implemented as an **absence of a query**, not as a filter:

* `TAB_STATUSES` has three entries and none of them contains `verified`. Every
  read the list makes is `.in('status', TAB_STATUSES[tab])`, so no query the
  screen can issue asks for a verified card. There is nothing to un-hide and no
  filter a URL could clear.
* `TABS` has three keys, so `?tab=history` is not a value the URL codec
  accepts — it falls back to Available.
* **The card screen declines one too.** That route is addressed by id, and a
  verifier who has just verified a card is standing on its URL; leaving it
  readable there would be hiding the card from the lists rather than removing
  it. A verified card takes the same "that test card is not available" path as
  one the reader may not see, and verifying navigates back to **To verify**
  rather than reloading into that message.

> **Nothing is deleted, and nothing about who may READ a card changed.** The row
> keeps every timestamp, the verifier's note and the whole append-only trail,
> and RLS still lets a verifier select it — the live assertions read one back on
> purpose (§9b) to prove it. What changed is that this module offers no way to
> ask. Restoring a history screen later would be a new feature, not a rollback.

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

### Any valid number — and what checks it

There is **no allowlist and no environment variable**. An authorized tester
types the number they want to test against, and the field says so: *Enter
WhatsApp number*.

"Any number" widened who can be reached. It widened nothing about who can reach
them:

* **Only an active employee holding `customer_review_requests.use`, and only for
  a card THEY hold.** Checked in the route and, independently, by the card's own
  RLS — the read runs as the caller. A verifier can *read* every card; reading is
  not holding.
* **The number is normalised and validated on the server**, whatever the browser
  did with it. The same function runs in both places; the browser's copy is a
  courtesy that saves a round trip.
* **The tester must tick the confirmation** (§ below). It is a required field of
  the request.
* **The message still carries the permanent internal-test label**, re-checked by
  the server on the way out and by the browser before anything opens.

#### What counts as valid

| Accepted | Refused |
| --- | --- |
| `+919999900001` | empty, whitespace |
| `+91 99999 00001` | fewer than 8 digits |
| `+91-99999-00001` | more than 15 digits |
| `+91 (999) 990-0001` | letters or stray punctuation — `+91 98765 4321O` |
| `0091 99999 00001` | a **bare national number** — `9999900001` |
| `+1 (415) 555-0100` | a leading zero after the country code |

Spaces, `+`, hyphens, dots, parentheses and the various Unicode dashes people
paste out of documents are all separators and are removed. Anything else is
**checked, not stripped** — stripping a mistyped letter would turn
`+91 98765 4321O` into a valid-looking number one digit short of the one that
was meant, and the link would open a chat with a stranger.

**The country code is required**, and this is the one rule that got *stricter*
when the allowlist went away. While only BOE's own numbers were reachable,
assuming `+91` for a bare ten digits was a safe convenience. Now that any number
can be typed, that assumption would be silently choosing which country gets
messaged.

**No error message contains any part of the input.** These strings are shown on
a screen and returned by the route, and a validation message that quoted the
number would put it somewhere nobody audited.

### The confirmation

Before a link is produced, the tester must tick:

> I confirm this number may receive an internal BOE test message and the content
> will not be published as a customer review.

It is checked **on the server, before the number is even parsed**, and it is
checked *strictly*: `confirmed === true`. `'yes'`, `1` or a missing field are not
confirmations — a truthy check would let a client tick the box by accident,
which is the opposite of what a deliberate confirmation is for.

The sentence lives in two places (the route and the component, because a Client
Component must not import a module that reads server-only configuration) and a
source-contract test pins the two strings to each other.

### What is kept afterwards

**The number is never stored, never logged, never put in an event, and never in
a fixture.** It exists in one request body, for the length of one request, and
in the `wa.me` URL the server hands back to the browser that asked for it.

What the card keeps instead is one column:

| Column | What it holds |
| --- | --- |
| `whatsapp_target_last_four` | the final four digits, so a person recognises a number they typed |

It is sliced off the validated E.164 form in the route. **SQL never sees a
number** — the RPC's only recipient parameter is those four digits, shape-
guarded, so no future caller can accidentally store one.

> **An earlier design also kept a keyed HMAC fingerprint** so that two tests
> sent to the same number could be recognised as the same recipient. It is
> gone. Nothing in this workflow correlates recipients, so the fingerprint was a
> credential dependency and a rotation hazard bought for no benefit — and it
> reused `SUPABASE_SERVICE_ROLE_KEY`, which is not what that credential is for.
> If correlation is ever genuinely required, it needs a dedicated server-only
> `CUSTOMER_REVIEW_RECIPIENT_HMAC_KEY` with fail-closed validation and a
> documented rotation story — not a borrowed key.

### Why the server builds the link

Because everything above is only true if this is the only path. If the browser
assembled the `wa.me` URL, the validation, the confirmation and the label would
each be a suggestion that a devtools console could skip.

`POST /api/customer-reviews/whatsapp` validates the number, requires the
confirmation, reads the card **as the caller**, checks that the caller holds it,
composes the message from the card row and the constants, and returns the URL.
The browser builds nothing — a source-contract test asserts that the component
contains no `wa.me` literal at all.

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
still hold the card**, and nobody else may withdraw one at all — see the note
under §4.

### One live screenshot per card, enforced by the database

`MAX_TEST_SCREENSHOTS = 1` used to be protected only by a count in the route.
That was a **read followed by a write**: two concurrent uploads with different
content both read zero and both inserted.

Two partial unique indexes now make it a database guarantee:

| Index | What it prevents |
| --- | --- |
| `customer_review_screenshot_one_live_per_card` on `(card_id) where removal_started_at is null` | a second live screenshot on one card, under any concurrency |
| `customer_review_screenshot_unique_live_content` on `(card_id, content_sha256) where removal_started_at is null` | the same bytes registered twice while live |

`where removal_started_at is null` is load-bearing on both. A row marked for
removal is already invisible to every reader (the SELECT policy filters it), so
it must not occupy the slot either — otherwise a **failed object deletion would
leave the card permanently unable to accept a replacement, including the very
same file**. The old plain `unique (card_id, content_sha256)` constraint had
exactly that defect and is gone.

The route still counts first, because refusing before five megabytes are decoded
and uploaded is kinder. When the race is genuinely lost, the insert comes back
`23505` and the route maps it to the same sentence the count would have
produced — so a tester sees one answer however the race went.

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
| `record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)` | takes the actor, plus the recipient **already reduced** to four digits |
| `begin_customer_review_test_screenshot_removal(uuid, uuid)` | takes the actor |
| `finish_customer_review_test_screenshot_removal(uuid)` | the second half of a removal |

Internal helpers, explicitly revoked from `public`, `anon` and
`authenticated`:
`assert_customer_review_test_card_submittable(uuid)`,
`customer_review_test_screenshots_log_removal()`.

> **Stated precisely, because "reachable by nobody" would be false.** The
> platform's default privileges leave every new function in `public` executable
> by `service_role`, and this migration revokes only the client roles — so
> `service_role` can in principle call those two. That adds nothing: it bypasses
> RLS entirely and never leaves the server, so anything it could learn by
> calling them it could read directly. What matters, and what the migration
> asserts, is that **no browser role can reach them**.

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
| `contact.test.ts` | every accepted spelling normalises to one form; empty, malformed, too-short, too-long and bare-national numbers are refused; no error echoes the input |
| `recipientPrivacy.test.ts` | the reduction, its fail-closed cases, and that no full number reaches a column, a parameter, a log line, an event or a fixture |
| `whatsappRoute.test.ts` | the number is validated and the confirmation required before a link exists; a non-owner is refused; nothing in `src/` can send; no environment variable is needed |
| `status.test.ts` | the four statuses, who may make each move, and what a submission needs |
| `migration.test.ts` | the schema, the policies, the grants, and that the SQL transition table matches the browser's edge for edge |
| `securityContract.test.ts` | function by function: pinned `search_path`, no acting-user parameter, row locks, SQLSTATEs, and what each grant admits |
| `uploadRoute.test.ts` | the upload path, the generated key, and the two-route inventory |
| `photoRemoval.test.ts`, `photoRemovalRetry.test.ts` | removal is one operation, is idempotent, and converges after a failure |
| `fixture.test.ts` | the fixture cannot run against production, and none of its content reads as a review |
| `customerReviewOutreach.test.ts` | the guard, the launcher, Control Center, and what the screens offer |
| `supabase/tests/customer_review_test_card_assertions.sql` | **executed against a database**: exact SQLSTATEs, double booking, inactive accounts, visibility, that a verified card matches none of the three tab status sets, and that its record survives anyway |

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

# Customer Review Outreach

**Status:** built, tested, **NOT deployed**. The migration exists in the
repository and has **not been applied to any database — local or remote**. The
module is unreachable until it is.

Route: `/customer-reviews` · Module key: `customer_review_requests` ·
Migration: `supabase/migrations/20261017000000_customer_review_outreach.sql`

---

## 1. Purpose

An authorized BOE employee prepares a **neutral invitation** for a customer or
project contact they have actually dealt with, opens WhatsApp with that
invitation prefilled, and afterwards records what happened.

The customer writes and publishes the review **themselves, from their own
account, in their own words**. This system prepares an invitation. It does not
send messages, and it never writes a review.

## 2. The ethical boundary

These are product rules, and most of them are enforced structurally rather than
by a policy somebody has to remember.

| The module must never… | What stops it |
| --- | --- |
| Fabricate a customer, project or experience | `genuine_customer_confirmed` is a required confirmation, checked by `assert_customer_review_ready()` before a request can leave Draft |
| Generate or supply review wording | There is no review-text field, table or code path. `buildInvitationMessage()` produces an invitation only, and its test asserts the message contains no quoted wording, no “you could say”, and no claim about BOE's work |
| Ask an employee to post as a customer | Nothing in the module accepts review text at all |
| Request five stars or any rating | Asserted by test against every spelling of “five star”, “rate us”, “good review” |
| Insert praise or prescribed wording | The employee edits two fields — the greeting and a factual project reference. There is no message editor and **no `message_body` column** |
| Hide or discourage critical feedback | The closing two sentences are constants (`NEUTRAL_FEEDBACK_SENTENCE`, `CUSTOMER_CHOICE_SENTENCE`), not fields. `hasNeutralLanguage()` disables the WhatsApp button if either is ever missing |
| Reward anyone by submission, rating or sentiment | No rating, score, sentiment, points or leaderboard exists in the schema or the UI. Asserted by test against the migration text and the list screen |
| Send WhatsApp messages automatically | The only outbound step is `window.open` on a `wa.me` link, started by a click. A person still presses send in WhatsApp |
| Claim automatically that a review was posted | `review_public_url` is optional factual evidence recorded by a person. No status is derived from it, and `verified` requires a separate permission and a separate deliberate action |
| Store unnecessary private data | One private field: the customer's WhatsApp number. Masked everywhere by default, never logged, never in a query string other than the `wa.me` URL |

**Selecting who to ask.** The module does not filter, rank or suggest customers.
Which customers to invite is the employee's judgment, and the list screen offers
no signal that would steer it.

## 3. Roles and permissions

Two permissions, registered in the existing Control Center permission engine.
The module deliberately registers **no `view` action**.

| Permission | Grants |
| --- | --- |
| `customer_review_requests.use` | **Module entry.** Raise a request, edit their own while it is being prepared, attach photographs, mark it Ready to Send, open WhatsApp, confirm they sent it, record a reply and evidence, cancel it. Sees **their own requests only** |
| `customer_review_requests.verify` | Read **every** request, verify one, and close it. Implies module entry. Does **not** grant raising, editing or sending |

* `verify` is a **PROTECTED action** (`src/lib/permissions/levels.ts`): no
  preset level ever grants it. It has to be ticked deliberately in Custom.
* `verify` **depends on** `use` (`ACTION_DEPENDENCIES`), so ticking it brings
  module entry with it, and withdrawing `use` takes `verify` with it.
* The migration grants role defaults to **`admin` only**. `manager` and `member`
  get nothing: who runs outreach, and who signs it off, are per-person
  decisions.
* Admins bypass the engine, as in every other cut-over module.

### Why `use` and not `view`

Every other module here gates entry on `view` (`moduleVisibility.ts`). This one
cannot: a `use` holder sees **their own** outreach and nobody else's, so a
separate read-only grant would name an empty screen. `use` **is** entry.

The consequence is handled rather than tolerated. `entryActionForModule()` in
`levels.ts` resolves a module's entry action from the actions it registers
(`['view', 'use']`, in that order), and Control Center's module switch reads it
— so the On/Off control writes `use` for this module and `view` for every other
one. Without that, the switch would have read “Hidden” however much access an
employee held, and turning it on would have written nothing.

### Where each permission is enforced

| Surface | Enforcement |
| --- | --- |
| Launcher card | `src/app/modules/page.tsx` → `deriveCustomerReviewCapabilities(...).canAccessModule`, resolved for the **signed-in** user (View As lends nothing) |
| Route entry (all four screens) | `src/app/customer-reviews/layout.tsx` → `hasPermission(..., 'use')` or `'verify'`, admin short-circuit, fails closed on a missing or inactive profile |
| Reading any request, photo or event | RLS `SELECT` policies → `can_view_customer_review_request()` |
| Creating a request | RLS `INSERT` policy: `created_by = auth.uid()`, `status = 'draft'`, no lifecycle field pre-set, and `use` (or admin) |
| Editing a request | RLS `UPDATE` policy → `can_edit_customer_review_request()`, **plus a column grant** limiting writes to the ten form fields |
| Any status change | `transition_customer_review_request()` (SECURITY DEFINER) — transition table, then permission, then prerequisites |
| Verifying / closing | The `verified`/`closed` branch of that function requires `verify` |
| Opening WhatsApp | `record_customer_review_whatsapp_opened()` — owner + `use`, status must be `ready_to_send`, prerequisites re-checked |
| Recording evidence | `record_customer_review_evidence()` — owner + `use`, status `sent` or `customer_responded`, https only |
| Photograph objects | Storage policies on `storage.objects`, keyed on the request id in the object path |

**There are no API routes.** Enforcement is in the database — RLS plus SECURITY
DEFINER functions — which is the pattern Meetings (20260814000000) and Order
Requests use. A route would have added a second place for the rules to live.

## 4. Status model

Seven statuses, and no eighth.

| Status | Means |
| --- | --- |
| `draft` | Being prepared. Incomplete is fine |
| `ready_to_send` | Every sending prerequisite is met. Nothing has left BOE |
| `sent` | The employee **confirmed** they sent it. A person's deliberate claim |
| `customer_responded` | The customer replied. Says nothing about a review |
| `verified` | A `verify` holder checked the evidence and said so |
| `closed` | Verified and finished with |
| `cancelled` | Abandoned before it was verified |

### Transitions

```
draft              → ready_to_send, cancelled
ready_to_send      → draft, sent, cancelled
sent               → customer_responded, verified, cancelled
customer_responded → verified, cancelled
verified           → closed
closed             → (terminal)
cancelled          → (terminal)
```

* **One shared place.** `CUSTOMER_REVIEW_TRANSITIONS` in
  `src/lib/customerReviews/status.ts` is the browser's copy;
  `transition_customer_review_request()` holds the deciding copy.
  `migration.test.ts` asserts the two are identical, branch by branch.
* `verified` and `closed` need `verify`. Everything else needs to be the
  **owner** (or an admin) — a verifier does not run somebody else's outreach.
* Cancelling stops at `customer_responded`: a verified or closed request is a
  finished record of something that happened.
* There is no path from “WhatsApp was opened” to `sent`.

### Ready-to-Send prerequisites

Checked in `readyToSendBlockers()` and, decisively, in
`assert_customer_review_ready()`:

1. genuine-customer confirmation ticked
2. customer / project name
3. a valid WhatsApp number
4. an interaction type
5. an https review destination
6. **if any project photograph is attached** — the image-sharing confirmation

The internal note is deliberately **not** a prerequisite: it never reaches the
customer, so requiring it would be requiring paperwork.

## 5. Data model

`customer_review_requests`
: One outreach. Holds the customer name, E.164 number, interaction type,
internal note, the two editable invitation fragments, the review destination,
the two confirmations, ownership, and the lifecycle timestamps. **No message
body** — the invitation is assembled, never stored.

`customer_review_request_photos`
: Metadata for objects in the private bucket. `kind` is `project_photo` or
`review_proof`. `storage_path` is UNIQUE, and a CHECK requires its first segment
to equal the request id.

`customer_review_request_events`
: Append-only trail: `created`, `status_changed`, `whatsapp_opened`,
`evidence_recorded`. No client role holds INSERT, UPDATE, DELETE or TRUNCATE,
and there is no write policy of any kind.

### The four facts that are never collapsed

| Column | Means | Does **not** mean |
| --- | --- | --- |
| `whatsapp_opened_at` / `_count` | The invitation was handed to WhatsApp | Sent, delivered, or read |
| `sent_at` / `sent_by` | An employee confirmed they sent it | WhatsApp confirmed anything |
| `responded_at` / `responded_by` | Somebody observed a reply | A review exists |
| `verified_at` / `verified_by` | A `verify` holder checked it | — |

`review_public_url` is a fifth, separate fact: a link somebody pasted. Its
presence is never verification.

## 6. Storage

* Bucket `customer-review-photos`: **private**, 5 MB per object,
  `allowed_mime_types` = `image/jpeg`, `image/png`, `image/webp`.
* The bucket's own limits are the **server-side** validation.
  `validateReviewPhoto()` mirrors them exactly so a file that passes in the
  browser cannot then be refused by Storage; `mime_type` and `byte_size` CHECK
  constraints on the metadata row are a third gate.
* Object key: `<request_id>/<kind>/<timestamp>_<random>.<ext>`. **Nothing the
  user typed reaches the path** — only a sanitised extension. Collisions are
  impossible; a crafted filename cannot escape the folder.
* Reads are short-lived signed URLs only, and `createSignedUrl` is governed by
  the same SELECT policy as reading the request. No public URL is ever built.
* Uploading is two writes (object, then metadata row). If the row fails, **the
  object is removed again** before the function returns, so a failed attach
  leaves nothing orphaned.
* `project_photo` can be attached and removed while the request is being
  prepared. `review_proof` can be attached once the request is `sent` and
  **cannot be removed by a client** — evidence offered for verification must not
  vanish from under the verifier.

## 7. Screens and routes

| Route | Screen |
| --- | --- |
| `/customer-reviews` | Request list — status tabs, search, desktop table / mobile cards, masked number, empty / loading / error states. Verifier-only “To Verify” tab |
| `/customer-reviews/new` | Create — confirmations, customer, number, interaction, internal note, destination, invitation fields, live preview |
| `/customer-reviews/[id]` | Request detail — six milestones, permission-gated actions, exact invitation, photographs, evidence, verification, history |
| `/customer-reviews/[id]/edit` | Edit — the same form with photographs live. Only while `draft` or `ready_to_send` |

Shell: `src/components/layout/CustomerReviewsLayout.tsx`, following the BOE
Module Layout Standard (Home button to `/modules`, module-only navigation,
shared user area).

## 8. Validation rules

| Input | Rule |
| --- | --- |
| Customer / project name | Required (NOT NULL), non-blank, ≤ 120 chars |
| WhatsApp number | Normalised to E.164. A **bare 10-digit** number gets `+91`; anything with `+`, `00`, or another length is taken at face value. Stored only if it matches `^\+[1-9][0-9]{7,14}$` (CHECK + client) |
| Interaction type | One of eight fixed keys (CHECK) |
| Internal note | ≤ 500 chars |
| Greeting name | ≤ 120, non-blank if present |
| Project reference | ≤ 160 chars |
| Review destination | `https:` **only**, parseable, hostname present, **no credentials**, ≤ 500 chars. Refused: `http:`, `javascript:`, `data:`, `file:`, `ftp:`, bare hostnames |
| Public review URL | Same rule, re-checked in the RPC and by a column CHECK |
| Photographs | JPEG / PNG / WEBP, ≤ 5 MB, ≤ 6 project photos. An extension can never launder a disallowed type |

Draft saving is lenient. Three things are still checked on every save, because
each would be stored *wrong* rather than merely missing: the name, a number that
is not a number, and an unsafe link.

## 9. Privacy behaviour

* The number is masked to its **last four digits** everywhere by default
  (`•••• •••• 0001`) — the country code is not shown. A deliberate per-instance
  reveal exists on the detail screen only; the list has none, because a list is
  what gets screenshotted.
* Masking is a display control, not the boundary. Who may read a number at all
  is the SELECT policy.
* The number, the message body, signed URLs and proof contents are **never**
  logged. A test walks every module file and fails on a `console.*` call whose
  argument could carry a request row.
* Validation failures never echo the number back.
* The audit trail stores decisions, never the private data behind them.
* A request the caller may not read returns **no row**, and the screen says “not
  available” — it neither confirms nor denies that the request exists.
* `service_role` is used nowhere in this module; every read and write is the
  signed-in user's, under RLS.

## 10. What opening WhatsApp does and does not prove

**Does:** the invitation was complete, the database re-authorized the employee,
and a `wa.me` link was opened with the exact previewed message prefilled.

**Does not:** that WhatsApp accepted it, that it was delivered, that it was
read, or that anybody pressed send.

The button awaits `record_customer_review_whatsapp_opened()` **before** pointing
the tab at `wa.me`; if the database refuses, the tab is closed and the message
never reaches WhatsApp. The RPC writes `whatsapp_opened_at` and never touches
`status` or `sent_at`. Confirming “I sent this invitation” is a separate click,
worded as the employee's own claim.

Repeated clicks are stopped twice: an in-flight ref (state is too slow for two
clicks in one tick) and a 5-second cooldown.

## 11. Test coverage

| File | Covers |
| --- | --- |
| `src/lib/customerReviews/invitation.test.ts` | Exact wording, locked sentences, no rating language, no supplied review text, the internal note is not even a parameter, **preview ↔ `wa.me` parity** |
| `src/lib/customerReviews/contact.test.ts` | Normalisation, E.164 validation, masking, `waMePhone`, and a sweep asserting no module file logs the number |
| `src/lib/customerReviews/destination.test.ts` | https-only, credentialled URLs, every unsafe protocol, no invented BOE review link |
| `src/lib/customerReviews/status.test.ts` | The transition table, terminal states, verifier-only moves, owner-only moves, Ready-to-Send blockers |
| `src/lib/customerReviews/photos.test.ts` | Type and size validation matching the bucket, extension laundering, path generation, collision resistance |
| `src/lib/customerReviews/migration.test.ts` | RLS on every table, no `USING (true)`, append-only trail, the column grant excludes `status`, storage policies, SQL transition table **identical** to the UI's, deny-by-default registration |
| `src/lib/permissions/customerReviewOutreach.test.ts` | Registry, protected/dependency wiring, capability derivation, per-request edit rule, the route guard, the launcher card, Control Center, and the screens' RPC and double-click discipline |

Fictional data throughout (`+91 99999 000xx`, `example.test`).

## 12. Local setup and manual testing

The migration is **not applied**, so the module is unreachable until somebody
applies it deliberately.

1. Apply `20261017000000_customer_review_outreach.sql` to a **disposable local
   or test** Supabase project. Never production, and not with `db push` against
   the linked remote.
2. `npm run permissions:sync` against that same project, so
   `permission_modules` matches the registry.
3. In Control Center → Access Control, grant a test employee **Use Customer
   Review Outreach** (Custom). Grant a second employee **Verify & Close Review
   Requests** — dependency resolution adds Use automatically.
4. `npm run dev`, sign in as the `use` employee, open `/modules`. The Customer
   Review Outreach card should appear.
5. **No-permission check:** sign in as an employee with neither grant. The card
   must be absent and `/customer-reviews` must bounce to `/coming-soon`.
6. New Request → tick the genuine-customer confirmation, enter a **fictional**
   name and number (`+91 99999 00001`), pick an interaction type, paste an
   `https://example.test/...` destination. Save draft. Confirm the blockers list
   clears as fields fill.
7. Edit → attach a photograph → confirm “Ready to Send” is blocked until the
   sharing confirmation is ticked.
8. Mark Ready to Send. **Do not send a real message.** Verify the WhatsApp link
   by inspecting it rather than following it:
   ```bash
   node -e "const {buildInvitationMessage,buildWaMeUrl,messageFromWaMeUrl}=require('./src/lib/customerReviews/invitation');const m=buildInvitationMessage({greetingName:null,customerName:'Test Customer',projectReference:null,reviewUrl:'https://example.test/r'});console.log(messageFromWaMeUrl(buildWaMeUrl('919999900001',m))===m)"
   ```
   or, in the browser, right-click → Copy Link on the button's opened tab, or
   watch the network tab. Compare the decoded `text` parameter to the preview.
9. Confirm “I sent this invitation”, record a reply, record an `https` evidence
   link.
10. Sign in as the verifier: confirm they can see the request, that Verify asks
    what was checked, and that they cannot edit it. Confirm the **owner** is
    never offered Verify.
11. Repeat steps 4–9 at a 375 px viewport for the mobile card layout.

## 13. Known limitations

1. **Selecting an existing project photograph is not implemented.** BOE has no
   cross-module media library — images live inside Order submissions and
   Showroom products behind their own buckets and authorization — and building
   one would be a far larger piece of work than this module. Upload is the MVP
   path. Existing-image selection remains a later integration.
2. **No standing BOE review URL.** None exists in this repository, and inventing
   one would send real customers to an unverified address. The employee pastes a
   destination per request. A single configured default is a product decision
   with an owner.
3. **The `+91` default** applies only to a bare 10-digit number. It is a
   deliberate assumption and is documented in `contact.ts`.
4. **No notifications.** A verifier is not told a request is waiting; they open
   the To Verify tab. Adding one means touching the shared `notifications` enum,
   which is a separate migration.
5. **No API routes**, by design (see §3). Any future server-side work must not
   become a second place the rules live.
6. **Idempotency** is client locking (in-flight ref + cooldown) plus server-side
   transition checks and a `FOR UPDATE` row lock — not an idempotency-key
   platform. Two simultaneous “Mark Ready” calls: the second sees the new status
   and is refused. Two simultaneous WhatsApp opens: both may record an open,
   which is honest — the counter is a count of openings.
7. **Browser verification was not completed**; see §14.

## 14. Verification status

* `npm test`, `npx tsc --noEmit`, `npx eslint`, and `next build` — see the
  delivery report accompanying this change for the exact results.
* **Browser verification could not be completed**: the module's tables do not
  exist in any database this environment can reach, and the only credentials
  available point at production, which must not be used. The screens cannot be
  exercised without applying the migration to a disposable project first.
  §12 is the manual test procedure for whoever does that.

## 15. Out of scope

Not built, and deliberately: AI-written reviews, sample “genuine” reviews,
WhatsApp Business API sending, bulk campaigns, scheduled follow-ups, analytics
dashboards, leaderboards, points or incentives, sentiment analysis, rating
tracking, a settings area, a reusable workflow engine, a general media library.

## 16. Before this ships — needs a product-owner decision

1. **Apply the migration** to a disposable project and run the §12 procedure.
   Confirm the four prerequisites listed at the top of the migration file.
2. **Who holds `verify`?** The migration grants it to nobody. Somebody has to
   decide, per person.
3. **Should BOE have one standing review URL?** If yes, that is a small follow-up
   (a settings row plus a default in the form), and it is a decision, not an
   implementation detail.
4. **Should a verifier be notified** when a request is waiting? See limitation 4.
5. Confirm the invitation wording in §2 is the wording BOE wants to send.

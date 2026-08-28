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
* **Administrators hold both actions from the moment the migration applies** —
  `role_permissions` gets an admin row for every action the module registers.
  `manager` and `member` get nothing. Who else runs outreach, and who else is
  trusted to verify it, are per-person decisions in Control Center.
* The migration creates **no employee override**. That is a different level
  from the role rows above, and the distinction is the whole reason those two
  statements can both be true at once.
* Admins bypass the engine, as in every other cut-over module.

### Effective permissions after the migration

| Who | `use` | `verify` | Decided at |
| --- | --- | --- | --- |
| Admin role | **allowed** | **allowed** | `role` |
| Manager role | denied | denied | `system_default` |
| Member role | denied | denied | `system_default` |
| Explicitly assigned user | allowed | denied | `employee_override` |
| Explicitly assigned verifier | allowed | **allowed** | `employee_override` |
| Unauthorized employee | denied | denied | `system_default` |

Precedence is `employee_override > department > role > system_default`
(20260660 §7). Ticking **Verify** in Custom brings **Use** with it, because
`verify` depends on `use`. Proved in
`src/lib/permissions/customerReviewEffectiveAccess.test.ts`.

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
sent               → customer_responded, cancelled
customer_responded → verified, cancelled
verified           → closed
closed             → (terminal)
cancelled          → (terminal)
```

**The middle is one path, with no shortcut.** `sent → verified` existed in the
first cut and was removed in the pre-review audit. Verification means "somebody
checked that this customer published a review", and a request in `sent` is one
where nothing has come back at all — so that edge let a verifier jump from "we
sent a message" to "the review is confirmed" with no recorded response in
between, and made `customer_responded` a step people could skip.

**Recording a published review URL on a `sent` request moves it to
`customer_responded`.** A published review *is* a response, and leaving the
request in `sent` would mean the record said "we heard nothing" while holding a
link to what the customer wrote. The move writes its own `status_changed` trail
row. It never verifies anything: `verified_at` is written in exactly one place
in the whole migration, and that is the `verify` branch of the transition
function.

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
6. a neutral invitation — the greeting and the project reference must not ask
   for a rating or a positive review (`containsSteeringLanguage()` /
   `customer_review_text_steers()`)
7. **at least one real project photograph**
8. the image-sharing confirmation

The internal note is deliberately **not** a prerequisite: it never reaches the
customer, so requiring it would be requiring paperwork.

**Why a photograph is required, given that it is never sent.** A `wa.me` link
carries a phone number and a text parameter and nothing else — there is no way
to attach a file to one. The photograph is BOE's own private reference,
anchoring the request to work actually done for this customer; an outreach
nobody can show a photograph of is an outreach nobody can evidence. The employee
shares images by hand in the chat if they choose to, which is what the
image-sharing confirmation covers.

**Why the steering check exists.** The closing two sentences are a constant and
cannot be edited — but the greeting and the project reference are editable, and
without this an employee could type "please give us 5 stars" into a factual
reference and send a message that solicits a rating in its first sentence and
disclaims it in its last. Checked in the browser *and* in
`assert_customer_review_ready()`.

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
* **Uploads go through one trusted server route**,
  `POST /api/customer-reviews/photos`. The browser cannot write an object or
  register one: `authenticated` holds no storage INSERT policy for this bucket,
  no metadata INSERT policy, and no INSERT privilege on the metadata table.
  The migration asserts all three at apply time.
* **Two gates, in order.** `inspectImageBytes()` parses the container — PNG
  signature + IHDR + IEND, JPEG SOI + SOF + EOI, WEBP RIFF — and requires it to
  account for the **whole file**, so appended payloads are refused. It is a
  parser, not a decoder, and its job is to keep unsupported containers away
  from the decoder — which matters because **libvips accepts SVG and this does
  not**.
* **Then the file is decoded and re-encoded**, and the *output* is what is
  stored. See §6a for exactly what that does and does not guarantee.
  `mime_type` and `byte_size` describe the re-encoded bytes, so they are facts
  a server established rather than claims a browser made.
* `validateReviewPhoto()` still runs in the browser first. It is a **courtesy**
  — it saves a five-megabyte round trip to be told no — and is explicitly not
  the boundary.
* The **object key is generated on the server** from the request id and a fresh
  uuid. No path, bucket or key is accepted from the body; the only three fields
  read are `requestId`, `kind` and `file`.
* A repeated upload is refused by **content hash** (`content_sha256`), in the
  route and again by a per-request unique constraint — so a double click is one
  attachment whatever races with what, and a genuinely different photograph is
  never blocked.
* Object key: `<request_id>/<kind>/<timestamp>_<random>.<ext>`. **Nothing the
  user typed reaches the path** — only a sanitised extension. Collisions are
  impossible; a crafted filename cannot escape the folder.
* Reads are short-lived signed URLs only, and `createSignedUrl` is governed by
  the same SELECT policy as reading the request. No public URL is ever built.
* Uploading is two writes (object, then metadata row). If the row fails, **the
  object is removed again** before the function returns, so a failed attach
  leaves nothing orphaned.
* `project_photo` can be attached and removed by its owner while the request is
  being prepared. `review_proof` can be attached once the request is `sent` and
  is **not** removable by its owner — evidence offered for verification must not
  vanish from under the verifier.
* **An admin may withdraw either kind at any status**, and this is a deliberate
  second door. Without it an image uploaded by accident — the wrong customer's
  site, a bystander in shot, a photograph BOE turns out not to have permission
  for — would be permanently unremovable the moment the request left
  `ready_to_send`. Every removal writes a `photo_removed` row to the
  append-only trail, so a correction is recorded rather than silent. The
  metadata policy and the storage policy grant the same door, because a route
  that removed one without the other would leave an orphan or a broken
  reference.
* **A request that still holds photographs cannot be deleted.** The metadata
  rows cascade from the request and the objects do not, so deleting one would
  strand every object it named with nothing left to name them. Empty it first;
  removing a photograph deletes the row and the object together.

## 6a. Byte validation — the exact guarantee

Every accepted file is **decoded and re-encoded by libvips (`sharp`), and the
re-encoded output is what is stored.** The uploaded bytes are never written,
never hashed and never described by the metadata row.

**What that guarantees**

* The stored object is bytes a decoder produced, not bytes a caller supplied.
* **EXIF, ICC, XMP and IPTC are gone.** This is a privacy fix as much as a
  safety one: a phone photograph of a customer’s premises carries GPS
  coordinates, a device serial and a timestamp, and BOE has no business
  storing any of it. EXIF orientation is applied first, so photographs stay
  upright.
* Anything appended to the original is gone, because it was never part of the
  decoded image. (It is also refused earlier, by the structural gate.)
* A file the decoder cannot read is refused rather than stored as a future
  broken thumbnail.
* The parser and the decoder must **agree** on the format; a disagreement is a
  refusal, not something to reconcile.
* A decompression bomb is capped at 50 megapixels — far above a 48 MP phone
  camera, far below trouble.

**What it does not guarantee.** The structural parser on its own cannot prove
that every malformed or embedded-payload file is rejected, and this
documentation does not claim it does. What closes that gap is the re-encode:
anything the decoder does not carry into its output does not reach storage.
The residual boundary is the decoder itself — a vulnerability in libvips would
be reached by any image-handling system that decodes, and this one decodes on
the server, in a Node runtime, on bytes already narrowed to three containers.

**Always refused:** SVG, HTML, scripts, executables, archives, PDF, GIF, TIFF
and every other unsupported container; appended data; invalid or truncated
length declarations; a signature that disagrees with the extension; an empty
file; anything over 5 MB.

**No dependency was added.** `sharp` is already in `package.json` and already
runs server-side in production (`src/app/api/showroom/quotation/[id]/route.ts`,
`src/lib/orders/confirmedPdfRender.ts`). `package-lock.json` is untouched.

## 6b. Removing a photograph

**Removal is one server operation**, `DELETE /api/customer-reviews/photos`,
because it spans the private bucket and the metadata table and no transaction
covers both. A browser that could delete either half on its own would sooner
or later delete exactly one — leaving a file nothing names again, or a record
pointing at nothing.

| Step | What it does |
| --- | --- |
| **Mark** | `begin_customer_review_photo_removal()` re-checks the authorization in SQL, locks the row, stamps `removal_started_at` / `removal_by`. Every read filters the row out from this moment |
| **Object** | the file is deleted from the private bucket |
| **Row** | `finish_customer_review_photo_removal()` deletes the metadata; the delete trigger writes the `photo_removed` entry, crediting `removal_by` |

**Partial failure is explicit.** If the object deletion fails, the row stays
marked and still names its path — nothing is orphaned, the photograph is
already invisible, and a retry converges because both functions are
idempotent. If the row deletion fails, the caller is told the image is gone but
the record is not, which is true.

**Who may remove what** (enforced in the SQL, and again in the route):

* the **owner** (with `use`): a project photograph while the request is `draft`
  or `ready_to_send`; review proof only while the request is **unverified** —
  evidence a verifier has acted on must not vanish from underneath their
  decision;
* an **admin**: either kind, at any status, verified included, as a correction.

Both SQL halves take the actor as a parameter and are granted to
**`service_role` alone** — a browser able to call either could name anybody.

## 7. Screens and routes

| Route | Screen |
| --- | --- |
| `POST /api/customer-reviews/photos` | Trusted upload — validate, decode, re-encode, store |
| `DELETE /api/customer-reviews/photos` | Trusted removal — mark, delete object, delete row, audit |
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

**And it does not send the photographs.** A `wa.me` link carries a phone number
and a text parameter; there is no way to attach a file to one. The project
photographs are stored privately with the request as BOE's own reference. If
the employee wants the customer to see them, they open each one from the
request screen to save it and **attach the files themselves in WhatsApp before
sending**. The request screen carries a download control on every photograph
for exactly that, using the same short-lived signed URL the preview uses.

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
| `src/lib/customerReviews/photos.test.ts` | The browser-side courtesy check, extension laundering, path shape, collision resistance |
| `src/lib/customerReviews/imageBytes.test.ts` | The real validator, driven by byte fixtures built to spec: genuine PNG/JPEG/WEBP accepted; PDF, ZIP, ELF, EXE, SVG, HTML, GIF, TIFF refused; disguised, truncated, malformed and **polyglot** files refused; the size limit is the real length |
| `src/lib/customerReviews/imageProcessing.test.ts` | The re-encode, run for real through libvips: the three formats survive; **EXIF does not**; appended payloads do not; **SVG is refused even though the decoder would take it**; damaged and truncated files are caught by the decoder |
| `src/lib/customerReviews/photoRemoval.test.ts` | That a client can delete neither an object nor a metadata row; the route’s authorization, its three-step order, and its explicit partial-failure handling; the two SQL halves being service-role-only, locked and idempotent; verified proof being admin-only; the audit entry crediting the remover |
| `src/lib/customerReviews/uploadRoute.test.ts` | The route: authentication before the body is read, `use` resolved, caller-scoped RLS read, kind/status rules, inspection before storage, server-generated path, no path field in the body, cleanup on metadata failure, closed-list errors, no service-role key on the client, and the database half of the boundary |
| `src/lib/customerReviews/draftLeniency.test.ts` | Column nullability, what a bare draft may omit, that a supplied-but-invalid value is still refused, and that both gates re-check in the database |
| `src/lib/customerReviews/migration.test.ts` | RLS on every table, no `USING (true)`, append-only trail, the column grant excludes `status`, storage policies, SQL transition table **identical** to the UI's, deny-by-default registration |
| `src/lib/permissions/customerReviewOutreach.test.ts` | Registry, protected/dependency wiring, capability derivation, per-request edit rule, the route guard, the launcher card, Control Center, and the screens' RPC and double-click discipline |
| `src/lib/permissions/customerReviewEffectiveAccess.test.ts` | The resolver's four levels modelled against the migration's own seed rows — what admin, manager, member, an assigned user and an unauthorized user each end up holding |
| `src/lib/customerReviews/securityContract.test.ts` | Every SECURITY DEFINER function: pinned `search_path`, revoke-then-grant, no `service_role`, `auth.uid()`-only identity, inactive-user refusal, `FOR UPDATE` locking, no mass assignment, no field forgery, safe errors — plus the RLS read gate, storage path forgery, orphan prevention and the admin correction route |

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
3b. **Image validation now decodes and re-encodes** (§6a). The residual
   boundary is libvips itself: a vulnerability in the decoder would be reached
   by any system that decodes images, this one included. It runs server-side,
   in a Node runtime, on bytes already narrowed to three containers.
3c. **The steering check is a phrase list, not a sentiment model.** It catches
   the phrasings people actually use; a determined employee could still write a
   steered reference it does not match. It is one control among several, not a
   guarantee.
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

A pre-review audit of the first commit found and fixed: a NUL byte committed
into a test file (git had classified it as binary), `sent → verified` as an
unjustified shortcut, no way to correct an accidentally-uploaded image after
sending, storage objects orphaned by deleting a draft that held photographs, and
no check stopping an employee typing a rating request into the two editable
invitation fragments. All are described in place above.

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
2. **Who beyond an administrator should hold `verify`?** Administrators hold it
   from the moment the migration applies. Anyone else is a per-person decision
   in Control Center → Access Control.
3. **Should BOE have one standing review URL?** If yes, that is a small follow-up
   (a settings row plus a default in the form), and it is a decision, not an
   implementation detail.
4. **Should a verifier be notified** when a request is waiting? See limitation 4.
5. Confirm the invitation wording in §2 is the wording BOE wants to send.

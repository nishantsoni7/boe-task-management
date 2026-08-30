-- Review Workflow Test (Internal) — an internal rehearsal of a workflow.
--
-- WHAT THIS IS
-- ------------
-- An internal test phase. An authorized BOE employee opens a list of TEST
-- CARDS, books one, opens WhatsApp with a prefilled message addressed to ANY
-- VALID NUMBER THE TESTER ENTERS, confirms by hand that they sent it, uploads a
-- screenshot, and a verifier checks that the workflow was exercised.
--
-- WHAT IS NOT CLAIMED. The tester chooses the recipient, so this file promises
-- nothing about who receives a message — not that they are internal, and not
-- that they are not a member of the public. What IS true and enforced: nothing
-- is posted anywhere, and BOE never sends the message.
--
--     available -> booked -> submitted -> verified
--
-- WHAT THIS IS NOT
-- ----------------
-- It is not a customer review system, and this file is shaped so that it cannot
-- quietly become one:
--
--   * There is NO customer name, phone number, project reference, interaction
--     type or review destination column. Those fields existed in an earlier
--     draft of this module and are gone. A column that does not exist cannot be
--     populated by a future screen that seemed harmless at the time.
--   * There is NO review URL, no public destination, and no publish action
--     anywhere in this migration or in the application code above it.
--   * NO CLIENT ROLE CAN CREATE A CARD. Card text arrives from a local test
--     fixture (supabase/fixtures/) run against a disposable stack, never from
--     this migration and never from a browser. `authenticated` holds no INSERT
--     privilege on the card table and there is no INSERT policy.
--   * Nothing here sends a WhatsApp message. There is no WhatsApp API client in
--     this repository. The only artefact produced is a wa.me URL string, built
--     server-side, which a person may then click.
--
-- THE MANDATORY LABEL
-- -------------------
-- Every card and every message carries
--
--     INTERNAL TEST ONLY - NOT A CUSTOMER REVIEW - DO NOT PUBLISH
--
-- and an employee cannot remove it. The label is applied by trusted application
-- code (src/lib/customerReviews/internalTest.ts), and the reason it cannot be
-- removed is structural rather than procedural: employees do not author card
-- text at all. `authenticated` holds no INSERT and no UPDATE privilege on any
-- content column, so there is no form, API or RPC through which a single
-- character of a card can be supplied or altered. §9 is where that is enforced
-- and §12 is where it is asserted.
--
-- customer_review_internal_test_warning() below holds the SQL-side copy of the
-- string, and a source-contract test pins it to the TypeScript constant.
--
-- WHAT OPENING WHATSAPP MEANS HERE
-- --------------------------------
-- Nothing, on its own. Opening wa.me hands the message to WhatsApp; it does not
-- prove WhatsApp accepted it, delivered it, or that the tester pressed send.
-- The confirmation is therefore a SEPARATE, DELIBERATE call the tester makes
-- afterwards — see whatsapp_opened_at, which records the preparation, and
-- sent_confirmed_at, which records the person's claim. NO STATUS CHANGES WHEN
-- WHATSAPP IS OPENED, by any path, ever.
--
-- DELIBERATELY NOT BUILT
--   Reviews, ratings, customers, campaigns, scheduling, message composition,
--   public links, posting, analytics, leaderboards or incentives. None of these
--   have storage here on purpose.
--
-- ASSUMPTIONS TO CHECK BEFORE THIS IS APPLIED
--   1. public.set_updated_at() exists (it does — used by 20260814000000).
--   2. public.resolve_permission(uuid, text, text) exists (20260660).
--   3. public.users(id, role, is_active) exists.
--   4. permission_actions is keyed on action_key and carries is_system.
--   5. This migration inserts NO app_modules row. Module entry for this module
--      is decided by the permission engine action `use` and by nothing else —
--      see docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md. An app_modules row
--      would be a Control Center control that nothing reads, which is the exact
--      defect src/lib/permissions/moduleVisibility.ts was written to remove.
--   6. THE MODULE KEY STAYS `customer_review_requests`. The tables and
--      functions below are named for what they now are, but the permission
--      module key and its two actions (`use`, `verify`) are retained verbatim:
--      they are the identifiers Control Center grants are written against, and
--      renaming them would silently revoke every existing grant.

-- ═══ 1. Private bucket for test screenshots ════════════════════════════════
--
-- Images only, and only the three still-image formats this codebase already
-- trusts. 5 MB per object: these are phone screenshots, not documents. do
-- UPDATE rather than do NOTHING so the private/limit/type properties are
-- enforced even if a bucket with this id already exists.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-review-test-screenshots',
  'customer-review-test-screenshots',
  false,     -- private: no anonymous or public read, ever
  5242880,   -- 5 MB per file (5 x 1024 x 1024) — must equal TEST_SCREENSHOT_MAX_BYTES
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ═══ 2. The mandatory label, in SQL ════════════════════════════════════════
--
-- The SQL-side copy of INTERNAL_TEST_WARNING. It exists for two reasons:
--
--   1. So a source-contract test can prove the database and
--      src/lib/customerReviews/internalTest.ts hold the SAME string, rather
--      than two strings that look alike.
--   2. So the fixture's own CHECK below can refuse a card whose text tries to
--      carry its own copy of the label. The label is prepended by trusted code
--      at message-build time; a second copy baked into the body would be one an
--      editor could reword, which is precisely the failure mode being designed
--      out.
--
-- Written with plain ASCII hyphens. The application constant uses en dashes for
-- display; equality is asserted on the normalized form by the contract test,
-- which is stated there rather than assumed here.
create or replace function public.customer_review_internal_test_warning()
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select 'INTERNAL TEST ONLY - NOT A CUSTOMER REVIEW - DO NOT PUBLISH'::text;
$$;

revoke execute on function public.customer_review_internal_test_warning() from public, anon;
grant  execute on function public.customer_review_internal_test_warning() to authenticated, service_role;

-- ═══ 3. customer_review_test_cards ═════════════════════════════════════════

create table public.customer_review_test_cards (
  id uuid primary key default gen_random_uuid(),

  -- Four states, and no fifth. A CHECK rather than an enum, matching every
  -- other module here.
  --
  -- THERE IS NO 'returned' STATE. A verifier who cannot use the evidence sends
  -- the card back to 'booked' and records why (return_reason below). That gives
  -- the return action the workflow needs without adding a state, which is the
  -- smallest thing that answers it.
  status text not null default 'available' check (status in (
    'available',
    'booked',
    'submitted',
    'verified'
  )),

  -- ── What the card says ──
  --
  -- ALL THREE ARE FIXTURE-SUPPLIED. No client role holds INSERT or UPDATE on
  -- this table (§9), so nothing an employee types reaches any of them.

  -- Short human reference. Printed on the card and inside the message, so a
  -- screenshot can be matched back to a record without a uuid.
  card_ref text not null unique check (card_ref ~ '^TEST-[0-9]{3}$'),

  -- The ten scenario shapes the fixture covers. They vary LAYOUT AND MESSAGE
  -- HANDLING; they describe nothing that happened. Every key ends in `_test` so
  -- a category label can never be mistaken, on a screen or in a message, for a
  -- claim about a real project.
  test_category text not null check (test_category in (
    'restaurant_test',
    'cafe_test',
    'hotel_test',
    'resort_test',
    'bulk_order_test',
    'customisation_test',
    'delivery_test',
    'product_quality_test',
    'service_test',
    'issue_resolution_test'
  )),

  test_title text not null check (btrim(test_title) <> '' and length(test_title) <= 120),

  -- The generic, visibly fictional filler. Bounded at both ends so the fixture
  -- exercises short and long layouts without becoming a place to store prose.
  --
  -- THE TWO CHECKS THAT MATTER HERE:
  --   * it must not contain the mandatory label. The label is prepended by
  --     trusted code; a copy inside the body would be a copy an edit could
  --     reword, and the whole point is that there is nothing to reword.
  --   * it must not contain a URL. A card with a link in it is one step from a
  --     card with a review destination in it, and this module has no public
  --     destination of any kind.
  test_body text not null check (
    btrim(test_body) <> ''
    and length(test_body) between 20 and 900
    and position(public.customer_review_internal_test_warning() in upper(test_body)) = 0
    and test_body !~* '(https?://|www\.|wa\.me)'
  ),

  -- ── Who holds it ──
  --
  -- booked_by is written ONLY by book_customer_review_test_card(), from
  -- auth.uid(). It is never a parameter of anything a browser can call.
  booked_by uuid references public.users(id),
  booked_at timestamptz,

  -- ── Preparation, which is not delivery ──
  whatsapp_opened_at    timestamptz,
  whatsapp_opened_count integer not null default 0 check (whatsapp_opened_count >= 0),
  -- WHO THE LAST LINK WAS ADDRESSED TO — FOUR DIGITS, AND NOTHING ELSE.
  --
  -- A tester may enter any valid international number, so what lands here is
  -- not necessarily a colleague's. THE FULL NUMBER IS NEVER STORED, and this is
  -- the only trace of it that is.
  --
  -- AN EARLIER VERSION ALSO KEPT AN HMAC FINGERPRINT so that two tests sent to
  -- the same number could be recognised as the same recipient. It is gone:
  -- nothing in this workflow needs to correlate recipients, and a keyed digest
  -- that nothing consults is a credential dependency and a rotation hazard
  -- bought for no benefit. Four digits are what a person needs to recognise a
  -- number they typed, and that is the whole requirement.
  --
  -- The CHECK is a shape guard on the promise: four digits are four digits, and
  -- a phone number is not.
  whatsapp_target_last_four text check (
    whatsapp_target_last_four is null
    or whatsapp_target_last_four ~ '^[0-9]{4}$'
  ),

  -- ── The tester's own claim ──
  sent_confirmed_at timestamptz,
  sent_confirmed_by uuid references public.users(id),

  -- ── Handed over, and checked ──
  submitted_at timestamptz,
  submitted_by uuid references public.users(id),

  verified_at timestamptz,
  verified_by uuid references public.users(id),
  verification_note text check (verification_note is null or length(verification_note) <= 500),

  -- The return path. Recorded on the row so the tester sees WHY the card came
  -- back, without a fifth status existing to say it.
  returned_at   timestamptz,
  returned_by   uuid references public.users(id),
  return_reason text check (return_reason is null or length(return_reason) <= 500),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ── Shape rules the status has to obey ──
  --
  -- Each actor column travels with its timestamp, so a half-written row is not
  -- expressible even by the definer functions.
  constraint customer_review_test_cards_booking_consistent check (
    (booked_by is null and booked_at is null)
    or (booked_by is not null and booked_at is not null)
  ),
  constraint customer_review_test_cards_sent_consistent check (
    (sent_confirmed_by is null and sent_confirmed_at is null)
    or (sent_confirmed_by is not null and sent_confirmed_at is not null)
  ),
  constraint customer_review_test_cards_submitted_consistent check (
    (submitted_by is null and submitted_at is null)
    or (submitted_by is not null and submitted_at is not null)
  ),
  constraint customer_review_test_cards_verified_consistent check (
    (verified_by is null and verified_at is null)
    or (verified_by is not null and verified_at is not null)
  ),
  constraint customer_review_test_cards_returned_consistent check (
    (returned_by is null and returned_at is null)
    or (returned_by is not null and returned_at is not null)
  ),

  -- AN AVAILABLE CARD HOLDS NOTHING. This is what makes "released back to
  -- available" impossible to fake and what keeps the Available list honest:
  -- a row in that list has no tester, no evidence and no history on it.
  constraint customer_review_test_cards_available_is_empty check (
    status <> 'available'
    or (booked_by is null and sent_confirmed_at is null
        and submitted_at is null and verified_at is null
        and whatsapp_opened_count = 0)
  ),
  -- ...and anything past 'available' has a holder.
  constraint customer_review_test_cards_active_has_holder check (
    status = 'available' or booked_by is not null
  ),
  -- A verified card was checked by somebody.
  constraint customer_review_test_cards_verified_has_verifier check (
    status <> 'verified' or verified_by is not null
  ),
  -- A submitted card carries the tester's confirmation. The screenshot cannot
  -- be checked by a CHECK — it lives in another table — so it is enforced in
  -- assert_customer_review_test_card_submittable() instead (§7).
  constraint customer_review_test_cards_submitted_is_confirmed check (
    status not in ('submitted', 'verified') or sent_confirmed_at is not null
  )
);

create index customer_review_test_cards_status_idx
  on public.customer_review_test_cards (status, card_ref);
create index customer_review_test_cards_booked_idx
  on public.customer_review_test_cards (booked_by, status);

drop trigger if exists customer_review_test_cards_set_updated_at on public.customer_review_test_cards;
create trigger customer_review_test_cards_set_updated_at
  before update on public.customer_review_test_cards
  for each row execute function public.set_updated_at();

-- ═══ 4. customer_review_test_card_screenshots ══════════════════════════════
--
-- Metadata for objects in the private bucket. ONE KIND, and the name says what
-- it is: a screenshot the tester took of their own WhatsApp screen.
--
-- IT IS NOT PROOF OF A REVIEW. There is no review in this module. It is not
-- proof of delivery either. It is the artefact a verifier looks at to decide
-- whether the workflow was exercised, and that is the only claim made about it
-- anywhere in this file or in the application above it.

create table public.customer_review_test_card_screenshots (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.customer_review_test_cards(id) on delete cascade,

  kind text not null default 'test_screenshot' check (kind = 'test_screenshot'),

  -- The object key inside 'customer-review-test-screenshots'. UNIQUE so one
  -- object can never be claimed by two cards. The first path segment is always
  -- the card id — the storage policies below read ownership out of it, which is
  -- why the path must contain a separator and must not start with one.
  storage_path text not null unique check (
    position('/' in storage_path) > 1 and length(storage_path) <= 400
  ),

  -- Display only. Never used to build a path.
  file_name text not null check (btrim(file_name) <> '' and length(file_name) <= 200),

  -- FACTS ABOUT THE BYTES, not claims about them. Both are written by
  -- /api/customer-reviews/photos after it has read the file and DECODED it, and
  -- no client role can insert a row at all — so a value here is something a
  -- server established rather than something a caller asserted.
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 5242880),

  -- sha256 of the accepted bytes, lower-case hex. It is what makes a repeated
  -- upload answerable by CONTENT rather than by a timer: the same screenshot
  -- offered twice for one card is one attachment, whatever raced with what.
  --
  -- THE UNIQUENESS THAT ENFORCES THAT IS A PARTIAL INDEX, DEFINED BELOW, not a
  -- table constraint. A plain `unique (card_id, content_sha256)` was wrong in a
  -- way that only showed up on a failure: a row MARKED for removal still
  -- occupied the pair, so if the object deletion failed the tester could never
  -- re-upload that same file — the card was permanently unable to carry the
  -- screenshot it was supposed to have. The index below ignores marked rows,
  -- which is the same rule every reader already applies.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),

  uploaded_by uuid not null default auth.uid() references public.users(id),
  uploaded_at timestamptz not null default now(),

  -- ── Removal, in two steps ──
  --
  -- Deleting an attachment touches two systems — the bucket and this table —
  -- and no transaction spans both. Doing it in one step means choosing which
  -- inconsistency to risk: delete the row first and a failed object removal
  -- leaves an orphan nothing can find again; delete the object first and a
  -- failed row deletion leaves a record pointing at nothing.
  --
  -- So removal is MARKED before it is done. The begin half stamps these two
  -- columns, every read filters the row out from that moment, the object is
  -- deleted, and the finish half deletes the row. A failure between the two
  -- leaves a marked row that still names its path, so the operation is
  -- retryable and converges — and nothing is ever both invisible and
  -- unreachable.
  removal_started_at timestamptz,
  removal_by uuid references public.users(id),

  constraint customer_review_screenshot_removal_fields_consistent check (
    (removal_started_at is null and removal_by is null)
    or (removal_started_at is not null and removal_by is not null)
  ),

  -- The path segment the storage policies rely on has to agree with the row's
  -- own card, or a tester holding one card could reach another's objects.
  constraint customer_review_screenshot_path_matches_card check (
    split_part(storage_path, '/', 1) = card_id::text
  )
);

-- ═══ AT MOST ONE LIVE SCREENSHOT PER CARD, AND THE DATABASE SAYS SO ═══════
--
-- This is the guarantee, and it has to be here rather than in the route.
--
-- The route counts existing rows and refuses a second upload. That check is a
-- READ FOLLOWED BY A WRITE, and two concurrent uploads with different content
-- both read zero and both insert — the count is correct for each of them and
-- wrong for the card. No amount of care in the route fixes that; only the
-- database can serialise it.
--
-- A partial unique index does. The second inserter blocks on the index, then
-- fails with 23505 once the first commits. The route maps that to the same
-- sentence its own count produces, so a tester sees one answer however the
-- race went.
--
-- WHERE removal_started_at IS NULL is the load-bearing part of both indexes.
-- A row marked for removal is already gone as far as every reader is concerned
-- (the SELECT policy filters it), so it must not occupy the slot either — or a
-- failed object deletion would leave the card permanently unable to accept a
-- replacement.
create unique index customer_review_screenshot_one_live_per_card
  on public.customer_review_test_card_screenshots (card_id)
  where removal_started_at is null;

-- ...and the same content cannot be registered twice while it is live. This is
-- what makes a repeated upload idempotent by CONTENT rather than by a timer.
create unique index customer_review_screenshot_unique_live_content
  on public.customer_review_test_card_screenshots (card_id, content_sha256)
  where removal_started_at is null;

create index customer_review_screenshot_card_idx
  on public.customer_review_test_card_screenshots (card_id);

-- ═══ 5. customer_review_test_card_events ═══════════════════════════════════
--
-- APPEND-ONLY lifecycle trail. No client role holds INSERT, UPDATE, DELETE or
-- TRUNCATE; rows arrive only from the definer functions below. The columns on
-- customer_review_test_cards are the CURRENT state — this is the history that
-- survives every transition, and it is what answers "who booked, opened,
-- confirmed, submitted and verified this, and when".

create table public.customer_review_test_card_events (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.customer_review_test_cards(id) on delete cascade,

  event_type text not null check (event_type in (
    'booked',              -- a tester claimed the card
    'whatsapp_opened',     -- a link was built and opened. NOT "sent".
    'sent_confirmed',      -- the tester's own deliberate claim
    'submitted',           -- handed to the verification queue
    'verified',            -- a verifier checked the evidence
    'returned',            -- a verifier handed it back, with a reason
    'screenshot_removed'   -- an administrator withdrew an attached image
  )),

  previous_status text check (previous_status is null or previous_status in (
    'available', 'booked', 'submitted', 'verified'
  )),
  new_status text check (new_status is null or new_status in (
    'available', 'booked', 'submitted', 'verified'
  )),

  -- Short, and either system-generated or a note the actor deliberately wrote
  -- about this event.
  --
  -- NEVER A PHONE NUMBER — and there is no number anywhere in this module to
  -- put here. The trail is about what somebody decided; the only trace of a
  -- recipient is four digits on the card itself, not scattered through free
  -- text where it could neither be masked nor found again.
  detail text check (detail is null or length(detail) <= 500),

  actor_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),

  -- The three events that move the status name both ends; the rest name
  -- neither.
  constraint customer_review_test_events_status_matches_type check (
    (event_type in ('booked', 'submitted', 'verified', 'returned') and new_status is not null)
    or (event_type in ('whatsapp_opened', 'sent_confirmed', 'screenshot_removed')
        and new_status is null and previous_status is null)
  )
);

create index customer_review_test_events_card_idx
  on public.customer_review_test_card_events (card_id, created_at desc);

-- ═══ 6. Visibility predicates ══════════════════════════════════════════════
--
-- THREE functions, called by every policy AND by every definer function, so
-- "who may see this card" is answered in exactly one place. SECURITY DEFINER +
-- STABLE so a policy can call them without recursing through RLS on
-- public.users.
--
-- ═══ NO BROWSER-CALLABLE FUNCTION MAY BE TOLD WHO TO ANSWER FOR ═══════════
--
-- Every predicate here is granted to `authenticated`, so its parameters are
-- chosen by a browser. A function that accepts an ACTING-USER id and is
-- reachable from a session is an oracle: a signed-in employee can ask it about
-- a colleague and read back who is active, who is an admin and who holds
-- `verify` — the facts this module exists to withhold. The acting identity is
-- taken from auth.uid() inside each body, never handed in.
--
-- The uuid that IS accepted below is a ROW's booked_by, and the difference is
-- the whole reason the rule survives: the function reads public.users for
-- auth.uid() alone, and compares the argument to it by equality. Asking about a
-- colleague's uuid returns only "is that uuid me", which the caller already
-- knew.

-- May this user use this module at all?
--
-- ZERO ARGUMENTS, deliberately: there is nothing to ask about but the caller.
--
-- An earlier revision of this module removed a function of this shape on the
-- grounds that nothing called it, and that was right at the time. It is back
-- because something calls it now: an AVAILABLE card belongs to nobody, so the
-- SELECT policy cannot decide it from a booked_by, and the authorization half
-- of "may I see the available list" has to live behind definer rights like
-- every other predicate here rather than as an inline read of public.users.
create or replace function public.can_use_customer_review_test_cards()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.is_active
      -- MODULE ENTRY IS THE RESOLVED PERMISSION, AND NOTHING ELSE.
      --
      -- `u.role = 'admin' or` used to lead this disjunction. Being first it
      -- short-circuited, so an administrator whose grants had been revoked in
      -- Control Center still passed the entry predicate — the row is read
      -- through RLS that this function backs, so the revocation was not merely
      -- cosmetic, it was unenforced.
      --
      -- An administrator is not locked out: the role_permissions seed grants
      -- them both actions, so resolve_permission answers true. The difference
      -- is that the engine is now asked.
      and (
        public.resolve_permission(auth.uid(), 'customer_review_requests', 'use')
        or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
      )
  );
$$;

revoke execute on function public.can_use_customer_review_test_cards() from public, anon;
grant  execute on function public.can_use_customer_review_test_cards() to authenticated;

-- May this user READ a card held by this person?
--
--   * an admin;
--   * a verifier (customer_review_requests.verify) — they have to read the
--     submitted tests in order to check them, and the verified ones to keep a
--     history;
--   * the tester who booked it.
--
-- A `use` holder sees THEIR OWN booked cards and the unbooked pool, and nobody
-- else's work. Module entry must never become sight of every test every
-- colleague has run.
--
-- WHY THIS EXISTS SEPARATELY FROM can_view_customer_review_test_card().
-- That helper resolves a card by SELECTing it. That is right for the child
-- tables and the bucket, which hold a card id and need the parent looked up. It
-- is wrong for customer_review_test_cards itself, twice over:
--
--   1. It re-queries the table being guarded. Because the function is STABLE it
--      runs against the statement's own snapshot, so a row a writing statement
--      is about to return is invisible to it — the policy evaluates false and
--      the statement is refused 42501.
--
--   2. Spelling the predicate out inline in the policy instead trades one
--      defect for a quieter one. A policy body runs as the CALLER, so an inline
--      "select ... from public.users" is subject to whatever privileges and row
--      security public.users carries. Today that is survivable; a future
--      tightening of public.users would change who can see this module's rows,
--      silently, with nothing here to say so.
--
-- SECURITY DEFINER closes both. It reads users with the definer's rights, like
-- every other predicate in this module, and it takes booked_by as a VALUE, so
-- it never touches customer_review_test_cards at all.
create or replace function public.can_view_customer_review_test_card_row(
  p_booked_by uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.is_active
      -- THE HOLDER, OR SOMEBODY WHO RESOLVES `verify`. The `u.role = 'admin'`
      -- disjunct is gone for the reason above: an administrator whose `verify`
      -- was revoked could still read every tester's rows, which is the one
      -- thing revoking `verify` is supposed to stop.
      and (
        p_booked_by = auth.uid()
        or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
      )
  );
$$;

revoke execute on function public.can_view_customer_review_test_card_row(uuid) from public, anon;
grant  execute on function public.can_view_customer_review_test_card_row(uuid) to authenticated;

-- The same question, asked about a card the caller names by id.
--
-- Used by the child tables and by the storage policy, which hold a card id and
-- have to look the parent up. It answers false for a card the caller may not
-- see, so a screenshot belonging to somebody else's card does not exist as far
-- as any of them are concerned.
create or replace function public.can_view_customer_review_test_card(
  p_card_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.customer_review_test_cards c
    join public.users u on u.id = auth.uid() and u.is_active
    where c.id = p_card_id
      -- THREE WAYS IN, AND A ROLE IS NOT ONE OF THEM. Same correction as the
      -- row predicate above: the `u.role = 'admin'` disjunct is gone, so a
      -- revoked administrator reads what their permissions say they may read
      -- and nothing more.
      and (
        c.booked_by = auth.uid()
        or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
        or (
          -- An unbooked card is visible to anyone who may use the module. It
          -- holds no evidence and belongs to nobody; that is what "available"
          -- means.
          c.status = 'available'
          and public.resolve_permission(auth.uid(), 'customer_review_requests', 'use')
        )
      )
  );
$$;

revoke execute on function public.can_view_customer_review_test_card(uuid) from public, anon;
grant  execute on function public.can_view_customer_review_test_card(uuid) to authenticated;

-- THERE IS NO can_create_* AND NO can_edit_* PREDICATE IN THIS MODULE, and
-- their absence is stronger than their presence was.
--
-- An earlier draft let employees author outreach records, so it needed a
-- creation predicate and an editorship predicate to say who could and while
-- what status held. Test cards are not authored by anybody: they arrive from a
-- fixture, and their text is never editable by anyone at all. So instead of a
-- predicate deciding who may write, `authenticated` simply holds NO INSERT and
-- NO UPDATE privilege on the card table (§9) and there is no INSERT or UPDATE
-- policy on it (§7). §12 asserts both.

-- ═══ 7. Row-level security ═════════════════════════════════════════════════
--
-- No policy in this module is `USING (true)`.

alter table public.customer_review_test_cards            enable row level security;
alter table public.customer_review_test_card_screenshots enable row level security;
alter table public.customer_review_test_card_events      enable row level security;

-- ── customer_review_test_cards ──

-- THIS POLICY ASKS ABOUT THE ROW IT IS GIVEN, and it must never go back to the
-- table to find it. can_view_customer_review_test_card() would; it is STABLE
-- and re-reads this table, so a row a writing statement is about to RETURN is
-- outside its snapshot and the statement is refused 42501. The row-shaped
-- predicate reads booked_by straight off the candidate row instead.
--
-- Two branches, because a card has two ways of being visible:
--   the AVAILABLE POOL, which belongs to nobody and is offered to anyone who
--   may use the module; and
--   A HELD CARD, which is visible to whoever booked it, to a verifier and to an
--   admin.
--
-- `status` is read off the candidate row, which is safe — it touches no other
-- table. The authorization half of that branch is a definer call, which is the
-- half that would otherwise read public.users as the caller.
--
-- The table name is written out rather than left implicit. Unqualified,
-- `status` and `booked_by` would resolve against whatever the predicate's inner
-- scope happens to contain.
create policy "customer_review_test_cards_select" on public.customer_review_test_cards
  for select to authenticated
  using (
    (
      customer_review_test_cards.status = 'available'
      and public.can_use_customer_review_test_cards()
    )
    or public.can_view_customer_review_test_card_row(customer_review_test_cards.booked_by)
  );

-- THERE IS NO INSERT POLICY, NO UPDATE POLICY AND NO DELETE POLICY ON THIS
-- TABLE, and that is the module's central structural claim.
--
-- Cards are not created, edited or destroyed by anybody holding a browser
-- session. They arrive from a local fixture run against a disposable stack with
-- the postgres role, and from then on they move only through the definer
-- functions in §8 — each of which takes its actor from auth.uid(), re-checks
-- the transition table, and writes the audit row in the same transaction.
--
-- WHAT THIS BUYS, concretely:
--   * The mandatory internal-test label cannot be removed, because the text it
--     is attached to cannot be written by an employee at all.
--   * A status cannot move without its trail moving with it.
--   * booked_by cannot be set to somebody else, because it cannot be set by a
--     client statement at any value.
-- §9 removes the underlying privileges as well, so a policy added back by
-- mistake later still could not write.

-- ── customer_review_test_card_screenshots ──

create policy "customer_review_test_screenshots_select"
  on public.customer_review_test_card_screenshots
  for select to authenticated
  using (
    public.can_view_customer_review_test_card(card_id)
    -- A row marked for removal is already gone as far as every reader is
    -- concerned. Filtering here rather than in each query is what makes the
    -- two-step removal invisible instead of half-visible.
    and removal_started_at is null
  );

-- THERE IS NO INSERT POLICY ON THIS TABLE, and its absence is the security
-- boundary the module's upload path rests on.
--
-- An earlier version had one: a client could insert its own row, supplying
-- mime_type and byte_size from `file.type` and `file.size` — two values the
-- browser derives from the filename. Nothing had read a byte, so "image/png,
-- 100 bytes" could describe three megabytes of anything.
--
-- Registering an image is now something only /api/customer-reviews/photos can
-- do. That route authenticates the caller, resolves
-- customer_review_requests.use for them, reads the card through THEIR OWN RLS,
-- applies the status and ownership rules, DECODES AND RE-ENCODES the bytes,
-- generates the object key itself, and only then writes — with the service
-- role, which no policy constrains and which never leaves the server.
--
-- The rule that follows: an image can only be registered by something that has
-- read it. The storage INSERT policy is absent for the same reason (§10).
--
-- THERE IS NO DELETE POLICY ON THIS TABLE EITHER. Removal spans the bucket and
-- this table, and a browser that could do one half would strand the other. It
-- is one server operation or it is nothing.
--
-- WHO MAY REMOVE WHAT is enforced inside
-- begin_customer_review_test_screenshot_removal():
--
--   the tester holding the card, while they still hold it. That is the whole
--   rule. There is no administrator exception: an administrator acting on
--   somebody else's card would be an administrator performing a tester's
--   action.
--
--   What that costs, said plainly: once a card is submitted its screenshot is
--   frozen for everybody, so an image uploaded by accident can only be
--   corrected by a verifier RETURNING the card to its tester first. That is a
--   real extra step and it is the price of the rule.

-- Every removal is recorded. The row names the file, so the trail still reads
-- correctly once the metadata row it describes is gone.
create or replace function public.customer_review_test_screenshots_log_removal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Skip when the parent card is itself going away. The trail cascades with it,
  -- so the row would be written and immediately deleted.
  if not exists (select 1 from public.customer_review_test_cards where id = old.card_id) then
    return old;
  end if;

  insert into public.customer_review_test_card_events
    (card_id, event_type, detail, actor_id)
  values
    (old.card_id, 'screenshot_removed',
     format('Test screenshot removed: %s', left(coalesce(old.file_name, 'unnamed'), 120)),
     -- WHO REMOVED IT, and the order matters. removal_by is stamped by the
     -- begin half with the authenticated caller the route established; it is
     -- read FIRST because the delete itself arrives through the service role,
     -- where auth.uid() is null. Falling back to the uploader would credit the
     -- removal to whoever added the file.
     coalesce(old.removal_by, auth.uid(), old.uploaded_by));
  return old;
end;
$$;

revoke execute on function public.customer_review_test_screenshots_log_removal()
  from public, anon, authenticated;

drop trigger if exists customer_review_test_screenshots_log_removal_trg
  on public.customer_review_test_card_screenshots;
create trigger customer_review_test_screenshots_log_removal_trg
  before delete on public.customer_review_test_card_screenshots
  for each row execute function public.customer_review_test_screenshots_log_removal();

-- ── The two halves of a removal ───────────────────────────────────────────
--
-- Both are granted to service_role ALONE. They take the actor as a parameter,
-- which would be a spoofing hole if a browser could call them — so no browser
-- can: `authenticated` holds no EXECUTE on either, and
-- DELETE /api/customer-reviews/photos is what establishes the actor from the
-- session before calling.
--
-- The authorization is repeated HERE as well as in the route, on purpose. The
-- route is the only caller today; this is what keeps the rule true if it ever
-- is not.

create or replace function public.begin_customer_review_test_screenshot_removal(
  p_screenshot_id uuid,
  p_actor_id uuid
)
returns public.customer_review_test_card_screenshots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.customer_review_test_card_screenshots%rowtype;
  c public.customer_review_test_cards%rowtype;
begin
  -- Locked, so two removals of one screenshot cannot both proceed to delete an
  -- object and then both try to delete the row.
  select * into s from public.customer_review_test_card_screenshots
   where id = p_screenshot_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_SCREENSHOT_NOT_FOUND: That screenshot is no longer attached'
      using errcode = 'P0002';
  end if;

  -- AN INACTIVE ACCOUNT IS REFUSED BEFORE ANYTHING ELSE. Asked as "is there an
  -- active row for this person", with no interest in their role — because a
  -- role no longer buys anything here.
  if not exists (
    select 1 from public.users u where u.id = p_actor_id and u.is_active
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  select * into c from public.customer_review_test_cards where id = s.card_id;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- REMOVING A SCREENSHOT IS A TESTER ACTION, so it belongs to the tester
  -- HOLDING THE CARD and to nobody else. There is no administrator branch.
  --
  -- An earlier version let an administrator withdraw any screenshot at any
  -- status, on the argument that an image uploaded by accident would otherwise
  -- be unremovable. That argument was real and it is now overruled: an
  -- administrator acting on a card somebody else holds is an administrator
  -- performing a tester's action, which is exactly what this module must not
  -- allow. THE CONSEQUENCE IS STATED RATHER THAN HIDDEN — once a card is
  -- submitted, its screenshot is frozen for everybody, and correcting a
  -- mistaken upload after that point requires the card to be returned to its
  -- tester first, which a verifier can do.
  if not (
    c.booked_by = p_actor_id
    and public.resolve_permission(p_actor_id, 'customer_review_requests', 'use')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can remove its screenshot'
      using errcode = '42501';
  end if;
  if c.status <> 'booked' then
    raise exception 'CUSTOMER_REVIEW_TEST_LOCKED: A screenshot can only be removed while you still hold the card'
      using errcode = '42501';
  end if;

  -- Idempotent: a retry after a failed object deletion re-enters here and finds
  -- the row already marked, which is exactly the state it wants.
  if s.removal_started_at is null then
    update public.customer_review_test_card_screenshots
       set removal_started_at = now(),
           removal_by = p_actor_id
     where id = p_screenshot_id;
    select * into s from public.customer_review_test_card_screenshots where id = p_screenshot_id;
  end if;

  return s;
end;
$$;

revoke execute on function public.begin_customer_review_test_screenshot_removal(uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.begin_customer_review_test_screenshot_removal(uuid, uuid) to service_role;

-- The second half: the object is gone, so the row goes and the trail gains its
-- screenshot_removed entry (written by the trigger above, from removal_by).
create or replace function public.finish_customer_review_test_screenshot_removal(p_screenshot_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.customer_review_test_card_screenshots%rowtype;
begin
  select * into s from public.customer_review_test_card_screenshots
   where id = p_screenshot_id for update;
  -- Already finished. A retry says so rather than failing, so a caller that
  -- lost its response can converge.
  if not found then return true; end if;

  if s.removal_started_at is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_REMOVAL: This screenshot was not marked for removal'
      using errcode = '23514';
  end if;

  delete from public.customer_review_test_card_screenshots where id = p_screenshot_id;
  return true;
end;
$$;

revoke execute on function public.finish_customer_review_test_screenshot_removal(uuid)
  from public, anon, authenticated;
grant  execute on function public.finish_customer_review_test_screenshot_removal(uuid) to service_role;

-- ── customer_review_test_card_events ──
--
-- Readable by whoever can read the card. Not writable, not editable, not
-- erasable — by anyone, including an admin. There is no INSERT, UPDATE or
-- DELETE policy on purpose.

create policy "customer_review_test_events_select" on public.customer_review_test_card_events
  for select to authenticated
  using (public.can_view_customer_review_test_card(card_id));

-- ═══ 8. The lifecycle, as the only way status moves ════════════════════════

-- Submission prerequisites.
--
-- The screenshot rule cannot be a CHECK, because a CHECK cannot count rows in
-- another table. The confirmation rule could be and IS (§3), and is repeated
-- here so a caller gets a sentence rather than a constraint name.
--
-- NOT EXECUTABLE BY ANY CLIENT ROLE: it is an internal step of the transition
-- function, and a browser that could call it would learn the state of a card it
-- may not see.
create or replace function public.assert_customer_review_test_card_submittable(p_card_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.customer_review_test_cards%rowtype;
  v_shots integer;
begin
  select * into c from public.customer_review_test_cards where id = p_card_id;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- THE TESTER'S OWN CLAIM, and it is not substitutable. whatsapp_opened_at is
  -- never accepted in its place: opening a wa.me link hands text to WhatsApp
  -- and proves nothing about what happened next.
  if c.sent_confirmed_at is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Confirm that you sent the internal test message'
      using errcode = '23514';
  end if;

  select count(*) into v_shots
  from public.customer_review_test_card_screenshots s
  where s.card_id = p_card_id and s.removal_started_at is null;

  if v_shots = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Attach a screenshot of the internal test you sent'
      using errcode = '23514';
  end if;
end;
$$;

revoke execute on function public.assert_customer_review_test_card_submittable(uuid)
  from public, anon, authenticated;

-- ── Booking, which is the one move that must win a race ───────────────────
--
-- NOT part of the transition table below, and deliberately so. The generic
-- transition function reads a row, locks it, and then decides — which is one
-- lock too late to be a race guard for a row that belongs to nobody yet.
--
-- THE CLAIM IS ONE STATEMENT. `where id = ... and status = 'available'` is
-- evaluated by the UPDATE itself. Under READ COMMITTED a second transaction
-- blocks on the row lock, then re-reads the row it was waiting for, sees
-- 'booked', matches nothing and updates zero rows. Two testers cannot both
-- take one card; the second is told it has gone.
--
-- THE ACTING IDENTITY IS NOT A PARAMETER. booked_by is auth.uid(), read inside
-- the body. A caller can book FOR THEMSELVES and there is no other thing to
-- ask for.
create or replace function public.book_customer_review_test_card(p_card_id uuid)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c     public.customer_review_test_cards%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- ACTIVE, and holding `use`. `verify` alone is NOT enough to book: a verifier
  -- checks other people's tests, and letting the checker also be the tester
  -- would remove the only separation the workflow has.
  --
  -- THERE IS NO ROLE BYPASS HERE. An administrator books a card the same way
  -- anybody does — by holding `use`, which the role_permissions seed grants
  -- them — rather than by being an administrator. The difference matters
  -- because it makes an explicit revocation actually revoke: an admin whose
  -- `use` is withdrawn in Control Center can no longer take a test card, which
  -- is what withdrawing it is for.
  if not exists (
    select 1 from public.users u
    where u.id = v_uid
      and u.is_active
      and public.resolve_permission(v_uid, 'customer_review_requests', 'use')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: You do not have permission to book a test card'
      using errcode = '42501';
  end if;

  update public.customer_review_test_cards
     set status    = 'booked',
         booked_by = v_uid,
         booked_at = now()
   where id = p_card_id
     and status = 'available'
  returning * into c;

  if not found then
    -- Missing and taken are different facts and the tester needs to be able to
    -- tell them apart — a taken card is one they should stop waiting for.
    -- Neither answer names who took it.
    if not exists (select 1 from public.customer_review_test_cards where id = p_card_id) then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists'
        using errcode = 'P0002';
    end if;
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_BOOKED: Somebody else has already booked that test card'
      using errcode = '23514';
  end if;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id, 'booked', 'available', 'booked', 'Test card booked.', v_uid);

  return c;
end;
$$;

revoke execute on function public.book_customer_review_test_card(uuid) from public, anon;
grant  execute on function public.book_customer_review_test_card(uuid) to authenticated;

-- ── The tester's own claim that they sent the message ─────────────────────
--
-- A SEPARATE, DELIBERATE ACTION, and the whole reason this function exists
-- apart from the WhatsApp one. It changes no status: it records that a person
-- says they pressed send. Submitting is still a further explicit step.
create or replace function public.confirm_customer_review_test_card_sent(p_card_id uuid)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c     public.customer_review_test_cards%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- THE HOLDER, AND ONLY THE HOLDER. No role bypass: this records that a
  -- specific person pressed send, and nobody else can make that claim on their
  -- behalf — least of all an administrator who was not there.
  if not (
    c.booked_by = v_uid
    and public.resolve_permission(v_uid, 'customer_review_requests', 'use')
    and exists (select 1 from public.users u where u.id = v_uid and u.is_active)
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can confirm they sent it'
      using errcode = '42501';
  end if;

  if c.status <> 'booked' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: A % card cannot be confirmed as sent', c.status
      using errcode = '23514';
  end if;

  -- OPENING WHATSAPP FIRST IS REQUIRED, and it is required as an ORDERING
  -- rather than as evidence. There is nothing to have sent if no link was ever
  -- built, and this is the only place the two facts are related at all — the
  -- open still confirms nothing by itself.
  if c.whatsapp_opened_at is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Open WhatsApp with the test message first'
      using errcode = '23514';
  end if;

  -- Idempotent: confirming twice keeps the FIRST claim. A later click must not
  -- quietly move the timestamp somebody may already have been shown.
  if c.sent_confirmed_at is null then
    update public.customer_review_test_cards
       set sent_confirmed_at = now(),
           sent_confirmed_by = v_uid
     where id = p_card_id;

    insert into public.customer_review_test_card_events
      (card_id, event_type, detail, actor_id)
    values
      (p_card_id, 'sent_confirmed',
       'The tester confirmed by hand that they sent the internal test message.', v_uid);
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id;
  return c;
end;
$$;

revoke execute on function public.confirm_customer_review_test_card_sent(uuid) from public, anon;
grant  execute on function public.confirm_customer_review_test_card_sent(uuid) to authenticated;

-- ── Record that a link was built and opened ───────────────────────────────
--
-- THIS IS NOT "SENT" AND MUST NEVER BECOME IT. It writes a timestamp, a counter
-- and the number the link was addressed to, and it does not touch status. The
-- claim that a message was sent is confirm_customer_review_test_card_sent(),
-- which a person calls afterwards.
--
-- GRANTED TO service_role ALONE, like the removal halves — and the reason
-- changed when the allowlist went away, so it is restated here rather than
-- inherited.
--
-- It is NOT that SQL cannot check the recipient. It is that this function takes
-- p_actor_id, and a function that is TOLD who is acting must not be reachable
-- by the party it would be acting for. POST /api/customer-reviews/whatsapp
-- establishes the actor from the session, validates the number, and REDUCES it
-- before calling here.
--
-- WHICH IS THE OTHER HALF: the number never reaches SQL. What arrives is four
-- digits, sliced off the validated E.164 form in the route. No parameter of
-- this function could carry a phone number, so no future caller can
-- accidentally store one.
create or replace function public.record_customer_review_test_card_whatsapp_opened(
  p_card_id          uuid,
  p_target_last_four text,
  p_actor_id         uuid
)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.customer_review_test_cards%rowtype;
begin
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  -- THE HOLDER, AND ONLY THE HOLDER. No role bypass: producing a WhatsApp link
  -- is a tester action, and an administrator doing it on somebody else's card
  -- would be an administrator running somebody else's test.
  if not (
    c.booked_by = p_actor_id
    and public.resolve_permission(p_actor_id, 'customer_review_requests', 'use')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can open WhatsApp for it'
      using errcode = '42501';
  end if;

  if c.status <> 'booked' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: WhatsApp can only be opened for a booked card'
      using errcode = '23514';
  end if;

  -- SHAPE-CHECKED, AND THE SHAPE IS THE POINT. The parameter is already a
  -- reduced form, and refusing anything else is what makes "SQL never sees a
  -- number" a property of the signature rather than a habit of its one caller:
  -- four digits are four digits, and a phone number is not.
  if p_target_last_four is null or p_target_last_four !~ '^[0-9]{4}$' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TARGET: The recipient last-four is not four digits'
      using errcode = '23514';
  end if;

  update public.customer_review_test_cards
     set whatsapp_opened_at        = now(),
         whatsapp_opened_count     = whatsapp_opened_count + 1,
         whatsapp_target_last_four = p_target_last_four
   where id = p_card_id;

  insert into public.customer_review_test_card_events
    (card_id, event_type, detail, actor_id)
  values
    (p_card_id, 'whatsapp_opened',
     'A wa.me link was built and opened. This does not confirm the message was sent.',
     p_actor_id);

  select * into c from public.customer_review_test_cards where id = p_card_id;
  return c;
end;
$$;

revoke execute on function public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)
  from public, anon, authenticated;
grant  execute on function public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)
  to service_role;

-- ── The transition table ──────────────────────────────────────────────────
--
-- ONE function, one table of legal moves, one audit row per move. The UI reads
-- the same table from src/lib/customerReviews/status.ts; this is the copy that
-- decides.
--
--   available -> (nothing; booking has its own function, see above)
--   booked    -> submitted
--   submitted -> verified, booked
--   verified  -> (nothing)
--
-- 'booked' AS A DESTINATION IS THE RETURN PATH. A verifier who cannot read the
-- screenshot has to be able to hand the card back; the alternatives are
-- verifying evidence they could not check, or leaving the card stuck in the
-- queue forever. It needs `verify`, it carries a reason, and it is the only
-- backwards move in the module.
--
-- 'submitted' is reachable only from 'booked' and only by a deliberate call:
-- there is no path from "the tester opened WhatsApp" to anything, because
-- opening a link is not evidence of anything.
create or replace function public.transition_customer_review_test_card(
  p_card_id     uuid,
  p_next_status text,
  p_detail      text default null
)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c        public.customer_review_test_cards%rowtype;
  v_uid    uuid := auth.uid();
  v_use    boolean;
  v_verify boolean;
  v_holder boolean;
  v_legal  boolean;
  v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- Locked for the duration, so two clicks cannot both read 'booked' and both
  -- write 'submitted'. The legality guard below then refuses the second.
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- AN INACTIVE ACCOUNT IS REFUSED HERE, before any permission is considered.
  -- Asked as "is there an active row for this person" — their role is not
  -- consulted, because no role grants anything in this function.
  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  -- RESOLVED FROM THE PERMISSION ENGINE, NOT FROM THE ROLE. An administrator
  -- holds both through role_permissions, so nothing they legitimately do is
  -- lost — but an explicit revocation in Control Center now actually revokes,
  -- and being an administrator no longer stands in for holding a card.
  v_use    := public.resolve_permission(v_uid, 'customer_review_requests', 'use');
  v_verify := public.resolve_permission(v_uid, 'customer_review_requests', 'verify');
  v_holder := (c.booked_by = v_uid);

  if not (v_use or v_verify) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: You do not have access to this module'
      using errcode = '42501';
  end if;

  -- ── Is the move itself legal? ──
  v_legal := case c.status
    when 'booked'    then p_next_status in ('submitted')
    when 'submitted' then p_next_status in ('verified', 'booked')
    else false
  end;

  if not v_legal then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: A % card cannot become %', c.status, p_next_status
      using errcode = '23514';
  end if;

  -- ── Is this person allowed to make it? ──
  --
  -- Verifying and returning need `verify`, and nothing else does. Submitting
  -- belongs to the tester holding the card and to nobody else — not to a
  -- verifier, and not to an administrator. Those two authorities cover
  -- verification and returning, which is the whole of what they are for here.
  if p_next_status in ('verified', 'booked') then
    if not v_verify then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Verifying or returning a test needs the Verify permission'
        using errcode = '42501';
    end if;
  else
    -- SUBMITTING IS A TESTER ACTION: the holder, and nobody else. An
    -- administrator who did not run the test cannot hand it over as though
    -- they had.
    if not (v_holder and v_use) then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can submit it'
        using errcode = '42501';
    end if;
  end if;

  if p_next_status = 'submitted' then
    perform public.assert_customer_review_test_card_submittable(p_card_id);
  end if;

  -- A return has to say why. A card handed back with no reason is a card the
  -- tester cannot act on.
  if p_next_status = 'booked' and v_detail is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Give a short reason when returning a test'
      using errcode = '23514';
  end if;

  -- ── Apply ──
  update public.customer_review_test_cards c2
     set status = p_next_status,

         submitted_at = case when p_next_status = 'submitted' then now()  else c2.submitted_at end,
         submitted_by = case when p_next_status = 'submitted' then v_uid  else c2.submitted_by end,

         verified_at = case when p_next_status = 'verified' then now()  else c2.verified_at end,
         verified_by = case when p_next_status = 'verified' then v_uid  else c2.verified_by end,
         -- The verifier's note, and only on the step that has one.
         verification_note = case
           when p_next_status = 'verified' then v_detail
           else c2.verification_note
         end,

         returned_at   = case when p_next_status = 'booked' then now()    else c2.returned_at end,
         returned_by   = case when p_next_status = 'booked' then v_uid    else c2.returned_by end,
         return_reason = case when p_next_status = 'booked' then v_detail else c2.return_reason end
   -- NOTHING IS CLEARED ON A RETURN, and that is the choice rather than an
   -- omission. submitted_at means "when this was last handed over", which
   -- stays true after it comes back; blanking it would erase a thing that
   -- happened in order to make the row look tidier. The STATUS says where the
   -- card is now, return_reason says why it moved, and the append-only trail
   -- below keeps every submission and every return in order. A re-submission
   -- overwrites submitted_at with the new one, which is the same rule.
   where c2.id = p_card_id;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id,
     case p_next_status when 'submitted' then 'submitted'
                        when 'verified'  then 'verified'
                        else 'returned' end,
     c.status, p_next_status, v_detail, v_uid);

  select * into c from public.customer_review_test_cards where id = p_card_id;
  return c;
end;
$$;

revoke execute on function public.transition_customer_review_test_card(uuid, text, text) from public, anon;
grant  execute on function public.transition_customer_review_test_card(uuid, text, text) to authenticated;

-- ═══ 9. Column-level grants ════════════════════════════════════════════════
--
-- NO CLIENT ROLE WRITES ANY OF THESE TABLES. This is not a narrowing of what a
-- client may write; it is the removal of the ability entirely, and it is the
-- mechanism behind three of the module's promises at once:
--
--   * The mandatory internal-test label cannot be removed by an employee,
--     because the text it attaches to cannot be written by one.
--   * A status cannot move without its audit row, because the only writers are
--     the definer functions that write both in one transaction.
--   * booked_by cannot name somebody else, because no client statement can set
--     it to any value at all.
--
-- service_role is unaffected, and the definer functions run as the table owner
-- regardless — which is how the fixture loads and how the workflow runs.

revoke insert, update, delete, truncate, references, trigger
  on public.customer_review_test_cards from authenticated, anon;

-- Screenshot metadata: READ-ONLY to every client role.
--
-- Each revocation is belt to the braces of an absent policy, and each is worth
-- stating separately:
--
--   INSERT  registering an image is /api/customer-reviews/photos and nothing
--           else, because only something that has READ the bytes may record
--           what they are.
--   UPDATE  a row that could be re-pointed at a different object would make
--           customer_review_screenshot_path_matches_card decorative, and a row
--           that could be edited would let somebody rewrite mime_type,
--           byte_size or content_sha256 after the server established them.
--   DELETE  removal spans the bucket and this table, and a client that could do
--           one half would leave the other stranded.
--
-- A policy added back by mistake later still could not write, because the
-- privilege is gone.
revoke insert, update, delete, truncate
  on public.customer_review_test_card_screenshots from authenticated, anon;

-- The trail: readable, never writable. Neither policy nor grant admits a write,
-- and TRUNCATE — which no policy governs and no row trigger fires on — cannot
-- erase it either.
revoke insert, update, delete, truncate
  on public.customer_review_test_card_events from authenticated, anon;

comment on table public.customer_review_test_cards is
  'INTERNAL TEST WORKFLOW ONLY. Each row is a fictional test card used to rehearse book -> WhatsApp -> confirm -> screenshot -> verify. It is NOT a customer review, is not attributed to any customer, and carries no customer data: there is no name, number, project or review-destination column. Card text is loaded from a local fixture; no client role holds INSERT or UPDATE.';

comment on column public.customer_review_test_cards.whatsapp_opened_at is
  'When a wa.me link was last built and opened for this card. Proves preparation only: it is not evidence that the message was sent, delivered or read. sent_confirmed_at is the tester''s separate, deliberate confirmation, and no status moves when this column does.';

comment on column public.customer_review_test_cards.whatsapp_target_last_four is
  'The final four digits of the recipient, so a tester recognises a number they typed. THE ONLY TRACE OF A RECIPIENT THIS MODULE KEEPS — the full number is never stored, here or anywhere else. An earlier design also kept a keyed HMAC fingerprint so recipients could be correlated; nothing needed that, so it was removed rather than carried.';

comment on table public.customer_review_test_card_events is
  'Append-only internal-test trail: booked, whatsapp_opened, sent_confirmed, submitted, verified, returned, screenshot_removed. No client role holds INSERT, UPDATE, DELETE or TRUNCATE; rows arrive only from the definer functions in 20261017000000. whatsapp_opened is NOT a delivery receipt.';

comment on table public.customer_review_test_card_screenshots is
  'Screenshots a tester took of their own WhatsApp screen, as evidence that the WORKFLOW was exercised. NOT proof of a review — there is no review in this module — and not proof of delivery.';

-- ═══ 10. Storage policies ══════════════════════════════════════════════════
--
-- Ownership is read out of the FIRST PATH SEGMENT, which is always the card id
-- — the same shape as order-request-attachments (20260711000000) and
-- payment-proofs (20260672). The metadata table's
-- customer_review_screenshot_path_matches_card constraint is what keeps the two
-- in agreement.

-- THERE IS NO INSERT POLICY ON storage.objects FOR THIS BUCKET.
--
-- The pair to the missing metadata INSERT policy above, and the half that
-- actually stops the bytes. `authenticated` cannot put an object in
-- customer-review-test-screenshots by any route: not through supabase-js, not
-- through the Storage REST API, not with a forged path. The service role is not
-- governed by policies, so /api/customer-reviews/photos can — after it has read
-- and re-encoded the file.
--
-- WHAT THIS CLOSES. With a client INSERT policy, a caller could upload
-- arbitrary bytes under a Content-Type of their choosing and then simply not
-- call the route; the object would sit in the bucket, unregistered and
-- unvalidated. The validation would have been advisory. It is not.

-- Reading — which is also what createSignedUrl is governed by — follows exactly
-- who may read the card. A verifier sees the screenshot because that is what
-- they are checking; nobody else sees it at all. Written as an EXISTS over the
-- card id rather than a cast of the path segment, so a malformed object name is
-- a non-match instead of an error.
create policy "customer_review_test_screenshots_storage_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'customer-review-test-screenshots'
    and exists (
      select 1 from public.customer_review_test_cards c
      where c.id::text = split_part(storage.objects.name, '/', 1)
        and public.can_view_customer_review_test_card(c.id)
    )
  );

-- THERE IS NO DELETE POLICY ON storage.objects FOR THIS BUCKET EITHER.
--
-- Together with the absent metadata DELETE policy, this is what makes removal
-- ONE operation instead of two independent ones a client could perform in
-- either order, or half of. The bucket is SELECT-only for every client role;
-- reading stays with the browser, through short-lived signed URLs.

-- ═══ 11. Registration in the permission engine ═════════════════════════════
--
-- Mirrors src/lib/permissions/modules.ts exactly — `npm run permissions:check`
-- fails if the two drift.
--
-- THE MODULE KEY AND BOTH ACTION KEYS ARE UNCHANGED. `customer_review_requests`
-- with `use` and `verify` is what any existing Control Center grant is written
-- against; renaming it to match the module's new purpose would silently revoke
-- every one of them. The DISPLAY name is what changed, because that is the part
-- a human reads.
--
-- TWO ACTIONS, and the module registers no `view`. That is deliberate: `use` IS
-- module entry here, and a third "can open it but do nothing" grant would be a
-- state with no meaning. See docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md.

insert into public.permission_modules (module_key, display_name, description) values
  ('customer_review_requests', 'Review Workflow Test (Internal)',
   'Internal test workflow. The tester chooses the WhatsApp recipient. Nothing is posted publicly, and BOE does not send the message automatically.')
on conflict (module_key) do update set
  display_name = excluded.display_name,
  description  = excluded.description;

-- Custom actions (is_system = false), like Sample Tracking's dispatch/receive.
insert into public.permission_actions (action_key, display_name, is_system) values
  ('use',    'Use Customer Review Outreach',   false),
  ('verify', 'Verify & Close Review Requests', false)
on conflict (action_key) do nothing;

-- System Default = false for both. Nobody holds anything here until an
-- administrator grants it.
insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('use', 'verify')
where pm.module_key = 'customer_review_requests'
on conflict (module_id, action_id) do nothing;

-- ROLE DEFAULTS: admin only, and only because every module here admits an
-- admin. manager and member are granted NOTHING — who runs the test phase and
-- who verifies it are decisions the business makes one person at a time in
-- Control Center, not something a role name should confer.
insert into public.role_permissions (role, module_id, action_id, allowed)
select 'admin', mpa.module_id, mpa.action_id, true
from public.module_permission_actions mpa
join public.permission_modules pm on pm.id = mpa.module_id and pm.module_key = 'customer_review_requests'
on conflict (role, module_id, action_id) do nothing;

-- ═══ 12. Assertions ════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_n   integer;
  v_bad text;
  v_col text;
begin
  -- Every table carries RLS.
  select count(*) into v_n
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in (
      'customer_review_test_cards',
      'customer_review_test_card_screenshots',
      'customer_review_test_card_events'
    )
    and c.relrowsecurity;
  if v_n <> 3 then
    raise exception 'row level security is not enabled on all three internal-test tables (got %)', v_n;
  end if;

  -- THE CARD TABLE HAS EXACTLY ONE POLICY, AND IT READS.
  --
  -- The module's central structural claim: nothing with a browser session can
  -- create, edit or destroy a test card. Asserted as a COUNT of non-SELECT
  -- policies rather than by naming the ones that must be absent, so a policy
  -- added later under any name fails here.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'customer_review_test_cards'
    and cmd <> 'SELECT';
  if v_n <> 0 then
    raise exception 'customer_review_test_cards has % write polic(ies); cards must be fixture-loaded and moved only by the definer functions', v_n;
  end if;

  -- ...and the privileges are gone as well as the policies, so a policy added
  -- back by mistake still could not write.
  foreach v_col in array array['INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('authenticated', 'public.customer_review_test_cards', v_col) then
      raise exception 'authenticated still holds % on customer_review_test_cards', v_col;
    end if;
    if has_table_privilege('anon', 'public.customer_review_test_cards', v_col) then
      raise exception 'anon still holds % on customer_review_test_cards', v_col;
    end if;
  end loop;

  -- The trail has no write policy of any kind.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename = 'customer_review_test_card_events'
    and cmd <> 'SELECT';
  if v_n <> 0 then
    raise exception 'customer_review_test_card_events has % write polic(ies); it must be append-only', v_n;
  end if;

  -- No policy anywhere in this module is unconditional.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename like 'customer_review%'
    and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');
  if v_n <> 0 then
    raise exception '% internal-test polic(ies) are USING (true)', v_n;
  end if;

  -- THE CARD'S OWN SELECT POLICY, CHECKED BY NAME.
  --
  -- Filtered by policyname, not merely by table and command: a second SELECT
  -- policy added later would otherwise make SELECT INTO pick an arbitrary one
  -- of the two and assert against whichever it happened to get.
  select coalesce(qual, '') into v_bad
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'customer_review_test_cards'
    and cmd        = 'SELECT'
    and policyname = 'customer_review_test_cards_select';

  if v_bad = '' then
    raise exception 'customer_review_test_cards_select is missing';
  end if;

  -- 1. It must not resolve the card by looking it up. The card-id helper is
  --    STABLE and re-reads this table, so a row a writing statement is about to
  --    return is invisible to it. Matched on the exact call shape so the _row
  --    variant does not count.
  if v_bad ~ 'can_view_customer_review_test_card\(' then
    raise exception 'customer_review_test_cards_select re-queries its own table';
  end if;

  -- 2. It must not read public.users in the policy body either. A policy runs
  --    as the CALLER, so an inline read of users binds this module's visibility
  --    to that table's grants and row security. The predicate belongs in a
  --    SECURITY DEFINER function, where every other predicate here already is.
  if v_bad ~* '\mfrom\M\s+(public\.)?users\M' then
    raise exception 'customer_review_test_cards_select reads public.users as the caller';
  end if;

  -- 3. It must go through the row predicate AND gate the available branch on
  --    the definer-rights use check. Either half alone would be a hole: the
  --    first without the second shows the pool to anybody signed in.
  if v_bad not like '%can_view_customer_review_test_card_row%' then
    raise exception 'customer_review_test_cards_select does not use can_view_customer_review_test_card_row()';
  end if;
  if v_bad not like '%can_use_customer_review_test_cards%' then
    raise exception 'customer_review_test_cards_select does not gate the available pool on can_use_customer_review_test_cards()';
  end if;

  -- ═══ WHAT A BROWSER MAY CALL, AND WITH WHAT ══════════════════════════════
  --
  -- A function granted to `authenticated` has its arguments chosen by a browser.
  -- One that accepts an acting-user id is an oracle: a signed-in employee can
  -- ask it about a colleague and read back who is active, who is an admin and
  -- who holds `verify` — the facts this module exists to withhold.
  --
  -- TWO CHECKS, AND THEY ARE NOT THE SAME STRENGTH. Being honest about which is
  -- which matters more than the checks themselves:
  --
  --   (1) AN EXACT ALLOW-LIST. Every function in this module executable by
  --       `authenticated`, with its exact argument list. This is a real
  --       structural guarantee: a function added later, or an argument added to
  --       an existing one, fails here regardless of what anything is called.
  --
  --   (2) A NAME HEURISTIC over p_user_id / p_actor_id / p_acting. This is NOT
  --       a guarantee and must not be described as one. It matches parameter
  --       NAMES, so a future `p_who uuid` or `p_subject uuid` walks straight
  --       past it. It is kept because it names the offending parameter when it
  --       does fire, which (1) cannot do — (1) says only that the signature is
  --       not the approved one. The allow-list is the control; this is the
  --       error message.
  --
  -- Neither can see SEMANTICS. Nothing here proves a function derives its actor
  -- from auth.uid() rather than, say, from a GUC a caller can set. That is
  -- asserted separately below by reading each body for auth.uid(), which is
  -- itself textual — and is checked behaviourally, which is the part that
  -- actually knows, in
  -- supabase/tests/customer_review_request_visibility_assertions.sql, where a
  -- colleague passes another employee's uuid and gets an answer about
  -- themselves.

  -- (1) the allow-list
  select string_agg(sig, ', ' order by sig) into v_bad
  from (
    select f.proname || '(' || pg_get_function_arguments(f.oid) || ')' as sig
    from pg_proc f
    join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'public'
      and f.proname like '%customer_review%'
      and has_function_privilege('authenticated', f.oid, 'EXECUTE')
  ) t
  where sig not in (
    'customer_review_internal_test_warning()',
    'can_use_customer_review_test_cards()',
    'can_view_customer_review_test_card(p_card_id uuid)',
    'can_view_customer_review_test_card_row(p_booked_by uuid)',
    'book_customer_review_test_card(p_card_id uuid)',
    'confirm_customer_review_test_card_sent(p_card_id uuid)',
    'transition_customer_review_test_card(p_card_id uuid, p_next_status text, p_detail text DEFAULT NULL::text)'
  );

  if v_bad is not null then
    raise exception 'these are executable by authenticated and are not on the approved list: %', v_bad;
  end if;

  -- ...and every approved predicate must actually be present, so the list above
  -- cannot pass by the functions simply not existing.
  foreach v_col in array array[
    'can_use_customer_review_test_cards',
    'can_view_customer_review_test_card',
    'can_view_customer_review_test_card_row',
    'book_customer_review_test_card',
    'confirm_customer_review_test_card_sent'
  ] loop
    select coalesce(prosrc, '') into v_bad
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'public' and f.proname = v_col;

    if v_bad is null or v_bad = '' then
      raise exception '% is missing', v_col;
    end if;
    if v_bad not like '%auth.uid()%' then
      raise exception '% does not derive its actor from auth.uid()', v_col;
    end if;
    if not exists (
      select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
      where n.nspname = 'public' and f.proname = v_col
        and f.prosecdef
        and array_to_string(coalesce(f.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
    ) then
      raise exception '% must be SECURITY DEFINER and pin search_path', v_col;
    end if;
  end loop;

  -- (2) the heuristic, kept for the message it produces, not for coverage
  select string_agg(f.proname || '(' || pg_get_function_arguments(f.oid) || ')', ', ')
    into v_bad
  from pg_proc f
  join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public'
    and f.proname like '%customer_review%'
    and has_function_privilege('authenticated', f.oid, 'EXECUTE')
    and pg_get_function_arguments(f.oid) ~* '(p_user_id|p_actor_id|p_acting)';

  if v_bad is not null then
    raise exception 'these functions are callable by authenticated AND accept an acting-user id: %', v_bad;
  end if;

  -- ═══ THE ROW PREDICATE MUST NOT GO BACK TO THE TABLE ══════════════════════
  --
  -- Matched as a FROM/JOIN, not as any occurrence: a body legitimately contains
  -- the module key string as resolve_permission()'s argument.
  select coalesce(prosrc, '') into v_bad
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public' and f.proname = 'can_view_customer_review_test_card_row';

  if v_bad ~* '(from|join)\s+(public\.)?customer_review_test_cards\M' then
    raise exception 'can_view_customer_review_test_card_row queries customer_review_test_cards; it must decide from its argument';
  end if;

  -- ...and every predicate must still require an ACTIVE employee. The check
  -- moved out of the policies and into these functions; it must not have been
  -- lost on the way.
  foreach v_col in array array[
    'can_use_customer_review_test_cards',
    'can_view_customer_review_test_card',
    'can_view_customer_review_test_card_row',
    'book_customer_review_test_card',
    'confirm_customer_review_test_card_sent',
    'transition_customer_review_test_card',
    'record_customer_review_test_card_whatsapp_opened',
    'begin_customer_review_test_screenshot_removal'
  ] loop
    select coalesce(prosrc, '') into v_bad
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'public' and f.proname = v_col;
    if v_bad not like '%is_active%' then
      raise exception '% no longer requires an active user', v_col;
    end if;
  end loop;

  -- EVERY SECURITY DEFINER FUNCTION IN THIS MODULE PINS ITS search_path.
  --
  -- Asserted over the whole set rather than function by function, so one added
  -- later is covered by the same rule.
  select string_agg(f.proname, ', ' order by f.proname) into v_bad
  from pg_proc f
  join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public'
    and f.proname like '%customer_review%'
    and f.prosecdef
    and array_to_string(coalesce(f.proconfig, '{}'), ',') not like '%search_path=public, pg_temp%';
  if v_bad is not null then
    raise exception 'these SECURITY DEFINER functions do not pin search_path: %', v_bad;
  end if;

  -- THE THREE SERVICE-ROLE-ONLY FUNCTIONS. Each takes an actor or a recipient
  -- that the trusted route establishes; either one in a browser's hands would
  -- be a spoofing hole.
  for v_bad in
    select unnest(array[
      'public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)',
      'public.begin_customer_review_test_screenshot_removal(uuid, uuid)',
      'public.finish_customer_review_test_screenshot_removal(uuid)'
    ])
  loop
    if has_function_privilege('authenticated', v_bad, 'EXECUTE')
       or has_function_privilege('anon', v_bad, 'EXECUTE') then
      raise exception '% is executable by a client role', v_bad;
    end if;
    if not has_function_privilege('service_role', v_bad, 'EXECUTE') then
      raise exception '% is not executable by service_role, so the trusted route cannot work', v_bad;
    end if;
  end loop;

  -- The submission guard is reachable by nobody but this module's own
  -- functions.
  if has_function_privilege('authenticated', 'public.assert_customer_review_test_card_submittable(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.assert_customer_review_test_card_submittable(uuid)', 'EXECUTE') then
    raise exception 'assert_customer_review_test_card_submittable is reachable by a client role';
  end if;

  -- The bucket is private.
  if not exists (
    select 1 from storage.buckets
    where id = 'customer-review-test-screenshots' and public = false
  ) then
    raise exception 'the customer-review-test-screenshots bucket is missing or public';
  end if;

  -- NO CLIENT MAY REGISTER AN IMAGE. The absence of these two policies is what
  -- makes /api/customer-reviews/photos the only writer, and therefore what
  -- makes the byte inspection a boundary rather than a courtesy.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename = 'customer_review_test_card_screenshots'
    and cmd = 'INSERT';
  if v_n <> 0 then
    raise exception 'customer_review_test_card_screenshots has an INSERT policy; only the trusted upload route may register an image';
  end if;

  select count(*) into v_n
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and cmd = 'INSERT'
    and policyname like 'customer_review_test%';
  if v_n <> 0 then
    raise exception 'a client INSERT policy exists on the customer-review-test-screenshots bucket';
  end if;

  -- NO CLIENT MAY REMOVE ONE EITHER.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename = 'customer_review_test_card_screenshots'
    and cmd = 'DELETE';
  if v_n <> 0 then
    raise exception 'customer_review_test_card_screenshots has a DELETE policy; removal must go through the trusted route';
  end if;

  select count(*) into v_n
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and cmd = 'DELETE'
    and policyname like 'customer_review_test%';
  if v_n <> 0 then
    raise exception 'a client DELETE policy exists on the customer-review-test-screenshots bucket';
  end if;

  -- The bucket is SELECT-only for clients: exactly one policy, and it reads.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname like 'customer_review_test%';
  if v_n <> 1 then
    raise exception 'the customer-review-test-screenshots bucket has % client polic(ies); it must have exactly one, for SELECT', v_n;
  end if;

  -- And the privileges are gone as well as the policies.
  foreach v_col in array array['INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('authenticated', 'public.customer_review_test_card_screenshots', v_col) then
      raise exception 'authenticated still holds % on customer_review_test_card_screenshots', v_col;
    end if;
  end loop;

  -- NO REVIEW DESTINATION EXISTS ANYWHERE IN THIS MODULE'S SCHEMA.
  --
  -- Asserted structurally rather than promised in a comment: a future column
  -- named for a link, a URL or a review destination fails the migration. This
  -- is the schema-level half of "no public review link and no public-posting
  -- action"; the source-contract tests cover the application half.
  select string_agg(c.relname || '.' || a.attname, ', ') into v_bad
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname like 'customer_review%'
    and a.attnum > 0
    and not a.attisdropped
    and (a.attname ~* '(review_url|public_url|review_link|destination|google)');
  if v_bad is not null then
    raise exception 'these columns look like a public review destination, which this module must not have: %', v_bad;
  end if;

  -- NO CUSTOMER CONTACT COLUMN EITHER, for the same reason and by the same
  -- means. whatsapp_target_last_four holds four digits rather than a number
  -- and is excluded by name; anything else that looks like stored contact data
  -- fails — including a fingerprint column, if one is ever reintroduced without
  -- the requirement that would justify it.
  select string_agg(c.relname || '.' || a.attname, ', ') into v_bad
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname like 'customer_review%'
    and a.attnum > 0
    and not a.attisdropped
    and a.attname <> 'whatsapp_target_last_four'
    and (a.attname ~* '(customer_name|customer_phone|greeting|whatsapp_number|contact_)');
  if v_bad is not null then
    raise exception 'these columns look like customer contact data, which this module must not hold: %', v_bad;
  end if;

  -- THE MODULE SHIPS EMPTY. Test cards come from a fixture run against a
  -- disposable stack, never from a migration, so a production apply of this
  -- file creates no test data at all.
  select count(*) into v_n from public.customer_review_test_cards;
  if v_n <> 0 then
    raise exception 'this migration created % test card(s); test data must come from a fixture, never from a migration', v_n;
  end if;

  -- Both actions are registered deny-by-default.
  select count(*) into v_n
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions pa  on pa.id = mpa.action_id
  where pm.module_key = 'customer_review_requests'
    and pa.action_key in ('use', 'verify')
    and mpa.default_allowed = false;
  if v_n <> 2 then
    raise exception 'customer_review_requests must register use and verify as deny-by-default (got %)', v_n;
  end if;

  -- WHO HOLDS WHAT, after this migration:
  --   admin    use = allowed, verify = allowed, from the role rows above.
  --   manager  neither, unless an administrator assigns it.
  --   member   neither, unless an administrator assigns it.
  -- What this assertion checks is narrower and is about PER-PERSON grants: the
  -- migration must not hand either action to an individual employee. Control
  -- Center writes those rows later, and they are the highest level in the
  -- resolver, so a stray one here would be invisible and would outrank
  -- everything.
  select count(*) into v_n
  from public.employee_permission_overrides epo
  join public.permission_modules pm on pm.id = epo.module_id
  where pm.module_key = 'customer_review_requests';
  if v_n <> 0 then
    raise exception 'customer_review_requests has % employee override(s); this migration must create none', v_n;
  end if;
end $$;

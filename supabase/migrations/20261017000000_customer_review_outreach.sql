-- Customer Review Outreach — inviting a genuine customer to review BOE, honestly.
--
-- WHAT THIS IS
-- ------------
-- An authorized BOE employee prepares a NEUTRAL invitation for a customer or
-- project contact they have actually dealt with, opens WhatsApp with that
-- invitation prefilled, and later records what happened. The customer writes
-- and publishes the review themselves, from their own account, in their own
-- words. Nothing here writes, drafts, suggests or scores a review.
--
-- THE RULES THIS FILE ENFORCES IN THE DATABASE
-- --------------------------------------------
--   * A request cannot reach 'ready_to_send' without the employee's explicit
--     confirmation that the recipient is a genuine customer or project contact
--     (genuine_customer_confirmed), a customer name, a WhatsApp number, an
--     interaction type and an https review destination.
--   * A request that carries project photographs cannot reach 'ready_to_send'
--     without the employee's explicit confirmation that BOE may share them
--     (image_permission_confirmed) — enforced in a function, because a CHECK
--     cannot count rows in another table.
--   * Status moves ONLY through transition_customer_review_request(), which
--     holds the one transition table and writes the audit row in the same
--     transaction. No client role holds UPDATE on any status column, so a
--     status cannot move without its trail moving with it.
--   * 'verified' and 'closed' require customer_review_requests.verify. The
--     employee who raised the request cannot verify their own outreach unless
--     they separately hold that authority.
--   * No status asserts that a public review exists. review_public_url is
--     OPTIONAL FACTUAL EVIDENCE recorded by a person, never inferred.
--
-- WHAT OPENING WHATSAPP MEANS HERE
-- --------------------------------
-- Nothing, on its own. Opening wa.me hands the message to WhatsApp; it does not
-- prove WhatsApp accepted it, delivered it, or that the employee pressed send.
-- 'sent' is therefore a SEPARATE, DELIBERATE confirmation the employee makes
-- afterwards — see whatsapp_opened_at, which records the preparation, and
-- sent_at, which records the person's claim.
--
-- DELIBERATELY NOT BUILT
--   Bulk campaigns, scheduled follow-ups, review text generation, ratings,
--   sentiment, analytics, leaderboards, incentives, a media library, or any
--   automatic sending. None of these have storage here on purpose.
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

-- ═══ 1. Private bucket for project photographs and review proof ════════════
--
-- Images only, and only the three still-image formats this codebase already
-- trusts. 5 MB per object: these are project photographs taken on a phone, not
-- commercial documents. do UPDATE rather than do NOTHING so the private/limit/
-- type properties are enforced even if a bucket with this id already exists.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'customer-review-photos',
  'customer-review-photos',
  false,     -- private: no anonymous or public read, ever
  5242880,   -- 5 MB per file (5 × 1024 × 1024) — must equal REVIEW_PHOTO_MAX_BYTES
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ═══ 2. customer_review_requests ═══════════════════════════════════════════

create table public.customer_review_requests (
  id uuid primary key default gen_random_uuid(),

  -- Seven states, and no eighth. A CHECK rather than an enum, matching every
  -- other module here.
  status text not null default 'draft' check (status in (
    'draft',
    'ready_to_send',
    'sent',
    'customer_responded',
    'verified',
    'closed',
    'cancelled'
  )),

  -- ── Who the invitation is for ──
  customer_name text not null check (btrim(customer_name) <> '' and length(customer_name) <= 120),

  -- E.164, digits with a leading '+'. Nullable because a draft may be saved
  -- before the number is known; ready_to_send requires it. NEVER put this in a
  -- log line, an error message, or any query string other than the wa.me URL
  -- the employee's own browser opens.
  whatsapp_number text check (
    whatsapp_number is null
    or whatsapp_number ~ '^\+[1-9][0-9]{7,14}$'
  ),

  -- The eight real BOE interaction types. Fixed and small on purpose: free text
  -- here would become an unusable dimension within a month.
  interaction_type text check (interaction_type is null or interaction_type in (
    'factory_visit',
    'online_enquiry',
    'online_order',
    'restaurant_project',
    'cafe_project',
    'hotel_project',
    'other_bulk_project',
    'issue_resolved'
  )),

  -- ── What the employee records internally ──
  --
  -- INTERNAL ONLY. This never appears in the invitation and there is no code
  -- path that could put it there: the message is built from customer_name /
  -- greeting_name, project_reference and review_url alone.
  internal_note text check (internal_note is null or length(internal_note) <= 500),

  -- ── The invitation the customer will receive ──
  --
  -- Two editable fragments and nothing else. The neutral-feedback and
  -- customer-choice sentences are NOT stored, because they are not editable:
  -- they are a constant in src/lib/customerReviews/invitation.ts and the
  -- message is assembled from these fields plus that constant. There is
  -- deliberately no `message_body` column — a stored message body would be an
  -- unrestricted message editor with extra steps.
  greeting_name text check (
    greeting_name is null or (btrim(greeting_name) <> '' and length(greeting_name) <= 120)
  ),
  project_reference text check (project_reference is null or length(project_reference) <= 160),

  -- Where the customer is being pointed. https only, checked here as well as in
  -- the application, because a stored javascript: or http: destination would be
  -- a stored redirect for everyone who opens the record afterwards.
  review_url text check (
    review_url is null or (review_url like 'https://%' and length(review_url) <= 500)
  ),

  -- ── The two confirmations the product refuses to work without ──
  genuine_customer_confirmed boolean not null default false,
  image_permission_confirmed boolean not null default false,

  -- ── Ownership ──
  created_by uuid not null default auth.uid() references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ── What actually happened, each recorded separately ──
  --
  -- These four facts are NOT interchangeable and must never be collapsed:
  --   whatsapp_opened_at  the employee opened WhatsApp with the invitation
  --                       prefilled. Proves preparation, nothing more.
  --   sent_at             the employee CONFIRMED afterwards that they sent it.
  --                       A person's claim, deliberately made.
  --   responded_at        the customer replied. A person's observation.
  --   verified_at         a verifier checked the evidence and said so.
  whatsapp_opened_at timestamptz,
  whatsapp_opened_count integer not null default 0 check (whatsapp_opened_count >= 0),

  sent_at timestamptz,
  sent_by uuid references public.users(id),

  responded_at timestamptz,
  responded_by uuid references public.users(id),

  -- Optional factual evidence: a URL somebody pasted after seeing the review.
  -- Its presence is never treated as proof on its own — a verifier still has to
  -- verify.
  review_public_url text check (
    review_public_url is null
    or (review_public_url like 'https://%' and length(review_public_url) <= 500)
  ),

  verified_at timestamptz,
  verified_by uuid references public.users(id),
  verification_note text check (verification_note is null or length(verification_note) <= 500),

  closed_at timestamptz,
  closed_by uuid references public.users(id),

  cancelled_at timestamptz,
  cancelled_by uuid references public.users(id),
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),

  -- A record that claims a lifecycle event always says who and when; one that
  -- does not claim it says neither.
  constraint customer_review_requests_sent_fields_consistent check (
    (sent_at is null and sent_by is null)
    or (sent_at is not null and sent_by is not null)
  ),
  constraint customer_review_requests_responded_fields_consistent check (
    (responded_at is null and responded_by is null)
    or (responded_at is not null and responded_by is not null)
  ),
  constraint customer_review_requests_verified_fields_consistent check (
    (verified_at is null and verified_by is null)
    or (verified_at is not null and verified_by is not null)
  ),
  constraint customer_review_requests_closed_fields_consistent check (
    (closed_at is null and closed_by is null)
    or (closed_at is not null and closed_by is not null)
  ),
  constraint customer_review_requests_cancelled_fields_consistent check (
    (cancelled_at is null and cancelled_by is null)
    or (cancelled_at is not null and cancelled_by is not null)
  ),

  -- A closed request was verified first, and a verified or closed request
  -- always names its verifier. Stated as constraints rather than trusted to the
  -- transition table, so a future direct write cannot produce a closed request
  -- nobody ever checked.
  constraint customer_review_requests_verified_before_closed check (
    closed_at is null or verified_at is not null
  ),
  constraint customer_review_requests_status_matches_verification check (
    status not in ('verified', 'closed') or verified_at is not null
  ),
  constraint customer_review_requests_status_matches_cancellation check (
    (status = 'cancelled' and cancelled_at is not null)
    or (status <> 'cancelled' and cancelled_at is null)
  )
);

-- TWO indexes, and no third.
--
--   created_idx  the list screen's ordering, and the only index every read of
--                this table actually uses today.
--   status_idx   the module's one operational dimension — the verifier queue is
--                "customer_responded and not yet verified", and the tab strip is
--                status. Kept even though the MVP filters in memory, because it
--                is the query this table will grow into.
--
-- An owner index was considered and DELIBERATELY NOT created. Ownership is
-- decided by the SELECT policy in §6, which compares created_by on the row it is
-- already looking at — it never scans on created_by — so the index would have
-- served no query that exists.
create index customer_review_requests_created_idx on public.customer_review_requests (created_at desc);
create index customer_review_requests_status_idx  on public.customer_review_requests (status, created_at desc);

drop trigger if exists customer_review_requests_set_updated_at on public.customer_review_requests;
create trigger customer_review_requests_set_updated_at
  before update on public.customer_review_requests
  for each row execute function public.set_updated_at();

-- ═══ 3. customer_review_request_photos ═════════════════════════════════════
--
-- Metadata for objects in the private bucket. Two kinds, and they are not the
-- same thing:
--   project_photo  an ACTUAL photograph of the work BOE did for this customer.
--   review_proof   optional evidence, attached afterwards, that a public review
--                  exists.
-- No stock imagery, no generated imagery, and nothing that stands in for a
-- review the customer has not written.

create table public.customer_review_request_photos (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.customer_review_requests(id) on delete cascade,

  kind text not null check (kind in ('project_photo', 'review_proof')),

  -- The object key inside 'customer-review-photos'. UNIQUE so one object can
  -- never be claimed by two requests. The first path segment is always the
  -- request id — the storage policies below read ownership out of it, which is
  -- why the path must contain a separator and must not start with one.
  storage_path text not null unique check (
    position('/' in storage_path) > 1 and length(storage_path) <= 400
  ),

  -- Display only. Never used to build a path.
  file_name text not null check (btrim(file_name) <> '' and length(file_name) <= 200),

  -- FACTS ABOUT THE BYTES, not claims about them.
  --
  -- These two used to be whatever the browser said — `file.type` (derived from
  -- the extension) and `file.size`. Both are now written by
  -- /api/customer-reviews/photos after it has read the file and parsed its
  -- container, and no client role can insert a row at all, so a value here is
  -- something a server established rather than something a caller asserted.
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 5242880),

  -- sha256 of the accepted bytes, lower-case hex.
  --
  -- It is what makes a repeated upload answerable by CONTENT rather than by a
  -- timer: the same photograph offered twice for one request is one attachment,
  -- whatever raced with what, and a genuinely different photograph is never
  -- blocked. The uniqueness is per request, not global — two customers may
  -- legitimately have the same photograph of the same delivered chair.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint customer_review_photos_unique_content_per_request
    unique (request_id, content_sha256),

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
  -- So removal is MARKED before it is done. begin_customer_review_photo_removal
  -- stamps these two columns, every read filters the row out from that moment,
  -- the object is deleted, and finish_customer_review_photo_removal deletes the
  -- row. A failure between the two leaves a marked row that still names its
  -- path, so the operation is retryable and converges — and nothing is ever
  -- both invisible and unreachable.
  removal_started_at timestamptz,
  removal_by uuid references public.users(id),

  constraint customer_review_photos_removal_fields_consistent check (
    (removal_started_at is null and removal_by is null)
    or (removal_started_at is not null and removal_by is not null)
  ),

  -- The path segment the storage policies rely on has to agree with the row's
  -- own request, or a member of one request could reach another's objects.
  constraint customer_review_photos_path_matches_request check (
    split_part(storage_path, '/', 1) = request_id::text
  )
);

create index customer_review_photos_request_idx
  on public.customer_review_request_photos (request_id, kind);

-- ═══ 4. customer_review_request_events ═════════════════════════════════════
--
-- APPEND-ONLY lifecycle trail. No client role holds INSERT, UPDATE, DELETE or
-- TRUNCATE; rows arrive only from the definer functions below. The columns on
-- customer_review_requests are the CURRENT state — this is the history that
-- survives every transition.

create table public.customer_review_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.customer_review_requests(id) on delete cascade,

  event_type text not null check (event_type in (
    'created',            -- the draft was raised
    'status_changed',     -- a transition through the table in §8
    'whatsapp_opened',    -- the invitation was handed to WhatsApp. NOT "sent".
    'evidence_recorded',  -- a public review URL was attached
    'photo_removed'       -- an administrator withdrew an attached image
  )),

  previous_status text check (previous_status is null or previous_status in (
    'draft', 'ready_to_send', 'sent', 'customer_responded', 'verified', 'closed', 'cancelled'
  )),
  new_status text check (new_status is null or new_status in (
    'draft', 'ready_to_send', 'sent', 'customer_responded', 'verified', 'closed', 'cancelled'
  )),

  -- Short, and either system-generated or a note the actor deliberately wrote
  -- about this event. NEVER the customer's number and never the message body:
  -- the trail is about what somebody decided, not about the private data
  -- involved.
  detail text check (detail is null or length(detail) <= 500),

  actor_id uuid not null references public.users(id),
  created_at timestamptz not null default now(),

  -- A status change always names both ends; anything else names neither.
  constraint customer_review_events_status_matches_type check (
    (event_type = 'status_changed' and new_status is not null)
    or (event_type <> 'status_changed' and new_status is null and previous_status is null)
  )
);

create index customer_review_events_request_idx
  on public.customer_review_request_events (request_id, created_at desc);

-- ═══ 5. Visibility and editorship predicates ═══════════════════════════════
--
-- TWO functions, called by every policy AND by every definer function, so "who
-- may read this request" and "who may change it" are each answered in exactly
-- one place. SECURITY DEFINER + STABLE so a policy can call them without
-- recursing through RLS on public.users.
--
-- There is no third "may this person open the module" function — see the note
-- below where one used to be.

-- May this user READ this request?
--
--   * an admin;
--   * a verifier (customer_review_requests.verify) — they have to read the
--     outreach in order to check it;
--   * the employee who raised it.
--
-- A `use` holder sees THEIR OWN requests and nobody else's. That is deliberate:
-- these rows carry a customer's phone number, and module entry must never
-- become company-wide sight of every customer BOE has ever messaged.
-- THE ACTING IDENTITY IS NOT A PARAMETER, and that is the whole point of the
-- signature. This function is granted to `authenticated`, so anything it
-- accepts is chosen by a browser. An earlier version took
-- `p_user_id uuid default auth.uid()`; the default made every call site read
-- correctly and the parameter made the function an oracle — a signed-in
-- employee could pass a colleague's uuid and learn who is active, who is an
-- admin and who holds `verify`, one call at a time. Those are precisely the
-- facts this module withholds.
--
-- auth.uid() is read inside the body instead. A caller can ask "may I?" and
-- nothing else.
create or replace function public.can_view_customer_review_request(
  p_request_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.customer_review_requests r
    join public.users u on u.id = auth.uid() and u.is_active
    where r.id = p_request_id
      and (
        r.created_by = auth.uid()
        or u.role = 'admin'
        or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
      )
  );
$$;

revoke execute on function public.can_view_customer_review_request(uuid) from public, anon;
grant  execute on function public.can_view_customer_review_request(uuid) to authenticated;

-- The same question, asked about a row the caller already has in hand.
--
-- WHY THIS EXISTS SEPARATELY FROM THE FUNCTION ABOVE.
-- can_view_customer_review_request() resolves a request by SELECTing it. That
-- is right for the child tables and the bucket, which hold a request id and
-- need the parent looked up. It is wrong for customer_review_requests itself,
-- twice over:
--
--   1. It re-queries the table being guarded. Because the function is STABLE it
--      runs against the statement's own snapshot, so the row an
--      INSERT ... RETURNING is about to return is invisible to it — the policy
--      evaluates false and the insert is refused 42501. That was every create
--      in the UI, for everybody, admins included.
--
--   2. Spelling the predicate out inline in the policy instead — which is how
--      this was first fixed — trades one defect for a quieter one. A policy
--      body runs as the CALLER, so an inline "select ... from public.users" is
--      subject to whatever privileges and row security public.users carries.
--      Today that is survivable: authenticated holds column SELECT on id, role
--      and is_active (20260813000000), and the row policy is
--      USING (is_active = true) (20260812000000), which happens to agree with
--      the predicate's own is_active requirement. But the module's visibility
--      would then depend on a neighbouring table's grants staying exactly as
--      they are — and a future tightening of public.users would change who can
--      see customer contact details, silently, with nothing in this module to
--      say so.
--
-- SECURITY DEFINER closes both. It reads users with the definer's rights, like
-- every other predicate in this module, and it takes created_by as a VALUE, so
-- it never touches customer_review_requests at all.
--
-- IT TRUSTS NOTHING FROM THE CALLER BUT TWO IDENTIFIERS. Role, active state and
-- effective permission are all derived here; none is a parameter.
-- THE ACTING IDENTITY IS NOT A PARAMETER, and that is the whole point of the
-- signature. This function is granted to `authenticated`, so anything it
-- accepts is chosen by a browser. An earlier version took
-- `p_user_id uuid default auth.uid()`; the default made every call site read
-- correctly and the parameter made the function an oracle — a signed-in
-- employee could pass a colleague's uuid and learn who is active, who is an
-- admin and who holds `verify`, one call at a time. Those are precisely the
-- facts this module withholds.
--
-- auth.uid() is read inside the body instead. A caller can ask "may I?" and
-- nothing else.
create or replace function public.can_view_customer_review_request_row(
  p_created_by uuid
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
      and (
        p_created_by = auth.uid()
        or u.role = 'admin'
        or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
      )
  );
$$;

revoke execute on function public.can_view_customer_review_request_row(uuid) from public, anon;
grant  execute on function public.can_view_customer_review_request_row(uuid) to authenticated;

-- May this user CHANGE this request's contents?
--
-- Narrower than reading, in two directions at once. A verifier reads every
-- request and edits none of them: verifying somebody's outreach is not
-- authorship of it. The owner edits their own, and only while it is still being
-- prepared — once a request has been sent, what the customer received is a fact
-- and rewriting it would make the record a lie.
--
-- An admin is included because every module here admits one, and because a typo
-- in a customer's name has to be fixable.
-- THE ACTING IDENTITY IS NOT A PARAMETER, and that is the whole point of the
-- signature. This function is granted to `authenticated`, so anything it
-- accepts is chosen by a browser. An earlier version took
-- `p_user_id uuid default auth.uid()`; the default made every call site read
-- correctly and the parameter made the function an oracle — a signed-in
-- employee could pass a colleague's uuid and learn who is active, who is an
-- admin and who holds `verify`, one call at a time. Those are precisely the
-- facts this module withholds.
--
-- auth.uid() is read inside the body instead. A caller can ask "may I?" and
-- nothing else.
create or replace function public.can_edit_customer_review_request(
  p_request_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.customer_review_requests r
    join public.users u on u.id = auth.uid() and u.is_active
    where r.id = p_request_id
      and r.status in ('draft', 'ready_to_send')
      and (
        u.role = 'admin'
        or (
          r.created_by = auth.uid()
          and public.resolve_permission(auth.uid(), 'customer_review_requests', 'use')
        )
      )
  );
$$;

revoke execute on function public.can_edit_customer_review_request(uuid) from public, anon;
grant  execute on function public.can_edit_customer_review_request(uuid) to authenticated;

-- May this person RAISE a request, and is the row they are raising their own?
--
-- The INSERT policy used to ask this inline: an EXISTS over public.users written
-- straight into the WITH CHECK. It worked, and it made the module's primary
-- action depend on a neighbouring table's grants and row security — the same
-- objection that moved the read predicate behind definer rights, left standing
-- on the write side because the read side was what had visibly broken.
--
-- The asymmetry was the bug. A tightening of public.users would have taken the
-- create button with it, and the failure would have looked like a permissions
-- problem in this module rather than a grant change in another.
--
-- Same shape as the read predicates, for the same reasons: definer rights, a
-- pinned search_path, no acting-user parameter, and it never touches
-- customer_review_requests — it is asked about a row that does not exist yet.
create or replace function public.can_create_customer_review_request(
  p_created_by uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select auth.uid() is not null
     and p_created_by = auth.uid()          -- a request is raised by its author
     and exists (
       select 1
       from public.users u
       where u.id = auth.uid()
         and u.is_active
         and (
           u.role = 'admin'
           or public.resolve_permission(auth.uid(), 'customer_review_requests', 'use')
         )
     );
$$;

revoke execute on function public.can_create_customer_review_request(uuid) from public, anon;
grant  execute on function public.can_create_customer_review_request(uuid) to authenticated;

-- THERE IS NO can_use_customer_review_outreach(). One was written and removed
-- in the pre-review audit, and the reason is worth keeping: nothing called it.
--
-- Module ENTRY is answered in two places that already exist — the route guard
-- asks resolve_permission() for `use` and for `verify` (the shape
-- src/app/meetings/layout.tsx established), and every policy below asks a
-- narrower question about a specific row. A third function saying "may this
-- person open the module" would have been a granted, definer-rights function
-- with no caller: pure surface, and a tempting shortcut for a future policy
-- that should be asking about a row instead.

-- ═══ 6. Row-level security ═════════════════════════════════════════════════
--
-- No policy in this module is `USING (true)`.

alter table public.customer_review_requests       enable row level security;
alter table public.customer_review_request_photos enable row level security;
alter table public.customer_review_request_events enable row level security;

-- ── customer_review_requests ──

-- THIS POLICY ASKS ABOUT THE ROW IT IS GIVEN, and it must never go back to the
-- table to find it.
--
-- It reads like a job for can_view_customer_review_request(), and it was one.
-- That helper answers the same question — and is still the right answer for the
-- child tables and the bucket below, which are asking about a DIFFERENT table's
-- row. But it answers it by looking the request up in
-- public.customer_review_requests, and here that is the very table being
-- guarded. On a plain SELECT the lookup is merely redundant. On
-- `INSERT ... RETURNING` it is fatal:
--
--   Postgres applies the SELECT policy to the row an INSERT is about to return.
--   The helper is STABLE, so it runs against the statement's own snapshot — and
--   the row being inserted is not in that snapshot. The lookup finds nothing,
--   the policy evaluates false, and the INSERT is refused with 42501 "new row
--   violates row-level security policy". Every time, for everybody, including
--   an admin, with nothing wrong with the payload.
--
-- PostgREST turns .select() into RETURNING, so that was every create in the UI.
--
-- Written out below, the predicate reads `created_by` straight off the
-- candidate row. Same three people, same active-user requirement, one table
-- touched instead of two, and correct during the statement that inserts the row.
-- The table name is written out rather than left implicit. Unqualified,
-- created_by would resolve against whatever the predicate's inner scope happens
-- to contain — correct today only because nothing else in scope has a column of
-- that name. Passing it as an argument to a function that queries only users
-- removes the question entirely.
create policy "customer_review_requests_select" on public.customer_review_requests
  for select to authenticated
  using (
    public.can_view_customer_review_request_row(customer_review_requests.created_by)
  );

-- A request is born a draft, owned by its creator, claiming nothing.
create policy "customer_review_requests_insert" on public.customer_review_requests
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and status = 'draft'
    and sent_at is null
    and responded_at is null
    and verified_at is null
    and closed_at is null
    and cancelled_at is null
    and whatsapp_opened_at is null
    and whatsapp_opened_count = 0
    and review_public_url is null
    -- THE ACTOR COLUMNS ARE PINNED TOO, and their absence here was a real gap.
    -- Pinning only the timestamps left a client free to create a draft already
    -- naming who sent, verified or closed it, and carrying a verification note
    -- or a cancellation reason. None of that would make the request verified —
    -- the status and timestamp checks above see to that — but all of it reaches
    -- the detail screen, which renders verified_by as a person's name. An audit
    -- trail that can be pre-populated by the person being audited is not one.
    and sent_by is null
    and responded_by is null
    and verified_by is null
    and verification_note is null
    and closed_by is null
    and cancelled_by is null
    and cancel_reason is null
    -- Authorship and authority are one question, asked with definer rights so
    -- that this policy does not read public.users as the caller. Every pin
    -- above stays where it is: the predicate answers who may create, not what
    -- the created row is allowed to claim.
    and public.can_create_customer_review_request(created_by)
  );

-- The PREPARATION fields are editable in place while the request is still being
-- prepared. What this policy cannot do is move the status: 'draft' and
-- 'ready_to_send' are both required on both sides, so neither is reachable from
-- the other through a client UPDATE and no further state is reachable at all.
-- Status moves only through transition_customer_review_request(); the column
-- grants in §9 are what make that unavoidable.
create policy "customer_review_requests_update" on public.customer_review_requests
  for update to authenticated
  using (
    status in ('draft', 'ready_to_send')
    and public.can_edit_customer_review_request(id)
  )
  with check (
    status in ('draft', 'ready_to_send')
    and public.can_edit_customer_review_request(id)
  );

-- Discarding a request raised by mistake and never acted on. Anything past that
-- is CANCELLED, not deleted — an outreach that reached a customer must leave a
-- record behind.
create policy "customer_review_requests_delete" on public.customer_review_requests
  for delete to authenticated
  using (
    status = 'draft'
    and whatsapp_opened_count = 0
    and public.can_edit_customer_review_request(id)
  );

-- A REQUEST THAT STILL HOLDS PHOTOGRAPHS CANNOT BE DELETED, and this trigger is
-- about storage rather than about the record.
--
-- customer_review_request_photos cascades from the request, so deleting a draft
-- would take its metadata rows with it — and the OBJECTS in the bucket would
-- stay behind, now undiscoverable, because the rows that named their paths are
-- the only index of them. Nothing could ever find or remove them again.
--
-- Refusing the delete makes the compensation the caller's, and it is a
-- compensation the UI already performs: removing a photograph deletes the row
-- and the object together. Empty the request, then discard it.
create or replace function public.customer_review_requests_prevent_delete_with_photos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.customer_review_request_photos where request_id = old.id) then
    raise exception 'CUSTOMER_REVIEW_HAS_PHOTOS: Remove the attached photographs before discarding this request'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

revoke execute on function public.customer_review_requests_prevent_delete_with_photos()
  from public, anon, authenticated;

drop trigger if exists customer_review_requests_prevent_delete_trg on public.customer_review_requests;
create trigger customer_review_requests_prevent_delete_trg
  before delete on public.customer_review_requests
  for each row execute function public.customer_review_requests_prevent_delete_with_photos();

-- ── customer_review_request_photos ──

create policy "customer_review_photos_select" on public.customer_review_request_photos
  for select to authenticated
  using (public.can_view_customer_review_request(request_id));

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
-- customer_review_requests.use for them, reads the request through THEIR OWN
-- RLS, applies the kind/status rule, parses the file's container to establish
-- what it really is, generates the object key itself, and only then writes —
-- with the service role, which no policy constrains and which never leaves the
-- server.
--
-- The rule that follows: an image can only be registered by something that has
-- read it. A client that tries goes through the route or does not go at all.
-- The storage INSERT policy is absent for the same reason (see §10).

-- THERE IS NO DELETE POLICY ON THIS TABLE EITHER.
--
-- An earlier version had one, and it created exactly the inconsistency the
-- two-step removal above exists to prevent: a browser could delete the metadata
-- row on its own and then fail — or simply decline — to remove the object,
-- leaving a file in the bucket that nothing named any more. The reverse was
-- equally available through the storage DELETE policy.
--
-- Removal is now one operation, in one place: DELETE /api/customer-reviews/photos
-- authorizes the caller, marks the row, deletes the object, deletes the row, and
-- leaves a photo_removed entry in the append-only trail. The two functions it
-- uses are granted to service_role alone, so there is no client path to half of
-- the job.
--
-- WHO MAY REMOVE WHAT is unchanged and is enforced inside
-- begin_customer_review_photo_removal():
--
--   the owner   a PROJECT PHOTOGRAPH, while the request is still being
--               prepared. And REVIEW PROOF only while the request is unverified
--               — evidence a verifier has already acted on must not vanish
--               from underneath their decision.
--
--   an admin    either kind, at any status, verified included. Without this an
--               image uploaded by accident — the wrong customer's site, a
--               bystander in shot, a photograph BOE turns out not to have
--               permission for — would be permanently unremovable, with no safe
--               correction route at all.

-- Every removal is recorded. The row names the file and the kind, so the trail
-- still reads correctly once the metadata row it describes is gone.
create or replace function public.customer_review_photos_log_removal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Skip when the parent request is itself going away. The trail cascades with
  -- it, so the row would be written and immediately deleted — and on some
  -- orderings the insert would fail against a row already being removed. The
  -- request-deletion trigger below makes this branch unreachable in practice;
  -- it is here so the function is correct on its own terms.
  if not exists (select 1 from public.customer_review_requests where id = old.request_id) then
    return old;
  end if;

  insert into public.customer_review_request_events
    (request_id, event_type, detail, actor_id)
  values
    (old.request_id, 'photo_removed',
     format('%s removed: %s',
            case when old.kind = 'review_proof' then 'Proof image' else 'Project photograph' end,
            left(coalesce(old.file_name, 'unnamed'), 120)),
     -- WHO REMOVED IT, and the order matters. removal_by is stamped by
     -- begin_customer_review_photo_removal() with the authenticated caller the
     -- route established; it is read FIRST because the delete itself arrives
     -- through the service role, where auth.uid() is null. Falling back to the
     -- uploader would credit the removal to whoever added the file, which is
     -- usually somebody else entirely.
     coalesce(old.removal_by, auth.uid(), old.uploaded_by));
  return old;
end;
$$;

revoke execute on function public.customer_review_photos_log_removal() from public, anon, authenticated;

drop trigger if exists customer_review_photos_log_removal_trg on public.customer_review_request_photos;
create trigger customer_review_photos_log_removal_trg
  before delete on public.customer_review_request_photos
  for each row execute function public.customer_review_photos_log_removal();

-- ── The two halves of a removal ───────────────────────────────────────────
--
-- Both are granted to service_role ALONE. They take the actor as a parameter,
-- which would be a spoofing hole if a browser could call them — so no browser
-- can: `authenticated` holds no EXECUTE on either, and DELETE /api/customer-
-- reviews/photos is what establishes the actor from the session before calling.
--
-- The authorization is repeated HERE as well as in the route, on purpose. The
-- route is the only caller today; this is what keeps the rule true if it ever
-- is not.

create or replace function public.begin_customer_review_photo_removal(
  p_photo_id uuid,
  p_actor_id uuid
)
returns public.customer_review_request_photos
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p       public.customer_review_request_photos%rowtype;
  r       public.customer_review_requests%rowtype;
  v_admin boolean;
begin
  -- Locked, so two removals of one photograph cannot both proceed to delete an
  -- object and then both try to delete the row.
  select * into p from public.customer_review_request_photos where id = p_photo_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_PHOTO_NOT_FOUND: That photograph is no longer attached'
      using errcode = 'P0002';
  end if;

  select (u.role = 'admin') into v_admin
  from public.users u
  where u.id = p_actor_id and u.is_active;
  if v_admin is null then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  select * into r from public.customer_review_requests where id = p.request_id;
  if not found then
    raise exception 'CUSTOMER_REVIEW_NOT_FOUND: That request no longer exists' using errcode = 'P0002';
  end if;

  -- An admin may correct anything, at any status. Everyone else is narrower.
  if not v_admin then
    if not (
      r.created_by = p_actor_id
      and public.resolve_permission(p_actor_id, 'customer_review_requests', 'use')
    ) then
      raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Only the employee who raised this request can remove its photographs'
        using errcode = '42501';
    end if;

    if p.kind = 'project_photo' then
      -- Preparation stage only. Once a request has been sent, its photographs
      -- are part of what was prepared.
      if r.status not in ('draft', 'ready_to_send') then
        raise exception 'CUSTOMER_REVIEW_LOCKED: Photographs cannot be removed once the request has been sent'
          using errcode = '42501';
      end if;
    else
      -- REVIEW PROOF, and the rule that matters: evidence a verifier has
      -- already acted on must not vanish from underneath their decision. Before
      -- verification the person who attached it may withdraw it; after
      -- verification only an administrator can, as a correction.
      if r.verified_at is not null then
        raise exception 'CUSTOMER_REVIEW_LOCKED: Verified proof can only be withdrawn by an administrator'
          using errcode = '42501';
      end if;
      if r.status not in ('sent', 'customer_responded') then
        raise exception 'CUSTOMER_REVIEW_LOCKED: Proof cannot be removed at this stage'
          using errcode = '42501';
      end if;
    end if;
  end if;

  -- Idempotent: a retry after a failed object deletion re-enters here and finds
  -- the row already marked, which is exactly the state it wants.
  if p.removal_started_at is null then
    update public.customer_review_request_photos
       set removal_started_at = now(),
           removal_by = p_actor_id
     where id = p_photo_id;
    select * into p from public.customer_review_request_photos where id = p_photo_id;
  end if;

  return p;
end;
$$;

revoke execute on function public.begin_customer_review_photo_removal(uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.begin_customer_review_photo_removal(uuid, uuid) to service_role;

-- The second half: the object is gone, so the row goes and the trail gains its
-- photo_removed entry (written by the trigger above, from removal_by).
create or replace function public.finish_customer_review_photo_removal(p_photo_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.customer_review_request_photos%rowtype;
begin
  select * into p from public.customer_review_request_photos where id = p_photo_id for update;
  -- Already finished. A retry says so rather than failing, so a caller that
  -- lost its response can converge.
  if not found then return true; end if;

  if p.removal_started_at is null then
    raise exception 'CUSTOMER_REVIEW_BAD_REMOVAL: This photograph was not marked for removal'
      using errcode = '23514';
  end if;

  delete from public.customer_review_request_photos where id = p_photo_id;
  return true;
end;
$$;

revoke execute on function public.finish_customer_review_photo_removal(uuid)
  from public, anon, authenticated;
grant  execute on function public.finish_customer_review_photo_removal(uuid) to service_role;

-- ── customer_review_request_events ──
--
-- Readable by whoever can read the request. Not writable, not editable, not
-- erasable — by anyone, including an admin. There is no INSERT, UPDATE or
-- DELETE policy on purpose.

create policy "customer_review_events_select" on public.customer_review_request_events
  for select to authenticated
  using (public.can_view_customer_review_request(request_id));

-- ═══ 7. Ready-to-send prerequisites ════════════════════════════════════════
--
-- The photograph rule cannot be a CHECK, because a CHECK cannot count rows in
-- another table. Everything else could be, but is kept here with it so that
-- "what does Ready to Send require" has ONE answer in the database, matching
-- readyToSendBlockers() in src/lib/customerReviews/status.ts.
--
-- THE STEERING CHECK IS THE ONE WORTH READING TWICE. The closing two sentences
-- of the invitation are a constant in the application and cannot be edited —
-- but the greeting and the project reference ARE editable, and an employee in a
-- hurry could type "please give us 5 stars" into a factual reference field and
-- send a message that asks for a rating in its first sentence and disclaims it
-- in its last. That would defeat the whole design, so the two editable
-- fragments are checked HERE as well as in the browser: a browser check
-- protects the person typing, and this one protects the customer.

-- Does this fragment ask the customer for a particular rating or verdict?
--
-- A deliberately NARROW list of solicitation phrases, not a sentiment model.
-- False positives are cheap (the employee rewrites a project reference) and a
-- false negative is a real customer receiving a steered ask, so the patterns
-- are written to catch the phrasings people actually use.
create or replace function public.customer_review_text_steers(p_text text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_text is not null and (
    lower(p_text) ~ '(^|[^a-z])(5|five)[[:space:]-]*stars?([^a-z]|$)'
    or lower(p_text) ~ '(^|[^a-z])5[[:space:]]*/[[:space:]]*5([^a-z]|$)'
    or lower(p_text) ~ '5[[:space:]]+out[[:space:]]+of[[:space:]]+5'
    or lower(p_text) ~ '(good|great|positive|excellent|best|nice|glowing)[[:space:]]+(review|rating|feedback)'
    or lower(p_text) ~ '(rate|review)[[:space:]]+us[[:space:]]+(well|highly|positively|good)'
    or lower(p_text) ~ 'please[[:space:]]+(rate|review)'
    or lower(p_text) ~ 'star[[:space:]]+rating'
    or p_text like '%★%'
  );
$$;

revoke execute on function public.customer_review_text_steers(text) from public, anon;
grant  execute on function public.customer_review_text_steers(text) to authenticated;

create or replace function public.assert_customer_review_ready(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        public.customer_review_requests%rowtype;
  v_photos integer;
begin
  select * into r from public.customer_review_requests where id = p_request_id;
  if not found then
    raise exception 'CUSTOMER_REVIEW_NOT_FOUND: That request no longer exists' using errcode = 'P0002';
  end if;

  if r.genuine_customer_confirmed is not true then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Confirm this is a genuine BOE customer or project contact'
      using errcode = '23514';
  end if;
  if btrim(coalesce(r.customer_name, '')) = '' then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Add the customer or project name'
      using errcode = '23514';
  end if;
  if r.whatsapp_number is null then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Add a valid WhatsApp number'
      using errcode = '23514';
  end if;
  if r.interaction_type is null then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Choose the interaction type'
      using errcode = '23514';
  end if;
  if r.review_url is null then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Add the review destination (an https link)'
      using errcode = '23514';
  end if;

  -- The two editable fragments must not ask for a rating. Checked before the
  -- photograph rules so the employee fixes wording and attachments in the order
  -- the form presents them.
  if public.customer_review_text_steers(r.greeting_name) then
    raise exception 'CUSTOMER_REVIEW_NOT_NEUTRAL: The greeting must not ask for a rating or a positive review'
      using errcode = '23514';
  end if;
  if public.customer_review_text_steers(r.project_reference) then
    raise exception 'CUSTOMER_REVIEW_NOT_NEUTRAL: The project reference must not ask for a rating or a positive review'
      using errcode = '23514';
  end if;

  select count(*) into v_photos
  from public.customer_review_request_photos
  where request_id = p_request_id and kind = 'project_photo';

  -- AT LEAST ONE REAL PROJECT PHOTOGRAPH, by product decision. It anchors the
  -- request to work BOE actually did for this customer: an outreach nobody can
  -- show a photograph of is an outreach nobody can evidence.
  --
  -- The photographs are NOT attached to the WhatsApp message — wa.me carries
  -- text only, and the employee shares images themselves if they choose to.
  -- They are a private project reference stored with the request.
  if v_photos = 0 then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Attach at least one real photograph of this customer''s project'
      using errcode = '23514';
  end if;

  if r.image_permission_confirmed is not true then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Confirm BOE has permission to share these photographs'
      using errcode = '23514';
  end if;
end;
$$;

revoke execute on function public.assert_customer_review_ready(uuid) from public, anon, authenticated;

-- ═══ 8. The transition table, as the only way status moves ═════════════════
--
-- ONE function, one table of legal moves, one audit row per move. The UI reads
-- the same table from src/lib/customerReviews/status.ts; this is the copy that
-- decides.
--
--   draft              → ready_to_send, cancelled
--   ready_to_send      → draft, sent, cancelled
--   sent               → customer_responded, cancelled
--   customer_responded → verified, cancelled
--   verified           → closed
--   closed             → (nothing)
--   cancelled          → (nothing)
--
-- ONE PATH THROUGH THE MIDDLE, and the shortcut that used to exist is gone.
--
-- An earlier version allowed sent → verified. It was wrong. Verification means
-- "somebody checked that this customer published a review", and a request in
-- 'sent' is one where nothing has come back at all — so that edge let a
-- verifier jump from "we sent a message" to "the review is confirmed" without
-- any record of a response in between, and left 'customer_responded' as a step
-- people could skip. The lifecycle is now linear:
--
--   sent → customer_responded → verified → closed
--
-- Recording a published review URL on a 'sent' request MOVES it to
-- 'customer_responded' (see record_customer_review_evidence below), because a
-- published review IS a response. That move is a status change with its own
-- trail row, and it never verifies anything.
--
-- 'sent' is reachable only from 'ready_to_send' and only by a deliberate call:
-- there is no path from "the employee opened WhatsApp" to "the message was
-- sent", because opening a link is not evidence of anything.
--
-- Cancelling stops at 'customer_responded'. A verified or closed request is a
-- finished record of something that actually happened; cancelling it would be
-- rewriting history rather than abandoning a plan.

create or replace function public.transition_customer_review_request(
  p_request_id  uuid,
  p_next_status text,
  p_detail      text default null,
  p_review_url  text default null
)
returns public.customer_review_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r        public.customer_review_requests%rowtype;
  v_uid    uuid := auth.uid();
  v_admin  boolean;
  v_use    boolean;
  v_verify boolean;
  v_owner  boolean;
  v_legal  boolean;
  v_detail text := nullif(btrim(coalesce(p_detail, '')), '');
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- Locked for the duration, so two clicks cannot both read 'ready_to_send' and
  -- both write 'sent'. The legality guard below then refuses the second.
  select * into r from public.customer_review_requests where id = p_request_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_NOT_FOUND: That request no longer exists' using errcode = 'P0002';
  end if;

  select (u.role = 'admin') into v_admin
  from public.users u
  where u.id = v_uid and u.is_active;
  if v_admin is null then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  v_use    := v_admin or public.resolve_permission(v_uid, 'customer_review_requests', 'use');
  v_verify := v_admin or public.resolve_permission(v_uid, 'customer_review_requests', 'verify');
  v_owner  := (r.created_by = v_uid);

  if not (v_use or v_verify) then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: You do not have access to Customer Review Outreach'
      using errcode = '42501';
  end if;

  -- ── Is the move itself legal? ──
  v_legal := case r.status
    when 'draft'              then p_next_status in ('ready_to_send', 'cancelled')
    when 'ready_to_send'      then p_next_status in ('draft', 'sent', 'cancelled')
    when 'sent'               then p_next_status in ('customer_responded', 'cancelled')
    when 'customer_responded' then p_next_status in ('verified', 'cancelled')
    when 'verified'           then p_next_status in ('closed')
    else false
  end;

  if not v_legal then
    raise exception 'CUSTOMER_REVIEW_BAD_TRANSITION: A % request cannot become %', r.status, p_next_status
      using errcode = '23514';
  end if;

  -- ── Is this person allowed to make it? ──
  --
  -- Verifying and closing need `verify`, and nothing else does. Everything up
  -- to and including "I sent it" belongs to the employee who did the outreach
  -- (or an admin): a verifier does not run somebody else's outreach for them.
  if p_next_status in ('verified', 'closed') then
    if not v_verify then
      raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Verifying and closing a request needs the Verify permission'
        using errcode = '42501';
    end if;
  else
    if not (v_admin or (v_owner and v_use)) then
      raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Only the employee who raised this request can update it'
        using errcode = '42501';
    end if;
  end if;

  if p_next_status = 'ready_to_send' then
    perform public.assert_customer_review_ready(p_request_id);
  end if;

  -- ── Apply ──
  --
  -- Returning to draft withdraws the readiness claim and nothing else. Nothing
  -- that already happened is erased, because nothing that happened can be
  -- undone by an edit.
  update public.customer_review_requests r2
     set status = p_next_status,

         sent_at = case when p_next_status = 'sent' then now() else r2.sent_at end,
         sent_by = case when p_next_status = 'sent' then v_uid else r2.sent_by end,

         responded_at = case when p_next_status = 'customer_responded' then now() else r2.responded_at end,
         responded_by = case when p_next_status = 'customer_responded' then v_uid else r2.responded_by end,

         verified_at = case when p_next_status = 'verified' then now() else r2.verified_at end,
         verified_by = case when p_next_status = 'verified' then v_uid else r2.verified_by end,
         -- The verifier's note is the only free text this function stores, and
         -- only on the step that needs one.
         verification_note = case
           when p_next_status = 'verified' then v_detail
           else r2.verification_note
         end,

         closed_at = case when p_next_status = 'closed' then now() else r2.closed_at end,
         closed_by = case when p_next_status = 'closed' then v_uid else r2.closed_by end,

         cancelled_at  = case when p_next_status = 'cancelled' then now() else r2.cancelled_at end,
         cancelled_by  = case when p_next_status = 'cancelled' then v_uid else r2.cancelled_by end,
         cancel_reason = case when p_next_status = 'cancelled' then v_detail else r2.cancel_reason end,

         -- Optional factual evidence, accepted only on the steps where a person
         -- could actually have seen a published review, and only as https.
         review_public_url = case
           when p_next_status in ('customer_responded', 'verified')
                and p_review_url is not null
                and p_review_url like 'https://%'
                and length(p_review_url) <= 500
             then p_review_url
           else r2.review_public_url
         end
   where r2.id = p_request_id;

  insert into public.customer_review_request_events
    (request_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_request_id, 'status_changed', r.status, p_next_status, v_detail, v_uid);

  select * into r from public.customer_review_requests where id = p_request_id;
  return r;
end;
$$;

revoke execute on function public.transition_customer_review_request(uuid, text, text, text) from public, anon;
grant  execute on function public.transition_customer_review_request(uuid, text, text, text) to authenticated;

-- Record that the invitation was handed to WhatsApp.
--
-- THIS IS NOT "SENT" AND MUST NEVER BECOME IT. It writes a timestamp and a
-- counter and does not touch status. The move to 'sent' is a separate call the
-- employee makes after they have actually sent the message.
create or replace function public.record_customer_review_whatsapp_opened(p_request_id uuid)
returns public.customer_review_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r     public.customer_review_requests%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  select * into r from public.customer_review_requests where id = p_request_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_NOT_FOUND: That request no longer exists' using errcode = 'P0002';
  end if;

  if not (
    exists (select 1 from public.users u where u.id = v_uid and u.is_active and u.role = 'admin')
    or (
      r.created_by = v_uid
      and public.resolve_permission(v_uid, 'customer_review_requests', 'use')
      and exists (select 1 from public.users u where u.id = v_uid and u.is_active)
    )
  ) then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Only the employee who raised this request can open WhatsApp for it'
      using errcode = '42501';
  end if;

  if r.status <> 'ready_to_send' then
    raise exception 'CUSTOMER_REVIEW_NOT_READY: Mark the request Ready to Send first'
      using errcode = '23514';
  end if;

  perform public.assert_customer_review_ready(p_request_id);

  update public.customer_review_requests
     set whatsapp_opened_at    = now(),
         whatsapp_opened_count = whatsapp_opened_count + 1
   where id = p_request_id;

  insert into public.customer_review_request_events
    (request_id, event_type, detail, actor_id)
  values
    (p_request_id, 'whatsapp_opened',
     'WhatsApp was opened with the invitation prefilled. This does not confirm the message was sent.',
     v_uid);

  select * into r from public.customer_review_requests where id = p_request_id;
  return r;
end;
$$;

revoke execute on function public.record_customer_review_whatsapp_opened(uuid) from public, anon;
grant  execute on function public.record_customer_review_whatsapp_opened(uuid) to authenticated;

-- Attach the public review URL as factual evidence.
--
-- ON A 'sent' REQUEST THIS ALSO MOVES IT TO 'customer_responded', and that is
-- deliberate rather than incidental: a published review IS a response, and
-- leaving the request in 'sent' would mean the record said "we heard nothing"
-- while holding a link to what the customer wrote. The move is a real status
-- change and writes its own trail row.
--
-- WHAT IT STILL DOES NOT DO is verify anything. verified_at is never touched
-- here, by anyone, at any status: recording where a review is and confirming
-- somebody checked it are two facts, and only a `verify` holder can assert the
-- second.
create or replace function public.record_customer_review_evidence(
  p_request_id uuid,
  p_review_url text
)
returns public.customer_review_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r     public.customer_review_requests%rowtype;
  v_uid uuid := auth.uid();
  v_url text := nullif(btrim(coalesce(p_review_url, '')), '');
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  select * into r from public.customer_review_requests where id = p_request_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_NOT_FOUND: That request no longer exists' using errcode = 'P0002';
  end if;

  if not (
    exists (select 1 from public.users u where u.id = v_uid and u.is_active and u.role = 'admin')
    or (
      r.created_by = v_uid
      and public.resolve_permission(v_uid, 'customer_review_requests', 'use')
      and exists (select 1 from public.users u where u.id = v_uid and u.is_active)
    )
  ) then
    raise exception 'CUSTOMER_REVIEW_UNAUTHORIZED: Only the employee who raised this request can record evidence'
      using errcode = '42501';
  end if;

  if r.status not in ('sent', 'customer_responded') then
    raise exception 'CUSTOMER_REVIEW_BAD_TRANSITION: Evidence can only be recorded on a sent request'
      using errcode = '23514';
  end if;

  if v_url is null or v_url not like 'https://%' or length(v_url) > 500 then
    raise exception 'CUSTOMER_REVIEW_BAD_URL: The review link must be an https address'
      using errcode = '23514';
  end if;

  update public.customer_review_requests
     set review_public_url = v_url,
         -- 'sent' → 'customer_responded'. Already-responded requests keep their
         -- status; nothing here can reach 'verified'.
         status       = case when r.status = 'sent' then 'customer_responded' else r.status end,
         responded_at = case when r.status = 'sent' then now()  else r.responded_at end,
         responded_by = case when r.status = 'sent' then v_uid  else r.responded_by end
   where id = p_request_id;

  insert into public.customer_review_request_events
    (request_id, event_type, detail, actor_id)
  values
    (p_request_id, 'evidence_recorded',
     'A public review link was recorded. It has not been verified.',
     v_uid);

  -- A status change always leaves a status_changed row, whichever function made
  -- it, so the trail reads the same however the request got here.
  if r.status = 'sent' then
    insert into public.customer_review_request_events
      (request_id, event_type, previous_status, new_status, detail, actor_id)
    values
      (p_request_id, 'status_changed', 'sent', 'customer_responded',
       'A published review link was recorded, which is a customer response.',
       v_uid);
  end if;

  select * into r from public.customer_review_requests where id = p_request_id;
  return r;
end;
$$;

revoke execute on function public.record_customer_review_evidence(uuid, text) from public, anon;
grant  execute on function public.record_customer_review_evidence(uuid, text) to authenticated;

-- Creation is logged by a trigger rather than by the client, so a request
-- cannot exist without the first line of its own trail.
create or replace function public.customer_review_requests_log_creation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.customer_review_request_events
    (request_id, event_type, detail, actor_id)
  values
    (new.id, 'created', 'Request raised.', new.created_by);
  return new;
end;
$$;

revoke execute on function public.customer_review_requests_log_creation() from public, anon, authenticated;

drop trigger if exists customer_review_requests_log_creation_trg on public.customer_review_requests;
create trigger customer_review_requests_log_creation_trg
  after insert on public.customer_review_requests
  for each row execute function public.customer_review_requests_log_creation();

-- ═══ 9. Column-level grants ════════════════════════════════════════════════
--
-- The UPDATE policy above decides WHICH ROWS; only a column grant can decide
-- WHICH COLUMNS. Without this an owner could PATCH `{ status: 'verified' }`
-- straight from the browser — past the transition table, past the verify
-- permission, and with no audit row. The grant is what makes both unavoidable.
--
-- service_role is unaffected, and the definer functions run as the table owner
-- regardless.

revoke update, truncate, references, trigger on public.customer_review_requests from authenticated, anon;

-- Exactly the fields the create/edit form writes, plus updated_at for the
-- set_updated_at trigger. NOT status, none of the lifecycle timestamps or
-- actors, not whatsapp_opened_*, not review_public_url, not verification_note,
-- not created_by.
grant update (
  customer_name,
  whatsapp_number,
  interaction_type,
  internal_note,
  greeting_name,
  project_reference,
  review_url,
  genuine_customer_confirmed,
  image_permission_confirmed,
  updated_at
) on public.customer_review_requests to authenticated;

revoke insert, update, delete, truncate on public.customer_review_requests from anon;

-- Photo metadata: READ-ONLY to every client role. No insert, no update, no
-- delete, no truncate.
--
-- Each revocation is belt to the braces of an absent policy, and each is worth
-- stating separately:
--
--   INSERT  registering an image is /api/customer-reviews/photos and nothing
--           else, because only something that has READ the bytes may record
--           what they are.
--   UPDATE  a row that could be re-pointed at a different object would make
--           customer_review_photos_path_matches_request decorative, and a row
--           that could be edited would let somebody rewrite mime_type,
--           byte_size or content_sha256 after the server established them.
--   DELETE  removal spans the bucket and this table, and a client that could do
--           one half would leave the other stranded. It is one server operation
--           or it is nothing.
--
-- A policy added back by mistake later still could not write, because the
-- privilege is gone.
revoke insert, update, delete, truncate on public.customer_review_request_photos from authenticated, anon;

-- The trail: readable, never writable. Neither policy nor grant admits a write,
-- and TRUNCATE — which no policy governs and no row trigger fires on — cannot
-- erase it either.
revoke insert, update, delete, truncate on public.customer_review_request_events from authenticated, anon;

comment on table public.customer_review_request_events is
  'Append-only Customer Review Outreach trail: created, status_changed, whatsapp_opened, evidence_recorded. No client role holds INSERT, UPDATE, DELETE or TRUNCATE; rows arrive only from the definer functions in 20261017000000. whatsapp_opened is NOT a delivery receipt — it records only that the invitation was handed to WhatsApp.';

comment on column public.customer_review_requests.whatsapp_opened_at is
  'When the invitation was last handed to WhatsApp with the message prefilled. Proves preparation only: it is not evidence that the message was sent, delivered or read. sent_at is the employee''s separate, deliberate confirmation.';

comment on column public.customer_review_requests.review_public_url is
  'Optional factual evidence of a published review, recorded by a person. Its presence never means the review has been verified — verified_at does, and only a customer_review_requests.verify holder can set it.';

-- ═══ 10. Storage policies ══════════════════════════════════════════════════
--
-- Ownership is read out of the FIRST PATH SEGMENT, which is always the request
-- id — the same shape as order-request-attachments (20260711000000) and
-- payment-proofs (20260672). The metadata table's
-- customer_review_photos_path_matches_request constraint is what keeps the two
-- in agreement.

-- THERE IS NO INSERT POLICY ON storage.objects FOR THIS BUCKET.
--
-- The pair to the missing metadata INSERT policy above, and the half that
-- actually stops the bytes. `authenticated` cannot put an object in
-- customer-review-photos by any route: not through supabase-js, not through the
-- Storage REST API, not with a forged path. The service role is not governed by
-- policies, so /api/customer-reviews/photos can — after it has read the file.
--
-- WHAT THIS CLOSES. With a client INSERT policy, a caller could upload
-- arbitrary bytes under a Content-Type of their choosing and then simply not
-- call the route; the object would sit in the bucket, unregistered and
-- unvalidated, reachable by anyone who could read that request's folder. The
-- validation would have been advisory. It is not.

-- Reading — which is also what createSignedUrl is governed by — follows exactly
-- who may read the request. A verifier sees the photographs because that is
-- what they are checking; nobody else sees them at all. Written as an EXISTS
-- over the request id rather than a cast of the path segment, so a malformed
-- object name is a non-match instead of an error.
create policy "customer_review_photos_storage_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'customer-review-photos'
    and exists (
      select 1 from public.customer_review_requests r
      where r.id::text = split_part(storage.objects.name, '/', 1)
        and public.can_view_customer_review_request(r.id)
    )
  );

-- THERE IS NO DELETE POLICY ON storage.objects FOR THIS BUCKET EITHER.
--
-- Together with the absent metadata DELETE policy, this is what makes removal
-- ONE operation instead of two independent ones a client could perform in
-- either order, or half of.
--
-- With a client storage DELETE policy, a browser could remove the object and
-- leave the row — a record pointing at a file that no longer exists, rendering
-- as a permanently broken preview for everyone who opens the request. With a
-- client metadata DELETE policy it could do the reverse and strand the file.
-- Neither is now expressible: `authenticated` holds no DELETE policy and no
-- DELETE privilege on either side.
--
-- DELETE /api/customer-reviews/photos does the whole job — mark, delete the
-- object, delete the row, leave the audit entry — and its two SQL halves are
-- granted to service_role alone.
--
-- The bucket is therefore SELECT-only for every client role. Reading stays with
-- the browser, through short-lived signed URLs, exactly as before.

-- ═══ 11. Registration in the permission engine ═════════════════════════════
--
-- Mirrors src/lib/permissions/modules.ts exactly — `npm run permissions:check`
-- fails if the two drift.
--
-- TWO ACTIONS, and the module registers no `view`. That is deliberate: `use` IS
-- module entry here, and a third "can open it but do nothing" grant would be a
-- state with no meaning — there is no read-only audience for one employee's own
-- outreach drafts. See docs/Module Docs/CUSTOMER_REVIEW_OUTREACH.md.

insert into public.permission_modules (module_key, display_name, description) values
  ('customer_review_requests', 'Customer Review Outreach',
   'Invite genuine customers to leave an honest review, and track the outreach.')
on conflict (module_key) do nothing;

-- Custom actions (is_system = false), like Sample Tracking's dispatch/receive.
insert into public.permission_actions (action_key, display_name, is_system) values
  ('use',    'Use Customer Review Outreach',   false),
  ('verify', 'Verify & Close Review Requests', false)
on conflict (action_key) do nothing;

-- System Default = false for both. Nobody holds anything here until an
-- administrator grants it: this module reaches real customers.
insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key in ('use', 'verify')
where pm.module_key = 'customer_review_requests'
on conflict (module_id, action_id) do nothing;

-- ROLE DEFAULTS: admin only, and only because every module here admits an
-- admin. manager and member are granted NOTHING. Who runs customer outreach,
-- and who is trusted to verify it, are decisions the business makes one person
-- at a time in Control Center → Access Control — not something a role name
-- should confer.
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
      'customer_review_requests',
      'customer_review_request_photos',
      'customer_review_request_events'
    )
    and c.relrowsecurity;
  if v_n <> 3 then
    raise exception 'row level security is not enabled on all three Customer Review Outreach tables (got %)', v_n;
  end if;

  -- The trail has no write policy of any kind.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename = 'customer_review_request_events'
    and cmd <> 'SELECT';
  if v_n <> 0 then
    raise exception 'customer_review_request_events has % write polic(ies); it must be append-only', v_n;
  end if;

  -- No policy anywhere in this module is unconditional.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename like 'customer_review%'
    and (coalesce(qual, '') = 'true' or coalesce(with_check, '') = 'true');
  if v_n <> 0 then
    raise exception '% Customer Review Outreach polic(ies) are USING (true)', v_n;
  end if;

  -- THE REQUEST'S OWN SELECT POLICY, CHECKED BY NAME.
  --
  -- Filtered by policyname, not merely by table and command: a second SELECT
  -- policy added later would otherwise make SELECT INTO pick an arbitrary one
  -- of the two and assert against whichever it happened to get.
  select coalesce(qual, '') into v_bad
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'customer_review_requests'
    and cmd        = 'SELECT'
    and policyname = 'customer_review_requests_select';

  if v_bad = '' then
    raise exception 'customer_review_requests_select is missing';
  end if;

  -- 1. It must not resolve the request by looking it up. The request-id helper
  --    is STABLE and re-reads this table, so the row an INSERT ... RETURNING is
  --    about to return is invisible to it and the insert is refused 42501.
  --    Matched on the exact name so that the _row variant does not count.
  if v_bad ~ 'can_view_customer_review_request\(' then
    raise exception 'customer_review_requests_select re-queries its own table; INSERT ... RETURNING cannot pass it';
  end if;

  -- 2. It must not read public.users in the policy body either. A policy runs
  --    as the CALLER, so an inline read of users binds this module's visibility
  --    to that table's grants and row security. The predicate belongs in a
  --    SECURITY DEFINER function, where every other predicate here already is.
  if v_bad ~* '\mfrom\M\s+(public\.)?users\M' then
    raise exception 'customer_review_requests_select reads public.users as the caller; use the row predicate instead';
  end if;

  -- 3. It must go through the row predicate.
  if v_bad not like '%can_view_customer_review_request_row%' then
    raise exception 'customer_review_requests_select does not use can_view_customer_review_request_row()';
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
  -- Neither can see SEMANTICS. Nothing here proves a one-argument function
  -- derives its actor from auth.uid() rather than, say, from a GUC a caller can
  -- set. That is asserted separately below by reading each body for auth.uid(),
  -- which is itself textual — and is checked behaviourally, which is the part
  -- that actually knows, in
  -- supabase/tests/customer_review_request_visibility_assertions.sql §6c, where
  -- a colleague passes another employee's uuid and gets an answer about
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
    'can_view_customer_review_request(p_request_id uuid)',
    'can_view_customer_review_request_row(p_created_by uuid)',
    'can_edit_customer_review_request(p_request_id uuid)',
    'can_create_customer_review_request(p_created_by uuid)',
    'customer_review_text_steers(p_text text)',
    'record_customer_review_whatsapp_opened(p_request_id uuid)',
    'record_customer_review_evidence(p_request_id uuid, p_review_url text)',
    'transition_customer_review_request(p_request_id uuid, p_next_status text, p_detail text DEFAULT NULL::text, p_review_url text DEFAULT NULL::text)'
  );

  if v_bad is not null then
    raise exception 'these are executable by authenticated and are not on the approved list: %', v_bad;
  end if;

  -- ...and every approved predicate must actually be present, so the list above
  -- cannot pass by the functions simply not existing.
  foreach v_col in array array[
    'can_view_customer_review_request',
    'can_view_customer_review_request_row',
    'can_edit_customer_review_request',
    'can_create_customer_review_request'
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
        and f.pronargs = 1
        and array_to_string(coalesce(f.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
    ) then
      raise exception '% must be SECURITY DEFINER, take one argument, and pin search_path', v_col;
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

  -- The removal halves DO take an actor, because the route establishes it from
  -- the session and the trigger credits it in the audit trail. That is only safe
  -- while no browser role can reach them.
  if has_function_privilege('authenticated', 'public.begin_customer_review_photo_removal(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.begin_customer_review_photo_removal(uuid,uuid)', 'EXECUTE') then
    raise exception 'begin_customer_review_photo_removal takes an actor id and is reachable by a client role';
  end if;

  -- ═══ CREATING IS ASKED WITH DEFINER RIGHTS TOO ════════════════════════════
  --
  -- The read policy was moved behind a definer predicate and the write policy
  -- was left reading public.users inline, which is the same defect on the other
  -- side: a tightening of that table would have taken the create button with it.
  select coalesce(with_check, '') into v_bad
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'customer_review_requests'
    and cmd        = 'INSERT'
    and policyname = 'customer_review_requests_insert';

  if v_bad = '' then
    raise exception 'customer_review_requests_insert is missing';
  end if;
  if v_bad ~* '\mfrom\M\s+(public\.)?users\M' then
    raise exception 'customer_review_requests_insert reads public.users as the caller; use the creation predicate';
  end if;
  if v_bad not like '%can_create_customer_review_request%' then
    raise exception 'customer_review_requests_insert does not use can_create_customer_review_request()';
  end if;

  -- ...and every field the create is not allowed to claim is still pinned.
  foreach v_col in array array[
    'sent_at', 'responded_at', 'verified_at', 'closed_at', 'cancelled_at',
    'whatsapp_opened_at', 'review_public_url', 'sent_by', 'responded_by',
    'verified_by', 'verification_note', 'closed_by', 'cancelled_by', 'cancel_reason'
  ] loop
    if v_bad not like '%' || v_col || '%' then
      raise exception 'customer_review_requests_insert no longer pins %', v_col;
    end if;
  end loop;

  if not exists (
    select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'public'
      and f.proname = 'can_create_customer_review_request'
      and f.prosecdef
      and array_to_string(coalesce(f.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
  ) then
    raise exception 'can_create_customer_review_request is missing, not SECURITY DEFINER, or does not pin search_path';
  end if;

  select coalesce(prosrc, '') into v_bad
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public' and f.proname = 'can_create_customer_review_request';

  if v_bad ~* '(from|join)\s+(public\.)?customer_review_requests\M' then
    raise exception 'can_create_customer_review_request queries customer_review_requests';
  end if;
  if v_bad not like '%is_active%' then
    raise exception 'can_create_customer_review_request no longer requires an active user';
  end if;
  if has_function_privilege('anon', 'public.can_create_customer_review_request(uuid)', 'EXECUTE') then
    raise exception 'anon can execute the creation predicate';
  end if;

  -- 4. ...which must be SECURITY DEFINER with a pinned search_path, or it
  --    solves nothing: definer rights are the whole point, and an unpinned
  --    search_path would let a caller resolve "users" to a table of their own
  --    while running as the owner.
  if not exists (
    select 1 from pg_proc f
    join pg_namespace n on n.oid = f.pronamespace
    where n.nspname = 'public'
      and f.proname = 'can_view_customer_review_request_row'
      and f.prosecdef
      and array_to_string(coalesce(f.proconfig, '{}'), ',') like '%search_path=public, pg_temp%'
  ) then
    raise exception 'can_view_customer_review_request_row is missing, is not SECURITY DEFINER, or does not pin search_path';
  end if;

  -- 5. ...and it must not query customer_review_requests, or it reintroduces
  --    the very lookup it was written to avoid.
  select coalesce(prosrc, '') into v_bad
  from pg_proc f join pg_namespace n on n.oid = f.pronamespace
  where n.nspname = 'public' and f.proname = 'can_view_customer_review_request_row';

  -- Matched as a FROM/JOIN, not as any occurrence: the body legitimately
  -- contains the string as resolve_permission()'s module key.
  if v_bad ~* '(from|join)\s+(public\.)?customer_review_requests\M' then
    raise exception 'can_view_customer_review_request_row queries customer_review_requests; it must decide from its arguments';
  end if;

  -- 6. ...and it must still require an active employee. The check moved out of
  --    the policy and into here; it must not have been lost on the way.
  if v_bad not like '%is_active%' then
    raise exception 'can_view_customer_review_request_row no longer requires an active user';
  end if;

  -- The bucket is private.
  if not exists (
    select 1 from storage.buckets
    where id = 'customer-review-photos' and public = false
  ) then
    raise exception 'the customer-review-photos bucket is missing or public';
  end if;

  -- NO CLIENT MAY REGISTER AN IMAGE. The absence of these two policies is what
  -- makes /api/customer-reviews/photos the only writer, and therefore what makes
  -- the byte inspection a boundary rather than a courtesy. Asserted rather than
  -- trusted, because a later migration adding one back would silently turn the
  -- validation off.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename = 'customer_review_request_photos'
    and cmd = 'INSERT';
  if v_n <> 0 then
    raise exception 'customer_review_request_photos has an INSERT policy; only the trusted upload route may register an image';
  end if;

  select count(*) into v_n
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and cmd = 'INSERT'
    and policyname like 'customer_review_photos%';
  if v_n <> 0 then
    raise exception 'a client INSERT policy exists on the customer-review-photos bucket';
  end if;

  -- NO CLIENT MAY REMOVE ONE EITHER. Deleting spans the bucket and the metadata
  -- table, and a client holding half of that is how an orphaned object or a
  -- broken reference gets made. Both policies must be absent, and both
  -- privileges gone.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'public'
    and tablename = 'customer_review_request_photos'
    and cmd = 'DELETE';
  if v_n <> 0 then
    raise exception 'customer_review_request_photos has a DELETE policy; removal must go through the trusted route';
  end if;

  select count(*) into v_n
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and cmd = 'DELETE'
    and policyname like 'customer_review_photos%';
  if v_n <> 0 then
    raise exception 'a client DELETE policy exists on the customer-review-photos bucket';
  end if;

  -- The bucket is SELECT-only for clients: exactly one policy, and it reads.
  select count(*) into v_n
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname like 'customer_review_photos%';
  if v_n <> 1 then
    raise exception 'the customer-review-photos bucket has % client polic(ies); it must have exactly one, for SELECT', v_n;
  end if;

  -- And the privileges are gone as well as the policies.
  for v_bad in
    select unnest(array['INSERT', 'UPDATE', 'DELETE'])
  loop
    if has_table_privilege('authenticated', 'public.customer_review_request_photos', v_bad) then
      raise exception 'authenticated still holds % on customer_review_request_photos', v_bad;
    end if;
  end loop;

  -- The two removal halves are reachable by service_role alone. Either one in
  -- a browser's hands would be an actor-spoofing hole: both take the actor as a
  -- parameter, because the route is what establishes it.
  for v_bad in
    select unnest(array[
      'public.begin_customer_review_photo_removal(uuid, uuid)',
      'public.finish_customer_review_photo_removal(uuid)'
    ])
  loop
    if has_function_privilege('authenticated', v_bad, 'EXECUTE')
       or has_function_privilege('anon', v_bad, 'EXECUTE') then
      raise exception '% is executable by a client role', v_bad;
    end if;
    if not has_function_privilege('service_role', v_bad, 'EXECUTE') then
      raise exception '% is not executable by service_role, so the removal route cannot work', v_bad;
    end if;
  end loop;

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

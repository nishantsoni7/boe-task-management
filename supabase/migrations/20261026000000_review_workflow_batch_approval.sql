-- ═════════════════════════════════════════════════════════════════════════════
-- Review Workflow — eight drafts a batch, and nothing reaches a candidate
-- unapproved
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT CHANGES, AND WHY IT IS ONE MIGRATION.
--
-- 20261023000000 shipped a generator with two rules that no longer hold: it
-- produced TWENTY reviews, and it refused to run until the available pool had
-- reached ZERO. Both were sized for a workflow where a generated draft went
-- straight into the candidate pool — with nothing between the model and a
-- customer's phone, the only brake available was scarcity.
--
-- The approved workflow puts a person there instead. A verifier supplies
-- guidance, EIGHT drafts are created, and they sit in `pending_approval` where
-- no candidate can see them. A verifier reads each complete draft and approves
-- one, a selection, or the whole batch; only then does a review become
-- available to book. Because approval is the brake, the pool rule is not needed
-- and the batch is small enough that a person can actually read all of it.
--
-- Those pieces only make sense together, which is why they are one file: the
-- new status is meaningless without the approval functions, and dropping the
-- pool rule is unsafe without the new status.
--
-- ═══ THE STATE MAP ═══════════════════════════════════════════════════════════
--
-- The module already expressed sub-states as a status plus a timestamp — `sent`
-- and `returned` are both status 'booked' with a column set — and this follows
-- that idiom rather than inventing a second vocabulary. NOTHING IS RENAMED.
--
--   conceptual state        status              discriminator
--   ─────────────────────── ─────────────────── ──────────────────────────────
--   pending approval        pending_approval    approved_at is null (enforced)
--   approved and available  available           approved_at is not null
--   booked but not sent     booked              sent_confirmed_at is null
--   sent                    booked              sent_confirmed_at is not null
--   submitted               submitted           —
--   returned                booked              returned_at is not null
--   verified                verified            —
--
-- APPROVAL STATE AND CANDIDATE STATE ARE NOT THE SAME AXIS, and the columns say
-- so: `approved_at`/`approved_by` record a verifier's decision about the TEXT
-- and are never cleared, while status records where the card is in a
-- candidate's workflow and moves back and forth. Unbooking returns a card to
-- 'available' and leaves the approval untouched, because the approval was never
-- about the booking.
--
-- ═══ WHY A CANDIDATE CANNOT SEE A PENDING DRAFT ══════════════════════════════
--
-- No policy is added for it, and that is the strongest form the guarantee could
-- take. customer_review_test_cards_select (20261017000000) reads:
--
--     (status = 'available' and can_use_customer_review_test_cards())
--     or can_view_customer_review_test_card_row(booked_by)
--
-- A pending draft is not 'available', so the first branch is false. Its
-- booked_by is null, so the second reduces to
-- `resolve_permission(uid, …, 'verify')`. A candidate holding only `use`
-- therefore matches NEITHER branch — through the page, through PostgREST,
-- through a hand-written query, through a direct id. A verifier matches the
-- second, which is exactly who should read it. The assertions execute this
-- rather than restating it.

-- ── 1. THE FIFTH STATUS ─────────────────────────────────────────────────────

alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_status_check;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_status_check
  check (status in (
    'pending_approval',  -- generated, unapproved, invisible to candidates
    'available',         -- approved; any `use` holder may book it
    'booked',
    'submitted',
    'verified'
  ));

-- A pending draft has no holder, and neither does an available one. The
-- original read `status = 'available' or booked_by is not null`, which a
-- pending row would violate.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_active_has_holder;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_active_has_holder
  check (status in ('available', 'pending_approval') or booked_by is not null);

-- ── 2. THE APPROVAL RECORD ──────────────────────────────────────────────────

alter table public.customer_review_test_cards
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.users(id);

-- The actor travels with the timestamp, the same shape every other pair on this
-- table already has.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_approval_consistent;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_approval_consistent
  check (
    (approved_by is null and approved_at is null)
    or (approved_by is not null and approved_at is not null)
  );

-- A PENDING DRAFT HOLDS NOTHING AT ALL. It is not approved, nobody has booked
-- it, nobody has opened WhatsApp for it, and there is no evidence attached to
-- it. This is what makes "pending" impossible to fake: a row in that state
-- carries no candidate work, so a candidate action cannot have happened to one.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_pending_is_untouched;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_pending_is_untouched
  check (
    status <> 'pending_approval'
    or (approved_at is null
        and booked_by is null and booked_at is null
        and whatsapp_opened_at is null and whatsapp_opened_count = 0
        and whatsapp_target_last_four is null
        and sent_confirmed_at is null
        and submitted_at is null
        and verified_at is null
        and returned_at is null)
  );

-- A GENERATED CARD LEAVES `pending_approval` ONLY BY BEING APPROVED.
--
-- Scoped to cards that belong to a batch, which is every card this workflow
-- creates. The scope is not a loophole, it is precision: the sixteen rehearsal
-- rows carry no batch and are removed by 20261025000000, and the local test
-- fixture's cards carry no batch either — neither was ever generated, so
-- neither has an approval to record. For everything the generator makes, the
-- constraint is absolute.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_batched_approval;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_batched_approval
  check (
    batch_id is null
    or status = 'pending_approval'
    or approved_at is not null
  );

-- A pending draft always came from a batch. Nothing else can be pending,
-- because nothing else is generated.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_pending_has_batch;

alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_pending_has_batch
  check (status <> 'pending_approval' or batch_id is not null);

create index if not exists customer_review_test_cards_pending
  on public.customer_review_test_cards (batch_id, card_ref)
  where status = 'pending_approval';

comment on column public.customer_review_test_cards.approved_at is
  'When a verifier approved this draft for candidates to see. Null while the card is pending_approval and never null afterwards for a generated card. It is an approval of the TEXT, not of a booking: unbooking returns the card to available and leaves this untouched.';

-- ── 3. EIGHT, AND THE REQUEST THAT ASKED FOR THEM ───────────────────────────
--
-- FIRST, A SENTENCE INSTEAD OF A CONSTRAINT NAME.
--
-- Production holds no batch at all, so this is about every other database. A
-- batch created by 20261023000000 holds twenty cards which are already
-- `available` and were never approved by anybody — there is no honest way to
-- migrate one into a workflow whose whole claim is that a candidate only ever
-- sees approved text, because stamping an approver onto it would be inventing
-- an audit record. The constraints below would refuse such a row anyway; this
-- refuses it first, and says why.
do $$
declare v_old integer;
begin
  select count(*) into v_old
    from public.customer_review_draft_batches where card_count <> 8;
  if v_old > 0 then
    raise exception using
      errcode = '23514',
      message = format(
        'REVIEW_WORKFLOW_LEGACY_BATCH: %s batch(es) from the retired twenty-draft generator are present.', v_old),
      detail  = 'Their cards are available but were never approved, and this migration cannot invent an approver for them.',
      hint    = 'Remove the retired batches and their cards before applying this file. Production holds no batch, so this cannot arise there.';
  end if;
end $$;

alter table public.customer_review_draft_batches
  drop constraint if exists customer_review_draft_batches_card_count_check;

alter table public.customer_review_draft_batches
  add constraint customer_review_draft_batches_card_count_check
  check (card_count = 8);

-- WHAT WAS ASKED FOR, BESIDE WHAT LANDED.
--
-- They are always equal, and recording both is what makes that checkable rather
-- than merely asserted: the insert is one transaction, so a batch that produced
-- the wrong number of drafts produces no row at all. A reader who wants to know
-- whether a batch was ever short can compare two columns instead of trusting a
-- comment.
--
-- THE SUCCESS/FAILURE STATE IS THE ROW'S EXISTENCE. A failed generation — a
-- provider error, a timeout, a malformed reply, a wrong count, a validation
-- refusal — rolls the whole transaction back and writes nothing here, by
-- design. There is no half-batch to mark failed, and a status column that could
-- only ever hold 'succeeded' would be a column that lies by omission. Failures
-- are recorded in the route's server log, which is the only place a rolled-back
-- transaction can record anything.
alter table public.customer_review_draft_batches
  add column if not exists expected_count integer not null default 8;

alter table public.customer_review_draft_batches
  drop constraint if exists customer_review_draft_batches_expected_count_check;

alter table public.customer_review_draft_batches
  add constraint customer_review_draft_batches_expected_count_check
  check (expected_count = 8 and card_count = expected_count);

-- THE KEY THAT MAKES A REPEATED TAP HARMLESS.
--
-- The browser mints one uuid when the verifier presses the confirmation and
-- sends it with the request. A second tap, a retried fetch, a double-submitted
-- form and two tabs racing all carry the SAME key, and the unique index below
-- means only the first of them can ever create a batch — the rest are told
-- which batch already exists. Two DIFFERENT deliberate generations carry two
-- different keys and both proceed, which is correct: asking twice on purpose is
-- allowed, asking once and being counted twice is not.
alter table public.customer_review_draft_batches
  add column if not exists request_key uuid not null default gen_random_uuid();

create unique index if not exists customer_review_draft_batches_request_key
  on public.customer_review_draft_batches (request_key);

-- ── 4. REVISION, AS AN APPEND-ONLY RECORD ───────────────────────────────────
--
-- A revision replaces the title and body of every draft in a batch that is
-- still pending. It is not a new batch — the cards keep their identity, their
-- reference and their batch — so it cannot be recorded in
-- customer_review_draft_batches, which holds one row per batch. It gets its own
-- append-only table instead, one row per revision, in the order they happened.
create table if not exists public.customer_review_draft_batch_revisions (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references public.customer_review_draft_batches(id) on delete cascade,
  revised_by   uuid not null references public.users(id),
  revised_at   timestamptz not null default now(),
  -- The new guidance exactly as submitted, capped like the batch's own.
  guidance     text not null check (btrim(guidance) <> '' and length(guidance) <= 2000),
  model        text not null check (btrim(model) <> '' and length(model) <= 120),
  -- How many pending drafts this revision actually rewrote. Between 1 and 8:
  -- a revision with nothing to revise is refused, and a batch holds eight.
  revised_count integer not null check (revised_count between 1 and 8),
  -- Same repeated-tap protection as the batch table.
  request_key  uuid not null default gen_random_uuid()
);

create unique index if not exists customer_review_draft_batch_revisions_request_key
  on public.customer_review_draft_batch_revisions (request_key);

create index if not exists customer_review_draft_batch_revisions_batch
  on public.customer_review_draft_batch_revisions (batch_id, revised_at desc);

comment on table public.customer_review_draft_batch_revisions is
  'Append-only: one row per successful revision of a batch''s still-pending drafts. Who asked, when, with what guidance, which model, and how many drafts were rewritten. A failed revision writes nothing here and changes no draft.';

alter table public.customer_review_draft_batch_revisions enable row level security;

-- Readable by whoever may verify — the same audience as the batch itself.
create policy "customer_review_draft_batch_revisions_select"
  on public.customer_review_draft_batch_revisions
  for select to authenticated
  using (public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify'));

-- READ-ONLY to every client role, the same posture as every other table here. A
-- new table in `public` arrives with INSERT/UPDATE/DELETE already granted to
-- authenticated by Supabase's default privileges; taking the privilege away
-- means a policy added back by mistake later still cannot write.
revoke insert, update, delete, truncate, references, trigger
  on public.customer_review_draft_batch_revisions from authenticated, anon;

-- ── 5. THE THREE NEW THINGS THE TRAIL HAS TO BE ABLE TO SAY ─────────────────

alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_card_events_event_type_check;

alter table public.customer_review_test_card_events
  add constraint customer_review_test_card_events_event_type_check
  check (event_type in (
    'generated',           -- a batch created this draft, pending approval
    'revised',             -- its title and body were regenerated while pending
    'approved',            -- a verifier released it to the candidate pool
    'booked',
    'unbooked',            -- the holder released it before confirming a send
    'whatsapp_opened',
    'sent_confirmed',
    'submitted',
    'verified',
    'returned',
    'screenshot_removed'
  ));

alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_card_events_previous_status_check;
alter table public.customer_review_test_card_events
  add constraint customer_review_test_card_events_previous_status_check
  check (previous_status is null or previous_status in (
    'pending_approval', 'available', 'booked', 'submitted', 'verified'
  ));

alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_card_events_new_status_check;
alter table public.customer_review_test_card_events
  add constraint customer_review_test_card_events_new_status_check
  check (new_status is null or new_status in (
    'pending_approval', 'available', 'booked', 'submitted', 'verified'
  ));

-- The events that MOVE the card name where it went; the events that only record
-- something happening to it name neither end. `revised` is in the second group
-- deliberately: a revision rewrites text and moves nothing.
alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_events_status_matches_type;

alter table public.customer_review_test_card_events
  add constraint customer_review_test_events_status_matches_type
  check (
    (event_type in ('generated', 'approved', 'booked', 'unbooked',
                    'submitted', 'verified', 'returned')
     and new_status is not null)
    or (event_type in ('revised', 'whatsapp_opened', 'sent_confirmed', 'screenshot_removed')
        and new_status is null and previous_status is null)
  );

-- ── 6. GENERATION ───────────────────────────────────────────────────────────
--
-- The 4-argument version is DROPPED rather than left beside this one. It still
-- carries the twenty-draft rule and the empty-pool rule, and a superseded
-- definer function that a service-role caller can still reach is not dead code,
-- it is a second door with the old lock on it.
drop function if exists public.create_customer_review_draft_batch(text, text, jsonb, uuid);

create or replace function public.create_customer_review_draft_batch(
  p_guidance    text,
  p_model       text,
  p_drafts      jsonb,
  p_actor_id    uuid,
  p_request_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch_id uuid;
  v_n        integer;
  v_next     integer;
  v_item     jsonb;
  v_title    text;
  v_body     text;
begin
  if p_request_key is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a generation request needs a request key'
      using errcode = '23514';
  end if;

  -- ── The actor ────────────────────────────────────────────────────────────
  -- Active account first, then the RESOLVED permission. No role is read here or
  -- anywhere else in this module: an administrator generates because the engine
  -- says they hold `verify`, not because of what they are called.
  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Generating drafts needs the Verify permission'
      using errcode = '42501';
  end if;

  -- ── One generation at a time ─────────────────────────────────────────────
  --
  -- Retained from 20261023000000, and it does a different job now that the pool
  -- rule is gone: it serialises reference allocation. Two batches inserting at
  -- once would both read the same `max(card_ref)` and both try to claim
  -- RW-000017. The lock is transaction-scoped, so it releases on commit or
  -- rollback without anything having to remember to.
  perform pg_advisory_xact_lock(hashtext('customer_review_draft_batch'));

  -- ── The same request, twice ──────────────────────────────────────────────
  --
  -- Checked AFTER the lock, so two concurrent retries of one request cannot
  -- both find nothing. The answer is the batch that already exists rather than
  -- an error: a repeated tap should be a no-op the caller can act on, not a
  -- failure it has to interpret.
  select id into v_batch_id
    from public.customer_review_draft_batches
   where request_key = p_request_key;
  if v_batch_id is not null then
    return v_batch_id;
  end if;

  -- ── THERE IS NO POOL CHECK ANY MORE ──────────────────────────────────────
  --
  -- 20261023000000 refused unless zero reviews were available, because a
  -- generated draft went straight into the candidate pool and scarcity was the
  -- only brake. Approval is the brake now: nothing generated here is visible to
  -- a candidate until a verifier approves it, so a verifier may prepare a batch
  -- whenever they like.

  -- ── Exactly eight, all valid ─────────────────────────────────────────────
  if jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the drafts payload is not an array'
      using errcode = '23514';
  end if;

  v_n := jsonb_array_length(p_drafts);
  if v_n <> 8 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the batch holds % draft(s), expected exactly 8', v_n
      using errcode = '23514';
  end if;

  insert into public.customer_review_draft_batches
    (generated_by, guidance, model, card_count, expected_count, request_key)
  values (p_actor_id, p_guidance, p_model, 8, 8, p_request_key)
  returning id into v_batch_id;

  -- References continue from the highest RW- already used, so a reference is
  -- never reused even after cards are deleted, and stays stable once assigned.
  select coalesce(max(substring(card_ref from 4)::integer), 0)
    into v_next
    from public.customer_review_test_cards
   where card_ref ~ '^RW-[0-9]{6}$';

  for v_item in select * from jsonb_array_elements(p_drafts)
  loop
    v_title := btrim(coalesce(v_item->>'title', ''));
    v_body  := btrim(coalesce(v_item->>'body', ''));

    if v_title = '' or v_body = '' then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a draft has an empty title or body'
        using errcode = '23514';
    end if;

    -- THE DATABASE REFUSES A CONTACT DETAIL TOO, rather than trusting that the
    -- route checked. Title as well as body: a title is displayed on the card.
    if public.customer_review_contains_phone(v_title)
    or public.customer_review_contains_phone(v_body) then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a draft contains a telephone number'
        using errcode = '23514';
    end if;

    v_next := v_next + 1;

    -- pending_approval, NOT available. This one word is the whole of the new
    -- workflow's safety property: a model's output is never a thing a candidate
    -- can pick up.
    insert into public.customer_review_test_cards
      (card_ref, test_category, test_title, test_body, batch_id, status)
    values ('RW-' || lpad(v_next::text, 6, '0'),
            coalesce(v_item->>'category', 'service_test')::text,
            v_title, v_body, v_batch_id, 'pending_approval');

    insert into public.customer_review_test_card_events
      (card_id, event_type, previous_status, new_status, detail, actor_id)
    select c.id, 'generated', null, 'pending_approval',
           'Draft generated from batch guidance. Awaiting approval.', p_actor_id
      from public.customer_review_test_cards c
     where c.card_ref = 'RW-' || lpad(v_next::text, 6, '0');
  end loop;

  return v_batch_id;
end;
$$;

comment on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid) is
  'Inserts one validated batch of exactly 8 review drafts, atomically, in pending_approval. Requires the resolved verify permission. There is no pool rule: approval, not scarcity, is what keeps a draft away from candidates. Generates nothing itself — the route supplies already-validated drafts — and repeating one request_key returns the batch it already created.';

-- It takes an actor id, so a browser must never be able to call it. The trusted
-- route calls it with the service role after establishing who is asking.
revoke execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)
  to service_role;

-- ── 7. REVISION ─────────────────────────────────────────────────────────────
--
-- Regenerates the title and body of every draft in one batch that is STILL
-- PENDING, and touches nothing else. The whole set changes or none of it does.
create or replace function public.revise_customer_review_draft_batch(
  p_batch_id    uuid,
  p_guidance    text,
  p_model       text,
  p_drafts      jsonb,
  p_actor_id    uuid,
  p_request_key uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n        integer;
  v_pending  uuid[];
  v_count    integer;
  v_item     jsonb;
  v_title    text;
  v_body     text;
  v_i        integer;
  v_existing integer;
begin
  if p_request_key is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a revision request needs a request key'
      using errcode = '23514';
  end if;

  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Revising drafts needs the Verify permission'
      using errcode = '42501';
  end if;

  if not exists (select 1 from public.customer_review_draft_batches b where b.id = p_batch_id) then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That batch no longer exists'
      using errcode = 'P0002';
  end if;

  -- The same repeated-tap rule as generation, and the same answer: the revision
  -- that already happened, not an error.
  select revised_count into v_existing
    from public.customer_review_draft_batch_revisions
   where request_key = p_request_key;
  if v_existing is not null then
    return v_existing;
  end if;

  -- ── LOCK THE PENDING MEMBERS, THEN RECHECK ───────────────────────────────
  --
  -- `for update` on the pending rows of this batch is what makes "only pending
  -- drafts change" true under concurrency rather than only in a quiet moment. A
  -- verifier approving a draft in another tab either commits before this lock
  -- is taken — in which case the row is no longer pending and is not selected —
  -- or waits behind it, and finds the text already rewritten. There is no
  -- window in which an approved draft is overwritten.
  --
  -- ORDERED BY card_ref so the drafts map onto the generated array in a stable,
  -- reproducible order, and so two concurrent revisions of the same batch take
  -- the row locks in the same order and cannot deadlock.
  select array_agg(c.id order by c.card_ref)
    into v_pending
    from (
      select id, card_ref
        from public.customer_review_test_cards
       where batch_id = p_batch_id
         and status = 'pending_approval'
       order by card_ref
         for update
    ) c;

  v_count := coalesce(array_length(v_pending, 1), 0);

  if v_count = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOTHING_PENDING: Every review in that batch has already been approved; there is nothing left to revise'
      using errcode = '23514';
  end if;

  if jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the drafts payload is not an array'
      using errcode = '23514';
  end if;

  v_n := jsonb_array_length(p_drafts);

  -- THE COUNT IS RECHECKED HERE, INSIDE THE LOCK, AND A MISMATCH REFUSES
  -- EVERYTHING. The route counted the pending drafts before it called the
  -- model; if somebody approved one in between, the batch it generated no
  -- longer describes the batch it would write. Refusing is the only answer that
  -- cannot leave a draft rewritten with somebody else's text.
  if v_n <> v_count then
    raise exception 'CUSTOMER_REVIEW_TEST_REVISION_CHANGED: % review(s) are pending in that batch but % replacement(s) were prepared; nothing was changed', v_count, v_n
      using errcode = '23514';
  end if;

  for v_i in 1 .. v_count loop
    v_item  := p_drafts -> (v_i - 1);
    v_title := btrim(coalesce(v_item->>'title', ''));
    v_body  := btrim(coalesce(v_item->>'body', ''));

    if v_title = '' or v_body = '' then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a revised draft has an empty title or body'
        using errcode = '23514';
    end if;

    if public.customer_review_contains_phone(v_title)
    or public.customer_review_contains_phone(v_body) then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a revised draft contains a telephone number'
        using errcode = '23514';
    end if;

    -- The card keeps its id, its reference and its batch. Only what the model
    -- wrote is replaced — every column CHECK the table already carries still
    -- applies, and a violation aborts the whole function because this is one
    -- transaction.
    --
    -- `and status = 'pending_approval'` is belt to the lock's braces: the row is
    -- already held, so it cannot have changed, and the predicate means a future
    -- edit that loosened the lock would write nothing rather than write wrongly.
    update public.customer_review_test_cards
       set test_title    = v_title,
           test_body     = v_body,
           test_category = coalesce(v_item->>'category', test_category)::text,
           updated_at    = now()
     where id = v_pending[v_i]
       and status = 'pending_approval';

    if not found then
      raise exception 'CUSTOMER_REVIEW_TEST_REVISION_CHANGED: a review stopped being pending while it was being revised; nothing was changed'
        using errcode = '23514';
    end if;

    insert into public.customer_review_test_card_events
      (card_id, event_type, previous_status, new_status, detail, actor_id)
    values (v_pending[v_i], 'revised', null, null,
            'Draft regenerated from new guidance while pending approval.', p_actor_id);
  end loop;

  insert into public.customer_review_draft_batch_revisions
    (batch_id, revised_by, guidance, model, revised_count, request_key)
  values (p_batch_id, p_actor_id, p_guidance, p_model, v_count, p_request_key);

  return v_count;
end;
$$;

comment on function public.revise_customer_review_draft_batch(uuid, text, text, jsonb, uuid, uuid) is
  'Replaces the title and body of every still-pending draft in one batch, atomically, from freshly supplied guidance. Locks the pending rows and rechecks their status before writing, so an approved, booked, sent, submitted, returned or verified review can never be rewritten. Requires the resolved verify permission.';

revoke execute on function public.revise_customer_review_draft_batch(uuid, text, text, jsonb, uuid, uuid)
  from public, anon, authenticated;
grant  execute on function public.revise_customer_review_draft_batch(uuid, text, text, jsonb, uuid, uuid)
  to service_role;

-- ── 8. APPROVAL ─────────────────────────────────────────────────────────────
--
-- Two functions, because there are two questions. One takes the ids a verifier
-- selected; the other takes a batch and approves whatever in it is still
-- pending. Both are callable from a browser, because both take their actor from
-- auth.uid() and there is nothing to ask for on somebody else's behalf.
--
-- ATOMIC, OR NOTHING. A selection is approved as a set: if one member has
-- stopped being pending — because another verifier got there first, or because
-- the browser is showing a list from five minutes ago — the whole call is
-- refused and no card moves. Partial approval of a group nobody chose to split
-- is worse than a refusal a person can retry.
create or replace function public.approve_customer_review_drafts(p_card_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_ids     uuid[];
  v_asked   integer;
  v_locked  integer;
  v_bad     text;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- ACTIVE, AND HOLDING `verify`. No role branch: an administrator approves
  -- because the engine resolves `verify` for them, and an administrator whose
  -- `verify` was revoked in Control Center is refused here exactly like anybody
  -- else. That is what revoking it is for.
  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Approving a review needs the Verify permission'
      using errcode = '42501';
  end if;

  -- Duplicates in the request are a browser sending the same id twice, not a
  -- request to approve something twice.
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_card_ids, '{}'::uuid[])) x;
  v_asked := coalesce(array_length(v_ids, 1), 0);

  if v_asked = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: Select at least one review to approve'
      using errcode = '23514';
  end if;
  if v_asked > 8 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: A batch holds eight reviews; % were selected', v_asked
      using errcode = '23514';
  end if;

  -- Lock every named row before deciding anything, in id order so two verifiers
  -- approving overlapping selections queue rather than deadlock.
  select count(*) into v_locked from (
    select id from public.customer_review_test_cards
     where id = any(v_ids)
     order by id
       for update
  ) l;

  if v_locked <> v_asked then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: % of the selected reviews no longer exist; nothing was approved', v_asked - v_locked
      using errcode = 'P0002';
  end if;

  -- RECHECKED AFTER THE LOCK, which is the only place the check means anything.
  select string_agg(card_ref, ', ' order by card_ref) into v_bad
    from public.customer_review_test_cards
   where id = any(v_ids) and status <> 'pending_approval';

  if v_bad is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_PENDING: % is no longer awaiting approval; nothing was approved', v_bad
      using errcode = '23514';
  end if;

  update public.customer_review_test_cards
     set status      = 'available',
         approved_at = now(),
         approved_by = v_uid,
         updated_at  = now()
   where id = any(v_ids)
     and status = 'pending_approval';

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select id, 'approved', 'pending_approval', 'available',
         'Approved. The review is now available for a candidate to book.', v_uid
    from public.customer_review_test_cards
   where id = any(v_ids);

  return v_asked;
end;
$$;

comment on function public.approve_customer_review_drafts(uuid[]) is
  'Approves a selected set of pending drafts atomically, releasing them into the candidate pool. Requires the resolved verify permission. Locks and rechecks every row, so a stale browser cannot approve a review that has stopped being pending, and a partial approval is not expressible.';

revoke execute on function public.approve_customer_review_drafts(uuid[]) from public, anon;
grant  execute on function public.approve_customer_review_drafts(uuid[]) to authenticated;

-- Everything still pending in one batch. The SET IS CHOSEN INSIDE THE
-- TRANSACTION rather than sent by the browser, so "approve all pending" means
-- what is pending now — not what was pending when the page last loaded.
create or replace function public.approve_customer_review_draft_batch(p_batch_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Approving a review needs the Verify permission'
      using errcode = '42501';
  end if;

  select array_agg(c.id order by c.id) into v_ids
    from (
      select id from public.customer_review_test_cards
       where batch_id = p_batch_id and status = 'pending_approval'
       order by id
         for update
    ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOTHING_PENDING: Nothing in that batch is awaiting approval'
      using errcode = '23514';
  end if;

  update public.customer_review_test_cards
     set status      = 'available',
         approved_at = now(),
         approved_by = v_uid,
         updated_at  = now()
   where id = any(v_ids)
     and status = 'pending_approval';

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select unnest(v_ids), 'approved', 'pending_approval', 'available',
         'Approved with the rest of the batch. The review is now available for a candidate to book.',
         v_uid;

  return v_n;
end;
$$;

comment on function public.approve_customer_review_draft_batch(uuid) is
  'Approves every still-pending draft in one batch, atomically. The set is chosen inside the transaction under a row lock, so it is what is pending now rather than what the browser last saw.';

revoke execute on function public.approve_customer_review_draft_batch(uuid) from public, anon;
grant  execute on function public.approve_customer_review_draft_batch(uuid) to authenticated;

-- ── 9. UNBOOKING ────────────────────────────────────────────────────────────
--
-- The holder may put a review back until they say they sent it. After that the
-- claim exists and cannot be withdrawn: a person stated that a message left
-- their phone, and releasing the card would let somebody else book a review
-- that has already been sent to a real recipient.
--
-- THE HOLDER, AND ONLY THE HOLDER. There is no verifier bypass and no
-- administrator bypass. A verifier's authority over somebody else's card is the
-- RETURN path (transition_customer_review_test_card), which already exists,
-- requires a reason and leaves the card with its holder — that is the
-- separately authorised administrative workflow, and this is not it.
create or replace function public.unbook_customer_review_test_card(p_card_id uuid)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c      public.customer_review_test_cards%rowtype;
  v_uid  uuid := auth.uid();
  v_shots integer;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- LOCKED FIRST. confirm_customer_review_test_card_sent() takes the same row
  -- lock, so an unbook racing a send-confirmation is serialised by Postgres:
  -- whichever commits first is seen whole by the other, and the second is
  -- refused by one of the checks below. There is no interleaving that leaves a
  -- card both released and confirmed sent.
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That review no longer exists' using errcode = 'P0002';
  end if;

  if not (
    c.booked_by = v_uid
    and public.resolve_permission(v_uid, 'customer_review_requests', 'use')
    and exists (select 1 from public.users u where u.id = v_uid and u.is_active)
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the candidate holding this review can release it'
      using errcode = '42501';
  end if;

  if c.status <> 'booked' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_TRANSITION: A % review cannot be unbooked', c.status
      using errcode = '23514';
  end if;

  -- THE POINT OF NO RETURN, ENFORCED IN THE DATABASE. The UI hides the control
  -- and the route would refuse, and this is the one that decides.
  if c.sent_confirmed_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_SENT: You confirmed you sent this review, so it can no longer be unbooked'
      using errcode = '23514';
  end if;

  -- A LIVE SCREENSHOT MUST COME OFF FIRST, and this is a privacy rule rather
  -- than a tidiness one. An available review is readable by every `use` holder,
  -- and so are its screenshots — so releasing a card with somebody's WhatsApp
  -- screen still attached would publish that image to the whole pool. It would
  -- also block the next holder, because one live screenshot per card is a
  -- unique index. The holder can remove it themselves while they still hold the
  -- card, which is the same window this action lives in.
  select count(*) into v_shots
    from public.customer_review_test_card_screenshots s
   where s.card_id = p_card_id and s.removal_started_at is null;
  if v_shots > 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Remove the screenshot you attached before unbooking this review'
      using errcode = '23514';
  end if;

  -- ── Back to the approved pool ────────────────────────────────────────────
  --
  -- EVERY BOOKING-SPECIFIC FIELD IS CLEARED, including the four retained digits
  -- of whoever the last link was addressed to. The next holder must not inherit
  -- a trace of the previous holder's recipient, and the table's
  -- `available_is_empty` constraint independently refuses a released row that
  -- kept any of it.
  --
  -- approved_at AND approved_by SURVIVE. The verifier approved the text, not the
  -- booking; a released review is still an approved review, which is precisely
  -- what "returns to the approved and available pool" means.
  --
  -- submitted_* and returned_* are already null here and are cleared anyway: a
  -- card cannot have been submitted without sent_confirmed_at, which the check
  -- above has just proved is null. Writing them is the defensive half of a
  -- statement whose predicate already covers it.
  update public.customer_review_test_cards
     set status                    = 'available',
         booked_by                 = null,
         booked_at                 = null,
         whatsapp_opened_at        = null,
         whatsapp_opened_count     = 0,
         whatsapp_target_last_four = null,
         submitted_at              = null,
         submitted_by              = null,
         returned_at               = null,
         returned_by               = null,
         return_reason             = null,
         updated_at                = now()
   where id = p_card_id;

  -- THE TRAIL IS NOT ERASED. Every booking, every WhatsApp open and every
  -- return this card ever had stays in customer_review_test_card_events, which
  -- no role can write or delete. Releasing a booking adds a line; it does not
  -- remove one.
  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id, 'unbooked', 'booked', 'available',
     'The candidate released this review before confirming a send. It is available again.',
     v_uid);

  select * into c from public.customer_review_test_cards where id = p_card_id;
  return c;
end;
$$;

comment on function public.unbook_customer_review_test_card(uuid) is
  'Releases a booked review back into the approved and available pool. The holder only, only before they confirm a send, and only with no live screenshot attached. Clears every booking field including the retained last four digits; leaves the approval and the append-only trail intact.';

revoke execute on function public.unbook_customer_review_test_card(uuid) from public, anon;
grant  execute on function public.unbook_customer_review_test_card(uuid) to authenticated;

-- ── 10. WHAT THIS FILE PROMISED, ASSERTED ───────────────────────────────────
do $$
declare
  v_txt text;
begin
  -- The fifth status exists and the fourth still does.
  if not exists (
    select 1 from pg_constraint
     where conname = 'customer_review_test_cards_status_check'
       and pg_get_constraintdef(oid) like '%pending_approval%'
       and pg_get_constraintdef(oid) like '%available%'
  ) then
    raise exception 'the status check does not admit pending_approval';
  end if;

  -- The retired 4-argument generator is gone, not merely superseded.
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'create_customer_review_draft_batch'
      and p.pronargs = 4
  ) then
    raise exception 'the 20-draft, empty-pool generator is still callable';
  end if;

  -- Eight, and it is the schema saying so rather than the application.
  if not exists (
    select 1 from pg_constraint
     where conname = 'customer_review_draft_batches_card_count_check'
       and pg_get_constraintdef(oid) like '%= 8%'
  ) then
    raise exception 'the batch size constraint is not 8';
  end if;

  -- Neither writer that takes an actor id is reachable from a browser.
  if has_function_privilege('authenticated',
       'public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)', 'EXECUTE')
  or has_function_privilege('authenticated',
       'public.revise_customer_review_draft_batch(uuid, text, text, jsonb, uuid, uuid)', 'EXECUTE') then
    raise exception 'a browser role can call a function that takes an actor id';
  end if;

  -- The three that take their actor from auth.uid() ARE reachable, or the
  -- screens would offer buttons nothing can answer.
  if not has_function_privilege('authenticated',
       'public.approve_customer_review_drafts(uuid[])', 'EXECUTE')
  or not has_function_privilege('authenticated',
       'public.approve_customer_review_draft_batch(uuid)', 'EXECUTE')
  or not has_function_privilege('authenticated',
       'public.unbook_customer_review_test_card(uuid)', 'EXECUTE') then
    raise exception 'a browser role cannot call the approval or unbook functions';
  end if;

  -- NO ROLE IS CONSULTED ANYWHERE IN THE NEW FUNCTIONS. Comments are stripped
  -- first so the prose above cannot satisfy or trip the check.
  for v_txt in
    select regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g')
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('create_customer_review_draft_batch',
                         'revise_customer_review_draft_batch',
                         'approve_customer_review_drafts',
                         'approve_customer_review_draft_batch',
                         'unbook_customer_review_test_card')
  loop
    if v_txt ~* '(u\.role|users\.role|''admin'')' then
      raise exception 'a new function consults a role';
    end if;
  end loop;

  -- Nothing writes the new tables from a browser.
  if has_table_privilege('authenticated', 'public.customer_review_draft_batch_revisions', 'INSERT')
  or has_table_privilege('authenticated', 'public.customer_review_draft_batch_revisions', 'UPDATE')
  or has_table_privilege('authenticated', 'public.customer_review_draft_batch_revisions', 'DELETE') then
    raise exception 'a browser role can write the revision trail';
  end if;

  -- No card is left in an unapproved state inside the candidate pool.
  if exists (
    select 1 from public.customer_review_test_cards
     where batch_id is not null and status <> 'pending_approval' and approved_at is null
  ) then
    raise exception 'a generated card left pending_approval without an approval record';
  end if;

  raise notice 'PASS  review-workflow batch approval: pending_approval installed, batch size 8, approval and unbook locked down';
end $$;

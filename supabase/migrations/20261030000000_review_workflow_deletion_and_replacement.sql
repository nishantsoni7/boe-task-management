-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — verifier deletion, and Add-versus-Replace at approval
-- ═══════════════════════════════════════════════════════════════════════════
--
-- TWO CAPABILITIES, and they share one mechanism.
--
--   1. A VERIFIER MAY DELETE a review — one, a selection, or every review in
--      the module — at any stage it has reached.
--   2. WHEN NEWLY GENERATED DRAFTS ARE APPROVED, the verifier chooses whether
--      they JOIN the current available list or REPLACE it.
--
-- Replacement is deletion: the reviews it displaces are soft-deleted by exactly
-- the same write, in the same transaction that approves the new ones, and carry
-- a source of 'replacement' plus the batch that displaced them.
--
-- ─── WHY SOFT ─────────────────────────────────────────────────────────────────
--
-- Ordinary deletion here NEVER removes a row. `deleted_at` is stamped and the
-- row stops existing for every operational purpose — it leaves every list, its
-- direct URL stops resolving, and every workflow action refuses it — while the
-- tombstone and the append-only trail survive for accountability.
--
-- THE REASON IS THE SCREENSHOT. `storage.objects` refuses a direct SQL DELETE
-- (storage.protect_objects_delete), so a hard delete of a card whose screenshot
-- row cascades away would strand the image: unreadable, because the bucket
-- policy resolves through a card that no longer exists, and unfindable, because
-- the row naming its key went with the card. A soft delete keeps the pointer.
--
-- SO NOTHING IN THIS FILE TOUCHES STORAGE, and nothing in it deletes a
-- screenshot row. Deleting a review does not delete the evidence attached to
-- it; it stops the review being usable. Those are different acts and only the
-- first is being authorised here.
--
-- ─── WHAT THIS FILE IS NOT ────────────────────────────────────────────────────
--
-- IT IS NOT THE LEGACY CLEANUP. 20261025000000 permanently deletes the sixteen
-- rehearsal cards seeded before this module was rebuilt, and that is a genuine
-- DELETE with a fingerprint guard. This file is the ordinary operational path
-- that exists afterwards, for reviews the module itself generated.
--
-- THERE IS NO RESTORE. Nothing here can clear `deleted_at`, and the freeze
-- trigger in §5 makes an un-delete unexpressible rather than merely unimplemented.
-- Restoring was not asked for and the existing pattern does not offer one; a
-- half-built undo is worse than none, because it invites the belief that
-- deletion is reversible when the storage side of it is not.
--
-- NO ROLE IS CONSULTED ANYWHERE IN THIS FILE. Every gate is
-- resolve_permission(..., 'customer_review_requests', 'verify'). §9 greps the
-- catalog for `u.role`, `users.role` and `'admin'` across every function this
-- file defines and raises if any of them appears.

-- ── 1. THE TOMBSTONE ────────────────────────────────────────────────────────
--
-- FOUR COLUMNS, and each answers a question the audit has to be able to answer:
-- when, by whom, under which action, and — for a replacement — which batch
-- displaced it. The human sentence lives on the event row rather than being
-- duplicated here; a free-text reason column beside a structured source would
-- be two answers to one question.

alter table public.customer_review_test_cards
  add column if not exists deleted_at     timestamptz,
  add column if not exists deleted_by     uuid references public.users(id),
  add column if not exists deleted_source text,
  add column if not exists replaced_by_batch_id uuid
    references public.customer_review_draft_batches(id);

-- THE SCOPE THE DELETION CAME FROM, which is what makes "who deleted all of
-- them, and when" a query rather than an archaeology exercise.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_deleted_source_check;
alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_deleted_source_check
  check (deleted_source is null or deleted_source in (
    'single',       -- one review, from its own row
    'selected',     -- a selection the verifier ticked
    'all',          -- the whole module, from Delete all reviews
    'replacement'   -- displaced by a newly approved batch
  ));

-- The actor travels with the timestamp and the source, the same shape every
-- other pair on this table has.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_deletion_consistent;
alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_deletion_consistent
  check (
    (deleted_at is null and deleted_by is null and deleted_source is null)
    or (deleted_at is not null and deleted_by is not null and deleted_source is not null)
  );

-- A replacement batch is meaningful only on a row a replacement displaced.
alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_replacement_batch;
alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_replacement_batch
  check (replaced_by_batch_id is null or deleted_source = 'replacement');

-- Every operational read is "this status, not deleted". A partial index on the
-- live rows keeps those reads off the tombstones as the table grows.
create index if not exists customer_review_test_cards_live_status_idx
  on public.customer_review_test_cards (status)
  where deleted_at is null;

-- ── 2. TWO MORE EVENT TYPES ─────────────────────────────────────────────────
--
-- `deleted` and `replaced` are separate types rather than one type with a
-- source column, because they answer different questions: "a verifier removed
-- this" and "a new batch displaced this" are read by different people looking
-- for different things.

alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_card_events_event_type_check;

alter table public.customer_review_test_card_events
  add constraint customer_review_test_card_events_event_type_check
  check (event_type in (
    'generated',
    'revised',
    'approved',
    'booked',
    'unbooked',
    'whatsapp_opened',
    'sent_confirmed',
    'submitted',
    'verified',
    'returned',
    'screenshot_removed',
    'deleted',             -- a verifier deleted this review
    'replaced'             -- a newly approved batch displaced this review
  ));

-- A THIRD ARM, AND IT IS THE ONE THAT CARRIES THE PRIOR STATUS.
--
-- The existing constraint had two shapes: events that MOVE a card name both
-- ends, events that merely happened name neither. Deletion is a third shape —
-- the card does not move, but WHERE IT WAS is the single most important fact
-- about the deletion, because it is what tells a reader whether somebody's
-- in-flight work was thrown away. So `previous_status` is REQUIRED and
-- `new_status` is null: there is no status to move to.
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
    or (event_type in ('deleted', 'replaced')
        and previous_status is not null and new_status is null)
  );

-- ── 3. "MAY THIS PERSON VERIFY?" AS ITS OWN QUESTION ────────────────────────
--
-- The module already had can_use_customer_review_test_cards(); the verify half
-- was only ever asked inline, inside can_view_customer_review_test_card_row().
-- The tombstone branch of the SELECT policy needs it on its own, and a policy
-- that re-derived it inline would be a second copy of an authorization rule.
create or replace function public.can_verify_customer_review_test_cards()
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
      -- THE RESOLVED PERMISSION, AND NOTHING ELSE. No role disjunct, for the
      -- reason the comment on can_use_customer_review_test_cards() gives at
      -- length: a role that short-circuits ahead of the engine makes a Control
      -- Center revocation cosmetic.
      and public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
  );
$$;

comment on function public.can_verify_customer_review_test_cards() is
  'True when the caller is active and the permission engine resolves customer_review_requests.verify for them. No role is consulted.';

revoke execute on function public.can_verify_customer_review_test_cards() from public, anon;
grant  execute on function public.can_verify_customer_review_test_cards() to authenticated;

-- ── 4. A DELETED REVIEW LEAVES THE POOL, AND THE TOMBSTONE STAYS ────────────
--
-- The policy had two doors: the available pool, and a row you hold. Both now
-- require the row to be live, and a THIRD door is added for the tombstone.
--
--   * a candidate cannot read a deleted review by any route. Not in a list, not
--     by typing its id — the two branches that could ever have shown it to them
--     both now require `deleted_at is null`.
--   * a VERIFIER can still read it, which is what makes the tombstone an audit
--     record rather than a row nobody can ever look at again.
--
-- THE OPERATIONAL LISTS FILTER IN THE QUERY AS WELL. This policy stops a
-- candidate reading a tombstone; it deliberately does NOT stop a verifier, so
-- the screens narrow their own reads to live rows. Hiding it from the verifier
-- here would make the audit unreadable to the only people entitled to read it.
drop policy if exists "customer_review_test_cards_select" on public.customer_review_test_cards;

create policy "customer_review_test_cards_select" on public.customer_review_test_cards
  for select to authenticated
  using (
    (
      customer_review_test_cards.status = 'available'
      and customer_review_test_cards.deleted_at is null
      and public.can_use_customer_review_test_cards()
    )
    or (
      customer_review_test_cards.deleted_at is null
      and public.can_view_customer_review_test_card_row(customer_review_test_cards.booked_by)
    )
    or (
      customer_review_test_cards.deleted_at is not null
      and public.can_verify_customer_review_test_cards()
    )
  );

-- ── 5. A DELETED REVIEW IS FROZEN ───────────────────────────────────────────
--
-- THE BACKSTOP, AND IT IS NOT THE PRIMARY GUARD. Every function in §6 refuses a
-- deleted row explicitly, with a sentence a person can read. This trigger is
-- what catches the function somebody adds in a year and forgets to guard, and
-- what makes "a tombstone never changes again" a property of the table rather
-- than a property of the current set of callers.
--
-- It also makes RESTORE UNEXPRESSIBLE. Clearing deleted_at is an UPDATE of a
-- row whose OLD.deleted_at is not null, so it is refused here — there is no
-- code path, present or future, that can bring a deleted review back without
-- first removing this trigger in a migration somebody has to write and justify.
create or replace function public.customer_review_test_cards_freeze_deleted()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'CUSTOMER_REVIEW_TEST_DELETED: % was deleted and can no longer be changed', old.card_ref
    using errcode = '42501',
          detail  = 'A deleted review keeps its tombstone and its audit trail. Nothing can move it, and nothing can restore it.';
  return null;
end;
$$;

-- A TRIGGER FUNCTION IS NOT AN API. Postgres grants EXECUTE to PUBLIC on a new
-- function by default, which would put this on the list of things a browser
-- session can call by name. The trigger itself is unaffected: EXECUTE is
-- checked when a trigger is CREATED, not each time it fires.
revoke execute on function public.customer_review_test_cards_freeze_deleted()
  from public, anon, authenticated;

drop trigger if exists customer_review_test_cards_freeze_deleted
  on public.customer_review_test_cards;

create trigger customer_review_test_cards_freeze_deleted
  before update on public.customer_review_test_cards
  for each row
  when (old.deleted_at is not null)
  execute function public.customer_review_test_cards_freeze_deleted();

-- NO NEW EVIDENCE MAY BE ATTACHED TO A DELETED REVIEW either. The freeze
-- trigger covers the card; a screenshot is a row in another table, so it needs
-- its own refusal. Existing screenshots are untouched — deleting a review does
-- not delete the evidence, and must not.
create or replace function public.customer_review_screenshot_rejects_deleted()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.customer_review_test_cards c
     where c.id = new.card_id and c.deleted_at is not null
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: that review was deleted and cannot take a screenshot'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.customer_review_screenshot_rejects_deleted()
  from public, anon, authenticated;

drop trigger if exists customer_review_screenshot_rejects_deleted
  on public.customer_review_test_card_screenshots;

create trigger customer_review_screenshot_rejects_deleted
  before insert on public.customer_review_test_card_screenshots
  for each row
  execute function public.customer_review_screenshot_rejects_deleted();

-- ── 6. EVERY EXISTING ACTION REFUSES A DELETED REVIEW, IN SO MANY WORDS ─────
--
-- Each function below is the current definition with ONE guard added. They are
-- carried forward in full because that is how this module has always amended a
-- function — 20261023000000 re-created book_ and confirm_sent the same way —
-- and because plpgsql has no way to amend a body in place.
--
-- WHY EXPLICIT GUARDS WHEN §5 ALREADY REFUSES THE WRITE: the trigger fires at
-- the UPDATE, which for several of these is after the authorization checks and
-- in one case (booking) after a conditional UPDATE that would otherwise MATCH a
-- deleted row and take it. An explicit clause refuses at the right moment and
-- with the right sentence.

-- BOOKING IS THE ONE THAT MATTERS MOST. `where status = 'available'` matches a
-- deleted-but-available row: soft deletion does not move the status, it stamps
-- a tombstone. Without `and deleted_at is null` in the claim predicate, a
-- candidate holding a stale list could take a review a verifier had deleted.
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
  -- them — rather than by being an administrator.
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
     and deleted_at is null
  returning * into c;

  if not found then
    -- Missing, deleted and taken are three different facts and the candidate
    -- needs to tell them apart. None of the answers names who took the card.
    if not exists (select 1 from public.customer_review_test_cards where id = p_card_id) then
      raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists'
        using errcode = 'P0002';
    end if;
    if exists (
      select 1 from public.customer_review_test_cards
       where id = p_card_id and deleted_at is not null
    ) then
      raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted that review, so it can no longer be booked'
        using errcode = '23514';
    end if;
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_BOOKED: Somebody else has already booked that test card'
      using errcode = '23514';
  end if;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values
    (p_card_id, 'booked', 'available', 'booked', 'Review booked.', v_uid);

  return c;
end;
$$;

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

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be used'
      using errcode = '42501';
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
  -- built, and this is the only place the two facts are related at all.
  if c.whatsapp_opened_at is null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Open WhatsApp with the test message first'
      using errcode = '23514';
  end if;

  -- Idempotent: confirming twice keeps the FIRST claim.
  if c.sent_confirmed_at is null then
    update public.customer_review_test_cards
       set sent_confirmed_at = now(),
           sent_confirmed_by = v_uid
     where id = p_card_id;

    insert into public.customer_review_test_card_events
      (card_id, event_type, detail, actor_id)
    values
      (p_card_id, 'sent_confirmed',
       'The candidate confirmed by hand that they sent the message.', v_uid);
  end if;

  select * into c from public.customer_review_test_cards where id = p_card_id;
  return c;
end;
$$;

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

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so WhatsApp cannot be opened for it'
      using errcode = '42501';
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

  -- SHAPE-CHECKED, AND THE SHAPE IS THE POINT. Four digits are four digits, and
  -- a phone number is not.
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

  if not exists (
    select 1 from public.users u where u.id = p_actor_id and u.is_active
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  select * into c from public.customer_review_test_cards where id = s.card_id;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That test card no longer exists' using errcode = 'P0002';
  end if;

  -- A DELETED REVIEW'S EVIDENCE IS FROZEN, NOT REMOVED. Ordinary deletion
  -- deliberately leaves the screenshot row and its stored object in place; what
  -- it takes away is the ability to act on the review. Withdrawing the image
  -- afterwards would be a separate decision with a separate authorisation, and
  -- this is not it.
  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review; its screenshot can no longer be removed here'
      using errcode = '42501';
  end if;

  -- REMOVING A SCREENSHOT IS A TESTER ACTION, so it belongs to the tester
  -- HOLDING THE CARD and to nobody else. There is no administrator branch.
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

-- THE DETAIL SCREEN'S GATE. A deleted review's direct URL must behave as
-- unavailable for a candidate; a verifier keeps the tombstone, matching the
-- SELECT policy exactly so the page and the row agree.
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
      and (
        -- A VERIFIER READS IT WHETHER IT IS LIVE OR A TOMBSTONE. Everybody
        -- else reads live rows only.
        public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')
        or (
          c.deleted_at is null
          and (
            c.booked_by = auth.uid()
            or (
              c.status = 'available'
              and public.resolve_permission(auth.uid(), 'customer_review_requests', 'use')
            )
          )
        )
      )
  );
$$;

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

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it cannot be submitted'
      using errcode = '42501';
  end if;

  -- THE TESTER'S OWN CLAIM, and it is not substitutable.
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

  -- REFUSED BEFORE ANY OTHER JUDGEMENT. Submitting, verifying and returning are
  -- all workflow actions, and a deleted review has left the workflow. A
  -- verifier can still READ the tombstone; they cannot move it.
  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be moved'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;

  -- RESOLVED FROM THE PERMISSION ENGINE, NOT FROM THE ROLE.
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
  if p_next_status in ('verified', 'booked') then
    if not v_verify then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Verifying or returning a test needs the Verify permission'
        using errcode = '42501';
    end if;
  else
    -- SUBMITTING IS A TESTER ACTION: the holder, and nobody else.
    if not (v_holder and v_use) then
      raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Only the tester holding this card can submit it'
        using errcode = '42501';
    end if;
  end if;

  if p_next_status = 'submitted' then
    perform public.assert_customer_review_test_card_submittable(p_card_id);
  end if;

  -- A return has to say why.
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
         verification_note = case
           when p_next_status = 'verified' then v_detail
           else c2.verification_note
         end,

         returned_at   = case when p_next_status = 'booked' then now()    else c2.returned_at end,
         returned_by   = case when p_next_status = 'booked' then v_uid    else c2.returned_by end,
         return_reason = case when p_next_status = 'booked' then v_detail else c2.return_reason end
   -- NOTHING IS CLEARED ON A RETURN, and that is the choice rather than an
   -- omission. The append-only trail keeps every submission and every return.
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

  -- LOCKED FIRST, so an unbook racing a send-confirmation is serialised by
  -- Postgres and the second is refused by one of the checks below.
  select * into c from public.customer_review_test_cards where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That review no longer exists' using errcode = 'P0002';
  end if;

  -- A DELETED REVIEW CANNOT BE PUT BACK INTO A POOL IT HAS LEFT. Unbooking
  -- returns a card to 'available', which is precisely the state a deleted
  -- review must never re-enter.
  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review, so it can no longer be unbooked'
      using errcode = '42501';
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

  -- THE POINT OF NO RETURN, ENFORCED IN THE DATABASE.
  if c.sent_confirmed_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_SENT: You confirmed you sent this review, so it can no longer be unbooked'
      using errcode = '23514';
  end if;

  -- A LIVE SCREENSHOT MUST COME OFF FIRST — a privacy rule rather than a
  -- tidiness one. An available review is readable by every `use` holder, and so
  -- are its screenshots.
  select count(*) into v_shots
    from public.customer_review_test_card_screenshots s
   where s.card_id = p_card_id and s.removal_started_at is null;
  if v_shots > 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_READY: Remove the screenshot you attached before unbooking this review'
      using errcode = '23514';
  end if;

  -- ── Back to the approved pool ────────────────────────────────────────────
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

-- REVISION TOUCHES PENDING DRAFTS ONLY, and a deleted draft is not one. The
-- pending set is chosen under a row lock, so adding `deleted_at is null` to
-- that predicate is the whole guard: a deleted draft is not selected, is not
-- counted, and therefore cannot be rewritten.
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
  -- `for update` on the pending, LIVE rows of this batch is what makes "only
  -- pending drafts change" true under concurrency. A verifier approving or
  -- deleting a draft in another tab either commits before this lock is taken —
  -- in which case the row is not selected — or waits behind it and finds the
  -- text already rewritten.
  select array_agg(c.id order by c.card_ref)
    into v_pending
    from (
      select id, card_ref
        from public.customer_review_test_cards
       where batch_id = p_batch_id
         and status = 'pending_approval'
         and deleted_at is null
       order by card_ref
         for update
    ) c;

  v_count := coalesce(array_length(v_pending, 1), 0);

  if v_count = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOTHING_PENDING: Every review in that batch has already been approved or deleted; there is nothing left to revise'
      using errcode = '23514';
  end if;

  if jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the drafts payload is not an array'
      using errcode = '23514';
  end if;

  v_n := jsonb_array_length(p_drafts);

  -- THE COUNT IS RECHECKED HERE, INSIDE THE LOCK, AND A MISMATCH REFUSES
  -- EVERYTHING.
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

    update public.customer_review_test_cards
       set test_title    = v_title,
           test_body     = v_body,
           test_category = coalesce(v_item->>'category', test_category)::text,
           updated_at    = now()
     where id = v_pending[v_i]
       and status = 'pending_approval'
       and deleted_at is null;

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

-- ── 7. DELETION ─────────────────────────────────────────────────────────────
--
-- WHAT THE VERIFIER IS ABOUT TO DO, COUNTED BY STAGE.
--
-- Read-only, `verify`-gated, and it exists so the confirmation can state the
-- consequence in the words that matter — "three of these are booked" — rather
-- than a bare total. The screens cannot compute it themselves: no tab reads
-- `verified` rows, by design, so a client-side count would silently omit them.
create or replace function public.customer_review_deletion_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not public.can_verify_customer_review_test_cards() then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Deleting reviews needs the Verify permission'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
           'total',            count(*),
           'pending_approval', count(*) filter (where status = 'pending_approval'),
           'available',        count(*) filter (where status = 'available'),
           'booked',           count(*) filter (where status = 'booked' and sent_confirmed_at is null),
           'sent',             count(*) filter (where status = 'booked' and sent_confirmed_at is not null),
           'submitted',        count(*) filter (where status = 'submitted'),
           'verified',         count(*) filter (where status = 'verified')
         )
    into v_out
    from public.customer_review_test_cards
   where deleted_at is null;

  return v_out;
end;
$$;

comment on function public.customer_review_deletion_summary() is
  'Counts the live reviews by workflow stage, for the Delete all confirmation. Read-only and requires the resolved verify permission.';

revoke execute on function public.customer_review_deletion_summary() from public, anon;
grant  execute on function public.customer_review_deletion_summary() to authenticated;

-- ONE REVIEW, OR A SELECTION. Atomic over the named ids: if any one of them has
-- already been deleted the whole call is refused and nothing changes, because a
-- partial result of a group nobody chose to split is worse than a refusal the
-- verifier can retry against a refreshed list.
--
-- REPEATED TAPS ARE SAFE. The second call finds the rows already deleted and
-- raises rather than writing a second tombstone over the first — the deletion
-- that happened keeps its original actor and timestamp.
create or replace function public.delete_customer_review_test_cards(
  p_card_ids uuid[],
  p_source   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_ids     uuid[];
  v_asked   integer;
  v_locked  integer;
  v_gone    text;
  v_deleted integer;
  v_out     jsonb;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- `verify`, RESOLVED. No role branch: an administrator deletes because the
  -- engine resolves `verify` for them, and an administrator whose `verify` was
  -- revoked in Control Center is refused here exactly like anybody else.
  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Deleting a review needs the Verify permission'
      using errcode = '42501';
  end if;

  if p_source is null or p_source not in ('single', 'selected') then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_REQUEST: a deletion must say whether it is a single review or a selection'
      using errcode = '23514';
  end if;

  -- Duplicates are a browser sending one id twice, not a request to delete it
  -- twice.
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_card_ids, '{}'::uuid[])) x;
  v_asked := coalesce(array_length(v_ids, 1), 0);

  if v_asked = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_REQUEST: Select at least one review to delete'
      using errcode = '23514';
  end if;
  if p_source = 'single' and v_asked <> 1 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_REQUEST: a single deletion names one review, not %', v_asked
      using errcode = '23514';
  end if;

  -- Locked in id order, so two verifiers deleting overlapping selections queue
  -- rather than deadlock, and so a booking racing a deletion is serialised.
  select count(*) into v_locked from (
    select id from public.customer_review_test_cards
     where id = any(v_ids)
     order by id
       for update
  ) l;

  if v_locked <> v_asked then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: % of the selected reviews no longer exist; nothing was deleted', v_asked - v_locked
      using errcode = 'P0002';
  end if;

  -- RECHECKED AFTER THE LOCK, which is the only place the check means anything.
  select string_agg(card_ref, ', ' order by card_ref) into v_gone
    from public.customer_review_test_cards
   where id = any(v_ids) and deleted_at is not null;

  if v_gone is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_DELETED: % has already been deleted; nothing was changed', v_gone
      using errcode = '23514';
  end if;

  -- THE EVENT IS WRITTEN BEFORE THE TOMBSTONE, because the freeze trigger in §5
  -- refuses any UPDATE of a row that is already deleted, and the trail must
  -- record where the review WAS. previous_status is read from the live row.
  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select id, 'deleted', status, null,
         case
           when status = 'pending_approval'
             then 'Deleted by a verifier while awaiting approval.'
           when status = 'available'
             then 'Deleted by a verifier. It was available and is now withdrawn from the pool.'
           when status = 'booked' and sent_confirmed_at is not null
             then 'Deleted by a verifier after the candidate confirmed they had sent it.'
           when status = 'booked'
             then 'Deleted by a verifier while a candidate was holding it.'
           when status = 'submitted'
             then 'Deleted by a verifier while it was awaiting verification.'
           else 'Deleted by a verifier after it had been verified.'
         end,
         v_uid
    from public.customer_review_test_cards
   where id = any(v_ids);

  update public.customer_review_test_cards
     set deleted_at     = now(),
         deleted_by     = v_uid,
         deleted_source = p_source,
         updated_at     = now()
   where id = any(v_ids)
     and deleted_at is null;

  get diagnostics v_deleted = row_count;

  if v_deleted <> v_asked then
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_DELETED: % of % reviews were deleted while this ran; nothing was changed', v_asked - v_deleted, v_asked
      using errcode = '23514';
  end if;

  select jsonb_build_object(
           'deleted',          count(*),
           'pending_approval', count(*) filter (where status = 'pending_approval'),
           'available',        count(*) filter (where status = 'available'),
           'booked',           count(*) filter (where status = 'booked' and sent_confirmed_at is null),
           'sent',             count(*) filter (where status = 'booked' and sent_confirmed_at is not null),
           'submitted',        count(*) filter (where status = 'submitted'),
           'verified',         count(*) filter (where status = 'verified')
         )
    into v_out
    from public.customer_review_test_cards
   where id = any(v_ids);

  return v_out;
end;
$$;

comment on function public.delete_customer_review_test_cards(uuid[], text) is
  'Soft-deletes one review or a selection, atomically, at any workflow stage. Requires the resolved verify permission. Locks and rechecks every row; a selection containing an already-deleted review is refused whole. Screenshots and storage objects are deliberately left in place.';

revoke execute on function public.delete_customer_review_test_cards(uuid[], text) from public, anon;
grant  execute on function public.delete_customer_review_test_cards(uuid[], text) to authenticated;

-- EVERY LIVE REVIEW, IN ONE TRANSACTION.
--
-- THE SET IS CHOSEN INSIDE THE TRANSACTION rather than sent by the browser, so
-- "all" means what is live NOW — not what was live when the confirmation was
-- drawn. That is what makes the returned counts honest, and it is why this
-- takes no id list and no expected total: a count the browser supplied could
-- only ever be used to refuse a deletion the verifier still wants.
create or replace function public.delete_all_customer_review_test_cards()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_ids uuid[];
  v_n   integer;
  v_out jsonb;
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
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Deleting reviews needs the Verify permission'
      using errcode = '42501';
  end if;

  -- ONE STATEMENT TAKES EVERY LOCK, in id order, so a second verifier pressing
  -- the same button waits here and then finds nothing left to delete rather
  -- than half-deleting the same set. A concurrent booking either commits first
  -- — and its card is deleted in the booked state — or waits and is refused by
  -- the deleted_at guard in book_customer_review_test_card.
  select array_agg(c.id order by c.id) into v_ids
    from (
      select id from public.customer_review_test_cards
       where deleted_at is null
       order by id
         for update
    ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOTHING_TO_DELETE: There are no reviews left to delete'
      using errcode = '23514';
  end if;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select id, 'deleted', status, null,
         'Deleted by a verifier as part of removing every review in the module.',
         v_uid
    from public.customer_review_test_cards
   where id = any(v_ids);

  update public.customer_review_test_cards
     set deleted_at     = now(),
         deleted_by     = v_uid,
         deleted_source = 'all',
         updated_at     = now()
   where id = any(v_ids)
     and deleted_at is null;

  select jsonb_build_object(
           'deleted',          count(*),
           'pending_approval', count(*) filter (where status = 'pending_approval'),
           'available',        count(*) filter (where status = 'available'),
           'booked',           count(*) filter (where status = 'booked' and sent_confirmed_at is null),
           'sent',             count(*) filter (where status = 'booked' and sent_confirmed_at is not null),
           'submitted',        count(*) filter (where status = 'submitted'),
           'verified',         count(*) filter (where status = 'verified')
         )
    into v_out
    from public.customer_review_test_cards
   where id = any(v_ids);

  -- Belt to the lock's braces: the set was locked, so this cannot differ.
  if (v_out->>'deleted')::integer <> v_n then
    raise exception 'CUSTOMER_REVIEW_TEST_ALREADY_DELETED: the set changed while it was being deleted; nothing was changed'
      using errcode = '23514';
  end if;

  return v_out;
end;
$$;

comment on function public.delete_all_customer_review_test_cards() is
  'Soft-deletes every live review in the module, atomically, whatever stage each has reached. The set is chosen under a row lock inside the transaction, so the returned counts are what was actually deleted. Requires the resolved verify permission.';

revoke execute on function public.delete_all_customer_review_test_cards() from public, anon;
grant  execute on function public.delete_all_customer_review_test_cards() to authenticated;

-- ── 8. APPROVAL: ADD, OR REPLACE ────────────────────────────────────────────
--
-- THE CHOICE IS MADE AT APPROVAL, NOT AT GENERATION, and that ordering is the
-- whole design. Asking "replace the list?" when the model returns would make
-- the verifier commit before reading a word of what it wrote; asking at
-- approval means they have read the drafts, possibly revised them, and are
-- deciding about text they have seen.
--
-- REPLACE DISPLACES THE AVAILABLE LIST AND NOTHING ELSE:
--
--   replaced      available, live                        -> soft-deleted
--   untouched     booked / sent / submitted / verified   somebody is working on
--                                                        it, or already did
--   untouched     pending drafts in any batch            not published yet
--   untouched     already-deleted rows                   nothing to do
--
-- The displaced set is computed and locked BEFORE the new drafts are approved,
-- so the reviews being approved in this same call can never displace themselves.
--
-- BOTH SIGNATURES CHANGED, AND THE OLD ONES ARE DROPPED rather than left beside
-- them. Two overloads differing only by a defaulted argument is PGRST203 from
-- PostgREST — it cannot choose — so `p_replace` has no default and the browser
-- always states its choice. A superseded definer function a service-role caller
-- can still reach is not dead code, it is a second door with the old lock on it.

drop function if exists public.approve_customer_review_drafts(uuid[]);
drop function if exists public.approve_customer_review_draft_batch(uuid);

-- The displaced set, deleted and audited. Shared by both approval entry points
-- so "what Replace does" has exactly one definition.
--
-- IT IS NOT SECURITY-DEFINER AND IT IS NOT GRANTED TO ANYBODY. It is an
-- internal helper called only from the two definer functions below, which have
-- already resolved `verify`; making it callable in its own right would be a
-- third door onto the same write.
create or replace function public.customer_review_replace_available(
  p_actor_id uuid,
  p_batch_id uuid
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_n   integer;
begin
  select array_agg(c.id order by c.id) into v_ids
    from (
      select id from public.customer_review_test_cards
       where status = 'available'
         and deleted_at is null
       order by id
         for update
    ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then return 0; end if;

  -- The event first, because the freeze trigger refuses an UPDATE of an
  -- already-deleted row and the trail must name where the review was.
  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select id, 'replaced', status, null,
         'Replaced by a newly approved batch of reviews.',
         p_actor_id
    from public.customer_review_test_cards
   where id = any(v_ids);

  update public.customer_review_test_cards
     set deleted_at           = now(),
         deleted_by           = p_actor_id,
         deleted_source       = 'replacement',
         replaced_by_batch_id = p_batch_id,
         updated_at           = now()
   where id = any(v_ids)
     and deleted_at is null;

  return v_n;
end;
$$;

comment on function public.customer_review_replace_available(uuid, uuid) is
  'Internal helper. Soft-deletes every live available review and records a replaced event naming the batch that displaced it. Called only from the approval functions, which resolve verify first; it is granted to nobody.';

revoke execute on function public.customer_review_replace_available(uuid, uuid) from public, anon, authenticated;

-- A SELECTION, APPROVED AS A SET.
--
-- ATOMIC, OR NOTHING. If one member has stopped being pending — because another
-- verifier got there first, because it was deleted, or because the browser is
-- showing a list from five minutes ago — the whole call is refused and nothing
-- moves, replacement included.
create or replace function public.approve_customer_review_drafts(
  p_card_ids uuid[],
  p_replace  boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_ids      uuid[];
  v_asked    integer;
  v_locked   integer;
  v_bad      text;
  v_batches  integer;
  v_batch_id uuid;
  v_replaced integer := 0;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;

  -- ACTIVE, AND HOLDING `verify`. No role branch.
  if not exists (
    select 1 from public.users u
     where u.id = v_uid
       and u.is_active
       and public.resolve_permission(v_uid, 'customer_review_requests', 'verify')
  ) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Approving a review needs the Verify permission'
      using errcode = '42501';
  end if;

  if p_replace is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: an approval must say whether it adds to the list or replaces it'
      using errcode = '23514';
  end if;

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

  -- RECHECKED AFTER THE LOCK. A deleted draft fails this too: deletion does not
  -- move the status, so the clause names both conditions.
  select string_agg(card_ref, ', ' order by card_ref) into v_bad
    from public.customer_review_test_cards
   where id = any(v_ids)
     and (status <> 'pending_approval' or deleted_at is not null);

  if v_bad is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_PENDING: % is no longer awaiting approval; nothing was approved', v_bad
      using errcode = '23514';
  end if;

  -- ── The replacement, BEFORE the approval ─────────────────────────────────
  --
  -- Order is load-bearing. Displacing the available list after approving would
  -- delete the reviews this call has just published; doing it first means the
  -- displaced set cannot contain them.
  if p_replace then
    -- WHICH BATCH DISPLACED THEM has to be a single answer for the tombstone to
    -- mean anything. Selection is scoped to one batch in the UI; this is the
    -- database refusing to record a half-truth if that ever stops being so.
    -- array_agg rather than min(): THERE IS NO min(uuid) IN POSTGRES, and the
    -- first version of this line used one. It parsed, it read correctly, and it
    -- failed at run time the first time a Replace was executed — which is the
    -- whole argument for the disposable-database assertions existing beside the
    -- text audit.
    select count(distinct batch_id), (array_agg(distinct batch_id))[1]
      into v_batches, v_batch_id
      from public.customer_review_test_cards
     where id = any(v_ids);

    if v_batches > 1 then
      raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: a replacement must come from one batch; the selection spans %', v_batches
        using errcode = '23514';
    end if;

    v_replaced := public.customer_review_replace_available(v_uid, v_batch_id);
  end if;

  update public.customer_review_test_cards
     set status      = 'available',
         approved_at = now(),
         approved_by = v_uid,
         updated_at  = now()
   where id = any(v_ids)
     and status = 'pending_approval'
     and deleted_at is null;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select id, 'approved', 'pending_approval', 'available',
         case when p_replace
           then 'Approved, replacing the reviews that were available. It is now available for a candidate to book.'
           else 'Approved. The review is now available for a candidate to book.'
         end,
         v_uid
    from public.customer_review_test_cards
   where id = any(v_ids);

  return jsonb_build_object('approved', v_asked, 'replaced', v_replaced);
end;
$$;

comment on function public.approve_customer_review_drafts(uuid[], boolean) is
  'Approves a selected set of pending drafts atomically. With p_replace, the reviews currently available are soft-deleted in the same transaction and stamped with the batch that displaced them; booked, sent, submitted, verified and pending rows are never touched. Requires the resolved verify permission. Returns {approved, replaced}.';

revoke execute on function public.approve_customer_review_drafts(uuid[], boolean) from public, anon;
grant  execute on function public.approve_customer_review_drafts(uuid[], boolean) to authenticated;

-- Everything still pending in one batch. The SET IS CHOSEN INSIDE THE
-- TRANSACTION, so "approve all pending" means what is pending now.
create or replace function public.approve_customer_review_draft_batch(
  p_batch_id uuid,
  p_replace  boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_ids      uuid[];
  v_n        integer;
  v_replaced integer := 0;
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

  if p_replace is null then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: an approval must say whether it adds to the list or replaces it'
      using errcode = '23514';
  end if;

  select array_agg(c.id order by c.id) into v_ids
    from (
      select id from public.customer_review_test_cards
       where batch_id = p_batch_id
         and status = 'pending_approval'
         and deleted_at is null
       order by id
         for update
    ) c;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception 'CUSTOMER_REVIEW_TEST_NOTHING_PENDING: Nothing in that batch is awaiting approval'
      using errcode = '23514';
  end if;

  -- BEFORE the approval, for the reason the selection function gives.
  if p_replace then
    v_replaced := public.customer_review_replace_available(v_uid, p_batch_id);
  end if;

  update public.customer_review_test_cards
     set status      = 'available',
         approved_at = now(),
         approved_by = v_uid,
         updated_at  = now()
   where id = any(v_ids)
     and status = 'pending_approval'
     and deleted_at is null;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  select unnest(v_ids), 'approved', 'pending_approval', 'available',
         case when p_replace
           then 'Approved with the rest of the batch, replacing the reviews that were available.'
           else 'Approved with the rest of the batch. The review is now available for a candidate to book.'
         end,
         v_uid;

  return jsonb_build_object('approved', v_n, 'replaced', v_replaced);
end;
$$;

comment on function public.approve_customer_review_draft_batch(uuid, boolean) is
  'Approves every still-pending draft in one batch, atomically. With p_replace, the reviews currently available are soft-deleted in the same transaction. The set is chosen under a row lock, so it is what is pending now. Returns {approved, replaced}.';

revoke execute on function public.approve_customer_review_draft_batch(uuid, boolean) from public, anon;
grant  execute on function public.approve_customer_review_draft_batch(uuid, boolean) to authenticated;

-- ── 9. WHAT THIS FILE CLAIMS, EXECUTED ──────────────────────────────────────
--
-- Assertions rather than prose. Each one fails the migration rather than
-- letting a broken promise reach production.

do $$
declare
  v_src  text;
  v_name text;
begin
  -- ── NO ROLE IS CONSULTED, ANYWHERE IN THIS FILE'S FUNCTIONS ──────────────
  --
  -- The grep is over the catalog, not over this file, so it reads what was
  -- actually installed. `'admin'` is included because a literal role name in a
  -- predicate is the shape the earlier bug took.
  for v_name, v_src in
    select p.proname, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'can_verify_customer_review_test_cards',
         'customer_review_deletion_summary',
         'delete_customer_review_test_cards',
         'delete_all_customer_review_test_cards',
         'customer_review_replace_available',
         'approve_customer_review_drafts',
         'approve_customer_review_draft_batch',
         'book_customer_review_test_card',
         'unbook_customer_review_test_card',
         'transition_customer_review_test_card',
         'confirm_customer_review_test_card_sent',
         'record_customer_review_test_card_whatsapp_opened',
         'begin_customer_review_test_screenshot_removal',
         'can_view_customer_review_test_card',
         'assert_customer_review_test_card_submittable',
         'revise_customer_review_draft_batch'
       )
  loop
    if v_src ~ 'u\.role|users\.role|''admin''' then
      raise exception 'ROLE BYPASS: %() consults a role', v_name;
    end if;
  end loop;

  -- ── THE RETIRED SIGNATURES ARE GONE, NOT SHADOWED ────────────────────────
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'approve_customer_review_drafts'
       and pg_get_function_identity_arguments(p.oid) = 'uuid[]'
  ) then
    raise exception 'the one-argument approve_customer_review_drafts is still callable';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'approve_customer_review_draft_batch'
       and pg_get_function_identity_arguments(p.oid) = 'uuid'
  ) then
    raise exception 'the one-argument approve_customer_review_draft_batch is still callable';
  end if;

  -- ── EVERY WORKFLOW FUNCTION NAMES deleted_at ─────────────────────────────
  --
  -- The explicit half of the guard. §5's trigger is the backstop; this asserts
  -- that each function refuses on its own terms rather than relying on it.
  for v_name in
    select unnest(array[
      'book_customer_review_test_card',
      'unbook_customer_review_test_card',
      'transition_customer_review_test_card',
      'confirm_customer_review_test_card_sent',
      'record_customer_review_test_card_whatsapp_opened',
      'begin_customer_review_test_screenshot_removal',
      'assert_customer_review_test_card_submittable',
      'revise_customer_review_draft_batch',
      'approve_customer_review_drafts',
      'approve_customer_review_draft_batch',
      'can_view_customer_review_test_card'
    ])
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_name
         and p.prosrc like '%deleted_at%'
    ) then
      raise exception 'GUARD MISSING: %() does not mention deleted_at', v_name;
    end if;
  end loop;

  -- ── THE FREEZE TRIGGER EXISTS AND IS CONDITIONAL ─────────────────────────
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'customer_review_test_cards'
       and t.tgname = 'customer_review_test_cards_freeze_deleted'
       and not t.tgisinternal
  ) then
    raise exception 'the freeze trigger is missing';
  end if;
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
     where c.relname = 'customer_review_test_card_screenshots'
       and t.tgname = 'customer_review_screenshot_rejects_deleted'
       and not t.tgisinternal
  ) then
    raise exception 'the screenshot trigger is missing';
  end if;

  -- ── THE POLICY HIDES DELETED ROWS FROM CANDIDATES ────────────────────────
  select pg_get_expr(pol.polqual, pol.polrelid) into v_src
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
   where c.relname = 'customer_review_test_cards'
     and pol.polname = 'customer_review_test_cards_select';

  if v_src is null then
    raise exception 'customer_review_test_cards_select is missing';
  end if;
  if v_src not like '%deleted_at%' then
    raise exception 'customer_review_test_cards_select does not filter deleted rows';
  end if;
  if v_src not like '%can_verify_customer_review_test_cards%' then
    raise exception 'customer_review_test_cards_select does not gate the tombstone on verify';
  end if;

  -- ── STILL NO WRITE POLICY OF ANY KIND ────────────────────────────────────
  --
  -- The module's central structural claim: nothing holding a browser session
  -- can INSERT, UPDATE or DELETE a card. Deletion is a definer function, not a
  -- new policy, and this is what proves it stayed that way.
  if exists (
    select 1 from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
     where c.relname = 'customer_review_test_cards'
       and pol.polcmd <> 'r'
  ) then
    raise exception 'a write policy appeared on customer_review_test_cards';
  end if;

  -- ── NOTHING HERE TOUCHES STORAGE ─────────────────────────────────────────
  --
  -- Ordinary deletion must never remove a stored object or a screenshot row.
  for v_name, v_src in
    select p.proname, p.prosrc
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'delete_customer_review_test_cards',
         'delete_all_customer_review_test_cards',
         'customer_review_replace_available'
       )
  loop
    if v_src ~* 'storage\.|delete\s+from' then
      raise exception 'DELETION TOUCHES STORAGE OR DELETES ROWS: %()', v_name;
    end if;
  end loop;

  raise notice 'PASS  review-workflow deletion and replacement';
end $$;

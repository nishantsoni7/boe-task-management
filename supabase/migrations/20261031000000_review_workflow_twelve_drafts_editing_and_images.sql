-- Review Workflow — twelve drafts a batch, a verifier who may correct one
-- before releasing it, and up to four images that travel with the review.
--
-- THREE CHANGES, ONE FILE, because they are one change to the workflow: what a
-- batch contains, what a verifier may do to it before approval, and what goes
-- out with it afterwards. Splitting them would leave a database in which drafts
-- are editable but the count is not yet twelve, which is a state nothing wants.
--
-- WHAT DOES NOT CHANGE, AND IS RE-STATED HERE BECAUSE IT WOULD BE EASY TO LOSE:
--
--   * A draft is still `pending_approval` until a person approves it. Editing
--     one does not approve it, and no path in this file moves a status.
--   * A candidate still cannot see a pending draft, or its images. The SELECT
--     policies are untouched; image rows hang off the card and inherit
--     can_view_customer_review_test_card() exactly as the screenshots do.
--   * Nothing here sends anything. There is no message, no recipient and no
--     outbound call in this file, and attaching an image does not create one.
--   * The generation claim, the request key and batch-level idempotence are
--     untouched. This file changes what a valid batch SIZE is, not how a batch
--     is claimed.

-- ═══ 1. TWELVE ═════════════════════════════════════════════════════════════
--
-- WHY `NOT VALID`, AND IT IS THE MOST IMPORTANT DECISION IN THIS FILE.
--
-- `add constraint ... check (card_count = 12)` validates every existing row as
-- it is added. Every batch generated before today holds eight, so the plain
-- form would either fail outright or — if those rows were rewritten to satisfy
-- it — falsify the historical record of what those batches actually contained.
--
-- NOT VALID enforces the rule on every INSERT and UPDATE from now on and asks
-- nothing of the rows already there. That is exactly the requirement: a newly
-- generated batch must hold twelve, and an eight-draft batch from last week
-- stays as it is, stays legal, and stays readable.
--
-- The consequence, said plainly: an eight-draft batch row can no longer be
-- UPDATED without failing this check. That is acceptable and arguably right — a
-- batch row is a record of what a model produced, and nothing updates one.

alter table public.customer_review_draft_batches
  drop constraint if exists customer_review_draft_batches_card_count_check;

alter table public.customer_review_draft_batches
  add constraint customer_review_draft_batches_card_count_check
  check (card_count = 12) not valid;

alter table public.customer_review_draft_batches
  drop constraint if exists customer_review_draft_batches_expected_count_check;

alter table public.customer_review_draft_batches
  add constraint customer_review_draft_batches_expected_count_check
  check (expected_count = 12 and card_count = expected_count) not valid;

alter table public.customer_review_draft_batches
  alter column expected_count set default 12;

-- WIDENINGS, and these are ordinary. Every value already stored satisfies the
-- new bound, so there is nothing to skip and no reason to skip it.
alter table public.customer_review_draft_batch_revisions
  drop constraint if exists customer_review_draft_batch_revisions_revised_count_check;

alter table public.customer_review_draft_batch_revisions
  add constraint customer_review_draft_batch_revisions_revised_count_check
  check (revised_count between 1 and 12);

alter table public.customer_review_generation_claims
  drop constraint if exists customer_review_generation_claims_result_count_check;

alter table public.customer_review_generation_claims
  add constraint customer_review_generation_claims_result_count_check
  check (result_count is null or result_count between 1 and 12);

-- ── The generator, saying twelve ────────────────────────────────────────────
--
-- Identical to 20261026000000's definition except for the count. Repeated in
-- full rather than patched because plpgsql has no partial redefinition, and a
-- reader comparing the two files should see one number changed rather than have
-- to reconstruct a body from a diff.
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

  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Generating drafts needs the Verify permission'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_review_draft_batch'));

  select id into v_batch_id
    from public.customer_review_draft_batches
   where request_key = p_request_key;
  if v_batch_id is not null then
    return v_batch_id;
  end if;

  -- ── Exactly twelve, all valid ────────────────────────────────────────────
  if jsonb_typeof(p_drafts) <> 'array' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the drafts payload is not an array'
      using errcode = '23514';
  end if;

  v_n := jsonb_array_length(p_drafts);
  if v_n <> 12 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: the batch holds % draft(s), expected exactly 12', v_n
      using errcode = '23514';
  end if;

  insert into public.customer_review_draft_batches
    (generated_by, guidance, model, card_count, expected_count, request_key)
  values (p_actor_id, p_guidance, p_model, 12, 12, p_request_key)
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

    -- pending_approval, NOT available. This one word is the whole of the
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
  'Creates one batch of exactly twelve pending drafts, atomically, keyed by request_key so a repeated request returns the batch that already exists. Requires the resolved verify permission.';

revoke execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid) to service_role;

-- ═══ 2. EDITING A DRAFT, WHILE IT IS STILL A DRAFT ═════════════════════════
--
-- WHAT THIS IS FOR. A model produces twelve drafts and one of them has a phrase
-- the verifier would not put their name to. The choices before today were
-- approve it as written, revise the whole batch against new guidance, or delete
-- it. Correcting one sentence was not among them.
--
-- THE WINDOW IS `pending_approval` AND NOTHING ELSE, and that is the rule this
-- whole section exists to enforce. Once a review is approved a candidate may
-- have read it, booked it, or sent it; text that changes underneath that is
-- text nobody can vouch for afterwards. There is no safe edit workflow for an
-- approved review in this module, so this function refuses one rather than
-- inventing a second, weaker path to the same row.

alter table public.customer_review_test_cards
  add column if not exists draft_edited_at timestamptz;

alter table public.customer_review_test_cards
  add column if not exists draft_edited_by uuid references public.users(id);

alter table public.customer_review_test_cards
  drop constraint if exists customer_review_test_cards_draft_edit_consistent;

-- Both or neither. A timestamp with no actor is an edit nobody is answerable
-- for, which is worse than no record at all.
alter table public.customer_review_test_cards
  add constraint customer_review_test_cards_draft_edit_consistent
  check ((draft_edited_at is null) = (draft_edited_by is null));

-- ── The trail learns two more words ─────────────────────────────────────────
alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_card_events_event_type_check;

alter table public.customer_review_test_card_events
  add constraint customer_review_test_card_events_event_type_check
  check (event_type in (
    'generated',
    'revised',
    'draft_edited',        -- a verifier corrected this draft's words by hand
    'approved',
    'booked',
    'unbooked',
    'whatsapp_opened',
    'sent_confirmed',
    'submitted',
    'verified',
    'returned',
    'screenshot_removed',
    'image_removed',       -- a verifier withdrew an attached review image
    'deleted',
    'replaced'
  ));

-- `draft_edited` and `image_removed` join the arm for events that MERELY
-- HAPPENED: the card does not move, so naming a status either side would be
-- inventing one.
alter table public.customer_review_test_card_events
  drop constraint if exists customer_review_test_events_status_matches_type;

alter table public.customer_review_test_card_events
  add constraint customer_review_test_events_status_matches_type
  check (
    (event_type in ('generated', 'approved', 'booked', 'unbooked',
                    'submitted', 'verified', 'returned')
     and new_status is not null)
    or (event_type in ('revised', 'draft_edited', 'whatsapp_opened',
                       'sent_confirmed', 'screenshot_removed', 'image_removed')
        and new_status is null and previous_status is null)
    or (event_type in ('deleted', 'replaced')
        and previous_status is not null and new_status is null)
  );

-- ── The edit itself ─────────────────────────────────────────────────────────
--
-- THE SAME THREE GATES THE REST OF THE MODULE USES, in the same order: the
-- account is active, the permission is RESOLVED (no role is read), and the row
-- is locked before anything about it is decided.
--
-- IT VALIDATES THE TEXT AGAIN. The route validates first — the same length
-- bounds and the same forbidden patterns a generated draft is held to — and
-- this refuses a telephone number regardless, because
-- create_customer_review_draft_batch() does, and a hand-typed draft may not be
-- held to a lower standard than a generated one.
create or replace function public.edit_customer_review_draft(
  p_card_id  uuid,
  p_title    text,
  p_body     text,
  p_actor_id uuid
)
returns public.customer_review_test_cards
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.customer_review_test_cards%rowtype;
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
begin
  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Editing a draft needs the Verify permission'
      using errcode = '42501';
  end if;

  -- Locked before the status is read, so two verifiers editing one draft
  -- serialise instead of both deciding it was pending and both writing.
  select * into c from public.customer_review_test_cards
   where id = p_card_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That review no longer exists'
      using errcode = 'P0002';
  end if;

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review; its text can no longer be changed'
      using errcode = '42501';
  end if;

  -- THE ONE RULE THIS FUNCTION EXISTS FOR. Approved, booked, submitted and
  -- verified are all refused by this single clause, which is why there is one
  -- clause rather than a list that could acquire an exception later.
  if c.status <> 'pending_approval' then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_PENDING: This review has been approved; its text can no longer be edited'
      using errcode = '42501';
  end if;

  if v_title = '' or v_body = '' then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_DRAFT: a review needs a title and a body'
      using errcode = '23514';
  end if;

  if public.customer_review_contains_phone(v_title)
  or public.customer_review_contains_phone(v_body) then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_DRAFT: a review may not contain a telephone number'
      using errcode = '23514';
  end if;

  -- The column CHECKs on test_title and test_body enforce the length bounds;
  -- they are not repeated here so there is one copy of each number.
  update public.customer_review_test_cards
     set test_title      = v_title,
         test_body       = v_body,
         draft_edited_at = now(),
         draft_edited_by = p_actor_id,
         updated_at      = now()
   where id = p_card_id
   returning * into c;

  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values (p_card_id, 'draft_edited', null, null,
          'A verifier edited this draft before approval.', p_actor_id);

  return c;
end;
$$;

comment on function public.edit_customer_review_draft(uuid, text, text, uuid) is
  'Replaces the title and body of ONE draft that is still pending_approval. Refuses an approved, booked, submitted, verified or deleted review. Requires the resolved verify permission. Does not approve anything and does not move a status.';

revoke execute on function public.edit_customer_review_draft(uuid, text, text, uuid) from public, anon, authenticated;
grant  execute on function public.edit_customer_review_draft(uuid, text, text, uuid) to service_role;

-- ═══ 3. UP TO FOUR IMAGES ON A DRAFT ═══════════════════════════════════════
--
-- REUSING THE BUCKET, DELIBERATELY. `customer-review-test-screenshots` is
-- already private, already limited to 5 MB and to JPEG/PNG/WebP, and its
-- storage SELECT policy already reads ownership out of
-- split_part(name, '/', 1) and defers to can_view_customer_review_test_card().
-- That policy is KIND-AGNOSTIC: it answers "may this person see this card", and
-- that is exactly the right question for a review image too. A second bucket
-- would be a second copy of that policy and a second thing to keep in step.
--
-- REUSING THE METADATA TABLE for the same reason. What separates the two kinds
-- is the `kind` column, the slot, and the two functions below — not the storage.
--
-- FOUR, ENFORCED BY A UNIQUE INDEX RATHER THAN BY A COUNT.
--
-- A route that counts existing rows and then inserts is a read followed by a
-- write: two concurrent uploads both read three and both write a fourth, and
-- the card ends up with five. The module already learned this once — the
-- comment on customer_review_screenshot_one_live_per_card says so — so the
-- fifth image is refused the same way: every review image occupies a SLOT,
-- slots run 0 to 3, and a unique index means two rows cannot hold the same one.
-- The route still counts, because refusing before five megabytes are decoded is
-- kinder; the index is what actually decides.

alter table public.customer_review_test_card_screenshots
  drop constraint if exists customer_review_test_card_screenshots_kind_check;

alter table public.customer_review_test_card_screenshots
  add constraint customer_review_test_card_screenshots_kind_check
  check (kind in ('test_screenshot', 'review_image'));

alter table public.customer_review_test_card_screenshots
  add column if not exists image_slot smallint;

alter table public.customer_review_test_card_screenshots
  drop constraint if exists customer_review_screenshot_slot_range;

alter table public.customer_review_test_card_screenshots
  add constraint customer_review_screenshot_slot_range
  check (image_slot is null or image_slot between 0 and 3);

alter table public.customer_review_test_card_screenshots
  drop constraint if exists customer_review_screenshot_slot_matches_kind;

-- A slot is what makes a review image countable, so a review image must have
-- one and a test screenshot must not. Stated as an equivalence rather than two
-- implications, because the two halves are the same rule.
alter table public.customer_review_test_card_screenshots
  add constraint customer_review_screenshot_slot_matches_kind
  check ((kind = 'review_image') = (image_slot is not null));

-- ── The indexes, rebuilt so the two kinds do not collide ────────────────────
--
-- one_live_per_card was unconditional on card_id. Left alone it would refuse a
-- review image on any card that already had a screenshot, and refuse a second
-- review image on any card at all. It is now what it always meant: ONE TEST
-- SCREENSHOT per card.
drop index if exists public.customer_review_screenshot_one_live_per_card;

create unique index customer_review_screenshot_one_live_per_card
  on public.customer_review_test_card_screenshots (card_id)
  where removal_started_at is null and kind = 'test_screenshot';

-- FOUR SLOTS, AND NO FIFTH. This is the constraint the requirement asks for,
-- and it is a unique index because a fifth upload racing a fourth has to be
-- refused by something that does not read-then-write.
create unique index if not exists customer_review_image_one_live_per_slot
  on public.customer_review_test_card_screenshots (card_id, image_slot)
  where removal_started_at is null and kind = 'review_image';

-- The same-content guard, now scoped by kind, so a screenshot and a review
-- image that happen to be identical bytes are not confused for each other.
drop index if exists public.customer_review_screenshot_unique_live_content;

create unique index customer_review_screenshot_unique_live_content
  on public.customer_review_test_card_screenshots (card_id, kind, content_sha256)
  where removal_started_at is null;

-- ── The removal pair, for review images ─────────────────────────────────────
--
-- Mirrors begin_/finish_customer_review_test_screenshot_removal() step for
-- step. What differs is WHO and WHEN: withdrawing a review image is a
-- VERIFIER's action on a draft they have not yet approved, so it resolves
-- `verify` rather than `use`, and it is refused once the review is approved.
--
-- THE IMAGES SURVIVE APPROVAL. That is the point of refusing here rather than
-- cascading: an approved review keeps the images it was approved with, and
-- nothing in this module deletes them afterwards.
create or replace function public.begin_customer_review_image_removal(
  p_image_id uuid,
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
  select * into s from public.customer_review_test_card_screenshots
   where id = p_image_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_IMAGE_NOT_FOUND: That image is no longer attached'
      using errcode = 'P0002';
  end if;

  -- The screenshot half has its own function, its own permission and its own
  -- window. Sending a screenshot id here would otherwise remove it under the
  -- wrong authorisation entirely.
  if s.kind <> 'review_image' then
    raise exception 'CUSTOMER_REVIEW_IMAGE_NOT_FOUND: That image is no longer attached'
      using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.users u where u.id = p_actor_id and u.is_active) then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;

  select * into c from public.customer_review_test_cards where id = s.card_id;
  if not found then
    raise exception 'CUSTOMER_REVIEW_TEST_NOT_FOUND: That review no longer exists'
      using errcode = 'P0002';
  end if;

  if c.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_TEST_DELETED: A verifier deleted this review; its images can no longer be removed here'
      using errcode = '42501';
  end if;

  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED: Removing a review image needs the Verify permission'
      using errcode = '42501';
  end if;

  -- THE SAME WINDOW AS EDITING. An approved review keeps the images it was
  -- approved with; a candidate may already have shared them.
  if c.status <> 'pending_approval' then
    raise exception 'CUSTOMER_REVIEW_TEST_LOCKED: This review has been approved; its images can no longer be removed'
      using errcode = '42501';
  end if;

  -- Idempotent, so a retry after a failed object deletion converges.
  if s.removal_started_at is null then
    update public.customer_review_test_card_screenshots
       set removal_started_at = now(),
           removal_by = p_actor_id
     where id = p_image_id;
    select * into s from public.customer_review_test_card_screenshots where id = p_image_id;
  end if;

  return s;
end;
$$;

comment on function public.begin_customer_review_image_removal(uuid, uuid) is
  'Marks one review image for removal, after re-checking the verify permission and that the review is still pending approval. Refuses a test screenshot. The object and the row are deleted by the route, in that order.';

revoke execute on function public.begin_customer_review_image_removal(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.begin_customer_review_image_removal(uuid, uuid) to service_role;

create or replace function public.finish_customer_review_image_removal(p_image_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.customer_review_test_card_screenshots%rowtype;
begin
  select * into s from public.customer_review_test_card_screenshots
   where id = p_image_id for update;
  -- Already finished. A retry says so rather than failing, so a caller that
  -- lost its response can converge.
  if not found then return true; end if;

  if s.removal_started_at is null then
    raise exception 'CUSTOMER_REVIEW_IMAGE_BAD_REMOVAL: This image was not marked for removal'
      using errcode = '23514';
  end if;

  delete from public.customer_review_test_card_screenshots where id = p_image_id;
  return true;
end;
$$;

revoke execute on function public.finish_customer_review_image_removal(uuid) from public, anon, authenticated;
grant  execute on function public.finish_customer_review_image_removal(uuid) to service_role;

-- ── The trail, written by the delete trigger ────────────────────────────────
--
-- The existing trigger wrote 'screenshot_removed' for every deleted row. Now
-- that there are two kinds it writes the one that is true, so a reader looking
-- for withdrawn customer-facing images does not have to filter a wording.
create or replace function public.customer_review_test_screenshots_log_removal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.customer_review_test_card_events
    (card_id, event_type, previous_status, new_status, detail, actor_id)
  values (
    old.card_id,
    case when old.kind = 'review_image' then 'image_removed' else 'screenshot_removed' end,
    null, null,
    case when old.kind = 'review_image'
      then format('Review image removed: %s', left(coalesce(old.file_name, 'unnamed'), 120))
      else format('Test screenshot removed: %s', left(coalesce(old.file_name, 'unnamed'), 120))
    end,
    old.removal_by
  );
  return old;
end;
$$;

revoke execute on function public.customer_review_test_screenshots_log_removal()
  from public, anon, authenticated;

-- ═══ 4. APPROVING TWELVE ═══════════════════════════════════════════════════
--
-- The only change is the upper bound. It was 8, which would have refused
-- "Approve all" on a twelve-draft batch outright — the count guard and the
-- batch size are two statements of one number, and raising one without the
-- other breaks the action it exists to protect.
--
-- Copied verbatim from 20261030000000 apart from that bound, for the reason
-- given in §1: plpgsql has no partial redefinition, and a reader comparing the
-- two should see one number changed.

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
  if v_asked > 12 then
    raise exception 'CUSTOMER_REVIEW_TEST_BAD_BATCH: A batch holds twelve reviews; % were selected', v_asked
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
  'Approves a selected set of pending drafts atomically, at most one batch worth (twelve). With p_replace, the reviews currently available are soft-deleted in the same transaction and stamped with the batch that displaced them. Requires the resolved verify permission. Returns {approved, replaced}.';

revoke execute on function public.approve_customer_review_drafts(uuid[], boolean) from public, anon;
grant  execute on function public.approve_customer_review_drafts(uuid[], boolean) to authenticated;

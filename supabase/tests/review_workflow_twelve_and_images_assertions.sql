-- ═══════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261031000000, executed rather than read
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS. twelveDrafts.test.ts, draftEditing.test.ts and
-- reviewImages.test.ts read the SQL text and check that it SAYS the right
-- things. That is worth having and it is not enough: an earlier round of this
-- module shipped a policy defect past hundreds of passing unit tests precisely
-- because nothing executed the SQL. This file runs it.
--
-- It found one. `begin_customer_review_image_removal()` refused to take an
-- image OFF an approved review, and nothing refused putting one ON — a gap no
-- text audit was ever going to reveal, because both halves read correctly on
-- their own. §6 below is the test that found it and now guards the fix.
--
-- WHAT THE HARNESS ASSUMES, AND WHERE IT CAME FROM
-- ------------------------------------------------
-- The runner applies the real prerequisite migrations, then
-- _review_workflow_eight_draft_history_before.sql (an eight-draft batch made by
-- the OLD generator), then the migration under test. So by the time this file
-- runs there is genuine pre-change history to be careful about, which is the
-- only way §1 can mean anything.
--
-- Actors come from that same file: a verifier holding `verify` and not `use`, a
-- tester holding `use` and not `verify`, an employee holding neither, and a
-- DEACTIVATED verifier. Every refusal below names which of them was refused and
-- asserts the SQLSTATE, not merely that something failed — "it errored" is
-- compatible with a typo in the test.
--
-- NOTHING HERE CONTACTS ANYTHING. No provider, no network, no storage service.
-- Image rows are inserted as the owner, which is what the route does with the
-- service-role credential; the bytes those rows describe do not exist and are
-- not needed, because every rule under test is about the row.

\set ON_ERROR_STOP on

-- ─── Helpers ────────────────────────────────────────────────────────────────

-- Run a statement and REQUIRE it to fail with an exact SQLSTATE. Modelled on
-- pg_temp.refused_with in customer_review_test_card_assertions.sql.
create or replace function pg_temp.must_refuse(
  p_sql text, p_sqlstate text, p_marker text, p_label text
)
returns void language plpgsql as $$
declare v_state text; v_msg text;
begin
  begin
    execute p_sql;
    raise exception 'EXPECTED REFUSAL, GOT SUCCESS — %', p_label;
  exception
    when sqlstate 'P0001' then
      if sqlerrm like 'EXPECTED REFUSAL%' then raise; end if;
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if p_sqlstate <> 'P0001' then
        raise exception '% — expected SQLSTATE %, got P0001: %', p_label, p_sqlstate, v_msg;
      end if;
      if position(p_marker in v_msg) = 0 then
        raise exception '% — refused, but not with %: %', p_label, p_marker, v_msg;
      end if;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state <> p_sqlstate then
        raise exception '% — expected SQLSTATE %, got %: %', p_label, p_sqlstate, v_state, v_msg;
      end if;
      if position(p_marker in v_msg) = 0 then
        raise exception '% — refused with % but not carrying %: %', p_label, v_state, p_marker, v_msg;
      end if;
  end;
end $$;

-- Read a table AS somebody, through their own RLS, the way PostgREST would.
create or replace function pg_temp.images_visible_to(p_user uuid, p_card uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n
    from public.customer_review_test_card_screenshots
   where card_id = p_card and kind = 'review_image' and removal_started_at is null;
  reset role;
  return n;
end $$;

create or replace function pg_temp.storage_objects_visible_to(p_user uuid, p_card uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from storage.objects
   where bucket_id = 'customer-review-test-screenshots'
     and split_part(name, '/', 1) = p_card::text;
  reset role;
  return n;
end $$;

-- A batch of n drafts, valid enough that a refusal can only be about the count.
create or replace function pg_temp.drafts(n integer)
returns jsonb language plpgsql as $$
declare v jsonb := '[]'::jsonb;
begin
  for i in 1..n loop
    v := v || jsonb_build_object(
      'title', format('Harness draft %s', i),
      'body',  format('Harness filler long enough to clear the minimum body length. It describes nothing and is not attributed to anybody. Number %s.', i),
      'category', 'restaurant_test');
  end loop;
  return v;
end $$;

-- The fixture identities, named once.
create or replace function pg_temp.who(p_label text)
returns uuid language sql immutable as $$
  select case p_label
    when 'admin'    then 'ffffffff-0000-4000-8000-000000000001'
    when 'tester'   then 'ffffffff-0000-4000-8000-000000000002'
    when 'verifier' then 'ffffffff-0000-4000-8000-000000000004'
    when 'nobody'   then 'ffffffff-0000-4000-8000-000000000005'
    when 'exverif'  then 'ffffffff-0000-4000-8000-000000000007'
  end::uuid $$;

-- ═══ 1. THE HISTORY THE MIGRATION PROMISED NOT TO DISTURB ══════════════════

do $$
declare
  v_batches  integer;
  v_eight    integer;
  v_cards    integer;
  v_approved integer;
  v_pending  integer;
  v_title    text;
begin
  -- The eight-draft batch made by the OLD generator, before this migration ran.
  select count(*) into v_batches from public.customer_review_draft_batches;
  select count(*) into v_eight
    from public.customer_review_draft_batches where card_count = 8 and expected_count = 8;
  if v_batches <> 1 or v_eight <> 1 then
    raise exception 'expected exactly one historical eight-draft batch, found % batch(es) of which % hold eight', v_batches, v_eight;
  end if;
  raise notice 'PASS  1a. the eight-draft batch created before the migration is still there, still saying eight';

  -- AND IT IS STILL READABLE, which is a different claim from still existing.
  select count(*) into v_cards from public.customer_review_test_cards c
    join public.customer_review_draft_batches b on b.id = c.batch_id
   where b.card_count = 8;
  select count(*) into v_approved from public.customer_review_test_cards c
    join public.customer_review_draft_batches b on b.id = c.batch_id
   where b.card_count = 8 and c.status = 'available';
  select count(*) into v_pending from public.customer_review_test_cards c
    join public.customer_review_draft_batches b on b.id = c.batch_id
   where b.card_count = 8 and c.status = 'pending_approval';
  if v_cards <> 8 or v_approved <> 2 or v_pending <> 6 then
    raise exception 'the historical batch reads as %/%/% cards/approved/pending, expected 8/2/6', v_cards, v_approved, v_pending;
  end if;
  raise notice 'PASS  1b. its eight cards still read: two approved, six pending';

  -- Its text is intact. A migration that "kept" a batch but rewrote its drafts
  -- would satisfy every count above.
  select test_title into v_title from public.customer_review_test_cards c
    join public.customer_review_draft_batches b on b.id = c.batch_id
   where b.card_count = 8 order by c.card_ref limit 1;
  if v_title not like 'Historical draft%' then
    raise exception 'the historical drafts were rewritten: title is %', v_title;
  end if;
  raise notice 'PASS  1c. and their text is exactly what the old generator wrote';

  -- The new columns arrived NULL on every historical row rather than defaulted
  -- to something that would claim an edit nobody made.
  if exists (select 1 from public.customer_review_test_cards where draft_edited_at is not null) then
    raise exception 'a historical card claims to have been edited';
  end if;
  raise notice 'PASS  1d. no historical card claims an edit that never happened';
end $$;

do $$
declare r record; n integer := 0;
begin
  -- THE CONSTRAINTS ARE NOT VALID, AND THAT IS THE POINT.
  --
  -- A validated CHECK would have refused to be added at all against the batch
  -- above. If somebody later "tidies" the NOT VALID away, this fails.
  for r in
    select conname, convalidated from pg_constraint
     where conname in ('customer_review_draft_batches_card_count_check',
                       'customer_review_draft_batches_expected_count_check')
  loop
    n := n + 1;
    if r.convalidated then
      raise exception '% is VALIDATED; it would have condemned the eight-draft history', r.conname;
    end if;
  end loop;
  if n <> 2 then
    raise exception 'expected both twelve-constraints, found %', n;
  end if;
  raise notice 'PASS  1e. both twelve-constraints are NOT VALID, so the history stays legal';
end $$;

-- ═══ 2. A NEW BATCH IS EXACTLY TWELVE ══════════════════════════════════════

do $$
declare v_batch uuid; n integer;
begin
  v_batch := public.create_customer_review_draft_batch(
    'Harness guidance for the twelve-draft batch.', 'claude-opus-5',
    pg_temp.drafts(12), pg_temp.who('verifier'),
    'aaaa1212-0000-4000-8000-000000000012'::uuid);
  select count(*) into n from public.customer_review_test_cards where batch_id = v_batch;
  if n <> 12 then
    raise exception 'a twelve-draft batch produced % card(s)', n;
  end if;
  if not exists (select 1 from public.customer_review_draft_batches
                  where id = v_batch and card_count = 12 and expected_count = 12) then
    raise exception 'the batch row does not record twelve';
  end if;
  raise notice 'PASS  2a. twelve drafts are accepted and stored as ONE batch of twelve';

  -- Every one of them lands pending, which is the workflow's safety property.
  if exists (select 1 from public.customer_review_test_cards
              where batch_id = v_batch and status <> 'pending_approval') then
    raise exception 'a newly generated draft was not pending_approval';
  end if;
  raise notice 'PASS  2b. all twelve land in pending_approval, visible to no candidate';
end $$;

do $$
begin
  -- ELEVEN AND THIRTEEN ARE BOTH REFUSED, and nothing is written by either.
  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L::uuid, %L::uuid)',
           'g', 'm', pg_temp.drafts(11)::text, pg_temp.who('verifier'), 'aaaa1111-0000-4000-8000-000000000011'),
    '23514', 'CUSTOMER_REVIEW_TEST_BAD_BATCH', '2c. eleven drafts');
  raise notice 'PASS  2c. eleven drafts are refused';

  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L::uuid, %L::uuid)',
           'g', 'm', pg_temp.drafts(13)::text, pg_temp.who('verifier'), 'aaaa1313-0000-4000-8000-000000000013'),
    '23514', 'CUSTOMER_REVIEW_TEST_BAD_BATCH', '2d. thirteen drafts');
  raise notice 'PASS  2d. thirteen drafts are refused';

  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L::uuid, %L::uuid)',
           'g', 'm', pg_temp.drafts(8)::text, pg_temp.who('verifier'), 'aaaa0808-0000-4000-8000-000000000008'),
    '23514', 'CUSTOMER_REVIEW_TEST_BAD_BATCH', '2e. eight drafts');
  raise notice 'PASS  2e. and so is EIGHT — the old size is not grandfathered for NEW batches';

  -- Nothing was written by any of the three.
  if exists (select 1 from public.customer_review_draft_batches where card_count <> 12 and card_count <> 8) then
    raise exception 'a refused batch left a row behind';
  end if;
  raise notice 'PASS  2f. all three refusals wrote nothing';
end $$;

do $$
declare v_a uuid; v_b uuid;
begin
  -- The request key still makes a repeat a no-op rather than a second batch.
  v_a := public.create_customer_review_draft_batch(
    'Repeat guidance.', 'claude-opus-5', pg_temp.drafts(12),
    pg_temp.who('verifier'), 'aaaa9999-0000-4000-8000-000000000099'::uuid);
  v_b := public.create_customer_review_draft_batch(
    'Repeat guidance.', 'claude-opus-5', pg_temp.drafts(12),
    pg_temp.who('verifier'), 'aaaa9999-0000-4000-8000-000000000099'::uuid);
  if v_a <> v_b then
    raise exception 'one request key produced two batches: % and %', v_a, v_b;
  end if;
  raise notice 'PASS  2g. one request key still produces one batch, at twelve as at eight';
end $$;

do $$
begin
  -- Generation still needs `verify`, and the count change did not loosen it.
  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L::uuid, %L::uuid)',
           'g', 'm', pg_temp.drafts(12)::text, pg_temp.who('tester'), 'aaaa7777-0000-4000-8000-000000000077'),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '2h. a `use` holder generating');
  raise notice 'PASS  2h. generation still needs `verify`; a `use` holder is refused';

  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L::uuid, %L::uuid)',
           'g', 'm', pg_temp.drafts(12)::text, pg_temp.who('exverif'), 'aaaa6666-0000-4000-8000-000000000066'),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '2i. a deactivated verifier generating');
  raise notice 'PASS  2i. and a DEACTIVATED verifier is refused too';
end $$;

-- ═══ 3. APPROVAL TAKES A FULL BATCH OF TWELVE ══════════════════════════════

do $$
declare v_batch uuid; v_ids uuid[]; v_result jsonb;
begin
  select id into v_batch from public.customer_review_draft_batches
   where card_count = 12 order by generated_at limit 1;
  select array_agg(id) into v_ids from public.customer_review_test_cards
   where batch_id = v_batch and status = 'pending_approval';

  if array_length(v_ids, 1) <> 12 then
    raise exception 'expected twelve pending drafts to approve, found %', array_length(v_ids, 1);
  end if;

  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', pg_temp.who('verifier'), 'role', 'authenticated')::text);
  v_result := public.approve_customer_review_drafts(v_ids, false);
  set local request.jwt.claims = '';

  if (v_result->>'approved')::integer <> 12 then
    raise exception 'approving twelve reported %', v_result->>'approved';
  end if;
  if exists (select 1 from public.customer_review_test_cards
              where batch_id = v_batch and status <> 'available') then
    raise exception 'not every draft in the batch became available';
  end if;
  raise notice 'PASS  3a. all TWELVE are approved in one call — the old bound of eight would have refused this';
end $$;

do $$
declare v_ids uuid[];
begin
  -- Thirteen is still refused, so the bound moved rather than disappearing.
  select array_agg(id) into v_ids from (
    select id from public.customer_review_test_cards limit 13) t;
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', pg_temp.who('verifier'), 'role', 'authenticated')::text);
  perform pg_temp.must_refuse(
    format('select public.approve_customer_review_drafts(%L::uuid[], false)', v_ids),
    '23514', 'CUSTOMER_REVIEW_TEST_BAD_BATCH', '3b. approving thirteen');
  set local request.jwt.claims = '';
  raise notice 'PASS  3b. thirteen is still refused; the bound moved rather than went away';
end $$;

-- ═══ 4. EDITING A DRAFT ════════════════════════════════════════════════════

do $$
declare v_card uuid; c record; v_events integer;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;

  select * into c from public.edit_customer_review_draft(
    v_card, 'A corrected title',
    'A corrected body, comfortably longer than the minimum the column requires, and carrying nothing forbidden.',
    pg_temp.who('verifier'));

  if c.test_title <> 'A corrected title' then
    raise exception 'the title was not written: %', c.test_title;
  end if;
  raise notice 'PASS  4a. a verifier edits a pending draft, and the new text is stored';

  -- THE STATUS DID NOT MOVE. The single most important claim about this
  -- function: saving is not approving.
  if c.status <> 'pending_approval' then
    raise exception 'editing moved the status to %', c.status;
  end if;
  if c.approved_at is not null or c.approved_by is not null then
    raise exception 'editing stamped an approval';
  end if;
  raise notice 'PASS  4b. SAVING IS NOT APPROVING — the status is untouched and no approval was stamped';

  if c.draft_edited_at is null or c.draft_edited_by <> pg_temp.who('verifier') then
    raise exception 'the edit was not attributed';
  end if;
  raise notice 'PASS  4c. the edit is attributed to the person who made it';

  select count(*) into v_events from public.customer_review_test_card_events
   where card_id = v_card and event_type = 'draft_edited';
  if v_events <> 1 then
    raise exception 'expected one draft_edited event, found %', v_events;
  end if;
  raise notice 'PASS  4d. and it is written to the append-only trail as draft_edited';
end $$;

do $$
declare v_card uuid;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;

  -- The text is held to the rules a GENERATED draft is held to.
  perform pg_temp.must_refuse(
    format('select public.edit_customer_review_draft(%L::uuid, %L, %L, %L::uuid)',
           v_card, 'Ring us', 'Please ring 020 7946 0000 about the seating we supplied to your restaurant.', pg_temp.who('verifier')),
    '23514', 'CUSTOMER_REVIEW_TEST_BAD_DRAFT', '4e. a telephone number');
  raise notice 'PASS  4e. a telephone number is refused, from a verifier as from a model';

  perform pg_temp.must_refuse(
    format('select public.edit_customer_review_draft(%L::uuid, %L, %L, %L::uuid)',
           v_card, '   ', 'A body comfortably longer than the minimum the column requires.', pg_temp.who('verifier')),
    '23514', 'CUSTOMER_REVIEW_TEST_BAD_DRAFT', '4f. an empty title');
  raise notice 'PASS  4f. an empty title is refused';

  -- THE LENGTH BOUNDS ARE THE COLUMN'S, NOT THE FUNCTION'S, and the refusal
  -- names the column constraint rather than one of the function's own markers.
  -- That is deliberate: edit_customer_review_draft() does not restate the
  -- column's minimum and maximum (40 and, as of 20261114000000, 1800), so
  -- there is exactly one copy of each number and this is what enforcing it
  -- looks like from outside.
  perform pg_temp.must_refuse(
    format('select public.edit_customer_review_draft(%L::uuid, %L, %L, %L::uuid)',
           v_card, 'A title', 'too short', pg_temp.who('verifier')),
    '23514', 'customer_review_test_cards_test_body_check', '4g. a body under the column minimum');
  raise notice 'PASS  4g. a body under the column minimum is refused by the column CHECK itself';
end $$;

-- ═══ 5. WHO MAY EDIT, AND WHEN ═════════════════════════════════════════════

do $$
declare v_card uuid; v_approved uuid; v_before text;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;

  perform pg_temp.must_refuse(
    format('select public.edit_customer_review_draft(%L::uuid, %L, %L, %L::uuid)',
           v_card, 'Tester title', 'A body comfortably longer than the minimum the column requires.', pg_temp.who('tester')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '5a. a `use` holder editing');
  raise notice 'PASS  5a. `use` is not enough — a tester cannot edit a draft';

  perform pg_temp.must_refuse(
    format('select public.edit_customer_review_draft(%L::uuid, %L, %L, %L::uuid)',
           v_card, 'Nobody title', 'A body comfortably longer than the minimum the column requires.', pg_temp.who('nobody')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '5b. an unpermissioned employee editing');
  raise notice 'PASS  5b. an employee holding neither permission cannot edit';

  perform pg_temp.must_refuse(
    format('select public.edit_customer_review_draft(%L::uuid, %L, %L, %L::uuid)',
           v_card, 'Ex title', 'A body comfortably longer than the minimum the column requires.', pg_temp.who('exverif')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '5c. a deactivated verifier editing');
  raise notice 'PASS  5c. a DEACTIVATED verifier cannot edit, `verify` notwithstanding';

  -- ── AND THE WINDOW CLOSES AT APPROVAL ──────────────────────────────────
  select id, test_title into v_approved, v_before from public.customer_review_test_cards
   where status = 'available' limit 1;

  perform pg_temp.must_refuse(
    format('select public.edit_customer_review_draft(%L::uuid, %L, %L, %L::uuid)',
           v_approved, 'Rewritten after approval', 'A body comfortably longer than the minimum the column requires.', pg_temp.who('verifier')),
    '42501', 'CUSTOMER_REVIEW_TEST_NOT_PENDING', '5d. editing an APPROVED review');
  raise notice 'PASS  5d. AN APPROVED REVIEW CANNOT BE EDITED, by a verifier or anybody else';

  if (select test_title from public.customer_review_test_cards where id = v_approved) <> v_before then
    raise exception 'the refused edit changed the approved text anyway';
  end if;
  raise notice 'PASS  5e. and the refusal changed nothing';
end $$;

do $$
declare v_card uuid; n integer;
begin
  -- NO CLIENT ROLE MAY UPDATE A CARD AT ALL. The definer function is the only
  -- way text changes, which is what makes its status check the whole boundary
  -- rather than one of two.
  select id into v_card from public.customer_review_test_cards where status = 'available' limit 1;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'customer_review_test_cards' and cmd = 'UPDATE';
  if n <> 0 then
    raise exception 'the card table has % UPDATE policy/policies; a client could rewrite a review', n;
  end if;
  raise notice 'PASS  5f. the card table still has no UPDATE policy for any client role';

  if has_table_privilege('authenticated', 'public.customer_review_test_cards', 'UPDATE') then
    raise exception 'authenticated holds UPDATE on the card table';
  end if;
  raise notice 'PASS  5g. and `authenticated` holds no UPDATE privilege on it either';
end $$;

-- ═══ 6. IMAGES: THE SLOT RULES, AT THE DATABASE ════════════════════════════

do $$
declare v_card uuid; i integer;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;
  delete from public.customer_review_test_card_screenshots where card_id = v_card;

  for i in 0..3 loop
    insert into public.customer_review_test_card_screenshots
      (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
    values (v_card, 'review_image', i,
            v_card || '/review_image/slot' || i || '.jpg', 'slot' || i || '.jpg',
            'image/jpeg', 1024, repeat(i::text, 64), pg_temp.who('verifier'));
  end loop;
  if pg_temp.images_visible_to(pg_temp.who('verifier'), v_card) <> 4 then
    raise exception 'four images were inserted but the verifier cannot see four';
  end if;
  raise notice 'PASS  6a. slots 0, 1, 2 and 3 are all accepted — four images on one review';
end $$;

do $$
declare v_card uuid;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;

  -- A FIFTH IMAGE HAS NOWHERE TO GO. Two different ways of trying, because
  -- there are two different constraints and both have to hold.
  perform pg_temp.must_refuse(
    format($q$insert into public.customer_review_test_card_screenshots
              (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
              values (%L::uuid, 'review_image', 4, %L, 'fifth.jpg', 'image/jpeg', 1024, %L, %L::uuid)$q$,
           v_card, v_card || '/review_image/fifth.jpg', repeat('4', 64), pg_temp.who('verifier')),
    '23514', 'customer_review_screenshot_slot_range', '6b. a fifth image in slot 4');
  raise notice 'PASS  6b. slot 4 does not exist — the range CHECK refuses a fifth place';

  perform pg_temp.must_refuse(
    format($q$insert into public.customer_review_test_card_screenshots
              (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
              values (%L::uuid, 'review_image', 0, %L, 'dupe.jpg', 'image/jpeg', 1024, %L, %L::uuid)$q$,
           v_card, v_card || '/review_image/dupe.jpg', repeat('5', 64), pg_temp.who('verifier')),
    '23505', 'customer_review_image_one_live_per_slot', '6c. a fifth image reusing slot 0');
  raise notice 'PASS  6c. A DUPLICATE LIVE SLOT IS REFUSED BY THE UNIQUE INDEX — this is what stops a fifth image';

  if pg_temp.images_visible_to(pg_temp.who('verifier'), v_card) <> 4 then
    raise exception 'a refused fifth image changed the count';
  end if;
  raise notice 'PASS  6d. and neither refusal added anything';
end $$;

do $$
declare v_card uuid;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;

  -- THE TWO KINDS DO NOT COLLIDE. one_live_per_card was unconditional before
  -- this migration; had it stayed so, this insert would fail.
  insert into public.customer_review_test_card_screenshots
    (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (v_card, 'test_screenshot', v_card || '/test_screenshot/shot.png', 'shot.png',
          'image/png', 2048, repeat('a', 64), pg_temp.who('verifier'));
  raise notice 'PASS  6e. a test screenshot sits alongside four review images without conflict';

  -- ...and one screenshot is still the limit for screenshots.
  perform pg_temp.must_refuse(
    format($q$insert into public.customer_review_test_card_screenshots
              (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
              values (%L::uuid, 'test_screenshot', %L, 'shot2.png', 'image/png', 2048, %L, %L::uuid)$q$,
           v_card, v_card || '/test_screenshot/shot2.png', repeat('b', 64), pg_temp.who('verifier')),
    '23505', 'customer_review_screenshot_one_live_per_card', '6f. a second screenshot');
  raise notice 'PASS  6f. and a SECOND screenshot is still refused — narrowing the index did not weaken it';
end $$;

do $$
declare v_card uuid;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;

  -- A slot is what makes a review image countable, so the two must agree.
  perform pg_temp.must_refuse(
    format($q$insert into public.customer_review_test_card_screenshots
              (card_id, kind, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
              values (%L::uuid, 'review_image', %L, 'noslot.jpg', 'image/jpeg', 1024, %L, %L::uuid)$q$,
           v_card, v_card || '/review_image/noslot.jpg', repeat('c', 64), pg_temp.who('verifier')),
    '23514', 'customer_review_screenshot_slot_matches_kind', '6g. a review image with no slot');
  raise notice 'PASS  6g. a review image without a slot is refused — it would be uncountable';

  perform pg_temp.must_refuse(
    format($q$insert into public.customer_review_test_card_screenshots
              (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
              values (%L::uuid, 'test_screenshot', 2, %L, 'slotted.png', 'image/png', 2048, %L, %L::uuid)$q$,
           v_card, v_card || '/test_screenshot/slotted.png', repeat('d', 64), pg_temp.who('verifier')),
    '23514', 'customer_review_screenshot_slot_matches_kind', '6h. a screenshot holding a slot');
  raise notice 'PASS  6h. and a screenshot may not hold one';
end $$;

-- ═══ 7. REMOVAL, AND RE-UPLOAD INTO THE FREED SLOT ═════════════════════════

do $$
declare v_card uuid; v_img uuid; v_shot uuid;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;
  select id into v_img from public.customer_review_test_card_screenshots
   where card_id = v_card and kind = 'review_image' and image_slot = 1;
  select id into v_shot from public.customer_review_test_card_screenshots
   where card_id = v_card and kind = 'test_screenshot';

  -- Only `verify` may withdraw one.
  perform pg_temp.must_refuse(
    format('select public.begin_customer_review_image_removal(%L::uuid, %L::uuid)', v_img, pg_temp.who('tester')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '7a. a `use` holder removing');
  raise notice 'PASS  7a. a `use` holder cannot remove a review image';

  perform pg_temp.must_refuse(
    format('select public.begin_customer_review_image_removal(%L::uuid, %L::uuid)', v_img, pg_temp.who('nobody')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '7b. an unpermissioned employee removing');
  raise notice 'PASS  7b. nor an employee holding neither permission';

  perform pg_temp.must_refuse(
    format('select public.begin_customer_review_image_removal(%L::uuid, %L::uuid)', v_img, pg_temp.who('exverif')),
    '42501', 'CUSTOMER_REVIEW_TEST_UNAUTHORIZED', '7c. a deactivated verifier removing');
  raise notice 'PASS  7c. nor a DEACTIVATED verifier';

  -- THE IMAGE FUNCTION REFUSES A TEST SCREENSHOT. Sending a screenshot id here
  -- would otherwise withdraw it under the wrong permission entirely.
  perform pg_temp.must_refuse(
    format('select public.begin_customer_review_image_removal(%L::uuid, %L::uuid)', v_shot, pg_temp.who('verifier')),
    'P0002', 'CUSTOMER_REVIEW_IMAGE_NOT_FOUND', '7d. removing a screenshot through the image function');
  raise notice 'PASS  7d. the image function refuses a test screenshot — the two kinds keep their own doors';
end $$;

do $$
declare v_card uuid; v_img uuid; v_live integer;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;
  select id into v_img from public.customer_review_test_card_screenshots
   where card_id = v_card and kind = 'review_image' and image_slot = 1;

  perform public.begin_customer_review_image_removal(v_img, pg_temp.who('verifier'));
  if pg_temp.images_visible_to(pg_temp.who('verifier'), v_card) <> 3 then
    raise exception 'marking did not hide the image from readers';
  end if;
  raise notice 'PASS  7e. a marked image is already gone as far as every reader is concerned';

  -- THE FREED SLOT IS REUSABLE WHILE THE MARKED ROW STILL EXISTS. This is the
  -- property that makes an interrupted removal recoverable rather than a
  -- permanently blocked slot.
  insert into public.customer_review_test_card_screenshots
    (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (v_card, 'review_image', 1, v_card || '/review_image/replacement.jpg', 'replacement.jpg',
          'image/jpeg', 4096, repeat('e', 64), pg_temp.who('verifier'));
  raise notice 'PASS  7f. and slot 1 is immediately reusable, before the removal has even finished';

  perform public.finish_customer_review_image_removal(v_img);
  select count(*) into v_live from public.customer_review_test_card_screenshots
   where card_id = v_card and kind = 'review_image';
  if v_live <> 4 then
    raise exception 'after removal and re-upload the review holds % image rows, expected 4', v_live;
  end if;
  raise notice 'PASS  7g. finishing deletes the row: four images again, one of them the replacement';

  -- The trail names it as an IMAGE removal, not a screenshot one.
  if not exists (select 1 from public.customer_review_test_card_events
                  where card_id = v_card and event_type = 'image_removed') then
    raise exception 'no image_removed event was written';
  end if;
  if exists (select 1 from public.customer_review_test_card_events
              where card_id = v_card and event_type = 'screenshot_removed') then
    raise exception 'a review image removal was logged as a screenshot removal';
  end if;
  raise notice 'PASS  7h. the trail records image_removed, distinctly from screenshot_removed';

  -- Finishing twice is a no-op rather than a failure, so a lost response converges.
  perform public.finish_customer_review_image_removal(v_img);
  raise notice 'PASS  7i. finishing an already-finished removal is a no-op';
end $$;

-- ═══ 8. APPROVAL FREEZES THE IMAGES, AND THEY STAY READABLE ════════════════

do $$
declare v_card uuid; v_img uuid; v_ids uuid[]; v_free integer;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref limit 1;

  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', pg_temp.who('verifier'), 'role', 'authenticated')::text);
  perform public.approve_customer_review_drafts(array[v_card], false);
  set local request.jwt.claims = '';

  if (select status from public.customer_review_test_cards where id = v_card) <> 'available' then
    raise exception 'the card was not approved';
  end if;

  -- ── THE IMAGES SURVIVE APPROVAL ────────────────────────────────────────
  if pg_temp.images_visible_to(pg_temp.who('verifier'), v_card) <> 4 then
    raise exception 'approval lost the images';
  end if;
  raise notice 'PASS  8a. all four images survive approval — approving does not cascade them away';

  -- ── AND CANNOT BE REMOVED AFTERWARDS ───────────────────────────────────
  select id into v_img from public.customer_review_test_card_screenshots
   where card_id = v_card and kind = 'review_image' limit 1;
  perform pg_temp.must_refuse(
    format('select public.begin_customer_review_image_removal(%L::uuid, %L::uuid)', v_img, pg_temp.who('verifier')),
    '42501', 'CUSTOMER_REVIEW_TEST_LOCKED', '8b. removing from an approved review');
  raise notice 'PASS  8b. and cannot be removed once the review is approved';

  -- ── NOR ADDED TO ───────────────────────────────────────────────────────
  --
  -- THE DEFECT THIS FILE FOUND. Removal was refused; addition was not, so an
  -- image could appear on an approved review after the fact and the thing
  -- shared would not be the thing approved. Slot 1's row was deleted above, so
  -- there IS a free slot here — without one this would pass for the wrong
  -- reason, which is exactly how the gap survived the first reading.
  select count(*) into v_free from generate_series(0, 3) g
   where g not in (select image_slot from public.customer_review_test_card_screenshots
                    where card_id = v_card and kind = 'review_image' and removal_started_at is null);
  if v_free = 0 then
    -- Make one, so the assertion tests the status rule and not the slot rule.
    delete from public.customer_review_test_card_screenshots
     where id = (select id from public.customer_review_test_card_screenshots
                  where card_id = v_card and kind = 'review_image' limit 1);
  end if;

  perform pg_temp.must_refuse(
    format($q$insert into public.customer_review_test_card_screenshots
              (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
              values (%L::uuid, 'review_image',
                      (select min(g) from generate_series(0,3) g
                        where g not in (select coalesce(image_slot, -1) from public.customer_review_test_card_screenshots
                                         where card_id = %L::uuid and kind = 'review_image' and removal_started_at is null)),
                      %L, 'sneaked-in.jpg', 'image/jpeg', 1024, %L, %L::uuid)$q$,
           v_card, v_card, v_card || '/review_image/sneaked-in.jpg', repeat('9', 64), pg_temp.who('verifier')),
    '42501', 'CUSTOMER_REVIEW_TEST_LOCKED', '8c. adding to an approved review');
  raise notice 'PASS  8c. AND NO IMAGE CAN BE ADDED TO AN APPROVED REVIEW — the gap this file found, now closed';
end $$;

do $$
declare v_card uuid;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'available'
     and exists (select 1 from public.customer_review_test_card_screenshots s
                  where s.card_id = customer_review_test_cards.id and s.kind = 'review_image')
   limit 1;

  -- ── STILL READABLE, WHICH IS WHAT SHARING NEEDS ────────────────────────
  --
  -- An approved review's images are frozen, not hidden. The person about to
  -- share it has to be able to read them, or the whole feature is pointless.
  if pg_temp.images_visible_to(pg_temp.who('verifier'), v_card) = 0 then
    raise exception 'a verifier cannot read the images of an approved review';
  end if;
  raise notice 'PASS  8d. an approved review''s images stay readable to an authorised reviewer, for sharing';

  if pg_temp.images_visible_to(pg_temp.who('tester'), v_card) = 0 then
    raise exception 'a `use` holder cannot read the images of an APPROVED review they may book';
  end if;
  raise notice 'PASS  8e. and to a candidate who may book it — an approved review is in the pool';

  -- ...but not to somebody with no permission at all.
  if pg_temp.images_visible_to(pg_temp.who('nobody'), v_card) <> 0 then
    raise exception 'an employee with no permission can read a review image';
  end if;
  raise notice 'PASS  8f. and to nobody else — the image rows inherit the card''s own policy';
end $$;

do $$
declare v_card uuid;
begin
  -- A PENDING draft's images are visible to a verifier and to NO candidate,
  -- which is the same rule the draft's text obeys.
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval'
     and exists (select 1 from public.customer_review_test_card_screenshots s
                  where s.card_id = customer_review_test_cards.id and s.kind = 'review_image')
   limit 1;

  if v_card is null then
    -- Give a pending draft an image, so the claim has something to be about.
    select id into v_card from public.customer_review_test_cards
     where status = 'pending_approval' order by card_ref limit 1;
    insert into public.customer_review_test_card_screenshots
      (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
    values (v_card, 'review_image', 0, v_card || '/review_image/pending.jpg', 'pending.jpg',
            'image/jpeg', 1024, repeat('7', 64), pg_temp.who('verifier'));
  end if;

  if pg_temp.images_visible_to(pg_temp.who('verifier'), v_card) = 0 then
    raise exception 'a verifier cannot see a pending draft''s images';
  end if;
  raise notice 'PASS  8g. a verifier sees a pending draft''s images';

  if pg_temp.images_visible_to(pg_temp.who('tester'), v_card) <> 0 then
    raise exception 'A CANDIDATE CAN SEE A PENDING DRAFT''S IMAGES';
  end if;
  raise notice 'PASS  8h. AND A CANDIDATE CANNOT — nothing about a pending draft reaches the pool';
end $$;

-- ═══ 8b. THE DELETE TRIGGER, WHICH THIS MIGRATION REDEFINED ════════════════
--
-- Redefining customer_review_test_screenshots_log_removal() to say
-- `image_removed` meant restating the whole body, and the first attempt dropped
-- two things the original did. Both were caught here and neither by reading the
-- file, so both now have a test.

do $$
declare v_card uuid; v_img uuid; v_events integer;
begin
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref desc limit 1;
  delete from public.customer_review_test_card_screenshots where card_id = v_card;

  insert into public.customer_review_test_card_screenshots
    (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (v_card, 'review_image', 0, v_card || '/review_image/unmarked.jpg', 'unmarked.jpg',
          'image/jpeg', 1024, repeat('1', 64), pg_temp.who('verifier'))
  returning id into v_img;

  -- ── THE ACTOR FALLBACK ─────────────────────────────────────────────────
  --
  -- A row deleted WITHOUT being marked first has a null removal_by, and
  -- actor_id is NOT NULL. A bare `old.removal_by` turns this into a constraint
  -- violation; the coalesce is what keeps it a trail entry.
  delete from public.customer_review_test_card_screenshots where id = v_img;
  select count(*) into v_events from public.customer_review_test_card_events
   where card_id = v_card and event_type = 'image_removed';
  if v_events = 0 then
    raise exception 'deleting an unmarked image wrote no trail entry';
  end if;
  if exists (select 1 from public.customer_review_test_card_events
              where card_id = v_card and event_type = 'image_removed' and actor_id is null) then
    raise exception 'the trail entry has no actor';
  end if;
  raise notice 'PASS  8i. an image deleted without being marked first still writes a trail entry, with an actor';
end $$;

do $$
declare v_card uuid; v_before integer; v_after integer;
begin
  -- ── THE CASCADE GUARD ──────────────────────────────────────────────────
  --
  -- Deleting a card cascades to its images. Without the "is the parent still
  -- there" check the trigger writes a trail entry for a card that is going away
  -- in the same statement, and delete_customer_review_test_cards() — a shipped
  -- feature — fails on any review that ever carried an image.
  select id into v_card from public.customer_review_test_cards
   where status = 'pending_approval' order by card_ref desc limit 1;

  insert into public.customer_review_test_card_screenshots
    (card_id, kind, image_slot, storage_path, file_name, mime_type, byte_size, content_sha256, uploaded_by)
  values (v_card, 'review_image', 0, v_card || '/review_image/doomed.jpg', 'doomed.jpg',
          'image/jpeg', 1024, repeat('2', 64), pg_temp.who('verifier'));

  select count(*) into v_before from public.customer_review_test_cards;
  delete from public.customer_review_test_cards where id = v_card;
  select count(*) into v_after from public.customer_review_test_cards;

  if v_after <> v_before - 1 then
    raise exception 'deleting a card that carried an image did not remove it';
  end if;
  raise notice 'PASS  8j. a card carrying a review image can still be deleted — the cascade guard holds';
end $$;

-- ═══ 9. THE CLIENT ROLE STILL CANNOT WRITE AN IMAGE AT ALL ═════════════════

do $$
declare n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'customer_review_test_card_screenshots'
     and cmd in ('INSERT', 'UPDATE', 'DELETE');
  if n <> 0 then
    raise exception 'the image table has % write policy/policies for a client role', n;
  end if;
  raise notice 'PASS  9a. the image table still has no INSERT, UPDATE or DELETE policy';

  for n in select 1 where has_table_privilege('authenticated', 'public.customer_review_test_card_screenshots', 'INSERT')
                       or has_table_privilege('authenticated', 'public.customer_review_test_card_screenshots', 'DELETE')
  loop
    raise exception 'authenticated holds a write privilege on the image table';
  end loop;
  raise notice 'PASS  9b. and `authenticated` holds no write privilege on it';

  -- The new functions are service-role only, like every other writer here.
  for n in select 1 where has_function_privilege('authenticated', 'public.edit_customer_review_draft(uuid, text, text, uuid)', 'EXECUTE')
                       or has_function_privilege('authenticated', 'public.begin_customer_review_image_removal(uuid, uuid)', 'EXECUTE')
                       or has_function_privilege('authenticated', 'public.finish_customer_review_image_removal(uuid)', 'EXECUTE')
                       or has_function_privilege('anon', 'public.edit_customer_review_draft(uuid, text, text, uuid)', 'EXECUTE')
  loop
    raise exception 'a client role can execute one of the new definer functions directly';
  end loop;
  raise notice 'PASS  9c. no client role may execute edit_ or either image-removal function directly';

  -- The bucket is still private, and still limited.
  if exists (select 1 from storage.buckets
              where id = 'customer-review-test-screenshots' and public) then
    raise exception 'the review image bucket is PUBLIC';
  end if;
  raise notice 'PASS  9d. the bucket the images live in is still private';
end $$;

-- ═══ 10. WHAT THE MIGRATION DID NOT TOUCH ══════════════════════════════════

do $$
declare v_card uuid; n integer;
begin
  -- Booking still works, and still needs `use`. The count and image work had no
  -- business changing the candidate path, and this is the check that says so.
  --
  -- A REVIEW THAT ACTUALLY CARRIES IMAGES, because that is the case the change
  -- could plausibly have broken. Picking any available card would have booked
  -- one with none and proved nothing about images at all.
  select id into v_card from public.customer_review_test_cards
   where status = 'available'
     and exists (select 1 from public.customer_review_test_card_screenshots s
                  where s.card_id = customer_review_test_cards.id
                    and s.kind = 'review_image' and s.removal_started_at is null)
   limit 1;
  if v_card is null then
    raise exception 'no approved review carries an image; 10a/10b would prove nothing';
  end if;

  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', pg_temp.who('tester'), 'role', 'authenticated')::text);
  set local role authenticated;
  perform public.book_customer_review_test_card(v_card);
  reset role;
  set local request.jwt.claims = '';

  if (select status from public.customer_review_test_cards where id = v_card) <> 'booked' then
    raise exception 'booking no longer works';
  end if;
  raise notice 'PASS  10a. a candidate can still book an approved review';

  select count(*) into n from public.customer_review_test_card_screenshots
   where card_id = v_card and kind = 'review_image' and removal_started_at is null;
  if n = 0 then
    raise exception 'booking lost the review images';
  end if;
  raise notice 'PASS  10b. and its % review image(s) survive the booking intact', n;

  -- AND THE TESTER HOLDING IT CAN READ THEM, which is what a share needs.
  if pg_temp.images_visible_to(pg_temp.who('tester'), v_card) <> n then
    raise exception 'the holder cannot read the images of the review they booked';
  end if;
  raise notice 'PASS  10c. and the candidate holding it can read them, which is what sharing needs';
end $$;

do $$
begin
  raise notice '';
  raise notice '══ every assertion in review_workflow_twelve_and_images_assertions.sql passed';
end $$;

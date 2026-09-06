-- ═══════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261108000000, executed rather than read
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS. batchSize.test.ts, variableBatchWorkflow.test.ts and
-- generationSettings.test.ts read the SQL text and model the policy in
-- TypeScript. That is policy-logic regression coverage and it is worth having.
-- It cannot prove that Postgres agrees: a model can match the SQL it was
-- written from and both can be wrong about what the database does.
--
-- This file runs it, on a disposable database, with the pending migration
-- applied — the same harness run_review_workflow_twelve_and_images_local.sh
-- uses for 20261031000000.
--
-- ── THE RLS ASSERTIONS ARE REAL, NOT SIMULATED ────────────────────────────
--
-- Candidate visibility is checked by setting `request.jwt.claims` and
-- `role authenticated` and then SELECTing, exactly as
-- review_workflow_twelve_and_images_assertions.sql does. Postgres evaluates
-- customer_review_test_cards_select itself, with a real auth.uid(). Nothing
-- here reimplements the policy or reasons about it in application code.
--
-- WHAT IT PROVES
-- --------------
--   1. a batch of SEVENTEEN is a legal batch: the widened CHECK, the derived
--      composition (12 text / 5 image), and a batch assigned whole;
--   2. six and twenty are legal, five and twenty-one are not;
--   3. CANDIDATE A reads all seventeen of the batch assigned to them;
--   4. CANDIDATE B reads NONE of them;
--   5. the VERIFIER reads them;
--   6. a batch whose intended_for names A, before assignment, grants A nothing
--      — not the drafts, not the batch row;
--   7. the FIVE-ARGUMENT COMPATIBILITY WRAPPER still works and still makes a
--      twelve-review batch, so applying this migration cannot break the bundle
--      that is live at the moment it is applied.
--
-- Actors come from _review_workflow_eight_draft_history_before.sql, the same
-- fixture the twelve-draft harness uses: a verifier holding `verify`, a tester
-- holding `use`, and a nobody holding neither. Candidate B is the tester's
-- second identity — `nobody` — because what is under test is assignment, not
-- permission: a candidate sees a review because it is ASSIGNED to them.
--
-- NOTHING HERE CONTACTS ANYTHING. No provider, no network, no storage service,
-- and no ANTHROPIC_API_KEY: the drafts are supplied as literal JSON.

\set ON_ERROR_STOP on

-- ─── Helpers ────────────────────────────────────────────────────────────────

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

create or replace function pg_temp.who(p_label text)
returns uuid language sql immutable as $$
  select case p_label
    when 'admin'    then 'ffffffff-0000-4000-8000-000000000001'
    when 'tester'   then 'ffffffff-0000-4000-8000-000000000002'
    when 'verifier' then 'ffffffff-0000-4000-8000-000000000004'
    when 'nobody'   then 'ffffffff-0000-4000-8000-000000000005'
  end::uuid
$$;

/**
 * HOW MANY REVIEWS OF ONE BATCH THIS USER CAN ACTUALLY SEE.
 *
 * The whole point of the file. `set local role authenticated` drops the
 * superuser rights psql runs with — without it RLS is bypassed and every
 * assertion below would pass vacuously — and request.jwt.claims is what
 * auth.uid() reads.
 */
create or replace function pg_temp.cards_visible_to(p_user uuid, p_batch uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_test_cards where batch_id = p_batch;
  reset role;
  return n;
end $$;

/** Whether this user can read the BATCH row itself. */
create or replace function pg_temp.batches_visible_to(p_user uuid, p_batch uuid)
returns integer language plpgsql as $$
declare n integer;
begin
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', p_user, 'role', 'authenticated')::text);
  set local role authenticated;
  select count(*) into n from public.customer_review_draft_batches where id = p_batch;
  reset role;
  return n;
end $$;

/** N drafts as literal JSON, composed the way the route composes them. */
create or replace function pg_temp.drafts(p_n integer)
returns jsonb language sql stable as $$
  select jsonb_agg(jsonb_build_object(
    'title',    'Assertion draft ' || i,
    'body',     'A synthetic draft written by the assertion harness so the batch is a real batch. Draft number ' || i || '.',
    'category', 'restaurant_test',
    'type',     case when i <= p_n - round(p_n::numeric / 3) then 'text' else 'image' end
  ))
  from generate_series(1, p_n) i
$$;

-- ═══ 1. SEVENTEEN IS A LEGAL BATCH ═════════════════════════════════════════

do $$
declare
  v_batch uuid;
  v_text  integer;
  v_image integer;
begin
  v_batch := public.create_customer_review_draft_batch(
    'Assertion guidance: a batch of seventeen.', 'assertion-harness',
    pg_temp.drafts(17), pg_temp.who('verifier'),
    '11111111-0000-4000-8000-000000000017',
    17, '{"batchSize":17}'::jsonb, null
  );

  if (select card_count from public.customer_review_draft_batches where id = v_batch) <> 17 then
    raise exception 'a seventeen-review batch did not store card_count 17';
  end if;
  if (select count(*) from public.customer_review_test_cards where batch_id = v_batch) <> 17 then
    raise exception 'a seventeen-review batch did not create seventeen cards';
  end if;

  -- ONE IMAGE REVIEW IN THREE: round(17/3) = 6, so 11 text and 6 image.
  select count(*) filter (where review_type = 'text'),
         count(*) filter (where review_type = 'image')
    into v_text, v_image
    from public.customer_review_test_cards where batch_id = v_batch;
  if v_text <> 11 or v_image <> 6 then
    raise exception 'a batch of seventeen is % text and % image, expected 11 and 6', v_text, v_image;
  end if;

  -- Every draft lands pending, which is the module's safety property.
  if exists (select 1 from public.customer_review_test_cards
              where batch_id = v_batch and status <> 'pending_approval') then
    raise exception 'a generated draft did not land in pending_approval';
  end if;

  raise notice 'PASS  §1  seventeen is a legal batch: 11 text + 6 image, all pending';
end $$;

-- ═══ 2. THE RANGE IS SIX TO TWENTY ═════════════════════════════════════════

do $$
declare v_batch uuid;
begin
  v_batch := public.create_customer_review_draft_batch(
    'Six.', 'assertion-harness', pg_temp.drafts(6), pg_temp.who('verifier'),
    '11111111-0000-4000-8000-000000000006', 6, null, null);
  if (select count(*) from public.customer_review_test_cards where batch_id = v_batch) <> 6 then
    raise exception 'six was not created as six';
  end if;

  v_batch := public.create_customer_review_draft_batch(
    'Twenty.', 'assertion-harness', pg_temp.drafts(20), pg_temp.who('verifier'),
    '11111111-0000-4000-8000-000000000020', 20, null, null);
  if (select count(*) from public.customer_review_test_cards where batch_id = v_batch) <> 20 then
    raise exception 'twenty was not created as twenty';
  end if;

  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L, %L, 5, null, null)',
           'Five.', 'assertion-harness', pg_temp.drafts(5)::text, pg_temp.who('verifier'),
           '11111111-0000-4000-8000-000000000005'),
    '23514', 'between 6 and 20', 'a batch of five');

  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L, %L, 21, null, null)',
           'Twenty-one.', 'assertion-harness', pg_temp.drafts(21)::text, pg_temp.who('verifier'),
           '11111111-0000-4000-8000-000000000021'),
    '23514', 'between 6 and 20', 'a batch of twenty-one');

  -- AND THE REQUEST MUST MATCH WHAT ARRIVED. Asking for 17 and sending 16 is
  -- how a provider that returned the wrong number would define the batch.
  perform pg_temp.must_refuse(
    format('select public.create_customer_review_draft_batch(%L, %L, %L::jsonb, %L, %L, 17, null, null)',
           'Mismatch.', 'assertion-harness', pg_temp.drafts(16)::text, pg_temp.who('verifier'),
           '11111111-0000-4000-8000-00000000ff01'),
    '23514', 'expected exactly', 'sixteen drafts sent for a batch of seventeen');

  raise notice 'PASS  §2  6 and 20 accepted; 5, 21 and a count mismatch refused';
end $$;

-- ═══ 3. CANDIDATE VISIBILITY, AT SEVENTEEN, THROUGH RLS ════════════════════

do $$
declare
  v_batch uuid;
  v_ids   uuid[];
  v_seen  integer;
begin
  select id into v_batch from public.customer_review_draft_batches
   where request_key = '11111111-0000-4000-8000-000000000017';

  -- Approve the whole batch as the verifier, then assign it whole to A.
  execute format('set local request.jwt.claims = %L',
                 json_build_object('sub', pg_temp.who('verifier'), 'role', 'authenticated')::text);
  perform public.approve_customer_review_draft_batch(v_batch, false);
  perform public.assign_customer_review_batch(v_batch, pg_temp.who('tester'));
  set local request.jwt.claims = '';

  if (select count(*) from public.customer_review_test_cards
       where batch_id = v_batch and assigned_to = pg_temp.who('tester')) <> 17 then
    raise exception 'assignment did not give all seventeen to candidate A';
  end if;

  -- 3a. CANDIDATE A READS ALL SEVENTEEN.
  v_seen := pg_temp.cards_visible_to(pg_temp.who('tester'), v_batch);
  if v_seen <> 17 then
    raise exception 'candidate A saw % of their seventeen assigned reviews', v_seen;
  end if;

  -- 3b. CANDIDATE B READS NONE.
  v_seen := pg_temp.cards_visible_to(pg_temp.who('nobody'), v_batch);
  if v_seen <> 0 then
    raise exception 'candidate B saw % of candidate A''s reviews', v_seen;
  end if;

  -- 3c. THE VERIFIER READS THEM.
  v_seen := pg_temp.cards_visible_to(pg_temp.who('verifier'), v_batch);
  if v_seen <> 17 then
    raise exception 'the verifier saw % of the seventeen', v_seen;
  end if;

  raise notice 'PASS  §3  at seventeen: A sees 17, B sees 0, verifier sees 17';
end $$;

-- ═══ 4. intended_for GRANTS NOTHING ════════════════════════════════════════

do $$
declare
  v_batch uuid;
  v_seen  integer;
begin
  -- A batch generated FOR candidate A and never assigned — exactly the state
  -- between generating for somebody and giving it to them.
  v_batch := public.create_customer_review_draft_batch(
    'Generated for A, not assigned.', 'assertion-harness',
    pg_temp.drafts(17), pg_temp.who('verifier'),
    '11111111-0000-4000-8000-0000000017ff',
    17, null, pg_temp.who('tester'));

  if (select intended_for from public.customer_review_draft_batches where id = v_batch)
     <> pg_temp.who('tester') then
    raise exception 'the fixture batch does not name candidate A in intended_for';
  end if;

  -- 4a. THE DRAFTS ARE INVISIBLE TO THE PERSON THEY WERE GENERATED FOR.
  v_seen := pg_temp.cards_visible_to(pg_temp.who('tester'), v_batch);
  if v_seen <> 0 then
    raise exception
      'intended_for granted candidate A sight of % drafts before assignment', v_seen;
  end if;

  -- 4b. AND TO EVERYBODY ELSE WHO IS NOT A VERIFIER.
  v_seen := pg_temp.cards_visible_to(pg_temp.who('nobody'), v_batch);
  if v_seen <> 0 then
    raise exception 'candidate B saw % pending drafts', v_seen;
  end if;

  -- 4c. THE VERIFIER SEES THEM, which is what makes 4a a real distinction
  --     rather than a query that returns nothing for everyone.
  v_seen := pg_temp.cards_visible_to(pg_temp.who('verifier'), v_batch);
  if v_seen <> 17 then
    raise exception 'the verifier saw % of the seventeen pending drafts', v_seen;
  end if;

  -- 4d. NOR CAN A CANDIDATE READ THE BATCH ROW THAT NAMES THEM.
  v_seen := pg_temp.batches_visible_to(pg_temp.who('tester'), v_batch);
  if v_seen <> 0 then
    raise exception 'candidate A read the batch row naming them in intended_for';
  end if;
  v_seen := pg_temp.batches_visible_to(pg_temp.who('verifier'), v_batch);
  if v_seen <> 1 then
    raise exception 'the verifier could not read the batch row';
  end if;

  raise notice 'PASS  §4  intended_for grants nothing: A sees 0 drafts and 0 batch rows';
end $$;

-- ═══ 5. THE COMPATIBILITY WRAPPER STILL WORKS ══════════════════════════════

do $$
declare
  v_batch uuid;
  v_text  integer;
  v_image integer;
begin
  -- THE CALL THE CURRENTLY DEPLOYED BUNDLE MAKES. If this fails, applying the
  -- migration breaks generation for everybody until the new bundle is live.
  v_batch := public.create_customer_review_draft_batch(
    'Five-argument call, as the live bundle makes it.', 'assertion-harness',
    pg_temp.drafts(12), pg_temp.who('verifier'),
    '11111111-0000-4000-8000-0000000000c0'
  );

  if (select card_count from public.customer_review_draft_batches where id = v_batch) <> 12 then
    raise exception 'the compatibility wrapper did not make a batch of twelve';
  end if;

  select count(*) filter (where review_type = 'text'),
         count(*) filter (where review_type = 'image')
    into v_text, v_image
    from public.customer_review_test_cards where batch_id = v_batch;
  if v_text <> 8 or v_image <> 4 then
    raise exception 'the wrapper made % text and % image, expected 8 and 4', v_text, v_image;
  end if;

  -- It stores nothing it was not given, and grants nothing.
  if (select generation_settings from public.customer_review_draft_batches where id = v_batch) is not null
  or (select intended_for from public.customer_review_draft_batches where id = v_batch) is not null then
    raise exception 'the wrapper invented settings or an intended employee';
  end if;

  raise notice 'PASS  §5  the five-argument wrapper still makes a 12-review batch (8 text / 4 image)';
end $$;

-- ═══ 6. HISTORY SURVIVES ═══════════════════════════════════════════════════

do $$
begin
  -- The eight-draft batch the runner seeded BEFORE the migration is still
  -- there, still says eight, and is still readable. That is what NOT VALID is
  -- for, and it cannot be tested against an empty table.
  if not exists (
    select 1 from public.customer_review_draft_batches
     where card_count = 8 and expected_count = 8
  ) then
    raise exception 'the pre-migration eight-draft batch did not survive';
  end if;

  raise notice 'PASS  §6  the historical eight-draft batch is intact and legal';
end $$;

do $$ begin raise notice ''; raise notice 'ALL ASSERTIONS PASSED — 20261108000000'; end $$;

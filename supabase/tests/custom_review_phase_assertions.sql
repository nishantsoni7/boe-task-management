-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261206000000_customer_review_custom_reapply_and_monthly_rules.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- customMonthlyRules.test.ts and customReviewPhase.test.ts read the SQL text.
-- This runs it, on the bare container run_custom_review_submissions_local.sh
-- builds, after custom_review_submissions_assertions.sql.
--
--   §0  applied               columns, table, enum values, the phase settings row
--   §1  notifications         a submission notifies every active verify holder but
--                             the submitter; a refused submission and a duplicate
--                             notify nobody; the text names person and type
--   §2  the cap               9 → the 10th is accepted; 10 → the 11th is refused
--   §3  the image mix         7 text + 0 image: text refused with the exact sentence,
--                             image accepted; 8 + 1: text refused; 9 + 2: text
--                             refused; 9 + 3: the final text accepted; 7 + 2: text
--                             accepted; a settings change moves the formula
--   §4  reapply               owner only; rejected only; same row, same slot; the
--                             rejection kept in the history; a retry changes and
--                             notifies nothing; reviewers notified as a
--                             reapplication; an image → text change checked
--   §5  the pending count     approval and rejection leave the queue; a reapplication
--                             returns to it
--   §6  credits               text 1 and image 1.5; a reapplied review earns once;
--                             two approvals are provisional, the third qualifies;
--                             nothing negative is posted for a short month
--   §7  a closed month        finalization removes exactly the provisional credits
--                             (no penalty); approving or reapplying into a lapsed
--                             month is refused
--   §8  history visibility    own, verifier, nobody else; append-only
--   §9  booking paused        a candidate cannot book a generated review; a verifier
--                             and a sessionless server call can
--   §10 no repricing          a settings change leaves posted rewards as they were
--
-- ONE TRANSACTION, ROLLED BACK. Refuses to run if public.users holds anybody.
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through run_custom_review_submissions_local.sh.

\set ON_ERROR_STOP on

begin;

-- ─── helpers ────────────────────────────────────────────────────────────────

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- No session: claims are an empty JSON object, so auth.uid() reads null rather
-- than failing to parse '' — the booking guard in §9 calls it.
create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'none', true);
end $$;

-- A session's identity WITHOUT the authenticated role: for a trigger that reads
-- auth.uid() on a table the stub does not grant to authenticated.
create or replace function pg_temp.claims_only(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'none', true);
end $$;

create or replace function pg_temp.must_refuse(p_sql text, p_sqlstate text, p_marker text, p_label text)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception '% — refused, but with SQLSTATE % not %: %', p_label, v_state, p_sqlstate, v_msg;
    end if;
    if position(p_marker in v_msg) = 0 then
      raise exception '% — refused, but not with %: %', p_label, p_marker, v_msg;
    end if;
    raise notice 'PASS  % (% %)', p_label, v_state, p_marker;
    return;
  end;
  raise exception '% — WAS ALLOWED, and must not be', p_label;
end $$;

-- A registration exactly as the upload route makes it, with a unique screenshot.
create or replace function pg_temp.sub(p_actor uuid, p_type text, p_id uuid default gen_random_uuid())
returns uuid language plpgsql as $$
begin
  perform public.create_customer_review_custom_submission(
    p_id, p_actor, p_type, (now() at time zone 'Asia/Kolkata')::date, null,
    p_id::text || '/proof/shot.png', 'shot.png', 'image/png', 2048,
    md5(p_id::text) || md5(p_id::text || 'x')
  );
  return p_id;
end $$;

create or replace function pg_temp.reject_as(p_verifier uuid, p_id uuid, p_reason text)
returns void language plpgsql as $$
begin
  perform pg_temp.act_as(p_verifier);
  perform public.reject_customer_review_custom_submission(p_id, p_reason);
  perform pg_temp.act_as_service();
end $$;

create or replace function pg_temp.approve_as(p_verifier uuid, p_id uuid)
returns jsonb language plpgsql as $$
declare
  v_type text;
  v_amount numeric;
  v jsonb;
begin
  select review_type into v_type from public.customer_review_custom_submissions where id = p_id;
  select case v_type when 'image' then image_review_reward_credits else review_reward_credits end
    into v_amount from public.boe_credit_settings order by created_at desc limit 1;
  perform pg_temp.act_as(p_verifier);
  v := public.approve_customer_review_custom_submission(p_id, v_amount);
  perform pg_temp.act_as_service();
  return v;
end $$;

-- ─── fixtures ────────────────────────────────────────────────────────────────
--   A  admin, use + verify     V  member, use + verify     VI inactive verifier
--   E1…E9 members, use         O  member, no grant

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',     'admin@example.test', 'admin',  'management', true,  false, 'T-ADM'),
  ('b0000000-0000-4000-8000-00000000000b', 'Test Verifier',  'ver@example.test',   'member', 'reviews',    true,  false, 'T-VER'),
  ('b1000000-0000-4000-8000-0000000000b1', 'Gone Verifier',  'gone@example.test',  'member', 'reviews',    false, false, 'T-VGN'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Ashok Choudhary','e1@example.test',    'member', 'sales',      true,  false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Test Two',       'e2@example.test',    'member', 'sales',      true,  false, 'T-002'),
  ('e3000000-0000-4000-8000-0000000000e3', 'Test Three',     'e3@example.test',    'member', 'sales',      true,  false, 'T-003'),
  ('e4000000-0000-4000-8000-0000000000e4', 'Test Four',      'e4@example.test',    'member', 'sales',      true,  false, 'T-004'),
  ('e5000000-0000-4000-8000-0000000000e5', 'Test Five',      'e5@example.test',    'member', 'sales',      true,  false, 'T-005'),
  ('e6000000-0000-4000-8000-0000000000e6', 'Test Six',       'e6@example.test',    'member', 'sales',      true,  false, 'T-006'),
  ('e7000000-0000-4000-8000-0000000000e7', 'Test Seven',     'e7@example.test',    'member', 'sales',      true,  false, 'T-007'),
  ('e8000000-0000-4000-8000-0000000000e8', 'Test Eight',     'e8@example.test',    'member', 'sales',      true,  false, 'T-008'),
  ('e9000000-0000-4000-8000-0000000000e9', 'Test Nine',      'e9@example.test',    'member', 'sales',      true,  false, 'T-009'),
  ('c0000000-0000-4000-8000-00000000000c', 'Test Outsider',  'out@example.test',   'member', 'sales',      true,  false, 'T-OUT');

insert into public.test_permission_grants (user_id, module_key, action_key)
select id, 'customer_review_requests', 'use'
  from public.users where employee_code in ('T-ADM', 'T-VER', 'T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007', 'T-008', 'T-009');
insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('a0000000-0000-4000-8000-00000000000a', 'customer_review_requests', 'verify'),
  ('b0000000-0000-4000-8000-00000000000b', 'customer_review_requests', 'verify'),
  ('b1000000-0000-4000-8000-0000000000b1', 'customer_review_requests', 'verify');

-- ═══ §0. Applied ═════════════════════════════════════════════════════════════

do $$
declare
  s public.boe_credit_settings%rowtype;
begin
  select * into s from public.boe_credit_settings order by created_at desc limit 1;
  assert s.credit_value = 50 and s.review_reward_credits = 1 and s.image_review_reward_credits = 1.5,
    format('§0 the phase row: ₹50, text 1, image 1.5 — got %s, %s, %s', s.credit_value, s.review_reward_credits, s.image_review_reward_credits);
  assert s.minimum_monthly_reviews = 3 and s.max_monthly_review_submissions = 10 and s.minimum_monthly_image_reviews = 3,
    '§0 the phase row: minimum 3, maximum 10, 3 images';
  assert to_regclass('public.customer_review_custom_submission_events') is not null, '§0 the history table exists';
  assert (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
           where t.typname = 'notification_type' and e.enumlabel like 'customer_review_%') = 2, '§0 both notification types';
  raise notice 'PASS  §0 applied: the phase settings row, the history table, the two notification types';
end $$;

-- ═══ §1. Notifications on submission ════════════════════════════════════════

do $$
declare
  v_id uuid := '61000000-0000-4000-8000-000000000061';
  n    public.notifications%rowtype;
begin
  perform pg_temp.sub('e1000000-0000-4000-8000-0000000000e1', 'image', v_id);

  assert (select count(*) from public.notifications where entity_id = v_id) = 2,
    format('§1 two reviewers told (admin + verifier), got %s', (select count(*) from public.notifications where entity_id = v_id));
  assert not exists (select 1 from public.notifications where entity_id = v_id and user_id = 'e1000000-0000-4000-8000-0000000000e1'),
    '§1 the submitter is not told about their own submission';
  assert not exists (select 1 from public.notifications where entity_id = v_id and user_id = 'b1000000-0000-4000-8000-0000000000b1'),
    '§1 an inactive verifier is not told';
  assert not exists (select 1 from public.notifications where entity_id = v_id and user_id = 'e2000000-0000-4000-8000-0000000000e2'),
    '§1 an employee without verify is not told';

  select * into n from public.notifications where entity_id = v_id and user_id = 'b0000000-0000-4000-8000-00000000000b';
  assert n.type::text = 'customer_review_submitted', '§1 type customer_review_submitted';
  assert n.title = 'Ashok Choudhary submitted a custom Image Review for approval.', format('§1 the sentence, got %s', n.title);
  assert n.task_id is null, '§1 task_id is null, so the Task feed cannot claim it';
  assert n.body = (select submission_ref from public.customer_review_custom_submissions where id = v_id), '§1 the body is the reference';
  assert exists (select 1 from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'submitted'),
    '§1 the submitted event is recorded';
  raise notice 'PASS  §1 a submission notifies every active verify holder but the submitter, by name and type';
end $$;

-- A refused submission and a duplicate screenshot notify nobody.
create temporary table notif_before on commit drop as select count(*) as n from public.notifications;
select pg_temp.must_refuse(
  $q$select public.create_customer_review_custom_submission('62000000-0000-4000-8000-000000000062', 'e1000000-0000-4000-8000-0000000000e1', 'text', (now() at time zone 'Asia/Kolkata')::date + 1, null, '62000000-0000-4000-8000-000000000062/proof/a.png', 'a.png', 'image/png', 10, repeat('9', 64))$q$,
  '22023', 'The published date cannot be in the future', '§1 a refused submission');
select pg_temp.must_refuse(
  $q$select public.create_customer_review_custom_submission('63000000-0000-4000-8000-000000000063', 'e1000000-0000-4000-8000-0000000000e1', 'text', (now() at time zone 'Asia/Kolkata')::date, null, '63000000-0000-4000-8000-000000000063/proof/a.png', 'a.png', 'image/png', 10, md5('61000000-0000-4000-8000-000000000061') || md5('61000000-0000-4000-8000-000000000061x'))$q$,
  '23505', 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE', '§1 the same screenshot again');
do $$
begin
  assert (select count(*) from public.notifications) = (select n from notif_before), '§1 neither refusal wrote a notification';
  raise notice 'PASS  §1 a refused submission and a duplicate write no notification';
end $$;

-- ═══ §2. The monthly cap ════════════════════════════════════════════════════

do $$
begin
  -- E2: three images first, then six texts — nine, the image requirement met.
  for i in 1..3 loop perform pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', 'image'); end loop;
  for i in 1..6 loop perform pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', 'text'); end loop;
  assert (select submitted from public.customer_review_custom_month_usage('e2000000-0000-4000-8000-0000000000e2', date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date)) = 9, '§2 nine';
  perform pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', 'text', '64000000-0000-4000-8000-000000000064');
  raise notice 'PASS  §2 nine submitted — the tenth is accepted';
end $$;

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', 'image')$q$,
  '23514', 'You have reached your monthly limit of 10 review submissions.', '§2 ten submitted — the eleventh is refused');

-- ═══ §3. The image mix ══════════════════════════════════════════════════════

do $$
begin
  for i in 1..7 loop perform pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'text'); end loop;
end $$;

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'text')$q$,
  '23514',
  'You have submitted 7 reviews this month. Your remaining 3 reviews must be Image Reviews to complete the monthly requirement of 3 Image Reviews.',
  '§3 7 text + 0 image — a text review is refused, in the brief''s own words');

do $$
begin
  perform pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'image', '65000000-0000-4000-8000-000000000065');
  raise notice 'PASS  §3 7 text + 0 image — an image review is accepted';
end $$;

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'text')$q$,
  '23514', 'Your remaining 2 reviews must be Image Reviews', '§3 8 total + 1 image — a text review is refused');

do $$
begin
  perform pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'image', '66000000-0000-4000-8000-000000000066');
end $$;

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'text')$q$,
  '23514', 'Your remaining 1 review must be an Image Review', '§3 9 total + 2 images — the final slot must be an image');

do $$
begin
  -- E4: six texts and three images — nine, requirement met — then the final text.
  for i in 1..6 loop perform pg_temp.sub('e4000000-0000-4000-8000-0000000000e4', 'text'); end loop;
  for i in 1..3 loop perform pg_temp.sub('e4000000-0000-4000-8000-0000000000e4', 'image'); end loop;
  perform pg_temp.sub('e4000000-0000-4000-8000-0000000000e4', 'text');
  raise notice 'PASS  §3 9 total + 3 images — the final text review is accepted';

  -- E5: two images and five texts — seven — then a text: 2 slots left, 1 image needed.
  for i in 1..2 loop perform pg_temp.sub('e5000000-0000-4000-8000-0000000000e5', 'image'); end loop;
  for i in 1..5 loop perform pg_temp.sub('e5000000-0000-4000-8000-0000000000e5', 'text'); end loop;
  perform pg_temp.sub('e5000000-0000-4000-8000-0000000000e5', 'text');
  raise notice 'PASS  §3 7 total + 2 images — a text review is still accepted (2 slots left, 1 image needed)';
end $$;

-- A settings change moves the formula: at most 5, at least 1 image.
insert into public.boe_credit_settings (
  review_reward_credits, image_review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits,
  minimum_monthly_reviews, max_monthly_review_submissions, minimum_monthly_image_reviews, note, created_at
) values (1, 1.5, 50, 8, 15, 3, 5, 1, 'test-only: 5 and 1', clock_timestamp());

do $$
begin
  for i in 1..4 loop perform pg_temp.sub('e6000000-0000-4000-8000-0000000000e6', 'text'); end loop;
end $$;
select pg_temp.must_refuse(
  $q$select pg_temp.sub('e6000000-0000-4000-8000-0000000000e6', 'text')$q$,
  '23514', 'Your remaining 1 review must be an Image Review to complete the monthly requirement of 1 Image Review.',
  '§3 with 5 / 1: four texts — the fifth must be an image');
do $$
begin
  perform pg_temp.sub('e6000000-0000-4000-8000-0000000000e6', 'image');
  raise notice 'PASS  §3 with 5 / 1 the same formula holds, with no 10 or 3 written into it';
end $$;
select pg_temp.must_refuse(
  $q$select pg_temp.sub('e6000000-0000-4000-8000-0000000000e6', 'image')$q$,
  '23514', 'monthly limit of 5 review submissions', '§3 with 5 / 1: the sixth is over the cap');

-- Back to the phase values for everything below.
insert into public.boe_credit_settings (
  review_reward_credits, image_review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits,
  minimum_monthly_reviews, max_monthly_review_submissions, minimum_monthly_image_reviews, note, created_at
) values (1, 1.5, 50, 8, 15, 3, 10, 3, 'test-only: phase values again', clock_timestamp());

-- ═══ §4. Reapply ════════════════════════════════════════════════════════════

select pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', '64000000-0000-4000-8000-000000000064', 'The screenshot is cropped');

select pg_temp.must_refuse(
  $q$select public.reapply_customer_review_custom_submission('64000000-0000-4000-8000-000000000064', 'e1000000-0000-4000-8000-0000000000e1', 'text', (now() at time zone 'Asia/Kolkata')::date, null, 'mine now', null, null, null, null, null)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER', '§4 nobody reapplies somebody else''s review');
select pg_temp.must_refuse(
  $q$select public.reapply_customer_review_custom_submission('64000000-0000-4000-8000-000000000064', 'c0000000-0000-4000-8000-00000000000c', 'text', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null)$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§4 an employee without use cannot reapply');
select pg_temp.must_refuse(
  $q$select public.reapply_customer_review_custom_submission('64000000-0000-4000-8000-000000000064', 'e2000000-0000-4000-8000-0000000000e2', 'text', (now() at time zone 'Asia/Kolkata')::date, null, null, '61000000-0000-4000-8000-000000000061/proof/x.png', 'x.png', 'image/png', 10, repeat('a', 64))$q$,
  '22023', 'does not belong to this review', '§4 a new screenshot under another submission''s id is refused');

select pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
select pg_temp.must_refuse(
  $q$select public.reapply_customer_review_custom_submission('64000000-0000-4000-8000-000000000064', 'e2000000-0000-4000-8000-0000000000e2', 'text', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null)$q$,
  '42501', 'permission denied', '§4 a browser session cannot call the reapplication');
select pg_temp.act_as_service();

do $$
declare
  v_id   uuid := '64000000-0000-4000-8000-000000000064';
  v      jsonb;
  s      public.customer_review_custom_submissions%rowtype;
  e      public.customer_review_custom_submission_events%rowtype;
  v_ref  text;
  v_sub  timestamptz;
  v_notified integer;
begin
  select submission_ref, submitted_at into v_ref, v_sub from public.customer_review_custom_submissions where id = v_id;

  v := public.reapply_customer_review_custom_submission(
    v_id, 'e2000000-0000-4000-8000-0000000000e2', 'text', (now() at time zone 'Asia/Kolkata')::date,
    'Posted on Google Maps', '  Uploaded the full screenshot  ',
    v_id::text || '/proof/second.png', 'second.png', 'image/png', 4096, repeat('b', 64));

  assert not (v ->> 'already_pending')::boolean, '§4 a first reapplication';
  assert v ->> 'previous_proof_storage_path' = v_id::text || '/proof/shot.png', '§4 the previous proof path is handed back';
  select * into s from public.customer_review_custom_submissions where id = v_id;
  assert s.status = 'pending_verification', '§4 back to Pending Approval';
  assert s.submission_ref = v_ref and s.submitted_at = v_sub, '§4 the SAME row: reference and first submission unchanged';
  assert s.reapplication_count = 1 and s.last_reapplied_at is not null, '§4 counted once';
  assert s.rejection_reason is null and s.rejected_by is null, '§4 the rejection leaves the row';
  assert s.candidate_note = 'Uploaded the full screenshot', '§4 the note is kept, trimmed';
  assert s.proof_storage_path = v_id::text || '/proof/second.png', '§4 the new screenshot is the proof';
  assert (select submitted from public.customer_review_custom_month_usage('e2000000-0000-4000-8000-0000000000e2', date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date)) = 10,
    '§4 still ten slots — the reapplication took none';
  assert (select count(*) from public.customer_review_custom_submissions where submitted_by = 'e2000000-0000-4000-8000-0000000000e2') = 10,
    '§4 no duplicate row';

  select * into e from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'rejected';
  assert e.reason = 'The screenshot is cropped' and e.actor_id = 'b0000000-0000-4000-8000-00000000000b', '§4 the rejection and its reason stay in the history';
  select * into e from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'reapplied';
  assert e.note = 'Uploaded the full screenshot', '§4 the reapplied event carries the note';
  assert e.details -> 'previous' ->> 'rejection_reason' = 'The screenshot is cropped', '§4 … and what was rejected';
  assert (e.details ->> 'proof_replaced')::boolean, '§4 … and that the proof changed';

  -- REGRESSION (20261207000000): the trail runs AFTER the UPDATE, so the count
  -- already includes this reapplication. The first one is attempt 1, not 2.
  assert s.reapplication_count = 1,
    format('§4 regression: the first reapplication leaves reapplication_count = 1, got %s', s.reapplication_count);
  assert (select count(*) from public.customer_review_custom_submission_events
           where submission_id = v_id and event_type = 'reapplied') = 1,
    '§4 regression: exactly one reapplied history event';
  assert e.details ->> 'attempt' = '1',
    format('§4 regression: the first reapplied event records attempt 1, got %s', e.details ->> 'attempt');

  select count(*) into v_notified from public.notifications
   where entity_id = v_id and type::text = 'customer_review_reapplied';
  assert v_notified = 2, format('§4 both reviewers told about the reapplication, got %s', v_notified);
  assert exists (select 1 from public.notifications where entity_id = v_id and type::text = 'customer_review_reapplied'
                   and title = 'Test Two reapplied a rejected custom Text Review for approval.'), '§4 the reapplication sentence';

  -- A retry that finds it pending changes nothing and tells nobody.
  v := public.reapply_customer_review_custom_submission(
    v_id, 'e2000000-0000-4000-8000-0000000000e2', 'text', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null);
  assert (v ->> 'already_pending')::boolean, '§4 a retry is recognised';
  assert (select reapplication_count from public.customer_review_custom_submissions where id = v_id) = 1, '§4 still counted once';
  assert (select count(*) from public.notifications where entity_id = v_id and type::text = 'customer_review_reapplied') = 2, '§4 the retry told nobody';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = v_id and event_type = 'reapplied') = 1, '§4 one reapplied event';
  raise notice 'PASS  §4 reapply: the same row and slot, the rejection kept, the note kept, reviewers told once';
end $$;

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', 'image')$q$,
  '23514', 'monthly limit of 10', '§4 after a reapplication the eleventh new review is still refused');

-- An image review turned text on reapplication is checked against the mix. E3
-- holds 7 text + 2 image; rejecting one image and reapplying it as text would
-- leave 1 slot for 2 required images.
select pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', '66000000-0000-4000-8000-000000000066', 'Wrong project photo');
select pg_temp.must_refuse(
  $q$select public.reapply_customer_review_custom_submission('66000000-0000-4000-8000-000000000066', 'e3000000-0000-4000-8000-0000000000e3', 'text', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null)$q$,
  '23514', 'Keep it as an Image Review', '§4 an image review cannot become text when the mix needs it');
do $$
begin
  perform public.reapply_customer_review_custom_submission('66000000-0000-4000-8000-000000000066', 'e3000000-0000-4000-8000-0000000000e3', 'image', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null);
  assert (select status from public.customer_review_custom_submissions where id = '66000000-0000-4000-8000-000000000066') = 'pending_verification', '§4 reapplied as image';
  raise notice 'PASS  §4 the image mix is re-checked only when an image review becomes text';
end $$;

-- Reapplication is the only way a rejected row moves, and it moves only the corrections.
do $$
declare
  v_id uuid;
begin
  v_id := pg_temp.sub('e1000000-0000-4000-8000-0000000000e1', 'text', '67000000-0000-4000-8000-000000000067');
  perform pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', v_id, 'Not published');
end $$;
select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submissions set status = 'pending_verification', rejected_by = null, rejected_at = null, rejection_reason = null, reapplication_count = reapplication_count + 1, last_reapplied_at = now(), submitted_at = submitted_at + interval '40 days' where id = '67000000-0000-4000-8000-000000000067'$q$,
  '42501', 'may change only the candidate', '§4 a reapplication cannot move the first submission');
select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submissions set status = 'pending_verification', rejected_by = null, rejected_at = null, rejection_reason = null where id = '67000000-0000-4000-8000-000000000067'$q$,
  '42501', 'counted exactly once', '§4 a reapplication must be counted');
-- ═══ §5. The pending count follows the decisions ════════════════════════════

do $$
declare
  v_before integer;
  v_own    integer;
  v_id     uuid := '61000000-0000-4000-8000-000000000061';
begin
  select count(*) into v_before from public.customer_review_custom_submissions where status = 'pending_verification';
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_id);
  assert (select count(*) from public.customer_review_custom_submissions where status = 'pending_verification') = v_before - 1, '§5 an approval leaves the queue';

  perform pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', '65000000-0000-4000-8000-000000000065', 'Blurry');
  assert (select count(*) from public.customer_review_custom_submissions where status = 'pending_verification') = v_before - 2, '§5 a rejection leaves the queue';

  perform public.reapply_customer_review_custom_submission('65000000-0000-4000-8000-000000000065', 'e3000000-0000-4000-8000-0000000000e3', 'image', (now() at time zone 'Asia/Kolkata')::date, null, 'Sharper photo', null, null, null, null, null);
  assert (select count(*) from public.customer_review_custom_submissions where status = 'pending_verification') = v_before - 1, '§5 a reapplication returns to the queue';

  -- A candidate's own read counts only their own rows, never the queue.
  select count(*) into v_own from public.customer_review_custom_submissions
   where status = 'pending_verification' and submitted_by = 'e3000000-0000-4000-8000-0000000000e3';
  perform pg_temp.act_as('e3000000-0000-4000-8000-0000000000e3');
  assert (select count(*) from public.customer_review_custom_submissions where status = 'pending_verification') = v_own,
    '§5 a candidate cannot count anybody else''s pending reviews';
  assert v_own < v_before - 1, '§5 (the queue holds other people''s reviews too)';
  perform pg_temp.act_as_service();
  raise notice 'PASS  §5 the pending queue: approval and rejection remove, reapplication returns';
end $$;

-- ═══ §6. Credits ════════════════════════════════════════════════════════════

do $$
declare
  v_text  uuid;
  v_img1  uuid;
  v_img2  uuid;
  v_rej   uuid;
  m       public.boe_credit_review_months%rowtype;
begin
  v_img1 := pg_temp.sub('e7000000-0000-4000-8000-0000000000e7', 'image');
  v_text := pg_temp.sub('e7000000-0000-4000-8000-0000000000e7', 'text');
  v_rej  := pg_temp.sub('e7000000-0000-4000-8000-0000000000e7', 'text');
  v_img2 := pg_temp.sub('e7000000-0000-4000-8000-0000000000e7', 'image');

  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_img1);
  assert (select credits from public.boe_credit_transactions where source_id = v_img1) = 1.5, '§6 an image review earns 1.5';
  assert public.boe_credit_spendable_balance('e7000000-0000-4000-8000-0000000000e7') = 0, '§6 one approval: nothing spendable';

  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', v_text);
  assert (select credits from public.boe_credit_transactions where source_id = v_text) = 1, '§6 a text review earns 1';
  assert public.boe_credit_spendable_balance('e7000000-0000-4000-8000-0000000000e7') = 0, '§6 two approvals: nothing spendable';
  assert public.boe_credit_provisional_credits('e7000000-0000-4000-8000-0000000000e7') = 2.5, '§6 2.5 pending the target';

  perform pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', v_rej, 'Duplicate of another review');
  assert not exists (select 1 from public.boe_credit_transactions where source_id = v_rej), '§6 a rejected review earns nothing';

  perform pg_temp.approve_as('a0000000-0000-4000-8000-00000000000a', v_img2);
  select * into m from public.boe_credit_review_months
   where employee_id = 'e7000000-0000-4000-8000-0000000000e7'
     and review_month = date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  assert m.status = 'qualified' and m.qualifying_review_count = 3, '§6 the third approval qualifies the month';
  assert public.boe_credit_spendable_balance('e7000000-0000-4000-8000-0000000000e7') = 4, '§6 1.5 + 1 + 1.5 = 4 spendable';
  assert not exists (select 1 from public.boe_credit_transactions where employee_id = 'e7000000-0000-4000-8000-0000000000e7' and credits < 0),
    '§6 nothing negative was posted';

  -- The reapplied review from §4 is approved, once.
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', '64000000-0000-4000-8000-000000000064');
  perform pg_temp.approve_as('a0000000-0000-4000-8000-00000000000a', '64000000-0000-4000-8000-000000000064');
  assert (select count(*) from public.boe_credit_transactions where source_id = '64000000-0000-4000-8000-000000000064') = 1,
    '§6 a reapplied then approved review earns exactly once';

  -- E8: two approvals and no more — the month stays open, nothing spendable, nothing negative.
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', pg_temp.sub('e8000000-0000-4000-8000-0000000000e8', 'image'));
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', pg_temp.sub('e8000000-0000-4000-8000-0000000000e8', 'text'));
  assert public.boe_credit_spendable_balance('e8000000-0000-4000-8000-0000000000e8') = 0, '§6 two approved: no review credit spendable';
  assert public.boe_credit_balance('e8000000-0000-4000-8000-0000000000e8') = 2.5, '§6 two approved: 2.5 recorded, pending';
  assert not exists (select 1 from public.boe_credit_transactions where employee_id = 'e8000000-0000-4000-8000-0000000000e8' and credits < 0),
    '§6 a month below its minimum posts no negative row';
  raise notice 'PASS  §6 credits: text 1, image 1.5, pending until the third approval, once per review, never negative';
end $$;

-- ═══ §7. A closed month ═════════════════════════════════════════════════════

create temporary table last_month on commit drop as
select (date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - interval '1 month')::date as m;

-- Three E9 reviews from last month: one to approve, one left pending, one rejected.
insert into public.customer_review_custom_submissions (
  id, submitted_by, review_type, published_on, proof_storage_path, proof_file_name, proof_mime_type,
  proof_byte_size, proof_content_sha256, submitted_at
)
select v.id, 'e9000000-0000-4000-8000-0000000000e9', v.t, (select m from last_month) + 5,
       v.id::text || '/proof/old.png', 'old.png', 'image/png', 100, md5(v.id::text) || md5(v.id::text || 'y'),
       ((select m from last_month) + interval '10 days')::timestamp at time zone 'Asia/Kolkata'
  from (values
    ('71000000-0000-4000-8000-000000000071'::uuid, 'text'),
    ('72000000-0000-4000-8000-000000000072'::uuid, 'text'),
    ('73000000-0000-4000-8000-000000000073'::uuid, 'image')
  ) as v(id, t);

do $$
declare
  v jsonb;
begin
  perform public.post_boe_credit_transaction('e9000000-0000-4000-8000-0000000000e9', 'admin_adjustment', 5, 'manual', null, 'Fixture: credits already held', 'a0000000-0000-4000-8000-00000000000a');
  perform pg_temp.approve_as('b0000000-0000-4000-8000-00000000000b', '71000000-0000-4000-8000-000000000071');
  perform pg_temp.reject_as('b0000000-0000-4000-8000-00000000000b', '73000000-0000-4000-8000-000000000073', 'Wrong review');
  assert public.boe_credit_balance('e9000000-0000-4000-8000-0000000000e9') = 6, '§7 5 held + 1 provisional = 6 recorded';

  v := public.finalize_boe_credit_review_month('e9000000-0000-4000-8000-0000000000e9', (select m from last_month), 'a0000000-0000-4000-8000-00000000000a');
  assert v ->> 'status' = 'lapsed', '§7 one approval of three: the month lapses';
  assert (v ->> 'lapsed_credits')::numeric = 1, '§7 exactly the provisional credit lapses';
  assert public.boe_credit_balance('e9000000-0000-4000-8000-0000000000e9') = 5, '§7 the credits already held are untouched — no penalty';
  assert public.boe_credit_spendable_balance('e9000000-0000-4000-8000-0000000000e9') = 5, '§7 5 spendable';
  assert (select coalesce(sum(credits), 0) from public.boe_credit_transactions
           where employee_id = 'e9000000-0000-4000-8000-0000000000e9' and credits < 0) = -1,
    '§7 the only negative row is the lapse of that one provisional credit';
  raise notice 'PASS  §7 a month below its minimum lapses exactly its provisional credits; nothing already held is taken';
end $$;

select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
select pg_temp.must_refuse(
  $q$select public.approve_customer_review_custom_submission('72000000-0000-4000-8000-000000000072', 1)$q$,
  '55000', 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED', '§7 a review whose month lapsed cannot be approved into it');
select pg_temp.act_as_service();
select pg_temp.must_refuse(
  $q$select public.reapply_customer_review_custom_submission('73000000-0000-4000-8000-000000000073', 'e9000000-0000-4000-8000-0000000000e9', 'image', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null)$q$,
  '55000', 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED', '§7 a rejected review whose month lapsed cannot be reapplied');

do $$
begin
  assert public.boe_credit_spendable_balance('e9000000-0000-4000-8000-0000000000e9') = 5, '§7 still 5 — nothing slipped through';
  raise notice 'PASS  §7 a lapsed month accepts neither an approval nor a reapplication';
end $$;

-- ═══ §8. Who can read the history ═══════════════════════════════════════════

do $$
begin
  perform pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
  assert (select count(distinct submission_id) from public.customer_review_custom_submission_events) = 10, '§8 E2 reads the history of their ten';
  perform pg_temp.act_as('c0000000-0000-4000-8000-00000000000c');
  assert (select count(*) from public.customer_review_custom_submission_events) = 0, '§8 an outsider reads none';
  perform pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
  assert (select count(*) from public.customer_review_custom_submission_events)
         = (select count(*) from public.customer_review_custom_submission_events e join public.customer_review_custom_submissions s on s.id = e.submission_id),
    '§8 a verifier reads every history';
  perform pg_temp.act_as_service();
  raise notice 'PASS  §8 the history follows the submission''s own visibility';
end $$;

select pg_temp.must_refuse(
  $q$update public.customer_review_custom_submission_events set note = 'edited' where event_type = 'reapplied'$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§8 the history is never edited');
select pg_temp.must_refuse(
  $q$delete from public.customer_review_custom_submission_events$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§8 the history is never deleted');

-- ═══ §9. Generated reviews: a candidate cannot book ═════════════════════════

insert into public.customer_review_test_cards (id, status, card_ref) values
  ('81000000-0000-4000-8000-000000000081', 'available', 'RW-PAUSE-1'),
  ('82000000-0000-4000-8000-000000000082', 'available', 'RW-PAUSE-2'),
  ('83000000-0000-4000-8000-000000000083', 'available', 'RW-PAUSE-3');

select pg_temp.claims_only('e1000000-0000-4000-8000-0000000000e1');
select pg_temp.must_refuse(
  $q$update public.customer_review_test_cards set status = 'booked', booked_by = 'e1000000-0000-4000-8000-0000000000e1' where id = '81000000-0000-4000-8000-000000000081'$q$,
  '55000', 'CUSTOMER_REVIEW_GENERATED_PAUSED', '§9 a candidate cannot book a generated review');

do $$
begin
  perform pg_temp.claims_only('b0000000-0000-4000-8000-00000000000b');
  update public.customer_review_test_cards set status = 'booked', booked_by = 'b0000000-0000-4000-8000-00000000000b' where id = '82000000-0000-4000-8000-000000000082';
  perform pg_temp.act_as_service();
  update public.customer_review_test_cards set status = 'booked' where id = '83000000-0000-4000-8000-000000000083';
  update public.customer_review_test_cards set status = 'submitted' where id = '83000000-0000-4000-8000-000000000083';
  assert (select count(*) from public.customer_review_test_cards where status in ('booked', 'submitted')) = 2, '§9 verifier and server moves went through';
  assert (select status from public.customer_review_test_cards where id = '81000000-0000-4000-8000-000000000081') = 'available', '§9 the candidate''s card is still available';
  raise notice 'PASS  §9 booking is paused for candidates only; nothing else about a card''s lifecycle changed';
end $$;

-- ═══ §10. Settings changes do not reprice ═══════════════════════════════════

insert into public.boe_credit_settings (
  review_reward_credits, image_review_reward_credits, credit_value, half_day_redemption_credits, full_day_redemption_credits,
  minimum_monthly_reviews, max_monthly_review_submissions, minimum_monthly_image_reviews, note, created_at
) values (2, 3, 80, 8, 15, 3, 10, 3, 'test-only: new prices', clock_timestamp());

do $$
begin
  assert (select credits from public.boe_credit_transactions where source_id = '61000000-0000-4000-8000-000000000061') = 1.5,
    '§10 the image reward already posted is still 1.5';
  assert (select credits_awarded from public.customer_review_custom_submissions where id = '61000000-0000-4000-8000-000000000061') = 1.5,
    '§10 and the submission still records 1.5';
  assert public.boe_credit_spendable_balance('e7000000-0000-4000-8000-0000000000e7') = 4, '§10 E7 still holds 4';
  raise notice 'PASS  §10 a settings change reprices nothing already posted';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;

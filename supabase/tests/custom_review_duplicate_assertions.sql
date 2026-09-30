-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20270224000000_customer_review_custom_duplicate_detection.sql
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Run by run_custom_review_edit_delete_local.sh after the edit / delete suite.
-- The MATCHING (text and image similarity) is duplicateDetection.ts and is tested
-- there; this suite proves what the DATABASE stores, refuses and hides.
--
--   §1  a clear run          fields stored, a 'clear' run, fingerprint, no flags
--   §2  a flagged run        refused unless the employee proceeded; then run + flag + history event
--   §3  an unavailable run   refused unless proceeded; stored honestly as unavailable, never clear
--   §4  malformed results    refused (inconsistent status, self match, unknown match, bad reason, bad hash)
--   §5  private evidence     an employee reads no check and no flag; a verifier reads both
--   §6  decisions            verifier only, never the review's submitter, never stale; history keeps a change of mind;
--   §6b a confirmed duplicate  "Duplicate" REJECTS the review and reverses its credit once; a weak flag cannot be confirmed;
--                            approval is refused while it stands; "Different" after "Duplicate" restores no credit
--                            no status or credit moves
--   §7  a changed review     new fingerprint = new undecided flags; the old decision stays as history
--   §8  a weak match         stored, shown, not queued
--   §9  deleted evidence     candidates include deleted reviews; a flag against one is recorded
--   §10 append-only          checks never change; flags change only their decision
--
-- ONE TRANSACTION, ROLLED BACK. Refuses to run if public.users holds anybody.
-- ⚠ NOT RUN AGAINST PRODUCTION.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
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

create or replace function pg_temp.fp(p_seed text) returns text language sql as $$
  select md5(p_seed) || md5(p_seed || 'f')
$$;

create or replace function pg_temp.dup(p_status text, p_fp text, p_proceeded boolean, p_matches jsonb default '[]')
returns jsonb language sql as $$
  select jsonb_build_object('status', p_status, 'fingerprint', p_fp, 'employee_proceeded', p_proceeded, 'matches', p_matches)
$$;

create or replace function pg_temp.match(p_id uuid, p_reasons text[], p_strength text, p_evidence jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('matched_id', p_id, 'reasons', to_jsonb(p_reasons), 'strength', p_strength, 'evidence', p_evidence)
$$;

-- A registration exactly as the route makes it.
create or replace function pg_temp.sub(
  p_actor uuid, p_id uuid, p_name text default null, p_text text default null,
  p_dup jsonb default null, p_phash text default null)
returns uuid language plpgsql as $$
begin
  perform public.create_customer_review_custom_submission(
    p_id, p_actor, 'text', (now() at time zone 'Asia/Kolkata')::date, null,
    p_id::text || '/proof/shot.png', 'shot.png', 'image/png', 2048,
    md5(p_id::text) || md5(p_id::text || 'x'),
    p_name, p_text, lower(p_name), lower(p_text), p_phash, p_dup);
  return p_id;
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

-- A run and one flag on the review's CURRENT content (what the route would have recorded).
create or replace function pg_temp.flag_on(p_sub uuid, p_matched uuid, p_strength text default 'strong', p_reasons text[] default array['review_text'])
returns uuid language plpgsql as $$
declare
  v_fp text := md5(p_sub::text || clock_timestamp()::text) || md5(p_sub::text);
  v_check uuid;
  v_flag uuid;
begin
  insert into public.customer_review_custom_duplicate_checks (submission_id, content_fingerprint, status, employee_proceeded, trigger_event, match_count)
  values (p_sub, v_fp, 'flagged', true, 'submitted', 1) returning id into v_check;
  insert into public.customer_review_custom_duplicate_flags (submission_id, matched_submission_id, check_id, content_fingerprint, reasons, strength, employee_proceeded)
  values (p_sub, p_matched, v_check, v_fp, p_reasons, p_strength, true) returning id into v_flag;
  return v_flag;
end $$;

create or replace function pg_temp.decide_as(p_verifier uuid, p_flag uuid, p_decision text, p_note text default null)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_verifier);
  v := public.decide_customer_review_custom_duplicate(p_flag, p_decision, p_note);
  perform pg_temp.act_as_service();
  return v;
end $$;

do $$
begin
  if (select count(*) from public.users) <> 0 then
    raise exception 'REFUSING TO RUN: public.users is not empty — this is not a disposable database';
  end if;
end $$;

insert into public.users (id, full_name, email, role, team, is_active, is_deleted, employee_code) values
  ('a0000000-0000-4000-8000-00000000000a', 'Test Admin',    'admin@example.test', 'admin',  'management', true, false, 'T-ADM'),
  ('b0000000-0000-4000-8000-00000000000b', 'Test Verifier', 'ver@example.test',   'member', 'reviews',    true, false, 'T-VER'),
  ('e1000000-0000-4000-8000-0000000000e1', 'Ashok Choudhary','e1@example.test',   'member', 'sales',      true, false, 'T-001'),
  ('e2000000-0000-4000-8000-0000000000e2', 'Test Two',      'e2@example.test',    'member', 'sales',      true, false, 'T-002'),
  ('e3000000-0000-4000-8000-0000000000e3', 'Test Three',    'e3@example.test',    'member', 'sales',      true, false, 'T-003');

insert into public.test_permission_grants (user_id, module_key, action_key)
select id, 'customer_review_requests', 'use'
  from public.users where employee_code in ('T-ADM', 'T-VER', 'T-001', 'T-002', 'T-003');
insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('a0000000-0000-4000-8000-00000000000a', 'customer_review_requests', 'verify'),
  ('b0000000-0000-4000-8000-00000000000b', 'customer_review_requests', 'verify');

-- ═══ §1. A clear run ═════════════════════════════════════════════════════════

do $$
declare
  a uuid := 'd1000000-0000-4000-8000-0000000000d1';
  r public.customer_review_custom_submissions%rowtype;
begin
  perform pg_temp.sub('e1000000-0000-4000-8000-0000000000e1', a, 'Priya Nair', 'Lovely furniture and the delivery team was punctual.',
    pg_temp.dup('clear', pg_temp.fp('a'), false), repeat('a', 1024));
  select * into r from public.customer_review_custom_submissions where id = a;
  assert r.reviewer_name = 'Priya Nair' and r.review_text like 'Lovely furniture%', '§1 name and text stored';
  assert r.reviewer_name_norm = 'priya nair' and r.proof_phash = repeat('a', 1024), '§1 the normalized name and the hash stored';
  assert (select status from public.customer_review_custom_duplicate_checks where submission_id = a) = 'clear', '§1 a clear run';
  assert (select employee_proceeded from public.customer_review_custom_duplicate_checks where submission_id = a) = false, '§1 nobody proceeded';
  assert (select count(*) from public.customer_review_custom_duplicate_flags where submission_id = a) = 0, '§1 no flags';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = a and event_type = 'duplicate_flagged') = 0,
    '§1 a clear run writes no flag event';

  -- name and text stay optional; a norm without its field is not kept
  perform pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', 'd1000000-0000-4000-8000-0000000000d2');
  assert (select reviewer_name_norm is null and review_text_norm is null and proof_phash is null
            from public.customer_review_custom_submissions where id = 'd1000000-0000-4000-8000-0000000000d2'),
    '§1 no name, no text, no hash, no check: a review from before the feature reads as "not checked"';
  assert (select count(*) from public.customer_review_custom_duplicate_checks where submission_id = 'd1000000-0000-4000-8000-0000000000d2') = 0,
    '§1 with no result there is no run — never a fabricated clear';
  raise notice 'PASS  §1 a clear run is recorded with the fields; no result means no run';
end $$;

-- ═══ §2. A flagged run ═══════════════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', 'd2000000-0000-4000-8000-0000000000d3', 'Priya Nair', 'Lovely furniture and the delivery team was punctual.',
       pg_temp.dup('flagged', pg_temp.fp('b'), false, jsonb_build_array(pg_temp.match('d1000000-0000-4000-8000-0000000000d1', array['review_text'], 'strong'))))$q$,
  '55000', 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE_WARNING', '§2 a flagged run the employee did not proceed on is refused');
do $$
begin
  assert not exists (select 1 from public.customer_review_custom_submissions where id = 'd2000000-0000-4000-8000-0000000000d3'),
    '§2 and the refusal left no review behind';
end $$;

do $$
declare
  b uuid := 'd2000000-0000-4000-8000-0000000000d4';
  f public.customer_review_custom_duplicate_flags%rowtype;
begin
  perform pg_temp.sub('e2000000-0000-4000-8000-0000000000e2', b, 'Priya Nair', 'Lovely furniture and the delivery team was punctual.',
    pg_temp.dup('flagged', pg_temp.fp('b'), true, jsonb_build_array(pg_temp.match(
      'd1000000-0000-4000-8000-0000000000d1', array['review_text', 'reviewer_name'], 'strong',
      '{"text_kind":"exact","text_similarity":1,"name_match":true}'))));
  select * into f from public.customer_review_custom_duplicate_flags where submission_id = b;
  assert f.matched_submission_id = 'd1000000-0000-4000-8000-0000000000d1', '§2 the matched review is recorded';
  assert f.reasons = array['review_text', 'reviewer_name'] or f.reasons = array['reviewer_name', 'review_text'], '§2 the reasons';
  assert f.strength = 'strong' and f.employee_proceeded, '§2 the strength, and that the employee proceeded';
  assert f.evidence ->> 'text_kind' = 'exact', '§2 the evidence is kept';
  assert (select status from public.customer_review_custom_duplicate_checks where submission_id = b) = 'flagged'
     and (select employee_proceeded from public.customer_review_custom_duplicate_checks where submission_id = b), '§2 the run says flagged and proceeded';
  assert (select count(*) from public.customer_review_custom_submission_events where submission_id = b and event_type = 'duplicate_flagged') = 1,
    '§2 one history event';
  -- Saved anyway: a warning alone rejects nothing and touches no reward.
  assert (select status from public.customer_review_custom_submissions where id = b) = 'pending_verification', '§2 the review is pending like any other';
  raise notice 'PASS  §2 a flagged review saves only after the employee proceeded, with the evidence stored';
end $$;

-- ═══ §3. An unavailable check is never a clean one ═══════════════════════════

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'd3000000-0000-4000-8000-0000000000d5', null, null,
       pg_temp.dup('unavailable', pg_temp.fp('c'), false))$q$,
  '55000', 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE_WARNING', '§3 an unavailable check the employee did not acknowledge is refused');
do $$
declare c uuid := 'd3000000-0000-4000-8000-0000000000d6';
begin
  perform pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', c, null, null, pg_temp.dup('unavailable', pg_temp.fp('c'), true));
  assert (select status from public.customer_review_custom_duplicate_checks where submission_id = c) = 'unavailable', '§3 stored as unavailable';
  assert (select count(*) from public.customer_review_custom_duplicate_flags where submission_id = c) = 0, '§3 with no flags';
  assert (select check_status from public.customer_review_custom_duplicate_summary where submission_id = c) = 'unavailable',
    '§3 the summary says unavailable, not clear';
  raise notice 'PASS  §3 an unavailable check is stored as unavailable and never reads as clear';
end $$;

-- ═══ §4. Malformed results ═══════════════════════════════════════════════════

select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'd4000000-0000-4000-8000-0000000000e1', null, null,
       pg_temp.dup('clear', pg_temp.fp('d'), false, jsonb_build_array(pg_temp.match('d1000000-0000-4000-8000-0000000000d1', array['image'], 'strong'))))$q$,
  '22023', 'inconsistent', '§4 a clear run cannot carry matches');
select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'd4000000-0000-4000-8000-0000000000e2', null, null,
       pg_temp.dup('flagged', pg_temp.fp('d'), true))$q$,
  '22023', 'inconsistent', '§4 a flagged run needs a match');
select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'd4000000-0000-4000-8000-0000000000e3', null, null,
       pg_temp.dup('flagged', pg_temp.fp('d'), true, jsonb_build_array(pg_temp.match('d4000000-0000-4000-8000-0000000000e3', array['image'], 'strong'))))$q$,
  '22023', 'could not be read', '§4 a review cannot match itself');
select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'd4000000-0000-4000-8000-0000000000e4', null, null,
       pg_temp.dup('flagged', pg_temp.fp('d'), true, jsonb_build_array(pg_temp.match('99999999-9999-4999-8999-999999999999', array['image'], 'strong'))))$q$,
  '22023', 'does not exist', '§4 an unknown matched review');
select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'd4000000-0000-4000-8000-0000000000e5', null, null,
       pg_temp.dup('flagged', pg_temp.fp('d'), true, jsonb_build_array(pg_temp.match('d1000000-0000-4000-8000-0000000000d1', array['mood'], 'strong'))))$q$,
  '22023', 'could not be read', '§4 an unknown reason');
select pg_temp.must_refuse(
  $q$select pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', 'd4000000-0000-4000-8000-0000000000e6', null, null,
       pg_temp.dup('clear', 'not-a-hash', false))$q$,
  '22023', 'could not be read', '§4 a fingerprint that is not a SHA-256');

-- ═══ §5. Private evidence ════════════════════════════════════════════════════

select pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
do $$
begin
  assert (select count(*) from public.customer_review_custom_duplicate_flags) = 0, '§5 an employee reads no flag — not even on their own review';
  assert (select count(*) from public.customer_review_custom_duplicate_checks) = 0, '§5 nor any run';
  assert (select count(*) from public.customer_review_custom_duplicate_summary where check_status is not null) = 0,
    '§5 nor a run through the summary view';
end $$;
select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
do $$
begin
  assert (select count(*) from public.customer_review_custom_duplicate_flags) >= 1, '§5 a verifier reads the flags';
  assert (select count(*) from public.customer_review_custom_duplicate_checks) >= 3, '§5 and the runs';
  assert (select flags_open from public.customer_review_custom_duplicate_summary where submission_id = 'd2000000-0000-4000-8000-0000000000d4') = 1,
    '§5 the summary counts the open flag';
end $$;
select pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
select pg_temp.must_refuse($q$select public.customer_review_custom_duplicate_candidates(null)$q$, '42501', 'permission denied', '§5 an employee cannot list candidates');
select pg_temp.must_refuse($q$insert into public.customer_review_custom_duplicate_flags (submission_id, matched_submission_id, check_id, content_fingerprint, reasons, strength) select submission_id, matched_submission_id, check_id, content_fingerprint, reasons, strength from public.customer_review_custom_duplicate_flags limit 1$q$,
  '42501', 'permission denied', '§5 no client role inserts a flag');
select pg_temp.act_as_service();
do $$ begin raise notice 'PASS  §5 evidence is a verifier''s: employees read none of it'; end $$;

-- ═══ §6. Decisions ═══════════════════════════════════════════════════════════

do $$
declare
  fl uuid;
  v  jsonb;
  st text;
begin
  select id into fl from public.customer_review_custom_duplicate_flags where submission_id = 'd2000000-0000-4000-8000-0000000000d4';
  select status into st from public.customer_review_custom_submissions where id = 'd2000000-0000-4000-8000-0000000000d4';

  perform pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
  v := public.decide_customer_review_custom_duplicate(fl, 'different', 'Looks alike, but a different customer');
  assert v ->> 'decision' = 'different' and (v ->> 'unchanged')::boolean = false, '§6 recorded as different';
  v := public.decide_customer_review_custom_duplicate(fl, 'different', 'Looks alike, but a different customer');
  assert (v ->> 'unchanged')::boolean, '§6 a repeat is unchanged';
  v := public.decide_customer_review_custom_duplicate(fl, 'different', 'Checked again — still a different customer');
  assert v ->> 'decision' = 'different', '§6 the note can change';
  perform pg_temp.act_as_service();

  assert (select count(*) from public.customer_review_custom_submission_events
           where submission_id = 'd2000000-0000-4000-8000-0000000000d4' and event_type = 'duplicate_decided') = 2,
    '§6 both decisions are in the history';
  assert exists (select 1 from public.customer_review_custom_submission_events
           where submission_id = 'd2000000-0000-4000-8000-0000000000d4' and event_type = 'duplicate_decided'
             and details ->> 'decision' = 'different' and details ->> 'previous_decision' = 'different'), '§6 the second says what it replaced';
  assert (select status from public.customer_review_custom_submissions where id = 'd2000000-0000-4000-8000-0000000000d4') = st,
    '§6 "different" moved no status';
  assert (select count(*) from public.boe_credit_transactions) = 0, '§6 and no credit';
  assert (select flags_open from public.customer_review_custom_duplicate_summary where submission_id = 'd2000000-0000-4000-8000-0000000000d4') = 0
     and (select decided_different from public.customer_review_custom_duplicate_summary where submission_id = 'd2000000-0000-4000-8000-0000000000d4') = 1,
    '§6 the summary follows the decision';
  raise notice 'PASS  §6 a verifier decides; the history keeps every decision; no status or credit moves';
end $$;

select pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
select pg_temp.must_refuse(
  $q$select public.decide_customer_review_custom_duplicate((select id from public.customer_review_custom_duplicate_flags limit 1), 'duplicate')$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED', '§6 an employee without verify cannot decide');
select pg_temp.act_as_service();
-- the submitter of the flagged review, holding verify, still cannot decide it
insert into public.test_permission_grants (user_id, module_key, action_key) values
  ('e2000000-0000-4000-8000-0000000000e2', 'customer_review_requests', 'verify');
select pg_temp.act_as('e2000000-0000-4000-8000-0000000000e2');
select pg_temp.must_refuse(
  $q$select public.decide_customer_review_custom_duplicate((select id from public.customer_review_custom_duplicate_flags where submission_id = 'd2000000-0000-4000-8000-0000000000d4'), 'duplicate')$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_SELF', '§6 nobody decides a flag on their own review');
select pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
select pg_temp.must_refuse(
  $q$select public.decide_customer_review_custom_duplicate((select id from public.customer_review_custom_duplicate_flags limit 1), 'maybe')$q$,
  '22023', 'Choose Duplicate or Different review', '§6 only the two decisions exist');
select pg_temp.act_as_service();
delete from public.test_permission_grants where user_id = 'e2000000-0000-4000-8000-0000000000e2' and action_key = 'verify';


-- ═══ §6b. A confirmed duplicate is binding ═══════════════════════════════════

do $$
declare
  V  uuid := 'b0000000-0000-4000-8000-00000000000b';
  E1 uuid := 'e1000000-0000-4000-8000-0000000000e1';
  ref uuid := 'd1000000-0000-4000-8000-0000000000d1';
  p1 uuid := 'dd000000-0000-4000-8000-0000000000a1';
  p2 uuid := 'dd000000-0000-4000-8000-0000000000a2';
  p3 uuid := 'dd000000-0000-4000-8000-0000000000a3';
  p4 uuid := 'dd000000-0000-4000-8000-0000000000a4';
  f  uuid;
  weak uuid;
  res jsonb;
  bal0 numeric;
  n_rev integer;
begin
  bal0 := public.boe_credit_balance(E1);

  -- A. a PENDING review marked Duplicate is rejected; nothing was paid, nothing reversed
  perform pg_temp.sub(E1, p1, 'Copy Cat', 'Some words that were written once and copied by someone else afterwards.');
  weak := pg_temp.flag_on(p1, ref, 'weak', array['reviewer_name']);
  begin
    perform pg_temp.decide_as(V, weak, 'duplicate');
    raise exception '§6b a weak flag was confirmed as a duplicate';
  exception when sqlstate '22023' then null;
  end;
  f := pg_temp.flag_on(p1, ref);   -- a later run: this is the current one
  res := pg_temp.decide_as(V, f, 'duplicate', 'Same review');
  assert (res ->> 'review_rejected')::boolean and not (res ->> 'credit_reversed')::boolean, '§6b a pending duplicate is rejected, no credit to reverse';
  assert (select status from public.customer_review_custom_submissions where id = p1) = 'rejected'
     and (select rejection_reason from public.customer_review_custom_submissions where id = p1) = 'Confirmed duplicate of an earlier review',
    '§6b status Rejected with the reason';
  assert exists (select 1 from public.customer_review_custom_submission_events where submission_id = p1 and event_type = 'rejected' and reason like 'Confirmed duplicate%'),
    '§6b the rejection is in the history';
  assert (select decided_duplicate from public.customer_review_custom_duplicate_summary where submission_id = p1) >= 1, '§6b the summary shows the confirmed duplicate';
  res := pg_temp.decide_as(V, f, 'duplicate', 'Same review');
  assert (res ->> 'unchanged')::boolean, '§6b a repeat changes nothing';

  -- "Different" afterwards: the mark goes, the review stays Rejected, no credit appears
  res := pg_temp.decide_as(V, f, 'different', 'On reflection, a different customer');
  assert (select status from public.customer_review_custom_submissions where id = p1) = 'rejected', '§6b Different does not un-reject the review';
  assert (select decided_duplicate from public.customer_review_custom_duplicate_summary where submission_id = p1) = 0, '§6b the confirmed-duplicate mark is gone';
  assert public.boe_credit_balance(E1) = bal0, '§6b and no credit was created';
  -- it earned nothing, so the employee may Edit & Reapply it, and then it can be approved (one reward, first time)
  perform public.reapply_customer_review_custom_submission(p1, E1, 'text', (now() at time zone 'Asia/Kolkata')::date, null, 'Not a duplicate', null, null, null, null, null);
  perform pg_temp.approve_as(V, p1);
  assert public.boe_credit_balance(E1) = bal0 + 1, '§6b after Different and a reapplication the review earns its ONE reward';

  -- B. Duplicate, reapplied unchanged: still confirmed, so approval is REFUSED
  perform pg_temp.sub(E1, p2, 'Copy Cat Two', 'Another sentence written once and reproduced word for word by a second employee.');
  f := pg_temp.flag_on(p2, ref);
  perform pg_temp.decide_as(V, f, 'duplicate');
  perform public.reapply_customer_review_custom_submission(p2, E1, 'text', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null);
  perform pg_temp.act_as(V);
  begin
    perform public.approve_customer_review_custom_submission(p2, 1);
    raise exception '§6b a confirmed duplicate was approved';
  exception when sqlstate '55000' then
    if position('DUPLICATE_CONFIRMED' in sqlerrm) = 0 then raise; end if;
  end;
  perform pg_temp.act_as_service();
  assert public.boe_credit_balance(E1) = bal0 + 1, '§6b nothing was paid for it';

  -- C. an APPROVED review marked Duplicate: rejected, credit reversed ONCE
  perform pg_temp.sub(E1, p3, 'Copy Cat Three', 'A third sentence, approved first and only later recognised as a copy of another review.');
  perform pg_temp.approve_as(V, p3);
  assert public.boe_credit_balance(E1) = bal0 + 2, '§6b approved: +1';
  f := pg_temp.flag_on(p3, ref);
  res := pg_temp.decide_as(V, f, 'duplicate', 'Recognised later');
  assert (res ->> 'review_rejected')::boolean and (res ->> 'credit_reversed')::boolean, '§6b the credit is reversed with the rejection';
  assert public.boe_credit_balance(E1) = bal0 + 1, '§6b net: the reward is taken back';
  select count(*) into n_rev from public.boe_credit_transactions where employee_id = E1 and transaction_type = 'reversal';
  res := pg_temp.decide_as(V, f, 'duplicate', 'Recorded again with another note');
  assert (select count(*) from public.boe_credit_transactions where employee_id = E1 and transaction_type = 'reversal') = n_rev, '§6b a second decision reverses nothing more';
  res := pg_temp.decide_as(V, f, 'different', 'Changed my mind');
  assert public.boe_credit_balance(E1) = bal0 + 1, '§6b Different restores NO credit';
  assert (select status from public.customer_review_custom_submissions where id = p3) = 'rejected', '§6b and does not un-reject it';
  begin
    perform public.reapply_customer_review_custom_submission(p3, E1, 'text', (now() at time zone 'Asia/Kolkata')::date, null, null, null, null, null, null, null);
    raise exception '§6b a review whose credit was reversed was reapplied';
  exception when sqlstate '55000' then null;
  end;
  assert (select reward_reversal_transaction_id from public.customer_review_custom_submissions where id = p3) is not null, '§6b the reversal is linked to the review';

  -- D. an EDITED approved review (credit held) marked Duplicate: reversed and rejected
  perform pg_temp.sub(E1, p4, 'Copy Cat Four', 'A fourth sentence that was approved, then edited, then found to be a copy of a review.');
  perform pg_temp.approve_as(V, p4);
  perform public.edit_customer_review_custom_submission(p4, E1, 'text', (now() at time zone 'Asia/Kolkata')::date, 'edited', 0, null, null, null, null, null);
  assert (select reward_held from public.customer_review_custom_submissions where id = p4), '§6b D: held';
  f := pg_temp.flag_on(p4, ref);
  res := pg_temp.decide_as(V, f, 'duplicate');
  assert (res ->> 'credit_reversed')::boolean and (select status from public.customer_review_custom_submissions where id = p4) = 'rejected'
     and not (select reward_held from public.customer_review_custom_submissions where id = p4), '§6b D: a held credit is reversed and the review rejected';
  assert public.boe_credit_balance(E1) = bal0 + 1, '§6b D: net unchanged from C';

  -- E. a POSSIBLE duplicate (undecided flag) never blocks approval
  perform pg_temp.sub(E1, 'dd000000-0000-4000-8000-0000000000a5', 'Merely Similar', 'A fifth sentence that only resembles another review, which a verifier has not decided about at all.');
  perform pg_temp.flag_on('dd000000-0000-4000-8000-0000000000a5', ref);
  perform pg_temp.approve_as(V, 'dd000000-0000-4000-8000-0000000000a5');
  assert (select status from public.customer_review_custom_submissions where id = 'dd000000-0000-4000-8000-0000000000a5') = 'approved', '§6b E: an undecided possible duplicate is a non-blocking warning';
  raise notice 'PASS  §6b Duplicate rejects and reverses once, blocks approval, a weak flag cannot be confirmed, Different restores nothing, a possible duplicate never blocks';
end $$;

-- ═══ §7. A changed review is checked again ═══════════════════════════════════

do $$
declare
  b uuid := 'd2000000-0000-4000-8000-0000000000d4';
  n_flags_before integer;
  v jsonb;
begin
  select count(*) into n_flags_before from public.customer_review_custom_duplicate_flags where submission_id = b;
  assert (select decision from public.customer_review_custom_duplicate_flags where submission_id = b) = 'different', '§7 starting from a "different" decision';

  -- The employee edits the text; the route recomputes and finds a match again.
  v := public.edit_customer_review_custom_submission(
    b, 'e2000000-0000-4000-8000-0000000000e2', 'text', (select published_on from public.customer_review_custom_submissions where id = b),
    null, 0, null, null, null, null, null,
    'Priya Nair', 'Lovely furniture, and the delivery team was very punctual.', 'priya nair', 'lovely furniture and the delivery team was very punctual', null,
    pg_temp.dup('flagged', pg_temp.fp('b2'), true, jsonb_build_array(pg_temp.match(
      'd1000000-0000-4000-8000-0000000000d1', array['review_text'], 'moderate', '{"text_kind":"similar","text_similarity":0.91}'))));

  assert (select count(*) from public.customer_review_custom_duplicate_flags where submission_id = b) = n_flags_before + 1,
    '§7 the edit raised a NEW flag';
  assert (select count(*) from public.customer_review_custom_duplicate_flags where submission_id = b and decision = 'different') = 1,
    '§7 the earlier decision is still there, as history';
  assert (select count(*) from public.customer_review_custom_duplicate_flags where submission_id = b and decision is null) = 1,
    '§7 the new flag is undecided — the old "different" did not silently clear it';
  assert (select flags_open from public.customer_review_custom_duplicate_summary where submission_id = b) = 1
     and (select decided_different from public.customer_review_custom_duplicate_summary where submission_id = b) = 0,
    '§7 the summary shows the review as awaiting a decision again';

  -- An edit that changes nothing the check reads (same fingerprint) raises nothing new.
  v := public.edit_customer_review_custom_submission(
    b, 'e2000000-0000-4000-8000-0000000000e2', 'text', (select published_on from public.customer_review_custom_submissions where id = b),
    'a remark', 1, null, null, null, null, null,
    'Priya Nair', 'Lovely furniture, and the delivery team was very punctual.', 'priya nair', 'lovely furniture and the delivery team was very punctual', null,
    pg_temp.dup('flagged', pg_temp.fp('b2'), true, jsonb_build_array(pg_temp.match(
      'd1000000-0000-4000-8000-0000000000d1', array['review_text'], 'moderate', '{"text_kind":"similar","text_similarity":0.91}'))));
  assert (select count(*) from public.customer_review_custom_duplicate_flags where submission_id = b) = n_flags_before + 1,
    '§7 the same content raised no second flag';
  assert exists (select 1 from public.customer_review_custom_submission_events
           where submission_id = b and event_type = 'edited' and details -> 'current' ->> 'review_text' like 'Lovely furniture, and%'),
    '§7 the edit history keeps the text';
  raise notice 'PASS  §7 changed content raises new undecided flags; earlier decisions stay as history';
end $$;

-- A stale decision is refused: the flag belongs to an older run.
do $$
declare old_flag uuid;
begin
  select id into old_flag from public.customer_review_custom_duplicate_flags
   where submission_id = 'd2000000-0000-4000-8000-0000000000d4' and decision = 'different';
  perform pg_temp.act_as('b0000000-0000-4000-8000-00000000000b');
  begin
    perform public.decide_customer_review_custom_duplicate(old_flag, 'duplicate');
    raise exception '§7 a decision on a stale flag was accepted';
  exception when sqlstate '40001' then
    perform pg_temp.act_as_service();
    raise notice 'PASS  §7 a flag from an older run cannot be decided';
  end;
end $$;

-- ═══ §8. A weak match is stored, not queued ══════════════════════════════════

do $$
declare
  w uuid := 'd8000000-0000-4000-8000-0000000000d8';
begin
  perform pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', w, 'Priya Nair', null,
    pg_temp.dup('flagged', pg_temp.fp('w'), true, jsonb_build_array(pg_temp.match(
      'd1000000-0000-4000-8000-0000000000d1', array['reviewer_name'], 'weak', '{"name_match":true}'))));
  assert (select count(*) from public.customer_review_custom_duplicate_flags where submission_id = w and strength = 'weak') = 1, '§8 the weak flag is stored';
  assert (select flags_current from public.customer_review_custom_duplicate_summary where submission_id = w) = 1
     and (select flags_open from public.customer_review_custom_duplicate_summary where submission_id = w) = 0,
    '§8 it is shown but not counted as awaiting a decision';
  raise notice 'PASS  §8 a shared name alone is weak: recorded, not queued';
end $$;

-- ═══ §9. Deleted reviews stay as evidence ════════════════════════════════════

do $$
declare
  gone uuid := 'd9000000-0000-4000-8000-0000000000d9';
  again uuid := 'd9000000-0000-4000-8000-0000000000da';
  n integer;
begin
  perform pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', gone, 'Kiran Rao', 'The wardrobe finish is excellent and installation was smooth.',
    pg_temp.dup('clear', pg_temp.fp('g'), false), repeat('c', 1024));
  perform public.delete_customer_review_custom_submission(gone, 'e3000000-0000-4000-8000-0000000000e3');

  select count(*) into n from public.customer_review_custom_duplicate_candidates(null) where id = gone and deleted;
  assert n = 1, '§9 the deleted review is still a candidate, marked deleted';
  assert (select count(*) from public.customer_review_custom_duplicate_candidates(gone) where id = gone) = 0, '§9 excluding a review leaves it out';

  -- Delete-and-repost: the same words again are flagged against the deleted record.
  perform pg_temp.sub('e3000000-0000-4000-8000-0000000000e3', again, 'Kiran Rao', 'The wardrobe finish is excellent and installation was smooth.',
    pg_temp.dup('flagged', pg_temp.fp('g2'), true, jsonb_build_array(pg_temp.match(gone, array['review_text', 'reviewer_name'], 'strong'))));
  assert (select matched_was_deleted from public.customer_review_custom_duplicate_flags where submission_id = again and matched_submission_id = gone),
    '§9 the flag records that it matched a deleted review';
  raise notice 'PASS  §9 deleted reviews remain comparison evidence, so delete-and-repost is flagged';
end $$;

-- ═══ §10. Append-only ════════════════════════════════════════════════════════

select pg_temp.must_refuse($q$update public.customer_review_custom_duplicate_checks set status = 'clear'$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§10 a run is never changed');
select pg_temp.must_refuse($q$delete from public.customer_review_custom_duplicate_checks$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§10 a run is never deleted');
select pg_temp.must_refuse($q$update public.customer_review_custom_duplicate_flags set strength = 'weak'$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§10 a flag''s evidence never changes');
select pg_temp.must_refuse($q$delete from public.customer_review_custom_duplicate_flags$q$,
  '42501', 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY', '§10 a flag is never deleted');

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
rollback;

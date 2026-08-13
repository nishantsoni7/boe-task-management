-- transition_task_review() / tasks_enforce_review_path assertions
-- ===========================================================================
-- Covers the FINAL state of all three migrations together:
--
--   20260832000000_task_pending_approval_status.sql       the status value
--   20260833000000_task_creator_approval.sql              the review RPC
--   20260834000000_task_creator_approval_enforcement.sql  the trigger
--
-- A delegated ordinary task reaches `pending_approval` or `completed` through
-- the review function and through nothing else, while self tasks, quotation
-- requests, cancellation and restore keep working exactly as they did.
--
-- This suite asserts the END state, so it is meaningless before 20260834 is
-- applied: with only 832 + 833 in place, §1 and §5 SHOULD fail, because during
-- that deliberate rollout window direct completion is still permitted so the
-- previously-deployed frontend keeps working. §0 refuses to run rather than
-- letting that read as a regression.
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. No sequences are consumed and no notification survives.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. This script writes rows. Run it only against a
--   database that is positively identified as non-production and that already
--   has all THREE migrations applied.
--
-- PREREQUISITES:
--   * psql as a role that may set session GUCs (standard Supabase `postgres`).
--   * Replace the THREE real user UUIDs below; all must exist and be distinct:
--       test.creator_id   -> the person who delegates the work
--       test.assignee_id  -> the person who does it
--       test.outsider_id  -> anybody else
--
-- Every guard under test reads auth.uid(), so the script simulates a session
-- with request.jwt.claims rather than SET ROLE — the same idiom the Assets and
-- Order Requests assertion scripts use. Note that the TRIGGER is only armed for
-- sessions that carry an identity: with no claims set, psql is the service-role
-- equivalent and is deliberately exempt (that is what keeps /api/cancel-task
-- and /api/restore-task working). §7 asserts that boundary explicitly.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ── 0. All three migrations must be applied ─────────────────────────────────
-- Checked FIRST and separately, so "the trigger was never installed" cannot be
-- mistaken for "the trigger let something through". Each assertion names the
-- file that supplies the missing object.

do $$
begin
  assert exists (
    select 1
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
     where t.typname = 'task_status'
       and e.enumlabel = 'pending_approval'),
    '20260832000000_task_pending_approval_status.sql is NOT applied: public.task_status has no pending_approval label';

  assert exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'transition_task_review'
       and pg_get_function_identity_arguments(p.oid) = 'uuid, text, text'),
    '20260833000000_task_creator_approval.sql is NOT applied: public.transition_task_review(uuid, text, text) does not exist';

  assert has_function_privilege('authenticated', 'public.transition_task_review(uuid, text, text)', 'execute'),
    '20260833000000 applied but `authenticated` lacks EXECUTE on the review RPC';

  assert exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'in_task_review'),
    '20260834000000_task_creator_approval_enforcement.sql is NOT applied: public.in_task_review() does not exist';

  assert exists (
    select 1 from pg_trigger
     where tgrelid = 'public.tasks'::regclass
       and tgname  = 'tasks_enforce_review_path'
       and not tgisinternal),
    '20260834000000_task_creator_approval_enforcement.sql is NOT applied: trigger tasks_enforce_review_path does not exist on public.tasks. NOTE: with only 20260832 + 20260833 applied this is the EXPECTED state during the rollout window, and this suite must not be run yet.';

  -- tgenabled: O = enabled (origin), D = disabled, R/A = replica-only.
  assert (select tgenabled from pg_trigger
           where tgrelid = 'public.tasks'::regclass
             and tgname  = 'tasks_enforce_review_path') = 'O',
    'trigger tasks_enforce_review_path exists but is not enabled for ordinary writes';
end $$;

-- ── Config: the ONLY lines a tester edits ────────────────────────────────────
do $$
begin
  perform set_config('test.creator_id',  '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.assignee_id', '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.outsider_id', '33333333-3333-3333-3333-333333333333', true); -- REPLACE

  perform set_config('t.delegated', gen_random_uuid()::text, true); -- the task under test
  perform set_config('t.self',      gen_random_uuid()::text, true); -- must stay directly completable
  perform set_config('t.quote',     gen_random_uuid()::text, true); -- must keep its own workflow
end $$;

do $$
begin
  assert (select count(*) from public.users
           where id in (current_setting('test.creator_id')::uuid,
                        current_setting('test.assignee_id')::uuid,
                        current_setting('test.outsider_id')::uuid)) = 3,
    'the three configured user ids must all exist and be distinct — replace the placeholders';
end $$;

-- Session helpers. `act_as(null)` drops back to an identity-less session, which
-- is what the service role and psql look like to the trigger.
create or replace function pg_temp.act_as(p_uid text) returns void
language plpgsql as $$
begin
  if p_uid is null then
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
  else
    perform set_config('request.jwt.claim.sub', p_uid, true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  end if;
end $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Written with no identity set, so the trigger does not police their creation.

do $$ begin perform pg_temp.act_as(null); end $$;

-- `team` is copied from the assignee's own row rather than hard-coded: it is a
-- free-text column since 20260667 and the valid values are the company's, not
-- this script's.
insert into public.tasks (id, title, status, priority, created_by, assigned_to, task_type, acknowledged_at, team)
values
  (current_setting('t.delegated')::uuid, 'ASSERT delegated ordinary', 'working', 'medium',
   current_setting('test.creator_id')::uuid, current_setting('test.assignee_id')::uuid, 'general', now(),
   (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid)),
  (current_setting('t.self')::uuid, 'ASSERT self task', 'working', 'medium',
   current_setting('test.assignee_id')::uuid, current_setting('test.assignee_id')::uuid, 'general', null,
   (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid)),
  (current_setting('t.quote')::uuid, 'ASSERT quotation request', 'working', 'medium',
   current_setting('test.creator_id')::uuid, current_setting('test.assignee_id')::uuid, 'quotation_request', null,
   (select u.team from public.users u where u.id = current_setting('test.assignee_id')::uuid));

-- ── 1. The bypass is closed ──────────────────────────────────────────────────
-- The whole reason this migration exists: a signed-in assignee holding the
-- table UPDATE grant used to be able to write `completed` directly.

do $$
declare v_msg text;
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));

  begin
    update public.tasks set status = 'completed'
     where id = current_setting('t.delegated')::uuid;
    assert false, 'an assignee must not be able to complete a delegated task directly';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_APPROVAL_REQUIRED:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    update public.tasks set status = 'pending_approval'
     where id = current_setting('t.delegated')::uuid;
    assert false, 'nobody may write pending_approval directly — it must go through the RPC';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_PATH_REQUIRED:%', 'unexpected refusal: ' || v_msg;
  end;

  -- The creator holds no direct route either.
  perform pg_temp.act_as(current_setting('test.creator_id'));
  begin
    update public.tasks set status = 'completed'
     where id = current_setting('t.delegated')::uuid;
    assert false, 'a creator must not be able to complete a delegated task directly';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_APPROVAL_REQUIRED:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

-- ── 2. Ordinary status changes are untouched ─────────────────────────────────

do $$
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  update public.tasks set status = 'waiting' where id = current_setting('t.delegated')::uuid;
  update public.tasks set status = 'blocked', blocker_reason = 'ASSERT blocker'
   where id = current_setting('t.delegated')::uuid;
  assert (select status::text from public.tasks where id = current_setting('t.delegated')::uuid) = 'blocked',
    'acknowledge/waiting/blocked transitions must still be available to the assignee';

  -- and a non-status edit by the creator is not policed at all
  perform pg_temp.act_as(current_setting('test.creator_id'));
  update public.tasks set priority = 'high' where id = current_setting('t.delegated')::uuid;
end $$;

-- ── 3. Who may submit ────────────────────────────────────────────────────────

do $$
declare v_msg text;
begin
  perform pg_temp.act_as(current_setting('test.creator_id'));
  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'submit');
    assert false, 'the creator must not submit on the assignee''s behalf';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_FORBIDDEN:%', 'unexpected refusal: ' || v_msg;
  end;

  perform pg_temp.act_as(current_setting('test.outsider_id'));
  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'submit');
    assert false, 'an outsider must not submit';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_FORBIDDEN:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'approve');
    assert false, 'an outsider must not approve';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_FORBIDDEN:%', 'unexpected refusal: ' || v_msg;
  end;

  perform pg_temp.act_as(current_setting('test.assignee_id'));
  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'approve');
    assert false, 'the assignee must not approve their own work';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_FORBIDDEN:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

-- ── 4. Submit: the transition, the stale fields, the record, the notification ─

do $$
declare
  v_res jsonb;
  v_before_notifs bigint;
begin
  select count(*) into v_before_notifs from public.notifications
   where task_id = current_setting('t.delegated')::uuid;

  perform pg_temp.act_as(current_setting('test.assignee_id'));
  v_res := public.transition_task_review(current_setting('t.delegated')::uuid, 'submit');

  assert v_res->>'status' = 'pending_approval', 'submit must land on pending_approval';
  assert v_res->>'completed_at' is null, 'completed_at must stay null on submit';

  assert (select completed_at is null and blocker_reason is null
                 and waiting_on_type is null and waiting_on_user_id is null and waiting_on_text is null
            from public.tasks where id = current_setting('t.delegated')::uuid),
    'the blocker that explained the old status must not outlive it';

  assert exists (
    select 1 from public.task_activity_log
     where task_id = current_setting('t.delegated')::uuid
       and action = 'status_changed'
       and from_status::text = 'blocked'
       and to_status::text   = 'pending_approval'
       and actor_id = current_setting('test.assignee_id')::uuid),
    'the submission must be recorded as a status change by the assignee';

  assert (select count(*) from public.notifications
           where task_id = current_setting('t.delegated')::uuid
             and user_id = current_setting('test.creator_id')::uuid
             and title like '%submitted task for approval') = 1,
    'exactly one notification, to the CREATOR, naming the event';

  assert (select count(*) from public.notifications
           where task_id = current_setting('t.delegated')::uuid) = v_before_notifs + 1,
    'submit must write exactly one notification';
end $$;

-- ── 5. A submitted task is frozen for the assignee ───────────────────────────

do $$
declare v_msg text;
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));

  begin
    update public.tasks set status = 'working' where id = current_setting('t.delegated')::uuid;
    assert false, 'the assignee must not move a task back out of pending_approval';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_PATH_REQUIRED:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'submit');
    assert false, 'a task awaiting approval must not be submitted again';
  exception when object_not_in_prerequisite_state then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_INVALID_SOURCE:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

-- ── 6. Return, then re-submit, then approve ──────────────────────────────────

do $$
declare
  v_res jsonb;
  v_msg text;
begin
  perform pg_temp.act_as(current_setting('test.creator_id'));

  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'return', '   ');
    assert false, 'a whitespace-only reason must be refused';
  exception when invalid_parameter_value then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_RETURN_REASON_REQUIRED:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'return', repeat('x', 1001));
    assert false, 'an over-long reason must be refused';
  exception when invalid_parameter_value then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_RETURN_REASON_TOO_LONG:%', 'unexpected refusal: ' || v_msg;
  end;

  v_res := public.transition_task_review(
    current_setting('t.delegated')::uuid, 'return', '  Rates are missing from the annexure.  ');

  assert v_res->>'status' = 'working', 'return must land on working';
  assert v_res->>'completed_at' is null, 'completed_at must stay null on return';
  assert exists (
    select 1 from public.task_activity_log
     where task_id = current_setting('t.delegated')::uuid
       and from_status::text = 'pending_approval' and to_status::text = 'working'
       and note = 'Rates are missing from the annexure.'),
    'the return reason must be recorded, trimmed, on the activity row';
  assert exists (
    select 1 from public.notifications
     where task_id = current_setting('t.delegated')::uuid
       and user_id = current_setting('test.assignee_id')::uuid
       and title like '%returned task to Working'),
    'the assignee must be told, by name, that the task came back';

  -- The assignee corrects and resubmits.
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  v_res := public.transition_task_review(current_setting('t.delegated')::uuid, 'submit');
  assert v_res->>'status' = 'pending_approval', 'a returned task must be submittable again';

  -- The creator approves.
  perform pg_temp.act_as(current_setting('test.creator_id'));
  v_res := public.transition_task_review(current_setting('t.delegated')::uuid, 'approve');
  assert v_res->>'status' = 'completed', 'approve must complete the task';
  assert v_res->>'completed_at' is not null, 'completed_at is set ONLY on approval';
  assert (select completed_at is not null from public.tasks
           where id = current_setting('t.delegated')::uuid),
    'the stored row must carry completed_at';
  assert exists (
    select 1 from public.notifications
     where task_id = current_setting('t.delegated')::uuid
       and user_id = current_setting('test.assignee_id')::uuid
       and title like '%approved and completed task'),
    'the assignee must be told their work was accepted';

  -- No second approval.
  begin
    perform public.transition_task_review(current_setting('t.delegated')::uuid, 'approve');
    assert false, 'a completed task must not be approved twice';
  exception when object_not_in_prerequisite_state then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_INVALID_SOURCE:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

-- ── 7. What the rule deliberately does NOT reach ─────────────────────────────

do $$
declare v_msg text;
begin
  -- A self task stays directly completable by the one person on it.
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  update public.tasks set status = 'completed', completed_at = now()
   where id = current_setting('t.self')::uuid;
  assert (select status::text from public.tasks where id = current_setting('t.self')::uuid) = 'completed',
    'a self task must remain directly completable';

  -- A quotation request keeps its own completion workflow.
  update public.tasks set status = 'completed', completed_at = now()
   where id = current_setting('t.quote')::uuid;
  assert (select status::text from public.tasks where id = current_setting('t.quote')::uuid) = 'completed',
    'a quotation request must remain directly completable';

  -- …and it is refused by the review function, which is not its path.
  begin
    perform public.transition_task_review(current_setting('t.quote')::uuid, 'submit');
    assert false, 'a quotation request must not enter the approval workflow';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_NOT_APPLICABLE:%', 'unexpected refusal: ' || v_msg;
  end;

  -- A self task is refused too — there is nobody to approve to.
  begin
    perform public.transition_task_review(current_setting('t.self')::uuid, 'submit');
    assert false, 'a self task must not enter the approval workflow';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_REVIEW_NOT_DELEGATED:%', 'unexpected refusal: ' || v_msg;
  end;

  -- An identity-less session — the service role, as /api/cancel-task and
  -- /api/restore-task use it — is exempt, which is what keeps restore working.
  perform pg_temp.act_as(null);
  update public.tasks set status = 'working', completed_at = null
   where id = current_setting('t.delegated')::uuid;
  assert (select status::text from public.tasks where id = current_setting('t.delegated')::uuid) = 'working',
    'the service role must still be able to restore an approved task';
end $$;

-- ── 8. Ownership cannot be rewritten to dodge the rule ───────────────────────

do $$
declare v_msg text;
begin
  perform pg_temp.act_as(current_setting('test.assignee_id'));
  begin
    update public.tasks set created_by = current_setting('test.assignee_id')::uuid
     where id = current_setting('t.delegated')::uuid;
    assert false, 'a client session must not be able to re-attribute a task';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_OWNERSHIP_IMMUTABLE:%', 'unexpected refusal: ' || v_msg;
  end;

  begin
    update public.tasks
       set created_by = current_setting('test.assignee_id')::uuid,
           status     = 'completed'
     where id = current_setting('t.delegated')::uuid;
    assert false, 'the same statement must not be able to re-attribute AND complete';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_OWNERSHIP_IMMUTABLE:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

-- ── 9. The review flag does not leak past the function ───────────────────────

do $$
declare v_msg text;
begin
  assert coalesce(nullif(current_setting('boe.task_review_context', true), ''), '') = '',
    'the review flag must be cleared when the function returns';

  perform pg_temp.act_as(current_setting('test.assignee_id'));
  begin
    update public.tasks set status = 'completed'
     where id = current_setting('t.delegated')::uuid;
    assert false, 'nothing later in the transaction may ride on a spent review flag';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    assert v_msg like 'TASK_APPROVAL_REQUIRED:%', 'unexpected refusal: ' || v_msg;
  end;
end $$;

-- ── 10. Grants ───────────────────────────────────────────────────────────────

do $$
begin
  assert     has_function_privilege('authenticated', 'public.transition_task_review(uuid, text, text)', 'execute'),
    'authenticated must be able to call the review function';
  assert not has_function_privilege('anon', 'public.transition_task_review(uuid, text, text)', 'execute'),
    'anon must NOT be able to call the review function';
  assert not has_function_privilege('anon', 'public.in_task_review()', 'execute'),
    'anon must not be able to read the review context';
  assert not has_function_privilege('authenticated', 'public.in_task_review()', 'execute'),
    'authenticated must not be able to read the review context';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;

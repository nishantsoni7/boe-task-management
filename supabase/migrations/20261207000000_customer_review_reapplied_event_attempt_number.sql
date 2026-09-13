-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — a reapplied event records the right attempt number.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. 20261206000000 (applied) wrote, in
-- customer_review_custom_submissions_trail():
--
--     'attempt', new.reapplication_count + 1
--
-- The trigger runs AFTER the UPDATE, so new.reapplication_count already counts
-- the reapplication being recorded: the first reapplication was written as
-- attempt 2.
--
-- THE REPAIR. The function re-created with that one expression changed to
--
--     'attempt', new.reapplication_count
--
-- Everything else is the 20261206000000 §6 body unchanged: the signature,
-- SECURITY DEFINER, search_path, every history event, the notification wording
-- and its recipients. CREATE OR REPLACE keeps the owner, the grants and the
-- trigger that calls it; the revoke is restated exactly as 20261206000000 has it.
--
-- NOT CHANGED. 20261206000000 is applied and is not edited. History rows already
-- written keep what they say — customer_review_custom_submission_events is
-- append-only.
--
-- ROLLBACK: re-apply 20261206000000 §6 (this function only).

create or replace function public.customer_review_custom_submissions_trail()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind  text;
  v_name  text;
  v_type  text;
  v_title text;
  v_body  text;
begin
  if tg_op = 'INSERT' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'submitted', new.submitted_by,
            jsonb_build_object('review_type', new.review_type, 'published_on', new.published_on),
            new.submitted_at);
    v_kind := 'customer_review_submitted';

  elsif old.status = 'pending_verification' and new.status = 'approved' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'approved', new.approved_by,
            jsonb_build_object('credits_awarded', new.credits_awarded, 'credit_transaction_id', new.credit_transaction_id),
            coalesce(new.approved_at, now()));
    return null;

  elsif old.status = 'pending_verification' and new.status = 'rejected' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, reason, created_at)
    values (new.id, 'rejected', new.rejected_by, new.rejection_reason, coalesce(new.rejected_at, now()));
    return null;

  elsif old.status = 'rejected' and new.status = 'pending_verification' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, note, details, created_at)
    values (new.id, 'reapplied', new.submitted_by, new.candidate_note,
            jsonb_build_object(
              'attempt', new.reapplication_count,
              'previous', jsonb_build_object(
                'review_type', old.review_type, 'published_on', old.published_on, 'remark', old.remark,
                'proof_storage_path', old.proof_storage_path, 'proof_file_name', old.proof_file_name,
                'rejection_reason', old.rejection_reason, 'rejected_by', old.rejected_by, 'rejected_at', old.rejected_at
              ),
              'current', jsonb_build_object(
                'review_type', new.review_type, 'published_on', new.published_on, 'remark', new.remark,
                'proof_storage_path', new.proof_storage_path, 'proof_file_name', new.proof_file_name
              ),
              'proof_replaced', old.proof_storage_path is distinct from new.proof_storage_path
            ),
            coalesce(new.last_reapplied_at, now()));
    v_kind := 'customer_review_reapplied';

  else
    return null;
  end if;

  -- The notification: who, which type, that it needs a decision. No review
  -- content and no note — those are on the submission, for the people who may
  -- read it.
  select full_name into v_name from public.users where id = new.submitted_by;
  v_type := case new.review_type when 'image' then 'Image' else 'Text' end;
  if v_kind = 'customer_review_submitted' then
    v_title := format('%s submitted a custom %s Review for approval.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := new.submission_ref;
  else
    v_title := format('%s reapplied a rejected custom %s Review for approval.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := format('%s · reapplication %s', new.submission_ref, new.reapplication_count);
  end if;

  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select r.user_id, null, new.id, v_kind::notification_type, v_title, v_body, true
    from public.customer_review_custom_reviewer_ids(new.submitted_by) r;

  return null;
end;
$$;

revoke execute on function public.customer_review_custom_submissions_trail() from public, anon, authenticated;

-- ═══ Assertions ═══════════════════════════════════════════════════════════

do $$
declare
  v_src text;
  v_def boolean;
  v_cfg text[];
begin
  select prosrc, prosecdef, proconfig into v_src, v_def, v_cfg
    from pg_proc where oid = to_regprocedure('public.customer_review_custom_submissions_trail()');
  if v_src is null then
    raise exception 'CUSTOM_REVIEW_ATTEMPT: customer_review_custom_submissions_trail() is missing';
  end if;
  if position('''attempt'', new.reapplication_count,' in v_src) = 0
     or position('reapplication_count + 1' in v_src) <> 0 then
    raise exception 'CUSTOM_REVIEW_ATTEMPT: the trail does not record attempt = new.reapplication_count';
  end if;
  if not v_def or v_cfg is null or not ('search_path=public, pg_temp' = any(v_cfg)) then
    raise exception 'CUSTOM_REVIEW_ATTEMPT: the trail lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('authenticated', 'public.customer_review_custom_submissions_trail()', 'EXECUTE')
     or has_function_privilege('anon', 'public.customer_review_custom_submissions_trail()', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_ATTEMPT: a client role can execute the trail function';
  end if;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.customer_review_custom_submissions'::regclass
       and tgname = 'customer_review_custom_submissions_trail' and not tgisinternal
  ) then
    raise exception 'CUSTOM_REVIEW_ATTEMPT: the trail trigger is missing';
  end if;
end $$;

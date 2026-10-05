-- Reviews — an administrator may reject an APPROVED custom review, and delete any custom review.
--
-- WHAT THIS ADDS
-- --------------
--   customer_review_custom_is_admin(uuid)                       internal: an active, non-deleted users.role = 'admin'
--   admin_reject_customer_review_custom_submission(uuid, text)  Admin: approved -> rejected, reason required, credit reversed once
--   admin_delete_customer_review_custom_submission(uuid)        Admin: soft delete of ANY custom review, any status
--   customer_review_custom_submissions_guard()    re-created: the one extra move approved -> rejected, only through the function above
--   customer_review_custom_submissions_trail()    re-created: the history rows now say what the status was before, and who deleted
--
-- WHY A SEPARATE FUNCTION FOR AN APPROVED REVIEW. reject_customer_review_custom_submission() is the
-- verifier's decision on a PENDING review and refuses an approved one ("a decided review is final").
-- Taking an approval back is a different, rarer act with a different authority (an administrator,
-- not any holder of `verify`), so it is its own function and the guard names it.
--
-- NOTHING IS HARD-DELETED AND NO HISTORY IS REWRITTEN. The row, its screenshot, its flags and its
-- append-only history stay. The original 'approved' event is untouched; the new 'rejected' event
-- records the previous status, the new status, the administrator, the time and the reason, and
-- the approval it took back (who approved, when, how many credits).
--
-- CREDITS. The existing ledger rules are used as they are, through reverse_customer_review_custom_reward():
-- one reversal of the one review_reward, posted for the employee; a review whose month already
-- LAPSED is not reversed a second time (the lapse removed that credit); a repeat posts nothing. No
-- payroll adjustment and no new ledger row type is invented. After the reversal the ORIGINAL review
-- month (the Asia/Kolkata month of submitted_at, the month the reward was attributed to — never the
-- month of the rejection) is recounted with refresh_boe_credit_review_month(), so that month's
-- "approved reviews" and its monthly target drop at once. A month that already QUALIFIED stays
-- qualified (the existing rule: a status never moves back).
--
-- ONE MOVE ONLY. The guard still refuses every other change to a decided review. approved -> rejected
-- is allowed when the transaction was opened by admin_reject_…() (a transaction-local marker naming
-- this row, set by that function after it checked the caller is an administrator, and the rejecting
-- user is checked again) — or, as before, when decide_customer_review_custom_duplicate() recorded a
-- Duplicate decision in the same transaction. Clients hold no table privilege, so the marker cannot
-- be set from outside a function.
--
-- CONCURRENCY. Both functions lock the review row first (the order approve, reject and the employee's
-- delete use), then the credits lock inside the reversal helper. Two administrators clicking together,
-- a double click, a retry after a dropped response and a click racing an employee's delete or edit all
-- run one after the other: the second sees the committed result and answers 'already rejected' / 'already
-- deleted' (nothing posted, no second history row) or is refused (an edited review is pending again,
-- a deleted one no longer exists).
--
-- PRODUCTION SAFETY. No column, table or row is changed. Two functions are added and two are re-created
-- with the same signatures (privileges are kept by CREATE OR REPLACE). Re-runnable.
--
-- ROLLBACK
--   drop function if exists public.admin_reject_customer_review_custom_submission(uuid, text);
--   drop function if exists public.admin_delete_customer_review_custom_submission(uuid);
--   drop function if exists public.customer_review_custom_is_admin(uuid);
--   -- then re-apply 20270224000000 §8 (guard) and §9 (trail) for the previous bodies.
--   -- Reviews already rejected or deleted by an administrator stay rejected / deleted: the history
--   -- names them, and a reversed credit is not restored (one reward, one reversal).

-- ═══ 1. The authority ═════════════════════════════════════════════════════
--
-- An active, non-deleted administrator — the same predicate can_manage_boe_credits() and the test-record
-- purge use, taken for an explicit user so the guard can ask about the person who rejected.

create or replace function public.customer_review_custom_is_admin(p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select p_user_id is not null and exists (
    select 1
      from public.users u
     where u.id = p_user_id
       and u.role::text = 'admin'
       and u.is_active = true
       and coalesce(u.is_deleted, false) = false
  );
$$;

comment on function public.customer_review_custom_is_admin(uuid) is
  'Internal. True for an active, non-deleted admin. Authorizes only the administrator''s rejection of an approved custom review and the administrator''s deletion of a custom review.';

revoke execute on function public.customer_review_custom_is_admin(uuid) from public, anon, authenticated, service_role;

-- ═══ 2. The guard, re-created ═════════════════════════════════════════════

create or replace function public.customer_review_custom_submissions_guard()
returns trigger
language plpgsql
as $$
declare
  v_decision text[] := array[
    'status', 'approved_by', 'approved_at', 'credits_awarded', 'credit_transaction_id',
    'rejected_by', 'rejected_at', 'rejection_reason', 'updated_at',
    'reward_held', 'reward_reversal_transaction_id'
  ];
  v_reapply text[] := array[
    'status', 'approved_by', 'approved_at', 'credits_awarded', 'credit_transaction_id',
    'rejected_by', 'rejected_at', 'rejection_reason', 'updated_at',
    'review_type', 'published_on', 'remark',
    'proof_storage_path', 'proof_file_name', 'proof_mime_type', 'proof_byte_size', 'proof_content_sha256',
    'reviewer_name', 'review_text', 'reviewer_name_norm', 'review_text_norm', 'proof_phash',
    'candidate_note', 'reapplication_count', 'last_reapplied_at'
  ];
  v_edit text[] := array[
    'status', 'updated_at', 'reward_held',
    'review_type', 'published_on', 'remark',
    'proof_storage_path', 'proof_file_name', 'proof_mime_type', 'proof_byte_size', 'proof_content_sha256',
    'reviewer_name', 'review_text', 'reviewer_name_norm', 'review_text_norm', 'proof_phash',
    'edit_count', 'last_edited_at'
  ];
  v_delete text[] := array['deleted_at', 'deleted_by', 'reward_reversal_transaction_id', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a custom review submission is never deleted — it is the audit record'
      using errcode = '42501';
  end if;

  -- BACKFILL of the image hash for a review from before duplicate detection: the
  -- one column that goes from null to a value with nothing else changing, on any
  -- row (a deleted one included — it is comparison evidence). Written only by
  -- backfill_customer_review_custom_proof_phash().
  if old.proof_phash is null and new.proof_phash is not null
     and (to_jsonb(new) - 'proof_phash' - 'updated_at') = (to_jsonb(old) - 'proof_phash' - 'updated_at') then
    return new;
  end if;

  if old.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a deleted custom review submission is kept as it was'
      using errcode = '42501';
  end if;

  if new.deleted_at is not null then
    if (to_jsonb(new) - v_delete) <> (to_jsonb(old) - v_delete) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a delete may change nothing but the delete stamp'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.edit_count <> old.edit_count then
    if new.edit_count <> old.edit_count + 1 or new.last_edited_at is null then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: an edit is counted exactly once'
        using errcode = '42501';
    end if;
    if not (old.status in ('pending_verification', 'approved') and new.status = 'pending_verification') then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: only a pending or approved review can be edited'
        using errcode = '42501';
    end if;
    if (to_jsonb(new) - v_edit) <> (to_jsonb(old) - v_edit) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: an edit may change only the employee''s own content'
        using errcode = '42501';
    end if;
    if old.status = 'approved' and (new.review_type <> old.review_type or new.reward_held is not true) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: an approved review keeps its type and holds its credit while it is edited'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if old.status = 'rejected' and new.status = 'pending_verification' then
    if (to_jsonb(new) - v_reapply) <> (to_jsonb(old) - v_reapply) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a reapplication may change only the candidate''s corrections'
        using errcode = '42501';
    end if;
    if new.reapplication_count <> old.reapplication_count + 1
       or new.last_reapplied_at is null
       or new.last_reapplied_at is not distinct from old.last_reapplied_at then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a reapplication is counted exactly once'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- AN APPROVED REVIEW MAY BE REJECTED in exactly two ways: a confirmed duplicate, through
  -- decide_customer_review_custom_duplicate() (a 'duplicate' decision on one of its flags recorded in
  -- THIS transaction), or an administrator, through admin_reject_customer_review_custom_submission().
  if old.status = 'approved' and new.status = 'rejected' then
    if not exists (
      select 1 from public.customer_review_custom_duplicate_flags fl
       where fl.submission_id = old.id and fl.decision = 'duplicate' and fl.decided_at = now()
    ) and not (
      -- ADMINISTRATOR'S REJECTION OF AN APPROVED REVIEW: the marker names this row and was set, in this
      -- transaction, by admin_reject_customer_review_custom_submission(); the rejecting user is an
      -- administrator. coalesce: an unset marker is NULL, and NULL would let the test pass.
      coalesce(current_setting('boe.custom_review_admin_reject', true), '') = old.id::text
      and public.customer_review_custom_is_admin(new.rejected_by)
    ) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a decided custom review submission is final'
        using errcode = '42501';
    end if;
    if (to_jsonb(new) - v_decision) <> (to_jsonb(old) - v_decision) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: only the decision on a custom review submission may change'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if old.status <> 'pending_verification' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a decided custom review submission is final'
      using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_decision) <> (to_jsonb(old) - v_decision) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: only the decision on a custom review submission may change'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.customer_review_custom_submissions_guard() from public, anon, authenticated;

-- ═══ 3. The history, re-created ═══════════════════════════════════════════
--
-- Same body as 20270224000000 §9; the only additions are the details of the 'rejected' event (what the
-- status was before, which approval was taken back) and 'by_owner' on the 'deleted' event.

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

  elsif old.deleted_at is null and new.deleted_at is not null then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'deleted', new.deleted_by,
            jsonb_build_object(
              'by_owner', new.deleted_by = new.submitted_by,
              'status_at_delete', old.status,
              'credits_awarded', old.credits_awarded,
              'credits_reversed', new.reward_reversal_transaction_id is not null,
              'reversal_transaction_id', new.reward_reversal_transaction_id
            ),
            new.deleted_at);
    return null;

  elsif new.edit_count = old.edit_count + 1 then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'edited', new.submitted_by,
            jsonb_build_object(
              'edit', new.edit_count,
              'status_before', old.status,
              'sent_back_for_approval', old.status = 'approved',
              'credit_held', new.reward_held,
              'previous', jsonb_build_object(
                'review_type', old.review_type, 'published_on', old.published_on, 'remark', old.remark,
                'reviewer_name', old.reviewer_name, 'review_text', old.review_text,
                'proof_storage_path', old.proof_storage_path, 'proof_file_name', old.proof_file_name
              ),
              'current', jsonb_build_object(
                'review_type', new.review_type, 'published_on', new.published_on, 'remark', new.remark,
                'reviewer_name', new.reviewer_name, 'review_text', new.review_text,
                'proof_storage_path', new.proof_storage_path, 'proof_file_name', new.proof_file_name
              ),
              'proof_replaced', old.proof_storage_path is distinct from new.proof_storage_path
            ),
            coalesce(new.last_edited_at, now()));
    if old.status <> 'approved' then
      return null;
    end if;
    v_kind := 'customer_review_reapplied';

  elsif old.status = 'pending_verification' and new.status = 'approved' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, details, created_at)
    values (new.id, 'approved', new.approved_by,
            jsonb_build_object(
              'credits_awarded', new.credits_awarded,
              'credit_transaction_id', new.credit_transaction_id,
              'reaffirmed_after_edit', old.reward_held
            ),
            coalesce(new.approved_at, now()));
    return null;

  elsif old.status in ('pending_verification', 'approved') and new.status = 'rejected' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, reason, details, created_at)
    values (new.id, 'rejected', new.rejected_by, new.rejection_reason,
            jsonb_build_object(
              'previous_status', old.status,
              'new_status', 'rejected',
              'reversed_approval', old.status = 'approved',
              'previous_approved_by', old.approved_by,
              'previous_approved_at', old.approved_at,
              'previous_credits_awarded', old.credits_awarded,
              'credit_reversed', new.reward_reversal_transaction_id is not null,
              'reversal_transaction_id', new.reward_reversal_transaction_id
            ),
            coalesce(new.rejected_at, now()));
    return null;

  elsif old.status = 'rejected' and new.status = 'pending_verification' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, note, details, created_at)
    values (new.id, 'reapplied', new.submitted_by, new.candidate_note,
            jsonb_build_object(
              'attempt', new.reapplication_count,
              'previous', jsonb_build_object(
                'review_type', old.review_type, 'published_on', old.published_on, 'remark', old.remark,
                'reviewer_name', old.reviewer_name, 'review_text', old.review_text,
                'proof_storage_path', old.proof_storage_path, 'proof_file_name', old.proof_file_name,
                'rejection_reason', old.rejection_reason, 'rejected_by', old.rejected_by, 'rejected_at', old.rejected_at
              ),
              'current', jsonb_build_object(
                'review_type', new.review_type, 'published_on', new.published_on, 'remark', new.remark,
                'reviewer_name', new.reviewer_name, 'review_text', new.review_text,
                'proof_storage_path', new.proof_storage_path, 'proof_file_name', new.proof_file_name
              ),
              'proof_replaced', old.proof_storage_path is distinct from new.proof_storage_path
            ),
            coalesce(new.last_reapplied_at, now()));
    v_kind := 'customer_review_reapplied';

  else
    return null;
  end if;

  select full_name into v_name from public.users where id = new.submitted_by;
  v_type := case new.review_type when 'image' then 'Image' else 'Text' end;
  if v_kind = 'customer_review_submitted' then
    v_title := format('%s submitted a custom %s Review for approval.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := new.submission_ref;
  elsif tg_op = 'UPDATE' and new.edit_count = old.edit_count + 1 then
    v_title := format('%s edited an approved custom %s Review; it needs approval again.', coalesce(nullif(btrim(v_name), ''), 'An employee'), v_type);
    v_body  := format('%s · edit %s · credit stays in balance', new.submission_ref, new.edit_count);
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

-- ═══ 4. Administrator: reject an approved review ══════════════════════════

create or replace function public.admin_reject_customer_review_custom_submission(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s            public.customer_review_custom_submissions%rowtype;
  v_uid        uuid := auth.uid();
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_credit_id  uuid;
  v_had_credit boolean;
  v_reversal   uuid;
  v_employee   uuid;
  v_month      date;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not public.customer_review_custom_is_admin(v_uid) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Only an administrator can reject an approved review'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Give a short reason for rejecting' using errcode = '22023';
  end if;
  if length(v_reason) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the reason under 300 characters' using errcode = '22023';
  end if;

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by = v_uid then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_SELF: You cannot approve or reject your own submission'
      using errcode = '42501';
  end if;

  -- A repeat (double click, second tab, retry after a lost answer): nothing more happens.
  if s.status = 'rejected' then
    return jsonb_build_object('submission', to_jsonb(s), 'already_decided', true,
                              'credit_reversed', false, 'credit_expired', false);
  end if;
  -- Anything but an approved review has its own path (the ordinary Reject for a pending one;
  -- an edited review is pending again — refresh and decide it there).
  if s.status <> 'approved' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_APPROVED: This review is not approved any more. Refresh the list and use Reject on a pending review.'
      using errcode = '55000';
  end if;

  v_credit_id  := s.credit_transaction_id;
  v_had_credit := v_credit_id is not null and s.reward_reversal_transaction_id is null;

  -- The ORIGINAL review month and employee, read before the row stops pointing at the credit.
  select m.employee_id, m.review_month into v_employee, v_month
    from public.boe_credit_review_rewards r
    join public.boe_credit_review_months m on m.id = r.review_month_id
   where r.transaction_id = v_credit_id;

  if v_had_credit then
    v_reversal := public.reverse_customer_review_custom_reward(s.id, v_uid, 'Approval taken back by an administrator');
  end if;

  perform set_config('boe.custom_review_admin_reject', s.id::text, true);

  update public.customer_review_custom_submissions
     set status                         = 'rejected',
         rejected_by                    = v_uid,
         rejected_at                    = now(),
         rejection_reason               = v_reason,
         approved_by                    = null,
         approved_at                    = null,
         credits_awarded                = null,
         credit_transaction_id          = null,
         reward_held                    = false,
         reward_reversal_transaction_id = coalesce(v_reversal, reward_reversal_transaction_id)
   where id = s.id
   returning * into s;

  perform set_config('boe.custom_review_admin_reject', '', true);

  -- The month the review was counted in — not this month — is recounted.
  if v_employee is not null then
    perform public.refresh_boe_credit_review_month(v_employee, v_month);
  end if;

  return jsonb_build_object('submission', to_jsonb(s), 'already_decided', false,
                            'credit_reversed', v_reversal is not null,
                            'credit_expired', v_had_credit and v_reversal is null,
                            'review_month', v_month);
end;
$$;

revoke execute on function public.admin_reject_customer_review_custom_submission(uuid, text) from public, anon;
grant  execute on function public.admin_reject_customer_review_custom_submission(uuid, text) to authenticated;

comment on function public.admin_reject_customer_review_custom_submission(uuid, text) is
  'ADMINISTRATOR ONLY (active users.role = admin, checked here, not by the screen). Rejects an APPROVED custom review with a required reason: the row, screenshot and history stay, the credit is reversed once through the ledger helper, and the review''s ORIGINAL month is recounted. Repeats answer already_decided. Never the administrator''s own review.';

-- ═══ 5. Administrator: delete any review ══════════════════════════════════

create or replace function public.admin_delete_customer_review_custom_submission(
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s            public.customer_review_custom_submissions%rowtype;
  v_uid        uuid := auth.uid();
  v_credit_id  uuid;
  v_had_credit boolean;
  v_reversal   uuid;
  v_employee   uuid;
  v_month      date;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not public.customer_review_custom_is_admin(v_uid) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Only an administrator can delete another employee''s review'
      using errcode = '42501';
  end if;

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  -- Idempotent: a second click, a retry or a second administrator reverses nothing more.
  if s.deleted_at is not null then
    return jsonb_build_object('submission', to_jsonb(s), 'already_deleted', true,
                              'credit_reversed', false, 'credit_expired', false);
  end if;

  v_credit_id  := s.credit_transaction_id;
  v_had_credit := v_credit_id is not null and s.reward_reversal_transaction_id is null;

  select m.employee_id, m.review_month into v_employee, v_month
    from public.boe_credit_review_rewards r
    join public.boe_credit_review_months m on m.id = r.review_month_id
   where r.transaction_id = v_credit_id;

  -- An approved review, or an edited one holding its credit: reversed once, here. Null when the
  -- month lapsed (the lapse already removed it).
  if v_had_credit then
    v_reversal := public.reverse_customer_review_custom_reward(s.id, v_uid, 'Custom review deleted by an administrator');
  end if;

  update public.customer_review_custom_submissions
     set deleted_at = now(),
         deleted_by = v_uid,
         reward_reversal_transaction_id = coalesce(v_reversal, reward_reversal_transaction_id)
   where id = s.id
   returning * into s;

  if v_employee is not null then
    perform public.refresh_boe_credit_review_month(v_employee, v_month);
  end if;

  return jsonb_build_object('submission', to_jsonb(s), 'already_deleted', false,
                            'credit_reversed', v_reversal is not null,
                            'credit_expired', v_had_credit and v_reversal is null,
                            'review_month', v_month);
end;
$$;

revoke execute on function public.admin_delete_customer_review_custom_submission(uuid) from public, anon;
grant  execute on function public.admin_delete_customer_review_custom_submission(uuid) to authenticated;

comment on function public.admin_delete_customer_review_custom_submission(uuid) is
  'ADMINISTRATOR ONLY (checked here). Soft-deletes any custom review in any status: stamps deleted_at / deleted_by, keeps the row, proof and history, frees the monthly slot, reverses a posted credit once (nothing when the month lapsed) and recounts the review''s original month. Idempotent. The employee''s own delete keeps its own function.';

-- ═══ 6. Assertions ════════════════════════════════════════════════════════

do $$
begin
  if has_function_privilege('anon', 'public.admin_reject_customer_review_custom_submission(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.admin_delete_customer_review_custom_submission(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customer_review_custom_is_admin(uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.customer_review_custom_is_admin(uuid)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_ADMIN_ACTIONS: a role holds a privilege it must not';
  end if;
  if not has_function_privilege('authenticated', 'public.admin_reject_customer_review_custom_submission(uuid, text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.admin_delete_customer_review_custom_submission(uuid)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_ADMIN_ACTIONS: the administrator functions are not callable';
  end if;
  if has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'DELETE') then
    raise exception 'CUSTOM_REVIEW_ADMIN_ACTIONS: a client role holds a table write';
  end if;
end $$;

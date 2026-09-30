-- ═══════════════════════════════════════════════════════════════════════════
-- Review Workflow — an employee edits or deletes THEIR OWN custom review.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS ADDS
-- --------------
--   customer_review_custom_submissions   + deleted_at / deleted_by        (soft delete: the row stays)
--                                        + edit_count / last_edited_at    (edit history counter)
--                                        + reward_held                    (an edited APPROVED review keeps its
--                                                                          credit while it waits for re-approval)
--                                        + reward_reversal_transaction_id (the ledger reversal, when one was posted)
--   public.edit_customer_review_custom_submission()     SERVICE ROLE ONLY (PUT route)
--   public.delete_customer_review_custom_submission()   SERVICE ROLE ONLY (DELETE route)
--   public.reverse_customer_review_custom_reward()      internal: the one ledger reversal for a review's reward
--   approve / reject / reapply / create / month_usage   re-created (see "WHAT CHANGES IN EXISTING FUNCTIONS")
--   the trail trigger                                   + 'edited' and 'deleted' history events
--   the SELECT policy                                   a deleted row is hidden from its owner, kept for verifiers
--
-- THE RULES, STATED ONCE
-- ----------------------
--   OWNERSHIP. Only the submitter may edit or delete a review: the route takes
--   the actor from the session, the function compares it with submitted_by and
--   refuses anyone else (administrators included) with CUSTOMER_REVIEW_CUSTOM_NOT_OWNER.
--   No client role can write the table (unchanged); the two functions are
--   service-role only, so a browser cannot call them directly either.
--
--   WHICH REVIEWS.
--     pending_verification  edit in place; stays pending; the queue position and
--                           submission date do not move.
--     rejected              corrected through the existing Edit & Reapply (PATCH);
--                           the new edit path refuses it so there is one way in.
--     approved              edit sends it BACK TO APPROVAL: status becomes
--                           pending_verification, reward_held = true. See below.
--
--   AN EDITED APPROVED REVIEW — WHY THE CREDIT STAYS PUT.
--     The ledger allows exactly one review_reward per source and one reversal per
--     row; "re-awarding after a reversal is deliberately NOT possible"
--     (20261101000000). So "reverse now, pay again on re-approval" cannot work.
--     Instead the credit already posted STAYS on the ledger while the review is
--     pending again (credits_awarded / credit_transaction_id are kept, reward_held
--     marks them as held). Then:
--       verifier approves again  -> NOTHING is posted; the same credit stands.
--       verifier rejects it      -> the credit is REVERSED, once.
--       employee deletes it      -> the credit is REVERSED, once.
--     The full reward is therefore never paid twice, however often a review is
--     edited. The type (Text/Image) of an approved review cannot change, because
--     it would need a different reward; delete it and submit a new one instead.
--
--   DELETE. A soft delete: deleted_at / deleted_by are stamped, the row, its
--   proof and its history are kept for verifiers, and the employee no longer sees
--   it. An approved review's credit is reversed in the same transaction (one
--   reversal per reward, so repeated requests reverse nothing more). Deleting
--   frees the monthly slot (the deleted row is left out of the month's count).
--   A deleted review stays available as duplicate-check evidence (see the next
--   migration): delete-and-repost does not earn a second reward for the same
--   proof without a warning to the verifier.
--
--   CLOSED MONTH. A review in a month that lapsed cannot be edited (its credit is
--   already gone). It can still be deleted; nothing is reversed a second time.
--
--   REPEATED REQUESTS. Delete is idempotent (a second call returns
--   already_deleted). Edit carries the edit_count the employee opened the form
--   on; a stale count with identical content is treated as the same request
--   already applied, a stale count with different content is refused.
--
-- WHAT CHANGES IN EXISTING FUNCTIONS
-- ----------------------------------
--   * customer_review_custom_month_usage: leaves deleted rows out (frees the slot).
--   * create/reapply: the one-live-proof-per-employee rule ignores deleted rows;
--     reapply refuses a deleted row and a review whose credit was withdrawn.
--   * approve: a review whose credit is held is re-approved WITHOUT a second
--     ledger row; a deleted review cannot be decided.
--   * reject: a review whose credit is held has that credit reversed; a deleted
--     review cannot be decided.
--   * the unique index on (submitted_by, proof_content_sha256) ignores deleted rows.
--
-- PRODUCTION SAFETY. Additive columns (all nullable or defaulted), constraints
-- re-created, functions re-created. No row is rewritten. Re-runnable.
--
-- DEPLOYMENT ORDER. Apply BEFORE the application code: the routes call the new
-- functions and the screens read the new columns.
--
-- ROLLBACK (lossless while no review was edited or deleted)
--   drop function if exists public.delete_customer_review_custom_submission(uuid, uuid);
--   drop function if exists public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text);
--   drop function if exists public.reverse_customer_review_custom_reward(uuid, uuid, text);
--   -- then re-apply 20261206000000 §7–§10 and 20261207000000 for the re-created functions,
--   -- and restore the one SELECT policy from 20261205000000.

-- ═══ 1. Columns ═══════════════════════════════════════════════════════════

alter table public.customer_review_custom_submissions
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.users(id),
  add column if not exists edit_count integer not null default 0 check (edit_count >= 0),
  add column if not exists last_edited_at timestamptz,
  add column if not exists reward_held boolean not null default false,
  add column if not exists reward_reversal_transaction_id uuid unique references public.boe_credit_transactions(id);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_review_custom_submissions'::regclass
                   and conname = 'custom_review_submission_deleted_consistent') then
    alter table public.customer_review_custom_submissions
      add constraint custom_review_submission_deleted_consistent
      check ((deleted_at is null) = (deleted_by is null));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.customer_review_custom_submissions'::regclass
                   and conname = 'custom_review_submission_edited_consistent') then
    alter table public.customer_review_custom_submissions
      add constraint custom_review_submission_edited_consistent
      check (edit_count = 0 or last_edited_at is not null);
  end if;
end $$;

comment on column public.customer_review_custom_submissions.deleted_at is
  'Soft delete by the submitter. The row, its proof and its history are kept for verifiers; the employee no longer sees it and it is left out of every total. Never cleared.';
comment on column public.customer_review_custom_submissions.reward_held is
  'True while an EDITED approved review waits for re-approval: credits_awarded / credit_transaction_id are kept (the credit stays on the ledger, never paid twice). Re-approval clears it without posting; rejection or deletion reverses the credit.';
comment on column public.customer_review_custom_submissions.reward_reversal_transaction_id is
  'The ledger reversal posted when a paid review was deleted or its edit was rejected. Null when nothing was reversed.';

-- A published date may follow the first submission (the review that was actually
-- published), but never the moment of the latest edit or reapplication.
alter table public.customer_review_custom_submissions
  drop constraint if exists custom_review_submission_published_not_after_submission;
alter table public.customer_review_custom_submissions
  add constraint custom_review_submission_published_not_after_submission
  check (published_on <= (
    greatest(submitted_at, coalesce(last_reapplied_at, submitted_at), coalesce(last_edited_at, submitted_at))
    at time zone 'Asia/Kolkata'
  )::date);

-- The decision shape, extended for a held credit.
alter table public.customer_review_custom_submissions
  drop constraint if exists custom_review_submission_decision_consistent;
alter table public.customer_review_custom_submissions
  add constraint custom_review_submission_decision_consistent check (
    case status
      when 'pending_verification' then
        rejected_by is null and rejected_at is null and rejection_reason is null
        and case when reward_held
              then approved_by is not null and approved_at is not null and credits_awarded > 0 and credit_transaction_id is not null
              else approved_by is null and approved_at is null and credits_awarded is null and credit_transaction_id is null
            end
      when 'approved' then
        approved_by is not null and approved_at is not null and credits_awarded > 0 and credit_transaction_id is not null
        and rejected_by is null and rejected_at is null and rejection_reason is null
        and reward_held = false
      when 'rejected' then
        rejected_by is not null and rejected_at is not null
        and rejection_reason is not null and btrim(rejection_reason) <> '' and length(rejection_reason) <= 300
        and approved_by is null and approved_at is null and credits_awarded is null and credit_transaction_id is null
        and reward_held = false
    end
  );

-- One live proof per employee: a deleted review no longer blocks the same
-- screenshot (the duplicate check still sees it as evidence).
drop index if exists public.customer_review_custom_submissions_live_proof_unique;
create unique index customer_review_custom_submissions_live_proof_unique
  on public.customer_review_custom_submissions (submitted_by, proof_content_sha256)
  where status <> 'rejected' and deleted_at is null;

-- ═══ 2. History: two more events ══════════════════════════════════════════

alter table public.customer_review_custom_submission_events
  drop constraint if exists customer_review_custom_submission_events_event_type_check;
alter table public.customer_review_custom_submission_events
  add constraint customer_review_custom_submission_events_event_type_check
  check (event_type in ('submitted', 'rejected', 'reapplied', 'approved', 'edited', 'deleted'));

-- ═══ 3. Visibility ════════════════════════════════════════════════════════
--
-- The owner no longer sees a deleted review; a verifier still does (history,
-- comparison evidence). The history table's policy asks this table, under RLS,
-- so a deleted review's history is hidden from its owner too.

drop policy if exists "customer_review_custom_submissions_select" on public.customer_review_custom_submissions;
create policy "customer_review_custom_submissions_select"
  on public.customer_review_custom_submissions
  for select
  to authenticated
  using (
    public.can_view_customer_review_custom_submission(submitted_by)
    and (deleted_at is null or public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify'))
  );

-- ═══ 4. The guard, re-created ═════════════════════════════════════════════
--
-- Moves this trigger allows, and nothing else:
--   decision      pending -> approved | rejected             (decision columns only)
--   reapply       rejected -> pending                        (unchanged)
--   edit          pending -> pending, approved -> pending    (content columns, edit_count + 1)
--   delete        any status, stamps deleted_at/by           (+ the reversal id); afterwards the row is frozen
-- A hard DELETE is still refused.

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
    'candidate_note', 'reapplication_count', 'last_reapplied_at'
  ];
  v_edit text[] := array[
    'status', 'updated_at', 'reward_held',
    'review_type', 'published_on', 'remark',
    'proof_storage_path', 'proof_file_name', 'proof_mime_type', 'proof_byte_size', 'proof_content_sha256',
    'edit_count', 'last_edited_at'
  ];
  v_delete text[] := array['deleted_at', 'deleted_by', 'reward_reversal_transaction_id', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a custom review submission is never deleted — it is the audit record'
      using errcode = '42501';
  end if;

  -- A deleted review is frozen.
  if old.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a deleted custom review submission is kept as it was'
      using errcode = '42501';
  end if;

  -- SOFT DELETE: only the delete columns change, from null to stamped.
  if new.deleted_at is not null then
    if (to_jsonb(new) - v_delete) <> (to_jsonb(old) - v_delete) then
      raise exception 'CUSTOMER_REVIEW_CUSTOM_APPEND_ONLY: a delete may change nothing but the delete stamp'
        using errcode = '42501';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- EDIT: pending -> pending, or approved -> pending (the credit is held).
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

  -- REAPPLICATION: rejected -> pending, the same row.
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

  -- DECISION: pending -> approved | rejected, decision columns only.
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

-- ═══ 5. The trail, re-created with 'edited' and 'deleted' ═════════════════
--
-- The 20261207000000 body, plus two branches. An edit of a PENDING review adds
-- history only (the review is already in the queue). An edit of an APPROVED
-- review puts it back in the queue, so reviewers are notified with the existing
-- 'customer_review_reapplied' type. A delete adds history and notifies nobody.

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
                'proof_storage_path', old.proof_storage_path, 'proof_file_name', old.proof_file_name
              ),
              'current', jsonb_build_object(
                'review_type', new.review_type, 'published_on', new.published_on, 'remark', new.remark,
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

  elsif old.status = 'pending_verification' and new.status = 'rejected' then
    insert into public.customer_review_custom_submission_events (submission_id, event_type, actor_id, reason, details, created_at)
    values (new.id, 'rejected', new.rejected_by, new.rejection_reason,
            jsonb_build_object(
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

drop trigger if exists customer_review_custom_submissions_trail on public.customer_review_custom_submissions;
create trigger customer_review_custom_submissions_trail
  after insert or update of status, deleted_at, edit_count on public.customer_review_custom_submissions
  for each row execute function public.customer_review_custom_submissions_trail();

-- ═══ 6. The month's slot count leaves deleted reviews out ═════════════════

create or replace function public.customer_review_custom_month_usage(
  p_employee_id  uuid,
  p_review_month date,
  p_excluding    uuid default null
)
returns table (submitted integer, image_reviews integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         (count(*) filter (where s.review_type = 'image'))::integer
    from public.customer_review_custom_submissions s
   where s.submitted_by = p_employee_id
     and s.deleted_at is null
     and s.submitted_at >= (p_review_month::timestamp at time zone 'Asia/Kolkata')
     and s.submitted_at <  ((p_review_month + interval '1 month')::timestamp at time zone 'Asia/Kolkata')
     and (p_excluding is null or s.id <> p_excluding);
$$;

revoke execute on function public.customer_review_custom_month_usage(uuid, date, uuid) from public, anon, authenticated;
grant  execute on function public.customer_review_custom_month_usage(uuid, date, uuid) to service_role;

-- ═══ 7. The one ledger reversal for a review's credit ═════════════════════
--
-- INTERNAL (owner-called by the definer functions below; no client role and not
-- even the service role can call it). post_boe_credit_transaction() allows a
-- reversal only from an administrator, but here the reversing actor is the
-- employee deleting their own review or a verifier rejecting an edit. The row
-- written is exactly the one that function would write — a 'reversal' naming the
-- review_reward it negates — and the ledger's own triggers still run
-- (boe_credit_reversal_guard, boe_credit_reversal_effects: the month recount).
--
-- ONCE. The ledger's uniqueness rule allows one reversal per row; this function
-- also returns the existing reversal when there is one, so a repeated call posts
-- nothing. A reward whose month LAPSED is not reversed (the lapse already
-- removed it; reversing again would take it twice) — the function returns null.

create or replace function public.reverse_customer_review_custom_reward(
  p_submission_id uuid,
  p_actor_id      uuid,
  p_reason        text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s          public.customer_review_custom_submissions%rowtype;
  v_orig     public.boe_credit_transactions%rowtype;
  v_existing uuid;
  v_new      uuid;
begin
  select * into s from public.customer_review_custom_submissions where id = p_submission_id;
  if not found or s.credit_transaction_id is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(s.submitted_by::text));

  select id into v_existing from public.boe_credit_transactions
   where transaction_type = 'reversal' and source_type = 'boe_credit_transaction' and source_id = s.credit_transaction_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if exists (
    select 1 from public.boe_credit_review_rewards r
      join public.boe_credit_review_months m on m.id = r.review_month_id
     where r.transaction_id = s.credit_transaction_id and m.status = 'lapsed'
  ) then
    return null;
  end if;

  select * into v_orig from public.boe_credit_transactions where id = s.credit_transaction_id;
  insert into public.boe_credit_transactions (
    employee_id, transaction_type, credits, source_type, source_id, description, created_by
  ) values (
    v_orig.employee_id, 'reversal', -v_orig.credits, 'boe_credit_transaction', v_orig.id,
    left(coalesce(nullif(btrim(p_reason), ''), 'Custom review reward reversed') || ' · ' || s.submission_ref, 500),
    p_actor_id
  )
  returning id into v_new;
  return v_new;
end;
$$;

revoke execute on function public.reverse_customer_review_custom_reward(uuid, uuid, text) from public, anon, authenticated, service_role;

comment on function public.reverse_customer_review_custom_reward(uuid, uuid, text) is
  'INTERNAL. Posts the one ledger reversal of a custom review''s credit, for the employee who deleted the review or the verifier who rejected its edit. Returns the reversal id, the existing one on a repeat, or null when there is nothing to reverse (no credit, or the month lapsed).';

-- ═══ 8. Create, re-created: a deleted review does not block the same proof ══

create or replace function public.create_customer_review_custom_submission(
  p_submission_id        uuid,
  p_actor_id             uuid,
  p_review_type          text,
  p_published_on         date,
  p_remark               text,
  p_proof_storage_path   text,
  p_proof_file_name      text,
  p_proof_mime_type      text,
  p_proof_byte_size      integer,
  p_proof_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_month  date := date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date;
  v_remark text := nullif(btrim(coalesce(p_remark, '')), '');
  v_row    public.customer_review_custom_submissions%rowtype;
begin
  if p_actor_id is null or not exists (
    select 1 from public.users
     where id = p_actor_id and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;
  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'use') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: You do not have permission to submit a custom review'
      using errcode = '42501';
  end if;

  if p_submission_id is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The submission could not be identified'
      using errcode = '22023';
  end if;
  if p_review_type is null or p_review_type not in ('text', 'image') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Choose a Text-based or Image-based review'
      using errcode = '22023';
  end if;
  if p_published_on is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Enter the date the review was published'
      using errcode = '22023';
  end if;
  if p_published_on > v_today then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The published date cannot be in the future'
      using errcode = '22023';
  end if;
  if v_remark is not null and length(v_remark) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the remark under 300 characters'
      using errcode = '22023';
  end if;
  if p_proof_storage_path is null or split_part(p_proof_storage_path, '/', 1) <> p_submission_id::text then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: A screenshot of the published review is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));
  perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, null, null);

  if exists (
    select 1 from public.customer_review_custom_submissions
     where submitted_by = p_actor_id
       and proof_content_sha256 = p_proof_content_sha256
       and status <> 'rejected'
       and deleted_at is null
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end if;

  begin
    insert into public.customer_review_custom_submissions (
      id, submitted_by, review_type, published_on, remark,
      proof_storage_path, proof_file_name, proof_mime_type, proof_byte_size, proof_content_sha256
    ) values (
      p_submission_id, p_actor_id, p_review_type, p_published_on, v_remark,
      p_proof_storage_path, p_proof_file_name, p_proof_mime_type, p_proof_byte_size, p_proof_content_sha256
    )
    returning * into v_row;
  exception when unique_violation then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  return to_jsonb(v_row);
end;
$$;

revoke execute on function public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)
  from public, anon, authenticated;
grant  execute on function public.create_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, integer, text)
  to service_role;

-- ═══ 9. Reapply, re-created: not a deleted review, not a withdrawn credit ═══

create or replace function public.reapply_customer_review_custom_submission(
  p_submission_id        uuid,
  p_actor_id             uuid,
  p_review_type          text,
  p_published_on         date,
  p_remark               text,
  p_candidate_note       text,
  p_proof_storage_path   text,
  p_proof_file_name      text,
  p_proof_mime_type      text,
  p_proof_byte_size      integer,
  p_proof_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_remark   text := nullif(btrim(coalesce(p_remark, '')), '');
  v_note     text := nullif(btrim(coalesce(p_candidate_note, '')), '');
  v_new_path boolean := p_proof_storage_path is not null;
  v_month    date;
  s          public.customer_review_custom_submissions%rowtype;
  v_previous text;
begin
  if p_actor_id is null or not exists (
    select 1 from public.users
     where id = p_actor_id and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;
  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'use') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: You do not have permission to submit a custom review'
      using errcode = '42501';
  end if;

  if p_review_type is null or p_review_type not in ('text', 'image') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Choose a Text-based or Image-based review'
      using errcode = '22023';
  end if;
  if p_published_on is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Enter the date the review was published'
      using errcode = '22023';
  end if;
  if p_published_on > v_today then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The published date cannot be in the future'
      using errcode = '22023';
  end if;
  if v_remark is not null and length(v_remark) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the remark under 300 characters'
      using errcode = '22023';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the note under 500 characters'
      using errcode = '22023';
  end if;
  if v_new_path and (
       split_part(p_proof_storage_path, '/', 1) <> p_submission_id::text
       or p_proof_file_name is null or p_proof_mime_type is null
       or p_proof_byte_size is null or p_proof_content_sha256 is null
     ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The new screenshot does not belong to this review'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by <> p_actor_id then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: You can only reapply your own review' using errcode = '42501';
  end if;

  if s.status = 'pending_verification' then
    return jsonb_build_object('submission', to_jsonb(s), 'already_pending', true, 'previous_proof_storage_path', null);
  end if;
  if s.status = 'approved' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This review was already approved' using errcode = '55000';
  end if;
  if s.reward_reversal_transaction_id is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: The credit for this review was already withdrawn (its edit was rejected, or it was confirmed a duplicate), and a review is paid only once. Submit it again as a new review.'
      using errcode = '55000';
  end if;

  v_month := date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date;
  if exists (
    select 1 from public.boe_credit_review_months m
     where m.employee_id = s.submitted_by and m.review_month = v_month and m.status = 'lapsed'
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED: %',
      format('%s has been closed for BOE Credits, so this review can no longer be reapplied.', trim(to_char(v_month, 'Month')) || ' ' || to_char(v_month, 'YYYY'))
      using errcode = '55000';
  end if;

  if v_new_path and exists (
    select 1 from public.customer_review_custom_submissions
     where submitted_by = p_actor_id
       and proof_content_sha256 = p_proof_content_sha256
       and status <> 'rejected'
       and deleted_at is null
       and id <> s.id
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end if;

  perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, s.id, s.review_type);

  v_previous := case when v_new_path then s.proof_storage_path else null end;

  begin
    update public.customer_review_custom_submissions
       set status               = 'pending_verification',
           rejected_by          = null,
           rejected_at          = null,
           rejection_reason     = null,
           review_type          = p_review_type,
           published_on         = p_published_on,
           remark               = v_remark,
           candidate_note       = v_note,
           proof_storage_path   = case when v_new_path then p_proof_storage_path   else proof_storage_path   end,
           proof_file_name      = case when v_new_path then p_proof_file_name      else proof_file_name      end,
           proof_mime_type      = case when v_new_path then p_proof_mime_type      else proof_mime_type      end,
           proof_byte_size      = case when v_new_path then p_proof_byte_size      else proof_byte_size      end,
           proof_content_sha256 = case when v_new_path then p_proof_content_sha256 else proof_content_sha256 end,
           reapplication_count  = reapplication_count + 1,
           last_reapplied_at    = now()
     where id = s.id
     returning * into s;
  exception when unique_violation then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  return jsonb_build_object('submission', to_jsonb(s), 'already_pending', false, 'previous_proof_storage_path', v_previous);
end;
$$;

revoke execute on function public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text)
  from public, anon, authenticated;
grant  execute on function public.reapply_customer_review_custom_submission(uuid, uuid, text, date, text, text, text, text, text, integer, text)
  to service_role;

-- ═══ 10. Edit ═════════════════════════════════════════════════════════════
--
-- SERVICE ROLE ONLY. The PUT route authenticated the caller and, when a new
-- screenshot was sent, re-encoded and stored it under this submission's id.
-- Proof arguments are all null to keep the current screenshot. Returns
--   { submission, unchanged, sent_back_for_approval, previous_proof_storage_path }
-- `unchanged` is true for a repeat of an edit that already went through and for
-- an edit that changes nothing; neither writes anything or bumps the counter.

create or replace function public.edit_customer_review_custom_submission(
  p_submission_id        uuid,
  p_actor_id             uuid,
  p_review_type          text,
  p_published_on         date,
  p_remark               text,
  p_expected_edit_count  integer,
  p_proof_storage_path   text,
  p_proof_file_name      text,
  p_proof_mime_type      text,
  p_proof_byte_size      integer,
  p_proof_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today    date := (now() at time zone 'Asia/Kolkata')::date;
  v_remark   text := nullif(btrim(coalesce(p_remark, '')), '');
  v_new_path boolean := p_proof_storage_path is not null;
  v_month    date;
  s          public.customer_review_custom_submissions%rowtype;
  v_same     boolean;
  v_previous text;
  v_was_approved boolean;
begin
  if p_actor_id is null or not exists (
    select 1 from public.users
     where id = p_actor_id and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;
  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'use') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: You do not have permission to edit a custom review'
      using errcode = '42501';
  end if;

  if p_review_type is null or p_review_type not in ('text', 'image') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Choose a Text-based or Image-based review'
      using errcode = '22023';
  end if;
  if p_published_on is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Enter the date the review was published'
      using errcode = '22023';
  end if;
  if p_published_on > v_today then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The published date cannot be in the future'
      using errcode = '22023';
  end if;
  if v_remark is not null and length(v_remark) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: Keep the remark under 300 characters'
      using errcode = '22023';
  end if;
  if p_expected_edit_count is null or p_expected_edit_count < 0 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The edit could not be identified'
      using errcode = '22023';
  end if;
  if v_new_path and (
       split_part(p_proof_storage_path, '/', 1) <> p_submission_id::text
       or p_proof_file_name is null or p_proof_mime_type is null
       or p_proof_byte_size is null or p_proof_content_sha256 is null
     ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The new screenshot does not belong to this review'
      using errcode = '22023';
  end if;

  -- Month lock first (the registration and reapplication order), then the row.
  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That review no longer exists' using errcode = 'P0002';
  end if;

  -- OWNERSHIP: nobody edits somebody else's review — administrators included.
  if s.submitted_by <> p_actor_id then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: You can only edit your own review' using errcode = '42501';
  end if;

  if s.status = 'rejected' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_EDITABLE: A rejected review is corrected with Edit & Reapply.'
      using errcode = '55000';
  end if;

  v_same := s.review_type = p_review_type
        and s.published_on = p_published_on
        and s.remark is not distinct from v_remark
        and (not v_new_path or s.proof_content_sha256 = p_proof_content_sha256);

  -- A repeat of an edit that already went through (double click, retry, second
  -- tab), or an edit that changes nothing: answered, not applied.
  if v_same then
    return jsonb_build_object('submission', to_jsonb(s), 'unchanged', true,
                              'sent_back_for_approval', false, 'previous_proof_storage_path', null);
  end if;
  if s.edit_count <> p_expected_edit_count then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_STALE: This review changed since you opened it. Close this form and open it again.'
      using errcode = '40001';
  end if;

  v_month := date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date;
  if exists (
    select 1 from public.boe_credit_review_months m
     where m.employee_id = s.submitted_by and m.review_month = v_month and m.status = 'lapsed'
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED: %',
      format('%s has been closed for BOE Credits, so this review can no longer be edited.', trim(to_char(v_month, 'Month')) || ' ' || to_char(v_month, 'YYYY'))
      using errcode = '55000';
  end if;

  v_was_approved := s.status = 'approved' or s.reward_held;
  if v_was_approved and p_review_type <> s.review_type then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_INVALID: The type of an approved review cannot change. Delete it and submit a new review instead.'
      using errcode = '22023';
  end if;

  if v_new_path and exists (
    select 1 from public.customer_review_custom_submissions
     where submitted_by = p_actor_id
       and proof_content_sha256 = p_proof_content_sha256
       and status <> 'rejected'
       and deleted_at is null
       and id <> s.id
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end if;

  if p_review_type <> s.review_type then
    perform public.check_customer_review_custom_month_rules(p_actor_id, v_month, p_review_type, s.id, s.review_type);
  end if;

  v_previous := case when v_new_path then s.proof_storage_path else null end;

  begin
    update public.customer_review_custom_submissions
       set status               = 'pending_verification',
           reward_held          = s.status = 'approved' or s.reward_held,
           review_type          = p_review_type,
           published_on         = p_published_on,
           remark               = v_remark,
           proof_storage_path   = case when v_new_path then p_proof_storage_path   else proof_storage_path   end,
           proof_file_name      = case when v_new_path then p_proof_file_name      else proof_file_name      end,
           proof_mime_type      = case when v_new_path then p_proof_mime_type      else proof_mime_type      end,
           proof_byte_size      = case when v_new_path then p_proof_byte_size      else proof_byte_size      end,
           proof_content_sha256 = case when v_new_path then p_proof_content_sha256 else proof_content_sha256 end,
           edit_count           = edit_count + 1,
           last_edited_at       = now()
     where id = s.id
     returning * into s;
  exception when unique_violation then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DUPLICATE: This screenshot has already been submitted'
      using errcode = '23505';
  end;

  return jsonb_build_object('submission', to_jsonb(s), 'unchanged', false,
                            'sent_back_for_approval', v_was_approved, 'previous_proof_storage_path', v_previous);
end;
$$;

revoke execute on function public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text)
  from public, anon, authenticated;
grant  execute on function public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text)
  to service_role;

comment on function public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text) is
  'SERVICE ROLE ONLY. Edits the caller''s OWN pending or approved custom review in place: same row, same submission date and month, edit_count + 1, history row written by the trail trigger. An approved review goes back to pending_verification with its credit held (never paid twice). A repeat or a no-op returns unchanged. Refuses rejected (use reapply), deleted, another employee''s, and a lapsed month.';

-- ═══ 11. Delete ═══════════════════════════════════════════════════════════

create or replace function public.delete_customer_review_custom_submission(
  p_submission_id uuid,
  p_actor_id      uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s          public.customer_review_custom_submissions%rowtype;
  v_reversal uuid;
begin
  if p_actor_id is null or not exists (
    select 1 from public.users
     where id = p_actor_id and is_active = true and coalesce(is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active'
      using errcode = '42501';
  end if;
  if not public.resolve_permission(p_actor_id, 'customer_review_requests', 'use') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: You do not have permission to delete a custom review'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer_review_custom_month'), hashtext(p_actor_id::text));

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That review no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by <> p_actor_id then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_OWNER: You can only delete your own review' using errcode = '42501';
  end if;

  -- Idempotent: a second click, a retry or a second tab reverses nothing more.
  if s.deleted_at is not null then
    return jsonb_build_object('submission', to_jsonb(s), 'already_deleted', true, 'credits_reversed', 0);
  end if;

  -- A paid review (approved, or edited and waiting with its credit held): the
  -- credit is reversed once, in this transaction. Null when the month lapsed —
  -- the lapse already removed it.
  if s.credit_transaction_id is not null and s.reward_reversal_transaction_id is null then
    v_reversal := public.reverse_customer_review_custom_reward(s.id, p_actor_id, 'Custom review deleted by the employee');
  end if;

  update public.customer_review_custom_submissions
     set deleted_at = now(),
         deleted_by = p_actor_id,
         reward_reversal_transaction_id = coalesce(v_reversal, reward_reversal_transaction_id)
   where id = s.id
   returning * into s;

  return jsonb_build_object('submission', to_jsonb(s), 'already_deleted', false,
                            'credits_reversed', case when v_reversal is null then 0 else s.credits_awarded end);
end;
$$;

revoke execute on function public.delete_customer_review_custom_submission(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.delete_customer_review_custom_submission(uuid, uuid) to service_role;

comment on function public.delete_customer_review_custom_submission(uuid, uuid) is
  'SERVICE ROLE ONLY. Soft-deletes the caller''s OWN custom review: stamps deleted_at/by, keeps the row, proof and history for verifiers, frees the monthly slot, and reverses a posted credit once (nothing when the month lapsed). Idempotent.';

-- ═══ 12. Approve, re-created: a held credit is not paid again ═════════════

create or replace function public.approve_customer_review_custom_submission(
  p_submission_id uuid,
  p_credits       numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s          public.customer_review_custom_submissions%rowtype;
  v_uid      uuid := auth.uid();
  v_settings public.boe_credit_settings%rowtype;
  v_default  numeric;
  v_reward   jsonb;
  v_month    date;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;
  if not public.resolve_permission(v_uid, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Approving a custom review needs the Verify permission'
      using errcode = '42501';
  end if;

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by = v_uid then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_SELF: You cannot approve or reject your own submission'
      using errcode = '42501';
  end if;

  if s.status = 'approved' then
    return jsonb_build_object('submission', to_jsonb(s), 'reward', null, 'already_decided', true);
  end if;
  if s.status = 'rejected' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This submission was already rejected' using errcode = '55000';
  end if;

  -- AN EDITED REVIEW WHOSE CREDIT IS HELD: approve it again, post nothing. The
  -- credit already on the ledger stands; the ledger would refuse a second
  -- review_reward for this source anyway.
  if s.reward_held then
    update public.customer_review_custom_submissions
       set status      = 'approved',
           approved_by = v_uid,
           approved_at = now(),
           reward_held = false
     where id = s.id
     returning * into s;
    return jsonb_build_object('submission', to_jsonb(s), 'reward', null, 'already_decided', false, 'reaffirmed', true);
  end if;

  if p_credits is null or p_credits <= 0 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: Enter a credit amount above 0' using errcode = '22023';
  end if;
  if p_credits <> round(p_credits, 2) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: Credits have at most two decimal places' using errcode = '22023';
  end if;
  if p_credits > 100000 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: That is more credits than one review can earn' using errcode = '22023';
  end if;

  select * into v_settings from public.boe_credit_settings order by created_at desc limit 1;
  if not found then
    raise exception 'BOE_CREDITS_SETTINGS: no active credit settings row' using errcode = 'P0002';
  end if;
  v_default := case s.review_type
    when 'image' then v_settings.image_review_reward_credits
    else v_settings.review_reward_credits
  end;

  if p_credits <> v_default and not public.can_manage_boe_credits() then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_CREDITS: Only a BOE Credits administrator can change the amount. The configured reward for this review type is % credits', v_default
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('boe_credits'), hashtext(s.submitted_by::text));
  v_month := date_trunc('month', (s.submitted_at at time zone 'Asia/Kolkata')::date)::date;
  if exists (
    select 1 from public.boe_credit_review_months m
     where m.employee_id = s.submitted_by and m.review_month = v_month and m.status = 'lapsed'
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_MONTH_CLOSED: %',
      format('%s was closed below the monthly minimum for this employee, so this review can no longer earn credits. Reject it with that reason instead.',
        trim(to_char(v_month, 'Month')) || ' ' || to_char(v_month, 'YYYY'))
      using errcode = '55000';
  end if;

  v_reward := public.post_boe_credit_custom_review_reward(
    s.submitted_by, s.id, s.submission_ref, p_credits, s.submitted_at, v_uid
  );

  update public.customer_review_custom_submissions
     set status                = 'approved',
         approved_by           = v_uid,
         approved_at           = now(),
         credits_awarded       = p_credits,
         credit_transaction_id = (v_reward ->> 'transaction_id')::uuid
   where id = s.id
   returning * into s;

  return jsonb_build_object('submission', to_jsonb(s), 'reward', v_reward, 'already_decided', false);
end;
$$;

revoke execute on function public.approve_customer_review_custom_submission(uuid, numeric) from public, anon;
grant  execute on function public.approve_customer_review_custom_submission(uuid, numeric) to authenticated;

-- ═══ 13. Reject, re-created: a held credit is reversed ════════════════════

create or replace function public.reject_customer_review_custom_submission(
  p_submission_id uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s          public.customer_review_custom_submissions%rowtype;
  v_uid      uuid := auth.uid();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_reversal uuid;
begin
  if v_uid is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Sign in to continue' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.users u where u.id = v_uid and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Your account is not active' using errcode = '42501';
  end if;
  if not public.resolve_permission(v_uid, 'customer_review_requests', 'verify') then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_UNAUTHORIZED: Rejecting a custom review needs the Verify permission'
      using errcode = '42501';
  end if;

  select * into s from public.customer_review_custom_submissions where id = p_submission_id for update;
  if not found or s.deleted_at is not null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_NOT_FOUND: That submission no longer exists' using errcode = 'P0002';
  end if;

  if s.submitted_by = v_uid then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_SELF: You cannot approve or reject your own submission'
      using errcode = '42501';
  end if;

  if s.status = 'rejected' then
    return jsonb_build_object('submission', to_jsonb(s), 'already_decided', true);
  end if;
  if s.status = 'approved' then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_DECIDED: This submission was already approved and its credits awarded'
      using errcode = '55000';
  end if;

  if v_reason is null then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_REASON: Give a short reason for rejecting' using errcode = '22023';
  end if;
  if length(v_reason) > 300 then
    raise exception 'CUSTOMER_REVIEW_CUSTOM_REASON: Keep the reason under 300 characters' using errcode = '22023';
  end if;

  -- A rejected EDIT of an approved review withdraws the credit it was holding.
  if s.reward_held then
    v_reversal := public.reverse_customer_review_custom_reward(s.id, v_uid, 'Edit of an approved custom review rejected');
  end if;

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

  return jsonb_build_object('submission', to_jsonb(s), 'already_decided', false, 'credit_reversed', v_reversal is not null);
end;
$$;

revoke execute on function public.reject_customer_review_custom_submission(uuid, text) from public, anon;
grant  execute on function public.reject_customer_review_custom_submission(uuid, text) to authenticated;

-- ═══ 14. Assertions ═══════════════════════════════════════════════════════

do $$
begin
  if has_function_privilege('authenticated', 'public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.delete_customer_review_custom_submission(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.delete_customer_review_custom_submission(uuid, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reverse_customer_review_custom_reward(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.reverse_customer_review_custom_reward(uuid, uuid, text)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_EDIT_DELETE: a client role can execute an owner-only function';
  end if;
  if not has_function_privilege('service_role', 'public.edit_customer_review_custom_submission(uuid, uuid, text, date, text, integer, text, text, text, integer, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.delete_customer_review_custom_submission(uuid, uuid)', 'EXECUTE') then
    raise exception 'CUSTOM_REVIEW_EDIT_DELETE: the service role cannot execute edit/delete';
  end if;
  if has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'DELETE')
     or has_table_privilege('authenticated', 'public.customer_review_custom_submissions', 'INSERT') then
    raise exception 'CUSTOM_REVIEW_EDIT_DELETE: a client role holds a table write';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'customer_review_custom_submissions') <> 1 then
    raise exception 'CUSTOM_REVIEW_EDIT_DELETE: expected exactly one policy on the submissions table';
  end if;
end $$;

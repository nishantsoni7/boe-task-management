-- A PI that is Awaiting Approval can be deleted, by its owner or an administrator.
--
-- WHAT CHANGES
-- ------------
-- order_submission_deletable_statuses() was the allow-list
--   draft, needs_changes, rejected.
-- It now also admits 'submitted' (the PI is awaiting approval). Nothing else
-- about who may delete is touched: order_submission_deletable_by() still admits
-- the owner (created_by / submitted_by) or an active administrator, and an
-- APPROVED PI still cannot be deleted here, because approving creates its Order
-- and that is deleted as an Order (a separate, admin-only action).
--
-- WHY THIS NEEDS MORE THAN ONE WORD
-- ---------------------------------
-- A PI that has been sent for approval has more attached to it than a draft:
--   * order_document_submissions (+ files, events): the Design Files / Client PO
--     sent with it. All three are append-only, so the cascade from the PI was
--     refused (ORDER_DOCUMENT_*_IMMUTABLE) and the PI could never be deleted.
--     This is true of an already REJECTED PI that was sent with documents too.
--   * the uploaded files themselves, in storage under pi-documents/{pi}/...,
--     which the application removes first (the route sweeps that prefix).
--   * a pending allocation intent, if a payment is attached. That one is NOT
--     released: it counts as a blocker (20270315000000), so a PI with money
--     attached still refuses, before anything is touched.
--
-- WHAT IS ERASED WITH THE PI, AND ONLY THEN
-- -----------------------------------------
-- Its own document submissions with NO Order (order_id is null: nothing was ever
-- approved), their files and their events, inside the purge of that one PI
-- (order_submission_purge_in_progress, pinned to one submission id). Document
-- submissions that belong to an Order are never reachable here and stay
-- immutable for everyone. The shared append-only guard keeps refusing every
-- other table and every UPDATE.
--
-- THE REVIEWER RACE is already handled by the reservation: begin takes the row
-- lock and the reserved PI cannot be approved, rejected or returned until the
-- delete finishes or is released. A reviewer who approves first makes the delete
-- refuse with STATUS_CHANGED.
--
-- It creates no payment, approves nothing, and moves no money.

do $$
begin
  if to_regprocedure('public.allocation_released_by_payment_deletion(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270315000000 must be applied first';
  end if;
  if to_regclass('public.order_document_submissions') is null then
    raise exception 'DEPENDENCY MISSING: 20270112000000 must be applied first';
  end if;
end $$;

-- ── 1. The allow-list ────────────────────────────────────────────────────────

create or replace function public.order_submission_deletable_statuses()
returns text[]
language sql
immutable
as $$
  -- An allow-list: absence is the refusal, so a status invented later is refused
  -- until it is deliberately added. 'approved' is absent on purpose.
  select array['draft', 'needs_changes', 'submitted', 'rejected']::text[];
$$;

-- ── 2. Document submissions may be erased with their PI, and only then ───────

create or replace function public.order_document_submissions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then return old; end if;
    -- The PI this submission was sent with is being permanently deleted, and no
    -- Order was ever made from it.
    if old.order_id is null
       and public.order_submission_purge_in_progress(old.pi_submission_id) then
      return old;
    end if;
    raise exception 'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE: document submissions cannot be deleted'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending_admin' then
      raise exception 'ORDER_DOCUMENT_SUBMISSION_INVALID: a submission is created pending admin review'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.stage is distinct from old.stage
     or new.pi_submission_id is distinct from old.pi_submission_id
     or (old.order_id is not null and new.order_id is distinct from old.order_id)
     or new.includes_design_files is distinct from old.includes_design_files
     or new.includes_client_po is distinct from old.includes_client_po
     or new.design_mode is distinct from old.design_mode
     or new.note is distinct from old.note
     or new.snapshot_sha256 is distinct from old.snapshot_sha256
     or new.file_count is distinct from old.file_count
     or new.resubmission_of is distinct from old.resubmission_of
     or new.submitted_by is distinct from old.submitted_by
     or new.submitted_at is distinct from old.submitted_at then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE: the snapshot of submission % cannot be changed', old.id
      using errcode = '42501';
  end if;
  -- The Order link is written once: when the approved PI creates the Order.
  if old.order_id is null and new.order_id is not null
     and not (old.stage = 'initial' and old.status = 'pending_admin' and new.status = 'awaiting_operations'
              and current_setting('boe.order_document_pi_link', true) = 'on') then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_IMMUTABLE: submission % is linked to an Order only by approving its PI', old.id
      using errcode = '42501';
  end if;
  -- An INITIAL submission moves only with its PI (§11), never by a direct call.
  if old.stage = 'initial' and new.status is distinct from old.status
     and current_setting('boe.order_document_pi_link', true) is distinct from 'on' then
    raise exception 'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID: documents sent with a PI are decided with that PI'
      using errcode = '42501';
  end if;

  -- REASSIGNMENT (§12): only the operations reviewer of a submission awaiting
  -- operations moves, and nothing else about it.
  if new.status = old.status then
    if old.status = 'awaiting_operations'
       and (to_jsonb(new) - 'operations_reviewer') = (to_jsonb(old) - 'operations_reviewer') then
      return new;
    end if;
    raise exception 'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID: submission % cannot be rewritten in place', old.id
      using errcode = '42501';
  end if;

  if old.status = 'pending_admin' and new.status in ('awaiting_operations', 'rejected_admin') then
    return new;
  end if;
  if old.status = 'awaiting_operations' and new.status in ('accepted', 'rejected_operations')
     and new.admin_decided_by is not distinct from old.admin_decided_by
     and new.admin_decided_at is not distinct from old.admin_decided_at then
    return new;
  end if;
  raise exception 'ORDER_DOCUMENT_SUBMISSION_TRANSITION_INVALID: submission % cannot move from % to %',
    old.id, old.status, new.status using errcode = '42501';
end;
$$;

-- The shared append-only guard (absences, events, files), with the same narrow
-- exemption for a PI that is being purged. UPDATEs and every other table stay
-- refused for everyone.
create or replace function public.order_document_append_only_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.in_test_data_cleanup() then return old; end if;

  if tg_op = 'DELETE' then
    if tg_table_name = 'order_pi_document_absences'
       and public.order_submission_purge_in_progress((to_jsonb(old) ->> 'pi_submission_id')::uuid) then
      return old;
    end if;
    if tg_table_name = 'order_document_submission_events'
       and (to_jsonb(old) ->> 'order_id') is null
       and public.order_submission_purge_in_progress((to_jsonb(old) ->> 'pi_submission_id')::uuid) then
      return old;
    end if;
    -- A file has no PI column; it is judged by the submission it belongs to,
    -- which finalization deletes the files of BEFORE the submission itself.
    if tg_table_name = 'order_document_submission_files'
       and exists (
         select 1 from public.order_document_submissions d
          where d.id = (to_jsonb(old) ->> 'submission_id')::uuid
            and d.order_id is null
            and public.order_submission_purge_in_progress(d.pi_submission_id)
       ) then
      return old;
    end if;
  end if;

  raise exception 'ORDER_DOCUMENT_HISTORY_IMMUTABLE: % rows cannot be changed or deleted', tg_table_name
    using errcode = '42501';
end;
$$;

-- ── 3. finalize_order_submission_deletion, restated whole ────────────────────
-- Identical to 20270315000000 except for the marked block.

create or replace function public.finalize_order_submission_deletion(
  p_submission_id uuid,
  p_claim_token   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_sub      public.order_submissions%rowtype;
  v_n_images int;
  v_n_items  int;
  v_n_events int;
  v_n_allocs int;
  v_n_docs   int;
begin
  if p_claim_token is null then
    raise exception 'ORDER_SUBMISSION_DELETION_CLAIM_INVALID: a deletion claim is required'
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_DELETE_MISSING: this PI no longer exists'
      using errcode = 'P0002';
  end if;

  if v_sub.deletion_claim_token is null
     or v_sub.deletion_claim_token <> p_claim_token then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIM_INVALID: this deletion claim is not valid for this PI'
      using errcode = '42501';
  end if;

  if v_sub.deletion_claimed_by <> v_actor
     and not public.order_submission_deletable_by(p_submission_id, v_actor) then
    raise exception
      'ORDER_SUBMISSION_DELETE_DENIED: only the owner of this PI or an administrator can delete it'
      using errcode = '42501';
  end if;

  if not (v_sub.status = any (public.order_submission_deletable_statuses())) then
    raise exception
      'ORDER_SUBMISSION_DELETE_STATUS: a PI in this state cannot be deleted (this one is %)',
      v_sub.status
      using errcode = 'P0001';
  end if;

  perform set_config('boe.order_submission_purge_id', p_submission_id::text, true);

  delete from public.finance_payment_allocation_intents i
   where i.order_submission_id = p_submission_id
     and i.status = 'cancelled'
     and public.payment_deleted_before_approval(i.payment_request_id);

  perform set_config('boe.pi_allocation_release', p_submission_id::text, true);
  delete from public.finance_payment_allocations a
   where a.order_submission_id = p_submission_id
     and public.allocation_released_by_payment_deletion(a.id);
  get diagnostics v_n_allocs = row_count;
  perform set_config('boe.pi_allocation_release', '', true);

  -- NEW. The documents sent with this PI, children first: the guard judges a
  -- file by its (still present) submission, so the order matters.
  delete from public.order_document_submission_files f
   using public.order_document_submissions d
   where f.submission_id = d.id
     and d.pi_submission_id = p_submission_id
     and d.order_id is null;
  delete from public.order_document_submission_events e
   where e.pi_submission_id = p_submission_id
     and e.order_id is null;
  delete from public.order_document_submissions d
   where d.pi_submission_id = p_submission_id
     and d.order_id is null;
  get diagnostics v_n_docs = row_count;

  delete from public.order_submission_item_images where submission_id = p_submission_id;
  get diagnostics v_n_images = row_count;

  delete from public.order_submission_items where submission_id = p_submission_id;
  get diagnostics v_n_items = row_count;

  delete from public.order_submission_activity where submission_id = p_submission_id;
  get diagnostics v_n_events = row_count;

  delete from public.order_submissions where id = p_submission_id;

  perform set_config('boe.order_submission_purge_id', '', true);

  return jsonb_build_object(
    'deleted',       true,
    'submission_id', p_submission_id,
    'client_name',   v_sub.client_name,
    'status',        v_sub.status,
    'items',         v_n_items,
    'images',        v_n_images,
    'activity',      v_n_events,
    'allocations_released', v_n_allocs,
    'document_submissions', v_n_docs
  );
end;
$$;

-- ── Self-assertions (executed when this file is applied) ─────────────────────

do $$
declare
  v_def text;
begin
  if public.order_submission_deletable_statuses()
       is distinct from array['draft', 'needs_changes', 'submitted', 'rejected']::text[] then
    raise exception 'the deletable statuses must be exactly draft, needs_changes, submitted, rejected';
  end if;
  if 'approved' = any (public.order_submission_deletable_statuses()) then
    raise exception 'an approved PI must never be deletable as a PI';
  end if;

  v_def := pg_get_functiondef('public.order_document_submissions_guard()'::regprocedure);
  if v_def not like '%order_submission_purge_in_progress%' or v_def not like '%old.order_id is null%' then
    raise exception 'the document submission guard must exempt only an Order-less submission of a purged PI';
  end if;

  v_def := pg_get_functiondef('public.order_document_append_only_guard()'::regprocedure);
  if v_def not like '%order_document_submission_files%'
     or v_def not like '%order_document_submission_events%'
     or v_def not like '%order_pi_document_absences%' then
    raise exception 'the append-only guard must name each table it exempts';
  end if;

  v_def := pg_get_functiondef('public.finalize_order_submission_deletion(uuid,uuid)'::regprocedure);
  if v_def not like '%order_document_submission_files%'
     or v_def not like '%allocation_released_by_payment_deletion%'
     or v_def not like '%deletion_claim_token%' then
    raise exception 'finalize_order_submission_deletion must keep its claim checks and the PR 317 release';
  end if;

  if (select count(*) from pg_trigger
       where tgname in ('order_document_submissions_guard', 'order_document_submission_events_guard',
                        'order_document_submission_files_guard', 'order_pi_document_absences_guard')
         and tgenabled <> 'D') <> 4 then
    raise exception 'the four document history guards must stay armed';
  end if;
end $$;

-- ROLLBACK (manual): restate order_submission_deletable_statuses with
-- draft/needs_changes/rejected, order_document_submissions_guard from
-- 20270112000000, order_document_append_only_guard and
-- finalize_order_submission_deletion from 20270315000000.

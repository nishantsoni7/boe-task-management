-- Order Requests — attachment editing on a SUBMITTED (finalized) request.
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
--
-- Why this migration is required
-- ------------------------------
-- 20260711 deliberately made a finalized request's attachments IMMUTABLE through
-- the client API, and that design is unchanged by this file:
--   * order_request_attachments has NO delete policy and NO update policy;
--   * its INSERT policy is gated on order_request_attachment_writable(), which
--     requires finalized_at IS NULL;
--   * the storage INSERT and DELETE policies on 'order-request-attachments' are
--     likewise draft-only.
-- There is therefore no existing path — for anyone, admin included — by which a
-- submitted request's Main PI can be replaced or a reference file added/removed.
-- remove_unfinalized_order_request_attachment() explicitly refuses a finalized
-- request, and finalize_order_request() only ever runs once.
--
-- The product now requires that an admin or the current assignee can correct the
-- attachments of a request that is still open (submitted / needs_clarification /
-- rejected). This migration adds EXACTLY ONE narrowly-scoped SECURITY DEFINER
-- function for that and nothing else. It does NOT:
--   * add or widen any RLS policy on order_request_attachments,
--   * add or widen any storage.objects policy,
--   * grant any client the ability to delete metadata rows directly,
--   * introduce a general attachment-management framework.
--
-- Storage objects are NOT touched here. Postgres and Supabase Storage cannot
-- share a transaction, so object writes/removals stay in the authenticated
-- server route (src/app/api/orders/requests/attachments/edit), which uploads the
-- replacement objects BEFORE calling this function and removes the superseded
-- objects only AFTER it commits. This function returns the superseded paths so
-- the route knows exactly what became garbage.
--
-- Conventions follow 20260711 §7/§10: authorise BEFORE revealing anything about
-- the row, lock the parent request FOR UPDATE, raise stable greppable codes, and
-- write activity in the same transaction as the change it describes.

-- ── 1. Activity event types ───────────────────────────────────────────────────
-- Postgres cannot add a value to a CHECK in place, so the constraint is dropped
-- and re-created with the FULL list. Any value omitted here is silently REVOKED,
-- which is why the list below is the LIVE constraint as defined by 20260711 §6
-- (the union of every prior migration's additions) PLUS the two added here.
--
-- RULE for anyone editing this list: re-read the constraint from the live
-- database first (pg_get_constraintdef) and take the UNION with whatever this
-- migration adds. Never retype it from memory or from an older migration.
alter table public.order_request_activity
  drop constraint order_request_activity_event_type_check;

alter table public.order_request_activity
  add constraint order_request_activity_event_type_check
  check (event_type in (
    'request_submitted',
    'status_changed',
    'request_converted',
    'clarification_requested',
    'clarification_resubmitted',
    'request_rejected',
    'reapplication_submitted',
    'payment_linked',
    'payment_unlinked',
    'request_edited',
    'attachments_uploaded',
    'main_pi_replaced',                -- added by this migration
    'reference_attachments_changed'    -- added by this migration
  ));

-- ── 2. edit_order_request_attachments() ───────────────────────────────────────
-- Apply one atomic set of attachment changes to a SUBMITTED request:
--   * replace the Main PI (the old row is removed and the new one inserted in the
--     same statement set — there is never a committed state without a Main PI);
--   * remove named reference attachments;
--   * add new reference attachments.
--
-- The caller has already uploaded every new object to a NEW storage path; this
-- function only moves metadata. It returns the storage paths that the change
-- superseded, so the caller can delete those objects afterwards.
--
-- Authorization is the SAME rule as editing the request itself — admin, or the
-- CURRENT ASSIGNEE — evaluated here, independently of any client-side control
-- and independently of the service-role client the route uses for Storage. A
-- creator/requester who is not the assignee gets nothing.
--
-- p_main_pi / p_add_references element shape (all keys required except
-- mime_type / *_size_bytes, which may be null):
--   { "file_name": text, "storage_path": text, "mime_type": text,
--     "original_size_bytes": bigint, "uploaded_size_bytes": bigint }
--
-- Absent arguments: p_main_pi accepts omission, SQL NULL or JSON `null` as "no
-- Main PI change", and p_add_references accepts omission, SQL NULL, JSON `null`
-- or [] as "no additions" — normalised in the body so an add-references-only
-- save cannot be refused by how a transport encoded an absent value. A value of
-- the wrong TYPE is refused, never normalised away.
create or replace function public.edit_order_request_attachments(
  p_order_request_id     uuid,
  p_main_pi              jsonb   default null,
  p_add_references       jsonb   default '[]'::jsonb,
  p_remove_attachment_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_req         public.order_requests%rowtype;
  v_is_admin    boolean;
  -- The normalised arguments. Everything below reads THESE, never the raw
  -- parameters, so "absent" has exactly one meaning throughout the body.
  v_main        jsonb;
  v_refs        jsonb;
  v_superseded  text[] := '{}';
  v_removed_names text[] := '{}';
  v_added_names   text[] := '{}';
  v_old_main    public.order_request_attachments%rowtype;
  v_old_main_name text;
  v_new_main_name text;
  v_remove_id   uuid;
  v_item        jsonb;
  v_att         public.order_request_attachments%rowtype;
  v_main_count  integer;
  -- How many Main PI rows the request had BEFORE this change. Captured because
  -- the closing invariant is about what this change DID, not about what history
  -- left behind — see the invariant block for why that distinction matters.
  v_main_before integer;
begin
  if v_actor is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  -- Lock the parent so this cannot interleave with a concurrent edit, convert or
  -- delete. Whichever transaction runs second sees the other's committed state.
  select * into v_req from public.order_requests
  where id = p_order_request_id
  for update;

  if not found then
    raise exception 'ORDER_REQUEST_NOT_FOUND: That Order Request no longer exists.'
      using errcode = 'P0002';
  end if;

  select exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin')
    into v_is_admin;

  -- AUTHORISE FIRST, before any property of the request or its files is acted on
  -- or revealed, so an unauthorised caller gets an identical 42501 whatever the
  -- record's state — the function never becomes an oracle.
  --
  -- Same rule as edit_order_request (20260708): admin OR the CURRENT ASSIGNEE.
  -- created_by / requested_by grant nothing on their own.
  --
  -- coalesce() is LOAD-BEARING, for the reason 20260709 records against
  -- edit_order_request: on an UNASSIGNED request assigned_to IS NULL, so
  -- `assigned_to = v_actor` is NULL, `false or NULL` is NULL, `not NULL` is NULL,
  -- and plpgsql treats a NULL condition as false — the raise would be SKIPPED and
  -- any authenticated caller could change the attachments of an unassigned
  -- request by calling this function directly (the route's own check is not the
  -- gate; this is). Written as an explicit boolean instead.
  if not (v_is_admin or coalesce(v_req.assigned_to = v_actor, false)) then
    raise exception 'You do not have permission to change the attachments on this Order Request.'
      using errcode = '42501';
  end if;

  -- A converted request is permanent source history.
  if v_req.converted_order_id is not null or v_req.status = 'converted' then
    raise exception 'ATTACHMENTS_LOCKED: this Order Request has been converted and its attachments can no longer be changed.'
      using errcode = '42501';
  end if;

  -- Only the states edit_order_request accepts. A future status is excluded by
  -- default rather than silently becoming editable.
  if v_req.status not in ('submitted', 'needs_clarification', 'rejected') then
    raise exception 'ATTACHMENTS_LOCKED: this Order Request is not in an editable state.'
      using errcode = '42501';
  end if;

  -- This function is the POST-submission path only. An upload-stage draft still
  -- has its own creation-time flow (direct insert under the draft-only policies
  -- plus remove_unfinalized_order_request_attachment), which is unchanged.
  if v_req.finalized_at is null then
    raise exception 'ATTACHMENTS_LOCKED: this Order Request has not been submitted yet.'
      using errcode = '42501';
  end if;

  -- ── Argument normalisation ──────────────────────────────────────────────────
  -- Deliberately AFTER the authorization block, per the rule above: an
  -- unauthorised caller gets 42501 whatever it sent, so this function never
  -- becomes an oracle for anything, not even its own argument parsing.
  --
  -- "No Main PI in this change" must mean the same thing whether the caller
  -- omitted the argument, passed SQL NULL, or passed a JSON `null`. Testing only
  -- `p_main_pi is not null` would make a jsonb 'null' take the REPLACE branch and
  -- fail on MAIN_PI_INVALID — i.e. an add-references-only save would be refused
  -- because of how a transport encoded an absent value. Decided here, once,
  -- rather than trusting PostgREST's null handling to stay as it is.
  --
  -- A value of the WRONG SHAPE is refused rather than normalised away: silently
  -- treating a malformed argument as "nothing asked for" is how a caller ends up
  -- being told its files were saved when they were never recorded.
  if p_main_pi is null or jsonb_typeof(p_main_pi) = 'null' then
    v_main := null;
  elsif jsonb_typeof(p_main_pi) <> 'object' then
    raise exception 'MAIN_PI_INVALID: the replacement Main PI is incomplete.'
      using errcode = 'P0001';
  else
    v_main := p_main_pi;
  end if;

  if p_add_references is null or jsonb_typeof(p_add_references) = 'null' then
    v_refs := '[]'::jsonb;
  elsif jsonb_typeof(p_add_references) <> 'array' then
    raise exception 'ATTACHMENT_INVALID: the list of new files is malformed.'
      using errcode = 'P0001';
  else
    v_refs := p_add_references;
  end if;

  -- The pre-change Main PI count, read AFTER authorization and BEFORE anything
  -- is touched. Nothing below may move it except the replacement branch.
  select count(*) into v_main_before
  from public.order_request_attachments
  where order_request_id = p_order_request_id and attachment_type = 'main_pi';

  -- ── Removals ────────────────────────────────────────────────────────────────
  -- Only REFERENCE rows belonging to THIS request may be removed. A main_pi id
  -- is refused outright: the Main PI leaves only by being replaced, below, which
  -- guarantees a replacement exists. An unknown id is refused rather than
  -- ignored, so a caller can never believe it removed something it did not.
  if p_remove_attachment_ids is not null and array_length(p_remove_attachment_ids, 1) > 0 then
    foreach v_remove_id in array p_remove_attachment_ids
    loop
      select * into v_att from public.order_request_attachments
      where id = v_remove_id;

      if not found or v_att.order_request_id <> p_order_request_id then
        raise exception 'ATTACHMENT_NOT_FOUND: one of the selected files no longer belongs to this Order Request.'
          using errcode = 'P0002';
      end if;
      if v_att.attachment_type <> 'reference' then
        raise exception 'MAIN_PI_NOT_REMOVABLE: the Main PI can only be replaced, never removed on its own.'
          using errcode = 'P0001';
      end if;

      v_superseded    := v_superseded || v_att.storage_path;
      v_removed_names := v_removed_names || v_att.file_name;

      delete from public.order_request_attachments where id = v_att.id;
    end loop;
  end if;

  -- ── Main PI replacement ─────────────────────────────────────────────────────
  -- Same authoritative Excel gate finalize_order_request() applies, so a crafted
  -- call can never install a PDF/image as the Main PI. Validated on BOTH stored
  -- signals: the extension MUST be .xlsx/.xls, and the mime MUST be an Excel
  -- mime or null/empty (a genuine workbook can arrive with a missing browser
  -- mime; a NON-empty conflicting mime is rejected rather than trusting the name).
  if v_main is not null then
    v_new_main_name := v_main ->> 'file_name';

    if v_new_main_name is null or btrim(v_new_main_name) = ''
       or coalesce(btrim(v_main ->> 'storage_path'), '') = '' then
      raise exception 'MAIN_PI_INVALID: the replacement Main PI is incomplete.'
        using errcode = 'P0001';
    end if;

    if not (lower(v_new_main_name) like '%.xlsx' or lower(v_new_main_name) like '%.xls') then
      raise exception 'MAIN_PI_NOT_EXCEL: the Main PI must be an Excel file (.xlsx or .xls).'
        using errcode = 'P0001';
    end if;

    if coalesce(v_main ->> 'mime_type', '') <> ''
       and (v_main ->> 'mime_type') not in (
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.ms-excel'
       ) then
      raise exception 'MAIN_PI_NOT_EXCEL: the Main PI must be an Excel file (.xlsx or .xls).'
        using errcode = 'P0001';
    end if;

    -- Remove the outgoing row and insert the replacement in the same statement
    -- set. order_request_attachments_one_main_pi (partial unique index) requires
    -- the delete to precede the insert; both are in this transaction, so no
    -- committed state ever lacks a Main PI.
    select * into v_old_main from public.order_request_attachments
    where order_request_id = p_order_request_id and attachment_type = 'main_pi';

    if found then
      v_old_main_name := v_old_main.file_name;
      v_superseded    := v_superseded || v_old_main.storage_path;
      delete from public.order_request_attachments where id = v_old_main.id;
    end if;

    insert into public.order_request_attachments
      (order_request_id, attachment_type, file_name, storage_path, mime_type,
       original_size_bytes, uploaded_size_bytes, uploaded_by)
    values (
      p_order_request_id, 'main_pi',
      v_new_main_name,
      v_main ->> 'storage_path',
      nullif(v_main ->> 'mime_type', ''),
      (v_main ->> 'original_size_bytes')::bigint,
      (v_main ->> 'uploaded_size_bytes')::bigint,
      v_actor
    );
  end if;

  -- ── Reference additions ─────────────────────────────────────────────────────
  -- v_refs is always a jsonb array by construction (see the normalisation block),
  -- so a malformed argument can no longer be skipped in silence.
  if jsonb_array_length(v_refs) > 0 then
    for v_item in select * from jsonb_array_elements(v_refs)
    loop
      if jsonb_typeof(v_item) <> 'object'
         or coalesce(btrim(v_item ->> 'file_name'), '') = ''
         or coalesce(btrim(v_item ->> 'storage_path'), '') = '' then
        raise exception 'ATTACHMENT_INVALID: one of the new files is incomplete.'
          using errcode = 'P0001';
      end if;

      insert into public.order_request_attachments
        (order_request_id, attachment_type, file_name, storage_path, mime_type,
         original_size_bytes, uploaded_size_bytes, uploaded_by)
      values (
        p_order_request_id, 'reference',
        v_item ->> 'file_name',
        v_item ->> 'storage_path',
        nullif(v_item ->> 'mime_type', ''),
        (v_item ->> 'original_size_bytes')::bigint,
        (v_item ->> 'uploaded_size_bytes')::bigint,
        v_actor
      );

      v_added_names := v_added_names || (v_item ->> 'file_name');
    end loop;
  end if;

  -- ── The invariant ───────────────────────────────────────────────────────────
  -- The backstop: this change must never leave the request with fewer Main PIs
  -- than it started with, and never with more than one.
  --
  -- Deliberately NOT a flat "exactly one" assertion. 20260711 §2 keeps the
  -- legacy insert path open on purpose during the compatibility window, and
  -- states plainly that for those rows the one-Main-PI guarantee is convention-
  -- enforced rather than DB-enforced. Every Order Request finalized BEFORE
  -- 20260711 was applied is therefore a finalized request with ZERO main_pi
  -- rows. A flat "exactly one" check would refuse every attachment change on
  -- those rows — so adding a single reference file to a pre-existing request
  -- would fail with MAIN_PI_REQUIRED, a message about a document the user did
  -- not touch and cannot supply through the control they used. That is a save
  -- blocked by history rather than by anything the caller did wrong.
  --
  -- What this function is actually responsible for is its OWN effect, and that
  -- is what is asserted:
  --   * > 1 is refused outright — impossible via the branches above and already
  --     barred by order_request_attachments_one_main_pi, so this is pure
  --     defence against a future edit to this function;
  --   * 0 is refused only when the request HAD a Main PI or was given one, i.e.
  --     only when reaching 0 would mean this change destroyed or failed to
  --     install it. A legacy request that had none and was not given one is
  --     left exactly as it was — references may still be corrected, and the
  --     request is no worse off than before the call.
  -- The Main PI can still never be removed on its own: MAIN_PI_NOT_REMOVABLE
  -- above is what enforces that, on every request, legacy or not.
  select count(*) into v_main_count
  from public.order_request_attachments
  where order_request_id = p_order_request_id and attachment_type = 'main_pi';

  if v_main_count > 1 then
    raise exception 'MAIN_PI_REQUIRED: a submitted Order Request must never have more than one Main PI.'
      using errcode = 'P0001';
  end if;

  if v_main_count = 0 and (v_main_before > 0 or v_main is not null) then
    raise exception 'MAIN_PI_REQUIRED: a submitted Order Request must always have exactly one Main PI.'
      using errcode = 'P0001';
  end if;

  -- Nothing asked for at all — reject rather than write an empty audit entry.
  -- This is the ONLY condition under which the caller may report that nothing
  -- changed, so it is stated in terms of what was actually applied.
  if v_main is null
     and array_length(v_removed_names, 1) is null
     and array_length(v_added_names, 1) is null then
    raise exception 'NO_ATTACHMENT_CHANGES: no attachment changes were supplied.'
      using errcode = 'P0001';
  end if;

  -- ── Activity ────────────────────────────────────────────────────────────────
  -- Written in the same transaction as the change it describes, by a
  -- SECURITY DEFINER function no client can call with a forged actor. FILE NAMES
  -- ONLY — never a storage path and never a signed URL.
  if v_main is not null then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, details)
    values (
      p_order_request_id, 'main_pi_replaced', v_actor,
      jsonb_build_object('from_file_name', v_old_main_name, 'to_file_name', v_new_main_name)
    );
  end if;

  if array_length(v_removed_names, 1) is not null or array_length(v_added_names, 1) is not null then
    insert into public.order_request_activity
      (order_request_id, event_type, actor_id, details)
    values (
      p_order_request_id, 'reference_attachments_changed', v_actor,
      jsonb_build_object(
        'added',   coalesce(to_jsonb(v_added_names),   '[]'::jsonb),
        'removed', coalesce(to_jsonb(v_removed_names), '[]'::jsonb)
      )
    );
  end if;

  -- updated_at moves because the record genuinely changed.
  update public.order_requests set updated_at = now() where id = p_order_request_id;

  return jsonb_build_object(
    'order_request_id',    p_order_request_id,
    'main_pi_replaced',    (v_main is not null),
    'references_added',    coalesce(array_length(v_added_names, 1), 0),
    'references_removed',  coalesce(array_length(v_removed_names, 1), 0),
    -- The objects the caller must now delete. Safe to hand back: the caller has
    -- already been authorised above, and it is the same service-role route that
    -- wrote the replacements.
    'superseded_paths',    coalesce(to_jsonb(v_superseded), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.edit_order_request_attachments(uuid, jsonb, jsonb, uuid[])
  from public, anon;
grant execute on function public.edit_order_request_attachments(uuid, jsonb, jsonb, uuid[])
  to authenticated;

comment on function public.edit_order_request_attachments(uuid, jsonb, jsonb, uuid[]) is
  'Atomically replace the Main PI and/or add/remove reference attachments on a submitted, unconverted Order Request. Admin or current assignee only. Returns the superseded storage paths for the caller to delete AFTER commit. Storage objects are never touched here.';

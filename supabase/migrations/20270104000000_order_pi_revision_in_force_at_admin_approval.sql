-- ═══════════════════════════════════════════════════════════════════════════
-- 20270104000000 — A revised PI is IN FORCE when an Admin approves it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE BUSINESS RULE (owner, 2026-09-25)
--
--   Admin approval of a revised PI makes that version current. If its value
--   changes, the Confirmed Order's commercial value changes in the SAME
--   transaction, recorded as an amendment with the old and new values, the
--   actor and the time. Operations receives the revised PI for review; its
--   acknowledgement does not stand between the admin's approval and the
--   version being current.
--
-- WHAT IT REPLACES (20270101000000, #205)
--
--   #205 STAGED a revision at admin approval ('admin_approved') and promoted
--   it only when the operations reviewer accepted it, refusing acceptance
--   while the revision differed from the Order on an amendable field until
--   someone amended the Order by hand. Both halves contradict the rule above.
--   This file re-emits approve_order_pi_revision() to APPLY instead of stage.
--   Everything else #205 built is kept and simply sees no new staged rows:
--   decide_order_pi_revision_operations(), reapprove_order_pi_revision() and
--   the freeze triggers still govern any 'admin_approved' row that exists
--   (none in production — #205 was never deployed).
--
-- WHAT OPERATIONS STILL DOES (20261229000000, unchanged)
--
--   When the version becomes 'approved' the existing handoff trigger records
--   an operations handoff for THAT version, addresses it to the assigned
--   reviewer, tells them, and resets a production alignment that covered the
--   previous version. The reviewer accepts (aligning the Order for production)
--   or flags it through decide_order_operations_handoff(). That decision is
--   about production readiness; it never un-does or delays the PI in force.
--
-- ONE TRANSACTION, IN THIS ORDER
--
--   checks (#205's, word for word) → lease (the route's, or taken here) →
--   outgoing content captured → the existing parse writer → the Order's five
--   amendable fields restored, then moved by apply_order_amendment() (the
--   audited door: 'order_amended', source 'pi_revision') → terms seeded →
--   previous version superseded, this one approved (handoff trigger fires) →
--   product codes re-attached to continuing lines, fresh codes for added
--   lines → activity + Sales told.
--
-- PRODUCT CODES (order_product_codes, 20261124000000)
--
--   The parse writer deletes and re-inserts every line; the code's foreign key
--   is ON DELETE SET NULL, so until now every revision orphaned every code and
--   issued fresh ones (V2's lines became BE003/BE004). An EDIT revision keeps
--   each continuing line's item id (renamed or not), so the codes linked to
--   those ids just before the parse are re-attached to the same ids after it.
--   A removed line's code stays orphaned and retired; an added line gets the
--   next sequence, which is always above every code ever issued. A WORKBOOK
--   revision carries no line identity (fresh ids, row-position sequences), so
--   its lines are coded afresh, exactly as before.
--
--   The item sequence (B001 …) of a removed line is retired too: an edit
--   revision that gives an added line — or re-numbers a continuing one to —
--   a sequence any earlier line of this Order held is refused.
--
-- ALSO HERE
--
--   * The Finance "Allocated Against" read names a PI Draft by its stable
--     draft reference (PID-00012) instead of its workbook file name; same
--     result shape.
--   * order_pi_versions_guard: pending → approved is legal again, but only
--     inside this function's apply context.
--   * 20270103000000's edit-terms trigger fires on pending → approved too.
--
-- NOT CHANGED: who may propose, who may approve (an active admin), payments,
-- allocations, the handoff and alignment rules, the Order's identity and number.

do $$
begin
  if to_regclass('public.order_pi_version_contents') is null
     or to_regprocedure('public.order_pi_content_of(uuid)') is null then
    raise exception 'PRECONDITION FAILED: 20270103000000 (PI edit revisions) is not applied';
  end if;
end $$;


-- ═══ 1. order_pi_versions_guard: pending → approved inside the apply ═══════
--
-- As 20270101000000 left it, with ONE transition added back: pending →
-- approved, only while approve_order_pi_revision() holds the apply context for
-- this version's PI (boe.pi_revision_apply = submission id).

create or replace function public.order_pi_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then
      return old;
    end if;
    raise exception
      'ORDER_PI_VERSION_IMMUTABLE: PI version history cannot be deleted'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      return new;
    end if;
    if new.status = 'approved' and new.version_number = 1
       and public.in_pi_submission_approval(new.submission_id) then
      return new;
    end if;
    raise exception
      'ORDER_PI_VERSION_INVALID: a PI version is created pending, or as V1 by approving the PI'
      using errcode = '42501';
  end if;

  if new.order_id        is distinct from old.order_id
     or new.submission_id  is distinct from old.submission_id
     or new.version_number is distinct from old.version_number
     or new.workbook_path  is distinct from old.workbook_path
     or new.workbook_name  is distinct from old.workbook_name
     or new.uploaded_by    is distinct from old.uploaded_by
     or new.uploaded_at    is distinct from old.uploaded_at
     or new.revision_reason is distinct from old.revision_reason
     or new.created_at     is distinct from old.created_at then
    raise exception
      'ORDER_PI_VERSION_IMMUTABLE: the identity and document of PI version % cannot be changed', old.id
      using errcode = '42501';
  end if;

  if new.status is not distinct from old.status then
    if old.status = 'admin_approved'
       and current_setting('boe.pi_revision_reapprove', true) = old.id::text
       and new.decision_reason is not distinct from old.decision_reason
       and new.operations_decided_by is null and new.operations_decided_at is null
       and new.operations_reason is null and new.applied_at is null
       and new.operations_reviewer is not distinct from old.operations_reviewer then
      return new;
    end if;
    if old.status <> 'pending'
       and (new.decided_by is distinct from old.decided_by
            or new.decided_at is distinct from old.decided_at
            or new.decision_reason is distinct from old.decision_reason
            or new.operations_decided_by is distinct from old.operations_decided_by
            or new.operations_decided_at is distinct from old.operations_decided_at
            or new.operations_reason is distinct from old.operations_reason
            or new.applied_at is distinct from old.applied_at) then
      raise exception
        'ORDER_PI_VERSION_IMMUTABLE: the decision on PI version % cannot be rewritten', old.id
        using errcode = '42501';
    end if;
    if new.operations_reviewer is distinct from old.operations_reviewer and old.status <> 'admin_approved' then
      raise exception
        'ORDER_PI_VERSION_IMMUTABLE: only a revision awaiting operations can be readdressed'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status = 'rejected' then
    return new;
  end if;
  -- (20270104000000) An admin's approval puts the revision in force, inside
  -- approve_order_pi_revision()'s apply context and nowhere else.
  if old.status = 'pending' and new.status = 'approved'
     and current_setting('boe.pi_revision_apply', true) = new.submission_id::text
     and new.decided_by is not null and new.decided_at is not null then
    return new;
  end if;
  if old.status = 'pending' and new.status = 'admin_approved' then
    return new;
  end if;
  if old.status = 'admin_approved' and new.status = 'rejected'
     and new.operations_decided_at is not null then
    return new;
  end if;
  if old.status = 'admin_approved' and new.status = 'approved'
     and current_setting('boe.pi_revision_apply', true) = new.submission_id::text
     and new.operations_decided_at is not null then
    return new;
  end if;
  if old.status = 'approved' and new.status = 'superseded' then
    return new;
  end if;

  raise exception
    'ORDER_PI_VERSION_TRANSITION_INVALID: PI version % cannot move from % to %',
    old.id, old.status, new.status
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_pi_versions_guard()
  from public, anon, authenticated, service_role;


-- ═══ 2. An edit revision's terms are applied when it becomes current ═══════
--
-- Same function as 20270103000000; the trigger now also fires on the direct
-- pending → approved step.

drop trigger if exists order_pi_versions_apply_edit_terms on public.order_pi_versions;
create trigger order_pi_versions_apply_edit_terms
  after update of status on public.order_pi_versions
  for each row
  when (old.status in ('pending', 'admin_approved') and new.status = 'approved' and new.source_kind = 'edit')
  execute function public.order_pi_versions_apply_edit_terms();


-- ═══ 3. The item sequences an Order has ever used ══════════════════════════
--
-- Every line that ever reached a version in force was given a BOE code, and
-- the code kept the sequence the line had then. So this is the complete list
-- of sequences a new line may not take. Read by the Edit PI route (to number
-- an added line) and by approve_order_pi_revision() (to refuse one).

create or replace function public.order_item_sequences_ever_used(p_order_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct upper(btrim(c.source_item_sequence))), '{}'::text[])
    from public.order_product_codes c
   where c.order_id = p_order_id
     and nullif(btrim(coalesce(c.source_item_sequence, '')), '') is not null
$$;
comment on function public.order_item_sequences_ever_used(uuid) is
  'SERVICE ROLE ONLY. Every item sequence (B001 …) a line of this Order held when it was given its BOE code — current and removed lines alike. An added line may never take one of these. 20270104000000.';
revoke execute on function public.order_item_sequences_ever_used(uuid) from public, anon, authenticated;
grant  execute on function public.order_item_sequences_ever_used(uuid) to service_role;


-- ═══ 4. approve_order_pi_revision, re-emitted: APPLY, and amend the Order ══

create or replace function public.approve_order_pi_revision(
  p_version_id uuid,
  p_actor_id   uuid,
  p_payload    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin  boolean;
  v_ver       public.order_pi_versions%rowtype;
  v_current   public.order_pi_versions%rowtype;
  v_order     public.orders%rowtype;
  v_sub       public.order_submissions%rowtype;
  v_path      text;
  v_now       timestamptz := now();
  v_token     uuid;
  v_own_lease boolean := false;
  v_result    jsonb;
  v_codes     jsonb;
  v_relinked  jsonb := '[]'::jsonb;
  v_blocking  jsonb;
  v_amend     jsonb;
  v_seed      jsonb;
  v_pre_codes jsonb;
  v_pre_items jsonb;
  v_retired   text;
  v_name      text;
  v_reason    text;
  v_handoff   uuid;
  v_client    text;
  v_confirm   date;
  v_due       date;
  v_total     numeric;
  v_product   numeric;
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required'
      using errcode = '28000';
  end if;

  select coalesce(u.role = 'admin', false) into v_is_admin
  from public.users u
  where u.id = p_actor_id and u.is_active and coalesce(u.is_deleted, false) = false;
  if not found or not coalesce(v_is_admin, false) then
    raise exception 'You do not have permission to decide a revised PI'
      using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id;
  if not found then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  -- LOCK ORDER: reviewers (SHARE) → orders → submission → versions → handoffs.
  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;

  select * into v_order from public.orders where id = v_ver.order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception
      'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled and cannot take a revised PI', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = v_ver.submission_id for update;
  if not found or v_sub.order_id is distinct from v_order.id then
    raise exception
      'ORDER_PI_REVISION_INVALID: the PI behind Order % is not the one this version names', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  if v_ver.status <> 'pending' then
    raise exception
      'ORDER_PI_REVISION_NOT_PENDING: PI version % is % and is no longer waiting for a decision',
      v_ver.version_number, v_ver.status
      using errcode = 'P0001';
  end if;

  select * into v_current from public.order_pi_versions
  where order_id = v_order.id and status = 'approved' for update;

  if v_current.id is not null and v_current.version_number >= v_ver.version_number then
    raise exception
      'ORDER_PI_REVISION_STALE: PI version % is older than the current approved version %',
      v_ver.version_number, v_current.version_number
      using errcode = 'P0001';
  end if;

  v_path := nullif(btrim(coalesce(p_payload -> 'source' ->> 'workbook_path', '')), '');
  if v_path is null or v_path is distinct from v_ver.workbook_path then
    raise exception
      'ORDER_PI_REVISION_FILE_MISMATCH: the parsed workbook is not the file this revision proposed'
      using errcode = 'P0001';
  end if;

  -- A route from before 20270101000000 does not send the terms to seed; it
  -- would seed them itself afterwards and delete pictures. Refused, as #205.
  if jsonb_typeof(p_payload -> 'seed_terms') is distinct from 'object' then
    raise exception
      'ORDER_PI_REVISION_CLIENT_UPDATE_REQUIRED: this version of the app cannot approve a revised PI. Reload once the update is live and approve it again.'
      using errcode = 'P0001';
  end if;

  -- ── THE ORDER'S VALUE MUST BE KNOWN ──
  -- The Order's value is amended to the revision's Grand Total. A revision
  -- whose Grand Total could not be read would leave the Order and its PI
  -- disagreeing, so it is refused in words.
  v_total := nullif(p_payload -> 'commercial' ->> 'grand_total', '')::numeric;
  if v_total is null or v_total < 0 then
    raise exception
      'ORDER_PI_REVISION_NO_GRAND_TOTAL: PI V% has no readable Grand Total, so the Order''s value cannot be amended to it. Correct the PI and propose it again.',
      v_ver.version_number
      using errcode = 'P0001';
  end if;

  -- What the Order will be amended to: #205's definition of a difference (a PI
  -- without a client, confirm date or due date leaves the Order's as it is).
  v_blocking := public.order_pi_revision_blocking_differences(p_payload, v_order.id);
  if jsonb_array_length(v_blocking) > 0 and v_order.status = 'dispatched' then
    raise exception
      'ORDER_CLOSED: Order % is dispatched and its terms can no longer be amended, so PI V% (which changes them) cannot be approved',
      v_order.display_number, v_ver.version_number
      using errcode = '42501';
  end if;

  -- ── THE LEASE ──
  -- The workbook route parses under its own lease and sends its token; an edit
  -- revision has nothing to parse and arrives without one, so it is taken here.
  v_token := nullif(p_payload ->> 'processing_token', '')::uuid;
  if v_token is null then
    v_token := gen_random_uuid();
    v_own_lease := true;
    perform public.begin_order_submission_processing(v_sub.id, p_actor_id, v_token);
  end if;

  -- ── WHAT IS BEING REPLACED ──
  -- The codes each current line holds, and the lines themselves, before the
  -- parse deletes them; and the outgoing version's complete content, read
  -- back later by order_pi_version_detail().
  select coalesce(jsonb_agg(jsonb_build_object('code_id', c.id, 'item_id', c.submission_item_id)), '[]'::jsonb)
    into v_pre_codes
    from public.order_product_codes c
   where c.order_id = v_order.id and c.submission_item_id is not null;
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'seq', upper(btrim(i.item_sequence)))), '[]'::jsonb)
    into v_pre_items
    from public.order_submission_items i where i.submission_id = v_sub.id;

  -- With each line's BOE code as it stood, so the outgoing version's PDF can
  -- print its own codes — a removed line's code is orphaned a moment later.
  if v_current.id is not null then
    insert into public.order_pi_version_contents (version_id, content)
    values (v_current.id, public.order_pi_content_of(v_sub.id) || jsonb_build_object('codes',
      coalesce((select jsonb_object_agg(c.submission_item_id::text, c.boe_sequence)
                  from public.order_product_codes c
                 where c.order_id = v_order.id and c.submission_item_id is not null), '{}'::jsonb)))
    on conflict (version_id) do nothing;
  end if;

  insert into public.order_pi_revision_staged_parses (
    version_id, submission_id, payload, staged_by, staged_at, superseded_snapshot, applied_at, applied_by)
  values (
    v_ver.id, v_sub.id, p_payload - 'processing_token', p_actor_id, v_now,
    jsonb_build_object(
      'version_id', v_current.id, 'version_number', v_current.version_number,
      'order', jsonb_build_object('client_name', v_order.client_name, 'confirm_date', v_order.confirm_date,
                                  'due_date', v_order.due_date, 'total_value', v_order.total_value,
                                  'total_product_value', v_order.total_product_value,
                                  'billing_percentage', v_sub.billing_percentage),
      'items',  coalesce((select jsonb_agg(to_jsonb(i) order by i.sort_order) from public.order_submission_items i where i.submission_id = v_sub.id), '[]'::jsonb),
      'images', coalesce((select jsonb_agg(to_jsonb(m)) from public.order_submission_item_images m where m.submission_id = v_sub.id), '[]'::jsonb)),
    v_now, p_actor_id);

  -- ── APPLY, through the unchanged parse writer ──
  v_reason := left('PI V' || v_ver.version_number::text || ' approved: ' || v_ver.revision_reason, 500);
  perform set_config('boe.pi_revision_apply', v_sub.id::text, true);
  perform set_config('boe.amendment_context', 'order_amendment', true);
  v_result := public.replace_order_submission_parse(v_sub.id, p_actor_id,
    p_payload || jsonb_build_object('processing_token', v_token, 'change_reason', v_reason));

  if (select source_workbook_path from public.order_submissions where id = v_sub.id) is distinct from v_ver.workbook_path then
    raise exception 'ORDER_PI_REVISION_NOT_APPLIED: the revised workbook was not recorded on the PI' using errcode = 'P0001';
  end if;

  -- ── THE ORDER'S FIVE AMENDABLE FIELDS: through the audited door ──
  -- The parse writer mirrors the PI onto the Order without an amendment
  -- record. Put the Order back exactly as it was, then move it to the
  -- revision's values through apply_order_amendment(), which writes the
  -- 'order_amended' entry with each field's old and new value, the approving
  -- admin and the time.
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders
     set client_name = v_order.client_name, confirm_date = v_order.confirm_date, due_date = v_order.due_date,
         total_value = v_order.total_value, total_product_value = v_order.total_product_value
   where id = v_order.id
     and (client_name, confirm_date, due_date, total_value, total_product_value)
         is distinct from (v_order.client_name, v_order.confirm_date, v_order.due_date,
                           v_order.total_value, v_order.total_product_value);
  perform set_config('boe.amendment_context', '', true);

  if jsonb_array_length(v_blocking) > 0 then
    select max(case when d ->> 'field' = 'client_name'         then d ->> 'pi_value' end),
           max(case when d ->> 'field' = 'confirm_date'        then d ->> 'pi_value' end)::date,
           max(case when d ->> 'field' = 'due_date'            then d ->> 'pi_value' end)::date,
           max(case when d ->> 'field' = 'total_product_value' then d ->> 'pi_value' end)::numeric
      into v_client, v_confirm, v_due, v_product
      from jsonb_array_elements(v_blocking) d;
    v_amend := public.apply_order_amendment(
      v_order.id, p_actor_id, v_reason, 'pi_revision', null,
      v_client,
      case when exists (select 1 from jsonb_array_elements(v_blocking) d where d ->> 'field' = 'total_value')
           then v_total end,
      v_product, v_confirm, v_due, null, null);
  end if;

  if v_own_lease then
    perform public.finish_order_submission_processing(v_sub.id, v_token);
  end if;

  v_seed := p_payload -> 'seed_terms';
  perform public.seed_order_submission_pi_terms(v_sub.id,
    v_seed ->> 'fabric_responsibility', v_seed ->> 'commercial_terms_note', v_seed ->> 'client_city');

  -- ── THE VERSION IN FORCE CHANGES ──
  -- (The handoff trigger records this version's operations handoff and resets
  -- an alignment that covered the previous one; the edit-terms trigger applies
  -- an edit revision's terms.)
  if v_current.id is not null then
    update public.order_pi_versions
       set status = 'superseded', superseded_at = v_now, superseded_by_version_id = v_ver.id
     where id = v_current.id;
  end if;
  update public.order_pi_versions
     set status = 'approved',
         decided_by = p_actor_id,
         decided_at = v_now,
         applied_at = v_now,
         workbook_sha256 = coalesce(nullif(lower(p_payload -> 'source' ->> 'workbook_sha256'), ''), workbook_sha256)
   where id = v_ver.id;
  perform set_config('boe.pi_revision_apply', '', true);

  -- ── PRODUCT CODES ──
  -- An edit revision: a continuing line keeps its item id, so it gets back the
  -- code it held. A workbook revision's lines are all new ids and match nothing.
  if v_ver.source_kind = 'edit' then
    with back as (
      update public.order_product_codes c
         set submission_item_id = (p.value ->> 'item_id')::uuid
        from jsonb_array_elements(v_pre_codes) p
       where c.id = (p.value ->> 'code_id')::uuid
         and c.submission_item_id is null
         and exists (select 1 from public.order_submission_items i
                      where i.submission_id = v_sub.id and i.id = (p.value ->> 'item_id')::uuid)
      returning c.submission_item_id, c.boe_sequence
    )
    select coalesce(jsonb_agg(jsonb_build_object('submission_item_id', submission_item_id,
                                                 'boe_item_code', 'BE' || lpad(boe_sequence::text, 3, '0'))), '[]'::jsonb)
      into v_relinked from back;

    -- A RETIRED SEQUENCE IS NEVER HANDED OUT AGAIN: a line that is new, or
    -- whose sequence changed, may not take one any line of this Order held.
    select string_agg(distinct i.item_sequence, ', ') into v_retired
      from public.order_submission_items i
     where i.submission_id = v_sub.id
       and nullif(btrim(coalesce(i.item_sequence, '')), '') is not null
       and upper(btrim(i.item_sequence)) = any (public.order_item_sequences_ever_used(v_order.id)
                                                || array(select p.value ->> 'seq' from jsonb_array_elements(v_pre_items) p))
       and not exists (select 1 from jsonb_array_elements(v_pre_items) p
                        where (p.value ->> 'id')::uuid = i.id and p.value ->> 'seq' = upper(btrim(i.item_sequence)));
    if v_retired is not null then
      raise exception
        'ORDER_PI_EDIT_SEQUENCE_RETIRED: PI V% gives % to a product, but that item number already belonged to another product on this Order. Choose a new number.',
        v_ver.version_number, v_retired
        using errcode = 'P0001';
    end if;
  end if;
  v_codes := public.assign_order_product_codes(v_order.id, p_actor_id);

  -- ── RECORDS ──
  select id into v_handoff from public.order_operations_handoffs
   where pi_version_id = v_ver.id and superseded_at is null;

  perform public.log_order_submission_activity(
    v_sub.id, p_actor_id, 'pi_revision_approved', 'approved', 'approved', null,
    jsonb_build_object('order_id', v_order.id, 'version_id', v_ver.id,
                       'version_number', v_ver.version_number,
                       'superseded_version_id', v_current.id,
                       'superseded_version_number', v_current.version_number,
                       'order_amendment', v_amend -> 'changes',
                       'superseded_documents', v_result -> 'superseded_documents'));

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, p_actor_id, 'pi_revision_approved',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'superseded_version_number', v_current.version_number,
                             'source_kind', v_ver.source_kind,
                             'order_amendment', v_amend -> 'changes',
                             'handoff_id', v_handoff,
                             'superseded_documents', v_result -> 'superseded_documents'));

  if jsonb_array_length(v_codes) > 0 or jsonb_array_length(v_relinked) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_order.id, p_actor_id, 'order_product_codes_assigned',
            jsonb_build_object('codes', v_codes, 'kept', v_relinked, 'version_id', v_ver.id));
  end if;

  -- The person who proposed it hears that it is now the PI in force.
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = p_actor_id;
  if v_ver.uploaded_by is not null and v_ver.uploaded_by <> p_actor_id then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_ver.uploaded_by, null, v_order.id, 'order_operations_review_decided'::notification_type,
            format('Order %s: %s approved PI V%s — it is now the PI in force.', v_order.display_number,
                   coalesce(v_name, 'an administrator'), v_ver.version_number),
            case when v_amend is not null then 'The Order''s commercial values were amended to match it.'
                 else 'Operations has been sent it for review.' end,
            true);
  end if;

  return jsonb_build_object(
    'version_id',       v_ver.id,
    'version_number',   v_ver.version_number,
    'order_id',         v_order.id,
    'status',           'approved',
    'superseded_version_number', v_current.version_number,
    'order_amendment',  v_amend -> 'changes',
    'handoff_id',       v_handoff,
    'codes_kept',       jsonb_array_length(v_relinked),
    'codes_issued',     jsonb_array_length(v_codes),
    'parse',            v_result
  );
end;
$$;

comment on function public.approve_order_pi_revision(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. An active admin approves a pending revised PI (workbook or edit), and it is IN FORCE when this returns (20270104000000): in one transaction the outgoing content is captured, the parse is applied through replace_order_submission_parse, the Order''s client/dates/value/product value are moved through apply_order_amendment (an ''order_amended'' record, source pi_revision, old → new), the previous version is superseded and this one approved — which records its operations handoff for review — continuing lines keep their BOE codes (edit revisions) and added lines get fresh ones. Refuses a non-pending version, a stale one, a cancelled Order, a mismatched file, a missing Grand Total, a value change on a dispatched Order, and a retired item sequence.';

revoke execute on function public.approve_order_pi_revision(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.approve_order_pi_revision(uuid, uuid, jsonb) to service_role;


-- ═══ 4b. What a version contained: the reader's own access, captured first ═
--
-- As 20270103000000, with two corrections:
--   * ACCESS. can_view_order() is SECURITY INVOKER by design; called from this
--     SECURITY DEFINER function it ran as the owner and answered yes for every
--     Order. can_view_order_as_actor() asks for the signed-in person.
--   * A REPLACED EDIT VERSION returns what was actually in force (captured when
--     it was replaced, with its codes) rather than its proposal; a pending or
--     rejected edit version still returns its proposal.

create or replace function public.order_pi_version_detail(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v   public.order_pi_versions%rowtype;
  v_c jsonb;
begin
  select * into v from public.order_pi_versions where id = p_version_id;
  if not found or not coalesce(public.can_view_order_as_actor(v.order_id), false) then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  if v.status = 'approved' then
    return jsonb_build_object('source', 'live', 'content', null);
  end if;
  select content into v_c from public.order_pi_version_contents where version_id = v.id;
  if v_c is not null then
    return jsonb_build_object('source', 'captured', 'content', v_c);
  end if;
  if v.source_kind = 'edit' then
    return jsonb_build_object('source', 'proposal', 'content', v.proposal);
  end if;
  if v.status = 'superseded' then
    select sp.superseded_snapshot into v_c from public.order_pi_revision_staged_parses sp
     where sp.version_id = v.superseded_by_version_id;
    return jsonb_build_object('source', case when v_c is null then 'none' else 'snapshot' end, 'content', v_c);
  end if;
  select sp.payload - 'processing_token' into v_c from public.order_pi_revision_staged_parses sp where sp.version_id = v.id;
  return jsonb_build_object('source', case when v_c is null then 'none' else 'staged' end,
                            'content', case when v_c is null then null else jsonb_build_object('payload', v_c) end);
end;
$$;
comment on function public.order_pi_version_detail(uuid) is
  'What one PI version contained, for the signed-in person if they may open its Order (can_view_order_as_actor): {source: live | captured | proposal | snapshot | staged | none, content}. Read-only. 20270103000000, 20270104000000.';
revoke execute on function public.order_pi_version_detail(uuid) from public, anon;
grant  execute on function public.order_pi_version_detail(uuid) to authenticated;


-- ═══ 5. Finance: a PI Draft is named by its stable reference ═══════════════
--
-- Same result shape as 20261216000000 §3; target_reference for a PI Draft is
-- its draft reference (PID-00012), falling back to the workbook's file name
-- only for a row that has none. An allocation moved onto an Order at approval
-- is read as that Order (its number), as before.

create or replace function public.received_payment_allocation_targets(
  p_payment_request_ids uuid[]
)
returns table (
  payment_request_id    uuid,
  allocation_id         uuid,
  target_type           text,
  target_id             uuid,
  target_reference      text,
  reserved_order_number text,
  allocated_amount      numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'ALLOCATION_TARGETS_AUTH_REQUIRED: sign in to read payment allocations.'
      using errcode = '28000';
  end if;

  if not coalesce(public.module_entry_open('finance'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: Finance access is required.'
      using errcode = '42501';
  end if;

  if not coalesce(public.actor_has_module_permission('finance', 'view'), false) then
    raise exception 'ALLOCATION_TARGETS_NOT_PERMITTED: you do not have permission to view Finance payments.'
      using errcode = '42501';
  end if;

  if coalesce(cardinality(p_payment_request_ids), 0) > 50 then
    raise exception 'ALLOCATION_TARGETS_TOO_MANY: at most 50 payments may be read at once (got %).',
      cardinality(p_payment_request_ids)
      using errcode = '22023';
  end if;

  if coalesce(cardinality(p_payment_request_ids), 0) = 0 then
    return;
  end if;

  return query
  select
    a.payment_request_id,
    a.id,
    case when a.order_id is not null then 'order' else 'pi_draft' end,
    coalesce(a.order_id, a.order_submission_id),
    case
      when a.order_id is not null then nullif(btrim(o.display_number), '')
      -- The draft's stable reference (20270102000000). Never source_order_number.
      else coalesce(nullif(btrim(s.draft_reference), ''),
                    nullif(btrim(regexp_replace(coalesce(s.source_workbook_name, ''), '^.*[\\/]', '')), ''))
    end,
    case when a.order_id is null then nullif(btrim(s.reserved_order_number), '') end,
    a.allocated_amount
  from public.finance_payment_requests f
  join public.finance_payment_allocations a on a.payment_request_id = f.id
  left join public.orders            o on o.id = a.order_id
  left join public.order_submissions s on s.id = a.order_submission_id
  where f.id = any (p_payment_request_ids)
    and public.finance_payment_status_is_verified(f.status)
    and public.received_payment_visible_to_actor(f.id)
    and a.status = 'active'
    and (a.order_id is not null or a.order_submission_id is not null)
  order by a.payment_request_id, a.created_at, a.id;
end;
$$;

comment on function public.received_payment_allocation_targets(uuid[]) is
  'The ACTIVE allocation targets (type, id, safe reference, reserved Order number, amount) of at most 50 CONFIRMED payments, for the Confirmed Payments list''s Allocated Against cell and Allocation Status badge. A PI Draft is named by its draft reference (PID-00012; 20270104000000), an Order by its number. Returns rows only to an authenticated caller with Finance module entry who holds finance.view as an active user (admin bypass), and only for payments that caller may already read (received_payment_visible_to_actor). Never returns source_order_number, client or other Order/PI fields. 20261216000000, 20270104000000.';

revoke execute on function public.received_payment_allocation_targets(uuid[]) from public, anon, service_role;
grant  execute on function public.received_payment_allocation_targets(uuid[]) to authenticated;


-- ═══ 6. Apply-time assertions ══════════════════════════════════════════════
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'approve_order_pi_revision';
  if position('replace_order_submission_parse(' in v_src) = 0
     or position('apply_order_amendment(' in v_src) = 0
     or position('assign_order_product_codes(' in v_src) = 0
     or position('''pi_revision_approved''' in v_src) = 0
     or position('superseded_by_version_id = v_ver.id' in v_src) = 0 then
    raise exception 'ASSERT: approve_order_pi_revision must apply the revision, amend the Order, and code the lines';
  end if;
  if position('from public.order_operations_reviewers where duty = ''pi_handoff'' for share' in v_src)
     > position('from public.orders where id = v_ver.order_id for update' in v_src) then
    raise exception 'ASSERT: approve_order_pi_revision must lock the reviewer row before the Order';
  end if;
  if has_function_privilege('authenticated', 'public.approve_order_pi_revision(uuid, uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.approve_order_pi_revision(uuid, uuid, jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.approve_order_pi_revision(uuid, uuid, jsonb)', 'EXECUTE') then
    raise exception 'ASSERT: approve_order_pi_revision must stay service-role only';
  end if;
  if has_function_privilege('authenticated', 'public.order_item_sequences_ever_used(uuid)', 'EXECUTE') then
    raise exception 'ASSERT: order_item_sequences_ever_used is server-only';
  end if;
  if pg_get_function_result('public.received_payment_allocation_targets(uuid[])'::regprocedure) <>
     'TABLE(payment_request_id uuid, allocation_id uuid, target_type text, target_id uuid, target_reference text, reserved_order_number text, allocated_amount numeric)'
     or has_function_privilege('service_role', 'public.received_payment_allocation_targets(uuid[])', 'EXECUTE')
     or has_function_privilege('anon', 'public.received_payment_allocation_targets(uuid[])', 'EXECUTE') then
    raise exception 'ASSERT: the Allocated Against read changed shape or privileges';
  end if;
end $$;

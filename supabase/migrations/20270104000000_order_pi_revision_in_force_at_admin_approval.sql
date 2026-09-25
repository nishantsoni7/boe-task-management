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
--   revision's item ids are derived from the ROW, so they say nothing about
--   the product: there a line continues the line in force with the same item
--   number (column J), unique on both sides; a blank or duplicated number is
--   matched by the admin (line_map) or the approval is refused, listing them.
--
--   The item sequence (B001 …) of a removed line is retired too: a revision
--   of either kind that gives it to any other product is refused.
--
-- ALSO HERE
--
--   * Workbook revisions keep codes too: a line continues the line in force
--     with the same item number; a blank or duplicated number must be matched
--     by the admin before the approval goes through (§4).
--   * A reserved Order number is never issued to anything else, even after
--     its draft is deleted (§4c: order_reserved_number_ledger).
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
  v_map       jsonb := '{}'::jsonb;   -- new item id → the item id it continues
  v_review    jsonb := '[]'::jsonb;
  v_explicit  text;
  n           record;
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

  -- ── WHICH PRODUCT EACH NEW LINE IS ──
  -- Decided BEFORE anything is written, from the lines in force now.
  --   edit       a continuing line keeps its item id (renamed or not); a line
  --              with an id not in force is new.
  --   workbook   the parse route derives item ids from the ROW, so an id says
  --              nothing about the product on it. A line continues the line in
  --              force with the SAME item number (column J) — unique on both
  --              sides. A blank or duplicated number is AMBIGUOUS: the admin
  --              matches it (payload.line_map: {new id: old id | "new"}) or the
  --              approval is refused with the lines to match, changing nothing.
  -- Either way an item number a line of this Order EVER held may only stay
  -- with the product that held it; on any other line it is refused.
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'seq', nullif(upper(btrim(coalesce(i.item_sequence, ''))), ''),
                                               'name', i.product_name,
                                               'code', (select 'BE' || lpad(c.boe_sequence::text, 3, '0') from public.order_product_codes c
                                                         where c.order_id = v_order.id and c.submission_item_id = i.id))
                            order by i.sort_order, i.source_row), '[]'::jsonb)
    into v_pre_items
    from public.order_submission_items i where i.submission_id = v_sub.id;

  if v_ver.source_kind = 'edit' then
    select coalesce(jsonb_object_agg(e ->> 'id', e ->> 'id'), '{}'::jsonb) into v_map
      from jsonb_array_elements(p_payload -> 'items') e
     where exists (select 1 from jsonb_array_elements(v_pre_items) p where p.value ->> 'id' = e ->> 'id');
  else
    for n in
      select e ->> 'id' as id, nullif(upper(btrim(coalesce(e ->> 'item_sequence', ''))), '') as seq,
             e ->> 'product_name' as name, e ->> 'quantity' as qty
        from jsonb_array_elements(p_payload -> 'items') e
    loop
      v_explicit := p_payload -> 'line_map' ->> n.id;
      if v_explicit = 'new' then
        continue;
      elsif v_explicit is not null then
        if not exists (select 1 from jsonb_array_elements(v_pre_items) p where p.value ->> 'id' = v_explicit) then
          raise exception 'ORDER_PI_REVISION_LINE_MAP_INVALID: a line of PI V% is matched to a product that is not in force',
            v_ver.version_number using errcode = 'P0001';
        end if;
        v_map := v_map || jsonb_build_object(n.id, v_explicit);
      elsif n.seq is null
         or (select count(*) from jsonb_array_elements(p_payload -> 'items') e2
              where nullif(upper(btrim(coalesce(e2 ->> 'item_sequence', ''))), '') = n.seq) > 1
         or (select count(*) from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' = n.seq) > 1 then
        v_review := v_review || jsonb_build_object('id', n.id, 'seq', n.seq, 'name', n.name, 'qty', n.qty,
          'why', case when n.seq is null then 'no item number' else 'item number used more than once' end);
      elsif exists (select 1 from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' = n.seq) then
        v_map := v_map || jsonb_build_object(n.id,
          (select p.value ->> 'id' from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' = n.seq));
      end if;   -- otherwise: a new product
    end loop;

    if (select count(*) from jsonb_each_text(v_map)) <> (select count(distinct value) from jsonb_each_text(v_map)) then
      raise exception 'ORDER_PI_REVISION_LINE_MAP_INVALID: two lines of PI V% continue the same product',
        v_ver.version_number using errcode = 'P0001';
    end if;
    if jsonb_array_length(v_review) > 0 then
      raise exception using errcode = 'P0001',
        message = format('ORDER_PI_REVISION_LINES_NEED_REVIEW: %s product line(s) of PI V%s cannot be matched to the lines in force by item number. Match each to the product it continues, or mark it new, and approve again.',
                         jsonb_array_length(v_review), v_ver.version_number),
        detail = jsonb_build_object('lines', v_review, 'candidates', v_pre_items)::text;
    end if;
  end if;

  -- A RETIRED ITEM NUMBER IS NEVER HANDED OUT AGAIN.
  select string_agg(distinct e ->> 'item_sequence', ', ') into v_retired
    from jsonb_array_elements(p_payload -> 'items') e
   where nullif(upper(btrim(coalesce(e ->> 'item_sequence', ''))), '') = any (
           public.order_item_sequences_ever_used(v_order.id)
           || array(select p.value ->> 'seq' from jsonb_array_elements(v_pre_items) p where p.value ->> 'seq' is not null))
     and not exists (select 1 from jsonb_array_elements(v_pre_items) p
                      where p.value ->> 'id' = v_map ->> (e ->> 'id')
                        and p.value ->> 'seq' = upper(btrim(e ->> 'item_sequence')));
  if v_retired is not null then
    if v_ver.source_kind = 'edit' then
      raise exception
        'ORDER_PI_EDIT_SEQUENCE_RETIRED: PI V% gives % to a product, but that item number already belonged to another product on this Order. Choose a new number.',
        v_ver.version_number, v_retired using errcode = 'P0001';
    end if;
    raise exception
      'ORDER_PI_REVISION_SEQUENCE_RETIRED: PI V% gives % to a product, but that item number belonged to another product on this Order. Renumber it in the workbook and upload it again.',
      v_ver.version_number, v_retired using errcode = 'P0001';
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
  -- Each continuing line gets back the code the line it continues held (the
  -- parse orphaned it a moment ago); removed lines' codes stay retired; new
  -- lines get the next BOE sequence, above every code ever issued.
  with back as (
    update public.order_product_codes c
       set submission_item_id = (m.key)::uuid
      from jsonb_each_text(v_map) m
      join jsonb_array_elements(v_pre_codes) p on p.value ->> 'item_id' = m.value
     where c.id = (p.value ->> 'code_id')::uuid
       and c.submission_item_id is null
       and exists (select 1 from public.order_submission_items i
                    where i.submission_id = v_sub.id and i.id = (m.key)::uuid)
    returning c.submission_item_id, c.boe_sequence
  )
  select coalesce(jsonb_agg(jsonb_build_object('submission_item_id', submission_item_id,
                                               'boe_item_code', 'BE' || lpad(boe_sequence::text, 3, '0'))), '[]'::jsonb)
    into v_relinked from back;
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
    'parse',            v_result,
    -- Where the verified advance now stands against the amended value (§4d).
    'advance',          public.order_advance_position(v_order.id)
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


-- ═══ 4c. A reserved Order number is never issued to anything else ══════════
--
-- THE RULE. An Order number a PI Draft ever reserved (production: 0524, 0525)
-- is recorded here once and for good. The Confirmed Order number cycle can
-- never be set at or below it — whether its draft is live, rejected,
-- converted, or permanently deleted. Only Test Data Cleanup, removing a TEST
-- draft, removes that draft's entry.
--
-- WHY. 20261009000000's floor (order_number_cycle_respects_reservations) read
-- the reservations of the drafts that EXIST. A draft holding 0525 is in a
-- deletable status; deleting it dropped the floor to 0524, and
-- set_next_confirmed_order_number(525) — which only asks "above the highest
-- ORDER" — would then have handed a number already printed on a customer's PI
-- to a different Order. Reservations are retired (20270102000000), so this
-- ledger only ever holds the numbers that were reserved before that.

create table if not exists public.order_reserved_number_ledger (
  number        text primary key check (number ~ '^[0-9]+$'),
  submission_id uuid,                        -- no FK: the entry outlives its draft
  recorded_at   timestamptz not null default now()
);
comment on table public.order_reserved_number_ledger is
  'Every Order number a PI Draft ever reserved, kept after the draft is rejected, converted or deleted. The number cycle can never be set at or below any of them (order_number_cycle_respects_reservations). Written by trigger only; removed only by Test Data Cleanup. 20270104000000.';
alter table public.order_reserved_number_ledger enable row level security;
revoke all on public.order_reserved_number_ledger from public, anon, authenticated;

insert into public.order_reserved_number_ledger (number, submission_id)
select s.reserved_order_number, s.id from public.order_submissions s
 where s.reserved_order_number ~ '^[0-9]+$'
on conflict (number) do nothing;

create or replace function public.order_reserved_number_ledger_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.in_test_data_cleanup() then return old; end if;
  raise exception 'ORDER_RESERVED_NUMBER_PERMANENT: a reserved Order number stays reserved' using errcode = '42501';
end;
$$;
revoke execute on function public.order_reserved_number_ledger_guard() from public, anon, authenticated, service_role;
drop trigger if exists order_reserved_number_ledger_guard on public.order_reserved_number_ledger;
create trigger order_reserved_number_ledger_guard
  before update or delete on public.order_reserved_number_ledger
  for each row execute function public.order_reserved_number_ledger_guard();

create or replace function public.order_submissions_record_reserved_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- Test Data Cleanup takes a test draft's entry with it; nothing else does.
    if public.in_test_data_cleanup() then
      delete from public.order_reserved_number_ledger where submission_id = old.id;
    end if;
    return old;
  end if;
  if new.reserved_order_number ~ '^[0-9]+$' then
    insert into public.order_reserved_number_ledger (number, submission_id)
    values (new.reserved_order_number, new.id)
    on conflict (number) do nothing;
  end if;
  return new;
end;
$$;
revoke execute on function public.order_submissions_record_reserved_number() from public, anon, authenticated, service_role;
drop trigger if exists order_submissions_record_reserved_number on public.order_submissions;
create trigger order_submissions_record_reserved_number
  after insert or update of reserved_order_number or delete on public.order_submissions
  for each row execute function public.order_submissions_record_reserved_number();

-- The floor, as 20261009000000 §6, reading the ledger as well as the live rows.
create or replace function public.order_number_cycle_respects_reservations()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_reserved bigint;
  v_count    bigint;
begin
  if tg_op = 'UPDATE' and new.next_number is not distinct from old.next_number then
    return new;
  end if;

  select count(*), coalesce(max(n::bigint), 0) into v_count, v_reserved
    from (select s.reserved_order_number as n from public.order_submissions s where s.reserved_order_number ~ '^[0-9]+$'
          union
          select l.number from public.order_reserved_number_ledger l) r;

  if v_count = 0 then
    return new;
  end if;

  if new.next_number <= v_reserved then
    raise exception
      'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION: Order numbers up to % were reserved for PI Drafts; the next Order number cannot be set to % — it would hand out a number that is already on a customer''s document',
      public.format_confirmed_order_number(v_reserved),
      public.format_confirmed_order_number(new.next_number)
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;
revoke execute on function public.order_number_cycle_respects_reservations() from public, anon, authenticated;


-- ═══ 4d. Production is never aligned below the 40% advance ═════════════════
--
-- THE RULE. A revised PI is in force at the admin's approval, and the Order's
-- value moves with it. The verified advance is then measured against the
-- AMENDED value — 40% of orders.total_value, the conversion gate's own
-- threshold (order_submission_required_payment). While it is short, the Order
-- cannot be aligned for production — by Operations accepting a version, by
-- the alignment door, or by any write — until either
--   * enough further payment is VERIFIED by Finance (money awaiting
--     verification does not count), or
--   * an administrator approves an explicit below-40% exception FOR THAT
--     ORDER VALUE (approve_order_advance_exception). An exception is tied to
--     the value it was given at: a later amendment makes it stale. The PI's
--     own pre-conversion exception counts only while the PI still carries the
--     figures it was decided on.
-- Enforced by a trigger on orders.production_alignment, so a disabled button
-- is never the only thing in the way. Moving AWAY from aligned is always
-- allowed; the version stays in force either way.

create table if not exists public.order_advance_exceptions (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.orders(id) on delete cascade,
  order_value       numeric not null check (order_value >= 0),
  verified_at_grant numeric not null,
  shortfall_at_grant numeric not null,
  reason            text not null check (char_length(btrim(reason)) between 10 and 1000),
  approved_by       uuid not null references public.users(id),
  approved_at       timestamptz not null default now()
);
comment on table public.order_advance_exceptions is
  'An administrator''s explicit approval to align a Confirmed Order for production below the 40% verified advance, for the Order value it names. Stale once the Order''s value changes. Written only by approve_order_advance_exception(). 20270104000000.';
alter table public.order_advance_exceptions enable row level security;
revoke all on public.order_advance_exceptions from public, anon, authenticated;

create or replace function public.order_advance_exceptions_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.in_test_data_cleanup() then return old; end if;
  raise exception 'ORDER_ADVANCE_EXCEPTION_IMMUTABLE: an advance exception is a record and cannot be changed' using errcode = '42501';
end;
$$;
revoke execute on function public.order_advance_exceptions_immutable() from public, anon, authenticated, service_role;
drop trigger if exists order_advance_exceptions_immutable on public.order_advance_exceptions;
create trigger order_advance_exceptions_immutable
  before update or delete on public.order_advance_exceptions
  for each row execute function public.order_advance_exceptions_immutable();

-- Where the Order stands. Internal: every figure a person or the gate reads.
create or replace function public.order_advance_position(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  o          public.orders%rowtype;
  s          public.order_submissions%rowtype;
  v_verified numeric;
  v_awaiting numeric;
  v_required numeric;
  v_short    numeric;
  v_exc      public.order_advance_exceptions%rowtype;
  v_pi_exc   boolean := false;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then return null; end if;

  select coalesce(sum(a.allocated_amount), 0) into v_verified
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and public.finance_payment_status_is_verified(f.status);
  select coalesce(sum(a.allocated_amount), 0) into v_awaiting
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and f.status in ('pending_approval', 'needs_clarification');

  v_required := public.order_submission_required_payment(o.total_value);
  v_short    := coalesce(public.order_submission_payment_shortfall(o.total_value, v_verified), 0);

  -- An administrator's exception for THIS value.
  select * into v_exc from public.order_advance_exceptions e
   where e.order_id = o.id and e.order_value = o.total_value
   order by e.approved_at desc limit 1;

  -- The PI's own pre-conversion exception, while the PI and the Order still
  -- carry the figures it was decided on.
  if o.source_order_submission_id is not null then
    select * into s from public.order_submissions where id = o.source_order_submission_id;
    v_pi_exc := s.id is not null
      and s.grand_total is not distinct from o.total_value
      and public.order_submission_exception_current(
            s.advance_exception_status,
            s.advance_exception_decided_grand_total,     s.grand_total,
            s.advance_exception_decided_workbook_sha256, s.source_workbook_sha256,
            s.advance_exception_decided_payment_terms,   s.payment_terms,
            s.advance_exception_decided_billing_terms,   s.billing_terms);
  end if;

  return jsonb_build_object(
    'order_value',  o.total_value,
    'verified',     v_verified,
    'awaiting',     v_awaiting,
    'required',     v_required,
    'shortfall',    v_short,
    'percent',      case when coalesce(o.total_value, 0) > 0 then round(100 * v_verified / o.total_value, 2) end,
    'threshold_percent', public.order_submission_standard_advance_percent(),
    'below',        v_short > 0,
    'exception',    case when v_exc.id is not null then jsonb_build_object(
                      'source', 'order', 'approved_by', v_exc.approved_by, 'approved_at', v_exc.approved_at,
                      'reason', v_exc.reason, 'order_value', v_exc.order_value)
                    when v_pi_exc then jsonb_build_object('source', 'pi', 'approved_by', s.advance_exception_decided_by,
                      'approved_at', s.advance_exception_decided_at)
                    end,
    'ready',        v_short = 0 or v_exc.id is not null or v_pi_exc);
end;
$$;
revoke execute on function public.order_advance_position(uuid) from public, anon, authenticated, service_role;

-- The same, for anybody who may open the Order.
create or replace function public.order_advance_readiness(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not coalesce(public.can_view_order_as_actor(p_order_id), false) then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  return public.order_advance_position(p_order_id);
end;
$$;
comment on function public.order_advance_readiness(uuid) is
  'Where a Confirmed Order stands against the 40% verified advance, measured on its current (amended) value: {order_value, verified, awaiting, required, shortfall, percent, below, exception, ready}. For anybody who may open the Order. 20270104000000.';
revoke execute on function public.order_advance_readiness(uuid) from public, anon;
grant  execute on function public.order_advance_readiness(uuid) to authenticated;

-- An administrator's explicit below-40% exception, for the Order's value now.
create or replace function public.approve_order_advance_exception(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  o        public.orders%rowtype;
  v_pos    jsonb;
  v_id     uuid;
  v_name   text;
  v_rev    uuid;
begin
  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin'
                  and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'Only an administrator can approve production below the 40%% advance' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 10 then
    raise exception 'ORDER_ADVANCE_EXCEPTION_REASON_REQUIRED: say why production may go ahead below the 40%% advance (at least 10 characters)'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'ORDER_ADVANCE_EXCEPTION_REASON_TOO_LONG: the reason may be at most 1000 characters' using errcode = 'P0001';
  end if;

  select user_id into v_rev from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002'; end if;
  if o.status in ('cancelled', 'dispatched') then
    raise exception 'ORDER_CLOSED: Order % is %', o.display_number, o.status using errcode = 'P0001';
  end if;

  v_pos := public.order_advance_position(o.id);
  if not (v_pos ->> 'below')::boolean then
    raise exception 'ORDER_ADVANCE_EXCEPTION_NOT_NEEDED: Order % already has the 40%% advance verified', o.display_number
      using errcode = 'P0001';
  end if;
  if (v_pos ->> 'ready')::boolean then
    raise exception 'ORDER_ADVANCE_EXCEPTION_ALREADY_APPROVED: Order % already has a below-40%% approval for its value of %',
      o.display_number, o.total_value using errcode = 'P0001';
  end if;

  insert into public.order_advance_exceptions (order_id, order_value, verified_at_grant, shortfall_at_grant, reason, approved_by)
  values (o.id, o.total_value, (v_pos ->> 'verified')::numeric, (v_pos ->> 'shortfall')::numeric, v_reason, v_actor)
  returning id into v_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (o.id, v_actor, 'order_advance_exception_approved',
          jsonb_build_object('exception_id', v_id, 'order_value', o.total_value,
                             'verified', v_pos -> 'verified', 'percent', v_pos -> 'percent',
                             'shortfall', v_pos -> 'shortfall', 'reason', v_reason));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  if v_rev is not null and v_rev <> v_actor then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_rev, null, o.id, 'order_operations_review_requested'::notification_type,
            format('Order %s: %s approved production below the 40%% advance.', o.display_number, coalesce(v_name, 'An administrator')),
            v_reason, true);
  end if;

  return jsonb_build_object('exception_id', v_id, 'order_id', o.id) || public.order_advance_position(o.id);
end;
$$;
comment on function public.approve_order_advance_exception(uuid, text) is
  'An active administrator approves aligning a Confirmed Order for production below the 40% verified advance, for its current value, with a reason (10–1000 characters). Refused when not needed or already approved for this value. Logged on the Order; the operations reviewer is told. 20270104000000.';
revoke execute on function public.approve_order_advance_exception(uuid, text) from public, anon;
grant  execute on function public.approve_order_advance_exception(uuid, text) to authenticated;

-- THE GATE.
create or replace function public.orders_alignment_requires_advance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pos jsonb;
begin
  if new.production_alignment is distinct from 'aligned'
     or old.production_alignment is not distinct from 'aligned' then
    return new;
  end if;
  if public.in_test_data_cleanup() then return new; end if;

  -- Measured on the value the Order will have after THIS write.
  v_pos := public.order_advance_position(new.id);
  if new.total_value is distinct from old.total_value then
    v_pos := v_pos || jsonb_build_object('ready', false);   -- never align in the same write that changes the value
  end if;
  if not (v_pos ->> 'ready')::boolean then
    raise exception
      'ORDER_ADVANCE_BELOW_THRESHOLD: Order % has ₹% verified — % of its ₹% value. ₹% more verified payment, or an administrator''s below-40%% approval, is needed before production can be aligned.%',
      new.display_number,
      to_char((v_pos ->> 'verified')::numeric, 'FM99999999999990.00'),
      coalesce(v_pos ->> 'percent', '0') || '%',
      to_char((v_pos ->> 'order_value')::numeric, 'FM99999999999990.00'),
      to_char((v_pos ->> 'shortfall')::numeric, 'FM99999999999990.00'),
      case when (v_pos ->> 'awaiting')::numeric > 0
           then format(' ₹%s is awaiting Finance verification.', to_char((v_pos ->> 'awaiting')::numeric, 'FM99999999999990.00'))
           else '' end
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function public.orders_alignment_requires_advance() from public, anon, authenticated, service_role;
drop trigger if exists orders_alignment_requires_advance on public.orders;
create trigger orders_alignment_requires_advance
  before update of production_alignment on public.orders
  for each row execute function public.orders_alignment_requires_advance();


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
  if exists (select 1 from public.order_submissions s
              where s.reserved_order_number ~ '^[0-9]+$'
                and not exists (select 1 from public.order_reserved_number_ledger l where l.number = s.reserved_order_number)) then
    raise exception 'ASSERT: every reserved Order number is in the ledger';
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

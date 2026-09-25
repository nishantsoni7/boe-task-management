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
--   * THE 40% ADVANCE (§4d): production is never aligned below 40% verified
--     of the Order's current value, and an aligned Order that falls short —
--     its value raised by any path, or its verified money reduced — loses its
--     alignment in the same transaction, with a recorded hold, and management
--     is told. A below-40% exception belongs to one value basis (value epoch +
--     PI version + verified amount). No value on record is never "ready".
--     decide_order_operations_handoff() is re-emitted so an accepted version
--     can be aligned again once the hold is cleared.
--
-- NOT CHANGED: who may propose, who may approve (an active admin), payments,
-- allocations, the Order's identity and number, its status and history.

do $$
begin
  if to_regclass('public.order_pi_version_contents') is null
     or to_regprocedure('public.order_pi_content_of(uuid)') is null then
    raise exception 'PRECONDITION FAILED: 20270103000000 (PI edit revisions) is not applied';
  end if;
  -- #205's staged state is not carried forward: nothing may be waiting in it.
  if exists (select 1 from public.order_pi_versions where status = 'admin_approved') then
    raise exception 'PRECONDITION FAILED: % PI version(s) are admin_approved (staged by #205); resolve them before applying 20270104000000',
      (select count(*) from public.order_pi_versions where status = 'admin_approved');
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
  -- Who is applying it: a production hold opened inside this apply is theirs
  -- (order_advance_hold_recheck), although this door runs as the service role.
  perform set_config('boe.pi_revision_actor', p_actor_id::text, true);
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
  perform set_config('boe.pi_revision_actor', '', true);

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
-- is not READY for production: it cannot be aligned — by Operations accepting
-- a version, by the alignment door, or by any write — and an Order that WAS
-- aligned loses that alignment the moment it falls short. Ready means either
--   * enough payment is VERIFIED by Finance (money awaiting verification does
--     not count), or
--   * an administrator approved an explicit below-40% exception for the
--     Order's CURRENT value basis (approve_order_advance_exception).
-- An Order with no value on record (NULL, zero, NaN) is never ready on
-- payment: its advance cannot be measured, so it needs an exception.
--
-- AN EXCEPTION BELONGS TO ONE AMENDMENT OF ONE VERSION. orders.value_epoch
-- counts every change to the Order's value; an exception records the epoch
-- and the PI version in force when it was given, and the verified amount it
-- was given against. Any later value change (even back to an earlier figure),
-- any later version, or verified money falling below what the admin saw makes
-- it stale. The PI's own pre-conversion exception counts only while the Order
-- has never been re-valued (epoch 0), the PI still carries the figures it was
-- decided on, and the verified money is still at the share it was decided at.
--
-- THE CHECK RUNS WHENEVER READINESS CAN FALL, NOT ONLY WHEN IT IS SET.
--   * the alignment itself: orders_alignment_requires_advance refuses a move
--     to 'aligned' while not ready;
--   * the Order's value: any change to orders.total_value (amend_order, an
--     approved change request, a PI revision, any other writer) re-checks;
--   * the verified money: an allocation reversed, reduced, moved or deleted,
--     or a payment leaving a verified status, re-checks every Order it touched.
-- A re-check that finds an ALIGNED Order no longer ready, in the same
-- transaction as the write that caused it: opens a HOLD (order_advance_holds:
-- what changed, the figures, who), removes the alignment through the audited
-- door (production_alignment_changed, with the hold), logs
-- order_advance_hold_opened, and tells every active administrator and the
-- operations reviewer. During a PI revision the version's handoff removes the
-- alignment itself; the hold is still recorded. The hold closes when the
-- Order is aligned again — which the gate allows only once it is ready.
-- Nothing historical is undone: the Order's status, its dispatch, earlier
-- alignments and decisions stay exactly as recorded.
--
-- CONCURRENCY. Every re-check takes the Order's row lock (FOR UPDATE) before
-- it reads alignment or money; the alignment doors take the same lock before
-- the gate reads money. So an alignment and a reversal committing at the same
-- moment are serialised on the Order row: whichever runs second sees the
-- other's committed result.

-- The Order's value basis.
alter table public.orders add column if not exists value_epoch integer not null default 0;
comment on column public.orders.value_epoch is
  'How many times this Order''s value (total_value) has changed since it was created. Maintained by orders_value_epoch only; a below-40% exception is valid for one epoch. 20270104000000.';

create or replace function public.orders_value_epoch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.value_epoch := old.value_epoch
    + case when new.total_value is distinct from old.total_value then 1 else 0 end;
  return new;
end;
$$;
revoke execute on function public.orders_value_epoch() from public, anon, authenticated, service_role;
drop trigger if exists orders_value_epoch on public.orders;
create trigger orders_value_epoch
  before update on public.orders
  for each row execute function public.orders_value_epoch();

create table if not exists public.order_advance_exceptions (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders(id) on delete cascade,
  order_value        numeric check (order_value is null or order_value >= 0),
  value_epoch        integer not null,
  pi_version_id      uuid references public.order_pi_versions(id) on delete set null,
  verified_at_grant  numeric not null,
  shortfall_at_grant numeric,
  reason             text not null check (char_length(btrim(reason)) between 10 and 1000),
  approved_by        uuid not null references public.users(id),
  approved_at        timestamptz not null default now()
);
comment on table public.order_advance_exceptions is
  'An administrator''s explicit approval to align a Confirmed Order for production below the 40% verified advance, for ONE value basis: the Order''s value epoch and the PI version in force when given, against the verified amount then. Stale once any of those moves. Written only by approve_order_advance_exception(). 20270104000000.';
alter table public.order_advance_exceptions enable row level security;
revoke all on public.order_advance_exceptions from public, anon, authenticated, service_role;
create index if not exists order_advance_exceptions_order on public.order_advance_exceptions (order_id, value_epoch);

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

-- A below-40% approval VOIDED FOR GOOD because the verified money it was given
-- against was reversed (review R6). Re-verifying the same amount later does
-- not bring it back: it needs a new administrator's decision. exception_id
-- NULL is the PI's own pre-conversion exception. One void per approval.
create table if not exists public.order_advance_exception_voids (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  exception_id uuid references public.order_advance_exceptions(id) on delete cascade,
  cause        text not null check (cause in ('payment_reduced')),
  verified     numeric not null,
  floor        numeric not null,
  detail       jsonb not null default '{}'::jsonb,
  voided_at    timestamptz not null default now()
);
comment on table public.order_advance_exception_voids is
  'A below-40% approval (an order_advance_exceptions row, or the PI''s own exception when exception_id is NULL) made void for good because verified money fell below the amount it was given against. Written only by order_advance_exceptions_void_on_reduction(). 20270104000000.';
alter table public.order_advance_exception_voids enable row level security;
revoke all on public.order_advance_exception_voids from public, anon, authenticated, service_role;
create unique index if not exists order_advance_exception_voids_one
  on public.order_advance_exception_voids (order_id, coalesce(exception_id, '00000000-0000-0000-0000-000000000000'::uuid));

create or replace function public.order_advance_exception_voids_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.in_test_data_cleanup() then return old; end if;
  raise exception 'ORDER_ADVANCE_EXCEPTION_VOID_PERMANENT: a voided approval stays void' using errcode = '42501';
end;
$$;
revoke execute on function public.order_advance_exception_voids_immutable() from public, anon, authenticated, service_role;
drop trigger if exists order_advance_exception_voids_immutable on public.order_advance_exception_voids;
create trigger order_advance_exception_voids_immutable
  before update or delete on public.order_advance_exception_voids
  for each row execute function public.order_advance_exception_voids_immutable();

-- A hold: readiness removed from an aligned Order because it fell short.
create table if not exists public.order_advance_holds (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id) on delete cascade,
  cause                text not null check (cause in ('value_changed', 'pi_revision', 'payment_changed')),
  order_value          numeric,
  previous_order_value numeric,
  value_epoch          integer not null,
  verified             numeric not null,
  percent              numeric,
  shortfall            numeric,
  detail               jsonb not null default '{}'::jsonb,
  held_by              uuid references public.users(id) on delete set null,
  held_at              timestamptz not null default now(),
  resolved_at          timestamptz,
  resolved_by          uuid references public.users(id) on delete set null,
  resolution           text check (resolution in ('realigned')),
  check ((resolved_at is null) = (resolution is null))
);
comment on table public.order_advance_holds is
  'Production readiness removed from an aligned Confirmed Order because its verified advance fell below 40% of its value (value change, PI revision, or verified money reduced). At most one open hold per Order; it closes when the Order is aligned again. Written only by order_advance_hold_recheck() and orders_advance_hold_resolve(). 20270104000000.';
alter table public.order_advance_holds enable row level security;
revoke all on public.order_advance_holds from public, anon, authenticated, service_role;
create unique index if not exists order_advance_holds_one_open on public.order_advance_holds (order_id) where resolved_at is null;

create or replace function public.order_advance_holds_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then return old; end if;
    raise exception 'ORDER_ADVANCE_HOLD_IMMUTABLE: a production hold is a record and cannot be deleted' using errcode = '42501';
  end if;
  -- The one legal change: an open hold is resolved, nothing else moves.
  if old.resolved_at is null and new.resolved_at is not null
     and (to_jsonb(new) - array['resolved_at', 'resolved_by', 'resolution'])
         = (to_jsonb(old) - array['resolved_at', 'resolved_by', 'resolution']) then
    return new;
  end if;
  raise exception 'ORDER_ADVANCE_HOLD_IMMUTABLE: a production hold is a record and cannot be changed' using errcode = '42501';
end;
$$;
revoke execute on function public.order_advance_holds_guard() from public, anon, authenticated, service_role;
drop trigger if exists order_advance_holds_guard on public.order_advance_holds;
create trigger order_advance_holds_guard
  before update or delete on public.order_advance_holds
  for each row execute function public.order_advance_holds_guard();

-- The verified money the PI's own exception stays backed by: what was verified
-- when the administrator decided it (20270102000000 stamps it), or, for a
-- decision made before that was recorded, the percentage on the PI.
create or replace function public.order_pi_exception_floor(p_decided_verified numeric, p_percent numeric, p_total numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_decided_verified, coalesce(p_percent, 0) * p_total / 100);
$$;
revoke execute on function public.order_pi_exception_floor(numeric, numeric, numeric) from public, anon, authenticated, service_role;

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
  v_known    boolean;
  v_verified numeric;
  v_awaiting numeric;
  v_required numeric;
  v_short    numeric;
  v_version  uuid;
  v_exc      public.order_advance_exceptions%rowtype;
  v_pi_exc   boolean := false;
  v_hold     public.order_advance_holds%rowtype;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then return null; end if;

  -- NULL, zero and NaN are "no value on record": nothing to measure against.
  v_known := o.total_value is not null and o.total_value <> 'NaN'::numeric and o.total_value > 0;

  select coalesce(sum(a.allocated_amount), 0) into v_verified
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and public.finance_payment_status_is_verified(f.status);
  select coalesce(sum(a.allocated_amount), 0) into v_awaiting
    from public.finance_payment_allocations a join public.finance_payment_requests f on f.id = a.payment_request_id
   where a.order_id = o.id and a.status = 'active' and f.status in ('pending_approval', 'needs_clarification');

  if v_known then
    v_required := public.order_submission_required_payment(o.total_value);
    v_short    := greatest(coalesce(public.order_submission_payment_shortfall(o.total_value, v_verified), v_required - v_verified), 0);
  end if;

  select v.id into v_version from public.order_pi_versions v
   where v.order_id = o.id and v.status = 'approved' limit 1;

  -- An administrator's exception for THIS value basis, still backed by the
  -- money it was given against.
  select * into v_exc from public.order_advance_exceptions e
   where e.order_id = o.id
     and e.value_epoch = o.value_epoch
     and e.order_value is not distinct from o.total_value
     and e.pi_version_id is not distinct from v_version
     and v_verified >= e.verified_at_grant
     and not exists (select 1 from public.order_advance_exception_voids x where x.exception_id = e.id)
   order by e.approved_at desc limit 1;

  -- The PI's own pre-conversion exception: only while the Order has never
  -- been re-valued, the PI still carries the figures it was decided on, the
  -- verified money has not fallen below what it was when the administrator
  -- DECIDED it (advance_exception_decided_verified; older decisions fall back
  -- to the recorded percentage), and no reversal has voided it.
  if o.source_order_submission_id is not null and o.value_epoch = 0 then
    select * into s from public.order_submissions where id = o.source_order_submission_id;
    v_pi_exc := coalesce(s.id is not null
      and s.grand_total is not distinct from o.total_value
      and v_verified >= public.order_pi_exception_floor(s.advance_exception_decided_verified, s.advance_exception_percent, o.total_value)
      and not exists (select 1 from public.order_advance_exception_voids x where x.order_id = o.id and x.exception_id is null)
      and public.order_submission_exception_current(
            s.advance_exception_status,
            s.advance_exception_decided_grand_total,     s.grand_total,
            s.advance_exception_decided_workbook_sha256, s.source_workbook_sha256,
            s.advance_exception_decided_payment_terms,   s.payment_terms,
            s.advance_exception_decided_billing_terms,   s.billing_terms), false);
  end if;

  select * into v_hold from public.order_advance_holds h where h.order_id = o.id and h.resolved_at is null;

  return jsonb_build_object(
    'order_value',  o.total_value,
    'value_known',  v_known,
    'value_epoch',  o.value_epoch,
    'pi_version_id', v_version,
    'verified',     v_verified,
    'awaiting',     v_awaiting,
    'required',     v_required,
    'shortfall',    v_short,
    'percent',      case when v_known then round(100 * v_verified / o.total_value, 2) end,
    'threshold_percent', public.order_submission_standard_advance_percent(),
    'below',        not v_known or v_short > 0,
    'exception',    case when v_exc.id is not null then jsonb_build_object(
                      'source', 'order', 'approved_by', v_exc.approved_by, 'approved_at', v_exc.approved_at,
                      'reason', v_exc.reason, 'order_value', v_exc.order_value)
                    when v_pi_exc then jsonb_build_object('source', 'pi', 'approved_by', s.advance_exception_decided_by,
                      'approved_at', s.advance_exception_decided_at)
                    end,
    'hold',         case when v_hold.id is not null then jsonb_build_object(
                      'id', v_hold.id, 'cause', v_hold.cause, 'held_at', v_hold.held_at,
                      'order_value', v_hold.order_value, 'previous_order_value', v_hold.previous_order_value,
                      'verified', v_hold.verified, 'percent', v_hold.percent, 'shortfall', v_hold.shortfall)
                    end,
    'ready',        (v_known and v_short = 0) or v_exc.id is not null or v_pi_exc);
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
declare
  v_pos   jsonb;
  v_rev   uuid;
  v_avail boolean;
begin
  if not coalesce(public.can_view_order_as_actor(p_order_id), false) then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  v_pos := public.order_advance_position(p_order_id);
  -- WHO MAY ALIGN A HELD ORDER AGAIN (review R1), for the screen to draw; the
  -- doors decide again under lock. The current operations reviewer when one
  -- can act; otherwise an administrator's recovery.
  if jsonb_typeof(v_pos -> 'hold') = 'object' then
    select r.user_id into v_rev from public.order_operations_reviewers r where r.duty = 'pi_handoff';
    v_avail := v_rev is not null and public.operations_reviewer_can_open_order(v_rev, p_order_id);
    v_pos := v_pos || jsonb_build_object('realign', jsonb_build_object(
      'reviewer_id', v_rev,
      'reviewer_available', v_avail,
      'by_viewer', v_avail and v_rev = auth.uid(),
      'recover_by_viewer', not v_avail and exists (
        select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'
           and u.is_active and coalesce(u.is_deleted, false) = false)));
  end if;
  return v_pos;
end;
$$;
comment on function public.order_advance_readiness(uuid) is
  'Where a Confirmed Order stands against the 40% verified advance, measured on its current (amended) value: {order_value, value_known, verified, awaiting, required, shortfall, percent, below, exception, hold, ready}, and while a hold is open, realign: who may align it again (the current operations reviewer, or an administrator''s recovery when none can act). For anybody who may open the Order. 20270104000000.';
revoke execute on function public.order_advance_readiness(uuid) from public, anon;
grant  execute on function public.order_advance_readiness(uuid) to authenticated;

-- An administrator's explicit below-40% exception, for the Order's value basis now.
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
    raise exception 'ORDER_ADVANCE_EXCEPTION_ALREADY_APPROVED: Order % already has a below-40%% approval for its current value and PI version',
      o.display_number using errcode = 'P0001';
  end if;

  insert into public.order_advance_exceptions
    (order_id, order_value, value_epoch, pi_version_id, verified_at_grant, shortfall_at_grant, reason, approved_by)
  values (o.id, o.total_value, o.value_epoch, nullif(v_pos ->> 'pi_version_id', '')::uuid,
          (v_pos ->> 'verified')::numeric, (v_pos ->> 'shortfall')::numeric, v_reason, v_actor)
  returning id into v_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (o.id, v_actor, 'order_advance_exception_approved',
          jsonb_build_object('exception_id', v_id, 'order_value', o.total_value, 'value_epoch', o.value_epoch,
                             'pi_version_id', v_pos -> 'pi_version_id',
                             'verified', v_pos -> 'verified', 'percent', v_pos -> 'percent',
                             'shortfall', v_pos -> 'shortfall', 'reason', v_reason));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  if v_rev is not null and v_rev <> v_actor
     and exists (select 1 from public.users u where u.id = v_rev and u.is_active and coalesce(u.is_deleted, false) = false) then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (v_rev, null, o.id, 'order_operations_review_requested'::notification_type,
            format('Order %s: %s approved production below the 40%% advance.', o.display_number, coalesce(v_name, 'An administrator')),
            v_reason, true);
  end if;

  return jsonb_build_object('exception_id', v_id, 'order_id', o.id) || public.order_advance_position(o.id);
end;
$$;
comment on function public.approve_order_advance_exception(uuid, text) is
  'An active administrator approves aligning a Confirmed Order for production below the 40% verified advance, for its current value basis (value epoch + PI version in force + verified amount), with a reason (10–1000 characters). Refused when not needed or already approved for this basis. Logged on the Order; the operations reviewer is told. 20270104000000.';
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
  if (v_pos ->> 'ready')::boolean then
    return new;
  end if;
  if not (v_pos ->> 'value_known')::boolean then
    raise exception
      'ORDER_ADVANCE_VALUE_UNKNOWN: Order % has no value on record, so its 40%% advance cannot be measured. An administrator''s below-40%% approval is needed before production can be aligned.',
      new.display_number
      using errcode = 'P0001';
  end if;
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
end;
$$;
revoke execute on function public.orders_alignment_requires_advance() from public, anon, authenticated, service_role;
drop trigger if exists orders_alignment_requires_advance on public.orders;
create trigger orders_alignment_requires_advance
  before update of production_alignment on public.orders
  for each row execute function public.orders_alignment_requires_advance();

-- 'raised', 'lowered' or 'changed' (either figure unknown, or equal).
create or replace function public.order_value_change_word(p_before numeric, p_after numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_before is null or p_after is null or p_before = 'NaN'::numeric or p_after = 'NaN'::numeric then 'changed'
    when p_after > p_before then 'raised'
    when p_after < p_before then 'lowered'
    else 'changed' end;
$$;
revoke execute on function public.order_value_change_word(numeric, numeric) from public, anon, authenticated, service_role;

-- THE RE-CHECK. Internal; called by the triggers below in the transaction of
-- the write that may have made the Order fall short.
create or replace function public.order_advance_hold_recheck(p_order_id uuid, p_cause text, p_detail jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o         public.orders%rowtype;
  v_pos     jsonb;
  -- Who caused it. A PI revision is applied by the service role on an
  -- administrator's behalf: that administrator is the author (review R5).
  v_actor   uuid := coalesce(auth.uid(), nullif(current_setting('boe.pi_revision_actor', true), '')::uuid);
  v_hold    uuid;
  v_in_rev  boolean := nullif(current_setting('boe.pi_revision_apply', true), '') is not null;
  v_dir     text;
  v_what    text;
  v_title   text;
  v_body    text;
begin
  if p_order_id is null or public.in_test_data_cleanup() then
    return false;
  end if;

  -- The Order's row lock first: an alignment in flight either committed
  -- before this (and is seen below) or waits and then sees this write.
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.production_alignment is distinct from 'aligned'
     or o.status in ('cancelled', 'dispatched') then
    return false;
  end if;

  -- Already held: a PI revision re-values the Order more than once inside its
  -- apply (parse, restore, amendment) before its handoff removes the alignment.
  if exists (select 1 from public.order_advance_holds h where h.order_id = o.id and h.resolved_at is null) then
    return false;
  end if;

  v_pos := public.order_advance_position(o.id);
  if (v_pos ->> 'ready')::boolean then
    return false;
  end if;

  if v_actor is not null and not exists (select 1 from public.users u where u.id = v_actor) then
    v_actor := null;
  end if;

  insert into public.order_advance_holds
    (order_id, cause, order_value, previous_order_value, value_epoch, verified, percent, shortfall, detail, held_by)
  values (o.id, p_cause, o.total_value, nullif(p_detail ->> 'previous_order_value', '')::numeric, o.value_epoch,
          (v_pos ->> 'verified')::numeric, nullif(v_pos ->> 'percent', '')::numeric,
          nullif(v_pos ->> 'shortfall', '')::numeric, coalesce(p_detail, '{}'::jsonb), v_actor)
  returning id into v_hold;

  -- The direction is said only when both figures are known (review R2): a
  -- LOWER value can leave an Order short too, when an approval it relied on
  -- was for the old value.
  v_dir := public.order_value_change_word(nullif(p_detail ->> 'previous_order_value', '')::numeric, o.total_value);
  v_what := case p_cause
    when 'value_changed' then case when v_dir = 'changed' then 'its value changed' else 'its value was ' || v_dir end
    when 'pi_revision'   then 'a revised PI ' || v_dir || ' its value'
    else 'verified payment against it was reduced' end;

  -- A revision's own handoff removes the alignment in this transaction.
  if not v_in_rev then
    perform public.order_operations_handoff_set_alignment(
      o.id, v_actor, false,
      format('Production readiness removed: the verified advance fell below 40%% after %s.', v_what),
      jsonb_build_object('reason', 'advance_hold', 'hold_id', v_hold, 'cause', p_cause));
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (o.id, v_actor, 'order_advance_hold_opened',
          jsonb_build_object('hold_id', v_hold, 'cause', p_cause,
                             'order_value', o.total_value, 'value_known', v_pos -> 'value_known',
                             'verified', v_pos -> 'verified', 'percent', v_pos -> 'percent',
                             'shortfall', v_pos -> 'shortfall') || coalesce(p_detail, '{}'::jsonb));

  v_title := format('Order %s: production readiness removed — advance below 40%%.', o.display_number);
  v_body  := case when (v_pos ->> 'value_known')::boolean then
               format('After %s, ₹%s is verified — %s%% of ₹%s. ₹%s more verified payment, or an administrator''s below-40%% approval, is needed before Operations can align production again.',
                      v_what,
                      to_char((v_pos ->> 'verified')::numeric, 'FM99999999999990.00'),
                      v_pos ->> 'percent',
                      to_char(o.total_value, 'FM99999999999990.00'),
                      to_char((v_pos ->> 'shortfall')::numeric, 'FM99999999999990.00'))
             else format('After %s, the Order has no value on record, so its advance cannot be measured. An administrator''s below-40%% approval is needed before Operations can align production again.', v_what)
             end;
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select r.user_id, null, o.id, 'order_update_production'::notification_type, v_title, v_body, true
    from (select u.id as user_id from public.users u
           where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false
          union
          -- The operations reviewer only while they can act on it (review R8):
          -- an inactive or deleted reviewer is not told; the administrators are.
          select r.user_id from public.order_operations_reviewers r
            join public.users u on u.id = r.user_id
           where r.duty = 'pi_handoff' and u.is_active and coalesce(u.is_deleted, false) = false) r
   where r.user_id is distinct from v_actor;

  return true;
end;
$$;
comment on function public.order_advance_hold_recheck(uuid, text, jsonb) is
  'Internal: under the Order''s row lock, if an ALIGNED open Order is no longer ready on the 40% advance, open a hold, remove the alignment (unless a PI revision''s handoff is doing so), log it and tell the administrators and the operations reviewer. Not callable by any client role. 20270104000000.';
revoke execute on function public.order_advance_hold_recheck(uuid, text, jsonb) from public, anon, authenticated, service_role;

-- VERIFIED MONEY REVERSED: a below-40% approval it no longer covers is void
-- for good (review R6). Internal; called by the two payment triggers below,
-- BEFORE the hold re-check, under the same Order row lock. Only the approval
-- that is current for the Order's value basis can be voided — one given for an
-- earlier epoch or PI version is already stale for good.
create or replace function public.order_advance_exceptions_void_on_reduction(p_order_id uuid, p_detail jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o         public.orders%rowtype;
  s         public.order_submissions%rowtype;
  v_pos     jsonb;
  v_version uuid;
  v_verified numeric;
  v_floor   numeric;
  v_actor   uuid := auth.uid();
  v_count   integer := 0;
  e         record;
begin
  if p_order_id is null or public.in_test_data_cleanup() then
    return 0;
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then return 0; end if;
  if v_actor is not null and not exists (select 1 from public.users u where u.id = v_actor) then
    v_actor := null;
  end if;

  v_pos := public.order_advance_position(o.id);
  v_verified := (v_pos ->> 'verified')::numeric;
  v_version := nullif(v_pos ->> 'pi_version_id', '')::uuid;

  for e in
    select x.* from public.order_advance_exceptions x
     where x.order_id = o.id
       and x.value_epoch = o.value_epoch
       and x.order_value is not distinct from o.total_value
       and x.pi_version_id is not distinct from v_version
       and v_verified < x.verified_at_grant
       and not exists (select 1 from public.order_advance_exception_voids v where v.exception_id = x.id)
  loop
    insert into public.order_advance_exception_voids (order_id, exception_id, cause, verified, floor, detail)
    values (o.id, e.id, 'payment_reduced', v_verified, e.verified_at_grant, coalesce(p_detail, '{}'::jsonb));
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (o.id, v_actor, 'order_advance_exception_voided',
            jsonb_build_object('source', 'order', 'exception_id', e.id, 'verified', v_verified,
                               'verified_at_grant', e.verified_at_grant) || coalesce(p_detail, '{}'::jsonb));
    v_count := v_count + 1;
  end loop;

  -- The PI's own exception, while it is still the one covering this Order.
  if o.source_order_submission_id is not null and o.value_epoch = 0
     and not exists (select 1 from public.order_advance_exception_voids v where v.order_id = o.id and v.exception_id is null) then
    select * into s from public.order_submissions where id = o.source_order_submission_id;
    v_floor := public.order_pi_exception_floor(s.advance_exception_decided_verified, s.advance_exception_percent, o.total_value);
    if s.id is not null and s.advance_exception_status = 'approved' and v_verified < v_floor then
      insert into public.order_advance_exception_voids (order_id, exception_id, cause, verified, floor, detail)
      values (o.id, null, 'payment_reduced', v_verified, v_floor, coalesce(p_detail, '{}'::jsonb));
      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (o.id, v_actor, 'order_advance_exception_voided',
              jsonb_build_object('source', 'pi', 'verified', v_verified, 'verified_at_grant', v_floor)
              || coalesce(p_detail, '{}'::jsonb));
      v_count := v_count + 1;
    end if;
  end if;
  return v_count;
end;
$$;
comment on function public.order_advance_exceptions_void_on_reduction(uuid, jsonb) is
  'Internal: under the Order''s row lock, voids for good every below-40% approval current for the Order''s value basis (and the PI''s own exception) that verified money has fallen below; logs order_advance_exception_voided. Not callable by any client role. 20270104000000 (review R6).';
revoke execute on function public.order_advance_exceptions_void_on_reduction(uuid, jsonb) from public, anon, authenticated, service_role;

-- The Order's value changed (any path).
create or replace function public.orders_advance_recheck_on_value_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.total_value is not distinct from old.total_value then
    return null;
  end if;
  perform public.order_advance_hold_recheck(
    new.id,
    case when nullif(current_setting('boe.pi_revision_apply', true), '') is not null then 'pi_revision' else 'value_changed' end,
    jsonb_build_object('previous_order_value', old.total_value, 'order_value', new.total_value,
                       'previous_value_epoch', old.value_epoch, 'value_epoch', new.value_epoch));
  return null;
end;
$$;
revoke execute on function public.orders_advance_recheck_on_value_change() from public, anon, authenticated, service_role;
drop trigger if exists orders_advance_recheck_on_value_change on public.orders;
create trigger orders_advance_recheck_on_value_change
  after update of total_value on public.orders
  for each row execute function public.orders_advance_recheck_on_value_change();

-- Aligned again: the open hold is resolved.
create or replace function public.orders_advance_hold_resolve()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.production_alignment = 'aligned' and old.production_alignment is distinct from 'aligned' then
    update public.order_advance_holds
       set resolved_at = now(), resolved_by = new.production_aligned_by, resolution = 'realigned'
     where order_id = new.id and resolved_at is null;
  end if;
  return null;
end;
$$;
revoke execute on function public.orders_advance_hold_resolve() from public, anon, authenticated, service_role;
drop trigger if exists orders_advance_hold_resolve on public.orders;
create trigger orders_advance_hold_resolve
  after update of production_alignment on public.orders
  for each row execute function public.orders_advance_hold_resolve();

-- Verified money reduced: an allocation reversed, reduced, moved or deleted.
create or replace function public.finance_payment_allocations_advance_recheck()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_detail jsonb;
begin
  if public.in_test_data_cleanup() or old.status is distinct from 'active' or old.order_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.status = 'active'
     and new.order_id is not distinct from old.order_id
     and new.payment_request_id is not distinct from old.payment_request_id
     and new.allocated_amount >= old.allocated_amount then
    return null;   -- nothing that could lower this Order's verified advance
  end if;
  v_detail := jsonb_build_object('allocation_id', old.id, 'payment_request_id', old.payment_request_id,
                                 'change', case when tg_op = 'DELETE' then 'deleted'
                                                when new.status <> 'active' then new.status
                                                when new.order_id is distinct from old.order_id then 'moved'
                                                else 'reduced' end);
  perform public.order_advance_exceptions_void_on_reduction(old.order_id, v_detail);
  perform public.order_advance_hold_recheck(old.order_id, 'payment_changed', v_detail);
  return null;
end;
$$;
revoke execute on function public.finance_payment_allocations_advance_recheck() from public, anon, authenticated, service_role;
drop trigger if exists finance_payment_allocations_advance_recheck on public.finance_payment_allocations;
create trigger finance_payment_allocations_advance_recheck
  after update or delete on public.finance_payment_allocations
  for each row execute function public.finance_payment_allocations_advance_recheck();

-- A payment leaves a verified status: every Order it is actively allocated to.
create or replace function public.finance_payment_requests_advance_recheck()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
begin
  if public.in_test_data_cleanup()
     or not public.finance_payment_status_is_verified(old.status)
     or public.finance_payment_status_is_verified(new.status) then
    return null;
  end if;
  for v_order in
    select distinct a.order_id from public.finance_payment_allocations a
     where a.payment_request_id = new.id and a.status = 'active' and a.order_id is not null
     order by a.order_id
  loop
    perform public.order_advance_exceptions_void_on_reduction(v_order,
      jsonb_build_object('payment_request_id', new.id, 'change', 'payment_status',
                         'from_status', old.status, 'to_status', new.status));
    perform public.order_advance_hold_recheck(v_order, 'payment_changed',
      jsonb_build_object('payment_request_id', new.id, 'change', 'payment_status',
                         'from_status', old.status, 'to_status', new.status));
  end loop;
  return null;
end;
$$;
revoke execute on function public.finance_payment_requests_advance_recheck() from public, anon, authenticated, service_role;
drop trigger if exists finance_payment_requests_advance_recheck on public.finance_payment_requests;
create trigger finance_payment_requests_advance_recheck
  after update of status on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_advance_recheck();

-- The reviewer's decision, re-emitted IN FULL from 20261229000000 §8 with one
-- change: after a production hold removed the alignment of an ACCEPTED
-- version, "accept" aligns the Order again against that same acceptance
-- (operations_handoff_realigned) instead of refusing ALREADY_ACCEPTED — the
-- only way back for Operations once the Order is ready again.
create or replace function public.decide_order_operations_handoff(
  p_handoff_id uuid,
  p_decision   text,
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_order_id uuid;
  v_order    public.orders%rowtype;
  v_h        public.order_operations_handoffs%rowtype;
  v_version  public.order_pi_versions%rowtype;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now      timestamptz := now();
  v_name     text;
  v_event    text;
  v_withdraw boolean := false;
  v_realign  boolean := false;
  v_current  uuid;
begin
  if p_decision is null or p_decision not in ('accepted', 'clarification_needed') then
    raise exception 'ORDER_OPERATIONS_HANDOFF_DECISION_UNKNOWN: the decision must be accepted or clarification_needed'
      using errcode = 'P0001';
  end if;
  if p_decision = 'clarification_needed' and v_reason is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED: say what needs clarifying before this version can be accepted'
      using errcode = 'P0001';
  end if;
  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception 'ORDER_OPERATIONS_HANDOFF_REASON_TOO_LONG: the reason may be at most 1000 characters (this one is %)',
      char_length(v_reason) using errcode = 'P0001';
  end if;

  -- LOCK ORDER: the reviewer row (SHARE), then the Order, then the handoff —
  -- the order a revision approval takes. The reviewer row comes first because
  -- set_order_operations_reviewer() holds it FOR UPDATE while it locks this
  -- handoff and then needs FOR KEY SHARE on this Order (its history row's
  -- foreign key): holding the Order and then waiting on the handoff would
  -- close that cycle. SHARE does not serialize decisions with each other or
  -- with approvals; the Order lock does that.
  select order_id into v_order_id from public.order_operations_handoffs where id = p_handoff_id;
  if v_order_id is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FOUND: that handoff no longer exists' using errcode = 'P0002';
  end if;
  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into v_h from public.order_operations_handoffs where id = p_handoff_id for update;
  if not found then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FOUND: that handoff no longer exists' using errcode = 'P0002';
  end if;

  -- RE-ALIGNING a held Order (review R1): an ACCEPTED version whose Order lost
  -- its alignment to a production hold. The acceptance names whoever accepted
  -- it and stays that way; the person who may align it again is whoever is the
  -- operations reviewer NOW — a reassignment after the acceptance moves this
  -- duty, never the alignment itself.
  v_realign := v_h.status = 'accepted' and p_decision = 'accepted'
               and v_order.production_alignment is distinct from 'aligned';

  -- ── Authority: the assigned reviewer (for a re-alignment, the CURRENT
  --    reviewer), active, able to open this Order, and nobody in their place ──
  if v_realign then
    select r.user_id into v_current from public.order_operations_reviewers r where r.duty = 'pi_handoff';
    if v_current is null then
      raise exception 'ORDER_REALIGN_NO_REVIEWER: no operations reviewer is assigned. An administrator can assign one in Control Center, or recover the alignment with a reason.'
        using errcode = 'P0001';
    end if;
    if v_current <> v_actor then
      raise exception 'ORDER_REALIGN_NOT_CURRENT_REVIEWER: only the current operations reviewer can align production again'
        using errcode = '42501';
    end if;
    if not public.operations_reviewer_can_open_order(v_actor, v_h.order_id) then
      raise exception 'You do not have access to this Order' using errcode = '42501';
    end if;
    if not exists (select 1 from public.order_advance_holds h where h.order_id = v_h.order_id and h.resolved_at is null) then
      raise exception 'ORDER_REALIGN_NOT_HELD: Order % is not on a production hold', v_order.display_number
        using errcode = 'P0001';
    end if;
  else
    if v_h.assigned_to is null then
      raise exception 'ORDER_OPERATIONS_HANDOFF_UNASSIGNED: no operations reviewer is assigned; an administrator must assign one in Control Center'
        using errcode = 'P0001';
    end if;
    if v_h.assigned_to <> v_actor then
      raise exception 'Only the assigned operations reviewer can decide this handoff'
        using errcode = '42501';
    end if;
    if not public.can_view_order_as_actor(v_h.order_id) then
      raise exception 'You do not have access to this Order' using errcode = '42501';
    end if;
  end if;

  -- ── State: live, about the version in force, on an open Order ──
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_CLOSED: Order % is cancelled', v_order.display_number
      using errcode = 'P0001';
  end if;
  if v_h.superseded_at is not null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: PI V% has been replaced by a later approved version; review the current one',
      v_h.version_number using errcode = 'P0001';
  end if;
  select * into v_version from public.order_pi_versions where id = v_h.pi_version_id;
  if not found or v_version.status <> 'approved'
     or exists (select 1 from public.order_pi_versions v
                 where v.order_id = v_h.order_id and v.status = 'approved' and v.id <> v_h.pi_version_id) then
    raise exception 'ORDER_OPERATIONS_HANDOFF_STALE: PI V% is no longer the approved version of Order %',
      v_h.version_number, v_order.display_number using errcode = 'P0001';
  end if;
  -- 20270104000000: an accepted version whose Order lost its alignment to a
  -- production hold (order_advance_holds) may be accepted again — the gate
  -- decides whether it can be aligned now.
  if v_h.status = 'accepted' and p_decision = 'accepted' and v_order.production_alignment = 'aligned' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED: PI V% was already accepted for production', v_h.version_number
      using errcode = 'P0001';
  end if;
  if v_h.status = 'clarification_needed' and p_decision = 'clarification_needed' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_FLAGGED: PI V% is already flagged for clarification', v_h.version_number
      using errcode = 'P0001';
  end if;

  -- ── The decision ──
  if p_decision = 'accepted' and v_h.status = 'accepted' then
    -- RE-ALIGNING AFTER A HOLD (20270104000000). The acceptance on the row is
    -- what happened and stays exactly as it was; the Order is aligned against
    -- it again, as a new event naming who aligned it and when, next to the
    -- acceptance it stands on. The gate refuses it while the Order is short.
    v_event := 'operations_handoff_realigned';
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor, v_event,
            jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                               'version_number', v_h.version_number, 'note', v_reason,
                               'realigned_by', v_actor, 'realigned_at', v_now,
                               'accepted_by', v_h.accepted_by, 'accepted_at', v_h.accepted_at,
                               'hold_id', (select h.id from public.order_advance_holds h
                                            where h.order_id = v_h.order_id and h.resolved_at is null)));
    perform public.order_operations_handoff_set_alignment(
      v_h.order_id, v_actor, true, v_reason,
      jsonb_build_object('reason', 'operations_handoff_realigned', 'handoff_id', v_h.id,
                         'version_id', v_h.pi_version_id, 'version_number', v_h.version_number));
  elsif p_decision = 'accepted' then
    -- From awaiting, or from clarification_needed once the question is
    -- settled (including after a withdrawal: the new acceptance replaces the
    -- withdrawn one, and both are on the history as events).
    update public.order_operations_handoffs
       set status = 'accepted',
           accepted_by = v_actor, accepted_at = v_now, accepted_note = v_reason,
           acceptance_withdrawn_by = null, acceptance_withdrawn_at = null, acceptance_withdrawn_reason = null
     where id = v_h.id;
    v_event := 'operations_handoff_accepted';
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor, v_event,
            jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                               'version_number', v_h.version_number, 'note', v_reason,
                               'after_clarification', v_h.status = 'clarification_needed',
                               'after_withdrawal', v_h.acceptance_withdrawn_at is not null));
    -- ACCEPTING ALIGNS. The Order is in production against THIS version, by
    -- this reviewer, from now.
    perform public.order_operations_handoff_set_alignment(
      v_h.order_id, v_actor, true, v_reason,
      jsonb_build_object('reason', 'operations_handoff_accepted', 'handoff_id', v_h.id,
                         'version_id', v_h.pi_version_id, 'version_number', v_h.version_number));
  else
    v_withdraw := v_h.status = 'accepted';
    if v_withdraw then
      -- WITHDRAWING an acceptance: the acceptance stays on the row as what
      -- happened; the withdrawal says who took it back and why.
      update public.order_operations_handoffs
         set status = 'clarification_needed',
             acceptance_withdrawn_by = v_actor, acceptance_withdrawn_at = v_now, acceptance_withdrawn_reason = v_reason,
             clarification_by = v_actor, clarification_at = v_now, clarification_reason = v_reason
       where id = v_h.id;
      v_event := 'operations_handoff_acceptance_withdrawn';
    else
      update public.order_operations_handoffs
         set status = 'clarification_needed', clarification_by = v_actor,
             clarification_at = v_now, clarification_reason = v_reason
       where id = v_h.id;
      v_event := 'operations_handoff_clarification_needed';
    end if;
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (v_h.order_id, v_actor, v_event,
            jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                               'version_number', v_h.version_number, 'reason', v_reason,
                               'previously_accepted_at', case when v_withdraw then v_h.accepted_at end));
    -- A FLAGGED OR WITHDRAWN VERSION IS NOT ONE THE ORDER IS ALIGNED AGAINST.
    perform public.order_operations_handoff_set_alignment(
      v_h.order_id, v_actor, false, v_reason,
      jsonb_build_object('reason', v_event, 'handoff_id', v_h.id,
                         'version_id', v_h.pi_version_id, 'version_number', v_h.version_number));
  end if;

  -- The approver hears the outcome, unless they decided it themselves.
  if v_h.approved_by is not null and v_h.approved_by is distinct from v_actor then
    select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (
      v_h.approved_by, null, v_h.order_id, 'order_operations_review_decided'::notification_type,
      case
        when v_event = 'operations_handoff_realigned' then
          format('Order %s: %s aligned production again against PI V%s.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
        when p_decision = 'accepted' then
          format('Order %s: %s accepted PI V%s for production.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
        when v_withdraw then
          format('Order %s: %s withdrew the acceptance of PI V%s. Clarification needed.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
        else
          format('Order %s: %s cannot accept PI V%s. Clarification needed.', v_order.display_number, coalesce(v_name, 'The operations reviewer'), v_h.version_number)
      end,
      v_reason,
      true
    );
  end if;

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_id', v_h.pi_version_id,
    'version_number', v_h.version_number, 'status', p_decision,
    'production_alignment', case when p_decision = 'accepted' then 'aligned' else 'not_aligned' end,
    'withdrawn', v_withdraw);
end;
$$;

comment on function public.decide_order_operations_handoff(uuid, text, text) is
  'The assigned operations reviewer accepts a PI version for production — which ALIGNS the Order — or flags it as needing clarification (reason required, at most 1000 characters), which takes the alignment back; on an accepted version, a flag is a withdrawal that keeps the acceptance on record. Re-checks under row locks: caller is the assigned, active reviewer who can open the Order; the handoff is live and about the Order''s current approved version; the Order is not cancelled. Writes the decision, the Order history events, and one notification to the approver. Acceptance means operations has reviewed and can work from this version, not that manufacturing work is done. 20270104000000: an accepted version whose Order lost its alignment to a production hold can be accepted again (operations_handoff_realigned), the acceptance on record unchanged; the 40% gate decides.';

revoke execute on function public.decide_order_operations_handoff(uuid, text, text) from public, anon;
grant  execute on function public.decide_order_operations_handoff(uuid, text, text) to authenticated;

-- ADMINISTRATOR RECOVERY (review R1). A held Order whose accepted version can
-- be aligned again only by the operations reviewer would be stuck if there is
-- no reviewer who can act: none assigned, or the one assigned is inactive,
-- deleted or cannot open the Order. Then — and only then — an active
-- administrator may align it again, with a reason, against the same accepted
-- version. The acceptance stays as recorded; the recovery is its own event
-- naming the administrator, the time, the reason and why no reviewer could.
-- The 40% gate decides exactly as for Operations. Refused whenever a reviewer
-- who can act exists: being an admin is not being operations.
create or replace function public.recover_order_production_alignment(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := public.assert_order_submission_actor();
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now     timestamptz := now();
  v_order   public.orders%rowtype;
  v_h       public.order_operations_handoffs%rowtype;
  v_rev     uuid;
  v_why     text;
  v_hold    uuid;
  v_name    text;
begin
  if not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin'
                  and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'Only an administrator can recover a production alignment' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 10 then
    raise exception 'ORDER_REALIGN_RECOVERY_REASON_REQUIRED: say why production is being aligned again without an operations reviewer (at least 10 characters)'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'ORDER_REALIGN_RECOVERY_REASON_TOO_LONG: the reason may be at most 1000 characters' using errcode = 'P0001';
  end if;

  -- Lock order as decide_order_operations_handoff: reviewer row, Order, handoff.
  select r.user_id into v_rev from public.order_operations_reviewers r where r.duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  select * into v_h from public.order_operations_handoffs h
   where h.order_id = p_order_id and h.superseded_at is null
   for update;
  if not found then
    raise exception 'ORDER_REALIGN_NOT_HELD: Order % has no operations handoff to align against', v_order.display_number
      using errcode = 'P0001';
  end if;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_CLOSED: Order % is cancelled', v_order.display_number using errcode = 'P0001';
  end if;
  if v_h.status <> 'accepted'
     or not exists (select 1 from public.order_pi_versions v where v.id = v_h.pi_version_id and v.status = 'approved')
     or exists (select 1 from public.order_pi_versions v
                 where v.order_id = v_h.order_id and v.status = 'approved' and v.id <> v_h.pi_version_id) then
    raise exception 'ORDER_REALIGN_NOT_ACCEPTED: the PI version in force on Order % is not accepted by operations; it needs their review, not a recovery',
      v_order.display_number using errcode = 'P0001';
  end if;
  select h.id into v_hold from public.order_advance_holds h where h.order_id = v_order.id and h.resolved_at is null;
  if v_order.production_alignment = 'aligned' or v_hold is null then
    raise exception 'ORDER_REALIGN_NOT_HELD: Order % is not on a production hold', v_order.display_number
      using errcode = 'P0001';
  end if;

  -- Only when no reviewer can act.
  if v_rev is not null and public.operations_reviewer_can_open_order(v_rev, v_order.id) then
    select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_rev;
    raise exception 'ORDER_REALIGN_REVIEWER_AVAILABLE: % is the operations reviewer and can align production again; an administrator recovers only when no reviewer can',
      coalesce(v_name, 'An active reviewer') using errcode = 'P0001';
  end if;
  v_why := case when v_rev is null then 'no_reviewer'
                when not exists (select 1 from public.users u where u.id = v_rev and u.is_active and coalesce(u.is_deleted, false) = false)
                  then 'reviewer_inactive'
                else 'reviewer_cannot_open_order' end;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, v_actor, 'operations_handoff_realigned_by_admin',
          jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                             'version_number', v_h.version_number, 'reason', v_reason,
                             'realigned_by', v_actor, 'realigned_at', v_now,
                             'accepted_by', v_h.accepted_by, 'accepted_at', v_h.accepted_at,
                             'reviewer_id', v_rev, 'reviewer_unavailable', v_why, 'hold_id', v_hold));
  -- The gate (orders_alignment_requires_advance) refuses this while the Order is short.
  perform public.order_operations_handoff_set_alignment(
    v_order.id, v_actor, true, v_reason,
    jsonb_build_object('reason', 'operations_handoff_realigned_by_admin', 'handoff_id', v_h.id,
                       'version_id', v_h.pi_version_id, 'version_number', v_h.version_number,
                       'reviewer_unavailable', v_why));

  return jsonb_build_object('order_id', v_order.id, 'handoff_id', v_h.id, 'version_number', v_h.version_number,
                            'production_alignment', 'aligned', 'recovered_by', v_actor, 'reviewer_unavailable', v_why);
end;
$$;
comment on function public.recover_order_production_alignment(uuid, text) is
  'Administrator recovery for a held Order (review R1): when no operations reviewer can act (none assigned, inactive or deleted, or unable to open the Order), an active administrator aligns the Order again against its accepted PI version, with a reason (10–1000 characters). The acceptance stays as recorded; logs operations_handoff_realigned_by_admin. The 40% gate applies. Refused while a reviewer who can act exists. 20270104000000.';
revoke execute on function public.recover_order_production_alignment(uuid, text) from public, anon;
grant  execute on function public.recover_order_production_alignment(uuid, text) to authenticated;


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
  -- The 40% advance is re-checked wherever readiness can fall.
  if (select count(*) from pg_trigger t
       where not t.tgisinternal and (t.tgrelid, t.tgname) in (
         ('public.orders'::regclass, 'orders_alignment_requires_advance'),
         ('public.orders'::regclass, 'orders_advance_recheck_on_value_change'),
         ('public.orders'::regclass, 'orders_advance_hold_resolve'),
         ('public.orders'::regclass, 'orders_value_epoch'),
         ('public.finance_payment_allocations'::regclass, 'finance_payment_allocations_advance_recheck'),
         ('public.finance_payment_requests'::regclass, 'finance_payment_requests_advance_recheck'))) <> 6 then
    raise exception 'ASSERT: every 40%% advance trigger is installed';
  end if;
  if has_function_privilege('authenticated', 'public.order_advance_hold_recheck(uuid, text, jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.order_advance_hold_recheck(uuid, text, jsonb)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.order_advance_holds', 'SELECT')
     or has_table_privilege('service_role', 'public.order_advance_holds', 'INSERT')
     or has_table_privilege('service_role', 'public.order_advance_exceptions', 'INSERT') then
    raise exception 'ASSERT: holds and exceptions are written only by their definer functions';
  end if;
  -- Review fixes R1 and R6.
  if has_table_privilege('authenticated', 'public.order_advance_exception_voids', 'SELECT')
     or has_table_privilege('service_role', 'public.order_advance_exception_voids', 'INSERT')
     or has_function_privilege('authenticated', 'public.order_advance_exceptions_void_on_reduction(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.order_advance_exceptions_void_on_reduction(uuid, jsonb)', 'EXECUTE') then
    raise exception 'ASSERT: exception voids are written only by their definer function';
  end if;
  if position('order_advance_exceptions_void_on_reduction(' in
       (select prosrc from pg_proc where oid = 'public.finance_payment_allocations_advance_recheck()'::regprocedure)) = 0
     or position('order_advance_exceptions_void_on_reduction(' in
       (select prosrc from pg_proc where oid = 'public.finance_payment_requests_advance_recheck()'::regprocedure)) = 0 then
    raise exception 'ASSERT: every reduction of verified money voids the approvals it no longer covers';
  end if;
  if not has_function_privilege('authenticated', 'public.recover_order_production_alignment(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.recover_order_production_alignment(uuid, text)', 'EXECUTE') then
    raise exception 'ASSERT: the administrator recovery door is for signed-in users only';
  end if;
end $$;

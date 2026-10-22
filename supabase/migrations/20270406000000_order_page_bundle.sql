-- ═══════════════════════════════════════════════════════════════════════════
-- THE CONFIRMED ORDER PAGE'S WHOLE READ AS ONE DATABASE CALL.
--
-- WHY. Opening an Order waits for four reads in a row (the order, then fourteen
-- things about its PI, payments and history, then the people and the photo links,
-- then the whole-payment totals), each about a quarter of a second on the live
-- site, and requests sent together finish in clusters rather than all at once.
-- This function returns everything the page reads once it knows the Order's id as
-- ONE jsonb answer, so the page needs one read here and then only the signed
-- photo links (storage cannot be called from the database).
--
-- ACCESS: SECURITY INVOKER AND NOTHING ELSE. The function runs as the signed-in
-- person, so every table's own row-level security decides, row by row, what it
-- decides for the page's separate reads today. It reads nothing as an owner,
-- grants nothing, writes nothing, and is not callable by anon. An Order the
-- reader cannot see answers { "found": false }, exactly as the separate read
-- finds no row.
--
-- FAILURE. Every part is { "ok": true, "data": ... } or { "ok": false, "code": SQLSTATE }.
-- One part failing (a table the reader may not read, a function not on this
-- database) never takes the others down, which is how the page's separate reads
-- behave today (a refused commission reads as "Restricted", not as a broken page).
--
-- SHAPES. Each part is shaped like the PostgREST answer the page already maps:
-- the page's own column lists (src/lib/orders/orderPageBundle.ts keeps them in
-- step and a test pins it), the same ordering, embedded people as
-- { "full_name": ... } objects or null.
--
-- PROVEN BEFORE IT WAS WRITTEN DOWN. Run inside BEGIN..ROLLBACK against the live
-- database for all eight Orders as an administrator, an operations user and a
-- salesperson: 0 failed checks (row counts per table against each reader's own
-- reads, column sets against the page's lists, visibility, every part working),
-- about 100 ms inside the database, about 24 KB an Order.
--
-- The page falls back to its separate reads when this function is absent, so the
-- release order is migration first, then code, but neither breaks the other.
-- Read-only; no table, column, policy or grant changes beyond this function.
-- Rollback: drop function public.order_page_bundle(uuid);
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.order_page_bundle(p_order_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order      jsonb;
  v_sub_id     uuid;
  v_sub        jsonb;
  v_items      jsonb;
  v_images     jsonb;
  v_codes      jsonb;
  v_versions   jsonb;
  v_trail      jsonb;
  v_handoffs   jsonb;
  v_comm       jsonb;
  v_comm_ok    jsonb;
  v_pay        jsonb;
  v_alloc      jsonb;
  v_totals     jsonb;
  v_activity   jsonb;
  v_appr       jsonb;
  v_chg        jsonb;
  v_people     jsonb;
  v_adv        jsonb;
  v_tbg        jsonb;
  v_pay_ids    uuid[];
  v_people_ids uuid[];
begin
  -- THE ORDER ITSELF decides whether there is anything to return: RLS shows the reader this row or it does not.
  select jsonb_build_object(
           'id', o.id, 'display_number', o.display_number, 'client_name', o.client_name,
           'requested_by', o.requested_by, 'assigned_to', o.assigned_to, 'created_by', o.created_by,
           'confirm_date', o.confirm_date, 'due_date', o.due_date,
           'total_value', o.total_value, 'total_product_value', o.total_product_value,
           'lead_source', o.lead_source, 'status', o.status, 'notes', o.notes,
           'created_at', o.created_at, 'updated_at', o.updated_at,
           'source_order_request_id', o.source_order_request_id, 'source_request_number', o.source_request_number,
           'is_test_data', o.is_test_data, 'source_order_submission_id', o.source_order_submission_id,
           'billing_percentage', o.billing_percentage, 'sample_type', o.sample_type, 'sample_type_set_at', o.sample_type_set_at,
           'production_alignment', o.production_alignment, 'production_aligned_by', o.production_aligned_by,
           'production_aligned_at', o.production_aligned_at, 'production_alignment_note', o.production_alignment_note,
           'requested_by_user', (select jsonb_build_object('full_name', u.full_name) from public.users u where u.id = o.requested_by),
           'assigned_to_user', (select jsonb_build_object('full_name', u.full_name) from public.users u where u.id = o.assigned_to),
           'created_by_user', (select jsonb_build_object('full_name', u.full_name) from public.users u where u.id = o.created_by),
           'production_aligned_by_user', (select jsonb_build_object('full_name', u.full_name) from public.users u where u.id = o.production_aligned_by)
         ),
         o.source_order_submission_id
    into v_order, v_sub_id
    from public.orders o
   where o.id = p_order_id;

  if v_order is null then
    return jsonb_build_object('found', false);
  end if;

  -- The advance base is a computed column that may not exist on an older database: read alone, fail alone.
  begin
    select to_jsonb(public.order_total_before_gst(o)) into v_tbg from public.orders o where o.id = p_order_id;
  exception when others then
    v_tbg := null;
  end;
  v_order := v_order || jsonb_build_object('total_before_gst', v_tbg);

  begin
    v_adv := jsonb_build_object('ok', true, 'data', to_jsonb(public.order_advance_readiness(p_order_id)));
  exception when others then
    v_adv := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  -- ── The source PI. An order with no source submission has none of these. ──
  if v_sub_id is not null then
    begin
      select jsonb_build_object('ok', true, 'data', to_jsonb(t)) into v_sub
        from (select id, client_name, bill_to_name, ship_to_name, creation_date, source_created_by, contact_number,
                     bill_to_phone, ship_to_phone, billing_address, shipping_address, client_city, bill_to_gst, ship_to_gst,
                     order_confirmation_date, dispatch_commitment, due_date, gross_product_amount, discount_amount,
                     subtotal_after_discount, fabric_cost, fabric_cost_meaning, fabric_cost_text, packing_cost,
                     packing_cost_meaning, packing_cost_text, transportation_amount, transportation_text, total_before_gst,
                     gst_amount, grand_total, commercial_terms_note, fabric_responsibility, billing_percentage, billing_terms,
                     payment_terms, sample_type, advance_exception_reason_code, source_workbook_name, source_workbook_path
                from public.order_submissions where id = v_sub_id) t;
      if v_sub is null then v_sub := jsonb_build_object('ok', true, 'data', null); end if;
    exception when others then
      v_sub := jsonb_build_object('ok', false, 'code', sqlstate);
    end;

    begin
      select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order asc), '[]'::jsonb)) into v_items
        from (select id, source_row, item_sequence, source_product_code, product_name, quantity, dimensions, material,
                     customization, cost_per_piece, total_amount, sort_order
                from public.order_submission_items where submission_id = v_sub_id) t;
    exception when others then
      v_items := jsonb_build_object('ok', false, 'code', sqlstate);
    end;

    begin
      select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.position asc), '[]'::jsonb)) into v_images
        from (select item_id, role, position, storage_path
                from public.order_submission_item_images where submission_id = v_sub_id) t;
    exception when others then
      v_images := jsonb_build_object('ok', false, 'code', sqlstate);
    end;

    begin
      select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)) into v_trail
        from (select id, action, actor_id, note, created_at, metadata
                from public.order_submission_activity where submission_id = v_sub_id) t;
    exception when others then
      v_trail := jsonb_build_object('ok', false, 'code', sqlstate);
    end;

    begin
      select jsonb_build_object('ok', true, 'data', to_jsonb(t)) into v_comm
        from (select middleman_commission, middleman_recipient, middleman_commission_basis, middleman_commission_amount,
                     middleman_commission_percent, middleman_commission_percent_of
                from public.order_submission_middleman_commissions where submission_id = v_sub_id) t;
      if v_comm is null then v_comm := jsonb_build_object('ok', true, 'data', null); end if;
    exception when others then
      v_comm := jsonb_build_object('ok', false, 'code', sqlstate);
    end;

    begin
      v_comm_ok := jsonb_build_object('ok', true, 'data', to_jsonb(public.can_read_order_submission_commission(v_sub_id)));
    exception when others then
      v_comm_ok := jsonb_build_object('ok', false, 'code', sqlstate);
    end;
  else
    v_sub := jsonb_build_object('ok', true, 'data', null);
    v_items := jsonb_build_object('ok', true, 'data', '[]'::jsonb);
    v_images := jsonb_build_object('ok', true, 'data', '[]'::jsonb);
    v_trail := jsonb_build_object('ok', true, 'data', '[]'::jsonb);
    v_comm := jsonb_build_object('ok', true, 'data', null);
    v_comm_ok := jsonb_build_object('ok', true, 'data', false);
  end if;

  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)) into v_codes
      from (select submission_item_id, boe_sequence, source_product_code, source_item_sequence
              from public.order_product_codes where order_id = p_order_id) t;
  exception when others then
    v_codes := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.version_number desc), '[]'::jsonb)) into v_versions
      from (select id, order_id, submission_id, version_number, status, workbook_path, workbook_name, uploaded_by, uploaded_at,
                   revision_reason, decided_by, decided_at, decision_reason, superseded_at, operations_reviewer,
                   operations_decided_by, operations_decided_at, operations_reason, source_kind
              from public.order_pi_versions where order_id = p_order_id) t;
  exception when others then
    v_versions := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.version_number desc), '[]'::jsonb)) into v_handoffs
      from (select id, order_id, pi_version_id, submission_id, version_number, approved_by, approved_at, assigned_to, assigned_at,
                   unassigned_reason, production_alignment_at_approval, prior_handoff_status, status, accepted_by, accepted_at,
                   accepted_note, acceptance_withdrawn_by, acceptance_withdrawn_at, acceptance_withdrawn_reason, clarification_by,
                   clarification_at, clarification_reason, superseded_at, superseded_by_version_id, created_at
              from public.order_operations_handoffs where order_id = p_order_id) t;
  exception when others then
    v_handoffs := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  -- ── Money ──
  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.payment_date desc), '[]'::jsonb)) into v_pay
      from (select id, client_name, amount, payment_date, payment_mode, order_number, status
              from public.finance_payment_requests where order_id = p_order_id) t;
  exception when others then
    v_pay := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)) into v_alloc
      from (select a.id, a.allocated_amount, a.status,
                   (select jsonb_build_object('id', p.id, 'client_name', p.client_name, 'amount', p.amount,
                                              'payment_date', p.payment_date, 'payment_mode', p.payment_mode,
                                              'order_number', p.order_number, 'status', p.status)
                      from public.finance_payment_requests p where p.id = a.payment_request_id) as payment
              from public.finance_payment_allocations a
             where a.order_id = p_order_id and a.status = 'active') t;
  exception when others then
    v_alloc := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  -- The whole-payment fact (payment_active_allocation_totals), for every payment this page can show: the
  -- order's own linked payments and the payments its allocations came from.
  begin
    v_pay_ids := array(
      select x from (
        select p.id as x from public.finance_payment_requests p where p.order_id = p_order_id
        union
        select a.payment_request_id from public.finance_payment_allocations a
          join public.finance_payment_requests p on p.id = a.payment_request_id
         where a.order_id = p_order_id and a.status = 'active'
      ) s where x is not null);
    if coalesce(array_length(v_pay_ids, 1), 0) = 0 then
      v_totals := jsonb_build_object('ok', true, 'data', '[]'::jsonb);
    else
      select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(jsonb_build_object(
                'payment_request_id', t.payment_request_id, 'active_total', t.active_total)), '[]'::jsonb)) into v_totals
        from public.payment_active_allocation_totals(v_pay_ids) t;
    end if;
  exception when others then
    v_totals := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  -- ── The order's own trail ──
  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)) into v_activity
      from (select l.id, l.event_type, l.payload, l.created_at,
                   (select jsonb_build_object('full_name', u.full_name) from public.users u where u.id = l.actor_id) as actor
              from public.order_activity_log l where l.order_id = p_order_id) t;
  exception when others then
    v_activity := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)) into v_appr
      from (select e.id, e.order_id, e.approval_kind, e.status, e.evidence_path, e.actor_id, e.created_at,
                   (select jsonb_build_object('full_name', u.full_name) from public.users u where u.id = e.actor_id) as actor
              from public.order_approval_events e where e.order_id = p_order_id) t;
  exception when others then
    v_appr := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  begin
    select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)) into v_chg
      from (select c.id, c.order_id, c.order_number_snapshot, c.request_type, c.requested_by, c.reason,
                   c.proposed_client_name, c.proposed_total_value, c.proposed_total_product_value,
                   c.proposed_confirm_date, c.proposed_due_date, c.proposed_lead_source, c.proposed_notes,
                   c.baseline_client_name, c.baseline_total_value, c.baseline_total_product_value,
                   c.baseline_confirm_date, c.baseline_due_date, c.baseline_lead_source, c.baseline_notes,
                   c.status, c.reviewed_by, c.reviewed_at, c.review_note, c.created_at,
                   (select jsonb_build_object('full_name', u.full_name) from public.users u where u.id = c.requested_by) as requester
              from public.order_change_requests c where c.order_id = p_order_id) t;
  exception when others then
    v_chg := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  -- ── Names: everybody the PI versions, the PI trail and the handoffs mention (what the page's "names" read asks) ──
  begin
    v_people_ids := array(
      select distinct x from (
        select unnest(array[v.uploaded_by, v.decided_by, v.operations_reviewer, v.operations_decided_by]) as x
          from public.order_pi_versions v where v.order_id = p_order_id
        union all
        select a.actor_id from public.order_submission_activity a where v_sub_id is not null and a.submission_id = v_sub_id
        union all
        select unnest(array[h.approved_by, h.assigned_to, h.accepted_by, h.clarification_by])
          from public.order_operations_handoffs h where h.order_id = p_order_id
      ) s where x is not null);
    if coalesce(array_length(v_people_ids, 1), 0) = 0 then
      v_people := jsonb_build_object('ok', true, 'data', '[]'::jsonb);
    else
      select jsonb_build_object('ok', true, 'data', coalesce(jsonb_agg(jsonb_build_object(
               'id', u.id, 'full_name', u.full_name, 'is_active', u.is_active)), '[]'::jsonb)) into v_people
        from public.users u where u.id = any (v_people_ids);
    end if;
  exception when others then
    v_people := jsonb_build_object('ok', false, 'code', sqlstate);
  end;

  return jsonb_build_object(
    'found', true,
    'order', v_order,
    'advance', v_adv,
    'submission', v_sub,
    'items', v_items,
    'images', v_images,
    'codes', v_codes,
    'versions', v_versions,
    'trail', v_trail,
    'handoffs', v_handoffs,
    'commission', v_comm,
    'commission_readable', v_comm_ok,
    'payments', v_pay,
    'allocations', v_alloc,
    'active_totals', v_totals,
    'activity', v_activity,
    'approvals', v_appr,
    'change_requests', v_chg,
    'people', v_people
  );
end;
$$;

comment on function public.order_page_bundle(uuid) is
  'Everything the Confirmed Order page reads once it knows the order id, as one jsonb answer. SECURITY INVOKER: every table''s own row-level security decides what the caller gets. Each part is { ok, data } or { ok: false, code }; an order the caller cannot see is { found: false }. 20270406000000.';

revoke execute on function public.order_page_bundle(uuid) from public, anon;
grant  execute on function public.order_page_bundle(uuid) to authenticated;


-- ═══ Proof (executed on apply) ═══════════════════════════════════════════════

do $$
declare
  v_def boolean;
begin
  select p.prosecdef into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'order_page_bundle';
  if v_def is distinct from false then
    raise exception 'order_page_bundle proof: it must be SECURITY INVOKER, so every table''s row-level security applies';
  end if;
  if has_function_privilege('anon', 'public.order_page_bundle(uuid)', 'EXECUTE') then
    raise exception 'order_page_bundle proof: anon must not call it';
  end if;
  if not has_function_privilege('authenticated', 'public.order_page_bundle(uuid)', 'EXECUTE') then
    raise exception 'order_page_bundle proof: signed-in users must be able to call it';
  end if;
  -- An id nobody can see answers found:false (a caller without a session sees no Order at all).
  if (public.order_page_bundle(gen_random_uuid()) ->> 'found')::boolean is distinct from false then
    raise exception 'order_page_bundle proof: an unknown Order must answer found:false';
  end if;
end;
$$;

-- Orders — fix the staleness gate's array append.
--
-- Found by RUNNING supabase/tests/order_amendment_assertions.sql against the
-- migrated database, not by reading it. Section H failed with:
--
--   22P02: malformed array literal: "total order value"
--
-- 20260818000000 §3 builds the list of stale fields with:
--
--   v_stale := v_stale || 'total order value';
--
-- `v_stale` is text[]. Postgres offers both `anyarray || anyelement` and
-- `anyarray || anyarray`, and against an untyped string literal it resolves to
-- the ARRAY form — so it tries to parse 'total order value' as an array
-- literal and raises 22P02 instead of appending.
--
-- Consequence in the deployed function: the staleness check never produced its
-- intended ORDER_CHANGE_REQUEST_STALE refusal. It failed *safe* — the exception
-- still aborted the approval, so no stale amendment was ever applied and the
-- clobbering hole stayed shut — but the admin got an opaque Postgres cast error
-- instead of a sentence explaining that the order had moved, and
-- amendmentErrorMessage() could not map it, so the UI fell through to its
-- generic "Refresh and try again".
--
-- array_append() is unambiguous and cannot re-acquire this bug. The rest of the
-- function is byte-identical to 20260818000000 §3, so the two can be diffed.
--
-- Scope: one function. No table, no policy, no privilege, no row.

create or replace function public.approve_order_change_request(
  p_request_id  uuid,
  p_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := public.assert_order_amender();
  v_req    public.order_change_requests;
  v_order  public.orders%rowtype;
  v_stale  text[] := '{}';
  v_result jsonb;
begin
  -- FOR UPDATE: two admins clicking Approve at once serialize here, and the
  -- second finds the row already reviewed rather than applying it twice.
  select * into v_req
    from public.order_change_requests
   where id = p_request_id
   for update;

  if not found then
    raise exception 'ORDER_CHANGE_REQUEST_MISSING: This request no longer exists'
      using errcode = '42501';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'ORDER_CHANGE_REQUEST_REVIEWED: This request has already been reviewed'
      using errcode = '42501';
  end if;

  if v_req.request_type = 'cancel' then
    -- A cancellation proposes no field values, so it has no baseline to be
    -- stale against. The status checks inside cancel_order_with_audit are the
    -- whole of its concurrency story.
    v_result := public.cancel_order_with_audit(
      v_req.order_id, v_uid, v_req.reason, 'change_request', v_req.id
    );
  else
    -- Lock the Order in the SAME order apply_order_amendment takes it, so the
    -- staleness read cannot be overtaken between this check and the write, and
    -- the two functions can never deadlock against each other.
    select * into v_order from public.orders where id = v_req.order_id for update;

    if not found then
      raise exception 'ORDER_NOT_FOUND: That Order no longer exists'
        using errcode = 'P0002';
    end if;

    -- Compare only the fields this request actually proposes. A NULL baseline
    -- against a NULL current value is not a change, which `is distinct from`
    -- gets right and `<>` would not.
    if v_req.proposed_client_name is not null
       and v_order.client_name is distinct from v_req.baseline_client_name then
      v_stale := array_append(v_stale, 'client name');
    end if;
    if v_req.proposed_total_value is not null
       and v_order.total_value is distinct from v_req.baseline_total_value then
      v_stale := array_append(v_stale, 'total order value');
    end if;
    if v_req.proposed_total_product_value is not null
       and v_order.total_product_value is distinct from v_req.baseline_total_product_value then
      v_stale := array_append(v_stale, 'total product value');
    end if;
    if v_req.proposed_confirm_date is not null
       and v_order.confirm_date is distinct from v_req.baseline_confirm_date then
      v_stale := array_append(v_stale, 'confirm date');
    end if;
    if v_req.proposed_due_date is not null
       and v_order.due_date is distinct from v_req.baseline_due_date then
      v_stale := array_append(v_stale, 'due date');
    end if;
    if v_req.proposed_lead_source is not null
       and v_order.lead_source is distinct from v_req.baseline_lead_source then
      v_stale := array_append(v_stale, 'lead source');
    end if;
    if v_req.proposed_notes is not null
       and v_order.notes is distinct from v_req.baseline_notes then
      v_stale := array_append(v_stale, 'notes');
    end if;

    if array_length(v_stale, 1) > 0 then
      raise exception
        'ORDER_CHANGE_REQUEST_STALE: Order % changed after this request was raised (%). Review the current values before approving.',
        v_order.display_number, array_to_string(v_stale, ', ')
        using errcode = '40001';
    end if;

    v_result := public.apply_order_amendment(
      v_req.order_id, v_uid, v_req.reason, 'change_request', v_req.id,
      v_req.proposed_client_name,
      v_req.proposed_total_value,
      v_req.proposed_total_product_value,
      v_req.proposed_confirm_date,
      v_req.proposed_due_date,
      v_req.proposed_lead_source,
      v_req.proposed_notes
    );
  end if;

  -- Reached only when the change above succeeded. Every refusal — a closed
  -- order, a no-op, a negative value, a stale baseline — has already raised and
  -- rolled the whole transaction back, so no request is ever marked approved
  -- without its effect.
  update public.order_change_requests
     set status      = 'approved',
         reviewed_by = v_uid,
         reviewed_at = now(),
         review_note = p_review_note
   where id = p_request_id;

  return v_result || jsonb_build_object('request_id', p_request_id, 'decision', 'approved');
end;
$$;

revoke execute on function public.approve_order_change_request(uuid, text) from public, anon;
grant  execute on function public.approve_order_change_request(uuid, text) to authenticated;

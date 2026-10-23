-- PI line numbers stay contiguous when the lines are reordered.
--
-- reorder_order_submission_items() (20261002000000) moved sort_order only, so
-- reordering a draft left line numbers out of sequence (BE0003 above BE0001).
-- A PI that is not yet an Order is numbered BE0001..n in the order shown (the
-- rule Edit PI already follows); this restates the function to renumber in the
-- same transaction. A PI that already has an Order is left as it was: its
-- numbers are permanent. Nothing else about the function changes.
--
-- Safe to apply before or after the code that ships with it.

create or replace function public.reorder_order_submission_items(
  p_submission_id    uuid,
  p_item_ids         uuid[],
  p_expected_version integer default null,
  p_reason           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_sub       public.order_submissions%rowtype;
  v_is_admin  boolean;
  v_is_owner  boolean;
  v_after_sub boolean;
  v_reason    text;
  v_count     integer;
  v_version   integer;
  v_changed   boolean := false;
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);
  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception 'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;
  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception 'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- THE LIST MUST BE THE WHOLE SET, EXACTLY ONCE EACH. A partial list would
  -- leave the unnamed lines with collided sort orders; a repeated id would too.
  -- Refusing is the only honest answer to either.
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception 'ORDER_SUBMISSION_BAD_ORDER: the new order must list every product line'
      using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.order_submission_items
   where submission_id = p_submission_id;

  if v_count <> array_length(p_item_ids, 1)
     or v_count <> (select count(distinct x) from unnest(p_item_ids) x)
     or exists (
       select 1 from unnest(p_item_ids) x
        where not exists (select 1 from public.order_submission_items i
                           where i.id = x and i.submission_id = p_submission_id)
     ) then
    raise exception
      'ORDER_SUBMISSION_BAD_ORDER: the new order must list every product line of this PI exactly once'
      using errcode = 'P0001';
  end if;

  -- Did anything actually move? An unchanged order writes nothing.
  select exists (
    select 1 from unnest(p_item_ids) with ordinality as t(id, pos)
    join public.order_submission_items i on i.id = t.id
    where i.sort_order is distinct from (t.pos - 1)::integer
  ) into v_changed;

  if not v_changed then
    return jsonb_build_object('submission_id', p_submission_id, 'changed', false,
                              'row_version', v_sub.row_version, 'superseded_documents', 0);
  end if;

  -- TWO PASSES, because sort_order is UNIQUE per submission and a single pass
  -- would collide the moment two lines swap. The offset is large enough that no
  -- intermediate value can equal a real one.
  update public.order_submission_items
     set sort_order = sort_order + 1000000
   where submission_id = p_submission_id;

  update public.order_submission_items i
     set sort_order = (t.pos - 1)::integer
    from unnest(p_item_ids) with ordinality as t(id, pos)
   where i.id = t.id;

  -- A PI that is not yet an Order carries its line numbers as BE0001..n in the
  -- order shown: reordering renumbers, so the codes never run out of sequence.
  -- Two passes for the same reason as sort_order: (submission_id, item_sequence)
  -- is unique. Once an Order exists its numbers are permanent and are left alone.
  if v_sub.order_id is null then
    update public.order_submission_items
       set item_sequence = null
     where submission_id = p_submission_id;

    update public.order_submission_items i
       set item_sequence = 'BE' || lpad(t.pos::text, 4, '0')
      from unnest(p_item_ids) with ordinality as t(id, pos)
     where i.id = t.id;
  end if;

  update public.order_submissions
     set row_version = row_version + 1, updated_at = now()
   where id = p_submission_id
  returning row_version into v_version;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor,
    case when v_after_sub and not v_is_owner
         then 'product_details_amended_by_admin' else 'product_details_updated' end,
    v_sub.status, v_sub.status, v_reason,
    jsonb_build_object('reordered', true, 'lines', v_count,
                       'stage', v_sub.status, 'after_submission', v_after_sub,
                       'renumbered', v_sub.order_id is null)
  );

  return jsonb_build_object('submission_id', p_submission_id, 'changed', true,
                            'row_version', v_version, 'superseded_documents', 0);
end;
$$;

comment on function public.reorder_order_submission_items(uuid, uuid[], integer, text) is
  'Reorders a PI''s product lines. sort_order is authoritative (unique per submission). The list must name every line of this PI exactly once. A PI that is not yet an Order is also renumbered BE0001..n in the new order. Moves no money.';

revoke all    on function public.reorder_order_submission_items(uuid, uuid[], integer, text) from public, anon;
grant  execute on function public.reorder_order_submission_items(uuid, uuid[], integer, text) to authenticated;

do $$
begin
  if pg_get_functiondef('public.reorder_order_submission_items(uuid, uuid[], integer, text)'::regprocedure) not like '%BE%lpad%' then
    raise exception 'reorder_order_submission_items does not renumber';
  end if;
end;
$$;

-- ═══ RESPOND TO OPERATIONS' OBJECTION AND RESUBMIT, WITH REMARKS ONLY ════════
--
-- Operations flags the PI version in force ("cannot accept — clarification
-- needed", with a reason). Until now the only way out was a revised PI (a new
-- version) or Operations changing its own mind. Often nothing in the PI needs to
-- change: the answer is a sentence. This adds that door.
--
-- WHO: whoever may revise this PI — the person who owns it, or an active
-- administrator (can_propose_order_pi_edit(), the rule Edit PI already uses).
-- WHAT: the flagged handoff goes back to 'awaiting' with the remark attached and
-- the operations reviewer is told. No new PI version, no change to the PI, the
-- Order or its alignment (a flagged version is already not aligned).
-- HISTORY: the objection (clarification_by / _at / _reason) is KEPT on the row;
-- the response sits beside it; an Order history event records both. If Operations
-- flags the version again, the new objection overwrites the old one through the
-- ordinary decision RPC and the old response, now older than the objection, is
-- no longer shown as the answer to it.
--
-- Forward-only, additive: three nullable columns, one constraint, one function.
-- Rollback: drop function public.respond_order_handoff_clarification(uuid, text);
--           alter table public.order_operations_handoffs
--             drop constraint order_operations_handoffs_response_complete,
--             drop column clarification_response, drop column clarification_responded_by,
--             drop column clarification_responded_at;
-- (a handoff already answered then needs its status set back by hand.)

alter table public.order_operations_handoffs
  add column if not exists clarification_response     text,
  add column if not exists clarification_responded_by uuid references public.users(id) on delete set null,
  add column if not exists clarification_responded_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_operations_handoffs_response_complete') then
    alter table public.order_operations_handoffs
      add constraint order_operations_handoffs_response_complete
      check (
        (clarification_response is null and clarification_responded_at is null)
        or (clarification_response is not null and clarification_responded_at is not null
            and char_length(clarification_response) between 1 and 1000)
      );
  end if;
end $$;

create or replace function public.respond_order_handoff_clarification(
  p_handoff_id uuid,
  p_remark     text
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
  v_remark   text := nullif(btrim(coalesce(p_remark, '')), '');
  v_now      timestamptz := now();
  v_name     text;
begin
  if v_remark is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_RESPONSE_REQUIRED: write your remarks for Operations before resubmitting'
      using errcode = 'P0001';
  end if;
  if char_length(v_remark) > 1000 then
    raise exception 'ORDER_OPERATIONS_HANDOFF_RESPONSE_TOO_LONG: the remarks may be at most 1000 characters (these are %)',
      char_length(v_remark) using errcode = 'P0001';
  end if;

  -- Same lock order as decide_order_operations_handoff(): reviewer row (SHARE),
  -- then the Order, then the handoff.
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

  -- AUTHORITY: the PI's owner or an active administrator, as for Edit PI.
  if not public.can_propose_order_pi_edit(v_h.order_id) then
    raise exception 'Only the person who owns this PI, or an administrator, can respond to Operations'
      using errcode = '42501';
  end if;

  -- STATE: live, flagged, about the version in force, on an open Order.
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_CLOSED: Order % is cancelled', v_order.display_number
      using errcode = 'P0001';
  end if;
  if v_h.superseded_at is not null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: PI V% has been replaced by a later approved version', v_h.version_number
      using errcode = 'P0001';
  end if;
  if v_h.status <> 'clarification_needed' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FLAGGED: PI V% is not waiting for a response', v_h.version_number
      using errcode = 'P0001';
  end if;
  select * into v_version from public.order_pi_versions where id = v_h.pi_version_id;
  if not found or v_version.status <> 'approved'
     or exists (select 1 from public.order_pi_versions v
                 where v.order_id = v_h.order_id and v.status = 'approved' and v.id <> v_h.pi_version_id) then
    raise exception 'ORDER_OPERATIONS_HANDOFF_STALE: PI V% is no longer the approved version of Order %',
      v_h.version_number, v_order.display_number using errcode = 'P0001';
  end if;

  update public.order_operations_handoffs
     set status = 'awaiting',
         clarification_response = v_remark,
         clarification_responded_by = v_actor,
         clarification_responded_at = v_now
   where id = v_h.id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_h.order_id, v_actor, 'operations_handoff_clarification_answered',
          jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                             'version_number', v_h.version_number, 'response', v_remark,
                             'objection', v_h.clarification_reason,
                             'objection_by', v_h.clarification_by, 'objection_at', v_h.clarification_at));

  -- The operations reviewer is asked to look again.
  -- Through the one Orders helper: never the actor, never an inactive account,
  -- never the same notice twice within two minutes.
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.assigned_to], v_actor, v_h.order_id, 'order_operations_review_requested',
    format('Order %s: %s responded on PI V%s and resubmitted it. Awaiting your operations review.',
           v_order.display_number, coalesce(v_name, 'The PI owner'), v_h.version_number),
    v_remark);

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_id', v_h.pi_version_id,
    'version_number', v_h.version_number, 'status', 'awaiting');
end;
$$;

comment on function public.respond_order_handoff_clarification(uuid, text) is
  'The PI''s owner or an active administrator (can_propose_order_pi_edit) answers Operations'' clarification request with remarks only (1-1000 characters) and resubmits the SAME PI version: the flagged handoff returns to awaiting, the objection stays on the row, the remark is stored beside it, the Order history records both and the assigned reviewer is notified. Changes nothing about the PI, the Order or its alignment. Refused when the handoff is not flagged, was superseded, is no longer the approved version, or the Order is cancelled. 20270422000000.';

revoke execute on function public.respond_order_handoff_clarification(uuid, text) from public, anon;
grant  execute on function public.respond_order_handoff_clarification(uuid, text) to authenticated;

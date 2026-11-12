-- ═══ SEND A PI BACK TO THE SALESPERSON, WITH THE APPROVER'S COMMENT ═══════════
--
-- Operations flags the PI version in force ("cannot accept") or has not decided
-- it yet. The approver (or an administrator) has read it and wants the
-- salesperson to deal with it: change the PI, or explain it. Until now the only
-- doors were "Respond and resubmit" (back to OPERATIONS, remarks only) and Edit
-- PI (the approver rewriting the PI themself). Neither tells the salesperson,
-- in the approver's words, that the PI is theirs again.
--
-- WHO: an active administrator or a holder of orders.approve_order
--      (actor_has_module_permission('orders', 'approve_order'), which already
--      includes active admins), who can open the Order.
-- WHAT: ONE history entry and ONE notice carrying the comment (1-1000
--      characters) to the people who own the sale: the Order's salesperson and
--      the PI's submitter / creator (never the actor, never an inactive
--      account). The handoff, the PI, the Order and its alignment are NOT
--      touched: the salesperson revises with Edit PI, and a new version goes to
--      Operations the ordinary way.
-- WHEN: the version in force, not accepted, on an open Order.
--
-- The notice reuses the existing notification type order_operations_review_decided
-- (it opens the Order at its Operations review strip); the app words its badge
-- from the title, as it already does for pi_review_decided. No enum value is added.
--
-- Forward-only, additive: ONE function, no table or column change.
-- Rollback: drop function public.send_order_handoff_to_sales(uuid, text);

create or replace function public.send_order_handoff_to_sales(
  p_handoff_id uuid,
  p_comment    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_comment    text := nullif(btrim(coalesce(p_comment, '')), '');
  v_h          public.order_operations_handoffs%rowtype;
  v_order      public.orders%rowtype;
  v_sub_by     uuid;
  v_sub_to     uuid;
  v_recipients uuid[];
  v_name       text;
  v_notified   integer;
begin
  if v_comment is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SEND_BACK_COMMENT_REQUIRED: write your comment for the salesperson before sending'
      using errcode = 'P0001';
  end if;
  if char_length(v_comment) > 1000 then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SEND_BACK_COMMENT_TOO_LONG: the comment may be at most 1000 characters (this is %)',
      char_length(v_comment) using errcode = 'P0001';
  end if;

  select * into v_h from public.order_operations_handoffs where id = p_handoff_id for share;
  if not found then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FOUND: that handoff no longer exists' using errcode = 'P0002';
  end if;

  -- AUTHORITY: an approver or an administrator who can open this Order.
  if not public.actor_has_module_permission('orders', 'approve_order')
     or not public.can_read_order_detail(v_h.order_id) then
    raise exception 'Only an administrator or a PI approver can send a PI back to the salesperson'
      using errcode = '42501';
  end if;

  -- STATE: the live version, not accepted, on an open Order.
  select * into v_order from public.orders where id = v_h.order_id;
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_CLOSED: Order % is cancelled', v_order.display_number
      using errcode = 'P0001';
  end if;
  if v_h.superseded_at is not null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: PI V% has been replaced by a later approved version', v_h.version_number
      using errcode = 'P0001';
  end if;
  if v_h.status = 'accepted' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED: PI V% was already accepted for production', v_h.version_number
      using errcode = 'P0001';
  end if;

  -- WHO IT GOES TO: the Order's salesperson and the PI's submitter and creator.
  select s.created_by, s.submitted_by into v_sub_by, v_sub_to
    from public.order_submissions s where s.id = v_order.source_order_submission_id;
  select coalesce(array_agg(distinct u.id), '{}') into v_recipients
    from public.users u
   where u.id in (v_order.assigned_to, v_order.requested_by, v_sub_by, v_sub_to)
     and u.id <> v_actor
     and u.is_active and coalesce(u.is_deleted, false) = false;
  if coalesce(array_length(v_recipients, 1), 0) = 0 then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SEND_BACK_NO_SALESPERSON: Order % has no other active salesperson to send it to', v_order.display_number
      using errcode = 'P0001';
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_h.order_id, v_actor, 'operations_handoff_sent_to_sales',
          jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                             'version_number', v_h.version_number, 'comment', v_comment,
                             'handoff_status', v_h.status, 'recipients', to_jsonb(v_recipients)));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  -- Through the one Orders helper: never the actor, never an inactive account,
  -- never the same notice twice within two minutes.
  v_notified := public.order_notify_users(
    v_recipients, v_actor, v_h.order_id, 'order_operations_review_decided',
    format('Order %s: %s sent PI V%s back to you.', v_order.display_number, coalesce(v_name, 'The approver'), v_h.version_number),
    v_comment);

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_number', v_h.version_number,
    'recipients', to_jsonb(v_recipients), 'notified', v_notified);
end;
$$;

comment on function public.send_order_handoff_to_sales(uuid, text) is
  'An administrator or PI approver (actor_has_module_permission orders/approve_order) who can open the Order sends the live, not accepted, PI version back to the salesperson with a comment (1-1000 characters): one Order history entry and one notice (order_operations_review_decided) to the Order''s salesperson and the PI''s submitter/creator, never the actor. Changes nothing about the handoff, the PI, the Order or its alignment. Refused for an accepted or superseded version, a cancelled Order, or when nobody else is there to receive it. 20270619000000.';

revoke execute on function public.send_order_handoff_to_sales(uuid, text) from public, anon;
grant  execute on function public.send_order_handoff_to_sales(uuid, text) to authenticated;

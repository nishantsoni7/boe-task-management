-- ═══ THE PI REVIEW CHAIN: ONE HOLDER AT A TIME, EVERY HOP THROUGH THE APPROVER ═══
--
-- Owner, 2026-11-14 (Order 547): Operations flagged PI V1; the owner sent it to the
-- salesperson; the salesperson's reply went STRAIGHT back to Operations and the owner
-- heard nothing. Between Operations and Sales the owner is the go-between: every
-- hop must reach him first, and he decides whether to pass it on or send it back.
--
-- WHAT WAS WRONG (verified in the code, 2026-11-14):
--   1. respond_order_handoff_clarification() (20270422000000) put the flagged
--      handoff straight back to 'awaiting' and notified only the operations
--      reviewer. It also worked from the moment Operations flagged, so the
--      approver's "send back" (20270619000000) was optional.
--   2. order_operations_handoff_notify() (20270321000001) told the Order's
--      salesperson DIRECTLY when Operations flagged a version.
--   3. my_flagged_pis() (20270611000000) showed Operations' reason to the
--      salesperson the moment it was flagged.
--   4. Nothing recorded who holds the item, since when, or how many rounds it has
--      been through; the screens inferred it by comparing history timestamps.
--
-- THE RULE AFTER THIS FILE. A flagged version is held by exactly one of:
--   'operations'  — Operations reviews it (the normal state after approval).
--   'coordinator' — the approver: Operations flagged it, or Sales replied.
--   'sales'       — the approver sent it to the salesperson.
--   (null)        — decided: accepted for production.
-- Operations and Sales can only hand it to the approver. The approver hands it on:
--   send_order_handoff_to_sales()           -> 'sales'       (existing door)
--   forward_order_handoff_to_operations()   -> 'operations'  (new door)
-- The salesperson's reply door works only while Sales holds it, and puts it with
-- the approver. A revised PI (Edit PI) was already approved by the approver before
-- it reached Operations; that path is unchanged.
--
-- THE HOLDER IS STORED (three columns) so the doors can check it and the lists can
-- read it without parsing history. A BEFORE UPDATE trigger moves it on every
-- STATUS change (so decide_order_operations_handoff() needs no change); the two
-- doors that move it without a status change (send to Sales, Sales' reply) set it
-- themselves.
--
-- The Order's history stays the full record: every hop writes its own entry
-- (operations_handoff_clarification_needed / _sent_to_sales / _clarification_answered
-- / _returned_to_operations), and the Order page draws them as one thread.
--
-- Forward-only. Rollback:
--   drop function public.forward_order_handoff_to_operations(uuid, text);
--   re-apply the previous definitions of respond_order_handoff_clarification
--     (20270422000000), send_order_handoff_to_sales (20270619000000),
--     order_operations_handoff_notify (20270321000001) and my_flagged_pis (20270611000000);
--   drop trigger order_operations_handoffs_chain_sync on public.order_operations_handoffs;
--   drop function public.order_operations_handoffs_chain_sync(), public.order_chain_coordinators();
--   alter table public.order_operations_handoffs drop column chain_holder,
--     drop column chain_since, drop column chain_round;
--   (a handoff held by the approver then needs its status set back by hand.)

do $dep$
begin
  if to_regprocedure('public.respond_order_handoff_clarification(uuid, text)') is null then
    raise exception 'DEPENDENCY MISSING: apply 20270422000000_order_handoff_clarification_response.sql first';
  end if;
  if to_regprocedure('public.send_order_handoff_to_sales(uuid, text)') is null then
    raise exception 'DEPENDENCY MISSING: apply 20270619000000_order_handoff_send_to_sales.sql first';
  end if;
  if to_regprocedure('public.my_flagged_pis()') is null then
    raise exception 'DEPENDENCY MISSING: apply 20270611000000_my_flagged_pis.sql first';
  end if;
  if to_regprocedure('public.order_notify_users(uuid[], uuid, uuid, notification_type, text, text)') is null then
    raise exception 'DEPENDENCY MISSING: apply 20270321000001_order_submission_notifications_complete.sql first';
  end if;
  if to_regprocedure('public.user_holds_permission(uuid, text, text)') is null then
    raise exception 'DEPENDENCY MISSING: apply 20270120000000_order_submission_admin_decisions_ask_permissions.sql first';
  end if;
end $dep$;


-- ═══ 1. WHO HOLDS IT, SINCE WHEN, AFTER HOW MANY ROUNDS ═════════════════════

alter table public.order_operations_handoffs
  add column if not exists chain_holder text default 'operations',
  add column if not exists chain_since  timestamptz not null default now(),
  add column if not exists chain_round  integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'order_operations_handoffs_chain_holder_check') then
    alter table public.order_operations_handoffs
      add constraint order_operations_handoffs_chain_holder_check
      check (chain_holder is null or chain_holder in ('operations', 'coordinator', 'sales'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_operations_handoffs_chain_round_check') then
    alter table public.order_operations_handoffs
      add constraint order_operations_handoffs_chain_round_check check (chain_round >= 0);
  end if;
end $$;

comment on column public.order_operations_handoffs.chain_holder is
  'Who holds this PI version in the review chain: operations (reviewing), coordinator (the approver: Operations flagged it or Sales replied), sales (the approver sent it to the salesperson). NULL once accepted or superseded. Moved by order_operations_handoffs_chain_sync on a status change, and by send_order_handoff_to_sales / respond_order_handoff_clarification. 20270718000000.';
comment on column public.order_operations_handoffs.chain_since is
  'When chain_holder last changed.';
comment on column public.order_operations_handoffs.chain_round is
  'How many times Operations has flagged this version (a withdrawn acceptance counts): 0 = never flagged.';


-- ═══ 2. EXISTING HANDOFFS: SET THE HOLDER FROM WHAT THE HISTORY ALREADY SAYS ═
--
-- Before the trigger exists, so the backfill is not rewritten by it. Live, undecided
-- handoffs only; a superseded or accepted one is not held by anybody. The newest of
-- {created, flagged, sent to Sales, answered} decides, the rule the Order page and
-- the Operations queue already used. An answer under the OLD door put the handoff
-- back to 'awaiting', so an answered 'awaiting' handoff is with Operations (547).

update public.order_operations_handoffs h
   set chain_holder = null
 where h.superseded_at is not null or h.status = 'accepted';

with ev as (
  select h.id,
         (select max(e.created_at) from public.order_activity_log e
           where e.order_id = h.order_id and e.event_type = 'operations_handoff_sent_to_sales'
             and e.payload ->> 'handoff_id' = h.id::text) as sent_at,
         (select max(e.created_at) from public.order_activity_log e
           where e.order_id = h.order_id and e.event_type = 'operations_handoff_clarification_answered'
             and e.payload ->> 'handoff_id' = h.id::text) as answered_at,
         (select count(*) from public.order_activity_log e
           where e.order_id = h.order_id
             and e.event_type in ('operations_handoff_clarification_needed', 'operations_handoff_acceptance_withdrawn')
             and e.payload ->> 'handoff_id' = h.id::text)::int as flags
    from public.order_operations_handoffs h
   where h.superseded_at is null
)
update public.order_operations_handoffs h
   set chain_round  = ev.flags,
       chain_holder = case
         when h.status = 'accepted' then null
         when h.status = 'clarification_needed' then
           case when ev.sent_at is not null and ev.sent_at >= coalesce(h.clarification_at, '-infinity'::timestamptz)
                then 'sales' else 'coordinator' end
         else
           case when ev.sent_at is not null
                 and ev.sent_at >= greatest(h.created_at, coalesce(h.clarification_at, '-infinity'::timestamptz),
                                            coalesce(ev.answered_at, '-infinity'::timestamptz))
                then 'sales' else 'operations' end
       end,
       chain_since  = greatest(h.created_at, coalesce(h.clarification_at, '-infinity'::timestamptz),
                               coalesce(ev.sent_at, '-infinity'::timestamptz),
                               coalesce(ev.answered_at, '-infinity'::timestamptz))
  from ev
 where ev.id = h.id;


-- ═══ 3. THE STATUS-DRIVEN MOVES, IN ONE PLACE ═══════════════════════════════
--
-- A new handoff starts with Operations (the column default). When the STATUS
-- changes: flagged (or an acceptance withdrawn) -> the approver, one round more;
-- back to awaiting -> Operations; accepted -> nobody. A change of holder without
-- a status change (send to Sales, Sales' reply) is stamped with its time here too,
-- unless the writer set the time itself. Fires before the existing guard trigger
-- (alphabetical), which does not look at these columns.

create or replace function public.order_operations_handoffs_chain_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    new.chain_holder := case new.status
      when 'clarification_needed' then 'coordinator'
      when 'awaiting'             then 'operations'
      else null end;
    if new.status = 'clarification_needed' then
      new.chain_round := coalesce(old.chain_round, 0) + 1;
    end if;
    new.chain_since := now();
  elsif new.chain_holder is distinct from old.chain_holder
        and new.chain_since is not distinct from old.chain_since then
    new.chain_since := now();
  end if;
  return new;
end;
$$;
revoke execute on function public.order_operations_handoffs_chain_sync() from public, anon, authenticated;

drop trigger if exists order_operations_handoffs_chain_sync on public.order_operations_handoffs;
create trigger order_operations_handoffs_chain_sync
  before update on public.order_operations_handoffs
  for each row execute function public.order_operations_handoffs_chain_sync();


-- ═══ 4. WHO IS TOLD ═════════════════════════════════════════════════════════
--
-- The approvers: the active people who HOLD orders.approve_order (the permission
-- itself, as in actor_can_approve_order — the owner's grant is permanent). INTERNAL:
-- callable by no client role.

create or replace function public.order_chain_coordinators()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(u.id), '{}'::uuid[])
    from public.users u
   where u.is_active and coalesce(u.is_deleted, false) = false
     and public.user_holds_permission(u.id, 'orders', 'approve_order')
$$;
revoke all on function public.order_chain_coordinators() from public, anon, authenticated;
comment on function public.order_chain_coordinators() is
  'The active users who hold orders.approve_order: the go-between of the PI review chain, who is told at every hop. Internal. 20270718000000.';


-- ═══ 5. OPERATIONS FLAGS A VERSION: THE APPROVER IS TOLD, NOT THE SALESPERSON ═
--
-- Re-emitted from 20270321000001 §7 with one change: a flag goes to the approvers
-- (decide_order_operations_handoff() already tells the person who approved the
-- version, so that one is left out here to avoid a second notice). An ACCEPTANCE
-- still goes to the salesperson: it ends the loop.

create or replace function public.order_operations_handoff_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_actor uuid;
begin
  if new.status is not distinct from old.status or new.status not in ('accepted', 'clarification_needed') then
    return null;
  end if;
  select o.display_number, o.assigned_to into v_order from public.orders o where o.id = new.order_id;
  v_actor := coalesce(case when new.status = 'accepted' then new.accepted_by else new.clarification_by end, auth.uid());
  if new.status = 'accepted' then
    perform public.order_notify_users(
      array[v_order.assigned_to], v_actor, new.order_id, 'order_operations_review_decided',
      format('Order %s: Operations accepted PI V%s for production%s.',
             v_order.display_number, new.version_number, public.order_notify_actor_suffix(v_actor)),
      new.accepted_note);
  else
    perform public.order_notify_users(
      array_remove(public.order_chain_coordinators(), new.approved_by), v_actor, new.order_id, 'order_operations_review_decided',
      format('Order %s: Operations asked for clarification on PI V%s%s. Waiting for you.',
             v_order.display_number, new.version_number, public.order_notify_actor_suffix(v_actor)),
      new.clarification_reason);
  end if;
  return null;
exception when others then
  raise warning 'order_operations_handoff_notify skipped a notice for handoff %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_operations_handoff_notify() from public, anon, authenticated;


-- ═══ 6. THE SALESPERSON'S REPLY GOES TO THE APPROVER ════════════════════════
--
-- Re-emitted from 20270422000000. Changes: (a) refused unless Sales holds the
-- version, i.e. the approver has sent it to them; (b) the handoff STAYS flagged and
-- is now held by the approver (it no longer goes back to awaiting); (c) the
-- approvers are told, not the operations reviewer. Everything else is as it was:
-- authority (can_propose_order_pi_edit), the checks on the version, the history
-- entry, the stored reply.

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
    raise exception 'ORDER_OPERATIONS_HANDOFF_RESPONSE_REQUIRED: write your remarks before sending your reply'
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
    raise exception 'Only the person who owns this PI, or an administrator, can reply on it'
      using errcode = '42501';
  end if;

  -- STATE: live, flagged, about the version in force, on an open Order — and with Sales.
  if v_order.status = 'cancelled' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_CLOSED: Order % is cancelled', v_order.display_number
      using errcode = 'P0001';
  end if;
  if v_h.superseded_at is not null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: PI V% has been replaced by a later approved version', v_h.version_number
      using errcode = 'P0001';
  end if;
  if v_h.status <> 'clarification_needed' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FLAGGED: PI V% is not waiting for a reply', v_h.version_number
      using errcode = 'P0001';
  end if;
  if v_h.chain_holder is distinct from 'sales' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_WITH_SALES: PI V% is not with Sales: the approver sends it to you before you reply', v_h.version_number
      using errcode = 'P0001';
  end if;
  select * into v_version from public.order_pi_versions where id = v_h.pi_version_id;
  if not found or v_version.status <> 'approved'
     or exists (select 1 from public.order_pi_versions v
                 where v.order_id = v_h.order_id and v.status = 'approved' and v.id <> v_h.pi_version_id) then
    raise exception 'ORDER_OPERATIONS_HANDOFF_STALE: PI V% is no longer the approved version of Order %',
      v_h.version_number, v_order.display_number using errcode = 'P0001';
  end if;

  -- The reply is stored beside the objection; the version stays flagged and passes to the approver.
  update public.order_operations_handoffs
     set clarification_response = v_remark,
         clarification_responded_by = v_actor,
         clarification_responded_at = v_now,
         chain_holder = 'coordinator'
   where id = v_h.id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_h.order_id, v_actor, 'operations_handoff_clarification_answered',
          jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                             'version_number', v_h.version_number, 'response', v_remark,
                             'objection', v_h.clarification_reason,
                             'objection_by', v_h.clarification_by, 'objection_at', v_h.clarification_at,
                             'to', 'coordinator', 'round', v_h.chain_round));

  -- The APPROVERS are told. Through the one Orders helper: never the actor, never
  -- an inactive account, never the same notice twice within two minutes.
  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    public.order_chain_coordinators(), v_actor, v_h.order_id, 'order_operations_review_decided',
    format('Order %s: %s replied on PI V%s. Waiting for you.',
           v_order.display_number, coalesce(v_name, 'The PI owner'), v_h.version_number),
    v_remark);

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_id', v_h.pi_version_id,
    'version_number', v_h.version_number, 'status', 'clarification_needed', 'holder', 'coordinator');
end;
$$;

comment on function public.respond_order_handoff_clarification(uuid, text) is
  'The PI''s owner or an active administrator (can_propose_order_pi_edit) replies to the approver''s send-back with remarks only (1-1000 characters), while Sales holds the flagged version. The reply is stored beside the objection, the version stays flagged and passes to the approver (chain_holder = coordinator), the Order history records both and the approvers are notified. The approver then forwards it to Operations (forward_order_handoff_to_operations) or sends it back. Changes nothing about the PI, the Order or its alignment. Refused when the version is not flagged, not with Sales, superseded, stale, or the Order is cancelled. 20270718000000 (was: straight back to Operations, 20270422000000).';

revoke execute on function public.respond_order_handoff_clarification(uuid, text) from public, anon;
grant  execute on function public.respond_order_handoff_clarification(uuid, text) to authenticated;


-- ═══ 7. SEND TO SALES: NOW ALSO MARKS WHO HOLDS IT ══════════════════════════
--
-- Re-emitted from 20270619000000: same authority, same checks, same history entry
-- and notice; additionally the version is now held by Sales (chain_holder = sales).
-- The lock is FOR UPDATE because the function now writes the handoff.

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

  select * into v_h from public.order_operations_handoffs where id = p_handoff_id for update;
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

  update public.order_operations_handoffs set chain_holder = 'sales' where id = v_h.id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_h.order_id, v_actor, 'operations_handoff_sent_to_sales',
          jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                             'version_number', v_h.version_number, 'comment', v_comment,
                             'handoff_status', v_h.status, 'recipients', to_jsonb(v_recipients),
                             'from', v_h.chain_holder, 'round', v_h.chain_round));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  -- Through the one Orders helper: never the actor, never an inactive account,
  -- never the same notice twice within two minutes.
  v_notified := public.order_notify_users(
    v_recipients, v_actor, v_h.order_id, 'order_operations_review_decided',
    format('Order %s: %s sent PI V%s back to you.', v_order.display_number, coalesce(v_name, 'The approver'), v_h.version_number),
    v_comment);

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_number', v_h.version_number,
    'recipients', to_jsonb(v_recipients), 'notified', v_notified, 'holder', 'sales');
end;
$$;

comment on function public.send_order_handoff_to_sales(uuid, text) is
  'An administrator or PI approver (actor_has_module_permission orders/approve_order) who can open the Order sends the live, not accepted, PI version to the salesperson with a comment (1-1000 characters): one Order history entry, one notice (order_operations_review_decided) to the Order''s salesperson and the PI''s submitter/creator, never the actor, and the version is now held by Sales (chain_holder = sales), who reply to the approver. Changes nothing about the PI, the Order or its alignment. Refused for an accepted or superseded version, a cancelled Order, or when nobody else is there to receive it. 20270619000000, holder 20270718000000.';

revoke execute on function public.send_order_handoff_to_sales(uuid, text) from public, anon;
grant  execute on function public.send_order_handoff_to_sales(uuid, text) to authenticated;


-- ═══ 8. THE APPROVER FORWARDS IT TO OPERATIONS ══════════════════════════════
--
-- WHO: the same people who may send it to Sales (an approver or an administrator
-- who can open the Order). WHEN: the live version, not accepted, held by the
-- approver or by Sales (taking it back from Sales is allowed: the approver decides).
-- WHAT: the flagged version goes back to 'awaiting' (the trigger moves the holder to
-- Operations), the history records the hop and the approver's note, and the
-- operations reviewer is told. A note is required unless the approver is passing on
-- the salesperson's reply, which then travels with it.

create or replace function public.forward_order_handoff_to_operations(
  p_handoff_id uuid,
  p_note       text default null
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
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_replied  boolean;
  v_name     text;
begin
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception 'ORDER_OPERATIONS_HANDOFF_FORWARD_NOTE_TOO_LONG: the note may be at most 1000 characters (this is %)',
      char_length(v_note) using errcode = 'P0001';
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

  -- AUTHORITY: an approver or an administrator who can open this Order.
  if not public.actor_has_module_permission('orders', 'approve_order')
     or not public.can_read_order_detail(v_h.order_id) then
    raise exception 'Only an administrator or a PI approver can pass a PI on to Operations'
      using errcode = '42501';
  end if;

  -- STATE: the live version, still the approved one, not accepted, on an open Order, not already with Operations.
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
  select * into v_version from public.order_pi_versions where id = v_h.pi_version_id;
  if not found or v_version.status <> 'approved'
     or exists (select 1 from public.order_pi_versions v
                 where v.order_id = v_h.order_id and v.status = 'approved' and v.id <> v_h.pi_version_id) then
    raise exception 'ORDER_OPERATIONS_HANDOFF_STALE: PI V% is no longer the approved version of Order %',
      v_h.version_number, v_order.display_number using errcode = 'P0001';
  end if;
  if v_h.chain_holder is not distinct from 'operations' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_ALREADY_WITH_OPERATIONS: PI V% is already with Operations', v_h.version_number
      using errcode = 'P0001';
  end if;

  v_replied := v_h.status = 'clarification_needed' and v_h.chain_holder = 'coordinator'
               and v_h.clarification_responded_at is not null
               and v_h.clarification_responded_at >= v_h.clarification_at;
  if v_note is null and not v_replied then
    raise exception 'ORDER_OPERATIONS_HANDOFF_FORWARD_NOTE_REQUIRED: say why Operations should look at PI V% again', v_h.version_number
      using errcode = 'P0001';
  end if;

  if v_h.status = 'clarification_needed' then
    -- The trigger moves the holder to Operations with the status.
    update public.order_operations_handoffs set status = 'awaiting' where id = v_h.id;
  else
    update public.order_operations_handoffs set chain_holder = 'operations' where id = v_h.id;
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_h.order_id, v_actor, 'operations_handoff_returned_to_operations',
          jsonb_build_object('handoff_id', v_h.id, 'version_id', v_h.pi_version_id,
                             'version_number', v_h.version_number, 'note', v_note,
                             'from', v_h.chain_holder, 'reply_forwarded', v_replied,
                             'response', case when v_replied then v_h.clarification_response end,
                             'response_by', case when v_replied then v_h.clarification_responded_by end,
                             'round', v_h.chain_round));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[v_h.assigned_to], v_actor, v_h.order_id, 'order_operations_review_requested',
    case when v_replied
      then format('Order %s: %s passed on the reply to PI V%s. Awaiting your operations review.',
                  v_order.display_number, coalesce(v_name, 'The approver'), v_h.version_number)
      else format('Order %s: %s sent PI V%s back to you for another look.',
                  v_order.display_number, coalesce(v_name, 'The approver'), v_h.version_number) end,
    coalesce(v_note, case when v_replied then v_h.clarification_response end));

  return jsonb_build_object(
    'handoff_id', v_h.id, 'order_id', v_h.order_id, 'version_number', v_h.version_number,
    'holder', 'operations', 'reply_forwarded', v_replied);
end;
$$;

comment on function public.forward_order_handoff_to_operations(uuid, text) is
  'An administrator or PI approver (actor_has_module_permission orders/approve_order) who can open the Order passes the live, not accepted, PI version to Operations: a flagged version goes back to awaiting (the chain trigger moves the holder to Operations), one Order history entry (operations_handoff_returned_to_operations) records the hop, the note (at most 1000 characters; required unless the salesperson''s reply is being passed on, which travels with it) and the round, and the assigned operations reviewer is notified. Refused for an accepted, superseded or stale version, a cancelled Order, or a version already with Operations. Changes nothing about the PI or the Order. 20270718000000.';

revoke execute on function public.forward_order_handoff_to_operations(uuid, text) from public, anon;
grant  execute on function public.forward_order_handoff_to_operations(uuid, text) to authenticated;


-- ═══ 9. "WAITING ON ME": THE FLAGGED LIST, BY HOLDER ════════════════════════
--
-- Re-emitted from 20270611000000. Same rows (a live flag on the version in force, on
-- an open Order the caller may open) and the same oldest-first order, plus who holds
-- each one and since when. WHO SEES WHAT:
--   an approver or administrator  — every flagged PI; `mine` is true for the ones the
--                                   approver holds, the rest are theirs to watch;
--   anybody else who may answer (the PI's owner) — ONLY a PI the approver has sent to
--                                   Sales. Operations' flag reaches them through the
--                                   approver, never directly.
-- The salesperson's reply is returned with the row so the approver sees it at once.
-- Read-only; never raises for an ordinary signed-in person.

create or replace function public.my_flagged_pis()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_now   timestamptz := now();
  v_coord boolean;
begin
  if v_actor is null then
    return '[]'::jsonb;
  end if;
  -- The launcher must never break: without the Orders module there is simply nothing to show.
  if not public.module_entry_open('orders') then
    return '[]'::jsonb;
  end if;
  v_coord := public.actor_has_module_permission('orders', 'approve_order');

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'handoff_id',      h.id,
             'order_id',        h.order_id,
             'order_number',    o.display_number,
             'client_name',     o.client_name,
             'version_number',  h.version_number,
             'reason',          h.clarification_reason,
             'by_name',         u.full_name,
             'since',           h.clarification_at,
             'waiting_seconds', greatest(extract(epoch from (v_now - coalesce(h.clarification_at, v_now))), 0),
             'holder',          h.chain_holder,
             'holder_since',    h.chain_since,
             'round',           h.chain_round,
             'mine',            coalesce((not v_coord) or h.chain_holder = 'coordinator', false),
             'reply',           case when h.clarification_responded_at >= h.clarification_at then h.clarification_response end,
             'reply_by_name',   case when h.clarification_responded_at >= h.clarification_at then ru.full_name end,
             'reply_at',        case when h.clarification_responded_at >= h.clarification_at then h.clarification_responded_at end)
           order by h.clarification_at asc nulls last, h.id)
      from public.order_operations_handoffs h
      join public.orders o on o.id = h.order_id
      left join public.users u on u.id = h.clarification_by
      left join public.users ru on ru.id = h.clarification_responded_by
     where h.status = 'clarification_needed'
       and h.superseded_at is null
       and o.status <> 'cancelled'
       -- Still the approved version of the Order: otherwise the answer doors refuse it as stale.
       and exists (select 1 from public.order_pi_versions v
                    where v.id = h.pi_version_id and v.status = 'approved')
       and not exists (select 1 from public.order_pi_versions v2
                        where v2.order_id = h.order_id and v2.status = 'approved' and v2.id <> h.pi_version_id)
       and public.can_view_order(h.order_id)
       and (v_coord
            or (h.chain_holder = 'sales' and public.can_propose_order_pi_edit(h.order_id)))), '[]'::jsonb);
end;
$$;

revoke all     on function public.my_flagged_pis() from public, anon;
grant  execute on function public.my_flagged_pis() to authenticated;
comment on function public.my_flagged_pis() is
  'The PIs Operations flagged ("cannot accept") that the CALLER sees, oldest first, for the Orders dashboards and the Modules launcher: order, client, PI version, Operations'' reason, who flagged and when, who HOLDS it (holder: coordinator = the approver, sales = the approver sent it to the salesperson), since when, the round, `mine` (the caller holds it) and the salesperson''s reply when there is one. An approver or administrator sees every flagged PI on an Order they can open; anybody else who may answer sees only a PI the approver has sent to Sales. The flag must be live, about the version in force, on an Order that is not cancelled. [] without the Orders module. Read-only. 20270611000000, by holder 20270718000000.';


-- ═══ Assertions ═════════════════════════════════════════════════════════════

do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad from information_schema.columns
   where table_schema = 'public' and table_name = 'order_operations_handoffs'
     and column_name in ('chain_holder', 'chain_since', 'chain_round');
  if v_bad <> 3 then
    raise exception 'VERIFY: the three chain columns are not all on order_operations_handoffs';
  end if;
  if not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
                  where c.relnamespace = 'public'::regnamespace and c.relname = 'order_operations_handoffs'
                    and g.tgname = 'order_operations_handoffs_chain_sync' and not g.tgisinternal) then
    raise exception 'VERIFY: the chain sync trigger is missing';
  end if;
  if to_regprocedure('public.forward_order_handoff_to_operations(uuid, text)') is null then
    raise exception 'VERIFY: forward_order_handoff_to_operations() was not created';
  end if;
  if has_function_privilege('anon', 'public.forward_order_handoff_to_operations(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.respond_order_handoff_clarification(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.my_flagged_pis()', 'execute') then
    raise exception 'VERIFY: anon must not be able to call the chain doors';
  end if;
  if has_function_privilege('authenticated', 'public.order_chain_coordinators()', 'execute') then
    raise exception 'VERIFY: order_chain_coordinators() is internal';
  end if;
  if pg_get_functiondef('public.respond_order_handoff_clarification(uuid, text)'::regprocedure) !~ 'NOT_WITH_SALES' then
    raise exception 'VERIFY: the reply door does not ask who holds the version';
  end if;
  if pg_get_functiondef('public.order_operations_handoff_notify()'::regprocedure) !~ 'order_chain_coordinators' then
    raise exception 'VERIFY: Operations'' flag does not reach the approvers';
  end if;
  if pg_get_functiondef('public.my_flagged_pis()'::regprocedure) !~ 'chain_holder' then
    raise exception 'VERIFY: my_flagged_pis() does not read the holder';
  end if;
  -- A live, undecided handoff always has a holder; a decided or superseded one has none.
  select count(*) into v_bad from public.order_operations_handoffs h
   where (h.superseded_at is null and h.status <> 'accepted' and h.chain_holder is null)
      or ((h.superseded_at is not null or h.status = 'accepted') and h.chain_holder is not null);
  if v_bad <> 0 then
    raise exception 'VERIFY: % handoff(s) have a holder that does not match their state', v_bad;
  end if;
end $$;

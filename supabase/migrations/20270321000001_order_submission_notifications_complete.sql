-- ═══════════════════════════════════════════════════════════════════════════
-- 20270321000001  ORDERS NOTIFICATIONS FROM THE DATABASE — every concerned
--                 person is told of every new Orders activity
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (owner, 2026-10-19)
-- -----------------------
-- "Any concerned person should get the required notification for any kind of
-- new activity." The audit found most Confirmed-Order notices were sent by the
-- BROWSER after an action succeeded (/api/orders/[id]/notify): lost if the tab
-- closed, limited to four events, and silent for payments (a new payment
-- never carries order_id, so the Order's people were never told), for Fabric &
-- Finish, sample changes, change requests, a PI sent for review, a PI returned
-- or rejected, and a PI approved into an Order.
--
-- WHAT THIS FILE DOES — every notice below is written IN THE SAME TRANSACTION
-- as the activity it reports, so it cannot be lost:
--
--   1. order_activity_log AFTER INSERT → the Order's configured recipients
--      (order_notification_recipients: super_admin / admin / salesperson /
--      bdm, the same rule as resolveOrderUpdateRecipients) for:
--        status_changed                       order_update_status
--        order_amended + the five PI-side amendment events, sample_type_changed
--                                             order_update_amended
--        production_alignment_changed         order_update_production
--        payment_verified / _rejected / _linked / _unlinked
--                                             order_update_payment
--      and to the SALESPERSON only (approvers and the reviewer are already told
--      by the functions that write these rows):
--        order_advance_hold_opened, order_advance_exception_approved
--                                             order_update_payment
--      Payment verification already writes one activity row per allocated
--      Order (finance_payment_requests_echo_decision), so this fixes the
--      payment notice without touching Finance.
--   2. order_approval_events AFTER INSERT (Fabric & Finish)
--                                             order_update_approval → recipients
--   3. order_change_requests AFTER INSERT     order_change_requested → admins
--      ... AFTER UPDATE pending → decided     order_change_decided → requester
--   4. order_submissions AFTER UPDATE OF status
--        → submitted                          pi_review_requested → approve_order holders
--        submitted → needs_changes / rejected pi_review_decided → the PI's owner
--   5. orders AFTER INSERT from a PI          order_converted → the PI's owner
--                                             and the Order's salesperson
--   6. order_operations_handoffs AFTER UPDATE OF status → accepted /
--      clarification_needed                   order_operations_review_decided →
--                                             the Order's salesperson (the approver
--                                             is already told by the decision RPC)
--
-- RULES SHARED BY EVERY NOTICE (order_notify_users):
--   * never the person who did it (the actor), never an inactive or deleted user;
--   * one row per person, and none if the same person already got the same
--     type for the same record in the last 2 minutes — so the browser routes
--     that still fire during the switch-over cannot double a notice;
--   * A NOTICE NEVER UNDOES THE ACTION: every trigger body catches its own
--     errors, raises a WARNING and lets the activity stand.
--
-- NOT TOUCHED: no existing function, policy, grant or column. Triggers and new
-- helper functions only. Needs 20270321000000 (the enum values) applied first.

do $$
begin
  if to_regprocedure('public.users_with_module_permission(text, text)') is null then
    raise exception 'DEPENDENCY MISSING: users_with_module_permission(text, text)';
  end if;
  if to_regclass('public.order_notification_recipients') is null then
    raise exception 'DEPENDENCY MISSING: order_notification_recipients (20261202000000)';
  end if;
  if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                  where t.typname = 'notification_type' and e.enumlabel = 'order_update_approval') then
    raise exception 'DEPENDENCY MISSING: apply 20270321000000_order_submission_notification_types.sql first';
  end if;
end $$;


-- ═══ 1. Helpers ═════════════════════════════════════════════════════════════

-- One notice per person: never the actor, never an inactive or deleted user,
-- never twice for the same type and record within two minutes.
create or replace function public.order_notify_users(
  p_users  uuid[],
  p_actor  uuid,
  p_entity uuid,
  p_type   notification_type,
  p_title  text,
  p_body   text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_users is null or p_title is null then
    return 0;
  end if;
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  select distinct u.id, null::uuid, p_entity, p_type, p_title, nullif(btrim(coalesce(p_body, '')), ''), true
    from public.users u
   where u.id = any (p_users)
     and u.id is distinct from p_actor
     and u.is_active
     and coalesce(u.is_deleted, false) = false
     and not exists (
       select 1 from public.notifications n
        where n.user_id = u.id
          and n.type = p_type
          and n.entity_id is not distinct from p_entity
          and n.created_at > now() - interval '2 minutes');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.order_notify_users(uuid[], uuid, uuid, notification_type, text, text) from public, anon, authenticated;
comment on function public.order_notify_users(uuid[], uuid, uuid, notification_type, text, text) is
  'Inserts one Orders notification per person: never the actor, never an inactive/deleted user, never the same type+record to the same person within 2 minutes. Executable by no client role (triggers call it). 20270321000001.';

-- The Order's configured recipients: the same rule as
-- resolveOrderUpdateRecipients (src/lib/orders/orderUpdateNotifications.ts).
-- A missing config row falls back to the shipped default (bdm OFF).
create or replace function public.order_update_recipient_ids(p_order_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with cfg as (
    select
      coalesce((select enabled from public.order_notification_recipients where recipient_role = 'super_admin'), true)  as super_admin,
      coalesce((select enabled from public.order_notification_recipients where recipient_role = 'admin'), true)        as admin,
      coalesce((select enabled from public.order_notification_recipients where recipient_role = 'salesperson'), true)  as salesperson,
      coalesce((select enabled from public.order_notification_recipients where recipient_role = 'bdm'), false)         as bdm
  )
  select coalesce(array_agg(distinct u.id), '{}'::uuid[])
    from public.users u
    cross join cfg
    left join public.orders o on o.id = p_order_id
   where u.is_active
     and coalesce(u.is_deleted, false) = false
     and (   (cfg.super_admin and u.designation_level = 'super_admin')
          or (cfg.admin and u.role = 'admin')
          or (cfg.salesperson and o.assigned_to is not null and u.id = o.assigned_to)
          or (cfg.bdm and u.team = 'bdm'))
$$;
revoke all on function public.order_update_recipient_ids(uuid) from public, anon, authenticated;

create or replace function public.order_notify_status_word(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p
    when 'running'            then 'Running'
    when 'on_hold'            then 'On Hold'
    when 'ready_for_dispatch' then 'Ready for Dispatch'
    when 'dispatched'         then 'Dispatched'
    when 'cancelled'          then 'Cancelled'
    else coalesce(nullif(p, ''), 'an unknown state') end
$$;

create or replace function public.order_notify_actor_suffix(p_actor uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select ' by ' || u.full_name from public.users u
                    where u.id = p_actor and nullif(btrim(u.full_name), '') is not null), '')
$$;
revoke all on function public.order_notify_actor_suffix(uuid) from public, anon, authenticated;


-- ═══ 2. The Order's activity trail ══════════════════════════════════════════

create or replace function public.order_activity_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_num      text;
  v_assigned uuid;
  v_actor    uuid := coalesce(new.actor_id, auth.uid());
  v_by       text;
  v_p        jsonb := coalesce(new.payload, '{}'::jsonb);
  v_type     notification_type;
  v_title    text;
  v_body     text;
  v_users    uuid[];
  v_keys     text[];
  v_amount   text;
  v_ref      text;
  v_label    text;
begin
  select o.display_number, o.assigned_to into v_num, v_assigned
    from public.orders o where o.id = new.order_id;
  if not found then
    return null;
  end if;
  v_num := 'Order ' || coalesce(v_num, '');
  v_by  := public.order_notify_actor_suffix(v_actor);

  if new.event_type = 'status_changed' then
    if (v_p ->> 'from') is not distinct from (v_p ->> 'to') then return null; end if;
    v_type  := 'order_update_status';
    v_title := format('%s status changed from %s to %s%s.', v_num,
                      public.order_notify_status_word(v_p ->> 'from'),
                      public.order_notify_status_word(v_p ->> 'to'), v_by);
    v_body  := case when nullif(btrim(v_p ->> 'reason'), '') is not null then 'Reason: ' || btrim(v_p ->> 'reason') end;
    v_users := public.order_update_recipient_ids(new.order_id);

  elsif new.event_type = 'production_alignment_changed' then
    v_type  := 'order_update_production';
    v_title := format('%s was %s%s.', v_num,
                      case when v_p ->> 'to' = 'aligned' then 'aligned for production' else 'moved back to not aligned' end, v_by);
    v_body  := v_p ->> 'note';
    v_users := public.order_update_recipient_ids(new.order_id);

  elsif new.event_type in ('payment_verified', 'payment_rejected', 'payment_linked', 'payment_unlinked') then
    v_amount := coalesce(v_p ->> 'allocated_amount', v_p ->> 'payment_amount', v_p ->> 'amount');
    v_ref    := coalesce(nullif(btrim(v_p ->> 'human_payment_id'), ''), nullif(btrim(v_p ->> 'request_number'), ''));
    v_type   := 'order_update_payment';
    v_title  := format('%s %s %s%s.',
                       case when v_amount ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
                            then 'Payment of ₹' || to_char(btrim(v_amount)::numeric, 'FM999999999990.00')
                            else 'A payment' end,
                       case new.event_type
                         when 'payment_verified' then 'verified for'
                         when 'payment_rejected' then 'rejected for'
                         when 'payment_unlinked' then 'unlinked from'
                         else 'linked to' end,
                       v_num, v_by);
    v_body  := case when v_ref is not null then 'Payment ' || v_ref end;
    v_users := public.order_update_recipient_ids(new.order_id);

  elsif new.event_type in ('order_amended', 'order_client_details_amended', 'order_schedule_terms_amended',
                           'order_products_amended', 'order_billing_percentage_amended', 'order_workbook_replaced') then
    v_type := 'order_update_amended';
    select coalesce(array_agg(k order by k), '{}') into v_keys
      from jsonb_object_keys(case when jsonb_typeof(v_p -> 'changes') = 'object' then v_p -> 'changes' else '{}'::jsonb end) k;
    if coalesce(array_length(v_keys, 1), 0) = 0 then
      v_title := format('%s — %s%s.', v_num,
        case new.event_type
          when 'order_workbook_replaced'          then 'PI workbook was replaced'
          when 'order_products_amended'           then 'products were amended'
          when 'order_billing_percentage_amended' then 'billing percentage was amended'
          when 'order_client_details_amended'     then 'client details were amended'
          when 'order_schedule_terms_amended'     then 'schedule or terms were amended'
          else 'details were amended' end, v_by);
    else
      select string_agg(case k
               when 'client_name'         then 'client name'
               when 'total_product_value' then 'total product value'
               when 'total_value'         then 'total order value'
               when 'confirm_date'        then 'confirm date'
               when 'due_date'            then 'due date'
               when 'lead_source'         then 'lead source'
               else replace(k, '_', ' ') end, ', ')
        into v_label from unnest(v_keys) k;
      v_title := case when array_length(v_keys, 1) = 1
                      then format('%s %s was changed%s.', v_num, v_label, v_by)
                      else format('%s was amended%s: %s.', v_num, v_by, v_label) end;
    end if;
    v_body  := v_p ->> 'reason';
    v_users := public.order_update_recipient_ids(new.order_id);

  elsif new.event_type = 'sample_type_changed' then
    v_type  := 'order_update_amended';
    v_title := format('%s sample changed to %s%s.', v_num,
                      case v_p ->> 'to'
                        when 'sampling_needed' then 'Sampling needed before production'
                        when 'sample_order'    then 'Sample order only'
                        else 'Not a sample' end, v_by);
    v_users := public.order_update_recipient_ids(new.order_id);

  elsif new.event_type = 'order_advance_hold_opened' then
    -- Approvers and the reviewer are told by order_advance_hold_recheck; the
    -- salesperson was not.
    v_type  := 'order_update_payment';
    v_title := format('%s is on hold: the verified advance is below the required 40%%.', v_num);
    v_users := array[v_assigned];

  elsif new.event_type = 'order_advance_exception_approved' then
    -- The operations reviewer is told by approve_order_advance_exception; the
    -- salesperson was not.
    v_type  := 'order_update_payment';
    v_title := format('Approval to continue %s below the 40%% advance was granted%s.', v_num, v_by);
    v_body  := v_p ->> 'reason';
    v_users := array[v_assigned];

  else
    return null;
  end if;

  perform public.order_notify_users(v_users, v_actor, new.order_id, v_type, v_title, v_body);
  return null;
exception when others then
  raise warning 'order_activity_notify skipped a notice for activity %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_activity_notify() from public, anon, authenticated;

drop trigger if exists order_activity_log_notify on public.order_activity_log;
create trigger order_activity_log_notify
  after insert on public.order_activity_log
  for each row execute function public.order_activity_notify();


-- ═══ 3. Fabric & Finish ═════════════════════════════════════════════════════

create or replace function public.order_approval_event_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_num   text;
  v_actor uuid := coalesce(new.actor_id, auth.uid());
begin
  select 'Order ' || o.display_number into v_num from public.orders o where o.id = new.order_id;
  if v_num is null then return null; end if;
  perform public.order_notify_users(
    public.order_update_recipient_ids(new.order_id), v_actor, new.order_id, 'order_update_approval',
    format('%s %s is now %s%s.', v_num,
           case new.approval_kind when 'fabric' then 'fabric' when 'finish' then 'finish' else new.approval_kind end,
           case new.status
             when 'fully_approved'     then 'Fully Approved'
             when 'partially_approved' then 'Partially Approved'
             else 'Not Approved' end,
           public.order_notify_actor_suffix(v_actor)),
    null);
  return null;
exception when others then
  raise warning 'order_approval_event_notify skipped a notice for event %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_approval_event_notify() from public, anon, authenticated;

drop trigger if exists order_approval_events_notify on public.order_approval_events;
create trigger order_approval_events_notify
  after insert on public.order_approval_events
  for each row execute function public.order_approval_event_notify();


-- ═══ 4. Change requests ═════════════════════════════════════════════════════

create or replace function public.order_change_request_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_num    text := 'Order ' || coalesce(new.order_number_snapshot, '');
  v_verb   text := case new.request_type when 'cancel' then 'cancel' else 'change' end;
  v_actor  uuid;
  v_admins uuid[];
begin
  if tg_op = 'INSERT' then
    v_actor := coalesce(new.requested_by, auth.uid());
    select coalesce(array_agg(u.id), '{}') into v_admins
      from public.users u
     where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false;
    perform public.order_notify_users(
      v_admins, v_actor, new.order_id, 'order_change_requested',
      format('%s: %s asked to %s the Order.', v_num,
             coalesce(nullif(btrim(public.order_notify_actor_suffix(v_actor)), ''), 'someone'),
             v_verb),
      new.reason);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved', 'rejected') then
    v_actor := coalesce(new.reviewed_by, auth.uid());
    perform public.order_notify_users(
      array[new.requested_by], v_actor, new.order_id, 'order_change_decided',
      format('Your request to %s %s was %s%s.', v_verb, v_num, new.status,
             public.order_notify_actor_suffix(v_actor)),
      new.review_note);
  end if;
  return null;
exception when others then
  raise warning 'order_change_request_notify skipped a notice for request %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_change_request_notify() from public, anon, authenticated;

drop trigger if exists order_change_requests_notify on public.order_change_requests;
create trigger order_change_requests_notify
  after insert or update of status on public.order_change_requests
  for each row execute function public.order_change_request_notify();


-- ═══ 5. A PI sent for review, returned or rejected ══════════════════════════

create or replace function public.order_submission_review_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_client    text := coalesce(nullif(btrim(new.client_name), ''), 'a client');
  v_approvers uuid[];
begin
  if new.status is not distinct from old.status then
    return null;
  end if;

  if new.status = 'submitted' then
    -- RUN AT COMMIT (deferred): an approver who submits their own PI is
    -- auto-approved in the same transaction, and "sent for approval" must not
    -- reach the other approvers for a PI that is already approved.
    if (select s.status from public.order_submissions s where s.id = new.id) is distinct from 'submitted' then
      return null;
    end if;
    select coalesce(array_agg(user_id), '{}') into v_approvers
      from public.users_with_module_permission('orders', 'approve_order');
    perform public.order_notify_users(
      v_approvers, v_actor, new.id, 'pi_review_requested',
      format('The PI for %s was sent for approval%s.', v_client, public.order_notify_actor_suffix(coalesce(v_actor, new.submitted_by))),
      null);
  elsif old.status = 'submitted' and new.status in ('needs_changes', 'rejected') then
    perform public.order_notify_users(
      array[new.submitted_by, new.created_by], v_actor, new.id, 'pi_review_decided',
      case new.status
        when 'needs_changes' then format('Changes were requested on the PI for %s%s.', v_client, public.order_notify_actor_suffix(v_actor))
        else format('The PI for %s was rejected%s.', v_client, public.order_notify_actor_suffix(v_actor)) end,
      new.review_note);
  end if;
  return null;
exception when others then
  raise warning 'order_submission_review_notify skipped a notice for PI %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_submission_review_notify() from public, anon, authenticated;

drop trigger if exists order_submissions_review_notify on public.order_submissions;
-- A CONSTRAINT trigger only so it can be DEFERRED to commit (see above).
create constraint trigger order_submissions_review_notify
  after update of status on public.order_submissions
  deferrable initially deferred
  for each row execute function public.order_submission_review_notify();


-- ═══ 6. A PI approved into a Confirmed Order ════════════════════════════════

create or replace function public.order_created_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_sub    record;
begin
  if new.source_order_submission_id is null then
    return null;
  end if;
  select s.client_name, s.created_by, s.submitted_by into v_sub
    from public.order_submissions s where s.id = new.source_order_submission_id;
  perform public.order_notify_users(
    array[v_sub.submitted_by, v_sub.created_by, new.assigned_to], v_actor, new.id, 'order_converted',
    format('The PI for %s was approved — Order %s is confirmed%s.',
           coalesce(nullif(btrim(coalesce(v_sub.client_name, new.client_name)), ''), 'a client'),
           coalesce(new.display_number, ''), public.order_notify_actor_suffix(v_actor)),
    null);
  return null;
exception when others then
  raise warning 'order_created_notify skipped a notice for Order %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_created_notify() from public, anon, authenticated;

drop trigger if exists orders_created_notify on public.orders;
create trigger orders_created_notify
  after insert on public.orders
  for each row execute function public.order_created_notify();


-- ═══ 7. Operations' decision, to the salesperson too ════════════════════════

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
  perform public.order_notify_users(
    array[v_order.assigned_to], v_actor, new.order_id, 'order_operations_review_decided',
    case new.status
      when 'accepted' then format('Order %s: Operations accepted PI V%s for production%s.',
                                  v_order.display_number, new.version_number, public.order_notify_actor_suffix(v_actor))
      else format('Order %s: Operations asked for clarification on PI V%s%s.',
                  v_order.display_number, new.version_number, public.order_notify_actor_suffix(v_actor)) end,
    case when new.status = 'clarification_needed' then new.clarification_reason else new.accepted_note end);
  return null;
exception when others then
  raise warning 'order_operations_handoff_notify skipped a notice for handoff %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_operations_handoff_notify() from public, anon, authenticated;

drop trigger if exists order_operations_handoffs_notify on public.order_operations_handoffs;
create trigger order_operations_handoffs_notify
  after update of status on public.order_operations_handoffs
  for each row execute function public.order_operations_handoff_notify();


-- ═══ 8. Proof ═══════════════════════════════════════════════════════════════

do $$
declare
  v_missing text;
begin
  select string_agg(t, ', ') into v_missing
    from unnest(array[
      'order_activity_log:order_activity_log_notify',
      'order_approval_events:order_approval_events_notify',
      'order_change_requests:order_change_requests_notify',
      'order_submissions:order_submissions_review_notify',
      'orders:orders_created_notify',
      'order_operations_handoffs:order_operations_handoffs_notify']) t
   where not exists (
     select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where c.relnamespace = 'public'::regnamespace
        and c.relname = split_part(t, ':', 1)
        and g.tgname = split_part(t, ':', 2)
        and not g.tgisinternal);
  if v_missing is not null then
    raise exception 'PROOF FAILED: triggers missing: %', v_missing;
  end if;
  if has_function_privilege('authenticated', 'public.order_notify_users(uuid[], uuid, uuid, notification_type, text, text)', 'execute') then
    raise exception 'PROOF FAILED: a client role may call order_notify_users';
  end if;
end $$;

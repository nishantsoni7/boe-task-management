-- ═══════════════════════════════════════════════════════════════════════════
-- 20270328000100  A PI SENT BACK OR REJECTED ALSO TELLS ITS SALESPERSON
-- ═══════════════════════════════════════════════════════════════════════════
--
-- order_submission_review_notify() (20270321000001) told only submitted_by and
-- created_by when a reviewer returned or rejected a PI. The salesperson named on
-- the PI (salesperson_id, 20270211000000) can be someone else, and the personal
-- dashboard is built around that person. They are now told as well.
--
-- Restated from 20270321000001 with ONE change: the recipients array gains
-- new.salesperson_id. order_notify_users already drops the actor, inactive users
-- and duplicates (it selects DISTINCT users), so a person who is several of the
-- three gets one notice. Type, title and body are unchanged; the badge (amber
-- "Changes requested" / red "Rejected") is chosen by the app from the title.

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
      array[new.submitted_by, new.created_by, new.salesperson_id], v_actor, new.id, 'pi_review_decided',
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

do $$
begin
  if pg_get_functiondef('public.order_submission_review_notify()'::regprocedure) !~ 'salesperson_id' then
    raise exception 'VERIFY: order_submission_review_notify() does not notify the salesperson';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'order_submissions_review_notify' and not tgisinternal) then
    raise exception 'VERIFY: order_submissions_review_notify trigger is missing (20270321000001 not applied?)';
  end if;
end $$;

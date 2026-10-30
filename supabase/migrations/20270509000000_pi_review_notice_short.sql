-- ═══════════════════════════════════════════════════════════════════════════
-- 20270509000000  PI RETURNED / CLOSED — ONE SHORT LINE, NOT THE WHOLE NOTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner, 2026-10-30: the notice a salesperson gets when a PI is returned or
-- closed should only say that it happened. The approver's note can run to many
-- paragraphs; it stays on the PI page (its attention card shows it at the top),
-- where the salesperson must go anyway to edit and submit again.
--
-- This restates order_submission_review_notify() (20270328000100), UNCHANGED
-- except for the words of the two decision notices and their body:
--
--   Returned to Sales (needs_changes):
--     before  "Changes were requested on the PI for IBC by Nishant Soni."  + the whole note
--     now     "PID-00021 · IBC was returned to you by Nishant Soni."       + no body
--   Close: deal lost (rejected, the button since 20270506000000):
--     before  "The PI for IBC was rejected by Nishant Soni."               + the reason
--     now     "PID-00019 · IBC was closed (deal lost) by Nishant Soni."    + no body
--
-- With no PI reference on record the line starts "The PI for <client>".
-- Same type (pi_review_decided, so no enum change), same recipients (salesperson,
-- creator, submitter — never the person who decided, via order_notify_users),
-- same 2-minute rule, same "sent for approval" notice. Notices already written
-- keep their old words; getNotificationMeta recognises both.
--
-- Roll-back: run the create-or-replace of 20270328000100 again (the previous
-- body, unchanged since).

create or replace function public.order_submission_review_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_client    text := coalesce(nullif(btrim(new.client_name), ''), 'a client');
  v_pi        text;
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
    -- ONE LINE: which PI, what happened, who did it. The note stays on the PI page.
    v_pi := case when nullif(btrim(new.draft_reference), '') is not null
                 then format('%s · %s', btrim(new.draft_reference), v_client)
                 else format('The PI for %s', v_client) end;
    perform public.order_notify_users(
      array[new.submitted_by, new.created_by, new.salesperson_id], v_actor, new.id, 'pi_review_decided',
      case new.status
        when 'needs_changes' then format('%s was returned to you%s.', v_pi, public.order_notify_actor_suffix(v_actor))
        else format('%s was closed (deal lost)%s.', v_pi, public.order_notify_actor_suffix(v_actor)) end,
      null);
  end if;
  return null;
exception when others then
  raise warning 'order_submission_review_notify skipped a notice for PI %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_submission_review_notify() from public, anon, authenticated;

do $$
declare
  v_def text := pg_get_functiondef('public.order_submission_review_notify()'::regprocedure);
begin
  if v_def !~ 'salesperson_id' then
    raise exception 'VERIFY: order_submission_review_notify() does not notify the salesperson';
  end if;
  if v_def !~ 'was returned to you' or v_def !~ 'was closed \(deal lost\)' then
    raise exception 'VERIFY: order_submission_review_notify() does not write the short lines';
  end if;
  if v_def ~ 'new\.review_note' then
    raise exception 'VERIFY: order_submission_review_notify() still copies the note into the notice';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'order_submissions_review_notify' and not tgisinternal) then
    raise exception 'VERIFY: order_submissions_review_notify trigger is missing (20270321000001 not applied?)';
  end if;
end $$;

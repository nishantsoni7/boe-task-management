-- A task submitted for approval no longer requires action from its assignee,
-- so it must stop occupying one of that user's Top 3 Focus slots. Returning it
-- to Working makes it actionable again but deliberately does not recreate the
-- personal pin; the assignee may choose to pin it again.

create or replace function public.cleanup_top_tasks_on_completion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('pending_approval', 'completed', 'cancelled')
     and old.status not in ('pending_approval', 'completed', 'cancelled') then
    delete from public.user_top_tasks where task_id = new.id;
  end if;
  return new;
end;
$$;

revoke all on function public.cleanup_top_tasks_on_completion() from public, anon, authenticated;

comment on function public.cleanup_top_tasks_on_completion() is
  'Trigger-only cleanup: removes personal Top 3 pins when a task moves to approval or closes.';

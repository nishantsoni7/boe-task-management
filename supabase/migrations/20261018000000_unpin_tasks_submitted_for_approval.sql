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

-- ─── One-time cleanup ────────────────────────────────────────────────────────
-- The trigger above only fires on a FUTURE status change, so tasks that were
-- already submitted, completed or cancelled when this migration ran would keep
-- their pin row indefinitely. The Top 3 query filters those out, so nothing is
-- visibly wrong — but the rows are dead, they make display_order values
-- ambiguous, and they leave `pinnedIds` reporting pins for work that is no
-- longer anyone's to do.
--
-- Deleting them is safe and idempotent: user_top_tasks holds nothing but a
-- personal ordering, a removed pin is exactly what the trigger would have
-- written, and re-running the migration finds nothing left to delete.
delete from public.user_top_tasks utt
using public.tasks t
where t.id = utt.task_id
  and t.status in ('pending_approval', 'completed', 'cancelled');

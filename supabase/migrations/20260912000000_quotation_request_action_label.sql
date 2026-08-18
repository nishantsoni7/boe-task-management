-- Make the employee-facing quotation grant match the operation it controls.
-- The action key is unchanged, so every existing override remains valid.

begin;

update public.permission_actions
set display_name = 'Submit Quotation Requests'
where action_key = 'manage_quotations';

do $$
begin
  if not exists (
    select 1
    from public.permission_actions
    where action_key = 'manage_quotations'
      and display_name = 'Submit Quotation Requests'
  ) then
    raise exception 'manage_quotations action is missing or was not renamed';
  end if;

  if not exists (
    select 1
    from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id
    where pm.module_key = 'task_management'
      and pa.action_key = 'manage_quotations'
      and mpa.default_allowed = false
  ) then
    raise exception 'task_management.manage_quotations must remain deny-by-default';
  end if;
end
$$;

commit;

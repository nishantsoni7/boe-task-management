-- Quotation requests go to the owner OR Nitish (owner, 18 Nov 2026: "an option to share the quotation to either me or
-- Nitish"; answers in chat: the salesperson must pick and the pick is remembered; Nitish sees the requests sent to him and
-- the owner sees all; Nitish gets full maker access).
--
-- Until now every request was assigned to one user found by a hard-coded email in the request form.
--
-- Adds:
--   1. A protected Task Management action `receive_quotations` ("Receive quotation requests"), off by default and with
--      no role default: an administrator receives requests by role, anybody else only by a per-person grant.
--   2. quotation_request_receiver(user) and quotation_request_receivers(): who may be sent a request (an active
--      administrator, or an active holder of the action). The request form lists them.
--   3. A guard on tasks: a quotation request can only be created for, or moved to, a receiver. A request can no longer
--      reach nobody, or somebody who cannot answer it.
--   4. Read policies so an administrator sees EVERY quotation request (the task, its timeline, its attachments), not
--      only the ones assigned to them. Ordinary tasks are untouched: the existing policies stay as they are.
--      Storage already lets an administrator read task attachments (task_attachments_storage_select).
--   5. Nitish's grants, approved by the owner in chat on 18 Nov 2026 ("Full maker access"): Task Management
--      view_quotations + receive_quotations; Quotations view, create, edit, view_all. Employee overrides only, so the owner
--      can change any of them later in Control Center without a migration.
--
-- Rollback: drop trigger tasks_quotation_request_receiver on public.tasks; drop function
-- tasks_quotation_request_receiver_guard(), quotation_request_receivers(), quotation_request_receiver(uuid),
-- quotation_request_overseer(); drop policy tasks_quotation_requests_admin_read on public.tasks,
-- task_activity_log_quotation_requests_admin_read on public.task_activity_log, task_attachments_quotation_requests_admin_read
-- on public.task_attachments; update employee_permission_overrides set allowed = false, revoked_at = now() for Nitish's six
-- rows; delete from module_permission_actions / permission_actions the receive_quotations rows.

begin;

-- ─── 1. The action ─────────────────────────────────────────────────────────────
insert into public.permission_actions (action_key, display_name, is_system)
values ('receive_quotations', 'Receive Quotation Requests', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'receive_quotations'
where pm.module_key = 'task_management'
on conflict (module_id, action_id) do nothing;

-- ─── 2. Who receives requests ─────────────────────────────────────────────────
create or replace function public.quotation_request_receiver(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users u
    where u.id = p_user and u.is_active and coalesce(u.is_deleted, false) = false
      and (u.role = 'admin' or public.resolve_permission(u.id, 'task_management', 'receive_quotations'))
  )
$$;
revoke all on function public.quotation_request_receiver(uuid) from public, anon;
grant execute on function public.quotation_request_receiver(uuid) to authenticated;

-- Names and ids only: the request form shows them as the "Send to" choice. Administrators first, then by name.
create or replace function public.quotation_request_receivers()
returns table (id uuid, full_name text) language sql stable security definer set search_path = public, pg_temp
as $$
  select u.id, u.full_name
  from public.users u
  where auth.uid() is not null and public.quotation_request_receiver(u.id)
  order by (u.role = 'admin') desc, u.full_name
$$;
revoke all on function public.quotation_request_receivers() from public, anon;
grant execute on function public.quotation_request_receivers() to authenticated;

-- ─── 3. The guard ─────────────────────────────────────────────────────────────
create or replace function public.tasks_quotation_request_receiver_guard()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.task_type = 'quotation_request'
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to or new.task_type is distinct from old.task_type)
     and not public.quotation_request_receiver(new.assigned_to) then
    raise exception 'QUOTATION_REQUEST_RECEIVER: a quotation request can only be sent to someone who receives quotation requests'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists tasks_quotation_request_receiver on public.tasks;
create trigger tasks_quotation_request_receiver
  before insert or update of assigned_to, task_type on public.tasks
  for each row execute function public.tasks_quotation_request_receiver_guard();

-- ─── 4. An administrator sees every quotation request ─────────────────────────
create or replace function public.quotation_request_overseer()
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active)
$$;
revoke all on function public.quotation_request_overseer() from public, anon;
grant execute on function public.quotation_request_overseer() to authenticated;

drop policy if exists tasks_quotation_requests_admin_read on public.tasks;
create policy tasks_quotation_requests_admin_read on public.tasks
  for select to authenticated
  using (task_type = 'quotation_request' and public.quotation_request_overseer());

drop policy if exists task_activity_log_quotation_requests_admin_read on public.task_activity_log;
create policy task_activity_log_quotation_requests_admin_read on public.task_activity_log
  for select to authenticated
  using (public.quotation_request_overseer() and exists (
    select 1 from public.tasks t where t.id = task_activity_log.task_id and t.task_type = 'quotation_request'));

drop policy if exists task_attachments_quotation_requests_admin_read on public.task_attachments;
create policy task_attachments_quotation_requests_admin_read on public.task_attachments
  for select to authenticated
  using (public.quotation_request_overseer() and (
    exists (select 1 from public.tasks t where t.id = task_attachments.task_id and t.task_type = 'quotation_request')
    or exists (select 1 from public.task_activity_log l join public.tasks t on t.id = l.task_id
               where l.id = task_attachments.activity_log_id and t.task_type = 'quotation_request')));

-- ─── 5. Nitish's grants (owner, 18 Nov 2026, "Full maker access") ─────────────
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by, granted_at)
select v.user_id, pm.id, pa.id, true, '6507df9f-cdeb-4ebd-849f-8498c165d596', now()
from (values
  ('58ec48e3-d252-4660-b61b-4db48fb58e9e'::uuid, 'task_management', 'view_quotations'),
  ('58ec48e3-d252-4660-b61b-4db48fb58e9e'::uuid, 'task_management', 'receive_quotations'),
  ('58ec48e3-d252-4660-b61b-4db48fb58e9e'::uuid, 'quotations',      'view'),
  ('58ec48e3-d252-4660-b61b-4db48fb58e9e'::uuid, 'quotations',      'create'),
  ('58ec48e3-d252-4660-b61b-4db48fb58e9e'::uuid, 'quotations',      'edit'),
  ('58ec48e3-d252-4660-b61b-4db48fb58e9e'::uuid, 'quotations',      'view_all')
) as v(user_id, module_key, action_key)
join public.permission_modules pm on pm.module_key = v.module_key
join public.permission_actions  pa on pa.action_key = v.action_key
join public.module_permission_actions mpa on mpa.module_id = pm.id and mpa.action_id = pa.id
join public.users u on u.id = v.user_id and u.is_active and coalesce(u.is_deleted, false) = false
on conflict (user_id, module_id, action_id) do update
  set allowed = true, revoked_at = null, revoked_by = null, granted_by = excluded.granted_by, granted_at = excluded.granted_at;

-- ─── 6. Post-conditions ───────────────────────────────────────────────────────
do $$
declare v_count int;
begin
  select count(*) into v_count
  from public.module_permission_actions mpa
  join public.permission_modules pm on pm.id = mpa.module_id
  join public.permission_actions pa on pa.id = mpa.action_id
  where pm.module_key = 'task_management' and pa.action_key = 'receive_quotations' and not mpa.default_allowed;
  if v_count <> 1 then raise exception 'QUOTATION_REQUEST_RECEIVERS: receive_quotations is not registered off by default'; end if;

  select count(*) into v_count
  from public.role_permissions rp join public.permission_actions pa on pa.id = rp.action_id
  where pa.action_key = 'receive_quotations' and rp.allowed;
  if v_count <> 0 then raise exception 'QUOTATION_REQUEST_RECEIVERS: a role default grants receive_quotations'; end if;

  if not public.quotation_request_receiver('6507df9f-cdeb-4ebd-849f-8498c165d596') then
    raise exception 'QUOTATION_REQUEST_RECEIVERS: the owner does not receive quotation requests';
  end if;
  if not public.quotation_request_receiver('58ec48e3-d252-4660-b61b-4db48fb58e9e') then
    raise exception 'QUOTATION_REQUEST_RECEIVERS: Nitish does not receive quotation requests';
  end if;
  if not public.resolve_permission('58ec48e3-d252-4660-b61b-4db48fb58e9e', 'quotations', 'view_all')
     or not public.resolve_permission('58ec48e3-d252-4660-b61b-4db48fb58e9e', 'task_management', 'view_quotations') then
    raise exception 'QUOTATION_REQUEST_RECEIVERS: Nitish''s grants did not land';
  end if;

  -- Every request already in the table goes to a receiver, so no existing row is left that the guard would refuse to touch.
  select count(*) into v_count from public.tasks t
  where t.task_type = 'quotation_request' and t.status not in ('completed', 'cancelled')
    and not public.quotation_request_receiver(t.assigned_to);
  if v_count <> 0 then raise exception 'QUOTATION_REQUEST_RECEIVERS: % open request(s) are assigned to a non-receiver', v_count; end if;

  if not exists (select 1 from pg_trigger where tgname = 'tasks_quotation_request_receiver' and tgrelid = 'public.tasks'::regclass) then
    raise exception 'QUOTATION_REQUEST_RECEIVERS: the guard trigger is missing';
  end if;
  if has_function_privilege('anon', 'public.quotation_request_receivers()', 'execute') then
    raise exception 'QUOTATION_REQUEST_RECEIVERS: anon may list the receivers';
  end if;
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20270424000000 — a personal drag-and-drop order for My Tasks
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One row per person holding the task ids in the order they dragged them to.
-- The My Tasks page sorts: Important first, then Today's Focus pins, then this
-- list, then the application's default order for anything not on it.
--
-- A DISPLAY PREFERENCE ONLY. It grants no access and is consulted by no guard,
-- RPC or policy: the page lists tasks the person can already read (tasks RLS)
-- and merely sorts them by this list. An id for a task they cannot see, or one
-- since completed, is inert.
--
-- One row with an array, replaced whole by a single upsert, is atomic — a save
-- either happens or does not (user_top_tasks' DELETE + INSERT reorder is not).
-- The same shape as public.user_module_order (20261228000000).

create or replace function public.user_task_order_ids_valid(p_ids uuid[])
returns boolean
language sql
immutable
as $$
  select
    p_ids is not null
    and coalesce(array_ndims(p_ids), 1) = 1
    and coalesce(array_length(p_ids, 1), 0) <= 1000
    and array_position(p_ids, null) is null
    and coalesce(array_length(p_ids, 1), 0) = (select count(distinct i) from unnest(p_ids) as i)
$$;

comment on function public.user_task_order_ids_valid(uuid[]) is
  'True when a uuid[] is a well-formed task order: one dimension, at most 1000 entries, no nulls, no id twice. Used only by the check constraint on public.user_task_order.task_ids. 20270424000000.';

create table if not exists public.user_task_order (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  task_ids   uuid[]      not null default '{}',
  updated_at timestamptz not null default now(),
  constraint user_task_order_ids_valid
    check (public.user_task_order_ids_valid(task_ids))
);

comment on table public.user_task_order is
  'One row per person: the order they dragged their My Tasks list into, as task ids, first task first. A DISPLAY PREFERENCE ONLY - it grants no access; ids for tasks the person cannot read or that are finished are ignored on read. 20270424000000.';

alter table public.user_task_order enable row level security;

revoke all on public.user_task_order from public, anon, authenticated;
grant select, insert, update on public.user_task_order to authenticated;

drop policy if exists user_task_order_select on public.user_task_order;
create policy user_task_order_select
  on public.user_task_order
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists user_task_order_insert on public.user_task_order;
create policy user_task_order_insert
  on public.user_task_order
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists user_task_order_update on public.user_task_order;
create policy user_task_order_update
  on public.user_task_order
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.touch_user_task_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_task_order_touch on public.user_task_order;
create trigger user_task_order_touch
  before insert or update on public.user_task_order
  for each row
  execute function public.touch_user_task_order();

-- ─── Self-assertion: executed at apply time, aborts the migration on failure ──
do $$
declare
  v_policies text[];
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'user_task_order' and rowsecurity
  ) then
    raise exception 'user_task_order: RLS is not enabled';
  end if;

  select array_agg(distinct cmd order by cmd) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'user_task_order';
  if v_policies is distinct from array['INSERT', 'SELECT', 'UPDATE'] then
    raise exception 'user_task_order: expected SELECT/INSERT/UPDATE policies, found %', v_policies;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_task_order'
      and coalesce(qual, '') || coalesce(with_check, '') not like '%auth.uid()%'
  ) then
    raise exception 'user_task_order: a policy is not scoped to auth.uid()';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_task_order'
      and cmd = 'UPDATE' and qual like '%auth.uid()%' and with_check like '%auth.uid()%'
  ) then
    raise exception 'user_task_order: the update policy is missing its with-check half';
  end if;

  if has_table_privilege('anon', 'public.user_task_order', 'SELECT')
     or has_table_privilege('anon', 'public.user_task_order', 'INSERT')
     or has_table_privilege('anon', 'public.user_task_order', 'UPDATE') then
    raise exception 'user_task_order: anon holds a grant';
  end if;
  if has_table_privilege('authenticated', 'public.user_task_order', 'DELETE') then
    raise exception 'user_task_order: authenticated can DELETE';
  end if;
  if not has_table_privilege('authenticated', 'public.user_task_order', 'SELECT')
     or not has_table_privilege('authenticated', 'public.user_task_order', 'INSERT')
     or not has_table_privilege('authenticated', 'public.user_task_order', 'UPDATE') then
    raise exception 'user_task_order: authenticated lost a grant';
  end if;

  if not public.user_task_order_ids_valid('{}'::uuid[])
     or not public.user_task_order_ids_valid(array['00000000-0000-0000-0000-000000000001'::uuid])
     or public.user_task_order_ids_valid(array['00000000-0000-0000-0000-000000000001'::uuid,
                                               '00000000-0000-0000-0000-000000000001'::uuid])
     or public.user_task_order_ids_valid(array['00000000-0000-0000-0000-000000000001'::uuid, null]) then
    raise exception 'user_task_order: the task_ids validator does not hold';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_task_order'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) then
    raise exception 'user_task_order: user_id does not cascade from auth.users';
  end if;
end $$;

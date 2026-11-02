-- 20270523000000_meta_weekly_review.sql
--
-- Marketing, Meta Ads, phase 2: what the Monday review leaves behind. GET /api/integrations/meta/review (Vercel Cron,
-- with CRON_SECRET) works out the week's figures in code, asks Claude for the words, checks the answer and writes here
-- with the service role. Nothing here can change the Meta account.
--
-- meta_reviews    one row per reviewed week; a failed week keeps its row with status 'failed' and the screens keep
--                 showing the last good one.
-- meta_learnings  lessons proposed by the review. Only the ones a person confirms are used later.
-- meta_needs      what the manager needs from the owner, from rules in code and from the review's Look at list.
--
-- No data is seeded. Lead names and phone numbers never enter these tables.
--
-- READ:  a signed-in person with Marketing `view` (or Admin), through module_entry_open('marketing').
-- WRITE: the service role only, plus two functions that need Admin or Marketing `edit`. A browser has no write grant.
--
-- ROLLBACK (nothing else reads these):
--   drop function public.meta_decide_learning(uuid, text);
--   drop function public.meta_update_need(uuid, text, uuid);
--   drop table public.meta_needs, public.meta_learnings, public.meta_reviews;

create table public.meta_reviews (
  week_start date primary key,
  week_end date not null check (week_end = week_start + 6),
  status text not null check (status in ('ok', 'failed')),
  verdict text check (verdict in ('better', 'same', 'worse', 'quiet')),
  numbers jsonb not null default '{}'::jsonb check (jsonb_typeof(numbers) = 'object'),
  body jsonb not null default '{}'::jsonb check (jsonb_typeof(body) = 'object'),
  message text not null default '' check (length(message) <= 500),
  model text not null default '' check (length(model) <= 80),
  created_at timestamptz not null default now(),
  check (status = 'failed' or verdict is not null)
);

create table public.meta_learnings (
  id uuid primary key default gen_random_uuid(),
  lesson_key text not null unique check (lesson_key ~ '^[a-z0-9-]{3,60}$'),
  title text not null check (length(title) between 1 and 200),
  evidence text not null check (length(evidence) between 1 and 800),
  strength text not null check (strength in ('solid', 'fair', 'thin')),
  status text not null default 'open' check (status in ('open', 'confirmed', 'rejected')),
  first_seen_week date not null,
  decided_by uuid references public.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meta_learnings_status_idx on public.meta_learnings (status, created_at desc);

create table public.meta_needs (
  id uuid primary key default gen_random_uuid(),
  need_key text not null unique check (length(need_key) between 1 and 120),
  title text not null check (length(title) between 1 and 200),
  why text not null default '' check (length(why) <= 500),
  next_step text not null check (next_step in ('set_target', 'set_cap', 'learnings', 'task')),
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  -- The task the owner made from this need. No foreign key: tasks can be hard-deleted, and a need must survive that.
  task_id uuid,
  resolved_by uuid references public.users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meta_needs_status_idx on public.meta_needs (status, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['meta_reviews', 'meta_learnings', 'meta_needs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.module_entry_open(''marketing''))', t || '_read', t);
  end loop;
end $$;

create function public.meta_decide_learning(p_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
    or not (
      exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or public.resolve_permission(auth.uid(), 'marketing', 'edit')
    ) then
    raise exception 'MARKETING_FORBIDDEN';
  end if;
  if p_decision is null or p_decision not in ('confirmed', 'rejected', 'open') then
    raise exception 'MARKETING_INVALID';
  end if;

  update public.meta_learnings
  set status = p_decision,
      decided_by = case when p_decision = 'open' then null else auth.uid() end,
      decided_at = case when p_decision = 'open' then null else now() end,
      updated_at = now()
  where id = p_id;
  if not found then
    raise exception 'MARKETING_NOT_FOUND';
  end if;
end;
$$;

-- p_task_id records the task the caller just made from this need, and must be that caller's own.
create function public.meta_update_need(p_id uuid, p_status text, p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
    or not (
      exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
      or public.resolve_permission(auth.uid(), 'marketing', 'edit')
    ) then
    raise exception 'MARKETING_FORBIDDEN';
  end if;
  if p_status is null or p_status not in ('open', 'done', 'dismissed') then
    raise exception 'MARKETING_INVALID';
  end if;
  if p_task_id is not null and not exists (
    select 1 from public.tasks t where t.id = p_task_id and auth.uid() in (t.created_by, t.assigned_to)
  ) then
    raise exception 'MARKETING_INVALID';
  end if;

  update public.meta_needs
  set status = p_status,
      task_id = coalesce(p_task_id, task_id),
      resolved_by = case when p_status = 'open' then null else auth.uid() end,
      resolved_at = case when p_status = 'open' then null else now() end,
      updated_at = now()
  where id = p_id;
  if not found then
    raise exception 'MARKETING_NOT_FOUND';
  end if;
end;
$$;

revoke all on function public.meta_decide_learning(uuid, text) from public, anon;
revoke all on function public.meta_update_need(uuid, text, uuid) from public, anon;
grant execute on function public.meta_decide_learning(uuid, text) to authenticated;
grant execute on function public.meta_update_need(uuid, text, uuid) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['meta_reviews', 'meta_learnings', 'meta_needs'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'META_REVIEW: % has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'META_REVIEW: anon can read %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
      or has_table_privilege('authenticated', 'public.' || t, 'update')
      or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'META_REVIEW: a browser could write to %', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.meta_decide_learning(uuid, text)', 'execute')
    or has_function_privilege('anon', 'public.meta_update_need(uuid, text, uuid)', 'execute') then
    raise exception 'META_REVIEW: anon can run a write function';
  end if;
end $$;

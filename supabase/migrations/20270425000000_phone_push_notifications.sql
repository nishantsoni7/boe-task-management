-- Phone alerts (Web Push) for notifications.
--
-- A push is a second delivery of a row already written to public.notifications.
-- Nothing here changes what is notified, to whom, or the notification_type enum.
--
--   push_subscriptions   one row per device a person turned alerts on for.
--   push_preferences     categories a person muted.
--   notifications_push_dispatch()  AFTER INSERT trigger on notifications. When
--       the recipient has at least one device, it asks the app (pg_net, async)
--       to send the push. The app does the filtering and the sending.
--
-- INERT UNTIL CONFIGURED. The trigger reads two Vault secrets,
-- push_dispatch_url and push_dispatch_secret; with either missing it does
-- nothing, so applying this migration changes no behaviour. The secret is never
-- in the repository.
--
-- A NOTIFICATION MUST NEVER FAIL BECAUSE A PUSH COULD NOT BE QUEUED. The trigger
-- swallows every error, so the business action that wrote the row is untouched.
--
-- ROLLBACK:  drop trigger notifications_push_dispatch on public.notifications;
--            drop function public.notifications_push_dispatch();
--            drop table public.push_preferences, public.push_subscriptions;

begin;

create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  -- The push service's address for this device. Unique: one device, one row.
  -- Signing in as someone else on the same device re-points the row.
  endpoint     text not null unique check (endpoint like 'https://%'),
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.push_preferences (
  user_id          uuid primary key references public.users(id) on delete cascade,
  muted_categories text[] not null default '{}'
    check (muted_categories <@ array['task','finance','order','asset','attendance_payroll','review','inventory']::text[]),
  updated_at       timestamptz not null default now()
);

-- Row access is the caller's own rows. Writes go through the app's API routes
-- (service role, scoped to the signed-in user), so no client write policy.
alter table public.push_subscriptions enable row level security;
alter table public.push_preferences   enable row level security;

create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy push_preferences_select_own on public.push_preferences
  for select to authenticated using (user_id = auth.uid());

revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.push_preferences   from anon, authenticated;
grant select on public.push_subscriptions to authenticated;
grant select on public.push_preferences   to authenticated;

create or replace function public.notifications_push_dispatch()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- Rows the inbox never shows get no banner (kept in step with pushPolicy.ts).
  if new.is_digest
     or new.type::text in ('escalation','overdue','stale_flag','morning_digest','evening_digest','task_assigned')
  then
    return new;
  end if;

  -- Most people have no device registered: no secret read, no HTTP call.
  if not exists (select 1 from public.push_subscriptions where user_id = new.user_id) then
    return new;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'push_dispatch_url' limit 1;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_dispatch_secret' limit 1;
  if v_url is null or v_secret is null then
    return new;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body    := jsonb_build_object('notification_id', new.id),
    timeout_milliseconds := 3000
  );
  return new;
exception when others then
  return new;
end;
$$;

revoke all on function public.notifications_push_dispatch() from public, anon, authenticated;

create trigger notifications_push_dispatch
  after insert on public.notifications
  for each row execute function public.notifications_push_dispatch();

commit;

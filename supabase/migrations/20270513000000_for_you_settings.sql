-- ═══════════════════════════════════════════════════════════════════════════
-- 20270513000000 — what the Modules "For you" column may show
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Owner, 2026-10-31: an administrator decides in Control Center what can appear
-- in the column, and each person then chooses for themselves among those items.
--
-- TWO TABLES, BOTH DISPLAY PREFERENCES.
--
--   for_you_item_settings      one row per item an administrator has set: Off,
--                              Optional or Always on. No row means the default
--                              written beside the item in
--                              src/lib/modules/forYouCatalogue.ts, so a new item
--                              needs no seed here.
--
--   user_for_you_preferences   one row per person: the items they turned off for
--                              themselves. Shaped like user_module_order.
--
-- NEITHER GRANTS ANYTHING. No guard, RPC or policy consults them. Every card
-- reads its own data under the reader's own access, so Always on cannot show a
-- person something they could not already open, and an item key is inert text.
--
-- THE COMPANY SETTING HAS ONE DOOR. Clients may read it; only
-- set_for_you_item_mode() writes it, and that refuses anyone who is not an
-- active administrator. A person's own row follows user_module_order: RLS on
-- auth.uid() = user_id, and no DELETE at all.
--
-- ADDITIVE: nothing existing is altered. Until this is applied the app reads
-- both as empty and the column behaves as it did.
--
-- ROLLBACK (nothing else depends on these):
--   drop function public.set_for_you_item_mode(text, text);
--   drop table public.user_for_you_preferences;
--   drop table public.for_you_item_settings;

create table if not exists public.for_you_item_settings (
  item_key   text        primary key,
  mode       text        not null,
  updated_by uuid        references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint for_you_item_settings_key_shape check (item_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint for_you_item_settings_mode_known check (mode in ('off', 'optional', 'always'))
);

comment on table public.for_you_item_settings is
  'What an administrator allows in the Modules For you column. Grants nothing: every card reads its own data under the reader''s own access.';

create table if not exists public.user_for_you_preferences (
  user_id      uuid        primary key references auth.users(id) on delete cascade,
  hidden_items text[]      not null default '{}',
  updated_at   timestamptz not null default now()
);

comment on table public.user_for_you_preferences is
  'The For you items one person turned off for themselves. Grants nothing, and an Always on item ignores it.';

alter table public.for_you_item_settings enable row level security;
alter table public.user_for_you_preferences enable row level security;

revoke all on public.for_you_item_settings from public, anon, authenticated;
grant select on public.for_you_item_settings to authenticated;

revoke all on public.user_for_you_preferences from public, anon, authenticated;
grant select, insert, update on public.user_for_you_preferences to authenticated;

drop policy if exists for_you_item_settings_read on public.for_you_item_settings;
create policy for_you_item_settings_read
  on public.for_you_item_settings
  for select to authenticated
  using (true);

drop policy if exists user_for_you_preferences_select on public.user_for_you_preferences;
create policy user_for_you_preferences_select
  on public.user_for_you_preferences
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists user_for_you_preferences_insert on public.user_for_you_preferences;
create policy user_for_you_preferences_insert
  on public.user_for_you_preferences
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists user_for_you_preferences_update on public.user_for_you_preferences;
create policy user_for_you_preferences_update
  on public.user_for_you_preferences
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.set_for_you_item_mode(p_item_key text, p_mode text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.users u
     where u.id = auth.uid()
       and u.role = 'admin'
       and u.is_active is true
       and u.is_deleted is not true
  ) then
    raise exception 'Only an administrator can change what For you shows.' using errcode = '42501';
  end if;

  insert into public.for_you_item_settings (item_key, mode, updated_by, updated_at)
  values (p_item_key, p_mode, auth.uid(), now())
  on conflict (item_key) do update
    set mode = excluded.mode,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.set_for_you_item_mode(text, text) from public, anon;
grant execute on function public.set_for_you_item_mode(text, text) to authenticated;

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.for_you_item_settings'::regclass) then
    raise exception 'for_you_item_settings: row level security is off';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.user_for_you_preferences'::regclass) then
    raise exception 'user_for_you_preferences: row level security is off';
  end if;
  if has_table_privilege('authenticated', 'public.for_you_item_settings', 'INSERT, UPDATE, DELETE') then
    raise exception 'for_you_item_settings: only set_for_you_item_mode may write it';
  end if;
  if has_table_privilege('authenticated', 'public.user_for_you_preferences', 'DELETE') then
    raise exception 'user_for_you_preferences: there is no delete door';
  end if;
  if has_function_privilege('anon', 'public.set_for_you_item_mode(text, text)', 'EXECUTE') then
    raise exception 'set_for_you_item_mode: anon may not call it';
  end if;
end $$;

-- 20270522000100_meta_ads_tables.sql
--
-- Marketing, Meta Ads, PR A: the tables a daily read of the owner's Meta ad account fills, and the one function
-- that sets the owner's two numbers. GET /api/integrations/meta/sync (Vercel Cron, with CRON_SECRET) reads Meta
-- with a view-only token and writes here with the service role. The screens only read.
--
-- Money is whole paise. Meta sends spend as a decimal string in rupees and budgets in the account currency's
-- smallest unit; src/lib/meta/parse.ts converts both, and nothing here stores a float.
--
-- Meta's own list of what happened on a day (`actions`) is kept as sent. What counts as a "chat" is worked out in
-- code (src/lib/meta/results.ts), so a wrong mapping is fixed without reading Meta again.
--
-- No data is seeded: the repository is public, and ad figures do not belong in it. `meta_settings` is one row of
-- two empty numbers. Lead names and phone numbers never enter these tables: Meta is read for counts only.
--
-- READ:  a signed-in person with Marketing `view` (or Admin), through module_entry_open('marketing').
-- WRITE: the service role only. There is no write policy and no write grant, so a browser cannot write. The two
--        settings are written by meta_set_targets, which needs Admin or Marketing `edit`.
--
-- ROLLBACK (nothing else reads these):
--   drop function public.meta_set_targets(bigint, bigint);
--   drop table public.meta_sync_runs, public.meta_insights_daily, public.meta_ad_sets, public.meta_campaigns,
--   public.meta_settings, public.meta_ad_accounts;

create table public.meta_ad_accounts (
  account_id text primary key check (account_id ~ '^[0-9]{5,25}$'),
  name text not null default '' check (length(name) <= 300),
  currency text not null default '' check (length(currency) <= 8),
  timezone_name text not null default '' check (length(timezone_name) <= 80),
  account_status integer,
  last_synced_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.meta_campaigns (
  campaign_id text primary key check (campaign_id ~ '^[0-9]{5,25}$'),
  account_id text not null references public.meta_ad_accounts (account_id) on delete cascade,
  name text not null default '' check (length(name) <= 500),
  objective text not null default '' check (length(objective) <= 80),
  status text not null default '' check (length(status) <= 40),
  effective_status text not null default '' check (length(effective_status) <= 40),
  daily_budget_paise bigint check (daily_budget_paise >= 0),
  lifetime_budget_paise bigint check (lifetime_budget_paise >= 0),
  created_time timestamptz,
  updated_time timestamptz,
  updated_at timestamptz not null default now()
);
create index meta_campaigns_account_idx on public.meta_campaigns (account_id, effective_status);

create table public.meta_ad_sets (
  ad_set_id text primary key check (ad_set_id ~ '^[0-9]{5,25}$'),
  campaign_id text not null references public.meta_campaigns (campaign_id) on delete cascade,
  account_id text not null references public.meta_ad_accounts (account_id) on delete cascade,
  name text not null default '' check (length(name) <= 500),
  status text not null default '' check (length(status) <= 40),
  effective_status text not null default '' check (length(effective_status) <= 40),
  optimization_goal text not null default '' check (length(optimization_goal) <= 80),
  destination_type text not null default '' check (length(destination_type) <= 80),
  daily_budget_paise bigint check (daily_budget_paise >= 0),
  lifetime_budget_paise bigint check (lifetime_budget_paise >= 0),
  created_time timestamptz,
  updated_time timestamptz,
  updated_at timestamptz not null default now()
);
create index meta_ad_sets_campaign_idx on public.meta_ad_sets (campaign_id);

-- One row per ad set per day that had delivery. No foreign keys on purpose: Meta keeps results for an ad set that
-- has since been deleted, and those days must not be refused because the structure no longer lists it.
create table public.meta_insights_daily (
  ad_set_id text not null check (ad_set_id ~ '^[0-9]{5,25}$'),
  day date not null,
  campaign_id text not null check (campaign_id ~ '^[0-9]{5,25}$'),
  spend_paise bigint not null check (spend_paise >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  clicks bigint not null default 0 check (clicks >= 0),
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  updated_at timestamptz not null default now(),
  primary key (ad_set_id, day)
);
create index meta_insights_daily_day_idx on public.meta_insights_daily (day);
create index meta_insights_daily_campaign_idx on public.meta_insights_daily (campaign_id, day);

-- One row per sync. A 'running' row younger than 15 minutes stops a second sync starting.
create table public.meta_sync_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('first', 'daily')),
  status text not null check (status in ('running', 'ok', 'failed')),
  message text not null default '' check (length(message) <= 500),
  campaigns integer not null default 0 check (campaigns >= 0),
  ad_sets integer not null default 0 check (ad_sets >= 0),
  insight_rows integer not null default 0 check (insight_rows >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index meta_sync_runs_started_idx on public.meta_sync_runs (started_at desc);

-- The owner's two numbers. One row, both empty until the owner sets them.
create table public.meta_settings (
  id boolean primary key default true check (id),
  monthly_cap_paise bigint check (monthly_cap_paise > 0),
  target_cost_per_enquiry_paise bigint check (target_cost_per_enquiry_paise > 0),
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.meta_settings (id) values (true);

do $$
declare t text;
begin
  foreach t in array array['meta_ad_accounts', 'meta_campaigns', 'meta_ad_sets', 'meta_insights_daily', 'meta_sync_runs', 'meta_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.module_entry_open(''marketing''))', t || '_read', t);
  end loop;
end $$;

create function public.meta_set_targets(p_monthly_cap_paise bigint, p_target_cost_paise bigint)
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
  -- Empty means "not set". A number must be a positive amount in paise, and nobody sets a cap past a crore of rupees.
  if (p_monthly_cap_paise is not null and (p_monthly_cap_paise <= 0 or p_monthly_cap_paise > 1000000000))
    or (p_target_cost_paise is not null and (p_target_cost_paise <= 0 or p_target_cost_paise > 1000000000)) then
    raise exception 'MARKETING_INVALID';
  end if;

  update public.meta_settings
  set monthly_cap_paise = p_monthly_cap_paise,
      target_cost_per_enquiry_paise = p_target_cost_paise,
      updated_by = auth.uid(),
      updated_at = now()
  where id;
end;
$$;

revoke all on function public.meta_set_targets(bigint, bigint) from public, anon;
grant execute on function public.meta_set_targets(bigint, bigint) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['meta_ad_accounts', 'meta_campaigns', 'meta_ad_sets', 'meta_insights_daily', 'meta_sync_runs', 'meta_settings'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'META_TABLES: % has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'META_TABLES: anon can read %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
      or has_table_privilege('authenticated', 'public.' || t, 'update')
      or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'META_TABLES: a browser could write to %', t;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.meta_set_targets(bigint, bigint)', 'execute') then
    raise exception 'META_TABLES: anon can run meta_set_targets';
  end if;
  if (select count(*) from public.meta_settings) <> 1 then
    raise exception 'META_TABLES: meta_settings must hold exactly one row';
  end if;
end $$;

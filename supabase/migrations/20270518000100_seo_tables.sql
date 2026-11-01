-- 20270518000100_seo_tables.sql
--
-- The SEO module's six tables. The scheduled sessions on the owner's PC send their results to
-- POST /api/integrations/seo/ingest, which writes here with the service role. The screens only read.
-- Keys come from the sender, so sending the same result twice overwrites it and never doubles it.
--
-- No data is seeded here: the repository is public, and SEO figures do not belong in it.
-- Lead data is counts only. Names and phone numbers never enter these tables.
--
-- READ:  a signed-in person with SEO `view` (or Admin), through module_entry_open('seo').
-- WRITE: the service role only. There is no write policy and no write grant, so a browser cannot write.
--
-- ROLLBACK (nothing else reads these tables):
--   drop table public.seo_feed_runs, public.seo_log, public.seo_reviews, public.seo_plan_items,
--   public.seo_watchlist, public.seo_metrics;

-- Every number, one row per day, metric and thing measured. `scope` is the keyword, 'City | keyword', the
-- competitor's domain or a label, and '' for the site as a whole.
create table public.seo_metrics (
  metric_date date not null,
  metric text not null check (length(metric) between 1 and 80),
  scope text not null default '' check (length(scope) <= 300),
  value numeric,
  detail jsonb,
  source text not null check (length(source) between 1 and 80),
  updated_at timestamptz not null default now(),
  primary key (metric_date, metric, scope)
);
create index seo_metrics_metric_date_idx on public.seo_metrics (metric, metric_date desc);

-- The money keywords and the competitors we follow.
create table public.seo_watchlist (
  kind text not null check (kind in ('keyword', 'competitor')),
  entry_key text not null check (length(entry_key) between 1 and 300),
  label text not null check (length(label) between 1 and 300),
  note text,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (kind, entry_key)
);

-- The 30/60-day vision board.
create table public.seo_plan_items (
  id text primary key check (length(id) between 1 and 40),
  window_key text not null check (window_key in ('d30', 'd60')),
  title text not null check (length(title) between 1 and 500),
  who text not null check (length(who) <= 200),
  due_date date,
  status text not null check (status in ('done', 'started', 'waiting_owner', 'not_started')),
  evidence text not null default '' check (length(evidence) <= 1000),
  updated_at timestamptz not null default now()
);

-- One row per Monday review.
create table public.seo_reviews (
  review_date date primary key,
  verdict text not null check (verdict in ('on_track', 'watch', 'off_track', 'none')),
  items_due integer check (items_due >= 0),
  items_done integer check (items_done >= 0),
  numbers_on_target integer check (numbers_on_target between 0 and 5),
  summary text not null default '' check (length(summary) <= 4000),
  detail jsonb,
  updated_at timestamptz not null default now()
);

-- What was done, what was found, what was decided, and strategy changes waiting for an answer.
create table public.seo_log (
  id text primary key check (length(id) between 1 and 200),
  kind text not null check (kind in ('work', 'finding', 'decision', 'proposal')),
  log_date date not null,
  title text not null check (length(title) between 1 and 1000),
  body text not null default '' check (length(body) <= 4000),
  before_value text check (length(before_value) <= 500),
  after_value text check (length(after_value) <= 500),
  source text not null default '' check (length(source) <= 200),
  updated_at timestamptz not null default now()
);
create index seo_log_kind_date_idx on public.seo_log (kind, log_date desc);

-- One row per scheduled task per day, so a task that stopped or never ran is visible.
create table public.seo_feed_runs (
  feed text not null check (feed in ('daily_numbers', 'city_check', 'ahrefs_research', 'monday_review')),
  run_date date not null,
  status text not null check (status in ('ok', 'partial', 'blocked', 'logged_out', 'failed')),
  message text not null default '' check (length(message) <= 500),
  row_count integer not null default 0 check (row_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (feed, run_date)
);

do $$
declare t text;
begin
  foreach t in array array['seo_metrics', 'seo_watchlist', 'seo_plan_items', 'seo_reviews', 'seo_log', 'seo_feed_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.module_entry_open(''seo''))', t || '_read', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['seo_metrics', 'seo_watchlist', 'seo_plan_items', 'seo_reviews', 'seo_log', 'seo_feed_runs'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'SEO_TABLES: % has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'SEO_TABLES: anon can read %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
      or has_table_privilege('authenticated', 'public.' || t, 'update')
      or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'SEO_TABLES: a browser could write to %', t;
    end if;
  end loop;
end $$;

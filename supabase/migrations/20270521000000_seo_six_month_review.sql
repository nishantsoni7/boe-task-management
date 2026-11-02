-- 20270521000000_seo_six_month_review.sql
--
-- The rolling 6-month review and the private discussion brief. Each is one JSON document a period, written by the
-- scheduled sessions on the owner's PC and sent to POST /api/integrations/seo/ingest, which checks its shape and writes
-- here with the service role. The screens only read.
--
-- No data is seeded here: the repository is public, and SEO figures do not belong in it.
-- The brief is about a named role, so it has its own table with its own Admin-only policy: holding SEO `view` does
-- not open it. Pay and role cost never enter either table, and lead data stays counts only.
--
-- READ:  seo_six_month_reviews: a signed-in person with SEO `view` (or Admin), through module_entry_open('seo').
--        seo_discussion_briefs: Admin only.
-- WRITE: the service role only. There is no write policy and no write grant, so a browser cannot write.
--
-- ROLLBACK (nothing else reads these tables):
--   drop table public.seo_discussion_briefs, public.seo_six_month_reviews;

create table public.seo_six_month_reviews (
  period_end date primary key,
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  updated_at timestamptz not null default now()
);

create table public.seo_discussion_briefs (
  period_end date primary key,
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['seo_six_month_reviews', 'seo_discussion_briefs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

create policy seo_six_month_reviews_read on public.seo_six_month_reviews
  for select to authenticated
  using (public.module_entry_open('seo'));

create policy seo_discussion_briefs_read on public.seo_discussion_briefs
  for select to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));

do $$
declare t text;
begin
  foreach t in array array['seo_six_month_reviews', 'seo_discussion_briefs'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'SEO_SIX_MONTH: % has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'SEO_SIX_MONTH: anon can read %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
      or has_table_privilege('authenticated', 'public.' || t, 'update')
      or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'SEO_SIX_MONTH: a browser could write to %', t;
    end if;
  end loop;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'seo_discussion_briefs' and qual ilike '%module_entry_open%'
  ) then
    raise exception 'SEO_SIX_MONTH: the brief must not open with the module';
  end if;
end $$;

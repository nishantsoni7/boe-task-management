-- 20270713000000_clickup_draft_orders.sql
--
-- Draft Orders (ClickUp) — owner, 2026-11-13. The ClickUp subscription is ending, so every order of ClickUp's
-- "Running Orders" list (521: running, ready for dispatch, on hold, cancelled, dispatched) is copied into BOE One
-- as a DRAFT: a place to test and to keep, apart from Confirmed Orders, payments and dispatch. Nothing here creates
-- an Order, a payment or a notification.
--
-- WHAT IT ADDS
--   * public.clickup_draft_orders — one row per ClickUp task: the client / order fields (jsonb, name -> text), the
--     description, checklists, status history, the comments (jsonb array) and the files (jsonb array: name, upload
--     date, uploader, size, sha256, storage path). Comments and files live in the row because they are only ever read
--     with their order. Re-importing the same ClickUp task id replaces the row (unique clickup_id).
--   * Storage bucket clickup-draft-files (private). Objects sit under <clickup task id>/<file id><ext>.
--
-- WHO MAY USE IT — nobody through the database. The table has row-level security ON and NO policy, and the bucket has
-- NO policy on storage.objects, so the browser, anon and authenticated can read and write neither. Every read and
-- write goes through /api/orders/clickup-drafts/*, which asks for the Admin role first and then uses the service role
-- (the same closed-table pattern as Customize image learning, 20270420000000).
--
-- WRITE: creates one new table and one new bucket. No existing table, column, function or row is touched.
--   By the owner's backup rule this creates a table, so take the backup first (it is the rollback data for anything
--   else; this migration needs none of its own).
--
-- ROLLBACK (empty the bucket in the dashboard first, then):
--   drop table public.clickup_draft_orders;
--   delete from storage.buckets where id = 'clickup-draft-files';

create table if not exists public.clickup_draft_orders (
  id                  uuid primary key default gen_random_uuid(),
  clickup_id          text not null,
  clickup_custom_id   text,
  order_no            text,
  name                text not null,
  client_name         text not null default '',
  status              text not null default '',
  created_in_clickup  timestamptz,
  updated_in_clickup  timestamptz,
  closed_in_clickup   timestamptz,
  start_date          date,
  due_date            date,
  created_by_name     text not null default '',
  assignees           text[] not null default '{}',
  tags                text[] not null default '{}',
  priority            text not null default '',
  description         text not null default '',
  fields              jsonb not null default '{}'::jsonb,
  checklists          jsonb not null default '[]'::jsonb,
  subtasks            jsonb not null default '[]'::jsonb,
  status_history      jsonb,
  comments            jsonb not null default '[]'::jsonb,
  files               jsonb not null default '[]'::jsonb,
  file_count          integer generated always as (jsonb_array_length(files)) stored,
  comment_count       integer generated always as (jsonb_array_length(comments)) stored,
  imported_at         timestamptz not null default now(),
  imported_by         uuid references public.users(id) on delete set null,
  constraint clickup_draft_orders_clickup_id_key unique (clickup_id),
  constraint clickup_draft_orders_shape check (
        jsonb_typeof(fields) = 'object'
    and jsonb_typeof(checklists) = 'array'
    and jsonb_typeof(subtasks) = 'array'
    and jsonb_typeof(comments) = 'array'
    and jsonb_typeof(files) = 'array'
  )
);

comment on table public.clickup_draft_orders is
  'Orders copied from ClickUp (Running Orders list) as drafts, 2026-11. Closed table: reached only through /api/orders/clickup-drafts (Admin).';

alter table public.clickup_draft_orders enable row level security;
revoke all on public.clickup_draft_orders from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clickup-draft-files', 'clickup-draft-files', false, 52428800, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = null;

-- Self-check: executed on apply, so a wrong state aborts instead of shipping.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.clickup_draft_orders'::regclass) then
    raise exception 'clickup_draft_orders must have row level security on';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'clickup_draft_orders') then
    raise exception 'clickup_draft_orders must have no policy (closed table)';
  end if;
  if exists (select 1 from storage.buckets where id = 'clickup-draft-files' and public) then
    raise exception 'clickup-draft-files must be private';
  end if;
end $$;

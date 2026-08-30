-- Image Editor — private per-user result history with a 7-day retention window.
--
-- WHAT THIS CHANGES
-- -----------------
-- Until now the Image Editor stored nothing: uploads were read into memory,
-- sent to the provider, and the master came back in the response body. Closing
-- the tab lost everything. 20261020000000's header says so, and
-- src/lib/permissions/imageEditor.ts leans on it — see "THE PARENT GATE" below,
-- because that reasoning changes with this migration.
--
-- What is stored is ONE object per generated image: the final normalised PNG
-- master, the thing the employee would otherwise have had to download
-- immediately. The UPLOADED PHOTOGRAPH IS NOT STORED. It never was, and it is
-- not now — BOE's factory photographs are the employee's own working material
-- and nothing here has asked to keep them.
--
-- THE RETENTION RULE
-- ------------------
--   * a result is visible for SEVEN DAYS FROM GENERATION;
--   * a result marked Keep stays visible indefinitely;
--   * a result not kept is deleted, object and row, after those seven days;
--   * the owner may delete their own result at any time.
--
-- `expires_at` is defaulted by the DATABASE, not sent by the application, so
-- the seven days are measured by one clock. The application never writes it.
--
-- Un-keeping restores the ORIGINAL window rather than granting a fresh one:
-- the rule is seven days from generation, and a keep/unkeep cycle is not a way
-- to buy another week. A result un-kept after its window has passed is
-- therefore due for deletion immediately, which the UI states before it acts.
--
-- THE PARENT GATE, WHICH NOW HAS A SURFACE
-- ----------------------------------------
-- 20261020000000 explained at length that the Image Editor could not inherit
-- 20260905000000's RESTRICTIVE module_entry_open() gate because it had no
-- tables. This migration gives it one, and attaches that gate below. The
-- application-level check in imageEditor.ts and in the studio route stays
-- exactly as it is — it guards GENERATION, which spends money and still has no
-- table of its own to gate. The two are complementary, not duplicates.
--
-- NO ADMIN BACK DOOR
-- ------------------
-- Every permissive policy below is `user_id = auth.uid()` with no admin branch.
-- An administrator sees their own results and nobody else's. This is deliberate
-- and is the opposite of the convention used for assets and orders: those are
-- company records, and these are an employee's work in progress. Note that
-- module_entry_open() does contain an admin branch, but it is RESTRICTIVE — it
-- can only ever narrow access, never widen it, so it cannot open another
-- person's row.
--
-- DELIBERATELY NOT HERE
--   No sharing, no admin console, no quota, no change to the provider pipeline,
--   no change to any other module's grants, and no cron entry — the sweep is a
--   Vercel Cron hitting /api/image-editor/cleanup, and lives in vercel.json.

-- ═══ 1. The bucket ══════════════════════════════════════════════════════════
--
-- PRIVATE. Every read is a short-lived signed URL minted by an API route that
-- has already checked ownership; no public URL of a BOE product image is ever
-- constructed. 20260907000000 exists because that lesson was learned the hard
-- way on task attachments.
--
-- PNG only, because that is the only thing the studio route produces: the
-- master is `normaliseSquare`'s output, encoded as PNG. The download converter
-- (/api/image-editor/convert) re-encodes on the way out and stores nothing, so
-- no JPEG or WebP ever reaches this bucket.
--
-- 15 MB: a 1440x1440 lossless PNG of a detailed product runs to several MB, and
-- the source-upload ceiling of 10 MB is not the right bound for the output.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'image-editor-results',
  'image-editor-results',
  false,        -- private: no anonymous read, ever
  15728640,     -- 15 MB (15 × 1024 × 1024)
  array['image/png']
)
on conflict (id) do nothing;

-- ═══ 2. The table ═══════════════════════════════════════════════════════════

create table if not exists public.image_editor_results (
  id                uuid primary key default gen_random_uuid(),

  -- The owner, and the only person who will ever read this row. ON DELETE
  -- CASCADE so removing an employee removes their history with them; the
  -- objects are then swept as orphans by the cleanup route.
  user_id           uuid not null references public.users(id) on delete cascade,

  -- Object key within `image-editor-results`, always '<user_id>/<id>.png'.
  -- The storage policies below parse the first segment, so this shape is
  -- load-bearing and not merely a convention. Never a URL.
  storage_path      text not null unique,

  -- The name of the photograph the employee uploaded, so a row is recognisable
  -- in a list. The photograph itself is NOT stored.
  source_file_name  text not null,

  -- What the preservation gate could establish, carried through unchanged from
  -- the studio route so history cannot claim more than the original response
  -- did. Same two members as VerificationStatus in
  -- src/lib/imageEditor/verification.ts — there is no 'failed', because a
  -- confirmed structural failure is a 422 with no image to store.
  verification      text not null
                      check (verification in ('passed', 'manual_review_required')),

  -- The Keep flag. False means this row lives until expires_at and is then
  -- swept; true means it is kept until the owner says otherwise.
  kept              boolean not null default false,

  created_at        timestamptz not null default now(),

  -- Seven days from generation, set by the database. The application never
  -- writes this column, so the retention window cannot drift with a client
  -- clock or be extended by a caller.
  expires_at        timestamptz not null default (now() + interval '7 days')
);

comment on table public.image_editor_results is
  'Per-user history of generated Image Editor masters. Private to the owner, '
  'including from administrators. Rows not marked kept are deleted with their '
  'storage object seven days after generation by /api/image-editor/cleanup.';

comment on column public.image_editor_results.expires_at is
  'Seven days from generation, defaulted by the database. Ignored while kept is '
  'true. Never written by the application.';

-- Listing: the owner's newest results first, which is the only read the API
-- makes.
create index if not exists image_editor_results_user_created_idx
  on public.image_editor_results (user_id, created_at desc);

-- The sweep: only ever looks for unkept rows that are past their window, so the
-- index carries the predicate and stays small.
create index if not exists image_editor_results_due_idx
  on public.image_editor_results (expires_at)
  where kept = false;

-- ═══ 3. Row-level security ══════════════════════════════════════════════════

alter table public.image_editor_results enable row level security;

-- ── Permissive: the owner, and nobody else ──────────────────────────────────
--
-- Four separate policies rather than one FOR ALL, so that each command's rule
-- is legible on its own and a later widening of one cannot silently widen the
-- others.

drop policy if exists image_editor_results_select_own on public.image_editor_results;
create policy image_editor_results_select_own
  on public.image_editor_results
  for select to authenticated
  using (user_id = auth.uid());

-- WITH CHECK only: an INSERT has no existing row to test. A caller cannot
-- insert a row owned by somebody else.
drop policy if exists image_editor_results_insert_own on public.image_editor_results;
create policy image_editor_results_insert_own
  on public.image_editor_results
  for insert to authenticated
  with check (user_id = auth.uid());

-- Both clauses: USING picks the rows that may be updated, WITH CHECK stops the
-- update from handing the row to somebody else. Only `kept` is ever changed by
-- the application, and expires_at is never written at all.
drop policy if exists image_editor_results_update_own on public.image_editor_results;
create policy image_editor_results_update_own
  on public.image_editor_results
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists image_editor_results_delete_own on public.image_editor_results;
create policy image_editor_results_delete_own
  on public.image_editor_results
  for delete to authenticated
  using (user_id = auth.uid());

-- ── Restrictive: module entry, the house gate ───────────────────────────────
--
-- AND-ed with all four policies above. Someone whose `image_editor:view` is
-- revoked loses their history at the database, not merely in the UI, and
-- regains it if the grant returns. This is the gate 20261020000000 could not
-- attach for want of a table.

drop policy if exists image_editor_results_module_entry_gate on public.image_editor_results;
create policy image_editor_results_module_entry_gate
  on public.image_editor_results
  as restrictive for all to authenticated
  using (public.module_entry_open('image_editor'))
  with check (public.module_entry_open('image_editor'));

-- ═══ 4. Storage policies ════════════════════════════════════════════════════
--
-- The object key is '<user_id>/<result_id>.png', so the first path segment IS
-- the owner. `split_part(name, '/', 1)` is the same technique
-- 20260711000000 uses for order-request attachments.
--
-- These are a second, independent lock: the API routes act with the service
-- role and therefore bypass RLS entirely, so these policies are what protects
-- an object if a signed URL is ever minted by anything else, or if a client
-- reaches the bucket directly with its own token.

drop policy if exists image_editor_results_storage_select on storage.objects;
create policy image_editor_results_storage_select
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'image-editor-results'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists image_editor_results_storage_insert on storage.objects;
create policy image_editor_results_storage_insert
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'image-editor-results'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists image_editor_results_storage_delete on storage.objects;
create policy image_editor_results_storage_delete
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'image-editor-results'
    and split_part(name, '/', 1) = auth.uid()::text
  );

-- No UPDATE policy on storage.objects. A generated master is written once and
-- never edited; a re-generation is a new row with a new id and a new object.

-- ═══ 5. Assertions ══════════════════════════════════════════════════════════
--
-- Read-only, and they fail the migration rather than leave a half-applied
-- state that looks fine until somebody reads somebody else's picture.

do $$
declare
  v_missing text;
  v_public  boolean;
begin
  -- The bucket exists and is private. A public bucket here would expose every
  -- generated product image to anyone who could guess a uuid, which is the
  -- single worst outcome this migration could produce.
  select public into v_public from storage.buckets where id = 'image-editor-results';
  if v_public is null then
    raise exception 'image-editor-results bucket was not created';
  end if;
  if v_public then
    raise exception 'image-editor-results bucket is PUBLIC — refusing to leave it readable';
  end if;

  -- Row-level security is actually on. A table with policies but RLS disabled
  -- reads as protected and is not.
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'image_editor_results' and c.relrowsecurity
  ) then
    raise exception 'row-level security is not enabled on image_editor_results';
  end if;

  -- All five table policies, including the restrictive gate.
  select string_agg(p, ', ') into v_missing
  from unnest(array[
    'image_editor_results_select_own',
    'image_editor_results_insert_own',
    'image_editor_results_update_own',
    'image_editor_results_delete_own',
    'image_editor_results_module_entry_gate'
  ]) as p
  where not exists (
    select 1 from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'image_editor_results' and pol.polname = p
  );
  if v_missing is not null then
    raise exception 'missing policies on image_editor_results: %', v_missing;
  end if;

  -- The gate is RESTRICTIVE. If it were permissive it would GRANT entry to
  -- every authenticated user rather than requiring it, which is the exact
  -- inversion of what it is for.
  if not exists (
    select 1 from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'image_editor_results'
      and pol.polname = 'image_editor_results_module_entry_gate'
      and pol.polpermissive = false
  ) then
    raise exception 'image_editor_results_module_entry_gate is not RESTRICTIVE';
  end if;

  -- The three storage policies.
  select string_agg(p, ', ') into v_missing
  from unnest(array[
    'image_editor_results_storage_select',
    'image_editor_results_storage_insert',
    'image_editor_results_storage_delete'
  ]) as p
  where not exists (
    select 1 from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects' and pol.polname = p
  );
  if v_missing is not null then
    raise exception 'missing storage policies: %', v_missing;
  end if;

  -- The retention default is SEVEN days, read off the column itself rather
  -- than assumed. A wrong default here would silently delete an employee's
  -- work early, or keep it for ever — and neither would be visible until it
  -- had already happened.
  if not exists (
    select 1
    from pg_attrdef ad
    join pg_class c on c.oid = ad.adrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = ad.adnum
    where n.nspname = 'public'
      and c.relname = 'image_editor_results'
      and a.attname = 'expires_at'
      and pg_get_expr(ad.adbin, ad.adrelid) like '%7 days%'
  ) then
    raise exception
      'image_editor_results.expires_at does not default to seven days — refusing to '
      'leave the retention window undefined';
  end if;
end $$;

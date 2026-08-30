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
-- Expiry is enforced by the POLICIES, not only by the listing query: both
-- SELECT rules — on the table and on the object — require
-- `kept or expires_at > now()`. An expired result is therefore unreadable and
-- undownloadable the moment its window passes, with the caller's own token,
-- whether or not the nightly sweep has reclaimed the bytes yet.
--
-- Keep, Unkeep and Delete are UPDATE and DELETE and are left on ownership
-- alone. What that does NOT mean is that a client holding a user token can
-- still reach an expired row: PostgreSQL applies the SELECT policy to any
-- statement that reads the row (a WHERE clause does), and refuses an UPDATE
-- whose resulting row would fail it — so with a user's own token an expired
-- unkept row cannot be found, and unkeeping an expired KEPT row is refused
-- outright. Both were measured, not assumed; see
-- supabase/tests/image_editor_result_history_assertions.sql.
--
-- The application does none of it that way. Keep, Unkeep, Delete and the sweep
-- all go through API routes acting with the SERVICE ROLE, which bypasses RLS
-- entirely, so every one of those operations behaves exactly as it did before
-- this condition existed. What the condition removes is a direct client's
-- ability to touch material it is no longer allowed to see.
--
-- WHEN AN EMPLOYEE IS DELETED
-- ---------------------------
-- The owner reference is ON DELETE RESTRICT and the reason is written out at
-- the column. In short: the row is the only record of where the object is, so
-- deleting it first orphans the bytes for ever. The permanent-delete route
-- empties the history first and the database refuses the delete if anything is
-- left.
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

  -- The owner, and the only person who will ever read this row.
  --
  -- ON DELETE RESTRICT, NOT CASCADE, AND THE REASON MATTERS
  -- ------------------------------------------------------
  -- This row is the ONLY record of where its storage object lives. A CASCADE
  -- would delete it the instant the employee was removed and leave the object
  -- behind: no row means no `storage_path`, and the sweep below only ever
  -- looks at rows, so nothing would ever find those bytes again. They would sit
  -- in a private bucket for ever, paid for and unreachable — the exact
  -- unrecoverable case history.ts refuses to create by deleting the object
  -- first.
  --
  -- So the database REFUSES to delete an employee who still has results. The
  -- one application path that removes a person permanently
  -- (POST /api/permanently-delete-user) empties this history first — object
  -- then row, plus any leftover object under the employee's prefix — and only
  -- deletes the user once that has verifiably succeeded. If it did not, the
  -- delete stops with the rows intact and the administrator can retry, which is
  -- recoverable in a way an orphan is not.
  --
  -- The RESTRICT is what makes that guarantee independent of any one route: a
  -- future route, a script, or somebody deleting the auth user by hand gets a
  -- loud foreign-key error instead of a silent bucket leak.
  user_id           uuid not null references public.users(id) on delete restrict,

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

-- `create table if not exists` above does nothing on a table that is already
-- there, so the delete action is stated again for a database that received an
-- earlier version of this file. Dropping and re-adding is the only way to
-- change ON DELETE, and both statements are safe to re-run.

do $$
begin
  if exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'image_editor_results'
      and con.conname = 'image_editor_results_user_id_fkey'
      and con.confdeltype <> 'r'
  ) then
    alter table public.image_editor_results
      drop constraint image_editor_results_user_id_fkey;
  end if;

  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'image_editor_results'
      and con.conname = 'image_editor_results_user_id_fkey'
  ) then
    alter table public.image_editor_results
      add constraint image_editor_results_user_id_fkey
      foreign key (user_id) references public.users(id) on delete restrict;
  end if;
end $$;

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

-- SELECT carries the RETENTION RULE as well as the ownership rule. The listing
-- route filters `kept OR expires_at > now()` too, but that route is one caller:
-- a client with its own token reaching the table directly would otherwise read
-- rows whose seven days have passed, and an expired result is one the employee
-- was told no longer exists. Enforcing it here makes the window true of the
-- TABLE rather than true of one query, and it holds whether or not the sweep
-- has run.
--
-- `kept` disables the countdown entirely — a kept row is readable however old,
-- which is what Keep means — and un-keeping restores the original window, so an
-- expired row disappears again the moment it is unkept.
--
-- WHAT THIS DOES TO UPDATE AND DELETE, WHICH IS NOT NOTHING
-- ---------------------------------------------------------
-- Those policies are unchanged and stay on ownership alone, but a SELECT rule
-- is not confined to SELECT: PostgreSQL applies it to any statement that has to
-- READ the row, which every `where id = …` does. Measured behaviour with a
-- user's own token, once this condition is in place:
--
--   * an expired UNKEPT row cannot be found to update or delete — 0 rows;
--   * unkeeping an expired KEPT row is REFUSED, because the resulting row would
--     no longer be visible;
--   * everything unexpired or kept behaves exactly as before.
--
-- That is acceptable here only because the application never does any of this
-- with a user token. Keep, Unkeep, the owner's Delete and the nightly sweep all
-- run in API routes holding the SERVICE ROLE, which bypasses row-level security,
-- so the product behaviour — including "unkeeping an expired result deletes it"
-- — is unchanged. The same suite that measured the refusals above proves the
-- service-role path still works.
drop policy if exists image_editor_results_select_own on public.image_editor_results;
create policy image_editor_results_select_own
  on public.image_editor_results
  for select to authenticated
  using (
    user_id = auth.uid()
    and (kept or expires_at > now())
  );

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

-- SELECT is the download, so it carries the RETENTION RULE too. Ownership alone
-- would let the owner fetch the bytes of a result whose window has passed —
-- directly, with their own token, after the listing had stopped showing it and
-- before the nightly sweep reclaimed it. The object is looked up by its key,
-- which IS `image_editor_results.storage_path`, and the same
-- `kept or expires_at > now()` decides.
--
-- The row lookup runs under the reader's own privileges, so the policies above
-- apply to it as well: no cross-user read can be smuggled in through this
-- subquery, and losing module entry closes this door with the others.
--
-- INSERT and DELETE below stay on ownership alone, and the sweep deletes with
-- the service role, so an expired object is always reclaimable. With a USER
-- token the same reading rule applies as on the table: an object whose row is no
-- longer visible cannot be found by a `where name = …`, so a client cannot
-- delete it either. Nothing in the application deletes an object with a user
-- token — the routes hold the service role — so this costs the product nothing.
drop policy if exists image_editor_results_storage_select on storage.objects;
create policy image_editor_results_storage_select
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'image-editor-results'
    and split_part(name, '/', 1) = auth.uid()::text
    and exists (
      select 1
      from public.image_editor_results r
      where r.storage_path = storage.objects.name
        and r.user_id = auth.uid()
        and (r.kept or r.expires_at > now())
    )
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

  -- The owner reference RESTRICTS. A CASCADE here would delete the rows that
  -- carry every storage_path the moment an employee was removed, orphaning
  -- their objects permanently — see the column comment above. Read off
  -- pg_constraint rather than trusted, because `create table if not exists`
  -- silently keeps whatever an earlier run left behind.
  if not exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'image_editor_results'
      and con.contype = 'f'
      and con.conname = 'image_editor_results_user_id_fkey'
      and con.confdeltype = 'r'
  ) then
    raise exception
      'image_editor_results.user_id does not RESTRICT on delete — refusing to leave '
      'a cascade that would orphan every storage object of a deleted employee';
  end if;

  -- Both SELECT rules carry the retention window as well as the owner. A policy
  -- that checked ownership alone would let the owner read — and download — a
  -- result whose seven days have passed, which is the one thing the listing
  -- route already refuses to show them. Checked by reading the stored
  -- expression, so a later edit that drops the condition fails the migration
  -- rather than quietly widening it.
  if not exists (
    select 1 from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'image_editor_results'
      and pol.polname = 'image_editor_results_select_own'
      and pg_get_expr(pol.polqual, pol.polrelid) like '%expires_at%'
      and pg_get_expr(pol.polqual, pol.polrelid) like '%kept%'
  ) then
    raise exception
      'image_editor_results_select_own does not enforce (kept or expires_at > now())';
  end if;

  if not exists (
    select 1 from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage' and c.relname = 'objects'
      and pol.polname = 'image_editor_results_storage_select'
      and pg_get_expr(pol.polqual, pol.polrelid) like '%expires_at%'
      and pg_get_expr(pol.polqual, pol.polrelid) like '%kept%'
  ) then
    raise exception
      'image_editor_results_storage_select does not enforce (kept or expires_at > now()) — '
      'an expired object would still be downloadable directly';
  end if;
end $$;

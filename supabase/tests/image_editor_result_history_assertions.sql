-- What 20261021000000 actually does, asked of a running PostgreSQL.
--
-- Every check below is a real query by a real role with a real JWT claim, under
-- the migration's own policies. Nothing here reads the migration's text: the
-- question is whether an expired result is READABLE, not whether a word appears
-- in a file.
--
-- Run by run_image_editor_result_history_suite.sh, after the fixture and the
-- migration. Fails loudly on the first wrong answer.

\set ON_ERROR_STOP on
\set A '11111111-1111-4111-8111-111111111111'
\set B '22222222-2222-4222-8222-222222222222'

-- ── A tiny assertion helper ──────────────────────────────────────────────────
-- The count is computed by the CALLER, in the caller's own session and role, so
-- row-level security applies to it. Passing the query in would run it as the
-- function's owner and prove nothing.
create or replace function public.assert_eq(actual bigint, expected bigint, what text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAILED: % — expected %, got %', what, expected, actual;
  end if;
  raise notice 'ok: %', what;
end $$;

-- ── Fixtures, written as the owner so RLS does not shape the setup ───────────
insert into public.users (id, email, full_name, role) values
  (:'A', 'a@boe.test', 'Owner A', 'member'),
  (:'B', 'b@boe.test', 'Other B', 'member');

-- Four results for A and one for B. expires_at is normally the database's own
-- default; it is written directly here because a test cannot wait seven days,
-- and it is the only place in this repository that writes it.
insert into public.image_editor_results
  (id, user_id, storage_path, source_file_name, verification, kept, created_at, expires_at)
values
  ('aaaa0001-0000-4000-8000-000000000001', :'A', :'A' || '/aaaa0001-0000-4000-8000-000000000001.png',
   'fresh.jpg',  'passed', false, now(), now() + interval '7 days'),
  ('aaaa0002-0000-4000-8000-000000000002', :'A', :'A' || '/aaaa0002-0000-4000-8000-000000000002.png',
   'stale.jpg',  'passed', false, now() - interval '8 days', now() - interval '1 day'),
  ('aaaa0003-0000-4000-8000-000000000003', :'A', :'A' || '/aaaa0003-0000-4000-8000-000000000003.png',
   'keeper.jpg', 'passed', true,  now() - interval '9 days', now() - interval '2 days'),
  ('aaaa0004-0000-4000-8000-000000000004', :'A', :'A' || '/aaaa0004-0000-4000-8000-000000000004.png',
   'doomed.jpg', 'manual_review_required', false, now() - interval '8 days', now() - interval '1 day'),
  ('bbbb0001-0000-4000-8000-000000000001', :'B', :'B' || '/bbbb0001-0000-4000-8000-000000000001.png',
   'b-fresh.jpg', 'passed', false, now(), now() + interval '7 days');

insert into storage.objects (bucket_id, name)
select 'image-editor-results', storage_path from public.image_editor_results;

-- ═══ 10. The bucket ═════════════════════════════════════════════════════════
-- First, because everything else assumes it exists.
select public.assert_eq(
  (select count(*) from storage.buckets
    where id = 'image-editor-results' and public = false
      and allowed_mime_types = array['image/png'] and file_size_limit = 15728640),
  1, '10. the bucket is private, PNG-only and capped at 15 MB');

-- ═══ As owner A ═════════════════════════════════════════════════════════════
set role authenticated;
select set_config('request.jwt.claim.sub', :'A', false);

-- ═══ 1. An unexpired result is readable by its owner ════════════════════════
select public.assert_eq(
  (select count(*) from public.image_editor_results
    where id = 'aaaa0001-0000-4000-8000-000000000001'),
  1, '1. owner A can SELECT an unexpired result');

-- ═══ 3. An EXPIRED, UNKEPT result is not ════════════════════════════════════
select public.assert_eq(
  (select count(*) from public.image_editor_results
    where id = 'aaaa0002-0000-4000-8000-000000000002'),
  0, '3. owner A cannot SELECT their own expired unkept result');

-- ═══ 4. An expired KEPT result is ═══════════════════════════════════════════
select public.assert_eq(
  (select count(*) from public.image_editor_results
    where id = 'aaaa0003-0000-4000-8000-000000000003'),
  1, '4. owner A can SELECT an expired kept result');

-- And the whole listing agrees: two of A's four rows, never five.
select public.assert_eq(
  (select count(*) from public.image_editor_results),
  2, '1/3/4. A sees exactly the fresh one and the kept one');

-- ═══ 5. The expired unkept OBJECT cannot be downloaded ══════════════════════
-- A direct read of storage.objects is what a client with its own token does;
-- the policy is the only thing standing in the way.
select public.assert_eq(
  (select count(*) from storage.objects
    where name = :'A' || '/aaaa0002-0000-4000-8000-000000000002.png'),
  0, '5. owner A cannot read the expired unkept object');

-- ═══ 6. The expired KEPT object can ═════════════════════════════════════════
select public.assert_eq(
  (select count(*) from storage.objects
    where name = :'A' || '/aaaa0003-0000-4000-8000-000000000003.png'),
  1, '6. owner A can read the expired kept object');

select public.assert_eq(
  (select count(*) from storage.objects),
  2, '5/6. and A sees exactly two objects, not four and not five');

-- ═══ 7. What UPDATE and DELETE actually do, with a user's own token ════════
-- The UPDATE and DELETE policies are ownership-only and unchanged. But a SELECT
-- rule is not confined to SELECT: PostgreSQL applies it to any statement that
-- must READ the row, and refuses an UPDATE whose resulting row would fail it.
-- These are the measured consequences, asserted rather than assumed — and the
-- reason the application does all of this with the service role instead (§9).

do $$
declare n int;
begin
  -- Keep and Unkeep on an UNEXPIRED result: untouched, both directions.
  update public.image_editor_results set kept = true
    where id = 'aaaa0001-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: 7. an unexpired result could not be KEPT (% rows)', n; end if;

  update public.image_editor_results set kept = false
    where id = 'aaaa0001-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: 7. an unexpired result could not be UNKEPT (% rows)', n; end if;
  raise notice 'ok: 7a. Keep and Unkeep work normally on an unexpired result';
end $$;

do $$
declare n int;
begin
  -- The owner deletes an unexpired result of their own: object then row, the
  -- order every deletion in this feature uses.
  delete from storage.objects
    where name = '11111111-1111-4111-8111-111111111111/aaaa0001-0000-4000-8000-000000000001.png';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: 7. the owner could not delete their own OBJECT (% rows)', n; end if;

  delete from public.image_editor_results where id = 'aaaa0001-0000-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: 7. the owner could not delete their own ROW (% rows)', n; end if;
  raise notice 'ok: 7b. the owner can delete their own result, object and row';
end $$;

do $$
declare n int;
begin
  -- An expired UNKEPT result cannot be reached at all: the WHERE clause has to
  -- read the row, and the SELECT policy hides it.
  delete from public.image_editor_results where id = 'aaaa0004-0000-4000-8000-000000000004';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: 7. an expired unkept row was reachable by its owner (% rows)', n; end if;
  raise notice 'ok: 7c. an expired UNKEPT row cannot be found by its owner''s own token';
end $$;

do $$
declare n int;
begin
  update public.image_editor_results set kept = true
    where id = 'aaaa0002-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: 7. an expired unkept row was updatable by its owner (% rows)', n; end if;
  raise notice 'ok: 7d. nor kept by it';
end $$;

do $$
begin
  -- Unkeeping an expired KEPT row would produce a row the owner may not see, and
  -- PostgreSQL refuses it rather than returning zero. This is the one behaviour
  -- the narrowed SELECT policy CHANGES for a direct client, so it is asserted
  -- exactly, not glossed: the application does this through the service role
  -- (§9 below) and is unaffected.
  update public.image_editor_results set kept = false
    where id = 'aaaa0003-0000-4000-8000-000000000003';
  raise exception 'FAILED: 7. unkeeping an expired kept row was allowed with a user token';
exception
  when insufficient_privilege then
    raise notice 'ok: 7e. unkeeping an EXPIRED kept row is refused with a user token, by design';
end $$;

-- ═══ The restrictive module-entry gate, which is AND-ed with all of it ══════
select set_config('boe.module_entry_open', 'false', false);
select public.assert_eq(
  (select count(*) from public.image_editor_results),
  0, 'gate. losing module entry closes the history at the database');
select public.assert_eq(
  (select count(*) from storage.objects),
  0, 'gate. and the objects with it');
select set_config('boe.module_entry_open', 'true', false);

-- ═══ 2. User B sees nothing of A's ══════════════════════════════════════════
select set_config('request.jwt.claim.sub', :'B', false);

select public.assert_eq(
  (select count(*) from public.image_editor_results where user_id = :'A'),
  0, '2. user B cannot SELECT any of A''s results');

select public.assert_eq(
  (select count(*) from storage.objects where name like :'A' || '/%'),
  0, '2. nor read any of A''s objects');

select public.assert_eq(
  (select count(*) from public.image_editor_results),
  1, '2. B sees their own row and only their own');

-- B cannot delete or update A's row either, expired or not.
do $$
declare n int;
begin
  update public.image_editor_results set kept = true
    where id = 'aaaa0003-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: 2. B updated one of A''s rows (% rows)', n; end if;

  delete from public.image_editor_results where id = 'aaaa0003-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: 2. B deleted one of A''s rows (% rows)', n; end if;
  raise notice 'ok: 2. and B can neither keep nor delete A''s work';
end $$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ═══ 8. A member with results left cannot be deleted ════════════════════════
-- The whole reason the reference RESTRICTS: a cascade would take the rows that
-- carry every storage_path and orphan the objects for ever.
do $$
begin
  delete from public.users where id = '11111111-1111-4111-8111-111111111111';
  raise exception 'FAILED: 8. a member with Image Editor results was deleted — the objects are now orphans';
exception
  when foreign_key_violation then
    raise notice 'ok: 8. deleting a member with results is refused by the RESTRICT';
end $$;

-- ═══ 9. The service role sweeps an expired unkept result ════════════════════
-- The cleanup route acts with this role, which BYPASSES row-level security —
-- which is why it can see the expired row the owner cannot, and why every route
-- filters ownership in code.
set role service_role;

select public.assert_eq(
  (select count(*) from public.image_editor_results
    where kept = false and expires_at <= now()),
  2, '9. the sweep sees both due results — the ones their own owner cannot');

do $$
declare n int;
begin
  -- Object first, then row — the order the cleanup route uses, for the reason
  -- written at the top of src/lib/imageEditor/history.ts.
  delete from storage.objects
    where name in (
      '11111111-1111-4111-8111-111111111111/aaaa0002-0000-4000-8000-000000000002.png',
      '11111111-1111-4111-8111-111111111111/aaaa0004-0000-4000-8000-000000000004.png');
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'FAILED: 9. the sweep could not delete the OBJECTS (% rows)', n; end if;

  delete from public.image_editor_results where kept = false and expires_at <= now();
  get diagnostics n = row_count;
  if n <> 2 then raise exception 'FAILED: 9. the sweep could not delete the ROWS (% rows)', n; end if;
  raise notice 'ok: 9a. the service role deletes every expired unkept object and row';
end $$;

select public.assert_eq(
  (select count(*) from public.image_editor_results where user_id = '11111111-1111-4111-8111-111111111111'),
  1, '9. and leaves the kept result alone');

-- The application's own Keep/Unkeep path. PATCH /api/image-editor/results/[id]
-- holds this role, so the operation 7e refuses with a user token is exactly the
-- operation the product performs — unchanged by the narrowed SELECT policy.
do $$
declare n int;
begin
  update public.image_editor_results set kept = false
    where id = 'aaaa0003-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: 9. the service role could not unkeep an expired kept result (% rows)', n; end if;
  raise notice 'ok: 9b. and unkeeps an expired kept result, which is what the PATCH route does';
end $$;

reset role;

-- ═══ 8 again, from the other side ═══════════════════════════════════════════
-- With the history emptied — which is what the permanent-delete route does
-- before it touches anything else — the same delete succeeds.
delete from public.image_editor_results where user_id = '11111111-1111-4111-8111-111111111111';
delete from public.users where id = '11111111-1111-4111-8111-111111111111';
select public.assert_eq(
  (select count(*) from public.users where id = '11111111-1111-4111-8111-111111111111'),
  0, '8. and once the history is empty the member deletes normally');

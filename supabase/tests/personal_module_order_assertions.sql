-- ═════════════════════════════════════════════════════════════════════════════
-- BEHAVIOURAL ASSERTIONS — 20261228000000_personal_module_order.sql, executed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS. src/lib/modules/moduleOrderStorage.test.ts reads the
-- migration's TEXT and checks that it SAYS the right things. That is worth
-- having and it is not enough: a policy can be present and wrong, a `using`
-- clause can be missing its `with check` half and still look complete, and a
-- CHECK constraint can pass every row somebody thought of. This runs the real
-- objects, as two real signed-in accounts, and proves what they do.
--
-- WHAT IT PROVES, IN ORDER
-- ------------------------
--   §1  two people, two orders      each account stores its own list and reads
--                                   back exactly that list
--   §2  no cross-account read       B asking for A's row gets nothing — not an
--                                   error, NOTHING, which is what RLS does
--   §3  no cross-account write      B's UPDATE of A's row touches zero rows;
--                                   B's INSERT against A's id is refused
--   §4  no row handover             B cannot rewrite user_id to A's — the half
--                                   a `using`-only update policy would miss
--   §5  no destructive door         nobody can DELETE a preference, because no
--                                   policy and no grant permits it
--   §6  the shape constraint bites  duplicates, wrong case, nulls, the empty
--                                   string, punctuation, over-length and a
--                                   two-dimensional array are all refused
--   §7  anon gets nothing           and it is a REVOKE that did it: the
--                                   baseline grants anon everything on new
--                                   tables first (bootstrap/009), so this
--                                   cannot pass for the wrong reason
--   §8  A's order is untouched      after every attempt in §2–§5
--   §9  updated_at is the server's  the trigger overwrites whatever was sent
--  §10  it grants nothing           the table references no module, no
--                                   permission and no business record, and
--                                   nothing else in the schema reads it
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. It creates its own two fictional accounts and refuses to run if
-- auth.users already holds anybody.
--
-- ⚠ NOT RUN AGAINST PRODUCTION. Run only through
--   run_personal_module_order_local.sh, which builds a disposable database and
--   applies the migration first.
--
-- Every policy under test reads auth.uid(), so the script simulates a session
-- with request.jwt.claims and SET ROLE rather than a real login — the idiom
-- boe_credits_assertions.sql and the Review Workflow scripts use.
--
-- On success it prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back.

\set ON_ERROR_STOP on

begin;

-- ─── helpers ─────────────────────────────────────────────────────────────────

-- Become one signed-in person, the way PostgREST would present them.
create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function pg_temp.act_as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

-- Back to the owner: no claims, no role.
create or replace function pg_temp.act_as_owner()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'none', true);
end $$;

-- Run a statement and REQUIRE it to fail with an exact SQLSTATE. "It errored"
-- is compatible with a typo in the test, so the state is named.
create or replace function pg_temp.must_refuse(
  p_sql text, p_sqlstate text, p_label text
)
returns void language plpgsql as $$
declare
  v_state text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception '% — refused, but with SQLSTATE % not %: %', p_label, v_state, p_sqlstate, v_msg;
    end if;
    raise notice 'PASS  % (%)', p_label, v_state;
    return;
  end;
  raise exception '% — WAS ALLOWED, and must not be', p_label;
end $$;

-- ─── fixtures ────────────────────────────────────────────────────────────────

do $$
begin
  if (select count(*) from auth.users) <> 0 then
    raise exception 'REFUSING TO RUN: auth.users is not empty — this is not a disposable database';
  end if;
  if (select count(*) from public.user_module_order) <> 0 then
    raise exception 'REFUSING TO RUN: public.user_module_order already holds rows';
  end if;
end $$;

-- A and B. Two people who work in different modules, which is the entire
-- product requirement.
insert into auth.users (id) values
  ('aaaaaaaa-0000-4000-8000-00000000000a'),
  ('bbbbbbbb-0000-4000-8000-00000000000b');

-- ─── §1. Two people, two orders ──────────────────────────────────────────────

do $$
declare
  v_a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  v_b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
  v_keys text[];
begin
  -- A lives in Orders and Finance.
  perform pg_temp.act_as(v_a);
  insert into public.user_module_order (user_id, module_keys)
    values (v_a, array['orders', 'finance', 'tasks']);
  select module_keys into v_keys from public.user_module_order;
  assert v_keys = array['orders', 'finance', 'tasks'],
    format('§1 A read back %s', v_keys);
  assert (select count(*) from public.user_module_order) = 1,
    '§1 A can see more than one row';

  -- B lives in Meetings, and saving it does not disturb A.
  perform pg_temp.act_as(v_b);
  insert into public.user_module_order (user_id, module_keys)
    values (v_b, array['meetings', 'tasks']);
  select module_keys into v_keys from public.user_module_order;
  assert v_keys = array['meetings', 'tasks'],
    format('§1 B read back %s', v_keys);
  assert (select count(*) from public.user_module_order) = 1,
    '§1 B can see more than one row';

  raise notice 'PASS  §1 two accounts hold two different orders, each reading only its own';
end $$;

-- ─── §2. B cannot read A's row ───────────────────────────────────────────────
--
-- NOT an error: no rows. That is the whole character of a SELECT policy, and a
-- test that accepted an exception here would also accept a table with no policy
-- and no grant.

do $$
declare v_b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
begin
  perform pg_temp.act_as(v_b);
  assert (select count(*) from public.user_module_order
           where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a') = 0,
    '§2 B can see A''s preference row';
  assert (select count(*) from public.user_module_order) = 1,
    '§2 B sees somebody else''s row in an unfiltered select';
  raise notice 'PASS  §2 an unfiltered select returns one row — the caller''s own';
end $$;

-- ─── §3. B cannot write A's row ──────────────────────────────────────────────

do $$
declare
  v_a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  v_rows int;
begin
  perform pg_temp.act_as('bbbbbbbb-0000-4000-8000-00000000000b');
  update public.user_module_order set module_keys = array['control_center']
   where user_id = v_a;
  get diagnostics v_rows = row_count;
  assert v_rows = 0, format('§3 B updated %s of A''s rows', v_rows);
  raise notice 'PASS  §3 B''s update of A''s row touched 0 rows';
end $$;

select pg_temp.must_refuse(
  $q$ insert into public.user_module_order (user_id, module_keys)
      values ('aaaaaaaa-0000-4000-8000-00000000000a', array['control_center']) $q$,
  '42501', '§3 B inserting a row against A''s id');

-- ─── §4. B cannot hand their row to A ────────────────────────────────────────
--
-- The half a `using`-only UPDATE policy would let through: the row B is allowed
-- to update becomes a row belonging to somebody else.

select pg_temp.must_refuse(
  $q$ update public.user_module_order
         set user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '42501', '§4 reassigning user_id to another account');

-- ─── §5. Nobody can delete a preference ──────────────────────────────────────
--
-- Refused by the absence of a GRANT, before RLS is consulted at all — which is
-- stronger than the absence of a policy, and is why the migration revokes by
-- name and grants only three commands back.

select pg_temp.must_refuse(
  $q$ delete from public.user_module_order $q$,
  '42501', '§5 deleting a preference row');

-- ─── §6. The shape constraint bites ──────────────────────────────────────────

do $$
declare v_b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
begin
  perform pg_temp.act_as(v_b);
end $$;

select pg_temp.must_refuse(
  $q$ update public.user_module_order set module_keys = array['tasks', 'tasks']
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '23514', '§6 the same key twice');

select pg_temp.must_refuse(
  $q$ update public.user_module_order set module_keys = array['Orders']
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '23514', '§6 a key that is not lower case');

select pg_temp.must_refuse(
  $q$ update public.user_module_order set module_keys = array['tasks', null]
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '23514', '§6 a null element');

select pg_temp.must_refuse(
  $q$ update public.user_module_order set module_keys = array['']
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '23514', '§6 the empty string');

select pg_temp.must_refuse(
  $q$ update public.user_module_order set module_keys = array['../secrets']
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '23514', '§6 punctuation in a key');

select pg_temp.must_refuse(
  $q$ update public.user_module_order
         set module_keys = (select array_agg('mod_' || g) from generate_series(1, 65) g)
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '23514', '§6 sixty-five keys');

select pg_temp.must_refuse(
  $q$ update public.user_module_order set module_keys = array[['a'],['b']]
       where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' $q$,
  '23514', '§6 a two-dimensional array');

-- And the legitimate ones still go through, so §6 is not vacuous.
do $$
declare v_b uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
begin
  perform pg_temp.act_as(v_b);
  update public.user_module_order set module_keys = array['meetings', 'tasks', 'image_editor']
   where user_id = v_b;
  assert (select module_keys from public.user_module_order) = array['meetings', 'tasks', 'image_editor'],
    '§6 a well-formed list was not stored';
  -- The empty list is allowed: it is "a row exists but asserts no order", which
  -- the reader treats exactly like no row.
  update public.user_module_order set module_keys = '{}' where user_id = v_b;
  assert (select module_keys from public.user_module_order) = '{}'::text[],
    '§6 the empty list was refused';
  update public.user_module_order set module_keys = array['meetings', 'tasks']
   where user_id = v_b;
  raise notice 'PASS  §6 well-formed lists, including the empty one, are stored';
end $$;

-- ─── §7. anon gets nothing, and a REVOKE is what did it ──────────────────────
--
-- bootstrap/009 reproduces production's default privileges, which grant anon
-- every privilege on a newly created public table. So this assertion is about
-- the migration's revoke and cannot pass because a grant was simply never made.

select pg_temp.act_as_anon();

select pg_temp.must_refuse(
  $q$ select count(*) from public.user_module_order $q$,
  '42501', '§7 anon selecting');

select pg_temp.must_refuse(
  $q$ insert into public.user_module_order (user_id, module_keys)
      values ('aaaaaaaa-0000-4000-8000-00000000000a', array['orders']) $q$,
  '42501', '§7 anon inserting');

select pg_temp.must_refuse(
  $q$ update public.user_module_order set module_keys = array['orders'] $q$,
  '42501', '§7 anon updating');

do $$
begin
  -- Said again as a privilege fact, not only as a refusal, so a future grant is
  -- caught even if some other rule happens to refuse the statement.
  assert not has_table_privilege('anon', 'public.user_module_order', 'SELECT'),
    '§7 anon holds SELECT';
  assert not has_table_privilege('anon', 'public.user_module_order', 'INSERT'),
    '§7 anon holds INSERT';
  assert not has_table_privilege('anon', 'public.user_module_order', 'UPDATE'),
    '§7 anon holds UPDATE';
  assert not has_table_privilege('authenticated', 'public.user_module_order', 'DELETE'),
    '§7 authenticated holds DELETE';
  raise notice 'PASS  §7 anon holds nothing, authenticated holds no DELETE';
end $$;

-- ─── §8. A's order survived every one of those attempts ──────────────────────

do $$
declare
  v_a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  v_keys text[];
begin
  perform pg_temp.act_as(v_a);
  select module_keys into v_keys from public.user_module_order;
  assert v_keys = array['orders', 'finance', 'tasks'],
    format('§8 A''s order was changed by somebody else: %s', v_keys);
  raise notice 'PASS  §8 A''s order is exactly what A saved, after every attempt above';
end $$;

-- ─── §9. updated_at belongs to the server ────────────────────────────────────

do $$
declare
  v_a uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
  v_sent timestamptz := '2001-01-01T00:00:00Z';
  v_stored timestamptz;
begin
  perform pg_temp.act_as(v_a);
  update public.user_module_order
     set module_keys = array['finance', 'orders', 'tasks'], updated_at = v_sent
   where user_id = v_a;
  select updated_at into v_stored from public.user_module_order;
  assert v_stored <> v_sent, '§9 the client''s updated_at was stored verbatim';
  assert now() - v_stored < interval '1 minute',
    format('§9 updated_at is not now(): %s', v_stored);
  raise notice 'PASS  §9 the trigger overwrote the timestamp the client sent';
end $$;

-- ─── §10. It grants nothing, and nothing else reads it ───────────────────────
--
-- The property that makes a stored module key inert. Asked of the catalogue, so
-- a future migration that wires this table into an authorization path breaks
-- this assertion rather than shipping quietly.

do $$
declare v_refs text;
begin
  perform pg_temp.act_as_owner();

  -- It references nothing but auth.users.
  select string_agg(confrelid::regclass::text, ', ') into v_refs
    from pg_constraint
   where conrelid = 'public.user_module_order'::regclass and contype = 'f';
  assert v_refs = 'auth.users',
    format('§10 the table now references %s — it must reference only auth.users', v_refs);

  -- Nothing references IT, so no cascade or trigger elsewhere depends on a
  -- display preference.
  assert (select count(*) from pg_constraint
           where confrelid = 'public.user_module_order'::regclass) = 0,
    '§10 something now has a foreign key INTO the preference table';

  -- No other table's policy mentions it, which is what "ordering data cannot
  -- bypass a permission check" means at the database.
  select string_agg(tablename || '.' || policyname, ', ') into v_refs
    from pg_policies
   where schemaname = 'public'
     and tablename <> 'user_module_order'
     and coalesce(qual, '') || coalesce(with_check, '') like '%user_module_order%';
  assert v_refs is null,
    format('§10 a policy on another table now reads the module order: %s', v_refs);

  -- And no function body does either, apart from the validator the constraint
  -- calls.
  select string_agg(p.proname, ', ') into v_refs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname not in ('user_module_order_keys_valid', 'touch_user_module_order')
     and p.prosrc like '%user_module_order%';
  assert v_refs is null,
    format('§10 a function now reads the module order: %s', v_refs);

  -- It holds no business record: two columns and a timestamp, and nothing that
  -- could be money, a task, an order or a person's details.
  assert (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'user_module_order') = 3,
    '§10 the preference table grew a column';

  raise notice 'PASS  §10 the table references only auth.users, nothing reads it, and it carries no business record';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;

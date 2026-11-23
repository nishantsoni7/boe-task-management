-- ═══════════════════════════════════════════════════════════════════════════
-- 20270821000000 — which launcher cards are the BIG blocks (up to four), per person
-- ═══════════════════════════════════════════════════════════════════════════
--
-- /modules shows a row of large "essentials" blocks above the rest. Until now the
-- row was fixed in the code (Task, Order, Finance). The owner asked to choose
-- which modules are big, so each person's choice is kept beside their card order,
-- on the SAME row of public.user_module_order (20261228000000).
--
-- ONE NULLABLE COLUMN, NOTHING ELSE.
--
--   big_module_keys text[]   launcher card keys, up to four, first = first block.
--
-- NULL means "never chosen" and the launcher uses its default (tasks, orders,
-- finance, sales). '{}' is a real choice: no big blocks at all. The two are NOT
-- the same, which is why the column has no default and is not "not null".
--
-- ── WHAT THIS DOES NOT CHANGE ───────────────────────────────────────────────
--
-- A stored key is still not access. The launcher builds the cards from the
-- permission engine first and only then picks the big ones out of them, so a key
-- naming a module the person cannot open produces no card (see
-- src/lib/modules/moduleOrder.ts). No policy, grant, trigger or function is
-- touched: the three owner-scoped policies and the table-level grants already
-- cover a new column, and the assertions below prove it rather than assume it.
--
-- The shape check REUSES user_module_order_keys_valid (one dimension, no nulls,
-- every entry a well-formed key, no duplicates) and adds the cap of four.
--
-- ROLLBACK: `alter table public.user_module_order drop column big_module_keys;`
-- (drops the column and its constraint together; nothing else depends on it).
-- Ship order: this migration FIRST, then the code — the launcher reads and
-- writes the column, and a deploy before the column exists makes the personal
-- card order unreadable until the column is there.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.user_module_order
  add column if not exists big_module_keys text[];

comment on column public.user_module_order.big_module_keys is
  'Launcher card keys shown as the big "essentials" blocks, first block first, at most four. NULL = never chosen (the launcher default applies); {} = chosen none. A DISPLAY PREFERENCE ONLY: the launcher builds the visible cards from the permission engine first, so a key naming a module the person cannot open produces no card. 20270821000000.';

alter table public.user_module_order
  drop constraint if exists user_module_order_big_keys_valid;

alter table public.user_module_order
  add constraint user_module_order_big_keys_valid
  check (
    big_module_keys is null
    or (
      public.user_module_order_keys_valid(big_module_keys)
      and coalesce(array_length(big_module_keys, 1), 0) <= 4
    )
  );

-- ─── Assertions ─────────────────────────────────────────────────────────────
--
-- Read-only: pure expressions over literals and catalog lookups. Nothing writes
-- a row. They fail the migration rather than let a half-applied state look done.

do $$
declare
  v_policies text[];
begin
  -- The column exists, is text[], and is nullable (NULL = never chosen).
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_module_order'
      and column_name = 'big_module_keys' and data_type = 'ARRAY' and udt_name = '_text'
      and is_nullable = 'YES' and column_default is null
  ) then
    raise exception 'big module keys: the column is missing, not text[], not nullable, or has a default';
  end if;

  -- The cap-of-four check is present and calls the shared validator.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_module_order'::regclass
      and contype = 'c' and conname = 'user_module_order_big_keys_valid'
      and pg_get_constraintdef(oid) like '%user_module_order_keys_valid%'
      and pg_get_constraintdef(oid) like '%<= 4%'
  ) then
    raise exception 'big module keys: the shape and cap constraint is missing';
  end if;

  -- The rule the constraint states, run over literals. Four keys pass; five, a
  -- duplicate, a bad key and a null entry do not; NULL itself is allowed.
  if not (
       (select ok from (select (public.user_module_order_keys_valid(a) and coalesce(array_length(a, 1), 0) <= 4) as ok
                          from (values (array['tasks','orders','finance','sales']::text[])) as t(a)) s)
   and (select ok from (select (public.user_module_order_keys_valid(a) and coalesce(array_length(a, 1), 0) <= 4) as ok
                          from (values ('{}'::text[])) as t(a)) s)
  ) then
    raise exception 'big module keys: a valid list (four keys, or none) is refused';
  end if;
  if (select ok from (select (public.user_module_order_keys_valid(a) and coalesce(array_length(a, 1), 0) <= 4) as ok
                        from (values (array['a','b','c','d','e']::text[])) as t(a)) s)
     or (select ok from (select (public.user_module_order_keys_valid(a) and coalesce(array_length(a, 1), 0) <= 4) as ok
                           from (values (array['tasks','tasks']::text[])) as t(a)) s)
     or (select ok from (select (public.user_module_order_keys_valid(a) and coalesce(array_length(a, 1), 0) <= 4) as ok
                           from (values (array['Tasks']::text[])) as t(a)) s)
     or (select ok from (select (public.user_module_order_keys_valid(a) and coalesce(array_length(a, 1), 0) <= 4) as ok
                           from (values (array['tasks', null]::text[])) as t(a)) s)
  then
    raise exception 'big module keys: an invalid list (five keys, a duplicate, a bad key, a null) is accepted';
  end if;

  -- Still exactly the three owner-scoped commands, each on auth.uid().
  select array_agg(distinct cmd order by cmd) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'user_module_order';
  if v_policies is distinct from array['INSERT', 'SELECT', 'UPDATE'] then
    raise exception 'big module keys: expected SELECT/INSERT/UPDATE policies only, found %', v_policies;
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_module_order'
      and coalesce(qual, '') || coalesce(with_check, '') not like '%auth.uid()%'
  ) then
    raise exception 'big module keys: a policy is not scoped to auth.uid()';
  end if;

  -- The new column is reachable by the signed-in role and by nobody else.
  if not has_column_privilege('authenticated', 'public.user_module_order', 'big_module_keys', 'SELECT')
     or not has_column_privilege('authenticated', 'public.user_module_order', 'big_module_keys', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.user_module_order', 'big_module_keys', 'INSERT') then
    raise exception 'big module keys: authenticated cannot read or write the new column';
  end if;
  if has_column_privilege('anon', 'public.user_module_order', 'big_module_keys', 'SELECT')
     or has_column_privilege('anon', 'public.user_module_order', 'big_module_keys', 'INSERT')
     or has_column_privilege('anon', 'public.user_module_order', 'big_module_keys', 'UPDATE') then
    raise exception 'big module keys: anon holds a grant on the new column';
  end if;
  if has_table_privilege('authenticated', 'public.user_module_order', 'DELETE') then
    raise exception 'big module keys: authenticated can DELETE a preference row';
  end if;
end $$;

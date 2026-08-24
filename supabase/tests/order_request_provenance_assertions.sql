-- ORDER PROVENANCE assertions — the contract 20261007000000 §5i is about
-- ===========================================================================
-- Run against the production-shaped harness with 20261007000000 applied.
--
-- WHY THIS FILE EXISTS
--
-- The corrected 20261007000000 was pushed to the linked database and refused its
-- own apply:
--
--     ERROR: public.orders.source_order_request_id must not be dropped:
--            confirmed Orders depend on it (SQLSTATE P0001)
--     At statement: 25
--
-- The column is not missing, and nothing in the 201-migration history removes
-- it. `20260655_create_orders.sql` creates the table, `20260701000000` adds the
-- provenance pair, no migration drops or renames either, and the Order detail
-- page selects both (src/app/orders/[id]/page.tsx). The statement immediately
-- before the failing one had just read the column: a census that counts
-- `orders where source_order_request_id is not null` cannot parse, let alone
-- run, against a column that is not there.
--
-- The assertion was asking the wrong oracle. §1 below demonstrates it.
--
-- Runs inside ONE transaction that ends in ROLLBACK — including §3, which drops
-- a real column to prove the corrected assertion notices.
--
-- PREREQUISITES: psql as a role that may create a role and SET ROLE.
-- On success prints NOTICE 'PROVENANCE ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

-- ═══ 1. THE TWO ORACLES, AND WHY ONLY ONE OF THEM IS ONE ════════════════════
--
-- `information_schema.columns` ends its definition with
--
--     AND c.relkind IN ('r', 'v', 'f', 'p')
--     AND (pg_has_role(c.relowner, 'USAGE')
--          OR has_column_privilege(c.oid, a.attnum,
--                                  'SELECT, INSERT, UPDATE, REFERENCES'))
--
-- so it answers "is this column visible to whoever is asking". Ask it as a role
-- that is neither the owner nor a privilege holder for that column and a column
-- that unquestionably exists is reported absent. `pg_catalog.pg_attribute` is
-- filtered by neither clause and is what every DDL statement resolves against.

do $$
declare
  v_info    int;
  v_catalog int;
begin
  create role t_provenance_reader nologin noinherit;
  grant usage on schema public to t_provenance_reader;
  -- Readable, but not through the provenance column: exactly the shape of
  -- access that makes information_schema lie.
  grant select (id, display_number) on public.orders to t_provenance_reader;

  set local role t_provenance_reader;

  select count(*) into v_info
  from information_schema.columns
  where table_schema = 'public' and table_name = 'orders'
    and column_name = 'source_order_request_id';

  select count(*) into v_catalog
  from pg_catalog.pg_attribute a
  where a.attrelid = 'public.orders'::regclass
    and a.attname = 'source_order_request_id'
    and a.attnum > 0 and not a.attisdropped;

  reset role;

  if v_info <> 0 then
    raise exception
      'information_schema was expected to hide the column from a non-privileged reader, but showed % row(s)', v_info;
  end if;
  if v_catalog <> 1 then
    raise exception
      'pg_catalog must report the column present regardless of who asks, but returned % row(s)', v_catalog;
  end if;

  raise notice
    '1. the same present column: information_schema says 0, pg_catalog says 1 — the first form asked the first one';
exception when others then
  reset role;
  raise;
end $$;

do $$
declare
  v_missing text;
  v_failed  text := null;
begin
  -- THE FIRST FORM, verbatim from the commit that was pushed, run as that same
  -- non-privileged reader. It reproduces the linked failure exactly.
  set local role t_provenance_reader;
  begin
    foreach v_missing in array array[
      'orders.source_order_request_id',
      'orders.source_request_number',
      'finance_payment_requests.order_request_id',
      'finance_payment_requests.order_request_number',
      'order_requests.converted_order_id',
      'order_requests.request_number'
    ] loop
      if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = split_part(v_missing, '.', 1)
          and column_name = split_part(v_missing, '.', 2)
      ) then
        raise exception 'public.% must not be dropped: confirmed Orders depend on it', v_missing;
      end if;
    end loop;
  exception when others then
    v_failed := sqlerrm;
  end;
  reset role;

  if v_failed is distinct from
     'public.orders.source_order_request_id must not be dropped: confirmed Orders depend on it' then
    raise exception
      'the first form was expected to reproduce the linked failure verbatim; it gave "%"', coalesce(v_failed, '<no error>');
  end if;

  raise notice '2. the first form reproduces the linked failure verbatim, on a database that has the column';
exception when others then
  reset role;
  raise;
end $$;

-- ═══ 2. THE CORRECTED ASSERTION, ASKED THE SAME WAY ═════════════════════════

do $$
declare
  v_missing text;
  v_count   int;
begin
  set local role t_provenance_reader;
  begin
    foreach v_missing in array array[
      'orders.source_order_request_id',
      'orders.source_request_number',
      'finance_payment_requests.order_request_id',
      'finance_payment_requests.order_request_number',
      'order_requests.converted_order_id',
      'order_requests.request_number'
    ] loop
      if to_regclass('public.' || quote_ident(split_part(v_missing, '.', 1))) is null
         or not exists (
           select 1 from pg_catalog.pg_attribute a
           where a.attrelid = ('public.' || quote_ident(split_part(v_missing, '.', 1)))::regclass
             and a.attname  = split_part(v_missing, '.', 2)
             and a.attnum > 0 and not a.attisdropped
         ) then
        raise exception 'public.% must not be dropped: confirmed Orders depend on it', v_missing;
      end if;
    end loop;
  exception when others then
    reset role;
    raise exception
      'the corrected assertion must not depend on who is asking, but failed as a non-privileged reader: %', sqlerrm;
  end;
  reset role;

  raise notice '3. the corrected assertion passes for the same reader the first form failed for';
end $$;

-- ═══ 3. THE MUTATION TEST — it must still fail when the field really goes ═══
--
-- Rolled back with the rest of the file. Nothing here survives the transaction.

do $$
declare
  v_missing text;
  v_failed  text := null;
begin
  -- Drop the real column, and everything that hangs off it.
  drop trigger if exists orders_protect_source_request on public.orders;
  alter table public.orders drop column source_order_request_id cascade;

  begin
    foreach v_missing in array array[
      'orders.source_order_request_id',
      'orders.source_request_number'
    ] loop
      if to_regclass('public.' || quote_ident(split_part(v_missing, '.', 1))) is null
         or not exists (
           select 1 from pg_catalog.pg_attribute a
           where a.attrelid = ('public.' || quote_ident(split_part(v_missing, '.', 1)))::regclass
             and a.attname  = split_part(v_missing, '.', 2)
             and a.attnum > 0 and not a.attisdropped
         ) then
        raise exception 'public.% must not be dropped: confirmed Orders depend on it', v_missing;
      end if;
    end loop;
  exception when others then
    v_failed := sqlerrm;
  end;

  if v_failed is distinct from
     'public.orders.source_order_request_id must not be dropped: confirmed Orders depend on it' then
    raise exception
      'the corrected assertion did NOT notice the column being dropped; it gave "%"', coalesce(v_failed, '<no error>');
  end if;

  raise notice '4. mutation test: drop the column for real and the corrected assertion fails, with the right message';
end $$;

rollback;

-- ═══ 4. The provenance itself, on a database that still has it ══════════════

begin;

do $$
declare
  ORD constant uuid := '22222222-0000-4000-8000-0000000000a1';
  REQ constant uuid := '33333333-0000-4000-8000-0000000000b1';
  v_row     record;
  v_failed  text;
begin
  -- 4a. Both halves of the pair are populated, and they agree with the request.
  select o.source_order_request_id, o.source_request_number, r.request_number, r.converted_order_id
    into v_row
  from public.orders o join public.order_requests r on r.id = o.source_order_request_id
  where o.id = ORD;

  if v_row.source_order_request_id is distinct from REQ then
    raise exception 'the confirmed Order lost its source request id';
  end if;
  if v_row.source_request_number is distinct from v_row.request_number then
    raise exception 'the denormalised request number drifted from the request: % vs %',
      v_row.source_request_number, v_row.request_number;
  end if;
  if v_row.converted_order_id is distinct from ORD then
    raise exception 'the reverse link from the request to the Order is gone';
  end if;

  -- 4b. It is still immutable. 20260701000000 §4's guard is not the retirement's
  -- to remove, and an Order whose provenance could be re-pointed has none.
  v_failed := null;
  begin
    update public.orders set source_order_request_id = null where id = ORD;
  exception when others then
    v_failed := sqlerrm;
  end;
  if v_failed is null or v_failed not like '%immutable%' then
    raise exception 'provenance is no longer immutable; got "%"', coalesce(v_failed, '<no error>');
  end if;

  -- 4c. And the source request still cannot be hard-deleted while an Order names
  -- it. The NO ACTION foreign key is the guarantee, not a UI convention — so
  -- even the definer cleanup path, which bypasses RLS entirely, is refused.
  v_failed := null;
  begin
    perform public.t_definer_delete_request(REQ);
  exception when others then
    v_failed := sqlerrm;
  end;
  if v_failed is null then
    raise exception 'a converted Order Request was hard-deleted while an Order still named it';
  end if;

  raise notice '5. provenance intact: pair populated and agreeing, immutable, and the source request undeletable';
end $$;

do $$ begin raise notice 'PROVENANCE ASSERTIONS PASSED'; end $$;

rollback;

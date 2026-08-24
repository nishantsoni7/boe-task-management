-- ORDER PROVENANCE — the mutation tests
-- ===========================================================================
-- 20260701000000 did not add a column. It added a five-part guarantee, and an
-- assertion that checked only the column would let four fifths of it be removed
-- without a word. This file breaks each part in turn and requires
-- 20261007000000 §5i to notice — for the RIGHT reason, not merely to fail.
--
-- Each case runs in its own transaction and ends in ROLLBACK, so the mutation
-- never survives the case that made it. The sixth breaks a row count instead of
-- a schema object, and is checked against §5m.
--
-- The assertion bodies below are copied from 20261007000000 §5i and §5m. That
-- duplication is deliberate: a mutation test that re-ran the whole migration
-- would be proving the migration's plumbing, not its assertions, and could not
-- reach §5m at all without first re-applying everything before it.
--
-- PREREQUISITES: 20261007000000 applied; psql as a role that may ALTER the
-- schema. On success prints NOTICE 'PROVENANCE MUTATION TESTS PASSED'.

\set ON_ERROR_STOP on

-- The assertions under test, as functions, so each case invokes exactly what the
-- migration runs rather than a paraphrase of it. Dropped at the end.

create or replace function pg_temp.t_assert_provenance_schema() returns void
language plpgsql as $fn$
declare
  v_missing  text;
  v_count    int;
  v_names    text;
  v_expected text[];
begin
  foreach v_missing in array array[
    'orders.source_order_request_id=uuid',
    'orders.source_request_number=text',
    'finance_payment_requests.order_request_id=uuid',
    'finance_payment_requests.order_request_number=text',
    'order_requests.converted_order_id=uuid',
    'order_requests.request_number=text'
  ] loop
    v_names := split_part(split_part(v_missing, '=', 1), '.', 1);
    v_expected := array[split_part(split_part(v_missing, '=', 1), '.', 2),
                        split_part(v_missing, '=', 2)];

    if to_regclass('public.' || quote_ident(v_names)) is null then
      raise exception 'public.% must not be dropped: it is the historical record', v_names;
    end if;

    select count(*) into v_count
    from pg_catalog.pg_attribute a
    where a.attrelid = ('public.' || quote_ident(v_names))::regclass
      and a.attname = v_expected[1] and a.attnum > 0 and not a.attisdropped;
    if v_count = 0 then
      raise exception 'public.%.% must not be dropped: confirmed Orders depend on it',
        v_names, v_expected[1];
    end if;

    select count(*) into v_count
    from pg_catalog.pg_attribute a
    where a.attrelid = ('public.' || quote_ident(v_names))::regclass
      and a.attname = v_expected[1] and a.attnum > 0 and not a.attisdropped
      and format_type(a.atttypid, null) = v_expected[2];
    if v_count = 0 then
      raise exception
        'public.%.% changed type; it must remain %', v_names, v_expected[1], v_expected[2];
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.conrelid = 'public.orders'::regclass
      and c.confrelid = 'public.order_requests'::regclass
      and c.contype = 'f' and a.attname = 'source_order_request_id'
      and c.confdeltype = 'a' and array_length(c.conkey, 1) = 1
  ) then
    raise exception
      'orders.source_order_request_id lost its NO ACTION foreign key to order_requests(id); a converted request could then be hard-deleted';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
    where i.indrelid = 'public.orders'::regclass
      and ic.relname = 'orders_source_order_request_id_uidx'
      and i.indisunique and i.indpred is not null
  ) then
    raise exception
      'orders_source_order_request_id_uidx is missing or no longer a partial unique index; two Orders could name one request';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.orders'::regclass
      and t.tgname = 'orders_protect_source_request'
      and p.proname = 'prevent_order_source_request_change'
      and not t.tgisinternal and t.tgenabled <> 'D'
  ) then
    raise exception
      'orders_protect_source_request is missing or disabled; Order Request provenance would stop being immutable';
  end if;
end;
$fn$;

-- §5m, against a census captured the way the migration captures it.
create or replace function pg_temp.t_assert_census(
  p_requests bigint, p_activity bigint, p_attachments bigint,
  p_orders_with_provenance bigint, p_orders_with_number bigint,
  p_payments_with_linkage bigint) returns void
language plpgsql as $fn$
begin
  if p_requests               <> (select count(*) from public.order_requests)
  or p_activity               <> (select count(*) from public.order_request_activity)
  or p_attachments            <> (select count(*) from public.order_request_attachments)
  or p_orders_with_provenance <> (select count(*) from public.orders
                                   where source_order_request_id is not null)
  or p_orders_with_number     <> (select count(*) from public.orders
                                   where source_request_number is not null)
  or p_payments_with_linkage  <> (select count(*) from public.finance_payment_requests
                                   where order_request_id is not null) then
    raise exception
      'the retirement changed a row count or a provenance value; it must delete and rewrite nothing';
  end if;
end;
$fn$;

-- A harness for the cases: run a mutation, require the assertion to fail with a
-- message containing the expected fragment, and say so.
create or replace function pg_temp.t_mutation(p_label text, p_mutation text, p_expect text)
returns void language plpgsql as $fn$
declare v_failed text := null;
begin
  execute p_mutation;
  begin
    perform pg_temp.t_assert_provenance_schema();
  exception when others then
    v_failed := sqlerrm;
  end;

  if v_failed is null then
    raise exception 'MUTATION "%" WENT UNNOTICED: the assertion passed after %', p_label, p_mutation;
  end if;
  if position(p_expect in v_failed) = 0 then
    raise exception 'mutation "%" failed for the wrong reason. expected to contain "%", got "%"',
      p_label, p_expect, v_failed;
  end if;
  raise notice '%  →  %', rpad(p_label, 38), v_failed;
end;
$fn$;

-- ═══ 1. The column is dropped ═══════════════════════════════════════════════
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'column dropped',
    'drop trigger orders_protect_source_request on public.orders;
     alter table public.orders drop column source_order_request_id cascade',
    'public.orders.source_order_request_id must not be dropped');
end $$;
rollback;

-- ═══ 2. The column survives as the wrong type ═══════════════════════════════
--
-- The failure an existence-only check cannot see: the name is still there and
-- the catalog row is still there, but nothing can read a uuid out of it.
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'column retyped to text',
    'drop trigger orders_protect_source_request on public.orders;
     alter table public.orders drop constraint orders_source_order_request_id_fkey;
     alter table public.orders alter column source_order_request_id type text',
    'changed type; it must remain uuid');
end $$;
rollback;

-- ═══ 3. The foreign key is removed ══════════════════════════════════════════
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'foreign key dropped',
    'alter table public.orders drop constraint orders_source_order_request_id_fkey',
    'lost its NO ACTION foreign key');
end $$;
rollback;

-- ═══ 4. The foreign key is REDIRECTED, not removed ══════════════════════════
--
-- Still a constraint, still on the same column, still NO ACTION — and pointing
-- somewhere else entirely. A check that counted constraints would pass.
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'foreign key redirected',
    'alter table public.orders drop constraint orders_source_order_request_id_fkey;
     alter table public.orders add constraint orders_source_order_request_id_fkey
       foreign key (source_order_request_id) references public.orders(id) not valid',
    'lost its NO ACTION foreign key');
end $$;
rollback;

-- ═══ 5. The partial unique index is removed ═════════════════════════════════
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'provenance unique index dropped',
    'drop index public.orders_source_order_request_id_uidx',
    'two Orders could name one request');
end $$;
rollback;

-- ═══ 6. The index survives but stops being unique ═══════════════════════════
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'unique index replaced by a plain one',
    'drop index public.orders_source_order_request_id_uidx;
     create index orders_source_order_request_id_uidx on public.orders (source_order_request_id)
       where source_order_request_id is not null',
    'no longer a partial unique index');
end $$;
rollback;

-- ═══ 7. The immutability trigger is removed ═════════════════════════════════
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'immutability trigger dropped',
    'drop trigger orders_protect_source_request on public.orders',
    'would stop being immutable');
end $$;
rollback;

-- ═══ 8. The trigger survives but is DISABLED ════════════════════════════════
begin;
do $$ begin
  perform pg_temp.t_mutation(
    'immutability trigger disabled',
    'alter table public.orders disable trigger orders_protect_source_request',
    'is missing or disabled');
end $$;
rollback;

-- ═══ 9. A row count changes between the census and the comparison ═══════════
--
-- §5m rather than §5i: the census is what proves the migration deleted and
-- rewrote nothing, and it is only worth taking if a change to it would be seen.
begin;
do $$
declare
  c_requests    bigint := (select count(*) from public.order_requests);
  c_activity    bigint := (select count(*) from public.order_request_activity);
  c_attachments bigint := (select count(*) from public.order_request_attachments);
  c_orders      bigint := (select count(*) from public.orders where source_order_request_id is not null);
  c_numbers     bigint := (select count(*) from public.orders where source_request_number is not null);
  c_payments    bigint := (select count(*) from public.finance_payment_requests where order_request_id is not null);
  v_failed text := null;
begin
  -- Unchanged: the assertion must be silent.
  perform pg_temp.t_assert_census(c_requests, c_activity, c_attachments, c_orders, c_numbers, c_payments);

  -- A provenance value cleared — no row deleted, nothing but a single NULL.
  -- The immutability guard has to come off first, which is itself the point of
  -- §5i-iv: with that trigger in place this mutation is not reachable at all.
  alter table public.orders disable trigger orders_protect_source_request;
  update public.orders set source_request_number = null
   where id = '22222222-0000-4000-8000-0000000000a1';
  begin
    perform pg_temp.t_assert_census(c_requests, c_activity, c_attachments, c_orders, c_numbers, c_payments);
  exception when others then
    v_failed := sqlerrm;
  end;
  if v_failed is null then
    raise exception 'MUTATION "census: number cleared" WENT UNNOTICED';
  end if;
  raise notice '%  →  %', rpad('census: number cleared', 38), v_failed;
  update public.orders set source_request_number = 'REQ-FIXTURE-1'
   where id = '22222222-0000-4000-8000-0000000000a1';
  v_failed := null;

  -- The id cleared, which the census does count.
  update public.orders set source_order_request_id = null
   where id = '22222222-0000-4000-8000-0000000000a1';
  begin
    perform pg_temp.t_assert_census(c_requests, c_activity, c_attachments, c_orders, c_numbers, c_payments);
  exception when others then
    v_failed := sqlerrm;
  end;
  if v_failed is null then
    raise exception 'MUTATION "census: provenance cleared" WENT UNNOTICED';
  end if;
  if position('changed a row count or a provenance value' in v_failed) = 0 then
    raise exception 'the census mutation failed for the wrong reason: "%"', v_failed;
  end if;
  raise notice '%  →  %', rpad('census: provenance cleared', 38), v_failed;

  -- And a deleted historical row.
  v_failed := null;
  delete from public.order_request_activity;
  begin
    perform pg_temp.t_assert_census(c_requests, c_activity, c_attachments, c_orders, c_numbers, c_payments);
  exception when others then
    v_failed := sqlerrm;
  end;
  if v_failed is null then
    raise exception 'MUTATION "census: activity deleted" WENT UNNOTICED';
  end if;
  raise notice '%  →  %', rpad('census: activity deleted', 38), v_failed;
end $$;
rollback;

-- ═══ 10. And the unmutated schema still passes ══════════════════════════════
begin;
do $$ begin
  perform pg_temp.t_assert_provenance_schema();
  raise notice '%  →  passes, as it must', rpad('no mutation', 38);
end $$;
rollback;

do $$ begin raise notice 'PROVENANCE MUTATION TESTS PASSED'; end $$;

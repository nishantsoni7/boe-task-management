-- ASSERTIONS for 20270203000000 (order_pi_version_pdf_detail, a copy of
-- order_pi_version_detail). One transaction, rolled back. Needs a database with
-- PI versions in several statuses (e.g. after run_order_pi_version_pdf_order_number_local.sh).
-- Run through run_order_pi_version_pdf_detail_local.sh.
\set ON_ERROR_STOP on
begin;

create function pg_temp.become(p_user uuid) returns void language plpgsql as $$
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.restore() returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end $$;
-- A function's answer, or its error message, as one comparable value.
create function pg_temp.answer(p_fn text, p_version uuid) returns jsonb language plpgsql as $$
declare r jsonb; m text;
begin
  execute format('select public.%I($1)', p_fn) into r using p_version;
  return jsonb_build_object('ok', r);
exception when others then
  get stacked diagnostics m = message_text;
  return jsonb_build_object('error', m, 'state', sqlstate);
end $$;

-- ═══ 1. THE CATALOG: same body, security, settings, grants ═════════════════
do $$
declare o pg_proc; c pg_proc;
begin
  select * into o from pg_proc where oid = 'public.order_pi_version_detail(uuid)'::regprocedure;
  select * into c from pg_proc where oid = 'public.order_pi_version_pdf_detail(uuid)'::regprocedure;
  if replace(c.prosrc, E'\r', '') <> replace(o.prosrc, E'\r', '')
     or (c.prorettype, c.provolatile, c.prosecdef, c.proconfig::text, c.proacl::text)
        is distinct from (o.prorettype, o.provolatile, o.prosecdef, o.proconfig::text, o.proacl::text) then
    raise exception '1. FAILED: the copy differs from the original';
  end if;
  if has_function_privilege('anon', c.oid, 'execute') then raise exception '1. FAILED: anon may execute the copy'; end if;
  raise notice '1. catalog: identical body, security, settings and grants OK';
end $$;

-- ═══ 2. EVERY VERSION, EVERY KIND OF READER: identical answers ═════════════
do $$
declare
  u uuid; v record; a jsonb; b jsonb; n int := 0; refused int := 0;
begin
  if (select count(*) from public.order_pi_versions) < 4 then
    raise exception '2. FAILED: this needs a database with PI versions (run the PDF number runner first)';
  end if;
  foreach u in array array['11111111-1111-1111-1111-111111111111',   -- admin
                           '55555555-5555-5555-5555-555555555555',   -- sales (orders view)
                           '44444444-4444-4444-4444-444444444444']::uuid[]  -- no Orders access
  loop
    for v in select id from public.order_pi_versions loop
      perform pg_temp.become(u);
      a := pg_temp.answer('order_pi_version_detail', v.id);
      b := pg_temp.answer('order_pi_version_pdf_detail', v.id);
      perform pg_temp.restore();
      if a is distinct from b then
        raise exception '2. FAILED: % reading % — original % vs copy %', u, v.id, a, b;
      end if;
      n := n + 1;
      if a ? 'error' then refused := refused + 1; end if;
    end loop;
  end loop;
  -- Access is not widened: the reader without Orders access is refused every version.
  perform pg_temp.become('44444444-4444-4444-4444-444444444444');
  if exists (select 1 from public.order_pi_versions pv where not (pg_temp.answer('order_pi_version_pdf_detail', pv.id) ? 'error')) then
    raise exception '2. FAILED: a reader without Orders access got a version through the copy';
  end if;
  perform pg_temp.restore();
  -- A version that does not exist is refused the same way.
  if pg_temp.answer('order_pi_version_pdf_detail', gen_random_uuid()) ->> 'state' <> 'P0002' then
    raise exception '2. FAILED: an unknown version is not refused as P0002';
  end if;
  raise notice '2. % answers compared (% refusals, all identical) OK', n, refused;
end $$;

-- ═══ 3. anon cannot call it ════════════════════════════════════════════════
do $$
declare m text;
begin
  execute 'set local role anon';
  begin
    perform public.order_pi_version_pdf_detail(gen_random_uuid());
    raise exception '3. FAILED: anon could call the copy';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  raise notice '3. anon refused OK';
end $$;

select 'ALL PI VERSION PDF DETAIL ASSERTIONS PASSED' as result;
rollback;

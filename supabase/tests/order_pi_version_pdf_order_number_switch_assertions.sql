-- NEW PI VERSIONS PRINT THE STORED ORDER NUMBER — AND NO VERSION CHANGES (20270202000000)
-- ===========================================================================
-- After the whole release sequence on a disposable stack:
--   before 20270201000000   _prior_versions   (the old route prints "1", "2", "3")
--   between the migrations  _between_versions (stamped "5", the old form)
--   after 20270202000000    this suite
--
-- A version keeps the number its PDF FIRST printed, whenever it was created:
--   1. between   versions created between the migrations keep the old form —
--                what the old route printed, and the new route too
--   2. decided   a proposal created between the migrations and decided after
--                the switch keeps it; so does the V1 it supersedes
--   3. after     a revision proposed after the switch prints the stored form,
--                so one Order's versions can differ: each keeps its own
--   4. history   the switch rewrote nothing: every version created before it
--                still equals what the old route prints for its Order
--   5. function  only the stamp changed: refusal of a missing number and
--                immutability hold, grants unchanged
--
-- Runs inside ONE transaction that ends in ROLLBACK, after
-- _order_pi_version_pdf_order_number_helpers.sql in the same session.
-- On success prints NOTICE 'ALL PI PDF ORDER NUMBER SWITCH ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

do $$
begin
  assert (select prosrc from pg_proc where oid = 'public.order_pi_versions_pdf_order_number()'::regprocedure)
           not like '%order_operational_number%', '20270202000000 is applied';
end $$;

-- ═══ 1. VERSIONS CREATED BETWEEN THE MIGRATIONS KEEP THE OLD FORM ══════════

do $$
declare
  e   uuid := (select id from public.orders where client_name = 'ASSERT pdfnum between E');
  dn  text := (select display_number from public.orders where client_name = 'ASSERT pdfnum between E');
  bad text;
begin
  assert e is not null and dn ~ '^0[0-9]{3}$', 'the between-migrations Order exists, zero-led: ' || coalesce(dn, 'none');
  select string_agg(format('V%s %s: %s', version_number, status, pdf_order_number), '; ') into bad
    from public.order_pi_versions where order_id = e and pdf_order_number is distinct from pg_temp.route_number(dn);
  assert bad is null, 'between-migration versions carry the old form: ' || coalesce(bad, '');
  assert (select count(*) from public.order_pi_versions where order_id = e) = 2, 'V1 and the pending V2';
  raise notice '1. versions created between the migrations keep % (not %) OK', pg_temp.route_number(dn), dn;
end $$;


-- ═══ 2. A PROPOSAL MADE BETWEEN, DECIDED AFTER, KEEPS IT ═══════════════════

do $$
declare
  e   uuid := (select id from public.orders where client_name = 'ASSERT pdfnum between E');
  old text := (select pg_temp.route_number(display_number) from public.orders where client_name = 'ASSERT pdfnum between E');
  v1  uuid := (select id from public.order_pi_versions where order_id = (select id from public.orders where client_name = 'ASSERT pdfnum between E') and version_number = 1);
  v2  uuid := (select id from public.order_pi_versions where order_id = (select id from public.orders where client_name = 'ASSERT pdfnum between E') and status = 'pending');
begin
  perform pg_temp.approve(v2);
  assert (select status from public.order_pi_versions where id = v2) = 'approved', 'V2 is in force';
  assert (select pdf_order_number from public.order_pi_versions where id = v2) = old,
    'approved after the switch, V2 keeps the number its PDF printed while it was pending';
  assert (select status from public.order_pi_versions where id = v1) = 'superseded'
     and (select pdf_order_number from public.order_pi_versions where id = v1) = old, 'V1, superseded, keeps it too';
  raise notice '2. a proposal made between the migrations and approved after keeps % OK', old;
end $$;


-- ═══ 3. A REVISION PROPOSED AFTER THE SWITCH PRINTS THE STORED FORM ════════

do $$
declare
  e   uuid := (select id from public.orders where client_name = 'ASSERT pdfnum between E');
  dn  text := (select display_number from public.orders where client_name = 'ASSERT pdfnum between E');
  v3  uuid;
begin
  v3 := pg_temp.propose_edit(e, 12000, 'ASSERT between E: V3 after the switch');
  assert (select pdf_order_number from public.order_pi_versions where id = v3) = dn,
    'a revision proposed after the switch carries the stored number ' || dn;
  perform pg_temp.approve(v3);
  assert (select pdf_order_number from public.order_pi_versions where id = v3) = dn, 'and keeps it when approved';
  assert (select array_agg(pdf_order_number order by version_number) from public.order_pi_versions where order_id = e)
       = array[pg_temp.route_number(dn), pg_temp.route_number(dn), dn],
    'each version of the Order keeps its own: V1, V2 old; V3 stored';
  raise notice '3. after the switch a new revision prints %, the earlier versions keep % OK', dn, pg_temp.route_number(dn);
end $$;


-- ═══ 4. THE SWITCH REWROTE NOTHING ═════════════════════════════════════════

do $$
declare
  bad text;
  n   int;
begin
  select count(*), string_agg(format('%s V%s: %s', o.client_name, v.version_number, v.pdf_order_number), '; ')
    into n, bad
    from public.order_pi_versions v join public.orders o on o.id = v.order_id
   where (o.client_name like 'ASSERT pdfnum prior%' or (o.client_name = 'ASSERT pdfnum between E' and v.version_number <= 2))
     and v.pdf_order_number is distinct from pg_temp.route_number(o.display_number);
  assert n = 0, 'every version created before the switch still prints the old form: ' || coalesce(bad, '');
  raise notice '4. every version created before the switch is unchanged OK';
end $$;


-- ═══ 5. ONLY THE STAMP CHANGED ═════════════════════════════════════════════

do $$
declare
  v1 uuid := (select id from public.order_pi_versions where order_id = (select id from public.orders where client_name = 'ASSERT pdfnum between E') and version_number = 1);
  e  text;
begin
  e := pg_temp.fails_with(format('update public.order_pi_versions set pdf_order_number = %L where id = %L',
                                 (select display_number from public.orders where client_name = 'ASSERT pdfnum between E'), v1));
  assert e like 'PI_PDF_ORDER_NUMBER_IMMUTABLE:%', 'an old-form version cannot be "upgraded" after the switch: ' || e;
  assert (select prosecdef and proconfig = array['search_path=public, pg_temp'] from pg_proc
           where oid = 'public.order_pi_versions_pdf_order_number()'::regprocedure), 'still security definer, pg_temp last';
  assert not has_function_privilege('authenticated', 'public.order_pi_versions_pdf_order_number()', 'EXECUTE')
     and not has_function_privilege('anon', 'public.order_pi_versions_pdf_order_number()', 'EXECUTE')
     and not has_function_privilege('service_role', 'public.order_pi_versions_pdf_order_number()', 'EXECUTE'),
    'EXECUTE stays revoked';
  raise notice '5. immutability, definer settings and grants unchanged OK';
end $$;

do $$ begin raise notice 'ALL PI PDF ORDER NUMBER SWITCH ASSERTIONS PASSED'; end $$;

rollback;

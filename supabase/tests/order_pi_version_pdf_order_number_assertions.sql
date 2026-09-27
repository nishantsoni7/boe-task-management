-- EACH PI VERSION KEEPS THE ORDER NUMBER ITS PDF PRINTS (20270201000000)
-- ===========================================================================
-- Through the real doors, on a disposable stack, AFTER the migration ran over
-- the history _order_pi_version_pdf_order_number_prior_versions.sql committed:
--
--   1. backfill   every earlier version — superseded, approved, rejected,
--                 pending — keeps what its PDF printed: "1", not "0001"
--   2. earlier    an earlier PENDING version keeps it through approval, and
--      pending    another through rejection
--   3. V1         a new Order's V1 takes the stored "0004" in the transaction
--                 that numbers the Order
--   4. Edit PI    pending → approved: numbered at the proposal, unchanged by
--                 the approval and by V1 being superseded
--   5. Edit PI    pending → rejected: unchanged by the rejection
--   6. workbook   a revised workbook is numbered at the proposal too
--   7. direct     an insert's own value is ignored; no role can change the
--                 value afterwards (not even to NULL, not even the owner); an
--                 Order with no number cannot get a version
--   8. reading    the select policy is unchanged: whoever sees the Order sees
--                 the value, and nobody else does
--
-- Runs inside ONE transaction that ends in ROLLBACK, after
-- _order_pi_version_pdf_order_number_helpers.sql in the same session.
-- On success prints NOTICE 'ALL PI PDF ORDER NUMBER ASSERTIONS PASSED'.

\set ON_ERROR_STOP on

begin;

-- ═══ 1. BACKFILL: EARLIER VERSIONS KEEP WHAT THEIR PDF PRINTED ═════════════

do $$
declare
  v_rows     int;
  v_statuses text[];
  v_wrong    text;
begin
  select count(*), array_agg(distinct v.status order by v.status)
    into v_rows, v_statuses
    from public.order_pi_versions v join public.orders o on o.id = v.order_id
   where o.client_name like 'ASSERT pdfnum prior%';
  assert v_rows = 8, 'the fixture left 8 earlier versions, found ' || v_rows;
  assert v_statuses = array['approved', 'pending', 'rejected', 'superseded'],
    'every status a PDF can be opened for is covered: ' || v_statuses::text;

  select string_agg(format('%s V%s %s: %s', o.client_name, v.version_number, v.status, v.pdf_order_number), '; ')
    into v_wrong
    from public.order_pi_versions v join public.orders o on o.id = v.order_id
   where o.client_name like 'ASSERT pdfnum prior%'
     and v.pdf_order_number is distinct from pg_temp.route_number(o.display_number);
  assert v_wrong is null, 'each earlier version prints what the route printed before: ' || coalesce(v_wrong, '');

  -- …which is the old form, not the stored one.
  assert not exists (select 1 from public.order_pi_versions v join public.orders o on o.id = v.order_id
                      where o.client_name like 'ASSERT pdfnum prior%' and v.pdf_order_number = o.display_number),
    'no earlier version was given the four-digit form';
  raise notice '1. backfill: 8 earlier versions in all four statuses keep the route''s old output OK';
end $$;


-- ═══ 2. AN EARLIER PENDING VERSION KEEPS ITS NUMBER THROUGH THE DECISION ═══

do $$
declare
  a  uuid := (select id from public.orders where client_name = 'ASSERT pdfnum prior A');
  b  uuid := (select id from public.orders where client_name = 'ASSERT pdfnum prior B');
  va uuid := (select id from public.order_pi_versions where order_id = (select id from public.orders where client_name = 'ASSERT pdfnum prior A') and status = 'pending');
  vb uuid := (select id from public.order_pi_versions where order_id = (select id from public.orders where client_name = 'ASSERT pdfnum prior B') and status = 'pending');
  vb1 uuid := (select id from public.order_pi_versions where order_id = (select id from public.orders where client_name = 'ASSERT pdfnum prior B') and version_number = 1);
  v_old_a text := (select pg_temp.route_number(display_number) from public.orders where client_name = 'ASSERT pdfnum prior A');
  v_old_b text := (select pg_temp.route_number(display_number) from public.orders where client_name = 'ASSERT pdfnum prior B');
begin
  assert va is not null and vb is not null, 'the fixture left a pending version on A and on B';

  perform pg_temp.approve(vb);
  assert (select status from public.order_pi_versions where id = vb) = 'approved', 'B''s earlier proposal is now in force';
  assert (select pdf_order_number from public.order_pi_versions where id = vb) = v_old_b,
    'approving an earlier proposal keeps its number: ' || (select pdf_order_number from public.order_pi_versions where id = vb);
  assert (select status from public.order_pi_versions where id = vb1) = 'superseded'
     and (select pdf_order_number from public.order_pi_versions where id = vb1) = v_old_b,
    'and superseding B''s V1 keeps V1''s';

  perform pg_temp.reject(va, 'ASSERT prior A: V4 not agreed');
  assert (select status from public.order_pi_versions where id = va) = 'rejected', 'A''s earlier proposal is rejected';
  assert (select pdf_order_number from public.order_pi_versions where id = va) = v_old_a,
    'rejecting an earlier proposal keeps its number';
  raise notice '2. earlier pending versions keep their number through approval and rejection OK';
end $$;


-- ═══ 3. V1: NUMBERED IN THE TRANSACTION THAT NUMBERS THE ORDER ═════════════

do $$
declare
  d   uuid;
  o   public.orders%rowtype;
  v1  public.order_pi_versions%rowtype;
begin
  d := pg_temp.new_order('new D');
  select * into o from public.orders where id = d;
  select * into v1 from public.order_pi_versions where order_id = d and version_number = 1;

  assert o.display_number ~ '^0[0-9]{3}$', 'the new Order has a zero-led number, so the two forms differ: ' || o.display_number;
  assert v1.status = 'approved', 'V1 is in force';
  assert v1.pdf_order_number = o.display_number,
    format('V1 prints the stored number %s, found %s', o.display_number, v1.pdf_order_number);
  assert v1.pdf_order_number <> pg_temp.route_number(o.display_number), 'not the old form';
  -- One transaction: the Order row and V1 share its timestamp.
  assert v1.created_at = o.created_at, 'V1 was written in the transaction that created and numbered the Order';

  perform set_config('test.order_d', d::text, true);
  raise notice '3. V1 of a new Order prints % in the transaction that numbered it OK', o.display_number;
end $$;


-- ═══ 4. EDIT PI: PENDING → APPROVED ════════════════════════════════════════

do $$
declare
  d   uuid := current_setting('test.order_d')::uuid;
  dn  text := (select display_number from public.orders where id = current_setting('test.order_d')::uuid);
  v1  uuid := (select id from public.order_pi_versions where order_id = current_setting('test.order_d')::uuid and version_number = 1);
  v2  uuid;
begin
  v2 := pg_temp.propose_edit(d, 11000, 'ASSERT new D: V2 rate');
  assert (select status from public.order_pi_versions where id = v2) = 'pending', 'V2 is proposed';
  assert (select pdf_order_number from public.order_pi_versions where id = v2) = dn,
    'the proposal is numbered when it is created, before any decision';

  perform pg_temp.approve(v2);
  assert (select status from public.order_pi_versions where id = v2) = 'approved', 'V2 is in force';
  assert (select pdf_order_number from public.order_pi_versions where id = v2) = dn, 'approval does not change it';
  assert (select status from public.order_pi_versions where id = v1) = 'superseded'
     and (select pdf_order_number from public.order_pi_versions where id = v1) = dn, 'superseding V1 does not change V1''s';
  raise notice '4. Edit PI pending → approved keeps % from proposal to approval OK', dn;
end $$;


-- ═══ 5. EDIT PI: PENDING → REJECTED ════════════════════════════════════════

do $$
declare
  d   uuid := current_setting('test.order_d')::uuid;
  dn  text := (select display_number from public.orders where id = current_setting('test.order_d')::uuid);
  v3  uuid;
begin
  v3 := pg_temp.propose_edit(d, 12000, 'ASSERT new D: V3 rate');
  assert (select pdf_order_number from public.order_pi_versions where id = v3) = dn, 'V3 is numbered at the proposal';
  perform pg_temp.reject(v3, 'ASSERT new D: V3 not agreed');
  assert (select status from public.order_pi_versions where id = v3) = 'rejected', 'V3 is rejected';
  assert (select pdf_order_number from public.order_pi_versions where id = v3) = dn, 'rejection does not change it';
  raise notice '5. Edit PI pending → rejected keeps % OK', dn;
end $$;


-- ═══ 6. A REVISED WORKBOOK IS NUMBERED AT THE PROPOSAL TOO ═════════════════

do $$
declare
  d   uuid := current_setting('test.order_d')::uuid;
  dn  text := (select display_number from public.orders where id = current_setting('test.order_d')::uuid);
  v4  uuid;
begin
  v4 := pg_temp.propose_workbook(d, 'ASSERT new D: V4 workbook');
  assert v4 is not null and (select status from public.order_pi_versions where id = v4) = 'pending', 'V4 is proposed';
  assert (select pdf_order_number from public.order_pi_versions where id = v4) = dn, 'a workbook revision is numbered at the proposal';
  perform pg_temp.reject(v4, 'ASSERT new D: V4 not agreed');
  assert (select pdf_order_number from public.order_pi_versions where id = v4) = dn, 'and keeps it through the rejection';
  raise notice '6. revised workbook numbered at the proposal and kept OK';
end $$;


-- ═══ 7. DIRECT WRITES ══════════════════════════════════════════════════════

do $$
declare
  d    uuid := current_setting('test.order_d')::uuid;
  dn   text := (select display_number from public.orders where id = current_setting('test.order_d')::uuid);
  sub  uuid := (select source_order_submission_id from public.orders where id = current_setting('test.order_d')::uuid);
  v1   uuid := (select id from public.order_pi_versions where order_id = current_setting('test.order_d')::uuid and version_number = 1);
  old1 uuid := (select v.id from public.order_pi_versions v join public.orders o on o.id = v.order_id
                 where o.client_name = 'ASSERT pdfnum prior C' and v.version_number = 1);
  vx   uuid;
  e    text;
begin
  -- A direct insert's own value is ignored: the version prints the Order's number.
  insert into public.order_pi_versions (order_id, submission_id, version_number, status, revision_reason, pdf_order_number)
  values (d, sub, (select max(version_number) + 1 from public.order_pi_versions where order_id = d), 'pending',
          'ASSERT direct insert', 'X-999')
  returning id into vx;
  assert (select pdf_order_number from public.order_pi_versions where id = vx) = dn,
    'the caller''s value is replaced by the Order''s number';

  -- No change, by anyone, to anything.
  e := pg_temp.fails_with(format('update public.order_pi_versions set pdf_order_number = %L where id = %L', '4', v1));
  assert e like 'PI_PDF_ORDER_NUMBER_IMMUTABLE:%', 'the owner cannot change it: ' || e;
  e := pg_temp.fails_with(format('update public.order_pi_versions set pdf_order_number = null where id = %L', v1));
  assert e like 'PI_PDF_ORDER_NUMBER_IMMUTABLE:%', 'nor clear it: ' || e;
  e := pg_temp.fails_with(format('update public.order_pi_versions set pdf_order_number = %L where id = %L',
                                 (select display_number from public.orders where client_name = 'ASSERT pdfnum prior C'), old1));
  assert e like 'PI_PDF_ORDER_NUMBER_IMMUTABLE:%', 'an earlier version cannot be "upgraded" to the four-digit form: ' || e;
  e := pg_temp.fails_with(format('update public.order_pi_versions set pdf_order_number = %L where id = %L', '9', vx));
  assert e like 'PI_PDF_ORDER_NUMBER_IMMUTABLE:%', 'nor can a pending one: ' || e;
  e := pg_temp.fails_with(format(
    'do $b$ begin set local role service_role; update public.order_pi_versions set pdf_order_number = %L where id = %L; end $b$', '4', v1));
  assert e like 'PI_PDF_ORDER_NUMBER_IMMUTABLE:%', 'service_role cannot change it: ' || e;
  execute 'reset role';
  e := pg_temp.fails_with(format(
    'do $b$ begin perform pg_temp.become(%L); update public.order_pi_versions set pdf_order_number = %L where id = %L; end $b$',
    current_setting('test.admin_id'), '4', v1));
  assert e like 'permission denied%', 'a signed-in user has no UPDATE at all: ' || e;
  perform pg_temp.restore();

  -- Writing the same value (a no-op) is not a change.
  update public.order_pi_versions set pdf_order_number = pdf_order_number where id = v1;
  assert (select pdf_order_number from public.order_pi_versions where id = v1) = dn, 'unchanged';

  -- An Order with no number cannot get a version. (Only reachable by lifting
  -- the Order's own NOT NULL, CHECK and guards, which this transaction does
  -- and rolls back.)
  alter table public.orders disable trigger user;
  alter table public.orders drop constraint orders_display_number_four_digit;
  alter table public.orders alter column display_number drop not null;
  update public.orders set display_number = null where id = d;
  e := pg_temp.fails_with(format(
    'insert into public.order_pi_versions (order_id, submission_id, version_number, status, revision_reason) values (%L, %L, 99, %L, %L)',
    d, sub, 'pending', 'ASSERT no number'));
  assert e like 'ORDER_PI_VERSION_ORDER_NUMBER_MISSING:%', 'an Order without a number: ' || e;
  update public.orders set display_number = '   ' where id = d;
  e := pg_temp.fails_with(format(
    'insert into public.order_pi_versions (order_id, submission_id, version_number, status, revision_reason) values (%L, %L, 99, %L, %L)',
    d, sub, 'pending', 'ASSERT blank number'));
  assert e like 'ORDER_PI_VERSION_ORDER_NUMBER_MISSING:%', 'an Order with a blank number: ' || e;
  update public.orders set display_number = dn where id = d;
  alter table public.orders alter column display_number set not null;
  alter table public.orders add constraint orders_display_number_four_digit
    check (display_number ~ '^[0-9]{4}$' and display_number <> '0000');
  alter table public.orders enable trigger user;

  -- The column itself refuses NULL and blank, whatever a trigger does.
  assert (select attnotnull from pg_attribute where attrelid = 'public.order_pi_versions'::regclass and attname = 'pdf_order_number'),
    'pdf_order_number is NOT NULL';
  assert exists (select 1 from pg_constraint where conname = 'order_pi_versions_pdf_order_number_present'), 'and non-blank';
  raise notice '7. direct writes: insert value ignored, every change refused, no number no version OK';
end $$;


-- ═══ 8. READING IS UNCHANGED ═══════════════════════════════════════════════

do $$
declare
  d    uuid := current_setting('test.order_d')::uuid;
  dn   text := (select display_number from public.orders where id = current_setting('test.order_d')::uuid);
  n    int;
  vals text[];
begin
  assert (select array_agg(polname::text || ':' || coalesce(pg_get_expr(polqual, polrelid), '') order by polname)
            from pg_policy where polrelid = 'public.order_pi_versions'::regclass)
       = array['order_pi_versions_module_entry_gate:module_entry_open(''orders''::text)',
               'order_pi_versions_select:(can_view_order(order_id) OR can_view_order_submission(submission_id))'],
    'the policies on order_pi_versions are exactly as before';
  assert has_column_privilege('authenticated', 'public.order_pi_versions', 'pdf_order_number', 'SELECT'),
    'signed-in users may select the column (the table grant covers it)';
  assert not has_column_privilege('authenticated', 'public.order_pi_versions', 'pdf_order_number', 'UPDATE'),
    'but not update it';
  assert not has_column_privilege('anon', 'public.order_pi_versions', 'pdf_order_number', 'SELECT'),
    'and anon cannot read it';

  -- Sales, who can see the Order, reads the number the route will print.
  perform pg_temp.become(current_setting('test.sales_id')::uuid);
  select count(*), array_agg(distinct pdf_order_number) into n, vals from public.order_pi_versions where order_id = d;
  perform pg_temp.restore();
  assert n >= 4 and vals = array[dn], format('Sales reads %s versions, all %s: %s', n, dn, vals::text);

  -- Someone without Orders access reads nothing.
  perform pg_temp.become(current_setting('test.outsider_id')::uuid);
  select count(*) into n from public.order_pi_versions where order_id = d;
  perform pg_temp.restore();
  assert n = 0, 'an outsider reads no versions: ' || n;
  raise notice '8. reading: policies unchanged; Sales sees %, an outsider sees nothing OK', dn;
end $$;

do $$ begin raise notice 'ALL PI PDF ORDER NUMBER ASSERTIONS PASSED'; end $$;

rollback;

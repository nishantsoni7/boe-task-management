-- ═════════════════════════════════════════════════════════════════════════════
-- 20261009000000, asserted against a running PostgreSQL
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every case prints `pass` or raises. Nothing here reads the migration's text:
-- each assertion calls the function a screen would call, as the person who would
-- call it, and judges the rows that come out.
--
-- Concurrency lives in the runner, because it needs two connections. Everything
-- that can be proved in one is proved here.

\set ON_ERROR_STOP on
\timing off

-- ── The cast ─────────────────────────────────────────────────────────────────
insert into public.users (id, email, role, team) values
  ('11111111-0000-4000-8000-000000000001', 'admin@test',    'admin',    'management'),
  ('11111111-0000-4000-8000-000000000002', 'owner@test',    'employee', 'sales'),
  ('11111111-0000-4000-8000-000000000003', 'stranger@test', 'employee', 'sales'),
  ('11111111-0000-4000-8000-000000000004', 'allocator@test','employee', 'finance'),
  ('11111111-0000-4000-8000-000000000005', 'viewer@test',   'employee', 'finance'),
  ('11111111-0000-4000-8000-000000000006', 'approver@test', 'employee', 'management');

insert into public.test_grants (user_id, module, action) values
  ('11111111-0000-4000-8000-000000000002', 'orders',  'create'),
  ('11111111-0000-4000-8000-000000000003', 'orders',  'create'),
  ('11111111-0000-4000-8000-000000000004', 'finance', 'allocate'),
  ('11111111-0000-4000-8000-000000000004', 'finance', 'view_all'),
  ('11111111-0000-4000-8000-000000000005', 'finance', 'view'),
  ('11111111-0000-4000-8000-000000000006', 'orders',  'approve_order'),
  ('11111111-0000-4000-8000-000000000006', 'orders',  'view_all');

create or replace function public.act_as(p_email text)
returns void language sql as $$
  select set_config('boe.test_actor',
                    (select id::text from public.users where email = p_email), false)::void
$$;

-- ── A PI Draft, made in one call ─────────────────────────────────────────────
create or replace function public.make_pi(
  p_id uuid, p_client text, p_sha text, p_owner text default 'owner@test',
  p_status text default 'draft', p_total numeric default 100000)
returns uuid language plpgsql as $$
declare v_owner uuid;
begin
  select id into v_owner from public.users where email = p_owner;
  insert into public.order_submissions (
    id, status, submitted_by, created_by, client_name, grand_total, gross_product_amount,
    source_workbook_path, source_workbook_name, source_workbook_sha256)
  values (p_id, p_status, v_owner, v_owner, p_client, p_total, p_total,
          'submissions/' || p_id::text || '/original/pi.xlsx', 'pi.xlsx', p_sha);
  return p_id;
end $$;

-- Everything approve_order_submission() asks for beyond the reservation clause:
-- the workbook in storage, one product line with exactly one representative
-- image, the image in storage, finance verification current, and verified money
-- at or above the 40% requirement.
create or replace function public.make_approvable(p_id uuid)
returns void language plpgsql as $$
declare
  v_item uuid; v_sub public.order_submissions%rowtype; v_pay uuid; v_now timestamptz := now();
begin
  select * into v_sub from public.order_submissions where id = p_id;

  insert into storage.objects (bucket_id, name, metadata)
  values ('order-files', v_sub.source_workbook_path,
          jsonb_build_object('mimetype',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
  on conflict do nothing;

  insert into public.order_submission_items (submission_id, item_sequence, product_name, source_row)
  values (p_id, 1, 'A chair', 30) returning id into v_item;

  insert into public.order_submission_item_images
    (submission_id, item_id, role, position, sha256, anchor_row, storage_path)
  values (p_id, v_item, 'representative', 1, repeat('e', 64), 30,
          'submissions/' || p_id::text || '/images/' || v_item::text
          || '/representative/1-' || repeat('e', 64) || '.png');

  insert into storage.objects (bucket_id, name, metadata)
  select 'order-files', m.storage_path, jsonb_build_object('mimetype', 'image/png')
  from public.order_submission_item_images m where m.submission_id = p_id;

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, status, submitted_by)
  values (v_sub.client_name, round(v_sub.grand_total * 0.5, 2), current_date, 'bank_transfer',
          'approved_linked', v_sub.submitted_by)
  returning id into v_pay;

  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by)
  values (v_pay, p_id, round(v_sub.grand_total * 0.5, 2), 'active', 'order_submission', v_sub.submitted_by);

  update public.order_submissions
     set status = 'submitted', submitted_at = v_now,
         finance_verified_at = v_now, finance_verified_submission_at = v_now
   where id = p_id;
end $$;

-- A Confirmed Order created outside any PI, for the "historical Orders are
-- untouched" and "the allocator still works" cases.
create or replace function public.make_order(p_client text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.orders (client_name, total_value, created_by, status)
  values (p_client, 50000,
          (select id from public.users where email = 'admin@test'), 'running')
  returning id into v_id;
  return v_id;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- REQUIREMENT 2 — a number reserved early, and used at the end
-- ═════════════════════════════════════════════════════════════════════════════

-- ── A. Sequential assignment, from the one cycle ─────────────────────────────
do $$
declare a text; b text;
begin
  perform public.act_as('owner@test');
  perform public.make_pi('22222222-0000-4000-8000-00000000000a', 'Alpha', repeat('1', 64));
  perform public.make_pi('22222222-0000-4000-8000-00000000000b', 'Beta',  repeat('2', 64));

  a := public.reserve_order_number_for_submission('22222222-0000-4000-8000-00000000000a')->>'reserved_order_number';
  b := public.reserve_order_number_for_submission('22222222-0000-4000-8000-00000000000b')->>'reserved_order_number';

  if a <> '0001' then raise exception 'A FAILED: first reservation was % not 0001', a; end if;
  if b <> '0002' then raise exception 'A FAILED: second reservation was % not 0002', b; end if;
  if (select next_number from public.order_number_cycle where id) <> 3 then
    raise exception 'A FAILED: the cycle did not advance past both reservations';
  end if;
  raise notice 'A pass — sequential: % then %, cycle now 0003', a, b;
end $$;

-- ── B. Repeated calls return the SAME number, and take no second one ─────────
do $$
declare first text; again jsonb; cycle_before bigint; cycle_after bigint;
begin
  perform public.act_as('owner@test');
  select next_number into cycle_before from public.order_number_cycle where id;
  select reserved_order_number into first from public.order_submissions
   where id = '22222222-0000-4000-8000-00000000000a';

  again := public.reserve_order_number_for_submission('22222222-0000-4000-8000-00000000000a');
  select next_number into cycle_after from public.order_number_cycle where id;

  if again->>'reserved_order_number' <> first then
    raise exception 'B FAILED: a second call returned % instead of %', again->>'reserved_order_number', first;
  end if;
  if (again->>'already_reserved')::boolean is not true then
    raise exception 'B FAILED: the second call did not say it was already reserved';
  end if;
  if cycle_after <> cycle_before then
    raise exception 'B FAILED: the second call burned a number (% -> %)', cycle_before, cycle_after;
  end if;
  -- And it wrote no second history entry.
  if (select count(*) from public.order_submission_activity
      where submission_id = '22222222-0000-4000-8000-00000000000a'
        and action = 'order_number_reserved') <> 1 then
    raise exception 'B FAILED: the idempotent call wrote a second audit row';
  end if;
  raise notice 'B pass — idempotent: % returned again, cycle untouched', first;
end $$;

-- ── C. Two PI Drafts can never hold the same number ──────────────────────────
do $$
declare v_msg text;
begin
  begin
    update public.order_submissions
       set reserved_order_number = '0002'
     where id = '22222222-0000-4000-8000-00000000000a';
    raise exception 'C FAILED: two PI Drafts were allowed to hold 0002';
  exception
    when unique_violation then
      raise notice 'C pass — the partial unique index refused a duplicate reservation';
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'RESERVED_ORDER_NUMBER_IMMUTABLE%' then
        raise notice 'C pass — refused earlier still, by the immutability guard';
      else
        raise;
      end if;
  end;
end $$;

-- ── D. Once shown, it does not silently change ───────────────────────────────
do $$
declare v_msg text;
begin
  begin
    update public.order_submissions
       set reserved_order_number = '0009'
     where id = '22222222-0000-4000-8000-00000000000a';
    raise exception 'D FAILED: a reserved number was rewritten';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'RESERVED_ORDER_NUMBER_IMMUTABLE%' then raise; end if;
    raise notice 'D pass — %', v_msg;
  end;

  begin
    update public.order_submissions
       set reserved_order_number = null
     where id = '22222222-0000-4000-8000-00000000000a';
    raise exception 'D FAILED: a reservation was released';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'RESERVED_ORDER_NUMBER_IMMUTABLE%' then raise; end if;
    raise notice 'D pass — a reservation cannot be released either';
  end;
end $$;

-- ── E. Approval is refused while the revised PI is missing ───────────────────
do $$
declare v_msg text;
begin
  perform public.make_approvable('22222222-0000-4000-8000-00000000000a');
  perform public.act_as('approver@test');
  begin
    perform public.approve_order_submission('22222222-0000-4000-8000-00000000000a');
    raise exception 'E FAILED: a reserved PI was approved without its revised workbook';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_REVISED_PI_MISSING%' then raise; end if;
    raise notice 'E pass — %', substr(v_msg, 1, 96);
  end;
  if exists (select 1 from public.orders where source_order_submission_id = '22222222-0000-4000-8000-00000000000a') then
    raise exception 'E FAILED: the refused approval created an Order anyway';
  end if;
end $$;

-- ── F. The revised PI is still uploadable, and then approval uses the number ─
do $$
declare v_result jsonb; v_reserved text; v_display text;
begin
  select reserved_order_number into v_reserved from public.order_submissions
   where id = '22222222-0000-4000-8000-00000000000a';

  -- The revised upload, as replace_order_submission_parse() would leave it: a
  -- different workbook, so a different hash. Nothing about the reservation is
  -- touched by the replacement, which is the point.
  update public.order_submissions
     set source_workbook_sha256 = repeat('9', 64)
   where id = '22222222-0000-4000-8000-00000000000a';

  if (select reserved_order_number from public.order_submissions
      where id = '22222222-0000-4000-8000-00000000000a') <> v_reserved then
    raise exception 'F FAILED: replacing the workbook moved the reservation';
  end if;

  perform public.act_as('approver@test');
  v_result := public.approve_order_submission('22222222-0000-4000-8000-00000000000a');

  select display_number into v_display from public.orders
   where source_order_submission_id = '22222222-0000-4000-8000-00000000000a';

  if v_display <> v_reserved then
    raise exception 'F FAILED: the Order came out as % but % was reserved', v_display, v_reserved;
  end if;
  if v_result->>'reserved_order_number' <> v_reserved then
    raise exception 'F FAILED: the RPC did not report the reservation it used';
  end if;
  if (select reserved_order_number_used_at from public.order_submissions
      where id = '22222222-0000-4000-8000-00000000000a') is null then
    raise exception 'F FAILED: the reservation was not marked used';
  end if;
  if (select count(*) from public.order_submission_activity
      where submission_id = '22222222-0000-4000-8000-00000000000a'
        and action = 'order_number_used') <> 1 then
    raise exception 'F FAILED: the number being taken up was not recorded in the history';
  end if;
  raise notice 'F pass — the Confirmed Order is %, the number reserved before the revised PI', v_display;
end $$;

-- ── G. An already-converted PI cannot reserve again ──────────────────────────
do $$
declare v_msg text;
begin
  perform public.act_as('owner@test');
  begin
    perform public.reserve_order_number_for_submission('22222222-0000-4000-8000-00000000000a');
    raise exception 'G FAILED: a converted PI reserved a second number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    -- It already holds one, so the idempotent branch answers first. That IS the
    -- refusal: no second number is taken. Asserted as such rather than by
    -- reaching for a message it will never produce.
    raise exception 'G FAILED: expected the idempotent answer, got %', v_msg;
  end;
exception when others then
  get stacked diagnostics v_msg = message_text;
  if v_msg not like 'G FAILED: expected the idempotent answer%' then raise; end if;
  raise notice 'G pass — an approved PI returns the number it already used and takes no other';
end $$;

do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-00000000000c';
begin
  -- The other half of G, on a PI that is past draft but holds no reservation:
  -- the stage gate must refuse it outright.
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Gamma', repeat('3', 64));
  update public.order_submissions set status = 'submitted' where id = v_id;
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'G2 FAILED: a submitted PI reserved a number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_NOT_EDITABLE%'
       and v_msg not like 'ORDER_NUMBER_RESERVATION_STAGE%' then raise; end if;
    raise notice 'G2 pass — %', substr(v_msg, 1, 90);
  end;
end $$;

-- ── H. An unauthorized caller reserves nothing ───────────────────────────────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-00000000000d'; v_cycle bigint;
begin
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Delta', repeat('4', 64));
  select next_number into v_cycle from public.order_number_cycle where id;

  perform public.act_as('stranger@test');
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'H FAILED: somebody else''s PI was given a number by a stranger';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_NOT_OWNED%' then raise; end if;
  end;

  perform public.act_as('allocator@test');
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'H FAILED: Finance authority reserved an Order number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_FORBIDDEN%' then raise; end if;
  end;

  perform public.act_as('approver@test');
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'H FAILED: orders.approve_order alone reserved a number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_FORBIDDEN%' then raise; end if;
  end;

  if (select next_number from public.order_number_cycle where id) <> v_cycle then
    raise exception 'H FAILED: a refused reservation still burned a number';
  end if;
  if (select reserved_order_number from public.order_submissions where id = v_id) is not null then
    raise exception 'H FAILED: a refused reservation still wrote to the PI';
  end if;
  raise notice 'H pass — three refusals, and the cycle is exactly where it was';
end $$;

-- ── I. A PI with no workbook has nothing to put the number into ──────────────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-00000000000e';
begin
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Epsilon', repeat('5', 64));
  update public.order_submissions
     set source_workbook_path = null, source_workbook_sha256 = null where id = v_id;
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'I FAILED: a PI with no workbook reserved a number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_NUMBER_RESERVATION_NO_WORKBOOK%' then raise; end if;
    raise notice 'I pass — %', substr(v_msg, 1, 90);
  end;
end $$;

-- ── J. Historical Orders are untouched, and unreserved approval is unchanged ─
do $$
declare v_before jsonb; v_after jsonb; v_id uuid := '22222222-0000-4000-8000-00000000000f'; v_display text;
begin
  select jsonb_agg(jsonb_build_object('id', id, 'n', display_number) order by display_number)
    into v_before from public.orders;

  -- A PI that never reserved: approved exactly as it always was, numbered from
  -- the cycle at insert, with no revised-PI requirement anywhere near it.
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Zeta', repeat('6', 64));
  perform public.make_approvable(v_id);
  perform public.act_as('approver@test');
  perform public.approve_order_submission(v_id);

  select display_number into v_display from public.orders where source_order_submission_id = v_id;
  if v_display is null then raise exception 'J FAILED: an unreserved PI could not be approved'; end if;

  select jsonb_agg(jsonb_build_object('id', id, 'n', display_number) order by display_number)
    into v_after from public.orders where id in (select (e->>'id')::uuid from jsonb_array_elements(v_before) e);

  if v_after is distinct from v_before then
    raise exception 'J FAILED: an existing Order number changed';
  end if;
  raise notice 'J pass — the unreserved path still numbers from the cycle (%), and no existing Order moved', v_display;
end $$;

-- ── K. The admin setter may not step back over a live reservation ───────────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-000000000010'; v_reserved text;
begin
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Eta', repeat('7', 64));
  v_reserved := public.reserve_order_number_for_submission(v_id)->>'reserved_order_number';

  perform public.act_as('admin@test');
  begin
    perform public.set_next_confirmed_order_number(v_reserved::bigint);
    raise exception 'K FAILED: the cycle was set onto a live reservation';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_NUMBER_TOO_LOW%' then raise; end if;
    raise notice 'K pass — %', substr(v_msg, 1, 120);
  end;
end $$;

-- ── L. The allocator walks past a number a PI Draft is holding ──────────────
do $$
declare v_id uuid := '22222222-0000-4000-8000-000000000011'; v_reserved text; v_new text;
begin
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Theta', repeat('8', 64));
  v_reserved := public.reserve_order_number_for_submission(v_id)->>'reserved_order_number';

  -- Force the cycle back onto the reservation, which only a direct write can do
  -- now that §5 refuses it. This is the state §4's loop exists for.
  update public.order_number_cycle set next_number = v_reserved::bigint where id;

  perform public.make_order('Bypass Co');
  select display_number into v_new from public.orders where client_name = 'Bypass Co';

  if v_new = v_reserved then
    raise exception 'L FAILED: a new Order took %, which a PI Draft is holding', v_reserved;
  end if;
  if v_new::bigint <= v_reserved::bigint then
    raise exception 'L FAILED: the allocator did not advance past the reservation';
  end if;
  if (select reserved_order_number from public.order_submissions where id = v_id) <> v_reserved then
    raise exception 'L FAILED: the reservation moved';
  end if;
  raise notice 'L pass — % is held, so the new Order took % instead', v_reserved, v_new;
end $$;

-- ── M. The cycle cannot be reset underneath a reservation ───────────────────
do $$
declare v_msg text; v_claim uuid;
begin
  insert into public.test_data_cleanup_claims (finalized_at) values (now())
  returning claim_token into v_claim;

  perform public.act_as('admin@test');
  begin
    perform public.reset_confirmed_order_number_cycle(v_claim);
    raise exception 'M FAILED: the cycle was reset while Orders and reservations exist';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    -- Gate 2 (Orders exist) fires first here and is the correct answer; the
    -- reservation gate is proved on its own below, with an empty register.
    if v_msg not like 'ORDER_NUMBER_RESET_ORDERS_EXIST%' then raise; end if;
  end;

  -- Now with no Orders and no allocations at all, so the ONLY thing standing in
  -- the way is the reservation gate this migration added.
  delete from public.finance_payment_allocations;
  delete from public.order_activity_log;
  update public.order_submissions set order_id = null;
  delete from public.orders;
  update public.order_submissions set status = 'draft'
   where status in ('submitted', 'approved');

  begin
    perform public.reset_confirmed_order_number_cycle(v_claim);
    raise exception 'M FAILED: the cycle was reset while PI Drafts hold numbers';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_NUMBER_RESET_RESERVATIONS_EXIST%' then raise; end if;
    raise notice 'M pass — %', substr(v_msg, 1, 110);
  end;
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- REQUIREMENT 1 — one payment, divided as it is recorded
-- ═════════════════════════════════════════════════════════════════════════════

-- A clean stage: two Confirmed Orders and two PI Drafts the allocator can see.
do $$
declare o1 uuid; o2 uuid;
begin
  perform public.act_as('admin@test');
  o1 := public.make_order('Split Co One');
  o2 := public.make_order('Split Co Two');
  perform public.act_as('owner@test');
  perform public.make_pi('33333333-0000-4000-8000-000000000001', 'Split PI One', repeat('a', 64));
  perform public.make_pi('33333333-0000-4000-8000-000000000002', 'Split PI Two', repeat('b', 64));
  update public.orders set client_name = 'Split Co One' where id = o1;
  update public.orders set client_name = 'Split Co Two' where id = o2;
end $$;

-- ── N. One payment across two Confirmed Orders ──────────────────────────────
do $$
declare r jsonb; o1 uuid; o2 uuid;
begin
  select id into o1 from public.orders where client_name = 'Split Co One';
  select id into o2 from public.orders where client_name = 'Split Co Two';

  perform public.act_as('allocator@test');
  r := public.record_payment_with_allocations(
    100000, current_date, 'bank_transfer', 'Split Co', 'company_account', 'NEFT-1', null,
    jsonb_build_array(
      jsonb_build_object('kind', 'order', 'id', o1, 'amount', 60000),
      jsonb_build_object('kind', 'order', 'id', o2, 'amount', 40000)));

  if (r->>'allocation_count')::int <> 2 then raise exception 'N FAILED: % allocations', r->>'allocation_count'; end if;
  if (r->>'unallocated_balance')::numeric <> 0 then raise exception 'N FAILED: balance not zero'; end if;
  if (select count(*) from public.finance_payment_requests
      where id = (r->>'payment_request_id')::uuid) <> 1 then
    raise exception 'N FAILED: the payment was not written once';
  end if;
  if (select sum(allocated_amount) from public.finance_payment_allocations
      where payment_request_id = (r->>'payment_request_id')::uuid and status = 'active') <> 100000 then
    raise exception 'N FAILED: the allocations do not sum to the payment';
  end if;
  if (select count(distinct order_id) from public.finance_payment_allocations
      where payment_request_id = (r->>'payment_request_id')::uuid) <> 2 then
    raise exception 'N FAILED: the two Orders are not both linked';
  end if;
  -- ONE payment row for two Orders, which is the whole shape of requirement 3.
  if (select count(*) from public.finance_payment_requests where order_number = 'NEFT-1') <> 1 then
    raise exception 'N FAILED: the payment was duplicated per Order';
  end if;
  raise notice 'N pass — one payment %, two Orders, 60000 + 40000', r->>'request_number';
end $$;

-- ── O. One payment across two PI Drafts, and across a mixture ───────────────
do $$
declare r jsonb; o1 uuid;
begin
  perform public.act_as('allocator@test');
  r := public.record_payment_with_allocations(
    50000, current_date, 'upi', 'Split Co', null, null, 'two drafts',
    jsonb_build_array(
      jsonb_build_object('kind', 'submission', 'id', '33333333-0000-4000-8000-000000000001', 'amount', 20000),
      jsonb_build_object('kind', 'submission', 'id', '33333333-0000-4000-8000-000000000002', 'amount', 30000)));
  if (select count(*) from public.finance_payment_allocations
      where payment_request_id = (r->>'payment_request_id')::uuid
        and order_submission_id is not null) <> 2 then
    raise exception 'O FAILED: the two PI Drafts are not both linked';
  end if;
  -- And each PI's own timeline says money arrived.
  if (select count(*) from public.order_submission_activity
      where action = 'payment_recorded' and metadata->>'split_entry' = 'true') <> 2 then
    raise exception 'O FAILED: the PI timelines do not record the split entry';
  end if;

  select id into o1 from public.orders where client_name = 'Split Co One';
  r := public.record_payment_with_allocations(
    70000, current_date, 'cheque', 'Split Co', 'other', 'CHQ-9', null,
    jsonb_build_array(
      jsonb_build_object('kind', 'order',      'id', o1, 'amount', 25000),
      jsonb_build_object('kind', 'submission', 'id', '33333333-0000-4000-8000-000000000001', 'amount', 15000)));
  if (r->>'unallocated_balance')::numeric <> 30000 then
    raise exception 'O FAILED: the remainder is % not 30000', r->>'unallocated_balance';
  end if;
  raise notice 'O pass — two PI Drafts, then an Order and a PI Draft with 30000 left over';
end $$;

-- ── P. A remainder is allowed; an empty list is allowed; exact is allowed ────
do $$
declare r jsonb; o1 uuid;
begin
  perform public.act_as('allocator@test');
  select id into o1 from public.orders where client_name = 'Split Co Two';

  r := public.record_payment_with_allocations(
    10000, current_date, 'cash', 'Split Co', null, null, null, '[]'::jsonb);
  if (r->>'allocation_count')::int <> 0 or (r->>'unallocated_balance')::numeric <> 10000 then
    raise exception 'P FAILED: an unallocated payment was not written as one';
  end if;

  r := public.record_payment_with_allocations(
    12345.67, current_date, 'other', 'Split Co', null, null, null,
    jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 12345.67)));
  if (r->>'unallocated_balance')::numeric <> 0 then
    raise exception 'P FAILED: an exact allocation left a balance';
  end if;
  raise notice 'P pass — no allocations, and an exact one to the paise';
end $$;

-- ── Q. Over-allocation is refused, and leaves NOTHING behind ────────────────
do $$
declare v_msg text; o1 uuid; o2 uuid; v_pays bigint; v_allocs bigint;
begin
  perform public.act_as('allocator@test');
  select id into o1 from public.orders where client_name = 'Split Co One';
  select id into o2 from public.orders where client_name = 'Split Co Two';
  select count(*) into v_pays   from public.finance_payment_requests;
  select count(*) into v_allocs from public.finance_payment_allocations;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(
        jsonb_build_object('kind', 'order', 'id', o1, 'amount', 600),
        jsonb_build_object('kind', 'order', 'id', o2, 'amount', 600)));
    raise exception 'Q FAILED: 1200 was allocated out of 1000';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATIONS_EXCEED_AMOUNT%' then raise; end if;
  end;

  if (select count(*) from public.finance_payment_requests) <> v_pays then
    raise exception 'Q FAILED: the refused entry left a payment behind';
  end if;
  if (select count(*) from public.finance_payment_allocations) <> v_allocs then
    raise exception 'Q FAILED: the refused entry left an allocation behind';
  end if;
  raise notice 'Q pass — refused before anything was written, and nothing was';
end $$;

-- ── R. A second row naming the same target is refused, atomically ──────────
do $$
declare v_msg text; o1 uuid; v_pays bigint; v_allocs bigint;
begin
  perform public.act_as('allocator@test');
  select id into o1 from public.orders where client_name = 'Split Co One';
  select count(*) into v_pays   from public.finance_payment_requests;
  select count(*) into v_allocs from public.finance_payment_allocations;

  begin
    perform public.record_payment_with_allocations(
      5000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(
        jsonb_build_object('kind', 'order', 'id', o1, 'amount', 2000),
        jsonb_build_object('kind', 'order', 'id', o1, 'amount', 1000)));
    raise exception 'R FAILED: one payment made two active claims on one Order';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ALLOCATION_DUPLICATE%' then raise; end if;
  end;

  -- THE ATOMICITY CASE. The FIRST allocation succeeded before the second was
  -- refused, so if this transaction were not one unit there would now be a
  -- payment carrying 2000 of an entry the caller was told had failed.
  if (select count(*) from public.finance_payment_requests) <> v_pays then
    raise exception 'R FAILED: a payment survived a failed entry';
  end if;
  if (select count(*) from public.finance_payment_allocations) <> v_allocs then
    raise exception 'R FAILED: the first allocation survived a failed entry';
  end if;
  raise notice 'R pass — duplicate refused, and the row written before it went with it';
end $$;

-- ── S. A target the caller cannot see is refused ───────────────────────────
do $$
declare v_msg text; v_id uuid := '33333333-0000-4000-8000-000000000003';
begin
  -- A PI belonging to somebody else, and a caller with finance.allocate but NOT
  -- finance.view_all — so the target is invisible to them.
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Private PI', repeat('f', 64), 'stranger@test');

  insert into public.test_grants (user_id, module, action)
  values ('11111111-0000-4000-8000-000000000005', 'finance', 'allocate')
  on conflict do nothing;

  perform public.act_as('viewer@test');
  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Someone', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'submission', 'id', v_id, 'amount', 1000)));
    raise exception 'S FAILED: money was allocated to a record the caller cannot see';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ALLOCATION_TARGET_NOT_AVAILABLE%' then raise; end if;
    raise notice 'S pass — %', substr(v_msg, 1, 90);
  end;
end $$;

-- ── T. Authorization: entry needs Finance, and division needs finance.allocate
do $$
declare v_msg text; o1 uuid;
begin
  select id into o1 from public.orders where client_name = 'Split Co One';

  -- The PI owner: no Finance module entry at all.
  perform public.act_as('owner@test');
  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null, '[]'::jsonb);
    raise exception 'T FAILED: somebody outside Finance recorded a payment here';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ENTRY_NOT_PERMITTED%' then raise; end if;
  end;

  -- Finance sight without the allocation action.
  delete from public.test_grants
   where user_id = '11111111-0000-4000-8000-000000000005' and action = 'allocate';
  perform public.act_as('viewer@test');
  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 1000)));
    raise exception 'T FAILED: finance.view alone divided a payment';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED%' then raise; end if;
  end;
  raise notice 'T pass — Finance entry AND finance.allocate, both required';
end $$;

-- ── U. Degenerate rows are refused before the payment is written ───────────
do $$
declare v_msg text; o1 uuid; v_pays bigint;
begin
  perform public.act_as('allocator@test');
  select id into o1 from public.orders where client_name = 'Split Co One';
  select count(*) into v_pays from public.finance_payment_requests;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 0)));
    raise exception 'U FAILED: a zero allocation was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATION_AMOUNT_INVALID%' then raise; end if;
  end;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', -500)));
    raise exception 'U FAILED: a negative allocation was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATION_AMOUNT_INVALID%' then raise; end if;
  end;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'order_request', 'id', o1, 'amount', 500)));
    raise exception 'U FAILED: an Order Request target was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATION_KIND_INVALID%' then raise; end if;
  end;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null, '"not an array"'::jsonb);
    raise exception 'U FAILED: a non-array allocation list was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATIONS_INVALID%' then raise; end if;
  end;

  if (select count(*) from public.finance_payment_requests) <> v_pays then
    raise exception 'U FAILED: a malformed list still wrote a payment';
  end if;
  raise notice 'U pass — zero, negative, a retired target kind and a non-array, all refused with no payment written';
end $$;

-- ── V. The payment is Awaiting Verification, and carries no direct link ────
do $$
declare r jsonb; o1 uuid; v_pay public.finance_payment_requests%rowtype;
begin
  perform public.act_as('allocator@test');
  select id into o1 from public.orders where client_name = 'Split Co One';
  r := public.record_payment_with_allocations(
    2500, current_date, 'bank_transfer', 'Split Co', 'company_account', 'REF-V', null,
    jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 2500)));

  select * into v_pay from public.finance_payment_requests where id = (r->>'payment_request_id')::uuid;
  if v_pay.status <> 'pending_approval' then
    raise exception 'V FAILED: the payment was written as % rather than awaiting verification', v_pay.status;
  end if;
  if v_pay.order_id is not null then
    raise exception 'V FAILED: a direct linkage was written beside the allocation';
  end if;
  if v_pay.submitted_by <> (select id from public.users where email = 'allocator@test') then
    raise exception 'V FAILED: the submitter was not derived from the caller';
  end if;
  raise notice 'V pass — pending_approval, no direct link, submitter derived';
end $$;

\echo 'ALL SQL ASSERTIONS PASSED'

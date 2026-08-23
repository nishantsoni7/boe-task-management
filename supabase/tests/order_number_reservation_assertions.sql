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
-- A LEGACY draft: created before the migration, so reservation_required is
-- false and it carries its workbook from the start. This is the pre-109
-- population, and every rule that is grandfathered is grandfathered for it.
create or replace function public.make_pi(
  p_id uuid, p_client text, p_sha text, p_owner text default 'owner@test',
  p_status text default 'draft', p_total numeric default 100000)
returns uuid language plpgsql as $$
declare v_owner uuid;
begin
  select id into v_owner from public.users where email = p_owner;
  insert into public.order_submissions (
    id, status, submitted_by, created_by, client_name, grand_total, gross_product_amount,
    reservation_required,
    source_workbook_path, source_workbook_name, source_workbook_sha256)
  values (p_id, p_status, v_owner, v_owner, p_client, p_total, p_total,
          false,
          'submissions/' || p_id::text || '/original/pi.xlsx', 'pi.xlsx', p_sha);
  return p_id;
end $$;

-- A NEW draft, created the way the product creates one: EMPTY. It has no
-- workbook and therefore no number until the first PI is uploaded and parsed,
-- which is what upload_pi() below does.
create or replace function public.make_new_pi(
  p_id uuid, p_client text, p_owner text default 'owner@test', p_total numeric default 100000)
returns uuid language plpgsql as $$
declare v_owner uuid;
begin
  select id into v_owner from public.users where email = p_owner;
  insert into public.order_submissions (
    id, status, submitted_by, created_by, client_name, grand_total, gross_product_amount)
  values (p_id, 'draft', v_owner, v_owner, p_client, p_total, p_total);
  return p_id;
end $$;

-- THE ONLY WAY A WORKBOOK EVER REACHES A PI, in this harness as in production:
-- the server parses the stored bytes and hands the header to
-- replace_order_submission_parse(). p_reference is what the parser read out of
-- B20 — a caller of the RPC cannot invent it, because the RPC is executable by
-- no client role and the route that reaches it never reads the body for it.
create or replace function public.upload_pi(
  p_id uuid, p_sha text, p_reference text default null)
returns void language plpgsql as $$
declare v_actor uuid;
begin
  select created_by into v_actor from public.order_submissions where id = p_id;
  perform public.replace_order_submission_parse(p_id, v_actor, jsonb_build_object(
    'header', jsonb_build_object('source_order_number', p_reference),
    'source_workbook_path',   'submissions/' || p_id::text || '/original/pi.xlsx',
    'source_workbook_name',   'pi.xlsx',
    'source_workbook_sha256', p_sha));
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

  -- IDEMPOTENT. Several cases call this twice on one PI — once before a refused
  -- attempt and again after correcting it — and a fixture that could only be
  -- applied once would turn a real assertion into a duplicate-key error.
  if exists (select 1 from public.order_submission_items where submission_id = p_id) then
    insert into storage.objects (bucket_id, name, metadata)
    values ('order-files', v_sub.source_workbook_path,
            jsonb_build_object('mimetype',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
    on conflict do nothing;
    return;
  end if;

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
  from public.order_submission_item_images m where m.submission_id = p_id
  on conflict do nothing;

  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, status, submitted_by)
  values (v_sub.client_name, round(v_sub.grand_total * 0.5, 2), current_date, 'bank_transfer',
          'approved_linked', v_sub.submitted_by)
  returning id into v_pay;

  insert into public.finance_payment_allocations
    (payment_request_id, order_submission_id, allocated_amount, status, origin_target_type, created_by)
  values (v_pay, p_id, round(v_sub.grand_total * 0.5, 2), 'active', 'order_submission', v_sub.submitted_by);

  -- DELIBERATELY DOES NOT SUBMIT. Moving the status is what the submit gate
  -- guards, so a test that wants to watch it be refused has to be able to
  -- attempt it on its own. submit_pi() below is that attempt.
end $$;

-- The transition into review, on its own, so the gate that guards it can be
-- tested rather than hidden inside a fixture.
create or replace function public.submit_pi(p_id uuid)
returns void language plpgsql as $$
declare v_now timestamptz := now();
begin
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
-- REQUIREMENT 2 — a number reserved early, PROVED to be on the revised PI,
--                 and used at the end
-- ═════════════════════════════════════════════════════════════════════════════

-- ── A. A NEW draft takes its number automatically, the moment it has a PI ───
do $$
declare a text; b text; v_auto boolean;
begin
  perform public.act_as('owner@test');
  perform public.make_new_pi('22222222-0000-4000-8000-00000000000a', 'Alpha');
  perform public.make_new_pi('22222222-0000-4000-8000-00000000000b', 'Beta');

  -- Nothing yet: an empty draft has nothing to put a number into.
  if (select reserved_order_number from public.order_submissions
      where id = '22222222-0000-4000-8000-00000000000a') is not null then
    raise exception 'A FAILED: an empty draft was given a number';
  end if;

  -- The initial PI upload. NOBODY PRESSED ANYTHING.
  perform public.upload_pi('22222222-0000-4000-8000-00000000000a', repeat('1', 64), 'OLD-PI-7788');
  perform public.upload_pi('22222222-0000-4000-8000-00000000000b', repeat('2', 64), null);

  select reserved_order_number into a from public.order_submissions
   where id = '22222222-0000-4000-8000-00000000000a';
  select reserved_order_number into b from public.order_submissions
   where id = '22222222-0000-4000-8000-00000000000b';

  if a <> '0001' then raise exception 'A FAILED: first reservation was % not 0001', a; end if;
  if b <> '0002' then raise exception 'A FAILED: second reservation was % not 0002', b; end if;
  if (select next_number from public.order_number_cycle where id) <> 3 then
    raise exception 'A FAILED: the cycle did not advance past both reservations';
  end if;

  -- And it is recorded as automatic, exactly once.
  select (metadata->>'automatic')::boolean into v_auto
  from public.order_submission_activity
  where submission_id = '22222222-0000-4000-8000-00000000000a' and action = 'order_number_reserved';
  if v_auto is not true then raise exception 'A FAILED: the reservation was not recorded as automatic'; end if;
  if (select count(*) from public.order_submission_activity
      where submission_id = '22222222-0000-4000-8000-00000000000a'
        and action = 'order_number_reserved') <> 1 then
    raise exception 'A FAILED: more than one audit row for one reservation';
  end if;

  raise notice 'A pass — automatic on first upload: % then %, nobody clicked anything', a, b;
end $$;

-- ── B. Re-uploading does not take a second number ──────────────────────────
do $$
declare first text; cycle_before bigint;
begin
  select next_number into cycle_before from public.order_number_cycle where id;
  select reserved_order_number into first from public.order_submissions
   where id = '22222222-0000-4000-8000-00000000000a';

  -- The revised upload, and then another correction after it.
  perform public.upload_pi('22222222-0000-4000-8000-00000000000a', repeat('3', 64), first);
  perform public.upload_pi('22222222-0000-4000-8000-00000000000a', repeat('4', 64), first);

  if (select reserved_order_number from public.order_submissions
      where id = '22222222-0000-4000-8000-00000000000a') <> first then
    raise exception 'B FAILED: re-uploading moved the reservation';
  end if;
  if (select next_number from public.order_number_cycle where id) <> cycle_before then
    raise exception 'B FAILED: re-uploading burned a number';
  end if;
  if (select count(*) from public.order_submission_activity
      where submission_id = '22222222-0000-4000-8000-00000000000a'
        and action = 'order_number_reserved') <> 1 then
    raise exception 'B FAILED: a second reservation audit row was written';
  end if;

  -- And the client door answers with the same number rather than taking another.
  perform public.act_as('owner@test');
  if public.reserve_order_number_for_submission('22222222-0000-4000-8000-00000000000a')
       ->>'reserved_order_number' <> first then
    raise exception 'B FAILED: the client door returned a different number';
  end if;
  if (select next_number from public.order_number_cycle where id) <> cycle_before then
    raise exception 'B FAILED: the client door burned a number on an already-reserved PI';
  end if;

  raise notice 'B pass — idempotent across re-uploads and clicks: % throughout', first;
end $$;

-- ── C. Two PI Drafts can never hold the same number ────────────────────────
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

-- ── D. Once shown, it does not silently change, and is never released ──────
do $$
declare v_msg text;
begin
  begin
    update public.order_submissions set reserved_order_number = '0009'
     where id = '22222222-0000-4000-8000-00000000000a';
    raise exception 'D FAILED: a reserved number was rewritten';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'RESERVED_ORDER_NUMBER_IMMUTABLE%' then raise; end if;
  end;

  begin
    update public.order_submissions set reserved_order_number = null
     where id = '22222222-0000-4000-8000-00000000000a';
    raise exception 'D FAILED: a reservation was released';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'RESERVED_ORDER_NUMBER_IMMUTABLE%' then raise; end if;
  end;

  -- And the OBLIGATION cannot be switched off to escape the workflow.
  begin
    update public.order_submissions set reservation_required = false
     where id = '22222222-0000-4000-8000-00000000000a';
    raise exception 'D FAILED: the reservation obligation was switched off';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'RESERVATION_OBLIGATION_IMMUTABLE%' then raise; end if;
  end;

  raise notice 'D pass — the number, the stamp and the obligation are all one-way';
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- THE REVISED PI MUST CONTAIN THE RESERVED NUMBER
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The rule itself, asked directly, before it is asked through a workflow. Every
-- case the correction named, and the two the hash alone used to let through.

do $$
declare
  RES  text := '0042';
  OLD  text := repeat('a', 64);
  NEW  text := repeat('b', 64);
  r    text;
begin
  -- E1. EXACT MATCH on a genuinely revised workbook.
  if public.order_submission_revised_pi_refusal(RES, OLD, NEW, '0042') is not null then
    raise exception 'E1 FAILED: an exact match on a revised workbook was refused';
  end if;

  -- E2. HARMLESS NORMALIZATION: surrounding whitespace, and case.
  for r in select unnest(array['  0042', '0042  ', E'\t0042\n', ' 0042 ']) loop
    if public.order_submission_revised_pi_refusal(RES, OLD, NEW, r) is not null then
      raise exception 'E2 FAILED: % should normalize to a match', quote_literal(r);
    end if;
  end loop;
  -- Case, on a value that has one. Digits have no case, so this proves the
  -- folding is applied rather than that it matters for today's format.
  if public.order_submission_revised_pi_refusal('00AB', OLD, NEW, ' 00ab ') is not null then
    raise exception 'E2 FAILED: case folding is not applied';
  end if;

  -- E3. THE WRONG NUMBER. The case the hash alone could never catch.
  r := public.order_submission_revised_pi_refusal(RES, OLD, NEW, '0043');
  if r is null or r not like 'ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH%' then
    raise exception 'E3 FAILED: a revised workbook carrying 0043 was accepted for 0042 (%)', coalesce(r, 'null');
  end if;
  if r not like '%0043%' or r not like '%0042%' then
    raise exception 'E3 FAILED: the refusal must name what it found AND what it wanted';
  end if;

  -- E4. A BLANK REFERENCE — no number at all, or only spaces.
  for r in select unnest(array[null, '', '   ', E'\t\n']) loop
    if public.order_submission_revised_pi_refusal(RES, OLD, NEW, r)
         not like 'ORDER_SUBMISSION_REVISED_PI_NO_NUMBER%' then
      raise exception 'E4 FAILED: a blank reference was accepted';
    end if;
  end loop;

  -- E5. THE OLD PI NUMBER RETAINED, and the workbook never re-uploaded. This is
  -- the ordinary failure: B20 normally holds the number of whatever older PI
  -- this one was copied from.
  r := public.order_submission_revised_pi_refusal(RES, OLD, OLD, 'OLD-PI-7788');
  if r not like 'ORDER_SUBMISSION_REVISED_PI_MISSING%' then
    raise exception 'E5 FAILED: an unrevised workbook was accepted';
  end if;

  -- E6. AND THE COINCIDENCE CASE. The unrevised workbook happens to carry the
  -- reserved number already. The hash is asked FIRST precisely so this is still
  -- refused: nothing has been re-parsed, so nothing has been proved.
  r := public.order_submission_revised_pi_refusal(RES, OLD, OLD, '0042');
  if r not like 'ORDER_SUBMISSION_REVISED_PI_MISSING%' then
    raise exception 'E6 FAILED: an unrevised workbook that happened to say 0042 was accepted';
  end if;

  -- E7. A CHANGED WORKBOOK WITH THE WRONG NUMBER — exactly what the hash-only
  -- test used to let through.
  if public.order_submission_revised_pi_refusal(RES, OLD, NEW, 'OLD-PI-7788')
       not like 'ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH%' then
    raise exception 'E7 FAILED: a revised workbook carrying the OLD number was accepted';
  end if;

  -- E8. NO PARTIAL, PREFIX, SUBSTRING OR NUMERIC MATCH.
  for r in select unnest(array['42', '004', '00420', 'PI-0042', '0042/2026', '0042A', '00 42']) loop
    if public.order_submission_revised_pi_refusal(RES, OLD, NEW, r) is null then
      raise exception 'E8 FAILED: % was accepted as 0042', quote_literal(r);
    end if;
  end loop;

  -- E9. A PARSE THAT FAILED. replace_order_submission_parse never ran, so the
  -- hash did not move — and this is the refusal, in the words that tell the
  -- person what to do.
  if public.order_submission_revised_pi_refusal(RES, OLD, null, null)
       not like 'ORDER_SUBMISSION_REVISED_PI_MISSING%' then
    raise exception 'E9 FAILED: a PI with no stored hash was accepted';
  end if;

  raise notice 'E pass — exact match only: whitespace and case normalized, 9 refusal cases held';
end $$;

-- ── F. The workflow: submission is refused until the revised PI carries it ──
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-00000000000b'; v_res text;
begin
  select reserved_order_number into v_res from public.order_submissions where id = v_id;

  -- The initial upload carried no number at all (make_new_pi + upload_pi null).
  perform public.make_approvable(v_id);
  begin
    perform public.submit_pi(v_id);
    raise exception 'F FAILED: a PI was submitted without its number on the revised file';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_REVISED_PI_%' then raise; end if;
  end;

  -- A revised file with the WRONG number is refused just as firmly.
  perform public.upload_pi(v_id, repeat('7', 64), '0099');
  begin
    perform public.submit_pi(v_id);
    raise exception 'F FAILED: a PI carrying the wrong number was submitted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH%' then raise; end if;
  end;

  raise notice 'F pass — submission refused twice: %', substr(v_msg, 1, 84);
end $$;

-- ── G. With the number in the file: submitted, approved, and the Order is it ─
do $$
declare v_id uuid := '22222222-0000-4000-8000-00000000000b'; v_res text; v_display text;
begin
  select reserved_order_number into v_res from public.order_submissions where id = v_id;

  perform public.upload_pi(v_id, repeat('8', 64), '  ' || v_res || ' ');
  perform public.make_approvable(v_id);
  perform public.submit_pi(v_id);

  perform public.act_as('approver@test');
  perform public.approve_order_submission(v_id);

  select display_number into v_display from public.orders where source_order_submission_id = v_id;
  if v_display <> v_res then
    raise exception 'G FAILED: the Order came out as % but % was reserved', v_display, v_res;
  end if;
  if (select reserved_order_number_used_at from public.order_submissions where id = v_id) is null then
    raise exception 'G FAILED: the reservation was not marked used';
  end if;
  for v_display in select unnest(array['order_number_revised_pi_verified', 'order_number_used']) loop
    if (select count(*) from public.order_submission_activity
        where submission_id = v_id and action = v_display) <> 1 then
      raise exception 'G FAILED: % was not recorded exactly once', v_display;
    end if;
  end loop;
  -- The trail records that the check passed, and nothing else about the file.
  if exists (select 1 from public.order_submission_activity
             where submission_id = v_id and action = 'order_number_revised_pi_verified'
               and metadata::text ~ '[0-9a-f]{64}') then
    raise exception 'G FAILED: the verification trail leaks the workbook hash';
  end if;
  raise notice 'G pass — submitted, approved, and Order % is the reserved number', v_res;
end $$;

-- ── H. Approval re-checks: a PI corrected after review is caught ───────────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-000000000021'; v_res text;
begin
  perform public.act_as('owner@test');
  perform public.make_new_pi(v_id, 'Corrected After Review');
  perform public.upload_pi(v_id, repeat('a', 64), null);
  select reserved_order_number into v_res from public.order_submissions where id = v_id;

  perform public.upload_pi(v_id, repeat('b', 64), v_res);
  perform public.make_approvable(v_id);
  perform public.submit_pi(v_id);

  -- Somebody replaces the workbook again between review and approval, and the
  -- new one no longer carries the number.
  perform public.upload_pi(v_id, repeat('c', 64), 'SOMETHING-ELSE');

  perform public.act_as('approver@test');
  begin
    perform public.approve_order_submission(v_id);
    raise exception 'H FAILED: a PI whose number was removed after review was approved';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH%' then raise; end if;
  end;

  if exists (select 1 from public.orders where source_order_submission_id = v_id) then
    raise exception 'H FAILED: the refused approval created an Order anyway';
  end if;
  raise notice 'H pass — approval re-reads the file and refuses: %', substr(v_msg, 1, 80);
end $$;

-- ── I. A LEGACY draft is grandfathered end to end ──────────────────────────
do $$
declare v_id uuid := '22222222-0000-4000-8000-00000000000f'; v_display text;
begin
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Zeta', repeat('6', 64));

  if (select reserved_order_number from public.order_submissions where id = v_id) is not null then
    raise exception 'I FAILED: a pre-109 draft was given a number automatically';
  end if;
  if (select reservation_required from public.order_submissions where id = v_id) then
    raise exception 'I FAILED: a pre-109 draft carries the new obligation';
  end if;

  perform public.make_approvable(v_id);
  perform public.submit_pi(v_id);
  perform public.act_as('approver@test');
  perform public.approve_order_submission(v_id);

  select display_number into v_display from public.orders where source_order_submission_id = v_id;
  if v_display is null then raise exception 'I FAILED: a grandfathered PI could not be approved'; end if;
  raise notice 'I pass — a pre-109 draft submits and approves unchanged, as Order %', v_display;
end $$;

-- ── J. A legacy draft that reserves BY HAND then obeys the same rules ──────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-000000000022'; v_res text; v_auto boolean;
begin
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Legacy Reserving', repeat('d', 64));
  v_res := public.reserve_order_number_for_submission(v_id)->>'reserved_order_number';
  if v_res is null then raise exception 'J FAILED: the compatibility action issued nothing'; end if;

  select (metadata->>'automatic')::boolean into v_auto
  from public.order_submission_activity
  where submission_id = v_id and action = 'order_number_reserved';
  if v_auto is not false then
    raise exception 'J FAILED: a click was recorded as automatic';
  end if;

  perform public.make_approvable(v_id);
  begin
    perform public.submit_pi(v_id);
    raise exception 'J FAILED: a legacy PI that reserved was submitted without a revised file';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_REVISED_PI_MISSING%' then raise; end if;
  end;
  raise notice 'J pass — once a legacy draft reserves %, the revised-PI rule binds it', v_res;
end $$;

-- ── K. An unauthorized caller reserves nothing ─────────────────────────────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-00000000000d'; v_cycle bigint;
begin
  perform public.act_as('owner@test');
  perform public.make_pi(v_id, 'Delta', repeat('4', 64));
  select next_number into v_cycle from public.order_number_cycle where id;

  perform public.act_as('stranger@test');
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'K FAILED: somebody else''s PI was given a number by a stranger';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_NOT_OWNED%' then raise; end if;
  end;

  perform public.act_as('allocator@test');
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'K FAILED: Finance authority reserved an Order number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_FORBIDDEN%' then raise; end if;
  end;

  perform public.act_as('approver@test');
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'K FAILED: orders.approve_order alone reserved a number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_SUBMISSION_FORBIDDEN%' then raise; end if;
  end;

  if (select next_number from public.order_number_cycle where id) <> v_cycle then
    raise exception 'K FAILED: a refused reservation still burned a number';
  end if;
  if (select reserved_order_number from public.order_submissions where id = v_id) is not null then
    raise exception 'K FAILED: a refused reservation still wrote to the PI';
  end if;
  raise notice 'K pass — three refusals, and the cycle is exactly where it was';
end $$;

-- ── L. No workbook, no number — automatically or by hand ───────────────────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-00000000000e';
begin
  perform public.act_as('owner@test');
  perform public.make_new_pi(v_id, 'Epsilon');
  if (select reserved_order_number from public.order_submissions where id = v_id) is not null then
    raise exception 'L FAILED: an empty draft was given a number';
  end if;
  begin
    perform public.reserve_order_number_for_submission(v_id);
    raise exception 'L FAILED: a PI with no workbook reserved a number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_NUMBER_RESERVATION_NO_WORKBOOK%' then raise; end if;
    raise notice 'L pass — %', substr(v_msg, 1, 88);
  end;
end $$;

-- ── M. THE CYCLE CANNOT STEP BACK OVER A RESERVATION — from ANY writer ─────
do $$
declare v_msg text; v_id uuid := '22222222-0000-4000-8000-000000000010'; v_res text; v_claim uuid;
begin
  perform public.act_as('owner@test');
  perform public.make_new_pi(v_id, 'Eta');
  perform public.upload_pi(v_id, repeat('7', 64), null);
  select reserved_order_number into v_res from public.order_submissions where id = v_id;

  -- 1. The admin setter.
  perform public.act_as('admin@test');
  begin
    perform public.set_next_confirmed_order_number(v_res::bigint);
    raise exception 'M FAILED: the cycle was set onto a live reservation';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION%' then raise; end if;
  end;

  -- 2. A RAW UPDATE, which no re-emitted function could ever have caught. This
  --    is the whole reason the rule lives on the table.
  begin
    update public.order_number_cycle set next_number = 1 where id;
    raise exception 'M FAILED: a raw UPDATE walked the cycle back over a reservation';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION%' then raise; end if;
  end;

  -- 3. The cycle reset, which has its own gates and now this one as well.
  insert into public.test_data_cleanup_claims (finalized_at) values (now())
  returning claim_token into v_claim;
  begin
    perform public.reset_confirmed_order_number_cycle(v_claim);
    raise exception 'M FAILED: the cycle was reset while a PI Draft holds a number';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    -- Its OWN empty-register gate fires first here, which is the correct answer;
    -- the reservation guard is proved on its own by case 2 above.
    if v_msg not like 'ORDER_NUMBER_RESET_%' and v_msg not like 'ORDER_NUMBER_CYCLE_BEHIND_RESERVATION%' then
      raise;
    end if;
  end;

  -- And nothing moved.
  if (select reserved_order_number from public.order_submissions where id = v_id) <> v_res then
    raise exception 'M FAILED: the reservation moved';
  end if;
  raise notice 'M pass — setter, raw UPDATE and reset all refused while % is held', v_res;
end $$;

-- ── N. Historical Orders are untouched throughout ──────────────────────────
do $$
declare v_before jsonb; v_after jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', id, 'n', display_number) order by display_number)
    into v_before from public.orders;
  perform public.act_as('admin@test');
  perform public.make_order('Unrelated Co');
  select jsonb_agg(jsonb_build_object('id', id, 'n', display_number) order by display_number)
    into v_after from public.orders
   where id in (select (e->>'id')::uuid from jsonb_array_elements(v_before) e);
  if v_after is distinct from v_before then
    raise exception 'N FAILED: an existing Order number changed';
  end if;
  raise notice 'N pass — no existing Order moved';
end $$;

-- ── O. A FORGED CLIENT PAYLOAD CANNOT CLAIM A MATCH ────────────────────────
--
-- The only value the rule reads is order_submissions.source_order_number, and
-- the only thing that writes it is replace_order_submission_parse — which is
-- executable by no client role. A browser can ask for stored bytes to be
-- re-parsed; it cannot say what they contain.
do $$
declare v_bad bigint;
begin
  if has_function_privilege('authenticated',
       'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon',
       'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute') then
    raise exception 'O FAILED: a client role can call the one writer of the parsed reference';
  end if;

  select count(*) into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    -- prokind 'f' is a plain function. pg_get_functiondef() raises on an
    -- aggregate or a window function, so the filter is a correctness
    -- requirement rather than a narrowing.
    and p.prokind = 'f'
    and p.proname <> 'replace_order_submission_parse'
    and pg_get_functiondef(p.oid) ~* 'set[^;]*source_order_number\s*=';
  if v_bad <> 0 then
    raise exception 'O FAILED: % other function(s) write the parsed reference', v_bad;
  end if;

  -- And no client role may write the column directly either.
  if has_column_privilege('authenticated', 'public.order_submissions', 'source_order_number', 'UPDATE')
     or has_column_privilege('authenticated', 'public.order_submissions', 'reserved_order_number', 'UPDATE') then
    raise exception 'O FAILED: a client role can update the columns the rule reads';
  end if;

  raise notice 'O pass — the reference is server-parsed, single-writer, and not client-writable';
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

-- ── S1. One payment across two Confirmed Orders ──────────────────────────────
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

  if (r->>'allocation_count')::int <> 2 then raise exception 'S1 FAILED: % allocations', r->>'allocation_count'; end if;
  if (r->>'unallocated_balance')::numeric <> 0 then raise exception 'S1 FAILED: balance not zero'; end if;
  if (select count(*) from public.finance_payment_requests
      where id = (r->>'payment_request_id')::uuid) <> 1 then
    raise exception 'S1 FAILED: the payment was not written once';
  end if;
  if (select sum(allocated_amount) from public.finance_payment_allocations
      where payment_request_id = (r->>'payment_request_id')::uuid and status = 'active') <> 100000 then
    raise exception 'S1 FAILED: the allocations do not sum to the payment';
  end if;
  if (select count(distinct order_id) from public.finance_payment_allocations
      where payment_request_id = (r->>'payment_request_id')::uuid) <> 2 then
    raise exception 'S1 FAILED: the two Orders are not both linked';
  end if;
  -- ONE payment row for two Orders, which is the whole shape of requirement 3.
  if (select count(*) from public.finance_payment_requests where order_number = 'NEFT-1') <> 1 then
    raise exception 'S1 FAILED: the payment was duplicated per Order';
  end if;
  raise notice 'S1 pass — one payment %, two Orders, 60000 + 40000', r->>'request_number';
end $$;

-- ── S2. One payment across two PI Drafts, and across a mixture ───────────────
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
    raise exception 'S2 FAILED: the two PI Drafts are not both linked';
  end if;
  -- And each PI's own timeline says money arrived.
  if (select count(*) from public.order_submission_activity
      where action = 'payment_recorded' and metadata->>'split_entry' = 'true') <> 2 then
    raise exception 'S2 FAILED: the PI timelines do not record the split entry';
  end if;

  select id into o1 from public.orders where client_name = 'Split Co One';
  r := public.record_payment_with_allocations(
    70000, current_date, 'cheque', 'Split Co', 'other', 'CHQ-9', null,
    jsonb_build_array(
      jsonb_build_object('kind', 'order',      'id', o1, 'amount', 25000),
      jsonb_build_object('kind', 'submission', 'id', '33333333-0000-4000-8000-000000000001', 'amount', 15000)));
  if (r->>'unallocated_balance')::numeric <> 30000 then
    raise exception 'S2 FAILED: the remainder is % not 30000', r->>'unallocated_balance';
  end if;
  raise notice 'S2 pass — two PI Drafts, then an Order and a PI Draft with 30000 left over';
end $$;

-- ── S3. A remainder is allowed; an empty list is allowed; exact is allowed ────
do $$
declare r jsonb; o1 uuid;
begin
  perform public.act_as('allocator@test');
  select id into o1 from public.orders where client_name = 'Split Co Two';

  r := public.record_payment_with_allocations(
    10000, current_date, 'cash', 'Split Co', null, null, null, '[]'::jsonb);
  if (r->>'allocation_count')::int <> 0 or (r->>'unallocated_balance')::numeric <> 10000 then
    raise exception 'S3 FAILED: an unallocated payment was not written as one';
  end if;

  r := public.record_payment_with_allocations(
    12345.67, current_date, 'other', 'Split Co', null, null, null,
    jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 12345.67)));
  if (r->>'unallocated_balance')::numeric <> 0 then
    raise exception 'S3 FAILED: an exact allocation left a balance';
  end if;
  raise notice 'S3 pass — no allocations, and an exact one to the paise';
end $$;

-- ── S4. Over-allocation is refused, and leaves NOTHING behind ────────────────
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
    raise exception 'S4 FAILED: 1200 was allocated out of 1000';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATIONS_EXCEED_AMOUNT%' then raise; end if;
  end;

  if (select count(*) from public.finance_payment_requests) <> v_pays then
    raise exception 'S4 FAILED: the refused entry left a payment behind';
  end if;
  if (select count(*) from public.finance_payment_allocations) <> v_allocs then
    raise exception 'S4 FAILED: the refused entry left an allocation behind';
  end if;
  raise notice 'S4 pass — refused before anything was written, and nothing was';
end $$;

-- ── S5. A second row naming the same target is refused, atomically ──────────
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
    raise exception 'S5 FAILED: one payment made two active claims on one Order';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ALLOCATION_DUPLICATE%' then raise; end if;
  end;

  -- THE ATOMICITY CASE. The FIRST allocation succeeded before the second was
  -- refused, so if this transaction were not one unit there would now be a
  -- payment carrying 2000 of an entry the caller was told had failed.
  if (select count(*) from public.finance_payment_requests) <> v_pays then
    raise exception 'S5 FAILED: a payment survived a failed entry';
  end if;
  if (select count(*) from public.finance_payment_allocations) <> v_allocs then
    raise exception 'S5 FAILED: the first allocation survived a failed entry';
  end if;
  raise notice 'S5 pass — duplicate refused, and the row written before it went with it';
end $$;

-- ── S6. A target the caller cannot see is refused ───────────────────────────
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
    raise exception 'S6 FAILED: money was allocated to a record the caller cannot see';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'ALLOCATION_TARGET_NOT_AVAILABLE%' then raise; end if;
    raise notice 'S6 pass — %', substr(v_msg, 1, 90);
  end;
end $$;

-- ── S7. Authorization: entry needs Finance, and division needs finance.allocate
do $$
declare v_msg text; o1 uuid;
begin
  select id into o1 from public.orders where client_name = 'Split Co One';

  -- The PI owner: no Finance module entry at all.
  perform public.act_as('owner@test');
  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null, '[]'::jsonb);
    raise exception 'S7 FAILED: somebody outside Finance recorded a payment here';
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
    raise exception 'S7 FAILED: finance.view alone divided a payment';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED%' then raise; end if;
  end;
  raise notice 'S7 pass — Finance entry AND finance.allocate, both required';
end $$;

-- ── S8. Degenerate rows are refused before the payment is written ───────────
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
    raise exception 'S8 FAILED: a zero allocation was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATION_AMOUNT_INVALID%' then raise; end if;
  end;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', -500)));
    raise exception 'S8 FAILED: a negative allocation was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATION_AMOUNT_INVALID%' then raise; end if;
  end;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'order_request', 'id', o1, 'amount', 500)));
    raise exception 'S8 FAILED: an Order Request target was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATION_KIND_INVALID%' then raise; end if;
  end;

  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Split Co', null, null, null, '"not an array"'::jsonb);
    raise exception 'S8 FAILED: a non-array allocation list was accepted';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ALLOCATIONS_INVALID%' then raise; end if;
  end;

  if (select count(*) from public.finance_payment_requests) <> v_pays then
    raise exception 'S8 FAILED: a malformed list still wrote a payment';
  end if;
  raise notice 'S8 pass — zero, negative, a retired target kind and a non-array, all refused with no payment written';
end $$;

-- ── S9. The payment is Awaiting Verification, and carries no direct link ────
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
    raise exception 'S9 FAILED: the payment was written as % rather than awaiting verification', v_pay.status;
  end if;
  if v_pay.order_id is not null then
    raise exception 'S9 FAILED: a direct linkage was written beside the allocation';
  end if;
  if v_pay.submitted_by <> (select id from public.users where email = 'allocator@test') then
    raise exception 'S9 FAILED: the submitter was not derived from the caller';
  end if;
  raise notice 'S9 pass — pending_approval, no direct link, submitter derived';
end $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- WHO MAY DIVIDE A PAYMENT AS THEY RECORD IT
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE BUSINESS RULE. Sales may record payments. Sales may DIVIDE one only when
-- separately authorized, and that authorization is granted per person through
-- Access Control — not by job title, and never to every Sales user at once.
--
-- THE TWO GATES, AND WHY THEY ARE THE RIGHT TWO.
--
--   finance module entry   is what "may record a payment" already means: the
--     /finance page offers Send Payment Request to anybody who can open the
--     module, and the RESTRICTIVE policy on finance_payment_requests requires
--     the same thing of every write to that table. A SECURITY DEFINER function
--     bypasses RLS, so the RPC asks it explicitly rather than skipping it.
--
--   finance.allocate       is the separate allocation permission, registered by
--     20260918000000 and PROTECTED (src/lib/permissions/levels.ts) — which
--     means no preset level confers it and an administrator must grant it to a
--     named person. That is exactly "separately authorized", and it is what
--     allocate_payment_to_target() already requires of the same act performed a
--     minute later.
--
-- Neither gate mentions a role, a team or a title. A Sales user, a Senior Sales
-- user, a Finance user and an admin all pass or fail on the same two questions.

do $$
declare v_msg text; o1 uuid; v_result jsonb;
begin
  select id into o1 from public.orders where client_name = 'Split Co One';

  -- ── P1. A SELECTED SALES USER, granted both. ──
  insert into public.users (id, email, role, team)
  values ('11111111-0000-4000-8000-000000000007', 'sales@test', 'employee', 'sales');
  insert into public.test_grants (user_id, module, action) values
    ('11111111-0000-4000-8000-000000000007', 'finance', 'view'),
    ('11111111-0000-4000-8000-000000000007', 'finance', 'allocate');

  perform public.act_as('sales@test');
  v_result := public.record_payment_with_allocations(
    9000, current_date, 'upi', 'Sales Client', null, 'SALES-1', null,
    jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 4000)));
  if (v_result->>'allocation_count')::int <> 1 then
    raise exception 'P1 FAILED: a selected Sales user could not divide a payment';
  end if;
  if v_result->>'status' <> 'pending_approval' then
    raise exception 'P1 FAILED: a Sales entry did not land as Awaiting Verification';
  end if;

  -- ── P2. A SELECTED SENIOR SALES USER, granted both. Same two questions. ──
  insert into public.users (id, email, role, team)
  values ('11111111-0000-4000-8000-000000000008', 'senior@test', 'employee', 'senior_sales');
  insert into public.test_grants (user_id, module, action) values
    ('11111111-0000-4000-8000-000000000008', 'finance', 'view'),
    ('11111111-0000-4000-8000-000000000008', 'finance', 'allocate');

  perform public.act_as('senior@test');
  if (public.record_payment_with_allocations(
        5000, current_date, 'cash', 'Senior Client', null, null, null,
        jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 2500)))
      ->>'allocation_count')::int <> 1 then
    raise exception 'P2 FAILED: a selected Senior Sales user could not divide a payment';
  end if;

  -- ── P3. A SALES USER WITHOUT THE ALLOCATION GRANT. ──
  --
  -- May record — the existing Finance form is untouched and its RLS admits them
  -- — but may not divide. The refusal names the missing permission rather than
  -- the module.
  insert into public.users (id, email, role, team)
  values ('11111111-0000-4000-8000-000000000009', 'sales2@test', 'employee', 'sales');
  insert into public.test_grants (user_id, module, action)
  values ('11111111-0000-4000-8000-000000000009', 'finance', 'view');

  perform public.act_as('sales2@test');
  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'Sales Client', null, null, null,
      jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 1000)));
    raise exception 'P3 FAILED: Sales without the allocation grant divided a payment';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED%' then raise; end if;
  end;
  -- And the ordinary single-target entry they DO have is untouched: the RLS
  -- policy that admits it is not this RPC's business and is not narrowed here.
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, status, submitted_by)
  values ('Sales Client', 1000, current_date, 'cash', 'pending_approval',
          '11111111-0000-4000-8000-000000000009');

  -- ── P4. ALLOCATION ACCESS BUT NO PAYMENT-ENTRY ACCESS. ──
  --
  -- A grant with nowhere to act. Refused at the FIRST gate, so the message is
  -- about the module rather than about allocation.
  insert into public.users (id, email, role, team)
  values ('11111111-0000-4000-8000-00000000000a', 'orphan@test', 'employee', 'sales');
  insert into public.test_grants (user_id, module, action)
  values ('11111111-0000-4000-8000-00000000000a', 'orders', 'view_all');

  perform public.act_as('orphan@test');
  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'X', null, null, null, '[]'::jsonb);
    raise exception 'P4 FAILED: somebody outside Finance recorded a payment here';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'PAYMENT_ENTRY_NOT_PERMITTED%' then raise; end if;
  end;

  -- ── P5. AN INACTIVE ACCOUNT, holding both grants. ──
  update public.users set is_active = false where email = 'sales@test';
  perform public.act_as('sales@test');
  begin
    perform public.record_payment_with_allocations(
      1000, current_date, 'cash', 'X', null, null, null, '[]'::jsonb);
    raise exception 'P5 FAILED: a deactivated account recorded a payment';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like '%not active%' and v_msg not like 'PAYMENT_ENTRY_%' then raise; end if;
  end;
  update public.users set is_active = true where email = 'sales@test';

  -- ── P6. ADMIN AND FINANCE keep exactly what they had. ──
  perform public.act_as('admin@test');
  if (public.record_payment_with_allocations(
        3000, current_date, 'cash', 'Admin Client', null, null, null,
        jsonb_build_array(jsonb_build_object('kind', 'order', 'id', o1, 'amount', 3000)))
      ->>'allocation_count')::int <> 1 then
    raise exception 'P6 FAILED: an admin could not divide a payment';
  end if;
  perform public.act_as('allocator@test');
  if (public.record_payment_with_allocations(
        3000, current_date, 'cash', 'Finance Client', null, null, null, '[]'::jsonb)
      ->>'allocation_count')::int <> 0 then
    raise exception 'P6 FAILED: a Finance allocator could not record a payment';
  end if;

  -- ── P7. THE FORGED CALL. ──
  --
  -- There is no hidden button to bypass: the gates are in the function body, so
  -- a caller who reaches the RPC directly meets exactly the same two questions.
  -- P3 and P4 above ARE that call — neither went near a screen.
  --
  -- What is asserted here is the property those two rely on: the RPC is the
  -- only door, and it is not executable by anon.
  if has_function_privilege('anon',
       'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)',
       'execute') then
    raise exception 'P7 FAILED: an unauthenticated caller can reach the split-entry door';
  end if;
  if not has_function_privilege('authenticated',
       'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb)',
       'execute') then
    raise exception 'P7 FAILED: an authenticated caller cannot reach it at all';
  end if;

  -- ── P8. NOBODY GOT ALLOCATION BY BEING SALES. ──
  --
  -- The two Sales users differ in exactly one grant, and that is the only thing
  -- that decided the answer. Stated as an assertion so a future change that
  -- shortcut the check on `team` or `role` would fail here.
  if public.resolve_permission('11111111-0000-4000-8000-000000000009', 'finance', 'allocate') then
    raise exception 'P8 FAILED: a Sales user holds allocation without being granted it';
  end if;

  raise notice 'P pass — Sales, Senior Sales, Finance and Admin all decided by the same two grants';
end $$;

\echo 'ALL SQL ASSERTIONS PASSED'

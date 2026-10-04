-- THE ADVANCE BASE ON A REVISED PI, AND ON INCONSISTENT DATA (20270227000000)
-- ===========================================================================
--   1  in force        the in-force revision's STAGED PARSE (order_pi_revision_staged_parses, the way
--                      approve_order_pi_revision writes it) supplies the pre-GST base
--   2  superseded      a superseded revision supplies nothing, even if it once stated the same grand total
--   3  mismatch        a grand total that is not the Order's value (hand amendment, wrong revision) = UNKNOWN base
--   4  not in force    a pending or rejected revision never supplies one
--   5  inconsistent    a pre-GST amount ABOVE its grand total (GST would be negative) is unknown, not trusted:
--                      on the source PI, on a staged revision, and on the PI payment summary
-- One transaction, ROLLBACK. Synthetic records only.
\set ON_ERROR_STOP on

begin;

do $$
begin
  perform set_config('test.owner_id', '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.sales_id', 'd0000000-0000-4000-8000-00000000f011', true);
end $$;

insert into public.users (id, full_name, email, role, team, is_active, employee_code) values
  (current_setting('test.sales_id')::uuid, 'ADV Sales', 'adv-sales@example.test', 'member', 'sales', true, 'ASSERT-F11')
on conflict (id) do update set role = excluded.role, team = excluded.team, is_active = true, is_deleted = false;
update public.users set role = 'admin', is_active = true, is_deleted = false where id = current_setting('test.owner_id')::uuid;

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
create function pg_temp.check(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'ASSERT FAILED: %', p_label; end if;
end $$;

/** The shared helper, read as the database reads it (it is not callable by a client role). */
create function pg_temp.pos(p_order uuid) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.restore();
  v := public.order_advance_position(p_order);
  return v;
end $$;

/** One PI with a stated before-GST total. gst = grand - before. */
create function pg_temp.mk_pi(p_before numeric, p_grand numeric, p_status text default 'draft') returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  perform pg_temp.restore();
  alter table public.order_submissions disable trigger user;
  insert into public.order_submissions (id, status, submitted_by, created_by, client_name, source_workbook_path,
                                        gross_product_amount, discount_amount, subtotal_after_discount,
                                        total_before_gst, gst_amount, grand_total, submitted_at,
                                        approved_by, approved_at)
  values (v_id, p_status, current_setting('test.sales_id')::uuid, current_setting('test.sales_id')::uuid, 'ADV-PI',
          'pi/' || v_id::text || '.xlsx', 100, 0, 100, p_before, greatest(p_grand - p_before, 0), p_grand,
          case when p_status = 'draft' then null else now() end,
          case when p_status = 'approved' then current_setting('test.owner_id')::uuid end,
          case when p_status = 'approved' then now() end);
  alter table public.order_submissions enable trigger user;
  return v_id;
end $$;

/** An Order stating `p_grand`, from a PI stating `p_before` before GST (null PI = no PI at all). */
create function pg_temp.mk_order(p_tag text, p_grand numeric, p_pi uuid default null, p_status text default 'running') returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  perform pg_temp.restore();
  update public.test_data_cleanup_settings set enabled = false, permanently_disabled = false where id;
  insert into public.orders (id, client_name, status, confirm_date, total_value, total_product_value,
                             created_by, assigned_to, source_order_submission_id)
  values (v_id, 'ADV-' || p_tag, p_status, current_date, p_grand, p_grand, current_setting('test.owner_id')::uuid,
          current_setting('test.sales_id')::uuid, p_pi);
  return v_id;
end $$;

create function pg_temp.mk_version(p_order uuid, p_submission uuid, p_n int, p_status text) returns uuid language plpgsql as $$
declare v_ver uuid := gen_random_uuid();
begin
  perform pg_temp.restore();
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  insert into public.order_pi_versions (id, order_id, submission_id, version_number, status, decided_by, decided_at,
                                        decision_reason, superseded_at, revision_reason, pdf_order_number)
  values (v_ver, p_order, p_submission, p_n, p_status, current_setting('test.owner_id')::uuid, now(),
          case when p_status = 'rejected' then 'no' end,
          case when p_status = 'superseded' then now() end,
          case when p_n > 1 then 'client change' end, 'ADV-1');
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;
  return v_ver;
end $$;

/** Change an Order's stated grand total the way the promotion / an amendment does (inside the amendment context). */
create function pg_temp.set_value(p_order uuid, p_value numeric) returns void language plpgsql as $$
begin
  perform pg_temp.restore();
  perform set_config('boe.amendment_context', 'order_amendment', true);
  update public.orders set total_value = p_value where id = p_order;
  perform set_config('boe.amendment_context', '', true);
end $$;

/** Money allocated to an Order; p_status decides whether Finance verified it. */
create function pg_temp.pay(p_order uuid, p_amount numeric, p_status text default 'approved_unlinked') returns void language plpgsql as $$
declare v_pay uuid := gen_random_uuid();
begin
  perform pg_temp.restore();
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ADV-PAY', p_amount, current_date, 'hdfc', p_status, current_setting('test.owner_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, p_order, p_amount, 'confirmed_order', current_setting('test.owner_id')::uuid);
end $$;

/** Payment against a PI (before it is an Order). */
create function pg_temp.pay_pi(p_sub uuid, p_amount numeric, p_status text default 'approved_unlinked') returns void language plpgsql as $$
declare v_pay uuid := gen_random_uuid();
begin
  perform pg_temp.restore();
  insert into public.finance_payment_requests (id, client_name, amount, payment_date, payment_mode, status, submitted_by, received_in)
  values (v_pay, 'ADV-PAY', p_amount, current_date, 'hdfc', p_status, current_setting('test.owner_id')::uuid, null);
  insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
  values (v_pay, p_sub, p_amount, 'order_submission', current_setting('test.owner_id')::uuid);
end $$;


/** Stage a revision's parse the way approve_order_pi_revision does: the version's payload carries the commercial figures. */
create function pg_temp.stage(p_version uuid, p_submission uuid, p_grand text, p_before text) returns void language plpgsql as $$
begin
  perform pg_temp.restore();
  insert into public.order_pi_revision_staged_parses (version_id, submission_id, payload, staged_by)
  values (p_version, p_submission,
          jsonb_build_object('commercial', jsonb_build_object('grand_total', p_grand, 'total_before_gst', p_before)),
          current_setting('test.owner_id')::uuid);
end $$;

/** A version with its own staged parse. */
create function pg_temp.rev(p_order uuid, p_n int, p_status text, p_grand text, p_before text) returns uuid language plpgsql as $$
declare v_sub uuid; v_ver uuid;
begin
  v_sub := pg_temp.mk_pi(null, 1, 'draft');        -- the version's own submission row (its figures are NOT what the base reads)
  v_ver := pg_temp.mk_version(p_order, v_sub, p_n, p_status);
  perform pg_temp.stage(v_ver, v_sub, p_grand, p_before);
  return v_ver;
end $$;

create function pg_temp.base(p_order uuid) returns numeric language sql as $$
  select public.order_advance_base(p_order)
$$;

-- ═══ 1. The in-force revision supplies the base ════════════════════════════
do $$
declare pi uuid; o uuid; v1 uuid; v2 uuid; p jsonb;
begin
  pi := pg_temp.mk_pi(100000, 118000, 'approved');
  o  := pg_temp.mk_order('rev1', 118000, pi);
  v1 := pg_temp.mk_version(o, pi, 1, 'approved');
  perform pg_temp.check(pg_temp.base(o) = 100000, 'V1 in force, no staged parse: the source PI states the value, base 1,00,000');

  -- V2 is applied: V1 superseded, V2 in force, the Order re-valued to V2's grand total (the promotion's own write)
  perform pg_temp.restore();
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  update public.order_pi_versions set status = 'superseded', superseded_at = now() where id = v1;
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;
  v2 := pg_temp.rev(o, 2, 'approved', '236000', '200000');
  perform pg_temp.set_value(o, 236000);
  perform pg_temp.check(pg_temp.base(o) = 200000, 'V2 in force with a staged parse stating 2,36,000: base 2,00,000 — from the REVISION, not the source PI');
  p := pg_temp.pos(o);
  perform pg_temp.check((p ->> 'advance_base')::numeric = 200000 and (p ->> 'order_value')::numeric = 236000 and (p ->> 'value_known')::boolean,
    'and the shared position reports it: base 2,00,000 against order value 2,36,000');
  perform pg_temp.pay(o, 80000);
  p := pg_temp.pos(o);
  perform pg_temp.check((p ->> 'percent')::numeric = 40 and (p ->> 'ready')::boolean, '₹80,000 of the revised ₹2,00,000 is exactly 40%, ready');
end $$;

-- ═══ 2. A superseded revision supplies nothing ═══════════════════════════════
do $$
declare pi uuid; o uuid; v1 uuid; v2 uuid; v3 uuid;
begin
  pi := pg_temp.mk_pi(100000, 118000, 'approved');
  o  := pg_temp.mk_order('rev2', 236000, pi);        -- the Order stands at V3's value
  v1 := pg_temp.mk_version(o, pi, 1, 'superseded');
  v2 := pg_temp.rev(o, 2, 'superseded', '236000', '200000');   -- V2 stated THIS grand total once, and is superseded
  v3 := pg_temp.rev(o, 3, 'approved',   '354000', '300000');   -- V3 is in force, but states a DIFFERENT grand total
  perform pg_temp.check(pg_temp.base(o) is null,
    'a superseded revision that once stated the same grand total does not supply the base; the in-force V3 states another total: unknown');

  -- Now V3 states the Order's value: the in-force revision wins, whatever V2 said
  perform pg_temp.restore();
  update public.order_pi_revision_staged_parses
     set payload = jsonb_build_object('commercial', jsonb_build_object('grand_total', '236000', 'total_before_gst', '210000'))
   where version_id = v3;
  perform pg_temp.check(pg_temp.base(o) = 210000, 'the in-force V3 states the value: its 2,10,000, never the superseded V2''s 2,00,000');
end $$;

-- ═══ 3. A mismatched grand total gives an UNKNOWN base ═══════════════════════
do $$
declare pi uuid; o uuid; v uuid; p jsonb;
begin
  pi := pg_temp.mk_pi(100000, 118000, 'approved');
  o  := pg_temp.mk_order('rev3', 118000, pi);
  v  := pg_temp.mk_version(o, pi, 1, 'approved');
  perform pg_temp.check(pg_temp.base(o) = 100000, 'control: matching source PI');
  perform pg_temp.set_value(o, 125000);
  p := pg_temp.pos(o);
  perform pg_temp.check(pg_temp.base(o) is null and not (p ->> 'value_known')::boolean and p -> 'advance_base' = 'null'::jsonb and p -> 'percent' = 'null'::jsonb,
    'the Order was hand-amended to 1,25,000: no PI states it, so no base and no percentage');
  -- a revision in force whose grand total is NOT the Order's value
  perform pg_temp.restore();
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  update public.order_pi_versions set status = 'superseded', superseded_at = now() where id = v;
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;
  perform pg_temp.rev(o, 2, 'approved', '236000', '200000');
  perform pg_temp.check(pg_temp.base(o) is null, 'an in-force revision stating 2,36,000 does not price an Order standing at 1,25,000');
  perform pg_temp.set_value(o, 236000);
  perform pg_temp.check(pg_temp.base(o) = 200000, 'and prices it the moment the Order stands at 2,36,000');
end $$;

-- ═══ 4. Not yet in force, or refused: never a base ════════════════════════════
do $$
declare pi uuid; o uuid; v1 uuid;
begin
  pi := pg_temp.mk_pi(100000, 118000, 'approved');
  o  := pg_temp.mk_order('rev4', 236000, pi);       -- (stands at the proposed value, as a fixture)
  v1 := pg_temp.mk_version(o, pi, 1, 'approved');
  perform pg_temp.rev(o, 2, 'pending', '236000', '200000');
  perform pg_temp.check(pg_temp.base(o) is null, 'a PENDING revision stating the value is not in force: unknown');
  perform pg_temp.restore();
  alter table public.order_pi_versions disable trigger order_pi_versions_guard;
  update public.order_pi_versions set status = 'rejected', decision_reason = 'no' where order_id = o and version_number = 2;
  alter table public.order_pi_versions enable trigger order_pi_versions_guard;
  perform pg_temp.check(pg_temp.base(o) is null, 'a REJECTED revision never is');
end $$;

-- ═══ 5. A pre-GST amount above the grand total is INCONSISTENT, not a base ═══
do $$
declare pi uuid; o uuid; v uuid; p jsonb; s jsonb;
begin
  -- the source PI
  pi := pg_temp.mk_pi(130000, 118000, 'approved');
  o  := pg_temp.mk_order('inc1', 118000, pi);
  perform pg_temp.pay(o, 60000);
  p := pg_temp.pos(o);
  perform pg_temp.check(pg_temp.base(o) is null and not (p ->> 'value_known')::boolean and p -> 'percent' = 'null'::jsonb and not (p ->> 'ready')::boolean,
    'a source PI stating ₹1,30,000 before GST against a ₹1,18,000 grand total (GST would be negative): unknown base, not ready on payment');
  -- a staged revision
  pi := pg_temp.mk_pi(100000, 118000, 'approved');
  o  := pg_temp.mk_order('inc2', 236000, pi);
  perform pg_temp.mk_version(o, pi, 1, 'superseded');
  perform pg_temp.rev(o, 2, 'approved', '236000', '250000');
  perform pg_temp.check(pg_temp.base(o) is null, 'a staged revision stating ₹2,50,000 before GST against ₹2,36,000: unknown base');
  -- the boundary: equal is valid (a GST-free PI)
  pi := pg_temp.mk_pi(118000, 118000, 'approved');
  o  := pg_temp.mk_order('inc3', 118000, pi);
  perform pg_temp.check(pg_temp.base(o) = 118000, 'before GST equal to the grand total (no GST) is consistent: a base');
  -- words and zero are no figure
  perform pg_temp.restore();
  pi := pg_temp.mk_pi(100000, 118000, 'approved'); o := pg_temp.mk_order('inc4', 236000, pi);
  perform pg_temp.mk_version(o, pi, 1, 'superseded');
  perform pg_temp.rev(o, 2, 'approved', '236000', 'as applicable');
  perform pg_temp.check(pg_temp.base(o) is null, 'words where a figure should be: no base, and no error');
  pi := pg_temp.mk_pi(100000, 118000, 'approved'); o := pg_temp.mk_order('inc5', 236000, pi);
  perform pg_temp.mk_version(o, pi, 1, 'superseded');
  perform pg_temp.rev(o, 2, 'approved', '236000', '0');
  perform pg_temp.check(pg_temp.base(o) is null, 'a zero total before GST: no base');

  -- the PI-level reading of the same inconsistency: the payment summary reports no base
  pi := pg_temp.mk_pi(130000, 118000, 'submitted');
  perform pg_temp.pay_pi(pi, 50000);
  perform pg_temp.become(current_setting('test.owner_id')::uuid);
  s := public.pi_submission_payment_summary(pi);
  perform pg_temp.restore();
  perform pg_temp.check(s -> 'advance_base' = 'null'::jsonb and s -> 'verified_percent' = 'null'::jsonb and not (s ->> 'meets_standard')::boolean,
    'the PI payment summary of an inconsistent PI: no base, no percentage, standard not met');
  perform pg_temp.check((s ->> 'grand_total')::numeric = 118000, 'and the grand total is still reported as it is');
end $$;

do $$ begin raise notice 'ALL REVISED-PI ADVANCE-BASE ASSERTIONS PASSED'; end $$;
rollback;

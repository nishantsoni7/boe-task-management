-- ── The world 20261014000000 arrives into ────────────────────────────────────
--
-- Four probes, joined by '|'. run_payment_custody_and_modes_suite.sh requires
-- the exact string, so a fixture that has silently drifted forward cannot make
-- the suite look meaningful.
--
-- The fourth probe is the DEFECT ITSELF, reproduced rather than described: a
-- Payment Request naming a Confirmed Order, approved by Finance, ends up with a
-- correct allocation and a status of approved_unlinked with no order_number —
-- which is what the badge read "Order No. Pending" and the Order Number cell
-- read blank from.

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.act_as(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

insert into public.users (id, email, role, full_name) values
  ('99999999-9999-4999-8999-999999999999', 'probe-admin@boe.test', 'admin', 'Probe Admin');
insert into public.orders (id, display_number, status, client_name, created_by) values
  ('99999999-0000-4000-8000-00000000000a', 'ORD-PROBE', 'running', 'Probe Co',
   '99999999-9999-4999-8999-999999999999');

do $$ begin perform pg_temp.act_as('99999999-9999-4999-8999-999999999999'); end $$;

-- THE FOUR PROBES, IN PL/pgSQL AND NOT IN ONE SELECT.
--
-- Probe 4 CALLS two volatile RPCs and then reads the row they wrote. A single
-- SELECT takes one snapshot, so the payment those calls insert is not visible to
-- the rest of the same statement — the read comes back empty and the probe looks
-- like a fixture failure. Separate statements inside a function each take their
-- own snapshot, which is what makes the reproduction actually readable.

create or replace function pg_temp.probe() returns text
language plpgsql as $probe$
declare
  v_modes  text;
  v_pay    uuid;
  v_row    public.finance_payment_requests%rowtype;
  v_n      int;
  v_amount numeric;
begin
  -- 1. The payment-mode domain is still the five legacy values, and none of the
  --    four current accounts is storable.
  if (select count(*) from pg_constraint c
      where c.conrelid = 'public.finance_payment_requests'::regclass
        and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%payment_mode%'
        and pg_get_constraintdef(c.oid) like '%bank_transfer%'
        and pg_get_constraintdef(c.oid) not like '%hdfc%') = 1
  then v_modes := 'FIVE_LEGACY_MODES';
  else v_modes := 'MODES_ALREADY_MOVED';
  end if;

  -- 4. The defect, RUN rather than described.
  v_pay := (public.submit_payment_request(
    p_destination  => 'confirmed_order',
    p_target_id    => '99999999-0000-4000-8000-00000000000a',
    p_amount       => 100000,
    p_payment_date => current_date,
    p_payment_mode => 'bank_transfer')->>'payment_request_id')::uuid;

  perform public.approve_finance_payment_request(v_pay, 'probe');

  select * into v_row from public.finance_payment_requests where id = v_pay;
  select count(*), coalesce(sum(allocated_amount), 0) into v_n, v_amount
  from public.finance_payment_allocations
  where payment_request_id = v_pay and status = 'active';

  return v_modes
    || '|' || (case when to_regclass('public.finance_payment_custody_events') is null
                    then 'NO_CUSTODY_TABLE' else 'CUSTODY_TABLE_EXISTS' end)
    || '|' || (case when to_regclass('public.finance_payment_destinations') is null
                    then 'NO_DESTINATION_VIEW' else 'DESTINATION_VIEW_EXISTS' end)
    || '|' || (case
                 when v_row.status = 'approved_unlinked' and v_row.order_number is null
                      and v_n = 1 and v_amount = 100000
                 then 'APPROVES_UNLINKED'
                 else 'DEFECT_ALREADY_FIXED:' || v_row.status || '/'
                      || coalesce(v_row.order_number, '-') || '/' || v_n || '/' || v_amount
               end);
end $probe$;

select pg_temp.probe();

rollback;

-- Finance cash collection / handover assertions (20260716000000)
-- ===========================================================================
-- Validates the cash-trail contract introduced by
-- 20260716000000_finance_payment_collection_handover.sql:
--
--   * columns  collected_by_user_id, collected_from_text,
--              handed_over_to_user_id, handed_over_at, collection_handover_note
--   * CHECK    finance_payment_requests_handover_pair
--   * indexes  finance_payment_requests_collected_by_idx
--              finance_payment_requests_handed_over_to_idx
--   * trigger  finance_payment_requests_guard_approved  (five columns frozen)
--   * trigger  log_finance_payment_request_activity     (two new events, and
--              the unchanged silence on a plain field edit)
--
-- Runs entirely inside ONE transaction that ends in ROLLBACK, so every fixture
-- is discarded. Payment request_number comes from a transactional counter table,
-- so a rolled-back run leaves no numbering gap.
--
-- PREREQUISITES (controlled environment, migrations already applied):
--   * Run with psql as a role that bypasses RLS (standard Supabase `postgres`
--     connection) and may SET the `role` GUC / request.jwt.claims.
--   * Replace the THREE real user UUIDs below:
--       test.admin_id     -> a public.users row with role = 'admin'
--       test.sales_id     -> a NON-admin user (the collector / submitter)
--       test.receiver_id  -> a SECOND, DISTINCT user (the handover recipient)
--
-- On success prints NOTICE 'ALL ASSERTIONS PASSED' and rolls back. Any failed
-- ASSERT aborts the transaction with an error.
--
-- NOTE: like the other files in this directory, this script is run in a
-- controlled, already-migrated environment; it is not executed by the JS suite.

\set ON_ERROR_STOP on

begin;

-- ── Config: the ONLY lines a tester edits ─────────────────────────────────────
do $$
begin
  perform set_config('test.admin_id',    '11111111-1111-1111-1111-111111111111', true); -- REPLACE
  perform set_config('test.sales_id',    '22222222-2222-2222-2222-222222222222', true); -- REPLACE
  perform set_config('test.receiver_id', '33333333-3333-3333-3333-333333333333', true); -- REPLACE
end $$;

-- A reusable payment inserter, fixed on the PNB destination pair — the one
-- destination that captures the whole trail — so each assertion states only what
-- it is actually testing.
create or replace function pg_temp.new_cash_payment(
  p_client text default 'ASSERT cash payment'
) returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into public.finance_payment_requests
    (client_name, amount, payment_date, payment_mode, received_in, submitted_by)
  values
    (p_client, 100000, current_date, 'other', 'other',
     current_setting('test.sales_id')::uuid)
  returning id into v_id;
  return v_id;
end $$;

create or replace function pg_temp.fails_with(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

-- Counts activity rows of one event type on one payment.
create or replace function pg_temp.events(p_payment uuid, p_event text)
returns integer
language sql
as $$
  select count(*)::int
  from public.finance_payment_request_activity_log
  where payment_request_id = p_payment and event_type = p_event
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- A. Schema shape — nullable columns, real FKs, a date not a timestamp
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_n integer;
begin
  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public'
    and table_name   = 'finance_payment_requests'
    and column_name in ('collected_by_user_id', 'collected_from_text',
                        'handed_over_to_user_id', 'handed_over_at',
                        'collection_handover_note')
    and is_nullable  = 'YES';
  assert v_n = 5, 'all five cash-trail columns must exist and be nullable, found ' || v_n;

  -- handed_over_at records a DAY. A timestamptz would invent a time nobody
  -- recorded and re-render under the reader's timezone.
  assert (
    select data_type from information_schema.columns
    where table_schema='public' and table_name='finance_payment_requests'
      and column_name='handed_over_at'
  ) = 'date', 'handed_over_at must be a date';

  -- Both user references are real FKs, following this table's own convention
  -- (submitted_by / approved_by): NO ACTION, so a user named in a financial
  -- record cannot be deleted out from under it.
  select count(*) into v_n
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
  join information_schema.referential_constraints rc
    on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.constraint_schema
  where tc.table_schema = 'public'
    and tc.table_name   = 'finance_payment_requests'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name in ('collected_by_user_id', 'handed_over_to_user_id')
    and rc.delete_rule = 'NO ACTION';
  assert v_n = 2, 'both cash-trail user columns must be NO ACTION FKs, found ' || v_n;

  -- OLD ROWS REMAIN VALID. All five columns are nullable with no default and
  -- nothing is backfilled, so every pre-migration row must satisfy the new
  -- CHECK with nulls. Proven against real data, not inferred from the DDL.
  select count(*) into v_n
  from public.finance_payment_requests
  where (handed_over_to_user_id is null) <> (handed_over_at is null);
  assert v_n = 0, 'existing rows must all satisfy the handover pair rule, found ' || v_n;

  -- The guard TRIGGER is still attached. 20260716 replaces the function body
  -- WITHOUT recreating the trigger, so this is the assertion that proves the
  -- shortcut was safe.
  assert exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'finance_payment_requests'
      and t.tgname  = 'finance_payment_requests_guard_approved'
      and not t.tgisinternal
  ), 'the approved-row guard trigger must still be attached';

  -- NO PRIVILEGE EXPANSION. Neither replaced function may be callable by a
  -- client role; both are trigger functions reached only through the table.
  assert not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('finance_payment_requests_guard_approved',
                        'log_finance_payment_request_activity')
      and (has_function_privilege('authenticated', p.oid, 'execute')
        or has_function_privilege('anon',          p.oid, 'execute'))
  ), 'neither trigger function may be executable by anon or authenticated';

  raise notice 'A. schema shape, old rows, trigger and privileges OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- B. The handover pair moves together — or not at all
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_payment uuid;
  v_err     text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  v_payment := pg_temp.new_cash_payment('ASSERT handover pair');

  -- Neither half: not handed over yet. The normal state of a request submitted
  -- on the day the cash was collected.
  assert (select handed_over_to_user_id is null and handed_over_at is null
          from public.finance_payment_requests where id = v_payment),
    'a fresh cash payment must carry no handover';

  -- A recipient with no date is a record nobody can act on.
  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests
          set handed_over_to_user_id = %L where id = %L$q$,
    current_setting('test.receiver_id'), v_payment));
  assert v_err like '23514|%finance_payment_requests_handover_pair%',
    'a handover recipient with no date must be refused, got: ' || v_err;

  -- ...and a date with nobody named is the same defect from the other side.
  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests
          set handed_over_at = current_date where id = %L$q$, v_payment));
  assert v_err like '23514|%finance_payment_requests_handover_pair%',
    'a handover date with no recipient must be refused, got: ' || v_err;

  -- Both together: accepted.
  update public.finance_payment_requests
     set handed_over_to_user_id = current_setting('test.receiver_id')::uuid,
         handed_over_at         = current_date
   where id = v_payment;
  assert (select handed_over_to_user_id is not null and handed_over_at is not null
          from public.finance_payment_requests where id = v_payment),
    'a complete handover must be accepted';

  -- And clearing it takes both halves too — an undo is as constrained as a set.
  update public.finance_payment_requests
     set handed_over_to_user_id = null, handed_over_at = null
   where id = v_payment;
  assert (select handed_over_to_user_id is null and handed_over_at is null
          from public.finance_payment_requests where id = v_payment),
    'clearing both halves must be accepted';

  raise notice 'B. handover pair OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- C. Audit — two events, and the silence that was already there
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_payment uuid;
  v_before  integer;
  v_row     public.finance_payment_request_activity_log%rowtype;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  v_payment := pg_temp.new_cash_payment('ASSERT cash audit');

  -- 1. Collection details changing on a pre-approval request is recorded, with
  --    the NAMES resolved so the timeline is readable without a join.
  update public.finance_payment_requests
     set collected_by_user_id     = current_setting('test.sales_id')::uuid,
         collection_handover_note = 'collected at the showroom'
   where id = v_payment;

  assert pg_temp.events(v_payment, 'collection_details_updated') = 1,
    'a collection change must log exactly one collection_details_updated';

  select * into v_row
  from public.finance_payment_request_activity_log
  where payment_request_id = v_payment and event_type = 'collection_details_updated';
  assert v_row.payload->>'from_collected_by_id' is null,      'from side must record the previous null';
  assert v_row.payload->>'to_collected_by_id' = current_setting('test.sales_id'),
    'to side must record the new collector';
  assert v_row.payload->>'to_collected_by_name' is not null,  'the collector name must be resolved into the payload';
  assert v_row.payload->>'to_note' = 'collected at the showroom', 'the note must be recorded';

  -- 2. Re-saving the SAME values logs nothing. This is the noise rule: a form
  --    that is opened and saved unchanged must not produce a trail entry.
  v_before := pg_temp.events(v_payment, 'collection_details_updated');
  update public.finance_payment_requests
     set collected_by_user_id     = current_setting('test.sales_id')::uuid,
         collection_handover_note = 'collected at the showroom',
         updated_at               = now()
   where id = v_payment;
  assert pg_temp.events(v_payment, 'collection_details_updated') = v_before,
    'an unchanged re-save must log nothing';

  -- 3. The handover is its own event — it is the thing the business waits for.
  update public.finance_payment_requests
     set handed_over_to_user_id = current_setting('test.receiver_id')::uuid,
         handed_over_at         = current_date
   where id = v_payment;

  assert pg_temp.events(v_payment, 'cash_handover_recorded') = 1,
    'recording a handover must log exactly one cash_handover_recorded';

  select * into v_row
  from public.finance_payment_request_activity_log
  where payment_request_id = v_payment and event_type = 'cash_handover_recorded';
  assert v_row.payload->>'to_handed_over_to_id' = current_setting('test.receiver_id'),
    'the handover recipient must be recorded';
  assert v_row.payload->>'to_handed_over_to_name' is not null,
    'the recipient name must be resolved into the payload';
  assert v_row.payload->>'to_handed_over_at' is not null, 'the handover date must be recorded';

  -- 4. A handover AND a collection change in the same statement produce ONE
  --    row, not two — the handover wins and carries both.
  v_before := pg_temp.events(v_payment, 'collection_details_updated');
  update public.finance_payment_requests
     set handed_over_at           = current_date - 0,
         handed_over_to_user_id   = current_setting('test.sales_id')::uuid,
         collection_handover_note = 'handed over at the office'
   where id = v_payment;
  assert pg_temp.events(v_payment, 'cash_handover_recorded') = 2,
    'a combined change must log the handover event';
  assert pg_temp.events(v_payment, 'collection_details_updated') = v_before,
    'a combined change must NOT also log a collection event';

  -- 5. REGRESSION on the restructured trigger: a plain field edit that touches
  --    nothing in the cash trail is still recorded nowhere at all. This is the
  --    20260677 rule, and rewriting the final `else` branch must not have
  --    started logging ordinary edits.
  v_before := (select count(*)::int from public.finance_payment_request_activity_log
               where payment_request_id = v_payment);
  update public.finance_payment_requests
     set amount = 123456, proof_note = 'UTR 999', updated_at = now()
   where id = v_payment;
  assert (select count(*)::int from public.finance_payment_request_activity_log
          where payment_request_id = v_payment) = v_before,
    'a plain field edit must still log nothing';

  raise notice 'C. audit OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- D. Post-approval freeze — the five columns are part of what was approved
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  v_payment uuid;
  v_err     text;
  v_before  integer;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  v_payment := pg_temp.new_cash_payment('ASSERT cash freeze');
  update public.finance_payment_requests
     set collected_by_user_id = current_setting('test.sales_id')::uuid
   where id = v_payment;

  -- Approve it directly (this file is not testing the approval RPC).
  perform set_config('request.jwt.claims', null, true);
  update public.finance_payment_requests
     set status = 'approved_unlinked', approved_at = now(),
         approved_by = current_setting('test.admin_id')::uuid
   where id = v_payment;

  -- The submitter can no longer rewrite who collected the cash…
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);
  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests
          set collected_by_user_id = %L where id = %L$q$,
    current_setting('test.receiver_id'), v_payment));
  assert v_err like '42501|%approved%', 'a non-admin must not change the collector after approval, got: ' || v_err;

  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests
          set handed_over_to_user_id = %L, handed_over_at = current_date where id = %L$q$,
    current_setting('test.receiver_id'), v_payment));
  assert v_err like '42501|%approved%', 'a non-admin must not record a handover after approval, got: ' || v_err;

  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests
          set collection_handover_note = 'rewritten' where id = %L$q$, v_payment));
  assert v_err like '42501|%approved%', 'a non-admin must not rewrite the collection note after approval, got: ' || v_err;

  -- …and — the real regression risk of replacing this function — every field it
  -- ALREADY protected is still protected. Adding five names to a 17-name list is
  -- exactly the edit that silently drops one. One probe per pre-existing field.
  declare
    v_field text;
    v_sql   text;
  begin
    -- Custom dollar-quote tags below: the outer DO block already owns the
    -- default tag, and reusing it here would terminate it mid-array.
    foreach v_field in array array[
      $f$client_name = 'rewritten'$f$,
      $f$amount = 999999$f$,
      $f$payment_date = current_date - 1$f$,
      $f$payment_mode = 'cash'$f$,
      $f$received_in = 'cash_in_hand'$f$,
      $f$proof_note = 'rewritten'$f$,
      $f$sales_note = 'rewritten'$f$,
      $f$status = 'pending_approval'$f$,
      $f$order_number = 'REWRITTEN'$f$,
      $f$admin_note = 'rewritten'$f$,
      $f$approved_at = now()$f$,
      $f$created_at = now()$f$
    ] loop
      v_sql := format('update public.finance_payment_requests set %s where id = %L', v_field, v_payment);
      v_err := pg_temp.fails_with(v_sql);
      assert v_err like '42501|%approved%',
        'the guard must still refuse "' || v_field || '" after approval, got: ' || v_err;
    end loop;
  end;

  -- …but an admin still can, which is what "correcting an approved record is an
  -- admin action" means everywhere else on this table.
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.admin_id'), 'role', 'authenticated')::text, true);
  update public.finance_payment_requests
     set collected_by_user_id = current_setting('test.receiver_id')::uuid
   where id = v_payment;
  assert (select collected_by_user_id from public.finance_payment_requests where id = v_payment)
         = current_setting('test.receiver_id')::uuid,
    'an admin must still be able to correct the collector';

  -- The cash-trail audit is scoped to the PRE-APPROVAL window, so an admin's
  -- post-approval correction is governed by the approval trail, not by these
  -- two events.
  v_before := pg_temp.events(v_payment, 'collection_details_updated');
  assert v_before = 1, 'only the pre-approval collection change should have logged, found ' || v_before;

  raise notice 'D. post-approval freeze OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- E. The event_type CHECK is a UNION, not a retyped list
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def
  from pg_constraint
  where conname = 'finance_payment_request_activity_log_event_type_check';

  -- The two new ones…
  assert v_def like '%collection_details_updated%', 'collection_details_updated must be allowed';
  assert v_def like '%cash_handover_recorded%',     'cash_handover_recorded must be allowed';
  -- …and every one that was already there. A drop-and-recreate CHECK silently
  -- revokes anything omitted, and an empty table hides it until the first write.
  assert v_def like '%request_submitted%',      'request_submitted must survive';
  assert v_def like '%order_linked%',           'order_linked must survive';
  assert v_def like '%order_unlinked%',         'order_unlinked must survive';
  assert v_def like '%order_link_changed%',     'order_link_changed must survive';
  assert v_def like '%order_request_linked%',   'order_request_linked must survive';
  assert v_def like '%order_request_unlinked%', 'order_request_unlinked must survive';
  assert v_def like '%target_changed%',         'target_changed must survive';
  assert v_def like '%status_changed%',         'status_changed must survive';

  raise notice 'E. event_type CHECK OK';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F. Cash cannot be handed over before it was collected  (20260717000000)
-- ═══════════════════════════════════════════════════════════════════════════
-- The form refuses this too, but a form is bypassed by a direct PostgREST call
-- and by a stale client. These assertions are about the DATABASE's answer.
--
-- Every write below sets the recipient and the date TOGETHER, because
-- finance_payment_requests_handover_pair independently forbids one without the
-- other — which is also what makes the last assertion here meaningful.
do $$
declare
  v_payment uuid;
  v_err     text;
  v_paid    date;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', current_setting('test.sales_id'), 'role', 'authenticated')::text, true);

  -- 1. The constraint exists and says what it is supposed to say.
  assert exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'finance_payment_requests'
      and c.conname = 'finance_payment_requests_handover_not_before_payment'
      and c.contype = 'c'
  ), 'the handover-date guard constraint must exist';

  v_payment := pg_temp.new_cash_payment('ASSERT handover date guard');
  select payment_date into v_paid from public.finance_payment_requests where id = v_payment;

  -- 2. No handover date at all stays valid — the normal state of a PNB payment
  --    on the day it is submitted. The constraint is NULL-permissive.
  assert (select handed_over_at is null from public.finance_payment_requests where id = v_payment),
    'a payment with no handover must remain valid';

  -- 3. Same day: collecting and handing over on one day is ordinary, not an
  --    error. This is the boundary the >= is there for.
  update public.finance_payment_requests
     set handed_over_to_user_id = current_setting('test.receiver_id')::uuid,
         handed_over_at         = v_paid
   where id = v_payment;
  assert (select handed_over_at = v_paid from public.finance_payment_requests where id = v_payment),
    'a same-day handover must be accepted';

  -- 4. The following day — the case this whole workflow exists for.
  update public.finance_payment_requests
     set handed_over_at = v_paid + 1
   where id = v_payment;
  assert (select handed_over_at = v_paid + 1 from public.finance_payment_requests where id = v_payment),
    'a later handover must be accepted';

  -- 5. The day before is refused. Cash cannot be handed over before it was
  --    collected, whatever the client believes.
  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests set handed_over_at = %L where id = %L$q$,
    v_paid - 1, v_payment));
  assert v_err like '23514|%finance_payment_requests_handover_not_before_payment%',
    'a handover before the payment date must be refused, got: ' || v_err;

  -- 5b. The same rule seen from the other side: moving payment_date FORWARD past
  --     an existing handover is refused too. This is the accepted cost recorded
  --     in 20260717's header — asserted so it is a known behaviour, not a
  --     surprise the first time an admin corrects a date.
  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests set payment_date = %L where id = %L$q$,
    v_paid + 5, v_payment));
  assert v_err like '23514|%finance_payment_requests_handover_not_before_payment%',
    'moving payment_date past the handover must be refused, got: ' || v_err;

  -- …and correcting BOTH in one statement is how that is done.
  update public.finance_payment_requests
     set payment_date = v_paid + 5, handed_over_at = v_paid + 6
   where id = v_payment;
  assert (select payment_date = v_paid + 5 and handed_over_at = v_paid + 6
          from public.finance_payment_requests where id = v_payment),
    'correcting both dates together must be accepted';

  -- 6. The PAIR constraint is untouched by all of this: a date still cannot
  --    exist without a recipient.
  v_err := pg_temp.fails_with(format(
    $q$update public.finance_payment_requests
          set handed_over_to_user_id = null where id = %L$q$, v_payment));
  assert v_err like '23514|%finance_payment_requests_handover_pair%',
    'the recipient/date pair rule must still hold, got: ' || v_err;

  raise notice 'F. handover date guard OK';
end $$;

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;

rollback;

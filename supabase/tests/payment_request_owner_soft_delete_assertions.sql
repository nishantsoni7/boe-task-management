-- Payment request owner soft delete — assertions
-- ===========================================================================
-- Covers 20270226000000_payment_request_owner_soft_delete.sql:
--
--   A. The owner can delete Pending, Needs Clarification, Rejected and an
--      archived (old rejected) request; history is retained
--   B. Another salesperson cannot, by RPC or by a direct write
--   C. Approved/confirmed payments are protected — including an archived row
--      that was once approved (approval stamp, and trail-only evidence)
--   D. A deleted row vanishes for every reader and is frozen for every writer,
--      approval included
--   E. Allocations are reversed (kept), intents cancelled, nothing new attaches
--   F. A submitter can no longer hard-DELETE through the API; admin deletion survives
--   G. A rejection leaves the cancelled link readable (the client shows it)
--
-- Runs inside ONE transaction that ends in ROLLBACK. The approval/deletion race
-- (two sessions) cannot run in one transaction; see the PR for that run.
--
-- PREREQUISITE: a database with the Finance/Orders chain through 20270225000000
-- and the REAL 20270226000000 migration applied.
-- Run: psql -v ON_ERROR_STOP=1 -f payment_request_owner_soft_delete_assertions.sql

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.fails_with(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'NO ERROR';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $$;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not p_condition then raise exception 'ASSERTION FAILED: %', p_what; end if;
end $$;

-- Become a user for the rest of the transaction. Clears the claim first so a
-- fixture insert is never judged as the previous actor.
create or replace function pg_temp.become(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.s1()  returns uuid language sql immutable as $$ select 'a1000000-0000-4000-8000-000000000001'::uuid $$;
create or replace function pg_temp.s2()  returns uuid language sql immutable as $$ select 'a1000000-0000-4000-8000-000000000002'::uuid $$;
create or replace function pg_temp.adm() returns uuid language sql immutable as $$ select 'a1000000-0000-4000-8000-000000000003'::uuid $$;

insert into public.users (id, full_name, email, role, team, is_active) values
  (pg_temp.s1(),  'Sales One',  'sd1@boe.test', 'member', 'sales', true),
  (pg_temp.s2(),  'Sales Two',  'sd2@boe.test', 'member', 'sales', true),
  (pg_temp.adm(), 'Admin',      'sd3@boe.test', 'admin', 'management', true);

-- Finance module entry for both salespeople (the restrictive gate), so that
-- "cannot see it afterwards" is a statement about the delete, not about access.
insert into public.employee_permission_overrides (user_id, module_id, action_id, allowed, granted_by)
select u.id, m.id, a.id, true, pg_temp.adm()
  from (values (pg_temp.s1()), (pg_temp.s2())) u(id)
  join public.permission_modules m on m.module_key = 'finance'
  join public.permission_actions a on a.action_key = 'view';

-- ── Fixtures (as the table owner; inserts are revoked from authenticated) ────

create or replace function pg_temp.mk(p_no text, p_by uuid, p_status text, p_amount numeric default 1000)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.finance_payment_requests
    (request_number, client_name, amount, payment_date, payment_mode, submitted_by, status)
  values (p_no, 'Client ' || p_no, p_amount, current_date, 'hdfc', p_by, p_status)
  returning id into v_id;
  return v_id;
end $$;

create temp table ids (k text primary key, id uuid);
insert into ids values
  ('pend',  pg_temp.mk('SD-PEND',  pg_temp.s1(), 'pending_approval')),
  ('clar',  pg_temp.mk('SD-CLAR',  pg_temp.s1(), 'needs_clarification')),
  ('rej',   pg_temp.mk('SD-REJ',   pg_temp.s1(), 'rejected')),
  ('arch',  pg_temp.mk('SD-ARCH',  pg_temp.s1(), 'rejected')),
  ('other', pg_temp.mk('SD-OTHER', pg_temp.s2(), 'pending_approval')),
  ('race',  pg_temp.mk('SD-RACE',  pg_temp.s1(), 'pending_approval')),
  ('okap',  pg_temp.mk('SD-OKAP',  pg_temp.s1(), 'pending_approval')),
  ('ghost', pg_temp.mk('SD-GHOST', pg_temp.s1(), 'rejected'));
grant select on ids to authenticated;

-- An archived row: rejected 40 days ago.
update public.finance_payment_requests
   set rejected_at = now() - interval '40 days', updated_at = now() - interval '40 days'
 where id = (select id from ids where k = 'arch');

-- An approved payment (directly; the approval path is exercised separately).
insert into ids values ('appr', pg_temp.mk('SD-APPR', pg_temp.s1(), 'pending_approval'));
update public.finance_payment_requests set status = 'approved_unlinked',
       approved_by = pg_temp.adm(), approved_at = now()
 where id = (select id from ids where k = 'appr');

-- An archived row whose ONLY evidence of approval is the trail: status was
-- walked back to rejected (an admin direct write; no stamp survives).
insert into public.finance_payment_request_activity_log (payment_request_id, actor_id, event_type, payload)
select id, pg_temp.adm(), 'status_changed',
       jsonb_build_object('from_status', 'pending_approval', 'to_status', 'approved_unlinked')
  from ids where k = 'ghost';

-- A PI draft the pending request is allocated to, plus a pending intent on it.
create temp table pi (id uuid);
with s as (
  insert into public.order_submissions (submitted_by, created_by)
  values (pg_temp.s1(), pg_temp.s1()) returning id
) insert into pi select id from s;

insert into public.finance_payment_allocations
  (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by)
select (select id from ids where k = 'pend'), (select id from pi), 400, 'order_submission', pg_temp.s1();

insert into public.finance_payment_allocation_intents
  (payment_request_id, target_type, order_submission_id, intended_amount, created_by)
select (select id from ids where k = 'clar'), 'pi_draft', (select id from pi), 300, pg_temp.s1();

create or replace function pg_temp.id(p_k text) returns uuid language sql stable as $$
  select id from ids where k = p_k $$;

-- ═══ 0. Before: the owner can see their requests, the other salesperson cannot ═══
do $$
begin
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  perform pg_temp.ok((select count(*) from public.finance_payment_requests
                       where id in (select id from ids where k in ('pend','clar','rej','arch'))) = 4,
    '0a. the owner sees all four before deleting');
  reset role;
  perform pg_temp.become(pg_temp.s2());
  set local role authenticated;
  perform pg_temp.ok((select count(*) from public.finance_payment_requests
                       where id in (select id from ids where k in ('pend','clar','rej','arch'))) = 0,
    '0b. another salesperson never saw them');
  reset role;
end $$;

-- ═══ A + E. The owner deletes; history is retained ══════════════════════════

do $$
declare r jsonb;
begin
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;

  r := public.delete_own_payment_request(pg_temp.id('pend'));
  perform pg_temp.ok((r->>'already_deleted')::boolean = false, 'A1. Pending request deleted');
  perform pg_temp.ok((r->>'allocations_reversed')::int = 1, 'E1. its one active allocation is reversed, not erased');

  r := public.delete_own_payment_request(pg_temp.id('clar'));
  perform pg_temp.ok((r->>'already_deleted')::boolean = false, 'A2. Needs Clarification request deleted');

  r := public.delete_own_payment_request(pg_temp.id('rej'));
  perform pg_temp.ok((r->>'already_deleted')::boolean = false, 'A3. Rejected request deleted');

  r := public.delete_own_payment_request(pg_temp.id('arch'));
  perform pg_temp.ok((r->>'already_deleted')::boolean = false, 'A4. archived (never approved) request deleted');

  r := public.delete_own_payment_request(pg_temp.id('pend'));
  perform pg_temp.ok((r->>'already_deleted')::boolean = true, 'A5. a repeat is a no-op, not an error');

  reset role;
  raise notice 'A/E (owner deletes) PASSED';
end $$;

do $$
begin
  -- Retained history (read as the table owner, who bypasses the hiding policy).
  perform pg_temp.ok((select deleted_by from public.finance_payment_requests where id = pg_temp.id('pend')) = pg_temp.s1(),
    'A6. actor recorded');
  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('pend')) is not null,
    'A7. time recorded');
  perform pg_temp.ok((select count(*) from public.finance_payment_request_activity_log
                       where payment_request_id = pg_temp.id('pend') and event_type = 'request_deleted') = 1,
    'A8. a request_deleted trail row exists, written once');
  perform pg_temp.ok((select count(*) from public.finance_payment_request_activity_log
                       where payment_request_id = pg_temp.id('pend') and event_type = 'request_submitted') >= 0
                     and (select count(*) from public.finance_payment_request_activity_log
                           where payment_request_id = pg_temp.id('pend')) >= 2,
    'A9. the earlier history is still there');
  perform pg_temp.ok((select status from public.finance_payment_allocations
                       where payment_request_id = pg_temp.id('pend')) = 'reversed',
    'E2. the allocation row survives, reversed');
  perform pg_temp.ok((select reversal_reason from public.finance_payment_allocations
                       where payment_request_id = pg_temp.id('pend')) is not null, 'E3. with a reason');
  perform pg_temp.ok((select status from public.finance_payment_allocation_intents
                       where payment_request_id = pg_temp.id('clar')) = 'cancelled',
    'E4. a pending intent is cancelled');
end $$;

-- ═══ D. A deleted row disappears for every reader ═══════════════════════════

do $$
begin
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  perform pg_temp.ok((select count(*) from public.finance_payment_requests
                       where id in (select id from ids where k in ('pend','clar','rej','arch'))) = 0,
    'D1. the owner no longer sees any of them');
  perform pg_temp.ok((select count(*) from public.finance_payment_requests
                       where status = 'rejected' and client_name like 'Client SD-%') = 1,
    'D2. active lists/counts: only the never-deleted-but-protected "ghost" rejected row remains');
  reset role;

  perform pg_temp.become(pg_temp.adm());
  set local role authenticated;
  perform pg_temp.ok((select count(*) from public.finance_payment_requests
                       where id in (select id from ids where k in ('pend','clar','rej','arch'))) = 0,
    'D3. nor does an admin');
  perform pg_temp.ok((select count(*) from public.finance_received_payments
                       where id in (select id from ids where k in ('pend','clar','rej','arch'))) = 0,
    'D4. nor does the Received Payments view');
  reset role;
  raise notice 'D (hidden) PASSED';
end $$;

-- ═══ B. Another salesperson cannot ═══════════════════════════════════════════

do $$
declare e text;
begin
  perform pg_temp.become(pg_temp.s2());
  set local role authenticated;

  e := pg_temp.fails_with(format('select public.delete_own_payment_request(%L)', pg_temp.id('ghost')));
  perform pg_temp.ok(e like '42501|PAYMENT_NOT_OWNER%', 'B1. RPC refuses another person''s request: ' || e);

  -- Direct PATCH of someone else's request: invisible, so zero rows.
  update public.finance_payment_requests set deleted_at = now(), deleted_by = pg_temp.s2()
   where id = pg_temp.id('ghost');
  get diagnostics e = row_count;
  perform pg_temp.ok(e::int = 0, 'B2. direct PATCH of another''s row touches nothing');
  reset role;

  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('ghost')) is null,
    'B3. the row is intact');

  -- A request that does not exist at all.
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  e := pg_temp.fails_with(format('select public.delete_own_payment_request(%L)', gen_random_uuid()));
  perform pg_temp.ok(e like 'P0002|PAYMENT_NOT_FOUND%', 'B4. unknown id: ' || e);

  -- The owner cannot bypass the RPC with their own UPDATE policy.
  e := pg_temp.fails_with(format(
    'update public.finance_payment_requests set deleted_at = now(), deleted_by = %L where id = %L',
    pg_temp.s1(), pg_temp.id('other')));
  reset role;
  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('other')) is null,
    'B5. nothing was written to the other person''s row');

  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  e := pg_temp.fails_with(format(
    'update public.finance_payment_requests set deleted_at = now(), deleted_by = %L where id = %L',
    pg_temp.s1(), pg_temp.id('okap')));
  reset role;
  perform pg_temp.ok(e like '42501|PAYMENT_DELETE_REFUSED%', 'B6. the owner''s own PATCH of deleted_at is refused: ' || e);
  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('okap')) is null,
    'B7. and nothing changed');
  raise notice 'B (not the owner) PASSED';
end $$;

-- ═══ C. Approved / confirmed are protected ═══════════════════════════════════

do $$
declare e text;
begin
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;

  e := pg_temp.fails_with(format('select public.delete_own_payment_request(%L)', pg_temp.id('appr')));
  perform pg_temp.ok(e like '23514|PAYMENT_APPROVED%', 'C1. approved payment refused: ' || e);

  e := pg_temp.fails_with(format('select public.delete_own_payment_request(%L)', pg_temp.id('ghost')));
  perform pg_temp.ok(e like '23514|PAYMENT_APPROVED%',
    'C2. a rejected/archived row that the trail shows was once approved is refused: ' || e);
  reset role;

  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('appr')) is null,
    'C3. approved row untouched');
  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('ghost')) is null,
    'C4. once-approved archived row untouched');

  -- An approval stamp alone is enough, whatever the status says.
  update public.finance_payment_requests set approved_at = now(), approved_by = pg_temp.adm()
   where id = pg_temp.id('okap');
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  e := pg_temp.fails_with(format('select public.delete_own_payment_request(%L)', pg_temp.id('okap')));
  reset role;
  perform pg_temp.ok(e like '23514|PAYMENT_APPROVED%', 'C5. an approval stamp alone blocks deletion: ' || e);
  update public.finance_payment_requests set approved_at = null, approved_by = null where id = pg_temp.id('okap');
  raise notice 'C (protected) PASSED';
end $$;

-- ═══ D2. A deleted row is frozen — approval included ═════════════════════════

do $$
declare e text;
begin
  -- Delete 'race', then try to approve it as the approver (admin).
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  perform public.delete_own_payment_request(pg_temp.id('race'));
  reset role;

  perform pg_temp.become(pg_temp.adm());
  set local role authenticated;
  e := pg_temp.fails_with(format('select public.approve_finance_payment_request(%L, null)', pg_temp.id('race')));
  reset role;
  perform pg_temp.ok(e <> 'NO ERROR', 'D5. approving a deleted request fails: ' || e);
  perform pg_temp.ok((select status from public.finance_payment_requests where id = pg_temp.id('race')) = 'pending_approval',
    'D6. and it stayed pending (nothing approved)');
  perform pg_temp.ok((select count(*) from public.finance_payment_allocations
                       where payment_request_id = pg_temp.id('race') and status = 'active') = 0,
    'D7. no allocation was applied');

  e := pg_temp.fails_with(format('update public.finance_payment_requests set admin_note = ''x'' where id = %L', pg_temp.id('race')));
  perform pg_temp.ok(e like '42501|PAYMENT_REQUEST_DELETED%', 'D8. even the table owner cannot edit a deleted row: ' || e);

  e := pg_temp.fails_with(format('update public.finance_payment_requests set deleted_at = null, deleted_by = null where id = %L', pg_temp.id('race')));
  perform pg_temp.ok(e like '42501|PAYMENT_REQUEST_DELETED%', 'D9. a deletion cannot be undone');

  -- Nothing new may attach to a deleted payment.
  e := pg_temp.fails_with(format(
    'insert into public.finance_payment_allocations (payment_request_id, order_submission_id, allocated_amount, origin_target_type, created_by) values (%L, %L, 10, ''order_submission'', %L)',
    pg_temp.id('pend'), (select id from pi), pg_temp.s1()));
  perform pg_temp.ok(e like '42501|PAYMENT_REQUEST_DELETED%', 'E5. no allocation can be added to a deleted payment: ' || e);
  e := pg_temp.fails_with(format(
    'insert into public.finance_payment_allocation_intents (payment_request_id, target_type, order_submission_id, intended_amount, created_by) values (%L, ''pi_draft'', %L, 10, %L)',
    pg_temp.id('pend'), (select id from pi), pg_temp.s1()));
  perform pg_temp.ok(e like '42501|PAYMENT_REQUEST_DELETED%', 'E6. nor an intent: ' || e);
  raise notice 'D2/E (frozen) PASSED';
end $$;

-- ═══ Approval first, then delete ═════════════════════════════════════════════

do $$
declare e text;
begin
  perform pg_temp.become(pg_temp.adm());
  set local role authenticated;
  perform public.approve_finance_payment_request(pg_temp.id('okap'), null);
  reset role;
  perform pg_temp.ok((select status from public.finance_payment_requests where id = pg_temp.id('okap')) like 'approved%',
    'R1. the approval committed');

  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  e := pg_temp.fails_with(format('select public.delete_own_payment_request(%L)', pg_temp.id('okap')));
  reset role;
  perform pg_temp.ok(e like '23514|PAYMENT_APPROVED%', 'R2. a request approved while the dialog was open cannot be deleted: ' || e);
  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('okap')) is null,
    'R3. and it is intact');
  raise notice 'R (approve-then-delete) PASSED';
end $$;

-- ═══ F. The bypass is closed: no direct DELETE for the submitter ═════════════

do $$
declare n int; e text;
begin
  insert into ids values ('byp', pg_temp.mk('SD-BYP', pg_temp.s1(), 'pending_approval'));
  insert into public.finance_payment_request_activity_log (payment_request_id, actor_id, event_type, payload)
  values (pg_temp.id('byp'), pg_temp.s1(), 'status_changed', jsonb_build_object('from_status','x','to_status','pending_approval'));

  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  delete from public.finance_payment_requests where id = pg_temp.id('byp');
  get diagnostics n = row_count;
  perform pg_temp.ok(n = 0, 'F1. the submitter''s direct DELETE of their own unapproved request removes nothing');
  reset role;
  perform pg_temp.ok((select count(*) from public.finance_payment_requests where id = pg_temp.id('byp')) = 1, 'F2. the row is still there');
  perform pg_temp.ok((select count(*) from public.finance_payment_request_activity_log where payment_request_id = pg_temp.id('byp')) >= 1,
    'F3. and so is its history');

  -- The only DELETE policies left are the admin and finance.delete ones.
  perform pg_temp.ok((select count(*) from pg_policy where polrelid = 'public.finance_payment_requests'::regclass
                       and polcmd = 'd' and polname like '%own_delete%') = 0, 'F4. no own_delete policy remains');

  -- The soft-delete RPC still works for the same request.
  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  perform public.delete_own_payment_request(pg_temp.id('byp'));
  reset role;
  perform pg_temp.ok((select deleted_at from public.finance_payment_requests where id = pg_temp.id('byp')) is not null,
    'F5. the RPC still soft-deletes it, and the history is kept');

  -- Authorised admin deletion still works: a direct admin DELETE of an unapproved row.
  insert into ids values ('adm', pg_temp.mk('SD-ADM', pg_temp.s2(), 'pending_approval'));
  perform pg_temp.become(pg_temp.adm());
  set local role authenticated;
  delete from public.finance_payment_requests where id = pg_temp.id('adm');
  get diagnostics n = row_count;
  reset role;
  perform pg_temp.ok(n = 1, 'F6. an admin can still delete an unapproved request');

  -- ...and an approved payment is still protected from the admin's DELETE policy by the guard trigger.
  perform pg_temp.become(pg_temp.adm());
  set local role authenticated;
  e := pg_temp.fails_with(format('delete from public.finance_payment_requests where id = %L', pg_temp.id('appr')));
  reset role;
  perform pg_temp.ok(e <> 'NO ERROR' or (select count(*) from public.finance_payment_requests where id = pg_temp.id('appr')) = 1,
    'F7. an approved payment survives a direct DELETE');
  raise notice 'F (bypass closed) PASSED';
end $$;

-- ═══ G. A rejection leaves the cancelled link readable by its owner ══════════

do $$
declare pi uuid; pay uuid; ordr uuid; r record;
begin
  select id into pi from public.order_submissions order by created_at limit 1;
  insert into ids values ('rej2', pg_temp.mk('SD-REJ2', pg_temp.s1(), 'pending_approval'));
  pay := pg_temp.id('rej2');
  insert into public.finance_payment_allocation_intents (payment_request_id, target_type, order_submission_id, intended_amount, created_by)
  values (pay, 'pi_draft', pi, 100, pg_temp.s1());

  perform pg_temp.become(pg_temp.adm());
  set local role authenticated;
  perform public.reject_finance_payment_request(pay, 'not matching');
  reset role;

  perform pg_temp.become(pg_temp.s1());
  set local role authenticated;
  select status, cancelled_reason, order_submission_id into r
    from public.finance_payment_allocation_intents where payment_request_id = pay;
  reset role;
  perform pg_temp.ok(r.status = 'cancelled', 'G1. rejection cancels the intent (unchanged)');
  perform pg_temp.ok(r.cancelled_reason = 'payment request rejected',
    'G2. with the exact reason the client reads it back by');
  perform pg_temp.ok(r.order_submission_id = pi, 'G3. and the cancelled intent still names the original PI');
  perform pg_temp.ok((select count(*) from public.finance_payment_allocation_intents
                       where payment_request_id = pay and status = 'pending') = 0,
    'G4. the link stays cancelled — nothing is reactivated');
  raise notice 'G (rejection context) PASSED';
end $$;

select 'ALL PAYMENT REQUEST SOFT DELETE ASSERTIONS PASSED' as result;

rollback;

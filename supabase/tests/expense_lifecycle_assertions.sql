-- ── 20261222000000, PROVEN ──────────────────────────────────────────────────
--
-- Run against a disposable database that holds:
--   * the shaped base (_expense_lifecycle_shaped_schema.sql),
--   * the two Phase 1 migrations, applied for real,
--   * the EXACT expense and category production holds, copied byte for byte,
--   * and 20261222000000, applied for real.
--
-- Every assertion below runs as a CLIENT ROLE with `set local role authenticated`
-- and a jwt sub, so RLS is actually in force — a check that ran as the owner
-- would prove nothing about the policies.
--
-- It creates and destroys its own test rows; the production copy is used only
-- as the row that must NOT change.

\set ON_ERROR_STOP on

-- ── People ──────────────────────────────────────────────────────────────────
-- Reuses the production author's id so the copied expense's created_by resolves.

\set author   '''6507df9f-cdeb-4ebd-849f-8498c165d596'''
\set creator  '''11111111-1111-1111-1111-111111111111'''
\set manager  '''22222222-2222-2222-2222-222222222222'''
\set outsider '''33333333-3333-3333-3333-333333333333'''
\set admin    '''44444444-4444-4444-4444-444444444444'''

insert into public.users (id, full_name, role) values
  (:creator,  'Creator',  'employee'),
  (:manager,  'Manager',  'employee'),
  (:outsider, 'Outsider', 'employee'),
  (:admin,    'Admin',    'admin')
on conflict (id) do nothing;

-- Finance entry for everybody except the outsider — who is the control.
insert into public.test_module_entry (user_id, module_key) values
  (:author, 'finance'), (:creator, 'finance'), (:manager, 'finance')
on conflict do nothing;

-- THE MANAGER HOLDS view_all AS WELL AS manage, AND THAT IS NOT PADDING.
--
-- Phase 1 grants visibility through three SELECT policies — admin, the
-- protected finance.view_all, and your own rows — and `manage` is in NONE of
-- them. It is a write authority and confers no sight of anything.
--
-- PostgreSQL requires SELECT permission on a row for an UPDATE whose WHERE
-- clause reads a column, so a manage-only holder cannot reach somebody else's
-- expense at all: not to correct it (Phase 1) and not to remove it (this
-- phase). That is coherent — you cannot act on a row you cannot see, and a
-- screen could not draw the button either — and section 2f-bis below pins it
-- rather than leaving it to be rediscovered. A real holder of manage holds
-- view_all too, which is what this row models.
insert into public.test_permissions (user_id, module_key, action_key) values
  (:author,  'finance', 'create'),
  (:creator, 'finance', 'create'),
  (:manager, 'finance', 'create'),
  (:manager, 'finance', 'manage'),
  (:manager, 'finance', 'view_all')
on conflict do nothing;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void language plpgsql as $$
begin
  if not p_condition then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok: %', p_what;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. THE PRODUCTION ROW IS UNTOUCHED, AND STILL COUNTS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v record;
begin
  select * into v from public.expenses
  where id = '5509dffb-df89-47f2-944b-1eeb432319f2';

  perform pg_temp.ok(v.id is not null, 'the production expense survived the migration');
  perform pg_temp.ok(v.amount = 1000.00, 'its amount is unchanged');
  perform pg_temp.ok(v.paid_to = 'MCD', 'its payee is unchanged');
  perform pg_temp.ok(v.remark = 'Sewage Cleaning', 'its remark is unchanged');
  perform pg_temp.ok(v.expense_date = date '2026-09-20', 'its date is unchanged');
  perform pg_temp.ok(v.payment_mode = 'cash', 'its mode is unchanged');
  perform pg_temp.ok(v.created_by = '6507df9f-cdeb-4ebd-849f-8498c165d596'::uuid,
    'its author is unchanged');
  perform pg_temp.ok(v.created_at = '2026-09-20 08:24:19.818794+00'::timestamptz,
    'its created_at is unchanged — the ALTER did not touch a timestamp');
  perform pg_temp.ok(v.updated_at = '2026-09-20 08:24:19.818794+00'::timestamptz,
    'AND ITS updated_at IS UNCHANGED: adding a column is not an UPDATE, so the '
    'set_updated_at trigger never fired');
  perform pg_temp.ok(v.deleted_at is null and v.deleted_by is null,
    'THE TOMBSTONE LANDED NULL: the expense that existed still counts');
end $$;

do $$
declare v_total int; v_live int;
begin
  select count(*), count(*) filter (where deleted_at is null) into v_total, v_live
  from public.expenses;
  perform pg_temp.ok(v_total = v_live, 'every expense in the table is live');
end $$;

-- The category is untouched too, and still active.
do $$
declare v record;
begin
  select * into v from public.expense_categories
  where id = '8a0b094a-ddfd-4f97-a204-ac96c983e5b1';
  perform pg_temp.ok(v.name = 'Factory Maintenance', 'the production category is unchanged');
  perform pg_temp.ok(v.is_active, 'and still active');
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. SOFT DELETION
-- ═══════════════════════════════════════════════════════════════════════════

-- A test expense of the creator's, recorded through RLS as the creator.
do $$
declare v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, remark, created_by)
  values (current_date, 250.00, 'cash', 'Test Payee', '8a0b094a-ddfd-4f97-a204-ac96c983e5b1',
          'lifecycle suite', auth.uid())
  returning id into v_id;
  perform pg_temp.ok(v_id is not null, 'finance.create records an expense through RLS');

  -- ── 2a. THE AUTHOR MAY REMOVE IT ──
  update public.expenses
  set deleted_by = auth.uid(), updated_by = auth.uid()
  where id = v_id and deleted_at is null;
  perform pg_temp.ok(found, 'its author may soft-delete it');

  perform pg_temp.ok(
    (select deleted_at is not null and deleted_by = auth.uid() from public.expenses where id = v_id),
    'the tombstone names its author and carries a server timestamp');

  -- ── 2b. NOTHING ELSE CHANGED ──
  perform pg_temp.ok(
    (select amount = 250.00 and paid_to = 'Test Payee' and remark = 'lifecycle suite'
     from public.expenses where id = v_id),
    'the amount, payee and remark are preserved by the removal');

  -- ── 2c. A DELETED EXPENSE IS NOT EDITABLE ──
  begin
    update public.expenses set amount = 1.00, updated_by = auth.uid() where id = v_id;
    raise exception 'FAILED: a deleted expense was edited';
  exception when insufficient_privilege then
    raise notice 'ok: a deleted expense cannot be edited';
  end;

  -- ── 2d. UN-DELETING IS NOT AN UPDATE ──
  begin
    update public.expenses set deleted_at = null, deleted_by = null, updated_by = auth.uid()
    where id = v_id;
    raise exception 'FAILED: a deleted expense was resurrected';
  exception when insufficient_privilege then
    raise notice 'ok: a deleted expense cannot be un-deleted';
  end;

  reset role;
end $$;

-- ── 2e. A HARD DELETE IS REFUSED, BEFORE ANY POLICY IS CONSULTED ──
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  begin
    delete from public.expenses where id = '5509dffb-df89-47f2-944b-1eeb432319f2';
    raise exception 'FAILED: an admin hard-deleted an expense';
  exception when insufficient_privilege then
    raise notice 'ok: DELETE is refused for a client role — even an admin''s';
  end;
  reset role;
end $$;

-- ── 2f. A STRANGER MAY NOT REMOVE SOMEBODY ELSE'S ──
do $$
declare v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by)
  values (current_date, 99.00, 'cash', 'Stranger Test', '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', auth.uid())
  returning id into v_id;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  update public.expenses set deleted_by = auth.uid(), updated_by = auth.uid() where id = v_id;
  perform pg_temp.ok(not found, 'somebody outside Finance cannot remove an expense');
  perform pg_temp.ok((select count(*) from public.expenses) >= 0, 'and sees nothing of it');
  reset role;

  -- ── 2g. finance.manage (with view_all) MAY remove somebody else's ──
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  update public.expenses set deleted_by = auth.uid(), updated_by = auth.uid()
  where id = v_id and deleted_at is null;
  perform pg_temp.ok(found, 'a holder of the protected finance.manage may remove it');
  perform pg_temp.ok(
    (select deleted_by = '22222222-2222-2222-2222-222222222222'::uuid
     from public.expenses where id = v_id),
    'and the tombstone names the manager, not the author');
  reset role;
end $$;

-- ── 2f-bis. MANAGE CONFERS NO SIGHT, AND THEREFORE NO REACH ────────────────
--
-- Pinned because it is the non-obvious consequence of Phase 1's policy set and
-- because a future reader will otherwise "fix" it by adding a SELECT policy for
-- manage — which would quietly widen who can read every expense in the company.
do $$
declare v_id uuid; v_seen int;
begin
  -- A manage holder with NO view_all.
  insert into public.users (id, full_name, role)
  values ('55555555-5555-5555-5555-555555555555', 'Manage only', 'employee')
  on conflict (id) do nothing;
  insert into public.test_module_entry (user_id, module_key)
  values ('55555555-5555-5555-5555-555555555555', 'finance') on conflict do nothing;
  insert into public.test_permissions (user_id, module_key, action_key) values
    ('55555555-5555-5555-5555-555555555555', 'finance', 'manage') on conflict do nothing;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by)
  values (current_date, 77.00, 'cash', 'Unseen', '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', auth.uid())
  returning id into v_id;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  select count(*) into v_seen from public.expenses where id = v_id;
  perform pg_temp.ok(v_seen = 0,
    'finance.manage alone grants NO sight of somebody else''s expense');
  update public.expenses set deleted_by = auth.uid(), updated_by = auth.uid() where id = v_id;
  perform pg_temp.ok(not found,
    'and so it cannot remove one either — you cannot act on a row you cannot see');
  reset role;
end $$;

-- ── 2h. A REMOVAL CANNOT NAME SOMEBODY ELSE ──
do $$
declare v_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  insert into public.expenses (expense_date, amount, payment_mode, paid_to, category_id, created_by)
  values (current_date, 55.00, 'cash', 'Forge Test', '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', auth.uid())
  returning id into v_id;

  begin
    update public.expenses
    set deleted_by = '22222222-2222-2222-2222-222222222222', updated_by = auth.uid()
    where id = v_id;
    raise exception 'FAILED: deleted_by was forged';
  exception when insufficient_privilege then
    raise notice 'ok: deleted_by cannot be forged';
  end;
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. DRAFTS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v_draft uuid; v_result jsonb; v_again jsonb; v_expenses_before int; v_expenses_after int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  -- ── 3a. AN INCOMPLETE CAPTURE IS SAVED ──
  insert into public.expense_drafts (raw_text, created_by)
  values ('750 for factory work', auth.uid())
  returning id into v_draft;
  perform pg_temp.ok(v_draft is not null,
    'a capture with no amount, no payee, no mode and no category is saved');
  perform pg_temp.ok(
    (select parsed_date = current_date and parsed_amount is null and parsed_paid_to is null
     from public.expense_drafts where id = v_draft),
    'and every field it did not have is NULL, with the date defaulted to today');

  -- ── 3b. AN EMPTY ONE IS NOT ──
  begin
    insert into public.expense_drafts (raw_text, created_by) values ('   ', auth.uid());
    raise exception 'FAILED: an empty capture was saved';
  exception when check_violation then
    raise notice 'ok: a capture with no text is refused';
  end;

  -- ── 3c. A DRAFT REACHES NO EXPENSE TOTAL ──
  perform pg_temp.ok(
    (select count(*) from public.expenses where paid_to = '750 for factory work') = 0,
    'a draft is not an expense and is nowhere near the expenses table');

  -- ── 3d. FINALIZING IT CREATES EXACTLY ONE EXPENSE ──
  select count(*) into v_expenses_before from public.expenses;
  v_result := public.finalize_expense_draft(
    v_draft, current_date, 750.00, 'cash', 'Factory Hand',
    '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', 'factory work');
  select count(*) into v_expenses_after from public.expenses;

  perform pg_temp.ok((v_result->>'created')::boolean, 'finalizing reports that it created one');
  perform pg_temp.ok(v_expenses_after = v_expenses_before + 1, 'and exactly one expense appeared');
  perform pg_temp.ok(
    (select status = 'finalized' and expense_id = (v_result->>'expense_id')::uuid
       and finalized_at is not null
     from public.expense_drafts where id = v_draft),
    'the draft is marked finalized and linked to it');

  -- ── 3e. A SECOND TAP CREATES NOTHING ──
  v_again := public.finalize_expense_draft(
    v_draft, current_date, 750.00, 'cash', 'Factory Hand',
    '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', 'factory work');
  perform pg_temp.ok(not (v_again->>'created')::boolean, 'a retry reports that it created nothing');
  perform pg_temp.ok(v_again->>'expense_id' = v_result->>'expense_id',
    'AND HANDS BACK THE FIRST CALL''S EXPENSE');
  perform pg_temp.ok((select count(*) from public.expenses) = v_expenses_after,
    'so one capture cannot become two expenses');

  -- ── 3f. THE FINALIZED EXPENSE NAMES ITS RECORDER, FROM auth.uid() ──
  perform pg_temp.ok(
    (select created_by = auth.uid() from public.expenses where id = (v_result->>'expense_id')::uuid),
    'the expense names the caller and could not name anybody else');

  reset role;
end $$;

-- ── 3g. A DISCARDED CAPTURE IS KEPT, WITH WHO AND WHEN ──
do $$
declare v_draft uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

  insert into public.expense_drafts (raw_text, created_by)
  values ('something not wanted', auth.uid()) returning id into v_draft;

  update public.expense_drafts
  set status = 'discarded', discarded_by = auth.uid(), discarded_at = now()
  where id = v_draft and status = 'pending';
  perform pg_temp.ok(found, 'a pending capture can be discarded');
  perform pg_temp.ok(
    (select status = 'discarded' and discarded_by = auth.uid() and discarded_at is not null
       and raw_text = 'something not wanted'
     from public.expense_drafts where id = v_draft),
    'AND THE ROW SURVIVES, with who discarded it and when');

  -- It cannot come back.
  begin
    update public.expense_drafts set status = 'pending', discarded_by = null, discarded_at = null
    where id = v_draft;
    raise exception 'FAILED: a discarded capture was resurrected';
  exception when insufficient_privilege then
    raise notice 'ok: a discarded capture cannot be resurrected';
  end;

  -- And it cannot be hard-deleted.
  begin
    delete from public.expense_drafts where id = v_draft;
    raise exception 'FAILED: a capture was hard-deleted';
  exception when insufficient_privilege then
    raise notice 'ok: DELETE on expense_drafts is refused for a client role';
  end;

  reset role;
end $$;

-- ── 3h. SOMEBODY WITHOUT FINANCE SEES AND DOES NOTHING ──
do $$
declare v_seen int; v_drafts int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

  select count(*) into v_seen from public.expenses;
  select count(*) into v_drafts from public.expense_drafts;
  perform pg_temp.ok(v_seen = 0, 'a person without Finance entry sees NO expense');
  perform pg_temp.ok(v_drafts = 0, 'and NO capture');

  begin
    insert into public.expense_drafts (raw_text, created_by) values ('sneaky', auth.uid());
    raise exception 'FAILED: somebody without Finance created a capture';
  exception when insufficient_privilege then
    raise notice 'ok: they cannot create one either';
  end;

  reset role;
end $$;

-- ── 3i. THE FINALIZE DOOR IS NOT AN EASIER DOOR ──
do $$
declare v_draft uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  insert into public.expense_drafts (raw_text, created_by)
  values ('someone else''s capture', auth.uid()) returning id into v_draft;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.finalize_expense_draft(
      v_draft, current_date, 10.00, 'cash', 'X',
      '8a0b094a-ddfd-4f97-a204-ac96c983e5b1', null);
    raise exception 'FAILED: somebody without Finance finalized a capture';
  exception when insufficient_privilege then
    raise notice 'ok: the finalize door refuses somebody without Finance';
  end;
  reset role;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. AND AFTER ALL OF THAT, THE PRODUCTION ROW IS STILL EXACTLY AS IT WAS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare v record;
begin
  select * into v from public.expenses where id = '5509dffb-df89-47f2-944b-1eeb432319f2';
  perform pg_temp.ok(
    v.amount = 1000.00 and v.paid_to = 'MCD' and v.remark = 'Sewage Cleaning'
    and v.payment_mode = 'cash' and v.expense_date = date '2026-09-20'
    and v.deleted_at is null and v.deleted_by is null and v.updated_by is null
    and v.created_at = '2026-09-20 08:24:19.818794+00'::timestamptz
    and v.updated_at = '2026-09-20 08:24:19.818794+00'::timestamptz,
    'THE PRODUCTION EXPENSE IS BYTE FOR BYTE WHAT IT WAS, after every test above');
end $$;

select 'expense lifecycle assertions: all passed' as result;

-- ════════════════════════════════════════════════════════════════════════════
-- RETURNING THE CONFIRMED ORDER NUMBER CYCLE TO 0001
--
-- WHAT THIS IS FOR
-- ----------------
-- Every Order Management record in the system today is TEST DATA, and real
-- confirmed Order numbering must begin at 0001 once it has been removed. The
-- removal itself already exists and is not touched here: begin_test_data_cleanup
-- → storage removal → finalize_test_data_cleanup (20260916000000), driven by
-- /api/orders/test-data-cleanup.
--
-- WHAT WAS ALREADY THERE, AND WHAT WAS NOT
-- ----------------------------------------
-- finalize_test_data_cleanup() already gives back the Order numbers a cleanup
-- freed, and does so narrowly and correctly: it walks the cycle down while the
-- number immediately below it is one this cleanup just deleted. An administrator
-- who deliberately set the cycle to 1000 has said something, and deleting a test
-- Order is not a reason to unsay it.
--
-- THAT NARROWNESS IS RIGHT, AND IT IS ALSO WHY IT CANNOT FINISH THE JOB. The
-- walk only reclaims from the TOP of the range, so the cycle lands on 1 only
-- when the Orders happen to be cleaned in descending order. Clean 0003, then
-- 0001, then 0002 and the cycle stops at 2 — the next real Order would be 0002,
-- and 0001 would never be used by anybody.
--
-- So the missing piece is not "reclaim harder". It is a SEPARATE, DELIBERATE,
-- AUDITED act: an administrator saying "the register is empty; start again at
-- one." This migration is that act, and the six conditions under which it is
-- allowed to happen.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
--   1. order_number_cycle_resets   a permanent audit of every reset
--   2. reset_confirmed_order_number_cycle(claim_token)
--                                  admin-only, claim-bound, six-gated
--   3. assertions
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- --------------------------------
--   * IT DELETES NOTHING. Not an Order, not a PI, not a payment, not a file. It
--     reads, it refuses, and on success it writes ONE integer and one audit row.
--     §3 asserts that no DELETE reaches it.
--   * It does not renumber anything. display_number is immutable and stays so;
--     there are no Orders left to renumber in any case, which is gate 2.
--   * It does not touch finalize_test_data_cleanup(), begin_test_data_cleanup(),
--     the chain resolver or the audit they write. The cleanup protocol is
--     unchanged.
--   * It does not relax set_next_confirmed_order_number()'s rules. That door
--     stays exactly as it is; this is a second, narrower one.
--   * It runs NOTHING on its own. Applying this migration does not reset
--     anything: the function exists and waits to be called.
--
-- Not one applied migration is edited. Timestamp is after 20260925000000.
-- ════════════════════════════════════════════════════════════════════════════


-- ═══ 1. The audit ═══════════════════════════════════════════════════════════
--
-- A SEPARATE TABLE from test_data_cleanup_audit, on purpose. That one records
-- what was DELETED, and its shape — root_type, root_id, deleted_records — has
-- nothing to say about a numbering decision. Folding a reset into it would mean
-- a row that answers none of its own columns.
--
-- It records the STATE THE DECISION WAS TAKEN AGAINST, not just the decision:
-- what the cycle was, what it became, and the evidence that every gate was
-- genuinely clear at that moment. A year from now the question will not be
-- "was it reset" but "was it safe to", and only the second is worth storing.

create table if not exists public.order_number_cycle_resets (
  id                 uuid        primary key default gen_random_uuid(),
  performed_by       uuid        references public.users(id) on delete set null,
  performed_by_email text,
  performed_at       timestamptz not null default now(),

  /** The cleanup claim this reset was authorized by. */
  claim_id           uuid        references public.test_data_cleanup_claims(id) on delete set null,

  previous_number    bigint      not null,
  new_number         bigint      not null,

  /** Every gate, and what it saw. Stored so the decision can be re-examined
   *  rather than merely re-asserted. */
  evidence           jsonb       not null default '{}'::jsonb,

  constraint order_number_cycle_resets_positive
    check (previous_number > 0 and new_number > 0)
);

comment on table public.order_number_cycle_resets is
  'Permanent record of every Confirmed Order number cycle reset. Written only by reset_confirmed_order_number_cycle(). Survives the test records whose removal justified it, and carries the evidence each gate saw.';

alter table public.order_number_cycle_resets enable row level security;

revoke all on table public.order_number_cycle_resets from public, anon, authenticated;

-- Admins may READ it; nobody may write it from a client. The insert happens
-- inside a SECURITY DEFINER function, which RLS does not constrain.
grant select on table public.order_number_cycle_resets to authenticated;

create policy "order_number_cycle_resets_admin_select"
  on public.order_number_cycle_resets
  for select to authenticated
  using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );


-- ═══ 2. The reset ═══════════════════════════════════════════════════════════
--
-- SIX GATES, IN THIS ORDER, AND EVERY ONE A REFUSAL.
--
--   0  an active, non-deleted ADMIN — the same authority the cleanup requires
--   1  a VALID, FINALIZED cleanup claim, named by its token. The token is the
--      link between "somebody deliberately cleaned the register" and "somebody
--      is now resetting the counter"; without it this would be a bare
--      "set the number to 1" with no occasion attached.
--      FINALIZED also proves the STORAGE CLEANUP COMPLETED — the protocol is
--      begin → remove storage → finalize, so finalized_at cannot be set until
--      the files are gone. That is gate 5, satisfied by the same check.
--   2  NO ORDER ROWS REMAIN. Not "no test Orders" — none at all. A cancelled
--      real Order is still a row, so once live use begins this gate closes
--      permanently and by itself, which is exactly what it is for.
--   3  NO PI APPROVAL COULD BE IN FLIGHT. A submission at 'submitted' can be
--      approved at any instant, and an approval allocates a number; one at
--      'approved' has already produced an Order. Either is a refusal.
--   4  NO PAYMENT ALLOCATION still points at an Order or a PI.
--   5  (see gate 1)
--
-- AND THE RACE IS CLOSED BY A LOCK, NOT BY A CHECK. Gates 2-4 are readings, and
-- a reading is stale the moment it is taken: an approval could commit between
-- the check and the write. So the cycle row is locked FOR UPDATE first, and
-- that is the same row allocate_confirmed_order_number() locks before it hands
-- out a number. An approval that starts during this transaction blocks on that
-- lock; one that had already started holds it, and this blocks instead. Either
-- way the two cannot interleave, and whichever runs second sees the other's
-- committed work and refuses.

create or replace function public.reset_confirmed_order_number_cycle(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_email      text;
  v_claim      public.test_data_cleanup_claims%rowtype;
  v_prev       bigint;
  v_orders     bigint;
  v_pending    bigint;
  v_allocs     bigint;
  v_reset_id   uuid;
  v_evidence   jsonb;
begin
  -- ── Gate 0: an active admin ──
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.users u
    where u.id = v_actor
      and u.role = 'admin'
      and u.is_active
      and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'ORDER_NUMBER_RESET_FORBIDDEN: Only an active admin may reset the Confirmed Order number cycle'
      using errcode = '42501';
  end if;

  -- Recorded on the audit row. Read separately from the gate above, because an
  -- admin whose email is null is still an admin.
  select u.email into v_email from public.users u where u.id = v_actor;

  -- ── THE LOCK, BEFORE ANY GATE IS READ ──
  --
  -- The same row allocate_confirmed_order_number() takes FOR UPDATE before it
  -- hands out a number. Holding it here is what makes the four readings below
  -- true at the moment of the write rather than merely true when they were
  -- taken.
  select c.next_number into v_prev
  from public.order_number_cycle c
  where c.id = true
  for update;

  if not found then
    raise exception 'ORDER_NUMBER_CYCLE_MISSING: Confirmed Order numbering is not configured'
      using errcode = 'P0001';
  end if;

  -- ── Gate 1: a valid, finalized cleanup claim ── (and, with it, gate 5)
  if p_claim_token is null then
    raise exception 'ORDER_NUMBER_RESET_NO_CLAIM: a finalized Test Data Cleanup claim is required'
      using errcode = '42501';
  end if;

  select * into v_claim
  from public.test_data_cleanup_claims
  where claim_token = p_claim_token;

  if not found then
    raise exception 'ORDER_NUMBER_RESET_CLAIM_INVALID: that cleanup claim is not valid'
      using errcode = '42501';
  end if;

  if v_claim.finalized_at is null then
    raise exception 'ORDER_NUMBER_RESET_CLAIM_UNFINISHED: that cleanup has not been finalized, so its storage removal is not proven complete'
      using errcode = '42501';
  end if;

  -- ── Gate 2: not one Order row remains ──
  --
  -- Deliberately `public.orders` entire, with no is_test_data filter. A
  -- cancelled real Order is a row like any other, and once one exists this gate
  -- closes permanently — which is the point. The register is either empty or it
  -- is not.
  select count(*) into v_orders from public.orders;
  if v_orders <> 0 then
    raise exception
      'ORDER_NUMBER_RESET_ORDERS_EXIST: % Order(s) still exist; the cycle may only restart against an empty register',
      v_orders
      using errcode = '42501';
  end if;

  -- ── Gate 3: no PI approval could be in flight ──
  select count(*) into v_pending
  from public.order_submissions s
  where s.status in ('submitted', 'approved')
     or s.order_id is not null;

  if v_pending <> 0 then
    raise exception
      'ORDER_NUMBER_RESET_APPROVAL_PENDING: % PI submission(s) are submitted or approved; an approval allocates a number and must not race this reset',
      v_pending
      using errcode = '42501';
  end if;

  -- ── Gate 4: no payment allocation still points at an Order or a PI ──
  select count(*) into v_allocs
  from public.finance_payment_allocations a
  where a.order_id is not null or a.order_submission_id is not null;

  if v_allocs <> 0 then
    raise exception
      'ORDER_NUMBER_RESET_ALLOCATIONS_REMAIN: % payment allocation(s) still point at an Order or a PI',
      v_allocs
      using errcode = '42501';
  end if;

  -- ── Already at 1: answer, do not act ──
  --
  -- IDEMPOTENT, and audited as such. A second call after a successful one is a
  -- person checking, not a person deciding, and it must not write a second
  -- decision — but it must also not report a failure for a state that is
  -- exactly what was asked for.
  if v_prev = 1 then
    return jsonb_build_object(
      'reset', false, 'already_at_start', true,
      'next_number', 1, 'next_display_number', public.format_confirmed_order_number(1));
  end if;

  v_evidence := jsonb_build_object(
    'claim_token_matched',   true,
    'claim_finalized_at',    v_claim.finalized_at,
    'claim_root_type',       v_claim.root_type,
    'orders_remaining',      v_orders,
    'submissions_in_flight', v_pending,
    'allocations_remaining', v_allocs,
    'storage_prefix',        v_claim.storage_prefix);

  update public.order_number_cycle
     set next_number   = 1,
         configured_at = now(),
         configured_by = v_actor
   where id = true;

  insert into public.order_number_cycle_resets (
    performed_by, performed_by_email, claim_id,
    previous_number, new_number, evidence
  ) values (
    v_actor, v_email, v_claim.id, v_prev, 1, v_evidence
  ) returning id into v_reset_id;

  return jsonb_build_object(
    'reset',               true,
    'already_at_start',    false,
    'reset_id',            v_reset_id,
    'previous_number',     v_prev,
    'next_number',         1,
    'next_display_number', public.format_confirmed_order_number(1),
    'evidence',            v_evidence);
end;
$$;

comment on function public.reset_confirmed_order_number_cycle(uuid) is
  'Admin-only. Returns the Confirmed Order number cycle to 1 so the next real Order is 0001. Requires a FINALIZED Test Data Cleanup claim (which proves storage removal completed), an entirely empty public.orders, no submitted or approved PI, and no payment allocation still pointing at an Order or a PI. Locks the cycle row first, so a concurrent approval cannot race it. Deletes nothing. Idempotent, and permanently audited in order_number_cycle_resets.';

revoke execute on function public.reset_confirmed_order_number_cycle(uuid) from public, anon;
grant  execute on function public.reset_confirmed_order_number_cycle(uuid) to authenticated;


-- ═══ 2b. Letting Test Data Cleanup remove an Order that has documents ═══════
--
-- A DEFECT THIS PHASE INTRODUCED, CLOSED IN THE SAME BRANCH.
--
-- 20260925000000 gave public.order_document_versions a foreign key to
-- public.orders with NO ON DELETE clause — deliberately, because the one path
-- that can remove an Order is the audited Test Data Cleanup and a silent cascade
-- would hide what that cleanup destroyed.
--
-- But finalize_test_data_cleanup() ends with `delete from public.orders`, and it
-- knows nothing about a table that did not exist when it was written. An Order
-- whose documents had been generated could therefore never be cleaned up: the
-- delete would fail on the foreign key, after the files were already gone. That
-- is precisely the "storage removed, rows not" corruption the claim protocol
-- exists to prevent.
--
-- WHY A TRIGGER AND NOT A RE-EMIT. finalize_test_data_cleanup() is a 240-line
-- SECURITY DEFINER function that deletes payments, requests, PIs and Orders in a
-- lock order that took a migration of its own to get right. Re-emitting it to
-- add one DELETE would put all of that at risk for a line that belongs to this
-- phase's table anyway. The trigger sits with the table it protects, fires
-- wherever an Order is deleted from, and cannot be forgotten by a future
-- cleanup path.
--
-- IT IS NOT A BACK DOOR. orders_prevent_delete (20260705000000) already refuses
-- every DELETE on public.orders except an authorized cleanup finalization, for
-- the service role included. This trigger therefore only ever runs inside one,
-- and it destroys nothing an Order does not solely own.
--
-- THE FILES ARE NOT ITS BUSINESS. Storage and Postgres share no transaction, so
-- the objects are removed by the route BEFORE finalization, exactly as the PI's
-- files are — see removeAllObjectsForOrder in
-- src/lib/orders/submissionFilesServer.ts. This removes the rows that name them.

create or replace function public.orders_remove_document_versions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.order_document_versions where order_id = old.id;
  return old;
end;
$$;

drop trigger if exists orders_remove_document_versions_trg on public.orders;
create trigger orders_remove_document_versions_trg
  before delete on public.orders
  for each row execute function public.orders_remove_document_versions();

comment on function public.orders_remove_document_versions() is
  'Removes an Order''s document register rows immediately before the Order itself is deleted, so an audited Test Data Cleanup is not blocked by the no-cascade foreign key 20260925000000 chose deliberately. Reachable only through a cleanup finalization, because orders_prevent_delete refuses every other DELETE.';

revoke execute on function public.orders_remove_document_versions()
  from public, anon, authenticated, service_role;


-- ═══ 2c. The document keys a cleanup must sweep ═════════════════════════════
--
-- The route removes storage BEFORE it finalizes, and it must be told what to
-- remove from the database rather than deriving it — a browser-supplied prefix
-- is exactly what this whole protocol refuses.
--
-- SELECT-ONLY AND ORDER-SCOPED. It returns the keys a ready version names, for
-- one Order, to an admin. It deletes nothing and it authorizes nothing.

create or replace function public.order_document_storage_paths(p_order_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(path order by path), '{}'::text[])
  from (
    select d.excel_path as path from public.order_document_versions d
     where d.order_id = p_order_id and d.excel_path is not null
    union
    select d.pdf_path from public.order_document_versions d
     where d.order_id = p_order_id and d.pdf_path is not null
  ) keys;
$$;

comment on function public.order_document_storage_paths(uuid) is
  'Every generated-document key one Order''s register names, for the Test Data Cleanup route to remove before finalization. Read-only. An attempt''s unpublished output is not named here and is swept by prefix instead.';

revoke execute on function public.order_document_storage_paths(uuid) from public, anon;
grant  execute on function public.order_document_storage_paths(uuid) to authenticated;


-- ═══ 3. Assertions ══════════════════════════════════════════════════════════

do $$
declare
  v_def     text;
  v_targets text;
  v_name    text;
begin
  -- 3a. It exists, is a definer, and is reachable only by a signed-in caller.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reset_confirmed_order_number_cycle' and p.prosecdef
  ) then
    raise exception 'reset_confirmed_order_number_cycle must exist and must be SECURITY DEFINER';
  end if;

  if has_function_privilege('anon',
       'public.reset_confirmed_order_number_cycle(uuid)', 'execute') then
    raise exception 'anon may reset the Order number cycle';
  end if;

  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reset_confirmed_order_number_cycle';

  -- 3b. IT DELETES NOTHING. The whole point of separating this from the cleanup
  -- is that the destructive half already happened; this must not be a second
  -- door to it.
  if v_def ~* '\mdelete\s+from\m' or v_def ~* '\mtruncate\m' then
    raise exception 'the cycle reset contains a DELETE; it must destroy nothing';
  end if;

  -- 3c. It writes exactly two things: the cycle, and its own audit.
  -- Every write target is extracted and compared by name — PostgreSQL's regex
  -- has no negative lookahead, and "matches nothing unexpected" is in any case
  -- weaker than "matches exactly these".
  select string_agg(distinct m[1], ', ' order by m[1]) into v_targets
  from regexp_matches(v_def, 'update\s+public\.(\w+)', 'gi') m;
  if v_targets is distinct from 'order_number_cycle' then
    raise exception 'the cycle reset updates something other than the cycle: %', coalesce(v_targets, '(none)');
  end if;

  select string_agg(distinct m[1], ', ' order by m[1]) into v_targets
  from regexp_matches(v_def, 'insert\s+into\s+public\.(\w+)', 'gi') m;
  if v_targets is distinct from 'order_number_cycle_resets' then
    raise exception 'the cycle reset inserts into something other than its own audit: %', coalesce(v_targets, '(none)');
  end if;

  -- 3d. Every gate is present. Named individually, so removing one is a failed
  -- apply rather than a quietly wider door.
  if position('for update' in lower(v_def)) = 0 then
    raise exception 'the cycle reset does not lock the cycle row; a concurrent approval could race it';
  end if;
  if position('ORDER_NUMBER_RESET_CLAIM_UNFINISHED' in v_def) = 0
     or position('ORDER_NUMBER_RESET_ORDERS_EXIST' in v_def) = 0
     or position('ORDER_NUMBER_RESET_APPROVAL_PENDING' in v_def) = 0
     or position('ORDER_NUMBER_RESET_ALLOCATIONS_REMAIN' in v_def) = 0
     or position('ORDER_NUMBER_RESET_FORBIDDEN' in v_def) = 0 then
    raise exception 'the cycle reset is missing one of its gates';
  end if;

  -- 3e. The lock is taken BEFORE the gates are read, or the readings are stale.
  if position('for update' in lower(v_def))
     > position('order_number_reset_orders_exist' in lower(v_def)) then
    raise exception 'the cycle reset reads its gates before taking the lock';
  end if;

  -- 3f. The cleanup protocol is untouched.
  foreach v_name in array array[
    'begin_test_data_cleanup', 'finalize_test_data_cleanup',
    'release_test_data_cleanup', 'resolve_test_data_cleanup_chain',
    'allocate_confirmed_order_number', 'set_next_confirmed_order_number',
    'approve_order_submission'
  ] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    ) then
      raise exception '% is missing; this migration must not have removed it', v_name;
    end if;
  end loop;

  -- 3g. The audit is admin-read, client-unwritable.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'order_number_cycle_resets'
      and grantee in ('anon', 'authenticated', 'public')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) then
    raise exception 'a client role may write the cycle reset audit';
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'order_number_cycle_resets' and c.relrowsecurity
  ) then
    raise exception 'order_number_cycle_resets has RLS disabled';
  end if;

  -- 3h. Nothing was reset by applying this migration.
  if exists (select 1 from public.order_number_cycle_resets) then
    raise exception 'applying this migration wrote a reset; it must reset nothing';
  end if;

  -- 3i. The cleanup can now delete an Order that has documents.
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'orders'
      and t.tgname = 'orders_remove_document_versions_trg'
      and not t.tgisinternal
  ) then
    raise exception 'the document rows would block a Test Data Cleanup of an Order that has documents';
  end if;

  -- And that trigger destroys nothing else.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'orders_remove_document_versions';

  select string_agg(distinct m[1], ', ' order by m[1]) into v_targets
  from regexp_matches(v_def, 'delete\s+from\s+public\.(\w+)', 'gi') m;
  if v_targets is distinct from 'order_document_versions' then
    raise exception 'the document cleanup trigger deletes something else: %', coalesce(v_targets, '(none)');
  end if;

  -- 3j. The key lister reads and does nothing else.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'order_document_storage_paths';

  if v_def ~* '\m(insert|update|delete|truncate)\M' then
    raise exception 'order_document_storage_paths writes something; it must only read';
  end if;

  if public.order_document_storage_paths(gen_random_uuid()) <> '{}'::text[] then
    raise exception 'order_document_storage_paths does not return an empty array for an unknown Order';
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20270117000000 — the Order and Finance write guards run as their owner
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ALTER FUNCTION STATEMENTS ONLY, and they give a signed-in person back the
-- right to write to their own Order and Finance rows.
--
-- ── WHAT IS BROKEN IN PRODUCTION ───────────────────────────────────────────
--
-- 20260705000000 revoked EXECUTE on public.in_test_data_cleanup() from
-- `authenticated`, and its siblings are internal too. That was right. But
-- eleven trigger functions call one of them — nine as their FIRST statement —
-- and none of them is SECURITY DEFINER. A trigger function runs as the role
-- that fired it, so when a signed-in client writes the table directly, the
-- trigger calls a function that role may not execute and the write fails with
--
--     permission denied for function in_test_data_cleanup
--
-- before the guard has decided anything. Read from production on 2026-09-25
-- (SELECT-only): has_function_privilege('authenticated',
-- 'public.in_test_data_cleanup()', 'execute') = false, and the schema-wide
-- query in the last assertion below returns exactly the eleven functions
-- named here, every one with prosecdef = false.
--
-- What that breaks today, by the client's own direct writes:
--
--   order_finance_reset_write_guard (20261010000000), on all sixteen tables
--   in its lock list, INSERT/UPDATE/DELETE:
--     * Sales cannot file an Order change request
--       (OrderAmendmentModals.tsx inserts into order_change_requests)
--     * the Order status change and its activity row (orders/[id]/page.tsx
--       updates orders, then inserts into order_activity_log)
--     * Finance's direct payment edit / correction / proof upload
--       (finance_payment_requests, payment_proof_attachments)
--     It ALSO calls open_order_finance_reset_scope(), which is revoked from
--     every client role too.
--
--   Three more on public.orders UPDATE, so fixing the reset guard ALONE would
--   leave the Order status change failing with the very same message:
--     orders_guard_cleanup_claim                (20260916000000)
--     prevent_order_source_request_change       (20260701000000, 20260706000000)
--     prevent_order_source_submission_change    (20260915000000, 20260916000000)
--
--   And five more, each reached the same way:
--     order_submissions_guard_cleanup_claim     order_submissions UPDATE
--                                               (20260916000000)
--     finance_payment_allocations_guard_pi_deletion
--                                               finance_payment_allocations INSERT
--                                               (20261010000000)
--     order_submission_corrections_guard_deletion
--                                               order_submission_correction_requests INSERT
--                                               (20261010000000)
--     order_submissions_guard_delete            order_submissions DELETE
--                                               (20260914000000, 20260916000000)
--     order_submission_activity_guard_delete    order_submission_activity DELETE
--                                               (20260914000000, 20260916000000)
--   (The two DELETE guards refuse a client anyway; today they refuse it with
--   "permission denied for function order_submission_purge_in_progress"
--   instead of their own message. They are included so that EVERY guard of
--   this shape is fixed at once and the assertion below can say so.)
--
--   And two from 20260914000000 that call order_submission_purge_in_progress()
--   — revoked from clients as well:
--     order_submission_child_guard_deletion_claim
--                                               order_submission_items and
--                                               order_submission_item_images,
--                                               INSERT/UPDATE/DELETE, FIRST
--     order_submissions_guard_deletion_claim    order_submissions UPDATE, only
--                                               once a PI is claimed for deletion
--
--   Three more exist only once 20270116000000 (#209) is applied —
--   order_advance_exceptions_immutable, order_advance_holds_guard and
--   order_reserved_number_ledger_guard. They reach in_test_data_cleanup() only
--   on DELETE, which they refuse anyway, so today they cost a client nothing
--   but the wrong message. They are altered IF PRESENT (§1b), so this file
--   does not depend on #209's merge order and the final assertion holds either
--   way.
--
-- ── THE FIX, AND WHY THIS ONE ──────────────────────────────────────────────
--
-- Run each guard as its owner: SECURITY DEFINER with search_path pinned to
-- `public, pg_temp` — exactly what the guards' sibling helpers
-- (open_order_finance_reset_scope, test_data_cleanup_claim_open) and the
-- 20261010000000 reset RPCs already declare.
--
-- NOT granting the helpers to `authenticated`. They stay internal; a client
-- has no business asking whether a cleanup or a reset is in flight. A trigger
-- function cannot be called directly, so making it a definer hands a client
-- nothing it could not already do by writing the table.
--
-- DECIDING NOTHING DIFFERENTLY. Every helper these bodies call reads either a
-- transaction-local GUC (boe.cleanup_context, boe.order_submission_purge_id)
-- or public.test_data_cleanup_claims through a definer of its own. None of
-- them reads current_user, auth.uid() or a JWT claim, so running the guard as
-- its owner changes who is PERMITTED to call them and nothing about what they
-- answer. The guards' own `exists (select … from public.order_submissions)`
-- probes now see every row rather than the RLS-visible ones — which is what a
-- deletion-claim check must do: a claim on a PI the writer cannot see is still
-- a claim.
--
-- ── AND ONE SEARCH_PATH THAT LOST pg_temp (§3) ─────────────────────────────
--
-- public.assert_order_amender() is the SECURITY DEFINER choke point that
-- amend_order, cancel_order, approve_order_change_request and
-- reject_order_change_request call to authorize an amendment.
-- 20260818000000 pinned it to `search_path = public, pg_temp`. Then
-- 20260901000000 restated it with CREATE OR REPLACE … `set search_path =
-- public`, which replaced the setting and dropped pg_temp. Production reads
-- search_path=public today (2026-09-25, SELECT-only), and it is the only
-- amendment function in that state (#209 review, H5).
--
-- Why it matters: with pg_temp absent from an explicit search_path, Postgres
-- searches pg_temp FIRST. A caller who creates a temporary table named
-- `users` would have it resolve ahead of public.users inside the admin check
-- of a definer that runs as postgres. PostgREST sessions cannot run DDL, so
-- the app is not exposed today, but the pairing exists to rule this out by
-- construction, and the ten other amendment functions all have it.
--
-- NOT A SCHEMA-WIDE SWEEP. Production has 94 other SECURITY DEFINER functions
-- in public whose search_path lacks pg_temp. They are outside this file:
-- each needs its own read, and this file changes only functions it names.
--
-- The fix is the same ALTER FUNCTION … SET search_path shape: the body is not
-- touched, it stays a definer, and it KEEPS its EXECUTE grant to
-- `authenticated`, because the RPCs above need it and a client calling it
-- directly learns only whether they may amend.
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- The function BODIES are not redefined — this file contains no CREATE
-- FUNCTION, so the bytes production is running are the bytes it keeps
-- running. ALTER FUNCTION changes only the security mode and the search_path.
-- No trigger, table, policy, grant on a table or row is altered, and there is
-- NO DML. The helpers' own privileges are asserted unchanged below.
--
-- ORDERING. Numbered after the five migrations of #202 / #205 / #206 / #209
-- (20270112000000 … 20270116000000) that are not yet applied, so it lands
-- after them whichever merges first. It depends on none of them; it needs only
-- 20261010000000. It is an ALTER, so a LATER migration that redefines one of
-- these functions with CREATE OR REPLACE and no SECURITY DEFINER silently
-- undoes it; any such migration must restate `security definer set
-- search_path = public, pg_temp`. (None of the five does, read 2026-09-25.)
--
-- DEPENDENCIES (hard): 20260705000000, 20260706000000, 20260816000000,
-- 20260901000000, 20260914000000, 20260915000000, 20260916000000,
-- 20261010000000.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.in_test_data_cleanup()',
    'public.open_order_finance_reset_scope()',
    'public.order_submission_purge_in_progress(uuid)',
    'public.test_data_cleanup_claim_open(uuid, uuid)',
    'public.order_finance_reset_write_guard()',
    'public.orders_guard_cleanup_claim()',
    'public.order_submissions_guard_cleanup_claim()',
    'public.prevent_order_source_request_change()',
    'public.prevent_order_source_submission_change()',
    'public.finance_payment_allocations_guard_pi_deletion()',
    'public.order_submission_corrections_guard_deletion()',
    'public.order_submissions_guard_delete()',
    'public.order_submission_activity_guard_delete()',
    'public.order_submission_child_guard_deletion_claim()',
    'public.order_submissions_guard_deletion_claim()',
    'public.assert_order_amender()'
  ] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'DEPENDENCY MISSING: % does not exist', v_fn;
    end if;
  end loop;
end $$;


-- ═══ 1. The eleven guards run as their owner ════════════════════════════════

alter function public.order_finance_reset_write_guard()
  security definer set search_path = public, pg_temp;

alter function public.orders_guard_cleanup_claim()
  security definer set search_path = public, pg_temp;
alter function public.order_submissions_guard_cleanup_claim()
  security definer set search_path = public, pg_temp;

alter function public.prevent_order_source_request_change()
  security definer set search_path = public, pg_temp;
alter function public.prevent_order_source_submission_change()
  security definer set search_path = public, pg_temp;

alter function public.finance_payment_allocations_guard_pi_deletion()
  security definer set search_path = public, pg_temp;
alter function public.order_submission_corrections_guard_deletion()
  security definer set search_path = public, pg_temp;

alter function public.order_submissions_guard_delete()
  security definer set search_path = public, pg_temp;
alter function public.order_submission_activity_guard_delete()
  security definer set search_path = public, pg_temp;

alter function public.order_submission_child_guard_deletion_claim()
  security definer set search_path = public, pg_temp;
alter function public.order_submissions_guard_deletion_claim()
  security definer set search_path = public, pg_temp;

-- ── 1b. The three from 20270116000000, if it is applied ────────────────────
--
-- Named, not discovered: each body was read before it was listed here, and a
-- sweep that altered whatever matched would change functions nobody reviewed.

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.order_advance_exceptions_immutable()',
    'public.order_advance_holds_guard()',
    'public.order_reserved_number_ledger_guard()'
  ] loop
    if to_regprocedure(v_fn) is not null then
      execute format('alter function %s security definer set search_path = public, pg_temp', v_fn);
      execute format('revoke execute on function %s from public, anon, authenticated, service_role', v_fn);
    end if;
  end loop;
end $$;


-- ═══ 2. And nobody may call them ════════════════════════════════════════════
--
-- Each was already revoked from these roles where it was created; restated
-- here because a definer is the kind of function whose EXECUTE grant matters,
-- and the assertion below should not depend on a file two hundred migrations
-- back.

revoke execute on function public.order_finance_reset_write_guard()
  from public, anon, authenticated, service_role;
revoke execute on function public.orders_guard_cleanup_claim()
  from public, anon, authenticated, service_role;
revoke execute on function public.order_submissions_guard_cleanup_claim()
  from public, anon, authenticated, service_role;
revoke execute on function public.prevent_order_source_request_change()
  from public, anon, authenticated, service_role;
revoke execute on function public.prevent_order_source_submission_change()
  from public, anon, authenticated, service_role;
revoke execute on function public.finance_payment_allocations_guard_pi_deletion()
  from public, anon, authenticated, service_role;
revoke execute on function public.order_submission_corrections_guard_deletion()
  from public, anon, authenticated, service_role;
revoke execute on function public.order_submissions_guard_delete()
  from public, anon, authenticated, service_role;
revoke execute on function public.order_submission_activity_guard_delete()
  from public, anon, authenticated, service_role;
revoke execute on function public.order_submission_child_guard_deletion_claim()
  from public, anon, authenticated, service_role;
revoke execute on function public.order_submissions_guard_deletion_claim()
  from public, anon, authenticated, service_role;


-- ═══ 3. assert_order_amender gets pg_temp back ══════════════════════════════
--
-- Its grants are deliberately NOT restated. It keeps exactly the EXECUTE it
-- has, and the assertion below says so.

alter function public.assert_order_amender()
  set search_path = public, pg_temp;


-- ─── Assertions ─────────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a partially applied state
-- look successful.

do $$
declare
  v_fn   text;
  v_oid  oid;
  v_role text;
  v_bad  text;
begin
  foreach v_fn in array array[
    'public.order_finance_reset_write_guard()',
    'public.orders_guard_cleanup_claim()',
    'public.order_submissions_guard_cleanup_claim()',
    'public.prevent_order_source_request_change()',
    'public.prevent_order_source_submission_change()',
    'public.finance_payment_allocations_guard_pi_deletion()',
    'public.order_submission_corrections_guard_deletion()',
    'public.order_submissions_guard_delete()',
    'public.order_submission_activity_guard_delete()',
    'public.order_submission_child_guard_deletion_claim()',
    'public.order_submissions_guard_deletion_claim()',
    'public.order_advance_exceptions_immutable()',
    'public.order_advance_holds_guard()',
    'public.order_reserved_number_ledger_guard()'
  ] loop
    v_oid := to_regprocedure(v_fn)::oid;
    continue when v_oid is null;  -- only the three 20270104 guards may be absent

    if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
      raise exception 'guard definer: % is still SECURITY INVOKER', v_fn;
    end if;
    if (select p.proconfig from pg_proc p where p.oid = v_oid)
       is distinct from array['search_path=public, pg_temp'] then
      raise exception 'guard definer: % must set exactly search_path = public, pg_temp, has %',
        v_fn, (select p.proconfig from pg_proc p where p.oid = v_oid);
    end if;

    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception 'guard definer: % is executable by %', v_fn, v_role;
      end if;
    end loop;

    -- AND THE BODY IS UNCHANGED: still the guard that stands down only for
    -- the authorized cleanup or purge. If a later edit to this file adds a
    -- CREATE FUNCTION, this stops being a statement about production's bytes.
    if not exists (
      select 1 from pg_proc p
       where p.oid = v_oid
         and (p.prosrc like '%public.in_test_data_cleanup()%'
              or p.prosrc like '%public.order_submission_purge_in_progress(%')
    ) then
      raise exception 'guard definer: % no longer has the body this migration was written against', v_fn;
    end if;
  end loop;

  -- THE HELPERS STAY INTERNAL. The fix is the guard's identity, not the
  -- helper's audience.
  foreach v_fn in array array[
    'public.in_test_data_cleanup()',
    'public.open_order_finance_reset_scope()',
    'public.order_submission_purge_in_progress(uuid)'
  ] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, to_regprocedure(v_fn)::oid, 'EXECUTE') then
        raise exception 'guard definer: internal helper % became executable by %', v_fn, v_role;
      end if;
    end loop;
  end loop;

  -- AND NO GUARD OF THIS SHAPE IS LEFT. Any trigger function in public that
  -- runs as its caller and calls a helper no client may execute will refuse
  -- that client's write with "permission denied" — the defect this file
  -- exists to remove. Checked across the whole schema, so a guard added by a
  -- migration this file does not know about is caught here, not in production.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname)
    into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prorettype = 'trigger'::regtype
     and not p.prosecdef
     and exists (select 1 from pg_trigger t where t.tgfoid = p.oid and not t.tgisinternal)
     and exists (
       select 1 from pg_proc h
        where h.pronamespace = 'public'::regnamespace
          and h.proname in ('in_test_data_cleanup', 'open_order_finance_reset_scope',
                            'order_submission_purge_in_progress', 'test_data_cleanup_claim_open')
          and not has_function_privilege('authenticated', h.oid, 'EXECUTE')
          and p.prosrc like '%public.' || h.proname || '(%'
     );
  if v_bad is not null then
    raise exception 'guard definer: trigger functions still run as the caller and call an internal helper: %', v_bad;
  end if;
end $$;

do $$
declare
  v_oid oid := 'public.assert_order_amender()'::regprocedure::oid;
begin
  if (select p.proconfig from pg_proc p where p.oid = v_oid)
     is distinct from array['search_path=public, pg_temp'] then
    raise exception 'assert_order_amender: must set exactly search_path = public, pg_temp, has %',
      (select p.proconfig from pg_proc p where p.oid = v_oid);
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = v_oid) then
    raise exception 'assert_order_amender: is no longer SECURITY DEFINER';
  end if;

  -- IT KEEPS ITS DOOR. amend_order, cancel_order and the change-request
  -- decisions call it as the signed-in user's own authorization check.
  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'assert_order_amender: authenticated LOST execute; amending an Order would be refused to everyone';
  end if;
  if has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception 'assert_order_amender: anon can execute it';
  end if;

  -- AND THE BODY IS THE ONE 20260901000000 WROTE: the admin-or-orders.manage
  -- rule, unchanged.
  if not exists (
    select 1 from pg_proc p
     where p.oid = v_oid
       and p.prosrc like '%ORDER_AMENDMENT_FORBIDDEN%'
       and p.prosrc like '%public.actor_has_permission(''orders'', ''manage'')%'
  ) then
    raise exception 'assert_order_amender: no longer has the body this migration was written against';
  end if;
end $$;

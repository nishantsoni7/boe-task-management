-- ═════════════════════════════════════════════════════════════════════════════
-- Two financial-data exposures, closed
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Both were found by the pre-application security review of 20261005000000.
-- Neither is introduced by that migration; both are live in the applied schema.
-- Neither applied file is edited — this is a forward-only correction that
-- replaces three functions by `create or replace` at their existing signatures,
-- so every policy, grant and caller keeps working untouched.
--
--
-- EXPOSURE 1 — can_read_payment_as_participant() (20260919000000 §2)
-- -----------------------------------------------------------------
-- The function is SECURITY DEFINER, and its Order branch reads:
--
--     (a.order_id is not null
--      and exists (select 1 from public.orders o where o.id = a.order_id))
--
-- with a comment saying "public.orders' own RLS decides this". It does not.
-- Inside a SECURITY DEFINER function current_user is the OWNER, so RLS on
-- public.orders is evaluated for the owner — which owns the table and is
-- therefore exempt from it. The branch means `the Order exists`, and it is true
-- for every caller.
--
-- That predicate is the USING clause of finance_payment_requests_participant_select
-- and one branch of the restrictive finance_payment_requests_module_entry_gate,
-- so in the applied schema any authenticated user can read any payment ledger
-- row — amount, status, submitter, dates — that carries an allocation to any
-- existing Order. The same two policies exist on payment_proof_attachments.
--
-- The nesting is not an accident that a helper can fix: a SECURITY INVOKER
-- function called from inside a definer also runs as the definer, so
-- can_view_order() — invoker precisely so that it ASKS the orders policies
-- rather than restating them (20260924000000 §1) — degenerates to the same
-- `the Order exists` when called from here. Verified by execution; see
-- supabase/tests/payment_participant_security.sql.
--
-- WHY THE FUNCTION CANNOT SIMPLY BECOME AN INVOKER. It reads
-- finance_payment_allocations, whose finance_payment_allocations_payment_owner_select
-- policy reads finance_payment_requests, whose policies call this function.
-- As an invoker that is a policy cycle and PostgreSQL refuses it outright
-- ("infinite recursion detected in policy for relation ..."). The definer is
-- what breaks the cycle, and it has to stay.
--
-- SO THE ORDER BRANCH IS MADE DEFINER-SAFE INSTEAD, by asking a predicate that
-- means the same thing in every security context: §1 below.
--
--
-- EXPOSURE 2 — order_linked_payment_total(uuid) (20260816000000 §5)
-- -----------------------------------------------------------------
-- SECURITY DEFINER, granted to `authenticated`, and gated on nothing at all. Any
-- signed-in user could ask what any Order UUID has received. The UI only ever
-- calls it for an Order already on screen; the RPC is reachable directly.
--
-- Gated in §3, with the SAME predicate §1 introduces, so "may this person see
-- this Order" has one answer in both fixes.
--
--
-- WHAT IS NOT CHANGED
-- -------------------
-- No policy is created, dropped or altered. No table grant moves. No RLS is
-- weakened, and nothing is granted broader table access — both fixes NARROW.
-- The canonical attribution rule is preserved exactly: active allocations are
-- authoritative, the direct linkage is a fallback only when none exist.
--
-- FORWARD-ONLY. Edits no applied file.

begin;

-- ═══ 1. "May this person see this Order?", answerable inside a definer ══════
--
-- THE PROBLEM THIS SOLVES. public.can_view_order() answers this correctly and
-- must keep being the answer wherever it works — it is SECURITY INVOKER, so it
-- ASKS the orders policies and can never drift from them. But it only works when
-- the whole call chain is invoker. Called from inside any SECURITY DEFINER it
-- silently becomes `the Order exists`, which is exposure 1.
--
-- So this is its DEFINER-SAFE SIBLING, for the two callers below that have no
-- choice but to be definers. It is deliberately NOT a replacement:
-- can_view_order() stays the right tool for policies and invoker functions, and
-- this one carries the cost of being a restatement.
--
-- IT IS A RESTATEMENT, AND THAT IS THE PART TO WATCH. Every branch below is one
-- permissive SELECT policy on public.orders, expressed in terms of auth.uid()
-- rather than of RLS:
--
--   orders_admin_select              users.role = 'admin'
--   orders_operations_select         users.team = 'operations'
--   orders_sales_select              requested_by / assigned_to = auth.uid()
--   orders_permission_engine_select  resolve_permission(uid,'orders','view_all')
--
-- ANDed with module_entry_open('orders'), which is the RESTRICTIVE
-- orders_module_entry_gate (20260905000000 §2). A restatement can drift from
-- what it restates, so §4 asserts AT APPLY TIME that the set of permissive
-- SELECT policies on public.orders is exactly those four. A fifth one added
-- later fails this migration's assertion in CI and fails the repository test
-- that mirrors it — the drift is loud instead of silent.
--
-- WHY auth.uid() IS THE RIGHT IDENTITY. It reads the request's JWT claim, not
-- current_user, so it means the same thing at any nesting depth. That is exactly
-- the property the bare EXISTS lacked, and it is what lets §3 keep working when
-- cancel_order_with_audit() calls it from inside its own definer.
--
-- READING public.orders HERE BYPASSES ITS RLS, deliberately: the predicate above
-- IS that RLS, and `o.id = p_order_id` pins the read to the single row being
-- asked about. An Order that does not exist yields no row and therefore false,
-- which is the same answer an Order the caller may not see gets. Fail-closed on
-- null, like can_view_order().

create or replace function public.can_view_order_as_actor(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.orders o
     where o.id = p_order_id
       -- The RESTRICTIVE module gate, first, exactly as a restrictive policy
       -- applies: no ownership or view_all branch is reached without it.
       and public.module_entry_open('orders')
       and (
         exists (
           select 1 from public.users u
           where u.id = auth.uid() and u.role = 'admin'
         )
         or exists (
           select 1 from public.users u
           where u.id = auth.uid() and u.team = 'operations'
         )
         or o.requested_by = auth.uid()
         or o.assigned_to  = auth.uid()
         or public.resolve_permission(auth.uid(), 'orders', 'view_all')
       )
  );
$$;

comment on function public.can_view_order_as_actor(uuid) is
  'True when the CALLER may read this Order — admin, operations, its requester, its assignee, or orders.view_all — ANDed with the RESTRICTIVE Orders module entry gate. The DEFINER-SAFE sibling of can_view_order(): identical in meaning, but expressed in auth.uid() terms so it survives being called from inside a SECURITY DEFINER, where can_view_order() would silently degenerate to "the Order exists". Use can_view_order() in policies and invoker functions; use this one only where a definer has no alternative. Because it restates the orders SELECT policies rather than asking them, the migration that introduced it asserts that policy set at apply time. Null or unknown id is false.';

revoke execute on function public.can_view_order_as_actor(uuid) from public, anon;
grant  execute on function public.can_view_order_as_actor(uuid) to authenticated;

-- ═══ 2. The participant predicate, with a sound Order branch ════════════════
--
-- The CURRENT definition from 20260919000000 §2, copied here with ONE
-- authorization expression replaced — the repository's established idiom for
-- correcting an applied function (20260901000000 §2). The signature, return
-- type, volatility, security context and grants are unchanged, so all four
-- policies that call it keep working untouched:
--
--   finance_payment_requests_participant_select        permissive SELECT
--   finance_payment_requests_module_entry_gate         RESTRICTIVE, USING only
--   payment_proof_attachments_participant_select       permissive SELECT
--   payment_proof_attachments_module_entry_gate        RESTRICTIVE, USING only
--
-- STILL A DEFINER, because it must be: see the header. What changes is only that
-- its Order branch now asks a question that means something inside one.
--
-- THE PI BRANCH IS UNTOUCHED AND WAS ALWAYS SOUND. can_view_order_submission()
-- is a definer whose every branch is auth.uid()-based (20260915000000 §9), and
-- it IS the order_submissions_select policy rather than a restatement of it, so
-- nesting cannot change its meaning. module_entry_open('orders') stays ANDed to
-- it for the reason 20260919000000 gives: that helper is itself a definer and so
-- does not carry the PI table's own restrictive parent gate.
--
-- THE ONE EXPRESSION THAT CHANGES. The Order branch was
--
--     exists (select 1 from <the orders table> o where o.id = a.order_id)
--
-- which inside this definer meant "the Order exists" and so made every allocated
-- payment readable by every authenticated user. It is now
-- can_view_order_as_actor(a.order_id). Nothing else in the body moves.
--
-- The old expression is written without its schema prefix above on purpose: §4
-- asserts that the shipped body contains no direct read of the orders table at
-- all, and a comment inside the body would be part of the body.
--
-- SELECT ONLY, unchanged. The gate's WITH CHECK never mentioned this predicate
-- and still does not, so participant sight cannot authorize a write.

create or replace function public.can_read_payment_as_participant(p_payment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.finance_payment_allocations a
    where a.payment_request_id = p_payment_id
      and (
        (a.order_submission_id is not null
         and public.module_entry_open('orders')
         and public.can_view_order_submission(a.order_submission_id))
        or
        (a.order_id is not null
         and public.can_view_order_as_actor(a.order_id))
      )
  );
$$;

comment on function public.can_read_payment_as_participant(uuid) is
  'True when an allocation — active or reversed — attaches this payment to a PI submission or an Order the caller can already open. The single participant-visibility rule shared by the payment policy and the module gate. Grants SELECT only; confers no verification, allocation, correction or deletion. SECURITY DEFINER because reading finance_payment_allocations as the invoker would be a policy cycle through finance_payment_requests; both of its visibility branches are therefore auth.uid()-based predicates that keep their meaning at any nesting depth, never RLS reads that a definer would silently bypass.';

-- ═══ 3. The Order total, gated ══════════════════════════════════════════════
--
-- The CURRENT definition from 20261005000000 §2, copied verbatim, with the
-- attribution untouched and one authorization expression wrapped around it. §4
-- asserts the attribution shape survived the copy, so a transcription slip
-- cannot quietly change what the money means.
--
-- AN UNAUTHORIZED CALLER GETS NULL, NOT ZERO AND NOT AN ERROR. Zero is a
-- financial claim — "this Order has received nothing" — and an error message
-- distinguishes the rows that exist from the rows that do not. NULL is the same
-- answer for an Order the caller may not see and for an Order that does not
-- exist, so the function is not an oracle for either.
--
-- WHY auth.uid() IS NULL IS ALLOWED THROUGH. A null uid is not an end user: it
-- is the service role or a direct psql session. `anon` cannot reach this branch,
-- because anon holds no EXECUTE at all (§3 revoke, asserted in §4), and every
-- PostgREST session for role `authenticated` carries a sub claim. The service
-- role bypasses RLS entirely and can read finance_payment_requests directly, so
-- admitting it here grants nothing it did not already have — and refusing it
-- would silently blank the received figure in any operational or backfill
-- script. This is the same boundary 20260819000000 §4 already draws for the
-- cancellation role gate, in those words: "skipped when auth.uid() is null,
-- which is the service role and direct psql".
--
-- THE CANCEL FLOW IS UNAFFECTED. Its path is cancel_order(uuid, text) — granted
-- to authenticated, SECURITY DEFINER — into cancel_order_with_audit(), which
-- reads this function into v_received for the activity log. auth.uid() is the
-- real end user throughout, at every nesting depth, so an authorized canceller
-- passes can_view_order_as_actor() and gets the true total. A definer that
-- consulted RLS instead would have returned nothing there, which is precisely
-- why §1 is identity-based.

create or replace function public.order_linked_payment_total(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with authorized as (
    select public.can_view_order_as_actor(p_order_id)
        or auth.uid() is null as ok
  ),
  candidates as (
    -- Every VERIFIED payment that could be attributed to this Order at all:
    -- one the Order's own id names, or one an active allocation names it from.
    -- A payment whose only allocation to this Order was reversed is not a
    -- candidate through that route, which is rule 3.
    select f.id, f.amount, f.order_id
      from public.finance_payment_requests f
     where (select ok from authorized)
       and public.finance_payment_status_is_verified(f.status)
       and (
         f.order_id = p_order_id
         or exists (
           select 1
             from public.finance_payment_allocations a
            where a.payment_request_id = f.id
              and a.status = 'active'
              and a.order_id = p_order_id
         )
       )
  ),
  shares as (
    select
      c.id,
      c.amount,
      c.order_id,
      -- Every active allocation against this payment, wherever it points. This
      -- is the fact rule 1 turns on.
      coalesce((
        select sum(a.allocated_amount)
          from public.finance_payment_allocations a
         where a.payment_request_id = c.id
           and a.status = 'active'
      ), 0) as active_total,
      -- Only the ones naming THIS Order.
      coalesce((
        select sum(a.allocated_amount)
          from public.finance_payment_allocations a
         where a.payment_request_id = c.id
           and a.status = 'active'
           and a.order_id = p_order_id
      ), 0) as own_total
    from candidates c
  )
  select case when (select ok from authorized) then coalesce(sum(
    case
      -- RULE 1. Allocations exist, so allocations decide — and this Order's
      -- share is legitimately ZERO when the money went somewhere else. The
      -- direct linkage contributes nothing here, which is the whole correction.
      when s.active_total > 0        then s.own_total
      -- RULE 2. No active allocation anywhere: the direct linkage attributes
      -- the whole payment to the Order it names.
      when s.order_id = p_order_id   then s.amount
      else 0
    end
  ), 0) end
  from shares s;
$$;

comment on function public.order_linked_payment_total(uuid) is
  'Rupees of VERIFIED money attributed to one Confirmed Order under the canonical rule: if the payment has ANY active allocation, this Order receives only its own active allocated share and the payment''s direct order_id is ignored entirely; if it has none, the direct link attributes the whole payment. Reversed allocations count as zero. Attribution summed across every Order and PI, plus what is unallocated, equals the payment exactly. Mirrored by src/lib/finance/paymentAttribution.ts. GATED: returns NULL — never 0, never an error — unless the caller may view the Order under can_view_order_as_actor(), so an Order the caller cannot see and an Order that does not exist are indistinguishable. SECURITY DEFINER on purpose: a salesperson''s RLS does not show every payment on an Order, and cancelling one while misinformed about the money is the mistake this prevents. Reports; gates nothing.';

revoke execute on function public.order_linked_payment_total(uuid) from public, anon;
grant  execute on function public.order_linked_payment_total(uuid) to authenticated;

-- ═══ 4. Apply-time assertions ═══════════════════════════════════════════════
--
-- The migration refuses itself rather than ship a security fix that is wrong in
-- a way nobody would notice until data had been read.

do $$
declare
  v_def  text;
  v_pols text[];
  v_n    int;
begin
  -- 4a. The restatement in §1 must still match the policies it restates.
  select array_agg(p.polname order by p.polname) into v_pols
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'orders'
    and p.polpermissive
    and p.polcmd in ('r', '*');

  if v_pols is distinct from array[
       'orders_admin_select', 'orders_operations_select',
       'orders_permission_engine_select', 'orders_sales_select'
     ] then
    raise exception
      'can_view_order_as_actor restates the orders SELECT policies, and that set has changed to %; update §1 before applying', v_pols;
  end if;

  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'orders' and p.polname = 'orders_module_entry_gate'
      and not p.polpermissive
  ) then
    raise exception 'the RESTRICTIVE orders_module_entry_gate is missing; §1 assumes it';
  end if;

  -- 4b. §1 itself.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'can_view_order_as_actor';

  if v_def is null then raise exception 'can_view_order_as_actor is missing'; end if;
  if v_def !~ 'search_path' then
    raise exception 'can_view_order_as_actor must pin its search_path';
  end if;
  if v_def !~ 'module_entry_open' then
    raise exception 'can_view_order_as_actor must AND the RESTRICTIVE module gate';
  end if;
  if v_def !~ 'resolve_permission' then
    raise exception 'can_view_order_as_actor must honour orders.view_all';
  end if;

  -- 4c. The participant predicate: the bare EXISTS must be gone, and the two
  -- identity-based branches must both be present.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'can_read_payment_as_participant';

  if v_def is null then raise exception 'can_read_payment_as_participant is missing'; end if;
  if v_def !~* 'security definer' then
    raise exception
      'can_read_payment_as_participant must remain SECURITY DEFINER: as an invoker it is a policy cycle through finance_payment_requests';
  end if;
  if v_def !~ 'search_path' then
    raise exception 'can_read_payment_as_participant must pin its search_path';
  end if;
  if v_def ~ 'from public\.orders' then
    raise exception
      'can_read_payment_as_participant must not read public.orders directly: inside a definer that means "the Order exists"';
  end if;
  if v_def !~ 'can_view_order_as_actor' then
    raise exception 'can_read_payment_as_participant must ask can_view_order_as_actor for the Order branch';
  end if;
  if v_def !~ 'can_view_order_submission' then
    raise exception 'can_read_payment_as_participant must keep its PI branch';
  end if;

  -- 4d. All four policies that depend on it are still in place and still
  -- SELECT-only. This migration must not have disturbed them.
  select count(*) into v_n
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('finance_payment_requests', 'payment_proof_attachments')
    and pg_get_expr(p.polqual, p.polrelid) like '%can_read_payment_as_participant%';
  if v_n <> 4 then
    raise exception 'expected 4 policies to consult the participant predicate, found %', v_n;
  end if;

  select count(*) into v_n
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname in ('finance_payment_requests', 'payment_proof_attachments')
    and coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%can_read_payment_as_participant%';
  if v_n <> 0 then
    raise exception 'participant visibility must NEVER appear in a WITH CHECK, found %', v_n;
  end if;

  -- 4e. The Order total: gated, and the attribution rule intact.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'order_linked_payment_total';

  if v_def is null then raise exception 'order_linked_payment_total is missing'; end if;
  if v_def !~ 'can_view_order_as_actor' then
    raise exception 'order_linked_payment_total must be gated on Order visibility';
  end if;
  if v_def !~ 'finance_payment_status_is_verified' then
    raise exception 'order_linked_payment_total must use the shared verified predicate';
  end if;
  -- The canonical rule's shape, unchanged by the gating: the allocation branch
  -- must still be tested BEFORE the direct-link branch.
  if position('active_total > 0' in v_def) = 0
     or position('active_total > 0' in v_def) > position('s.order_id = p_order_id' in v_def) then
    raise exception
      'order_linked_payment_total must prefer active allocations over the direct link';
  end if;

  -- 4f. Grants on all three, exactly as intended.
  if has_function_privilege('anon', 'public.can_view_order_as_actor(uuid)', 'execute') then
    raise exception 'anon must not hold EXECUTE on can_view_order_as_actor';
  end if;
  if has_function_privilege('public', 'public.can_view_order_as_actor(uuid)', 'execute') then
    raise exception 'PUBLIC must not hold EXECUTE on can_view_order_as_actor';
  end if;
  if not has_function_privilege('authenticated', 'public.can_view_order_as_actor(uuid)', 'execute') then
    raise exception 'authenticated must hold EXECUTE on can_view_order_as_actor';
  end if;
  if has_function_privilege('anon', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'anon must not hold EXECUTE on order_linked_payment_total';
  end if;
  if not has_function_privilege('authenticated', 'public.order_linked_payment_total(uuid)', 'execute') then
    raise exception 'authenticated must retain EXECUTE on order_linked_payment_total';
  end if;
  if has_function_privilege('anon', 'public.can_read_payment_as_participant(uuid)', 'execute') then
    raise exception 'anon must not hold EXECUTE on can_read_payment_as_participant';
  end if;
end $$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
--   drop function if exists public.can_view_order_as_actor(uuid);
--
-- then re-run 20260919000000 §2's definition of can_read_payment_as_participant
-- and 20261005000000 §2's definition of order_linked_payment_total.
--
-- Nothing else needs undoing: no table, column, policy, index, trigger or grant
-- was created, altered or dropped, and no data was written. Rolling back
-- restores both exposures above — every allocated payment readable by every
-- authenticated user, and every Order's received total readable by the same.

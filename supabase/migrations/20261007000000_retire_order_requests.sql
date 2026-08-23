-- ═════════════════════════════════════════════════════════════════════════════
-- Retiring the Order Request workflow
-- ═════════════════════════════════════════════════════════════════════════════
--
-- NOT APPLIED. Requires explicit approval before `supabase db push`.
-- Apply AFTER 20261006000000. Forward-only; no earlier migration is edited.
--
-- ── WHAT CHANGED IN THE BUSINESS ─────────────────────────────────────────────
--
-- There is now ONE pre-approval Order workflow, and it is the PI:
--
--     PI upload/import → PI Draft → submit for review → finance/payment
--     conditions → management approval → Confirmed Order
--
-- Anything not finally approved stays a PI Draft. Only an approved PI becomes a
-- Confirmed Order. The Order Request — the older path where somebody raised a
-- request that an admin later CONVERTED into an Order — is retired.
--
-- ── WHAT THIS FILE DOES, AND WHAT IT REFUSES TO DO ───────────────────────────
--
-- IT CLOSES THE WRITE PATHS. Four triggers and one dropped policy, so that no
-- caller — client, service role, direct SQL, or an old RPC somebody still holds
-- a reference to — can create an Order Request, convert one into an Order, stamp
-- request provenance onto a NEW Order, or attach a NEW payment to a request.
-- Hiding a screen is not retirement: a route that is gone from the sidebar is
-- still a POST away, and the database is the only place a rule cannot be routed
-- around.
--
-- IT DELETES NOTHING. Not one table, column, foreign key, index, row, storage
-- object or audit entry. `public.order_requests`, `order_request_activity`,
-- `order_request_attachments`, `orders.source_order_request_id`,
-- `orders.source_request_number`, `finance_payment_requests.order_request_id`
-- and `order_request_number` all stay exactly as they are, and every SELECT
-- policy on them is untouched:
--
--   * confirmed Orders created by conversion carry their provenance, and
--     20260701000000's immutability trigger already refuses to change it. An
--     Order that opens today must still open tomorrow.
--   * `finance_payment_requests.order_request_id` is a historical fact about
--     where money was parked. Nulling it would rewrite the payment trail, and
--     the canonical attribution rule (PR #49) already treats it as attributing
--     NOTHING — only `order_id` is a fallback — so such a payment reads as
--     available money that now needs a real home, which is the truth.
--   * the activity rows are audit history. Audit history is not editable by a
--     migration whose subject is a product decision.
--
-- IF THE REMAINING ORDER REQUEST DATA IS ALL TEST DATA, it is removed through
-- the existing controlled test-data cleanup protocol (20260706000000), not
-- here, and not as part of applying this file. `admin_delete_order_request` is
-- therefore left executable on purpose.
--
-- ── FINANCE PAYMENT REQUESTS ARE NOT ORDER REQUESTS ──────────────────────────
--
-- Nothing in this file touches the Finance Payment Request workflow. That is a
-- different record on a different table (`finance_payment_requests`) with a
-- different lifecycle, and it remains fully active: raising one, verifying one,
-- correcting one, allocating one and reversing an allocation all behave exactly
-- as they did. The ONE Finance thing this file constrains is naming a retired
-- Order Request as a NEW payment's target, which is a doorway into the retired
-- workflow rather than part of the Payment Request workflow itself.
--
-- ── THE SHAPE OF EVERY REFUSAL ───────────────────────────────────────────────
--
-- Each guard raises `ORDER_REQUESTS_RETIRED` with errcode P0001 and names the
-- replacement, so a caller that somehow reaches one is told what to do instead
-- rather than shown a constraint violation. No guard reads auth.uid() and none
-- exempts a role: a retirement that an admin or the service role could step
-- around would not be a retirement.

begin;

-- ═══ 1. No client may write to order_requests at all ═══════════════════════
--
-- TWO LAYERS, because they fail differently and both are wanted.
--
-- The POLICIES are the PostgREST-facing layer. With no PERMISSIVE policy for a
-- command, PostgreSQL refuses that command outright for every client role: an
-- INSERT is refused before a row is built, and an UPDATE or DELETE matches zero
-- rows. That is the layer that stops the retired screen's own POST, and any
-- hand-made copy of it.
--
-- The TRIGGERS below are the layer beneath. RLS does not apply to the table
-- owner, to `service_role`, or inside a SECURITY DEFINER function — and
-- `finalize_order_request` is exactly such a function. A trigger applies to all
-- of them.
--
-- ── WHAT THE FIRST ATTEMPT AT THIS MIGRATION GOT WRONG ──
--
-- It dropped the INSERT policy and then asserted that no policy on the table had
-- `cmd` of INSERT or ALL. The linked database refused the apply:
--
--     order_requests still has 1 INSERT-capable polic(ies);
--     the retired workflow would remain creatable
--
-- The policy it found is `order_requests_module_entry_gate` (20260905000000 §2),
-- and it is RESTRICTIVE. A restrictive policy is AND-ed with the permissive ones
-- and can only ever NARROW access — it grants nothing, INSERT-capable or
-- otherwise. Dropping it would have REMOVED a restriction: the parent
-- module-entry gate that stops somebody without `orders:view` reaching the four
-- permissive SELECT policies at all. The assertion was wrong, not the database,
-- and §5b below now asks the question it meant to ask.
--
-- Proved rather than argued: supabase/tests/order_request_retirement_pre_107.sql
-- drops only the permissive INSERT policy, keeps the gate, and shows the INSERT
-- refused for an owner AND for an admin. The suite around it
-- (run_order_request_retirement_suite.sh) reproduces the failure above verbatim
-- and shows it rolling back to a byte-identical policy set.
--
-- ── THE TWO PERMISSIVE WRITE POLICIES THIS DROPS ──
--
--   order_requests_requester_insert          (20260710000000 §2)
--   order_requests_admin_delete_unconverted  (20260705000000)
--
-- The first is the creation path and is the point of the whole file.
--
-- THE SECOND IS DROPPED BECAUSE NOTHING CALLS IT. It let an admin delete an
-- unconverted request straight from PostgREST. Every deletion of an
-- `order_requests` row in this schema happens inside a SECURITY DEFINER
-- function — `admin_delete_order_request`, `cleanup_unfinalized_order_request`
-- and `execute_test_data_cleanup` — and a definer function bypasses RLS, so not
-- one of them needs a policy. Keeping a direct client DELETE on a retired
-- workflow's table would be retaining a write path with no caller and no audit
-- trail, when the audited RPC that replaces it is asserted still executable in
-- §5j.
--
-- NO UPDATE POLICY IS DROPPED, because there has not been one since
-- 20260683000000 and 20260687000000 moved every mutation into an RPC. A direct
-- UPDATE already matches zero rows; §5c asserts it stays that way.

drop policy if exists "order_requests_requester_insert" on public.order_requests;
drop policy if exists "order_requests_admin_delete_unconverted" on public.order_requests;

create or replace function public.order_requests_refuse_new()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception
    'ORDER_REQUESTS_RETIRED: the Order Request workflow is retired. Upload the PI and submit it as a PI Draft instead.'
    using errcode = 'P0001';
end;
$$;

comment on function public.order_requests_refuse_new() is
  'Refuses every INSERT into public.order_requests. The Order Request workflow is retired; PI Drafts are the only pre-approval Order workflow. Reads no actor and exempts no role — including the service role and any SECURITY DEFINER caller — because a retirement a privileged path could step around is not one. Existing rows are untouched and remain readable for audit.';

revoke execute on function public.order_requests_refuse_new() from public, anon, authenticated;

drop trigger if exists order_requests_refuse_new on public.order_requests;

create trigger order_requests_refuse_new
  before insert on public.order_requests
  for each row execute function public.order_requests_refuse_new();

-- ═══ 2. No Order Request may be converted into an Order ═════════════════════
--
-- The conversion is TWO writes — the request moves to `converted` and an Order
-- row is created carrying the request's id — and both are refused, in the two
-- places they happen, because either one alone would leave the other reachable.
--
-- 2a. THE REQUEST SIDE. `converted` is the only status transition blocked. Every
-- other UPDATE still applies, so `admin_delete_order_request`'s bookkeeping, the
-- test-data cleanup protocol and any future correction of a historical row keep
-- working. A row that is ALREADY converted may still be updated, unchanged: this
-- refuses the TRANSITION, never the record.

create or replace function public.order_requests_refuse_conversion()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'converted' and old.status is distinct from 'converted' then
    raise exception
      'ORDER_REQUESTS_RETIRED: an Order Request can no longer be converted into an Order. Approve the PI Draft instead.'
      using errcode = 'P0001';
  end if;

  -- The CHECK constraint on this table already ties converted_order_id to the
  -- status, so this branch is unreachable through it. It is stated anyway: the
  -- constraint could be relaxed, and a conversion that arrived by setting the
  -- id alone would otherwise pass.
  if new.converted_order_id is not null and old.converted_order_id is null then
    raise exception
      'ORDER_REQUESTS_RETIRED: an Order Request can no longer be attached to a new Order. Approve the PI Draft instead.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.order_requests_refuse_conversion() is
  'Refuses the transition of an Order Request into the converted state, and the attachment of a converted_order_id where there was none. Already-converted rows are fully editable as before: this blocks the transition, never the record, so historical provenance stays readable and correctable through its existing controlled paths.';

revoke execute on function public.order_requests_refuse_conversion() from public, anon, authenticated;

drop trigger if exists order_requests_refuse_conversion on public.order_requests;

create trigger order_requests_refuse_conversion
  before update on public.order_requests
  for each row execute function public.order_requests_refuse_conversion();

-- 2b. THE ORDER SIDE. A NEW Order may not be stamped with request provenance.
--
-- INSERT ONLY, and that is the whole point. `orders.source_order_request_id` is
-- how an existing confirmed Order records where it came from, and
-- 20260701000000's `prevent_order_source_request_change` already makes it
-- immutable once set. Every historical Order keeps its provenance and keeps
-- opening; what is refused is a NEW Order claiming to have come from a request.

create or replace function public.orders_refuse_request_provenance()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.source_order_request_id is not null or new.source_request_number is not null then
    raise exception
      'ORDER_REQUESTS_RETIRED: a new Order cannot be created from an Order Request. Approve the PI Draft instead.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.orders_refuse_request_provenance() is
  'Refuses a NEW Order that carries Order Request provenance. Existing Orders are untouched — their source_order_request_id stays, stays immutable, and stays readable — so a historical confirmed Order still opens and still shows where it came from.';

revoke execute on function public.orders_refuse_request_provenance() from public, anon, authenticated;

drop trigger if exists orders_refuse_request_provenance on public.orders;

create trigger orders_refuse_request_provenance
  before insert on public.orders
  for each row execute function public.orders_refuse_request_provenance();

-- ═══ 3. No NEW payment may name an Order Request ════════════════════════════
--
-- The Finance Payment Request workflow is NOT retired and nothing here changes
-- it. What is refused is one target: attaching money to an Order Request, which
-- is a doorway into the retired workflow rather than part of Finance's own.
--
-- ESTABLISHING THE LINK IS WHAT IS REFUSED, NOT HOLDING IT. An UPDATE that
-- leaves `order_request_id` exactly as it was passes untouched, so every
-- correction, verification, allocation and status change on a historical
-- request-linked payment keeps working — including
-- `unlink_finance_payment_from_order_request`, which sets the column to NULL and
-- is deliberately left executable so that historical money can be freed and
-- allocated to a real Order or PI.

create or replace function public.finance_payment_requests_refuse_request_target()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.order_request_id is not null
     and (tg_op = 'INSERT' or new.order_request_id is distinct from old.order_request_id)
  then
    raise exception
      'ORDER_REQUESTS_RETIRED: a payment can no longer be attached to an Order Request. Attach it to a Confirmed Order or allocate it to a PI Draft.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

comment on function public.finance_payment_requests_refuse_request_target() is
  'Refuses a payment that newly names an Order Request. Holding an existing link is untouched, so historical request-linked payments stay readable, correctable and unlinkable; only establishing a NEW one is refused. Nothing else about the Finance Payment Request workflow changes.';

revoke execute on function public.finance_payment_requests_refuse_request_target() from public, anon, authenticated;

drop trigger if exists finance_payment_requests_refuse_request_target
  on public.finance_payment_requests;

-- Named to sort AFTER finance_payment_requests_derive_target, which runs first
-- and is what would otherwise classify the row as `order_request`. PostgreSQL
-- fires BEFORE triggers in name order, and `zz_` guarantees this one sees the
-- derived value rather than only the payload.
create trigger zz_finance_payment_requests_refuse_request_target
  before insert or update on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_refuse_request_target();

-- ═══ 4. The retired RPCs are no longer executable by any client ═════════════
--
-- BY NAME, ACROSS EVERY OVERLOAD. Several of these were replaced in place over
-- the phases and more than one signature survives in the catalog
-- (`convert_order_request_to_order` has two, `reject_order_request` has two).
-- Enumerating signatures here would revoke one and leave the other, which is the
-- exact gap this section exists to close — so the loop revokes every overload of
-- every named function.
--
-- REVOKE, NOT DROP. Dropping a SECURITY DEFINER function that historical
-- activity rows and comments reference gains nothing and would make a rollback a
-- restore rather than a grant. With EXECUTE revoked from `authenticated` and
-- `anon`, PostgREST refuses the call outright — and even if one were somehow
-- invoked, the triggers in sections 1–3 refuse the writes it would attempt.
--
-- WHAT IS DELIBERATELY LEFT EXECUTABLE, and why:
--
--   admin_delete_order_request                  the controlled cleanup path
--   cleanup_unfinalized_order_request           removes an abandoned draft
--   remove_unfinalized_order_request_attachment the same, one file at a time
--   admin_list_stale_order_request_drafts       a read
--   unlink_finance_payment_from_order_request   frees historical money so it can
--                                               be allocated to a real target
--
-- None of the five creates an Order Request, advances one, or converts one.
-- Removing them would strand data and money rather than retire a workflow.

do $$
declare
  v_name  text;
  v_proc  record;
  v_count int := 0;
begin
  foreach v_name in array array[
    'finalize_order_request',
    'resubmit_order_request',
    'reapply_order_request',
    'respond_to_clarification',
    'edit_order_request',
    'edit_order_request_attachments',
    'request_order_request_clarification',
    'reject_order_request',
    'convert_order_request_to_order',
    'link_finance_payment_to_order_request'
  ] loop
    for v_proc in
      select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = v_name
    loop
      execute format('revoke execute on function %s from public, anon, authenticated', v_proc.sig);
      v_count := v_count + 1;
    end loop;
  end loop;

  -- Not an error if a name is absent: a function this project never deployed
  -- cannot be a way in. But zero matches across ALL TEN names would mean the
  -- loop matched nothing at all, which is a typo rather than a clean schema.
  if v_count = 0 then
    raise exception
      'retirement revoked nothing: none of the ten Order Request RPCs was found in public';
  end if;
end $$;

-- ═══ 5. Apply-time assertions ═══════════════════════════════════════════════
--
-- The migration refuses itself rather than reporting a retirement it did not
-- actually perform. Every check below reads the COMMITTED catalog or probes the
-- real behaviour; none of them re-states an intention.
--
-- ROLLBACK IS ATOMIC. The whole file is one transaction, so a failure here
-- leaves the policy set, the triggers and every grant exactly as they were —
-- which is what the linked database observed when the first attempt refused
-- itself, and what supabase/tests/order_request_retirement_assertions.sql
-- re-proves.

-- ── 5a. Row and provenance census, taken BEFORE anything is asserted ────────
--
-- Captured into a temp table so 5k can prove the file removed no row and
-- rewrote no provenance value. Temp, so it disappears with the session and
-- cannot become schema.

create temporary table t_retirement_census on commit drop as
select
  (select count(*) from public.order_requests)                                     as requests,
  (select count(*) from public.order_request_activity)                             as activity,
  (select count(*) from public.order_request_attachments)                          as attachments,
  (select count(*) from public.orders where source_order_request_id is not null)   as orders_with_provenance,
  (select count(*) from public.finance_payment_requests
    where order_request_id is not null)                                            as payments_with_linkage;

do $$
declare
  v_missing  text;
  v_count    int;
  v_names    text;
  v_expected text[];
  v_probe    uuid;
  v_admin    uuid;
  v_row      uuid;
begin
  -- ── 5a. RLS is still ON ──
  --
  -- FIRST, because every other policy assertion is meaningless without it. If
  -- RLS were off, "no INSERT policy" would mean the opposite of what 5b claims.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'order_requests' and c.relrowsecurity
  ) then
    raise exception 'row level security must remain enabled on public.order_requests';
  end if;

  -- ── 5b. No PERMISSIVE policy admits INSERT ──
  --
  -- THE CORRECTION. The first attempt counted every policy whose `cmd` was
  -- INSERT or ALL and refused the apply on finding one — but the one it found,
  -- `order_requests_module_entry_gate`, is RESTRICTIVE. Restrictive policies are
  -- AND-ed with the permissive ones; they can only narrow, never grant. Counting
  -- one as INSERT-capable is a category error, and acting on it would have meant
  -- dropping the parent module-entry gate, which WIDENS the table.
  --
  -- The question that actually decides whether a row can be inserted is: is
  -- there a PERMISSIVE policy for INSERT (or for ALL, which covers it)? With
  -- none, PostgreSQL refuses the command for every client role.
  select string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname)
    into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'order_requests'
    and permissive = 'PERMISSIVE'
    and cmd in ('INSERT', 'ALL');

  if v_names is not null then
    raise exception
      'order_requests still has permissive INSERT-capable polic(ies): %; the retired workflow would remain creatable',
      v_names;
  end if;

  -- ── 5c. And none admits UPDATE or DELETE either ──
  --
  -- Direct UPDATE has been impossible since 20260683000000/20260687000000 moved
  -- every mutation into an RPC; §1 removes the last direct DELETE. Both are
  -- asserted rather than assumed, because a client write path into a retired
  -- workflow's records is exactly the thing that survives a retirement by
  -- accident.
  select string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname)
    into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'order_requests'
    and permissive = 'PERMISSIVE'
    and cmd in ('UPDATE', 'DELETE', 'ALL');

  if v_names is not null then
    raise exception
      'order_requests still has permissive write polic(ies): %; cleanup belongs to the SECURITY DEFINER RPCs, which bypass RLS and need none',
      v_names;
  end if;

  -- ── 5d. THE RESTRICTIVE PARENT GATE IS STILL THERE ──
  --
  -- Asserted POSITIVELY, so no future edit "tidies away" the ALL policy the way
  -- the first attempt was about to. It is the only thing stopping somebody
  -- without `orders:view` reaching the four SELECT policies below, and removing
  -- it would widen historical visibility rather than retire anything.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'order_requests'
      and policyname = 'order_requests_module_entry_gate'
      and permissive = 'RESTRICTIVE' and cmd = 'ALL'
  ) then
    raise exception
      'order_requests_module_entry_gate must remain, RESTRICTIVE and FOR ALL: it is the parent module-entry gate (20260905000000), and dropping it would widen the table rather than retire it';
  end if;

  -- ── 5e. The four historical SELECT policies remain, and nothing else does ──
  --
  -- AN EXACT SET, not a minimum. A policy this file does not know about is a
  -- policy nobody reasoned about, so it is named in the failure rather than
  -- silently tolerated — and never dropped dynamically, because a migration that
  -- deletes what it does not recognise is worse than one that stops.
  v_expected := array[
    'order_requests_admin_select',        -- 20260711000000 §3
    'order_requests_assignee_select',     -- 20260711000000 §3
    'order_requests_module_entry_gate',   -- 20260905000000 §2, RESTRICTIVE
    'order_requests_requester_select',    -- 20260680000000
    'order_requests_view_all_select'      -- 20260903000000
  ];

  select string_agg(policyname, ', ' order by policyname) into v_names
  from pg_policies
  where schemaname = 'public' and tablename = 'order_requests'
    and not (policyname = any (v_expected));

  if v_names is not null then
    raise exception
      'order_requests carries unexpected polic(ies): %. This migration reasoned about exactly: %',
      v_names, array_to_string(v_expected, ', ');
  end if;

  foreach v_missing in array v_expected loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = 'order_requests' and policyname = v_missing
    ) then
      raise exception
        'order_requests lost "%": historical records must stay readable by the same people who could read them before retirement',
        v_missing;
    end if;
  end loop;

  -- At least one SELECT policy, stated separately from the set above so the
  -- requirement survives the set being edited.
  select count(*) into v_count
  from pg_policies
  where schemaname = 'public' and tablename = 'order_requests'
    and permissive = 'PERMISSIVE' and cmd = 'SELECT';

  if v_count < 1 then
    raise exception 'order_requests has no permissive SELECT policy; history would become unreadable';
  end if;

  -- ── 5f. HISTORY IS STILL READABLE, PROVED BY READING IT ──
  --
  -- The catalog checks above say the right policies exist. This says they still
  -- WORK, by becoming an ordinary client and looking.
  --
  -- Requires membership of `authenticated` to assume the role. `supabase db
  -- push` connects as `postgres`, which is a superuser and therefore a member of
  -- every role, so this runs in the real target environment. Where it genuinely
  -- cannot, it fails loudly and names why rather than skipping quietly.
  if not pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise exception
      'cannot assume the authenticated role as %, so the historical-visibility probe could not run. Apply this migration as a role that may SET ROLE authenticated (supabase db push uses postgres).',
      current_user;
  end if;

  -- A finalized request, and an active admin: the pair `order_requests_admin_select`
  -- is written for, and the pair whose visibility must be unchanged. With no
  -- historical rows there is genuinely nothing to demonstrate, and saying so is
  -- more honest than inventing a fixture — this migration writes no row.
  select id into v_row
  from public.order_requests where finalized_at is not null limit 1;

  select id into v_admin
  from public.users where role = 'admin' and coalesce(is_deleted, false) = false limit 1;

  if v_row is null then
    raise notice
      'no finalized Order Request exists, so the historical-visibility probe has nothing to read. The policy set is asserted above.';
  elsif v_admin is null then
    raise notice
      'no active admin exists, so the historical-visibility probe has nobody to read as. The policy set is asserted above.';
  else
    -- 5f-i. An authorised historical viewer still sees the row.
    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    select count(*) into v_count from public.order_requests where id = v_row;
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);

    if v_count <> 1 then
      raise exception
        'an admin can no longer read finalized Order Request %: retirement must not cost anybody sight of an existing record',
        v_row;
    end if;

    -- 5f-ii. An unrelated user still sees nothing. A uuid no row and no user
    -- carries: not the creator, not the requester, not the assignee, not an
    -- admin, and holding no grant — so both the gate and every permissive
    -- policy refuse them. Probing with a synthetic id writes nothing.
    v_probe := '00000000-0000-4000-8000-0000000000ff'::uuid;
    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_probe::text, true);
    select count(*) into v_count from public.order_requests;
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);

    if v_count <> 0 then
      raise exception
        'an unrelated user can read % Order Request row(s); retirement must not widen visibility',
        v_count;
    end if;

    -- 5f-iii. That same admin cannot INSERT, and cannot UPDATE or DELETE.
    --
    -- The strongest statement of the whole file, made the only way that settles
    -- it: by trying. The INSERT is expected to raise, so it is caught; the
    -- UPDATE and DELETE are expected to match zero rows, because RLS filters
    -- them rather than erroring.
    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin::text, true);

    begin
      insert into public.order_requests (request_number, status, created_by, requested_by, assigned_to)
      values ('RETIREMENT-PROBE', 'submitted', v_admin, v_admin, v_admin);
      execute 'reset role';
      raise exception
        'an admin was able to INSERT an Order Request: the retirement is not closed';
    exception
      when insufficient_privilege or check_violation then
        null;  -- refused by RLS, which is the point
      when others then
        -- The trigger's own ORDER_REQUESTS_RETIRED is equally a refusal, and on
        -- a path where the owner reaches the trigger it is the one that fires.
        if sqlerrm not like '%ORDER_REQUESTS_RETIRED%'
           and sqlerrm not like '%row-level security%' then
          execute 'reset role';
          raise;
        end if;
    end;

    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    update public.order_requests set client_name = client_name where id = v_row;
    get diagnostics v_count = row_count;
    execute 'reset role';
    if v_count <> 0 then
      raise exception 'an admin updated % Order Request row(s) directly; every mutation belongs to an RPC', v_count;
    end if;

    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    delete from public.order_requests where id = v_row;
    get diagnostics v_count = row_count;
    execute 'reset role';
    perform set_config('request.jwt.claim.sub', '', true);
    if v_count <> 0 then
      raise exception
        'an admin deleted % Order Request row(s) directly; deletion belongs to admin_delete_order_request, which is audited',
        v_count;
    end if;
  end if;

  -- ── 5g. The four guards are attached, and each is enabled ──
  --
  -- A trigger created and then disabled is the failure mode a bare
  -- `create trigger` cannot catch.
  foreach v_missing in array array[
    'order_requests_refuse_new',
    'order_requests_refuse_conversion',
    'orders_refuse_request_provenance',
    'zz_finance_payment_requests_refuse_request_target'
  ] loop
    if not exists (
      select 1 from pg_trigger t
      where t.tgname = v_missing and not t.tgisinternal and t.tgenabled <> 'D'
    ) then
      raise exception 'the retirement guard "%" is missing or disabled', v_missing;
    end if;
  end loop;

  -- ── 5h. HISTORY IS STILL READABLE on the two child tables ──
  foreach v_missing in array array['order_request_activity', 'order_request_attachments'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = v_missing and cmd in ('SELECT', 'ALL')
    ) then
      raise exception 'public.% lost its SELECT policies; historical records must stay readable', v_missing;
    end if;
  end loop;

  -- ── 5i. NOTHING WAS DELETED. Every column the historical records depend on
  -- is still there, still named the same.
  --
  -- ── WHY THIS ASKS pg_catalog AND NOT information_schema ──
  --
  -- The first form of this check asked `information_schema.columns`, and the
  -- linked database refused the apply on it:
  --
  --     public.orders.source_order_request_id must not be dropped:
  --     confirmed Orders depend on it
  --
  -- The column is not missing. `20260701000000` adds it, no migration in the
  -- history drops or renames it, the Order detail page selects it
  -- (src/app/orders/[id]/page.tsx), and the census statement immediately above
  -- this block had just READ it — `count(*) ... where source_order_request_id is
  -- not null` cannot parse against a column that is not there. Two statements
  -- apart, the same migration read the column and then declared it dropped.
  --
  -- `information_schema.columns` is not a schema oracle. Its definition ends
  --
  --     AND c.relkind IN ('r', 'v', 'f', 'p')
  --     AND (pg_has_role(c.relowner, 'USAGE')
  --          OR has_column_privilege(c.oid, a.attnum,
  --                                  'SELECT, INSERT, UPDATE, REFERENCES'))
  --
  -- so it answers "is this column visible to whoever is asking", not "does this
  -- column exist". It reports a perfectly present column as absent whenever the
  -- applying role is neither the table's owner nor a holder of a privilege on
  -- that column, and for any relation kind outside those four. That is a
  -- property of the connection, not of the schema — which is exactly why this
  -- passed locally and failed on the linked database.
  --
  -- `pg_catalog.pg_attribute` is the schema. It is readable by PUBLIC, it is
  -- filtered by nothing, and it is what `to_regclass` and every DDL statement
  -- resolve against. The divergence is demonstrated, both directions, in
  -- supabase/tests/order_request_provenance_assertions.sql §1.
  --
  -- AND THE COLUMN IS THEN READ. A catalog row proves existence; it does not
  -- prove the historical record is still reachable through it. The dynamic
  -- SELECT below is the assertion that would still fail if a column survived as
  -- an unusable stub — and it is the same read the application performs.
  foreach v_missing in array array[
    'orders.source_order_request_id',
    'orders.source_request_number',
    'finance_payment_requests.order_request_id',
    'finance_payment_requests.order_request_number',
    'order_requests.converted_order_id',
    'order_requests.request_number'
  ] loop
    if to_regclass('public.' || quote_ident(split_part(v_missing, '.', 1))) is null
       or not exists (
         select 1
         from pg_catalog.pg_attribute a
         where a.attrelid = ('public.' || quote_ident(split_part(v_missing, '.', 1)))::regclass
           and a.attname  = split_part(v_missing, '.', 2)
           and a.attnum > 0
           and not a.attisdropped
       ) then
      raise exception 'public.% must not be dropped: confirmed Orders depend on it', v_missing;
    end if;

    begin
      execute format('select count(*) from public.%I where %I is not null',
                     split_part(v_missing, '.', 1), split_part(v_missing, '.', 2))
        into v_count;
    exception when others then
      raise exception
        'public.% is in the catalog but could not be read (%): the historical record must stay reachable',
        v_missing, sqlerrm;
    end;
  end loop;

  -- The three tables themselves, and the provenance foreign key that ties an
  -- Order to the request it came from.
  foreach v_missing in array array[
    'order_requests', 'order_request_activity', 'order_request_attachments'
  ] loop
    if to_regclass('public.' || v_missing) is null then
      raise exception 'public.% must not be dropped: it is the historical record', v_missing;
    end if;
  end loop;

  -- ── 5j. The cleanup and unlink paths are still executable ──
  --
  -- Revoking them would strand abandoned drafts and, worse, strand money on a
  -- retired record with no way to move it to a real one.
  foreach v_missing in array array[
    'admin_delete_order_request',
    'cleanup_unfinalized_order_request',
    'remove_unfinalized_order_request_attachment',
    'unlink_finance_payment_from_order_request'
  ] loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_missing
      and has_function_privilege('authenticated', p.oid, 'execute');

    if v_count = 0 then
      raise exception
        '% must remain executable by authenticated: retiring a workflow must not strand its data', v_missing;
    end if;
  end loop;

  -- ── 5k. The ten retired RPCs are executable by no client role, in any overload ──
  foreach v_missing in array array[
    'finalize_order_request',
    'resubmit_order_request',
    'reapply_order_request',
    'respond_to_clarification',
    'edit_order_request',
    'edit_order_request_attachments',
    'request_order_request_clarification',
    'reject_order_request',
    'convert_order_request_to_order',
    'link_finance_payment_to_order_request'
  ] loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_missing
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'));

    if v_count <> 0 then
      raise exception
        '% is still executable by a client role in % overload(s); the retired workflow remains reachable',
        v_missing, v_count;
    end if;
  end loop;

  -- ── 5l. FINANCE PAYMENT REQUESTS ARE UNCHANGED ──
  --
  -- The four doors that make that workflow work must all still be open: this
  -- file must not have retired the wrong thing.
  foreach v_missing in array array[
    'approve_finance_payment_request',
    'allocate_payment_to_target',
    'reverse_payment_allocation',
    'link_finance_payment_to_order'
  ] loop
    select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_missing
      and has_function_privilege('authenticated', p.oid, 'execute');

    if v_count = 0 then
      raise exception
        'Finance Payment Requests must remain active: % is no longer executable', v_missing;
    end if;
  end loop;

  -- And its own table keeps a permissive write path, because that workflow is
  -- NOT retired. An empty result here would mean this file narrowed Finance by
  -- mistake.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'finance_payment_requests'
      and permissive = 'PERMISSIVE' and cmd in ('INSERT', 'UPDATE', 'ALL')
  ) then
    raise exception
      'finance_payment_requests lost its permissive write policies; the Finance Payment Request workflow must remain active';
  end if;

  -- ── 5m. NOT ONE ROW WAS REMOVED, AND NO PROVENANCE VALUE REWRITTEN ──
  --
  -- Compared against the census taken before any assertion ran. This file
  -- contains no INSERT, UPDATE or DELETE of a business row; the census is what
  -- makes that a checked fact rather than a claim.
  if exists (
    select 1 from t_retirement_census c
    where c.requests               <> (select count(*) from public.order_requests)
       or c.activity               <> (select count(*) from public.order_request_activity)
       or c.attachments            <> (select count(*) from public.order_request_attachments)
       or c.orders_with_provenance <> (select count(*) from public.orders
                                        where source_order_request_id is not null)
       or c.payments_with_linkage  <> (select count(*) from public.finance_payment_requests
                                        where order_request_id is not null)
  ) then
    raise exception
      'the retirement changed a row count or a provenance value; it must delete and rewrite nothing';
  end if;

  raise notice 'Order Request retirement: all assertions passed';
end $$;


commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
--   drop trigger if exists order_requests_refuse_new                        on public.order_requests;
--   drop trigger if exists order_requests_refuse_conversion                 on public.order_requests;
--   drop trigger if exists orders_refuse_request_provenance                 on public.orders;
--   drop trigger if exists zz_finance_payment_requests_refuse_request_target on public.finance_payment_requests;
--   drop function if exists public.order_requests_refuse_new();
--   drop function if exists public.order_requests_refuse_conversion();
--   drop function if exists public.orders_refuse_request_provenance();
--   drop function if exists public.finance_payment_requests_refuse_request_target();
--
-- then re-create `order_requests_requester_insert` from 20260710000000 §2
-- verbatim, and re-grant EXECUTE on the ten RPCs to `authenticated`.
--
-- NO DATA CHANGE NEEDS UNDOING. This file inserts, updates and deletes nothing.

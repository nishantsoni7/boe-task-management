-- Test Data Cleanup — remove a test Order created from an approved PI, safely.
--
-- ═══ TWO DEFECTS, NOT ONE ═══════════════════════════════════════════════════
--
-- ── A. The reported one: the cleanup could not run at all ────────────────────
--
--   update or delete on table "orders" violates foreign key constraint
--   "order_submissions_order_id_fkey" on table "order_submissions"
--
-- 20260915000000 introduced a SECOND provenance link, and it points both ways:
--
--   order_submissions.order_id            -> orders(id)              NO ACTION
--   orders.source_order_submission_id     -> order_submissions(id)   NO ACTION
--
-- Two NO ACTION foreign keys facing each other. Neither row can be deleted while
-- the other exists, and execute_test_data_cleanup() only knew how to release the
-- OLDER pair (20260701), so it walked straight into the constraint.
--
-- ── B. The one found in review: the obvious fix was unsafe ───────────────────
--
-- The first attempt removed the PI's files in one call and deleted the rows in
-- another, orchestrated by the browser, on the reasoning that "a storage failure
-- leaves a complete, retryable record". THAT REASONING WAS WRONG, twice over:
--
--   * removeAllObjectsForSubmission() removes objects in batches and reports
--     failures AFTERWARDS. A partial success is a real outcome: some files are
--     already gone when the failure is reported.
--   * even a fully successful sweep is followed by a SEPARATE database call,
--     which can refuse — cleanup disabled meanwhile, eligibility changed, a lost
--     connection, any gate.
--
-- Either way the result is the same and it is the worst outcome this system can
-- produce: AN APPROVED PI SURVIVES WITH ITS WORKBOOK AND PRODUCT IMAGES
-- DESTROYED. Silent, permanent, and indistinguishable from a healthy record
-- until somebody opens it.
--
-- It is exactly the defect 20260914000000 was written to prevent for ordinary PI
-- deletion, and it has exactly the same remedy: A DURABLE CLAIM.
--
-- ═══ THE PROTOCOL ═══════════════════════════════════════════════════════════
--
--   1. begin_test_data_cleanup(root, reason, confirmation)
--        every gate, the whole chain resolved, the rows LOCKED, both provenance
--        links proved to agree, a permanent audit row written, and an
--        unguessable claim recorded. Nothing is destroyed. The Order and the PI
--        are FROZEN — no competing claim, no mutation — until the claim ends.
--
--   2. the server route removes storage, with the bounded, fully-settled sweep.
--
--   3a. every object gone -> finalize_test_data_cleanup(token)
--        re-lock, re-validate, open the cleanup context, break the Order's
--        reference to the PI, delete the PI and its children, delete the Order,
--        complete the audit, reclaim the freed Order numbers, consume the claim.
--
--   3b. anything left  -> the claim STAYS. Rows are untouched, the record stays
--        frozen, and a retry re-claims it, removes what remains and finalizes.
--        release_test_data_cleanup(token) is the explicit way back, and the
--        route uses it only when NOTHING was removed.
--
-- WHY THE CLAIM IS THE AUTHORIZATION AT FINALIZE, AND NOT THE SETTINGS ROW.
-- Once step 2 has destroyed a file there is no way back: refusing to finalize
-- would leave precisely the corruption this design exists to prevent. So the
-- five gates are enforced at CLAIM time, when nothing has happened yet, and the
-- claim carries that authorization forward. A cleanup disabled between the two
-- steps therefore stops the NEXT claim and does not strand this one — and the
-- audit records that it completed under a claim taken earlier.
--
-- ═══ WHAT IS AND IS NOT WEAKENED ════════════════════════════════════════════
--
-- Neither foreign key is dropped, altered or made deferrable; both are fully
-- enforcing before and after. Three guards gain the SAME cleanup-context
-- exemption the Order, Order Request and payment guards have carried since
-- 20260705000000, and that context is transaction-local, unreachable by any
-- client role, and opened only inside finalize_test_data_cleanup() after every
-- check has passed again under locks.
--
-- ═══ WHAT THIS MIGRATION DOES NOT DO ════════════════════════════════════════
--
--   * It does not edit 20260915000000 or any earlier migration.
--   * It does not change normal PI deletion: begin/release/finalize
--     _order_submission_deletion and order_submission_deletable_statuses() are
--     untouched, so an approved PI is still absent from the ordinary path.
--   * It does not change final approval, the advance workflow, any payment rule,
--     or any RLS policy on a business table.
--   * It adds no new permission and no new client-writable table.

-- ═══ 1. The three guards gain the cleanup exemption ═════════════════════════
--
-- Each is reproduced from the migration that owns it, with the exemption added
-- as the FIRST statement and NOTHING else altered.

-- ── 1a. The PI provenance column on the Order (20260915000000 §2) ────────────

create or replace function public.prevent_order_source_submission_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.in_test_data_cleanup() then
    return new;
  end if;

  if old.source_order_submission_id is not null
     and new.source_order_submission_id is distinct from old.source_order_submission_id then
    raise exception
      'ORDER_SOURCE_SUBMISSION_IMMUTABLE: the PI an Order was created from cannot be changed once set'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.prevent_order_source_submission_change()
  from public, anon, authenticated;

comment on function public.prevent_order_source_submission_change() is
  'Freezes orders.source_order_submission_id once set, for every transaction except an authorized Test Data Cleanup finalization — which releases it only to break the mutual foreign key immediately before deleting both rows.';

-- ── 1b. Deleting the submission row (20260914000000 §5) ──────────────────────

create or replace function public.order_submissions_guard_delete()
returns trigger
language plpgsql
as $$
begin
  if public.order_submission_purge_in_progress(old.id) then
    return old;
  end if;
  if public.in_test_data_cleanup() then
    return old;
  end if;
  raise exception
    'ORDER_SUBMISSION_DELETE_DENIED: a PI submission is deleted only through finalize_order_submission_deletion()'
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_submissions_guard_delete()
  from public, anon, authenticated, service_role;

-- ── 1c. The submission's append-only trail (20260914000000 §5) ───────────────
--
-- These rows arrive by CASCADE from the submission delete, and a BEFORE DELETE
-- trigger fires on a cascade exactly as on a direct statement.

create or replace function public.order_submission_activity_guard_delete()
returns trigger
language plpgsql
as $$
begin
  if public.order_submission_purge_in_progress(old.submission_id) then
    return old;
  end if;
  if public.in_test_data_cleanup() then
    return old;
  end if;
  raise exception
    'ORDER_SUBMISSION_ACTIVITY_IMMUTABLE: PI submission history cannot be deleted'
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_submission_activity_guard_delete()
  from public, anon, authenticated, service_role;

-- ═══ 2. The claim ═══════════════════════════════════════════════════════════
--
-- A DURABLE row, not a transaction-local flag. That is the whole point: it has
-- to survive the gap between "the files are gone" and "the rows are gone",
-- including a lost response, a crashed request and a redeployed server.
--
-- It records the ENTIRE resolved chain as it stood when every gate passed, so a
-- retry finalizes the operation that was authorized rather than re-deriving a
-- possibly-different one — and finalization re-validates against the live rows
-- anyway, so a chain that has moved is refused rather than acted on.
--
-- claim_token is gen_random_uuid(): unguessable, single-use, and NEVER RETURNED
-- TO THE BROWSER. It lives inside one server route for the length of one
-- request, exactly as the PI deletion claim token does.

create table if not exists public.test_data_cleanup_claims (
  id                  uuid        primary key default gen_random_uuid(),
  claim_token         uuid        not null unique default gen_random_uuid(),

  root_type           text        not null,
  root_id             uuid        not null,
  root_number         text,

  -- The resolved chain, frozen at claim time.
  order_id            uuid,
  order_request_id    uuid,
  order_submission_id uuid,
  payment_ids         uuid[]      not null default '{}',
  chain               jsonb       not null default '{}'::jsonb,

  -- What the admin typed, carried to finalization so the audit is complete even
  -- if the two halves happen minutes apart.
  reason              text        not null,
  confirmation        text        not null,

  claimed_by          uuid        references public.users(id) on delete set null,
  claimed_by_email    text,
  claimed_at          timestamptz not null default now(),

  -- Storage, for the route. Read from the database, never from a browser.
  storage_prefix      text,

  -- Set when finalization completes. A claim with this set is CONSUMED: it
  -- blocks nothing and cannot delete anything a second time.
  finalized_at        timestamptz,
  audit_id            uuid        references public.test_data_cleanup_audit(id) on delete set null,
  result              jsonb       not null default '{}'::jsonb,

  constraint test_data_cleanup_claims_reason_not_blank check (btrim(reason) <> ''),
  constraint test_data_cleanup_claims_root_type_known
    check (root_type in ('order', 'order_request', 'payment'))
);

comment on table public.test_data_cleanup_claims is
  'A durable reservation over one Test Data Cleanup chain. Taken by begin_test_data_cleanup() after every gate passes, held while storage is removed, and consumed by finalize_test_data_cleanup(). Its existence is what makes "the files are gone but the rows are not" a recoverable state rather than silent corruption.';

-- ONE OPEN CLAIM PER ROOT, and one per Order and per PI. Three partial unique
-- indexes rather than one: a second admin must not be able to claim the same
-- Order through a different root type and race the first to the same rows.
create unique index if not exists test_data_cleanup_claims_open_root_uidx
  on public.test_data_cleanup_claims (root_type, root_id) where finalized_at is null;
create unique index if not exists test_data_cleanup_claims_open_order_uidx
  on public.test_data_cleanup_claims (order_id) where finalized_at is null and order_id is not null;
create unique index if not exists test_data_cleanup_claims_open_submission_uidx
  on public.test_data_cleanup_claims (order_submission_id)
  where finalized_at is null and order_submission_id is not null;

alter table public.test_data_cleanup_claims enable row level security;

-- Not client-readable and not client-writable. The token must never be
-- selectable from a browser, so there is no SELECT policy and no grant at all —
-- the SECURITY DEFINER functions below run as the owner and are unaffected.
revoke all on table public.test_data_cleanup_claims from public, anon, authenticated;

-- ═══ 3. A claimed record is frozen ══════════════════════════════════════════
--
-- WHY THIS IS NEEDED AND NOT MERELY TIDY. Between the claim and the finalize the
-- files may already be gone. If the Order could be amended, cancelled or
-- re-linked in that window, finalization would either destroy a record somebody
-- had just changed, or refuse and strand it. Freezing is what makes the window
-- safe to have.
--
-- WHAT IS STILL ALLOWED: the finalization itself, which runs inside the cleanup
-- context. Nothing else about the row may move.

create or replace function public.test_data_cleanup_claim_open(p_order uuid, p_submission uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.test_data_cleanup_claims c
    where c.finalized_at is null
      and (
        (p_order is not null and c.order_id = p_order)
        or (p_submission is not null and c.order_submission_id = p_submission)
      )
  );
$$;

revoke execute on function public.test_data_cleanup_claim_open(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.orders_guard_cleanup_claim()
returns trigger
language plpgsql
as $$
begin
  if public.in_test_data_cleanup() then
    return new;
  end if;
  if public.test_data_cleanup_claim_open(old.id, null) then
    raise exception
      'ORDER_CLEANUP_CLAIMED: Order % is reserved for Test Data Cleanup and cannot be changed',
      old.display_number
      using errcode = '55P03';
  end if;
  return new;
end;
$$;

revoke execute on function public.orders_guard_cleanup_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists orders_guard_cleanup_claim on public.orders;
create trigger orders_guard_cleanup_claim
  before update on public.orders
  for each row execute function public.orders_guard_cleanup_claim();

create or replace function public.order_submissions_guard_cleanup_claim()
returns trigger
language plpgsql
as $$
begin
  if public.in_test_data_cleanup() then
    return new;
  end if;
  if public.test_data_cleanup_claim_open(null, old.id) then
    raise exception
      'ORDER_SUBMISSION_CLEANUP_CLAIMED: this PI is reserved for Test Data Cleanup and cannot be changed'
      using errcode = '55P03';
  end if;
  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_cleanup_claim()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_guard_cleanup_claim on public.order_submissions;
create trigger order_submissions_guard_cleanup_claim
  before update on public.order_submissions
  for each row execute function public.order_submissions_guard_cleanup_claim();

-- ═══ 4. Chain resolution learns about the PI ════════════════════════════════
--
-- Restated from 20260706000000 §5 with the PI branch added. Every existing
-- behaviour is preserved: the three root types, the payment-root retention rule,
-- the all-or-nothing eligibility rule, the proof-attachment storage_paths array
-- and every existing key of the returned object.
--
-- WHAT IS ADDED: order_submission_id, submission_storage_prefix, one to_delete
-- entry of type 'order_submission', and the four PI row counts.
--
-- WHY THE PI PREFIX IS A SEPARATE KEY. storage_paths is consumed as PAYMENT-PROOF
-- keys and removed from the payment-proofs bucket. PI files live in order-files
-- under a different policy. Folding them together would send one bucket's keys
-- to the other, which fails silently in the direction that matters.
--
-- CONSISTENCY IS A BLOCKER, NOT A REPAIR. A provenance pair that disagrees is a
-- fact somebody needs to look at, not something a bulk delete should paper over.

create or replace function public.resolve_test_data_cleanup_chain(
  p_root_type text,
  p_root_id   uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_order_id      uuid;
  v_request_id    uuid;
  v_submission_id uuid;
  v_sub_order_id  uuid;
  v_sub_status    text;
  v_payments      uuid[] := '{}';
  v_root_num      text;
  v_delete        jsonb := '[]'::jsonb;
  v_retain        jsonb := '[]'::jsonb;
  v_block         jsonb := '[]'::jsonb;
  v_paths         jsonb := '[]'::jsonb;
  v_prefix        text;
  v_order_is_test boolean;
  v_counts        jsonb;
begin
  if p_root_type not in ('order', 'order_request', 'payment') then
    raise exception 'CLEANUP_ROOT_TYPE_INVALID: Unknown record type %', p_root_type
      using errcode = 'P0001';
  end if;

  if p_root_type = 'order' then
    select o.id, o.source_order_request_id, o.display_number
      into v_order_id, v_request_id, v_root_num
    from public.orders o where o.id = p_root_id;

  elsif p_root_type = 'order_request' then
    select r.id, r.converted_order_id, r.request_number
      into v_request_id, v_order_id, v_root_num
    from public.order_requests r where r.id = p_root_id;

  else
    select f.request_number into v_root_num
    from public.finance_payment_requests f where f.id = p_root_id;

    if v_root_num is not null then
      v_payments := array[p_root_id];
    end if;
  end if;

  if v_root_num is null then
    raise exception 'CLEANUP_ROOT_NOT_FOUND: That record no longer exists'
      using errcode = 'P0002';
  end if;

  if p_root_type in ('order', 'order_request') then
    select coalesce(array_agg(f.id), '{}')
      into v_payments
    from public.finance_payment_requests f
    where (v_order_id   is not null and f.order_id         = v_order_id)
       or (v_request_id is not null and f.order_request_id = v_request_id);
  end if;

  -- ── The PI this Order came from ───────────────────────────────────────────
  -- Read from the ORDER. An Order created by converting an Order Request carries
  -- no PI and this resolves to null, which is the honest answer.
  if v_order_id is not null then
    select o.source_order_submission_id, o.is_test_data
      into v_submission_id, v_order_is_test
    from public.orders o where o.id = v_order_id;
  end if;

  if v_submission_id is not null then
    select s.order_id, s.status
      into v_sub_order_id, v_sub_status
    from public.order_submissions s where s.id = v_submission_id;

    v_prefix := 'submissions/' || v_submission_id::text || '/';
  end if;

  select coalesce(jsonb_agg(x order by x->>'type', x->>'number'), '[]'::jsonb)
    into v_delete
  from (
    select jsonb_build_object(
             'type', 'order', 'id', o.id, 'number', o.display_number,
             'status', o.status, 'label', o.client_name, 'is_test_data', o.is_test_data) as x
    from public.orders o where o.id = v_order_id
    union all
    select jsonb_build_object(
             'type', 'order_request', 'id', r.id, 'number', r.request_number,
             'status', r.status, 'label', r.client_name, 'is_test_data', r.is_test_data)
    from public.order_requests r where r.id = v_request_id
    union all
    select jsonb_build_object(
             'type', 'payment', 'id', f.id, 'number', f.request_number,
             'status', f.status, 'label', f.client_name, 'amount', f.amount,
             'is_test_data', f.is_test_data)
    from public.finance_payment_requests f where f.id = any(v_payments)
    union all
    -- THE PI. order_submissions has NO is_test_data column and deliberately does
    -- not gain one: an approved PI's only reason to exist is the Order it
    -- produced, the link is one-to-one in both directions and immutable, so the
    -- classification is INHERITED — and is only trustworthy because the pair is
    -- verified immediately below.
    select jsonb_build_object(
             'type', 'order_submission', 'id', s.id, 'number', null,
             'status', s.status, 'label', s.client_name,
             'is_test_data', coalesce(v_order_is_test, false),
             'storage_prefix', v_prefix)
    from public.order_submissions s where s.id = v_submission_id
  ) t;

  select coalesce(jsonb_agg(x), '[]'::jsonb)
    into v_block
  from jsonb_array_elements(v_delete) x
  where not (x->>'is_test_data')::boolean;

  -- ── The provenance pair must name each other ──────────────────────────────
  if v_submission_id is not null and v_sub_order_id is null then
    v_block := v_block || jsonb_build_array(jsonb_build_object(
      'type', 'order_submission', 'id', v_submission_id,
      'number', null, 'status', coalesce(v_sub_status, 'missing'),
      'is_test_data', false,
      'reason', 'the PI this Order names does not exist, or is not linked back to any Order'));
  elsif v_submission_id is not null and v_sub_order_id is distinct from v_order_id then
    v_block := v_block || jsonb_build_array(jsonb_build_object(
      'type', 'order_submission', 'id', v_submission_id,
      'number', null, 'status', coalesce(v_sub_status, 'unknown'),
      'is_test_data', false,
      'reason', 'the PI this Order names is linked to a different Order'));
  end if;

  if p_root_type = 'payment' then
    select coalesce(jsonb_agg(x order by x->>'type'), '[]'::jsonb)
      into v_retain
    from (
      select jsonb_build_object('type','order','id',o.id,'number',o.display_number,
                                'status',o.status,'is_test_data',o.is_test_data) as x
      from public.orders o
      join public.finance_payment_requests f on f.order_id = o.id
      where f.id = p_root_id
      union all
      select jsonb_build_object('type','order_request','id',r.id,'number',r.request_number,
                                'status',r.status,'is_test_data',r.is_test_data)
      from public.order_requests r
      join public.finance_payment_requests f on f.order_request_id = r.id
      where f.id = p_root_id
    ) t;

    v_block := v_block || (
      select coalesce(jsonb_agg(x), '[]'::jsonb)
      from jsonb_array_elements(v_retain) x
      where not (x->>'is_test_data')::boolean
    );
  end if;

  -- storage_paths is UNCHANGED: payment-proof object keys, and nothing else.
  select coalesce(jsonb_agg(a.storage_path order by a.storage_path), '[]'::jsonb)
    into v_paths
  from public.payment_proof_attachments a
  where a.payment_request_id = any(v_payments);

  v_counts := jsonb_build_object(
    'orders',                   (select count(*) from public.orders where id = v_order_id),
    'order_requests',           (select count(*) from public.order_requests where id = v_request_id),
    'payment_requests',         coalesce(array_length(v_payments, 1), 0),
    'order_activity_log',       (select count(*) from public.order_activity_log where order_id = v_order_id),
    'order_request_activity',   (select count(*) from public.order_request_activity where order_request_id = v_request_id),
    'payment_activity',         (select count(*) from public.finance_payment_request_activity_log where payment_request_id = any(v_payments)),
    'proof_attachments',        (select count(*) from public.payment_proof_attachments where payment_request_id = any(v_payments)),
    'notifications',            (select count(*) from public.notifications
                                  where entity_id in (
                                    select unnest(array_remove(array[v_order_id, v_request_id], null))
                                    union all select unnest(v_payments))
                                    and (type::text like 'order%' or type::text like 'finance%')),
    'order_submissions',            (select count(*) from public.order_submissions where id = v_submission_id),
    'order_submission_items',       (select count(*) from public.order_submission_items where submission_id = v_submission_id),
    'order_submission_item_images', (select count(*) from public.order_submission_item_images where submission_id = v_submission_id),
    'order_submission_activity',    (select count(*) from public.order_submission_activity where submission_id = v_submission_id)
  );

  return jsonb_build_object(
    'root_type',       p_root_type,
    'root_id',         p_root_id,
    'root_number',     v_root_num,
    'order_id',        v_order_id,
    'order_request_id',v_request_id,
    'payment_ids',     to_jsonb(v_payments),
    'order_submission_id',       v_submission_id,
    'submission_storage_prefix', v_prefix,
    'to_delete',       v_delete,
    'to_retain',       v_retain,
    'blocking',        v_block,
    'storage_paths',   v_paths,
    'counts',          v_counts,
    'eligible',        jsonb_array_length(v_block) = 0
  );
end;
$$;

revoke execute on function public.resolve_test_data_cleanup_chain(text, uuid)
  from public, anon, authenticated;

-- ═══ 5. The PI's storage keys, for the route ════════════════════════════════
--
-- READ FROM THE DATABASE, and only for a submission named by an OPEN CLAIM. A
-- caller cannot point this at a live PI by guessing a uuid: without a claim it
-- answers nothing, and a claim can only exist for a chain that passed every gate.

create or replace function public.test_cleanup_claim_storage(p_claim_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim public.test_data_cleanup_claims%rowtype;
  v_sub   public.order_submissions%rowtype;
  v_paths text[];
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'Only an admin may read cleanup storage' using errcode = '42501';
  end if;

  select * into v_claim
  from public.test_data_cleanup_claims
  where claim_token = p_claim_token;

  if not found then
    raise exception 'CLEANUP_CLAIM_INVALID: this cleanup claim is not valid'
      using errcode = '42501';
  end if;

  if v_claim.order_submission_id is null then
    return jsonb_build_object('found', false, 'reason', 'no_submission');
  end if;

  select * into v_sub
  from public.order_submissions where id = v_claim.order_submission_id;

  if not found then
    -- Already erased by a finalization that committed. Nothing to remove, and a
    -- retry must not treat that as an error.
    return jsonb_build_object('found', false, 'reason', 'already_deleted');
  end if;

  select coalesce(array_agg(path order by path), '{}')
    into v_paths
  from (
    select v_sub.source_workbook_path as path
    where coalesce(btrim(v_sub.source_workbook_path), '') <> ''
    union
    select m.storage_path
    from public.order_submission_item_images m
    where m.submission_id = v_sub.id
    union
    -- The pre-20260909000000 per-item column. Almost always null now, and read
    -- anyway: a key a row still names is a key that must go.
    select i.image_storage_path
    from public.order_submission_items i
    where i.submission_id = v_sub.id
      and coalesce(btrim(i.image_storage_path), '') <> ''
  ) t
  where path like ('submissions/' || v_sub.id::text || '/%');

  return jsonb_build_object(
    'found',          true,
    'submission_id',  v_sub.id,
    'storage_prefix', 'submissions/' || v_sub.id::text || '/',
    'storage_paths',  to_jsonb(v_paths)
  );
end;
$$;

comment on function public.test_cleanup_claim_storage(uuid) is
  'The storage keys of the PI named by an OPEN cleanup claim, read from the database. Requires the claim token, which never reaches a browser. Reserves nothing and deletes nothing.';

revoke execute on function public.test_cleanup_claim_storage(uuid) from public, anon;
grant  execute on function public.test_cleanup_claim_storage(uuid) to authenticated;

-- ═══ 6. begin — every gate, then the claim ══════════════════════════════════
--
-- NOTHING IS DESTROYED HERE. This proves the operation may happen, freezes the
-- records so nothing can contradict it, and writes the permanent audit row. If
-- any check fails, no claim is taken and no object has been touched.
--
-- RE-CLAIM IS THE RETRY PATH. An admin who already holds an open claim on this
-- root gets THAT CLAIM BACK rather than a refusal — which is what makes a lost
-- response, a crashed request and a partial storage failure all recoverable by
-- simply asking again. A DIFFERENT admin is refused: two people must not be
-- deleting the same chain at once.

create or replace function public.begin_test_data_cleanup(
  p_root_type    text,
  p_root_id      uuid,
  p_reason       text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_email      text;
  v_set        public.test_data_cleanup_settings%rowtype;
  v_chain      jsonb;
  v_order      uuid;
  v_request    uuid;
  v_submission uuid;
  v_payments   uuid[];
  v_existing   public.test_data_cleanup_claims%rowtype;
  v_claim      public.test_data_cleanup_claims%rowtype;
  v_audit      uuid;
begin
  -- ── Gate 1: admin ─────────────────────────────────────────────────────────
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select u.email into v_email
  from public.users u where u.id = v_actor and u.role = 'admin';

  if v_email is null then
    raise exception 'Only an admin may run Test Data Cleanup' using errcode = '42501';
  end if;

  -- ── Gate 2: enabled. Locked, so a concurrent permanent-disable cannot slip
  --    past between the check and the claim.
  select * into v_set from public.test_data_cleanup_settings where id = true for update;

  if not found or v_set.permanently_disabled or not v_set.enabled then
    raise exception
      'CLEANUP_DISABLED: Test Data Cleanup has been permanently disabled. Final Orders and bank payment history cannot be deleted.'
      using errcode = '42501';
  end if;

  -- ── Gate 3: a reason ──────────────────────────────────────────────────────
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'CLEANUP_REASON_REQUIRED: Enter why this test data is being removed'
      using errcode = 'P0001';
  end if;

  -- ── Gate 4: the typed words ───────────────────────────────────────────────
  if coalesce(btrim(p_confirmation), '') <> 'DELETE TEST DATA' then
    raise exception 'CLEANUP_CONFIRMATION_INVALID: Type DELETE TEST DATA exactly to confirm'
      using errcode = 'P0001';
  end if;

  -- ── An open claim on this root: hand it back, or refuse ───────────────────
  select * into v_existing
  from public.test_data_cleanup_claims
  where root_type = p_root_type and root_id = p_root_id and finalized_at is null
  for update;

  if found then
    if v_existing.claimed_by is distinct from v_actor then
      raise exception
        'CLEANUP_CLAIMED_BY_OTHER: another administrator is already cleaning up this record'
        using errcode = '55P03';
    end if;
    -- THE RETRY. The chain is not re-resolved and the audit is not rewritten:
    -- this is the same authorized operation being resumed, and re-deriving it
    -- now — possibly after its files are already gone — would be a different
    -- operation wearing the same claim.
    return jsonb_build_object(
      'claim_token',   v_existing.claim_token,
      'resumed',       true,
      'root_type',     v_existing.root_type,
      'root_number',   v_existing.root_number,
      'order_id',              v_existing.order_id,
      'order_request_id',      v_existing.order_request_id,
      'order_submission_id',   v_existing.order_submission_id,
      'storage_prefix',        v_existing.storage_prefix,
      'chain',                 v_existing.chain,
      'audit_id',              v_existing.audit_id
    );
  end if;

  -- ── Resolve, then LOCK, then re-resolve ───────────────────────────────────
  v_chain := public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);

  v_order      := nullif(v_chain->>'order_id', '')::uuid;
  v_request    := nullif(v_chain->>'order_request_id', '')::uuid;
  v_submission := nullif(v_chain->>'order_submission_id', '')::uuid;

  select coalesce(array_agg(value::uuid), '{}') into v_payments
  from jsonb_array_elements_text(v_chain->'payment_ids');

  perform 1 from public.orders            where id = v_order      for update;
  perform 1 from public.order_requests    where id = v_request    for update;
  perform 1 from public.order_submissions where id = v_submission for update;
  perform 1 from public.finance_payment_requests
   where id = any(v_payments) order by id for update;

  v_chain := public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);

  -- ── Gate 5: every record in the chain is test data ────────────────────────
  if not (v_chain->>'eligible')::boolean then
    raise exception
      'CLEANUP_NOT_ELIGIBLE: This chain contains records that are not test data and cannot be removed: %',
      (select string_agg(coalesce(x->>'number', x->>'reason', x->>'id'), ', ')
         from jsonb_array_elements(v_chain->'blocking') x)
      using errcode = '42501';
  end if;

  v_order      := nullif(v_chain->>'order_id', '')::uuid;
  v_request    := nullif(v_chain->>'order_request_id', '')::uuid;
  v_submission := nullif(v_chain->>'order_submission_id', '')::uuid;
  select coalesce(array_agg(value::uuid), '{}') into v_payments
  from jsonb_array_elements_text(v_chain->'payment_ids');

  -- ── The provenance pair, asserted where the claim is taken ────────────────
  if v_submission is not null then
    if not exists (
      select 1
      from public.order_submissions s
      join public.orders o on o.id = s.order_id
      where s.id = v_submission
        and o.id = v_order
        and o.source_order_submission_id = s.id
        and o.is_test_data
    ) then
      raise exception
        'CLEANUP_PROVENANCE_MISMATCH: the PI and the Order do not name each other, or the Order is not test data'
        using errcode = '42501';
    end if;
  end if;

  -- ── The permanent audit, written BEFORE anything can be destroyed ─────────
  --
  -- At CLAIM time, not at finalization: from the moment this returns, files may
  -- start disappearing, and an operation that destroys data must be on the
  -- record before it does so — including one that never reaches finalization.
  -- `result` stays empty until it completes, which is how an unfinished cleanup
  -- is told apart from a finished one.
  insert into public.test_data_cleanup_audit (
    performed_by, performed_by_email, reason, confirmation,
    root_type, root_id, root_number,
    deleted_records, table_counts, storage_paths
  )
  values (
    v_actor, v_email, btrim(p_reason), 'DELETE TEST DATA',
    p_root_type, p_root_id, v_chain->>'root_number',
    v_chain->'to_delete', v_chain->'counts', v_chain->'storage_paths'
  )
  returning id into v_audit;

  -- ── The claim ─────────────────────────────────────────────────────────────
  insert into public.test_data_cleanup_claims (
    root_type, root_id, root_number,
    order_id, order_request_id, order_submission_id, payment_ids, chain,
    reason, confirmation, claimed_by, claimed_by_email,
    storage_prefix, audit_id
  )
  values (
    p_root_type, p_root_id, v_chain->>'root_number',
    v_order, v_request, v_submission, v_payments, v_chain,
    btrim(p_reason), 'DELETE TEST DATA', v_actor, v_email,
    v_chain->>'submission_storage_prefix', v_audit
  )
  returning * into v_claim;

  return jsonb_build_object(
    'claim_token',         v_claim.claim_token,
    'resumed',             false,
    'root_type',           p_root_type,
    'root_number',         v_chain->>'root_number',
    'order_id',            v_order,
    'order_request_id',    v_request,
    'order_submission_id', v_submission,
    'storage_prefix',      v_chain->>'submission_storage_prefix',
    'chain',               v_chain,
    'audit_id',            v_audit
  );
end;
$$;

comment on function public.begin_test_data_cleanup(text, uuid, text, text) is
  'Admin-only. Validates admin, the enabled setting, the reason, the typed confirmation, the whole chain''s test-data eligibility and the PI/Order provenance pair; locks the chain; writes the permanent audit row; and takes a durable claim. Destroys nothing. Returns the same claim to the same admin on a retry, and refuses a competing one.';

revoke execute on function public.begin_test_data_cleanup(text, uuid, text, text) from public, anon;
grant  execute on function public.begin_test_data_cleanup(text, uuid, text, text) to authenticated;

-- ═══ 7. release — give the records back, whole ══════════════════════════════
--
-- Only correct while NOTHING has been destroyed. The route calls it in exactly
-- that case; once a single object has gone the claim is kept instead, because
-- unfreezing a record whose files are missing is the corruption this design
-- exists to prevent.

create or replace function public.release_test_data_cleanup(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.test_data_cleanup_claims%rowtype;
begin
  if not exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'
  ) then
    raise exception 'Only an admin may release a cleanup claim' using errcode = '42501';
  end if;

  select * into v_claim
  from public.test_data_cleanup_claims
  where claim_token = p_claim_token
  for update;

  if not found then
    raise exception 'CLEANUP_CLAIM_INVALID: this cleanup claim is not valid' using errcode = '42501';
  end if;

  if v_claim.finalized_at is not null then
    -- Already consumed. Releasing it would be a no-op with a misleading answer.
    return jsonb_build_object('released', false, 'reason', 'already_finalized');
  end if;

  delete from public.test_data_cleanup_claims where id = v_claim.id;

  -- The audit row STAYS. A cleanup that was authorized and then abandoned is a
  -- thing that happened, and erasing the record of it would be the one edit this
  -- table exists to make impossible.
  update public.test_data_cleanup_audit
     set result = jsonb_build_object('released', true, 'released_at', now())
   where id = v_claim.audit_id and result = '{}'::jsonb;

  return jsonb_build_object('released', true, 'root_number', v_claim.root_number);
end;
$$;

comment on function public.release_test_data_cleanup(uuid) is
  'Admin-only. Gives back a cleanup claim under which nothing was destroyed, unfreezing the records. The permanent audit row survives, marked released. Never call this once a storage object has been removed.';

revoke execute on function public.release_test_data_cleanup(uuid) from public, anon;
grant  execute on function public.release_test_data_cleanup(uuid) to authenticated;

-- ═══ 8. finalize — the point of no return ═══════════════════════════════════
--
-- Reached only with the claim that froze the records, and only once the route
-- has confirmed every storage object is gone.
--
-- IDEMPOTENT. A claim that has already been finalized returns its recorded
-- result and deletes nothing a second time — which is what makes a lost response
-- safe to retry.
--
-- IT DOES NOT RE-CHECK THE ENABLED SETTING, deliberately. See the header: the
-- five gates were enforced at claim time, when nothing had happened; by now the
-- files are gone, and refusing would leave the corruption this whole design
-- exists to prevent. It DOES re-check everything that can still be made whole —
-- the chain's eligibility and the provenance pair — under fresh locks.

create or replace function public.finalize_test_data_cleanup(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_claim      public.test_data_cleanup_claims%rowtype;
  v_chain      jsonb;
  v_order      uuid;
  v_request    uuid;
  v_submission uuid;
  v_payments   uuid[];
  v_ids        uuid[];
  v_freed      bigint[];
  v_next       bigint;
  v_highest    bigint;
  v_reclaimed  bigint := 0;
  v_result     jsonb;
  v_n_notif    integer := 0;
  v_n_pay      integer := 0;
  v_n_req      integer := 0;
  v_n_ord      integer := 0;
  v_n_sub      integer := 0;
  v_n_items    integer := 0;
  v_n_images   integer := 0;
  v_n_events   integer := 0;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.users u where u.id = v_actor and u.role = 'admin'
  ) then
    raise exception 'Only an admin may run Test Data Cleanup' using errcode = '42501';
  end if;

  select * into v_claim
  from public.test_data_cleanup_claims
  where claim_token = p_claim_token
  for update;

  if not found then
    raise exception 'CLEANUP_CLAIM_INVALID: this cleanup claim is not valid' using errcode = '42501';
  end if;

  -- ── Already done: answer, do not act ──────────────────────────────────────
  if v_claim.finalized_at is not null then
    return v_claim.result || jsonb_build_object('already_finalized', true);
  end if;

  v_order      := v_claim.order_id;
  v_request    := v_claim.order_request_id;
  v_submission := v_claim.order_submission_id;
  v_payments   := v_claim.payment_ids;

  -- ── Re-lock the claimed rows ──────────────────────────────────────────────
  perform 1 from public.orders            where id = v_order      for update;
  perform 1 from public.order_requests    where id = v_request    for update;
  perform 1 from public.order_submissions where id = v_submission for update;
  perform 1 from public.finance_payment_requests
   where id = any(v_payments) order by id for update;

  -- ── Re-validate against the LIVE rows, not the snapshot ───────────────────
  --
  -- The claim froze these records, so nothing should have moved. Checked anyway:
  -- "frozen" is a claim about triggers that have not been edited yet, and this
  -- is the last moment anything can be refused.
  v_chain := public.resolve_test_data_cleanup_chain(v_claim.root_type, v_claim.root_id);

  if not (v_chain->>'eligible')::boolean then
    raise exception
      'CLEANUP_NOT_ELIGIBLE: This chain contains records that are not test data and cannot be removed: %',
      (select string_agg(coalesce(x->>'number', x->>'reason', x->>'id'), ', ')
         from jsonb_array_elements(v_chain->'blocking') x)
      using errcode = '42501';
  end if;

  -- The chain must still be the one that was claimed. A different shape means
  -- the world moved despite the freeze, and this call is not authorized for it.
  if nullif(v_chain->>'order_id', '')::uuid            is distinct from v_order
     or nullif(v_chain->>'order_request_id', '')::uuid is distinct from v_request
     or nullif(v_chain->>'order_submission_id', '')::uuid is distinct from v_submission then
    raise exception
      'CLEANUP_CHAIN_CHANGED: this chain is no longer the one that was claimed'
      using errcode = '42501';
  end if;

  if v_submission is not null then
    if not exists (
      select 1
      from public.order_submissions s
      join public.orders o on o.id = s.order_id
      where s.id = v_submission
        and o.id = v_order
        and o.source_order_submission_id = s.id
        and o.is_test_data
    ) then
      raise exception
        'CLEANUP_PROVENANCE_MISMATCH: the PI and the Order do not name each other, or the Order is not test data'
        using errcode = '42501';
    end if;
  end if;

  -- The numbers about to be freed, read BEFORE the Order goes.
  select coalesce(array_agg(o.display_number::bigint), '{}')
    into v_freed
  from public.orders o
  where o.id = v_order and o.display_number ~ '^[0-9]+$';

  -- ── Stand the production guards down for this transaction only ────────────
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);

  v_ids := array_remove(array[v_order, v_request], null) || v_payments;

  -- 1. Notifications have no foreign key, so nothing removes them implicitly.
  delete from public.notifications
   where entity_id = any(v_ids)
     and (type::text like 'order%' or type::text like 'finance%');
  get diagnostics v_n_notif = row_count;

  -- 2. Payments (proofs and activity cascade).
  delete from public.finance_payment_requests where id = any(v_payments);
  get diagnostics v_n_pay = row_count;

  -- 3. Release the OLD provenance reference so that mutual FK opens.
  if v_order is not null and v_request is not null then
    update public.orders
       set source_order_request_id = null,
           source_request_number   = null
     where id = v_order;
  end if;

  -- 4. The request (order_request_activity cascades).
  delete from public.order_requests where id = v_request;
  get diagnostics v_n_req = row_count;

  -- ── 4a. THE PI PAIR — defect A ────────────────────────────────────────────
  -- Release the Order's reference, delete the PI, then (step 5) the Order. Both
  -- directions of the mutual foreign key hold at every moment.
  if v_submission is not null then
    select
      (select count(*) from public.order_submission_items       where submission_id = v_submission),
      (select count(*) from public.order_submission_item_images where submission_id = v_submission),
      (select count(*) from public.order_submission_activity    where submission_id = v_submission)
      into v_n_items, v_n_images, v_n_events;

    update public.orders
       set source_order_submission_id = null
     where id = v_order;

    delete from public.order_submissions where id = v_submission;
    get diagnostics v_n_sub = row_count;
  end if;

  -- 5. The Order (order_activity_log cascades).
  delete from public.orders where id = v_order;
  get diagnostics v_n_ord = row_count;

  -- ── 6. Give back the Order numbers this cleanup actually freed ────────────
  --
  -- THE RULE, AND WHY IT IS THIS NARROW. 20260703000000 makes the next Confirmed
  -- Order number an ADMIN DECISION, and a cleanup must not quietly overrule one:
  -- an administrator who deliberately set the cycle to 1000 has said something,
  -- and deleting a test Order is not a reason to unsay it.
  --
  -- So only a number this cleanup freed FROM THE TOP OF THE RANGE is reclaimed,
  -- by walking down while the number immediately below the cycle is one we just
  -- deleted. Deleting the only Order, 0001, therefore returns the cycle to 1 and
  -- 0001 is genuinely reusable with no manual repair. Deleting 0025 while 0050
  -- still exists changes nothing, because 0025 is not below the cycle.
  --
  -- It NEVER advances the cycle and never takes it below the highest surviving
  -- Order + 1 — the same invariant allocate_confirmed_order_number() enforces.
  if array_length(v_freed, 1) > 0 then
    select c.next_number into v_next
    from public.order_number_cycle c where c.id = true for update;

    select coalesce(max(o.display_number::bigint), 0) into v_highest
    from public.orders o where o.display_number ~ '^[0-9]+$';

    while v_next > greatest(v_highest + 1, 1)
          and (v_next - 1) = any (v_freed)
    loop
      v_next := v_next - 1;
      v_reclaimed := v_reclaimed + 1;
    end loop;

    if v_reclaimed > 0 then
      -- configured_at / configured_by are NOT touched: they record the last
      -- ADMIN decision, and giving back a number this cleanup freed is not one.
      update public.order_number_cycle set next_number = v_next where id = true;
    end if;
  end if;

  v_result := jsonb_build_object(
    'notifications',    v_n_notif,
    'payment_requests', v_n_pay,
    'order_requests',   v_n_req,
    'orders',           v_n_ord,
    'order_submissions',            v_n_sub,
    'order_submission_items',       v_n_items,
    'order_submission_item_images', v_n_images,
    'order_submission_activity',    v_n_events,
    'order_numbers_reclaimed',      v_reclaimed,
    'submission_storage_prefix',    v_claim.storage_prefix
  );

  update public.test_data_cleanup_audit
     set result = v_result
   where id = v_claim.audit_id;

  -- ── 7. Consume the claim ──────────────────────────────────────────────────
  --
  -- Kept, not deleted: it is the record that this chain was cleaned under this
  -- token, and it is what makes a repeated finalize answer instead of act.
  update public.test_data_cleanup_claims
     set finalized_at = now(), result = v_result
   where id = v_claim.id;

  return jsonb_build_object(
    'audit_id',        v_claim.audit_id,
    'root_type',       v_claim.root_type,
    'root_number',     v_claim.root_number,
    'deleted',         v_result,
    'deleted_records', v_claim.chain->'to_delete',
    'retained',        v_claim.chain->'to_retain',
    'storage_paths',   v_claim.chain->'storage_paths',
    'order_submission_id',       v_submission,
    'submission_storage_prefix', v_claim.storage_prefix,
    'already_finalized', false
  );
end;
$$;

comment on function public.finalize_test_data_cleanup(uuid) is
  'Admin-only. Completes a claimed Test Data Cleanup: re-locks and re-validates the chain and the PI/Order provenance pair, then deletes the PI before the Order so the mutual foreign key holds throughout, completes the permanent audit, gives back only the Order numbers this cleanup freed from the top of the range, and consumes the claim. Idempotent: a finalized claim answers with its recorded result.';

revoke execute on function public.finalize_test_data_cleanup(uuid) from public, anon;
grant  execute on function public.finalize_test_data_cleanup(uuid) to authenticated;

-- ═══ 9. The old one-shot door is closed ═════════════════════════════════════
--
-- execute_test_data_cleanup() deleted rows in a call of its own, with storage
-- removal orchestrated separately by the browser. That is defect B, and it
-- cannot be made safe by adding checks to it: the unsafety is the SHAPE — two
-- destructive steps with nothing durable joining them.
--
-- It is not dropped, because DROP would discard its grants and any deployed
-- client calling it would get a confusing "function does not exist". Instead it
-- refuses, by name, and says where to go. The admin page calls the route.

create or replace function public.execute_test_data_cleanup(
  p_root_type    text,
  p_root_id      uuid,
  p_reason       text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    'CLEANUP_USE_CLAIM_PROTOCOL: Test Data Cleanup now runs as begin_test_data_cleanup() -> storage removal -> finalize_test_data_cleanup(), through /api/orders/test-data-cleanup. A single-call deletion cannot keep storage and rows consistent.'
    using errcode = '42501';
end;
$$;

comment on function public.execute_test_data_cleanup(text, uuid, text, text) is
  'RETIRED. Superseded by the claim protocol: begin_test_data_cleanup() -> storage removal -> finalize_test_data_cleanup(). Raises CLEANUP_USE_CLAIM_PROTOCOL. Kept rather than dropped so a stale client gets a clear message instead of a missing function.';

revoke execute on function public.execute_test_data_cleanup(text, uuid, text, text) from public, anon;
grant  execute on function public.execute_test_data_cleanup(text, uuid, text, text) to authenticated;

-- ═══ 10. Assertions ═════════════════════════════════════════════════════════

do $$
declare
  v_def text;
  v_bad text;
begin
  -- ── The three exemptions are present and still refuse everybody else ──
  for v_bad in select unnest(array[
      'prevent_order_source_submission_change',
      'order_submissions_guard_delete',
      'order_submission_activity_guard_delete'
    ])
  loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_bad;

    if v_def is null then raise exception 'guard % is missing', v_bad; end if;
    if v_def not like '%in_test_data_cleanup()%' then
      raise exception 'guard % did not gain the cleanup exemption', v_bad;
    end if;
    if v_def not like '%raise exception%' then
      raise exception 'guard % no longer refuses anything', v_bad;
    end if;
  end loop;

  -- The ordinary PI purge door survives.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'order_submissions_guard_delete';
  if v_def not like '%order_submission_purge_in_progress%' then
    raise exception 'the ordinary PI purge path was removed from the delete guard';
  end if;

  -- ── The claim table is closed to every client role ──
  select string_agg(privilege_type, ', ') into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'test_data_cleanup_claims'
    and grantee in ('anon', 'authenticated');
  if v_bad is not null then
    raise exception 'test_data_cleanup_claims is reachable by a client role: %', v_bad;
  end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'test_data_cleanup_claims' and c.relrowsecurity
  ) then
    raise exception 'RLS is not enabled on test_data_cleanup_claims';
  end if;

  -- ── One open claim per root, per Order and per PI ──
  for v_bad in select unnest(array[
      'test_data_cleanup_claims_open_root_uidx',
      'test_data_cleanup_claims_open_order_uidx',
      'test_data_cleanup_claims_open_submission_uidx'
    ])
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_bad
    ) then
      raise exception 'the competing-claim index % is missing', v_bad;
    end if;
  end loop;

  -- ── The freeze is attached ──
  for v_bad in select unnest(array[
      'orders_guard_cleanup_claim', 'order_submissions_guard_cleanup_claim'
    ])
  loop
    if not exists (
      select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where t.tgname = v_bad and not t.tgisinternal
    ) then
      raise exception 'the claim freeze trigger % is not attached', v_bad;
    end if;
  end loop;

  -- ── The cleanup context is still unreachable from any client ──
  if has_function_privilege('authenticated', 'public.in_test_data_cleanup()', 'EXECUTE')
     or has_function_privilege('anon', 'public.in_test_data_cleanup()', 'EXECUTE') then
    raise exception 'in_test_data_cleanup is executable by a client role';
  end if;

  -- ── Neither foreign key was weakened ──
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_submissions_order_id_fkey'
      and confupdtype = 'a' and confdeltype = 'a'
  ) then
    raise exception 'order_submissions.order_id is no longer a NO ACTION foreign key';
  end if;
  if not exists (
    select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
    where t.relname = 'orders' and c.contype = 'f'
      and pg_get_constraintdef(c.oid) like '%source_order_submission_id%'
      and pg_get_constraintdef(c.oid) not like '%ON DELETE%'
  ) then
    raise exception 'orders.source_order_submission_id is no longer a NO ACTION foreign key';
  end if;

  for v_bad in select unnest(array[
      'order_submissions_order_id_key', 'orders_source_order_submission_id_uidx'
    ])
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_bad
    ) then
      raise exception 'uniqueness index % is missing', v_bad;
    end if;
  end loop;

  -- ── Normal PI deletion is unchanged ──
  if 'approved' = any (public.order_submission_deletable_statuses()) then
    raise exception 'normal PI deletion now admits an approved submission';
  end if;

  -- ── begin: the context is never opened, and every gate precedes the claim ──
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'begin_test_data_cleanup';

  if v_def like '%boe.cleanup_context%' then
    raise exception 'begin_test_data_cleanup opens the cleanup context; only finalization may';
  end if;
  if v_def ~* 'delete from public\.' then
    raise exception 'begin_test_data_cleanup deletes something; it must destroy nothing';
  end if;
  for v_bad in select unnest(array[
      'Only an admin may run Test Data Cleanup', 'CLEANUP_DISABLED',
      'CLEANUP_REASON_REQUIRED', 'CLEANUP_CONFIRMATION_INVALID',
      'CLEANUP_NOT_ELIGIBLE', 'CLEANUP_PROVENANCE_MISMATCH'
    ])
  loop
    if position(v_bad in v_def) = 0 then
      raise exception 'begin_test_data_cleanup is missing gate %', v_bad;
    end if;
    if position(v_bad in v_def) > position('insert into public.test_data_cleanup_claims' in v_def) then
      raise exception 'gate % is checked after the claim is taken', v_bad;
    end if;
  end loop;

  -- ── finalize: the deletion order is the only one the keys permit ──
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_test_data_cleanup';

  if position('set source_order_submission_id = null' in v_def)
     > position('delete from public.order_submissions' in v_def) then
    raise exception 'the Order must release the PI before the PI is deleted';
  end if;
  if position('delete from public.order_submissions' in v_def)
     > position('delete from public.orders where id = v_order' in v_def) then
    raise exception 'the PI must be deleted before the Order it belongs to';
  end if;
  if position('CLEANUP_NOT_ELIGIBLE' in v_def) > position('boe.cleanup_context' in v_def) then
    raise exception 'the cleanup context is opened before the eligibility re-check';
  end if;
  if v_def not like '%already_finalized%' then
    raise exception 'finalize_test_data_cleanup is not idempotent';
  end if;
  if v_def not like '%CLEANUP_CHAIN_CHANGED%' then
    raise exception 'finalize_test_data_cleanup does not re-check the claimed chain';
  end if;

  -- ── The retired door refuses ──
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'execute_test_data_cleanup';
  if v_def not like '%CLEANUP_USE_CLAIM_PROTOCOL%' then
    raise exception 'the retired single-call cleanup still deletes';
  end if;
  if v_def ~* 'delete from public\.' then
    raise exception 'the retired single-call cleanup still deletes';
  end if;

  -- ── Nothing has been cleaned up by this file ──
  if exists (select 1 from public.test_data_cleanup_claims) then
    raise exception 'a cleanup claim already exists; this migration takes none';
  end if;
end $$;

-- ═══ 11. What this migration deliberately does NOT do ═══════════════════════
--
--   * It does not add is_test_data to order_submissions. The classification is
--     inherited from the Order through a link verified in both directions, and a
--     second flag could only ever disagree with the first.
--   * It does not delete a storage object. Object storage is not transactional;
--     the PI's files and the Order Request's attachments are removed BETWEEN the
--     claim and the finalization, by the route, and the payment proofs after the
--     commit — each on the side where a failure is recoverable.
--   * It does not re-check the enabled setting at finalization. See §8: by then
--     the files are gone, and the claim carries the authorization the gates gave.
--   * It does not advance the Order number cycle, and reclaims only numbers this
--     cleanup freed from the top of the range — never overruling a number an
--     administrator configured.
--   * It does not change what an employee or reviewer can delete, the approval
--     path, the advance workflow, any payment rule or any RLS policy on a
--     business table.

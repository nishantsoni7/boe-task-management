-- Test Data Cleanup — remove a test Order that was created from an approved PI.
--
-- ═══ THE PRODUCTION DEFECT ══════════════════════════════════════════════════
--
-- Admin → Test Data Cleanup could not delete test Order 0001:
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
-- the other exists, so one reference has to be released first — and
-- execute_test_data_cleanup() only knew how to release the OLDER pair
-- (orders.source_order_request_id / order_requests.converted_order_id, 20260701).
-- It had never heard of the PI, so it walked straight into the FK and stopped.
--
-- THE SAME SHAPE, THE SAME REMEDY. 20260706000000 §7 already documents why
-- releasing the ORDER'S reference is the correct side to break: the reverse
-- direction is tangled up in a consistency constraint on the other row, and
-- mutating something on the way to deleting it is both pointless and misleading.
-- This file applies that identical reasoning to the PI pair, and the deletion
-- order falls out of it:
--
--   1. clear orders.source_order_submission_id      the loop opens
--   2. delete the order_submissions row             items, images and activity
--                                                   cascade with it
--   3. delete the orders row                        order_activity_log cascades
--
-- Step 1's state is never observable: both rows are deleted in the same
-- transaction, two statements later.
--
-- ═══ WHAT IS AND IS NOT WEAKENED ════════════════════════════════════════════
--
-- Neither foreign key is dropped, altered or made deferrable. Both are fully
-- enforcing before this transaction and after it. What changes is that three
-- guards gain the SAME cleanup-context exemption the Order, Order Request and
-- payment guards have carried since 20260705000000 — and only that context:
--
--   prevent_order_source_submission_change    so step 1 is possible
--   order_submissions_guard_delete            so step 2 is possible
--   order_submission_activity_guard_delete    so the trail cascades with it
--
-- in_test_data_cleanup() reads a TRANSACTION-LOCAL setting that
-- execute_test_data_cleanup() sets only after all five gates have passed, and
-- that no client role can set: the function is revoked from public, anon and
-- authenticated, and set_config(..., true) cannot outlive the transaction. So
-- outside that one authorized transaction an approved PI is exactly as
-- undeletable as it was on the day 20260915000000 shipped, and a Confirmed Order
-- is exactly as permanent.
--
-- ═══ HOW A PI IS JUDGED TO BE TEST DATA ═════════════════════════════════════
--
-- order_submissions HAS NO is_test_data COLUMN, and this migration deliberately
-- does not add one. Adding it would mean a stamping trigger on a table whose
-- rows are created in the Import screen — far outside the Orders module the
-- cleanup feature knows about — plus a backfill and an immutability guard, to
-- express a fact that is already derivable and cannot disagree with itself:
--
--   an APPROVED PI's only reason to exist is the Order it produced, the link is
--   one-to-one in both directions (two partial unique indexes), and it is
--   immutable once written.
--
-- So the PI inherits the Order's classification, and the inheritance is only
-- sound while the link is intact — which is why §2 refuses the whole operation
-- if the two rows do not name each other. A PI that is not reachable from a test
-- Order is never touched by this feature at all.
--
-- ═══ WHAT THIS MIGRATION DOES NOT DO ════════════════════════════════════════
--
--   * It does not edit 20260915000000 or any earlier migration. Every function
--     below is CREATE OR REPLACE at its existing signature, so the live ACL
--     survives and no DROP discards a grant.
--   * It does not change normal PI deletion. begin/release/finalize
--     _order_submission_deletion, order_submission_deletable_statuses() and
--     order_submission_deletable_by() are untouched: an approved PI is still
--     absent from the deletable statuses, so the ordinary path still refuses it.
--   * It does not change final approval, numbering, the Order number cycle, any
--     payment rule, or any RLS policy.
--   * It does not reset, reduce or advance order_number_cycle. A freed number
--     becomes REUSABLE only in the sense it always has: once no Order holds it,
--     set_next_confirmed_order_number() will accept it, because that function's
--     rule is "> the highest EXISTING Order number". Nothing here decides that
--     for the admin.
--   * It adds no new permission, no new client-callable function, and no new
--     table.

-- ═══ 1. The three guards gain the cleanup exemption ═════════════════════════
--
-- Each is reproduced from the migration that owns it, with the exemption added
-- as the FIRST statement and NOTHING else altered — so the two can be diffed and
-- a repository test asserts exactly that.

-- ── 1a. The PI provenance column on the Order ────────────────────────────────
--
-- From 20260915000000 §2. The guard freezes source_order_submission_id once set,
-- which is right for every ordinary path and is why it is kept. Step 1 of the
-- deletion above needs the one exemption.

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
  'Freezes orders.source_order_submission_id once set, for every transaction except an authorized Test Data Cleanup — which releases it only to break the mutual foreign key immediately before deleting both rows.';

-- ── 1b. Deleting the submission row ──────────────────────────────────────────
--
-- From 20260914000000 §5. The purge marker stays the ordinary path — it is what
-- finalize_order_submission_deletion() uses, and it names ONE submission so it
-- cannot authorize a second. The cleanup context is the second, equally narrow
-- door, and it is reached only through the five gates in
-- execute_test_data_cleanup().

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

-- ── 1c. The submission's append-only trail ───────────────────────────────────
--
-- From 20260914000000 §5, and for the same reason it gave: a trail without its
-- record is not history, it is litter. The rows here arrive by CASCADE from the
-- submission delete, and a BEFORE DELETE trigger fires on a cascade exactly as
-- it does on a direct statement — so without this the cascade would raise.

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

-- ═══ 2. Chain resolution learns about the PI ════════════════════════════════
--
-- The single source of truth for "what does cleaning this up actually touch?".
-- Preview and execute both call it, so what an admin was shown and what the
-- database acts on cannot drift — execute re-runs it under held locks and
-- re-checks the answer.
--
-- Restated from 20260706000000 §5 with the PI branch added. Every existing
-- behaviour is preserved exactly: the three root types, the payment-root
-- retention rule, the all-or-nothing eligibility rule, the proof-attachment
-- storage_paths array and every existing key of the returned object.
--
-- WHAT IS ADDED
--
--   order_submission_id           the approved PI this Order came from, or null
--   submission_storage_prefix     submissions/{id}/ — the ONE prefix that PI's
--                                 files live under, for the route that removes
--                                 them. Never a browser-supplied path.
--   to_delete                     gains one entry of type 'order_submission'
--   counts                        gains the four PI tables
--
-- WHY THE PREFIX IS A SEPARATE KEY AND NOT PART OF storage_paths. That array is
-- consumed by the admin page as payment-proof object keys and removed from the
-- payment-proofs bucket. PI files live in order-files, under a different policy,
-- and are removed by a different route. Folding them together would send one
-- bucket's keys to the other, which fails silently in the direction that matters.
--
-- CONSISTENCY IS A BLOCKER, NOT A REPAIR. If the Order names a PI that does not
-- name it back, this reports it in `blocking` and the operation is refused. It
-- is not silently skipped and the link is not "fixed": a provenance pair that
-- disagrees is a fact somebody needs to look at, not something a bulk delete
-- should paper over on its way past.

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

  -- ── Resolve the chain members ──────────────────────────────────────────────
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

  -- Payments attached to either side of an order/request chain.
  if p_root_type in ('order', 'order_request') then
    select coalesce(array_agg(f.id), '{}')
      into v_payments
    from public.finance_payment_requests f
    where (v_order_id   is not null and f.order_id         = v_order_id)
       or (v_request_id is not null and f.order_request_id = v_request_id);
  end if;

  -- ── The PI this Order came from ───────────────────────────────────────────
  --
  -- Read from the ORDER, in whichever chain the Order arrived. An Order created
  -- by converting an Order Request carries no PI and this resolves to null,
  -- which is the honest answer rather than an absence to be worked around.
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

  -- ── Records proposed for deletion, and the ones that block ─────────────────
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
    -- THE PI. Its classification is INHERITED from the Order it produced — see
    -- the header — so `is_test_data` here is the Order's own flag rather than a
    -- column on this row, and it is only trustworthy because the link is
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
  --
  -- Two independent ways this can be wrong, and both are refusals:
  --
  --   the Order names a PI that no longer exists      a dangling reference
  --   the PI names a DIFFERENT Order, or none         the pair disagrees
  --
  -- Either means the one-to-one relationship the inheritance rests on is not
  -- there, so the PI's test-data status cannot be derived and nothing is deleted.
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

  -- A payment root keeps its Order / Order Request. They are reported as
  -- retained so the admin can see what survives, and they are checked: an
  -- attachment to a REAL record blocks, exactly as rule 9.3 requires.
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

  -- ── Proof objects and dependent-row counts ────────────────────────────────
  --
  -- storage_paths is UNCHANGED: payment-proof object keys, and nothing else. PI
  -- files are reported by submission_storage_prefix and removed by a different
  -- route against a different bucket.
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
    -- The PI and everything that belongs solely to it. All four are counted for
    -- the preview even though three of them arrive by CASCADE, because an admin
    -- deciding whether to press the button should see the size of what goes.
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

-- ═══ 3. The PI's own storage keys, for the route that removes them ══════════
--
-- READ FROM THE DATABASE, never from anything a browser sent, and every one of
-- them is under submissions/{id}/ — a prefix the path CHECK constraints in
-- 20260908000000 and 20260909000000 make exclusive to one submission. No shared
-- object can be named here.
--
-- It answers only for a submission reachable from a TEST Order that names it
-- back. An id that is not — a real PI, a draft somebody owns, a mismatched
-- pair — returns null rather than a path list, so the route cannot be pointed at
-- somebody's live workbook by guessing a uuid.
--
-- This mirrors what begin_order_submission_deletion() returns on the ordinary
-- deletion path, and deliberately does NOT reserve anything: the Test Data
-- Cleanup transaction holds its own row locks, and a reservation here would be a
-- second, competing freeze on the same record.

create or replace function public.test_cleanup_submission_storage(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub    public.order_submissions%rowtype;
  v_order  public.orders%rowtype;
  v_paths  text[];
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin'
      and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'Only an admin may read PI cleanup storage' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    return jsonb_build_object('found', false, 'reason', 'order_not_found');
  end if;

  -- TEST DATA ONLY. This is the same rule the cleanup RPC enforces, checked
  -- again here so the route cannot be used to enumerate a real PI's file keys.
  if not v_order.is_test_data then
    return jsonb_build_object('found', false, 'reason', 'order_not_test_data');
  end if;

  if v_order.source_order_submission_id is null then
    return jsonb_build_object('found', false, 'reason', 'no_submission');
  end if;

  select * into v_sub
  from public.order_submissions
  where id = v_order.source_order_submission_id;

  if not found then
    return jsonb_build_object('found', false, 'reason', 'submission_missing');
  end if;

  -- The pair must name each other, exactly as §2 requires.
  if v_sub.order_id is distinct from p_order_id then
    return jsonb_build_object('found', false, 'reason', 'provenance_mismatch');
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
    -- anyway: a key that a row still names is a key that must go, whichever
    -- generation of the schema wrote it.
    select i.image_storage_path
    from public.order_submission_items i
    where i.submission_id = v_sub.id
      and coalesce(btrim(i.image_storage_path), '') <> ''
  ) t
  where path like ('submissions/' || v_sub.id::text || '/%');

  return jsonb_build_object(
    'found',          true,
    'submission_id',  v_sub.id,
    'status',         v_sub.status,
    'storage_prefix', 'submissions/' || v_sub.id::text || '/',
    'storage_paths',  to_jsonb(v_paths)
  );
end;
$$;

comment on function public.test_cleanup_submission_storage(uuid) is
  'Admin-only. The storage keys of the PI submission a TEST Order was created from, read from the database. Returns found=false for a real Order, an Order with no PI, or a provenance pair that disagrees — so it cannot be aimed at a live PI. Reserves nothing and deletes nothing.';

revoke execute on function public.test_cleanup_submission_storage(uuid) from public, anon;
grant  execute on function public.test_cleanup_submission_storage(uuid) to authenticated;

-- ═══ 4. Execution learns the new deletion order ═════════════════════════════
--
-- Restated from 20260706000000 §7. Every gate, every lock, every existing
-- deletion step, the audit-before-anything rule and the returned shape are
-- preserved exactly. What is added is the PI: one more row locked, one more
-- eligibility fact re-checked under that lock, and three statements in the
-- middle of the deletion sequence.
--
-- THE ORDER OF THE FIVE GATES IS UNCHANGED, and the cleanup context is still set
-- only after all of them AND after the post-lock re-resolve has confirmed the
-- chain is eligible. Nothing about the PI is touched before that point.

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
declare
  v_actor      uuid := auth.uid();
  v_email      text;
  v_set        public.test_data_cleanup_settings%rowtype;
  v_chain      jsonb;
  v_order      uuid;
  v_request    uuid;
  v_submission uuid;
  v_payments   uuid[];
  v_ids        uuid[];
  v_audit      uuid;
  v_n_notif    integer := 0;
  v_n_pay      integer := 0;
  v_n_req      integer := 0;
  v_n_ord      integer := 0;
  v_n_sub      integer := 0;
  v_n_items    integer := 0;
  v_n_images   integer := 0;
  v_n_events   integer := 0;
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
  --    past between the check and the deletion.
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

  -- ── Resolve, then LOCK, then re-resolve ───────────────────────────────────
  -- The first pass finds the rows; the locks freeze them; the second pass is the
  -- one that counts. Anything that changed between the admin's preview and now —
  -- a payment approved onto the Order, a request converted, a PI approved into
  -- this very Order — is caught by the re-check rather than acted on from a
  -- stale graph.
  v_chain := public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);

  v_order      := nullif(v_chain->>'order_id', '')::uuid;
  v_request    := nullif(v_chain->>'order_request_id', '')::uuid;
  v_submission := nullif(v_chain->>'order_submission_id', '')::uuid;

  -- jsonb_array_elements_text, not jsonb_array_elements: the latter yields jsonb
  -- string values whose ::text form still carries its quotes, which the uuid cast
  -- then rejects.
  select coalesce(array_agg(value::uuid), '{}')
    into v_payments
  from jsonb_array_elements_text(v_chain->'payment_ids');

  perform 1 from public.orders            where id = v_order      for update;
  perform 1 from public.order_requests    where id = v_request    for update;
  perform 1 from public.order_submissions where id = v_submission for update;
  perform 1 from public.finance_payment_requests
   where id = any(v_payments) order by id for update;

  v_chain := public.resolve_test_data_cleanup_chain(p_root_type, p_root_id);

  -- ── Gate 5: every record in the chain is test data ────────────────────────
  --
  -- The PI is in that chain now, carrying the Order's classification, and the
  -- provenance-pair check in §2 has already added a blocking entry if the two
  -- rows disagree. So a mismatched or dangling link fails here, with a reason,
  -- rather than reaching the deletion sequence.
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
  -- jsonb_array_elements_text, not jsonb_array_elements: the latter yields jsonb
  -- string values whose ::text form still carries its quotes, which the uuid cast
  -- then rejects.
  select coalesce(array_agg(value::uuid), '{}')
    into v_payments
  from jsonb_array_elements_text(v_chain->'payment_ids');

  -- ── A last, explicit assertion on the provenance pair ─────────────────────
  --
  -- §2 already blocks a disagreeing pair, and this says it again in the one
  -- place that is about to delete something, under the locks that make the
  -- answer final. "Already checked" is a statement about code that has not been
  -- edited yet; this is the check that stands next to the DELETE.
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

  -- ── The audit entry, written BEFORE anything is removed ───────────────────
  --
  -- deleted_records carries the PI's id and its storage prefix (the
  -- 'order_submission' entry §2 builds), table_counts carries the four PI row
  -- counts, and storage_paths keeps its existing meaning — payment proofs. The
  -- audit therefore records the submission id, the counts, the prefix, the Order
  -- number, the actor and the reason, and outlives all of them.
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

  -- ── Stand the production guards down for this transaction only ────────────
  -- Everything above has already been verified. set_config(..., true) is
  -- transaction-local: it cannot outlive this call, and no client can set it.
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);

  v_ids := array_remove(array[v_order, v_request], null) || v_payments;

  -- 1. Notifications have no foreign key, so nothing removes them implicitly.
  --    Scoped to this chain's uuids and to Order/Finance types, so a task
  --    notification that happens to share an id can never be caught.
  delete from public.notifications
   where entity_id = any(v_ids)
     and (type::text like 'order%' or type::text like 'finance%');
  get diagnostics v_n_notif = row_count;

  -- 2. Payments. payment_proof_attachments and
  --    finance_payment_request_activity_log both cascade with the row.
  delete from public.finance_payment_requests where id = any(v_payments);
  get diagnostics v_n_pay = row_count;

  -- 3. Release the OLD provenance reference so the mutual FK lock opens. Both
  --    rows are deleted immediately below, so this state is never observable.
  if v_order is not null and v_request is not null then
    update public.orders
       set source_order_request_id = null,
           source_request_number   = null
     where id = v_order;
  end if;

  -- 4. The request (order_request_activity cascades).
  delete from public.order_requests where id = v_request;
  get diagnostics v_n_req = row_count;

  -- ── 4a. THE PI PAIR — the defect this migration exists to fix ─────────────
  --
  -- Release the Order's reference to the PI, then delete the PI, then (step 5)
  -- the Order. Both directions of the mutual foreign key are respected at every
  -- moment: after the update the Order names no PI, so the PI can go; the PI's
  -- own order_id still names a live Order right up until it is deleted.
  --
  -- The three child tables are counted BEFORE the delete and then removed by
  -- CASCADE, so the audit reports what actually went rather than what Postgres
  -- was trusted to do quietly.
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

  update public.test_data_cleanup_audit
     set result = jsonb_build_object(
           'notifications',    v_n_notif,
           'payment_requests', v_n_pay,
           'order_requests',   v_n_req,
           'orders',           v_n_ord,
           'order_submissions',            v_n_sub,
           'order_submission_items',       v_n_items,
           'order_submission_item_images', v_n_images,
           'order_submission_activity',    v_n_events,
           'submission_storage_prefix',    v_chain->>'submission_storage_prefix'
         )
   where id = v_audit;

  -- Storage paths are RETURNED, never deleted here: object storage is not part
  -- of this transaction, so a file removed now could not be restored if the
  -- transaction rolled back. The caller deletes them only after this commits.
  --
  -- The PI's files are the OTHER way round and deliberately so: they are removed
  -- BEFORE this function is called, by the admin-only route, because the PI row
  -- is what makes their keys discoverable. Losing the row first would strand
  -- them; losing the files first leaves a retryable, fully-described record.
  return jsonb_build_object(
    'audit_id',      v_audit,
    'root_type',     p_root_type,
    'root_number',   v_chain->>'root_number',
    'deleted',       jsonb_build_object(
                       'orders',           v_n_ord,
                       'order_requests',   v_n_req,
                       'payment_requests', v_n_pay,
                       'notifications',    v_n_notif,
                       'order_submissions',            v_n_sub,
                       'order_submission_items',       v_n_items,
                       'order_submission_item_images', v_n_images,
                       'order_submission_activity',    v_n_events
                     ),
    'deleted_records', v_chain->'to_delete',
    'retained',        v_chain->'to_retain',
    'storage_paths',   v_chain->'storage_paths',
    'order_submission_id',       v_submission,
    'submission_storage_prefix', v_chain->>'submission_storage_prefix'
  );
end;
$$;

revoke execute on function public.execute_test_data_cleanup(text, uuid, text, text) from public, anon;
grant  execute on function public.execute_test_data_cleanup(text, uuid, text, text) to authenticated;

comment on function public.execute_test_data_cleanup(text, uuid, text, text) is
  'Admin-only. Removes one complete verified test transaction chain — including the approved PI submission an Order was created from, and its items, images and history — in a single transaction, after checking admin, enabled setting, reason, typed confirmation, per-record test-data eligibility and the PI/Order provenance pair. Writes a permanent audit row first. Never touches numbering: no sequence is reset and order_number_cycle is not reduced.';

-- ═══ 5. Assertions ══════════════════════════════════════════════════════════
--
-- These fail the migration rather than let a partial apply look successful.

do $$
declare
  v_def text;
  v_bad text;
begin
  -- ── The three exemptions are present, and are the cleanup context ONLY ──
  for v_bad in select unnest(array[
      'prevent_order_source_submission_change',
      'order_submissions_guard_delete',
      'order_submission_activity_guard_delete'
    ])
  loop
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_bad;

    if v_def is null then
      raise exception 'guard % is missing', v_bad;
    end if;
    if v_def not like '%in_test_data_cleanup()%' then
      raise exception 'guard % did not gain the cleanup exemption', v_bad;
    end if;
    -- It must still refuse everybody else.
    if v_def not like '%raise exception%' then
      raise exception 'guard % no longer refuses anything', v_bad;
    end if;
  end loop;

  -- The two ordinary purge doors are untouched.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'order_submissions_guard_delete';
  if v_def not like '%order_submission_purge_in_progress%' then
    raise exception 'the ordinary PI purge path was removed from the delete guard';
  end if;

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
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'orders'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) like '%source_order_submission_id%'
      and pg_get_constraintdef(c.oid) not like '%ON DELETE%'
  ) then
    raise exception 'orders.source_order_submission_id is no longer a NO ACTION foreign key';
  end if;

  -- ── Both uniqueness guarantees survive ──
  for v_bad in select unnest(array[
      'order_submissions_order_id_key',
      'orders_source_order_submission_id_uidx'
    ])
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_bad
    ) then
      raise exception 'uniqueness index % is missing', v_bad;
    end if;
  end loop;

  -- ── An approved PI is still absent from the ordinary deletable statuses ──
  if 'approved' = any (public.order_submission_deletable_statuses()) then
    raise exception 'normal PI deletion now admits an approved submission; that is not this migration''s to change';
  end if;

  -- ── The execution RPC still sets the context AFTER the eligibility gate ──
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'execute_test_data_cleanup';

  if position('CLEANUP_NOT_ELIGIBLE' in v_def) > position('boe.cleanup_context' in v_def) then
    raise exception 'the cleanup context is set before the eligibility gate';
  end if;
  if position('CLEANUP_CONFIRMATION_INVALID' in v_def) > position('boe.cleanup_context' in v_def) then
    raise exception 'the cleanup context is set before the confirmation gate';
  end if;
  if v_def not like '%CLEANUP_PROVENANCE_MISMATCH%' then
    raise exception 'the provenance assertion is missing from the execution RPC';
  end if;
  -- The PI is deleted BEFORE the Order, or the foreign key would refuse.
  if position('delete from public.order_submissions' in v_def)
     > position('delete from public.orders' in v_def) then
    raise exception 'the PI must be deleted before the Order it belongs to';
  end if;

  -- ── Nothing here touches numbering ──
  if v_def like '%order_number_cycle%'
     or v_def like '%allocate_confirmed_order_number%'
     or v_def like '%setval%' then
    raise exception 'the cleanup RPC now touches Order numbering';
  end if;
end $$;

-- ═══ 6. What this migration deliberately does NOT do ════════════════════════
--
--   * It does not add is_test_data to order_submissions. See the header: the
--     classification is inherited from the Order through a link this file
--     verifies in both directions, and a second flag could only ever disagree
--     with the first.
--   * It does not delete a storage object. Object storage is not transactional,
--     so the PI's files are removed BEFORE this RPC by the admin-only route, and
--     the payment proofs AFTER it by the admin page — each on the side of the
--     commit where a failure is recoverable.
--   * It does not reset or reduce order_number_cycle, and does not make a freed
--     Order number reusable by itself. Deleting the Order that held a number
--     means set_next_confirmed_order_number() will now ACCEPT that number,
--     because its rule is "> the highest existing Order number" — but an admin
--     still has to decide it.
--   * It does not change what an ordinary employee or reviewer can delete, the
--     approval path, the advance workflow, any payment rule or any RLS policy.

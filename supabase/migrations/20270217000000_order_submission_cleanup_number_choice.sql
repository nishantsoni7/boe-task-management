-- An administrator chooses whether a deleted test Order's number stays spent.
-- The choice is fixed on the durable claim before any storage deletion starts.
alter table public.test_data_cleanup_claims
  add column if not exists order_number_choice text
    check (order_number_choice in ('keep', 'reuse'));

create or replace function public.choose_test_cleanup_order_number(
  p_claim_token uuid, p_choice text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_claim public.test_data_cleanup_claims%rowtype;
  v_number bigint;
  v_next bigint;
begin
  if v_actor is null or not exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin'
      and u.is_active is true and u.is_deleted is false
  ) then
    raise exception 'Only an active administrator can choose Order numbering' using errcode = '42501';
  end if;
  if p_choice not in ('keep', 'reuse') or p_choice is null then
    raise exception 'Choose whether to keep or reuse the Order number' using errcode = '22023';
  end if;

  select * into v_claim from public.test_data_cleanup_claims
   where claim_token = p_claim_token for update;
  if not found or v_claim.finalized_at is not null or v_claim.released_at is not null
     or v_claim.claimed_by is distinct from v_actor or v_claim.order_id is null then
    raise exception 'This Order cleanup claim cannot accept a number choice' using errcode = '42501';
  end if;
  if v_claim.order_number_choice is not null then
    if v_claim.order_number_choice <> p_choice then
      raise exception 'This cleanup already has a different Order number choice; resume it with the same choice'
        using errcode = '23514';
    end if;
    return;
  end if;

  -- A gap below a surviving Order is never the next number. Lock the same
  -- cycle row as allocation and finalization so this proof cannot race them.
  if p_choice = 'reuse' then
    select c.next_number into v_next from public.order_number_cycle c
      where c.id = true for update;
    select o.display_number::bigint into v_number from public.orders o
      where o.id = v_claim.order_id and o.display_number ~ '^[0-9]+$';
    if v_next is null or v_number is null or v_next <> v_number + 1
       or exists (select 1 from public.orders o
                    where o.id <> v_claim.order_id and o.display_number ~ '^[0-9]+$'
                      and o.display_number::bigint >= v_number)
       or exists (select 1 from public.order_reserved_number_ledger l
                    where l.number::bigint >= v_number
                      and l.submission_id is distinct from v_claim.order_submission_id) then
      raise exception 'This is not the latest unreserved number; the next Order cannot reuse it'
        using errcode = '23514';
    end if;
  end if;

  update public.test_data_cleanup_claims
     set order_number_choice = p_choice where id = v_claim.id;
end;
$$;

revoke execute on function public.choose_test_cleanup_order_number(uuid, text)
  from public, anon, service_role;
grant execute on function public.choose_test_cleanup_order_number(uuid, text)
  to authenticated;

-- A new approval cannot consume the next number between the choice and
-- finalization. The choice setter and the allocator both lock the cycle row.
create or replace function public.pause_order_allocation_for_reuse_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.next_number > old.next_number
     and not public.in_test_data_cleanup()
     and exists (
       select 1 from public.test_data_cleanup_claims c
       where c.order_number_choice = 'reuse' and c.finalized_at is null
         and c.released_at is null
     ) then
    raise exception 'ORDER_NUMBER_CLEANUP_IN_PROGRESS: Finish the claimed test Order cleanup before approving another Order'
      using errcode = '55P03';
  end if;
  return new;
end;
$$;
revoke execute on function public.pause_order_allocation_for_reuse_cleanup()
  from public, anon, authenticated, service_role;
drop trigger if exists order_cycle_pause_for_reuse_cleanup on public.order_number_cycle;
create trigger order_cycle_pause_for_reuse_cleanup
  before update of next_number on public.order_number_cycle
  for each row execute function public.pause_order_allocation_for_reuse_cleanup();

-- finalize_test_data_cleanup is re-emitted below with the same claim, chain,
-- storage and FK safeguards. Three behavioral changes:
--   * a claim that deletes an Order must carry the administrator's numbering
--     choice before anything is deleted;
--   * the Order's advance exceptions are deleted before its PI (see step 4a);
--   * a kept number is never reclaimed in step 6.

create or replace function public.finalize_test_data_cleanup(p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
  v_n_exceptions integer := 0;
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

  -- Deleting an Order needs the administrator's numbering choice, recorded on
  -- this claim by choose_test_cleanup_order_number(). A claim taken before that
  -- existed (Order 0526's) is finished only once the choice is made.
  if v_claim.order_id is not null and v_claim.order_number_choice is null then
    raise exception
      'ORDER_NUMBER_CHOICE_REQUIRED: choose whether to keep or reuse the Order number before finishing this cleanup'
      using errcode = 'P0001';
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
  --
  -- An advance exception names the PI version it was granted against
  -- (pi_version_id, ON DELETE SET NULL). Deleting the PI deletes that version,
  -- and the SET NULL is an UPDATE its immutability guard refuses: the failure
  -- that left Order 0526's cleanup unfinished. The exceptions belong to the
  -- Order being deleted, so they go first; their voids cascade, and both guards
  -- allow a delete in this cleanup context.
  if v_order is not null then
    delete from public.order_advance_exceptions where order_id = v_order;
    get diagnostics v_n_exceptions = row_count;
  end if;

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
  if array_length(v_freed, 1) > 0
     and v_claim.order_number_choice = 'reuse' then
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
    'order_advance_exceptions',     v_n_exceptions,
    'order_numbers_reclaimed',      v_reclaimed,
    'order_number_choice',          v_claim.order_number_choice,
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
  'Finalizes a claimed Test Data Cleanup, preserving the same deletion and audit gates. A claim that deletes an Order needs its keep/reuse choice first. The Order''s advance exceptions are deleted before its PI so the pi_version_id SET NULL never rewrites an immutable exception. A kept Order number is never reclaimed; reuse still requires the deleted Order to be at the top of the series.';

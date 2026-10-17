-- An administrator can permanently delete a Confirmed Order.
--
-- THE RULE
-- --------
-- Until now an Order was permanent: prevent_order_delete() refused every caller
-- but the test-data cleanup. An administrator may now delete one, through ONE
-- function, delete_confirmed_order(order_id, typed order number), which removes
-- the Order and everything that belongs only to it and to the PI it was made
-- from, in one transaction.
--
-- WHAT STOPS IT (nothing is deleted if any of these is true)
-- ----------------------------------------------------------
--   * the caller is not an active administrator
--   * the typed confirmation is not the Order's own number
--   * a payment allocation names the Order or its PI, in ANY status, other than
--     a reversed leftover of a payment its owner deleted before approval
--     (allocation_released_by_payment_deletion, 20270315000000)
--   * a payment allocation intent names them, other than the cancelled intent of
--     such a payment
--   * a payment request is linked to the Order
--   * a retired Order Request was converted into it
-- Finance is never touched by this function: no payment, allocation or proof is
-- deleted, reversed or edited. Money has to be dealt with in Finance first.
--
-- HOW, AND WHY IT BORROWS THE CLEANUP CONTEXT
-- -------------------------------------------
-- An Order owns about twenty tables, many of them append-only history (approval
-- events, handoffs, PI versions, document submissions, advance exceptions...).
-- The production guards on those tables already recognise one sanctioned way to
-- let go of a row: the transaction-local boe.cleanup_context that the test-data
-- executor sets (and that 20261010000000 uses for exactly this deletion order).
-- This function sets the same context for the length of ONE transaction, after
-- every check above has passed, and executes a fixed list of statements pinned
-- to ONE Order id and the PI(s) it came from. It is not settable by any client,
-- is cleared before returning, and rolls back with any error. Restating twenty
-- guards instead would have been twenty chances to drift from their live
-- definitions.
--
-- Two guards do NOT honour that context and are restated narrowly here:
--   * order_approval_events_append_only raised unconditionally, so even the
--     cleanup could not remove an Order that had a fabric/finish approval. It now
--     lets a row go only while THAT Order is being purged (boe.order_purge_id).
--   * order_factory_focus_guard already lets a row go with its Order (it only
--     refuses a direct delete) and needs no change.
--
-- STORAGE is swept by the caller AFTER this commits, from the prefixes and keys
-- returned: a failed sweep then leaves unreachable files, never an Order whose
-- documents have disappeared. The sweep is idempotent and can be re-run.
--
-- A permanent audit row is written to order_deletion_log.

do $$
begin
  if to_regprocedure('public.allocation_released_by_payment_deletion(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20270315000000 must be applied first';
  end if;
  if to_regprocedure('public.in_test_data_cleanup()') is null then
    raise exception 'DEPENDENCY MISSING: 20260705000000 must be applied first';
  end if;
  if to_regclass('public.order_approval_events') is null then
    raise exception 'DEPENDENCY MISSING: order_approval_events must exist';
  end if;
end $$;

-- ── 1. The audit trail ───────────────────────────────────────────────────────

create table if not exists public.order_deletion_log (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null,
  display_number      text not null,
  client_name         text,
  submission_ids      uuid[] not null default '{}',
  deleted_by          uuid not null references public.users(id),
  deleted_at          timestamptz not null default now(),
  removed             jsonb not null default '{}'::jsonb
);

comment on table public.order_deletion_log is
  'One row per Order an administrator permanently deleted. Deliberately has no foreign key to the Order: the row must outlive it.';

alter table public.order_deletion_log enable row level security;
revoke all on table public.order_deletion_log from public, anon, authenticated;
grant select on table public.order_deletion_log to authenticated;

drop policy if exists order_deletion_log_admin_select on public.order_deletion_log;
create policy order_deletion_log_admin_select on public.order_deletion_log
  for select to authenticated
  using (exists (select 1 from public.users u
                  where u.id = auth.uid() and u.role = 'admin'
                    and u.is_active and coalesce(u.is_deleted, false) = false));

create or replace function public.order_deletion_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ORDER_DELETION_LOG_IMMUTABLE: the deletion log is append-only'
    using errcode = '42501';
end;
$$;

drop trigger if exists order_deletion_log_immutable on public.order_deletion_log;
create trigger order_deletion_log_immutable
  before update or delete on public.order_deletion_log
  for each row execute function public.order_deletion_log_immutable();

-- ── 2. The purge marker, and the one guard that needs it ─────────────────────

create or replace function public.order_purge_in_progress(p_order_id uuid)
returns boolean
language plpgsql
stable
as $$
declare
  v_marker text := current_setting('boe.order_purge_id', true);
begin
  return p_order_id is not null
     and v_marker is not null
     and v_marker <> ''
     and v_marker = p_order_id::text;
exception when others then
  return false;
end;
$$;

comment on function public.order_purge_in_progress(uuid) is
  'True only inside delete_confirmed_order(), and only for the Order that call is erasing.';

revoke execute on function public.order_purge_in_progress(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.order_approval_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and public.order_purge_in_progress(old.order_id) then
    return old;
  end if;
  raise exception
    'ORDER_APPROVAL_EVENT_IMMUTABLE: fabric and finish approval events are append-only'
    using errcode = 'P0001';
end;
$$;

-- ── 3. The deletion ──────────────────────────────────────────────────────────

create or replace function public.delete_confirmed_order(
  p_order_id uuid,
  p_confirm  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_ord      public.orders%rowtype;
  v_subs     uuid[];
  v_sub      uuid;
  v_blocked  integer;
  v_paths    text[];
  v_n_docs   integer := 0;
  v_n_subs   integer := 0;
  v_n_notif  integer := 0;
begin
  if v_actor is null
     or not exists (select 1 from public.users u
                     where u.id = v_actor and u.role = 'admin'
                       and u.is_active and coalesce(u.is_deleted, false) = false) then
    raise exception 'ORDER_DELETE_DENIED: only an administrator can delete an Order'
      using errcode = '42501';
  end if;

  select * into v_ord from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_DELETE_MISSING: this Order no longer exists' using errcode = 'P0002';
  end if;

  if btrim(coalesce(p_confirm, '')) is distinct from btrim(v_ord.display_number::text) then
    raise exception 'ORDER_DELETE_CONFIRMATION: type the Order number %, exactly, to confirm', v_ord.display_number
      using errcode = 'P0001';
  end if;

  -- Every PI this Order is, or was made from.
  select coalesce(array_agg(distinct s), '{}') into v_subs
    from (select v_ord.source_order_submission_id as s
          union
          select id from public.order_submissions where order_id = p_order_id) x
   where s is not null;

  perform 1 from public.order_submissions where id = any (v_subs) order by id for update;

  -- ── What stops it: money, in any state ─────────────────────────────────────
  select count(*) into v_blocked
    from public.finance_payment_allocations a
   where (a.order_id = p_order_id or a.order_submission_id = any (v_subs))
     and not public.allocation_released_by_payment_deletion(a.id);
  if v_blocked > 0 then
    raise exception 'ORDER_DELETE_BLOCKED_PAYMENTS: % payment allocation(s) name this Order or its PI; Finance must deal with them first', v_blocked
      using errcode = 'P0001';
  end if;

  select count(*) into v_blocked
    from public.finance_payment_allocation_intents i
   where (i.order_id = p_order_id or i.order_submission_id = any (v_subs))
     and not (i.status = 'cancelled' and public.payment_deleted_before_approval(i.payment_request_id));
  if v_blocked > 0 then
    raise exception 'ORDER_DELETE_BLOCKED_PAYMENTS: % pending payment intent(s) name this Order or its PI', v_blocked
      using errcode = 'P0001';
  end if;

  select count(*) into v_blocked
    from public.finance_payment_requests p
   where p.order_id = p_order_id;
  if v_blocked > 0 then
    raise exception 'ORDER_DELETE_BLOCKED_PAYMENTS: % payment request(s) are linked to this Order', v_blocked
      using errcode = 'P0001';
  end if;

  select count(*) into v_blocked
    from public.order_requests r where r.converted_order_id = p_order_id;
  if v_blocked > 0 then
    raise exception 'ORDER_DELETE_BLOCKED_REQUESTS: a retired Order Request was converted into this Order'
      using errcode = 'P0001';
  end if;

  -- ── What the caller must remove from storage afterwards ────────────────────
  select coalesce(array_agg(distinct p order by p), '{}') into v_paths
    from (
      select excel_path as p from public.order_document_versions where order_id = p_order_id
      union all
      select pdf_path   from public.order_document_versions where order_id = p_order_id
      union all
      select workbook_path from public.order_pi_versions
       where order_id = p_order_id or submission_id = any (v_subs)
      union all
      select f.storage_path
        from public.order_document_submission_files f
        join public.order_document_submissions d on d.id = f.submission_id
       where d.order_id = p_order_id or d.pi_submission_id = any (v_subs)
      union all
      select source_workbook_path from public.order_submissions where id = any (v_subs)
      union all
      select storage_path from public.order_submission_item_images where submission_id = any (v_subs)
    ) q
   where p is not null and btrim(p) <> '';

  -- ── The point of no return: stand the guards down for ONE transaction ──────
  perform set_config('boe.cleanup_context', 'test_data_cleanup', true);
  perform set_config('boe.order_purge_id', p_order_id::text, true);

  delete from public.notifications
   where entity_id = any (array[p_order_id] || v_subs)
     and type::text like 'order%';
  get diagnostics v_n_notif = row_count;

  -- Leftovers of payments deleted before approval (the only money rows allowed
  -- to reach here), then the Order's own children that are NO ACTION.
  delete from public.finance_payment_allocations a
   where (a.order_id = p_order_id or a.order_submission_id = any (v_subs))
     and public.allocation_released_by_payment_deletion(a.id);
  delete from public.finance_payment_allocation_intents i
   where (i.order_id = p_order_id or i.order_submission_id = any (v_subs))
     and i.status = 'cancelled';

  delete from public.order_document_versions where order_id = p_order_id;
  get diagnostics v_n_docs = row_count;
  delete from public.order_change_requests where order_id = p_order_id;
  delete from public.order_activity_log where order_id = p_order_id;

  -- The PI(s): correction requests BEFORE activity (a resolved request names the
  -- activity row that answered it, NO ACTION), then lines.
  delete from public.order_submission_correction_requests where submission_id = any (v_subs);
  delete from public.order_submission_activity where submission_id = any (v_subs);
  delete from public.order_submission_item_images where submission_id = any (v_subs);
  delete from public.order_submission_items where submission_id = any (v_subs);

  -- Release the mutual provenance link, then PI(s), then the Order.
  update public.orders
     set source_order_submission_id = null,
         source_order_request_id    = null,
         source_request_number      = null
   where id = p_order_id;

  foreach v_sub in array v_subs loop
    perform set_config('boe.order_submission_purge_id', v_sub::text, true);
    delete from public.order_submissions where id = v_sub;
    v_n_subs := v_n_subs + 1;
  end loop;
  perform set_config('boe.order_submission_purge_id', '', true);

  delete from public.orders where id = p_order_id;

  perform set_config('boe.order_purge_id', '', true);
  perform set_config('boe.cleanup_context', '', true);

  insert into public.order_deletion_log
    (order_id, display_number, client_name, submission_ids, deleted_by, removed)
  values
    (p_order_id, v_ord.display_number::text, v_ord.client_name, v_subs, v_actor,
     jsonb_build_object('document_versions', v_n_docs, 'submissions', v_n_subs,
                        'notifications', v_n_notif, 'storage_keys', coalesce(array_length(v_paths, 1), 0)));

  return jsonb_build_object(
    'deleted',        true,
    'order_id',       p_order_id,
    'display_number', v_ord.display_number,
    'client_name',    v_ord.client_name,
    'submission_ids', to_jsonb(v_subs),
    'storage_paths',  to_jsonb(v_paths)
  );
end;
$$;

comment on function public.delete_confirmed_order(uuid, text) is
  'Permanently deletes one Confirmed Order and the PI it was made from, for an active administrator who types the Order number. Refuses while any payment allocation, intent or payment request names them. Never touches Finance.';

revoke all on function public.delete_confirmed_order(uuid, text) from public, anon;
grant execute on function public.delete_confirmed_order(uuid, text) to authenticated;

-- ── Self-assertions (executed when this file is applied) ─────────────────────

do $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.delete_confirmed_order(uuid,text)'::regprocedure);
  if v_def not like '%role = ''admin''%'
     or v_def not like '%ORDER_DELETE_BLOCKED_PAYMENTS%'
     or v_def not like '%ORDER_DELETE_CONFIRMATION%' then
    raise exception 'delete_confirmed_order must check the administrator, the payments and the confirmation';
  end if;
  if v_def like '%delete from public.finance_payment_requests%'
     or v_def like '%delete from public.payment_proof_attachments%' then
    raise exception 'delete_confirmed_order must never delete a payment or its proofs';
  end if;
  if has_function_privilege('anon', 'public.delete_confirmed_order(uuid,text)', 'execute') then
    raise exception 'delete_confirmed_order must not be callable anonymously';
  end if;
  if has_function_privilege('authenticated', 'public.order_purge_in_progress(uuid)', 'execute') then
    raise exception 'the purge marker must not be callable by clients';
  end if;
  v_def := pg_get_functiondef('public.order_approval_events_append_only()'::regprocedure);
  if v_def not like '%order_purge_in_progress%' then
    raise exception 'the approval event guard must exempt only the purge of its own Order';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'orders_prevent_delete' and tgenabled <> 'D') then
    raise exception 'orders_prevent_delete must stay armed: direct deletes are still refused';
  end if;
end $$;

-- ROLLBACK (manual): drop function delete_confirmed_order(uuid, text),
-- order_purge_in_progress(uuid) and the order_deletion_log table; restate
-- order_approval_events_append_only as an unconditional raise.

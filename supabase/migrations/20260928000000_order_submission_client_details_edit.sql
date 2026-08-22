-- ═══════════════════════════════════════════════════════════════════════════
-- EDITING A PI'S CLIENT AND PARTY DETAILS
--
-- WHY THIS EXISTS
-- ---------------
-- A workbook was imported without a client name. The PI detail screen showed
-- "Not provided", and then the workflow dead-ended: add_pi_submission_payment
-- refuses with ORDER_SUBMISSION_NO_CLIENT, so no money could be attributed, and
-- there was no way anywhere in the product to supply the missing value.
--
-- Imported PI data was being treated as permanently uneditable. It is not
-- supposed to be: a parser reads a human-authored spreadsheet, and a
-- spreadsheet can be incomplete or wrong.
--
-- ── WHY THIS IS ONE SECTION AND NOT THE WHOLE PI ───────────────────────────
--
-- Client and party details ONLY. Deliberately section-focused, for two reasons.
--
-- First, auditability. One RPC covering every field of a PI — header, schedule,
-- products, commercial inputs — would be several hundred lines of branching
-- whose authority and validation nobody could hold in their head at once. The
-- module's own convention is narrow, named write paths.
--
-- Second, these fields are SAFE IN A WAY THE OTHERS ARE NOT. Nothing here feeds
-- a total. A client name, a phone number and an address are recorded as typed
-- and read back as typed; no derived figure moves when one changes. The
-- commercial inputs and the product rows are different in kind — editing a rate
-- must atomically recompute a line total, a subtotal, the pre-GST total, the
-- GST amount and the grand total, and must then reconcile the verified-payment
-- position against the new Grand Total. That belongs in its own migration with
-- its own proofs, not bolted onto this one.
--
-- So this unblocks the reported dead end and nothing more. The remaining
-- sections are recorded as open work rather than half-implemented here.
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- No derived value, no status, no timestamp of record, no approver, no
-- payment, no allocation, no Order number, no PI linkage, no workbook, no
-- workbook hash, no document state, no claim token. The allow-list in §2 is
-- exhaustive and unknown keys are REFUSED rather than ignored.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. A COUNTER, NOT A TIMESTAMP ────────────────────────────────────────────
--
-- Two people editing the same PI must not silently overwrite each other. The
-- caller sends the version it last saw; if the row has moved since, the write
-- is refused and the caller re-reads.
--
-- The first cut of this used `updated_at` for that, and its own assertions
-- caught it failing: `now()` is TRANSACTION-scoped in PostgreSQL, so two writes
-- inside one transaction stamp the identical value and a stale edit compares
-- equal to a fresh one. In production the two edits arrive in separate
-- transactions and the check would usually work — which is worse, not better,
-- because a concurrency guard that holds "usually" is one that fails under
-- exactly the load it exists for. Clock resolution is not a version.
--
-- So: an explicit monotonic counter, incremented by every write that changes
-- anything. It cannot collide, does not depend on the clock, and reads the same
-- inside a transaction as outside one.
--
-- Passing NULL skips the check, and that is deliberate rather than a loophole:
-- a caller that never read the row cannot have a version to assert, and forcing
-- a sentinel would just move the problem. Every caller in this repository sends
-- one, and a test asserts that.

do $$
begin
  if to_regprocedure('public.can_admin_edit_order_submission(uuid)') is null then
    raise exception
      'DEPENDENCY MISSING: 20260927000000 must be applied before this migration';
  end if;
end $$;

alter table public.order_submissions
  add column if not exists row_version integer not null default 0;

comment on column public.order_submissions.row_version is
  'Monotonic edit counter for optimistic concurrency. Incremented by every section editor that changes something. NOT a timestamp: now() is transaction-scoped and cannot distinguish two writes in one transaction.';


-- ── 2. The write path ────────────────────────────────────────────────────────

create or replace function public.update_order_submission_client_details(
  p_submission_id    uuid,
  p_fields           jsonb,
  p_expected_version integer default null,
  p_reason           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_sub        public.order_submissions%rowtype;
  v_is_admin   boolean;
  v_is_owner   boolean;
  v_after_sub  boolean;
  v_reason     text;
  v_key        text;
  v_new        text;
  v_old        text;
  v_changes    jsonb := '{}'::jsonb;
  v_changed    integer := 0;
  v_superseded integer := 0;
  v_version    integer;
  v_client_changed boolean := false;

  -- THE ALLOW-LIST. Every editable field of this section, and nothing else.
  -- A key not on this list is refused, not skipped: silently dropping an
  -- unrecognised field would let a caller believe it saved something it did not.
  c_fields constant text[] := array[
    'client_name', 'contact_number',
    'bill_to_name', 'bill_to_phone', 'bill_to_gst', 'billing_address',
    'ship_to_name', 'ship_to_phone', 'ship_to_gst', 'shipping_address'
  ];

  -- Fields that appear on the confirmed documents. A change to one of these
  -- makes an existing ready pair no longer current; a change to the others
  -- does not, and superseding for them would make people regenerate for nothing.
  c_printed constant text[] := array[
    'client_name', 'bill_to_name', 'billing_address',
    'ship_to_name', 'shipping_address'
  ];
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of fields is required'
      using errcode = 'P0001';
  end if;

  -- THE ROW LOCK COMES FIRST, before any judgement of state, authority or
  -- staleness, so the state every check reads is the state the write lands on.
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- ── Authority ──
  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);

  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  -- ── Optimistic concurrency ──
  --
  -- Checked AFTER the lock and BEFORE any change is computed. Two admins with
  -- the dialog open must not silently overwrite one another; the second is told
  -- to re-read.
  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  -- ── The reason, for an amendment ──
  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;

  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception
        'ORDER_SUBMISSION_REASON_TOO_LONG: the reason may be at most 500 characters'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- ── Every key must be one this function owns ──
  for v_key in select jsonb_object_keys(p_fields) loop
    if not (v_key = any (c_fields)) then
      raise exception
        'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an editable client detail', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
      raise exception
        'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  -- ── Compute the change set ──
  --
  -- Blank becomes NULL, matching replace_order_submission_parse exactly, so a
  -- field cleared by hand and a field the parser never found are the same
  -- state. Anything else would make "empty" mean two different things.
  for v_key in select unnest(c_fields) loop
    continue when not (p_fields ? v_key);

    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');

    if v_new is not null and length(v_new) > 500 then
      raise exception
        'ORDER_SUBMISSION_FIELD_TOO_LONG: % may be at most 500 characters', v_key
        using errcode = 'P0001';
    end if;

    execute format('select ($1).%I::text', v_key) into v_old using v_sub;

    if v_new is distinct from v_old then
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('from', v_old, 'to', v_new));
      if v_key = 'client_name' then v_client_changed := true; end if;
    end if;
  end loop;

  -- ── A reviewable PI must keep its client name ──
  --
  -- order_submissions_reviewable_is_complete already forbids this, but a CHECK
  -- violation reaches the caller as a constraint name. Saying it here means the
  -- reader is told what is wrong instead of being handed a catalog identifier.
  if v_changes ? 'client_name'
     and (v_changes -> 'client_name' ->> 'to') is null
     and v_sub.status not in ('draft', 'needs_changes') then
    raise exception
      'ORDER_SUBMISSION_CLIENT_NAME_REQUIRED: a PI that has been submitted must keep a client name'
      using errcode = 'P0001';
  end if;

  -- NOTHING CHANGED: no write, no event, no supersession. The same rule the
  -- billing percentage follows, for the same reason — a save that changed
  -- nothing is not an amendment and must not read like one in the trail.
  if v_changed = 0 then
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'changed',       false,
      'fields',        0,
      'row_version',   v_sub.row_version,
      'superseded_documents', 0
    );
  end if;

  -- ── The write ──
  --
  -- Each column takes its new value only when the caller SENT that key, so a
  -- partial object edits exactly what it names and leaves the rest alone. An
  -- absent key is not the same as a null one, and this is where that holds.
  update public.order_submissions set
    client_name      = case when p_fields ? 'client_name'      then nullif(btrim(coalesce(p_fields ->> 'client_name', '')), '')      else client_name      end,
    contact_number   = case when p_fields ? 'contact_number'   then nullif(btrim(coalesce(p_fields ->> 'contact_number', '')), '')   else contact_number   end,
    bill_to_name     = case when p_fields ? 'bill_to_name'     then nullif(btrim(coalesce(p_fields ->> 'bill_to_name', '')), '')     else bill_to_name     end,
    bill_to_phone    = case when p_fields ? 'bill_to_phone'    then nullif(btrim(coalesce(p_fields ->> 'bill_to_phone', '')), '')    else bill_to_phone    end,
    bill_to_gst      = case when p_fields ? 'bill_to_gst'      then nullif(btrim(coalesce(p_fields ->> 'bill_to_gst', '')), '')      else bill_to_gst      end,
    billing_address  = case when p_fields ? 'billing_address'  then nullif(btrim(coalesce(p_fields ->> 'billing_address', '')), '')  else billing_address  end,
    ship_to_name     = case when p_fields ? 'ship_to_name'     then nullif(btrim(coalesce(p_fields ->> 'ship_to_name', '')), '')     else ship_to_name     end,
    ship_to_phone    = case when p_fields ? 'ship_to_phone'    then nullif(btrim(coalesce(p_fields ->> 'ship_to_phone', '')), '')    else ship_to_phone    end,
    ship_to_gst      = case when p_fields ? 'ship_to_gst'      then nullif(btrim(coalesce(p_fields ->> 'ship_to_gst', '')), '')      else ship_to_gst      end,
    shipping_address = case when p_fields ? 'shipping_address' then nullif(btrim(coalesce(p_fields ->> 'shipping_address', '')), '') else shipping_address end,
    row_version      = row_version + 1,
    updated_at       = now()
  where id = p_submission_id
  returning row_version into v_version;

  -- ── The linked Order carries the client's name ──
  --
  -- orders.client_name is written at approval from the PI's value. Leaving it
  -- behind would make the Order state a name its own PI no longer says.
  -- NOTHING ELSE on the Order is touched: not the number, not the link, not a
  -- total, not an allocation, not a payment.
  if v_sub.order_id is not null and v_client_changed then
    update public.orders
       set client_name = (v_changes -> 'client_name' ->> 'to'),
           updated_at  = now()
     where id = v_sub.order_id;
  end if;

  -- ── Ready documents stop being current ──
  if v_sub.order_id is not null
     and exists (select 1 from unnest(c_printed) k where v_changes ? k) then
    v_superseded := public.supersede_order_documents(v_sub.order_id, 'pi_data_amended');
  end if;

  if v_sub.order_id is not null then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_sub.order_id, v_actor, 'order_client_details_amended',
      jsonb_build_object(
        'fields',   v_changed,
        'changed',  v_changes,
        'by_admin', v_is_admin and not v_is_owner,
        'reason',   v_reason
      )
    );
  end if;

  -- ── The PI's own trail ──
  --
  -- BEFORE AND AFTER, per field, so the record answers "what did it say
  -- before" without anyone having to reconstruct it. Owner and admin edits are
  -- different actions, not one action with a flag.
  --
  -- These are business text fields — names, phones, addresses, tax numbers.
  -- No image bytes and no secret can reach here: the allow-list above admits
  -- ten named text columns and refuses everything else.
  perform public.log_order_submission_activity(
    p_submission_id,
    v_actor,
    case when v_after_sub and not v_is_owner
         then 'client_details_amended_by_admin'
         else 'client_details_updated' end,
    v_sub.status,
    v_sub.status,
    v_reason,
    jsonb_build_object(
      'fields',                v_changed,
      'changed',               v_changes,
      'stage',                 v_sub.status,
      'after_submission',      v_after_sub,
      'superseded_documents',  v_superseded
    )
  );

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'changed',              true,
    'fields',               v_changed,
    'row_version',          v_version,
    'superseded_documents', v_superseded
  );
end;
$$;

comment on function public.update_order_submission_client_details(uuid, jsonb, integer, text) is
  'Edits a PI''s client and party details — the ten named text fields and nothing else. The OWNER may do so in draft/needs_changes; an ACTIVE ADMIN at any stage, with a reason once the PI has been submitted. Optimistic concurrency through p_expected_version, a monotonic counter rather than a timestamp. Touches no derived value, no status, no payment and no document file. A change to a printed field supersedes the linked Order''s ready documents.';

revoke all    on function public.update_order_submission_client_details(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_client_details(uuid, jsonb, integer, text) to authenticated;


-- ── 3. What this migration promises, checked here ────────────────────────────
do $$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'update_order_submission_client_details';

  if v_def is null then
    raise exception 'update_order_submission_client_details was not created';
  end if;
  if v_def !~ 'SET search_path TO ''?public''?, ''?pg_temp''?' then
    raise exception 'update_order_submission_client_details has no fixed search_path';
  end if;

  -- IT MUST NOT WRITE ANYTHING DERIVED. The whole safety argument for this
  -- section rests on nothing here feeding a total, so the claim is checked
  -- rather than trusted.
  for v_def in
    select unnest(array[
      'total_before_gst', 'gst_amount', 'grand_total', 'subtotal_after_discount',
      'gross_product_amount', 'display_number', 'source_order_submission_id',
      'source_workbook_sha256', 'claim_token', 'billing_percentage'
    ])
  loop
    if (select pg_get_functiondef(p.oid)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'update_order_submission_client_details')
       ~ ('\m' || v_def || '\M\s*=')
    then
      raise exception 'the client-details editor assigns %, which is derived or system-owned', v_def;
    end if;
  end loop;

  -- the owner rule is still the owner rule
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'can_edit_order_submission';
  if v_def !~ '''draft''' or v_def !~ 'order_id is null' then
    raise exception 'can_edit_order_submission has been altered; it must remain the owner rule';
  end if;

  raise notice '20260928000000 applied: PI client and party details are editable.';
end $$;

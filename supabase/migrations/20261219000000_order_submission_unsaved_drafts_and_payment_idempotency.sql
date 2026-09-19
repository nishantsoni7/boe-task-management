-- ═══════════════════════════════════════════════════════════════════════════
-- 20261219000000 — Unsaved PI drafts (order_submission), payment idempotency,
--                  rupees and paise
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THREE LAUNCH GAPS (Orders & Finance launch audit, PR #172, 2026-09-19).
--
--   §1  RUPEES AND PAISE, IN THE TABLE. record_payment_with_allocations and
--       record_pi_submission_payment refuse `amount <> round(amount, 2)`;
--       submit_payment_request and edit_payment_request refuse only
--       `amount <= 0`, so 1000.005 — and NaN, which Postgres sorts above every
--       number — was stored as typed. One CHECK now binds every insert and
--       every update, whichever door wrote it, and a BEFORE trigger raises the
--       existing PAYMENT_AMOUNT_INVALID first so a person never sees a raw
--       constraint name. Nothing is rounded: a third decimal is REFUSED.
--
--   §2  ONE SUBMISSION, ONE PAYMENT. No payment door was idempotent. A lost
--       response, a timeout or a refresh followed by a retry recorded the same
--       money twice, and the only protection was a React ref. Each creation
--       door now takes an optional p_idempotency_key:
--
--         * the key is scoped to the ACTOR (auth.uid()), never global;
--         * a transaction-scoped advisory lock on (actor, key) serialises two
--           concurrent calls — the second waits, then reads the first's
--           committed row;
--         * the first call's RESULT is stored with a fingerprint of its
--           normalised payload; a matching retry returns that result
--           unchanged and writes nothing (no payment, allocation, intent,
--           custody event or activity);
--         * the same key with a different payload is refused by name
--           (PAYMENT_IDEMPOTENCY_KEY_REUSED) — never silently "matched";
--         * a NULL key behaves exactly as today, so the frontend that is
--           deployed while this migration lands keeps working unchanged.
--
--       HOW, WITHOUT RESTATING 700 LINES OF DEPLOYED BODIES. Each deployed
--       function is RENAMED to <name>_core, its EXECUTE is revoked from every
--       client role, and a new function with the ORIGINAL name and the original
--       parameters plus `p_idempotency_key uuid default null` wraps it. There is
--       exactly one function per public name afterwards — no PostgREST overload
--       to resolve (PGRST203) — and the bodies Finance has been running are the
--       bodies that still run.
--
--       THE FOURTH DOOR IS CLOSED. finance_payment_requests_own_insert and the
--       default table grant let any signed-in employee INSERT their own pending
--       payment straight through PostgREST, past every RPC and every key. No
--       screen uses it (all four forms write through the RPCs, which are
--       SECURITY DEFINER and need no table privilege). INSERT is revoked by name
--       from anon and authenticated; service_role keeps its default, as on every
--       other Finance table.
--
--   §3  A FAILED PI UPLOAD LEAVES NO EMPTY DRAFT. The upload screen must create
--       the draft row BEFORE the workbook can be stored (the order-files INSERT
--       policy authorises a path by its submission). A failed upload, a
--       rejected workbook or a lost response therefore left an empty "draft"
--       in PI Drafts, and a retry after a lost create response made a second.
--
--         * create_order_submission takes the same kind of key: a retry with
--           it returns the SAME draft instead of creating another;
--         * discard_unsaved_order_submission(id) removes a draft its own
--           creator made that was NEVER SAVED — no stored workbook, no items,
--           no activity beyond its creation, no lease held, no money, no Order,
--           no reserved number, no deletion claim. It refuses (returns
--           discarded=false) for anything else, so the screen may call it after
--           any failure without being trusted to judge which failures count.
--
--   §2b A REPLAY IS STILL AN AUTHORIZED CALL. Before a keyed call looks its
--       key up, assert_finance_payment_door() re-asks the questions the door's
--       own body asks — signed in, active, Finance entry, and the door's
--       permission (finance.allocate for Record Payment; for a PI payment,
--       finance.allocate or the PI's uploader / creator / assigned reviewer) —
--       with the same helpers and the same messages. A deactivated employee, or
--       one who lost the permission, is refused exactly as a first call would
--       be, and is told nothing about whether the key exists.
--
--   §5  SEND BACK FOR CLARIFICATION, THROUGH A DOOR. The Payment Requests review
--       sent "Needs clarification" as a direct table UPDATE, which production
--       refuses (the 20261010000000 reset guard is not SECURITY DEFINER and
--       calls functions authenticated may not execute). The rejection already
--       has its door, reject_finance_payment_request (20261211000000);
--       request_finance_payment_clarification is its sibling, with the same
--       authority, the same self-decision rule and the same lock, and it says
--       whether the row changed.
--
-- WHAT IS UNCHANGED. Every deployed payment body, every allocation rule, RLS on
-- every table, payment immutability, the deletion claim protocol, the PI
-- processing lease and every existing grant except the direct INSERT above.
--
-- DEPENDENCIES: 20260908000000 (create_order_submission),
-- 20261014000000 (the four payment doors as deployed).
-- ═══════════════════════════════════════════════════════════════════════════


-- ── §0. The deployed signatures this migration wraps must be exactly these ──

do $$
begin
  if to_regprocedure('public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)') is null
     or to_regprocedure('public.edit_payment_request(uuid, text, uuid, numeric, date, text, text, text, jsonb)') is null
     or to_regprocedure('public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)') is null
     or to_regprocedure('public.record_pi_submission_payment(uuid, numeric, date, text, text, text)') is null
     or to_regprocedure('public.create_order_submission(text)') is null then
    raise exception 'DEPENDENCY MISSING: 20261014000000 and 20260908000000 must be applied, with their signatures unchanged';
  end if;
  if to_regprocedure('public.submit_payment_request_core(text, uuid, numeric, date, text, text, text, jsonb)') is not null then
    raise exception 'ALREADY APPLIED: submit_payment_request_core exists';
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- §1. Rupees and paise
-- ═══════════════════════════════════════════════════════════════════════════

-- The one rule, in one place. NaN compares GREATER than every number in
-- Postgres (so `NaN > 0` is true) and equal to itself (so `round(NaN,2) = NaN`
-- is true); `< 'Infinity'` is what excludes it, and Infinity itself.
create or replace function public.payment_amount_is_rupees_and_paise(p_amount numeric)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_amount is not null
     and p_amount > 0
     and p_amount < 'Infinity'::numeric
     and p_amount = round(p_amount, 2)
$$;

comment on function public.payment_amount_is_rupees_and_paise(numeric) is
  'True for a finite, positive amount with at most two decimal places. The single statement of the rule the CHECK, the trigger and the payment doors share. 20261219000000.';

-- Only the SECURITY DEFINER doors and this migration call it.
revoke execute on function public.payment_amount_is_rupees_and_paise(numeric) from public, anon, authenticated;

-- PREFLIGHT. A violating row is reported and NOTHING is changed: this migration
-- never rounds, truncates or rewrites a recorded amount.
do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad
    from public.finance_payment_requests
   where not public.payment_amount_is_rupees_and_paise(amount);
  if v_bad > 0 then
    raise exception 'PREFLIGHT FAILED: % payment row(s) hold an amount that is not a positive figure in rupees and paise. Nothing was changed; these rows need an owner decision before this migration can apply.', v_bad;
  end if;
end $$;

-- The friendly refusal, BEFORE the constraint can speak. Named so it sorts
-- first among this table's BEFORE triggers: an invalid amount is refused
-- before a human payment id or anything else is assigned. The rule is written
-- out rather than called: a trigger runs with the WRITER's privileges, and the
-- writer may be a role that holds no EXECUTE on the helper.
create or replace function public.finance_payment_requests_amount_is_rupees_and_paise()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not (new.amount is not null
          and new.amount > 0
          and new.amount < 'Infinity'::numeric
          and new.amount = round(new.amount, 2)) then
    raise exception 'PAYMENT_AMOUNT_INVALID: enter a positive amount in rupees and paise, with no more than two decimal places.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke execute on function public.finance_payment_requests_amount_is_rupees_and_paise()
  from public, anon, authenticated;

drop trigger if exists finance_payment_requests_amount_is_rupees_and_paise on public.finance_payment_requests;
create trigger finance_payment_requests_amount_is_rupees_and_paise
  before insert or update of amount on public.finance_payment_requests
  for each row execute function public.finance_payment_requests_amount_is_rupees_and_paise();

-- The invariant itself. The column is already NOT NULL.
alter table public.finance_payment_requests
  drop constraint if exists finance_payment_requests_amount_rupees_and_paise;
alter table public.finance_payment_requests
  add constraint finance_payment_requests_amount_rupees_and_paise
  check (amount > 0 and amount < 'Infinity'::numeric and amount = round(amount, 2)) not valid;
alter table public.finance_payment_requests
  validate constraint finance_payment_requests_amount_rupees_and_paise;

comment on constraint finance_payment_requests_amount_rupees_and_paise
  on public.finance_payment_requests is
  'A payment is a finite, positive amount in rupees and paise — never more than two decimal places, never NaN. Binds every door and the service role. The trigger of the same name raises PAYMENT_AMOUNT_INVALID first. 20261219000000.';


-- ═══════════════════════════════════════════════════════════════════════════
-- §2. One submission, one payment
-- ═══════════════════════════════════════════════════════════════════════════

create table public.finance_payment_submission_keys (
  actor_id            uuid        not null,
  idempotency_key     uuid        not null,
  door                text        not null
                        check (door in ('submit_payment_request',
                                        'record_payment_with_allocations',
                                        'record_pi_submission_payment')),
  payload_fingerprint text        not null check (payload_fingerprint ~ '^[0-9a-f]{32}$'),
  -- CASCADE: a pending payment its own form removed (the /finance proof
  -- compensation) or an admin deleted takes its key with it, so an honest
  -- resubmission records once rather than replaying a payment that is gone.
  payment_request_id  uuid        not null
                        references public.finance_payment_requests(id) on delete cascade,
  result              jsonb       not null check (jsonb_typeof(result) = 'object'),
  created_at          timestamptz not null default now(),
  primary key (actor_id, idempotency_key)
);

create index finance_payment_submission_keys_payment_idx
  on public.finance_payment_submission_keys (payment_request_id);

comment on table public.finance_payment_submission_keys is
  'One row per payment-creation submission that carried an idempotency key: who, which key, which door, a fingerprint of the normalised payload, the payment it created and the exact result returned. Written and read only by the SECURITY DEFINER payment doors. 20261219000000.';

alter table public.finance_payment_submission_keys enable row level security;
-- No policy: no client reads or writes this table. Revoked BY NAME, because a
-- Supabase project grants every new table to anon and authenticated by default.
revoke all on public.finance_payment_submission_keys from public, anon, authenticated;

-- Take the key's lock and return what it already produced, if anything.
create or replace function public.finance_payment_submission_key_claim(
  p_door text, p_key uuid, p_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row   record;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  -- Serialises two calls with the same (actor, key) until the first commits
  -- or rolls back. The SELECT below is a new statement, so under READ
  -- COMMITTED it sees the first call's committed row.
  perform pg_advisory_xact_lock(
    hashtextextended('finance_payment_submission_key:' || v_actor::text || ':' || p_key::text, 0));

  select k.door, k.payload_fingerprint, k.result into v_row
    from public.finance_payment_submission_keys k
   where k.actor_id = v_actor and k.idempotency_key = p_key;
  if not found then
    return null;
  end if;
  if v_row.door <> p_door or v_row.payload_fingerprint <> p_fingerprint then
    raise exception 'PAYMENT_IDEMPOTENCY_KEY_REUSED: this submission was already recorded with different details. Nothing new was recorded — refresh and check the payment list before entering it again.'
      using errcode = 'P0001';
  end if;
  return v_row.result;
end;
$$;

create or replace function public.finance_payment_submission_key_record(
  p_door text, p_key uuid, p_fingerprint text, p_result jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.finance_payment_submission_keys
    (actor_id, idempotency_key, door, payload_fingerprint, payment_request_id, result)
  values
    (auth.uid(), p_key, p_door, p_fingerprint, (p_result->>'payment_request_id')::uuid, p_result);
end;
$$;

revoke execute on function public.finance_payment_submission_key_claim(text, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.finance_payment_submission_key_record(text, uuid, text, jsonb)
  from public, anon, authenticated;

-- ── §2b. A replay is still an authorized call ──
--
-- The questions each door's deployed body asks before it writes, asked again
-- with the SAME helpers and the SAME messages — not a second, looser rule. Run
-- before the key is looked up, so a caller who may not use the door learns
-- nothing about whether a key exists. It reads; it never writes.
create or replace function public.assert_finance_payment_door(p_door text, p_submission_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Signed in, active and not deleted — the PI door's own first line
  -- (28000 'Authentication required', 42501 'This account is not active').
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   record;
begin
  if p_door = 'submit_payment_request' then
    if not public.module_entry_open('finance') then
      raise exception 'FINANCE_MODULE_CLOSED: the Finance module is not open to you.'
        using errcode = '42501';
    end if;

  elsif p_door = 'record_payment_with_allocations' then
    if not public.module_entry_open('finance') then
      raise exception 'PAYMENT_ENTRY_NOT_PERMITTED: you do not have access to Finance.'
        using errcode = '42501';
    end if;
    if not public.actor_has_module_permission('finance', 'allocate') then
      raise exception
        'PAYMENT_ENTRY_ALLOCATION_NOT_PERMITTED: you do not have permission to allocate payments.'
        using errcode = '42501';
    end if;

  elsif p_door = 'record_pi_submission_payment' then
    select s.submitted_by, s.created_by, s.assigned_to into v_sub
      from public.order_submissions s where s.id = p_submission_id;
    if not coalesce(
      public.actor_has_module_permission('finance', 'allocate')
      or v_sub.submitted_by = v_actor
      or v_sub.created_by   = v_actor
      or v_sub.assigned_to  = v_actor
    , false) then
      raise exception
        'PI_PAYMENT_NOT_PERMITTED: you do not have permission to record a payment against this PI.'
        using errcode = '42501';
    end if;

  else
    raise exception 'unknown payment door %', p_door using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.assert_finance_payment_door(text, uuid) from public, anon, authenticated;

-- ── The deployed bodies, renamed and closed to clients ──
alter function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb)
  rename to submit_payment_request_core;
alter function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb)
  rename to record_payment_with_allocations_core;
alter function public.record_pi_submission_payment(uuid, numeric, date, text, text, text)
  rename to record_pi_submission_payment_core;

revoke execute on function public.submit_payment_request_core(text, uuid, numeric, date, text, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.record_payment_with_allocations_core(numeric, date, text, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function public.record_pi_submission_payment_core(uuid, numeric, date, text, text, text)
  from public, anon, authenticated;

-- ── submit_payment_request (the /finance Payment Request form) ──
create function public.submit_payment_request(
  p_destination     text,
  p_target_id       uuid    default null,
  p_amount          numeric default null,
  p_payment_date    date    default null,
  p_payment_mode    text    default null,
  p_proof_note      text    default null,
  p_sales_note      text    default null,
  p_custody_events  jsonb   default '[]'::jsonb,
  p_idempotency_key uuid    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fp     text;
  v_result jsonb;
begin
  -- The core refuses a missing or non-positive amount itself; this adds the
  -- paise rule to the same friendly code before anything else happens.
  if p_amount is not null and not public.payment_amount_is_rupees_and_paise(p_amount) then
    raise exception 'PAYMENT_AMOUNT_INVALID: enter a positive amount in rupees and paise, with no more than two decimal places.'
      using errcode = 'P0001';
  end if;

  if p_idempotency_key is null then
    return public.submit_payment_request_core(p_destination, p_target_id, p_amount, p_payment_date,
      p_payment_mode, p_proof_note, p_sales_note, p_custody_events);
  end if;

  v_fp := md5(jsonb_build_array(
    'submit_payment_request',
    nullif(btrim(p_destination), ''), p_target_id, trim_scale(p_amount)::text, p_payment_date,
    nullif(btrim(p_payment_mode), ''), nullif(btrim(p_proof_note), ''), nullif(btrim(p_sales_note), ''),
    coalesce(p_custody_events, '[]'::jsonb)
  )::text);

  perform public.assert_finance_payment_door('submit_payment_request');
  v_result := public.finance_payment_submission_key_claim('submit_payment_request', p_idempotency_key, v_fp);
  if v_result is not null then
    return v_result;
  end if;

  v_result := public.submit_payment_request_core(p_destination, p_target_id, p_amount, p_payment_date,
    p_payment_mode, p_proof_note, p_sales_note, p_custody_events);
  perform public.finance_payment_submission_key_record('submit_payment_request', p_idempotency_key, v_fp, v_result);
  return v_result;
end;
$$;

-- ── record_payment_with_allocations (Received Payments: Record Payment) ──
create function public.record_payment_with_allocations(
  p_amount          numeric,
  p_payment_date    date,
  p_payment_mode    text,
  p_client_name     text,
  p_received_in     text    default null,
  p_reference       text    default null,
  p_remarks         text    default null,
  p_allocations     jsonb   default '[]'::jsonb,
  p_custody_events  jsonb   default '[]'::jsonb,
  p_idempotency_key uuid    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fp     text;
  v_result jsonb;
begin
  if p_idempotency_key is null then
    return public.record_payment_with_allocations_core(p_amount, p_payment_date, p_payment_mode,
      p_client_name, p_received_in, p_reference, p_remarks, p_allocations, p_custody_events);
  end if;

  v_fp := md5(jsonb_build_array(
    'record_payment_with_allocations',
    trim_scale(p_amount)::text, p_payment_date, nullif(btrim(p_payment_mode), ''),
    nullif(btrim(p_client_name), ''), nullif(btrim(p_received_in), ''),
    nullif(btrim(p_reference), ''), nullif(btrim(p_remarks), ''),
    coalesce(p_allocations, '[]'::jsonb), coalesce(p_custody_events, '[]'::jsonb)
  )::text);

  perform public.assert_finance_payment_door('record_payment_with_allocations');
  v_result := public.finance_payment_submission_key_claim('record_payment_with_allocations', p_idempotency_key, v_fp);
  if v_result is not null then
    return v_result;
  end if;

  v_result := public.record_payment_with_allocations_core(p_amount, p_payment_date, p_payment_mode,
    p_client_name, p_received_in, p_reference, p_remarks, p_allocations, p_custody_events);
  perform public.finance_payment_submission_key_record('record_payment_with_allocations', p_idempotency_key, v_fp, v_result);
  return v_result;
end;
$$;

-- ── record_pi_submission_payment (the PI Draft's Record Payment) ──
create function public.record_pi_submission_payment(
  p_submission_id   uuid,
  p_amount          numeric,
  p_payment_date    date,
  p_payment_mode    text,
  p_reference       text default null,
  p_remarks         text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fp     text;
  v_result jsonb;
begin
  if p_idempotency_key is null then
    return public.record_pi_submission_payment_core(p_submission_id, p_amount, p_payment_date,
      p_payment_mode, p_reference, p_remarks);
  end if;

  v_fp := md5(jsonb_build_array(
    'record_pi_submission_payment',
    p_submission_id, trim_scale(p_amount)::text, p_payment_date, nullif(btrim(p_payment_mode), ''),
    nullif(btrim(p_reference), ''), nullif(btrim(p_remarks), '')
  )::text);

  perform public.assert_finance_payment_door('record_pi_submission_payment', p_submission_id);
  v_result := public.finance_payment_submission_key_claim('record_pi_submission_payment', p_idempotency_key, v_fp);
  if v_result is not null then
    return v_result;
  end if;

  v_result := public.record_pi_submission_payment_core(p_submission_id, p_amount, p_payment_date,
    p_payment_mode, p_reference, p_remarks);
  perform public.finance_payment_submission_key_record('record_pi_submission_payment', p_idempotency_key, v_fp, v_result);
  return v_result;
end;
$$;

revoke execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid)
  from public, anon;
grant  execute on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid)
  to authenticated;
revoke execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb, uuid)
  from public, anon;
grant  execute on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb, uuid)
  to authenticated;
revoke execute on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text, uuid)
  from public, anon;
grant  execute on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text, uuid)
  to authenticated;

comment on function public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid) is
  'The Payment Request form''s door. submit_payment_request_core (the 20261014000000 body) does the work; this adds the paise rule and, with p_idempotency_key, returns the original result for a retried submission instead of recording it again. 20261219000000.';
comment on function public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb, uuid) is
  'Record Payment''s door. record_payment_with_allocations_core (the 20261014000000 body) does the work; with p_idempotency_key a retried submission returns the original result and records nothing. 20261219000000.';
comment on function public.record_pi_submission_payment(uuid, numeric, date, text, text, text, uuid) is
  'The PI Draft payment door. record_pi_submission_payment_core (the 20261014000000 body) does the work; with p_idempotency_key a retried submission returns the original result and records nothing. 20261219000000.';

-- ── The fourth door: a direct INSERT, past every RPC ──
revoke insert on public.finance_payment_requests from anon, authenticated;
drop policy if exists "finance_payment_requests_own_insert" on public.finance_payment_requests;


-- ═══════════════════════════════════════════════════════════════════════════
-- §3. A failed PI upload leaves no empty draft
-- ═══════════════════════════════════════════════════════════════════════════

create table public.order_submission_creation_keys (
  actor_id        uuid        not null,
  idempotency_key uuid        not null,
  submission_id   uuid        not null references public.order_submissions(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (actor_id, idempotency_key)
);

create index order_submission_creation_keys_submission_idx
  on public.order_submission_creation_keys (submission_id);

comment on table public.order_submission_creation_keys is
  'Which draft an Upload PI attempt created, by (actor, key), so a retried create_order_submission returns that draft instead of a second one. Written and read only by create_order_submission. 20261219000000.';

alter table public.order_submission_creation_keys enable row level security;
revoke all on public.order_submission_creation_keys from public, anon, authenticated;

alter function public.create_order_submission(text) rename to create_order_submission_core;
revoke execute on function public.create_order_submission_core(text) from public, anon, authenticated;

create function public.create_order_submission(
  p_client_name     text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid;
  v_id     uuid;
  v_result jsonb;
begin
  if p_idempotency_key is null then
    return public.create_order_submission_core(p_client_name);
  end if;

  v_actor := public.assert_order_submission_actor();
  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to create an order submission'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('order_submission_creation_key:' || v_actor::text || ':' || p_idempotency_key::text, 0));

  select k.submission_id into v_id
    from public.order_submission_creation_keys k
   where k.actor_id = v_actor and k.idempotency_key = p_idempotency_key;
  if found then
    select jsonb_build_object('id', s.id, 'status', s.status) into v_result
      from public.order_submissions s where s.id = v_id;
    return v_result;
  end if;

  v_result := public.create_order_submission_core(p_client_name);
  insert into public.order_submission_creation_keys (actor_id, idempotency_key, submission_id)
  values (v_actor, p_idempotency_key, (v_result->>'id')::uuid);
  return v_result;
end;
$$;

revoke execute on function public.create_order_submission(text, uuid) from public, anon;
grant  execute on function public.create_order_submission(text, uuid) to authenticated;

comment on function public.create_order_submission(text, uuid) is
  'Creates an empty draft for Upload PI. create_order_submission_core (the 20260908000000 body) does the work; with p_idempotency_key a retried call returns the draft that key already created. 20261219000000.';

-- Removes a draft its own creator made that was never saved. Everything a real
-- draft could hold is a reason to refuse, and a refusal is an answer, not an
-- error: the screen calls this after any failure and the SERVER decides.
create function public.discard_unsaved_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_row   public.order_submissions%rowtype;
begin
  if p_submission_id is null then
    raise exception 'ORDER_SUBMISSION_REQUIRED: name the draft to discard.' using errcode = 'P0001';
  end if;

  -- NOWAIT: anything holding this row (a save in progress) wins, and this
  -- answers "not discarded" rather than waiting behind it.
  begin
    select * into v_row from public.order_submissions where id = p_submission_id for update nowait;
  exception when lock_not_available then
    return jsonb_build_object('discarded', false, 'reason', 'busy');
  end;
  if v_row.id is null then
    return jsonb_build_object('discarded', false, 'reason', 'absent');
  end if;

  if v_row.created_by is distinct from v_actor or v_row.submitted_by is distinct from v_actor then
    raise exception 'ORDER_SUBMISSION_DISCARD_DENIED: only the person who started this upload can discard it.'
      using errcode = '42501';
  end if;

  if v_row.status <> 'draft'
     or v_row.source_workbook_path is not null
     or v_row.processing_token is not null
     or v_row.order_id is not null
     or v_row.reserved_order_number is not null
     or v_row.deletion_claim_token is not null
     or exists (select 1 from public.order_submission_items i where i.submission_id = p_submission_id)
     or exists (select 1 from public.order_submission_activity a
                 where a.submission_id = p_submission_id and a.action <> 'submission_created')
     or exists (select 1 from public.order_pi_versions v where v.submission_id = p_submission_id)
     or exists (select 1 from public.finance_payment_allocations f where f.order_submission_id = p_submission_id)
     or exists (select 1 from public.finance_payment_allocation_intents f where f.order_submission_id = p_submission_id)
     or exists (select 1 from public.orders o where o.source_order_submission_id = p_submission_id) then
    return jsonb_build_object('discarded', false, 'reason', 'saved');
  end if;

  -- The purge marker order_submissions_guard_delete and the activity guard
  -- honour, set for THIS row and this transaction only, then cleared.
  perform set_config('boe.order_submission_purge_id', p_submission_id::text, true);
  delete from public.order_submissions where id = p_submission_id;
  perform set_config('boe.order_submission_purge_id', '', true);

  return jsonb_build_object('discarded', true);
end;
$$;

revoke execute on function public.discard_unsaved_order_submission(uuid) from public, anon;
grant  execute on function public.discard_unsaved_order_submission(uuid) to authenticated;

comment on function public.discard_unsaved_order_submission(uuid) is
  'Removes a draft its own creator started and never saved (no workbook, no items, no activity beyond creation, no lease, no money, no Order, no reserved number, no deletion claim). Returns discarded=false for anything else. Used by Upload PI after a failed save. 20261219000000.';


-- ═══════════════════════════════════════════════════════════════════════════
-- §5. Send back for clarification — the sibling of reject_finance_payment_request
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.request_finance_payment_clarification(
  p_request_id uuid,
  p_note       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_req   public.finance_payment_requests%rowtype;
  v_now   timestamptz := now();
begin
  if v_actor is null then
    raise exception 'Authentication required to send a payment back for clarification'
      using errcode = '28000';
  end if;

  -- The SAME authority as approving and rejecting (active, finance.approve),
  -- and nothing wider.
  if not public.actor_has_module_permission('finance', 'approve') then
    raise exception 'Only a payment verifier may send a payment back for clarification'
      using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'PAYMENT_CLARIFICATION_NOTE_REQUIRED: say what needs clarifying before sending the payment back.'
      using errcode = '22023';
  end if;

  select * into v_req
  from public.finance_payment_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Payment request % not found', p_request_id
      using errcode = 'P0002';
  end if;

  -- Separation of entry and decision, as reject_finance_payment_request.
  if v_req.submitted_by = v_actor
     and not exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin') then
    raise exception 'PAYMENT_SELF_DECISION_FORBIDDEN: payment % was recorded by you; another payment verifier must decide it',
      v_req.request_number
      using errcode = '42501';
  end if;

  -- STALE IS AN ANSWER. Decided (or sent back) by someone else since the
  -- reviewer opened it: nothing changes, and the caller is told so.
  if v_req.status <> 'pending_approval' then
    return jsonb_build_object('changed', false, 'request_id', v_req.id,
                              'request_number', v_req.request_number, 'status', v_req.status);
  end if;

  -- One statement, so the activity and timeline triggers record this verifier.
  update public.finance_payment_requests
     set status     = 'needs_clarification',
         admin_note = v_note,
         updated_at = v_now
   where id = p_request_id;

  return jsonb_build_object('changed', true, 'request_id', v_req.id,
                            'request_number', v_req.request_number, 'status', 'needs_clarification');
end;
$$;

comment on function public.request_finance_payment_clarification(uuid, text) is
  'Sends a pending payment back for clarification, for a caller holding finance.approve who did not record it (admins excepted). Requires a note, locks the row, and returns changed=false — writing nothing — when the payment is no longer pending. The sibling of reject_finance_payment_request. 20261219000000.';

revoke execute on function public.request_finance_payment_clarification(uuid, text) from public, anon;
grant  execute on function public.request_finance_payment_clarification(uuid, text) to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- §4. Apply-time assertions — the migration refuses itself otherwise
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_name text;
  v_fn   regprocedure;
begin
  -- Exactly one function per public name: no overload for PostgREST to resolve.
  foreach v_name in array array['submit_payment_request', 'record_payment_with_allocations',
                                'record_pi_submission_payment', 'create_order_submission',
                                'discard_unsaved_order_submission', 'request_finance_payment_clarification']
  loop
    if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = v_name) <> 1 then
      raise exception 'ASSERTION FAILED: public.% is not exactly one function', v_name;
    end if;
  end loop;

  -- Every client-callable door: SECURITY DEFINER, a fixed search_path,
  -- authenticated only.
  foreach v_fn in array array[
      'public.submit_payment_request(text, uuid, numeric, date, text, text, text, jsonb, uuid)'::regprocedure,
      'public.record_payment_with_allocations(numeric, date, text, text, text, text, text, jsonb, jsonb, uuid)'::regprocedure,
      'public.record_pi_submission_payment(uuid, numeric, date, text, text, text, uuid)'::regprocedure,
      'public.create_order_submission(text, uuid)'::regprocedure,
      'public.discard_unsaved_order_submission(uuid)'::regprocedure,
      'public.request_finance_payment_clarification(uuid, text)'::regprocedure]
  loop
    if not (select prosecdef from pg_proc where oid = v_fn)
       or not exists (select 1 from pg_proc where oid = v_fn
                        and proconfig @> array['search_path=public, pg_temp']) then
      raise exception 'ASSERTION FAILED: % is not SECURITY DEFINER with a fixed search_path', v_fn;
    end if;
    if not has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or has_function_privilege('anon', v_fn, 'EXECUTE') then
      raise exception 'ASSERTION FAILED: % must be executable by authenticated and not by anon', v_fn;
    end if;
  end loop;

  -- The renamed bodies and the key helpers are unreachable from any client.
  foreach v_fn in array array[
      'public.submit_payment_request_core(text, uuid, numeric, date, text, text, text, jsonb)'::regprocedure,
      'public.record_payment_with_allocations_core(numeric, date, text, text, text, text, text, jsonb, jsonb)'::regprocedure,
      'public.record_pi_submission_payment_core(uuid, numeric, date, text, text, text)'::regprocedure,
      'public.create_order_submission_core(text)'::regprocedure,
      'public.finance_payment_submission_key_claim(text, uuid, text)'::regprocedure,
      'public.finance_payment_submission_key_record(text, uuid, text, jsonb)'::regprocedure,
      'public.assert_finance_payment_door(text, uuid)'::regprocedure,
      'public.finance_payment_requests_amount_is_rupees_and_paise()'::regprocedure]
  loop
    if has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or has_function_privilege('anon', v_fn, 'EXECUTE') then
      raise exception 'ASSERTION FAILED: % is executable by a client role', v_fn;
    end if;
  end loop;

  -- The key tables are closed to clients.
  foreach v_name in array array['finance_payment_submission_keys', 'order_submission_creation_keys']
  loop
    if has_table_privilege('authenticated', 'public.' || v_name, 'SELECT')
       or has_table_privilege('authenticated', 'public.' || v_name, 'INSERT')
       or has_table_privilege('anon', 'public.' || v_name, 'SELECT') then
      raise exception 'ASSERTION FAILED: public.% is reachable by a client role', v_name;
    end if;
  end loop;

  -- The direct INSERT door is closed.
  if has_table_privilege('authenticated', 'public.finance_payment_requests', 'INSERT')
     or has_table_privilege('anon', 'public.finance_payment_requests', 'INSERT') then
    raise exception 'ASSERTION FAILED: a client role can still INSERT into finance_payment_requests';
  end if;

  -- The amount rule is bound, validated and says what it should.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.finance_payment_requests'::regclass
                    and conname = 'finance_payment_requests_amount_rupees_and_paise'
                    and convalidated) then
    raise exception 'ASSERTION FAILED: the rupees-and-paise constraint is missing or not validated';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.finance_payment_requests'::regclass
                    and tgname = 'finance_payment_requests_amount_is_rupees_and_paise'
                    and not tgisinternal and tgenabled <> 'D') then
    raise exception 'ASSERTION FAILED: the rupees-and-paise trigger is not bound';
  end if;
  if public.payment_amount_is_rupees_and_paise(1000.005)
     or public.payment_amount_is_rupees_and_paise('NaN'::numeric)
     or public.payment_amount_is_rupees_and_paise('Infinity'::numeric)
     or public.payment_amount_is_rupees_and_paise(0)
     or public.payment_amount_is_rupees_and_paise(-1)
     or public.payment_amount_is_rupees_and_paise(null)
     or not public.payment_amount_is_rupees_and_paise(1000.5)
     or not public.payment_amount_is_rupees_and_paise(1000000.00) then
    raise exception 'ASSERTION FAILED: payment_amount_is_rupees_and_paise decides wrongly';
  end if;

  raise notice '20261219000000: payment doors keyed and wrapped, direct INSERT closed, amounts are rupees and paise, unsaved PI drafts can be discarded by their creator';
end $$;

notify pgrst, 'reload schema';

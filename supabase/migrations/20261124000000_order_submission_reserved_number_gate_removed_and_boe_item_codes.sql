-- ════════════════════════════════════════════════════════════════════════════
-- The PI Excel is no longer required to print the reserved Order number, and
-- BOE now assigns permanent operational product codes at Order confirmation
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE BUSINESS DECISION. A submitted PI may already have a reserved Order
-- number, but assign_order_display_number() (20261009000000 §7, restated by
-- 20261121000000's own assertions as still asking the rule) has refused to
-- create the Confirmed Order until Sales edits the ORIGINAL PI Excel, types
-- the reserved number into it, and re-uploads it through Change PI. The PI
-- Excel is a commercial source document; it does not need to carry the
-- Order's operational identity. That identity is now assigned by BOE, inside
-- the application, the moment the Order is confirmed.
--
-- WHAT THIS FILE CHANGES.
--
--   1. assign_order_display_number() — re-emitted WITHOUT the call to
--      order_submission_revised_pi_refusal() and its three refusals
--      (REVISED_PI_MISSING / REVISED_PI_NO_NUMBER / REVISED_PI_NUMBER_MISMATCH).
--      A reserved number still becomes the Order's display_number, still
--      exactly once, still refusing a used or already-taken reservation.
--      Nothing about the allocator, the cycle, the reservation's uniqueness or
--      its permanence moves.
--
--   2. order_operational_number(text) — a new, pure display function. The
--      STORED display_number keeps its four-digit, zero-padded shape
--      (`'0524'`) — untouched: the CHECK constraint, the unique index, every
--      function that already reads or writes it, and every historical Order
--      number are all left exactly as they are. Only what a human is shown
--      changes: '0524' is read out as '524'. This is chosen over migrating
--      the stored column itself because dozens of functions across ten weeks
--      of migrations format, compare or restate display_number as a 4-digit
--      string, and a storage-format migration would have to touch every one
--      of them for a requirement that is, in the business's own words, about
--      what "users should see and refer to" — a display concern, not a
--      storage one.
--
--   3. public.order_product_codes — a new table. BOE item codes (BE001,
--      BE002, ...) and the combined Order Product Code (524-BE001) did not
--      exist before this file: 20260908000000 deliberately never composed
--      {order_number}-{item_sequence}, and there is no order_items table —
--      an Order's line items are, and remain, order_submission_items reached
--      through orders.source_order_submission_id. This table is the first
--      place a permanent per-item code is actually stored.
--
-- WHY A NEW TABLE, KEYED ON THE ITEM ROW'S OWN id, RATHER THAN ON
-- source_product_code OR item_sequence.
--
-- Both candidate "business keys" are workbook template artifacts, not product
-- identity: masterSheetParser.ts documents, in its own words, that column A
-- (source_product_code) and column J (item_sequence) can carry a
-- formula-derived value "while holding no product at all" — they name a ROW
-- POSITION in the template, not the product occupying it. Matching a
-- revision's new rows back to old permanent codes by either field would risk
-- silently attaching a previously-issued code to an unrelated product.
--
-- order_submission_items.id IS trustworthy, but only across an edit that
-- never deletes the row. update_order_submission_item_details() (20261002000000)
-- is exactly that: it UPDATEs item_sequence, source_product_code, product_name,
-- dimensions, material and customization in place, by id, and never touches
-- money, sort_order or the row's existence. A code anchored to id survives
-- that path perfectly, with no matching heuristic at all.
--
-- A revision that changes QUANTITY OR PRICE has no such path: money edits are
-- refused by that RPC ("this system cannot recompute what the money becomes")
-- and can only happen through a full workbook re-parse
-- (replace_order_submission_parse, called by Change PI and by
-- approve_order_pi_revision for a PI that already has an Order), which
-- deletes every order_submission_items row for the submission and reinserts
-- fresh ones with fresh ids. For that path, this migration deliberately does
-- NOT invent a fuzzy match: a code's submission_item_id is set to NULL by the
-- foreign key below when its row is deleted, the code itself is NEVER deleted
-- and NEVER reassigned to a different item, and assign_order_product_codes()
-- (added by this file, called from approve_order_submission() and
-- approve_order_pi_revision()) gives every row that has no code yet — which,
-- after such a reparse, is every current row — the next unused sequence for
-- that Order. Freeze what was issued; re-issue what is now current. A
-- money-changing revision therefore does not keep the OLD item's code
-- visually attached to the reparsed row, but no code is ever reused, and
-- every one that was ever issued remains on the Order's permanent record.
-- This is a reported, deliberate limitation, not an oversight: the source
-- document has no field that reliably answers "is this the same product"
-- across a full re-parse, and inventing one would be the "risky mapping
-- scheme" this work was asked not to build.
--
-- WHAT THIS FILE DOES NOT CHANGE.
--
--   * order_submission_revised_pi_refusal() itself, and
--     order_submissions_require_revised_pi_on_submit() — both untouched.
--     The rule they encode simply stops being asked by the Order door too.
--   * PI approval permission, payment verification, the 40% gate, the
--     advance-exception path, their independence from each other, exactly-once
--     Order creation, Order-number uniqueness/permanence/non-reuse, audit
--     history, PI version history, server-side permissions, Production
--     Alignment, the amendment guards. None of those functions are restated.
--   * No permission is granted or revoked beyond what a brand-new,
--     server-only table and function need to exist safely.

begin;

-- ── 0. Refuse to apply over a database that is not the one this assumes ─────

do $$
declare
  v_missing text[] := array[]::text[];
  v_fn      text;
begin
  foreach v_fn in array array[
    'public.assign_order_display_number()',
    'public.order_submission_revised_pi_refusal(text, text, text, text)',
    'public.approve_order_submission(uuid)',
    'public.approve_order_pi_revision(uuid, uuid, jsonb)',
    'public.order_submission_items',
    'public.orders'
  ] loop
    if v_fn like '%(%' then
      if to_regprocedure(v_fn) is null then v_missing := v_missing || v_fn; end if;
    else
      if to_regclass(v_fn) is null then v_missing := v_missing || v_fn; end if;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'DEPENDENCY MISSING: % — this migration cannot run without it',
      array_to_string(v_missing, ', ');
  end if;

  if pg_get_functiondef(to_regprocedure('public.assign_order_display_number()'))
       not like '%order_submission_revised_pi_refusal%' then
    raise exception
      'PRECONDITION FAILED: assign_order_display_number() does not ask order_submission_revised_pi_refusal(), so there is nothing here to remove';
  end if;
end $$;

-- ── 1. assign_order_display_number(), without the revised-PI question ───────
--
-- 20261009000000 §7 as it stood (re-emitted unchanged since), minus exactly
-- the v_refusal declaration, the call to order_submission_revised_pi_refusal()
-- and the raise that acted on it. Everything else — the approval-context
-- check, the "no reservation" refusal, the "already used" refusal, the
-- uniqueness refusal, the fallback to the shared cycle — is unchanged.

create or replace function public.assign_order_display_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub public.order_submissions%rowtype;
begin
  if new.source_order_submission_id is not null then
    select * into v_sub
    from public.order_submissions
    where id = new.source_order_submission_id;

    if found and (v_sub.reserved_order_number is not null or v_sub.reservation_required) then
      if not public.in_pi_submission_approval(new.source_order_submission_id) then
        raise exception
          'ORDER_FROM_RESERVED_PI_REQUIRES_APPROVAL: an Order for this PI can only be created by approving it'
          using errcode = '42501';
      end if;

      if v_sub.reserved_order_number is null then
        raise exception
          'ORDER_SUBMISSION_RESERVATION_REQUIRED: this PI has no reserved Order number, and one is required before it can become an Order'
          using errcode = 'P0001';
      end if;

      if v_sub.reserved_order_number_used_at is not null then
        raise exception
          'ORDER_SUBMISSION_CONVERTED: the number reserved for this PI has already been taken by an Order'
          using errcode = 'P0001';
      end if;

      -- THE REMOVED STEP. This door no longer asks whether the stored
      -- workbook was re-parsed since the reservation, or whether it carries
      -- the reserved number at all — that rule is not asked here any more.
      -- The PI Excel is a commercial source document; the Order's
      -- operational number is assigned by BOE, not printed by Sales.

      if exists (select 1 from public.orders o where o.display_number = v_sub.reserved_order_number) then
        raise exception
          'ORDER_NUMBER_RESERVATION_IN_USE: Order number % was reserved for this PI but is already in use',
          v_sub.reserved_order_number
          using errcode = 'P0001';
      end if;

      new.display_number := v_sub.reserved_order_number;
      return new;
    end if;
  end if;

  new.display_number := public.allocate_confirmed_order_number();
  return new;
end;
$$;

comment on function public.assign_order_display_number() is
  'BEFORE INSERT trigger on public.orders. An Order created from a PI holding a reservation takes that reserved number (refusing an unused-but-missing reservation, a reservation already consumed, or a number already in use); every other Order takes the next number from the shared cycle. Does not require the source PI workbook to carry the reserved number (20261124000000) — that requirement was removed, not moved.';

-- ── 2. order_operational_number(text): the display-only, unpadded number ────

create or replace function public.order_operational_number(p_number text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(ltrim(p_number, '0'), '')
$$;

comment on function public.order_operational_number(text) is
  'The Order number as BOE now shows and refers to it: the stored, permanent, zero-padded display_number (''0524'') with its leading zeros dropped for display (''524''). Never changes what is stored, compared or allocated — display_number, its CHECK constraint, its unique index and every allocator function are untouched. Pure and total: null in, null out; a value with no non-zero digit (never possible under the current CHECK) reads as null rather than an empty string.';

revoke execute on function public.order_operational_number(text) from public, anon;
grant  execute on function public.order_operational_number(text) to authenticated;

-- ── 3. BOE item codes: a new, additive table ─────────────────────────────────

create table public.order_product_codes (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders(id) on delete cascade,
  -- SET NULL, deliberately, not CASCADE: a code that has been issued is never
  -- deleted, even once the item row it was issued for is gone (a money-driven
  -- reparse deletes and reinserts every order_submission_items row). The code
  -- becomes an orphaned, permanently-retired entry — never reused — rather
  -- than disappearing along with the row.
  submission_item_id    uuid references public.order_submission_items(id) on delete set null,
  boe_sequence          integer not null check (boe_sequence > 0),
  -- Captured AT ISSUANCE, from the item row that earned the code. Kept even
  -- after submission_item_id goes null, so the traceability this exists for
  -- does not disappear along with the row that prompted it.
  source_product_code   text,
  source_item_sequence  text,
  created_at            timestamptz not null default now(),
  created_by            uuid references public.users(id),
  unique (order_id, submission_item_id),
  unique (order_id, boe_sequence)
);

comment on table public.order_product_codes is
  'Permanent BOE item codes (BE001, BE002, ...) for a Confirmed Order''s product lines, assigned only once an Order exists (assign_order_product_codes(), called from approve_order_submission() and approve_order_pi_revision()). boe_sequence is issued once per submission_item_id and never reused for that Order, even once the item row it names is gone: reordering, a descriptive-only edit (update_order_submission_item_details, which never changes an item''s id) and a genuinely new line all leave every existing code exactly as it is. A revision that changes quantity or price can only reach the Order through a full workbook re-parse, which deletes and reinserts every order_submission_items row with fresh ids; this table does not attempt to match the new rows back to the old ones by source_product_code or item_sequence (both are documented, in masterSheetParser.ts, as workbook-template row-position artifacts, not product identity). Its codes go permanently orphaned instead — submission_item_id set to null, never deleted, never reassigned — and the reparsed rows receive fresh, never-before-issued sequence numbers.';

comment on column public.order_product_codes.source_product_code is
  'The workbook''s own column-A code (e.g. "B001") at the moment this BOE code was issued. Traceability only — never the identity a code is matched on.';

create index order_product_codes_order_idx on public.order_product_codes (order_id);

alter table public.order_product_codes enable row level security;

create or replace function public.can_view_order(p_order_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  -- A subquery against public.orders is evaluated under the CALLING role's own
  -- row security, so this automatically grants exactly the same visibility as
  -- the Order itself — whatever mix of ownership and orders.view_all applies
  -- — without restating that rule here.
  select exists (select 1 from public.orders o where o.id = p_order_id);
$$;

comment on function public.can_view_order(uuid) is
  'Whether the calling role can see Order p_order_id — i.e. whether a row for it is visible under public.orders'' own row security. SECURITY INVOKER, deliberately: it must run as the caller, not as this function''s owner, or every Order would appear visible to everybody.';

revoke execute on function public.can_view_order(uuid) from public, anon;
grant  execute on function public.can_view_order(uuid) to authenticated;

create policy "order_product_codes_select" on public.order_product_codes
  for select to authenticated
  using (public.can_view_order(order_id));

comment on policy "order_product_codes_select" on public.order_product_codes is
  'Visible to anyone who can see the Order itself (public.can_view_order) — the product codes are part of what viewing an Order shows, not a separately-gated fact.';

-- No insert/update/delete policy for any client role: every write goes
-- through assign_order_product_codes(), called only from already-authorized,
-- SECURITY DEFINER approval functions.

revoke all on public.order_product_codes from public, anon, authenticated;
grant select on public.order_product_codes to authenticated;

-- ── 4. assign_order_product_codes(): the one place a code is ever issued ────

create or replace function public.assign_order_product_codes(p_order_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission_id uuid;
  v_next          integer;
  v_assigned      jsonb := '[]'::jsonb;
  v_item          record;
begin
  select source_order_submission_id into v_submission_id
  from public.orders where id = p_order_id for update;

  -- No PI behind this Order: nothing to code. (Every Order created through
  -- approve_order_submission() names one; this guards a caller that does not.)
  if v_submission_id is null then
    return v_assigned;
  end if;

  select coalesce(max(boe_sequence), 0) into v_next
  from public.order_product_codes where order_id = p_order_id;

  -- Every CURRENT item that does not already hold a code for this Order —
  -- which, the first time this runs, is all of them, and after a reparse is
  -- exactly the fresh rows the old codes were never matched to. Ordered by
  -- the document's own layout so a first assignment reads top-to-bottom.
  for v_item in
    select i.id, i.source_product_code, i.item_sequence
    from public.order_submission_items i
    where i.submission_id = v_submission_id
      and not exists (
        select 1 from public.order_product_codes c
        where c.order_id = p_order_id and c.submission_item_id = i.id
      )
    order by i.sort_order, i.source_row
  loop
    v_next := v_next + 1;
    insert into public.order_product_codes (
      order_id, submission_item_id, boe_sequence,
      source_product_code, source_item_sequence, created_by
    ) values (
      p_order_id, v_item.id, v_next,
      v_item.source_product_code, v_item.item_sequence, p_actor
    );
    v_assigned := v_assigned || jsonb_build_object(
      'submission_item_id', v_item.id,
      'boe_sequence',       v_next,
      'boe_item_code',      'BE' || lpad(v_next::text, 3, '0')
    );
  end loop;

  return v_assigned;
end;
$$;

comment on function public.assign_order_product_codes(uuid, uuid) is
  'Gives every CURRENT product line of Order p_order_id that does not already hold one the next unused BOE item code (BE001, BE002, ...) for that Order, and returns what it just assigned as jsonb (empty if nothing was outstanding). Never reassigns, never reuses and never touches a code already issued. Internal only — called from approve_order_submission() at Order creation and from approve_order_pi_revision() after a post-approval PI reparse; not client-callable.';

revoke all on function public.assign_order_product_codes(uuid, uuid) from public, anon, authenticated;

-- ── 5. approve_order_submission(): re-emitted, with one call added ──────────
--
-- RE-EMITTED IN FULL from 20261119000000 §9. Identical in every respect but
-- one: immediately after the Order is inserted, assign_order_product_codes()
-- gives its product lines their permanent BOE item codes, and — only when it
-- assigned at least one — a dedicated activity-log entry records what was
-- issued. Nothing about authorization, the payment gate, the PI-approval
-- stamp, the allocation move or the PI-version row changes.

create or replace function public.approve_order_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := public.assert_order_submission_actor();
  v_sub          public.order_submissions%rowtype;
  v_order_id     uuid;
  v_number       text;
  v_now          timestamptz;
  v_item_count   integer;
  v_bad          integer;
  v_bad_row      integer;
  v_client       text;
  v_verified     numeric;
  v_unverified   numeric;
  v_required     numeric;
  v_shortfall    numeric;
  v_route        text;
  v_exception_current boolean;
  v_moved_count  integer := 0;
  v_moved_amount numeric := 0;
  v_stranded     integer;
  v_pi_stamped   boolean := false;
  v_codes        jsonb;
begin
  -- ── 1. Authorization, server-side, before anything is read ──
  if not public.actor_has_module_permission('orders', 'approve_order') then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  -- ── 2. The lock, before any mutable state is judged ──
  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- ── 3. Already approved: answer with what exists ──
  if v_sub.status = 'approved' and v_sub.order_id is not null then
    select o.display_number into v_number
    from public.orders o where o.id = v_sub.order_id;

    return jsonb_build_object(
      'submission_id',    p_submission_id,
      'order_id',         v_sub.order_id,
      'display_number',   v_number,
      'already_approved', true
    );
  end if;

  -- ── 4. A deletion reservation freezes the record for everybody ──
  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  -- ── 5. Only a submitted PI can be approved ──
  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if v_sub.order_id is not null then
    raise exception
      'ORDER_SUBMISSION_ALREADY_LINKED: this PI is already linked to an Order'
      using errcode = 'P0001';
  end if;

  -- ── 6. Finance verification must be CURRENT ──
  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
      using errcode = 'P0001';
  end if;

  v_now := now();

  -- ── 6b. The PI decision, if it has not been taken against this submission ──
  if not public.order_submission_pi_approved(
       v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at) then
    update public.order_submissions
       set pi_approved_by            = v_actor,
           pi_approved_at            = v_now,
           pi_approved_submission_at = v_sub.submitted_at
     where id = p_submission_id;
    v_pi_stamped := true;
    v_sub.pi_approved_by            := v_actor;
    v_sub.pi_approved_at            := v_now;
    v_sub.pi_approved_submission_at := v_sub.submitted_at;
  end if;

  -- ── 6a. The total the requirement is a percentage of ──
  if v_sub.grand_total is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: this PI has no stored grand total'
      using errcode = 'P0001';
  end if;

  -- ── 7. The PAYMENT gate, live, under locks ──
  perform 1
  from public.finance_payment_requests f
  where f.id in (
    select a.payment_request_id
    from public.finance_payment_allocations a
    where a.order_submission_id = p_submission_id
  )
  order by f.id
  for update;

  perform 1
  from public.finance_payment_allocations a
  where a.order_submission_id = p_submission_id
  order by a.id
  for update;

  v_verified   := public.order_submission_verified_payment(p_submission_id);
  v_unverified := public.order_submission_unverified_payment(p_submission_id);
  v_required   := public.order_submission_required_payment(v_sub.grand_total);
  v_shortfall  := public.order_submission_payment_shortfall(v_sub.grand_total, v_verified);

  v_exception_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  if v_verified >= v_required then
    v_route := 'standard';
  elsif v_exception_current then
    v_route := 'exception';
  else
    v_route := null;
  end if;

  if v_route is null then
    if v_sub.advance_exception_status = 'pending' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_PENDING: The reduced-payment exception is still pending.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'rejected' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REJECTED: The reduced-payment exception was rejected. Update the PI before resubmitting.'
        using errcode = 'P0001';
    end if;

    if v_sub.advance_exception_status = 'approved' then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_STALE: The reduced-payment approval was given for different commercial terms and must be approved again.'
        using errcode = 'P0001';
    end if;

    if v_unverified > 0 then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION: Payment is awaiting Finance verification. % more verified payment is required for standard approval, or Admin approval is required to proceed below 40%%.',
        '₹' || to_char(v_shortfall, 'FM999999999990.00')
        using errcode = 'P0001';
    end if;

    raise exception
      'ORDER_SUBMISSION_PAYMENT_INSUFFICIENT: % more verified payment is required for standard approval. Admin approval is required to proceed below 40%%.',
      '₹' || to_char(v_shortfall, 'FM999999999990.00')
      using errcode = 'P0001';
  end if;

  -- ── 8. No blocking diagnostics ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- ── 9. The fields an Order cannot be built without ──
  v_client := nullif(btrim(coalesce(v_sub.client_name, '')), '');
  if v_client is null then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

  -- ── 10. The workbook: shape, then existence, then type ──
  if coalesce(btrim(v_sub.source_workbook_path), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: the uploaded workbook is missing'
      using errcode = 'P0001';
  end if;

  if v_sub.source_workbook_path !~
     ('^submissions/' || p_submission_id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the workbook is not stored under submissions/%/original/', p_submission_id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_sub.source_workbook_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: the PI workbook is missing from storage, or is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  -- ── 11. The product lines still satisfy the submission invariants ──
  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(i.source_row) into v_bad, v_bad_row
  from public.order_submission_items i
  where i.submission_id = p_submission_id
    and (
      select count(*) from public.order_submission_item_images m
      where m.item_id = i.id and m.role = 'representative'
    ) <> 1;

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) do not have exactly one representative image (first at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  select count(*) into v_bad
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and m.storage_path !~
        ('^submissions/' || p_submission_id::text || '/images/' || m.item_id::text
         || '/' || m.role || '/' || m.position::text || '-' || m.sha256
         || '\.(png|jpg|jpeg|webp)$');

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_BAD_IMAGE_PATH: % image path(s) do not name this submission and their own product line',
      v_bad
      using errcode = 'P0001';
  end if;

  select count(*), min(m.anchor_row) into v_bad, v_bad_row
  from public.order_submission_item_images m
  where m.submission_id = p_submission_id
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'order-files'
        and o.name = m.storage_path
        and o.metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    );

  if v_bad > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_NOT_STORED: % image(s) are missing from storage or are not a PNG, JPEG or WEBP (first anchored at row %)',
      v_bad, v_bad_row
      using errcode = 'P0001';
  end if;

  -- ── 12. Everything holds. Open the approval context. ──
  perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true);

  if v_pi_stamped then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
      jsonb_build_object(
        'approved_submission_at', v_sub.submitted_at,
        'order_created',          true
      )
    );
  end if;

  -- ── 13. Exactly one Order ──
  insert into public.orders (
    client_name, requested_by, confirm_date, due_date, total_value, total_product_value,
    billing_percentage,
    created_by, status, source_order_submission_id
  )
  values (
    v_client,
    v_sub.submitted_by,
    coalesce(v_sub.order_confirmation_date, v_now::date),
    v_sub.due_date,
    v_sub.grand_total,
    v_sub.gross_product_amount,
    v_sub.billing_percentage,
    v_actor,
    'running',
    p_submission_id
  )
  returning id, display_number into v_order_id, v_number;

  -- ── 13b. Permanent BOE item codes, assigned the moment the Order exists ──
  v_codes := public.assign_order_product_codes(v_order_id, v_actor);

  -- ── 14. The submission becomes approved, and names its Order ──
  update public.order_submissions
     set status      = 'approved',
         approved_by = v_actor,
         approved_at = v_now,
         order_id    = v_order_id
   where id = p_submission_id;

  -- ── 14a. The money follows the record. It is MOVED, never copied. ──
  with moved as (
    update public.finance_payment_allocations
       set order_submission_id = null,
           order_id            = v_order_id
     where order_submission_id = p_submission_id
       and status = 'active'
    returning allocated_amount
  )
  select count(*), coalesce(sum(allocated_amount), 0)
    into v_moved_count, v_moved_amount
  from moved;

  select count(*) into v_stranded
  from public.finance_payment_allocations
  where order_submission_id = p_submission_id and status = 'active';

  if v_stranded > 0 then
    raise exception
      'ORDER_SUBMISSION_ALLOCATION_NOT_MOVED: % allocation(s) still name this PI after conversion; no Order may be created over stranded money',
      v_stranded
      using errcode = 'P0001';
  end if;

  -- ── 14b. V1 of the Order's PI history: the document it was approved from ──
  insert into public.order_pi_versions (
    order_id, submission_id, version_number, status,
    workbook_path, workbook_name, workbook_sha256,
    uploaded_by, uploaded_at, revision_reason,
    decided_by, decided_at
  ) values (
    v_order_id, p_submission_id, 1, 'approved',
    v_sub.source_workbook_path, v_sub.source_workbook_name, v_sub.source_workbook_sha256,
    coalesce(v_sub.submitted_by, v_sub.created_by), coalesce(v_sub.submitted_at, v_now), null,
    v_actor, v_now
  );

  -- ── 15. Both trails ──
  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'approved', 'submitted', 'approved', null,
    jsonb_build_object(
      'order_id',             v_order_id,
      'order_display_number', v_number,
      'item_count',           v_item_count,
      'payment_route',        v_route,
      'verified_payment',     v_verified,
      'unverified_payment',   v_unverified,
      'attached_payment',     v_verified + v_unverified,
      'required_payment',     v_required,
      'grand_total',          v_sub.grand_total,
      'pi_approved_at',       v_sub.pi_approved_at,
      'pi_approved_by',       v_sub.pi_approved_by
    )
  );

  if v_moved_count > 0 then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'payment_allocations_moved', 'approved', 'approved', null,
      jsonb_build_object(
        'order_id',           v_order_id,
        'allocation_count',   v_moved_count,
        'allocated_total',    v_moved_amount
      )
    );
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (
    v_order_id, v_actor, 'order_created_from_pi_submission',
    jsonb_build_object(
      'order_submission_id',       p_submission_id,
      'item_count',                v_item_count,
      'payment_route',             v_route,
      'moved_allocation_count',    v_moved_count,
      'moved_allocated_total',     v_moved_amount,
      'production_alignment',      'not_aligned'
    )
  );

  if jsonb_array_length(v_codes) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_order_id, v_actor, 'order_product_codes_assigned',
      jsonb_build_object('codes', v_codes)
    );
  end if;

  -- ── 16. Close the context before returning ──
  perform set_config('boe.pi_submission_approval_id', '', true);

  -- ── 17. Identifiers only. Nothing the caller could not already read. ──
  return jsonb_build_object(
    'submission_id',    p_submission_id,
    'order_id',         v_order_id,
    'display_number',   v_number,
    'already_approved', false
  );
end;
$$;

comment on function public.approve_order_submission(uuid) is
  'Approves a submitted PI and creates exactly one Confirmed Order, in one transaction, for a caller holding orders.approve_order. Re-derives every eligibility rule from the locked row: finance verification current, advance requirement settled, no blocking issues, the workbook and every product image still stored, no deletion reservation, not already approved. The Order number comes only from assign_order_display_number(); a failed approval consumes none. Assigns permanent BOE item codes to the Order''s product lines (20261124000000) before it returns. Records no payment of any kind.';

revoke execute on function public.approve_order_submission(uuid) from public, anon;
grant  execute on function public.approve_order_submission(uuid) to authenticated;

-- ── 6. approve_order_pi_revision(): re-emitted, with one call added ─────────
--
-- RE-EMITTED IN FULL from 20261119000000 §7. Identical but for one line, added
-- right after the reparse is confirmed applied: assign_order_product_codes()
-- gives any genuinely new line in the revised set its own permanent code.
-- Every code already issued for a surviving line is untouched — the reparse
-- deletes and reinserts order_submission_items, which orphans (never deletes,
-- never reassigns) the codes of any row that did not come back; see this
-- file's header for why that is deliberate.

create or replace function public.approve_order_pi_revision(
  p_version_id uuid,
  p_actor_id   uuid,
  p_payload    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_admin  boolean;
  v_ver       public.order_pi_versions%rowtype;
  v_current   public.order_pi_versions%rowtype;
  v_order     public.orders%rowtype;
  v_sub       public.order_submissions%rowtype;
  v_path      text;
  v_now       timestamptz := now();
  v_result    jsonb;
  v_payload   jsonb;
  v_codes     jsonb;
begin
  if p_actor_id is null then
    raise exception 'ORDER_SUBMISSION_ACTOR_REQUIRED: an acting employee is required'
      using errcode = '28000';
  end if;

  select coalesce(u.role = 'admin', false) into v_is_admin
  from public.users u
  where u.id = p_actor_id and u.is_active and coalesce(u.is_deleted, false) = false;
  if not found or not coalesce(v_is_admin, false) then
    raise exception 'You do not have permission to decide a revised PI'
      using errcode = '42501';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id;
  if not found then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  select * into v_order from public.orders where id = v_ver.order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    raise exception
      'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled and cannot take a revised PI', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = v_ver.submission_id for update;
  if not found or v_sub.order_id is distinct from v_order.id then
    raise exception
      'ORDER_PI_REVISION_INVALID: the PI behind Order % is not the one this version names', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  if v_ver.status <> 'pending' then
    raise exception
      'ORDER_PI_REVISION_NOT_PENDING: PI version % is % and is no longer waiting for a decision',
      v_ver.version_number, v_ver.status
      using errcode = 'P0001';
  end if;

  select * into v_current from public.order_pi_versions
  where order_id = v_order.id and status = 'approved' for update;

  if v_current.id is not null and v_current.version_number >= v_ver.version_number then
    raise exception
      'ORDER_PI_REVISION_STALE: PI version % is older than the current approved version %',
      v_ver.version_number, v_current.version_number
      using errcode = 'P0001';
  end if;

  v_path := nullif(btrim(coalesce(p_payload -> 'source' ->> 'workbook_path', '')), '');
  if v_path is null or v_path is distinct from v_ver.workbook_path then
    raise exception
      'ORDER_PI_REVISION_FILE_MISMATCH: the parsed workbook is not the file this revision proposed'
      using errcode = 'P0001';
  end if;

  v_payload := p_payload || jsonb_build_object(
    'change_reason', left('PI revision V' || v_ver.version_number::text || ': ' || v_ver.revision_reason, 500));

  perform set_config('boe.amendment_context', 'order_amendment', true);
  v_result := public.replace_order_submission_parse(v_sub.id, p_actor_id, v_payload);
  perform set_config('boe.amendment_context', '', true);

  select source_workbook_path, source_workbook_sha256, source_workbook_name
    into v_sub.source_workbook_path, v_sub.source_workbook_sha256, v_sub.source_workbook_name
  from public.order_submissions where id = v_sub.id;
  if v_sub.source_workbook_path is distinct from v_ver.workbook_path then
    raise exception
      'ORDER_PI_REVISION_NOT_APPLIED: the revised workbook was not recorded on the PI'
      using errcode = 'P0001';
  end if;

  if v_current.id is not null then
    update public.order_pi_versions
       set status = 'superseded',
           superseded_at = v_now,
           superseded_by_version_id = v_ver.id
     where id = v_current.id;
  end if;

  update public.order_pi_versions
     set status = 'approved',
         decided_by = p_actor_id,
         decided_at = v_now,
         workbook_sha256 = coalesce(v_sub.source_workbook_sha256, workbook_sha256)
   where id = v_ver.id;

  -- Genuinely new lines in the revised set get their own permanent code here;
  -- every code already issued for a line that survived the reparse (same
  -- submission_item_id — impossible after a full reparse, since every row is
  -- reinserted with a fresh id) is untouched, and every code whose row did not
  -- come back stays exactly as orphaned-and-retired as it was the instant the
  -- reparse deleted that row.
  v_codes := public.assign_order_product_codes(v_order.id, p_actor_id);

  perform public.log_order_submission_activity(
    v_sub.id, p_actor_id, 'pi_revision_approved', 'approved', 'approved', null,
    jsonb_build_object('order_id', v_order.id, 'version_id', v_ver.id,
                       'version_number', v_ver.version_number,
                       'superseded_version_id', v_current.id,
                       'superseded_version_number', v_current.version_number,
                       'superseded_documents', v_result -> 'superseded_documents')
  );

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, p_actor_id, 'pi_revision_approved',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'superseded_version_number', v_current.version_number,
                             'superseded_documents', v_result -> 'superseded_documents'));

  if jsonb_array_length(v_codes) > 0 then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_order.id, p_actor_id, 'order_product_codes_assigned',
      jsonb_build_object('codes', v_codes, 'version_id', v_ver.id)
    );
  end if;

  return jsonb_build_object(
    'version_id',       v_ver.id,
    'version_number',   v_ver.version_number,
    'order_id',         v_order.id,
    'status',           'approved',
    'superseded_version_number', v_current.version_number,
    'parse',            v_result
  );
end;
$$;

comment on function public.approve_order_pi_revision(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. Approves a pending revised PI for an active admin (re-derived from p_actor_id): applies the server''s parse of the revised workbook through replace_order_submission_parse() — which carries the figures onto the Order, clears a finance verification and supersedes ready documents — marks the previous approved version superseded and this one approved, and gives any genuinely new product line its own permanent BOE item code (20261124000000), in ONE transaction. Refuses a non-pending version, a version older than the current one, a cancelled Order, and a payload whose workbook is not this version''s file.';

revoke execute on function public.approve_order_pi_revision(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.approve_order_pi_revision(uuid, uuid, jsonb) to service_role;

-- ── 7. Read back what was installed ──────────────────────────────────────────

do $$
declare
  v_order_gate text := pg_get_functiondef(to_regprocedure('public.assign_order_display_number()'));
  v_approve    text := pg_get_functiondef(to_regprocedure('public.approve_order_submission(uuid)'));
  v_revision   text := pg_get_functiondef(to_regprocedure('public.approve_order_pi_revision(uuid, uuid, jsonb)'));
  v_rule       text := pg_get_functiondef(to_regprocedure('public.order_submission_revised_pi_refusal(text, text, text, text)'));
begin
  if v_order_gate like '%order_submission_revised_pi_refusal%' then
    raise exception
      'ASSERTION FAILED: assign_order_display_number() still asks the revised-PI rule';
  end if;
  if v_order_gate not like '%ORDER_SUBMISSION_RESERVATION_REQUIRED%'
     or v_order_gate not like '%ORDER_SUBMISSION_CONVERTED%'
     or v_order_gate not like '%ORDER_NUMBER_RESERVATION_IN_USE%' then
    raise exception
      'ASSERTION FAILED: assign_order_display_number() lost a rule it must keep';
  end if;

  -- The rule function itself is untouched by this file — it is simply no
  -- longer called from either door.
  if v_rule not like '%ORDER_SUBMISSION_REVISED_PI_MISSING%'
     or v_rule not like '%ORDER_SUBMISSION_REVISED_PI_NO_NUMBER%'
     or v_rule not like '%ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH%' then
    raise exception
      'ASSERTION FAILED: order_submission_revised_pi_refusal() was altered by a migration that must not touch it';
  end if;

  if v_approve not like '%assign_order_product_codes%' then
    raise exception 'ASSERTION FAILED: approve_order_submission() does not assign product codes';
  end if;
  if v_revision not like '%assign_order_product_codes%' then
    raise exception 'ASSERTION FAILED: approve_order_pi_revision() does not assign product codes';
  end if;

  if to_regclass('public.order_product_codes') is null then
    raise exception 'ASSERTION FAILED: public.order_product_codes was not created';
  end if;

  if (select relrowsecurity from pg_class where oid = 'public.order_product_codes'::regclass) is not true then
    raise exception 'ASSERTION FAILED: public.order_product_codes does not have row level security enabled';
  end if;

  if public.order_operational_number('0524') is distinct from '524' then
    raise exception 'ASSERTION FAILED: order_operational_number(''0524'') must be ''524''';
  end if;
  if public.order_operational_number(null) is not null then
    raise exception 'ASSERTION FAILED: order_operational_number(null) must be null';
  end if;

  raise notice
    'Order door no longer requires the reserved number to be printed in the PI. BOE item codes are assigned at Order confirmation.';
end $$;

commit;

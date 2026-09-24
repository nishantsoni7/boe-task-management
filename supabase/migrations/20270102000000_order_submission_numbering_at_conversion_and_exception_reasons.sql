-- ═══════════════════════════════════════════════════════════════════════════
-- 20270102000000 — A PI Draft is numbered when it becomes an Order, carries its
--                  own internal reference until then, and asks for one of three
--                  reasons below the standard payment.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT CHANGES
--
--   1. DRAFT REFERENCE. Every PI Draft gets a stable internal reference,
--      PID-00001, PID-00002 … from its own sequence. It is what a person reads
--      and quotes about a draft; the row's UUID stays what URLs and payment
--      allocations point at (finance_payment_allocations.order_submission_id),
--      exactly as before. It is NOT an Order number, it never becomes one, and
--      a gap in it (a rolled-back insert) means nothing.
--
--   2. NO RESERVATION FOR A NEW DRAFT. 20261009000000 took a real Confirmed
--      Order number from the one cycle the moment a new draft's workbook was
--      parsed, and never gave it back — so every abandoned, rejected or deleted
--      draft burned a number. From here on:
--        * reservation_required defaults to FALSE for every new row;
--        * the automatic-reservation trigger is dropped;
--        * the compatibility "Reserve Order number" action is retired;
--        * the submit gate no longer asks for a reservation;
--        * assign_order_display_number() gives a PI with no reservation the
--          next number from the cycle — allocate_confirmed_order_number(),
--          under its FOR UPDATE lock, inside the approval transaction. A
--          rolled-back approval rolls the cycle back with it, so a failed or
--          retried approval neither skips nor duplicates a number, and two
--          concurrent approvals serialize on the cycle row.
--
--   3. EXISTING RESERVATIONS ARE KEPT, NOT RE-DECIDED. A draft that already
--      holds a reserved number (production: one, 0525) keeps it, and its Order
--      takes exactly that number at approval, as before — every check in
--      assign_order_display_number() for a held reservation is unchanged. No
--      reservation is released, no reservation_required flag is rewritten, no
--      activity row is touched, and no Confirmed Order is renumbered. A draft
--      that was created under the old rule but never reached a parse (flag
--      true, number null) simply gets its number at approval like a new one.
--
--   4. ONE OF THREE REASONS BELOW 40%. submit_pi_for_review_internal is
--      re-emitted verbatim from 20261224000000 with exactly these edits:
--        * the reason must be 'Against client PO', 'Sample order', or
--          'Other: <remark>' (remark ≥ 10 characters), and its category is
--          stored in the new advance_exception_reason_code;
--        * Payment Terms are no longer REQUIRED on that route (still stored
--          when given, still part of the recorded exception basis).
--      Nothing about the payment gate moves: the route is still chosen on
--      attached payment, the request is still 'pending' until an admin with
--      orders.approve_advance_exception decides it, and approval still counts
--      verified money only and still refuses any pending payment.
--
-- NOTHING HERE touches an Order, an allocation, a payment or an existing
-- activity row. No UPDATE runs against existing data: the draft reference is
-- filled by the column's default during ADD COLUMN, which fires no trigger.

-- ─── 0. Preconditions ──────────────────────────────────────────────────────

do $$
begin
  if to_regprocedure('public.assign_order_display_number()') is null
     or to_regprocedure('public.allocate_confirmed_order_number()') is null
     or to_regprocedure('public.submit_pi_for_review_internal(uuid, text, text, text, text)') is null
     or to_regprocedure('public.order_submissions_require_revised_pi_on_submit()') is null then
    raise exception 'PRECONDITION FAILED: the PI numbering and submission functions this migration replaces are not all present';
  end if;
end $$;


-- ─── 1. The draft reference ────────────────────────────────────────────────

create sequence if not exists public.order_submission_draft_reference_seq
  as bigint start with 1 increment by 1 no cycle;

revoke all on sequence public.order_submission_draft_reference_seq from public, anon, authenticated;

-- A volatile default on ADD COLUMN is evaluated once per existing row while
-- the table is rewritten: every existing draft gets a reference with no UPDATE
-- statement and therefore no trigger (least of all the reservation one).
alter table public.order_submissions
  add column if not exists draft_reference text not null
    default ('PID-' || lpad(nextval('public.order_submission_draft_reference_seq')::text, 5, '0'));

create unique index if not exists order_submissions_draft_reference_uidx
  on public.order_submissions (draft_reference);

alter table public.order_submissions
  drop constraint if exists order_submissions_draft_reference_format;
alter table public.order_submissions
  add constraint order_submissions_draft_reference_format
  check (draft_reference ~ '^PID-[0-9]{5,}$');

comment on column public.order_submissions.draft_reference is
  'The PI Draft''s own internal reference (PID-00001 …), assigned at creation from order_submission_draft_reference_seq and never changed. NOT an Order number and never becomes one: the Confirmed Order number is allocated only when the PI is approved (20270102000000). URLs and payment allocations keep using the row id.';

create or replace function public.order_submissions_draft_reference_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.draft_reference is distinct from old.draft_reference then
    raise exception
      'ORDER_SUBMISSION_DRAFT_REFERENCE_IMMUTABLE: a PI Draft''s reference % is permanent', old.draft_reference
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.order_submissions_draft_reference_immutable()
  from public, anon, authenticated;

drop trigger if exists order_submissions_draft_reference_immutable on public.order_submissions;
create trigger order_submissions_draft_reference_immutable
  before update of draft_reference on public.order_submissions
  for each row execute function public.order_submissions_draft_reference_immutable();


-- ─── 2. No official number for a new draft ─────────────────────────────────

alter table public.order_submissions
  alter column reservation_required set default false;

comment on column public.order_submissions.reservation_required is
  'HISTORICAL. TRUE for drafts created between 20261009000000 and 20270102000000, which reserved a Confirmed Order number when their workbook was first parsed; FALSE otherwise. Since 20270102000000 it decides nothing: a new draft reserves no number, and an Order takes a held reservation when there is one and the next number from the cycle when there is not. Never written by hand.';

-- The automatic reservation. Dropped, not neutered: a trigger that exists and
-- does nothing is one a later re-emission could silently re-arm.
drop trigger if exists order_submissions_auto_reserve_order_number on public.order_submissions;
drop function if exists public.order_submissions_auto_reserve_order_number();

-- The compatibility action for pre-20261009 drafts. Kept as a named refusal
-- (same signature, same grant) so an older browser tab gets words, not a 404.
create or replace function public.reserve_order_number_for_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception
    'ORDER_NUMBER_RESERVATION_RETIRED: PI Drafts no longer reserve an Order number. The Order number is allocated when the PI is approved.'
    using errcode = 'P0001';
end;
$$;

comment on function public.reserve_order_number_for_submission(uuid) is
  'RETIRED by 20270102000000. Always refuses: an Order number is allocated only when a PI is approved. Existing reservations are untouched and still used by their Orders.';

-- The submit gate: nothing left to ask about numbers. Kept as a function (the
-- trigger stays attached) so its history reads in one place.
create or replace function public.order_submissions_require_revised_pi_on_submit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- 20270102000000: a PI no longer needs a reserved Order number to be sent for
  -- review. The number is allocated when the PI is approved.
  return new;
end;
$$;

comment on function public.order_submissions_require_revised_pi_on_submit() is
  'Since 20270102000000 asks nothing: sending a PI for review needs no Order number. Kept attached so the trigger''s history reads in one place.';

-- assign_order_display_number(): 20261124000000 §1 verbatim, minus the one
-- refusal that treated "reservation required but none held" as an error. That
-- PI now takes the next number from the cycle, like every PI without a
-- reservation. Every check on a HELD reservation is unchanged.
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

    -- The approval-context rule is exactly as broad as before: any PI that
    -- holds a reservation or was created under the reservation obligation.
    if found and (v_sub.reserved_order_number is not null or v_sub.reservation_required)
       and not public.in_pi_submission_approval(new.source_order_submission_id) then
      raise exception
        'ORDER_FROM_RESERVED_PI_REQUIRES_APPROVAL: an Order for this PI can only be created by approving it'
        using errcode = '42501';
    end if;

    if found and v_sub.reserved_order_number is not null then
      if v_sub.reserved_order_number_used_at is not null then
        raise exception
          'ORDER_SUBMISSION_CONVERTED: the number reserved for this PI has already been taken by an Order'
          using errcode = 'P0001';
      end if;

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

  -- Everything else — a new PI Draft included — takes the next number from the
  -- one cycle, under its lock, in this transaction.
  new.display_number := public.allocate_confirmed_order_number();
  return new;
end;
$$;

comment on function public.assign_order_display_number() is
  'BEFORE INSERT trigger on public.orders. An Order created from a PI holding a reservation takes that reserved number (refusing a reservation already consumed or a number already in use, and requiring the approval context); every other Order — including every PI Draft created since 20270102000000 — takes the next number from the shared cycle under its FOR UPDATE lock, inside the creating transaction.';


-- ─── 3. The three reasons ──────────────────────────────────────────────────

alter table public.order_submissions
  add column if not exists advance_exception_reason_code text;

alter table public.order_submissions
  drop constraint if exists order_submissions_advance_exception_reason_code_check;
alter table public.order_submissions
  add constraint order_submissions_advance_exception_reason_code_check
  check (advance_exception_reason_code is null
         or advance_exception_reason_code in ('against_client_po', 'sample_order', 'other'));

comment on column public.order_submissions.advance_exception_reason_code is
  'Which of the three reasons the submitter chose for asking to proceed below the standard payment: against_client_po, sample_order or other (whose remark is in advance_exception_reason). Written only by submitting. NULL on the standard route and on requests made before 20270102000000. A category is not a decision: the exception stays pending until an admin decides it.';

-- The one definition of the three, shared by the door and the tests.
create or replace function public.order_submission_exception_reason_code(p_reason text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_reason is null then null
    when btrim(p_reason) = 'Against client PO' then 'against_client_po'
    when btrim(p_reason) = 'Sample order'      then 'sample_order'
    when btrim(p_reason) ~ '^Other: '
         and char_length(btrim(substr(btrim(p_reason), 8))) >= 10 then 'other'
    else null
  end
$$;

comment on function public.order_submission_exception_reason_code(text) is
  'The category of a below-standard-payment reason: ''Against client PO'' → against_client_po, ''Sample order'' → sample_order, ''Other: <remark of 10+ characters>'' → other; anything else → NULL (refused by the submission door). 20270102000000.';

-- Written only in the same statement that submits the PI.
create or replace function public.order_submissions_guard_exception_reason_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.advance_exception_reason_code is distinct from old.advance_exception_reason_code
     and not (new.status = 'submitted' and old.status in ('draft', 'needs_changes')) then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_INVALID: the reason category is set only by submitting the PI'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_exception_reason_code()
  from public, anon, authenticated;

drop trigger if exists order_submissions_guard_exception_reason_code on public.order_submissions;
create trigger order_submissions_guard_exception_reason_code
  before update of advance_exception_reason_code on public.order_submissions
  for each row execute function public.order_submissions_guard_exception_reason_code();


-- ─── 3b. Design Files and Client PO attached BEFORE the PI is sent ─────────
--
-- 20261231000000 lets the owner attach both inside the "Submit for approval"
-- dialog, uploading under pi-documents/{pi}/{document submission}/… and
-- recording them when the PI is sent. This lets the same files be attached
-- EARLIER — right after the upload, or any time while the PI is a draft or
-- returned — so they are not lost between visits.
--
-- NO NEW STORAGE RULE. The objects go to exactly the key the dialog uses, under
-- the id they will later be sent with; 20261231000000's insert policy already
-- allows that (owner, draft or returned, not yet sent) and seals it on send.
-- This table only remembers what each staged object is called and which
-- category it is, because the object key is a UUID. It decides nothing: the
-- files become part of a submission only when submit_pi_for_review_with_
-- documents records them, with every check that function already makes.

create table if not exists public.order_pi_staged_documents (
  id                    uuid primary key default gen_random_uuid(),
  pi_submission_id      uuid not null references public.order_submissions(id) on delete cascade,
  staging_submission_id uuid not null,
  category              text not null check (category in ('design_files', 'client_po')),
  storage_path          text not null unique,
  file_name             text not null check (char_length(btrim(file_name)) between 1 and 200),
  uploaded_by           uuid not null default auth.uid() references public.users(id),
  uploaded_at           timestamptz not null default now(),
  -- The key must be this PI's, under this staging id, in this category.
  constraint order_pi_staged_documents_key check (
    storage_path = 'pi-documents/' || pi_submission_id::text || '/' || staging_submission_id::text
                   || '/' || category || '/' || split_part(storage_path, '/', 5)
  )
);

create index if not exists order_pi_staged_documents_pi_idx
  on public.order_pi_staged_documents (pi_submission_id, staging_submission_id);

comment on table public.order_pi_staged_documents is
  'Design Files and Client PO attached to a PI Draft before it is sent (20270102000000): the name and category of each object already uploaded under pi-documents/{pi}/{staging id}/…. Sending the PI through submit_pi_for_review_with_documents with that staging id records them; this table never makes a file current and never approves anything.';

alter table public.order_pi_staged_documents enable row level security;
revoke all on public.order_pi_staged_documents from public, anon, authenticated;
grant select, insert, delete on public.order_pi_staged_documents to authenticated;

-- Whether the staged object exists and was uploaded by the caller.
create or replace function public.order_pi_staged_object_is_mine(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files' and o.name = p_path and o.owner_id = auth.uid()::text
  );
$$;
revoke execute on function public.order_pi_staged_object_is_mine(text) from public, anon;
grant  execute on function public.order_pi_staged_object_is_mine(text) to authenticated;

drop policy if exists order_pi_staged_documents_select on public.order_pi_staged_documents;
create policy order_pi_staged_documents_select on public.order_pi_staged_documents
  for select to authenticated
  using (public.module_entry_open('orders')
         and coalesce(public.can_view_order_submission(pi_submission_id), false));

-- Recorded only by the person who uploaded the object, while it could still be
-- uploaded (the storage rule, asked of the key), for an object that exists.
drop policy if exists order_pi_staged_documents_insert on public.order_pi_staged_documents;
create policy order_pi_staged_documents_insert on public.order_pi_staged_documents
  for insert to authenticated
  with check (public.module_entry_open('orders')
              and uploaded_by = auth.uid()
              and public.can_write_order_submission_file(pi_submission_id)
              and not exists (select 1 from public.order_document_submissions s where s.id = staging_submission_id)
              and public.order_pi_staged_object_is_mine(storage_path));

-- Taken off the list while still unsent. The stored object stays (no storage
-- delete exists for these keys); it is simply not sent.
drop policy if exists order_pi_staged_documents_delete on public.order_pi_staged_documents;
create policy order_pi_staged_documents_delete on public.order_pi_staged_documents
  for delete to authenticated
  using (public.module_entry_open('orders')
         and public.can_write_order_submission_file(pi_submission_id)
         and not exists (select 1 from public.order_document_submissions s where s.id = staging_submission_id));


-- ─── 4. The submission door, re-emitted from 20261224000000 ────────────────

create or replace function public.submit_pi_for_review_internal(
  p_submission_id uuid,
  p_note          text,
  p_reason        text,
  p_payment_terms text,
  p_billing_terms text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_sub        public.order_submissions%rowtype;
  v_item_count integer;
  v_incomplete integer;
  v_bad        integer;
  v_bad_row    integer;
  v_note       text := nullif(btrim(coalesce(p_note, '')), '');
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_pay_terms  text := nullif(btrim(coalesce(p_payment_terms, '')), '');
  v_bill_terms text := nullif(btrim(coalesce(p_billing_terms, '')), '');
  v_verified   numeric;
  v_unverified numeric;
  v_attached   numeric;
  v_required   numeric;
  v_percent    numeric;
  v_attached_percent numeric;
  v_standard   numeric := public.order_submission_standard_advance_percent();
  v_route      text;
  v_reason_code text;
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_meta       jsonb;
  -- ── Added by 20261224000000, for the auto-approval block at the foot ──
  v_can_approve   boolean := false;
  v_submitted_at  timestamptz;
  v_pi_now        timestamptz;
  v_auto_approved boolean := false;
begin
  if not public.actor_has_module_permission('orders', 'create') then
    raise exception 'You do not have permission to submit an order submission'
      using errcode = '42501';
  end if;

  if v_note is not null and char_length(v_note) > 1000 then
    raise exception
      'ORDER_SUBMISSION_NOTE_TOO_LONG: a reply may be at most 1000 characters (this one is %)',
      char_length(v_note)
      using errcode = 'P0001';
  end if;

  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  if v_pay_terms is not null and char_length(v_pay_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: payment terms may be at most 500 characters (these are %)',
      char_length(v_pay_terms)
      using errcode = 'P0001';
  end if;

  if v_bill_terms is not null and char_length(v_bill_terms) > 500 then
    raise exception
      'ORDER_SUBMISSION_TERMS_TOO_LONG: billing terms may be at most 500 characters (these are %)',
      char_length(v_bill_terms)
      using errcode = 'P0001';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if not public.can_edit_order_submission(p_submission_id) then
    raise exception 'This order submission cannot be submitted by you in its current state'
      using errcode = '42501';
  end if;

  if v_sub.grand_total is null then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored grand total, so its payment position cannot be judged'
      using errcode = 'P0001';
  end if;

  -- The live payment position, under the same locks the approval takes:
  -- payments before allocations, both in id order.
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
  v_attached   := v_verified + v_unverified;
  v_required   := public.order_submission_required_payment(v_sub.grand_total);

  -- THE ROUTE IS CHOSEN ON ATTACHED PAYMENT. Money the client has paid and
  -- Finance has not yet looked at is not a reason to make the employee argue
  -- for an exception; it is a reason for Finance to look. Below 40% attached —
  -- zero included — the business must be told why before it is asked.
  v_route := case when v_attached >= v_required then 'standard' else 'exception' end;

  v_attached_percent := case
    when v_attached = 0 then 0
    else coalesce(public.order_submission_advance_percent_of(v_sub.grand_total, v_attached), 0)
  end;

  if v_route = 'exception' then
    if v_reason is null then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED: say why an Order should be confirmed below the standard %% requirement'
        using errcode = 'P0001';
    end if;

    -- ── 20270102000000: ONE OF THREE REASONS, and nothing else ──
    --
    -- The reason is one of the three the screen offers, stated in words the
    -- admin reads as they are: 'Against client PO', 'Sample order', or
    -- 'Other: <remark>' where the remark says something (at least 10
    -- characters). Anything else is refused rather than stored, so every
    -- request carries a category an admin can filter and reason about.
    --
    -- PAYMENT TERMS ARE NO LONGER DEMANDED HERE. They remain part of the
    -- exception's recorded basis below — order_submission_exception_current()
    -- still compares them — and are still stored when given. Choosing a reason
    -- decides nothing: the request is 'pending' until an admin holding
    -- orders.approve_advance_exception approves it, exactly as before.
    v_reason_code := public.order_submission_exception_reason_code(v_reason);
    if v_reason_code is null then
      raise exception
        'ORDER_SUBMISSION_EXCEPTION_REASON_INVALID: choose Against client PO, Sample order, or Other with a remark of at least 10 characters'
        using errcode = 'P0001';
    end if;

    if not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_OWNER: only the owner of this PI may request an advance exception'
        using errcode = '42501';
    end if;

    -- THE SNAPSHOT keeps its applied meaning: verified payment, truncated and
    -- never rounded. On this route verified <= attached < the requirement, so
    -- the "strictly below 40" row constraint holds by construction.
    v_percent := case
      when v_verified = 0 then 0
      else coalesce(
        public.order_submission_advance_percent_of(v_sub.grand_total, v_verified), 0)
    end;

    if v_percent >= v_standard then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_NOT_POSITIVE: this PI has no positive grand total to measure a payment percentage against'
        using errcode = 'P0001';
    end if;

    v_keep := coalesce(
      v_sub.advance_condition = 'exception'
      and v_sub.advance_exception_reason is not distinct from v_reason
      and public.order_submission_exception_current(
            v_sub.advance_exception_status,
            v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
            v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
            v_sub.advance_exception_decided_payment_terms,   v_pay_terms,
            v_sub.advance_exception_decided_billing_terms,   v_bill_terms),
      false
    );
  end if;

  -- ── The completeness checks, identical to every other submission path ──
  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) must be fixed in the workbook before this can be submitted',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  if coalesce(btrim(v_sub.client_name), '') = '' then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: a client name is required'
      using errcode = 'P0001';
  end if;

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
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: no file exists in order-files at the recorded workbook path'
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
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX: the stored workbook is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  select count(*) into v_item_count
  from public.order_submission_items where submission_id = p_submission_id;

  if v_item_count = 0 then
    raise exception 'ORDER_SUBMISSION_INCOMPLETE: at least one product line is required'
      using errcode = 'P0001';
  end if;

  select count(*) into v_incomplete
  from public.order_submission_items
  where submission_id = p_submission_id
    and (item_sequence is null or product_name is null);

  if v_incomplete > 0 then
    raise exception
      'ORDER_SUBMISSION_INCOMPLETE: % product line(s) are missing an item sequence or a name',
      v_incomplete
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

  -- ── The write: one statement on every path ──
  if v_route = 'standard' then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'standard',
           advance_declared_amount = null,
           advance_exception_percent = null,
           advance_exception_reason = null,
           advance_exception_reason_code = null,
           advance_exception_status = null,
           advance_exception_requested_by = null,
           advance_exception_requested_at = null,
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;

  elsif v_keep then
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_declared_amount = null,
           advance_exception_percent = v_percent
     where id = p_submission_id;

  else
    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           payment_terms = v_pay_terms,
           billing_terms = v_bill_terms,
           advance_condition = 'exception',
           advance_declared_amount = null,
           advance_exception_percent = v_percent,
           advance_exception_reason = v_reason,
           advance_exception_reason_code = v_reason_code,
           advance_exception_status = 'pending',
           advance_exception_requested_by = v_actor,
           advance_exception_requested_at = now(),
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;
    v_requested := true;
  end if;

  v_meta := jsonb_build_object(
    'advance_condition',  v_route,
    'advance_percent',    case when v_route = 'standard' then v_standard else v_percent end,
    'standard_percent',   v_standard,
    'grand_total',        v_sub.grand_total,
    'advance_amount',     v_verified,
    'verified_payment',   v_verified,
    'unverified_payment', v_unverified,
    'attached_payment',   v_attached,
    'attached_percent',   v_attached_percent,
    'required_payment',   v_required,
    'payment_terms',      v_pay_terms,
    'billing_terms',      v_bill_terms
  );

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
      || v_meta
  );

  if v_requested then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'advance_exception_requested', v_sub.status, 'submitted', v_reason,
      v_meta || jsonb_build_object('exception_status', 'pending', 'reason_code', v_reason_code)
    );
  end if;

  -- ══ AUTO-APPROVAL, and nothing but the PI decision ════════════════════════
  --
  -- LAST, so that it is unreachable by a PI that failed anything above it.
  -- Every workbook, completeness, image and storage check has already run and
  -- already had its chance to raise; a PI carrying a single blocking issue was
  -- refused hundreds of lines ago and never arrives here. Nothing in this block
  -- re-judges the document — it records a decision about one that has just
  -- been proved submittable.
  --
  -- THE PERMISSION IS ASKED OF THE ENGINE, AT THE MOMENT OF THE CALL. Not of a
  -- role name, not of a column on the record, and not of anything the browser
  -- sent. actor_can_approve_order() — §4's permission-only door, the SAME one
  -- the reviewer's Approve button goes through — resolves auth.uid() against
  -- the four precedence levels every time.
  --
  -- THE ADMIN ROLE IS NOT A BACK DOOR HERE, and that is the whole reason §4
  -- exists. Asking the admin-branching helper would have auto-approved every
  -- administrator's own uploads no matter what the Control Centre said, which
  -- is the defect this file corrects rather than reproduces.
  --
  -- So withdrawing somebody's approve_order stops the very next submission
  -- from being auto-approved, with no cache to wait for and nothing to
  -- redeploy. It rewrites no decision already recorded: a PI approved while
  -- the permission was held keeps its stamp and its trail, because this block
  -- only ever writes forward.
  --
  -- A SECOND STATEMENT, NOT A LONGER FIRST ONE, and that is forced rather than
  -- chosen. order_submissions_guard_pi_approval (20261119000000 §1) CLEARS the
  -- three pi_approved_ columns on any update that moves status, which every
  -- write above does — draft/needs_changes → submitted. Folding the stamp into
  -- those statements would therefore have written it and thrown it away in the
  -- same breath. Stamped here, the guard sees submitted → submitted and applies
  -- its other rule instead: the decision must be bound to the submission it was
  -- made against.
  --
  -- WHICH IS WHY submitted_at IS READ BACK. It is assigned by the status
  -- transition trigger from the transaction clock and is deliberately not
  -- something any caller can supply, so the only way to bind the decision to
  -- this submission is to ask the row what the trigger wrote.
  --
  -- THE TRAIL SAYS BOTH THINGS. 'submitted' was logged above with this actor as
  -- the uploader; 'pi_approved' is logged here with this actor as the approver,
  -- carrying auto_approved = true so a reader can tell a decision that was
  -- taken from one that was merely implied. Requirement and consequence: on an
  -- auto-approved PI the uploader and the approver are the same person, and the
  -- history says so in two separate events rather than pretending otherwise.
  v_can_approve := public.actor_can_approve_order();

  if v_can_approve then
    select submitted_at into v_submitted_at
    from public.order_submissions
    where id = p_submission_id;

    v_pi_now := now();

    update public.order_submissions
       set pi_approved_by            = v_actor,
           pi_approved_at            = v_pi_now,
           pi_approved_submission_at = v_submitted_at
     where id = p_submission_id;

    v_auto_approved := true;

    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
      jsonb_build_object(
        'approved_submission_at', v_submitted_at,
        'order_created',          false,
        'auto_approved',          true,
        'submitted_by',           v_actor
      )
    );
  end if;

  return jsonb_build_object(
    'id',                  p_submission_id,
    'status',              'submitted',
    'item_count',          v_item_count,
    'payment_route',       v_route,
    'verified_payment',    v_verified,
    'unverified_payment',  v_unverified,
    'attached_payment',    v_attached,
    'required_payment',    v_required,
    'exception_requested', v_requested,
    -- Added by 20261224000000. Additive: every key above is unchanged, so a
    -- caller that reads only exception_requested is unaffected.
    'pi_auto_approved',    v_auto_approved,
    'pi_approved_at',      v_pi_now
  );
end;
$$;

revoke execute on function public.submit_pi_for_review_internal(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_pi_for_review_internal(uuid, text, text, text, text) is
  'The implementation of submitting a PI for review. The route is chosen on ATTACHED payment (verified + awaiting verification): at or above 40% no reason is owed; below it — zero included — one of three reasons is mandatory (Against client PO, Sample order, Other: remark; 20270102000000) and the existing reduced-payment exception is raised as PENDING. Payment Terms are optional on both routes since 20270102000000. A submitter who holds orders.approve_order also has the PI DECISION stamped (20261224000000); that settles no advance exception. Gates no Order. Executable by no role: reached only by its door, as the definer.';


-- ─── 5. Assertions ─────────────────────────────────────────────────────────

do $assert$
declare
  v_def text;
begin
  if exists (select 1 from pg_trigger
             where tgrelid = 'public.order_submissions'::regclass
               and tgname = 'order_submissions_auto_reserve_order_number') then
    raise exception 'ASSERTION FAILED: the automatic reservation trigger is still attached';
  end if;

  if (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'order_submissions'
        and column_name = 'reservation_required') is distinct from 'false' then
    raise exception 'ASSERTION FAILED: reservation_required does not default to false';
  end if;

  if exists (select 1 from public.order_submissions where draft_reference is null) then
    raise exception 'ASSERTION FAILED: a PI Draft has no reference';
  end if;

  v_def := pg_get_functiondef(to_regprocedure('public.assign_order_display_number()'));
  if v_def like '%ORDER_SUBMISSION_RESERVATION_REQUIRED%' then
    raise exception 'ASSERTION FAILED: an Order still refuses a PI that holds no reservation';
  end if;
  if v_def not like '%allocate_confirmed_order_number()%' then
    raise exception 'ASSERTION FAILED: an Order no longer allocates from the cycle';
  end if;

  v_def := pg_get_functiondef(to_regprocedure('public.submit_pi_for_review_internal(uuid, text, text, text, text)'));
  if v_def like '%ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED%' then
    raise exception 'ASSERTION FAILED: the exception route still requires payment terms';
  end if;
  if v_def not like '%ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED%'
     or v_def not like '%order_submission_exception_reason_code(v_reason)%'
     or v_def not like '%actor_can_approve_order()%' then
    raise exception 'ASSERTION FAILED: the submission door lost a check it must keep';
  end if;

  if public.order_submission_exception_reason_code('Against client PO') <> 'against_client_po'
     or public.order_submission_exception_reason_code('Sample order') <> 'sample_order'
     or public.order_submission_exception_reason_code('Other: repeat client, paying on delivery') <> 'other'
     or public.order_submission_exception_reason_code('Other: ok') is not null
     or public.order_submission_exception_reason_code('because') is not null then
    raise exception 'ASSERTION FAILED: the three reasons are not read as specified';
  end if;
end
$assert$;

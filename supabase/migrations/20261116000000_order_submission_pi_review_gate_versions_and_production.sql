-- ═══════════════════════════════════════════════════════════════════════════
-- PI review, the Confirmed-Order gate, PI versions, and production alignment
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT CHANGES, IN ONE PARAGRAPH EACH
--
-- §1  SUBMISSION IS JUDGED ON ATTACHED PAYMENT. Until now a reason and Payment
--     Terms were mandatory when FINANCE-VERIFIED payment was below 40%. From
--     here the submission door counts everything ATTACHED to the PI — verified
--     plus reported-but-undecided (pending_approval / needs_clarification) —
--     so an employee whose client has paid, but whose payment Finance has not
--     yet looked at, is not forced to write an exception. Below 40% attached
--     (zero included) a reason stays mandatory and the existing exception is
--     raised, unchanged. THE ORDER GATE DOES NOT MOVE: an Order is still
--     created only on verified payment or an approved exception (§4).
--
-- §2  THE PI DECISION IS SEPARABLE FROM THE ORDER. A reviewer may now record
--     that the PI ITSELF is approved (approve_pi_review) while the payment
--     condition is still unresolved; the record stays 'submitted', Needs
--     Changes and Reject remain available, Finance keeps verifying money
--     independently, and the Confirmed Order is created by a second, explicit
--     approve_order_submission() once both gates clear. approve_order_submission
--     stamps the PI decision itself when it is the first press, so the one-click
--     path a fully paid PI has today is unchanged.
--
-- §3  PI VERSIONS. A Confirmed Order gains order_pi_versions: V1 is the PI it
--     was approved from; a later upload is a PENDING revision that never
--     overwrites the current one; approval applies the revised workbook through
--     the EXISTING trusted parse and marks the previous version superseded;
--     rejection keeps the row with its reason. Exactly one approved and at most
--     one pending version per Order, by partial unique index.
--
-- §4  PRODUCTION ALIGNMENT. orders.production_alignment, 'not_aligned' by
--     default on every Order, moved only by set_order_production_alignment()
--     under the new protected action orders.align_production.
--
-- §5  HISTORY. The Order side may read its source PI's trail; a Finance
--     decision on a payment is echoed onto every PI and Order the payment is
--     allocated to; six new PI events and three new Order events.
--
-- ADDITIVE ONLY. No column is dropped, no row is rewritten, no applied
-- function changes signature. The two functions re-emitted in full
-- (submit_pi_for_review_internal, approve_order_submission) keep every rule
-- they had and add one each; pi_submission_payment_summary adds keys and
-- removes none.
--
-- MIGRATION FIRST, THEN CODE. The PI detail read spreads the new columns into
-- its select, so the code must not deploy before this file is applied.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.approve_order_submission(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260923000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.submit_pi_for_review_internal(uuid, text, text, text, text)') is null
     or to_regprocedure('public.pi_submission_payment_summary(uuid)') is null
     or to_regprocedure('public.order_submission_exception_current(text, numeric, numeric, text, text, text, text, text, text)') is null then
    raise exception 'DEPENDENCY MISSING: 20260921000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.replace_order_submission_parse(uuid, uuid, jsonb)') is null
     or to_regprocedure('public.assert_order_submission_workbook_editor(uuid, uuid, text, boolean)') is null then
    raise exception 'DEPENDENCY MISSING: 20261003000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.can_view_order(uuid)') is null
     or to_regprocedure('public.can_view_order_submission_via_order(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: 20260924000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_order_amendment()') is null then
    raise exception 'DEPENDENCY MISSING: 20260816000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.in_test_data_cleanup()') is null then
    raise exception 'DEPENDENCY MISSING: 20260705000000 must be applied before this migration';
  end if;
end $$;


-- ═══ 1. The PI decision, as columns ═════════════════════════════════════════
--
-- SHAPED EXACTLY LIKE THE FINANCE CHECK (20260915000000 §2): a stamp, an actor,
-- and the submitted_at it was made against, so a resubmission makes it stale by
-- itself. All three or none.

alter table public.order_submissions
  add column if not exists pi_approved_by            uuid references public.users(id),
  add column if not exists pi_approved_at            timestamptz,
  add column if not exists pi_approved_submission_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_submissions_pi_approval_complete'
      and conrelid = 'public.order_submissions'::regclass
  ) then
    alter table public.order_submissions
      add constraint order_submissions_pi_approval_complete check (
        (pi_approved_by is null and pi_approved_at is null and pi_approved_submission_at is null)
        or
        (pi_approved_by is not null and pi_approved_at is not null and pi_approved_submission_at is not null)
      );
  end if;
end $$;

comment on column public.order_submissions.pi_approved_by is
  'The orders.approve_order holder who approved the PI ITSELF — its document, figures and terms — independently of whether the payment condition was cleared. NULL until approve_pi_review() or approve_order_submission() stamps it; cleared whenever the record leaves review.';
comment on column public.order_submissions.pi_approved_at is
  'When the PI decision was taken.';
comment on column public.order_submissions.pi_approved_submission_at is
  'The submitted_at the PI decision was made against. A resubmission takes a new submitted_at, so a decision about the previous version stops matching — the same currency rule the finance check uses.';

-- The reusable currency rule, shaped like order_submission_finance_verified().
create or replace function public.order_submission_pi_approved(
  p_pi_approved_at            timestamptz,
  p_pi_approved_submission_at timestamptz,
  p_submitted_at              timestamptz
)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select coalesce(
    p_pi_approved_at is not null
    and p_pi_approved_submission_at is not null
    and p_submitted_at is not null
    and p_pi_approved_submission_at = p_submitted_at,
    false
  )
$$;

comment on function public.order_submission_pi_approved(timestamptz, timestamptz, timestamptz) is
  'True only when a PI decision exists AND is bound to the submission currently under review. A decision carried over from an earlier submission is not current. Reads; authorises nothing.';

revoke execute on function public.order_submission_pi_approved(timestamptz, timestamptz, timestamptz)
  from public, anon;
grant  execute on function public.order_submission_pi_approved(timestamptz, timestamptz, timestamptz)
  to authenticated;

-- The guard: mirrors order_submissions_guard_finance_verification, clause for
-- clause. Recording is permitted only on a submitted PI and only bound to the
-- submission in front of the reviewer; any move away from review clears it,
-- except the move to 'approved', which keeps it as part of the approved record.
create or replace function public.order_submissions_guard_pi_approval()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.pi_approved_by is not null
       or new.pi_approved_at is not null
       or new.pi_approved_submission_at is not null then
      raise exception
        'ORDER_SUBMISSION_PI_APPROVAL_INVALID: a submission is created with no PI decision'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'approved' then
      return new;
    end if;
    new.pi_approved_by            := null;
    new.pi_approved_at            := null;
    new.pi_approved_submission_at := null;
    return new;
  end if;

  if new.pi_approved_at is not distinct from old.pi_approved_at
     and new.pi_approved_by is not distinct from old.pi_approved_by
     and new.pi_approved_submission_at is not distinct from old.pi_approved_submission_at then
    return new;
  end if;

  if new.pi_approved_at is null then
    return new;
  end if;

  if new.status <> 'submitted' or old.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_PI_APPROVAL_NOT_UNDER_REVIEW: only a submitted PI can be approved'
      using errcode = '42501';
  end if;

  if new.pi_approved_submission_at is distinct from new.submitted_at then
    raise exception
      'ORDER_SUBMISSION_PI_APPROVAL_INVALID: a PI decision must be bound to the submission it was made against'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.order_submissions_guard_pi_approval()
  from public, anon, authenticated, service_role;

drop trigger if exists order_submissions_guard_pi_approval on public.order_submissions;
create trigger order_submissions_guard_pi_approval
  before insert or update on public.order_submissions
  for each row execute function public.order_submissions_guard_pi_approval();


-- ═══ 2. Attached payment ════════════════════════════════════════════════════
--
-- verified + unverified, in one place, so the submit door and the summary
-- cannot add the two differently. Same shape and the same "executable by no
-- role" posture as the two it sums.

create or replace function public.order_submission_attached_payment(p_submission_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.order_submission_verified_payment(p_submission_id)
       + public.order_submission_unverified_payment(p_submission_id)
$$;

comment on function public.order_submission_attached_payment(uuid) is
  'Rupees ATTACHED to one PI: Finance-verified money plus money reported against it that Finance has not yet decided. Rejected and reversed count as nothing. This is the figure the SUBMISSION rule reads — a reason is mandatory below 40% of it — and it gates NO Order: approve_order_submission() still requires verified payment or an approved exception. Executable by no role.';

revoke execute on function public.order_submission_attached_payment(uuid)
  from public, anon, authenticated, service_role;


-- ═══ 3. The closed activity set grows by six ════════════════════════════════

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_class t     on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'order_submission_activity'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%order_number_used%';
  if v_name is null then
    raise exception 'the order_submission_activity action constraint was not found';
  end if;
  execute format('alter table public.order_submission_activity drop constraint %I', v_name);
end $$;

alter table public.order_submission_activity
  drop constraint if exists order_submission_activity_action_check;

alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    -- ── Everything 20261009000000 left in force ──
    'submission_created',
    'parse_replaced',
    'submitted',
    'changes_requested',
    'rejected',
    'advance_exception_requested',
    'advance_exception_approved',
    'advance_exception_rejected',
    'finance_verified',
    'approved',
    'payment_recorded',
    'payment_allocations_moved',
    'billing_percentage_set',
    'billing_percentage_amended_by_admin',
    'client_details_updated',
    'client_details_amended_by_admin',
    'schedule_terms_updated',
    'schedule_terms_amended_by_admin',
    'correction_requested',
    'correction_resolved',
    'correction_rejected',
    'product_details_updated',
    'product_details_amended_by_admin',
    'workbook_replaced_by_admin',
    'order_number_reserved',
    'order_number_revised_pi_verified',
    'order_number_used',

    -- ── 20261116000000 ──
    -- The PI decision, taken on its own. 'approved' remains the event that
    -- creates the Order — this is the decision that may precede it.
    'pi_approved',
    -- Finance's decision on a payment, echoed onto the PI it is allocated to.
    'payment_verified',
    'payment_rejected',
    -- A later PI on a Confirmed Order, and what became of it.
    'pi_revision_proposed',
    'pi_revision_approved',
    'pi_revision_rejected'
  ));

comment on constraint order_submission_activity_action_check on public.order_submission_activity is
  'The CLOSED set of actions a PI''s history may record. A migration that logs a new action must extend this in the same migration.';


-- ═══ 4. Submitting a PI: the reason is owed below 40% ATTACHED ═════════════
--
-- RE-EMITTED IN FULL from 20260921000000 §9, the house rule for this function.
-- It differs in exactly these places:
--
--   1. v_unverified and v_attached are read beside v_verified, under the same
--      locks;
--   2. the ROUTE is chosen on v_attached, not v_verified;
--   3. the trail carries the three new figures.
--
-- Everything else — the shape checks, the ownership rule, the completeness
-- checks, the three write shapes, the survival of an identical approved
-- exception — is what was applied. The snapshot advance_exception_percent keeps
-- its documented meaning (verified payment at the moment of the request), and
-- because verified <= attached < 40% on the exception route the applied
-- "strictly below 40" constraint is satisfied by construction.

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
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_meta       jsonb;
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

    if v_pay_terms is null then
      raise exception
        'ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED: enter the agreed payment terms before asking to proceed below the standard requirement'
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
      v_meta || jsonb_build_object('exception_status', 'pending')
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
    'exception_requested', v_requested
  );
end;
$$;

revoke execute on function public.submit_pi_for_review_internal(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_pi_for_review_internal(uuid, text, text, text, text) is
  'The implementation of submitting a PI for review. Since 20261116000000 the route is chosen on ATTACHED payment (verified + awaiting verification): at or above 40% no reason is owed; below it — zero included — a reason and Payment Terms are mandatory and the existing reduced-payment exception is raised. Gates no Order. Executable by no role: reached only by its door, as the definer.';


-- ═══ 5. The summary the screens read: the attached figures and the PI decision
--
-- RE-EMITTED IN FULL from 20260921000000 §8. Every key it returned is still
-- returned with the same meaning; these are added:
--
--   attached_amount / attached_percent / attached_meets_standard
--   needed_attached_for_submission    shortfall against ATTACHED, rounded up
--   submission_position               attached_met | attached_partial | no_payment
--   pi_approved / pi_approved_at / pi_approved_by / pi_approved_by_name
--   order_gate_cleared                 the verified-or-exception answer the
--                                      Order gate would give right now

create or replace function public.pi_submission_payment_summary(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_sub       public.order_submissions%rowtype;
  v_verified  numeric := 0;
  v_unverif   numeric := 0;
  v_attached  numeric := 0;
  v_total     numeric;
  v_required  numeric;
  v_meets      boolean;
  v_attached_meets boolean;
  v_exc_current boolean;
  v_position  text;
  v_sub_position text;
  v_pi_approved boolean;
  v_pi_approver text;
  v_is_admin  boolean;
  v_fin_all   boolean;
  v_rows      jsonb;
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id;

  if not found or not public.can_view_order_submission(p_submission_id) then
    raise exception 'ORDER_SUBMISSION_NOT_AVAILABLE: that PI is not available.'
      using errcode = '42501';
  end if;

  v_is_admin := exists (
    select 1 from public.users u
    where u.id = v_actor and u.role = 'admin' and u.is_active
      and coalesce(u.is_deleted, false) = false
  );
  v_fin_all := public.actor_has_module_permission('finance', 'view_all');

  select
    coalesce(sum(a.allocated_amount) filter (
      where public.finance_payment_status_is_verified(f.status)), 0),
    coalesce(sum(a.allocated_amount) filter (
      where f.status in ('pending_approval', 'needs_clarification')), 0)
    into v_verified, v_unverif
  from public.finance_payment_allocations a
  join public.finance_payment_requests f on f.id = a.payment_request_id
  where a.order_submission_id = p_submission_id
    and a.status = 'active';

  v_attached := v_verified + v_unverif;
  v_total    := v_sub.grand_total;
  v_required := public.order_submission_required_payment(v_total);
  v_meets    := v_required is not null and v_verified >= v_required;
  v_attached_meets := v_required is not null and v_attached >= v_required;

  v_exc_current := public.order_submission_exception_current(
    v_sub.advance_exception_status,
    v_sub.advance_exception_decided_grand_total,     v_sub.grand_total,
    v_sub.advance_exception_decided_workbook_sha256, v_sub.source_workbook_sha256,
    v_sub.advance_exception_decided_payment_terms,   v_sub.payment_terms,
    v_sub.advance_exception_decided_billing_terms,   v_sub.billing_terms);

  v_position := case
    when v_meets                                     then 'standard_met'
    when v_exc_current                               then 'exception_approved'
    when v_sub.advance_exception_status = 'approved' then 'exception_stale'
    when v_sub.advance_exception_status = 'pending'  then 'exception_pending'
    when v_sub.advance_exception_status = 'rejected' then 'exception_rejected'
    when v_unverif > 0                               then 'verification_pending'
    else 'payment_required'
  end;

  -- WHERE THE SUBMISSION RULE STANDS, resolved here so the dialog that asks
  -- for a reason and the door that refuses without one read one answer.
  v_sub_position := case
    when v_attached_meets then 'attached_met'
    when v_attached > 0   then 'attached_partial'
    else 'no_payment'
  end;

  -- THE PI DECISION. On an approved record it is read straight, as the finance
  -- check is: the columns are deliberately kept, and submitted_at no longer
  -- moves.
  v_pi_approved := case
    when v_sub.status = 'approved' then v_sub.pi_approved_at is not null
    else public.order_submission_pi_approved(
           v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at)
  end;

  select u.full_name into v_pi_approver
  from public.users u where u.id = v_sub.pi_approved_by;

  select coalesce(jsonb_agg(r order by r->>'created_at' desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
      'allocation_id',     a.id,
      'allocation_status', a.status,
      'allocated_amount',  a.allocated_amount,
      'payment_id',        f.id,
      'request_number',    f.request_number,
      'amount',            f.amount,
      'payment_date',      f.payment_date,
      'payment_mode',      f.payment_mode,
      'reference',         f.order_number,
      'remarks',           f.sales_note,
      'status',            f.status,
      'is_verified',       public.finance_payment_status_is_verified(f.status),
      'admin_note',        f.admin_note,
      'entered_by',        eb.full_name,
      'verified_by',       vb.full_name,
      'created_at',        f.created_at,
      'verified_at',       f.approved_at,
      'rejected_at',       f.rejected_at,
      'proof_count',       (select count(*) from public.payment_proof_attachments pa
                             where pa.payment_request_id = f.id),
      'can_view_proof',    (v_is_admin or f.submitted_by = v_actor)
    ) as r
    from public.finance_payment_allocations a
    join public.finance_payment_requests f on f.id = a.payment_request_id
    left join public.users eb on eb.id = f.submitted_by
    left join public.users vb on vb.id = f.approved_by
    where a.order_submission_id = p_submission_id
  ) t;

  return jsonb_build_object(
    'submission_id',        p_submission_id,
    'submission_status',    v_sub.status,
    'grand_total',          v_total,
    'verified_amount',      v_verified,
    'unverified_amount',    v_unverif,
    'attached_amount',      v_attached,
    'verified_percent',     case when v_total is null or v_total = 0 then null
                                 else trunc(v_verified * 100 / v_total, 2) end,
    'unverified_percent',   case when v_total is null or v_total = 0 then null
                                 else trunc(v_unverif  * 100 / v_total, 2) end,
    'attached_percent',     case when v_total is null or v_total = 0 then null
                                 else trunc(v_attached * 100 / v_total, 2) end,
    'needed_for_standard',  public.order_submission_payment_shortfall(v_total, v_verified),
    'needed_attached_for_submission',
                            public.order_submission_payment_shortfall(v_total, v_attached),
    'required_payment',     v_required,
    'meets_standard',       v_meets,
    'attached_meets_standard', v_attached_meets,
    'approval_position',    v_position,
    'submission_position',  v_sub_position,
    'order_gate_cleared',   (v_meets or v_exc_current),
    'pi_approved',          v_pi_approved,
    'pi_approved_at',       case when v_pi_approved then v_sub.pi_approved_at end,
    'pi_approved_by',       case when v_pi_approved then v_sub.pi_approved_by end,
    'pi_approved_by_name',  case when v_pi_approved then v_pi_approver end,
    'pending_balance',      case when v_total is null then null
                                 else greatest(v_total - v_verified, 0) end,
    'standard_percent',     public.order_submission_standard_advance_percent(),
    'advance_condition',    v_sub.advance_condition,
    'exception_status',     v_sub.advance_exception_status,
    'exception_current',    v_exc_current,
    'exception_reason',     v_sub.advance_exception_reason,
    'exception_rejection_reason', v_sub.advance_exception_rejection_reason,
    'payment_terms',        v_sub.payment_terms,
    'billing_terms',        v_sub.billing_terms,
    'can_view_all_finance', v_fin_all,
    'payments',             v_rows
  );
end;
$$;

comment on function public.pi_submission_payment_summary(uuid) is
  'Every payment allocated to one PI, with the card''s totals computed in numeric in the database: verified, awaiting verification, and ATTACHED (the two together); the APPROVAL POSITION the Order gate would reach right now; the SUBMISSION POSITION the reason rule reads; and whether the PI itself has been approved. Reports; decides nothing — submit_pi_for_review() and approve_order_submission() re-derive all of it under row locks. Refuses a caller who cannot open the PI.';

revoke execute on function public.pi_submission_payment_summary(uuid) from public, anon;
grant  execute on function public.pi_submission_payment_summary(uuid) to authenticated;


-- ═══ 6. Approving the PI, on its own ════════════════════════════════════════
--
-- THE SAME AUTHORITY AS THE ORDER, deliberately: orders.approve_order is the
-- authority to review this document, and approving it is that review's answer.
-- What this does NOT do is create anything: no Order, no number, no moved
-- money. It records that management is satisfied with the PI and leaves the
-- payment condition to Finance and to the exception approver — which is what
-- lets "payment approved, PI held" and "PI approved, payment pending" both be
-- representable at once.
--
-- The finance CHECK (somebody with finance authority has read the figures) is
-- still required first, exactly as approve_order_submission requires it: the
-- PI is not approvable until its figures have been read.

create or replace function public.approve_pi_review(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.assert_order_submission_actor();
  v_sub   public.order_submissions%rowtype;
  v_now   timestamptz;
begin
  if not public.actor_has_module_permission('orders', 'approve_order') then
    raise exception 'You do not have permission to approve order submissions'
      using errcode = '42501';
  end if;

  select * into v_sub
  from public.order_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion and cannot be approved'
      using errcode = '55P03';
  end if;

  if v_sub.status <> 'submitted' then
    raise exception
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW: only a submitted PI can be approved (this one is %)', v_sub.status
      using errcode = 'P0001';
  end if;

  if not public.order_submission_finance_verified(
       v_sub.finance_verified_at, v_sub.finance_verified_submission_at, v_sub.submitted_at) then
    raise exception
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED: this PI has not been verified by finance for the submission under review'
      using errcode = 'P0001';
  end if;

  if jsonb_array_length(v_sub.parse_blocking_issues) > 0 then
    raise exception
      'ORDER_SUBMISSION_BLOCKED: % issue(s) in this PI must be fixed before it can be approved',
      jsonb_array_length(v_sub.parse_blocking_issues)
      using errcode = 'P0001';
  end if;

  -- Already decided against THIS submission: answer, do not re-record.
  if public.order_submission_pi_approved(
       v_sub.pi_approved_at, v_sub.pi_approved_submission_at, v_sub.submitted_at) then
    return jsonb_build_object(
      'id',               p_submission_id,
      'pi_approved',      true,
      'pi_approved_at',   v_sub.pi_approved_at,
      'already_approved', true
    );
  end if;

  v_now := now();

  update public.order_submissions
     set pi_approved_by            = v_actor,
         pi_approved_at            = v_now,
         pi_approved_submission_at = v_sub.submitted_at
   where id = p_submission_id;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'pi_approved', 'submitted', 'submitted', null,
    jsonb_build_object(
      'approved_submission_at', v_sub.submitted_at,
      'order_created',          false
    )
  );

  return jsonb_build_object(
    'id',               p_submission_id,
    'pi_approved',      true,
    'pi_approved_at',   v_now,
    'already_approved', false
  );
end;
$$;

comment on function public.approve_pi_review(uuid) is
  'Records that management approves the PI ITSELF — for a caller holding orders.approve_order, on a submitted PI whose finance check is current and which has no blocking issues. Creates NO Order, allocates NO number, moves NO money and verifies NO payment: the Confirmed Order is created by approve_order_submission() once the payment condition is also cleared. Idempotent against the same submission.';

revoke execute on function public.approve_pi_review(uuid) from public, anon;
grant  execute on function public.approve_pi_review(uuid) to authenticated;


-- ═══ 7. PI versions ═════════════════════════════════════════════════════════
--
-- ONE ORDER, MANY PI VERSIONS. V1 is the workbook the Order was approved from.
-- A later upload is a new row, PENDING, and changes nothing until an active
-- admin approves it — at which point the revised workbook is applied through
-- replace_order_submission_parse() (the ONE parser path, unchanged) and the
-- previous version is marked superseded. A rejected revision keeps its row, its
-- file and its reason.
--
-- WHY A TABLE AND NOT A COLUMN. The current PI is already the submission row;
-- what is missing is the HISTORY of documents and decisions, which is a list.
-- The rows are small — a path, a name, a hash, who, when, why, and the
-- decision — and every figure still lives on the submission, parsed from
-- whichever workbook is current.

create table if not exists public.order_pi_versions (
  id                uuid        primary key default gen_random_uuid(),
  -- Both parents cascade: an audited Test Data Cleanup deletes the PI before
  -- the Order, and a version row must follow whichever goes first. Nothing else
  -- can delete either parent (orders_prevent_delete, order_submissions_guard_delete).
  order_id          uuid        not null references public.orders(id) on delete cascade,
  submission_id     uuid        not null references public.order_submissions(id) on delete cascade,
  version_number    integer     not null check (version_number >= 1),
  status            text        not null
                                check (status in ('pending', 'approved', 'rejected', 'superseded')),

  -- The document. workbook_path is nullable only so a backfilled V1 whose
  -- submission had lost its stored path still records that a version existed.
  workbook_path     text,
  workbook_name     text,
  workbook_sha256   text,

  -- Who proposed it, when, and why. V1 carries no reason: it is the original.
  uploaded_by       uuid        references public.users(id),
  uploaded_at       timestamptz not null default now(),
  revision_reason   text,

  -- The decision.
  decided_by        uuid        references public.users(id),
  decided_at        timestamptz,
  decision_reason   text,

  -- When an approved version stopped being current, and which one replaced it.
  superseded_at     timestamptz,
  superseded_by_version_id uuid references public.order_pi_versions(id),

  created_at        timestamptz not null default now(),

  constraint order_pi_versions_order_version_key unique (order_id, version_number),
  constraint order_pi_versions_revision_needs_reason check (
    version_number = 1 or nullif(btrim(coalesce(revision_reason, '')), '') is not null
  ),
  constraint order_pi_versions_decision_complete check (
    (status = 'pending'  and decided_by is null and decided_at is null)
    or (status in ('approved', 'superseded') and decided_by is not null and decided_at is not null)
    or (status = 'rejected' and decided_by is not null and decided_at is not null
        and nullif(btrim(coalesce(decision_reason, '')), '') is not null)
  ),
  constraint order_pi_versions_superseded_complete check (
    (status = 'superseded') = (superseded_at is not null)
  ),
  constraint order_pi_versions_reason_lengths check (
    coalesce(char_length(revision_reason), 0) <= 500
    and coalesce(char_length(decision_reason), 0) <= 1000
  )
);

comment on table public.order_pi_versions is
  'Every PI document a Confirmed Order has carried: V1 is the one it was approved from, later rows are revisions proposed against it. Exactly one approved (current) version and at most one pending revision per Order, by partial unique index. Rows are never deleted outside an audited Test Data Cleanup; a rejected revision keeps its file and its reason.';

-- EXACTLY ONE CURRENT PI PER ORDER, and at most ONE OPEN REVISION. Both are
-- indexes rather than rules in a function, so two admins racing, a stale
-- browser and a retried request all meet the same refusal.
create unique index if not exists order_pi_versions_one_current_per_order
  on public.order_pi_versions (order_id) where status = 'approved';
create unique index if not exists order_pi_versions_one_pending_per_order
  on public.order_pi_versions (order_id) where status = 'pending';
create index if not exists order_pi_versions_order_idx
  on public.order_pi_versions (order_id, version_number desc);
create index if not exists order_pi_versions_submission_idx
  on public.order_pi_versions (submission_id);

-- ── Backfill: V1 for every Order that came from a PI ──
--
-- ADDITIVE HISTORY ROWS, one per Order, taken from facts the two tables already
-- hold. Nothing on orders or order_submissions is rewritten. Written BEFORE the
-- guard trigger below exists, which is why an 'approved' row can be inserted
-- here at all.
insert into public.order_pi_versions (
  order_id, submission_id, version_number, status,
  workbook_path, workbook_name, workbook_sha256,
  uploaded_by, uploaded_at, revision_reason,
  decided_by, decided_at
)
select
  o.id, s.id, 1, 'approved',
  s.source_workbook_path, s.source_workbook_name, s.source_workbook_sha256,
  coalesce(s.submitted_by, s.created_by), coalesce(s.submitted_at, s.created_at), null,
  -- decided_by is NOT NULL for an approved row. Every approval stamps
  -- approved_by, and orders.created_by is the same actor; the two owner columns
  -- close the chain so a hard-deleted account (ON DELETE SET NULL) can never
  -- abort the apply.
  coalesce(s.approved_by, o.created_by, s.submitted_by, s.created_by), coalesce(s.approved_at, o.created_at)
from public.orders o
join public.order_submissions s on s.id = o.source_order_submission_id
where not exists (
  select 1 from public.order_pi_versions v where v.order_id = o.id
);

-- ── The guard: what a row may ever do ──
--
-- INSERT: a pending revision, or V1 inside approve_order_submission() for that
--         PI (the same context that admits the 'approved' status move).
-- UPDATE: identity and document frozen; pending → approved | rejected;
--         approved → superseded. Nothing else.
-- DELETE: only inside an audited Test Data Cleanup.
create or replace function public.order_pi_versions_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.in_test_data_cleanup() then
      return old;
    end if;
    raise exception
      'ORDER_PI_VERSION_IMMUTABLE: PI version history cannot be deleted'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      return new;
    end if;
    if new.status = 'approved' and new.version_number = 1
       and public.in_pi_submission_approval(new.submission_id) then
      return new;
    end if;
    raise exception
      'ORDER_PI_VERSION_INVALID: a PI version is created pending, or as V1 by approving the PI'
      using errcode = '42501';
  end if;

  if new.order_id        is distinct from old.order_id
     or new.submission_id  is distinct from old.submission_id
     or new.version_number is distinct from old.version_number
     or new.workbook_path  is distinct from old.workbook_path
     or new.workbook_name  is distinct from old.workbook_name
     or new.uploaded_by    is distinct from old.uploaded_by
     or new.uploaded_at    is distinct from old.uploaded_at
     or new.revision_reason is distinct from old.revision_reason
     or new.created_at     is distinct from old.created_at then
    raise exception
      'ORDER_PI_VERSION_IMMUTABLE: the identity and document of PI version % cannot be changed', old.id
      using errcode = '42501';
  end if;

  if new.status is not distinct from old.status then
    -- A standing decision cannot be re-worded either.
    if old.status <> 'pending'
       and (new.decided_by is distinct from old.decided_by
            or new.decided_at is distinct from old.decided_at
            or new.decision_reason is distinct from old.decision_reason) then
      raise exception
        'ORDER_PI_VERSION_IMMUTABLE: the decision on PI version % cannot be rewritten', old.id
        using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    return new;
  end if;

  if old.status = 'approved' and new.status = 'superseded' then
    return new;
  end if;

  raise exception
    'ORDER_PI_VERSION_TRANSITION_INVALID: PI version % cannot move from % to %',
    old.id, old.status, new.status
    using errcode = '42501';
end;
$$;

revoke execute on function public.order_pi_versions_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists order_pi_versions_guard on public.order_pi_versions;
create trigger order_pi_versions_guard
  before insert or update or delete on public.order_pi_versions
  for each row execute function public.order_pi_versions_guard();

-- ── Privileges and RLS ──
--
-- Supabase's default privileges grant arwdDxt to the client roles at CREATE
-- TABLE. Normalised explicitly: read only, through the two visibility doors the
-- Order and the PI already have; every write goes through a definer function.
alter table public.order_pi_versions enable row level security;
revoke all on table public.order_pi_versions from public, anon, authenticated;
grant select on table public.order_pi_versions to authenticated;

drop policy if exists "order_pi_versions_select" on public.order_pi_versions;
create policy "order_pi_versions_select" on public.order_pi_versions
  for select to authenticated
  using (
    public.can_view_order(order_id)
    or public.can_view_order_submission(submission_id)
  );

drop policy if exists "order_pi_versions_module_entry_gate" on public.order_pi_versions;
create policy "order_pi_versions_module_entry_gate" on public.order_pi_versions
  as restrictive for all to authenticated
  using (public.module_entry_open('orders'))
  with check (public.module_entry_open('orders'));

-- ── Who may upload a revised workbook onto an approved PI ──
--
-- The existing insert predicate admits the OWNER while the PI is a draft or has
-- been returned. This one admits the owner or an active admin, holding
-- orders.create, on an APPROVED PI that has become an Order — the one state the
-- existing predicate refuses and this feature needs. The key still has to name
-- this submission's own original/ folder, which is what every parser path and
-- the approval RPC already require of a workbook.
create or replace function public.can_write_order_pi_revision_file(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.order_submissions s
    join public.users u on u.id = auth.uid()
    where s.id = p_submission_id
      and s.status = 'approved'
      and s.order_id is not null
      and u.is_active
      and coalesce(u.is_deleted, false) = false
      and (
        u.role = 'admin'
        or s.created_by = auth.uid()
        or s.submitted_by = auth.uid()
      )
      and (
        u.role = 'admin'
        or coalesce(public.resolve_permission(auth.uid(), 'orders', 'create'), false)
      )
  );
$$;

comment on function public.can_write_order_pi_revision_file(uuid) is
  'True for the PI''s owner or an active admin, holding orders.create, while the PI is APPROVED and linked to an Order — the state in which a revised PI may be proposed. Reviewers and finance verifiers are excluded, as they are from every other write. Additive to can_write_order_submission_file, which keeps the draft rule.';

revoke execute on function public.can_write_order_pi_revision_file(uuid) from public, anon;
grant  execute on function public.can_write_order_pi_revision_file(uuid) to authenticated;

drop policy if exists "order_files_revision_insert" on storage.objects;
create policy "order_files_revision_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-files'
    and public.module_entry_open('orders')
    and name ~ '^submissions/[0-9a-fA-F-]{36}/original/[^/]+\.xlsx$'
    and public.can_write_order_pi_revision_file(public.order_file_submission_id(name))
  );

comment on policy "order_files_revision_insert" on storage.objects is
  'Upload of a REVISED PI workbook onto an approved PI''s own original/ folder, by its owner or an admin. Additive to order_files_insert (the draft rule). No UPDATE policy exists, so a stored file is still never overwritten; no DELETE is added, so a proposed revision''s file cannot be pulled from under its row.';

-- ── Proposing a revision ──
create or replace function public.propose_order_pi_revision(
  p_order_id      uuid,
  p_workbook_path text,
  p_workbook_name text,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_is_admin boolean;
  v_order    public.orders%rowtype;
  v_sub      public.order_submissions%rowtype;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_name     text := nullif(btrim(coalesce(p_workbook_name, '')), '');
  v_path     text := nullif(btrim(coalesce(p_workbook_path, '')), '');
  v_next     integer;
  v_id       uuid;
begin
  select coalesce(u.role = 'admin', false) into v_is_admin
  from public.users u where u.id = v_actor;

  if not (coalesce(v_is_admin, false) or public.actor_has_module_permission('orders', 'create')) then
    raise exception 'You do not have permission to propose a revised PI'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'ORDER_PI_REVISION_REASON_REQUIRED: say why a revised PI is being proposed'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 500 then
    raise exception
      'ORDER_PI_REVISION_REASON_TOO_LONG: the reason may be at most 500 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;
  if v_name is not null and char_length(v_name) > 200 then
    v_name := left(v_name, 200);
  end if;

  -- Lock order: the Order, then its PI — the module's standing lock order.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;

  if v_order.status = 'cancelled' then
    raise exception
      'ORDER_PI_REVISION_ORDER_CLOSED: Order % is cancelled and cannot take a revised PI', v_order.display_number
      using errcode = 'P0001';
  end if;

  if v_order.source_order_submission_id is null then
    raise exception
      'ORDER_PI_REVISION_NO_SOURCE: Order % was not created from a PI, so there is no PI to revise', v_order.display_number
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions
  where id = v_order.source_order_submission_id for update;

  if not found or v_sub.status <> 'approved' or v_sub.order_id is distinct from v_order.id then
    raise exception
      'ORDER_PI_REVISION_INVALID: the PI behind Order % is not in an approvable state', v_order.display_number
      using errcode = 'P0001';
  end if;

  if not (coalesce(v_is_admin, false) or v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
    raise exception
      'ORDER_PI_REVISION_NOT_OWNER: only the person who owns this PI, or an administrator, may propose a revision'
      using errcode = '42501';
  end if;

  if v_sub.deletion_claim_token is not null then
    raise exception
      'ORDER_SUBMISSION_DELETION_CLAIMED: this PI is reserved for deletion'
      using errcode = '55P03';
  end if;

  -- THE FILE: this submission's own original/ folder, actually stored, an xlsx,
  -- and not the workbook already current — a revision must be a different file.
  if v_path is null or v_path !~ ('^submissions/' || v_sub.id::text || '/original/[^/]+$') then
    raise exception
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH: the revised workbook is not stored under submissions/%/original/', v_sub.id
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'order-files'
      and o.name = v_path
      and o.metadata ->> 'mimetype'
          = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED: the revised workbook is missing from storage, or is not an .xlsx file'
      using errcode = 'P0001';
  end if;

  if v_path = v_sub.source_workbook_path
     or exists (select 1 from public.order_pi_versions v
                where v.order_id = v_order.id and v.workbook_path = v_path) then
    raise exception
      'ORDER_PI_REVISION_SAME_FILE: that workbook is already a version of this Order''s PI'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from public.order_pi_versions v
             where v.order_id = v_order.id and v.status = 'pending') then
    raise exception
      'ORDER_PI_REVISION_PENDING: a revised PI is already waiting for a decision on Order %', v_order.display_number
      using errcode = 'P0001';
  end if;

  select coalesce(max(version_number), 0) + 1 into v_next
  from public.order_pi_versions where order_id = v_order.id;

  insert into public.order_pi_versions (
    order_id, submission_id, version_number, status,
    workbook_path, workbook_name, uploaded_by, uploaded_at, revision_reason
  ) values (
    v_order.id, v_sub.id, v_next, 'pending',
    v_path, v_name, v_actor, now(), v_reason
  )
  returning id into v_id;

  perform public.log_order_submission_activity(
    v_sub.id, v_actor, 'pi_revision_proposed', 'approved', 'approved', v_reason,
    jsonb_build_object('order_id', v_order.id, 'version_id', v_id, 'version_number', v_next)
  );

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_order.id, v_actor, 'pi_revision_proposed',
          jsonb_build_object('version_id', v_id, 'version_number', v_next,
                             'reason', v_reason, 'workbook_name', v_name));

  return jsonb_build_object(
    'version_id',     v_id,
    'version_number', v_next,
    'order_id',       v_order.id,
    'status',         'pending'
  );
end;
$$;

comment on function public.propose_order_pi_revision(uuid, text, text, text) is
  'Records a revised PI workbook as a PENDING version of a Confirmed Order''s PI, for the PI''s owner or an active admin holding orders.create, with a mandatory reason. Changes NOTHING on the Order or the current PI: the current approved version stays operative until an admin approves the revision. Refuses a cancelled Order, a file that is already a version, and a second open revision.';

revoke execute on function public.propose_order_pi_revision(uuid, text, text, text) from public, anon;
grant  execute on function public.propose_order_pi_revision(uuid, text, text, text) to authenticated;

-- ── Rejecting a revision ──
--
-- ACTIVE ADMIN ONLY, the same authority the deployed rule already gives the
-- only person who may move a submitted PI's figures (20261003000000 §1).
create or replace function public.reject_order_pi_revision(
  p_version_id uuid,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := public.assert_order_submission_actor();
  v_is_admin boolean;
  v_ver      public.order_pi_versions%rowtype;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now      timestamptz := now();
begin
  select coalesce(u.role = 'admin', false) into v_is_admin
  from public.users u where u.id = v_actor;
  if not coalesce(v_is_admin, false) then
    raise exception 'You do not have permission to decide a revised PI'
      using errcode = '42501';
  end if;

  if v_reason is null then
    raise exception
      'ORDER_PI_REVISION_DECISION_REASON_REQUIRED: say why the revised PI is refused'
      using errcode = 'P0001';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception
      'ORDER_PI_REVISION_REASON_TOO_LONG: the reason may be at most 1000 characters (this one is %)',
      char_length(v_reason)
      using errcode = 'P0001';
  end if;

  select * into v_ver from public.order_pi_versions where id = p_version_id for update;
  if not found then
    raise exception 'ORDER_PI_VERSION_NOT_FOUND: that PI version does not exist' using errcode = 'P0002';
  end if;

  if v_ver.status <> 'pending' then
    raise exception
      'ORDER_PI_REVISION_NOT_PENDING: PI version % is % and is no longer waiting for a decision',
      v_ver.version_number, v_ver.status
      using errcode = 'P0001';
  end if;

  update public.order_pi_versions
     set status = 'rejected',
         decided_by = v_actor,
         decided_at = v_now,
         decision_reason = v_reason
   where id = p_version_id;

  perform public.log_order_submission_activity(
    v_ver.submission_id, v_actor, 'pi_revision_rejected', 'approved', 'approved', v_reason,
    jsonb_build_object('order_id', v_ver.order_id, 'version_id', v_ver.id,
                       'version_number', v_ver.version_number)
  );

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (v_ver.order_id, v_actor, 'pi_revision_rejected',
          jsonb_build_object('version_id', v_ver.id, 'version_number', v_ver.version_number,
                             'reason', v_reason));

  return jsonb_build_object(
    'version_id',     v_ver.id,
    'version_number', v_ver.version_number,
    'order_id',       v_ver.order_id,
    'status',         'rejected'
  );
end;
$$;

comment on function public.reject_order_pi_revision(uuid, text) is
  'Refuses a pending revised PI, for an active admin, with a mandatory reason. The current approved version is untouched; the rejected row, its file and its reason are kept.';

revoke execute on function public.reject_order_pi_revision(uuid, text) from public, anon;
grant  execute on function public.reject_order_pi_revision(uuid, text) to authenticated;

-- ── Approving a revision ──
--
-- SERVICE ROLE ONLY, like replace_order_submission_parse(), and for the same
-- reason: the payload is the SERVER'S parse of the revised workbook's bytes and
-- must never come from a browser. The route that calls this is the same one
-- that saves a draft: it holds the processing lease, downloads the file it is
-- told about, parses it itself, uploads the pictures, and only then reaches
-- here — with the lease token in the payload, which the parser checks.
--
-- ONE TRANSACTION: the parse is applied, the previous version superseded and
-- the revision approved together, or none of it happens. The parse is the
-- deployed replace_order_submission_parse(), whose after-submission branch
-- carries the corrected figures onto the Order, clears a finance verification
-- and supersedes the ready documents. Its Order update is a commercial change
-- and must be admitted by orders_guard_amendable_columns, so the amendment
-- context is opened around the call — after the actor has been validated and
-- with the reason on both trails, which is the contract that context expresses.
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

  -- Locks in the module's order: the Order, then its PI, then the version rows.
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

  -- AN OLDER REVISION CAN NEVER REPLACE A NEWER APPROVED ONE.
  if v_current.id is not null and v_current.version_number >= v_ver.version_number then
    raise exception
      'ORDER_PI_REVISION_STALE: PI version % is older than the current approved version %',
      v_ver.version_number, v_current.version_number
      using errcode = 'P0001';
  end if;

  -- THE PARSE MUST BE OF THIS VERSION'S FILE. The server built the payload from
  -- the bytes at one path; that path has to be the one the proposal recorded.
  v_path := nullif(btrim(coalesce(p_payload -> 'source' ->> 'workbook_path', '')), '');
  if v_path is null or v_path is distinct from v_ver.workbook_path then
    raise exception
      'ORDER_PI_REVISION_FILE_MISMATCH: the parsed workbook is not the file this revision proposed'
      using errcode = 'P0001';
  end if;

  -- The reason travels as the amendment reason, so the deployed parser records
  -- the same words on its own 'workbook_replaced_by_admin' event.
  v_payload := p_payload || jsonb_build_object(
    'change_reason', left('PI revision V' || v_ver.version_number::text || ': ' || v_ver.revision_reason, 500));

  perform set_config('boe.amendment_context', 'order_amendment', true);
  v_result := public.replace_order_submission_parse(v_sub.id, p_actor_id, v_payload);
  perform set_config('boe.amendment_context', '', true);

  -- The record now carries the revised file, or nothing happened.
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
  'SERVICE ROLE ONLY. Approves a pending revised PI for an active admin (re-derived from p_actor_id): applies the server''s parse of the revised workbook through replace_order_submission_parse() — which carries the figures onto the Order, clears a finance verification and supersedes ready documents — marks the previous approved version superseded and this one approved, in ONE transaction. Refuses a non-pending version, a version older than the current one, a cancelled Order, and a payload whose workbook is not this version''s file.';

revoke execute on function public.approve_order_pi_revision(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.approve_order_pi_revision(uuid, uuid, jsonb) to service_role;


-- ═══ 8. Production alignment ════════════════════════════════════════════════
--
-- COMMERCIAL APPROVAL IS NOT PRODUCTION ACCEPTANCE. Every Order is born
-- 'not_aligned'; the Head of Manufacturing aligns it explicitly, through one
-- function, under one protected action, with the change on the Order's trail.
-- The three columns are guarded like the commercial terms: nothing but that
-- function may move them, service role and direct SQL included.

alter table public.orders
  add column if not exists production_alignment      text not null default 'not_aligned',
  add column if not exists production_aligned_by     uuid references public.users(id),
  add column if not exists production_aligned_at     timestamptz,
  add column if not exists production_alignment_note text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_production_alignment_known'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_production_alignment_known
      check (production_alignment in ('not_aligned', 'aligned'));
  end if;
end $$;

comment on column public.orders.production_alignment is
  'Whether the Head of Manufacturing has aligned this Order for production. ''not_aligned'' on every Order at creation — commercial approval is not production acceptance — and moved only by set_order_production_alignment() under orders.align_production.';

create or replace function public.in_production_alignment()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(current_setting('boe.production_alignment_context', true), '') = 'production_alignment';
$$;

revoke execute on function public.in_production_alignment() from public, anon, authenticated;

comment on function public.in_production_alignment() is
  'True only inside set_order_production_alignment(). Transaction-local; not settable by any client. Read by orders_guard_amendable_columns.';

-- RE-EMITTED from 20260818000000 §5 with ONE clause added, ahead of the
-- amendment early-return so an amendment cannot move alignment either.
create or replace function public.orders_guard_amendable_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception
      'ORDER_FIELD_FROZEN: The creation record of Order % cannot be changed', old.display_number
      using errcode = '42501';
  end if;

  if (new.production_alignment      is distinct from old.production_alignment
      or new.production_aligned_by  is distinct from old.production_aligned_by
      or new.production_aligned_at  is distinct from old.production_aligned_at
      or new.production_alignment_note is distinct from old.production_alignment_note)
     and not public.in_production_alignment() then
    raise exception
      'ORDER_PRODUCTION_ALIGNMENT_PATH_REQUIRED: The production alignment of Order % is changed only through set_order_production_alignment()',
      old.display_number
      using errcode = '42501';
  end if;

  if public.in_order_amendment() then
    return new;
  end if;

  if new.client_name         is distinct from old.client_name
     or new.requested_by        is distinct from old.requested_by
     or new.assigned_to         is distinct from old.assigned_to
     or new.confirm_date        is distinct from old.confirm_date
     or new.due_date            is distinct from old.due_date
     or new.total_value         is distinct from old.total_value
     or new.total_product_value is distinct from old.total_product_value
     or new.lead_source         is distinct from old.lead_source
     or new.notes               is distinct from old.notes then
    raise exception
      'ORDER_AMENDMENT_REQUIRED: The terms of Order % can only be changed through an order amendment, which records who changed what and why',
      old.display_number
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.orders_guard_amendable_columns() from public, anon, authenticated;

-- The action, registered exactly as approve_advance_exception was.
insert into public.permission_actions (action_key, display_name, is_system)
values ('align_production', 'Align Production', false)
on conflict (action_key) do nothing;

insert into public.module_permission_actions (module_id, action_id, default_allowed)
select pm.id, pa.id, false
from public.permission_modules pm
join public.permission_actions pa on pa.action_key = 'align_production'
where pm.module_key = 'orders'
on conflict (module_id, action_id) do nothing;

create or replace function public.set_order_production_alignment(
  p_order_id uuid,
  p_aligned  boolean,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := public.assert_order_submission_actor();
  v_order  public.orders%rowtype;
  v_target text := case when coalesce(p_aligned, false) then 'aligned' else 'not_aligned' end;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_now    timestamptz := now();
begin
  if not public.actor_has_module_permission('orders', 'align_production') then
    raise exception 'You do not have permission to align an Order for production'
      using errcode = '42501';
  end if;

  if v_note is not null and char_length(v_note) > 500 then
    raise exception
      'ORDER_PRODUCTION_ALIGNMENT_NOTE_TOO_LONG: the note may be at most 500 characters (this one is %)',
      char_length(v_note)
      using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND: That Order no longer exists' using errcode = 'P0002';
  end if;

  if v_order.status = 'cancelled' then
    raise exception
      'ORDER_PRODUCTION_ALIGNMENT_CLOSED: Order % is cancelled', v_order.display_number
      using errcode = 'P0001';
  end if;

  if v_order.production_alignment = v_target then
    return jsonb_build_object(
      'order_id', v_order.id, 'production_alignment', v_target, 'unchanged', true);
  end if;

  perform set_config('boe.production_alignment_context', 'production_alignment', true);
  update public.orders
     set production_alignment      = v_target,
         production_aligned_by     = case when v_target = 'aligned' then v_actor else null end,
         production_aligned_at     = case when v_target = 'aligned' then v_now else null end,
         production_alignment_note = v_note,
         updated_at                = v_now
   where id = p_order_id;
  perform set_config('boe.production_alignment_context', '', true);

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (p_order_id, v_actor, 'production_alignment_changed',
          jsonb_build_object('from', v_order.production_alignment, 'to', v_target, 'note', v_note));

  return jsonb_build_object(
    'order_id', v_order.id, 'production_alignment', v_target, 'unchanged', false);
end;
$$;

comment on function public.set_order_production_alignment(uuid, boolean, text) is
  'Aligns a Confirmed Order for production, or takes the alignment back, for a caller holding orders.align_production (or an active admin), with an optional note of at most 500 characters. Refuses a cancelled Order. Idempotent: setting the state the Order is already in changes nothing and writes no event.';

revoke execute on function public.set_order_production_alignment(uuid, boolean, text) from public, anon;
grant  execute on function public.set_order_production_alignment(uuid, boolean, text) to authenticated;


-- ═══ 9. Approval, re-emitted: the PI decision first, then the Order ══════════
--
-- RE-EMITTED IN FULL from 20260923000000 §4. It differs in exactly these
-- places, and finalApprovalContinuity keeps the two texts together:
--
--   6b. If the PI decision is not current, it is stamped now by this actor
--       (who holds the same authority) and logged as its own event — so the
--       trail always shows "PI approved" before "confirmed order created",
--       whether they were one press or two.
--   7.  Unchanged in rule; the refusals it raises leave the 6b stamp behind?
--       NO — a refusal aborts the whole transaction, so a reviewer who wants
--       the PI decision recorded while payment is unresolved uses
--       approve_pi_review(). The screen chooses the right door.
--   14b. V1 of the Order's PI history is written.
--   15.  The 'approved' event carries the attached figures too.

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
  --
  -- The same authority that will create the Order is approving the document in
  -- the same act. Stamped here, before the payment gate, so the trail reads
  -- "PI approved" and then "confirmed order created" whether it took one press
  -- or two. A refusal below rolls this back with everything else; a reviewer
  -- who wants the decision kept while payment is unresolved has approve_pi_review().
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

  -- The PI decision is its own event, logged only now that nothing below it
  -- can roll it back for a reason the reviewer could not see.
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

  -- ── 16. Close the context before returning ──
  perform set_config('boe.pi_submission_approval_id', '', true);

  -- ── 17. Identifiers only. Nothing the caller could not already read. ──
  return jsonb_build_object(
    'submission_id',    p_submission_id,
    'order_id',         v_order_id,
    'display_number',   v_number,
    'already_approved', false,
    'payment_route',    v_route,
    'moved_allocations', v_moved_count
  );
end;
$$;

revoke all on function public.approve_order_submission(uuid) from public;
grant execute on function public.approve_order_submission(uuid) to authenticated;

comment on function public.approve_order_submission(uuid) is
  'Creates exactly one Confirmed Order from a submitted PI, in one transaction, for a caller holding orders.approve_order. Requires a CURRENT finance check, FINANCE-VERIFIED payment of at least 40% of the grand total or a CURRENT approved reduced-payment exception, and every completeness rule, all re-derived under row locks. Since 20261116000000 it also records the PI decision itself (stamping it when this is the first press), writes V1 of the Order''s PI history, and the Order is born production_alignment = not_aligned. Records no payment of any kind.';


-- ═══ 10. History ════════════════════════════════════════════════════════════

-- 10a. An Order's viewer may read the trail of the PI it came from — the same
-- door 20260924000000 opened for the submission, its items and its images.
drop policy if exists "order_submission_activity_confirmed_order_select" on public.order_submission_activity;
create policy "order_submission_activity_confirmed_order_select" on public.order_submission_activity
  for select to authenticated
  using (public.can_view_order_submission_via_order(submission_id));

comment on policy "order_submission_activity_confirmed_order_select" on public.order_submission_activity is
  'Order-side sight of the approved PI''s history, so a Confirmed Order can show the whole chronology from draft to alignment. Additive to order_submission_activity_select; still ANDed with the RESTRICTIVE module entry gate.';

-- 10b. Finance's decision on a payment, echoed onto the PI and the Order it is
-- allocated to.
--
-- A DEFERRED CONSTRAINT TRIGGER, because approve_finance_payment_request()
-- writes the status first and converts the allocation intents AFTER it: a
-- row-time AFTER trigger would see no allocation to echo onto. At commit every
-- allocation the approval created is visible.
--
-- It echoes; it decides nothing. The Finance trail remains the authority for
-- the payment; these rows exist so the PI and the Order can say "Finance
-- verified ₹X on <date>" without their readers needing Finance sight.
create or replace function public.finance_payment_requests_echo_decision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_verified boolean;
  v_actor  uuid;
  v_alloc  record;
  v_status text;
begin
  if public.finance_payment_status_is_verified(new.status)
     and not public.finance_payment_status_is_verified(old.status) then
    v_verified := true;
    v_actor  := coalesce(new.approved_by, auth.uid());
  elsif new.status = 'rejected' and old.status is distinct from 'rejected' then
    v_verified := false;
    v_actor  := auth.uid();
  else
    return null;
  end if;

  for v_alloc in
    select a.order_submission_id, a.order_id, a.allocated_amount
    from public.finance_payment_allocations a
    where a.payment_request_id = new.id
      and a.status = 'active'
  loop
    if v_alloc.order_submission_id is not null then
      select s.status into v_status from public.order_submissions s
      where s.id = v_alloc.order_submission_id;
      perform public.log_order_submission_activity(
        v_alloc.order_submission_id, v_actor,
        case when v_verified then 'payment_verified' else 'payment_rejected' end,
        v_status, v_status, null,
        jsonb_build_object(
          'payment_id',       new.id,
          'request_number',   new.request_number,
          'human_payment_id', new.human_payment_id,
          'allocated_amount', v_alloc.allocated_amount,
          'payment_amount',   new.amount,
          'payment_status',   new.status,
          'admin_note',       new.admin_note
        )
      );
    end if;

    if v_alloc.order_id is not null then
      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (v_alloc.order_id, v_actor,
              case when v_verified then 'payment_verified' else 'payment_rejected' end,
              jsonb_build_object(
                'payment_id',       new.id,
                'request_number',   new.request_number,
                'human_payment_id', new.human_payment_id,
                'allocated_amount', v_alloc.allocated_amount,
                'payment_amount',   new.amount,
                'payment_status',   new.status,
                'admin_note',       new.admin_note));
    end if;
  end loop;

  return null;
end;
$$;

revoke execute on function public.finance_payment_requests_echo_decision()
  from public, anon, authenticated, service_role;

drop trigger if exists finance_payment_requests_echo_decision on public.finance_payment_requests;
create constraint trigger finance_payment_requests_echo_decision
  after update of status on public.finance_payment_requests
  deferrable initially deferred
  for each row execute function public.finance_payment_requests_echo_decision();

comment on function public.finance_payment_requests_echo_decision() is
  'At commit, after a payment moves into a verified status or into rejected, writes payment_verified / payment_rejected onto every PI and Order its ACTIVE allocations name. Deferred so the allocations approve_finance_payment_request() creates after the status write are visible. Echoes the Finance decision; takes none.';


-- ═══ 11. Notifications ══════════════════════════════════════════════════════
alter type notification_type add value if not exists 'pi_revision_proposed';
alter type notification_type add value if not exists 'pi_revision_approved';
alter type notification_type add value if not exists 'pi_revision_rejected';


-- ═══ 12. Apply-time assertions ══════════════════════════════════════════════
do $$
declare
  v_n       integer;
  v_def     text;
  v_fn      text;
  v_missing text[] := '{}';
  v_action  text;
begin
  -- Columns.
  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'order_submissions'
    and column_name in ('pi_approved_by', 'pi_approved_at', 'pi_approved_submission_at');
  if v_n <> 3 then
    raise exception 'ASSERTION FAILED: the three PI-decision columns are not all present';
  end if;

  select count(*) into v_n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'orders'
    and column_name in ('production_alignment', 'production_aligned_by',
                        'production_aligned_at', 'production_alignment_note');
  if v_n <> 4 then
    raise exception 'ASSERTION FAILED: the four production-alignment columns are not all present';
  end if;

  select column_default into v_def
  from information_schema.columns
  where table_schema = 'public' and table_name = 'orders' and column_name = 'production_alignment';
  if v_def not like '%not_aligned%' then
    raise exception 'ASSERTION FAILED: production_alignment does not default to not_aligned';
  end if;

  if exists (select 1 from public.orders where production_alignment <> 'not_aligned') then
    raise exception 'ASSERTION FAILED: an existing Order was born aligned';
  end if;

  -- Functions.
  foreach v_fn in array array[
    'public.order_submission_pi_approved(timestamptz, timestamptz, timestamptz)',
    'public.order_submissions_guard_pi_approval()',
    'public.order_submission_attached_payment(uuid)',
    'public.approve_pi_review(uuid)',
    'public.order_pi_versions_guard()',
    'public.can_write_order_pi_revision_file(uuid)',
    'public.propose_order_pi_revision(uuid, text, text, text)',
    'public.reject_order_pi_revision(uuid, text)',
    'public.approve_order_pi_revision(uuid, uuid, jsonb)',
    'public.in_production_alignment()',
    'public.set_order_production_alignment(uuid, boolean, text)',
    'public.finance_payment_requests_echo_decision()'
  ]
  loop
    if to_regprocedure(v_fn) is null then
      v_missing := array_append(v_missing, v_fn);
    end if;
  end loop;
  if array_length(v_missing, 1) is not null then
    raise exception 'ASSERTION FAILED: not installed: %', array_to_string(v_missing, ', ');
  end if;

  -- Client-callable doors, and only those.
  foreach v_fn in array array[
    'public.approve_pi_review(uuid)',
    'public.propose_order_pi_revision(uuid, text, text, text)',
    'public.reject_order_pi_revision(uuid, text)',
    'public.set_order_production_alignment(uuid, boolean, text)',
    'public.approve_order_submission(uuid)',
    'public.pi_submission_payment_summary(uuid)'
  ]
  loop
    if not has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception 'ASSERTION FAILED: % is not executable by authenticated', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'ASSERTION FAILED: % is executable by anon', v_fn;
    end if;
  end loop;

  foreach v_fn in array array[
    'public.approve_order_pi_revision(uuid, uuid, jsonb)',
    'public.order_submission_attached_payment(uuid)',
    'public.submit_pi_for_review_internal(uuid, text, text, text, text)',
    'public.order_pi_versions_guard()',
    'public.order_submissions_guard_pi_approval()',
    'public.finance_payment_requests_echo_decision()'
  ]
  loop
    if has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('anon', v_fn, 'execute') then
      raise exception 'ASSERTION FAILED: % is executable by a client role', v_fn;
    end if;
  end loop;

  -- No stale overload on any name this file introduces.
  for v_fn in
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('approve_pi_review', 'propose_order_pi_revision', 'reject_order_pi_revision',
                        'approve_order_pi_revision', 'set_order_production_alignment',
                        'order_submission_attached_payment', 'order_submission_pi_approved')
    group by p.proname having count(*) > 1
  loop
    raise exception 'ASSERTION FAILED: % has more than one overload', v_fn;
  end loop;

  -- The re-emitted bodies say what this file says they say.
  select pg_get_functiondef('public.approve_order_submission(uuid)'::regprocedure) into v_def;
  -- The marker is SET here and READ by order_pi_versions_guard(); this function
  -- names the GUC, not the predicate, so that is what is asserted.
  if v_def not like '%pi_approved_submission_at%'
     or v_def not like '%order_pi_versions%'
     or v_def not like '%boe.pi_submission_approval_id%' then
    raise exception 'ASSERTION FAILED: approve_order_submission was not re-emitted with the PI decision and the V1 history row';
  end if;
  if v_def not like '%order_submission_finance_verified%'
     or v_def not like '%order_submission_exception_current%'
     or v_def not like '%ORDER_SUBMISSION_ALLOCATION_NOT_MOVED%' then
    raise exception 'ASSERTION FAILED: approve_order_submission lost a rule it had';
  end if;

  select pg_get_functiondef('public.submit_pi_for_review_internal(uuid, text, text, text, text)'::regprocedure) into v_def;
  if v_def not like '%v_attached >= v_required%' then
    raise exception 'ASSERTION FAILED: the submission route is not chosen on attached payment';
  end if;

  select pg_get_functiondef('public.orders_guard_amendable_columns()'::regprocedure) into v_def;
  if v_def not like '%in_production_alignment%' or v_def not like '%ORDER_AMENDMENT_REQUIRED%' then
    raise exception 'ASSERTION FAILED: the orders column guard was not re-emitted with the alignment clause';
  end if;

  -- The action set admits every event this file logs.
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.order_submission_activity'::regclass
    and c.conname = 'order_submission_activity_action_check';
  foreach v_action in array array[
    'pi_approved', 'payment_verified', 'payment_rejected',
    'pi_revision_proposed', 'pi_revision_approved', 'pi_revision_rejected',
    'order_number_used', 'workbook_replaced_by_admin', 'approved', 'finance_verified'
  ]
  loop
    if v_def not like '%''' || v_action || '''%' then
      raise exception 'ASSERTION FAILED: the activity constraint does not admit %', v_action;
    end if;
  end loop;

  -- Versions: exactly one current per Order, at most one pending, and V1 for
  -- every Order that came from a PI.
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'order_pi_versions_one_current_per_order')
     or not exists (select 1 from pg_indexes where schemaname = 'public'
                    and indexname = 'order_pi_versions_one_pending_per_order') then
    raise exception 'ASSERTION FAILED: the two partial unique indexes on order_pi_versions are missing';
  end if;

  select count(*) into v_n
  from public.orders o
  where o.source_order_submission_id is not null
    and exists (select 1 from public.order_submissions s where s.id = o.source_order_submission_id)
    and not exists (select 1 from public.order_pi_versions v
                    where v.order_id = o.id and v.status = 'approved');
  if v_n <> 0 then
    raise exception 'ASSERTION FAILED: % Order(s) from a PI have no current PI version after the backfill', v_n;
  end if;

  -- Privileges on the new table: read only for clients.
  if has_table_privilege('authenticated', 'public.order_pi_versions', 'insert')
     or has_table_privilege('authenticated', 'public.order_pi_versions', 'update')
     or has_table_privilege('authenticated', 'public.order_pi_versions', 'delete')
     or has_table_privilege('anon', 'public.order_pi_versions', 'select') then
    raise exception 'ASSERTION FAILED: a client role can write order_pi_versions, or anon can read it';
  end if;
  if not has_table_privilege('authenticated', 'public.order_pi_versions', 'select') then
    raise exception 'ASSERTION FAILED: authenticated cannot read order_pi_versions';
  end if;

  -- The permission action is registered and linked to Orders.
  if not exists (
    select 1 from public.module_permission_actions mpa
    join public.permission_modules pm on pm.id = mpa.module_id
    join public.permission_actions pa on pa.id = mpa.action_id
    where pm.module_key = 'orders' and pa.action_key = 'align_production'
  ) then
    raise exception 'ASSERTION FAILED: orders.align_production is not registered';
  end if;

  -- The policies exist.
  if not exists (select 1 from pg_policies where schemaname = 'public'
                 and tablename = 'order_submission_activity'
                 and policyname = 'order_submission_activity_confirmed_order_select') then
    raise exception 'ASSERTION FAILED: the Order-side activity policy is missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage'
                 and tablename = 'objects' and policyname = 'order_files_revision_insert') then
    raise exception 'ASSERTION FAILED: the revision upload policy is missing';
  end if;

  raise notice '20261116000000 applied: PI decision, attached-payment submission rule, PI versions, production alignment.';
end $$;

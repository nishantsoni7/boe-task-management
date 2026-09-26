-- ═══════════════════════════════════════════════════════════════════════════
-- 20270122000000  PI INTERNAL DETAILS — the dates and the middleman answer
--                 Sales confirms in the app before a PI goes for review
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- PID-00002 went for review with a confirmation date and a due date nobody had
-- confirmed: the dates typed on 24 Sep (confirmation 23 Sep, due 15 Sep — a
-- due date BEFORE the confirmation date) were silently overwritten by the next
-- workbook upload (20 Sep / 20 Nov), and the audit entry for that upload said
-- only how many product lines it had. The reviewer then had to send the PI back
-- asking for the dates.
--
-- So a PI now carries, as APP fields the client never sees:
--
--   order_confirmation_date, due_date   (existing columns) — prefilled from the
--                                       workbook, correctable in the app, and
--                                       CONFIRMED by Sales before submission.
--   workbook_order_confirmation_date,   what the workbook itself said, kept
--   workbook_due_date                   apart so a correction in the app never
--                                       pretends the workbook said something else.
--   middleman_commission                'yes' | 'no' — the question must be
--                                       answered, not assumed.
--   middleman_recipient, _basis,        when 'yes': who, and either a rupee
--   _amount, _percent, _percent_of      amount or a percentage OF A NAMED FIGURE.
--   internal_details_confirmed_at/_by   stamped only by the save RPC's confirm.
--   discount_label                      the wording the workbook printed beside
--                                       the deduction row ("Design Fee",
--                                       "Discount", …). Display only: the figure
--                                       is ALWAYS a deduction, whatever it says.
--
-- WHAT THIS FILE DOES, AND DELIBERATELY DOES NOT
-- ----------------------------------------------
-- PHASE 1 (this file) IS PURELY ADDITIVE for the deployed application:
--   * nullable columns, no backfill;
--   * one new RPC, save_order_submission_internal_details();
--   * a guard trigger that CLEARS the confirmation when a confirmed answer
--     changes by any other path (a workbook replacement, the schedule editor)
--     and refuses a confirmation stamp written by anything but the RPC;
--   * replace_order_submission_parse() as 20261120000000 left it, plus:
--       - a BLANK workbook date no longer erases the date Sales entered in the
--         app while the PI is a draft or returned (the old behaviour nulled it);
--       - the workbook's own dates and discount wording are recorded;
--       - the parse_replaced entry records BEFORE and AFTER amounts, dates and
--         workbook hash, not just counts;
--   * the readiness check order_submission_internal_details_problem(), which
--     answers "what is still missing" and is called by NOTHING here.
--
-- PHASE 2 (20270123000000, a separate PR) wires that check in front of every
-- submission door. It is split for the reason 20261225000000 gives: applied
-- before the new screen is live, it would refuse every PI submission for
-- answers the deployed screen has no way to give.
--
-- WHAT A CLIENT DOCUMENT PRINTS. The generated PDFs (src/lib/orders/
-- confirmedPdf.ts — the confirmed-order PDF and the PI version PDF) print NO
-- confirmation date and NO due date from any source, and print a non-zero
-- deduction as "Discount" (a zero one is left off). The internal answers are
-- never printed. The original uploaded workbook and the confirmed Excel copy
-- are unchanged files: whatever dates and wording the workbook holds, they
-- still hold, and sharing them shares that.

do $$
begin
  if to_regprocedure('public.log_order_submission_activity(uuid, uuid, text, text, text, text, jsonb)') is null then
    raise exception 'DEPENDENCY MISSING: 20260908000000 must be applied before this migration';
  end if;
  if to_regprocedure('public.can_edit_order_submission(uuid)') is null then
    raise exception 'DEPENDENCY MISSING: can_edit_order_submission must exist before this migration';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_submissions' and column_name = 'row_version'
  ) then
    raise exception 'DEPENDENCY MISSING: 20260928000000 (row_version) must be applied before this migration';
  end if;
end $$;


-- ═══ 1. Columns ═════════════════════════════════════════════════════════════

alter table public.order_submissions
  add column if not exists workbook_order_confirmation_date date,
  add column if not exists workbook_due_date                date,
  add column if not exists discount_label                   text,
  add column if not exists middleman_commission             text,
  add column if not exists middleman_recipient              text,
  add column if not exists middleman_commission_basis       text,
  add column if not exists middleman_commission_amount      numeric(14, 2),
  add column if not exists middleman_commission_percent     numeric(6, 3),
  add column if not exists middleman_commission_percent_of  text,
  add column if not exists internal_details_confirmed_at    timestamptz,
  add column if not exists internal_details_confirmed_by    uuid references public.users(id);

-- SHAPE ONLY. A draft may be half-answered ("Yes", recipient not typed yet);
-- what it may never be is self-contradictory. Completeness is the readiness
-- check's job, at the moment it matters.
alter table public.order_submissions
  drop constraint if exists order_submissions_discount_label_len,
  add  constraint order_submissions_discount_label_len
    check (discount_label is null or char_length(discount_label) between 1 and 200),
  drop constraint if exists order_submissions_middleman_answer,
  add  constraint order_submissions_middleman_answer
    check (middleman_commission is null or middleman_commission in ('yes', 'no')),
  drop constraint if exists order_submissions_middleman_recipient_len,
  add  constraint order_submissions_middleman_recipient_len
    check (middleman_recipient is null or char_length(middleman_recipient) between 1 and 200),
  drop constraint if exists order_submissions_middleman_basis,
  add  constraint order_submissions_middleman_basis
    check (middleman_commission_basis is null or middleman_commission_basis in ('amount', 'percent')),
  drop constraint if exists order_submissions_middleman_percent_of,
  add  constraint order_submissions_middleman_percent_of
    check (middleman_commission_percent_of is null or middleman_commission_percent_of in
           ('gross_product_amount', 'subtotal_after_discount', 'total_before_gst', 'grand_total')),
  drop constraint if exists order_submissions_middleman_amount_range,
  add  constraint order_submissions_middleman_amount_range
    check (middleman_commission_amount is null or middleman_commission_amount > 0),
  drop constraint if exists order_submissions_middleman_percent_range,
  add  constraint order_submissions_middleman_percent_range
    check (middleman_commission_percent is null
           or (middleman_commission_percent > 0 and middleman_commission_percent <= 100)),
  -- "No" carries nothing else.
  drop constraint if exists order_submissions_middleman_no_is_empty,
  add  constraint order_submissions_middleman_no_is_empty
    check (middleman_commission is distinct from 'no'
           or (middleman_recipient is null and middleman_commission_basis is null
               and middleman_commission_amount is null and middleman_commission_percent is null
               and middleman_commission_percent_of is null)),
  -- A basis belongs to a "Yes", and each basis carries only its own figure.
  drop constraint if exists order_submissions_middleman_basis_fits,
  add  constraint order_submissions_middleman_basis_fits
    check ((middleman_commission_basis is null or middleman_commission = 'yes')
           and (middleman_commission_basis is distinct from 'amount'
                or (middleman_commission_percent is null and middleman_commission_percent_of is null))
           and (middleman_commission_basis is distinct from 'percent'
                or middleman_commission_amount is null)
           and (middleman_commission_basis is not null
                or (middleman_commission_amount is null and middleman_commission_percent is null
                    and middleman_commission_percent_of is null))),
  drop constraint if exists order_submissions_internal_confirmation_pair,
  add  constraint order_submissions_internal_confirmation_pair
    check ((internal_details_confirmed_at is null) = (internal_details_confirmed_by is null));

comment on column public.order_submissions.workbook_order_confirmation_date is
  'The order confirmation date AS THE WORKBOOK STATED IT at the last upload (null when blank). order_confirmation_date is the app value Sales confirms; the two are kept apart so an app correction never rewrites what the workbook said. 20270122000000.';
comment on column public.order_submissions.workbook_due_date is
  'The due date AS THE WORKBOOK STATED IT at the last upload (null when blank or a commitment rather than a date). due_date is the app value Sales confirms. 20270122000000.';
comment on column public.order_submissions.discount_label is
  'The wording the workbook printed beside the deduction row ("Design Fee" by default, "Discount" when one is offered). DISPLAY PROVENANCE ONLY: discount_amount is always a deduction whatever this says. 20270122000000.';
comment on column public.order_submissions.middleman_commission is
  'INTERNAL — never on a client document. Sales'' answer to "Is there a middleman commission?": yes | no; null = not yet answered. 20270122000000.';
comment on column public.order_submissions.middleman_commission_percent_of is
  'INTERNAL. The figure a percentage commission is a percentage OF, so "5%" is never ambiguous. 20270122000000.';
comment on column public.order_submissions.internal_details_confirmed_at is
  'When Sales last confirmed the internal details (dates and middleman answer). Stamped only by save_order_submission_internal_details(p_confirm => true); cleared by order_submissions_internal_details_guard when a confirmed answer changes by any other path while the PI is a draft or returned. 20270122000000.';


-- ═══ 2. The activity action ══════════════════════════════════════════════════
--
-- Everything 20261119000000 left in force (the same 33, checked against
-- production on 2026-09-26), plus the one this file logs. Written out, as every
-- earlier redefinition was, so orderActivityActions.test.ts can read the set.

alter table public.order_submission_activity
  drop constraint if exists order_submission_activity_action_check;

alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    -- ── Everything 20261119000000 left in force ──
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
    'pi_approved',
    'payment_verified',
    'payment_rejected',
    'pi_revision_proposed',
    'pi_revision_approved',
    'pi_revision_rejected',
    -- ── 20270122000000 ──
    'internal_details_updated'
  ));


-- ═══ 3. The confirmation guard ════════════════════════════════════════════════
--
-- A CONFIRMATION MEANS "SALES LOOKED AT THESE VALUES". So:
--   * only the save RPC's confirm may stamp it (it sets a transaction-local
--     flag naming this row); anything else writing a non-null stamp is refused;
--   * while the PI is a draft or returned, ANY other change to a confirmed
--     answer — the schedule editor moving a date, a new workbook arriving —
--     clears it, so Sales confirms again before submitting.
-- After submission the activity trail is the record; nothing is cleared there.

create or replace function public.order_submissions_internal_details_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_confirming boolean :=
    coalesce(current_setting('boe.pi_internal_details_confirm', true), '') = new.id::text;
begin
  if not v_confirming
     and new.internal_details_confirmed_at is not null
     and (new.internal_details_confirmed_at is distinct from old.internal_details_confirmed_at
          or new.internal_details_confirmed_by is distinct from old.internal_details_confirmed_by) then
    raise exception
      'ORDER_SUBMISSION_INTERNAL_DETAILS_CONFIRM_PATH: internal details are confirmed only through save_order_submission_internal_details()'
      using errcode = '42501';
  end if;

  if not v_confirming
     and old.status in ('draft', 'needs_changes')
     and old.internal_details_confirmed_at is not null
     and (new.order_confirmation_date         is distinct from old.order_confirmation_date
       or new.due_date                        is distinct from old.due_date
       or new.middleman_commission            is distinct from old.middleman_commission
       or new.middleman_recipient             is distinct from old.middleman_recipient
       or new.middleman_commission_basis      is distinct from old.middleman_commission_basis
       or new.middleman_commission_amount     is distinct from old.middleman_commission_amount
       or new.middleman_commission_percent    is distinct from old.middleman_commission_percent
       or new.middleman_commission_percent_of is distinct from old.middleman_commission_percent_of
       or new.source_workbook_sha256          is distinct from old.source_workbook_sha256) then
    new.internal_details_confirmed_at := null;
    new.internal_details_confirmed_by := null;
  end if;

  return new;
end;
$$;
revoke execute on function public.order_submissions_internal_details_guard() from public, anon, authenticated, service_role;
drop trigger if exists order_submissions_internal_details_guard on public.order_submissions;
create trigger order_submissions_internal_details_guard
  before update on public.order_submissions
  for each row execute function public.order_submissions_internal_details_guard();


-- ═══ 4. What is still missing ═════════════════════════════════════════════════
--
-- ONE ANSWER, IN FORM ORDER, or NULL when the PI is ready. Phase 2 raises it as
-- ORDER_SUBMISSION_INCOMPLETE; src/lib/orders/piInternalDetails.ts mirrors it
-- for the screen. Called by nothing in this file.

create or replace function public.order_submission_internal_details_problem(p_submission_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  s public.order_submissions%rowtype;
begin
  select * into s from public.order_submissions where id = p_submission_id;
  if not found then
    return 'the PI was not found';
  end if;
  if s.order_confirmation_date is null then
    return 'enter the order confirmation date';
  end if;
  if s.due_date is null then
    return 'enter the due date';
  end if;
  if s.due_date < s.order_confirmation_date then
    return 'the due date is before the order confirmation date';
  end if;
  if s.middleman_commission is null then
    return 'answer "Is there a middleman commission?"';
  end if;
  if s.middleman_commission = 'yes' then
    if s.middleman_recipient is null then
      return 'name who receives the middleman commission';
    end if;
    if s.middleman_commission_basis is null then
      return 'give the middleman commission as an amount or a percentage';
    end if;
    if s.middleman_commission_basis = 'amount' and s.middleman_commission_amount is null then
      return 'enter the middleman commission amount';
    end if;
    if s.middleman_commission_basis = 'percent'
       and (s.middleman_commission_percent is null or s.middleman_commission_percent_of is null) then
      return 'enter the middleman commission percentage and what it is a percentage of';
    end if;
  end if;
  if s.internal_details_confirmed_at is null then
    return 'confirm the internal details';
  end if;
  return null;
end;
$$;
revoke execute on function public.order_submission_internal_details_problem(uuid) from public, anon, authenticated;
comment on function public.order_submission_internal_details_problem(uuid) is
  'Null when a PI''s internal details (confirmed dates in order, and a complete middleman commission answer) are ready for submission; otherwise the first missing thing, in form order. Wired in front of submission by 20270123000000. 20270122000000.';


-- ═══ 5. The editor ════════════════════════════════════════════════════════════
--
-- FULL STATE, NOT A PATCH. The form always sends all eight answers; a key left
-- out is an answer of "blank". Unknown keys are refused by name.
--
-- p_confirm = false saves a draft (shape-checked only; a change clears any
-- earlier confirmation through the guard). p_confirm = true additionally
-- requires the answers to be complete and stamps who confirmed them and when.

create or replace function public.save_order_submission_internal_details(
  p_submission_id    uuid,
  p_details          jsonb,
  p_expected_version integer,
  p_confirm          boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_sub      public.order_submissions%rowtype;
  v_key      text;
  v_text     text;
  v_confirm  date;
  v_due      date;
  v_answer   text;
  v_who      text;
  v_basis    text;
  v_amount   numeric;
  v_percent  numeric;
  v_of       text;
  v_changes  jsonb := '{}'::jsonb;
  v_version  integer;
  v_problem  text;
  v_stamp    boolean;
  c_keys constant text[] := array[
    'order_confirmation_date', 'due_date', 'middleman_commission', 'middleman_recipient',
    'middleman_commission_basis', 'middleman_commission_amount',
    'middleman_commission_percent', 'middleman_commission_percent_of'];
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of answers is required'
      using errcode = 'P0001';
  end if;
  for v_key in select jsonb_object_keys(p_details) loop
    if not (v_key = any (c_keys)) then
      raise exception 'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an internal detail', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_details -> v_key) not in ('string', 'number', 'null') then
      raise exception 'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text, a number or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  -- Owner (or an active admin) while the PI is a draft or returned, and never
  -- once it has an Order — exactly can_edit_order_submission's answer.
  if not public.can_edit_order_submission(p_submission_id) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: the internal details can be changed only while the PI is a draft or returned for changes'
      using errcode = '42501';
  end if;

  if p_expected_version is not null and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  -- ── Dates ──
  foreach v_key in array array['order_confirmation_date', 'due_date'] loop
    v_text := nullif(btrim(coalesce(p_details ->> v_key, '')), '');
    if v_text is not null then
      if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'ORDER_SUBMISSION_BAD_DATE: % must be a calendar date in YYYY-MM-DD form', v_key
          using errcode = 'P0001';
      end if;
      begin
        perform v_text::date;
      exception when others then
        raise exception 'ORDER_SUBMISSION_BAD_DATE: % must be a calendar date in YYYY-MM-DD form', v_key
          using errcode = 'P0001';
      end;
    end if;
    if v_key = 'order_confirmation_date' then v_confirm := v_text::date; else v_due := v_text::date; end if;
  end loop;
  if v_confirm is not null and v_due is not null and v_due < v_confirm then
    raise exception
      'ORDER_SUBMISSION_DUE_BEFORE_CONFIRMATION: the due date (%) cannot be before the order confirmation date (%)',
      v_due, v_confirm
      using errcode = 'P0001';
  end if;

  -- ── The middleman answer ──
  v_answer := nullif(btrim(lower(coalesce(p_details ->> 'middleman_commission', ''))), '');
  v_who    := nullif(btrim(coalesce(p_details ->> 'middleman_recipient', '')), '');
  v_basis  := nullif(btrim(lower(coalesce(p_details ->> 'middleman_commission_basis', ''))), '');
  v_of     := nullif(btrim(lower(coalesce(p_details ->> 'middleman_commission_percent_of', ''))), '');
  begin
    v_amount  := nullif(btrim(coalesce(p_details ->> 'middleman_commission_amount', '')), '')::numeric;
    v_percent := nullif(btrim(coalesce(p_details ->> 'middleman_commission_percent', '')), '')::numeric;
  exception when others then
    raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: the commission amount and percentage must be numbers'
      using errcode = 'P0001';
  end;

  if v_answer is not null and v_answer not in ('yes', 'no') then
    raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: answer Yes or No'
      using errcode = 'P0001';
  end if;
  if coalesce(v_answer, '') <> 'yes'
     and (v_who is not null or v_basis is not null or v_amount is not null
          or v_percent is not null or v_of is not null) then
    raise exception
      'ORDER_SUBMISSION_COMMISSION_CONTRADICTION: commission details are given only when the answer is Yes'
      using errcode = 'P0001';
  end if;
  if v_who is not null and char_length(v_who) > 200 then
    raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: the recipient may be at most 200 characters'
      using errcode = 'P0001';
  end if;
  if v_basis is not null and v_basis not in ('amount', 'percent') then
    raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: give the commission as an amount or a percentage'
      using errcode = 'P0001';
  end if;
  if (v_basis is distinct from 'amount' and v_amount is not null)
     or (v_basis is distinct from 'percent' and (v_percent is not null or v_of is not null)) then
    raise exception
      'ORDER_SUBMISSION_COMMISSION_CONTRADICTION: send the amount for an amount, or the percentage and its base for a percentage — not both'
      using errcode = 'P0001';
  end if;
  if v_amount is not null then
    if v_amount = 'NaN'::numeric or v_amount <= 0 then
      raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: the commission amount must be more than zero'
        using errcode = 'P0001';
    end if;
    if v_amount <> round(v_amount, 2) then
      raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: the commission amount may have at most two decimal places'
        using errcode = 'P0001';
    end if;
    if v_sub.grand_total is not null and v_amount > v_sub.grand_total then
      raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: the commission amount cannot exceed the grand total of %',
        v_sub.grand_total
        using errcode = 'P0001';
    end if;
  end if;
  if v_percent is not null then
    if v_percent = 'NaN'::numeric or v_percent <= 0 or v_percent > 100 then
      raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: the commission percentage must be more than 0 and at most 100'
        using errcode = 'P0001';
    end if;
    if v_percent <> round(v_percent, 3) then
      raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: the commission percentage may have at most three decimal places'
        using errcode = 'P0001';
    end if;
  end if;
  if v_of is not null
     and v_of not in ('gross_product_amount', 'subtotal_after_discount', 'total_before_gst', 'grand_total') then
    raise exception 'ORDER_SUBMISSION_COMMISSION_INVALID: % is not a figure a commission can be a percentage of', v_of
      using errcode = 'P0001';
  end if;

  -- ── What changed ──
  if v_confirm is distinct from v_sub.order_confirmation_date then
    v_changes := v_changes || jsonb_build_object('order_confirmation_date',
      jsonb_build_object('from', v_sub.order_confirmation_date, 'to', v_confirm));
  end if;
  if v_due is distinct from v_sub.due_date then
    v_changes := v_changes || jsonb_build_object('due_date',
      jsonb_build_object('from', v_sub.due_date, 'to', v_due));
  end if;
  if v_answer is distinct from v_sub.middleman_commission then
    v_changes := v_changes || jsonb_build_object('middleman_commission',
      jsonb_build_object('from', v_sub.middleman_commission, 'to', v_answer));
  end if;
  if v_who is distinct from v_sub.middleman_recipient then
    v_changes := v_changes || jsonb_build_object('middleman_recipient',
      jsonb_build_object('from', v_sub.middleman_recipient, 'to', v_who));
  end if;
  if v_basis is distinct from v_sub.middleman_commission_basis then
    v_changes := v_changes || jsonb_build_object('middleman_commission_basis',
      jsonb_build_object('from', v_sub.middleman_commission_basis, 'to', v_basis));
  end if;
  if v_amount is distinct from v_sub.middleman_commission_amount then
    v_changes := v_changes || jsonb_build_object('middleman_commission_amount',
      jsonb_build_object('from', v_sub.middleman_commission_amount, 'to', v_amount));
  end if;
  if v_percent is distinct from v_sub.middleman_commission_percent then
    v_changes := v_changes || jsonb_build_object('middleman_commission_percent',
      jsonb_build_object('from', v_sub.middleman_commission_percent, 'to', v_percent));
  end if;
  if v_of is distinct from v_sub.middleman_commission_percent_of then
    v_changes := v_changes || jsonb_build_object('middleman_commission_percent_of',
      jsonb_build_object('from', v_sub.middleman_commission_percent_of, 'to', v_of));
  end if;

  -- A confirm stamps even when nothing changed — "I have looked, and these are
  -- right" is the point. A plain save with nothing changed writes nothing.
  v_stamp := coalesce(p_confirm, false);
  if v_changes = '{}'::jsonb and not v_stamp then
    return jsonb_build_object('submission_id', p_submission_id, 'changed', false,
      'confirmed', v_sub.internal_details_confirmed_at is not null, 'row_version', v_sub.row_version);
  end if;

  if v_stamp then
    perform set_config('boe.pi_internal_details_confirm', p_submission_id::text, true);
  end if;

  update public.order_submissions set
    order_confirmation_date         = v_confirm,
    due_date                        = v_due,
    middleman_commission            = v_answer,
    middleman_recipient             = v_who,
    middleman_commission_basis      = v_basis,
    middleman_commission_amount     = v_amount,
    middleman_commission_percent    = v_percent,
    middleman_commission_percent_of = v_of,
    internal_details_confirmed_at   = case when v_stamp then now()   else internal_details_confirmed_at end,
    internal_details_confirmed_by   = case when v_stamp then v_actor else internal_details_confirmed_by end,
    row_version                     = row_version + 1,
    updated_at                      = now()
  where id = p_submission_id
  returning row_version into v_version;

  if v_stamp then
    -- Complete, or nothing is written: the stamp must never sit on answers
    -- that are not all there.
    v_problem := public.order_submission_internal_details_problem(p_submission_id);
    if v_problem is not null then
      raise exception 'ORDER_SUBMISSION_INCOMPLETE: %', v_problem using errcode = 'P0001';
    end if;
    perform set_config('boe.pi_internal_details_confirm', '', true);
  end if;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'internal_details_updated', v_sub.status, v_sub.status, null,
    jsonb_build_object(
      'changed', v_changes, 'fields', (select count(*) from jsonb_object_keys(v_changes)),
      'confirmed', v_stamp, 'stage', v_sub.status)
  );

  return jsonb_build_object('submission_id', p_submission_id, 'changed', v_changes <> '{}'::jsonb,
    'confirmed', v_stamp or (v_sub.internal_details_confirmed_at is not null and v_changes = '{}'::jsonb),
    'row_version', v_version);
end;
$$;
revoke execute on function public.save_order_submission_internal_details(uuid, jsonb, integer, boolean) from public, anon;
grant  execute on function public.save_order_submission_internal_details(uuid, jsonb, integer, boolean) to authenticated;
comment on function public.save_order_submission_internal_details(uuid, jsonb, integer, boolean) is
  'Saves a PI''s INTERNAL details — the app confirmation and due dates and the middleman commission answer — while it is a draft or returned. Full state, not a patch. p_confirm stamps internal_details_confirmed_at/by and requires the answers to be complete. Never printed on a client document. 20270122000000.';


-- ═══ 6. replace_order_submission_parse, as 20261120000000 left it, plus ═══════
--        the three changes named in the header.

create or replace function public.replace_order_submission_parse(
  p_submission_id uuid,
  p_actor_id      uuid,
  p_payload       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status      text;
  v_header      jsonb := coalesce(p_payload -> 'header', '{}'::jsonb);
  v_commercial  jsonb := coalesce(p_payload -> 'commercial', '{}'::jsonb);
  v_source      jsonb := coalesce(p_payload -> 'source', '{}'::jsonb);
  v_parse       jsonb := coalesce(p_payload -> 'parse', '{}'::jsonb);
  v_items       jsonb := coalesce(p_payload -> 'items', '[]'::jsonb);
  v_images      jsonb := coalesce(p_payload -> 'item_images', '[]'::jsonb);
  v_warnings    jsonb := coalesce(v_parse -> 'warnings', '[]'::jsonb);
  v_blocking    jsonb := coalesce(v_parse -> 'blocking_issues', '[]'::jsonb);
  v_count       integer;
  v_rep_count   integer;
  v_cust_count  integer;
  v_foreign     integer;
  v_fingerprint text := nullif(btrim(lower(coalesce(p_payload ->> 'fingerprint', ''))), '');
  v_previous    text;
  v_unchanged   boolean := false;
  -- Carried in the payload rather than as a fourth argument: `create or
  -- replace` cannot change a signature, and adding one would leave the old
  -- three-argument function in place as a token-free way in. The payload is
  -- built server-side by the same process that holds the lease.
  v_token       uuid := nullif(btrim(coalesce(p_payload ->> 'processing_token', '')), '')::uuid;
  v_held        uuid;
  -- What the workbook editor decided: whether this is an admin amendment after
  -- submission, and the reason it required.
  v_amend       jsonb;
  v_after       boolean;
  v_reason      text;
  v_order       uuid;
  v_superseded  integer := 0;
  v_cleared     boolean := false;
  -- 20270122000000: the row as it stood before this upload, and after it, so
  -- the parse_replaced entry records what the upload actually changed.
  v_was         public.order_submissions%rowtype;
  v_now         public.order_submissions%rowtype;
  -- While the PI is still being prepared, a blank workbook date leaves the
  -- date Sales entered in the app where it is (it used to erase it).
  v_preparing   boolean;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: a JSON object is required'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: items must be an array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_images) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: item_images must be an array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_warnings) <> 'array' or jsonb_typeof(v_blocking) <> 'array' then
    raise exception 'ORDER_SUBMISSION_PAYLOAD_INVALID: parse.warnings and parse.blocking_issues must be arrays'
      using errcode = 'P0001';
  end if;

  -- Serializes two uploads racing on the same submission, so the row the items
  -- are attached to is the row that was checked. The previous fingerprint is
  -- read under the same lock, so two concurrent replays cannot both decide they
  -- are the first.
  select s.status, s.parse_fingerprint, s.processing_token
    into v_status, v_previous, v_held
  from public.order_submissions s
  where s.id = p_submission_id
  for update;

  if not found then
    raise exception 'Order submission % not found', p_submission_id using errcode = 'P0002';
  end if;

  -- NO REPLACEMENT OUTSIDE THE LEASE.
  --
  -- The caller must present the token that currently holds this submission.
  -- That makes the whole three-step run — upload, replace, clean — the property
  -- of one processor, and it makes a late write from an abandoned attempt
  -- impossible: taking over a stale lease changes the token, so the old
  -- processor's replacement is refused rather than landing on top of the new
  -- one's work.
  if v_held is null or v_token is null or v_held <> v_token then
    raise exception
      'ORDER_SUBMISSION_PROCESSING_NOT_HELD: this parse replacement does not hold the processing lease'
      using errcode = '55P03';
  end if;

  -- Re-derives everything about p_actor_id from the database: active, holds
  -- orders.create, owns THIS submission, and the submission is still editable.
  -- THE ONLY AUTHORITY CHANGE. assert_order_submission_editor checks the STAGE
  -- before the actor, so an active admin can never replace a workbook on a PI
  -- that has left draft — the same structural bug can_edit_order_submission
  -- carried for the billing percentage. The workbook editor puts the actor
  -- first and takes a reason for an amendment.
  v_amend := public.assert_order_submission_workbook_editor(
    p_submission_id, p_actor_id,
    nullif(btrim(coalesce(p_payload ->> 'change_reason', '')), ''));

  -- A replay of the payload already stored. The write below still runs and is a
  -- no-op; what is suppressed is the audit entry, because nothing happened.
  v_unchanged := v_fingerprint is not null and v_previous is not null and v_fingerprint = v_previous;

  select * into v_was from public.order_submissions where id = p_submission_id;
  v_preparing := v_status in ('draft', 'needs_changes') and v_was.order_id is null;

  update public.order_submissions set
    parse_fingerprint       = v_fingerprint,
    client_name             = nullif(btrim(coalesce(v_header ->> 'client_name', '')), ''),
    creation_date           = nullif(v_header ->> 'creation_date', '')::date,
    source_created_by       = nullif(btrim(coalesce(v_header ->> 'source_created_by', '')), ''),
    boe_gst                 = nullif(btrim(coalesce(v_header ->> 'boe_gst', '')), ''),
    contact_number          = nullif(btrim(coalesce(v_header ->> 'contact_number', '')), ''),
    bill_to_name            = nullif(btrim(coalesce(v_header ->> 'bill_to_name', '')), ''),
    bill_to_phone           = nullif(btrim(coalesce(v_header ->> 'bill_to_phone', '')), ''),
    bill_to_gst             = nullif(btrim(coalesce(v_header ->> 'bill_to_gst', '')), ''),
    billing_address         = nullif(btrim(coalesce(v_header ->> 'billing_address', '')), ''),
    ship_to_name            = nullif(btrim(coalesce(v_header ->> 'ship_to_name', '')), ''),
    ship_to_phone           = nullif(btrim(coalesce(v_header ->> 'ship_to_phone', '')), ''),
    ship_to_gst             = nullif(btrim(coalesce(v_header ->> 'ship_to_gst', '')), ''),
    shipping_address        = nullif(btrim(coalesce(v_header ->> 'shipping_address', '')), ''),
    -- 20270122000000: a blank workbook date no longer erases the app date while
    -- the PI is being prepared. A date the workbook DOES carry still prefills
    -- the app field; the confirmation guard then asks Sales to confirm again.
    order_confirmation_date = case when v_preparing
      then coalesce(nullif(v_header ->> 'order_confirmation_date', '')::date, order_confirmation_date)
      else nullif(v_header ->> 'order_confirmation_date', '')::date end,
    workbook_order_confirmation_date = nullif(v_header ->> 'order_confirmation_date', '')::date,
    dispatch_commitment     = nullif(btrim(coalesce(v_header ->> 'dispatch_commitment', '')), ''),
    -- The dispatch DATE, when the document carried one. Decided entirely in
    -- src/lib/orders/dueDate.ts before the payload was built: this writes what
    -- it was given and never parses prose. A payload from an older build has no
    -- such key, and ->> yields NULL, which is the correct answer for it.
    due_date                = case when v_preparing
      then coalesce(nullif(v_header ->> 'due_date', '')::date, due_date)
      else nullif(v_header ->> 'due_date', '')::date end,
    workbook_due_date       = nullif(v_header ->> 'due_date', '')::date,
    source_order_number     = nullif(btrim(coalesce(v_header ->> 'source_order_number', '')), ''),

    source_workbook_path       = nullif(btrim(coalesce(v_source ->> 'workbook_path', '')), ''),
    source_workbook_name       = nullif(btrim(coalesce(v_source ->> 'workbook_name', '')), ''),
    source_workbook_size_bytes = nullif(v_source ->> 'workbook_size_bytes', '')::bigint,
    source_workbook_sha256     = nullif(btrim(lower(coalesce(v_source ->> 'workbook_sha256', ''))), ''),
    template_version           = nullif(btrim(coalesce(v_source ->> 'template_version', '')), ''),

    parse_warnings        = v_warnings,
    parse_blocking_issues = v_blocking,

    gross_product_amount    = coalesce(nullif(v_commercial ->> 'gross_product_amount', '')::numeric, 0),
    discount_amount         = coalesce(nullif(v_commercial ->> 'discount_amount', '')::numeric, 0),
    -- The row's printed wording, for display provenance only (20270122000000).
    discount_label          = left(nullif(btrim(coalesce(v_commercial ->> 'discount_label', '')), ''), 200),
    subtotal_after_discount = nullif(v_commercial ->> 'subtotal_after_discount', '')::numeric,

    -- The two cost cells: amount AND meaning AND wording, together, so the
    -- table constraint can prove they agree. A payload that omits the meaning
    -- falls back to 'numeric', which is what a plain figure is.
    fabric_cost             = nullif(v_commercial ->> 'fabric_cost', '')::numeric,
    fabric_cost_meaning     = coalesce(nullif(btrim(coalesce(v_commercial ->> 'fabric_cost_meaning', '')), ''), 'numeric'),
    fabric_cost_text        = nullif(btrim(coalesce(v_commercial ->> 'fabric_cost_text', '')), ''),
    packing_cost            = nullif(v_commercial ->> 'packing_cost', '')::numeric,
    packing_cost_meaning    = coalesce(nullif(btrim(coalesce(v_commercial ->> 'packing_cost_meaning', '')), ''), 'numeric'),
    packing_cost_text       = nullif(btrim(coalesce(v_commercial ->> 'packing_cost_text', '')), ''),

    transportation_amount   = nullif(v_commercial ->> 'transportation_amount', '')::numeric,
    transportation_text     = nullif(btrim(coalesce(v_commercial ->> 'transportation_text', '')), ''),
    total_before_gst        = nullif(v_commercial ->> 'total_before_gst', '')::numeric,
    gst_amount              = nullif(v_commercial ->> 'gst_amount', '')::numeric,
    grand_total             = nullif(v_commercial ->> 'grand_total', '')::numeric
  where id = p_submission_id;

  -- Atomic replacement. Deleting the items cascades their image rows away, so
  -- an obsolete picture from a previous upload cannot survive into the new
  -- reading of the document.
  delete from public.order_submission_items where submission_id = p_submission_id;

  insert into public.order_submission_items (
    id, submission_id, source_row, item_sequence, source_product_code, product_name,
    quantity, dimensions, material, customization, cost_per_piece, total_amount,
    image_storage_path, image_mime_type, image_sha256, image_anchor_row, sort_order
  )
  select
    -- The CLIENT may supply the item id, and now always does: the image keys
    -- contain it and the objects are uploaded BEFORE this function runs.
    coalesce(nullif(item ->> 'id', '')::uuid, gen_random_uuid()),
    p_submission_id,
    (item ->> 'source_row')::integer,
    nullif(btrim(coalesce(item ->> 'item_sequence', '')), ''),
    nullif(btrim(coalesce(item ->> 'source_product_code', '')), ''),
    nullif(btrim(coalesce(item ->> 'product_name', '')), ''),
    (item ->> 'quantity')::numeric,
    nullif(btrim(coalesce(item ->> 'dimensions', '')), ''),
    -- Separate columns, deliberately. Never merged.
    nullif(btrim(coalesce(item ->> 'material', '')), ''),
    nullif(btrim(coalesce(item ->> 'customization', '')), ''),
    (item ->> 'cost_per_piece')::numeric,
    (item ->> 'total_amount')::numeric,
    -- Legacy compatibility fields, written from the representative image.
    nullif(btrim(coalesce(item ->> 'image_storage_path', '')), ''),
    nullif(btrim(coalesce(item ->> 'image_mime_type', '')), ''),
    nullif(btrim(lower(coalesce(item ->> 'image_sha256', ''))), ''),
    nullif(item ->> 'image_anchor_row', '')::integer,
    coalesce(nullif(item ->> 'sort_order', '')::integer, (ordinality - 1)::integer)
  from jsonb_array_elements(v_items) with ordinality as t(item, ordinality);

  -- Every image must name an item of THIS submission. The composite foreign key
  -- below would refuse a foreign one anyway; this check exists so the failure
  -- is a named business error rather than a constraint violation, and so the
  -- count of them can be reported.
  select count(*) into v_foreign
  from jsonb_array_elements(v_images) as img
  where not exists (
    select 1 from public.order_submission_items i
    where i.id = nullif(img.value ->> 'item_id', '')::uuid
      and i.submission_id = p_submission_id
  );

  if v_foreign > 0 then
    raise exception
      'ORDER_SUBMISSION_IMAGE_ITEM_UNKNOWN: % image(s) name a product line that does not belong to this submission',
      v_foreign
      using errcode = 'P0001';
  end if;

  insert into public.order_submission_item_images (
    submission_id, item_id, role, position,
    storage_path, mime_type, sha256, source_media_path, anchor_row
  )
  select
    p_submission_id,
    (img ->> 'item_id')::uuid,
    img ->> 'role',
    (img ->> 'position')::integer,
    btrim(img ->> 'storage_path'),
    btrim(img ->> 'mime_type'),
    lower(btrim(img ->> 'sha256')),
    nullif(btrim(coalesce(img ->> 'source_media_path', '')), ''),
    (img ->> 'anchor_row')::integer
  from jsonb_array_elements(v_images) as t(img);

  select count(*) into v_count
  from public.order_submission_items where submission_id = p_submission_id;

  select
    count(*) filter (where role = 'representative'),
    count(*) filter (where role = 'customization')
  into v_rep_count, v_cust_count
  from public.order_submission_item_images where submission_id = p_submission_id;

  -- NO ENTRY FOR A REPLAY. Pressing Retry after a network timeout is not three
  -- submissions, and an append-only trail that said so would be a false record
  -- of what an employee did. A genuine re-parse — a corrected workbook, a
  -- different file — has a different fingerprint and is logged normally.
  if not v_unchanged then
    select * into v_now from public.order_submissions where id = p_submission_id;
    perform public.log_order_submission_activity(
      p_submission_id, p_actor_id, 'parse_replaced', v_status, v_status, null,
      jsonb_build_object(
        'item_count',                 v_count,
        'representative_image_count', v_rep_count,
        'customization_image_count',  v_cust_count,
        'warning_count',              jsonb_array_length(v_warnings),
        'blocking_issue_count',       jsonb_array_length(v_blocking),
        -- 20270122000000: WHAT THE UPLOAD CHANGED, not only how big it was.
        -- The same keys before and after, so a reader can diff them directly.
        'before', jsonb_build_object(
          'grand_total',             v_was.grand_total,
          'total_before_gst',        v_was.total_before_gst,
          'gst_amount',              v_was.gst_amount,
          'discount_amount',         v_was.discount_amount,
          'discount_label',          v_was.discount_label,
          'order_confirmation_date', v_was.order_confirmation_date,
          'due_date',                v_was.due_date,
          'workbook_sha256',         v_was.source_workbook_sha256),
        'after', jsonb_build_object(
          'grand_total',             v_now.grand_total,
          'total_before_gst',        v_now.total_before_gst,
          'gst_amount',              v_now.gst_amount,
          'discount_amount',         v_now.discount_amount,
          'discount_label',          v_now.discount_label,
          'order_confirmation_date', v_now.order_confirmation_date,
          'due_date',                v_now.due_date,
          'workbook_sha256',         v_now.source_workbook_sha256),
        'workbook_dates', jsonb_build_object(
          'order_confirmation_date', v_now.workbook_order_confirmation_date,
          'due_date',                v_now.workbook_due_date),
        'internal_details_confirmation_cleared',
          v_was.internal_details_confirmed_at is not null and v_now.internal_details_confirmed_at is null
      )
    );
  end if;

  -- ═══ WHAT A REPLACEMENT MEANS ONCE THE PI HAS LEFT DRAFT ═══════════════
  --
  -- Everything below is skipped entirely for the ordinary case — an owner
  -- re-uploading their own draft — because none of it applies there. It runs
  -- only when the PI has been submitted or already has an Order.
  v_after  := coalesce((v_amend ->> 'after_submission')::boolean, false);
  v_reason := v_amend ->> 'reason';

  if v_after and not v_unchanged then
    select order_id into v_order from public.order_submissions where id = p_submission_id;

    -- ── Finance verification cannot survive a new commercial basis ──
    --
    -- The clearing trigger from 20260915000000 fires on a STATUS CHANGE, and a
    -- workbook replacement is not one: a submitted PI stays submitted. So a
    -- sign-off made against the previous figures would otherwise stand against
    -- the new ones. Cleared here, for the same reason the trigger clears it
    -- anywhere else — whatever finance signed off is no longer the thing under
    -- review.
    --
    -- The reduced-payment exception needs no equivalent, and deliberately so:
    -- order_submission_exception_current() DERIVES currency by comparing the
    -- recorded basis against the live grand total, workbook hash and both
    -- terms. Replacing the workbook moves every one of them, so the decision
    -- stops being current on its own. Storing a second answer would be a second
    -- thing to keep in step.
    update public.order_submissions
       set finance_verified_by            = null,
           finance_verified_at            = null,
           finance_verified_submission_at = null
     where id = p_submission_id
       and finance_verified_at is not null;
    v_cleared := found;

    if v_order is not null then
      -- ── The Order carries the corrected figures ──
      --
      -- Its IDENTITY does not move: not the id, not the confirmed number, not
      -- the PI linkage, not one payment and not one allocation. Only the
      -- mirrored values follow their source.
      perform set_config('boe.amendment_context', 'order_amendment', true);

      update public.orders o
         set client_name         = coalesce(s.client_name, o.client_name),
             confirm_date        = coalesce(s.order_confirmation_date, o.confirm_date),
             due_date            = s.due_date,
             total_value         = s.grand_total,
             total_product_value = s.gross_product_amount,
             billing_percentage  = s.billing_percentage,
             updated_at          = now()
        from public.order_submissions s
       where o.id = v_order and s.id = p_submission_id;

      perform set_config('boe.amendment_context', '', true);


      -- Every figure on both documents came from the file that was just
      -- replaced, so the ready pair is stale in full.
      v_superseded := public.supersede_order_documents(v_order, 'pi_data_amended');

      insert into public.order_activity_log (order_id, actor_id, event_type, payload)
      values (v_order, p_actor_id, 'order_workbook_replaced',
              jsonb_build_object('submission_id', p_submission_id,
                                 'reason', v_reason,
                                 'after_approval', true,
                                 'superseded_documents', v_superseded));
    end if;

    perform public.log_order_submission_activity(
      p_submission_id, p_actor_id, 'workbook_replaced_by_admin',
      v_status, v_status, v_reason,
      jsonb_build_object('after_submission', true,
                         'finance_verification_cleared', v_cleared,
                         'order_id', v_order,
                         'superseded_documents', v_superseded,
                         'item_count', v_count)
    );
  end if;

  return jsonb_build_object(
    'id', p_submission_id,
    'status', v_status,
    'after_submission', coalesce(v_after, false),
    'finance_verification_cleared', v_cleared,
    'superseded_documents', v_superseded,
    'item_count', v_count,
    'representative_image_count', v_rep_count,
    'customization_image_count', v_cust_count,
    'blocking_issue_count', jsonb_array_length(v_blocking),
    'unchanged', v_unchanged
  );
end;
$$;

revoke execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.replace_order_submission_parse(uuid, uuid, jsonb)
  to service_role;

comment on function public.replace_order_submission_parse(uuid, uuid, jsonb) is
  'SERVICE ROLE ONLY. Writes the parsed commercial snapshot, every product line and every normalized product image of a PI submission. Not callable by anon or authenticated, because these values must come from parsing the uploaded workbook server-side and never from a browser. p_actor_id is re-validated against the database, not trusted. Since 20261003000000 an ACTIVE ADMIN may also run it after submission, with a reason in payload.change_reason: that clears any finance verification, carries the corrected figures onto the linked Order without touching its identity, and supersedes the current confirmed documents. Since 20261120000000 that one Order UPDATE runs inside the amendment context, which is what orders_guard_amendable_columns() requires of every writer of those columns. Since 20270122000000 a blank workbook date leaves the app date in place while the PI is a draft or returned, the workbook''s own dates and discount wording are recorded, and parse_replaced records before/after amounts, dates and workbook hash.';


-- ═══ 5c. A date-only edit on a confirmed Order no longer revises the PI ═════
--
-- MEASURED BEFORE THIS CHANGE, on an accepted, aligned Order with current
-- documents (supabase/tests/order_submission_internal_details_documents_assertions.sql):
--
--   * update_order_submission_schedule_terms on the approved PI was REFUSED
--     (ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION) — the two dates are PI
--     content keys, so the only way to move them was Edit PI;
--   * a date-only Edit PI proposal, once the Admin approved it, SUPERSEDED the
--     ready documents, RESET production alignment to not_aligned and recorded
--     a new Operations handoff AWAITING re-acceptance — for two fields no
--     client document prints;
--   * amend_order (dates only) changed the Order's dates only: documents,
--     handoff and alignment untouched.
--
-- NOW: the schedule editor amends the two dates on an approved PI directly —
-- the PI's dates, the Order's dates (through the amendment context, as
-- before), the Order's activity (order_schedule_terms_amended) and the PI's
-- (schedule_terms_amended_by_admin) — without a PI version, an Operations
-- re-review, an alignment reset or a superseded document. The Edit PI route
-- sends a date-only edit here instead of proposing a version. Anything a
-- client document prints still goes through a revision; dispatch_commitment,
-- which the confirmed Excel prints at E113, now supersedes the documents (it
-- was missing from the list).
--
-- The editor itself keeps its authority rules: after submission an ACTIVE
-- ADMIN only, with a reason. No notification was sent by either path before,
-- and none is added.

create or replace function public.order_submissions_approved_pi_is_versioned()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  k text;
begin
  -- Only a PI that has already become an Order.
  if old.order_id is null or old.status <> 'approved' then return new; end if;
  if public.order_pi_is_versioned_write_allowed(new.id) then return new; end if;
  -- While a revision awaits Operations, #205's freeze refuses the same edit in
  -- its own, more specific words; this guard steps aside so that is the one
  -- a person reads.
  if public.order_submission_has_revision_awaiting_operations(new.id) then return new; end if;
  foreach k in array public.order_pi_content_keys() loop
    -- 20270122000000: the two INTERNAL dates may move without a revision, and
    -- only inside update_order_submission_schedule_terms' date-only amendment
    -- of THIS row. Every other content key is guarded exactly as before.
    continue when k in ('order_confirmation_date', 'due_date')
      and coalesce(current_setting('boe.pi_internal_dates_amend', true), '') = new.id::text;
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION: this PI is approved and in force on an Order. Use Edit PI to propose a new version; the current one stays in force until the new one is approved.'
        using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;


create or replace function public.update_order_submission_schedule_terms(
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

  c_fields constant text[] := array[
    'order_confirmation_date', 'due_date',
    'dispatch_commitment', 'payment_terms', 'billing_terms'
  ];
  c_dates constant text[] := array['order_confirmation_date', 'due_date'];
  -- WHAT THE CONFIRMED DOCUMENTS ACTUALLY PRINT (20270122000000). The PDF
  -- prints no confirmation or due date any more, and the confirmed Excel never
  -- wrote either; it DOES write dispatch_commitment (E113), which this list
  -- used to leave out. So a dispatch edit supersedes the documents and a date
  -- edit does not.
  c_printed constant text[] := array['dispatch_commitment'];
  -- A DATE-ONLY amendment of an approved PI (20270122000000): the dates are
  -- Sales' internal answers and the Order's schedule, printed nowhere, so they
  -- change without a new PI version — no Operations re-acceptance, no
  -- production re-alignment, no superseded documents.
  v_dates_only boolean;
begin
  if v_actor is null then
    raise exception 'ORDER_SUBMISSION_NOT_AUTHENTICATED: you must be signed in'
      using errcode = '42501';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'ORDER_SUBMISSION_BAD_FIELDS: a JSON object of fields is required'
      using errcode = 'P0001';
  end if;

  select * into v_sub from public.order_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'ORDER_SUBMISSION_NOT_FOUND: submission % not found', p_submission_id
      using errcode = 'P0002';
  end if;

  v_is_admin := public.can_admin_edit_order_submission(p_submission_id);
  v_is_owner := public.can_edit_order_submission(p_submission_id);
  if not (v_is_admin or v_is_owner) then
    raise exception
      'ORDER_SUBMISSION_NOT_EDITABLE: this PI cannot be changed by you in its current state'
      using errcode = '42501';
  end if;

  if p_expected_version is not null
     and v_sub.row_version is distinct from p_expected_version then
    raise exception
      'ORDER_SUBMISSION_STALE: this PI changed while you were editing it. Reopen it and apply your change again.'
      using errcode = 'P0001';
  end if;

  v_after_sub := v_sub.status not in ('draft', 'needs_changes') or v_sub.order_id is not null;
  if v_after_sub and not v_is_owner then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is null then
      raise exception 'ORDER_SUBMISSION_REASON_REQUIRED: editing a submitted PI needs a reason'
        using errcode = 'P0001';
    end if;
    if length(v_reason) > 500 then
      raise exception 'ORDER_SUBMISSION_REASON_TOO_LONG: the reason may be at most 500 characters'
        using errcode = 'P0001';
    end if;
  else
    v_reason := null;
  end if;

  -- ── Every key must be one this function owns ──
  for v_key in select jsonb_object_keys(p_fields) loop
    if not (v_key = any (c_fields)) then
      -- Named explicitly, because a caller aiming a billing percentage here has
      -- made an understandable mistake and deserves to be pointed at the right
      -- door rather than told "unknown field".
      if v_key = 'billing_percentage' then
        raise exception
          'ORDER_SUBMISSION_WRONG_EDITOR: billing_percentage is set through set_order_submission_billing_percentage'
          using errcode = 'P0001';
      end if;
      raise exception
        'ORDER_SUBMISSION_UNKNOWN_FIELD: % is not an editable schedule or terms field', v_key
        using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
      raise exception 'ORDER_SUBMISSION_BAD_FIELD_TYPE: % must be text or null', v_key
        using errcode = 'P0001';
    end if;
  end loop;

  -- ── Compute the change set ──
  for v_key in select unnest(c_fields) loop
    continue when not (p_fields ? v_key);

    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');

    if v_key = any (c_dates) and v_new is not null then
      -- A DATE IS PARSED, NOT TRUSTED — and the SHAPE is checked before the
      -- cast, which is not belt and braces.
      --
      -- PostgreSQL's date input accepts a great deal more than a calendar
      -- date: 'yesterday', 'today', 'tomorrow', 'now', 'epoch', 'infinity' and
      -- '-infinity' all cast without error. A cast-only check therefore passed
      -- 'yesterday' straight through and silently stored a RELATIVE date — the
      -- assertions in this migration's test file caught exactly that. A PI's
      -- confirm date is a fact about an agreement, not an expression evaluated
      -- whenever it happens to be written.
      --
      -- So the ISO shape is required first, which is what the error message
      -- below has always claimed. Without this the message was a lie.
      if v_new !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception
          'ORDER_SUBMISSION_BAD_DATE: % must be a calendar date in YYYY-MM-DD form', v_key
          using errcode = 'P0001';
      end if;
      begin
        perform v_new::date;
      exception when others then
        -- Correct shape, impossible day — 2026-02-30, 2026-13-01.
        raise exception
          'ORDER_SUBMISSION_BAD_DATE: % must be a calendar date in YYYY-MM-DD form', v_key
          using errcode = 'P0001';
      end;
      -- Re-spelled through the type so a stored value and a submitted one are
      -- compared in one spelling and an identical date cannot read as a change.
      v_new := (v_new::date)::text;
    end if;

    if v_key <> all (c_dates) and v_new is not null and length(v_new) > 500 then
      -- Matches order_submissions_payment_terms_valid and its billing twin, so
      -- the caller is told what is wrong instead of meeting a constraint name.
      raise exception 'ORDER_SUBMISSION_FIELD_TOO_LONG: % may be at most 500 characters', v_key
        using errcode = 'P0001';
    end if;

    execute format('select ($1).%I::text', v_key) into v_old using v_sub;

    if v_new is distinct from v_old then
      v_changed := v_changed + 1;
      v_changes := v_changes || jsonb_build_object(
        v_key, jsonb_build_object('from', v_old, 'to', v_new));
    end if;
  end loop;

  if v_changed = 0 then
    return jsonb_build_object(
      'submission_id', p_submission_id,
      'changed',       false,
      'fields',        0,
      'row_version',   v_sub.row_version,
      'superseded_documents', 0
    );
  end if;

  -- The same date-order rule the internal-details editor applies.
  if coalesce((v_changes -> 'due_date' ->> 'to')::date, v_sub.due_date)
     < coalesce((v_changes -> 'order_confirmation_date' ->> 'to')::date, v_sub.order_confirmation_date) then
    raise exception
      'ORDER_SUBMISSION_DUE_BEFORE_CONFIRMATION: the due date cannot be before the order confirmation date'
      using errcode = 'P0001';
  end if;

  -- Only the two dates changed, on a PI in force on an Order: the approved-PI
  -- versioning guard lets exactly those two columns through for this row
  -- (order_submissions_approved_pi_is_versioned, below). Anything else still
  -- needs a revision, and the guard still says so.
  v_dates_only := v_sub.order_id is not null
    and not exists (select 1 from jsonb_object_keys(v_changes) k where k <> all (c_dates));
  if v_dates_only then
    perform set_config('boe.pi_internal_dates_amend', p_submission_id::text, true);
  end if;

  update public.order_submissions set
    order_confirmation_date = case when p_fields ? 'order_confirmation_date'
      then nullif(btrim(coalesce(p_fields ->> 'order_confirmation_date', '')), '')::date
      else order_confirmation_date end,
    due_date = case when p_fields ? 'due_date'
      then nullif(btrim(coalesce(p_fields ->> 'due_date', '')), '')::date
      else due_date end,
    dispatch_commitment = case when p_fields ? 'dispatch_commitment'
      then nullif(btrim(coalesce(p_fields ->> 'dispatch_commitment', '')), '')
      else dispatch_commitment end,
    payment_terms = case when p_fields ? 'payment_terms'
      then nullif(btrim(coalesce(p_fields ->> 'payment_terms', '')), '')
      else payment_terms end,
    billing_terms = case when p_fields ? 'billing_terms'
      then nullif(btrim(coalesce(p_fields ->> 'billing_terms', '')), '')
      else billing_terms end,
    row_version = row_version + 1,
    updated_at  = now()
  where id = p_submission_id
  returning row_version into v_version;

  perform set_config('boe.pi_internal_dates_amend', '', true);

  -- ── The linked Order carries the same two dates ──
  --
  -- orders.confirm_date and orders.due_date are written at approval from these
  -- columns. Leaving them behind would make the Order state a schedule its own
  -- PI no longer says. NOTHING ELSE on the Order is touched.
  if v_sub.order_id is not null
     and (v_changes ? 'order_confirmation_date' or v_changes ? 'due_date') then
    -- 20261217000000: the dates are guarded Order columns; write them through
    -- the amendment door, exactly one statement wide.
    perform set_config('boe.amendment_context', 'order_amendment', true);

    update public.orders
       set confirm_date = case when v_changes ? 'order_confirmation_date'
             then (v_changes -> 'order_confirmation_date' ->> 'to')::date
             else confirm_date end,
           due_date = case when v_changes ? 'due_date'
             then (v_changes -> 'due_date' ->> 'to')::date
             else due_date end,
           updated_at = now()
     where id = v_sub.order_id;

    perform set_config('boe.amendment_context', '', true);
  end if;

  if v_sub.order_id is not null
     and exists (select 1 from unnest(c_printed) k where v_changes ? k) then
    v_superseded := public.supersede_order_documents(v_sub.order_id, 'pi_data_amended');
  end if;

  if v_sub.order_id is not null then
    insert into public.order_activity_log (order_id, actor_id, event_type, payload)
    values (
      v_sub.order_id, v_actor, 'order_schedule_terms_amended',
      jsonb_build_object(
        'fields', v_changed, 'changed', v_changes,
        'by_admin', v_is_admin and not v_is_owner, 'reason', v_reason)
    );
  end if;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor,
    case when v_after_sub and not v_is_owner
         then 'schedule_terms_amended_by_admin'
         else 'schedule_terms_updated' end,
    v_sub.status, v_sub.status, v_reason,
    jsonb_build_object(
      'fields', v_changed, 'changed', v_changes,
      'stage', v_sub.status, 'after_submission', v_after_sub,
      'superseded_documents', v_superseded)
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

revoke execute on function public.order_submissions_approved_pi_is_versioned() from public, anon, authenticated, service_role;

revoke all    on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) from public, anon;
grant  execute on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) to authenticated;

comment on function public.update_order_submission_schedule_terms(uuid, jsonb, integer, text) is
  'Edits a PI''s confirm date, due date, dispatch commitment, payment terms and billing terms — those five and nothing else. Owner in draft/needs_changes; active admin at any stage with a reason after submission. row_version concurrency. The two DATES mirror onto the linked Order and, since 20270122000000, may be amended on an approved PI WITHOUT a revision and supersede no document (no client document prints them); dispatch_commitment, printed in the confirmed Excel, supersedes the Order''s ready documents. Refuses a due date before the confirmation date.';



-- ═══ 7. Proof ═════════════════════════════════════════════════════════════════

do $$
declare
  v_def text;
begin
  -- The activity check still names real actions, including the new one.
  v_def := (select pg_get_constraintdef(oid) from pg_constraint
             where conname = 'order_submission_activity_action_check'
               and conrelid = 'public.order_submission_activity'::regclass);
  if v_def not like '%''internal_details_updated''%' or v_def not like '%''parse_replaced''%'
     or v_def like '%NULL%' then
    raise exception 'ASSERTION FAILED: the activity action check is wrong after this migration: %', v_def;
  end if;

  -- 5c: a date edit supersedes nothing; the printed dispatch text does; the
  -- guard exempts only the two dates, only under the editor's own flag.
  v_def := pg_get_functiondef('public.update_order_submission_schedule_terms(uuid, jsonb, integer, text)'::regprocedure);
  if v_def !~ 'c_printed constant text\[\] := array\[''dispatch_commitment''\]'
     or v_def not like '%boe.pi_internal_dates_amend%'
     or v_def not like '%ORDER_SUBMISSION_DUE_BEFORE_CONFIRMATION%' then
    raise exception 'ASSERTION FAILED: the schedule editor lost its 20270122000000 rules';
  end if;
  v_def := pg_get_functiondef('public.order_submissions_approved_pi_is_versioned()'::regprocedure);
  if v_def not like '%boe.pi_internal_dates_amend%'
     or v_def not like '%order_pi_content_keys()%'
     or v_def not like '%ORDER_PI_APPROVED_EDIT_REQUIRES_REVISION%' then
    raise exception 'ASSERTION FAILED: the approved-PI guard lost its keys, its refusal or its date exemption';
  end if;

  -- The editor is callable by signed-in users and nobody else.
  if not has_function_privilege('authenticated',
       'public.save_order_submission_internal_details(uuid, jsonb, integer, boolean)', 'execute') then
    raise exception 'ASSERTION FAILED: the internal-details editor is not callable by authenticated';
  end if;
  if has_function_privilege('anon',
       'public.save_order_submission_internal_details(uuid, jsonb, integer, boolean)', 'execute') then
    raise exception 'ASSERTION FAILED: the internal-details editor is callable by anon';
  end if;

  -- The readiness check exists and is not a client door.
  if has_function_privilege('authenticated', 'public.order_submission_internal_details_problem(uuid)', 'execute') then
    raise exception 'ASSERTION FAILED: order_submission_internal_details_problem is callable by authenticated';
  end if;

  -- PHASE 1 WIRES NOTHING IN FRONT OF SUBMISSION.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname like 'submit\_%' or p.proname like 'order\_submissions\_%')
      and p.proname <> 'order_submissions_internal_details_guard'
      and pg_get_functiondef(p.oid) like '%order_submission_internal_details_problem%'
  ) then
    raise exception 'ASSERTION FAILED: Phase 1 must not put the internal-details check in front of any submission door';
  end if;

  -- The replacement keeps the lease, the editor check and the service-role-only door.
  v_def := pg_get_functiondef('public.replace_order_submission_parse(uuid, uuid, jsonb)'::regprocedure);
  if v_def not like '%ORDER_SUBMISSION_PROCESSING_NOT_HELD%'
     or v_def not like '%assert_order_submission_workbook_editor%'
     or v_def not like '%workbook_due_date%'
     or v_def not like '%''before''%' then
    raise exception 'ASSERTION FAILED: replace_order_submission_parse lost its lease/editor check or its 20270122000000 additions';
  end if;
  if has_function_privilege('authenticated', 'public.replace_order_submission_parse(uuid, uuid, jsonb)', 'execute') then
    raise exception 'ASSERTION FAILED: replace_order_submission_parse is callable by authenticated';
  end if;
end $$;

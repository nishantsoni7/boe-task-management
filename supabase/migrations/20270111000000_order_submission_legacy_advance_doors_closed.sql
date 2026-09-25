-- Legacy advance submission doors: closed to clients, and no longer failing closed
-- =============================================================================
--
-- THE DEFECT (predates the #202 -> #205 -> #206 -> #209 stack; found by the #209
-- review and tracked there as D2).
--
-- The Order PI screen submits through ONE door, submit_pi_for_review(...)
-- (20260921000000). Two older doors are still granted to `authenticated`:
--
--   submit_order_submission_with_advance(uuid, text, text, numeric, text)
--   submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)
--
-- The browser has not called either since 20260921000000 (src/ has no rpc() to
-- them). Both reach submit_order_submission_advance_v2_internal(...), last
-- defined in 20260917000000. When a resubmission replaces an APPROVED exception,
-- with a fresh pending one or with the standard route, that function moves
-- advance_exception_status off 'approved' but leaves the four decision-basis
-- columns 20260921000000 added. 20260921000000's CHECK
-- order_submissions_exception_basis_scope allows those columns only on an
-- approved exception, so the UPDATE is refused and the call fails with a CHECK
-- violation. It fails CLOSED: no row is written, and nothing is approved that
-- should not be.
--
-- THE FIX, BOTH HALVES:
--
--   §1  submit_order_submission_advance_v2_internal clears the decision basis
--       in the two branches that leave 'approved', the same four assignments
--       submit_pi_for_review_internal (20260921000000) already makes. Nothing
--       else in the body changes: it is 20260917000000's text, with only those
--       eight lines added. The branch that KEEPS an unchanged approved
--       exception still keeps its basis.
--
--   §2  EXECUTE on both legacy advance doors is revoked from `authenticated`
--       (public and anon never had it), so the application has one submit door.
--       Nothing in src/ calls them. submit_order_submission(uuid) and
--       submit_order_submission_with_note(uuid, text) never touch the advance
--       and are out of scope; they are unchanged.
--
-- WHAT THIS DOES NOT TOUCH: submit_pi_for_review / submit_pi_for_review_internal,
-- the constraint, any table, any row, any trigger, and every #209 / #211
-- migration (20261231000000 .. 20270105000000). It depends only on migrations
-- already applied to production, so it may be applied before or after them.
--
-- NUMBERED AFTER 20270110000000 (announcements), the newest migration already
-- applied to production when this was written: a lower number would sit behind
-- an applied one, and `supabase db push` refuses that without --include-all.
--
-- REVERSAL: re-run 20260917000000's §5 definition of
-- submit_order_submission_advance_v2_internal (restoring the defect), and
-- `grant execute on function public.submit_order_submission_with_advance(uuid, text, text, numeric, text) to authenticated;`
-- plus the same for submit_order_submission_with_advance_amount.

-- ═════════════════════════════════════════════════════════════════════════════
-- §1. The implementation clears the decision basis when it leaves 'approved'
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 20260917000000's body, restated with its signature, definer, search_path,
-- privileges and comment unchanged. The only edits are the two blocks marked
-- "the decision basis goes with the decision" below.

create or replace function public.submit_order_submission_advance_v2_internal(
  p_submission_id     uuid,
  p_note              text,
  p_declare_mode      text,
  p_advance_condition text,
  p_advance_value     numeric,
  p_advance_reason    text
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
  v_mode       text := nullif(btrim(lower(coalesce(p_declare_mode, ''))), '');
  -- Trimmed and folded, so "  Standard  " and "standard" are the same choice and
  -- a reason of pure whitespace is indistinguishable from no reason at all.
  v_condition  text := nullif(btrim(lower(coalesce(p_advance_condition, ''))), '');
  v_reason     text := nullif(btrim(coalesce(p_advance_reason, '')), '');
  v_percent    numeric;
  v_amount     numeric;
  v_threshold  numeric;
  v_standard   numeric := public.order_submission_standard_advance_percent();
  v_declare    boolean;
  v_effective  numeric;
  v_metaamount numeric;
  v_keep       boolean := false;
  v_requested  boolean := false;
  v_advance    jsonb   := '{}'::jsonb;
begin
  if v_mode is null or v_mode not in ('none', 'amount', 'percent') then
    raise exception
      'ORDER_SUBMISSION_ADVANCE_MODE_INVALID: an advance is declared by amount or by percentage, or not at all'
      using errcode = 'P0001';
  end if;
  v_declare := v_mode <> 'none';

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

  -- ── The declaration's SHAPE, before the row is locked ──
  --
  -- Every one of these is the caller's own mistake and needs nothing from the
  -- record, so refusing early costs the database nothing and holds no lock. The
  -- rules that need the grand total wait until section "FIT", below.
  if v_declare then
    if v_condition is null or v_condition not in ('standard', 'exception') then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: choose the standard advance requirement or request an exception'
        using errcode = 'P0001';
    end if;

    -- A REASON BELONGS TO AN EXCEPTION AND TO NOTHING ELSE, on both paths. A
    -- reason arriving with a standard declaration means the caller has sent two
    -- different answers, and guessing which one they meant is not this
    -- function's job. (The percentage path refuses a percentage here as well,
    -- below; the amount path takes an amount on both routes, so the amount is
    -- not a contradiction there.)
    if v_condition = 'standard' and v_mode = 'amount' and v_reason is not null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: the standard advance requirement carries no reason'
        using errcode = 'P0001';
    end if;

    if v_condition = 'exception' then
      if v_reason is null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_REASON_REQUIRED: say why a lower advance is being proposed'
          using errcode = 'P0001';
      end if;
      if char_length(v_reason) > 1000 then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_REASON_TOO_LONG: a reason may be at most 1000 characters (this one is %)',
          char_length(v_reason)
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  if v_mode = 'amount' then
    if p_advance_value is null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: enter the advance amount being declared'
        using errcode = 'P0001';
    end if;
    -- NaN first, and by name: it compares ABOVE every real number, so leaving it
    -- to the range test would refuse it with a message about being too high.
    if p_advance_value = 'NaN'::numeric then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: the advance amount is not a number'
        using errcode = 'P0001';
    end if;
    if p_advance_value < 0 then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: the advance amount cannot be negative'
        using errcode = 'P0001';
    end if;
    if p_advance_value <> round(p_advance_value, 2) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_INVALID: the advance amount may have at most two decimal places'
        using errcode = 'P0001';
    end if;
    v_amount := p_advance_value;

  elsif v_mode = 'percent' then
    v_percent := p_advance_value;

    if v_condition = 'standard' then
      -- The standard requirement, declared the OLD way, is exactly the configured
      -- rule. A percentage or a reason arriving with it means the caller has sent
      -- two different answers, and guessing which one they meant is not this
      -- function's job.
      if p_advance_value is not null or v_reason is not null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_CONDITION_INVALID: the standard advance requirement carries no percentage and no reason'
          using errcode = 'P0001';
      end if;
    else
      if v_percent is null then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: enter the advance percentage being proposed'
          using errcode = 'P0001';
      end if;
      if v_percent = 'NaN'::numeric then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: the advance percentage is not a number'
          using errcode = 'P0001';
      end if;
      if v_percent < 0 or v_percent >= v_standard then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: an exception must be at least 0%% and below the standard %%%',
          v_standard
          using errcode = 'P0001';
      end if;
      if v_percent <> round(v_percent, 2) then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_PERCENT_INVALID: the advance percentage may have at most two decimal places'
          using errcode = 'P0001';
      end if;
    end if;
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

  -- ── The declaration's FIT with this record ──
  if v_declare then
    -- FAIL CLOSED ON AN UNKNOWN AMOUNT. Nobody may declare an advance against a
    -- total the record does not have; the same rule is a table constraint, so
    -- this is the readable half of a refusal that happens either way.
    if v_sub.grand_total is null then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no stored grand total, so an advance requirement cannot be declared against it'
        using errcode = 'P0001';
    end if;

    -- ONLY THE OWNER MAY PROPOSE AN EXCEPTION. can_edit_order_submission admits
    -- an active admin as well, which is right for correcting a record and wrong
    -- for asking the business a commercial question in somebody else's name.
    if v_condition = 'exception'
       and not (v_sub.created_by = v_actor or v_sub.submitted_by = v_actor) then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_NOT_OWNER: only the owner of this PI may request an advance exception'
        using errcode = '42501';
    end if;
  end if;

  if v_mode = 'amount' then
    -- THE CLASSIFICATION, AGAINST THE AMOUNT AND NEVER AGAINST A ROUNDED
    -- PERCENTAGE. v_threshold is the smallest whole-paise figure that satisfies
    -- the standard requirement, so for an amount already proved to be whole
    -- paise, "at or above v_threshold" and "at least grand_total * 40 / 100" are
    -- the same statement — which is what the table constraint enforces.
    v_threshold := public.order_submission_standard_advance_amount(v_sub.grand_total);

    if v_amount > v_sub.grand_total then
      raise exception
        'ORDER_SUBMISSION_ADVANCE_AMOUNT_ABOVE_TOTAL: the advance cannot exceed the grand total of %',
        v_sub.grand_total
        using errcode = 'P0001';
    end if;

    if v_condition = 'standard' then
      if v_amount < v_threshold then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_AMOUNT_BELOW_STANDARD: the standard advance requires at least % — request a reduced advance to declare less',
          v_threshold
          using errcode = 'P0001';
      end if;
      -- The percentage the declared amount comes to. NULL only for a zero total,
      -- where the standard requirement is itself zero and no percentage exists.
      v_percent := public.order_submission_advance_percent_of(v_sub.grand_total, v_amount);
    else
      -- An exception is a percentage OF something, and a zero or absent total
      -- gives nothing to take a percentage of. Refused by name rather than as a
      -- range failure against two zeroes.
      if v_sub.grand_total <= 0 then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING: this PI has no positive grand total, so an advance exception cannot be declared against it'
          using errcode = 'P0001';
      end if;
      if v_amount >= v_threshold then
        raise exception
          'ORDER_SUBMISSION_ADVANCE_AMOUNT_NOT_REDUCED: a reduced advance must be below the standard requirement of %',
          v_threshold
          using errcode = 'P0001';
      end if;
      -- Truncated, so a figure below the requirement can never be stored as 40.
      -- Zero rupees is zero percent exactly, with no division involved.
      v_percent := case
        when v_amount = 0 then 0
        else public.order_submission_advance_percent_of(v_sub.grand_total, v_amount)
      end;
    end if;
  end if;

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

  -- ── The workbook: shape, then existence, then type ──
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

  -- ── Exactly one representative image per product line ──
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

  -- ── Every recorded image: the key must name THIS submission, THIS item, its
  --    own role and its own position ──
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

  -- ── Every recorded image: a real object, of a real image type ──
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

  -- ── The write ──
  --
  -- ONE STATEMENT ON EVERY PATH, so the status and the advance declaration land
  -- together or not at all. review_note is cleared exactly as the applied
  -- migrations established: management's outstanding request has been answered.

  if v_mode = 'none' then
    -- Nothing was declared, so nothing about the advance moves. Whatever the
    -- record already carried it still carries.
    update public.order_submissions
       set status = 'submitted',
           review_note = null
     where id = p_submission_id;

  elsif v_condition = 'standard' then
    -- MOVING TO THE STRICTER CHOICE NEEDS NO APPROVAL, and it clears the whole
    -- actionable exception state from the row. The permanent record of what was
    -- once asked for, and what was decided, stays in the append-only trail —
    -- nothing there is deleted or rewritten.
    --
    -- v_amount is NULL on the 'percent' path, which is the declaration the
    -- applied door has always made: the standard requirement, with no typed
    -- figure. Writing it explicitly also clears any amount left by a previous
    -- declaration, so the row cannot carry a figure its condition disagrees with.
    v_effective  := coalesce(v_percent, v_standard);
    v_metaamount := coalesce(
      v_amount, public.order_submission_advance_amount(v_sub.grand_total, v_standard));

    update public.order_submissions
       set status = 'submitted',
           review_note = null,
           advance_condition = 'standard',
           advance_declared_amount = v_amount,
           advance_exception_percent = null,
           advance_exception_reason = null,
           advance_exception_status = null,
           advance_exception_requested_by = null,
           advance_exception_requested_at = null,
           advance_exception_decided_by = null,
           advance_exception_decided_at = null,
           advance_exception_rejection_reason = null,
           -- the decision basis goes with the decision (20270111000000): it may only
           -- stand on an approved exception (order_submissions_exception_basis_scope)
           advance_exception_decided_grand_total     = null,
           advance_exception_decided_workbook_sha256 = null,
           advance_exception_decided_payment_terms   = null,
           advance_exception_decided_billing_terms   = null
     where id = p_submission_id;

  else
    v_effective  := v_percent;
    v_metaamount := coalesce(
      v_amount, public.order_submission_advance_amount(v_sub.grand_total, v_percent));

    -- AN APPROVED EXCEPTION SURVIVES A RESUBMISSION THAT DOES NOT CHANGE IT.
    --
    -- A PI returned for an unrelated correction comes back with the same proposal
    -- the business already accepted, and asking management to accept it a second
    -- time would be make-work. Anything else — a different figure, different
    -- words, a move from standard, a previously rejected or pending request —
    -- becomes a FRESH pending decision with fresh requester and time and cleared
    -- decision fields.
    --
    -- ON THE AMOUNT PATH THE COMPARISON IS THE AMOUNT, because the amount is what
    -- was declared. order_submission_effective_advance_amount reads the stored
    -- record the one way this file defines, so an approved exception written
    -- before this column existed is recognised as unchanged when the same rupee
    -- figure is declared over it.
    --
    -- Numeric equality is by VALUE, so 5 and 5.00 are the same proposal.
    if v_mode = 'amount' then
      -- BOTH FIGURES MUST MATCH, not just the rupees. A stored percentage that
      -- does not derive from the amount now being declared is a DIFFERENT
      -- proposal however similar the two look, and keeping the old decision over
      -- it would leave the row saying two things at once.
      v_keep := coalesce(
        v_sub.advance_condition = 'exception'
        and v_sub.advance_exception_status = 'approved'
        and public.order_submission_effective_advance_amount(
              v_sub.advance_condition, v_sub.advance_declared_amount,
              v_sub.advance_exception_percent, v_sub.grand_total) = v_amount
        and v_sub.advance_exception_percent = v_percent
        and v_sub.advance_exception_reason is not distinct from v_reason,
        false
      );
    else
      v_keep := coalesce(
        v_sub.advance_condition = 'exception'
        and v_sub.advance_exception_status = 'approved'
        and v_sub.advance_exception_percent = v_percent
        and v_sub.advance_exception_reason is not distinct from v_reason,
        false
      );
    end if;

    if v_keep then
      -- The decision stands and the proposal is unchanged, so the only thing
      -- written is the amount the record was always worth — never on the
      -- 'percent' path, which declares no amount and must not invent one.
      update public.order_submissions
         set status = 'submitted',
             review_note = null,
             advance_declared_amount = case when v_mode = 'amount'
                                            then v_amount
                                            else advance_declared_amount end
       where id = p_submission_id;
    else
      update public.order_submissions
         set status = 'submitted',
             review_note = null,
             advance_condition = 'exception',
             advance_declared_amount = v_amount,
             advance_exception_percent = v_percent,
             advance_exception_reason = v_reason,
             advance_exception_status = 'pending',
             advance_exception_requested_by = v_actor,
             advance_exception_requested_at = now(),
             advance_exception_decided_by = null,
             advance_exception_decided_at = null,
             advance_exception_rejection_reason = null,
             -- the decision basis goes with the decision (20270111000000): it may only
             -- stand on an approved exception (order_submissions_exception_basis_scope)
             advance_exception_decided_grand_total     = null,
             advance_exception_decided_workbook_sha256 = null,
             advance_exception_decided_payment_terms   = null,
             advance_exception_decided_billing_terms   = null
       where id = p_submission_id;
      v_requested := true;
    end if;
  end if;

  -- submitted_at is stamped by the status transition trigger (20260910000000)
  -- and by nothing here.

  if v_declare then
    -- THE SAME KEYS 20260913000000 WROTE, so the activity trail renders every
    -- event ever logged with one reader. advance_amount is now the DECLARED
    -- figure when there is one, and the derived figure when there is not.
    v_advance := jsonb_build_object(
      'advance_condition', v_condition,
      'advance_percent',   v_effective,
      'standard_percent',  v_standard,
      'grand_total',       v_sub.grand_total,
      'advance_amount',    v_metaamount,
      'advance_declared',  v_mode = 'amount'
    );
  end if;

  perform public.log_order_submission_activity(
    p_submission_id, v_actor, 'submitted', v_sub.status, 'submitted', v_note,
    jsonb_build_object('item_count', v_item_count, 'resubmitted', v_sub.status = 'needs_changes')
      || v_advance
  );

  -- The exception request is its OWN event, separate from the submission, so a
  -- reader can see the proposal without reading the submission's bookkeeping.
  if v_requested then
    perform public.log_order_submission_activity(
      p_submission_id, v_actor, 'advance_exception_requested', v_sub.status, 'submitted', v_reason,
      v_advance || jsonb_build_object('exception_status', 'pending')
    );
  end if;

  -- The established return shape, unchanged, so all four doors answer exactly
  -- what the first one always answered.
  return jsonb_build_object('id', p_submission_id, 'status', 'submitted', 'item_count', v_item_count);
end;
$$;

revoke execute on function public.submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text)
  from public, anon, authenticated, service_role;

comment on function public.submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text) is
  'The single implementation of submitting a PI for review, with an optional employee reply and an optional advance declaration made either as an amount or, for the applied door, as a percentage. Executable by no role: reached only by the wrappers, as their definer.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §2. The two legacy advance doors are closed to clients
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A REVOKE, NOT A DROP. The functions stay, so a reversal is one GRANT and no
-- body has to be restored. The SQL suites that drive the implementation keep
-- calling them as the owner.

revoke execute on function public.submit_order_submission_with_advance(uuid, text, text, numeric, text)
  from public, anon, authenticated;
revoke execute on function public.submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)
  from public, anon, authenticated;

comment on function public.submit_order_submission_with_advance(uuid, text, text, numeric, text) is
  'LEGACY, not callable by clients since 20270111000000: the application submits a PI through submit_pi_for_review(). Submits a PI for review under a declared advance requirement: ''standard'' for the configured 40% rule, or ''exception'' with a percentage of at least 0 and below 40 and a mandatory reason.';

comment on function public.submit_order_submission_with_advance_amount(uuid, text, text, numeric, text) is
  'LEGACY, not callable by clients since 20270111000000: the application submits a PI through submit_pi_for_review(). Submits a PI for review under a declared advance AMOUNT in rupees: ''standard'' for an amount of at least 40% of the grand total, or ''exception'' with an amount below 40% and a mandatory reason.';

-- ═════════════════════════════════════════════════════════════════════════════
-- §3. Assertions: the transaction fails unless every promise above holds
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_fn   regprocedure := 'public.submit_order_submission_advance_v2_internal(uuid, text, text, text, numeric, text)'::regprocedure;
  v_src  text;
  v_role text;
  v_door text;
begin
  -- §1: still a definer with exactly this search_path.
  if not (select prosecdef from pg_proc where oid = v_fn) then
    raise exception 'ASSERTION FAILED: % is no longer SECURITY DEFINER', v_fn;
  end if;
  if (select proconfig from pg_proc where oid = v_fn) is distinct from array['search_path=public, pg_temp'] then
    raise exception 'ASSERTION FAILED: % search_path is %', v_fn, (select proconfig from pg_proc where oid = v_fn);
  end if;

  -- §1: executable by no role, as before.
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_role, v_fn, 'EXECUTE') then
      raise exception 'ASSERTION FAILED: % is executable by %', v_fn, v_role;
    end if;
  end loop;

  -- §1: both branches that leave 'approved' clear the whole decision basis.
  v_src := (select prosrc from pg_proc where oid = v_fn);
  if (select count(*) from regexp_matches(v_src,
        'advance_exception_decided_grand_total\s*=\s*null,\s*'
        'advance_exception_decided_workbook_sha256\s*=\s*null,\s*'
        'advance_exception_decided_payment_terms\s*=\s*null,\s*'
        'advance_exception_decided_billing_terms\s*=\s*null', 'g')) <> 2 then
    raise exception 'ASSERTION FAILED: % does not clear the decision basis in exactly two branches', v_fn;
  end if;

  -- The constraint it now satisfies is still there and still enforced.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_submissions'::regclass
      and conname = 'order_submissions_exception_basis_scope' and convalidated
  ) then
    raise exception 'ASSERTION FAILED: order_submissions_exception_basis_scope is missing or not validated';
  end if;

  -- §2: no client role can call either legacy advance door.
  foreach v_door in array array[
    'public.submit_order_submission_with_advance(uuid, text, text, numeric, text)',
    'public.submit_order_submission_with_advance_amount(uuid, text, text, numeric, text)'
  ] loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_door, 'EXECUTE') then
        raise exception 'ASSERTION FAILED: % is still executable by %', v_door, v_role;
      end if;
    end loop;
  end loop;

  -- ...and nothing else was narrowed: the application's door and the two
  -- non-advance legacy doors are still exactly as reachable as they were.
  foreach v_door in array array[
    'public.submit_pi_for_review(uuid, text, text, text, text)',
    'public.submit_order_submission(uuid)',
    'public.submit_order_submission_with_note(uuid, text)'
  ] loop
    if not has_function_privilege('authenticated', v_door, 'EXECUTE') then
      raise exception 'ASSERTION FAILED: % is no longer callable by authenticated', v_door;
    end if;
    if has_function_privilege('anon', v_door, 'EXECUTE') then
      raise exception 'ASSERTION FAILED: % is callable by anon', v_door;
    end if;
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- The reserved Order number is required before the ORDER, not before REVIEW
-- ════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS OBSERVED. A PI Draft with 47.95% of its grand total already VERIFIED
-- — every payment gate satisfied, nothing awaiting Finance — could not be sent
-- for management review at all:
--
--   Order number 0524 is reserved for this PI but no revised PI has been
--   uploaded since it was issued. Put 0524 into the PI and upload it with
--   Change PI.
--
-- WHY EVERY NEW DRAFT HITS IT. 20261009000000 §5b reserves a number
-- automatically the moment a workbook is first parsed onto a draft, stamping
-- reserved_number_workbook_sha256 with the sha of THAT SAME workbook. Its §8
-- submit gate then asks order_submission_revised_pi_refusal(), whose first test
-- is "has the workbook been re-parsed since the number was issued". Immediately
-- after the reservation the two hashes are equal by construction, so the answer
-- is always no. reservation_required defaults TRUE for every draft created
-- after that migration and is frozen, so this is not an edge case: it is every
-- PI.
--
-- The salesperson was therefore obliged to take a number, type it into the
-- workbook and re-upload through Change PI BEFORE the PI could even be shown to
-- management — placing an Order-numbering step in front of the review that
-- decides whether there will be an Order at all.
--
-- WHAT THIS CHANGES, AND ALL IT CHANGES. The submit gate stops asking the
-- revised-PI question. One `create or replace function`; nothing else.
--
-- WHAT IT DELIBERATELY DOES NOT CHANGE.
--
--   * order_submission_revised_pi_refusal() itself — untouched, all three
--     refusals intact, still exact equality after normalization.
--   * assign_order_display_number() (20261009000000 §7) — STILL asks that rule
--     before an Order may take a reserved number. The document that becomes a
--     Confirmed Order must still carry that Order's number. The requirement
--     moves from the review door to the Order door; it is not repealed.
--   * The reservation itself, its allocator, its lock, its immutability guard,
--     its audit row and the cycle rule — untouched. Numbers stay unique,
--     permanent and non-reusable.
--   * ORDER_SUBMISSION_RESERVATION_REQUIRED — KEPT at submit. It asks only that
--     a number EXISTS, which the automatic reservation already guarantees; it
--     costs the salesperson nothing and keeps the obligation visible.
--   * Every payment rule, PI review gate, version rule and RLS policy.
--
-- THIS FILE WRITES NO ROW. It executes one function replacement and then reads
-- back what it installed. A before/after census is not needed because no
-- statement here can move a business column — which §3 proves from the other
-- side, by showing the Order door still refuses what this door stopped asking.

begin;

-- ── 1. Refuse to apply over a database that is not the one this assumes ─────

do $$
declare
  v_missing text[] := array[]::text[];
  v_fn      text;
begin
  foreach v_fn in array array[
    'public.order_submissions_require_revised_pi_on_submit()',
    'public.order_submission_revised_pi_refusal(text, text, text, text)',
    'public.assign_order_display_number()'
  ] loop
    if to_regprocedure(v_fn) is null then
      v_missing := v_missing || v_fn;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception
      'DEPENDENCY MISSING: % — this migration edits the 20261009000000 submit gate and cannot run without it',
      array_to_string(v_missing, ', ');
  end if;

  -- The gate must currently ASK the rule, or this file is being applied to a
  -- database where something else has already changed it, and the account above
  -- of what changes here would not be true.
  if pg_get_functiondef(to_regprocedure('public.order_submissions_require_revised_pi_on_submit()'))
       not like '%order_submission_revised_pi_refusal%' then
    raise exception
      'PRECONDITION FAILED: the submit gate does not ask order_submission_revised_pi_refusal(), so there is nothing here to remove and something unexpected has edited it';
  end if;
end $$;

-- ── 2. The submit gate, without the revised-PI question ─────────────────────
--
-- 20261009000000 §8 as it stood, minus exactly one block: the call to
-- order_submission_revised_pi_refusal() and the raise that acted on it. The
-- `if new.reserved_order_number is null then return new; end if;` guard went
-- with it — it existed only to skip that call — and the v_refusal declaration
-- with it.

create or replace function public.order_submissions_require_revised_pi_on_submit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status <> 'submitted' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'submitted' then return new; end if;

  -- A number must EXIST. §5b takes one automatically as soon as a workbook is
  -- parsed onto the draft, so a submitted PI without one means no PI file was
  -- ever stored — a different and real problem, and this says so.
  if new.reservation_required and new.reserved_order_number is null then
    raise exception
      'ORDER_SUBMISSION_RESERVATION_REQUIRED: this PI has no reserved Order number. Upload the PI file so a number can be issued, then put it into the revised PI.'
      using errcode = 'P0001';
  end if;

  -- AND THAT IS ALL THIS DOOR ASKS. Whether the stored workbook actually prints
  -- the reserved number is asked by assign_order_display_number() at the moment
  -- an Order would take it — the last point at which refusing still costs
  -- nothing, and the first at which the document and the Order must agree.
  -- Asking it here put an Order-numbering step in front of the review that
  -- decides whether there will be an Order.
  return new;
end;
$$;

comment on function public.order_submissions_require_revised_pi_on_submit() is
  'Submit-time gate on a PI Draft holding a reserved Order number: the number must EXIST. Whether the stored workbook carries it is deliberately NOT asked here — assign_order_display_number() asks that when an Order would take the number (20261121000000). Sending a PI for review is not creating an Order.';

-- ── 3. Read back what was installed, and what was left alone ────────────────

do $$
declare
  v_submit text := pg_get_functiondef(to_regprocedure('public.order_submissions_require_revised_pi_on_submit()'));
  v_order  text := pg_get_functiondef(to_regprocedure('public.assign_order_display_number()'));
  v_rule   text := pg_get_functiondef(to_regprocedure('public.order_submission_revised_pi_refusal(text, text, text, text)'));
  v_trg    text;
begin
  -- 3a. THE DEFECT IS GONE from the deployed body, not merely from this file.
  if v_submit like '%order_submission_revised_pi_refusal%' then
    raise exception
      'ASSERTION FAILED: the submit gate still asks the revised-PI rule';
  end if;

  -- 3b. AND THE REST OF THAT GATE SURVIVED.
  if v_submit not like '%ORDER_SUBMISSION_RESERVATION_REQUIRED%'
     or v_submit not like '%reservation_required%' then
    raise exception
      'ASSERTION FAILED: the submit gate lost the requirement that a reservation exists';
  end if;
  if v_submit not like '%submitted%' then
    raise exception
      'ASSERTION FAILED: the submit gate no longer limits itself to submission';
  end if;

  -- 3c. THE ORDER DOOR STILL ASKS IT. This is the whole safety of the change:
  -- the requirement moved, it was not removed.
  if v_order not like '%order_submission_revised_pi_refusal%' then
    raise exception
      'ASSERTION FAILED: assign_order_display_number() no longer asks the revised-PI rule — the requirement would be gone, not moved';
  end if;

  -- 3d. AND THE RULE ITSELF IS UNTOUCHED, all three refusals intact.
  if v_rule not like '%ORDER_SUBMISSION_REVISED_PI_MISSING%'
     or v_rule not like '%ORDER_SUBMISSION_REVISED_PI_NO_NUMBER%'
     or v_rule not like '%ORDER_SUBMISSION_REVISED_PI_NUMBER_MISMATCH%'
     or v_rule not like '%v_found <> v_expected%' then
    raise exception
      'ASSERTION FAILED: order_submission_revised_pi_refusal() was altered by a migration that must not touch it';
  end if;

  -- 3e. THE TRIGGER IS STILL BOUND, and to the same events. Replacing a
  -- function does not touch its triggers, so this proves nothing was dropped.
  select pg_get_triggerdef(t.oid) into v_trg
  from pg_trigger t
  where t.tgrelid = 'public.order_submissions'::regclass
    and t.tgname = 'order_submissions_require_revised_pi_on_submit'
    and not t.tgisinternal;

  if v_trg is null then
    raise exception 'ASSERTION FAILED: the submit-gate trigger is not bound to order_submissions';
  end if;
  if v_trg !~* 'before insert or update on public\.order_submissions' then
    raise exception 'ASSERTION FAILED: the submit-gate trigger fires on different events: %', v_trg;
  end if;

  -- 3f. NOT ONE RESERVATION WAS TAKEN, RELEASED OR REUSED by this file: every
  -- reserved number is still held by at most one PI.
  if exists (
    select 1
    from public.order_submissions
    where reserved_order_number is not null
    group by reserved_order_number
    having count(*) > 1
  ) then
    raise exception 'ASSERTION FAILED: a reserved Order number is held by more than one PI';
  end if;

  raise notice
    'submit gate: revised-PI question removed from the review door; assign_order_display_number still asks it at the Order door';
end $$;

commit;

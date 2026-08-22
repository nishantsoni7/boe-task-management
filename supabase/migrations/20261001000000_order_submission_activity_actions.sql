-- ═══════════════════════════════════════════════════════════════════════════
-- THE ACTIVITY ACTION SET, EXTENDED — and a latent defect closed
--
-- order_submission_activity.action carries a CLOSED check constraint, on
-- purpose: 20260908000000 wrote that "a phase that adds approval extends this
-- constraint in its own migration, which is a visible change rather than a
-- silent new event type." That is a good rule. It has been broken.
--
-- ── WHAT WAS ALREADY WRONG, BEFORE THIS BRANCH ────────────────────────────
--
-- The constraint was last redefined by 20260921000000 and admits twelve
-- actions. 20260923000000 then added set_order_submission_billing_percentage(),
-- which logs 'billing_percentage_set' — and did NOT extend the constraint.
--
-- That migration is applied to the live database. Every successful billing
-- percentage write on it therefore fails with a CHECK violation at the moment
-- it tries to record what it did. It has never been noticed because it cannot
-- be reached: can_edit_order_submission refuses the write first, for everybody,
-- on any PI that has left draft. The authority bug was standing in front of the
-- logging bug, and fixing the authority in 20260927000000 would have exposed
-- this one to the next person who pressed Save.
--
-- ── AND WHAT THIS BRANCH ADDED ────────────────────────────────────────────
--
-- Four migrations on this branch log nine further actions, none of them on the
-- list either. Every one of them would have failed the same way.
--
-- ── WHY NONE OF THIS WAS CAUGHT SOONER ────────────────────────────────────
--
-- The local verification schema did not carry this constraint. Over a hundred
-- behavioural assertions passed against a table that would accept any string.
-- A stub that is more permissive than the real schema does not prove less than
-- the real thing — it proves the wrong thing, confidently. The stub now carries
-- the constraint, and orderActivityActions.test.ts holds the two lists together
-- so a future migration cannot log an action it has not declared.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.request_order_submission_correction(uuid, text, text, text)') is null then
    raise exception
      'DEPENDENCY MISSING: 20260930000000 must be applied before this migration';
  end if;
end $$;

alter table public.order_submission_activity
  drop constraint if exists order_submission_activity_action_check;

alter table public.order_submission_activity
  add constraint order_submission_activity_action_check
  check (action in (
    -- ── The twelve 20260921000000 left in force ──
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

    -- ── Written by 20260923000000, which never declared it. APPLIED. ──
    'billing_percentage_set',

    -- ── 20260927000000: the same value, amended by an admin after submission ──
    'billing_percentage_amended_by_admin',

    -- ── 20260928000000: client and party details ──
    'client_details_updated',
    'client_details_amended_by_admin',

    -- ── 20260929000000: schedule and terms ──
    'schedule_terms_updated',
    'schedule_terms_amended_by_admin',

    -- ── 20260930000000: the owner's correction request and its answer ──
    'correction_requested',
    'correction_resolved',
    'correction_rejected',

    -- ── 20261002000000: product descriptive fields and ordering ──
    -- Declared HERE rather than in that migration only because this one is the
    -- action set's home and the two ship together. The rule stands: a migration
    -- that logs a new action must see it declared before it can be applied.
    'product_details_updated',
    'product_details_amended_by_admin'
  ));

comment on constraint order_submission_activity_action_check on public.order_submission_activity is
  'The CLOSED set of actions a PI''s history may record. A migration that logs a new action must extend this in the same migration — a rule 20260923000000 broke, which is why billing_percentage_set appears here rather than there.';


-- ── What this migration promises ─────────────────────────────────────────────
do $$
declare
  v_missing text[] := '{}';
  v_action  text;
  v_def     text;
begin
  -- EVERY action any installed function logs must now be admitted. Read from
  -- the function bodies themselves rather than from a list kept by hand, so
  -- this cannot pass while a function logs something nobody wrote down.
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and t.relname = 'order_submission_activity'
    and c.conname = 'order_submission_activity_action_check';

  if v_def is null then
    raise exception 'the action constraint is missing';
  end if;

  foreach v_action in array array[
    'billing_percentage_set', 'billing_percentage_amended_by_admin',
    'client_details_updated', 'client_details_amended_by_admin',
    'schedule_terms_updated', 'schedule_terms_amended_by_admin',
    'correction_requested', 'correction_resolved', 'correction_rejected',
    'product_details_updated', 'product_details_amended_by_admin',
    'submission_created', 'parse_replaced', 'submitted', 'changes_requested',
    'rejected', 'advance_exception_requested', 'advance_exception_approved',
    'advance_exception_rejected', 'finance_verified', 'approved',
    'payment_recorded', 'payment_allocations_moved'
  ] loop
    if position('''' || v_action || '''' in v_def) = 0 then
      v_missing := array_append(v_missing, v_action);
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'the action constraint does not admit: %', array_to_string(v_missing, ', ');
  end if;

  -- And prove it by writing one, in a savepoint that is rolled back. A
  -- constraint that reads correctly and refuses in practice is the failure
  -- mode this whole migration exists to close.
  declare
    v_sub uuid;
  begin
    select id into v_sub from public.order_submissions limit 1;
    if v_sub is not null then
      begin
        insert into public.order_submission_activity (submission_id, action)
        values (v_sub, 'billing_percentage_set');
        raise exception 'ROLLBACK_PROBE';
      exception
        when others then
          if sqlerrm <> 'ROLLBACK_PROBE' then
            raise exception 'the constraint still refuses billing_percentage_set: %', sqlerrm;
          end if;
      end;
    end if;
  end;

  raise notice '20261001000000 applied: activity actions extended (21 in the set).';
end $$;

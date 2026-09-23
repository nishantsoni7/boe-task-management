-- ═══════════════════════════════════════════════════════════════════════════
-- ONE-TIME DATA FIX: SEND ORDER 0524's ALREADY-APPROVED PI V1 TO OPERATIONS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- 20261229000000 records an operations handoff at the moment a PI version
-- BECOMES approved. Order 0524's PI V1 was approved on 2026-09-21, two days
-- before that migration went live, so it has no handoff: nobody was asked to
-- review it, and the Order shows the review as "Not recorded". 20261229000000
-- deliberately backfilled nothing across Orders; this file fixes the one Order
-- the business has asked to route, by name, and nothing else.
--
-- WHAT IT WRITES — once, in one transaction
-- ------------------------------------------
--   * ONE order_operations_handoffs row for PI V1, AWAITING, addressed to the
--     configured operations reviewer. Its approved_by / approved_at are V1's
--     own decided_by / decided_at, UNCHANGED — the historic approval stays the
--     historic approval. created_at and assigned_at are NOW: the handoff
--     itself is new, and the row says so.
--   * ONE order_activity_log entry, operations_handoff_recorded, with no actor
--     (nobody pressed a button; this migration did it) and a payload that says
--     it was recorded late for a pre-existing approval, by this file.
--   * ONE review-request notification to the reviewer, saying the EXISTING
--     PI V1 was sent for review now, with the original approval (approver
--     and date) stated separately — never worded as a new approval.
--
-- WHAT IT DOES NOT DO
-- -------------------
-- No PI version is created or changed; the workbook, the approval and the
-- approver are untouched. Nothing is accepted: the decision stays the
-- reviewer's. The Order's alignment is not moved (it is not_aligned and the
-- handoff snapshots exactly that). No other Order is read or written.
--
-- WHY THE IDs ARE PINNED
-- ----------------------
-- Every id below was read from production on 2026-09-23 and is checked, not
-- assumed. If ANY expectation no longer holds — the Order, its one approved
-- version, the approver, the approval time, the alignment, the configured
-- reviewer, or their eligibility — the file raises and writes nothing, so a
-- changed situation is looked at by a person instead of guessed at. The
-- reviewer is the one configured in order_operations_reviewers at apply time;
-- the pinned id only asserts that it is still the person the business named.
--
-- REPEATS ARE HARMLESS
-- --------------------
-- If V1 already has a handoff (this file ran before, or anything else recorded
-- it), the file says so and writes nothing — no second row, no second history
-- entry, no second notification. The handoff table is also UNIQUE on the
-- version, so a concurrent second run cannot insert twice either.
--
-- A DATABASE WITHOUT THIS ORDER (a disposable replay, a fresh project) has no
-- Order with this id and no Order numbered 0524: the file says so and does
-- nothing. An Order numbered 0524 with a DIFFERENT id is a mismatch and stops.
--
-- LOCK ORDER is 20261229000000's: the reviewer row → orders → PI rows →
-- handoffs.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  -- ── The expectations, read from production on 2026-09-23 ──
  c_display_number  constant text        := '0524';
  c_order_id        constant uuid        := '5ca406a4-4d9f-4a71-acd9-923d3d13c208';
  c_version_id      constant uuid        := 'd900e411-fa3b-4f87-b3de-7dfc903aa715';
  c_submission_id   constant uuid        := '4df2ce51-4c39-4670-b318-883f65fdb336';
  c_approved_by     constant uuid        := '6507df9f-cdeb-4ebd-849f-8498c165d596';
  c_approved_at     constant timestamptz := '2026-09-21 17:07:25.126071+00';
  c_reviewer_id     constant uuid        := '58ec48e3-d252-4660-b61b-4db48fb58e9e';
  c_migration       constant text        := '20261230000000_order_0524_operations_handoff_for_existing_approval';

  v_order      public.orders%rowtype;
  v_version    public.order_pi_versions%rowtype;
  v_versions   integer;
  v_configured uuid;
  v_existing   public.order_operations_handoffs%rowtype;
  v_other      integer;
  v_handoff_id uuid;
  v_approver   text;
  v_now        timestamptz := now();
begin
  -- ── Is this Order in this database at all? ──
  if not exists (select 1 from public.orders where id = c_order_id) then
    if exists (select 1 from public.orders where display_number = c_display_number) then
      raise exception 'ORDER_0524_HANDOFF_MISMATCH: an Order numbered % exists, but not with id %; refusing to guess',
        c_display_number, c_order_id;
    end if;
    raise notice 'ORDER_0524_HANDOFF: Order % (%) is not in this database; nothing to do', c_display_number, c_order_id;
    return;
  end if;

  -- ── Locks, in 20261229000000's order ──
  select r.user_id into v_configured
    from public.order_operations_reviewers r
   where r.duty = 'pi_handoff'
     for share;
  if not found then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: the pi_handoff reviewer settings row is missing';
  end if;

  select * into v_order from public.orders where id = c_order_id for update;

  select count(*) into v_versions from public.order_pi_versions where order_id = c_order_id;
  select * into v_version from public.order_pi_versions where id = c_version_id for share;

  -- ── Already done? Then nothing at all happens ──
  select * into v_existing from public.order_operations_handoffs where pi_version_id = c_version_id;
  if found then
    raise notice 'ORDER_0524_HANDOFF: PI V1 of Order % already has handoff % (status %, created %); nothing to do',
      c_display_number, v_existing.id, v_existing.status, v_existing.created_at;
    return;
  end if;

  -- ── Every expectation, or stop ──
  if v_order.display_number is distinct from c_display_number then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: Order % is numbered %, not %', c_order_id, v_order.display_number, c_display_number;
  end if;
  if v_order.status is distinct from 'running' then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: Order % is %, expected running', c_display_number, v_order.status;
  end if;
  if v_order.source_order_submission_id is distinct from c_submission_id then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: Order % is not built from PI submission %', c_display_number, c_submission_id;
  end if;
  if v_order.production_alignment is distinct from 'not_aligned'
     or v_order.production_aligned_by is not null
     or v_order.production_aligned_at is not null then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: Order % production alignment is %, expected not_aligned with nobody recorded',
      c_display_number, v_order.production_alignment;
  end if;

  if v_versions <> 1 then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: Order % has % PI versions, expected exactly one', c_display_number, v_versions;
  end if;
  if v_version.id is null
     or v_version.order_id is distinct from c_order_id
     or v_version.submission_id is distinct from c_submission_id
     or v_version.version_number is distinct from 1
     or v_version.status is distinct from 'approved' then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: PI version % is not Order %''s approved V1 (found V%, %)',
      c_version_id, c_display_number, v_version.version_number, v_version.status;
  end if;
  if v_version.decided_by is distinct from c_approved_by or v_version.decided_at is distinct from c_approved_at then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: PI V1 approval is by % at %, expected % at %',
      v_version.decided_by, v_version.decided_at, c_approved_by, c_approved_at;
  end if;

  select count(*) into v_other from public.order_operations_handoffs where order_id = c_order_id;
  if v_other <> 0 then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: Order % already has % handoff(s) for another version', c_display_number, v_other;
  end if;

  -- The reviewer: the one CONFIGURED now, who must be the person the business
  -- named, and eligible exactly as the trigger would require.
  if v_configured is distinct from c_reviewer_id then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: the configured operations reviewer is %, expected %', v_configured, c_reviewer_id;
  end if;
  if not exists (
    select 1 from public.users u
     where u.id = v_configured and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: the configured operations reviewer % is not an active account', v_configured;
  end if;
  if not public.operations_reviewer_can_open_order(v_configured, c_order_id) then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: the configured operations reviewer % cannot open Order %', v_configured, c_display_number;
  end if;
  if v_configured = v_version.decided_by then
    raise exception 'ORDER_0524_HANDOFF_MISMATCH: the reviewer approved V1 themselves; the review notification would not be sent';
  end if;

  -- ── The handoff: the historic approval, recorded now ──
  insert into public.order_operations_handoffs (
    order_id, pi_version_id, submission_id, version_number,
    approved_by, approved_at,
    assigned_to, assigned_at, unassigned_reason,
    production_alignment_at_approval, prior_handoff_status,
    created_at
  ) values (
    c_order_id, c_version_id, c_submission_id, 1,
    v_version.decided_by, v_version.decided_at,
    v_configured, v_now, null,
    v_order.production_alignment, null,
    v_now
  )
  returning id into v_handoff_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (c_order_id, null, 'operations_handoff_recorded',
          jsonb_build_object(
            'handoff_id', v_handoff_id,
            'version_id', c_version_id,
            'version_number', 1,
            'assigned_to', v_configured,
            'unassigned_reason', null,
            'production_alignment', v_order.production_alignment,
            'superseded_handoff_id', null,
            'superseded_handoff_status', null,
            'superseded_version_number', null,
            'recorded_for_existing_approval', true,
            'approved_by', v_version.decided_by,
            'approved_at', v_version.decided_at,
            'recorded_by_migration', c_migration));

  -- NOT the trigger's "PI V1 approved by …" wording: nothing was approved
  -- today. The title says the existing V1 was SENT for review now; the body
  -- names the original approval, its approver and its date, separately.
  select nullif(btrim(u.full_name), '') into v_approver from public.users u where u.id = v_version.decided_by;
  insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
  values (
    v_configured, null, c_order_id, 'order_operations_review_requested'::notification_type,
    format('Order %s: existing PI V1 sent for your operations review', v_order.display_number),
    format('Original approval: %s, %s. PI V1 was approved before operations review was recorded and has been sent to you now. Open the Order, review PI V1, then choose Accept for production or Cannot accept.',
           coalesce(v_approver, 'an administrator'),
           to_char(v_version.decided_at at time zone 'Asia/Kolkata', 'FMDD FMMonth YYYY')),
    true
  );

  raise notice 'ORDER_0524_HANDOFF: recorded handoff % for PI V1 of Order %, awaiting review by %',
    v_handoff_id, c_display_number, v_configured;
end $$;

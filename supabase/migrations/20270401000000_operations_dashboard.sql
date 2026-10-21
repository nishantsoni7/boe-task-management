-- ═══════════════════════════════════════════════════════════════════════════
-- OPERATIONS DASHBOARD: changes to an order already in production, answered
-- line by line, and the Orders / Dispatches comparison.
--
-- WHAT THE OWNER ASKED FOR (2026-10-22)
-- -------------------------------------
-- The Operations team's Orders dashboard shows (1) Orders not aligned for
-- manufacturing, (2) new changes in Approved Orders for Operations to scan and
-- say whether each can be done, (3) revenue, (4) running orders, (5) Orders
-- and Dispatches last month, (6) Orders and Dispatches over the last 6 months.
--
-- Items 1, 3 and 4 are already in orders_dashboard_summary(); this migration
-- adds 2, 5 and 6, and the rule that makes 2 possible:
--
--   * A customer sometimes asks for a change late in manufacturing. The change
--     is a revised PI, approved by the approver. Until now the approval took
--     the Order's production alignment away until Operations accepted the new
--     version — wrong for a factory already making the order.
--     NOW: an Order that is ALREADY ALIGNED stays aligned when a revision is
--     approved. Operations answers each changed line; the answers are advice
--     to the approver, who decides with the customer. An Order that is NOT yet
--     aligned keeps today's rule (nothing to reset; acceptance aligns).
--
--   * Operations' answer is one per changed LINE: can_do / cannot_do / discuss.
--     "Accept all" and "Reject all" are conveniences of the screen that fill
--     every line; the database stores one answer per line, a note being
--     required on cannot_do and discuss.
--
-- WHAT IS NOT CHANGED
-- -------------------
-- decide_order_operations_handoff() (whole-version accept / flag) is untouched
-- and remains the way an Order that is not yet aligned is accepted. Money
-- gates (the 40% advance, holds) are untouched: a revision that lowers the
-- verified percentage still removes alignment through the advance hold.
--
-- DISPATCH DATES
-- --------------
-- orders has no dispatched_at. The date an Order was dispatched is read from
-- the activity-log entry the Order page writes when the status moves to
-- 'dispatched' (event_type 'status_changed', payload.to). A dispatched Order
-- with no such entry is counted and SAID, never guessed.
--
-- Roll-back: drop the two RPCs and the table; re-emit the two functions from
-- 20261229000000 §6 and 20270321000001 §7. Nothing else depends on them.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ 1. An aligned Order stays aligned when a revision is approved ═════════
--
-- order_pi_versions_record_operations_handoff(), re-emitted IN FULL from
-- 20261229000000 §6 with ONE change: the block that reset an Order's
-- alignment ("AN OLDER ALIGNMENT NEVER COVERS A NEWER VERSION") is gone, and
-- the reviewer's notice says the Order is still in production. The handoff
-- still records production_alignment_at_approval = 'aligned', which is how
-- the Operations dashboard knows this version is a change to an Order that is
-- already being made.

create or replace function public.order_pi_versions_record_operations_handoff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order        public.orders%rowtype;
  v_prior        public.order_operations_handoffs%rowtype;
  v_configured   uuid;
  v_reviewer     uuid;
  v_unassigned   text;
  v_handoff_id   uuid;
  v_now          timestamptz := now();
  v_approver     text;
  v_alignment    text;
begin
  -- Only the moment a version BECOMES the one in force.
  if new.status <> 'approved' then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    return null;
  end if;
  -- Idempotent: one handoff per version, whatever path re-runs.
  if exists (select 1 from public.order_operations_handoffs h where h.pi_version_id = new.id) then
    return null;
  end if;

  select * into v_order from public.orders where id = new.order_id;
  if not found then
    return null;
  end if;
  v_alignment := v_order.production_alignment;

  -- WHO THE REVIEWER IS RIGHT NOW — read under a SHARE lock on the one
  -- settings row (see 20261229000000 §6 for why).
  select r.user_id into v_configured
    from public.order_operations_reviewers r
   where r.duty = 'pi_handoff'
     for share;

  -- ADDRESSED ONLY TO SOMEBODY WHO CAN OPEN THIS ORDER, as they are now.
  -- Otherwise the handoff is recorded UNASSIGNED with the reason, and the
  -- administrators are told. Never an admin in the reviewer's place.
  if v_configured is null then
    v_reviewer := null;
    v_unassigned := 'no_reviewer';
  elsif not exists (
    select 1 from public.users u
    where u.id = v_configured and u.is_active and coalesce(u.is_deleted, false) = false
  ) then
    v_reviewer := null;
    v_unassigned := 'reviewer_inactive';
  elsif not public.operations_reviewer_can_open_order(v_configured, new.order_id) then
    v_reviewer := null;
    v_unassigned := 'reviewer_cannot_open_order';
  else
    v_reviewer := v_configured;
    v_unassigned := null;
  end if;

  -- The earlier version's handoff, whatever it decided, is now history.
  update public.order_operations_handoffs
     set superseded_at = v_now,
         superseded_by_version_id = new.id
   where order_id = new.order_id
     and superseded_at is null
  returning * into v_prior;

  insert into public.order_operations_handoffs (
    order_id, pi_version_id, submission_id, version_number,
    approved_by, approved_at,
    assigned_to, assigned_at, unassigned_reason,
    production_alignment_at_approval, prior_handoff_status
  ) values (
    new.order_id, new.id, new.submission_id, new.version_number,
    new.decided_by, coalesce(new.decided_at, v_now),
    v_reviewer, case when v_reviewer is null then null else v_now end, v_unassigned,
    v_alignment, v_prior.status
  )
  returning id into v_handoff_id;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (new.order_id, new.decided_by, 'operations_handoff_recorded',
          jsonb_build_object(
            'handoff_id', v_handoff_id,
            'version_id', new.id,
            'version_number', new.version_number,
            'assigned_to', v_reviewer,
            'unassigned_reason', v_unassigned,
            'production_alignment', v_alignment,
            'alignment_kept', v_alignment = 'aligned',
            'superseded_handoff_id', v_prior.id,
            'superseded_handoff_status', v_prior.status,
            'superseded_version_number', v_prior.version_number));

  -- UNASSIGNED IS AN ADMINISTRATOR'S PROBLEM, and they are told at once.
  if v_reviewer is null then
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    select u.id, null, new.order_id, 'order_operations_review_requested'::notification_type,
           format('Order %s: PI V%s approved, but no operations reviewer can take it. Assign one in Control Center.',
                  v_order.display_number, new.version_number),
           case v_unassigned
             when 'reviewer_inactive' then 'The configured operations reviewer is no longer an active account.'
             when 'reviewer_cannot_open_order' then 'The configured operations reviewer cannot open this Order. Choose an admin, a member of the operations team, or a holder of orders.view_all.'
             else 'No operations reviewer is configured. Control Center → Operations Handoff.'
           end,
           true
      from public.users u
     where u.role = 'admin' and u.is_active and coalesce(u.is_deleted, false) = false;
  end if;

  -- (20270401000000) NO ALIGNMENT RESET HERE ANY MORE. An Order already being
  -- made stays aligned; Operations answers the changed lines and the approver
  -- decides with the customer. An Order not yet aligned has nothing to reset.

  -- The reviewer hears about it — unless they are the approver.
  if v_reviewer is not null and v_reviewer is distinct from new.decided_by then
    select nullif(btrim(u.full_name), '') into v_approver from public.users u where u.id = new.decided_by;
    insert into public.notifications (user_id, task_id, entity_id, type, title, body, is_push_sent)
    values (
      v_reviewer, null, new.order_id, 'order_operations_review_requested'::notification_type,
      format('Order %s: PI V%s approved by %s. Awaiting your operations review.',
             v_order.display_number, new.version_number, coalesce(v_approver, 'an administrator')),
      case
        when v_alignment = 'aligned' then
          format('This Order is already in production and stays aligned. Open your Operations dashboard, look at what changed in V%s, and answer each change: can do, cannot do, or needs discussion.',
                 new.version_number)
        when v_prior.status = 'accepted' then
          format('You accepted PI V%s earlier. Open the Order, review what changed in V%s, then choose Accept for production or Cannot accept.',
                 v_prior.version_number, new.version_number)
        else
          format('Open the Order, review PI V%s, then choose Accept for production or Cannot accept.',
                 new.version_number)
      end,
      true
    );
  end if;

  return null;
end;
$$;

comment on function public.order_pi_versions_record_operations_handoff() is
  'AFTER trigger on order_pi_versions: when a version becomes approved, supersedes the Order''s live handoff (keeping its decision), records a new awaiting handoff for this version addressed to the assigned, active operations reviewer (or unassigned), logs operations_handoff_recorded, and notifies the reviewer once. An Order that is already aligned STAYS aligned (20270401000000): the handoff records production_alignment_at_approval = aligned and Operations answers the changed lines. Idempotent per version.';

revoke execute on function public.order_pi_versions_record_operations_handoff() from public, anon, authenticated;


-- ═══ 2. The decision notice does not call a line-by-line answer "accepted" ═
--
-- order_operations_handoff_notify(), re-emitted IN FULL from 20270321000001 §7
-- with one early return: when answer_order_pi_changes() (below) moves the
-- handoff to accepted it sets boe.pi_changes_answered, and sends its own,
-- accurate notice ("2 can do, 1 cannot do") instead of "accepted for
-- production".

create or replace function public.order_operations_handoff_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_actor uuid;
begin
  if new.status is not distinct from old.status or new.status not in ('accepted', 'clarification_needed') then
    return null;
  end if;
  if nullif(current_setting('boe.pi_changes_answered', true), '') is not null then
    return null;
  end if;
  select o.display_number, o.assigned_to into v_order from public.orders o where o.id = new.order_id;
  v_actor := coalesce(case when new.status = 'accepted' then new.accepted_by else new.clarification_by end, auth.uid());
  perform public.order_notify_users(
    array[v_order.assigned_to], v_actor, new.order_id, 'order_operations_review_decided',
    case new.status
      when 'accepted' then format('Order %s: Operations accepted PI V%s for production%s.',
                                  v_order.display_number, new.version_number, public.order_notify_actor_suffix(v_actor))
      else format('Order %s: Operations asked for clarification on PI V%s%s.',
                  v_order.display_number, new.version_number, public.order_notify_actor_suffix(v_actor)) end,
    case when new.status = 'clarification_needed' then new.clarification_reason else new.accepted_note end);
  return null;
exception when others then
  raise warning 'order_operations_handoff_notify skipped a notice for handoff %: %', new.id, sqlerrm;
  return null;
end;
$$;
revoke all on function public.order_operations_handoff_notify() from public, anon, authenticated;


-- ═══ 3. The answers ════════════════════════════════════════════════════════

create table if not exists public.order_pi_change_answers (
  id          uuid primary key default gen_random_uuid(),
  handoff_id  uuid not null references public.order_operations_handoffs(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  -- Stable name of the changed line within the revision: 'item:<sequence>' or
  -- 'group:<schedule|commercial|client|terms>'. See order_pi_diff_lines().
  line_key    text not null check (btrim(line_key) <> ''),
  line_title  text not null,
  decision    text not null check (decision in ('can_do', 'cannot_do', 'discuss')),
  note        text check (note is null or char_length(note) <= 1000),
  answered_by uuid references public.users(id) on delete set null,
  answered_at timestamptz not null default now(),
  constraint order_pi_change_answers_line_key unique (handoff_id, line_key),
  constraint order_pi_change_answers_note_required
    check (decision = 'can_do' or nullif(btrim(coalesce(note, '')), '') is not null)
);

comment on table public.order_pi_change_answers is
  'Operations'' answer to each changed line of a PI revision approved on an Order already in production: can_do / cannot_do / discuss, with a note required unless can_do. ADVICE to the approver, never a gate: nothing here changes the Order. Written only by answer_order_pi_changes(); read only through operations_orders_dashboard(). 20270401000000.';

create index if not exists order_pi_change_answers_order_idx on public.order_pi_change_answers (order_id);

alter table public.order_pi_change_answers enable row level security;
revoke all on table public.order_pi_change_answers from public, anon, authenticated;


-- ═══ 4. What changed between two PI versions, as lines ═════════════════════
--
-- Pure: takes two order_pi_content_of() documents and returns the changed
-- lines. One line per changed product (matched by item sequence), and one per
-- changed GROUP of header fields (dates, prices and totals, client and
-- addresses, terms), so a quantity change does not arrive as six lines of
-- recomputed totals. Workbook paths, hashes and the PI's creation date are
-- not changes the factory can act on and are ignored.

create or replace function public.order_pi_diff_lines(p_old jsonb, p_new jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_lines   jsonb := '[]'::jsonb;
  v_group   record;
  v_changes jsonb;
  v_item    record;
  v_k       text;
  v_f       text;
  v_o       jsonb;
  v_n       jsonb;
  v_oi      jsonb;
  v_ni      jsonb;
  v_fields  constant text[] := array['product_name', 'quantity', 'dimensions', 'material', 'customization', 'cost_per_piece', 'total_amount'];
begin
  -- Header groups.
  for v_group in
    select * from (values
      (1, 'schedule',   'Dates',
          array['due_date', 'order_confirmation_date', 'dispatch_commitment']),
      (2, 'commercial', 'Prices and totals',
          array['gross_product_amount', 'discount_amount', 'subtotal_after_discount', 'fabric_cost', 'packing_cost',
                'transportation_amount', 'total_before_gst', 'gst_amount', 'grand_total', 'billing_percentage']),
      (3, 'client',     'Client and addresses',
          array['client_name', 'contact_number', 'client_city', 'bill_to_name', 'bill_to_phone', 'bill_to_gst',
                'billing_address', 'ship_to_name', 'ship_to_phone', 'ship_to_gst', 'shipping_address']),
      (4, 'terms',      'Terms',
          array['fabric_responsibility', 'commercial_terms_note', 'payment_terms', 'billing_terms'])
    ) as g(ord, key, title, keys) order by g.ord
  loop
    v_changes := '[]'::jsonb;
    foreach v_f in array v_group.keys loop
      v_o := coalesce(p_old -> 'submission' -> v_f, 'null'::jsonb);
      v_n := coalesce(p_new -> 'submission' -> v_f, 'null'::jsonb);
      if v_o is distinct from v_n then
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'label', initcap(replace(v_f, '_', ' ')),
          'old', p_old -> 'submission' ->> v_f,
          'new', p_new -> 'submission' ->> v_f));
      end if;
    end loop;
    if jsonb_array_length(v_changes) > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'key', 'group:' || v_group.key, 'group', v_group.key, 'title', v_group.title,
        'kind', 'changed', 'changes', v_changes));
    end if;
  end loop;

  -- Product lines, matched by item sequence (row number when there is none).
  for v_item in
    select coalesce(n.k, o.k) as k, o.i as oi, n.i as ni,
           coalesce((n.i ->> 'sort_order')::int, (o.i ->> 'sort_order')::int, 0) as so
      from (select coalesce(x ->> 'item_sequence', 'row' || (x ->> 'source_row')) as k, x as i
              from jsonb_array_elements(coalesce(p_old -> 'items', '[]'::jsonb)) x) o
      full join (select coalesce(x ->> 'item_sequence', 'row' || (x ->> 'source_row')) as k, x as i
                   from jsonb_array_elements(coalesce(p_new -> 'items', '[]'::jsonb)) x) n on n.k = o.k
     order by 4, 1
  loop
    v_k := v_item.k;
    v_oi := v_item.oi;
    v_ni := v_item.ni;
    v_changes := '[]'::jsonb;
    foreach v_f in array v_fields loop
      if coalesce(v_oi -> v_f, 'null'::jsonb) is distinct from coalesce(v_ni -> v_f, 'null'::jsonb) then
        v_changes := v_changes || jsonb_build_array(jsonb_build_object(
          'label', initcap(replace(v_f, '_', ' ')),
          'old', v_oi ->> v_f,
          'new', v_ni ->> v_f));
      end if;
    end loop;
    if jsonb_array_length(v_changes) > 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'key', 'item:' || v_k,
        'group', 'item',
        'title', coalesce(nullif(btrim(coalesce(v_ni ->> 'product_name', v_oi ->> 'product_name')), ''), 'Product') || ' (item ' || v_k || ')',
        'kind', case when v_oi is null then 'added' when v_ni is null then 'removed' else 'changed' end,
        'changes', v_changes));
    end if;
  end loop;

  return v_lines;
end;
$$;

comment on function public.order_pi_diff_lines(jsonb, jsonb) is
  'The changed lines between two order_pi_content_of() documents: one per changed product (added / removed / changed) and one per changed group of header fields. Pure. 20270401000000.';

revoke execute on function public.order_pi_diff_lines(jsonb, jsonb) from public, anon, authenticated;


-- The changed lines of ONE handoff's version against the version it replaced,
-- each carrying the answer already given (if any). Internal: callers check
-- visibility first.
--   available = false when the replaced version's content was not captured
--   (older data); the screen then says so rather than showing an empty list.
create or replace function public.order_handoff_change_lines(p_handoff_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  h        public.order_operations_handoffs%rowtype;
  v_prior  uuid;
  v_old    jsonb;
  v_lines  jsonb;
begin
  select * into h from public.order_operations_handoffs where id = p_handoff_id;
  if not found then
    return jsonb_build_object('available', false, 'lines', '[]'::jsonb);
  end if;
  select v.id into v_prior
    from public.order_pi_versions v
   where v.order_id = h.order_id and v.superseded_by_version_id = h.pi_version_id
   order by v.version_number desc limit 1;
  select c.content into v_old from public.order_pi_version_contents c where c.version_id = v_prior;
  if v_old is null or h.version_number < 2 then
    return jsonb_build_object('available', false, 'lines', '[]'::jsonb);
  end if;

  v_lines := public.order_pi_diff_lines(v_old, public.order_pi_content_of(h.submission_id));

  select coalesce(jsonb_agg(
           l || case when a.id is null then '{}'::jsonb
                     else jsonb_build_object('answer', jsonb_build_object(
                            'decision', a.decision, 'note', a.note, 'answered_at', a.answered_at)) end
           order by ord), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(v_lines) with ordinality as t(l, ord)
    left join public.order_pi_change_answers a
           on a.handoff_id = p_handoff_id and a.line_key = t.l ->> 'key';

  return jsonb_build_object('available', true, 'lines', v_lines);
end;
$$;

revoke execute on function public.order_handoff_change_lines(uuid) from public, anon, authenticated;


-- ═══ 5. Operations answers the changes ═════════════════════════════════════
--
-- p_answers: [{ "line_key": "...", "decision": "can_do|cannot_do|discuss", "note": "..." }]
-- EVERY changed line must be answered in one call (the screen's "Accept all" /
-- "Reject all" fill them all); a note is required unless the answer is can_do.
-- The caller must be the reviewer the handoff is addressed to. Answering again
-- while the version is still the one in force replaces the earlier answers.
-- The Order is not touched: it stays aligned whatever is answered.

create or replace function public.answer_order_pi_changes(p_handoff_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := public.assert_order_submission_actor();
  v_order_id uuid;
  v_order   public.orders%rowtype;
  h         public.order_operations_handoffs%rowtype;
  v_ver     public.order_pi_versions%rowtype;
  v_lines   jsonb;
  v_line    jsonb;
  v_ans     jsonb;
  v_dec     text;
  v_note    text;
  v_seen    text[] := array[]::text[];
  v_can     int := 0;
  v_cannot  int := 0;
  v_disc    int := 0;
  v_name    text;
  v_now     timestamptz := now();
  v_summary text;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'ORDER_CHANGES_ANSWERS_INVALID: send the answers as a list' using errcode = 'P0001';
  end if;

  select order_id into v_order_id from public.order_operations_handoffs where id = p_handoff_id;
  if v_order_id is null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_NOT_FOUND: that handoff no longer exists' using errcode = 'P0002';
  end if;
  -- Lock order, as decide_order_operations_handoff(): reviewer row, Order, handoff.
  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;
  select * into v_order from public.orders where id = v_order_id for update;
  select * into h from public.order_operations_handoffs where id = p_handoff_id for update;

  if h.assigned_to is null or h.assigned_to <> v_actor then
    raise exception 'Only the operations reviewer this change was sent to can answer it' using errcode = '42501';
  end if;
  if not public.can_view_order_as_actor(h.order_id) then
    raise exception 'You do not have access to this Order' using errcode = '42501';
  end if;
  if v_order.status in ('cancelled', 'dispatched') then
    raise exception 'ORDER_CHANGES_CLOSED: Order % is % and takes no more changes', v_order.display_number, v_order.status
      using errcode = 'P0001';
  end if;
  if h.superseded_at is not null then
    raise exception 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED: PI V% has been replaced by a later version; answer the current one', h.version_number
      using errcode = 'P0001';
  end if;
  select * into v_ver from public.order_pi_versions where id = h.pi_version_id;
  if not found or v_ver.status <> 'approved' then
    raise exception 'ORDER_OPERATIONS_HANDOFF_STALE: PI V% is no longer the approved version of Order %', h.version_number, v_order.display_number
      using errcode = 'P0001';
  end if;
  if h.production_alignment_at_approval is distinct from 'aligned' or h.version_number < 2 then
    raise exception 'ORDER_CHANGES_NOT_ANSWERABLE: this version was approved before the Order was aligned; accept or flag it on the Order page'
      using errcode = 'P0001';
  end if;
  if h.status = 'clarification_needed' then
    raise exception 'ORDER_CHANGES_ALREADY_FLAGGED: this version was already flagged for clarification on the Order page'
      using errcode = 'P0001';
  end if;

  v_lines := public.order_handoff_change_lines(p_handoff_id);
  if not (v_lines ->> 'available')::boolean or jsonb_array_length(v_lines -> 'lines') = 0 then
    raise exception 'ORDER_CHANGES_NONE: there are no changed lines to answer for PI V%', h.version_number
      using errcode = 'P0001';
  end if;

  -- Every changed line answered, each once, nothing else.
  for v_ans in select * from jsonb_array_elements(p_answers) loop
    if jsonb_typeof(v_ans) <> 'object' or nullif(btrim(coalesce(v_ans ->> 'line_key', '')), '') is null then
      raise exception 'ORDER_CHANGES_ANSWERS_INVALID: each answer needs a line_key' using errcode = 'P0001';
    end if;
    if (v_ans ->> 'line_key') = any (v_seen) then
      raise exception 'ORDER_CHANGES_ANSWERS_INVALID: line % is answered twice', v_ans ->> 'line_key' using errcode = 'P0001';
    end if;
    v_seen := v_seen || (v_ans ->> 'line_key');
  end loop;
  for v_line in select * from jsonb_array_elements(v_lines -> 'lines') loop
    if not (v_line ->> 'key') = any (v_seen) then
      raise exception 'ORDER_CHANGES_INCOMPLETE: answer every changed line — "%" has no answer', v_line ->> 'title'
        using errcode = 'P0001';
    end if;
  end loop;
  if array_length(v_seen, 1) <> jsonb_array_length(v_lines -> 'lines') then
    raise exception 'ORDER_CHANGES_ANSWERS_INVALID: an answer names a line that did not change' using errcode = 'P0001';
  end if;

  perform set_config('boe.pi_changes_answered', 'on', true);

  for v_line in select * from jsonb_array_elements(v_lines -> 'lines') loop
    select a into v_ans from jsonb_array_elements(p_answers) a where a ->> 'line_key' = v_line ->> 'key';
    v_dec := v_ans ->> 'decision';
    v_note := nullif(btrim(coalesce(v_ans ->> 'note', '')), '');
    if v_dec is null or v_dec not in ('can_do', 'cannot_do', 'discuss') then
      raise exception 'ORDER_CHANGES_DECISION_UNKNOWN: choose can do, cannot do or needs discussion for "%"', v_line ->> 'title'
        using errcode = 'P0001';
    end if;
    if v_dec <> 'can_do' and v_note is null then
      raise exception 'ORDER_CHANGES_NOTE_REQUIRED: say why for "%"', v_line ->> 'title' using errcode = 'P0001';
    end if;
    if v_note is not null and char_length(v_note) > 1000 then
      raise exception 'ORDER_CHANGES_NOTE_TOO_LONG: the note may be at most 1000 characters' using errcode = 'P0001';
    end if;
    insert into public.order_pi_change_answers (handoff_id, order_id, line_key, line_title, decision, note, answered_by, answered_at)
    values (p_handoff_id, h.order_id, v_line ->> 'key', v_line ->> 'title', v_dec, v_note, v_actor, v_now)
    on conflict (handoff_id, line_key) do update
       set decision = excluded.decision, note = excluded.note,
           answered_by = excluded.answered_by, answered_at = excluded.answered_at,
           line_title = excluded.line_title;
    if v_dec = 'can_do' then v_can := v_can + 1;
    elsif v_dec = 'cannot_do' then v_cannot := v_cannot + 1;
    else v_disc := v_disc + 1; end if;
  end loop;

  v_summary := format('Answered line by line: %s can do, %s cannot do, %s need discussion.', v_can, v_cannot, v_disc);

  -- The version has now been reviewed. The Order's alignment is NOT touched.
  if h.status = 'awaiting' then
    update public.order_operations_handoffs
       set status = 'accepted', accepted_by = v_actor, accepted_at = v_now, accepted_note = v_summary
     where id = h.id;
  end if;

  insert into public.order_activity_log (order_id, actor_id, event_type, payload)
  values (h.order_id, v_actor, 'operations_changes_answered',
          jsonb_build_object('handoff_id', h.id, 'version_id', h.pi_version_id, 'version_number', h.version_number,
                             'can_do', v_can, 'cannot_do', v_cannot, 'discuss', v_disc));

  select nullif(btrim(u.full_name), '') into v_name from public.users u where u.id = v_actor;
  perform public.order_notify_users(
    array[h.approved_by, v_order.assigned_to], v_actor, h.order_id, 'order_operations_review_decided',
    format('Order %s: %s answered the changes in PI V%s — %s can do, %s cannot do, %s need discussion.',
           v_order.display_number, coalesce(v_name, 'Operations'), h.version_number, v_can, v_cannot, v_disc),
    case when v_cannot + v_disc > 0 then 'Open the Orders dashboard to see each answer. The Order stays in production meanwhile.' else null end);

  return jsonb_build_object('handoff_id', h.id, 'can_do', v_can, 'cannot_do', v_cannot, 'discuss', v_disc);
end;
$$;

comment on function public.answer_order_pi_changes(uuid, jsonb) is
  'The assigned operations reviewer answers every changed line of a revision approved on an Order already aligned: can_do / cannot_do / discuss, note required unless can_do. Advice only: the Order stays aligned. Marks the handoff reviewed (accepted, note = the counts), logs operations_changes_answered, tells the approver and the salesperson. 20270401000000.';

revoke execute on function public.answer_order_pi_changes(uuid, jsonb) from public, anon;
grant  execute on function public.answer_order_pi_changes(uuid, jsonb) to authenticated;


-- ═══ 6. The Operations dashboard's own read ════════════════════════════════
--
-- Beside orders_dashboard_summary() (running, not aligned, revenue), this
-- returns what is new: the changes waiting for THIS reader to answer (if they
-- are the assigned reviewer), the answers already given (to the reviewer and
-- to whoever approves Orders), and Orders / Dispatches for last month and the
-- last six completed months. Every figure is over the Orders this reader may
-- open; none is money-sensitive beyond what the Orders list already shows.

create or replace function public.operations_orders_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := public.assert_order_submission_actor();
  v_now        timestamptz := now();
  v_ist        date := timezone('Asia/Kolkata', now())::date;
  v_month_from date := date_trunc('month', timezone('Asia/Kolkata', now()))::date;
  v_last_from  date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '1 month')::date;
  v_last_to    date := (date_trunc('month', timezone('Asia/Kolkata', now()))::date - 1);
  v_six_from   date := (date_trunc('month', timezone('Asia/Kolkata', now())) - interval '6 months')::date;
  v_is_reviewer boolean;
  v_is_approver boolean;
  v_pending    jsonb;
  v_responses  jsonb;
  v_periods    jsonb;
begin
  if not public.module_entry_open('orders') then
    raise exception 'The Orders module is not open to this account' using errcode = '42501';
  end if;

  v_is_reviewer := exists (select 1 from public.order_operations_reviewers r
                            where r.duty = 'pi_handoff' and r.user_id = v_actor);
  v_is_approver := coalesce(public.actor_can_approve_order(), false)
                   or exists (select 1 from public.users u where u.id = v_actor and u.role = 'admin'
                                 and u.is_active and coalesce(u.is_deleted, false) = false);

  -- Waiting for THIS reader's answer.
  select coalesce(jsonb_agg(x order by x ->> 'approved_at'), '[]'::jsonb) into v_pending
    from (
      select jsonb_build_object(
               'handoff_id', h.id, 'order_id', o.id, 'display_number', o.display_number,
               'client_name', o.client_name, 'version_number', h.version_number,
               'approved_at', h.approved_at,
               'approved_by_name', (select nullif(btrim(u.full_name), '') from public.users u where u.id = h.approved_by),
               'revision_reason', (select v.revision_reason from public.order_pi_versions v where v.id = h.pi_version_id),
               'changes', public.order_handoff_change_lines(h.id)) as x
        from public.order_operations_handoffs h
        join public.orders o on o.id = h.order_id
       where v_is_reviewer
         and h.assigned_to = v_actor
         and h.status = 'awaiting'
         and h.superseded_at is null
         and h.version_number >= 2
         and h.production_alignment_at_approval = 'aligned'
         and o.status not in ('cancelled', 'dispatched')
         and coalesce(o.is_test_data, false) = false
         and public.can_read_order_detail(o.id)
    ) s;

  -- Answers already given, last 45 days: for the reviewer who gave them and
  -- for whoever approves Orders.
  select coalesce(jsonb_agg(x order by x ->> 'answered_at' desc), '[]'::jsonb) into v_responses
    from (
      select jsonb_build_object(
               'handoff_id', h.id, 'order_id', o.id, 'display_number', o.display_number,
               'client_name', o.client_name, 'version_number', h.version_number,
               'still_current', h.superseded_at is null,
               'answered_at', g.answered_at,
               'answered_by_name', (select nullif(btrim(u.full_name), '') from public.users u where u.id = g.answered_by),
               'can_do', g.can_do, 'cannot_do', g.cannot_do, 'discuss', g.discuss,
               'lines', coalesce((select jsonb_agg(jsonb_build_object(
                                    'key', a.line_key, 'title', a.line_title,
                                    'decision', a.decision, 'note', a.note) order by a.line_title)
                                    from public.order_pi_change_answers a where a.handoff_id = h.id), '[]'::jsonb)) as x
        from (select a.handoff_id, max(a.answered_at) as answered_at, max(a.answered_by::text)::uuid as answered_by,
                     count(*) filter (where a.decision = 'can_do') as can_do,
                     count(*) filter (where a.decision = 'cannot_do') as cannot_do,
                     count(*) filter (where a.decision = 'discuss') as discuss
                from public.order_pi_change_answers a group by a.handoff_id) g
        join public.order_operations_handoffs h on h.id = g.handoff_id
        join public.orders o on o.id = h.order_id
       where g.answered_at >= v_now - interval '45 days'
         and (v_is_approver or g.answered_by = v_actor)
         and coalesce(o.is_test_data, false) = false
         and public.can_read_order_detail(o.id)
       order by g.answered_at desc
       limit 30
    ) s;

  -- Orders and Dispatches. Orders: confirmed in the period. Dispatches: moved
  -- to dispatched in the period (date read from the status-change entry).
  with base as (
    select o.id, o.status, o.confirm_date,
           case
             when o.total_product_value is null or o.total_product_value = 'NaN'::numeric then null
             when coalesce(pi.d, 0) <> 0 and pi.g is not null and o.total_product_value = pi.g and pi.st is not null
               then pi.st
             else o.total_product_value end as pv,
           (select min((a.created_at at time zone 'Asia/Kolkata')::date)
              from public.order_activity_log a
             where a.order_id = o.id and a.event_type = 'status_changed'
               and a.payload ->> 'to' = 'dispatched') as dispatched_on
      from public.orders o
      left join lateral (
        select s.gross_product_amount as g, s.discount_amount as d, s.subtotal_after_discount as st
          from public.order_submissions s
         where s.id = coalesce(
                 (select v.submission_id from public.order_pi_versions v
                   where v.order_id = o.id and v.status = 'approved'
                   order by v.version_number desc limit 1),
                 o.source_order_submission_id)) pi on true
     where coalesce(o.is_test_data, false) = false
       and o.status <> 'cancelled'
       and public.can_read_order_detail(o.id)
  )
  select jsonb_build_object(
           'last_month', jsonb_build_object('from', v_last_from, 'to', v_last_to,
             'orders', jsonb_build_object(
               'count', count(*) filter (where confirm_date between v_last_from and v_last_to),
               'value', coalesce(sum(pv) filter (where confirm_date between v_last_from and v_last_to), 0)),
             'dispatches', jsonb_build_object(
               'count', count(*) filter (where status = 'dispatched' and dispatched_on between v_last_from and v_last_to),
               'value', coalesce(sum(pv) filter (where status = 'dispatched' and dispatched_on between v_last_from and v_last_to), 0))),
           'last_six_months', jsonb_build_object('from', v_six_from, 'to', v_last_to,
             'orders', jsonb_build_object(
               'count', count(*) filter (where confirm_date between v_six_from and v_last_to),
               'value', coalesce(sum(pv) filter (where confirm_date between v_six_from and v_last_to), 0)),
             'dispatches', jsonb_build_object(
               'count', count(*) filter (where status = 'dispatched' and dispatched_on between v_six_from and v_last_to),
               'value', coalesce(sum(pv) filter (where status = 'dispatched' and dispatched_on between v_six_from and v_last_to), 0))),
           'gaps', jsonb_build_object(
             'dispatched_without_date', count(*) filter (where status = 'dispatched' and dispatched_on is null),
             'orders_without_value', count(*) filter (where confirm_date between v_six_from and v_last_to and pv is null),
             'no_confirm_date', count(*) filter (where confirm_date is null)))
    into v_periods
    from base;

  return jsonb_build_object(
    'today', v_ist,
    'viewer', jsonb_build_object('is_reviewer', v_is_reviewer, 'is_approver', v_is_approver),
    'pending_changes', v_pending,
    'responses', v_responses,
    'periods', v_periods);
end;
$$;

comment on function public.operations_orders_dashboard() is
  'The Operations dashboard''s own read: revised-PI changes waiting for the calling reviewer to answer, the answers already given (to that reviewer and to whoever approves Orders), and Orders / Dispatches for last month and the last six completed months. Over the Orders the caller may open. 20270401000000.';

revoke execute on function public.operations_orders_dashboard() from public, anon;
grant  execute on function public.operations_orders_dashboard() to authenticated;


-- ═══ 7. Proof (executed on apply) ══════════════════════════════════════════

do $$
declare
  v_old jsonb := jsonb_build_object(
    'submission', jsonb_build_object('due_date', '2026-11-01', 'grand_total', 1000, 'client_name', 'A'),
    'items', jsonb_build_array(
      jsonb_build_object('item_sequence', 'B001', 'product_name', 'Chair', 'quantity', 10, 'sort_order', 0, 'source_row', 32),
      jsonb_build_object('item_sequence', 'B002', 'product_name', 'Table', 'quantity', 2, 'sort_order', 1, 'source_row', 33)));
  v_new jsonb := jsonb_build_object(
    'submission', jsonb_build_object('due_date', '2026-11-15', 'grand_total', 1000.00, 'client_name', 'A'),
    'items', jsonb_build_array(
      jsonb_build_object('item_sequence', 'B001', 'product_name', 'Chair', 'quantity', 12, 'sort_order', 0, 'source_row', 32),
      jsonb_build_object('item_sequence', 'B003', 'product_name', 'Lamp', 'quantity', 1, 'sort_order', 2, 'source_row', 34)));
  v_lines jsonb;
begin
  v_lines := public.order_pi_diff_lines(v_old, v_new);
  -- schedule changed; commercial NOT (1000 = 1000.00); B001 changed; B002 removed; B003 added.
  if jsonb_array_length(v_lines) <> 4 then
    raise exception 'operations dashboard proof: expected 4 changed lines, got %: %', jsonb_array_length(v_lines), v_lines;
  end if;
  if (select array_agg(l ->> 'key' order by ord) from jsonb_array_elements(v_lines) with ordinality t(l, ord))
       <> array['group:schedule', 'item:B001', 'item:B002', 'item:B003'] then
    raise exception 'operations dashboard proof: wrong lines %', v_lines;
  end if;
  if public.order_pi_diff_lines(v_old, v_old) <> '[]'::jsonb then
    raise exception 'operations dashboard proof: identical documents must produce no lines';
  end if;
  if has_function_privilege('anon', 'public.operations_orders_dashboard()', 'EXECUTE')
     or has_function_privilege('anon', 'public.answer_order_pi_changes(uuid, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.order_handoff_change_lines(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.order_pi_diff_lines(jsonb, jsonb)', 'EXECUTE') then
    raise exception 'operations dashboard proof: a function is callable by a role that must not call it';
  end if;
  if has_table_privilege('authenticated', 'public.order_pi_change_answers', 'SELECT') then
    raise exception 'operations dashboard proof: answers must be readable only through the RPC';
  end if;
end;
$$;

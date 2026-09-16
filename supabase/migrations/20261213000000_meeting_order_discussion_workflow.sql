-- Meetings — the order-discussion workflow: one issue, many meetings.
--
-- THE BUSINESS PROBLEM
-- -------------------
-- Sales assigns a task to management: "Order 2041 — customer says the finish is
-- wrong". Management needs that on the next review's agenda in a few taps, and
-- then needs it to STAY on the agenda, with its own continuing history, until
-- somebody actually resolves it. Some issues finish in one meeting; others run
-- through five or six.
--
-- What already existed (20260814000000, 20260831000000, 20261203000000) is the
-- ORDER rail: meeting_orders is the Order as discussed in ONE meeting, and the
-- same Order returns to a later meeting as a NEW row under the same normalised
-- order_number_key. That is right for "what is happening with 2041", and it is
-- the wrong unit for "this particular repair complaint". One Order can carry two
-- unrelated running-order concerns and an after-sales replacement at the same
-- time, and each must keep its own thread.
--
-- WHAT THIS ADDS — THREE TABLES AND ONE COLUMN
--   public.meeting_discussion_items        the PERSISTENT issue. One row for the
--                                         life of the issue, whatever number of
--                                         meetings it passes through. Open or
--                                         Resolved, and nothing else: execution
--                                         states belong to Task Management.
--   public.meeting_discussion_appearances  that issue ON ONE MEETING's agenda.
--                                         One row per (meeting, item), enforced
--                                         by a UNIQUE constraint — which is what
--                                         makes carry-forward idempotent.
--   public.meeting_discussion_events       APPEND-ONLY trail for the issue:
--                                         captured, added to an agenda, carried
--                                         forward, updated, task linked,
--                                         resolved, reopened.
--   meeting_order_evidence.discussion_appearance_id
--                                         one nullable column, so an image
--                                         attached while discussing an ISSUE is
--                                         known to belong to that issue as well
--                                         as to the Order. Nothing else about
--                                         evidence changes: same private bucket,
--                                         same three storage policies, same
--                                         append-only table.
--
-- WHY NOT REUSE meeting_order_items
-- ---------------------------------
-- That table is a SKU line under an Order in ONE meeting (UNIQUE
-- (meeting_order_id, sku_key)), it requires a SKU and a product name, and its
-- status set is open/waiting/resolved. An after-sales complaint has no SKU, must
-- not be forced to invent one, and must not be re-keyed per meeting — the whole
-- point is that the issue is the SAME row next month. Widening that table would
-- have made `sku` nullable, which is the one column that keeps an orphaned SKU
-- history row readable. Same reasoning the evidence migration gave for not
-- widening meeting_update_history.
--
-- WHY NOT REUSE meeting_update_history FOR THE TRAIL
-- --------------------------------------------------
-- Its entry_type is a CHECK shared by six functions and its subject columns are
-- (order_number NOT NULL, sku, product_name). An issue event has a different
-- NOT NULL subject — the discussion item. 20261203000000 made exactly this call
-- for evidence: a new fact gets its own table, and the shared history table is
-- left as it is. The consequence is the one the guide relies on: ISSUE history
-- and GENERAL ORDER history are different tables, so they can never be confused
-- on screen.
--
-- THE TWO CATEGORIES
--   running_order  the order has not shipped: drawing/material approval,
--                  production, QC, packing, dispatch.
--   after_sales    the order has shipped and something came back: repair,
--                  replacement, site damage, wrong item, finish or fitting.
-- A CHECK, not an enum, matching every other module here. `after_sales_tag`
-- (repair / replacement / site_issue / other) is a SECONDARY convenience tag and
-- is refused on a running-order item, so it can never become a third category.
--
-- HOW AN ISSUE REACHES A MEETING
--   1. capture_meeting_discussion_item() — from Task Detail, or from a meeting.
--      With a target meeting the caller may EDIT, it lands on that agenda. With
--      no target it waits in the MEETING INBOX, which is not a table: it is the
--      open items with no appearance anywhere.
--   2. AUTOMATIC CARRY-FORWARD. An AFTER INSERT trigger on public.meetings runs
--      apply_meeting_discussion_carry_forward() in the SAME transaction as the
--      meeting's creation, so a new review cannot exist without its inherited
--      agenda. It adds, for the matching category:
--        * every OPEN item whose most recent earlier appearance was in a meeting
--          of this type held before this one, and
--        * every OPEN Inbox item,
--      each EXACTLY ONCE — ON CONFLICT DO NOTHING against
--      meeting_discussion_appearances_unique_per_meeting. Nothing is copied:
--      earlier updates stay in the earlier meeting's own rows, and this trigger
--      writes only into the new meeting. A completed meeting is never touched,
--      re-run or reopened.
--   3. carry_forward_meeting_discussions() is the same engine as an editor-run
--      RPC, for a meeting created before this migration or a repair. Calling it
--      twice adds nothing the second time.
--
-- COMPLETING A MEETING RESOLVES NOTHING
-- set_meeting_status() is untouched. A completed meeting becomes read-only and
-- its open items are, by that fact alone, eligible for the next one. Only
-- resolve_meeting_discussion_item() moves an item to Resolved, and it requires a
-- note, an actor and a live editable meeting.
--
-- WHAT IS DELIBERATELY NOT BUILT
--   A meeting-series or recurrence model (the existing meeting_type is the
--   relevance key), per-item notifications, priorities, assignees, due dates or
--   any other execution field (Task Management owns all of those), a second
--   evidence bucket, unlinking a task, deleting an event, and any change to the
--   Order rail's own behaviour.
--
-- WHO READS WHAT
-- A meeting's notes belong to that meeting. Every piece of text recorded IN a
-- meeting — an update, a decision, a next review date, a resolution note, a
-- follow-up task's title, evidence — is readable only by somebody who can open
-- that meeting (can_view_meeting), exactly as meeting_update_history is. The
-- issue ROW itself (order, customer, title, details, category, Open/Resolved) is
-- readable a little more widely — by its creator and, while it waits in the
-- Inbox, by the meeting editors who triage it — and for that reason the one
-- meeting-specific column on it, resolution_note, is not granted to any client
-- role at all: the note is read from its 'resolved' trail row, which carries the
-- resolving meeting's visibility. A reopening reason follows the meeting whose
-- resolution it reopens.
--
-- DATA IMPACT
-- Additive only. Three new tables, one nullable column on an existing table, and
-- two new triggers on public.meetings (carry-forward AFTER INSERT; a deletion
-- guard BEFORE DELETE). NO existing row is read, rewritten or deleted; no
-- existing policy, grant, function or trigger is dropped or re-emitted, and
-- add_meeting_order_evidence() keeps its exact signature (§19 asserts it).
-- There is NO backfill: an issue exists only once someone captures it, and
-- inventing discussion items from historical SKU lines would fabricate a business
-- record nobody wrote.
--
-- ROLLBACK / CORRECTIVE FORWARD
-- Forward-only. To retire: drop the two triggers on public.meetings, drop the
-- functions named below, drop the column meeting_order_evidence
-- .discussion_appearance_id, then drop the three tables (events, appearances,
-- items).

-- ═══ 1. The persistent issue ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meeting_discussion_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The two primary categories, and only these two.
  category     text NOT NULL CHECK (category IN ('running_order', 'after_sales')),

  -- A convenience tag that reduces typing on an after-sales row. Never a third
  -- category: the CHECK below refuses it on a running-order item.
  after_sales_tag text CHECK (
    after_sales_tag IS NULL
    OR after_sales_tag IN ('repair', 'replacement', 'site_issue', 'other')
  ),

  -- Free text, exactly as meeting_orders.order_number is free text: Meetings
  -- records the discussion, it does not own the order master. The generated key
  -- is the SAME normalisation meeting_orders uses, which is what lets one screen
  -- show an issue's thread next to the Order's general history.
  order_number     text NOT NULL CHECK (btrim(order_number) <> ''),
  order_number_key text GENERATED ALWAYS AS (upper(btrim(order_number))) STORED,

  customer_name text,

  -- The short line the board shows. `details` is the optional long form.
  title   text NOT NULL CHECK (btrim(title) <> ''),
  details text,

  -- The task this was captured from, when it was captured from one. SET NULL
  -- rather than CASCADE: a deleted task must not take the issue with it. Storing
  -- only the id — never the task's title — is what keeps a meeting viewer who
  -- cannot read that task from learning anything about it.
  source_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,

  -- Two states, on purpose. Pending / Working / Waiting / Blocked are TASK
  -- states and stay in Task Management; a meeting only needs to know whether the
  -- issue still has to be discussed.
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),

  created_by uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- CURRENT resolution state, in the same sense meetings.completed_at is current
  -- state: a reopen clears these three, and the record of the resolution
  -- survives in meeting_discussion_events, which is never cleared.
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES public.users(id),
  resolution_note text,

  -- A resolved issue always says who resolved it, when, and why it is closed; an
  -- open one never claims any of the three.
  CONSTRAINT meeting_discussion_items_resolution_consistent CHECK (
    (state = 'resolved'
       AND resolved_at IS NOT NULL
       AND resolved_by IS NOT NULL
       AND btrim(COALESCE(resolution_note, '')) <> '')
    OR
    (state = 'open'
       AND resolved_at IS NULL
       AND resolved_by IS NULL
       AND resolution_note IS NULL)
  ),

  CONSTRAINT meeting_discussion_items_tag_is_after_sales_only CHECK (
    after_sales_tag IS NULL OR category = 'after_sales'
  )
);

-- Carry-forward's own predicate, and the board's category filter.
CREATE INDEX IF NOT EXISTS meeting_discussion_items_open_by_category_idx
  ON public.meeting_discussion_items (category, created_at)
  WHERE state = 'open';

-- "What else has been raised against this order?" — the same normalised key the
-- Order rail matches on.
CREATE INDEX IF NOT EXISTS meeting_discussion_items_order_key_idx
  ON public.meeting_discussion_items (order_number_key);

CREATE INDEX IF NOT EXISTS meeting_discussion_items_source_task_idx
  ON public.meeting_discussion_items (source_task_id)
  WHERE source_task_id IS NOT NULL;

-- DUPLICATE PREVENTION, in the database rather than in the button.
--
-- Pressing "Add to Meeting" twice on the same task must not produce two issues.
-- capture_meeting_discussion_item() returns the existing open item instead of
-- inserting, and this index is what makes that promise hold under a double
-- submit, two tabs or a retried request. Partial on state = 'open': once an
-- issue is resolved, the same task may legitimately raise a new one.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_discussion_items_one_open_per_task_idx
  ON public.meeting_discussion_items (source_task_id)
  WHERE source_task_id IS NOT NULL AND state = 'open';

DROP TRIGGER IF EXISTS meeting_discussion_items_set_updated_at ON public.meeting_discussion_items;
CREATE TRIGGER meeting_discussion_items_set_updated_at
  BEFORE UPDATE ON public.meeting_discussion_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.meeting_discussion_items IS
  'One business issue on an order, for the whole life of that issue across every meeting it passes through. Open or Resolved only — execution status belongs to Task Management. No client role holds INSERT, UPDATE, DELETE or TRUNCATE; rows arrive and move only through the SECURITY DEFINER functions in 20261213000000.';

-- ═══ 2. The issue on one meeting's agenda ══════════════════════════════════

CREATE TABLE IF NOT EXISTS public.meeting_discussion_appearances (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE is safe and deliberate: a meeting can only be deleted while it is a
  -- draft with no order under review (meetings_prevent_delete_with_content) and
  -- nothing substantive recorded against any issue on it
  -- (meetings_prevent_delete_with_discussion, §17b), so the only rows this can
  -- take are untouched automatic appearances. A deleted draft must hand those
  -- straight back to the carry-forward pool rather than pin them to a meeting
  -- that never happened.
  meeting_id uuid NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,

  -- NO ACTION: nothing deletes an issue, so nothing may take its appearances.
  discussion_item_id uuid NOT NULL REFERENCES public.meeting_discussion_items(id),

  -- The Order's row in THIS meeting, created lazily — the first time evidence is
  -- attached. NULL until then, so creating a meeting does not put every
  -- inherited issue's order on the Order rail (which would also make every new
  -- draft undeletable). SET NULL, and a validation trigger below keeps it inside
  -- this same meeting.
  meeting_order_id uuid REFERENCES public.meeting_orders(id) ON DELETE SET NULL,

  -- Agenda position. Not unique: two writers may land on the same number, and
  -- the board's secondary sort is created_at. Carry-forward preserves the
  -- previous meeting's order.
  agenda_position integer NOT NULL CHECK (agenda_position > 0),

  -- Where this appearance came from, when it was inherited rather than added.
  -- The audit record of one carry-forward, alongside created_by / created_at.
  carried_from_id uuid REFERENCES public.meeting_discussion_appearances(id) ON DELETE SET NULL,

  -- HOW it reached this agenda. 'automatic' is carry-forward (from an earlier
  -- meeting or from the Inbox), which nobody chose; 'manual' is an editor's
  -- deliberate attach or capture. The distinction is what lets a draft raised by
  -- mistake be deleted with its untouched inherited agenda, while a draft that an
  -- editor has put anything on cannot be (§17b).
  placement text NOT NULL DEFAULT 'manual' CHECK (placement IN ('manual', 'automatic')),

  -- THIS meeting's own position on the issue. Never copied from an earlier
  -- meeting: an appearance with no update means the issue was inherited and has
  -- not been discussed yet, which is exactly what the board must be able to say.
  latest_update    text,
  decision         text,
  next_review_date date,

  -- Discussed-today state. Set by the first save that moves anything.
  discussed_at timestamptz,
  discussed_by uuid REFERENCES public.users(id),

  created_by uuid        NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- THE CONSTRAINT THAT MAKES CARRY-FORWARD IDEMPOTENT. Every insert path uses
  -- ON CONFLICT DO NOTHING against it, so a retried meeting creation, a second
  -- manual attach and a re-run of the engine all add the item exactly once.
  CONSTRAINT meeting_discussion_appearances_unique_per_meeting
    UNIQUE (meeting_id, discussion_item_id),

  CONSTRAINT meeting_discussion_appearances_discussed_fields_consistent CHECK (
    (discussed_at IS NULL     AND discussed_by IS NULL)
    OR
    (discussed_at IS NOT NULL AND discussed_by IS NOT NULL)
  )
);

-- The board: this meeting's agenda, in order.
CREATE INDEX IF NOT EXISTS meeting_discussion_appearances_meeting_idx
  ON public.meeting_discussion_appearances (meeting_id, agenda_position, created_at);

-- The issue's own thread: every meeting it has been on.
CREATE INDEX IF NOT EXISTS meeting_discussion_appearances_item_idx
  ON public.meeting_discussion_appearances (discussion_item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS meeting_discussion_appearances_order_idx
  ON public.meeting_discussion_appearances (meeting_order_id)
  WHERE meeting_order_id IS NOT NULL;

DROP TRIGGER IF EXISTS meeting_discussion_appearances_set_updated_at ON public.meeting_discussion_appearances;
CREATE TRIGGER meeting_discussion_appearances_set_updated_at
  BEFORE UPDATE ON public.meeting_discussion_appearances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- An appearance's Order row must belong to the appearance's own meeting.
--
-- A plain column FK cannot say that, and the consequence of it being wrong is
-- that evidence stored under one meeting's Order folder would be readable
-- through another meeting's visibility rules. The only writer is a definer
-- function that looks the Order up BY meeting_id; this trigger is what makes the
-- guarantee structural rather than a habit.
CREATE OR REPLACE FUNCTION public.meeting_discussion_appearance_order_in_meeting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.meeting_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.meeting_orders o
    WHERE o.id = NEW.meeting_order_id AND o.meeting_id = NEW.meeting_id
  ) THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_ORDER_MISMATCH: That order belongs to a different meeting'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.meeting_discussion_appearance_order_in_meeting()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS meeting_discussion_appearance_order_in_meeting_trg
  ON public.meeting_discussion_appearances;
CREATE TRIGGER meeting_discussion_appearance_order_in_meeting_trg
  BEFORE INSERT OR UPDATE OF meeting_order_id, meeting_id
  ON public.meeting_discussion_appearances
  FOR EACH ROW EXECUTE FUNCTION public.meeting_discussion_appearance_order_in_meeting();

COMMENT ON TABLE public.meeting_discussion_appearances IS
  'One persistent discussion item on one meeting''s agenda, with that meeting''s own update, decision and next review date. UNIQUE (meeting_id, discussion_item_id) is what makes automatic carry-forward idempotent. No client role holds INSERT, UPDATE, DELETE or TRUNCATE.';

-- ═══ 3. The issue's append-only trail ══════════════════════════════════════
--
-- One row per thing that happened to the issue. Its NOT NULL subject is the
-- ISSUE (meeting_update_history's is the Order, meeting_activity_log's is the
-- meeting), which is the reason this is a third table and not a widened one.
-- The snapshots — order_number, meeting_title — are why a row still reads
-- correctly after the meeting it names has been deleted as an empty draft.

CREATE TABLE IF NOT EXISTS public.meeting_discussion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  discussion_item_id uuid NOT NULL REFERENCES public.meeting_discussion_items(id),

  -- Nullable + SET NULL: deleting an empty draft must not erase the record that
  -- the item was once inherited into it. The snapshot below keeps the row
  -- readable afterwards.
  meeting_id    uuid REFERENCES public.meetings(id) ON DELETE SET NULL,
  appearance_id uuid REFERENCES public.meeting_discussion_appearances(id) ON DELETE SET NULL,

  order_number  text NOT NULL,
  meeting_title text,

  event_type text NOT NULL CHECK (event_type IN (
    'captured',         -- the issue was raised, from a task or by hand
    'added_to_agenda',  -- an editor put it on a meeting
    'carried_forward',  -- a new meeting inherited it, unresolved
    'update',           -- this meeting's position / decision / next review
    'task_linked',      -- a follow-up task was created or linked
    'resolved',
    'reopened'
  )),

  previous_update text,
  new_update      text,
  previous_state  text CHECK (previous_state IS NULL OR previous_state IN ('open', 'resolved')),
  new_state       text CHECK (new_state      IS NULL OR new_state      IN ('open', 'resolved')),
  previous_review_date date,
  new_review_date      date,

  -- Present on 'task_linked' only. SET NULL so a deleted task does not erase the
  -- record that a task was raised.
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,

  -- The short free line: the resolution note, the reopening reason, the decision
  -- change, which meeting an item was carried from.
  detail text,

  actor_id   uuid        NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The only read this table serves: one issue's trail, newest first.
CREATE INDEX IF NOT EXISTS meeting_discussion_events_item_idx
  ON public.meeting_discussion_events (discussion_item_id, created_at DESC);

-- Per-meeting grouping of an issue's history, and the linked-task list.
CREATE INDEX IF NOT EXISTS meeting_discussion_events_appearance_idx
  ON public.meeting_discussion_events (appearance_id, created_at)
  WHERE appearance_id IS NOT NULL;

-- One task is linked to one appearance once. Linking the same task twice is a
-- no-op rather than a second row, so the "linked tasks" count is honest.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_discussion_events_one_task_link_idx
  ON public.meeting_discussion_events (appearance_id, task_id)
  WHERE event_type = 'task_linked';

COMMENT ON TABLE public.meeting_discussion_events IS
  'Append-only trail of one discussion item: captured, added to an agenda, carried forward, updated, task linked, resolved, reopened. No client role holds INSERT, UPDATE, DELETE or TRUNCATE; rows arrive only from record_meeting_discussion_event(), inside the same transaction as the change they describe. A reopen clears meeting_discussion_items.resolved_* — THIS is where the original resolution survives.';

-- ═══ 4. Evidence: one nullable column ══════════════════════════════════════
--
-- Additive. Every existing evidence row keeps NULL, which reads correctly: it
-- was attached to the Order's discussion, not to a named issue. The bucket, the
-- three storage policies, the table's append-only privileges and
-- add_meeting_order_evidence() are all untouched.

ALTER TABLE public.meeting_order_evidence
  ADD COLUMN IF NOT EXISTS discussion_appearance_id uuid
    REFERENCES public.meeting_discussion_appearances(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS meeting_order_evidence_discussion_idx
  ON public.meeting_order_evidence (discussion_appearance_id, created_at DESC)
  WHERE discussion_appearance_id IS NOT NULL;

COMMENT ON COLUMN public.meeting_order_evidence.discussion_appearance_id IS
  'Set when the image was attached while discussing a specific issue (20261213000000). NULL means it belongs to the Order''s general discussion in that meeting. Never used to build a storage path: the object still lives under its meeting_order_id folder, so every storage policy applies unchanged.';

-- ═══ 5. Visibility predicate ═══════════════════════════════════════════════
--
-- The ISSUE ROW — order, customer, title, details, category, Open/Resolved — is
-- readable by whoever can read a meeting it has been on. Two extra branches, and
-- each is as narrow as its reason:
--
--   * its creator — otherwise the sales employee who raised it from a task can
--     never see whether it is still open. The creator sees the row they wrote,
--     not what any meeting said about it (see can_view_discussion_event).
--   * a meeting EDITOR, manager or admin, WHILE THE ISSUE IS IN THE INBOX (no
--     appearance anywhere) — because the Inbox has no meeting to derive
--     visibility from, and somebody has to triage it. Once an issue is on an
--     agenda, meeting visibility alone decides; 'edit' does not reveal issues on
--     meetings the holder cannot open.
--
-- Plain 'view' grants nothing extra: an ordinary employee sees the issues on the
-- meetings they attended, and nothing else.
CREATE OR REPLACE FUNCTION public.can_view_discussion_item(
  p_item_id uuid,
  p_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.meeting_discussion_items i
    WHERE i.id = p_item_id
      AND (
        i.created_by = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.meeting_discussion_appearances a
          WHERE a.discussion_item_id = i.id
            AND public.can_view_meeting(a.meeting_id, p_user_id)
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM public.meeting_discussion_appearances a
            WHERE a.discussion_item_id = i.id
          )
          AND (
            EXISTS (
              SELECT 1 FROM public.users u
              WHERE u.id = p_user_id AND u.is_active AND u.role = 'admin'
            )
            OR public.resolve_permission(p_user_id, 'meetings', 'edit')
            OR public.resolve_permission(p_user_id, 'meetings', 'manage')
          )
        )
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_view_discussion_item(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_view_discussion_item(uuid, uuid) TO authenticated;

-- ONE TRAIL ROW, and whether this reader may see it.
--
-- A trail row is meeting-specific text — an update, a decision, a follow-up
-- task's title, a resolution note, a reopening reason — so it follows the
-- meeting, never the issue:
--
--   * a row recorded IN a meeting      → whoever can open that meeting;
--   * 'captured'                       → whoever can see the issue row. It carries
--                                        a fixed phrase and the source task's id,
--                                        never the task's title;
--   * 'reopened' (taken outside a      → whoever can open the meeting whose
--     meeting)                           resolution it reopens, because it quotes
--                                        that resolution's note;
--   * anything else with no meeting    → nobody. That is an 'added_to_agenda' or
--                                        'carried_forward' row detached when an
--                                        untouched draft was deleted: its title
--                                        snapshot names a meeting that no longer
--                                        exists and was never held.
CREATE OR REPLACE FUNCTION public.can_view_discussion_event(
  p_item_id    uuid,
  p_meeting_id uuid,
  p_event_type text,
  p_created_at timestamptz,
  p_user_id    uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p_user_id IS NOT NULL AND CASE
    WHEN p_meeting_id IS NOT NULL THEN
      public.can_view_meeting(p_meeting_id, p_user_id)
    WHEN p_event_type = 'captured' THEN
      public.can_view_discussion_item(p_item_id, p_user_id)
    WHEN p_event_type = 'reopened' THEN
      COALESCE((
        SELECT public.can_view_meeting(r.meeting_id, p_user_id)
        FROM public.meeting_discussion_events r
        WHERE r.discussion_item_id = p_item_id
          AND r.event_type = 'resolved'
          AND r.meeting_id IS NOT NULL
          AND r.created_at <= p_created_at
        ORDER BY r.created_at DESC
        LIMIT 1
      ), false)
    ELSE false
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.can_view_discussion_event(uuid, uuid, text, timestamptz, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_view_discussion_event(uuid, uuid, text, timestamptz, uuid) TO authenticated;

-- ═══ 6. Row Level Security ═════════════════════════════════════════════════
--
-- No policy here is `USING (true)`, and none of the three tables has a write
-- policy for anybody: every mutation goes through a definer function that writes
-- the row and its trail entry in ONE transaction. Privileges are revoked as well
-- as policies withheld, so a permissive policy added later by mistake still
-- could not write, and TRUNCATE — which no policy governs — cannot erase a trail.

ALTER TABLE public.meeting_discussion_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_discussion_appearances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_discussion_events      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meeting_discussion_items_select" ON public.meeting_discussion_items;
CREATE POLICY "meeting_discussion_items_select" ON public.meeting_discussion_items
  FOR SELECT TO authenticated
  USING (public.can_view_discussion_item(id, auth.uid()));

DROP POLICY IF EXISTS "meeting_discussion_appearances_select" ON public.meeting_discussion_appearances;
CREATE POLICY "meeting_discussion_appearances_select" ON public.meeting_discussion_appearances
  FOR SELECT TO authenticated
  USING (public.can_view_meeting(meeting_id, auth.uid()));

DROP POLICY IF EXISTS "meeting_discussion_events_select" ON public.meeting_discussion_events;
CREATE POLICY "meeting_discussion_events_select" ON public.meeting_discussion_events
  FOR SELECT TO authenticated
  USING (public.can_view_discussion_event(discussion_item_id, meeting_id, event_type, created_at, auth.uid()));

-- The parent module gate every meeting table carries (20260905000000).
DROP POLICY IF EXISTS "meeting_discussion_items_module_entry_gate" ON public.meeting_discussion_items;
CREATE POLICY "meeting_discussion_items_module_entry_gate" ON public.meeting_discussion_items
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.module_entry_open('meetings'))
  WITH CHECK (public.module_entry_open('meetings'));

DROP POLICY IF EXISTS "meeting_discussion_appearances_module_entry_gate" ON public.meeting_discussion_appearances;
CREATE POLICY "meeting_discussion_appearances_module_entry_gate" ON public.meeting_discussion_appearances
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.module_entry_open('meetings'))
  WITH CHECK (public.module_entry_open('meetings'));

DROP POLICY IF EXISTS "meeting_discussion_events_module_entry_gate" ON public.meeting_discussion_events;
CREATE POLICY "meeting_discussion_events_module_entry_gate" ON public.meeting_discussion_events
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (public.module_entry_open('meetings'))
  WITH CHECK (public.module_entry_open('meetings'));

REVOKE ALL ON public.meeting_discussion_items       FROM anon;
REVOKE ALL ON public.meeting_discussion_appearances FROM anon;
REVOKE ALL ON public.meeting_discussion_events      FROM anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_discussion_items       FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_discussion_appearances FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_discussion_events      FROM authenticated;

-- The issue row is readable column by column, and resolution_note is not one of
-- the columns. It is the only meeting-specific text on the row, and the row is
-- readable by people (the creator, Inbox triage) who may not open the meeting
-- that resolved it. The note is read from its 'resolved' trail row instead, which
-- can_view_discussion_event() gates on that meeting. REVOKE first: production's
-- default privileges grant table-wide SELECT, which would make any column grant
-- meaningless.
REVOKE SELECT ON public.meeting_discussion_items FROM authenticated;
GRANT SELECT (
  id, category, after_sales_tag, order_number, order_number_key, customer_name,
  title, details, source_task_id, state, created_by, created_at, updated_at,
  resolved_at, resolved_by
) ON public.meeting_discussion_items TO authenticated;
GRANT SELECT ON public.meeting_discussion_appearances TO authenticated;
GRANT SELECT ON public.meeting_discussion_events      TO authenticated;

-- ═══ 7. Internal writers ═══════════════════════════════════════════════════

-- Append one trail row. Not granted to any client role: a client that could call
-- this directly could fabricate a resolution.
CREATE OR REPLACE FUNCTION public.record_meeting_discussion_event(
  p_item_id       uuid,
  p_meeting_id    uuid,
  p_appearance_id uuid,
  p_order_number  text,
  p_meeting_title text,
  p_event_type    text,
  p_actor_id      uuid,
  p_previous_update text DEFAULT NULL,
  p_new_update      text DEFAULT NULL,
  p_previous_state  text DEFAULT NULL,
  p_new_state       text DEFAULT NULL,
  p_previous_review date DEFAULT NULL,
  p_new_review      date DEFAULT NULL,
  p_task_id         uuid DEFAULT NULL,
  p_detail          text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.meeting_discussion_events (
    discussion_item_id, meeting_id, appearance_id, order_number, meeting_title,
    event_type, previous_update, new_update, previous_state, new_state,
    previous_review_date, new_review_date, task_id, detail, actor_id
  ) VALUES (
    p_item_id, p_meeting_id, p_appearance_id, p_order_number, p_meeting_title,
    p_event_type, p_previous_update, p_new_update, p_previous_state, p_new_state,
    p_previous_review, p_new_review, p_task_id, p_detail, p_actor_id
  )
  ON CONFLICT DO NOTHING;
$$;

REVOKE EXECUTE ON FUNCTION public.record_meeting_discussion_event(
  uuid, uuid, uuid, text, text, text, uuid, text, text, text, text, date, date, uuid, text
) FROM public, anon, authenticated;

-- Authorize a write against one appearance, and lock the rows behind it.
--
-- One place, so "who may record against this issue" is answered once. It LOCKS
-- the appearance and its issue (FOR UPDATE) and returns the caller's id; each
-- writer then reads the three rows it needs, which are already locked and cannot
-- move underneath it. Returning a scalar rather than a row of composites is
-- deliberate: plpgsql's multi-target `SELECT … INTO` accepts only scalar targets,
-- so a convenience function handing back four records would not compile at every
-- call site.
--
-- `assert_meeting_editor` is what refuses a completed meeting, a view-only user
-- and a meeting the caller has nothing to do with.
CREATE OR REPLACE FUNCTION public.assert_meeting_discussion_editor(p_appearance_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_appearance public.meeting_discussion_appearances;
BEGIN
  SELECT * INTO v_appearance
  FROM public.meeting_discussion_appearances WHERE id = p_appearance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_MISSING: This discussion item is no longer on this meeting'
      USING ERRCODE = '42501';
  END IF;

  -- Locked here so a concurrent resolve and update serialise rather than race.
  PERFORM 1 FROM public.meeting_discussion_items
  WHERE id = v_appearance.discussion_item_id FOR UPDATE;

  -- Refuses a completed meeting, so an editor must reopen the meeting before
  -- correcting anything recorded in it.
  RETURN public.assert_meeting_editor(v_appearance.meeting_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_meeting_discussion_editor(uuid)
  FROM public, anon, authenticated;

-- Internal: the three rows behind an appearance, read after it is authorized and
-- locked. A macro, written out at each call site rather than hidden in a helper
-- for the reason above.
--   SELECT * INTO v_appearance FROM public.meeting_discussion_appearances WHERE id = …;
--   SELECT * INTO v_item       FROM public.meeting_discussion_items       WHERE id = …;
--   SELECT * INTO v_meeting    FROM public.meetings                       WHERE id = …;

-- ═══ 7b. Which review an issue belongs in ════════════════════════════════════
--
-- The ONLY relationship between an issue and a meeting, and the one the module
-- already has: `meeting_type`. A Running Order issue belongs in a New Order
-- review, an After Sales issue in a Repair Order review. Every path that puts an
-- issue on an agenda — capture with a target, manual attach, and carry-forward —
-- asks this one function, so the three can never disagree about what "the right
-- meeting" means. IMMUTABLE: it reads nothing.
CREATE OR REPLACE FUNCTION public.meeting_discussion_category_for_type(p_meeting_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE p_meeting_type
           WHEN 'new_order'    THEN 'running_order'
           WHEN 'repair_order' THEN 'after_sales'
         END;
$$;

REVOKE EXECUTE ON FUNCTION public.meeting_discussion_category_for_type(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.meeting_discussion_category_for_type(text) TO authenticated;

-- ═══ 8. Capture ════════════════════════════════════════════════════════════
--
-- The Task Detail quick sheet, and the meeting's own "New issue". Returns jsonb
-- rather than a row because the caller has to be told WHICH of three things
-- happened: a new issue was created and put on a meeting, a new issue is waiting
-- in the Inbox, or the task already had an open issue and that one is being
-- shown instead.
--
-- AUTHORIZATION, in two independent halves:
--   * the MEETINGS half — module entry to raise an issue into the Inbox, and
--     can_edit_meeting for a named target meeting. Nothing here widens a
--     permission: an Inbox item is on nobody's agenda until an editor attaches
--     it.
--   * the TASK half — the caller must have a real relationship to the source
--     task (creator, assignee, or admin), checked independently. This function
--     is SECURITY DEFINER and reads public.tasks with RLS bypassed, so without
--     this predicate a caller could pin any task id in the company to an issue
--     and then read it back.
CREATE OR REPLACE FUNCTION public.capture_meeting_discussion_item(
  p_category       text,
  p_order_number   text,
  p_title          text,
  p_meeting_id     uuid DEFAULT NULL,
  p_customer_name  text DEFAULT NULL,
  p_after_sales_tag text DEFAULT NULL,
  p_details        text DEFAULT NULL,
  p_source_task_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_item       public.meeting_discussion_items;
  v_appearance public.meeting_discussion_appearances;
  v_title      text := btrim(COALESCE(p_title, ''));
  v_order      text := btrim(COALESCE(p_order_number, ''));
  v_tag        text := NULLIF(btrim(COALESCE(p_after_sales_tag, '')), '');
  v_created    boolean := false;
  v_on_agenda  boolean := false;
  v_latest_meeting uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT public.module_entry_open('meetings') THEN
    RAISE EXCEPTION 'MEETING_FORBIDDEN: You do not have access to Meetings'
      USING ERRCODE = '42501';
  END IF;

  IF p_category IS NULL OR p_category NOT IN ('running_order', 'after_sales') THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_CATEGORY_INVALID: Choose either Running Order or After Sales'
      USING ERRCODE = '22023';
  END IF;

  IF v_tag IS NOT NULL AND v_tag NOT IN ('repair', 'replacement', 'site_issue', 'other') THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_TAG_INVALID: Unknown after-sales tag "%"', v_tag
      USING ERRCODE = '22023';
  END IF;

  IF v_tag IS NOT NULL AND p_category <> 'after_sales' THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_TAG_INVALID: An after-sales tag only applies to an After Sales issue'
      USING ERRCODE = '22023';
  END IF;

  IF v_order = '' THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_ORDER_REQUIRED: An order or repair reference is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_title = '' THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_TITLE_REQUIRED: A short issue line is required'
      USING ERRCODE = '22023';
  END IF;

  -- The task half of the authorization. One message for "no such task" and "not
  -- your task": a caller must not be able to probe which task ids exist.
  IF p_source_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tasks t
    WHERE t.id = p_source_task_id
      AND (
        t.created_by  = v_uid
        OR t.assigned_to = v_uid
        OR EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = v_uid AND u.is_active AND u.role = 'admin'
        )
      )
  ) THEN
    RAISE EXCEPTION 'MEETING_TASK_NOT_LINKABLE: That task cannot be added to a meeting'
      USING ERRCODE = '42501';
  END IF;

  -- DUPLICATE PREVENTION. Pressing the button twice, or two tabs racing, must
  -- reach the SAME issue. The row is locked so a concurrent caller waits here
  -- rather than colliding on the unique index below.
  IF p_source_task_id IS NOT NULL THEN
    SELECT * INTO v_item
    FROM public.meeting_discussion_items
    WHERE source_task_id = p_source_task_id AND state = 'open'
    FOR UPDATE;
  END IF;

  IF v_item.id IS NULL THEN
    INSERT INTO public.meeting_discussion_items (
      category, after_sales_tag, order_number, customer_name,
      title, details, source_task_id, created_by
    ) VALUES (
      p_category, v_tag, v_order,
      NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
      v_title,
      NULLIF(btrim(COALESCE(p_details, '')), ''),
      p_source_task_id, v_uid
    )
    RETURNING * INTO v_item;
    v_created := true;

    PERFORM public.record_meeting_discussion_event(
      v_item.id, NULL, NULL, v_item.order_number, NULL, 'captured', v_uid,
      p_new_state := 'open',
      p_task_id   := p_source_task_id,
      p_detail    := CASE WHEN p_source_task_id IS NULL
                          THEN 'Issue raised'
                          ELSE 'Issue raised from a task' END
    );
  END IF;

  IF p_meeting_id IS NOT NULL THEN
    v_appearance := public.attach_meeting_discussion_item(p_meeting_id, v_item.id);
  END IF;

  -- Where the issue actually is, for an issue that already existed and was not
  -- placed by this call. Without this an existing issue already on a meeting
  -- would be reported as waiting in the Inbox.
  --
  -- `on_agenda` says whether it is on ANY agenda; `meeting_id` names the most
  -- recent one THIS CALLER CAN OPEN, and is NULL otherwise. A task's assignee who
  -- presses the button again learns that the issue is already on a meeting, never
  -- which meeting they are not part of.
  IF v_appearance.id IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.meeting_discussion_appearances a
      WHERE a.discussion_item_id = v_item.id
    ) INTO v_on_agenda;

    SELECT a.meeting_id INTO v_latest_meeting
    FROM public.meeting_discussion_appearances a
    JOIN public.meetings m ON m.id = a.meeting_id
    WHERE a.discussion_item_id = v_item.id
      AND public.can_view_meeting(a.meeting_id, v_uid)
    ORDER BY m.meeting_date DESC, m.created_at DESC
    LIMIT 1;
  ELSE
    v_on_agenda := true;
  END IF;

  RETURN jsonb_build_object(
    'item_id',       v_item.id,
    'status',        CASE WHEN v_created THEN 'created' ELSE 'existing' END,
    'appearance_id', v_appearance.id,
    'meeting_id',    COALESCE(v_appearance.meeting_id, v_latest_meeting),
    'category',      v_item.category,
    'order_number',  v_item.order_number,
    'title',         v_item.title,
    'on_agenda',     v_on_agenda,
    'in_inbox',      NOT v_on_agenda
  );
EXCEPTION
  WHEN unique_violation THEN
    -- The one-open-issue-per-task index fired: a concurrent caller inserted
    -- first. Hand back THEIR row rather than an error the user cannot act on.
    SELECT * INTO v_item
    FROM public.meeting_discussion_items
    WHERE source_task_id = p_source_task_id AND state = 'open';
    IF v_item.id IS NULL THEN RAISE; END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.meeting_discussion_appearances a
      WHERE a.discussion_item_id = v_item.id
    ) INTO v_on_agenda;
    SELECT a.meeting_id INTO v_latest_meeting
    FROM public.meeting_discussion_appearances a
    JOIN public.meetings m ON m.id = a.meeting_id
    WHERE a.discussion_item_id = v_item.id
      AND public.can_view_meeting(a.meeting_id, v_uid)
    ORDER BY m.meeting_date DESC, m.created_at DESC
    LIMIT 1;
    RETURN jsonb_build_object(
      'item_id', v_item.id, 'status', 'existing', 'appearance_id', NULL,
      'meeting_id', v_latest_meeting, 'category', v_item.category,
      'order_number', v_item.order_number, 'title', v_item.title,
      'on_agenda', v_on_agenda,
      'in_inbox', NOT v_on_agenda
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.capture_meeting_discussion_item(text, text, text, uuid, text, text, text, uuid)
  FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.capture_meeting_discussion_item(text, text, text, uuid, text, text, text, uuid)
  TO authenticated;

-- ═══ 9. Attach an issue to a meeting ═══════════════════════════════════════
--
-- The Meeting Inbox's "Add to this meeting", and the second half of capture.
-- Idempotent: calling it again returns the appearance that already exists.
CREATE OR REPLACE FUNCTION public.attach_meeting_discussion_item(
  p_meeting_id uuid,
  p_item_id    uuid
)
RETURNS public.meeting_discussion_appearances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid;
  v_item       public.meeting_discussion_items;
  v_meeting    public.meetings;
  v_appearance public.meeting_discussion_appearances;
BEGIN
  v_uid := public.assert_meeting_editor(p_meeting_id);

  SELECT * INTO v_meeting FROM public.meetings WHERE id = p_meeting_id;

  SELECT * INTO v_item FROM public.meeting_discussion_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_MISSING: This discussion item no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF v_item.state <> 'open' THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_RESOLVED: "%" is resolved. Reopen it before putting it back on an agenda.', v_item.title
      USING ERRCODE = '42501';
  END IF;

  -- The category decides the review, for a manual attach exactly as for
  -- carry-forward. Without this a Running Order issue could be put on a Repair
  -- Order review by hand, and would then carry forward into a DIFFERENT series of
  -- meetings from the one it was discussed in — its history split across two.
  IF v_item.category IS DISTINCT FROM public.meeting_discussion_category_for_type(v_meeting.meeting_type) THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_CATEGORY_MISMATCH: A % issue can only be added to a % review',
      CASE v_item.category WHEN 'running_order' THEN 'Running Order' ELSE 'After Sales' END,
      CASE v_item.category WHEN 'running_order' THEN 'New Order' ELSE 'Repair Order' END
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.meeting_discussion_appearances (
    meeting_id, discussion_item_id, agenda_position, created_by
  ) VALUES (
    p_meeting_id, p_item_id,
    COALESCE((
      SELECT max(agenda_position) FROM public.meeting_discussion_appearances
      WHERE meeting_id = p_meeting_id
    ), 0) + 1,
    v_uid
  )
  ON CONFLICT ON CONSTRAINT meeting_discussion_appearances_unique_per_meeting DO NOTHING
  RETURNING * INTO v_appearance;

  -- Already on this agenda: return the existing row, silently. Repeating the
  -- action must not read as a failure and must not make a second entry.
  IF v_appearance.id IS NULL THEN
    SELECT * INTO v_appearance
    FROM public.meeting_discussion_appearances
    WHERE meeting_id = p_meeting_id AND discussion_item_id = p_item_id;
    RETURN v_appearance;
  END IF;

  PERFORM public.record_meeting_discussion_event(
    v_item.id, p_meeting_id, v_appearance.id, v_item.order_number, v_meeting.title,
    'added_to_agenda', v_uid,
    p_detail := format('Added to %s', v_meeting.title)
  );

  RETURN v_appearance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.attach_meeting_discussion_item(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.attach_meeting_discussion_item(uuid, uuid) TO authenticated;

-- ═══ 10. This meeting's update ═════════════════════════════════════════════
--
-- Every value parameter defaults to NULL and NULL means "leave alone", the same
-- contract save_meeting_order_update() has: this door cannot blank a field it
-- was not asked about. Blanking is therefore its own explicit flag —
-- p_clear_decision and p_clear_next_review — never an empty string, so "the
-- editor deleted the decision" and "the editor did not touch it" cannot be
-- confused. A save that moves nothing writes no trail row — the trail records
-- decisions, not clicks.
CREATE OR REPLACE FUNCTION public.save_meeting_discussion_update(
  p_appearance_id     uuid,
  p_update            text    DEFAULT NULL,
  p_decision          text    DEFAULT NULL,
  p_next_review_date  date    DEFAULT NULL,
  p_clear_next_review boolean DEFAULT false,
  p_clear_decision    boolean DEFAULT false
)
RETURNS public.meeting_discussion_appearances
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid      uuid;
  v_before   public.meeting_discussion_appearances;
  v_after    public.meeting_discussion_appearances;
  v_item     public.meeting_discussion_items;
  v_meeting  public.meetings;
  v_update   text;
  v_decision text;
  v_detail   text;
BEGIN
  v_uid := public.assert_meeting_discussion_editor(p_appearance_id);

  SELECT * INTO v_before
  FROM public.meeting_discussion_appearances WHERE id = p_appearance_id;
  SELECT * INTO v_item
  FROM public.meeting_discussion_items WHERE id = v_before.discussion_item_id;
  SELECT * INTO v_meeting
  FROM public.meetings WHERE id = v_before.meeting_id;

  IF v_item.state <> 'open' THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_RESOLVED: "%" is resolved. Reopen it to record anything further.', v_item.title
      USING ERRCODE = '42501';
  END IF;

  v_update   := NULLIF(btrim(COALESCE(p_update, '')), '');
  v_decision := NULLIF(btrim(COALESCE(p_decision, '')), '');

  UPDATE public.meeting_discussion_appearances
     SET latest_update = COALESCE(v_update, latest_update),
         decision      = CASE
                           WHEN p_clear_decision THEN NULL
                           ELSE COALESCE(v_decision, decision)
                         END,
         next_review_date = CASE
                              WHEN p_clear_next_review THEN NULL
                              ELSE COALESCE(p_next_review_date, next_review_date)
                            END,
         -- Discussed-today. Set by the first save that moves something and never
         -- cleared: a meeting cannot un-discuss an item.
         discussed_at = CASE
                          WHEN v_update IS NOT NULL OR v_decision IS NOT NULL
                            THEN COALESCE(discussed_at, now())
                          ELSE discussed_at
                        END,
         discussed_by = CASE
                          WHEN v_update IS NOT NULL OR v_decision IS NOT NULL
                            THEN COALESCE(discussed_by, v_uid)
                          ELSE discussed_by
                        END
   WHERE id = p_appearance_id
  RETURNING * INTO v_after;

  IF v_after.decision IS DISTINCT FROM v_before.decision THEN
    v_detail := CASE
                  WHEN v_after.decision IS NULL THEN 'Decision cleared'
                  ELSE format('Decision recorded: %s', v_after.decision)
                END;
  END IF;

  IF v_update IS NOT NULL
     OR v_after.decision         IS DISTINCT FROM v_before.decision
     OR v_after.next_review_date IS DISTINCT FROM v_before.next_review_date THEN
    PERFORM public.record_meeting_discussion_event(
      v_item.id, v_meeting.id, v_after.id, v_item.order_number, v_meeting.title,
      'update', v_uid,
      p_previous_update := v_before.latest_update,
      p_new_update      := v_update,
      p_previous_review := CASE WHEN v_after.next_review_date IS DISTINCT FROM v_before.next_review_date
                                THEN v_before.next_review_date END,
      p_new_review      := CASE WHEN v_after.next_review_date IS DISTINCT FROM v_before.next_review_date
                                THEN v_after.next_review_date END,
      p_detail          := v_detail
    );
  END IF;

  RETURN v_after;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_meeting_discussion_update(uuid, text, text, date, boolean, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.save_meeting_discussion_update(uuid, text, text, date, boolean, boolean) TO authenticated;

-- ═══ 11. Resolve ═══════════════════════════════════════════════════════════
--
-- Resolving is done IN a meeting, by an editor of that meeting, while it is
-- live. That is what makes "who closed this, when, and in which review" a fact
-- rather than a recollection. A note is mandatory: an issue that runs through
-- five meetings and then simply disappears is the failure this workflow exists
-- to prevent.
CREATE OR REPLACE FUNCTION public.resolve_meeting_discussion_item(
  p_appearance_id uuid,
  p_note          text
)
RETURNS public.meeting_discussion_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid;
  v_appearance public.meeting_discussion_appearances;
  v_item      public.meeting_discussion_items;
  v_meeting   public.meetings;
  v_note      text;
  v_after     public.meeting_discussion_items;
BEGIN
  v_uid := public.assert_meeting_discussion_editor(p_appearance_id);

  SELECT * INTO v_appearance
  FROM public.meeting_discussion_appearances WHERE id = p_appearance_id;
  SELECT * INTO v_item
  FROM public.meeting_discussion_items WHERE id = v_appearance.discussion_item_id;
  SELECT * INTO v_meeting
  FROM public.meetings WHERE id = v_appearance.meeting_id;

  -- Already resolved: return it unchanged rather than write a second resolution.
  IF v_item.state = 'resolved' THEN
    RETURN v_item;
  END IF;

  v_note := NULLIF(btrim(COALESCE(p_note, '')), '');
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_NOTE_REQUIRED: Say in one line how this was resolved'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.meeting_discussion_items
     SET state           = 'resolved',
         resolved_at     = now(),
         resolved_by     = v_uid,
         resolution_note = v_note
   WHERE id = v_item.id
  RETURNING * INTO v_after;

  -- Resolving is also the last discussion of it.
  UPDATE public.meeting_discussion_appearances
     SET discussed_at = COALESCE(discussed_at, now()),
         discussed_by = COALESCE(discussed_by, v_uid)
   WHERE id = v_appearance.id;

  PERFORM public.record_meeting_discussion_event(
    v_item.id, v_meeting.id, v_appearance.id, v_item.order_number, v_meeting.title,
    'resolved', v_uid,
    p_previous_state := 'open',
    p_new_state      := 'resolved',
    p_detail         := v_note
  );

  RETURN v_after;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_meeting_discussion_item(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.resolve_meeting_discussion_item(uuid, text) TO authenticated;

-- ═══ 12. Reopen ════════════════════════════════════════════════════════════
--
-- Keyed on the ITEM, not on an appearance: the meeting that resolved it is
-- usually completed by the time anyone discovers the repair did not hold, and a
-- completed meeting must stay read-only. Authorization is therefore "you may
-- edit one of the meetings this issue has been on", with completed meetings
-- allowed for that test only — nothing in the completed meeting changes.
--
-- The reopen CLEARS resolved_at / resolved_by / resolution_note, because the
-- CHECK constraint requires an open issue to claim none of them. The original
-- resolution survives as the 'resolved' event, and this reopen's own event
-- carries that note forward in previous_update so the two read together.
CREATE OR REPLACE FUNCTION public.reopen_meeting_discussion_item(
  p_item_id uuid,
  p_reason  text
)
RETURNS public.meeting_discussion_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_item   public.meeting_discussion_items;
  v_after  public.meeting_discussion_items;
  v_reason text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_item FROM public.meeting_discussion_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_MISSING: This discussion item no longer exists'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.meeting_discussion_appearances a
    WHERE a.discussion_item_id = p_item_id
      AND public.can_edit_meeting(a.meeting_id, v_uid, true)
  ) THEN
    RAISE EXCEPTION 'MEETING_FORBIDDEN: You do not have permission to reopen this discussion item'
      USING ERRCODE = '42501';
  END IF;

  IF v_item.state = 'open' THEN
    RETURN v_item;
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'MEETING_DISCUSSION_REASON_REQUIRED: Say in one line why this is being reopened'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.meeting_discussion_items
     SET state           = 'open',
         resolved_at     = NULL,
         resolved_by     = NULL,
         resolution_note = NULL
   WHERE id = p_item_id
  RETURNING * INTO v_after;

  PERFORM public.record_meeting_discussion_event(
    p_item_id, NULL, NULL, v_item.order_number, NULL, 'reopened', v_uid,
    p_previous_update := v_item.resolution_note,
    p_previous_state  := 'resolved',
    p_new_state       := 'open',
    p_detail          := v_reason
  );

  RETURN v_after;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reopen_meeting_discussion_item(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.reopen_meeting_discussion_item(uuid, text) TO authenticated;

-- ═══ 13. Link a follow-up task ═════════════════════════════════════════════
--
-- Meetings stores the RELATIONSHIP only. Assignee, due date, priority, working
-- state, completion and task activity all stay in Task Management, which remains
-- the execution source of truth — this module never mirrors them.
--
-- The same task predicate link_meeting_item_task() uses, for the same reason:
-- this function reads public.tasks with RLS bypassed, and the trail row it
-- writes would otherwise disclose the title of any task whose id was guessed.
CREATE OR REPLACE FUNCTION public.link_meeting_discussion_task(
  p_appearance_id uuid,
  p_task_id       uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid;
  v_appearance public.meeting_discussion_appearances;
  v_item       public.meeting_discussion_items;
  v_meeting    public.meetings;
  v_title      text;
BEGIN
  v_uid := public.assert_meeting_discussion_editor(p_appearance_id);

  SELECT * INTO v_appearance
  FROM public.meeting_discussion_appearances WHERE id = p_appearance_id;
  SELECT * INTO v_item
  FROM public.meeting_discussion_items WHERE id = v_appearance.discussion_item_id;
  SELECT * INTO v_meeting
  FROM public.meetings WHERE id = v_appearance.meeting_id;

  SELECT t.title INTO v_title
  FROM public.tasks t
  WHERE t.id = p_task_id
    AND (
      t.created_by  = v_uid
      OR t.assigned_to = v_uid
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = v_uid AND u.is_active AND u.role = 'admin'
      )
    );

  IF v_title IS NULL THEN
    RAISE EXCEPTION 'MEETING_TASK_NOT_LINKABLE: That task cannot be linked to this discussion item'
      USING ERRCODE = '42501';
  END IF;

  -- ON CONFLICT DO NOTHING inside record_meeting_discussion_event(), against
  -- meeting_discussion_events_one_task_link_idx: linking the same task twice is
  -- a no-op, not a second row.
  PERFORM public.record_meeting_discussion_event(
    v_item.id, v_meeting.id, v_appearance.id, v_item.order_number, v_meeting.title,
    'task_linked', v_uid,
    p_task_id := p_task_id,
    p_detail  := format('Follow-up task: %s', v_title)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.link_meeting_discussion_task(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.link_meeting_discussion_task(uuid, uuid) TO authenticated;

-- ═══ 14. The Order folder, created on demand ═══════════════════════════════
--
-- Evidence lives in the private meeting-evidence bucket under
-- {meeting_order_id}/{uuid}.{ext}, and every one of that bucket's three storage
-- policies authorizes on that first path segment. So an issue that is about to
-- carry an image needs its Order's row in THIS meeting to exist first — and the
-- browser needs its id before it can upload.
--
-- Created here, lazily, rather than during carry-forward: an inherited agenda of
-- twelve issues must not silently put twelve orders on the Order rail, and a
-- draft raised by mistake must stay deletable (meetings_prevent_delete_with_
-- content refuses a meeting that has any order row).
--
-- Idempotent, and it reuses the Order rail's own uniqueness: if the Order is
-- already under review in this meeting, that row is adopted rather than
-- duplicated.
CREATE OR REPLACE FUNCTION public.ensure_meeting_discussion_order(p_appearance_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid;
  v_appearance public.meeting_discussion_appearances;
  v_item       public.meeting_discussion_items;
  v_meeting    public.meetings;
  v_order_id   uuid;
  v_order_no   text;
  v_type       text;
BEGIN
  v_uid := public.assert_meeting_discussion_editor(p_appearance_id);

  SELECT * INTO v_appearance
  FROM public.meeting_discussion_appearances WHERE id = p_appearance_id;
  SELECT * INTO v_item
  FROM public.meeting_discussion_items WHERE id = v_appearance.discussion_item_id;
  SELECT * INTO v_meeting
  FROM public.meetings WHERE id = v_appearance.meeting_id;

  IF v_appearance.meeting_order_id IS NOT NULL THEN
    RETURN v_appearance.meeting_order_id;
  END IF;

  -- A running-order issue belongs with the New Order review's orders; an
  -- after-sales issue with the Repair Order review's. The same mapping
  -- carry-forward uses, read the other way round.
  v_type := CASE v_item.category WHEN 'running_order' THEN 'new_order' ELSE 'repair_order' END;

  INSERT INTO public.meeting_orders (
    meeting_id, order_number, order_type, customer_name, created_by
  ) VALUES (
    v_meeting.id, v_item.order_number, v_type, v_item.customer_name, v_uid
  )
  ON CONFLICT ON CONSTRAINT meeting_orders_unique_per_meeting DO NOTHING
  RETURNING id, order_number INTO v_order_id, v_order_no;

  IF v_order_id IS NULL THEN
    SELECT id, order_number INTO v_order_id, v_order_no
    FROM public.meeting_orders
    WHERE meeting_id = v_meeting.id
      AND order_number_key = upper(btrim(v_item.order_number));
  ELSE
    -- The Order rail's own trail, written the way add_meeting_order() writes it.
    PERFORM public.record_meeting_history(
      v_meeting.id, v_order_id, NULL,
      v_order_no, NULL, NULL, 'order_added', v_uid,
      p_detail := 'Order added while discussing an issue'
    );
  END IF;

  UPDATE public.meeting_discussion_appearances
     SET meeting_order_id = v_order_id
   WHERE id = p_appearance_id;

  RETURN v_order_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ensure_meeting_discussion_order(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.ensure_meeting_discussion_order(uuid) TO authenticated;

-- ═══ 15. Record an uploaded image against an issue ═════════════════════════
--
-- The same three promises add_meeting_order_evidence() makes, kept the same way:
-- Storage and PostgreSQL cannot share a transaction, so the browser uploads
-- first and then calls this; NOTHING is recorded unless the object really exists
-- in the private bucket, under this Order's folder, uploaded by the caller; and
-- type and size come from Storage's own metadata, never from the caller.
--
-- A separate function rather than a fourth parameter on the existing one:
-- re-emitting add_meeting_order_evidence() with a defaulted parameter would
-- leave PostgREST with two candidate overloads for a three-argument call
-- (PGRST203), and dropping its three-argument form would change a shipped RPC
-- for a feature that does not need it to change.
CREATE OR REPLACE FUNCTION public.add_meeting_discussion_evidence(
  p_appearance_id uuid,
  p_storage_path  text,
  p_file_name     text DEFAULT NULL
)
RETURNS public.meeting_order_evidence
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid;
  v_appearance public.meeting_discussion_appearances;
  v_item       public.meeting_discussion_items;
  v_meeting    public.meetings;
  v_order_id   uuid;
  v_order_no   text;
  v_path       text := btrim(COALESCE(p_storage_path, ''));
  v_mime       text;
  v_size       bigint;
  v_name       text;
  v_row        public.meeting_order_evidence;
BEGIN
  v_uid := public.assert_meeting_discussion_editor(p_appearance_id);

  SELECT * INTO v_appearance
  FROM public.meeting_discussion_appearances WHERE id = p_appearance_id;
  SELECT * INTO v_item
  FROM public.meeting_discussion_items WHERE id = v_appearance.discussion_item_id;
  SELECT * INTO v_meeting
  FROM public.meetings WHERE id = v_appearance.meeting_id;

  -- The folder the browser uploaded into. Resolved rather than trusted: this is
  -- also what makes the call work if the client skipped the ensure step.
  v_order_id := public.ensure_meeting_discussion_order(p_appearance_id);

  SELECT order_number INTO v_order_no FROM public.meeting_orders WHERE id = v_order_id;

  IF v_path !~ ('^' || v_order_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$') THEN
    RAISE EXCEPTION 'MEETING_EVIDENCE_PATH_INVALID: That image is not stored under this order'
      USING ERRCODE = '42501';
  END IF;

  SELECT o.metadata ->> 'mimetype', NULLIF(o.metadata ->> 'size', '')::bigint
    INTO v_mime, v_size
  FROM storage.objects o
  WHERE o.bucket_id = 'meeting-evidence'
    AND o.name = v_path
    AND (o.owner_id = v_uid::text OR o.owner = v_uid);

  -- One message for "never uploaded" and "uploaded by somebody else".
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_EVIDENCE_NOT_STORED: The image did not finish uploading, so nothing was attached'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_mime IS NULL OR v_mime NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'MEETING_EVIDENCE_TYPE_INVALID: Only JPG, PNG or WEBP images can be attached'
      USING ERRCODE = '22023';
  END IF;

  IF v_size IS NULL OR v_size <= 0 OR v_size > 10485760 THEN
    RAISE EXCEPTION 'MEETING_EVIDENCE_TOO_LARGE: Images must be 10 MB or smaller'
      USING ERRCODE = '22023';
  END IF;

  v_name := left(regexp_replace(btrim(COALESCE(p_file_name, '')), '[[:cntrl:]/]', '', 'g'), 120);
  IF btrim(v_name) = '' THEN
    v_name := 'image';
  END IF;

  INSERT INTO public.meeting_order_evidence (
    meeting_id, meeting_order_id, order_number,
    storage_path, file_name, mime_type, size_bytes, uploaded_by,
    discussion_appearance_id
  ) VALUES (
    v_meeting.id, v_order_id, v_order_no,
    v_path, v_name, v_mime, v_size, v_uid,
    p_appearance_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'MEETING_EVIDENCE_DUPLICATE: That image is already attached'
      USING ERRCODE = '23505';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_meeting_discussion_evidence(uuid, text, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.add_meeting_discussion_evidence(uuid, text, text) TO authenticated;

-- ═══ 16. Automatic carry-forward ═══════════════════════════════════════════
--
-- The engine. One function, two callers: the AFTER INSERT trigger on
-- public.meetings (§17), and an editor-run RPC (§18) for a meeting created
-- before this migration or for a repair.
--
-- WHAT IT ADDS to meeting M of type T, for the matching category:
--   1. every OPEN item whose MOST RECENT appearance in a meeting of type T held
--      BEFORE M exists — "held before" by meeting_date then created_at, the same
--      clock earlierMeetingOrders() uses, so a later meeting is never treated as
--      an earlier one;
--   2. every OPEN Meeting Inbox item of that category — an item with no
--      appearance anywhere, which is what the Inbox IS. There is no inbox table
--      and nothing to sweep: the absence of an appearance is the state.
--
-- WHAT IT NEVER DOES
--   * copy an earlier update, decision, review date or image — an inherited
--     appearance starts empty, which is precisely how the board can say "not
--     discussed yet";
--   * write to any meeting other than M, so no completed meeting is altered and
--     none is reopened;
--   * add an item twice — ON CONFLICT DO NOTHING against the UNIQUE constraint,
--     which is also why calling it again is free.
--
-- ORDERING: inherited items keep their previous agenda order, and Inbox items
-- follow them.
CREATE OR REPLACE FUNCTION public.apply_meeting_discussion_carry_forward(
  p_meeting_id uuid,
  p_actor_id   uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_meeting    public.meetings;
  v_category   text;
  v_position   integer;
  v_added      integer := 0;
  v_appearance public.meeting_discussion_appearances;
  r            record;
BEGIN
  SELECT * INTO v_meeting FROM public.meetings WHERE id = p_meeting_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  -- A completed meeting is read-only, including to this.
  IF v_meeting.status = 'completed' THEN RETURN 0; END IF;

  v_category := public.meeting_discussion_category_for_type(v_meeting.meeting_type);

  -- A meeting type with no category is not a relationship anything can be matched
  -- on. Nothing is added; Inbox items stay in the Inbox for manual attachment.
  IF v_category IS NULL THEN RETURN 0; END IF;

  SELECT COALESCE(max(agenda_position), 0) INTO v_position
  FROM public.meeting_discussion_appearances WHERE meeting_id = p_meeting_id;

  FOR r IN
    WITH ranked AS (
      SELECT a.id            AS source_appearance_id,
             a.discussion_item_id,
             a.agenda_position AS source_position,
             row_number() OVER (
               PARTITION BY a.discussion_item_id
               ORDER BY m.meeting_date DESC, m.created_at DESC
             ) AS rn
      FROM public.meeting_discussion_appearances a
      JOIN public.meetings m                       ON m.id = a.meeting_id
      JOIN public.meeting_discussion_items i       ON i.id = a.discussion_item_id
      WHERE i.state = 'open'
        AND i.category = v_category
        AND m.id <> p_meeting_id
        AND m.meeting_type = v_meeting.meeting_type
        AND (m.meeting_date, m.created_at) < (v_meeting.meeting_date, v_meeting.created_at)
    )
    SELECT discussion_item_id, source_appearance_id, source_position
    FROM ranked
    WHERE rn = 1
    UNION ALL
    SELECT i.id, NULL::uuid, NULL::integer
    FROM public.meeting_discussion_items i
    WHERE i.state = 'open'
      AND i.category = v_category
      AND NOT EXISTS (
        SELECT 1 FROM public.meeting_discussion_appearances a
        WHERE a.discussion_item_id = i.id
      )
      -- Only into a meeting dated ON OR AFTER the day the issue was raised (IST,
      -- the calendar meeting dates are entered in). A meeting back-dated to last
      -- month is a record of last month; an issue raised today was never on it,
      -- so it stays in the Inbox rather than being written into that history.
      AND (i.created_at AT TIME ZONE 'Asia/Kolkata')::date <= v_meeting.meeting_date
    ORDER BY 3 NULLS LAST, 1
  LOOP
    v_position := v_position + 1;

    INSERT INTO public.meeting_discussion_appearances (
      meeting_id, discussion_item_id, agenda_position, carried_from_id, placement, created_by
    ) VALUES (
      p_meeting_id, r.discussion_item_id, v_position, r.source_appearance_id, 'automatic', p_actor_id
    )
    ON CONFLICT ON CONSTRAINT meeting_discussion_appearances_unique_per_meeting DO NOTHING
    RETURNING * INTO v_appearance;

    -- Already on this agenda. Nothing written, nothing said, and the position
    -- number it would have taken is simply not used.
    IF v_appearance.id IS NULL THEN
      v_position := v_position - 1;
      CONTINUE;
    END IF;

    v_added := v_added + 1;

    PERFORM public.record_meeting_discussion_event(
      r.discussion_item_id, p_meeting_id, v_appearance.id,
      (SELECT order_number FROM public.meeting_discussion_items WHERE id = r.discussion_item_id),
      v_meeting.title,
      CASE WHEN r.source_appearance_id IS NULL THEN 'added_to_agenda' ELSE 'carried_forward' END,
      p_actor_id,
      p_detail := CASE
        WHEN r.source_appearance_id IS NULL
          THEN format('Brought in from the Meeting Inbox into %s', v_meeting.title)
        ELSE format('Still open — carried forward into %s', v_meeting.title)
      END
    );
  END LOOP;

  RETURN v_added;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_meeting_discussion_carry_forward(uuid, uuid)
  FROM public, anon, authenticated;

-- ═══ 17. …on creation, in the same transaction ═════════════════════════════
--
-- A trigger rather than a step in the browser, for the reason meetings_log_
-- creation() is one: being a trigger is what makes it non-optional. A meeting
-- cannot come into existence without its inherited agenda, a client cannot
-- suppress it, and a retried INSERT cannot produce a second copy of anything
-- (§16's ON CONFLICT DO NOTHING, and a retry that creates a second MEETING
-- simply gets its own agenda).
--
-- NEW.created_by, not auth.uid(): the INSERT policy pins created_by to the
-- caller, and reading the row keeps this correct if a service-role path ever
-- inserts one.
CREATE OR REPLACE FUNCTION public.meetings_carry_forward_discussions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.apply_meeting_discussion_carry_forward(NEW.id, NEW.created_by);
  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

REVOKE EXECUTE ON FUNCTION public.meetings_carry_forward_discussions()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS meetings_carry_forward_discussions_trg ON public.meetings;
CREATE TRIGGER meetings_carry_forward_discussions_trg
  AFTER INSERT ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.meetings_carry_forward_discussions();

-- ═══ 18. …and on demand ════════════════════════════════════════════════════
--
-- For a meeting raised before this migration existed, or after an item was
-- reopened while a live meeting was already open. Editor-only, and calling it
-- twice adds nothing the second time.
CREATE OR REPLACE FUNCTION public.carry_forward_meeting_discussions(p_meeting_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := public.assert_meeting_editor(p_meeting_id);
  RETURN public.apply_meeting_discussion_carry_forward(p_meeting_id, v_uid);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.carry_forward_meeting_discussions(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.carry_forward_meeting_discussions(uuid) TO authenticated;

-- ═══ 17b. A draft that holds a discussion cannot be deleted ═════════════════
--
-- meetings_delete lets the creator discard a DRAFT raised by mistake, and
-- meetings_prevent_delete_with_content refuses once an Order is under review in
-- it. A discussion needs the same protection, because the database lets an
-- editor work a draft: without this, deleting it would cascade away that
-- meeting's recorded update, decision and next review date, and leave its
-- resolution attached to no meeting at all.
--
-- What still may go with a mistaken draft is exactly what nobody did: an
-- AUTOMATIC appearance (carry-forward, from an earlier meeting or the Inbox)
-- with nothing recorded against it. Everything else is substantive and refuses:
--   * a MANUAL appearance — an editor chose to put the issue on this agenda;
--   * an update, a decision, a next review date, or Discussed Today;
--   * an Order folder or any evidence tagged to the issue here;
--   * any 'update', 'task_linked', 'resolved' or 'reopened' trail row in this
--     meeting — so a decision that was recorded and then cleared still counts.
-- Agenda position is not in the list because nothing can change it: it is set
-- when the appearance is created and no function edits it.
CREATE OR REPLACE FUNCTION public.meetings_prevent_delete_with_discussion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.meeting_discussion_appearances a
    WHERE a.meeting_id = OLD.id
      AND (
        a.placement <> 'automatic'
        OR a.latest_update    IS NOT NULL
        OR a.decision         IS NOT NULL
        OR a.next_review_date IS NOT NULL
        OR a.discussed_at     IS NOT NULL
        OR a.meeting_order_id IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM public.meeting_order_evidence ev
          WHERE ev.discussion_appearance_id = a.id
        )
        OR EXISTS (
          SELECT 1 FROM public.meeting_discussion_events e
          WHERE e.appearance_id = a.id
            AND e.event_type IN ('update', 'task_linked', 'resolved', 'reopened')
        )
      )
  ) OR EXISTS (
    SELECT 1 FROM public.meeting_discussion_events e
    WHERE e.meeting_id = OLD.id
      AND e.event_type IN ('update', 'task_linked', 'resolved', 'reopened')
  ) THEN
    RAISE EXCEPTION 'MEETING_HAS_DISCUSSION: Issues have already been discussed in this meeting, so it cannot be deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.meetings_prevent_delete_with_discussion()
  FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS meetings_prevent_delete_with_discussion_trg ON public.meetings;
CREATE TRIGGER meetings_prevent_delete_with_discussion_trg
  BEFORE DELETE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.meetings_prevent_delete_with_discussion();

-- ═══ 18b. The Meeting Inbox, read by the database ════════════════════════════
--
-- "In the Inbox" means NO appearance on ANY meeting. A browser cannot compute
-- that: it only receives the appearances on meetings it may open, so an issue
-- sitting on somebody else's agenda would look unclaimed to it — and could then
-- be put on a second live meeting. This function answers the question with RLS
-- bypassed for the "any appearance anywhere" test only, and returns just the
-- issues this caller may see (can_view_discussion_item). It returns issue-row
-- columns only; resolution_note is not among them, and an open issue has none.
CREATE OR REPLACE FUNCTION public.list_meeting_discussion_inbox()
RETURNS TABLE (
  id               uuid,
  category         text,
  after_sales_tag  text,
  order_number     text,
  order_number_key text,
  customer_name    text,
  title            text,
  details          text,
  source_task_id   uuid,
  state            text,
  created_by       uuid,
  created_at       timestamptz,
  updated_at       timestamptz,
  resolved_at      timestamptz,
  resolved_by      uuid,
  created_by_name  text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT public.module_entry_open('meetings') THEN
    RAISE EXCEPTION 'MEETING_FORBIDDEN: You do not have access to Meetings'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT i.id, i.category, i.after_sales_tag, i.order_number, i.order_number_key,
         i.customer_name, i.title, i.details, i.source_task_id, i.state,
         i.created_by, i.created_at, i.updated_at, i.resolved_at, i.resolved_by,
         u.full_name
  FROM public.meeting_discussion_items i
  LEFT JOIN public.users u ON u.id = i.created_by
  WHERE i.state = 'open'
    AND NOT EXISTS (
      SELECT 1 FROM public.meeting_discussion_appearances a
      WHERE a.discussion_item_id = i.id
    )
    AND public.can_view_discussion_item(i.id, v_uid)
  ORDER BY i.created_at DESC, i.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.list_meeting_discussion_inbox() FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.list_meeting_discussion_inbox() TO authenticated;

-- ═══ 19. Assertions ═══════════════════════════════════════════════════════
--
-- Read-only. Each needle is one the named object itself contains, so a partially
-- applied migration fails here rather than looking successful.

DO $$
DECLARE
  v_bad   text;
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'meeting_discussion_items',
    'meeting_discussion_appearances',
    'meeting_discussion_events'
  ] LOOP
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = ('public.' || v_table)::regclass) THEN
      RAISE EXCEPTION '% must have RLS enabled', v_table;
    END IF;

    -- Readable, and nothing else: the only permissive policy is SELECT.
    SELECT string_agg(p.polname, ', ') INTO v_bad
    FROM pg_policy p
    WHERE p.polrelid = ('public.' || v_table)::regclass
      AND p.polpermissive
      AND p.polcmd <> 'r';
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION '% has a permissive write policy: %', v_table, v_bad;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = ('public.' || v_table)::regclass
        AND p.polname = v_table || '_module_entry_gate'
        AND NOT p.polpermissive
        AND p.polcmd = '*'
    ) THEN
      RAISE EXCEPTION '% is missing its RESTRICTIVE module entry gate', v_table;
    END IF;

    IF has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'TRUNCATE') THEN
      RAISE EXCEPTION 'authenticated still holds a write privilege on %', v_table;
    END IF;

    IF NOT has_any_column_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION 'authenticated cannot read %', v_table;
    END IF;
  END LOOP;

  -- A meeting's notes follow the meeting. The one meeting-specific column on the
  -- issue row is not readable by any client role; the rest of the row is.
  IF has_column_privilege('authenticated', 'public.meeting_discussion_items', 'resolution_note', 'SELECT')
     OR has_column_privilege('anon', 'public.meeting_discussion_items', 'resolution_note', 'SELECT') THEN
    RAISE EXCEPTION 'a client role can read meeting_discussion_items.resolution_note directly';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.meeting_discussion_items', 'title', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated cannot read an issue title';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = 'public.meeting_discussion_events'::regclass
      AND p.polname = 'meeting_discussion_events_select'
      AND pg_get_expr(p.polqual, p.polrelid) LIKE '%can_view_discussion_event%'
  ) THEN
    RAISE EXCEPTION 'meeting_discussion_events is not gated per trail row';
  END IF;

  IF pg_get_functiondef('public.can_view_discussion_event(uuid,uuid,text,timestamptz,uuid)'::regprocedure)
     NOT LIKE '%can_view_meeting(p_meeting_id%' THEN
    RAISE EXCEPTION 'can_view_discussion_event does not gate meeting rows on the meeting';
  END IF;

  -- A meeting-edit grant reveals only Inbox issues, never issues on meetings the
  -- holder cannot open.
  v_bad := pg_get_functiondef('public.can_view_discussion_item(uuid,uuid)'::regprocedure);
  IF position('NOT EXISTS' IN v_bad) = 0
     OR position('NOT EXISTS' IN v_bad)
        > position('resolve_permission(p_user_id, ''meetings'', ''edit'')' IN v_bad) THEN
    RAISE EXCEPTION 'can_view_discussion_item lets a meetings edit grant see issues outside the Inbox';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.meetings'::regclass
      AND tgname = 'meetings_prevent_delete_with_discussion_trg'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'a draft holding a discussion can be deleted: the guard is missing';
  END IF;

  -- Duplicate prevention, the two rules the whole workflow leans on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.meeting_discussion_appearances'::regclass
      AND conname  = 'meeting_discussion_appearances_unique_per_meeting'
      AND contype  = 'u'
  ) THEN
    RAISE EXCEPTION 'one item can appear twice in one meeting: the UNIQUE constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.meeting_discussion_items'::regclass
      AND c.relname = 'meeting_discussion_items_one_open_per_task_idx'
      AND i.indisunique
      AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'one task could raise two open issues: the partial unique index is missing';
  END IF;

  -- The category and state rules are the database's, not the browser's.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.meeting_discussion_items'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%running_order%after_sales%'
  ) THEN
    RAISE EXCEPTION 'meeting_discussion_items does not constrain its category';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.meeting_discussion_items'::regclass
      AND conname = 'meeting_discussion_items_resolution_consistent'
  ) THEN
    RAISE EXCEPTION 'a resolved issue could exist with no note, actor or time';
  END IF;

  -- Carry-forward is attached to creation, and is the trigger's only job.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.meetings'::regclass
      AND tgname = 'meetings_carry_forward_discussions_trg'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'carry-forward is not attached to meeting creation';
  END IF;

  -- Every write path authorizes before it writes.
  FOREACH v_table IN ARRAY ARRAY[
    'public.save_meeting_discussion_update(uuid,text,text,date,boolean,boolean)',
    'public.resolve_meeting_discussion_item(uuid,text)',
    'public.link_meeting_discussion_task(uuid,uuid)',
    'public.ensure_meeting_discussion_order(uuid)',
    'public.add_meeting_discussion_evidence(uuid,text,text)'
  ] LOOP
    IF pg_get_functiondef(v_table::regprocedure) NOT LIKE '%assert_meeting_discussion_editor%' THEN
      RAISE EXCEPTION '% does not authorize the caller', v_table;
    END IF;
  END LOOP;

  IF pg_get_functiondef('public.attach_meeting_discussion_item(uuid,uuid)'::regprocedure)
     NOT LIKE '%assert_meeting_editor%' THEN
    RAISE EXCEPTION 'attach_meeting_discussion_item does not authorize the caller';
  END IF;

  -- Category ↔ review type is enforced on BOTH placing paths.
  IF pg_get_functiondef('public.attach_meeting_discussion_item(uuid,uuid)'::regprocedure)
     NOT LIKE '%meeting_discussion_category_for_type%'
     OR pg_get_functiondef('public.apply_meeting_discussion_carry_forward(uuid,uuid)'::regprocedure)
     NOT LIKE '%meeting_discussion_category_for_type%' THEN
    RAISE EXCEPTION 'a placing path does not check the category against the review type';
  END IF;

  IF public.meeting_discussion_category_for_type('new_order') IS DISTINCT FROM 'running_order'
     OR public.meeting_discussion_category_for_type('repair_order') IS DISTINCT FROM 'after_sales'
     OR public.meeting_discussion_category_for_type('something_else') IS NOT NULL THEN
    RAISE EXCEPTION 'meeting_discussion_category_for_type maps review types incorrectly';
  END IF;

  IF pg_get_functiondef('public.carry_forward_meeting_discussions(uuid)'::regprocedure)
     NOT LIKE '%assert_meeting_editor%' THEN
    RAISE EXCEPTION 'carry_forward_meeting_discussions does not authorize the caller';
  END IF;

  IF pg_get_functiondef('public.reopen_meeting_discussion_item(uuid,text)'::regprocedure)
     NOT LIKE '%can_edit_meeting%' THEN
    RAISE EXCEPTION 'reopen_meeting_discussion_item does not authorize the caller';
  END IF;

  -- The functions no client may ever call directly.
  FOREACH v_table IN ARRAY ARRAY[
    'public.record_meeting_discussion_event(uuid,uuid,uuid,text,text,text,uuid,text,text,text,text,date,date,uuid,text)',
    'public.apply_meeting_discussion_carry_forward(uuid,uuid)',
    'public.meetings_prevent_delete_with_discussion()'
  ] LOOP
    IF has_function_privilege('authenticated', v_table, 'EXECUTE')
       OR has_function_privilege('anon', v_table, 'EXECUTE') THEN
      RAISE EXCEPTION 'a client role can execute %', v_table;
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY[
    'public.capture_meeting_discussion_item(text,text,text,uuid,text,text,text,uuid)',
    'public.attach_meeting_discussion_item(uuid,uuid)',
    'public.save_meeting_discussion_update(uuid,text,text,date,boolean,boolean)',
    'public.resolve_meeting_discussion_item(uuid,text)',
    'public.reopen_meeting_discussion_item(uuid,text)',
    'public.link_meeting_discussion_task(uuid,uuid)',
    'public.ensure_meeting_discussion_order(uuid)',
    'public.add_meeting_discussion_evidence(uuid,text,text)',
    'public.carry_forward_meeting_discussions(uuid)',
    'public.list_meeting_discussion_inbox()'
  ] LOOP
    IF has_function_privilege('anon', v_table, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', v_table;
    END IF;
    IF NOT has_function_privilege('authenticated', v_table, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated cannot execute %', v_table;
    END IF;
  END LOOP;

  -- Evidence gained one nullable column and lost nothing.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'meeting_order_evidence'
      AND column_name  = 'discussion_appearance_id'
      AND is_nullable  = 'YES'
  ) THEN
    RAISE EXCEPTION 'meeting_order_evidence.discussion_appearance_id is missing or not nullable';
  END IF;

  IF has_table_privilege('authenticated', 'public.meeting_order_evidence', 'INSERT')
     OR has_table_privilege('authenticated', 'public.meeting_order_evidence', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.meeting_order_evidence', 'DELETE') THEN
    RAISE EXCEPTION 'evidence stopped being append-only';
  END IF;

  -- The three-argument add_meeting_order_evidence() is untouched, so the Order
  -- rail's own evidence path still works exactly as it did.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'add_meeting_order_evidence'
      AND pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_storage_path text, p_file_name text'
  ) THEN
    RAISE EXCEPTION 'add_meeting_order_evidence(uuid, text, text) is no longer intact';
  END IF;
END $$;

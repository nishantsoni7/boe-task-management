-- BOE Meetings — structured order-review meetings (Phase 1 MVP).
--
-- WHAT THIS IS
-- ------------
-- BOE runs two recurring review meetings — New Order Review and Repair Order
-- Review — where the team walks order by order, SKU by SKU, records what moved
-- since last time, and either sets the next follow-up or turns the discussion
-- into a task. This migration is the storage and authorization for exactly
-- that, and nothing wider: there is no generic meeting-management model here,
-- no agenda engine, no minutes requirement, no recurrence.
--
-- SIX TABLES
--   meetings                — the review session
--   meeting_attendees       — who was in it (references public.users; there is
--                             no second employee directory)
--   meeting_orders          — one order/repair reference discussed in it
--   meeting_order_items     — one SKU/product line under that order
--   meeting_update_history  — APPEND-ONLY record of every update ever entered
--   meeting_activity_log    — APPEND-ONLY meeting lifecycle trail (created,
--                             started, completed, reopened). Kept separate from
--                             the update history on purpose — see §5b.
--
-- THE RULE THIS FILE EXISTS TO ENFORCE
-- ------------------------------------
-- An update is never lost and never rewritten. meeting_order_items and
-- meeting_orders therefore have NO UPDATE policy and NO DELETE policy for
-- anyone, including admins. Every mutation goes through a SECURITY DEFINER
-- function that writes the row and its history entry in ONE transaction, so a
-- value cannot move without the trail moving with it. This is the same shape
-- Order Requests uses (20260708000000) and Assets & Access uses
-- (20260722000000/20260724000000) — not a new pattern.
--
-- meeting_update_history itself has an INSERT policy that no client can
-- satisfy and no UPDATE/DELETE policy at all: rows arrive only from the
-- definer functions below, and nothing can edit or erase them afterwards.
--
-- DELIBERATELY NOT BUILT
--   Notifications, comments, attachments, recurrence, calendar links, audio,
--   AI summaries, analytics, or an Orders/ERP integration. `order_number` is
--   free text on purpose — Meetings does not own an order master and must not
--   pretend to.

-- ═══ 1. meetings ═══════════════════════════════════════════════════════════

CREATE TABLE public.meetings (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Phase 1 supports exactly two review types. A CHECK rather than an enum,
  -- matching every other module here: adding a third type later is a one-line
  -- migration instead of an enum rewrite.
  meeting_type text        NOT NULL CHECK (meeting_type IN ('new_order', 'repair_order')),
  meeting_date date        NOT NULL,

  -- Generated from type + date on creation, then freely editable. Stored, not
  -- derived, because the moment a user edits it the derivation is wrong.
  title        text        NOT NULL CHECK (btrim(title) <> ''),

  -- Who runs the meeting. Kept even if they are later deactivated, so a past
  -- meeting still reads correctly.
  lead_id      uuid        NOT NULL REFERENCES public.users(id),

  status       text        NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft', 'in_progress', 'completed')),

  -- One short optional note. NOT minutes: a meeting can always be completed
  -- without it.
  note         text,

  created_by   uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  completed_at timestamptz,
  completed_by uuid        REFERENCES public.users(id),

  -- A completed meeting always says who completed it and when; a live one
  -- never claims either.
  CONSTRAINT meetings_completion_fields_consistent CHECK (
    (status = 'completed'  AND completed_at IS NOT NULL AND completed_by IS NOT NULL)
    OR
    (status <> 'completed' AND completed_at IS NULL     AND completed_by IS NULL)
  )
);

CREATE INDEX meetings_status_date_idx ON public.meetings (status, meeting_date DESC);
CREATE INDEX meetings_date_idx        ON public.meetings (meeting_date DESC);
CREATE INDEX meetings_lead_idx        ON public.meetings (lead_id);
CREATE INDEX meetings_created_by_idx  ON public.meetings (created_by);

DROP TRIGGER IF EXISTS meetings_set_updated_at ON public.meetings;
CREATE TRIGGER meetings_set_updated_at
  BEFORE UPDATE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══ 2. meeting_attendees ══════════════════════════════════════════════════

CREATE TABLE public.meeting_attendees (
  meeting_id uuid        NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES public.users(id)    ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);

-- "Which meetings was I in?" is the employee's entire view of this module, and
-- it is also evaluated inside the meetings SELECT policy for every row.
CREATE INDEX meeting_attendees_user_idx ON public.meeting_attendees (user_id);

-- ═══ 3. meeting_orders ═════════════════════════════════════════════════════

CREATE TABLE public.meeting_orders (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid        NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,

  -- Free text. An order number here may be a confirmed BOE order, a repair
  -- reference, or something written on a pad this morning — Meetings records
  -- the discussion, it does not validate the order master.
  order_number text        NOT NULL CHECK (btrim(order_number) <> ''),
  -- Normalised match key. Generated (not trigger-maintained) so the uniqueness
  -- below and the spreadsheet import can never disagree about what "the same
  -- order" means. upper(btrim(...)) is IMMUTABLE, which a generated column
  -- requires.
  order_number_key text    GENERATED ALWAYS AS (upper(btrim(order_number))) STORED,

  order_type   text        NOT NULL CHECK (order_type IN ('new_order', 'repair_order')),

  customer_name           text,
  expected_dispatch_date  date,

  position     text        NOT NULL DEFAULT 'on_track'
                           CHECK (position IN ('on_track', 'attention', 'at_risk', 'closed')),

  latest_update    text,
  next_review_date date,
  remarks          text,

  created_by   uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- The import's matching key, and the reason the same order cannot be added
  -- to one meeting twice.
  CONSTRAINT meeting_orders_unique_per_meeting UNIQUE (meeting_id, order_number_key)
);

CREATE INDEX meeting_orders_meeting_idx      ON public.meeting_orders (meeting_id);
-- Order number search across meetings ("where has 2041 been discussed?").
CREATE INDEX meeting_orders_number_key_idx   ON public.meeting_orders (order_number_key);
CREATE INDEX meeting_orders_next_review_idx  ON public.meeting_orders (next_review_date)
  WHERE next_review_date IS NOT NULL;

DROP TRIGGER IF EXISTS meeting_orders_set_updated_at ON public.meeting_orders;
CREATE TRIGGER meeting_orders_set_updated_at
  BEFORE UPDATE ON public.meeting_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══ 4. meeting_order_items ════════════════════════════════════════════════
--
-- The row the meeting actually moves through. Only sku and product_name are
-- required: the fastest valid update is "latest_update + status (+ a date when
-- one is needed)", and a schema that demanded a stage, an owner and a quantity
-- for every line would be a schema that gets filled with junk.

CREATE TABLE public.meeting_order_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_order_id uuid        NOT NULL REFERENCES public.meeting_orders(id) ON DELETE CASCADE,

  sku              text        NOT NULL CHECK (btrim(sku) <> ''),
  sku_key          text        GENERATED ALWAYS AS (upper(btrim(sku))) STORED,
  product_name     text        NOT NULL CHECK (btrim(product_name) <> ''),

  quantity         numeric(12,2) CHECK (quantity IS NULL OR quantity >= 0),
  current_stage    text,
  latest_update    text,
  issue            text,
  -- Mirrors departments.department_key / users.team. Text, not a FK: a
  -- department renamed in Control Center must not rewrite what a past meeting
  -- recorded.
  responsible_department text,
  next_follow_up_date    date,

  status           text        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'waiting', 'resolved')),

  -- Task Management stays the execution source of truth. SET NULL rather than
  -- CASCADE: a deleted task must not take the SKU discussion with it.
  linked_task_id   uuid        REFERENCES public.tasks(id) ON DELETE SET NULL,
  linked_task_at   timestamptz,
  linked_task_by   uuid        REFERENCES public.users(id),

  created_by       uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meeting_order_items_unique_sku_per_order UNIQUE (meeting_order_id, sku_key)
);

CREATE INDEX meeting_order_items_order_idx ON public.meeting_order_items (meeting_order_id);

-- The Follow-ups screen's only query: everything still open with a date on it,
-- oldest first. Partial, because a resolved line is never a follow-up.
CREATE INDEX meeting_order_items_follow_up_idx
  ON public.meeting_order_items (next_follow_up_date)
  WHERE next_follow_up_date IS NOT NULL AND status <> 'resolved';

CREATE INDEX meeting_order_items_department_idx ON public.meeting_order_items (responsible_department)
  WHERE responsible_department IS NOT NULL;

-- "Which discussion produced this task?" — the reverse lookup from Task
-- Management back into the meeting.
CREATE INDEX meeting_order_items_task_idx ON public.meeting_order_items (linked_task_id)
  WHERE linked_task_id IS NOT NULL;

DROP TRIGGER IF EXISTS meeting_order_items_set_updated_at ON public.meeting_order_items;
CREATE TRIGGER meeting_order_items_set_updated_at
  BEFORE UPDATE ON public.meeting_order_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ═══ 5. meeting_update_history ═════════════════════════════════════════════
--
-- One row per save. The snapshots (order_number, sku, product_name) are why
-- the trail survives its subjects: a history row still reads correctly after
-- the SKU line or the order it described has been removed, which is exactly
-- when a reader most needs it.

CREATE TABLE public.meeting_update_history (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The meeting source. CASCADE is safe: a meeting can only be deleted while
  -- it is an empty draft (see meetings_prevent_delete_with_content below), so
  -- there is never history to lose.
  meeting_id uuid        NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,

  -- Nullable + SET NULL so removing a mistyped line never erases the decisions
  -- recorded against it.
  meeting_order_id      uuid REFERENCES public.meeting_orders(id)      ON DELETE SET NULL,
  meeting_order_item_id uuid REFERENCES public.meeting_order_items(id) ON DELETE SET NULL,

  order_number text NOT NULL,
  sku          text,
  product_name text,

  entry_type text NOT NULL CHECK (entry_type IN (
    'order_added',    -- an order was brought into this meeting
    'order_update',   -- order-level position / overall update / next review
    'item_added',     -- a SKU line was added
    'item_update',    -- the ordinary SKU update
    'task_linked',    -- a task was created from this line
    'import'          -- the row arrived through the spreadsheet import
  )),

  -- Before/after for each of the three things a reviewer cares about. NULL on
  -- both sides means "this save did not touch it".
  previous_update      text,
  new_update           text,
  previous_status      text,
  new_status           text,
  previous_follow_up_date date,
  new_follow_up_date      date,

  -- Free-form supporting line: the position change, the linked task title, the
  -- import batch note. Never a substitute for the columns above.
  detail     text,

  actor_id   uuid        NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meeting_update_history_item_idx
  ON public.meeting_update_history (meeting_order_item_id, created_at DESC);
CREATE INDEX meeting_update_history_order_idx
  ON public.meeting_update_history (meeting_order_id, created_at DESC);
CREATE INDEX meeting_update_history_meeting_idx
  ON public.meeting_update_history (meeting_id, created_at DESC);

-- ═══ 5b. meeting_activity_log ══════════════════════════════════════════════
--
-- The meeting's own LIFECYCLE trail: created, started, completed, reopened,
-- completed again. Separate from meeting_update_history on purpose, and the
-- separation is the design decision worth stating.
--
-- meeting_update_history answers "what did we say about this SKU?". Its rows
-- are anchored to an order and usually to a product line, and `order_number` is
-- NOT NULL because a row that cannot name its subject is unreadable. A meeting
-- lifecycle event has no order and no SKU. Forcing it into that table would
-- mean making order_number nullable — weakening the one column that keeps an
-- orphaned discussion row meaningful — so that a completely different kind of
-- event could sit in the same list and have to be filtered back out of every
-- SKU drawer. Two focused tables, each with a NOT NULL subject, is cleaner than
-- one table with a nullable one.
--
-- THE DEFECT THIS FIXES: reopening a meeting clears completed_at/completed_by
-- (the CHECK constraint on public.meetings requires it), so before this table
-- existed, reopen-then-recomplete silently destroyed the record of the first
-- completion — who closed the meeting, and when. Nothing anywhere held it.
-- Now the columns on public.meetings are merely the CURRENT state, and this
-- table is the history that survives every transition.

CREATE TABLE public.meeting_activity_log (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id uuid        NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,

  event_type text        NOT NULL CHECK (event_type IN (
    'created',            -- the draft was raised
    'started',            -- draft → in_progress
    'completed',          -- → completed, from either live state
    'reopened',           -- completed → in_progress, for a correction
    'returned_to_draft'   -- in_progress → draft, started by mistake
  )),

  -- NULL only for 'created', which has no prior state.
  previous_status text CHECK (previous_status IS NULL OR previous_status IN ('draft', 'in_progress', 'completed')),
  new_status      text NOT NULL CHECK (new_status IN ('draft', 'in_progress', 'completed')),

  -- Short, system-generated. Never user input: this is an audit trail, not a
  -- comment thread.
  detail     text,

  actor_id   uuid        NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- 'created' is the only event with no previous status, and every other event
  -- must have one. Stops a malformed row from ever reaching the trail.
  CONSTRAINT meeting_activity_log_previous_status_matches_event CHECK (
    (event_type =  'created' AND previous_status IS NULL)
    OR
    (event_type <> 'created' AND previous_status IS NOT NULL)
  )
);

-- The only query this table serves: one meeting's trail, newest first.
CREATE INDEX meeting_activity_log_meeting_idx
  ON public.meeting_activity_log (meeting_id, created_at DESC);

-- ═══ 6. Visibility and editorship predicates ═══════════════════════════════
--
-- Two functions, used by every policy below AND by every definer function, so
-- "who can see this meeting" and "who can change it" are each answered in
-- exactly one place. SECURITY DEFINER + STABLE so a policy can call them
-- without recursing through RLS on public.users.

-- Can this user READ this meeting?
--
--   * an admin, or someone holding meetings.manage — management-wide sight of
--     every review, which is what a manager conducting them needs;
--   * the lead or the creator;
--   * anyone who attended.
--
-- An employee who was not in the room sees nothing. That is the whole point of
-- the module being permission-gated rather than 'live' to everybody: these are
-- management reviews and they must not become ambiently readable.
CREATE OR REPLACE FUNCTION public.can_view_meeting(p_meeting_id uuid, p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.meetings m
    WHERE m.id = p_meeting_id
      AND (
        m.lead_id    = p_user_id
        OR m.created_by = p_user_id
        OR EXISTS (
          SELECT 1 FROM public.meeting_attendees a
          WHERE a.meeting_id = m.id AND a.user_id = p_user_id
        )
        OR EXISTS (
          SELECT 1 FROM public.users u
          WHERE u.id = p_user_id AND u.is_active AND u.role = 'admin'
        )
        OR public.resolve_permission(p_user_id, 'meetings', 'manage')
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_view_meeting(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_view_meeting(uuid, uuid) TO authenticated;

-- Can this user CHANGE this meeting's contents?
--
-- Conducting a review is a narrower right than reading one: an attendee reads,
-- but only the lead, the creator, an admin, or someone holding meetings.edit /
-- meetings.manage writes. `p_allow_completed` exists because completing and
-- reopening are themselves writes against a completed meeting; every ordinary
-- edit path passes false, which is what makes a completed meeting read-only.
CREATE OR REPLACE FUNCTION public.can_edit_meeting(
  p_meeting_id      uuid,
  p_user_id         uuid    DEFAULT auth.uid(),
  p_allow_completed boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.meetings m
    JOIN public.users u ON u.id = p_user_id AND u.is_active
    WHERE m.id = p_meeting_id
      AND (p_allow_completed OR m.status <> 'completed')
      AND (
        u.role = 'admin'
        OR m.lead_id    = p_user_id
        OR m.created_by = p_user_id
        OR public.resolve_permission(p_user_id, 'meetings', 'edit')
        OR public.resolve_permission(p_user_id, 'meetings', 'manage')
      )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.can_edit_meeting(uuid, uuid, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.can_edit_meeting(uuid, uuid, boolean) TO authenticated;

-- Raising guard used at the top of every definer function below, so a refused
-- write produces one sentence a user can act on instead of a silent no-op.
CREATE OR REPLACE FUNCTION public.assert_meeting_editor(
  p_meeting_id      uuid,
  p_allow_completed boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.meetings WHERE id = p_meeting_id) THEN
    RAISE EXCEPTION 'MEETING_MISSING: This meeting no longer exists' USING ERRCODE = '42501';
  END IF;

  IF NOT p_allow_completed
     AND EXISTS (SELECT 1 FROM public.meetings WHERE id = p_meeting_id AND status = 'completed') THEN
    RAISE EXCEPTION 'MEETING_COMPLETED: This meeting is completed and is now read-only. Reopen it to make a correction.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.can_edit_meeting(p_meeting_id, v_uid, p_allow_completed) THEN
    RAISE EXCEPTION 'MEETING_FORBIDDEN: You do not have permission to change this meeting'
      USING ERRCODE = '42501';
  END IF;

  RETURN v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.assert_meeting_editor(uuid, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.assert_meeting_editor(uuid, boolean) TO authenticated;

-- ═══ 7. Row Level Security ═════════════════════════════════════════════════
--
-- No policy anywhere in this module is `USING (true)`.

ALTER TABLE public.meetings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_attendees      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_order_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_update_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_activity_log   ENABLE ROW LEVEL SECURITY;

-- ── meetings ──────────────────────────────────────────────────────────────

CREATE POLICY "meetings_select" ON public.meetings
  FOR SELECT TO authenticated
  USING (public.can_view_meeting(id, auth.uid()));

CREATE POLICY "meetings_insert" ON public.meetings
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND status = 'draft'
    AND completed_at IS NULL
    AND completed_by IS NULL
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.is_active
        AND (u.role = 'admin' OR public.resolve_permission(auth.uid(), 'meetings', 'create'))
    )
  );

-- The meeting HEADER (title, date, type, lead, note) is editable in place —
-- there is no history requirement on it, and forcing a round trip through an
-- RPC to fix a typo in a title would be friction with no accountability gain.
--
-- What this policy cannot do is complete or reopen a meeting: both sides
-- require status <> 'completed', so 'completed' is unreachable from a client
-- UPDATE in either direction. Status moves only through set_meeting_status()
-- below, where the transition table lives.
CREATE POLICY "meetings_update" ON public.meetings
  FOR UPDATE TO authenticated
  USING      (status <> 'completed' AND public.can_edit_meeting(id, auth.uid(), false))
  WITH CHECK (status <> 'completed' AND public.can_edit_meeting(id, auth.uid(), false));

-- Deleting is for a draft raised by mistake. The trigger below additionally
-- refuses once anything has been discussed in it.
CREATE POLICY "meetings_delete" ON public.meetings
  FOR DELETE TO authenticated
  USING (
    status = 'draft'
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.is_active
        AND (
          u.role = 'admin'
          OR (created_by = auth.uid() AND public.resolve_permission(auth.uid(), 'meetings', 'create'))
          OR public.resolve_permission(auth.uid(), 'meetings', 'delete')
        )
    )
  );

CREATE OR REPLACE FUNCTION public.meetings_prevent_delete_with_content()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.meeting_orders WHERE meeting_id = OLD.id) THEN
    RAISE EXCEPTION 'MEETING_HAS_CONTENT: This meeting already has orders under review and cannot be deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS meetings_prevent_delete_with_content_trg ON public.meetings;
CREATE TRIGGER meetings_prevent_delete_with_content_trg
  BEFORE DELETE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.meetings_prevent_delete_with_content();

-- ── meeting_attendees ─────────────────────────────────────────────────────

CREATE POLICY "meeting_attendees_select" ON public.meeting_attendees
  FOR SELECT TO authenticated
  USING (public.can_view_meeting(meeting_id, auth.uid()));

CREATE POLICY "meeting_attendees_insert" ON public.meeting_attendees
  FOR INSERT TO authenticated
  WITH CHECK (
    public.can_edit_meeting(meeting_id, auth.uid(), false)
    -- Only an ACTIVE BOE member can be an attendee. The module reuses the
    -- employee directory; it does not accept arbitrary ids.
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = user_id AND u.is_active)
  );

CREATE POLICY "meeting_attendees_delete" ON public.meeting_attendees
  FOR DELETE TO authenticated
  USING (public.can_edit_meeting(meeting_id, auth.uid(), false));

-- ── meeting_orders / meeting_order_items ──────────────────────────────────
--
-- SELECT only. No INSERT, no UPDATE, no DELETE policy for anyone — that is
-- what routes every write through the definer functions in section 8 and makes
-- the history entry non-optional.

CREATE POLICY "meeting_orders_select" ON public.meeting_orders
  FOR SELECT TO authenticated
  USING (public.can_view_meeting(meeting_id, auth.uid()));

CREATE POLICY "meeting_order_items_select" ON public.meeting_order_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.meeting_orders o
    WHERE o.id = meeting_order_id
      AND public.can_view_meeting(o.meeting_id, auth.uid())
  ));

-- ── meeting_update_history ────────────────────────────────────────────────
--
-- Readable by whoever can read the meeting. Not writable, not editable, not
-- erasable — by anyone, including an admin. There is no UPDATE policy and no
-- DELETE policy on purpose, and no INSERT policy either: the definer functions
-- write these rows.

CREATE POLICY "meeting_update_history_select" ON public.meeting_update_history
  FOR SELECT TO authenticated
  USING (public.can_view_meeting(meeting_id, auth.uid()));

-- ── meeting_activity_log ──────────────────────────────────────────────────
--
-- Same shape, same guarantee: readable by whoever can read the meeting, and
-- writable by nobody. Rows arrive only from record_meeting_activity(), called
-- by set_meeting_status() and by the creation trigger.

CREATE POLICY "meeting_activity_log_select" ON public.meeting_activity_log
  FOR SELECT TO authenticated
  USING (public.can_view_meeting(meeting_id, auth.uid()));

-- ═══ 8. Write operations ═══════════════════════════════════════════════════
--
-- Every function: authorize → mutate → record history, in one transaction.

-- Internal: append one history row. Not granted to any client role.
CREATE OR REPLACE FUNCTION public.record_meeting_history(
  p_meeting_id  uuid,
  p_order_id    uuid,
  p_item_id     uuid,
  p_order_number text,
  p_sku          text,
  p_product_name text,
  p_entry_type   text,
  p_actor_id     uuid,
  p_previous_update text DEFAULT NULL,
  p_new_update      text DEFAULT NULL,
  p_previous_status text DEFAULT NULL,
  p_new_status      text DEFAULT NULL,
  p_previous_follow_up date DEFAULT NULL,
  p_new_follow_up      date DEFAULT NULL,
  p_detail             text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.meeting_update_history (
    meeting_id, meeting_order_id, meeting_order_item_id,
    order_number, sku, product_name, entry_type,
    previous_update, new_update,
    previous_status, new_status,
    previous_follow_up_date, new_follow_up_date,
    detail, actor_id
  ) VALUES (
    p_meeting_id, p_order_id, p_item_id,
    p_order_number, p_sku, p_product_name, p_entry_type,
    p_previous_update, p_new_update,
    p_previous_status, p_new_status,
    p_previous_follow_up, p_new_follow_up,
    p_detail, p_actor_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.record_meeting_history(uuid, uuid, uuid, text, text, text, text, uuid, text, text, text, text, date, date, text)
  FROM public, anon, authenticated;

-- Internal: append one LIFECYCLE row. Not granted to any client role either —
-- a client that could call this directly could fabricate a completion.
CREATE OR REPLACE FUNCTION public.record_meeting_activity(
  p_meeting_id      uuid,
  p_event_type      text,
  p_previous_status text,
  p_new_status      text,
  p_actor_id        uuid,
  p_detail          text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.meeting_activity_log (
    meeting_id, event_type, previous_status, new_status, detail, actor_id
  ) VALUES (
    p_meeting_id, p_event_type, p_previous_status, p_new_status, p_detail, p_actor_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.record_meeting_activity(uuid, text, text, text, uuid, text)
  FROM public, anon, authenticated;

-- ── 8a-0. The 'created' event ─────────────────────────────────────────────
--
-- A trigger rather than an RPC, because a meeting is created by a plain INSERT
-- through meetings_insert (there is no create_meeting() function, and adding
-- one to record a single audit row would be a worse trade than this). Being a
-- trigger is what makes the entry non-optional: it fires inside the INSERT's
-- own transaction, so a meeting cannot exist without its opening trail row, and
-- no client can suppress it.
--
-- NEW.created_by, not auth.uid(): the INSERT policy already pins created_by to
-- the caller, and reading the row keeps this correct if a service-role path
-- ever inserts one.

CREATE OR REPLACE FUNCTION public.meetings_log_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.record_meeting_activity(
    NEW.id, 'created', NULL, NEW.status, NEW.created_by, 'Meeting created'
  );
  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

REVOKE EXECUTE ON FUNCTION public.meetings_log_creation() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS meetings_log_creation_trg ON public.meetings;
CREATE TRIGGER meetings_log_creation_trg
  AFTER INSERT ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.meetings_log_creation();

-- ── 8a. Add an order to a meeting ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.add_meeting_order(
  p_meeting_id             uuid,
  p_order_number           text,
  p_order_type             text    DEFAULT NULL,
  p_customer_name          text    DEFAULT NULL,
  p_expected_dispatch_date date    DEFAULT NULL,
  p_remarks                text    DEFAULT NULL
)
RETURNS public.meeting_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid;
  v_type  text;
  v_order public.meeting_orders;
BEGIN
  v_uid := public.assert_meeting_editor(p_meeting_id);

  IF btrim(COALESCE(p_order_number, '')) = '' THEN
    RAISE EXCEPTION 'MEETING_ORDER_NUMBER_REQUIRED: An order or repair reference is required'
      USING ERRCODE = '22023';
  END IF;

  -- An order defaults to the kind of review it is being discussed in, which is
  -- right almost always and keeps one field off the form.
  SELECT COALESCE(p_order_type, m.meeting_type) INTO v_type
  FROM public.meetings m WHERE m.id = p_meeting_id;

  IF v_type NOT IN ('new_order', 'repair_order') THEN
    RAISE EXCEPTION 'MEETING_ORDER_TYPE_INVALID: Unknown order type "%"', v_type
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.meeting_orders (
    meeting_id, order_number, order_type, customer_name,
    expected_dispatch_date, remarks, created_by
  ) VALUES (
    p_meeting_id, btrim(p_order_number), v_type, NULLIF(btrim(COALESCE(p_customer_name, '')), ''),
    p_expected_dispatch_date, NULLIF(btrim(COALESCE(p_remarks, '')), ''), v_uid
  )
  RETURNING * INTO v_order;

  PERFORM public.record_meeting_history(
    p_meeting_id, v_order.id, NULL,
    v_order.order_number, NULL, NULL, 'order_added', v_uid,
    p_detail := 'Order added to this review'
  );

  RETURN v_order;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'MEETING_ORDER_DUPLICATE: "%" is already under review in this meeting', btrim(p_order_number)
      USING ERRCODE = '23505';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_meeting_order(uuid, text, text, text, date, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.add_meeting_order(uuid, text, text, text, date, text) TO authenticated;

-- ── 8b. Order-level update ────────────────────────────────────────────────
--
-- Every parameter is DEFAULT NULL and NULL means "leave alone", so this door
-- cannot blank a field it was not asked about. Clearing a value is done with
-- the explicit p_clear_* flags.

CREATE OR REPLACE FUNCTION public.save_meeting_order_update(
  p_order_id               uuid,
  p_latest_update          text    DEFAULT NULL,
  p_position               text    DEFAULT NULL,
  p_next_review_date       date    DEFAULT NULL,
  p_remarks                text    DEFAULT NULL,
  p_customer_name          text    DEFAULT NULL,
  p_expected_dispatch_date date    DEFAULT NULL,
  p_clear_next_review      boolean DEFAULT false
)
RETURNS public.meeting_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before public.meeting_orders;
  v_after  public.meeting_orders;
  v_uid    uuid;
  v_update text := NULLIF(btrim(COALESCE(p_latest_update, '')), '');
  v_detail text;
BEGIN
  SELECT * INTO v_before FROM public.meeting_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ORDER_MISSING: This order is no longer part of the meeting'
      USING ERRCODE = '42501';
  END IF;

  v_uid := public.assert_meeting_editor(v_before.meeting_id);

  IF p_position IS NOT NULL AND p_position NOT IN ('on_track', 'attention', 'at_risk', 'closed') THEN
    RAISE EXCEPTION 'MEETING_POSITION_INVALID: Unknown position "%"', p_position USING ERRCODE = '22023';
  END IF;

  UPDATE public.meeting_orders
     SET latest_update  = COALESCE(v_update, latest_update),
         position       = COALESCE(p_position, position),
         next_review_date = CASE
                              WHEN p_clear_next_review THEN NULL
                              ELSE COALESCE(p_next_review_date, next_review_date)
                            END,
         remarks        = COALESCE(NULLIF(btrim(COALESCE(p_remarks, '')), ''), remarks),
         customer_name  = COALESCE(NULLIF(btrim(COALESCE(p_customer_name, '')), ''), customer_name),
         expected_dispatch_date = COALESCE(p_expected_dispatch_date, expected_dispatch_date)
   WHERE id = p_order_id
  RETURNING * INTO v_after;

  IF v_after.position IS DISTINCT FROM v_before.position THEN
    v_detail := format('Position: %s → %s', v_before.position, v_after.position);
  END IF;

  -- A save that moved nothing writes no history. The trail records decisions,
  -- not clicks.
  IF v_update IS NOT NULL
     OR v_after.position         IS DISTINCT FROM v_before.position
     OR v_after.next_review_date IS DISTINCT FROM v_before.next_review_date THEN
    PERFORM public.record_meeting_history(
      v_before.meeting_id, v_before.id, NULL,
      v_before.order_number, NULL, NULL, 'order_update', v_uid,
      p_previous_update    := v_before.latest_update,
      p_new_update         := v_update,
      p_previous_status    := CASE WHEN v_after.position IS DISTINCT FROM v_before.position THEN v_before.position END,
      p_new_status         := CASE WHEN v_after.position IS DISTINCT FROM v_before.position THEN v_after.position  END,
      p_previous_follow_up := CASE WHEN v_after.next_review_date IS DISTINCT FROM v_before.next_review_date THEN v_before.next_review_date END,
      p_new_follow_up      := CASE WHEN v_after.next_review_date IS DISTINCT FROM v_before.next_review_date THEN v_after.next_review_date  END,
      p_detail             := v_detail
    );
  END IF;

  RETURN v_after;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_meeting_order_update(uuid, text, text, date, text, text, date, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.save_meeting_order_update(uuid, text, text, date, text, text, date, boolean) TO authenticated;

-- ── 8c. Remove an order from a meeting ────────────────────────────────────
--
-- For the reference typed in wrong. Refused the moment anything has actually
-- been discussed against it, because a removal at that point would be an
-- erasure of the record rather than a correction of an entry error.

CREATE OR REPLACE FUNCTION public.remove_meeting_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.meeting_orders;
BEGIN
  SELECT * INTO v_order FROM public.meeting_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.assert_meeting_editor(v_order.meeting_id);

  -- "Has anything actually been discussed against this order?"
  --
  -- entry_type alone is not that question. An 'import' entry carries a real
  -- update typed by a real person into the review sheet, so keying only on the
  -- three manual types let an imported discussion be removed. The predicate is
  -- therefore: any manual update event, OR any entry that carried update text
  -- however it arrived. 'order_added' and a bare 'item_added' with no update
  -- remain removable, which is the entry-error case this exists for.
  IF EXISTS (
    SELECT 1 FROM public.meeting_update_history
    WHERE meeting_order_id = p_order_id
      AND (
        entry_type IN ('order_update', 'item_update', 'task_linked')
        OR btrim(COALESCE(new_update, '')) <> ''
      )
  ) THEN
    RAISE EXCEPTION 'MEETING_ORDER_HAS_HISTORY: "%" already has recorded updates and cannot be removed', v_order.order_number
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.meeting_order_items
    WHERE meeting_order_id = p_order_id AND linked_task_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MEETING_ORDER_HAS_TASKS: "%" has tasks created from it and cannot be removed', v_order.order_number
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.meeting_orders WHERE id = p_order_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.remove_meeting_order(uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.remove_meeting_order(uuid) TO authenticated;

-- ── 8d. Add a SKU line ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.add_meeting_order_item(
  p_order_id               uuid,
  p_sku                    text,
  p_product_name           text,
  p_quantity               numeric DEFAULT NULL,
  p_current_stage          text    DEFAULT NULL,
  p_responsible_department text    DEFAULT NULL,
  p_issue                  text    DEFAULT NULL,
  p_latest_update          text    DEFAULT NULL,
  p_status                 text    DEFAULT 'open',
  p_next_follow_up_date    date    DEFAULT NULL
)
RETURNS public.meeting_order_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.meeting_orders;
  v_uid   uuid;
  v_item  public.meeting_order_items;
BEGIN
  SELECT * INTO v_order FROM public.meeting_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ORDER_MISSING: This order is no longer part of the meeting'
      USING ERRCODE = '42501';
  END IF;

  v_uid := public.assert_meeting_editor(v_order.meeting_id);

  IF btrim(COALESCE(p_sku, '')) = '' OR btrim(COALESCE(p_product_name, '')) = '' THEN
    RAISE EXCEPTION 'MEETING_ITEM_FIELDS_REQUIRED: SKU and product name are required'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_status, 'open') NOT IN ('open', 'waiting', 'resolved') THEN
    RAISE EXCEPTION 'MEETING_ITEM_STATUS_INVALID: Unknown status "%"', p_status USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.meeting_order_items (
    meeting_order_id, sku, product_name, quantity, current_stage,
    responsible_department, issue, latest_update, status, next_follow_up_date, created_by
  ) VALUES (
    p_order_id, btrim(p_sku), btrim(p_product_name), p_quantity,
    NULLIF(btrim(COALESCE(p_current_stage, '')), ''),
    NULLIF(btrim(COALESCE(p_responsible_department, '')), ''),
    NULLIF(btrim(COALESCE(p_issue, '')), ''),
    NULLIF(btrim(COALESCE(p_latest_update, '')), ''),
    COALESCE(p_status, 'open'), p_next_follow_up_date, v_uid
  )
  RETURNING * INTO v_item;

  PERFORM public.record_meeting_history(
    v_order.meeting_id, v_order.id, v_item.id,
    v_order.order_number, v_item.sku, v_item.product_name, 'item_added', v_uid,
    p_new_update    := v_item.latest_update,
    p_new_status    := v_item.status,
    p_new_follow_up := v_item.next_follow_up_date
  );

  RETURN v_item;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'MEETING_ITEM_DUPLICATE: "%" is already listed under %', btrim(p_sku), v_order.order_number
      USING ERRCODE = '23505';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_meeting_order_item(uuid, text, text, numeric, text, text, text, text, text, date) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.add_meeting_order_item(uuid, text, text, numeric, text, text, text, text, text, date) TO authenticated;

-- ── 8e. The SKU update — the operation this module exists for ─────────────
--
-- The fastest valid call passes p_latest_update alone. Everything else is
-- optional and NULL means "leave alone"; p_clear_follow_up is how a date is
-- removed, because "no date" and "don't touch the date" are different
-- instructions and NULL can only mean one of them.

CREATE OR REPLACE FUNCTION public.save_meeting_item_update(
  p_item_id                uuid,
  p_latest_update          text    DEFAULT NULL,
  p_status                 text    DEFAULT NULL,
  p_next_follow_up_date    date    DEFAULT NULL,
  p_issue                  text    DEFAULT NULL,
  p_current_stage          text    DEFAULT NULL,
  p_responsible_department text    DEFAULT NULL,
  p_clear_follow_up        boolean DEFAULT false,
  p_clear_issue            boolean DEFAULT false
)
RETURNS public.meeting_order_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before public.meeting_order_items;
  v_after  public.meeting_order_items;
  v_order  public.meeting_orders;
  v_uid    uuid;
  v_update text := NULLIF(btrim(COALESCE(p_latest_update, '')), '');
BEGIN
  SELECT * INTO v_before FROM public.meeting_order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ITEM_MISSING: This product line no longer exists' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.meeting_orders WHERE id = v_before.meeting_order_id;
  v_uid := public.assert_meeting_editor(v_order.meeting_id);

  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'waiting', 'resolved') THEN
    RAISE EXCEPTION 'MEETING_ITEM_STATUS_INVALID: Unknown status "%"', p_status USING ERRCODE = '22023';
  END IF;

  UPDATE public.meeting_order_items
     SET latest_update = COALESCE(v_update, latest_update),
         status        = COALESCE(p_status, status),
         next_follow_up_date = CASE
                                 -- Resolving a line retires its follow-up: a
                                 -- resolved item must never keep appearing in
                                 -- the Overdue list.
                                 WHEN COALESCE(p_status, status) = 'resolved' THEN NULL
                                 WHEN p_clear_follow_up THEN NULL
                                 ELSE COALESCE(p_next_follow_up_date, next_follow_up_date)
                               END,
         issue         = CASE
                           WHEN p_clear_issue THEN NULL
                           ELSE COALESCE(NULLIF(btrim(COALESCE(p_issue, '')), ''), issue)
                         END,
         current_stage = COALESCE(NULLIF(btrim(COALESCE(p_current_stage, '')), ''), current_stage),
         responsible_department = COALESCE(NULLIF(btrim(COALESCE(p_responsible_department, '')), ''), responsible_department)
   WHERE id = p_item_id
  RETURNING * INTO v_after;

  IF v_update IS NOT NULL
     OR v_after.status              IS DISTINCT FROM v_before.status
     OR v_after.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN
    PERFORM public.record_meeting_history(
      v_order.meeting_id, v_order.id, v_after.id,
      v_order.order_number, v_after.sku, v_after.product_name, 'item_update', v_uid,
      p_previous_update    := v_before.latest_update,
      p_new_update         := v_update,
      p_previous_status    := CASE WHEN v_after.status IS DISTINCT FROM v_before.status THEN v_before.status END,
      p_new_status         := CASE WHEN v_after.status IS DISTINCT FROM v_before.status THEN v_after.status  END,
      p_previous_follow_up := CASE WHEN v_after.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN v_before.next_follow_up_date END,
      p_new_follow_up      := CASE WHEN v_after.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN v_after.next_follow_up_date  END
    );
  END IF;

  RETURN v_after;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_meeting_item_update(uuid, text, text, date, text, text, text, boolean, boolean) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.save_meeting_item_update(uuid, text, text, date, text, text, text, boolean, boolean) TO authenticated;

-- ── 8f. Link a task created from a SKU line ───────────────────────────────
--
-- Meetings stores the RELATIONSHIP only. Acknowledgement, status changes,
-- completion and activity history stay in Task Management, which remains the
-- execution source of truth — this module never mirrors them.

CREATE OR REPLACE FUNCTION public.link_meeting_item_task(
  p_item_id uuid,
  p_task_id uuid
)
RETURNS public.meeting_order_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before public.meeting_order_items;
  v_after  public.meeting_order_items;
  v_order  public.meeting_orders;
  v_uid    uuid;
  v_title  text;
BEGIN
  SELECT * INTO v_before FROM public.meeting_order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_ITEM_MISSING: This product line no longer exists' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_order FROM public.meeting_orders WHERE id = v_before.meeting_order_id;
  v_uid := public.assert_meeting_editor(v_order.meeting_id);

  -- The caller must have a legitimate relationship to the task, NOT merely a
  -- task id. This function is SECURITY DEFINER, so it reads public.tasks with
  -- RLS bypassed; without this predicate a meeting editor could link ANY task
  -- in the company by guessing its id, and the history entry below — which they
  -- are then entitled to read — would disclose that task's title.
  --
  -- Creator OR assignee is the honest boundary: the intended flow is "I just
  -- created this task from this SKU" (created_by = caller), and linking a task
  -- that was assigned to you is the only other case that is not a fishing
  -- expedition. Admins are exempt, as everywhere else in this module.
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

  -- One message for "no such task" and "not your task" on purpose: a caller
  -- must not be able to probe which task ids exist.
  IF v_title IS NULL THEN
    RAISE EXCEPTION 'MEETING_TASK_NOT_LINKABLE: That task cannot be linked to this product line'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.meeting_order_items
     SET linked_task_id = p_task_id,
         linked_task_at = now(),
         linked_task_by = v_uid
   WHERE id = p_item_id
  RETURNING * INTO v_after;

  PERFORM public.record_meeting_history(
    v_order.meeting_id, v_order.id, v_after.id,
    v_order.order_number, v_after.sku, v_after.product_name, 'task_linked', v_uid,
    p_detail := format('Task created: %s', v_title)
  );

  RETURN v_after;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.link_meeting_item_task(uuid, uuid) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.link_meeting_item_task(uuid, uuid) TO authenticated;

-- ── 8g. Status transitions ────────────────────────────────────────────────
--
-- The only door to 'completed', in either direction. The transition table is
-- here and mirrored in src/lib/meetings/status.ts, which is what the UI
-- branches on — the client never invents a transition the database would
-- refuse.
--
--   draft       → in_progress | completed
--   in_progress → completed   | draft
--   completed   → in_progress          (reopen, for a correction)
--
-- Completing with open issues is allowed on purpose. Meetings end when the
-- meeting ends; the warning is the UI's job, not the database's.

CREATE OR REPLACE FUNCTION public.set_meeting_status(
  p_meeting_id uuid,
  p_status     text
)
RETURNS public.meetings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before public.meetings;
  v_after  public.meetings;
  v_uid    uuid;
  v_event  text;
BEGIN
  SELECT * INTO v_before FROM public.meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEETING_MISSING: This meeting no longer exists' USING ERRCODE = '42501';
  END IF;

  -- allow_completed = true: reopening is a write against a completed meeting,
  -- and it is the one write that has to be.
  v_uid := public.assert_meeting_editor(p_meeting_id, true);

  IF p_status NOT IN ('draft', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'MEETING_STATUS_INVALID: Unknown status "%"', p_status USING ERRCODE = '22023';
  END IF;

  IF v_before.status = p_status THEN
    RETURN v_before;
  END IF;

  IF NOT (
    (v_before.status = 'draft'       AND p_status IN ('in_progress', 'completed'))
    OR (v_before.status = 'in_progress' AND p_status IN ('completed', 'draft'))
    OR (v_before.status = 'completed'   AND p_status = 'in_progress')
  ) THEN
    RAISE EXCEPTION 'MEETING_TRANSITION_INVALID: A % meeting cannot move to %', v_before.status, p_status
      USING ERRCODE = '42501';
  END IF;

  -- Reopening clears completed_at/completed_by rather than keeping a stale
  -- pair; the CHECK constraint on the table makes that non-optional. Those two
  -- columns are therefore CURRENT STATE, not history — the history is the
  -- meeting_activity_log row written below, which is never cleared, so a
  -- meeting completed, reopened and completed again keeps BOTH completion
  -- records with their own actors and timestamps.
  UPDATE public.meetings
     SET status       = p_status,
         completed_at = CASE WHEN p_status = 'completed' THEN now()   ELSE NULL END,
         completed_by = CASE WHEN p_status = 'completed' THEN v_uid   ELSE NULL END
   WHERE id = p_meeting_id
  RETURNING * INTO v_after;

  -- The transition, named. Derived from the pair rather than passed in, so the
  -- trail cannot disagree with what actually happened.
  v_event := CASE
    WHEN p_status = 'completed'                                  THEN 'completed'
    WHEN v_before.status = 'completed' AND p_status = 'in_progress' THEN 'reopened'
    WHEN p_status = 'in_progress'                                THEN 'started'
    ELSE 'returned_to_draft'
  END;

  -- Same transaction as the UPDATE above, and unreachable unless
  -- assert_meeting_editor() passed at the top: an unauthorized attempt raises
  -- before anything is written, so it leaves no row and no trail entry.
  PERFORM public.record_meeting_activity(
    p_meeting_id, v_event, v_before.status, p_status, v_uid,
    CASE v_event
      WHEN 'completed'         THEN 'Meeting completed'
      WHEN 'reopened'          THEN 'Meeting reopened for correction'
      WHEN 'started'           THEN 'Meeting started'
      ELSE                          'Meeting returned to draft'
    END
  );

  RETURN v_after;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_meeting_status(uuid, text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.set_meeting_status(uuid, text) TO authenticated;

-- ── 8h. Spreadsheet import ────────────────────────────────────────────────
--
-- One controlled BOE template, matched on (order number + SKU). The rules that
-- matter and are enforced here, not in the browser:
--
--   * matching is on the NORMALISED keys, so trailing spaces and lower case in
--     a spreadsheet do not create a second copy of an order;
--   * an existing line is UPDATED through the same history-writing path as a
--     manual update — the trail does not care how the value arrived;
--   * nothing is ever deleted, and linked_task_id is never touched, so a
--     re-import cannot detach a task or drop a previous meeting's record;
--   * a blank cell means "leave alone", never "clear".
--
-- Rows are validated in the browser first (src/lib/meetings/import.ts) so the
-- user sees a preview; this function re-checks the essentials because a client
-- is not a validator.

CREATE OR REPLACE FUNCTION public.import_meeting_rows(
  p_meeting_id uuid,
  p_rows       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   uuid := public.assert_meeting_editor(p_meeting_id);
  v_row   jsonb;
  v_order public.meeting_orders;
  v_item  public.meeting_order_items;
  v_before public.meeting_order_items;
  v_meeting_type text;
  v_order_type   text;
  v_number text;
  v_sku    text;
  v_name   text;
  v_update text;
  v_follow date;
  v_orders_created int := 0;
  v_orders_matched int := 0;
  v_items_created  int := 0;
  v_items_updated  int := 0;
  -- One order usually spans several rows of the sheet. Counting per row would
  -- report "12 orders matched" for a 12-line, one-order import.
  v_seen_orders    uuid[] := ARRAY[]::uuid[];
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'MEETING_IMPORT_INVALID: Expected a list of rows' USING ERRCODE = '22023';
  END IF;

  SELECT meeting_type INTO v_meeting_type FROM public.meetings WHERE id = p_meeting_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_number := btrim(COALESCE(v_row ->> 'order_number', ''));
    v_sku    := btrim(COALESCE(v_row ->> 'sku', ''));
    v_name   := btrim(COALESCE(v_row ->> 'product_name', ''));

    IF v_number = '' OR v_sku = '' OR v_name = '' THEN
      RAISE EXCEPTION 'MEETING_IMPORT_ROW_INVALID: Every row needs an order number, a SKU and a product name'
        USING ERRCODE = '22023';
    END IF;

    v_order_type := COALESCE(NULLIF(v_row ->> 'order_type', ''), v_meeting_type);
    IF v_order_type NOT IN ('new_order', 'repair_order') THEN
      RAISE EXCEPTION 'MEETING_IMPORT_TYPE_INVALID: Unknown order type "%"', v_order_type USING ERRCODE = '22023';
    END IF;

    -- Match on the normalised key, then create only if there was nothing to
    -- match. Written as look-then-write rather than ON CONFLICT so the
    -- created/matched counts reported back to the user are exact rather than
    -- inferred from timestamps.
    SELECT * INTO v_order
    FROM public.meeting_orders
    WHERE meeting_id = p_meeting_id AND order_number_key = upper(v_number)
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.meeting_orders (
        meeting_id, order_number, order_type, customer_name, expected_dispatch_date, created_by
      ) VALUES (
        p_meeting_id, v_number, v_order_type,
        NULLIF(btrim(COALESCE(v_row ->> 'customer_name', '')), ''),
        NULLIF(v_row ->> 'expected_dispatch_date', '')::date,
        v_uid
      )
      RETURNING * INTO v_order;

      v_orders_created := v_orders_created + 1;
      v_seen_orders := v_seen_orders || v_order.id;
      PERFORM public.record_meeting_history(
        p_meeting_id, v_order.id, NULL, v_order.order_number, NULL, NULL, 'order_added', v_uid,
        p_detail := 'Order added by spreadsheet import'
      );
    ELSE
      -- A blank cell leaves the existing value alone here too.
      UPDATE public.meeting_orders
         SET customer_name          = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'customer_name', '')), ''), customer_name),
             expected_dispatch_date = COALESCE(NULLIF(v_row ->> 'expected_dispatch_date', '')::date, expected_dispatch_date)
       WHERE id = v_order.id
      RETURNING * INTO v_order;

      IF NOT (v_order.id = ANY (v_seen_orders)) THEN
        v_orders_matched := v_orders_matched + 1;
        v_seen_orders := v_seen_orders || v_order.id;
      END IF;
    END IF;

    v_update := NULLIF(btrim(COALESCE(v_row ->> 'latest_update', '')), '');
    v_follow := NULLIF(v_row ->> 'next_follow_up_date', '')::date;

    SELECT * INTO v_before
    FROM public.meeting_order_items
    WHERE meeting_order_id = v_order.id AND sku_key = upper(v_sku)
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.meeting_order_items (
        meeting_order_id, sku, product_name, quantity, current_stage,
        responsible_department, issue, latest_update, next_follow_up_date, created_by
      ) VALUES (
        v_order.id, v_sku, v_name,
        NULLIF(v_row ->> 'quantity', '')::numeric,
        NULLIF(btrim(COALESCE(v_row ->> 'current_stage', '')), ''),
        NULLIF(btrim(COALESCE(v_row ->> 'responsible_department', '')), ''),
        NULLIF(btrim(COALESCE(v_row ->> 'issue', '')), ''),
        v_update, v_follow, v_uid
      )
      RETURNING * INTO v_item;

      v_items_created := v_items_created + 1;
      PERFORM public.record_meeting_history(
        p_meeting_id, v_order.id, v_item.id, v_order.order_number, v_item.sku, v_item.product_name,
        'import', v_uid,
        p_new_update    := v_item.latest_update,
        p_new_status    := v_item.status,
        p_new_follow_up := v_item.next_follow_up_date,
        p_detail        := 'Added by spreadsheet import'
      );
    ELSE
      -- A blank cell leaves the value alone. linked_task_id and status are not
      -- in this list at all: an import reports progress, it does not close a
      -- discussion or detach a task.
      UPDATE public.meeting_order_items
         SET product_name  = v_name,
             quantity      = COALESCE(NULLIF(v_row ->> 'quantity', '')::numeric, quantity),
             current_stage = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'current_stage', '')), ''), current_stage),
             responsible_department = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'responsible_department', '')), ''), responsible_department),
             issue         = COALESCE(NULLIF(btrim(COALESCE(v_row ->> 'issue', '')), ''), issue),
             latest_update = COALESCE(v_update, latest_update),
             next_follow_up_date = COALESCE(v_follow, next_follow_up_date)
       WHERE id = v_before.id
      RETURNING * INTO v_item;

      v_items_updated := v_items_updated + 1;

      IF v_update IS NOT NULL
         OR v_item.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN
        PERFORM public.record_meeting_history(
          p_meeting_id, v_order.id, v_item.id, v_order.order_number, v_item.sku, v_item.product_name,
          'import', v_uid,
          p_previous_update    := v_before.latest_update,
          p_new_update         := v_update,
          p_previous_follow_up := CASE WHEN v_item.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN v_before.next_follow_up_date END,
          p_new_follow_up      := CASE WHEN v_item.next_follow_up_date IS DISTINCT FROM v_before.next_follow_up_date THEN v_item.next_follow_up_date  END,
          p_detail             := 'Updated by spreadsheet import'
        );
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'orders_created', v_orders_created,
    'orders_matched', v_orders_matched,
    'items_created',  v_items_created,
    'items_updated',  v_items_updated
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.import_meeting_rows(uuid, jsonb) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.import_meeting_rows(uuid, jsonb) TO authenticated;

-- ═══ 8i. Privileges ════════════════════════════════════════════════════════
--
-- PRIVILEGES, not a session variable and not only a policy — the control
-- Postgres checks BEFORE row-level security and before any trigger runs, and
-- one that nothing a client puts in a transaction can override. This follows
-- 20260806000000, which found that Supabase's blanket `grant all on all tables`
-- default had left an RLS policy standing alone in front of commercial columns.
-- The same default applies to every table created here.
--
-- What this closes concretely: `meetings_update` permits the lead to edit the
-- header, and a policy cannot express WHICH COLUMNS. Without the grant below, a
-- lead could PATCH `{ status: 'in_progress' }` straight from the browser —
-- bypassing set_meeting_status(), and therefore producing a status change with
-- NO lifecycle history. The grant is what makes the audit trail unavoidable.
--
-- service_role keeps everything; it is not constrained by these statements and
-- the definer functions run as the table owner regardless.

-- ── public.meetings: header columns only ──
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.meetings FROM authenticated, anon;

-- The five fields the Edit Meeting form writes, plus updated_at for the
-- set_updated_at trigger's benefit. NOT status, completed_at or completed_by:
-- those move exclusively through set_meeting_status(), which writes the trail.
-- NOT created_by or created_at: provenance is not editable.
GRANT UPDATE (meeting_type, meeting_date, title, lead_id, note, updated_at)
  ON public.meetings TO authenticated;

-- anon holds no write privilege anywhere in this module. It has no matching
-- policy either, so this changes no behaviour today — it removes the standing
-- grant that would become one the moment a permissive policy was added.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meetings FROM anon;

-- ── The two history tables: readable, never writable ──
--
-- Neither has an INSERT/UPDATE/DELETE policy, so these grants are already
-- unusable. Revoking them anyway means a future policy added by mistake still
-- could not write, and TRUNCATE — which no policy governs and which no row
-- trigger would fire on — cannot erase either trail.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_update_history FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_activity_log    FROM authenticated, anon;

-- ── Orders and SKU lines: definer functions only ──
-- Same reasoning: SELECT-only policies today, and no standing grant left behind
-- for a future policy to activate.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_orders      FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.meeting_order_items FROM authenticated, anon;

-- ── Attendees: the one child table a client legitimately writes ──
REVOKE UPDATE, TRUNCATE ON public.meeting_attendees FROM authenticated, anon;
REVOKE INSERT, DELETE    ON public.meeting_attendees FROM anon;

COMMENT ON TABLE public.meeting_activity_log IS
  'Append-only meeting lifecycle trail: created, started, completed, reopened. No client role holds INSERT, UPDATE, DELETE or TRUNCATE; rows arrive only from record_meeting_activity(), called by set_meeting_status() and the creation trigger. meetings.completed_at/completed_by are current state — THIS is the history that survives a reopen.';

COMMENT ON TABLE public.meeting_update_history IS
  'Append-only order and SKU discussion trail. No client role holds INSERT, UPDATE, DELETE or TRUNCATE; rows arrive only from record_meeting_history(), called inside the same transaction as the value they describe.';

-- ═══ 9. Registration ═══════════════════════════════════════════════════════

-- Control Center module registry (route visibility). Mirrors the seed shape in
-- 20260645_create_control_center_v1.sql.
INSERT INTO public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
VALUES
  ('meetings', 'Meetings', 'Structured order-review meetings, SKU updates, and follow-ups.', '/meetings', 'live', NULL, 90)
ON CONFLICT (module_key) DO NOTHING;

-- Permission engine registry. Mirrors src/lib/permissions/modules.ts exactly —
-- `npm run permissions:check` fails the build if the two drift.
INSERT INTO public.permission_modules (module_key, display_name, description) VALUES
  ('meetings', 'Meetings', 'Structured order-review meetings, SKU updates, and follow-ups.')
ON CONFLICT (module_key) DO NOTHING;

-- System Default = false for every action. Meetings are confidential
-- management reviews: nobody holds anything here until it is granted, which is
-- the opposite of the 'live' default that made the asset inventory readable to
-- the whole company (see 20260810000000).
INSERT INTO public.module_permission_actions (module_id, action_id, default_allowed)
SELECT pm.id, pa.id, false
FROM public.permission_modules pm
JOIN public.permission_actions pa ON pa.action_key IN
  ('view', 'create', 'edit', 'delete', 'export', 'manage')
WHERE pm.module_key = 'meetings'
ON CONFLICT (module_id, action_id) DO NOTHING;

-- Role defaults.
--
--   admin   — everything, matching every other module's seed.
--   manager — view, create, edit, manage: create a review, conduct it, record
--             updates, complete it, and see every meeting (manage) because a
--             manager running these reviews needs the whole picture.
--   member  — 'view' only. That is module ENTRY, not visibility: the meetings
--             SELECT policy still narrows the rows to the ones they led,
--             created or ATTENDED. An employee opening Meetings sees their own
--             reviews and the tasks that came out of them, and nothing else.
INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'admin', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'meetings'
ON CONFLICT (role, module_id, action_id) DO NOTHING;

INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'manager', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'meetings'
JOIN public.permission_actions pa  ON pa.id = mpa.action_id
WHERE pa.action_key IN ('view', 'create', 'edit', 'manage')
ON CONFLICT (role, module_id, action_id) DO NOTHING;

INSERT INTO public.role_permissions (role, module_id, action_id, allowed)
SELECT 'member', mpa.module_id, mpa.action_id, true
FROM public.module_permission_actions mpa
JOIN public.permission_modules pm ON pm.id = mpa.module_id AND pm.module_key = 'meetings'
JOIN public.permission_actions pa  ON pa.id = mpa.action_id
WHERE pa.action_key = 'view'
ON CONFLICT (role, module_id, action_id) DO NOTHING;

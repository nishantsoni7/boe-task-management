-- Order Management: Activity log
--
-- Append-only ledger of every significant event on an order.
-- Reuses the same pattern as the task activity log.
--
-- event_type values (not exhaustive; new types can be added without migration):
--   created           → order record first inserted
--   status_changed    → payload: { from: 'requested', to: 'running' }
--   payment_linked    → payload: { payment_id: '...', amount: 50000 }
--   payment_unlinked  → payload: { payment_id: '...' }
--   note_added        → payload: { note: '...' }

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE public.order_activity_log (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid          NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  actor_id    uuid          REFERENCES public.users(id) ON DELETE SET NULL,
  event_type  text          NOT NULL,
  payload     jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX order_activity_log_order_id_idx    ON public.order_activity_log(order_id);
CREATE INDEX order_activity_log_created_at_idx  ON public.order_activity_log(created_at DESC);

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.order_activity_log ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "order_activity_log_admin_select" ON public.order_activity_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

CREATE POLICY "order_activity_log_admin_insert" ON public.order_activity_log
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

-- Operations: view logs for all orders they can see
CREATE POLICY "order_activity_log_operations_select" ON public.order_activity_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

CREATE POLICY "order_activity_log_operations_insert" ON public.order_activity_log
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

-- Sales: view logs only for orders they can see (requested_by or assigned_to)
CREATE POLICY "order_activity_log_sales_select" ON public.order_activity_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.orders
      WHERE orders.id = order_activity_log.order_id
        AND (orders.requested_by = auth.uid() OR orders.assigned_to = auth.uid())
    )
  );

-- No delete policy: activity log is append-only

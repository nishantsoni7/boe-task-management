-- Order Management: Orders table
--
-- The Order is the central business object in BOE OS.
-- Payments, production status, and dispatch all attach to it.
--
-- Lifecycle (status values):
--   requested          → Sales has submitted an order request; not yet admin-verified
--   running            → Admin has aligned the order; active in production
--   on_hold            → Paused (waiting on material, client decision, etc.)
--   ready_for_dispatch → Production complete, awaiting shipment
--   dispatched         → Shipped to client
--   cancelled          → Dead order
--
-- display_number is the human-visible identifier (e.g. "496").
-- Internally all relationships use the UUID id.

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE public.orders (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Visible identifier
  display_number   text          UNIQUE NOT NULL,

  -- Core order info
  client_name      text          NOT NULL,
  requested_by     uuid          REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_to      uuid          REFERENCES public.users(id) ON DELETE SET NULL,
  confirm_date     date,
  due_date         date,
  total_value      numeric(12,2),
  lead_source      text
                     CHECK (lead_source IN (
                       'reference', 'repeat_customer', 'whatsapp', 'instagram', 'website'
                     )),

  -- Lifecycle
  status           text          NOT NULL DEFAULT 'requested'
                     CHECK (status IN (
                       'requested',
                       'running',
                       'on_hold',
                       'ready_for_dispatch',
                       'dispatched',
                       'cancelled'
                     )),

  notes            text,

  -- Audit
  created_by       uuid          REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  updated_at       timestamptz   NOT NULL DEFAULT now()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX orders_display_number_idx  ON public.orders(display_number);
CREATE INDEX orders_status_idx          ON public.orders(status);
CREATE INDEX orders_requested_by_idx    ON public.orders(requested_by);
CREATE INDEX orders_assigned_to_idx     ON public.orders(assigned_to);
CREATE INDEX orders_due_date_idx        ON public.orders(due_date DESC);
CREATE INDEX orders_created_at_idx      ON public.orders(created_at DESC);

-- ─── updated_at trigger ───────────────────────────────────────────────────────
-- set_updated_at() was defined in 20260609_create_attendance_records.sql

DROP TRIGGER IF EXISTS orders_set_updated_at ON public.orders;

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "orders_admin_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

CREATE POLICY "orders_admin_insert" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

CREATE POLICY "orders_admin_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

CREATE POLICY "orders_admin_delete" ON public.orders
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.role = 'admin')
  );

-- Operations: view all orders + update status/notes (no insert, no delete)
CREATE POLICY "orders_operations_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

CREATE POLICY "orders_operations_update" ON public.orders
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users WHERE users.id = auth.uid() AND users.team = 'operations')
  );

-- Sales: view orders they requested or are assigned to
CREATE POLICY "orders_sales_select" ON public.orders
  FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR assigned_to = auth.uid()
  );

-- Sales: insert their own order requests
CREATE POLICY "orders_sales_insert" ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
  );

-- ─── app_modules: register Orders module ─────────────────────────────────────

INSERT INTO public.app_modules
  (module_key, module_name, description, route_path, visibility_type, allowed_department, sort_order)
VALUES
  (
    'orders',
    'Orders',
    'Track confirmed orders from request through dispatch.',
    '/orders',
    'live',
    NULL,
    85
  )
ON CONFLICT (module_key) DO NOTHING;

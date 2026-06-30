-- Finance: Link payments to orders
--
-- Adds order_id (UUID FK) alongside the existing order_number (text) column.
-- order_number is NOT removed — it already has live data and is used by the Finance UI.
-- order_id is the real relational link; order_number remains the human-visible label.
--
-- When a payment is linked to an order, both fields should be populated:
--   order_id     → UUID of the orders row (used for joins and payment summary)
--   order_number → display_number from that order (shown in Finance tables)
--
-- A payment where order_id IS NULL is an unlinked / suspense entry:
--   payment received but order not yet identified or not yet created.
-- These will be surfaced in the Orders dashboard as "Unlinked Payments".

ALTER TABLE public.finance_payment_requests
  ADD COLUMN IF NOT EXISTS order_id uuid
    REFERENCES public.orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS finance_payment_requests_order_id_idx
  ON public.finance_payment_requests(order_id);

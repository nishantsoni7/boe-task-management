-- Finance: Add payment_against column
--
-- Every new payment request must declare whether the payment is for:
--   existing_order  – customer already has an order
--   new_order       – order has not yet been created
--
-- Default 'new_order' keeps existing rows valid without a backfill.

ALTER TABLE public.finance_payment_requests
  ADD COLUMN IF NOT EXISTS payment_against text
    NOT NULL DEFAULT 'new_order'
    CHECK (payment_against IN ('existing_order', 'new_order'));

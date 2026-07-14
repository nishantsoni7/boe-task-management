-- Finance: enforce that approved_linked payments always have a real order_id
--
-- order_id is the source of truth for payment-to-order linking.
-- order_number is display/reference text only and must never, by itself,
-- make a payment "linked". A payment can only be approved_linked when it
-- carries a genuine order_id foreign key.
--
-- Step 1 — data normalization (safe, no invention of data):
--   Any existing row that is approved_linked but has a null order_id is
--   demoted to approved_unlinked. order_number is left untouched — it
--   remains valid historical/reference text, we just stop treating its
--   presence as proof of a link.
--
-- Step 2 — CHECK constraint:
--   status = 'approved_linked' -> order_id must not be null.
--   The inverse (approved_unlinked -> order_id IS NULL) is intentionally
--   NOT enforced here: existing code allows an admin to correct a payment
--   back to approved_unlinked while an order_id is still attached (e.g.
--   via the Unlink flow, which explicitly nulls it out in a separate
--   step), and there is no proof today that approved_unlinked rows are
--   always order_id-null in practice.

UPDATE public.finance_payment_requests
SET status = 'approved_unlinked',
    updated_at = now()
WHERE status = 'approved_linked'
  AND order_id IS NULL;

ALTER TABLE public.finance_payment_requests
  ADD CONSTRAINT finance_payment_requests_approved_linked_requires_order_id
  CHECK (status <> 'approved_linked' OR order_id IS NOT NULL);

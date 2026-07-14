-- Order Management: make display_number reuse-proof for deletions
--
-- display_number was previously computed client-side as MAX(existing)+1
-- (src/app/orders/all/page.tsx and src/app/finance/page.tsx). Deleting the
-- highest-numbered order would let the next created order reuse that same
-- number. Replace the generation mechanism with a Postgres sequence,
-- exposed via a SECURITY DEFINER RPC so any authenticated caller who can
-- create an order (sales or admin, per orders_sales_insert /
-- orders_admin_insert) can safely obtain the next number without needing
-- direct sequence privileges.
--
-- A sequence's nextval() does not roll back on a failed/aborted
-- transaction, so a number can be skipped (e.g. if an insert fails after
-- fetching it) but can never be duplicated or reused — which is exactly
-- the required invariant: deleted numbers stay permanently skipped.

CREATE SEQUENCE IF NOT EXISTS public.orders_display_number_seq;

-- Seed the sequence so the first nextval() continues after the current
-- highest issued number, never re-issuing an already-used one.
DO $$
DECLARE
  current_max bigint;
BEGIN
  SELECT MAX(display_number::bigint) INTO current_max
  FROM public.orders
  WHERE display_number ~ '^[0-9]+$';

  IF current_max IS NOT NULL AND current_max > 0 THEN
    PERFORM setval('public.orders_display_number_seq', current_max, true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.next_order_display_number()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.orders_display_number_seq')::text;
$$;

GRANT EXECUTE ON FUNCTION public.next_order_display_number() TO authenticated;

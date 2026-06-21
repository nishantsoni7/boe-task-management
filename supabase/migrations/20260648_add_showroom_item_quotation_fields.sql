-- Add per-item quotation fields to showroom_inquiry_items.
-- rate_override: salesperson-set price used in quotation PDF instead of mrp_at_time.
-- customization_note: free-text note for this line item (fabric, colour, size, etc.).
-- Both nullable — NULL means "use default" (mrp_at_time / no note).

alter table public.showroom_inquiry_items
  add column if not exists rate_override      numeric(10,2),
  add column if not exists customization_note text;

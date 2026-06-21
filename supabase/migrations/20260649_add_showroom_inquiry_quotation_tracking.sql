-- Add quotation tracking fields to showroom_inquiries.
-- Phase 3 foundation: no UI changes, no PDF changes, no automation.
-- Existing rows safely default to quotation_status = 'draft'.

alter table public.showroom_inquiries
  add column if not exists quotation_no         text,
  add column if not exists quotation_status     text        not null default 'draft',
  add column if not exists quotation_sent_at    timestamptz,
  add column if not exists converted_at         timestamptz,
  add column if not exists lost_at              timestamptz;

-- Enforce allowed values
alter table public.showroom_inquiries
  drop constraint if exists showroom_inquiries_quotation_status_check;

alter table public.showroom_inquiries
  add constraint showroom_inquiries_quotation_status_check
    check (quotation_status in ('draft', 'sent', 'converted', 'lost'));

-- Backfill any rows where quotation_status is somehow null (defensive)
update public.showroom_inquiries
  set quotation_status = 'draft'
  where quotation_status is null;

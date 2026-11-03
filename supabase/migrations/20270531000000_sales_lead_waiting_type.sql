-- 20270531000000_sales_lead_waiting_type.sql
--
-- Sales: a new lead waiting to be allotted, the notice that tells whoever allots (20270531000100, the website capture).
-- Its own file: a new enum value must be committed before anything uses it, and before the app names it.
--
-- ROLLBACK: none needed. An enum value cannot be dropped in place, and an unused one is harmless.

alter type notification_type add value if not exists 'sales_lead_waiting';

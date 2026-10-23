-- Finance cash handover: notification types.
--
-- Postgres cannot use a new enum value in the transaction that adds it, so the
-- values live alone in this migration. It MUST be applied before
-- 20270410000100_finance_cash_handovers.sql and before the code that inserts them.

alter type notification_type add value if not exists 'finance_handover_requested';
alter type notification_type add value if not exists 'finance_handover_accepted';
alter type notification_type add value if not exists 'finance_handover_disputed';
alter type notification_type add value if not exists 'finance_handover_cancelled';
alter type notification_type add value if not exists 'finance_handover_reminder';

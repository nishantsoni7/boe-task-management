-- Sales: the notifications a salesperson and a manager receive.
--
-- Postgres cannot use a new enum value in the transaction that adds it, so the values live alone in this migration.
-- It MUST be applied before the code that names them ships: the Sales feed filters on these values, and an unknown
-- value in that filter fails the whole feed.

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'sales_lead_allotted';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'sales_followups_due';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'sales_first_call_missed';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'sales_lead_enquired_again';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'sales_lead_reminder';

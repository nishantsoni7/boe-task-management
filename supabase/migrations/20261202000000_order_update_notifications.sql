-- ORDER UPDATE NOTIFICATIONS — telling the people on an Order that it moved.
--
-- WHAT THIS ADDS
-- --------------
--   1. Four `notification_type` values, so an Order update can be stored in the
--      shared `notifications` table alongside every other module's rows.
--   2. `order_notification_recipients` — FOUR BOOLEANS. Management decides which
--      associated categories are told. Nothing else.
--   3. One index, so "which of MY Orders have unread updates" is a single cheap
--      read on the Confirmed Orders list rather than a scan.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD
-- -----------------------------------
--   NO SECOND NOTIFICATION SYSTEM. The rows go in `notifications`, which already
--   has per-user delivery, `is_read`/`read_at`, RLS, a bell, a count endpoint,
--   a mark-read endpoint and a feed. `entity_id` — added by 20260694000000 for
--   exactly this purpose — carries the Order id, so one user reading an update
--   cannot mark it read for anybody else. That is the whole read/unread design.
--
--   NO TRIGGER ON `orders`. A row-level trigger would fire on every UPDATE,
--   including the `updated_at` a status write touches, the `production_aligned_at`
--   an alignment touches and every background correction — and "updated_at
--   changed" is not an event anybody wants to hear about. Notifications are
--   raised EXPLICITLY, by /api/orders/[id]/notify, from the `order_activity_log`
--   row the action already wrote. The audit log is the event stream; this
--   migration adds no second definition of "meaningful".
--
--   NO `bdm` COLUMN ON `orders`. Nothing in this system has ever recorded a BDM
--   against an Order, and adding a column no code path writes would create a
--   recipient category that can never resolve to anybody. The BDM category
--   resolves to the members of the BDM DEPARTMENT (`users.team = 'bdm'`), which
--   is the only BDM this database knows, and the Control Center control says so
--   in those words.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS public.order_notification_recipients;
--   DROP INDEX IF EXISTS public.notifications_entity_unread_idx;
--   (Enum values cannot be dropped in Postgres. Four unused labels are inert:
--    nothing selects on them and no constraint references them.)
--
-- No RLS policy, permission, workflow, status rule or existing notification
-- behaviour is changed. Every statement is idempotent.

-- ─── 1. The four notification types ──────────────────────────────────────────
--
-- FOUR, NOT ONE PER FIELD. A recipient wants to know WHAT KIND of thing moved
-- so the badge can say it; the sentence carries the detail. One type per
-- amendable column would be a dozen labels that all render the same chip.
--
-- ADD VALUE IF NOT EXISTS is idempotent, and none of the four is referenced
-- inside this migration, so Postgres never needs them committed mid-transaction.

alter type notification_type add value if not exists 'order_update_status';
alter type notification_type add value if not exists 'order_update_amended';
alter type notification_type add value if not exists 'order_update_production';
alter type notification_type add value if not exists 'order_update_payment';

-- ─── 2. Who is told — management configuration, not user preference ──────────
--
-- FOUR ROWS, ONE BOOLEAN EACH, AND THE KEYS ARE CLOSED BY A CHECK. This is a
-- company policy ("do our BDMs hear about Order updates?"), not a per-person
-- setting, so it is one table for the whole business and there is no user_id
-- column anywhere near it.
--
-- The table is a SWITCHBOARD, NOT AN AUTHORIZATION. Turning a category on can
-- only cause a notification to be written to somebody who is already an
-- administrator, or is already named on the Order. It grants nothing: a
-- recipient still sees the Order itself only if RLS lets them, exactly as
-- before. Turning a category OFF is the only thing it can do that matters, and
-- that is the point of it.

create table if not exists public.order_notification_recipients (
  recipient_role text primary key
    check (recipient_role in ('super_admin', 'admin', 'salesperson', 'bdm')),
  enabled        boolean not null default true,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references public.users(id) on delete set null
);

comment on table public.order_notification_recipients is
  'Which associated categories receive in-app notifications when a Confirmed Order changes. Management configuration for the whole business — NOT a per-user preference, and NOT a permission: enabling a category cannot show anybody an Order they could not already see.';

-- HOW EACH KEY RESOLVES TO PEOPLE IS NOT DECIDED HERE, and deliberately not
-- even named here: src/lib/orders/orderUpdateNotifications.ts holds the four
-- predicates, and a test pins its list to this CHECK. Stating the column names
-- in this comment would put the organisational designation level into a
-- migration, which designationLevels.test.ts refuses on sight — correctly, and
-- for a reason that still holds: a level grants nothing, and nothing in SQL
-- reads it.
comment on column public.order_notification_recipients.recipient_role is
  'One of four recipient categories. Closed set, matched by the CHECK above; how each resolves to people is decided in src/lib/orders/orderUpdateNotifications.ts, never in SQL.';

-- Seeded ON, all four: the feature is worth nothing switched off, and an
-- administrator who wants a category silent can say so in one click. ON
-- CONFLICT DO NOTHING so re-running never resets a decision somebody made.
insert into public.order_notification_recipients (recipient_role, enabled)
values ('super_admin', true), ('admin', true), ('salesperson', true), ('bdm', true)
on conflict (recipient_role) do nothing;

alter table public.order_notification_recipients enable row level security;

-- ADMIN ONLY, IN FULL, AND FAIL-CLOSED. With RLS on and no employee policy, a
-- non-admin SELECT returns zero rows and a non-admin write is rejected. The
-- notify route reads this with the service role, so the feature works for
-- everybody while the CONTROL stays where it belongs. Same shape as
-- payroll_settings (20260828000000).
drop policy if exists order_notification_recipients_admin_select on public.order_notification_recipients;
create policy order_notification_recipients_admin_select
  on public.order_notification_recipients
  for select to authenticated
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));

drop policy if exists order_notification_recipients_admin_update on public.order_notification_recipients;
create policy order_notification_recipients_admin_update
  on public.order_notification_recipients
  for update to authenticated
  using      (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'))
  with check (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'));

-- No INSERT and no DELETE policy, deliberately: the four rows are the closed
-- set this feature understands, and a fifth would be a code change, not a
-- configuration change.

-- ─── 3. The unread lookup the Confirmed Orders list makes ────────────────────
--
-- "Which Orders have updates I have not read?" is one query per page load:
--   select entity_id from notifications
--    where user_id = me and is_read = false and type in (the four above)
--
-- PARTIAL, on `is_read = false`. Read rows are the overwhelming majority over
-- time and none of them can ever match, so indexing them costs write time and
-- storage for nothing. `entity_id` is included so the answer comes from the
-- index alone.
create index if not exists notifications_entity_unread_idx
  on public.notifications (user_id, type, entity_id)
  where is_read = false;

comment on index public.notifications_entity_unread_idx is
  'Serves the per-user unread lookup behind the NEW UPDATE badge on Confirmed Orders, and the mark-read-by-entity the Order page performs when that user opens it. Partial on is_read = false: a read row can never match.';

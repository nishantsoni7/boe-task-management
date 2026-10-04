-- Notifications: one notification per EVENT, per recipient, per type — enforced by the database.
--
-- WHY. A status notice is linked to the activity row (task_activity_log) of the event it announces. Today nothing stops the
-- same event being announced twice: /api/notify-status-update is a plain insert, and the repository's only de-duplication
-- is a read-then-insert (assignment) or a two-minute window (finance), both of which two overlapping requests defeat.
-- A lost response to a status change makes a second send legitimate — the page must be able to announce an event it
-- found after the fact — so sending has to be SAFE TO REPEAT. The event already has a durable identity; this makes it a key.
--
-- WHAT THIS ADDS. One partial UNIQUE index:
--
--     notifications (activity_log_id, user_id, type)  where activity_log_id is not null
--
-- Every writer that sets notifications.activity_log_id writes at most one row per (event, recipient, type) by design:
-- transition_task_review (one row to the other party), /api/cancel-task and /api/restore-task (one recipient each),
-- /api/notify-status-update (one recipient) and the assignment writer (the task's `created` row, once). Rows without an
-- activity id (every other module, and unlinked notices) are outside the index and unaffected. The foreign key is
-- ON DELETE SET NULL, so removing an activity row takes its notices out of the index rather than colliding.
--
-- EXISTING DATA. A unique index cannot be built over duplicates, and this migration will NOT delete anyone's notices to
-- make room. It first COUNTS duplicate (event, recipient, type) groups; if there are any it RAISES, names the count and a
-- few examples, and changes nothing. Whether to keep the earliest and drop the rest is a data decision for the owner,
-- taken after reading the read-only duplicate report that ships with this change.
--
-- ROLLOUT. Either order is safe. The route change treats this index's unique violation as "already announced"; before the
-- index exists that branch is simply never taken. CREATE UNIQUE INDEX takes a lock that blocks writes to `notifications`
-- for the duration of the build (no CONCURRENTLY: migrations run in a transaction) — brief for a table of this size, and
-- the size is part of the read-only report.
--
-- ROLLBACK: `drop index public.notifications_event_once_idx;`
-- Re-runnable: the guard re-checks and `create unique index if not exists` is a no-op the second time.

do $$
declare
  v_groups bigint;
  v_sample text;
begin
  if to_regclass('public.notifications') is null then
    raise exception 'NOTIFICATIONS_EVENT_PREREQUISITE: public.notifications does not exist';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'notifications' and column_name = 'activity_log_id') then
    raise exception 'NOTIFICATIONS_EVENT_PREREQUISITE: apply 20261016000000 (notifications.activity_log_id) first';
  end if;

  select count(*) into v_groups
    from (select 1
            from public.notifications
           where activity_log_id is not null
           group by activity_log_id, user_id, type
          having count(*) > 1) d;

  if v_groups > 0 then
    select string_agg(g.label, '; ' order by g.n desc) into v_sample
      from (select activity_log_id::text || ' / ' || user_id::text || ' / ' || type::text || ' x' || count(*) as label, count(*) as n
              from public.notifications
             where activity_log_id is not null
             group by activity_log_id, user_id, type
            having count(*) > 1
             order by count(*) desc
             limit 5) g;
    raise exception 'NOTIFICATIONS_EVENT_DUPLICATES: % event/recipient/type group(s) already hold more than one notification (event / recipient / type, worst first: %). Review them and remove the extras (keep the earliest) before applying; nothing was changed.',
      v_groups, v_sample
      using errcode = 'P0001';
  end if;
end $$;

create unique index if not exists notifications_event_once_idx
  on public.notifications (activity_log_id, user_id, type)
  where activity_log_id is not null;

comment on index public.notifications_event_once_idx is
  'One notification per activity event, per recipient, per type. A second insert for the same event fails with 23505 on this index; the notification writer treats that as "already announced".';

-- ═══════════════════════════════════════════════════════════════════════════
--  BOE — read-only inspection of run_task_health_check and the notification
--  delivery surface.  Sections A1 … A8.
--
--  STRICTLY READ ONLY.  No CREATE, ALTER, DROP, INSERT, UPDATE, DELETE,
--  TRUNCATE, GRANT, REVOKE, no cron changes, and NO CALL of the function
--  under inspection — it is only ever named in a WHERE clause.
--
--  Safe to run against production.  Run top to bottom in the Supabase SQL
--  Editor and copy back what each section's "COPY BACK" line asks for.
--  An EMPTY result grid is an answer: say "n rows: 0" rather than omitting it.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- A1.  THE FUNCTION ITSELF — signature, security mode, owner, search_path,
--      and the complete definition.  This is the blocker.
-- COPY BACK: the whole grid, and `function_definition` IN FULL AND VERBATIM.
--            Do not trim it — the insert cannot be removed safely without
--            seeing everything around it.
-- ───────────────────────────────────────────────────────────────────────────
select
  p.oid::regprocedure                        as function_signature,
  n.nspname                                  as schema_name,
  p.proname                                  as function_name,
  pg_get_function_identity_arguments(p.oid)  as identity_arguments,
  pg_get_function_result(p.oid)              as returns,
  l.lanname                                  as language,
  case when p.prosecdef then 'SECURITY DEFINER'
       else 'SECURITY INVOKER' end           as security_mode,
  pg_get_userbyid(p.proowner)                as owner,
  p.proconfig                                as config_settings,   -- search_path etc.
  case p.provolatile when 'i' then 'IMMUTABLE'
                     when 's' then 'STABLE'
                     else 'VOLATILE' end     as volatility,
  pg_get_functiondef(p.oid)                  as function_definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid = p.prolang
where p.proname = 'run_task_health_check'
order by n.nspname, p.oid;


-- A1b.  FALLBACK — run ONLY if A1 returned zero rows (the job may be named
--       differently, or live outside `public`).
-- COPY BACK: the whole grid.
select
  n.nspname            as schema_name,
  p.proname            as function_name,
  p.oid::regprocedure  as function_signature,
  l.lanname            as language
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid = p.prolang
where n.nspname not in ('pg_catalog', 'information_schema')
  and l.lanname in ('sql', 'plpgsql')
  and (p.proname ilike '%health%'   or p.proname ilike '%escalat%'
    or p.proname ilike '%overdue%'  or p.proname ilike '%stale%'
    or p.proname ilike '%sweep%'    or p.proname ilike '%digest%')
order by 1, 2;


-- ───────────────────────────────────────────────────────────────────────────
-- A2.  SCHEDULING.  Timing must not change, so it has to be recorded first.
-- ───────────────────────────────────────────────────────────────────────────

-- A2a.  Probe first, so a database without pg_cron does not error.
-- COPY BACK: all three columns.
select
  to_regclass('cron.job')             as cron_job_table,          -- null => pg_cron absent
  to_regclass('cron.job_run_details') as cron_job_run_details,
  (select string_agg(extname || ' ' || extversion, ', ' order by extname)
     from pg_extension)               as installed_extensions;

-- A2b.  Run ONLY if A2a's `cron_job_table` is NOT null.
-- COPY BACK: EVERY row, not only the matching one — a second job may write
--            notifications under another name.
select * from cron.job order by jobid;

-- A2c.  Run ONLY if A2a's `cron_job_run_details` is NOT null.  Recent history,
--       to confirm the job is actually firing and how long it takes.
-- COPY BACK: the whole grid.
select jobid, status, start_time, end_time, return_message
from cron.job_run_details
order by start_time desc
limit 20;


-- ───────────────────────────────────────────────────────────────────────────
-- A3.  OWNERSHIP AND GRANTS.  The migration must restate these exactly.
-- COPY BACK: both grids.
-- ───────────────────────────────────────────────────────────────────────────
select
  p.oid::regprocedure          as function_signature,
  pg_get_userbyid(p.proowner)  as owner,
  coalesce(array_to_string(p.proacl, E'\n'),
           '(no explicit ACL — PostgreSQL default: EXECUTE to PUBLIC)') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'run_task_health_check'
order by 1;

select
  routine_schema, routine_name, grantee, privilege_type, is_grantable
from information_schema.routine_privileges
where routine_name = 'run_task_health_check'
order by grantee, privilege_type;


-- ───────────────────────────────────────────────────────────────────────────
-- A4.  TRIGGERS that touch, or mention, notifications.  A trigger fanning out
--      to a webhook would be a delivery path the application cannot see.
-- COPY BACK: every row.  If none, write "A4: 0 rows".
-- ───────────────────────────────────────────────────────────────────────────
select
  n.nspname as schema_name,
  c.relname as table_name,
  t.tgname  as trigger_name,
  case t.tgenabled when 'O' then 'enabled'  when 'D' then 'disabled'
                   when 'R' then 'replica'  when 'A' then 'always'
                   else t.tgenabled::text end as enabled,
  pg_get_triggerdef(t.oid) as trigger_definition
from pg_trigger t
join pg_class     c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal
  and (c.relname = 'notifications'
    or pg_get_triggerdef(t.oid) ilike '%notification%')
order by 1, 2, 3;


-- ───────────────────────────────────────────────────────────────────────────
-- A5.  OUTBOUND DELIVERY — can the database itself send anything?
-- COPY BACK: all three grids, EMPTY OR NOT.  I cannot tell "empty" from
--            "not run", and an empty grid here is exactly the answer I want.
-- ───────────────────────────────────────────────────────────────────────────

-- A5a.  Extensions capable of outbound HTTP or scheduling.
select e.extname, e.extversion, n.nspname as installed_in
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
where e.extname in ('pg_net', 'http', 'pg_cron', 'supabase_vault', 'wrappers')
order by e.extname;

-- A5b.  Supabase Database Webhook / pg_net entry points, if those schemas exist.
select n.nspname as schema_name, p.proname as function_name
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('supabase_functions', 'net')
order by 1, 2;

-- A5c.  Any function body mentioning notifications AND an outbound call.
select
  n.nspname as schema_name,
  p.proname as function_name,
  l.lanname as language,
  case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_mode
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid = p.prolang
where n.nspname not in ('pg_catalog', 'information_schema')
  and l.lanname in ('sql', 'plpgsql')          -- prosrc for C funcs is a symbol
  and coalesce(p.prosrc, '') ilike '%notification%'
  and (   coalesce(p.prosrc, '') ilike '%net.http%'
       or coalesce(p.prosrc, '') ilike '%http_post%'
       or coalesce(p.prosrc, '') ilike '%http_request%'
       or coalesce(p.prosrc, '') ilike '%supabase_functions%'
       or coalesce(p.prosrc, '') ilike '%webhook%')
order by 1, 2;


-- ───────────────────────────────────────────────────────────────────────────
-- A6.  EVERY FUNCTION THAT INSERTS INTO notifications.
--      Expected: transition_task_review (human-invoked — must keep notifying)
--      and run_task_health_check.  Anything else is an unaccounted writer.
-- COPY BACK: the whole grid.
-- ───────────────────────────────────────────────────────────────────────────
select
  n.nspname as schema_name,
  p.proname as function_name,
  l.lanname as language,
  case when p.prosecdef then 'DEFINER' else 'INVOKER' end as security_mode,
  pg_get_userbyid(p.proowner) as owner
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid = p.prolang
where n.nspname not in ('pg_catalog', 'information_schema')
  and l.lanname in ('sql', 'plpgsql')
  and coalesce(p.prosrc, '') ~* 'insert\s+into\s+(public\.)?"?notifications"?'
order by 1, 2;


-- ───────────────────────────────────────────────────────────────────────────
-- A7.  IS ESCALATION HISTORY STORED ANYWHERE BUT notifications?
--      THIS DECIDES THE MIGRATION.  If task_activity_log already records the
--      job's escalations, the migration only deletes the notification insert.
--      If it does NOT, the notification row is the ONLY record, and deleting
--      the insert would destroy history rather than relocate it — the
--      migration must then add the log write in the same statement.
-- ───────────────────────────────────────────────────────────────────────────

-- A7a.  Probe.  COPY BACK: both values.
select to_regclass('public.task_activity_log') as task_activity_log,
       to_regclass('public.notifications')     as notifications;

-- A7b.  What the activity log records at all.  Run if A7a is not null.
-- COPY BACK: the whole grid.
select action, count(*) as rows,
       min(created_at) as first_seen, max(created_at) as last_seen
from public.task_activity_log
group by action
order by rows desc;

-- A7c.  ★ THE CRITICAL ONE ★  Rows the log holds with NO human actor — i.e.
--       written by the system rather than by a person.
-- COPY BACK: the whole grid, EMPTY OR NOT.  An empty grid means the
--            notification row is the only escalation record that exists.
select action, count(*) as rows,
       min(created_at) as first_seen, max(created_at) as last_seen
from public.task_activity_log
where actor_id is null
group by action
order by rows desc;

-- A7d.  What the job has actually been writing, and when it last ran.
--       `type::text` rather than the enum, so a since-removed label cannot
--       make this error.
-- COPY BACK: the whole grid.
select
  type::text                       as notification_type,
  count(*)                         as rows,
  count(*) filter (where is_read)  as read_rows,
  min(created_at)                  as first_seen,
  max(created_at)                  as last_seen
from public.notifications
where type::text in ('escalation', 'overdue', 'stale_flag',
                     'morning_digest', 'evening_digest')
group by type
order by rows desc;


-- ───────────────────────────────────────────────────────────────────────────
-- A8.  THE notifications TABLE — columns, enum values, indexes, size.
--      The enum labels confirm the five suppressed values still exist and
--      that no sixth system type has appeared; the index list decides whether
--      the proposed indexes are needed at all.
-- COPY BACK: all four grids.
-- ───────────────────────────────────────────────────────────────────────────
select column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'notifications'
order by ordinal_position;

select t.typname as enum_type, e.enumlabel as value, e.enumsortorder as sort_order
from pg_type t
join pg_enum      e on e.enumtypid   = t.oid
join pg_namespace n on n.oid         = t.typnamespace
where n.nspname = 'public' and t.typname = 'notification_type'
order by e.enumsortorder;

select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'notifications'
order by indexname;

select relname as table_name,
       n_live_tup as approx_rows,
       pg_size_pretty(pg_total_relation_size(relid)) as total_size
from pg_stat_user_tables
where schemaname = 'public'
  and relname in ('notifications', 'task_activity_log')
order by relname;

-- ═══════════════════════════ end of A1 … A8 ════════════════════════════════

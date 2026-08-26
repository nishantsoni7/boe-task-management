-- Did the failed 20261013000000 push leave anything behind?
--
-- READ-ONLY. Every statement here is a SELECT. It creates nothing, changes
-- nothing, and deletes nothing, so it is safe to run against the linked project
-- exactly as it is. Run it BEFORE deciding anything about a retry.
--
-- WHY IT IS NEEDED. `supabase migration list` showing
--
--     20261013000000 | (blank)
--
-- means only that no row was recorded in supabase_migrations.schema_migrations.
-- It says nothing about DDL. Whether the objects the migration created before it
-- failed still exist depends on whether the runner wrapped the file in a
-- transaction — and 20261013000000 does not open one of its own. Both outcomes
-- were reproduced locally:
--
--   wrapped     nothing survives; client_name is still NOT NULL
--   unwrapped   the table and both RPCs survive; client_name is already nullable
--
-- EITHER ANSWER IS FINE. The corrected migration was re-applied over both states
-- and succeeded in both: `create table if not exists`, `create or replace
-- function`, `drop policy if exists`, `create ... if not exists` and an
-- idempotent `drop not null` make it re-runnable. So this is diagnosis, not a
-- gate — it tells you what you are looking at, not whether you may proceed.
--
--   psql "$DATABASE_URL" -f supabase/tests/check_113_residue.sql

\pset border 2
\echo
\echo '── 1. Was 20261013000000 ever recorded as applied? ──'
select version, name
from supabase_migrations.schema_migrations
where version >= '20261012000000'
order by version;

\echo
\echo '── 2. Objects 20261013000000 creates — present or absent? ──'
select 'finance_payment_allocation_intents (table)' as object,
       to_regclass('public.finance_payment_allocation_intents') is not null as present
union all select 'submit_payment_request (rpc)',
       to_regproc('public.submit_payment_request') is not null
union all select 'edit_payment_request (rpc)',
       to_regproc('public.edit_payment_request') is not null
union all select 'apply_payment_allocation_intents (rpc)',
       to_regproc('public.apply_payment_allocation_intents') is not null
union all select 'cancel_intents_on_reject (trigger fn)',
       to_regproc('public.finance_payment_requests_cancel_intents_on_reject') is not null;

\echo
\echo '── 3. Did §1 land? client_name should still be NOT NULL if it did not ──'
select column_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'finance_payment_requests'
  and column_name in ('client_name', 'received_in');

\echo
\echo '── 4. If the table IS present, what privileges does it carry? ──'
\echo '     (the failure was here: authenticated must hold SELECT and nothing else)'
select coalesce(grantee, '(table absent)') as grantee,
       string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name   = 'finance_payment_allocation_intents'
group by grantee
order by grantee;

\echo
\echo '── 5. Any rows in it? (a failed push should have written none) ──'
select case
         when to_regclass('public.finance_payment_allocation_intents') is null
           then 'table absent — nothing to count'
         else (select count(*)::text || ' intent rows'
               from public.finance_payment_allocation_intents)
       end as intent_rows;

\echo
\echo '── 6. Untouched by any of this: the ledger 20261012000000 left ──'
select 'active allocations'  as measure, count(*)::text as value
from public.finance_payment_allocations where status = 'active'
union all
select 'payment requests', count(*)::text from public.finance_payment_requests;

\echo
\echo '── HOW TO READ IT ─────────────────────────────────────────────────────'
\echo '  2 all false + 3 client_name=NO   the failure rolled back cleanly.'
\echo '  2 all true  + 3 client_name=YES  the runner did not wrap the file;'
\echo '                                   the objects are there, unrecorded.'
\echo '  Either way the corrected migration re-applies over it — verified'
\echo '  locally against both states. Section 6 must be unchanged in both.'
\echo

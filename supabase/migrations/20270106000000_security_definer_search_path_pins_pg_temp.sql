-- ═══════════════════════════════════════════════════════════════════════════
-- 20270106000000 — every SECURITY DEFINER in public pins pg_temp last
-- ═══════════════════════════════════════════════════════════════════════════
--
-- AN AUDIT, AND ITS MECHANICAL RESULT. A SELECT-only read of production on
-- 2026-09-25 found 95 SECURITY DEFINER functions in public whose search_path
-- does not name pg_temp. All are owned by postgres, none is an extension
-- member, 19 are trigger functions and 76 are callable:
--
--   87  search_path = public              → public, pg_temp
--    1  search_path = pg_catalog, public  → pg_catalog, public, pg_temp
--    7  NO search_path at all             → public, pg_temp
--
-- ── WHY pg_temp MUST BE NAMED ──────────────────────────────────────────────
--
-- When a function's search_path does not mention pg_temp, Postgres searches
-- the session's temporary schema FIRST for tables, views and types. A SECURITY
-- DEFINER runs as postgres; a caller who can create a temporary table named,
-- say, `users` would have it resolve ahead of public.users inside that
-- definer. Naming pg_temp LAST closes that. It is the pairing the schema's
-- newer definers already use (20261010000000, 20261231000000 onwards).
--
-- The seven with NO search_path are worse: they resolve names through the
-- CALLER's search_path, whatever it is. Six of them are permission resolvers
-- that RLS policies call (module_entry_open, resolve_permission, …), and
-- has_permission() reads `employee_permissions` UNQUALIFIED — the one
-- unqualified relation in any of the seven.
--
-- Exposure today is low: PostgREST sessions cannot run CREATE TEMP TABLE or
-- SET search_path. This is defence in depth, not an incident.
--
-- ── WHY THIS CANNOT CHANGE BEHAVIOUR ───────────────────────────────────────
--
--   * ALTER FUNCTION … SET search_path only. There is no CREATE FUNCTION, so
--     every body is the one production runs now, byte for byte.
--   * For the 88 already pinned: the only resolution that moves is a
--     TEMPORARY object's, from first to last. No body creates or reads one
--     (none mentions temp/temporary/pg_temp, read 2026-09-25).
--   * For the seven unpinned: pg_catalog is always searched implicitly, every
--     relation they name is schema-qualified except has_permission's
--     employee_permissions, which resolves to public.employee_permissions
--     exactly as it does for every real caller today, and auth.uid() is
--     qualified. `public, pg_temp` is what their callers already resolve.
--   * No grant changes, except the one finding below.
--
-- assert_order_amender() is on the list too. 20270105000000 (#211) makes the
-- same change to it. The ALTER is idempotent, so the two files apply in either
-- order.
--
-- ── ONE FINDING FIXED HERE (§2) ────────────────────────────────────────────
--
-- get_or_create_quotation_no(uuid) is a definer that EVERY role could execute,
-- anon included (a PUBLIC grant plus Supabase's default grants), and it checks
-- nobody. Given any uuid, even one naming no inquiry, it still increments
-- showroom_quotation_seq before its UPDATE matches nothing. So anyone holding
-- the public key could burn BOE-QTN numbers without limit. Its only caller is
-- /api/showroom/quotation/[id], which authenticates the person and then calls
-- it with the SERVICE-ROLE client. So EXECUTE is revoked from public, anon and
-- authenticated, and service_role keeps it.
--
-- ── FINDINGS NOT CHANGED HERE (reported in the PR) ─────────────────────────
--
-- Six permission resolvers are executable by anon through the same PUBLIC
-- grant: has_permission, module_entry_open, resolve_effective_permissions,
-- resolve_effective_permissions_for_user, resolve_permission,
-- sample_tracking_module_open. Given a user's uuid, anon can read that user's
-- permission map. Every RLS policy that calls them is TO authenticated, but ~30
-- client call sites reach them, so narrowing their grants is its own change.
-- handle_new_auth_user() exists in production but in NO migration (§1d).
--
-- Four TRIGGER functions also carry an anon grant. That is harmless, because a
-- trigger function cannot be called directly.
--
-- ORDERING. Numbered after 20270105000000 (#211) and after the five unapplied
-- Orders migrations of #202 / #205 / #206 / #209. None of those drops or
-- redefines any function listed here (read 2026-09-25), and every definer they
-- add already pins pg_temp, so the final schema-wide assertion holds whichever
-- lands first. A LATER CREATE OR REPLACE of any function below must restate
-- `set search_path = public, pg_temp`, or it silently undoes this.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.accept_employee_asset_impl(uuid,boolean)',
    'public.accept_employee_asset(uuid,boolean)',
    'public.accept_employee_asset(uuid)',
    'public.add_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date)',
    'public.admin_delete_order_request(uuid,boolean)',
    'public.admin_list_stale_order_request_drafts(integer)',
    'public.allocate_confirmed_order_number()',
    'public.approve_asset_change_request(uuid,text)',
    'public.approve_finance_payment_request(uuid,text)',
    'public.assert_asset_custody_permission(text,text)',
    'public.assert_asset_request_reviewer()',
    'public.assert_order_amender()',
    'public.asset_employee_department(uuid)',
    'public.asset_user_display_name(uuid)',
    'public.assign_asset_code()',
    'public.assign_asset(uuid,uuid,date,text,text,text,text)',
    'public.assign_finance_payment_request_number()',
    'public.assign_order_request_number()',
    'public.begin_test_data_cleanup(text,uuid,text,text)',
    'public.can_access_assets_module()',
    'public.can_manage_access_records()',
    'public.can_read_asset_records()',
    'public.can_review_asset_requests()',
    'public.can_view_asset_inventory()',
    'public.can_write_asset_records()',
    'public.cleanup_top_tasks_on_completion()',
    'public.cleanup_unfinalized_order_request(uuid)',
    'public.complete_asset_service(uuid,date,numeric,text,text,date)',
    'public.convert_order_request_to_order(uuid,uuid[])',
    'public.correct_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date)',
    'public.current_asset_custody(uuid)',
    'public.delete_payroll_period(uuid,smallint,smallint,text,uuid)',
    'public.edit_order_request_attachments(uuid,jsonb,jsonb,uuid[])',
    'public.edit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)',
    'public.execute_test_data_cleanup(text,uuid,text,text)',
    'public.finalize_order_request(uuid)',
    'public.finalize_test_data_cleanup(uuid)',
    'public.get_confirmed_order_number_cycle()',
    'public.get_or_create_quotation_no(uuid)',
    'public.get_test_data_cleanup_settings()',
    'public.has_permission(uuid,text)',
    'public.holds_or_held_asset(uuid)',
    'public.is_eligible_order_assignee(uuid)',
    'public.list_eligible_order_assignees()',
    'public.log_asset_activity(uuid,text,text,uuid,uuid,jsonb)',
    'public.log_asset_change_requested()',
    'public.log_asset_created()',
    'public.log_asset_document_change()',
    'public.log_asset_edited()',
    'public.log_asset_service_change()',
    'public.log_order_request_activity()',
    'public.mark_asset_lost(uuid,text)',
    'public.module_entry_open(text)',
    'public.next_asset_code()',
    'public.next_finance_payment_request_number(integer)',
    'public.next_order_display_number()',
    'public.next_order_request_number(integer)',
    'public.order_request_attachment_writable(uuid)',
    'public.payroll_settlement_lock_guard()',
    'public.permanently_delete_asset(uuid)',
    'public.permanently_disable_test_data_cleanup(text)',
    'public.prevent_assigned_asset_delete()',
    'public.prevent_converted_order_request_delete()',
    'public.prevent_order_delete()',
    'public.preview_test_data_cleanup(text,uuid)',
    'public.reapply_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)',
    'public.record_asset_transfer(uuid,text,uuid,uuid,text,text,text,text,date,text,text,uuid)',
    'public.recover_lost_asset(uuid,uuid,text,text,text)',
    'public.reject_asset_change_request(uuid,text)',
    'public.reject_order_request(uuid,text)',
    'public.release_test_data_cleanup(uuid)',
    'public.remove_asset_document(uuid,text)',
    'public.remove_unfinalized_order_request_attachment(uuid)',
    'public.request_order_request_clarification(uuid,text)',
    'public.resolve_effective_permissions_for_user(uuid)',
    'public.resolve_effective_permissions(uuid,text)',
    'public.resolve_permission(uuid,text,text)',
    'public.resolve_test_data_cleanup_chain(text,uuid)',
    'public.respond_to_clarification(uuid,text,text,uuid,date,date,numeric,numeric,text,text)',
    'public.restore_asset(uuid,text)',
    'public.resubmit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)',
    'public.retire_asset(uuid,boolean,text)',
    'public.return_asset(uuid,text,text,text,date)',
    'public.sample_tracking_module_open()',
    'public.search_test_data_cleanup_roots(text)',
    'public.send_asset_for_repair(uuid,text,text,text,text,date,text)',
    'public.set_asset_activity_source(text,uuid)',
    'public.set_asset_edit_logging(boolean)',
    'public.set_next_confirmed_order_number(bigint)',
    'public.stamp_test_data_flag()',
    'public.transfer_asset(uuid,uuid,text,date,text,text)',
    'public.validate_order_request_assignee()',
    'public.validate_task_team_department()',
    'public.validate_user_team_department()'
  ] loop
    if to_regprocedure(v_fn) is null then
      raise exception 'DEPENDENCY MISSING: % does not exist', v_fn;
    end if;
  end loop;
end $$;


-- ═══ 1. Pin pg_temp last ════════════════════════════════════════════════════

-- ── 1a. The 6 that set no search_path at all (the seventh is §1d) ──────────
alter function public.has_permission(uuid,text) set search_path = public, pg_temp;
alter function public.module_entry_open(text) set search_path = public, pg_temp;
alter function public.resolve_effective_permissions_for_user(uuid) set search_path = public, pg_temp;
alter function public.resolve_effective_permissions(uuid,text) set search_path = public, pg_temp;
alter function public.resolve_permission(uuid,text,text) set search_path = public, pg_temp;
alter function public.sample_tracking_module_open() set search_path = public, pg_temp;

-- ── 1b. The one that names pg_catalog first ───────────────────────────────
alter function public.cleanup_top_tasks_on_completion() set search_path = pg_catalog, public, pg_temp;

-- ── 1c. The 87 pinned to public alone ──────────────────────────────────────
alter function public.accept_employee_asset_impl(uuid,boolean) set search_path = public, pg_temp;
alter function public.accept_employee_asset(uuid,boolean) set search_path = public, pg_temp;
alter function public.accept_employee_asset(uuid) set search_path = public, pg_temp;
alter function public.add_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date) set search_path = public, pg_temp;
alter function public.admin_delete_order_request(uuid,boolean) set search_path = public, pg_temp;
alter function public.admin_list_stale_order_request_drafts(integer) set search_path = public, pg_temp;
alter function public.allocate_confirmed_order_number() set search_path = public, pg_temp;
alter function public.approve_asset_change_request(uuid,text) set search_path = public, pg_temp;
alter function public.approve_finance_payment_request(uuid,text) set search_path = public, pg_temp;
alter function public.assert_asset_custody_permission(text,text) set search_path = public, pg_temp;
alter function public.assert_asset_request_reviewer() set search_path = public, pg_temp;
alter function public.assert_order_amender() set search_path = public, pg_temp;
alter function public.asset_employee_department(uuid) set search_path = public, pg_temp;
alter function public.asset_user_display_name(uuid) set search_path = public, pg_temp;
alter function public.assign_asset_code() set search_path = public, pg_temp;
alter function public.assign_asset(uuid,uuid,date,text,text,text,text) set search_path = public, pg_temp;
alter function public.assign_finance_payment_request_number() set search_path = public, pg_temp;
alter function public.assign_order_request_number() set search_path = public, pg_temp;
alter function public.begin_test_data_cleanup(text,uuid,text,text) set search_path = public, pg_temp;
alter function public.can_access_assets_module() set search_path = public, pg_temp;
alter function public.can_manage_access_records() set search_path = public, pg_temp;
alter function public.can_read_asset_records() set search_path = public, pg_temp;
alter function public.can_review_asset_requests() set search_path = public, pg_temp;
alter function public.can_view_asset_inventory() set search_path = public, pg_temp;
alter function public.can_write_asset_records() set search_path = public, pg_temp;
alter function public.cleanup_unfinalized_order_request(uuid) set search_path = public, pg_temp;
alter function public.complete_asset_service(uuid,date,numeric,text,text,date) set search_path = public, pg_temp;
alter function public.convert_order_request_to_order(uuid,uuid[]) set search_path = public, pg_temp;
alter function public.correct_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date) set search_path = public, pg_temp;
alter function public.current_asset_custody(uuid) set search_path = public, pg_temp;
alter function public.delete_payroll_period(uuid,smallint,smallint,text,uuid) set search_path = public, pg_temp;
alter function public.edit_order_request_attachments(uuid,jsonb,jsonb,uuid[]) set search_path = public, pg_temp;
alter function public.edit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text) set search_path = public, pg_temp;
alter function public.execute_test_data_cleanup(text,uuid,text,text) set search_path = public, pg_temp;
alter function public.finalize_order_request(uuid) set search_path = public, pg_temp;
alter function public.finalize_test_data_cleanup(uuid) set search_path = public, pg_temp;
alter function public.get_confirmed_order_number_cycle() set search_path = public, pg_temp;
alter function public.get_or_create_quotation_no(uuid) set search_path = public, pg_temp;
alter function public.get_test_data_cleanup_settings() set search_path = public, pg_temp;
alter function public.holds_or_held_asset(uuid) set search_path = public, pg_temp;
alter function public.is_eligible_order_assignee(uuid) set search_path = public, pg_temp;
alter function public.list_eligible_order_assignees() set search_path = public, pg_temp;
alter function public.log_asset_activity(uuid,text,text,uuid,uuid,jsonb) set search_path = public, pg_temp;
alter function public.log_asset_change_requested() set search_path = public, pg_temp;
alter function public.log_asset_created() set search_path = public, pg_temp;
alter function public.log_asset_document_change() set search_path = public, pg_temp;
alter function public.log_asset_edited() set search_path = public, pg_temp;
alter function public.log_asset_service_change() set search_path = public, pg_temp;
alter function public.log_order_request_activity() set search_path = public, pg_temp;
alter function public.mark_asset_lost(uuid,text) set search_path = public, pg_temp;
alter function public.next_asset_code() set search_path = public, pg_temp;
alter function public.next_finance_payment_request_number(integer) set search_path = public, pg_temp;
alter function public.next_order_display_number() set search_path = public, pg_temp;
alter function public.next_order_request_number(integer) set search_path = public, pg_temp;
alter function public.order_request_attachment_writable(uuid) set search_path = public, pg_temp;
alter function public.payroll_settlement_lock_guard() set search_path = public, pg_temp;
alter function public.permanently_delete_asset(uuid) set search_path = public, pg_temp;
alter function public.permanently_disable_test_data_cleanup(text) set search_path = public, pg_temp;
alter function public.prevent_assigned_asset_delete() set search_path = public, pg_temp;
alter function public.prevent_converted_order_request_delete() set search_path = public, pg_temp;
alter function public.prevent_order_delete() set search_path = public, pg_temp;
alter function public.preview_test_data_cleanup(text,uuid) set search_path = public, pg_temp;
alter function public.reapply_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text) set search_path = public, pg_temp;
alter function public.record_asset_transfer(uuid,text,uuid,uuid,text,text,text,text,date,text,text,uuid) set search_path = public, pg_temp;
alter function public.recover_lost_asset(uuid,uuid,text,text,text) set search_path = public, pg_temp;
alter function public.reject_asset_change_request(uuid,text) set search_path = public, pg_temp;
alter function public.reject_order_request(uuid,text) set search_path = public, pg_temp;
alter function public.release_test_data_cleanup(uuid) set search_path = public, pg_temp;
alter function public.remove_asset_document(uuid,text) set search_path = public, pg_temp;
alter function public.remove_unfinalized_order_request_attachment(uuid) set search_path = public, pg_temp;
alter function public.request_order_request_clarification(uuid,text) set search_path = public, pg_temp;
alter function public.resolve_test_data_cleanup_chain(text,uuid) set search_path = public, pg_temp;
alter function public.respond_to_clarification(uuid,text,text,uuid,date,date,numeric,numeric,text,text) set search_path = public, pg_temp;
alter function public.restore_asset(uuid,text) set search_path = public, pg_temp;
alter function public.resubmit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text) set search_path = public, pg_temp;
alter function public.retire_asset(uuid,boolean,text) set search_path = public, pg_temp;
alter function public.return_asset(uuid,text,text,text,date) set search_path = public, pg_temp;
alter function public.search_test_data_cleanup_roots(text) set search_path = public, pg_temp;
alter function public.send_asset_for_repair(uuid,text,text,text,text,date,text) set search_path = public, pg_temp;
alter function public.set_asset_activity_source(text,uuid) set search_path = public, pg_temp;
alter function public.set_asset_edit_logging(boolean) set search_path = public, pg_temp;
alter function public.set_next_confirmed_order_number(bigint) set search_path = public, pg_temp;
alter function public.stamp_test_data_flag() set search_path = public, pg_temp;
alter function public.transfer_asset(uuid,uuid,text,date,text,text) set search_path = public, pg_temp;
alter function public.validate_order_request_assignee() set search_path = public, pg_temp;
alter function public.validate_task_team_department() set search_path = public, pg_temp;
alter function public.validate_user_team_department() set search_path = public, pg_temp;


-- ── 1d. handle_new_auth_user(): production drift, pinned where it exists ───
--
-- No migration in this repository creates it. In production it was created
-- outside the migration history and fires AFTER INSERT ON auth.users
-- (on_auth_user_created). A fresh replay does not have it, so it is pinned
-- only if present. Its body qualifies public.users and swallows every error
-- (WHEN OTHERS THEN RETURN NEW), so pinning its path cannot fail a signup.

do $$
begin
  if to_regprocedure('public.handle_new_auth_user()') is not null then
    alter function public.handle_new_auth_user() set search_path = public, pg_temp;
  end if;
end $$;


-- ═══ 2. get_or_create_quotation_no is for the server only ═══════════════════

revoke execute on function public.get_or_create_quotation_no(uuid)
  from public, anon, authenticated;
grant  execute on function public.get_or_create_quotation_no(uuid)
  to service_role;


-- ─── Assertions ─────────────────────────────────────────────────────────────
--
-- Read-only. They fail the migration rather than let a partially applied state
-- look successful.

do $$
declare
  v_bad text;
begin
  -- EVERY DEFINER IN public NAMES pg_temp, AND NAMES IT LAST. Stated for the
  -- whole schema rather than for the list above, so a definer this file did
  -- not know about is caught here, not in production.
  select string_agg(p.oid::regprocedure::text || ' ' || coalesce(array_to_string(p.proconfig, ','), '<none>'), '; ' order by p.proname)
    into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.prosecdef
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
        where c like 'search_path=%'
          and c like '%pg_temp'
     );
  if v_bad is not null then
    raise exception 'definer search_path: these definers do not end their search_path with pg_temp: %', v_bad;
  end if;

  -- AND THE 93 THIS FILE PINNED SAY EXACTLY public, pg_temp — nothing
  -- was widened on the way.
  select string_agg(v_fn, ', ')
    into v_bad
    from unnest(array[
      'public.has_permission(uuid,text)',
      'public.module_entry_open(text)',
      'public.resolve_effective_permissions_for_user(uuid)',
      'public.resolve_effective_permissions(uuid,text)',
      'public.resolve_permission(uuid,text,text)',
      'public.sample_tracking_module_open()',
      'public.accept_employee_asset_impl(uuid,boolean)',
      'public.accept_employee_asset(uuid,boolean)',
      'public.accept_employee_asset(uuid)',
      'public.add_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date)',
      'public.admin_delete_order_request(uuid,boolean)',
      'public.admin_list_stale_order_request_drafts(integer)',
      'public.allocate_confirmed_order_number()',
      'public.approve_asset_change_request(uuid,text)',
      'public.approve_finance_payment_request(uuid,text)',
      'public.assert_asset_custody_permission(text,text)',
      'public.assert_asset_request_reviewer()',
      'public.assert_order_amender()',
      'public.asset_employee_department(uuid)',
      'public.asset_user_display_name(uuid)',
      'public.assign_asset_code()',
      'public.assign_asset(uuid,uuid,date,text,text,text,text)',
      'public.assign_finance_payment_request_number()',
      'public.assign_order_request_number()',
      'public.begin_test_data_cleanup(text,uuid,text,text)',
      'public.can_access_assets_module()',
      'public.can_manage_access_records()',
      'public.can_read_asset_records()',
      'public.can_review_asset_requests()',
      'public.can_view_asset_inventory()',
      'public.can_write_asset_records()',
      'public.cleanup_unfinalized_order_request(uuid)',
      'public.complete_asset_service(uuid,date,numeric,text,text,date)',
      'public.convert_order_request_to_order(uuid,uuid[])',
      'public.correct_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date)',
      'public.current_asset_custody(uuid)',
      'public.delete_payroll_period(uuid,smallint,smallint,text,uuid)',
      'public.edit_order_request_attachments(uuid,jsonb,jsonb,uuid[])',
      'public.edit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)',
      'public.execute_test_data_cleanup(text,uuid,text,text)',
      'public.finalize_order_request(uuid)',
      'public.finalize_test_data_cleanup(uuid)',
      'public.get_confirmed_order_number_cycle()',
      'public.get_or_create_quotation_no(uuid)',
      'public.get_test_data_cleanup_settings()',
      'public.holds_or_held_asset(uuid)',
      'public.is_eligible_order_assignee(uuid)',
      'public.list_eligible_order_assignees()',
      'public.log_asset_activity(uuid,text,text,uuid,uuid,jsonb)',
      'public.log_asset_change_requested()',
      'public.log_asset_created()',
      'public.log_asset_document_change()',
      'public.log_asset_edited()',
      'public.log_asset_service_change()',
      'public.log_order_request_activity()',
      'public.mark_asset_lost(uuid,text)',
      'public.next_asset_code()',
      'public.next_finance_payment_request_number(integer)',
      'public.next_order_display_number()',
      'public.next_order_request_number(integer)',
      'public.order_request_attachment_writable(uuid)',
      'public.payroll_settlement_lock_guard()',
      'public.permanently_delete_asset(uuid)',
      'public.permanently_disable_test_data_cleanup(text)',
      'public.prevent_assigned_asset_delete()',
      'public.prevent_converted_order_request_delete()',
      'public.prevent_order_delete()',
      'public.preview_test_data_cleanup(text,uuid)',
      'public.reapply_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)',
      'public.record_asset_transfer(uuid,text,uuid,uuid,text,text,text,text,date,text,text,uuid)',
      'public.recover_lost_asset(uuid,uuid,text,text,text)',
      'public.reject_asset_change_request(uuid,text)',
      'public.reject_order_request(uuid,text)',
      'public.release_test_data_cleanup(uuid)',
      'public.remove_asset_document(uuid,text)',
      'public.remove_unfinalized_order_request_attachment(uuid)',
      'public.request_order_request_clarification(uuid,text)',
      'public.resolve_test_data_cleanup_chain(text,uuid)',
      'public.respond_to_clarification(uuid,text,text,uuid,date,date,numeric,numeric,text,text)',
      'public.restore_asset(uuid,text)',
      'public.resubmit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)',
      'public.retire_asset(uuid,boolean,text)',
      'public.return_asset(uuid,text,text,text,date)',
      'public.search_test_data_cleanup_roots(text)',
      'public.send_asset_for_repair(uuid,text,text,text,text,date,text)',
      'public.set_asset_activity_source(text,uuid)',
      'public.set_asset_edit_logging(boolean)',
      'public.set_next_confirmed_order_number(bigint)',
      'public.stamp_test_data_flag()',
      'public.transfer_asset(uuid,uuid,text,date,text,text)',
      'public.validate_order_request_assignee()',
      'public.validate_task_team_department()',
      'public.validate_user_team_department()'
    ]) v_fn
   where (select p.proconfig from pg_proc p where p.oid = to_regprocedure(v_fn))
         is distinct from array['search_path=public, pg_temp'];
  if v_bad is not null then
    raise exception 'definer search_path: not exactly public, pg_temp: %', v_bad;
  end if;
  if (select p.proconfig from pg_proc p where p.oid = 'public.cleanup_top_tasks_on_completion()'::regprocedure)
     is distinct from array['search_path=pg_catalog, public, pg_temp'] then
    raise exception 'definer search_path: cleanup_top_tasks_on_completion must keep pg_catalog first';
  end if;
  if to_regprocedure('public.handle_new_auth_user()') is not null
     and (select p.proconfig from pg_proc p where p.oid = to_regprocedure('public.handle_new_auth_user()'))
         is distinct from array['search_path=public, pg_temp'] then
    raise exception 'definer search_path: handle_new_auth_user is present but not pinned to public, pg_temp';
  end if;

  -- §2: THE QUOTATION NUMBER IS THE SERVER'S. The route calls it as service_role.
  if has_function_privilege('anon', 'public.get_or_create_quotation_no(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.get_or_create_quotation_no(uuid)', 'EXECUTE') then
    raise exception 'definer search_path: get_or_create_quotation_no is still executable by a client role';
  end if;
  if not has_function_privilege('service_role', 'public.get_or_create_quotation_no(uuid)', 'EXECUTE') then
    raise exception 'definer search_path: service_role LOST get_or_create_quotation_no; the quotation route would fail';
  end if;

  -- AND NOTHING ELSE'S DOOR MOVED: the permission resolvers the app calls as
  -- the signed-in user are still callable by that user.
  if not (has_function_privilege('authenticated', 'public.resolve_permission(uuid, text, text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.resolve_effective_permissions(uuid, text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.resolve_effective_permissions_for_user(uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.module_entry_open(text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.has_permission(uuid, text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.sample_tracking_module_open()', 'EXECUTE')) then
    raise exception 'definer search_path: a permission resolver lost its grant to authenticated';
  end if;
end $$;

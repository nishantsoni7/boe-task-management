# SECURITY DEFINER search_path audit (2026-09-25)

Source: a SELECT-only read of production (`supabase db query --linked`) on 2026-09-25 for every
`SECURITY DEFINER` function in `public` whose `search_path` does not name `pg_temp`. The fix is
`supabase/migrations/20270125000000_security_definer_search_path_pins_pg_temp.sql`, and the forward
guard is `src/lib/securityDefinerSearchPath.test.ts`.

## Why it matters

- If a function's `search_path` omits `pg_temp`, Postgres searches the session's temporary schema
  **first** for relations. A definer runs as `postgres`, so a temporary table can shadow a real one
  inside it.
- If a function has **no** `search_path`, it resolves through the caller's path.
- On a disposable stack, a SQL session running as `authenticated` made `has_permission()` return `true`
  for a permission never granted, using a temporary `employee_permissions` table. After the fix the
  same attempt returns `false`.
- The app's API path (PostgREST) cannot create temporary tables or set `search_path`, so this is
  defence in depth, not an exploitable hole today.

## Summary

| | count |
|---|---|
| functions found | 95 |
| `search_path = public` → `public, pg_temp` | 87 |
| `search_path = pg_catalog, public` → `pg_catalog, public, pg_temp` | 1 |
| no `search_path` → `public, pg_temp` | 7 |
| trigger functions | 19 |
| callable by `anon` (non-trigger) | 7 |
| callable by `authenticated` | 59 |

All are owned by `postgres`, and none is an extension member. No body mentions temporary objects.

## Findings

1. **`get_or_create_quotation_no(uuid)`: fixed in this PR.**
   - `PUBLIC`, `anon` and `authenticated` could execute it, and it checks nobody.
   - Given any uuid, it increments `showroom_quotation_seq` even when no inquiry matches. Anyone with the
     public key could burn quotation numbers.
   - The only caller is `/api/showroom/quotation/[id]`, which uses the service-role client.
   - Now executable by `service_role` only.
2. **Six permission resolvers are executable by `anon`: not changed.**
   - The functions: `has_permission`, `module_entry_open`, `resolve_effective_permissions`,
     `resolve_effective_permissions_for_user`, `resolve_permission`, `sample_tracking_module_open`.
   - Given a user's uuid, anon can read that user's permission map.
   - Every RLS policy that calls them is `TO authenticated`.
   - About 30 client call sites reach them. Narrowing the grant needs its own check of those paths.
3. **`handle_new_auth_user()` exists only in production.**
   - It fires on `auth.users` (`on_auth_user_created`), and no migration creates it.
   - The migration pins it only if present.
   - Bringing it into the migration history is a separate task.
4. **How regressions happen.** `assert_order_amender()` had `pg_temp` (20260818000000) and lost it when
   20260901000000 re-created it with `set search_path = public`. The new test reads every later
   migration and fails on any definer, or any `ALTER … SET search_path`, that does not end with `pg_temp`.

## Every function

| function | kind | before | after | anon | authenticated | notes |
|---|---|---|---|---|---|---|
| `accept_employee_asset_impl(uuid,boolean)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `accept_employee_asset(uuid,boolean)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `accept_employee_asset(uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `add_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `admin_delete_order_request(uuid,boolean)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `admin_list_stale_order_request_drafts(integer)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `allocate_confirmed_order_number()` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `approve_asset_change_request(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `approve_finance_payment_request(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `assert_asset_custody_permission(text,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `assert_asset_request_reviewer()` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `assert_order_amender()` | plpgsql | `public` | `public, pg_temp` | — | yes | same change in #211 (idempotent) |
| `asset_employee_department(uuid)` | sql | `public` | `public, pg_temp` | — | — |  |
| `asset_user_display_name(uuid)` | sql | `public` | `public, pg_temp` | — | — |  |
| `assign_asset_code()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `assign_asset(uuid,uuid,date,text,text,text,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `assign_finance_payment_request_number()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `assign_order_request_number()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `begin_test_data_cleanup(text,uuid,text,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `can_access_assets_module()` | sql | `public` | `public, pg_temp` | — | yes |  |
| `can_manage_access_records()` | sql | `public` | `public, pg_temp` | — | yes |  |
| `can_read_asset_records()` | sql | `public` | `public, pg_temp` | — | yes |  |
| `can_review_asset_requests()` | sql | `public` | `public, pg_temp` | — | yes |  |
| `can_view_asset_inventory()` | sql | `public` | `public, pg_temp` | — | yes |  |
| `can_write_asset_records()` | sql | `public` | `public, pg_temp` | — | yes |  |
| `cleanup_top_tasks_on_completion()` | trigger | `pg_catalog, public` | `pg_catalog, public, pg_temp` | — | — |  |
| `cleanup_unfinalized_order_request(uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `complete_asset_service(uuid,date,numeric,text,text,date)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `convert_order_request_to_order(uuid,uuid[])` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `correct_asset_service_record(uuid,text,text,text,text,date,date,numeric,text,text,date)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `current_asset_custody(uuid)` | sql | `public` | `public, pg_temp` | — | yes |  |
| `delete_payroll_period(uuid,smallint,smallint,text,uuid)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `edit_order_request_attachments(uuid,jsonb,jsonb,uuid[])` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `edit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `execute_test_data_cleanup(text,uuid,text,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `finalize_order_request(uuid)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `finalize_test_data_cleanup(uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `get_confirmed_order_number_cycle()` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `get_or_create_quotation_no(uuid)` | plpgsql | `public` | `public, pg_temp` | yes | yes | **FIXED §2**: executable by anon/authenticated with no check; burns BOE-QTN numbers. Now service_role only |
| `get_test_data_cleanup_settings()` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `handle_new_auth_user()` | trigger | `(none: caller's path)` | `public, pg_temp` | yes | yes | **Drift**: in production, in no migration; pinned only if present; anon grant, harmless on a trigger |
| `has_permission(uuid,text)` | sql | `(none: caller's path)` | `public, pg_temp` | yes | yes | reads `employee_permissions` unqualified; temp-table shadowing demonstrated before, closed after; anon-executable (finding, not changed) |
| `holds_or_held_asset(uuid)` | sql | `public` | `public, pg_temp` | — | yes |  |
| `is_eligible_order_assignee(uuid)` | sql | `public` | `public, pg_temp` | — | yes |  |
| `list_eligible_order_assignees()` | sql | `public` | `public, pg_temp` | — | yes |  |
| `log_asset_activity(uuid,text,text,uuid,uuid,jsonb)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `log_asset_change_requested()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `log_asset_created()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `log_asset_document_change()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `log_asset_edited()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `log_asset_service_change()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `log_order_request_activity()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `mark_asset_lost(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `module_entry_open(text)` | sql | `(none: caller's path)` | `public, pg_temp` | yes | yes | anon-executable (finding, not changed) |
| `next_asset_code()` | sql | `public` | `public, pg_temp` | — | — |  |
| `next_finance_payment_request_number(integer)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `next_order_display_number()` | sql | `public` | `public, pg_temp` | — | — |  |
| `next_order_request_number(integer)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `order_request_attachment_writable(uuid)` | sql | `public` | `public, pg_temp` | — | yes |  |
| `payroll_settlement_lock_guard()` | trigger | `public` | `public, pg_temp` | yes | yes | anon grant, harmless on a trigger |
| `permanently_delete_asset(uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `permanently_disable_test_data_cleanup(text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `prevent_assigned_asset_delete()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `prevent_converted_order_request_delete()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `prevent_order_delete()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `preview_test_data_cleanup(text,uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `reapply_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `record_asset_transfer(uuid,text,uuid,uuid,text,text,text,text,date,text,text,uuid)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `recover_lost_asset(uuid,uuid,text,text,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `reject_asset_change_request(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `reject_order_request(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `release_test_data_cleanup(uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `remove_asset_document(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `remove_unfinalized_order_request_attachment(uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `request_order_request_clarification(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `resolve_effective_permissions_for_user(uuid)` | plpgsql | `(none: caller's path)` | `public, pg_temp` | yes | yes | anon-executable (finding, not changed) |
| `resolve_effective_permissions(uuid,text)` | plpgsql | `(none: caller's path)` | `public, pg_temp` | yes | yes | anon-executable (finding, not changed) |
| `resolve_permission(uuid,text,text)` | sql | `(none: caller's path)` | `public, pg_temp` | yes | yes | anon-executable (finding, not changed) |
| `resolve_test_data_cleanup_chain(text,uuid)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `respond_to_clarification(uuid,text,text,uuid,date,date,numeric,numeric,text,text)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `restore_asset(uuid,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `resubmit_order_request(uuid,text,uuid,date,date,numeric,numeric,text,text)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `retire_asset(uuid,boolean,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `return_asset(uuid,text,text,text,date)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `sample_tracking_module_open()` | sql | `(none: caller's path)` | `public, pg_temp` | yes | yes | anon-executable (finding, not changed) |
| `search_test_data_cleanup_roots(text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `send_asset_for_repair(uuid,text,text,text,text,date,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `set_asset_activity_source(text,uuid)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `set_asset_edit_logging(boolean)` | plpgsql | `public` | `public, pg_temp` | — | — |  |
| `set_next_confirmed_order_number(bigint)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `stamp_test_data_flag()` | trigger | `public` | `public, pg_temp` | — | — |  |
| `transfer_asset(uuid,uuid,text,date,text,text)` | plpgsql | `public` | `public, pg_temp` | — | yes |  |
| `validate_order_request_assignee()` | trigger | `public` | `public, pg_temp` | — | yes |  |
| `validate_task_team_department()` | trigger | `public` | `public, pg_temp` | yes | yes | anon grant, harmless on a trigger |
| `validate_user_team_department()` | trigger | `public` | `public, pg_temp` | yes | yes | anon grant, harmless on a trigger |

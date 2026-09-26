import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const HOOK = fs.readFileSync('src/hooks/queries/useTopTasks.ts', 'utf8')
const MIGRATION_FILE = '20261018000000_unpin_tasks_submitted_for_approval.sql'
const MIGRATION = fs.readFileSync('supabase/migrations/' + MIGRATION_FILE, 'utf8')

test('Top 3 query excludes tasks awaiting approval', () => {
  assert.match(HOOK, /\.neq\('status', 'pending_approval'\)/)
})

test('submitting for approval removes the personal pin transactionally', () => {
  assert.match(
    MIGRATION,
    /new\.status in \('pending_approval', 'completed', 'cancelled'\)/,
  )
  assert.match(MIGRATION, /delete from public\.user_top_tasks where task_id = new\.id/)
})

test('returning to Working does not silently recreate a Top 3 pin', () => {
  assert.doesNotMatch(MIGRATION, /insert\s+into\s+public\.user_top_tasks/i)
})

test('the trigger function is hardened and cannot be called by client roles', () => {
  assert.match(MIGRATION, /security definer/i)
  assert.match(MIGRATION, /set search_path = pg_catalog, public/i)
  assert.match(
    MIGRATION,
    /revoke all on function public\.cleanup_top_tasks_on_completion\(\) from public, anon, authenticated/i,
  )
})

// ─── The corrections ─────────────────────────────────────────────────────────

test('the migration is numbered 118, not the already-taken 117', () => {
  // 20261017000000 belongs to the unapplied customer-review-outreach migration
  // on another branch. Two files sharing a version is a migration-history
  // collision, and this repository has already had to repair one.
  const files = fs.readdirSync('supabase/migrations').filter(f => f.endsWith('.sql'))
  assert.ok(files.includes(MIGRATION_FILE), '118 is present')

  // 117 IS NOW IN THIS TREE, and that is the situation this test was written to
  // survive rather than a violation of it. The two branches have since merged,
  // so the assertion "nothing occupies 117" is no longer the right shape: what
  // the test defends is that THIS migration did not take 117, which is now
  // stated by 117 being present AND belonging to the other module.
  const at117 = files.filter(f => f.startsWith('20261017000000'))
  assert.deepEqual(at117, ['20261017000000_customer_review_outreach.sql'],
    '117 must be the customer-review migration, and only that')
  assert.notEqual(MIGRATION_FILE, at117[0], 'this branch must not occupy 20261017000000')
})

test('no two migrations share a version stamp', () => {
  // The general form of the same rule: whatever this branch is numbered, it
  // may not duplicate a stamp already in the tree.
  const stamps = fs.readdirSync('supabase/migrations')
    .filter(f => /^\d{14}_/.test(f)).map(f => f.slice(0, 14))
  assert.equal(new Set(stamps).size, stamps.length, 'duplicate migration version stamp')
})

test('everything after it is later, unrelated work — it does not apply ahead of any of it', () => {
  // THIS FILE IS NO LONGER THE NEWEST, and that is fine. Later branches have
  // since merged behind it. Each is named on purpose: a stray file landing
  // here unaccounted for still fails this test, which is the property the
  // original "is the newest" assertion was really defending.
  const files = fs.readdirSync('supabase/migrations').filter(f => /^\d{14}_/.test(f)).sort()
  const at = files.indexOf(MIGRATION_FILE)
  assert.ok(at >= 0, '118 is present')
  assert.deepEqual(files.slice(at + 1), [
    '20261020000000_register_image_editor_module.sql',
    '20261021000000_seed_customer_review_test_cards.sql',
    '20261022000000_image_editor_result_history.sql',
    '20261023000000_review_workflow_ai_drafts.sql',
    '20261025000000_review_workflow_remove_legacy_test_data.sql',
    '20261026000000_review_workflow_batch_approval.sql',
    '20261027000000_review_workflow_generation_claims.sql',
    '20261028000000_assets_access_manage_access_records.sql',
    '20261029000000_asset_handover_acknowledgement.sql',
    '20261030000000_review_workflow_deletion_and_replacement.sql',
    '20261031000000_review_workflow_twelve_drafts_editing_and_images.sql',
    '20261101000000_boe_credits_foundation.sql',
    '20261102000000_boe_credits_review_reward.sql',
    '20261103000000_boe_credits_attendance_redemption.sql',
    '20261104000000_boe_credits_phase_1d.sql',
    '20261105000000_holiday_half_day.sql',
    // Employee designation level: one nullable, informational column on
    // public.users, granted to authenticated. Reaches nothing here.
    '20261106000000_employee_designation_level.sql',
    // Review types, batch assignment and the project image library: two new
    // tables of its own, columns on customer_review_test_cards and one on
    // boe_credit_settings. It reaches nothing here.
    '20261107000000_review_types_assignment_and_image_groups.sql',
    // Variable Review Workflow batch size: three CHECKs on its own batch and
    // claim tables widened from 12 to a 6-20 range, two nullable columns added
    // to customer_review_draft_batches, and three of its own functions
    // redefined. It creates no table and reaches nothing here.
    '20261108000000_review_workflow_variable_batch_size.sql',
    // Performance: Personal Performance and Team Performance become separately
    // configurable capabilities. It registers two actions on the existing
    // `performance` permission module and seeds the admin/manager role grants
    // that reproduce today's role checks exactly. It creates no table, alters
    // no table and defines no function, so it reaches nothing asserted here.
    '20261109000000_performance_personal_and_team_capabilities.sql',
    // The forward-only correction to it: Performance management visibility is
    // granted per employee, never inherited from the `manager` role name. It
    // deletes two role_permissions rows and inserts two
    // employee_permission_overrides rows. It creates no table, alters no table
    // and defines no function, so it reaches nothing asserted here.
    '20261110000000_performance_team_visibility_is_granted_not_inherited.sql',
    // The two permission_modules rows whose display_name and description had
    // drifted from src/lib/permissions/modules.ts, moved onto the registry text.
    // Two UPDATE statements against display text. It creates no table, alters no
    // table and defines no function, so it reaches nothing asserted here.
    '20261111000000_permission_module_labels_follow_the_registry.sql',
    // Performance participation: one UPDATE holding a partner out of the
    // measured population, via users.performance_tracking_enabled (20260719000000).
    // A DATA migration — it creates no table, alters no table, defines no
    // function and deletes nothing, so it reaches nothing asserted here.
    '20261112000000_exclude_partner_from_performance_population.sql',
    // Minop Stage 1: raw authenticated webhook audit/quarantine only.
    // It creates one isolated Minop delivery table and does not touch the
    // schema, functions or data asserted by this older migration test.
    '20261113000000_create_minop_webhook_deliveries.sql',
    // Widens the Review Workflow test_body column CHECK from 900 to 1800
    // characters, so a 200-word generation ceiling is not silently capped by
    // storage. One constraint dropped and re-added, wider. It creates no
    // table, alters no other table and defines no function, so it reaches
    // nothing asserted here.
    '20261114000000_review_generation_word_range_and_body_length.sql',
    '20261115000000_minop_attendance_processing.sql',
    '20261118000000_restore_finance_payment_verification_context.sql',
    '20261119000000_order_submission_pi_review_gate_versions_and_production.sql',
    '20261120000000_order_submission_post_approval_edits_use_the_amendment_context.sql',
    // Review is not the Order door: one trigger function on
    // public.order_submissions re-emitted so a PI can be sent for review
    // without its file already carrying the reserved Order number. It creates
    // no table, alters no table, writes no row and adds no trigger, so it
    // reaches nothing asserted here.
    '20261121000000_order_submission_does_not_require_the_reserved_number_before_review.sql',
    // Control Center label wording for the three order-approval
    // capabilities: three permission_actions.display_name UPDATEs. It
    // creates no table, alters no table and defines no function, so it
    // reaches nothing asserted here.
    '20261122000000_order_approval_capability_labels.sql',
    // A new RPC only, the native-share equivalent of the phone-number
    // WhatsApp-opened writer. It creates no table and touches no task, so
    // it reaches nothing asserted here.
    '20261123000000_review_native_share_records_the_open.sql',
    // The PI Excel no longer needs to carry the reserved Order number, and
    // BOE item codes: re-emits assign_order_display_number() and the two PI
    // approval functions, and adds one new table of its own,
    // public.order_product_codes. It touches no task table or function.
    '20261124000000_order_submission_reserved_number_gate_removed_and_boe_item_codes.sql',
    '20261201000000_order_submission_confirmation_required_fields.sql',
    // Confirmed Order update notifications: four notification_type values, one
    // configuration table of its own and one partial index on
    // public.notifications. It touches no task table and no task function.
    '20261202000000_order_update_notifications.sql',
    // Meetings Order discussion evidence: one append-only table of its own
    // (meeting_order_evidence), one private bucket with three storage
    // policies, two new meeting functions, and remove_meeting_order()
    // re-emitted with one more refusal. It reaches nothing asserted here.
    '20261203000000_meeting_order_evidence.sql',
    // Decimal BOE Credits: five credit-amount columns become numeric(12,2) and
    // the credit functions that carried an amount as integer are re-created
    // with numeric amounts, bodies otherwise unchanged. It reaches nothing
    // asserted here.
    '20261204000000_boe_credits_decimal_credits.sql',
    // Custom Review Submissions: one table of its own
    // (customer_review_custom_submissions), one private bucket with one SELECT
    // storage policy, and five new functions. It alters no existing table and
    // redefines no existing function, so it reaches nothing asserted here.
    '20261205000000_customer_review_custom_submissions.sql',
    // The Custom Review phase: reapplication, the monthly submission rules,
    // reviewer notifications, an append-only history table of its own, two
    // boe_credit_settings columns and a booking trigger on
    // customer_review_test_cards. It reaches nothing asserted here.
    '20261206000000_customer_review_custom_reapply_and_monthly_rules.sql',
    // Repair: re-creates customer_review_custom_submissions_trail() so a reapplied
    // event records the right attempt number. One function; it reaches nothing
    // asserted here.
    '20261207000000_customer_review_reapplied_event_attempt_number.sql',
    // BOE Credits redemption switches: two boe_credit_settings columns and a
    // BEFORE INSERT guard on boe_credit_attendance_redemptions. It touches no
    // task table and no task function.
    '20261208000000_boe_credits_redemption_toggles.sql',
    // Review Workflow admin purge of internal test records. It touches no task
    // table and no task function.
    '20261209000000_customer_review_test_card_admin_purge.sql',
    // Minop raw capture by URL path token: widens the
    // minop_webhook_deliveries auth_method CHECK by one value. It reaches
    // nothing asserted here.
    '20261210000000_minop_webhook_url_path_token_auth.sql',
    // Payment decisions belong to payment verifiers: one BEFORE INSERT OR
    // UPDATE trigger on finance_payment_requests and one new RPC,
    // reject_finance_payment_request(). It changes no column, policy or
    // existing function, so it reaches nothing asserted here.
    '20261211000000_finance_payment_decisions_belong_to_verifiers.sql',
    // 20261212000000 re-creates transition_task_review() with the approval
    // notification skipped. It touches neither user_top_tasks nor the
    // completion trigger.
    '20261212000000_task_review_approval_stops_notifying.sql',
    // 20261213000000 adds the Meetings order-discussion workflow: three new
    // tables, one nullable column on meeting_order_evidence and one AFTER INSERT
    // trigger on public.meetings. It touches neither user_top_tasks nor the
    // completion trigger.
    '20261213000000_meeting_order_discussion_workflow.sql',
    // 20261215000000 — one read-only RPC, payment_allocation_ledger_for_correction(uuid),
    // for the Correct Allocation screen. It creates no table, column, policy, grant
    // on a table or permission action, and edits no existing function, so it reaches
    // nothing asserted here.
    '20261215000000_payment_allocation_ledger_for_correction.sql',
    // 20261216000000 — one read-only RPC, received_payment_allocation_targets(uuid[]),
    // for the Confirmed Payments Allocated Against column. It creates no table,
    // column, policy, grant on a table or permission action, and edits no existing
    // function, so it reaches nothing asserted here.
    '20261216000000_received_payment_allocation_targets.sql',
    // 20261217000000 — re-emits update_order_submission_schedule_terms() with the
    // amendment context around its one Order UPDATE. It creates no table,
    // column, policy, grant or permission action; only that one PI function body
    // changes, and nothing asserted here reads it.
    '20261217000000_order_submission_schedule_terms_use_the_amendment_context.sql',
    // 20261218000000 — re-emits finance_payment_deletable_by() and the payment
    // delete guard so a verified payment is permanent unless test data. No table,
    // column, policy, grant or permission action changes; only those two bodies
    // change, and nothing asserted here reads them.
    '20261218000000_finance_verified_payments_are_permanent.sql',
    // 20261219000000 — the launch audit's three gaps (PR #172): wraps the three
    // payment-creation doors and create_order_submission with an idempotency
    // key, adds two client-closed key tables, the rupees-and-paise CHECK on
    // finance_payment_requests.amount and discard_unsaved_order_submission, and
    // closes the direct INSERT on finance_payment_requests. Nothing this file
    // asserts reads any of it.
    '20261219000000_order_submission_unsaved_drafts_and_payment_idempotency.sql',
    // 20261220000000 — Finance → Expenses, Phase 1: two NEW tables
    // (expense_categories, expenses) with their own constraints, indexes, RLS
    // policies and triggers. Purely additive — it alters no existing table,
    // drops nothing, registers no permission module or action, and contains no
    // DML against any business table. It reaches nothing here.
    '20261220000000_finance_expenses.sql',
    // 20261221000000 — drops the declared scale from expenses.amount so an
    // over-precise figure is REFUSED by the CHECK rather than silently rounded.
    // One ALTER COLUMN TYPE on an empty table of its own. It reaches nothing here.
    '20261221000000_expense_amounts_are_never_rounded.sql',
    // 20261222000000 — Expenses Phase 2: the deleted_at/deleted_by tombstone on
    // public.expenses, the new public.expense_drafts table and
    // finalize_expense_draft(). Additive: it creates one table, adds two
    // nullable columns, drops nothing, registers no permission module or
    // action, and runs no DML against any business table. It reaches nothing
    // here.
    '20261222000000_expense_lifecycle.sql',
    // 20261223000000 — revokes EXECUTE on finalize_expense_draft from anon,
    // which 20261222000000 meant to do and did not (it revoked from the
    // pseudo-role public only). One revoke and one grant on one function.
    // No CREATE FUNCTION, no table, no policy, no DML. It reaches nothing here.
    '20261223000000_finalize_expense_draft_is_not_for_anon.sql',
    // 20261224000000 — Order Approval: an explicit, unrevokable
    // orders.approve_order override for the seeded owner account, a guard trigger
    // on employee_permission_overrides scoped to that one row, and the PI decision
    // stamped inside submit_pi_for_review_internal for a submitter who already
    // holds that action. It creates no table, alters no table, registers no new
    // permission module or action, and writes one override row. It reaches nothing
    // here.
    '20261224000000_order_submission_approval_permanent_grant_and_auto_approval.sql',
    '20261225000000_order_submission_pi_header_terms_and_fabric.sql',
    // The PI-level finance verification stops being a requirement: two approval
    // functions re-emitted with one check removed and one added. It reaches
    // nothing here.
    '20261226000000_order_submission_finance_verification_no_longer_required.sql',
    // The Confirmed Order’s fabric and finish approvals: one new append-only
    // table, one new private storage bucket and one write RPC. It re-emits no
    // existing function, adds no column to any existing table, writes no row and
    // drops nothing, so it reaches nothing here.
    '20261227000000_order_fabric_finish_approvals.sql',
    '20261228000000_personal_module_order.sql',
    // The PI-to-operations handoff: two new tables, one trigger on
    // order_pi_versions and two RPCs. It re-emits no existing function,
    // alters no existing table, writes no row and drops nothing, so it
    // reaches nothing here.
    '20261229000000_order_operations_handoff.sql',
    // Order 0524's one-time handoff: one DO block writing one handoff, one
    // history row and one notification for ONE pinned Order. No DDL, and it
    // re-emits nothing, so it reaches nothing here.
    '20261230000000_order_0524_operations_handoff_for_existing_approval.sql',
    // Announcements (20270110000000): three new tables, their functions, a
    // private PDF bucket and its storage policies. Purely additive; it reads
    // public.users and touches nothing this suite is about.
    '20270110000000_announcements.sql',
    // A payment's typed reference is kept in proof_note on insert (trigger), carried
    // forward on unverified rows, and read by pi_submission_payment_summary.
    '20270111120000_finance_payment_reference_survives_verification.sql',
    '20270112000000_order_document_submissions.sql',
    '20270113000000_order_submission_revised_pi_promotes_on_operations_acceptance.sql',
    '20270114000000_order_submission_numbering_at_conversion_and_exception_reasons.sql',
    '20270115000000_order_submission_pi_edit_revisions.sql',
    '20270116000000_order_pi_revision_in_force_at_admin_approval.sql',
    '20270117000000_order_finance_guards_run_as_owner.sql',
    '20270118120000_finance_payment_proof_opens_for_its_reviewers.sql',
    '20270120000000_order_submission_admin_decisions_ask_permissions.sql',
    '20270122000000_order_submission_internal_details.sql',
    // Every SECURITY DEFINER in public pins pg_temp last. THIS ONE DOES
    // REACH the completion trigger, deliberately and only this far: it ALTERs
    // cleanup_top_tasks_on_completion()'s search_path from `pg_catalog,
    // public` to `pg_catalog, public, pg_temp`. The body, the trigger, the
    // revoke and user_top_tasks are unchanged, so what the trigger does is
    // unchanged.
    '20270125000000_security_definer_search_path_pins_pg_temp.sql',
  ],'Image Editor, Review Workflow, Assets & Access, BOE Credits and the half-day holiday work, none of which changes what user_top_tasks or the completion trigger do')
})

test('a one-time cleanup reaches the rows the trigger never could', () => {
  // The trigger only fires on a FUTURE status change, so tasks already
  // submitted, completed or cancelled would keep their pin row forever.
  assert.match(MIGRATION, /delete from public\.user_top_tasks utt/i)
  assert.match(MIGRATION, /using public\.tasks t/i)
  assert.match(
    MIGRATION,
    /t\.status in \('pending_approval', 'completed', 'cancelled'\)/i,
  )
})

test('the cleanup is a delete only — it never invents a pin', () => {
  assert.doesNotMatch(MIGRATION, /insert\s+into\s+public\.user_top_tasks/i)
  assert.doesNotMatch(MIGRATION, /update\s+public\.tasks/i)
})

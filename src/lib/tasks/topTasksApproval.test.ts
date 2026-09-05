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
    // Performance: Personal Performance and Team Performance become separately
    // configurable capabilities. It registers two actions on the existing
    // `performance` permission module and seeds the admin/manager role grants
    // that reproduce today's role checks exactly. It creates no table, alters
    // no table and defines no function, so it reaches nothing asserted here.
    '20261109000000_performance_personal_and_team_capabilities.sql',
  ], 'Image Editor, Review Workflow, Assets & Access, BOE Credits and the half-day holiday work, none of which touches user_top_tasks or the completion trigger')
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

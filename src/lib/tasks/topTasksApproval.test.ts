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

test('it is the newest migration, so it cannot apply ahead of anything', () => {
  const files = fs.readdirSync('supabase/migrations').filter(f => /^\d{14}_/.test(f)).sort()
  assert.equal(files[files.length - 1], MIGRATION_FILE)
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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const HOOK = fs.readFileSync('src/hooks/queries/useTopTasks.ts', 'utf8')
const MIGRATION = fs.readFileSync(
  'supabase/migrations/20261017000000_unpin_tasks_submitted_for_approval.sql',
  'utf8',
)

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

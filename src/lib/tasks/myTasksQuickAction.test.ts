import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { canMarkComplete, canSubmitForApproval } from './taskDetailAccess'

const PAGE = fs.readFileSync('src/app/tasks/my/page.tsx', 'utf8')
const ME = '00000000-0000-4000-8000-000000000001'
const BOSS = '00000000-0000-4000-8000-000000000002'

const task = (over: Record<string, unknown>) => ({
  assigned_to: ME,
  created_by: ME,
  status: 'working',
  acknowledged_at: null,
  task_type: 'general',
  ...over,
})

test('self tasks receive direct completion, not approval submission', () => {
  const self = task({})
  assert.equal(canMarkComplete(self, ME), true)
  assert.equal(canSubmitForApproval(self, ME), false)
})

test('acknowledged delegated tasks receive approval submission, not direct completion', () => {
  const delegated = task({ created_by: BOSS, acknowledged_at: '2026-08-29T09:00:00Z' })
  assert.equal(canMarkComplete(delegated, ME), false)
  assert.equal(canSubmitForApproval(delegated, ME), true)
})

test('unacknowledged delegated tasks cannot bypass acknowledgement from the list', () => {
  const delegated = task({ created_by: BOSS })
  assert.equal(canMarkComplete(delegated, ME), false)
  assert.equal(canSubmitForApproval(delegated, ME), false)
})

test('My Tasks uses the protected review RPC and invalidates Top 3 after either action', () => {
  assert.match(PAGE, /supabase\.rpc\('transition_task_review'/)
  assert.match(PAGE, /p_action: 'submit'/)
  assert.match(PAGE, /queryKey: \['top-tasks', userId\]/)
  assert.match(PAGE, /aria-label=\{onComplete \? 'Complete task' : 'Submit for approval'\}/)
})

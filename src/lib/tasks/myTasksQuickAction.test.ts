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

// ─── The corrections ─────────────────────────────────────────────────────────

test('the double-click lock is a ref, taken before any await', () => {
  // A state-only guard loses the race it exists to prevent: two clicks in one
  // frame both read the pre-render value and both proceed, completing the task
  // twice. The detail page fixed exactly this with a ref, and the quick
  // actions must not reintroduce it.
  assert.match(PAGE, /const quickActionRef = useRef\(false\)/)
  assert.match(PAGE, /if \(quickActionRef\.current\) return/)
  assert.match(PAGE, /quickActionRef\.current = true/)
  assert.match(PAGE, /quickActionRef\.current = false/)
  // And the old state-only guard is gone from both handlers.
  assert.doesNotMatch(PAGE, /viewAsUserId \|\| quickActionTaskId\) return/)
})

test('both quick actions take the lock, and both release it', () => {
  assert.equal((PAGE.match(/if \(quickActionRef\.current\) return/g) ?? []).length, 2)
  assert.equal((PAGE.match(/quickActionRef\.current = true/g) ?? []).length, 2)
  assert.equal((PAGE.match(/quickActionRef\.current = false/g) ?? []).length, 2)
})

test('quick-completing a blocked or waiting task clears the stale reason', () => {
  // applyStatusChange on the detail page clears these; the Waiting / Blocked
  // tab is one of the places this button is reached from, so the row would
  // otherwise keep a blocker that no longer describes anything.
  const handler = PAGE.slice(
    PAGE.indexOf('const handleQuickComplete'),
    PAGE.indexOf('const handleQuickSubmit'),
  )
  assert.ok(handler.length > 0, 'the quick-complete handler is present')
  for (const field of ['blocker_reason', 'waiting_on_type', 'waiting_on_user_id', 'waiting_on_text']) {
    assert.match(handler, new RegExp(field), field + ' is cleared on completion')
  }
  // Cleared in the database write AND in the local patch, so the list and the
  // row agree without a refetch.
  assert.match(handler, /updates\.blocker_reason = null/)
  assert.match(handler, /patch\.blocker_reason = null/)
  assert.match(handler, /updates\.waiting_on_user_id = null/)
  assert.match(handler, /patch\.waiting_on_user_id = null/)
})

test('the completion notification carries the activity row it came from', () => {
  // Without activityLogId the card cannot show the previous status — that
  // value lives only on the activity row the notification links to.
  const handler = PAGE.slice(
    PAGE.indexOf('const handleQuickComplete'),
    PAGE.indexOf('const handleQuickSubmit'),
  )
  assert.match(handler, /\.select\('id'\)/)
  assert.match(handler, /\.single\(\)/)
  assert.match(handler, /activityLogId: logRow\?\.id \?\? null/)
})

test('quick actions are measured under the same perf actions as the detail page', () => {
  assert.match(PAGE, /perfTrack\('task\.complete'\)/)
  assert.match(PAGE, /perfTrack\('task\.status\.update'\)/)
  assert.equal((PAGE.match(/perf\.end\(\)/g) ?? []).length, 2)
})

test('the Action column has room for four buttons', () => {
  // complete/submit + pin + edit + delete at 26px with 2px gaps is 110px
  // exactly. The track carries 124px so the worst case is not flush to the
  // edge, and the width comes out of Priority so the row's total minimum is
  // unchanged and nothing that fitted before can overflow.
  const grid = PAGE.match(/const LIST_GRID_COLUMNS =\s*\n?\s*'([^']+)'/)
  if (!grid) throw new Error('the shared grid constant is missing from My Tasks')
  const found = grid[1].match(/minmax\((\d+)px/g)
  if (!found) throw new Error('the grid declares no minmax tracks')
  const mins = found.map(m => Number((m.match(/\d+/) ?? ['0'])[0]))
  // One fixed 28px star column plus six minmax tracks — seven in all, which is
  // what the task row and the table header both lay out.
  assert.ok(grid[1].startsWith('28px '))
  assert.equal(mins.length, 6)
  assert.equal(mins[mins.length - 1], 124, 'the Action track is 124px')
  assert.equal(28 + mins.reduce((a, b) => a + b, 0), 933, 'the row minimum is unchanged')
})

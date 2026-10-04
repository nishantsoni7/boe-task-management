import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Source contract. The Dashboard resolves currentUserId to the VIEWED user under
// View As, so every write handler on the page must be inert while viewAsUserId
// is set; otherwise an administrator's click would be saved, logged and notified
// as the employee being viewed. My Tasks follows the same rule.
const PAGE = fs.readFileSync('src/app/dashboard/page.tsx', 'utf8').replace(/\r/g, '')

const handler = PAGE.slice(
  PAGE.indexOf('const handleAcknowledge'),
  PAGE.indexOf('const userMap = useMemo'),
)

test('handleAcknowledge refuses outright under View As, before any write', () => {
  assert.ok(handler.length > 0, 'the acknowledge handler is present')
  const guard = handler.indexOf('if (viewAsUserId) return')
  assert.ok(guard >= 0, 'the handler has a viewAsUserId guard')
  // Acknowledge is ONE database call now (acknowledge_task): the guard must precede it, and the handler holds no direct write.
  assert.ok(handler.indexOf('acknowledgeTask(supabase,') > guard, 'the guard comes before the write')
  assert.equal(handler.includes('supabase.from('), false, 'the handler makes no direct table write')
  assert.ok(guard < handler.indexOf('setAcknowledgingIds'), 'the guard comes before any state change')
})

test('the Needs acknowledgement panel gets no handler while viewing as someone else', () => {
  const panel = PAGE.slice(
    PAGE.indexOf('<UnacknowledgedPanel'),
    PAGE.indexOf('<UnacknowledgedPanel') + 600,
  )
  assert.match(panel, /onAcknowledge=\{viewAsUserId \? undefined : handleAcknowledge\}/)
  assert.doesNotMatch(panel, /onAcknowledge=\{handleAcknowledge\}/)
})

test('the task preview panel button stays guarded and the only handler references are guarded', () => {
  const preview = PAGE.slice(PAGE.indexOf('<TaskDetailPanel'))
  assert.match(preview, /onAcknowledge=\{\s*!viewAsUserId &&/)
  // Every use of handleAcknowledge is inside the guarded handler, the panel prop
  // or the preview prop; a new unguarded call site fails here.
  assert.equal((PAGE.match(/handleAcknowledge/g) ?? []).length, 3)
})

test('the Top 3 reorder stays read-only under View As', () => {
  assert.match(PAGE, /if \(!loggedInId \|\| viewAsUserId \|\| reorderingFocus\) return/)
  assert.match(PAGE, /canReorder=\{!viewAsUserId\}/)
})

test('the page has exactly the known write paths: reorder and acknowledge', () => {
  // delete/insert are the reorder. Acknowledge is a single acknowledgeTask() call (acknowledge_task, one transaction) plus the
  // shared notice helper, so the page itself holds no update and no fetch.
  assert.equal((PAGE.match(/\.update\(/g) ?? []).length, 0)
  assert.equal((PAGE.match(/\.rpc\(/g) ?? []).length, 0)
  assert.equal((PAGE.match(/\.delete\(\)/g) ?? []).length, 1)
  assert.equal((PAGE.match(/\.insert\(/g) ?? []).length, 2)
  assert.equal((PAGE.match(/fetch\('\/api\//g) ?? []).length, 0)
  assert.equal((PAGE.match(/acknowledgeTask\(supabase,/g) ?? []).length, 1)
  assert.equal((PAGE.match(/postAcknowledgedNotice\(/g) ?? []).length, 1)
})

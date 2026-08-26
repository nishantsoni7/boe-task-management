// GATE 4 — COPY TASK, end to end.
//
// The copy route creates a task AND notifies its new assignee, in one request.
// The two can succeed independently, so the same three outcomes exist here as
// on the four creation screens — and the response has to let the caller tell
// them apart without guessing.
//
// Run:
//   npx tsx --test src/lib/tasks/copyTaskNotification.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAssignmentNotification,
  type AssignmentNotificationStore,
  type AssignmentTaskRow,
} from '@/lib/tasks/assignmentNotificationWriter.server'
import type { NotificationInsert } from '@/lib/notificationWrites'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const ROUTE  = read('src/app/api/tasks/[id]/copy/route.ts')
const CLIENT = read('src/app/tasks/[id]/page.tsx')

const ADMIN    = '55555555-5555-4555-8555-555555555555'
const ASSIGNEE = '11111111-1111-4111-8111-111111111111'
const NEW_TASK = '66666666-6666-4666-8666-666666666666'

type Stub = AssignmentNotificationStore & { written: NotificationInsert[][] }
function stubStore(opts: { task?: AssignmentTaskRow; existing?: boolean; insertError?: { message: string } } = {}): Stub {
  const written: NotificationInsert[][] = []
  const task = opts.task ?? {
    id: NEW_TASK, title: 'copied task', assigned_to: ASSIGNEE, created_by: ADMIN,
  }
  return {
    written,
    async fetchTask() { return { task, error: null } },
    async isAdmin(u) { return u === ADMIN },
    async hasAssignmentNotification() { return { exists: opts.existing ?? false, readable: true } },
    async insert(rows) { written.push(rows); return { error: opts.insertError ?? null } },
  }
}

// ── The task is created once ─────────────────────────────────────────────────

describe('the copied task is created exactly once', () => {
  test('one insert into tasks, and nothing retries it', () => {
    assert.equal((ROUTE.match(/\.from\('tasks'\)\s*\n\s*\.insert/g) ?? []).length, 1)
    // No loop or retry wraps the creation.
    const at = ROUTE.indexOf(".from('tasks')")
    const before = ROUTE.slice(Math.max(0, at - 400), at)
    assert.equal(/for \(|while \(|retry/i.test(before), false)
  })

  test('a task-insert failure returns 500 and never reaches the notification', () => {
    const insertAt = ROUTE.indexOf('if (taskErr || !newTask)')
    const notifyAt = ROUTE.indexOf('createAssignmentNotification(')
    assert.ok(insertAt > 0 && insertAt < notifyAt)
    const guard = ROUTE.slice(insertAt, insertAt + 300)
    assert.ok(guard.includes('{ status: 500 }'))
    assert.ok(guard.includes('return'))
  })
})

// ── The notification is attempted once, through the one operation ────────────

describe('the assignment notification is attempted once, by the shared operation', () => {
  test('one call, and no direct insert alongside it', () => {
    assert.equal((ROUTE.match(/createAssignmentNotification\(/g) ?? []).length, 1)
    assert.equal(/\.from\(['"]notifications['"]\)/.test(ROUTE), false,
      'the copy route must not write the table itself')
  })

  test('it runs in-process with the service-role client, not by calling its own API', () => {
    assert.ok(ROUTE.includes('supabaseAssignmentStore(supabase)'))
    assert.equal(/fetch\(['"`][^'"`]*notify-assignment/.test(ROUTE), false,
      'no self-call over HTTP — that would be a second client and a second auth hop')
  })

  test('a second client call for the same task cannot create a second row', async () => {
    // Whatever calls it — the copy route in-process, or the browser hitting
    // /notify-assignment afterwards — the duplicate check is the same one.
    const store = stubStore({ existing: true })
    const outcome = await createAssignmentNotification(store, { taskId: NEW_TASK, callerId: ADMIN })
    assert.equal(outcome.status, 'skipped_duplicate')
    assert.equal(store.written.length, 0)
  })

  test('an existing notification is IDEMPOTENT SUCCESS, not an error', async () => {
    const store = stubStore({ existing: true })
    const outcome = await createAssignmentNotification(store, { taskId: NEW_TASK, callerId: ADMIN })
    assert.notEqual(outcome.status, 'error')
    // And the route reports it as notified.
    assert.ok(ROUTE.includes("notified.status === 'created' || notified.status === 'skipped_duplicate'"))
  })
})

// ── The response is accurate ─────────────────────────────────────────────────

describe('assignmentNotified is accurate for every outcome', () => {
  const FIELD = /assignmentNotified:\s*(.+)/.exec(ROUTE)![1]

  test('true only when a notification row exists', () => {
    assert.match(FIELD, /'created'/)
    assert.match(FIELD, /'skipped_duplicate'/)
    assert.equal(/'error'/.test(FIELD), false)
    assert.equal(/'skipped_self'/.test(FIELD), false)
  })

  test('a self-assigned copy reports false, which is the truth', async () => {
    const store = stubStore({
      task: { id: NEW_TASK, title: 'copied task', assigned_to: ADMIN, created_by: ADMIN },
    })
    const outcome = await createAssignmentNotification(store, { taskId: NEW_TASK, callerId: ADMIN })
    assert.equal(outcome.status, 'skipped_self')
    assert.equal(store.written.length, 0)
    // …so the caller reads the pending flag, not assignmentNotified, to decide
    // whether anything is outstanding.
    assert.ok(ROUTE.includes("assignmentNotificationPending: notified.status === 'error'"))
  })

  test('the raw status is returned too, so nothing has to be inferred', () => {
    assert.ok(ROUTE.includes('assignmentNotification: notified.status'))
  })
})

// ── Partial success, not total failure ───────────────────────────────────────

describe('a notification failure is partial success, and costs nobody their copy', () => {
  test('the route returns 200 with the copy, not an error', () => {
    const at = ROUTE.indexOf("if (notified.status === 'error')")
    assert.ok(at > 0)
    const branch = ROUTE.slice(at, ROUTE.indexOf('return NextResponse.json({', at))
    assert.equal(/status: 500|status: 4\d\d/.test(branch), false,
      'a failed notification must not fail the copy')
    assert.equal(/\.delete\(\)|rollback/i.test(branch), false,
      'and must not undo the copied task')
  })

  test('the copied task is never deleted for a notification failure', () => {
    // The route DOES roll the task back if ATTACHMENT copying fails — that is a
    // half-copied task and a different fault. What must never trigger it is the
    // notification, which happens after and is explicitly non-fatal.
    const notifyAt = ROUTE.indexOf('createAssignmentNotification(')
    assert.equal(/\.delete\(\)/.test(ROUTE.slice(notifyAt)), false)
  })

  test('the client shows outcome B instead of a plain success toast', () => {
    assert.ok(CLIENT.includes("assignmentNotification === 'error'"))
    assert.ok(CLIENT.includes('setCopyNotifyFailedFor'))
    assert.ok(CLIENT.includes('AssignmentNotificationNotice'),
      'the same notice the four creation screens use')
    assert.ok(CLIENT.includes('but they were not notified'))
  })

  test('and that notice does not vanish on the ten-second chip timer', () => {
    // `lastCopied` auto-clears; a partial failure must not.
    assert.ok(CLIENT.includes('const [copyNotifyFailedFor'))
    const effect = CLIENT.slice(CLIENT.indexOf('if (!lastCopied) return'), CLIENT.indexOf('if (!lastCopied) return') + 200)
    assert.equal(/copyNotifyFailedFor/.test(effect), false,
      'the auto-clear effect must not touch the partial-failure notice')
  })

  test('retry targets the NEW task, never the source', () => {
    const at = CLIENT.indexOf('setCopyNotifyFailedFor(taskId)')
    assert.ok(at > 0, 'the id passed to retry is the copy response taskId')
    // …and it is the same variable the "View new task" link uses.
    assert.ok(CLIENT.includes('setLastCopied({ id: taskId, name })'))
    // The notice is given that id and nothing else.
    assert.ok(CLIENT.includes('taskId={copyNotifyFailedFor}'))
  })
})

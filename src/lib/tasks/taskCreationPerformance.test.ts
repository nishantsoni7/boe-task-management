/**
 * Task creation critical-path regressions.
 *
 * Two independent findings, both on the AWAITED path of every task creation —
 * the click stays in "Saving…" until each of these settles:
 *
 *   1. createAssignmentNotification ran its duplicate check and its
 *      activity-log lookup SEQUENTIALLY even though neither depends on the
 *      other's answer (both need only the task row already in hand). That
 *      was one full guaranteed round trip on every single task creation,
 *      across all four creation screens, since this operation is what
 *      /api/tasks/:id/notify-assignment calls.
 *
 *   2. /tasks/quotation-requests/new called prepareFiles (which
 *      canvas-compresses every image) THREE times per submission with
 *      attachments — once on file selection, once to "validate" before
 *      insert (discarding the result), and once more to actually prepare the
 *      upload. /tasks/create and /tasks/create-self fixed the same defect
 *      earlier (see their inline comments); this screen was left behind, and
 *      it also awaited its activity-log insert and its notification request
 *      one after another instead of together, unlike every sibling screen.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskCreationPerformance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createAssignmentNotification,
  type AssignmentNotificationStore,
  type AssignmentTaskRow,
} from './assignmentNotificationWriter.server'
import type { NotificationInsert } from '@/lib/notificationWrites'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/** Source with comments stripped, so a comment mentioning a call never counts as one. */
const codeOf = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const TASK      = '33333333-3333-4333-8333-333333333333'
const ASSIGNEE  = '11111111-1111-4111-8111-111111111111'
const CREATOR   = '22222222-2222-4222-8222-222222222222'

// ── 1. The two independent server-side reads run together ──────────────────

describe('createAssignmentNotification runs its independent reads concurrently', () => {
  /** A store whose two independent reads record WHEN they started and finished. */
  function timingStore(delayMs: number): AssignmentNotificationStore & { calls: { name: string; start: number; end: number }[] } {
    const calls: { name: string; start: number; end: number }[] = []
    const timed = async <T>(name: string, value: T): Promise<T> => {
      const start = Date.now()
      await new Promise(r => setTimeout(r, delayMs))
      calls.push({ name, start, end: Date.now() })
      return value
    }
    return {
      calls,
      async fetchTask() {
        return {
          task: { id: TASK, title: 't', assigned_to: ASSIGNEE, created_by: CREATOR } as AssignmentTaskRow,
          error: null,
        }
      },
      async isAdmin() { return false },
      async hasAssignmentNotification() {
        return timed('dup', { exists: false, readable: true })
      },
      async findCreationActivityId() {
        return timed('activity', 'activity-log-id')
      },
      async insert(rows: NotificationInsert[]) { void rows; return { error: null } },
    }
  }

  test('the duplicate check and the activity lookup overlap, rather than one waiting on the other', async () => {
    const store = timingStore(40)
    const startedAt = Date.now()
    const outcome = await createAssignmentNotification(store, { taskId: TASK, callerId: CREATOR })
    const totalMs = Date.now() - startedAt

    assert.equal(outcome.status, 'created')
    assert.equal(store.calls.length, 2)

    // Two sequential 40ms reads would take ~80ms+; run together they take
    // ~40ms. A generous ceiling avoids flaking on a loaded CI box while still
    // catching a regression back to sequential awaits (which would be ~80ms+).
    assert.ok(totalMs < 70, `expected the two reads to overlap (~40ms), took ${totalMs}ms`)

    // Direct proof of overlap: the second call to start began before the
    // first had finished.
    const [first, second] = [...store.calls].sort((a, b) => a.start - b.start)
    assert.ok(second.start < first.end, 'the second read must start before the first one ends')
  })

  test('the source runs them through one Promise.all, not two sequential awaits', () => {
    const src = codeOf(read('src/lib/tasks/assignmentNotificationWriter.server.ts'))
    assert.ok(/const \[dup, activityLogId\] = await Promise\.all\(\[/.test(src),
      'the duplicate check and the activity lookup must be issued together')
    // The historical bug: two separate `await store.X(...)` lines in sequence.
    assert.equal(
      /await store\.hasAssignmentNotification\([^)]*\)\s*\n\s*if[\s\S]{0,200}const activityLogId = await store\.findCreationActivityId/.test(src),
      false,
      'must not regress to sequential awaits',
    )
  })
})

// ── 2. Every attachment-bearing creation screen compresses at most twice ───
//
// Once on selection (immediate feedback: size, rejected types) and once more
// at submit (the authoritative pass, reused for both the size gate and the
// upload) — the same two-call shape /tasks/create and /tasks/create-self
// already use. A THIRD call anywhere in one screen's own source is the
// regression: it means a validate-only call and an upload-only call both ran
// prepareFiles instead of sharing one result.

describe('attachment-bearing creation screens compress at most twice per submission', () => {
  const SCREENS = [
    'src/app/tasks/create/page.tsx',
    'src/app/tasks/create-self/page.tsx',
    'src/app/tasks/quotation-requests/new/page.tsx',
  ]

  for (const path of SCREENS) {
    test(`${path} calls prepareFiles at most twice`, () => {
      const src = codeOf(read(path))
      const calls = src.match(/\bprepareFiles\(/g) ?? []
      assert.ok(calls.length <= 2,
        `${path} calls prepareFiles ${calls.length} times — expected at most 2 ` +
        '(once on selection for live feedback, once at submit reused for the upload)')
    })
  }

  test('quotation-requests/new no longer discards a validate-only prepareFiles result', () => {
    // The regression, named precisely: a call whose destructured `ready` was
    // never used because a second call re-did the work to get it.
    const src = codeOf(read('src/app/tasks/quotation-requests/new/page.tsx'))
    assert.equal(/const \{ error: prepErr \} = await prepareFiles/.test(src), false,
      'a prepareFiles call must not discard its `ready` result')
    assert.ok(src.includes('const { ready: readyAttachments, error: prepErr } = await prepareFiles(attachFiles)'))
    assert.ok(src.includes('for (const file of readyAttachments)'),
      'the upload loop must reuse the validated set, not recompress')
  })
})

// ── 3. Every creation screen parallelises its two independent writes ───────

describe('every creation screen runs its activity log and its notification together', () => {
  const SCREENS = [
    // /tasks/create and /tasks/create-self no longer wait on the notification at
    // all: it starts only once the activity row exists and is never awaited —
    // src/lib/tasks/taskCreateFlow.test.ts pins that stronger shape.
    'src/app/tasks/quotation-requests/new/page.tsx',
    'src/app/tasks/assigned-by-me/page.tsx',
    'src/components/meetings/MeetingTaskModal.tsx',
  ]

  for (const path of SCREENS) {
    test(`${path} does not sequentially await the activity log then the notification`, () => {
      const src = codeOf(read(path))
      // create-self assigns to nobody but itself, so it never calls
      // requestAssignmentNotification at all — nothing to parallelise.
      if (!src.includes('requestAssignmentNotification(task.id)')) return
      assert.equal(
        /task_activity_log['"]\)\s*\n\s*\.insert\([\s\S]{0,200}\}\)\s*\n\s*(\/\/[^\n]*\n\s*)*const notified = await requestAssignmentNotification/.test(src),
        false,
        `${path} must not await the activity log insert before starting the notification request`,
      )
    })
  }

  test('quotation-requests/new now uses Promise.all, matching every sibling screen', () => {
    const src = codeOf(read('src/app/tasks/quotation-requests/new/page.tsx'))
    assert.ok(src.includes('const [{ error: logErr }, notified] = await Promise.all(['))
    assert.ok(src.includes("supabase.from('task_activity_log').insert("))
    assert.ok(src.includes('requestAssignmentNotification(task.id),'))
  })
})

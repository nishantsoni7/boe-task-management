/**
 * OUTCOME B, RENDERED — plus the retry that resolves it.
 *
 * Three outcomes exist on every creation screen and they must not be confused:
 *
 *   A  the task was NOT created
 *   B  created, but the assignee was not notified
 *   C  both succeeded
 *
 * B borrowing A's wording is the dangerous case: the task exists, so a creator
 * told "Task creation failed" fills the form in again and now there are two.
 * These tests pin the wording and the retry. Since a new task stopped notifying
 * its assignee, the four creation screens no longer have an outcome B; the
 * notice remains for a copied task on the task detail page.
 *
 * Run:
 *   npx tsx --test src/components/tasks/AssignmentNotificationNotice.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AssignmentNotificationNotice,
  AssignmentNotificationRecovered,
} from './AssignmentNotificationNotice'
import {
  requestAssignmentNotification,
  ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE,
  ASSIGNMENT_NOTIFICATION_RECOVERED_MESSAGE,
} from '@/lib/tasks/assignmentNotification'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/**
 * The body of each `if (!notified.ok)` branch, and only that.
 *
 * A fixed-width window overruns the closing brace into the SUCCESS path, which
 * made an earlier version of these tests fail on correct code. This walks
 * braces, so a single-line branch is one line and a block branch ends where it
 * actually ends.
 */
function outcomeBBranches(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/if \(!notified\.ok\)\s*/g)) {
    let i = m.index! + m[0].length
    if (src[i] !== '{') { out.push(src.slice(m.index!, src.indexOf('\n', i))); continue }
    let depth = 0
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break } }
    }
    out.push(src.slice(start, i))
  }
  return out
}
const TASK = '99999999-9999-4999-8999-999999999999' // a shape, never a real id

const SCREENS = [
  { name: 'New Task',        path: 'src/app/tasks/create/page.tsx' },
  { name: 'Assigned By Me',  path: 'src/app/tasks/assigned-by-me/page.tsx' },
  { name: 'Quotation',       path: 'src/app/tasks/quotation-requests/new/page.tsx' },
  { name: 'Meeting Task',    path: 'src/components/meetings/MeetingTaskModal.tsx' },
]

// ── The message ──────────────────────────────────────────────────────────────

describe('the outcome-B message says the task EXISTS', () => {
  test('it is the exact sentence, and it leads with what worked', () => {
    assert.equal(ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE,
      'Task created, but the assignee notification could not be sent.')
    assert.ok(ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE.startsWith('Task created'))
  })

  test('it never says creation failed — the duplicate-task trap', () => {
    assert.equal(/creation failed|could not be created|failed to create/i
      .test(ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE), false)
  })

  test('and it reaches the DOM', () => {
    const html = renderToStaticMarkup(
      <AssignmentNotificationNotice taskId={TASK} onResolved={() => {}} onDismiss={() => {}} />)
    assert.ok(html.includes(ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE))
    assert.ok(html.includes('Retry notification'))
    assert.ok(html.includes('role="status"'))
  })

  test('the recovered banner replaces it with plain success', () => {
    const html = renderToStaticMarkup(<AssignmentNotificationRecovered onDismiss={() => {}} />)
    assert.ok(html.includes(ASSIGNMENT_NOTIFICATION_RECOVERED_MESSAGE))
    assert.equal(html.includes(ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE), false)
  })

  test('the notice carries the task id and nothing else about the task', () => {
    const src = read('src/components/tasks/AssignmentNotificationNotice.tsx')
    for (const forbidden of ['taskTitle', 'assigneeId', 'recipient', 'body', 'localStorage', 'sessionStorage']) {
      assert.equal(new RegExp(`\\b${forbidden}\\b`).test(src.replace(/\/\/.*$/gm, '')), false,
        `the notice must not hold ${forbidden}`)
    }
  })
})

// ── Retry ────────────────────────────────────────────────────────────────────

describe('retry sends only the notification request', () => {
  test('it POSTs to the notification route and nothing else', async () => {
    const calls: { url: string; method?: string }[] = []
    const fake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method })
      return new Response(JSON.stringify({ status: 'created' }), { status: 200 }) as Response
    }
    const res = await requestAssignmentNotification(TASK, fake)
    assert.deepEqual(res, { ok: true, status: 'created' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, `/api/tasks/${TASK}/notify-assignment`)
    assert.equal(calls[0].method, 'POST')
  })

  test('RETRY NEVER CREATES ANOTHER TASK — no task-writing call is possible', async () => {
    const urls: string[] = []
    const fake: typeof fetch = async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ status: 'created' }), { status: 200 }) as Response
    }
    // Ten presses.
    for (let i = 0; i < 10; i++) await requestAssignmentNotification(TASK, fake)
    assert.equal(urls.length, 10)
    for (const u of urls) {
      assert.match(u, /\/notify-assignment$/)
      assert.equal(/\/api\/tasks\/?$/.test(u), false, 'never a task-creation endpoint')
    }
    // And the helper itself contains no Supabase or task write at all.
    const src = read('src/lib/tasks/assignmentNotification.ts')
    assert.equal(/\.from\(['"]tasks['"]\)/.test(src), false)
    assert.equal(/\.from\(['"]notifications['"]\)/.test(src), false)
  })

  test('an ALREADY-EXISTING notification is success, not an error', async () => {
    const dup: typeof fetch = async () =>
      new Response(JSON.stringify({ status: 'skipped_duplicate' }), { status: 200 }) as Response
    assert.deepEqual(await requestAssignmentNotification(TASK, dup),
      { ok: true, status: 'skipped_duplicate' })
  })

  test('a self-task skip is success too', async () => {
    const self: typeof fetch = async () =>
      new Response(JSON.stringify({ status: 'skipped_self' }), { status: 200 }) as Response
    assert.deepEqual(await requestAssignmentNotification(TASK, self),
      { ok: true, status: 'skipped_self' })
  })

  test('a failed retry stays failed — the notice keeps the warning up', () => {
    const src = read('src/components/tasks/AssignmentNotificationNotice.tsx')
    // On success it calls onResolved and returns; only then is the warning
    // replaced. Anything else sets retryFailed and leaves the notice mounted.
    assert.ok(src.includes('if (result.ok) { onResolved(); return }'))
    assert.ok(src.includes('setRetryFailed(true)'))
    // The parent, not the notice, decides what replaces it — and only on resolve.
    assert.equal(/onDismiss\(\)/.test(src.slice(src.indexOf('const retry'), src.indexOf('return ('))), false,
      'a failed retry must not dismiss the notice')
  })
})

// ── The creation screens ─────────────────────────────────────────────────────
//
// A new task is silent (taskNotificationPolicy.ts), so no creation screen asks
// for an assignment notification and outcome B cannot arise there any more.
// What is left is A and C. The notice itself is still used by the task detail
// page for a copied task — see copyTaskNotification.test.ts.

describe('every creation screen distinguishes A and C, and has no outcome B', () => {
  for (const { name, path } of SCREENS) {
    const src = read(path)

    test(`${name}: A — a creation failure still uses the error path`, () => {
      assert.ok(/setSaveError|setSubmitError|setError\(/.test(src),
        'the screen has a real creation-failure path')
      // …and that path is reached from the task insert.
      const insertFail = src.indexOf('if (error') >= 0 ? src.indexOf('if (error') : src.indexOf('if (taskErr')
      assert.ok(insertFail > 0, 'the task insert error is handled')
    })

    test(`${name}: no notification is requested, so no "not notified" notice exists`, () => {
      assert.equal(outcomeBBranches(src).length, 0)
      assert.equal(src.includes('requestAssignmentNotification'), false)
      assert.equal(src.includes('AssignmentNotificationNotice'), false)
      assert.equal(src.includes(ASSIGNMENT_NOTIFICATION_FAILED_MESSAGE), false)
    })

    test(`${name}: C — the ordinary success path is untouched`, () => {
      assert.ok(/setSuccess\(true\)|onCreated\(/.test(src))
    })
  }
})

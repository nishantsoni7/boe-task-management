// The admin side of attendance requests: the list, the review drawer, the page
// and the old deep link. Source-reading, like the other screen suites here: the
// facts worth pinning are which rules the screens keep, not their pixels.
//
// Run: npx tsx --test src/components/attendanceRequests/adminRequests.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const queue = read('src/components/attendanceRequests/RequestQueue.tsx')
const drawer = read('src/components/attendanceRequests/RequestReviewDrawer.tsx')

describe('the admin list', () => {
  test('defaults to Pending, or to All when a notification points at one request', () => {
    assert.match(queue, /useState<FilterKey>\(focusId \? 'all' : 'pending'\)/)
    for (const label of ['Pending', 'Approved', 'Rejected', 'All']) assert.ok(queue.includes(`label: '${label}'`), label)
  })

  test('the empty state says what the brief asks for', () => {
    assert.ok(queue.includes('No pending requests'))
    assert.ok(queue.includes('New attendance requests will appear here.'))
  })

  test('filters narrow one list; they are not another row of page tabs', () => {
    assert.equal(queue.includes('role="tablist"'), false)
  })

  test('a slow answer for a filter the admin has left is ignored', () => {
    assert.match(queue, /if \(ticket !== latest\.current\) return/)
  })

  test('the request a notification links to is scrolled to, highlighted and opened once', () => {
    assert.match(queue, /const focusRow = focusId && !focusDone/)
    assert.match(queue, /styles\.focusRow/)
    assert.match(queue, /const reviewing = picked \?\? focusRow/)
  })

  test('submission timing uses the shared three-way wording', () => {
    assert.match(queue, /SUBMISSION_TIMING_LABEL\[submissionTiming\(r\)\]/)
    assert.match(drawer, /SUBMISSION_TIMING_LABEL\[submissionTiming\(row\)\]/)
  })
})

describe('the review drawer', () => {
  test('rejecting, and changing an earlier decision, still need a reason', () => {
    assert.match(drawer, /const noteRequired = mode === 'rejected' \|\| revising/)
    assert.match(drawer, /Add a reason/)
  })

  test('an admin cannot decide their own request, and cancelled ones are closed', () => {
    assert.match(drawer, /const canApprove = !own && row\.status !== 'cancelled' && row\.status !== 'approved'/)
    assert.match(drawer, /const canReject\s+= !own && row\.status !== 'cancelled' && row\.status !== 'rejected'/)
  })

  test('repeat taps are ignored while saving, by a ref', () => {
    assert.match(drawer, /const inFlight = useRef\(false\)/)
    assert.match(drawer, /if \(!mode \|\| inFlight\.current\) return/)
  })

  test('keeps the audit history and follows the form-modal dismissal rule', () => {
    assert.match(drawer, /RequestHistoryList/)
    assert.match(drawer, /shouldCloseFormModal\('escape'\)/)
    assert.match(drawer, /Deliberately no click handler/)
  })

  test('a failed decision keeps the remark and the mode, so the admin can retry', () => {
    const confirmFn = drawer.slice(drawer.indexOf('const confirm = async'), drawer.indexOf('const employee ='))
    assert.match(confirmFn, /setError\(message\)/)
    assert.equal(/setNote\(''\)|setMode\(null\)/.test(confirmFn), false)
  })
})

describe('the requests page and its old deep link', () => {
  test('the page renders the list only and hands ?request= to it', () => {
    const page = read('src/app/attendance/requests/page.tsx')
    assert.equal(page.includes('PayrollAttendanceReview'), false)
    assert.equal(page.includes('role="tablist"'), false)
    assert.match(page, /focusId=\{params\.get\('request'\)\}/)
    assert.match(page, /view=decisions/)
  })

  test('/attendance/requests?tab=review redirects to its new home', () => {
    const cfg = read('next.config.ts')
    assert.match(cfg, /source: '\/attendance\/requests'/)
    assert.match(cfg, /key: 'tab', value: 'review'/)
    assert.match(cfg, /destination: '\/attendance\/monthly-review\?view=decisions'/)
  })

  test('the review view is hosted by Monthly Review, on the shared month', () => {
    const page = read('src/app/attendance/monthly-review/page.tsx')
    assert.match(page, /<PayrollAttendanceReview getToken=\{getToken\} year=\{year\} month=\{month\} \/>/)
  })
})

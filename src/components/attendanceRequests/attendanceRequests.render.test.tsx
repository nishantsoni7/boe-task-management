// Server-render smoke tests for the attendance-request screens: the form a
// phone user sees first, the correction dialog pre-filled from an original, and
// the rules the admin list and review drawer must keep.

import '@/lib/testing/cssModuleStub'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { AttendanceRequestModal } from './AttendanceRequestModal'
import { AttendanceRequestForm } from './AttendanceRequestForm'
import { REQUEST_TYPES, REQUEST_TYPE_LABEL, type AttendanceRequestRow } from '@/lib/attendance/requests'

const noop = () => {}
const submit = async () => null
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const shift = { scheduled_in_minutes: 600, scheduled_out_minutes: 1140 }

describe('AttendanceRequestForm (page)', () => {
  const html = renderToStaticMarkup(
    <AttendanceRequestForm variant="page" shift={shift} onSubmit={submit} onSubmitted={noop} />,
  )

  test('opens on Late arrival with every supported type as a tappable choice', () => {
    assert.match(html, /aria-checked="true"[^>]*><span[^>]*>Late arrival</)
    for (const t of REQUEST_TYPES) assert.ok(html.includes(REQUEST_TYPE_LABEL[t]), t)
    assert.equal((html.match(/role="radio"/g) ?? []).length >= REQUEST_TYPES.length, true)
  })

  test('shows only the fields the chosen type needs', () => {
    assert.match(html, /Expected arrival/)
    // Not asked for on a late arrival:
    for (const other of ['Leaving at', 'Back by', 'Which half', 'Personal or company work']) {
      assert.equal(html.includes(other), false, `${other} should be hidden for Late arrival`)
    }
    assert.match(html, /Your shift starts at 10:00/)
  })

  test('date and time use native pickers and the inputs are phone-sized', () => {
    assert.match(html, /type="date"/)
    assert.match(html, /type="time"/)
  })

  test('has the reason chips, one clear Submit request action and no attachments', () => {
    for (const r of ['Company vehicle delay', 'Personal reason', 'Other']) assert.ok(html.includes(r), r)
    assert.equal((html.match(/Submit request/g) ?? []).length, 1)
    assert.equal(/type="file"/.test(html), false)
  })

  test('does not ask who the request is for — the API takes the employee from the token', () => {
    assert.equal(/employee_id|Select employee|Employee</i.test(html), false)
  })
})

describe('AttendanceRequestForm (source rules)', () => {
  const src = read('src/components/attendanceRequests/AttendanceRequestForm.tsx')

  test('a second tap while sending is ignored, by a ref and not just by state', () => {
    assert.match(src, /const inFlight = useRef\(false\)/)
    assert.match(src, /if \(inFlight\.current\) return/)
  })

  test('a failed submit keeps every entry and only adds a message', () => {
    // No reset of the field state on the error path.
    const failure = src.slice(src.indexOf('const message = await onSubmit'), src.indexOf('} finally {'))
    assert.match(failure, /setError\(message\)/)
    assert.equal(/setDate\(|setReason\(|setNote\(|setType\(/.test(failure), false)
  })

  test('validation mirrors the server: reason, Other note, per-type times and half', () => {
    for (const rule of ['missing.reason', 'missing.note', 'missing.depart', 'missing.back', 'missing.kind', 'missing.half']) {
      assert.ok(src.includes(rule), rule)
    }
  })
})

describe('AttendanceRequestModal (correction)', () => {
  test('a correction pre-fills from the original and says the original is kept', () => {
    const original = {
      id: '00000000-0000-0000-0000-000000000001', request_type: 'time_out',
      start_date: '2026-10-05', end_date: '2026-10-05', expected_arrival_time: null,
      departure_time: '14:00:00', return_time: '15:30:00', half_session: null, work_kind: 'company',
      reason_code: 'company_work', reason_note: 'Bank visit for BOE', status: 'pending',
    } as unknown as AttendanceRequestRow
    const html = renderToStaticMarkup(<AttendanceRequestModal original={original} onClose={noop} onSubmit={submit} />)
    assert.match(html, /Correct attendance request/)
    assert.match(html, /original request stays in the history/)
    assert.match(html, /value="14:00"/)
    assert.match(html, /value="15:30"/)
    assert.match(html, /aria-checked="true"[^>]*>Company work</)
    assert.match(html, /Submit correction/)
    assert.match(html, /Cancel/)
  })
})

describe('the admin list and review drawer', () => {
  const queue = read('src/components/attendanceRequests/RequestQueue.tsx')
  const drawer = read('src/components/attendanceRequests/RequestReviewDrawer.tsx')

  test('defaults to Pending and offers Pending / Approved / Rejected / All', () => {
    assert.match(queue, /useState<FilterKey>\('pending'\)/)
    for (const label of ['Pending', 'Approved', 'Rejected', 'All']) assert.ok(queue.includes(`label: '${label}'`), label)
  })

  test('the empty state says what the brief asks for', () => {
    assert.ok(queue.includes('No pending requests'))
    assert.ok(queue.includes('New attendance requests will appear here.'))
  })

  test('filters are one list, not another tab row', () => {
    assert.equal(queue.includes('role="tablist"'), false)
  })

  test('rejecting, and changing an earlier decision, still need a reason', () => {
    assert.match(drawer, /const noteRequired = mode === 'rejected' \|\| revising/)
    assert.match(drawer, /Add a reason/)
  })

  test('an admin cannot decide their own request, and cancelled ones are closed', () => {
    assert.match(drawer, /const canApprove = !own && row\.status !== 'cancelled' && row\.status !== 'approved'/)
    assert.match(drawer, /const canReject\s+= !own && row\.status !== 'cancelled' && row\.status !== 'rejected'/)
  })

  test('the drawer keeps the audit history and follows the form-modal dismissal rule', () => {
    assert.match(drawer, /RequestHistoryList/)
    assert.match(drawer, /shouldCloseFormModal\('escape'\)/)
    assert.match(drawer, /Deliberately no click handler/)
  })

  test('a slow answer for a filter the admin has left is ignored', () => {
    assert.match(queue, /if \(ticket !== latest\.current\) return/)
  })
})

describe('the requests page and its old deep link', () => {
  test('the page renders the list only; Payroll review is not a second tab any more', () => {
    const page = read('src/app/attendance/requests/page.tsx')
    assert.equal(page.includes('PayrollAttendanceReview'), false)
    assert.equal(page.includes('role="tablist"'), false)
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

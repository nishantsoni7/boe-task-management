// Server-render smoke tests for the attendance-request screens: the form a
// phone user sees first, and the correction form pre-filled from an original.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { AttendanceRequestModal } from './AttendanceRequestModal'
import type { AttendanceRequestRow } from '@/lib/attendance/requests'

const noop = () => {}
const submit = async () => null

describe('AttendanceRequestModal', () => {
  test('opens on Late arrival: type, date, optional time, the reason chips and Submit', () => {
    const html = renderToStaticMarkup(<AttendanceRequestModal onClose={noop} onSubmit={submit} />)
    assert.match(html, /Attendance request/)
    assert.match(html, /aria-checked="true"[^>]*>Late arrival</)
    assert.match(html, /Expected arrival \(optional\)/)
    for (const r of ['Company vehicle delay', 'Personal reason', 'Other']) assert.ok(html.includes(r), r)
    assert.match(html, /Submit request/)
    // Nothing to upload: attachments are not asked for.
    assert.equal(/type="file"/.test(html), false)
  })

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
  })
})

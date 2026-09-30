// Server-render smoke tests for the attendance-request form: what a phone user
// sees first, the fields each tile reveals, and the correction pre-fill.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { AttendanceRequestModal } from './AttendanceRequestModal'
import type { AttendanceRequestRow } from '@/lib/attendance/requests'

const noop = () => {}
const submit = async () => null

/** Values of the checked radios, in document order. */
const checked = (html: string) =>
  [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)]
    .map(m => m[0]).filter(t => /checked=""/.test(t)).map(t => /value="([^"]*)"/.exec(t)![1])

const render = (original?: AttendanceRequestRow) =>
  renderToStaticMarkup(<AttendanceRequestModal original={original} onClose={noop} onSubmit={submit} />)

describe('AttendanceRequestModal', () => {
  test('opens with the title, subtitle, four tiles, one date control, a reason dropdown and Send request', () => {
    const html = render()
    assert.match(html, /Attendance request/)
    assert.match(html, /Request leave or permission for a change in your working hours\./)
    for (const t of ['Leave', 'Coming late', 'Leaving early', 'Going out briefly']) assert.ok(html.includes(`>${t}<`), t)
    // Coming late is preselected and shows its optional time only.
    assert.match(html, /Expected arrival time \(optional\)/)
    assert.equal(/Planned departure time/.test(html), false)
    assert.equal(/Which half/.test(html), false)
    // Date shortcuts, and a single date value shown as text until "Another date".
    for (const d of ['Today', 'Tomorrow', 'Another date']) assert.ok(html.includes(`>${d}<`), d)
    assert.equal((html.match(/type="date"/g) ?? []).length, 0)
    assert.match(html, /Send request/)
    assert.equal(/type="file"/.test(html), false, 'no attachment is asked for')
  })

  test('the reason is ONE labelled dropdown with no default, listing every existing category', () => {
    const html = render()
    assert.match(html, /<select[^>]*aria-required="true"/)
    // The empty placeholder is the selected option, so no real category is a default.
    assert.match(html, /<option value="" disabled="" selected="">Select a reason<\/option>/)
    assert.equal(/<option value="[a-z_]+"[^>]*selected/.test(html), false, 'nothing is pre-selected')
    for (const r of ['Company vehicle delay', 'Company work', 'Personal reason', 'Medical', 'Family emergency', 'Traffic / transport', 'Other'])
      assert.ok(html.includes(`>${r}</option>`), r)
    // The old reason pills are gone.
    assert.equal(/aria-label="Reason"/.test(html), false)
  })

  test('required fields carry a red asterisk; the note is behind "Add a note"', () => {
    const html = render()
    assert.match(html, /class="boe-req-star"[^>]*> \*<\/span>/)
    assert.match(html, />\s*Add a note\s*</)
    assert.equal(/<textarea/.test(html), false, 'the textarea is hidden until asked for')
  })

  test('no employee, approver, attachment or pay-status field exists', () => {
    const html = render()
    assert.equal(/approver|employee|pay status|paid|unpaid/i.test(html.replace(/<option[^>]*>[^<]*<\/option>/g, '')), false)
  })

  test('a correction pre-fills from the original and says the original is kept', () => {
    const original = {
      id: '00000000-0000-0000-0000-000000000001', request_type: 'time_out',
      start_date: '2025-01-06', end_date: '2025-01-06', expected_arrival_time: null,
      departure_time: '14:00:00', return_time: '15:30:00', half_session: null, work_kind: 'company',
      reason_code: 'company_work', reason_note: 'Bank visit for BOE', status: 'pending',
    } as unknown as AttendanceRequestRow
    const html = render(original)
    assert.match(html, /Correct attendance request/)
    assert.match(html, /original request stays in the history/)
    assert.match(html, /value="14:00"/)
    assert.match(html, /value="15:30"/)
    assert.match(html, /<option value="company_work" selected=""/)
    assert.ok(checked(html).includes('out'))
    assert.match(html, /Bank visit for BOE/)
    // 6 Jan 2025 is in the past: the date picker is open and the form says why it matters.
    assert.match(html, /type="date"/)
    assert.match(html, /marked as sent after the event/)
    assert.match(html, /Send correction/)
  })

  test('a half-day request opens under Leave with Half day selected and its half choice', () => {
    const original = {
      id: '00000000-0000-0000-0000-000000000002', request_type: 'half_day',
      start_date: '2099-01-05', end_date: '2099-01-05', expected_arrival_time: null,
      departure_time: null, return_time: null, half_session: 'second_half', work_kind: null,
      reason_code: 'personal', reason_note: null, status: 'pending',
    } as unknown as AttendanceRequestRow
    const html = render(original)
    assert.match(html, /How much of the day\?/)
    assert.match(html, /Which half\?/)
    for (const v of ['leave', 'half', 'second_half']) assert.ok(checked(html).includes(v), v)
  })
})

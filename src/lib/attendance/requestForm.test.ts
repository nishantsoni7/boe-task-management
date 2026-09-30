import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  FORM_TILES,
  buildPayload,
  dateChoice,
  dateShortcuts,
  initialFormState,
  requestTypeFor,
  tileForType,
  validateForm,
  type FormState,
} from './requestForm'
import { REQUEST_TYPES, validateRequestInput } from './requests'

const SHIFT = { scheduled_in_minutes: 600, scheduled_out_minutes: 1140 }
const NOW = new Date('2026-10-05T04:00:00Z')   // 09:30 IST on 5 Oct

const base = (over: Partial<FormState>): FormState => ({ ...initialFormState(NOW), reason: 'personal', ...over })

describe('tiles map onto the existing backend types', () => {
  test('every backend type is reachable and round-trips', () => {
    const reached = new Set<string>()
    for (const tile of FORM_TILES) for (const leave of ['full', 'half'] as const) reached.add(requestTypeFor(tile, leave))
    assert.deepEqual([...reached].sort(), [...REQUEST_TYPES].sort())
    for (const t of REQUEST_TYPES) {
      const { tile, leave } = tileForType(t)
      assert.equal(requestTypeFor(tile, leave), t)
    }
  })
})

describe('Today / Tomorrow in IST', () => {
  test('roll over exactly at IST midnight (18:30 UTC)', () => {
    assert.deepEqual(dateShortcuts(new Date('2026-10-05T18:29:59Z')), { today: '2026-10-05', tomorrow: '2026-10-06' })
    assert.deepEqual(dateShortcuts(new Date('2026-10-05T18:30:00Z')), { today: '2026-10-06', tomorrow: '2026-10-07' })
  })
  test('month and year ends carry', () => {
    assert.deepEqual(dateShortcuts(new Date('2026-12-31T19:00:00Z')), { today: '2027-01-01', tomorrow: '2027-01-02' })
  })
  test('a chosen date stops being "Today" after midnight instead of changing silently', () => {
    const before = new Date('2026-10-05T18:00:00Z')
    const after = new Date('2026-10-05T19:00:00Z')
    assert.equal(dateChoice('2026-10-05', before), 'today')
    assert.equal(dateChoice('2026-10-05', after), 'other')
    assert.equal(dateChoice('2026-10-06', before), 'tomorrow')
    assert.equal(dateChoice('2026-10-06', after), 'today')
  })
  test('the form starts on today in IST, not the device date', () => {
    assert.equal(initialFormState(new Date('2026-10-05T20:00:00Z')).date, '2026-10-06')
  })
})

describe('what is sent', () => {
  test('a tile switch never leaks the previous tile’s values', () => {
    const filled = base({ tile: 'out', depart: '14:00', back: '15:00', kind: 'company', expected: '10:45', half: 'first_half', endDate: '2026-10-08' })
    const late = buildPayload({ ...filled, tile: 'late' })
    assert.equal(late.request_type, 'late_arrival')
    assert.equal(late.departure_time, null)
    assert.equal(late.return_time, null)
    assert.equal(late.work_kind, null)
    assert.equal(late.half_session, null)
    assert.equal(late.end_date, null)
    assert.equal(late.expected_arrival_time, '10:45')

    const half = buildPayload({ ...filled, tile: 'leave', leave: 'half' })
    assert.equal(half.request_type, 'half_day')
    assert.equal(half.half_session, 'first_half')
    assert.equal(half.departure_time, null)
    assert.equal(half.end_date, null)

    const full = buildPayload({ ...filled, tile: 'leave', leave: 'full' })
    assert.equal(full.request_type, 'full_day_leave')
    assert.equal(full.end_date, '2026-10-08')
    assert.equal(full.half_session, null)
    assert.equal(full.expected_arrival_time, null)
  })

  test('every tile’s payload passes the SERVER validation unchanged', () => {
    const cases: FormState[] = [
      base({ tile: 'leave', leave: 'full' }),
      base({ tile: 'leave', leave: 'half', half: 'second_half' }),
      base({ tile: 'late' }),
      base({ tile: 'late', expected: '10:45' }),
      base({ tile: 'early', depart: '17:00' }),
      base({ tile: 'out', depart: '14:00', back: '15:30', kind: 'personal' }),
    ]
    for (const c of cases) {
      assert.deepEqual(validateForm(c), {}, JSON.stringify(c))
      const v = validateRequestInput(buildPayload(c), '2026-10-05', SHIFT)
      assert.equal(v.ok, true, JSON.stringify(v))
    }
  })
})

describe('validation before sending', () => {
  test('no default reason: an untouched form is missing one', () => {
    assert.equal(validateForm(initialFormState(NOW)).reason, 'Choose a reason.')
  })
  test('Other needs a short explanation; other reasons do not', () => {
    assert.ok(validateForm(base({ reason: 'other', note: '  ' })).note)
    assert.equal(validateForm(base({ reason: 'other', note: 'Bank visit' })).note, undefined)
    assert.equal(validateForm(base({ reason: 'medical', note: '' })).note, undefined)
  })
  test('each tile asks only for what it needs', () => {
    assert.equal(validateForm(base({ tile: 'late', expected: '' })).expected, undefined, 'arrival time is optional')
    assert.ok(validateForm(base({ tile: 'early', depart: '' })).depart)
    assert.ok(validateForm(base({ tile: 'leave', leave: 'half', half: '' })).half)
    const out = validateForm(base({ tile: 'out' }))
    assert.ok(out.depart && out.back && out.kind)
  })
  test('going out: the return must be after the departure', () => {
    assert.ok(validateForm(base({ tile: 'out', depart: '15:00', back: '14:00', kind: 'personal' })).back)
    assert.ok(validateForm(base({ tile: 'out', depart: '15:00', back: '15:00', kind: 'personal' })).back)
  })
  test('a multi-day leave cannot end before it starts', () => {
    assert.ok(validateForm(base({ tile: 'leave', leave: 'full', date: '2026-10-08', endDate: '2026-10-07' })).endDate)
  })
  test('a correction pre-fills every field from the original', () => {
    const s = initialFormState(NOW, {
      request_type: 'time_out', start_date: '2026-10-05', end_date: '2026-10-05', expected_arrival_time: null,
      departure_time: '14:00:00', return_time: '15:30:00', half_session: null, work_kind: 'company',
      reason_code: 'company_work', reason_note: 'Bank',
    } as never)
    assert.equal(s.tile, 'out')
    assert.equal(s.depart, '14:00')
    assert.equal(s.back, '15:30')
    assert.equal(s.kind, 'company')
    assert.equal(s.reason, 'company_work')
  })
})

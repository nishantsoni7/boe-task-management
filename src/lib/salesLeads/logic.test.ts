/**
 * Sales, Lead Master: the rules that do not need a database or a screen.
 *
 * Run:
 *   npm run test:file -- src/lib/salesLeads/logic.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { allotStep, changeCameFromKey, isSelectNavigationKey, KEY_CHANGE_WINDOW_MS } from './allot'
import { EMPTY_FORM, formFromLead, numberError, toInput, validateLead, type LeadForm } from './validation'
import { dayLabel, dayLabelLong, editedFields, initialsOf, plural, receivedLabel, whenLabel } from './format'

const MOHIT = '00000000-0000-0000-0000-0000000000c1'
const DHRUV = '00000000-0000-0000-0000-0000000000c2'

describe('picking a name in the dropdown', () => {
  test('a lead nobody holds is allotted at once', () => {
    assert.equal(allotStep(null, MOHIT), 'save')
  })
  test('changing a name that is already there asks first', () => {
    assert.equal(allotStep(MOHIT, DHRUV), 'confirm')
  })
  test('picking the person who already holds it does nothing', () => {
    assert.equal(allotStep(MOHIT, MOHIT), 'nothing')
  })
})

describe('a stray key must not allot a lead', () => {
  test('arrows, Home, End, paging and a typed letter or digit are moving keys', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'a', 'M', '7']) {
      assert.equal(isSelectNavigationKey({ key }), true, key)
    }
  })
  test('the ways of opening the list and choosing from it are not moving keys', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'Shift', 'Backspace', 'F2']) {
      assert.equal(isSelectNavigationKey({ key }), false, key)
    }
    assert.equal(isSelectNavigationKey({ key: 'ArrowDown', altKey: true }), false, 'Alt+Down opens the list')
    assert.equal(isSelectNavigationKey({ key: 'a', ctrlKey: true }), false)
    assert.equal(isSelectNavigationKey({ key: 'a', metaKey: true }), false)
  })
})

describe('which change came from a key, and which from choosing in the list', () => {
  test('a change in the same instant as a moving key is the key\'s doing, and is ignored', () => {
    assert.equal(changeCameFromKey(1000, 1000), true)
    assert.equal(changeCameFromKey(1000, 1000 + KEY_CHANGE_WINDOW_MS - 1), true)
  })
  test('a pick made later, from the open list, is a real pick, even on a Mac where the arrow key opened the list', () => {
    assert.equal(changeCameFromKey(1000, 1000 + KEY_CHANGE_WINDOW_MS), false)
    assert.equal(changeCameFromKey(1000, 1000 + 2500), false)
  })
  test('no moving key yet means every change is a real pick; a clock that runs backwards is not a key either', () => {
    assert.equal(changeCameFromKey(null, 5000), false)
    assert.equal(changeCameFromKey(5000, 4000), false)
  })
})

describe('slips the shared phone rule cannot see', () => {
  test('a 0 left at the front of a number from another country is refused, India\'s own leading 0 is fine', () => {
    assert.equal(numberError('971', '0501234567'), 'Leave out the 0 at the start')
    assert.equal(numberError('44', '07911 123456'), 'Leave out the 0 at the start')
    assert.equal(numberError('971', '50 123 4567'), null)
    assert.equal(numberError('91', '098765 43210'), null)
    assert.equal(numberError('91', '98765 43210'), null)
  })
  test('"Other" needs the country code spelled out with a + (or 00)', () => {
    assert.match(numberError('', '9876543210') ?? '', /^Start with \+/)
    assert.equal(numberError('', '+971 56 732 3638'), null)
    assert.equal(numberError('', '00971 56 732 3638'), null)
  })
  test('a whole +… number typed under any country is taken as typed', () => {
    assert.equal(numberError('971', '+971 56 732 3638'), null)
    assert.equal(numberError('91', '+971 56 732 3638'), null)
  })
  test('everything the shared rule refuses is still refused, with its own words', () => {
    assert.equal(numberError('91', ''), 'Enter the mobile number')
    assert.equal(numberError('91', '12345'), 'Enter a valid mobile number')
    assert.equal(numberError('91', 'abc'), 'Use digits only')
  })
  test('the form uses it', () => {
    assert.equal(validateLead({ ...EMPTY_FORM, countryCode: '971', number: '0501234567', source: 'website' }).number, 'Leave out the 0 at the start')
    assert.deepEqual(validateLead({ ...EMPTY_FORM, countryCode: '971', number: '501234567', source: 'website' }), {})
  })
})

const form = (over: Partial<LeadForm> = {}): LeadForm => ({ ...EMPTY_FORM, number: '98765 43210', source: 'website', ...over })

describe('the Add lead form', () => {
  test('a number and a source are enough', () => {
    assert.deepEqual(validateLead(form()), {})
  })
  test('the number is judged by the Exhibition Leads rule', () => {
    assert.equal(validateLead(form({ number: '' })).number, 'Enter the mobile number')
    assert.equal(validateLead(form({ number: '12345' })).number, 'Enter a valid mobile number')
    assert.equal(validateLead(form({ number: '5876543210' })).number, 'Enter a valid mobile number')
    assert.equal(validateLead(form({ number: 'abc' })).number, 'Use digits only')
    assert.equal(validateLead(form({ countryCode: '', number: '+971 56 732 3638' })).number, undefined)
    assert.equal(validateLead(form({ number: '098765 43210' })).number, undefined)
  })
  test('the source is required', () => {
    assert.ok(validateLead(form({ source: '' })).source)
  })
  test('an email, if given, must look like one', () => {
    assert.equal(validateLead(form({ email: '' })).email, undefined)
    assert.equal(validateLead(form({ email: 'rohan@example.com' })).email, undefined)
    assert.ok(validateLead(form({ email: 'rohan' })).email)
    assert.ok(validateLead(form({ email: 'a b@example.com' })).email)
  })
  test('over-long text is refused, exactly where the database refuses it', () => {
    assert.equal(validateLead(form({ name: 'x'.repeat(120) })).name, undefined)
    assert.ok(validateLead(form({ name: 'x'.repeat(121) })).name)
    assert.equal(validateLead(form({ location: 'x'.repeat(120) })).location, undefined)
    assert.ok(validateLead(form({ location: 'x'.repeat(121) })).location)
    assert.equal(validateLead(form({ requirement: 'x'.repeat(4000) })).requirement, undefined)
    assert.ok(validateLead(form({ requirement: 'x'.repeat(4001) })).requirement)
  })
  test('toInput joins the country code, drops the spaces and trims', () => {
    assert.deepEqual(toInput(form({ name: ' Rohan ', location: ' Jaipur ' })), {
      phone: '+919876543210', source: 'website', name: 'Rohan', email: '', location: 'Jaipur', requirement: '',
    })
    assert.equal(toInput(form({ countryCode: '', number: '+971 56 732 3638' })).phone, '+971567323638')
    assert.equal(toInput(form({ countryCode: '971', number: '56 732 3638' })).phone, '+971567323638')
  })
})

describe('editing a stored lead', () => {
  const stored = { phone: '+919876543210', source: 'whatsapp' as const, name: null, email: null, location: null, requirement: null }
  test('an Indian number fills the box without +91, any other keeps the whole +…', () => {
    assert.deepEqual(formFromLead(stored), { ...EMPTY_FORM, countryCode: '91', number: '9876543210', source: 'whatsapp' })
    const abroad = formFromLead({ ...stored, phone: '+971567323638' })
    assert.equal(abroad.countryCode, '')
    assert.equal(abroad.number, '+971567323638')
  })
  test('what goes in comes back out as the same number', () => {
    for (const phone of ['+919876543210', '+971567323638', '+14155550132']) {
      assert.equal(toInput(formFromLead({ ...stored, phone })).phone, phone)
    }
  })
})

describe('dates and history', () => {
  test('a day reads as 12 Oct 2026, with its weekday when it is the headline', () => {
    assert.equal(dayLabel('2026-10-12'), '12 Oct 2026')
    assert.equal(dayLabelLong('2026-11-02'), 'Mon 2 Nov 2026')
    assert.equal(dayLabelLong('2026-12-31'), 'Thu 31 Dec 2026')
  })
  test('the Received column: Today, Yesterday, then the day, with the year only when it is not this one', () => {
    assert.equal(receivedLabel('2026-11-02', '2026-11-02'), 'Today')
    assert.equal(receivedLabel('2026-11-01', '2026-11-02'), 'Yesterday')
    assert.equal(receivedLabel('2026-10-12', '2026-11-02'), '12 Oct')
    assert.equal(receivedLabel('2025-12-30', '2026-11-02'), '30 Dec 2025')
    assert.equal(receivedLabel('2026-10-31', '2026-11-01'), 'Yesterday')
    assert.equal(receivedLabel('2026-11-30', '2026-12-01'), 'Yesterday')
  })
  test('a moment is shown in India time', () => {
    assert.equal(whenLabel('2026-11-02T05:50:00.000Z'), '2 Nov 2026, 11:20 am')
    assert.equal(whenLabel('2026-11-02T20:00:00.000Z'), '3 Nov 2026, 1:30 am')
    assert.equal(whenLabel('not a date'), 'not a date')
  })
  test('an edit says which fields changed, in words', () => {
    assert.equal(editedFields('phone'), 'the number')
    assert.equal(editedFields('phone, name'), 'the number and the name')
    assert.equal(editedFields('source, name, location'), 'the source, the name and the location')
    assert.equal(editedFields(null), 'the details')
  })
  test('small helpers', () => {
    assert.equal(initialsOf('Mohit Sharma'), 'MS')
    assert.equal(initialsOf('Dhruv'), 'D')
    assert.equal(plural(1, 'lead'), '1 lead')
    assert.equal(plural(12406, 'lead'), '12,406 leads')
  })
})

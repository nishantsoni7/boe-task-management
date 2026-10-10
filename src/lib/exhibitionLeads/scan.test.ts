import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CLIENT_TYPES, REQUIREMENTS } from './constants'
import { emptyLeadForm, missingRequired, validateLeadForm } from './validation'
import { applyScan, firstUsablePhone, parseScanResult, scanIsEmpty, scanNote, splitPhone } from './scan'
import { SCAN_TOOL } from './scanPrompt'

const card = (extra: Record<string, unknown> = {}) => parseScanResult({
  name: '  Asha   Rao ', phones: ['+91 98765 43210', '022 2345 6789'], email: 'ASHA@Studio.IN',
  company: 'Rao Studio', designation: 'Principal Architect', city: 'Pune', client_type: 'architect_designer', ...extra,
}, 'visiting_card')

describe('parseScanResult', () => {
  it('trims, collapses whitespace and lower-cases the email', () => {
    const r = card()
    assert.equal(r.name, 'Asha Rao')
    assert.equal(r.email, 'asha@studio.in')
    assert.equal(r.clientType, 'architect_designer')
  })
  it('drops unknown option values and wrong types instead of guessing', () => {
    const r = parseScanResult({ name: 5, phones: 'x', client_type: 'billionaire', requirements: ['hotel', 'spa', 7] }, 'visitor_form')
    assert.equal(r.name, '')
    assert.deepEqual(r.phones, [])
    assert.equal(r.clientType, '')
    assert.deepEqual(r.requirements, ['hotel'])
  })
  it('survives null, arrays and strings', () => {
    for (const bad of [null, undefined, [], 'text', 3]) assert.ok(scanIsEmpty(parseScanResult(bad, 'visiting_card')))
  })
  it('is "empty" only when nothing usable was read', () => {
    assert.ok(!scanIsEmpty(card()))
    assert.ok(!scanIsEmpty(parseScanResult({ phones: ['9876543210'] }, 'visiting_card')))
  })
})

describe('phones', () => {
  it('skips a landline and uses the first number the form can save', () => {
    assert.equal(firstUsablePhone(['022 2345 6789', '98765 43210']), '+919876543210')
    assert.equal(firstUsablePhone(['022 2345 6789']), null)
  })
  it('splits +91 numbers into code and number; others stay whole', () => {
    assert.deepEqual(splitPhone('+919876543210'), { countryCode: '91', mobile: '9876543210' })
    assert.deepEqual(splitPhone('+971501234567'), { countryCode: '91', mobile: '+971501234567' })
  })
})

describe('applyScan', () => {
  it('fills the empty form and leaves the lead type to the salesperson', () => {
    const { values, filled } = applyScan(emptyLeadForm(), card())
    assert.equal(values.contactName, 'Asha Rao')
    assert.equal(values.mobile, '9876543210')
    assert.equal(values.countryCode, '91')
    assert.equal(values.companyName, 'Rao Studio')
    assert.equal(values.projectCity, 'Pune')
    assert.equal(values.clientType, 'architect_designer')
    assert.equal(values.leadType, '')
    assert.ok(filled.includes('contactName') && filled.includes('mobile') && filled.includes('note'))
    // The one judgement call is the only thing left (plus the requirement a card cannot tell).
    assert.deepEqual(missingRequired(values), ['Requirement', 'Lead type'])
    assert.ok(!validateLeadForm(values).contactName && !validateLeadForm(values).mobile)
  })
  it('never overwrites what the salesperson already typed', () => {
    const typed = { ...emptyLeadForm(), contactName: 'Asha R', mobile: '90000 11111', requirements: ['hotel' as const], clientType: 'consultant' as const }
    const { values } = applyScan(typed, card({ requirements: ['restaurant_cafe'] }))
    assert.equal(values.contactName, 'Asha R')
    assert.equal(values.mobile, '90000 11111')
    assert.deepEqual(values.requirements, ['hotel'])
    assert.equal(values.clientType, 'consultant')
  })
  it('a visitor form can complete every required field but the lead type', () => {
    const r = parseScanResult({
      name: 'Imran', phones: ['9811122233'], city: 'Delhi', client_type: 'property_owner',
      requirements: ['hotel'], requirement_text: '60 rooms, Jaipur',
    }, 'visitor_form')
    const { values } = applyScan(emptyLeadForm(), r)
    assert.deepEqual(missingRequired(values), ['Lead type'])
    assert.match(values.note, /^Scanned from visitor form/)
    assert.match(values.note, /Requirement: 60 rooms, Jaipur/)
  })
  it('flags a number the form cannot use', () => {
    const r = parseScanResult({ name: 'Landline Larry', phones: ['022 2345 6789'] }, 'visiting_card')
    const out = applyScan(emptyLeadForm(), r)
    assert.equal(out.unusablePhone, true)
    assert.equal(out.values.mobile, '')
    assert.ok(missingRequired(out.values).includes('Mobile'))
  })
  it('keeps the note under the limit and lists spare numbers', () => {
    const r = card({ address: 'x'.repeat(5000) })
    assert.ok(scanNote(r).length <= 2000)
    assert.match(scanNote(card()), /Other numbers: 022 2345 6789/)
    assert.match(scanNote(card()), /Email: asha@studio\.in/)
  })
})

describe('the reader is held to the form’s own vocabularies', () => {
  const props = SCAN_TOOL.input_schema.properties
  it('offers exactly the client types and requirements the form has', () => {
    assert.deepEqual([...props.client_type.enum], CLIENT_TYPES.map(c => c.value))
    assert.deepEqual([...props.requirements.items.enum], REQUIREMENTS.map(r => r.value))
  })
  it('has no field for the lead type: that judgement stays human', () => {
    assert.ok(!('lead_type' in props))
  })
})

describe('the route', () => {
  const route = readFileSync(new URL('../../app/api/exhibition-leads/scan/route.ts', import.meta.url), 'utf8').replace(/\r/g, '')
  it('checks the caller is signed in and in the module before spending anything', () => {
    const iAuth = route.indexOf('auth.getUser')
    const iAccess = route.indexOf(".from('exhibitions')")
    const iProvider = route.indexOf('api.anthropic.com')
    assert.ok(iAuth > 0 && iAccess > iAuth && iProvider > iAccess)
  })
  it('keeps the key on the server and uses no service credential', () => {
    assert.ok(!route.includes('SERVICE_ROLE'))
    assert.ok(!route.includes('NEXT_PUBLIC_ANTHROPIC'))
  })
  it('degrades to typing when no key is configured', () => {
    assert.match(route, /not_configured/)
  })
})

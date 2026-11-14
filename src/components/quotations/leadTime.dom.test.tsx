/**
 * PROJECT TYPE, SEATS AND LEAD TIME in the builder's Client card, run for real in jsdom (owner, 14 Nov 2026): the lead time
 * follows the owner's rules by itself, and a person may change it only by saying why.
 *
 * Run: npm run test:file -- src/components/quotations/leadTime.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement, useState } from 'react'
import '@/lib/testing/cssModuleStub'
import { LeadTime, effectiveLeadTime } from './LeadTime'
import type { Header } from '@/lib/quotations/api'
import type { QuoteArea } from '@/lib/quotations/math'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const AREAS: QuoteArea[] = [{ key: 'a', name: 'Boho room', style: '', multiplier: 56, unit_label: 'rooms' }]
const base = { project_type: '', seats: null, lead_time_weeks: null, lead_time_reason: '' } as Header

// The parent the builder is: it holds the header and applies each patch.
function Parent({ start, areas = AREAS, log }: { start: Partial<Header>; areas?: QuoteArea[]; log: Partial<Header>[] }) {
  const [h, setH] = useState<Header>({ ...base, ...start })
  return createElement(LeadTime, { h, areas, editable: true, onChange: (p: Partial<Header>) => { log.push(p); setH(x => ({ ...x, ...p })) } })
}
// the harness types into inputs; a select is chosen the same way a browser does: set the value, then a change event
const setSelect = (el: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new window.Event('change', { bubbles: true })) })
}

describe('what a save writes (effectiveLeadTime)', () => {
  test('the rule, until a person changed it with a reason', () => {
    assert.equal(effectiveLeadTime({ ...base, project_type: 'hotel' }, AREAS), 14)
    assert.equal(effectiveLeadTime({ ...base, project_type: 'hotel' }, [{ ...AREAS[0], multiplier: 30 }]), 10)
    assert.equal(effectiveLeadTime({ ...base, project_type: 'restaurant', seats: 320 }, []), 10)
    assert.equal(effectiveLeadTime({ ...base, project_type: 'other' }, AREAS), null)
    assert.equal(effectiveLeadTime({ ...base, project_type: 'hotel', lead_time_weeks: 20, lead_time_reason: 'Client asked for a later date' }, AREAS), 20, 'a person changed it')
  })
  test('rooms added later move the rule; a changed lead time does not move', () => {
    const grown = [{ ...AREAS[0], multiplier: 120 }]
    assert.equal(effectiveLeadTime({ ...base, project_type: 'hotel' }, grown), 16)
    assert.equal(effectiveLeadTime({ ...base, project_type: 'hotel', lead_time_weeks: 12, lead_time_reason: 'Rush order' }, grown), 12)
  })
})

describe('the Client card block', () => {
  test('a hotel shows its lead time and how it was worked out; seats are not asked', () => {
    const ui = mount(createElement(Parent, { start: { project_type: 'hotel' }, log: [] })); cleanup = () => ui.unmount()
    assert.match(ui.text(), /14 weeks/); assert.match(ui.text(), /Hotel, 56 rooms \(31 to 100 rooms\), from the advance/)
    assert.equal(ui.all('#q-seats').length, 0)
  })
  test('choosing a restaurant asks for the seats, and the lead time appears once they are typed', () => {
    const log: Partial<Header>[] = []
    const ui = mount(createElement(Parent, { start: {}, areas: [], log })); cleanup = () => ui.unmount()
    assert.match(ui.text(), /Not printed/); assert.match(ui.text(), /Choose Hotel, Resort, Restaurant, Café or Brewery/)
    setSelect(ui.one<HTMLSelectElement>('#q-ptype'), 'restaurant')
    assert.deepEqual(log[0], { project_type: 'restaurant' })
    assert.match(ui.text(), /Add the seats to see it/)
    ui.type(ui.one<HTMLInputElement>('#q-seats'), '220')
    assert.deepEqual(log[1], { seats: 220 })
    assert.match(ui.text(), /10 weeks/); assert.match(ui.text(), /Restaurant, 220 seats \(201 to 500 seats\)/)
  })
  test('Other prints no lead time and says how to add one', () => {
    const ui = mount(createElement(Parent, { start: { project_type: 'other' }, log: [] })); cleanup = () => ui.unmount()
    assert.match(ui.text(), /Not printed/)
  })
  test('changing the lead time needs weeks and a reason; with both it is kept, with the reason shown beside it', () => {
    const log: Partial<Header>[] = []
    const ui = mount(createElement(Parent, { start: { project_type: 'hotel' }, log })); cleanup = () => ui.unmount()
    ui.click(ui.button('Change'))
    const use = ui.button('Use this')
    assert.equal(use.disabled, true, 'nothing is typed yet')
    ui.type(ui.one<HTMLInputElement>('#q-lead-weeks'), '20')
    assert.equal(ui.button('Use this').disabled, true, 'weeks without a reason')
    ui.type(ui.one<HTMLInputElement>('#q-lead-why'), '  Client needs it after the season  ')
    ui.click(ui.button('Use this'))
    assert.deepEqual(log, [{ lead_time_weeks: 20, lead_time_reason: 'Client needs it after the season' }])
    assert.match(ui.text(), /20 weeks/); assert.match(ui.text(), /Changed by a person: Client needs it after the season/)
  })
  test('weeks outside 1 to 104, or a fraction, are refused', () => {
    const ui = mount(createElement(Parent, { start: { project_type: 'hotel' }, log: [] })); cleanup = () => ui.unmount()
    ui.click(ui.button('Change'))
    ui.type(ui.one<HTMLInputElement>('#q-lead-why'), 'because')
    for (const bad of ['0', '105', '12.5', '-3', '']) { ui.type(ui.one<HTMLInputElement>('#q-lead-weeks'), bad); assert.equal(ui.button('Use this').disabled, true, bad) }
    ui.type(ui.one<HTMLInputElement>('#q-lead-weeks'), '104'); assert.equal(ui.button('Use this').disabled, false)
  })
  test('"Back to the rule" drops the change and the reason; Cancel changes nothing', () => {
    const log: Partial<Header>[] = []
    const ui = mount(createElement(Parent, { start: { project_type: 'hotel', lead_time_weeks: 20, lead_time_reason: 'Rush' }, log })); cleanup = () => ui.unmount()
    assert.match(ui.text(), /20 weeks/)
    ui.click(ui.button('Change')); ui.click(ui.button('Cancel')); assert.deepEqual(log, [])
    ui.click(ui.button('Change')); ui.click(ui.button('Back to the rule'))
    assert.deepEqual(log, [{ lead_time_weeks: 14, lead_time_reason: '' }])
    assert.match(ui.text(), /14 weeks/); assert.doesNotMatch(ui.text(), /Changed by a person/)
  })
})

describe('the builder uses it', () => {
  test('the Client card holds the block, and a save writes the effective lead time, not a stale one', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
    assert.ok(src.includes('<LeadTime h={h} areas={areas} editable={editable}'))
    assert.ok(src.includes('saveDoc({ ...h, lead_time_weeks: effectiveLeadTime(h, areas) }, areas, lines, base.updated_at)'))
  })
})

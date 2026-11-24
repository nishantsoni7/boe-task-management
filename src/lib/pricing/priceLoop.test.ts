// Price Brain v2, phase 4 (owner approved 24 Nov 2026): "Teach this?" on a quotation line, and rate reminders on For you.
// Rupees and dates are made up.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { askedPrice, kindFor, shouldAsk, TEACH_REASONS, withAskedTag } from './teachAsk'
import { dueRates, dueText, isDue } from './rateReview'
import { ratesDueCard } from '../modules/forYouWork'
import { FOR_YOU_ITEMS, itemApplies, NO_FOR_YOU_ACCESS } from '../modules/forYouCatalogue'

const NOW = Date.parse('2026-11-24T06:00:00Z')
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString()

describe('teach this?: a typed price more than 10% from the suggestion asks once', () => {
  test('the tag is written, replaced and read; whatever else the note says stays', () => {
    assert.equal(withAskedTag('', 6200.4), '[Asked to teach 6200]')
    assert.equal(withAskedTag('Darker [Asked to teach 5000] [Used suggestion 4790]', 6200), 'Darker [Used suggestion 4790] [Asked to teach 6200]')
    assert.equal(askedPrice('x [Asked to teach 6200]'), 6200); assert.equal(askedPrice('x'), null)
  })
  test('asks above 10% either way, never for a price Use set, never twice for the same price', () => {
    assert.equal(shouldAsk(5600, 5000, ''), true)        // +12%
    assert.equal(shouldAsk(4400, 5000, ''), true)        // -12%
    assert.equal(shouldAsk(5400, 5000, ''), false)       // +8%
    assert.equal(shouldAsk(5500, 5000, ''), false)       // exactly 10%: not more than
    assert.equal(shouldAsk(6200, 5000, '[Used suggestion 6200]'), false)
    assert.equal(shouldAsk(6200, 5000, '[Asked to teach 6200]'), false)
    assert.equal(shouldAsk(6300, 5000, '[Asked to teach 6200]'), true) // a new price asks again
    assert.equal(shouldAsk(null, 5000, ''), false); assert.equal(shouldAsk(6200, null, ''), false); assert.equal(shouldAsk(0, 5000, ''), false)
  })
  test('the note says the suggestion was too high or too low', () => {
    assert.equal(kindFor(4400, 5000), 'too_high'); assert.equal(kindFor(5600, 5000), 'too_low')
    assert.deepEqual([...TEACH_REASONS], ['Material or wood', 'Size', 'Finish or fabric', 'Work or design', 'Client or volume', 'Market rate', 'Other'])
  })
  test('the row is for the people who see "Why?", on an editable line, and sends one note with both prices', () => {
    const desk = readFileSync('src/components/quotations/PricingDesk.tsx', 'utf8')
    assert.match(desk, /\{feedback && editable && onAsked && sug && <TeachAsk /)
    assert.match(desk, /kind: kindFor\(p, sug\.price\), comment: `Reason: \$\{reason\}`, expected_price: p, line: ctx\.line/)
    assert.match(desk, /quotation_id: ctx\.quotationId/)
    assert.match(desk, /setState\('sent'\); onAsked\(withAskedTag\(note, p\)\)/)  // remembered only once sent
    assert.match(desk, /onClick=\{\(\) => onAsked\(withAskedTag\(note, p\)\)\}>Not now/)
    assert.match(readFileSync('src/components/quotations/ProductLine.tsx', 'utf8'), /note=\{l\.internal_note\} onAsked=\{n => onChange\(\{ internal_note: n \}\)\}/)
  })
})

describe('rate reminders: steel every 30 days, wood every 90, a missing rate at once', () => {
  const woods = [{ name: 'Mango', rate: 1500, updated_at: ago(89) }, { name: 'Teak', rate: 4200, updated_at: ago(95) }, { name: 'Ash', rate: null, updated_at: ago(1) }]
  const metals = [{ name: 'MS sheet', rate: null, updated_at: ago(2) }, { name: 'MS tube and pipe', rate: 80, updated_at: ago(31) }, { name: 'MS bar and flat', rate: 78, updated_at: ago(29) }]
  test('what is due, missing rates first, then the oldest', () => {
    assert.equal(isDue('metal', metals[1], NOW), true); assert.equal(isDue('metal', metals[2], NOW), false)
    assert.equal(isDue('wood', woods[0], NOW), false); assert.equal(isDue('wood', woods[1], NOW), true)
    const due = dueRates(woods, metals, NOW)
    assert.deepEqual(due.map(dueText), ['Ash: no rate yet', 'MS sheet: no rate yet', 'Teak: 95 days', 'MS tube and pipe: 31 days'])
    assert.deepEqual(dueRates([{ name: 'Mango', rate: 1500, updated_at: ago(0) }], [], NOW), [])
  })
  test('one For you card names the first three; it changes when the list changes', () => {
    const due = dueRates(woods, metals, NOW)
    const [card] = ratesDueCard(due)
    assert.equal(card.label, 'Rates to review · 4')
    assert.equal(card.brief, 'Ash: no rate yet, MS sheet: no rate yet, Teak: 95 days, and 1 more')
    assert.equal(card.href, '/pricing/woods'); assert.equal(card.action, 'Review rates')
    assert.notEqual(ratesDueCard(due.slice(1))[0].key, card.key)
    assert.deepEqual(ratesDueCard([]), [])
  })
  test('the item is optional, and only for people who teach prices', () => {
    const item = FOR_YOU_ITEMS.find(i => i.key === 'pricing_rates_due')!
    assert.equal(item.defaultMode, 'optional')
    assert.equal(itemApplies('pricing_rates_due', NO_FOR_YOU_ACCESS), false)
    assert.equal(itemApplies('pricing_rates_due', { ...NO_FOR_YOU_ACCESS, teachesPrices: true }), true)
    const access = readFileSync('src/hooks/queries/useForYouSettings.ts', 'utf8')
    assert.match(access, /teachesPrices: isAdminRole\(subjectRole\) \|\| \(allows\('view'\) && allows\('create'\)\)/)
  })
  test('"Still right" saves a rate unchanged, which stamps it reviewed, and refreshes the card', () => {
    const page = readFileSync('src/components/pricing/training/WoodRates.tsx', 'utf8')
    assert.match(page, /saveWood\(supabase, r\.name, Number\(r\.rate\)\) : saveMetal\(supabase, r\.name, null, Number\(r\.rate\)\)/)
    assert.match(page, /\['for-you', 'work', 'pricing_rates_due'\]/)
    assert.match(readFileSync('src/app/modules/AttentionPanel.tsx', 'utf8'), /pricing_rates_due: Scale,/)
  })
})

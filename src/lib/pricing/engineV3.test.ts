// Engine v3 (Price Brain v2, phase 3C) against made-up chairs from a KNOWN rule: every chair is called "Dining chair",
// the same size, but a cane back costs 40% more than an upholstered one, and only the photo facts say which is which.
// Today's model (v2) cannot see it; v3 can. Rupees are made up.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareEngines, examine } from './exam'
import { explainFit, fitType, predict, pointFeatures, priceLine, type ModelPoint } from './model'

const NOW = Date.parse('2026-11-23T06:00:00Z')
let seed = 5
const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
const at = (i: number) => new Date(NOW - (i % 4) * 60 * 86_400_000).toISOString()

const chairs = (n: number, withPhotos = true): ModelPoint[] => Array.from({ length: n }, (_, i) => {
  const cane = i % 2 === 0
  const wide = i % 3 === 0
  return {
    k: 'order', p: Math.round(5000 * (cane ? 1.4 : 1) * (wide ? 1.1 : 1) * (1 + (rand() - 0.5) * 0.06)), q: 4, at: at(i),
    name: 'Dining chair', dims: wide ? '24 x 22 x 34' : '20 x 22 x 34', material: 'Mango wood', finish: 'PU', client_type: null,
    f: withPhotos ? { kind: 'chair', arms: 'no', back: cane ? 'cane' : 'upholstered', seat: 'upholstered' } : null,
  }
})
const beds = (n: number): ModelPoint[] => Array.from({ length: n }, (_, i) => ({
  k: 'order', p: Math.round(40000 * (i % 3 ? 1 : 1.2) * (1 + (rand() - 0.5) * 0.06)), q: 4, at: at(i),
  name: 'King bed', dims: i % 2 ? '72 x 78' : '72 x 84', material: i % 3 ? 'Mango wood' : 'Teak wood', finish: 'PU', client_type: null,
}))
const taught = (name: string, p: number): ModelPoint => ({ k: 'taught', p, q: 1, at: at(0), name, dims: '20 x 22 x 34', material: 'Sheesham', finish: null, client_type: null })

describe('engine v3: photo facts and taught cases', () => {
  test('with no photo read and nothing taught, v3 is exactly v2, and v2 stays in use', () => {
    const pts = beds(30)
    const v2 = fitType(pts, 'bed', NOW)!, v3 = fitType(pts, 'bed', NOW, true)!
    assert.deepEqual(v3.columns, v2.columns)
    assert.deepEqual(v3.coef, v2.coef)
    const f = pointFeatures(pts[0])
    assert.equal(predict(v3, pointFeatures(pts[0], true)).price, predict(v2, f).price)
    const exam = compareEngines(pts, 'bed', NOW)
    assert.equal(exam.leader, 'v2'); assert.deepEqual(exam.v3, exam.v2)
  })

  test('today\'s model never learns a taught case; v3 learns it at full weight', () => {
    const pts = beds(30), more = [...pts, taught('King bed', 90000), taught('King bed', 95000)]
    assert.deepEqual(fitType(more, 'bed', NOW)!.coef, fitType(pts, 'bed', NOW)!.coef)
    assert.equal(fitType(more, 'bed', NOW, true)!.n, 32)
    // A taught case is never a price examined: the same 30 prices are tested either way.
    assert.equal(examine(more, NOW).types.find(t => t.type === 'bed')!.tested, 30)
  })

  test('a cane back only the photo shows: v3 learns it, misses less on the blind test, and leads', () => {
    const pts = chairs(40)
    const fit = fitType(pts, 'chair', NOW, true)!
    const cane = explainFit(fit).find(e => /Back/.test(e.label))!
    assert.match(cane.label, /\(photo\)$/)
    assert.ok(Math.abs(Math.abs(cane.pct) - 40) <= 8 || Math.abs(Math.abs(cane.pct) - 29) <= 8, `learned ${cane.pct}% for the back`)
    const chair = examine(pts, NOW).types.find(t => t.type === 'chair')!
    assert.equal(chair.leader, 'v3')
    assert.ok(chair.v3.miss! < chair.v2.miss!, `v3 ${chair.v3.miss}% against v2 ${chair.v2.miss}%`)
    assert.equal(chair.miss, chair.v3.miss)
    // The same chairs without their photos: nothing for v3 to see, so v2 stays.
    assert.equal(compareEngines(chairs(40, false), 'chair', NOW).leader, 'v2')
  })

  test('a quotation line is priced for its photo where v3 leads, and exactly as before where it does not', () => {
    const pts = chairs(40)
    const line = { name: 'Dining chair', size: '20 x 22 x 34', material: 'Mango wood', finish: 'PU', qty: 4 }
    const facts = (back: string) => ({ kind: 'chair', arms: 'no', back, seat: 'upholstered' })
    const v3 = (back: string) => priceLine(pts, line, NOW, undefined, { facts: facts(back), useFacts: () => true })!
    assert.equal(v3('cane').engine, 'v3')
    assert.ok(v3('cane').price > v3('upholstered').price * 1.25, `${v3('cane').price} against ${v3('upholstered').price}`)
    assert.match(v3('cane').basis, /with photo facts/)
    const asToday = priceLine(pts, line, NOW)!
    const v2Led = priceLine(pts, line, NOW, undefined, { facts: facts('cane'), useFacts: () => false })!
    assert.deepEqual(v2Led, asToday)
    assert.equal(asToday.engine, 'v2')
    // A name with no product type is priced by its photo's kind only where v3 leads.
    const odd = { ...line, name: 'Model 7' }
    assert.equal(priceLine(pts, odd, NOW, undefined, { facts: facts('cane'), useFacts: () => false }), null)
    assert.equal(priceLine(pts, odd, NOW, undefined, { facts: facts('cane'), useFacts: () => true })!.type, 'chair')
  })

  test('the screens use the leader: the builder passes each line\'s photo facts, the card shows both engines', () => {
    const builder = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
    assert.match(builder, /compareEngines\(pool, type\)\.leader === 'v3'/)
    assert.match(builder, /fetchFactsFor\(supabase, photoKeysOn\.split\('\\n'\)\)/)
    assert.match(builder, /\{ facts, useFacts \}/)
    const card = readFileSync('src/components/pricing/learning/AccuracyCard.tsx', 'utf8')
    assert.match(card, /With photos/)
    assert.match(card, /t\.leader === e/)
    assert.match(readFileSync('src/components/pricing/HowPricesAreMade.tsx', 'utf8'), /compareEngines\(q\.data, type\)\.leader === 'v3'/)
  })

  test('the migration: facts without the reader\'s note, taught cases as selling prices per piece, facts_for behind the pool\'s door', () => {
    const sql = readFileSync('supabase/migrations/20270826000000_pricing_engine_v3.sql', 'utf8').replace(/\r/g, '')
    assert.match(sql, /jsonb_build_object\('f', x\.f - 'note' - 'confidence'\)/)
    assert.match(sql, /c\.status = 'submitted' and c\.price_level = 'selling' and c\.per_set is null and t\.total > 0/)
    assert.match(sql, /and not public\.pricing_used_suggestion\(l\.internal_note, l\.unit_price\)/) // the echo guard stays
    assert.match(sql, /limit 2500/)
    const facts = sql.slice(sql.indexOf('create or replace function public.pricing_photo_facts_for'))
    assert.match(facts, /module_entry_open\('quotations'\) or public\.module_entry_open\('pricing'\)/)
    assert.match(facts, /> 200/)
    assert.doesNotMatch(sql, /create table|alter table|insert into|delete from|update public/i)
  })
})

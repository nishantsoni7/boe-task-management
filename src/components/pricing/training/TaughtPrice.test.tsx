import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { TaughtPrice } from './TaughtPrice'
import type { Library, TaughtCase } from '@/lib/pricing/training/match'

const CHAIR: TaughtCase = { id: 'a', case_no: 12, name: 'Arm chair, cane back', variant: null, image_path: 'u/p.jpg', total: 5500, wood: 'Sheesham', wood_amount: 2300, in_wood: { teak: 7800 } }
const lib = (c: TaughtCase): Library => ({ cases: [c], woods: ['Sheesham', 'Teak'] })
const html = (o: { note?: string; editable?: boolean; material?: string; c?: TaughtCase; price?: number | null }) => renderToStaticMarkup(
  <TaughtPrice library={lib(o.c ?? CHAIR)} photo={p => `https://img.example/${p}`} line={{ name: 'Chair C - 1', material: o.material }} note={o.note ?? ''}
    price={o.price ?? null} editable={o.editable ?? true} onNote={() => {}} onUse={() => {}} />)

describe('taught price on a quotation line', () => {
  it('offers the pick while nothing is picked, and nothing at all on a line that cannot be edited', () => {
    assert.ok(html({}).includes('Pick a taught product'))
    assert.equal(html({ editable: false }), '')
  })

  it('shows the picked case with its photo and price, in the line wood when there is one', () => {
    const h = html({ note: 'x [Taught case #12]', material: 'Teak wood' })
    assert.ok(h.includes('https://img.example/u/p.jpg') && h.includes('#12 Arm chair, cane back'))
    assert.ok(h.includes('7,800') && h.includes('in Teak') && h.includes('taught at') && h.includes('5,500'))
    assert.ok(h.includes('>Use<') && h.includes('>Change<') && h.includes('>Remove<'))
    assert.ok(!html({ note: '[Taught case #12]', price: 5500 }).includes('>Use<'), 'no Use when the line already has that price')
  })

  it('shows what the price is made of only when the database sent the elements', () => {
    assert.ok(!html({ note: '[Taught case #12]' }).includes('What it is made of'))
    const withLines = { ...CHAIR, lines: [{ element: 'Margin', kind: 'margin', amount: 900, material: null }] }
    assert.ok(html({ note: '[Taught case #12]', c: withLines }).includes('What it is made of'))
  })

  it('shows an adjusted price and what is different, and offers "This one is different" only once the elements arrive', () => {
    assert.ok(!html({ note: '[Taught case #12]' }).includes('This one is different'))
    const parts = { ...CHAIR, parts: [{ element: 'Back weaving', kind: 'material', amount: 1000 }] }
    const h = html({ note: '[Taught case #12; without Back weaving; without Cane seat]', c: parts })
    assert.ok(h.includes('Taught price, adjusted') && h.includes('4,500') && h.includes('without Back weaving'))
    assert.ok(h.includes('no longer taught, so not counted: Cane seat') && h.includes('This one is different'))
    assert.ok(!html({ note: '[Taught case #12]', c: parts, editable: false }).includes('This one is different'))
  })

  it('asks why when the price typed is more than 5% from the taught price, and shows the reason once given', () => {
    assert.ok(!html({ note: '[Taught case #12]', price: 5400 }).includes('the taught price.'), 'close enough: no question')
    const ask = html({ note: '[Taught case #12]', price: 4840 })
    assert.ok(ask.includes('660') && ask.includes('(12%) below the taught price.') && ask.includes('Why?') && ask.includes('Quantity discount'))
    const told = html({ note: '[Taught case #12; why Client relationship]', price: 4840 })
    assert.ok(told.includes('Reason: <b>Client relationship</b>') && told.includes('Change reason') && !told.includes('Why?'))
    assert.ok(html({ note: '[Taught case #12]', price: 6050, editable: false }).includes('(10%) above the taught price. No reason given.'))
  })

  it('says so when the picked case is no longer submitted', () => {
    assert.ok(html({ note: '[Taught case #99]' }).includes('Taught product #99 has no submitted price right now'))
  })
})

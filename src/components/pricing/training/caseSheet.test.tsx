import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { ElementRow } from './ElementRow'
import { PriceBuildUp } from './PriceBuildUp'
import { emptyLine, workCase, type Line } from '@/lib/pricing/training/doc'
import { buildUp, emptyBoxes, withPct, withOf, type Boxes } from '@/lib/pricing/training/boxes'
import { newCalc, type Size } from '@/lib/pricing/training/calc'

const NO_SIZE: Size = { width: null, depth: null, height: null }
const line = (o: Partial<Line>): Line => ({ ...emptyLine(), ...o })
const row = (l: Line, open = false) => renderToStaticMarkup(
  <ElementRow i={0} line={l} worked={workCase([l], NO_SIZE)[0]} size={NO_SIZE} woods={[]} metals={[]} open={open} onToggle={() => {}} onChange={() => {}} onRemove={() => {}} />)

const CHAIR = [line({ element: 'Structure', kind: 'structure', amount: '1700' }), line({ element: 'Finish', amount: '500' }), line({ element: 'Weaving', amount: '1100' }), line({ element: 'Other', kind: 'other', amount: '200' })]
const boxes = (o: string, m: string, of: 'cost' | 'above' = 'cost'): Boxes => { const b = emptyBoxes(); return { overhead: withPct(b.overhead, o), margin: withOf(withPct(b.margin, m), of) } }
const card = (o: { b?: Boxes; sold?: number | null; editable?: boolean }) => {
  const b = o.b ?? emptyBoxes()
  return renderToStaticMarkup(<PriceBuildUp editable={o.editable ?? true} build={buildUp(CHAIR, b, NO_SIZE)} boxes={b} sold={o.sold ?? null} onPct={() => {}} onBase={() => {}} />)
}

describe('one element is one line of the sheet', () => {
  it('shows the amount worked out from quantity × rate, and an amount box only when there is no quantity × rate', () => {
    const h = row(line({ element: 'Seat weaving', quantity: '3', unit: 'sq ft', rate: '400' }))
    assert.ok(h.includes('₹1,200') && !h.includes('aria-label="Element 1 amount"'))
    const flat = row(line({ element: 'Finish', amount: '1250' }))
    assert.ok(flat.includes('aria-label="Element 1 amount"') && flat.includes('value="1250"'))
  })
  it('keeps how it was worked out, the wood and the calculators behind the arrow', () => {
    const closed = row(line({ element: 'Frame', kind: 'structure', material: 'Teak', reasoning: 'Four legs', amount: '2200' }))
    assert.ok(closed.includes('aria-expanded="false"') && closed.includes('Teak · Four legs') && !closed.includes('Worked out as'))
    const open = row(line({ element: 'Frame', kind: 'structure', material: 'Teak', reasoning: 'Four legs', amount: '2200' }), true)
    assert.ok(open.includes('aria-expanded="true"') && open.includes('Worked out as') && open.includes('How you worked this out') && open.includes('Of which wood'))
  })
  it('shows a worked-out element as such, and its calculator opens with the details', () => {
    const l = line({ element: 'Top', kind: 'material', calc: newCalc('area') })
    assert.ok(row(l).includes('Worked out: area of the product'))
    assert.ok(row(l, true).includes('Worked out as'))
  })
  it('offers no Overhead or Margin kind on a new row, but still shows one a case already has', () => {
    const fresh = row(line({ element: 'Hardware' }))
    assert.ok(!fresh.includes('>Overhead<') && !fresh.includes('>Margin<') && fresh.includes('>Wooden structure<'))
    assert.ok(row(line({ element: 'Factory Expense', kind: 'overhead', amount: '500' })).includes('>Overhead<'))
  })
  it('marks what the AI read', () => {
    assert.ok(row(line({ element: 'Finish', from_ai: true, reasoning: 'Satin brown' })).includes('read by AI'))
  })
})

describe('the price build-up', () => {
  it("the owner's chair: 3,500 + 20% overhead + 20% margin on the cost = 4,900", () => {
    const h = card({ b: boxes('20', '20') })
    for (const s of ['₹3,500', '+ ₹700', '₹4,900', 'Cost of making', 'Selling price']) assert.ok(h.includes(s), s)
    assert.ok(h.includes('value="20"') && h.includes('aria-describedby="box-overhead-amount"'))
  })
  it('works the margin on the cost plus overhead when the case says so, and shows both bases', () => {
    const h = card({ b: boxes('20', '20', 'above') })
    assert.ok(h.includes('₹5,040') && h.includes('₹4,200'))
  })
  it('starts with both boxes empty and the price equal to the cost', () => {
    const h = card({})
    assert.ok(h.includes('placeholder="0"') && h.includes('₹3,500') && !h.includes('+ ₹'))
  })
  it('compares with the price on the case: rounding is fine, a gap is said in rupees', () => {
    assert.ok(card({ b: boxes('20', '20'), sold: 4900 }).includes('Matches the price on the case'))
    const off = card({ b: boxes('20', '20'), sold: 4500 })
    assert.ok(off.includes('₹400 above the price on the case') && off.includes('8.9% apart'))
  })
  it('a person who may only read sees the percentages as text, not boxes', () => {
    const h = card({ b: boxes('20', '15'), editable: false })
    assert.ok(!h.includes('<input id="box-overhead"') && h.includes('20%') && h.includes('15%'))
  })
})

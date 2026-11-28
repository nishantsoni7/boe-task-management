/**
 * PRICE LEARNING, RUN FOR REAL: the feedback and correction doorway on a suggested price (owner, 13 Nov 2026: "always give an
 * option to share feedback or correct the price logic"), and the three steps of an upload rendered with real data.
 *
 * Run: npm run test:file -- src/components/pricing/learning/learning.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import '@/lib/testing/cssModuleStub'
import { SuggestionFeedback } from './SuggestionFeedback'
import { PriceHintLine } from '@/components/quotations/PricingDesk'
import { StepCheck } from './StepCheck'
import { StepFiles } from './StepFiles'
import { StepTest } from './StepTest'
import { isDesk } from './common'
import { blindTest } from '@/lib/pricing/learning/blindTest'
import { initialReview, testLinesOf } from '@/lib/pricing/learning/batch'
import { contentPrint, judge, readPiGrids, type Cell } from '@/lib/pricing/learning/readPi'
import type { PiFile } from '@/lib/pricing/learning/piFile'
import { priceLine, type ModelPoint, type ModelSuggestion } from '@/lib/pricing/model'

// next/link looks for `self`, which the jsdom harness does not copy across.
Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true, writable: true })

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

type Call = [string, { p_doc: Record<string, unknown> }]
const fakeClient = (reply: { error: { message: string } | null } = { error: null }) => {
  const calls: Call[] = []
  const client = { rpc: async (fn: string, args: Call[1]) => { calls.push([fn, args]); return { data: reply.error ? null : 'fb-1', error: reply.error } } }
  return { calls, client: client as never }
}

const SUG = { price: 59700, low: 54600, high: 65400, confidence: 'medium', basis: 'the price model for Bed (92 prices)', reasons: ['+18% Teak instead of Mango'] }
const LINE = { name: 'King bed with headboard', size: '78 x 84', material: 'Teak', finish: 'PU', qty: 56 }
const door = (over: Partial<Parameters<typeof SuggestionFeedback>[0]> = {}, reply?: Parameters<typeof fakeClient>[0]) => {
  const f = fakeClient(reply)
  const ui = mount(createElement(SuggestionFeedback, { source: 'quotation', line: LINE, clientType: 'property_owner', suggestion: SUG, quotationId: 'q-1', client: f.client, ...over }))
  cleanup = () => ui.unmount()
  return { ui, calls: f.calls }
}

describe('the feedback and correction doorway', () => {
  test('is closed until asked for, then says what the suggestion was and what can be done', () => {
    const { ui } = door()
    assert.match(ui.text(), /Feedback or correct the logic/)
    assert.doesNotMatch(ui.text(), /Send to the pricing desk/)
    ui.click(ui.button('Feedback or correct the logic'))
    assert.match(ui.text(), /King bed with headboard: suggested ₹59,700 \(₹54,600–₹65,400, medium confidence\)/)
    assert.match(ui.text(), /Share feedback/)
    assert.match(ui.text(), /Correct the logic/)
    assert.match(ui.text(), /The price looks too low/)
  })

  test('feedback goes to the pricing desk with the line, what the model said and what the person would quote', async () => {
    const { ui, calls } = door()
    ui.click(ui.button('Feedback or correct the logic'))
    ui.click(ui.one<HTMLInputElement>('input[type=radio]:nth-of-type(1)').parentElement!.parentElement!.querySelectorAll('input')[1])
    ui.type(ui.one<HTMLTextAreaElement>('textarea'), 'The last three teak beds sold at 56,000')
    ui.type(ui.one<HTMLInputElement>('input[type=number]'), '56000')
    ui.click(ui.button('Send to the pricing desk'))
    await ui.settle()
    assert.equal(calls.length, 1)
    const [fn, args] = calls[0]
    assert.equal(fn, 'pricing_feedback_add')
    assert.deepEqual(args.p_doc, {
      source: 'quotation', kind: 'too_low', comment: 'The last three teak beds sold at 56,000', expected_price: 56000, line: LINE, client_type: 'property_owner',
      suggestion: { price: 59700, low: 54600, high: 65400, confidence: 'medium', reasons: ['+18% Teak instead of Mango'], basis: 'the price model for Bed (92 prices)' }, quotation_id: 'q-1',
    })
    assert.match(ui.text(), /Thank you. The pricing desk will see this./)
  })

  test('"Correct the logic" needs a few words about how the logic should work, and is saved as a correction', async () => {
    const { ui, calls } = door({ isDesk: true })
    ui.click(ui.button('Feedback or correct the logic'))
    ui.click(ui.button('Correct the logic'))
    ui.click(ui.button('Send to the pricing desk'))
    await ui.settle()
    assert.equal(calls.length, 0, 'nothing is sent without a description')
    assert.match(ui.text(), /Say in a few words how the logic should work/)
    assert.equal(ui.all('input[type=radio]').length, 0, 'the "what is wrong" choices belong to feedback, not to a correction')
    ui.type(ui.one<HTMLTextAreaElement>('textarea'), 'Teak should be +25% over mango from October')
    ui.click(ui.button('Send to the pricing desk'))
    await ui.settle()
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1].p_doc.kind, 'correction')
    assert.equal(calls[0][1].p_doc.comment, 'Teak should be +25% over mango from October')
    assert.equal(calls[0][1].p_doc.expected_price, null)
    assert.ok(ui.all('a').some(a => /feedback list/.test(a.textContent ?? '')), 'the pricing desk is offered the list')
  })

  test('a refused send keeps what was typed and says why; a price of zero is not sent', async () => {
    const { ui, calls } = door({}, { error: { message: 'PRICING_FEEDBACK_LIMIT: that is a lot of feedback for one day' } })
    ui.click(ui.button('Feedback or correct the logic'))
    ui.type(ui.one<HTMLInputElement>('input[type=number]'), '0')
    ui.click(ui.button('Send to the pricing desk'))
    await ui.settle()
    assert.equal(calls.length, 0)
    assert.match(ui.text(), /must be more than zero/)
    ui.type(ui.one<HTMLInputElement>('input[type=number]'), '')
    ui.type(ui.one<HTMLTextAreaElement>('textarea'), 'Too high')
    ui.click(ui.button('Send to the pricing desk'))
    await ui.settle()
    assert.equal(calls.length, 1)
    assert.match(ui.text(), /that is a lot of feedback for one day/)
    assert.equal(ui.one<HTMLTextAreaElement>('textarea').value, 'Too high')
  })
})

describe('the suggested price on a quotation line: a small card for everyone, "Why this price" for the Pricing people', () => {
  const MODEL: ModelSuggestion = { price: 59700, low: 54600, high: 65400, confidence: 'medium', reasons: ['+18% Teak instead of Mango'], basis: 'the price model for Bed (92 prices)', n: 92, type: 'bed' }
  const HINT = { name: 'x', ordered: { last: 50000, last_at: '2026-01-01', min: 40000, max: 52000, count: 3 }, quoted: { last: 48000, last_at: '2026-02-01' } }
  const ctx = { line: LINE, clientType: null, quotationId: 'q-1', isDesk: false }
  const html = (props: Partial<Parameters<typeof PriceHintLine>[0]>) => renderToStaticMarkup(createElement(PriceHintLine, { price: null, editable: true, onUse: () => {}, ...props }))
  const draw = (props: Partial<Parameters<typeof PriceHintLine>[0]>) => {
    const ui = mount(createElement(PriceHintLine, { price: null, editable: true, onUse: () => {}, ...props }))
    cleanup = () => ui.unmount()
    return ui
  }

  test('without the Pricing module it is a small card: the price with a Use button and the range under it; no reasons, history, confidence or link', () => {
    const out = html({ model: MODEL, hint: HINT })
    assert.match(out, /Estimator <b>₹59,700<\/b>[\s\S]*<button[^>]*class="sugUse"[^>]*>Use<\/button>[\s\S]*Range ₹54,600–₹65,400/)
    for (const gone of [/Why this price/, /Teach my price/, /Feedback or correct the logic/, /Teak instead of Mango/, /medium/, /Last ordered/, /last quoted/i, /92 prices/]) assert.doesNotMatch(out, gone)
    assert.equal((out.match(/<div/g) ?? []).length, 1, 'one block, not a stack of lines')
  })

  test('with only history it says "Last ordered" once and nothing else; no history and no model draws nothing', () => {
    const out = html({ model: null, hint: { ...HINT, quoted: null } })
    assert.match(out, /Last ordered[\s\S]*₹50,000[\s\S]*Use/)
    assert.doesNotMatch(out, /over 3|₹40,000|Why this price/)
    assert.equal(html({ model: null, hint: { name: 'x', ordered: null, quoted: null } }), '')
    // What the builder passes someone outside the pricing desk (24 Nov 2026): no hint and no model draws nothing, not even Use.
    assert.equal(html({ model: null, hint: undefined }), '')
  })

  test('Use fills the suggestion and goes away once the price is that figure; a locked quotation has no Use', () => {
    assert.doesNotMatch(html({ model: MODEL, price: 59700 }), /Use/)
    assert.doesNotMatch(html({ model: MODEL, editable: false }), />Use</)
  })

  test('a suggestion without a chain (history only) keeps the facts popup: reasons, range, confidence, history and the form to correct the logic', () => {
    const ui = draw({ model: MODEL, hint: HINT, feedback: ctx })
    assert.doesNotMatch(ui.text(), /Teak instead of Mango/, 'closed until asked')
    ui.click(ui.button('Why this price'))
    const t = ui.text()
    assert.match(t, /King bed with headboard: the price/)
    assert.match(t, /range ₹54,600–₹65,400 · medium confidence/)
    assert.match(t, /From the price model for Bed \(92 prices\)/)
    assert.match(t, /\+18% Teak instead of Mango/)
    assert.match(t, /Last ordered ₹50,000 · ₹40,000–₹52,000 over 3 orders/)
    assert.match(t, /Last quoted ₹48,000/)
    assert.match(t, /Share feedback/)
    assert.match(t, /Correct the logic/)
    assert.equal(ui.one('[role=dialog]').getAttribute('aria-modal'), 'true')
    assert.equal(ui.one('[role=dialog]').parentElement?.parentElement, document.body, 'drawn in the page body, not inside the muted product row')
  })

  test('the popup closes with Close, Escape or a click outside; it opens on a locked quotation too', () => {
    const ui = draw({ model: MODEL, editable: false, feedback: ctx })
    for (const close of [() => ui.click(ui.button('×')), () => ui.press('Escape'), () => ui.click(ui.one('[role=dialog]').parentElement!)]) {
      ui.click(ui.button('Why this price'))
      assert.equal(ui.all('[role=dialog]').length, 1)
      close()
      assert.equal(ui.all('[role=dialog]').length, 0)
    }
  })

  test('history only: the popup shows the facts and no form (there is no calculation to correct)', () => {
    const ui = draw({ model: null, hint: HINT, feedback: ctx })
    ui.click(ui.button('Why this price'))
    assert.match(ui.text(), /Last ordered ₹50,000 · ₹40,000–₹52,000 over 3 orders/)
    assert.doesNotMatch(ui.text(), /Correct the logic|Share feedback/)
  })
})

describe('Why this price (28 Nov 2026): the chain, the three opinions, the closest past prices, and the way to teach', () => {
  const NOW = Date.parse('2026-11-28T06:00:00Z')
  const MODEL = () => priceLine(POOL, { name: 'King bed with headboard', size: '78 x 84', material: 'Teak', finish: 'PU', qty: 56 }, NOW)!
  const ctx = (over: Partial<NonNullable<Parameters<typeof PriceHintLine>[0]['feedback']>> = {}) => ({ line: LINE, clientType: null, quotationId: 'q-1', isDesk: false, ...over })
  const draw = (feedback = ctx(), props: Partial<Parameters<typeof PriceHintLine>[0]> = {}) => {
    const ui = mount(createElement(PriceHintLine, { price: null, editable: true, onUse: () => {}, model: MODEL(), feedback, ...props }))
    cleanup = () => ui.unmount()
    return ui
  }

  test('the card says Estimator and gives two ways in: Why this price, and Teach my price only for people who may teach', () => {
    const plain = draw()
    assert.match(plain.text(), /Estimator ₹/)
    assert.deepEqual(plain.all('button').map(b => b.textContent), ['Use', 'Why this price'])
    plain.unmount()
    const may = draw(ctx({ onTeach: () => {} }))
    assert.ok(may.all('button').some(b => b.textContent === 'Teach my price'))
  })

  test('the popup shows three opinions, the chain from a starting point to the suggestion, and the closest past prices', () => {
    const ui = draw()
    ui.click(ui.button('Why this price'))
    const t = ui.text()
    const m = MODEL()
    assert.match(t, new RegExp(`where ₹${m.price.toLocaleString('en-IN')} comes from`))
    assert.match(t, /Your costing.*Not taught yet/)
    assert.match(t, /Estimator.*Range ₹.*medium confidence|Estimator.*Range ₹.*low confidence|Estimator.*Range ₹.*high confidence/)
    assert.match(t, /Past prices.*similar bed prices/)
    assert.match(t, /Starting point.*A typical bed/)
    assert.match(t, /Estimator suggests/)
    assert.match(t, /Closest past prices/)
    assert.doesNotMatch(t, /₹d[d,]*.d/, 'every price is whole rupees: no paise in the chain')
    assert.ok(ui.all('table tbody tr').length >= 3, 'a start, at least one step, and the end')
    assert.equal(ui.all('[role=dialog] input[type=checkbox]').length, m.why!().steps.filter(s => s.key !== 'rest').length)
  })

  test('what you taught comes first, and is judged against the estimator and the past prices', () => {
    const ui = draw(ctx({ taught: { caseNo: 3, name: 'Chair', price: 5_000_000 } }))
    ui.click(ui.button('Why this price'))
    assert.match(ui.text(), /Your costing.*₹50,00,000.*#3 Chair, taught/)
    assert.match(ui.text(), /Your taught price ₹50,00,000 is above the estimator's range and above the past prices/)
  })

  test('switching a step off shows the price without it, says how it compares with the past prices, and saves nothing', () => {
    const ui = draw()
    ui.click(ui.button('Why this price'))
    assert.doesNotMatch(ui.text(), /With your changes/)
    const first = ui.all<HTMLInputElement>('[role=dialog] input[type=checkbox]')[0]
    ui.click(first)
    assert.match(ui.text(), /With your changes: ₹[\d,]+\./)
    assert.match(ui.text(), /Only this screen changes; nothing is saved\./)
    assert.equal(ui.all('[role=dialog] tbody tr.off').length, 1)
    ui.click(ui.all<HTMLInputElement>('[role=dialog] input[type=checkbox]')[0])
    assert.doesNotMatch(ui.text(), /With your changes/)
  })

  test('Teach my price closes the popup and hands over what was typed in the note box, so it is not typed twice', () => {
    const told: string[] = []
    const ui = draw(ctx({ onTeach: note => told.push(note) }))
    ui.click(ui.button('Why this price'))
    ui.click(ui.button('Send a note to the pricing desk instead'))
    ui.click(ui.button('Correct the logic'))
    ui.type(ui.one<HTMLTextAreaElement>('textarea'), 'Wood Structure: 1900\nCane: 525')
    ui.click(ui.all('[role=dialog] button').find(b => b.textContent === 'Teach my price')!)
    assert.deepEqual(told, ['Wood Structure: 1900\nCane: 525'])
    assert.equal(ui.all('[role=dialog]').length, 0)
  })

  test('with no note typed it hands over nothing, and the card button opens the panel at once', () => {
    const told: string[] = []
    const ui = draw(ctx({ onTeach: note => told.push(note) }))
    ui.click(ui.all('button').find(b => b.textContent === 'Teach my price')!)
    assert.deepEqual(told, [''])
  })
})

describe('who the pricing desk is', () => {
  test('Admin, or edit together with see-all: the rule of price approval and of the database', () => {
    assert.equal(isDesk({ create: false, edit: false, view_all: false, admin: true }), true)
    assert.equal(isDesk({ create: true, edit: true, view_all: true, admin: false }), true)
    assert.equal(isDesk({ create: true, edit: true, view_all: false, admin: false }), false)
    assert.equal(isDesk({ create: false, edit: false, view_all: true, admin: false }), false)
  })
})

// ── the three steps, rendered with real reader output ────────────────────
const HEAD = ['Code', 'Name', 'Quantity', 'Dimension in inches & shape', 'Representative image', 'Material', 'Cost per piece (INR)', 'Total cost (INR)']
async function piFile(n: number, rows: Cell[][], date: Cell | null = 45700): Promise<PiFile> {
  const grid: Cell[][] = [...(date ? [['', '', '', '', '', 'Date', date]] : []), HEAD, ...rows, ['', '', '', '', '', 'Sub Total', '', rows.reduce((t, r) => t + Number(r[7]), 0)]]
  const reading = readPiGrids([{ name: 'Master', grid }], new Date('2026-11-14T06:00:00Z'))
  return { label: `Client ${n} PI.xlsx`, fileHash: `${n}`.repeat(64).slice(0, 64), contentPrint: await contentPrint(reading.lines), reading, savedDate: '2025-06-01', verdict: judge(reading, reading.piDate !== null), failure: null }
}
const BED: Cell[] = ['1', 'King bed with headboard', 56, '78 x 84 x 42', null, 'Teak wood', 54800, 3068800]
const ROWS: Cell[][] = [BED, ['2', 'Bedside table, 2 drawers', 112, '20 x 16 x 22', null, 'Teak wood', 11400, 1276800], ['3', 'Lounge chair, sample piece', 1, '30 x 30 x 31', null, 'Mango', 28000, 28000]]
const DIMS = ['60 x 78', '72 x 78', '78 x 84']
const POOL: ModelPoint[] = Array.from({ length: 30 }, (_, i) => ({ k: 'order', p: 44000 + (i % 3) * 4000 + (i % 2) * 6000, q: 10, at: '2026-01-01T00:00:00Z', name: 'King bed with headboard', dims: DIMS[i % 3], material: i % 2 ? 'Teak wood' : 'Mango wood', finish: 'PU', client_type: null }))

describe('the three steps render with real data', () => {
  test('step 1 lists each file with what was found and what will not be learned', async () => {
    const good = await piFile(1, ROWS)
    const noDate = await piFile(2, ROWS, null)
    const usd = await piFile(3, [['1', 'Console', 10, '48 x 14 x 30', null, 'Mango', 220, 2200]]); usd.reading.currency = 'USD'; usd.verdict = judge(usd.reading, true)
    const out = renderToStaticMarkup(createElement(StepFiles, { files: [good, noDate, usd], seen: [], progress: null, error: null, clientType: '', onClientType: () => {}, onAdd: () => {}, onRemove: () => {}, onNext: () => {} }))
    assert.match(out, /3 of 25 files added/)
    assert.match(out, /Client 1 PI\.xlsx/)
    assert.match(out, /Read · totals match/)
    assert.match(out, /1 thing to check/)
    assert.match(out, /US dollars/)
    assert.match(out, /not stored/)
  })

  test('step 2 shows the order facts, the Sub Total proof, the ticked lines and a sample line left out', async () => {
    const pis = initialReview([await piFile(1, ROWS), await piFile(2, ROWS.slice(0, 2), null)], [], null)
    const out = renderToStaticMarkup(createElement(StepCheck, { pis, selected: pis[0].id, busy: false, error: null, onSelect: () => {}, onPi: () => {}, onEditLine: () => {}, onKeep: () => {}, onBack: () => {}, onNext: () => {} }))
    assert.match(out, /Client 1 PI\.xlsx/)
    assert.match(out, /adds up to the file(&#x27;|')s Sub Total/)
    assert.match(out, /A sample price: left out/)
    assert.match(out, /2 of 3 ticked/)
    assert.match(out, /Test blind, then learn 2 PIs/)
    assert.match(out, /<b>1<\/b> need a look/, 'the second file has no date of its own')
  })

  test('step 3 shows the score, the biggest misses with the feedback doorway, and the learn button', async () => {
    const pis = initialReview([await piFile(1, ROWS)], [], null)
    const t = blindTest(testLinesOf(pis), () => POOL, Date.parse('2026-11-14T06:00:00Z'))
    assert.equal(t.priced, 1)
    const out = renderToStaticMarkup(createElement(StepTest, { test: t, pis, previous: { avg_miss: 24.8, hit_rate: 31 }, saving: false, error: null, onBack: () => {}, onLearn: () => {} }))
    assert.match(out, /Blind test\./)
    assert.match(out, /Average miss/)
    assert.match(out, /against the last batch \(24\.8%\)/)
    assert.match(out, /Biggest misses/)
    assert.match(out, /Explain or correct/, 'every big miss carries the doorway')
    assert.match(out, /Learn this batch/)
    assert.match(out, /could not price/i)
  })

  test('step 3 with no prices to compare with says so and still offers to learn', async () => {
    const pis = initialReview([await piFile(1, ROWS)], [], null)
    const t = blindTest(testLinesOf(pis), () => [], Date.now())
    const out = renderToStaticMarkup(createElement(StepTest, { test: t, pis, previous: null, saving: false, error: null, onBack: () => {}, onLearn: () => {} }))
    assert.match(out, /The model had no prices to compare with/)
    assert.match(out, /Learn this batch/)
    assert.doesNotMatch(out, /Biggest misses/)
  })
})

describe('house rules for these screens', () => {
  const DIR = join(process.cwd(), 'src/components/pricing/learning')
  const files = readdirSync(DIR).filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f))
  const css = (f: string) => new Set([...readFileSync(f, 'utf8').matchAll(/\.([A-Za-z][A-Za-z0-9_]*)\b/g)].map(m => m[1]))
  const mine = css(join(DIR, 'learning.module.css'))
  const shared = css(join(process.cwd(), 'src/components/quotations/quotations.module.css'))

  test('every style class the screens use exists in the stylesheet they take it from (a missing one fails silently)', () => {
    for (const f of files) {
      const src = readFileSync(join(DIR, f), 'utf8')
      for (const m of src.matchAll(/\bl\.([A-Za-z][A-Za-z0-9_]*)/g)) assert.ok(mine.has(m[1]), `${f}: learning.module.css has no .${m[1]}`)
      for (const m of src.matchAll(/\bs\.([A-Za-z][A-Za-z0-9_]*)/g)) assert.ok(shared.has(m[1]), `${f}: quotations.module.css has no .${m[1]}`)
    }
  })

  test('links go through AppLink and nothing is prefetched (owner decision of 12 Nov 2026)', () => {
    for (const f of files) {
      const src = readFileSync(join(DIR, f), 'utf8')
      assert.doesNotMatch(src, /from 'next\/link'/, f)
      assert.doesNotMatch(src, /router\.prefetch|prefetch=\{true\}/, f)
    }
  })

  test('pictures are never read: the reader works from words and prices', () => {
    for (const f of ['readPi.ts', 'piFile.ts']) assert.doesNotMatch(readFileSync(join(process.cwd(), 'src/lib/pricing/learning', f), 'utf8'), /exceljs|getImages|\.xlsx\.load/i, f)
  })
})

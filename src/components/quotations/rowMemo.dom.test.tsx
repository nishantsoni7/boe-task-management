/**
 * TYPING IN ONE PRODUCT MUST NOT REDRAW THE OTHERS (owner's Vercel toolbar, 20 Nov 2026: 33 to 72 ms of input work plus 11 to 16 ms
 * of render on every keystroke in the Material and Remarks boxes). The real rows run in jsdom under a parent that is wired the way the
 * builder is: the lines live in the parent, every keystroke sets them, and a new suggestion / feedback object is made on every render.
 * A row's `url` is called once each time it is drawn (for its picture), so the calls are the count of draws.
 *
 * Run: npm run test:file -- src/components/quotations/rowMemo.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, useState } from 'react'
import '@/lib/testing/cssModuleStub'
import type { QuoteLine } from '@/lib/quotations/math'
import { LineRow, ProductRow, sameRow } from './ProductLine'
import { useRowActions, type RowActions } from './rowActions'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const mk = (i: number): QuoteLine => ({
  key: `l${i}`, area_key: null, name: `King bed ${i}`, size_text: '83 × 68', spec: '', material: 'Ash wood', finish: '', category: '',
  qty_mode: 'fixed', qty: 4, unit_price: 38500, tax_rate: 18, image_path: `u/${i}.jpg`, is_optional: false, client_note: '', internal_note: '',
})
const drawn = new Map<string, number>()
const url = (p: string) => { drawn.set(p, (drawn.get(p) ?? 0) + 1); return `https://img.example/${p}` }
const noop = () => {}
const modelOf = (i: number) => ({ price: 40000 + i, low: 36000, high: 44000, confidence: 'high' as const, reasons: ['+10% Teak'], basis: 'the price model', n: 40, type: 'bed' })

function Screen({ variant, log }: { variant: 'memo' | 'plain'; log: string[] }) {
  const [lines, setLines] = useState<QuoteLine[]>(() => [0, 1, 2].map(mk))
  const change = (key: string, patch: Partial<QuoteLine>) => setLines(p => p.map(l => (l.key === key ? { ...l, ...patch } : l)))
  // Like removeLine: it records what it saw in the render it was made in (the Undo keeps that).
  const remove = (key: string) => { log.push(`remove ${key} saw ${lines.map(l => l.spec).join('|')}`) }
  const actions = useRowActions({ change, upload: noop, improve: noop, view: noop, remove, move: noop, duplicate: noop })
  return createElement('div', null, lines.map((l, i) => {
    const common = { l, area: null, unit: 'in' as const, editable: true, qty: 4, total: 154000, first: i === 0, last: i === lines.length - 1, url }
    // A NEW object with the same values on every render, as the builder makes them on every keystroke.
    const model = modelOf(i), feedbackCtx = { clientType: null, quotationId: 'q1', isDesk: true }
    return variant === 'memo'
      ? createElement(ProductRow, { key: l.key, ...common, actions, model, feedbackCtx })
      : createElement(LineRow, { key: l.key, ...common, onChange: p => change(l.key, p), onUpload: noop, onImprove: noop, onView: noop, onRemove: () => remove(l.key), onMove: noop, onDuplicate: noop, model, feedbackCtx })
  }))
}
const remarks = (ui: ReturnType<typeof mount>, i: number) => ui.all<HTMLTextAreaElement>('textarea[aria-label="Remarks / customization"]')[i]
const drew = (i: number) => drawn.get(`u/${i}.jpg`) ?? 0

describe('typing in one product', () => {
  test('draws that product again and leaves the others alone', () => {
    const ui = mount(createElement(Screen, { variant: 'memo', log: [] })); cleanup = () => ui.unmount()
    drawn.clear()
    ui.type(remarks(ui, 0), 'Solid frame')
    assert.equal(remarks(ui, 0).value, 'Solid frame', 'what was typed is on the screen')
    assert.ok(drew(0) >= 1, 'the product typed in is drawn again')
    assert.equal(drew(1), 0, 'the second product is not')
    assert.equal(drew(2), 0, 'the third product is not')
  })

  test('control: drawn the way the builder did before, every product is drawn again (so this test can tell)', () => {
    const ui = mount(createElement(Screen, { variant: 'plain', log: [] })); cleanup = () => ui.unmount()
    drawn.clear()
    ui.type(remarks(ui, 0), 'Solid frame')
    assert.ok(drew(1) >= 1 && drew(2) >= 1)
  })

  test('a click still reaches the NEWEST builder function: Remove after typing sees the typed text', () => {
    const log: string[] = []
    const ui = mount(createElement(Screen, { variant: 'memo', log })); cleanup = () => ui.unmount()
    ui.type(remarks(ui, 0), 'abc')
    ui.click(ui.all('button[aria-label="Remove product"]')[1])
    // The row never got new props, yet the call used the render after the typing: the Undo of a removed product depends on it.
    assert.deepEqual(log, ['remove l1 saw abc||'])
  })
})

describe('when a row is drawn again', () => {
  const ACTIONS: RowActions = { change: noop, upload: noop, improve: noop, view: noop, remove: noop, move: noop, duplicate: noop }
  const LINE = mk(0) // an untouched line keeps its identity from one render to the next: only the edited one is a new object
  const base = (): Parameters<typeof sameRow>[0] => ({
    l: LINE, area: null, unit: 'in', editable: true, qty: 4, total: 154000, first: true, last: false, url, actions: ACTIONS, onUploadSwatch: undefined,
    model: modelOf(0), feedbackCtx: { clientType: null, quotationId: 'q1', isDesk: true }, hint: undefined,
  })
  test('the same things, or new objects holding the same values: not drawn again', () => {
    assert.equal(sameRow(base(), base()), true)
    assert.equal(sameRow({ ...base(), model: { ...modelOf(0), reasons: ['+10% Teak'] } }, base()), true)
    assert.equal(sameRow({ ...base(), hint: { name: 'King bed', ordered: null, quoted: null } as never }, { ...base(), hint: { name: 'King bed', ordered: null, quoted: null } as never }), true)
  })
  test('anything the row shows or calls changed: drawn again', () => {
    assert.equal(sameRow({ ...base(), l: { ...mk(0), spec: 'x' } }, base()), false, 'its own line')
    assert.equal(sameRow({ ...base(), model: modelOf(5) }, base()), false, 'the suggested price')
    assert.equal(sameRow({ ...base(), model: null }, base()), false, 'the suggestion going away')
    assert.equal(sameRow({ ...base(), feedbackCtx: undefined }, base()), false, 'the Why? doorway')
    assert.equal(sameRow({ ...base(), qty: 5 }, base()), false, 'the quantity')
    assert.equal(sameRow({ ...base(), editable: false }, base()), false, 'the quotation being locked')
    assert.equal(sameRow({ ...base(), url: (p: string) => p }, base()), false, 'the picture mark being switched')
    assert.equal(sameRow({ ...base(), actions: { ...ACTIONS } }, base()), false, 'new actions')
  })
})

describe('the builder', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
  const SCREEN = read('src/components/quotations/BuilderScreen.tsx')
  test('draws its products with ProductRow and one never-changing set of actions, with the hook above the early returns', () => {
    assert.match(SCREEN, /<ProductRow key=\{l\.key\}[\s\S]*?actions=\{rowActions\}/)
    assert.ok(!/<LineRow\b/.test(SCREEN), 'no row is drawn without the memo')
    const hook = SCREEN.indexOf('useRowActions({'), early = SCREEN.indexOf('if (loading) return')
    assert.ok(hook > 0 && early > 0 && hook < early, 'a hook after an early return would break the order of hooks')
    assert.ok(/const picSrc = useCallback\(/.test(SCREEN), 'the picture function keeps its identity until the mark changes')
  })
})

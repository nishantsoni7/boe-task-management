// Client choices as cards (version 2, step 3, 25 Nov 2026; 20270828000000): add one by any name, Done, the pencil, confirm, remove and
// Copy to…, run in jsdom with a person's clicks and typing.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, useState } from 'react'
import { ChoicesPanel, CopyChoiceDialog } from './ChoicesPanel'
import type { ChoiceKey, LineChoices, QuoteLine } from '@/lib/quotations/math'

function panel(start?: LineChoices) {
  const seen: LineChoices[] = []
  const copies: ChoiceKey[] = []
  function Host() {
    const [c, setC] = useState<LineChoices | undefined>(start)
    return createElement(ChoicesPanel, {
      choices: c, editable: true, url: (p: string) => `https://img.example/${p}`, onUpload: async () => 'x',
      onChange: (v: LineChoices) => { seen.push(v); setC(v) }, onCopy: (k: ChoiceKey) => { copies.push(k) },
    })
  }
  const ui = mount(createElement(Host))
  return { ui, seen, copies, last: () => seen[seen.length - 1] }
}
const input = (ui: ReturnType<typeof mount>, label: string) => ui.one<HTMLInputElement>(`[aria-label="${label}"]`)

describe('adding a choice', () => {
  test('Add a choice opens a form with the Choice box first; any name is kept under its own key with its label', () => {
    const p = panel()
    p.ui.click(p.ui.button(/^Add a choice/))
    const choice = input(p.ui, 'Choice')
    assert.equal(p.ui.container.ownerDocument.activeElement, choice, 'the Choice box has the focus')
    assert.ok(p.ui.all('datalist option').some(o => o.getAttribute('value') === 'Leather'), 'names are suggested')
    p.ui.type(choice, 'Leather')
    p.ui.type(input(p.ui, 'Leather name'), 'Tan nubuck')
    p.ui.click(p.ui.button('Done'))
    const keys = Object.keys(p.last())
    assert.equal(keys.length, 1)
    assert.match(keys[0], /^x_[a-z0-9]{2,24}$/)
    assert.deepEqual(p.last()[keys[0] as ChoiceKey], { source: 'catalog', status: 'to_confirm', label: 'Leather', name: 'Tan nubuck' })
    assert.match(p.ui.one('.ccCard').textContent ?? '', /Leather · to confirmTan nubuck/)
    p.ui.unmount()
  })
  test('named like a fixed kind, it moves to that kind on Done, and the form then shows the kind without a box', () => {
    const p = panel()
    p.ui.click(p.ui.button(/^Add a choice/))
    p.ui.type(input(p.ui, 'Choice'), 'fabric')
    p.ui.click(p.ui.button('Done'))
    assert.deepEqual(Object.keys(p.last()), ['fabric'])
    assert.equal('label' in p.last().fabric!, false)
    p.ui.click(p.ui.one('button[aria-label="Edit Fabric"]'))
    assert.equal(p.ui.all('[aria-label="Choice"]').length, 0)
    assert.equal(p.ui.one('.ccFixed').textContent, 'Fabric')
    p.ui.unmount()
  })
})

describe('editing a card', () => {
  test('the pencil edits it in place; Confirmed stamps today; the bin removes it', () => {
    const p = panel({ finish: { source: 'catalog', status: 'to_confirm', name: 'Walnut' } })
    assert.equal(p.ui.all('.ccEdit').length, 0)
    p.ui.click(p.ui.one('button[aria-label="Edit Finish"]'))
    assert.equal(p.ui.all('.ccEdit').length, 1)
    p.ui.click(p.ui.one('.ccEdit input[type="checkbox"]'))
    assert.equal(p.last().finish!.status, 'confirmed')
    assert.match(p.last().finish!.confirmed_on ?? '', /^\d{4}-\d{2}-\d{2}$/)
    p.ui.click(p.ui.one('button[aria-label="Remove Finish"]'))
    assert.deepEqual(p.last(), {})
    assert.equal(p.ui.all('.ccCard').length, 0)
    p.ui.unmount()
  })
  test('Copy to… finishes the card first and hands over the key it ends up under', () => {
    const p = panel({ x_mf0a: { source: 'catalog', status: 'to_confirm', label: 'Stone', name: 'Slate' } })
    p.ui.click(p.ui.one('button[aria-label="Edit Stone"]'))
    p.ui.click(p.ui.button(/Copy to/))
    assert.deepEqual(p.copies, ['stone'])
    assert.deepEqual(Object.keys(p.last()), ['stone'])
    p.ui.unmount()
  })
  test('a product with twelve choices offers no Add', () => {
    const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`x_k${String(i).padStart(2, '0')}`, { source: 'client', status: 'to_confirm', label: `C${i}` }])) as LineChoices
    const p = panel(twelve)
    assert.equal(p.ui.all('.ccAdd').length, 0)
    assert.match(p.ui.text(), /A product holds 12 choices at most\./)
    p.ui.unmount()
  })
})

describe('Copy to…', () => {
  const L = (key: string, name: string, choices?: LineChoices): QuoteLine => ({
    key, area_key: null, name, size_text: '', spec: '', material: '', finish: '', category: '', qty_mode: 'fixed', qty: 1, unit_price: 1, tax_rate: 18,
    image_path: null, is_optional: false, client_note: '', internal_note: '', choices,
  })
  test('lists every other product with its number and what it has; quick picks; copies to the picked ones; Escape closes', () => {
    const lines = [
      L('a', 'Sofa', { fabric: { source: 'catalog', status: 'to_confirm', name: 'Velvet' } }),
      L('b', 'Chair', { fabric: { source: 'catalog', status: 'confirmed', name: 'Linen' } }),
      L('c', 'Bench'),
      L('d', 'Stool'),
    ]
    const got: ReadonlySet<string>[] = []
    let closed = 0
    const ui = mount(createElement(CopyChoiceDialog, { lines, from: 'a', choiceKey: 'fabric', url: (p: string) => p, onCopy: (to: ReadonlySet<string>) => { got.push(to) }, onClose: () => { closed++ } }))
    const rows = ui.all('.cpItem').map(r => r.textContent)
    assert.deepEqual(rows, ['2 Chairhas Linen', '3 Benchno fabric yet', '4 Stoolno fabric yet'])
    assert.ok(ui.button(/^Copy to 0 products/).disabled)
    ui.click(ui.button(/^Only those without fabric \(2\)/))
    ui.click(ui.button(/^Copy to 2 products/))
    assert.deepEqual([...got[0]].sort(), ['c', 'd'])
    ui.click(ui.button(/^Select all \(3\)/))
    assert.ok(ui.all<HTMLInputElement>('.cpItem input').every(i => i.checked))
    ui.press('Escape')
    assert.equal(closed, 1)
    ui.unmount()
  })
})

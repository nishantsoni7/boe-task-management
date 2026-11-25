// Copy and paste a product's picture with the keyboard (owner, 18 Nov 2026), and the parts of the product line (version 2, 25 Nov 2026) that
// only a person's clicks and typing show: the strip under the boxes and the price box. Runs the real product line in jsdom.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement, useState } from 'react'
import { LineRow } from './ProductLine'
import { PICTURE_MARK, onCopy, onPaste, validPicturePath } from './pictureClipboard'
import type { QuoteLine } from '@/lib/quotations/math'

const line = (key: string, image_path: string | null): QuoteLine => ({
  key, area_key: null, name: 'Chair', size_text: '', spec: '', material: '', finish: '', category: '',
  qty_mode: 'fixed', qty: 1, unit_price: 1000, tax_rate: 18, image_path, is_optional: false, client_note: '', internal_note: '',
})

/** A clipboard event the way the browser hands it over: text and files, and whether the default was prevented. */
function clip(type: 'copy' | 'paste', put: { text?: string; files?: File[] } = {}) {
  const store: Record<string, string> = { 'text/plain': put.text ?? '' }
  const e = new Event(type, { cancelable: true }) as ClipboardEvent
  Object.defineProperty(e, 'clipboardData', { value: { setData: (k: string, v: string) => { store[k] = v }, getData: (k: string) => store[k] ?? '', files: put.files ?? [] } })
  return { e, store }
}

/** The builder holds whether a product's Client choices are open (its bar opens them all); here a one-product host holds it. */
function Host(props: Omit<Parameters<typeof LineRow>[0], 'choicesOpen' | 'onChoicesOpen'>) {
  const [open, setOpen] = useState(false)
  return createElement(LineRow, { ...props, choicesOpen: open, onChoicesOpen: setOpen })
}

function row(l: QuoteLine, editable = true) {
  const changes: Partial<QuoteLine>[] = []
  const uploads: File[] = []
  const ui = mount(createElement(Host, {
    l, n: 1, area: null, unit: 'in', editable, qty: 1, total: 1000, first: true, last: true, url: (p: string) => `https://img.example/${p}`,
    onChange: (p: Partial<QuoteLine>) => { changes.push(p) }, onUpload: (f: File | undefined) => { if (f) uploads.push(f) },
    onImprove: () => {}, onView: () => {}, onRemove: () => {}, onMove: () => {}, onDuplicate: () => {},
  }))
  const pic = ui.container.querySelector('.plPic') as HTMLElement
  return { ui, pic, changes, uploads }
}

const enter = (el: HTMLElement) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })

describe('product picture copy and paste', () => {
  test('pointing at a picture and copying puts its path on the clipboard', async () => {
    const a = row(line('a', 'q/1/chair.jpg'))
    await enter(a.pic)
    const { e, store } = clip('copy')
    onCopy(e)
    assert.equal(store['text/plain'], `${PICTURE_MARK}q/1/chair.jpg`)
    assert.equal(e.defaultPrevented, true)
    a.ui.unmount()
  })

  test('pasting that onto another product gives it the same picture; an image file is uploaded', async () => {
    const b = row(line('b', null))
    await enter(b.pic)
    onPaste(clip('paste', { text: `${PICTURE_MARK}q/1/chair.jpg` }).e)
    assert.deepEqual(b.changes, [{ image_path: 'q/1/chair.jpg' }])
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    onPaste(clip('paste', { files: [file] }).e)
    assert.equal(b.uploads[0], file)
    b.ui.unmount()
  })

  test('typing in a text field is left alone, and a product that may not be edited takes no paste', async () => {
    const b = row(line('b', null))
    await enter(b.pic)
    const input = b.ui.container.querySelector('input[aria-label="Product name"]') as HTMLInputElement
    input.focus()
    const typed = clip('paste', { text: `${PICTURE_MARK}q/1/chair.jpg` })
    onPaste(typed.e)
    assert.equal(typed.e.defaultPrevented, false)
    assert.deepEqual(b.changes, [])
    input.blur()
    b.ui.unmount()
    const locked = row(line('c', null), false)
    await enter(locked.pic)
    onPaste(clip('paste', { text: `${PICTURE_MARK}q/1/chair.jpg` }).e)
    assert.deepEqual(locked.changes, [])
    locked.ui.unmount()
  })

  test('only a plain storage path is taken', () => {
    assert.equal(validPicturePath('quotations/abc/pic-1.jpg'), true)
    for (const bad of ['', '../secret', '/abs/path', 'a b', 'https://x.example/p.png', 'x'.repeat(500)]) assert.equal(validPicturePath(bad), false, bad)
  })
})

describe('the strip under the boxes (version 2)', () => {
  test('the internal note is closed even when it has text, and the strip shows that text; opening it shows the box, for the team only', () => {
    const a = row({ ...line('a', null), internal_note: 'Teak at the usual rate' })
    const note = a.ui.button(/^Internal note/)
    assert.equal(note.getAttribute('aria-expanded'), 'false')
    assert.match(note.textContent ?? '', /Teak at the usual rate/)
    assert.equal(a.ui.all('.plOpens').length, 0, 'nothing open')
    a.ui.click(note)
    assert.equal(note.getAttribute('aria-expanded'), 'true')
    const box = a.ui.one<HTMLInputElement>('.plOpens input[aria-label="Internal note"]')
    assert.equal(box.value, 'Teak at the usual rate')
    assert.match(a.ui.one('.plOpens').textContent ?? '', /Only your team sees this\. It is never shown to the client\./)
    a.ui.type(box, 'Ask Nitish')
    assert.deepEqual(a.changes, [{ internal_note: 'Ask Nitish' }])
    a.ui.unmount()
  })
  test('Client choices says what was chosen without opening; opening shows the panel under the product, and both can be open at once', () => {
    const a = row({ ...line('a', null), choices: { fabric: { source: 'catalog', status: 'to_confirm', name: 'Berlin velvet' } } })
    const choices = a.ui.button(/^Client choices/)
    assert.equal(choices.getAttribute('aria-expanded'), 'false')
    assert.match(choices.textContent ?? '', /Fabric: Berlin velvet.*1 to confirm/)
    a.ui.click(choices)
    assert.equal(choices.getAttribute('aria-expanded'), 'true')
    assert.match(a.ui.one('.plOpens .ccCard').textContent ?? '', /Fabric · to confirmBerlin velvet/)
    a.ui.click(a.ui.button(/^Internal note/))
    assert.ok(a.ui.all('.plOpens input[aria-label="Internal note"]').length === 1 && a.ui.all('.plOpens .ccCards').length === 1)
    a.ui.unmount()
  })
  test('the tools sit in the strip; a product that may not be edited has none', () => {
    const a = row(line('a', null))
    const tools = a.ui.one('.plStrip [role="group"][aria-label="Product tools"]')
    assert.deepEqual([...tools.querySelectorAll('button')].map(b => b.getAttribute('aria-label')), ['Move up', 'Move down', 'Duplicate', 'Remove product'])
    a.ui.unmount()
    const locked = row(line('b', null), false)
    assert.equal(locked.ui.all('[aria-label="Product tools"]').length, 0)
    locked.ui.unmount()
  })
})

describe('the price box (version 2)', () => {
  test('it shows 13,500 until it is clicked, the plain digits while it is typed in, and keeps only the digits that are typed', () => {
    const a = row({ ...line('a', null), unit_price: 13500 })
    const box = a.ui.one<HTMLInputElement>('input[aria-label="Unit price (₹, before GST)"]')
    assert.equal(box.value, '13,500')
    act(() => { box.focus() })
    assert.equal(box.value, '13500')
    a.ui.type(box, '14,2a00')
    a.ui.type(box, '')
    assert.deepEqual(a.changes, [{ unit_price: 14200 }, { unit_price: null }], 'an empty box is no price')
    act(() => { box.blur() })
    assert.equal(box.value, '13,500')
    a.ui.unmount()
  })
})

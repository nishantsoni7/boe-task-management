// Copy and paste a product's picture with the keyboard (owner, 18 Nov 2026). Runs the real product line in jsdom.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
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

function row(l: QuoteLine, editable = true) {
  const changes: Partial<QuoteLine>[] = []
  const uploads: File[] = []
  const ui = mount(createElement(LineRow, {
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

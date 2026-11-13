/**
 * THE PICTURE POP-UP, RUN FOR REAL (owner, 13 Nov 2026): click a product's picture to see it large; ← and → go to the previous
 * and next product that has a picture; Esc closes. Run in jsdom with the real component.
 *
 * Run: npm run test:file -- src/components/quotations/pictureViewer.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, useState } from 'react'
import '@/lib/testing/cssModuleStub'
import { PictureViewer, stepIndex, type ViewerItem } from './PictureViewer'

// The pop-up loads the neighbouring pictures with `new Image()`; jsdom's window has it, the harness does not copy it across.
const loaded: string[] = []
Object.defineProperty(globalThis, 'Image', { value: class { set src(v: string) { loaded.push(v) } }, configurable: true, writable: true })

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

const ITEMS: ViewerItem[] = [
  { key: 'a', name: 'Beds', detail: '83 × 68 in · Acacia Wood', path: 'u/a.jpg' },
  { key: 'b', name: 'Side Table', detail: '18 × 18 × 18 in', path: 'u/b.jpg' },
  { key: 'c', name: 'Coffee Table', detail: '', path: 'u/c.jpg' },
]
const url = (p: string) => `https://img.example/${p}`

// The parent the builder is: it holds which picture is open, and closes the pop-up when told to.
function Parent({ items = ITEMS, start = 0, log }: { items?: ViewerItem[]; start?: number; log: string[] }) {
  const [at, setAt] = useState<number | null>(start)
  return createElement('div', null,
    createElement('button', { id: 'opener' }, 'opener'),
    at !== null && createElement(PictureViewer, { items, index: at, url, onIndex: i => { log.push(`index ${i}`); setAt(i) }, onClose: () => { log.push('closed'); setAt(null) } }))
}
const shown = (ui: ReturnType<typeof mount>) => ui.one<HTMLImageElement>('[role="dialog"] img[alt]:not([alt=""])').getAttribute('src')

describe('stepping', () => {
  test('→ on the last picture goes to the first, ← on the first goes to the last; one picture stays put', () => {
    assert.equal(stepIndex(0, 3, 1), 1)
    assert.equal(stepIndex(2, 3, 1), 0)
    assert.equal(stepIndex(0, 3, -1), 2)
    assert.equal(stepIndex(0, 1, 1), 0)
    assert.equal(stepIndex(0, 0, -1), 0)
  })
})

describe('the picture pop-up', () => {
  test('it shows the product, its details, the picture and where it is in the pictures', () => {
    const ui = mount(createElement(Parent, { log: [] })); cleanup = () => ui.unmount()
    assert.equal(ui.one('[role="dialog"]').getAttribute('aria-modal'), 'true')
    assert.match(ui.text(), /Beds/)
    assert.match(ui.text(), /83 × 68 in · Acacia Wood/)
    assert.match(ui.text(), /1 of 3 with pictures/)
    assert.equal(shown(ui), 'https://img.example/u/a.jpg')
    assert.ok(loaded.includes('https://img.example/u/b.jpg') && loaded.includes('https://img.example/u/c.jpg'), 'the next and the previous picture load in advance')
  })

  test('the right and left arrow keys go to the next and the previous product', () => {
    const ui = mount(createElement(Parent, { log: [] })); cleanup = () => ui.unmount()
    ui.press('ArrowRight')
    assert.match(ui.text(), /Side Table/); assert.match(ui.text(), /2 of 3/)
    assert.equal(shown(ui), 'https://img.example/u/b.jpg')
    ui.press('ArrowRight'); ui.press('ArrowRight')
    assert.match(ui.text(), /1 of 3/, 'after the last it comes round to the first')
    ui.press('ArrowLeft')
    assert.match(ui.text(), /3 of 3/); assert.equal(shown(ui), 'https://img.example/u/c.jpg')
  })

  test('the two round buttons and the small pictures do the same for a mouse or a finger', () => {
    const ui = mount(createElement(Parent, { log: [] })); cleanup = () => ui.unmount()
    ui.click(ui.one('[aria-label="Next product"]'))
    assert.match(ui.text(), /2 of 3/)
    ui.click(ui.one('[aria-label="Previous product"]'))
    assert.match(ui.text(), /1 of 3/)
    ui.click(ui.one('[aria-label="Show Coffee Table"]'))
    assert.match(ui.text(), /3 of 3/)
  })

  test('Esc, the close button and a click outside close it; a click on the picture does not', () => {
    const log: string[] = []
    let ui = mount(createElement(Parent, { log })); cleanup = () => ui.unmount()
    ui.press('Escape'); assert.equal(ui.all('[role="dialog"]').length, 0)
    ui.unmount()
    ui = mount(createElement(Parent, { log })); cleanup = () => ui.unmount()
    ui.click(ui.one('[aria-label="Close"]')); assert.equal(ui.all('[role="dialog"]').length, 0)
    ui.unmount()
    ui = mount(createElement(Parent, { log })); cleanup = () => ui.unmount()
    ui.click(ui.one('[role="dialog"]')); assert.equal(ui.all('[role="dialog"]').length, 1, 'inside the pop-up: stays open')
    ui.click(ui.one('[role="dialog"]').parentElement as Element); assert.equal(ui.all('[role="dialog"]').length, 0, 'outside: closes')
    assert.deepEqual(log, ['closed', 'closed', 'closed'])
  })

  test('one picture only: no arrows, no keys wasted on it, still closes with Esc', () => {
    const ui = mount(createElement(Parent, { items: [ITEMS[0]], log: [] })); cleanup = () => ui.unmount()
    assert.equal(ui.all('[aria-label="Next product"]').length, 0)
    assert.match(ui.text(), /1 of 1 with pictures/)
    ui.press('ArrowRight'); assert.match(ui.text(), /Beds/)
    ui.press('Escape'); assert.equal(ui.all('[role="dialog"]').length, 0)
  })

  test('focus moves into the pop-up and goes back to where it was; Tab stays inside', () => {
    const ui = mount(createElement(Parent, { start: 0, log: [] })); cleanup = () => ui.unmount()
    assert.ok(ui.one('[role="dialog"]').contains(document.activeElement), 'focus is inside the pop-up')
    const stops = ui.all<HTMLElement>('[role="dialog"] button')
    stops[stops.length - 1].focus()
    assert.equal(document.activeElement, stops[stops.length - 1])
    ui.press('Tab')
    assert.equal(document.activeElement, stops[0], 'Tab on the last button wraps to the first, not out to the page')
  })
})

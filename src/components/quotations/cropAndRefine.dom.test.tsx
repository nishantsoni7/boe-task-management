// Crop by drawing a box, and change a made picture again with comments (owner, 18 Nov 2026). Real components in jsdom.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { CropBox, WHOLE, boxBetween, fitBox, type Box } from './CropBox'
import { StudioDialog } from './StudioDialog'

describe('the crop box', () => {
  test('a box between two points, whichever way it was dragged, kept inside the picture and never tiny', () => {
    assert.deepEqual(boxBetween({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.1 }), { x: 0.2, y: 0.1, w: 0.6000000000000001, h: 0.8 })
    const tiny = boxBetween({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })
    assert.ok(tiny.w >= 0.03 && tiny.h >= 0.03)
    assert.deepEqual(fitBox({ x: 0.9, y: -0.2, w: 0.5, h: 0.5 }), { x: 0.5, y: 0, w: 0.5, h: 0.5 })
  })

  test('dragging on the picture draws the area to keep; dragging inside it moves it', async () => {
    const img = { naturalWidth: 400, naturalHeight: 200 } as HTMLImageElement
    let box: Box = WHOLE
    const ui = mount(createElement(CropBox, { img, turns: 0, box, onBox: (b: Box) => { box = b } }))
    const area = ui.container.querySelector('[data-crop-area]') as HTMLElement
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const fire = (el: Element, type: string, x: number, y: number) => act(() => {
      el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: 1 }))
    })
    await fire(area, 'pointerdown', 40, 20)
    await fire(area, 'pointermove', 240, 120)
    await fire(area, 'pointerup', 240, 120)
    assert.deepEqual(box, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 })
    ui.unmount()
  })

  test('on first open the box is the whole picture and covers it: a drag on it still DRAWS a box, it does not move the whole', async () => {
    const img = { naturalWidth: 400, naturalHeight: 200 } as HTMLImageElement
    let box: Box = WHOLE
    const ui = mount(createElement(CropBox, { img, turns: 0, box, onBox: (b: Box) => { box = b } }))
    const area = ui.container.querySelector('[data-crop-area]') as HTMLElement
    area.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const fire = (el: Element, type: string, x: number, y: number) => act(() => {
      el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: 1 }))
    })
    await fire(ui.container.querySelector('[data-crop-box]')!, 'pointerdown', 40, 20)
    await fire(area, 'pointermove', 240, 120)
    await fire(area, 'pointerup', 240, 120)
    assert.deepEqual(box, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 })
    ui.unmount()
  })
})

describe('changing a made picture again', () => {
  test('"Make these changes" sends the made picture back with what to change, and Back returns to it', async () => {
    const sent: Array<Record<string, unknown>> = []
    let n = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      n++
      return new Response(JSON.stringify({ ok: true, path: `u1/made-${n}.jpg` }), { status: 200 })
    }) as typeof fetch
    try {
      const ui = mount(createElement(StudioDialog, {
        supabase: {} as never, userId: 'u1', path: 'u1/original.jpg', url: (p: string) => `https://img.example/${p}`,
        onClose: () => {}, onUse: () => {},
      }))
      // The action buttons, not the tab of the same name: the last button with that text.
      const button = (label: string) => [...ui.container.querySelectorAll('button')].filter(b => b.textContent?.trim() === label).pop()!
      const click = (label: string) => act(async () => { ui.click(button(label)); await new Promise(r => setTimeout(r, 0)) })
      await click('Clean up')
      assert.deepEqual(sent[0], { sourcePath: 'u1/original.jpg', mode: 'clean', instruction: '', reference: null, details: '' })
      ui.type(ui.container.querySelector('[data-refine] input') as HTMLInputElement, 'remove the cushion')
      await click('Make these changes')
      assert.deepEqual(sent[1], { sourcePath: 'u1/made-1.jpg', mode: 'change', instruction: 'remove the cushion', reference: null, details: '' })
      assert.match(ui.text(), /Back to the previous one/)
      ui.unmount()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe('the product details and the reference picture (owner, 23 Nov 2026)', () => {
  const DETAILS = 'Product: Dining chair. Size: 47 × 52 × 80 in. Material: Ash wood'
  test('the line\'s details start in a box, go with every request, and an emptied box sends none', async () => {
    const sent: Array<Record<string, unknown>> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, path: `u1/made-${sent.length}.jpg` }), { status: 200 })
    }) as typeof fetch
    try {
      const ui = mount(createElement(StudioDialog, {
        supabase: {} as never, userId: 'u1', path: 'u1/original.jpg', url: (p: string) => `https://img.example/${p}`,
        details: DETAILS, onClose: () => {}, onUse: () => {},
      }))
      const box = ui.container.querySelector('textarea[aria-label="Details sent with the picture"]') as HTMLTextAreaElement
      assert.equal(box.value, DETAILS)
      const button = (label: string) => [...ui.container.querySelectorAll('button')].filter(b => b.textContent?.trim() === label).pop()!
      const click = (label: string) => act(async () => { ui.click(button(label)); await new Promise(r => setTimeout(r, 0)) })
      await click('Clean up')
      assert.equal(sent[0].details, DETAILS)
      // The next round of changes carries them too, and the box can be emptied for it.
      ui.type(box, '')
      ui.type(ui.container.querySelector('[data-refine] input') as HTMLInputElement, 'straight legs')
      await click('Make these changes')
      assert.equal(sent[1].details, '')
      ui.unmount()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a reference picture shows as a thumbnail with Remove, goes with a change, never with Clean up', async () => {
    const sent: Array<Record<string, unknown>> = []
    const realFetch = globalThis.fetch
    const g = globalThis as Record<string, unknown>
    const realBitmap = g.createImageBitmap
    const canvasProto = Object.getPrototypeOf(document.createElement('canvas')) as Record<string, unknown>
    const realCtx = canvasProto.getContext
    const realToBlob = canvasProto.toBlob
    const realReader = g.FileReader
    // jsdom cannot draw: stand in for the browser's decoder and canvas, so the real "add a picture" path runs.
    g.createImageBitmap = async () => ({ width: 10, height: 10, close() {} })
    canvasProto.getContext = () => ({ drawImage() {} })
    canvasProto.toBlob = (cb: (b: Blob) => void) => cb(new Blob(['x'], { type: 'image/jpeg' }))
    g.FileReader = new JSDOM('').window.FileReader
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true, path: 'u1/made.jpg' }), { status: 200 })
    }) as typeof fetch
    try {
      const ui = mount(createElement(StudioDialog, {
        supabase: {} as never, userId: 'u1', path: 'u1/original.jpg', url: (p: string) => `https://img.example/${p}`,
        wants: 'Mustard velvet', onClose: () => {}, onUse: () => {},
      }))
      const button = (label: string) => [...ui.container.querySelectorAll('button')].filter(b => b.textContent?.trim() === label).pop()!
      const click = (label: string) => act(async () => { ui.click(button(label)); await new Promise(r => setTimeout(r, 0)) })
      // Opens on Change it: a plain button, no thumbnail yet, and the bare browser file picker is gone.
      assert.match(ui.text(), /Add a reference picture/)
      assert.ok(!/Reference picture \(optional\)/.test(ui.text()))
      assert.equal(ui.container.querySelector('[data-reference] img'), null)
      const file = ui.container.querySelector('[data-reference] input[type="file"]') as HTMLInputElement
      assert.equal(file.hidden, true)
      Object.defineProperty(file, 'files', { value: [new File(['x'], 'sofa.jpg', { type: 'image/jpeg' })], configurable: true })
      await act(async () => { file.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 20)) })
      assert.ok(ui.container.querySelector('[data-reference] img'), 'the thumbnail shows')
      await click('Make the change')
      assert.match(String(sent[0].reference), /^data:image\/jpeg;base64,/)
      // Clean up redraws the same design: the reference stays added but is not sent.
      ui.click([...ui.container.querySelectorAll('[role="tab"]')].find(b => b.textContent?.trim() === 'Clean up')!)
      await click('Clean up')
      assert.equal(sent[1].mode, 'clean')
      assert.equal(sent[1].reference, null)
      // After a result the box is still there: Remove takes it out of the next round of changes.
      assert.ok(ui.container.querySelector('[data-refine] [data-reference] img'))
      await click('Remove')
      ui.type(ui.container.querySelector('[data-refine] input') as HTMLInputElement, 'lighter wood')
      await click('Make these changes')
      assert.equal(sent[2].reference, null)
      ui.unmount()
    } finally {
      globalThis.fetch = realFetch
      g.createImageBitmap = realBitmap; canvasProto.getContext = realCtx; canvasProto.toBlob = realToBlob; g.FileReader = realReader
    }
  })
})

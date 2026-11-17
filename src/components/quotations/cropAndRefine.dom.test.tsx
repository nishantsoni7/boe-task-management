// Crop by drawing a box, and change a made picture again with comments (owner, 18 Nov 2026). Real components in jsdom.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
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
      assert.deepEqual(sent[0], { sourcePath: 'u1/original.jpg', mode: 'clean', instruction: '', reference: null })
      ui.type(ui.container.querySelector('[data-refine] input') as HTMLInputElement, 'remove the cushion')
      await click('Make these changes')
      assert.deepEqual(sent[1], { sourcePath: 'u1/made-1.jpg', mode: 'change', instruction: 'remove the cushion', reference: null })
      assert.match(ui.text(), /Back to the previous one/)
      ui.unmount()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

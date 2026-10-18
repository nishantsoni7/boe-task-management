/**
 * A tiny DOM test harness: mount a React element into jsdom and drive it like a person does
 * (click, type, press a key), then assert on what is on the screen.
 *
 * WHY: most "tests" of the payment forms used to read the .tsx source and look for a string,
 * which proves a string exists, not that pressing the button on an empty form names what is
 * missing. These run the real component.
 *
 * Usage:
 *   import { mount } from '@/lib/testing/domHarness'      // import this BEFORE anything that imports react-dom
 *   const ui = mount(createElement(Thing, props))
 *   ui.click(ui.button('Record payment'))
 *   assert.match(ui.text(), /Enter the amount/)
 *   ui.unmount()
 *
 * The DOM is installed once, when this module is first imported, and shared by the test file.
 */
import { JSDOM } from 'jsdom'
import type { ReactElement } from 'react'
import { act } from 'react'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const win = dom.window as unknown as Window & typeof globalThis

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
for (const name of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLButtonElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent',
  'getComputedStyle', 'MutationObserver', 'DocumentFragment', 'File', 'FileList', 'Blob', 'FormData',
] as const) {
  define(name, (win as unknown as Record<string, unknown>)[name])
}
define('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0))
define('cancelAnimationFrame', (id: number) => clearTimeout(id))
define('IS_REACT_ACT_ENVIRONMENT', true)
// jsdom has no layout: the forms call these to bring a problem into view.
win.Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this as Element) }
export const scrolled: Element[] = []

export type Mounted = ReturnType<typeof mount>

export function mount(element: ReactElement) {
  // Required lazily so that the DOM above exists before react-dom evaluates.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(element) })

  const api = {
    container,
    /** Everything on screen, portals included (the forms render into body). */
    text: () => win.document.body.textContent ?? '',
    all: <T extends Element = Element>(selector: string) => [...win.document.body.querySelectorAll<T>(selector)],
    one: <T extends Element = Element>(selector: string): T => {
      const found = win.document.body.querySelector<T>(selector)
      if (!found) throw new Error(`nothing matches ${selector}`)
      return found
    },
    button: (label: string | RegExp): HTMLButtonElement => {
      const found = [...win.document.body.querySelectorAll('button')].find(b => {
        const t = (b.textContent ?? '').trim()
        return typeof label === 'string' ? t === label : label.test(t)
      })
      if (!found) throw new Error(`no button "${String(label)}"; buttons: ${[...win.document.body.querySelectorAll('button')].map(b => (b.textContent ?? '').trim()).join(' | ')}`)
      return found as HTMLButtonElement
    },
    click: (el: Element) => { act(() => { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true })) }) },
    /** Set a controlled input's value the way typing does, so React sees it. */
    type: (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
      act(() => { setter.call(el, value); el.dispatchEvent(new win.Event('input', { bubbles: true })) })
    },
    press: (key: string) => { act(() => { win.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true })) }) },
    /** Let promises and effects settle (a form that loads something on open). */
    settle: async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) },
    unmount: () => { act(() => { root.unmount() }); container.remove(); scrolled.length = 0 },
  }
  return api
}

/**
 * The BOE One loader's lines — run in a simulated browser.
 *
 * The loader used to show the same eight sentences, in the same order, every
 * time; most waits end within two lines, so people only ever read the first
 * two. These tests run the real component and watch what a browser would do:
 * the fixed lines are what first renders (so the server and the browser agree),
 * then the library is fetched on demand and a fresh draw replaces them, a stored
 * headline can appear, and the hidden copy that a slow click reveals draws again
 * each time it is revealed.
 *
 * Run:
 *   npx tsx --test src/components/ui/BoeOneLoader.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness' // first: it installs the DOM react-dom needs
import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { BoeOneLoader, CHEER_LINES } from './BoeOneLoader'
import { HEADLINES_KEY } from '@/lib/dailySplash/splash'

type Ui = ReturnType<typeof mount>

const lineTexts = (ui: Ui) => ui.all('.boe-loader-line').map(p => (p.textContent ?? '').trim())

/** The library arrives through a dynamic import, so give it a few turns of the event loop. */
async function until(ui: Ui, ok: () => boolean) {
  for (let i = 0; i < 50 && !ok(); i++) await ui.settle()
}
const drawn = (ui: Ui) => () => ui.all('.boe-loader-kind').length === 8

async function setPending(ui: Ui, on: boolean) {
  await act(async () => {
    if (on) document.documentElement.setAttribute('data-boe-nav-pending', '')
    else document.documentElement.removeAttribute('data-boe-nav-pending')
    await new Promise(r => setTimeout(r, 0))
  })
  await ui.settle()
}

describe('BoeOneLoader lines', () => {
  const opened: Ui[] = []
  const open = (props: Record<string, unknown> = {}) => {
    const ui = mount(createElement(BoeOneLoader, props))
    opened.push(ui)
    return ui
  }
  afterEach(() => {
    while (opened.length) opened.pop()!.unmount()
    document.documentElement.removeAttribute('data-boe-nav-pending')
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  test('the fixed lines are what first renders, then a fresh draw of eight replaces them', async () => {
    const ui = open()
    assert.deepEqual(lineTexts(ui), [...CHEER_LINES])
    assert.equal(ui.all('.boe-loader-kind').length, 0, 'the fallback has no label')

    await until(ui, drawn(ui))
    const lines = lineTexts(ui)
    assert.equal(lines.length, 8)
    for (const line of lines) assert.ok(!CHEER_LINES.some(c => line.includes(c)), `still a fixed line: ${line}`)
    assert.equal(new Set(lines).size, 8)
    // Every drawn line says what it is: Fun fact, Jingle, Work hack...
    assert.equal(ui.all('.boe-loader-kind').length, 8)
  })

  test('each showing is different from the one before', async () => {
    const first = open()
    await until(first, drawn(first))
    const a = lineTexts(first)
    const second = open()
    await until(second, drawn(second))
    assert.notDeepEqual(lineTexts(second), a)
  })

  test('with cheer off there are no lines at all, and nothing is drawn', async () => {
    const ui = open({ cheer: false })
    await ui.settle()
    await ui.settle()
    assert.equal(ui.all('.boe-loader-line').length, 0)
  })

  test('a fresh headline stored in the browser can appear, with its publisher', async () => {
    Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true })
    window.localStorage.setItem(HEADLINES_KEY, JSON.stringify({
      at: Date.now(),
      items: [{ title: 'A thinner laptop arrives with a brighter screen', source: 'Gadgets 360' }],
    }))
    let seen = false
    for (let i = 0; i < 40 && !seen; i++) {
      const ui = open()
      await until(ui, drawn(ui))
      seen = lineTexts(ui).some(t => t.includes('A thinner laptop arrives with a brighter screen'))
      if (seen) {
        const kinds = ui.all('.boe-loader-kind').map(k => k.textContent)
        assert.ok(kinds.includes('In the news'))
        assert.ok(ui.all('.boe-loader-by').some(b => (b.textContent ?? '').includes('Gadgets 360')))
      }
      ui.unmount()
      opened.pop()
    }
    assert.ok(seen, 'a stored headline never appeared in 40 showings')
  })

  test('a broken stored headline is ignored and the loader still draws', async () => {
    Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true })
    window.localStorage.setItem(HEADLINES_KEY, '{broken')
    const ui = open()
    await until(ui, drawn(ui))
    assert.equal(lineTexts(ui).length, 8)
    assert.ok(!ui.all('.boe-loader-kind').some(k => k.textContent === 'In the news'))
  })

  test('the hidden copy that a slow click reveals loads nothing until a click waits, then draws each time', async () => {
    const ui = open({ className: 'boe-nav-loader' })
    await ui.settle()
    await ui.settle()
    assert.deepEqual(lineTexts(ui), [...CHEER_LINES], 'hidden and idle: still the fixed lines')

    await setPending(ui, true)
    await until(ui, drawn(ui))
    const firstWait = lineTexts(ui)
    assert.notDeepEqual(firstWait, [...CHEER_LINES])

    await setPending(ui, false)
    assert.deepEqual(lineTexts(ui), firstWait, 'nothing is redrawn when the wait ends')

    await setPending(ui, true)
    await until(ui, () => JSON.stringify(lineTexts(ui)) !== JSON.stringify(firstWait))
    assert.notDeepEqual(lineTexts(ui), firstWait, 'the next wait gets different lines')
  })

  test('a loader that is a screen of its own does not watch the page for slow clicks', async () => {
    const ui = open()
    await until(ui, drawn(ui))
    const before = lineTexts(ui)
    await setPending(ui, true)
    await ui.settle()
    assert.deepEqual(lineTexts(ui), before)
  })
})

// THE GUARD THAT LETS A MODULE'S PAGE START WHILE THE PERMISSION ANSWER IS ON ITS WAY (2026-11-19, page speed).
// These run the real components in a DOM: the hidden page is built, is invisible and cannot be reached, becomes the
// SAME shown page (not built again) when the answer is yes, and is removed when it is no.
// Run: npx tsx --test src/components/layout/moduleGuardStartsEarly.dom.test.tsx

import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { createElement, useEffect, type ReactElement } from 'react'
import { ModuleGuardStartsEarlyView, useBuildHidden } from './ModuleGuardStartsEarly'
import { useModuleShown } from '@/lib/moduleShown'

let pageMounts = 0

/** A page that reports whether it is on screen, and counts how many times it was BUILT. */
function Page() {
  const shown = useModuleShown()
  useEffect(() => { pageMounts += 1 }, [])
  return createElement('main', { 'data-page': 'tasks', 'data-shown': String(shown) }, 'PAGE')
}

type State = { ready: boolean; allowed: boolean; buildHidden: boolean }
const view = (s: State): ReactElement => <ModuleGuardStartsEarlyView {...s}><Page /></ModuleGuardStartsEarlyView>

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null; pageMounts = 0 })
function show(s: State) {
  const ui = mount(view(s))
  cleanup = () => ui.unmount()
  return ui
}

const COLD_START: State = { ready: false, allowed: false, buildHidden: true }
const wrapper = (ui: ReturnType<typeof mount>) => ui.container.querySelector<HTMLElement>('[data-module-page]')
const spinners = (ui: ReturnType<typeof mount>) => ui.container.querySelectorAll('[role="status"]').length

describe('the hidden build, while the answer is on its way', () => {
  test('the page is built, but hidden and unreachable, next to the spinner', () => {
    const ui = show(COLD_START)
    const w = wrapper(ui)!
    assert.equal(w.getAttribute('data-module-page'), 'waiting')
    assert.ok(w.hasAttribute('inert'), 'nothing in it can be focused or clicked')
    assert.equal(w.style.display, 'none', 'nothing of it is seen')
    assert.ok(w.querySelector('main[data-page="tasks"]'), 'the page is built, so its reads have started')
    assert.equal(spinners(ui), 1, 'the spinner is what the person sees')
    assert.equal(pageMounts, 1)
  })

  test('the page knows it is not on screen yet', () => {
    const ui = show(COLD_START)
    assert.equal(ui.one('main[data-page="tasks"]').getAttribute('data-shown'), 'false')
  })

  test('on the server and in the browser\'s first render nothing hidden is built, so the two match', () => {
    const ui = show({ ready: false, allowed: false, buildHidden: false })
    assert.equal(wrapper(ui) === null, true, 'no wrapper is built')
    assert.equal(ui.container.querySelectorAll('main').length, 0)
    assert.equal(spinners(ui), 1)
    assert.equal(pageMounts, 0)
  })
})

describe('the answer arrives', () => {
  test('yes: the SAME page is shown, not built again', () => {
    const ui = show(COLD_START)
    const before = wrapper(ui)!
    const mainBefore = ui.one('main[data-page="tasks"]')
    ui.render(view({ ready: true, allowed: true, buildHidden: false }))
    const after = wrapper(ui)!
    // Booleans, not the elements: a failed assertion on two jsdom nodes tries to print both whole object graphs.
    assert.ok(after === before, 'the wrapper element is kept')
    assert.ok(ui.one('main[data-page="tasks"]') === mainBefore, 'the page element is kept')
    assert.equal(after.getAttribute('data-module-page'), 'shown')
    assert.equal(after.hasAttribute('inert'), false)
    assert.equal(after.style.display, 'contents')
    assert.equal(mainBefore.getAttribute('data-shown'), 'true', 'the page is told it is on screen')
    assert.equal(spinners(ui), 0)
    assert.equal(pageMounts, 1, 'built exactly once')
  })

  test('no: the page is removed and the spinner stays, so the person never sees it', () => {
    const ui = show(COLD_START)
    assert.equal(pageMounts, 1)
    ui.render(view({ ready: true, allowed: false, buildHidden: false }))
    assert.equal(wrapper(ui) === null, true, 'no wrapper is left')
    assert.equal(ui.container.querySelectorAll('main').length, 0, 'the page is gone')
    assert.equal(spinners(ui), 1)
  })

  test('a person who may open the module and has a warm answer sees no hidden phase at all', () => {
    const ui = show({ ready: true, allowed: true, buildHidden: false })
    assert.equal(wrapper(ui)!.getAttribute('data-module-page'), 'shown')
    assert.equal(ui.one('main[data-page="tasks"]').getAttribute('data-shown'), 'true')
    assert.equal(spinners(ui), 0)
    assert.equal(pageMounts, 1)
  })

  test('a person who may NOT, with a warm answer, never gets the page built at all', () => {
    const ui = show({ ready: true, allowed: false, buildHidden: false })
    assert.equal(pageMounts, 0)
    assert.equal(ui.container.querySelectorAll('main').length, 0)
    assert.equal(spinners(ui), 1)
  })

  test('a person who may NOT, and whose answer arrives after the hidden build, is not recorded as having used the page', () => {
    // The page was built (its reads started) but it never became "shown": nothing that waits for it ever ran.
    const ui = show(COLD_START)
    assert.equal(ui.one('main[data-page="tasks"]').getAttribute('data-shown'), 'false')
    ui.render(view({ ready: true, allowed: false, buildHidden: false }))
    assert.equal(ui.container.querySelectorAll('main').length, 0)
  })
})

describe('a module that gives its own frame to show while the answer is on its way (Sales, 2026-11-23)', () => {
  const FRAME = createElement('div', { 'data-frame': 'checking' }, 'FRAME')
  const framed = (s: State): ReactElement => <ModuleGuardStartsEarlyView {...s} checking={FRAME}><Page /></ModuleGuardStartsEarlyView>
  const showFramed = (s: State) => {
    const ui = mount(framed(s))
    cleanup = () => ui.unmount()
    return ui
  }

  test('the frame is what is seen while the answer is pending, in place of the spinner, with the page built hidden behind it', () => {
    const ui = showFramed(COLD_START)
    assert.equal(ui.container.querySelectorAll('[data-frame="checking"]').length, 1)
    assert.equal(spinners(ui), 0, 'no spinner')
    assert.equal(wrapper(ui)!.style.display, 'none')
    assert.equal(pageMounts, 1, 'the page is built, so its reads have started')
  })

  test('yes: the frame goes and the same page is shown', () => {
    const ui = showFramed(COLD_START)
    const main = ui.one('main[data-page="tasks"]')
    ui.render(framed({ ready: true, allowed: true, buildHidden: false }))
    assert.equal(ui.container.querySelectorAll('[data-frame="checking"]').length, 0)
    assert.ok(ui.one('main[data-page="tasks"]') === main, 'not built again')
    assert.equal(pageMounts, 1)
  })

  test('no: neither the frame nor the page is left, only the spinner while the redirect lands', () => {
    const ui = showFramed(COLD_START)
    ui.render(framed({ ready: true, allowed: false, buildHidden: false }))
    assert.equal(ui.container.querySelectorAll('[data-frame="checking"]').length, 0)
    assert.equal(ui.container.querySelectorAll('main').length, 0)
    assert.equal(spinners(ui), 1)
  })

  test('with no frame given the spinner is shown, as for every other module', () => {
    const ui = show(COLD_START)
    assert.equal(spinners(ui), 1)
  })
})

describe('useModuleShown', () => {
  test('outside the guard a page is always "shown", so nothing else changes', () => {
    const ui = mount(createElement(Page))
    cleanup = () => ui.unmount()
    assert.equal(ui.one('main[data-page="tasks"]').getAttribute('data-shown'), 'true')
  })
})

describe('the hidden build applies to the first load only', () => {
  function Probe({ ready, inBrowser }: { ready: boolean; inBrowser: boolean }) {
    return createElement('i', { 'data-build-hidden': String(useBuildHidden(ready, inBrowser)) })
  }
  const probe = (ready: boolean, inBrowser: boolean) => createElement(Probe, { ready, inBrowser })
  const flag = (ui: ReturnType<typeof mount>) => ui.one('i').getAttribute('data-build-hidden')

  test('hidden while the first answer is pending in the browser; never on the server', () => {
    const ui = mount(probe(false, true))
    cleanup = () => ui.unmount()
    assert.equal(flag(ui), 'true')
    ui.render(probe(false, false))
    assert.equal(flag(ui), 'false', 'the server and the first browser render build nothing hidden')
  })

  test('once the context has answered, going back to "checking" (View As switching person) builds nothing hidden', () => {
    const ui = mount(probe(false, true))
    cleanup = () => ui.unmount()
    assert.equal(flag(ui), 'true')
    ui.render(probe(true, true))
    assert.equal(flag(ui), 'false')
    ui.render(probe(false, true))
    assert.equal(flag(ui), 'false', 'the old guard\'s rule: unmount and show the spinner until the new answer')
  })
})

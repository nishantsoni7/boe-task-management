/**
 * Form-modal dismissal + focus-trap policy — behavioural tests.
 *
 * The BOE Form Modal Dismissal Rule, asserted directly. There is no DOM test
 * runner in this repo (no jsdom, no testing-library), and the task explicitly
 * rules out adding one for this fix — so the policy lives in pure functions
 * that CAN be tested, and the components are reduced to calling them. What
 * remains DOM-dependent (does the overlay actually swallow a sidebar click,
 * does focus really land on the Create Asset button) is listed as a manual
 * check in the task report.
 *
 * Run:
 *   npx tsx --test src/lib/ui/modalDismissal.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shouldCloseFormModal, resolveTrapTarget, FOCUSABLE_SELECTOR } from './modalDismissal'

describe('shouldCloseFormModal', () => {
  test('a backdrop click does NOT close the modal', () => {
    assert.equal(shouldCloseFormModal('backdrop'), false)
  })

  test('Escape closes', () => {
    assert.equal(shouldCloseFormModal('escape'), true)
  })

  test('the close icon closes', () => {
    assert.equal(shouldCloseFormModal('close-icon'), true)
  })

  test('Cancel closes', () => {
    assert.equal(shouldCloseFormModal('cancel'), true)
  })

  test('a successful submission closes', () => {
    assert.equal(shouldCloseFormModal('submit-success'), true)
  })

  test('a failed submission keeps the modal open', () => {
    assert.equal(shouldCloseFormModal('submit-error'), false)
  })

  test('backdrop is the only pointer-driven reason, and it is refused', () => {
    // Guards against someone later adding 'pointer-down-outside' or
    // 'interact-outside' as a closing reason.
    const closing = (['backdrop', 'escape', 'close-icon', 'cancel', 'submit-success', 'submit-error'] as const)
      .filter(shouldCloseFormModal)
    assert.deepEqual(closing, ['escape', 'close-icon', 'cancel', 'submit-success'])
  })
})

describe('resolveTrapTarget', () => {
  test('Tab on the last control wraps to the first, not out to the sidebar', () => {
    assert.equal(resolveTrapTarget({ count: 4, activeIndex: 3, shiftKey: false }), 'first')
  })

  test('Shift+Tab on the first control wraps to the last', () => {
    assert.equal(resolveTrapTarget({ count: 4, activeIndex: 0, shiftKey: true }), 'last')
  })

  test('an ordinary move inside the dialog is left to the browser', () => {
    assert.equal(resolveTrapTarget({ count: 4, activeIndex: 1, shiftKey: false }), null)
    assert.equal(resolveTrapTarget({ count: 4, activeIndex: 2, shiftKey: true }), null)
  })

  test('focus that has escaped the dialog is pulled back to the first control', () => {
    // activeIndex -1 = focus is somewhere outside — the sidebar, say.
    assert.equal(resolveTrapTarget({ count: 4, activeIndex: -1, shiftKey: false }), 'first')
    assert.equal(resolveTrapTarget({ count: 4, activeIndex: -1, shiftKey: true }), 'first')
  })

  test('a dialog with nothing focusable swallows Tab rather than releasing focus', () => {
    assert.equal(resolveTrapTarget({ count: 0, activeIndex: -1, shiftKey: false }), 'block')
  })

  test('a single focusable control keeps focus on itself in both directions', () => {
    assert.equal(resolveTrapTarget({ count: 1, activeIndex: 0, shiftKey: false }), 'first')
    assert.equal(resolveTrapTarget({ count: 1, activeIndex: 0, shiftKey: true }), 'last')
  })
})

describe('FOCUSABLE_SELECTOR', () => {
  test('excludes disabled controls, which cannot hold focus', () => {
    assert.match(FOCUSABLE_SELECTOR, /button:not\(\[disabled\]\)/)
    assert.match(FOCUSABLE_SELECTOR, /input:not\(\[disabled\]\)/)
  })

  test('excludes tabindex="-1", so the dialog container is not itself a stop', () => {
    assert.match(FOCUSABLE_SELECTOR, /\[tabindex\]:not\(\[tabindex="-1"\]\)/)
  })

  test('covers the control types these forms actually use', () => {
    for (const tag of ['input', 'select', 'textarea', 'button']) {
      assert.ok(FOCUSABLE_SELECTOR.includes(tag), `${tag} must be focusable`)
    }
  })
})

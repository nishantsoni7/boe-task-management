// Ask before an in-app link leaves a page with unsaved edits (quotation builder, 18 Nov 2026).
import '@/lib/testing/domHarness'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { UNSAVED_LEAVE_PROMPT, askBeforeLeaving } from './leaveGuard'

/** Click a fresh link with the guard listening on the document, the way the builder installs it. */
function click(attrs: Record<string, string>, { dirty = true, answer = false, init = {} as MouseEventInit } = {}) {
  const asked: string[] = []
  const a = document.createElement('a')
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v)
  const inner = document.createElement('span')
  a.appendChild(inner)
  document.body.appendChild(a)
  const guard = askBeforeLeaving(() => dirty, t => { asked.push(t); return answer })
  let stopped = true
  // A click that reaches the link's own handlers was let through; then keep jsdom from following it (it cannot navigate).
  const after = (ev: MouseEvent) => { stopped = ev.defaultPrevented; ev.preventDefault() }
  document.addEventListener('click', guard, true)
  document.addEventListener('click', after)
  inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
  document.removeEventListener('click', guard, true)
  document.removeEventListener('click', after)
  a.remove()
  return { asked, stopped }
}

describe('askBeforeLeaving', () => {
  test('with unsaved edits, a link to another page asks; Cancel stops the click', () => {
    const r = click({ href: '/orders' })
    assert.deepEqual(r.asked, [UNSAVED_LEAVE_PROMPT])
    assert.equal(r.stopped, true)
  })
  test('OK lets the click through', () => {
    const r = click({ href: '/orders' }, { answer: true })
    assert.equal(r.asked.length, 1)
    assert.equal(r.stopped, false)
  })
  test('nothing is asked when everything is saved', () => {
    assert.deepEqual(click({ href: '/orders' }, { dirty: false }), { asked: [], stopped: false })
  })
  test('nothing is asked for a link that stays on this page, opens a new tab, downloads, or a Ctrl-click', () => {
    assert.equal(click({ href: '/?tab=2' }).asked.length, 0)
    assert.equal(click({ href: '#top' }).asked.length, 0)
    assert.equal(click({ href: '/orders', target: '_blank' }).asked.length, 0)
    assert.equal(click({ href: '/file.xlsx', download: '' }).asked.length, 0)
    assert.equal(click({ href: '/orders' }, { init: { ctrlKey: true } }).asked.length, 0)
  })
  test('next/link does not navigate a click whose default was prevented', () => {
    const link = readFileSync('node_modules/next/dist/client/app-dir/link.js', 'utf8')
    assert.match(link, /if \(e\.defaultPrevented\)/)
  })
  test('the quotation builder installs it on the document, in the capture phase', () => {
    const screen = readFileSync('src/components/quotations/BuilderScreen.tsx', 'utf8')
    assert.match(screen, /document\.addEventListener\('click', onLink, true\)/)
    assert.match(screen, /document\.removeEventListener\('click', onLink, true\)/)
  })
})

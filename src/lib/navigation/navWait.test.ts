import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { beginNavWait, leavesThisPage, NAV_PENDING_ATTRIBUTE } from './navWait'

// The rules behind "a slow click shows the BOE One loader" (AppLink):
// which clicks count, and the mark on <html> that CSS turns into the loader.

const HERE = 'https://boeone.vercel.app/orders/all?tab=open'

describe('which clicks count: only the ones that go to a different page', () => {
  test('another page counts', () => {
    assert.equal(leavesThisPage('/finance', HERE), true)
    assert.equal(leavesThisPage('/orders/123', HERE), true)
    assert.equal(leavesThisPage('/orders/all/', HERE), true) // different path text
  })

  test('the same page with a different query or hash does not', () => {
    assert.equal(leavesThisPage('/orders/all?tab=closed', HERE), false)
    assert.equal(leavesThisPage('?tab=closed', HERE), false)
    assert.equal(leavesThisPage('#top', HERE), false)
    assert.equal(leavesThisPage('/orders/all', HERE), false)
  })

  test('an empty target (what AppLink passes for a URL object with no pathname) does not', () => {
    assert.equal(leavesThisPage('', HERE), false)
  })

  test('an address that cannot be read shows the loader rather than stay silent', () => {
    assert.equal(leavesThisPage('/finance', 'not a url'), true)
  })
})

describe('the mark on <html>: set while any clicked link waits, cleared when none is left', () => {
  function html() {
    return new JSDOM('<!doctype html><html><body></body></html>').window.document.documentElement
  }
  const marked = (root: Element) => root.hasAttribute(NAV_PENDING_ATTRIBUTE)

  test('one wait: marked, then cleared when it ends', () => {
    const root = html()
    const end = beginNavWait(root)
    assert.equal(marked(root), true)
    end()
    assert.equal(marked(root), false)
  })

  test('two waits at once: the first to end must not hide the loader the second still needs', () => {
    const root = html()
    const endFirst = beginNavWait(root)
    const endSecond = beginNavWait(root)
    endFirst()
    assert.equal(marked(root), true, 'the second click is still waiting')
    endSecond()
    assert.equal(marked(root), false)
  })

  test('ending the same wait twice counts once (React may run a cleanup again)', () => {
    const root = html()
    const endFirst = beginNavWait(root)
    const endSecond = beginNavWait(root)
    endFirst()
    endFirst()
    assert.equal(marked(root), true, 'the second wait must survive a repeated cleanup of the first')
    endSecond()
    assert.equal(marked(root), false)
  })

  test('the attribute name is the one the stylesheet reveals the loader on', () => {
    assert.equal(NAV_PENDING_ATTRIBUTE, 'data-boe-nav-pending')
  })
})

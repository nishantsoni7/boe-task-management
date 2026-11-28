/**
 * A move to another page that is made by code (router.push, the Back button, the browser's own Back) shows the
 * BOE One loader when it is slow, exactly like a clicked link — run in a simulated browser.
 *
 * Next's useRouter() reads AppRouterContext, so the app's 195 callers are covered by one provider. These tests
 * mount that provider over a recording stand-in for Next's router and read what a person's screen would carry:
 * the mark on <html> that globals.css turns into the full-screen loader.
 *
 * Run:
 *   npx tsx --test src/components/layout/NavWaitRouter.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness' // first: it installs the DOM react-dom needs
import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { useRouter } from 'next/navigation'
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { NavWaitRouter, NAV_WAIT_GIVE_UP_MS } from './NavWaitRouter'
import { NAV_PENDING_ATTRIBUTE } from '@/lib/navigation/navWait'

type Ui = ReturnType<typeof mount>

const marked = () => document.documentElement.hasAttribute(NAV_PENDING_ATTRIBUTE)

describe('every move made by code shows the loader while it waits', () => {
  const calls: string[] = []
  const real = {
    push: (href: string) => { calls.push(`push ${href}`) },
    replace: (href: string) => { calls.push(`replace ${href}`) },
    back: () => { calls.push('back') },
    forward: () => { calls.push('forward') },
    refresh: () => { calls.push('refresh') },
    prefetch: () => { calls.push('prefetch') },
  } as unknown as AppRouterInstance

  let seen: AppRouterInstance
  function Probe() { seen = useRouter(); return null }
  const tree = (path: string) => createElement(AppRouterContext.Provider, { value: real },
    createElement(PathnameContext.Provider, { value: path },
      createElement(NavWaitRouter, null, createElement(Probe))))

  let ui: Ui | null = null
  const open = (path = '/') => { ui = mount(tree(path)); return ui }
  const arrive = (path: string) => { ui!.render(tree(path)) }

  afterEach(() => {
    ui?.unmount(); ui = null
    calls.length = 0
    document.documentElement.removeAttribute(NAV_PENDING_ATTRIBUTE)
    window.history.replaceState({}, '', '/')
  })

  test('push to another page marks <html> and still reaches the real router', () => {
    open('/')
    act(() => { seen.push('/finance') })
    assert.equal(marked(), true)
    assert.deepEqual(calls, ['push /finance'])
  })

  test('replace to another page marks <html> too', () => {
    open('/')
    act(() => { seen.replace('/login') })
    assert.equal(marked(), true)
    assert.deepEqual(calls, ['replace /login'])
  })

  test('a filter or tab on the same page does not: that page keeps its own loading state', () => {
    open('/')
    act(() => { seen.push('/?tab=closed') })
    assert.equal(marked(), false)
    assert.deepEqual(calls, ['push /?tab=closed'], 'the move itself still happens')
  })

  test('the mark comes off when the new page arrives', () => {
    open('/')
    act(() => { seen.push('/finance') })
    assert.equal(marked(), true)
    arrive('/finance')
    assert.equal(marked(), false)
  })

  test('two moves waiting at once end together when a page arrives', () => {
    open('/')
    act(() => { seen.push('/finance'); seen.push('/orders') })
    assert.equal(marked(), true)
    arrive('/orders')
    assert.equal(marked(), false)
  })

  test('a move that never arrives is given up, so the loader cannot stay on for ever', () => {
    open('/')
    const real = window.setTimeout
    let giveUp: (() => void) | null = null
    let ms = 0
    window.setTimeout = ((fn: () => void, delay: number) => { giveUp = fn; ms = delay; return 1 }) as unknown as typeof window.setTimeout
    try { act(() => { seen.push('/finance') }) } finally { window.setTimeout = real }
    assert.equal(ms, NAV_WAIT_GIVE_UP_MS)
    assert.equal(marked(), true)
    act(() => { giveUp!() })
    assert.equal(marked(), false)
  })

  test("the browser's own Back or Forward to another page is covered (popstate), and one that stays is not", () => {
    open('/')
    window.history.replaceState({}, '', '/orders') // the address has changed, the page has not yet
    act(() => { window.dispatchEvent(new window.Event('popstate')) })
    assert.equal(marked(), true)
    arrive('/orders')
    assert.equal(marked(), false)

    window.history.replaceState({}, '', '/orders?tab=2') // same page, new query
    act(() => { window.dispatchEvent(new window.Event('popstate')) })
    assert.equal(marked(), false)
  })

  test('the other router methods pass straight through', () => {
    open('/')
    act(() => { seen.back(); seen.forward(); seen.refresh(); seen.prefetch('/x') })
    assert.deepEqual(calls, ['back', 'forward', 'refresh', 'prefetch'])
    assert.equal(marked(), false)
  })

  test('the router handed to the app is the same object on every render, so effects that depend on it do not re-run', () => {
    open('/')
    const first = seen
    arrive('/')
    arrive('/finance')
    assert.equal(seen, first)
  })
})

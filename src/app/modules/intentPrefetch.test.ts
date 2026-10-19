import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// GUARD: other modules' routes are warmed on INTENT (pointer over, focus, touch
// start), never in an effect on load.
//
// Warming a route fetches its page, and the page brings its stylesheet. On the
// Modules page and the Dashboard that meant preloading the CSS of Control
// Center, Inventory and Exhibition Leads — files the current page never applies
// — so Chrome logged "preloaded using link preload but not used within a few
// seconds", repeatedly, and the burst of requests competed with the page's own
// data. Same-module warm-ups (Dashboard → My Tasks / Notifications) bring no
// foreign CSS and are not covered here.

const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8')

const MODULES = read('src', 'app', 'modules', 'page.tsx')
const QUICK = read('src', 'components', 'layout', 'QuickActions.tsx')

// Every router.prefetch( call must be the body of the intent helper itself
// (`const warm... = (...) => { router.prefetch(...) }`) — never inside an effect.
function prefetchInsideEffect(source: string): boolean {
  return source
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .some(line => line.includes('router.prefetch(') && !/const warm(Module)? = /.test(line))
}

describe('cross-module prefetch happens on intent only', () => {
  it('the Modules page does not warm every module in an effect', () => {
    assert.equal(prefetchInsideEffect(MODULES), false)
    assert.ok(MODULES.includes('onIntent'), 'ModuleCard receives an intent handler')
    assert.ok(MODULES.includes('onPointerEnter={onIntent}'))
    assert.ok(MODULES.includes('onFocus={onIntent}'))
    assert.ok(MODULES.includes('onTouchStart={onIntent}'))
  })

  it('edit mode (rearranging) warms nothing', () => {
    assert.ok(MODULES.includes('onIntent={editingOrder ? undefined :'))
  })

  it('Quick Actions do not warm their destinations in an effect', () => {
    assert.equal(prefetchInsideEffect(QUICK), false)
    assert.ok(QUICK.includes('onPointerEnter={() => warm(action.href)}'))
    assert.ok(QUICK.includes('onFocus={() => warm(action.href)}'))
    assert.ok(QUICK.includes('onTouchStart={() => warm(action.href)}'))
  })
})

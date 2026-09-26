import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOADING_SELECTOR, LOADING_TEXT, LONG_NAVIGATION_MS, documentReport, errorReport, navigationReport, parseRouteHealthReport,
  routeTemplate, scriptFile, scrubMessage,
} from './routeHealth'

const NET = { effectiveType: '4g', rttMs: 150 }
const DPL = 'dpl_ERfEboEmxgUnGKNWDptiWFvwa4xk'

describe('routeTemplate keeps the shape of a route and nothing that identifies a record', () => {
  test('ids, numbers, codes and tokens become :id; query and hash are dropped', () => {
    assert.equal(routeTemplate('/orders/5ca406a4-4d9f-4a71-acd9-923d3d13c208?returnTo=%2Forders#x'), '/orders/:id')
    assert.equal(routeTemplate('/orders/drafts/11fd3102-6d5f-4151-aef9-6ffd1f17d104'), '/orders/drafts/:id')
    assert.equal(routeTemplate('/payroll/results/2026/a5a5a5a5-0000-4000-8000-000000000001'), '/payroll/results/:id/:id')
    assert.equal(routeTemplate('/showroom/share/Zk3v9QpLmX2aBcD4eF6gH8jK'), '/showroom/share/:id')
    assert.equal(routeTemplate('/showroom/product/526-BE001'), '/showroom/product/:id')
    assert.equal(routeTemplate('/x/someone@example.com'), '/x/:id')
  })
  test('ordinary routes are unchanged', () => {
    for (const r of ['/', '/modules', '/finance/expenses', '/admin/control-center/people', '/tasks/create'])
      assert.equal(routeTemplate(r), r)
  })
})

describe('scrubMessage removes identifying content from an error message', () => {
  test('uuids, emails, urls, tokens and long numbers', () => {
    const s = scrubMessage('Order 5ca406a4-4d9f-4a71-acd9-923d3d13c208 for riya@boe.test failed at https://x.supabase.co/rest/v1/orders?id=eq.1 amount 1678550 token eyJhbGciOi.eyJzdWIiOi.sig')
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(s), false)
    assert.equal(s.includes('@'), false)
    assert.equal(s.includes('supabase'), false)
    assert.equal(s.includes('1678550'), false)
    assert.equal(s.includes('eyJ'), false)
    assert.ok(s.startsWith('Order :id for :email failed at :url'))
  })
  test('a production crash message survives in a useful form', () => {
    assert.equal(scrubMessage('e.amount.trim is not a function'), 'e.amount.trim is not a function')
  })
  test('length is capped', () => {
    assert.equal(scrubMessage('x '.repeat(400)).length <= 200, true)
  })
})

describe('scriptFile keeps only the chunk file name', () => {
  test('url, query and line/column are dropped', () => {
    assert.equal(scriptFile('https://boe-task-management.vercel.app/_next/static/chunks/0cgnk1q34yg_u.js?dpl=dpl_Gao3:1:2635'), '0cgnk1q34yg_u.js')
    assert.equal(scriptFile(''), null)
    assert.equal(scriptFile(undefined), null)
  })
})

describe('only waits that matter are reported', () => {
  const base = { fromPath: '/finance', toPath: '/finance/expenses', startedAt: 1000, visibleAtStart: true, visibleAtEnd: true, hardLoad: false, network: NET, deployment: DPL }
  test('a normal navigation is not reported', () => {
    assert.equal(navigationReport({ ...base, endedAt: 1400, contentAt: 1000 + LONG_NAVIGATION_MS - 1 }), null)
  })
  test('a fast route with slow CONTENT is reported — that is the wait users feel', () => {
    const r = navigationReport({ ...base, endedAt: 1300, contentAt: 1000 + 25000 })
    assert.equal(r?.durationMs, 300)
    assert.equal(r?.contentMs, 25000)
    assert.equal(r?.stalled, false)
  })
  test('a long one is, with templates and visibility', () => {
    const r = navigationReport({ ...base, toPath: '/orders/5ca406a4-4d9f-4a71-acd9-923d3d13c208', endedAt: 1000 + 9000, contentAt: 1000 + 9500, visibleAtEnd: false })
    assert.deepEqual(r, { kind: 'navigation', from: '/finance', to: '/orders/:id', durationMs: 9000, contentMs: 9500, stalled: false,
      visibleAtStart: true, visibleAtEnd: false, hardLoad: false, network: NET, deployment: DPL })
  })
  test('a navigation that never arrived, or whose content never settled, is reported as stalled', () => {
    const r = navigationReport({ ...base, endedAt: null, contentAt: null })
    assert.equal(r?.stalled, true)
    assert.equal(r?.durationMs, null)
    assert.equal(navigationReport({ ...base, endedAt: 1200, contentAt: null })?.stalled, true)
  })
  test('a slow first open is reported (the daily quote counts as waiting); a fast one is not', () => {
    assert.equal(documentReport({ path: '/modules', firstRouteMs: 1200, contentMs: 1500, responseEndMs: 200, visible: true, network: NET, deployment: DPL }), null)
    assert.equal(documentReport({ path: '/modules', firstRouteMs: 1200, contentMs: 6300, responseEndMs: 200, visible: true, network: NET, deployment: DPL })?.contentMs, 6300)
    assert.equal(documentReport({ path: '/modules', firstRouteMs: 7400, contentMs: 7600, responseEndMs: 210, visible: true, network: NET, deployment: DPL })?.firstRouteMs, 7400)
  })
  test('the daily quote and the shared loader count as still loading', () => {
    assert.ok(LOADING_SELECTOR.includes('[aria-label="Daily quote"]'))
    assert.ok(LOADING_SELECTOR.includes('.boe-loading'))
    assert.ok(LOADING_SELECTOR.includes('[aria-busy="true"]'))
    assert.ok(LOADING_TEXT.test('Loading…') && LOADING_TEXT.test('Loading...') && !LOADING_TEXT.test('Loading orders for Riya'))
  })
  test('an error report is scrubbed', () => {
    const r = errorReport({ path: '/finance/expenses', message: 'e.amount.trim is not a function', source: 'https://h/_next/static/chunks/abc.js?dpl=1:1:2', visible: true, deployment: DPL })
    assert.deepEqual(r, { kind: 'error', route: '/finance/expenses', message: 'e.amount.trim is not a function', file: 'abc.js', visible: true, deployment: DPL })
  })
})

describe('parseRouteHealthReport — the server whitelist', () => {
  test('extra keys are dropped and values re-cleaned', () => {
    const r = parseRouteHealthReport({ kind: 'navigation', from: '/orders/5ca406a4-4d9f-4a71-acd9-923d3d13c208', to: '/modules', durationMs: 9000.4,
      stalled: false, visibleAtStart: true, visibleAtEnd: true, hardLoad: false, network: { effectiveType: '4g', rttMs: 150, extra: 1 }, deployment: DPL,
      userId: 'a5a5a5a5-0000-4000-8000-000000000001', email: 'x@y.z' }) as Record<string, unknown>
    assert.equal(r.from, '/orders/:id')
    assert.equal(r.durationMs, 9000)
    assert.equal('userId' in r, false)
    assert.equal('email' in r, false)
    assert.deepEqual(r.network, { effectiveType: '4g', rttMs: 150 })
  })
  test('an unscrubbed message sent by hand is scrubbed again', () => {
    const r = parseRouteHealthReport({ kind: 'error', route: '/x', message: 'user riya@boe.test id 5ca406a4-4d9f-4a71-acd9-923d3d13c208', file: 'a.js', visible: true, deployment: null }) as { message: string }
    assert.equal(r.message, 'user :email id :id')
  })
  test('unknown kinds, junk and bad deployment ids are refused or nulled', () => {
    assert.equal(parseRouteHealthReport({ kind: 'anything' }), null)
    assert.equal(parseRouteHealthReport('text'), null)
    assert.equal(parseRouteHealthReport([1]), null)
    assert.equal(parseRouteHealthReport({ kind: 'document', route: '/', firstRouteMs: 'slow' }), null)
    const r = parseRouteHealthReport({ kind: 'error', route: '/', message: 'm', file: null, visible: false, deployment: 'not-a-deployment' }) as { deployment: unknown }
    assert.equal(r.deployment, null)
  })
})

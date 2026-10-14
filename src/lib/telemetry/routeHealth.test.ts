import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOADING_SELECTOR, LOADING_TEXT, LOCAL_EVIDENCE_DAYS, LOCAL_EVIDENCE_MAX, LONG_NAVIGATION_MS, appendLocalEvidence, documentReport,
  errorReport, lineBudget, navigationReport, parseRouteHealthReport, readLocalEvidence, routeTemplate, safeErrorMessage, scriptFile,
  scrubMessage, templateFromParams,
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
    assert.equal(r.message, 'Error: (message withheld)', 'an app-written message is withheld even after scrubbing')
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

describe('templateFromParams names a route by its own parameters', () => {
  test('a dynamic segment is replaced exactly, whatever it looks like', () => {
    assert.equal(templateFromParams('/showroom/product/ZZ-TIMING-PROBE', { product_code: 'ZZ-TIMING-PROBE' }), '/showroom/product/:product_code')
    assert.equal(templateFromParams('/showroom-admin/products/Riya%20Sofa/edit', { product_code: 'Riya Sofa' }), '/showroom-admin/products/:product_code/edit')
    assert.equal(templateFromParams('/payroll/results/p1/e2', { periodId: 'p1', employeeId: 'e2' }), '/payroll/results/:periodId/:employeeId')
    assert.equal(templateFromParams('/orders/drafts/abc?x=1', { submissionId: 'abc' }), '/orders/drafts/:submissionId')
  })
  test('without params the heuristics still apply; static routes are unchanged', () => {
    assert.equal(templateFromParams('/orders/5ca406a4-4d9f-4a71-acd9-923d3d13c208', {}), '/orders/:id')
    assert.equal(templateFromParams('/finance/expenses', null), '/finance/expenses')
  })
  test('a hostile param key cannot inject text', () => {
    assert.equal(templateFromParams('/x/v', { 'a b<script>': 'v' }), '/x/v')
  })
})

describe('safeErrorMessage keeps only messages written by the browser, React, Next or the database', () => {
  test('known engine and framework messages survive', () => {
    for (const m of [
      'e.amount.trim is not a function',
      "Cannot read properties of undefined (reading 'map')",
      "Cannot access 'x' before initialization",
      'Failed to fetch', 'Load failed', 'signal is aborted without reason',
      'Loading chunk 123 failed.', 'ChunkLoadError',
      'new row violates row-level security policy for table "orders"',
      'permission denied for table order_submissions', 'JWT expired',
    ]) assert.equal(safeErrorMessage(m), m, m)
  })
  test('a React production error keeps its number, not its arguments', () => {
    const s = safeErrorMessage('Minified React error #418; visit https://react.dev/errors/418?args[]=Riya for the full message or use the non-minified dev environment for full errors and additional helpful warnings.')
    assert.ok(s.startsWith('Minified React error #418; visit :url'), s)
    assert.equal(s.includes('Riya'), false)
  })
  test('a JSON failure is normalised — it would otherwise quote the response', () => {
    assert.equal(safeErrorMessage(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`), 'Unexpected token (response was not JSON)')
  })
  test('anything else — an app-thrown message could name a customer or an amount — is withheld', () => {
    assert.equal(safeErrorMessage('Customer Riya Traders has no GST number', 'Error'), 'Error: (message withheld)')
    assert.equal(safeErrorMessage('Payment 45,000 for PI 7 failed', 'PostgrestError'), 'PostgrestError: (message withheld)')
    assert.equal(safeErrorMessage('x', '<img>'), 'Error: (message withheld)')
    assert.equal(safeErrorMessage(undefined), 'Error: (message withheld)')
  })
})

describe('the device keeps its own copy (the server log lasts an hour on Hobby)', () => {
  const r = errorReport({ path: '/finance', message: 'Failed to fetch', source: null, visible: true, deployment: DPL })
  const now = new Date('2026-09-26T10:00:00Z')
  test('newest last, capped', () => {
    let list: unknown = []
    for (let i = 0; i < LOCAL_EVIDENCE_MAX + 5; i++) list = appendLocalEvidence(list, r, new Date(now.getTime() + i * 1000))
    const kept = readLocalEvidence(list)
    assert.equal(kept.length, LOCAL_EVIDENCE_MAX)
    assert.equal(kept[kept.length - 1].at, new Date(now.getTime() + (LOCAL_EVIDENCE_MAX + 4) * 1000).toISOString())
  })
  test('old entries are dropped', () => {
    const old = [{ at: new Date(now.getTime() - (LOCAL_EVIDENCE_DAYS + 1) * 86_400_000).toISOString(), report: r }]
    assert.equal(appendLocalEvidence(old, r, now).length, 1)
  })
  test('whatever is read back goes through the whitelist again', () => {
    const tampered = [{ at: now.toISOString(), report: { ...r, message: 'Customer Riya owes 45,000', email: 'x@y.z' } }, { at: 'x', report: r }, 'junk']
    const kept = readLocalEvidence(tampered)
    assert.equal(kept.length, 1)
    assert.equal((kept[0].report as { message: string }).message, 'Error: (message withheld)')
    assert.equal('email' in kept[0].report, false)
    assert.deepEqual(readLocalEvidence('not a list'), [])
  })
})

describe('lineBudget caps log lines per minute and reports what it dropped', () => {
  test('the excess is refused, then summarised once', () => {
    const summaries: string[] = []
    const take = lineBudget(3, line => summaries.push(line))
    assert.deepEqual([0, 1, 2, 3, 4].map(at => take(at)), [true, true, true, false, false])
    assert.equal(take(60_000), true)
    assert.deepEqual(summaries, ['{"kind":"dropped","count":2}'])
    assert.equal(take(120_000), true)
    assert.equal(summaries.length, 1, 'no summary when nothing was dropped')
  })
})

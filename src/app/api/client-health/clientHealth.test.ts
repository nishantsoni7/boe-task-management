// POST /api/client-health: accepts only whitelisted, scrubbed reports, logs one
// line, stores nothing. Runs the real handler; no database, no network.
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { POST } from './route'
import { SERVER_MAX_LINES_PER_MINUTE } from '@/lib/telemetry/routeHealth'

let lines: string[] = []
const realLog = console.log
before(() => { console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) } })
after(() => { console.log = realLog })

const post = (body: string, headers: Record<string, string> = {}) =>
  POST(new NextRequest('http://localhost/api/client-health', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }))

describe('POST /api/client-health', () => {
  test('a valid report is logged once, scrubbed, with a coarse device class', async () => {
    lines = []
    const res = await post(JSON.stringify({ kind: 'navigation', from: '/orders/5ca406a4-4d9f-4a71-acd9-923d3d13c208', to: '/modules', durationMs: 9100,
      stalled: false, visibleAtStart: true, visibleAtEnd: true, hardLoad: false, network: { effectiveType: '4g', rttMs: 120 }, deployment: 'dpl_ERfEboEmxgUnGKNWDptiWFvwa4xk', userId: 'someone' }),
      { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari' })
    assert.equal(res.status, 204)
    assert.equal(lines.length, 1)
    assert.ok(lines[0].startsWith('[client-health] '))
    const logged = JSON.parse(lines[0].slice('[client-health] '.length))
    assert.equal(logged.from, '/orders/:id')
    assert.equal(logged.device, 'mobile')
    assert.equal('userId' in logged, false)
  })
  test('junk, oversize and unknown shapes are dropped silently with 204', async () => {
    lines = []
    assert.equal((await post('not json')).status, 204)
    assert.equal((await post(JSON.stringify({ kind: 'nope' }))).status, 204)
    assert.equal((await post('x'.repeat(5000))).status, 204)
    assert.equal((await post('{}', { 'content-length': '999999' })).status, 204)
    assert.equal(lines.length, 0)
  })
  test('a report posted from another site is refused', async () => {
    lines = []
    const ok = JSON.stringify({ kind: 'error', route: '/x', message: 'Failed to fetch', file: null, visible: true, deployment: null })
    assert.equal((await post(ok, { 'sec-fetch-site': 'cross-site' })).status, 204)
    assert.equal((await post(ok, { origin: 'https://evil.example', host: 'localhost' })).status, 204)
    assert.equal(lines.length, 0)
    await post(ok, { 'sec-fetch-site': 'same-origin', origin: 'http://localhost', host: 'localhost' })
    assert.equal(lines.length, 1, 'the app itself is still heard')
  })
  test('it reads no cookie, no session and no database', () => {
    const src = readFileSync(join(__dirname, 'route.ts'), 'utf8')
    assert.equal(/cookies\(|getUser|getSession|createClient|supabase/i.test(src.replace(/\/\/.*$/gm, '')), false)
  })
})

describe('a flood costs at most SERVER_MAX_LINES_PER_MINUTE lines (runs last: it spends the budget)', () => {
  test('beyond the budget nothing more is logged this minute', async () => {
    lines = []
    const ok = JSON.stringify({ kind: 'error', route: '/x', message: 'Failed to fetch', file: null, visible: true, deployment: null })
    for (let i = 0; i < SERVER_MAX_LINES_PER_MINUTE + 15; i++) assert.equal((await post(ok)).status, 204)
    assert.ok(lines.length <= SERVER_MAX_LINES_PER_MINUTE, `logged ${lines.length}`)
    assert.ok(lines.length >= SERVER_MAX_LINES_PER_MINUTE - 5, 'earlier tests used only a few lines')
  })
})

describe('the reporter is mounted once, for every route', () => {
  test('Providers renders RouteHealthReporter', () => {
    const providers = readFileSync(join(__dirname, '../../../components/layout/Providers.tsx'), 'utf8')
    assert.equal((providers.match(/<RouteHealthReporter \/>/g) ?? []).length, 1)
  })
  test('the reporter sends only through the whitelist builders and sendBeacon', () => {
    const src = readFileSync(join(__dirname, '../../../components/layout/RouteHealthReporter.tsx'), 'utf8')
    assert.ok(src.includes('navigator.sendBeacon'))
    assert.equal(/localStorage|document\.cookie|getSession|userId|email/.test(src), false)
  })
  test('routes are named from the route params, never from the raw location', () => {
    const src = readFileSync(join(__dirname, '../../../components/layout/RouteHealthReporter.tsx'), 'utf8')
    assert.ok(src.includes('templateFromParams(pathname, params'))
    assert.equal(/(path|fromPath|toPath): window\.location/.test(src), false)
  })
  test('the device copy stores only through the whitelist', () => {
    const src = readFileSync(join(__dirname, '../../../components/layout/routeHealthLocal.ts'), 'utf8')
    assert.ok(src.includes('appendLocalEvidence(stored(), report, new Date())'))
    assert.ok(src.includes('readLocalEvidence(stored())'))
    assert.equal(/fetch\(|sendBeacon|XMLHttpRequest/.test(src), false, 'nothing leaves the device from here')
  })
})

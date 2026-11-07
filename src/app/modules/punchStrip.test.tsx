// The punch-in strip on the Modules page: what it draws for each answer, and the
// wiring that keeps it honest (own punch only, not while previewing, not while
// arranging the cards).
//
// Run:
//   npm run test:file -- src/app/modules/punchStrip.test.tsx

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PunchStrip as Answer } from '@/lib/minop/punchStrip'
import type { PunchStrip as Strip } from './PunchStrip'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r/g, '')

let PunchStrip: typeof Strip

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  PunchStrip = (await import('./PunchStrip')).PunchStrip
})

function draw(answer: Answer | null, enabled = true): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (answer) client.setQueryData(['punch-strip', 'u1'], answer)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(PunchStrip, { userId: 'u1', enabled })),
  )
}

const answer = (over: Partial<Answer>): Answer => ({
  today: '2026-11-03', tone: 'on_time', title: 'You punched in at 10:04 am', detail: 'On time. This note goes away at 10:36 am.', showForMs: 1_560_000, ...over,
})

describe('what it draws', () => {
  test('green: the title and the line under it, and no way to hide it', () => {
    const html = draw(answer({}))
    assert.match(html, /You punched in at 10:04 am/)
    assert.match(html, /On time\. This note goes away at 10:36 am\./)
    assert.match(html, /class="strip ok"/)
    assert.equal(html.includes('Hide for today'), false)
  })

  test('amber for late', () => {
    const html = draw(answer({ tone: 'late', title: 'You punched in at 10:27 am', detail: 'Late by 27 minutes, counted from 10:00 am. This note goes away at 10:59 am.' }))
    assert.match(html, /class="strip late"/)
    assert.match(html, /Late by 27 minutes/)
  })

  test('red: the notice and "Hide for today"', () => {
    const html = draw(answer({ tone: 'missing', title: 'No punch-in recorded for you today', detail: 'Office opened at 10:00 am.', showForMs: null }))
    assert.match(html, /class="strip missing"/)
    assert.match(html, /No punch-in recorded for you today/)
    assert.match(html, /<button type="button" class="hide">Hide for today<\/button>/)
  })

  test('nothing for an answer of nothing, while it loads, or when it is switched off', () => {
    assert.equal(draw(answer({ tone: null, title: '', detail: '', showForMs: null })), '')
    assert.equal(draw(null), '')
    assert.equal(draw(answer({ tone: 'missing' }), false), '')
  })
})

describe('the wiring', () => {
  const ROUTE = read('src/app/api/attendance/my-punch/route.ts')
  const PAGE = read('src/app/modules/page.tsx')
  const COMPONENT = read('src/app/modules/PunchStrip.tsx')

  test('the route answers for the caller only: id from the token, nothing from the request', () => {
    assert.match(ROUTE, /resolveCaller\(req\)/)
    assert.match(ROUTE, /readPunchStrip\(caller\.svc, caller\.id\)/)
    for (const forbidden of ['searchParams', 'req.json', 'formData', 'nextUrl', 'requireAdmin']) {
      assert.equal(ROUTE.includes(forbidden), false, `the route must not use ${forbidden}`)
    }
    assert.match(ROUTE, /export async function GET/)
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(ROUTE), false)
  })

  test('first thing on the page, not while arranging, not while previewing someone else', () => {
    const strip = '{!editingOrder && <PunchStrip userId={userId} enabled={!viewMode} />}'
    assert.ok(PAGE.includes(strip))
    assert.ok(PAGE.indexOf(strip) < PAGE.indexOf('<QuickActionList actions={quickActions} variant="page" />'))
  })

  test('"Hide for today" only ever hides the red strip, against the server date', () => {
    assert.match(COMPONENT, /data\.tone === 'missing' && isPunchStripHidden\(hiddenOn, data\.today\)/)
    assert.match(COMPONENT, /window\.localStorage\.setItem\(punchStripHiddenKey\(userId\), data\.today\)/)
  })

  test('it reads nothing itself and writes nothing anywhere', () => {
    for (const forbidden of ['adminClient', 'SERVICE_ROLE', 'supabase.from', '.from(', 'method: \'POST\'']) {
      assert.equal(COMPONENT.includes(forbidden), false, `PunchStrip must not use ${forbidden}`)
    }
  })

  test('the 30 minutes are counted from when the answer arrived, never from the device clock alone', () => {
    assert.match(COMPONENT, /showFor - \(Date\.now\(\) - dataUpdatedAt\)/)
  })
})

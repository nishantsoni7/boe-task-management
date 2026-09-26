/**
 * GET /api/payroll/periods ISSUES ITS INDEPENDENT READS TOGETHER.
 *
 * Measured on production (2026-09-26, Attendance & Payroll from Modules): the
 * server took 4.6 s before its first byte. Every read here is a separate
 * server → database round trip (~0.45 s from iad1 to ap-northeast-1), and the
 * route issued them strictly one after another.
 *
 * This runs the REAL handler against an in-process fake Supabase HTTP server
 * with a fixed delay per call — no database, no network beyond 127.0.0.1 — and
 * records when each read starts. It pins:
 *   - periods, generations and results start together;
 *   - the status-event read starts before the attendance read finishes;
 *   - the response is unchanged (headcount from results, stale marker, trail);
 *   - a failing periods read is still the same 500.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const DELAY = 60
const USER = '00000000-0000-4000-8000-00000000a001'
const P1 = '00000000-0000-4000-8000-0000000000a1'
const P2 = '00000000-0000-4000-8000-0000000000a2'

type Call = { path: string; start: number; end: number }
let calls: Call[] = []
let failPeriods = false
let t0 = Date.now()

const rows: Record<string, unknown> = {
  '/rest/v1/payroll_periods': [
    { id: P1, payroll_month: 8, payroll_year: 2026, status: 'generated' },
    { id: P2, payroll_month: 7, payroll_year: 2026, status: 'locked' },
  ],
  '/rest/v1/payroll_generation': [
    { payroll_period_id: P1, employee_count: 1, completed_at: '2026-09-02T10:00:00Z' },
    { payroll_period_id: P2, employee_count: 3, completed_at: '2026-08-02T10:00:00Z' },
  ],
  '/rest/v1/payroll_results': [1, 2, 3, 4, 5].map(i => ({ id: `r${i}`, payroll_period_id: i <= 3 ? P1 : P2 })),
  '/rest/v1/attendance_records': [
    { attendance_date: '2026-08-10', updated_at: '2026-09-05T10:00:00Z' }, // after P1's generation → stale
    { attendance_date: '2026-07-10', updated_at: '2026-07-11T10:00:00Z' },
  ],
  '/rest/v1/payroll_period_status_events': [
    { payroll_period_id: P2, event_type: 'locked', created_at: '2026-08-03T10:00:00Z', actor_id: USER, reason: null },
  ],
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x')
  const start = Date.now() - t0
  setTimeout(() => {
    const end = Date.now() - t0
    calls.push({ path: u.pathname, start, end })
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body))
    }
    if (u.pathname === '/auth/v1/user') return json(200, { id: USER, aud: 'authenticated', role: 'authenticated' })
    if (u.pathname === '/rest/v1/users') {
      const one = (req.headers.accept ?? '').includes('vnd.pgrst.object')
      const me = { id: USER, role: 'admin', team: null }
      return json(200, one ? me : [me])
    }
    if (u.pathname === '/rest/v1/payroll_periods' && failPeriods) return json(500, { message: 'periods read failed', code: 'XX000' })
    const body = (rows[u.pathname] ?? []) as unknown[]
    return json(200, body, { 'content-range': `0-${Math.max(body.length - 1, 0)}/${body.length}` })
  }, DELAY)
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GET: (req: any) => Promise<Response>

before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${port}`
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'synthetic-anon-key'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role-key'
  ;({ GET } = await import('./route'))
})
after(() => new Promise<void>(r => server.close(() => r())))

async function call() {
  calls = []; t0 = Date.now()
  const { NextRequest } = await import('next/server')
  const res = await GET(new NextRequest('http://localhost/api/payroll/periods', { headers: { authorization: 'Bearer synthetic-token' } }))
  return { status: res.status, body: await res.json(), elapsed: Date.now() - t0 }
}
const first = (path: string) => calls.find(c => c.path === `/rest/v1/${path}`)!

describe('the independent reads overlap', () => {
  test('periods, generations and results start together', async () => {
    failPeriods = false
    const { status } = await call()
    assert.equal(status, 200)
    const p = first('payroll_periods'), g = first('payroll_generation'), r = first('payroll_results')
    assert.ok(Math.max(p.start, g.start, r.start) < Math.min(p.end, g.end, r.end),
      `the three reads ran side by side (starts ${p.start}/${g.start}/${r.start})`)
  })

  test('the status trail starts before the attendance read finishes', async () => {
    failPeriods = false
    await call()
    const s = first('payroll_period_status_events'), a = first('attendance_records')
    assert.ok(s.start < a.end, `status events at ${s.start}, attendance done at ${a.end}`)
  })

  test('fewer sequential round trips: under 5 delays, where the old chain took 7', async () => {
    failPeriods = false
    const { elapsed } = await call()
    // auth → profile → [periods|gens|results] → [attendance|status events]
    assert.ok(elapsed < DELAY * 5 + 40, `took ${elapsed} ms`)
  })
})

describe('the response is unchanged', () => {
  test('headcount, run metadata, stale marker and trail per period', async () => {
    failPeriods = false
    const { body } = await call()
    const byId = Object.fromEntries((body.periods as { id: string }[]).map(p => [p.id, p])) as Record<string, Record<string, unknown>>
    assert.deepEqual(Object.keys(byId), [P1, P2])
    assert.equal(byId[P1].employee_count, 3, 'headcount comes from results, not the run')
    assert.equal(byId[P1].last_run_employee_count, 1)
    assert.equal(byId[P1].out_of_date, true, 'attendance changed after the generation')
    assert.equal(byId[P2].out_of_date, false)
    assert.equal(byId[P2].employee_count, 2)
    assert.ok(byId[P2].last_status_event, 'the locked period carries its trail')
  })

  test('a failed periods read is still a 500 with its message', async () => {
    failPeriods = true
    const { status, body } = await call()
    failPeriods = false
    assert.equal(status, 500)
    assert.equal(body.error, 'periods read failed')
  })
})

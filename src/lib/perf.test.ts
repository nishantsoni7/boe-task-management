/**
 * perf — behavioural tests
 *
 * The two things that must hold for instrumentation left in shipped code:
 * it is completely inert when disabled, and it never carries a payload that
 * could leak task/comment/attachment content into a log.
 *
 * Run:
 *   npx tsx --test src/lib/perf.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  perfTrack,
  perfStart,
  perfNow,
  buildPerfReport,
  formatPerfReport,
  PERF_TOTAL_WARN_MS,
  PERF_PHASE_WARN_MS,
  type PerfReport,
} from './perf'

/** A clock the test drives by hand — no sleeping, no flakiness. */
function fakeClock(steps: number[]) {
  let i = 0
  return () => steps[Math.min(i++, steps.length - 1)]
}

function collector() {
  const reports: PerfReport[] = []
  const lines: string[] = []
  return { reports, lines, sink: (r: PerfReport, l: string) => { reports.push(r); lines.push(l) } }
}

describe('buildPerfReport', () => {
  test('flags a total over the 1000ms threshold', () => {
    assert.equal(buildPerfReport('task.create', 1200, []).slow, true)
    assert.equal(buildPerfReport('task.create', PERF_TOTAL_WARN_MS, []).slow, false, 'exactly at the threshold is not slow')
    assert.equal(buildPerfReport('task.create', 999, []).slow, false)
  })

  test('flags an individual phase over the 500ms threshold', () => {
    const r = buildPerfReport('task.detail.load', 700, [
      { name: 'auth', ms: 120 },
      { name: 'queries', ms: 580 },
    ])
    assert.equal(r.slow, false, 'total is under 1000ms')
    assert.equal(r.flagged, true, 'but a phase crossed 500ms')
    assert.deepEqual(r.phases.map(p => p.slow), [false, true])
  })

  test('a phase exactly at the threshold is not flagged', () => {
    const r = buildPerfReport('task.edit', 600, [{ name: 'update', ms: PERF_PHASE_WARN_MS }])
    assert.equal(r.flagged, false)
  })

  test('nothing is flagged when everything is fast', () => {
    const r = buildPerfReport('task.edit', 210, [{ name: 'update', ms: 90 }, { name: 'log', ms: 120 }])
    assert.equal(r.slow, false)
    assert.equal(r.flagged, false)
  })

  test('durations are rounded to a tenth of a millisecond', () => {
    const r = buildPerfReport('task.edit', 123.4567, [{ name: 'a', ms: 12.3456 }])
    assert.equal(r.totalMs, 123.5)
    assert.equal(r.phases[0].ms, 12.3)
  })
})

describe('formatPerfReport', () => {
  test('renders action, total and phases on one line', () => {
    const line = formatPerfReport(buildPerfReport('task.detail.load', 240, [
      { name: 'auth', ms: 100 }, { name: 'queries', ms: 140 },
    ]))
    assert.equal(line, '[perf] task.detail.load 240ms — auth=100ms queries=140ms')
  })

  test('marks a slow total and a slow phase', () => {
    const line = formatPerfReport(buildPerfReport('task.create', 1400, [
      { name: 'insert', ms: 300 }, { name: 'upload', ms: 1100 },
    ]))
    assert.match(line, /!SLOW/)
    assert.match(line, /upload=1100ms!/)
    assert.doesNotMatch(line, /insert=300ms!/)
  })

  test('omits the phase section when there are no phases', () => {
    assert.equal(formatPerfReport(buildPerfReport('task.delete', 50, [])), '[perf] task.delete 50ms')
  })

  test('emits only action, phase names and numbers — no payload can appear', () => {
    // The privacy contract: the API accepts no payload at all, so a line can
    // only ever contain the static action, static phase names, and durations.
    const line = formatPerfReport(buildPerfReport('task.comment.add', 300, [{ name: 'insert', ms: 300 }]))
    assert.match(line, /^\[perf\] [a-z.\-]+ [\d.]+ms — [a-z]+=[\d.]+ms$/)
  })
})

describe('perfTrack', () => {
  test('is completely inert when disabled', () => {
    const c = collector()
    const t = perfTrack('task.create', { enabled: false, sink: c.sink, now: () => { throw new Error('clock must not be read') } })
    t.mark('phase')
    assert.equal(t.end(), null)
    assert.deepEqual(c.reports, [], 'nothing logged')
  })

  test('measures total and phases from the injected clock', () => {
    const c = collector()
    // Clock: start=0, mark('auth')=200, mark('queries')=350, end=900.
    // A phase runs from its own mark to the next mark (or to end()), so
    // 'auth' spans 200→350 and 'queries' spans 350→900. Time before the first
    // mark is counted in the total but belongs to no named phase.
    const t = perfTrack('task.detail.load', { enabled: true, sink: c.sink, now: fakeClock([0, 200, 350, 900]) })
    t.mark('auth')
    t.mark('queries')
    t.end()

    const r = c.reports[0]
    assert.equal(r.totalMs, 900)
    assert.deepEqual(r.phases.map(p => p.name), ['auth', 'queries'])
    assert.deepEqual(r.phases.map(p => p.ms), [150, 550])
    assert.equal(r.flagged, true, '550ms phase crosses the phase threshold')
  })

  test('end() closes the last open phase rather than dropping it', () => {
    const c = collector()
    const t = perfTrack('task.create', { enabled: true, sink: c.sink, now: fakeClock([0, 100, 700]) })
    t.mark('upload')
    t.end()
    assert.deepEqual(c.reports[0].phases.map(p => p.name), ['upload'])
    assert.equal(c.reports[0].phases[0].ms, 600)
  })

  test('an action with no marks reports a total and no phases', () => {
    const c = collector()
    perfTrack('task.delete', { enabled: true, sink: c.sink, now: fakeClock([0, 120]) }).end()
    assert.equal(c.reports[0].totalMs, 120)
    assert.deepEqual(c.reports[0].phases, [])
  })

  test('end() is idempotent — a second call logs nothing', () => {
    const c = collector()
    const t = perfTrack('task.edit', { enabled: true, sink: c.sink, now: fakeClock([0, 100]) })
    assert.notEqual(t.end(), null)
    assert.equal(t.end(), null)
    assert.equal(c.reports.length, 1)
  })

  test('mark() after end() is ignored', () => {
    const c = collector()
    const t = perfTrack('task.edit', { enabled: true, sink: c.sink, now: fakeClock([0, 100]) })
    t.end()
    t.mark('too late')
    assert.equal(c.reports.length, 1)
    assert.deepEqual(c.reports[0].phases, [])
  })

  test('the sink receives the report and its rendered line together', () => {
    const c = collector()
    perfTrack('task.status.update', { enabled: true, sink: c.sink, now: fakeClock([0, 60]) }).end()
    assert.equal(c.lines[0], formatPerfReport(c.reports[0]))
  })
})

describe('perfStart', () => {
  test('returns a closure that ends the measurement', () => {
    const c = collector()
    const done = perfStart('notification.delete.single', { enabled: true, sink: c.sink, now: fakeClock([0, 1500]) })
    const report = done()
    assert.equal(report?.totalMs, 1500)
    assert.equal(report?.slow, true)
    assert.match(c.lines[0], /notification\.delete\.single 1500ms !SLOW/)
  })

  test('returns a no-op closure when disabled', () => {
    const c = collector()
    assert.equal(perfStart('task.restore', { enabled: false, sink: c.sink })(), null)
    assert.deepEqual(c.reports, [])
  })
})

describe('perfNow', () => {
  test('returns a monotonic-ish high-resolution number', () => {
    const a = perfNow()
    const b = perfNow()
    assert.equal(typeof a, 'number')
    assert.equal(Number.isFinite(a), true)
    assert.equal(b >= a, true)
  })
})

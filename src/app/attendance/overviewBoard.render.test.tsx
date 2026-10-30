// Server-render tests for the Overview: what an admin reads for a month, and the
// parts that must never go missing.

import { before, test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OverviewBoard as Board } from './OverviewBoard'
import { emptyTally, type OverviewData, type OverviewPerson, type StripDay } from '@/lib/attendance/attendanceScore'
import { todayLine } from '@/lib/attendance/overviewToday'
import type { MachineDayEntry, MachineDayView } from '@/lib/minop/machineDayView'

let OverviewBoard: typeof Board

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  OverviewBoard = (await import('./OverviewBoard')).OverviewBoard
})

const strip: StripDay[] = [
  { date: '2026-11-01', kind: 'off' },
  { date: '2026-11-02', kind: 'absent' },
  { date: '2026-11-03', kind: 'late' },
  { date: '2026-11-04', kind: 'pending' },
]

const person = (over: Partial<OverviewPerson>): OverviewPerson => ({
  id: 'a',
  name: 'Sample Person',
  code: '0001',
  strip,
  tally: { ...emptyTally(), ok: 20, late: 2 },
  counted: 22,
  score: 98,
  band: 'great',
  rank: 1,
  notRanked: null,
  reason: 'On time on 20 of 22 days',
  usualArrival: '9:58',
  history: [null, null, 90, 92, 94, 98],
  delta: 4,
  ...over,
})

const data = (over: Partial<OverviewData> = {}): OverviewData => ({
  year: 2026,
  month: 11,
  coverageThrough: '2026-11-28',
  workingDaysCounted: 23,
  months: [
    { year: 2026, month: 6 }, { year: 2026, month: 7 }, { year: 2026, month: 8 },
    { year: 2026, month: 9 }, { year: 2026, month: 10 }, { year: 2026, month: 11 },
  ],
  company: { score: 89, history: [91, 91, 91, 90, 90, 89], delta: -1 },
  totals: {
    late: { total: 45, people: 8, top: { name: 'Sample Person', count: 14 } },
    absent: { total: 9, people: 3, top: { name: 'Other Person', count: 5 } },
    miss: { total: 6, people: 5, top: { name: 'Other Person', count: 2 } },
  },
  people: [
    person({}),
    person({ id: 'b', name: 'Other Person', score: 66, band: 'attention', rank: 2, reason: '5 absent days and 7 late', delta: -8 }),
    person({ id: 'c', name: 'New Person', score: null, band: null, rank: null, notRanked: 'Joined 25 Nov, 4 days so far', delta: null, history: [null, null, null, null, null, null], usualArrival: null }),
  ],
  pendingRequests: 3,
  noMachineId: 1,
  fellBackFrom: null,
  ...over,
})

const render = (d: OverviewData = data(), today: MachineDayView | null = null) =>
  renderToStaticMarkup(<OverviewBoard data={d} today={today} />)

describe('the Overview', () => {
  test('names who is doing well and who needs attention, with the reason', () => {
    const html = render()
    assert.ok(html.includes('Doing great'))
    assert.ok(html.includes('Needs attention'))
    assert.ok(html.includes('On time on 20 of 22 days'))
    assert.ok(html.includes('5 absent days and 7 late'))
  })

  test('shows the company score and how it moved', () => {
    const html = render()
    assert.ok(html.includes('Company score'))
    assert.ok(html.includes('>89<'))
    assert.ok(html.includes('1 point below October'))
  })

  test('someone who cannot be ranked says why and has no score', () => {
    const html = render()
    assert.ok(html.includes('Joined 25 Nov, 4 days so far'))
  })

  test('each person opens on their own days for this month', () => {
    assert.ok(render().includes('/attendance/monthly-review/b?year=2026&amp;month=11'))
  })

  test('the day blocks say what they are, not only by colour', () => {
    const html = render()
    assert.ok(html.includes('Mon, 2 Nov: Absent') || html.includes('Mon 2 Nov: Absent'))
    assert.match(html, /role="img" aria-label="20 on time, 2 late or left early/)
  })

  test('the legend carries the scoring rule', () => {
    const html = render()
    for (const text of ['On time, full day', 'Late or left early', 'One punch missing', 'Half day', 'Absent', 'Approved leave']) {
      assert.ok(html.includes(text), text)
    }
    assert.ok(html.includes('A day you waived or approved never counts against the person.'))
  })

  test('nobody in a band is said out loud rather than left blank', () => {
    const html = render(data({ people: [person({ band: 'okay', score: 90 })] }))
    assert.ok(html.includes('Nobody reached 95 this month.'))
    assert.ok(html.includes('Nobody is below 85 this month.'))
  })

  test('what is waiting is linked, and a zero is not', () => {
    assert.ok(render().includes('3 requests waiting'))
    assert.ok(render().includes('1 person has no Machine ID'))
    const quiet = render(data({ pendingRequests: 0, noMachineId: 0 }))
    assert.equal(quiet.includes('requests waiting'), false)
    assert.equal(quiet.includes('Machine ID'), false)
  })

  test('every page of the module can still be reached', () => {
    const html = render()
    for (const href of [
      '/attendance/upload', '/attendance/records', '/attendance/monthly-review', '/attendance/requests', '/payroll',
      '/attendance/today', '/attendance/minop', '/attendance/correction-log',
      '/attendance/employees', '/attendance/holidays', '/payroll/settings',
    ]) assert.ok(html.includes(`href="${href}"`), href)
  })
})

describe('the line about today', () => {
  const entry = (over: Partial<MachineDayEntry>): MachineDayEntry => ({
    userId: 'u', name: 'U', machineId: '1', checkInAt: null, checkOutAt: null, hoursWorked: null, lateMinutes: null,
    status: 'no_punch_yet', group: 'no_punch', approved: false, note: null, ...over,
  })
  const view = (state: MachineDayView['health']['state'], entries: MachineDayEntry[]): MachineDayView => ({
    date: '2026-11-30', today: '2026-11-30', earliest: '2026-11-01',
    health: { state, today: '2026-11-30', lastPunch: null },
    entries, counts: {} as MachineDayView['counts'], strays: [],
  })

  test('counts who has punched, out of who was expected', () => {
    const line = todayLine(view('sending', [
      entry({ status: 'in_office', checkInAt: '2026-11-30T04:30:00Z' }),
      entry({ status: 'in_office', checkInAt: '2026-11-30T05:10:00Z', lateMinutes: 40 }),
      entry({}),
      entry({ status: 'on_leave' }),
      entry({ status: 'no_machine_id' }),
    ]))
    assert.equal(line.lead, 'Today: 2 of 3 people have punched in, 1 late so far.')
    assert.equal(line.stopped, false)
  })

  test('a stopped machine is said first', () => {
    const line = todayLine(view('stopped', [entry({})]))
    assert.equal(line.lead, 'Machine has stopped sending.')
    assert.equal(line.stopped, true)
  })

  test('a day off counts nobody', () => {
    assert.equal(todayLine(view('day_off', [entry({ status: 'day_off' })])).lead, 'Day off today.')
  })
})

describe('the page', () => {
  const page = readFileSync('src/app/attendance/page.tsx', 'utf8')

  test('keeps the month in the address', () => {
    assert.ok(page.includes('useSearchParams'))
    assert.ok(page.includes('/attendance?year=${year}&month=${month}'))
  })

  test('a failed read of today cannot take the ranking down with it', () => {
    assert.match(page, /Today's line is extra/)
  })

  test('the links stay when the month has nothing to show or fails to load', () => {
    assert.equal((page.match(/<PageLinks \/>/g) ?? []).length, 2)
  })
})

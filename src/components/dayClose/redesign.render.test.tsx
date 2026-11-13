// Team Today and the Monthly Review, redesigned 2026-11-13: what each screen draws from a real-looking answer.
//
// Run:
//   npm run test:file -- src/components/dayClose/redesign.render.test.tsx

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

let TeamTodayScreen: ComponentType
let MonthlyReviewScreen: ComponentType

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  TeamTodayScreen = (await import('./TeamTodayScreen')).TeamTodayScreen
  MonthlyReviewScreen = (await import('@/components/scoreboard/MonthlyReviewScreen')).MonthlyReviewScreen
})

function draw(Screen: ComponentType, key: unknown[], data: unknown): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(key, data)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Screen)))
}

const PAST = '2026-11-12'
const ist = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString()
const row = (over: Record<string, unknown>) => ({
  id: 'p', name: 'Person', machineLinked: true, onLeave: false,
  punch: { checkInAt: ist(PAST, '10:02'), checkOutAt: ist(PAST, '18:35') },
  plan: { submitted_at: ist(PAST, '10:10'), closed_at: ist(PAST, '18:20'), close_note: null },
  counts: { total: 2, done: 2, carried: 0, open: 0 }, tasks: [], strikes: [], monthStrikes: 0,
  calls: { call: 3, whatsapp: 5 }, overdueTasks: 0, ...over,
})
const team = {
  date: PAST, today: '2026-11-13', workingDay: true, holiday: false,
  viewer: { isReviewer: true, manages: true }, reviewer: { id: 'o', name: 'Owner' },
  planDue: 630, closeOpens: 1080,
  rows: [
    row({ id: 'a', name: 'Jasvi' }),
    row({ id: 'b', name: 'Dhruv', plan: null, overdueTasks: 3 }),
    row({ id: 'c', name: 'Prerna', onLeave: true, plan: null }),
  ],
  openStrikes: [{ id: 's1', employee_id: 'b', work_date: PAST, kind: 'no_plan', status: 'open', detail: { due: '10:30 am' }, decision_note: null, name: 'Dhruv', label: 'No plan filed' }],
  lockedLeave: [{ requestId: 'r1', employeeId: 'a', name: 'Jasvi', requestType: 'full_day_leave', startDate: '2026-11-16', endDate: '2026-11-16', words: '2 overdue tasks' }],
}

describe('Team Today', () => {
  test('decisions first, then one table worst first: attention, on track, away', () => {
    const html = draw(TeamTodayScreen, ['day-close', 'team', null], team)
    assert.match(html, /Needs your decision/)
    assert.match(html, /Dhruv · No plan filed/)
    assert.match(html, /Leave locked/)
    assert.match(html, /href="\/attendance\/requests"/)
    const attention = html.indexOf('Needs attention · 1')
    const onTrack = html.indexOf('On track · 1')
    const away = html.indexOf('Away · 1')
    assert.ok(attention > 0 && attention < onTrack && onTrack < away, 'the groups in order')
    assert.ok(html.indexOf('Dhruv', attention) < onTrack, 'Dhruv needs attention')
    assert.match(html, /3 overdue|>3</)
    assert.match(html, /People &amp; targets/)
    assert.match(html, />Ratings</)
  })
  test('the setup sections are on their own tab, not on Today', () => {
    const html = draw(TeamTodayScreen, ['day-close', 'team', null], team)
    assert.equal(html.includes('Who takes part'), false)
  })
})

const review = {
  month: '2026-11-01', monthLabel: 'November 2026', ended: true, frozen: null,
  rows: [
    { id: 'a', name: 'Prerna', track: 'general', score: 88, band: 'Star', change: 6, votes: 2, sales: 0, flag: null },
    { id: 'b', name: 'Ashok', track: 'general', score: 37, band: 'Red zone', change: null, votes: 0, sales: 0, flag: { reason: 'red', redStreak: 1, step: 'one_to_one', label: 'Private 1:1 and goals' } },
  ],
  awards: [
    { key: 'star_performer', label: 'Star Performer', rule: 'Highest score of the month', many: false, suggested: ['a'], saved: [] },
    { key: 'never_late', label: 'Never Late', rule: 'Every working day present and on time', many: true, suggested: [], saved: [] },
  ],
  reviews: [], announcement: null,
}

describe('Monthly Review', () => {
  test('an ended month opens on step 2, the awards, with the step bar', () => {
    const html = draw(MonthlyReviewScreen, ['scoreboard', 'review', null], review)
    for (const s of ['Standings', 'Awards', 'Freeze &amp; announce', 'Private reviews']) assert.match(html, new RegExp(s))
    assert.match(html, /Step 2 · Confirm the awards/)
    assert.match(html, /0 of 2 confirmed/)
    assert.match(html, />Suggested</)
    assert.equal(html.includes('Step 1 · Final standings'), false)
  })
  test('a frozen month opens on step 3 with the message ready to copy', () => {
    const html = draw(MonthlyReviewScreen, ['scoreboard', 'review', null], {
      ...review, frozen: { frozen_at: '2026-12-01T06:00:00Z' }, announcement: '🏆 BOE Champions of November 2026 🏆',
      awards: review.awards.map(a => ({ ...a, saved: a.suggested })),
    })
    assert.match(html, /Step 3 · Announced/)
    assert.match(html, /BOE Champions of November 2026/)
    assert.match(html, /Copy message/)
  })
})

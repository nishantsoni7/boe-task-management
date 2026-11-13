/**
 * THE TODAY CARD AND THE TEAM SWITCH, ACTUALLY RENDERED (20270704000000).
 *
 * While the switch is off the card keeps what is useful (the task list and "File today's plan") but drops the
 * red "Your plan was due" banner, which is about a rule that is paused. Once live, the banner is back.
 *
 * Run: npm run test:file -- src/components/dayClose/dayCardTeamSwitch.render.test.tsx
 */

import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DayCard as Card } from './DayCard'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:54321'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'

let DayCard: typeof Card

// The runner cannot load a CSS module, so for this file each class is its own name.
before(async () => {
  const loaders = (Module as unknown as { _extensions: Record<string, (mod: { exports: unknown }) => void> })._extensions
  loaders['.css'] = mod => {
    mod.exports = { __esModule: true, default: new Proxy({}, { get: (_, name) => String(name) }) }
  }
  DayCard = (await import('./DayCard')).DayCard
})

const myDay = (live: boolean | undefined) => ({
  member: true, live, today: '2026-11-13', workingDay: true, planDue: 630, closeOpens: 1080,
  plan: null, tasks: [], counts: { total: 0, done: 0, carried: 0, open: 0 },
  prompt: { kind: 'file_plan', late: true, due: '10:30 am' },
  punch: { checkInAt: null, checkOutAt: null },
})

function render(day: ReturnType<typeof myDay>): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['day-close', 'me'], day)
  return renderToStaticMarkup(<QueryClientProvider client={client}><DayCard enabled /></QueryClientProvider>)
}

describe('the Today card', () => {
  test('paused: no "plan was due" banner, but the card and "File today’s plan" stay', () => {
    const html = render(myDay(false))
    assert.doesNotMatch(html, /Your plan was due/)
    assert.doesNotMatch(html, /recorded as a strike/)
    assert.match(html, /Today · /)
    assert.match(html, /File today’s plan/)
  })

  test('a switch that is missing from the answer is paused too', () => {
    assert.doesNotMatch(render(myDay(undefined)), /Your plan was due/)
  })

  test('live: the red banner is back', () => {
    assert.match(render(myDay(true)), /Your plan was due at 10:30 am/)
  })
})

/**
 * Task reporting: the Dashboard's creation counts and the Completed history.
 *
 * The rules are filter lists handed to the database, so these tests evaluate
 * the SAME lists against sample rows with SQL's semantics — including NULL,
 * where `assigned_to <> me` is not true for an unassigned task. What passes here
 * is exactly what the database is asked.
 *
 * Dates are built from local parts (`new Date(2026, 8, 10)`), which is what the
 * browser does, so the day boundaries hold in any time zone the suite runs in —
 * and in IST they are the difference between a 00:30 completion landing on its
 * own day or the day before.
 *
 * Run:
 *   npx tsx --test src/lib/tasks/taskReporting.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildListSearch, dateParam, isCalendarDate, parseListState } from '@/lib/listState'
import {
  COMPLETED_PAGE_SIZE, DAY_MS, DELEGATED_COMPLETED_PARAMS, MY_COMPLETED_PARAMS,
  applyTaskFilters, completedListFilters, completedPageRange, completedScopeFilters,
  createdTaskFilters, escapeLikePattern, localDayRange, onOrAfter, pageSpan,
  rollingSince, totalPages, withinRange, yesterdayRange,
  type FilterableQuery, type TaskFilter,
} from './taskReporting'

// ── A tiny model of what PostgREST does with a filter list ──────────────────

type Row = Record<string, string | null>

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function likeToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '\\' && i + 1 < pattern.length) { out += escapeRegExp(pattern[++i]); continue }
    out += ch === '%' ? '.*' : ch === '_' ? '.' : escapeRegExp(ch)
  }
  return new RegExp(`^${out}$`, 'i')
}

function matches(row: Row, filters: readonly TaskFilter[]): boolean {
  return filters.every(f => {
    const value = row[f.column] ?? null
    if (f.op === 'notNull') return value !== null
    if (value === null) return false // every comparison with NULL is not true
    switch (f.op) {
      case 'eq':    return value === f.value
      case 'neq':   return value !== f.value
      case 'gte':   return Date.parse(value) >= Date.parse(f.value)
      case 'lt':    return Date.parse(value) < Date.parse(f.value)
      case 'ilike': return likeToRegExp(f.value).test(value)
    }
  })
}

const ME = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = new Date(2026, 8, 11, 10, 0, 0) // 11 Sep 2026, 10:00 local
const iso = (d: Date) => d.toISOString()

const created = (overrides: Row): Row => ({
  status: 'working', task_type: 'general', created_by: ME, assigned_to: ME, created_at: iso(NOW), ...overrides,
})

// ── Dashboard: self vs delegated ────────────────────────────────────────────

describe('tasks created: self vs delegated', () => {
  const since = rollingSince(NOW, 7)
  const self      = created({})
  const delegated = created({ assigned_to: OTHER })
  const received  = created({ created_by: OTHER })
  const unassigned = created({ assigned_to: null })

  test('self = created by me AND assigned to me', () => {
    const f = createdTaskFilters('self', ME, since)
    assert.equal(matches(self, f), true)
    assert.equal(matches(delegated, f), false)
    assert.equal(matches(received, f), false)
  })

  test('delegated = created by me AND assigned to somebody else', () => {
    const f = createdTaskFilters('delegated', ME, since)
    assert.equal(matches(delegated, f), true)
    assert.equal(matches(self, f), false)
    assert.equal(matches(received, f), false, 'a task someone gave me is not one I delegated')
  })

  test('a task assigned to nobody is neither', () => {
    assert.equal(matches(unassigned, createdTaskFilters('self', ME, since)), false)
    assert.equal(matches(unassigned, createdTaskFilters('delegated', ME, since)), false)
  })

  test('a normal self task counts as self, in both windows', () => {
    for (const days of [7, 30]) {
      const f = createdTaskFilters('self', ME, rollingSince(NOW, days))
      assert.equal(matches(created({ task_type: 'general' }), f), true, `${days}d`)
    }
  })

  test('a normal delegated task counts as delegated, in both windows', () => {
    for (const days of [7, 30]) {
      const f = createdTaskFilters('delegated', ME, rollingSince(NOW, days))
      assert.equal(matches(created({ task_type: 'general', assigned_to: OTHER }), f), true, `${days}d`)
    }
  })

  test('a quotation request assigned to myself counts as neither', () => {
    const quote = created({ task_type: 'quotation_request', assigned_to: ME })
    for (const days of [7, 30]) {
      assert.equal(matches(quote, createdTaskFilters('self', ME, rollingSince(NOW, days))), false, `self ${days}d`)
      assert.equal(matches(quote, createdTaskFilters('delegated', ME, rollingSince(NOW, days))), false, `delegated ${days}d`)
    }
  })

  test('a quotation request assigned to another employee counts as neither', () => {
    const quote = created({ task_type: 'quotation_request', assigned_to: OTHER })
    for (const days of [7, 30]) {
      assert.equal(matches(quote, createdTaskFilters('delegated', ME, rollingSince(NOW, days))), false, `delegated ${days}d`)
      assert.equal(matches(quote, createdTaskFilters('self', ME, rollingSince(NOW, days))), false, `self ${days}d`)
    }
  })

  test('status does not matter — a created task counts whatever became of it', () => {
    for (const status of ['completed', 'cancelled', 'pending_approval']) {
      assert.equal(matches(created({ status }), createdTaskFilters('self', ME, since)), true, status)
    }
  })
})

describe('rolling 7 / 30 day windows', () => {
  for (const days of [7, 30]) {
    test(`last ${days} days starts exactly ${days} × 24h before now, inclusive`, () => {
      const since = rollingSince(NOW, days)
      assert.equal(NOW.getTime() - since.getTime(), days * DAY_MS)
      const f = createdTaskFilters('self', ME, since)
      assert.equal(matches(created({ created_at: iso(since) }), f), true, 'on the boundary')
      assert.equal(matches(created({ created_at: iso(new Date(since.getTime() - 1)) }), f), false, '1ms before')
      assert.equal(matches(created({ created_at: iso(NOW) }), f), true, 'just now')
    })
  }

  test('an 8-day-old task is in the 30-day count but not the 7-day one', () => {
    const row = created({ created_at: iso(new Date(NOW.getTime() - 8 * DAY_MS)) })
    assert.equal(matches(row, createdTaskFilters('self', ME, rollingSince(NOW, 7))), false)
    assert.equal(matches(row, createdTaskFilters('self', ME, rollingSince(NOW, 30))), true)
  })
})

// ── Completed: scope, yesterday, local dates ────────────────────────────────

const completed = (overrides: Row): Row => ({
  status: 'completed', created_by: OTHER, assigned_to: ME, priority: 'high',
  title: 'Send revised quotation', completed_at: iso(NOW), ...overrides,
})

describe('whose completed tasks each list holds', () => {
  test('My Tasks: assigned to me, whoever created it', () => {
    const f = completedScopeFilters('assigned-to-me', ME)
    assert.equal(matches(completed({}), f), true)
    assert.equal(matches(completed({ created_by: ME }), f), true, 'my own self task')
    assert.equal(matches(completed({ assigned_to: OTHER }), f), false)
  })

  test('Assigned By Me: created by me and assigned to somebody else', () => {
    const f = completedScopeFilters('assigned-by-me', ME)
    assert.equal(matches(completed({ created_by: ME, assigned_to: OTHER }), f), true)
    assert.equal(matches(completed({ created_by: ME, assigned_to: ME }), f), false, 'self tasks are not delegated')
    assert.equal(matches(completed({ created_by: ME, assigned_to: null }), f), false)
    assert.equal(matches(completed({ created_by: OTHER, assigned_to: OTHER }), f), false)
  })

  test('only tasks that are completed NOW — reopened, submitted or cancelled work is excluded', () => {
    const f = completedScopeFilters('assigned-to-me', ME)
    // /api/restore-task clears completed_at, but the status rule alone excludes it.
    assert.equal(matches(completed({ status: 'working', completed_at: null }), f), false, 'reopened')
    assert.equal(matches(completed({ status: 'working' }), f), false, 'reopened, stale completed_at')
    assert.equal(matches(completed({ status: 'pending_approval', completed_at: null }), f), false)
    assert.equal(matches(completed({ status: 'cancelled' }), f), false)
  })
})

describe('"Yesterday" is the previous local calendar day', () => {
  const between = (now: Date) => withinRange('completed_at', yesterdayRange(now))
  const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
    completed({ completed_at: iso(new Date(y, m, d, h, min, s, ms)) })

  test('from 00:00 yesterday up to, not including, 00:00 today', () => {
    const f = between(NOW)
    assert.equal(matches(at(2026, 8, 10, 0, 0), f), true, 'first instant of yesterday')
    assert.equal(matches(at(2026, 8, 10, 23, 59, 59, 999), f), true, 'last instant of yesterday')
    assert.equal(matches(at(2026, 8, 11, 0, 0), f), false, 'midnight belongs to today')
    assert.equal(matches(at(2026, 8, 9, 23, 59, 59, 999), f), false, 'the day before')
  })

  test('just after midnight it is still the previous calendar day, not the last 24 hours', () => {
    const range = yesterdayRange(new Date(2026, 8, 11, 0, 5))
    assert.equal(range.start.getTime(), new Date(2026, 8, 10).getTime())
    assert.equal(range.end.getTime(), new Date(2026, 8, 11).getTime())
  })

  test('across a month boundary', () => {
    const range = yesterdayRange(new Date(2026, 9, 1, 9, 0))
    assert.equal(range.start.getTime(), new Date(2026, 8, 30).getTime())
  })

  test('last 7 / 30 days of completions are rolling, like the creation report', () => {
    const f = [...completedScopeFilters('assigned-to-me', ME), ...onOrAfter('completed_at', rollingSince(NOW, 7))]
    assert.equal(matches(completed({ completed_at: iso(rollingSince(NOW, 7)) }), f), true)
    assert.equal(matches(completed({ completed_at: iso(new Date(rollingSince(NOW, 7).getTime() - 1)) }), f), false)
  })
})

describe('Completed on: a local calendar date', () => {
  test('the range is local midnight to local midnight', () => {
    const range = localDayRange('2026-09-10')
    assert.ok(range)
    assert.equal(range.start.getTime(), new Date(2026, 8, 10).getTime())
    assert.equal(range.end.getTime(), new Date(2026, 8, 11).getTime())
  })

  test('an early-morning completion stays on its own day (UTC midnight would move it in IST)', () => {
    const f = completedListFilters('assigned-to-me', ME, { counterpart: '', priority: '', q: '', completedOn: '2026-09-10' })
    assert.equal(matches(completed({ completed_at: iso(new Date(2026, 8, 10, 0, 30)) }), f), true)
    assert.equal(matches(completed({ completed_at: iso(new Date(2026, 8, 10, 23, 59)) }), f), true)
    assert.equal(matches(completed({ completed_at: iso(new Date(2026, 8, 11, 0, 0)) }), f), false)
    assert.equal(matches(completed({ completed_at: null }), f), false, 'no completion time, no date match')
  })

  test('a date that does not exist is no filter, not an empty result', () => {
    assert.equal(localDayRange('2026-02-30'), null)
    assert.equal(localDayRange('10/09/2026'), null)
    assert.equal(isCalendarDate('2026-09-10'), true)
    assert.equal(dateParam().parse('2026-02-30'), '')
    assert.equal(dateParam().parse('2026-09-10'), '2026-09-10')
    const f = completedListFilters('assigned-to-me', ME, { counterpart: '', priority: '', q: '', completedOn: '2026-02-30' })
    assert.deepEqual(f, completedScopeFilters('assigned-to-me', ME))
  })

  test('it combines with search, priority and the assigner filter', () => {
    const f = completedListFilters('assigned-to-me', ME, {
      counterpart: OTHER, priority: 'high', q: '  revised ', completedOn: '2026-09-11',
    })
    const hit = completed({})
    assert.equal(matches(hit, f), true)
    assert.equal(matches({ ...hit, created_by: ME }, f), false, 'other assigner')
    assert.equal(matches({ ...hit, priority: 'low' }, f), false, 'other priority')
    assert.equal(matches({ ...hit, title: 'Call supplier' }, f), false, 'search')
    assert.equal(matches({ ...hit, completed_at: iso(new Date(2026, 8, 10, 12)) }, f), false, 'other day')
  })

  test('the Assigned By Me filter narrows by assignee', () => {
    const f = completedListFilters('assigned-by-me', ME, { counterpart: OTHER, priority: '', q: '', completedOn: '' })
    assert.equal(matches(completed({ created_by: ME, assigned_to: OTHER }), f), true)
    assert.ok(f.some(x => x.op === 'eq' && x.column === 'assigned_to' && x.value === OTHER))
  })

  test('search treats % and _ as the characters typed, not wildcards', () => {
    assert.equal(escapeLikePattern('50%_off\\'), '50\\%\\_off\\\\')
    const f = completedListFilters('assigned-to-me', ME, { counterpart: '', priority: '', q: '50%', completedOn: '' })
    assert.equal(matches(completed({ title: 'Advance 50% received' }), f), true)
    assert.equal(matches(completed({ title: 'Advance 500 received' }), f), false)
  })
})

// ── Paging ──────────────────────────────────────────────────────────────────

describe('twenty rows per page, counted by the database', () => {
  test('page size is 20', () => {
    assert.equal(COMPLETED_PAGE_SIZE, 20)
  })

  test('page N asks for exactly its twenty rows', () => {
    assert.deepEqual(completedPageRange(1), { from: 0, to: 19 })
    assert.deepEqual(completedPageRange(2), { from: 20, to: 39 })
    assert.deepEqual(completedPageRange(5), { from: 80, to: 99 })
  })

  test('a nonsense page number reads page 1', () => {
    for (const page of [0, -3, Number.NaN]) {
      assert.deepEqual(completedPageRange(Number.isNaN(page) ? 1 : page), { from: 0, to: 19 })
    }
    assert.deepEqual(completedPageRange(2.9), { from: 20, to: 39 })
  })

  test('page count from the total', () => {
    assert.equal(totalPages(0), 1)
    assert.equal(totalPages(20), 1)
    assert.equal(totalPages(21), 2)
    assert.equal(totalPages(83), 5)
  })

  test('position labels', () => {
    assert.deepEqual(pageSpan(1, 83), { first: 1, last: 20 })
    assert.deepEqual(pageSpan(2, 83), { first: 21, last: 40 })
    assert.deepEqual(pageSpan(5, 83), { first: 81, last: 83 })
    assert.deepEqual(pageSpan(1, 0), { first: 0, last: 0 })
  })
})

describe('the page lives in the URL, and a filter change returns to page 1', () => {
  for (const [label, params, counterpart] of [
    ['My Tasks', MY_COMPLETED_PARAMS, 'assignedBy'],
    ['Assigned By Me', DELEGATED_COMPLETED_PARAMS, 'assignee'],
  ] as const) {
    test(`${label}: changing any filter drops ?page`, () => {
      const current = 'priority=high&page=3'
      for (const patch of [{ completedOn: '2026-09-10' }, { q: 'quote' }, { priority: 'low' as const }, { [counterpart]: OTHER }]) {
        const next = new URLSearchParams(buildListSearch(params, current, patch, { pageKey: 'page' }))
        assert.equal(next.get('page'), null, JSON.stringify(patch))
      }
    })

    test(`${label}: moving to another page keeps every filter`, () => {
      const next = buildListSearch(params, 'priority=high&completedOn=2026-09-10', { page: 2 }, { pageKey: 'page' })
      assert.deepEqual(parseListState(params, new URLSearchParams(next)).page, 2)
      assert.equal(new URLSearchParams(next).get('priority'), 'high')
      assert.equal(new URLSearchParams(next).get('completedOn'), '2026-09-10')
    })

    test(`${label}: clearing the date removes it from the URL`, () => {
      const next = buildListSearch(params, 'completedOn=2026-09-10', { completedOn: '' }, { pageKey: 'page' })
      assert.equal(new URLSearchParams(next).get('completedOn'), null)
    })
  }
})

// ── Transport ───────────────────────────────────────────────────────────────

describe('applyTaskFilters hands each filter to the query builder verbatim', () => {
  class Recorder implements FilterableQuery<Recorder> {
    calls: string[] = []
    private log(entry: string) { this.calls.push(entry); return this }
    eq(c: string, v: string)  { return this.log(`eq ${c} ${v}`) }
    neq(c: string, v: string) { return this.log(`neq ${c} ${v}`) }
    not(c: string, op: string, v: null) { return this.log(`not ${c} ${op} ${v}`) }
    gte(c: string, v: string) { return this.log(`gte ${c} ${v}`) }
    lt(c: string, v: string)  { return this.log(`lt ${c} ${v}`) }
    ilike(c: string, v: string) { return this.log(`ilike ${c} ${v}`) }
  }

  test('delegated creation filters', () => {
    const since = rollingSince(NOW, 7)
    const recorder = applyTaskFilters(new Recorder(), createdTaskFilters('delegated', ME, since))
    assert.deepEqual(recorder.calls, [
      `eq created_by ${ME}`,
      `gte created_at ${since.toISOString()}`,
      'neq task_type quotation_request',
      'not assigned_to is null',
      `neq assigned_to ${ME}`,
    ])
  })
})

// ── Wiring ──────────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

describe('wiring: whose numbers, and what the page waits for', () => {
  const PAGES = [
    ['src/app/tasks/my/completed/page.tsx', 'MY_COMPLETED_PARAMS'],
    ['src/app/tasks/assigned-by-me/completed/page.tsx', 'DELEGATED_COMPLETED_PARAMS'],
  ] as const

  for (const [file, params] of PAGES) {
    test(`${file}: the effective user under View As, unchanged`, () => {
      const code = read(file)
      assert.ok(code.includes("const userId = viewAsUserId ?? signedInUserId ?? ''"))
      assert.ok(code.includes('useCompletionSummary(SCOPE, userId)'))
    })

    test(`${file}: page and filters are URL state with page reset`, () => {
      assert.ok(read(file).includes(`useListUrlState(${params}, { pageKey: 'page' })`))
    })
  }

  test('counts are head-only requests — no rows are downloaded to count them', () => {
    const hook = read('src/hooks/queries/useTaskReports.ts')
    assert.ok(hook.includes(".select('id', { count: 'exact', head: true })"))
    assert.equal(hook.includes('fetchAllRows'), false)
  })

  test('the Dashboard report reads the effective user and never joins the loading gate', () => {
    const dashboard = read('src/app/dashboard/page.tsx')
    assert.ok(dashboard.includes("useTaskCreationReport(permsReady ? currentUserId : '')"))
    const gate = dashboard.slice(dashboard.indexOf('const loading = '), dashboard.indexOf('if (loading) return <LoadingScreen />'))
    assert.equal(gate.includes('creationReport'), false)
  })

  test('a page placeholder never carries one person’s rows into another’s list', () => {
    const hook = read('src/hooks/queries/useCompletedTasks.ts')
    assert.ok(hook.includes('previousQuery?.queryKey[2] === scope && previousQuery?.queryKey[3] === userId ? previous : undefined'))
  })
})

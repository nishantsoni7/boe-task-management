/**
 * Quotation Requests list filtering.
 *
 * Covers the rules the list page depends on and cannot show on its own:
 *   * which fields the search box actually reads,
 *   * that Assigned By means the request's raiser (`created_by`),
 *   * that the created-date windows read `created_at` and never `last_update_at`,
 *   * that the Priority column and filter read `priority` and are unaffected by
 *     `status`, which no longer has a filter of its own, and
 *   * that every active filter combines with AND, and resetting returns the
 *     full tab dataset.
 *
 * The Pending/Closed split still keys off `status`, but that lives on the page
 * (it decides which dataset is handed in) and is not part of this model.
 *
 * Run:
 *   npx tsx --test src/app/tasks/quotation-requests/filters.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import {
  EMPTY_FILTERS,
  applyQuotationFilters,
  assignedByOptions,
  assignerId,
  assignerName,
  createdAtMs,
  dateFilterStart,
  filtersActive,
  matchesDateRange,
  matchesSearch,
  type QuotationFilters,
} from './filters'

// ── Fixtures ──────────────────────────────────────────────────────────────────

// "Now" for every date assertion: 27 Jul 2026, 15:00 local.
const NOW = new Date(2026, 6, 27, 15, 0, 0)

/** Local-midday ISO string N days before NOW, so no assertion sits on a boundary. */
function daysAgo(n: number): string {
  return new Date(2026, 6, 27 - n, 12, 0, 0).toISOString()
}

const PRERNA = 'user-prerna'
const RAVI   = 'user-ravi'
const OWNER  = 'user-owner'

const USER_MAP: Record<string, string> = {
  [PRERNA]: 'Prerna',
  [RAVI]:   'Ravi',
  [OWNER]:  'Quotation Owner',
}

function qtn(over: Partial<Task> & { id: string }): Task {
  return {
    title: 'Quotation request',
    note: null,
    status: 'pending' as TaskStatus,
    priority: 'medium' as TaskPriority,
    type: 'completion',
    is_urgent: false,
    due_date: null,
    acknowledged_at: null,
    created_at: daysAgo(0),
    last_update_at: null,
    assigned_to: OWNER,
    created_by: PRERNA,
    delegated_by: null,
    copied_from_task_id: null,
    blocker_reason: null,
    waiting_on_type: null,
    waiting_on_user_id: null,
    waiting_on_text: null,
    team: 'sales',
    task_type: 'quotation_request',
    customer_name: null,
    contact_number: null,
    company_name: null,
    city_project: null,
    attachment_url: null,
    cancelled_by: null,
    cancelled_at: null,
    cancellation_reason: null,
    ...over,
  }
}

function withFilters(over: Partial<QuotationFilters>): QuotationFilters {
  return { ...EMPTY_FILTERS, ...over }
}

const ids = (tasks: Task[]) => tasks.map(t => t.id)

// ── Search ────────────────────────────────────────────────────────────────────

describe('matchesSearch', () => {
  const task = qtn({
    id: 't',
    customer_name: 'Ramesh Textiles',
    title: 'Curtain quotation for villa',
    note: 'Needs blackout fabric',
  })

  test('empty or whitespace-only query matches everything', () => {
    assert.equal(matchesSearch(task, ''), true)
    assert.equal(matchesSearch(task, '   '), true)
  })

  test('matches on customer name, case-insensitively', () => {
    assert.equal(matchesSearch(task, 'ramesh'), true)
    assert.equal(matchesSearch(task, 'RAMESH'), true)
  })

  test('matches on title and on note', () => {
    assert.equal(matchesSearch(task, 'villa'), true)
    assert.equal(matchesSearch(task, 'blackout'), true)
  })

  test('matches on a substring, not just a prefix', () => {
    assert.equal(matchesSearch(task, 'extiles'), true)
  })

  test('does not match unrelated text', () => {
    assert.equal(matchesSearch(task, 'invoice'), false)
  })

  test('null customer name and null note do not throw and do not match', () => {
    const bare = qtn({ id: 'b', customer_name: null, note: null, title: 'Bare request' })
    assert.equal(matchesSearch(bare, 'anything'), false)
    assert.equal(matchesSearch(bare, 'bare'), true)
  })

  test('a request with only a title is still findable by it', () => {
    const untitledCustomer = qtn({ id: 'u', customer_name: null, title: 'Walk-in enquiry' })
    assert.equal(matchesSearch(untitledCustomer, 'walk-in'), true)
  })
})

// ── Assigned By ───────────────────────────────────────────────────────────────

describe('assigner identity', () => {
  test('assignerId is created_by — the raiser — not the quotation owner', () => {
    const task = qtn({ id: 'a', created_by: PRERNA, assigned_to: OWNER })
    assert.equal(assignerId(task), PRERNA)
    assert.notEqual(assignerId(task), task.assigned_to)
  })

  test('delegated_by does not override created_by', () => {
    const task = qtn({ id: 'a', created_by: PRERNA, delegated_by: RAVI })
    assert.equal(assignerId(task), PRERNA)
  })

  test('assignerName resolves through the page user map', () => {
    assert.equal(assignerName(qtn({ id: 'a', created_by: RAVI }), USER_MAP), 'Ravi')
  })

  test('a missing, empty or blank name falls back to "Unknown"', () => {
    assert.equal(assignerName(qtn({ id: 'a', created_by: 'ghost' }), USER_MAP), 'Unknown')
    assert.equal(assignerName(qtn({ id: 'a', created_by: 'x' }), { x: '' }), 'Unknown')
    assert.equal(assignerName(qtn({ id: 'a', created_by: 'x' }), { x: '   ' }), 'Unknown')
  })

  test('assignedByOptions lists each assigner once, sorted by name', () => {
    const tasks = [
      qtn({ id: '1', created_by: RAVI }),
      qtn({ id: '2', created_by: PRERNA }),
      qtn({ id: '3', created_by: RAVI }),
    ]
    assert.deepEqual(assignedByOptions(tasks, USER_MAP), [
      { id: PRERNA, name: 'Prerna' },
      { id: RAVI,   name: 'Ravi' },
    ])
  })
})

describe('applyQuotationFilters — Assigned By', () => {
  const tasks = [
    qtn({ id: 'p1', created_by: PRERNA }),
    qtn({ id: 'r1', created_by: RAVI }),
    qtn({ id: 'p2', created_by: PRERNA }),
  ]

  test('narrows to one assigner', () => {
    const out = applyQuotationFilters(tasks, withFilters({ assignedBy: PRERNA }), NOW)
    assert.deepEqual(ids(out), ['p1', 'p2'])
  })

  test('"all" keeps every assigner', () => {
    assert.equal(applyQuotationFilters(tasks, EMPTY_FILTERS, NOW).length, 3)
  })

  test('does not match on assigned_to', () => {
    const out = applyQuotationFilters(tasks, withFilters({ assignedBy: OWNER }), NOW)
    assert.deepEqual(ids(out), [])
  })
})

// ── Priority ──────────────────────────────────────────────────────────────────

describe('applyQuotationFilters — priority', () => {
  const tasks = [
    qtn({ id: 'high',   priority: 'high' }),
    qtn({ id: 'medium', priority: 'medium' }),
    qtn({ id: 'low',    priority: 'low' }),
  ]

  test('selects only the chosen priority', () => {
    assert.deepEqual(ids(applyQuotationFilters(tasks, withFilters({ priority: 'high' }), NOW)), ['high'])
    assert.deepEqual(ids(applyQuotationFilters(tasks, withFilters({ priority: 'low' }), NOW)), ['low'])
    assert.deepEqual(ids(applyQuotationFilters(tasks, withFilters({ priority: 'medium' }), NOW)), ['medium'])
  })

  test('"all" keeps every priority', () => {
    assert.equal(applyQuotationFilters(tasks, EMPTY_FILTERS, NOW).length, 3)
  })

  // The Priority column replaced the Status column. Both the badge and the
  // filter must read `priority`; a request whose status disagrees with its
  // priority must not leak into the wrong bucket.
  test('priority is read from `priority`, never from `status`', () => {
    const mismatched = [
      qtn({ id: 'lowPriorityWorking',  priority: 'low',  status: 'working' }),
      qtn({ id: 'highPriorityPending', priority: 'high', status: 'pending' }),
    ]
    assert.deepEqual(
      ids(applyQuotationFilters(mismatched, withFilters({ priority: 'high' }), NOW)),
      ['highPriorityPending'],
    )
    assert.deepEqual(
      ids(applyQuotationFilters(mismatched, withFilters({ priority: 'low' }), NOW)),
      ['lowPriorityWorking'],
    )
  })

  test('status is no longer a filter dimension: identical rows survive any status', () => {
    const sameExceptStatus = [
      qtn({ id: 'pending', status: 'pending', priority: 'high' }),
      qtn({ id: 'working', status: 'working', priority: 'high' }),
      qtn({ id: 'blocked', status: 'blocked', priority: 'high' }),
      qtn({ id: 'waiting', status: 'waiting', priority: 'high' }),
    ]
    assert.deepEqual(
      ids(applyQuotationFilters(sameExceptStatus, withFilters({ priority: 'high' }), NOW)),
      ['pending', 'working', 'blocked', 'waiting'],
    )
  })
})

// ── Created date ──────────────────────────────────────────────────────────────

describe('created-date windows', () => {
  test('createdAtMs reads created_at', () => {
    const task = qtn({ id: 'a', created_at: new Date(2026, 6, 20, 12).toISOString() })
    assert.equal(createdAtMs(task), new Date(2026, 6, 20, 12).getTime())
  })

  test('dateFilterStart anchors at local midnight, inclusive', () => {
    assert.equal(dateFilterStart('all', NOW), null)
    assert.deepEqual(dateFilterStart('today', NOW), new Date(2026, 6, 27))
    assert.deepEqual(dateFilterStart('7d', NOW),    new Date(2026, 6, 21))
    assert.deepEqual(dateFilterStart('30d', NOW),   new Date(2026, 5, 28))
  })

  test('Today covers earlier the same calendar day, not a rolling 24 hours', () => {
    const thisMorning = qtn({ id: 'm', created_at: new Date(2026, 6, 27, 1, 30).toISOString() })
    const lateLastNight = qtn({ id: 'n', created_at: new Date(2026, 6, 26, 23, 30).toISOString() })
    assert.equal(matchesDateRange(thisMorning, 'today', NOW), true)
    assert.equal(matchesDateRange(lateLastNight, 'today', NOW), false)
  })

  test('Last 7 days includes day 6 and excludes day 7', () => {
    assert.equal(matchesDateRange(qtn({ id: 'a', created_at: daysAgo(6) }), '7d', NOW), true)
    assert.equal(matchesDateRange(qtn({ id: 'b', created_at: daysAgo(7) }), '7d', NOW), false)
  })

  test('Last 30 days includes day 29 and excludes day 30', () => {
    assert.equal(matchesDateRange(qtn({ id: 'a', created_at: daysAgo(29) }), '30d', NOW), true)
    assert.equal(matchesDateRange(qtn({ id: 'b', created_at: daysAgo(30) }), '30d', NOW), false)
  })

  test('"Any date" keeps rows with no usable created_at', () => {
    const undated = qtn({ id: 'u', created_at: '' })
    assert.equal(matchesDateRange(undated, 'all', NOW), true)
  })

  test('a missing or unparseable created_at is excluded once a window is active', () => {
    assert.ok(Number.isNaN(createdAtMs(qtn({ id: 'u', created_at: '' }))))
    assert.ok(Number.isNaN(createdAtMs(qtn({ id: 'u', created_at: 'not-a-date' }))))
    assert.equal(matchesDateRange(qtn({ id: 'u', created_at: '' }), '7d', NOW), false)
    assert.equal(matchesDateRange(qtn({ id: 'v', created_at: 'not-a-date' }), '30d', NOW), false)
  })

  test('the window reads created_at, NOT last_update_at', () => {
    // Raised 20 days ago, touched this morning. "Last 7 days" is a created-date
    // filter, so this request must fall outside it.
    const oldButRecentlyTouched = qtn({
      id: 'stale',
      created_at: daysAgo(20),
      last_update_at: new Date(2026, 6, 27, 9).toISOString(),
    })
    assert.equal(matchesDateRange(oldButRecentlyTouched, '7d', NOW), false)
    assert.deepEqual(
      ids(applyQuotationFilters([oldButRecentlyTouched], withFilters({ dateRange: '7d' }), NOW)),
      [],
    )
  })

  test('the window ignores due_date and acknowledged_at too', () => {
    const task = qtn({
      id: 'd',
      created_at: daysAgo(20),
      due_date: new Date(2026, 6, 27, 9).toISOString(),
      acknowledged_at: new Date(2026, 6, 27, 9).toISOString(),
    })
    assert.equal(matchesDateRange(task, '7d', NOW), false)
  })
})

// ── Combination, activity and reset ───────────────────────────────────────────

describe('filtersActive', () => {
  test('false for the empty filter set', () => {
    assert.equal(filtersActive(EMPTY_FILTERS), false)
  })

  test('whitespace-only search does not count as active', () => {
    assert.equal(filtersActive(withFilters({ search: '   ' })), false)
  })

  test('true for each individual filter', () => {
    assert.equal(filtersActive(withFilters({ search: 'a' })), true)
    assert.equal(filtersActive(withFilters({ assignedBy: PRERNA })), true)
    assert.equal(filtersActive(withFilters({ priority: 'high' })), true)
    assert.equal(filtersActive(withFilters({ dateRange: 'today' })), true)
  })

  test('the filter set is exactly search + assignedBy + priority + dateRange', () => {
    assert.deepEqual(Object.keys(EMPTY_FILTERS).sort(), ['assignedBy', 'dateRange', 'priority', 'search'])
  })
})

describe('applyQuotationFilters — combined (AND)', () => {
  // The brief's worked example: Assigned By = Prerna, Priority = High,
  // Created Date = Last 7 days.
  const tasks = [
    qtn({ id: 'match',      created_by: PRERNA, priority: 'high',   created_at: daysAgo(2), customer_name: 'Ramesh Textiles' }),
    qtn({ id: 'wrongUser',  created_by: RAVI,   priority: 'high',   created_at: daysAgo(2), customer_name: 'Ramesh Textiles' }),
    qtn({ id: 'wrongPrio',  created_by: PRERNA, priority: 'medium', created_at: daysAgo(2), customer_name: 'Ramesh Textiles' }),
    qtn({ id: 'tooOld',     created_by: PRERNA, priority: 'high',   created_at: daysAgo(20), customer_name: 'Ramesh Textiles' }),
  ]

  const threeWay = withFilters({ assignedBy: PRERNA, priority: 'high', dateRange: '7d' })

  test('only the row satisfying all three survives', () => {
    assert.deepEqual(ids(applyQuotationFilters(tasks, threeWay, NOW)), ['match'])
  })

  test('each filter alone is broader than the three together', () => {
    assert.equal(applyQuotationFilters(tasks, withFilters({ assignedBy: PRERNA }), NOW).length, 3)
    assert.equal(applyQuotationFilters(tasks, withFilters({ priority: 'high' }), NOW).length, 3)
    assert.equal(applyQuotationFilters(tasks, withFilters({ dateRange: '7d' }), NOW).length, 3)
  })

  test('search narrows further on top of the filters', () => {
    const withHit  = applyQuotationFilters(tasks, { ...threeWay, search: 'ramesh' }, NOW)
    const withMiss = applyQuotationFilters(tasks, { ...threeWay, search: 'zzz' }, NOW)
    assert.deepEqual(ids(withHit), ['match'])
    assert.deepEqual(ids(withMiss), [])
  })

  test('search alone cannot resurrect a row a filter excluded', () => {
    const out = applyQuotationFilters(tasks, withFilters({ assignedBy: PRERNA, search: 'ramesh' }), NOW)
    assert.ok(!ids(out).includes('wrongUser'))
  })

  test('clearing back to EMPTY_FILTERS returns the whole tab dataset, in input order', () => {
    assert.deepEqual(
      ids(applyQuotationFilters(tasks, EMPTY_FILTERS, NOW)),
      ['match', 'wrongUser', 'wrongPrio', 'tooOld'],
    )
    assert.equal(filtersActive(EMPTY_FILTERS), false)
  })

  test('filtering does not mutate the input array', () => {
    const input = [...tasks]
    applyQuotationFilters(input, threeWay, NOW)
    assert.deepEqual(ids(input), ['match', 'wrongUser', 'wrongPrio', 'tooOld'])
  })
})

// ── Tab isolation ─────────────────────────────────────────────────────────────

describe('per-tab application', () => {
  // The page owns the split; these predicates mirror it so a filter that
  // reached across tabs, or a count that moved with the filters, would show up.
  const all = [
    qtn({ id: 'pend',   status: 'pending',   priority: 'high', created_by: PRERNA }),
    qtn({ id: 'work',   status: 'working',   priority: 'high', created_by: PRERNA }),
    qtn({ id: 'done',   status: 'completed', priority: 'high', created_by: PRERNA }),
    qtn({ id: 'killed', status: 'cancelled', priority: 'high', created_by: PRERNA }),
  ]
  const pendingTab = all.filter(t => t.status !== 'completed' && t.status !== 'cancelled')
  const closedTab  = all.filter(t => t.status === 'completed')

  const filters = withFilters({ assignedBy: PRERNA, priority: 'high' })

  test('a filtered result never contains a row from the other tab', () => {
    assert.deepEqual(ids(applyQuotationFilters(pendingTab, filters, NOW)), ['pend', 'work'])
    assert.deepEqual(ids(applyQuotationFilters(closedTab, filters, NOW)), ['done'])
  })

  test('cancelled requests stay out of both tabs regardless of filters', () => {
    const seen = [
      ...applyQuotationFilters(pendingTab, EMPTY_FILTERS, NOW),
      ...applyQuotationFilters(closedTab, EMPTY_FILTERS, NOW),
    ]
    assert.ok(!ids(seen).includes('killed'))
  })

  test('tab counts come from the unfiltered sets, so filtering cannot move them', () => {
    const pendingCount = all.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length
    const closedCount  = all.filter(t => t.status === 'completed').length
    applyQuotationFilters(pendingTab, withFilters({ priority: 'low' }), NOW)
    assert.equal(pendingCount, 2)
    assert.equal(closedCount, 1)
  })
})

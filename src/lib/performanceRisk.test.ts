/**
 * buildDailyRiskSeries / periodAverageScore — behavioural tests
 *
 * The defect these lock down: overdue and stale-blocked counts were measured
 * once (as of now) and copied onto every day of the trend, so a task that went
 * overdue today retroactively penalised the whole week and yesterday's score
 * moved whenever today's portfolio moved.
 *
 * Run:
 *   npx tsx --test src/lib/performanceRisk.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDailyRiskSeries, periodAverageScore,
  computeBreakdown, trendDayFromInputs,
  STALE_BLOCKED_DAYS,
  type RiskTask, type RiskEvent,
} from './performance'
import { istDateRange, istDayStartUtc } from './istDate'
import type { DayInputs } from './types'

const WEEK = istDateRange('2026-07-24', '2026-07-30')

/** An instant at 10:00 IST on the given business date. */
const at = (date: string, hour = 10) =>
  new Date(Date.parse(istDayStartUtc(date)) + hour * 3600_000).toISOString()

function task(over: Partial<RiskTask> & { id: string }): RiskTask {
  return {
    due_date:       null,
    created_at:     at('2026-07-01'),
    status:         'in_progress',
    last_update_at: null,
    ...over,
  }
}

function statusEvent(task_id: string, date: string, from: string | null, to: string): RiskEvent {
  return { task_id, created_at: at(date), action: 'status_changed', from_status: from, to_status: to }
}

const counts = (m: Map<string, { overdueCount: number; staleBlockedCount: number }>, k: 'overdueCount' | 'staleBlockedCount') =>
  WEEK.map(d => m.get(d)![k])

/** Noon on the last day of the window — a fixed "now" so nothing drifts. */
const NOW = new Date(at('2026-07-30', 12))

const riskSeries = (tasks: RiskTask[], events: RiskEvent[] = []) =>
  buildDailyRiskSeries(WEEK, tasks, events, NOW)

// ─── Overdue ──────────────────────────────────────────────────────────────────

describe('overdue is counted per day, not copied from today', () => {
  test('a task counts only on days after its due date', () => {
    const t = task({ id: 't1', due_date: '2026-07-27' })
    const series = riskSeries([t])
    // due 27th → overdue from the 28th onward
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 1, 1, 1])
  })

  test('a task due today is not yet overdue', () => {
    const series = riskSeries([task({ id: 't1', due_date: '2026-07-30' })], [])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('a task with no due date never counts', () => {
    const series = riskSeries([task({ id: 't1', due_date: null })], [])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('a task does not count on days before it existed', () => {
    const t = task({ id: 't1', due_date: '2026-07-20', created_at: at('2026-07-28') })
    const series = riskSeries([t])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 1, 1, 1])
  })

  test('completing a task stops the penalty from that day on', () => {
    const t = task({ id: 't1', due_date: '2026-07-25', status: 'completed' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-28', 'in_progress', 'completed'),
    ])
    // overdue on 26th + 27th, closed on the 28th
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 1, 1, 0, 0, 0])
  })

  test('cancelling a task also stops the penalty', () => {
    const t = task({ id: 't1', due_date: '2026-07-25', status: 'cancelled' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-27', 'in_progress', 'cancelled'),
    ])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 1, 0, 0, 0, 0])
  })

  test('a task closed before the window never counts', () => {
    const t = task({ id: 't1', due_date: '2026-07-01', status: 'completed' })
    const series = riskSeries([t])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('several overdue tasks accumulate on the same day', () => {
    const series = riskSeries([
      task({ id: 'a', due_date: '2026-07-27' }),
      task({ id: 'b', due_date: '2026-07-28' }),
      task({ id: 'c', due_date: '2026-07-29' }),
    ], [])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 1, 2, 3])
  })
})

// ─── Pending-approval fairness ─────────────────────────────────────────────────
//
// A task the assignee has submitted for approval must stop accruing overdue
// against them, even though it is still open (not completed/cancelled) and
// still past its due date — the outstanding action is a review, not work,
// and belongs to the creator. See accruesAssigneeOverdue() in
// lib/tasks/reviewTransitions.ts, the single source of truth this reuses.

describe('a task submitted for approval does not accrue assignee overdue', () => {
  test('overdue, then submitted for approval before the due date: no overdue at all', () => {
    // Due the 27th; submitted on the 26th, still awaiting approval at week end.
    const t = task({ id: 't1', due_date: '2026-07-27', status: 'pending_approval' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-26', 'working', 'pending_approval'),
    ])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('overdue before submission, zero from the day it is submitted onward', () => {
    // Due the 25th; nothing happens until the employee submits on the 27th.
    const t = task({ id: 't1', due_date: '2026-07-25', status: 'pending_approval' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-27', 'working', 'pending_approval'),
    ])
    // Overdue on the 26th (before submission); clear from the 27th on.
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 1, 0, 0, 0, 0])
  })

  test('staying unapproved for the whole window never accrues, however overdue the due date', () => {
    // Due well before the window; submitted before the window too, so every
    // reconstructed day sees status = pending_approval already in force.
    const t = task({ id: 't1', due_date: '2026-07-15', status: 'pending_approval' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-20', 'working', 'pending_approval'),
    ])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('a reviewer approving days later does not retroactively penalise the assignee', () => {
    // Due the 24th (before the window); submitted the 27th, three days late;
    // approved the 30th, the last day of the window — a multi-day review delay.
    const t = task({ id: 't1', due_date: '2026-07-24', status: 'completed' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-27', 'working', 'pending_approval'),
      statusEvent('t1', '2026-07-30', 'pending_approval', 'completed'),
    ])
    // Overdue the 25th-26th, before submission; zero from submission on —
    // including the three days (27th-29th) the reviewer sat on it.
    assert.deepEqual(counts(series, 'overdueCount'), [0, 1, 1, 0, 0, 0, 0])
  })

  test('rejection returns responsibility to the assignee and overdue resumes', () => {
    // Due before the window; submitted the 26th; the reviewer returns it
    // (rejects) on the 29th; still unresolved through the end of the window.
    const t = task({ id: 't1', due_date: '2026-07-21', status: 'working' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-26', 'working', 'pending_approval'),
      statusEvent('t1', '2026-07-29', 'pending_approval', 'working'),
    ])
    // Overdue the 24th-25th (pre-submission), clear the 26th-28th (awaiting
    // review), overdue again from the 29th once responsibility returns.
    assert.deepEqual(counts(series, 'overdueCount'), [1, 1, 0, 0, 0, 1, 1])
  })

  test('a high-priority task awaiting approval still contributes 0 to overdueCount', () => {
    // Priority is not modelled in RiskTask/overdueCount itself — this asserts the
    // status exemption alone is what zeroes it, independent of priority.
    // Due well before the window; submitted on the 26th.
    const t = task({ id: 't1', due_date: '2026-07-18', status: 'pending_approval' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-26', 'working', 'pending_approval'),
    ])
    // Overdue the 24th-25th (pre-submission); exempt from the 26th on, however
    // many days it then sits awaiting approval.
    assert.deepEqual(counts(series, 'overdueCount'), [1, 1, 0, 0, 0, 0, 0])
  })

  test('mixture: only the genuinely overdue task counts, pending-approval ones do not', () => {
    const genuinelyOverdue = task({ id: 'real', due_date: '2026-07-20', status: 'working' })
    const awaiting1 = task({ id: 'p1', due_date: '2026-07-20', status: 'pending_approval' })
    const awaiting2 = task({ id: 'p2', due_date: '2026-07-22', status: 'pending_approval' })
    const series = riskSeries([genuinelyOverdue, awaiting1, awaiting2], [
      statusEvent('p1', '2026-07-24', 'working', 'pending_approval'),
      statusEvent('p2', '2026-07-24', 'working', 'pending_approval'),
    ])
    // p1/p2 are already pending_approval as of day-end on the 24th (the first
    // day in this window), so they contribute 0 every day; `real` was never
    // submitted and keeps accruing throughout. Only `real` shows up, all week.
    assert.deepEqual(counts(series, 'overdueCount'), [1, 1, 1, 1, 1, 1, 1])
  })
})

// ─── Deadline revisions ───────────────────────────────────────────────────────

describe('the deadline that actually applied on each day', () => {
  const dueChange = (task_id: string, date: string, from: string | null, to: string | null): RiskEvent => ({
    task_id, created_at: at(date), action: 'due_date_changed',
    from_status: null, to_status: null, old_val: from, new_val: to,
  })

  test('extending a deadline does not erase the days already overdue', () => {
    // Due the 25th; on the 29th it was pushed to the 31st.
    const t = task({ id: 't1', due_date: '2026-07-31' })
    const series = riskSeries([t], [dueChange('t1', '2026-07-29', '2026-07-25', '2026-07-31')])
    // Overdue 26th–28th under the original deadline; clear from the 29th.
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 1, 1, 1, 0, 0])
  })

  test('without the revision the same task would look clean all week', () => {
    const t = task({ id: 't1', due_date: '2026-07-31' })
    assert.deepEqual(counts(riskSeries([t]), 'overdueCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('pulling a deadline forward makes the later days overdue', () => {
    const t = task({ id: 't1', due_date: '2026-07-25' })
    const series = riskSeries([t], [dueChange('t1', '2026-07-28', '2026-08-30', '2026-07-25')])
    // Far-future deadline until the 28th, then the 25th applies.
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 1, 1, 1])
  })

  test('a deadline added to a task that had none starts the clock at the edit', () => {
    const t = task({ id: 't1', due_date: '2026-07-26' })
    const series = riskSeries([t], [dueChange('t1', '2026-07-29', null, '2026-07-26')])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 0, 1, 1])
  })

  test('successive revisions each apply to their own stretch of days', () => {
    const t = task({ id: 't1', due_date: '2026-08-15' })
    const series = riskSeries([t], [
      dueChange('t1', '2026-07-27', '2026-07-24', '2026-07-28'),
      dueChange('t1', '2026-07-30', '2026-07-28', '2026-08-15'),
    ])
    // Each day is judged by the deadline in force at its end: the 24th deadline
    // covers the 25th–26th, the revision on the 27th already relieves that day,
    // the 28th deadline then bites on the 29th, and the 30th's revision clears it.
    assert.deepEqual(counts(series, 'overdueCount'), [0, 1, 1, 0, 0, 1, 0])
  })
})

// ─── Reopening and waiting ────────────────────────────────────────────────────

describe('reopened and waiting tasks', () => {
  test('reopening a completed task restarts its overdue risk', () => {
    const t = task({ id: 't1', due_date: '2026-07-25', status: 'in_progress' })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-26', 'in_progress', 'completed'),
      statusEvent('t1', '2026-07-29', 'completed',   'in_progress'),
    ])
    // Closed from the 26th, open again from the 29th.
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 0, 0, 0, 1, 1])
  })

  test('a task completed and reopened on the same day ends that day open', () => {
    const t = task({ id: 't1', due_date: '2026-07-25', status: 'in_progress' })
    const series = riskSeries([t], [
      { task_id: 't1', created_at: at('2026-07-28', 10), action: 'status_changed', from_status: 'in_progress', to_status: 'completed', old_val: null, new_val: null },
      { task_id: 't1', created_at: at('2026-07-28', 16), action: 'status_changed', from_status: 'completed', to_status: 'in_progress', old_val: null, new_val: null },
    ])
    assert.deepEqual(counts(series, 'overdueCount'), [0, 0, 1, 1, 1, 1, 1])
  })

  test('a waiting task is overdue but never stale-blocked', () => {
    const t = task({ id: 't1', due_date: '2026-07-25', status: 'waiting', last_update_at: at('2026-07-24') })
    const series = riskSeries([t], [statusEvent('t1', '2026-07-24', 'in_progress', 'waiting')])
    assert.deepEqual(counts(series, 'overdueCount'),      [0, 0, 1, 1, 1, 1, 1])
    assert.deepEqual(counts(series, 'staleBlockedCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('moving from blocked to waiting clears the stale penalty', () => {
    const t = task({ id: 't1', status: 'waiting', last_update_at: at('2026-07-28') })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-24', 'in_progress', 'blocked'),
      statusEvent('t1', '2026-07-28', 'blocked',     'waiting'),
    ])
    assert.deepEqual(counts(series, 'staleBlockedCount'), [0, 0, 1, 1, 0, 0, 0])
  })
})

// ─── Stale-blocked ────────────────────────────────────────────────────────────

describe('stale-blocked follows the blocked interval', () => {
  test('a task blocked today is not yet stale', () => {
    const t = task({ id: 't1', status: 'blocked', last_update_at: at('2026-07-30') })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-30', 'in_progress', 'blocked'),
    ])
    assert.deepEqual(counts(series, 'staleBlockedCount'), [0, 0, 0, 0, 0, 0, 0])
  })

  test('it turns stale once untouched beyond the threshold', () => {
    const t = task({ id: 't1', status: 'blocked', last_update_at: at('2026-07-26') })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-26', 'in_progress', 'blocked'),
    ])
    // blocked 26th 10:00 → two full days elapse during the 28th
    assert.deepEqual(counts(series, 'staleBlockedCount'), [0, 0, 0, 0, 1, 1, 1])
  })

  test('unblocking clears it', () => {
    const t = task({ id: 't1', status: 'in_progress', last_update_at: at('2026-07-30') })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-24', 'in_progress', 'blocked'),
      statusEvent('t1', '2026-07-30', 'blocked', 'in_progress'),
    ])
    assert.deepEqual(counts(series, 'staleBlockedCount'), [0, 0, 1, 1, 1, 1, 0])
  })

  test('activity on a blocked task resets its staleness', () => {
    const t = task({ id: 't1', status: 'blocked', last_update_at: at('2026-07-29') })
    const series = riskSeries([t], [
      statusEvent('t1', '2026-07-24', 'in_progress', 'blocked'),
      { task_id: 't1', created_at: at('2026-07-29'), action: 'comment_added', from_status: null, to_status: null },
    ])
    // stale 26th–28th, cleared by the comment, not yet stale again
    assert.deepEqual(counts(series, 'staleBlockedCount'), [0, 0, 1, 1, 1, 0, 0])
  })

  test('a task blocked before the window is stale throughout it', () => {
    const t = task({ id: 't1', status: 'blocked', last_update_at: at('2026-07-10') })
    const series = riskSeries([t])
    assert.deepEqual(counts(series, 'staleBlockedCount'), [1, 1, 1, 1, 1, 1, 1])
  })

  test('today is measured at the current time, not at midnight tonight', () => {
    // Blocked 28th 13:00. By 30th 12:00 that is 1d23h — not yet stale. Measuring
    // today at end-of-day would add the remaining 12 hours and wrongly flag it.
    const t = task({ id: 't1', status: 'blocked', last_update_at: at('2026-07-28', 13) })
    const events = [{
      task_id: 't1', created_at: at('2026-07-28', 13),
      action: 'status_changed', from_status: 'in_progress', to_status: 'blocked',
    }]
    assert.deepEqual(counts(riskSeries([t], events), 'staleBlockedCount'), [0, 0, 0, 0, 0, 0, 0])

    // An hour of slippage is enough to tip it over.
    const later = new Date(Date.parse(at('2026-07-30', 14)))
    const tipped = buildDailyRiskSeries(WEEK, [t], events, later)
    assert.equal(tipped.get('2026-07-30')!.staleBlockedCount, 1)
  })

  test('the threshold is the exported constant', () => {
    assert.equal(STALE_BLOCKED_DAYS, 2)
  })
})

// ─── The regression this whole change exists for ─────────────────────────────

describe('history stops moving when today moves', () => {
  test('a task going overdue today leaves earlier days untouched', () => {
    const before = riskSeries([task({ id: 't1', due_date: '2026-08-05' })], [])
    const after  = riskSeries([task({ id: 't1', due_date: '2026-07-29' })], [])

    // Only the last day differs; the rest of the week is unchanged.
    assert.deepEqual(counts(before, 'overdueCount'), [0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual(counts(after,  'overdueCount'), [0, 0, 0, 0, 0, 0, 1])
  })

  test('an idle earlier day scores the same whatever today looks like', () => {
    const idle: DayInputs = {
      completedHigh: 0, completedMedium: 0, completedLow: 0,
      statusUpdates: 0, blockerResolutions: 0,
      hasEodLog: true, wasActiveToday: true, timelyAcks: 0,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 3, blockedCount: 0,
    }
    // Same day, but five tasks are overdue *now*. Under the old model those
    // five were injected into this day too and dragged it to 0.
    const withTodaysRisk: DayInputs = { ...idle, overdueCount: 5 }

    assert.equal(computeBreakdown(idle).total, 17)
    assert.equal(computeBreakdown(withTodaysRisk).total, 0)
  })
})

// ─── Period averaging ─────────────────────────────────────────────────────────

describe('periodAverageScore', () => {
  const day = (date: string, completedHigh: number) => trendDayFromInputs(date, {
    completedHigh, completedMedium: 0, completedLow: 0,
    statusUpdates: 0, blockerResolutions: 0,
    hasEodLog: false, wasActiveToday: completedHigh > 0, timelyAcks: 0,
    overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
  })

  test('dead days pull the average down instead of vanishing', () => {
    const days = [day('2026-07-28', 2), day('2026-07-29', 0), day('2026-07-30', 0)]
    // 49, 0, 0 → 16. Averaging only the day with data would report 49.
    assert.equal(periodAverageScore(days), 16)
    assert.equal(periodAverageScore(days.filter(d => d.score > 0)), 49)
  })

  test('an empty period has no average rather than a zero', () => {
    assert.equal(periodAverageScore([]), null)
  })
})

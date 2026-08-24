/**
 * teamPerformance — behavioural tests
 *
 * These lock down the conclusions the Team Performance page states out loud:
 * who is best, who is weakest, who slipped, who is not using the system, and
 * what the owner should do about it. The owner repeats these statements to
 * people, so every one has to be reproducible from the numbers.
 *
 * The recurring theme: a missing metric must never render as zero. "No dated
 * tasks" and "never on time" are different claims, and only one of them is
 * defensible when the denominator is empty.
 *
 * Run:
 *   npx tsx --test src/lib/teamPerformance.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  onTimeCompletionRate, eodOnTimeRate, activeDayRate, ackOnTimeRate,
  scoreDelta, tasksCreatedTotal,
  classifyMember, buildAttentionItems, buildPositiveItems,
  pickBestPerformer, pickWeakestPerformer, pickMostImproved, pickMostDeclined,
  filterMembers, sortMembers, buildRanking, recommendedAction,
  memberStrengths, memberConcerns,
  meaningfulActiveDays, isMeaningfulAction, classifyEodSubmission,
  STATUS_SEVERITY, SORT_KEYS, EOD_ONTIME_HOUR,
  attributableOverdueTasks, overdueWeightedSeverity,
  type MemberMetrics, type OperationalStatus, type SortKey,
} from './teamPerformance'
import { computeBreakdown } from './performance'
import { emptyAdoption, resolveWorkdayStart } from './performanceAdoption'
import { istDayStartUtc } from './istDate'
import type { DayInputs } from './types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function member(over: Partial<MemberMetrics> & { userId: string; userName: string }): MemberMetrics {
  return {
    team: 'sales', position: null,
    eligibleDays: 20, activeDays: 20, scoredDays: 20, eodOnlyDays: 0,
    prevEligibleDays: 20, prevScoredDays: 20,
    score: 60, prevScore: 60, breakdown: null, scoreSpread: null,
    adoption: emptyAdoption(resolveWorkdayStart('General Shift')),
    tasksCompleted: 5, tasksCompletedOnTime: 5, tasksCompletedLate: 0, tasksWithDueDate: 5,
    tasksCreatedSelf: 2, tasksCreatedDelegated: 1, prevTasksCompleted: 5,
    activeTasks: 4, overdueCount: 0, highPriorityOverdue: 0, oldestOverdueDays: 0,
    staleBlockedCount: 0, waitingCount: 0, blockedCount: 0,
    acksTotal: 4, acksOnTime: 4,
    eodSubmitted: 20, eodOnTime: 20, eodLate: 0, eodMissed: 0, eodStreak: 20,
    statusUpdates: 30,
    ...over,
  }
}

const at = (date: string, hour: number) =>
  new Date(Date.parse(istDayStartUtc(date)) + hour * 3600_000).toISOString()

// ─── Team Performance's current-portfolio overdue count ───────────────────────
//
// team/route.ts computes overdueCount/highPriorityOverdue/oldestOverdueDays
// directly from the current task portfolio (not via buildDailyRiskSeries), so
// it needs its own exemption for a task the assignee has submitted for
// approval — same rule, independent code path. See performanceRisk.test.ts
// for the equivalent historical-reconstruction coverage.

type OverdueFixtureTask = { id: string; due_date: string | null; status: string; priority?: string }

function overdueTask(over: Partial<OverdueFixtureTask> & { id: string }): OverdueFixtureTask {
  return { due_date: null, status: 'working', ...over }
}

describe('attributableOverdueTasks', () => {
  const TODAY = '2026-08-24'

  test('a pending_approval task past due is excluded even though it is still open', () => {
    const tasks = [overdueTask({ id: 't1', due_date: '2026-08-20', status: 'pending_approval' })]
    assert.deepEqual(attributableOverdueTasks(tasks, TODAY), [])
  })

  test('completed and cancelled are excluded the same way', () => {
    const tasks = [
      overdueTask({ id: 't1', due_date: '2026-08-20', status: 'completed' }),
      overdueTask({ id: 't2', due_date: '2026-08-20', status: 'cancelled' }),
    ]
    assert.deepEqual(attributableOverdueTasks(tasks, TODAY), [])
  })

  test('working, waiting and blocked tasks past due remain attributable', () => {
    const tasks = [
      overdueTask({ id: 't1', due_date: '2026-08-20', status: 'working' }),
      overdueTask({ id: 't2', due_date: '2026-08-20', status: 'waiting' }),
      overdueTask({ id: 't3', due_date: '2026-08-20', status: 'blocked' }),
    ]
    assert.equal(attributableOverdueTasks(tasks, TODAY).length, 3)
  })

  test('a task due today is not yet overdue, regardless of status', () => {
    const tasks = [overdueTask({ id: 't1', due_date: TODAY, status: 'working' })]
    assert.deepEqual(attributableOverdueTasks(tasks, TODAY), [])
  })

  test('mixture: one real overdue task plus three pending-approval ones counts as 1', () => {
    const tasks = [
      overdueTask({ id: 'real',  due_date: '2026-08-20', status: 'working' }),
      overdueTask({ id: 'p1',    due_date: '2026-08-18', status: 'pending_approval' }),
      overdueTask({ id: 'p2',    due_date: '2026-08-19', status: 'pending_approval' }),
      overdueTask({ id: 'p3',    due_date: '2026-08-21', status: 'pending_approval' }),
    ]
    const overdue = attributableOverdueTasks(tasks, TODAY)
    assert.deepEqual(overdue.map(t => t.id), ['real'])
  })

  test('three past-due tasks all awaiting approval: 0 attributable overdue', () => {
    const tasks = [
      overdueTask({ id: 'p1', due_date: '2026-08-18', status: 'pending_approval' }),
      overdueTask({ id: 'p2', due_date: '2026-08-19', status: 'pending_approval' }),
      overdueTask({ id: 'p3', due_date: '2026-08-20', status: 'pending_approval' }),
    ]
    assert.deepEqual(attributableOverdueTasks(tasks, TODAY), [])
  })

  test('a high-priority pending_approval task is not high-priority overdue', () => {
    const tasks = [overdueTask({ id: 't1', due_date: '2026-08-18', status: 'pending_approval', priority: 'high' })]
    const overdue = attributableOverdueTasks(tasks, TODAY)
    assert.equal(overdue.filter(t => t.priority === 'high').length, 0)
  })

  test('a pending_approval task does not extend oldestOverdueDays', () => {
    const oldestOverdueDays = (tasks: OverdueFixtureTask[]) =>
      attributableOverdueTasks(tasks, TODAY).reduce((max, t) => {
        const days = Math.floor((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse(`${t.due_date}T00:00:00Z`)) / 86_400_000)
        return days > max ? days : max
      }, 0)

    const withoutPendingApproval = oldestOverdueDays([
      overdueTask({ id: 'real', due_date: '2026-08-20', status: 'working' }),
    ])
    const withOldPendingApproval = oldestOverdueDays([
      overdueTask({ id: 'real', due_date: '2026-08-20', status: 'working' }),
      overdueTask({ id: 'ancient', due_date: '2026-07-01', status: 'pending_approval' }),
    ])
    assert.equal(withoutPendingApproval, withOldPendingApproval)
  })

  test('overdueWeightedSeverity reads 0 when every overdue task is pending_approval', () => {
    const m = member({
      userId: 'u1', userName: 'A',
      overdueCount: 0, highPriorityOverdue: 0, oldestOverdueDays: 0,
    })
    assert.equal(overdueWeightedSeverity(m), 0)
  })
})

// ─── Rates never fake a zero ──────────────────────────────────────────────────

describe('derived rates', () => {
  test('an empty denominator gives null, not 0%', () => {
    const m = member({ userId: 'a', userName: 'A', tasksWithDueDate: 0, tasksCompletedOnTime: 0 })
    assert.equal(onTimeCompletionRate(m), null)
    assert.equal(eodOnTimeRate(member({ userId: 'b', userName: 'B', eodOnTime: 0, eodLate: 0, eodMissed: 0 })), null)
    assert.equal(activeDayRate(member({ userId: 'c', userName: 'C', eligibleDays: 0 })), null)
    assert.equal(ackOnTimeRate(member({ userId: 'd', userName: 'D', acksTotal: 0 })), null)
  })

  test('genuine zero is still zero', () => {
    const m = member({ userId: 'a', userName: 'A', tasksWithDueDate: 4, tasksCompletedOnTime: 0, tasksCompletedLate: 4 })
    assert.equal(onTimeCompletionRate(m), 0)
  })

  test('rates round to whole percentages', () => {
    const m = member({ userId: 'a', userName: 'A', tasksWithDueDate: 3, tasksCompletedOnTime: 2 })
    assert.equal(onTimeCompletionRate(m), 67)
  })

  test('score delta needs both periods', () => {
    assert.equal(scoreDelta(member({ userId: 'a', userName: 'A', score: 70, prevScore: 55 })), 15)
    assert.equal(scoreDelta(member({ userId: 'b', userName: 'B', score: 70, prevScore: null })), null)
    assert.equal(scoreDelta(member({ userId: 'c', userName: 'C', score: null, prevScore: 55 })), null)
  })

  test('task creation splits self from delegated', () => {
    const m = member({ userId: 'a', userName: 'A', tasksCreatedSelf: 4, tasksCreatedDelegated: 3 })
    assert.equal(tasksCreatedTotal(m), 7)
  })
})

// ─── Meaningful activity ──────────────────────────────────────────────────────

describe('meaningful activity', () => {
  test('login is not in the vocabulary at all', () => {
    assert.equal(isMeaningfulAction('login'), false)
    assert.equal(isMeaningfulAction('viewed'), false)
    assert.equal(isMeaningfulAction('status_changed'), true)
    assert.equal(isMeaningfulAction('note_added'), true)
  })

  test('counts distinct eligible days, not events', () => {
    const events = [
      { action: 'status_changed', created_at: at('2026-07-27', 10) },
      { action: 'note_added',     created_at: at('2026-07-27', 14) },
      { action: 'status_changed', created_at: at('2026-07-28', 11) },
    ]
    const r = meaningfulActiveDays(['2026-07-27', '2026-07-28', '2026-07-29'], events, new Set())
    assert.equal(r.activeDays, 2)
  })

  test('activity on a non-eligible day does not count', () => {
    const events = [{ action: 'status_changed', created_at: at('2026-07-26', 10) }]  // Sunday
    const r = meaningfulActiveDays(['2026-07-27'], events, new Set())
    assert.equal(r.activeDays, 0)
  })

  test('an EOD alone makes the day active but is flagged as EOD-only', () => {
    const r = meaningfulActiveDays(['2026-07-27', '2026-07-28'], [], new Set(['2026-07-27']))
    assert.equal(r.activeDays, 1)
    assert.equal(r.eodOnlyDays, 1)
  })

  test('an EOD alongside task work is not EOD-only', () => {
    const events = [{ action: 'status_changed', created_at: at('2026-07-27', 10) }]
    const r = meaningfulActiveDays(['2026-07-27'], events, new Set(['2026-07-27']))
    assert.equal(r.activeDays, 1)
    assert.equal(r.eodOnlyDays, 0)
  })
})

// ─── EOD timing ───────────────────────────────────────────────────────────────

describe('EOD submission timing', () => {
  test('submitted before the cutoff is on time', () => {
    assert.equal(classifyEodSubmission('2026-07-28', at('2026-07-28', 18), true), 'on_time')
    assert.equal(classifyEodSubmission('2026-07-28', at('2026-07-28', EOD_ONTIME_HOUR), true), 'on_time')
  })

  test('submitted after the cutoff is late', () => {
    assert.equal(classifyEodSubmission('2026-07-28', at('2026-07-28', 23), true), 'late')
  })

  test('filed the next morning for yesterday is late, not on time', () => {
    assert.equal(classifyEodSubmission('2026-07-28', at('2026-07-29', 9), true), 'late')
  })

  test('nothing filed is missed once the day is over, pending before that', () => {
    assert.equal(classifyEodSubmission('2026-07-28', null, true),  'missed')
    assert.equal(classifyEodSubmission('2026-07-30', null, false), 'pending')
  })
})

// ─── Classification ───────────────────────────────────────────────────────────

describe('classification', () => {
  test('no eligible days is insufficient data, not a zero score', () => {
    const c = classifyMember(member({ userId: 'a', userName: 'A', eligibleDays: 0, scoredDays: 0, score: null }))
    assert.equal(c.status, 'insufficient_data')
  })

  test('one or two scored days is not enough for a verdict', () => {
    const c = classifyMember(member({ userId: 'a', userName: 'A', eligibleDays: 2, activeDays: 2, scoredDays: 2, score: 65 }))
    assert.equal(c.status, 'insufficient_data')
    assert.match(c.reason, /2 scored days/)
  })

  test('low activity outranks a good score on the few days worked', () => {
    // 5 of 20 days active, but those days scored 85. The finding is the absence.
    const c = classifyMember(member({
      userId: 'a', userName: 'A', eligibleDays: 20, activeDays: 5, scoredDays: 20, score: 85,
    }))
    assert.equal(c.status, 'low_activity')
    assert.match(c.reason, /5 of 20/)
  })

  test('a large drop is declining, with the figure in the reason', () => {
    const c = classifyMember(member({ userId: 'a', userName: 'A', score: 50, prevScore: 72 }))
    assert.equal(c.status, 'declining')
    assert.match(c.reason, /22 points/)
  })

  test('a large rise is improving', () => {
    const c = classifyMember(member({ userId: 'a', userName: 'A', score: 72, prevScore: 55 }))
    assert.equal(c.status, 'improving')
    assert.match(c.reason, /Up 17 points/)
  })

  test('a wide spread is inconsistent for a mid-range performer', () => {
    // Score 50: above critical, below "performing well", flat versus last period —
    // so the spread is the only thing left to say.
    const c = classifyMember(member({ userId: 'a', userName: 'A', score: 50, prevScore: 50, scoreSpread: 40 }))
    assert.equal(c.status, 'inconsistent')
    assert.match(c.reason, /varied by 40 points across active days/)
  })

  test('a wide spread does NOT mask a strong score or a real improvement', () => {
    // Regression from real-data review: checking the spread first labelled 7 of 10
    // employees "Inconsistent", including the top performer and the most improved.
    // "Inconsistent" is a weaker claim and must not pre-empt a stronger one.
    assert.equal(classifyMember(member({
      userId: 'a', userName: 'A', score: 76, prevScore: 71, scoreSpread: 86,
    })).status, 'strong')

    assert.equal(classifyMember(member({
      userId: 'b', userName: 'B', score: 57, prevScore: 21, scoreSpread: 80,
    })).status, 'improving')

    assert.equal(classifyMember(member({
      userId: 'c', userName: 'C', score: 53, prevScore: 67, scoreSpread: 80,
    })).status, 'declining')

    assert.equal(classifyMember(member({
      userId: 'd', userName: 'D', score: 62, prevScore: 60, scoreSpread: 90,
    })).status, 'performing_well')
  })

  test('a very low score is critical', () => {
    const c = classifyMember(member({ userId: 'a', userName: 'A', score: 22, prevScore: 24 }))
    assert.equal(c.status, 'critical_attention')
  })

  test('high and steady is strong; middling and steady is stable', () => {
    assert.equal(classifyMember(member({ userId: 'a', userName: 'A', score: 78, prevScore: 76, scoreSpread: 5 })).status, 'strong')
    assert.equal(classifyMember(member({ userId: 'b', userName: 'B', score: 62, prevScore: 61, scoreSpread: 5 })).status, 'performing_well')
    assert.equal(classifyMember(member({ userId: 'c', userName: 'C', score: 48, prevScore: 47, scoreSpread: 5 })).status, 'stable')
  })

  test('nobody is labelled just "average"', () => {
    const statuses = new Set<OperationalStatus>()
    for (const score of [10, 25, 35, 45, 55, 65, 75, 90]) {
      statuses.add(classifyMember(member({ userId: 'a', userName: 'A', score, prevScore: score, scoreSpread: 5 })).status)
    }
    assert.equal([...statuses].some(s => (s as string) === 'average'), false)
  })
})

// ─── Superlatives ─────────────────────────────────────────────────────────────

describe('superlatives', () => {
  const team = [
    member({ userId: 'a', userName: 'Asha',  score: 82, prevScore: 60 }),
    member({ userId: 'b', userName: 'Bilal', score: 55, prevScore: 78 }),
    member({ userId: 'c', userName: 'Chitra', score: 40, prevScore: 42 }),
  ]

  test('best performer is the highest score', () => {
    assert.equal(pickBestPerformer(team)!.userName, 'Asha')
  })

  test('weakest performer is the lowest score', () => {
    assert.equal(pickWeakestPerformer(team)!.userName, 'Chitra')
  })

  test('most improved is the biggest rise, not the highest score', () => {
    assert.equal(pickMostImproved(team)!.userName, 'Asha')   // +22
  })

  test('most declined is the biggest fall', () => {
    assert.equal(pickMostDeclined(team)!.userName, 'Bilal')  // -23
  })

  test('nobody is named from a single measured day', () => {
    const thin = [member({ userId: 'x', userName: 'X', scoredDays: 1, score: 99 })]
    assert.equal(pickBestPerformer(thin), null)
    assert.equal(pickWeakestPerformer(thin), null)
  })

  test('an empty team names nobody rather than crashing', () => {
    assert.equal(pickBestPerformer([]), null)
    assert.equal(pickMostImproved([]), null)
    assert.equal(pickMostDeclined([]), null)
  })

  test('most improved is null when nobody actually improved', () => {
    const flat = [member({ userId: 'a', userName: 'A', score: 50, prevScore: 50 })]
    assert.equal(pickMostImproved(flat), null)
    assert.equal(pickMostDeclined(flat), null)
  })

  test('a member with no previous period cannot be most improved', () => {
    const mixed = [
      member({ userId: 'a', userName: 'A', score: 90, prevScore: null }),
      member({ userId: 'b', userName: 'B', score: 60, prevScore: 55 }),
    ]
    assert.equal(pickMostImproved(mixed)!.userName, 'B')
  })
})

// ─── Attention briefing ───────────────────────────────────────────────────────

describe('attention items', () => {
  test('a clean team produces no items', () => {
    assert.deepEqual(buildAttentionItems([member({ userId: 'a', userName: 'A' })]), [])
  })

  test('a high-priority overdue task outranks a late EOD', () => {
    const items = buildAttentionItems([
      member({ userId: 'a', userName: 'Late', eodLate: 3 }),
      member({ userId: 'b', userName: 'Overdue', highPriorityOverdue: 2, overdueCount: 2, oldestOverdueDays: 6 }),
    ])
    assert.equal(items[0].userName, 'Overdue')
    assert.equal(items[0].severity, 'critical')
  })

  test('every item carries a number, never a bare adjective', () => {
    const items = buildAttentionItems([
      member({ userId: 'a', userName: 'A', overdueCount: 5, oldestOverdueDays: 4, highPriorityOverdue: 1 }),
      member({ userId: 'b', userName: 'B', eligibleDays: 20, activeDays: 4 }),
      member({ userId: 'c', userName: 'C', eodMissed: 4 }),
    ])
    assert.ok(items.length > 0)
    for (const i of items) {
      assert.match(i.evidence, /\d/, `evidence lacks a figure: ${i.evidence}`)
      assert.ok(i.action.length > 0)
      assert.ok(i.userName.length > 0)
    }
  })

  test('one item per person, so five names appear rather than one name five times', () => {
    const messy = member({
      userId: 'a', userName: 'A',
      overdueCount: 9, oldestOverdueDays: 12, highPriorityOverdue: 3,
      eodMissed: 5, eodLate: 4, staleBlockedCount: 4,
      eligibleDays: 20, activeDays: 2, score: 20, prevScore: 70,
    })
    const items = buildAttentionItems([messy])
    assert.equal(items.length, 1)
  })

  test('at most five items', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      member({ userId: `u${i}`, userName: `U${i}`, overdueCount: 5 + i, oldestOverdueDays: 3 + i }))
    assert.equal(buildAttentionItems(many).length, 5)
  })

  test('an EOD filed with no task activity is surfaced', () => {
    const items = buildAttentionItems([member({ userId: 'a', userName: 'A', eodOnlyDays: 4 })])
    assert.equal(items[0].issue, 'EOD filed without task activity')
    assert.match(items[0].evidence, /4 days/)
  })

  test('low activity is only claimed once there are enough eligible days', () => {
    const early = member({ userId: 'a', userName: 'A', eligibleDays: 2, activeDays: 0, scoredDays: 2 })
    assert.equal(buildAttentionItems([early]).some(i => i.issue === 'Not using Task Management'), false)
  })
})

// ─── Positives ────────────────────────────────────────────────────────────────

describe('positive items', () => {
  test('an unremarkable team gets no praise invented for it', () => {
    const plain = member({
      userId: 'a', userName: 'A', score: 50, prevScore: 50,
      tasksWithDueDate: 1, tasksCompletedOnTime: 1, tasksCompleted: 1,
      eodStreak: 1, eodOnTime: 1, eodLate: 0, eodMissed: 0,
      eligibleDays: 2, activeDays: 2, scoredDays: 2, activeTasks: 1,
    })
    assert.deepEqual(buildPositiveItems([plain]), [])
  })

  test('every positive carries a figure', () => {
    const strong = member({
      userId: 'a', userName: 'A', score: 85, prevScore: 60,
      tasksWithDueDate: 8, tasksCompletedOnTime: 8, tasksCompleted: 8,
    })
    const items = buildPositiveItems([strong])
    assert.ok(items.length > 0)
    for (const i of items) assert.match(i.evidence, /\d/)
  })

  test('one entry per person', () => {
    const strong = member({
      userId: 'a', userName: 'A', score: 92, prevScore: 60,
      tasksWithDueDate: 9, tasksCompletedOnTime: 9, tasksCompleted: 9, eodStreak: 12,
    })
    assert.equal(buildPositiveItems([strong]).length, 1)
  })
})

// ─── Filtering, searching, sorting ────────────────────────────────────────────

describe('filtering and searching', () => {
  const team = [
    member({ userId: 'a', userName: 'Asha Rao',  team: 'sales' }),
    member({ userId: 'b', userName: 'Bilal Khan', team: 'operations', position: 'Coordinator' }),
    member({ userId: 'c', userName: 'Chitra Devi', team: 'sales' }),
  ]

  test('department filter narrows to that team', () => {
    assert.deepEqual(filterMembers(team, { team: 'sales' }).map(m => m.userId), ['a', 'c'])
  })

  test('search matches name, case-insensitively', () => {
    assert.deepEqual(filterMembers(team, { search: 'bilal' }).map(m => m.userId), ['b'])
    assert.deepEqual(filterMembers(team, { search: 'ASHA' }).map(m => m.userId), ['a'])
  })

  test('search also matches department and position', () => {
    assert.deepEqual(filterMembers(team, { search: 'operations' }).map(m => m.userId), ['b'])
    assert.deepEqual(filterMembers(team, { search: 'coordinator' }).map(m => m.userId), ['b'])
  })

  test('filters combine', () => {
    assert.deepEqual(filterMembers(team, { team: 'sales', search: 'chitra' }).map(m => m.userId), ['c'])
  })

  test('an empty search returns everyone', () => {
    assert.equal(filterMembers(team, { search: '   ' }).length, 3)
  })
})

describe('sorting', () => {
  // `sortMembers` no longer takes a status resolver: 'needs_attention' delegates to
  // the shared severity model instead of STATUS_SEVERITY, so the table and the
  // attention card cannot order people differently.
  const team = [
    member({ userId: 'strong',  userName: 'Strong',  score: 88, prevScore: 70, tasksCompleted: 3,
             overdueCount: 0, tasksWithDueDate: 4, tasksCompletedOnTime: 4, eodOnTime: 10, eodMissed: 0,
             eligibleDays: 10, activeDays: 10, tasksCreatedSelf: 1, tasksCreatedDelegated: 0 }),
    member({ userId: 'mid',     userName: 'Mid',     score: 60, prevScore: 62, tasksCompleted: 9,
             overdueCount: 2, tasksWithDueDate: 4, tasksCompletedOnTime: 2, eodOnTime: 5, eodMissed: 5,
             eligibleDays: 10, activeDays: 7, tasksCreatedSelf: 6, tasksCreatedDelegated: 2 }),
    member({ userId: 'critical', userName: 'Critical', score: 25, prevScore: 65, tasksCompleted: 1,
             overdueCount: 7, tasksWithDueDate: 4, tasksCompletedOnTime: 0, eodOnTime: 1, eodMissed: 9,
             eligibleDays: 10, activeDays: 3, tasksCreatedSelf: 0, tasksCreatedDelegated: 0 }),
  ]
  const first = (key: SortKey) => sortMembers(team, key)[0].userId

  test('needs attention puts the worst status first', () => assert.equal(first('needs_attention'), 'critical'))
  test('best score',        () => assert.equal(first('best_score'),      'strong'))
  test('lowest score',      () => assert.equal(first('lowest_score'),    'critical'))
  test('most improved',     () => assert.equal(first('most_improved'),   'strong'))
  test('most declined',     () => assert.equal(first('most_declined'),   'critical'))
  test('highest overdue',   () => assert.equal(first('highest_overdue'), 'critical'))
  test('best on-time',      () => assert.equal(first('best_on_time'),    'strong'))
  test('best EOD',          () => assert.equal(first('best_eod'),        'strong'))
  test('least active',      () => assert.equal(first('least_active'),    'critical'))
  test('most completed',    () => assert.equal(first('most_completed'),  'mid'))
  test('most created',      () => assert.equal(first('most_created'),    'mid'))

  test('every sort key is handled and none loses a row', () => {
    for (const key of SORT_KEYS) {
      const out = sortMembers(team, key)
      assert.equal(out.length, team.length, `${key} changed the row count`)
      assert.deepEqual(new Set(out.map(m => m.userId)), new Set(team.map(m => m.userId)))
    }
  })

  test('members with no value sink instead of sorting as zero', () => {
    const withNulls = [
      member({ userId: 'none', userName: 'None', score: null, scoredDays: 0 }),
      member({ userId: 'some', userName: 'Some', score: 30 }),
    ]
    assert.equal(sortMembers(withNulls, 'best_score')[0].userId, 'some')
    assert.equal(sortMembers(withNulls, 'lowest_score')[0].userId, 'some')
  })

  test('sorting does not mutate the input', () => {
    const original = team.map(m => m.userId)
    sortMembers(team, 'best_score')
    assert.deepEqual(team.map(m => m.userId), original)
  })
})

// ─── Rankings ─────────────────────────────────────────────────────────────────

describe('rankings', () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    member({ userId: `u${i}`, userName: `U${i}`, score: 20 + i * 8, prevScore: 50 }))

  test('shows both ends, not just the flattering one', () => {
    const r = buildRanking(many, 'overall')
    assert.equal(r.top.length, 5)
    assert.equal(r.bottom.length, 5)
    assert.equal(r.top[0].userName, 'U8')
    assert.equal(r.bottom[0].userName, 'U0')
  })

  test('a small team shows one list rather than the same names twice', () => {
    const few = many.slice(0, 4)
    const r = buildRanking(few, 'overall')
    assert.equal(r.bottom.length, 0)
    assert.equal(r.top.length, 4)
  })

  test('a metric nobody has data for says so instead of ranking zeros', () => {
    const noDates = [member({ userId: 'a', userName: 'A', tasksWithDueDate: 0, tasksCompletedOnTime: 0 })]
    const r = buildRanking(noDates, 'on_time')
    assert.equal(r.top.length, 0)
    assert.match(r.note ?? '', /Not enough measured data/)
  })

  test('members without the metric are excluded rather than ranked last at zero', () => {
    const mixed = [
      member({ userId: 'a', userName: 'A', tasksWithDueDate: 4, tasksCompletedOnTime: 4 }),
      member({ userId: 'b', userName: 'B', tasksWithDueDate: 0, tasksCompletedOnTime: 0 }),
    ]
    const r = buildRanking(mixed, 'on_time')
    assert.deepEqual(r.top.map(t => t.userName), ['A'])
  })
})

// ─── Recommendations and drill-down text ─────────────────────────────────────

describe('recommended action', () => {
  test('names the specific overdue task situation', () => {
    const m = member({ userId: 'a', userName: 'A', highPriorityOverdue: 1, overdueCount: 1, oldestOverdueDays: 5 })
    // The action now quotes the shared finding's own evidence, so the drawer's
    // recommendation and the briefing's evidence are the same sentence.
    assert.match(recommendedAction(m, 'critical_attention'), /oldest high-priority overdue task/)
    assert.match(recommendedAction(m, 'critical_attention'), /oldest by 5 days/)
  })

  test('calls out system non-use with the day count', () => {
    const m = member({ userId: 'a', userName: 'A', eligibleDays: 20, activeDays: 8 })
    assert.match(recommendedAction(m, 'low_activity'), /12 of 20/)
  })

  test('flags workload when open tasks dwarf completions', () => {
    const m = member({ userId: 'a', userName: 'A', activeTasks: 14, tasksCompleted: 1 })
    assert.match(recommendedAction(m, 'stable'), /workload/i)
  })

  test('says nothing is needed when nothing is wrong', () => {
    assert.match(recommendedAction(member({ userId: 'a', userName: 'A' }), 'strong'), /No action needed/)
  })

  test('admits when there is not enough data to advise', () => {
    const m = member({ userId: 'a', userName: 'A', eligibleDays: 1, activeDays: 1, scoredDays: 1 })
    assert.match(recommendedAction(m, 'insufficient_data'), /Not enough measured days/)
  })
})

describe('drawer strengths and concerns', () => {
  test('concerns quantify every claim', () => {
    const m = member({
      userId: 'a', userName: 'A', overdueCount: 3, oldestOverdueDays: 4,
      highPriorityOverdue: 1, staleBlockedCount: 2, eodMissed: 2, eodLate: 1,
      eligibleDays: 20, activeDays: 5, score: 40, prevScore: 65,
      tasksWithDueDate: 5, tasksCompletedOnTime: 1,
    })
    const concerns = memberConcerns(m)
    assert.ok(concerns.length >= 5)
    for (const c of concerns) assert.match(c, /\d/)
  })

  test('a flawless period yields concerns that are empty, not fabricated', () => {
    assert.deepEqual(memberConcerns(member({ userId: 'a', userName: 'A' })), [])
  })

  test('strengths stay silent when there is nothing to say', () => {
    const weak = member({
      userId: 'a', userName: 'A', score: 30, prevScore: 40,
      tasksWithDueDate: 3, tasksCompletedOnTime: 0, tasksCompleted: 0,
      eodOnTime: 0, eodLate: 3, eodMissed: 4, eodStreak: 0,
      eligibleDays: 10, activeDays: 4, overdueCount: 2, activeTasks: 3, blockedCount: 0,
    })
    assert.deepEqual(memberStrengths(weak), [])
  })
})

// ─── Guardrails ───────────────────────────────────────────────────────────────

describe('guardrails', () => {
  test('status severity orders worst-first and is total', () => {
    const all: OperationalStatus[] = [
      'critical_attention', 'declining', 'low_activity', 'inconsistent',
      'insufficient_data', 'stable', 'improving', 'performing_well', 'strong',
    ]
    const values = all.map(s => STATUS_SEVERITY[s])
    assert.deepEqual(values, [...values].sort((a, b) => a - b))
    assert.equal(new Set(values).size, all.length)
  })

  test('the four score weights are untouched by this redesign', () => {
    const max: DayInputs = {
      completedHigh: 10, completedMedium: 10, completedLow: 10,
      statusUpdates: 10, blockerResolutions: 10,
      hasEodLog: true, wasActiveToday: true, timelyAcks: 10,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
    }
    const b = computeBreakdown(max)
    assert.equal(b.output, 50)
    assert.equal(b.momentum, 20)
    assert.equal(b.discipline, 20)
    assert.equal(computeBreakdown({ ...max, overdueCount: 10, staleBlockedCount: 10 }).risk, -41)
  })
})

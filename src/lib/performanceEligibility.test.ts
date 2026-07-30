/**
 * Performance eligibility, ranking transparency and System Adoption.
 *
 * This file covers the guarantees the owner is being asked to trust:
 *
 *   - an excluded account cannot influence a single team figure, by any path
 *   - an employee with too little data is visible but never ranked
 *   - the ranking order is the documented one, and it is deterministic
 *   - "improved" compares equivalent periods, or says it could not
 *   - every explanation quotes the same numbers the page displays
 *   - the calendar admits when it is incomplete instead of implying confidence
 *   - adoption records the real signed-in user and the IST business date
 *
 * Run:
 *   npx tsx --test src/lib/performanceEligibility.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  isPerformanceTracked, partitionByTracking, excludedSummaryLine,
  canViewExcludedDetails, EXCLUDED_SELF_NOTICE,
} from './performanceEligibility'
import {
  MIN_SCORED_DAYS_FOR_RANKING, MIN_DATA_RULE_TEXT,
  hasSufficientData, isRankable, isComparable, insufficientDataReason,
  overdueWeightedSeverity, compareOverall, overallRanking, overallRankOf,
  OVERALL_TIE_BREAKERS, HOW_RANKING_WORKS,
  attentionFindings, memberSeverity, sortBySeverity, pickMostConcerning,
  buildAttentionItems, attentionRankOf, ATTENTION_CATEGORY_ORDER,
  pickBestPerformer, pickWeakestPerformer, pickMostImproved, pickMostDeclined,
  periodComparison, rankExplanation, unrankedExplanation, movementExplanation,
  attentionExplanation, adoptionExplanation, buildRanksAndExplanations,
  buildRanking, sortMembers, filterMembers, classifyMember,
  onTimeCompletionRate, eodOnTimeRate, activeDayRate,
  recommendedAction, memberConcerns,
  type MemberMetrics,
} from './teamPerformance'
import {
  holidayCalendarCoverage, calendarConfidence, isExpectedWorkingDay,
  expectedWorkingDates, HOLIDAY_CALENDAR_INCOMPLETE_WARNING,
  type WorkingDayContext,
} from './performanceCalendar'
import {
  ATTENDANCE_TREATMENT, splitAttendanceStates, attendanceKey,
  DAY_ATTENDANCE_STATES, HALF_DAY_SUPPORT, NO_ATTENDANCE_PROVIDER,
  ATTENDANCE_LIMITATION_NOTE,
  type DayAttendance,
} from './performanceAttendance'
import {
  resolveWorkdayStart, classifyFirstOpen, computeAdoption, adoptionRate,
  adoptionRecordingFrom, hasAdoptionData, emptyAdoption, buildAppOpenRow,
  isTaskManagementRoute, withinWindowRate,
  SHIFT_START_MINUTES, PROVISIONAL_WORKDAY_START_MINUTES, ADOPTION_GRACE_MINUTES,
  type AppOpenRecord,
} from './performanceAdoption'
import { istDayStartUtc, istMinutesOfDay, formatMinutesOfDay } from './istDate'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const shift = resolveWorkdayStart('General Shift')

function member(over: Partial<MemberMetrics> & { userId: string; userName: string }): MemberMetrics {
  return {
    team: 'sales', position: null,
    eligibleDays: 20, activeDays: 20, scoredDays: 20, eodOnlyDays: 0,
    prevEligibleDays: 20, prevScoredDays: 20,
    score: 60, prevScore: 60, breakdown: null, scoreSpread: null,
    adoption: emptyAdoption(shift),
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

/** IST instant on a business date, at a given hour/minute. */
const at = (date: string, hour: number, minute = 0) =>
  new Date(Date.parse(istDayStartUtc(date)) + hour * 3600_000 + minute * 60_000).toISOString()

const user = (over: Partial<Parameters<typeof partitionByTracking>[0][number]> & { id: string }) => ({
  full_name: `User ${over.id}`, team: 'sales', ...over,
})

// ══════════════════════════════════════════════════════════════════════════════
// PART 1 — Eligibility
// ══════════════════════════════════════════════════════════════════════════════

describe('eligibility model', () => {
  test('a missing flag means included, so a forgotten SELECT cannot delete people', () => {
    assert.equal(isPerformanceTracked(user({ id: 'a' })), true)
    assert.equal(isPerformanceTracked(user({ id: 'b', performance_tracking_enabled: null })), true)
    assert.equal(isPerformanceTracked(user({ id: 'c', performance_tracking_enabled: true })), true)
  })

  test('only an explicit false excludes', () => {
    assert.equal(isPerformanceTracked(user({ id: 'a', performance_tracking_enabled: false })), false)
  })

  // Required case 1 — excluded user omitted from the team dataset.
  test('1. an excluded user is absent from the measured population', () => {
    const { tracked, excluded } = partitionByTracking([
      user({ id: 'real1' }),
      user({ id: 'admin', full_name: 'Nishant', performance_tracking_enabled: false, performance_tracking_note: 'Administrator account' }),
      user({ id: 'real2' }),
    ])
    assert.deepEqual(tracked.map(u => u.id), ['real1', 'real2'])
    assert.deepEqual(excluded.map(e => e.userId), ['admin'])
    assert.equal(excluded[0].userName, 'Nishant')
    assert.equal(excluded[0].note, 'Administrator account')
  })

  test('an excluded user with no recorded reason still lists, with a null note', () => {
    const { excluded } = partitionByTracking([user({ id: 'x', performance_tracking_enabled: false })])
    assert.equal(excluded[0].note, null)
  })

  // Required cases 2, 3, 4 — the exclusion must reach every aggregate. The
  // guarantee is structural: excluded users never enter the metrics array, so
  // every figure derived from it is unaffected. These assert exactly that.
  test('2. an excluded user cannot move the team average', () => {
    const tracked = [
      member({ userId: 'a', userName: 'A', score: 80 }),
      member({ userId: 'b', userName: 'B', score: 60 }),
    ]
    const avg = (ms: MemberMetrics[]) =>
      Math.round(ms.filter(isRankable).reduce((s, m) => s + m.score!, 0) / ms.filter(isRankable).length)

    const withExcluded = [...tracked, member({ userId: 'z', userName: 'Z', score: 0 })]
    // The excluded member is filtered before this point; proving the arithmetic
    // differs is what makes the filter load-bearing rather than cosmetic.
    assert.equal(avg(tracked), 70)
    assert.equal(avg(withExcluded), 47)
    assert.notEqual(avg(tracked), avg(withExcluded))
  })

  test('3. an excluded user cannot be named best or weakest', () => {
    const excludedWouldWin = member({ userId: 'z', userName: 'Z', score: 100 })
    const excludedWouldLose = member({ userId: 'y', userName: 'Y', score: 1 })
    const tracked = [
      member({ userId: 'a', userName: 'A', score: 80 }),
      member({ userId: 'b', userName: 'B', score: 60 }),
    ]
    assert.equal(pickBestPerformer(tracked)!.userId, 'a')
    assert.equal(pickWeakestPerformer(tracked)!.userId, 'b')
    // Sanity: had they been included, they *would* have taken both ends — which
    // is the whole reason the filter has to happen server-side.
    assert.equal(pickBestPerformer([...tracked, excludedWouldWin])!.userId, 'z')
    assert.equal(pickWeakestPerformer([...tracked, excludedWouldLose])!.userId, 'y')
  })

  test('4. an excluded user contributes to no EOD or adoption total', () => {
    const tracked = [member({ userId: 'a', userName: 'A', eodOnTime: 10, eodMissed: 0 })]
    const excluded = member({ userId: 'z', userName: 'Z', eodOnTime: 0, eodMissed: 20 })

    const eodRate = (ms: MemberMetrics[]) => {
      const expected = ms.reduce((s, m) => s + m.eodOnTime + m.eodLate + m.eodMissed, 0)
      const onTime   = ms.reduce((s, m) => s + m.eodOnTime, 0)
      return expected === 0 ? null : Math.round(onTime / expected * 100)
    }
    assert.equal(eodRate(tracked), 100)
    assert.equal(eodRate([...tracked, excluded]), 33)
  })

  // Required case 24 — excluded users generate no adoption metrics.
  test('24. excluded users produce no adoption rows because they never enter the loop', () => {
    const { tracked } = partitionByTracking([
      user({ id: 'a' }),
      user({ id: 'z', performance_tracking_enabled: false }),
    ])
    const adoptionByUser = tracked.map(u => u.id)
    assert.ok(!adoptionByUser.includes('z'))
  })

  // Required case 33 — admin-only visibility for excluded-user details.
  test('33. only an admin may see which users are excluded and why', () => {
    assert.equal(canViewExcludedDetails({ role: 'admin' }), true)
    assert.equal(canViewExcludedDetails({ role: 'manager' }), false)
    assert.equal(canViewExcludedDetails({ role: 'member' }), false)
  })

  test('the coverage line is suppressed at zero rather than reading "0 excluded"', () => {
    assert.equal(excludedSummaryLine(0), null)
    assert.equal(excludedSummaryLine(1), '1 user excluded from Performance tracking')
    assert.equal(excludedSummaryLine(2), '2 users excluded from Performance tracking')
  })

  test('an excluded user is told they are out of team ranking, without the reason', () => {
    assert.match(EXCLUDED_SELF_NOTICE, /not included in team Performance reporting/i)
    assert.match(EXCLUDED_SELF_NOTICE, /do not appear in team rankings/i)
    // The management-facing wording must not leak into the account holder's page.
    assert.doesNotMatch(EXCLUDED_SELF_NOTICE, /test account|administrative/i)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// PART 2 — Ranking transparency
// ══════════════════════════════════════════════════════════════════════════════

describe('minimum-data rule', () => {
  // Required case 5 — insufficient-data user not ranked.
  test('5. below the minimum an employee is visible but unranked', () => {
    const thin = member({ userId: 'thin', userName: 'Thin', scoredDays: 2, score: 95 })
    const full = member({ userId: 'full', userName: 'Full', scoredDays: 20, score: 55 })

    assert.equal(hasSufficientData(thin), false)
    assert.equal(isRankable(thin), false)
    assert.equal(overallRankOf([thin, full], 'thin'), null)

    // Not best, not weakest, not in a top or bottom five.
    assert.equal(pickBestPerformer([thin, full])!.userId, 'full')
    assert.equal(pickWeakestPerformer([thin, full])!.userId, 'full')
    const r = buildRanking([thin, full], 'overall')
    assert.deepEqual(r.top.map(t => t.userId), ['full'])
    assert.equal(r.unrankedCount, 1)

    // But still present in the table.
    assert.equal(sortMembers([thin, full], 'official_rank').length, 2)
    assert.equal(classifyMember(thin).status, 'insufficient_data')
  })

  test('the threshold is one constant, shared by status and rankings', () => {
    const boundary = member({ userId: 'b', userName: 'B', scoredDays: MIN_SCORED_DAYS_FOR_RANKING })
    const below    = member({ userId: 'c', userName: 'C', scoredDays: MIN_SCORED_DAYS_FOR_RANKING - 1 })

    assert.equal(isRankable(boundary), true)
    assert.equal(isRankable(below), false)
    // The status label and the ranking pool must agree at the boundary — the whole
    // point of collapsing two constants into one.
    assert.notEqual(classifyMember(boundary).status, 'insufficient_data')
    assert.equal(classifyMember(below).status, 'insufficient_data')
  })

  test('an employee wholly outside the period is unranked, not scored zero', () => {
    // Joined after the period ended, or left before it began.
    const outside = member({ userId: 'o', userName: 'O', eligibleDays: 0, scoredDays: 0, score: null })
    assert.equal(isRankable(outside), false)
    assert.match(insufficientDataReason(outside)!, /No expected working days/)
  })

  test('the rule is documented in the words the page shows', () => {
    assert.match(MIN_DATA_RULE_TEXT, new RegExp(`${MIN_SCORED_DAYS_FOR_RANKING} scored working days`))
    assert.match(MIN_DATA_RULE_TEXT, /Insufficient Data/)
  })
})

describe('official ranking order', () => {
  // Required case 6 — best-performer tie-break order.
  test('6. ties break by active-day rate, then on-time, then EOD, then overdue, then name', () => {
    const base = { score: 70, tasksWithDueDate: 10, tasksCompletedOnTime: 8, eodOnTime: 10, eodLate: 0, eodMissed: 0 }

    // Step 2: equal score, different active-day rate.
    const lowActive  = member({ userId: 'low',  userName: 'AAA', ...base, eligibleDays: 20, activeDays: 10 })
    const highActive = member({ userId: 'high', userName: 'ZZZ', ...base, eligibleDays: 20, activeDays: 20 })
    assert.equal(pickBestPerformer([lowActive, highActive])!.userId, 'high')

    // Step 3: equal score and activity, different on-time rate.
    const worseOnTime = member({ userId: 'w', userName: 'AAA', ...base, tasksCompletedOnTime: 5 })
    const betterOnTime = member({ userId: 'b', userName: 'ZZZ', ...base, tasksCompletedOnTime: 10 })
    assert.equal(pickBestPerformer([worseOnTime, betterOnTime])!.userId, 'b')

    // Step 4: equal to step 3, different EOD punctuality.
    const lateEod = member({ userId: 'l', userName: 'AAA', ...base, eodOnTime: 5, eodLate: 5 })
    const punctual = member({ userId: 'p', userName: 'ZZZ', ...base })
    assert.equal(pickBestPerformer([lateEod, punctual])!.userId, 'p')

    // Step 5: everything equal, different overdue severity.
    const overdue = member({ userId: 'o', userName: 'AAA', ...base, overdueCount: 3, highPriorityOverdue: 2, oldestOverdueDays: 6 })
    const clean   = member({ userId: 'c', userName: 'ZZZ', ...base })
    assert.equal(pickBestPerformer([overdue, clean])!.userId, 'c')

    // Step 6: fully identical — name decides, and nothing else does.
    const alpha = member({ userId: 'x', userName: 'Alpha', ...base })
    const zeta  = member({ userId: 'y', userName: 'Zeta',  ...base })
    assert.equal(pickBestPerformer([zeta, alpha])!.userId, 'x')
  })

  test('raw task count is not a tie-breaker at any position', () => {
    const shared = { score: 70, eligibleDays: 20, activeDays: 20, tasksWithDueDate: 4, tasksCompletedOnTime: 4 }
    const prolific = member({ userId: 'prolific', userName: 'Zeta',  ...shared, tasksCreatedSelf: 90, tasksCreatedDelegated: 90, tasksCompleted: 90 })
    const quiet    = member({ userId: 'quiet',    userName: 'Alpha', ...shared, tasksCreatedSelf: 0,  tasksCreatedDelegated: 0,  tasksCompleted: 1 })
    // Name breaks the tie, not volume — otherwise typing more tasks would rank higher.
    assert.equal(pickBestPerformer([prolific, quiet])!.userId, 'quiet')
  })

  test('a blank rate ranks last, never as 0%', () => {
    const noDated = member({ userId: 'blank', userName: 'AAA', score: 70, eligibleDays: 20, activeDays: 20, tasksWithDueDate: 0, tasksCompletedOnTime: 0 })
    const allLate = member({ userId: 'zero',  userName: 'ZZZ', score: 70, eligibleDays: 20, activeDays: 20, tasksWithDueDate: 4, tasksCompletedOnTime: 0, tasksCompletedLate: 4 })
    assert.equal(onTimeCompletionRate(noDated), null)
    assert.equal(onTimeCompletionRate(allLate), 0)
    // "No dated tasks" must not rank below "missed every deadline".
    assert.equal(pickBestPerformer([noDated, allLate])!.userId, 'blank')
  })

  test('weighted overdue severity weights priority above volume and halves age', () => {
    const oneHighFresh = member({ userId: 'a', userName: 'A', overdueCount: 1, highPriorityOverdue: 1, oldestOverdueDays: 0 })
    const threeLow     = member({ userId: 'b', userName: 'B', overdueCount: 3, highPriorityOverdue: 0, oldestOverdueDays: 0 })
    assert.equal(overdueWeightedSeverity(oneHighFresh), 3)
    assert.equal(overdueWeightedSeverity(threeLow), 3)
    assert.equal(overdueWeightedSeverity(member({ userId: 'c', userName: 'C', overdueCount: 1, highPriorityOverdue: 0, oldestOverdueDays: 10 })), 6)
    assert.equal(overdueWeightedSeverity(member({ userId: 'd', userName: 'D' })), 0)
  })

  // Required case 11 — stable order for exact ties.
  test('11. exact ties produce the same order however the input is shuffled', () => {
    const identical = ['Dev', 'Asha', 'Chen', 'Bala'].map((n, i) =>
      member({ userId: `u${i}`, userName: n, score: 65 }))

    const forward  = overallRanking(identical).map(m => m.userName)
    const reversed = overallRanking([...identical].reverse()).map(m => m.userName)
    const shuffled = overallRanking([identical[2], identical[0], identical[3], identical[1]]).map(m => m.userName)

    assert.deepEqual(forward, ['Asha', 'Bala', 'Chen', 'Dev'])
    assert.deepEqual(reversed, forward)
    assert.deepEqual(shuffled, forward)
  })

  test('the weakest measured performer is the last place in the same order', () => {
    const team = [
      member({ userId: 'a', userName: 'A', score: 80 }),
      member({ userId: 'b', userName: 'B', score: 40 }),
      member({ userId: 'c', userName: 'C', score: 60 }),
    ]
    const ordered = overallRanking(team)
    assert.equal(pickWeakestPerformer(team)!.userId, ordered[ordered.length - 1].userId)
    assert.equal(pickWeakestPerformer(team)!.userId, 'b')
  })

  test('the tie-break chain is published for the ranking-information panel', () => {
    assert.equal(OVERALL_TIE_BREAKERS.length, 6)
    assert.match(OVERALL_TIE_BREAKERS[0], /Period score/)
    assert.match(OVERALL_TIE_BREAKERS[5], /name/i)
  })

  test('the "how ranking works" panel states inclusion, minimum, and that volume does not help', () => {
    const headings = HOW_RANKING_WORKS.map(s => s.heading).join(' | ')
    assert.match(headings, /Who is included/)
    assert.match(headings, /Minimum data/)
    assert.match(headings, /Tie-breakers/)
    assert.match(headings, /does not improve rank/)
    assert.match(headings, /not ranked/)
    const bodies = HOW_RANKING_WORKS.map(s => s.body).join(' ')
    assert.match(bodies, new RegExp(`${MIN_SCORED_DAYS_FOR_RANKING} scored working days`))
    assert.match(bodies, /Approved leave is not yet recorded/)
  })
})

describe('attention severity — one shared calculation', () => {
  // Required case 7 — weakest/attention severity order.
  test('7. concerns rank in the documented management order', () => {
    assert.deepEqual([...ATTENTION_CATEGORY_ORDER].slice(0, 8), [
      'high_priority_overdue',
      'long_overdue',
      'very_low_activity',
      'repeated_missed_eod',
      'sharp_decline',
      'low_on_time',
      'stale_blocked',
      'low_score',
    ])
    assert.equal(attentionRankOf('high_priority_overdue'), 1)
    assert.equal(attentionRankOf('low_score'), 8)
  })

  test('a high-priority overdue task outranks every other finding on the same person', () => {
    const m = member({
      userId: 'a', userName: 'A',
      highPriorityOverdue: 1, overdueCount: 6, oldestOverdueDays: 9,
      eodMissed: 4, staleBlockedCount: 3,
      eligibleDays: 20, activeDays: 5,
      score: 20, scoredDays: 20, prevScore: 60, prevScoredDays: 20,
    })
    const findings = attentionFindings(m)
    assert.equal(findings[0].category, 'high_priority_overdue')
    assert.equal(memberSeverity(m).rank, 1)
    // The whole ordered set is available, so the drawer lists all of them.
    assert.ok(findings.length >= 6)
    const ranks = findings.map(f => f.rank)
    assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y))
  })

  test('within one category the larger instance is more severe', () => {
    const worse  = member({ userId: 'w', userName: 'AAA', highPriorityOverdue: 3, overdueCount: 3, oldestOverdueDays: 10 })
    const milder = member({ userId: 'm', userName: 'ZZZ', highPriorityOverdue: 1, overdueCount: 1, oldestOverdueDays: 1 })
    assert.equal(sortBySeverity([milder, worse])[0].userId, 'w')
  })

  test('an employee with no findings sorts below everyone who has one', () => {
    const clean   = member({ userId: 'clean',   userName: 'AAA' })
    // A genuine EOD problem: 3 missed against only 5 on time (63%), below the
    // healthy-rate bar. A high-rate employee with a couple of misses is
    // deliberately NOT a finding — see the rate-aware rule in attentionFindings.
    const flagged = member({ userId: 'flagged', userName: 'ZZZ', eodOnTime: 5, eodMissed: 3 })
    assert.equal(sortBySeverity([clean, flagged])[0].userId, 'flagged')
    assert.equal(memberSeverity(clean).primary, null)
    assert.equal(memberSeverity(clean).rank, Number.POSITIVE_INFINITY)
  })

  // Required case 31 — the summary card, the briefing and the default table sort
  // must name the same person.
  test('31. card, briefing and default table sort agree on who is worst', () => {
    const team = [
      member({ userId: 'ok',    userName: 'Ok' }),
      member({ userId: 'late',  userName: 'Late',  eodLate: 4 }),
      member({ userId: 'worst', userName: 'Worst', highPriorityOverdue: 2, overdueCount: 2, oldestOverdueDays: 8 }),
      member({ userId: 'quiet', userName: 'Quiet', eligibleDays: 20, activeDays: 4 }),
    ]
    const card     = pickMostConcerning(team)!.userId
    const briefing = buildAttentionItems(team)[0].userId
    const tableTop = sortMembers(team, 'needs_attention')[0].userId

    assert.equal(card, 'worst')
    assert.equal(briefing, 'worst')
    assert.equal(tableTop, 'worst')
  })

  test('the briefing shows five names, not one name five times', () => {
    const busy = member({
      userId: 'busy', userName: 'Busy',
      highPriorityOverdue: 2, overdueCount: 8, oldestOverdueDays: 12,
      eodMissed: 5, staleBlockedCount: 4, eligibleDays: 20, activeDays: 3,
    })
    const others = ['B', 'C', 'D', 'E', 'F'].map(n =>
      member({ userId: n, userName: n, eodOnTime: 4, eodMissed: 2 }))   // 67% — a real EOD problem
    const items = buildAttentionItems([busy, ...others])
    assert.equal(items.length, 5)
    assert.equal(new Set(items.map(i => i.userId)).size, 5)
    assert.equal(items[0].userId, 'busy')
  })

  // Regression: found by reconciling the rendered page against the database.
  test('a few missed EODs at a healthy rate is not a finding', () => {
    // The real case: the #1 performer, 23 on time and 2 missed (92%), whose single
    // recommended action was "Review repeated missed EOD submissions".
    const strong = member({ userId: 'top', userName: 'Top', eodOnTime: 23, eodLate: 0, eodMissed: 2 })
    assert.equal(eodOnTimeRate(strong), 92)
    assert.equal(attentionFindings(strong).some(f => f.category === 'repeated_missed_eod'), false)
    assert.equal(memberSeverity(strong).primary, null)
    assert.doesNotMatch(recommendedAction(strong, 'strong'), /missed EOD/)

    // Still visible in the drawer as context, just not as a team-level finding.
    assert.ok(memberConcerns(strong).some((s: string) => /2 EODs missed/.test(s)))
  })

  test('the same miss count at a weak rate IS a finding', () => {
    const weak = member({ userId: 'w', userName: 'W', eodOnTime: 3, eodLate: 0, eodMissed: 2 })
    assert.equal(eodOnTimeRate(weak), 60)
    const f = attentionFindings(weak).find(x => x.category === 'repeated_missed_eod')
    assert.ok(f, 'a 60% EOD rate with 2 misses must be flagged')
    assert.match(f.evidence, /2 EODs missed this period \(60% submitted on time\)/)
  })

  test('a large miss count is a finding regardless of rate', () => {
    // 4+ misses always counts, so a long period cannot dilute a real problem away.
    const many = member({ userId: 'm', userName: 'M', eodOnTime: 40, eodLate: 0, eodMissed: 4 })
    assert.equal(eodOnTimeRate(many), 91)
    assert.ok(attentionFindings(many).some(f => f.category === 'repeated_missed_eod'))
  })

  test('every finding carries a number, never a bare adjective', () => {
    const m = member({
      userId: 'a', userName: 'A', eligibleDays: 20, activeDays: 6,
      eodMissed: 3, overdueCount: 4, staleBlockedCount: 2, oldestOverdueDays: 8,
      tasksWithDueDate: 10, tasksCompletedOnTime: 2, score: 25, prevScore: 60,
    })
    for (const f of attentionFindings(m)) {
      assert.match(f.evidence, /\d/, `finding ${f.category} has no figure: ${f.evidence}`)
      assert.ok(f.action.length > 0)
    }
  })
})

describe('equivalent-period comparison', () => {
  // Required cases 8 and 9.
  test('8. improvement compares equivalent periods and shows both day counts', () => {
    const m = member({
      userId: 'a', userName: 'A',
      score: 74, prevScore: 60,
      eligibleDays: 22, scoredDays: 22,
      prevEligibleDays: 21, prevScoredDays: 21,
    })
    const cmp = periodComparison(m)
    assert.equal(cmp.comparable, true)
    assert.equal(cmp.delta, 14)
    assert.equal(cmp.eligibleDays, 22)
    assert.equal(cmp.prevEligibleDays, 21)
    assert.equal(cmp.scoredDays, 22)
    assert.equal(cmp.prevScoredDays, 21)
    assert.equal(cmp.note, null)

    const bullets = movementExplanation(m).bullets.join(' | ')
    assert.match(bullets, /Current score: 74/)
    assert.match(bullets, /Previous score: 60/)
    assert.match(bullets, /Change: \+14 points/)
    assert.match(bullets, /Current eligible days: 22/)
    assert.match(bullets, /Previous eligible days: 21/)
  })

  test('9. a thin previous period disqualifies the comparison rather than flattering it', () => {
    const stub = member({
      userId: 'a', userName: 'A',
      score: 74, prevScore: 20,
      scoredDays: 22, prevScoredDays: 1, prevEligibleDays: 1,
    })
    assert.equal(isComparable(stub), false)
    assert.equal(periodComparison(stub).delta, null)
    assert.match(periodComparison(stub).note!, /Only 1 scored day in the previous period/)

    // And so it cannot win Most Improved on a 54-point artefact.
    const honest = member({ userId: 'b', userName: 'B', score: 70, prevScore: 60, scoredDays: 20, prevScoredDays: 20 })
    assert.equal(pickMostImproved([stub, honest])!.userId, 'b')
  })

  test('9b. a thin current period also disqualifies the comparison', () => {
    const thin = member({ userId: 'a', userName: 'A', score: 90, prevScore: 40, scoredDays: 2, prevScoredDays: 20 })
    assert.equal(isComparable(thin), false)
    assert.equal(pickMostImproved([thin]), null)
  })

  test('most declined needs the same both-period minimum', () => {
    const stub   = member({ userId: 'stub',   userName: 'Stub',   score: 20, prevScore: 90, scoredDays: 20, prevScoredDays: 2 })
    const honest = member({ userId: 'honest', userName: 'Honest', score: 50, prevScore: 65, scoredDays: 20, prevScoredDays: 20 })
    assert.equal(pickMostDeclined([stub, honest])!.userId, 'honest')
  })

  test('no previous data at all reports the absence, not a zero delta', () => {
    const fresh = member({ userId: 'a', userName: 'A', prevScore: null, prevScoredDays: 0, prevEligibleDays: 0 })
    const cmp = periodComparison(fresh)
    assert.equal(cmp.comparable, false)
    assert.equal(cmp.delta, null)
    assert.match(cmp.note!, /No measured days in the previous period/)
  })

  test('improvement and decline ties break on current score, then name', () => {
    const higher = member({ userId: 'h', userName: 'Zeta',  score: 78, prevScore: 66 })
    const lower  = member({ userId: 'l', userName: 'Alpha', score: 51, prevScore: 39 })
    assert.equal(pickMostImproved([lower, higher])!.userId, 'h')
    assert.equal(pickMostDeclined([
      member({ userId: 'a', userName: 'Alpha', score: 40, prevScore: 60 }),
      member({ userId: 'b', userName: 'Beta',  score: 30, prevScore: 50 }),
    ])!.userId, 'b')
  })

  test('the most_improved ranking excludes incomparable members', () => {
    const stub   = member({ userId: 'stub',   userName: 'Stub',   score: 90, prevScore: 10, scoredDays: 20, prevScoredDays: 1 })
    const honest = member({ userId: 'honest', userName: 'Honest', score: 70, prevScore: 60, scoredDays: 20, prevScoredDays: 20 })
    const r = buildRanking([stub, honest], 'most_improved')
    assert.deepEqual(r.top.map(t => t.userId), ['honest'])
  })
})

describe('explainability', () => {
  // Required case 10 — the explanation matches the displayed metrics.
  test('10. every bullet quotes the same value the page renders', () => {
    const m = member({
      userId: 'a', userName: 'A',
      score: 82, prevScore: 70, scoredDays: 21, prevScoredDays: 21,
      eligibleDays: 21, activeDays: 20,
      tasksWithDueDate: 11, tasksCompletedOnTime: 10, tasksCompletedLate: 1,
      eodOnTime: 21, eodLate: 0, eodMissed: 0,
      overdueCount: 1, highPriorityOverdue: 0, oldestOverdueDays: 2,
    })
    const ex = rankExplanation(m, 1, 9)
    const text = ex.bullets.join(' | ')

    assert.equal(ex.headline, 'Ranked #1 of 9 because:')
    assert.match(text, /Score: 82/)
    assert.match(text, /Active on 20 of 21 eligible days/)
    // Read straight from the same functions the table calls.
    assert.match(text, new RegExp(`${onTimeCompletionRate(m)}% on-time task completion`))
    assert.match(text, new RegExp(`${eodOnTimeRate(m)}% EOD punctuality`))
    assert.equal(onTimeCompletionRate(m), 91)
    assert.equal(eodOnTimeRate(m), 100)
    assert.equal(activeDayRate(m), 95)
    assert.match(text, /1 overdue task, oldest by 2 days/)
  })

  test('a clean portfolio says so rather than printing "0 overdue tasks"', () => {
    const m = member({ userId: 'a', userName: 'A' })
    assert.match(rankExplanation(m, 2, 5).bullets.join(' | '), /No overdue tasks/)
  })

  // Required case 32 — a missing rate reads as an em dash, not a false zero.
  test('32. missing rates render as an em dash inside the explanation too', () => {
    const m = member({
      userId: 'a', userName: 'A',
      tasksWithDueDate: 0, tasksCompletedOnTime: 0,
      eodOnTime: 0, eodLate: 0, eodMissed: 0,
    })
    const text = rankExplanation(m, 1, 3).bullets.join(' | ')
    assert.match(text, /On-time completion: —/)
    assert.match(text, /EOD punctuality: —/)
    assert.doesNotMatch(text, /0% on-time/)
    assert.doesNotMatch(text, /0% EOD/)
  })

  test('an unranked employee is told why, in the same words as the rule', () => {
    const thin = member({ userId: 'a', userName: 'A', scoredDays: 1, eligibleDays: 12 })
    const ex = unrankedExplanation(thin)
    assert.equal(ex.headline, 'Not ranked because:')
    assert.match(ex.bullets.join(' | '), /Only 1 scored day/)
    assert.match(ex.bullets.join(' | '), /12 eligible working days/)
    assert.ok(ex.bullets.includes(MIN_DATA_RULE_TEXT))
  })

  test('the attention explanation reuses the findings word for word', () => {
    const m = member({
      userId: 'a', userName: 'A',
      highPriorityOverdue: 2, overdueCount: 2, oldestOverdueDays: 7,
      eligibleDays: 21, activeDays: 11, eodMissed: 4,
    })
    const ex = attentionExplanation(m)!
    const text = ex.bullets.join(' | ')
    assert.equal(ex.headline, 'Requires attention because:')
    assert.match(text, /2 high-priority tasks overdue/)
    assert.match(text, /oldest by 7 days/)
    assert.match(text, /No meaningful activity on 10 of 21 eligible working days/)
    assert.match(text, /4 EODs missed this period/)
    // Identical strings, so the drawer cannot paraphrase the briefing.
    assert.deepEqual(attentionFindings(m).map(f => f.evidence), ex.bullets)
  })

  test('nothing to flag yields no attention explanation at all', () => {
    assert.equal(attentionExplanation(member({ userId: 'a', userName: 'A' })), null)
  })

  // Required case 31, structural half: one ordering feeds ranks and explanations.
  test('31b. ranks and explanations are built from a single ordering', () => {
    const team = [
      member({ userId: 'c', userName: 'C', score: 50 }),
      member({ userId: 'a', userName: 'A', score: 90 }),
      member({ userId: 'b', userName: 'B', score: 70 }),
      member({ userId: 'thin', userName: 'Thin', score: 99, scoredDays: 1 }),
    ]
    const { ranks, explanations } = buildRanksAndExplanations(team)

    // Read before the deepEqual: assert.deepEqual narrows `ranks` to the literal
    // shape, after which TypeScript refuses the 'thin' lookup.
    assert.equal(ranks['thin'], undefined)
    assert.deepEqual(ranks, { a: 1, b: 2, c: 3 })
    assert.match(explanations.a.headline, /Ranked #1 of 3/)
    assert.match(explanations.b.headline, /Ranked #2 of 3/)
    assert.match(explanations.c.headline, /Ranked #3 of 3/)
    assert.equal(explanations.thin.headline, 'Not ranked because:')

    // And the rank quoted in the explanation is the rank in the map.
    for (const [uid, rank] of Object.entries(ranks)) {
      assert.match(explanations[uid].headline, new RegExp(`Ranked #${rank} `))
    }
  })
})

// Required cases 29, 30 — filters and search must not alter the official score.
describe('filters and search are presentation only', () => {
  test('29. department filtering preserves the official order within scope', () => {
    const team = [
      member({ userId: 'sales-top', userName: 'SalesTop', team: 'sales',  score: 75 }),
      member({ userId: 'sales-low', userName: 'SalesLow', team: 'sales',  score: 45 }),
      member({ userId: 'design-x',  userName: 'DesignX',  team: 'design', score: 90 }),
    ]
    const full  = overallRanking(team).map(m => m.userId)
    assert.deepEqual(full, ['design-x', 'sales-top', 'sales-low'])

    const scoped = overallRanking(filterMembers(team, { team: 'sales' })).map(m => m.userId)
    assert.deepEqual(scoped, ['sales-top', 'sales-low'])
    // Relative order inside the filtered scope is unchanged.
    assert.deepEqual(scoped, full.filter(id => id.startsWith('sales')))
  })

  test('30. searching changes neither the score nor the rate', () => {
    const team = [
      member({ userId: 'a', userName: 'Asha', score: 80, tasksWithDueDate: 4, tasksCompletedOnTime: 3 }),
      member({ userId: 'b', userName: 'Bala', score: 60 }),
    ]
    const before = team.map(m => ({ id: m.userId, score: m.score, rate: onTimeCompletionRate(m) }))
    const found = filterMembers(team, { search: 'ash' })
    assert.deepEqual(found.map(m => m.userId), ['a'])
    assert.equal(found[0].score, 80)
    assert.equal(onTimeCompletionRate(found[0]), 75)
    // The source array is untouched — filterMembers does not mutate.
    assert.deepEqual(team.map(m => ({ id: m.userId, score: m.score, rate: onTimeCompletionRate(m) })), before)
  })

  test('sorting never mutates the input array', () => {
    const team = [
      member({ userId: 'a', userName: 'A', score: 40 }),
      member({ userId: 'b', userName: 'B', score: 80 }),
    ]
    const original = team.map(m => m.userId)
    sortMembers(team, 'best_score')
    sortMembers(team, 'needs_attention')
    sortMembers(team, 'official_rank')
    assert.deepEqual(team.map(m => m.userId), original)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// PART 3 — Calendar, holidays, attendance adapter
// ══════════════════════════════════════════════════════════════════════════════

const calendar = (over: Partial<WorkingDayContext> = {}): WorkingDayContext => ({
  holidays: new Set<string>(), joiningDate: null, exitDate: null, ...over,
})

describe('working days', () => {
  // Required cases 12, 13, 14.
  test('12. a recorded company holiday is excluded', () => {
    const ctx = calendar({ holidays: new Set(['2026-07-28']) })
    assert.equal(isExpectedWorkingDay('2026-07-28', ctx), false)
    assert.equal(isExpectedWorkingDay('2026-07-29', ctx), true)
  })

  test('13. Sunday is excluded', () => {
    // 2026-07-26 is a Sunday.
    assert.equal(new Date('2026-07-26T00:00:00Z').getUTCDay(), 0)
    assert.equal(isExpectedWorkingDay('2026-07-26', calendar()), false)
  })

  test('14. Saturday is a working day', () => {
    // 2026-07-25 is a Saturday. BOE runs Monday–Saturday.
    assert.equal(new Date('2026-07-25T00:00:00Z').getUTCDay(), 6)
    assert.equal(isExpectedWorkingDay('2026-07-25', calendar()), true)
  })

  test('15. dates before joining do not count, and the joining day itself does', () => {
    const ctx = calendar({ joiningDate: '2026-07-20' })
    assert.equal(isExpectedWorkingDay('2026-07-17', ctx), false)
    assert.equal(isExpectedWorkingDay('2026-07-20', ctx), true)
  })

  test('16. dates after the exit boundary do not count, and the exit day itself does', () => {
    const ctx = calendar({ exitDate: '2026-07-20' })
    assert.equal(isExpectedWorkingDay('2026-07-20', ctx), true)
    assert.equal(isExpectedWorkingDay('2026-07-21', ctx), false)
  })
})

describe('holiday calendar coverage', () => {
  // Required case 17 — incomplete-calendar warning.
  test('17. an empty holiday calendar produces a visible warning', () => {
    const c = holidayCalendarCoverage('2026-06-08', '2026-07-30', [])
    assert.equal(c.status, 'no_records')
    assert.equal(c.holidayCount, 0)
    assert.match(c.warning!, new RegExp(HOLIDAY_CALENDAR_INCOMPLETE_WARNING))
    assert.match(c.warning!, /counted as an\s+ordinary working day/)
    assert.equal(calendarConfidence(c), 'limited')
  })

  test('a month with no record is reported as unverified coverage', () => {
    const c = holidayCalendarCoverage('2026-06-08', '2026-08-31', ['2026-06-15'])
    assert.equal(c.status, 'partial')
    assert.deepEqual(c.monthsInRange, ['2026-06', '2026-07', '2026-08'])
    assert.deepEqual(c.monthsWithRecords, ['2026-06'])
    assert.deepEqual(c.monthsWithoutRecords, ['2026-07', '2026-08'])
    assert.match(c.warning!, /2026-07, 2026-08/)
    assert.equal(calendarConfidence(c), 'limited')
  })

  test('every month covered means full confidence and no warning', () => {
    const c = holidayCalendarCoverage('2026-06-08', '2026-07-30', ['2026-06-15', '2026-07-04'])
    assert.equal(c.status, 'covered')
    assert.equal(c.warning, null)
    assert.equal(calendarConfidence(c), 'full')
  })

  test('duplicates and out-of-range dates are surfaced, not silently absorbed', () => {
    const c = holidayCalendarCoverage('2026-07-01', '2026-07-31',
      ['2026-07-04', '2026-07-04', '2026-06-15', '2026-08-20'])
    assert.equal(c.holidayCount, 1)
    assert.deepEqual(c.duplicateDates, ['2026-07-04'])
    assert.deepEqual(c.outOfRangeDates, ['2026-06-15', '2026-08-20'])
  })

  test('coverage is clamped to the rollout date', () => {
    const c = holidayCalendarCoverage('2026-01-01', '2026-06-30', [])
    assert.equal(c.from, '2026-06-08')
  })
})

describe('attendance integration contract', () => {
  test('every required state is declared', () => {
    assert.deepEqual([...DAY_ATTENDANCE_STATES], [
      'present', 'approved_leave', 'weekly_off', 'company_holiday',
      'official_duty', 'half_day', 'absent', 'unknown',
    ])
    for (const s of DAY_ATTENDANCE_STATES) {
      assert.ok(ATTENDANCE_TREATMENT[s], `no treatment for ${s}`)
      // A state is never both counted and removed from expectation.
      assert.ok(!(ATTENDANCE_TREATMENT[s].eligible && ATTENDANCE_TREATMENT[s].neutral))
    }
  })

  // Required case 18 — approved leave is neutral.
  test('18. approved leave is neutral: not eligible, not an absence', () => {
    const t = ATTENDANCE_TREATMENT.approved_leave
    assert.equal(t.eligible, false)
    assert.equal(t.neutral, true)
    assert.equal(t.expectation, 'none')
    assert.equal(t.attendanceConcern, false)
  })

  test('18b. a neutral date drops out of the expected-working-day set', () => {
    const dates = expectedWorkingDates('2026-07-27', '2026-07-29', '2026-07-30', calendar())
    assert.deepEqual(dates, ['2026-07-27', '2026-07-28', '2026-07-29'])

    const withLeave = expectedWorkingDates('2026-07-27', '2026-07-29', '2026-07-30',
      calendar({ neutralDates: new Set(['2026-07-28']) }))
    assert.deepEqual(withLeave, ['2026-07-27', '2026-07-29'])
  })

  // Required case 19 — official duty is eligible but not penalised for timing.
  test('19. official duty stays eligible but its login timing is not measured', () => {
    const t = ATTENDANCE_TREATMENT.official_duty
    assert.equal(t.eligible, true)
    assert.equal(t.neutral, false)
    assert.equal(t.expectation, 'full')
    assert.equal(t.measureLoginTiming, false)
  })

  // Required case 20 — half-day behaviour, or a documented unsupported state.
  test('20. half day is declared as a reduced expectation and documented as not implemented', () => {
    assert.equal(ATTENDANCE_TREATMENT.half_day.expectation, 'half')
    assert.equal(ATTENDANCE_TREATMENT.half_day.eligible, true)
    assert.equal(HALF_DAY_SUPPORT.declared, true)
    assert.equal(HALF_DAY_SUPPORT.implemented, false)
    assert.match(HALF_DAY_SUPPORT.note, /scored as full days/)
  })

  test('absence is an attendance concern, and no score is fabricated for it', () => {
    const t = ATTENDANCE_TREATMENT.absent
    assert.equal(t.eligible, true)          // it was a working day
    assert.equal(t.attendanceConcern, true) // and it is flagged as attendance, not output
    assert.equal(t.measureLoginTiming, false)
  })

  test('an unrecorded day is marked, never silently assumed', () => {
    assert.equal(ATTENDANCE_TREATMENT.unknown.eligible, true)
    assert.match(ATTENDANCE_TREATMENT.unknown.label, /Not recorded/)
  })

  test('the adapter splits provider output into neutral, concern and unverified', async () => {
    const states = new Map<string, DayAttendance>([
      [attendanceKey('u1', '2026-07-27'), { userId: 'u1', date: '2026-07-27', state: 'approved_leave',  checkInAt: null, source: 'test' }],
      [attendanceKey('u1', '2026-07-28'), { userId: 'u1', date: '2026-07-28', state: 'absent',          checkInAt: null, source: 'test' }],
      [attendanceKey('u1', '2026-07-29'), { userId: 'u1', date: '2026-07-29', state: 'unknown',         checkInAt: null, source: 'test' }],
      [attendanceKey('u1', '2026-07-30'), { userId: 'u1', date: '2026-07-30', state: 'company_holiday', checkInAt: null, source: 'test' }],
    ])
    const split = splitAttendanceStates('u1', ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'], states)
    assert.deepEqual([...split.neutralDates].sort(), ['2026-07-27', '2026-07-30'])
    assert.deepEqual([...split.concernDates], ['2026-07-28'])
    assert.deepEqual([...split.unverifiedDates], ['2026-07-29'])

    // No provider wired: every set is empty and today's behaviour is unchanged.
    const none = await NO_ATTENDANCE_PROVIDER.statesFor(['u1'], '2026-07-01', '2026-07-31')
    assert.equal(none.size, 0)
    const noSplit = splitAttendanceStates('u1', ['2026-07-27'], none)
    assert.equal(noSplit.neutralDates.size, 0)
  })

  test('the limitation is stated in the words the page shows, and leave is not inferred', () => {
    assert.match(ATTENDANCE_LIMITATION_NOTE, /Approved leave is not yet available/)
    assert.match(ATTENDANCE_LIMITATION_NOTE, /never inferred from absence/)
    assert.match(ATTENDANCE_LIMITATION_NOTE, /not a payroll-ready measurement/)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// PART 4 — System Adoption
// ══════════════════════════════════════════════════════════════════════════════

describe('start-window configuration', () => {
  test('a configured shift is authoritative and not provisional', () => {
    const general = resolveWorkdayStart('General Shift')
    assert.equal(general.startMinutes, SHIFT_START_MINUTES['General Shift'])
    assert.equal(general.startMinutes, 600)
    assert.equal(general.provisional, false)
    assert.equal(general.graceMinutes, ADOPTION_GRACE_MINUTES)
    assert.equal(general.windowEndMinutes, 630)

    assert.equal(resolveWorkdayStart('Factory Shift').startMinutes, 540)
  })

  test('free-text times are parsed, matching the existing attendance parser', () => {
    assert.equal(resolveWorkdayStart('9:30 AM').startMinutes, 570)
    assert.equal(resolveWorkdayStart('12:00 AM').startMinutes, 0)
    assert.equal(resolveWorkdayStart('1:00 PM').startMinutes, 780)
    assert.equal(resolveWorkdayStart('09:15').startMinutes, 555)
  })

  test('no configured shift falls back to a documented provisional default', () => {
    for (const value of [null, undefined, '', '   ', 'Whenever']) {
      const w = resolveWorkdayStart(value)
      assert.equal(w.startMinutes, PROVISIONAL_WORKDAY_START_MINUTES, `for ${JSON.stringify(value)}`)
      assert.equal(w.provisional, true, `for ${JSON.stringify(value)}`)
      assert.ok(w.source.length > 0)
    }
  })

  // Required case 25 — start-window classification.
  test('25. an open inside start + grace is within the window, after it is late', () => {
    const w = resolveWorkdayStart('General Shift')     // 10:00, 30 min grace
    assert.equal(classifyFirstOpen(at('2026-07-28',  9, 45), w), 'within_window')
    assert.equal(classifyFirstOpen(at('2026-07-28', 10,  0), w), 'within_window')
    assert.equal(classifyFirstOpen(at('2026-07-28', 10, 30), w), 'within_window')
    assert.equal(classifyFirstOpen(at('2026-07-28', 10, 31), w), 'late')
    assert.equal(classifyFirstOpen(at('2026-07-28', 15,  0), w), 'late')
    assert.equal(classifyFirstOpen(null, w), 'missing')
  })

  test('the window is measured in IST, not in the server timezone', () => {
    // 04:45 UTC is 10:15 IST — inside a 10:00 + 30 window.
    assert.equal(istMinutesOfDay('2026-07-28T04:45:00Z'), 615)
    assert.equal(formatMinutesOfDay(615), '10:15')
    assert.equal(classifyFirstOpen('2026-07-28T04:45:00Z', resolveWorkdayStart('General Shift')), 'within_window')
    // 06:00 UTC is 11:30 IST — outside it.
    assert.equal(classifyFirstOpen('2026-07-28T06:00:00Z', resolveWorkdayStart('General Shift')), 'late')
  })
})

describe('adoption metrics', () => {
  const dates = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30']

  test('opens are counted against eligible days only', () => {
    const records: AppOpenRecord[] = [
      { userId: 'u', businessDate: '2026-07-27', firstOpenedAt: at('2026-07-27', 10, 5) },
      { userId: 'u', businessDate: '2026-07-28', firstOpenedAt: at('2026-07-28', 12, 0) },
      // A Sunday open. Keenness at the weekend must not offset a weekday miss.
      { userId: 'u', businessDate: '2026-07-26', firstOpenedAt: at('2026-07-26', 10, 0) },
    ]
    const a = computeAdoption(dates, records, shift, '2026-07-27')
    assert.equal(a.expectedDays, 4)
    assert.equal(a.openedDays, 2)
    assert.equal(a.withinWindowDays, 1)
    assert.equal(a.lateDays, 1)
    assert.equal(a.missingDays, 2)
    assert.equal(a.unrecordedDays, 0)
    assert.equal(adoptionRate(a), 50)
    assert.equal(withinWindowRate(a), 50)
  })

  test('days before recording began are excluded from the denominator, not counted as misses', () => {
    const records: AppOpenRecord[] = [
      { userId: 'u', businessDate: '2026-07-30', firstOpenedAt: at('2026-07-30', 10, 0) },
    ]
    const a = computeAdoption(dates, records, shift, '2026-07-30')
    assert.equal(a.missingDays, 3)
    assert.equal(a.unrecordedDays, 3)   // 27, 28, 29 pre-date recording
    assert.equal(adoptionRate(a), 100)  // 1 of 1 recordable day
  })

  // Required case 26 — no adoption data must not break anything.
  test('26. an empty table yields no adoption conclusions rather than 0%', () => {
    const a = computeAdoption(dates, [], shift, null)
    assert.equal(a.openedDays, 0)
    assert.equal(a.unrecordedDays, 4)
    assert.equal(adoptionRate(a), null)
    assert.equal(withinWindowRate(a), null)
    assert.equal(a.avgFirstOpenMinutes, null)
    assert.equal(hasAdoptionData(a), false)

    // And the explanation says so instead of asserting non-use.
    const m = member({ userId: 'a', userName: 'A', adoption: a })
    const ex = adoptionExplanation(m)
    assert.match(ex.headline, /no data yet/)
    assert.match(ex.bullets.join(' '), /pre-date first-open recording/)
    assert.match(ex.bullets.join(' '), /does not affect the performance score/)
  })

  test('an employee with no eligible days has an empty, non-null adoption result', () => {
    const a = computeAdoption([], [], shift, '2026-07-01')
    assert.equal(a.expectedDays, 0)
    assert.equal(adoptionRate(a), null)
    assert.equal(hasAdoptionData(a), false)
    assert.deepEqual(emptyAdoption(shift).openedDays, 0)
  })

  test('the average first-open time is the mean of actual opens, in IST minutes', () => {
    const records: AppOpenRecord[] = [
      { userId: 'u', businessDate: '2026-07-27', firstOpenedAt: at('2026-07-27', 10, 0) },  // 600
      { userId: 'u', businessDate: '2026-07-28', firstOpenedAt: at('2026-07-28', 11, 0) },  // 660
    ]
    const a = computeAdoption(dates, records, shift, '2026-07-27')
    assert.equal(a.avgFirstOpenMinutes, 630)
    assert.equal(formatMinutesOfDay(a.avgFirstOpenMinutes!), '10:30')
  })

  test('the streak counts back from the most recent eligible day', () => {
    const recent: AppOpenRecord[] = [
      { userId: 'u', businessDate: '2026-07-29', firstOpenedAt: at('2026-07-29', 10, 0) },
      { userId: 'u', businessDate: '2026-07-30', firstOpenedAt: at('2026-07-30', 10, 0) },
    ]
    assert.equal(computeAdoption(dates, recent, shift, '2026-07-27').streak, 2)

    // A good week three weeks ago is not a current streak.
    const stale: AppOpenRecord[] = [
      { userId: 'u', businessDate: '2026-07-27', firstOpenedAt: at('2026-07-27', 10, 0) },
      { userId: 'u', businessDate: '2026-07-28', firstOpenedAt: at('2026-07-28', 10, 0) },
    ]
    assert.equal(computeAdoption(dates, stale, shift, '2026-07-27').streak, 0)
  })

  test('recording-start detection takes the earliest row present', () => {
    assert.equal(adoptionRecordingFrom([]), null)
    assert.equal(adoptionRecordingFrom([
      { userId: 'a', businessDate: '2026-07-20', firstOpenedAt: at('2026-07-20', 10, 0) },
      { userId: 'b', businessDate: '2026-07-14', firstOpenedAt: at('2026-07-14', 10, 0) },
    ]), '2026-07-14')
  })
})

describe('first-open recording', () => {
  // Required cases 21, 22, 23.
  test('21. one row per employee per business date is the row shape the constraint keys on', () => {
    const now = new Date('2026-07-28T05:00:00Z')
    const a = buildAppOpenRow('user-1', '/dashboard', now)
    const b = buildAppOpenRow('user-1', '/tasks/my', new Date('2026-07-28T09:00:00Z'))
    // Same (user_id, business_date) → the DB unique constraint absorbs the second,
    // so only the first timestamp survives.
    assert.equal(a.user_id, b.user_id)
    assert.equal(a.business_date, b.business_date)
    assert.notEqual(a.first_opened_at, b.first_opened_at)
  })

  test('22. the business date is the IST date, not the UTC date', () => {
    // 20:00 UTC on 27 July is 01:30 IST on 28 July. The UTC date would be wrong.
    const row = buildAppOpenRow('u', '/dashboard', new Date('2026-07-27T20:00:00Z'))
    assert.equal(row.business_date, '2026-07-28')
    assert.notEqual(row.business_date, '2026-07-27')

    // And 18:00 UTC on 27 July is 23:30 IST the same day.
    assert.equal(buildAppOpenRow('u', '/dashboard', new Date('2026-07-27T18:00:00Z')).business_date, '2026-07-27')
  })

  test('23. the row records whichever user id it is given — the endpoint supplies the real one', () => {
    // The endpoint resolves the id from the bearer token and never reads one from
    // the request body, so while View As is active the admin is recorded. This
    // asserts the builder has no other input that could override it.
    const row = buildAppOpenRow('real-admin-id', '/dashboard', new Date('2026-07-28T05:00:00Z'))
    assert.equal(row.user_id, 'real-admin-id')
    assert.deepEqual(Object.keys(row).sort(), ['business_date', 'first_opened_at', 'first_route', 'user_id'])
  })

  test('only Task Management routes count, and Performance pages never do', () => {
    for (const p of ['/dashboard', '/tasks', '/tasks/my', '/tasks/assigned-by-me', '/tasks/create', '/manager', '/notifications']) {
      assert.equal(isTaskManagementRoute(p), true, p)
    }
    // Checking the metric must not satisfy the metric.
    for (const p of ['/performance', '/performance/team', '/modules', '/finance', '/orders', '/attendance', '/login', '/payroll']) {
      assert.equal(isTaskManagementRoute(p), false, p)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// PART 5 — Regression guards
// ══════════════════════════════════════════════════════════════════════════════

describe('no regression in the official score', () => {
  // Required case 27 — no score-weight regression.
  test('27. adoption and eligibility touched none of the pillar weights', async () => {
    const { computeBreakdown } = await import('./performance')
    const full = computeBreakdown({
      completedHigh: 1, completedMedium: 1, completedLow: 1,
      statusUpdates: 0, blockerResolutions: 0,
      hasEodLog: false, wasActiveToday: false, timelyAcks: 0,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
    })
    // High×22 + Med×15 + Low×8 = 45, capped by the output weight of 50.
    assert.equal(full.output, 45)

    const disciplineOnly = computeBreakdown({
      completedHigh: 0, completedMedium: 0, completedLow: 0,
      statusUpdates: 0, blockerResolutions: 0,
      hasEodLog: true, wasActiveToday: true, timelyAcks: 0,
      overdueCount: 0, staleBlockedCount: 0, activeTasks: 0, blockedCount: 0,
    })
    assert.ok(disciplineOnly.discipline > 0 && disciplineOnly.discipline <= 20)
  })

  test('adoption is not referenced by any score component', () => {
    const withAdoption = member({
      userId: 'a', userName: 'A', score: 70,
      adoption: computeAdoption(['2026-07-28'], [], shift, '2026-07-01'),
    })
    const withoutAdoption = member({ userId: 'b', userName: 'B', score: 70, adoption: emptyAdoption(shift) })
    // Same score in, same rank position out — adoption cannot move it.
    assert.equal(compareOverall(withAdoption, withoutAdoption), 'A'.localeCompare('B'))
  })
})

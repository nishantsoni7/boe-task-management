/**
 * Pure scoring functions shared between the single-user and batch
 * performance-metrics routes. Do NOT import from route files.
 *
 * Score model — 4 pillars, max 100 pts:
 *  OUTPUT     (0–50)  Weighted completions: High×22 + Med×15 + Low×8, cap 50
 *  MOMENTUM   (0–20)  Status updates ×4 (cap 16) + blocker-cleared ×4 (cap 4)
 *  DISCIPLINE (0–20)  EOD log +12, was active today +5, timely ack ×3 (cap 3)
 *  RISK       (0→−40) Overdue ×−5 (cap −25) + stale-blocked ×−8 (cap −16)
 *  TOTAL = clamp(Output + Momentum + Discipline + Risk, 0, 100)
 */

import type {
  ScoreBreakdown, DayInputs, TrendDay,
  TrendAnalysis, TrendClassification, PerformanceRating,
} from '@/lib/types'

export function computeBreakdown(inputs: DayInputs): ScoreBreakdown {
  const output = Math.min(
    50,
    inputs.completedHigh   * 22 +
    inputs.completedMedium * 15 +
    inputs.completedLow    * 8
  )
  const momentum = Math.min(20,
    Math.min(16, inputs.statusUpdates * 4) +
    Math.min(4,  inputs.blockerResolutions * 4)
  )
  const discipline = Math.min(20,
    (inputs.hasEodLog     ? 12 : 0) +
    (inputs.wasActiveToday ? 5 : 0) +
    Math.min(3, inputs.timelyAcks * 3)
  )
  const risk = -(
    Math.min(25, inputs.overdueCount      * 5) +
    Math.min(16, inputs.staleBlockedCount * 8)
  )
  const total = Math.max(0, Math.min(100, output + momentum + discipline + risk))
  return { output, momentum, discipline, risk, total }
}

export function scoreRating(score: number): PerformanceRating {
  if (score >= 75) return 'excellent'
  if (score >= 58) return 'good'
  if (score >= 38) return 'average'
  if (score >= 20) return 'needs_improvement'
  return 'critical'
}

export function analyzeTrend(trendDays: TrendDay[]): TrendAnalysis {
  const scores = trendDays.map(d => d.score)

  if (scores.length < 3) {
    return {
      classification:    'insufficient_data',
      direction:         'flat',
      streak:            0,
      weekOverWeekDelta: 0,
      description:       'Not enough data yet',
    }
  }

  const n        = scores.length
  const avg      = scores.reduce((s, v) => s + v, 0) / n
  const variance = scores.reduce((s, v) => s + (v - avg) ** 2, 0) / n
  const stddev   = Math.sqrt(variance)

  const firstHalf  = scores.slice(0, Math.floor(n / 2))
  const secondHalf = scores.slice(Math.floor(n / 2))
  const firstAvg   = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length
  const secondAvg  = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length
  const halfDelta  = secondAvg - firstAvg

  const lastDir = scores[n - 1] >= scores[n - 2] ? 'up' : 'down'
  let streak = 1
  for (let i = n - 2; i > 0; i--) {
    const dir = scores[i] >= scores[i - 1] ? 'up' : 'down'
    if (dir === lastDir) streak++
    else break
  }

  let weekOverWeekDelta = Math.round(halfDelta)
  if (scores.length >= 14) {
    const prevWeekAvg = scores.slice(-14, -7).reduce((s, v) => s + v, 0) / 7
    const thisWeekAvg = scores.slice(-7).reduce((s, v) => s + v, 0) / 7
    weekOverWeekDelta = Math.round(thisWeekAvg - prevWeekAvg)
  }

  let classification: TrendClassification
  if      (stddev > 20)                            classification = 'volatile'
  else if (halfDelta > 8  && lastDir === 'up')     classification = 'improving'
  else if (halfDelta < -8 && lastDir === 'down')   classification = 'declining'
  else if (stddev < 8 && avg >= 50)                classification = 'consistent'
  else                                             classification = 'stagnant'

  const direction = halfDelta > 3 ? 'up' : halfDelta < -3 ? 'down' : 'flat'

  const descriptions: Record<TrendClassification, string> = {
    improving:         `Improving — up ${Math.abs(Math.round(halfDelta))} pts over last ${n} days`,
    declining:         `Declining — down ${Math.abs(Math.round(halfDelta))} pts over last ${n} days`,
    volatile:          `Volatile — ${Math.round(stddev)} pt swing day-to-day`,
    consistent:        `Consistent — steady at ~${Math.round(avg)}/100`,
    stagnant:          `Flat — little change recently`,
    insufficient_data: 'Not enough data yet',
  }

  return { classification, direction, streak, weekOverWeekDelta, description: descriptions[classification] }
}

export function trendDayFromInputs(date: string, inputs: DayInputs): TrendDay {
  const breakdown = computeBreakdown(inputs)
  return {
    date,
    score: breakdown.total,
    breakdown,
    inputs: {
      completedHigh:   inputs.completedHigh,
      completedMedium: inputs.completedMedium,
      completedLow:    inputs.completedLow,
      statusUpdates:   inputs.statusUpdates,
      hasEodLog:       inputs.hasEodLog,
    },
  }
}

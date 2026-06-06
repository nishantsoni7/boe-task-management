/**
 * Performance Audit API
 *
 * Accepts a full PerformanceData snapshot and returns coaching feedback.
 * If ANTHROPIC_API_KEY is set, calls Claude Haiku with a structured prompt.
 * Otherwise falls back to a rule-based engine that covers all key patterns.
 *
 * The AI prompt is designed to surface:
 *   1. Whether the day/period was progressive, moderate, or underperforming
 *   2. Pattern-based insights (e.g. "active but not completing", "discipline gap")
 *   3. Specific, numbered next-step suggestions referencing real numbers
 */

import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'
import type { DayInputs, ScoreBreakdown, TrendAnalysis, PerformanceAudit, TrendDay } from '@/lib/types'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function getCallerProfile(token: string) {
  const client = sb()
  const { data: { user }, error } = await client.auth.getUser(token)
  if (error || !user) return null
  const { data } = await client
    .from('users')
    .select('id, role, full_name, team, position')
    .eq('id', user.id)
    .single()
  return data as { id: string; role: string; full_name: string; team: string; position: string | null } | null
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(params: {
  userName:      string
  role:          string
  team:          string
  position:      string | null
  period:        string
  score:         number
  rating:        string
  breakdown:     ScoreBreakdown
  inputs:        DayInputs
  trendAnalysis: TrendAnalysis
  trend:         TrendDay[]
}): string {
  const { userName, role, team, position, period, score, rating, breakdown, inputs, trendAnalysis, trend } = params

  const totalCompleted = inputs.completedHigh + inputs.completedMedium + inputs.completedLow
  const periodLabel    = period === 'daily' ? "TODAY'S" : period === 'weekly' ? "THIS WEEK'S" : "THIS MONTH'S"

  // Trend summary: last 7 scores
  const recentScores  = trend.slice(-7).map(d => d.score).join(', ')
  const weeklyCompleted = trend.reduce((s, d) => s + d.inputs.completedHigh + d.inputs.completedMedium + d.inputs.completedLow, 0)
  const eodLogRate    = Math.round(trend.filter(d => d.inputs.hasEodLog).length / trend.length * 100)

  // Behavioural ratio: updates per completed task (signals "busy but not finishing")
  const weeklyUpdates = trend.reduce((s, d) => s + d.inputs.statusUpdates, 0)
  const updateRatio   = totalCompleted > 0
    ? `${(weeklyUpdates / (weeklyCompleted || 1)).toFixed(1)} updates per completed task`
    : `${weeklyUpdates} updates, 0 tasks completed`

  return `You are a performance coach for BOE Task Management, an internal operations tool for a furniture manufacturing company in India. Be direct, specific, and constructive — not generic.

=== TEAM MEMBER ===
Name: ${userName}
Role: ${role} | Team: ${team} | Position: ${position ?? 'N/A'}

=== ${periodLabel} SCORE BREAKDOWN ===
Total: ${score}/100 (${rating.replace('_', ' ')})
  Output     : ${breakdown.output}/50   — ${inputs.completedHigh} high-priority, ${inputs.completedMedium} medium, ${inputs.completedLow} low tasks completed today
  Momentum   : ${breakdown.momentum}/20  — ${inputs.statusUpdates} status updates, ${inputs.blockerResolutions} blocker(s) resolved
  Discipline : ${breakdown.discipline}/20 — EOD log: ${inputs.hasEodLog ? 'submitted' : 'MISSING'}, was active: ${inputs.wasActiveToday ? 'yes' : 'no'}, timely acks: ${inputs.timelyAcks}
  Risk       : ${breakdown.risk}/0   — ${inputs.overdueCount} overdue task(s), ${inputs.staleBlockedCount} stale-blocked (>2 days)

=== CURRENT TASK PORTFOLIO ===
Active tasks total: ${inputs.activeTasks}
Currently blocked: ${inputs.blockedCount} (${inputs.staleBlockedCount} stale >2 days)
Overdue: ${inputs.overdueCount}

=== 7-DAY TREND ===
Trend: ${trendAnalysis.classification} — ${trendAnalysis.description}
Week-over-week delta: ${trendAnalysis.weekOverWeekDelta >= 0 ? '+' : ''}${trendAnalysis.weekOverWeekDelta} pts
Direction streak: ${trendAnalysis.streak} day(s) ${trendAnalysis.direction}
Daily scores (oldest→newest): ${recentScores}

=== BEHAVIOURAL PATTERNS ===
Tasks completed this week: ${weeklyCompleted} (${trend.reduce((s,d) => s+d.inputs.completedHigh,0)} high, ${trend.reduce((s,d) => s+d.inputs.completedMedium,0)} medium)
EOD log rate this week: ${eodLogRate}% (${trend.filter(d=>d.inputs.hasEodLog).length}/${trend.length} days)
Update ratio: ${updateRatio}

Based on this data, provide coaching in this exact JSON format — no other text:
{
  "progressive": <true if score >= 58, false otherwise>,
  "progressiveLabel": "<one of: Progressive Day | Moderate Day | Needs Improvement>",
  "verdict": "<one direct sentence summarising the day/period — reference the score and the single biggest factor>",
  "insights": [
    "<specific pattern observation — reference real numbers, e.g. '8 updates but only 1 completion suggests effort without closure'>",
    "<second observation — focus on what the data reveals about work habits>",
    "<third observation — focus on risk, discipline, or trend direction>"
  ],
  "suggestions": [
    "<concrete action #1 — specific and actionable, e.g. 'Prioritise clearing the 3 overdue tasks before taking on new work'>",
    "<concrete action #2>",
    "<concrete action #3>"
  ]
}`
}

// ─── Rule-based fallback ──────────────────────────────────────────────────────

function ruleBasedAudit(
  score: number,
  breakdown: ScoreBreakdown,
  inputs: DayInputs,
  trendAnalysis: TrendAnalysis
): PerformanceAudit {
  const totalCompleted = inputs.completedHigh + inputs.completedMedium + inputs.completedLow
  const progressive    = score >= 58
  const label          = score >= 75 ? 'Progressive Day' : score >= 38 ? 'Moderate Day' : 'Needs Improvement'

  const insights: string[] = []
  const suggestions: string[] = []

  // ── Output pattern ────────────────────────────────────────────────────────
  if (totalCompleted === 0 && inputs.statusUpdates >= 3) {
    insights.push(
      `${inputs.statusUpdates} status updates were made but no tasks were completed — effort is going in but closure is missing.`
    )
    suggestions.push(`Identify one in-progress task closest to done and push it to completion tomorrow.`)
  } else if (totalCompleted >= 2) {
    insights.push(
      `Strong output — ${totalCompleted} task${totalCompleted > 1 ? 's' : ''} completed${inputs.completedHigh > 0 ? `, including ${inputs.completedHigh} high-priority` : ''}.`
    )
  } else if (totalCompleted === 1) {
    insights.push(`1 task completed. Consistent single-task days are a baseline, not a ceiling.`)
  } else {
    insights.push(`No tasks completed today. Output score is 0/50 — the biggest single drag on the total.`)
    suggestions.push(`Set a concrete target: complete at least one medium-priority task before EOD tomorrow.`)
  }

  // ── Risk pattern ──────────────────────────────────────────────────────────
  if (inputs.overdueCount > 0) {
    insights.push(
      `${inputs.overdueCount} overdue task${inputs.overdueCount > 1 ? 's are' : ' is'} costing ${Math.min(25, inputs.overdueCount * 5)} pts from the score. ` +
      (inputs.overdueCount >= 3 ? 'This is a significant backlog that needs triage.' : 'Clear these before the week ends.')
    )
    suggestions.push(
      `Address the oldest overdue task first — even a partial update stops the penalty from compounding.`
    )
  }

  if (inputs.staleBlockedCount > 0) {
    insights.push(
      `${inputs.staleBlockedCount} task${inputs.staleBlockedCount > 1 ? 's have' : ' has'} been blocked for more than 2 days with no update — that's a stale block costing ${inputs.staleBlockedCount * 8} pts.`
    )
    suggestions.push(`Escalate or add a note to each stale-blocked task today — even acknowledging the block reduces the perception of inaction.`)
  }

  // ── Discipline pattern ────────────────────────────────────────────────────
  if (!inputs.hasEodLog) {
    if (insights.length < 3)
      insights.push(`EOD log not submitted — the 12-pt discipline bonus was left on the table.`)
    suggestions.push(`Submit the EOD log before closing your laptop — it takes 2 minutes and earns 12 pts.`)
  }

  // ── Trend signal ──────────────────────────────────────────────────────────
  if (trendAnalysis.classification === 'declining' && trendAnalysis.streak >= 2) {
    if (insights.length < 3)
      insights.push(
        `Score has been declining for ${trendAnalysis.streak} consecutive days (${trendAnalysis.weekOverWeekDelta} pts week-over-week) — a pattern worth breaking before it becomes the norm.`
      )
  } else if (trendAnalysis.classification === 'improving' && trendAnalysis.streak >= 2) {
    if (insights.length < 3)
      insights.push(
        `Positive trend — improving for ${trendAnalysis.streak} consecutive days. The week-over-week delta is +${trendAnalysis.weekOverWeekDelta} pts.`
      )
  }

  // ── Momentum pattern ──────────────────────────────────────────────────────
  if (inputs.statusUpdates === 0 && inputs.wasActiveToday === false) {
    if (suggestions.length < 3)
      suggestions.push(`Make at least 2 status updates daily (mid-day + EOD) to keep the team informed and earn momentum points.`)
  }

  // Pad to 2-3 minimum
  while (insights.length < 2)    insights.push(`Overall score of ${score}/100 reflects the combined impact of completions, momentum, and risk.`)
  while (suggestions.length < 2) suggestions.push(`Focus on consistency: one completed task + one EOD log per day compounds significantly over a week.`)

  const verdict =
    score >= 75 ? `Strong day — ${score}/100, driven by ${breakdown.output > 25 ? 'solid task completions' : 'good discipline and momentum'}.`
    : score >= 58 ? `Good day at ${score}/100 — output is there but ${inputs.overdueCount > 0 ? 'overdue backlog is pulling the score down' : 'small discipline gaps prevented a higher score'}.`
    : score >= 38 ? `Moderate day at ${score}/100 — ${totalCompleted === 0 ? 'no completions' : 'limited completions'} and ${inputs.overdueCount > 0 ? `${inputs.overdueCount} overdue tasks` : 'missed discipline points'} are the key gaps.`
    : `Challenging day at ${score}/100 — ${inputs.overdueCount > 0 ? `${inputs.overdueCount} overdue tasks` : 'lack of activity'} combined with ${!inputs.hasEodLog ? 'no EOD log' : 'no completions'} kept the score low.`

  return {
    progressive,
    progressiveLabel: label,
    verdict,
    insights:    insights.slice(0, 3),
    suggestions: suggestions.slice(0, 3),
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const caller = await getCallerProfile(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const {
    userId, period, inputs, breakdown, trend, trendAnalysis,
    userName, score, rating,
  } = body as {
    userId?:       string
    period:        string
    inputs:        DayInputs
    breakdown:     ScoreBreakdown
    trend:         TrendDay[]
    trendAnalysis: TrendAnalysis
    userName:      string
    score:         number
    rating:        string
  }

  const targetId = userId ?? caller.id
  if (targetId !== caller.id && !['admin', 'manager'].includes(caller.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const client = sb()
  const { data: targetUser } = await client
    .from('users')
    .select('full_name, team, position, role')
    .eq('id', targetId)
    .single()

  const apiKey = process.env.ANTHROPIC_API_KEY

  // No API key → rule-based fallback immediately
  if (!apiKey) {
    return NextResponse.json({
      audit: ruleBasedAudit(score, breakdown, inputs, trendAnalysis),
    })
  }

  const prompt = buildPrompt({
    userName:      targetUser?.full_name ?? userName,
    role:          targetUser?.role ?? 'member',
    team:          targetUser?.team ?? '—',
    position:      targetUser?.position ?? null,
    period,
    score,
    rating,
    breakdown,
    inputs,
    trendAnalysis,
    trend: Array.isArray(trend) ? trend : [],
  })

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Anthropic API error:', err)
      return NextResponse.json({ audit: ruleBasedAudit(score, breakdown, inputs, trendAnalysis) })
    }

    const data = await response.json()
    const text = data.content?.[0]?.text ?? ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')
    const audit = JSON.parse(jsonMatch[0]) as PerformanceAudit
    return NextResponse.json({ audit })
  } catch (err) {
    console.error('Audit error:', err)
    return NextResponse.json({ audit: ruleBasedAudit(score, breakdown, inputs, trendAnalysis) })
  }
}

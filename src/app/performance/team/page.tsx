'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import type {
  UserProfile, MemberPerfEntry, PerformanceRating,
  TrendClassification, ScoreBreakdown,
} from '@/lib/types'

// ─── Progress loader ──────────────────────────────────────────────────────────
function TeamProgressLoader({ progress }: { progress: number }) {
  const pct = Math.round(progress)
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: '#fff',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 24, padding: '0 32px',
      pointerEvents: 'all',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 420 }}>
        <div style={{
          fontSize: 15, fontWeight: 600, color: '#111318',
          lineHeight: 1.6, marginBottom: 6,
        }}>
          Good things take a little time.
        </div>
        <div style={{ fontSize: 13, color: '#8C94A6', lineHeight: 1.6 }}>
          Please wait while we prepare your team performance report.
        </div>
      </div>

      <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{
          width: '100%', height: 6, background: '#EEF0F4',
          borderRadius: 999, overflow: 'hidden',
        }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: 'linear-gradient(90deg, #5585E8, #45A870)',
            borderRadius: 999,
            transition: 'width 0.25s ease',
          }} />
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: '#8C94A6' }}>
          {pct}%
        </div>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ratingColor(rating: PerformanceRating | string) {
  return ({
    excellent:        '#45A870',
    good:             '#5585E8',
    average:          '#E8A030',
    needs_improvement: '#D94F4F',
    critical:         '#B03030',
  } as Record<string, string>)[rating] ?? '#8C94A6'
}

function ratingLabel(rating: PerformanceRating | string) {
  return ({
    excellent:        'Excellent',
    good:             'Good',
    average:          'Average',
    needs_improvement: 'Needs Work',
    critical:         'Critical',
  } as Record<string, string>)[rating] ?? '—'
}

const TREND_COLORS: Record<TrendClassification, string> = {
  improving:         '#45A870',
  declining:         '#D94F4F',
  volatile:          '#E8A030',
  consistent:        '#5585E8',
  stagnant:          '#8C94A6',
  insufficient_data: '#8C94A6',
}

const TREND_ICONS: Record<TrendClassification, string> = {
  improving:         '↑',
  declining:         '↓',
  volatile:          '~',
  consistent:        '→',
  stagnant:          '—',
  insufficient_data: '?',
}

// ─── Score pill (clickable — shows breakdown) ─────────────────────────────────
function ScorePill({ score, rating, breakdown, weekOverWeekDelta }: {
  score: number; rating: string; breakdown: ScoreBreakdown; weekOverWeekDelta: number
}) {
  const [open, setOpen] = React.useState(false)
  const color = ratingColor(rating)

  const rows: { label: string; value: string | number; max?: number; color: string }[] = [
    { label: 'Output',      value: breakdown.output,     max: 50,  color: '#45A870' },
    { label: 'Ownership',   value: breakdown.momentum,   max: 20,  color: '#5585E8' },
    { label: 'Discipline',  value: breakdown.discipline, max: 20,  color: '#E8A030' },
    { label: 'Risk Penalty',value: breakdown.risk,                 color: breakdown.risk < 0 ? '#D94F4F' : '#8C94A6' },
    { label: 'Improvement', value: weekOverWeekDelta > 0 ? `+${weekOverWeekDelta} w/w` : weekOverWeekDelta === 0 ? '—' : `${weekOverWeekDelta} w/w`,
      color: weekOverWeekDelta > 0 ? '#45A870' : weekOverWeekDelta < 0 ? '#D94F4F' : '#8C94A6' },
  ]

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        title="Click to see score breakdown"
      >
        <div style={{
          width: 40, height: 40, borderRadius: '50%',
          background: color + '18', border: `2px solid ${color}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700, color,
        }}>{score}</div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color, whiteSpace: 'nowrap' }}>{ratingLabel(rating)}</div>
          <div style={{ fontSize: 9, color: '#A0A9BE', whiteSpace: 'nowrap' }}>{open ? '▲ hide' : '▼ breakdown'}</div>
        </div>
      </div>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 50, zIndex: 100,
          background: '#fff', border: '1px solid #EEF0F4',
          borderRadius: 10, padding: '12px 14px', minWidth: 200,
          boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#111318', marginBottom: 8 }}>Score Composition</div>
          {rows.map(r => (
            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: '#6B7384' }}>{r.label}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: r.color }}>
                {r.value}{r.max != null ? <span style={{ fontSize: 9, color: '#A0A9BE', fontWeight: 400 }}>/{r.max}</span> : ''}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #EEF0F4', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#111318' }}>Total Score</span>
            <span style={{ fontSize: 13, fontWeight: 700, color }}>{score}<span style={{ fontSize: 9, color: '#A0A9BE', fontWeight: 400 }}>/100</span></span>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Breakdown mini-bars ──────────────────────────────────────────────────────
function BreakdownMini({ breakdown }: { breakdown: ScoreBreakdown }) {
  const bars = [
    { label: 'O', value: breakdown.output,     max: 50,  color: '#45A870' },
    { label: 'M', value: breakdown.momentum,   max: 20,  color: '#5585E8' },
    { label: 'D', value: breakdown.discipline, max: 20,  color: '#E8A030' },
    { label: 'R', value: Math.abs(breakdown.risk), max: 40, color: '#D94F4F' },
  ]
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 20 }} title={`Output ${breakdown.output} · Momentum ${breakdown.momentum} · Discipline ${breakdown.discipline} · Risk ${breakdown.risk}`}>
      {bars.map(b => (
        <div key={b.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <div style={{
            width: 10,
            height: Math.max(3, Math.round((b.value / b.max) * 18)),
            background: b.color,
            borderRadius: 2,
            opacity: b.label === 'R' && b.value === 0 ? 0.2 : 0.8,
          }} />
          <div style={{ fontSize: 8, color: '#8C94A6' }}>{b.label}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Risk badge ───────────────────────────────────────────────────────────────
function RiskBadge({ level }: { level: 'high' | 'medium' | 'low' }) {
  const cfg = {
    high:   { color: '#D94F4F', bg: '#D94F4F10', label: 'High Risk' },
    medium: { color: '#E8A030', bg: '#E8A03010', label: 'Medium Risk' },
    low:    { color: '#45A870', bg: '#45A87010', label: 'Low Risk' },
  }[level]
  return (
    <span style={{
      fontSize: 10, fontWeight: 600,
      color: cfg.color, background: cfg.bg,
      padding: '2px 7px', borderRadius: 999,
    }}>{cfg.label}</span>
  )
}

// ─── Needs Attention badge ─────────────────────────────────────────────────────
function NeedsAttentionBadge() {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700,
      color: '#D94F4F', background: '#D94F4F12',
      border: '1px solid #D94F4F30',
      padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
    }}>⚠ Needs Attention</span>
  )
}

// ─── Health summary row ────────────────────────────────────────────────────────
function HealthSummaryRow({ m }: { m: MemberPerfEntry }) {
  const trendLabel = m.trendClassification === 'improving'
    ? '↑ Improving' : m.trendClassification === 'declining'
    ? '↓ Declining' : '→ Stable'
  const trendColor = m.trendClassification === 'improving'
    ? '#45A870' : m.trendClassification === 'declining'
    ? '#D94F4F' : '#8C94A6'

  const cells: { label: string; value: string | number; accent?: string }[] = [
    { label: 'Monthly Avg',  value: m.monthlyAvgScore,
      accent: m.monthlyAvgScore >= 70 ? '#45A870' : m.monthlyAvgScore >= 50 ? '#E8A030' : '#D94F4F' },
    { label: 'Submitted',    value: `${m.submittedDays}d` },
    { label: 'Missed',       value: `${m.missedDays}d`,   accent: m.missedDays  > 0 ? '#D94F4F' : undefined },
    { label: 'Low Score',    value: `${m.lowScoreDays}d`, accent: m.lowScoreDays >= 3 ? '#D94F4F' : m.lowScoreDays > 0 ? '#E8A030' : undefined },
    { label: 'Trend',        value: trendLabel,            accent: trendColor },
  ]

  return (
    <div style={{
      background: '#F8F9FB', borderRadius: 7, padding: '6px 8px',
      display: 'flex', gap: 0,
    }}>
      {cells.map((c, i) => (
        <div key={c.label} style={{
          flex: '1 1 0', textAlign: 'center',
          borderRight: i < cells.length - 1 ? '1px solid #E8EAF0' : 'none',
          padding: '3px 4px',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: c.accent ?? '#111318', lineHeight: 1.2 }}>{c.value}</div>
          <div style={{ fontSize: 9, color: '#A0A9BE', marginTop: 2, whiteSpace: 'nowrap' }}>{c.label}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Member card ──────────────────────────────────────────────────────────────
function MemberCard({ m, onViewProfile }: { m: MemberPerfEntry; onViewProfile: (id: string) => void }) {
  const color = ratingColor(m.rating)
  const trendColor = TREND_COLORS[m.trendClassification]
  const needsAttention = m.monthlyAvgScore < 70 || m.missedDays > 0 || m.lowScoreDays >= 3

  return (
    <div style={{
      background: '#fff', border: '1px solid #EEF0F4',
      borderRadius: 10, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 10,
      borderLeft: `3px solid ${color}`,
    }}>
      {/* Header: name + score */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111318' }}>{m.userName}</div>
            {needsAttention && <NeedsAttentionBadge />}
          </div>
          <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>
            {m.team}{m.position ? ` · ${m.position}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BreakdownMini breakdown={m.breakdown} />
          <ScorePill score={m.score} rating={m.rating} breakdown={m.breakdown} weekOverWeekDelta={m.weekOverWeekDelta} />
        </div>
      </div>

      {/* Performance Health Summary */}
      <HealthSummaryRow m={m} />

      {/* Key metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {[
          { label: 'Completed', value: m.completedThisWeek, sub: '30 days',  accent: m.completedThisWeek > 0 ? '#45A870' : undefined },
          { label: 'Active',    value: m.activeTasks,       sub: 'tasks'                                                              },
          { label: 'Overdue',   value: m.overdueCount,      sub: 'tasks',    accent: m.overdueCount > 0 ? '#D94F4F' : undefined       },
          { label: 'Stale Blk', value: m.staleBlockedCount, sub: '>2 days',  accent: m.staleBlockedCount > 0 ? '#D94F4F' : undefined  },
        ].map(({ label, value, sub, accent }) => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: accent ?? '#111318', lineHeight: 1.2 }}>{value}</div>
            <div style={{ fontSize: 10, color: '#8C94A6', marginTop: 1 }}>{label}</div>
            <div style={{ fontSize: 9, color: '#A0A9BE' }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Trend + risk + eod row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Trend classification badge */}
          <span style={{
            fontSize: 10, fontWeight: 600,
            color: trendColor, background: trendColor + '15',
            padding: '2px 7px', borderRadius: 999,
          }}>
            {TREND_ICONS[m.trendClassification]} {m.trendClassification.replace('_', ' ')}
          </span>

          {/* Week-over-week delta */}
          {m.weekOverWeekDelta !== 0 && (
            <span style={{
              fontSize: 10, fontWeight: 600,
              color: m.weekOverWeekDelta > 0 ? '#45A870' : '#D94F4F',
            }}>
              {m.weekOverWeekDelta > 0 ? '+' : ''}{m.weekOverWeekDelta} w/w
            </span>
          )}

          {/* Risk level */}
          <RiskBadge level={m.riskLevel} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* EOD log streak */}
          <span style={{
            fontSize: 10, fontWeight: 600,
            color: m.hasEodLogToday ? '#45A870' : '#D94F4F',
            background: m.hasEodLogToday ? '#45A87010' : '#D94F4F10',
            padding: '2px 7px', borderRadius: 999,
          }}>
            {m.hasEodLogToday ? `✓ EOD · ${m.eodLogStreak}d streak` : '✗ No EOD log'}
          </span>

          {/* View profile */}
          <button
            onClick={() => onViewProfile(m.userId)}
            style={{
              fontSize: 11, fontWeight: 600, color: '#5585E8',
              background: '#5585E808', border: '1px solid #5585E820',
              borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
            }}
          >
            Full Report →
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Performance Analysis Table ──────────────────────────────────────────────
type AnalysisSortKey =
  | 'score' | 'name' | 'team' | 'rating' | 'completed'
  | 'updates' | 'eod' | 'output' | 'momentum' | 'discipline'
  | 'risk' | 'ww' | 'achievement' | 'highlight'

const ANALYSIS_COLS: { key: AnalysisSortKey; label: string; sortable: boolean; align?: 'right' | 'center' }[] = [
  { key: 'name',        label: 'Member',            sortable: true  },
  { key: 'team',        label: 'Team',              sortable: true  },
  { key: 'score',       label: 'Score',             sortable: true,  align: 'right' },
  { key: 'rating',      label: 'Rating',            sortable: true  },
  { key: 'completed',   label: 'Completed',         sortable: true,  align: 'right' },
  { key: 'updates',     label: 'Updates',           sortable: true,  align: 'right' },
  { key: 'eod',         label: 'EOD',               sortable: true,  align: 'center' },
  { key: 'output',      label: 'Output',            sortable: true,  align: 'right' },
  { key: 'momentum',    label: 'Momentum',          sortable: true,  align: 'right' },
  { key: 'discipline',  label: 'Discipline',        sortable: true,  align: 'right' },
  { key: 'risk',        label: 'Risk Penalty',      sortable: true,  align: 'right' },
  { key: 'ww',          label: 'W/W Change',        sortable: true,  align: 'right' },
  { key: 'achievement', label: 'Latest Achievement',sortable: false  },
  { key: 'highlight',   label: 'Latest Highlight',  sortable: false  },
]

function PerformanceAnalysisTable({ members }: { members: MemberPerfEntry[] }) {
  const [sortKey, setSortKey] = useState<AnalysisSortKey>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (key: AnalysisSortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'name' || key === 'team' ? 'asc' : 'desc') }
  }

  const sorted = useMemo(() => {
    return [...members].sort((a, b) => {
      let cmp = 0
      if      (sortKey === 'score')      cmp = a.score - b.score
      else if (sortKey === 'name')       cmp = a.userName.localeCompare(b.userName)
      else if (sortKey === 'team')       cmp = a.team.localeCompare(b.team)
      else if (sortKey === 'rating')     cmp = a.score - b.score
      else if (sortKey === 'completed')  cmp = a.completedThisWeek - b.completedThisWeek
      else if (sortKey === 'updates')    cmp = (a.updatesCount ?? 0) - (b.updatesCount ?? 0)
      else if (sortKey === 'eod')        cmp = (a.hasEodLogToday ? 1 : 0) - (b.hasEodLogToday ? 1 : 0)
      else if (sortKey === 'output')     cmp = a.breakdown.output - b.breakdown.output
      else if (sortKey === 'momentum')   cmp = a.breakdown.momentum - b.breakdown.momentum
      else if (sortKey === 'discipline') cmp = a.breakdown.discipline - b.breakdown.discipline
      else if (sortKey === 'risk')       cmp = a.breakdown.risk - b.breakdown.risk
      else if (sortKey === 'ww')         cmp = a.weekOverWeekDelta - b.weekOverWeekDelta
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [members, sortKey, sortDir])

  if (members.length === 0) return null

  const thStyle = (col: typeof ANALYSIS_COLS[number]): React.CSSProperties => ({
    padding: '8px 10px',
    textAlign: col.align ?? 'left',
    fontWeight: 600,
    color: sortKey === col.key ? '#111318' : '#6B7384',
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap' as const,
    borderBottom: '1px solid #EEF0F4',
    background: '#F8F9FB',
    cursor: col.sortable ? 'pointer' : 'default',
    userSelect: 'none' as const,
  })

  const tdStyle = (align?: 'right' | 'center'): React.CSSProperties => ({
    padding: '8px 10px',
    fontSize: 12,
    borderBottom: '1px solid #F0F1F3',
    textAlign: align ?? 'left',
    verticalAlign: 'top',
  })

  const sortIcon = (key: AnalysisSortKey) => {
    if (sortKey !== key) return <span style={{ color: '#D0D5DF', marginLeft: 3 }}>↕</span>
    return <span style={{ color: '#5585E8', marginLeft: 3 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid #EEF0F4' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>Performance Analysis</div>
        <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>
          Compare score components side-by-side to understand ranking differences
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {ANALYSIS_COLS.map(col => (
                <th
                  key={col.key}
                  style={thStyle(col)}
                  onClick={col.sortable ? () => handleSort(col.key) : undefined}
                >
                  {col.label}{col.sortable && sortIcon(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, i) => {
              const color = ratingColor(m.rating)
              const wwPos = m.weekOverWeekDelta > 0
              const wwNeg = m.weekOverWeekDelta < 0
              return (
                <tr key={m.userId} style={{ background: i % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                  {/* Member */}
                  <td style={{ ...tdStyle(), color: '#111318', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {m.userName}
                  </td>
                  {/* Team */}
                  <td style={{ ...tdStyle(), color: '#6B7384', whiteSpace: 'nowrap' }}>
                    {m.team}
                  </td>
                  {/* Score */}
                  <td style={{ ...tdStyle('right') }}>
                    <span style={{ fontWeight: 700, color, fontSize: 13 }}>{m.score}</span>
                  </td>
                  {/* Rating */}
                  <td style={tdStyle()}>
                    <span style={{
                      fontSize: 10, fontWeight: 600,
                      color, background: color + '15',
                      padding: '2px 7px', borderRadius: 999, whiteSpace: 'nowrap',
                    }}>{ratingLabel(m.rating)}</span>
                  </td>
                  {/* Completed */}
                  <td style={{ ...tdStyle('right'), fontWeight: 600, color: m.completedThisWeek > 0 ? '#45A870' : '#8C94A6' }}>
                    {m.completedThisWeek}
                  </td>
                  {/* Updates */}
                  <td style={{ ...tdStyle('right'), color: '#3D4455' }}>
                    {(m.updatesCount ?? 0) || <span style={{ color: '#BCC3D0' }}>0</span>}
                  </td>
                  {/* EOD */}
                  <td style={{ ...tdStyle('center') }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600,
                      color: m.hasEodLogToday ? '#45A870' : '#D94F4F',
                    }}>
                      {m.hasEodLogToday ? '✓' : '✗'}
                    </span>
                  </td>
                  {/* Output */}
                  <td style={{ ...tdStyle('right'), color: '#45A870', fontWeight: 600 }}>
                    {m.breakdown.output}<span style={{ fontSize: 9, color: '#A0A9BE', fontWeight: 400 }}>/50</span>
                  </td>
                  {/* Momentum */}
                  <td style={{ ...tdStyle('right'), color: '#5585E8', fontWeight: 600 }}>
                    {m.breakdown.momentum}<span style={{ fontSize: 9, color: '#A0A9BE', fontWeight: 400 }}>/20</span>
                  </td>
                  {/* Discipline */}
                  <td style={{ ...tdStyle('right'), color: '#E8A030', fontWeight: 600 }}>
                    {m.breakdown.discipline}<span style={{ fontSize: 9, color: '#A0A9BE', fontWeight: 400 }}>/20</span>
                  </td>
                  {/* Risk Penalty */}
                  <td style={{ ...tdStyle('right'), color: m.breakdown.risk < 0 ? '#D94F4F' : '#8C94A6', fontWeight: 600 }}>
                    {m.breakdown.risk}
                  </td>
                  {/* W/W Change */}
                  <td style={{ ...tdStyle('right'), fontWeight: 600, color: wwPos ? '#45A870' : wwNeg ? '#D94F4F' : '#8C94A6' }}>
                    {m.weekOverWeekDelta > 0 ? '+' : ''}{m.weekOverWeekDelta}
                  </td>
                  {/* Latest Achievement */}
                  <td style={{ ...tdStyle(), color: '#3D4455', maxWidth: 220, lineHeight: 1.4 }}>
                    {m.latestAchievement
                      ? <span title={m.latestAchievement}>{m.latestAchievement.length > 80 ? m.latestAchievement.slice(0, 80) + '…' : m.latestAchievement}</span>
                      : <span style={{ color: '#BCC3D0' }}>—</span>
                    }
                  </td>
                  {/* Latest Highlight */}
                  <td style={{ ...tdStyle(), color: '#6B7384', maxWidth: 180, lineHeight: 1.4 }}>
                    {m.latestHighlight
                      ? <span title={m.latestHighlight}>{m.latestHighlight.length > 60 ? m.latestHighlight.slice(0, 60) + '…' : m.latestHighlight}</span>
                      : <span style={{ color: '#BCC3D0' }}>—</span>
                    }
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── EOD entry type ───────────────────────────────────────────────────────────
interface EodEntry {
  user_id:      string
  full_name:    string
  team:         string
  log_date:     string
  summary:      string
  highlights:   string | null
  self_score:   number | null
  submitted_at: string
}

// ─── EOD Updates table ────────────────────────────────────────────────────────
function EodUpdatesTable({ token }: { token: string }) {
  const todayStr = new Date().toISOString().slice(0, 10)

  const [mode,       setMode]       = useState<'single' | 'range'>('single')
  const [singleDate, setSingleDate] = useState(todayStr)
  const [fromDate,   setFromDate]   = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 6); return d.toISOString().slice(0, 10)
  })
  const [toDate,     setToDate]     = useState(todayStr)
  const [entries,    setEntries]    = useState<EodEntry[]>([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const rangeError = useMemo(() => {
    if (mode !== 'range') return null
    const diff = Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000)
    if (diff < 1) return 'End date must be after start date (min 2 days apart).'
    if (diff > 30) return 'Range cannot exceed 30 days.'
    return null
  }, [mode, fromDate, toDate])

  const fetchLogs = useCallback(async () => {
    if (!token) return
    if (rangeError) return
    setLoading(true)
    setError(null)
    try {
      const from = mode === 'single' ? singleDate : fromDate
      const to   = mode === 'single' ? singleDate : toDate
      const res = await fetch(`/api/eod-logs/team?from=${from}&to=${to}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error ?? 'Failed to load EOD logs.')
        return
      }
      const j = await res.json()
      setEntries(j.entries ?? [])
    } catch {
      setError('Network error — please try again.')
    } finally {
      setLoading(false)
    }
  }, [token, mode, singleDate, fromDate, toDate, rangeError])

  // Auto-fetch when valid params change
  useEffect(() => { fetchLogs() }, [fetchLogs])

  const formatTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
    } catch { return '—' }
  }

  const formatDate = (d: string) => {
    try {
      return new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    } catch { return d }
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid #EEF0F4', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>EOD Updates</div>
          <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>What your team submitted — helps explain performance scores</div>
        </div>
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 4, background: '#F4F5F7', borderRadius: 8, padding: 3 }}>
          {(['single', 'range'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: mode === m ? '#fff' : 'transparent',
              color: mode === m ? '#111318' : '#8C94A6',
              boxShadow: mode === m ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}>{m === 'single' ? 'Single Date' : 'Date Range'}</button>
          ))}
        </div>
      </div>

      {/* Date controls */}
      <div style={{ padding: '12px 18px', borderBottom: '1px solid #EEF0F4', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {mode === 'single' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384' }}>Date</label>
            <input
              type="date"
              value={singleDate}
              max={todayStr}
              onChange={e => setSingleDate(e.target.value)}
              style={{ fontSize: 12, padding: '5px 9px', border: '1px solid #EEF0F4', borderRadius: 7, color: '#111318', outline: 'none' }}
            />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384' }}>From</label>
              <input
                type="date"
                value={fromDate}
                max={toDate}
                onChange={e => setFromDate(e.target.value)}
                style={{ fontSize: 12, padding: '5px 9px', border: '1px solid #EEF0F4', borderRadius: 7, color: '#111318', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384' }}>To</label>
              <input
                type="date"
                value={toDate}
                max={todayStr}
                min={fromDate}
                onChange={e => setToDate(e.target.value)}
                style={{ fontSize: 12, padding: '5px 9px', border: '1px solid #EEF0F4', borderRadius: 7, color: '#111318', outline: 'none' }}
              />
            </div>
            {rangeError && (
              <span style={{ fontSize: 11, color: '#D94F4F', fontWeight: 500 }}>{rangeError}</span>
            )}
            {!rangeError && (
              <span style={{ fontSize: 11, color: '#8C94A6' }}>
                {Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000) + 1} days
              </span>
            )}
          </>
        )}

        {loading && <span style={{ fontSize: 11, color: '#8C94A6' }}>Loading…</span>}
        {!loading && !error && <span style={{ fontSize: 11, color: '#8C94A6' }}>{entries.length} submission{entries.length !== 1 ? 's' : ''}</span>}
        {error && <span style={{ fontSize: 11, color: '#D94F4F' }}>{error}</span>}
      </div>

      {/* Table */}
      {entries.length === 0 && !loading ? (
        <div style={{ padding: '32px', textAlign: 'center', color: '#8C94A6', fontSize: 13 }}>
          No EOD submissions for this period.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#F8F9FB' }}>
                {['Date', 'Member', 'Team', 'Biggest Achievement', 'Highlight / Note', 'Self Score', 'Submitted'].map(h => (
                  <th key={h} style={{
                    padding: '9px 14px', textAlign: 'left', fontWeight: 600,
                    color: '#6B7384', fontSize: 10, textTransform: 'uppercase',
                    letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    borderBottom: '1px solid #EEF0F4',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.user_id}:${e.log_date}`} style={{ background: i % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                  <td style={{ padding: '10px 14px', color: '#111318', fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid #F0F1F3' }}>
                    {formatDate(e.log_date)}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#111318', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #F0F1F3' }}>
                    {e.full_name}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6B7384', whiteSpace: 'nowrap', borderBottom: '1px solid #F0F1F3' }}>
                    {e.team}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#3D4455', lineHeight: 1.5, borderBottom: '1px solid #F0F1F3', maxWidth: 300 }}>
                    {e.summary}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6B7384', lineHeight: 1.5, borderBottom: '1px solid #F0F1F3', maxWidth: 220 }}>
                    {e.highlights ?? <span style={{ color: '#BCC3D0' }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', borderBottom: '1px solid #F0F1F3' }}>
                    {e.self_score != null ? (
                      <span style={{ display: 'flex', gap: 2 }}>
                        {Array.from({ length: 5 }, (_, idx) => (
                          <span key={idx} style={{ color: idx < e.self_score! ? '#E8A030' : '#D0D5DF', fontSize: 13 }}>★</span>
                        ))}
                      </span>
                    ) : <span style={{ color: '#BCC3D0' }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#8C94A6', whiteSpace: 'nowrap', borderBottom: '1px solid #F0F1F3' }}>
                    {formatTime(e.submitted_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
type SortKey = 'score' | 'name' | 'risk' | 'trend' | 'weekOverWeek'

export default function TeamPerformancePage() {
  const [profile,    setProfile]    = useState<UserProfile | null>(null)
  const [members,    setMembers]    = useState<MemberPerfEntry[]>([])
  const [loading,    setLoading]    = useState(true)
  const [token,      setToken]      = useState('')
  const [sortBy,     setSortBy]     = useState<SortKey>('score')
  const [filterTeam, setFilterTeam] = useState('')
  const [progress,   setProgress]   = useState(0)
  const [showLoader, setShowLoader] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const { data: profileData } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()

      if (!profileData || !['admin', 'manager'].includes((profileData as UserProfile).role)) {
        router.push('/performance'); return
      }

      setProfile(profileData as UserProfile)
      const token = session.access_token
      setToken(token)

      // Single batch call — replaces N individual /api/performance-metrics calls
      try {
        const res = await fetch('/api/performance-metrics/team?period=monthly', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        if (res.ok) {
          setMembers((data.members ?? []) as MemberPerfEntry[])
        } else {
          console.error('[team perf] batch API error:', res.status, data?.error)
        }
      } catch (err) {
        console.error('[team perf] fetch failed:', err)
      }
      setLoading(false)
    }
    init()
  }, [supabase, router])

  const teams = useMemo(() => [...new Set(members.map(m => m.team))].sort(), [members])

  const sorted = useMemo(() => {
    const filtered = filterTeam ? members.filter(m => m.team === filterTeam) : members
    return [...filtered].sort((a, b) => {
      if (sortBy === 'score')       return b.score - a.score
      if (sortBy === 'name')        return a.userName.localeCompare(b.userName)
      if (sortBy === 'risk')        return (['high', 'medium', 'low'] as const).indexOf(a.riskLevel) - (['high', 'medium', 'low'] as const).indexOf(b.riskLevel)
      if (sortBy === 'trend')       return (['declining', 'volatile', 'stagnant', 'insufficient_data', 'consistent', 'improving'] as const).indexOf(a.trendClassification) - (['declining', 'volatile', 'stagnant', 'insufficient_data', 'consistent', 'improving'] as const).indexOf(b.trendClassification)
      if (sortBy === 'weekOverWeek') return b.weekOverWeekDelta - a.weekOverWeekDelta
      return 0
    })
  }, [members, sortBy, filterTeam])

  const goToMemberPerf = (userId: string) => router.push(`/performance?userId=${userId}`)

  useEffect(() => {
    if (!showLoader) return
    if (!loading) {
      setProgress(100)
      const t = setTimeout(() => setShowLoader(false), 650)
      return () => clearTimeout(t)
    }
    const iv = setInterval(() => {
      setProgress(prev => {
        if (prev >= 90) return prev
        return Math.min(90, prev + Math.random() * 2.5 + 0.5)
      })
    }, 120)
    return () => clearInterval(iv)
  }, [loading, showLoader])

  if (showLoader) return <TeamProgressLoader progress={progress} />

  const avgScore      = members.length ? Math.round(members.reduce((s, m) => s + m.score, 0) / members.length) : 0
  const totalOverdue  = members.reduce((s, m) => s + m.overdueCount, 0)
  const highRiskCount = members.filter(m => m.riskLevel === 'high').length
  const improvingPct  = members.length
    ? Math.round(members.filter(m => m.trendClassification === 'improving').length / members.length * 100)
    : 0
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <DashboardLayout
      profile={profile}
      title="Team Performance"
      subtitle={today}
      onSignOut={async () => { await supabase.auth.signOut(); router.push('/login') }}
      actions={
        <a href="/performance" style={{
          fontSize: 12, fontWeight: 600, color: '#8C94A6', textDecoration: 'none',
          border: '1px solid #EEF0F4', padding: '6px 14px', borderRadius: 7,
        }}>← My Report</a>
      }
    >
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Team summary: 4 KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          {[
            { label: 'Members',    value: members.length,  sub: 'members tracked' },
            { label: 'Avg Score',  value: `${avgScore}/100`, sub: 'team average today', accent: avgScore >= 58 ? '#45A870' : avgScore >= 38 ? '#E8A030' : '#D94F4F' },
            { label: 'High Risk',  value: highRiskCount,   sub: 'members', accent: highRiskCount > 0 ? '#D94F4F' : '#45A870' },
            { label: 'Improving',  value: `${improvingPct}%`, sub: 'on upward trend', accent: improvingPct >= 50 ? '#45A870' : '#E8A030' },
          ].map(({ label, value, sub, accent }) => (
            <div key={label} style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: accent ?? '#111318' }}>{value}</div>
              <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Overdue banner if critical */}
        {totalOverdue > 0 && (
          <div style={{
            background: '#D94F4F10', border: '1px solid #D94F4F30',
            borderRadius: 10, padding: '10px 16px',
            display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: '#3D4455',
          }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#D94F4F', flexShrink: 0 }} />
            <strong>{totalOverdue} overdue tasks</strong> across the team — these are penalising member scores daily.
          </div>
        )}

        {/* Controls: sort + filter */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ fontSize: 12, color: '#8C94A6', fontWeight: 500 }}>Sort by:</div>
          {([
            ['score',       'Score'],
            ['risk',        'Risk'],
            ['trend',       'Trend'],
            ['weekOverWeek','W/W Delta'],
            ['name',        'Name'],
          ] as [SortKey, string][]).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setSortBy(k)}
              style={{
                fontSize: 12, fontWeight: 500,
                padding: '5px 12px', borderRadius: 7,
                border: '1px solid #EEF0F4',
                background: sortBy === k ? '#111318' : '#fff',
                color: sortBy === k ? '#fff' : '#4A5261',
                cursor: 'pointer',
              }}
            >
              {lbl}
            </button>
          ))}
          {teams.length > 1 && (
            <select
              value={filterTeam}
              onChange={e => setFilterTeam(e.target.value)}
              style={{
                fontSize: 12, padding: '5px 10px', borderRadius: 7,
                border: '1px solid #EEF0F4', background: '#fff',
                color: '#4A5261', cursor: 'pointer', marginLeft: 'auto',
              }}
            >
              <option value="">All Teams</option>
              {teams.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>

        {/* Member grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
          {sorted.map(m => (
            <MemberCard key={m.userId} m={m} onViewProfile={goToMemberPerf} />
          ))}
        </div>

        {sorted.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>No members found.</div>
        )}

        {/* Performance Analysis table */}
        {sorted.length > 0 && <PerformanceAnalysisTable members={sorted} />}

        {/* EOD Updates table */}
        {token && <EodUpdatesTable token={token} />}
      </div>
    </DashboardLayout>
  )
}

'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { useViewAs } from '@/hooks/useViewAs'
import type { UserProfile, MemberPerfEntry, TrendClassification, StuckTask, TaskDetailData } from '@/lib/types'

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
        <div style={{ fontSize: 15, fontWeight: 600, color: '#111318', lineHeight: 1.6, marginBottom: 6 }}>
          Good things take a little time.
        </div>
        <div style={{ fontSize: 13, color: '#8C94A6', lineHeight: 1.6 }}>
          Please wait while we prepare your team performance report.
        </div>
      </div>
      <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ width: '100%', height: 6, background: '#EEF0F4', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%',
            background: 'linear-gradient(90deg, #5585E8, #45A870)',
            borderRadius: 999, transition: 'width 0.25s ease',
          }} />
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: '#8C94A6' }}>{pct}%</div>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ratingColor(rating: string) {
  return ({
    excellent:         '#45A870',
    good:              '#5585E8',
    average:           '#E8A030',
    needs_improvement: '#D94F4F',
    critical:          '#B03030',
  } as Record<string, string>)[rating] ?? '#8C94A6'
}

function ratingLabel(rating: string) {
  return ({
    excellent:         'Excellent',
    good:              'Good',
    average:           'Average',
    needs_improvement: 'Needs Work',
    critical:          'Critical',
  } as Record<string, string>)[rating] ?? '—'
}

const TREND_ICONS: Record<TrendClassification, string> = {
  improving:         '↑',
  declining:         '↓',
  volatile:          '~',
  consistent:        '→',
  stagnant:          '—',
  insufficient_data: '?',
}

const TREND_COLORS: Record<TrendClassification, string> = {
  improving:         '#45A870',
  declining:         '#D94F4F',
  volatile:          '#E8A030',
  consistent:        '#5585E8',
  stagnant:          '#8C94A6',
  insufficient_data: '#8C94A6',
}

// Higher = worse = shown first when sorting by risk
function riskSortValue(m: MemberPerfEntry): number {
  return (m.riskLevel === 'high' ? 2 : m.riskLevel === 'medium' ? 1 : 0) * 1000
    + m.overdueCount * 100
    + m.staleBlockedCount * 50
    + m.waitingCount * 20
    + (100 - m.score)
}

function formatSubmitTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  } catch { return '—' }
}

// ─── Section 1: Attention Required ───────────────────────────────────────────
interface AttentionFlag { text: string; critical: boolean }

function buildAttentionFlags(m: MemberPerfEntry): AttentionFlag[] {
  const flags: AttentionFlag[] = []
  if (m.staleBlockedCount > 0) flags.push({ text: `${m.staleBlockedCount} stale blocked`, critical: true })
  if (m.overdueCount > 0)      flags.push({ text: `${m.overdueCount} overdue`, critical: true })
  if (!m.hasEodLogToday)       flags.push({ text: 'No EOD', critical: false })
  if (m.score < 40)            flags.push({ text: `Score ${m.score}`, critical: false })
  return flags
}

function AttentionRequired({ members, onViewReasons }: {
  members: MemberPerfEntry[]
  onViewReasons: (m: MemberPerfEntry) => void
}) {
  const flagged = members.map(m => ({ m, flags: buildAttentionFlags(m) }))
    .filter(({ flags }) => flags.length > 0)
    .sort((a, b) => {
      const ca = a.flags.filter(f => f.critical).length
      const cb = b.flags.filter(f => f.critical).length
      return cb !== ca ? cb - ca : b.flags.length - a.flags.length
    })

  if (flagged.length === 0) {
    return (
      <div style={{
        background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10,
        padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 16 }}>✓</span>
        <span style={{ fontSize: 13, color: '#45A870', fontWeight: 600 }}>All clear today — no flags across the team.</span>
      </div>
    )
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid #EEF0F4', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>⚠</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111318' }}>Attention Required</span>
        <span style={{ fontSize: 12, color: '#8C94A6' }}>— {flagged.length} member{flagged.length !== 1 ? 's' : ''} need action today</span>
      </div>
      <div style={{ padding: '14px 18px', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {flagged.map(({ m, flags }) => {
          const hasCritical = flags.some(f => f.critical)
          return (
            <div
              key={m.userId}
              onClick={() => onViewReasons(m)}
              style={{
                border: `1px solid ${hasCritical ? '#D94F4F40' : '#E8A03040'}`,
                borderRadius: 8,
                padding: '9px 13px',
                background: hasCritical ? '#FFF6F6' : '#FFFCF0',
                cursor: 'pointer',
                minWidth: 160,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, color: '#111318', marginBottom: 5 }}>
                {m.userName}
                <span style={{ fontSize: 10, fontWeight: 400, color: '#8C94A6', marginLeft: 6 }}>{m.team}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {flags.map(f => (
                  <span key={f.text} style={{
                    fontSize: 10, fontWeight: 600,
                    color: f.critical ? '#D94F4F' : '#E8A030',
                    background: f.critical ? '#D94F4F14' : '#E8A03014',
                    padding: '2px 7px', borderRadius: 999,
                  }}>{f.text}</span>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Attention Reason Modal ───────────────────────────────────────────────────
function AttentionReasonModal({ member, onClose, onViewStuckTasks, onViewFullReport }: {
  member: MemberPerfEntry
  onClose: () => void
  onViewStuckTasks: () => void
  onViewFullReport: () => void
}) {
  const hasStuck = member.stuckTasks.length > 0

  // Build detailed reason rows from member data
  type Reason = { label: string; value: string; critical: boolean; showStuckBtn?: boolean }
  const reasons: Reason[] = []

  if (member.staleBlockedCount > 0) reasons.push({
    label: `${member.staleBlockedCount} task${member.staleBlockedCount !== 1 ? 's' : ''} stale-blocked`,
    value: 'No update in 2+ days — costing score points',
    critical: true,
    showStuckBtn: true,
  })
  if (member.overdueCount > 0) reasons.push({
    label: `${member.overdueCount} overdue task${member.overdueCount !== 1 ? 's' : ''}`,
    value: 'Past due date and not completed',
    critical: true,
  })
  if (member.waitingCount > 0) reasons.push({
    label: `${member.waitingCount} task${member.waitingCount !== 1 ? 's' : ''} waiting`,
    value: 'Blocked on someone or something external',
    critical: false,
    showStuckBtn: true,
  })
  if (!member.hasEodLogToday) reasons.push({
    label: 'No EOD log submitted today',
    value: 'Missing — costs 12 discipline points',
    critical: false,
  })
  if (member.score < 40) reasons.push({
    label: `Today's score is low: ${member.score}/100`,
    value: `Rating: ${member.score >= 30 ? 'Needs Work' : 'Critical'}`,
    critical: member.score < 30,
  })
  if (member.monthlyAvgScore < 50) reasons.push({
    label: `Monthly average score: ${member.monthlyAvgScore}/100`,
    value: 'Below acceptable threshold (50)',
    critical: false,
  })
  if (member.missedDays > 0) reasons.push({
    label: `Missed EOD this month: ${member.missedDays} day${member.missedDays !== 1 ? 's' : ''}`,
    value: 'Each missed day applies a discipline penalty',
    critical: false,
  })

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14,
          width: '100%', maxWidth: 520,
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 40px rgba(0,0,0,0.16)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #EEF0F4',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111318' }}>
              Attention Required — {member.userName}
            </div>
            <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 3 }}>
              {member.team}{member.position ? ` · ${member.position}` : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#F4F5F7', border: 'none', borderRadius: 7,
              width: 30, height: 30, cursor: 'pointer', fontSize: 14, color: '#6B7384',
              flexShrink: 0,
            }}
          >✕</button>
        </div>

        {/* Reasons list */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {reasons.map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              background: r.critical ? '#FFF6F6' : '#FFFCF0',
              border: `1px solid ${r.critical ? '#D94F4F28' : '#E8A03028'}`,
              borderRadius: 8, padding: '10px 14px',
            }}>
              <div style={{
                width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 5,
                background: r.critical ? '#D94F4F' : '#E8A030',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111318', lineHeight: 1.4 }}>
                  {r.label}
                </div>
                <div style={{ fontSize: 11.5, color: '#6B7384', marginTop: 2, lineHeight: 1.4 }}>
                  {r.value}
                </div>
                {r.showStuckBtn && hasStuck && (
                  <button
                    onClick={e => { e.stopPropagation(); onViewStuckTasks() }}
                    style={{
                      marginTop: 7, fontSize: 11, fontWeight: 600,
                      color: '#D94F4F', background: '#D94F4F08',
                      border: '1px solid #D94F4F20', borderRadius: 5,
                      padding: '3px 10px', cursor: 'pointer',
                    }}
                  >View Stuck Tasks →</button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer actions */}
        <div style={{
          padding: '12px 20px', borderTop: '1px solid #EEF0F4',
          display: 'flex', gap: 8, justifyContent: 'flex-end',
        }}>
          <button
            onClick={onClose}
            style={{
              fontSize: 12, fontWeight: 500, color: '#6B7384',
              background: '#F4F5F7', border: 'none',
              borderRadius: 7, padding: '7px 16px', cursor: 'pointer',
            }}
          >Close</button>
          <button
            onClick={onViewFullReport}
            style={{
              fontSize: 12, fontWeight: 600, color: '#fff',
              background: '#111318', border: 'none',
              borderRadius: 7, padding: '7px 16px', cursor: 'pointer',
            }}
          >View Full Report →</button>
        </div>
      </div>
    </div>
  )
}

// ─── Section 2: EOD Discipline Today ─────────────────────────────────────────
function EodDisciplineToday({ members }: { members: MemberPerfEntry[] }) {
  const submitted    = members.filter(m => m.hasEodLogToday)
  const notSubmitted = members.filter(m => !m.hasEodLogToday)

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{
        padding: '12px 18px', borderBottom: '1px solid #EEF0F4',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>EOD Discipline — Today</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#45A870' }}>✓ {submitted.length} submitted</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: notSubmitted.length > 0 ? '#D94F4F' : '#8C94A6' }}>
            ✗ {notSubmitted.length} pending
          </span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        {/* Submitted */}
        <div style={{ padding: '12px 18px', borderRight: '1px solid #EEF0F4' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#45A870', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Submitted
          </div>
          {submitted.length === 0
            ? <div style={{ fontSize: 12, color: '#8C94A6' }}>None yet</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {submitted.map(m => (
                  <div key={m.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                    <div>
                      <span style={{ fontWeight: 600, color: '#111318' }}>{m.userName}</span>
                      <span style={{ color: '#8C94A6', marginLeft: 6, fontSize: 11 }}>{m.team}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {m.selfScoreToday != null && (
                        <span style={{ fontSize: 11, color: '#E8A030', letterSpacing: 1 }}>
                          {'★'.repeat(m.selfScoreToday)}{'☆'.repeat(5 - m.selfScoreToday)}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: '#8C94A6' }}>{formatSubmitTime(m.eodSubmittedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
          }
        </div>
        {/* Not submitted */}
        <div style={{ padding: '12px 18px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#D94F4F', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
            Not Submitted
          </div>
          {notSubmitted.length === 0
            ? <div style={{ fontSize: 12, color: '#45A870' }}>Everyone submitted ✓</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {notSubmitted.map(m => (
                  <div key={m.userId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                    <div>
                      <span style={{ fontWeight: 600, color: '#111318' }}>{m.userName}</span>
                      <span style={{ color: '#8C94A6', marginLeft: 6, fontSize: 11 }}>{m.team}</span>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#D94F4F' }}>Pending</span>
                  </div>
                ))}
              </div>
          }
        </div>
      </div>
    </div>
  )
}

// ─── Section 3: Member Performance Table ─────────────────────────────────────
type MemberTableSortKey =
  | 'risk' | 'score' | 'name' | 'eod' | 'overdue' | 'completed' | 'monthlyAvg' | 'updates'

const TABLE_COLS: { key: MemberTableSortKey; label: string; align?: 'right' | 'center' }[] = [
  { key: 'name',       label: 'Member'       },
  { key: 'score',      label: 'Score',      align: 'right' },
  { key: 'eod',        label: 'EOD Today',  align: 'center' },
  { key: 'updates',    label: 'Updates',    align: 'right' },
  { key: 'completed',  label: 'Done (30d)', align: 'right' },
  { key: 'overdue',    label: 'Overdue',    align: 'right' },
  { key: 'risk',       label: 'Stale Blk',  align: 'right' },
  { key: 'monthlyAvg', label: 'Mo. Avg',    align: 'right' },
]

function MemberTable({ members, onViewProfile }: {
  members: MemberPerfEntry[]
  onViewProfile: (id: string) => void
}) {
  const [sortKey, setSortKey] = useState<MemberTableSortKey>('risk')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const handleSort = (key: MemberTableSortKey) => {
    if (key === sortKey) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      // sensible defaults: problems first
      setSortDir(key === 'name' ? 'asc' : key === 'eod' ? 'asc' : 'desc')
    }
  }

  const sorted = useMemo(() => {
    return [...members].sort((a, b) => {
      let cmp = 0
      if      (sortKey === 'risk')       cmp = riskSortValue(b) - riskSortValue(a)
      else if (sortKey === 'score')      cmp = a.score - b.score
      else if (sortKey === 'name')       cmp = a.userName.localeCompare(b.userName)
      else if (sortKey === 'eod')        cmp = (a.hasEodLogToday ? 1 : 0) - (b.hasEodLogToday ? 1 : 0)
      else if (sortKey === 'overdue')    cmp = b.overdueCount - a.overdueCount
      else if (sortKey === 'completed')  cmp = b.completedThisWeek - a.completedThisWeek
      else if (sortKey === 'monthlyAvg') cmp = b.monthlyAvgScore - a.monthlyAvgScore
      else if (sortKey === 'updates')    cmp = (b.updatesCount ?? 0) - (a.updatesCount ?? 0)
      return sortDir === 'asc' ? -cmp : cmp
    })
  }, [members, sortKey, sortDir])

  if (members.length === 0) return null

  const thStyle = (col: typeof TABLE_COLS[number]): React.CSSProperties => ({
    padding: '8px 12px',
    textAlign: col.align ?? 'left',
    fontWeight: 600,
    color: sortKey === col.key ? '#111318' : '#6B7384',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid #EEF0F4',
    background: '#F8F9FB',
    cursor: 'pointer',
    userSelect: 'none',
  })

  const td = (align?: 'right' | 'center'): React.CSSProperties => ({
    padding: '9px 12px',
    fontSize: 12,
    borderBottom: '1px solid #F0F1F3',
    textAlign: align ?? 'left',
    verticalAlign: 'middle',
  })

  const sortIcon = (key: MemberTableSortKey) => {
    if (sortKey !== key) return <span style={{ color: '#D0D5DF', marginLeft: 3 }}>↕</span>
    return <span style={{ color: '#5585E8', marginLeft: 3 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid #EEF0F4' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>Member Performance</div>
        <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>
          Sorted by risk by default — highest risk first. Click any column to re-sort.
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {TABLE_COLS.map(col => (
                <th key={col.key} style={thStyle(col)} onClick={() => handleSort(col.key)}>
                  {col.label}{sortIcon(col.key)}
                </th>
              ))}
              {/* Extra non-sortable columns */}
              <th style={{ ...thStyle({ key: 'name', label: '' }), cursor: 'default', color: '#6B7384', textAlign: 'center' }}>Waiting</th>
              <th style={{ ...thStyle({ key: 'name', label: '' }), cursor: 'default', color: '#6B7384', textAlign: 'center' }}>Missed EOD</th>
              <th style={{ ...thStyle({ key: 'name', label: '' }), cursor: 'default', color: '#6B7384', textAlign: 'center' }}>Trend</th>
              <th style={{ ...thStyle({ key: 'name', label: '' }), cursor: 'default' }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, i) => {
              const color     = ratingColor(m.rating)
              const trendCol  = TREND_COLORS[m.trendClassification]
              const trendIcon = TREND_ICONS[m.trendClassification]
              return (
                <tr key={m.userId} style={{ background: i % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                  {/* Member */}
                  <td style={td()}>
                    <div style={{ fontWeight: 600, color: '#111318', whiteSpace: 'nowrap' }}>{m.userName}</div>
                    <div style={{ fontSize: 10, color: '#8C94A6', marginTop: 1 }}>{m.team}{m.position ? ` · ${m.position}` : ''}</div>
                  </td>
                  {/* Score */}
                  <td style={{ ...td('right') }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color }}>{m.score}</span>
                    <div style={{ fontSize: 10, fontWeight: 600, color, marginTop: 1 }}>{ratingLabel(m.rating)}</div>
                  </td>
                  {/* EOD Today */}
                  <td style={{ ...td('center') }}>
                    {m.hasEodLogToday ? (
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#45A870' }}>✓</div>
                        <div style={{ fontSize: 10, color: '#8C94A6' }}>{formatSubmitTime(m.eodSubmittedAt)}</div>
                        {m.selfScoreToday != null && (
                          <div style={{ fontSize: 10, color: '#E8A030', letterSpacing: 1 }}>
                            {'★'.repeat(m.selfScoreToday)}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#D94F4F' }}>✗</span>
                    )}
                  </td>
                  {/* Updates Today */}
                  <td style={{ ...td('right'), color: (m.updatesCount ?? 0) > 0 ? '#111318' : '#BCC3D0', fontWeight: 600 }}>
                    {m.updatesCount ?? 0}
                  </td>
                  {/* Completed 30d */}
                  <td style={{ ...td('right'), color: m.completedThisWeek > 0 ? '#45A870' : '#8C94A6', fontWeight: 600 }}>
                    {m.completedThisWeek}
                  </td>
                  {/* Overdue */}
                  <td style={{ ...td('right') }}>
                    {m.overdueCount > 0
                      ? <span style={{ fontWeight: 700, color: '#D94F4F' }}>{m.overdueCount}</span>
                      : <span style={{ color: '#BCC3D0' }}>0</span>
                    }
                  </td>
                  {/* Stale Blocked */}
                  <td style={{ ...td('right') }}>
                    {m.staleBlockedCount > 0
                      ? <span style={{ fontWeight: 700, color: '#D94F4F' }}>{m.staleBlockedCount}</span>
                      : <span style={{ color: '#BCC3D0' }}>0</span>
                    }
                  </td>
                  {/* Monthly Avg */}
                  <td style={{ ...td('right') }}>
                    <span style={{ fontWeight: 600, color: m.monthlyAvgScore >= 60 ? '#45A870' : m.monthlyAvgScore >= 40 ? '#E8A030' : '#D94F4F' }}>
                      {m.monthlyAvgScore}
                    </span>
                  </td>
                  {/* Waiting */}
                  <td style={{ ...td('center') }}>
                    {m.waitingCount > 0
                      ? <span style={{ fontWeight: 700, color: '#E8A030' }}>{m.waitingCount}</span>
                      : <span style={{ color: '#BCC3D0' }}>0</span>
                    }
                  </td>
                  {/* Missed EOD */}
                  <td style={{ ...td('center') }}>
                    {m.missedDays > 0
                      ? <span style={{ fontWeight: 600, color: '#D94F4F' }}>{m.missedDays}d</span>
                      : <span style={{ color: '#BCC3D0' }}>0</span>
                    }
                  </td>
                  {/* Trend */}
                  <td style={{ ...td('center') }}>
                    <span style={{ fontSize: 14, color: trendCol }} title={m.trendClassification.replace('_', ' ')}>
                      {trendIcon}
                    </span>
                  </td>
                  {/* Full Report */}
                  <td style={td()}>
                    <button
                      onClick={() => onViewProfile(m.userId)}
                      style={{
                        fontSize: 11, fontWeight: 600, color: '#5585E8',
                        background: '#5585E808', border: '1px solid #5585E820',
                        borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Full Report →
                    </button>
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

// ─── Task Detail Modal ────────────────────────────────────────────────────────
function TaskDetailModal({ task, assigneeName, token, onClose }: {
  task: StuckTask
  assigneeName: string
  token: string
  onClose: () => void
}) {
  const [detail, setDetail]   = useState<TaskDetailData | null>(null)
  const [fetching, setFetching] = useState(true)
  const [fetchErr, setFetchErr] = useState(false)

  useEffect(() => {
    setFetching(true)
    setFetchErr(false)
    fetch(`/api/task-detail?taskId=${task.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => setDetail(d))
      .catch(() => setFetchErr(true))
      .finally(() => setFetching(false))
  }, [task.id, token])

  const formatDate = (iso: string | null) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) }
    catch { return '—' }
  }
  const formatRelative = (iso: string | null) => {
    if (!iso) return '—'
    try {
      const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)
      if (h < 1)  return 'Just now'
      if (h < 24) return `${h}h ago`
      const d = Math.floor(h / 24)
      return `${d}d ago`
    } catch { return '—' }
  }
  const formatDateTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-IN', {
        day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: true,
      })
    } catch { return '—' }
  }
  const formatAction = (action: string, from: string | null, to: string | null) => {
    if (action === 'status_changed') {
      if (from && to && from === to) return 'Progress update'
      return `Status: ${from ?? '?'} → ${to ?? '?'}`
    }
    if (action === 'acknowledged')     return 'Task acknowledged'
    if (action === 'delegated')        return 'Task delegated'
    if (action === 'created')          return 'Task created'
    if (action === 'deadline_changed') return 'Deadline updated'
    if (action === 'priority_changed') return 'Priority updated'
    if (action === 'escalated')        return 'Escalated'
    if (action === 'progress_update')  return 'Progress update'
    return action.replace(/_/g, ' ')
  }

  const statusColor = task.status === 'waiting' ? '#E8A030' : '#D94F4F'
  const statusBg    = task.status === 'waiting' ? '#E8A03014' : '#D94F4F14'
  const priorityColor = task.priority === 'high' ? '#D94F4F' : task.priority === 'medium' ? '#E8A030' : '#8C94A6'
  const priorityBg    = task.priority === 'high' ? '#D94F4F12' : task.priority === 'medium' ? '#E8A03012' : 'rgba(0,0,0,0.04)'
  const todayStr = new Date().toISOString().slice(0, 10)
  const isOverdue = !!task.due_date && task.due_date < todayStr

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontSize: 12 }}>
      <div style={{ width: 110, flexShrink: 0, color: '#8C94A6', fontWeight: 500, paddingTop: 1 }}>{label}</div>
      <div style={{ flex: 1, color: '#111318', lineHeight: 1.5 }}>{value}</div>
    </div>
  )

  const waitingOnDisplay = () => {
    if (!task.waiting_on_type) return <span style={{ color: '#BCC3D0' }}>—</span>
    if (task.waiting_on_type === 'team_member') return task.waiting_on_name ?? 'Team member'
    return task.waiting_on_text?.trim() ? `External — ${task.waiting_on_text.trim()}` : 'External'
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1010,
        background: 'rgba(0,0,0,0.40)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14,
          width: '100%', maxWidth: 560, maxHeight: '88vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 12px 48px rgba(0,0,0,0.20)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #EEF0F4', flexShrink: 0,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 14, fontWeight: 700, color: '#111318',
              lineHeight: 1.4, marginBottom: 7,
            }}>{task.title}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 10, fontWeight: 600, color: statusColor, background: statusBg,
                padding: '2px 8px', borderRadius: 999, textTransform: 'capitalize',
              }}>{task.status}</span>
              <span style={{
                fontSize: 10, fontWeight: 600, color: priorityColor, background: priorityBg,
                padding: '2px 8px', borderRadius: 999, textTransform: 'capitalize',
              }}>{task.priority} priority</span>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#F4F5F7', border: 'none', borderRadius: 7,
              width: 30, height: 30, cursor: 'pointer', fontSize: 14, color: '#6B7384',
              flexShrink: 0,
            }}
          >✕</button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Key info grid */}
          <div style={{
            background: '#F8F9FB', border: '1px solid #EEF0F4', borderRadius: 10,
            padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 9,
          }}>
            {row('Assigned to', <span style={{ fontWeight: 600 }}>{assigneeName}</span>)}
            {row('Created by', fetching
              ? <span style={{ color: '#BCC3D0' }}>…</span>
              : (detail?.created_by_name ?? <span style={{ color: '#BCC3D0' }}>—</span>)
            )}
            {row('Due date',
              task.due_date
                ? <span style={{ fontWeight: isOverdue ? 600 : 400, color: isOverdue ? '#D94F4F' : '#111318' }}>
                    {formatDate(task.due_date)}{isOverdue ? ' — overdue' : ''}
                  </span>
                : <span style={{ color: '#BCC3D0' }}>No due date</span>
            )}
            {row('Last updated', formatRelative(task.last_update_at))}
          </div>

          {/* Stuck reason */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Why it&apos;s stuck
            </div>
            <div style={{
              background: '#FFF6F6', border: '1px solid #D94F4F20',
              borderRadius: 9, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              {row('Waiting on', waitingOnDisplay())}
              {row('Blocker note',
                task.blocker_reason?.trim()
                  ? task.blocker_reason.trim()
                  : <span style={{ color: '#BCC3D0', fontStyle: 'italic' }}>No blocker note added</span>
              )}
            </div>
          </div>

          {/* Task note */}
          {task.note?.trim() && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Task note
              </div>
              <div style={{
                background: '#FAFBFC', border: '1px solid #EEF0F4',
                borderRadius: 9, padding: '10px 14px',
                fontSize: 12.5, color: '#3D4455', lineHeight: 1.55,
              }}>{task.note.trim()}</div>
            </div>
          )}

          {/* Recent activity */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Recent activity
            </div>
            {fetching ? (
              <div style={{ fontSize: 12, color: '#BCC3D0', padding: '10px 0' }}>Loading…</div>
            ) : fetchErr ? (
              <div style={{ fontSize: 12, color: '#D94F4F' }}>Could not load activity.</div>
            ) : !detail?.activity.length ? (
              <div style={{ fontSize: 12, color: '#BCC3D0', fontStyle: 'italic' }}>No activity recorded.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {detail.activity.map((a, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 10, padding: '9px 0',
                    borderBottom: i < detail.activity.length - 1 ? '1px solid #F0F1F3' : 'none',
                    alignItems: 'flex-start',
                  }}>
                    <div style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: '#5585E8', flexShrink: 0, marginTop: 5,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#111318' }}>
                          {formatAction(a.action, a.from_status, a.to_status)}
                        </span>
                        <span style={{ fontSize: 10, color: '#A0A8B8', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {formatDateTime(a.created_at)}
                        </span>
                      </div>
                      {a.actor_name && (
                        <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 1 }}>by {a.actor_name}</div>
                      )}
                      {a.note?.trim() && (
                        <div style={{
                          fontSize: 12, color: '#4A5261', marginTop: 4,
                          background: '#F4F5F7', borderRadius: 6,
                          padding: '5px 9px', lineHeight: 1.5,
                        }}>{a.note.trim()}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Stuck Tasks Modal ────────────────────────────────────────────────────────
function stuckReason(t: StuckTask): { text: string; faint: boolean } {
  // Priority: blocker_reason → waiting_on_text (external) → note → fallback
  if (t.blocker_reason?.trim())  return { text: t.blocker_reason.trim(),  faint: false }
  if (t.waiting_on_type === 'external' && t.waiting_on_text?.trim())
    return { text: t.waiting_on_text.trim(), faint: false }
  if (t.note?.trim())            return { text: t.note.trim(),            faint: false }
  return { text: 'No reason added', faint: true }
}

function waitingOnLabel(t: StuckTask): string {
  if (!t.waiting_on_type) return '—'
  if (t.waiting_on_type === 'team_member') return t.waiting_on_name ?? 'Team member'
  // external: prefer waiting_on_text, but it's already shown in Reason column — keep label short
  return t.waiting_on_text?.trim() ? `External — ${t.waiting_on_text.trim()}` : 'External'
}

function StuckTasksModal({ memberName, tasks, onClose }: {
  memberName: string
  tasks: StuckTask[]
  onClose: () => void
}) {
  const router = useRouter()
  const formatDate = (iso: string | null) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }
    catch { return '—' }
  }
  const formatRelative = (iso: string | null) => {
    if (!iso) return '—'
    try {
      const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000)
      if (hours < 24) return `${hours}h ago`
      const days = Math.floor(hours / 24)
      return `${days}d ago`
    } catch { return '—' }
  }

  const th: React.CSSProperties = {
    padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600,
    color: '#6B7384', textTransform: 'uppercase', letterSpacing: '0.05em',
    whiteSpace: 'nowrap', borderBottom: '1px solid #EEF0F4', background: '#F8F9FB',
  }
  const td = (extra?: React.CSSProperties): React.CSSProperties => ({
    padding: '10px 12px', fontSize: 12, borderBottom: '1px solid #F0F1F3',
    verticalAlign: 'top', ...extra,
  })

  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14,
          width: '100%', maxWidth: 900, maxHeight: '82vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 40px rgba(0,0,0,0.16)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 20px', borderBottom: '1px solid #EEF0F4',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111318' }}>
              Stuck Tasks — {memberName}
            </div>
            <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>
              {tasks.length} task{tasks.length !== 1 ? 's' : ''} waiting or stale-blocked
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#F4F5F7', border: 'none', borderRadius: 7,
              width: 30, height: 30, cursor: 'pointer', fontSize: 14, color: '#6B7384',
              flexShrink: 0,
            }}
          >✕</button>
        </div>

        {/* Table */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {tasks.length === 0 ? (
            <div style={{ padding: '40px', textAlign: 'center', color: '#8C94A6', fontSize: 13 }}>
              No stuck tasks found.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0 }}>
                <tr>
                  <th style={th}>Task</th>
                  <th style={{ ...th, width: 84 }}>Status</th>
                  <th style={{ ...th, width: 130 }}>Waiting On</th>
                  <th style={{ ...th }}>Reason / Note</th>
                  <th style={{ ...th, width: 84 }}>Last Update</th>
                  <th style={{ ...th, width: 76 }}>Due Date</th>
                  <th style={{ ...th, width: 56 }}></th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => {
                  const isWaiting   = t.status === 'waiting'
                  const statusColor = isWaiting ? '#E8A030' : '#D94F4F'
                  const statusBg    = isWaiting ? '#E8A03014' : '#D94F4F14'
                  const reason      = stuckReason(t)
                  const isOverdue   = !!t.due_date && t.due_date < todayStr
                  return (
                    <tr key={t.id} style={{ background: i % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                      {/* Task title */}
                      <td style={td({ maxWidth: 200 })}>
                        <div style={{
                          fontWeight: 500, color: '#111318', fontSize: 12.5,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }} title={t.title}>{t.title}</div>
                      </td>
                      {/* Status pill */}
                      <td style={td({ verticalAlign: 'middle' })}>
                        <span style={{
                          fontSize: 10, fontWeight: 600,
                          color: statusColor, background: statusBg,
                          padding: '2px 8px', borderRadius: 999,
                          textTransform: 'capitalize',
                        }}>{t.status}</span>
                      </td>
                      {/* Waiting On */}
                      <td style={td({ color: '#6B7384', fontSize: 11.5, verticalAlign: 'middle' })}>
                        {waitingOnLabel(t)}
                      </td>
                      {/* Reason / Note */}
                      <td style={td({ maxWidth: 280 })}>
                        <div style={{
                          fontSize: 12, lineHeight: 1.45,
                          color: reason.faint ? '#BCC3D0' : '#3D4455',
                          fontStyle: reason.faint ? 'italic' : 'normal',
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }} title={reason.text}>{reason.text}</div>
                      </td>
                      {/* Last Update */}
                      <td style={td({ color: '#8C94A6', fontSize: 11.5, whiteSpace: 'nowrap', verticalAlign: 'middle' })}>
                        {formatRelative(t.last_update_at)}
                      </td>
                      {/* Due Date */}
                      <td style={td({ whiteSpace: 'nowrap', verticalAlign: 'middle' })}>
                        {t.due_date ? (
                          <span style={{
                            fontSize: 11.5,
                            fontWeight: isOverdue ? 600 : 400,
                            color: isOverdue ? '#D94F4F' : '#6B7384',
                          }}>{formatDate(t.due_date)}</span>
                        ) : <span style={{ color: '#BCC3D0' }}>—</span>}
                      </td>
                      {/* Open link */}
                      <td style={td({ textAlign: 'right', verticalAlign: 'middle' })}>
                        <button
                          onClick={() => { onClose(); router.push(`/tasks/${t.id}`) }}
                          style={{
                            fontSize: 10, fontWeight: 600, color: '#5585E8',
                            background: '#5585E808', border: '1px solid #5585E820',
                            borderRadius: 5, padding: '3px 8px',
                            cursor: 'pointer', whiteSpace: 'nowrap',
                          }}
                        >Open →</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Section 4: Blockers & Waiting ───────────────────────────────────────────
function BlockersAndWaiting({ members, onViewStuckTasks }: {
  members: MemberPerfEntry[]
  onViewStuckTasks: (member: MemberPerfEntry) => void
}) {
  const stuck = members
    .filter(m => m.staleBlockedCount > 0 || m.waitingCount > 0)
    .sort((a, b) =>
      (b.staleBlockedCount * 2 + b.waitingCount) - (a.staleBlockedCount * 2 + a.waitingCount)
    )

  if (stuck.length === 0) return null

  const td: React.CSSProperties = {
    padding: '9px 14px', fontSize: 12, borderBottom: '1px solid #F0F1F3', verticalAlign: 'middle',
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid #EEF0F4' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>Blockers & Waiting</div>
        <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>
          Members with stuck work — stale blocked (&gt;2 days no update) or tasks waiting on someone.
          Per-task detail is in each member's Full Report.
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#F8F9FB' }}>
              {['Member', 'Team', 'Stale Blocked', 'Waiting', 'Total Stuck', 'Action'].map(h => (
                <th key={h} style={{
                  padding: '8px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600,
                  color: '#6B7384', textTransform: 'uppercase', letterSpacing: '0.05em',
                  whiteSpace: 'nowrap', borderBottom: '1px solid #EEF0F4',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stuck.map((m, i) => (
              <tr key={m.userId} style={{ background: i % 2 === 0 ? '#fff' : '#FAFBFC' }}>
                <td style={{ ...td, fontWeight: 600, color: '#111318', whiteSpace: 'nowrap' }}>{m.userName}</td>
                <td style={{ ...td, color: '#6B7384' }}>{m.team}</td>
                <td style={td}>
                  {m.staleBlockedCount > 0
                    ? <span style={{ fontWeight: 700, color: '#D94F4F' }}>{m.staleBlockedCount}</span>
                    : <span style={{ color: '#BCC3D0' }}>—</span>
                  }
                </td>
                <td style={td}>
                  {m.waitingCount > 0
                    ? <span style={{ fontWeight: 700, color: '#E8A030' }}>{m.waitingCount}</span>
                    : <span style={{ color: '#BCC3D0' }}>—</span>
                  }
                </td>
                <td style={td}>
                  <span style={{ fontWeight: 700, color: '#111318' }}>
                    {m.staleBlockedCount + m.waitingCount}
                  </span>
                </td>
                <td style={td}>
                  <button
                    onClick={() => onViewStuckTasks(m)}
                    style={{
                      fontSize: 11, fontWeight: 600, color: '#D94F4F',
                      background: '#D94F4F08', border: '1px solid #D94F4F20',
                      borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
                    }}
                  >
                    View Stuck Tasks →
                  </button>
                </td>
              </tr>
            ))}
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
      <div style={{ padding: '14px 18px', borderBottom: '1px solid #EEF0F4', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>EOD Log Detail</div>
          <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>What your team submitted — read summaries and achievements</div>
        </div>
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
                type="date" value={fromDate} max={toDate}
                onChange={e => setFromDate(e.target.value)}
                style={{ fontSize: 12, padding: '5px 9px', border: '1px solid #EEF0F4', borderRadius: 7, color: '#111318', outline: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384' }}>To</label>
              <input
                type="date" value={toDate} max={todayStr} min={fromDate}
                onChange={e => setToDate(e.target.value)}
                style={{ fontSize: 12, padding: '5px 9px', border: '1px solid #EEF0F4', borderRadius: 7, color: '#111318', outline: 'none' }}
              />
            </div>
            {rangeError && <span style={{ fontSize: 11, color: '#D94F4F', fontWeight: 500 }}>{rangeError}</span>}
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
export default function TeamPerformancePage() {
  const [profile,    setProfile]    = useState<UserProfile | null>(null)
  const [members,    setMembers]    = useState<MemberPerfEntry[]>([])
  const [loading,    setLoading]    = useState(true)
  const [token,      setToken]      = useState('')
  const [filterTeam, setFilterTeam] = useState('')
  const [progress,   setProgress]   = useState(0)
  const [showLoader, setShowLoader] = useState(true)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { enterViewMode } = useViewAs()

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
      const tok = session.access_token
      setToken(tok)

      try {
        const res = await fetch('/api/performance-metrics/team?period=monthly', {
          headers: { Authorization: `Bearer ${tok}` },
        })
        const data = await res.json()
        if (res.ok) setMembers((data.members ?? []) as MemberPerfEntry[])
        else console.error('[team perf] API error:', res.status, data?.error)
      } catch (err) {
        console.error('[team perf] fetch failed:', err)
      }
      setLoading(false)
    }
    init()
  }, [supabase, router])

  useEffect(() => {
    if (!showLoader) return
    if (!loading) {
      setProgress(100)
      const t = setTimeout(() => setShowLoader(false), 650)
      return () => clearTimeout(t)
    }
    const iv = setInterval(() => {
      setProgress(prev => prev >= 90 ? prev : Math.min(90, prev + Math.random() * 2.5 + 0.5))
    }, 120)
    return () => clearInterval(iv)
  }, [loading, showLoader])

  const teams = useMemo(() => [...new Set(members.map(m => m.team))].sort(), [members])

  const filtered = useMemo(
    () => filterTeam ? members.filter(m => m.team === filterTeam) : members,
    [members, filterTeam]
  )

  // Fetch the member's full profile, set it in ViewAsContext (localStorage),
  // then navigate. The performance page reads viewAsUserId from that context —
  // a bare ?userId= URL param is ignored by it.
  const goToMemberPerf = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('users')
      .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code, payroll_active, employment_type, payroll_notes')
      .eq('id', userId)
      .single()
    if (data) enterViewMode(userId, data as UserProfile)
    router.push('/performance')
  }, [supabase, router, enterViewMode])

  const [stuckModal,     setStuckModal]     = useState<MemberPerfEntry | null>(null)
  const [attentionModal, setAttentionModal] = useState<MemberPerfEntry | null>(null)

  const openStuckModal = useCallback((member: MemberPerfEntry) => {
    setAttentionModal(null)
    setStuckModal(member)
  }, [])

  const openAttentionModal = useCallback((member: MemberPerfEntry) => {
    setAttentionModal(member)
  }, [])

  if (showLoader) return <TeamProgressLoader progress={progress} />

  // Summary counts (used in page header area)
  const totalMembers  = filtered.length
  const noEodToday    = filtered.filter(m => !m.hasEodLogToday).length
  const totalOverdue  = filtered.reduce((s, m) => s + m.overdueCount, 0)
  const highRiskCount = filtered.filter(m => m.riskLevel === 'high').length

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
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Quick stat bar */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { label: 'Members', value: totalMembers, accent: undefined },
            { label: 'No EOD today', value: noEodToday, accent: noEodToday > 0 ? '#D94F4F' : '#45A870' },
            { label: 'Overdue tasks', value: totalOverdue, accent: totalOverdue > 0 ? '#D94F4F' : '#45A870' },
            { label: 'High risk', value: highRiskCount, accent: highRiskCount > 0 ? '#D94F4F' : '#45A870' },
          ].map(({ label, value, accent }) => (
            <div key={label} style={{
              background: '#fff', border: '1px solid #EEF0F4', borderRadius: 8,
              padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: accent ?? '#111318' }}>{value}</span>
              <span style={{ fontSize: 11, color: '#8C94A6' }}>{label}</span>
            </div>
          ))}

          {/* Team filter */}
          {teams.length > 1 && (
            <select
              value={filterTeam}
              onChange={e => setFilterTeam(e.target.value)}
              style={{
                marginLeft: 'auto', fontSize: 12, padding: '6px 10px', borderRadius: 7,
                border: '1px solid #EEF0F4', background: '#fff', color: '#4A5261', cursor: 'pointer',
              }}
            >
              <option value="">All Teams</option>
              {teams.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>

        {/* Section 1: Attention Required */}
        <AttentionRequired members={filtered} onViewReasons={openAttentionModal} />

        {/* Section 2: EOD Discipline Today */}
        <EodDisciplineToday members={filtered} />

        {/* Section 3: Member Performance Table */}
        <MemberTable members={filtered} onViewProfile={goToMemberPerf} />

        {/* Section 4: Blockers & Waiting */}
        <BlockersAndWaiting members={filtered} onViewStuckTasks={openStuckModal} />

        {/* Attention Reason Modal */}
        {attentionModal && (
          <AttentionReasonModal
            member={attentionModal}
            onClose={() => setAttentionModal(null)}
            onViewStuckTasks={() => openStuckModal(attentionModal)}
            onViewFullReport={() => { setAttentionModal(null); goToMemberPerf(attentionModal.userId) }}
          />
        )}

        {/* Stuck Tasks Modal */}
        {stuckModal && (
          <StuckTasksModal
            memberName={stuckModal.userName}
            tasks={stuckModal.stuckTasks}
            onClose={() => setStuckModal(null)}
          />
        )}

        {/* Section 5: EOD Log Detail */}
        {token && <EodUpdatesTable token={token} />}

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>
            No members found.
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}

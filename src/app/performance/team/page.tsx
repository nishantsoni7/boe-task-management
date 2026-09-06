'use client'

import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PerformanceLayout } from '@/components/layout/PerformanceLayout'
import { useViewAs } from '@/hooks/useViewAs'
import type { UserProfile, StuckTask } from '@/lib/types'
import { istToday } from '@/lib/istDate'
import { PERIOD_KEYS, type PeriodKey } from '@/lib/performanceCalendar'
import {
  classifyHttpStatus, toLoadError, shouldShowLoader, nextProgress,
  isRetryable, shouldRedirectToLogin, isEmptyResult,
  type LoadState,
} from '@/lib/performanceLoadState'
import {
  STATUS_LABEL, SORT_KEYS, SORT_LABEL, RANKING_LABEL,
  onTimeCompletionRate, eodOnTimeRate, activeDayRate, ackOnTimeRate,
  tasksCreatedTotal, sortMembers, filterMembers,
  recommendedAction, memberStrengths, memberConcerns,
  isRankable, insufficientDataReason, periodComparison,
  movementExplanation, adoptionExplanation,
  HOW_RANKING_WORKS, MIN_SCORED_DAYS_FOR_RANKING,
  type TeamDataset, type MemberMetrics, type OperationalStatus,
  type SortKey, type RankingKey, type EodDetail, type RankExplanation,
} from '@/lib/teamPerformance'
import {
  adoptionRate, withinWindowRate, avgFirstOpenLabel, hasAdoptionData,
} from '@/lib/performanceAdoption'
import { formatMinutesOfDay } from '@/lib/istDate'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

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


// ─── Shared visual language ───────────────────────────────────────────────────
// Same palette and shapes the rest of BOE uses; nothing new invented here.

const C = {
  ink:   '#111318',
  muted: '#6B7384',
  faint: '#8C94A6',
  line:  '#EEF0F4',
  hair:  '#F0F1F3',
  panel: '#F8F9FB',
  green: '#45A870',
  red:   '#D94F4F',
  amber: '#E8A030',
  blue:  '#5585E8',
} as const

const PERIOD_LABEL: Record<PeriodKey, string> = {
  today: 'Today', this_week: 'This Week', last_week: 'Last Week',
  this_month: 'This Month', last_month: 'Last Month', custom: 'Custom Range',
}

const STATUS_COLOR: Record<OperationalStatus, string> = {
  strong:             C.green,
  performing_well:    C.green,
  improving:          C.blue,
  stable:             C.muted,
  inconsistent:       C.amber,
  low_activity:       C.amber,
  declining:          C.red,
  critical_attention: C.red,
  insufficient_data:  C.faint,
}

const panel: React.CSSProperties = {
  background: '#fff', border: '1px solid ' + C.line, borderRadius: 12, padding: 14,
}

/** Renders a rate that may genuinely have no value. Never shows 0% for "unknown". */
function Rate({ value, suffix = '%' }: { value: number | null; suffix?: string }) {
  if (value === null) return <span style={{ color: C.faint }}>—</span>
  return <>{value}{suffix}</>
}

function Delta({ value, unit = 'pts' }: { value: number | null; unit?: string }) {
  if (value === null) return <span style={{ fontSize: 11, color: C.faint }}>no prior data</span>
  if (value === 0)    return <span style={{ fontSize: 11, color: C.faint }}>no change</span>
  const up = value > 0
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: up ? C.green : C.red }}>
      {up ? '↑' : '↓'} {Math.abs(value)} {unit}
    </span>
  )
}

function StatusPill({ status }: { status: OperationalStatus }) {
  const color = STATUS_COLOR[status]
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 20,
      fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
      color, background: color + '14', border: '1px solid ' + color + '33',
    }}>{STATUS_LABEL[status]}</span>
  )
}

function SectionTitle({ children, hint, aside }: {
  children: React.ReactNode
  hint?: string
  aside?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
      <h2 style={{ fontSize: 13, fontWeight: 700, color: C.ink, margin: 0 }}>{children}</h2>
      {hint && <span style={{ fontSize: 11, color: C.faint }}>{hint}</span>}
      {aside && <span style={{ marginLeft: 'auto' }}>{aside}</span>}
    </div>
  )
}

/**
 * A ranking or attention explanation, exactly as the server built it.
 *
 * The page does not compose these sentences. It receives them from the same
 * functions that produced the numbers in the table, so the drawer cannot quote a
 * figure the row above it disagrees with.
 */
function Explanation({ ex, tone = 'neutral' }: {
  ex: RankExplanation | null
  tone?: 'neutral' | 'concern'
}) {
  if (!ex) return null
  const accent = tone === 'concern' ? C.red : C.blue
  return (
    <div style={{
      background: C.panel, border: '1px solid ' + C.line, borderRadius: 10, padding: 12,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 6 }}>{ex.headline}</div>
      <ul style={{ margin: 0, padding: 0 }}>
        {ex.bullets.map(b => (
          <li key={b} style={{
            fontSize: 12, color: C.muted, marginBottom: 3, listStyle: 'none',
            display: 'flex', gap: 6, lineHeight: 1.45,
          }}>
            <span style={{ color: accent, fontWeight: 700, flexShrink: 0 }}>•</span>
            <span style={{ overflowWrap: 'anywhere' }}>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Confidence marker for the summary cards.
 *
 * Present whenever the holiday calendar does not cover the period. Without it the
 * six cards read as settled fact, when in truth every unrecorded holiday is
 * sitting in the data as a company-wide zero.
 */
function ConfidenceFlag({ data }: { data: TeamDataset }) {
  if (data.coverage.confidence === 'full') return null
  return (
    <span
      title={data.coverage.holidayCoverage.warning ?? 'Calendar coverage is incomplete for this period.'}
      style={{
        fontSize: 10, fontWeight: 700, color: C.amber,
        background: C.amber + '14', border: '1px solid ' + C.amber + '33',
        borderRadius: 20, padding: '1px 7px', whiteSpace: 'nowrap',
      }}
    >limited confidence</span>
  )
}

// ─── How ranking works ────────────────────────────────────────────────────────
/**
 * A small modal, not a permanent wall of formula. The owner needs to be able to
 * answer "why is this person above that person?" on demand — and needs never to
 * see the pillar arithmetic unless they ask.
 */
function HowRankingWorks({ onClose }: { onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 12, width: '100%', maxWidth: 560,
        maxHeight: 'calc(100vh - 32px)', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid ' + C.line,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>How ranking works</div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', fontSize: 20, color: C.faint,
            cursor: 'pointer', lineHeight: 1, padding: 0,
          }} aria-label="Close">×</button>
        </div>
        <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {HOW_RANKING_WORKS.map(s => (
            <div key={s.heading}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                {s.heading}
              </div>
              <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>{s.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function HowRankingWorksButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button onClick={onOpen} style={{
      fontSize: 11, fontWeight: 600, color: C.blue, background: 'none',
      border: '1px solid ' + C.line, borderRadius: 7, padding: '3px 9px',
      cursor: 'pointer', whiteSpace: 'nowrap',
    }}>How ranking works</button>
  )
}

// ─── Performance Coverage ─────────────────────────────────────────────────────
/**
 * Who is in this report, and how far the data can be trusted. Placed above the
 * rankings on purpose: "who is included" is the owner's first question, and
 * answering it after the league table is answering it too late.
 */
function CoverageSection({ data, onOpen }: {
  data: TeamDataset
  onOpen: (userId: string) => void
}) {
  const [showExcluded, setShowExcluded] = useState(false)
  const [showThin, setShowThin] = useState(false)
  const cov = data.coverage
  const hc  = cov.holidayCoverage

  const stat = (label: string, value: React.ReactNode, note?: string) => (
    <div key={label} style={{ flex: '1 1 120px', minWidth: 108 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{value}</div>
      {note && <div style={{ fontSize: 10.5, color: C.faint, lineHeight: 1.4 }}>{note}</div>}
    </div>
  )

  const linkish: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: C.blue, background: 'none',
    border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit',
  }

  return (
    <div style={panel}>
      <SectionTitle hint={data.period.label}>Performance Coverage</SectionTitle>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 12 }}>
        {stat('Employees tracked', cov.trackedCount)}
        {stat('Excluded', cov.excludedCount, cov.excludedCount > 0 ? 'not in any figure' : undefined)}
        {stat('Sufficient data', cov.sufficientCount, `${MIN_SCORED_DAYS_FOR_RANKING}+ scored days`)}
        {stat('Insufficient data', cov.insufficientCount, cov.insufficientCount > 0 ? 'shown but unranked' : undefined)}
        {stat('Eligible working days', cov.maxEligibleDays)}
        {stat('Calendar', hc.status === 'covered' ? 'Covered' : hc.status === 'partial' ? 'Partial' : 'No records',
          hc.holidayCount + ' holiday' + (hc.holidayCount === 1 ? '' : 's') + ' recorded')}
      </div>

      {/* The working-day rule, stated where the calendar figures are, so the reader
          does not have to open a modal to learn what "eligible working day" means.
          One line, because Coverage has to stay compact. */}
      <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
        Working days are Monday to Saturday. <strong style={{ fontWeight: 600 }}>Sundays are excluded</strong> for
        everyone, as are <strong style={{ fontWeight: 600 }}>company holidays recorded in the holiday calendar</strong> and
        any dates before an employee joined or after they left. Excluded days count neither for nor against anyone.
      </div>

      {/* The calendar warning. Deliberately loud: a confident-looking ranking
          computed from an empty holiday calendar is the single most misleading
          thing this page could show. */}
      {hc.warning && (
        <div style={{
          fontSize: 12, lineHeight: 1.5, color: '#92400E',
          background: '#FFFBEB', border: '1px solid #FDE68A',
          borderRadius: 9, padding: '9px 12px', marginBottom: 10,
        }}>
          <strong style={{ fontWeight: 700 }}>Holiday calendar incomplete for this period.</strong>{' '}
          {/* The bolded lead-in already carries the headline, so strip it from the
              body — and re-capitalise, since what follows was mid-sentence. */}
          {(() => {
            const rest = hc.warning.replace(/^Holiday calendar incomplete for this period — /, '')
            return rest.charAt(0).toUpperCase() + rest.slice(1)
          })()}
        </div>
      )}

      {/* Approved leave is not available. Said out loud, next to the numbers it
          affects, rather than buried in a code comment. */}
      <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5, marginBottom: 8 }}>
        {cov.attendanceNote}
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {cov.insufficientCount > 0 && (
          <button style={linkish} onClick={() => setShowThin(v => !v)}>
            {showThin ? 'Hide' : 'Show'} {cov.insufficientCount} unranked employee{cov.insufficientCount === 1 ? '' : 's'}
          </button>
        )}
        {/* Admin-only. A manager sees the count above but not the names or reasons. */}
        {cov.excluded && cov.excludedCount > 0 && (
          <button style={linkish} onClick={() => setShowExcluded(v => !v)}>
            {showExcluded ? 'Hide' : 'Show'} {cov.excludedCount} user{cov.excludedCount === 1 ? '' : 's'} excluded from Performance tracking
          </button>
        )}
      </div>

      {showThin && (
        <div style={{ marginTop: 10, borderTop: '1px solid ' + C.hair, paddingTop: 8 }}>
          {cov.insufficient.map(u => (
            <button key={u.userId} onClick={() => onOpen(u.userId)} style={{
              display: 'flex', width: '100%', gap: 8, justifyContent: 'space-between',
              padding: '6px 0', border: 'none', borderBottom: '1px solid ' + C.hair,
              background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left',
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>{u.userName}</span>
              <span style={{ fontSize: 11, color: C.muted, textAlign: 'right' }}>{u.reason}</span>
            </button>
          ))}
        </div>
      )}

      {showExcluded && cov.excluded && (
        <div style={{ marginTop: 10, borderTop: '1px solid ' + C.hair, paddingTop: 8 }}>
          <div style={{ fontSize: 10.5, color: C.faint, marginBottom: 6 }}>
            Administrator view. These accounts keep full system access, task history and View As —
            they are simply not measured. Change this per employee in Attendance → Employees.
          </div>
          {cov.excluded.map(u => (
            <div key={u.userId} style={{
              display: 'flex', gap: 8, justifyContent: 'space-between',
              padding: '6px 0', borderBottom: '1px solid ' + C.hair,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap' }}>
                {u.userName}
                <span style={{ fontWeight: 400, color: C.faint }}> · {u.team}</span>
              </span>
              <span style={{ fontSize: 11, color: C.muted, textAlign: 'right' }}>{u.note ?? 'No reason recorded'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── System Adoption ──────────────────────────────────────────────────────────
/**
 * Is Task Management being opened, and when? Reported entirely separately from
 * the score — see lib/performanceAdoption.ts for why it is not folded in.
 */
function AdoptionSection({ data, rows, onOpen }: {
  data: TeamDataset
  rows: MemberMetrics[]
  onOpen: (userId: string) => void
}) {
  const a = data.adoptionSummary
  const withData = rows.filter(m => hasAdoptionData(m.adoption))

  const stat = (label: string, value: React.ReactNode, note?: string) => (
    <div key={label} style={{ flex: '1 1 130px', minWidth: 116 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{value}</div>
      {note && <div style={{ fontSize: 10.5, color: C.faint, lineHeight: 1.4 }}>{note}</div>}
    </div>
  )

  return (
    <div style={panel}>
      <SectionTitle hint="reported separately — not part of the score">System Adoption</SectionTitle>

      {a.noDataYet ? (
        // The honest state until the event has been collecting for a while. Showing
        // 0% here would accuse the whole company of never opening the app.
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
          No reliable first-open records for this period yet.
          {a.recordingFrom
            ? ` Recording began on ${a.recordingFrom}; select a period on or after that date to see adoption.`
            : ' Recording starts from the first time an employee opens Task Management after this release.'}
          <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>
            Days before recording began are excluded from adoption rather than counted as missed opens.
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
            {stat('Employees measured', a.measuredEmployees)}
            {stat('Opened at least once', a.openedEmployees)}
            {stat('Opens recorded', a.totalOpens)}
            {stat('Within start window', a.totalWithinWindow,
              a.totalOpens > 0 ? Math.round(a.totalWithinWindow / a.totalOpens * 100) + '% of opens' : undefined)}
            {stat('After the window', a.totalLate)}
            {stat('Missing opens', a.totalMissing, 'recordable days with no open')}
            {stat('Average first open',
              a.avgFirstOpenMinutes === null ? '—' : formatMinutesOfDay(a.avgFirstOpenMinutes) + ' IST')}
          </div>

          {a.anyProvisionalWindow && (
            <div style={{ fontSize: 11.5, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 9, padding: '8px 11px', marginBottom: 10 }}>
              Some employees have no configured shift, so their start window uses a provisional
              default of {formatMinutesOfDay(600)} + 30 minutes. Set Office Timing in
              Attendance → Employees to measure them against their real shift.
            </div>
          )}

          {withData.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
                <thead>
                  <tr>
                    <th style={TH}>Employee</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Opened</th>
                    <th style={{ ...TH, textAlign: 'right' }}>In window</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Avg first open</th>
                    <th style={{ ...TH, textAlign: 'right' }}>Streak</th>
                  </tr>
                </thead>
                <tbody>
                  {withData.map(m => (
                    <tr key={m.userId} onClick={() => onOpen(m.userId)} style={{ cursor: 'pointer' }}>
                      <td style={TD({ fontWeight: 600 })}>{m.userName}</td>
                      <td style={TD({ textAlign: 'right' })}>
                        {m.adoption.openedDays}/{m.adoption.expectedDays - m.adoption.unrecordedDays}
                      </td>
                      <td style={TD({ textAlign: 'right' })}><Rate value={withinWindowRate(m.adoption)} /></td>
                      <td style={TD({ textAlign: 'right' })}>
                        {avgFirstOpenLabel(m.adoption) ?? <span style={{ color: C.faint }}>—</span>}
                      </td>
                      <td style={TD({ textAlign: 'right' })}>{m.adoption.streak}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────────
// One period drives every section below. Changing it refetches the whole
// dataset rather than re-slicing stale numbers on the client.

function FilterBar({
  periodKey, onPeriod, customFrom, customTo, onCustom,
  teams, team, onTeam, search, onSearch, sort, onSort, rangeError,
}: {
  periodKey: PeriodKey
  onPeriod: (k: PeriodKey) => void
  customFrom: string
  customTo: string
  onCustom: (from: string, to: string) => void
  teams: string[]
  team: string
  onTeam: (t: string) => void
  search: string
  onSearch: (s: string) => void
  sort: SortKey
  onSort: (s: SortKey) => void
  rangeError: string | null
}) {
  const control: React.CSSProperties = {
    fontSize: 12, padding: '6px 10px', borderRadius: 8,
    border: '1px solid ' + C.line, background: '#fff', color: C.ink, outline: 'none',
  }
  return (
    <div style={{ ...panel, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {PERIOD_KEYS.map(k => (
          <button
            key={k}
            onClick={() => onPeriod(k)}
            style={{
              ...control, cursor: 'pointer',
              fontWeight:  periodKey === k ? 700 : 500,
              color:       periodKey === k ? '#fff' : C.muted,
              background:  periodKey === k ? C.ink : '#fff',
              borderColor: periodKey === k ? C.ink : C.line,
            }}
          >{PERIOD_LABEL[k]}</button>
        ))}
      </div>

      {periodKey === 'custom' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" value={customFrom} max={istToday()}
                 onChange={e => onCustom(e.target.value, customTo)} style={control} />
          <span style={{ fontSize: 12, color: C.faint }}>to</span>
          <input type="date" value={customTo} max={istToday()}
                 onChange={e => onCustom(customFrom, e.target.value)} style={control} />
          {rangeError && <span style={{ fontSize: 11, color: C.red, fontWeight: 600 }}>{rangeError}</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select value={team} onChange={e => onTeam(e.target.value)} style={{ ...control, cursor: 'pointer' }}>
          <option value="">All Departments</option>
          {teams.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <input
          type="text" value={search} placeholder="Search employee…"
          onChange={e => onSearch(e.target.value)}
          style={{ ...control, flex: '1 1 180px', minWidth: 140 }}
        />

        <select value={sort} onChange={e => onSort(e.target.value as SortKey)} style={{ ...control, cursor: 'pointer' }}>
          {SORT_KEYS.map(k => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </select>
      </div>
    </div>
  )
}

// ─── Management summary cards ─────────────────────────────────────────────────
// Conclusions, not decoration. Each states a finding, its evidence, and how it
// moved since the previous equivalent period.

function SummaryCard({ label, value, context, reason, delta, flag, onClick }: {
  label: string
  value: string
  context?: string
  reason?: string
  delta?: React.ReactNode
  /** Data-completeness marker, shown beside the label rather than in the value. */
  flag?: React.ReactNode
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        ...panel, textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
        display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </div>
        {flag}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.ink, lineHeight: 1.15, overflowWrap: 'anywhere' }}>
        {value}
      </div>
      {context && <div style={{ fontSize: 12, color: C.muted, overflowWrap: 'anywhere' }}>{context}</div>}
      {reason  && <div style={{ fontSize: 11, color: C.faint, overflowWrap: 'anywhere' }}>{reason}</div>}
      {delta}
    </button>
  )
}

// ─── Owner briefing ───────────────────────────────────────────────────────────

function Briefing({ data, onOpen }: {
  data: TeamDataset
  onOpen: (userId: string) => void
}) {
  const rowStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: 2, width: '100%',
    padding: '9px 0', borderTop: 'none', borderLeft: 'none', borderRight: 'none',
    borderBottom: '1px solid ' + C.hair,
    textAlign: 'left', background: 'none', cursor: 'pointer', font: 'inherit',
  }

  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
      <div style={panel}>
        <SectionTitle hint={data.attention.length + ' of ' + data.metrics.length}>
          Requires Your Attention
        </SectionTitle>
        {data.attention.length === 0 ? (
          <div style={{ fontSize: 12, color: C.faint, padding: '10px 0' }}>
            Nothing flagged for this period.
          </div>
        ) : data.attention.map(item => (
          <button key={item.userId + item.issue} onClick={() => onOpen(item.userId)} style={rowStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 6, height: 6, borderRadius: 3, flexShrink: 0,
                background: item.severity === 'critical' ? C.red : C.amber,
              }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{item.userName}</span>
              <span style={{ fontSize: 12, color: C.muted }}>— {item.issue}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted, paddingLeft: 12 }}>{item.evidence}</div>
            <div style={{ fontSize: 11, color: C.blue, fontWeight: 600, paddingLeft: 12 }}>{item.action} →</div>
          </button>
        ))}
      </div>

      <div style={panel}>
        <SectionTitle>Doing Well</SectionTitle>
        {data.positives.length === 0 ? (
          <div style={{ fontSize: 12, color: C.faint, padding: '10px 0' }}>
            No standout results to report for this period.
          </div>
        ) : data.positives.map(item => (
          <button key={item.userId + item.headline} onClick={() => onOpen(item.userId)} style={rowStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 3, background: C.green, flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: C.ink }}>{item.userName}</span>
              <span style={{ fontSize: 12, color: C.muted }}>— {item.headline}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted, paddingLeft: 12 }}>{item.evidence}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Table primitives ─────────────────────────────────────────────────────────

const TH: React.CSSProperties = {
  padding: '8px 10px', textAlign: 'left', fontSize: 10, fontWeight: 700,
  color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
  whiteSpace: 'nowrap', borderBottom: '1px solid ' + C.line, background: C.panel,
}
const TD = (extra?: React.CSSProperties): React.CSSProperties => ({
  padding: '10px', fontSize: 12, borderBottom: '1px solid ' + C.hair,
  color: C.ink, whiteSpace: 'nowrap', ...extra,
})

// ─── Employee table ───────────────────────────────────────────────────────────

function MemberTable({ rows, data, onOpen }: {
  rows: MemberMetrics[]
  data: TeamDataset
  onOpen: (userId: string) => void
}) {
  if (rows.length === 0) {
    return (
      <div style={{ ...panel, textAlign: 'center', padding: '32px 16px', fontSize: 12, color: C.faint }}>
        No employees match the current filters.
      </div>
    )
  }

  return (
    <div style={{ ...panel, padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead>
            <tr>
              {/* Rank leads: the official position is the column the owner reads
                  first, and it comes from the server so it cannot disagree with
                  the cards or the drawer. */}
              <th style={{ ...TH, textAlign: 'right' }}>Rank</th>
              <th style={TH}>Employee</th>
              <th style={TH}>Department</th>
              <th style={{ ...TH, textAlign: 'right' }}>Score</th>
              <th style={{ ...TH, textAlign: 'right' }}>Change</th>
              <th style={{ ...TH, textAlign: 'right' }}>Active Days</th>
              <th style={{ ...TH, textAlign: 'right' }}>On Time</th>
              <th style={{ ...TH, textAlign: 'right' }}>Overdue</th>
              <th style={{ ...TH, textAlign: 'right' }}>EOD</th>
              <th style={{ ...TH, textAlign: 'right' }}>Adoption</th>
              <th style={TH}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(m => {
              const cls    = data.classifications[m.userId]
              const onTime = onTimeCompletionRate(m)
              const eodPc  = eodOnTimeRate(m)
              const active = activeDayRate(m)
              const rank   = data.ranks[m.userId]
              const cmp    = periodComparison(m)
              const adopt  = adoptionRate(m.adoption)
              return (
                <tr key={m.userId}
                    onClick={() => onOpen(m.userId)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = C.panel }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                  {/* An unranked employee shows an em dash, never a position they
                      did not earn. */}
                  <td style={TD({ textAlign: 'right', fontWeight: 700, color: rank ? C.ink : C.faint })}
                      title={rank ? undefined : (insufficientDataReason(m) ?? undefined)}>
                    {rank ?? '—'}
                  </td>
                  <td style={TD({ fontWeight: 600 })}>{m.userName}</td>
                  <td style={TD({ color: C.muted })}>{m.team}</td>
                  <td style={TD({ textAlign: 'right', fontWeight: 700 })}>
                    {m.score === null ? <span style={{ color: C.faint }}>—</span> : m.score}
                  </td>
                  {/* Only a like-for-like comparison shows a change. An
                      incomparable previous period reads "—", not a spurious jump. */}
                  <td style={TD({ textAlign: 'right' })}
                      title={cmp.note ?? undefined}>
                    {cmp.comparable
                      ? <Delta value={cmp.delta} />
                      : <span style={{ fontSize: 11, color: C.faint }}>—</span>}
                  </td>
                  <td style={TD({ textAlign: 'right', color: active !== null && active < 60 ? C.red : C.ink })}>
                    {m.eligibleDays === 0 ? '—' : m.activeDays + '/' + m.eligibleDays}
                  </td>
                  <td style={TD({ textAlign: 'right', color: onTime !== null && onTime < 60 ? C.red : C.ink })}>
                    <Rate value={onTime} />
                  </td>
                  <td style={TD({
                    textAlign: 'right',
                    fontWeight: m.overdueCount > 0 ? 700 : 400,
                    color: m.overdueCount > 0 ? C.red : C.faint,
                  })}>{m.overdueCount}</td>
                  <td style={TD({ textAlign: 'right', color: eodPc !== null && eodPc < 60 ? C.red : C.ink })}>
                    <Rate value={eodPc} />
                  </td>
                  {/* No adoption record is "—", not 0%. */}
                  <td style={TD({ textAlign: 'right', color: adopt !== null && adopt < 60 ? C.amber : C.ink })}
                      title={hasAdoptionData(m.adoption) ? undefined : 'No first-open records for this period'}>
                    <Rate value={adopt} />
                  </td>
                  <td style={TD()}>{cls ? <StatusPill status={cls.status} /> : null}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Rankings ─────────────────────────────────────────────────────────────────

function Rankings({ data, onOpen }: { data: TeamDataset; onOpen: (userId: string) => void }) {
  const [tab, setTab] = useState<RankingKey>('overall')
  const ranking = data.rankings.find(r => r.key === tab)

  const list = (title: string, rows: { userId: string; userName: string; value: string }[]) => (
    <div style={{ flex: '1 1 220px', minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, textTransform: 'uppercase', marginBottom: 6 }}>
        {title}
      </div>
      {rows.map((r, i) => (
        <button key={r.userId} onClick={() => onOpen(r.userId)} style={{
          display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8,
          padding: '6px 0', border: 'none', borderBottom: '1px solid ' + C.hair,
          background: 'none', cursor: 'pointer', font: 'inherit', textAlign: 'left',
        }}>
          <span style={{ fontSize: 12, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: C.faint, marginRight: 6 }}>{i + 1}</span>{r.userName}
          </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.muted, whiteSpace: 'nowrap' }}>{r.value}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div style={panel}>
      <SectionTitle>Rankings</SectionTitle>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {data.rankings.map(r => (
          <button key={r.key} onClick={() => setTab(r.key)} style={{
            fontSize: 11, padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
            fontWeight:  tab === r.key ? 700 : 500,
            color:       tab === r.key ? '#fff' : C.muted,
            background:  tab === r.key ? C.ink : '#fff',
            border: '1px solid ' + (tab === r.key ? C.ink : C.line),
          }}>{RANKING_LABEL[r.key]}</button>
        ))}
      </div>

      {!ranking || ranking.note ? (
        <div style={{ fontSize: 12, color: C.faint }}>{ranking?.note ?? 'No data'}</div>
      ) : (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {list('Top', ranking.top)}
          {ranking.bottom.length > 0 && list('Needs Improvement', ranking.bottom)}
        </div>
      )}
    </div>
  )
}

// ─── EOD management view ──────────────────────────────────────────────────────

const EOD_STATUS_STYLE: Record<EodDetail['status'], { label: string; color: string }> = {
  on_time: { label: 'On time', color: C.green },
  late:    { label: 'Late',    color: C.amber },
  missed:  { label: 'Missed',  color: C.red   },
  pending: { label: 'Pending', color: C.faint },
}

function EodSection({ data, rows, onOpen }: {
  data: TeamDataset
  rows: MemberMetrics[]
  onOpen: (userId: string) => void
}) {
  const [filter, setFilter] = useState<'all' | 'on_time' | 'late' | 'missed'>('all')

  const totals = useMemo(() => ({
    eligible:  rows.length,
    submitted: rows.reduce((s, m) => s + m.eodSubmitted, 0),
    onTime:    rows.reduce((s, m) => s + m.eodOnTime, 0),
    late:      rows.reduce((s, m) => s + m.eodLate, 0),
    missed:    rows.reduce((s, m) => s + m.eodMissed, 0),
  }), [rows])

  const shown = useMemo(() => rows.filter(m =>
    filter === 'all'     ? true :
    filter === 'on_time' ? m.eodOnTime > 0 :
    filter === 'late'    ? m.eodLate   > 0 :
                           m.eodMissed > 0
  ), [rows, filter])

  const stat = (label: string, value: React.ReactNode, color: string = C.ink) => (
    <div key={label} style={{ flex: '1 1 90px', minWidth: 80 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color }}>{value}</div>
    </div>
  )

  return (
    <div style={panel}>
      <SectionTitle hint={data.period.label}>EOD Discipline</SectionTitle>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        {stat('Employees', totals.eligible)}
        {stat('Submitted', totals.submitted)}
        {stat('On Time',   totals.onTime, C.green)}
        {stat('Late',      totals.late,   totals.late   > 0 ? C.amber : C.ink)}
        {stat('Missed',    totals.missed, totals.missed > 0 ? C.red   : C.ink)}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {(['all', 'on_time', 'late', 'missed'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            fontSize: 11, padding: '4px 10px', borderRadius: 20, cursor: 'pointer',
            fontWeight:  filter === f ? 700 : 500,
            color:       filter === f ? '#fff' : C.muted,
            background:  filter === f ? C.ink : '#fff',
            border: '1px solid ' + (filter === f ? C.ink : C.line),
          }}>{f === 'all' ? 'All' : EOD_STATUS_STYLE[f].label}</button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div style={{ fontSize: 12, color: C.faint, padding: '10px 0' }}>No employees match this filter.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr>
                <th style={TH}>Employee</th>
                <th style={{ ...TH, textAlign: 'right' }}>On Time</th>
                <th style={{ ...TH, textAlign: 'right' }}>Late</th>
                <th style={{ ...TH, textAlign: 'right' }}>Missed</th>
                <th style={{ ...TH, textAlign: 'right' }}>Rate</th>
                <th style={TH}>Latest Summary</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(m => {
                const latest = [...(data.evidence[m.userId]?.eodRows ?? [])].reverse().find(r => r.summary)
                return (
                  <tr key={m.userId} onClick={() => onOpen(m.userId)} style={{ cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = C.panel }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                    <td style={TD({ fontWeight: 600 })}>{m.userName}</td>
                    <td style={TD({ textAlign: 'right', color: C.green })}>{m.eodOnTime}</td>
                    <td style={TD({ textAlign: 'right', color: m.eodLate   > 0 ? C.amber : C.faint })}>{m.eodLate}</td>
                    <td style={TD({ textAlign: 'right', color: m.eodMissed > 0 ? C.red   : C.faint })}>{m.eodMissed}</td>
                    <td style={TD({ textAlign: 'right', fontWeight: 700 })}><Rate value={eodOnTimeRate(m)} /></td>
                    <td style={TD({ whiteSpace: 'normal', color: C.muted, maxWidth: 320 })}>
                      {latest?.summary
                        ? <span>{latest.summary.slice(0, 90)}{latest.summary.length > 90 ? '…' : ''}</span>
                        : <span style={{ color: C.faint }}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
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
  const [nowMs] = useState(() => Date.now())
  const formatDate = (iso: string | null) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) }
    catch { return '—' }
  }
  const formatRelative = (iso: string | null) => {
    if (!iso) return '—'
    try {
      const hours = Math.floor((nowMs - new Date(iso).getTime()) / 3600000)
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

  const todayStr = istToday()

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


// ─── Employee detail drawer ───────────────────────────────────────────────────

type DrawerTab = 'overview' | 'tasks' | 'eod' | 'score'

function EmployeeDrawer({ data, member, onClose, onViewStuck, onViewFullReport }: {
  data: TeamDataset
  member: MemberMetrics
  onClose: () => void
  onViewStuck: (m: MemberMetrics) => void
  onViewFullReport: (userId: string) => void
}) {
  const [tab, setTab] = useState<DrawerTab>('overview')

  const cls        = data.classifications[member.userId]
  const evidence   = data.evidence[member.userId]
  const strengths  = memberStrengths(member)
  const concerns   = memberConcerns(member)
  const action     = recommendedAction(member, cls?.status ?? 'insufficient_data')

  // The rank, its explanation and the period comparison all come from the server,
  // built from one ordering. The drawer displays them; it never re-derives them.
  const rank        = data.ranks[member.userId]
  const rankedTotal = Object.keys(data.ranks).length
  const explanation = data.explanations[member.userId] ?? null
  const cmp         = periodComparison(member)
  const adoptEx     = adoptionExplanation(member)

  // Which dates counted, and which were expected but empty. Both lists come from
  // the server's own activity calculation — deriving them here from
  // `TrendDay.inputs` would use a narrower definition of "active" than the
  // `activeDays` figure displayed next to them, and the two would disagree.
  const dateFacts = useMemo(() => {
    const trend = evidence?.trend ?? []
    return {
      missed:      Math.max(0, member.eligibleDays - member.activeDays),
      firstDate:   trend[0]?.date ?? null,
      lastDate:    trend[trend.length - 1]?.date ?? null,
      idleDates:   evidence?.idleDates   ?? [],
      activeDates: evidence?.activeDates ?? [],
    }
  }, [evidence, member.eligibleDays, member.activeDays])

  const metric = (label: string, value: React.ReactNode) => (
    <div key={label} style={{ flex: '1 1 108px', minWidth: 96 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{value}</div>
    </div>
  )

  const bullet = (text: string, color: string) => (
    <li key={text} style={{ fontSize: 12, color: C.muted, marginBottom: 4, listStyle: 'none', display: 'flex', gap: 6 }}>
      <span style={{ color, fontWeight: 700 }}>•</span>{text}
    </li>
  )

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.32)', backdropFilter: 'blur(2px)',
      display: 'flex', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#fff', width: '100%', maxWidth: 560, height: '100%',
        display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 40px rgba(0,0,0,0.16)',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 18px', borderBottom: '1px solid ' + C.line }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{member.userName}</div>
              <div style={{ fontSize: 12, color: C.muted }}>
                {member.team}{member.position ? ' · ' + member.position : ''}
              </div>
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', fontSize: 20, color: C.faint,
              cursor: 'pointer', lineHeight: 1, padding: 0,
            }}>×</button>
          </div>

          <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', marginTop: 12, flexWrap: 'wrap' }}>
            <div>
              <span style={{ fontSize: 26, fontWeight: 700, color: C.ink }}>
                {member.score === null ? '—' : member.score}
              </span>
              <span style={{ fontSize: 12, color: C.faint }}>/100</span>
            </div>
            {/* The official position, or an explicit statement that there is none. */}
            <div style={{ fontSize: 12, fontWeight: 700, color: rank ? C.ink : C.faint }}>
              {rank ? `Rank ${rank} of ${rankedTotal}` : 'Unranked'}
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>
              Previous: {member.prevScore === null ? '—' : member.prevScore}
            </div>
            {cmp.comparable
              ? <Delta value={cmp.delta} />
              : <span style={{ fontSize: 11, color: C.faint }}>not comparable</span>}
            {cls && <StatusPill status={cls.status} />}
          </div>
          {cls && <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>{cls.reason}</div>}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '10px 18px 0', borderBottom: '1px solid ' + C.line }}>
          {(['overview', 'tasks', 'eod', 'score'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              fontSize: 12, padding: '6px 12px', cursor: 'pointer',
              background: 'none', border: 'none',
              borderBottom: '2px solid ' + (tab === t ? C.ink : 'transparent'),
              fontWeight: tab === t ? 700 : 500,
              color: tab === t ? C.ink : C.muted,
            }}>
              {t === 'overview' ? 'Overview' : t === 'tasks' ? 'Tasks' : t === 'eod' ? 'EOD' : 'Score'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {tab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {/* Why this rank — first, because it is the question the drawer was
                  opened to answer. Server-built from the same values shown below. */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, textTransform: 'uppercase', marginBottom: 8 }}>
                  {rank ? 'Why this rank' : 'Ranking eligibility'}
                </div>
                <Explanation ex={explanation} />
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, textTransform: 'uppercase', marginBottom: 8 }}>
                  Recommended action
                </div>
                <div style={{
                  fontSize: 13, color: C.ink, fontWeight: 600, lineHeight: 1.45,
                  background: C.panel, border: '1px solid ' + C.line, borderRadius: 10, padding: 12,
                }}>{action}</div>
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {metric('Eligible days', member.eligibleDays)}
                {metric('Scored days',   member.scoredDays)}
                {metric('Active days',   member.eligibleDays === 0 ? '—' : member.activeDays + '/' + member.eligibleDays)}
                {metric('Completed',     member.tasksCompleted)}
                {metric('Created',       tasksCreatedTotal(member))}
                {metric('On-time rate',  <Rate value={onTimeCompletionRate(member)} />)}
                {metric('EOD on time',   <Rate value={eodOnTimeRate(member)} />)}
                {metric('Adoption',      <Rate value={adoptionRate(member.adoption)} />)}
              </div>

              {/* Inclusion and eligibility state, stated plainly. */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, textTransform: 'uppercase', marginBottom: 6 }}>
                  Eligibility
                </div>
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>
                  Included in Performance tracking.{' '}
                  {isRankable(member)
                    ? `Ranked — ${member.scoredDays} scored days meets the ${MIN_SCORED_DAYS_FOR_RANKING}-day minimum.`
                    : `Not ranked — ${insufficientDataReason(member)}.`}
                  {dateFacts.firstDate && (
                    <> Measured window: {dateFacts.firstDate} to {dateFacts.lastDate}.</>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.55, marginTop: 4 }}>
                  {member.eligibleDays} expected working days
                  {' · '}{dateFacts.missed} expected day{dateFacts.missed === 1 ? '' : 's'} with no activity
                  {' · '}Sundays, recorded company holidays and dates outside employment are
                  neutral and counted nowhere.
                </div>
              </div>

              {/* Period comparison, with both day counts so the reader can see it
                  was like-for-like. */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, textTransform: 'uppercase', marginBottom: 8 }}>
                  Versus previous period
                </div>
                <Explanation ex={movementExplanation(member)} />
              </div>

              {/* Adoption, kept visually separate from the score above. */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, textTransform: 'uppercase', marginBottom: 8 }}>
                  System adoption
                </div>
                <Explanation ex={adoptEx} />
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.green, textTransform: 'uppercase', marginBottom: 6 }}>
                  Doing well
                </div>
                {strengths.length === 0
                  ? <div style={{ fontSize: 12, color: C.faint }}>Nothing measurable to highlight this period.</div>
                  : <ul style={{ margin: 0, padding: 0 }}>{strengths.map(s => bullet(s, C.green))}</ul>}
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.red, textTransform: 'uppercase', marginBottom: 6 }}>
                  Needs attention
                </div>
                {concerns.length === 0
                  ? <div style={{ fontSize: 12, color: C.faint }}>No issues flagged this period.</div>
                  : <ul style={{ margin: 0, padding: 0 }}>{concerns.map(s => bullet(s, C.red))}</ul>}
              </div>

              {/* Evidence: the actual dates behind "active on N of M". */}
              {dateFacts.idleDates.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, textTransform: 'uppercase', marginBottom: 6 }}>
                    Expected working days with no activity
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
                    {dateFacts.idleDates.join(', ')}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'tasks' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {metric('Open now',        member.activeTasks)}
                {metric('Completed',       member.tasksCompleted)}
                {metric('Completed late',  member.tasksCompletedLate)}
                {metric('Overdue',         member.overdueCount)}
                {metric('High-pri overdue',member.highPriorityOverdue)}
                {metric('Oldest overdue',  member.oldestOverdueDays > 0 ? member.oldestOverdueDays + 'd' : '—')}
                {metric('Stale blocked',   member.staleBlockedCount)}
                {metric('Waiting',         member.waitingCount)}
                {metric('Self tasks',      member.tasksCreatedSelf)}
                {metric('Delegated',       member.tasksCreatedDelegated)}
                {metric('Ack on time',     <Rate value={ackOnTimeRate(member)} />)}
                {metric('Status updates',  member.statusUpdates)}
              </div>

              {(evidence?.stuckTasks.length ?? 0) > 0 && (
                <button onClick={() => onViewStuck(member)} style={{
                  alignSelf: 'flex-start', fontSize: 12, fontWeight: 600, color: C.blue,
                  background: 'none', border: '1px solid ' + C.line, borderRadius: 8,
                  padding: '7px 12px', cursor: 'pointer',
                }}>
                  View {evidence!.stuckTasks.length} stuck task{evidence!.stuckTasks.length === 1 ? '' : 's'} →
                </button>
              )}
            </div>
          )}

          {tab === 'eod' && (
            <div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
                {metric('Submitted', member.eodSubmitted)}
                {metric('On time',   member.eodOnTime)}
                {metric('Late',      member.eodLate)}
                {metric('Missed',    member.eodMissed)}
                {metric('Streak',    member.eodStreak)}
              </div>
              {(evidence?.eodRows.length ?? 0) === 0 ? (
                <div style={{ fontSize: 12, color: C.faint }}>No eligible working days in this period.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={TH}>Date</th>
                      <th style={TH}>Status</th>
                      <th style={TH}>Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...evidence!.eodRows].reverse().map(r => (
                      <tr key={r.date}>
                        <td style={TD({ whiteSpace: 'nowrap' })}>{r.date}</td>
                        <td style={TD({ color: EOD_STATUS_STYLE[r.status].color, fontWeight: 600 })}>
                          {EOD_STATUS_STYLE[r.status].label}
                        </td>
                        <td style={TD({ whiteSpace: 'normal', color: C.muted })}>
                          {r.summary
                            ? r.summary.slice(0, 80) + (r.summary.length > 80 ? '…' : '')
                            : <span style={{ color: C.faint }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'score' && (
            <div>
              {member.breakdown === null ? (
                <div style={{ fontSize: 12, color: C.faint }}>
                  No scored day in this period yet, so there is no breakdown to show.
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>
                    Most recent scored day in this period. The period score above is the
                    average across {member.scoredDays} scored day{member.scoredDays === 1 ? '' : 's'}.
                  </div>
                  {([
                    ['Output',     member.breakdown.output,     50],
                    ['Momentum',   member.breakdown.momentum,   20],
                    ['Discipline', member.breakdown.discipline, 20],
                  ] as const).map(([label, val, max]) => (
                    <div key={label} style={{ marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                        <span style={{ color: C.muted }}>{label}</span>
                        <span style={{ fontWeight: 700, color: C.ink }}>{val}/{max}</span>
                      </div>
                      <div style={{ height: 5, background: C.line, borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ width: (val / max * 100) + '%', height: '100%', background: C.green }} />
                      </div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 12 }}>
                    <span style={{ color: C.muted }}>Risk penalty</span>
                    <span style={{ fontWeight: 700, color: member.breakdown.risk < 0 ? C.red : C.green }}>
                      {member.breakdown.risk}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid ' + C.line }}>
          <button onClick={() => onViewFullReport(member.userId)} style={{
            fontSize: 12, fontWeight: 600, color: '#fff', background: C.ink,
            border: 'none', borderRadius: 8, padding: '9px 14px', cursor: 'pointer', width: '100%',
          }}>Open full performance report →</button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function TeamPerformancePage() {
  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [token,    setToken]    = useState('')
  const [data,     setData]     = useState<TeamDataset | null>(null)
  const [state,    setState]    = useState<LoadState>({ phase: 'loading' })
  const [progress, setProgress] = useState(0)
  // The loader is a one-shot introduction, not a per-refetch spinner. Once it
  // has been cleared — by success *or* by failure — later period changes show
  // the inline "Loading…" row instead.
  const [loaderDone, setLoaderDone] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const [periodKey,  setPeriodKey]  = useState<PeriodKey>('this_month')
  const [customFrom, setCustomFrom] = useState(() => istToday())
  const [customTo,   setCustomTo]   = useState(() => istToday())
  const [team,   setTeam]   = useState('')
  const [search, setSearch] = useState('')
  const [sort,   setSort]   = useState<SortKey>('needs_attention')

  const [openUserId, setOpenUserId] = useState<string | null>(null)
  const [stuckFor,   setStuckFor]   = useState<MemberMetrics | null>(null)
  const [showRankingHelp, setShowRankingHelp] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { enterViewMode } = useViewAs()

  // A custom range is validated before it is ever sent.
  const rangeError = useMemo(() => {
    if (periodKey !== 'custom') return null
    if (!customFrom || !customTo) return 'Pick both dates'
    if (customFrom > customTo)   return 'Start date must not be after end date'
    return null
  }, [periodKey, customFrom, customTo])

  useEffect(() => {
    const init = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) { router.push('/login'); return }

        const { data: profileData, error: profileError } = await supabase
          .from('users')
          .select('id, full_name, email, phone, role, team, position, is_active, created_at')
          .eq('id', session.user.id)
          .single()

        // A failed profile read is not the same as "not allowed" — surface it
        // rather than silently bouncing the user or hanging on the loader.
        if (profileError || !profileData) {
          console.error('[team-performance] caller profile lookup failed:', profileError)
          setState(toLoadError('server'))
          return
        }

        // Entry is NOT decided here. It was — `role` had to be admin or manager
        // — and that role test is what made Team Performance and Personal
        // Performance the same decision. It now belongs to
        // src/app/performance/team/layout.tsx, which resolves
        // `performance.view_team` and does not mount this component without it,
        // and to the two team APIs, which resolve the same capability from the
        // caller's own token. A check here could only ever be a third opinion
        // arriving after the screen had already mounted.
        setProfile(profileData as UserProfile)
        setToken(session.access_token)
      } catch (e) {
        console.error('[team-performance] authentication check failed:', e)
        setState(toLoadError('network'))
      }
    }
    init()
  }, [supabase, router])

  // One fetch per period change. Department, search and sort are applied to the
  // dataset in memory — they never change what was measured, only what is shown.
  useEffect(() => {
    // An invalid custom range is reported inline in the filter bar and never
    // sent; the previously loaded dataset stays on screen.
    if (!token || rangeError) return

    let cancelled = false

    const qs = new URLSearchParams({ period: periodKey })
    if (periodKey === 'custom') { qs.set('from', customFrom); qs.set('to', customTo) }

    const run = async () => {
      setState({ phase: 'loading' })
      try {
        const r = await fetch('/api/performance-metrics/team?' + qs.toString(), {
          headers: { Authorization: 'Bearer ' + token },
        })

        if (!r.ok) {
          const detail = await r.text().catch(() => '')
          const kind = classifyHttpStatus(r.status)
          // Technical cause to the console only — the panel stays generic so a
          // database message can never reach a standard user.
          console.error(
            `[team-performance] GET /api/performance-metrics/team failed: ${r.status}`,
            detail,
          )
          if (cancelled) return
          if (shouldRedirectToLogin(kind)) { router.push('/login'); return }
          setState(toLoadError(kind))
          return
        }

        const body = await r.json() as TeamDataset
        if (cancelled) return
        setData(body)
        setState({ phase: 'ready' })
      } catch (e) {
        console.error('[team-performance] request threw:', e)
        if (cancelled) return
        setState(toLoadError('network'))
      }
    }

    run()
    return () => { cancelled = true }
  }, [token, periodKey, customFrom, customTo, rangeError, retryCount, router])

  // Progress is driven by the request's own state. Any terminal outcome —
  // dataset, 403, 500, dropped connection — completes the bar and retires the
  // loader. It is keyed on `state`, never on "is data still null", which is
  // what used to strand it at 90% whenever the request failed.
  useEffect(() => {
    if (loaderDone) return

    // Settled — `shouldShowLoader` has already hidden it. Latch the flag so a
    // later period change shows the inline row instead of the full-screen
    // loader again.
    if (state.phase !== 'loading') {
      const t = setTimeout(() => setLoaderDone(true), 0)
      return () => clearTimeout(t)
    }

    const iv = setInterval(() => {
      setProgress(prev => nextProgress(prev, state, Math.random() * 2.5 + 0.5))
    }, 120)
    return () => clearInterval(iv)
  }, [state, loaderDone])

  const teams = useMemo(
    () => [...new Set((data?.metrics ?? []).map(m => m.team).filter(Boolean))].sort(),
    [data],
  )

  const visible = useMemo(() => {
    if (!data) return []
    // Filtering and sorting are presentation only. Neither recomputes a score, and
    // the official rank travels with the dataset (`data.ranks`), so narrowing to a
    // department reorders the rows without inventing a new ranking.
    const filtered = filterMembers(data.metrics, { team, search })
    return sortMembers(filtered, sort)
  }, [data, team, search, sort])

  const openMember = useMemo(
    () => visible.find(m => m.userId === openUserId)
       ?? data?.metrics.find(m => m.userId === openUserId)
       ?? null,
    [visible, data, openUserId],
  )

  const goToFullReport = useCallback(async (userId: string) => {
    const { data: full } = await supabase
      .from('users')
      .select(USER_PROFILE_COLUMNS)
      .eq('id', userId)
      .single()
    if (full) enterViewMode(userId, full as UserProfile)
    router.push('/performance')
  }, [supabase, router, enterViewMode])

  if (shouldShowLoader(state, loaderDone)) return <TeamProgressLoader progress={progress} />

  const summary = data?.teamSummary
  const cardGrid: React.CSSProperties = {
    display: 'grid', gap: 10,
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
  }

  return (
    <PerformanceLayout
      profile={profile}
      canViewTeam
      title="Team Performance"
      subtitle={data ? data.period.label : 'Loading…'}
      onSignOut={async () => { await supabase.auth.signOut(); router.push('/login') }}
      actions={
        <a href="/performance" style={{
          fontSize: 12, fontWeight: 600, color: C.faint, textDecoration: 'none',
          border: '1px solid ' + C.line, padding: '6px 14px', borderRadius: 7,
        }}>← My Report</a>
      }
    >
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        <FilterBar
          periodKey={periodKey} onPeriod={setPeriodKey}
          customFrom={customFrom} customTo={customTo}
          onCustom={(f, t) => { setCustomFrom(f); setCustomTo(t) }}
          teams={teams} team={team} onTeam={setTeam}
          search={search} onSearch={setSearch}
          sort={sort} onSort={setSort}
          rangeError={rangeError}
        />

        {state.phase === 'error' && (
          <div style={{
            ...panel, borderColor: C.red + '55', background: C.red + '0C',
            display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.red }}>{state.message}</div>
            <div style={{ fontSize: 11, color: C.muted }}>
              {state.kind === 'forbidden'
                ? 'Ask an administrator if you need access to this page.'
                : 'The technical details have been written to the browser console.'}
            </div>
            {isRetryable(state.kind) && (
              <button
                onClick={() => setRetryCount(n => n + 1)}
                style={{
                  fontSize: 12, fontWeight: 600, color: '#fff', background: C.ink,
                  border: 'none', borderRadius: 7, padding: '7px 16px', cursor: 'pointer',
                }}
              >Retry</button>
            )}
          </div>
        )}

        {state.phase === 'loading' && (
          <div style={{ ...panel, textAlign: 'center', fontSize: 12, color: C.faint }}>
            Loading {PERIOD_LABEL[periodKey].toLowerCase()}…
          </div>
        )}

        {data && isEmptyResult(state, data.metrics.length) && (
          <div style={{ ...panel, textAlign: 'center', padding: '36px 16px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>No measurable employees</div>
            <div style={{ fontSize: 12, color: C.faint, marginTop: 4 }}>
              Nobody had an expected working day in {data.period.label}.
            </div>
          </div>
        )}

        {state.phase === 'ready' && data && data.metrics.length > 0 && summary && (
          <>
            {/* Management summary. Each card carries the confidence flag whenever
                the calendar limits how much these conclusions can be trusted. */}
            <div style={cardGrid}>
              <SummaryCard
                label="Best Performer"
                value={summary.best?.userName ?? 'Insufficient Data'}
                context={summary.best ? summary.best.score + '/100 · rank 1 of ' + Object.keys(data.ranks).length : undefined}
                reason={summary.best?.detail}
                flag={<ConfidenceFlag data={data} />}
                onClick={summary.best ? () => setOpenUserId(summary.best!.userId) : undefined}
              />
              <SummaryCard
                label="Most Improved"
                value={summary.improved?.userName ?? 'Insufficient Data'}
                context={summary.improved ? summary.improved.score + '/100' : 'No comparable previous period'}
                reason={summary.improved?.detail}
                onClick={summary.improved ? () => setOpenUserId(summary.improved!.userId) : undefined}
              />
              <SummaryCard
                label="Needs Immediate Attention"
                value={data.attention[0]?.userName ?? 'Nothing flagged'}
                context={data.attention[0]?.issue}
                reason={data.attention[0]?.evidence}
                onClick={data.attention[0] ? () => setOpenUserId(data.attention[0].userId) : undefined}
              />
              <SummaryCard
                label="Team Average"
                value={summary.teamAverage === null ? '—' : summary.teamAverage + '/100'}
                context={data.coverage.sufficientCount + ' of ' + data.coverage.trackedCount + ' employees measured'}
                reason={data.coverage.insufficientCount > 0
                  ? data.coverage.insufficientCount + ' excluded from the average for insufficient data'
                  : undefined}
                flag={<ConfidenceFlag data={data} />}
                delta={<Delta value={summary.teamAverageDelta} />}
              />
              <SummaryCard
                label="EOD On-Time Rate"
                value={summary.eodOnTimeRate === null ? '—' : summary.eodOnTimeRate + '%'}
                context={summary.eodLate + ' late · ' + summary.eodMissed + ' missed'}
                reason={summary.eodOnTimeRate === null ? 'No EOD expected in this period' : undefined}
              />
              <SummaryCard
                label="On-Time Completion"
                value={summary.onTimeCompletionRate === null ? '—' : summary.onTimeCompletionRate + '%'}
                context={summary.totalCompleted + ' completed · ' + summary.lateCompletions + ' late'}
                reason={summary.onTimeCompletionRate === null ? 'No tasks with due dates completed' : undefined}
              />
            </div>

            {/* Coverage before conclusions: "who is in this?" is the first question. */}
            <CoverageSection data={data} onOpen={setOpenUserId} />

            <Briefing data={data} onOpen={setOpenUserId} />

            <div>
              <SectionTitle
                hint={visible.length + ' of ' + data.metrics.length + ' shown'}
                aside={<HowRankingWorksButton onOpen={() => setShowRankingHelp(true)} />}
              >
                Employees
              </SectionTitle>
              <MemberTable rows={visible} data={data} onOpen={setOpenUserId} />
            </div>

            <Rankings data={data} onOpen={setOpenUserId} />

            <AdoptionSection data={data} rows={visible} onOpen={setOpenUserId} />

            <EodSection data={data} rows={visible} onOpen={setOpenUserId} />

            {/* Activity roll-up */}
            <div style={panel}>
              <SectionTitle hint="Meaningful actions, not logins">System Usage</SectionTitle>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                {([
                  ['Active in period',    data.activitySummary.activeInPeriod,   C.ink],
                  ['Active every day',    data.activitySummary.fullyActive,   C.green],
                  ['Low activity',        data.activitySummary.lowActivity,   data.activitySummary.lowActivity > 0 ? C.red : C.ink],
                  ['No completions',      data.activitySummary.noCompletions, data.activitySummary.noCompletions > 0 ? C.amber : C.ink],
                  ['Created no tasks',    data.activitySummary.noCreations,   C.muted],
                  ['EOD without tasks',   data.activitySummary.eodOnly,       data.activitySummary.eodOnly > 0 ? C.amber : C.ink],
                ] as const).map(([label, value, color]) => (
                  <div key={label} style={{ flex: '1 1 110px', minWidth: 100 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.faint, textTransform: 'uppercase' }}>{label}</div>
                    <div style={{ fontSize: 17, fontWeight: 700, color }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {openMember && data && (
        <EmployeeDrawer
          data={data}
          member={openMember}
          onClose={() => setOpenUserId(null)}
          onViewStuck={m => { setOpenUserId(null); setStuckFor(m) }}
          onViewFullReport={goToFullReport}
        />
      )}

      {stuckFor && data && (
        <StuckTasksModal
          memberName={stuckFor.userName}
          tasks={data.evidence[stuckFor.userId]?.stuckTasks ?? []}
          onClose={() => setStuckFor(null)}
        />
      )}

      {showRankingHelp && <HowRankingWorks onClose={() => setShowRankingHelp(false)} />}
    </PerformanceLayout>
  )
}

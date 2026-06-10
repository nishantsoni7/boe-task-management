'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { useViewAs } from '@/hooks/useViewAs'
import type {
  UserProfile, PerformanceData, PerformanceAudit, TrendDay,
  ScoreBreakdown, TrendClassification,
} from '@/lib/types'

// ─── Progress loader ──────────────────────────────────────────────────────────
function PerformanceProgressLoader({ progress }: { progress: number }) {
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
          Please wait while we prepare your performance report.
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

// ─── Score ring (SVG) ─────────────────────────────────────────────────────────
function ScoreRing({ score, rating }: { score: number; rating: string }) {
  const r    = 52
  const circ = 2 * Math.PI * r
  const dash = circ * (score / 100)

  const ringColor = {
    excellent:         '#45A870',
    good:              '#5585E8',
    average:           '#E8A030',
    needs_improvement: '#D94F4F',
    critical:          '#B03030',
  }[rating] ?? '#8C94A6'

  const label = {
    excellent:         'Excellent',
    good:              'Good',
    average:           'Average',
    needs_improvement: 'Needs Work',
    critical:          'Critical',
  }[rating] ?? '—'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg width={130} height={130} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={65} cy={65} r={r} fill="none" stroke="#EEF0F4" strokeWidth={10} />
        <circle
          cx={65} cy={65} r={r} fill="none"
          stroke={ringColor} strokeWidth={10}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.7s ease' }}
        />
        <text
          x={65} y={60} textAnchor="middle" dominantBaseline="middle"
          fill="#111318" fontSize={28} fontWeight={700}
          style={{ transform: 'rotate(90deg) translate(0px, -130px)', fontFamily: 'var(--font-syne)' }}
        >{score}</text>
        <text
          x={65} y={82} textAnchor="middle" dominantBaseline="middle"
          fill="#8C94A6" fontSize={11}
          style={{ transform: 'rotate(90deg) translate(0px, -130px)', fontFamily: 'var(--font-dm-sans)' }}
        >/100</text>
      </svg>
      <span style={{
        fontSize: 13, fontWeight: 600, color: ringColor,
        background: ringColor + '18', padding: '3px 12px', borderRadius: 999,
      }}>{label}</span>
    </div>
  )
}

// ─── Metric card ──────────────────────────────────────────────────────────────
function MetricCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #EEF0F4',
      borderRadius: 10, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ fontSize: 11, color: '#8C94A6', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent ?? '#111318', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#8C94A6' }}>{sub}</div>}
    </div>
  )
}

// ─── Score breakdown bar ──────────────────────────────────────────────────────
function BreakdownBar({ label, earned, max, color }: { label: string; earned: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(100, (earned / max) * 100))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 80, fontSize: 12, color: '#6B7384', fontWeight: 500, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 6, background: '#EEF0F4', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
      </div>
      <div style={{ width: 52, textAlign: 'right', fontSize: 12, fontWeight: 600, color: earned < 0 ? '#D94F4F' : '#111318', flexShrink: 0 }}>
        {earned < 0 ? earned : `+${earned}`} / {max}
      </div>
    </div>
  )
}

function ScoreBreakdownPanel({ breakdown }: { breakdown: ScoreBreakdown }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Score Breakdown</div>
      <BreakdownBar label="Output"     earned={breakdown.output}     max={50}  color="#45A870" />
      <BreakdownBar label="Momentum"   earned={breakdown.momentum}   max={20}  color="#5585E8" />
      <BreakdownBar label="Discipline" earned={breakdown.discipline} max={20}  color="#E8A030" />
      <BreakdownBar label="Risk"       earned={breakdown.risk}       max={-40} color="#D94F4F" />
    </div>
  )
}

// ─── Trend classification ─────────────────────────────────────────────────────
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

// ─── Trend bars ───────────────────────────────────────────────────────────────
function TrendBars({ trend }: { trend: TrendDay[] }) {
  const max = Math.max(...trend.map(d => d.score), 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
      {trend.map((d) => {
        const heightPct = (d.score / max) * 100
        const color = d.score >= 75 ? '#45A870' : d.score >= 58 ? '#5585E8' : d.score >= 38 ? '#E8A030' : '#D94F4F'
        const isToday = d.date === new Date().toISOString().slice(0, 10)
        return (
          <div
            key={d.date}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
            title={`${d.date}: ${d.score}/100 (Output ${d.breakdown.output}, Momentum ${d.breakdown.momentum}, Discipline ${d.breakdown.discipline}, Risk ${d.breakdown.risk})`}
          >
            <div style={{
              width: '100%', height: `${heightPct}%`, minHeight: 4,
              background: color, borderRadius: '3px 3px 0 0',
              opacity: isToday ? 1 : 0.6,
              outline: isToday ? `2px solid ${color}` : 'none',
              outlineOffset: 1,
              transition: 'height 0.4s ease',
            }} />
            <div style={{ fontSize: 9, color: '#8C94A6', whiteSpace: 'nowrap' }}>
              {new Date(d.date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short' }).slice(0, 2)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── AI Audit panel ───────────────────────────────────────────────────────────
function AuditPanel({ audit, loading, onGenerate }: {
  audit: PerformanceAudit | null
  loading: boolean
  onGenerate: () => void
}) {
  if (loading) {
    return (
      <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '20px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#E8A030', animation: 'pulse 1.2s infinite' }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>AI Audit</span>
        </div>
        <div style={{ color: '#8C94A6', fontSize: 13 }}>Analysing your performance data…</div>
      </div>
    )
  }

  if (!audit) {
    return (
      <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '20px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>AI Audit</span>
          <button
            onClick={onGenerate}
            style={{
              fontSize: 12, fontWeight: 600,
              background: '#111318', color: '#fff',
              border: 'none', borderRadius: 7,
              padding: '6px 14px', cursor: 'pointer',
            }}
          >Run Audit</button>
        </div>
        <div style={{ fontSize: 12, color: '#8C94A6' }}>
          Get AI coaching on your day — what worked, what didn&apos;t, and how to improve.
        </div>
      </div>
    )
  }

  const verdictColor = audit.progressive ? '#45A870' : audit.progressiveLabel === 'Moderate Day' ? '#E8A030' : '#D94F4F'

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: verdictColor }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>AI Audit</span>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600, color: verdictColor,
          background: verdictColor + '18', padding: '3px 10px', borderRadius: 999,
        }}>{audit.progressiveLabel}</span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: '#4A5261', lineHeight: 1.6 }}>{audit.verdict}</p>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Insights</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {audit.insights.map((insight, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#5585E8', marginTop: 6, flexShrink: 0 }} />
              <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.55 }}>{insight}</div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>How to improve</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {audit.suggestions.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: '#E8A030',
                background: '#E8A03018', borderRadius: 4,
                padding: '1px 5px', marginTop: 2, flexShrink: 0,
              }}>{i + 1}</div>
              <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.55 }}>{s}</div>
            </div>
          ))}
        </div>
      </div>
      <button
        onClick={onGenerate}
        style={{
          alignSelf: 'flex-start',
          fontSize: 11, fontWeight: 500, color: '#8C94A6',
          background: 'transparent', border: '1px solid #EEF0F4',
          borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
        }}
      >Regenerate</button>
    </div>
  )
}

// ─── Score guide (collapsible) ────────────────────────────────────────────────
function ScoreGuide() {
  const [open, setOpen] = useState(false)

  return (
    <div style={{ border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 16px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3D4455' }}>How is this score calculated?</span>
        <span style={{
          fontSize: 11, color: '#8C94A6',
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.2s', display: 'inline-block',
        }}>▾</span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 16, borderTop: '1px solid #F0F1F3' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#45A870', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, marginTop: 12 }}>
              ✓ You gain points when you…
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[
                { pts: '+8 to +22', text: 'Complete a task (Low +8, Medium +15, High +22)' },
                { pts: '+3',        text: 'Acknowledge a new task within 4 hours of it being assigned' },
                { pts: '+4',        text: 'Post a status update on a task you\'re working on' },
                { pts: '+4',        text: 'Resolve a task that was blocked' },
                { pts: '+12',       text: 'Submit your End-of-Day log' },
                { pts: '+5',        text: 'Stay active — any task action counts' },
              ].map(({ pts, text }) => (
                <div key={text} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#45A870', background: '#45A87015', borderRadius: 5, padding: '1px 6px', flexShrink: 0, whiteSpace: 'nowrap' }}>{pts}</span>
                  <span style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.5 }}>{text}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#D94F4F', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
              ✗ You lose points when you have…
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[
                { pts: '−5 each', text: 'An overdue task (past its due date and not completed)' },
                { pts: '−8 each', text: 'A task stuck as Blocked for more than 2 days with no update' },
              ].map(({ pts, text }) => (
                <div key={text} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#D94F4F', background: '#D94F4F12', borderRadius: 5, padding: '1px 6px', flexShrink: 0, whiteSpace: 'nowrap' }}>{pts}</span>
                  <span style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.5 }}>{text}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: '#F8F9FB', borderRadius: 8, padding: '10px 14px', border: '1px solid #EEF0F4' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#5585E8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Daily habit to keep a good score
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {[
                'When a task is assigned to you, acknowledge it the same day.',
                'Update the status of tasks you are actively working on.',
                'Complete tasks before their due date — overdue tasks cost points every day.',
                'If a task is blocked, add a note or escalate — do not leave it silent.',
                'Submit your EOD log before you close your laptop.',
              ].map((tip, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <span style={{ fontSize: 11, color: '#5585E8', flexShrink: 0, marginTop: 2 }}>›</span>
                  <span style={{ fontSize: 12.5, color: '#4A5261', lineHeight: 1.5 }}>{tip}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── EOD Log form ─────────────────────────────────────────────────────────────
type EodSaveState = 'idle' | 'saving' | 'saved' | 'error'

function EodLogForm({ existing, token, onSaved }: {
  existing: { summary: string; highlights: string | null; self_score: number | null } | null
  token: string
  onSaved: (log: { summary: string; self_score: number | null }) => void
}) {
  const [summary,   setSummary]   = useState(existing?.summary ?? '')
  const [selfScore, setSelfScore] = useState<number>(existing?.self_score ?? 0)
  const [saveState, setSaveState] = useState<EodSaveState>(existing ? 'saved' : 'idle')
  const [errorMsg,  setErrorMsg]  = useState('')

  const submit = async () => {
    if (!summary.trim()) return
    setSaveState('saving')
    setErrorMsg('')
    try {
      const res = await fetch('/api/daily-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ summary, self_score: selfScore || null }),
      })
      if (res.ok) {
        setSaveState('saved')
        onSaved({ summary, self_score: selfScore || null })
      } else {
        const body = await res.json().catch(() => ({}))
        setErrorMsg(body.error ?? 'Failed to save. Please try again.')
        setSaveState('error')
      }
    } catch {
      setErrorMsg('Network error. Please check your connection and try again.')
      setSaveState('error')
    }
  }

  const isSaving  = saveState === 'saving'
  const isSaved   = saveState === 'saved'
  const isError   = saveState === 'error'
  const btnLabel  = isSaving ? 'Saving…' : 'Update Log'

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111318', display: 'flex', alignItems: 'center', gap: 8 }}>
          End-of-Day Log
          {isSaved && (
            <span style={{ fontSize: 11, fontWeight: 500, color: '#45A870', background: '#45A87015', padding: '2px 8px', borderRadius: 5 }}>
              ✓ Saved just now
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#8C94A6' }}>+12 pts discipline</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384', display: 'block', marginBottom: 4 }}>
            Today&apos;s Key Work Done <span style={{ color: '#D94F4F' }}>*</span>
          </label>
          <textarea
            value={summary}
            onChange={e => { setSummary(e.target.value); if (saveState !== 'saving') setSaveState('idle'); setErrorMsg('') }}
            placeholder="Briefly write the important work you completed today..."
            rows={3}
            style={{
              width: '100%', resize: 'vertical',
              fontSize: 13, color: '#111318', lineHeight: 1.5,
              border: isError ? '1px solid #D94F4F' : '1px solid #EEF0F4', borderRadius: 7,
              padding: '8px 10px', outline: 'none',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384', display: 'block', marginBottom: 6 }}>
            How was your day?
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                onClick={() => { setSelfScore(n); if (saveState !== 'saving') setSaveState('idle') }}
                style={{
                  width: 32, height: 32, borderRadius: 8,
                  border: selfScore >= n ? '2px solid #E8A030' : '1px solid #EEF0F4',
                  background: selfScore >= n ? '#E8A03015' : '#fff',
                  cursor: 'pointer', fontSize: 16,
                }}
              >★</button>
            ))}
          </div>
        </div>
      </div>
      {isError && (
        <div style={{ fontSize: 12, color: '#D94F4F', background: '#D94F4F0D', border: '1px solid #D94F4F30', borderRadius: 6, padding: '8px 12px' }}>
          {errorMsg}
        </div>
      )}
      <button
        onClick={submit}
        disabled={isSaving || !summary.trim()}
        style={{
          alignSelf: 'flex-start',
          fontSize: 13, fontWeight: 600,
          background: '#111318', color: '#fff',
          border: 'none', borderRadius: 8,
          padding: '9px 20px', cursor: isSaving || !summary.trim() ? 'not-allowed' : 'pointer',
          opacity: isSaving || !summary.trim() ? 0.5 : 1,
        }}
      >{btnLabel}</button>
    </div>
  )
}

// ─── Day Score Modal ──────────────────────────────────────────────────────────
type SelectedDay = {
  date:     string
  trendDay: import('@/lib/types').TrendDay | undefined
  status:   DayStatus
}

function DayScoreModal({ day, onClose }: { day: SelectedDay; onClose: () => void }) {
  const { date, trendDay, status } = day

  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short',
  })

  const hasFullData = !!trendDay

  // ── Scoring thresholds (0-100 scale) ──────────────────────────────────────
  const totalScore = hasFullData
    ? trendDay!.breakdown.total
    : status === 'submitted' ? 12 : status === 'missed' ? -12 : 0

  const performanceLabel =
    totalScore >= 80 ? 'Excellent Performance' :
    totalScore >= 60 ? 'Good Performance'      :
    totalScore >= 40 ? 'Average Performance'   :
                       'Needs Improvement'

  const scoreColor =
    totalScore >= 60 ? '#45A870' :
    totalScore >= 40 ? '#E8A030' :
                       '#D94F4F'

  const scoreDisplayLabel = hasFullData
    ? `${totalScore}/100`
    : (status === 'submitted' ? '+12 pts' : status === 'missed' ? '−12 pts' : '—')

  // ── Build coaching content from real data only ─────────────────────────────
  const positives: string[] = []
  const negatives: string[] = []
  const improvements: string[] = []

  if (hasFullData) {
    const { breakdown, inputs } = trendDay!
    const totalCompleted = inputs.completedHigh + inputs.completedMedium + inputs.completedLow

    // What went well
    if (inputs.hasEodLog)
      positives.push(`EOD log submitted on time (+12 discipline points)`)
    if (inputs.completedHigh > 0)
      positives.push(`Completed ${inputs.completedHigh} high-priority task${inputs.completedHigh > 1 ? 's' : ''} (+${inputs.completedHigh * 22} output points)`)
    if (inputs.completedMedium > 0)
      positives.push(`Completed ${inputs.completedMedium} medium-priority task${inputs.completedMedium > 1 ? 's' : ''} (+${inputs.completedMedium * 15} output points)`)
    if (inputs.completedLow > 0)
      positives.push(`Completed ${inputs.completedLow} low-priority task${inputs.completedLow > 1 ? 's' : ''} (+${inputs.completedLow * 8} output points)`)
    if (inputs.statusUpdates > 0)
      positives.push(`Updated tasks ${inputs.statusUpdates} time${inputs.statusUpdates > 1 ? 's' : ''} during the day (+${Math.min(inputs.statusUpdates * 4, 16)} momentum points)`)
    if (breakdown.risk === 0)
      positives.push('No overdue or blocked tasks — clean risk score')

    // What reduced the score
    if (!inputs.hasEodLog)
      negatives.push('EOD log was not submitted — missed +12 discipline points')
    if (totalCompleted === 0)
      negatives.push('No tasks completed — task output was lower than expected')
    else if (inputs.completedHigh === 0)
      negatives.push('No high-priority task completed — output could be higher')
    if (inputs.statusUpdates === 0)
      negatives.push('No task status updates — momentum points were not earned')
    if (breakdown.risk < 0)
      negatives.push(`Risk points reduced your total score (overdue or stale blocked tasks)`)

    // How to improve tomorrow
    if (!inputs.hasEodLog)
      improvements.push('Submit your EOD log before you close your laptop — it only takes 2 minutes')
    if (totalCompleted === 0)
      improvements.push('Complete at least one task tomorrow to earn output points')
    if (inputs.completedHigh === 0 && totalCompleted > 0)
      improvements.push('Try to complete at least one high-priority task for a stronger output score')
    if (inputs.statusUpdates === 0)
      improvements.push('Post a quick status update on active tasks during the day')
    if (breakdown.risk < 0)
      improvements.push('Clear overdue tasks or add an update on blocked tasks to remove risk penalties')
    if (improvements.length === 0 && totalScore < 80)
      improvements.push('Keep your current habits and aim to complete one more task each day')

    // One-line context sentence (used below the score card)
  } else {
    // EOD-only fallback (last month — no trend data available)
    if (status === 'submitted') {
      positives.push('EOD log submitted — discipline points recorded')
      improvements.push('Full score data is only available for the current month')
    } else if (status === 'missed') {
      negatives.push('EOD log was not submitted for this day')
      improvements.push('Submit your EOD log every day before you finish work')
    } else {
      positives.push('Day is still in progress — EOD log not yet required')
    }
  }

  // Band-based coaching sentence
  const coachingMessage = hasFullData
    ? (totalScore >= 80
        ? 'You had a strong day with good task completion, consistency, and updates. Keep this momentum going.'
        : totalScore >= 60
        ? 'You had a productive day and maintained good work habits. A little more output could push you higher.'
        : totalScore >= 40
        ? 'You earned points through consistency and updates, but task output could be stronger.'
        : 'Several scoring opportunities were missed. Focus on completing tasks and submitting updates consistently.')
    : null

  // Target gap line
  const targetGapMessage = (() => {
    if (!hasFullData) return null
    if (totalScore >= 80) return 'Excellent performance achieved.'
    const nextThreshold = totalScore >= 60 ? 80 : totalScore >= 40 ? 60 : 40
    const nextLabel     = totalScore >= 60 ? 'Excellent Performance' : totalScore >= 40 ? 'Good Performance' : 'Average Performance'
    return `${nextThreshold - totalScore} more points needed to reach ${nextLabel}.`
  })()

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, padding: '24px',
          width: '100%', maxWidth: 420,
          maxHeight: '90vh', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 20,
          boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111318' }}>
            Score Breakdown — {dateLabel}
          </div>
          <button
            onClick={onClose}
            style={{
              background: '#F4F5F7', border: 'none', borderRadius: 7,
              width: 28, height: 28, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, color: '#6B7384',
            }}
          >✕</button>
        </div>

        {/* Score card */}
        <div style={{
          background: scoreColor + '10', border: `1px solid ${scoreColor}28`,
          borderRadius: 12, padding: '18px 20px',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ fontSize: 36, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>
              {scoreDisplayLabel}
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: scoreColor }}>
              {performanceLabel}
            </div>
          </div>
          {targetGapMessage && (
            <div style={{ fontSize: 12, color: '#6B7384', lineHeight: 1.5, marginTop: 2 }}>
              {targetGapMessage}
            </div>
          )}
          {coachingMessage && (
            <div style={{ fontSize: 12.5, color: '#4A5261', lineHeight: 1.6, marginTop: 4, paddingTop: 10, borderTop: '1px solid ' + scoreColor + '20' }}>
              {coachingMessage}
            </div>
          )}
        </div>

        {/* What went well */}
        {positives.length > 0 && (
          <div>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#45A870',
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
            }}>
              What went well
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {positives.map((text, i) => (
                <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: '#45A870',
                    background: '#45A87018', borderRadius: 4,
                    padding: '1px 5px', flexShrink: 0, marginTop: 1,
                  }}>✓</span>
                  <span style={{ fontSize: 13, color: '#3D4455', lineHeight: 1.5 }}>{text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* What reduced your score */}
        {negatives.length > 0 && (
          <div>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#D94F4F',
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
            }}>
              What reduced your score
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {negatives.map((text, i) => (
                <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, color: '#D94F4F',
                    background: '#D94F4F12', borderRadius: 4,
                    padding: '1px 5px', flexShrink: 0, marginTop: 1,
                  }}>✗</span>
                  <span style={{ fontSize: 13, color: '#3D4455', lineHeight: 1.5 }}>{text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* To Reach The Next Level */}
        {improvements.length > 0 && (
          <div style={{
            background: '#F0F4FF', border: '1px solid #D0DAFF',
            borderRadius: 10, padding: '14px 16px',
          }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#5585E8',
              textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
            }}>
              To Reach The Next Level
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {improvements.slice(0, 3).map((text, i) => (
                <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span style={{ color: '#5585E8', fontSize: 13, flexShrink: 0, marginTop: 1 }}>›</span>
                  <span style={{ fontSize: 13, color: '#3D4455', lineHeight: 1.5 }}>{text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {positives.length === 0 && negatives.length === 0 && (
          <div style={{ textAlign: 'center', color: '#8C94A6', fontSize: 12.5, padding: '8px 0' }}>
            No detailed breakdown available for this day.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Monthly EOD View ─────────────────────────────────────────────────────────
const ROLLOUT_DATE = '2026-06-08'

type EodLogRow = { log_date: string; summary: string; self_score: number | null }

type MonthRange =
  | { from: string; to: string; label: string; noData: false }
  | { noData: true; label: string }

function getMonthRange(which: 'current' | 'last'): MonthRange {
  const now = new Date()
  if (which === 'current') {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
    // Effective start is the later of month-start and rollout date
    const from = monthStart >= ROLLOUT_DATE ? monthStart : ROLLOUT_DATE
    const to   = now.toISOString().slice(0, 10)
    return { from, to, label: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }), noData: false }
  } else {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const last  = new Date(now.getFullYear(), now.getMonth(), 0)
    const lastStr = last.toISOString().slice(0, 10)
    const label   = first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    // If the entire last month ended before rollout, there's no trackable data
    if (lastStr < ROLLOUT_DATE) return { noData: true, label }
    const from = first.toISOString().slice(0, 10) >= ROLLOUT_DATE
      ? first.toISOString().slice(0, 10)
      : ROLLOUT_DATE
    return { from, to: lastStr, label, noData: false }
  }
}

type DayStatus = 'submitted' | 'pending' | 'missed'
type DayEntry  = { date: string; log: EodLogRow | null; status: DayStatus }

function buildDayList(from: string, to: string, logs: EodLogRow[]): DayEntry[] {
  const logMap  = new Map(logs.map(r => [r.log_date, r]))
  const todayStr = new Date().toISOString().slice(0, 10)
  const list: DayEntry[] = []
  const start = new Date(from + 'T12:00:00')
  const end   = new Date(to   + 'T12:00:00')
  for (let d = new Date(end); d >= start; d.setDate(d.getDate() - 1)) {
    const dateStr = d.toISOString().slice(0, 10)
    const log     = logMap.get(dateStr) ?? null
    const status: DayStatus =
      log              ? 'submitted' :
      dateStr < todayStr ? 'missed'   :
                           'pending'
    list.push({ date: dateStr, log, status })
  }
  return list
}

function ImprovementSuggestions({ submittedCount, missedCount, avgRating, riskPts, momentumScore }: {
  submittedCount: number
  missedCount: number
  avgRating: number | null
  riskPts: number
  momentumScore: number
}) {
  const tips: { color: string; text: string }[] = []

  if (missedCount > 0)
    tips.push({ color: '#D94F4F', text: `You missed ${missedCount} EOD log${missedCount > 1 ? 's' : ''} this month. Submit your log before closing your laptop — it takes under 2 minutes and earns +12 pts each day.` })
  if (avgRating !== null && avgRating < 4)
    tips.push({ color: '#E8A030', text: 'Your daily ratings are below 4 stars. Write clearer descriptions of completed work and focus on finishing higher-priority tasks to push your daily output up.' })
  if (riskPts < -10)
    tips.push({ color: '#D94F4F', text: 'Your risk score is costing points. Update blocked or waiting tasks earlier — even a short note removes the stale penalty.' })
  if (momentumScore < 10)
    tips.push({ color: '#5585E8', text: 'Your momentum score is low. Post a quick status update on active tasks each day — it signals progress and earns discipline points.' })

  if (tips.length === 0)
    return (
      <div style={{ background: '#45A87010', border: '1px solid #45A87030', borderRadius: 10, padding: '14px 18px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#45A870', marginBottom: 4 }}>Great consistency this month!</div>
        <div style={{ fontSize: 12.5, color: '#4A5261', lineHeight: 1.6 }}>
          You&apos;re submitting logs regularly and keeping your scores strong. Keep this up — consistency is what separates top performers over time.
        </div>
      </div>
    )

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>How to Improve Your Ranking</div>
      {tips.map((tip, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{
            width: 6, height: 6, borderRadius: '50%', background: tip.color,
            marginTop: 5, flexShrink: 0,
          }} />
          <div style={{ fontSize: 12.5, color: '#3D4455', lineHeight: 1.6 }}>{tip.text}</div>
        </div>
      ))}
    </div>
  )
}

function MonthlyView({ token, which, perfData, viewAsUserId }: {
  token: string
  which: 'current' | 'last'
  perfData: PerformanceData | null
  viewAsUserId?: string | null
}) {
  const [logs,        setLogs]        = useState<EodLogRow[]>([])
  const [fetching,    setFetching]    = useState(true)
  const [selectedDay, setSelectedDay] = useState<SelectedDay | null>(null)
  const range = useMemo(() => getMonthRange(which), [which])

  const trendMap = useMemo(() => {
    const map = new Map<string, TrendDay>()
    if (perfData?.trend) for (const d of perfData.trend) map.set(d.date, d)
    return map
  }, [perfData])

  useEffect(() => {
    if (!token || range.noData) { setFetching(false); return }
    setFetching(true)
    const qs = new URLSearchParams({ from: range.from, to: range.to })
    if (viewAsUserId) qs.set('userId', viewAsUserId)
    fetch(`/api/daily-log?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => setLogs(d.logs ?? []))
      .finally(() => setFetching(false))
  }, [token, range, viewAsUserId])

  const days = useMemo(
    () => range.noData ? [] : buildDayList(range.from, range.to, logs),
    [range, logs],
  )

  const submittedDays = days.filter(d => d.status === 'submitted')
  const missedDays    = days.filter(d => d.status === 'missed')
  const pendingDays   = days.filter(d => d.status === 'pending')
  const eodScore      = submittedDays.length * 12 - missedDays.length * 12
  const ratedLogs     = submittedDays.filter(d => d.log!.self_score)
  const avgRating     = ratedLogs.length
    ? ratedLogs.reduce((s, d) => s + d.log!.self_score!, 0) / ratedLogs.length
    : null
  const avgRatingStr  = avgRating !== null ? avgRating.toFixed(1) : '—'

  const breakdown     = perfData?.breakdown
  const riskPts       = breakdown?.risk ?? 0
  const momentumScore = breakdown?.momentum ?? 0

  const chipStyle = (accent: string) => ({
    display: 'flex' as const, flexDirection: 'column' as const, alignItems: 'center' as const,
    gap: 2, padding: '10px 12px', borderRadius: 8,
    background: accent + '10', border: `1px solid ${accent}25`,
    flex: '1 1 0', minWidth: 0,
  })

  if (fetching) return (
    <div style={{ textAlign: 'center', padding: '60px 0', fontSize: 13, color: '#8C94A6' }}>Loading…</div>
  )

  // No trackable dates for this month
  if (range.noData || days.length === 0) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7384' }}>{range.label}</div>
      <div style={{
        background: '#F8F9FB', border: '1px solid #EEF0F4', borderRadius: 10,
        padding: '28px 20px', textAlign: 'center',
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#8C94A6', marginBottom: 6 }}>No data available</div>
        <div style={{ fontSize: 12.5, color: '#8C94A6', lineHeight: 1.6 }}>
          EOD tracking started from 8 Jun 2026. No data is available for this month.
        </div>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Month label */}
      <div style={{ fontSize: 13, fontWeight: 600, color: '#6B7384' }}>{range.label}</div>

      {/* Summary chips row 1 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={chipStyle('#5585E8')}>
          <span style={{ fontSize: 18, fontWeight: 700, color: eodScore >= 0 ? '#45A870' : '#D94F4F' }}>
            {eodScore >= 0 ? `+${eodScore}` : eodScore}
          </span>
          <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Monthly Score</span>
        </div>
        <div style={chipStyle('#45A870')}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#45A870' }}>{submittedDays.length}</span>
          <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Submitted Days</span>
        </div>
        <div style={chipStyle('#D94F4F')}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#D94F4F' }}>{missedDays.length}</span>
          <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Missed Days</span>
        </div>
        {pendingDays.length > 0 && (
          <div style={chipStyle('#E8A030')}>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#E8A030' }}>{pendingDays.length}</span>
            <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Pending</span>
          </div>
        )}
        <div style={chipStyle('#E8A030')}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#E8A030' }}>{avgRatingStr}</span>
          <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Avg Rating</span>
        </div>
      </div>

      {/* Score breakdown chips — only when we have perf data (current month) */}
      {breakdown && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={chipStyle('#45A870')}>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#45A870' }}>{breakdown.output}</span>
            <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Output Score</span>
          </div>
          <div style={chipStyle('#5585E8')}>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#5585E8' }}>{breakdown.momentum}</span>
            <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Momentum</span>
          </div>
          <div style={chipStyle('#E8A030')}>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#E8A030' }}>{breakdown.discipline}</span>
            <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Discipline</span>
          </div>
          <div style={chipStyle(breakdown.risk < 0 ? '#D94F4F' : '#8C94A6')}>
            <span style={{ fontSize: 16, fontWeight: 700, color: breakdown.risk < 0 ? '#D94F4F' : '#45A870' }}>
              {breakdown.risk === 0 ? '✓ Clean' : breakdown.risk}
            </span>
            <span style={{ fontSize: 10, color: '#8C94A6', whiteSpace: 'nowrap' }}>Risk Points</span>
          </div>
        </div>
      )}

      {/* EOD log table */}
      <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: '#F8F9FB', borderBottom: '1px solid #EEF0F4' }}>
                {['Date', 'Key Work Done', 'Rating', 'Status', 'Total Score', 'Reason'].map(h => (
                  <th key={h} style={{
                    padding: '8px 12px', textAlign: 'left',
                    fontSize: 10, fontWeight: 600, color: '#8C94A6',
                    textTransform: 'uppercase', letterSpacing: '0.05em',
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map(({ date, log, status }) => {
                const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-IN', {
                  day: 'numeric', month: 'short',
                })
                const statusColor =
                  status === 'submitted' ? '#45A870' :
                  status === 'pending'   ? '#E8A030' :
                                          '#D94F4F'
                const statusBg =
                  status === 'submitted' ? '#45A87015' :
                  status === 'pending'   ? '#E8A03015' :
                                          '#D94F4F12'
                const statusLabel =
                  status === 'submitted' ? 'Submitted' :
                  status === 'pending'   ? 'Pending'   :
                                          'Missed'
                const reasonText =
                  status === 'submitted' ? 'Logged work and earned discipline points' :
                  status === 'pending'   ? 'Day still in progress'                   :
                                          'EOD log was not submitted before day close'
                const trendDay   = trendMap.get(date)
                const totalScore = trendDay
                  ? trendDay.breakdown.total
                  : status === 'submitted' ? 12 : status === 'missed' ? -12 : null
                const scoreDisplayLabel = trendDay
                  ? `${totalScore}`
                  : totalScore === null ? '—' : totalScore > 0 ? `+${totalScore}` : `${totalScore}`
                const scoreColor2 = trendDay
                  ? (totalScore! >= 58 ? '#45A870' : totalScore! >= 38 ? '#E8A030' : '#D94F4F')
                  : (status === 'submitted' ? '#45A870' : status === 'missed' ? '#D94F4F' : '#8C94A6')

                return (
                  <tr key={date} style={{ borderBottom: '1px solid #F4F5F7' }}>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', color: '#6B7384', fontSize: 12 }}>{dateLabel}</td>
                    <td style={{
                      padding: '8px 12px', color: status === 'submitted' ? '#3D4455' : '#C0C4CE',
                      maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={log?.summary ?? undefined}>{log?.summary ?? '—'}</td>
                    <td style={{ padding: '8px 12px', color: '#E8A030', whiteSpace: 'nowrap', letterSpacing: 1 }}>
                      {log?.self_score ? '★'.repeat(log.self_score) : <span style={{ color: '#C0C4CE' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600,
                        color: statusColor, background: statusBg,
                        padding: '2px 8px', borderRadius: 5,
                      }}>{statusLabel}</span>
                    </td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => setSelectedDay({ date, trendDay, status })}
                        title="Click to see score breakdown"
                        style={{
                          fontSize: 12, fontWeight: 700,
                          color: scoreColor2, background: scoreColor2 + '15',
                          border: `1px solid ${scoreColor2}35`,
                          padding: '3px 10px', borderRadius: 6,
                          cursor: 'pointer', whiteSpace: 'nowrap',
                          fontFamily: 'inherit',
                        }}
                      >{scoreDisplayLabel}</button>
                    </td>
                    <td style={{
                      padding: '8px 12px', fontSize: 11,
                      color: status === 'submitted' ? '#45A870' : status === 'pending' ? '#E8A030' : '#8C94A6',
                      whiteSpace: 'nowrap',
                    }}>{reasonText}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Rule-based improvement suggestions */}
      <ImprovementSuggestions
        submittedCount={submittedDays.length}
        missedCount={missedDays.length}
        avgRating={avgRating}
        riskPts={riskPts}
        momentumScore={momentumScore}
      />

      {selectedDay && (
        <DayScoreModal day={selectedDay} onClose={() => setSelectedDay(null)} />
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
type Tab       = 'today' | 'current_month' | 'last_month'
type ApiPeriod = 'daily' | 'weekly' | 'monthly'

const TAB_LABELS: Record<Tab, string> = {
  today:         'Today',
  current_month: 'Current Month',
  last_month:    'Last Month',
}

function tabToApiPeriod(tab: Tab): ApiPeriod {
  if (tab === 'current_month') return 'monthly'
  return 'daily'
}

export default function PerformancePage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [token,        setToken]        = useState('')
  const [tab,          setTab]          = useState<Tab>('today')
  const [perfData,     setPerfData]     = useState<PerformanceData | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [perfLoading,  setPerfLoading]  = useState(false)
  const [audit,        setAudit]        = useState<PerformanceAudit | null>(null)
  const perfCacheRef = useRef<Record<string, PerformanceData>>({})
  const [auditLoading, setAuditLoading] = useState(false)
  const [progress,     setProgress]     = useState(0)
  const [showLoader,   setShowLoader]   = useState(true)
  const [isMobile,     setIsMobile]     = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { viewAsUserId, viewAsProfile, exitViewMode } = useViewAs()

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)
      const { data: callerProfile } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      if (viewAsUserId && callerProfile?.role !== 'admin') {
        exitViewMode()
        router.push('/dashboard')
        return
      }
      if (callerProfile) setProfile(callerProfile as UserProfile)
      setLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, router, viewAsUserId])

  const fetchPerf = useCallback(async (apiPeriod: ApiPeriod, t: string, bustCache = false) => {
    if (!t) return
    const cacheKey = `${viewAsUserId ?? 'self'}:${apiPeriod}`
    if (!bustCache && perfCacheRef.current[cacheKey]) {
      setPerfData(perfCacheRef.current[cacheKey])
      return
    }
    setPerfLoading(true)
    setAudit(null)
    try {
      const params = new URLSearchParams({ period: apiPeriod })
      if (viewAsUserId) params.set('userId', viewAsUserId)
      const res = await fetch(`/api/performance-metrics?${params.toString()}`, {
        headers: { Authorization: `Bearer ${t}` },
      })
      if (res.ok) {
        const data = await res.json()
        perfCacheRef.current[cacheKey] = data
        setPerfData(data)
      }
    } finally {
      setPerfLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewAsUserId])

  useEffect(() => {
    if (!token) return
    if (tab === 'last_month') {
      // Last month tab doesn't call the perf metrics API
      setPerfData(null)
      return
    }
    fetchPerf(tabToApiPeriod(tab), token)
  }, [tab, token, fetchPerf])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const runAudit = async () => {
    if (!perfData || !token) return
    setAuditLoading(true)
    try {
      const res = await fetch('/api/performance-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          period:        'daily',
          inputs:        perfData.inputs,
          breakdown:     perfData.breakdown,
          trend:         perfData.trend,
          trendAnalysis: perfData.trendAnalysis,
          userName:      perfData.userName,
          score:         perfData.score,
          rating:        perfData.rating,
        }),
      })
      if (res.ok) setAudit((await res.json()).audit)
    } finally {
      setAuditLoading(false)
    }
  }

  const handleEodSaved = (log: { summary: string; self_score: number | null }) => {
    // Optimistically update local perfData so the Discipline card reflects the save
    // immediately without blanking the page via perfLoading.
    setPerfData(prev => {
      if (!prev) return prev
      const alreadyHad = prev.inputs.hasEodLog
      const newDiscipline = alreadyHad ? prev.breakdown.discipline : Math.min(prev.breakdown.discipline + 12, 20)
      return {
        ...prev,
        eodLog: { ...( prev.eodLog ?? { id: '', user_id: '', log_date: '', blockers: null, created_at: '', updated_at: '' }), summary: log.summary, highlights: null, self_score: log.self_score },
        inputs: { ...prev.inputs, hasEodLog: true },
        breakdown: { ...prev.breakdown, discipline: newDiscipline },
      }
    })
    // Silent background refetch to get the accurate server-computed score
    delete perfCacheRef.current[`${viewAsUserId ?? 'self'}:daily`]
    if (token) {
      const params = new URLSearchParams({ period: 'daily' })
      if (viewAsUserId) params.set('userId', viewAsUserId)
      fetch(`/api/performance-metrics?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            perfCacheRef.current[`${viewAsUserId ?? 'self'}:daily`] = data
            setPerfData(data)
          }
        })
        .catch(() => { /* silent — optimistic update already applied */ })
    }
  }

  const dataReady = !loading && !perfLoading
  useEffect(() => {
    if (!showLoader) return
    if (dataReady) {
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
  }, [dataReady, showLoader])

  if (showLoader) return <PerformanceProgressLoader progress={progress} />

  const todayLabel      = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const viewedProfile   = viewAsProfile ?? profile
  const isAdminOrManager = viewedProfile?.role === 'admin' || viewedProfile?.role === 'manager'

  return (
    <DashboardLayout
      profile={profile}
      title="Performance"
      subtitle={todayLabel}
      onSignOut={async () => { await supabase.auth.signOut(); router.push('/login') }}
      actions={isAdminOrManager ? (
        <a href="/performance/team" style={{
          fontSize: 12, fontWeight: 600, color: '#5585E8', textDecoration: 'none',
          border: '1px solid #5585E815', background: '#5585E808',
          padding: '6px 14px', borderRadius: 7,
        }}>Team View →</a>
      ) : undefined}
    >
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, background: '#F4F5F7', borderRadius: 10, padding: 4, alignSelf: 'flex-start' }}>
          {(['today', 'current_month', 'last_month'] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              fontSize: 12.5, fontWeight: 600,
              padding: '6px 16px', borderRadius: 7,
              border: 'none', cursor: 'pointer',
              background: tab === t ? '#fff' : 'transparent',
              color: tab === t ? '#111318' : '#8C94A6',
              boxShadow: tab === t ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap',
            }}>{TAB_LABELS[t]}</button>
          ))}
        </div>

        {/* ── TODAY TAB ── */}
        {tab === 'today' && (
          perfLoading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>Loading…</div>
          ) : perfData ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : '3fr 2fr',
              gap: 20,
              alignItems: 'start',
            }}>

              {/* ROW 1 LEFT */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 16, alignItems: 'stretch' }}>
                  <div style={{
                    background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10,
                    padding: '20px 10px',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
                  }}>
                    <ScoreRing score={perfData.score} rating={perfData.rating} />
                    {perfData.trendAnalysis.classification !== 'insufficient_data' && (
                      <div style={{
                        fontSize: 10, fontWeight: 600,
                        color: TREND_COLORS[perfData.trendAnalysis.classification],
                        background: TREND_COLORS[perfData.trendAnalysis.classification] + '15',
                        padding: '2px 8px', borderRadius: 999,
                        textAlign: 'center', lineHeight: 1.6,
                      }}>
                        {TREND_ICONS[perfData.trendAnalysis.classification]} {
                          perfData.trendAnalysis.weekOverWeekDelta !== 0
                            ? `${perfData.trendAnalysis.weekOverWeekDelta > 0 ? '+' : ''}${perfData.trendAnalysis.weekOverWeekDelta} w/w`
                            : perfData.trendAnalysis.classification
                        }
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignContent: 'start' }}>
                    <MetricCard
                      label="Output"
                      value={`${perfData.breakdown.output}/50`}
                      sub={`${perfData.inputs.completedHigh + perfData.inputs.completedMedium + perfData.inputs.completedLow} task${perfData.inputs.completedHigh + perfData.inputs.completedMedium + perfData.inputs.completedLow !== 1 ? 's' : ''} completed`}
                      accent={perfData.breakdown.output >= 30 ? '#45A870' : perfData.breakdown.output >= 15 ? undefined : '#8C94A6'}
                    />
                    <MetricCard
                      label="Momentum"
                      value={`${perfData.breakdown.momentum}/20`}
                      sub={`${perfData.inputs.statusUpdates} update${perfData.inputs.statusUpdates !== 1 ? 's' : ''}${perfData.inputs.blockerResolutions > 0 ? ` · ${perfData.inputs.blockerResolutions} unblocked` : ''}`}
                      accent={perfData.breakdown.momentum >= 12 ? '#5585E8' : undefined}
                    />
                    <MetricCard
                      label="Discipline"
                      value={`${perfData.breakdown.discipline}/20`}
                      sub={perfData.inputs.hasEodLog ? '✓ EOD log submitted' : 'EOD log missing'}
                      accent={perfData.inputs.hasEodLog ? '#45A870' : '#D94F4F'}
                    />
                    <MetricCard
                      label="Risk"
                      value={perfData.breakdown.risk === 0 ? '✓ Clean' : `${perfData.breakdown.risk}`}
                      sub={`${perfData.inputs.overdueCount} overdue · ${perfData.inputs.staleBlockedCount} stale blocks`}
                      accent={perfData.breakdown.risk < -10 ? '#D94F4F' : perfData.breakdown.risk === 0 ? '#45A870' : undefined}
                    />
                  </div>
                </div>

                {perfData.inputs.staleBlockedCount > 0 && (
                  <div style={{
                    background: '#D94F4F10', border: '1px solid #D94F4F30',
                    borderRadius: 10, padding: '12px 16px',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#D94F4F', flexShrink: 0 }} />
                    <div style={{ fontSize: 12.5, color: '#3D4455' }}>
                      <strong>{perfData.inputs.staleBlockedCount} task{perfData.inputs.staleBlockedCount > 1 ? 's have' : ' has'} been blocked for &gt;2 days</strong> — costing {perfData.inputs.staleBlockedCount * 8} pts. Escalate or add an update.
                    </div>
                  </div>
                )}
              </div>

              {/* ROW 1 RIGHT */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <ScoreGuide />
                <ScoreBreakdownPanel breakdown={perfData.breakdown} />
              </div>

              {/* ROW 2 LEFT: EOD form */}
              <EodLogForm existing={perfData.eodLog} token={token} onSaved={handleEodSaved} />

              {/* ROW 2 RIGHT: Trend chart */}
              {perfData.trend && perfData.trend.length > 0 ? (
                <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '18px 20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6B7384', textTransform: 'uppercase', letterSpacing: '0.05em' }}>7-Day Trend</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: TREND_COLORS[perfData.trendAnalysis.classification] }}>
                      {TREND_ICONS[perfData.trendAnalysis.classification]} {perfData.trendAnalysis.description}
                    </div>
                  </div>
                  <TrendBars trend={perfData.trend} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 11, color: '#8C94A6' }}>
                    <span>Avg: {Math.round(perfData.trend.reduce((s, d) => s + d.score, 0) / perfData.trend.length)}/100</span>
                    <span>Best: {Math.max(...perfData.trend.map(d => d.score))}/100</span>
                    <span>Streak: {perfData.trendAnalysis.streak}d {perfData.trendAnalysis.direction}</span>
                  </div>
                </div>
              ) : <div />}

              {/* ROW 3 LEFT: AI Audit */}
              <AuditPanel audit={audit} loading={auditLoading} onGenerate={runAudit} />

              {/* ROW 3 RIGHT: empty */}
              <div />

            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>No data available.</div>
          )
        )}

        {/* ── CURRENT MONTH TAB ── */}
        {tab === 'current_month' && token && (
          perfLoading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>Loading…</div>
          ) : (
            <MonthlyView token={token} which="current" perfData={perfData} viewAsUserId={viewAsUserId} />
          )
        )}

        {/* ── LAST MONTH TAB ── */}
        {tab === 'last_month' && token && (
          <MonthlyView token={token} which="last" perfData={null} viewAsUserId={viewAsUserId} />
        )}

      </div>
    </DashboardLayout>
  )
}

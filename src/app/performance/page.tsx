'use client'

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { useViewAs } from '@/hooks/useViewAs'
import type {
  UserProfile, PerformanceData, PerformanceAudit, TrendDay,
} from '@/lib/types'
import {
  istToday, istDateRange, istMonthStart, istMonthEnd, istMonthStartOffset,
} from '@/lib/istDate'

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
          <span style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>Today&apos;s Reflection</span>
        </div>
        <div style={{ color: '#8C94A6', fontSize: 13 }}>Analysing your performance data…</div>
      </div>
    )
  }

  if (!audit) {
    return (
      <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '20px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>Today&apos;s Reflection</span>
          <button
            onClick={onGenerate}
            style={{
              fontSize: 12, fontWeight: 600,
              background: '#111318', color: '#fff',
              border: 'none', borderRadius: 7,
              padding: '6px 14px', cursor: 'pointer',
            }}
          >Generate</button>
        </div>
        <div style={{ fontSize: 12, color: '#8C94A6' }}>
          Get coaching on what worked, what was missed, and what to improve tomorrow.
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
          <span style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>Today&apos;s Reflection</span>
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

// ─── Today's Coach panel ─────────────────────────────────────────────────────
function TodayCoach({ data }: { data: PerformanceData }) {
  const { breakdown, inputs, score } = data
  const totalCompleted = inputs.completedHigh + inputs.completedMedium + inputs.completedLow

  const strong: string[] = []
  const improve: { text: string; pts: number }[] = []

  if (totalCompleted > 0)
    strong.push(`Completed ${totalCompleted} task${totalCompleted !== 1 ? 's' : ''} today`)
  if (inputs.statusUpdates >= 3)
    strong.push(`Posted ${inputs.statusUpdates} updates — good communication`)
  if (inputs.hasEodLog)
    strong.push('EOD log submitted')
  if (breakdown.risk === 0 && inputs.activeTasks > 0)
    strong.push('No overdue or blocked tasks')

  const outputGap = 50 - breakdown.output
  if (outputGap > 0) {
    const medNeeded = Math.ceil(outputGap / 15)
    improve.push({
      text: `Complete ${medNeeded} more task${medNeeded !== 1 ? 's' : ''} for full output score`,
      pts: Math.min(outputGap, medNeeded * 15),
    })
  }

  const momentumGap = 20 - breakdown.momentum
  if (momentumGap > 0) {
    const updatesNeeded = Math.ceil(momentumGap / 4)
    improve.push({
      text: `Add ${updatesNeeded} more update${updatesNeeded !== 1 ? 's' : ''} on active tasks`,
      pts: Math.min(momentumGap, updatesNeeded * 4),
    })
  }

  if (!inputs.hasEodLog)
    improve.push({ text: 'Submit your EOD log before you finish work', pts: 12 })

  if (inputs.overdueCount > 0)
    improve.push({
      text: `Close ${inputs.overdueCount} overdue task${inputs.overdueCount !== 1 ? 's' : ''} to remove risk penalty`,
      pts: inputs.overdueCount * 5,
    })

  const potentialGain = improve.reduce((s, i) => s + i.pts, 0)
  const potentialScore = Math.min(100, score + potentialGain)

  return (
    <div style={{
      background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10,
      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* Header row with score */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Today&apos;s Coach
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111318' }}>{score}/100</div>
      </div>

      {strong.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#45A870', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Strong</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {strong.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: '#45A870',
                  background: '#45A87018', borderRadius: 4, padding: '1px 5px', flexShrink: 0,
                }}>✓</span>
                <span style={{ fontSize: 12, color: '#3D4455', lineHeight: 1.5 }}>{s}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {improve.length > 0 ? (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#5585E8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Next Steps</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {/* First item prominently styled */}
            <div style={{
              display: 'flex', gap: 8, alignItems: 'flex-start',
              background: '#5585E808', border: '1px solid #5585E820',
              borderRadius: 7, padding: '7px 10px',
            }}>
              <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>⚡</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, color: '#111318', fontWeight: 500, lineHeight: 1.5 }}>{improve[0].text}</span>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 700, color: '#5585E8',
                background: '#5585E818', borderRadius: 4, padding: '2px 6px', flexShrink: 0, marginTop: 2,
              }}>+{improve[0].pts}</span>
            </div>
            {/* Remaining items smaller */}
            {improve.slice(1).map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingLeft: 2 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, color: '#5585E8',
                  background: '#5585E818', borderRadius: 4, padding: '1px 5px', flexShrink: 0, marginTop: 2,
                }}>+{item.pts}</span>
                <span style={{ fontSize: 12, color: '#6B7384', lineHeight: 1.5 }}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#45A870', lineHeight: 1.6 }}>
          You&apos;ve done everything right today. Nothing left to improve — great work.
        </div>
      )}

      {/* Potential score */}
      <div style={{
        borderTop: '1px solid #EEF0F4', paddingTop: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ fontSize: 11, color: '#8C94A6' }}>Potential score today</span>
        <span style={{
          fontSize: 15, fontWeight: 700,
          color: potentialScore > score ? '#5585E8' : '#45A870',
        }}>{potentialScore}/100</span>
      </div>

      {/* Score guide link */}
      <div style={{ borderTop: '1px solid #F0F1F3', paddingTop: 8 }}>
        <ScoreGuide compact />
      </div>
    </div>
  )
}

// ─── Score guide (collapsible) ────────────────────────────────────────────────
function ScoreGuide({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)

  return (
    <div style={compact ? {} : { border: '1px solid #E5E7EB', borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          justifyContent: compact ? 'flex-start' : 'space-between',
          padding: compact ? '0' : '11px 16px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        {compact
          ? <span style={{ fontSize: 11, color: '#8C94A6', textDecoration: 'underline', textUnderlineOffset: 2 }}>
              How scoring works {open ? '↑' : '→'}
            </span>
          : <>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#3D4455' }}>How is this score calculated?</span>
              <span style={{
                fontSize: 11, color: '#8C94A6',
                transform: open ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s', display: 'inline-block',
              }}>▾</span>
            </>
        }
      </button>
      {open && (
        <div style={{ padding: compact ? '10px 0 0' : '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 16, borderTop: compact ? 'none' : '1px solid #F0F1F3' }}>
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
            rows={5}
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

// ─── Day Score Modal (monthly table) ─────────────────────────────────────────
type SelectedDay = { date: string; trendDay: TrendDay | undefined; status: DayStatus }

function DayScoreModal({ day, onClose }: { day: SelectedDay; onClose: () => void }) {
  const { date, trendDay, status } = day
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })

  const hasBreakdown = !!trendDay
  const total = hasBreakdown ? trendDay!.breakdown.total : status === 'submitted' ? 12 : status === 'missed' ? -12 : 0

  const scoreColor = total >= 70 ? '#45A870' : total >= 50 ? '#5585E8' : total >= 30 ? '#E8A030' : '#D94F4F'

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.30)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: 14, padding: '22px 24px',
          width: '100%', maxWidth: 380,
          display: 'flex', flexDirection: 'column', gap: 16,
          boxShadow: '0 8px 32px rgba(0,0,0,0.14)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111318' }}>{dateLabel}</div>
          <button onClick={onClose} style={{
            background: '#F4F5F7', border: 'none', borderRadius: 7,
            width: 28, height: 28, cursor: 'pointer', fontSize: 13, color: '#6B7384',
          }}>✕</button>
        </div>

        {/* Score badge */}
        <div style={{
          background: scoreColor + '0F', border: `1px solid ${scoreColor}28`,
          borderRadius: 10, padding: '14px 18px',
          display: 'flex', alignItems: 'baseline', gap: 10,
        }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>
            {hasBreakdown ? total : total > 0 ? `+${total}` : total}
          </div>
          <div style={{ fontSize: 12, color: scoreColor, fontWeight: 600 }}>
            {hasBreakdown ? '/ 100' : 'pts (EOD only)'}
          </div>
        </div>

        {/* Breakdown rows — only when full trend data is available */}
        {hasBreakdown && (() => {
          const bd = trendDay!.breakdown
          const inp = trendDay!.inputs
          const totalCompleted = inp.completedHigh + inp.completedMedium + inp.completedLow
          const rows: { label: string; value: string; max: string; sub: string; color: string }[] = [
            {
              label: 'Output', value: String(bd.output), max: '50', color: bd.output >= 30 ? '#45A870' : '#8C94A6',
              sub: totalCompleted > 0
                ? `${inp.completedHigh}H · ${inp.completedMedium}M · ${inp.completedLow}L completed`
                : 'No tasks completed',
            },
            {
              label: 'Momentum', value: String(bd.momentum), max: '20', color: '#5585E8',
              sub: inp.statusUpdates > 0 ? `${inp.statusUpdates} task update${inp.statusUpdates > 1 ? 's' : ''}` : 'No task updates posted',
            },
            {
              label: 'Discipline', value: String(bd.discipline), max: '20', color: inp.hasEodLog ? '#45A870' : '#D94F4F',
              sub: inp.hasEodLog ? 'EOD log submitted' : 'EOD log not submitted',
            },
            {
              label: 'Risk', value: bd.risk === 0 ? '✓' : String(bd.risk), max: '', color: bd.risk < 0 ? '#D94F4F' : '#45A870',
              sub: bd.risk === 0 ? 'No overdue or stale blocked tasks' : 'Overdue / stale blocked tasks',
            },
          ]
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Score Breakdown</div>
              {rows.map(r => (
                <div key={r.label} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 0', borderBottom: '1px solid #F4F5F7',
                }}>
                  <div style={{ width: 72, fontSize: 11, color: '#8C94A6', fontWeight: 500 }}>{r.label}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: r.color, width: 40 }}>
                    {r.value}{r.max ? <span style={{ fontSize: 10, color: '#C0C4CF', fontWeight: 400 }}>/{r.max}</span> : ''}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#6B7384', flex: 1 }}>{r.sub}</div>
                </div>
              ))}
            </div>
          )
        })()}

        {/* EOD-only fallback note */}
        {!hasBreakdown && (
          <div style={{ fontSize: 12, color: '#8C94A6', lineHeight: 1.6 }}>
            {status === 'submitted'
              ? 'Full daily breakdown is available only for the current 7-day window. This day shows EOD discipline points only (+12).'
              : 'EOD log was not submitted. A −12 penalty applies to the monthly score for this day.'}
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

function monthLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

function getMonthRange(which: 'current' | 'last'): MonthRange {
  // All boundaries are IST business dates. Building them from a local Date and
  // then calling toISOString() shifted the month start back a day in IST.
  const today = istToday()

  if (which === 'current') {
    const monthStart = istMonthStart(today)
    const from = monthStart >= ROLLOUT_DATE ? monthStart : ROLLOUT_DATE
    return { from, to: today, label: monthLabel(today), noData: false }
  }

  const first = istMonthStartOffset(today, 1)
  const last  = istMonthEnd(first)
  const label = monthLabel(first)
  // If the entire last month ended before rollout, there's no trackable data
  if (last < ROLLOUT_DATE) return { noData: true, label }
  return { from: first >= ROLLOUT_DATE ? first : ROLLOUT_DATE, to: last, label, noData: false }
}

type DayStatus = 'submitted' | 'pending' | 'missed'
type DayEntry  = { date: string; log: EodLogRow | null; status: DayStatus }

function buildDayList(
  from: string,
  to: string,
  logs: EodLogRow[],
  workingDates: ReadonlySet<string> | null,
): DayEntry[] {
  const logMap   = new Map(logs.map(r => [r.log_date, r]))
  const todayStr = istToday()
  // Newest first — the list is rendered as a reverse-chronological history.
  return istDateRange(from, to)
    .filter(date => workingDates === null || workingDates.has(date))
    .reverse()
    .map(date => {
      const log = logMap.get(date) ?? null
      const status: DayStatus =
        log             ? 'submitted' :
        date < todayStr ? 'missed'    :
                          'pending'
      return { date, log, status }
    })
}

function MonthlyView({ token, which, viewAsUserId }: {
  token: string
  which: 'current' | 'last'
  viewAsUserId?: string | null
}) {
  const [logs,        setLogs]        = useState<EodLogRow[]>([])
  const [trendDays,   setTrendDays]   = useState<TrendDay[]>([])
  const [avgScore,    setAvgScore]    = useState<number | null>(null)
  const [fetching,    setFetching]    = useState(true)
  const [selectedDay, setSelectedDay] = useState<SelectedDay | null>(null)
  const range = useMemo(() => getMonthRange(which), [which])

  // Scores for this month are fetched for the month's own date range. They used
  // to be read out of the 7-day trend the page had already loaded, which meant
  // the average silently covered only the last week and skipped every day with
  // no data — so a month with several dead days still averaged well.
  useEffect(() => {
    const loadMonth = () => {
      if (!token || range.noData) { setFetching(false); return }
      setFetching(true)
      const qs = new URLSearchParams({ from: range.from, to: range.to })
      if (viewAsUserId) qs.set('userId', viewAsUserId)
      const auth = { headers: { Authorization: `Bearer ${token}` } }

      Promise.all([
        fetch(`/api/daily-log?${qs.toString()}`, auth)
          .then(r => r.ok ? r.json() : { logs: [] })
          .catch(() => ({ logs: [] })),
        fetch(`/api/performance-metrics?${qs.toString()}`, auth)
          .then(r => r.ok ? r.json() : { trend: [] })
          .catch(() => ({ trend: [] })),
      ])
        .then(([logRes, perfRes]) => {
          setLogs(logRes.logs ?? [])
          setTrendDays(perfRes.trend ?? [])
          // Read the server's average rather than recomputing it here. The
          // server knows which days were expected working days and whether
          // today's cutoff has passed; recomputing from `trend` would quietly
          // disagree with the Team page for the same employee.
          setAvgScore(perfRes.aggregate?.avgScore ?? null)
        })
        .finally(() => setFetching(false))
    }
    loadMonth()
  }, [token, range, viewAsUserId])

  const trendMap = useMemo(
    () => new Map(trendDays.map(d => [d.date, d])),
    [trendDays],
  )

  // The trend carries exactly the dates the server treated as expected working
  // days, so it doubles as the working calendar here: no Sunday, holiday,
  // pre-joining or post-exit date can appear as a "missed EOD" day. If the
  // performance fetch failed, fall back to the whole range rather than showing
  // an empty month.
  const workingDates = useMemo(
    () => trendDays.length > 0 ? new Set(trendDays.map(d => d.date)) : null,
    [trendDays],
  )

  const days = useMemo(
    () => range.noData ? [] : buildDayList(range.from, range.to, logs, workingDates),
    [range, logs, workingDates],
  )

  const submittedDays = days.filter(d => d.status === 'submitted')
  const missedDays    = days.filter(d => d.status === 'missed')

  const monthlyAvgScore = avgScore

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Header card ── */}
      <div style={{
        background: '#fff', border: '1px solid #EEF0F4', borderRadius: 12,
        padding: '12px 20px',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0,
      }}>
        {/* Month label — left anchor */}
        <div style={{
          padding: '8px 20px 8px 0',
          marginRight: 4,
          fontSize: 15, fontWeight: 600, color: '#2D3340',
          whiteSpace: 'nowrap',
          borderRight: '1px solid #EEF0F4',
        }}>{range.label}</div>

        {/* Metrics in the same row */}
        {[
          {
            label: 'Monthly Avg Score',
            value: monthlyAvgScore !== null ? String(monthlyAvgScore) : '—',
            valueColor: monthlyAvgScore === null ? '#8C94A6'
              : monthlyAvgScore >= 70 ? '#45A870'
              : monthlyAvgScore >= 50 ? '#5585E8'
              : monthlyAvgScore >= 35 ? '#E8A030'
              : '#D94F4F',
          },
          { label: 'Submitted', value: String(submittedDays.length), valueColor: '#45A870' },
          { label: 'Missed',    value: String(missedDays.length),    valueColor: missedDays.length > 0 ? '#D94F4F' : '#8C94A6' },
        ].map(({ label, value, valueColor }, i) => (
          <div key={label} style={{
            padding: '8px 18px',
            display: 'flex', alignItems: 'center', gap: 8,
            borderLeft: i > 0 ? '1px solid #EEF0F4' : 'none',
          }}>
            <span style={{ fontSize: 11, color: '#8C94A6', fontWeight: 500, whiteSpace: 'nowrap' }}>{label}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: valueColor, lineHeight: 1 }}>{value}</span>
          </div>
        ))}
      </div>

      {/* ── Log history card ── */}
      <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 12, overflow: 'hidden' }}>

        {/* Card header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #EEF0F4' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>Monthly Log History</div>
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#EDEEF1', borderBottom: '1px solid #E2E4EA' }}>
                {[
                  { label: 'Date',        width: '10%' },
                  { label: 'Work Logged', width: '48%' },
                  { label: 'Rating',      width: '10%' },
                  { label: 'Score',       width: '12%' },
                  { label: 'Result',      width: '20%' },
                ].map(({ label, width }) => (
                  <th key={label} style={{
                    padding: '9px 16px', textAlign: 'left', width,
                    fontSize: 10, fontWeight: 600, color: '#8C94A6',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    whiteSpace: 'nowrap',
                  }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map(({ date, log, status }) => {
                const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-IN', {
                  day: 'numeric', month: 'short',
                })
                const trendDay    = trendMap.get(date)
                const resultScore = trendDay?.breakdown.total ?? null

                const result: { label: string; color: string; bg: string } =
                  status === 'pending'   ? { label: 'Today',            color: '#E8A030', bg: '#E8A03012' } :
                  status === 'missed'    ? { label: 'Missed EOD',       color: '#D94F4F', bg: '#D94F4F0E' } :
                  resultScore === null   ? { label: 'Submitted',        color: '#45A870', bg: '#45A87012' } :
                  resultScore >= 70      ? { label: 'Great Day',        color: '#45A870', bg: '#45A87012' } :
                  resultScore >= 50      ? { label: 'Good Day',         color: '#5585E8', bg: '#5585E812' } :
                  resultScore >= 35      ? { label: 'Low Activity',     color: '#E8A030', bg: '#E8A03012' } :
                                          { label: 'Needs Improvement', color: '#D94F4F', bg: '#D94F4F0E' }

                const isSubmitted = status === 'submitted'
                const isMissed    = status === 'missed'

                return (
                  <tr
                    key={date}
                    style={{ borderBottom: '1px solid #F4F5F7', background: isMissed ? '#FEF9F9' : 'transparent' }}
                    onMouseEnter={e => { if (!isMissed) (e.currentTarget as HTMLTableRowElement).style.background = '#FAFBFC' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = isMissed ? '#FEF9F9' : 'transparent' }}
                  >
                    <td style={{
                      padding: '11px 16px', whiteSpace: 'nowrap',
                      fontSize: 12, fontWeight: 500, color: '#8C94A6',
                    }}>{dateLabel}</td>
                    <td style={{
                      padding: '11px 16px',
                      color: isSubmitted ? '#1E2330' : '#C0C4CF',
                      maxWidth: 0, width: '55%',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontSize: 13, fontWeight: isSubmitted ? 450 : 400,
                    }} title={log?.summary ?? undefined}>
                      {log?.summary ?? <span style={{ fontStyle: 'italic', color: '#C0C4CF' }}>No log submitted</span>}
                    </td>
                    <td style={{
                      padding: '11px 16px', whiteSpace: 'nowrap',
                      color: '#E8A030', letterSpacing: 1.5, fontSize: 12,
                    }}>
                      {log?.self_score
                        ? '★'.repeat(log.self_score)
                        : <span style={{ color: '#D5D9E0', letterSpacing: 0 }}>—</span>}
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      {(() => {
                        const scoreVal = trendDay
                          ? trendDay.breakdown.total
                          : status === 'submitted' ? 12
                          : status === 'missed'    ? -12
                          : null
                        if (scoreVal === null) return <span style={{ color: '#D5D9E0' }}>—</span>
                        const scoreColor = trendDay
                          ? (scoreVal >= 70 ? '#45A870' : scoreVal >= 50 ? '#5585E8' : scoreVal >= 35 ? '#E8A030' : '#D94F4F')
                          : (status === 'submitted' ? '#45A870' : '#D94F4F')
                        const label = trendDay ? String(scoreVal) : scoreVal > 0 ? `+${scoreVal}` : String(scoreVal)
                        return (
                          <button
                            onClick={() => setSelectedDay({ date, trendDay, status })}
                            title="Click for score breakdown"
                            style={{
                              fontSize: 12, fontWeight: 700, color: scoreColor,
                              background: scoreColor + '12', border: `1px solid ${scoreColor}28`,
                              padding: '3px 9px', borderRadius: 5,
                              cursor: 'pointer', fontFamily: 'inherit',
                            }}
                          >{label}</button>
                        )
                      })()}
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      <span style={{
                        display: 'inline-block',
                        fontSize: 11, fontWeight: 600,
                        color: result.color, background: result.bg,
                        padding: '3px 9px', borderRadius: 5,
                        letterSpacing: '0.01em',
                      }}>{result.label}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {selectedDay && <DayScoreModal day={selectedDay} onClose={() => setSelectedDay(null)} />}

    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
type Tab       = 'today' | 'current_month' | 'last_month'

const TAB_LABELS: Record<Tab, string> = {
  today:         'Today',
  current_month: 'Current Month',
  last_month:    'Last Month',
}

export default function PerformancePage() {
  const [profile,          setProfile]          = useState<UserProfile | null>(null)
  const [token,            setToken]            = useState('')
  const [tab,              setTab]              = useState<Tab>('today')
  const [perfTodayData,    setPerfTodayData]    = useState<PerformanceData | null>(null)
  const [perfTodayLoading, setPerfTodayLoading] = useState(false)
  const [loading,          setLoading]          = useState(true)
  const [audit,            setAudit]            = useState<PerformanceAudit | null>(null)
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

  // ── Single fetch: today score + 7-day trend in one request ──────────────────
  const fetchPerf = useCallback(async (t: string, bustCache = false) => {
    if (!t) return
    const cacheKey = `${viewAsUserId ?? 'self'}:daily`
    if (!bustCache && perfCacheRef.current[cacheKey]) {
      setPerfTodayData(perfCacheRef.current[cacheKey])
      return
    }
    setPerfTodayLoading(true)
    setAudit(null)
    try {
      const qs = new URLSearchParams({ period: 'daily' })
      if (viewAsUserId) qs.set('userId', viewAsUserId)
      const res = await fetch(`/api/performance-metrics?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${t}` },
      })
      if (res.ok) {
        const data = await res.json()
        perfCacheRef.current[cacheKey] = data
        setPerfTodayData(data)
      }
    } finally {
      setPerfTodayLoading(false)
    }
  }, [viewAsUserId])

  useEffect(() => {
    if (!token) return
    fetchPerf(token)
  }, [token, fetchPerf])

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const runAudit = async () => {
    if (!perfTodayData || !token) return
    setAuditLoading(true)
    try {
      const res = await fetch('/api/performance-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          period:        'daily',
          inputs:        perfTodayData.inputs,
          breakdown:     perfTodayData.breakdown,
          trend:         perfTodayData.trend ?? [],
          trendAnalysis: perfTodayData.trendAnalysis,
          userName:      perfTodayData.userName,
          score:         perfTodayData.score,
          rating:        perfTodayData.rating,
        }),
      })
      const json = await res.json().catch(() => null)
      if (res.ok && json?.audit) {
        setAudit(json.audit)
      } else {
        console.error('Reflection error:', json)
      }
    } catch (err) {
      console.error('Reflection network error:', err)
    } finally {
      setAuditLoading(false)
    }
  }

  const handleEodSaved = (log: { summary: string; self_score: number | null }) => {
    // Optimistically update so the Discipline card reflects the save immediately
    setPerfTodayData(prev => {
      if (!prev) return prev
      const alreadyHad = prev.inputs.hasEodLog
      const newDiscipline = alreadyHad ? prev.breakdown.discipline : Math.min(prev.breakdown.discipline + 12, 20)
      return {
        ...prev,
        eodLog: { ...(prev.eodLog ?? { id: '', user_id: '', log_date: '', blockers: null, created_at: '', updated_at: '' }), summary: log.summary, highlights: null, self_score: log.self_score },
        inputs: { ...prev.inputs, hasEodLog: true },
        breakdown: { ...prev.breakdown, discipline: newDiscipline },
      }
    })
    // Silent refetch for accuracy after EOD save
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
            setPerfTodayData(data)
          }
        })
        .catch(() => { /* optimistic update already applied */ })
    }
  }

  const dataReady = !loading && !perfTodayLoading
  useEffect(() => {
    if (!showLoader) return
    if (dataReady) {
      const finishProgress = () => { setProgress(100) }
      finishProgress()
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
      actions={viewAsUserId ? (
        <a href="/performance/team" style={{
          fontSize: 12, fontWeight: 600, color: '#8C94A6', textDecoration: 'none',
          border: '1px solid #EEF0F4', padding: '6px 14px', borderRadius: 7,
        }}>← Back to Team Performance</a>
      ) : isAdminOrManager ? (
        <a href="/performance/team" style={{
          fontSize: 12, fontWeight: 600, color: '#5585E8', textDecoration: 'none',
          border: '1px solid #5585E815', background: '#5585E808',
          padding: '6px 14px', borderRadius: 7,
        }}>Team View →</a>
      ) : undefined}
    >
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '8px 16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Excluded from team reporting. Shown above everything else, because the
            reader needs to know it before they read a single figure below. The
            page stays fully functional — only the team comparison is absent. */}
        {perfTodayData?.exclusionNotice && (
          <div style={{
            padding: '10px 14px', borderRadius: 9, fontSize: 12.5, lineHeight: 1.55,
            background: '#FFFBEB', border: '1px solid #FDE68A', color: '#92400E',
          }}>
            <strong style={{ fontWeight: 700 }}>Not included in team Performance.</strong>{' '}
            {perfTodayData.exclusionNotice}
          </div>
        )}

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
          perfTodayLoading ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>Loading…</div>
          ) : perfTodayData ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : '3fr 2fr',
              gap: 20,
              alignItems: 'start',
            }}>

              {/* LEFT COLUMN: score card + EOD form */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{
                  background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10,
                  padding: '20px 20px',
                  display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 20, alignItems: 'flex-start',
                }}>
                  {/* Ring + accountability info */}
                  {(() => {
                    const eodSubmittedTime = perfTodayData.eodLog?.updated_at
                      ? new Date(perfTodayData.eodLog.updated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
                      : null
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                        <ScoreRing score={perfTodayData.score} rating={perfTodayData.rating} />
                        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 5 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 10, color: '#A0A8B8' }}>EOD Submitted</span>
                            <span style={{ fontSize: 10, fontWeight: 600, color: perfTodayData.inputs.hasEodLog ? '#45A870' : '#D94F4F' }}>
                              {eodSubmittedTime ?? 'Not yet'}
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })()}

                  {/* Breakdown */}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      Score Components
                    </div>
                    {(() => {
                      const totalCompleted = perfTodayData.inputs.completedHigh + perfTodayData.inputs.completedMedium + perfTodayData.inputs.completedLow
                      const outputGap = 50 - perfTodayData.breakdown.output
                      const momentumGap = 20 - perfTodayData.breakdown.momentum
                      const eodTime = perfTodayData.eodLog?.updated_at
                        ? new Date(perfTodayData.eodLog.updated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
                        : null

                      const rows: { label: string; value: string; sub: string; color: string }[] = [
                        {
                          label: 'Output',
                          value: `${perfTodayData.breakdown.output}/50`,
                          sub: outputGap > 0
                            ? `${totalCompleted} task${totalCompleted !== 1 ? 's' : ''} · ${outputGap} pts to max`
                            : `${totalCompleted} task${totalCompleted !== 1 ? 's' : ''} · full score`,
                          color: perfTodayData.breakdown.output >= 30 ? '#45A870' : '#8C94A6',
                        },
                        {
                          label: 'Momentum',
                          value: `${perfTodayData.breakdown.momentum}/20`,
                          sub: momentumGap > 0
                            ? `${perfTodayData.inputs.statusUpdates} update${perfTodayData.inputs.statusUpdates !== 1 ? 's' : ''} · ${momentumGap} pts to max`
                            : `${perfTodayData.inputs.statusUpdates} updates · full score`,
                          color: '#5585E8',
                        },
                        {
                          label: 'Discipline',
                          value: `${perfTodayData.breakdown.discipline}/20`,
                          sub: perfTodayData.inputs.hasEodLog
                            ? (eodTime ? `Submitted at ${eodTime}` : '✓ EOD submitted')
                            : 'Not submitted · +12 pts available',
                          color: perfTodayData.inputs.hasEodLog ? '#45A870' : '#D94F4F',
                        },
                        {
                          label: 'Risk',
                          value: perfTodayData.breakdown.risk === 0 ? '✓ Clean' : `${perfTodayData.breakdown.risk}`,
                          sub: perfTodayData.breakdown.risk === 0
                            ? 'No overdue tasks'
                            : `${perfTodayData.inputs.overdueCount} overdue · ${perfTodayData.inputs.staleBlockedCount} stale`,
                          color: perfTodayData.breakdown.risk < 0 ? '#D94F4F' : '#45A870',
                        },
                      ]

                      return (
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: isMobile ? '80px auto' : '68px 64px 1fr',
                          rowGap: 8,
                          alignItems: 'center',
                        }}>
                          {rows.map(({ label, value, sub, color }) => (
                            <React.Fragment key={label}>
                              <div style={{ fontSize: 11, color: '#8C94A6' }}>{label}</div>
                              <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
                              {!isMobile && <div style={{ fontSize: 11, color: '#A0A8B8', lineHeight: 1.3 }}>{sub}</div>}
                            </React.Fragment>
                          ))}
                        </div>
                      )
                    })()}
                  </div>
                </div>

                {perfTodayData.inputs.staleBlockedCount > 0 && (
                  <div style={{
                    background: '#D94F4F10', border: '1px solid #D94F4F30',
                    borderRadius: 10, padding: '12px 16px',
                    display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#D94F4F', flexShrink: 0 }} />
                    <div style={{ fontSize: 12.5, color: '#3D4455' }}>
                      <strong>{perfTodayData.inputs.staleBlockedCount} task{perfTodayData.inputs.staleBlockedCount > 1 ? 's have' : ' has'} been blocked for &gt;2 days</strong> — costing {perfTodayData.inputs.staleBlockedCount * 8} pts. Escalate or add an update.
                    </div>
                  </div>
                )}
                <EodLogForm existing={perfTodayData.eodLog} token={token} onSaved={handleEodSaved} />
              </div>

              {/* RIGHT COLUMN: coach + reflection */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <TodayCoach data={perfTodayData} />
                <AuditPanel audit={audit} loading={auditLoading} onGenerate={runAudit} />
              </div>

            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>No data available.</div>
          )
        )}

        {/* ── CURRENT MONTH TAB ── */}
        {tab === 'current_month' && token && (
          <MonthlyView token={token} which="current" viewAsUserId={viewAsUserId} />
        )}

        {/* ── LAST MONTH TAB ── */}
        {tab === 'last_month' && token && (
          <MonthlyView token={token} which="last" viewAsUserId={viewAsUserId} />
        )}

      </div>
    </DashboardLayout>
  )
}

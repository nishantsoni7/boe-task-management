'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import type {
  UserProfile, PerformanceData, PerformanceAudit, TrendDay,
  ScoreBreakdown, TrendClassification,
} from '@/lib/types'

// ─── Score ring (SVG) ─────────────────────────────────────────────────────────
function ScoreRing({ score, rating }: { score: number; rating: string }) {
  const r    = 52
  const circ = 2 * Math.PI * r
  const dash = circ * (score / 100)

  const ringColor = {
    excellent:        '#45A870',
    good:             '#5585E8',
    average:          '#E8A030',
    needs_improvement: '#D94F4F',
    critical:         '#B03030',
  }[rating] ?? '#8C94A6'

  const label = {
    excellent:        'Excellent',
    good:             'Good',
    average:          'Average',
    needs_improvement: 'Needs Work',
    critical:         'Critical',
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
          x={65} y={60}
          textAnchor="middle" dominantBaseline="middle"
          fill="#111318" fontSize={28} fontWeight={700}
          style={{ transform: 'rotate(90deg) translate(0px, -130px)', fontFamily: 'var(--font-syne)' }}
        >
          {score}
        </text>
        <text
          x={65} y={82}
          textAnchor="middle" dominantBaseline="middle"
          fill="#8C94A6" fontSize={11}
          style={{ transform: 'rotate(90deg) translate(0px, -130px)', fontFamily: 'var(--font-dm-sans)' }}
        >
          /100
        </text>
      </svg>
      <span style={{
        fontSize: 13, fontWeight: 600, color: ringColor,
        background: ringColor + '18',
        padding: '3px 12px', borderRadius: 999,
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
// Shows the 4 pillars as horizontal progress bars so you know *why* you scored X
function BreakdownBar({ label, earned, max, color }: { label: string; earned: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(100, (earned / max) * 100))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 80, fontSize: 12, color: '#6B7384', fontWeight: 500, flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 6, background: '#EEF0F4', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
      </div>
      <div style={{ width: 52, textAlign: 'right', fontSize: 12, fontWeight: 600, color: earned < 0 ? '#D94F4F' : '#111318', flexShrink: 0 }}>
        {earned < 0 ? earned : `+${earned}`} / {max < 0 ? max : max}
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

// ─── Trend classification badge ───────────────────────────────────────────────
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
          >
            Run Audit
          </button>
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
      >
        Regenerate
      </button>
    </div>
  )
}

// ─── EOD Log form ─────────────────────────────────────────────────────────────
function EodLogForm({ existing, token, onSaved }: {
  existing: { summary: string; highlights: string | null; blockers: string | null; self_score: number | null } | null
  token: string
  onSaved: () => void
}) {
  const [summary,    setSummary]    = useState(existing?.summary ?? '')
  const [highlights, setHighlights] = useState(existing?.highlights ?? '')
  const [blockers,   setBlockers]   = useState(existing?.blockers ?? '')
  const [selfScore,  setSelfScore]  = useState<number>(existing?.self_score ?? 0)
  const [saving,     setSaving]     = useState(false)
  const [saved,      setSaved]      = useState(!!existing)

  const submit = async () => {
    if (!summary.trim()) return
    setSaving(true)
    try {
      const res = await fetch('/api/daily-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ summary, highlights: highlights || null, blockers: blockers || null, self_score: selfScore || null }),
      })
      if (res.ok) { setSaved(true); onSaved() }
    } finally {
      setSaving(false)
    }
  }

  const stars = [1, 2, 3, 4, 5]

  return (
    <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111318' }}>
          End-of-Day Log
          {saved && <span style={{ fontSize: 11, color: '#45A870', marginLeft: 8 }}>✓ Saved</span>}
        </div>
        <div style={{ fontSize: 11, color: '#8C94A6' }}>+12 pts discipline</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384', display: 'block', marginBottom: 4 }}>
            What did you accomplish today? <span style={{ color: '#D94F4F' }}>*</span>
          </label>
          <textarea
            value={summary}
            onChange={e => { setSummary(e.target.value); setSaved(false) }}
            placeholder="Summarise your key work for the day…"
            rows={3}
            style={{
              width: '100%', resize: 'vertical',
              fontSize: 13, color: '#111318', lineHeight: 1.5,
              border: '1px solid #EEF0F4', borderRadius: 7,
              padding: '8px 10px', outline: 'none',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384', display: 'block', marginBottom: 4 }}>
            Highlights / wins
          </label>
          <input
            value={highlights}
            onChange={e => { setHighlights(e.target.value); setSaved(false) }}
            placeholder="Any notable achievement or milestone…"
            style={{
              width: '100%', fontSize: 13, color: '#111318',
              border: '1px solid #EEF0F4', borderRadius: 7,
              padding: '8px 10px', outline: 'none',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#6B7384', display: 'block', marginBottom: 4 }}>
            Blockers / pending
          </label>
          <input
            value={blockers}
            onChange={e => { setBlockers(e.target.value); setSaved(false) }}
            placeholder="Anything blocking you tomorrow…"
            style={{
              width: '100%', fontSize: 13, color: '#111318',
              border: '1px solid #EEF0F4', borderRadius: 7,
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
            {stars.map(n => (
              <button
                key={n}
                onClick={() => { setSelfScore(n); setSaved(false) }}
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

      <button
        onClick={submit}
        disabled={saving || !summary.trim()}
        style={{
          alignSelf: 'flex-start',
          fontSize: 13, fontWeight: 600,
          background: '#111318', color: '#fff',
          border: 'none', borderRadius: 8,
          padding: '9px 20px', cursor: 'pointer',
          opacity: saving || !summary.trim() ? 0.5 : 1,
        }}
      >
        {saving ? 'Saving…' : saved ? 'Update Log' : 'Submit Log'}
      </button>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
type Period = 'daily' | 'weekly' | 'monthly'

export default function PerformancePage() {
  const [profile,      setProfile]      = useState<UserProfile | null>(null)
  const [token,        setToken]        = useState('')
  const [period,       setPeriod]       = useState<Period>('daily')
  const [perfData,     setPerfData]     = useState<PerformanceData | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [perfLoading,  setPerfLoading]  = useState(false)
  const [audit,        setAudit]        = useState<PerformanceAudit | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)
      const { data: profileData } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at')
        .eq('id', session.user.id)
        .single()
      if (profileData) setProfile(profileData as UserProfile)
      setLoading(false)
    }
    init()
  }, [supabase, router])

  const fetchPerf = useCallback(async (p: Period, t: string) => {
    if (!t) return
    setPerfLoading(true)
    setAudit(null)
    try {
      const res = await fetch(`/api/performance-metrics?period=${p}`, {
        headers: { Authorization: `Bearer ${t}` },
      })
      if (res.ok) setPerfData(await res.json())
    } finally {
      setPerfLoading(false)
    }
  }, [])

  useEffect(() => {
    if (token) fetchPerf(period, token)
  }, [period, token, fetchPerf])

  // Audit now sends the full structured payload (breakdown + inputs + trend + trendAnalysis)
  const runAudit = async () => {
    if (!perfData || !token) return
    setAuditLoading(true)
    try {
      const res = await fetch('/api/performance-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          period,
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

  const handleEodSaved = () => { if (token) fetchPerf(period, token) }

  if (loading) return <LoadingScreen />

  const today  = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const isAdminOrManager = profile?.role === 'admin' || profile?.role === 'manager'

  const periodLabel: Record<Period, string> = { daily: 'Today', weekly: 'This Week', monthly: 'This Month' }

  return (
    <DashboardLayout
      profile={profile}
      title="Performance"
      subtitle={today}
      onSignOut={async () => { await supabase.auth.signOut(); router.push('/login') }}
      actions={isAdminOrManager ? (
        <a href="/performance/team" style={{
          fontSize: 12, fontWeight: 600, color: '#5585E8', textDecoration: 'none',
          border: '1px solid #5585E815', background: '#5585E808',
          padding: '6px 14px', borderRadius: 7,
        }}>Team View →</a>
      ) : undefined}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Period tabs */}
        <div style={{ display: 'flex', gap: 4, background: '#F4F5F7', borderRadius: 10, padding: 4, alignSelf: 'flex-start' }}>
          {(['daily', 'weekly', 'monthly'] as Period[]).map(p => (
            <button key={p} onClick={() => setPeriod(p)} style={{
              fontSize: 12.5, fontWeight: 600,
              padding: '6px 16px', borderRadius: 7,
              border: 'none', cursor: 'pointer',
              background: period === p ? '#fff' : 'transparent',
              color: period === p ? '#111318' : '#8C94A6',
              boxShadow: period === p ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              transition: 'all 0.15s ease',
            }}>
              {periodLabel[p]}
            </button>
          ))}
        </div>

        {perfLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>Loading…</div>
        ) : perfData ? (
          <>
            {/* Score ring + 4 pillar metric cards */}
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 16, alignItems: 'start' }}>
              <div style={{
                background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10,
                padding: '20px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
              }}>
                <ScoreRing score={perfData.score} rating={perfData.rating} />
                {/* Trend badge below score ring */}
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

              {/* 4 metric cards: one per pillar */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <MetricCard
                  label="Output"
                  value={`${perfData.breakdown.output}/50`}
                  sub={
                    period === 'daily'
                      ? `${perfData.inputs.completedHigh + perfData.inputs.completedMedium + perfData.inputs.completedLow} task${perfData.inputs.completedHigh + perfData.inputs.completedMedium + perfData.inputs.completedLow !== 1 ? 's' : ''} completed`
                      : `${perfData.aggregate?.totalCompleted ?? 0} tasks this ${period === 'weekly' ? 'week' : 'month'}`
                  }
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

            {/* Score pillar breakdown bars (always visible) */}
            <ScoreBreakdownPanel breakdown={perfData.breakdown} />

            {/* Trend chart — always shown, especially useful on daily view for context */}
            {perfData.trend && perfData.trend.length > 0 && (
              <div style={{ background: '#fff', border: '1px solid #EEF0F4', borderRadius: 10, padding: '18px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#6B7384', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {period === 'daily' ? '7-Day Score Context' : period === 'weekly' ? '14-Day Trend' : '30-Day Trend'}
                  </div>
                  <div style={{
                    fontSize: 11, fontWeight: 600,
                    color: TREND_COLORS[perfData.trendAnalysis.classification],
                  }}>
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
            )}

            {/* Weekly/Monthly aggregate summary */}
            {(period === 'weekly' || period === 'monthly') && perfData.aggregate && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <MetricCard
                  label={period === 'weekly' ? 'Week Total' : 'Month Total'}
                  value={perfData.aggregate.totalCompleted}
                  sub={`${perfData.aggregate.totalCompletedHigh} high · ${perfData.aggregate.totalCompletedMedium} med · ${perfData.aggregate.totalCompletedLow} low`}
                />
                <MetricCard
                  label="EOD Log Rate"
                  value={`${perfData.aggregate.eodLogRate}%`}
                  sub={`${period === 'weekly' ? '7' : '30'}-day discipline`}
                  accent={perfData.aggregate.eodLogRate >= 80 ? '#45A870' : perfData.aggregate.eodLogRate >= 50 ? '#E8A030' : '#D94F4F'}
                />
                <MetricCard
                  label="Week / Week"
                  value={perfData.trendAnalysis.weekOverWeekDelta >= 0 ? `+${perfData.trendAnalysis.weekOverWeekDelta}` : `${perfData.trendAnalysis.weekOverWeekDelta}`}
                  sub="pts vs prior period"
                  accent={perfData.trendAnalysis.weekOverWeekDelta > 0 ? '#45A870' : perfData.trendAnalysis.weekOverWeekDelta < 0 ? '#D94F4F' : undefined}
                />
              </div>
            )}

            {/* Stale-blocked alert */}
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

            {/* EOD Log (daily view) */}
            {period === 'daily' && (
              <EodLogForm existing={perfData.eodLog} token={token} onSaved={handleEodSaved} />
            )}

            {/* AI Audit */}
            <AuditPanel audit={audit} loading={auditLoading} onGenerate={runAudit} />
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#8C94A6', fontSize: 13 }}>No data available.</div>
        )}

        {/* Score model explanation */}
        <div style={{ background: '#F8F9FB', border: '1px solid #EEF0F4', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#8C94A6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
            How your score is calculated
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px', fontSize: 12, color: '#4A5261' }}>
            <div><strong>Output (0–50):</strong> High ×22, Medium ×15, Low ×8</div>
            <div><strong>Risk (0 to −40):</strong> Overdue ×−5, Stale block ×−8</div>
            <div><strong>Momentum (0–20):</strong> Update ×4, Blocker cleared ×4</div>
            <div><strong>Discipline (0–20):</strong> EOD log +12, Active +5, Ack +3</div>
          </div>
        </div>

      </div>
    </DashboardLayout>
  )
}

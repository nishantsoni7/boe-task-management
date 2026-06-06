'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DashboardLayout } from '@/components/layout/DashboardLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import type {
  UserProfile, MemberPerfEntry, PerformanceRating,
  TrendClassification, ScoreBreakdown,
} from '@/lib/types'

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

// ─── Score pill ───────────────────────────────────────────────────────────────
function ScorePill({ score, rating }: { score: number; rating: string }) {
  const color = ratingColor(rating)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 40, height: 40, borderRadius: '50%',
        background: color + '18', border: `2px solid ${color}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, fontWeight: 700, color,
      }}>{score}</div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color, whiteSpace: 'nowrap' }}>{ratingLabel(rating)}</div>
      </div>
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

// ─── Member card ──────────────────────────────────────────────────────────────
function MemberCard({ m, onViewProfile }: { m: MemberPerfEntry; onViewProfile: (id: string) => void }) {
  const color = ratingColor(m.rating)
  const trendColor = TREND_COLORS[m.trendClassification]

  return (
    <div style={{
      background: '#fff', border: '1px solid #EEF0F4',
      borderRadius: 10, padding: '16px 18px',
      display: 'flex', flexDirection: 'column', gap: 12,
      borderLeft: `3px solid ${color}`,
    }}>
      {/* Header: name + score */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#111318' }}>{m.userName}</div>
          <div style={{ fontSize: 11, color: '#8C94A6', marginTop: 2 }}>
            {m.team}{m.position ? ` · ${m.position}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BreakdownMini breakdown={m.breakdown} />
          <ScorePill score={m.score} rating={m.rating} />
        </div>
      </div>

      {/* Key metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[
          { label: 'Completed', value: m.completedThisWeek, sub: 'this week',    accent: m.completedThisWeek > 0 ? '#45A870' : undefined },
          { label: 'Active',    value: m.activeTasks,       sub: 'tasks'                                                                   },
          { label: 'Overdue',   value: m.overdueCount,      sub: 'tasks',        accent: m.overdueCount > 0 ? '#D94F4F' : undefined        },
          { label: 'Stale Blk', value: m.staleBlockedCount, sub: '>2 days',      accent: m.staleBlockedCount > 0 ? '#D94F4F' : undefined   },
        ].map(({ label, value, sub, accent }) => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: accent ?? '#111318' }}>{value}</div>
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

// ─── Main page ────────────────────────────────────────────────────────────────
type SortKey = 'score' | 'name' | 'risk' | 'trend' | 'weekOverWeek'

export default function TeamPerformancePage() {
  const [profile,    setProfile]    = useState<UserProfile | null>(null)
  const [members,    setMembers]    = useState<MemberPerfEntry[]>([])
  const [loading,    setLoading]    = useState(true)
  const [sortBy,     setSortBy]     = useState<SortKey>('score')
  const [filterTeam, setFilterTeam] = useState('')

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

      const { data: allMembers } = await supabase
        .from('users')
        .select('id, full_name, team, position, role')
        .eq('is_active', true)
        .eq('is_deleted', false)
        .order('full_name')

      if (!allMembers) { setLoading(false); return }

      const perfResults = await Promise.all(
        (allMembers as { id: string; full_name: string; team: string; position: string | null; role: string }[]).map(async (m) => {
          try {
            const res = await fetch(`/api/performance-metrics?period=daily&userId=${m.id}`, {
              headers: { Authorization: `Bearer ${token}` },
            })
            if (!res.ok) return null
            const data = await res.json()

            // Derive risk level from score breakdown + stale blocked
            const riskScore = Math.abs(data.breakdown?.risk ?? 0) + (data.inputs?.staleBlockedCount ?? 0) * 4
            const riskLevel: MemberPerfEntry['riskLevel'] =
              riskScore >= 20 ? 'high' : riskScore >= 8 ? 'medium' : 'low'

            // EOD log streak: count consecutive days with EOD log from the trend
            const trend = data.trend ?? []
            let eodLogStreak = 0
            for (let i = trend.length - 1; i >= 0; i--) {
              if (trend[i].inputs?.hasEodLog) eodLogStreak++
              else break
            }

            // Completed this week: sum from 7-day trend
            const completedThisWeek = trend.reduce(
              (s: number, d: { inputs?: { completedHigh?: number; completedMedium?: number; completedLow?: number } }) =>
                s + (d.inputs?.completedHigh ?? 0) + (d.inputs?.completedMedium ?? 0) + (d.inputs?.completedLow ?? 0),
              0
            )

            return {
              userId:              m.id,
              userName:            m.full_name,
              team:                m.team,
              position:            m.position,
              score:               data.score,
              rating:              data.rating as PerformanceRating,
              breakdown:           data.breakdown,
              overdueCount:        data.inputs?.overdueCount      ?? 0,
              staleBlockedCount:   data.inputs?.staleBlockedCount ?? 0,
              riskLevel,
              trendClassification: data.trendAnalysis?.classification ?? 'insufficient_data',
              weekOverWeekDelta:   data.trendAnalysis?.weekOverWeekDelta ?? 0,
              hasEodLogToday:      data.inputs?.hasEodLog ?? false,
              eodLogStreak,
              activeTasks:         data.inputs?.activeTasks ?? 0,
              completedThisWeek,
            } satisfies MemberPerfEntry
          } catch {
            return null
          }
        })
      )

      setMembers(perfResults.filter(Boolean) as MemberPerfEntry[])
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

  if (loading) return <LoadingScreen />

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
      </div>
    </DashboardLayout>
  )
}

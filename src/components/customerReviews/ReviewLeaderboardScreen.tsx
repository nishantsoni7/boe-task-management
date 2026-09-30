'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Trophy } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { colors } from '@/lib/tokens'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { formatCredits, reviewMonthLabel } from '@/lib/boeCredits/ledger'
import {
  FIRST_PLACE_FOOTNOTE,
  POINTS_PER_CREDIT,
  firstPlaceMessage,
  monthChoices,
  parseLeaderboard,
  type Leaderboard,
  type LeaderboardRow,
} from '@/lib/customerReviews/reviewReport'

// ── The monthly review leaderboard, for every signed-in employee ─────────────
//
// Ranked by REWARD-ELIGIBLE review count for the month (approved, with a live
// credit). Equal counts SHARE a rank — the rank number and a "tied" mark say so,
// whatever order the names display in. Your own row is highlighted and always
// shown, even when you are outside the top rows.
//
// Points are review-earned credits x 10 for the month and start again each month;
// they are not the performance score. Credits are shown separately.
//
// The data is one database function (customer_review_leaderboard): names, counts,
// credits and points — no review content. It needs only a signed-in, active
// account; no Review Workflow permission.

const TOP_ROWS = 10

const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'right', fontSize: '11px', fontWeight: 700, letterSpacing: '0.03em',
  textTransform: 'uppercase', color: colors.secondary, borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'right', color: colors.primary, borderBottom: `1px solid ${colors.borderSoft}`, fontVariantNumeric: 'tabular-nums',
}

export function ReviewLeaderboardScreen() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [ready, setReady] = useState(false)
  const [month, setMonth] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data } = await supabase.from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!active) return
      if (!data) { router.push('/login'); return }
      setProfile(data as UserProfile)
      setReady(true)
    })()
    return () => { active = false }
  }, [supabase, router])

  const board = useQuery({
    queryKey: ['review-leaderboard', month],
    enabled: ready,
    queryFn: async (): Promise<Leaderboard> => {
      const { data, error } = await supabase.rpc('customer_review_leaderboard', { p_month: month })
      if (error) throw new Error('The leaderboard could not be loaded.')
      const parsed = parseLeaderboard(data)
      if (!parsed) throw new Error('The leaderboard came back in a shape this screen does not understand.')
      return parsed
    },
    staleTime: 30 * 1000,
    retry: false,
  })

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (!ready) return <LoadingScreen />

  const data = board.data
  const months = data ? monthChoices(data.current_month, 6) : []
  const label = data ? reviewMonthLabel(data.month) : ''

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Review leaderboard"
      subtitle="Reward-eligible reviews this month"
      onSignOut={handleSignOut}
    >
      <div style={{ maxWidth: 760, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: colors.secondary, maxWidth: 260 }}>
          Month
          <select
            value={month ?? ''}
            onChange={e => { setMonth(e.target.value === '' ? null : e.target.value); setShowAll(false) }}
            style={{ minHeight: 44, padding: '8px 10px', borderRadius: 8, fontSize: 13, border: `1px solid ${colors.borderSoft}`, background: colors.base, color: colors.primary, fontFamily: 'inherit' }}
          >
            <option value="">{data ? `${reviewMonthLabel(data.current_month)} (current)` : 'Current month'}</option>
            {months.slice(1).map(m => <option key={m} value={m}>{reviewMonthLabel(m)}</option>)}
          </select>
        </label>

        {board.isPending ? (
          <p role="status" style={{ margin: 0, fontSize: 12.5, color: colors.muted }}>Loading the leaderboard…</p>
        ) : board.isError || !data ? (
          <div role="alert" style={{ padding: '14px 16px', borderRadius: 10, border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{board.error instanceof Error ? board.error.message : 'The leaderboard could not be loaded.'}</span>
            <button type="button" className="boe-btn boe-btn-ghost" onClick={() => { void board.refetch() }} style={{ minHeight: 44, padding: '7px 14px', fontSize: 12.5 }}>Try again</button>
          </div>
        ) : (
          <>
            <section aria-label="Your position" style={{
              padding: '12px 14px', borderRadius: 10, border: `1px solid ${colors.borderSoft}`, background: colors.base,
              display: 'flex', gap: 12, alignItems: 'flex-start',
            }}>
              <Trophy size={20} strokeWidth={1.8} aria-hidden="true" style={{ color: '#B45309', flexShrink: 0, marginTop: 2 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary }}>
                  {data.month === data.current_month
                    ? firstPlaceMessage(data.state, data.need, data.leaders)
                    : data.me ? `You finished ${label} on rank ${data.me.rank}` : `${label}: you were not taking part`}
                </div>
                {data.month === data.current_month && (data.state === 'behind' || data.state === 'no_activity') && (
                  <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>{FIRST_PLACE_FOOTNOTE}</div>
                )}
                {data.me && (
                  <div style={{ fontSize: 12.5, color: colors.secondary, marginTop: 4 }}>
                    Rank {data.me.rank} · {data.me.reviews} eligible {data.me.reviews === 1 ? 'review' : 'reviews'} · {formatCredits(data.me.credits)} · {data.me.points} points
                  </div>
                )}
              </div>
            </section>

            {data.rows.length === 0 ? (
              <p style={{ margin: 0, padding: '14px 16px', borderRadius: 10, border: `1px dashed ${colors.border}`, color: colors.muted, fontSize: 13 }}>
                Nobody has an eligible review in {label} yet.
              </p>
            ) : (
              <Table rows={data.rows} showAll={showAll} onToggle={() => setShowAll(v => !v)} />
            )}

            <p style={{ margin: 0, fontSize: 11.5, color: colors.muted, lineHeight: 1.55 }}>
              Ranked by reward-eligible reviews in {label}: approved reviews with a live credit. Equal counts share a rank.
              Review credits are shown separately from points; points are review credits × {POINTS_PER_CREDIT} for the month and
              start again each month. They are not your performance score.
              {' '}<Link href="/my-credits" style={{ color: colors.secondary }}>Your BOE Credits</Link>
            </p>
          </>
        )}
      </div>
    </AttendancePayrollLayout>
  )
}

function Table({ rows, showAll, onToggle }: { rows: LeaderboardRow[]; showAll: boolean; onToggle: () => void }) {
  const top = rows.slice(0, TOP_ROWS)
  const me = rows.find(r => r.is_me)
  // Keep the signed-in employee visible even when they are below the top rows.
  const meOutside = !showAll && me && !top.some(r => r.employee_id === me.employee_id)
  const shown = showAll ? rows : top
  return (
    <section aria-label="Leaderboard" style={{ borderRadius: 10, border: `1px solid ${colors.borderSoft}`, background: colors.base, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 0, tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th scope="col" style={{ ...th, textAlign: 'left' }}>Rank</th>
              <th scope="col" style={{ ...th, textAlign: 'left' }}>Employee</th>
              <th scope="col" style={th}>Reviews</th>
              <th scope="col" style={th}>Points</th>
              <th scope="col" style={th}>Credits</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => <Row key={r.employee_id} row={r} />)}
            {meOutside && me && (
              <>
                <tr aria-hidden="true"><td colSpan={5} style={{ ...td, textAlign: 'center', color: colors.muted, padding: '2px 10px' }}>⋮</td></tr>
                <Row row={me} />
              </>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > TOP_ROWS && (
        <button
          type="button"
          onClick={onToggle}
          style={{ width: '100%', minHeight: 44, border: 0, borderTop: `1px solid ${colors.borderSoft}`, background: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, color: colors.secondary }}
        >
          {showAll ? `Show the top ${TOP_ROWS}` : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  )
}

function Row({ row }: { row: LeaderboardRow }) {
  return (
    <tr aria-current={row.is_me ? 'true' : undefined} style={{ background: row.is_me ? 'rgba(79,111,208,0.08)' : undefined }}>
      <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>
        {row.rank}
        {row.tied && <span title="Tied: equal reviews share a rank" style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: colors.muted }}>tied</span>}
      </td>
      <td style={{ ...td, textAlign: 'left', fontWeight: row.is_me ? 700 : 500, overflowWrap: 'anywhere' }}>
        {row.name}{row.is_me ? ' (you)' : ''}
      </td>
      <td style={td}>{row.reviews}</td>
      <td style={td}>{row.points}</td>
      <td style={td}>{formatCredits(row.credits)}</td>
    </tr>
  )
}

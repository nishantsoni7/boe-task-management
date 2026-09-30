'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Trophy } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { Avatar } from '@/components/ui/atoms'
import { formatCredits, reviewMonthLabel } from '@/lib/boeCredits/ledger'
import {
  FIRST_PLACE_FOOTNOTE,
  REVIEW_LEADERBOARD_KEY,
  firstPlaceMessage,
  formatPoints,
  parseLeaderboard,
  type Leaderboard,
  type LeaderboardRow,
} from '@/lib/customerReviews/reviewReport'
import { arrangeLanding } from '@/lib/customerReviews/leaderboardLanding'

// The current-month leaderboard at the top of the Reviews landing page.
//
// ONE READ: customer_review_leaderboard(null) — the aggregate #269 built, which
// already applies the eligibility rules, the Asia/Kolkata month and credits =
// points x 10. Nothing is recalculated and nothing is fetched per employee. The
// query key is shared with the full leaderboard page so the two reuse one cache.
// Avatars are initials: the profile has no photo column, and looking one up per
// person would be exactly the per-employee query this avoids.

const GOLD = '#B45309'
const CARD: React.CSSProperties = {
  borderRadius: 12, border: `1px solid ${colors.borderSoft}`, background: colors.base, minWidth: 0,
}

const count = (n: number) => `${n} eligible ${n === 1 ? 'review' : 'reviews'}`

export function ReviewsLeaderboardPanel() {
  const supabase = useMemo(() => createClient(), [])
  const board = useQuery({
    queryKey: [...REVIEW_LEADERBOARD_KEY, null],
    queryFn: async (): Promise<Leaderboard> => {
      const { data, error } = await supabase.rpc('customer_review_leaderboard', { p_month: null })
      if (error) throw new Error('The leaderboard could not be loaded.')
      const parsed = parseLeaderboard(data)
      if (!parsed) throw new Error('The leaderboard came back in a shape this screen does not understand.')
      return parsed
    },
    staleTime: 30 * 1000,
    retry: false,
  })

  const data = board.data
  const label = data ? reviewMonthLabel(data.month) : 'this month'

  return (
    <section aria-labelledby="review-leaderboard-heading" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h2 id="review-leaderboard-heading" style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: colors.primary }}>
          Leaderboard · {label}
        </h2>
        <Link href="/my-credits/leaderboard" style={{ fontSize: 12.5, color: colors.secondary, fontWeight: 600 }}>
          Past months
        </Link>
      </header>

      {board.isPending ? (
        <p role="status" style={{ margin: 0, fontSize: 12.5, color: colors.muted }}>Loading the leaderboard…</p>
      ) : board.isError || !data ? (
        <div role="alert" style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid #FECACA', background: '#FEF2F2', color: '#B91C1C', fontSize: 13, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{board.error instanceof Error ? board.error.message : 'The leaderboard could not be loaded.'}</span>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={() => { void board.refetch() }} style={{ minHeight: 44, padding: '7px 14px', fontSize: 12.5 }}>Try again</button>
        </div>
      ) : (
        <Body data={data} label={label} />
      )}
    </section>
  )
}

function Body({ data, label }: { data: Leaderboard; label: string }) {
  const view = arrangeLanding(data)

  if (view.kind === 'empty') {
    return (
      <div style={{ ...CARD, borderStyle: 'dashed', padding: '22px 16px', textAlign: 'center' }}>
        <Trophy size={22} strokeWidth={1.6} aria-hidden="true" style={{ color: colors.muted }} />
        <p style={{ margin: '6px 0 2px', fontSize: 14, fontWeight: 700, color: colors.primary }}>No eligible reviews yet in {label}</p>
        <p style={{ margin: 0, fontSize: 12.5, color: colors.secondary }}>The first approved review takes the lead. Submit one to get on the board.</p>
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: view.runnersUp.length ? 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))' : '1fr' }}>
        <div style={{ ...CARD, padding: '16px 16px 14px', borderColor: 'rgba(180,83,9,0.35)', background: 'linear-gradient(180deg, #FFFBF2 0%, #FFFFFF 70%)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: GOLD }}>
            <Trophy size={15} strokeWidth={1.9} aria-hidden="true" />
            {view.joint ? `Joint leaders this month (${view.leaders.length})` : 'Leading this month'}
          </div>
          {view.leaders.map(r => <Person key={r.employee_id} row={r} size={view.joint ? 40 : 52} big={!view.joint} />)}
        </div>
        {view.runnersUp.length > 0 && (
          <div style={{ ...CARD, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.tertiary }}>
              {view.runnersUp.length > 1 ? 'Joint runners-up' : 'Runner-up'}
            </div>
            {view.runnersUp.map(r => <Person key={r.employee_id} row={r} size={36} />)}
          </div>
        )}
      </div>

      {data.me ? (
        <div style={{ ...CARD, padding: '10px 14px', background: 'rgba(79,111,208,0.06)', borderColor: 'rgba(79,111,208,0.25)' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: colors.primary }}>
            You are {data.rows.find(r => r.is_me)?.tied ? 'joint ' : ''}{ordinal(data.me.rank)} · {count(data.me.reviews)}
          </div>
          <div style={{ fontSize: 12.5, color: colors.secondary, marginTop: 2 }}>
            {firstPlaceMessage(data.state, data.need, data.leaders)}
          </div>
          {(data.state === 'behind' || data.state === 'no_activity') && (
            <div style={{ fontSize: 11.5, color: colors.muted, marginTop: 2 }}>{FIRST_PLACE_FOOTNOTE}</div>
          )}
        </div>
      ) : null}

      <ol aria-label="Ranking" style={{ ...CARD, listStyle: 'none', margin: 0, padding: 0, overflow: 'hidden' }}>
        {view.list.map((r, i) => (
          <li key={r.employee_id}>
            {view.meOutside && i === view.list.length - 1 && (
              <div aria-hidden="true" style={{ textAlign: 'center', color: colors.muted, fontSize: 12, lineHeight: 1 }}>⋮</div>
            )}
            <Line row={r} divider={i > 0} />
          </li>
        ))}
      </ol>
    </>
  )
}

function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

function Person({ row, size, big = false }: { row: LeaderboardRow; size: number; big?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <Avatar name={row.name} size={size} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: big ? 18 : 14, fontWeight: 700, color: colors.primary, overflowWrap: 'anywhere', lineHeight: 1.25 }}>
          {row.name}{row.is_me ? ' (you)' : ''}
        </div>
        <div style={{ fontSize: 12.5, color: colors.secondary, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
          {count(row.reviews)} · {formatPoints(row.points)} pts · {formatCredits(row.credits)}
        </div>
      </div>
    </div>
  )
}

function Line({ row, divider }: { row: LeaderboardRow; divider: boolean }) {
  return (
    <div
      aria-current={row.is_me ? 'true' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', minHeight: 44, minWidth: 0,
        borderTop: divider ? `1px solid ${colors.border}` : undefined,
        background: row.is_me ? 'rgba(79,111,208,0.08)' : undefined,
      }}
    >
      <span style={{ width: 26, flexShrink: 0, fontSize: 12.5, fontWeight: 700, color: row.rank === 1 ? GOLD : colors.tertiary, fontVariantNumeric: 'tabular-nums' }}>{row.rank}</span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: row.is_me ? 700 : 500, color: colors.primary, overflowWrap: 'anywhere' }}>
        {row.name}{row.is_me ? ' (you)' : ''}
        {row.tied && <span title="Tied: equal reviews share a rank" style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: colors.muted }}>tied</span>}
      </div>
      <div style={{ flexShrink: 0, textAlign: 'right', fontSize: 12, color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
        <strong style={{ color: colors.primary }}>{row.reviews}</strong> · {formatPoints(row.points)} pts · {formatCredits(row.credits)}
      </div>
    </div>
  )
}

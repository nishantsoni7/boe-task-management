'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Trophy } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { reviewMonthLabel } from '@/lib/boeCredits/ledger'
import { REVIEW_LEADER_CARD_KEY, firstPlaceMessage, parseLeaderCard, type LeaderCard } from '@/lib/customerReviews/reviewReport'

// A small card on the shared dashboard: who leads this month's reviews and where the
// signed-in employee stands, with a link to the full leaderboard. One database call
// (customer_review_leader_card), names and counts only. It loads on its own and never
// holds the dashboard back: while loading it takes a line of space, and if the read
// fails it says so in one muted line rather than vanishing or showing a wrong number.

export function ReviewLeaderCard({ isMobile = false }: { isMobile?: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const card = useQuery({
    queryKey: [...REVIEW_LEADER_CARD_KEY],
    queryFn: async (): Promise<LeaderCard> => {
      const { data, error } = await supabase.rpc('customer_review_leader_card')
      if (error) throw new Error('unavailable')
      const parsed = parseLeaderCard(data)
      if (!parsed) throw new Error('unavailable')
      return parsed
    },
    staleTime: 60 * 1000,
    retry: false,
  })

  const data = card.data
  return (
    <section
      aria-label="Review leaderboard"
      style={{
        marginBottom: isMobile ? '18px' : '22px', padding: '10px 14px', borderRadius: '10px',
        border: `1px solid ${colors.borderSoft}`, background: colors.base,
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 14px', minWidth: 0,
      }}
    >
      <Trophy size={16} strokeWidth={1.8} aria-hidden="true" style={{ color: '#B45309', flexShrink: 0 }} />
      {card.isPending ? (
        <span role="status" style={{ fontSize: '12.5px', color: colors.muted }}>Review leaderboard…</span>
      ) : card.isError || !data ? (
        <span style={{ fontSize: '12.5px', color: colors.muted }}>Review leaderboard unavailable right now.</span>
      ) : (
        <>
          <div style={{ flex: '1 1 240px', minWidth: 0, fontSize: '12.5px', lineHeight: 1.5, color: colors.primary }}>
            <strong style={{ color: colors.secondary, fontWeight: 700 }}>Review leader · {reviewMonthLabel(data.month)}</strong>
            <div style={{ overflowWrap: 'anywhere' }}>
              {data.leader_reviews === 0
                ? 'No eligible reviews yet this month'
                : `${data.leader_names.join(', ')}${data.leaders > data.leader_names.length ? ` +${data.leaders - data.leader_names.length}` : ''}${data.leaders > 1 ? ' (joint)' : ''} · ${data.leader_reviews} eligible ${data.leader_reviews === 1 ? 'review' : 'reviews'}`}
            </div>
            {data.me && (
              <div style={{ color: colors.secondary }}>
                {firstPlaceMessage(data.state, data.need, data.leaders)}
                {data.state === 'behind' || data.state === 'no_activity' ? ' (eligible reviews — a target, not a guaranteed award)' : ''}
              </div>
            )}
          </div>
          <Link
            href="/my-credits/leaderboard"
            className="boe-btn boe-btn-ghost"
            style={{ minHeight: '44px', padding: '7px 14px', fontSize: '12.5px', display: 'inline-flex', alignItems: 'center' }}
          >
            View leaderboard
          </Link>
        </>
      )}
    </section>
  )
}

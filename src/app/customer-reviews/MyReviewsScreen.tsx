'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { FileText, Image as ImageIcon } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { ReviewCard, ReviewCardGrid } from '@/components/customerReviews/ReviewCard'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
import { ReviewFullView, ReviewFullViewActions } from '@/components/customerReviews/ReviewFullView'
import { useProjectImages } from '@/components/customerReviews/ProjectImages'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { fetchAllRows } from '@/lib/supabasePaging'
import { formatCredits } from '@/lib/boeCredits/ledger'
import { canBookCard } from '@/lib/customerReviews/status'
import {
  countReviewsByType,
  progressLine,
  projectGroupUsable,
  type ReviewCounts,
} from '@/lib/customerReviews/reviewTypes'
import {
  REVIEW_TYPE_META,
  TEST_CARD_COLUMNS,
  testCategoryLabel,
  type ReviewType,
  type TestCard,
} from '@/lib/customerReviews/types'
import { CardGridSkeleton, StatSkeleton } from '@/components/customerReviews/ReviewSkeletons'

// ── The candidate's whole workspace, on one screen ───────────────────────────
//
// WHAT THIS REPLACED. A candidate used to have TWO destinations — "Available"
// and "My reviews" — and had to move between them to see their own work. Worse,
// each screen's summary counted only the rows on THAT tab: on Available,
// "Posted" was always 0 and "Assigned" counted only what was still unbooked.
// The numbers were partial and quietly wrong.
//
// ONE QUERY, ONE SET OF NUMBERS. This screen reads every live review assigned
// to this person, in every state, and every count on it is computed from that
// one set. A candidate asks "what do I have, what's left, what can I start now"
// and gets all three answers without navigating.
//
// A VERIFIED REVIEW IS STILL IN NO LIST. `verified` is absent from the status
// filter below, so no query this screen can issue returns one — the module's
// standing rule, unchanged.
//
// RLS DOES THE SCOPING, NOT THIS FILE. `assigned_to = me` is here so a VERIFIER
// opening their own screen sees their own work rather than everybody's; for a
// candidate the policy already returns nothing else.

/** Every state a candidate's assigned work can be in. Never `verified`. */
const MINE_STATUSES = ['available', 'booked', 'submitted'] as const

export function MyReviewsScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [cards, setCards] = useState<TestCard[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reading, setReading] = useState<TestCard | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [bookError, setBookError] = useState<string | null>(null)
  const booking = useRef(false)

  const load = useCallback(async () => {
    if (!profile) return
    const result = await fetchAllRows<TestCard>(
      (from, to) => supabase
        .from('customer_review_test_cards')
        .select(TEST_CARD_COLUMNS)
        .in('status', MINE_STATUSES)
        .eq('assigned_to', profile.id)
        .is('deleted_at', null)
        .order('review_type', { ascending: true })
        .order('card_ref', { ascending: true })
        .range(from, to),
    )
    if (!result.ok) {
      setLoadError('Your reviews could not be loaded. Refresh to try again.')
      setCards([])
      setLoaded(true)
      return
    }
    setLoadError(null)
    setCards(result.rows)
    setLoaded(true)
  }, [supabase, profile])

  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const book = useCallback(async (cardId: string) => {
    // State is too slow to stop a double click. The ref stops the second
    // request; the database's conditional UPDATE stops the second BOOKING, and
    // it is the one that actually decides.
    if (booking.current) return
    booking.current = true
    setBookingId(cardId)
    setBookError(null)
    try {
      const { error } = await supabase.rpc('book_customer_review_test_card', {
        p_card_id: cardId,
      })
      if (error) {
        setBookError(error.message.replace(/^[A-Z_]+:\s*/, '') || 'That review could not be booked.')
        await load()
        return
      }
      setReading(null)
      router.push(`/customer-reviews/${cardId}`)
    } catch {
      setBookError('That review could not be booked. Check your connection and try again.')
    } finally {
      booking.current = false
      setBookingId(null)
    }
  }, [supabase, load, router])

  /*
   * THE PROJECT PHOTOGRAPHS FOR THE SHEET THAT IS OPEN, and only then.
   *
   * `null` covers three of the four cases and each of them means no query at
   * all: no sheet open, a text review's sheet, and an image review with no
   * group yet. useProjectImages returns NO_PROJECT_IMAGES for a null id
   * without touching the network, so opening a text review costs nothing and
   * the list itself never loads an image it is not showing.
   *
   * Read through THIS USER'S client. RLS returns the group only to a verifier
   * or to the person the review is assigned to; there is no route and no
   * service role anywhere on this path.
   */
  const readingImages = useProjectImages(
    supabase,
    reading?.review_type === 'image' ? reading.image_group_id : null,
  )

  /*
   * MAY THE OPEN REVIEW BE BOOKED — one answer, used by the button and by the
   * sentence that explains its absence.
   *
   * canBookCard IS STILL THE POLICY. It already took the group's usability as
   * its third argument, for exactly this; nothing about the rule changed, the
   * browser simply stopped guessing at an argument it can now supply.
   *
   * WHILE THE GROUP IS STILL BEING READ THERE IS NO BUTTON. The candidate
   * would be pressing it on the strength of the row alone, and a read that
   * lands a moment later can withdraw the offer. The database refuses the
   * booking either way — this only stops us inviting a refusal.
   */
  const readingCanBook = !!reading
    && !readingImages.loading
    && canBookCard(
      reading,
      { userId: profile?.id ?? null, canUse: caps.canUse },
      projectGroupUsable(reading, readingImages),
    )

  const counts = useMemo(() => countReviewsByType(cards), [cards])

  const sections = useMemo(() => ([
    { type: 'text' as ReviewType, Icon: FileText, rows: cards.filter(c => c.review_type !== 'image'), counts: counts.text },
    { type: 'image' as ReviewType, Icon: ImageIcon, rows: cards.filter(c => c.review_type === 'image'), counts: counts.image },
  ]), [cards, counts])

  if (authLoading) return <LoadingScreen />

  const verified = verifiedNotice(searchParams.get('verified'))

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="My Reviews"
      subtitle="Everything assigned to you"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' }}>

        {verified && (
          <p role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600, margin: 0 }}>
            {verified}
          </p>
        )}
        {bookError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{bookError}</p>
        )}
        {loadError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{loadError}</p>
        )}

        {!loaded ? (
          <>
            <StatSkeleton count={3} />
            <CardGridSkeleton count={4} />
          </>
        ) : cards.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {/*
              THREE NUMBERS, NOT FOUR. Assigned, Posted and Remaining describe
              the whole of the work; "Available now" was a fourth number of
              equal weight that answered a question the sections below answer
              better, by simply showing what can be picked up.
            */}
            <Summary counts={counts.all} />

            {sections.map(({ type, Icon, rows, counts: c }) => (
              <section key={type} style={{ display: 'flex', flexDirection: 'column', gap: '11px' }}>
                <header style={{ display: 'flex', alignItems: 'baseline', gap: '9px', flexWrap: 'wrap' }}>
                  <Icon
                    size={15}
                    strokeWidth={2.2}
                    style={{ color: REVIEW_TYPE_META[type].color, flexShrink: 0, alignSelf: 'center' }}
                  />
                  <h2 style={{
                    margin: 0, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em',
                    textTransform: 'uppercase', color: colors.primary,
                  }}>
                    {REVIEW_TYPE_META[type].plural}
                  </h2>
                  <span style={{ fontSize: '12px', color: colors.secondary, fontVariantNumeric: 'tabular-nums' }}>
                    {progressLine(c)}
                  </span>
                </header>

                {rows.length === 0 ? (
                  <p style={{
                    margin: 0, padding: '14px 16px', borderRadius: '8px', fontSize: '12px',
                    border: `1px dashed ${colors.border}`, color: colors.muted,
                  }}>
                    {type === 'image' ? 'No image reviews assigned.' : 'No text reviews assigned.'}
                  </p>
                ) : (
                  <ReviewCardGrid>
                    {rows.map(card => (
                      <ReviewCard
                        key={card.id}
                        card={card}
                        actionLabel={card.status === 'available' ? 'View review' : 'Open'}
                        onAction={() => {
                          if (card.status === 'available') { setBookError(null); setReading(card) }
                          else router.push(`/customer-reviews/${card.id}`)
                        }}
                      />
                    ))}
                  </ReviewCardGrid>
                )}
              </section>
            ))}
          </>
        )}
      </div>

      {/*
        THE COMPLETE REVIEW, AND THE ONLY PLACE `Book` EXISTS. Booking from a
        card would mean taking a review on the strength of its first line and a
        half; the product rule is that a candidate reads the whole thing first.
      */}
      {reading && (
        <ReviewSheet
          title={reading.test_title}
          subtitle={`${reading.card_ref} · ${testCategoryLabel(reading.test_category)}`}
          maxWidth="560px"
          onClose={() => { setReading(null); setBookError(null) }}
          footer={
            <ReviewFullViewActions
              canBook={readingCanBook}
              booking={bookingId === reading.id}
              onBook={() => { void book(reading.id) }}
              onClose={() => { setReading(null); setBookError(null) }}
            />
          }
        >
          <ReviewFullView
            card={reading}
            canBook={readingCanBook}
            bookError={bookError}
            supabase={supabase}
            projectImages={readingImages}
          />
        </ReviewSheet>
      )}
    </CustomerReviewsLayout>
  )
}

/** Assigned · Posted · Remaining. Three numbers, one row, no chart. */
function Summary({ counts }: { counts: ReviewCounts }) {
  const stats: { label: string; value: number; tone?: string }[] = [
    { label: 'Assigned', value: counts.assigned },
    { label: 'Posted', value: counts.posted, tone: '#166534' },
    { label: 'Remaining', value: counts.remaining, tone: counts.remaining > 0 ? '#92400E' : colors.secondary },
  ]
  return (
    <div style={{
      display: 'flex', gap: '24px', flexWrap: 'wrap',
      padding: '14px 16px', borderRadius: '10px',
      border: `1px solid ${colors.borderSoft}`, background: colors.base,
    }}>
      {stats.map(s => (
        <div key={s.label} style={{ minWidth: '76px' }}>
          <div style={{
            fontSize: '22px', fontWeight: 700, lineHeight: 1.1,
            color: s.tone ?? colors.primary, fontVariantNumeric: 'tabular-nums',
          }}>
            {s.value}
          </div>
          <div style={{ fontSize: '11px', color: colors.secondary, marginTop: '3px' }}>{s.label}</div>
        </div>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <p style={{
      margin: 0, padding: '28px 20px', borderRadius: '10px', textAlign: 'center',
      border: `1px dashed ${colors.border}`, color: colors.muted,
      fontSize: '13px', lineHeight: 1.6,
    }}>
      Nothing is assigned to you right now.
    </p>
  )
}

/**
 * The one line shown after a verification, from `?verified=<credits>`.
 *
 * The detail screen sends the verifier back with the amount the transition RPC
 * returned from the SAME transaction that verified the review. The flag decides
 * what this line SAYS and nothing about what the screen shows.
 */
export function verifiedNotice(flag: string | null): string | null {
  if (flag === null) return null
  const credits = /^\d+$/.test(flag) ? Number(flag) : 0
  return credits > 0
    ? `Review verified · ${formatCredits(credits, { signed: true })} awarded.`
    : 'Review verified.'
}

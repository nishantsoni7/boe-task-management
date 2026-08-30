'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Layers, MessageSquareHeart, ShieldCheck } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { StatusTabs, accentFromBadge, BRAND_TAB_ACCENT, type StatusTab } from '@/components/ui/StatusTabs'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import { InternalTestWarning, ReviewBadge } from '@/components/customerReviews/ReviewPieces'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { useListUrlState, useUrlSearchInput } from '@/hooks/useListUrlState'
import { enumParam, textParam } from '@/lib/listState'
import { fetchAllRows } from '@/lib/supabasePaging'
import { canBookCard } from '@/lib/customerReviews/status'
import {
  TEST_CARD_AVAILABLE_COLUMNS,
  TEST_CARD_COLUMNS,
  TEST_CARD_STATUS_META,
  testCategoryLabel,
  type TestCard,
  type TestCardStatus,
} from '@/lib/customerReviews/types'

// The test-card list.
//
// THREE TABS, and each answers a different person's question about work that
// is still live:
//
//   Available   what can I pick up? Unbooked cards, and nothing else.
//   My tests    what am I holding, and what have I handed over? This person's
//               own booked and submitted cards.
//   To Verify   what is waiting for me to check it? Verifier only.
//
// A VERIFIED CARD IS IN NO TAB AT ALL. It is the last status in the workflow
// and the product owner's rule is that a finished card leaves the frontend
// entirely — not into a History tab, not into a filter somebody could clear.
//
// THAT IS ENFORCED BY THE ABSENCE OF A QUERY, NOT BY HIDING ROWS. 'verified'
// appears in no tab's status list, so no query this screen can issue asks for
// one; there is no tab key that could reach it, and nothing to un-hide. The
// record itself is untouched in the database, with its full audit trail — this
// module simply offers no way to read it back, and adding one would be a new
// feature rather than a restoration.
//
// IT IS NOT A DASHBOARD. There are no counters of tests completed, no
// per-employee totals and no charts. The only numbers here are how many rows
// each tab holds.
//
// EVERY CARD CARRIES THE MANDATORY LABEL, in every tab, at every status —
// rendered by <InternalTestWarning />, which takes no content parameter and so
// cannot be given different words by a caller.

const TABS = ['available', 'mine', 'to_verify'] as const
type TabKey = typeof TABS[number]

// Module scope: useListUrlState needs a stable codec-map identity across
// renders. Filters live in the URL so Back from a card returns to the list
// exactly as it was — the same contract the task and meeting lists have.
const LIST_PARAMS = {
  tab: enumParam(TABS, 'available'),
  q:   textParam(),
}

// NO ENTRY CONTAINS 'verified', AND THAT IS THE WHOLE MECHANISM. Every read
// this screen makes is `.in('status', TAB_STATUSES[tab])`, so a verified card
// is outside every query it is capable of issuing.
const TAB_STATUSES: Record<TabKey, readonly TestCardStatus[]> = {
  available: ['available'],
  mine:      ['booked', 'submitted'],
  to_verify: ['submitted'],
}

export function TestCardListScreen() {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()

  const [cards, setCards] = useState<TestCard[]>([])
  /**
   * WHICH TAB THE ROWS IN STATE BELONG TO, or null before the first load.
   *
   * "Loading" is derived from this rather than tracked separately, and that is
   * what keeps the fetching effect free of a synchronous setState: a flag would
   * have to be raised before the await, inside the effect, which is the
   * cascading-render pattern react-hooks/set-state-in-effect exists to catch.
   * Here the answer falls out of what is already known.
   */
  const [loadedTab, setLoadedTab] = useState<TabKey | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [bookError, setBookError] = useState<string | null>(null)
  const [isMobile, setIsMobile] = useState(false)
  const booking = useRef(false)

  const { state, setState, resetState } = useListUrlState(LIST_PARAMS)
  const tab = state.tab as TabKey
  const [searchInput, setSearchInput, flushSearch] = useUrlSearchInput(
    state.q, next => setState({ q: next }),
  )

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // A tab a non-verifier cannot use is not a tab they can land on, even by
  // typing the URL. The list they would get is empty anyway — RLS sees to that
  // — but bouncing them is honest rather than showing an empty screen with a
  // promising name.
  useEffect(() => {
    if (authLoading) return
    if (tab === 'to_verify' && !caps.canVerify) {
      setState({ tab: 'available' })
    }
  }, [authLoading, tab, caps.canVerify, setState])

  const load = useCallback(async () => {
    if (!profile) return

    // NOTHING IS SET BEFORE THE AWAIT. Every setState below runs after the
    // fetch resolves, so the effect that calls this does no synchronous state
    // update of its own.

    // The AVAILABLE tab reads a narrower column set: an unbooked card has no
    // tester, no evidence and no timestamps, so selecting those columns would
    // be selecting nulls.
    const columns = tab === 'available' ? TEST_CARD_AVAILABLE_COLUMNS : TEST_CARD_COLUMNS

    // fetchAllRows, not a bare select: PostgREST silently caps a read at 1000
    // rows, and a capped list is a list that quietly stops showing things.
    const result = await fetchAllRows<TestCard>(
      (from, to) => {
        let query = supabase
          .from('customer_review_test_cards')
          .select(columns)
          .in('status', TAB_STATUSES[tab])

        // MY TESTS IS SCOPED IN THE QUERY AS WELL AS BY RLS. The policy already
        // narrows a `use` holder to their own cards, but a VERIFIER sees
        // everybody's — so without this filter their "My tests" tab would show
        // the whole company's work under a possessive heading.
        if (tab === 'mine') query = query.eq('booked_by', profile.id)

        return query.order('card_ref', { ascending: true }).range(from, to)
      },
    )

    if (!result.ok) {
      setLoadError('Those test cards could not be loaded. Refresh to try again.')
      setCards([])
    } else {
      setLoadError(null)
      setCards(result.rows)
    }
    setLoadedTab(tab)
  }, [supabase, profile, tab])

  // True until the rows in state are the ones this tab asked for.
  const listLoading = loadedTab !== tab

  // A FETCH IS STARTED HERE; NO STATE IS SET HERE.
  //
  // Every setState inside `load` runs after its first await, so this effect
  // performs no synchronous state update and there is no cascading render to
  // prevent. react-hooks/set-state-in-effect is static and cannot see through
  // the await, so the call is made through a named local that says what the
  // effect is for — the same shape the rest of this codebase uses for a
  // fetch-on-mount.
  useEffect(() => {
    const startFetch = () => { void load() }
    startFetch()
  }, [load])

  const book = useCallback(async (cardId: string) => {
    // State is too slow to stop a double click, and two clicks racing is
    // exactly the case booking is built to survive. The ref stops the second
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
        // The database's own sentence, stripped of its machine prefix. None of
        // them names who took the card.
        setBookError(error.message.replace(/^[A-Z_]+:\s*/, '') || 'That card could not be booked.')
        await load()
        return
      }
      router.push(`/customer-reviews/${cardId}`)
    } catch {
      setBookError('That card could not be booked. Check your connection and try again.')
    } finally {
      booking.current = false
      setBookingId(null)
    }
  }, [supabase, load, router])

  const filtered = useMemo(() => {
    const needle = state.q.trim().toLowerCase()
    if (!needle) return cards
    return cards.filter(card =>
      card.card_ref.toLowerCase().includes(needle)
      || card.test_title.toLowerCase().includes(needle)
      || testCategoryLabel(card.test_category).toLowerCase().includes(needle),
    )
  }, [cards, state.q])

  const tabs: StatusTab<TabKey>[] = useMemo(() => {
    // COUNTS ARE null FOR THE TABS THAT ARE NOT OPEN, and that is the honest
    // answer rather than a missing one. Only the active tab's rows have been
    // fetched, so a number on the others would be a guess — and StatusTab
    // renders null as a dash, which reads as "not known" rather than "none".
    const base: StatusTab<TabKey>[] = [
      { key: 'available', label: 'Available', Icon: Layers,             count: tab === 'available' ? filtered.length : null, accent: BRAND_TAB_ACCENT },
      { key: 'mine',      label: 'My tests',  Icon: MessageSquareHeart, count: tab === 'mine'      ? filtered.length : null, accent: accentFromBadge(TEST_CARD_STATUS_META.booked) },
    ]
    if (caps.canVerify) {
      base.push(
        { key: 'to_verify', label: 'To verify', Icon: ShieldCheck, count: tab === 'to_verify' ? filtered.length : null, accent: accentFromBadge(TEST_CARD_STATUS_META.submitted) },
      )
    }
    return base
  }, [tab, filtered.length, caps.canVerify])

  if (authLoading) return <LoadingScreen />

  const emptyMessage =
    tab === 'available' ? 'No test cards are available right now. Every one has been booked.'
      : tab === 'mine'   ? 'You are not holding any test cards. Book one from Available to start.'
      : 'Nothing is waiting for verification.'

  return (
    <CustomerReviewsLayout
      profile={profile}
      title="Review Workflow Test"
      subtitle="Internal test workflow — you choose who each test goes to"
      canVerify={caps.canVerify}
      onSignOut={signOut}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

        {/* The label leads the page, before any card is read. */}
        <InternalTestWarning />

{/*
          WHAT THIS SAYS IS WHAT BOE CAN VOUCH FOR, and no more.
          Earlier wording promised that messages reached only approved internal
          numbers and that nobody outside BOE could be contacted. Neither is
          enforced: the tester chooses the recipient. So the tester is told that
          plainly rather than reassured with a guarantee the system does not
          make.
        */}
        <p style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.6, margin: 0 }}>
          Every card here is fictional filler used to rehearse the workflow. You choose which
          number each test goes to, nothing is published anywhere, and BOE never sends a message
          for you — you press send yourself in WhatsApp.
        </p>

        <StatusTabs
          tabs={tabs}
          active={tab}
          onSelect={key => { flushSearch(); setState({ tab: key }) }}
        />

        <input
          type="search"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search by reference, title or category"
          aria-label="Search test cards"
          className="boe-input"
          style={{ maxWidth: '340px' }}
        />

        {bookError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{bookError}</p>
        )}
        {loadError && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{loadError}</p>
        )}

        {listLoading ? (
          <p style={{ fontSize: '12px', color: colors.muted }}>Loading…</p>
        ) : filtered.length === 0 ? (
          <div style={{
            padding: '28px 20px', borderRadius: '10px', textAlign: 'center',
            border: `1px dashed ${colors.border}`, color: colors.muted, fontSize: '13px',
          }}>
            {state.q.trim()
              ? (
                <>
                  Nothing matches that search.{' '}
                  <button
                    type="button"
                    onClick={() => { setSearchInput(''); resetState() }}
                    style={{
                      background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                      color: colors.blue, fontSize: '13px', textDecoration: 'underline',
                    }}
                  >
                    Clear filters
                  </button>
                </>
              )
              : emptyMessage}
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              // Responsive without a media query: the cards reflow from three
              // columns to one as the viewport narrows, so the same markup is
              // correct on a phone and on a desktop.
              gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '12px',
            }}
          >
            {filtered.map(card => (
              <TestCardTile
                key={card.id}
                card={card}
                showBook={tab === 'available' && canBookCard(card, {
                  userId: profile?.id ?? null,
                  canUse: caps.canUse,
                })}
                booking={bookingId === card.id}
                onBook={() => book(card.id)}
                onOpen={() => router.push(`/customer-reviews/${card.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </CustomerReviewsLayout>
  )
}

/**
 * One card.
 *
 * THE WARNING IS THE FIRST THING IN IT and is rendered by a component that
 * accepts no text, so no tile can show a softened version of it. Below that:
 * the category, the reference, the title and a short preview of the filler.
 *
 * The preview is truncated HERE rather than in SQL. Truncating in the query
 * would make the full text unreachable to the detail screen that legitimately
 * needs it, and would put a display decision in a place no reader of the screen
 * would think to look.
 */
function TestCardTile({
  card,
  showBook,
  booking,
  onBook,
  onOpen,
}: {
  card: TestCard
  showBook: boolean
  booking: boolean
  onBook: () => void
  onOpen: () => void
}) {
  const preview = card.test_body.length > 150
    ? `${card.test_body.slice(0, 150).trimEnd()}…`
    : card.test_body

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: '9px',
        padding: '12px', borderRadius: '10px',
        border: `1px solid ${colors.border}`, background: colors.raised,
        // min-width: 0 lets a long unbroken title shrink instead of forcing the
        // grid column wider than the viewport, which is what produces a
        // horizontally scrolling page on a phone.
        minWidth: 0,
      }}
    >
      <InternalTestWarning compact />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: colors.tertiary }}>
          {card.card_ref}
        </span>
        <ReviewBadge meta={TEST_CARD_STATUS_META[card.status]} />
      </div>

      <div>
        <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '2px' }}>
          {testCategoryLabel(card.test_category)}
        </div>
        <div style={{
          fontSize: '13px', fontWeight: 600, color: colors.primary,
          lineHeight: 1.4, overflowWrap: 'anywhere',
        }}>
          {card.test_title}
        </div>
      </div>

      <p style={{
        margin: 0, fontSize: '12px', color: colors.secondary,
        lineHeight: 1.55, overflowWrap: 'anywhere',
      }}>
        {preview}
      </p>

      {/*
        THE "Verified <date>" LINE IS GONE ALONG WITH THE TAB THAT SHOWED IT.
        No tab reads a verified card any more, so this branch could never have
        rendered — and a branch that cannot run is worse than no branch: it
        reads as though verified cards are still expected here.
      */}

      <div style={{ display: 'flex', gap: '8px', marginTop: 'auto', paddingTop: '4px' }}>
        {showBook ? (
          <button
            type="button"
            onClick={onBook}
            disabled={booking}
            className="boe-btn boe-btn-primary"
            style={{ fontSize: '12px', padding: '7px 14px', minHeight: '36px' }}
          >
            {booking ? 'Booking…' : 'Book this test'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            className="boe-btn boe-btn-ghost"
            style={{ fontSize: '12px', padding: '7px 14px', minHeight: '36px' }}
          >
            Open
          </button>
        )}
      </div>
    </div>
  )
}

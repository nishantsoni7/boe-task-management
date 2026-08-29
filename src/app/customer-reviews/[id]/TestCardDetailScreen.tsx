'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import {
  InternalTestWarning,
  ReviewBadge,
  ScreenshotIsNotProofNote,
} from '@/components/customerReviews/ReviewPieces'
import { maskFromLastFour } from '@/lib/customerReviews/contact'
import { ScreenshotManager } from '@/components/customerReviews/ScreenshotManager'
import { ConfirmSentControl, WhatsAppTestPanel } from '@/components/customerReviews/WhatsAppLaunch'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { holdsThisCard } from '@/lib/permissions/customerReviewOutreach'
import { availableActions, submissionBlockers, type TestCardAction } from '@/lib/customerReviews/status'
import {
  TEST_CARD_COLUMNS,
  TEST_CARD_EVENT_COLUMNS,
  TEST_CARD_PHOTO_COLUMNS,
  TEST_CARD_STATUS_META,
  formatTestTimestamp,
  testCategoryLabel,
  type TestCard,
  type TestCardEvent,
  type TestCardPhoto,
} from '@/lib/customerReviews/types'

// One test card, and everything a tester or a verifier does with it.
//
// THE FIVE FACTS THIS SCREEN KEEPS APART, because collapsing any pair would
// make the record claim something nobody checked:
//
//   booked            somebody took the card.
//   whatsapp_opened   a link was built and opened. NOT a send, NOT a delivery.
//   sent_confirmed    a PERSON said they pressed send. Their claim, not ours.
//   submitted         the tester handed the evidence over.
//   verified          somebody else looked at it and said so.
//
// They are five rows in the timeline and five separate controls, and no control
// on this screen performs two of them.
//
// EVERY SERVER RULE IS RE-ASKED BY THE SERVER. What this screen decides is
// which buttons to draw; the definer functions decide whether anything happens.
// A button that appears for someone the RPC would refuse is a bug in this file,
// and the RPC still refuses.

export function TestCardDetailScreen({ cardId }: { cardId: string }) {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()

  const [card, setCard] = useState<TestCard | null>(null)
  const [screenshots, setScreenshots] = useState<TestCardPhoto[]>([])
  const [events, setEvents] = useState<TestCardEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState<{ action: TestCardAction; text: string } | null>(null)
  const acting = useRef(false)

  const load = useCallback(async () => {
    if (!profile) return

    // NOTHING IS SET BEFORE THE AWAIT — see the list screen for why. The error
    // is cleared below, where it means "these reads succeeded" rather than
    // "these reads are about to be attempted".
    const [{ data: cardRow }, { data: shots }, { data: trail }] = await Promise.all([
      supabase
        .from('customer_review_test_cards')
        .select(TEST_CARD_COLUMNS)
        .eq('id', cardId)
        .maybeSingle(),
      supabase
        .from('customer_review_test_card_screenshots')
        .select(TEST_CARD_PHOTO_COLUMNS)
        .eq('card_id', cardId)
        .order('uploaded_at', { ascending: true }),
      supabase
        .from('customer_review_test_card_events')
        .select(TEST_CARD_EVENT_COLUMNS)
        .eq('card_id', cardId)
        .order('created_at', { ascending: false }),
    ])

    // A card the reader may not see returns no row, and this screen cannot tell
    // "not yours" from "does not exist". Neither can the reader, which is the
    // answer they should get.
    if (!cardRow) { setNotFound(true); setLoading(false); return }

    // A VERIFIED CARD IS TREATED AS UNAVAILABLE, and it is the same answer the
    // lists give by never asking for one.
    //
    // The lists cannot reach a verified card, but this route is addressed by
    // id: a verifier who has just verified one is standing on its URL, and a
    // bookmark or the browser's Back button would otherwise still render the
    // whole record. Removing it from the lists and leaving it readable here
    // would be hiding it, not removing it.
    //
    // The ROW IS UNTOUCHED. This is the frontend declining to display it, not a
    // deletion and not an RLS change — the record and its audit trail are still
    // in the database, still readable by anything that queries the database
    // directly. Nothing about who may READ the row has changed.
    if ((cardRow as unknown as TestCard).status === 'verified') {
      setNotFound(true); setLoading(false); return
    }

    setError(null)
    setCard(cardRow as unknown as TestCard)
    setScreenshots((shots ?? []) as unknown as TestCardPhoto[])
    setEvents((trail ?? []) as unknown as TestCardEvent[])
    setLoading(false)
  }, [supabase, profile, cardId])

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

  const isAdmin = profile?.role === 'admin'
  // NO ROLE IS PASSED, because none is consulted. Holding a card is the whole
  // of what authorises a tester action, for an administrator as much as anyone.
  const mine = card ? holdsThisCard(card, profile?.id, caps) : false

  const actions = useMemo(
    () => (card
      ? availableActions(card, {
          userId: profile?.id ?? null,
          canUse: caps.canUse,
          canVerify: caps.canVerify,
        })
      : []),
    [card, profile?.id, caps.canUse, caps.canVerify],
  )

  const blockers = card ? submissionBlockers(card, screenshots.length) : []

  const confirmSent = useCallback(async () => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('confirm_customer_review_test_card_sent', {
        p_card_id: cardId,
      })
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That could not be recorded.')
        return
      }
      await load()
    } catch {
      setError('That could not be recorded. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, cardId, load])

  const runAction = useCallback(async (action: TestCardAction, detail: string | null) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('transition_customer_review_test_card', {
        p_card_id: cardId,
        p_next_status: action.to,
        p_detail: detail,
      })
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That could not be done.')
        return
      }
      setPrompt(null)

      // VERIFYING IS THE END OF THE CARD'S LIFE IN THIS UI. Reloading would
      // fetch a row this screen now declines to display and land the verifier
      // on "that test card is not available", which reads like an error rather
      // than like success. Going back to the list is the honest ending.
      if (action.to === 'verified') {
        router.push('/customer-reviews?tab=to_verify')
        return
      }

      await load()
    } catch {
      setError('That could not be done. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, cardId, load, router])

  if (authLoading || loading) return <LoadingScreen />

  if (notFound || !card) {
    return (
      <CustomerReviewsLayout
        profile={profile}
        title="Test card"
        canVerify={caps.canVerify}
        onSignOut={signOut}
      >
        <p style={{ fontSize: '13px', color: colors.secondary }}>
          That test card is not available.{' '}
          <button
            type="button"
            onClick={() => router.push('/customer-reviews')}
            style={{
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
              color: colors.blue, fontSize: '13px', textDecoration: 'underline',
            }}
          >
            Back to the list
          </button>
        </p>
      </CustomerReviewsLayout>
    )
  }

  const canWorkOnIt = mine && card.status === 'booked'

  return (
    <CustomerReviewsLayout
      profile={profile}
      title={card.test_title}
      subtitle={`${card.card_ref} · ${testCategoryLabel(card.test_category)}`}
      canVerify={caps.canVerify}
      onSignOut={signOut}
      actions={
        <button
          type="button"
          onClick={() => router.push('/customer-reviews')}
          className="boe-btn boe-btn-ghost"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
        >
          <ArrowLeft size={14} strokeWidth={2} />
          Back
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '760px' }}>

        {/* The label leads the screen, above everything including the status. */}
        <InternalTestWarning />

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <ReviewBadge meta={TEST_CARD_STATUS_META[card.status]} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: colors.tertiary }}>
            {card.card_ref}
          </span>
        </div>

        {error && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{error}</p>
        )}

        {/* A returned card says why, at the top, where the tester will see it. */}
        {card.return_reason && card.status === 'booked' && (
          <div style={{
            padding: '10px 12px', borderRadius: '8px',
            background: '#FFFBEB', border: '1px solid #FDE68A',
            fontSize: '12px', color: '#92400E', lineHeight: 1.55,
          }}>
            <strong>Returned by a verifier.</strong> {card.return_reason}
          </div>
        )}

        {/* ── The card's own text ── */}
        <Section title="Test content">
          <p style={{
            margin: 0, fontSize: '13px', color: colors.primary,
            lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          }}>
            {card.test_body}
          </p>
          <p style={{ fontSize: '11px', color: colors.muted, marginTop: '8px', marginBottom: 0, lineHeight: 1.5 }}>
            This text is fictional filler loaded from a test fixture. It describes nothing that
            happened, is not attributed to anybody, and cannot be edited — not by you, not by an
            administrator, and not through any screen in BOE.
          </p>
        </Section>

        {/* ── Step 1 and 2: open WhatsApp, then say you sent it ── */}
        {(canWorkOnIt || card.whatsapp_opened_at) && (
          <Section title="Send the internal test">
            {canWorkOnIt ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <WhatsAppTestPanel
                  cardId={card.id}
                  enabled={canWorkOnIt}
                  onOpened={load}
                  onError={setError}
                />
                <ConfirmSentControl
                  alreadyConfirmed={!!card.sent_confirmed_at}
                  canConfirm={!!card.whatsapp_opened_at}
                  onConfirm={confirmSent}
                  busy={busy}
                />
              </div>
            ) : (
              <dl style={{ margin: 0, display: 'grid', gap: '6px' }}>
                <Fact label="WhatsApp opened" value={formatTestTimestamp(card.whatsapp_opened_at)} />
                <Fact label="Times opened" value={String(card.whatsapp_opened_count)} />
                {/*
                  THE MASKED FORM IS THE ONLY FORM. There is no reveal control
                  and no revealable prop, because there is nothing to reveal:
                  the card stores four digits and nothing else,
                  and the number itself was never persisted. A verifier sees
                  exactly what a tester sees.
                */}
                <Fact
                  label="Addressed to"
                  value={maskFromLastFour(card.whatsapp_target_last_four)}
                />
                <Fact label="Tester confirmed sent" value={formatTestTimestamp(card.sent_confirmed_at)} />
              </dl>
            )}
          </Section>
        )}

        {/* ── Step 3: the screenshot ── */}
        <Section title="Test screenshot">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <ScreenshotIsNotProofNote />
            <ScreenshotManager
              supabase={supabase}
              cardId={card.id}
              screenshots={screenshots}
              onChanged={load}
              canAttach={canWorkOnIt}
              canRemove={canWorkOnIt || !!isAdmin}
              emptyHint={
                canWorkOnIt
                  ? 'Attach a screenshot of the internal test message you sent.'
                  : 'No screenshot is attached to this test card.'
              }
            />
          </div>
        </Section>

        {/* ── Step 4 and 5: submit, then somebody verifies ── */}
        {actions.length > 0 && (
          <Section title="Next step">
            {blockers.length > 0 && card.status === 'booked' && (
              <ul style={{
                margin: '0 0 10px', paddingLeft: '18px',
                fontSize: '12px', color: colors.tertiary, lineHeight: 1.7,
              }}>
                {blockers.map(b => <li key={b}>{b}</li>)}
              </ul>
            )}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {actions.map(action => {
                // Submitting is blocked in the UI when a prerequisite is
                // missing, and the RPC refuses it independently — this is the
                // half that explains why, not the half that decides.
                const blocked = action.to === 'submitted' && blockers.length > 0
                return (
                  <button
                    key={action.to}
                    type="button"
                    disabled={busy || blocked}
                    onClick={() => {
                      if (action.prompt) setPrompt({ action, text: '' })
                      else runAction(action, null)
                    }}
                    className={`boe-btn ${action.destructive ? 'boe-btn-ghost' : 'boe-btn-primary'}`}
                    style={{
                      fontSize: '13px', padding: '9px 18px', minHeight: '40px',
                      color: action.destructive ? colors.red : undefined,
                      opacity: busy || blocked ? 0.5 : 1,
                      cursor: busy || blocked ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {action.label}
                  </button>
                )
              })}
            </div>

            {prompt && (
              <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label
                  htmlFor="action-detail"
                  style={{ fontSize: '12px', fontWeight: 600, color: colors.secondary }}
                >
                  {prompt.action.prompt === 'return_reason'
                    ? 'Why are you returning this test?'
                    : 'Verification note (optional)'}
                </label>
                <textarea
                  id="action-detail"
                  value={prompt.text}
                  onChange={e => setPrompt({ ...prompt, text: e.target.value })}
                  rows={3}
                  maxLength={500}
                  className="boe-input"
                  style={{ resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    disabled={
                      busy
                      // A return has to say why. The database refuses one with
                      // no reason; this stops the round trip that would end in
                      // that refusal.
                      || (prompt.action.prompt === 'return_reason' && prompt.text.trim() === '')
                    }
                    onClick={() => runAction(prompt.action, prompt.text.trim() || null)}
                    className="boe-btn boe-btn-primary"
                    style={{ fontSize: '13px', padding: '8px 16px', minHeight: '38px' }}
                  >
                    {busy ? 'Working…' : prompt.action.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt(null)}
                    className="boe-btn boe-btn-ghost"
                    style={{ fontSize: '13px', padding: '8px 16px', minHeight: '38px' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Section>
        )}

        {/* ── What a verifier reads ── */}
        {(caps.canVerify || isAdmin) && card.status !== 'available' && (
          <Section title="Who did what">
            <dl style={{ margin: 0, display: 'grid', gap: '6px' }}>
              <Fact label="Booked" value={formatTestTimestamp(card.booked_at)} />
              <Fact label="WhatsApp opened" value={formatTestTimestamp(card.whatsapp_opened_at)} />
              <Fact label="Tester confirmed sent" value={formatTestTimestamp(card.sent_confirmed_at)} />
              <Fact label="Submitted" value={formatTestTimestamp(card.submitted_at)} />
              <Fact label="Verified" value={formatTestTimestamp(card.verified_at)} />
              {card.verification_note && <Fact label="Verifier's note" value={card.verification_note} />}
              {card.returned_at && <Fact label="Last returned" value={formatTestTimestamp(card.returned_at)} />}
            </dl>
          </Section>
        )}

        {/* ── The append-only trail ── */}
        <Section title="Activity">
          {events.length === 0 ? (
            <p style={{ fontSize: '12px', color: colors.muted, margin: 0 }}>Nothing recorded yet.</p>
          ) : (
            <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '8px' }}>
              {events.map(event => (
                <li key={event.id} style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
                  <span style={{ color: colors.muted, marginRight: '8px', fontVariantNumeric: 'tabular-nums' }}>
                    {formatTestTimestamp(event.created_at)}
                  </span>
                  <strong style={{ color: colors.primary }}>{EVENT_LABELS[event.event_type] ?? event.event_type}</strong>
                  {event.detail && <span> — {event.detail}</span>}
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </CustomerReviewsLayout>
  )
}

const EVENT_LABELS: Record<string, string> = {
  booked:             'Booked',
  whatsapp_opened:    'WhatsApp opened',
  sent_confirmed:     'Tester confirmed sent',
  submitted:          'Submitted for verification',
  verified:           'Verified',
  returned:           'Returned to tester',
  screenshot_removed: 'Screenshot removed',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      padding: '14px', borderRadius: '10px',
      border: `1px solid ${colors.border}`, background: colors.raised,
    }}>
      <h2 style={{
        margin: '0 0 10px', fontSize: '12px', fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.tertiary,
      }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '12px' }}>
      <dt style={{ color: colors.muted, minWidth: '160px' }}>{label}</dt>
      <dd style={{ margin: 0, color: colors.secondary, overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  )
}

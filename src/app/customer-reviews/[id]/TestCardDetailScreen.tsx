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
import { ReviewImageManager } from '@/components/customerReviews/ReviewImageManager'
import { ShareReviewButton } from '@/components/customerReviews/ShareReview'
import { DraftEditedNote } from '@/components/customerReviews/EditDraft'
import { REVIEW_IMAGE_KIND } from '@/lib/customerReviews/reviewImages'
import { ConfirmSentControl, WhatsAppTestPanel } from '@/components/customerReviews/WhatsAppLaunch'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { holdsThisCard } from '@/lib/permissions/customerReviewOutreach'
import { nextStepFor, stageIndex, REVIEW_STAGES } from '@/lib/customerReviews/nextStep'
import {
  availableActions,
  canDeleteCard,
  canUnbookCard,
  submissionBlockers,
  unbookBlocker,
  type TestCardAction,
} from '@/lib/customerReviews/status'
import { DeleteReviewButton, DeleteReviewsSheet } from '@/components/customerReviews/DeleteReviews'
import { ReviewSheet } from '@/components/customerReviews/ReviewSheet'
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
  /**
   * The review's own images, kept apart from the test screenshot.
   *
   * ONE QUERY, TWO LISTS, and the split matters. Both kinds live in one table,
   * so the query returns both — and the screenshot count is what
   * submissionBlockers() reads to decide whether a card may be handed to a
   * verifier. Letting a review image count towards that would let a candidate
   * submit a test they never took a screenshot of.
   */
  const [reviewImages, setReviewImages] = useState<TestCardPhoto[]>([])
  const [events, setEvents] = useState<TestCardEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState<{ action: TestCardAction; text: string } | null>(null)
  /** Open while the holder is confirming they mean to unbook this review. */
  const [unbooking, setUnbooking] = useState(false)
  /** Open while a verifier is confirming they mean to delete this review. */
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
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

    // A DELETED REVIEW'S URL IS UNAVAILABLE TO EVERYBODY, the verifier who
    // deleted it included. Same treatment as `verified` above and for the same
    // reason: the lists cannot reach it, but this route is addressed by id, so
    // a bookmark or the Back button would otherwise still render the whole
    // record — which is hiding it rather than removing it.
    //
    // A CANDIDATE NEVER GETS THIS FAR. RLS returns them no row at all for a
    // deleted review, so `!cardRow` has already answered them; this branch is
    // the verifier case, where the tombstone IS readable. It stays readable to
    // a direct query, which is what makes it an audit record. What it stops
    // being is a page in the workflow.
    if ((cardRow as unknown as TestCard).deleted_at) {
      setNotFound(true); setLoading(false); return
    }

    setError(null)
    setCard(cardRow as unknown as TestCard)
    const photos = (shots ?? []) as unknown as TestCardPhoto[]
    // A row marked for removal is already gone as far as every reader is
    // concerned, which is the filter the rest of the module applies too.
    const live = photos.filter(photo => photo.removal_started_at === null)
    setScreenshots(live.filter(photo => photo.kind !== REVIEW_IMAGE_KIND))
    setReviewImages(
      live
        .filter(photo => photo.kind === REVIEW_IMAGE_KIND)
        .sort((a, b) => (a.image_slot ?? 0) - (b.image_slot ?? 0)),
    )
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

  // THERE IS NO isAdmin HERE ANY MORE. It had two remaining uses and both were
  // authorization alternatives — a screenshot-removal control and the verifier
  // facts panel — so removing them left nothing for it to do. A role variable
  // kept "in case" is a role variable somebody re-uses.
  //
  // NO ROLE IS PASSED to holdsThisCard either, because none is consulted.
  // Holding a card is the whole of what authorises a tester action, for an
  // administrator as much as anyone.
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

  /**
   * Put this review back, before saying it was sent.
   *
   * WHAT THE SERVER DOES WITH IT, and why none of it is decided here:
   * unbook_customer_review_test_card() locks the row, re-checks that the caller
   * is the holder, that the review is still booked, that no send has been
   * confirmed and that no screenshot is attached, then clears every booking
   * field — including the four retained digits of the last recipient — and
   * appends an `unbooked` entry to the trail. The approval survives, because a
   * released review is still an approved review.
   *
   * A FAILURE LEAVES THE READER HERE. The message is shown on the card they
   * were already looking at, and the card is reloaded so what is on screen is
   * what is actually true — which for the common refusal ("you already
   * confirmed you sent it") is exactly what they need to see.
   */
  /**
   * Take this review out of the workflow.
   *
   * A VERIFIER'S ACTION AND NOBODY ELSE'S. delete_customer_review_test_cards()
   * resolves `verify` from the permission engine, locks the row, refuses a
   * review that has already been deleted, writes the `deleted` event naming the
   * stage it was in, and stamps the tombstone. Nothing is physically removed:
   * the trail and any attached screenshot stay exactly where they are.
   *
   * AFTERWARDS THIS PAGE IS GONE. The review's URL becomes unavailable the
   * moment it is deleted, so there is nothing to return to and the reader is
   * sent back to the list rather than left on a screen that would immediately
   * render "not available".
   */
  const remove = useCallback(async () => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setDeleteError(null)
    try {
      const { error: rpcError } = await supabase.rpc('delete_customer_review_test_cards', {
        p_card_ids: [cardId],
        p_source: 'single',
      })
      if (rpcError) {
        // THE SHEET STAYS OPEN. The usual refusal is staleness — somebody
        // deleted it first — and the sentence explaining that belongs where the
        // person is looking.
        setDeleteError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That review could not be deleted.')
        return
      }
      setDeleting(false)
      router.push('/customer-reviews')
    } catch {
      setDeleteError('That review could not be deleted. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, cardId, router])

  const unbook = useCallback(async () => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('unbook_customer_review_test_card', {
        p_card_id: cardId,
      })
      if (rpcError) {
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That review could not be unbooked.')
        await load()
        return
      }
      setUnbooking(false)
      // BACK TO THE LIST, because this card is no longer this person's. Staying
      // on a page for a review somebody else may already have booked would
      // leave them looking at controls that have all just disappeared.
      router.push('/customer-reviews?tab=available')
    } catch {
      setError('That review could not be unbooked. Check your connection and try again.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }, [supabase, cardId, load, router])

  const runAction = useCallback(async (action: TestCardAction, detail: string | null) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('transition_customer_review_test_card', {
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
      // than like success. Going back to the list is the honest ending. The
      // list is told what the database just did — the BOE Credits reward it
      // posted in the same transaction as the verification — through the same
      // kind of one-shot query flag the order drafts use for ?saved=1: it
      // decides only what the list SAYS, never what it shows.
      if (action.to === 'verified') {
        router.push(`/customer-reviews?tab=to_verify${verifiedQuery(data)}`)
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
        title="Review"
        canVerify={caps.canVerify}
        onSignOut={signOut}
      >
        <p style={{ fontSize: '13px', color: colors.secondary }}>
          That review is not available.{' '}
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
  const mayDelete = canDeleteCard({ userId: profile?.id ?? null, canVerify: caps.canVerify })

  return (
    <CustomerReviewsLayout
      profile={profile}
      title={card.test_title}
      subtitle={`${card.card_ref} · ${testCategoryLabel(card.test_category)}`}
      canVerify={caps.canVerify}
      onSignOut={signOut}
      actions={
        <>
          <button
            type="button"
            onClick={() => router.push('/customer-reviews')}
            className="boe-btn boe-btn-ghost"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}
          >
            <ArrowLeft size={14} strokeWidth={2} />
            Back
          </button>
          {/*
            THE SECONDARY ACTION AREA IS WHERE THIS BELONGS — beside Back, not
            among the workflow controls a candidate uses further down. It is
            rendered only for a resolved `verify` holder, so a candidate never
            sees it on a review they are holding.
          */}
          {mayDelete && (
            <DeleteReviewButton compact disabled={busy} onClick={() => setDeleting(true)} />
          )}
        </>
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

        {/*
          WHERE THIS REVIEW IS, AND WHAT COMES NEXT — said once, at the top,
          before the reader scrolls through the text, the images and the
          evidence to find the one control they came for. The sentence comes
          from nextStepFor(); the controls it points at are unchanged and
          still decide nothing — the database does.
        */}
        <NextStepStrip
          card={card}
          step={nextStepFor(card, { userId: profile?.id ?? null, canUse: caps.canUse, canVerify: caps.canVerify }, screenshots.length > 0)}
          hasAction={actions.length > 0 || (canWorkOnIt && !card.sent_confirmed_at)}
        />

        {error && (
          <p role="alert" style={{ fontSize: '12px', color: colors.red, margin: 0 }}>{error}</p>
        )}

        {/* A returned card says why, at the top, where the candidate will see it. */}
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
        <Section title="Review draft">
          <p style={{
            margin: 0, fontSize: '13px', color: colors.primary,
            lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          }}>
            {card.test_body}
          </p>
          {/*
            THE PROVENANCE SENTENCE, CORRECTED.
            It used to end "and cannot be edited — not by you, not by an
            administrator, and not through any screen in BOE." That stopped
            being true when a verifier gained the ability to correct a draft
            before approving it, and a sentence that promises immutability on a
            screen where the text may have been rewritten is worse than no
            sentence. What IS still true is the narrow thing: the window closes
            at approval, so the text on this page — which is approved or later —
            is final.
          */}
          <p style={{ fontSize: '11px', color: colors.muted, marginTop: '8px', marginBottom: 0, lineHeight: 1.5 }}>
            This draft was written by AI for a customer to use, adapt or discard. It is not a
            record of anything that happened and is not attributed to anybody.
            {card.draft_edited_at
              ? ' A verifier edited it before approving it.'
              : ' It is exactly as it was generated.'}
            {' '}Now that it is approved its text is final and cannot be edited — not by you,
            not by an administrator, and not through any screen in BOE.
          </p>
          {card.draft_edited_at && (
            <div style={{ marginTop: '8px' }}><DraftEditedNote card={card} /></div>
          )}
        </Section>

      {/*
        ── The review's own images, and sharing them ──

        NOT THE SCREENSHOT SECTION, and deliberately far from it. A screenshot
        is evidence a candidate produced about their own screen; these are
        photographs of furniture that go OUT with the review. Putting them in
        one section would invite somebody to share the evidence by mistake.

        THE IMAGES ARE READ-ONLY HERE. Every card this page can render is
        approved or later — a pending draft is edited from the verifier's
        workspace, and the server refuses an attach or a removal once a review
        is approved. `canEdit={false}` says so on screen instead of drawing a
        control the database would answer 409.

        SHARING IS OFFERED ONLY FOR AN APPROVED REVIEW. ShareReviewButton asks
        isShareableReview() and renders nothing at all when the answer is no —
        not a disabled button, which is a thing somebody would try to enable.
        It hands the text and the files to the operating system's share sheet;
        the person picks WhatsApp, picks a recipient and presses send. Nothing
        here sends anything, and no copy on this screen says it does.
      */}
      {(reviewImages.length > 0 || card.approved_at) && (
        <Section title="Review images">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <ReviewImageManager
              supabase={supabase}
              cardId={card.id}
              images={reviewImages}
              onChanged={load}
              canEdit={false}
            />
            <ShareReviewButton supabase={supabase} card={card} images={reviewImages} />
          </div>
        </Section>
      )}

        {/* ── Step 1 and 2: open WhatsApp, then say you sent it ── */}
        {(canWorkOnIt || card.whatsapp_opened_at) && (
          <Section title="Send the review" id="review-send">
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
                  exactly what the candidate sees.
                */}
                <Fact
                  label="Addressed to"
                  value={maskFromLastFour(card.whatsapp_target_last_four)}
                />
                <Fact label="Candidate confirmed sent" value={formatTestTimestamp(card.sent_confirmed_at)} />
              </dl>
            )}
          </Section>
        )}

        {/* ── Step 3: the screenshot ── */}
        <Section title="Screenshot">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <ScreenshotIsNotProofNote />
            <ScreenshotManager
              supabase={supabase}
              cardId={card.id}
              screenshots={screenshots}
              onChanged={load}
              canAttach={canWorkOnIt}
              // canWorkOnIt ALONE: the holder, while the card is still
              // theirs. begin_customer_review_test_screenshot_removal() says
              // exactly this and has no administrator branch, so the
              // `|| isAdmin` that stood here drew a control the database
              // refuses 42501.
              canRemove={canWorkOnIt}
              emptyHint={
                canWorkOnIt
                  ? 'Attach a screenshot of the message you sent.'
                  : 'No screenshot is attached to this review.'
              }
            />
          </div>
        </Section>

        {/* ── Changed your mind? ──
          Offered only while the review is genuinely still releasable, and
          explained rather than hidden when it is not. canUnbookCard() is the
          browser-side mirror of the definer function, clause for clause; the
          function re-checks every one of them under a row lock and is what
          actually refuses.

          IT IS NOT A PRIMARY ACTION. It sits below the work, in ghost styling,
          because unbooking a review is the exception and sending it is the
          point — but it is a real control with a text label rather than an
          unexplained icon, because somebody who booked the wrong review needs
          to find it.
        */}
        {mine && card.status === 'booked' && (
          <Section title="Not this review?">
            {canUnbookCard(
              card,
              { userId: profile?.id ?? null, canUse: caps.canUse },
              screenshots.length > 0,
            ) ? (
              <div>
                <button
                  type="button"
                  onClick={() => setUnbooking(true)}
                  disabled={busy}
                  className="boe-btn boe-btn-ghost"
                  style={{
                    fontSize: '13px', padding: '11px 18px', minHeight: '44px',
                    opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer',
                  }}
                >
                  Unbook this review
                </button>
                <p style={{ fontSize: '11px', color: colors.muted, margin: '7px 0 0', lineHeight: 1.5 }}>
                  It goes back to Available for somebody else to book. You can do this until
                  you confirm you sent it — after that it stays yours.
                </p>
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: '12px', color: colors.tertiary, lineHeight: 1.55 }}>
                {unbookBlocker(
                  card,
                  { userId: profile?.id ?? null, canUse: caps.canUse },
                  screenshots.length > 0,
                ) ?? 'This review can no longer be unbooked.'}
              </p>
            )}
          </Section>
        )}

        {/* ── Step 4 and 5: submit, then somebody verifies ── */}
        {actions.length > 0 && (
          <Section title="Next step" id="review-next-step">
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
                      fontSize: '13px', padding: '9px 18px', minHeight: '44px',
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
                    style={{ fontSize: '13px', padding: '8px 16px', minHeight: '44px' }}
                  >
                    {busy ? 'Working…' : prompt.action.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt(null)}
                    className="boe-btn boe-btn-ghost"
                    style={{ fontSize: '13px', padding: '8px 16px', minHeight: '44px' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Section>
        )}

        {/* ── What a verifier reads ── */}
        {/*
          caps.canVerify ALONE. These are the facts a verifier reads to make a
          decision, and `|| isAdmin` showed them to an administrator whose
          `verify` had been revoked — somebody the transition function will not
          let act on the card at all. caps.canVerify is now the resolved
          permission (see deriveCustomerReviewCapabilities), so this follows the
          engine like everything else.
        */}
        {caps.canVerify && card.status !== 'available' && (
          <Section title="Who did what">
            <dl style={{ margin: 0, display: 'grid', gap: '6px' }}>
              <Fact label="Booked" value={formatTestTimestamp(card.booked_at)} />
              <Fact label="WhatsApp opened" value={formatTestTimestamp(card.whatsapp_opened_at)} />
              <Fact label="Candidate confirmed sent" value={formatTestTimestamp(card.sent_confirmed_at)} />
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

      {/*
        A LIGHTWEIGHT CONFIRMATION, so an accidental tap does not release a
        booking. It is one sentence and two buttons, not a form: the action is
        reversible in the sense that the review can be booked again — by
        anybody, which is the part worth saying out loud.
      */}
      {unbooking && (
        <ReviewSheet
          title="Unbook this review?"
          onClose={() => { if (!busy) setUnbooking(false) }}
          footer={
            <>
              <button
                type="button"
                onClick={unbook}
                disabled={busy}
                className="boe-btn boe-btn-primary"
                style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
              >
                {busy ? 'Unbooking…' : 'Yes, unbook it'}
              </button>
              <button
                type="button"
                onClick={() => setUnbooking(false)}
                disabled={busy}
                className="boe-btn boe-btn-ghost"
                style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
              >
                Keep it
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: '13px', color: colors.secondary, lineHeight: 1.6 }}>
            <strong style={{ color: colors.primary }}>{card.card_ref}</strong> returns to the
            available pool, and any candidate can book it — including somebody else, straight
            away. It stays approved; you are giving up the booking, not the review.
          </p>
          <p style={{ margin: 0, fontSize: '12px', color: colors.tertiary, lineHeight: 1.55 }}>
            The number you last opened WhatsApp for is cleared. What already happened stays on
            the activity trail below; unbooking a review adds a line to it rather than removing
            one.
          </p>
        </ReviewSheet>
      )}

      {/*
        THE SAME SHEET THE LIST USES, so the wording a verifier reads before
        deleting is identical wherever they started from — and the stage warning
        for a booked or sent review is written once.
      */}
      {deleting && (
        <DeleteReviewsSheet
          cards={[card]}
          busy={busy}
          error={deleteError}
          onConfirm={() => { void remove() }}
          onCancel={() => { setDeleting(false); setDeleteError(null) }}
        />
      )}
    </CustomerReviewsLayout>
  )
}

const EVENT_LABELS: Record<string, string> = {
  generated:          'Drafted',
  revised:            'Draft rewritten',
  draft_edited:       'Draft edited by a verifier',
  approved:           'Approved',
  booked:             'Booked',
  unbooked:           'Unbooked — back to Available',
  whatsapp_opened:    'WhatsApp opened',
  sent_confirmed:     'Candidate confirmed sent',
  submitted:          'Submitted for verification',
  verified:           'Verified',
  returned:           'Returned to candidate',
  screenshot_removed: 'Screenshot removed',
  image_removed:      'Review image removed',
  deleted:            'Deleted by a verifier',
  replaced:           'Replaced by a newer batch',
}

// ─── BOE Credits: the reward a verification posted ───────────────────────────
//
// transition_customer_review_test_card() returns { card, reward } since
// 20261102000000. `reward.credits` is what the database actually wrote, in the
// same transaction as the verification — the active setting at that instant,
// for the card's holder. Nothing here computes a number: it carries the one the
// database returned to the To verify list, which says it.

/** The query-string tail for the To verify list after a verification:
 *  `&verified=<credits>`, or `&verified=0` when the result carries no reward
 *  (an older function, say). The list shows the amount and trusts the flag for
 *  nothing else — every row it renders still comes from its own queries. */
export function verifiedQuery(data: unknown): string {
  const reward = (data as {
    reward?: { credits?: unknown; qualifying_review_count?: unknown; minimum_reviews?: unknown; month_status?: unknown } | null
  } | null)?.reward
  const credits = typeof reward?.credits === 'number' && Number.isFinite(reward.credits) && reward.credits > 0
    ? Math.trunc(reward.credits)
    : 0
  // Phase 1D: the month's standing, as the database reported it, so the list
  // can say "2 of 3 this month". Absent when an older function answered.
  const done = typeof reward?.qualifying_review_count === 'number' ? Math.trunc(reward.qualifying_review_count) : null
  const need = typeof reward?.minimum_reviews === 'number' ? Math.trunc(reward.minimum_reviews) : null
  const status = reward?.month_status === 'qualified' ? 'qualified' : reward?.month_status === 'open' ? 'open' : null
  if (done === null || need === null || status === null) return `&verified=${credits}`
  return `&verified=${credits}&reviews=${done}&target=${need}&month=${status}`
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} style={{
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

/**
 * The four stages and the next-step sentence, in one strip.
 *
 * "Go to it" scrolls to the control the sentence points at: the send panel
 * while the review is unsent, the Next step section once it can be submitted,
 * verified or returned. Nothing here performs an action.
 */
function NextStepStrip({
  card, step, hasAction,
}: {
  card: TestCard
  step: ReturnType<typeof nextStepFor>
  hasAction: boolean
}) {
  const at = stageIndex(card)
  const toneColor =
    step.tone === 'attention' ? '#9A3412'
    : step.tone === 'act' ? '#1E40AF'
    : step.tone === 'done' ? '#166534'
    : colors.tertiary
  const toneBg =
    step.tone === 'attention' ? '#FFF7ED'
    : step.tone === 'act' ? '#EFF6FF'
    : step.tone === 'done' ? '#F0FDF4'
    : colors.raised
  const target = card.status === 'booked' && !card.sent_confirmed_at ? 'review-send' : 'review-next-step'

  return (
    <div style={{
      padding: '12px 14px', borderRadius: '10px',
      background: toneBg, border: `1px solid ${colors.border}`,
      display: 'flex', flexDirection: 'column', gap: '10px',
    }}>
      <ol aria-label="Progress" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {REVIEW_STAGES.map((name, i) => {
          const done = i < at
          const current = i === at
          return (
            <li key={name} style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px',
              fontSize: '11px', fontWeight: 600,
              color: done ? '#166534' : current ? colors.primary : colors.muted,
            }}>
              <span aria-hidden="true" style={{
                width: 16, height: 16, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700,
                background: done ? '#BBF7D0' : current ? colors.primary : 'rgba(0,0,0,0.08)',
                color: done ? '#166534' : current ? '#fff' : colors.muted,
              }}>
                {done ? '✓' : i + 1}
              </span>
              {name}
              {i < REVIEW_STAGES.length - 1 && <span aria-hidden="true" style={{ color: '#C4C9D4', margin: '0 2px' }}>›</span>}
            </li>
          )
        })}
      </ol>
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: toneColor }}>{step.headline}</div>
          {step.hint && <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5, marginTop: '2px' }}>{step.hint}</div>}
        </div>
        {hasAction && step.tone !== 'wait' && step.tone !== 'done' && (
          <button
            type="button"
            onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="boe-btn boe-btn-ghost"
            style={{ fontSize: '12px', padding: '8px 14px', minHeight: '40px', whiteSpace: 'nowrap' }}
          >
            Go to it
          </button>
        )}
      </div>
    </div>
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

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Check, CircleDashed, Pencil } from 'lucide-react'
import { LoadingScreen, EmptyState } from '@/components/ui/atoms'
import { Toast, useToast } from '@/components/ui/toast'
import { colors } from '@/lib/tokens'
import { CustomerReviewsLayout } from '@/components/layout/CustomerReviewsLayout'
import {
  MaskedNumber, OutreachPrinciple, ReviewBadge, WhatsAppOpenedNote,
} from '@/components/customerReviews/ReviewPieces'
import { InvitationPreview } from '@/components/customerReviews/InvitationPreview'
import { PhotoManager } from '@/components/customerReviews/PhotoManager'
import { WhatsAppLaunchButton } from '@/components/customerReviews/WhatsAppLaunch'
import { useCustomerReviews } from '@/hooks/useCustomerReviews'
import { canEditThisRequest } from '@/lib/permissions/customerReviewOutreach'
import { buildInvitationMessage } from '@/lib/customerReviews/invitation'
import { parseReviewEvidenceUrl } from '@/lib/customerReviews/destination'
import { availableActions, type CustomerReviewAction } from '@/lib/customerReviews/status'
import {
  CUSTOMER_REVIEW_EVENT_COLUMNS,
  CUSTOMER_REVIEW_PHOTO_COLUMNS,
  CUSTOMER_REVIEW_REQUEST_COLUMNS,
  CUSTOMER_REVIEW_STATUS_META,
  formatReviewDate,
  interactionTypeLabel,
  type CustomerReviewEvent,
  type CustomerReviewPhoto,
  type CustomerReviewRequest,
} from '@/lib/customerReviews/types'

// One request, and the five separate facts about it.
//
// THE THING THIS SCREEN EXISTS TO KEEP APART. An outreach has five milestones
// and they are NOT the same claim:
//
//   1. Invitation prepared        the request is complete and ready.
//   2. WhatsApp opened            the message was handed to WhatsApp. Proves
//                                 preparation. Not delivery, not sending.
//   3. Employee confirmed sent    a person said they sent it.
//   4. Customer responded         a person observed a reply.
//   5. Public review evidence     a link somebody pasted, unverified.
//   6. Verified                   somebody holding `verify` checked it.
//
// They are rendered as six separate rows, each either done or not, rather than
// as one progress bar — because a progress bar would let "we opened a link"
// slide into reading as "the customer reviewed us", which is the exact
// dishonesty this module is shaped to prevent.

type Prompt = {
  action: CustomerReviewAction
  value: string
}

export function RequestDetailScreen({ requestId }: { requestId: string }) {
  const { supabase, profile, caps, loading: authLoading, signOut } = useCustomerReviews()
  const router = useRouter()
  const { toast, show, dismiss } = useToast()

  const [request, setRequest] = useState<CustomerReviewRequest | null>(null)
  const [photos, setPhotos]   = useState<CustomerReviewPhoto[]>([])
  const [events, setEvents]   = useState<CustomerReviewEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [prompt, setPrompt]   = useState<Prompt | null>(null)
  const [acting, setActing]   = useState(false)
  const [evidenceInput, setEvidenceInput] = useState('')
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    const [reqResult, photoResult, eventResult] = await Promise.all([
      supabase
        .from('customer_review_requests')
        .select(`${CUSTOMER_REVIEW_REQUEST_COLUMNS}, owner:users!created_by(full_name), verifier:users!verified_by(full_name)`)
        .eq('id', requestId)
        .maybeSingle(),
      supabase
        .from('customer_review_request_photos')
        .select(CUSTOMER_REVIEW_PHOTO_COLUMNS)
        .eq('request_id', requestId)
        // A row being removed is already gone as far as the screen is concerned;
        // its object may already have been deleted.
        .is('removal_started_at', null)
        .order('uploaded_at', { ascending: true }),
      supabase
        .from('customer_review_request_events')
        .select(`${CUSTOMER_REVIEW_EVENT_COLUMNS}, actor:users!actor_id(full_name)`)
        .eq('request_id', requestId)
        .order('created_at', { ascending: false }),
    ])

    // A request this person may not read comes back as no row, not as an error:
    // the SELECT policy filters it out. "Not found" is the honest thing to show
    // — it neither confirms nor denies that the request exists.
    if (reqResult.error || !reqResult.data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    const row = reqResult.data as CustomerReviewRequest & {
      owner?: { full_name: string } | null
      verifier?: { full_name: string } | null
    }
    const { owner, verifier, ...rest } = row
    setRequest({ ...rest, owner_name: owner?.full_name ?? null, verifier_name: verifier?.full_name ?? null })
    setPhotos((photoResult.data ?? []) as CustomerReviewPhoto[])
    setEvents(((eventResult.data ?? []) as (CustomerReviewEvent & { actor?: { full_name: string } | null })[])
      .map(({ actor, ...e }) => ({ ...e, actor_name: actor?.full_name ?? null })))
    setEvidenceInput('')
    setLoading(false)
  }, [supabase, requestId])

  useEffect(() => {
    if (authLoading) return
    const run = () => { void load() }
    run()
  }, [authLoading, load])

  const runTransition = useCallback(async (action: CustomerReviewAction, detail: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setActing(true)
    try {
      const { error } = await supabase.rpc('transition_customer_review_request', {
        p_request_id: requestId,
        p_next_status: action.to,
        p_detail: detail.trim() || null,
        p_review_url: action.prompt === 'review_link' && detail.trim() ? detail.trim() : null,
      })
      if (error) {
        show(error.message.replace(/^[A-Z_]+:\s*/, '') || 'That could not be done.', 'error')
        return
      }
      setPrompt(null)
      await load()
      show('Updated')
    } finally {
      inFlight.current = false
      setActing(false)
    }
  }, [supabase, requestId, load, show])

  const recordEvidence = useCallback(async () => {
    if (inFlight.current) return
    const parsed = parseReviewEvidenceUrl(evidenceInput)
    if (!parsed.ok) { show(parsed.error, 'error'); return }

    inFlight.current = true
    setActing(true)
    try {
      const { error } = await supabase.rpc('record_customer_review_evidence', {
        p_request_id: requestId,
        p_review_url: parsed.url,
      })
      if (error) {
        show(error.message.replace(/^[A-Z_]+:\s*/, '') || 'That link could not be recorded.', 'error')
        return
      }
      await load()
      show('Review link recorded — the customer now counts as having responded, and it still needs verifying')
    } finally {
      inFlight.current = false
      setActing(false)
    }
  }, [supabase, requestId, evidenceInput, load, show])

  if (authLoading || loading) return <LoadingScreen />

  if (notFound || !request) {
    return (
      <CustomerReviewsLayout
        profile={profile}
        canVerify={caps.canVerify}
        title="Review request"
        onSignOut={signOut}
      >
        <EmptyState
          message="That request is not available."
          hint="It may have been removed, or it belongs to another employee."
        />
      </CustomerReviewsLayout>
    )
  }

  const isOwner = !!profile && request.created_by === profile.id
  const canEdit = canEditThisRequest(request, profile?.id ?? null, caps, profile?.role)
  const actions = availableActions(request, {
    userId: profile?.id ?? null,
    isAdmin: profile?.role === 'admin',
    canUse: caps.canUse,
    canVerify: caps.canVerify,
  })

  const projectPhotos = photos.filter(p => p.kind === 'project_photo')
  const proofPhotos   = photos.filter(p => p.kind === 'review_proof')

  const message = buildInvitationMessage({
    greetingName: request.greeting_name,
    customerName: request.customer_name,
    projectReference: request.project_reference,
    reviewUrl: request.review_url ?? '',
  })

  const canRecordEvidence =
    (isOwner || profile?.role === 'admin') &&
    caps.canUse &&
    (request.status === 'sent' || request.status === 'customer_responded')

  return (
    <CustomerReviewsLayout
      profile={profile}
      canVerify={caps.canVerify}
      // The shared page header does not truncate, so a long customer name would
      // push the header layout apart. It is bounded here and shown in full in
      // the "Customer and project" card below, which wraps.
      title={headerTitle(request.customer_name)}
      subtitle={interactionTypeLabel(request.interaction_type)}
      onSignOut={signOut}
      actions={
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => router.push('/customer-reviews')}
            className="boe-btn boe-btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 12px', fontSize: '12px' }}
          >
            <ArrowLeft size={13} strokeWidth={2} />
            Back
          </button>
          {canEdit && (
            <button
              onClick={() => router.push(`/customer-reviews/${request.id}/edit`)}
              className="boe-btn boe-btn-ghost"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 12px', fontSize: '12px' }}
            >
              <Pencil size={13} strokeWidth={2} />
              Edit
            </button>
          )}
        </div>
      }
    >
      <div style={{ maxWidth: '860px' }}>
        <OutreachPrinciple />

        {/* ── Status + the six separate facts ── */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <ReviewBadge meta={CUSTOMER_REVIEW_STATUS_META[request.status]} />
            <span style={{ fontSize: '11.5px', color: colors.muted }}>
              Raised {formatReviewDate(request.created_at)}
              {request.owner_name ? ` by ${request.owner_name}` : ''}
            </span>
          </div>

          <div style={{ marginTop: '14px', display: 'grid', gap: '2px' }}>
            <Milestone
              done={request.status !== 'draft' && request.status !== 'cancelled'}
              label="Invitation prepared"
              detail="Everything needed to send it is filled in."
            />
            <Milestone
              done={!!request.whatsapp_opened_at}
              label="WhatsApp opened"
              detail={request.whatsapp_opened_at
                ? `Last opened ${formatReviewDate(request.whatsapp_opened_at)}. Prepared ${request.whatsapp_opened_count} time${request.whatsapp_opened_count === 1 ? '' : 's'}.`
                : 'The invitation has not been handed to WhatsApp yet.'}
              note={<WhatsAppOpenedNote />}
            />
            <Milestone
              done={!!request.sent_at}
              label="Employee confirmed sent"
              detail={request.sent_at
                ? `Confirmed on ${formatReviewDate(request.sent_at)}.`
                : 'Nobody has confirmed sending this message.'}
            />
            <Milestone
              done={!!request.responded_at}
              label="Customer responded"
              detail={request.responded_at
                ? `Recorded on ${formatReviewDate(request.responded_at)}.`
                : 'No reply has been recorded.'}
            />
            <Milestone
              done={!!request.review_public_url}
              label="Public review evidence supplied"
              detail={request.review_public_url
                ? 'A link has been recorded. It has not been checked yet unless the row below says so.'
                : 'No link to a published review has been recorded.'}
            />
            <Milestone
              done={!!request.verified_at}
              label="Verified"
              detail={request.verified_at
                ? `Verified ${formatReviewDate(request.verified_at)}${request.verifier_name ? ` by ${request.verifier_name}` : ''}.`
                : 'Nobody with the Verify permission has checked this yet.'}
            />
          </div>
        </Card>

        {/* ── Actions ── */}
        {actions.length > 0 && (
          <Card title="What happens next">
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {actions.map(action => (
                <button
                  key={action.to}
                  onClick={() => (action.prompt
                    ? setPrompt({ action, value: '' })
                    : runTransition(action, ''))}
                  disabled={acting}
                  className={action.destructive ? 'boe-btn boe-btn-ghost' : 'boe-btn boe-btn-primary'}
                  style={{
                    padding: '9px 16px', fontSize: '13px', minHeight: '38px',
                    opacity: acting ? 0.6 : 1,
                    ...(action.destructive ? { color: colors.red, borderColor: 'rgba(217,79,79,0.35)' } : {}),
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
            {request.status === 'ready_to_send' && (
              <p style={{ fontSize: '11.5px', color: colors.muted, marginTop: '10px', lineHeight: 1.5 }}>
                “I sent this invitation” is your own confirmation. BOE cannot tell whether WhatsApp
                delivered anything, so nothing else records it for you.
              </p>
            )}
          </Card>
        )}

        {/* ── The invitation ── */}
        <Card title="The invitation prepared">
          <InvitationPreview
            message={message}
            incomplete={request.review_url ? null : 'No review link has been added yet.'}
          />

          {request.status === 'ready_to_send' && isOwner && caps.canUse && (
            <div style={{ marginTop: '14px' }}>
              <WhatsAppLaunchButton
                supabase={supabase}
                requestId={request.id}
                whatsappNumber={request.whatsapp_number}
                message={message}
                enabled
                onOpened={() => { show('WhatsApp opened — press send there', 'info'); void load() }}
                onError={m => show(m, 'error')}
              />
            </div>
          )}
        </Card>

        {/* ── Customer and internal detail ── */}
        <Card title="Customer and project">
          <Row label="Customer or project">{request.customer_name}</Row>
          <Row label="Interaction">{interactionTypeLabel(request.interaction_type)}</Row>
          <Row label="WhatsApp number">
            <MaskedNumber value={request.whatsapp_number} revealable />
          </Row>
          <Row label="Review destination">
            {request.review_url
              ? (
                <a
                  href={request.review_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: colors.blue, wordBreak: 'break-all' }}
                >
                  {request.review_url}
                </a>
              )
              : <span style={{ color: colors.muted }}>—</span>}
          </Row>
          <Row label="Genuine-customer confirmation">
            {request.genuine_customer_confirmed ? 'Confirmed' : 'Not confirmed'}
          </Row>
          <Row label="Internal note">
            {request.internal_note
              ? <span style={{ whiteSpace: 'pre-wrap' }}>{request.internal_note}</span>
              : <span style={{ color: colors.muted }}>—</span>}
          </Row>
          <p style={{ fontSize: '11px', color: colors.muted, marginTop: '4px' }}>
            The internal note is never part of the WhatsApp message.
          </p>
        </Card>

        {/* ── Photographs ── */}
        <Card title="Project photographs">
          <p style={{ fontSize: '11.5px', color: colors.secondary, marginBottom: '10px', lineHeight: 1.55 }}>
            Stored privately with this request. <strong>BOE cannot attach them to WhatsApp</strong> —
            a wa.me link carries the text invitation and nothing else. If you want the customer to
            see them, open each one to save it and attach the files yourself in the chat before you
            send.
          </p>
          <PhotoManager
            supabase={supabase}
            requestId={request.id}
            kind="project_photo"
            photos={projectPhotos}
            onChanged={load}
            canAttach={canEdit}
            canRemove={canEdit}
            downloadable
            emptyHint="No photographs were attached to this request."
          />
          {projectPhotos.length > 0 && (
            <p style={{ fontSize: '11.5px', color: colors.secondary, marginTop: '10px' }}>
              Sharing permission: {request.image_permission_confirmed ? 'confirmed' : 'not confirmed'}.
            </p>
          )}
        </Card>

        {/* ── Evidence ── */}
        <Card title="Public review evidence">
          <Row label="Recorded link">
            {request.review_public_url
              ? (
                <a
                  href={request.review_public_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: colors.blue, wordBreak: 'break-all' }}
                >
                  {request.review_public_url}
                </a>
              )
              : <span style={{ color: colors.muted }}>Nothing recorded</span>}
          </Row>

          {canRecordEvidence && (
            <>
            {request.status === 'sent' && (
              <p style={{ fontSize: '11.5px', color: colors.secondary, marginTop: '6px', lineHeight: 1.5 }}>
                Recording a published review here also marks the customer as having responded — a
                published review is a response. It does <strong>not</strong> verify the request.
              </p>
            )}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-start', marginTop: '8px' }}>
              <input
                className="boe-input"
                value={evidenceInput}
                onChange={e => setEvidenceInput(e.target.value)}
                placeholder="https://… link to the published review"
                aria-label="Link to the published review"
                style={{ flex: 1, minWidth: '220px', padding: '8px 10px', fontSize: '13px' }}
              />
              <button
                onClick={recordEvidence}
                disabled={acting || evidenceInput.trim() === ''}
                className="boe-btn boe-btn-ghost"
                style={{ padding: '8px 14px', fontSize: '12px', minHeight: '38px' }}
              >
                Record link
              </button>
            </div>
            </>
          )}

          <div style={{ marginTop: '14px' }}>
            <div style={{
              fontSize: '11px', fontWeight: 700, color: colors.tertiary,
              textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px',
            }}>
              Proof image
            </div>
            <PhotoManager
              supabase={supabase}
              requestId={request.id}
              kind="review_proof"
              photos={proofPhotos}
              onChanged={load}
              canAttach={canRecordEvidence}
              canRemove={false}
              emptyHint="No proof image attached."
            />
          </div>

          <p style={{ fontSize: '11px', color: colors.muted, marginTop: '10px', lineHeight: 1.5 }}>
            Evidence is a factual record of what somebody saw. It does not mean the request has been
            verified — only a verifier can say that.
          </p>
        </Card>

        {/* ── Verification ── */}
        {(request.verified_at || request.cancelled_at) && (
          <Card title={request.cancelled_at ? 'Cancellation' : 'Verification'}>
            {request.verified_at && (
              <>
                <Row label="Verified by">{request.verifier_name ?? '—'}</Row>
                <Row label="Verified on">{formatReviewDate(request.verified_at)}</Row>
                <Row label="Verifier’s note">
                  {request.verification_note
                    ? <span style={{ whiteSpace: 'pre-wrap' }}>{request.verification_note}</span>
                    : <span style={{ color: colors.muted }}>—</span>}
                </Row>
              </>
            )}
            {request.cancelled_at && (
              <>
                <Row label="Cancelled on">{formatReviewDate(request.cancelled_at)}</Row>
                <Row label="Reason">
                  {request.cancel_reason ?? <span style={{ color: colors.muted }}>—</span>}
                </Row>
              </>
            )}
          </Card>
        )}

        {/* ── Trail ── */}
        <Card title="History">
          {events.length === 0 ? (
            <p style={{ fontSize: '12px', color: colors.muted }}>Nothing recorded yet.</p>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {events.map(event => (
                <li
                  key={event.id}
                  style={{
                    display: 'flex', gap: '10px', padding: '8px 0',
                    borderBottom: `1px solid ${colors.border}`,
                  }}
                >
                  <span style={{
                    fontSize: '11px', color: colors.muted, minWidth: '92px',
                    fontFamily: 'var(--font-mono)', flexShrink: 0,
                  }}>
                    {formatReviewDate(event.created_at)}
                  </span>
                  <span style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
                    <strong style={{ color: colors.primary }}>{eventTitle(event)}</strong>
                    {event.detail ? ` — ${event.detail}` : ''}
                    {event.actor_name ? ` · ${event.actor_name}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      {prompt && (
        <PromptModal
          prompt={prompt}
          busy={acting}
          onChange={value => setPrompt({ ...prompt, value })}
          onCancel={() => setPrompt(null)}
          onConfirm={() => runTransition(prompt.action, prompt.value)}
        />
      )}

      <Toast toast={toast} onDismiss={dismiss} />
    </CustomerReviewsLayout>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section style={{
      background: colors.base, border: `1px solid ${colors.border}`,
      borderRadius: '10px', padding: '16px 18px', marginBottom: '14px',
    }}>
      {title && (
        <h2 style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, marginBottom: '12px' }}>
          {title}
        </h2>
      )}
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: '12px', padding: '6px 0', flexWrap: 'wrap',
      fontSize: '13px', color: colors.primary,
    }}>
      <span style={{ minWidth: '190px', color: colors.tertiary, fontSize: '12px', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ flex: 1, minWidth: '160px', wordBreak: 'break-word' }}>{children}</span>
    </div>
  )
}

/**
 * One fact, done or not done. Never a percentage and never a bar: each of these
 * is a separate claim, and only the ones that are actually true are ticked.
 */
function Milestone({
  done, label, detail, note,
}: { done: boolean; label: string; detail: string; note?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '7px 0' }}>
      <span style={{ marginTop: '1px', flexShrink: 0, color: done ? colors.green : colors.muted }}>
        {done ? <Check size={15} strokeWidth={2.4} /> : <CircleDashed size={15} strokeWidth={2} />}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{
          display: 'block', fontSize: '12.5px', fontWeight: 600,
          color: done ? colors.primary : colors.tertiary,
        }}>
          {label}
        </span>
        <span style={{ display: 'block', fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
          {detail}
        </span>
        {note && <span style={{ display: 'block', marginTop: '2px' }}>{note}</span>}
      </span>
    </div>
  )
}

const PROMPT_COPY: Record<NonNullable<CustomerReviewAction['prompt']>, {
  title: string
  label: string
  placeholder: string
  required: boolean
}> = {
  verification_note: {
    title: 'Verify this request',
    label: 'What did you check?',
    placeholder: 'e.g. Opened the link, the review is published under the customer’s own account.',
    required: true,
  },
  cancel_reason: {
    title: 'Cancel this request',
    label: 'Why is it being cancelled?',
    placeholder: 'e.g. Raised for the wrong customer.',
    required: false,
  },
  review_link: {
    title: 'Record the customer’s reply',
    label: 'Link to the published review, if there is one',
    placeholder: 'https://… (optional)',
    required: false,
  },
}

function PromptModal({
  prompt, busy, onChange, onCancel, onConfirm,
}: {
  prompt: Prompt
  busy: boolean
  onChange: (value: string) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const copy = PROMPT_COPY[prompt.action.prompt!]
  const blocked = copy.required && prompt.value.trim() === ''

  // Escape closes, focus lands in the field, and focus RETURNS to whatever
  // opened the dialog when it goes. Without the last part a keyboard user is
  // dropped at the top of the document every time they cancel, which is how a
  // dialog turns a working queue into a scrolling exercise.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [onCancel])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 900,
        background: 'rgba(17,19,24,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#fff', borderRadius: '14px', padding: '22px 24px',
          width: '460px', maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflowY: 'auto',
          boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
        }}
      >
        <h2 style={{ fontSize: '15px', fontWeight: 700, color: colors.primary, marginBottom: '12px' }}>
          {copy.title}
        </h2>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.secondary, marginBottom: '4px' }}>
          {copy.label}
        </label>
        <textarea
          className="boe-input"
          autoFocus
          rows={3}
          maxLength={500}
          value={prompt.value}
          onChange={e => onChange(e.target.value)}
          placeholder={copy.placeholder}
          style={{ width: '100%', padding: '8px 10px', fontSize: '13px', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '9px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
              border: `1px solid ${colors.border}`, background: 'transparent',
              color: colors.muted, cursor: busy ? 'not-allowed' : 'pointer', minHeight: '40px',
            }}
          >
            Back
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || blocked}
            className="boe-btn boe-btn-primary"
            style={{
              padding: '9px 18px', fontSize: '13px', minHeight: '40px',
              opacity: busy || blocked ? 0.5 : 1,
            }}
          >
            {busy ? 'Working…' : prompt.action.label}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A page-header-safe length. The full value is always shown in the body. */
function headerTitle(name: string): string {
  const trimmed = name.trim()
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed
}

function eventTitle(event: CustomerReviewEvent): string {
  switch (event.event_type) {
    case 'created':           return 'Request raised'
    case 'whatsapp_opened':   return 'WhatsApp opened'
    case 'evidence_recorded': return 'Evidence recorded'
    case 'photo_removed':     return 'Photograph removed'
    case 'status_changed': {
      // A missing end reads as an em dash rather than as 'Draft'. Defaulting a
      // status the row does not carry would put a transition in the trail that
      // never happened.
      const from = event.previous_status ? CUSTOMER_REVIEW_STATUS_META[event.previous_status].label : '—'
      const to   = event.new_status ? CUSTOMER_REVIEW_STATUS_META[event.new_status].label : '—'
      return `${from} → ${to}`
    }
    default:                  return 'Updated'
  }
}

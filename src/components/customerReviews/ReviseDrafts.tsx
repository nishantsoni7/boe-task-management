'use client'

import { useCallback, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { ReviewSheet } from './ReviewSheet'
import { MAX_GUIDANCE } from '@/lib/customerReviews/draftGeneration'

// Revise every draft in one batch that is still waiting for approval.
//
// WHAT IT CHANGES, AND WHAT IT CANNOT. It replaces the title and the body of
// the batch's PENDING drafts and nothing else. An approved review is one a
// person released to candidates; a booked, sent, submitted, returned or
// verified one is somebody's work in progress or somebody's finished evidence.
// None of them is touched, and that is enforced in the database rather than
// here: revise_customer_review_draft_batch() locks the batch's pending rows,
// counts them again inside the transaction, and refuses the whole revision if
// the count has moved since this screen read it.
//
// WHY THE COUNT IS ON THE BUTTON. "Revise pending reviews" on a batch where six
// of twelve are already approved would read as though it rewrites twelve. It says
// two, and the confirmation says two again, because the number is the entire
// difference between what a verifier expects and what happens.
//
// WHY A FAILURE LEAVES EVERYTHING WHERE IT WAS. The sheet stays open, the
// feedback stays typed and the request key is still held, so pressing the
// button again retries THE SAME request rather than starting a second one.

type Props = {
  batchId: string
  /** How many drafts in this batch are still pending. Zero hides the control. */
  pendingCount: number
  /** Called after a successful revision so the list can reload. */
  onRevised: (count: number) => void
}

export function ReviseDrafts({ batchId, pendingCount, onRevised }: Props) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const running = useRef(false)
  const requestKey = useRef<string | null>(null)

  const trimmed = feedback.trim()

  const close = useCallback(() => {
    if (running.current) return
    setOpen(false)
    setConfirming(false)
  }, [])

  const revise = useCallback(async () => {
    if (running.current) return
    running.current = true
    if (!requestKey.current) requestKey.current = crypto.randomUUID()
    setWorking(true)
    setError(null)
    try {
      const response = await fetch('/api/customer-reviews/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, feedback: trimmed, requestKey: requestKey.current }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setError(body?.error ?? 'That did not work. Please try again.')
        return
      }
      setFeedback('')
      requestKey.current = null
      setOpen(false)
      setConfirming(false)
      onRevised(body?.revised ?? pendingCount)
    } catch {
      setError('That did not work. Check your connection and try again.')
    } finally {
      running.current = false
      setWorking(false)
    }
  }, [batchId, trimmed, pendingCount, onRevised])

  if (pendingCount === 0) return null

  const noun = pendingCount === 1 ? 'review' : 'reviews'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="boe-btn boe-btn-ghost"
        style={{ fontSize: '12px', padding: '9px 14px', minHeight: '44px' }}
      >
        <RefreshCw size={13} strokeWidth={2} />
        Revise {pendingCount} pending {noun}
      </button>

      {open && (
        <ReviewSheet
          title={`Revise ${pendingCount} pending ${noun}`}
          subtitle="Only the reviews still awaiting approval are rewritten."
          onClose={close}
          dismissOnBackdrop={false}
          footer={
            confirming ? (
              <>
                <button
                  type="button"
                  onClick={revise}
                  disabled={working}
                  className="boe-btn boe-btn-primary"
                  style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  {working && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
                  {working ? 'Rewriting…' : `Yes, rewrite ${pendingCount} ${noun}`}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={working}
                  className="boe-btn boe-btn-ghost"
                  style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  Back
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={trimmed.length === 0}
                  className="boe-btn boe-btn-primary"
                  style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  Continue
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="boe-btn boe-btn-ghost"
                  style={{ justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  Cancel
                </button>
              </>
            )
          }
        >
          <div style={{
            padding: '10px 12px', borderRadius: '8px',
            background: colors.blueTint, border: '1px solid rgba(85,133,232,0.22)',
            fontSize: '12px', color: colors.secondary, lineHeight: 1.55,
          }}>
            <strong style={{ color: colors.primary }}>
              {pendingCount} of this batch’s reviews will be rewritten.
            </strong>{' '}
            Any review in this batch you have already approved keeps its exact text, and so
            does every review a candidate has booked, sent, submitted or had verified.
          </div>

          <label htmlFor="revision-feedback" style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
            What should change?
          </label>
          <p id="revision-feedback-help" style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
            Say what is wrong with the current drafts and what you want instead — for example
            “too enthusiastic, and they all sound the same; make some shorter and mention
            after-sales less”. The original batch guidance still applies; this is the
            correction on top of it.
          </p>

          <textarea
            id="revision-feedback"
            aria-describedby="revision-feedback-help"
            value={feedback}
            onChange={e => { setFeedback(e.target.value); if (error) setError(null) }}
            maxLength={MAX_GUIDANCE}
            rows={6}
            disabled={working}
            placeholder="Say what you want changed…"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: '8px',
              border: `1px solid ${colors.border}`, fontSize: '13px', lineHeight: 1.55,
              fontFamily: 'inherit', resize: 'vertical', minHeight: '120px',
            }}
          />
          <div style={{ fontSize: '11px', color: colors.muted, textAlign: 'right' }}>
            {feedback.length} / {MAX_GUIDANCE}
          </div>

          {confirming && (
            <div style={{
              display: 'grid', gap: '8px', padding: '12px',
              border: '1px solid #DDD6FE', borderRadius: '8px', background: '#F5F3FF',
            }}>
              <strong style={{ fontSize: '12px', color: '#4C1D95' }}>
                This replaces the title and the body of {pendingCount} pending {noun}.
              </strong>
              <p style={{ margin: 0, fontSize: '12px', color: '#4C1D95', lineHeight: 1.55 }}>
                The current text is not kept. Either all {pendingCount} are rewritten or none
                of them is — if one comes back unusable, nothing changes.
              </p>
            </div>
          )}

          {working && (
            <p role="status" style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
              Rewriting {pendingCount} {noun}…
            </p>
          )}

          {error && (
            <p role="alert" style={{ margin: 0, fontSize: '12px', color: '#991B1B', lineHeight: 1.55 }}>
              {error} Your feedback is still here — press the button again to retry the same
              request.
            </p>
          )}
        </ReviewSheet>
      )}
    </>
  )
}

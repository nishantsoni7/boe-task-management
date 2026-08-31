'use client'

import { useCallback, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { ReviewSheet } from './ReviewSheet'
import { DRAFTS_PER_BATCH, MAX_GUIDANCE } from '@/lib/customerReviews/draftGeneration'

// The generation control: a button, and a sheet behind it.
//
// WHO SEES IT: the caller renders it only when caps.canVerify, which is the
// RESOLVED `verify` permission and never a role. That is the weakest of the
// three checks — a screen can be lied to — and the route and the database
// function both ask again. It is here so somebody without the permission is not
// shown a button that would refuse them.
//
// WHY IT IS A SHEET AND NOT A PANEL. It used to be a permanently open section
// at the top of the list, above the tabs, on every visit for every verifier.
// Generation happens once in a while and reading pending drafts happens
// constantly, so the rare thing was occupying the space the frequent thing
// needed — particularly on a phone, where it pushed the list below the fold.
//
// THE POOL RULE IS GONE. The button used to be disabled until every available
// review had been booked, because a generated draft went straight to
// candidates and scarcity was the only brake. Approval is the brake now:
// eight drafts land in Pending approval, where no candidate can see them.
//
// WHAT IT STILL DOES NOT DO. No editing of a draft, no regeneration of a single
// one, no scheduling, no history, no filters. One button, one batch, one
// confirmation.

type Props = {
  /** Called after a successful batch so the list can reload. */
  onGenerated: () => void
}

type Phase =
  | { kind: 'writing' }
  | { kind: 'confirming' }
  | { kind: 'working' }
  | { kind: 'failed'; message: string }

export function GenerateDrafts({ onGenerated }: Props) {
  const [open, setOpen] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'writing' })
  const [done, setDone] = useState<number | null>(null)

  // State is too slow to stop a double click, and two clicks racing is exactly
  // what the request key exists to survive. This stops the second REQUEST; the
  // key stops the second BATCH.
  const running = useRef(false)
  /**
   * THE KEY THAT MAKES A REPEATED TAP HARMLESS, minted when the verifier
   * presses the confirmation and reused by every retry of THAT submission.
   *
   * It is generated here rather than by the route on purpose: a route that
   * minted its own key would give a retried request a new one, which is exactly
   * the case the key exists to catch. Cleared on success, so the next
   * deliberate generation is a different request and is allowed to proceed.
   */
  const requestKey = useRef<string | null>(null)

  const trimmed = guidance.trim()

  const close = useCallback(() => {
    if (running.current) return
    setOpen(false)
    setPhase({ kind: 'writing' })
  }, [])

  const generate = useCallback(async () => {
    if (running.current) return
    running.current = true
    if (!requestKey.current) requestKey.current = crypto.randomUUID()
    setPhase({ kind: 'working' })
    try {
      const response = await fetch('/api/customer-reviews/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidance: trimmed, requestKey: requestKey.current }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        // THE SHEET STAYS OPEN AND THE GUIDANCE STAYS TYPED. A failure that
        // closes the dialog makes somebody rewrite a paragraph they already
        // wrote, and the same request key is still held — so pressing the
        // button again retries THIS submission rather than starting a new one.
        setPhase({ kind: 'failed', message: body?.error ?? 'That did not work. Please try again.' })
        return
      }
      // The guidance and the key are both cleared on success, deliberately: the
      // next batch must be described afresh rather than silently repeating this
      // one, and it must be a new request rather than a repeat of this one.
      setGuidance('')
      requestKey.current = null
      setDone(body?.created ?? DRAFTS_PER_BATCH)
      setOpen(false)
      setPhase({ kind: 'writing' })
      onGenerated()
    } catch {
      setPhase({ kind: 'failed', message: 'That did not work. Check your connection and try again.' })
    } finally {
      running.current = false
    }
  }, [trimmed, onGenerated])

  const working = phase.kind === 'working'
  const confirming = phase.kind === 'confirming'

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => { setDone(null); setOpen(true) }}
          className="boe-btn boe-btn-primary"
          style={{ fontSize: '12px', padding: '9px 16px', minHeight: '44px' }}
        >
          <Sparkles size={14} strokeWidth={2.2} />
          Generate {DRAFTS_PER_BATCH} drafts
        </button>
        {done !== null && (
          <span role="status" style={{ fontSize: '12px', color: '#166534', fontWeight: 600 }}>
            {done} drafts created. They are waiting for your approval.
          </span>
        )}
      </div>

      {open && (
        <ReviewSheet
          title={`Generate ${DRAFTS_PER_BATCH} review drafts`}
          subtitle="They will wait for your approval. No candidate can see them until you approve."
          onClose={close}
          // A stray tap outside must never discard a paragraph somebody typed.
          dismissOnBackdrop={false}
          footer={
            confirming ? (
              <>
                <button
                  type="button"
                  onClick={generate}
                  disabled={working}
                  className="boe-btn boe-btn-primary"
                  style={{ flex: '1 1 auto', justifyContent: 'center', fontSize: '13px', padding: '11px 16px', minHeight: '44px' }}
                >
                  {working && <Loader2 size={14} strokeWidth={2.4} style={{ animation: 'boe-spin 0.8s linear infinite' }} />}
                  {working ? 'Drafting…' : `Yes, create ${DRAFTS_PER_BATCH} drafts`}
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: 'writing' })}
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
                  onClick={() => setPhase({ kind: 'confirming' })}
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
          <label htmlFor="review-guidance" style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
            Review guidance
          </label>
          <p id="review-guidance-help" style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
            Describe the tone, the product type, the project context and the subjects to
            cover — for example “restaurant banquette seating for a mid-range chain, warm
            and practical, covering delivery and after-sales”. Drafts are written from this
            description alone. Do not include a customer’s name or any real project detail
            you would not want written down.
          </p>

          <textarea
            id="review-guidance"
            aria-describedby="review-guidance-help"
            value={guidance}
            onChange={e => {
              setGuidance(e.target.value)
              if (phase.kind === 'failed') setPhase({ kind: 'writing' })
            }}
            maxLength={MAX_GUIDANCE}
            rows={6}
            disabled={working}
            placeholder="Describe the reviews you want drafted…"
            style={{
              width: '100%', padding: '10px 12px', borderRadius: '8px',
              border: `1px solid ${colors.border}`, fontSize: '13px', lineHeight: 1.55,
              fontFamily: 'inherit', resize: 'vertical', minHeight: '120px',
            }}
          />
          <div style={{ fontSize: '11px', color: colors.muted, textAlign: 'right' }}>
            {guidance.length} / {MAX_GUIDANCE}
          </div>

          {/*
            FRESH GUIDANCE, EVERY TIME. Nothing is remembered between batches and
            nothing is prefilled: the route refuses an empty field rather than
            reusing what was said last time, so a second batch is described
            again or it does not happen.
          */}
          {confirming && (
            <div style={{
              display: 'grid', gap: '8px', padding: '12px',
              border: '1px solid #DDD6FE', borderRadius: '8px', background: '#F5F3FF',
            }}>
              <strong style={{ fontSize: '12px', color: '#4C1D95' }}>
                This creates exactly {DRAFTS_PER_BATCH} drafts, pending your approval.
              </strong>
              <p style={{ margin: 0, fontSize: '12px', color: '#4C1D95', lineHeight: 1.55 }}>
                They cannot be edited by hand, and no candidate can see any of them until you
                approve. You can regenerate the whole set from new feedback, or approve them
                one at a time.
              </p>
            </div>
          )}

          {working && (
            <p role="status" style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
              Drafting {DRAFTS_PER_BATCH} reviews… this usually takes well under a minute.
              Nothing is created unless all {DRAFTS_PER_BATCH} pass their checks.
            </p>
          )}

          {phase.kind === 'failed' && (
            <p role="alert" style={{ margin: 0, fontSize: '12px', color: '#991B1B', lineHeight: 1.55 }}>
              {phase.message} Nothing was created, and your guidance is still here — press
              the button again to retry the same request.
            </p>
          )}
        </ReviewSheet>
      )}
    </>
  )
}

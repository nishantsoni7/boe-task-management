'use client'

import { useCallback, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { DRAFTS_PER_BATCH, MAX_GUIDANCE } from '@/lib/customerReviews/draftGeneration'

// The generation panel.
//
// WHO SEES IT: the caller renders it only when caps.canVerify, which is the
// RESOLVED `verify` permission and never a role. That is the weakest of the
// three checks — a screen can be lied to — and the route and the database
// function both ask again. It is here so somebody without the permission is not
// shown a button that would refuse them.
//
// WHEN IT CAN RUN: only with an empty pool. The button is disabled while any
// review is still available, and the disabled state explains why rather than
// just being grey. The rule is enforced in the route and again inside the
// database transaction; this is the courtesy, not the guarantee.
//
// WHAT IT DOES NOT DO. No editing, no regeneration of a single draft, no
// scheduling, no history, no filters. One button, one batch, one confirmation.

type Props = {
  /** How many reviews are still available. Generation needs this to be zero. */
  availableCount: number
  /** Called after a successful batch so the list can reload. */
  onGenerated: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'working' }
  | { kind: 'done'; created: number }
  | { kind: 'failed'; message: string }

export function GenerateDrafts({ availableCount, onGenerated }: Props) {
  const [guidance, setGuidance] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  // State is too slow to stop a double click, and two clicks racing is exactly
  // what the database advisory lock exists to survive. This stops the second
  // REQUEST; the database stops the second BATCH.
  const running = useRef(false)

  const poolEmpty = availableCount === 0
  const trimmed = guidance.trim()
  const canGenerate = poolEmpty && trimmed.length > 0 && phase.kind !== 'working'

  const generate = useCallback(async () => {
    if (running.current) return
    running.current = true
    setPhase({ kind: 'working' })
    try {
      const response = await fetch('/api/customer-reviews/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guidance: trimmed }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setPhase({ kind: 'failed', message: body?.error ?? 'That did not work. Please try again.' })
        return
      }
      setPhase({ kind: 'done', created: body?.created ?? DRAFTS_PER_BATCH })
      // The guidance is cleared on success, deliberately: the next batch must
      // be described afresh rather than silently repeating this one.
      setGuidance('')
      onGenerated()
    } catch {
      setPhase({ kind: 'failed', message: 'That did not work. Check your connection and try again.' })
    } finally {
      running.current = false
    }
  }, [trimmed, onGenerated])

  return (
    <section
      aria-label="Generate review drafts"
      style={{
        border: `1px solid ${colors.border}`, borderRadius: '10px',
        padding: '16px', background: '#FFFFFF', display: 'grid', gap: '12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Sparkles size={16} strokeWidth={2} style={{ color: '#5B21B6' }} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: colors.primary }}>
          Generate the next batch
        </h2>
      </div>

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
        onChange={e => { setGuidance(e.target.value); if (phase.kind !== 'idle') setPhase({ kind: 'idle' }) }}
        maxLength={MAX_GUIDANCE}
        rows={4}
        disabled={phase.kind === 'working'}
        placeholder="Describe the reviews you want drafted…"
        style={{
          width: '100%', padding: '10px 12px', borderRadius: '8px',
          border: `1px solid ${colors.border}`, fontSize: '13px', lineHeight: 1.55,
          fontFamily: 'inherit', resize: 'vertical',
        }}
      />
      <div style={{ fontSize: '11px', color: colors.muted, textAlign: 'right' }}>
        {guidance.length} / {MAX_GUIDANCE}
      </div>

      {!poolEmpty && (
        <p role="status" style={{ margin: 0, fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
          {availableCount} review{availableCount === 1 ? '' : 's'}{' '}
          {availableCount === 1 ? 'is' : 'are'} still available. The next batch can be
          generated once every one of them has been booked.
        </p>
      )}

      {phase.kind === 'confirming' ? (
        <div style={{
          display: 'grid', gap: '10px', padding: '12px',
          border: '1px solid #DDD6FE', borderRadius: '8px', background: '#F5F3FF',
        }}>
          <p style={{ margin: 0, fontSize: '12px', color: '#4C1D95', lineHeight: 1.55 }}>
            This creates {DRAFTS_PER_BATCH} new drafts from the guidance above. They
            cannot be edited afterwards, and the batch cannot be undone from here.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={generate}
              className="boe-btn boe-btn-primary"
              style={{ fontSize: '12px', padding: '7px 14px', minHeight: '36px' }}
            >
              Yes, generate {DRAFTS_PER_BATCH} reviews
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: 'idle' })}
              className="boe-btn boe-btn-ghost"
              style={{ fontSize: '12px', padding: '7px 14px', minHeight: '36px' }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setPhase({ kind: 'confirming' })}
          disabled={!canGenerate}
          className="boe-btn boe-btn-primary"
          style={{
            fontSize: '12px', padding: '8px 16px', minHeight: '38px',
            justifySelf: 'start', opacity: canGenerate ? 1 : 0.5,
            cursor: canGenerate ? 'pointer' : 'not-allowed',
          }}
        >
          Generate {DRAFTS_PER_BATCH} reviews
        </button>
      )}

      {phase.kind === 'working' && (
        <p role="status" style={{ margin: 0, fontSize: '12px', color: colors.secondary }}>
          Drafting {DRAFTS_PER_BATCH} reviews… this usually takes under a minute.
        </p>
      )}

      {phase.kind === 'done' && (
        <p role="status" style={{ margin: 0, fontSize: '12px', color: '#166534', fontWeight: 600 }}>
          {phase.created} reviews were created and are now available.
        </p>
      )}

      {phase.kind === 'failed' && (
        <p role="alert" style={{ margin: 0, fontSize: '12px', color: '#991B1B', lineHeight: 1.55 }}>
          {phase.message} Nothing was created.
        </p>
      )}
    </section>
  )
}

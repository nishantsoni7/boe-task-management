'use client'

import { useCallback, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { REVIEW_TYPES, REVIEW_TYPE_META, type ReviewType, type TestCard } from '@/lib/customerReviews/types'

// ── Correcting a draft's type, while it is still a draft ─────────────────────
//
// THE WINDOW IS pending_approval AND NOTHING ELSE, and this control does not
// merely respect that rule — it exists because of it. A batch is generated as
// eight text and four image by position, which is right for the batch and
// occasionally wrong for one review: a draft that reads as a description of how
// a room looks belongs with photographs, and one about delivery scheduling does
// not. A verifier reading twelve drafts is the person who can see that, and
// this is the only moment at which it is safe to act on it.
//
// AFTER APPROVAL IT IS REFUSED, and there is no weaker path. By then the review
// has been assigned, a candidate may have read it, and the type decides both
// what they were asked to do AND what they are paid — so changing it would
// rewrite the price of work already under way.
// set_customer_review_draft_type() refuses anything but a pending draft, and
// this component is rendered only where that is true. The database is what
// decides; this is what stops a control being drawn that would be refused.
//
// CHANGING TO TEXT CLEARS THE PROJECT GROUP, in the same statement, because a
// text review posts no photographs and a CHECK refuses a row that holds one.
// The sentence below says so before the change rather than after it.

export function ReviewTypeControl({
  supabase, card, onChanged,
}: {
  supabase: SupabaseClient
  card: Pick<TestCard, 'id' | 'status' | 'review_type' | 'image_group_id'>
  onChanged: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  const change = useCallback(async (next: ReviewType) => {
    if (inFlight.current || next === card.review_type) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const { error: rpcError } = await supabase.rpc('set_customer_review_draft_type', {
        p_card_id: card.id,
        p_review_type: next,
      })
      if (rpcError) {
        // The database's own sentence, stripped of its machine prefix. The
        // common refusal — "this review has been approved" — is exactly what
        // the verifier needs to read.
        setError(rpcError.message.replace(/^[A-Z_]+:\s*/, '') || 'That review type could not be changed.')
        return
      }
      await onChanged()
    } catch {
      setError('That review type could not be changed. Check your connection and try again.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [supabase, card.id, card.review_type, onChanged])

  // NOT PENDING MEANS NOT CHANGEABLE, and the type is shown as a plain fact
  // rather than as a control that would be refused.
  if (card.status !== 'pending_approval') {
    return (
      <p style={{ margin: 0, fontSize: '11px', color: colors.secondary, lineHeight: 1.6 }}>
        Review type: <strong>{REVIEW_TYPE_META[card.review_type].label}</strong> · fixed once the review is approved.
      </p>
    )
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
      <h4 style={{
        margin: 0, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.05em', color: colors.tertiary,
      }}>
        Review type
      </h4>

      <div role="group" aria-label="Review type" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {REVIEW_TYPES.map(type => {
          const active = card.review_type === type
          const meta = REVIEW_TYPE_META[type]
          return (
            <button
              key={type}
              type="button"
              aria-pressed={active}
              disabled={busy}
              onClick={() => { void change(type) }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '9px 14px', borderRadius: '8px', minHeight: '40px',
                fontSize: '12px', fontWeight: 600, fontFamily: 'inherit',
                border: `1px solid ${active ? meta.border : colors.border}`,
                background: active ? meta.bg : colors.base,
                color: active ? meta.color : colors.secondary,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
            >
              {busy && active ? <Loader2 size={12} className="boe-spin" /> : null}
              {meta.label}
            </button>
          )
        })}
      </div>

      <p style={{ margin: 0, fontSize: '11px', color: colors.secondary, lineHeight: 1.6 }}>
        An image review posts one project&rsquo;s photographs and earns the image reward. Changeable
        until the review is approved.
        {card.review_type === 'image' && card.image_group_id
          ? ' Changing it to text will detach the project images it currently carries.'
          : ''}
      </p>

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: '12px', color: colors.red, lineHeight: 1.6 }}>{error}</p>
      )}
    </section>
  )
}

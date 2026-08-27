'use client'

import { MessageCircle } from 'lucide-react'
import { colors } from '@/lib/tokens'
import {
  NEUTRAL_FEEDBACK_SENTENCE,
  CUSTOMER_CHOICE_SENTENCE,
} from '@/lib/customerReviews/invitation'

// The exact message the customer will receive.
//
// "Exact" is the whole point and it is load-bearing: this component renders the
// SAME STRING that buildWaMeUrl encodes into the link. It does not re-wrap it,
// re-punctuate it, truncate it, or add a signature — anything that made the
// preview prettier than the message would make it a lie, and the employee would
// be approving text that is not what gets sent.
//
// The two locked sentences are highlighted rather than hidden. An employee
// should be able to see, at a glance and without reading carefully, that the
// invitation says negative feedback is welcome and that the rating is the
// customer's own — because that is the part they cannot edit and the part that
// makes this an honest ask.

export function InvitationPreview({
  message,
  incomplete,
}: {
  message: string
  /** Shown instead of the message while a required field is still missing. */
  incomplete?: string | null
}) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px',
        fontSize: '11px', fontWeight: 700, color: colors.tertiary,
        textTransform: 'uppercase', letterSpacing: '0.05em',
      }}>
        <MessageCircle size={13} strokeWidth={2} />
        What the customer will receive
      </div>

      {incomplete ? (
        <div style={{
          padding: '14px 16px', borderRadius: '10px',
          background: colors.raised, border: `1px dashed ${colors.borderSoft}`,
          fontSize: '12px', color: colors.muted, lineHeight: 1.55,
        }}>
          {incomplete}
        </div>
      ) : (
        <div style={{
          padding: '14px 16px', borderRadius: '10px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#14532D', lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          {message}
        </div>
      )}

      <p style={{ fontSize: '11px', color: colors.muted, marginTop: '6px', lineHeight: 1.5 }}>
        You can change the greeting and the project reference. The last two sentences —
        “{NEUTRAL_FEEDBACK_SENTENCE}” and “{CUSTOMER_CHOICE_SENTENCE}” — are fixed and always sent.
      </p>
    </div>
  )
}

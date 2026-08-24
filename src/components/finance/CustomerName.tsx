'use client'

// The one shared customer-name display for Finance tables and cards.
//
// Requirement 7: at most ~20 characters including spaces in a list row, a
// clean ellipsis rather than a mid-word cut, the full name always reachable
// (a `title` tooltip here), and the full name shown in full wherever there is
// room — payment details and confirmation modals pass `truncate={false}`.
//
// THE STORED VALUE IS NEVER TOUCHED. formatCustomerName (paymentSurfaces.ts)
// only shapes what is rendered; every caller still holds the original string.

import { formatCustomerName } from '@/lib/finance/paymentSurfaces'

export function CustomerName({
  name,
  truncate = true,
  style,
}: {
  name: string | null | undefined
  /** false in payment details / confirmation modals, where the full name belongs. */
  truncate?: boolean
  style?: React.CSSProperties
}) {
  if (!truncate) {
    return <span style={style}>{(name ?? '').trim() || '—'}</span>
  }
  const { display, full, truncated } = formatCustomerName(name)
  return (
    <span
      style={{
        ...style,
        ...(truncated ? { cursor: 'default' } : null),
      }}
      title={truncated ? full : undefined}
    >
      {display}
    </span>
  )
}

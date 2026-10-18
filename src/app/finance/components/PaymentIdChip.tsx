'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * THE PAYMENT ID, AS A COPYABLE CHIP.
 *
 * The Payment ID (human_payment_id, `P-AA-0021`) is the one unique, immutable
 * handle on a payment — the database assigns it from a sequence and never
 * reuses it. The tables print it in this chip so it reads as an identifier, and
 * a small button copies it to quote in a message or search for it.
 *
 * The children are the ID text itself. The copy button stops the click from
 * reaching the row, which opens the payment's details.
 */
export function PaymentIdChip({ children }: { children: string | null | undefined }) {
  const id = (children ?? '').trim()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (!id) return <span className="boe-payment-id boe-payment-id--empty">—</span>

  async function copy(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be refused (insecure context, permissions); the ID stays
      // selectable text, so nothing is lost.
    }
  }

  return (
    <span className="boe-payment-id">
      <span className="boe-payment-id-text">{id}</span>
      <button
        type="button"
        className="boe-payment-id-copy"
        onClick={copy}
        aria-label={copied ? `Copied ${id}` : `Copy Payment ID ${id}`}
        title={copied ? 'Copied' : 'Copy Payment ID'}
      >
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
      </button>
      <span className="boe-sr-only" role="status" aria-live="polite">{copied ? 'Payment ID copied' : ''}</span>
    </span>
  )
}

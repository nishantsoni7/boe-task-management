'use client'

// ── The two fact cards of the Payment Requests popup ─────────────────────────
//
// Every fact the popup states appears ONCE. What the money is for used to be
// printed three times (Payment Against, Order Number, and a box of its own) and
// the client twice; it is one "Paid for" row now, and the client lives in the
// header. These two cards are label-and-value rows and nothing else — what is
// decided, and by whom, is the popup's own business.

import type { CSSProperties, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { DESTINATION_LOADING, paymentAgainstDisplay, type PaymentDestination } from '@/lib/finance/paymentDestination'
import { destinationCaption, destinationTag } from '@/lib/finance/paymentPopupWords'
import { destinationFromDb, paymentDestinationLabel } from '../paymentDestinations'
import { DESTINATION_ICON } from './AccountIcons'
import { PaymentModeHint } from './PaymentModeHint'

const CARD: CSSProperties = {
  margin: 0, padding: 0, border: `1px solid ${colors.border}`, borderRadius: '12px',
  overflow: 'hidden', background: colors.base,
}

const KEY: CSSProperties = {
  margin: 0, paddingTop: '2px', fontSize: '12px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

const VALUE: CSSProperties = { margin: 0, minWidth: 0, fontSize: '14px', overflowWrap: 'anywhere' }

function FactRow({ label, divided, children }: { label: string; divided?: boolean; children: ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', gap: '12px', padding: '12px 16px',
      borderTop: divided ? `1px solid ${colors.border}` : undefined,
    }}>
      <dt style={KEY}>{label}</dt>
      <dd style={VALUE}>{children}</dd>
    </div>
  )
}

const TAG: Record<'intent' | 'allocated', CSSProperties> = {
  intent:    { background: colors.blueTint,  color: colors.blue,  border: '1px solid #C3D3E6' },
  allocated: { background: colors.greenTint, color: colors.green, border: '1px solid #BCD8C8' },
}

/**
 * WHAT IT IS FOR, AND WHERE IT LANDED: the destination and the account.
 *
 * `destination` undefined means it has not been read yet; the row says so rather
 * than printing "Suspense" for a moment on every payment that names a record.
 */
export function PaymentFactsCard({ destination, paymentMode, receivedIn }: {
  destination: PaymentDestination | null | undefined
  paymentMode: string
  receivedIn: string | null
}) {
  const account = destinationFromDb(paymentMode, receivedIn)
  const Icon = account ? DESTINATION_ICON[account.iconKey] : null
  const tag = destinationTag(destination)
  const caption = destinationCaption(destination)
  return (
    <dl style={CARD} aria-label="Payment">
      <FactRow label="Paid for">
        {destination === undefined ? (
          <span style={{ color: colors.muted }}>{DESTINATION_LOADING}</span>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', alignItems: 'center' }}>
              <span style={{ fontSize: '15px', fontWeight: 600 }}>{paymentAgainstDisplay(destination)}</span>
              {tag && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 8px',
                  borderRadius: '6px', fontSize: '12px', fontWeight: 600, lineHeight: '18px', ...TAG[tag.tone],
                }}>
                  {tag.tone === 'allocated' && <Check size={12} aria-hidden="true" />}
                  {tag.label}
                </span>
              )}
            </div>
            {caption && <div style={{ fontSize: '12.5px', color: colors.muted, marginTop: '3px', lineHeight: 1.45 }}>{caption}</div>}
          </>
        )}
      </FactRow>
      <FactRow label="Account" divided>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
          {Icon && <Icon size={16} aria-hidden="true" color={colors.muted} style={{ flexShrink: 0 }} />}
          {paymentDestinationLabel(paymentMode, receivedIn)}
        </div>
        <PaymentModeHint mode={paymentMode} />
      </FactRow>
    </dl>
  )
}

/**
 * PROOF, REFERENCE AND NOTES, in one card. Three columns, three meanings
 * (the attachment, proof_note, sales_note) — grouped, never merged.
 *
 * The proof row is always drawn: for a waiting payment "no proof" is itself
 * something the verifier needs to see. The other two appear only when somebody
 * wrote something; an absent optional field is absent, not a row saying so.
 */
export function ProofNotesCard({ proof, reference, notes }: {
  proof: ReactNode
  reference: string | null
  notes: string | null
}) {
  const ref = (reference ?? '').trim()
  const note = (notes ?? '').trim()
  return (
    <dl style={CARD} aria-label="Proof and notes">
      <FactRow label="Proof">{proof}</FactRow>
      {ref && <FactRow label="Reference" divided>{ref}</FactRow>}
      {note && <FactRow label="Notes" divided><span style={{ whiteSpace: 'pre-wrap' }}>{note}</span></FactRow>}
    </dl>
  )
}

'use client'

// ── Payment Proof / Reference — one section, three fields ────────────────────
//
// WHAT THIS REPLACES. The three entry forms each asked the same three things
// under two or three separate headings — "Payment Proof / Reference" for the
// attachment and the reference, and a "Notes" or "Sales Note" or "Remark" block
// of its own below it. They are three parts of ONE question ("what backs this
// payment up?"), and splitting them left a form with a heading for every field.
//
// THE DATABASE COLUMNS ARE UNCHANGED AND STAY SEPARATE. proof_note is the
// reference; sales_note is the note to Finance; the attachment is a row in
// payment_proof_attachments. They mean different things and are stored, queried
// and displayed as different things. This is a GROUPING, not a merge.
//
// ONE HEADING, NO NESTED CARD. The section owns the heading and the frame; the
// fields inside carry small labels and no borders of their own, so three
// controls do not read as three panels.

import { useId } from 'react'
import { colors } from '@/lib/tokens'

export const PROOF_REFERENCE_TITLE = 'Payment Proof / Reference'

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '12px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.07em',
}

const FIELD_LABEL: React.CSSProperties = {
  fontSize: '12px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

const QUIET_LABEL: React.CSSProperties = { fontSize: '12px', fontWeight: 500, color: colors.muted }

/** One labelled control inside the section. No frame of its own. */
export function ProofReferenceField({ label, htmlFor, children, hint, quiet }: {
  label: string
  /** Small sentence-case label instead of bold capitals. Opt-in. */
  quiet?: boolean
  htmlFor?: string
  children: React.ReactNode
  hint?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      <label htmlFor={htmlFor} style={quiet ? QUIET_LABEL : FIELD_LABEL}>{label}</label>
      {children}
      {hint}
    </div>
  )
}

export function ProofReferenceSection({ children, quiet }: {
  children: React.ReactNode
  /** No frame and no heading of its own: the disclosure above it already names it. */
  quiet?: boolean
}) {
  const headingId = useId()
  if (quiet) {
    return (
      <div role="group" aria-label={PROOF_REFERENCE_TITLE} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {children}
      </div>
    )
  }
  return (
    <section
      aria-labelledby={headingId}
      style={{
        padding: '11px 12px', borderRadius: '8px',
        border: `1px solid ${colors.border}`, background: colors.raised,
        display: 'flex', flexDirection: 'column', gap: '9px',
      }}
    >
      <div id={headingId} style={SECTION_LABEL}>{PROOF_REFERENCE_TITLE}</div>
      {children}
    </section>
  )
}

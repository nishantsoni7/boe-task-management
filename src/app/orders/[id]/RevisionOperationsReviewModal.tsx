'use client'

// THE OPERATIONS REVIEWER'S DECISION ON A REVISED PI (20270101000000).
//
// The revision was approved by an admin and its parse is staged; nothing on
// the Order has changed. This dialog puts the PI in force beside the proposed
// one, states every commercial difference the database found, and offers the
// two answers. When the proposal differs from the Order on an amendable field
// Accept is not drawn at all: the reconciliation path is said in words instead
// — the database refuses the acceptance regardless.

import { useState } from 'react'
import { colors } from '@/lib/tokens'
import { OrderModal, OrderField, OrderModalError, OrderModalNotice } from '@/components/orders/OrderModal'
import {
  ACCEPT_REVISION_LABEL,
  ACCEPT_REVISION_NOTE,
  AMENDMENT_REQUIRED_NOTE,
  REJECT_REVISION_OPS_LABEL,
  REJECT_REVISION_OPS_NOTE,
  REVISION_DECISION_REASON_MAX_LENGTH,
  type PiVersionView,
  type RevisionDifferences,
} from '@/lib/orders/orderPiVersions'

const TEXTAREA: React.CSSProperties = {
  padding: '8px 10px', borderRadius: '7px',
  border: `1px solid ${colors.border}`, background: colors.base, color: colors.primary,
  fontSize: '13px', width: '100%', boxSizing: 'border-box', outline: 'none',
  minHeight: '64px', resize: 'vertical', fontFamily: 'inherit',
}

const money = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'
}
const shown = (field: string, v: unknown) =>
  field === 'total_value' || field === 'total_product_value' ? money(v) : v == null || v === '' ? '—' : String(v)

export function RevisionOperationsReviewModal({
  orderNumber, current, proposal, differences, saving, failure, onOpen, onClose, onDecide,
}: {
  orderNumber: string
  current: PiVersionView | null
  proposal: PiVersionView
  /** null while loading; 'unavailable' when the read was refused or failed. */
  differences: RevisionDifferences | null | 'unavailable'
  saving: boolean
  failure: string | null
  onOpen: (version: PiVersionView) => void
  onClose: () => void
  onDecide: (decision: 'accepted' | 'rejected', reason: string | null) => void
}) {
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const ready = differences !== null && differences !== 'unavailable'
  const blocking = ready ? differences.blocking : []
  const lines = ready ? differences.lines : null
  const blocked = blocking.length > 0
  const reasonText = reason.trim()

  return (
    <OrderModal
      title={`Review ${proposal.label} for operations`}
      subtitle={`Order ${orderNumber} · approved by Admin — awaiting your decision`}
      onClose={() => { if (!saving) onClose() }}
      width={680}
    >
      <OrderModalNotice>
        {current ? `${current.label} is in force and stays in force until you accept ${proposal.label}.` : 'No PI is in force yet.'}
      </OrderModalNotice>

      <div className="order-docsub-compare">
        <div>
          <h4 className="order-docsub-compare-title">In force: {current?.label ?? '—'}</h4>
          {current && (
            <>
              <p className="order-doc-note">{current.decisionLine ?? current.uploadedAt}</p>
              {current.workbookPath && (
                <button type="button" className="order-docsub-file" onClick={() => onOpen(current)}>Open {current.label}</button>
              )}
            </>
          )}
        </div>
        <div>
          <h4 className="order-docsub-compare-title">Proposed: {proposal.label}</h4>
          <p className="order-doc-note">Uploaded by {proposal.uploadedBy} · {proposal.uploadedAt}</p>
          {proposal.decisionLine && <p className="order-doc-note">{proposal.decisionLine}</p>}
          {proposal.revisionReason && <p className="order-doc-note">Reason: “{proposal.revisionReason}”</p>}
          {proposal.workbookPath && (
            <button type="button" className="order-docsub-file" onClick={() => onOpen(proposal)}>Open {proposal.label}</button>
          )}
        </div>
      </div>

      {differences === null && <p className="order-doc-loading" role="status">Comparing the two PIs…</p>}
      {differences === 'unavailable' && (
        <OrderModalError message="The differences could not be read. Refresh and try again before deciding." />
      )}

      {ready && (
        <section aria-label="What changes if you accept" className="order-revdiff">
          <h4 className="order-docsub-compare-title">Commercial data on the Order</h4>
          {blocking.length === 0 ? (
            <p className="order-doc-note">The Order already matches {proposal.label} on client, dates and values.</p>
          ) : (
            <>
              <table className="order-revdiff-table">
                <thead><tr><th>Field</th><th>Order now</th><th>{proposal.label}</th></tr></thead>
                <tbody>
                  {blocking.map(d => (
                    <tr key={d.field}><td>{d.label}</td><td>{shown(d.field, d.order_value)}</td><td><strong>{shown(d.field, d.pi_value)}</strong></td></tr>
                  ))}
                </tbody>
              </table>
              <OrderModalNotice tone="warning">{AMENDMENT_REQUIRED_NOTE}</OrderModalNotice>
            </>
          )}

          <h4 className="order-docsub-compare-title">Product lines</h4>
          {lines && lines.added.length + lines.removed.length + lines.changed.length === 0 ? (
            <p className="order-doc-note">No line changes.</p>
          ) : lines && (
            <ul className="order-revdiff-lines">
              {lines.changed.map(l => (
                <li key={`c${l.seq}`}>Line {l.seq} changes: {l.from.name} ×{l.from.qty} @ {money(l.from.rate)} → <strong>{l.to.name} ×{l.to.qty} @ {money(l.to.rate)}</strong> ({money(l.to.total)})</li>
              ))}
              {lines.added.map(l => <li key={`a${l.seq}`}>Line {l.seq} added: <strong>{l.name} ×{l.qty} @ {money(l.rate)}</strong></li>)}
              {lines.removed.map(l => <li key={`r${l.seq}`}>Line {l.seq} removed: {l.name} ×{l.qty}</li>)}
            </ul>
          )}
          {differences.billing_percentage.pi != null
            && String(differences.billing_percentage.pi) !== String(differences.billing_percentage.order ?? '') && (
            <p className="order-doc-note">Billing percentage: {String(differences.billing_percentage.order ?? '—')}% → <strong>{String(differences.billing_percentage.pi)}%</strong></p>
          )}
        </section>
      )}

      <OrderModalNotice>{blocked ? REJECT_REVISION_OPS_NOTE : `${ACCEPT_REVISION_NOTE} ${REJECT_REVISION_OPS_NOTE}`}</OrderModalNotice>
      <OrderField
        label="Reason (required to reject; optional note when accepting)"
        error={touched && reasonText === '' ? 'A reason is required to reject. Sales and the approving admin will see it.' : undefined}
      >
        <textarea value={reason} maxLength={REVISION_DECISION_REASON_MAX_LENGTH} disabled={saving} rows={3} style={TEXTAREA}
                  onChange={e => setReason(e.target.value)} />
      </OrderField>
      {failure && <OrderModalError message={failure} />}
      <div className="order-docsub-decide">
        <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="boe-btn boe-btn-ghost order-docsub-reject" disabled={saving}
                onClick={() => { setTouched(true); if (reasonText !== '') onDecide('rejected', reasonText) }}>
          {REJECT_REVISION_OPS_LABEL}
        </button>
        {!blocked && (
          <button type="button" className="boe-btn boe-btn-primary" disabled={saving || !ready}
                  onClick={() => onDecide('accepted', reasonText === '' ? null : reasonText)}>
            {saving ? 'Saving…' : ACCEPT_REVISION_LABEL(proposal.versionNumber)}
          </button>
        )}
      </div>
    </OrderModal>
  )
}

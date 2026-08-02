'use client'

// The four dialogs that change a Confirmed Order's terms, or ask to.
//
// Which one a reader gets is decided by canAmendOrderDirectly /
// canRequestOrderChange in src/lib/orders/amendments.ts — an admin amends, and
// everyone else who can see the Order proposes. Neither function is the
// authority: assert_order_amender() and the order_change_requests INSERT policy
// are (20260804000000). These decide which control is worth showing.
//
// All four are FORM modals, so all four use OrderModal, whose overlay carries no
// click handler at all. Losing a typed reason and seven re-entered figures to a
// stray click is exactly what the BOE Form Modal Dismissal Rule exists to stop.

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import {
  OrderModal, OrderField, OrderModalActions, OrderModalError, OrderModalNotice,
} from '@/components/orders/OrderModal'
import {
  AMENDABLE_FIELDS,
  LEAD_SOURCE_VALUES,
  LEAD_SOURCE_LABEL,
  initialAmendState,
  buildAmendmentPayload,
  validateAmendment,
  toProposedFields,
  amendmentErrorMessage,
  describeProposal,
  staleProposalFields,
  isLeadSource,
  type AmendableField,
  type AmendableOrder,
  type AmendFormState,
  type OrderChangeRequest,
} from '@/lib/orders/amendments'

// ── Shared plumbing ───────────────────────────────────────────────────────────

type AmendableOrderRow = AmendableOrder & { id: string; display_number: string }

/**
 * The one place a database failure becomes a sentence. Amendment codes first,
 * because each names a rule the reader can act on; anything else falls back to
 * a single honest sentence rather than echoing a Postgres error at a
 * salesperson.
 */
function failureMessage(message: string | null | undefined, fallback: string): string {
  return amendmentErrorMessage(message) ?? fallback
}

function fmtAmount(n: number | null): string {
  return n == null ? '—' : '₹' + n.toLocaleString('en-IN')
}

/**
 * The seven amendable inputs, shared by the admin's Amend form and the
 * salesperson's Request form so the two can never drift apart on what is
 * editable or how a value is entered.
 */
function AmendableFieldset({
  form, onChange, fieldError, disabled,
}: {
  form: AmendFormState
  onChange: (field: AmendableField, value: string) => void
  fieldError: { field: AmendableField; error: string } | null
  disabled: boolean
}) {
  return (
    <>
      {/* Stated once, at the top, because it is the one rule about this form
          that is not guessable from looking at it: an emptied box means "leave
          this alone", NOT "clear it". Both database doors COALESCE every value
          against the stored one, so clearing a field is not possible from here
          at all — saying so is honest, and a hint per field would be noise. */}
      <OrderModalNotice>
        Every field starts at its current value. Change only what should change —
        <strong> emptying a box leaves that value as it is</strong>, and no field can be
        cleared from this form.
      </OrderModalNotice>

      {AMENDABLE_FIELDS.map(({ key, label, kind }) => {
        const error = fieldError?.field === key ? fieldError.error : undefined
        const common = {
          disabled,
          value: form[key],
          onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
            onChange(key, e.target.value),
        }
        return (
          <OrderField key={key} label={label} error={error}>
            {kind === 'lead_source' ? (
              <select className="boe-input" style={{ width: '100%' }} {...common}>
                <option value="">—</option>
                {LEAD_SOURCE_VALUES.map(v => (
                  <option key={v} value={v}>{LEAD_SOURCE_LABEL[v]}</option>
                ))}
              </select>
            ) : kind === 'notes' ? (
              <textarea className="boe-input" rows={3} style={{ width: '100%', resize: 'vertical' }} {...common} />
            ) : (
              <input
                className="boe-input"
                type={kind === 'date' ? 'date' : 'text'}
                inputMode={kind === 'money' ? 'decimal' : undefined}
                placeholder={kind === 'money' ? '0' : undefined}
                style={{ width: '100%' }}
                {...common}
              />
            )}
          </OrderField>
        )
      })}
    </>
  )
}

/**
 * The shared state machine behind both amend forms: prefill, edit, build,
 * validate. Kept here rather than in each modal so "what counts as a change"
 * is asked once, of buildAmendmentPayload, on both paths.
 */
function useAmendForm(order: AmendableOrderRow) {
  const [form, setForm] = useState<AmendFormState>(() => initialAmendState(order))
  const [reason, setReason] = useState('')

  const built = useMemo(() => buildAmendmentPayload(order, form), [order, form])
  const fieldError = built.ok ? null : { field: built.field, error: built.error }
  const changed = built.ok ? built.changed : []
  const blocked = built.ok ? validateAmendment({ reason, changed }) : null

  const onChange = (field: AmendableField, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }))

  return { form, onChange, reason, setReason, built, fieldError, changed, blocked }
}

function ChangedSummary({ changed }: { changed: AmendableField[] }) {
  if (changed.length === 0) return null
  const labels = AMENDABLE_FIELDS.filter(f => changed.includes(f.key)).map(f => f.label)
  return (
    <OrderModalNotice>
      <strong>{labels.length} change{labels.length !== 1 ? 's' : ''}:</strong> {labels.join(', ')}
    </OrderModalNotice>
  )
}

// ── 1. Amend Order — admin, applies immediately ───────────────────────────────

export function AmendOrderModal({
  order, supabase, onClose, onDone,
}: {
  order: AmendableOrderRow
  supabase: SupabaseClient
  onClose: () => void
  onDone: () => void
}) {
  const { form, onChange, reason, setReason, built, fieldError, changed, blocked } = useAmendForm(order)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const submit = async () => {
    if (saving || !built.ok || blocked) return
    setSaving(true)
    setError('')

    const { error: rpcErr } = await supabase.rpc('amend_order', {
      p_order_id: order.id,
      p_reason:   reason.trim(),
      ...built.payload,
    })

    if (rpcErr) {
      // The modal stays open with every value intact — a failed save never
      // discards work (form-modal dismissal rule, 'submit-error').
      setSaving(false)
      setError(failureMessage(rpcErr.message, 'Could not amend this order. Refresh and try again.'))
      return
    }
    onDone()
  }

  return (
    <OrderModal
      title="Amend Order"
      subtitle={`${order.display_number} · applies immediately and is recorded in Activity`}
      onClose={onClose}
      width={520}
    >
      {error && <OrderModalError message={error} />}

      <AmendableFieldset form={form} onChange={onChange} fieldError={fieldError} disabled={saving} />

      <OrderField
        label="Reason"
        hint="Recorded permanently against the order. Say what changed and why."
      >
        <textarea
          className="boe-input"
          rows={2}
          value={reason}
          disabled={saving}
          onChange={e => setReason(e.target.value)}
          placeholder="Client added two dining chairs; value revised on call."
          style={{ width: '100%', resize: 'vertical' }}
        />
      </OrderField>

      <ChangedSummary changed={changed} />
      {blocked && <div style={{ fontSize: '11.5px', color: colors.muted }}>{blocked}</div>}

      <OrderModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel="Amend Order"
        disabled={!built.ok || !!blocked}
      />
    </OrderModal>
  )
}

// ── 2. Request a Change — everyone else, proposes ─────────────────────────────

export function RequestOrderChangeModal({
  order, supabase, onClose, onDone,
}: {
  order: AmendableOrderRow
  supabase: SupabaseClient
  onClose: () => void
  onDone: () => void
}) {
  const { form, onChange, reason, setReason, built, fieldError, changed, blocked } = useAmendForm(order)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const submit = async () => {
    if (saving || !built.ok || blocked) return
    setSaving(true)
    setError('')

    // requested_by is left to its DEFAULT auth.uid() and pinned by the INSERT
    // policy's WITH CHECK, so a request can never be filed in someone else's
    // name — sending it from here would only create a second, untrusted source
    // for a value the database already knows.
    const { error: insErr } = await supabase.from('order_change_requests').insert({
      order_id:              order.id,
      order_number_snapshot: order.display_number,
      request_type:          'edit',
      reason:                reason.trim(),
      ...toProposedFields(built.payload),
    })

    if (insErr) {
      setSaving(false)
      setError(failureMessage(
        insErr.message,
        'Could not submit this request. Refresh and try again.',
      ))
      return
    }
    onDone()
  }

  return (
    <OrderModal
      title="Request a Change"
      subtitle={`${order.display_number} · an admin has to approve this before it takes effect`}
      onClose={onClose}
      width={520}
    >
      {error && <OrderModalError message={error} />}

      <OrderModalNotice>
        Nothing changes on the order until an admin approves this request. The order
        keeps its current values in the meantime, and manufacturing continues to see them.
      </OrderModalNotice>

      <AmendableFieldset form={form} onChange={onChange} fieldError={fieldError} disabled={saving} />

      <OrderField label="Reason" hint="The admin reviewing this sees only what you write here.">
        <textarea
          className="boe-input"
          rows={2}
          value={reason}
          disabled={saving}
          onChange={e => setReason(e.target.value)}
          placeholder="Client confirmed two extra chairs on call today."
          style={{ width: '100%', resize: 'vertical' }}
        />
      </OrderField>

      <ChangedSummary changed={changed} />
      {blocked && <div style={{ fontSize: '11.5px', color: colors.muted }}>{blocked}</div>}

      <OrderModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel="Submit Request"
        disabled={!built.ok || !!blocked}
      />
    </OrderModal>
  )
}

// ── 3. Cancel — admin cancels, everyone else asks ─────────────────────────────

/**
 * The received figure is loaded rather than passed in. The caller's Payment
 * Summary is computed from the payments RLS let IT read, which for a
 * salesperson is not necessarily all of them; order_linked_payment_total is
 * SECURITY DEFINER and returns the true total. Cancelling an order while
 * misinformed about the money on it is the specific mistake this prevents.
 */
function useReceivedTotal(orderId: string, supabase: SupabaseClient) {
  const [received, setReceived] = useState<number | null>(null)
  const [failed, setFailed]     = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase.rpc('order_linked_payment_total', { p_order_id: orderId })
      if (cancelled) return
      if (error) { setFailed(true); return }
      setReceived(Number(data ?? 0))
    })()
    return () => { cancelled = true }
  }, [orderId, supabase])

  return { received, failed }
}

export function CancelOrderModal({
  order, supabase, isAdmin, onClose, onDone,
}: {
  order: AmendableOrderRow
  supabase: SupabaseClient
  isAdmin: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')
  const { received, failed } = useReceivedTotal(order.id, supabase)

  const submit = async () => {
    if (saving || reason.trim() === '') return
    setSaving(true)
    setError('')

    const { error: err } = isAdmin
      ? await supabase.rpc('cancel_order', { p_order_id: order.id, p_reason: reason.trim() })
      : await supabase.from('order_change_requests').insert({
          order_id:              order.id,
          order_number_snapshot: order.display_number,
          request_type:          'cancel',
          reason:                reason.trim(),
        })

    if (err) {
      setSaving(false)
      setError(failureMessage(
        err.message,
        isAdmin
          ? 'Could not cancel this order. Refresh and try again.'
          : 'Could not submit this request. Refresh and try again.',
      ))
      return
    }
    onDone()
  }

  return (
    <OrderModal
      title={isAdmin ? 'Cancel Order' : 'Request Cancellation'}
      subtitle={order.display_number}
      onClose={onClose}
    >
      {error && <OrderModalError message={error} />}

      {/* The money position, stated before the decision rather than after it. */}
      {failed ? (
        <OrderModalNotice tone="warning">
          The received total for this order could not be read. Check the Payment Summary
          before cancelling.
        </OrderModalNotice>
      ) : received === null ? (
        <OrderModalNotice>Checking payments received against this order…</OrderModalNotice>
      ) : received > 0 ? (
        <OrderModalNotice tone="warning">
          <strong>{fmtAmount(received)} has been received against this order.</strong>
          {' '}Cancelling does not refund it and does not change any payment. The money stays
          recorded against this order, and settling it with the client — a refund or a credit
          toward a future order — remains outstanding.
        </OrderModalNotice>
      ) : (
        <OrderModalNotice>No payments have been received against this order.</OrderModalNotice>
      )}

      {!isAdmin && (
        <OrderModalNotice>
          The order stays active until an admin approves this request.
        </OrderModalNotice>
      )}

      <OrderField label="Reason" hint="Recorded permanently against the order.">
        <textarea
          className="boe-input"
          rows={3}
          value={reason}
          disabled={saving}
          onChange={e => setReason(e.target.value)}
          placeholder="Client cancelled — shifting to a different product line."
          style={{ width: '100%', resize: 'vertical' }}
        />
      </OrderField>

      <OrderModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel={isAdmin ? 'Cancel Order' : 'Submit Request'}
        destructive={isAdmin}
        disabled={reason.trim() === ''}
      />
    </OrderModal>
  )
}

// ── 4. Review a change request — admin ────────────────────────────────────────

export function ReviewChangeRequestModal({
  request, order, supabase, onClose, onDone,
}: {
  request: OrderChangeRequest
  /** The Order as it stands NOW — used to flag a proposal the world has moved past. */
  order: AmendableOrder | null
  supabase: SupabaseClient
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote]     = useState('')
  const [saving, setSaving] = useState<'approve' | 'reject' | null>(null)
  const [error, setError]   = useState('')

  // `baseline → proposed`, so the admin reads what is being replaced rather
  // than a bare list of new values. The baseline is captured server-side at
  // request time (20260806000000).
  const lines = describeProposal(request)

  // Advisory mirror of the staleness gate in approve_order_change_request. The
  // database re-derives this under a row lock and is what actually refuses;
  // showing it here means the conflict is visible before the click.
  const stale = order ? staleProposalFields(request, order) : []

  const decide = async (decision: 'approve' | 'reject') => {
    if (saving) return
    setSaving(decision)
    setError('')

    const fn = decision === 'approve'
      ? 'approve_order_change_request'
      : 'reject_order_change_request'

    const { error: rpcErr } = await supabase.rpc(fn, {
      p_request_id:  request.id,
      p_review_note: note.trim() === '' ? null : note.trim(),
    })

    if (rpcErr) {
      setSaving(null)
      setError(failureMessage(
        rpcErr.message,
        `Could not ${decision} this request. Refresh and try again.`,
      ))
      return
    }
    onDone()
  }

  const isCancel = request.request_type === 'cancel'

  return (
    <OrderModal
      title={isCancel ? 'Review Cancellation Request' : 'Review Change Request'}
      subtitle={`${request.order_number_snapshot}${request.requested_by_name ? ` · raised by ${request.requested_by_name}` : ''}`}
      onClose={onClose}
      width={520}
    >
      {error && <OrderModalError message={error} />}

      <OrderField label="Reason given">
        <div style={{ fontSize: '13px', color: colors.primary, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
          {request.reason}
        </div>
      </OrderField>

      {isCancel ? (
        <OrderModalNotice tone="warning">
          Approving this cancels the order. Money already received stays recorded against it
          and is not refunded by this action.
        </OrderModalNotice>
      ) : (
        <>
          {stale.length > 0 && (
            <OrderModalNotice tone="warning">
              <strong>This order has changed since the request was raised</strong>
              {' '}({stale.join(', ')}). Approving would replace the newer values with what
              was proposed against the old ones, so the database will refuse it. Reject this
              request and ask for a fresh one if the change is still wanted.
            </OrderModalNotice>
          )}
          <OrderField label="Proposed">
            {lines.length === 0 ? (
              <div style={{ fontSize: '13px', color: colors.muted }}>Nothing proposed.</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', color: colors.primary, lineHeight: 1.7 }}>
                {lines.map(l => <li key={l}>{l}</li>)}
              </ul>
            )}
          </OrderField>
        </>
      )}

      <OrderField label="Review note" hint="Optional. Stored with the decision.">
        <textarea
          className="boe-input"
          rows={2}
          value={note}
          disabled={!!saving}
          onChange={e => setNote(e.target.value)}
          style={{ width: '100%', resize: 'vertical' }}
        />
      </OrderField>

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px', flexWrap: 'wrap' }}>
        <button
          onClick={() => decide('reject')}
          disabled={!!saving}
          className="boe-btn boe-btn-ghost"
          style={{ padding: '8px 18px', fontSize: '13px', color: '#C13030', borderColor: 'rgba(217,79,79,0.45)', fontWeight: 600, opacity: saving ? 0.6 : 1 }}
        >
          {saving === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          onClick={() => decide('approve')}
          disabled={!!saving}
          className="boe-btn boe-btn-primary"
          style={{ padding: '8px 18px', fontSize: '13px', opacity: saving ? 0.6 : 1 }}
        >
          {saving === 'approve' ? 'Approving…' : (isCancel ? 'Approve & Cancel Order' : 'Approve & Apply')}
        </button>
      </div>
    </OrderModal>
  )
}

// Re-exported so a caller can narrow a raw row without importing the lib twice.
export { isLeadSource }

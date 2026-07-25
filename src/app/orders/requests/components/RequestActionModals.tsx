'use client'

// ── Order Request focused action modals ───────────────────────────────────────
// Convert, Request Clarification, Reject and Delete. Each is a single,
// irreversible-ish DECISION taken on one request — a confirmation with its own
// required input — so each stays a focused modal even though the request itself
// has a dedicated detail page (/orders/requests/[id]).
//
// Changing the request's own FIELDS is not a decision of that kind and is not
// here: it happens inline on the record (see RequestInlineEdit).
//
// Every authorization rule, RPC, notification and error mapping is unchanged
// from the original implementation on the list page.

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { X } from 'lucide-react'
import { notifyOrders } from '@/lib/notify'
import { formatINR } from '@/lib/currency'
import { orderNumberErrorMessage } from '@/lib/orderNumbering'
import { StatusBadge } from './RequestPanels'
import {
  deleteRequestErrorMessage,
  fmtAmount,
  fmtDate,
  normalizeClientName,
  useEscapeToClose,
  LEAD_SOURCE_OPTIONS,
  type ConvertResult,
  type EligiblePayment,
  type OrderRequest,
} from './shared'

// ── Convert to Order modal (admin only) ───────────────────────────────────────
// Confirmation only: every value that ends up on the official Order is derived
// server-side by convert_order_request_to_order(). There is deliberately no
// Order-number input and no editing of request fields here.

export function ConvertModal({
  request,
  onClose,
  onConverted,
}: {
  request: OrderRequest
  onClose: () => void
  onConverted: (result: ConvertResult) => void
}) {
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [payments, setPayments] = useState<EligiblePayment[]>([])
  const [preLinked, setPreLinked] = useState<EligiblePayment[]>([])
  const [loadingPayments, setLoadingPayments] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const supabase = useMemo(() => createClient(), [])

  // Eligible = approved but not yet attached to any Order OR any Order
  // Request. Payments already parked on THIS request (order_request_id,
  // 20260698) are loaded separately: the conversion RPC transfers them
  // automatically, so they are shown as fixed, not selectable. Payments
  // parked on a DIFFERENT request are excluded entirely. Admin-only data:
  // this relies on the existing finance_payment_requests admin SELECT policy,
  // so no Finance visibility is widened for anyone else. The DB order
  // (payment_date desc) is the newest-first tie-break preserved within each
  // client-match group by the stable sort in `sortedPayments` below — the
  // match/mismatch grouping itself has no column to sort by server-side,
  // since it depends on comparing against this specific request's client_name.
  const loadEligiblePayments = async () => {
    setLoadingPayments(true)
    const paymentColumns = 'id, request_number, client_name, amount, payment_date, proof_note, submitted_by_user:users!submitted_by(full_name)'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapRows = (rows: any[]): EligiblePayment[] => rows.map(p => ({
      id: p.id,
      request_number: p.request_number,
      client_name: p.client_name,
      amount: p.amount,
      payment_date: p.payment_date,
      proof_note: p.proof_note ?? null,
      submitted_by_name: p.submitted_by_user?.full_name ?? undefined,
    }))

    const [eligibleRes, preLinkedRes] = await Promise.all([
      supabase
        .from('finance_payment_requests')
        .select(paymentColumns)
        .eq('status', 'approved_unlinked')
        .is('order_id', null)
        .is('order_request_id', null)
        .order('payment_date', { ascending: false }),
      supabase
        .from('finance_payment_requests')
        .select(paymentColumns)
        .eq('order_request_id', request.id)
        .order('payment_date', { ascending: false }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped = mapRows((eligibleRes.data ?? []) as any[])
    setPayments(mapped)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPreLinked(mapRows((preLinkedRes.data ?? []) as any[]))
    setLoadingPayments(false)
    return mapped
  }

  // Refresh eligibility whenever the modal opens.
  useEffect(() => {
    const onMount = () => { loadEligiblePayments() }
    onMount()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Matching-client-first, newest-first within each group. Array.prototype.sort
  // is a stable sort (guaranteed by spec since ES2019), so a comparator that
  // only looks at the match/mismatch boolean preserves the payment_date-desc
  // order the query already returned within each group — no secondary sort
  // key needed here.
  const requestClientNorm = useMemo(() => normalizeClientName(request.client_name), [request.client_name])
  const isClientMatch = (p: EligiblePayment) => normalizeClientName(p.client_name) === requestClientNorm
  const sortedPayments = useMemo(
    () => payments.slice().sort((a, b) => Number(isClientMatch(b)) - Number(isClientMatch(a))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [payments, requestClientNorm]
  )

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedList  = payments.filter(p => selected.has(p.id))
  const selectedTotal = selectedList.reduce((sum, p) => sum + Number(p.amount), 0)
  // Display/warning only — never blocks selection or conversion. Recomputed
  // from the live selection, so it appears and disappears exactly with
  // deselection, no separate state to keep in sync.
  const mismatchedSelected = selectedList.filter(p => !isClientMatch(p))

  // Escape closes; the backdrop does not (form-modal dismissal rule). Selected
  // payments are unsaved input, so an outside click must never discard them.
  useEscapeToClose(onClose, !saving)

  const handleConvert = async () => {
    if (saving) return  // guards against double-clicks; the RPC is the real guard
    setSaving(true)
    setError(null)

    const { data, error: rpcErr } = await supabase.rpc('convert_order_request_to_order', {
      p_order_request_id:    request.id,
      p_payment_request_ids: Array.from(selected),
    })

    if (rpcErr || !data) {
      // A payment we offered was linked by someone else in the meantime: re-read
      // eligibility, drop what is gone from the selection, and keep the modal
      // open. Nothing was created — the RPC rolled the whole conversion back.
      if (rpcErr?.message?.includes('STALE_PAYMENTS')) {
        const fresh = await loadEligiblePayments()
        const stillEligible = new Set(fresh.map(p => p.id))
        setSelected(prev => new Set(Array.from(prev).filter(id => stillEligible.has(id))))
        setError('One or more selected payments are no longer available. The list has been refreshed.')
      } else {
        // Order numbering failures (20260703000000) get their own plain-language
        // sentence. They are not "try again" problems — nothing about retrying
        // fixes an unconfigured or stale Order number cycle, and the generic
        // message below would send the admin round a loop that cannot succeed.
        // Like STALE_PAYMENTS, the whole conversion rolled back, so no Order was
        // created, no payment moved, and the configured number did not advance.
        const numbering = orderNumberErrorMessage(rpcErr?.message, 'conversion')
        setError(numbering ?? 'Could not convert this request. Please refresh and try again.')
      }
      setSaving(false)
      return
    }

    const result = data as ConvertResult

    // Notify the creator and the assigned user of the conversion. Any payments
    // linked during conversion are covered by this single notification.
    //
    // entityId is the ORDER id, not the request id — unlike every other Order
    // notification. The subject of this event is the Confirmed Order that now
    // exists, and getNotificationMeta routes order_converted to /orders/{id}
    // accordingly. Pointing it at the request would deep-link into the Order
    // Requests module, which no longer surfaces converted requests.
    void notifyOrders({
      event: 'order_converted',
      requestNumber: request.request_number,
      entityId: result.order_id,
      clientName: request.client_name,
      creatorId: request.requested_by,
      assignedTo: request.assigned_to,
      orderNumber: result.order_display_number,
    })

    onConverted(result)
  }

  const rowStyle: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', gap: '16px',
    padding: '7px 0', borderBottom: `1px solid ${colors.border}`, fontSize: '13px',
  }
  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }
  const valStyle: React.CSSProperties = { color: colors.primary, textAlign: 'right' }

  const carried: { label: string; value: string }[] = [
    { label: 'Client',                 value: request.client_name },
    { label: 'Requested By',           value: request.requested_by_name ?? '—' },
    { label: 'Assignee',               value: request.assigned_to_name ?? '—' },
    { label: 'Confirmation Date',      value: fmtDate(request.confirm_date) },
    { label: 'Due Date',               value: fmtDate(request.due_date) },
    { label: 'Total Product Value',    value: fmtAmount(request.total_product_value) },
    { label: 'Total Order Value',      value: fmtAmount(request.total_value) },
    { label: 'Lead Source',            value: LEAD_SOURCE_OPTIONS.find(o => o.value === request.lead_source)?.label ?? '—' },
    { label: 'Notes',                  value: request.notes?.trim() || '—' },
  ]

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes and never discards entered data. Dismiss via ×,
      // Cancel, Escape (useEscapeToClose above), or a successful submit.
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '520px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Convert to Official Order</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{
            fontSize: '12px', color: '#92400E',
            background: '#FFFBEB', border: '1px solid #FDE68A',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.5,
          }}>
            An official Order number will be allocated automatically when you confirm.
            This cannot be undone — the request will be permanently marked Converted
            and linked to the new Order.
          </div>

          <div>
            <div style={{ ...keyStyle, marginBottom: '4px' }}>Carried into the official Order</div>
            {carried.map(f => (
              <div key={f.label} style={rowStyle}>
                <span style={keyStyle}>{f.label}</span>
                <span style={valStyle}>{f.value}</span>
              </div>
            ))}
          </div>

          {/* ── Payments already linked to this request — transfer automatically ── */}
          {!loadingPayments && preLinked.length > 0 && (
            <div>
              <div style={{ ...keyStyle, marginBottom: '6px' }}>Linked Payments — Transfer Automatically</div>
              <div style={{ border: '1px solid #DDD6FE', background: '#F5F3FF', borderRadius: '6px' }}>
                {preLinked.map((p, idx) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex', justifyContent: 'space-between', gap: '10px',
                      padding: '8px 10px',
                      borderBottom: idx < preLinked.length - 1 ? '1px solid #DDD6FE' : 'none',
                    }}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#5B21B6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.request_number}
                      <span style={{ fontWeight: 500, color: colors.secondary }}> · {p.client_name} · {fmtDate(p.payment_date)}</span>
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {fmtAmount(p.amount)}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
                {preLinked.length === 1 ? 'This payment is' : 'These payments are'} linked to this
                request and will move to the new official Order automatically.
              </div>
            </div>
          )}

          {/* ── Optional: link approved payments ── */}
          <div>
            <div style={{ ...keyStyle, marginBottom: '6px' }}>
              Approved Payments Available to Link{' '}
              <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>(optional)</span>
            </div>

            {loadingPayments ? (
              <div style={{ fontSize: '12px', color: colors.muted, padding: '10px 0' }}>Loading payments…</div>
            ) : payments.length === 0 ? (
              <div style={{
                fontSize: '12px', color: colors.muted,
                border: `1px dashed ${colors.border}`, borderRadius: '6px',
                padding: '12px', textAlign: 'center',
              }}>
                No approved payments are waiting to be linked.
              </div>
            ) : (
              <>
                <div style={{
                  border: `1px solid ${colors.border}`, borderRadius: '6px',
                  maxHeight: '220px', overflowY: 'auto',
                }}>
                  {sortedPayments.map((p, idx) => {
                    const on = selected.has(p.id)
                    const matches = isClientMatch(p)
                    // A subtle divider where the matching group ends and the
                    // non-matching group begins — display only, never hides
                    // mismatched payments.
                    const prevMatches = idx > 0 ? isClientMatch(sortedPayments[idx - 1]) : matches
                    const showDivider = idx > 0 && prevMatches && !matches
                    return (
                      <div key={p.id}>
                        {showDivider && (
                          <div style={{
                            padding: '4px 10px', fontSize: '10px', fontWeight: 700,
                            color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
                            background: colors.raised, borderBottom: `1px solid ${colors.border}`,
                          }}>
                            Other clients
                          </div>
                        )}
                        <label
                          style={{
                            display: 'flex', alignItems: 'center', gap: '10px',
                            padding: '8px 10px', cursor: 'pointer',
                            borderBottom: `1px solid ${colors.border}`,
                            background: on ? 'rgba(220,31,46,0.04)' : 'transparent',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggle(p.id)}
                            disabled={saving}
                            style={{ cursor: 'pointer', flexShrink: 0 }}
                          />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
                              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p.request_number}
                                <span style={{ fontWeight: 500, color: colors.secondary }}> · {p.client_name}</span>
                                {!matches && (
                                  <span style={{
                                    marginLeft: '6px', fontSize: '10px', fontWeight: 600,
                                    color: '#9A3412', background: '#FFF7ED', border: '1px solid #FED7AA',
                                    borderRadius: '4px', padding: '1px 5px',
                                  }}>
                                    Different client
                                  </span>
                                )}
                              </span>
                              <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap', flexShrink: 0 }}>
                                {fmtAmount(p.amount)}
                              </span>
                            </span>
                            <span style={{
                              display: 'block', fontSize: '11px', color: colors.muted,
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {fmtDate(p.payment_date)}
                              {p.submitted_by_name ? ` · ${p.submitted_by_name}` : ''}
                              {p.proof_note ? ` · ${p.proof_note}` : ''}
                            </span>
                          </span>
                        </label>
                      </div>
                    )
                  })}
                </div>

                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: '12px', paddingTop: '8px',
                  color: selected.size > 0 ? colors.primary : colors.muted,
                }}>
                  <span>{selected.size} payment{selected.size !== 1 ? 's' : ''} selected</span>
                  <span style={{ fontWeight: selected.size > 0 ? 700 : 400 }}>{fmtAmount(selectedTotal)}</span>
                </div>

                {selected.size > 0 && (
                  <div style={{ fontSize: '11px', color: colors.muted, marginTop: '4px', lineHeight: 1.5 }}>
                    The selected payment{selected.size !== 1 ? 's' : ''} will be linked to the new official
                    Order and marked as received.
                  </div>
                )}

                {mismatchedSelected.length > 0 && (
                  <div style={{
                    fontSize: '11px', color: '#9A3412', background: '#FFF7ED',
                    border: '1px solid #FED7AA', borderRadius: '6px',
                    padding: '8px 10px', marginTop: '8px', lineHeight: 1.5,
                  }}>
                    <div>
                      The recorded client on this payment does not match the client on this order request.
                      Confirm that this is the correct payment before creating the order.
                    </div>
                    <ul style={{ margin: '6px 0 0', paddingLeft: '16px' }}>
                      {mismatchedSelected.map(p => (
                        <li key={p.id}>
                          {p.request_number} — payment client &ldquo;{p.client_name}&rdquo;, order request client &ldquo;{request.client_name}&rdquo;
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="button" onClick={handleConvert} disabled={saving} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Converting…' : 'Confirm & Convert'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Request Clarification modal (admin only) ──────────────────────────────────
// Deliberately separate from ConvertModal: asking a question and creating an
// official Order are different decisions and must not share a confirmation.

export function ClarifyModal({
  request,
  onClose,
  onRequested,
}: {
  request: OrderRequest
  onClose: () => void
  onRequested: (requestNumber: string) => void
}) {
  const [note,   setNote]   = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const noteValid = note.trim().length > 0

  // Escape closes; the backdrop does not (form-modal dismissal rule).
  useEscapeToClose(onClose, !saving)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !noteValid) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('request_order_request_clarification', {
      p_order_request_id:   request.id,
      p_clarification_note: note,
    })

    if (rpcErr) {
      // Modal stays open so the admin can retry or copy their note out.
      setError('Could not request clarification. The request may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Tell the creator their request needs clarification.
    void notifyOrders({
      event: 'order_clarification',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: request.client_name,
      creatorId: request.requested_by,
    })

    onRequested(request.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes and never discards entered data. Dismiss via ×,
      // Cancel, Escape (useEscapeToClose above), or a successful submit.
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '460px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Request Clarification</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.5 }}>
            The request goes back to the requester, who can update it and resubmit
            it for review. It cannot be converted until then.
          </div>

          <label style={labelStyle}>
            What needs clarifying? *
            <textarea
              autoFocus
              style={{
                padding: '7px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.raised, color: colors.primary,
                fontSize: '13px', width: '100%', boxSizing: 'border-box',
                outline: 'none', minHeight: '80px', resize: 'vertical',
                fontFamily: 'inherit',
              }}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Ask the requester what to correct or add…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !noteValid} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: (saving || !noteValid) ? 'not-allowed' : 'pointer',
              opacity: (saving || !noteValid) ? 0.5 : 1,
            }}>
              {saving ? 'Sending…' : 'Request Clarification'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Delete Request modal (admin only, unconverted only) ───────────────────────
//
// Deleting an Order Request is legitimate cleanup of something that was never
// finalized — a duplicate, a mistake, a request that will never proceed. It is
// NOT how a converted request goes away: that one produced a Confirmed Order and
// is permanent source history, which the database enforces independently of this
// modal (20260705000000).
//
// The one case that needs care is a request with approved payments parked on it.
// Those are real money sitting in Suspense, so they are DETACHED and kept, never
// deleted, and the modal says so before the admin commits. Detaching and
// deleting happen in one transaction inside admin_delete_order_request() — doing
// them as two client calls would leave a window where the payments are unparked
// but the request survives.

export function DeleteRequestModal({
  request,
  onClose,
  onDeleted,
}: {
  request: OrderRequest
  onClose: () => void
  onDeleted: (requestNumber: string, unlinkedCount: number) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [payments, setPayments] = useState<{ id: string; request_number: string; amount: number }[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from('finance_payment_requests')
        .select('id, request_number, amount')
        .eq('order_request_id', request.id)
      setPayments((data ?? []) as { id: string; request_number: string; amount: number }[])
    }
    void load()
  }, [supabase, request.id])

  const linkedCount  = payments?.length ?? 0
  const linkedAmount = (payments ?? []).reduce((sum, p) => sum + Number(p.amount ?? 0), 0)

  // Escape closes; the backdrop does not (form-modal dismissal rule).
  useEscapeToClose(onClose, !deleting)

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    setError(null)

    // Deletion is a single server-side orchestration (/api/orders/requests/delete):
    // it loads the attachment paths from the database itself (never trusting the
    // browser), removes the storage objects with the service role FIRST, and only
    // THEN runs admin_delete_order_request. If storage removal fails the request
    // is NOT deleted, so its files stay recorded and discoverable for a retry —
    // there is no window where the row is gone but objects are orphaned.
    let body: { success?: boolean; unlinked_count?: number; error?: string } | null = null
    try {
      const res = await fetch('/api/orders/requests/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, unlinkPayments: linkedCount > 0 }),
      })
      body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        setDeleting(false)
        setError(body?.error ? deleteRequestErrorMessage(body.error) : 'Could not delete this request. Please try again.')
        return
      }
    } catch {
      setDeleting(false)
      setError('Could not reach the server to delete this request. Please try again.')
      return
    }

    onDeleted(request.request_number, body?.unlinked_count ?? 0)
  }

  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes. Dismiss via ×, Cancel, or Escape (useEscapeToClose
      // above), all of which already respect the in-flight delete guard.
    >
      <div style={{
        background: colors.base, border: `1px solid ${colors.border}`,
        borderRadius: '12px', width: '100%', maxWidth: '480px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Delete Order Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={deleting}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: deleting ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Request Number</span>
              <span style={{ color: colors.primary, fontWeight: 600 }}>{request.request_number}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Status</span>
              <StatusBadge status={request.status} />
            </div>
            {linkedCount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={keyStyle}>Linked Payments</span>
                <span style={{ color: colors.primary }}>
                  {linkedCount} · {formatINR(linkedAmount)}
                </span>
              </div>
            )}
          </div>

          <div style={{
            fontSize: '12px', color: '#991B1B',
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.55,
          }}>
            <strong>Will be deleted:</strong> this Order Request and its activity history.
            {linkedCount === 0 && ' Nothing else is affected.'}
          </div>

          {linkedCount > 0 && (
            <div style={{
              fontSize: '12px', color: '#166534',
              background: '#F0FDF4', border: '1px solid #BBF7D0',
              borderRadius: '6px', padding: '9px 12px', lineHeight: 1.55,
            }}>
              <strong>Will be kept:</strong> {linkedCount} received{' '}
              {linkedCount === 1 ? 'payment' : 'payments'} totalling {formatINR(linkedAmount)}.
              {' '}They are real bank payments and are never deleted — they will be unlinked from
              this request and returned to Suspense, ready to attach elsewhere.
            </div>
          )}

          {error && (
            <div style={{
              padding: '9px 12px', borderRadius: '6px',
              background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5,
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button
              onClick={onClose}
              disabled={deleting}
              style={{
                padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: 'transparent', border: `1px solid ${colors.border}`,
                color: colors.secondary, cursor: deleting ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || payments === null}
              style={{
                padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
                background: colors.red, border: 'none', color: '#fff',
                cursor: deleting || payments === null ? 'not-allowed' : 'pointer',
                opacity: deleting || payments === null ? 0.7 : 1,
              }}
            >
              {deleting
                ? 'Deleting…'
                : linkedCount > 0 ? 'Unlink Payments and Delete' : 'Delete Request'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Reject Request modal (admin only) ──────────────────────────────────────────
// Deliberately separate from ConvertModal and ClarifyModal: rejecting is a
// terminal decision distinct from asking a question or creating an Order, and
// must not share a confirmation with either.

export function RejectModal({
  request,
  onClose,
  onRejected,
}: {
  request: OrderRequest
  onClose: () => void
  onRejected: (requestNumber: string) => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const reasonValid = reason.trim().length > 0

  // Escape closes; the backdrop does not (form-modal dismissal rule).
  useEscapeToClose(onClose, !saving)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving || !reasonValid) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('reject_order_request', {
      p_order_request_id: request.id,
      p_rejection_reason: reason,
    })

    if (rpcErr) {
      // Modal stays open so the admin can retry or copy their reason out.
      setError('Could not reject this request. It may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    // Tell the creator their request was rejected.
    void notifyOrders({
      event: 'order_rejected',
      requestNumber: request.request_number,
      entityId: request.id,
      clientName: request.client_name,
      creatorId: request.requested_by,
    })

    onRejected(request.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const keyStyle: React.CSSProperties = {
    color: colors.muted, fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      // Backdrop is inert by design (BOE form-modal dismissal rule): an outside
      // click never closes and never discards entered data. Dismiss via ×,
      // Cancel, Escape (useEscapeToClose above), or a successful submit.
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '460px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Reject Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{
            fontSize: '12px', color: '#991B1B',
            background: '#FEF2F2', border: '1px solid #FECACA',
            borderRadius: '6px', padding: '9px 12px', lineHeight: 1.5,
          }}>
            This cannot be undone. The request will be permanently marked Rejected
            and cannot be converted or resubmitted.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Request Number</span>
              <span style={{ color: colors.primary, fontWeight: 600 }}>{request.request_number}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
              <span style={keyStyle}>Client</span>
              <span style={{ color: colors.primary }}>{request.client_name}</span>
            </div>
          </div>

          <label style={labelStyle}>
            Rejection Reason *
            <textarea
              autoFocus
              style={{
                padding: '7px 10px', borderRadius: '6px',
                border: `1px solid ${colors.border}`,
                background: colors.raised, color: colors.primary,
                fontSize: '13px', width: '100%', boxSizing: 'border-box',
                outline: 'none', minHeight: '80px', resize: 'vertical',
                fontFamily: 'inherit',
              }}
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="Explain why this request is being rejected…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} disabled={saving} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary,
              cursor: saving ? 'not-allowed' : 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !reasonValid} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#991B1B', border: 'none', color: '#fff',
              cursor: (saving || !reasonValid) ? 'not-allowed' : 'pointer',
              opacity: (saving || !reasonValid) ? 0.5 : 1,
            }}>
              {saving ? 'Rejecting…' : 'Reject Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

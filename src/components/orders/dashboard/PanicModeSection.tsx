'use client'

// PANIC MODE — the Orders the owner has singled out, drawn above everything else.
//
// READ-ONLY FOR EVERYBODY BUT THE OWNER. The controls here are a courtesy: the
// database refuses designate_order_panic_mode / remove_order_panic_mode to
// anybody else and enforces the two-per-month limit itself (20270221000000), and
// the dashboard read returns `panic: null` — no data at all — to a reader who was
// not granted orders.view_panic_mode in Control Center. Nothing here decides
// access; it decides what is DRAWN.
//
// NO ANIMATION, NO FLASHING. Strong but restrained: a firm border, a tint, and
// the words "PANIC MODE" — never colour alone.

import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  PANIC_ADD_LABEL,
  PANIC_REASON_MAX,
  PANIC_TITLE,
  describePanicFailure,
  formatDate,
  panicSlotsLabel,
  plural,
  type DashboardPanic,
  type PanicRow,
} from '@/lib/orders/orderDashboardSummary'

type Candidate = { id: string; displayNumber: string; clientName: string; status: string }

type AddState =
  | { kind: 'closed' }
  | { kind: 'entering'; error: string | null; busy: boolean }
  | { kind: 'confirming'; order: Candidate; error: string | null; busy: boolean }

export function PanicModeSection({ panic, supabase, readOnlyReason, onChanged }: {
  panic: DashboardPanic | null
  supabase: SupabaseClient
  /** Set while the viewer is looking as somebody else: controls are not drawn. */
  readOnlyReason: string | null
  /** Re-reads the dashboard after a change lands. */
  onChanged: () => void
}) {
  const headingId = useId()
  const router = useRouter()
  const [add, setAdd] = useState<AddState>({ kind: 'closed' })
  const [number, setNumber] = useState('')
  const [reason, setReason] = useState('')
  const [removing, setRemoving] = useState<{ id: string; busy: boolean; error: string | null } | null>(null)

  // Nothing to say and nothing to do: no panel at all, never a large empty warning.
  if (!panic) return null
  const canManage = panic.canManage && !readOnlyReason
  if (panic.active.length === 0 && !canManage) return null

  const slotsLeft = panic.monthLimit - panic.monthUsed

  const lookUp = async () => {
    const wanted = number.trim().replace(/^#/, '')
    if (!/^\d{4}$/.test(wanted)) {
      setAdd({ kind: 'entering', error: 'Enter the four-digit order number, for example 1021.', busy: false })
      return
    }
    setAdd({ kind: 'entering', error: null, busy: true })
    const { data, error } = await supabase
      .from('orders')
      .select('id, display_number, client_name, status')
      .eq('display_number', wanted)
      .maybeSingle()
    if (error) {
      setAdd({ kind: 'entering', error: 'That order could not be looked up just now. Try again.', busy: false })
      return
    }
    if (!data) {
      setAdd({ kind: 'entering', error: `No order ${wanted} was found.`, busy: false })
      return
    }
    if (data.status === 'dispatched' || data.status === 'cancelled') {
      setAdd({ kind: 'entering', error: `Order ${wanted} is ${data.status === 'cancelled' ? 'cancelled' : 'dispatched'}, so it cannot be put in PANIC MODE.`, busy: false })
      return
    }
    setAdd({
      kind: 'confirming',
      order: { id: data.id, displayNumber: data.display_number, clientName: data.client_name ?? '', status: data.status },
      error: null, busy: false,
    })
  }

  const designate = async (order: Candidate) => {
    setAdd({ kind: 'confirming', order, error: null, busy: true })
    const { error } = await supabase.rpc('designate_order_panic_mode', {
      p_order_id: order.id,
      p_reason: reason.trim() === '' ? null : reason.trim(),
    })
    if (error) {
      setAdd({ kind: 'confirming', order, error: describePanicFailure(error), busy: false })
      return
    }
    setAdd({ kind: 'closed' }); setNumber(''); setReason('')
    onChanged()
  }

  const remove = async (row: PanicRow) => {
    setRemoving({ id: row.designationId, busy: true, error: null })
    const { error } = await supabase.rpc('remove_order_panic_mode', { p_designation_id: row.designationId, p_reason: null })
    if (error) {
      setRemoving({ id: row.designationId, busy: false, error: describePanicFailure(error) })
      return
    }
    setRemoving(null)
    onChanged()
  }

  const hasActive = panic.active.length > 0

  return (
    <section
      className={hasActive ? 'od-panic' : 'od-panic od-panic--quiet'}
      aria-labelledby={headingId}
    >
      <div className="od-panic-head">
        <h2 id={headingId} className="od-panic-title">
          {PANIC_TITLE}
          {hasActive ? <span className="od-panic-count"> · {plural(panic.active.length, 'order')}</span> : null}
        </h2>
        {canManage ? (
          <span className="od-panic-slots">{panicSlotsLabel(panic)}</span>
        ) : null}
        {canManage && add.kind === 'closed' && slotsLeft > 0 ? (
          <button type="button" className="boe-btn boe-btn-ghost od-panic-add"
            onClick={() => setAdd({ kind: 'entering', error: null, busy: false })}>
            {PANIC_ADD_LABEL}
          </button>
        ) : null}
      </div>

      {!hasActive ? <p className="od-panic-none">No order is in PANIC MODE.</p> : null}

      {hasActive ? (
        <ul className="od-panic-list">
          {panic.active.map(row => (
            <li key={row.designationId} className="od-panic-item">
              <div className="od-panic-main">
                {/* The number is text, not a second link to the same place: the one
                    action on the card is "Open order", so there is one tab stop. */}
                <span className="od-panic-order">{row.displayNumber}</span>
                <span className="od-panic-client">{row.clientName || 'Client not recorded'}</span>
              </div>
              <div className="od-panic-meta">
                <span>{row.dueDate ? `Due ${formatDate(row.dueDate)}` : 'No due date recorded'}</span>
                {row.reason ? <span className="od-panic-reason">{row.reason}</span> : null}
              </div>
              <div className="od-panic-actions">
                <Link
                  href={withReturnTo(`/orders/${row.orderId}`, '/orders')}
                  className="boe-btn boe-btn-primary"
                  aria-label={`Open order ${row.displayNumber}`}
                  prefetch={false}
                  onMouseEnter={() => router.prefetch(`/orders/${row.orderId}`)}
                  onFocus={() => router.prefetch(`/orders/${row.orderId}`)}
                >
                  Open order
                </Link>
                {canManage ? (
                  removing?.id === row.designationId ? (
                    <span className="od-inline-confirm" role="group" aria-label={`Remove PANIC MODE from order ${row.displayNumber}`}>
                      <span>Remove PANIC MODE from {row.displayNumber}?</span>
                      <button type="button" className="boe-btn boe-btn-danger" disabled={removing.busy} onClick={() => remove(row)}>
                        {removing.busy ? 'Removing…' : 'Remove'}
                      </button>
                      <button type="button" className="boe-btn boe-btn-ghost" disabled={removing.busy} onClick={() => setRemoving(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="boe-btn boe-btn-ghost"
                      aria-label={`Remove PANIC MODE from order ${row.displayNumber}`}
                      onClick={() => setRemoving({ id: row.designationId, busy: false, error: null })}>
                      Remove
                    </button>
                  )
                ) : null}
              </div>
              {removing?.id === row.designationId && removing.error ? (
                <p className="od-error-text" role="alert">{removing.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {canManage && add.kind !== 'closed' ? (
        <form
          className="od-panic-form"
          onSubmit={e => { e.preventDefault(); if (add.kind === 'entering') void lookUp(); else if (add.kind === 'confirming') void designate(add.order) }}
        >
          {add.kind === 'entering' ? (
            <>
              <label className="od-field">
                <span>Order number</span>
                <input
                  value={number} inputMode="numeric" autoComplete="off" maxLength={5} autoFocus
                  onChange={e => setNumber(e.target.value)} placeholder="1021"
                  aria-invalid={add.error ? true : undefined}
                />
              </label>
              <label className="od-field od-field--grow">
                <span>Reason (optional, {PANIC_REASON_MAX} characters)</span>
                <input value={reason} maxLength={PANIC_REASON_MAX} onChange={e => setReason(e.target.value)} placeholder="Why this order needs everyone now" />
              </label>
              <div className="od-form-actions">
                <button type="submit" className="boe-btn boe-btn-primary" disabled={add.busy}>{add.busy ? 'Looking up…' : 'Continue'}</button>
                <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setAdd({ kind: 'closed' })}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="od-confirm-text">
                Put order <strong>{add.order.displayNumber}</strong>{add.order.clientName ? ` · ${add.order.clientName}` : ''} in PANIC MODE?
                This uses one of the {panic.monthLimit} designations for this month, and removing it later does not give the slot back.
              </p>
              {reason.trim() !== '' ? <p className="od-confirm-text">Reason: {reason.trim()}</p> : null}
              <div className="od-form-actions">
                <button type="submit" className="boe-btn boe-btn-primary" disabled={add.busy}>{add.busy ? 'Saving…' : 'Confirm PANIC MODE'}</button>
                <button type="button" className="boe-btn boe-btn-ghost" disabled={add.busy} onClick={() => setAdd({ kind: 'entering', error: null, busy: false })}>Back</button>
              </div>
            </>
          )}
          {add.error ? <p className="od-error-text" role="alert">{add.error}</p> : null}
        </form>
      ) : null}
    </section>
  )
}

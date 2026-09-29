'use client'

// FACTORY FOCUS — the Orders the factory treats as its highest priority, and the
// salesperson each one recognises. Drawn directly under the page title.
//
// WHAT A READER SEES FOLLOWS ORDER VISIBILITY, decided by the database
// (orders_dashboard_summary): everybody with Orders entry sees WHICH orders, but
// only somebody who may open an Order is sent its client, note, status and id. A
// card for any other Order arrives with nothing more than its number, the
// salesperson and the month — so there is nothing here to hide, and no link to draw.
//
// SELECTING AND REMOVING ARE THE OWNER'S, AND MANUAL. The controls are a courtesy:
// the database refuses select_order_for_factory_focus / remove_order_factory_focus
// to anybody else, enforces the two-new-per-month limit itself, and requires a
// reason to remove. Nothing here hides a selection because an order was dispatched
// or cancelled, and nothing hides the section while there are active selections.
//
// When there are none, nothing is drawn at all — not a large empty panel. The
// owner's "Select an order" control lives in the page header and opens the form.

import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withReturnTo } from '@/lib/navigation/recordReturn'
import {
  FOCUS_NOTE_MAX,
  FOCUS_OUT_OF_SCOPE_NOTE,
  FOCUS_REMOVAL_REASON_MAX,
  FOCUS_TITLE,
  describeFocusFailure,
  focusSelectedLine,
  focusSlotsLabel,
  plural,
  removedNoticeLine,
  type DashboardFocus,
  type FocusCard,
} from '@/lib/orders/orderDashboardSummary'

type Candidate = { id: string; displayNumber: string; clientName: string; status: string; salesperson: string | null }

type AddState =
  | { kind: 'entering'; error: string | null; busy: boolean }
  | { kind: 'confirming'; order: Candidate; error: string | null; busy: boolean }

/** A quiet notice for the salesperson whose order was taken out of Factory Focus, with the reason. */
export function FocusRemovedNotices({ focus }: { focus: DashboardFocus }) {
  if (focus.removedForYou.length === 0) return null
  return (
    <div className="od-focus-removed" role="status">
      {focus.removedForYou.map(n => (
        <p key={`${n.displayNumber}-${n.removedAt}`}>{removedNoticeLine(n)}</p>
      ))}
    </div>
  )
}

export function FactoryFocusSection({ focus, supabase, readOnlyReason, addOpen, onCloseAdd, onChanged }: {
  focus: DashboardFocus
  supabase: SupabaseClient
  /** Set while the viewer is looking as somebody else: controls are not drawn. */
  readOnlyReason: string | null
  /** The owner's header control opened the form. */
  addOpen: boolean
  onCloseAdd: () => void
  /** Re-reads the dashboard after a change lands. */
  onChanged: () => void
}) {
  const headingId = useId()
  const router = useRouter()
  const canManage = focus.canManage && !readOnlyReason
  const [add, setAdd] = useState<AddState>({ kind: 'entering', error: null, busy: false })
  const [number, setNumber] = useState('')
  const [note, setNote] = useState('')
  const [removing, setRemoving] = useState<{ id: string; reason: string; busy: boolean; error: string | null } | null>(null)

  const showForm = canManage && addOpen
  // Nothing active and nothing being added: no section at all.
  if (focus.active.length === 0 && !showForm) return null

  const slotsLeft = focus.monthUsed === null ? 0 : focus.monthLimit - focus.monthUsed

  const closeForm = () => { setAdd({ kind: 'entering', error: null, busy: false }); setNumber(''); setNote(''); onCloseAdd() }

  const lookUp = async () => {
    const wanted = number.trim().replace(/^#/, '')
    if (!/^\d{4}$/.test(wanted)) {
      setAdd({ kind: 'entering', error: 'Enter the four-digit order number, for example 1021.', busy: false })
      return
    }
    setAdd({ kind: 'entering', error: null, busy: true })
    const { data, error } = await supabase
      .from('orders')
      .select('id, display_number, client_name, status, salesperson:users!assigned_to(full_name)')
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
      setAdd({ kind: 'entering', error: `Order ${wanted} is ${data.status === 'cancelled' ? 'cancelled' : 'dispatched'}, so it cannot be selected.`, busy: false })
      return
    }
    const sp = (data as unknown as { salesperson: { full_name: string | null } | { full_name: string | null }[] | null }).salesperson
    const salesperson = (Array.isArray(sp) ? sp[0]?.full_name : sp?.full_name) ?? null
    if (!salesperson) {
      setAdd({ kind: 'entering', error: `Order ${wanted} has no salesperson recorded, so there is nobody to recognise.`, busy: false })
      return
    }
    setAdd({
      kind: 'confirming',
      order: { id: data.id, displayNumber: data.display_number, clientName: data.client_name ?? '', status: data.status, salesperson },
      error: null, busy: false,
    })
  }

  const select = async (order: Candidate) => {
    setAdd({ kind: 'confirming', order, error: null, busy: true })
    const { error } = await supabase.rpc('select_order_for_factory_focus', {
      p_order_id: order.id,
      p_note: note.trim() === '' ? null : note.trim(),
    })
    if (error) {
      setAdd({ kind: 'confirming', order, error: describeFocusFailure(error), busy: false })
      return
    }
    closeForm()
    onChanged()
  }

  const remove = async (card: FocusCard) => {
    if (!removing || removing.id !== card.selectionId) return
    if (removing.reason.trim() === '') {
      setRemoving({ ...removing, error: 'Say why Factory Focus is being removed.' })
      return
    }
    setRemoving({ ...removing, busy: true, error: null })
    const { error } = await supabase.rpc('remove_order_factory_focus', {
      p_selection_id: card.selectionId, p_reason: removing.reason.trim(),
    })
    if (error) {
      setRemoving({ ...removing, busy: false, error: describeFocusFailure(error) })
      return
    }
    setRemoving(null)
    onChanged()
  }

  return (
    <section className="od-focus" aria-labelledby={headingId}>
      <div className="od-focus-head">
        <h2 id={headingId} className="od-focus-title">
          {FOCUS_TITLE}
          {focus.active.length > 0 ? <span className="od-focus-count"> · {plural(focus.active.length, 'order')}</span> : null}
        </h2>
        {canManage ? <span className="od-focus-slots">{focusSlotsLabel(focus)}</span> : null}
      </div>

      {focus.active.length > 0 ? (
        <ul className="od-focus-list">
          {focus.active.map(card => (
            <li key={card.selectionId} className="od-focus-item">
              <div className="od-focus-main">
                <span className="od-focus-order">{card.displayNumber}</span>
                {card.canOpen ? <span className="od-focus-client">{card.clientName ?? 'Client not recorded'}</span> : null}
              </div>
              <div className="od-focus-meta">
                <span>{focusSelectedLine(card)}</span>
                {card.canOpen && card.note ? <span className="od-focus-note">{card.note}</span> : null}
                {!card.canOpen ? <span className="od-focus-restricted">{FOCUS_OUT_OF_SCOPE_NOTE}</span> : null}
              </div>
              <div className="od-focus-actions">
                {card.canOpen && card.orderId ? (
                  <Link
                    href={withReturnTo(`/orders/${card.orderId}`, '/orders')}
                    className="boe-btn boe-btn-primary"
                    aria-label={`Open order ${card.displayNumber}`}
                    prefetch={false}
                    onMouseEnter={() => router.prefetch(`/orders/${card.orderId}`)}
                    onFocus={() => router.prefetch(`/orders/${card.orderId}`)}
                  >
                    Open order
                  </Link>
                ) : null}
                {canManage && removing?.id !== card.selectionId ? (
                  <button type="button" className="boe-btn boe-btn-ghost"
                    aria-label={`Remove order ${card.displayNumber} from Factory Focus`}
                    onClick={() => setRemoving({ id: card.selectionId, reason: '', busy: false, error: null })}>
                    Remove
                  </button>
                ) : null}
              </div>
              {canManage && removing?.id === card.selectionId ? (
                <form className="od-inline-form" onSubmit={e => { e.preventDefault(); void remove(card) }}>
                  <label className="od-field od-field--grow">
                    <span>Why is it being removed? The salesperson will see this.</span>
                    <input value={removing.reason} maxLength={FOCUS_REMOVAL_REASON_MAX} autoFocus required
                      onChange={e => setRemoving({ ...removing, reason: e.target.value })} />
                  </label>
                  <div className="od-form-actions">
                    <button type="submit" className="boe-btn boe-btn-danger" disabled={removing.busy}>
                      {removing.busy ? 'Removing…' : 'Remove'}
                    </button>
                    <button type="button" className="boe-btn boe-btn-ghost" disabled={removing.busy} onClick={() => setRemoving(null)}>
                      Keep
                    </button>
                  </div>
                  {removing.error ? <p className="od-error-text" role="alert">{removing.error}</p> : null}
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {showForm ? (
        <form
          className="od-focus-form"
          onSubmit={e => { e.preventDefault(); if (add.kind === 'entering') void lookUp(); else void select(add.order) }}
        >
          {slotsLeft <= 0 ? (
            <p className="od-confirm-text">{focusSlotsLabel(focus)}. A new month allows two more.</p>
          ) : add.kind === 'entering' ? (
            <>
              <label className="od-field">
                <span>Order number</span>
                <input value={number} inputMode="numeric" autoComplete="off" maxLength={5} autoFocus
                  onChange={e => setNumber(e.target.value)} placeholder="1021"
                  aria-invalid={add.error ? true : undefined} />
              </label>
              <label className="od-field od-field--grow">
                <span>Note (optional, {FOCUS_NOTE_MAX} characters)</span>
                <input value={note} maxLength={FOCUS_NOTE_MAX} onChange={e => setNote(e.target.value)} placeholder="What the salesperson is being recognised for" />
              </label>
              <div className="od-form-actions">
                <button type="submit" className="boe-btn boe-btn-primary" disabled={add.busy}>{add.busy ? 'Looking up…' : 'Continue'}</button>
                <button type="button" className="boe-btn boe-btn-ghost" onClick={closeForm}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="od-confirm-text">
                Select order <strong>{add.order.displayNumber}</strong>{add.order.clientName ? ` · ${add.order.clientName}` : ''} for Factory Focus,
                recognising <strong>{add.order.salesperson}</strong>? It becomes the factory&apos;s highest priority and uses one of the month&apos;s
                {' '}{focus.monthLimit} selections; removing it later does not give the selection back.
              </p>
              {note.trim() !== '' ? <p className="od-confirm-text">Note: {note.trim()}</p> : null}
              <div className="od-form-actions">
                <button type="submit" className="boe-btn boe-btn-primary" disabled={add.busy}>{add.busy ? 'Saving…' : 'Confirm Factory Focus'}</button>
                <button type="button" className="boe-btn boe-btn-ghost" disabled={add.busy} onClick={() => setAdd({ kind: 'entering', error: null, busy: false })}>Back</button>
              </div>
            </>
          )}
          {add.error ? <p className="od-error-text" role="alert">{add.error}</p> : null}
          {slotsLeft <= 0 ? (
            <div className="od-form-actions"><button type="button" className="boe-btn boe-btn-ghost" onClick={closeForm}>Close</button></div>
          ) : null}
        </form>
      ) : null}
    </section>
  )
}

'use client'

// The administrator's dialog for giving a Confirmed Order a different number.
//
// A FORM modal, so it uses OrderModal, whose overlay carries no click handler:
// a typed number is not lost to a stray click.
//
// Nothing here is the gate. change_confirmed_order_number() (20270502000000)
// checks the role and the number again, under the cycle lock, and is what says
// whether the old number goes to the next Order.

import { useState } from 'react'
import {
  OrderModal, OrderField, OrderModalActions, OrderModalError, OrderModalNotice,
} from '@/components/orders/OrderModal'
import { displayOrderNumber } from '@/lib/orderNumbering'
import {
  CHANGE_ORDER_NUMBER_BUSY_LABEL,
  CHANGE_ORDER_NUMBER_CONFIRM_LABEL,
  CHANGE_ORDER_NUMBER_DIALOG_TITLE,
  CHANGE_ORDER_NUMBER_NOTE,
  describeOrderNumberChange,
  describeOrderNumberChangeFailure,
  normalizeNewOrderNumber,
  type OrderNumberChangeResult,
} from '@/lib/orders/orderNumberChange'

export function ChangeOrderNumberModal({
  orderId, displayNumber, onClose, onChanged,
}: {
  orderId: string
  displayNumber: string
  onClose: () => void
  /** The number changed: the page reloads the Order behind the dialog. */
  onChanged: () => void
}) {
  const [typed, setTyped] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<string | null>(null)

  const normalized = normalizeNewOrderNumber(typed)
  const same = normalized !== null && normalized === displayNumber.trim()

  const submit = async () => {
    if (saving || normalized === null || same) return
    setSaving(true)
    setError('')
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/number`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: typed.trim() }),
      })
      const body = await response.json().catch(() => null) as
        ({ ok?: boolean; code?: unknown } & Partial<OrderNumberChangeResult>) | null
      if (!response.ok || body?.ok !== true || typeof body.displayNumber !== 'string') {
        setError(describeOrderNumberChangeFailure(body?.code).message)
        setSaving(false)
        return
      }
      setDone(describeOrderNumberChange({
        previousNumber: typeof body.previousNumber === 'string' ? body.previousNumber : displayNumber,
        displayNumber: body.displayNumber,
        nextNumber: typeof body.nextNumber === 'string' ? body.nextNumber : null,
        oldNumberIsNext: body.oldNumberIsNext === true,
      }))
      setSaving(false)
      onChanged()
    } catch {
      setError(describeOrderNumberChangeFailure('FAILED').message)
      setSaving(false)
    }
  }

  const current = displayOrderNumber(displayNumber)

  // AFTER THE CHANGE the dialog says what happened to the old number, once.
  if (done) {
    return (
      <OrderModal title={CHANGE_ORDER_NUMBER_DIALOG_TITLE} onClose={onClose}>
        <OrderModalNotice>{done}</OrderModalNotice>
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '4px' }}>
          <button onClick={onClose} className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
            Done
          </button>
        </div>
      </OrderModal>
    )
  }

  const fieldError = typed.trim() === '' ? undefined
    : normalized === null ? describeOrderNumberChangeFailure('INVALID').message
    : same ? describeOrderNumberChangeFailure('SAME').message
    : undefined

  return (
    <OrderModal title={CHANGE_ORDER_NUMBER_DIALOG_TITLE} subtitle={`Order ${current}`} onClose={onClose}>
      {error && <OrderModalError message={error} />}

      <OrderModalNotice>{CHANGE_ORDER_NUMBER_NOTE}</OrderModalNotice>

      <OrderField label="New Order number" hint={`Now ${current}`} error={fieldError}>
        <input
          className="boe-input"
          value={typed}
          disabled={saving}
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          onChange={e => setTyped(e.target.value)}
          placeholder="e.g. 508"
          style={{ width: '100%' }}
        />
      </OrderField>

      <OrderModalActions
        onClose={onClose}
        onSave={submit}
        saving={saving}
        saveLabel={saving ? CHANGE_ORDER_NUMBER_BUSY_LABEL : CHANGE_ORDER_NUMBER_CONFIRM_LABEL}
        disabled={normalized === null || same}
      />
    </OrderModal>
  )
}

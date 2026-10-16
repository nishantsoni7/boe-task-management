'use client'

// The administrator's confirmation before an Order is permanently deleted.
//
// A FORM modal, so it uses OrderModal, whose overlay carries no click handler:
// a typed confirmation is not lost to a stray click.
//
// THE ORDER NUMBER IS TYPED, not clicked through. The button stays disabled
// until what was typed is this Order's own number, and the database checks it
// again, so a different Order cannot be deleted by a stale tab.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  OrderModal, OrderField, OrderModalActions, OrderModalError, OrderModalNotice,
} from '@/components/orders/OrderModal'
import {
  DELETE_ORDER_BUSY_LABEL,
  DELETE_ORDER_CONFIRM_LABEL,
  DELETE_ORDER_DIALOG_TITLE,
  DELETE_ORDER_PAYMENTS_NOTE,
  DELETE_ORDER_WARNING,
  describeOrderDeletionFailure,
  orderDeletionConfirmationMatches,
} from '@/lib/orders/orderDeletion'

export function DeleteOrderModal({
  orderId, displayNumber, onClose,
}: {
  orderId: string
  displayNumber: string
  onClose: () => void
}) {
  const router = useRouter()
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState(false)

  const matches = orderDeletionConfirmationMatches(typed, displayNumber)

  const submit = async () => {
    if (deleting || !matches) return
    setDeleting(true)
    setError('')
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: typed.trim() }),
      })
      const body = await response.json().catch(() => null) as { ok?: boolean; code?: unknown } | null
      if (!response.ok || body?.ok !== true) {
        const failure = describeOrderDeletionFailure(body?.code)
        setError(failure.message)
        setBlocked(failure.blocked)
        setDeleting(false)
        // Already gone: leave the dead page rather than offer more actions on it.
        if (failure.code === 'MISSING') router.replace('/orders/all')
        return
      }
      router.replace('/orders/all')
    } catch {
      setError(describeOrderDeletionFailure('FAILED').message)
      setDeleting(false)
    }
  }

  return (
    <OrderModal title={DELETE_ORDER_DIALOG_TITLE} subtitle={`Order ${displayNumber}`} onClose={onClose}>
      {error && <OrderModalError message={error} />}

      <OrderModalNotice tone="warning">{DELETE_ORDER_WARNING}</OrderModalNotice>
      <OrderModalNotice>{DELETE_ORDER_PAYMENTS_NOTE}</OrderModalNotice>

      <OrderField label={`Type ${displayNumber} to confirm`}>
        <input
          className="boe-input"
          value={typed}
          disabled={deleting || blocked}
          autoComplete="off"
          onChange={e => setTyped(e.target.value)}
          placeholder={displayNumber}
          style={{ width: '100%' }}
        />
      </OrderField>

      <OrderModalActions
        onClose={onClose}
        onSave={submit}
        saving={deleting}
        saveLabel={deleting ? DELETE_ORDER_BUSY_LABEL : DELETE_ORDER_CONFIRM_LABEL}
        destructive
        disabled={!matches || blocked}
      />
    </OrderModal>
  )
}

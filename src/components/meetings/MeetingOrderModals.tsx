'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { colors } from '@/lib/tokens'
import { MeetingModal, MeetingField, MeetingModalActions, MeetingModalError } from './MeetingModal'
import { meetingErrorMessage, logMeetingFailure } from '@/lib/meetings/errors'
import {
  ORDER_POSITIONS, ORDER_POSITION_META, ITEM_STATUSES, ITEM_STATUS_META,
  formatMeetingDate, type MeetingOrder, type MeetingType, type OrderPosition,
  type ItemStatus,
} from '@/lib/meetings/types'

// The three order-level dialogs: bring an order into the review, record its
// overall position, and add a SKU line to it.
//
// They share a file because they share a subject and are read together; each is
// small, and splitting them would mean three files that must be kept in step on
// the same order shape.

/** Department options, read from Control Center's own list. */
export function useDepartments(supabase: SupabaseClient): { key: string; name: string }[] {
  const [departments, setDepartments] = useState<{ key: string; name: string }[]>([])
  useEffect(() => {
    let active = true
    supabase
      .from('departments')
      .select('department_key, department_name, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data }) => {
        if (!active || !data) return
        setDepartments(
          (data as { department_key: string; department_name: string }[])
            .map(d => ({ key: d.department_key, name: d.department_name })),
        )
      })
    return () => { active = false }
  }, [supabase])
  return departments
}

// ─── Add an order to the review ───────────────────────────────────────────────

export function AddOrderModal({
  supabase, meetingId, meetingType, onClose, onSaved,
}: {
  supabase: SupabaseClient
  meetingId: string
  meetingType: MeetingType
  onClose: () => void
  onSaved: (orderId: string) => void
}) {
  const [orderNumber, setOrderNumber] = useState('')
  const [customer, setCustomer]       = useState('')
  const [dispatch, setDispatch]       = useState('')
  const [remarks, setRemarks]         = useState('')
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState<string | null>(null)

  const save = async () => {
    if (orderNumber.trim() === '' || saving) return
    setSaving(true)
    setError(null)

    const { data, error: rpcErr } = await supabase.rpc('add_meeting_order', {
      p_meeting_id: meetingId,
      p_order_number: orderNumber.trim(),
      // Defaults to the meeting's own type. An order discussed in a Repair
      // Order Review is a repair order; making that a field would be a question
      // with one obvious answer.
      p_order_type: meetingType,
      p_customer_name: customer.trim() || null,
      p_expected_dispatch_date: dispatch || null,
      p_remarks: remarks.trim() || null,
    })

    if (rpcErr) {
      logMeetingFailure('add-order', rpcErr)
      setError(meetingErrorMessage('add-order', rpcErr))
      setSaving(false)
      return
    }

    setSaving(false)
    onSaved((data as { id: string }).id)
  }

  return (
    <MeetingModal
      title="Add Order to Review"
      subtitle="Only the order or repair reference is required."
      onClose={onClose}
      width={460}
    >
      {error && <MeetingModalError message={error} />}

      <MeetingField label="Order / Repair Reference">
        <input
          className="boe-input"
          autoFocus
          value={orderNumber}
          onChange={e => setOrderNumber(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save() }}
          placeholder="e.g. 2041"
        />
      </MeetingField>

      <MeetingField label="Customer" optional>
        <input className="boe-input" value={customer} onChange={e => setCustomer(e.target.value)} />
      </MeetingField>

      <MeetingField label="Expected Dispatch / Target Date" optional>
        <input
          type="date"
          className="boe-input"
          value={dispatch}
          onChange={e => setDispatch(e.target.value)}
          style={{ colorScheme: 'light' }}
        />
      </MeetingField>

      <MeetingField label="Order Remarks" optional>
        <textarea
          className="boe-input"
          rows={2}
          value={remarks}
          onChange={e => setRemarks(e.target.value)}
          style={{ resize: 'none' }}
        />
      </MeetingField>

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={orderNumber.trim() === ''}
        saveLabel="Add Order"
      />
    </MeetingModal>
  )
}

// ─── Order-level update ───────────────────────────────────────────────────────

export function OrderUpdateModal({
  supabase, order, onClose, onSaved,
}: {
  supabase: SupabaseClient
  order: MeetingOrder
  onClose: () => void
  onSaved: () => void
}) {
  const [update, setUpdate]     = useState('')
  const [position, setPosition] = useState<OrderPosition>(order.position)
  const [review, setReview]     = useState(order.next_review_date ?? '')
  const [customer, setCustomer] = useState(order.customer_name ?? '')
  const [dispatch, setDispatch] = useState(order.expected_dispatch_date ?? '')
  const [remarks, setRemarks]   = useState(order.remarks ?? '')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const dirty = useMemo(() => (
    update.trim() !== ''
    || position !== order.position
    || review !== (order.next_review_date ?? '')
    || customer.trim() !== (order.customer_name ?? '')
    || dispatch !== (order.expected_dispatch_date ?? '')
    || remarks.trim() !== (order.remarks ?? '')
  ), [update, position, review, customer, dispatch, remarks, order])

  const save = async () => {
    if (saving || !dirty) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('save_meeting_order_update', {
      p_order_id: order.id,
      p_latest_update: update.trim() || null,
      p_position: position !== order.position ? position : null,
      p_next_review_date: review || null,
      p_remarks: remarks.trim() || null,
      p_customer_name: customer.trim() || null,
      p_expected_dispatch_date: dispatch || null,
      p_clear_next_review: (order.next_review_date ?? '') !== '' && review === '',
    })

    if (rpcErr) {
      logMeetingFailure('update-order', rpcErr)
      setError(meetingErrorMessage('update-order', rpcErr))
      setSaving(false)
      return
    }

    setSaving(false)
    onSaved()
  }

  return (
    <MeetingModal
      title={`Order ${order.order_number}`}
      subtitle="Overall position for the whole order — SKU lines are updated individually."
      onClose={onClose}
      width={500}
    >
      {error && <MeetingModalError message={error} />}

      {order.latest_update && (
        <div style={{
          padding: '10px 12px', borderRadius: '8px',
          background: colors.raised, border: `1px solid ${colors.border}`,
        }}>
          <div style={{
            fontSize: '10px', fontWeight: 700, color: colors.muted,
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
          }}>
            Previous overall update
          </div>
          <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.45 }}>
            {order.latest_update}
          </div>
        </div>
      )}

      <MeetingField label="Overall Position" group>
        <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          {ORDER_POSITIONS.map(p => {
            const meta = ORDER_POSITION_META[p]
            const selected = position === p
            return (
              <button
                key={p}
                onClick={() => setPosition(p)}
                aria-pressed={selected}
                style={{
                  flex: '1 1 90px', padding: '7px 6px', borderRadius: '8px', cursor: 'pointer',
                  fontSize: '12px', fontWeight: selected ? 700 : 500,
                  border: `1px solid ${selected ? meta.color : colors.border}`,
                  background: selected ? meta.bg : 'transparent',
                  color: selected ? meta.color : colors.secondary,
                  transition: 'all 0.12s',
                }}
              >
                {meta.label}
              </button>
            )
          })}
        </div>
      </MeetingField>

      <MeetingField label="Latest Overall Update" optional>
        <textarea
          className="boe-input"
          rows={3}
          autoFocus
          value={update}
          onChange={e => setUpdate(e.target.value)}
          placeholder="Where does this order stand as a whole?"
          style={{ resize: 'none' }}
        />
      </MeetingField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="Next Review" optional>
          <input
            type="date"
            className="boe-input"
            value={review}
            onChange={e => setReview(e.target.value)}
            style={{ colorScheme: 'light' }}
          />
        </MeetingField>
        <MeetingField label="Expected Dispatch" optional>
          <input
            type="date"
            className="boe-input"
            value={dispatch}
            onChange={e => setDispatch(e.target.value)}
            style={{ colorScheme: 'light' }}
          />
        </MeetingField>
      </div>

      <MeetingField label="Customer" optional>
        <input className="boe-input" value={customer} onChange={e => setCustomer(e.target.value)} />
      </MeetingField>

      <MeetingField label="Order Remarks" optional>
        <textarea
          className="boe-input"
          rows={2}
          value={remarks}
          onChange={e => setRemarks(e.target.value)}
          style={{ resize: 'none' }}
        />
      </MeetingField>

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={!dirty}
        saveLabel="Save Update"
      />
    </MeetingModal>
  )
}

// ─── Add a SKU line ───────────────────────────────────────────────────────────

export function AddItemModal({
  supabase, order, onClose, onSaved,
}: {
  supabase: SupabaseClient
  order: MeetingOrder
  onClose: () => void
  onSaved: () => void
}) {
  const departments = useDepartments(supabase)

  const [sku, setSku]           = useState('')
  const [productName, setName]  = useState('')
  const [quantity, setQuantity] = useState('')
  const [stage, setStage]       = useState('')
  const [department, setDept]   = useState('')
  const [update, setUpdate]     = useState('')
  const [issue, setIssue]       = useState('')
  const [status, setStatus]     = useState<ItemStatus>('open')
  const [followUp, setFollowUp] = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const canSubmit = sku.trim() !== '' && productName.trim() !== ''

  const save = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    setError(null)

    const qty = quantity.trim() === '' ? null : Number(quantity)
    if (qty !== null && (!Number.isFinite(qty) || qty < 0)) {
      setError('Quantity must be a number.')
      setSaving(false)
      return
    }

    const { error: rpcErr } = await supabase.rpc('add_meeting_order_item', {
      p_order_id: order.id,
      p_sku: sku.trim(),
      p_product_name: productName.trim(),
      p_quantity: qty,
      p_current_stage: stage.trim() || null,
      p_responsible_department: department || null,
      p_issue: issue.trim() || null,
      p_latest_update: update.trim() || null,
      p_status: status,
      p_next_follow_up_date: status === 'resolved' ? null : (followUp || null),
    })

    if (rpcErr) {
      logMeetingFailure('add-item', rpcErr)
      setError(meetingErrorMessage('add-item', rpcErr))
      setSaving(false)
      return
    }

    setSaving(false)
    onSaved()
  }

  return (
    <MeetingModal
      title="Add Product"
      subtitle={`Order ${order.order_number}${order.customer_name ? ` · ${order.customer_name}` : ''}`}
      onClose={onClose}
      width={500}
    >
      {error && <MeetingModalError message={error} />}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="SKU / Reference">
          <input className="boe-input" autoFocus value={sku} onChange={e => setSku(e.target.value)} />
        </MeetingField>
        <MeetingField label="Quantity" optional>
          <input
            className="boe-input"
            inputMode="decimal"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
          />
        </MeetingField>
      </div>

      <MeetingField label="Product Name">
        <input className="boe-input" value={productName} onChange={e => setName(e.target.value)} />
      </MeetingField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="Current Stage" optional>
          <input
            className="boe-input"
            value={stage}
            onChange={e => setStage(e.target.value)}
            placeholder="e.g. Polishing"
          />
        </MeetingField>
        <MeetingField label="Responsible Department" optional>
          <select className="boe-input" value={department} onChange={e => setDept(e.target.value)}>
            <option value="">Not set</option>
            {departments.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
          </select>
        </MeetingField>
      </div>

      <MeetingField label="Latest Update" optional>
        <textarea
          className="boe-input"
          rows={2}
          value={update}
          onChange={e => setUpdate(e.target.value)}
          style={{ resize: 'none' }}
        />
      </MeetingField>

      <MeetingField label="Issue or Blocker" optional>
        <input className="boe-input" value={issue} onChange={e => setIssue(e.target.value)} />
      </MeetingField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        <MeetingField label="Status" group>
          <div style={{ display: 'flex', gap: '5px' }}>
            {ITEM_STATUSES.map(s => {
              const meta = ITEM_STATUS_META[s]
              const selected = status === s
              return (
                <button
                  key={s}
                  onClick={() => setStatus(s)}
                  aria-pressed={selected}
                  style={{
                    flex: 1, padding: '7px 4px', borderRadius: '6px', cursor: 'pointer',
                    fontSize: '12px', fontWeight: selected ? 700 : 500,
                    border: `1px solid ${selected ? meta.color : colors.border}`,
                    background: selected ? meta.bg : 'transparent',
                    color: selected ? meta.color : colors.secondary,
                  }}
                >
                  {meta.label}
                </button>
              )
            })}
          </div>
        </MeetingField>
        <MeetingField
          label="Next Follow-up"
          optional
          hint={status === 'resolved' ? 'Not needed for a resolved item.' : undefined}
        >
          <input
            type="date"
            className="boe-input"
            value={status === 'resolved' ? '' : followUp}
            disabled={status === 'resolved'}
            onChange={e => setFollowUp(e.target.value)}
            style={{ colorScheme: 'light', opacity: status === 'resolved' ? 0.5 : 1 }}
          />
        </MeetingField>
      </div>

      <MeetingModalActions
        onClose={onClose}
        onSave={save}
        saving={saving}
        disabled={!canSubmit}
        saveLabel="Add Product"
      />
    </MeetingModal>
  )
}

// ─── Remove an order ──────────────────────────────────────────────────────────

export function RemoveOrderModal({
  supabase, order, onClose, onRemoved,
}: {
  supabase: SupabaseClient
  order: MeetingOrder
  onClose: () => void
  onRemoved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const remove = async () => {
    if (saving) return
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('remove_meeting_order', { p_order_id: order.id })
    if (rpcErr) {
      logMeetingFailure('remove-order', rpcErr)
      setError(meetingErrorMessage('remove-order', rpcErr))
      setSaving(false)
      return
    }

    setSaving(false)
    onRemoved()
  }

  return (
    <MeetingModal
      title={`Remove order ${order.order_number}?`}
      subtitle="For a reference entered by mistake."
      onClose={onClose}
      width={420}
    >
      {error && <MeetingModalError message={error} />}
      <div style={{ fontSize: '12.5px', color: colors.secondary, lineHeight: 1.5 }}>
        This removes the order and its product lines from this meeting. It is refused once any
        update has been recorded against it or a task has been created from it — a discussion
        that happened is not erasable.
        {order.expected_dispatch_date && (
          <div style={{ marginTop: '8px', color: colors.muted }}>
            Expected dispatch: {formatMeetingDate(order.expected_dispatch_date)}
          </div>
        )}
      </div>
      <MeetingModalActions
        onClose={onClose}
        onSave={remove}
        saving={saving}
        saveLabel="Remove Order"
        destructive
      />
    </MeetingModal>
  )
}

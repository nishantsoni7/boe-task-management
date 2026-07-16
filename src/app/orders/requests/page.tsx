'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import type { UserProfile } from '@/lib/types'
import { X, CheckCircle2 } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

type OrderRequest = {
  id: string
  request_number: string
  client_name: string
  requested_by: string | null
  requested_by_name?: string
  assigned_to: string | null
  assigned_to_name?: string
  confirm_date: string | null
  due_date: string | null
  total_value: number | null
  lead_source: string | null
  notes: string | null
  status: string
  created_by: string | null
  clarification_note: string | null
  rejection_reason: string | null
  created_at: string
  converted_order_id: string | null
  converted_order_number?: string
}

// The project's existing requester rule (order_requests_requester_select /
// _insert, and resubmit_order_request): the requester is created_by OR
// requested_by. assigned_to is deliberately NOT an owner.
function isPermittedRequester(r: OrderRequest, userId: string): boolean {
  return r.created_by === userId || r.requested_by === userId
}

// Structured result returned by convert_order_request_to_order().
type ConvertResult = {
  order_request_id: string
  request_number: string
  order_id: string
  order_display_number: string
  converted_at: string
  linked_payment_count: number
  linked_payment_request_ids: string[]
}

// An approved Finance payment with no Order link yet — the only kind that may
// be linked during conversion. Identifying fields only: no proof attachments,
// no storage paths.
type EligiblePayment = {
  id: string
  request_number: string
  amount: number
  payment_date: string
  proof_note: string | null
  submitted_by_name?: string
}

type UserOption = { id: string; full_name: string }

type StatusFilter = 'active' | 'needs_clarification' | 'rejected' | 'converted' | 'all'

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  submitted:           { label: 'Submitted',           bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  needs_clarification: { label: 'Needs Clarification',  bg: '#FFF7ED', color: '#9A3412', border: '#FED7AA' },
  rejected:            { label: 'Rejected',             bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
  converted:           { label: 'Converted',            bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
}

// Phase 1: "Active" means submitted (awaiting review).
const STATUS_TABS: { key: StatusFilter; label: string; match: (s: string) => boolean }[] = [
  { key: 'active',              label: 'Active',              match: s => s === 'submitted' },
  { key: 'needs_clarification', label: 'Needs Clarification', match: s => s === 'needs_clarification' },
  { key: 'rejected',            label: 'Rejected',            match: s => s === 'rejected' },
  { key: 'converted',           label: 'Converted',           match: s => s === 'converted' },
  { key: 'all',                 label: 'All',                 match: () => true },
]

const LEAD_SOURCE_OPTIONS = [
  { value: 'reference',       label: 'Reference' },
  { value: 'repeat_customer', label: 'Repeat Customer' },
  { value: 'whatsapp',        label: 'WhatsApp' },
  { value: 'instagram',       label: 'Instagram' },
  { value: 'website',         label: 'Website' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAmount(n: number | null) {
  if (n == null) return '—'
  return '₹' + n.toLocaleString('en-IN')
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '5px',
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.border}`,
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  )
}

// ── Submit Order Request modal ────────────────────────────────────────────────

type RequestForm = {
  client_name: string
  requested_by: string
  assigned_to: string
  confirm_date: string
  due_date: string
  total_value: string
  lead_source: string
  notes: string
}

const EMPTY_FORM: RequestForm = {
  client_name: '',
  requested_by: '',
  assigned_to: '',
  confirm_date: '',
  due_date: '',
  total_value: '',
  lead_source: '',
  notes: '',
}

function SubmitRequestModal({
  users,
  currentUserId,
  onClose,
  onSubmitted,
}: {
  users: UserOption[]
  currentUserId: string
  onClose: () => void
  onSubmitted: (requestNumber: string) => void
}) {
  // Default "Requested By" to the current user — the common case is submitting
  // one's own request. It stays a required, editable selection.
  const [form,   setForm]   = useState<RequestForm>({ ...EMPTY_FORM, requested_by: currentUserId })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const set = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.client_name.trim()) { setError('Client name is required.'); return }
    if (!form.requested_by)       { setError('Requested By is required.'); return }
    setSaving(true)
    setError(null)

    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setError('Not authenticated.'); setSaving(false); return }

    // No order number, no display_number: this only creates an order_requests
    // row. request_number (ORD-REQ-YYYY-NNNN) is assigned by the database.
    const payload = {
      client_name:  form.client_name.trim(),
      requested_by: form.requested_by,
      assigned_to:  form.assigned_to  || null,
      confirm_date: form.confirm_date || null,
      due_date:     form.due_date     || null,
      total_value:  form.total_value  ? parseFloat(form.total_value) : null,
      lead_source:  form.lead_source  || null,
      notes:        form.notes.trim() || null,
      created_by:   session.user.id,
    }

    const { data: created, error: insertErr } = await supabase
      .from('order_requests')
      .insert(payload)
      .select('request_number')
      .single()

    if (insertErr || !created) {
      setError(insertErr?.message ?? 'Failed to submit order request.')
      setSaving(false)
      return
    }

    onSubmitted(created.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', width: '100%', boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '540px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Submit Order Request</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              A request number is assigned on submission. No order is created yet.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label style={labelStyle}>
            Client Name *
            <input style={inputStyle} value={form.client_name} onChange={set('client_name')} placeholder="Client name" required />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Requested By *
              <select style={inputStyle} value={form.requested_by} onChange={set('requested_by')} required>
                <option value="">— Select —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Assigned To
              <select style={inputStyle} value={form.assigned_to} onChange={set('assigned_to')}>
                <option value="">— Select —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Expected Confirmation
              <input type="date" style={inputStyle} value={form.confirm_date} onChange={set('confirm_date')} />
            </label>
            <label style={labelStyle}>
              Expected Due Date
              <input type="date" style={inputStyle} value={form.due_date} onChange={set('due_date')} />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Approx. Value (₹)
              <input type="number" min="0" step="0.01" style={inputStyle} value={form.total_value} onChange={set('total_value')} placeholder="0" />
            </label>
            <label style={labelStyle}>
              Lead Source
              <select style={inputStyle} value={form.lead_source} onChange={set('lead_source')}>
                <option value="">— Select —</option>
                {LEAD_SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <label style={labelStyle}>
            Notes
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }}
              value={form.notes}
              onChange={set('notes')}
              placeholder="Any additional notes…"
            />
          </label>

          {error && (
            <div style={{ fontSize: '12px', color: colors.red, background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '6px', padding: '8px 12px' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
            <button type="button" onClick={onClose} style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: 'transparent', border: `1px solid ${colors.border}`, color: colors.secondary, cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Submitting…' : 'Submit Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Convert to Order modal (admin only) ───────────────────────────────────────
// Confirmation only: every value that ends up on the official Order is derived
// server-side by convert_order_request_to_order(). There is deliberately no
// Order-number input and no editing of request fields here.

function ConvertModal({
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
  const [loadingPayments, setLoadingPayments] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const supabase = useMemo(() => createClient(), [])

  // Eligible = approved but not yet attached to any Order. Admin-only data:
  // this relies on the existing finance_payment_requests admin SELECT policy,
  // so no Finance visibility is widened for anyone else.
  const loadEligiblePayments = async () => {
    setLoadingPayments(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select('id, request_number, amount, payment_date, proof_note, submitted_by_user:users!submitted_by(full_name)')
      .eq('status', 'approved_unlinked')
      .is('order_id', null)
      .order('payment_date', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: EligiblePayment[] = ((data ?? []) as any[]).map(p => ({
      id: p.id,
      request_number: p.request_number,
      amount: p.amount,
      payment_date: p.payment_date,
      proof_note: p.proof_note ?? null,
      submitted_by_name: p.submitted_by_user?.full_name ?? undefined,
    }))
    setPayments(mapped)
    setLoadingPayments(false)
    return mapped
  }

  // Refresh eligibility whenever the modal opens.
  useEffect(() => {
    loadEligiblePayments()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        setError('Could not convert this request. Please refresh and try again.')
      }
      setSaving(false)
      return
    }

    onConverted(data as ConvertResult)
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
    { label: 'Assigned To',            value: request.assigned_to_name ?? '—' },
    { label: 'Expected Confirmation',  value: fmtDate(request.confirm_date) },
    { label: 'Expected Due Date',      value: fmtDate(request.due_date) },
    { label: 'Approx. Value',          value: fmtAmount(request.total_value) },
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
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
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
                  maxHeight: '190px', overflowY: 'auto',
                }}>
                  {payments.map(p => {
                    const on = selected.has(p.id)
                    return (
                      <label
                        key={p.id}
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
                            <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary }}>
                              {p.request_number}
                            </span>
                            <span style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
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

function ClarifyModal({
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
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
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

// ── Reject Request modal (admin only) ──────────────────────────────────────────
// Deliberately separate from ConvertModal and ClarifyModal: rejecting is a
// terminal decision distinct from asking a question or creating an Order, and
// must not share a confirmation with either.

function RejectModal({
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
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
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

// ── Update and Resubmit modal (permitted requester only) ──────────────────────
// One action: edit the permitted business fields and hand the request back for
// review. No draft, no separate reply — the edit IS the response.

function ResubmitModal({
  request,
  users,
  onClose,
  onResubmitted,
}: {
  request: OrderRequest
  users: UserOption[]
  onClose: () => void
  onResubmitted: (requestNumber: string) => void
}) {
  const [form, setForm] = useState<RequestForm>({
    client_name:  request.client_name,
    requested_by: request.requested_by ?? '',
    assigned_to:  request.assigned_to ?? '',
    confirm_date: request.confirm_date ?? '',
    due_date:     request.due_date ?? '',
    total_value:  request.total_value != null ? String(request.total_value) : '',
    lead_source:  request.lead_source ?? '',
    notes:        request.notes ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState<string | null>(null)
  const supabase = useMemo(() => createClient(), [])

  const set = (k: keyof RequestForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (!form.client_name.trim()) { setError('Client name is required.'); return }
    if (!form.requested_by)       { setError('Requested By is required.'); return }
    setSaving(true)
    setError(null)

    const { error: rpcErr } = await supabase.rpc('resubmit_order_request', {
      p_order_request_id: request.id,
      p_client_name:      form.client_name,
      p_requested_by:     form.requested_by,
      p_assigned_to:      form.assigned_to  || null,
      p_confirm_date:     form.confirm_date || null,
      p_due_date:         form.due_date     || null,
      p_total_value:      form.total_value  ? parseFloat(form.total_value) : null,
      p_lead_source:      form.lead_source  || null,
      p_notes:            form.notes,
    })

    if (rpcErr) {
      setError('Could not resubmit this request. It may have already changed. Please refresh and try again.')
      setSaving(false)
      return
    }

    onResubmitted(request.request_number)
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', gap: '4px',
    fontSize: '11px', fontWeight: 600, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.05em',
  }
  const inputStyle: React.CSSProperties = {
    padding: '7px 10px', borderRadius: '6px',
    border: `1px solid ${colors.border}`,
    background: colors.raised, color: colors.primary,
    fontSize: '13px', width: '100%', boxSizing: 'border-box',
    outline: 'none',
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '16px',
      }}
      onClick={e => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '12px',
        width: '100%', maxWidth: '540px',
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary }}>Update and Resubmit</div>
            <div style={{ fontSize: '12px', color: colors.muted, marginTop: '2px' }}>
              {request.request_number} · {request.client_name}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ background: 'none', border: 'none', cursor: saving ? 'not-allowed' : 'pointer', color: colors.muted, display: 'flex' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* The question being answered — shown prominently, above the fields. */}
          {request.clarification_note && (
            <div style={{
              background: '#EFF6FF', border: '1px solid #BFDBFE',
              borderRadius: '6px', padding: '10px 12px',
            }}>
              <div style={{
                fontSize: '10px', fontWeight: 700, color: '#1E40AF',
                textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
              }}>
                Clarification requested
              </div>
              <div style={{ fontSize: '13px', color: '#1E3A8A', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {request.clarification_note}
              </div>
            </div>
          )}

          <label style={labelStyle}>
            Client Name *
            <input style={inputStyle} value={form.client_name} onChange={set('client_name')} required />
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Requested By *
              <select style={inputStyle} value={form.requested_by} onChange={set('requested_by')} required>
                <option value="">— Select —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
            <label style={labelStyle}>
              Assigned To
              <select style={inputStyle} value={form.assigned_to} onChange={set('assigned_to')}>
                <option value="">— Select —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Expected Confirmation
              <input type="date" style={inputStyle} value={form.confirm_date} onChange={set('confirm_date')} />
            </label>
            <label style={labelStyle}>
              Expected Due Date
              <input type="date" style={inputStyle} value={form.due_date} onChange={set('due_date')} />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <label style={labelStyle}>
              Approx. Value (₹)
              <input type="number" min="0" step="0.01" style={inputStyle} value={form.total_value} onChange={set('total_value')} />
            </label>
            <label style={labelStyle}>
              Lead Source
              <select style={inputStyle} value={form.lead_source} onChange={set('lead_source')}>
                <option value="">— Select —</option>
                {LEAD_SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <label style={labelStyle}>
            Notes
            <textarea
              style={{ ...inputStyle, minHeight: '72px', resize: 'vertical', fontFamily: 'inherit' }}
              value={form.notes}
              onChange={set('notes')}
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
            <button type="submit" disabled={saving} style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}>
              {saving ? 'Resubmitting…' : 'Update and Resubmit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OrderRequestsPage() {
  const [pageLoading,   setPageLoading]   = useState(true)
  const [profile,       setProfile]       = useState<UserProfile | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string>('')
  const [requests,      setRequests]      = useState<OrderRequest[]>([])
  const [users,         setUsers]         = useState<UserOption[]>([])
  const [listLoading,   setListLoading]   = useState(false)
  const [search,        setSearch]        = useState('')
  const [statusTab,     setStatusTab]     = useState<StatusFilter>('active')
  const [showModal,     setShowModal]     = useState(false)
  const [successNumber, setSuccessNumber] = useState<string | null>(null)
  const [convertTarget, setConvertTarget] = useState<OrderRequest | null>(null)
  const [converted,     setConverted]     = useState<ConvertResult | null>(null)
  const [clarifyTarget,  setClarifyTarget]  = useState<OrderRequest | null>(null)
  const [resubmitTarget, setResubmitTarget] = useState<OrderRequest | null>(null)
  const [rejectTarget,   setRejectTarget]   = useState<OrderRequest | null>(null)
  const [actionMessage,  setActionMessage]  = useState<string | null>(null)

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  const loadRequests = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('order_requests')
      .select(`
        id, request_number, client_name,
        requested_by, assigned_to,
        confirm_date, due_date, total_value, lead_source, notes,
        status, created_by, clarification_note, rejection_reason, created_at, converted_order_id,
        requested_by_user:users!requested_by(full_name),
        assigned_to_user:users!assigned_to(full_name),
        converted_order:orders!converted_order_id(display_number)
      `)
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: OrderRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      requested_by_name:      r.requested_by_user?.full_name ?? undefined,
      assigned_to_name:       r.assigned_to_user?.full_name  ?? undefined,
      converted_order_number: r.converted_order?.display_number ?? undefined,
      requested_by_user: undefined,
      assigned_to_user:  undefined,
      converted_order:   undefined,
    }))
    setRequests(mapped)
    setListLoading(false)
  }

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setCurrentUserId(session.user.id)

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', session.user.id)
        .single()
      setProfile(me as UserProfile)

      const { data: usersData } = await supabase
        .from('users')
        .select('id, full_name')
        .eq('is_active', true)
        .order('full_name')
      setUsers((usersData ?? []) as UserOption[])

      await loadRequests()
      setPageLoading(false)
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  const visible = useMemo(() => {
    const tab = STATUS_TABS.find(t => t.key === statusTab) ?? STATUS_TABS[0]
    let list = requests.filter(r => tab.match(r.status))
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(r =>
      r.request_number.toLowerCase().includes(q) ||
      r.client_name.toLowerCase().includes(q)
    )
  }, [requests, statusTab, search])

  const isAdmin = profile?.role === 'admin'

  if (pageLoading) return <LoadingScreen />

  return (
    <OrdersLayout
      profile={profile}
      title="Order Requests"
      subtitle="Submit and track order requests before they become official orders."
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
    >
      {successNumber && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={15} />
            Request submitted — <strong>{successNumber}</strong>. No order has been created yet.
          </span>
          <button
            onClick={() => setSuccessNumber(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {actionMessage && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={15} />
            {actionMessage}
          </span>
          <button
            onClick={() => setActionMessage(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
          >
            ✕
          </button>
        </div>
      )}

      {converted && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '12px', flexWrap: 'wrap',
          padding: '10px 14px', borderRadius: '8px', marginBottom: '12px',
          background: '#F0FDF4', border: '1px solid #BBF7D0',
          fontSize: '13px', color: '#166534',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CheckCircle2 size={15} />
            {converted.request_number} converted — official Order{' '}
            <strong>{converted.order_display_number}</strong> created
            {converted.linked_payment_count > 0
              ? `, ${converted.linked_payment_count} payment${converted.linked_payment_count !== 1 ? 's' : ''} linked.`
              : '.'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => router.push(`/orders/${converted.order_id}`)}
              style={{
                padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                background: '#166534', border: 'none', color: '#fff', cursor: 'pointer',
              }}
            >
              Open Order
            </button>
            <button
              onClick={() => setConverted(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#166534', padding: 0, lineHeight: 1, fontSize: '13px' }}
            >
              ✕
            </button>
          </span>
        </div>
      )}

      {/* ── Search + tabs + submit button ── */}
      <div style={{ marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <input
            className="boe-input"
            placeholder="Search by request number or client…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: '320px', flex: 1, minWidth: '180px' }}
          />
          <button
            onClick={() => setShowModal(true)}
            style={{
              padding: '8px 16px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0,
            }}
          >
            + New Order Request
          </button>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatusTab(tab.key)}
              style={{
                padding: '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                cursor: 'pointer', border: '1px solid',
                borderColor: statusTab === tab.key ? '#DC1F2E' : colors.border,
                background:   statusTab === tab.key ? 'rgba(220,31,46,0.07)' : 'transparent',
                color:        statusTab === tab.key ? '#DC1F2E' : colors.secondary,
                transition: 'all 0.1s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Table ── */}
      <div style={{
        background: colors.base,
        border: `1px solid ${colors.border}`,
        borderRadius: '10px',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 20px', borderBottom: `1px solid ${colors.border}`,
          fontSize: '12px', color: colors.muted,
        }}>
          {listLoading ? 'Loading…' : `${visible.length} request${visible.length !== 1 ? 's' : ''}`}
        </div>

        {listLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            No order requests found.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                  {['Request #', 'Client', 'Requested By', 'Assigned To', 'Expected Confirmation', 'Expected Due Date', 'Approx. Value', 'Status', 'Submitted On', 'Action'].map(h => (
                    <th key={h} style={{
                      padding: '8px 16px', textAlign: 'left',
                      fontSize: '10px', fontWeight: 600, color: colors.muted,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '11px 16px', fontWeight: 600, color: colors.primary, whiteSpace: 'nowrap' }}>
                      {r.request_number}
                      {r.status === 'converted' && r.converted_order_number && (
                        <div style={{ fontSize: '11px', fontWeight: 500, color: colors.muted, marginTop: '2px' }}>
                          → Order {r.converted_order_number}
                        </div>
                      )}
                      {r.status === 'needs_clarification' && r.clarification_note && (
                        <div
                          title={r.clarification_note}
                          style={{
                            fontSize: '11px', fontWeight: 500, color: '#1E40AF', marginTop: '2px',
                            maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          ? {r.clarification_note}
                        </div>
                      )}
                      {r.status === 'rejected' && r.rejection_reason && (
                        <div
                          title={r.rejection_reason}
                          style={{
                            fontSize: '11px', fontWeight: 500, color: '#991B1B', marginTop: '2px',
                            maxWidth: '190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          ✕ {r.rejection_reason}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.primary, maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.client_name}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {r.requested_by_name ?? '—'}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {r.assigned_to_name ?? '—'}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtDate(r.confirm_date)}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtDate(r.due_date)}
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtAmount(r.total_value)}
                    </td>
                    <td style={{ padding: '11px 16px' }}>
                      <StatusBadge status={r.status} />
                    </td>
                    <td style={{ padding: '11px 16px', color: colors.secondary, whiteSpace: 'nowrap' }}>
                      {fmtDate(r.created_at)}
                    </td>
                    <td style={{ padding: '11px 16px', whiteSpace: 'nowrap' }}>
                      {isAdmin && r.status === 'submitted' ? (
                        <span style={{ display: 'inline-flex', gap: '6px' }}>
                          <button
                            onClick={() => setConvertTarget(r)}
                            style={{
                              padding: '4px 11px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                              background: '#DC1F2E', border: 'none', color: '#fff', cursor: 'pointer',
                            }}
                          >
                            Convert
                          </button>
                          <button
                            onClick={() => setClarifyTarget(r)}
                            style={{
                              padding: '4px 11px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                              background: 'transparent', border: `1px solid ${colors.border}`,
                              color: colors.secondary, cursor: 'pointer',
                            }}
                          >
                            Request Clarification
                          </button>
                          <button
                            onClick={() => setRejectTarget(r)}
                            style={{
                              padding: '4px 11px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                              background: 'transparent', border: '1px solid #FECACA',
                              color: '#991B1B', cursor: 'pointer',
                            }}
                          >
                            Reject Request
                          </button>
                        </span>
                      ) : r.status === 'needs_clarification' && isPermittedRequester(r, currentUserId) ? (
                        <button
                          onClick={() => setResubmitTarget(r)}
                          style={{
                            padding: '4px 11px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                            background: '#1E40AF', border: 'none', color: '#fff', cursor: 'pointer',
                          }}
                        >
                          Update and Resubmit
                        </button>
                      ) : r.status === 'converted' && r.converted_order_id ? (
                        <button
                          onClick={() => router.push(`/orders/${r.converted_order_id}`)}
                          style={{
                            padding: '4px 11px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                            background: 'transparent', border: `1px solid ${colors.border}`,
                            color: colors.secondary, cursor: 'pointer',
                          }}
                        >
                          Open Order
                        </button>
                      ) : (
                        <span style={{ color: colors.muted }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <SubmitRequestModal
          users={users}
          currentUserId={currentUserId}
          onClose={() => setShowModal(false)}
          onSubmitted={requestNumber => {
            setShowModal(false)
            setSuccessNumber(requestNumber)
            loadRequests()
          }}
        />
      )}

      {convertTarget && (
        <ConvertModal
          request={convertTarget}
          onClose={() => setConvertTarget(null)}
          onConverted={result => {
            setConvertTarget(null)
            setSuccessNumber(null)
            setActionMessage(null)
            setConverted(result)
            loadRequests()
          }}
        />
      )}

      {clarifyTarget && (
        <ClarifyModal
          request={clarifyTarget}
          onClose={() => setClarifyTarget(null)}
          onRequested={requestNumber => {
            setClarifyTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`Clarification requested on ${requestNumber}. It now sits under Needs Clarification.`)
            loadRequests()
          }}
        />
      )}

      {resubmitTarget && (
        <ResubmitModal
          request={resubmitTarget}
          users={users}
          onClose={() => setResubmitTarget(null)}
          onResubmitted={requestNumber => {
            setResubmitTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`${requestNumber} updated and resubmitted. It is back under Active for review.`)
            loadRequests()
          }}
        />
      )}

      {rejectTarget && (
        <RejectModal
          request={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onRejected={requestNumber => {
            setRejectTarget(null)
            setSuccessNumber(null)
            setConverted(null)
            setActionMessage(`${requestNumber} has been rejected.`)
            loadRequests()
          }}
        />
      )}
    </OrdersLayout>
  )
}

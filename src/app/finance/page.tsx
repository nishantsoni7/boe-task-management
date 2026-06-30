'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { LoadingScreen } from '@/components/ui/atoms'
import { colors } from '@/lib/tokens'
import { FinanceLayout } from '@/components/layout/FinanceLayout'
import type { UserProfile } from '@/lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentRequest = {
  id: string
  client_name: string
  amount: number
  payment_date: string
  payment_mode: string
  received_in: string
  proof_note: string
  order_number: string | null
  order_id: string | null
  sales_note: string | null
  payment_against: string
  status: string
  submitted_by: string
  submitted_by_name?: string
  admin_note: string | null
  created_at: string
}

type OrderResult = {
  id: string
  display_number: string
  client_name: string
  total_value: number | null
  status: string
}

type AdminAction = 'approve' | 'needs_clarification' | 'reject'
type FilterTab   = 'pending' | 'order_pending' | 'clarification' | 'rejected' | 'all'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAYMENT_MODE_LABEL: Record<string, string> = {
  // legacy DB payment_mode values (for existing records in the table)
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  upi:           'UPI',
  cheque:        'Cheque',
  other:         'Other',
  // UI-key values (received_in-based keys used as combined payment method)
  company_account: 'Company Acc',
  savings_account: 'Saving Acc',
  cash_in_hand:    'Cash Handover',
  hawala:          'Hawala',
}

const RECEIVED_IN_LABEL: Record<string, string> = {
  company_account: 'Company Account',
  cash_in_hand:    'Cash in Hand',
  savings_account: 'Savings Account',
  other:           'Other',
}

const STATUS_META: Record<string, { label: string; bg: string; color: string; border: string }> = {
  pending_approval:    { label: 'Pending',             bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  approved_unlinked:   { label: 'Order No. Pending',   bg: '#FFF7ED', color: '#92400E', border: '#FED7AA' },
  approved_linked:     { label: 'Received Payment',    bg: '#F0FDF4', color: '#166534', border: '#BBF7D0' },
  needs_clarification: { label: 'Needs Clarification', bg: '#EFF6FF', color: '#1E40AF', border: '#BFDBFE' },
  rejected:            { label: 'Rejected',            bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
}

const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  requested:          { label: 'Requested',          color: '#92400E' },
  running:            { label: 'Running',             color: '#1E40AF' },
  on_hold:            { label: 'On Hold',             color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch',  color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',          color: '#166534' },
  cancelled:          { label: 'Cancelled',           color: '#991B1B' },
}

const PAYMENT_AGAINST_LABEL: Record<string, string> = {
  existing_order: 'Existing Order',
  new_order:      'New Order',
}

const PAYMENT_AGAINST_OPTIONS: { label: string; value: string }[] = [
  { label: 'New Order',      value: 'new_order' },
  { label: 'Existing Order', value: 'existing_order' },
]

// Option values are received_in-style DB keys (DB-safe for that column).
// payment_mode is derived via PAYMENT_MODE_DB_MAP below.
const PAYMENT_MODE_OPTIONS: { label: string; value: string }[] = [
  { label: 'Company Acc',   value: 'company_account' },
  { label: 'Saving Acc',    value: 'savings_account' },
  { label: 'Cash Handover', value: 'cash_in_hand' },
  { label: 'Hawala',        value: 'hawala' },
]

// Maps UI option value → DB-safe (payment_mode, received_in) pair.
// DB constraints: payment_mode IN (bank_transfer|cash|upi|cheque|other)
//                 received_in  IN (company_account|cash_in_hand|savings_account|other)
const PAYMENT_MODE_DB_MAP: Record<string, { payment_mode: string; received_in: string }> = {
  company_account: { payment_mode: 'bank_transfer', received_in: 'company_account' },
  savings_account: { payment_mode: 'bank_transfer', received_in: 'savings_account' },
  cash_in_hand:    { payment_mode: 'cash',          received_in: 'cash_in_hand'    },
  hawala:          { payment_mode: 'other',         received_in: 'other'           },
}

// Reverse-maps existing DB column values back to a PAYMENT_MODE_OPTIONS value (for edit form init).
function dbToUiPaymentMode(payment_mode: string, received_in: string): string {
  for (const [key, v] of Object.entries(PAYMENT_MODE_DB_MAP)) {
    if (v.payment_mode === payment_mode && v.received_in === received_in) return key
  }
  return PAYMENT_MODE_OPTIONS[0].value // fallback for legacy-only values
}

// Resolves the correct display label for a stored record's payment_mode + received_in.
// Falls back to the legacy payment_mode label if the pair doesn't match a known UI key.
function displayPaymentMode(payment_mode: string, received_in: string): string {
  const uiKey = dbToUiPaymentMode(payment_mode, received_in)
  const mapped = PAYMENT_MODE_DB_MAP[uiKey]
  if (mapped && mapped.payment_mode === payment_mode && mapped.received_in === received_in) {
    return PAYMENT_MODE_LABEL[uiKey] ?? uiKey
  }
  return PAYMENT_MODE_LABEL[payment_mode] ?? payment_mode
}

const RECEIVED_IN_OPTIONS: { label: string; value: string }[] = [
  { label: 'Company Account', value: 'company_account' },
  { label: 'Cash in Hand',    value: 'cash_in_hand' },
  { label: 'Savings Account', value: 'savings_account' },
  { label: 'Other',           value: 'other' },
]

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'pending',       label: 'Pending' },
  { key: 'order_pending', label: 'Order No. Pending' },
  { key: 'clarification', label: 'Needs Clarification' },
  { key: 'rejected',      label: 'Rejected' },
  { key: 'all',           label: 'All' },
]

const EMPTY_MESSAGES: Record<FilterTab, string> = {
  pending:       'No pending payment confirmations.',
  order_pending: 'No payments with order number pending.',
  clarification: 'No payments awaiting clarification.',
  rejected:      'No rejected payments.',
  all:           'No payment confirmations here.',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtAmount(n: number) {
  return '₹' + n.toLocaleString('en-IN')
}

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
  return `${date}, ${time}`
}

function matchesTab(r: PaymentRequest, tab: FilterTab): boolean {
  switch (tab) {
    case 'pending':       return r.status === 'pending_approval'
    case 'order_pending': return r.status === 'approved_unlinked'
    case 'clarification': return r.status === 'needs_clarification'
    case 'rejected':      return r.status === 'rejected'
    default:              return r.status !== 'approved_linked'
  }
}

// ── Shared modal shell ────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 59 }} />
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: '480px', maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
        zIndex: 60, padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.primary }}>{title}</div>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '4px 10px', fontSize: '13px' }}>✕</button>
        </div>
        {children}
      </div>
    </>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}{required && <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>}
      </label>
      {children}
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px' }}>
      {message}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
      <span style={{ fontSize: '13px', color: colors.primary }}>{value}</span>
    </div>
  )
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

// ── Status correction options (admin) ────────────────────────────────────────

const STATUS_CORRECTION_OPTIONS: { value: string; label: string }[] = [
  { value: 'pending_approval',    label: 'Pending Review' },
  { value: 'needs_clarification', label: 'Needs Clarification' },
  { value: 'approved_unlinked',   label: 'Received – Order No. Pending' },
  { value: 'approved_linked',     label: 'Received – Order No. Added' },
  { value: 'rejected',            label: 'Rejected' },
]

// ── Details modal (read-only for creators; includes status correction for admin) ──

function DetailsModal({
  request: r,
  onClose,
  isAdmin,
  supabase,
  onCorrected,
}: {
  request: PaymentRequest
  onClose: () => void
  isAdmin?: boolean
  supabase?: ReturnType<typeof createClient>
  onCorrected?: () => void
}) {
  const meta = STATUS_META[r.status] ?? { label: r.status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }

  const [newStatus,       setNewStatus]       = useState(r.status)
  const [correctionNote,  setCorrectionNote]  = useState('')
  const [correcting,      setCorrecting]      = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)

  const noteRequiredForCorrection = newStatus === 'needs_clarification' || newStatus === 'rejected'
  const linkedRequiresOrderNo = newStatus === 'approved_linked' && !r.order_number?.trim()
  const statusChanged = newStatus !== r.status
  const canCorrect = statusChanged && (!noteRequiredForCorrection || correctionNote.trim()) && !linkedRequiresOrderNo

  const handleCorrect = async () => {
    if (!canCorrect || !supabase || !onCorrected) return
    setCorrecting(true)
    setCorrectionError(null)
    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        status:     newStatus,
        admin_note: correctionNote.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
    setCorrecting(false)
    if (dbError) { setCorrectionError(dbError.message); return }
    onCorrected()
  }

  return (
    <Modal title="Payment Confirmation Details" onClose={onClose}>
      {/* Status banner */}
      <div style={{
        padding: '10px 14px', borderRadius: '8px',
        background: meta.bg, border: `1px solid ${meta.border}`,
        fontSize: '12px', fontWeight: 600, color: meta.color,
      }}>
        {meta.label}
      </div>

      {/* Clarification note from admin */}
      {r.status === 'needs_clarification' && r.admin_note && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#EFF6FF', border: '1px solid #BFDBFE',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#1E40AF', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
            Clarification Required
          </div>
          <div style={{ fontSize: '13px', color: '#1E3A8A', lineHeight: 1.6 }}>{r.admin_note}</div>
        </div>
      )}

      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '14px 16px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px',
        border: `1px solid ${colors.border}`,
      }}>
        <DetailRow label="Client"       value={r.client_name} />
        <DetailRow label="Amount"       value={fmtAmount(r.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(r.payment_date)} />
        <DetailRow label="Payment Mode" value={displayPaymentMode(r.payment_mode, r.received_in)} />
        <DetailRow label="Received In"      value={RECEIVED_IN_LABEL[r.received_in]  ?? r.received_in} />
        <DetailRow label="Order No."        value={r.order_number ?? '—'} />
        <DetailRow label="Payment Against"  value={PAYMENT_AGAINST_LABEL[r.payment_against] ?? r.payment_against} />
        <div style={{ gridColumn: '1 / -1' }}>
          <DetailRow label="Proof / Reference" value={r.proof_note} />
        </div>
        {r.sales_note && (
          <div style={{ gridColumn: '1 / -1' }}>
            <DetailRow label="Sales Note" value={r.sales_note} />
          </div>
        )}
        <DetailRow label="Submitted"    value={fmtDate(r.created_at)} />
        {r.submitted_by_name && <DetailRow label="Submitted By" value={r.submitted_by_name} />}
      </div>

      {/* Admin-only status correction */}
      {isAdmin && supabase && onCorrected && (
        <div style={{
          borderTop: `1px solid ${colors.border}`,
          paddingTop: '14px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Admin — Correct Status
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <select
              className="boe-input"
              value={newStatus}
              onChange={e => { setNewStatus(e.target.value); setCorrectionNote(''); setCorrectionError(null) }}
              style={{ fontSize: '12px', flex: '1 1 180px' }}
            >
              {STATUS_CORRECTION_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          {statusChanged && noteRequiredForCorrection && (
            <textarea
              className="boe-input"
              value={correctionNote}
              onChange={e => setCorrectionNote(e.target.value)}
              placeholder={newStatus === 'needs_clarification' ? 'Clarification note (required)' : 'Rejection reason (required)'}
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontSize: '12px' }}
            />
          )}
          {statusChanged && !noteRequiredForCorrection && (
            <textarea
              className="boe-input"
              value={correctionNote}
              onChange={e => setCorrectionNote(e.target.value)}
              placeholder="Admin note (optional)"
              rows={2}
              style={{ width: '100%', resize: 'vertical', fontSize: '12px' }}
            />
          )}
          {linkedRequiresOrderNo && (
            <ErrorBanner message="Order number is required before moving to Received Payments." />
          )}
          {correctionError && <ErrorBanner message={correctionError} />}
          {statusChanged && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={handleCorrect}
                disabled={!canCorrect || correcting}
                className="boe-btn boe-btn-primary"
                style={{ padding: '7px 16px', fontSize: '12px' }}
              >
                {correcting ? 'Saving…' : 'Save Correction'}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Close
        </button>
      </div>
    </Modal>
  )
}

// ── New Payment Confirmation modal ────────────────────────────────────────────

const EMPTY_FORM = {
  clientName:      '',
  amount:          '',
  paymentDate:     '',
  paymentMode:     PAYMENT_MODE_OPTIONS[0].value,
  receivedIn:      RECEIVED_IN_OPTIONS[0].value, // kept for DB compat; not shown in UI
  proofNote:       '',
  orderNumber:     '',
  salesNote:       '',
  paymentAgainst:  PAYMENT_AGAINST_OPTIONS[0].value,
}

type NewPaymentModalProps = {
  userId: string
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}

function NewPaymentConfirmationModal({ userId, supabase, onClose, onSaved }: NewPaymentModalProps) {
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  // Order search — only used when payment_against = 'existing_order'
  const [orderQuery,     setOrderQuery]     = useState('')
  const [orderResults,   setOrderResults]   = useState<OrderResult[]>([])
  const [orderSearching, setOrderSearching] = useState(false)
  const [selectedOrder,  setSelectedOrder]  = useState<OrderResult | null>(null)

  const set = (key: keyof typeof EMPTY_FORM) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const handlePaymentAgainstChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setForm(prev => ({ ...prev, paymentAgainst: e.target.value }))
    setSelectedOrder(null)
    setOrderQuery('')
    setOrderResults([])
  }

  const handleOrderSearch = async (q: string) => {
    setOrderQuery(q)
    setSelectedOrder(null)
    const trimmed = q.trim()
    if (!trimmed) { setOrderResults([]); return }
    setOrderSearching(true)
    const { data } = await supabase
      .from('orders')
      .select('id, display_number, client_name, total_value, status')
      .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
      .not('status', 'in', '(cancelled)')
      .order('created_at', { ascending: false })
      .limit(20)
    setOrderResults((data ?? []) as OrderResult[])
    setOrderSearching(false)
  }

  const isExistingOrder = form.paymentAgainst === 'existing_order'

  const canSubmit = !!(
    form.clientName.trim() &&
    form.amount.trim() &&
    form.paymentDate &&
    form.proofNote.trim() &&
    (!isExistingOrder || selectedOrder !== null)
  )

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)

    // Resolve UI payment mode to DB-safe values before any DB operation
    const dbMode = PAYMENT_MODE_DB_MAP[form.paymentMode]
    if (!dbMode) {
      setError('Invalid payment mode selected. Please choose a valid option.')
      setSaving(false)
      return
    }

    // Hawala is mapped to payment_mode='other' / received_in='other'.
    // Record the original intent in sales_note so the admin can see it.
    const baseNote = form.salesNote.trim()
    const finalSalesNote = form.paymentMode === 'hawala'
      ? [baseNote, 'Payment mode: Hawala'].filter(Boolean).join(' | ') || null
      : baseNote || null

    if (isExistingOrder) {
      // Existing order — link directly, no order creation needed
      const { error: dbError } = await supabase
        .from('finance_payment_requests')
        .insert({
          client_name:     form.clientName.trim(),
          amount:          parseFloat(form.amount),
          payment_date:    form.paymentDate,
          payment_mode:    dbMode.payment_mode,
          received_in:     dbMode.received_in,
          proof_note:      form.proofNote.trim(),
          order_number:    selectedOrder?.display_number ?? null,
          order_id:        selectedOrder?.id ?? null,
          sales_note:      finalSalesNote,
          payment_against: 'existing_order',
          status:          'pending_approval',
          submitted_by:    userId,
        })
      setSaving(false)
      if (dbError) { setError(dbError.message); return }
      onSaved()
      return
    }

    // New Order — reserve the next order number, then create the payment request

    // Step 1: compute next display number (same logic as orders/all/page.tsx)
    const { data: allOrders } = await supabase
      .from('orders')
      .select('display_number')

    const nums = ((allOrders ?? []) as { display_number: string }[])
      .map(o => parseInt(o.display_number, 10))
      .filter(n => !isNaN(n))
    const nextDisplayNumber = String(nums.length > 0 ? Math.max(...nums) + 1 : 1)

    // Step 2: collision guard — another request may have taken this number in the gap
    const { data: taken } = await supabase
      .from('orders')
      .select('id')
      .eq('display_number', nextDisplayNumber)
      .maybeSingle()

    if (taken) {
      setError(`Order number ${nextDisplayNumber} was just taken. Please try submitting again.`)
      setSaving(false)
      return
    }

    // Step 3: create the pending order record
    const { data: newOrder, error: orderErr } = await supabase
      .from('orders')
      .insert({
        display_number: nextDisplayNumber,
        client_name:    form.clientName.trim(),
        requested_by:   userId,
        created_by:     userId,
        status:         'requested',
      })
      .select('id, display_number')
      .single()

    if (orderErr || !newOrder) {
      setError(orderErr?.message ?? 'Failed to reserve order number. Please try again.')
      setSaving(false)
      return
    }

    // Step 4: create the payment request linked to the reserved order
    const { error: paymentErr } = await supabase
      .from('finance_payment_requests')
      .insert({
        client_name:     form.clientName.trim(),
        amount:          parseFloat(form.amount),
        payment_date:    form.paymentDate,
        payment_mode:    dbMode.payment_mode,
        received_in:     dbMode.received_in,
        proof_note:      form.proofNote.trim(),
        order_number:    newOrder.display_number,
        order_id:        newOrder.id,
        sales_note:      finalSalesNote,
        payment_against: 'new_order',
        status:          'pending_approval',
        submitted_by:    userId,
      })

    setSaving(false)
    if (paymentErr) {
      // Roll back the reserved order to prevent orphaned order numbers
      await supabase.from('orders').delete().eq('id', newOrder.id)
      setError(`Payment request failed: ${paymentErr.message}`)
      return
    }
    onSaved()
  }

  // Card-based toggle — reuses same reset logic as handlePaymentAgainstChange
  const switchPaymentAgainst = (value: string) => {
    setForm(prev => ({ ...prev, paymentAgainst: value }))
    setSelectedOrder(null)
    setOrderQuery('')
    setOrderResults([])
  }

  const [attachFile, setAttachFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isHandoverMode = form.paymentMode === 'cash_in_hand' || form.paymentMode === 'hawala'

  const SECTION_LABEL: React.CSSProperties = {
    fontSize: '10px', fontWeight: 700, color: colors.muted,
    textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '10px',
  }

  return (
    <>
      {/* Full-page overlay */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200 }}
      />

      {/* Modal */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        width: '660px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 40px)',
        background: colors.base, borderRadius: '12px', border: `1px solid ${colors.border}`,
        zIndex: 201, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '14px 20px 12px', borderBottom: `1px solid ${colors.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: colors.primary, marginBottom: '2px' }}>
              New Payment Confirmation
            </div>
            <div style={{ fontSize: '11px', color: colors.muted }}>
              Submit customer payment details for admin review
            </div>
          </div>
          <button
            onClick={onClose}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '13px', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div style={{
          padding: '16px 20px', overflowY: 'auto', flex: 1,
          display: 'flex', flexDirection: 'column', gap: '14px',
        }}>

          {/* Section: Order */}
          <div>
            <div style={SECTION_LABEL}>Order</div>

            {/* Payment Against — two selectable cards */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              {PAYMENT_AGAINST_OPTIONS.map(opt => {
                const active = form.paymentAgainst === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => switchPaymentAgainst(opt.value)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                      gap: '2px', padding: '8px 12px', borderRadius: '7px', cursor: 'pointer',
                      border: active ? '1.5px solid #DC1F2E' : `1px solid ${colors.border}`,
                      background: active ? 'rgba(220,31,46,0.04)' : colors.raised,
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: '12px', fontWeight: 600, color: active ? '#DC1F2E' : colors.primary }}>
                      {opt.label}
                    </span>
                    <span style={{ fontSize: '11px', color: colors.muted }}>
                      {opt.value === 'new_order'
                        ? 'Auto-reserve a new order number'
                        : 'Link to an existing order'}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* New Order — helper line */}
            {!isExistingOrder && (
              <div style={{ fontSize: '11px', color: colors.muted, padding: '0 2px' }}>
                Order number will be auto-reserved after submission.
              </div>
            )}

            {/* Existing Order — search + selection */}
            {isExistingOrder && (
              <Field label="Select Order" required>
                {selectedOrder ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '7px 10px', borderRadius: '7px',
                    background: colors.blueTint, border: `1px solid rgba(85,133,232,0.25)`,
                  }}>
                    <div>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{selectedOrder.display_number}</span>
                      <span style={{ fontSize: '12px', color: colors.secondary, marginLeft: '8px' }}>{selectedOrder.client_name}</span>
                    </div>
                    <button
                      onClick={() => { setSelectedOrder(null); setOrderQuery(''); setOrderResults([]) }}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '2px 8px', fontSize: '11px' }}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      background: colors.raised, border: `1px solid ${colors.border}`,
                      borderRadius: '6px', padding: '5px 10px',
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        type="text"
                        autoFocus
                        placeholder="Search by order number or client…"
                        value={orderQuery}
                        onChange={e => handleOrderSearch(e.target.value)}
                        style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary }}
                      />
                      {orderSearching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
                    </div>
                    {orderResults.length > 0 && (
                      <div style={{
                        border: `1px solid ${colors.border}`, borderRadius: '7px', overflow: 'hidden',
                        maxHeight: '180px', overflowY: 'auto', marginTop: '4px',
                      }}>
                        {orderResults.map((o, idx) => {
                          const osMeta = ORDER_STATUS_META[o.status] ?? { label: o.status, color: colors.muted }
                          return (
                            <div
                              key={o.id}
                              onClick={() => { setSelectedOrder(o); setOrderResults([]) }}
                              style={{
                                padding: '8px 12px',
                                borderBottom: idx < orderResults.length - 1 ? `1px solid ${colors.border}` : 'none',
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                              }}
                              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = colors.raised }}
                              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{o.display_number}</span>
                                  <span style={{ fontSize: '11px', fontWeight: 600, color: osMeta.color }}>{osMeta.label}</span>
                                </div>
                                <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {o.client_name}
                                </div>
                              </div>
                              {o.total_value != null && (
                                <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, flexShrink: 0 }}>
                                  {fmtAmount(o.total_value)}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {orderQuery.trim() && !orderSearching && orderResults.length === 0 && (
                      <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0' }}>
                        No orders found for &ldquo;{orderQuery.trim()}&rdquo;.
                      </div>
                    )}
                  </>
                )}
              </Field>
            )}
          </div>

          {/* Section: Payment details */}
          <div>
            <div style={SECTION_LABEL}>Payment details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>

              {/* Row 1: Client Name + Amount */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <Field label="Client Name" required>
                  <input className="boe-input" value={form.clientName} onChange={set('clientName')}
                    placeholder="e.g. Raj Enterprises" style={{ width: '100%' }} />
                </Field>
                <Field label="Amount (₹)" required>
                  <input className="boe-input" type="number" min="0" value={form.amount}
                    onChange={set('amount')} placeholder="0" style={{ width: '100%' }} />
                </Field>
              </div>

              {/* Row 2: Payment Date + Payment Mode */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <Field label="Payment Date" required>
                  <input className="boe-input" type="date" value={form.paymentDate}
                    onChange={set('paymentDate')} style={{ width: '100%' }} />
                </Field>
                <Field label="Payment Mode" required>
                  <select className="boe-input" value={form.paymentMode} onChange={set('paymentMode')} style={{ width: '100%' }}>
                    {PAYMENT_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
              </div>

              {/* Conditional: Cash / handover note */}
              {isHandoverMode && (
                <Field label="Cash / handover note">
                  <input
                    className="boe-input"
                    value={form.salesNote}
                    onChange={set('salesNote')}
                    placeholder="Who collected cash or handover detail"
                    style={{ width: '100%' }}
                  />
                </Field>
              )}

              {/* Proof row: reference input + attachment */}
              <Field label="Payment Proof / Reference" required>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    className="boe-input"
                    value={form.proofNote}
                    onChange={set('proofNote')}
                    placeholder="UTR, cheque no., or short proof note"
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf"
                    style={{ display: 'none' }}
                    onChange={e => setAttachFile(e.target.files?.[0] ?? null)}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="boe-btn boe-btn-ghost"
                    style={{ padding: '6px 10px', fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0 }}
                  >
                    {attachFile ? '📎 ' + attachFile.name.slice(0, 14) + (attachFile.name.length > 14 ? '…' : '') : '📎 Attach'}
                  </button>
                </div>
              </Field>

            </div>
          </div>

          {error && <ErrorBanner message={error} />}

        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '10px 20px', borderTop: `1px solid ${colors.border}`,
          display: 'flex', gap: '8px', justifyContent: 'flex-end', flexShrink: 0,
        }}>
          <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '7px 16px', fontSize: '13px' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit || saving}
            className="boe-btn boe-btn-primary" style={{ padding: '7px 16px', fontSize: '13px' }}>
            {saving ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>

      </div>
    </>
  )
}

// ── Edit Payment modal (creator only) ────────────────────────────────────────

type EditPaymentModalProps = {
  request: PaymentRequest
  isAdmin: boolean
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onSaved: () => void
}

function EditPaymentModal({ request: r, isAdmin, supabase, onClose, onSaved }: EditPaymentModalProps) {
  const [form, setForm] = useState({
    clientName:  r.client_name,
    amount:      String(r.amount),
    paymentDate: r.payment_date,
    paymentMode: dbToUiPaymentMode(r.payment_mode, r.received_in),
    proofNote:   r.proof_note,
    orderNumber: r.order_number ?? '',
    salesNote:   r.sales_note  ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const set = (key: keyof typeof form) => (
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  )

  const canSubmit = form.clientName.trim() && form.amount.trim() && form.paymentDate && form.proofNote.trim()

  const handleSave = async () => {
    if (!canSubmit) return
    if (r.status === 'approved_linked' && !form.orderNumber.trim()) {
      setError('Order number is required for Received Payments.')
      return
    }
    const editDbMode = PAYMENT_MODE_DB_MAP[form.paymentMode]
    if (!editDbMode) {
      setError('Invalid payment mode selected.')
      return
    }
    setSaving(true)
    setError(null)
    const newOrderNumber = form.orderNumber.trim() || null
    const autoUpgrade = isAdmin && r.status === 'approved_unlinked' && !!newOrderNumber
    const { data: updated, error: dbError } = await supabase
      .from('finance_payment_requests')
      .update({
        client_name:  form.clientName.trim(),
        amount:       parseFloat(form.amount),
        payment_date: form.paymentDate,
        payment_mode: editDbMode.payment_mode,
        received_in:  editDbMode.received_in,
        proof_note:   form.proofNote.trim(),
        order_number: newOrderNumber,
        sales_note:   form.salesNote.trim() || null,
        ...(!isAdmin && r.status === 'needs_clarification' ? { status: 'pending_approval' } : {}),
        ...(autoUpgrade ? { status: 'approved_linked' } : {}),
        updated_at:   new Date().toISOString(),
      })
      .eq('id', r.id)
      .select('id, client_name, amount, status')
      .single()
    setSaving(false)
    if (dbError) { setError(dbError.message); return }
    if (!updated) { setError('No row was updated. Check permissions or row status.'); return }
    onSaved()
  }

  return (
    <Modal title="Edit Payment Confirmation" onClose={onClose}>
      {!isAdmin && r.status === 'needs_clarification' && (
        <div style={{
          padding: '12px 14px', borderRadius: '8px',
          background: '#EFF6FF', border: '1px solid #BFDBFE',
        }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#1E40AF', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: r.admin_note ? '6px' : '0' }}>
            Clarification Required
          </div>
          {r.admin_note && (
            <div style={{ fontSize: '13px', color: '#1E3A8A', lineHeight: 1.6, marginBottom: '6px' }}>{r.admin_note}</div>
          )}
          <div style={{ fontSize: '11px', color: '#3B82F6', marginTop: '4px' }}>
            Saving your changes will resubmit this request for admin review.
          </div>
        </div>
      )}
      <Field label="Client Name" required>
        <input className="boe-input" value={form.clientName} onChange={set('clientName')}
          placeholder="e.g. Raj Enterprises" style={{ width: '100%' }} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <Field label="Amount (₹)" required>
          <input className="boe-input" type="number" min="0" value={form.amount}
            onChange={set('amount')} placeholder="0" style={{ width: '100%' }} />
        </Field>
        <Field label="Payment Date" required>
          <input className="boe-input" type="date" value={form.paymentDate}
            onChange={set('paymentDate')} style={{ width: '100%' }} />
        </Field>
      </div>
      <Field label="Payment Mode" required>
        <select className="boe-input" value={form.paymentMode} onChange={set('paymentMode')} style={{ width: '100%' }}>
          {PAYMENT_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="Payment Proof / Reference Note" required>
        <textarea className="boe-input" value={form.proofNote} onChange={set('proofNote')}
          placeholder="e.g. UTR 123456789, cheque no. 001234, or cash received at office"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      <Field label="Order Number (optional)">
        <input className="boe-input" value={form.orderNumber} onChange={set('orderNumber')}
          placeholder="Leave blank if order not yet created" style={{ width: '100%' }} />
      </Field>
      <Field label="Sales Note (optional)">
        <textarea className="boe-input" value={form.salesNote} onChange={set('salesNote')}
          placeholder="Any additional context for admin"
          rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </Field>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
        <button onClick={handleSave} disabled={!canSubmit || saving}
          className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </Modal>
  )
}

// ── Admin Review modal ────────────────────────────────────────────────────────

type AdminReviewModalProps = {
  request: PaymentRequest
  adminUserId: string
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onActioned: () => void
}

function AdminReviewModal({ request: r, adminUserId, supabase, onClose, onActioned }: AdminReviewModalProps) {
  const [action,    setAction]    = useState<AdminAction | null>(null)
  const [adminNote, setAdminNote] = useState('')
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  const noteRequired = action === 'needs_clarification' || action === 'reject'
  const canConfirm   = action !== null && (!noteRequired || adminNote.trim())

  const handleConfirm = async () => {
    if (!action) return
    setSaving(true)
    setError(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {
      admin_note: adminNote.trim() || null,
      updated_at: new Date().toISOString(),
    }
    if (action === 'approve') {
      updates.status      = r.order_number?.trim() ? 'approved_linked' : 'approved_unlinked'
      updates.approved_by = adminUserId
      updates.approved_at = new Date().toISOString()
    } else {
      updates.status = action === 'needs_clarification' ? 'needs_clarification' : 'rejected'
    }
    const { error: dbError } = await supabase
      .from('finance_payment_requests')
      .update(updates)
      .eq('id', r.id)
    setSaving(false)
    if (dbError) { setError(dbError.message); return }
    onActioned()
  }

  const actionBtn = (a: AdminAction, label: string, activeColor: string, activeBg: string): React.CSSProperties => {
    const active = action === a
    return {
      padding: '7px 16px', fontSize: '12px', fontWeight: 600, borderRadius: '7px', cursor: 'pointer',
      border: `1px solid ${active ? activeColor : colors.border}`,
      background: active ? activeBg : 'transparent',
      color: active ? activeColor : colors.secondary,
    }
  }

  return (
    <Modal title="Review Payment Confirmation" onClose={onClose}>
      {/* Summary */}
      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '14px 16px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px',
        border: `1px solid ${colors.border}`,
      }}>
        <DetailRow label="Client"       value={r.client_name} />
        <DetailRow label="Amount"       value={fmtAmount(r.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(r.payment_date)} />
        <DetailRow label="Payment Mode" value={displayPaymentMode(r.payment_mode, r.received_in)} />
        <DetailRow label="Received In"     value={RECEIVED_IN_LABEL[r.received_in]  ?? r.received_in} />
        <DetailRow label="Order No."       value={r.order_number ?? '—'} />
        <DetailRow label="Payment Against" value={PAYMENT_AGAINST_LABEL[r.payment_against] ?? r.payment_against} />
        <div style={{ gridColumn: '1 / -1' }}>
          <DetailRow label="Proof / Reference" value={r.proof_note} />
        </div>
        {r.sales_note && (
          <div style={{ gridColumn: '1 / -1' }}>
            <DetailRow label="Sales Note" value={r.sales_note} />
          </div>
        )}
        {r.submitted_by_name && (
          <div style={{ gridColumn: '1 / -1' }}>
            <DetailRow label="Submitted By" value={r.submitted_by_name} />
          </div>
        )}
      </div>

      {/* Action selector */}
      <div>
        <div style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Action</div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button style={actionBtn('approve', 'Mark Payment Received', colors.green, colors.greenTint)} onClick={() => setAction('approve')}>Mark Payment Received</button>
          <button style={actionBtn('needs_clarification','Needs Clarification',colors.blue,  colors.blueTint)}  onClick={() => setAction('needs_clarification')}>Needs Clarification</button>
          <button style={actionBtn('reject',             'Reject',             colors.red,   colors.redTint)}   onClick={() => setAction('reject')}>Reject</button>
        </div>
      </div>

      {action && (
        <Field label={`Admin Note${noteRequired ? '' : ' (optional)'}`} required={noteRequired}>
          <textarea className="boe-input" value={adminNote} onChange={e => setAdminNote(e.target.value)}
            placeholder={
              action === 'approve'             ? 'Optional note for the salesperson' :
              action === 'needs_clarification' ? 'Explain what clarification is needed' :
                                                 'Explain why this is being rejected'
            }
            rows={2} style={{ width: '100%', resize: 'vertical' }} />
        </Field>
      )}

      {error && <ErrorBanner message={error} />}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
        <button onClick={handleConfirm} disabled={!canConfirm || saving}
          className="boe-btn boe-btn-primary" style={{ padding: '8px 18px', fontSize: '13px' }}>
          {saving ? 'Saving…' : 'Confirm'}
        </button>
      </div>
    </Modal>
  )
}

// ── Delete confirm modal (admin only) ────────────────────────────────────────

type DeleteConfirmModalProps = {
  request: PaymentRequest
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  onDeleted: () => void
}

function DeleteConfirmModal({ request: r, supabase, onClose, onDeleted }: DeleteConfirmModalProps) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const meta = STATUS_META[r.status] ?? { label: r.status, bg: '#F3F4F6', color: '#4B5563', border: '#E5E7EB' }

  const handleDelete = async () => {
    setDeleting(true)
    setError(null)
    const { error: dbError, count } = await supabase
      .from('finance_payment_requests')
      .delete({ count: 'exact' })
      .eq('id', r.id)
    setDeleting(false)
    if (dbError) { setError(dbError.message); return }
    if (count === 0) { setError('No row was deleted. Check permissions.'); return }
    onDeleted()
  }

  return (
    <Modal title="Delete Payment Confirmation" onClose={onClose}>
      <div style={{ fontSize: '13px', color: colors.secondary, lineHeight: 1.7 }}>
        Delete this payment confirmation? This cannot be undone.
      </div>
      <div style={{
        background: colors.raised, borderRadius: '8px', padding: '12px 14px',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px',
        border: `1px solid ${colors.border}`,
      }}>
        <DetailRow label="Client"       value={r.client_name} />
        <DetailRow label="Amount"       value={fmtAmount(r.amount)} />
        <DetailRow label="Payment Date" value={fmtDate(r.payment_date)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Status</span>
          <span style={{
            display: 'inline-block', padding: '2px 8px', borderRadius: '5px', alignSelf: 'flex-start',
            background: meta.bg, color: meta.color, border: `1px solid ${meta.border}`,
            fontSize: '11px', fontWeight: 600,
          }}>
            {meta.label}
          </span>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>Cancel</button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          style={{
            padding: '8px 18px', fontSize: '13px', fontWeight: 600, borderRadius: '8px',
            border: `1px solid ${colors.red}`, background: colors.redTint, color: colors.red,
            cursor: deleting ? 'default' : 'pointer', opacity: deleting ? 0.6 : 1,
          }}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  )
}

// ── Payments table ────────────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: 700,
  color: colors.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  whiteSpace: 'nowrap',
  borderBottom: `1px solid ${colors.border}`,
  background: colors.raised,
}

const EDITABLE_STATUSES = new Set(['pending_approval', 'needs_clarification'])

function PaymentsTable({
  rows,
  isAdmin,
  userId,
  onRowClick,
  onView,
  onEdit,
  onDelete,
}: {
  rows: PaymentRequest[]
  isAdmin: boolean
  userId: string
  onRowClick: (r: PaymentRequest) => void
  onView: (r: PaymentRequest) => void
  onEdit: (r: PaymentRequest) => void
  onDelete: (r: PaymentRequest) => void
}) {
  const TD: React.CSSProperties = { padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }

  return (
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '900px' }}>
        <thead>
          <tr>
            <th style={TH_STYLE}>Client</th>
            <th style={TH_STYLE}>Order No.</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Amount</th>
            <th style={TH_STYLE}>Payment Date</th>
            <th style={TH_STYLE}>Mode</th>
            <th style={TH_STYLE}>Received In</th>
            <th style={TH_STYLE}>Submitted By</th>
            <th style={TH_STYLE}>Submitted On</th>
            <th style={TH_STYLE}>Status</th>
            <th style={{ ...TH_STYLE, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isPending  = r.status === 'pending_approval'
            const isClarif   = r.status === 'needs_clarification'
            const isRejected = r.status === 'rejected'
            const accentColor =
              isPending  ? '#F59E0B' :
              isClarif   ? colors.blue :
              isRejected ? colors.red :
              'transparent'

            const showEdit   = isAdmin || (r.submitted_by === userId && EDITABLE_STATUSES.has(r.status))
            const showDelete = isAdmin

            return (
              <tr
                key={r.id}
                onClick={() => onRowClick(r)}
                style={{ cursor: 'pointer', borderLeft: `3px solid ${accentColor}` }}
                onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = colors.raised }}
                onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent' }}
              >
                <td style={{ ...TD, fontSize: '13px', fontWeight: 600, color: colors.primary }}>
                  {r.client_name}
                  {isAdmin && isPending && (
                    <span style={{
                      marginLeft: '6px', fontSize: '10px', fontWeight: 600,
                      color: '#92400E', background: '#FEF3C7',
                      padding: '1px 5px', borderRadius: '4px',
                    }}>
                      Review
                    </span>
                  )}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: r.order_number ? colors.secondary : colors.muted, fontStyle: r.order_number ? 'normal' : 'italic' }}>
                  {r.order_number ?? '—'}
                </td>
                <td style={{ ...TD, fontSize: '13px', fontWeight: 700, color: colors.primary, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fmtAmount(r.amount)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {fmtDate(r.payment_date)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {displayPaymentMode(r.payment_mode, r.received_in)}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {RECEIVED_IN_LABEL[r.received_in] ?? r.received_in}
                </td>
                <td style={{ ...TD, fontSize: '12px', color: colors.secondary }}>
                  {r.submitted_by_name ?? '—'}
                </td>
                <td style={{ ...TD, fontSize: '11px', color: colors.muted }}>
                  {fmtDateTime(r.created_at)}
                </td>
                <td style={TD}>
                  <StatusBadge status={r.status} />
                </td>
                <td style={{ ...TD, textAlign: 'right' }}>
                  <div
                    style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}
                    onClick={e => e.stopPropagation()}
                  >
                    <button
                      onClick={() => onView(r)}
                      className="boe-btn boe-btn-ghost"
                      style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                    >
                      View
                    </button>
                    {showEdit && (
                      isAdmin ? (
                        <button
                          onClick={() => onEdit(r)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                        >
                          Edit
                        </button>
                      ) : (
                        <button
                          onClick={() => onEdit(r)}
                          className="boe-btn boe-btn-ghost"
                          style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500 }}
                        >
                          Edit
                        </button>
                      )
                    )}
                    {showDelete && (
                      <button
                        onClick={() => onDelete(r)}
                        className="boe-btn boe-btn-ghost"
                        style={{ padding: '3px 9px', fontSize: '11px', fontWeight: 500, color: colors.red }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FinancePage() {
  const [pageLoading, setPageLoading]   = useState(true)
  const [userId, setUserId]             = useState<string>('')
  const [isAdmin, setIsAdmin]           = useState(false)
  const [profile, setProfile]           = useState<UserProfile | null>(null)
  const [requests, setRequests]         = useState<PaymentRequest[]>([])
  const [listLoading, setListLoading]   = useState(false)
  const [showForm, setShowForm]           = useState(false)
  const [reviewRequest, setReviewRequest] = useState<PaymentRequest | null>(null)
  const [detailRequest, setDetailRequest] = useState<PaymentRequest | null>(null)
  const [editRequest,   setEditRequest]   = useState<PaymentRequest | null>(null)
  const [deleteRequest, setDeleteRequest] = useState<PaymentRequest | null>(null)
  const [activeTab, setActiveTab]       = useState<FilterTab>('pending')
  const [search, setSearch]             = useState('')

  const router   = useRouter()
  const supabase = useMemo(() => createClient(), [])

  // ── Auth + profile ───────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const uid = session.user.id
      setUserId(uid)

      const { data: me } = await supabase
        .from('users')
        .select('id, full_name, email, phone, role, team, position, is_active, created_at, employee_code, joining_date, monthly_salary, office_timing, fingerprint_employee_code')
        .eq('id', uid)
        .single()

      setProfile(me as UserProfile)
      setIsAdmin(me?.role === 'admin')
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

  // ── Fetch — join submitted_by_name via users ─────────────────────────────────
  const loadRequests = async () => {
    setListLoading(true)
    const { data } = await supabase
      .from('finance_payment_requests')
      .select(`
        id, client_name, amount, payment_date, payment_mode,
        received_in, proof_note, order_number, order_id, sales_note,
        payment_against, status, submitted_by, admin_note, created_at,
        submitted_by_user:users!submitted_by(full_name)
      `)
      .neq('status', 'approved_linked')
      .order('created_at', { ascending: false })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: PaymentRequest[] = ((data ?? []) as any[]).map(r => ({
      ...r,
      submitted_by_name: r.submitted_by_user?.full_name ?? undefined,
      submitted_by_user: undefined,
    }))
    setRequests(mapped)
    setListLoading(false)
  }

  // ── Filtered + searched list (client-side, newest-first already from DB) ─────
  const visible = useMemo(() => {
    let list = requests.filter(r => matchesTab(r, activeTab))
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(r =>
        r.client_name.toLowerCase().includes(q) ||
        (r.order_number ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [requests, activeTab, search])

  // ── Status counts (across all unfiltered) ────────────────────────────────────
  const counts = useMemo(() => ({
    pending:       requests.filter(r => r.status === 'pending_approval').length,
    order_pending: requests.filter(r => r.status === 'approved_unlinked').length,
    clarification: requests.filter(r => r.status === 'needs_clarification').length,
    rejected:      requests.filter(r => r.status === 'rejected').length,
    all:           requests.filter(r => r.status !== 'approved_linked').length,
  }), [requests])

  const tabCount: Record<FilterTab, number> = {
    pending:       counts.pending,
    order_pending: counts.order_pending,
    clarification: counts.clarification,
    rejected:      counts.rejected,
    all:           counts.all,
  }

  // ── Row click handler ────────────────────────────────────────────────────────
  const handleRowClick = (r: PaymentRequest) => {
    if (isAdmin && r.status === 'pending_approval') {
      setReviewRequest(r)
    } else {
      setDetailRequest(r)
    }
  }

  if (pageLoading) return <LoadingScreen />

  return (
    <FinanceLayout
      profile={profile}
      title="Payment Confirmations"
      subtitle="Sales can submit customer payment details here for admin confirmation."
      onSignOut={handleSignOut}
      onRefresh={loadRequests}
      actions={
        <button onClick={() => setShowForm(true)} className="boe-btn boe-btn-primary"
          style={{ padding: '6px 14px', fontSize: '12px' }}>
          + New
        </button>
      }
    >
      <div className="boe-card" style={{ overflow: 'hidden' }}>

        {/* ── Filter tabs + search ── */}
        <div style={{ padding: '10px 16px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {FILTER_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setSearch('') }}
              className={`boe-filter-tab${activeTab === tab.key ? ' boe-filter-tab-active' : ''}`}
            >
              {tab.label}
              {tabCount[tab.key] > 0 && (
                <span style={{
                  marginLeft: '5px',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: '16px', height: '16px', borderRadius: '4px',
                  background: activeTab === tab.key ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.08)',
                  fontSize: '10px', fontWeight: 700,
                }}>
                  {tabCount[tab.key]}
                </span>
              )}
            </button>
          ))}

          {/* Search — right-aligned */}
          <div style={{
            marginLeft: 'auto',
            display: 'flex', alignItems: 'center', gap: '6px',
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '6px', padding: '5px 10px', minWidth: '160px',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Client or order…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary, minWidth: 0 }}
            />
            {search && (
              <button onClick={() => setSearch('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, padding: 0, lineHeight: 1, fontSize: '13px' }}>✕</button>
            )}
          </div>
        </div>

        {/* ── Table ── */}
        {listLoading ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>Loading…</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: colors.muted, fontSize: '13px' }}>
            {search.trim()
              ? `No results for "${search.trim()}".`
              : EMPTY_MESSAGES[activeTab]}
          </div>
        ) : (
          <PaymentsTable
            rows={visible}
            isAdmin={isAdmin}
            userId={userId}
            onRowClick={handleRowClick}
            onView={r => setDetailRequest(r)}
            onEdit={r => setEditRequest(r)}
            onDelete={r => setDeleteRequest(r)}
          />
        )}

      </div>

      {/* ── Modals ── */}
      {showForm && (
        <NewPaymentConfirmationModal
          userId={userId}
          supabase={supabase}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); loadRequests() }}
        />
      )}
      {reviewRequest && (
        <AdminReviewModal
          request={reviewRequest}
          adminUserId={userId}
          supabase={supabase}
          onClose={() => setReviewRequest(null)}
          onActioned={() => { setReviewRequest(null); loadRequests() }}
        />
      )}
      {detailRequest && (
        <DetailsModal
          request={detailRequest}
          onClose={() => setDetailRequest(null)}
          isAdmin={isAdmin}
          supabase={supabase}
          onCorrected={() => { setDetailRequest(null); loadRequests() }}
        />
      )}
      {editRequest && (
        <EditPaymentModal
          request={editRequest}
          isAdmin={isAdmin}
          supabase={supabase}
          onClose={() => setEditRequest(null)}
          onSaved={() => { setEditRequest(null); loadRequests() }}
        />
      )}
      {deleteRequest && (
        <DeleteConfirmModal
          request={deleteRequest}
          supabase={supabase}
          onClose={() => setDeleteRequest(null)}
          onDeleted={() => { setDeleteRequest(null); loadRequests() }}
        />
      )}

    </FinanceLayout>
  )
}

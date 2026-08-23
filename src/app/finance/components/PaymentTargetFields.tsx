'use client'

// ── Payment target selector ───────────────────────────────────────────────────
// The choice at the top of a payment request form, plus the search-first
// selector the linked target needs. Shared by the submission modal and the
// owner's edit modal so a correction offers exactly the same options, the same
// search and the same clearing rule as the original submission.
//
// TWO CHOICES, NOT THREE. Order Request was the third and is retired: no new
// payment may name one, and the database refuses the write (20261007000000 §3).
// Money that belongs to a PI Draft is recorded as New Order money and ALLOCATED
// to the PI afterwards — a PI is reached through the allocation table, not
// through a linkage column on the payment row.
//
// Presentational + query only. Every rule it appears to enforce is enforced
// server-side as well and independently: RLS decides which Orders are visible at
// all, and finance_payment_requests_derive_target re-derives the target and the
// client name from the locked row. This component exists so the reader is told
// BEFORE a round trip, never so the server can trust it.

import { useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { formatINR } from '@/lib/currency'
import {
  PAYMENT_TARGET_OPTIONS,
  switchTarget,
  type ConfirmedOrderOption,
  type PaymentTargetState,
  type SelectablePaymentTargetType,
} from '../paymentTargets'

// Status wording, so a result row says what state the Order is in rather than
// leaving the reader to infer it from the number.
const ORDER_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  running:            { label: 'Running',            color: '#1E40AF' },
  on_hold:            { label: 'On Hold',            color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch', color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',         color: '#166534' },
  cancelled:          { label: 'Cancelled',          color: '#991B1B' },
}

const SECTION_LABEL: React.CSSProperties = {
  fontSize: '10px', fontWeight: 700, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '10px',
}

const FIELD_LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

const SEARCH_BOX: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '6px',
  background: colors.raised, border: `1px solid ${colors.border}`,
  borderRadius: '6px', padding: '5px 10px',
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.muted}
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

// The chosen record, shown instead of the search once something is selected.
// "Change" reopens the search; it does NOT switch target, so the reader can
// correct a mis-pick without losing the rest of the form.
function SelectedRecord({
  kind, number, clientName, onChange, disabled,
}: {
  kind: string
  number: string
  clientName: string
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
      padding: '7px 10px', borderRadius: '7px',
      background: colors.blueTint, border: '1px solid rgba(85,133,232,0.25)',
    }}>
      <div style={{ minWidth: 0 }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted, marginRight: '6px' }}>{kind}</span>
        <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{number}</span>
        <span style={{ fontSize: '12px', color: colors.secondary, marginLeft: '8px', wordBreak: 'break-word' }}>{clientName}</span>
      </div>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        className="boe-btn boe-btn-ghost"
        style={{ padding: '2px 8px', fontSize: '11px', flexShrink: 0 }}
      >
        Change
      </button>
    </div>
  )
}

// One result row. Deliberately identical in shape for both record kinds — the
// leading badge is what tells them apart, not the layout.
function ResultRow({
  number, clientName, statusLabel, statusColor, amount, last, onSelect,
}: {
  number: string
  clientName: string
  statusLabel: string
  statusColor: string
  amount: number | null
  last: boolean
  onSelect: () => void
}) {
  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}
      style={{
        padding: '8px 12px',
        borderBottom: last ? 'none' : `1px solid ${colors.border}`,
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = colors.raised }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>{number}</span>
          <span style={{ fontSize: '11px', fontWeight: 600, color: statusColor }}>{statusLabel}</span>
        </div>
        <div style={{ fontSize: '12px', color: colors.secondary, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {clientName}
        </div>
      </div>
      {amount != null && (
        <div style={{ fontSize: '12px', fontWeight: 600, color: colors.primary, flexShrink: 0 }}>
          {formatINR(amount)}
        </div>
      )}
    </div>
  )
}

export function PaymentTargetFields({
  supabase,
  value,
  onChange,
  disabled,
  /** Hidden for a record whose target is frozen (an approved payment). */
  readOnlyNote,
}: {
  supabase: ReturnType<typeof createClient>
  value: PaymentTargetState
  onChange: (next: PaymentTargetState) => void
  disabled?: boolean
  readOnlyNote?: string
}) {
  const [query, setQuery]         = useState('')
  const [searching, setSearching] = useState(false)
  const [orderResults, setOrderResults] = useState<ConfirmedOrderOption[]>([])
  // Only the newest search may write results: a slow earlier query must never
  // overwrite a later one with stale rows.
  const searchToken = useRef(0)

  const clearResults = () => { setOrderResults([]) }

  const selectTarget = (target: SelectablePaymentTargetType) => {
    if (disabled || target === value.target) return
    setQuery('')
    clearResults()
    onChange(switchTarget(value, target))
  }

  const runSearch = async (raw: string) => {
    setQuery(raw)
    // Typing again abandons the current selection: the client name follows the
    // selected record, so a stale selection behind a fresh search would be a
    // silent mismatch.
    onChange({ ...value, selectedOrder: null })
    const trimmed = raw.trim()
    if (!trimmed) { clearResults(); return }

    const token = ++searchToken.current
    setSearching(true)

    // ONE SEARCH, AND ONLY CONFIRMED ORDERS. The Order Request branch that used
    // to sit beside this is gone: it searched `order_requests` for a target no
    // new payment may name. Preserved verbatim otherwise.
    const { data } = await supabase
      .from('orders')
      .select('id, display_number, client_name, total_value, status')
      .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
      .not('status', 'in', '(cancelled)')
      .order('created_at', { ascending: false })
      .limit(20)
    if (token !== searchToken.current) return
    setOrderResults((data ?? []) as ConfirmedOrderOption[])
    setSearching(false)
  }

  const pickOrder = (o: ConfirmedOrderOption) => {
    clearResults()
    onChange({ ...value, selectedOrder: o })
  }

  const reopenSearch = () => {
    setQuery('')
    clearResults()
    onChange({ ...value, selectedOrder: null })
  }

  const linked  = value.target !== 'unallocated'
  const noHits  = query.trim() !== '' && !searching && orderResults.length === 0

  return (
    <div>
      <div style={SECTION_LABEL}>Payment Against</div>

      {/* Explicit choices, one card each. They are business stages, not shades
          of one — so they stay equal cards rather than a toggle with a
          sub-option, and the grid follows however many there are rather than
          hard-coding a count that a retirement would leave stretched. */}
      <div
        role="radiogroup"
        aria-label="Payment target"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${PAYMENT_TARGET_OPTIONS.length}, 1fr)`,
          gap: '8px', marginBottom: '10px',
        }}
      >
        {PAYMENT_TARGET_OPTIONS.map(opt => {
          const active = value.target === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => selectTarget(opt.value)}
              disabled={disabled}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
                gap: '2px', padding: '8px 10px', borderRadius: '7px',
                cursor: disabled ? 'not-allowed' : 'pointer',
                border: active ? '1.5px solid #DC1F2E' : `1px solid ${colors.border}`,
                background: active ? 'rgba(220,31,46,0.04)' : colors.raised,
                textAlign: 'left', minWidth: 0,
              }}
            >
              <span style={{ fontSize: '12px', fontWeight: 600, color: active ? '#DC1F2E' : colors.primary }}>
                {opt.label}
              </span>
              <span style={{ fontSize: '10.5px', color: colors.muted, lineHeight: 1.35 }}>
                {opt.description}
              </span>
            </button>
          )
        })}
      </div>

      {readOnlyNote && (
        <div style={{ fontSize: '11px', color: colors.muted, marginBottom: '8px', lineHeight: 1.5 }}>
          {readOnlyNote}
        </div>
      )}

      {linked && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={FIELD_LABEL}>
            Select Confirmed Order
            <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>
          </label>

          {value.selectedOrder ? (
            <SelectedRecord
              kind="Confirmed Order"
              number={value.selectedOrder.display_number}
              clientName={value.selectedOrder.client_name}
              onChange={reopenSearch}
              disabled={disabled}
            />
          ) : (
            <>
              {/* Search-first: nothing is loaded until something is typed, so a
                  form open on the wrong target never pulls a ledger down. */}
              <div style={SEARCH_BOX}>
                <SearchIcon />
                <input
                  type="text"
                  value={query}
                  disabled={disabled}
                  onChange={e => runSearch(e.target.value)}
                  placeholder="Search by order number or client…"
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary }}
                />
                {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
              </div>

              {orderResults.length > 0 && (
                <div style={{
                  border: `1px solid ${colors.border}`, borderRadius: '7px', overflow: 'hidden',
                  maxHeight: '180px', overflowY: 'auto', marginTop: '4px',
                }}>
                  {orderResults.map((o, idx) => {
                    const meta = ORDER_STATUS_LABEL[o.status] ?? { label: o.status, color: colors.muted }
                    return (
                      <ResultRow
                        key={o.id}
                        number={o.display_number}
                        clientName={o.client_name}
                        statusLabel={meta.label}
                        statusColor={meta.color}
                        amount={o.total_value}
                        last={idx === orderResults.length - 1}
                        onSelect={() => pickOrder(o)}
                      />
                    )
                  })}
                </div>
              )}

              {noHits && (
                <div style={{ fontSize: '12px', color: colors.muted, padding: '6px 0', lineHeight: 1.5 }}>
                  No orders found for &ldquo;{query.trim()}&rdquo;.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

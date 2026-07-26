'use client'

// ── Payment target selector ───────────────────────────────────────────────────
// The three-way choice at the top of a payment request form, plus the search-
// first selector the two linked targets need. Shared by the submission modal and
// the owner's edit modal so a correction offers exactly the same three options,
// the same searches and the same clearing rule as the original submission.
//
// Presentational + query only. Every rule it appears to enforce is enforced
// server-side as well and independently: RLS decides which Order Requests are
// visible at all, and finance_payment_requests_derive_target re-derives the
// target, the request number and the client name from the locked row. This
// component exists so the reader is told BEFORE a round trip, never so the
// server can trust it.

import { useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { formatINR } from '@/lib/currency'
import {
  ORDER_REQUEST_SELECTABLE_STATUSES,
  PAYMENT_TARGET_OPTIONS,
  switchTarget,
  type ConfirmedOrderOption,
  type OrderRequestOption,
  type PaymentTargetState,
  type PaymentTargetType,
} from '../paymentTargets'

// Status wording for the two record kinds, so a result row says what state the
// record is in rather than leaving the reader to infer it from the number.
const ORDER_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  running:            { label: 'Running',            color: '#1E40AF' },
  on_hold:            { label: 'On Hold',            color: '#9A3412' },
  ready_for_dispatch: { label: 'Ready for Dispatch', color: '#5B21B6' },
  dispatched:         { label: 'Dispatched',         color: '#166534' },
  cancelled:          { label: 'Cancelled',          color: '#991B1B' },
}

const REQUEST_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  submitted:           { label: 'Submitted',           color: '#92400E' },
  needs_clarification: { label: 'Needs Clarification', color: '#9A3412' },
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
  const [orderResults,   setOrderResults]   = useState<ConfirmedOrderOption[]>([])
  const [requestResults, setRequestResults] = useState<OrderRequestOption[]>([])
  // Only the newest search may write results: a slow earlier query must never
  // overwrite a later one with stale rows.
  const searchToken = useRef(0)

  const clearResults = () => { setOrderResults([]); setRequestResults([]) }

  const selectTarget = (target: PaymentTargetType) => {
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
    onChange({ ...value, selectedRequest: null, selectedOrder: null })
    const trimmed = raw.trim()
    if (!trimmed) { clearResults(); return }

    const token = ++searchToken.current
    setSearching(true)

    if (value.target === 'confirmed_order') {
      // Preserved verbatim from the original Confirmed Order search.
      const { data } = await supabase
        .from('orders')
        .select('id, display_number, client_name, total_value, status')
        .or(`display_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
        .not('status', 'in', '(cancelled)')
        .order('created_at', { ascending: false })
        .limit(20)
      if (token !== searchToken.current) return
      setOrderResults((data ?? []) as ConfirmedOrderOption[])
    } else {
      // Only requests this viewer may actually use. Three independent filters,
      // each of which the database also applies:
      //   * RLS — a non-admin sees only requests they created, are the requester
      //     of, or are assigned to (order_requests_requester_select /
      //     _assignee_select, 20260707);
      //   * finalized_at — an upload-stage draft (20260711) is not a submitted
      //     request and must never be offered;
      //   * status — active only. derive_target refuses anything else.
      const { data } = await supabase
        .from('order_requests')
        .select('id, request_number, client_name, total_value, status')
        .or(`request_number.ilike.%${trimmed}%,client_name.ilike.%${trimmed}%`)
        .in('status', ORDER_REQUEST_SELECTABLE_STATUSES as unknown as string[])
        .not('finalized_at', 'is', null)
        .order('created_at', { ascending: false })
        .limit(20)
      if (token !== searchToken.current) return
      setRequestResults((data ?? []) as OrderRequestOption[])
    }
    setSearching(false)
  }

  const pickRequest = (r: OrderRequestOption) => {
    clearResults()
    onChange({ ...value, selectedRequest: r, selectedOrder: null })
  }

  const pickOrder = (o: ConfirmedOrderOption) => {
    clearResults()
    onChange({ ...value, selectedOrder: o, selectedRequest: null })
  }

  const reopenSearch = () => {
    setQuery('')
    clearResults()
    onChange({ ...value, selectedRequest: null, selectedOrder: null })
  }

  const linked  = value.target !== 'unallocated'
  const results = value.target === 'confirmed_order' ? orderResults : requestResults
  const noHits  = query.trim() !== '' && !searching && results.length === 0

  return (
    <div>
      <div style={SECTION_LABEL}>Payment Against</div>

      {/* Three explicit choices. They are three business stages, not three
          shades of one — so they are three equal cards, never a two-way toggle
          with a sub-option. */}
      <div
        role="radiogroup"
        aria-label="Payment target"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '10px' }}
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
            {value.target === 'order_request' ? 'Select Order Request' : 'Select Confirmed Order'}
            <span style={{ color: colors.red, marginLeft: '2px' }}>*</span>
          </label>

          {value.target === 'order_request' && value.selectedRequest ? (
            <SelectedRecord
              kind="Order Request"
              number={value.selectedRequest.request_number}
              clientName={value.selectedRequest.client_name}
              onChange={reopenSearch}
              disabled={disabled}
            />
          ) : value.target === 'confirmed_order' && value.selectedOrder ? (
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
                  placeholder={value.target === 'order_request'
                    ? 'Search by request number or client…'
                    : 'Search by order number or client…'}
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '12px', color: colors.primary }}
                />
                {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
              </div>

              {results.length > 0 && (
                <div style={{
                  border: `1px solid ${colors.border}`, borderRadius: '7px', overflow: 'hidden',
                  maxHeight: '180px', overflowY: 'auto', marginTop: '4px',
                }}>
                  {value.target === 'order_request'
                    ? requestResults.map((r, idx) => {
                        const meta = REQUEST_STATUS_LABEL[r.status] ?? { label: r.status, color: colors.muted }
                        return (
                          <ResultRow
                            key={r.id}
                            number={r.request_number}
                            clientName={r.client_name}
                            statusLabel={meta.label}
                            statusColor={meta.color}
                            amount={r.total_value}
                            last={idx === requestResults.length - 1}
                            onSelect={() => pickRequest(r)}
                          />
                        )
                      })
                    : orderResults.map((o, idx) => {
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
                  {value.target === 'order_request'
                    ? `No open Order Request matches “${query.trim()}”. Only requests you can access, that are still awaiting approval, can be selected.`
                    : `No orders found for “${query.trim()}”.`}
                </div>
              )}
            </>
          )}

          {/* Stated once the record is chosen, because it is the moment the
              reader stops being able to type the client name themselves. */}
          {value.target === 'order_request' && value.selectedRequest && (
            <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.5 }}>
              This payment will appear on {value.selectedRequest.request_number} straight away, marked pending until an admin approves it.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

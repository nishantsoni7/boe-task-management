'use client'

// ── Allocating an already-received payment across many targets, atomically ───
//
// ONE RPC, ONE CALL. allocate_payment_to_targets (20261011000000 §4) calls the
// single-target implementation once per row inside ONE transaction — a
// refusal on any row unwinds the whole submission, so there is never a
// partial split left committed here. This is the requirement's "single
// submit button ... ONE call, atomic".
//
// OFFERED ONLY WHILE THERE IS SOMETHING LEFT TO GIVE. The caller (Received
// Payments) shows this modal for a Confirmed Payment whose
// confirmed_allocation_status is 'zero' or 'partial'. A 'full' payment has
// nothing left to allocate, so the control is not offered at all. An 'over'
// payment is ALSO not offered here: it is already invalid data — the excess
// is exactly what CONFIRMED_ALLOCATION_BADGE flags for Admin review — and
// letting somebody add a further allocation on top of an already-exceeded
// payment would let the same defect compound instead of surfacing it for a
// person to look at. The Delete Payment action remains available for an
// 'over' row (Requirement 4), which is the correct next step for it.
//
// THE SEARCH, THE ROW SHAPE AND THE ERROR MAPPING ARE NOT REINVENTED.
// searchAllocationTargets / loadTargetPosition / KindBadge / statusLabel /
// allocationErrorMessage all come from AllocatePaymentModal.tsx — the
// existing single-target flow's own pieces, which already implement "search
// an Order or a PI Draft, under this reader's own RLS" exactly once.
// SplitAllocationRow / EMPTY_ALLOCATION_ROW / targetKey / duplicateTargetKeys
// / toRpcAllocations come from splitPaymentEntry.ts — RecordSplitPaymentModal's
// own row bookkeeping for "several targets, one form, live totals" against a
// different RPC. Both are reused here rather than restated a third time.

import { useRef, useState } from 'react'
import type { createClient } from '@/lib/supabase/client'
import { colors } from '@/lib/tokens'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { sanitizeAmountInput, isValidAmount } from '@/lib/currency'
import {
  ZERO,
  addExact,
  exactToString,
  isNegative,
  isZero,
  parseExact,
  subtractExact,
} from '@/lib/finance/exactMoney'
import {
  EMPTY_ALLOCATION_ROW,
  duplicateTargetKeys,
  targetKey,
  toRpcAllocations,
  type SplitAllocationRow,
} from '@/lib/finance/splitPaymentEntry'
import {
  KindBadge,
  allocationErrorMessage,
  loadTargetPosition,
  searchAllocationTargets,
  statusLabel,
  type AllocationCandidate,
  type TargetPosition,
} from './AllocatePaymentModal'

export const ALLOCATE_FUNDS_MODAL_TITLE = 'Allocate Funds'
/** The label on the control that opens this. Named once so tests read the product's word. */
export const ALLOCATE_FUNDS_ACTION_LABEL = 'Allocate Funds'
export const ALLOCATE_FULL_REMAINING_LABEL = 'Allocate Full Remaining'

let rowSeq = 0
const nextRowKey = () => `fund-alloc-${++rowSeq}`

export type AllocateFundsPayment = {
  id: string
  human_payment_id: string
  amount: number
  /** Every ACTIVE allocation this payment already carries, summed. */
  allocated_total: string | number | null
  client_name?: string | null
}

function rowsTotal(rows: readonly SplitAllocationRow[]) {
  let total = ZERO
  for (const row of rows) {
    if (!isValidAmount(row.amount)) continue
    const parsed = parseExact(row.amount)
    if (parsed) total = addExact(total, parsed)
  }
  return total
}

/** payment.amount − payment.allocated_total − the rows entered so far. Exact, and NEVER floored: a negative value is exactly the "would go over" fact the form must show and block on. */
export function allocateFundsRemaining(
  payment: AllocateFundsPayment,
  rows: readonly SplitAllocationRow[],
): string {
  const amount = parseExact(payment.amount) ?? ZERO
  const existing = parseExact(payment.allocated_total) ?? ZERO
  const spent = addExact(existing, rowsTotal(rows))
  return exactToString(subtractExact(amount, spent))
}

/** Why the submit button is disabled, in one sentence, or null when it is not. */
export function allocateFundsBlockedReason(input: {
  payment: AllocateFundsPayment
  rows: readonly SplitAllocationRow[]
}): string | null {
  const filled = input.rows.filter(r => r.kind || r.targetId || r.amount.trim())
  if (filled.length === 0) return 'Add at least one allocation.'

  for (let i = 0; i < filled.length; i++) {
    const row = filled[i]
    if (!row.kind || !row.targetId) {
      return `Choose an Order or a PI Draft for allocation ${i + 1}, or remove it.`
    }
    if (!isValidAmount(row.amount)) {
      return `Enter an amount for allocation ${i + 1}, in rupees and paise.`
    }
    const parsed = parseExact(row.amount)
    if (!parsed || isZero(parsed) || isNegative(parsed)) {
      return `Allocation ${i + 1} must be a positive amount.`
    }
  }

  const duplicates = duplicateTargetKeys(filled)
  if (duplicates.size > 0) {
    return 'The same Order or PI Draft is listed twice. One payment can hold only one allocation per record — combine the two rows.'
  }

  const remaining = parseExact(allocateFundsRemaining(input.payment, filled))
  if (remaining && isNegative(remaining)) {
    return 'The allocations total more than this payment has left unallocated. Reduce a row.'
  }

  return null
}

// ── The modal ─────────────────────────────────────────────────────────────────

export function AllocateFundsModal({
  payment,
  supabase,
  onClose,
  onAllocated,
}: {
  payment: AllocateFundsPayment
  supabase: ReturnType<typeof createClient>
  onClose: () => void
  /** Re-read just this payment's own row. Called only on a settled success. */
  onAllocated: () => void
}) {
  const [rows, setRows] = useState<SplitAllocationRow[]>([EMPTY_ALLOCATION_ROW(nextRowKey())])
  const [pickerFor, setPickerFor] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const existingAllocated = exactToString(parseExact(payment.allocated_total) ?? ZERO)
  const newTotal = exactToString(rowsTotal(rows))
  const remaining = allocateFundsRemaining(payment, rows)
  const remainingParsed = parseExact(remaining) ?? ZERO
  const remainingIsNegative = isNegative(remainingParsed)
  const blocked = allocateFundsBlockedReason({ payment, rows })
  const duplicates = duplicateTargetKeys(rows)

  const patchRow = (key: string, patch: Partial<SplitAllocationRow>) => {
    setError(null)
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  const removeRow = (key: string) => {
    setError(null)
    setRows(prev => {
      const next = prev.filter(r => r.key !== key)
      return next.length > 0 ? next : [EMPTY_ALLOCATION_ROW(nextRowKey())]
    })
  }

  // Fills the LAST row with whatever remains, computed EXCLUDING that row's
  // own current amount — filling it must not double-count what is already
  // typed into it.
  const fillRemaining = () => {
    setError(null)
    setRows(prev => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      const withoutLast = prev.slice(0, -1)
      const spare = parseExact(allocateFundsRemaining(payment, withoutLast))
      const value = spare && !isNegative(spare) && !isZero(spare) ? exactToString(spare) : '0'
      return prev.map(r => (r.key === last.key ? { ...r, amount: value } : r))
    })
  }

  const handleAllocate = async () => {
    if (blocked || saving) return
    setSaving(true)
    setError(null)

    const targets = toRpcAllocations(rows).map(t => ({
      order_submission_id: t.kind === 'submission' ? t.id : null,
      order_id: t.kind === 'order' ? t.id : null,
      allocated_amount: t.amount,
    }))

    // ONE CALL. Every row lands together, or none does.
    const { error: rpcError } = await supabase.rpc('allocate_payment_to_targets', {
      p_payment_request_id: payment.id,
      p_targets: targets,
    })

    setSaving(false)
    if (rpcError) { setError(allocationErrorMessage(rpcError.message)); return }
    onAllocated()
  }

  return (
    <FinanceModal
      title={ALLOCATE_FUNDS_MODAL_TITLE}
      onClose={onClose}
      width="700px"
      closeOnBackdropClick={!saving}
    >
      <div style={{ fontSize: '12px', color: colors.secondary, lineHeight: 1.55 }}>
        Divide what is left of {payment.client_name ?? 'this payment'}&apos;s payment across up to 20
        Orders or PI Drafts, in one submission. A refusal on any row leaves every row exactly as it
        was — nothing partial is ever saved.
      </div>

      <div style={{
        background: colors.raised, border: `1px solid ${colors.border}`, borderRadius: '8px',
        padding: '12px 14px', display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px',
      }}>
        <Figure label="Payment amount" value={formatMoney(payment.amount)} />
        <Figure label="Existing allocated" value={formatMoney(existingAllocated)} />
        <Figure label="New allocation total" value={formatMoney(newTotal)} />
        <Figure
          label={remainingIsNegative ? 'Over by' : 'Remaining unallocated'}
          value={formatMoney(remainingIsNegative ? remaining.replace('-', '') : remaining)}
          strong
          tone={remainingIsNegative ? colors.red : undefined}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <span style={LABEL}>Allocations</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={fillRemaining}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '12px' }}
          >
            {ALLOCATE_FULL_REMAINING_LABEL}
          </button>
          <button
            type="button"
            onClick={() => setRows(prev => [...prev, EMPTY_ALLOCATION_ROW(nextRowKey())])}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '12px' }}
            disabled={rows.length >= 20}
          >
            + Add allocation
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {rows.map((row, index) => (
          <FundsAllocationRow
            key={row.key}
            row={row}
            index={index}
            supabase={supabase}
            duplicate={Boolean(targetKey(row) && duplicates.has(targetKey(row) as string))}
            picking={pickerFor === row.key}
            onPick={() => setPickerFor(row.key)}
            onClosePicker={() => setPickerFor(null)}
            onChange={patch => patchRow(row.key, patch)}
            onRemove={() => removeRow(row.key)}
          />
        ))}
      </div>

      {blocked && !error && (
        <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>{blocked}</div>
      )}

      {error && (
        <div role="alert" style={{
          fontSize: '12px', color: colors.red, background: colors.redTint,
          border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '8px 12px', lineHeight: 1.5,
        }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
        <button onClick={onClose} disabled={saving} className="boe-btn boe-btn-ghost" style={{ padding: '8px 18px', fontSize: '13px' }}>
          Cancel
        </button>
        <button
          onClick={handleAllocate}
          disabled={blocked !== null || saving}
          className="boe-btn boe-btn-primary"
          style={{
            padding: '8px 18px', fontSize: '13px',
            opacity: (blocked !== null || saving) ? 0.6 : 1,
            cursor: (blocked !== null || saving) ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Allocating…' : ALLOCATE_FUNDS_ACTION_LABEL}
        </button>
      </div>
    </FinanceModal>
  )
}

// ── One destination row — the same picker the single-target Allocate control
// and Record Payment already use. ──────────────────────────────────────────

function FundsAllocationRow({
  row, index, supabase, duplicate, picking, onPick, onClosePicker, onChange, onRemove,
}: {
  row: SplitAllocationRow
  index: number
  supabase: ReturnType<typeof createClient>
  duplicate: boolean
  picking: boolean
  onPick: () => void
  onClosePicker: () => void
  onChange: (patch: Partial<SplitAllocationRow>) => void
  onRemove: () => void
}) {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<AllocationCandidate[]>([])
  const [position, setPosition] = useState<TargetPosition | null>(null)
  // Only the newest search may write results: a slow earlier query must never
  // overwrite a later one with stale rows.
  const searchToken = useRef(0)

  const runSearch = async (raw: string) => {
    setQuery(raw)
    const term = raw.trim()
    if (!term) { setResults([]); return }
    const token = ++searchToken.current
    setSearching(true)
    const found = await searchAllocationTargets(supabase, term)
    if (token !== searchToken.current) return
    setResults(found)
    setSearching(false)
  }

  const choose = async (candidate: AllocationCandidate) => {
    onChange({
      kind: candidate.kind,
      targetId: candidate.id,
      targetLabel: `${candidate.reference} · ${candidate.clientName}`,
    })
    setResults([])
    setQuery('')
    onClosePicker()
    setPosition(null)
    setPosition(await loadTargetPosition(supabase, candidate))
  }

  return (
    <div style={{
      border: `1px solid ${duplicate ? colors.red : colors.border}`,
      borderRadius: '8px', padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ ...LABEL, minWidth: '58px' }}>Row {index + 1}</span>

        {row.targetId && row.kind ? (
          <>
            <KindBadge kind={row.kind} />
            <span style={{
              fontSize: '13px', fontWeight: 600, color: colors.primary,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {row.targetLabel}
            </span>
            <button
              type="button"
              onClick={() => { onChange({ kind: null, targetId: null, targetLabel: null }); setPosition(null); onPick() }}
              className="boe-btn boe-btn-ghost"
              style={{ padding: '3px 9px', fontSize: '11px' }}
            >
              Change
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onPick}
            className="boe-btn boe-btn-ghost"
            style={{ padding: '4px 10px', fontSize: '12px' }}
          >
            Choose an Order or PI Draft
          </button>
        )}

        <input
          className="boe-input"
          inputMode="decimal"
          aria-label={`Amount for allocation ${index + 1}`}
          value={row.amount}
          onChange={e => onChange({ amount: sanitizeAmountInput(e.target.value) })}
          placeholder="0.00"
          style={{ marginLeft: 'auto', width: '130px', textAlign: 'right' }}
        />

        <button
          type="button"
          onClick={onRemove}
          className="boe-btn boe-btn-ghost"
          aria-label={`Remove allocation ${index + 1}`}
          style={{ padding: '3px 9px', fontSize: '11px' }}
        >
          Remove
        </button>
      </div>

      {row.targetId && position && (
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '11.5px', color: colors.secondary }}>
          <span>
            Already received{' '}
            <strong style={{ color: colors.primary }}>
              {position.received === null ? 'Not visible to you' : formatMoney(position.received)}
            </strong>
          </span>
          <span>
            Still outstanding{' '}
            <strong style={{ color: colors.primary }}>
              {position.outstanding === null ? '—' : formatMoney(position.outstanding)}
            </strong>
          </span>
        </div>
      )}

      {duplicate && (
        <div style={{ fontSize: '11.5px', color: colors.red, lineHeight: 1.5 }}>
          This record is already named by another row. One payment holds one allocation per record —
          combine the two.
        </div>
      )}

      {picking && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            background: colors.raised, border: `1px solid ${colors.border}`,
            borderRadius: '6px', padding: '6px 10px',
          }}>
            <input
              type="text"
              autoFocus
              value={query}
              onChange={e => runSearch(e.target.value)}
              placeholder="Order number, PI reference or client name…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: colors.primary }}
            />
            {searching && <span style={{ fontSize: '11px', color: colors.muted }}>Searching…</span>}
          </div>

          {results.length > 0 && (
            <div style={{
              border: `1px solid ${colors.border}`, borderRadius: '8px', overflow: 'hidden',
              maxHeight: '200px', overflowY: 'auto',
            }}>
              {results.map((candidate, i) => (
                <button
                  key={`${candidate.kind}-${candidate.id}`}
                  type="button"
                  onClick={() => choose(candidate)}
                  style={{
                    display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between',
                    gap: '12px', padding: '9px 12px', textAlign: 'left', cursor: 'pointer',
                    background: 'transparent', border: 'none',
                    borderBottom: i < results.length - 1 ? `1px solid ${colors.border}` : 'none',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <KindBadge kind={candidate.kind} />
                      <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary }}>
                        {candidate.reference}
                      </span>
                      <span style={{ fontSize: '11px', fontWeight: 600, color: colors.muted }}>
                        {statusLabel(candidate.status)}
                      </span>
                    </span>
                    <span style={{
                      display: 'block', fontSize: '12px', color: colors.secondary, marginTop: '2px',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {candidate.clientName}
                    </span>
                  </span>
                  <span style={{ fontSize: '13px', fontWeight: 700, color: colors.primary, flexShrink: 0 }}>
                    {candidate.value != null ? formatMoney(candidate.value) : '—'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {query.trim() !== '' && !searching && results.length === 0 && (
            <div style={{ fontSize: '12px', color: colors.muted, lineHeight: 1.5 }}>
              Nothing you can allocate to matches &ldquo;{query.trim()}&rdquo;. Only Orders and PI
              Drafts you may open are offered.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Small pieces ──────────────────────────────────────────────────────────────

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted,
  textTransform: 'uppercase', letterSpacing: '0.05em',
}

function Figure({ label, value, strong, tone }: {
  label: string
  value: string
  strong?: boolean
  tone?: string
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '10px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{
        fontSize: strong ? '15px' : '13px',
        fontWeight: strong ? 700 : 600,
        color: tone ?? colors.primary,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {value}
      </div>
    </div>
  )
}

'use client'

// ── Reimbursement: record one over several expenses, open one, reverse one ───
//
// Every write goes through ONE database function, so a batch and all of its
// expense links are saved together or not at all:
//
//   record_expense_reimbursement()   locks the selected expenses, refuses a
//                                    mixed or stale selection, writes the batch
//   reverse_expense_reimbursement()  keeps the batch, records who reversed it
//                                    and why, returns its expenses to pending
//
// There is no toggle that un-reimburses an expense in place; a correction is a
// reversal with a reason, and both the original and the reversal stay on record.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { colors } from '@/lib/tokens'
import type { createClient } from '@/lib/supabase/client'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { formatMoney, localTodayIso } from '@/lib/finance/piPaymentView'
import { expensePaymentModeLabel, type ExpenseListRow, type ExpenseRow } from '@/lib/finance/expenses'
import {
  REIMBURSEMENT_NOTE_MAX,
  REIMBURSEMENT_REFERENCE_MAX,
  REIMBURSEMENT_STATE_LABEL,
  friendlyReimbursementError,
  reimbursementSelectionProblem,
  reimbursementState,
  selectionTotal,
  validateReimbursementForm,
  selectionPayer,
  type ExpenseReimbursementReceipt,
  type ExpenseReimbursementRow,
  type ReimbursementFormState,
} from '@/lib/finance/expenseReimbursements'
import { ExpenseBills } from './ExpenseBills'

type Supabase = ReturnType<typeof createClient>

function fmtExpenseDate(value: string | null | undefined): string {
  if (!value) return '—'
  const at = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  if (Number.isNaN(at.getTime())) return value
  return at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

const LABEL: React.CSSProperties = {
  fontSize: '11px', fontWeight: 600, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em',
}

// ── Record ───────────────────────────────────────────────────────────────────

export function RecordReimbursementModal({
  supabase,
  rows,
  personName,
  onClose,
  onRecorded,
}: {
  supabase: Supabase
  rows: readonly ExpenseListRow[]
  personName: (id: string | null | undefined) => string
  onClose: () => void
  onRecorded: (result: { reimbursementId: string; count: number; total: string }) => void
}) {
  const todayIso = useMemo(() => localTodayIso(), [])
  const [form, setForm] = useState<ReimbursementFormState>({ reimbursedOn: todayIso, reference: '', note: '' })
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const total = selectionTotal(rows)
  const selectionProblem = reimbursementSelectionProblem(rows)
  const errors = validateReimbursementForm(form, todayIso)
  const shown = submitted ? errors : {}
  const payer = selectionPayer(rows)

  const confirm = async () => {
    setSubmitted(true)
    if (inFlight.current || selectionProblem || Object.keys(errors).length > 0) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const { data, error: rpcError } = await supabase.rpc('record_expense_reimbursement', {
        p_expense_ids: rows.map(r => r.id),
        p_reimbursed_on: form.reimbursedOn,
        p_reference: form.reference.trim(),
        // WHAT THE PERSON IS LOOKING AT. The database refuses the batch if the
        // amounts no longer add up to this.
        p_expected_total: total,
        p_note: form.note.trim() === '' ? null : form.note.trim(),
      })
      if (rpcError) { setError(friendlyReimbursementError(rpcError)); return }
      const result = data as { reimbursement_id: string; expense_count: number; total_amount: string | number }
      onRecorded({ reimbursementId: result.reimbursement_id, count: result.expense_count, total: String(result.total_amount) })
    } catch {
      setError('The reimbursement could not be saved. Nothing was recorded — check your connection and try again.')
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <FinanceModal title="Record reimbursement" onClose={onClose} width="600px" closeOnBackdropClick={false}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} data-testid="record-reimbursement">
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap',
          padding: '10px 12px', borderRadius: '10px', border: `1px solid ${colors.border}`, background: colors.raised,
        }}>
          <span style={{ fontSize: '12.5px', color: colors.secondary }}>
            {rows.length} {rows.length === 1 ? 'expense' : 'expenses'}
            {payer ? ` · to ${personName(payer)}` : ' · more than one payer'}
          </span>
          <span style={{ fontSize: '17px', fontWeight: 700, color: colors.primary, fontVariantNumeric: 'tabular-nums' }}>
            {formatMoney(total)}
          </span>
        </div>

        <ul aria-label="Expenses in this reimbursement" style={{
          listStyle: 'none', margin: 0, padding: 0, maxHeight: '240px', overflowY: 'auto',
          border: `1px solid ${colors.border}`, borderRadius: '10px',
        }}>
          {rows.map(row => (
            <li key={row.id} style={{
              display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 12px',
              borderBottom: `1px solid ${colors.border}`,
            }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '12.5px', color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.paid_to}
                </span>
                <span style={{ display: 'block', fontSize: '11px', color: colors.muted }}>
                  {fmtExpenseDate(row.expense_date)} · paid by {personName(row.paid_by)}
                </span>
              </span>
              <span style={{ fontSize: '13px', fontWeight: 600, color: colors.primary, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {formatMoney(row.amount)}
              </span>
            </li>
          ))}
        </ul>

        {selectionProblem && <div role="alert" style={{ fontSize: '12px', color: '#C13030' }}>{selectionProblem}</div>}

        <div className="expense-form-row">
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
            <span style={LABEL}>Reimbursement date<span style={{ color: colors.red }} aria-hidden="true">*</span></span>
            <input type="date" className="boe-input" value={form.reimbursedOn} max={todayIso} disabled={saving}
              onChange={e => setForm(p => ({ ...p, reimbursedOn: e.target.value }))} />
            {shown.reimbursedOn && <span role="alert" style={{ fontSize: '12px', color: '#C13030' }}>{shown.reimbursedOn}</span>}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
            <span style={LABEL}>Challan / payment reference<span style={{ color: colors.red }} aria-hidden="true">*</span></span>
            <input className="boe-input" value={form.reference} maxLength={REIMBURSEMENT_REFERENCE_MAX + 20} disabled={saving}
              autoComplete="off" placeholder="e.g. UTR or challan no."
              onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} />
            {shown.reference && <span role="alert" style={{ fontSize: '12px', color: '#C13030' }}>{shown.reference}</span>}
          </label>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={LABEL}>Note <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>Optional</span></span>
          <input className="boe-input" value={form.note} maxLength={REIMBURSEMENT_NOTE_MAX + 20} disabled={saving}
            autoComplete="off" onChange={e => setForm(p => ({ ...p, note: e.target.value }))} />
          {shown.note && <span role="alert" style={{ fontSize: '12px', color: '#C13030' }}>{shown.note}</span>}
        </label>

        {error && (
          <div role="alert" style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(217,79,79,0.1)', color: '#C13030', fontSize: '12px', lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} disabled={saving} style={{ minHeight: '44px', fontSize: '13px' }}>
            Cancel
          </button>
          <button type="button" className="boe-btn boe-btn-primary" onClick={() => void confirm()} disabled={saving || !!selectionProblem}
            style={{ minHeight: '44px', fontSize: '13px', minWidth: '200px' }}>
            {saving ? 'Saving…' : `Confirm ${formatMoney(total)} reimbursed`}
          </button>
        </div>
      </div>
    </FinanceModal>
  )
}

// ── Open one reimbursement ───────────────────────────────────────────────────

type BatchItem = {
  id: string
  expense_id: string
  amount: string | number
  paid_by: string
  reversed_at: string | null
  expense: Pick<ExpenseRow, 'id' | 'expense_date' | 'paid_to' | 'remark'> | null
}

export function ReimbursementBatchModal({
  supabase,
  reimbursementId,
  personName,
  mayReverse,
  onClose,
  onReversed,
}: {
  supabase: Supabase
  reimbursementId: string
  personName: (id: string | null | undefined) => string
  mayReverse: boolean
  onClose: () => void
  onReversed: () => void
}) {
  const [batch, setBatch] = useState<ExpenseReimbursementRow | null>(null)
  const [items, setItems] = useState<BatchItem[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reversing, setReversing] = useState(false)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const fetchBatch = useCallback(async () => {
    const [{ data: b, error: bErr }, { data: its, error: iErr }] = await Promise.all([
      supabase.from('expense_reimbursements').select('*').eq('id', reimbursementId).maybeSingle(),
      supabase.from('expense_reimbursement_items')
        .select('id, expense_id, amount, paid_by, reversed_at, expense:expenses!expense_reimbursement_items_expense_id_fkey(id, expense_date, paid_to, remark)')
        .eq('reimbursement_id', reimbursementId)
        .order('created_at'),
    ])
    if (bErr || iErr || !b) return null
    const row = b as ExpenseReimbursementRow
    const list = (its ?? []) as unknown as BatchItem[]
    const ids = [...new Set([row.payer_id, row.recorded_by, row.reversed_by, ...list.map(i => i.paid_by)].filter((x): x is string => !!x))]
    const { data: users } = await supabase.from('users').select('id, full_name').in('id', ids)
    const people = new Map<string, string>(
      ((users ?? []) as { id: string; full_name: string | null }[]).map(u => [u.id, u.full_name ?? '']))
    return { row, list, people }
  }, [supabase, reimbursementId])

  const apply = useCallback((result: Awaited<ReturnType<typeof fetchBatch>>) => {
    if (!result) { setState('error'); return }
    setNames(result.people)
    setBatch(result.row)
    setItems(result.list)
    setState('ready')
  }, [])

  const load = useCallback(async () => { apply(await fetchBatch()) }, [fetchBatch, apply])

  useEffect(() => {
    let live = true
    void fetchBatch().then(result => { if (live) apply(result) })
    return () => { live = false }
  }, [fetchBatch, apply])

  const nameOf = (id: string | null | undefined) => (id && names.get(id)) || personName(id)

  const reverse = async () => {
    if (inFlight.current) return
    if (reason.trim() === '') { setError('Say why this reimbursement is being reversed.'); return }
    inFlight.current = true
    setSaving(true)
    setError(null)
    const { error: rpcError } = await supabase.rpc('reverse_expense_reimbursement', {
      p_reimbursement_id: reimbursementId, p_reason: reason.trim(),
    })
    inFlight.current = false
    setSaving(false)
    if (rpcError) { setError(friendlyReimbursementError(rpcError)); await load(); return }
    setReversing(false)
    await load()
    onReversed()
  }

  const shownItems = items.filter(i => batch?.status === 'reversed' || i.reversed_at === null)

  return (
    <FinanceModal title="Reimbursement" onClose={onClose} width="600px">
      <div data-testid="reimbursement-batch" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {state === 'loading' && <div style={{ fontSize: '12.5px', color: colors.muted }}>Loading…</div>}
        {state === 'error' && <div role="alert" style={{ fontSize: '12.5px', color: '#C13030' }}>This reimbursement could not be loaded.</div>}
        {state === 'ready' && batch && (
          <>
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(110px, auto) 1fr', gap: '6px 12px', fontSize: '12.5px' }}>
              <dt style={{ color: colors.muted }}>Status</dt>
              <dd style={{ margin: 0, fontWeight: 600, color: batch.status === 'reversed' ? '#C13030' : '#1F7A3F' }}>
                {batch.status === 'reversed' ? 'Reversed' : 'Reimbursed'}
              </dd>
              <dt style={{ color: colors.muted }}>Paid to</dt><dd style={{ margin: 0, fontWeight: 600 }}>{nameOf(batch.payer_id)}</dd>
              <dt style={{ color: colors.muted }}>Date</dt><dd style={{ margin: 0 }}>{fmtExpenseDate(batch.reimbursed_on)}</dd>
              <dt style={{ color: colors.muted }}>Reference</dt><dd style={{ margin: 0, wordBreak: 'break-word' }}>{batch.reference}</dd>
              <dt style={{ color: colors.muted }}>Total</dt>
              <dd style={{ margin: 0, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {formatMoney(batch.total_amount)} · {batch.expense_count} {batch.expense_count === 1 ? 'expense' : 'expenses'}
              </dd>
              <dt style={{ color: colors.muted }}>Recorded by</dt>
              <dd style={{ margin: 0 }}>{nameOf(batch.recorded_by)} · {fmtExpenseDate(batch.recorded_at)}</dd>
              {batch.note && (<><dt style={{ color: colors.muted }}>Note</dt><dd style={{ margin: 0 }}>{batch.note}</dd></>)}
              {batch.status === 'reversed' && (
                <>
                  <dt style={{ color: colors.muted }}>Reversed by</dt>
                  <dd style={{ margin: 0 }}>{nameOf(batch.reversed_by)} · {fmtExpenseDate(batch.reversed_at)}</dd>
                  <dt style={{ color: colors.muted }}>Reason</dt><dd style={{ margin: 0 }}>{batch.reversal_reason}</dd>
                </>
              )}
            </dl>

            <div>
              <div style={{ ...LABEL, marginBottom: '6px' }}>Expenses covered</div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${colors.border}`, borderRadius: '10px' }}>
                {shownItems.map(item => (
                  <li key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '8px 12px', borderBottom: `1px solid ${colors.border}` }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '12.5px', color: colors.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.expense?.paid_to ?? 'Expense'}
                      </span>
                      <span style={{ display: 'block', fontSize: '11px', color: colors.muted }}>
                        {fmtExpenseDate(item.expense?.expense_date)} · paid by {nameOf(item.paid_by)}
                      </span>
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatMoney(item.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>

            {error && <div role="alert" style={{ fontSize: '12px', color: '#C13030' }}>{error}</div>}

            {mayReverse && batch.status === 'recorded' && (
              reversing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 12px', border: `1px solid ${colors.border}`, borderRadius: '10px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={LABEL}>Why is it being reversed?</span>
                    <input className="boe-input" value={reason} maxLength={500} disabled={saving} autoComplete="off"
                      placeholder="e.g. wrong reference entered" onChange={e => setReason(e.target.value)} />
                  </label>
                  <div style={{ fontSize: '11.5px', color: colors.muted, lineHeight: 1.5 }}>
                    The reimbursement stays on record as reversed, and its {batch.expense_count} expenses return to pending.
                  </div>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button type="button" className="boe-btn boe-btn-ghost" disabled={saving} onClick={() => setReversing(false)} style={{ minHeight: '44px' }}>Keep it</button>
                    <button type="button" className="boe-btn boe-btn-primary" disabled={saving} onClick={() => void reverse()}
                      style={{ minHeight: '44px', background: '#C13030', borderColor: '#C13030' }}>
                      {saving ? 'Reversing…' : 'Reverse reimbursement'}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setReversing(true)}
                  style={{ alignSelf: 'flex-start', minHeight: '40px', fontSize: '12.5px', color: '#C13030' }}>
                  Reverse this reimbursement…
                </button>
              )
            )}
          </>
        )}
      </div>
    </FinanceModal>
  )
}

// ── One expense, in full ─────────────────────────────────────────────────────

export function ExpenseDetailModal({
  supabase,
  expense,
  reimbursement,
  userId,
  categoryName,
  personName,
  mayAttach,
  mayRemoveBills,
  onClose,
  onOpenReimbursement,
  onBillsChanged,
}: {
  supabase: Supabase
  expense: ExpenseListRow
  /** This expense's own receipt — never the batch's total or other expenses. */
  reimbursement: ExpenseReimbursementReceipt | null
  userId: string
  categoryName: string
  personName: (id: string | null | undefined) => string
  /** May add a bill (author, finance.manage, or the named payer). */
  mayAttach: boolean
  /** May remove one (author or finance.manage only). */
  mayRemoveBills: boolean
  onClose: () => void
  /** Finance only: open the whole batch. Absent for everybody else. */
  onOpenReimbursement?: (id: string) => void
  onBillsChanged: () => void
}) {
  const state = reimbursementState(expense)
  const tone = STATE_TONE[state]
  return (
    <FinanceModal title="Expense" onClose={onClose} width="560px">
      <div data-testid="expense-detail" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' }}>
          <span style={{ fontSize: '15px', fontWeight: 600, color: colors.primary, minWidth: 0, wordBreak: 'break-word' }}>{expense.paid_to}</span>
          <span style={{ fontSize: '18px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{formatMoney(expense.amount)}</span>
        </div>
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(100px, auto) 1fr', gap: '6px 12px', fontSize: '12.5px' }}>
          <dt style={{ color: colors.muted }}>Date</dt><dd style={{ margin: 0 }}>{fmtExpenseDate(expense.expense_date)}</dd>
          <dt style={{ color: colors.muted }}>Category</dt><dd style={{ margin: 0 }}>{categoryName}</dd>
          <dt style={{ color: colors.muted }}>Mode</dt><dd style={{ margin: 0 }}>{expensePaymentModeLabel(expense.payment_mode)}</dd>
          {expense.remark && (<><dt style={{ color: colors.muted }}>Remark</dt><dd style={{ margin: 0 }}>{expense.remark}</dd></>)}
          <dt style={{ color: colors.muted }}>Recorded by</dt><dd style={{ margin: 0 }}>{personName(expense.created_by)}</dd>
          <dt style={{ color: colors.muted }}>Paid from</dt>
          <dd style={{ margin: 0 }}>
            {expense.paid_from === 'company' ? 'Company account'
              : expense.paid_from === 'personal' ? `Personally, by ${personName(expense.paid_by)}`
                : 'Not recorded (older expense)'}
          </dd>
        </dl>

        <div data-testid="expense-reimbursement-state" style={{
          padding: '10px 12px', borderRadius: '10px', border: `1px solid ${tone.border}`, background: tone.bg,
          display: 'flex', flexDirection: 'column', gap: '4px',
        }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: tone.fg }}>{REIMBURSEMENT_STATE_LABEL[state]}</span>
          {state === 'pending' && (
            <span style={{ fontSize: '12px', color: colors.secondary }}>
              {formatMoney(expense.amount)} to be paid back to {personName(expense.paid_by)}.
            </span>
          )}
          {state === 'company' && <span style={{ fontSize: '12px', color: colors.secondary }}>Paid from a company account — no reimbursement.</span>}
          {state === 'unknown' && (
            <span style={{ fontSize: '12px', color: colors.secondary }}>
              Entered before the payment source was recorded. Correct the expense to record it.
            </span>
          )}
          {state === 'reimbursed' && (
            reimbursement ? (
              <>
                <span style={{ fontSize: '12px', color: colors.secondary }}>
                  {formatMoney(reimbursement.amount)} on {fmtExpenseDate(reimbursement.reimbursed_on)} · Ref {reimbursement.reference}
                </span>
                <span style={{ fontSize: '11.5px', color: colors.muted }}>
                  Recorded by {personName(reimbursement.recorded_by)} on {fmtExpenseDate(reimbursement.recorded_at)}
                </span>
                {onOpenReimbursement && (
                  <button type="button" className="boe-btn boe-btn-ghost" onClick={() => onOpenReimbursement(reimbursement.reimbursement_id)}
                    style={{ alignSelf: 'flex-start', minHeight: '36px', fontSize: '12px', marginTop: '2px' }}>
                    Open reimbursement
                  </button>
                )}
              </>
            ) : (
              <span style={{ fontSize: '12px', color: colors.secondary }}>Reimbursement details are not visible to you.</span>
            )
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={LABEL}>Bills</span>
          <ExpenseBills
            supabase={supabase}
            expenseId={expense.id}
            userId={userId}
            mayAttach={mayAttach}
            mayRemove={mayRemoveBills}
            reimbursed={state === 'reimbursed'}
            personName={id => personName(id)}
            onChanged={onBillsChanged}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onClose} style={{ minHeight: '44px', fontSize: '13px' }}>Close</button>
        </div>
      </div>
    </FinanceModal>
  )
}

export const STATE_TONE: Record<ReturnType<typeof reimbursementState>, { fg: string; bg: string; border: string }> = {
  company: { fg: colors.secondary, bg: colors.raised, border: colors.border },
  pending: { fg: '#8A5A00', bg: 'rgba(217,148,0,0.10)', border: 'rgba(217,148,0,0.35)' },
  reimbursed: { fg: '#1F7A3F', bg: 'rgba(31,122,63,0.08)', border: 'rgba(31,122,63,0.30)' },
  unknown: { fg: colors.tertiary, bg: colors.raised, border: colors.border },
}

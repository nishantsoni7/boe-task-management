'use client'

// THE INTERNAL DETAILS CARD AND ITS EDITOR (20270122000000).
//
// The confirmation date and due date Sales confirms in the app, beside what the
// workbook itself said, and the answer to "Is there a middleman commission?".
// Shown to everybody who can open the PI — Sales, the reviewer, Operations —
// and to nobody outside BOE: no client-facing document reads these columns.
//
// The editor saves through save_order_submission_internal_details(). "Save
// draft" keeps half an answer; "Confirm details" requires the whole answer and
// is what the submission check (20270123000000) asks for.

import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { OrderModal } from '@/components/orders/OrderModal'
import {
  COMMISSION_PERCENT_OF_LABEL,
  COMMISSION_PERCENT_OF_ORDER,
  INTERNAL_DETAILS_NOTE,
  INTERNAL_DETAILS_TITLE,
  MIDDLEMAN_QUESTION,
  describeMiddleman,
  formatIsoDay,
  internalDetailsForm,
  internalDetailsMissing,
  internalDetailsPayload,
  internalDetailsReadiness,
  internalDetailsShapeErrors,
  workbookDateNotes,
  type PiInternalDetailsForm,
  type PiInternalDetailsRow,
} from '@/lib/orders/piInternalDetails'

const label: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: colors.secondary }
const value: React.CSSProperties = { fontSize: '13.5px', fontWeight: 600, color: colors.primary }
const input: React.CSSProperties = {
  padding: '7px 10px', fontSize: '13px', border: `1px solid ${colors.border}`,
  borderRadius: '7px', background: colors.base, color: colors.primary, width: '100%', boxSizing: 'border-box',
}
const fieldError: React.CSSProperties = { fontSize: '11.5px', color: colors.red }

const dateText = (iso: string | null | undefined) => formatIsoDay(iso) ?? 'Not entered'

export function PiInternalDetailsCard({ row, canEdit, onEdit }: {
  row: PiInternalDetailsRow
  canEdit: boolean
  onEdit: () => void
}) {
  const readiness = internalDetailsReadiness(row)
  const notes = workbookDateNotes(row)
  return (
    <section
      aria-label={INTERNAL_DETAILS_TITLE}
      style={{
        border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.base,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <Lock size={14} color={colors.tertiary} aria-hidden />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: colors.primary }}>{INTERNAL_DETAILS_TITLE}</h2>
        <span style={{ fontSize: '11.5px', color: colors.tertiary, flex: 1, minWidth: '180px' }}>{INTERNAL_DETAILS_NOTE}</span>
        {canEdit && (
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onEdit}>
            {readiness.ready ? 'Edit' : 'Enter and confirm'}
          </button>
        )}
      </div>

      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <div><div style={label}>Order confirmation date</div><div style={value}>{dateText(row.order_confirmation_date)}</div></div>
        <div><div style={label}>Due date</div><div style={value}>{dateText(row.due_date)}</div></div>
        <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
          <div style={label}>{MIDDLEMAN_QUESTION}</div>
          <div style={{ ...value, overflowWrap: 'anywhere' }}>{describeMiddleman(row)}</div>
        </div>
      </div>

      {notes.map(n => (
        <div key={n} style={{ fontSize: '12px', color: colors.secondary }}>{n}</div>
      ))}

      <div
        role="status"
        style={{
          display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px',
          color: readiness.ready ? colors.green : colors.amber,
        }}
      >
        {readiness.ready ? <CheckCircle2 size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
        <span style={{ color: colors.secondary }}>
          {readiness.ready
            ? `Confirmed ${formatIsoDay(row.internal_details_confirmed_at) ?? ''}`.trim()
            : `Needed before review: ${readiness.problem}.`}
        </span>
      </div>
    </section>
  )
}

export function PiInternalDetailsModal({ row, grandTotal, saving, failure, onCancel, onSave }: {
  row: PiInternalDetailsRow
  grandTotal: number | null
  saving: boolean
  failure: string | null
  onCancel: () => void
  onSave: (payload: Record<string, string | null>, confirm: boolean) => void
}) {
  const [form, setForm] = useState<PiInternalDetailsForm>(() => internalDetailsForm(row))
  const errors = useMemo(() => internalDetailsShapeErrors(form, grandTotal), [form, grandTotal])
  const payload = useMemo(() => internalDetailsPayload(form), [form])
  const missing = internalDetailsMissing(payload)
  const shapeOk = Object.keys(errors).length === 0
  const set = <K extends keyof PiInternalDetailsForm>(k: K, v: PiInternalDetailsForm[K]) =>
    setForm(f => ({ ...f, [k]: v }))
  const notes = workbookDateNotes({ ...row, ...payload })
  const wbConfirm = row.workbook_order_confirmation_date
  const wbDue = row.workbook_due_date

  return (
    <OrderModal title={INTERNAL_DETAILS_TITLE} subtitle={INTERNAL_DETAILS_NOTE} onClose={() => { if (!saving) onCancel() }} width={560}>
      <form
        onSubmit={e => { e.preventDefault(); if (shapeOk && !missing && !saving) onSave(payload, true) }}
        style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '16px 18px 18px', maxHeight: '70vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={label}>Order confirmation date</span>
            <input type="date" style={input} value={form.order_confirmation_date} disabled={saving}
              onChange={e => set('order_confirmation_date', e.target.value)} />
            <span style={{ fontSize: '11px', color: colors.tertiary }}>
              Workbook: {formatIsoDay(wbConfirm) ?? 'blank'}
            </span>
            {errors.order_confirmation_date && <span style={fieldError}>{errors.order_confirmation_date}</span>}
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={label}>Due date</span>
            <input type="date" style={input} value={form.due_date} disabled={saving}
              min={form.order_confirmation_date || undefined}
              onChange={e => set('due_date', e.target.value)} />
            <span style={{ fontSize: '11px', color: colors.tertiary }}>
              Workbook: {formatIsoDay(wbDue) ?? 'blank'}
            </span>
            {errors.due_date && <span style={fieldError}>{errors.due_date}</span>}
          </label>
        </div>
        {notes.length > 0 && (
          <div style={{ fontSize: '12px', color: colors.secondary, background: colors.amberTint, borderRadius: '7px', padding: '8px 10px' }}>
            {notes.join(' ')} Changing the app date does not change the uploaded workbook.
          </div>
        )}

        <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <legend style={{ ...label, marginBottom: '6px' }}>{MIDDLEMAN_QUESTION}</legend>
          <div style={{ display: 'flex', gap: '16px' }}>
            {(['no', 'yes'] as const).map(a => (
              <label key={a} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: colors.primary }}>
                <input type="radio" name="middleman" checked={form.middleman_commission === a} disabled={saving}
                  onChange={() => set('middleman_commission', a)} />
                {a === 'yes' ? 'Yes' : 'No'}
              </label>
            ))}
          </div>

          {form.middleman_commission === 'yes' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', paddingLeft: '4px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={label}>Who receives it</span>
                <input type="text" style={input} maxLength={200} value={form.middleman_recipient} disabled={saving}
                  onChange={e => set('middleman_recipient', e.target.value)} />
                {errors.middleman_recipient && <span style={fieldError}>{errors.middleman_recipient}</span>}
              </label>
              <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                {(['amount', 'percent'] as const).map(b => (
                  <label key={b} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: colors.primary }}>
                    <input type="radio" name="basis" checked={form.middleman_commission_basis === b} disabled={saving}
                      onChange={() => set('middleman_commission_basis', b)} />
                    {b === 'amount' ? 'Agreed amount (₹)' : 'Agreed percentage'}
                  </label>
                ))}
              </div>
              {form.middleman_commission_basis === 'amount' && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span style={label}>Amount (₹)</span>
                  <input type="number" inputMode="decimal" min="0.01" step="0.01" style={input}
                    value={form.middleman_commission_amount} disabled={saving}
                    onChange={e => set('middleman_commission_amount', e.target.value)} />
                  {errors.middleman_commission_amount && <span style={fieldError}>{errors.middleman_commission_amount}</span>}
                </label>
              )}
              {form.middleman_commission_basis === 'percent' && (
                <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={label}>Percentage (%)</span>
                    <input type="number" inputMode="decimal" min="0.001" max="100" step="0.001" style={input}
                      value={form.middleman_commission_percent} disabled={saving}
                      onChange={e => set('middleman_commission_percent', e.target.value)} />
                    {errors.middleman_commission_percent && <span style={fieldError}>{errors.middleman_commission_percent}</span>}
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={label}>Percentage of</span>
                    <select style={input} value={form.middleman_commission_percent_of} disabled={saving}
                      onChange={e => set('middleman_commission_percent_of', e.target.value as PiInternalDetailsForm['middleman_commission_percent_of'])}>
                      <option value="">Choose the figure…</option>
                      {COMMISSION_PERCENT_OF_ORDER.map(k => (
                        <option key={k} value={k}>{COMMISSION_PERCENT_OF_LABEL[k]}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          )}
        </fieldset>

        {failure && (
          <div role="alert" style={{ fontSize: '12.5px', color: colors.red, background: colors.redTint, borderRadius: '7px', padding: '8px 10px' }}>
            {failure}
          </div>
        )}
        {!failure && missing && (
          <div style={{ fontSize: '12px', color: colors.secondary }}>
            To confirm: {missing}.{shapeOk ? ' You can save a draft meanwhile.' : ''}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onCancel} disabled={saving}>Cancel</button>
          <button type="button" className="boe-btn boe-btn-ghost" disabled={saving || !shapeOk}
            onClick={() => onSave(payload, false)}>
            Save draft
          </button>
          <button type="submit" className="boe-btn boe-btn-primary" disabled={saving || !shapeOk || !!missing}>
            {saving ? 'Saving…' : 'Confirm details'}
          </button>
        </div>
      </form>
    </OrderModal>
  )
}

/** The deduction row's wording, flagged where a client would read it wrongly. */
export function PiDiscountWordingNotice({ notice }: { notice: string | null }) {
  if (!notice) return null
  return (
    <div
      role="note"
      style={{
        display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', color: colors.primary,
        border: `1px solid ${colors.amber}`, background: colors.amberTint, borderRadius: '10px', padding: '10px 14px',
      }}
    >
      <AlertTriangle size={15} color={colors.amber} aria-hidden style={{ flexShrink: 0, marginTop: '1px' }} />
      <span>{notice}</span>
    </div>
  )
}

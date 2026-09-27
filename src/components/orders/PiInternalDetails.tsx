'use client'

// THE INTERNAL DETAILS: THE SUMMARY'S COMMISSION ANSWER AND THE EDITOR (20270122000000).
//
// The confirmation date and due date Sales confirms in the app, beside what the
// workbook itself said, and the answer to "Is there a middleman commission?".
// The dates are shown to everybody who can open the PI. The commission is shown
// only to those can_read_order_submission_commission() admits — everybody else
// sees "Restricted" (withCommission) — and to nobody outside BOE: no
// client-facing document reads any of it.
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
  internalDetailsStatusLine,
  workbookDateNotes,
  SUBMISSION_CONFIRM_LABEL,
  SUBMISSION_DATE_LABEL,
  SUBMISSION_DATES_NOTE,
  SUBMISSION_MIDDLEMAN_HINT,
  type PiInternalDetailsForm,
  type PiInternalDetailsRow,
  type SubmissionDates,
} from '@/lib/orders/piInternalDetails'

const label: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: colors.secondary }
const input: React.CSSProperties = {
  padding: '7px 10px', fontSize: '13px', border: `1px solid ${colors.border}`,
  borderRadius: '7px', background: colors.base, color: colors.primary, width: '100%', boxSizing: 'border-box',
}
const fieldError: React.CSSProperties = { fontSize: '11.5px', color: colors.red }

/**
 * THE MIDDLEMAN ANSWER, IN THE PI SUMMARY beside Billing percentage.
 *
 * The two dates are not repeated here: the summary's date band prints the same
 * two columns (order_confirmation_date, due_date), and the workbook notes sit
 * under that band. What is left of the old Internal details card is the answer,
 * the one control that opens the editor, and the review-gate status line.
 * Presentation only — withCommission still decides what this viewer may read.
 */
export function PiCommissionSummary({ row, canEdit, onEdit }: {
  row: PiInternalDetailsRow
  canEdit: boolean
  onEdit: () => void
}) {
  const readiness = internalDetailsReadiness(row)
  const statusLine = internalDetailsStatusLine(row)
  const answer = describeMiddleman(row)
  const unanswered = !row.commission_restricted && !row.middleman_commission
  return (
    <section className="pi-detail-internal" aria-label={MIDDLEMAN_LABEL}>
      <div className="pi-detail-internal-head">
        <span className="pi-detail-figure-label">{MIDDLEMAN_LABEL}</span>
        <span className="pi-detail-internal-tag" title={INTERNAL_DETAILS_NOTE}>
          <Lock size={10} strokeWidth={2.2} aria-hidden />
          BOE only
        </span>
      </div>
      {/* Top-right beside the label on a wide column; last, after the
          warning it resolves, on a phone (CSS order). */}
      {canEdit && (
        <button
          type="button"
          className="boe-btn boe-btn-ghost pi-detail-internal-action"
          onClick={onEdit}
          aria-haspopup="dialog"
          aria-label={`${readiness.ready ? 'Edit' : 'Enter and confirm'} ${INTERNAL_DETAILS_TITLE.toLowerCase()}`}
        >
          {readiness.ready ? 'Edit' : 'Enter and confirm'}
        </button>
      )}

      {/* UNANSWERED IS A STATE, like an undeclared billing percentage. */}
      {unanswered ? (
        <span className="pi-detail-state-chip">{answer}</span>
      ) : (
        <div className={row.commission_restricted ? 'pi-detail-internal-restricted' : 'pi-detail-internal-value'}>{answer}</div>
      )}

      <p className={`pi-detail-internal-status pi-detail-internal-status--${statusLine.tone}`} role="status">
        {statusLine.tone === 'ready' && <CheckCircle2 size={13} aria-hidden style={{ flexShrink: 0 }} />}
        {statusLine.tone === 'needed' && <AlertTriangle size={13} aria-hidden style={{ flexShrink: 0 }} />}
        <span>{statusLine.text}</span>
      </p>
      <p className="pi-detail-internal-note">{INTERNAL_DETAILS_NOTE}</p>
    </section>
  )
}

/** The summary's label for the answer to MIDDLEMAN_QUESTION. */
export const MIDDLEMAN_LABEL = 'Middleman commission'

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

/**
 * What the Submit dialog says about confirming. `needed` is true exactly when
 * pressing Submit will write the internal details (submissionNeedsConfirmation);
 * then the tick is required and starts UNTICKED. When nothing will be written,
 * the line says the details are already confirmed.
 */
export type SubmissionConfirmation = {
  needed: boolean
  checked: boolean
  onToggle: (checked: boolean) => void
  /** Shown only after Submit was pressed without the tick. */
  error?: string | null
  /** "26 Sep 2026" when the record is confirmed and nothing will change. */
  confirmedOn?: string | null
}

/**
 * THE TWO DATES, INSIDE SUBMIT FOR APPROVAL (2026-09-27).
 *
 * The same columns the editor above writes, labelled in the workbook's own
 * words. Controlled by the submit dialog, which keeps the values across a
 * failed attempt; each message sits under its own input and is announced.
 * Errors are handed in already filtered to "shown" — the dialog says nothing
 * until Submit has been pressed once.
 */
export function PiSubmissionDatesFields({ dates, errors, disabled, onChange, inputRef, middleman, confirmation, confirmRef }: {
  dates: SubmissionDates
  errors: Partial<Record<keyof SubmissionDates, string>>
  disabled: boolean
  onChange: (key: keyof SubmissionDates, value: string) => void
  inputRef?: (key: keyof SubmissionDates, el: HTMLInputElement | null) => void
  /**
   * The CURRENT middleman commission answer, as describeMiddleman() words it.
   * Shown beside the dates because Submit confirms both together.
   */
  middleman?: string
  confirmation?: SubmissionConfirmation
  confirmRef?: (el: HTMLInputElement | null) => void
}) {
  const keys: (keyof SubmissionDates)[] = ['order_confirmation_date', 'due_date']
  return (
    <fieldset style={{ border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '12px 14px', margin: 0, minWidth: 0 }}>
      <legend style={{ ...label, padding: '0 4px', color: colors.primary }}>
        Internal details <span style={{ fontWeight: 400, color: colors.tertiary }}>· BOE only</span>
      </legend>
      <p style={{ margin: '0 0 10px', fontSize: '11.5px', color: colors.secondary, lineHeight: 1.45 }}>
        {SUBMISSION_DATES_NOTE}
      </p>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {keys.map(key => {
          const id = `pi-submit-${key}`
          const error = errors[key]
          return (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              <label htmlFor={id} style={label}>
                {SUBMISSION_DATE_LABEL[key]} <span aria-hidden style={{ color: colors.red }}>*</span>
              </label>
              <input
                id={id}
                ref={el => inputRef?.(key, el)}
                type="date"
                required
                value={dates[key]}
                min={key === 'due_date' && dates.order_confirmation_date ? dates.order_confirmation_date : undefined}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={e => onChange(key, e.target.value)}
                style={{ ...input, borderColor: error ? 'rgba(217,79,79,0.6)' : colors.border }}
              />
              {error && <span id={`${id}-error`} role="alert" style={fieldError}>{error}</span>}
            </div>
          )
        })}
      </div>
      {middleman !== undefined && (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={label}>{MIDDLEMAN_LABEL}</span>
          <span data-testid="pi-submit-middleman" style={{ fontSize: '13px', color: colors.primary, fontWeight: 600 }}>{middleman}</span>
          <span style={{ fontSize: '11px', color: colors.tertiary }}>{SUBMISSION_MIDDLEMAN_HINT}</span>
        </div>
      )}
      {confirmation && (confirmation.needed ? (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', color: colors.primary, lineHeight: 1.45, cursor: disabled ? 'default' : 'pointer' }}>
            <input
              id="pi-submit-confirm-internal"
              ref={confirmRef}
              type="checkbox"
              checked={confirmation.checked}
              disabled={disabled}
              aria-invalid={confirmation.error ? true : undefined}
              aria-describedby={confirmation.error ? 'pi-submit-confirm-internal-error' : undefined}
              onChange={e => confirmation.onToggle(e.target.checked)}
              style={{ marginTop: '2px', flexShrink: 0 }}
            />
            <span>{SUBMISSION_CONFIRM_LABEL}</span>
          </label>
          {confirmation.error && (
            <span id="pi-submit-confirm-internal-error" role="alert" style={fieldError}>{confirmation.error}</span>
          )}
        </div>
      ) : (
        <p style={{ margin: '12px 0 0', fontSize: '11.5px', color: colors.secondary, display: 'flex', gap: '6px', alignItems: 'center' }}>
          <CheckCircle2 size={13} aria-hidden style={{ flexShrink: 0, color: colors.green }} />
          <span>Confirmed{confirmation.confirmedOn ? ` ${confirmation.confirmedOn}` : ''} — nothing here will change.</span>
        </p>
      ))}
    </fieldset>
  )
}

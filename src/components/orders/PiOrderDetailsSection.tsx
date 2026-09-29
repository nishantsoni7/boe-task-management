'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ClipboardList, Lock, Pencil } from 'lucide-react'
import { colors } from '@/lib/tokens'
import { formatInr } from '@/lib/pi/previewView'
import { FABRIC_RESPONSIBILITY_KEEPS_FIGURES, FABRIC_RESPONSIBILITY_OPTIONS, fabricResponsibilityNeedsConfirmation } from '@/lib/orders/piTerms'
import { COMMISSION_PERCENT_OF_LABEL, COMMISSION_PERCENT_OF_ORDER, formatIsoDay } from '@/lib/orders/piInternalDetails'
import {
  BILLING_TERMS_MAX,
  LEAD_SOURCE_OPTIONS,
  ORDER_DETAILS_ANCHOR,
  ORDER_DETAILS_FIELD,
  ORDER_DETAILS_NEED_LABEL,
  ORDER_DETAILS_NOTE,
  ORDER_DETAILS_TITLE,
  orderDetailsAbsent,
  orderDetailsErrors,
  orderDetailsForm,
  orderDetailsReview,
  orderDetailsSaveFailureText,
  orderDetailsSavePlan,
  runOrderDetailsSave,
  orderDetailsSubmissionGaps,
  type OrderDetailsFieldKey,
  type OrderDetailsForm,
  type OrderDetailsNeed,
  type OrderDetailsReviewRow,
  type OrderDetailsRow,
} from '@/lib/orders/salesOrderDetails'

const LABEL: React.CSSProperties = { fontSize: '11.5px', fontWeight: 600, color: colors.secondary }
const INPUT: React.CSSProperties = {
  padding: '7px 10px', fontSize: '13px', border: `1px solid ${colors.border}`, borderRadius: '7px',
  background: colors.base, color: colors.primary, width: '100%', boxSizing: 'border-box', font: 'inherit',
}
const ERROR: React.CSSProperties = { fontSize: '11.5px', color: colors.red }
const HINT: React.CSSProperties = { fontSize: '11px', color: colors.tertiary, lineHeight: 1.4 }

/** The id of a field's input, for the readiness checklist to focus. */
export const orderDetailsInputId = (key: OrderDetailsFieldKey): string =>
  key === 'middleman_structure' ? 'od-middleman_recipient' : `od-${key}`

const NEED_TONE: Record<OrderDetailsNeed, { color: string; background: string }> = {
  submission: { color: '#9A6212', background: 'rgba(232,160,48,0.12)' },
  approval:   { color: '#2F5BB7', background: 'rgba(85,133,232,0.10)' },
  optional:   { color: '#6b7384', background: '#eef0f4' },
  conditional:{ color: '#6b7384', background: '#eef0f4' },
}

function NeedChip({ need }: { need: OrderDetailsNeed }) {
  const tone = NEED_TONE[need]
  return (
    <span data-need={need} style={{
      display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: '999px',
      fontSize: '10.5px', fontWeight: 600, whiteSpace: 'nowrap', ...tone,
    }}>
      {ORDER_DETAILS_NEED_LABEL[need]}
    </span>
  )
}

/** One fact in the read view. A missing required value is said, never blank. */
function ReviewLine({ row, missing }: { row: OrderDetailsReviewRow; missing: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
        <span style={LABEL}>{row.label}</span>
        <NeedChip need={row.need} />
      </div>
      <span style={{
        fontSize: '13.5px', fontWeight: row.value ? 600 : 500, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
        color: row.value ? colors.primary : missing ? '#8a4b12' : colors.muted,
      }}>
        {row.value ?? orderDetailsAbsent(row.need, row.key)}
      </span>
    </div>
  )
}

/**
 * THE INTERNAL ORDER DETAILS, on the saved PI Draft — what Sales owns about the
 * order, seen and entered together. See salesOrderDetails.ts for where each
 * value lives and which RPC saves it. PRESENTATION AND ORCHESTRATION ONLY:
 * `canEdit` is the page's can_edit_order_submission answer and every RPC
 * re-derives it; a failure part-way through says what was saved and what was not.
 */
export function PiOrderDetailsSection({
  supabase, submissionId, row, rowVersion, canEdit, salesDetailsAvailable, people, grandTotal, fabricCost,
  focus, onSaved, locked = false,
}: {
  supabase: SupabaseClient
  submissionId: string
  row: OrderDetailsRow
  rowVersion: number | null
  canEdit: boolean
  /** False until 20270211000000 is applied: salesperson and lead source are then read-only blanks. */
  salesDetailsAvailable: boolean
  people: readonly { id: string; name: string }[]
  grandTotal: number | null
  fabricCost: number | null
  /** Set by the readiness checklist: open the form and focus this field. */
  focus: { field: OrderDetailsFieldKey; nonce: number } | null
  /** Re-reads the PI; awaited before Save is offered again. */
  onSaved: () => void | Promise<void>
  /**
   * The PI is with management. The section stays fully legible, and its one
   * editing control is drawn muted and disabled instead of being taken away, so
   * the reader can see that editing exists and why it is not available.
   */
  locked?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<OrderDetailsForm>(() => orderDetailsForm(row))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)
  const sectionRef = useRef<HTMLElement | null>(null)

  const review = useMemo(() => orderDetailsReview(row, people), [row, people])
  const gaps = useMemo(() => new Set(orderDetailsSubmissionGaps(row).map(g => g.key)), [row])
  const errors = orderDetailsErrors(form, grandTotal)
  const shapeOk = Object.keys(errors).length === 0
  const plan = orderDetailsSavePlan(row, form)
  const restricted = row.commission_restricted === true

  const open = () => { setForm(orderDetailsForm(row)); setFailure(null); setAttempted(false); setEditing(true) }

  // The checklist's "Add": open the form on the record and put the cursor in the field.
  useEffect(() => {
    if (!focus || !canEdit) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    open()
    const id = orderDetailsInputId(focus.field)
    const t = setTimeout(() => {
      sectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      document.getElementById(id)?.focus({ preventScroll: true })
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  const set = <K extends keyof OrderDetailsForm>(key: K, value: OrderDetailsForm[K]) => {
    setForm(current => ({ ...current, [key]: value }))
    setFailure(null)
  }

  const save = async () => {
    setAttempted(true)
    if (!shapeOk || saving) return
    if (plan.length === 0) { setEditing(false); return }
    setSaving(true)
    setFailure(null)
    let result: Awaited<ReturnType<typeof runOrderDetailsSave>> | null = null
    try {
      result = await runOrderDetailsSave({
        plan,
        version: rowVersion,
        call: async (rpc, args) => { const { data, error } = await supabase.rpc(rpc, { p_submission_id: submissionId, ...args }); return { data, error } },
        readVersion: async () => {
          // set_order_submission_billing_percentage returns no version; read it.
          const { data } = await supabase.from('order_submissions').select('row_version').eq('id', submissionId).maybeSingle()
          const v = (data as { row_version?: unknown } | null)?.row_version
          return typeof v === 'number' ? v : null
        },
      })
      // WHATEVER COMMITTED IS RE-READ BEFORE SAVE IS OFFERED AGAIN, so a retry
      // plans against the saved record and its current version: it sends only
      // the groups that still differ, and cannot trip its own staleness check.
      if (result.saved.length > 0) await onSaved()
      if (result.ok) setEditing(false)
      // The form is NOT reset on a refusal: every edit stays where it was typed.
      else setFailure(orderDetailsSaveFailureText(result))
    } finally {
      setSaving(false)
    }
  }

  const field = (key: keyof OrderDetailsForm) => (attempted || form[key] !== orderDetailsForm(row)[key] ? errors[key] : undefined)
  const labelFor = (key: OrderDetailsFieldKey, text?: string) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
      <label htmlFor={orderDetailsInputId(key)} style={LABEL}>{text ?? ORDER_DETAILS_FIELD[key].label}</label>
      <NeedChip need={ORDER_DETAILS_FIELD[key].need} />
    </span>
  )
  const grid: React.CSSProperties = { display: 'grid', gap: '12px 14px', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }
  const fabricNote = fabricResponsibilityNeedsConfirmation({ next: form.fabric_responsibility || null, fabricCost })

  return (
    <section
      id={ORDER_DETAILS_ANCHOR}
      ref={sectionRef}
      aria-label={ORDER_DETAILS_TITLE}
      className="pi-order-details"
      style={{
        border: `1px solid ${colors.border}`, borderRadius: '10px', background: colors.base,
        padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0,
        scrollMarginTop: '80px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <ClipboardList size={15} aria-hidden style={{ color: colors.secondary }} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: colors.primary }}>{ORDER_DETAILS_TITLE}</h2>
        <span className="pi-detail-internal-tag" title={ORDER_DETAILS_NOTE}>
          <Lock size={10} strokeWidth={2.2} aria-hidden />
          Internal
        </span>
        {canEdit && !editing && (
          <button type="button" className="boe-btn boe-btn-ghost" style={{ marginLeft: 'auto' }} onClick={open}>
            <Pencil size={12} aria-hidden /> {gaps.size > 0 ? 'Complete details' : 'Edit details'}
          </button>
        )}
        {!canEdit && locked && (
          <button type="button" className="boe-btn boe-btn-ghost" disabled
            style={{ marginLeft: 'auto', opacity: 0.55, cursor: 'not-allowed' }}
            title="Locked while this PI is with management.">
            <Pencil size={12} aria-hidden /> Edit details
          </button>
        )}
      </div>
      <p style={{ margin: 0, ...HINT }}>{ORDER_DETAILS_NOTE}</p>

      {!editing ? (
        <div style={grid}>
          {review.map(r => <ReviewLine key={r.key} row={r} missing={gaps.has(r.key)} />)}
        </div>
      ) : (
        <form
          onSubmit={e => { e.preventDefault(); void save() }}
          style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
          aria-label={`Edit ${ORDER_DETAILS_TITLE.toLowerCase()}`}
        >
          {/* ── Dates ── */}
          <div style={grid}>
            {(['order_confirmation_date', 'due_date'] as const).map(key => (
              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                {labelFor(key)}
                <input id={orderDetailsInputId(key)} type="date" style={INPUT} value={form[key]} disabled={saving}
                  min={key === 'due_date' && form.order_confirmation_date ? form.order_confirmation_date : undefined}
                  aria-invalid={field(key) ? true : undefined}
                  onChange={e => set(key, e.target.value)} />
                {ORDER_DETAILS_FIELD[key].hint && <span style={HINT}>{ORDER_DETAILS_FIELD[key].hint}</span>}
                {field(key) && <span role="alert" style={ERROR}>{field(key)}</span>}
              </div>
            ))}
          </div>

          {/* ── Salesperson and lead source ── */}
          <div style={grid}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              {labelFor('salesperson_id')}
              <select id={orderDetailsInputId('salesperson_id')} style={INPUT} value={form.salesperson_id}
                disabled={saving || !salesDetailsAvailable} onChange={e => set('salesperson_id', e.target.value)}>
                <option value="">Choose the salesperson…</option>
                {form.salesperson_id && !people.some(p => p.id === form.salesperson_id) && (
                  <option value={form.salesperson_id}>Saved (not in the list)</option>
                )}
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <span style={HINT}>
                {salesDetailsAvailable
                  ? `${ORDER_DETAILS_FIELD.salesperson_id.hint}${row.source_created_by ? ` The workbook names “${row.source_created_by}”.` : ''}`
                  : 'Available once the database update for this section is applied.'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              {labelFor('lead_source')}
              <select id={orderDetailsInputId('lead_source')} style={INPUT} value={form.lead_source}
                disabled={saving || !salesDetailsAvailable} onChange={e => set('lead_source', e.target.value)}>
                <option value="">Choose the lead source…</option>
                {LEAD_SOURCE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {field('lead_source') && <span role="alert" style={ERROR}>{field('lead_source')}</span>}
            </div>
          </div>

          {/* ── Billing ── */}
          <div style={grid}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              {labelFor('billing_percentage')}
              <input id={orderDetailsInputId('billing_percentage')} type="text" inputMode="decimal" style={INPUT}
                value={form.billing_percentage} disabled={saving} placeholder="e.g. 65"
                aria-invalid={field('billing_percentage') ? true : undefined}
                onChange={e => set('billing_percentage', e.target.value)} />
              <span style={HINT}>{ORDER_DETAILS_FIELD.billing_percentage.hint} Leave blank to keep it undeclared.</span>
              {field('billing_percentage') && <span role="alert" style={ERROR}>{field('billing_percentage')}</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
              {labelFor('billing_terms')}
              <textarea id={orderDetailsInputId('billing_terms')} rows={2} style={{ ...INPUT, resize: 'vertical' }}
                maxLength={BILLING_TERMS_MAX} value={form.billing_terms} disabled={saving}
                onChange={e => set('billing_terms', e.target.value)} />
              {field('billing_terms') && <span role="alert" style={ERROR}>{field('billing_terms')}</span>}
            </div>
          </div>

          {/* ── Fabric ── */}
          <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
            <legend style={{ padding: 0, marginBottom: '4px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={LABEL}>{ORDER_DETAILS_FIELD.fabric_responsibility.label}</span>
                <NeedChip need="submission" />
              </span>
            </legend>
            <span style={HINT}>Fabric cost on this PI: {fabricCost === null ? 'not stated' : formatInr(fabricCost)} (from the workbook; not changed here).</span>
            {FABRIC_RESPONSIBILITY_OPTIONS.map((option, i) => (
              <label key={option.value} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '13px', color: colors.primary }}>
                <input id={i === 0 ? orderDetailsInputId('fabric_responsibility') : undefined} type="radio" name="od-fabric"
                  checked={form.fabric_responsibility === option.value} disabled={saving}
                  onChange={() => set('fabric_responsibility', option.value)} style={{ marginTop: '3px' }} />
                <span>{option.label}</span>
              </label>
            ))}
            {fabricNote && <span style={HINT}>{FABRIC_RESPONSIBILITY_KEEPS_FIGURES}</span>}
          </fieldset>

          {/* ── Middleman commission ── */}
          <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
            <legend style={{ padding: 0, marginBottom: '4px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={LABEL}>{ORDER_DETAILS_FIELD.middleman_commission.label}</span>
                <NeedChip need="submission" />
              </span>
            </legend>
            {restricted ? (
              <span style={HINT}>You may not read the middleman commission on this PI, so it is not edited here.</span>
            ) : (
              <>
                <div style={{ display: 'flex', gap: '16px' }}>
                  {(['no', 'yes'] as const).map((answer, i) => (
                    <label key={answer} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: colors.primary }}>
                      <input id={i === 0 ? orderDetailsInputId('middleman_commission') : undefined} type="radio" name="od-middleman"
                        checked={form.middleman_commission === answer} disabled={saving}
                        onChange={() => set('middleman_commission', answer)} />
                      {answer === 'yes' ? 'Yes' : 'No'}
                    </label>
                  ))}
                </div>
                {form.middleman_commission === 'yes' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', paddingLeft: '4px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {labelFor('middleman_structure', 'Who receives it')}
                      <input id={orderDetailsInputId('middleman_structure')} type="text" maxLength={200} style={INPUT}
                        value={form.middleman_recipient} disabled={saving} onChange={e => set('middleman_recipient', e.target.value)} />
                      {field('middleman_recipient') && <span role="alert" style={ERROR}>{field('middleman_recipient')}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                      {(['amount', 'percent'] as const).map(basis => (
                        <label key={basis} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: colors.primary }}>
                          <input type="radio" name="od-basis" checked={form.middleman_commission_basis === basis} disabled={saving}
                            onChange={() => set('middleman_commission_basis', basis)} />
                          {basis === 'amount' ? 'Agreed amount (₹)' : 'Agreed percentage'}
                        </label>
                      ))}
                    </div>
                    {form.middleman_commission_basis === 'amount' && (
                      <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={LABEL}>Amount (₹)</span>
                        <input type="number" inputMode="decimal" min="0.01" step="0.01" style={INPUT} data-amount-input
                          value={form.middleman_commission_amount} disabled={saving}
                          onChange={e => set('middleman_commission_amount', e.target.value)} />
                        {field('middleman_commission_amount') && <span role="alert" style={ERROR}>{field('middleman_commission_amount')}</span>}
                      </label>
                    )}
                    {form.middleman_commission_basis === 'percent' && (
                      <div style={grid}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <span style={LABEL}>Percentage (%)</span>
                          <input type="number" inputMode="decimal" min="0.001" max="100" step="0.001" style={INPUT}
                            value={form.middleman_commission_percent} disabled={saving}
                            onChange={e => set('middleman_commission_percent', e.target.value)} />
                          {field('middleman_commission_percent') && <span role="alert" style={ERROR}>{field('middleman_commission_percent')}</span>}
                        </label>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <span style={LABEL}>Percentage of</span>
                          <select style={INPUT} value={form.middleman_commission_percent_of} disabled={saving}
                            onChange={e => set('middleman_commission_percent_of', e.target.value as OrderDetailsForm['middleman_commission_percent_of'])}>
                            <option value="">Choose the figure…</option>
                            {COMMISSION_PERCENT_OF_ORDER.map(k => <option key={k} value={k}>{COMMISSION_PERCENT_OF_LABEL[k]}</option>)}
                          </select>
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </fieldset>

          {failure && <div role="alert" style={{ ...ERROR, background: colors.redTint, borderRadius: '7px', padding: '8px 10px' }}>{failure}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span style={{ ...HINT, marginRight: 'auto' }}>
              Saving keeps this a private draft. Anything left blank can be added later; Submit for Approval needs the ones marked “{ORDER_DETAILS_NEED_LABEL.submission}”.
            </span>
            <button type="button" className="boe-btn boe-btn-ghost" disabled={saving} onClick={() => { setEditing(false); setFailure(null) }}>Cancel</button>
            <button type="submit" className="boe-btn boe-btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </form>
      )}
      {!editing && row.internal_details_confirmed_at && (
        <span style={HINT}>Confirmed {formatIsoDay(row.internal_details_confirmed_at)}. A change clears the confirmation until Submit for Approval asks for it again.</span>
      )}
    </section>
  )
}

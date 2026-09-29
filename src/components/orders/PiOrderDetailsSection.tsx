'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ClipboardList, Lock, Pencil } from 'lucide-react'
import { formatInr } from '@/lib/pi/previewView'
import { FABRIC_RESPONSIBILITY_KEEPS_FIGURES, FABRIC_RESPONSIBILITY_OPTIONS, fabricResponsibilityNeedsConfirmation } from '@/lib/orders/piTerms'
import { COMMISSION_PERCENT_OF_LABEL, COMMISSION_PERCENT_OF_ORDER, formatIsoDay } from '@/lib/orders/piInternalDetails'
import {
  PAYMENT_TERMS_FIELD_MAX,
  LEAD_SOURCE_OPTIONS,
  ORDER_DETAILS_ANCHOR,
  ORDER_DETAILS_FIELD,
  ORDER_DETAILS_SHORT_NOTE,
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
  type OrderDetailsReviewRow,
  type OrderDetailsRow,
} from '@/lib/orders/salesOrderDetails'
import { Choice, ChoiceGroup, FormField, FormGroup, RequiredLegend, RequiredMark, describedBy } from './PiFormParts'

/** The id of a field's input, for the readiness checklist to focus. */
export const orderDetailsInputId = (key: OrderDetailsFieldKey): string =>
  key === 'middleman_structure' ? 'od-middleman_recipient' : `od-${key}`

/** What Submit for approval asks of the person, from the fields' own classification. */
const requiredToSubmit = (key: OrderDetailsFieldKey): boolean => ORDER_DETAILS_FIELD[key].need === 'submission'

/** The groups, in the order the form and the read view both show them. */
const REVIEW_GROUPS: readonly { title: string; keys: readonly OrderDetailsFieldKey[] }[] = [
  { title: 'Order dates', keys: ['order_confirmation_date', 'due_date'] },
  { title: 'Order assignment', keys: ['salesperson_id', 'lead_source'] },
  { title: 'Production details', keys: ['fabric_responsibility'] },
  { title: 'Commission', keys: ['middleman_commission'] },
  { title: 'Payment', keys: ['payment_terms'] },
]

/** One fact in the read view. A missing required value is said, never blank. */
function ReviewLine({ row, missing }: { row: OrderDetailsReviewRow; missing: boolean }) {
  return (
    <div className="pi-form-fact">
      <dt>{row.label}{requiredToSubmit(row.key) && <RequiredMark />}</dt>
      <dd data-empty={row.value ? undefined : 'true'} data-required={!row.value && missing ? 'true' : undefined}>
        {row.value ?? orderDetailsAbsent(row.need, row.key)}
      </dd>
    </div>
  )
}

/**
 * THE INTERNAL ORDER DETAILS, on the saved PI Draft — what Sales owns about the
 * order, seen and entered together. See salesOrderDetails.ts for where each
 * value lives and which RPC saves it. PRESENTATION AND ORCHESTRATION ONLY:
 * `canEdit` is the page's can_edit_order_submission answer and every RPC
 * re-derives it; a failure part-way through says what was saved and what was not.
 *
 * The billing percentage is not on this form: it sits with the supporting
 * details above it (PiSupportingDetails) and saves itself. Billing terms are no
 * longer offered anywhere on this page; a stored value is left exactly as it is,
 * because this form only ever sends the fields whose value changed.
 */
export function PiOrderDetailsSection({
  supabase, submissionId, row, rowVersion, canEdit, salesDetailsAvailable, people, grandTotal, fabricCost,
  focus, onSaved, locked = false, showLegend = false,
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
  /** Draw the one-line "* Required to submit" key. False when an area above it already has. */
  showLegend?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<OrderDetailsForm>(() => orderDetailsForm(row))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempted, setAttempted] = useState(false)
  const sectionRef = useRef<HTMLElement | null>(null)

  const review = useMemo(() => orderDetailsReview(row, people), [row, people])
  const reviewByKey = useMemo(() => new Map(review.map(r => [r.key, r])), [review])
  const gaps = useMemo(() => new Set(orderDetailsSubmissionGaps(row).map(g => g.key)), [row])
  const errors = orderDetailsErrors(form, grandTotal)
  const shapeOk = Object.keys(errors).length === 0
  const plan = orderDetailsSavePlan(row, form)
  const restricted = row.commission_restricted === true

  const open = () => { setForm(orderDetailsForm(row)); setFailure(null); setAttempted(false); setEditing(true) }

  // The checklist's "Add": open the form on the record and put the cursor in the field.
  // The billing percentage lives in the supporting details above and answers to the
  // same request itself, so this form does not open for it.
  useEffect(() => {
    if (!focus || !canEdit || focus.field === 'billing_percentage') return
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
  const fabricNote = fabricResponsibilityNeedsConfirmation({ next: form.fabric_responsibility || null, fabricCost })
  const workbookName = row.source_created_by ? ` The client PDF prints the workbook’s salesperson, “${row.source_created_by}”.` : ''

  return (
    <section
      id={ORDER_DETAILS_ANCHOR}
      ref={sectionRef}
      aria-label={ORDER_DETAILS_TITLE}
      className="pi-form-card pi-order-details"
    >
      <div className="pi-form-card-head">
        <ClipboardList size={16} aria-hidden style={{ color: '#4A5261' }} />
        <h2 className="pi-form-card-title">{ORDER_DETAILS_TITLE}</h2>
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
      <p className="pi-form-group-note" style={{ margin: '4px 0 0' }}>{ORDER_DETAILS_SHORT_NOTE}</p>
      {showLegend && <RequiredLegend />}

      {!editing ? (
        <>
          {REVIEW_GROUPS.map(group => (
            <FormGroup key={group.title} title={group.title} note={group.title === 'Order assignment' ? 'Needed when the Order is created, not to submit this PI.' : undefined}>
              <dl className="pi-form-facts">
                {group.keys.map(key => {
                  const r = reviewByKey.get(key)
                  return r ? <ReviewLine key={key} row={r} missing={gaps.has(key)} /> : null
                })}
              </dl>
            </FormGroup>
          ))}
          {row.internal_details_confirmed_at && (
            <span className="pi-form-help">Confirmed {formatIsoDay(row.internal_details_confirmed_at)}. A change clears the confirmation until Submit for Approval asks for it again.</span>
          )}
        </>
      ) : (
        <form
          noValidate
          onSubmit={e => { e.preventDefault(); void save() }}
          style={{ display: 'flex', flexDirection: 'column' }}
          aria-label={`Edit ${ORDER_DETAILS_TITLE.toLowerCase()}`}
        >
          {/* ── Order dates ── */}
          <FormGroup title="Order dates" note="The dispatch date cannot be before the confirmation date.">
            <div className="pi-form-grid">
              {(['order_confirmation_date', 'due_date'] as const).map(key => {
                const id = orderDetailsInputId(key)
                const error = field(key)
                return (
                  <FormField key={key} id={id} label={ORDER_DETAILS_FIELD[key].label} required error={error}>
                    <input id={id} type="date" className="pi-form-input" value={form[key]} disabled={saving}
                      min={key === 'due_date' && form.order_confirmation_date ? form.order_confirmation_date : undefined}
                      aria-required="true" aria-invalid={error ? true : undefined}
                      aria-describedby={describedBy(id, false, Boolean(error))}
                      onChange={e => set(key, e.target.value)} />
                  </FormField>
                )
              })}
            </div>
          </FormGroup>

          {/* ── Order assignment ── */}
          <FormGroup title="Order assignment" note="Needed when the Order is created, not to submit this PI.">
            <div className="pi-form-grid">
              <FormField id={orderDetailsInputId('salesperson_id')} label={ORDER_DETAILS_FIELD.salesperson_id.label}
                help={salesDetailsAvailable ? `Management can change it when creating the Order.${workbookName}` : 'Available once the database update for this section is applied.'}>
                <select id={orderDetailsInputId('salesperson_id')} className="pi-form-input" value={form.salesperson_id}
                  disabled={saving || !salesDetailsAvailable}
                  aria-describedby={describedBy(orderDetailsInputId('salesperson_id'), true, false)}
                  onChange={e => set('salesperson_id', e.target.value)}>
                  <option value="">Choose the salesperson…</option>
                  {form.salesperson_id && !people.some(p => p.id === form.salesperson_id) && (
                    <option value={form.salesperson_id}>Saved (not in the list)</option>
                  )}
                  {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </FormField>
              <FormField id={orderDetailsInputId('lead_source')} label={ORDER_DETAILS_FIELD.lead_source.label} error={field('lead_source')}>
                <select id={orderDetailsInputId('lead_source')} className="pi-form-input" value={form.lead_source}
                  disabled={saving || !salesDetailsAvailable}
                  aria-invalid={field('lead_source') ? true : undefined}
                  aria-describedby={describedBy(orderDetailsInputId('lead_source'), false, Boolean(field('lead_source')))}
                  onChange={e => set('lead_source', e.target.value)}>
                  <option value="">Choose the lead source…</option>
                  {LEAD_SOURCE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </FormField>
            </div>
          </FormGroup>

          {/* ── Production details ── */}
          <FormGroup title="Production details">
            <ChoiceGroup
              legend={ORDER_DETAILS_FIELD.fabric_responsibility.label}
              required
              describedById="od-fabric-group"
              help={<>Fabric cost on this PI: {fabricCost === null ? 'not stated' : formatInr(fabricCost)}, from the workbook. Printed on the client PDF as one sentence.</>}
              error={field('fabric_responsibility')}
            >
              {FABRIC_RESPONSIBILITY_OPTIONS.map((option, i) => (
                <Choice key={option.value} id={i === 0 ? orderDetailsInputId('fabric_responsibility') : undefined}
                  name="od-fabric" label={option.label} disabled={saving}
                  checked={form.fabric_responsibility === option.value}
                  onChange={() => set('fabric_responsibility', option.value)} />
              ))}
            </ChoiceGroup>
            {fabricNote && <span className="pi-form-help">{FABRIC_RESPONSIBILITY_KEEPS_FIGURES}</span>}
          </FormGroup>

          {/* ── Commission: the question and its follow-up, together ── */}
          <FormGroup title="Commission">
            {restricted ? (
              <span className="pi-form-help">You may not read the middleman commission on this PI, so it is not edited here.</span>
            ) : (
              <>
                <ChoiceGroup legend={ORDER_DETAILS_FIELD.middleman_commission.label} required describedById="od-middleman-group">
                  {(['no', 'yes'] as const).map((answer, i) => (
                    <Choice key={answer} id={i === 0 ? orderDetailsInputId('middleman_commission') : undefined}
                      name="od-middleman" label={answer === 'yes' ? 'Yes' : 'No'} disabled={saving}
                      checked={form.middleman_commission === answer}
                      onChange={() => set('middleman_commission', answer)} />
                  ))}
                </ChoiceGroup>
                {form.middleman_commission === 'yes' && (
                  <div className="pi-form-followup">
                    <FormField id={orderDetailsInputId('middleman_structure')} label="Who receives it" required error={field('middleman_recipient')}>
                      <input id={orderDetailsInputId('middleman_structure')} type="text" maxLength={200} className="pi-form-input"
                        value={form.middleman_recipient} disabled={saving}
                        aria-required="true" aria-invalid={field('middleman_recipient') ? true : undefined}
                        aria-describedby={describedBy(orderDetailsInputId('middleman_structure'), false, Boolean(field('middleman_recipient')))}
                        onChange={e => set('middleman_recipient', e.target.value)} />
                    </FormField>
                    <ChoiceGroup legend="How it is agreed" required describedById="od-basis-group">
                      {(['amount', 'percent'] as const).map(basis => (
                        <Choice key={basis} name="od-basis" label={basis === 'amount' ? 'Agreed amount (₹)' : 'Agreed percentage'}
                          disabled={saving} checked={form.middleman_commission_basis === basis}
                          onChange={() => set('middleman_commission_basis', basis)} />
                      ))}
                    </ChoiceGroup>
                    {form.middleman_commission_basis === 'amount' && (
                      <FormField id="od-commission-amount" label="Amount (₹)" required error={field('middleman_commission_amount')}>
                        <input id="od-commission-amount" type="number" inputMode="decimal" min="0.01" step="0.01" className="pi-form-input" data-amount-input
                          value={form.middleman_commission_amount} disabled={saving}
                          aria-required="true" aria-invalid={field('middleman_commission_amount') ? true : undefined}
                          aria-describedby={describedBy('od-commission-amount', false, Boolean(field('middleman_commission_amount')))}
                          onChange={e => set('middleman_commission_amount', e.target.value)} />
                      </FormField>
                    )}
                    {form.middleman_commission_basis === 'percent' && (
                      <div className="pi-form-grid">
                        <FormField id="od-commission-percent" label="Percentage (%)" required error={field('middleman_commission_percent')}>
                          <input id="od-commission-percent" type="number" inputMode="decimal" min="0.001" max="100" step="0.001" className="pi-form-input"
                            value={form.middleman_commission_percent} disabled={saving}
                            aria-required="true" aria-invalid={field('middleman_commission_percent') ? true : undefined}
                            aria-describedby={describedBy('od-commission-percent', false, Boolean(field('middleman_commission_percent')))}
                            onChange={e => set('middleman_commission_percent', e.target.value)} />
                        </FormField>
                        <FormField id="od-commission-percent-of" label="Percentage of" required>
                          <select id="od-commission-percent-of" className="pi-form-input" aria-required="true"
                            value={form.middleman_commission_percent_of} disabled={saving}
                            onChange={e => set('middleman_commission_percent_of', e.target.value as OrderDetailsForm['middleman_commission_percent_of'])}>
                            <option value="">Choose the figure…</option>
                            {COMMISSION_PERCENT_OF_ORDER.map(k => <option key={k} value={k}>{COMMISSION_PERCENT_OF_LABEL[k]}</option>)}
                          </select>
                        </FormField>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </FormGroup>

          {/* ── Payment terms ── */}
          <FormGroup title="Payment">
            <FormField id={orderDetailsInputId('payment_terms')} label={ORDER_DETAILS_FIELD.payment_terms.label} optional
              help="How the payments are agreed to fall due. Sent unchanged with the PI." error={field('payment_terms')}>
              <textarea id={orderDetailsInputId('payment_terms')} rows={2} className="pi-form-input"
                maxLength={PAYMENT_TERMS_FIELD_MAX} value={form.payment_terms} disabled={saving}
                placeholder="e.g. 30% advance, 30% during production, 40% before dispatch"
                aria-invalid={field('payment_terms') ? true : undefined}
                aria-describedby={describedBy(orderDetailsInputId('payment_terms'), true, Boolean(field('payment_terms')))}
                onChange={e => set('payment_terms', e.target.value)} />
            </FormField>
          </FormGroup>

          {failure && <div role="alert" className="pi-form-failure">{failure}</div>}
          <div className="pi-form-footer">
            <span className="pi-form-footer-note">Saving keeps this a private draft; anything left blank can be added later.</span>
            <button type="button" className="boe-btn boe-btn-ghost" disabled={saving} onClick={() => { setEditing(false); setFailure(null) }}>Cancel</button>
            <button type="submit" className="boe-btn boe-btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

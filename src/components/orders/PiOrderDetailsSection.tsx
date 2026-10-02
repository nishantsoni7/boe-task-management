'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Lock, Pencil } from 'lucide-react'
import { formatInr } from '@/lib/pi/previewView'
import { FABRIC_RESPONSIBILITY_KEEPS_FIGURES, FABRIC_RESPONSIBILITY_OPTIONS, fabricResponsibilityNeedsConfirmation } from '@/lib/orders/piTerms'
import { COMMISSION_PERCENT_OF_LABEL, COMMISSION_PERCENT_OF_ORDER, formatIsoDay } from '@/lib/orders/piInternalDetails'
import { formatBillingPercentage, readBillingPercentage } from '@/lib/orders/billingPercentage'
import {
  PAYMENT_TERMS_FIELD_MAX,
  LEAD_SOURCE_OPTIONS,
  ORDER_DETAILS_ANCHOR,
  ORDER_DETAILS_FIELD,
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
import { Choice, ChoiceGroup, FormField, FormGrid, RequiredMark, describedBy } from './PiFormParts'

/** The id of a field's input, for the readiness checklist to focus. */
export const orderDetailsInputId = (key: OrderDetailsFieldKey): string =>
  key === 'middleman_structure' ? 'od-middleman_recipient' : `od-${key}`

/** What Submit for approval asks of the person, from the fields' own classification. */
const requiredToSubmit = (key: OrderDetailsFieldKey): boolean => ORDER_DETAILS_FIELD[key].need === 'submission'

const BILLING_ID = 'od-billing_percentage'

/** Shorter labels for the four-column grid; the stored field names and meanings are unchanged. */
const DISPLAY_LABEL: Partial<Record<OrderDetailsFieldKey, string>> = {
  order_confirmation_date: 'Confirmation date',
  due_date: 'Dispatch date',
  salesperson_id: 'Assigned salesperson',
  middleman_commission: 'Middleman commission',
}
const labelOf = (key: OrderDetailsFieldKey): string => DISPLAY_LABEL[key] ?? ORDER_DETAILS_FIELD[key].label

/**
 * The read view, in the order a person scans it: four columns, two rows. The
 * billing percentage sits in the second row with its own inline control.
 */
const ROW_ONE: readonly OrderDetailsFieldKey[] = ['order_confirmation_date', 'due_date', 'fabric_responsibility', 'salesperson_id']
const ROW_TWO_BEFORE_BILLING: readonly OrderDetailsFieldKey[] = ['middleman_commission']
const ROW_TWO_AFTER_BILLING: readonly OrderDetailsFieldKey[] = ['payment_terms', 'lead_source']

/** One fact in the read view. A missing required value is said, never blank. */
function ReviewCell({ row, missing }: { row: OrderDetailsReviewRow; missing: boolean }) {
  return (
    <div className="pi-od-cell">
      <dt>{labelOf(row.key)}{requiredToSubmit(row.key) && <RequiredMark />}</dt>
      <dd data-empty={row.value ? undefined : 'true'} data-required={!row.value && missing ? 'true' : undefined}>
        {row.value ?? orderDetailsAbsent(row.need, row.key)}
      </dd>
    </div>
  )
}

/**
 * THE BILLING PERCENTAGE, inline in Internal order details: the same field, the
 * same range check and the same RPC (set_order_submission_billing_percentage,
 * through the shared save plan) it always had — sent only when it changed. A
 * blank percentage stays "not declared". `canEdit` is the page's
 * can_edit_order_submission answer and the RPC re-derives it.
 */
function BillingCell({ supabase, submissionId, row, rowVersion, canEdit, grandTotal, billingValue, focus, onSaved }: {
  supabase: SupabaseClient
  submissionId: string
  row: OrderDetailsRow
  rowVersion: number | null
  canEdit: boolean
  grandTotal: number | null
  /** The billed amount, formatted, when a percentage is declared and the total is known. */
  billingValue: string | null
  focus: { field: OrderDetailsFieldKey; nonce: number } | null
  onSaved: () => void | Promise<void>
}) {
  const stored = useMemo(() => orderDetailsForm(row).billing_percentage, [row])
  const [edited, setEdited] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const value = edited ?? stored
  const dirty = value.trim() !== stored.trim()
  const cellRef = useRef<HTMLDivElement | null>(null)

  // The checklist's "Add" for the billing percentage: bring the field up and focus it.
  useEffect(() => {
    if (!focus || focus.field !== 'billing_percentage' || !canEdit) return
    const t = setTimeout(() => {
      document.getElementById(BILLING_ID)?.focus({ preventScroll: true })
      cellRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce])

  const next = { ...orderDetailsForm(row), billing_percentage: value }
  const error = dirty ? orderDetailsErrors(next, grandTotal).billing_percentage ?? null : null

  const save = async () => {
    if (saving || !dirty || error) return
    const plan = orderDetailsSavePlan(row, next)
    if (plan.length === 0) { setEdited(null); return }
    setSaving(true)
    setFailure(null)
    setSaved(false)
    try {
      const result = await runOrderDetailsSave({
        plan,
        version: rowVersion,
        call: async (rpc, args) => { const { data, error: rpcError } = await supabase.rpc(rpc, { p_submission_id: submissionId, ...args }); return { data, error: rpcError } },
        readVersion: async () => {
          const { data } = await supabase.from('order_submissions').select('row_version').eq('id', submissionId).maybeSingle()
          const v = (data as { row_version?: unknown } | null)?.row_version
          return typeof v === 'number' ? v : null
        },
      })
      if (result.saved.length > 0) await onSaved()
      if (result.ok) { setEdited(null); setSaved(true) } else setFailure(orderDetailsSaveFailureText(result).split(' Your remaining')[0])
    } finally {
      setSaving(false)
    }
  }

  const declared = readBillingPercentage(row.billing_percentage ?? null)
  const label = ORDER_DETAILS_FIELD.billing_percentage.label
  return (
    <div className="pi-od-cell" ref={cellRef}>
      <dt>{canEdit ? <label htmlFor={BILLING_ID}>{label}</label> : label}</dt>
      <dd data-empty={!canEdit && declared === null ? 'true' : undefined}>
        {canEdit ? (
          <div className="pi-inline-save">
            <div className="pi-input-suffix">
              <input
                id={BILLING_ID} type="text" inputMode="decimal" className="pi-form-input" placeholder="e.g. 65"
                value={value} disabled={saving}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(BILLING_ID, false, Boolean(error ?? failure))}
                onChange={e => { setEdited(e.target.value); setSaved(false); setFailure(null) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save() } }}
              />
              <span aria-hidden="true">%</span>
            </div>
            <button type="button" className="boe-btn boe-btn-ghost" disabled={saving || !dirty || Boolean(error)} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save percentage'}
            </button>
            {saved && !dirty && <span role="status" className="pi-detail-highlight-saved" style={{ alignSelf: 'center' }}>Saved</span>}
          </div>
        ) : declared === null ? 'Not declared' : formatBillingPercentage(declared)}
        {declared !== null && billingValue && !dirty && <span className="pi-od-sub">Billing value {billingValue}</span>}
        {(error ?? failure) && <span id={`${BILLING_ID}-error`} role="alert" className="pi-form-error">{error ?? failure}</span>}
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
 * The read view is four columns over two rows. The billing percentage is saved
 * from its own inline control there (and from the form, when it is open). Billing
 * terms are no longer offered anywhere on this page; a stored value is left
 * exactly as it is, because this form only ever sends the fields whose value
 * changed.
 */
export function PiOrderDetailsSection({
  supabase, submissionId, row, rowVersion, canEdit, salesDetailsAvailable, people, grandTotal, fabricCost,
  focus, onSaved, locked = false, billingValue = null,
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
  /** The billed amount, formatted, shown under a declared percentage. Null when there is none to show. */
  billingValue?: string | null
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
  // The billing percentage answers to the same request from its inline control, so
  // this form does not open for it.
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
  // A commission answered Yes without its details is a gap keyed middleman_structure; the read view shows it on the commission line.
  const cells = (keys: readonly OrderDetailsFieldKey[]) => keys.map(key => {
    const r = reviewByKey.get(key)
    const missing = gaps.has(key) || (key === 'middleman_commission' && gaps.has('middleman_structure'))
    return r ? <ReviewCell key={key} row={r} missing={missing} /> : null
  })
  const billingError = field('billing_percentage')

  return (
    <section
      id={ORDER_DETAILS_ANCHOR}
      ref={sectionRef}
      aria-label={ORDER_DETAILS_TITLE}
      className="pi-form-card pi-order-details"
    >
      <div className="pi-form-card-head">
        <h2 className="pi-form-card-title">{ORDER_DETAILS_TITLE}</h2>
        <span className="pi-detail-internal-tag" title={ORDER_DETAILS_NOTE}>
          <Lock size={10} strokeWidth={2.2} aria-hidden />
          Internal
        </span>
        {canEdit && !editing && (
          <button type="button" className="boe-btn boe-btn-ghost pi-section-action" onClick={open}>
            <Pencil size={12} aria-hidden /> {gaps.size > 0 ? 'Complete details' : 'Edit details'}
          </button>
        )}
        {!canEdit && locked && (
          <button type="button" className="boe-btn boe-btn-ghost pi-section-action" disabled
            style={{ opacity: 0.55, cursor: 'not-allowed' }}
            title="Locked while this PI is with management.">
            <Pencil size={12} aria-hidden /> Edit details
          </button>
        )}
      </div>

      {!editing ? (
        <div className="pi-form-body">
          <dl className="pi-od-grid">
            {cells(ROW_ONE)}
            {cells(ROW_TWO_BEFORE_BILLING)}
            <BillingCell
              supabase={supabase} submissionId={submissionId} row={row} rowVersion={rowVersion}
              canEdit={canEdit && !locked} grandTotal={grandTotal} billingValue={billingValue}
              focus={focus} onSaved={onSaved}
            />
            {cells(ROW_TWO_AFTER_BILLING)}
          </dl>
          {row.internal_details_confirmed_at && (
            <span className="pi-form-help">Confirmed {formatIsoDay(row.internal_details_confirmed_at)}. A change clears the confirmation until Submit for Approval asks for it again.</span>
          )}
        </div>
      ) : (
        <form
          noValidate
          onSubmit={e => { e.preventDefault(); void save() }}
          className="pi-form-body"
          aria-label={`Edit ${ORDER_DETAILS_TITLE.toLowerCase()}`}
        >
          <FormGrid>
            {(['order_confirmation_date', 'due_date'] as const).map(key => {
              const id = orderDetailsInputId(key)
              const error = field(key)
              const help = key === 'due_date' ? 'Not before the confirmation date.' : undefined
              return (
                <FormField key={key} id={id} label={labelOf(key)} required span={3} help={help} error={error}>
                  <input id={id} type="date" className="pi-form-input" value={form[key]} disabled={saving}
                    min={key === 'due_date' && form.order_confirmation_date ? form.order_confirmation_date : undefined}
                    aria-required="true" aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(id, Boolean(help), Boolean(error))}
                    onChange={e => set(key, e.target.value)} />
                </FormField>
              )
            })}

            <ChoiceGroup
              legend={ORDER_DETAILS_FIELD.fabric_responsibility.label}
              required
              span={3}
              describedById="od-fabric-group"
              help={<>Fabric cost on this PI: {fabricCost === null ? 'not stated' : formatInr(fabricCost)}.</>}
              error={field('fabric_responsibility')}
            >
              {FABRIC_RESPONSIBILITY_OPTIONS.map((option, i) => (
                <Choice key={option.value} id={i === 0 ? orderDetailsInputId('fabric_responsibility') : undefined}
                  name="od-fabric" label={option.label} disabled={saving}
                  checked={form.fabric_responsibility === option.value}
                  onChange={() => set('fabric_responsibility', option.value)} />
              ))}
            </ChoiceGroup>

            <FormField id={orderDetailsInputId('salesperson_id')} label={labelOf('salesperson_id')} span={3}
              help={salesDetailsAvailable ? undefined : 'Available once the database update for this section is applied.'}>
              <select id={orderDetailsInputId('salesperson_id')} className="pi-form-input" value={form.salesperson_id}
                disabled={saving || !salesDetailsAvailable}
                aria-describedby={describedBy(orderDetailsInputId('salesperson_id'), !salesDetailsAvailable, false)}
                onChange={e => set('salesperson_id', e.target.value)}>
                <option value="">Choose…</option>
                {form.salesperson_id && !people.some(p => p.id === form.salesperson_id) && (
                  <option value={form.salesperson_id}>Saved (not in the list)</option>
                )}
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>

            {/* The commission question; its follow-up sits under the row. */}
            {restricted ? (
              <span className="pi-form-help pi-span-3">You may not read the middleman commission on this PI, so it is not edited here.</span>
            ) : (
              <ChoiceGroup legend={labelOf('middleman_commission')} required span={3} describedById="od-middleman-group">
                {(['no', 'yes'] as const).map((answer, i) => (
                  <Choice key={answer} id={i === 0 ? orderDetailsInputId('middleman_commission') : undefined}
                    name="od-middleman" label={answer === 'yes' ? 'Yes' : 'No'} disabled={saving}
                    checked={form.middleman_commission === answer}
                    onChange={() => set('middleman_commission', answer)} />
                ))}
              </ChoiceGroup>
            )}

            <FormField id={BILLING_ID} label={ORDER_DETAILS_FIELD.billing_percentage.label} span={3} error={billingError}>
              <div className="pi-input-suffix" style={{ flexBasis: 'auto', maxWidth: '160px' }}>
                <input id={BILLING_ID} type="text" inputMode="decimal" className="pi-form-input" placeholder="e.g. 65"
                  value={form.billing_percentage} disabled={saving}
                  aria-invalid={billingError ? true : undefined}
                  aria-describedby={describedBy(BILLING_ID, false, Boolean(billingError))}
                  onChange={e => set('billing_percentage', e.target.value)} />
                <span aria-hidden="true">%</span>
              </div>
            </FormField>

            <FormField id={orderDetailsInputId('payment_terms')} label={ORDER_DETAILS_FIELD.payment_terms.label} span={3} error={field('payment_terms')}>
              <textarea id={orderDetailsInputId('payment_terms')} rows={2} className="pi-form-input"
                maxLength={PAYMENT_TERMS_FIELD_MAX} value={form.payment_terms} disabled={saving}
                placeholder="e.g. 30% advance, 70% before dispatch"
                aria-invalid={field('payment_terms') ? true : undefined}
                aria-describedby={describedBy(orderDetailsInputId('payment_terms'), false, Boolean(field('payment_terms')))}
                onChange={e => set('payment_terms', e.target.value)} />
            </FormField>

            <FormField id={orderDetailsInputId('lead_source')} label={ORDER_DETAILS_FIELD.lead_source.label} span={3} error={field('lead_source')}>
              <select id={orderDetailsInputId('lead_source')} className="pi-form-input" value={form.lead_source}
                disabled={saving || !salesDetailsAvailable}
                aria-invalid={field('lead_source') ? true : undefined}
                aria-describedby={describedBy(orderDetailsInputId('lead_source'), false, Boolean(field('lead_source')))}
                onChange={e => set('lead_source', e.target.value)}>
                <option value="">Choose…</option>
                {LEAD_SOURCE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </FormField>

            {fabricNote && <span className="pi-form-help pi-span-12">{FABRIC_RESPONSIBILITY_KEEPS_FIGURES}</span>}

            {!restricted && form.middleman_commission === 'yes' && (
              <div className="pi-form-followup pi-span-12">
                <FormGrid>
                  <FormField id={orderDetailsInputId('middleman_structure')} label="Who receives it" required span={6} error={field('middleman_recipient')}>
                    <input id={orderDetailsInputId('middleman_structure')} type="text" maxLength={200} className="pi-form-input"
                      value={form.middleman_recipient} disabled={saving}
                      aria-required="true" aria-invalid={field('middleman_recipient') ? true : undefined}
                      aria-describedby={describedBy(orderDetailsInputId('middleman_structure'), false, Boolean(field('middleman_recipient')))}
                      onChange={e => set('middleman_recipient', e.target.value)} />
                  </FormField>
                  <ChoiceGroup legend="How it is agreed" required span={6} describedById="od-basis-group">
                    {(['amount', 'percent'] as const).map(basis => (
                      <Choice key={basis} name="od-basis" label={basis === 'amount' ? 'Agreed amount (₹)' : 'Agreed percentage'}
                        disabled={saving} checked={form.middleman_commission_basis === basis}
                        onChange={() => set('middleman_commission_basis', basis)} />
                    ))}
                  </ChoiceGroup>
                  {form.middleman_commission_basis === 'amount' && (
                    <FormField id="od-commission-amount" label="Amount (₹)" required span={3} error={field('middleman_commission_amount')}>
                      <input id="od-commission-amount" type="number" inputMode="decimal" min="0.01" step="0.01" className="pi-form-input" data-amount-input
                        value={form.middleman_commission_amount} disabled={saving}
                        aria-required="true" aria-invalid={field('middleman_commission_amount') ? true : undefined}
                        aria-describedby={describedBy('od-commission-amount', false, Boolean(field('middleman_commission_amount')))}
                        onChange={e => set('middleman_commission_amount', e.target.value)} />
                    </FormField>
                  )}
                  {form.middleman_commission_basis === 'percent' && (
                    <>
                      <FormField id="od-commission-percent" label="Percentage (%)" required span={3} error={field('middleman_commission_percent')}>
                        <input id="od-commission-percent" type="number" inputMode="decimal" min="0.001" max="100" step="0.001" className="pi-form-input"
                          value={form.middleman_commission_percent} disabled={saving}
                          aria-required="true" aria-invalid={field('middleman_commission_percent') ? true : undefined}
                          aria-describedby={describedBy('od-commission-percent', false, Boolean(field('middleman_commission_percent')))}
                          onChange={e => set('middleman_commission_percent', e.target.value)} />
                      </FormField>
                      <FormField id="od-commission-percent-of" label="Percentage of" required span={8}>
                        <select id="od-commission-percent-of" className="pi-form-input" aria-required="true"
                          value={form.middleman_commission_percent_of} disabled={saving}
                          onChange={e => set('middleman_commission_percent_of', e.target.value as OrderDetailsForm['middleman_commission_percent_of'])}>
                          <option value="">Choose the figure…</option>
                          {COMMISSION_PERCENT_OF_ORDER.map(k => <option key={k} value={k}>{COMMISSION_PERCENT_OF_LABEL[k]}</option>)}
                        </select>
                      </FormField>
                    </>
                  )}
                </FormGrid>
              </div>
            )}
          </FormGrid>

          {failure && <div role="alert" className="pi-form-failure">{failure}</div>}
          <div className="pi-form-footer">
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

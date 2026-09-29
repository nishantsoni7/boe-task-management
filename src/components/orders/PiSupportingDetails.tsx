'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readBillingPercentage, formatBillingPercentage } from '@/lib/orders/billingPercentage'
import {
  ORDER_DETAILS_FIELD,
  orderDetailsErrors,
  orderDetailsForm,
  orderDetailsSaveFailureText,
  orderDetailsSavePlan,
  runOrderDetailsSave,
  type OrderDetailsFieldKey,
  type OrderDetailsRow,
} from '@/lib/orders/salesOrderDetails'
import { PiHighlightRemark } from './PiHighlightRemark'
import { PiDraftAttachments, PiSentDocuments, type SupportingState } from './PiSupportingDocuments'
import { FormField, describedBy } from './PiFormParts'

export const SUPPORTING_DETAILS_TITLE = 'Supporting details'
const BILLING_ID = 'od-billing_percentage'

/**
 * SUPPORTING DETAILS: the optional things around a PI, in one compact card above
 * Internal order details — Client PO and Design Files side by side, the Order
 * highlight, and the billing percentage.
 *
 * Nothing here is needed to submit. Each part keeps the door it always had: the
 * files go through the staging table, the highlight through its own RPC, and the
 * billing percentage through set_order_submission_billing_percentage — sent only
 * when it changed, exactly as the Internal order details form sent it before it
 * moved here. A blank billing percentage stays "not declared". PRESENTATION AND
 * ORCHESTRATION ONLY: `canEditBilling`, `canEditFiles` and `canEditHighlight` are the page's
 * can_edit_order_submission answers and every RPC re-derives them.
 *
 * Locked (with management): the same three parts, read-only — no Add, no Save.
 */
export function PiSupportingDetails({
  supabase, submissionId, row, rowVersion, canEditBilling, canEditFiles, canEditHighlight, locked, supporting, submittedAt,
  grandTotal, focus, onSaved, onHighlightRead,
}: {
  supabase: SupabaseClient
  submissionId: string
  row: OrderDetailsRow
  rowVersion: number | null
  canEditBilling: boolean
  /** Client PO and Design Files: only while the PI is a draft or returned. */
  canEditFiles: boolean
  /** The Order highlight: can_edit_order_submission, as the page resolved it. */
  canEditHighlight: boolean
  locked: boolean
  supporting: SupportingState
  submittedAt: string | null
  grandTotal: number | null
  /** Set by the checklist: focus the billing percentage when it names it. */
  focus: { field: OrderDetailsFieldKey; nonce: number } | null
  onSaved: () => void | Promise<void>
  onHighlightRead: (state: { available: boolean; remark: string | null } | null) => void
}) {
  const stored = useMemo(() => orderDetailsForm(row).billing_percentage, [row])
  const [edited, setEdited] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const value = edited ?? stored
  const dirty = value.trim() !== stored.trim()

  // The checklist's "Add" for the billing percentage: bring the field up and focus it.
  useEffect(() => {
    if (!focus || focus.field !== 'billing_percentage' || !canEditBilling) return
    const t = setTimeout(() => {
      document.getElementById(BILLING_ID)?.focus({ preventScroll: true })
      rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
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

  return (
    <section
      id="pi-supporting-details"
      ref={rootRef}
      aria-label={SUPPORTING_DETAILS_TITLE}
      className="pi-form-card"
    >
      <div className="pi-form-card-head">
        <h2 className="pi-form-card-title">{SUPPORTING_DETAILS_TITLE}</h2>
        <span className="pi-form-optional" style={{ marginLeft: 0 }}>Optional. Nothing here is needed to submit.</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', marginTop: '14px' }}>
        {locked ? (
          <PiSentDocuments supabase={supabase} piSubmissionId={submissionId} refreshKey={submittedAt} />
        ) : (
          <PiDraftAttachments supabase={supabase} state={supporting} canEdit={canEditFiles} />
        )}

        <PiHighlightRemark
          supabase={supabase}
          submissionId={submissionId}
          canEdit={canEditHighlight && !locked}
          rowVersion={rowVersion}
          onSaved={() => { void onSaved() }}
          onRead={onHighlightRead}
          bare
        />

        {canEditBilling && !locked ? (
          <FormField
            id={BILLING_ID}
            label={ORDER_DETAILS_FIELD.billing_percentage.label}
            optional
            help={<>{ORDER_DETAILS_FIELD.billing_percentage.hint} Leave blank if it is not declared.</>}
            error={error ?? failure}
          >
            <div className="pi-inline-save">
              <div className="pi-input-suffix">
                <input
                  id={BILLING_ID} type="text" inputMode="decimal" className="pi-form-input" placeholder="e.g. 65"
                  value={value} disabled={saving}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={describedBy(BILLING_ID, true, Boolean(error ?? failure))}
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
          </FormField>
        ) : (declared !== null || locked) && (
          <dl className="pi-form-facts" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <div className="pi-form-fact">
              <dt>{ORDER_DETAILS_FIELD.billing_percentage.label} <span className="pi-form-optional">Internal</span></dt>
              <dd data-empty={declared === null ? 'true' : undefined}>
                {declared === null ? 'Not declared' : formatBillingPercentage(declared)}
              </dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  )
}

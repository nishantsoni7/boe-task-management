'use client'

import Link from 'next/link'
import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { LoadingScreen } from '@/components/ui/atoms'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { createLead, recordEnquiry, SALES_KEY, SalesRequestError, type SalesLead } from '@/lib/salesLeads/api'
import { sourceLabel } from '@/lib/salesLeads/constants'
import { dayLabelLong } from '@/lib/salesLeads/format'
import { EMPTY_FORM, toInput, validateLead, type LeadForm } from '@/lib/salesLeads/validation'
import { istToday } from '@/lib/istDate'
import { createClient } from '@/lib/supabase/client'
import { DetailFields, DupCallout, phoneCanSave, PhoneField, SourceField, usePhoneStatus } from './LeadFields'
import { SalesFrame } from './SalesFrame'
import s from './salesLeads.module.css'

// Add lead: the number, where it came from, and whatever else is known. The lead is saved NOT allotted: who gets
// it is chosen later, from the list. The received date is today in India, filled in by the database.

export function AddLeadScreen() {
  const { ready } = usePermissionContext()
  const { canCreate } = useSalesAccess()
  const router = useRouter()
  const queryClient = useQueryClient()
  const supabase = useMemo(() => createClient(), [])
  const [form, setForm] = useState<LeadForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** A number somebody else added a moment ago, found out only when saving. */
  const [raced, setRaced] = useState<SalesLead | null>(null)
  const [justSaved, setJustSaved] = useState<SalesLead | null>(null)
  const numberBox = useRef<HTMLDivElement>(null)

  const phone = usePhoneStatus(supabase, form.countryCode, form.number)
  const errors = validateLead(form)
  const canSave = phoneCanSave(phone) && Object.keys(errors).length === 0

  const change = (patch: Partial<LeadForm>) => {
    setForm(f => ({ ...f, ...patch }))
    setProblem(null)
    if ('number' in patch || 'countryCode' in patch) setRaced(null)
  }

  async function submit(andAnother: boolean) {
    if (!canSave || saving) return
    setSaving(true)
    setProblem(null)
    try {
      const result = await createLead(supabase, toInput(form))
      if (result.status === 'duplicate') {
        setRaced(result.lead)
        // The number was free when it was last checked and is not now: look again, so the page agrees with itself.
        await queryClient.invalidateQueries({ queryKey: [SALES_KEY, 'phone'] })
        return
      }
      void queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
      if (andAnother) {
        setForm(EMPTY_FORM)
        setJustSaved(result.lead)
        numberBox.current?.querySelector('input')?.focus()
      } else {
        router.push('/sales/lead-master')
      }
    } catch (e) {
      setProblem(e instanceof SalesRequestError ? e.message : 'Something went wrong. Nothing was confirmed saved: try again.')
    } finally {
      setSaving(false)
    }
  }

  // The same customer asked again: it goes on the lead they already are, and back to the top of its holder's day.
  async function repeatEnquiry(lead: SalesLead) {
    await recordEnquiry(supabase, lead.id, form.source ? sourceLabel(form.source) : 'Not said', form.requirement)
    await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
  }

  const missing: string[] = []
  if (!phoneCanSave(phone)) missing.push('a valid mobile number')
  if (errors.source) missing.push('a lead source')
  const why = raced || phone.kind === 'taken'
    ? 'Change the number, it is already a lead'
    : missing.length > 0 ? `Still needed: ${missing.join(' and ')}` : 'Received today · you allot it from the list'

  let body: React.ReactNode
  if (!ready) {
    body = <LoadingScreen message="Loading..." />
  } else if (!canCreate) {
    body = (
      <div className="boe-empty">
        <p className="boe-empty-title">You cannot add leads here</p>
        <p>Ask an administrator for the Create right on Sales.</p>
        <Link className="boe-btn boe-btn-secondary" href="/sales/lead-master">Back to the Lead Master</Link>
      </div>
    )
  } else {
    body = (
      <div className={`${s.wrap} ${s.wrapForm}`}>
        {justSaved && (
          <div className="boe-callout boe-callout-success" role="status" style={{ marginBottom: 14 }}>
            <div>
              <span className="boe-callout-title">Lead #{justSaved.lead_no} saved</span>
              <span>It is waiting to be allotted. Add the next one, or allot from the list.</span>
            </div>
          </div>
        )}
        <form className={s.panel} onSubmit={e => { e.preventDefault(); void submit(false) }} noValidate>
          <div className={s.panelHead}>
            <div>
              <h2 className={s.panelTitle}>New lead</h2>
              <div className={s.panelSub}>Only the number and the source are needed. Allot it later, from the list.</div>
            </div>
            <div className={s.received} title="Filled in automatically. It stands for the day the lead was received.">
              <Lock aria-hidden="true" />
              Received {dayLabelLong(istToday())} <span>· today</span>
            </div>
          </div>

          <div className={s.panelBody}>
            <div ref={numberBox}>
              <PhoneField form={form} onChange={change} status={phone} inputId="sales-add-phone" onRepeat={repeatEnquiry} />
              {raced && phone.kind !== 'taken' && <DupCallout lead={raced} onRepeat={repeatEnquiry} />}
            </div>
            <SourceField form={form} onChange={change} error={undefined} />
            <div className={s.divider}>Optional <span>· add what you know</span></div>
            <DetailFields form={form} onChange={change} errors={errors} idPrefix="sales-add" />
          </div>

          <div className={s.actions}>
            <button type="submit" className="boe-btn boe-btn-primary" disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save lead'}</button>
            <button type="button" className="boe-btn boe-btn-secondary" disabled={!canSave || saving} onClick={() => void submit(true)}>Save and add another</button>
            <span className={s.actionsWhy} aria-live="polite">{problem ?? why}</span>
          </div>
        </form>
      </div>
    )
  }

  return <SalesFrame title="Add lead" subtitle="Lead Master">{body}</SalesFrame>
}

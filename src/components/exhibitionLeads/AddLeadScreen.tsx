'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ListChecks } from 'lucide-react'
import { ExhibitionLeadsLayout } from '@/components/layout/ExhibitionLeadsLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { useExhibitionLeads, useExhibitions } from '@/hooks/useExhibitionLeads'
import {
  BUYING_TIMELINES, CLIENT_TYPES, LEAD_TYPES, REQUIREMENTS,
} from '@/lib/exhibitionLeads/constants'
import {
  EXHIBITION_LEADS_KEY, createLead, fetchLeadPage, updateLead, LeadRequestError, type CreateResult,
} from '@/lib/exhibitionLeads/api'
import { exhibitionDates } from '@/lib/exhibitionLeads/format'
import {
  MAX_CITY, MAX_COMPANY, MAX_NAME, MAX_NOTE, MAX_OTHER,
  emptyLeadForm, toCreateArgs, toggleRequirement, validateLeadForm,
  type LeadFormErrors, type LeadFormValues,
} from '@/lib/exhibitionLeads/validation'
import { clearDraft, newSubmissionId, saveDraft, takeDraft } from '@/lib/exhibitionLeads/draft'
import { ChoiceGroup } from './ChoiceGroup'
import dynamic from 'next/dynamic'
// Only needed when a duplicate is found and the person opens the existing lead.
const LeadDetailSheet = dynamic(() => import('./LeadDetailSheet'), { ssr: false })
import s from './leads.module.css'

type Duplicate = { mine: true; leadId: string } | { mine: false }
type Failure = { kind: LeadRequestError['kind']; message: string }

const Req = () => <span className={s.req} aria-hidden="true">*</span>

export default function AddLeadScreen() {
  const { supabase, profile, isAdmin, loading, signOut } = useExhibitionLeads()
  const { exhibitions, defaultExhibition } = useExhibitions(supabase, !loading)
  const qc = useQueryClient()

  // A draft parked by a session expiry is picked up once, before the first paint
  // of the form (the screen shows a loading state until the session resolves, so
  // nothing server-rendered can disagree with it).
  const [parked] = useState(() => (typeof window === 'undefined' ? null : takeDraft()))

  const [chosenExhibition, setChosenExhibition] = useState<string | null>(parked?.exhibitionId ?? null)
  const exhibitionId = chosenExhibition ?? defaultExhibition?.id ?? null
  const exhibition = exhibitions.find(e => e.id === exhibitionId) ?? null

  const [values, setValues] = useState<LeadFormValues>(() => parked?.values ?? emptyLeadForm())
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [saved, setSaved] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null)
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)
  const restored = parked !== null

  // THE IDEMPOTENCY KEY. One id per entry: it is reused for every retry of the
  // same content and replaced only after a confirmed save, an intentional
  // "new entry", or when the person changed what they are sending.
  const attempt = useRef<{ id: string; payload: string }>({ id: parked?.submissionId ?? newSubmissionId(), payload: '' })
  const savingRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)

  const errors: LeadFormErrors = showErrors ? validateLeadForm(values) : {}
  const set = <K extends keyof LeadFormValues>(key: K, v: LeadFormValues[K]) => {
    setValues(prev => ({ ...prev, [key]: v }))
    setSaved(null)
    setFailure(null)
    setDuplicate(null)
  }

  const counts = useQuery({
    queryKey: [...EXHIBITION_LEADS_KEY, 'page', 'form-counts', exhibitionId],
    queryFn: () => fetchLeadPage(supabase, { scope: 'mine', exhibition_id: exhibitionId ?? undefined }, 0, 0),
    enabled: !loading && !!exhibitionId,
  })

  function startNewEntry() {
    attempt.current = { id: newSubmissionId(), payload: '' }
    setValues(emptyLeadForm())
    setShowErrors(false)
    setFormKey(k => k + 1)
    setDuplicate(null)
    setFailure(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    requestAnimationFrame(() => nameRef.current?.focus())
  }

  async function submit(ev?: React.FormEvent) {
    ev?.preventDefault()
    if (savingRef.current || !exhibitionId) return
    setShowErrors(true)
    setSaved(null); setFailure(null); setDuplicate(null)
    const problems = validateLeadForm(values)
    if (Object.keys(problems).length) {
      const first = document.querySelector<HTMLElement>('[data-invalid="true"]')
      first?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      first?.focus?.()
      return
    }

    const args = toCreateArgs(values)
    const payload = JSON.stringify([exhibitionId, args])
    // Same content → same id (a retry is safe). Edited content → a fresh id;
    // the phone-number rule on the server still stops a double entry.
    if (attempt.current.payload && attempt.current.payload !== payload) {
      attempt.current = { id: newSubmissionId(), payload }
    } else {
      attempt.current.payload = payload
    }

    savingRef.current = true
    setSaving(true)
    try {
      const res: CreateResult = await createLead(supabase, {
        submissionId: attempt.current.id, exhibitionId, ...args,
      })
      if (res.outcome === 'created' || res.outcome === 'replayed') {
        clearDraft()
        setSaved(values.contactName.trim())
        startNewEntry()
        qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
      } else if (res.mine) {
        setDuplicate({ mine: true, leadId: res.lead_id })
      } else {
        setDuplicate({ mine: false })
      }
    } catch (e) {
      const err = e as LeadRequestError
      if (err.kind === 'auth') {
        saveDraft({ values, exhibitionId, submissionId: attempt.current.id })
      }
      setFailure({ kind: err.kind ?? 'unknown', message: err.message })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function addNoteToExisting(leadId: string) {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      await updateLead(supabase, leadId, {}, values.note.trim() || null)
      setSaved(`${values.contactName.trim()} (follow-up note added to the existing lead)`)
      startNewEntry()
      qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
    } catch (e) {
      const err = e as LeadRequestError
      setFailure({ kind: err.kind ?? 'unknown', message: err.message })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  if (loading) return <LoadingScreen />

  const todayCount = counts.data?.mine.owned_today
  const loginHref = `/login?redirect=${encodeURIComponent('/exhibition-leads/add')}`

  return (
    <ExhibitionLeadsLayout
      profile={profile} isAdmin={isAdmin} onSignOut={signOut}
      title="Add Exhibition Lead"
      subtitle={exhibition ? `${exhibition.name} · ${exhibitionDates(exhibition)}` : undefined}
    >
      <div className={s.wrap}>
        <div className={s.topStrip}>
          <Link href="/exhibition-leads/my" className={s.myLeadsLink}>
            <ListChecks size={18} aria-hidden="true" />
            My Leads
            <span className={s.countPill} aria-label={`${todayCount ?? 0} added today`}>{todayCount ?? '–'}</span>
            <span className={s.hint}>today</span>
          </Link>
          {exhibitions.length > 1 ? (
            <select
              className={`${s.select} ${s.exhibitionSelect}`} style={{ width: 'auto', maxWidth: '100%' }}
              aria-label="Exhibition" value={exhibitionId ?? ''} onChange={e => setChosenExhibition(e.target.value)}
            >
              {exhibitions.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          ) : exhibition ? (
            <div className={s.exhibitionTag}>Exhibition: <strong>{exhibition.name}</strong></div>
          ) : null}
        </div>

        {!exhibitionId && (
          <div className={`${s.notice} ${s.noticeWarn}`}>No active exhibition is set up yet. Ask Admin.</div>
        )}

        {saved && (
          <div className={`${s.notice} ${s.noticeOk}`} role="status">
            <strong>Saved</strong> — {saved}. Ready for the next visitor.
          </div>
        )}
        {restored && !saved && (
          <div className={`${s.notice} ${s.noticeWarn}`} role="status">
            Your session ended while saving. What you entered has been restored — check it and save again.
          </div>
        )}

        <form key={formKey} className={s.formCard} onSubmit={submit} noValidate>
          <div className={s.field}>
            <label className={s.label} htmlFor="lead-name">Contact name<Req /></label>
            <input
              id="lead-name" ref={nameRef} className={`${s.input}${errors.contactName ? ` ${s.invalid}` : ''}`}
              value={values.contactName} maxLength={MAX_NAME + 20} autoComplete="off" autoCapitalize="words"
              aria-invalid={!!errors.contactName} aria-describedby={errors.contactName ? 'err-name' : undefined}
              data-invalid={errors.contactName ? 'true' : undefined}
              onChange={e => set('contactName', e.target.value)}
            />
            {errors.contactName && <div id="err-name" className={s.err} role="alert">{errors.contactName}</div>}
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="lead-mobile">Mobile / WhatsApp number<Req /></label>
            <div className={s.phoneRow}>
              <div className={s.ccWrap}>
                <span className={s.ccPlus} aria-hidden="true">+</span>
                <input
                  className={`${s.input} ${s.ccInput}`} inputMode="numeric" aria-label="Country code"
                  value={values.countryCode} maxLength={4} autoComplete="off"
                  onChange={e => set('countryCode', e.target.value.replace(/\D/g, ''))}
                />
              </div>
              <input
                id="lead-mobile" className={`${s.input}${errors.mobile ? ` ${s.invalid}` : ''}`}
                type="tel" inputMode="tel" autoComplete="off" placeholder="98765 43210"
                value={values.mobile} maxLength={24}
                aria-invalid={!!errors.mobile} aria-describedby={errors.mobile ? 'err-mobile' : 'hint-mobile'}
                data-invalid={errors.mobile ? 'true' : undefined}
                onChange={e => set('mobile', e.target.value)}
              />
            </div>
            {errors.mobile
              ? <div id="err-mobile" className={s.err} role="alert">{errors.mobile}</div>
              : <div id="hint-mobile" className={s.hint}>+91 is assumed. For another country change the code.</div>}
          </div>

          <div className={s.field} data-invalid={errors.clientType ? 'true' : undefined} tabIndex={-1}>
            <span className={s.label} id="lbl-type">Client type<Req /></span>
            <ChoiceGroup
              name="client-type" legend="Client type" options={CLIENT_TYPES} value={values.clientType}
              onChange={v => set('clientType', v as LeadFormValues['clientType'])}
              invalid={!!errors.clientType} describedBy={errors.clientType ? 'err-type' : undefined}
            />
            {errors.clientType && <div id="err-type" className={s.err} role="alert">{errors.clientType}</div>}
            {values.clientType === 'other' && (
              <div className={s.field} style={{ marginTop: 8 }}>
                <label className={s.label} htmlFor="lead-client-other">What kind of client?<Req /></label>
                <input
                  id="lead-client-other" className={`${s.input}${errors.clientTypeOther ? ` ${s.invalid}` : ''}`}
                  value={values.clientTypeOther} maxLength={MAX_OTHER + 20} autoComplete="off"
                  placeholder="Example: Furniture retailer"
                  aria-invalid={!!errors.clientTypeOther} aria-describedby={errors.clientTypeOther ? 'err-other' : undefined}
                  data-invalid={errors.clientTypeOther ? 'true' : undefined}
                  onChange={e => set('clientTypeOther', e.target.value)}
                />
                {errors.clientTypeOther && <div id="err-other" className={s.err} role="alert">{errors.clientTypeOther}</div>}
              </div>
            )}
          </div>

          <div className={s.field} data-invalid={errors.requirements ? 'true' : undefined} tabIndex={-1}>
            <span className={s.label} id="lbl-req">Requirement<Req /></span>
            <ChoiceGroup
              name="requirement" legend="Requirement" options={REQUIREMENTS} multiple value={values.requirements}
              onChange={v => set('requirements', toggleRequirement(values.requirements, v as never))}
              invalid={!!errors.requirements} describedBy={errors.requirements ? 'err-req' : undefined}
            />
            <div className={s.hint}>Choose all that apply.</div>
            {errors.requirements && <div id="err-req" className={s.err} role="alert">{errors.requirements}</div>}
          </div>

          <div className={s.field} data-invalid={errors.leadType ? 'true' : undefined} tabIndex={-1}>
            <span className={s.label} id="lbl-lead">Lead type<Req /></span>
            <ChoiceGroup
              name="lead-type" legend="Lead type" options={LEAD_TYPES} columns={1} value={values.leadType}
              onChange={v => set('leadType', v as LeadFormValues['leadType'])}
              invalid={!!errors.leadType} describedBy={errors.leadType ? 'err-lead' : undefined}
            />
            {errors.leadType && <div id="err-lead" className={s.err} role="alert">{errors.leadType}</div>}
          </div>

          <div className={s.field}>
            <label className={s.label} htmlFor="lead-note">Discussion note</label>
            <textarea
              id="lead-note" className={`${s.textarea}${errors.note ? ` ${s.invalid}` : ''}`}
              value={values.note} maxLength={MAX_NOTE + 100}
              placeholder="Example: Needs 40 café chairs; send catalogue."
              onChange={e => set('note', e.target.value)}
            />
            {errors.note && <div className={s.err} role="alert">{errors.note}</div>}
          </div>

          <details className={s.optional}>
            <summary>Advanced</summary>
            <div className={s.optionalBody}>
              <div className={s.field}>
                <label className={s.label} htmlFor="lead-company">Company / project name</label>
                <input id="lead-company" className={s.input} value={values.companyName} maxLength={MAX_COMPANY + 20} autoComplete="off" onChange={e => set('companyName', e.target.value)} />
              </div>
              <div className={s.field}>
                <label className={s.label} htmlFor="lead-city">Project city</label>
                <input id="lead-city" className={s.input} value={values.projectCity} maxLength={MAX_CITY + 20} autoComplete="off" onChange={e => set('projectCity', e.target.value)} />
              </div>
              <div className={s.field}>
                <span className={s.label}>Buying timeline</span>
                <ChoiceGroup
                  name="timeline" legend="Buying timeline" options={BUYING_TIMELINES} value={values.buyingTimeline}
                  onChange={v => set('buyingTimeline', values.buyingTimeline === v ? '' : (v as LeadFormValues['buyingTimeline']))}
                />
              </div>
            </div>
          </details>

          {duplicate?.mine === true && (
            <div className={`${s.notice} ${s.noticeWarn}`} role="alert">
              This contact is already in your leads for this exhibition. Nothing new was created.
              <div className={s.noticeActions}>
                <button type="button" className={s.btn} onClick={() => setOpenLeadId(duplicate.leadId)}>Open existing lead</button>
                {values.note.trim() && (
                  <button type="button" className={s.btn} disabled={saving} onClick={() => addNoteToExisting(duplicate.leadId)}>
                    Add my note to it
                  </button>
                )}
              </div>
            </div>
          )}
          {duplicate?.mine === false && (
            <div className={`${s.notice} ${s.noticeWarn}`} role="alert">
              This contact is already recorded for this exhibition. Contact Admin for reassignment.
            </div>
          )}
          {failure && (
            <div className={`${s.notice} ${s.noticeErr}`} role="alert">
              {failure.message}
              {failure.kind === 'auth' && (
                <div className={s.noticeActions}><a className={s.btn} href={loginHref}>Sign in again</a></div>
              )}
            </div>
          )}

          <div className={s.saveBar}>
            <button type="submit" className={s.saveBtn} disabled={saving || !exhibitionId} aria-busy={saving}>
              {saving ? 'Saving…' : 'Save & Add Next'}
            </button>
          </div>
        </form>
      </div>

      {openLeadId && (
        <LeadDetailSheet leadId={openLeadId} supabase={supabase} isAdmin={isAdmin} onClose={() => setOpenLeadId(null)} />
      )}
    </ExhibitionLeadsLayout>
  )
}

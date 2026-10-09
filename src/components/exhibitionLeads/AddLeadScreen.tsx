'use client'

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import { Check } from 'lucide-react'
import { ExhibitionLeadsLayout } from '@/components/layout/ExhibitionLeadsLayout'
import { useExhibitionLeads, useExhibitions } from '@/hooks/useExhibitionLeads'
import {
  BUYING_TIMELINES, CLIENT_TYPES, LEAD_TYPES, LEAD_TYPE_ACCENTS, REQUIREMENTS,
} from '@/lib/exhibitionLeads/constants'
import { EXHIBITION_LEADS_KEY, updateLead, LeadRequestError } from '@/lib/exhibitionLeads/api'
import { exhibitionDates, exhibitionLabel } from '@/lib/exhibitionLeads/format'
import {
  MAX_CITY, MAX_COMPANY, MAX_NAME, MAX_NOTE, MAX_OTHER,
  emptyLeadForm, missingRequired, toCreateArgs, toggleRequirement, validateLeadForm,
  type LeadFormErrors, type LeadFormValues,
} from '@/lib/exhibitionLeads/validation'
import { clearDraft, newSubmissionId, takeDraft } from '@/lib/exhibitionLeads/draft'
import { newEntry } from '@/lib/exhibitionLeads/outbox'
import { ChoiceGroup } from './ChoiceGroup'
import { NoExhibitionNotice } from './LeadBits'
import { useOutbox } from './OutboxProvider'
import { Problems, RecentList, StatusLine } from './EntryFeed'
// Only needed when a duplicate is found and the person opens the existing lead.
const LeadDetailSheet = dynamic(() => import('./LeadDetailSheet'), { ssr: false })
import s from './leads.module.css'
import a from './addLead.module.css'

const Req = () => <span className={s.req} aria-hidden="true">*</span>

export default function AddLeadScreen() {
  // The form needs neither the profile nor the session round trip to be shown:
  // the route layout has already proved a session exists. It renders at once and
  // the account details fill in beside it.
  const { supabase, profile, isAdmin, signOut } = useExhibitionLeads()
  // Only OPEN exhibitions take new leads; closed ones stay available in the lists.
  const { exhibitions, open: openExhibitions, defaultOpenExhibition, isLoading: exhibitionsLoading } = useExhibitions(supabase, true)
  const qc = useQueryClient()

  // A draft parked by the previous version of this screen (a session expiry) is
  // still picked up once, so nothing typed before an update is lost.
  const [parked] = useState(() => (typeof window === 'undefined' ? null : takeDraft()))
  const [chosenExhibition, setChosenExhibition] = useState<string | null>(parked?.exhibitionId ?? null)
  const exhibitionId = (openExhibitions.some(e => e.id === chosenExhibition) ? chosenExhibition : null) ?? defaultOpenExhibition?.id ?? null
  const exhibition = openExhibitions.find(e => e.id === exhibitionId) ?? null

  const [values, setValues] = useState<LeadFormValues>(() => parked?.values ?? emptyLeadForm())
  const [showErrors, setShowErrors] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)
  const restored = parked !== null

  const topRef = useRef<HTMLDivElement>(null)
  const mobileRef = useRef<HTMLInputElement>(null)

  const errors: LeadFormErrors = showErrors ? validateLeadForm(values) : {}
  const set = <K extends keyof LeadFormValues>(key: K, v: LeadFormValues[K]) => setValues(prev => ({ ...prev, [key]: v }))

  // The outbox lives above every page (OutboxProvider): sending carries on after the person leaves this screen.
  const { entries, justSaved, enqueue, remove, retry, flash, patch } = useOutbox()

  // ── Saving ─────────────────────────────────────────────────────────────
  function readyForNext() {
    setValues(emptyLeadForm())
    setShowErrors(false)
    setFormKey(k => k + 1)
    // The form is rebuilt (its key changed), and its name field takes the focus by itself.
    topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  function submit(ev?: React.FormEvent) {
    ev?.preventDefault()
    if (!exhibitionId) return
    setShowErrors(true)
    const problems = validateLeadForm(values)
    if (Object.keys(problems).length) {
      const first = document.querySelector<HTMLElement>('[data-invalid="true"]')
      first?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      first?.focus?.()
      return
    }
    // The entry is handed to the outbox and the form is free again at once.
    // The id is minted here, once, and every retry of this entry reuses it.
    clearDraft()
    enqueue(newEntry({ id: newSubmissionId(), exhibitionId, values, args: toCreateArgs(values) }))
    readyForNext()
  }

  function editEntry(id: string) {
    const e = entries.find(x => x.id === id)
    if (!e) return
    const typing = JSON.stringify(values) !== JSON.stringify(emptyLeadForm())
    if (typing && !window.confirm('Replace what you are typing now with this entry?')) return
    setValues(e.values)
    setChosenExhibition(e.exhibitionId)
    remove(id)
    setShowErrors(false)
    setFormKey(k => k + 1)
    topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  async function addNoteToExisting(id: string) {
    const e = entries.find(x => x.id === id)
    if (!e?.leadId) return
    try {
      await updateLead(supabase, e.leadId, {}, e.values.note.trim() || null)
      remove(id)
      flash(`${e.name} — follow-up note added to the existing lead`)
      qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
    } catch (err) {
      const le = err as LeadRequestError
      patch(id, x => ({ ...x, message: le.message }))
    }
  }

  const required = missingRequired(values)
  const loginHref = `/login?redirect=${encodeURIComponent('/exhibition-leads/add')}`

  return (
    <ExhibitionLeadsLayout
      profile={profile} isAdmin={isAdmin} onSignOut={signOut}
      title="Add Exhibition Lead"
      subtitle={exhibition ? `${exhibition.name} · ${exhibitionDates(exhibition)}` : undefined}
    >
      <div className={a.page} ref={topRef}>
        {openExhibitions.length > 1 && (
          <div className={a.head}>
            <label htmlFor="lead-exhibition">Exhibition</label>
            <select
              id="lead-exhibition" className={`${s.select} ${s.exhibitionSelect}`} style={{ width: 'auto' }}
              value={exhibitionId ?? ''} onChange={e => setChosenExhibition(e.target.value)}
            >
              {openExhibitions.map(x => <option key={x.id} value={x.id}>{exhibitionLabel(x)}</option>)}
            </select>
          </div>
        )}

        <div className={a.main}>
          {!exhibitionId && !exhibitionsLoading && <NoExhibitionNotice isAdmin={isAdmin} closedOnly={exhibitions.length > 0} />}

          <StatusLine entries={entries} justSaved={justSaved} />
          <Problems
            entries={entries} busy={false} loginHref={loginHref}
            onRetry={retry}
            onEdit={editEntry}
            onDiscard={remove}
            onOpenLead={setOpenLeadId}
            onAddNote={addNoteToExisting}
          />
          {restored && entries.length === 0 && (
            <div className={`${s.notice} ${s.noticeWarn}`} role="status">
              Your session ended while saving. What you entered has been restored — check it and save again.
            </div>
          )}

          <form
            key={formKey} className={a.card} onSubmit={submit} noValidate
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit() }}
          >
            <div className={a.pair}>
              <div className={s.field}>
                <label className={s.label} htmlFor="lead-name">Contact name<Req /></label>
                <input
                  id="lead-name" className={`${s.input}${errors.contactName ? ` ${s.invalid}` : ''}`}
                  value={values.contactName} maxLength={MAX_NAME + 20} autoComplete="off" autoCapitalize="words"
                  enterKeyHint="next" autoFocus
                  aria-invalid={!!errors.contactName} aria-describedby={errors.contactName ? 'err-name' : undefined}
                  data-invalid={errors.contactName ? 'true' : undefined}
                  onChange={e => set('contactName', e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); mobileRef.current?.focus() } }}
                />
                {errors.contactName && <div id="err-name" className={s.err} role="alert">{errors.contactName}</div>}
              </div>

              <div className={s.field}>
                <label className={s.label} htmlFor="lead-mobile">Mobile / WhatsApp<Req /></label>
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
                    id="lead-mobile" ref={mobileRef} className={`${s.input}${errors.mobile ? ` ${s.invalid}` : ''}`}
                    type="tel" inputMode="tel" autoComplete="off" placeholder="98765 43210" enterKeyHint="done"
                    value={values.mobile} maxLength={24}
                    aria-invalid={!!errors.mobile} aria-describedby={errors.mobile ? 'err-mobile' : 'hint-mobile'}
                    data-invalid={errors.mobile ? 'true' : undefined}
                    onChange={e => set('mobile', e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                  />
                </div>
                {errors.mobile
                  ? <div id="err-mobile" className={s.err} role="alert">{errors.mobile}</div>
                  : <div id="hint-mobile" className={s.hint}>+91 is assumed. For another country change the code.</div>}
              </div>
            </div>

            <div className={`${s.field} ${a.tiles4}`} data-invalid={errors.clientType ? 'true' : undefined} tabIndex={-1}>
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
                    value={values.clientTypeOther} maxLength={MAX_OTHER + 20} autoComplete="off" autoFocus
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
              <div className={a.fieldHead}>
                <span className={s.label} id="lbl-req">Requirement<Req /></span>
                <span className={a.optionalTag}>Choose all that apply</span>
              </div>
              <ChoiceGroup
                name="requirement" legend="Requirement" options={REQUIREMENTS} multiple value={values.requirements}
                onChange={v => set('requirements', toggleRequirement(values.requirements, v as never))}
                invalid={!!errors.requirements} describedBy={errors.requirements ? 'err-req' : undefined}
              />
              {errors.requirements && <div id="err-req" className={s.err} role="alert">{errors.requirements}</div>}
            </div>

            <div className={`${s.field} ${a.leadTiles}`} data-invalid={errors.leadType ? 'true' : undefined} tabIndex={-1}>
              <span className={s.label} id="lbl-lead">Lead type<Req /></span>
              <ChoiceGroup
                name="lead-type" legend="Lead type" options={LEAD_TYPES} columns={1} accents={LEAD_TYPE_ACCENTS} value={values.leadType}
                onChange={v => set('leadType', v as LeadFormValues['leadType'])}
                invalid={!!errors.leadType} describedBy={errors.leadType ? 'err-lead' : undefined}
              />
              {errors.leadType && <div id="err-lead" className={s.err} role="alert">{errors.leadType}</div>}
            </div>

            <div className={s.field}>
              <div className={a.fieldHead}>
                <label className={s.label} htmlFor="lead-note">Discussion note</label>
                <span className={a.optionalTag}>Optional</span>
              </div>
              <textarea
                id="lead-note" className={`${s.textarea} ${a.noteBox}${errors.note ? ` ${s.invalid}` : ''}`}
                value={values.note} maxLength={MAX_NOTE + 100} rows={2}
                placeholder="Example: Needs 40 café chairs; send catalogue."
                onChange={e => set('note', e.target.value)}
              />
              {errors.note && <div className={s.err} role="alert">{errors.note}</div>}
            </div>

            <details className={s.optional}>
              <summary>More details <span className={a.optionalTag} style={{ marginLeft: 8, fontWeight: 400 }}>Company, city, timeline</span></summary>
              <div className={s.optionalBody}>
                <div className={s.field}>
                  <label className={s.label} htmlFor="lead-company">Company / project name</label>
                  <input id="lead-company" className={s.input} value={values.companyName} maxLength={MAX_COMPANY + 20} autoComplete="off" onChange={e => set('companyName', e.target.value)} />
                </div>
                <div className={s.field}>
                  <label className={s.label} htmlFor="lead-city">City</label>
                  <input
                    id="lead-city" className={s.input} value={values.projectCity} maxLength={MAX_CITY + 20}
                    autoComplete="off" autoCapitalize="words" enterKeyHint="next" placeholder="Type the city"
                    onChange={e => set('projectCity', e.target.value)}
                  />
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

            <div className={a.saveBar}>
              <div className={a.todo} aria-live="polite">
                {required.length === 0
                  ? <span className={a.todoDone}><Check size={15} strokeWidth={2.6} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Ready to save</span>
                  : <span>Still needed: <strong>{required.join(' · ')}</strong></span>}
              </div>
              <button type="submit" className={a.saveBtn} disabled={!exhibitionId}>
                Save &amp; Add Next
                <span className={a.kbd} aria-hidden="true">Ctrl ↵</span>
              </button>
            </div>
          </form>
        </div>

        <RecentList entries={entries} />
      </div>

      {openLeadId && (
        <LeadDetailSheet leadId={openLeadId} supabase={supabase} isAdmin={isAdmin} onClose={() => setOpenLeadId(null)} />
      )}
    </ExhibitionLeadsLayout>
  )
}

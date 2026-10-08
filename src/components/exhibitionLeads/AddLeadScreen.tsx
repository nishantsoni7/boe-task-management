'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import { Check } from 'lucide-react'
import { ExhibitionLeadsLayout } from '@/components/layout/ExhibitionLeadsLayout'
import { useExhibitionLeads, useExhibitions } from '@/hooks/useExhibitionLeads'
import {
  BUYING_TIMELINES, CLIENT_TYPES, LEAD_TYPES, LEAD_TYPE_ACCENTS, REQUIREMENTS,
} from '@/lib/exhibitionLeads/constants'
import { EXHIBITION_LEADS_KEY, createLead, updateLead, LeadRequestError } from '@/lib/exhibitionLeads/api'
import { standingsKey, standingsQuery } from '@/lib/exhibitionLeads/queries'
import { exhibitionDates, exhibitionLabel } from '@/lib/exhibitionLeads/format'
import {
  MAX_CITY, MAX_COMPANY, MAX_NAME, MAX_NOTE, MAX_OTHER,
  emptyLeadForm, missingRequired, toCreateArgs, toggleRequirement, validateLeadForm,
  type LeadFormErrors, type LeadFormValues,
} from '@/lib/exhibitionLeads/validation'
import { clearDraft, newSubmissionId, takeDraft } from '@/lib/exhibitionLeads/draft'
import {
  afterAnswer, afterError, isUnsent, loadOutbox, newEntry, nextToSend, resend, retryDelayMs,
  storeOutbox, type OutboxEntry,
} from '@/lib/exhibitionLeads/outbox'
import { exhibitionDay, withMyDelta, type Standings } from '@/lib/exhibitionLeads/standings'
import { istToday } from '@/lib/istDate'
import { ChoiceGroup } from './ChoiceGroup'
import { NoExhibitionNotice } from './LeadBits'
import { Leaderboard, StatTiles } from './StandingsPanel'
import { Problems, RecentList, StatusLine } from './EntryFeed'
// Only needed when a duplicate is found and the person opens the existing lead.
const LeadDetailSheet = dynamic(() => import('./LeadDetailSheet'), { ssr: false })
import s from './leads.module.css'
import a from './addLead.module.css'

const Req = () => <span className={s.req} aria-hidden="true">*</span>

// How long the green "Saved" confirmation stays.
const SAVED_FLASH_MS = 5000

export default function AddLeadScreen() {
  // The form needs neither the profile nor the session round trip to be shown:
  // the route layout has already proved a session exists. It renders at once and
  // the account details fill in beside it.
  const { supabase, profile, isAdmin, signOut } = useExhibitionLeads()
  const userId = profile?.id ?? null
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
  const [boardOpen, setBoardOpen] = useState(false)
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState<string | null>(null)
  const restored = parked !== null

  const topRef = useRef<HTMLDivElement>(null)
  const mobileRef = useRef<HTMLInputElement>(null)

  const errors: LeadFormErrors = showErrors ? validateLeadForm(values) : {}
  const set = <K extends keyof LeadFormValues>(key: K, v: LeadFormValues[K]) => setValues(prev => ({ ...prev, [key]: v }))

  // ── The scoreboard ─────────────────────────────────────────────────────
  // (If the leaderboard door is missing, the person's own numbers still show: see loadStandings.)
  const standingsQ = useQuery({
    ...standingsQuery(supabase, exhibitionId as string),
    enabled: !!exhibitionId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })

  // ── The outbox: entries made on this screen, and what became of them ───
  const [entries, setEntries] = useState<OutboxEntry[]>([])
  const inFlight = useRef<string | null>(null)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const dirty = useRef(false)
  // Whose saved entries have been read back from storage (nothing is written before that).
  const [outboxUser, setOutboxUser] = useState<string | null>(null)

  const patch = useCallback((id: string, fn: (e: OutboxEntry) => OutboxEntry) => {
    setEntries(list => list.map(e => (e.id === id ? fn(e) : e)))
  }, [])

  // Entries owed from an earlier visit (a closed tab, a dropped connection) come back and are sent.
  // (Read after a microtask: the storage is an external system, and the state
  // is set in a callback of that read, not while the effect body runs.)
  useEffect(() => {
    if (!userId) return
    let live = true
    void Promise.resolve().then(() => {
      if (!live) return
      const owed = loadOutbox(userId)
      if (owed.length) setEntries(list => [...owed.filter(o => !list.some(e => e.id === o.id)), ...list])
      setOutboxUser(userId)
    })
    return () => { live = false }
  }, [userId])

  // …and what is still owed is kept, so it survives a reload.
  useEffect(() => {
    if (userId && outboxUser === userId) storeOutbox(userId, entries)
  }, [userId, outboxUser, entries])

  // Send the oldest waiting entry; one at a time keeps the order and spares a weak connection.
  useEffect(() => {
    if (inFlight.current) return
    const next = nextToSend(entries)
    if (!next) return
    inFlight.current = next.id
    ;(async () => {
      try {
        const res = await createLead(supabase, { submissionId: next.id, exhibitionId: next.exhibitionId, ...next.args })
        patch(next.id, e => afterAnswer(e, res))
        if (res.outcome === 'created' || res.outcome === 'replayed') {
          dirty.current = true
          if (res.outcome === 'created') {
            qc.setQueryData<Standings | undefined>(standingsKey(next.exhibitionId), d => withMyDelta(d, 1))
          }
          setJustSaved(next.name)
        }
      } catch (e) {
        const err = e as LeadRequestError
        patch(next.id, x => afterError(x, { kind: err.kind ?? 'unknown', message: err.message }))
      } finally {
        inFlight.current = null
      }
    })()
  }, [entries, supabase, qc, patch])

  // A failed send tries again by itself, a little later each time.
  useEffect(() => {
    for (const e of entries) {
      if (e.status === 'retry' && !timers.current.has(e.id)) {
        timers.current.set(e.id, setTimeout(() => {
          timers.current.delete(e.id)
          patch(e.id, resend)
        }, retryDelayMs(e.attempts)))
      }
    }
  }, [entries, patch])
  useEffect(() => {
    const t = timers.current
    return () => { t.forEach(clearTimeout); t.clear() }
  }, [])

  // The connection came back: do not wait for the timer.
  useEffect(() => {
    const again = () => setEntries(list => list.map(e => (e.status === 'retry' ? resend(e) : e)))
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])

  // Once everything has been answered, bring the numbers and the lists in line with the database.
  const waiting = entries.some(isUnsent)
  useEffect(() => {
    if (!waiting && dirty.current) {
      dirty.current = false
      qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
    }
  }, [waiting, qc])

  // Closing the tab while something is still on its way: ask first.
  useEffect(() => {
    if (!entries.some(e => e.status === 'saving' || e.status === 'retry')) return
    const warn = (ev: BeforeUnloadEvent) => { ev.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [entries])

  // The green confirmation fades by itself.
  useEffect(() => {
    if (!justSaved) return
    const t = setTimeout(() => setJustSaved(null), SAVED_FLASH_MS)
    return () => clearTimeout(t)
  }, [justSaved])

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
    setJustSaved(null)
    setEntries(list => [...list, newEntry({ id: newSubmissionId(), exhibitionId, values, args: toCreateArgs(values) })])
    readyForNext()
  }

  function editEntry(id: string) {
    const e = entries.find(x => x.id === id)
    if (!e) return
    const typing = JSON.stringify(values) !== JSON.stringify(emptyLeadForm())
    if (typing && !window.confirm('Replace what you are typing now with this entry?')) return
    setValues(e.values)
    setChosenExhibition(e.exhibitionId)
    setEntries(list => list.filter(x => x.id !== id))
    setShowErrors(false)
    setFormKey(k => k + 1)
    topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  async function addNoteToExisting(id: string) {
    const e = entries.find(x => x.id === id)
    if (!e?.leadId) return
    try {
      await updateLead(supabase, e.leadId, {}, e.values.note.trim() || null)
      setEntries(list => list.filter(x => x.id !== id))
      setJustSaved(`${e.name} — follow-up note added to the existing lead`)
      qc.invalidateQueries({ queryKey: EXHIBITION_LEADS_KEY })
    } catch (err) {
      const le = err as LeadRequestError
      patch(id, x => ({ ...x, message: le.message }))
    }
  }

  // ── What the scoreboard shows: the database, plus what is still on its way ──
  const pending = entries.filter(e => isUnsent(e) && e.exhibitionId === exhibitionId).length
  const standings = useMemo(() => withMyDelta(standingsQ.data, pending), [standingsQ.data, pending])

  const required = missingRequired(values)
  const loginHref = `/login?redirect=${encodeURIComponent('/exhibition-leads/add')}`
  const today = istToday()
  const day = exhibition ? exhibitionDay(exhibition, today) : null
  const exParam = exhibitionId ? `ex=${exhibitionId}&` : ''

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

        {exhibitionId && (
          <StatTiles
            data={standings}
            loading={standingsQ.isLoading}
            day={day ? `Day ${day.day} of ${day.of}` : null}
            myLeadsHref="/exhibition-leads/my"
            totalHref={`/exhibition-leads/my?${exParam}when=all`}
            boardOpen={boardOpen}
            onToggleBoard={() => setBoardOpen(v => !v)}
          />
        )}

        {/* On a phone the two pieces flow between the tiles, the form and the end of the page; from 1280px they stack beside the form. */}
        <div className={a.aside}>
          <Leaderboard data={standings} open={boardOpen} onToggle={() => setBoardOpen(v => !v)} />
          <RecentList entries={entries} />
        </div>

        <div className={a.main}>
          {!exhibitionId && !exhibitionsLoading && <NoExhibitionNotice isAdmin={isAdmin} closedOnly={exhibitions.length > 0} />}

          <StatusLine entries={entries} justSaved={justSaved} />
          <Problems
            entries={entries} busy={false} loginHref={loginHref}
            onRetry={id => patch(id, resend)}
            onEdit={editEntry}
            onDiscard={id => setEntries(list => list.filter(x => x.id !== id))}
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
      </div>

      {openLeadId && (
        <LeadDetailSheet leadId={openLeadId} supabase={supabase} isAdmin={isAdmin} onClose={() => setOpenLeadId(null)} />
      )}
    </ExhibitionLeadsLayout>
  )
}

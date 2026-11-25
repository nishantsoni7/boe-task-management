'use client'

// The lead's quotations in the popup (owner approved 2026-11-19, after the Lead card on the quotation): ONE slim line between the update
// box and the activity: the newest quotation (number, version, status, value), "+N more" to open the rest, and "Make quotation", which
// starts one from the lead. Read from quotation_for_lead (20270812000000); nothing shows to somebody with no Quotations access, and a lead
// with no quotation and nobody who may make one shows nothing at all. It is one line because the popup is short on a laptop: the first
// build listed three rows and left the activity 29 px (measured with the real popup and stylesheet). The left side of the popup is
// measured to fit without scrolling, so this lives on the right, where the activity scrolls.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { FileCheck2, FileText, Plus } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { errorText, fetchLeadQuotations, fetchQuotation, leadQuotationsKey, setStatus, startQuotation, STATUS_LABEL, type LeadQuotation, type LeadQuotations } from '@/lib/quotations/api'
import { draftDetailHref } from '@/lib/orders/draftsView'
import { valueLabel } from '@/lib/salesLeads/board'
import type { WorkLead } from '@/lib/salesLeads/api'
import type { LeadWork } from './useLeadWork'
import s from './leadBoard.module.css'

export function LeadQuotes({ lead, work, canMake, filling }: { lead: WorkLead; work: LeadWork; canMake: boolean; filling: boolean }) {
  // Read at once, beside the record (the lead's id is known from the card), instead of after it: that was a second 0.25 s on every
  // popup (2026-11-23). Nothing is drawn until the record has arrived, as before.
  const q = useQuery({
    queryKey: leadQuotationsKey(lead.id), queryFn: () => fetchLeadQuotations(work.supabase, lead.id),
    retry: false, staleTime: 60_000,
  })
  const d = q.data
  // Not set up yet, no Quotations access, or nothing to show and nothing to offer: no band.
  if (filling || !d || !d.open) return null
  const mayMake = canMake && d.may_create
  if (d.quotations.length === 0 && !mayMake) return null
  return <Band lead={lead} work={work} data={d} mayMake={mayMake} />
}

/** "QT-MS-01001" (a link), "v2 · Sent", "₹ 4.5 L". */
function Item({ x }: { x: LeadQuotation }) {
  return (
    <>
      <Link href={`/quotations/${x.id}`} className={s.qNo}>{x.quote_no}</Link>
      <span className={s.qMeta}>{x.version_no ? `v${x.version_no} · ` : ''}{STATUS_LABEL[x.status] ?? x.status}</span>
      <span className={s.qVal}>{valueLabel(Math.round(x.value) * 100)}</span>
    </>
  )
}

/**
 * Create PI draft (owner, 25 Nov 2026: the PI is made from Lead Management, not from the quotation page). The same steps the quotation
 * page's Confirm → PI draft took: read the SAVED quotation, check what Orders needs, move a Draft to Negotiating (the database confirms only
 * a Sent or Negotiating one), make the PI draft and open it. A quotation that already has its PI opens it instead. The PI workbook code is
 * loaded on the click, so the lead board does not carry it.
 */
function PiAction({ x, leadId, work, onErr }: { x: LeadQuotation; leadId: string; work: LeadWork; onErr: (text: string) => void }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [stage, setStage] = useState<string | null>(null)
  const make = x.status === 'draft' || x.status === 'sent' || x.status === 'negotiating'
  if (!make && x.status !== 'confirmed') return null

  async function go() {
    setStage(make ? 'Checking…' : 'Opening…'); onErr('')
    try {
      const q = await fetchQuotation(work.supabase, x.id)
      if (q.pi) { router.push(draftDetailHref(q.pi.id)); return }
      if (!make) { onErr(`${x.quote_no} was confirmed without a PI.`); return }
      if (!q.may_edit) { onErr(`Only the owner of ${x.quote_no}, or someone with Edit and See all, can make its PI draft.`); return }
      const { conversionProblems, waitsFor } = await import('@/lib/quotations/piWorkbook')
      const problems = conversionProblems(q.areas, q.lines)
      if (problems.length) { onErr(`${x.quote_no}: ${waitsFor(problems)} Open the quotation to fix it.`); return }
      const { makePiDraft, PI_STAGE_LABEL, extrasLeftOutText } = await import('@/lib/quotations/toPiDraft')
      if (q.status === 'draft') await setStatus(work.supabase, q.id, 'negotiating')
      const r = await makePiDraft(work.supabase, q, st => setStage(PI_STAGE_LABEL[st]))
      void qc.invalidateQueries({ queryKey: leadQuotationsKey(leadId) })
      if (r.linkError) { onErr(`The PI draft was made (Orders → PI Drafts), but ${x.quote_no} could not be linked to it: ${r.linkError}`); return }
      if (r.extrasLeftOut) { onErr(`The PI draft was made (Orders → PI Drafts). ${extrasLeftOutText(r.extrasLeftOut)}`); return }
      router.push(draftDetailHref(r.submissionId))
    } catch (e) {
      onErr(errorText(e))
      void qc.invalidateQueries({ queryKey: leadQuotationsKey(leadId) }) // a draft may already be Negotiating
    } finally { setStage(null) }
  }

  return (
    <button type="button" className={s.qPi} disabled={stage !== null} onClick={() => void go()}
      title={make ? 'Makes a PI draft in Orders from the saved quotation. Nothing is sent to anyone: the PI stays a Draft until you submit it there.' : undefined}>
      <FileCheck2 aria-hidden="true" />{stage ?? (make ? 'Create PI draft' : 'Open the PI draft')}
    </button>
  )
}

// Its own component so that only a lead that really shows the band needs the router.
function Band({ lead, work, data, mayMake }: { lead: WorkLead; work: LeadWork; data: LeadQuotations; mayMake: boolean }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [first, ...rest] = data.quotations

  async function make() {
    setBusy(true); setErr('')
    try {
      // The database copies the lead's name, phone, city, venue and requirement into the quotation and links it in one step (20270814000000).
      const id = await startQuotation(work.supabase, lead.id)
      void qc.invalidateQueries({ queryKey: leadQuotationsKey(lead.id) })
      router.push(`/quotations/${id}`)
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }

  return (
    <section className={s.qBand} aria-label="Quotations">
      <div className={s.qHead}>
        <FileText aria-hidden="true" />
        <span className={s.eyebrow}>Quotations</span>
        {first ? <Item x={first} /> : <span className={s.qNone}>none yet</span>}
        {rest.length > 0 && (
          <button type="button" className={s.qMore} aria-expanded={more} onClick={() => setMore(v => !v)}>{more ? 'Show less' : `+${rest.length} more`}</button>
        )}
        {(first || mayMake) && (
          <span className={s.qActs}>
            {first && <PiAction x={first} leadId={lead.id} work={work} onErr={setErr} />}
            {mayMake && (
              <button type="button" className={s.qMake} disabled={busy} onClick={() => void make()}>
                <Plus aria-hidden="true" />{busy ? 'Making…' : 'Make quotation'}
              </button>
            )}
          </span>
        )}
      </div>
      {err && <p className={s.qErr} role="alert">{err}</p>}
      {more && (
        <ul className={s.qList}>
          {rest.map(x => (
            <li key={x.id} className={s.qRow}>
              <Item x={x} />
              {x.owner_name && <span className={s.qBy}>{x.owner_name}</span>}
              <PiAction x={x} leadId={lead.id} work={work} onErr={setErr} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

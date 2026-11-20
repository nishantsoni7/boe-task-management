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
import { FileText, Plus } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import { errorText, fetchLeadQuotations, leadQuotationsKey, startQuotation, STATUS_LABEL, type LeadQuotation, type LeadQuotations } from '@/lib/quotations/api'
import { valueLabel } from '@/lib/salesLeads/board'
import type { WorkLead } from '@/lib/salesLeads/api'
import type { LeadWork } from './useLeadWork'
import s from './leadBoard.module.css'

export function LeadQuotes({ lead, work, canMake, filling }: { lead: WorkLead; work: LeadWork; canMake: boolean; filling: boolean }) {
  const q = useQuery({
    queryKey: leadQuotationsKey(lead.id), queryFn: () => fetchLeadQuotations(work.supabase, lead.id),
    enabled: !filling, retry: false, staleTime: 60_000,
  })
  const d = q.data
  // Not set up yet, no Quotations access, or nothing to show and nothing to offer: no band.
  if (!d || !d.open) return null
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
        {mayMake && (
          <button type="button" className={s.qMake} disabled={busy} onClick={() => void make()}>
            <Plus aria-hidden="true" />{busy ? 'Making…' : 'Make quotation'}
          </button>
        )}
      </div>
      {err && <p className={s.qErr} role="alert">{err}</p>}
      {more && (
        <ul className={s.qList}>
          {rest.map(x => (
            <li key={x.id} className={s.qRow}>
              <Item x={x} />
              {x.owner_name && <span className={s.qBy}>{x.owner_name}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

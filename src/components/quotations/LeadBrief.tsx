'use client'

// The lead's brief, opened from the quotation's Lead row (owner, 25 Nov 2026: "On clicking on the lead, we should be able to get brief about the
// client in a popup with an option to view the page in detail by navigating to the lead management page"). Read only: the lead is changed in Lead
// Management. Read with the Lead Board's own call (get_sales_lead), so the lead's own permission rules decide who sees what.

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, X } from 'lucide-react'
import { AppLink as Link } from '@/components/ui/AppLink'
import type { createClient } from '@/lib/supabase/client'
import { istDateOf } from '@/lib/istDate'
import { fetchWorkLead } from '@/lib/salesLeads/api'
import { CLIENT_TYPES, PATH_STAGES, STAGES, TEMPERATURES, deadReasonLabel, stageLabel, valueLabel, type Stage } from '@/lib/salesLeads/board'
import { sourceLabel } from '@/lib/salesLeads/constants'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** The chip's colour: green once converted, grey when dead, amber while parked; the stages of a sale are blue. */
export const stageTone = (stage: string) => (stage === 'converted' ? s.stageDone : stage === 'dead' ? s.stageDead : stage === 'follow_up_later' ? s.stageLater : '')

/** The lead's stage as a chip, and the five-step meter while the lead is on the path of a sale. */
export function StageChip({ stage, deadReason }: { stage: string; deadReason?: string | null }) {
  const at = PATH_STAGES.indexOf(stage as Stage)
  return (
    <>
      <span className={`${s.stage} ${stageTone(stage)}`}>{stageLabel(stage)}{stage === 'dead' && deadReason ? ` · ${deadReasonLabel(deadReason)}` : ''}</span>
      {at >= 0 && (
        <span className={s.meter} role="img" aria-label={`Stage ${at + 1} of ${PATH_STAGES.length}`}
          title={`Stage ${at + 1} of ${PATH_STAGES.length}: ${PATH_STAGES.map(k => STAGES.find(x => x.key === k)?.label ?? k).join(', ')}`}>
          {PATH_STAGES.map((k, i) => <i key={k} className={i <= at ? s.meterOn : undefined} />)}
        </span>
      )}
    </>
  )
}

export const leadBriefKey = (id: string) => ['sales-leads', 'brief', id] as const

export function LeadBrief({ supabase, leadId, leadNo, name, onClose }: { supabase: Supabase; leadId: string; leadNo: number; name: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: leadBriefKey(leadId), queryFn: () => fetchWorkLead(supabase, leadId), retry: false, staleTime: 60_000 })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const l = q.data?.lead
  const last = q.data?.activities?.find(a => a.note?.trim())
  const href = `/sales/board?lead=${leadId}`

  return createPortal(
    <div className={s.scrim} onClick={onClose}>
      <div className={`${s.modal} ${s.brief}`} role="dialog" aria-modal="true" aria-labelledby="lead-brief-title" onClick={e => e.stopPropagation()}>
        <div className={s.cardHead}>
          <div className={s.briefTitle}>
            <span className={`${s.small} ${s.muted}`}>Lead #{leadNo}</span>
            <h2 id="lead-brief-title">{name?.trim() || 'No name yet'}</h2>
            {l?.location && <span className={`${s.small} ${s.muted}`}>{l.location}</span>}
          </div>
          <button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close" autoFocus><X size={16} aria-hidden /></button>
        </div>
        <div className={`${s.cardBody} ${s.briefBody}`}>
          {q.isLoading ? <p className={s.muted}>Reading the lead…</p>
            : !l ? <p className={s.muted}>This lead could not be read here. Open it in Lead Management.</p>
            : (
              <>
                <div className={s.row}>
                  <StageChip stage={l.stage} deadReason={l.dead_reason} />
                  {l.temperature && <span className={s.briefTemp}>{TEMPERATURES.find(t => t.value === l.temperature)?.label ?? l.temperature}</span>}
                </div>
                <dl className={s.briefDl}>
                  <dt>Phone</dt><dd>{l.phone}</dd>
                  {l.email && <><dt>Email</dt><dd><a href={`mailto:${l.email}`}>{l.email}</a></dd></>}
                  {l.client_type && <><dt>Client type</dt><dd>{CLIENT_TYPES.find(c => c.value === l.client_type)?.label ?? l.client_type}</dd></>}
                  <dt>Held by</dt><dd>{l.holder_name ?? 'nobody yet'}</dd>
                  {l.next_due_on && <><dt>Follow-up</dt><dd>{day(l.next_due_on)}</dd></>}
                  <dt>Came from</dt><dd>{sourceLabel(l.source)}, {day(l.received_on)}</dd>
                  {l.quantity && <><dt>Quantity</dt><dd>{l.quantity}</dd></>}
                  {l.expected_value_paise ? <><dt>Expected value</dt><dd>{valueLabel(l.expected_value_paise)}</dd></> : null}
                </dl>
                {l.requirement?.trim() && <div className={s.briefBox}><span className={s.briefK}>Requirement</span><p>{l.requirement}</p></div>}
                {last && <div className={s.briefBox}><span className={s.briefK}>Last update · {day(istDateOf(last.at))}{last.actor_name ? ` · ${last.actor_name}` : ''}</span><p>{last.note}</p></div>}
              </>
            )}
        </div>
        <div className={s.briefFoot}>
          <button type="button" className={s.btn} onClick={onClose}>Close</button>
          <Link href={href} className={`${s.btn} ${s.btnPrimary}`}>Open in Lead Management <ExternalLink size={14} aria-hidden /></Link>
        </div>
      </div>
    </div>,
    document.body,
  )
}

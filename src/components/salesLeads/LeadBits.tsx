'use client'

import { Bell, CalendarDays, Clock, Crown, Flame, Hourglass, Mail, MessageCircle, Phone, Snowflake, Sun, TriangleAlert } from 'lucide-react'
import { formatPhone } from '@/lib/exhibitionLeads/phone'
import type { LeadEvent, WorkLead } from '@/lib/salesLeads/api'
import { bigQuantity, cameBack, dueOf, flagOf, marketLabel, stageLabel, type Temperature, TEMPERATURES, valueLabel } from '@/lib/salesLeads/board'
import { editedFields } from '@/lib/salesLeads/format'
import s from './leadBoard.module.css'

// The small pieces of a lead that look the same on My day, the board and the lead panel.

export const leadTitle = (l: { name?: string | null; phone: string }) => l.name || formatPhone(l.phone)

const TEMP_STYLE: Record<Temperature, { cls: string; Icon: typeof Flame }> = {
  hot: { cls: s.chipHot, Icon: Flame },
  warm: { cls: s.chipWarm, Icon: Sun },
  cold: { cls: s.chipCold, Icon: Snowflake },
}

export function TempChip({ value }: { value: Temperature }) {
  const { cls, Icon } = TEMP_STYLE[value]
  return <span className={`${s.chip} ${cls}`}><Icon aria-hidden="true" />{TEMPERATURES.find(t => t.value === value)?.label}</span>
}

export function ValueChip({ paise }: { paise: number | null }) {
  return paise ? <span className={s.chip}>{valueLabel(paise)}</span> : null
}

/** Premium, with what made it so ("250 seats"): the client's own words, read by the database. */
export function PremiumChip({ reason }: { reason: string | null | undefined }) {
  return reason ? <span className={`${s.chip} ${s.chipPremium}`} title={`Premium: ${reason}`}><Crown aria-hidden="true" />Premium · {reason}</span> : null
}

export function LeadChips({ lead }: { lead: WorkLead }) {
  return (
    <div className={s.chips}>
      <PremiumChip reason={lead.premium} />
      <TempChip value={lead.temperature} />
      <ValueChip paise={lead.expected_value_paise} />
      {!lead.premium && bigQuantity(lead) && <span className={s.chip}>Big quantity</span>}
      {lead.market === 'export' && <span className={`${s.chip} ${s.chipExport}`}>{marketLabel(lead)}</span>}
      {cameBack(lead) && <span className={`${s.chip} ${s.chipAgain}`}><Bell aria-hidden="true" />Enquired again</span>}
    </div>
  )
}

const who = (name: string | null) => <b>{name ?? 'a former colleague'}</b>

/** One line of a lead's history, the same in the Lead Master and in the lead panel. */
export function eventLine(e: LeadEvent): React.ReactNode {
  switch (e.kind) {
    case 'added': return e.detail ? <>Came in from the <b>{e.detail}</b></> : 'Added in Lead Master'
    case 'allotted': return <>Allotted to {who(e.to_name)}{e.detail && <> automatically: {e.detail}</>}</>
    case 'reassigned': return <>Moved from {who(e.from_name)} to {who(e.to_name)}{e.detail && <> automatically: {e.detail}</>}</>
    case 'edited': return `Changed ${editedFields(e.detail)}`
    case 'enquired_again': return 'Enquired again'
    case 'imported': return <>Brought over from ClickUp{e.detail ? <> as <b>{e.detail}</b></> : null}</>
    case 'clickup_status': return <>In ClickUp: <b>{e.detail}</b></>
    case 'moved': {
      const [from, to] = (e.detail ?? '').split('>')
      return <>Moved from <b>{stageLabel(from)}</b> to <b>{stageLabel(to)}</b></>
    }
    default: return e.detail ?? e.kind
  }
}

// The website capture, and the allotment rule (whose allot lines alone carry a reason), act with nobody behind them.
const byItself = (e: LeadEvent) => e.detail === 'website form' || (!!e.detail && (e.kind === 'allotted' || e.kind === 'reassigned'))

/** Who did it. ClickUp's own entries say so instead of naming a former colleague. */
export const eventBy = (e: LeadEvent) =>
  e.kind === 'clickup_status' ? 'From ClickUp' : e.actor_name ?? (byItself(e) ? 'Automatically' : 'A former colleague')

export function StepIcon({ step }: { step: string }) {
  if (/^WhatsApp/i.test(step)) return <MessageCircle aria-hidden="true" />
  if (/^Email/i.test(step)) return <Mail aria-hidden="true" />
  if (/^Meeting/i.test(step)) return <CalendarDays aria-hidden="true" />
  return <Phone aria-hidden="true" />
}

export function StepLine({ step, children }: { step: string | null; children?: React.ReactNode }) {
  if (!step) return null
  return <div className={s.step}><StepIcon step={step} /><span className={s.stepText}>{step}</span>{children}</div>
}

export function Due({ lead, today, plain = false }: { lead: WorkLead; today: string; plain?: boolean }) {
  const d = dueOf(lead, today)
  const tone = d.tone === 'over' ? ` ${s.dueOver}` : d.tone === 'today' ? ` ${s.dueToday}` : ''
  return <span className={`${s.due}${tone}`}>{!plain && <Clock aria-hidden="true" />}{d.label}</span>
}

export function Flag({ lead, now, plain = false }: { lead: WorkLead; now: number; plain?: boolean }) {
  const f = flagOf(lead, now)
  if (!f) return null
  const Icon = f.kind === 'waiting' ? Hourglass : TriangleAlert
  return <span className={`${s.flag}${f.red ? ` ${s.flagRed}` : ''}`}>{!plain && <Icon aria-hidden="true" />}{f.label}</span>
}

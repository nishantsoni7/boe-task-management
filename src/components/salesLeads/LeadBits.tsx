'use client'

import { Bell, CalendarDays, Clock, Flame, Hourglass, Mail, MessageCircle, Phone, Snowflake, Sun, TriangleAlert } from 'lucide-react'
import { formatPhone } from '@/lib/exhibitionLeads/phone'
import type { WorkLead } from '@/lib/salesLeads/api'
import { dueOf, flagOf, marketLabel, type Temperature, TEMPERATURES, valueLabel } from '@/lib/salesLeads/board'
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

export function LeadChips({ lead }: { lead: WorkLead }) {
  return (
    <div className={s.chips}>
      <TempChip value={lead.temperature} />
      <ValueChip paise={lead.expected_value_paise} />
      {lead.market === 'export' && <span className={`${s.chip} ${s.chipExport}`}>{marketLabel(lead)}</span>}
      {lead.enquired_again_at && !lead.last_activity_at && <span className={`${s.chip} ${s.chipAgain}`}><Bell aria-hidden="true" />Enquired again</span>}
    </div>
  )
}

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

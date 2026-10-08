'use client'

import { Phone, MessageCircle } from 'lucide-react'
import {
  PRIORITIES, STATUSES, labelOf, isTerminalStatus, type Lead,
} from '@/lib/exhibitionLeads/constants'
import { telHref, whatsappHref } from '@/lib/exhibitionLeads/phone'
import { shortDate } from '@/lib/exhibitionLeads/format'
import s from './leads.module.css'

export function PriorityBadge({ priority }: { priority: string }) {
  const cls = priority === 'hot' ? s.badgeHot
    : priority === 'warm' ? s.badgeWarm
    : priority === 'general_interest' ? s.badgeGeneral
    : s.badgeMuted
  return <span className={`${s.badge} ${cls}`}>{labelOf(PRIORITIES, priority)}</span>
}

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'converted' ? s.badgeOk : isTerminalStatus(status) ? s.badgeMuted : ''
  return <span className={`${s.badge} ${cls}`}>{labelOf(STATUSES, status)}</span>
}

/**
 * The next follow-up date, with the words an owner needs: overdue and due-today
 * stand out. A closed or archived lead has no live schedule, so none is shown.
 */
export function FollowUpText({ lead, today }: { lead: Pick<Lead, 'next_follow_up_on' | 'status' | 'archived_at'>; today: string }) {
  if (!lead.next_follow_up_on) return null
  const d = lead.next_follow_up_on
  const live = !lead.archived_at && !isTerminalStatus(lead.status)
  if (live && d < today) return <span className={s.followDue}>Follow-up overdue · {shortDate(d)}</span>
  if (live && d === today) return <span className={s.followToday}>Follow-up today</span>
  return <span>Follow-up {shortDate(d)}</span>
}

/**
 * Call and WhatsApp open another app. Neither proves that anyone spoke to the
 * visitor, so neither touches the lead's status — "Contacted" is a decision the
 * owner records in the update panel.
 */
export function ContactActions({ phone, small = false, iconOnly = false }: { phone: string; small?: boolean; iconOnly?: boolean }) {
  const cls = `${s.btn}${small ? ` ${s.btnSm}` : ''}${iconOnly ? ` ${s.btnIcon}` : ''}`
  return (
    <>
      <a className={cls} href={telHref(phone)} aria-label={`Call ${phone}`} title="Call">
        <Phone size={15} aria-hidden="true" />{!iconOnly && ' Call'}
      </a>
      <a className={cls} href={whatsappHref(phone)} target="_blank" rel="noopener noreferrer" aria-label={`WhatsApp ${phone}`} title="WhatsApp">
        <MessageCircle size={15} aria-hidden="true" />{!iconOnly && ' WhatsApp'}
      </a>
    </>
  )
}

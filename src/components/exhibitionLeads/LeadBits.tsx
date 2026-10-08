'use client'

import Link from 'next/link'
import { Phone, MessageCircle } from 'lucide-react'
import {
  STATUSES, labelOf, isTerminalStatus, leadTypeLabel, type Lead,
} from '@/lib/exhibitionLeads/constants'
import { telHref, whatsappHref } from '@/lib/exhibitionLeads/phone'
import { shortDate } from '@/lib/exhibitionLeads/format'
import s from './leads.module.css'

export function LeadTypeBadge({ leadType }: { leadType: string }) {
  const cls = leadType === 'hot' ? s.badgeHot
    : leadType === 'warm' ? s.badgeWarm
    : leadType === 'long_term' ? s.badgeGeneral
    : s.badgeMuted
  return <span className={`${s.badge} ${cls}`}>{leadTypeLabel(leadType)}</span>
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
 * Nothing to capture leads against yet. An Admin is pointed at the screen that
 * fixes it; everyone else is told to ask them. `closedOnly`: exhibitions exist
 * but none is open for new leads.
 */
export function NoExhibitionNotice({ isAdmin, closedOnly = false }: { isAdmin: boolean; closedOnly?: boolean }) {
  const text = closedOnly
    ? (isAdmin
      ? 'Every exhibition is closed for new leads. Open one, or add a new exhibition.'
      : 'No exhibition is open for new leads right now. Please ask your Admin to open or add one.')
    : (isAdmin
      ? 'No exhibition has been added yet. Add one to start capturing leads.'
      : 'No exhibition has been added yet. Please ask your Admin to add it.')
  return (
    <div className={`${s.notice} ${s.noticeWarn}`} role="status">
      {text}
      {isAdmin && (
        <div className={s.noticeActions}>
          <Link className={`${s.btn} ${s.btnRed}`} href="/exhibition-leads/exhibitions">
            {closedOnly ? 'Manage exhibitions' : 'Add exhibition'}
          </Link>
        </div>
      )}
    </div>
  )
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

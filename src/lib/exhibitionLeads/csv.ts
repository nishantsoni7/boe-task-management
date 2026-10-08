import { csvCell, formatIst } from '@/lib/minop/incomingCsv'
import {
  BUYING_TIMELINES, STATUSES, clientTypeText, labelOf, leadTypeLabel, requirementsLabel,
  type Lead,
} from './constants'

// The Admin export. Same conventions as the Minop register export: UTF-8 with a
// BOM and CRLF so Excel reads it, csvCell() for escaping and for the leading
// = + - @ guard that stops a visitor-typed value from running as a formula.
//
// Phone numbers: stored as a validated '+<digits>' (a DB CHECK), so the cell can
// safely be written ="+919876543210" — Excel then keeps the plus and never turns
// it into a number. Anything that does not match that shape falls back to
// csvCell's apostrophe guard instead.

export type ExportLead = Lead & { exhibition_name: string | null }

const SAFE_PHONE = /^\+[0-9]{8,15}$/

export function phoneCell(e164: string): string {
  return SAFE_PHONE.test(e164) ? `"=""${e164}"""` : csvCell(e164)
}

type Column = { header: string; cell: (l: ExportLead) => string }

export const LEAD_CSV_COLUMNS: Column[] = [
  { header: 'Exhibition', cell: l => csvCell(l.exhibition_name) },
  { header: 'Added (IST)', cell: l => csvCell(formatIst(l.created_at)) },
  { header: 'Original collector', cell: l => csvCell(l.collected_by_name) },
  { header: 'Current owner', cell: l => csvCell(l.owner_name) },
  { header: 'Contact name', cell: l => csvCell(l.contact_name) },
  { header: 'Mobile', cell: l => phoneCell(l.phone) },
  { header: 'Company / project', cell: l => csvCell(l.company_name) },
  { header: 'City', cell: l => csvCell(l.project_city) },
  { header: 'Client type', cell: l => csvCell(clientTypeText(l)) },
  { header: 'Requirements', cell: l => csvCell(requirementsLabel(l.requirements)) },
  { header: 'Buying timeline', cell: l => csvCell(labelOf(BUYING_TIMELINES, l.buying_timeline)) },
  { header: 'Lead type', cell: l => csvCell(leadTypeLabel(l.lead_type)) },
  { header: 'Status', cell: l => csvCell(labelOf(STATUSES, l.status)) },
  { header: 'Next follow-up', cell: l => csvCell(l.next_follow_up_on) },
  { header: 'Initial discussion note', cell: l => csvCell(l.initial_note) },
  { header: 'Latest follow-up note', cell: l => csvCell(l.latest_note) },
  { header: 'Archived', cell: l => (l.archived_at ? 'Yes' : 'No') },
  { header: 'Archive reason', cell: l => csvCell(l.archive_reason) },
]

export function buildLeadsCsv(rows: readonly ExportLead[]): string {
  const head = LEAD_CSV_COLUMNS.map(c => c.header).join(',')
  const body = rows.map(r => LEAD_CSV_COLUMNS.map(c => c.cell(r)).join(','))
  return `﻿${[head, ...body].join('\r\n')}\r\n`
}

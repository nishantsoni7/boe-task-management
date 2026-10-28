import { csvCell, formatIst } from '@/lib/minop/incomingCsv'
import { CAPABILITIES, CATEGORIES, VENDOR_STATUSES, labelOf, labelsOf, type VendorSummary } from './constants'
import { phoneCell } from '@/lib/exhibitionLeads/csv'

// The vendor list as a spreadsheet. Same conventions as the other exports: UTF-8 with a BOM and CRLF so
// Excel reads it, csvCell() for escaping and the leading = + - @ guard, phones written so Excel keeps the plus.

type Column = { header: string; cell: (v: VendorSummary) => string }

export const VENDOR_CSV_COLUMNS: Column[] = [
  { header: 'Company', cell: v => csvCell(v.company_name) },
  { header: 'Contact person', cell: v => csvCell(v.contact_name) },
  { header: 'Mobile', cell: v => phoneCell(v.phone) },
  { header: 'City', cell: v => csvCell(v.city) },
  { header: 'State', cell: v => csvCell(v.state) },
  { header: 'Status', cell: v => csvCell(labelOf(VENDOR_STATUSES, v.status)) },
  { header: 'Can do', cell: v => csvCell(labelsOf(CAPABILITIES, v.capabilities)) },
  { header: 'Product types', cell: v => csvCell(labelsOf(CATEGORIES, v.categories)) },
  { header: 'People', cell: v => csvCell(v.headcount === null ? '' : String(v.headcount)) },
  { header: 'Visits', cell: v => csvCell(String(v.visit_count)) },
  { header: 'Last visit (IST)', cell: v => csvCell(v.last_visit_at ? formatIst(v.last_visit_at) : '') },
  { header: 'Last visited by', cell: v => csvCell(v.last_visited_by) },
]

export function vendorsCsv(rows: VendorSummary[]): string {
  const lines = [VENDOR_CSV_COLUMNS.map(c => c.header).join(',')]
  for (const r of rows) lines.push(VENDOR_CSV_COLUMNS.map(c => c.cell(r)).join(','))
  return `﻿${lines.join('\r\n')}\r\n`
}

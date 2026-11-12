// Phase 6, Reports: periods, the report's shape (from quotation_report, 20270618000000) and CSV downloads.

import type { createClient } from '@/lib/supabase/client'
import { csvCell } from '@/lib/minop/incomingCsv'
import { classifyError } from './api'

type Supabase = ReturnType<typeof createClient>

export type Count = { n: number; value: number }
export type Group = { name: string; made: number; sent?: number; confirmed: number; lost: number; confirmed_value?: number; win_rate: number | null }
export type Report = {
  scope: 'mine' | 'all'; may_see_all: boolean; from: string; to: string; today: string
  funnel: Record<'made' | 'sent' | 'negotiating' | 'confirmed' | 'lost' | 'open', Count>
  week: { from: string; to: string; made: number; made_value: number; sent: number; confirmed: number; confirmed_value: number; lost: number }
  by_owner: Group[]; by_client_type: Group[]; by_source: Group[]
  speed: { days_to_send: number | null; sent_count: number; days_to_confirm: number | null; confirmed_count: number }
  ageing: { bucket: string; n: number; value: number }[]
  opened_no_followup: { id: string; quote_no: string; client_name: string; owner_name: string | null; opened_at: string; value: number }[]
  lost_reasons: { reason: string; n: number }[]
  discount: { bucket: string; decided: number; confirmed: number; win_rate: number | null }[]
  price_waiting: number
}

export type PeriodKey = 'week' | 'month' | 'quarter' | 'year' | 'custom'

const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/** The period's first and last day, from an India date "YYYY-MM-DD" (weeks start on Monday; quarters are Indian, April first). */
export function periodRange(key: Exclude<PeriodKey, 'custom'>, todayIso: string): { from: string; to: string } {
  const [y, m, d] = todayIso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  if (key === 'week') {
    const back = (t.getUTCDay() + 6) % 7
    return { from: iso(new Date(Date.UTC(y, m - 1, d - back))), to: iso(new Date(Date.UTC(y, m - 1, d - back + 6))) }
  }
  if (key === 'month') return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) }
  if (key === 'quarter') {
    // Financial-year quarters (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar) fall on the same months as calendar quarters.
    const start = Math.floor((m - 1) / 3) * 3
    return { from: iso(new Date(Date.UTC(y, start, 1))), to: iso(new Date(Date.UTC(y, start + 3, 0))) }
  }
  const fyStart = m >= 4 ? y : y - 1
  return { from: iso(new Date(Date.UTC(fyStart, 3, 1))), to: iso(new Date(Date.UTC(fyStart + 1, 2, 31))) }
}

export async function fetchReport(s: Supabase, from: string, to: string, scope: 'mine' | 'all'): Promise<Report> {
  const { data, error } = await s.rpc('quotation_report', { p_from: from, p_to: to, p_scope: scope })
  if (error) throw classifyError(error)
  return data as Report
}

/** A table as CSV: UTF-8 with a BOM and CRLF (Excel), cells escaped by the shared csvCell. */
export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  return '﻿' + [headers, ...rows].map(r => r.map(v => csvCell(v === null ? '' : String(v))).join(',')).join('\r\n') + '\r\n'
}

export function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

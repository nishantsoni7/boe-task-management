import { normalizeLeadPhone } from '@/lib/exhibitionLeads/phone'
import type { LeadSource } from './constants'

// The two old Google Sheets, read in the browser before anything is saved (import_sales_lead_sheet, 20270530000000).
//   "Leads Master - 2026": a tab per year (Date 1-31 and Month, no year), Export tabs (Month only), Campaign and Retailers
//   (2026). Columns are found by name.
//   "Website Leads": what the website form wrote (your-name, your-tel, ...), mostly without a date, and after the message
//   the person it was given to. A missing date is taken from the dated rows around it: the form writes rows in order.

export type Grid = readonly (readonly unknown[])[]
export type SheetRow = {
  phone: string
  received_on: string | null
  source: LeadSource
  name: string | null
  email: string | null
  location: string | null
  requirement: string | null
  detail: string
}
export type TabReport = { tab: string; rows: number; used: number; skipped: number; note: string }
export type SheetPlan = { rows: SheetRow[]; tabs: TabReport[]; estimated: number }

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const SOURCES: Record<string, LeadSource> = {
  website: 'website', whatsapp: 'whatsapp', instagram: 'instagram', 'insta promo': 'insta_promo', 'insta promotion': 'insta_promo',
  'facebook promo': 'facebook_promo', 'facebook promotion': 'facebook_promo', facebook: 'facebook_promo', 'google ads': 'google_ads',
  reference: 'reference', repeat: 'repeat_customer', 'repeat customer': 'repeat_customer', campaign: 'campaign', bni: 'bni',
  'walk in': 'walk_in', 'walk-in': 'walk_in', others: 'others',
}
/** Rows on the website sheet given to these are suppliers and job seekers, not customers. */
const NOT_LEADS = new Set(['supplier', 'factory staff', 'office staff', 'factory'])

const text = (v: unknown) => (v instanceof Date ? '' : String(v ?? '').trim())
export const sheetSource = (v: unknown): LeadSource => SOURCES[text(v).toLowerCase().replace(/\s+/g, ' ')] ?? 'others'
const clip = (v: unknown, n: number) => text(v).slice(0, n) || null
const pad = (n: number) => String(n).padStart(2, '0')
/** Rows with anything in them: a sheet keeps hundreds of formatted, empty rows. */
const filledRows = (grid: Grid) => grid.slice(1).filter(r => r.some(c => text(c) || c instanceof Date)).length

/** A real calendar day, or null. Day 31 of a 30-day month becomes the 30th. */
export function dayOf(year: number, month: number, day: number): string | null {
  if (!year || !month || month > 12) return null
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${pad(month)}-${pad(Math.min(Math.max(day || 1, 1), last))}`
}

/** A date written any way the sheets write one: a real date cell, "Fri Mar 10 2023", "10/03/2023". */
export function looseDate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // A date cell is midnight in India, which is the evening before in UTC.
    const ist = new Date(v.getTime() + 5.5 * 3_600_000)
    return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`
  }
  const s = text(v)
  const named = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/.exec(s)
  if (named && MONTHS[named[1].toLowerCase()]) return dayOf(Number(named[3]), MONTHS[named[1].toLowerCase()], Number(named[2]))
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)
  if (dmy) return dayOf(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]))
  return null
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const email = (v: unknown) => { const e = text(v).toLowerCase(); return e.length <= 120 && EMAIL.test(e) ? e : null }
const phoneOf = (v: unknown) => normalizeLeadPhone(text(v).replace(/[^\d+]/g, ''))
const col = (head: readonly string[], ...names: RegExp[]) => head.findIndex(h => names.some(n => n.test(h)))

/** Which workbook this is, from its tab names. */
export function workbookKind(tabs: readonly string[]): 'leads_master' | 'website' | null {
  if (tabs.some(t => /^20\d\d$/.test(t.trim()))) return 'leads_master'
  if (tabs.some(t => /all_leads|till 20\d\d/i.test(t))) return 'website'
  return null
}

/** Leads Master: the year tabs, the Export tabs, Campaign and Retailers. Architects, Worker, Job and Variables are not leads. */
export function readLeadsMaster(tabs: Readonly<Record<string, Grid>>): SheetPlan {
  const rows: SheetRow[] = []
  const report: TabReport[] = []
  let estimated = 0
  for (const [tab, grid] of Object.entries(tabs)) {
    const name = tab.trim()
    const year = Number(/(20\d\d)/.exec(name)?.[1] ?? (/^(campaign|retailers)$/i.test(name) ? 2026 : 0))
    if (!year) { report.push({ tab: name, rows: filledRows(grid), used: 0, skipped: filledRows(grid), note: 'not leads' }); continue }
    const head = (grid[0] ?? []).map(h => text(h))
    const at = {
      day: col(head, /^date\.?$/i), month: col(head, /^month$/i), source: col(head, /lead source/i), name: col(head, /customer name|^name$/i),
      email: col(head, /^email/i), phone: col(head, /contact|phone/i), location: col(head, /location/i), need: col(head, /requirement/i),
      who: col(head, /ass[ia]n?g?n?ed to/i),
    }
    let used = 0
    let skipped = 0
    for (const r of grid.slice(1)) {
      if (!r.some(c => text(c))) continue
      const phone = phoneOf(r[at.phone])
      const month = MONTHS[text(r[at.month]).slice(0, 3).toLowerCase()]
      if (!phone || !month) { skipped++; continue }
      const day = at.day >= 0 ? Number(text(r[at.day])) : 0
      if (!day) estimated++
      const need = text(r[at.need])
      const who = text(r[at.who])
      rows.push({
        phone, received_on: dayOf(year, month, day), source: sheetSource(r[at.source]), name: clip(r[at.name], 120), email: email(r[at.email]),
        location: clip(r[at.location], 120),
        requirement: need ? (/^retailers$/i.test(name) ? `Retailer: ${need}` : need).slice(0, 4000) : null,
        detail: `Leads Master ${name}${who ? `, given to ${who}` : ''}${day ? '' : ', day not recorded'}`,
      })
      used++
    }
    report.push({ tab: name, rows: used + skipped, used, skipped, note: skipped ? 'no number or month' : '' })
  }
  return { rows, tabs: report, estimated }
}

/**
 * Website Leads: all_leads, Till 2025 and Till 2024. A row's date is its own when it has one, otherwise the date of the
 * nearest dated row above it (below it at the top of a tab). Dated means its own date, or its number in Leads Master.
 */
export function readWebsiteLeads(tabs: Readonly<Record<string, Grid>>, knownDates: ReadonlyMap<string, string>): SheetPlan {
  const rows: SheetRow[] = []
  const report: TabReport[] = []
  let estimated = 0
  for (const [tab, grid] of Object.entries(tabs)) {
    const name = tab.trim()
    const head = (grid[0] ?? []).map(h => text(h))
    const at = { phone: head.indexOf('your-tel'), name: head.indexOf('your-name'), email: head.indexOf('your-email'), location: head.indexOf('your-location'), need: head.indexOf('your-textarea'), type: head.indexOf('form-type') }
    if (at.phone < 0) { report.push({ tab: name, rows: filledRows(grid), used: 0, skipped: filledRows(grid), note: 'not the form' }); continue }
    const dateCol = head.findIndex(h => /^date$/i.test(h))
    type Pending = { row: SheetRow; date: string | null }
    const pending: Pending[] = []
    let skipped = 0
    for (const r of grid.slice(1)) {
      if (!r.some(c => text(c) || c instanceof Date)) continue
      const who = text(r[at.need + 1])
      const phone = phoneOf(r[at.phone])
      if (!phone || NOT_LEADS.has(who.toLowerCase())) { skipped++; continue }
      const own = looseDate(r[0]) ?? (dateCol >= 0 ? looseDate(r[dateCol]) : null)
      pending.push({
        date: own ?? knownDates.get(phone) ?? null,
        row: {
          phone, received_on: own, source: /google ads/i.test(text(r[at.type])) ? 'google_ads' : 'website', name: clip(r[at.name], 120),
          email: email(r[at.email]), location: clip(r[at.location], 120), requirement: clip(r[at.need], 4000),
          detail: `Website form (${name})${who ? `, given to ${who}` : ''}`,
        },
      })
    }
    // Fill each undated row from the nearest dated row before it, or after it at the top of the tab.
    let last: string | null = null
    const firstKnown = pending.find(p => p.date)?.date ?? null
    for (const p of pending) {
      if (p.date) last = p.date
      if (!p.row.received_on) {
        const guess = p.date ?? last ?? firstKnown
        if (guess) { p.row.received_on = guess; if (!knownDates.has(p.row.phone)) { estimated++; p.row.detail += ', date estimated' } }
      }
      rows.push(p.row)
    }
    report.push({ tab: name, rows: pending.length + skipped, used: pending.length, skipped, note: skipped ? 'no number, or a supplier or staff' : '' })
  }
  return { rows, tabs: report, estimated }
}

/** The earliest day each number appears in Leads Master, for dating the website rows. */
export function firstDates(rows: readonly SheetRow[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of rows) if (r.received_on && (!m.has(r.phone) || r.received_on < m.get(r.phone)!)) m.set(r.phone, r.received_on)
  return m
}

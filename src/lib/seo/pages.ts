// What the six everyday SEO pages work out from the saved rows, and the expert notes the Monday session writes for
// each. Pure, so each rule is tested without a database. The notes arrive inside seo_reviews.detail.pages and are not
// taken on trust: a missing or wrong field just stays blank, and the page still draws its figures.

import {
  dayLabel, daysBetween, latestByScope, latestReview, newestDate, numberIn, openProposals, tagOf, topThreeSpots,
  type SeoData, type SeoRun,
} from './report'
import type { SeoTag } from './sixMonth'

export type PageKey = 'overview' | 'rankings' | 'competitors' | 'board' | 'weekly' | 'tasks'

type Raw = Record<string, unknown>

const objects = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is Raw => typeof v === 'object' && v !== null) : [])
const said = (value: unknown) => (typeof value === 'string' ? value : '')

export type SideNumber = { label: string; note: string; value: string; tone?: 'up' | 'down' }

export type PageNotes = {
  kicker: string
  title: string
  text: string
  link: string
  foot: string
  lenses: { label: string; tag: SeoTag }[]
  side: SideNumber[]
  checks: Record<string, string>
  notes: { label: string; text: string }[]
  rows: { title: string; text: string; tag: SeoTag | null }[]
  cards: { title: string; text: string; action: string; tag: SeoTag | null }[]
  needs: { item: string; when: string; title: string; why: string }[]
}

export function pageNotes(data: SeoData, key: PageKey): PageNotes {
  const pages = latestReview(data)?.detail?.pages as Raw | undefined
  const page = (pages?.[key] ?? {}) as Raw
  return {
    kicker: said(page.kicker),
    title: said(page.title),
    text: said(page.text),
    link: said(page.link),
    foot: said(page.foot),
    lenses: objects(page.lenses).flatMap(l => { const tag = tagOf(l.tag); return tag && said(l.label) ? [{ label: said(l.label), tag }] : [] }),
    side: objects(page.side)
      .map((n): SideNumber => ({ label: said(n.label), note: said(n.note), value: said(n.value), tone: n.tone === 'up' || n.tone === 'down' ? n.tone : undefined }))
      .filter(n => n.label && n.value),
    checks: Object.fromEntries(Object.entries((page.checks ?? {}) as Raw).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string>,
    notes: objects(page.notes).map(n => ({ label: said(n.label), text: said(n.text) })).filter(n => n.text),
    rows: objects(page.rows).map(r => ({ title: said(r.title), text: said(r.text), tag: tagOf(r.tag) })).filter(r => r.title),
    cards: objects(page.cards).map(c => ({ title: said(c.title), text: said(c.text), action: said(c.action), tag: tagOf(c.tag) })).filter(c => c.title),
    needs: objects(page.needs).map(n => ({ item: said(n.item), when: said(n.when), title: said(n.title), why: said(n.why) })).filter(n => n.title),
  }
}

/** A signed change in whole percent, with a real minus sign, or a dash when there is nothing to compare with. */
export function percentChange(now: number, before: number | null) {
  if (!before) return '—'
  const percent = Math.round(((now - before) / before) * 100)
  return `${percent > 0 ? '+' : percent < 0 ? '−' : ''}${Math.abs(percent)}%`
}

export const thousands = (value: number) => `${Math.round(value / 1000)}K`

// ── The week and the month ──────────────────────────────────────────────────

export function weekNumbers(data: SeoData) {
  const row = latestByScope(data, 'site.week')[0]
  if (!row || row.value === null) return null
  return {
    clicks: row.value,
    previous: numberIn(row.detail, 'previous'),
    views: numberIn(row.detail, 'views'),
    viewsPrevious: numberIn(row.detail, 'views_previous'),
    daily: objects(row.detail?.daily).map(d => ({ date: said(d.date), clicks: typeof d.clicks === 'number' ? d.clicks : 0 })).filter(d => d.date),
  }
}

export function monthClicks(data: SeoData) {
  const row = latestByScope(data, 'site.28d')[0]
  return row && row.value !== null ? { clicks: row.value, previous: numberIn(row.detail, 'previous') } : null
}

// ── Money keywords in India ─────────────────────────────────────────────────

export type IndiaKeyword = {
  keyword: string
  order: number
  position: number
  previous: number | null
  clicks: number
  views: number
  demand: string
  step: string
  shown: string[]
  want: string
}

// Under 11 is page 1 and under 21 is page 2, because 10.9 shows as 10 in Search Console.
const PAGE_2 = 11
const PAGE_3 = 21
const REAL_VIEWS = 100

export function indiaKeywords(data: SeoData) {
  const latest = latestByScope(data, 'keyword.india')
  const asOf = newestDate(latest)
  const fresh = latest.filter(r => r.metric_date === asOf && r.value !== null)
  const rows = fresh
    .map((r): IndiaKeyword => ({
      keyword: r.scope,
      order: numberIn(r.detail, 'order') ?? fresh.length,
      position: r.value as number,
      previous: numberIn(r.detail, 'previous'),
      clicks: numberIn(r.detail, 'clicks') ?? 0,
      views: numberIn(r.detail, 'views') ?? 0,
      demand: said(r.detail?.demand),
      step: said(r.detail?.step),
      shown: Array.isArray(r.detail?.shown) ? r.detail.shown.map(said).filter(Boolean) : [],
      want: said(r.detail?.want),
    }))
    .sort((a, b) => a.order - b.order)
  const sum = (key: string) => fresh.reduce((total, r) => total + (numberIn(r.detail, key) ?? 0), 0)
  const page1 = rows.filter(r => r.position < PAGE_2)
  return {
    rows,
    // A keyword with a next step has enough views to act on.
    main: rows.filter(r => r.step),
    thin: rows.filter(r => !r.step),
    wrong: rows.filter(r => r.want),
    page1: page1.length,
    real: page1.filter(r => r.views >= REAL_VIEWS).length,
    page2: rows.filter(r => r.position >= PAGE_2 && r.position < PAGE_3).length,
    page3: rows.filter(r => r.position >= PAGE_3).length,
    clicks: sum('clicks'),
    clicksBefore: sum('clicks_prev'),
    views: sum('views'),
    viewsBefore: sum('views_prev'),
  }
}

// ── Who holds the city results ──────────────────────────────────────────────

export function spotBars(data: SeoData) {
  const spots = [...topThreeSpots(data)]
  const held = (site: RegExp) => spots.reduce((total, [domain, count]) => total + (site.test(domain) ? count : 0), 0)
  return [
    { label: 'Justdial', count: held(/justdial/), us: false },
    { label: 'IndiaMART', count: held(/indiamart/), us: false },
    { label: 'Best of Exports', count: held(/^bestofexports\.com$/), us: true },
  ]
}

// ── What needs the owner ────────────────────────────────────────────────────

export type Need = { when: string; title: string; why: string; href?: string; action?: string; urgent?: boolean }

const TO_BOARD = { href: '/seo/board', action: 'Open the board' }

/** The login first, because everything else can wait for it. Then what the Monday session worded, then anything it missed. */
export function needsYou(data: SeoData, notes: PageNotes): Need[] {
  const last = data.runs.filter(r => r.feed === 'ahrefs_research').sort((a, b) => b.run_date.localeCompare(a.run_date))[0]
  const login: Need[] = last?.status === 'logged_out'
    ? [{ when: 'Before 9:52 pm', title: 'Log in to tools.toolsurf.com in Chrome', why: 'The Ahrefs run stops without it, and with it the competitor readings.', href: 'https://tools.toolsurf.com', action: 'Open Toolsurf', urgent: true }]
    : []
  const status = new Map(data.planItems.map(i => [i.id, i.status]))
  // A need tied to a plan item drops off once that item is done, without waiting for next Monday.
  const worded = notes.needs
    .filter(n => status.get(n.item) !== 'done')
    .map((n): Need => ({ when: n.when, title: n.title, why: n.why, ...(n.item ? TO_BOARD : {}) }))
  const missed = data.planItems
    .filter(i => i.status === 'waiting_owner' && !notes.needs.some(n => n.item === i.id))
    .map((i): Need => ({ when: i.due_date ? `By ${dayLabel(i.due_date)}` : 'Soon', title: i.title, why: i.evidence, ...TO_BOARD }))
  const open = openProposals(data).length
  const answers: Need[] = open
    ? [{ when: 'This week', title: `Answer ${open} strategy ${open === 1 ? 'change' : 'changes'}`, why: 'Each comes with a recommendation.', href: '/seo/board', action: 'Answer them' }]
    : []
  return [...login, ...worded, ...missed, ...answers]
}

// ── The last 7 days of tasks, and how old each figure is ────────────────────

export type TaskCell = 'ran' | 'saved' | 'stopped' | 'login' | 'due' | 'none'

export const CELL_LABEL: Record<TaskCell, string> = { ran: 'Ran', saved: 'Saved', stopped: 'Stop', login: 'Login', due: 'Due', none: '–' }

function cellFor(run: SeoRun | undefined): TaskCell {
  if (!run) return 'none'
  if (run.status === 'logged_out') return 'login'
  if (run.status === 'blocked' || run.status === 'failed') return 'stopped'
  return /^ran only after/i.test(run.message) ? 'saved' : 'ran'
}

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const WEEKLY_FEED: SeoRun['feed'] = 'monday_review'

export function taskGrid(data: SeoData, today: string) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(today, index - 6))
  const cells = (feed: SeoRun['feed']) => days.map((day): TaskCell => {
    const cell = cellFor(data.runs.find(r => r.feed === feed && r.run_date === day))
    return cell === 'none' && day === today && feed !== WEEKLY_FEED ? 'due' : cell
  })
  return { days, cells }
}

export type SourceAge = { name: string; when: string; note: string; tag: SeoTag }

const OLD_DAYS = 7

export function sourceAges(data: SeoData, today: string): SourceAge[] {
  return latestByScope(data, 'source.age')
    .sort((a, b) => (numberIn(a.detail, 'order') ?? 0) - (numberIn(b.detail, 'order') ?? 0))
    .flatMap(r => {
      const date = said(r.detail?.date)
      if (!date) return []
      const tag: SeoTag = tagOf(r.detail?.tag)
        ?? (daysBetween(date, today) > OLD_DAYS ? { text: 'Old', tone: 'wait' } : r.detail?.by_hand ? { text: 'By hand', tone: 'pending' } : { text: 'Fresh', tone: 'good' })
      return [{ name: r.scope, when: said(r.detail?.when) || dayLabel(date), note: said(r.detail?.note), tag }]
    })
}

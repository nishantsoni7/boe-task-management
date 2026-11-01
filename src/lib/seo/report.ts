// Everything the SEO screens work out from the saved rows. Pure, so each rule is tested without a database.

export type SeoMetric = {
  metric_date: string
  metric: string
  scope: string
  value: number | null
  detail: Record<string, unknown> | null
  source: string
}
export type SeoWatch = { kind: 'keyword' | 'competitor'; entry_key: string; label: string; note: string | null; active: boolean }
export type SeoPlanItem = {
  id: string
  window_key: 'd30' | 'd60'
  title: string
  who: string
  due_date: string | null
  status: 'done' | 'started' | 'waiting_owner' | 'not_started'
  evidence: string
}
export type SeoReview = {
  review_date: string
  verdict: 'on_track' | 'watch' | 'off_track' | 'none'
  items_due: number | null
  items_done: number | null
  numbers_on_target: number | null
  summary: string
}
export type SeoLogRow = {
  id: string
  kind: 'work' | 'finding' | 'decision' | 'proposal'
  log_date: string
  title: string
  body: string
  before_value: string | null
  after_value: string | null
  source: string
}
export type SeoRun = {
  feed: 'daily_numbers' | 'city_check' | 'ahrefs_research' | 'monday_review'
  run_date: string
  status: 'ok' | 'partial' | 'blocked' | 'logged_out' | 'failed'
  message: string
  row_count: number
}
export type SeoData = {
  metrics: SeoMetric[]
  watchlist: SeoWatch[]
  planItems: SeoPlanItem[]
  reviews: SeoReview[]
  log: SeoLogRow[]
  runs: SeoRun[]
}

const OUR_DOMAIN = 'bestofexports.com'
// Listings, not makers: shown as a count, never as a competitor.
const DIRECTORIES = /indiamart|justdial|tradeindia|exportersindia|sulekha|revenuebase|olx|pinterest|instagram|youtube|facebook|amazon|flipkart/

export const isSeoDataEmpty = (data: SeoData) => !data.metrics.length && !data.planItems.length

export const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export const formatCount = (value: number) => value.toLocaleString('en-IN')

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)

/** The newest row for each scope of one metric, and how it was read on what date. */
function latestByScope(data: SeoData, metric: string): SeoMetric[] {
  const newest = new Map<string, SeoMetric>()
  for (const row of data.metrics) {
    if (row.metric !== metric) continue
    const held = newest.get(row.scope)
    if (!held || row.metric_date > held.metric_date) newest.set(row.scope, row)
  }
  return [...newest.values()]
}

const newestDate = (rows: SeoMetric[]) => rows.reduce<string | null>((max, r) => (!max || r.metric_date > max ? r.metric_date : max), null)
const numberIn = (detail: SeoMetric['detail'], key: string) => (typeof detail?.[key] === 'number' ? (detail[key] as number) : null)

// ── Money keywords ──────────────────────────────────────────────────────────

export type KeywordRow = { keyword: string; position: number; previous: number | null; move: 'up' | 'down' | 'same' }

/** Search Console keeps no row for a keyword with no impressions, so a keyword missing from the newest reading is silent, not ranked. */
export function moneyKeywords(data: SeoData): { rows: KeywordRow[]; silent: string[]; asOf: string | null; inTop10: number } {
  const latest = latestByScope(data, 'keyword.position')
  const asOf = newestDate(latest)
  const rows = latest
    .filter(r => r.metric_date === asOf && r.value !== null)
    .map((r): KeywordRow => {
      const position = r.value as number
      const previous = numberIn(r.detail, 'previous')
      // A lower position is better.
      const move = previous === null || previous === position ? 'same' : position < previous ? 'up' : 'down'
      return { keyword: r.scope, position, previous, move }
    })
    .sort((a, b) => a.position - b.position)
  const ranked = new Set(rows.map(r => r.keyword))
  const silent = data.watchlist.filter(w => w.kind === 'keyword' && w.active && !ranked.has(w.entry_key)).map(w => w.label)
  // 10.9 still shows as position 10 in Search Console.
  return { rows, silent, asOf, inTop10: rows.filter(r => r.position < 11).length }
}

// ── Cities ──────────────────────────────────────────────────────────────────

export type CityRow = { city: string; demand: number | null; searches: number; top3: number; top10: number; leaders: { domain: string; spots: number }[] }

const topOf = (row: SeoMetric) => (Array.isArray(row.detail?.top) ? (row.detail.top as unknown[]).filter((d): d is string => typeof d === 'string') : [])

export function cityTable(data: SeoData): { cities: CityRow[]; directorySpots: number; totalSpots: number; asOf: string | null } {
  const latest = latestByScope(data, 'city.position')
  const demand = new Map(latestByScope(data, 'city.demand').map(r => [r.scope, r.value]))
  const byCity = new Map<string, SeoMetric[]>()
  for (const row of latest) {
    const city = row.scope.split(' | ')[0]
    byCity.set(city, [...(byCity.get(city) ?? []), row])
  }

  let directorySpots = 0
  let totalSpots = 0
  for (const row of latest) {
    for (const domain of topOf(row).slice(0, 3)) {
      totalSpots += 1
      if (DIRECTORIES.test(domain)) directorySpots += 1
    }
  }

  const cities = [...byCity.entries()]
    // The India-wide searches are not a city.
    .filter(([city]) => !city.startsWith('India'))
    .map(([city, rows]): CityRow => {
      const spots = new Map<string, number>()
      for (const row of rows) {
        for (const domain of topOf(row).slice(0, 3)) {
          if (domain !== OUR_DOMAIN && !DIRECTORIES.test(domain)) spots.set(domain, (spots.get(domain) ?? 0) + 1)
        }
      }
      return {
        city,
        demand: demand.get(city) ?? null,
        searches: rows.length,
        top3: rows.filter(r => r.value !== null && r.value <= 3).length,
        top10: rows.filter(r => r.value !== null && r.value <= 10).length,
        leaders: [...spots.entries()].map(([domain, count]) => ({ domain, spots: count })).sort((a, b) => b.spots - a.spots).slice(0, 2),
      }
    })
    .sort((a, b) => (b.demand ?? 0) - (a.demand ?? 0))
  return { cities, directorySpots, totalSpots, asOf: newestDate(latest) }
}

// ── Competitors ─────────────────────────────────────────────────────────────

export type CompetitorRow = {
  domain: string
  wins: string | null
  strength: number | null
  linkingSites: number | null
  keywords: number | null
  visits: number | null
  visitsYearAgo: number | null
  cityTop3: number
  asOf: string
  isUs: boolean
}

export function competitors(data: SeoData): CompetitorRow[] {
  const spots = new Map<string, number>()
  for (const row of latestByScope(data, 'city.position')) {
    for (const domain of topOf(row).slice(0, 3)) spots.set(domain, (spots.get(domain) ?? 0) + 1)
  }
  const notes = new Map(data.watchlist.filter(w => w.kind === 'competitor').map(w => [w.entry_key, w.note]))
  return latestByScope(data, 'competitor.snapshot')
    .map((r): CompetitorRow => ({
      domain: r.scope,
      wins: notes.get(r.scope) ?? null,
      strength: r.value,
      linkingSites: numberIn(r.detail, 'ref_domains'),
      keywords: numberIn(r.detail, 'keywords'),
      visits: numberIn(r.detail, 'visits'),
      visitsYearAgo: numberIn(r.detail, 'visits_year_ago'),
      cityTop3: spots.get(r.scope) ?? 0,
      asOf: r.metric_date,
      isUs: r.scope === OUR_DOMAIN,
    }))
    .sort((a, b) => Number(b.isUs) - Number(a.isUs) || b.cityTop3 - a.cityTop3 || (b.visits ?? 0) - (a.visits ?? 0))
}

// ── The year ────────────────────────────────────────────────────────────────

export type MonthRow = { month: string; label: string; clicks: number | null; impressions: number | null; position: number | null; sessions: number | null; leads: number | null }

export function months(data: SeoData): MonthRow[] {
  const byMonth = new Map<string, MonthRow>()
  const field: Record<string, keyof Pick<MonthRow, 'clicks' | 'impressions' | 'position' | 'sessions' | 'leads'>> = {
    'site.month.clicks': 'clicks',
    'site.month.impressions': 'impressions',
    'site.month.position': 'position',
    'site.month.sessions': 'sessions',
    'site.month.website_leads': 'leads',
  }
  for (const row of data.metrics) {
    const key = field[row.metric]
    if (!key) continue
    const month = row.metric_date.slice(0, 7)
    const held = byMonth.get(month) ?? {
      month,
      label: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }),
      clicks: null, impressions: null, position: null, sessions: null, leads: null,
    }
    byMonth.set(month, { ...held, [key]: row.value })
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12)
}

/** The second half of a run of months against the first, or null when there are not two full halves to compare. */
export function halfOnHalf(values: (number | null)[]): { before: number; after: number; percent: number } | null {
  if (values.length < 12 || values.some(v => v === null)) return null
  const known = values.slice(-12) as number[]
  const before = known.slice(0, 6).reduce((sum, v) => sum + v, 0)
  const after = known.slice(6).reduce((sum, v) => sum + v, 0)
  if (!before) return null
  return { before, after, percent: Math.round(((after - before) / before) * 100) }
}

export function pageGroups(data: SeoData) {
  return latestByScope(data, 'pages.clicks')
    .map(r => ({ group: r.scope, clicks: r.value ?? 0, before: numberIn(r.detail, 'before') }))
    .sort((a, b) => b.clicks - a.clicks)
}

export function workCounts(data: SeoData) {
  return latestByScope(data, 'work.count')
    .map(r => ({ label: r.scope, count: r.value ?? 0, useful: r.detail?.useful === true }))
    .sort((a, b) => b.count - a.count)
}

export const workLog = (data: SeoData) =>
  data.log.filter(r => r.kind === 'work').sort((a, b) => b.log_date.localeCompare(a.log_date))

// ── The board and its targets ───────────────────────────────────────────────

export const STATUS_LABEL: Record<SeoPlanItem['status'], string> = {
  done: 'Done',
  started: 'Started',
  waiting_owner: 'Waiting on you',
  not_started: 'Not started',
}

export function boardCounts(items: SeoPlanItem[]) {
  const count = (status: SeoPlanItem['status']) => items.filter(i => i.status === status).length
  return { total: items.length, done: count('done'), started: count('started'), waiting: count('waiting_owner'), notStarted: count('not_started') }
}

export type TargetRow = { measure: string; now: number | null; target: number | null; april: number | null; onTarget: boolean | null }

/** This month's target, or the next one set when this month has none. */
export function targetForMonth(byMonth: Record<string, number>, month: string): number | null {
  const next = Object.keys(byMonth).sort().find(m => m >= month)
  return next ? byMonth[next] : null
}

export function targets(data: SeoData, today: string): TargetRow[] {
  return latestByScope(data, 'plan.target')
    .sort((a, b) => (numberIn(a.detail, 'order') ?? 0) - (numberIn(b.detail, 'order') ?? 0))
    .map((r): TargetRow => {
      const byMonth = (r.detail?.months ?? {}) as Record<string, number>
      const target = targetForMonth(byMonth, today.slice(0, 7))
      return {
        measure: r.scope,
        now: r.value,
        target,
        april: byMonth['2027-04'] ?? null,
        onTarget: r.value === null || target === null ? null : r.value >= target,
      }
    })
}

export function progress(data: SeoData) {
  return latestByScope(data, 'plan.progress').map(r => ({ label: r.scope, done: r.value ?? 0, of: numberIn(r.detail, 'of') ?? 0 }))
}

export const openProposals = (data: SeoData) => data.log.filter(r => r.kind === 'proposal')
export const needsOwner = (data: SeoData) => data.planItems.filter(i => i.status === 'waiting_owner')

export const latestReview = (data: SeoData): SeoReview | null =>
  [...data.reviews].sort((a, b) => b.review_date.localeCompare(a.review_date))[0] ?? null

export const VERDICT_LABEL: Record<SeoReview['verdict'], string> = {
  on_track: 'On track',
  watch: 'Watch',
  off_track: 'Off track',
  none: 'No verdict yet',
}

// ── Scheduled tasks ─────────────────────────────────────────────────────────

const FEEDS: { feed: SeoRun['feed']; label: string; allowedDays: number }[] = [
  { feed: 'daily_numbers', label: 'Daily SEO numbers', allowedDays: 1 },
  { feed: 'city_check', label: 'Daily city check', allowedDays: 1 },
  { feed: 'ahrefs_research', label: 'Daily Ahrefs research', allowedDays: 1 },
  { feed: 'monday_review', label: 'Monday review', allowedDays: 7 },
]

export type TaskState = { label: string; state: 'never' | 'ok' | 'late' | 'problem'; text: string }

/** One line per task. A problem on its last run outranks lateness, because it says what to do. */
export function taskStates(data: SeoData, today: string): TaskState[] {
  return FEEDS.map(({ feed, label, allowedDays }): TaskState => {
    const last = data.runs.filter(r => r.feed === feed).sort((a, b) => b.run_date.localeCompare(a.run_date))[0]
    if (!last) return { label, state: 'never', text: 'No run yet' }
    const when = dayLabel(last.run_date)
    if (last.status === 'logged_out') return { label, state: 'problem', text: `Logged out ${when}` }
    if (last.status === 'blocked') return { label, state: 'problem', text: `Blocked ${when}` }
    if (last.status === 'failed') return { label, state: 'problem', text: `Failed ${when}` }
    if (daysBetween(last.run_date, today) > allowedDays) return { label, state: 'late', text: `Late, last ran ${when}` }
    return { label, state: 'ok', text: last.status === 'partial' ? `Part done ${when}` : `Ran ${when}` }
  })
}

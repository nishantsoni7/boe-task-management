// What the Meta Ads screens draw, worked out from the stored rows. Pure functions: no database and no clock of their
// own, so every rule is tested with made-up numbers. The screens only read; nothing here can change the Meta account.

import { istAddDays, istClockOf, istDateOf } from '@/lib/istDate'
import type { Action } from './parse'
import { hasResultMapping, resultCount } from './results'
import { judge, type Verdict } from './verdict'

export type MetaAccount = { account_id: string; name: string; currency: string; last_synced_at: string | null }
export type MetaCampaign = {
  campaign_id: string; name: string; effective_status: string
  daily_budget_paise: number | null; lifetime_budget_paise: number | null
}
export type MetaAdSet = {
  ad_set_id: string; campaign_id: string; name: string; effective_status: string; optimization_goal: string
  daily_budget_paise: number | null; lifetime_budget_paise: number | null
}
export type MetaInsight = { ad_set_id: string; campaign_id: string; day: string; spend_paise: number; actions: Action[] }
export type MetaRun = {
  kind: 'first' | 'daily'; status: 'running' | 'ok' | 'failed'; message: string
  campaigns: number; ad_sets: number; insight_rows: number; started_at: string; finished_at: string | null
}
export type MetaSettings = { monthly_cap_paise: number | null; target_cost_per_enquiry_paise: number | null }

// ── Money ──────────────────────────────────────────────────────────────────────────────────────────────────────

const PAISE = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const WHOLE = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

export const rupees = (paise: number) => `₹${PAISE.format(paise / 100)}`
export const rupeesWhole = (paise: number) => `₹${WHOLE.format(paise / 100)}`
/** A budget or a typed number: whole rupees when it is one, paise when it is not. */
export const money = (paise: number) => (paise % 100 === 0 ? rupeesWhole(paise) : rupees(paise))

export function budgetLabel(daily: number | null, lifetime: number | null, none = '—'): string {
  if (daily) return `${money(daily)} a day`
  if (lifetime) return `${money(lifetime)} in total`
  return none
}

/** "1 campaign", "116 campaigns". */
export const plural = (n: number, word: string) => `${n.toLocaleString('en-IN')} ${word}${n === 1 ? '' : 's'}`

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function dayLabel(date: string, withYear = false): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`
}

export const RANGES = [7, 30, 90, 365] as const
export type RangeDays = (typeof RANGES)[number]

/** The last `days` whole days, ending yesterday: today is partial, and Ads Manager leaves it out of "last 30 days" too. */
export function rangeOf(days: RangeDays, today: string): { from: string; to: string; label: string; short: string } {
  const to = istAddDays(today, -1)
  const from = istAddDays(today, -days)
  const short = days === 365 ? 'Last 12 months' : `Last ${days} days`
  return { from, to, short, label: `${short} · ${dayLabel(from)} to ${dayLabel(to, true)}` }
}

function clock12(iso: string): string {
  const [h, m] = istClockOf(iso).split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

function whenLabel(iso: string, today: string): string {
  const day = istDateOf(iso)
  const word = day === today ? 'today' : day === istAddDays(today, -1) ? 'yesterday' : dayLabel(day)
  return `${word}, ${clock12(iso)}`
}

// ── The sync ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A run still 'running' after this long means the function died. Same number as STALE_RUNNING_MINUTES in sync.ts. */
export const STALE_RUN_MINUTES = 15
const OLD_AFTER_HOURS = 36

export type SyncView =
  | { kind: 'none' }
  | { kind: 'first_running' }
  | { kind: 'failed'; message: string; lastOkAt: string | null }
  | { kind: 'ok'; lastOkAt: string }

/** `runs` newest first, as the read returns them. */
export function syncView(runs: MetaRun[], now: Date): SyncView {
  const latest = runs[0]
  if (!latest) return { kind: 'none' }
  const lastOk = runs.find(r => r.status === 'ok')
  const stale = latest.status === 'running' && now.getTime() - Date.parse(latest.started_at) > STALE_RUN_MINUTES * 60_000
  if (latest.status === 'failed' || stale) {
    const message = stale ? 'A sync stopped before it finished.' : latest.message || 'The last sync did not finish.'
    return { kind: 'failed', message, lastOkAt: lastOk?.finished_at ?? null }
  }
  if (!lastOk) return { kind: 'first_running' }
  return { kind: 'ok', lastOkAt: lastOk.finished_at ?? lastOk.started_at }
}

/** The badge in the page header. */
export function syncBadge(view: SyncView, now: Date, today: string): { text: string; tone: 'completed' | 'waiting' } | null {
  if (view.kind === 'failed') return { text: 'Out of date', tone: 'waiting' }
  if (view.kind !== 'ok') return null
  const old = now.getTime() - Date.parse(view.lastOkAt) > OLD_AFTER_HOURS * 3_600_000
  return { text: `Synced ${whenLabel(view.lastOkAt, today)}`, tone: old ? 'waiting' : 'completed' }
}

export const syncedWhen = whenLabel

// ── Totals, lines and verdicts ─────────────────────────────────────────────────────────────────────────────────

/** `chats` stays null until a row with a mapped goal is added; `chatSpendPaise` is what those rows cost. */
export type Totals = { spendPaise: number; chatSpendPaise: number; chats: number | null }

const empty = (): Totals => ({ spendPaise: 0, chatSpendPaise: 0, chats: null })

function add(t: Totals, spendPaise: number, chats: number | null) {
  t.spendPaise += spendPaise
  if (chats !== null) {
    t.chatSpendPaise += spendPaise
    t.chats = (t.chats ?? 0) + chats
  }
}

function slot(map: Map<string, Totals>, key: string): Totals {
  let t = map.get(key)
  if (!t) map.set(key, (t = empty()))
  return t
}

export const costPerChat = (t: Totals): number | null => (t.chats ? t.chatSpendPaise / t.chats : null)

export type Line = {
  id: string; name: string; running: boolean; budget: string
  spendPaise: number; chats: number | null; costPaise: number | null; verdict: Verdict
}
export type AdSetLine = Line & { campaignId: string }
export type CampaignLine = Line & { adSets: AdSetLine[]; unlisted: Line | null }

function toLine(id: string, name: string, running: boolean, budget: string, t: Totals, targetPaise: number | null): Line {
  // A campaign that mixes goals is judged on the part that chases chats.
  const spendPaise = t.chats === null ? t.spendPaise : t.chatSpendPaise
  return {
    id, name, running, budget, spendPaise: t.spendPaise, chats: t.chats, costPaise: costPerChat(t),
    verdict: judge({ spendPaise, chats: t.chats, targetPaise }),
  }
}

const byRunningThenSpend = (a: Line, b: Line) => Number(b.running) - Number(a.running) || b.spendPaise - a.spendPaise || a.name.localeCompare(b.name)

export type Report = {
  campaigns: CampaignLine[]
  adSets: AdSetLine[]
  totals: Totals
  runningAdSets: number
  runningCampaigns: number
  /** Every ad set running now that chases chats, taken together. Null when none is. */
  runningVerdict: { verdict: Verdict; chats: number; spendPaise: number; adSets: number } | null
}

export function buildReport({ campaigns, adSets, insights, targetPaise }: {
  campaigns: MetaCampaign[]; adSets: MetaAdSet[]; insights: MetaInsight[]; targetPaise: number | null
}): Report {
  const adSetById = new Map(adSets.map(a => [a.ad_set_id, a]))

  // Results for an ad set Meta no longer lists are counted by the goal its campaign's other ad sets had.
  const campaignGoal = new Map<string, string>()
  for (const a of adSets) {
    const current = campaignGoal.get(a.campaign_id)
    if (current === undefined || (!hasResultMapping(current) && hasResultMapping(a.optimization_goal))) campaignGoal.set(a.campaign_id, a.optimization_goal)
  }

  const perAdSet = new Map<string, Totals>()
  const perCampaign = new Map<string, Totals>()
  const unlisted = new Map<string, Totals>()
  const all = empty()
  for (const row of insights) {
    const known = adSetById.get(row.ad_set_id)
    const goal = known?.optimization_goal ?? campaignGoal.get(row.campaign_id) ?? ''
    const chats = resultCount(goal, row.actions)
    add(known ? slot(perAdSet, row.ad_set_id) : slot(unlisted, row.campaign_id), row.spend_paise, chats)
    add(slot(perCampaign, row.campaign_id), row.spend_paise, chats)
    add(all, row.spend_paise, chats)
  }

  const adSetLines: AdSetLine[] = adSets.map(a => ({
    ...toLine(a.ad_set_id, a.name, a.effective_status === 'ACTIVE', budgetLabel(a.daily_budget_paise, a.lifetime_budget_paise), perAdSet.get(a.ad_set_id) ?? empty(), targetPaise),
    campaignId: a.campaign_id,
  }))

  const lineFor = (id: string, name: string, running: boolean, budget: string): CampaignLine => {
    const children = adSetLines
      .filter(a => a.campaignId === id && (a.running || a.spendPaise > 0))
      .sort(byRunningThenSpend)
    const gap = unlisted.get(id)
    return {
      ...toLine(id, name, running, budget, perCampaign.get(id) ?? empty(), targetPaise),
      adSets: children,
      unlisted: gap ? toLine(`${id}-unlisted`, 'Ad sets Meta no longer lists', false, '—', gap, targetPaise) : null,
    }
  }

  const listed = new Set(campaigns.map(c => c.campaign_id))
  const campaignLines = [
    ...campaigns.map(c => {
      const own = budgetLabel(c.daily_budget_paise, c.lifetime_budget_paise, '')
      const hasAdSetBudget = adSets.some(a => a.campaign_id === c.campaign_id && (a.daily_budget_paise || a.lifetime_budget_paise))
      return lineFor(c.campaign_id, c.name, c.effective_status === 'ACTIVE', own || (hasAdSetBudget ? 'Per ad set' : '—'))
    }),
    // Spend on a campaign Meta no longer lists is still spend.
    ...[...perCampaign.keys()].filter(id => !listed.has(id)).map(id => lineFor(id, 'A campaign Meta no longer lists', false, '—')),
  ].sort(byRunningThenSpend)

  const live = adSetLines.filter(a => a.running && a.chats !== null)
  const liveSpend = live.reduce((sum, a) => sum + a.spendPaise, 0)
  const liveChats = live.reduce((sum, a) => sum + (a.chats ?? 0), 0)

  return {
    campaigns: campaignLines,
    adSets: adSetLines,
    totals: all,
    runningAdSets: adSetLines.filter(a => a.running).length,
    runningCampaigns: campaigns.filter(c => c.effective_status === 'ACTIVE').length,
    runningVerdict: live.length === 0 ? null : {
      verdict: judge({ spendPaise: liveSpend, chats: liveChats, targetPaise }),
      chats: liveChats, spendPaise: liveSpend, adSets: live.length,
    },
  }
}
